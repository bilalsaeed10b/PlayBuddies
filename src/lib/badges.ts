/**
 * The badge catalog, shared by the profile page, the admin panel and the chip
 * that renders beside a player's name.
 *
 * Badges come from three different places and it matters which, because each
 * carries a different amount of trust:
 *
 *   * `stat` badges are derived from the counters on the user document. A
 *     determined player can inflate those one forged match at a time (see the
 *     note on `statsStep()` in firestore.rules) , they are a progress display,
 *     not a credential.
 *   * `grant` badges are written to `users/{uid}.grants` and only an admin may
 *     write there. Premium and the tester tiers live here, so a player cannot
 *     award themselves one.
 *   * `bug` badges are grant badges with an automatic trigger: the admin panel
 *     flips the grant once the approved-report count crosses the threshold.
 *
 * Icons are stored as names rather than React nodes so this file stays a plain
 * module that the admin panel, a script or a test can import without pulling
 * in the icon set.
 */

export type BadgeIconName =
  | "gamepad"
  | "star"
  | "target"
  | "shield"
  | "zap"
  | "trophy"
  | "crown"
  | "sparkles"
  | "bug"
  | "bug-plus"
  | "coins";

export type BadgeSource = "stat" | "grant" | "bug";

export interface BadgeDef {
  id: string;
  label: string;
  description: string;
  icon: BadgeIconName;
  /** Tailwind gradient stops, e.g. "from-violet-500 to-purple-600". */
  color: string;
  source: BadgeSource;
  /** Matches played, for `stat` badges. */
  gamesNeeded?: number;
  /** Matches won, for `stat` badges. */
  winsNeeded?: number;
  /** Approved bug reports, for `bug` badges. */
  bugsNeeded?: number;
  /** Key inside `users/{uid}.grants` for `grant` and `bug` badges. */
  grantKey?: GrantKey;
  /** Higher wins when picking the one badge shown beside a name. */
  rank: number;
}

export type GrantKey = "premium" | "tester" | "testerPlus";

/** Approved reports needed for each tester tier. */
export const TESTER_THRESHOLD = 10;
export const TESTER_PLUS_THRESHOLD = 30;

/**
 * Deliberately five badges, not ten.
 *
 * The original catalog handed out First Boot, Rookie and First Win for doing
 * nothing more than existing, so within a day of playing almost every account
 * wore three or four badges , a badge that describes the median player
 * describes nobody. Only the two that take real, sustained play (Champion,
 * Legend) and the three an admin actually controls (Tester, Tester+,
 * Premium+) remain, and the two stat badges were pushed well past a first
 * sitting's worth of games.
 */
export const BADGES: BadgeDef[] = [
  {
    id: "champion",
    label: "Champion",
    description: "Played 150 games",
    icon: "trophy",
    color: "from-pink-500 to-rose-500",
    source: "stat",
    gamesNeeded: 150,
    rank: 1,
  },
  {
    id: "legend",
    label: "Legend",
    description: "Won 75 matches",
    icon: "crown",
    color: "from-violet-600 to-pink-600",
    source: "stat",
    winsNeeded: 75,
    rank: 2,
  },
  {
    id: "tester",
    label: "Tester",
    description: `${TESTER_THRESHOLD} bug reports fixed and approved`,
    icon: "bug",
    color: "from-lime-400 to-emerald-500",
    source: "bug",
    bugsNeeded: TESTER_THRESHOLD,
    grantKey: "tester",
    rank: 3,
  },
  {
    id: "tester_plus",
    label: "Tester+",
    description: `${TESTER_PLUS_THRESHOLD} bug reports fixed and approved`,
    icon: "bug-plus",
    color: "from-teal-300 to-cyan-500",
    source: "bug",
    bugsNeeded: TESTER_PLUS_THRESHOLD,
    grantKey: "testerPlus",
    rank: 4,
  },
  {
    id: "premium",
    label: "Premium+",
    description: "Premium member",
    icon: "sparkles",
    color: "from-amber-400 to-yellow-500",
    source: "grant",
    grantKey: "premium",
    rank: 5,
  },
];

export const BADGES_BY_ID: Record<string, BadgeDef> = Object.fromEntries(
  BADGES.map((b) => [b.id, b]),
);

/** What a player has been given by an admin. Absent keys mean "not granted". */
export type Grants = Partial<Record<GrantKey, boolean>>;

export interface BadgeProgress {
  gamesPlayed: number;
  wins: number;
  /** Reports the admin marked approved. */
  bugsApproved: number;
  grants: Grants;
}

export const EMPTY_PROGRESS: BadgeProgress = {
  gamesPlayed: 0,
  wins: 0,
  bugsApproved: 0,
  grants: {},
};

/**
 * Whether a badge is earned.
 *
 * Tester tiers deliberately check the grant rather than recomputing from the
 * approved count: the count on the user document is written by the same admin
 * action that flips the grant, and a badge that appeared the moment a number
 * looked right would be awardable by anyone who could nudge that number.
 */
export function hasBadge(badge: BadgeDef, progress: BadgeProgress): boolean {
  if (badge.source !== "stat") {
    return badge.grantKey ? progress.grants[badge.grantKey] === true : false;
  }
  if (badge.gamesNeeded !== undefined && progress.gamesPlayed < badge.gamesNeeded) return false;
  if (badge.winsNeeded !== undefined && progress.wins < badge.winsNeeded) return false;
  return true;
}

export function earnedBadges(progress: BadgeProgress): BadgeDef[] {
  return BADGES.filter((b) => hasBadge(b, progress));
}

/** The single badge worth showing beside a name: the highest-ranked earned one. */
export function topBadge(progress: BadgeProgress): BadgeDef | null {
  const earned = earnedBadges(progress);
  if (earned.length === 0) return null;
  return earned.reduce((best, b) => (b.rank > best.rank ? b : best));
}

/** Which tester grants an approved-report count has earned. */
export function testerGrantsFor(bugsApproved: number): Grants {
  return {
    tester: bugsApproved >= TESTER_THRESHOLD,
    testerPlus: bugsApproved >= TESTER_PLUS_THRESHOLD,
  };
}

/** Progress toward the next tester tier, for a progress bar. */
export function testerProgress(bugsApproved: number): {
  next: number | null;
  label: string;
  ratio: number;
} {
  if (bugsApproved >= TESTER_PLUS_THRESHOLD) {
    return { next: null, label: "Tester+ earned", ratio: 1 };
  }
  const next = bugsApproved >= TESTER_THRESHOLD ? TESTER_PLUS_THRESHOLD : TESTER_THRESHOLD;
  const floor = bugsApproved >= TESTER_THRESHOLD ? TESTER_THRESHOLD : 0;
  return {
    next,
    label: `${bugsApproved} / ${next} approved`,
    ratio: Math.max(0, Math.min(1, (bugsApproved - floor) / (next - floor))),
  };
}
