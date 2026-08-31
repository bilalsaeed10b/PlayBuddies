/**
 * One wire, two ways to carry it.
 *
 * The mesh is the wire this game wants: peer-to-peer, sub-50ms, free. What it
 * is not is *reliable to establish*. PlayBuddies ships no TURN server, so two
 * players behind unhelpful NATs — a phone on mobile data and a laptop on office
 * wifi is the usual pair — can hold a perfectly good signalling conversation
 * and still never open a data channel.
 *
 * So there is a second path, over the one Firestore document each player is
 * already allowed to write — `lobbies/{room}/updates/{uid}`, the same slot
 * Fish Eat Fish and Fireboy & Watergirl use. That second game is the reason
 * this file looks the way it does: this used to be a three-tier chain — a
 * dedicated Realtime Database relay node, then a piggyback on the signalling
 * schema, then Firestore — opened only *after* the mesh's own startup write
 * had settled, and only once each earlier tier had been probed and found
 * wanting. Every one of those steps was a promise that could, on a network
 * where Realtime Database is not reachable at all, simply never settle —
 * and the SDK does not time those out on its own. One flaky signal and the
 * entire chain hung forever, including the Firestore leg that was supposed
 * to be the one path that always works. Fireboy & Watergirl never had that
 * problem, because it never had that chain: it writes to Firestore
 * unconditionally, from the first frame, in parallel with the mesh, and
 * simply paces the writes slower once the mesh is confirmed carrying
 * traffic. Copied here for the same reason — it works.
 *
 * Everything above this file talks to `Link` and never learns which path a
 * packet took.
 */
import { BALANCE } from '../game/rules';
import { NetMessage } from '../types/game';
import { Mesh } from './mesh';
import { PeerClocks, localNow } from './clock';
import type { PeerTiming } from './clock';

/**
 * How often the RTDB relay writes while any peer is not yet reachable
 * directly. RTDB doesn't charge per write, so we can run this at the
 * frame rate for true real-time performance.
 */
const RELAY_ACTIVE_MS = 33;

/**
 * How often it writes once every peer is reachable directly.
 *
 * Not zero: a heartbeat this slow costs almost nothing, and it is what lets
 * the relay take over instantly if the mesh drops mid-match — a fresh
 * connection with no warm-up, rather than a cold start that has to open a
 * listener and wait for it to catch up before the first packet.
 */
const RELAY_IDLE_MS = 1000;

/** Events (a `bye`, say) queued for the next relay write, at most. */
const MAX_EVENTS = 8;

export interface LinkStatus {
  /** Peers on an open data channel. */
  direct: string[];
  /** Peers we can only reach through the relay. */
  relayed: string[];
  /** Peers we cannot reach at all yet. */
  missing: string[];
  /** Worst round-trip estimate in ms across everyone we can reach. */
  rtt: number;
  /** How much that round trip is moving about, in ms. */
  jitter: number;
  /** Why peer-to-peer is not happening, when it is not. Fit to show a player. */
  reason: string | null;
}

type Handler = (from: string, msg: NetMessage) => void;
type RelayWrite = (batch: NetMessage[], seq: number) => Promise<void>;

export class Link {
  private mesh: Mesh;
  private peers: string[] = [];
  private clocks = new PeerClocks();
  private relayWrite: RelayWrite | null = null;
  private stopRelay: (() => void) | null = null;
  private relayTimer: number | null = null;
  private lastRelayWrite = 0;
  private pingTimer: number | null = null;
  private relaySeq = 0;
  /** Peers with a timing probe queued for the next relay write. */
  private relayProbes = new Set<string>();
  private seen = new Map<string, number>();
  private pendingState: NetMessage | null = null;
  private pendingEvents: NetMessage[] = [];
  private reason: string | null = null;
  private closed = false;

  constructor(
    private roomId: string,
    private selfId: string,
    private onMessage: Handler,
    private onStatus?: (status: LinkStatus) => void,
  ) {
    this.mesh = new Mesh(
      roomId,
      selfId,
      (from, raw) => this.receive(from, raw as NetMessage),
      () => this.publishStatus(),
      (_peerId, verdict) => {
        this.reason = verdict;
        this.publishStatus();
      },
    );

    this.pingTimer = window.setInterval(() => this.ping(), 1000 / BALANCE.PING_HZ);

    // Opened immediately, not after the mesh's own signalling has settled —
    // there is nothing left to wait for. The old chain waited on that because
    // an earlier relay design shared the mesh's own signalling node and could
    // collide with its startup wipe; this one writes to a completely
    // different document and has no such race.
    void this.openRelay();
  }

  setPeers(uids: string[]) {
    this.peers = uids.filter((u) => u && u !== this.selfId);
    this.mesh.setPeers(this.peers);
    // Stop reporting a departed player's connection, and drop their clock —
    // a uid that returns is a fresh page with a fresh timebase, so keeping the
    // old offset would be worse than having none.
    this.clocks.retain(this.peers);
    for (const id of [...this.seen.keys()]) if (!this.peers.includes(id)) this.seen.delete(id);
    this.publishStatus();
  }

  /**
   * Sends to everyone.
   *
   * `live` marks a packet whose only value is being the newest one — a snapshot
   * or a body update. The relay keeps just the last of those; anything else is
   * queued and delivered. Always captured for the relay too, regardless of
   * whether the mesh currently needs the help — see RELAY_IDLE_MS.
   */
  send(msg: NetMessage, live = false) {
    this.mesh.broadcast(msg);
    if (live) this.pendingState = msg;
    else if (this.pendingEvents.length < MAX_EVENTS) this.pendingEvents.push(msg);
  }

  sendTo(id: string, msg: NetMessage, live = false) {
    if (this.mesh.sendTo(id, msg)) return;
    // The relay is a broadcast medium — everything written to our slot is read
    // by the whole room. Addressing is the receiver's job, and every message
    // this game sends is either idempotent or already addressed by content.
    if (live) this.pendingState = msg;
    else if (this.pendingEvents.length < MAX_EVENTS) this.pendingEvents.push(msg);
  }

  /** The worst round trip in the room, for the badge. */
  get rtt(): number {
    return this.clocks.worstRtt;
  }

  rttTo(id: string): number {
    return this.clocks.timingFor(id).rtt;
  }

  timingTo(id: string): PeerTiming {
    return this.clocks.timingFor(id);
  }

  /**
   * How old a packet from `from` is, in seconds — measured, not inferred.
   *
   * `sentAt` is the stamp the sender put on it with `stamp()`. Capped by the
   * caller, because how far it is worth extrapolating is a game decision and
   * not this file's business.
   */
  ageOf(from: string, sentAt: number, cap: number): number {
    return this.clocks.ageOf(from, sentAt, cap);
  }

  /** The stamp to put on an outgoing packet so the receiver can date it. */
  stamp(): number {
    return localNow();
  }

  /** True once anybody at all is reachable. */
  get connected(): boolean {
    return this.mesh.connectedPeers.length > 0 || this.clocks.measured.length > 0;
  }

  close() {
    this.closed = true;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.relayTimer !== null) clearInterval(this.relayTimer);
    this.stopRelay?.();
    this.mesh.close();
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private receive(from: string, msg: NetMessage) {
    if (!msg || typeof msg !== 'object') return;
    // Timing probes are answered here and never reach the game.
    if (msg.t === 'q') {
      // Not for us. Over the relay every slot is world-readable, so most
      // probes in a 2v2 are somebody else's.
      if (msg.to !== this.selfId) return;
      const t1 = localNow();
      // t1 and t2 are read separately on purpose. The gap between them is
      // whatever this machine spends holding the reply — most of it the relay
      // write batch below — and sending both is what lets the prober subtract
      // that out instead of charging it to the network.
      this.replyTo(from, { t: 'a', id: msg.id, to: from, t1, t2: localNow() });
      return;
    }
    if (msg.t === 'a') {
      if (msg.to !== this.selfId) return;
      // The probe's own send time never travelled; it is matched from `id`
      // against what we recorded locally.
      if (this.clocks.closeProbe(from, msg.id, msg.t1, msg.t2)) this.publishStatus();
      return;
    }
    this.onMessage(from, msg);
  }

  private replyTo(id: string, msg: NetMessage) {
    if (this.mesh.sendTo(id, msg)) return;
    if (this.pendingEvents.length < MAX_EVENTS) this.pendingEvents.push(msg);
  }

  /**
   * One addressed probe per peer.
   *
   * Addressed rather than broadcast because each peer now needs its own `id`
   * to pair an echo against, and because a shared probe measured whichever
   * path happened to answer first — on a peer reachable both ways, the slower
   * relayed echo would arrive second and overwrite a perfectly good direct
   * measurement.
   */
  private ping() {
    if (this.closed) return;
    for (const id of this.peers) {
      // A relayed peer already has a probe waiting to be written. Minting a
      // second one now would only measure the queue: probes cannot usefully go
      // out faster than the relay writes, and at PING_HZ they would crowd the
      // batch out of room for the game's own packets.
      if (this.relayProbes.has(id)) continue;

      const { id: probeId } = this.clocks.openProbe(id);
      const probe: NetMessage = { t: 'q', id: probeId, to: id };
      if (this.mesh.sendTo(id, probe)) continue;

      if (this.pendingEvents.length < MAX_EVENTS) {
        this.relayProbes.add(id);
        this.pendingEvents.push(probe);
      }
    }
  }

  private needsRelay(): boolean {
    if (this.peers.length === 0) return false;
    const direct = new Set(this.mesh.connectedPeers);
    return this.peers.some((id) => !direct.has(id));
  }

  private publishStatus() {
    const direct = this.mesh.connectedPeers;
    const directSet = new Set(direct);
    // A peer counts as relayed the moment anything at all has arrived from
    // them over it — not only once a round-trip probe happens to have landed.
    // Gameplay itself proves the relay works; a slow first ping should not
    // leave the badge claiming there is no connection while a rally is
    // already in progress.
    const measured = new Set(this.clocks.measured);
    const relayed = this.peers.filter(
      (id) => !directSet.has(id) && (this.seen.has(id) || measured.has(id)),
    );
    const relayedSet = new Set(relayed);
    let jitter = 0;
    for (const id of this.peers) jitter = Math.max(jitter, this.clocks.timingFor(id).jitter);
    this.onStatus?.({
      direct,
      relayed,
      missing: this.peers.filter((id) => !directSet.has(id) && !relayedSet.has(id)),
      rtt: this.rtt,
      jitter,
      // Only worth saying while it is still true: a peer that came up on a
      // retry should not leave a stale explanation on screen.
      reason: direct.length === this.peers.length ? null : this.reason,
    });
  }

  /**
   * Arms the RTDB relay, with automatic Firestore fallback if RTDB fails.
   */
  private async openRelay() {
    try {
      const { rtdb, dbRef, dbSet, dbOnValue, db, doc, setDoc, collection, onSnapshot } = await import('../firebase');
      if (this.closed) return;

      let rtdbActive = true;
      let fsUnsub: (() => void) | null = null;
      let fsWriteFn: ((batch: NetMessage[], seq: number) => Promise<void>) | null = null;

      const initFirestore = () => {
        if (fsUnsub || this.closed) return;
        try {
          const mineDoc = doc(db, 'lobbies', this.roomId, 'updates', this.selfId);
          fsUnsub = onSnapshot(
            collection(db, 'lobbies', this.roomId, 'updates'),
            (snap) => {
              for (const change of snap.docChanges()) {
                if (change.type === 'removed') continue;
                const from = change.doc.id;
                if (from === this.selfId) continue;
                const data = change.doc.data() as { m?: string; n?: number };
                if (typeof data.m !== 'string' || typeof data.n !== 'number') continue;
                if (this.isReplay(from, data.n)) continue;
                this.markSeen(from, data.n);
                let batch: NetMessage[];
                try {
                  batch = JSON.parse(data.m) as NetMessage[];
                } catch {
                  continue;
                }
                for (const msg of batch) this.receive(from, msg);
              }
            },
            (err) => console.error('[link] Firestore relay fallback unavailable:', err),
          );
          fsWriteFn = async (batch, seq) => {
            await setDoc(mineDoc, { m: JSON.stringify(batch), n: seq, at: Date.now() });
          };
        } catch (e) {
          console.error('[link] Failed to init Firestore fallback:', e);
        }
      };

      const mine = dbRef(rtdb, `lobbies/${this.roomId}/updates/${this.selfId}`);
      const updatesRef = dbRef(rtdb, `lobbies/${this.roomId}/updates`);
      
      const unsubscribe = dbOnValue(
        updatesRef,
        (snap) => {
          if (!rtdbActive) return;
          snap.forEach((child) => {
            const from = child.key;
            if (!from || from === this.selfId) return;
            const data = child.val() as { m?: string; n?: number };
            if (typeof data.m !== 'string' || typeof data.n !== 'number') return;
            if (this.isReplay(from, data.n)) return;
            this.markSeen(from, data.n);
            let batch: NetMessage[];
            try {
              batch = JSON.parse(data.m) as NetMessage[];
            } catch {
              return;
            }
            for (const msg of batch) this.receive(from, msg);
          });
        },
        (err) => {
          console.warn('[link] RTDB relay unavailable, enabling Firestore fallback:', err);
          rtdbActive = false;
          initFirestore();
        },
      );

      this.stopRelay = () => {
        unsubscribe();
        fsUnsub?.();
      };

      this.relayWrite = async (batch, seq) => {
        if (rtdbActive) {
          try {
            await dbSet(mine, { m: JSON.stringify(batch), n: seq, at: Date.now() });
            return;
          } catch (err) {
            console.warn('[link] RTDB write failed, enabling Firestore fallback:', err);
            rtdbActive = false;
            initFirestore();
          }
        }
        if (fsWriteFn) {
          await fsWriteFn(batch, seq);
        }
      };

      this.relayTimer = window.setInterval(() => void this.flushRelay(), RELAY_ACTIVE_MS);
    } catch (err) {
      console.error('[link] could not open the relay:', err);
    }
  }

  /**
   * Whether a sequence number has already been acted on.
   *
   * A big jump *backwards* is a peer that reloaded and started counting again,
   * not a replayed message — treating that as stale would silence them for the
   * rest of the match.
   */
  private isReplay(from: string, n: number): boolean {
    const last = this.seen.get(from);
    return last !== undefined && n <= last && n > last - 60;
  }

  /**
   * Records that a peer has been heard from over the relay, and — the first
   * time, for this peer — tells the badge immediately.
   */
  private markSeen(id: string, n: number) {
    const first = !this.seen.has(id);
    this.seen.set(id, n);
    if (first) this.publishStatus();
  }

  private async flushRelay() {
    if (this.closed || !this.relayWrite) return;
    // Fast while somebody still needs the help; a slow heartbeat once nobody
    // does, so the relay stays warm without costing much. Never off outright —
    // that is exactly the gap the old gated version fell into.
    const interval = this.needsRelay() ? RELAY_ACTIVE_MS : RELAY_IDLE_MS;
    const now = Date.now();
    if (now - this.lastRelayWrite < interval) return;

    const batch: NetMessage[] = [];
    if (this.pendingState) batch.push(this.pendingState);
    batch.push(...this.pendingEvents);
    this.pendingState = null;
    this.pendingEvents.length = 0;
    if (batch.length === 0) return;

    // Both halves of a timing probe are stamped *here*, at the moment they
    // actually leave, rather than when they were queued. Everything above this
    // line may have waited up to a full batch interval, and a probe that
    // counted its own time in this queue as time on the wire would report the
    // relay as roughly twice as slow as it is — which then becomes twice as
    // much extrapolation, on every body and the ball.
    const leaving = localNow();
    for (const msg of batch) {
      if (msg.t === 'q') this.clocks.restampProbe(msg.id, leaving);
      else if (msg.t === 'a') msg.t2 = leaving;
    }
    this.relayProbes.clear();

    this.lastRelayWrite = now;
    try {
      await this.relayWrite(batch, ++this.relaySeq);
    } catch (err) {
      console.error('[link] RTDB relay write failed:', err);
    }
  }
}
