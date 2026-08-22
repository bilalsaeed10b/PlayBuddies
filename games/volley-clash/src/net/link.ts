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

/** Relay writes per second, per player. Deliberately below the mesh's rate. */
const RELAY_HZ = 8;
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
}

type Handler = (from: string, msg: NetMessage) => void;

interface RelayApi {
  write: (payload: string, seq: number) => Promise<void>;
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
    );

    this.pingTimer = window.setInterval(() => this.ping(), 1000 / BALANCE.PING_HZ);
    void this.openRelay();
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
    try {
      const { db, doc, setDoc, collection, onSnapshot } = await import('../firebase');
      if (this.closed) return;

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
            const last = this.seen.get(from);
            if (last !== undefined && data.n <= last && data.n > last - 60) continue;
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
        write: async (payload, seq) => {
          await setDoc(mine, { m: payload, n: seq, at: Date.now() });
        },
        stop,
      };

      this.relayTimer = window.setInterval(() => void this.flushRelay(), 1000 / RELAY_HZ);
    } catch (err) {
      console.error('[link] could not arm the relay:', err);
    }
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
      await this.relay.write(JSON.stringify(batch), ++this.relaySeq);
    } catch (err) {
      console.error('[link] relay write failed:', err);
    }
  }
}
