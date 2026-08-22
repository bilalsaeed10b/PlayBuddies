/**
 * The wire, which is a single Firestore document each.
 *
 * The other PlayBuddies games open a WebRTC mesh, because a volleyball or a
 * shoal of fish needs twenty position updates a second and routing those
 * through Firestore would be the largest bill on the platform. A turn-based
 * duel needs nothing of the sort: one shot is one write, and a whole match is
 * about a dozen of them.
 *
 * So this game does not open a peer connection at all, and gets three things
 * for free by not doing so -- no STUN, no NAT traversal, and no "connecting"
 * that never resolves on a corporate or mobile network where the mesh cannot
 * get through. It also means a player who reloads mid-match reads the current
 * turn straight out of the document rather than having to renegotiate.
 *
 * Each side writes only `lobbies/{room}/updates/{ownUid}`, which is exactly
 * what the security rules allow and nothing more.
 */
import type { NetPacket } from '../types/game';

type Unsubscribe = () => void;

export class TurnLink {
  private unsubscribe: Unsubscribe | null = null;
  private closed = false;
  private ready: Promise<void>;
  private write: ((packet: NetPacket) => Promise<void>) | null = null;
  /** Written before the connection is live; sent as soon as it is. */
  private queued: NetPacket | null = null;

  constructor(
    private room: string,
    private selfUid: string,
    private peerUid: string,
    private onPacket: (packet: NetPacket) => void,
    private onError?: (message: string) => void,
    /**
     * Fields merged into every packet this side writes.
     *
     * The host stamps the match's opening terms here. Each write replaces the
     * document rather than adding to it, so without this the start packet is
     * destroyed by the first shot that follows it and a late subscriber has
     * nothing to build a match from.
     */
    private stamp?: Record<string, number>,
  ) {
    this.ready = this.open();
  }

  private async open() {
    try {
      const { db, doc, setDoc, onSnapshot } = await import('../firebase');
      if (this.closed) return;

      const mine = doc(db, 'lobbies', this.room, 'updates', this.selfUid);
      const theirs = doc(db, 'lobbies', this.room, 'updates', this.peerUid);

      this.write = async (packet: NetPacket) => {
        // setDoc, not update: the document may not exist yet, and each turn
        // completely replaces the last one anyway.
        await setDoc(mine, this.stamp ? { ...this.stamp, ...packet } : packet);
      };

      // Clear whatever the previous match left behind before anyone can read
      // it as a live turn.
      await setDoc(mine, { t: 'idle', n: 0 });
      if (this.closed) return;

      this.unsubscribe = onSnapshot(
        theirs,
        (snap) => {
          const data = snap.data() as NetPacket | undefined;
          if (data && data.t !== 'idle') this.onPacket(data);
        },
        (err) => {
          console.error('[turnLink] lost the wire:', err);
          this.onError?.('Lost contact with the other ship.');
        },
      );

      if (this.queued) {
        const pending = this.queued;
        this.queued = null;
        await this.write(pending);
      }
    } catch (err) {
      console.error('[turnLink] could not open:', err);
      this.onError?.('Could not reach the other ship.');
    }
  }

  /**
   * Send a turn.
   *
   * A shot fired in the second before the document handle resolved is held
   * rather than dropped -- losing the opening shot of a match to an import
   * that had not finished is the kind of bug that reads as "multiplayer is
   * broken".
   */
  send(packet: NetPacket) {
    if (this.closed) return;
    if (!this.write) {
      this.queued = packet;
      void this.ready;
      return;
    }
    this.write(packet).catch((err) => {
      console.error('[turnLink] could not send:', err);
      this.onError?.('That shot did not reach the other ship.');
    });
  }

  /**
   * @param announce Tell the other side to give the wheel to a bot, because
   * this player has actually gone. Left true for every real departure. The
   * one caller that passes false is a reconnect: that link is being replaced
   * by a fresh one a moment later, and announcing a bye in between would send
   * a partner who is still here to a bot for no reason.
   */
  close(announce = true) {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (announce) this.write?.({ t: 'bye', n: Date.now() }).catch(() => {});
  }
}
