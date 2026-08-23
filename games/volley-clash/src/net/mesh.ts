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
 * How long an attempt with *no sign of progress* gets before it is written off.
 *
 * This was 9 seconds, applied to every attempt on both sides regardless of what
 * ICE was doing, and it was a bug: a handshake that would have succeeded in
 * twelve seconds — an ordinary outcome on a slow link to a distant STUN server
 * — was torn down at nine, restarted, and torn down again, forever.
 *
 * The fix for that overshot. Widening it to 20 seconds with two extensions
 * meant a caller stuck in `checking` — which is exactly what "no TURN server"
 * looks like, and does not resolve itself no matter how long it is given —
 * could take a full 60 seconds before its first retry. The caller trying
 * again does not fix a pair that structurally cannot connect, so there is
 * nothing to buy by waiting that long; what matters is finding out fast and
 * telling the relay to carry the match, which DROPPED_MS in MatchView.tsx
 * does on its own timer. That timer was 8 seconds — shorter than even the
 * first window here — so on every connection that failed rather than merely
 * being slow, a real player's seat was handed to a bot before this file ever
 * got a chance to retry or report why. The two numbers have to be read
 * together; see the note by DROPPED_MS.
 */
const OPEN_DEADLINE = 6000;

/** How many extra windows an attempt that is still making progress may have. */
const MAX_EXTENSIONS = 1;

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
  /** Windows already granted to an attempt that was still making progress. */
  extensions: number;
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
    dbRemove(mine).catch((err) => console.error('[mesh] signalling unavailable:', err));
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
      extensions: 0,
    };
    peer.attempt = a;

    /**
     * The backstop.
     *
     * Only the caller runs one. The answerer cannot start a new negotiation of
     * its own — `retry` returns immediately for it — so all a timeout there
     * achieves is destroying a half-built connection the caller may still be
     * completing, and then waiting for an offer anyway. Both sides running this
     * is what turned one slow handshake into a permanent restart loop.
     */
    const watchdog = () => {
      a.deadline = null;
      if (a.dead || dc.readyState === 'open') return;

      const ice = pc.iceConnectionState;
      // `checking` means candidate pairs are actively being tested, and
      // `connected`/`completed` means only the data channel is late. Both are
      // progress, and tearing either down loses a connection that was on its
      // way. Real failure arrives as `failed` and is handled the moment it does.
      const working = ice === 'checking' || ice === 'connected' || ice === 'completed';
      if (working && a.extensions < MAX_EXTENSIONS) {
        a.extensions++;
        a.deadline = window.setTimeout(watchdog, OPEN_DEADLINE);
        return;
      }

      const blocked = !a.gathered.has('srflx');
      const verdict = blocked ? 'STUN blocked on this network' : 'this pair needs a TURN server';
      console.warn(
        `[mesh] no channel to ${peerId} after ${OPEN_DEADLINE * (a.extensions + 1)}ms —` +
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
      this.retry(peerId, peer, iCall);
    };
    if (iCall) a.deadline = window.setTimeout(watchdog, OPEN_DEADLINE);

    const mineRef = dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${peerId}`);
    // A retry must not inherit the previous attempt's candidates: they point at
    // ports that are already closed, and the other side would spend its whole
    // ICE budget on them.
    dbRemove(mineRef).catch(() => {});

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
      dbPush(
        dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${peerId}/candidates`),
        JSON.stringify(e.candidate.toJSON()),
      )
        // Loud on purpose. A permission error here means the database rules
        // were never deployed, and the symptom players see is "multiplayer
        // doesn't work" with nothing in the console to explain it.
        .catch((err) => console.error('[mesh] could not publish ICE candidate:', err));
    };

    pc.onconnectionstatechange = () => {
      if (a.dead) return;
      const state = pc.connectionState;
      if (state === 'failed') {
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
