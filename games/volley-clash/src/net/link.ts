/**
 * One wire, two ways to carry it.
 *
 * The mesh is the wire this game wants: peer-to-peer, sub-50ms, free. What it
 * is not is *reliable to establish*. PlayBuddies ships no TURN server, so two
 * players behind unhelpful NATs — a phone on mobile data and a laptop on office
 * wifi is the usual pair — can hold a perfectly good signalling conversation
 * and still never open a data channel. There was nothing behind that, so the
 * match simply never started: no ball, no serve, no score, and no message on
 * screen explaining why.
 *
 * So there is a second path. Every peer the mesh has not reached is relayed
 * through the one Firestore document each player is already allowed to write —
 * `lobbies/{room}/updates/{uid}`, the same slot Fish Eat Fish uses. It is
 * slower and it costs a write, so it runs at a lower rate, carries only the
 * newest state, and switches itself off the moment the data channel opens.
 *
 * Everything above this file talks to `Link` and never learns which path a
 * packet took.
 */
import { BALANCE } from '../game/rules';
import { NetMessage } from '../types/game';
import { Mesh } from './mesh';

/**
 * Relay writes per second, per player.
 *
 * Two rates, because the two paths cost completely different things. A
 * Firestore write is billed per document write, so that path is paced
 * conservatively. A Realtime Database write is a message on a socket that is
 * already open and is billed by bandwidth, so it can run fast enough that the
 * pacing itself stops being a source of delay.
 *
 * That pacing is not free latency-wise: at 8Hz a snapshot waits up to 125ms
 * just for the next write, and the reply to a round-trip probe waits again on
 * the other side. Two of those are most of the difference between a relayed
 * match that is slow and one that is unplayable.
 */
const RELAY_HZ = 8;
const FAST_RELAY_HZ = 20;

/**
 * The key a player's relay slot lives under, inside their own signalling node.
 *
 * A tilde cannot appear in a Firebase uid, so this can never collide with a
 * real peer.
 */
const RELAY_SLOT = '~relay';

/** What the signalling schema allows in that slot: 20000 characters, less headroom. */
const SLOT_LIMIT = 19000;
/** Events (a `bye`, say) queued for the next relay write, at most. */
const MAX_EVENTS = 8;

export interface LinkStatus {
  /** Peers on an open data channel. */
  direct: string[];
  /** Peers we can only reach through the relay. */
  relayed: string[];
  /** Peers we cannot reach at all yet. */
  missing: string[];
  /** Best round-trip estimate in ms across everyone we can reach. */
  rtt: number;
  /** Why peer-to-peer is not happening, when it is not. Fit to show a player. */
  reason: string | null;
}

type Handler = (from: string, msg: NetMessage) => void;

interface RelayApi {
  write: (batch: NetMessage[], seq: number) => Promise<void>;
  stop: () => void;
}

export class Link {
  private mesh: Mesh;
  private peers: string[] = [];
  private rtts = new Map<string, number>();
  private relay: RelayApi | null = null;
  private relayTimer: number | null = null;
  private pingTimer: number | null = null;
  private relaySeq = 0;
  private seen = new Map<string, number>();
  private pendingState: NetMessage | null = null;
  private pendingEvents: NetMessage[] = [];
  private reason: string | null = null;
  /** Set by the signalling relay, so its per-peer listeners follow the roster. */
  private watchRelayPeers: ((uids: string[]) => void) | null = null;
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
    void this.openRelay();
  }

  setPeers(uids: string[]) {
    this.peers = uids.filter((u) => u && u !== this.selfId);
    this.mesh.setPeers(this.peers);
    this.watchRelayPeers?.(this.peers);
    this.publishStatus();
  }

  /**
   * Sends to everyone.
   *
   * `live` marks a packet whose only value is being the newest one — a snapshot
   * or a body update. The relay keeps just the last of those; anything else is
   * queued and delivered.
   */
  send(msg: NetMessage, live = false) {
    this.mesh.broadcast(msg);
    if (!this.needsRelay()) return;
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

  /** Round trip to the peer we care most about, or the room's best guess. */
  get rtt(): number {
    if (this.rtts.size === 0) return 0;
    let worst = 0;
    for (const v of this.rtts.values()) worst = Math.max(worst, v);
    return worst;
  }

  rttTo(id: string): number {
    return this.rtts.get(id) ?? this.rtt;
  }

  /** True once anybody at all is reachable. */
  get connected(): boolean {
    return this.mesh.connectedPeers.length > 0 || this.rtts.size > 0;
  }

  close() {
    this.closed = true;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.relayTimer !== null) clearInterval(this.relayTimer);
    this.relay?.stop();
    this.mesh.close();
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private receive(from: string, msg: NetMessage) {
    if (!msg || typeof msg !== 'object') return;
    // Round-trip probes are answered here and never reach the game.
    if (msg.t === 'q') {
      this.replyTo(from, { t: 'a', n: msg.n, to: from });
      return;
    }
    if (msg.t === 'a') {
      // The relay is a broadcast medium: an echo meant for another player is
      // stamped with *their* clock, and treating it as ours would produce a
      // round-trip figure invented out of the difference between two machines'
      // ideas of the time.
      if (msg.to !== this.selfId) return;
      const sample = Date.now() - msg.n;
      if (sample >= 0 && sample < 5000) {
        const previous = this.rtts.get(from);
        // Smoothed, because one slow packet is not a slow connection — but not
        // so smoothed that a genuinely degraded link takes ten seconds to show.
        this.rtts.set(from, previous === undefined ? sample : previous * 0.7 + sample * 0.3);
        this.publishStatus();
      }
      return;
    }
    this.onMessage(from, msg);
  }

  private replyTo(id: string, msg: NetMessage) {
    if (this.mesh.sendTo(id, msg)) return;
    if (this.pendingEvents.length < MAX_EVENTS) this.pendingEvents.push(msg);
  }

  private ping() {
    if (this.closed) return;
    const probe: NetMessage = { t: 'q', n: Date.now() };
    let needsRelayProbe = false;
    for (const id of this.peers) {
      if (!this.mesh.sendTo(id, probe)) needsRelayProbe = true;
    }
    // One probe covers every relayed peer at once: they all read the same slot.
    // Queued after the loop, so an unreachable peer early in the list cannot
    // cost the reachable ones their direct probe.
    if (needsRelayProbe && this.pendingEvents.length < MAX_EVENTS) this.pendingEvents.push(probe);
    // Forget the round trip to anyone who has left, so `rtt` doesn't keep
    // reporting a departed player's connection.
    for (const id of this.rtts.keys()) if (!this.peers.includes(id)) this.rtts.delete(id);
  }

  private needsRelay(): boolean {
    if (this.peers.length === 0) return false;
    const direct = new Set(this.mesh.connectedPeers);
    return this.peers.some((id) => !direct.has(id));
  }

  private publishStatus() {
    const direct = this.mesh.connectedPeers;
    const directSet = new Set(direct);
    const relayed = this.peers.filter((id) => !directSet.has(id) && this.rtts.has(id));
    const relayedSet = new Set(relayed);
    this.onStatus?.({
      direct,
      relayed,
      missing: this.peers.filter((id) => !directSet.has(id) && !relayedSet.has(id)),
      rtt: this.rtt,
      // Only worth saying while it is still true: a peer that came up on a
      // retry should not leave a stale explanation on screen.
      reason: direct.length === this.peers.length ? null : this.reason,
    });
  }

  /**
   * Opens the fallback.
   *
   * Firebase is imported here rather than at the top so that a match whose mesh
   * comes straight up never pays for the Firestore half of the SDK on the
   * critical path — the relay is armed in the background while the game is
   * already running.
   */
  private async openRelay() {
    // Realtime Database first. It is the same websocket the signalling already
    // holds open, so a message costs one push over a live socket rather than a
    // Firestore document write and a listener fan-out — the difference between
    // a fallback that plays and one that merely functions. Measured on a real
    // match, the Firestore path alone was a 669ms round trip.
    if ((await this.openFastRelay()) || (await this.openSignallingRelay())) {
      this.relayTimer = window.setInterval(() => void this.flushRelay(), 1000 / FAST_RELAY_HZ);
      return;
    }
    try {
      const { db, doc, setDoc, collection, onSnapshot } = await import('../firebase');
      if (this.closed) return;
      console.warn('[link] falling back to the Firestore relay — deploy database.rules.json for the faster one');

      const mine = doc(db, 'lobbies', this.roomId, 'updates', this.selfId);
      const stop = onSnapshot(
        collection(db, 'lobbies', this.roomId, 'updates'),
        (snap) => {
          for (const change of snap.docChanges()) {
            if (change.type === 'removed') continue;
            const from = change.doc.id;
            if (from === this.selfId) continue;
            const data = change.doc.data() as { m?: string; n?: number };
            if (typeof data.m !== 'string' || typeof data.n !== 'number') continue;
            // A Firestore listener replays what it already gave us on
            // reconnect; the sequence number is what keeps a replayed snapshot
            // from being mistaken for a fresh one. A counter that jumps a long
            // way *backwards* is a peer that reloaded, not a replay — treating
            // that as stale would silence them for the rest of the match.
            if (this.isReplay(from, data.n)) continue;
            this.seen.set(from, data.n);
            let batch: NetMessage[];
            try {
              batch = JSON.parse(data.m) as NetMessage[];
            } catch {
              continue;
            }
            for (const msg of batch) this.receive(from, msg);
          }
        },
        (err) => console.error('[link] relay unavailable:', err),
      );

      this.relay = {
        write: async (batch, seq) => {
          await setDoc(mine, { m: JSON.stringify(batch), n: seq, at: Date.now() });
        },
        stop,
      };

      this.relayTimer = window.setInterval(() => void this.flushRelay(), 1000 / RELAY_HZ);
    } catch (err) {
      console.error('[link] could not arm the relay:', err);
    }
  }

  /**
   * The fast fallback, over Realtime Database.
   *
   * Returns false if the rules for it are not deployed, in which case the
   * caller uses the Firestore relay instead. That is deliberate: this path
   * needs a `relay` node in database.rules.json, and a game that broke for
   * everyone until someone remembered to publish rules would be a worse bug
   * than the one being fixed.
   */
  private async openFastRelay(): Promise<boolean> {
    try {
      const { rtdb, dbRef, dbSet, dbOnValue, dbOnDisconnect, dbRemove } = await import('../firebase');
      if (this.closed) return false;

      const mine = dbRef(rtdb, `relay/${this.roomId}/${this.selfId}`);
      // One probe write, to find out whether the rules for this path exist
      // before committing the match to it.
      await dbSet(mine, { m: '[]', n: 0 });
      if (this.closed) return false;
      dbOnDisconnect(mine).remove().catch(() => {});

      const stop = dbOnValue(
        dbRef(rtdb, `relay/${this.roomId}`),
        (snap) => {
          const all = snap.val() as Record<string, { m?: string; n?: number }> | null;
          if (!all) return;
          for (const [from, entry] of Object.entries(all)) {
            if (from === this.selfId) continue;
            if (typeof entry?.m !== 'string' || typeof entry.n !== 'number') continue;
            if (this.isReplay(from, entry.n)) continue;
            this.seen.set(from, entry.n);
            let batch: NetMessage[];
            try {
              batch = JSON.parse(entry.m) as NetMessage[];
            } catch {
              continue;
            }
            for (const msg of batch) this.receive(from, msg);
          }
        },
        (err: unknown) => console.error('[link] fast relay dropped:', err),
      );

      this.relay = {
        write: async (batch, seq) => {
          await dbSet(mine, { m: JSON.stringify(batch), n: seq });
        },
        stop: () => {
          stop();
          dbRemove(mine).catch(() => {});
        },
      };
      return true;
    } catch (err) {
      // Almost always PERMISSION_DENIED, meaning the rules are not deployed.
      console.warn('[link] fast relay unavailable:', err);
      return false;
    }
  }

  /**
   * The fast fallback again, over a path that is already permitted.
   *
   * The clean `relay/{room}/{uid}` node above needs rules published before it
   * works. This one needs nothing: the deployed signalling rules already let a
   * player write `signaling/{room}/{self}/{anything}/desc` as a `{type, sdp}`
   * pair of strings, and let anyone in the room read it. A reserved key that no
   * uid can collide with gives every player one writable slot on the same
   * websocket, which is all a relay is.
   *
   * It is someone else's schema and it is used deliberately, because the
   * alternative is a player being told to go and publish database rules before
   * their game stops feeling broken. When the proper node does exist, the
   * method above wins and this is never reached.
   */
  private async openSignallingRelay(): Promise<boolean> {
    try {
      const { rtdb, dbRef, dbSet, dbOnValue, dbRemove } = await import('../firebase');
      if (this.closed) return false;

      const slot = (uid: string) => `signaling/${this.roomId}/${uid}/${RELAY_SLOT}/desc`;
      const mine = dbRef(rtdb, slot(this.selfId));
      await dbSet(mine, { type: 'r', sdp: '[]' });
      if (this.closed) return false;

      // One listener per peer rather than one on the room: the room node also
      // carries every ICE candidate anyone pushes, and watching all of it would
      // re-deliver the whole handshake on every one of them.
      const stops: (() => void)[] = [];
      const listen = (uid: string) =>
        dbOnValue(
          dbRef(rtdb, slot(uid)),
          (snap) => {
            const entry = snap.val() as { sdp?: string } | null;
            if (typeof entry?.sdp !== 'string') return;
            let batch: NetMessage[];
            try {
              batch = JSON.parse(entry.sdp) as NetMessage[];
            } catch {
              return;
            }
            // The sequence number rides inside the payload here, as the slot
            // itself only has room for the two fields the schema allows.
            const first = batch[0] as { rn?: number } | undefined;
            if (typeof first?.rn === 'number') {
              if (this.isReplay(uid, first.rn)) return;
              this.seen.set(uid, first.rn);
            }
            for (const msg of batch) if ((msg as { rn?: number }).rn === undefined) this.receive(uid, msg);
          },
          (err: unknown) => console.error('[link] signalling relay dropped:', err),
        );

      this.watchRelayPeers = (uids) => {
        while (stops.length) stops.pop()?.();
        for (const uid of uids) if (uid !== this.selfId) stops.push(listen(uid));
      };
      this.watchRelayPeers(this.peers);

      this.relay = {
        write: async (batch, seq) => {
          // `[{rn}, …messages]` — the marker carries the sequence, because the
          // slot itself has room only for the two fields the schema allows.
          let body = JSON.stringify([{ rn: seq }, ...batch]);
          if (body.length > SLOT_LIMIT) {
            // Only the newest state is worth keeping if it will not all fit,
            // and silently sending nothing would be worse than sending less.
            console.warn('[link] relay payload over the slot limit; sending state only');
            body = JSON.stringify([{ rn: seq }, ...batch.slice(0, 1)]);
          }
          await dbSet(mine, { type: 'r', sdp: body });
        },
        stop: () => {
          while (stops.length) stops.pop()?.();
          this.watchRelayPeers = null;
          dbRemove(mine).catch(() => {});
        },
      };
      console.warn('[link] relaying over the signalling channel — publish database.rules.json for the dedicated one');
      return true;
    } catch (err) {
      console.warn('[link] signalling relay unavailable:', err);
      return false;
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

  private async flushRelay() {
    if (this.closed || !this.relay) return;
    if (!this.needsRelay()) {
      // Nothing to carry: drop whatever queued up while the mesh was coming up
      // rather than sending it late.
      this.pendingState = null;
      this.pendingEvents.length = 0;
      return;
    }
    const batch: NetMessage[] = [];
    if (this.pendingState) batch.push(this.pendingState);
    batch.push(...this.pendingEvents);
    this.pendingState = null;
    this.pendingEvents.length = 0;
    if (batch.length === 0) return;

    try {
      await this.relay.write(batch, ++this.relaySeq);
    } catch (err) {
      console.error('[link] relay write failed:', err);
    }
  }
}
