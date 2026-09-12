/**
 * Free battle roles. Skins stay cosmetic; a captain chooses a role separately
 * before a match, so no shop purchase ever buys an advantage.
 */
export interface HullClass {
  id: 'shooter' | 'tank' | 'critical' | 'aimer' | 'balanced';
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
}

export const HULLS: HullClass[] = [
  {
    id: 'shooter',
    name: 'Shooter',
    blurb: 'A glass cannon built to land harder hits before the enemy can return fire.',
    cost: 'Less armour',
    perks: ['+18% cannon damage', '92% hull strength'],
    hp: 0.92, width: 0.97, drift: 1.08, blast: 0.95, damage: 1.18,
    critChance: 0, critDamage: 1, aimDots: 0,
  },
  {
    id: 'tank',
    name: 'Tank',
    blurb: 'Heavy armour and a broad silhouette. It survives the exchange, then wins it slowly.',
    cost: 'Softer guns and a larger target',
    perks: ['+35% hull strength', '78% cannon damage'],
    hp: 1.35, width: 1.18, drift: 0.58, blast: 0.92, damage: 0.78,
    critChance: 0, critDamage: 1, aimDots: 0,
  },
  {
    id: 'critical',
    name: 'Critical',
    blurb: 'A daring duellist whose direct hits can tear through a hull in one devastating strike.',
    cost: 'Light protection',
    perks: ['32% critical-hit chance', 'Criticals deal 1.7× damage'],
    hp: 0.94, width: 1.02, drift: 1.02, blast: 1, damage: 0.96,
    critChance: 0.32, critDamage: 1.7, aimDots: 0,
  },
  {
    id: 'aimer',
    name: 'Aimer',
    blurb: 'A surveyor’s ship with a longer trajectory guide for carefully placed cannon shots.',
    cost: 'Average guns, no lucky criticals',
    perks: ['+4 aiming-guide points', 'Precise, balanced hull'],
    hp: 1, width: 0.98, drift: 0.94, blast: 0.95, damage: 0.95,
    critChance: 0, critDamage: 1, aimDots: 4,
  },
  {
    id: 'balanced',
    name: 'Balanced',
    blurb: 'A reliable all-rounder with no weak hull, gun or targeting stat to exploit.',
    cost: 'No extreme specialty',
    perks: ['Even hull and cannon strength', 'Steady blast and handling'],
    hp: 1, width: 1, drift: 1, blast: 1, damage: 1,
    critChance: 0.08, critDamage: 1.25, aimDots: 1,
  },
];

/** Never out of range, whatever a stale save or a peer claims. */
export function hullAt(index: number | null | undefined): HullClass {
  if (typeof index !== 'number' || !Number.isInteger(index)) return HULLS[0];
  return HULLS[index] ?? HULLS[0];
}
