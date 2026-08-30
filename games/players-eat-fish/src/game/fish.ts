/**
 * The fish catalogue: one entry per sprite, ordered smallest to largest.
 *
 * `size` is the collision radius the fish is worth, and it doubles as the
 * unlock ladder — index order, size order and price order are deliberately the
 * same, so "the next one along" always means "a bit bigger".
 *
 * Art is served from public/asset/fishes/. The originals were 800×800 PNGs
 * totalling 11.6 MB, which is more than the entire rest of the site; they are
 * now 384px WebP and the whole set is 0.6 MB.
 */

export interface FishAsset {
  name: string;
  file: string;
  size: number;
  price: number;
  category: FishCategory;
}

export type FishCategory = 'Tiny' | 'Small' | 'Medium' | 'Large' | 'Giant' | 'Boss';

export const FISH_CATEGORIES: FishCategory[] = ['Tiny', 'Small', 'Medium', 'Large', 'Giant'];

export const FISH_ASSETS: FishAsset[] = [
  { name: 'Neon Tetra', file: 'neon-tetra.webp', size: 6, price: 0, category: 'Tiny' },
  { name: 'Guppy', file: 'guppy.webp', size: 8, price: 0, category: 'Tiny' },
  { name: 'Zebra Danio', file: 'zebra-danio.webp', size: 10, price: 0, category: 'Tiny' },
  { name: 'Angular Fish', file: 'angular-fish.webp', size: 12, price: 120, category: 'Tiny' },
  { name: 'Damselfish', file: 'damselfish.webp', size: 15, price: 180, category: 'Small' },
  { name: 'Platy Fish', file: 'platy-fish.webp', size: 18, price: 240, category: 'Small' },
  { name: 'Tiger Barb', file: 'tiger-barb.webp', size: 21, price: 300, category: 'Small' },
  { name: 'Panda Betta', file: 'white-and-black-betta.webp', size: 24, price: 380, category: 'Small' },
  { name: 'White Tetra', file: 'white-tetra.webp', size: 27, price: 460, category: 'Small' },
  { name: 'Betta Fish', file: 'betta-fish.webp', size: 30, price: 560, category: 'Small' },
  { name: 'Clownfish', file: 'clownfish.webp', size: 34, price: 700, category: 'Medium' },
  { name: 'Gourami', file: 'gourami.webp', size: 38, price: 850, category: 'Medium' },
  { name: 'Molly Fish', file: 'molly-fish.webp', size: 42, price: 1000, category: 'Medium' },
  { name: 'Swordtail', file: 'swordtail-fish.webp', size: 46, price: 1200, category: 'Medium' },
  { name: 'Butterflyfish', file: 'butterflyfish.webp', size: 50, price: 1400, category: 'Medium' },
  { name: 'Angelfish', file: 'angelfish.webp', size: 55, price: 1650, category: 'Medium' },
  { name: 'Discus', file: 'discus-fish.webp', size: 60, price: 1900, category: 'Medium' },
  { name: 'Goldfish', file: 'goldfish.webp', size: 65, price: 2200, category: 'Medium' },
  { name: 'Surgeonfish', file: 'surgeonfish.webp', size: 70, price: 2600, category: 'Large' },
  { name: 'Yellow Tang', file: 'yellow-tang.webp', size: 75, price: 3000, category: 'Large' },
  { name: 'Catfish', file: 'catfish.webp', size: 82, price: 3600, category: 'Large' },
  { name: 'Blue Tang', file: 'blue-tang.webp', size: 89, price: 4200, category: 'Large' },
  { name: 'Lionfish', file: 'lionfish.webp', size: 96, price: 5000, category: 'Large' },
  { name: 'Mackerel', file: 'mackerel.webp', size: 104, price: 6000, category: 'Large' },
  { name: 'Snapper', file: 'snapper.webp', size: 112, price: 7200, category: 'Giant' },
  { name: 'Tuna', file: 'tuna.webp', size: 120, price: 8600, category: 'Giant' },
  { name: 'Koi', file: 'koi-fish.webp', size: 128, price: 10000, category: 'Giant' },
  { name: 'Sea Turtle', file: 'sea-turtle.webp', size: 136, price: 12000, category: 'Giant' },
  { name: 'Swordfish', file: 'sword-fish.webp', size: 144, price: 15000, category: 'Giant' },
  { name: 'Tiger Shark', file: 'tiger-shark.webp', size: 155, price: 20000, category: 'Giant' },
  { name: 'Zombie Shark', file: 'zombie-shark.webp', size: 190, price: 0, category: 'Boss' },
];

export const BOSS_ASSET = FISH_ASSETS.length - 1;

/** Fish available without spending anything. */
export const STARTER_FISH = [0, 1, 2];

/**
 * Every player's real starting size, no matter which fish they picked.
 *
 * `FISH_ASSETS[i].size` still orders the catalogue and decides what a fish
 * looks like once it's grown into that size on its own, but coins buy a
 * look, not a head start — a Tiger Shark skin should not spawn already
 * bigger than everyone who couldn't afford one. Every player enters the
 * water at the same size and grows from there purely by eating.
 */
export const STARTING_SIZE = 10;

/**
 * Sprite for an AI fish of a given size.
 *
 * Only used when spawning. A *player* keeps the fish they chose for the whole
 * run and simply gets bigger — swapping their sprite as their score climbed
 * meant you stopped being the fish you picked, which nobody asked for.
 */
export function assetForSize(size: number): number {
  for (let i = FISH_ASSETS.length - 2; i >= 0; i--) {
    if (size >= FISH_ASSETS[i].size) return i;
  }
  return 0;
}

/**
 * Biggest fish that will ever travel in a group. Above this they swim alone —
 * a shark drifting in the middle of a school of neon tetras looked ridiculous.
 */
export const SHOAL_MAX_SIZE = 40;

export function isShoalingSize(size: number): boolean {
  return size <= SHOAL_MAX_SIZE;
}

/** Path a browser can load, relative to the bundle so any deploy prefix works. */
export function fishSrc(assetIndex: number): string {
  return `${import.meta.env.BASE_URL}asset/fishes/${FISH_ASSETS[assetIndex].file}`;
}
