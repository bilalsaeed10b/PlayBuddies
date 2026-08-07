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
 */

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

interface Peer {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  stop: () => void;
  seen: Set<string>;
}

export class Mesh {
  private peers = new Map<string, Peer>();
  private closed = false;

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
    dbRemove(mine).catch(() => {});
  }

  /** Reconciles the connection set against the room roster. Safe to call on every roster change. */
  setPeers(uids: string[]) {
    if (this.closed) return;
    const wanted = new Set(uids.filter((u) => u && u !== this.selfId));

    for (const [id, peer] of this.peers) {
      if (!wanted.has(id)) {
        peer.stop();
        this.peers.delete(id);
        this.announce();
      }
    }
    for (const id of wanted) {
      if (!this.peers.has(id)) this.connect(id);
    }
  }

  get connectedPeers(): string[] {
    return [...this.peers.entries()].filter(([, p]) => p.dc.readyState === 'open').map(([id]) => id);
  }

  broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const peer of this.peers.values()) {
      if (peer.dc.readyState === 'open') {
        try {
          peer.dc.send(data);
        } catch {
          /* channel closed between the check and the send */
        }
      }
    }
  }

  sendTo(id: string, msg: unknown) {
    const peer = this.peers.get(id);
    if (peer?.dc.readyState !== 'open') return;
    try {
      peer.dc.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }

  close() {
    this.closed = true;
    for (const peer of this.peers.values()) peer.stop();
    this.peers.clear();
    dbRemove(dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}`)).catch(() => {});
  }

  private announce() {
    this.onPeersChanged?.(this.connectedPeers);
  }

  private connect(peerId: string) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Pre-negotiated channel: both sides create it with the same id, so there
    // is no ondatachannel race to lose.
    const dc = pc.createDataChannel('fish', {
      negotiated: true,
      id: 0,
      // Position updates are worthless the moment a newer one exists, so drop
      // them rather than stalling the channel to retransmit stale coordinates.
      ordered: false,
      maxRetransmits: 0,
    });

    const seen = new Set<string>();
    const mineRef = dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${peerId}`);
    const theirsRef = dbRef(rtdb, `signaling/${this.roomId}/${peerId}/${this.selfId}`);

    dc.onopen = () => this.announce();
    dc.onclose = () => this.announce();
    dc.onmessage = (e) => {
      try {
        this.onMessage(peerId, JSON.parse(e.data));
      } catch {
        /* a peer sending us garbage is their problem, not a crash */
      }
    };

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      dbPush(dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${peerId}/candidates`),
        JSON.stringify(e.candidate.toJSON())).catch(() => {});
    };

    // Lower uid calls, higher uid answers. Both sides compute the same answer
    // from data they already have, so no coordination round trip is needed.
    const iCall = this.selfId < peerId;

    const applyCandidates = (candidates?: Record<string, string> | null) => {
      if (!candidates) return;
      for (const raw of Object.values(candidates)) {
        if (seen.has(raw)) continue;
        seen.add(raw);
        try {
          pc.addIceCandidate(new RTCIceCandidate(JSON.parse(raw))).catch(() => {});
        } catch {
          /* malformed candidate — skip */
        }
      }
    };

    const unsub = dbOnValue(theirsRef, async (snap) => {
      const data = snap.val() as { desc?: RTCSessionDescriptionInit; candidates?: Record<string, string> } | null;
      if (!data) return;
      try {
        if (data.desc) {
          if (iCall && pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(data.desc));
          } else if (!iCall && pc.signalingState === 'stable' && !pc.currentRemoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(data.desc));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await dbSet(dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${peerId}/desc`), {
              type: answer.type,
              sdp: answer.sdp,
            });
          }
        }
        applyCandidates(data.candidates);
      } catch (err) {
        console.error('[mesh] negotiation failed with', peerId, err);
      }
    });

    if (iCall) {
      (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await dbSet(dbRef(rtdb, `signaling/${this.roomId}/${this.selfId}/${peerId}/desc`), {
            type: offer.type,
            sdp: offer.sdp,
          });
        } catch (err) {
          console.error('[mesh] offer failed for', peerId, err);
        }
      })();
    }

    const stop = () => {
      unsub();
      try {
        dc.close();
      } catch {
        /* already gone */
      }
      pc.close();
      dbRemove(mineRef).catch(() => {});
    };

    this.peers.set(peerId, { pc, dc, stop, seen });
  }
}
