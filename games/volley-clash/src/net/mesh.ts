import { rtdb, dbRef, dbSet, dbPush, dbOnValue, dbOnDisconnect, dbRemove } from '../firebase';

/**
 * A full WebRTC mesh for up to eight players, signalled through Realtime
 * Database and nothing else.
 *
 * Why a mesh and not a server: PlayBuddies is a static site. There is no game
 * server to run authority on, and routing 8 players' positions through
 * Firestore at even 10Hz is roughly 5,000 billed writes a minute *per room* —
 * the single largest cost in the whole platform, and it would grow linearly
 * with players. Peer-to-peer traffic costs nothing and is an order of magnitude
 * lower latency. Firebase is used only to introduce the peers to each other.
 *
 * Signalling lives at `signaling/{room}/{sender}/{recipient}/…` — one channel
 * per direction per pair. The old single-slot-per-uid layout could only carry
 * one negotiation at a time, which is fine for a two-player game and useless
 * for a mesh.
 *
 * Offer/answer roles are decided by comparing uids, so both sides independently
 * agree on who calls whom and glare never happens.
 *
 * **A failed handshake is not the end of it.** With only STUN and no TURN, a
 * first attempt across two unhelpful NATs fails often enough that "multiplayer
 * doesn't work" was the normal experience rather than the rare one. Every peer
 * now retries with backoff, forever, and each attempt tears the old connection
 * down and negotiates a genuinely new one. The watcher that reads the other
 * side's signalling outlives those attempts, so a peer that restarts on its own
 * is noticed and answered rather than ignored.
 */

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * Which mesh instance owns each `room/player` signalling path, and a counter
 * to tell instances apart.
 *
 * Module scope because the point is precisely to be visible across instances:
 * a rematch builds the next mesh before the last one has finished tidying up.
 */
const OWNER = new Map<string, number>();
let MESH_SESSION = 0;

/** The candidate types inside a set of raw candidate JSON, for diagnostics. */
function typesOf(raw: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const one of raw) {
    // "candidate:… typ srflx …" — the type is the token after `typ`.
    const match = /typ (\w+)/.exec(one);
    if (match) out.add(match[1]);
  }
  return out;
}

/** Retry backoff, in ms, indexed by attempt. The last entry repeats. */
const BACKOFF = [700, 1500, 3000, 5000, 8000];

/** How long a connection may sit in `disconnected` before it is rebuilt. */
const DISCONNECT_GRACE = 3500;

/**
 * How often the watchdog checks in on an attempt that has not yet opened.
 *
 * This used to also be the *ceiling* — a fixed budget of one or two windows,
 * after which a caller still in `checking` was killed and restarted from a
 * fresh RTCPeerConnection regardless of whether it was making progress. It
 * was not: `checking` means the ICE agent is actively working through a
 * matrix of candidate pairs, which a route across real distance can
 * legitimately take longer than a couple of windows to finish, especially
 * gathering from three STUN servers. Killing it there never let one attempt
 * run long enough to find out, and every restart threw away the gathering
 * already done. See the watchdog itself, below, for why it now re-arms for
 * as long as there is real activity instead of capping it.
 */
const OPEN_DEADLINE = 6000;

interface Attempt {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  /** Candidates from the other side that this attempt has already taken in. */
  seen: Set<string>;
  /**
   * Candidates that arrived before there was a remote description to attach
   * them to.
   *
   * `addIceCandidate` rejects outright until `setRemoteDescription` has
   * resolved, and the answer and the first candidates almost always arrive in
   * the same signalling update — so without somewhere to put them, the entire
   * opening batch is thrown away. They are never re-sent, because the sender
   * has no idea anything was lost, and the connection then has nothing to try
   * but the local half of the pair. That is not a connection that fails loudly;
   * it is one that quietly never happens.
   */
  queued: string[];
  /**
   * Candidate types this side gathered, e.g. `host`, `srflx`, `relay`.
   *
   * The single most useful thing to know when a connection does not happen. No
   * `srflx` at all means STUN never answered and the network is blocking it;
   * `srflx` on both sides that still never connects means the two NATs will not
   * talk without a relay, which no amount of retrying will change.
   */
  gathered: Set<string>;
  dead: boolean;
  /** Fires if the channel never opens. Cleared the moment it does. */
  deadline: number | null;
}

interface Peer {
  /** The live negotiation, replaced wholesale on every retry. */
  attempt: Attempt | null;
  /** Stops the signalling watcher. Outlives individual attempts. */
  unwatch: () => void;
  /** Their last description this peer has acted on, to spot a restart. */
  lastDesc: string | null;
  /**
   * An answer that arrived before there was a local offer to attach it to.
   *
   * Held rather than discarded. A retry rebuilds the connection asynchronously
   * — `createOffer` is a promise — and an answer landing inside that window
   * used to be thrown away *and* marked as seen, so the caller sat on an
   * unanswered offer until its next timeout. On a link where the handshake was
   * already slow, that is a loop that never terminates.
   */
  pendingDesc: RTCSessionDescriptionInit | null;
  tries: number;
  retryTimer: number | null;
  graceTimer: number | null;
  /** Whether this peer's failure has already been reported. */
  told: boolean;
}

export class Mesh {
  private peers = new Map<string, Peer>();
  private closed = false;
  /** Identifies this instance among every mesh this tab has opened. See `owns`. */
  private readonly session = ++MESH_SESSION;
  private ownerKey: string | null = null;
  /**
   * Resolves once the signalling path has been cleared of the last session.
   *
   * Every write below waits on it. Nothing outside this class does.
   */
  private ready: Promise<void> = Promise.resolve();

  constructor(
    private roomId: string,
    private selfId: string,
    private onMessage: (from: string, msg: unknown) => void,
    private onPeersChanged?: (connected: string[]) => void,
    /**
     * Why peer-to-peer is not happening, in a few words fit to show a player.
     *
     * Reported at most once per peer. The console carries the detail; this is
     * for the person looking at the game, who has no reason to open DevTools
     * and every reason to wonder why it says relay.
     */
    private onTrouble?: (peerId: string, verdict: string) => void,
  ) {
    // Clear anything a previous session in this room left behind, and make sure
    // a crashed tab doesn't strand its half of every negotiation. Fire-and-
    // forget: nothing else in this class, or outside it, waits on this settling.
    const mine = dbRef(rtdb, `signaling/${roomId}/${selfId}`);
    dbOnDisconnect(mine).remove().catch(() => {});

    // This mesh now owns the path, and any older one for the same room and
    // player must not touch it again. See `owns`.
    const key = `${roomId}/${selfId}`;
    OWNER.set(key, this.session);
    this.ownerKey = key;

    // Held, not fired and forgotten. Every signalling write below waits on it,
    // because the wipe and the first offer both target the same node and the
    // wipe landing second deletes the offer -- which is what made the *second*
    // match of a session always fall back to the relay. On a first match there
    // is nothing to delete, so the remove returns immediately and nobody ever
    // saw it; on a rematch there is a whole session's worth of candidates to
    // clear, the remove takes real time, and it routinely landed last.
    this.ready = dbRemove(mine).catch((err) => {
      console.error('[mesh] signalling unavailable:', err);
    });
  }

  /**
   * Whether this instance still owns its signalling path.
   *
   * A mesh is closed and a new one opened for the same room every time a
   * rematch starts, and the old one's cleanup is asynchronous. Without this,
   * a delete queued by the *previous* match could land after the next match
   * had already published its offer and quietly wipe it -- the connection then
   * never forms, every packet goes the long way round, and the badge reads a
   * few hundred milliseconds for the rest of the match with nothing in the
   * console to explain it.
   */
  private owns(): boolean {
    return this.ownerKey !== null && OWNER.get(this.ownerKey) === this.session;
  }

  /** Reconciles the connection set against the room roster. Safe to call on every roster change. */
  setPeers(uids: string[]) {
    if (this.closed) return;
    const wanted = new Set(uids.filter((u) => u && u !== this.selfId));

    for (const [id, peer] of this.peers) {
      if (!wanted.has(id)) {
        this.teardown(id, peer);
        this.peers.delete(id);
        this.announce();
      }
    }
    for (const id of wanted) {
      if (!this.peers.has(id)) this.open(id);
    }
  }

  get connectedPeers(): string[] {
    return [...this.peers.entries()]
      .filter(([, p]) => p.attempt?.dc.readyState === 'open')
      .map(([id]) => id);
  }

  /** Peers we are still trying to reach. The caller relays for these. */
  get pendingPeers(): string[] {
    return [...this.peers.entries()]
      .filter(([, p]) => p.attempt?.dc.readyState !== 'open')
      .map(([id]) => id);
  }

  broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const peer of this.peers.values()) {
      if (peer.attempt?.dc.readyState === 'open') {
        try {
          peer.attempt.dc.send(data);
        } catch {
          /* channel closed between the check and the send */
        }
      }
    }
  }

  sendTo(id: string, msg: unknown): boolean {
    const dc = this.peers.get(id)?.attempt?.dc;
    if (dc?.readyState !== 'open') return false;
    try {
      dc.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.closed = true;
    for (const [id, peer] of this.peers) this.teardown(id, peer);
    this.peers.clear();
    // Only if a newer mesh has not already taken the path over. A rematch
    // opens the next one before this one's cleanup has settled.
    if (!this.owns()) return;
    if (this.ownerKey) OWNER.delete(this.ownerKey);
    dbRemove(dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}`)).catch(() => {});
  }

  private announce() {
    this.onPeersChanged?.(this.connectedPeers);
  }

  private teardown(id: string, peer: Peer) {
    peer.unwatch();
    this.killAttempt(peer);
    if (peer.retryTimer !== null) clearTimeout(peer.retryTimer);
    if (peer.graceTimer !== null) clearTimeout(peer.graceTimer);
    if (!this.owns()) return;
    dbRemove(dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${id}`)).catch(() => {});
  }

  private killAttempt(peer: Peer) {
    const a = peer.attempt;
    if (!a) return;
    a.dead = true;
    peer.attempt = null;
    if (a.deadline !== null) clearTimeout(a.deadline);
    try {
      a.dc.close();
    } catch {
      /* already gone */
    }
    try {
      a.pc.close();
    } catch {
      /* already gone */
    }
  }

  /**
   * Starts watching a peer, and keeps watching it for as long as it is in the
   * room. Individual connection attempts come and go underneath this.
   */
  private open(peerId: string) {
    // Lower uid calls, higher uid answers. Both sides compute the same answer
    // from data they already have, so no coordination round trip is needed.
    const iCall = this.selfId < peerId;
    const theirsRef = dbRef(rtdb, `signaling/${this.roomId}/${peerId}/${this.selfId}`);

    const peer: Peer = {
      attempt: null,
      unwatch: () => {},
      lastDesc: null,
      pendingDesc: null,
      told: false,
      tries: 0,
      retryTimer: null,
      graceTimer: null,
    };
    this.peers.set(peerId, peer);

    peer.unwatch = dbOnValue(theirsRef, (snap) => {
      const data = snap.val() as
        | { desc?: RTCSessionDescriptionInit; candidates?: Record<string, string> }
        | null;
      if (this.closed || this.peers.get(peerId) !== peer) return;
      if (!data?.desc) return;

      const sdp = data.desc.sdp ?? '';
      if (sdp !== peer.lastDesc) {
        if (!iCall) {
          // Their offer — and every offer is a fresh session, including the one
          // that arrives because *they* gave up on the last attempt. Answering
          // it on the old connection is what used to leave one side happily
          // "connected" to a peer that had already moved on.
          peer.lastDesc = sdp;
          this.attempt(peerId, peer, false, data.desc);
        } else {
          // Their answer. Applied the moment our offer is on the table, and
          // kept until then.
          peer.pendingDesc = data.desc;
          this.applyAnswer(peerId, peer);
        }
      }

      this.takeCandidates(peer, data.candidates);
    });

    if (iCall) this.attempt(peerId, peer, true);
  }

  /**
   * Applies a held answer, if there is one and we are ready for it.
   *
   * Called both when an answer arrives and when our own offer finishes being
   * set, because either can happen first.
   */
  private applyAnswer(peerId: string, peer: Peer) {
    const a = peer.attempt;
    const desc = peer.pendingDesc;
    if (!a || a.dead || !desc) return;
    if (a.pc.signalingState !== 'have-local-offer') return;

    peer.pendingDesc = null;
    peer.lastDesc = desc.sdp ?? '';
    void a.pc
      .setRemoteDescription(new RTCSessionDescription(desc))
      .then(() => this.flushCandidates(a))
      .catch((err) => console.error('[mesh] answer rejected by', peerId, err));
  }

  private takeCandidates(peer: Peer, candidates?: Record<string, string> | null) {
    const a = peer.attempt;
    if (!a || !candidates) return;
    for (const raw of Object.values(candidates)) {
      if (a.seen.has(raw)) continue;
      a.seen.add(raw);
      a.queued.push(raw);
    }
    this.flushCandidates(a);
  }

  /**
   * Hands over every candidate held back, once there is a remote description
   * for them to belong to. Safe to call at any time; it does nothing until
   * there is.
   */
  private flushCandidates(a: Attempt) {
    if (a.dead || !a.pc.remoteDescription || a.queued.length === 0) return;
    const batch = a.queued.splice(0, a.queued.length);
    for (const raw of batch) {
      try {
        a.pc
          .addIceCandidate(new RTCIceCandidate(JSON.parse(raw)))
          // Loud, because a rejected candidate is a route to the other player
          // being thrown away, and the symptom is a game that silently plays
          // over the slow path instead.
          .catch((err) => console.warn('[mesh] candidate rejected:', err));
      } catch {
        /* malformed candidate — skip */
      }
    }
  }

  /** One connection attempt. Replaces whatever was there before. */
  private attempt(peerId: string, peer: Peer, iCall: boolean, offer?: RTCSessionDescriptionInit) {
    if (this.closed) return;
    this.killAttempt(peer);
    // Anything held from the last attempt answered an offer that no longer
    // exists. The peer will answer this one.
    peer.pendingDesc = null;
    if (peer.graceTimer !== null) {
      clearTimeout(peer.graceTimer);
      peer.graceTimer = null;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    // Pre-negotiated channel: both sides create it with the same id, so there
    // is no ondatachannel race to lose.
    const dc = pc.createDataChannel('play', {
      negotiated: true,
      id: 0,
      // Position updates are worthless the moment a newer one exists, so drop
      // them rather than stalling the channel to retransmit stale coordinates.
      ordered: false,
      maxRetransmits: 0,
    });
    const a: Attempt = {
      pc,
      dc,
      seen: new Set(),
      queued: [],
      gathered: new Set(),
      dead: false,
      deadline: null,
    };
    peer.attempt = a;

    /**
     * Explains a negotiation that did not work out, once, and hands back to
     * the caller so it can decide what to do next.
     *
     * Shared between two genuinely different triggers. `onconnectionstatechange`
     * calls this the moment the browser's own ICE agent reaches `failed` —
     * which is the real "exhausted every candidate pair, no route exists"
     * signal, and the one that matters most. The watchdog below calls it too,
     * but only for a connection stuck at `new`: gathering never produced
     * anything to try at all, which is a different and rarer problem (usually
     * signalling, not routing) but still worth a word.
     */
    const reportTrouble = (ice: RTCIceConnectionState) => {
      const blocked = !a.gathered.has('srflx');
      const verdict = blocked ? 'STUN blocked on this network' : 'this pair needs a TURN server';
      console.warn(
        `[mesh] no channel to ${peerId} —` +
          ` ice: ${ice}, gathering: ${pc.iceGatheringState},` +
          ` ours: [${[...a.gathered].join(', ') || 'nothing'}],` +
          ` theirs: [${[...typesOf(a.seen)].join(', ') || 'nothing'}]`,
        blocked
          ? 'No server-reflexive candidate at all — STUN is being blocked on this network.'
          : 'Both sides are reachable from outside but no route between them was found: this pair needs a TURN server.',
      );
      if (!peer.told) {
        peer.told = true;
        this.onTrouble?.(peerId, verdict);
      }
    };

    /**
     * The backstop, for a connection that never even started checking.
     *
     * Only the caller runs one. The answerer cannot start a new negotiation of
     * its own — `retry` returns immediately for it.
     *
     * This used to also be where a stalled *`checking`* connection was killed
     * and restarted from a fresh RTCPeerConnection after a fixed budget. That
     * was wrong: `checking` means the ICE agent is actively working through a
     * matrix of candidate pairs, which a route across real distance can
     * genuinely take longer than a couple of windows to finish, especially
     * gathering from three STUN servers. Killing it there never let one
     * attempt run long enough to find out, and every restart threw away the
     * gathering already done — a loop that could not succeed even on a pair
     * that would have connected fine given the time its own ICE agent wanted
     * to spend on it. Comparing against this game's Fireboy & Watergirl
     * confirms it: that connection has no watchdog at all and simply waits,
     * and it connects across real distance without a TURN server. The real
     * "no route exists" signal is `failed`, and that is now handled directly
     * by `onconnectionstatechange` instead of guessed at here.
     *
     * Waiting indefinitely for `new` to resolve is *not* safe the same way —
     * unlike `checking`, nothing is actively happening while gathering has
     * produced nothing at all, and that usually means signalling itself is
     * stuck. So this still fires once, reports it, and retries — same as
     * before, just now only for that case rather than for `checking` too.
     */
    const watchdog = () => {
      a.deadline = null;
      if (a.dead || dc.readyState === 'open') return;
      const ice = pc.iceConnectionState;
      if (ice === 'checking' || ice === 'connected' || ice === 'completed') {
        a.deadline = window.setTimeout(watchdog, OPEN_DEADLINE);
        return;
      }
      reportTrouble(ice);
      this.retry(peerId, peer, iCall);
    };
    if (iCall) a.deadline = window.setTimeout(watchdog, OPEN_DEADLINE);

    const mineRef = dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${peerId}`);
    // A retry must not inherit the previous attempt's candidates: they point at
    // ports that are already closed, and the other side would spend its whole
    // ICE budget on them.
    const cleared = this.ready.then(() => (this.owns() ? dbRemove(mineRef) : undefined)).catch(() => {});

    dc.onopen = () => {
      if (a.dead) return;
      peer.tries = 0;
      if (a.deadline !== null) {
        clearTimeout(a.deadline);
        a.deadline = null;
      }
      this.announce();
    };
    dc.onclose = () => {
      if (a.dead) return;
      this.announce();
      this.retry(peerId, peer, iCall);
    };
    dc.onmessage = (e) => {
      try {
        this.onMessage(peerId, JSON.parse(e.data));
      } catch {
        /* a peer sending us garbage is their problem, not a crash */
      }
    };

    pc.onicecandidate = (e) => {
      if (!e.candidate || a.dead) return;
      if (e.candidate.type) a.gathered.add(e.candidate.type);
      // After the clear, or the clear takes the candidate with it.
      void cleared
        .then(() => {
          if (a.dead || !this.owns()) return undefined;
          return dbPush(
            dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${peerId}/candidates`),
            JSON.stringify(e.candidate!.toJSON()),
          );
        })
        // Loud on purpose. A permission error here means the database rules
        // were never deployed, and the symptom players see is "multiplayer
        // doesn't work" with nothing in the console to explain it.
        .catch((err) => console.error('[mesh] could not publish ICE candidate:', err));
    };

    pc.onconnectionstatechange = () => {
      if (a.dead) return;
      const state = pc.connectionState;
      if (state === 'failed') {
        // The browser's own ICE agent has exhausted every candidate pair it
        // gathered and found no route — the real version of the thing the
        // watchdog above used to guess at from a timeout.
        reportTrouble(pc.iceConnectionState);
        this.retry(peerId, peer, iCall);
      } else if (state === 'disconnected') {
        // Usually a blip. Give it a moment to come back on its own before
        // paying for a whole new handshake.
        if (peer.graceTimer === null) {
          peer.graceTimer = window.setTimeout(() => {
            peer.graceTimer = null;
            if (!a.dead && pc.connectionState !== 'connected') this.retry(peerId, peer, iCall);
          }, DISCONNECT_GRACE);
        }
      } else if (state === 'connected' && peer.graceTimer !== null) {
        clearTimeout(peer.graceTimer);
        peer.graceTimer = null;
      }
    };

    void (async () => {
      try {
        if (iCall) {
          const local = await pc.createOffer();
          if (a.dead) return;
          await pc.setLocalDescription(local);
          // An answer may already be waiting — see Peer.pendingDesc.
          this.applyAnswer(peerId, peer);
          // After the path has been cleared of the last session, never before:
          // the clear targets the node this offer is written into.
          await cleared;
          if (a.dead || !this.owns()) return;
          await dbSet(dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${peerId}/desc`), {
            type: local.type,
            sdp: local.sdp,
          });
        } else if (offer) {
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
          if (a.dead) return;
          // Their candidates may already be waiting: the offer and the first of
          // them arrive together far more often than not.
          this.flushCandidates(a);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await cleared;
          if (a.dead || !this.owns()) return;
          await dbSet(dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${peerId}/desc`), {
            type: answer.type,
            sdp: answer.sdp,
          });
        }
      } catch (err) {
        console.error('[mesh] negotiation failed with', peerId, err);
        this.retry(peerId, peer, iCall);
      }
    })();
  }

  /**
   * Schedules another attempt.
   *
   * Only the caller side re-offers. If the answerer gave up first it simply
   * waits: the caller's next offer is a new description, and the watcher above
   * turns that into a fresh attempt on this side too.
   */
  private retry(peerId: string, peer: Peer, iCall: boolean) {
    if (this.closed || this.peers.get(peerId) !== peer || peer.retryTimer !== null) return;
    this.killAttempt(peer);
    this.announce();
    if (!iCall) return;

    const wait = BACKOFF[Math.min(peer.tries, BACKOFF.length - 1)];
    peer.tries++;
    peer.retryTimer = window.setTimeout(() => {
      peer.retryTimer = null;
      if (this.closed || this.peers.get(peerId) !== peer) return;
      peer.lastDesc = null;
      this.attempt(peerId, peer, true);
    }, wait);
  }
}
