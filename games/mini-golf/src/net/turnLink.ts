/**
 * The wire, which is a single Firestore document each.
 *
 * Two of the other PlayBuddies games open a WebRTC mesh, because a volleyball
 * or a shoal of fish needs twenty position updates a second and routing those
 * through Firestore would be the largest bill on the platform. Golf needs
 * nothing of the sort: one putt is one write, and a whole round is a few dozen
 * of them.
 *
 * So this game does not open a peer connection at all, and gets three things
 * for free by not doing so — no STUN, no NAT traversal, and no "connecting…"
 * that never resolves on a corporate or mobile network where the mesh cannot
 * get through. It also means a player who reloads mid-round reads the whole
 * green straight out of the document rather than having to renegotiate.
 *
 * Each side writes only `lobbies/{room}/updates/{ownUid}`, which is exactly
 * what the security rules allow and nothing more.
 */
import type { NetPacket } from '../types/game';

type Unsubscribe = () => void;

export class TurnLink {
  private unsubscribes: Unsubscribe[] = [];
  private closed = false;
  private ready: Promise<void>;
  private write: ((packet: NetPacket) => Promise<void>) | null = null;
  /** Written before the connection is live; sent as soon as it is. */
  private queued: NetPacket | null = null;
  private stamp: Record<string, number> | undefined;

  constructor(
    private room: string,
    private selfUid: string,
    /**
     * Everyone else in the round.
     *
     * One document each, one listener each. A one-on-one has a single entry
     * here; a four-ball has three, which is still three listeners on three
     * small documents that change once a turn.
     */
    private peerUids: string[],
    private onPacket: (packet: NetPacket, from: string) => void,
    private onError?: (message: string) => void,
    /**
     * Fields merged into every packet this side writes.
     *
     * Each write *replaces* the document rather than adding to it, so without
     * this the opening negotiation is destroyed by the first putt that follows
     * it and a late subscriber has nothing to build a game from.
     */
    stamp?: Record<string, number>,
  ) {
    this.stamp = stamp;
    this.ready = this.open();
  }

  /**
   * Change what rides along on every write from here on.
   *
   * A guest does not know who tees off first until the host tells it, and once it
   * does it should be stamping that onto its own writes too — otherwise a
   * third player who joins late and happens to hear a guest's move first still
   * has no round to build.
   */
  setStamp(stamp: Record<string, number>) {
    this.stamp = stamp;
  }

  private async open() {
    try {
      const { db, doc, setDoc, onSnapshot } = await import('../firebase');
      if (this.closed) return;

      const mine = doc(db, 'lobbies', this.room, 'updates', this.selfUid);

      this.write = async (packet: NetPacket) => {
        // setDoc, not update: the document may not exist yet, and each write
        // completely replaces the last one anyway.
        await setDoc(mine, this.stamp ? { ...this.stamp, ...packet } : packet);
      };

      // Clear whatever the previous round left behind before anyone can read it
      // as a live turn.
      await setDoc(mine, { t: 'idle', n: 0 });
      if (this.closed) return;

      for (const peer of this.peerUids) {
        this.unsubscribes.push(
          onSnapshot(
            doc(db, 'lobbies', this.room, 'updates', peer),
            (snap) => {
              const data = snap.data() as NetPacket | undefined;
              // Who sent it matters once there are more than two of us: a
              // `bye` has to name the ball it is abandoning, and that cannot
              // be inferred from "the other one" any more.
              if (data && data.t !== 'idle') this.onPacket(data, peer);
            },
            (err) => {
              console.error('[turnLink] lost the wire to', peer, err);
              this.onError?.('Lost contact with one of the other players.');
            },
          ),
        );
      }

      if (this.queued) {
        const pending = this.queued;
        this.queued = null;
        await this.write(pending);
      }
    } catch (err) {
      console.error('[turnLink] could not open:', err);
      this.onError?.('Could not reach the other players.');
    }
  }

  /**
   * Send a turn.
   *
   * A putt made in the second before the document handle resolved is held
   * rather than dropped — losing the opening putt of a round to an import that
   * had not finished is the kind of bug that reads as "multiplayer is broken".
   * Only one is ever held, which is correct here: a shot packet carries the
   * whole green, so the newest one makes every older one redundant.
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
      this.onError?.('That putt did not reach the other players.');
    });
  }

  /**
   * @param announce Tell the others to give this seat to a bot, because this
   * player has actually gone. Left true for every real departure. The one
   * caller that passes false is a reconnect: that link is being replaced by a
   * fresh one a moment later, and announcing a bye in between would hand a
   * player who is still here to a bot for no reason.
   */
  close(announce = true) {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.unsubscribes) stop();
    this.unsubscribes = [];
    if (announce) this.write?.({ t: 'bye', n: Date.now() }).catch(() => {});
  }
}
