/**
 * What time it is on the other machine, and how long a packet actually took.
 *
 * Everything this game draws for a remote player is a guess about the present
 * built from a packet describing the past, so the single number the whole
 * synchronisation rests on is *how old is this packet*. Get that wrong and
 * every body and the ball are placed wrong — not jittery, wrong — and no
 * amount of smoothing downstream can recover it.
 *
 * The previous answer was `rtt / 2`, from a round-trip probe sent once a
 * second and folded into an exponential average. Three things were wrong with
 * it, and all three showed up as the same complaint:
 *
 *   1. One sample a second, smoothed at 0.3, needs about five seconds to
 *      follow a change. A phone's latency moves further than that between two
 *      rallies, so the extrapolation distance was chronically describing the
 *      network as it had been, not as it was.
 *
 *   2. `rtt / 2` is only the one-way delay if both directions are equal. When
 *      a pair falls back to the Firestore relay they are not remotely equal:
 *      each leg waits on its sender's write batching, so the measured round
 *      trip carried up to a couple of hundred milliseconds of *queueing* that
 *      the packet's contents had not aged by at all. That queueing was then
 *      handed to the physics as though it were time of flight.
 *
 *   3. The estimate was per-room, not per-peer, and fell back to the *worst*
 *      peer's figure for anyone not yet measured. In a 2v2 a player on a
 *      30ms direct channel spent the first second being extrapolated by a
 *      relayed peer's 400ms.
 *
 * So this file stops estimating age and starts measuring it. Probes carry the
 * four timestamps NTP uses, which is enough to solve for both the round trip
 * and the offset between the two machines' clocks:
 *
 *     t0  we send                     t1  they receive
 *     t2  they reply                  t3  we receive
 *
 *     rtt    = (t3 - t0) - (t2 - t1)
 *     offset = ((t1 - t0) + (t2 - t3)) / 2
 *
 * Subtracting `t2 - t1` is the part that matters here: it removes however long
 * the reply sat in the peer's own relay batch before leaving, so what is left
 * is time actually spent in flight. Once the offset is known, a packet's age
 * stops being inferred from the round trip at all — the sender stamps its own
 * clock, the receiver converts that into its own, and subtracts. That is a
 * measurement, and it stays correct on a path whose two directions are
 * nothing like each other.
 *
 * Sample selection is NTP's as well: keep a window, and trust the offset from
 * the sample with the *lowest* round trip. A fast round trip is one that got
 * through without queueing anywhere, which makes its offset the least
 * contaminated — and picking the best of a window converges in a couple of
 * probes rather than easing towards the truth over five seconds, while
 * rejecting a single slow packet outright instead of averaging it in.
 */

/** How many probe results are kept per peer. At PING_HZ this is a few seconds. */
const WINDOW = 16;

/**
 * How long a sample may still be selected as the best one.
 *
 * Without this a single unusually fast probe would pin the offset forever, and
 * a path that genuinely changed — a phone moving from wifi to mobile data —
 * would never be believed.
 */
const SAMPLE_TTL_MS = 12_000;

/** A round trip beyond this is a stalled tab or a broken reply, not a network. */
const MAX_PLAUSIBLE_RTT = 4000;

/**
 * Local time, in milliseconds, on a base that does not jump.
 *
 * `Date.now()` is wall clock and can be stepped by the operating system's own
 * time sync mid-match; a step of a few hundred milliseconds is normal and would
 * land here as a phantom change in the peer's offset. `performance.now()` is
 * monotonic, and adding the time origin puts it on roughly the same scale as
 * wall clock so the numbers stay readable in a log.
 */
export function localNow(): number {
  return performance.timeOrigin + performance.now();
}

interface Sample {
  rtt: number;
  offset: number;
  at: number;
}

export interface PeerTiming {
  /** Typical round trip in ms — the median of the window. For display. */
  rtt: number;
  /** The floor: the fastest round trip seen recently, i.e. the path's real cost. */
  rttMin: number;
  /** How much the round trip is moving about, in ms. */
  jitter: number;
  /** Their clock minus ours, in ms. */
  offset: number;
  /** True once enough probes have landed to extrapolate on. */
  ready: boolean;
  samples: number;
}

const EMPTY: PeerTiming = { rtt: 0, rttMin: 0, jitter: 0, offset: 0, ready: false, samples: 0 };

/**
 * One peer's timing. `PeerClocks` below owns a map of these.
 */
class PeerClock {
  private samples: Sample[] = [];
  private cached: PeerTiming = EMPTY;
  private dirty = true;

  /**
   * Folds in one completed probe.
   *
   * Returns false for a sample that is not physically possible — a negative
   * round trip, or one long enough that the reply was almost certainly sitting
   * in a backgrounded tab rather than on a wire. Those are dropped rather than
   * clamped: a clamped nonsense sample is still nonsense, and it would compete
   * to be the window's best.
   */
  add(t0: number, t1: number, t2: number, t3: number): boolean {
    const rtt = (t3 - t0) - (t2 - t1);
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > MAX_PLAUSIBLE_RTT) return false;

    const offset = ((t1 - t0) + (t2 - t3)) / 2;
    if (!Number.isFinite(offset)) return false;

    this.samples.push({ rtt, offset, at: t3 });
    if (this.samples.length > WINDOW) this.samples.shift();
    this.dirty = true;
    return true;
  }

  get timing(): PeerTiming {
    if (!this.dirty) return this.cached;

    const cutoff = localNow() - SAMPLE_TTL_MS;
    // Expired samples are dropped here rather than on a timer: the window is
    // tiny, this runs on read, and it means a peer nobody is asking about
    // costs nothing at all.
    if (this.samples.length > 0 && this.samples[0].at < cutoff) {
      this.samples = this.samples.filter((s) => s.at >= cutoff);
    }

    if (this.samples.length === 0) {
      this.cached = EMPTY;
      this.dirty = false;
      return this.cached;
    }

    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;

    const sorted = this.samples.map((s) => s.rtt).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    let spread = 0;
    for (const r of sorted) spread += Math.abs(r - median);

    this.cached = {
      rtt: Math.round(median),
      rttMin: Math.round(best.rtt),
      jitter: Math.round(spread / sorted.length),
      offset: best.offset,
      // Two agreeing probes is enough to act on and takes a quarter of a second
      // at PING_HZ. Waiting for a full window would mean the opening rally of
      // every match is played on the fallback path below.
      ready: this.samples.length >= 2,
      samples: this.samples.length,
    };
    this.dirty = false;
    return this.cached;
  }
}

/**
 * Every peer's clock, and the conversions the game actually asks for.
 */
export class PeerClocks {
  private clocks = new Map<string, PeerClock>();

  /** Probes we have sent and not yet had answered, by probe id. */
  private inflight = new Map<number, { to: string; t0: number }>();
  private nextId = 1;

  /**
   * Mints the outgoing half of a probe.
   *
   * The id is what pairs an echo with its send time, so `t0` never travels and
   * a peer cannot influence our idea of when we spoke.
   */
  openProbe(to: string): { id: number; t0: number } {
    const id = this.nextId++;
    const t0 = localNow();
    this.inflight.set(id, { to, t0 });
    // Unanswered probes would otherwise accumulate for the whole match on a
    // path that is dropping them.
    if (this.inflight.size > 64) {
      const oldest = this.inflight.keys().next();
      if (!oldest.done) this.inflight.delete(oldest.value);
    }
    return { id, t0 };
  }

  /**
   * Corrects a probe's send time to when it actually left.
   *
   * A probe that goes out over the Firestore relay is minted, queued, and only
   * written up to a batch interval later. Left alone, that wait would be
   * measured as time on the wire — the exact mistake the peer-side `t2 - t1`
   * subtraction exists to avoid on the other leg, so it has to be avoided on
   * this one too or the relay's round trip is inflated by both queues.
   */
  restampProbe(id: number, t0: number) {
    const sent = this.inflight.get(id);
    if (sent) sent.t0 = t0;
  }

  /**
   * Closes a probe with the echo's two peer-side timestamps.
   *
   * `from` is checked against who the probe was addressed to. Over the relay
   * every message is visible to the whole room, so without this a third player
   * echoing a probe id would be folded into the wrong peer's clock.
   */
  closeProbe(from: string, id: number, t1: number, t2: number): boolean {
    const sent = this.inflight.get(id);
    if (!sent || sent.to !== from) return false;
    this.inflight.delete(id);
    if (!Number.isFinite(t1) || !Number.isFinite(t2)) return false;
    return this.clockFor(from).add(sent.t0, t1, t2, localNow());
  }

  timingFor(id: string): PeerTiming {
    return this.clocks.get(id)?.timing ?? EMPTY;
  }

  /**
   * How old a packet from `from` is, in seconds, given the sender's own
   * timestamp.
   *
   * This is the number the whole file exists to produce. Once the offset is
   * known it is a subtraction rather than an estimate, and it is right even
   * when the two directions of the path cost wildly different amounts.
   *
   * Before the clock is ready it falls back to half the round trip, which is
   * the old behaviour and the best available guess with nothing measured yet.
   * `cap` bounds the result either way: a packet older than the caller is
   * willing to extrapolate is the caller's business, but a *negative* age
   * means the peer's clock ran ahead of our estimate and must never become
   * negative extrapolation.
   */
  ageOf(from: string, sentAt: number, cap: number): number {
    const t = this.timingFor(from);
    if (!t.ready) return Math.min(t.rtt / 2000, cap);
    if (!Number.isFinite(sentAt)) return Math.min(t.rtt / 2000, cap);
    const age = (localNow() - (sentAt - t.offset)) / 1000;
    if (!Number.isFinite(age)) return 0;
    return Math.max(0, Math.min(age, cap));
  }

  /** Our clock expressed on `to`'s scale, for stamping a packet we send them. */
  stampFor(): number {
    // Deliberately *our* clock, unconverted: every receiver knows its own
    // offset to us and converts on arrival. Converting on the way out would
    // need a different stamp per recipient for a single broadcast packet.
    return localNow();
  }

  /** Drops everything known about peers who are no longer in the room. */
  retain(ids: string[]) {
    const keep = new Set(ids);
    for (const id of [...this.clocks.keys()]) if (!keep.has(id)) this.clocks.delete(id);
    for (const [probe, sent] of this.inflight) if (!keep.has(sent.to)) this.inflight.delete(probe);
  }

  /** The worst round trip anyone is on, for the badge. */
  get worstRtt(): number {
    let worst = 0;
    for (const c of this.clocks.values()) worst = Math.max(worst, c.timing.rtt);
    return worst;
  }

  get measured(): string[] {
    return [...this.clocks.entries()].filter(([, c]) => c.timing.samples > 0).map(([id]) => id);
  }

  private clockFor(id: string): PeerClock {
    let c = this.clocks.get(id);
    if (!c) {
      c = new PeerClock();
      this.clocks.set(id, c);
    }
    return c;
  }
}
