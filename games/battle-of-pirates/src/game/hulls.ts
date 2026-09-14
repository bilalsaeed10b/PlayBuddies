/**
 * Free battle roles. Skins stay cosmetic; a captain chooses a role separately
 * before a match, so no shop purchase ever buys an advantage.
 */
export interface HullClass {
  id: string;
  name: string;
  blurb: string;
  cost: string;
  /** Short, readable facts for the lobby cards. */
  perks: string[];
  /** Multipliers on the battle's base values. */
  hp: number;
  width: number;
  drift: number;
  blast: number;
  damage: number;
  /** Chance that a direct cannon impact is critical, and its damage multiplier. */
  critChance: number;
  critDamage: number;
  /** Extra dots in this captain's own aiming guide. */
  aimDots: number;
  /** Optional custom visual meter dots (1-5). Auto-calculated from balance stats if omitted. */
  hpDots?: number;
  damageDots?: number;
  critDots?: number;
  aimGuideDots?: number;
}

export interface HullStatDots {
  hpDots: number;
  damageDots: number;
  critDots: number;
  aimGuideDots: number;
}

/**
 * Computes visual meter dots (1 - 5) for a hull class.
 * Uses explicit dot overrides if configured; otherwise auto-adjusts based on stat values.
 */
export function getHullStatDots(hull: HullClass): HullStatDots {
  // HP / Hull (1-5)
  let hp = hull.hpDots;
  if (hp === undefined || hp === null || hp <= 0) {
    if (hull.hp <= 0.82) hp = 1;
    else if (hull.hp <= 0.90) hp = 2; // e.g. Shooter (0.85) -> 2 dots
    else if (hull.hp <= 1.05) hp = 3; // e.g. Baseline (1.0), Critical (0.94) -> 3 dots
    else if (hull.hp <= 1.22) hp = 4;
    else hp = 5;                      // e.g. Tank (1.35) -> 5 dots
  }

  // Damage / Guns (1-5)
  let damage = hull.damageDots;
  if (damage === undefined || damage === null || damage <= 0) {
    if (hull.damage <= 0.78) damage = 2; // e.g. Tank (0.75) -> 2 dots
    else if (hull.damage <= 1.05) damage = 3; // e.g. Critical (0.85), Aimer (0.90), Balanced (1.0) -> 3 dots
    else if (hull.damage <= 1.15) damage = 4;
    else damage = 5;                          // e.g. Shooter (1.18) -> 5 dots
  }

  // Critical chance (1-5)
  let crit = hull.critDots;
  if (crit === undefined || crit === null || crit <= 0) {
    if (hull.critChance <= 0.02) crit = 1;     // e.g. Shooter (0), Tank (0) -> 1 dot
    else if (hull.critChance <= 0.12) crit = 2; // e.g. Balanced (0.08) -> 2 dots
    else if (hull.critChance <= 0.20) crit = 3;
    else if (hull.critChance <= 0.28) crit = 4;
    else crit = 5;                              // e.g. Critical (0.30) -> 5 dots
  }

  // Aim guide dots (1-5)
  let aim = hull.aimGuideDots;
  if (aim === undefined || aim === null || aim <= 0) {
    if (hull.aimDots <= 0) aim = 1;      // e.g. Tank (0), Critical (0) -> 1 dot
    else if (hull.aimDots === 1) aim = 2; // e.g. Balanced (1) -> 2 dots
    else if (hull.aimDots === 2) aim = 3; // e.g. Shooter (2) -> 3 dots
    else if (hull.aimDots === 3) aim = 4;
    else aim = 5;                         // e.g. Aimer (4) -> 5 dots
  }

  return {
    hpDots: Math.max(1, Math.min(5, Math.round(hp))),
    damageDots: Math.max(1, Math.min(5, Math.round(damage))),
    critDots: Math.max(1, Math.min(5, Math.round(crit))),
    aimGuideDots: Math.max(1, Math.min(5, Math.round(aim))),
  };
}

export const HULLS: HullClass[] = [
  {
    id: "balanced",
    name: "Balanced",
    blurb: "A reliable all-rounder with no weak hull, gun or targeting stat to exploit.",
    cost: "No extreme specialty",
    perks: ["Even hull and cannon strength", "Steady blast and handling"],
    hp: 1, width: 1, drift: 1, blast: 1, damage: 1,
    critChance: 0, critDamage: 1, aimDots: 1,
  },
  {
    id: "shooter",
    name: "Shooter",
    blurb: "A glass cannon built to land harder hits before the enemy can return fire.",
    cost: "Less armour",
    perks: ["+18% cannon damage", "92% hull strength"],
    hp: 0.85, width: 0.97, drift: 1.08, blast: 0.95, damage: 1.18,
    critChance: 0, critDamage: 1, aimDots: 2,
  },
  {
    id: "tank",
    name: "Tank",
    blurb: "Heavy armour and a broad silhouette. It survives the exchange, then wins it slowly.",
    cost: "Softer guns and a larger target",
    perks: ["+35% hull strength", "78% cannon damage"],
    hp: 1.35, width: 1.18, drift: 0.58, blast: 0.92, damage: 0.75,
    critChance: 0, critDamage: 1, aimDots: 0,
  },
  {
    id: "critical",
    name: "Critical",
    blurb: "A daring duellist whose direct hits can tear through a hull in one devastating strike.",
    cost: "Light protection",
    perks: ["32% critical-hit chance", "Criticals deal 1.7× damage"],
    hp: 0.94, width: 1.02, drift: 1.02, blast: 1, damage: 0.85,
    critChance: 0.3, critDamage: 1.7, aimDots: 0,
  },
  {
    id: "aimer",
    name: "Aimer",
    blurb: "A surveyor’s ship with a longer trajectory guide for carefully placed cannon shots.",
    cost: "Average guns, no lucky criticals",
    perks: ["+4 aiming-guide points", "Precise", "balanced hull"],
    hp: 1, width: 0.9, drift: 0.94, blast: 0.95, damage: 0.9,
    critChance: 0, critDamage: 1, aimDots: 4,
  },
];

/** The default baseline battle role (Balanced). */
export const DEFAULT_HULL_INDEX = 0;

/** Never out of range, whatever a stale save or a peer claims. */
export function hullAt(index: number | null | undefined): HullClass {
  if (typeof index !== 'number' || !Number.isInteger(index)) return HULLS[DEFAULT_HULL_INDEX] ?? HULLS[0];
  return HULLS[index] ?? HULLS[DEFAULT_HULL_INDEX] ?? HULLS[0];
}
