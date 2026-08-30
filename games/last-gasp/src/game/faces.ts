/**
 * The faces: eight chalk heads for the board, three free.
 *
 * They are skins and nothing else. Not one of them guesses better, scores
 * more or takes fewer lines, and none ever will — this is a game played
 * against other people, and a shop that sells an advantage in one is worse
 * than no shop at all. Every other game on the platform holds the same line.
 *
 * Drawn as a few SVG primitives rather than shipped as art. At the size these
 * actually appear — a 26px chip in a roster and a thumbnail in a shop — a
 * silhouette with a distinct expression reads better than a portrait, and it
 * costs the bundle nothing.
 */

export type Brow = 'none' | 'flat' | 'raised' | 'angry' | 'worried';
export type Mouth = 'line' | 'smile' | 'frown' | 'open' | 'smirk' | 'grit';
export type Extra = 'none' | 'hat' | 'cap' | 'hair' | 'bow' | 'shades';

export interface Face {
  name: string;
  /** What the poster says about them. */
  blurb: string;
  price: number;
  /** The chalk colour of the head outline. */
  ink: string;
  brow: Brow;
  mouth: Mouth;
  extra: Extra;
}

export const FACES: Face[] = [
  { name: 'Chalk', blurb: 'Drawn in a hurry. Regrets nothing.', price: 0, ink: '#f8fafc', brow: 'flat', mouth: 'line', extra: 'none' },
  { name: 'Grin', blurb: 'Has not read the rules and is winning anyway.', price: 0, ink: '#a3e635', brow: 'raised', mouth: 'smile', extra: 'none' },
  { name: 'Doom', blurb: 'Saw this coming. Said nothing.', price: 0, ink: '#fb7185', brow: 'worried', mouth: 'frown', extra: 'none' },
  { name: 'Squint', blurb: 'Counting the letters. Twice.', price: 250, ink: '#38bdf8', brow: 'angry', mouth: 'grit', extra: 'none' },
  { name: 'Topper', blurb: 'Dressed for a funeral. Possibly yours.', price: 400, ink: '#e2e8f0', brow: 'flat', mouth: 'smirk', extra: 'hat' },
  { name: 'Rookie', blurb: 'Guessed Q on the first turn. On purpose.', price: 600, ink: '#fbbf24', brow: 'raised', mouth: 'open', extra: 'cap' },
  { name: 'Mop', blurb: 'Knows a word you have never heard of.', price: 850, ink: '#c084fc', brow: 'flat', mouth: 'smirk', extra: 'hair' },
  { name: 'Cool', blurb: 'Has not blinked since round one.', price: 1200, ink: '#2dd4bf', brow: 'none', mouth: 'line', extra: 'shades' },
];

export const FREE_FACES = FACES.reduce<number[]>((free, f, i) => {
  if (f.price === 0) free.push(i);
  return free;
}, []);

export function faceAt(index: number): Face {
  return FACES[Math.max(0, Math.min(FACES.length - 1, index))] ?? FACES[0];
}

/**
 * The strokes for one face, in a 24x24 box whose head is a circle at (12, 12)
 * radius 8.5.
 *
 * Split out from the component so the roster and the shop draw the exact same
 * head — the whole point of a skin is being recognisable, and two near-copies
 * of this drifting apart is the standard way that stops being true.
 */
export function browPath(brow: Brow): string | null {
  switch (brow) {
    case 'flat':
      return 'M 7.6 9.4 L 10.2 9.4 M 13.8 9.4 L 16.4 9.4';
    case 'raised':
      return 'M 7.6 9.2 Q 8.9 8 10.2 9.2 M 13.8 9.2 Q 15.1 8 16.4 9.2';
    case 'angry':
      return 'M 7.6 8.8 L 10.2 10 M 16.4 8.8 L 13.8 10';
    case 'worried':
      return 'M 7.6 10 L 10.2 8.8 M 16.4 10 L 13.8 8.8';
    default:
      return null;
  }
}

export function mouthPath(mouth: Mouth): string {
  switch (mouth) {
    case 'smile':
      return 'M 8.4 15 Q 12 18.2 15.6 15';
    case 'frown':
      return 'M 8.4 17 Q 12 13.8 15.6 17';
    case 'open':
      return 'M 9.4 15 Q 12 18.6 14.6 15 Q 12 14.2 9.4 15 Z';
    case 'smirk':
      return 'M 8.8 15.6 Q 12 17.6 15.4 14.8';
    case 'grit':
      return 'M 8.6 15.6 L 15.4 15.6 M 10.3 15.6 L 10.3 17.2 M 12 15.6 L 12 17.2 M 13.7 15.6 L 13.7 17.2';
    default:
      return 'M 8.8 15.8 L 15.2 15.8';
  }
}

export function extraPath(extra: Extra): string | null {
  switch (extra) {
    case 'hat':
      return 'M 5.6 5.4 L 18.4 5.4 M 7.6 5.4 L 7.6 0.8 L 16.4 0.8 L 16.4 5.4';
    case 'cap':
      return 'M 4.4 6.2 Q 12 1.4 19.6 6.2 M 19.6 6.2 L 22.4 7.4';
    case 'hair':
      return 'M 4.6 8 Q 5.4 1.6 12 1.6 Q 18.6 1.6 19.4 8 M 8 2.6 L 7 7.4 M 12 1.6 L 12 6.8 M 16 2.6 L 17 7.4';
    case 'bow':
      return 'M 12 3.4 L 8.6 1.2 L 8.6 5.6 Z M 12 3.4 L 15.4 1.2 L 15.4 5.6 Z';
    case 'shades':
      return 'M 6.4 10.6 L 17.6 10.6 M 7 10.6 L 7 13 L 10.8 13 L 10.8 10.6 M 13.2 10.6 L 13.2 13 L 17 13 L 17 10.6';
    default:
      return null;
  }
}
