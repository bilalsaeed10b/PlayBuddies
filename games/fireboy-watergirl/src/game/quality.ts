/**
 * How hard this device is allowed to work.
 *
 * A cheap Android phone and a desktop both have to run this at a playable
 * rate, and the gap between them is far wider than any single "is mobile"
 * check can express. So the tier is guessed once from what the device admits
 * to, and then corrected by the only evidence that actually matters: how long
 * frames are really taking.
 *
 * The canvas here is a fixed 800x600 that CSS scales, so unlike the other
 * games there is no backing-store lever to pull. What costs money in this one
 * is `shadowBlur` — canvas 2D's most expensive feature, a separate blur pass
 * per fill — and the particle count. Those are the two things a tier moves.
 *
 * This mirrors games/battle-of-pirates/src/game/quality.ts. The two are kept
 * as separate files on purpose: the games are independently built bundles with
 * no shared package between them, and the levers each one exposes differ.
 */

export type Tier = 0 | 1 | 2;

export interface Quality {
  tier: Tier;
  /** Multiplier on every particle burst. */
  particles: number;
  /** Glow and drop shadows. Every one of these is a blur pass. */
  fancy: boolean;
}

const TIERS: Record<Tier, Quality> = {
  0: { tier: 0, particles: 0.3, fancy: false },
  1: { tier: 1, particles: 0.65, fancy: false },
  2: { tier: 2, particles: 1, fancy: true },
};

interface DeviceHints {
  deviceMemory?: number;
  hardwareConcurrency?: number;
}

/**
 * First guess, before a single frame has been drawn.
 *
 * `deviceMemory` and `hardwareConcurrency` are both absent or lied about often
 * enough that neither is trusted alone. They only set the starting tier; the
 * governor below has the final say within a second of play.
 */
export function detectTier(): Tier {
  if (typeof navigator === 'undefined') return 1;
  const nav = navigator as Navigator & DeviceHints;
  const mem = nav.deviceMemory ?? 0;
  const cores = nav.hardwareConcurrency ?? 0;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  if (mem > 0 && mem <= 3) return 0;
  if (cores > 0 && cores <= 4 && coarse) return 0;
  if (coarse) return 1;
  if (cores > 0 && cores <= 4) return 1;
  return 2;
}

/**
 * Watches the frame clock and moves the tier to match reality.
 *
 * Downgrades are quick and upgrades are slow and capped, because a device that
 * oscillates between two tiers looks far worse than one that simply stays on
 * the cheap path. The ceiling never rises above where it started: a phone that
 * happens to have one quiet second is still a phone.
 */
export class QualityGovernor {
  private ceiling: Tier;
  private current: Tier;
  private slowFrames = 0;
  private fastFrames = 0;
  private upgrades = 0;

  constructor(forceLow: boolean) {
    const start = forceLow ? 0 : detectTier();
    this.ceiling = start;
    this.current = start;
  }

  get quality(): Quality {
    return TIERS[this.current];
  }

  /** Called once a frame with the real elapsed time, in seconds. */
  sample(seconds: number) {
    // Anything past a quarter second is a tab that was backgrounded, not a
    // slow frame, and counting it would demote a perfectly good machine.
    if (seconds > 0.25) return;

    if (seconds > 0.026) {
      this.slowFrames++;
      this.fastFrames = 0;
    } else if (seconds < 0.019) {
      this.fastFrames++;
      this.slowFrames = 0;
    }

    if (this.slowFrames > 45 && this.current > 0) {
      this.current = (this.current - 1) as Tier;
      this.slowFrames = 0;
    } else if (this.fastFrames > 600 && this.current < this.ceiling && this.upgrades < 2) {
      this.current = (this.current + 1) as Tier;
      this.upgrades++;
      this.fastFrames = 0;
    }
  }
}
