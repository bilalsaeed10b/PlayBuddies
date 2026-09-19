import {
  rtdb, dbRef, dbSet, dbPush, dbOnValue, dbOnDisconnect, dbRemove,
  dbOnChildAdded, dbOnChildChanged, dbQuery, dbOrderByKey, dbStartAfter,
} from '../firebase';
import { fetchTurnServers } from '@shared/net/turnServers';
import { steadyInterval } from '@shared/net/steadyTimer';

/**
 * A full WebRTC mesh for up to eight players, signalled through Realtime
 * Database, with Realtime Database as the relay for any pair that cannot
 * connect directly.
 *
 * Why a mesh and not a server: PlayBuddies is a static site. There is no game
 * server to run authority on, and routing 8 players' positions through
 * Firestore at even 10Hz is roughly 5,000 billed writes a minute *per room* ,
 * the single largest cost in the whole platform. Peer-to-peer traffic costs
 * nothing and is an order of magnitude lower latency.
 *
 * Signalling lives at `signaling/{room}/{sender}/{recipient}` , one channel per
 * direction per pair. Offer/answer roles are decided by comparing uids (lower
 * calls), so both sides agree on who calls whom and glare never happens.
 *
 * Three things here exist because a room got stuck with nobody connected:
 *
 *   * The first offer waits for the TURN credentials. It used to go out the
 *     moment the mesh was built, which was before the credential fetch came
 *     back, so the one attempt a pair ever made was STUN-only , exactly the
 *     attempt that fails between two restrictive NATs.
 *   * A pair that does not open, or drops, is retried. The caller starts a new
 *     *epoch*: a fresh connection under a new label, which the answerer sees
 *     and rebuilds for. Before, a failed pair stayed failed for the match.
 *   * Anything that cannot go direct goes through the relay, all of it , the
 *     host's reef included. The old fallback carried player positions only, so
 *     a guest the mesh could not reach saw the other players but grew its own
 *     private reef, and nobody's fish lined up.
 */

const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

let iceServers: RTCIceServer[] = STUN_SERVERS;
/** Settles either way within the fetch's own timeout; it never rejects. */
const turnReady: Promise<void> = fetchTurnServers().then((turn) => {
  if (turn.length > 0) iceServers = [...STUN_SERVERS, ...turn];
});
let turnSettled = false;
void turnReady.then(() => {
  turnSettled = true;
});

/** How long a pair gets to open before the caller starts over. Grows per attempt. */
const OPEN_TIMEOUT_MS = 10_000;
const OPEN_TIMEOUT_STEP_MS = 4_000;
const OPEN_TIMEOUT_MAX_MS = 30_000;
/** After a channel that was open drops, wait this long before retrying. */
const REOPEN_DELAY_MS = 1_500;
/** Relayed state is written at most this often per key: a 15Hz stream becomes 10Hz. */
const RELAY_STATE_MS = 100;
/** Relayed events are swept from the sender's node once they are this old. */
const RELAY_EVENT_TTL_MS = 8_000;

interface Link {
  id: string;
  /** Which connection attempt this is, as `${session}:${n}`. Empty before the first. */
  epoch: string;
  attempt: number;
  pc: RTCPeerConnection | null;
  /** Positions: unordered and unreliable, a stale one is worth nothing. */
  dc: RTCDataChannel | null;
  /** Events (a bite, a kill, a line of chat): ordered and reliable. */
  rdc: RTCDataChannel | null;
  seen: Set<string>;
  timer: number;
  unsub: () => void;
}

export type LinkState = 'direct' | 'relayed' | 'connecting';

export class Mesh {
  private links = new Map<string, Link>();
  private closed = false;
  /** Tells this mesh's epochs apart from a previous page load's still in the database. */
  private readonly session = Math.random().toString(36).slice(2, 8);
  private wanted: string[] = [];
  private waitingForTurn = false;

  private readonly relayRoot: string;
  private relayLast = new Map<string, number>();
  private relayPushed: { path: string; at: number }[] = [];
  private relayReaders = new Map<string, () => void>();
  /** When a relayed message last arrived from each peer, for the link indicator. */
  private relayHeard = new Map<string, number>();
  private stopSweep: () => void;

  constructor(
    private roomId: string,
    private selfId: string,
    private onMessage: (from: string, msg: unknown) => void,
    private onPeersChanged?: (connected: string[]) => void,
  ) {
    // Clear anything a previous session in this room left behind, and make sure
    // a crashed tab doesn't strand its half of every negotiation.
    const mine = dbRef(rtdb, `signaling/${roomId}/${selfId}`);
    dbOnDisconnect(mine).remove().catch(() => {});
    dbRemove(mine).catch((err) => console.error('[mesh] signalling unavailable:', err));

    this.relayRoot = `lobbies/${roomId}/updates/${selfId}/fish`;
    const relay = dbRef(rtdb, this.relayRoot);
    dbOnDisconnect(relay).remove().catch(() => {});
    dbRemove(relay).catch(() => {});

    this.stopSweep = steadyInterval(() => this.sweepRelay(), 2000);
  }

  /** Reconciles the connection set against the room roster. Safe to call on every roster change. */
  setPeers(uids: string[]) {
    if (this.closed) return;
    this.wanted = uids.filter((u) => u && u !== this.selfId);
    // Nothing connects until the TURN credentials are in (or have failed to
    // come): an offer made without them is the one most likely to fail.
    if (!turnSettled) {
      if (!this.waitingForTurn) {
        this.waitingForTurn = true;
        void turnReady.then(() => {
          this.waitingForTurn = false;
          this.setPeers(this.wanted);
        });
      }
      return;
    }
    const wanted = new Set(this.wanted);
    for (const [id, link] of this.links) {
      if (!wanted.has(id)) {
        this.dropLink(link);
        this.links.delete(id);
      }
    }
    for (const id of wanted) {
      if (!this.links.has(id)) this.openLink(id);
    }
    this.reconcileRelay();
    this.announce();
  }

  /** Everyone this mesh is trying to reach, connected or not. */
  get peerIds(): string[] {
    return [...this.wanted];
  }

  get connectedPeers(): string[] {
    return [...this.links.values()].filter((l) => isOpen(l.dc)).map((l) => l.id);
  }

  /** How each wanted peer is reached right now. */
  linkStates(): Record<string, LinkState> {
    const out: Record<string, LinkState> = {};
    const now = Date.now();
    for (const id of this.wanted) {
      const link = this.links.get(id);
      if (link && isOpen(link.dc)) out[id] = 'direct';
      else if (now - (this.relayHeard.get(id) ?? 0) < 4000) out[id] = 'relayed';
      else out[id] = 'connecting';
    }
    return out;
  }

  /**
   * To everyone. `stateKey` marks a message that replaces the last one of its
   * kind (a position), which the relay may thin out; without it the message
   * is an event and is delivered reliably, in order.
   */
  broadcast(msg: unknown, stateKey?: string) {
    const data = JSON.stringify(msg);
    let unreached = false;
    for (const link of this.links.values()) {
      if (!this.sendDirect(link, data, stateKey)) unreached = true;
    }
    if (unreached || this.links.size < this.wanted.length) this.relayOut(data, stateKey, null);
  }

  sendTo(id: string, msg: unknown, stateKey?: string) {
    const data = JSON.stringify(msg);
    const link = this.links.get(id);
    if (link && this.sendDirect(link, data, stateKey)) return;
    this.relayOut(data, stateKey, id);
  }

  close() {
    this.closed = true;
    this.stopSweep();
    for (const link of this.links.values()) this.dropLink(link);
    this.links.clear();
    for (const stop of this.relayReaders.values()) stop();
    this.relayReaders.clear();
    dbRemove(dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}`)).catch(() => {});
    dbRemove(dbRef(rtdb, this.relayRoot)).catch(() => {});
  }

  // -- direct -----------------------------------------------------------------

  private sendDirect(link: Link, data: string, stateKey?: string): boolean {
    const channel = stateKey ? link.dc : link.rdc;
    if (!isOpen(channel)) return false;
    try {
      channel!.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private announce() {
    this.onPeersChanged?.(this.connectedPeers);
  }

  private openLink(peerId: string) {
    const link: Link = {
      id: peerId, epoch: '', attempt: 0, pc: null, dc: null, rdc: null,
      seen: new Set(), timer: 0, unsub: () => {},
    };
    this.links.set(peerId, link);
    const iCall = this.selfId < peerId;
    const mineRef = dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${peerId}`);
    const theirsRef = dbRef(rtdb, `signaling/${this.roomId}/${peerId}/${this.selfId}`);

    link.unsub = dbOnValue(theirsRef, async (snap) => {
      const data = snap.val() as {
        epoch?: string;
        desc?: RTCSessionDescriptionInit;
        candidates?: Record<string, string>;
      } | null;
      if (!data || typeof data.epoch !== 'string' || this.closed) return;
      try {
        if (!iCall && data.epoch !== link.epoch) {
          // The caller started a new attempt. Match it with a fresh connection,
          // and say which attempt this side's answer belongs to before any of
          // its candidates can land.
          await dbSet(mineRef, { epoch: data.epoch });
          this.build(link, data.epoch, iCall, mineRef);
        }
        if (data.epoch !== link.epoch) return; // an answer to an attempt we abandoned
        const pc = link.pc;
        if (!pc) return;
        if (data.desc) {
          if (iCall && pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(data.desc));
          } else if (!iCall && pc.signalingState === 'stable' && !pc.currentRemoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(data.desc));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            if (link.pc !== pc) return;
            await dbSet(dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${peerId}/desc`), {
              type: answer.type,
              sdp: answer.sdp,
            });
          }
        }
        if (link.pc === pc) this.applyCandidates(link, data.candidates);
      } catch (err) {
        console.error('[mesh] negotiation failed with', peerId, err);
      }
    });

    if (iCall) void this.callAgain(link, mineRef);
  }

  /** Caller only: begin a new attempt from scratch. */
  private async callAgain(link: Link, mineRef: ReturnType<typeof dbRef>) {
    if (this.closed || !this.links.has(link.id)) return;
    link.attempt += 1;
    const epoch = `${this.session}:${link.attempt}`;
    try {
      // Written first, so everything this attempt publishes lands after it and
      // nothing from the last attempt survives underneath it.
      await dbSet(mineRef, { epoch });
      if (this.closed || !this.links.has(link.id)) return;
      const pc = this.build(link, epoch, true, mineRef);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (link.pc !== pc) return;
      await dbSet(dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${link.id}/desc`), {
        type: offer.type,
        sdp: offer.sdp,
      });
    } catch (err) {
      console.error('[mesh] offer failed for', link.id, err);
    }
    // Whatever happened, give it a bounded time to open and go again if not.
    const wait = Math.min(OPEN_TIMEOUT_MAX_MS, OPEN_TIMEOUT_MS + (link.attempt - 1) * OPEN_TIMEOUT_STEP_MS);
    window.clearTimeout(link.timer);
    link.timer = window.setTimeout(() => {
      if (!isOpen(link.dc)) void this.callAgain(link, mineRef);
    }, wait);
  }

  private build(link: Link, epoch: string, iCall: boolean, mineRef: ReturnType<typeof dbRef>): RTCPeerConnection {
    this.closePc(link);
    link.epoch = epoch;
    link.seen = new Set();
    const pc = new RTCPeerConnection({ iceServers });
    // Pre-negotiated channels: both sides create them with the same ids, so
    // there is no ondatachannel race to lose.
    const dc = pc.createDataChannel('fish', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    const rdc = pc.createDataChannel('fish-events', { negotiated: true, id: 1, ordered: true });
    link.pc = pc;
    link.dc = dc;
    link.rdc = rdc;

    const deliver = (e: MessageEvent) => {
      try {
        this.onMessage(link.id, JSON.parse(e.data));
      } catch {
        /* a peer sending us garbage is their problem, not a crash */
      }
    };
    dc.onmessage = deliver;
    rdc.onmessage = deliver;
    dc.onopen = () => {
      window.clearTimeout(link.timer);
      this.reconcileRelay();
      this.announce();
    };
    dc.onclose = () => {
      if (link.pc !== pc || this.closed) return;
      this.reconcileRelay();
      this.announce();
      // A channel that was up and dropped (a network change, a phone waking
      // up) is worth a fresh attempt. Only the caller starts one.
      if (iCall) {
        window.clearTimeout(link.timer);
        link.timer = window.setTimeout(() => void this.callAgain(link, mineRef), REOPEN_DELAY_MS);
      }
    };
    pc.onconnectionstatechange = () => {
      if (link.pc !== pc || !iCall) return;
      if (pc.connectionState === 'failed') {
        window.clearTimeout(link.timer);
        void this.callAgain(link, mineRef);
      }
    };
    pc.onicecandidate = (e) => {
      if (!e.candidate || link.pc !== pc) return;
      dbPush(dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${link.id}/candidates`),
        JSON.stringify(e.candidate.toJSON()))
        // Loud on purpose. A permission error here means the database rules
        // were never deployed, and the symptom players see is "multiplayer
        // doesn't work" with nothing in the console to explain it.
        .catch((err) => console.error('[mesh] could not publish ICE candidate:', err));
    };
    return pc;
  }

  private applyCandidates(link: Link, candidates?: Record<string, string> | null) {
    if (!candidates || !link.pc) return;
    for (const raw of Object.values(candidates)) {
      if (link.seen.has(raw)) continue;
      link.seen.add(raw);
      try {
        link.pc.addIceCandidate(new RTCIceCandidate(JSON.parse(raw))).catch(() => {});
      } catch {
        /* malformed candidate , skip */
      }
    }
  }

  private closePc(link: Link) {
    const { pc, dc, rdc } = link;
    link.pc = null;
    link.dc = null;
    link.rdc = null;
    for (const channel of [dc, rdc]) {
      if (!channel) continue;
      channel.onopen = channel.onclose = channel.onmessage = null;
      try {
        channel.close();
      } catch {
        /* already gone */
      }
    }
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
  }

  private dropLink(link: Link) {
    window.clearTimeout(link.timer);
    link.unsub();
    this.closePc(link);
    dbRemove(dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${link.id}`)).catch(() => {});
  }

  // -- relay ------------------------------------------------------------------

  /**
   * Out through Realtime Database, for whoever has no open channel.
   *
   * Every payload is stored as its JSON string. Stored as a value, an empty
   * array comes back as nothing at all and a null field disappears, which
   * would hand the game a message missing half its shape.
   */
  private relayOut(data: string, stateKey: string | undefined, to: string | null) {
    if (this.closed) return;
    if (stateKey) {
      const path = to ? `to/${to}/s/${stateKey}` : `all/${stateKey}`;
      const now = Date.now();
      if (now - (this.relayLast.get(path) ?? 0) < RELAY_STATE_MS) return;
      this.relayLast.set(path, now);
      dbSet(dbRef(rtdb, `${this.relayRoot}/${path}`), data).catch(() => {});
      return;
    }
    const targets = to ? [to] : this.wanted.filter((id) => !isOpen(this.links.get(id)?.rdc ?? null));
    for (const target of targets) {
      const path = `${this.relayRoot}/to/${target}/ev`;
      const ref = dbPush(dbRef(rtdb, path));
      dbSet(ref, data).catch(() => {});
      this.relayPushed.push({ path: `${path}/${ref.key}`, at: Date.now() });
    }
  }

  /** Listen to the relay of every peer with no open channel, and only those. */
  private reconcileRelay() {
    if (this.closed) return;
    for (const id of this.wanted) {
      const direct = isOpen(this.links.get(id)?.dc ?? null);
      const reading = this.relayReaders.has(id);
      if (direct && reading) {
        this.relayReaders.get(id)!();
        this.relayReaders.delete(id);
      } else if (!direct && !reading) {
        this.relayReaders.set(id, this.readRelay(id));
      }
    }
    for (const [id, stop] of this.relayReaders) {
      if (!this.wanted.includes(id)) {
        stop();
        this.relayReaders.delete(id);
      }
    }
  }

  private readRelay(peerId: string): () => void {
    const base = `lobbies/${this.roomId}/updates/${peerId}/fish`;
    const deliver = (raw: unknown) => {
      if (typeof raw !== 'string') return;
      this.relayHeard.set(peerId, Date.now());
      try {
        this.onMessage(peerId, JSON.parse(raw));
      } catch {
        /* ignore */
      }
    };
    const stops: (() => void)[] = [];
    // State: only the entry that changed, not the whole folder again.
    for (const folder of [`${base}/all`, `${base}/to/${this.selfId}/s`]) {
      const ref = dbRef(rtdb, folder);
      stops.push(dbOnChildAdded(ref, (snap) => deliver(snap.val())));
      stops.push(dbOnChildChanged(ref, (snap) => deliver(snap.val())));
    }
    // Events: only those pushed from now on. A push key is a timestamp, so a
    // key made here and now is the cursor that skips everything older.
    const cursor = dbPush(dbRef(rtdb, `${base}/to/${this.selfId}/ev`)).key as string;
    const events = dbQuery(dbRef(rtdb, `${base}/to/${this.selfId}/ev`), dbOrderByKey(), dbStartAfter(cursor));
    stops.push(dbOnChildAdded(events, (snap) => deliver(snap.val())));
    return () => stops.forEach((stop) => stop());
  }

  /** Delete this sender's relayed events once nobody could still be waiting on them. */
  private sweepRelay() {
    const cutoff = Date.now() - RELAY_EVENT_TTL_MS;
    while (this.relayPushed.length > 0 && this.relayPushed[0].at < cutoff) {
      const { path } = this.relayPushed.shift()!;
      dbRemove(dbRef(rtdb, path)).catch(() => {});
    }
    // A reader that fell silent may have been started before its peer's relay
    // existed; restarting it costs one listener and fixes that for certain.
    this.reconcileRelay();
  }
}

function isOpen(channel: RTCDataChannel | null): boolean {
  return channel?.readyState === 'open';
}
