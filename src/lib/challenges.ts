import { doc, increment, runTransaction } from "firebase/firestore";
import { db } from "@/lib/firebase";

/**
 * Gems and the daily challenges that pay them.
 *
 * Gems are the platform's premium currency: one balance for the whole
 * account, unlike coins, which are kept per game (see wallet.ts). They are
 * never paid out by a game. The only ways in are real money (not live yet)
 * and these challenges , one per game each day, worth GEMS_PER_CHALLENGE
 * apiece, and no more than DAILY_CHALLENGE_CAP of them completed in a day.
 *
 * The day is the UTC calendar day, because it has to be the same day the
 * database rules compute from `request.time`, and the rules have no idea what
 * timezone anybody is in. So "today" rolls over at 00:00 UTC for everyone.
 *
 * What the rules can hold a client to is the payout, not the play: a claim is
 * two gems, alongside exactly one new entry in today's completed list, and
 * that list never holds more than three. Whether the match behind it really
 * happened is the same question as whether any match on the stats counter
 * really happened (see `statsStep()` in firestore.rules), and on a site with
 * no server it has the same answer. The cap is what bounds it.
 */

export const GEMS_PER_CHALLENGE = 2;
export const DAILY_CHALLENGE_CAP = 3;

/** Per-match numbers a game may report alongside a result. */
export type ChallengeDetail = Record<string, number>;

export interface ChallengeDef {
  /** Stable, so a change of wording never changes which challenge is which. */
  id: string;
  gameId: string;
  title: string;
  /**
   * `wins` and `plays` count matches through the day; `feat` asks for one
   * match that hits `metric` against `target`, and may insist it was a win.
   */
  kind: "wins" | "plays" | "feat";
  /** Matches needed, for `wins` and `plays`. */
  count?: number;
  metric?: string;
  /** Whether the metric must reach the target from above or below. */
  cmp?: "gte" | "lte";
  target?: number;
  needWin?: boolean;
  /**
   * What advances it. Most challenges count finished matches; a game with no
   * winner to report (a life in Players Eat Fish) counts runs instead, and
   * the two are never mixed, or a solo fish match that ends on a death would
   * count twice.
   */
  counts?: "matches" | "runs";
}

/**
 * Each game's pool. One is drawn per game per day (see `todaysChallenges`).
 *
 * The `feat` metrics are each something the game already works out when a
 * match ends and now reports with its result: ships sunk, total moves on the
 * board, strokes against four a hole, the wave reached, the winning margin.
 * Games whose scores run on scales that swing too far with the table size to
 * set one fair target stick to wins and matches played.
 */
const POOLS: Record<string, Omit<ChallengeDef, "gameId">[]> = {
  "battle-of-pirates": [
    { id: "bop-win", title: "Win a sea battle", kind: "wins", count: 1 },
    { id: "bop-sink2", title: "Sink 2 ships in one battle", kind: "feat", metric: "sunk", cmp: "gte", target: 2 },
    { id: "bop-play3", title: "Fight 3 battles", kind: "plays", count: 3 },
  ],
  "players-eat-fish": [
    { id: "fish-runs3", title: "Swim 3 runs", kind: "plays", count: 3, counts: "runs" },
    { id: "fish-runs5", title: "Swim 5 runs", kind: "plays", count: 5, counts: "runs" },
  ],
  "mini-golf": [
    { id: "golf-win", title: "Win a round", kind: "wins", count: 1 },
    { id: "golf-tidy", title: "Finish a round at 4 strokes a hole or better", kind: "feat", metric: "overPar", cmp: "lte", target: 0 },
    { id: "golf-play2", title: "Play 2 rounds", kind: "plays", count: 2 },
  ],
  quoridor: [
    { id: "quor-win", title: "Win a game", kind: "wins", count: 1 },
    { id: "quor-fast", title: "Win in 40 moves or fewer", kind: "feat", metric: "moves", cmp: "lte", target: 40, needWin: true },
    { id: "quor-play2", title: "Play 2 games", kind: "plays", count: 2 },
  ],
  "last-gasp": [
    { id: "gasp-win", title: "Win a match", kind: "wins", count: 1 },
    { id: "gasp-play2", title: "Play 2 matches", kind: "plays", count: 2 },
  ],
  "tower-siege": [
    { id: "siege-win", title: "Survive a siege", kind: "wins", count: 1 },
    { id: "siege-wave8", title: "Reach wave 8", kind: "feat", metric: "wave", cmp: "gte", target: 8 },
    { id: "siege-play2", title: "Play 2 sieges", kind: "plays", count: 2 },
  ],
  "volley-clash": [
    { id: "volley-win", title: "Win a match", kind: "wins", count: 1 },
    { id: "volley-rout", title: "Win by 3 points or more", kind: "feat", metric: "margin", cmp: "gte", target: 3, needWin: true },
    { id: "volley-play2", title: "Play 2 matches", kind: "plays", count: 2 },
  ],
  "wanted-board": [
    { id: "wanted-win", title: "Win a showdown", kind: "wins", count: 1 },
    { id: "wanted-play2", title: "Play 2 showdowns", kind: "plays", count: 2 },
  ],
};

/** Today in UTC as one integer, 20260918. The rules compute the same number. */
export function dayKey(now = new Date()): number {
  return now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
}

/** Milliseconds until the next UTC midnight, for the "resets in" line. */
export function msUntilReset(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next - now.getTime();
}

/** A small, stable mix of a day and a game id, so every client draws the same card. */
function pick(day: number, gameId: string, size: number): number {
  let h = day;
  for (let i = 0; i < gameId.length; i++) h = (Math.imul(h, 31) + gameId.charCodeAt(i)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h ^= h >>> 13;
  return Math.abs(h) % size;
}

/** The challenge a game offers on a given day, or null for a game with no pool. */
export function challengeFor(gameId: string, day = dayKey()): ChallengeDef | null {
  const pool = POOLS[gameId];
  if (!pool || pool.length === 0) return null;
  return { ...pool[pick(day, gameId, pool.length)], gameId };
}

/** Today's card, in the order the games are listed. */
export function todaysChallenges(gameIds: string[], day = dayKey()): ChallengeDef[] {
  return gameIds.map((id) => challengeFor(id, day)).filter((c): c is ChallengeDef => c !== null);
}

/** How far into a challenge a player is, out of `goal`. */
export function goalOf(def: ChallengeDef): number {
  return def.kind === "feat" ? 1 : Math.max(1, def.count ?? 1);
}

/** What this account has done today. Keyed by game id, like everything else here. */
export interface ChallengeState {
  day: number;
  progress: Record<string, number>;
  /** Game ids whose challenge was completed, and paid, today. */
  done: string[];
}

export function emptyState(day = dayKey()): ChallengeState {
  return { day, progress: {}, done: [] };
}

/**
 * Whatever is on the account, as today's state.
 *
 * A record from yesterday is not an error, it is simply over: the day moved
 * on, and a fresh card starts empty.
 */
export function cleanState(raw: unknown, day = dayKey()): ChallengeState {
  if (!raw || typeof raw !== "object") return emptyState(day);
  const r = raw as { day?: unknown; progress?: unknown; done?: unknown };
  if (r.day !== day) return emptyState(day);
  const progress: Record<string, number> = {};
  if (r.progress && typeof r.progress === "object") {
    for (const [id, n] of Object.entries(r.progress as Record<string, unknown>).slice(0, 12)) {
      const v = Number(n);
      if (Number.isFinite(v)) progress[id.slice(0, 48)] = Math.max(0, Math.min(99, Math.round(v)));
    }
  }
  const done = Array.isArray(r.done)
    ? [...new Set(r.done.filter((d): d is string => typeof d === "string"))].slice(0, DAILY_CHALLENGE_CAP)
    : [];
  return { day, progress, done };
}

export interface MatchEvent {
  won: boolean;
  detail: ChallengeDetail;
}

/** Progress after one more match. Pure, so the lobby page and a test agree. */
export function advance(def: ChallengeDef, before: number, event: MatchEvent): number {
  if (def.kind === "wins") return event.won ? before + 1 : before;
  if (def.kind === "plays") return before + 1;
  if (before >= 1) return before;
  if (def.needWin && !event.won) return before;
  const value = def.metric ? event.detail[def.metric] : undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || def.target === undefined) return before;
  const hit = def.cmp === "lte" ? value <= def.target : value >= def.target;
  return hit ? 1 : before;
}

/**
 * Only small, flat, numeric detail is kept. It arrives from a game over
 * postMessage, which is to say from code that anybody can edit.
 */
export function cleanDetail(raw: unknown): ChallengeDetail {
  if (!raw || typeof raw !== "object") return {};
  const out: ChallengeDetail = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 8)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k.slice(0, 24)] = v;
  }
  return out;
}

/**
 * Fold one finished match into today's challenge for its game, and pay out
 * if that finishes it.
 *
 * A transaction, because two tabs finishing a match at the same moment would
 * otherwise both read "one away", both complete it, and the second write
 * would be refused by the rules as a second payout for the same entry , or
 * worse, both land against a list the other had not seen.
 *
 * Resolves to the challenge when this match completed it, and null otherwise.
 */
export async function recordChallengeEvent(
  uid: string,
  gameId: string,
  event: MatchEvent,
  source: "match" | "run" = "match",
): Promise<ChallengeDef | null> {
  const day = dayKey();
  const def = challengeFor(gameId, day);
  if (!def) return null;
  if ((def.counts === "runs") !== (source === "run")) return null;
  const ref = doc(db, "users", uid);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return null;
    const state = cleanState(snap.data().challenges, day);
    if (state.done.includes(gameId)) return null;

    const before = state.progress[gameId] ?? 0;
    const after = advance(def, before, event);
    if (after === before) return null;

    const progress = { ...state.progress, [gameId]: after };
    const finished = after >= goalOf(def) && state.done.length < DAILY_CHALLENGE_CAP;
    const done = finished ? [...state.done, gameId] : state.done;

    tx.update(ref, {
      challenges: { day, progress, done },
      ...(finished ? { gems: increment(GEMS_PER_CHALLENGE) } : {}),
    });
    return finished ? def : null;
  });
}

/** Whatever is stored, as a balance. */
export function cleanGems(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}
