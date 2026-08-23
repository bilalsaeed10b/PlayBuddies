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

/**
 * How often the Firestore relay writes while any peer is not yet reachable
 * directly. Every write here is billed, so this is not the send rate the game
 * would pick if the wire were free — it is the rate that keeps a relayed
 * match playable without keeping a room's write bill unbounded.
 */
const FS_ACTIVE_MS = 100;

/**
 * How often it writes once every peer is reachable directly.
 *
 * Not zero: a heartbeat this slow costs almost nothing, and it is what lets
 * the relay take over instantly if the mesh drops mid-match — a fresh
 * connection with no warm-up, rather than a cold start that has to open a
 * Firestore listener and wait for it to catch up before the first packet.
 */
const FS_IDLE_MS = 1000;

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
type FirestoreWrite = (batch: NetMessage[], seq: number) => Promise<void>;

export class Link {
  private mesh: Mesh;
  private peers: string[] = [];
  private rtts = new Map<string, number>();
  private fsWrite: FirestoreWrite | null = null;
  private stopFirestore: (() => void) | null = null;
  private fsTimer: number | null = null;
  private lastFsWrite = 0;
  private pingTimer: number | null = null;
  private relaySeq = 0;
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
    void this.openFirestore();
  }

  setPeers(uids: string[]) {
    this.peers = uids.filter((u) => u && u !== this.selfId);
    this.mesh.setPeers(this.peers);
    this.publishStatus();
  }

  /**
   * Sends to everyone.
   *
   * `live` marks a packet whose only value is being the newest one — a snapshot
   * or a body update. The relay keeps just the last of those; anything else is
   * queued and delivered. Always captured for Firestore too, regardless of
   * whether the mesh currently needs the help — see FS_IDLE_MS.
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
    if (this.fsTimer !== null) clearInterval(this.fsTimer);
    this.stopFirestore?.();
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
    // A peer counts as relayed the moment anything at all has arrived from
    // them over it — not only once a round-trip probe happens to have landed.
    // Gameplay itself proves the relay works; a slow first ping should not
    // leave the badge claiming there is no connection while a rally is
    // already in progress.
    const relayed = this.peers.filter(
      (id) => !directSet.has(id) && (this.seen.has(id) || this.rtts.has(id)),
    );
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
   * Arms the Firestore relay. Unconditional and immediate — see the note at
   * the top of this file for why that matters more than which path is fastest.
   */
  private async openFirestore() {
    try {
      const { db, doc, setDoc, collection, onSnapshot } = await import('../firebase');
      if (this.closed) return;

      const mine = doc(db, 'lobbies', this.roomId, 'updates', this.selfId);
      this.stopFirestore = onSnapshot(
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
        (err) => console.error('[link] Firestore relay unavailable:', err),
      );

      this.fsWrite = async (batch, seq) => {
        await setDoc(mine, { m: JSON.stringify(batch), n: seq, at: Date.now() });
      };

      // Ticks far more often than either send rate actually needs, because
      // each tick decides for itself — via needsRelay() — whether enough time
      // has passed to be worth a write yet. See FS_ACTIVE_MS / FS_IDLE_MS.
      this.fsTimer = window.setInterval(() => void this.flushFirestore(), FS_ACTIVE_MS);
    } catch (err) {
      console.error('[link] could not open the Firestore relay:', err);
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

  private async flushFirestore() {
    if (this.closed || !this.fsWrite) return;
    // Fast while somebody still needs the help; a slow heartbeat once nobody
    // does, so the relay stays warm without costing much. Never off outright —
    // that is exactly the gap the old gated version fell into.
    const interval = this.needsRelay() ? FS_ACTIVE_MS : FS_IDLE_MS;
    const now = Date.now();
    if (now - this.lastFsWrite < interval) return;

    const batch: NetMessage[] = [];
    if (this.pendingState) batch.push(this.pendingState);
    batch.push(...this.pendingEvents);
    this.pendingState = null;
    this.pendingEvents.length = 0;
    if (batch.length === 0) return;

    this.lastFsWrite = now;
    try {
      await this.fsWrite(batch, ++this.relaySeq);
    } catch (err) {
      console.error('[link] Firestore relay write failed:', err);
    }
  }
}
