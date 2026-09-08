/**
 * The outlaws: eight faces for the wanted posters, three free.
 *
 * They are skins and nothing else. Not one of them rides further, banks
 * faster or takes less off an ambush, and none ever will — this is a game
 * played against other people, and a shop that sells an advantage in one is
 * worse than no shop at all. Every other game on the platform holds the same
 * line; see the note at the top of Battle of Pirates' ships.ts.
 *
 * Drawn as a few SVG primitives rather than shipped as art. At the size these
 * actually appear — a token on a map and a thumbnail in a shop — a silhouette
 * with a distinct hat reads better than a detailed portrait, and it costs the
 * bundle nothing.
 */

export type HatShape = 'stetson' | 'bowler' | 'flat' | 'hood' | 'feather' | 'bandana' | 'top' | 'none';

export interface Outlaw {
  name: string;
  /** What the wanted poster says about them. */
  blurb: string;
  price: number;
  /** Coat, the largest block of colour on the token. */
  coat: string;
  /** Hat and boots. */
  trim: string;
  /** The scarf over the face, and the one bright accent. */
  scarf: string;
  hat: HatShape;
}

export const OUTLAWS: Outlaw[] = [
  {
    name: 'Dust Kelly', blurb: 'Rode in on nothing and intends to leave on more.', price: 0,
    coat: '#8b5a2b', trim: '#e0c9a6', scarf: '#e0453c', hat: 'stetson',
  },
  {
    name: 'Quiet Mae', blurb: 'Never raises her voice. Never has to.', price: 0,
    coat: '#2f6f6a', trim: '#cfe9e4', scarf: '#f4a259', hat: 'bandana',
  },
  {
    name: 'Old Cobb', blurb: 'Been caught nine times. Still here.', price: 0,
    coat: '#5b6462', trim: '#c8cfcd', scarf: '#94a3b8', hat: 'flat',
  },
  {
    name: 'The Preacher', blurb: 'Quotes scripture while going through your pockets.', price: 300,
    coat: '#1f2937', trim: '#e5e7eb', scarf: '#a78bfa', hat: 'top',
  },
  {
    name: 'Ruby Vane', blurb: 'Has never once been where you expected her.', price: 450,
    coat: '#9f1239', trim: '#fecdd3', scarf: '#fbbf24', hat: 'feather',
  },
  {
    name: 'Copper Jack', blurb: 'Was a lawman on Tuesday. It is Wednesday.', price: 650,
    coat: '#b45309', trim: '#fde68a', scarf: '#0ea5e9', hat: 'bowler',
  },
  {
    name: 'Nightjar', blurb: 'Nobody has described the face. Several have tried.', price: 900,
    coat: '#312e81', trim: '#c7d2fe', scarf: '#22d3ee', hat: 'hood',
  },
  {
    name: 'The Ledger', blurb: 'Keeps a list. You are on it.', price: 1200,
    coat: '#064e3b', trim: '#a7f3d0', scarf: '#34d399', hat: 'top',
  },
];

export const FREE_OUTLAWS = OUTLAWS.reduce<number[]>((free, o, i) => {
  if (o.price === 0) free.push(i);
  return free;
}, []);

export function outlawAt(index: number): Outlaw {
  return OUTLAWS[Math.max(0, Math.min(OUTLAWS.length - 1, index))] ?? OUTLAWS[0];
}

/**
 * The hat, as an SVG path in a 24x24 box whose head sits at (12, 13) r 5.5.
 *
 * Split out from the token component so the shop and the map draw the exact
 * same silhouette — the whole point of a skin is being recognisable, and two
 * near-copies of this drifting apart is the standard way that stops being true.
 */
export function hatPath(hat: HatShape): string | null {
  switch (hat) {
    case 'stetson':
      return 'M3.5 8.2 Q12 10.4 20.5 8.2 Q19 7.6 17 7.3 Q16.4 3.4 12 3.4 Q7.6 3.4 7 7.3 Q5 7.6 3.5 8.2 Z';
    case 'bowler':
      return 'M5 8.4 Q12 9.8 19 8.4 Q18 7.9 16.6 7.6 Q16.6 4.2 12 4.2 Q7.4 4.2 7.4 7.6 Q6 7.9 5 8.4 Z';
    case 'flat':
      return 'M4.6 8.3 L19.4 8.3 L18 7.5 Q17.4 5.2 12 5.2 Q6.6 5.2 6 7.5 Z';
    case 'hood':
      return 'M5.6 9.6 Q5.2 2.6 12 2.6 Q18.8 2.6 18.4 9.6 Q15.6 6.6 12 6.6 Q8.4 6.6 5.6 9.6 Z';
    case 'feather':
      return 'M4.4 8.3 Q12 10.2 19.6 8.3 Q18.2 7.6 16.4 7.3 Q15.8 3.6 12 3.6 Q8.2 3.6 7.6 7.3 Q5.8 7.6 4.4 8.3 Z M16 7 Q20 3.4 21.6 5.2 Q19.6 6.6 17.4 7.6 Z';
    case 'bandana':
      return 'M6 8 Q12 5.4 18 8 Q17.4 5 12 4.6 Q6.6 5 6 8 Z';
    case 'top':
      return 'M4.8 8.6 L19.2 8.6 L17.6 7.8 L17.6 1.8 L6.4 1.8 L6.4 7.8 Z';
    default:
      return null;
  }
}
