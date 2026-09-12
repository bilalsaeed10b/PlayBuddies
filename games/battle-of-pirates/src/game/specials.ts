/** Meter charge is earned once per damaging cannon attack, never per pellet or burn tick. */
export const SPECIAL_HITS = 3;
export const SPECIALS = {
  // Give the wake time to read across a phone screen instead of snapping from
  // one fleet to the other. Damage still lands exactly when the nose arrives.
  torpedo: { name: 'Torpedo', amount: 25, duration: 4.00, impact: 1.35 },
  'acid-rain': { name: 'Acid Rain', amount: 15, duration: 6, impact: 2.4 },
  heal: { name: 'Heal', amount: 20, duration: 2.2, impact: 0.4 },
} as const;
export type SpecialId = keyof typeof SPECIALS;

export function isSpecial(value: unknown): value is SpecialId {
  return value === 'torpedo' || value === 'acid-rain' || value === 'heal';
}
