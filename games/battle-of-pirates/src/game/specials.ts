/** Meter charge is earned once per damaging cannon attack, never per pellet or burn tick. */
export const SPECIAL_HITS = 3;
export const SPECIALS = {
  torpedo: { name: 'Torpedo', amount: 25, duration: 1.8, impact: 0.9 },
  'acid-rain': { name: 'Acid Rain', amount: 10, duration: 6, impact: 2.4 },
  heal: { name: 'Heal', amount: 25, duration: 2.2, impact: 0.4 },
} as const;
export type SpecialId = keyof typeof SPECIALS;

export function isSpecial(value: unknown): value is SpecialId {
  return value === 'torpedo' || value === 'acid-rain' || value === 'heal';
}
