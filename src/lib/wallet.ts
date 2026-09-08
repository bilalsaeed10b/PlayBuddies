import { doc, getDoc, increment, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

/**
 * Coins, unlocks and match counters, kept on the account rather than in the
 * browser.
 *
 * All three used to live in localStorage inside each game, which is why a
 * player who signed in on a second device, or simply cleared their browser,
 * found an empty purse and a dashboard reading zero. localStorage is keyed by
 * origin and knows nothing about who is signed in, so it could never be the
 * home for anything that belongs to a person.
 *
 * The games still cannot reach any of this themselves. They are sandboxed in
 * an iframe and talk to the lobby page over postMessage; the lobby page is the
 * only thing that writes.
 */
export interface Wallet {
  /**
   * Coins, per game — what mini-golf pays out cannot be spent in Quoridor.
   * Same shape as `unlocks`, and for the same reason: a purse earned in one
   * game buying something in another was never a purse, it was one shared
   * account-wide currency wearing six different games' skins.
   */
  coins: Record<string, number>;
  /** Cosmetic items bought per game, e.g. { "battle-of-pirates": [0, 3] }. */
  unlocks: Record<string, number[]>;
}

export const EMPTY_WALLET: Wallet = { coins: {}, unlocks: {} };

/** Guards against a game posting something malformed into a database write. */
function cleanUnlocks(raw: unknown): Record<string, number[]> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number[]> = {};
  for (const [gameId, list] of Object.entries(raw as Record<string, unknown>).slice(0, 12)) {
    if (!Array.isArray(list)) continue;
    const ids = [...new Set(list.filter((n) => Number.isInteger(n) && n >= 0 && n < 200))].slice(0, 60);
    out[gameId.slice(0, 48)] = ids as number[];
  }
  return out;
}

/**
 * Same shape of guard as `cleanUnlocks`, one game's balance at a time.
 *
 * A wallet written before coins were split per game has a bare number here
 * instead of a map — `typeof raw !== "object"` catches that and the account
 * comes back with an empty purse in every game rather than a crash. That is
 * deliberate: coins earned under one shared balance do not have a single
 * honest game to land in, so the split starts everyone at zero rather than
 * guessing.
 */
function cleanCoins(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [gameId, value] of Object.entries(raw as Record<string, unknown>).slice(0, 12)) {
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    out[gameId.slice(0, 48)] = Math.max(0, Math.min(10_000_000, Math.round(n)));
  }
  return out;
}

export function cleanWallet(raw: { coins?: unknown; unlocks?: unknown }): Wallet {
  return {
    coins: cleanCoins(raw.coins),
    unlocks: cleanUnlocks(raw.unlocks),
  };
}

export async function readWallet(uid: string): Promise<Wallet> {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return EMPTY_WALLET;
  return cleanWallet(snap.data() as { coins?: unknown; unlocks?: unknown });
}

export async function writeWallet(uid: string, wallet: Wallet): Promise<void> {
  await updateDoc(doc(db, "users", uid), {
    coins: wallet.coins,
    unlocks: wallet.unlocks,
  });
}

/**
 * One finished match.
 *
 * Written with increment() rather than a read followed by a write, so two
 * games finishing at once cannot each read the same total and overwrite one
 * another. The rules only accept a step of exactly one game and at most one
 * win, which is what an increment of this shape produces.
 */
export async function recordMatch(uid: string, won: boolean): Promise<void> {
  await updateDoc(doc(db, "users", uid), {
    "stats.gamesPlayed": increment(1),
    "stats.wins": increment(won ? 1 : 0),
  });
}
