import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { LOBBY_TTL_MS } from "@/lib/rooms";
import { ROOM_STALE_MS } from "@/lib/adminMetrics";
import { DAILY_CHALLENGE_CAP, GEMS_PER_CHALLENGE } from "@/lib/challenges";

/**
 * Every ceiling the platform runs under, in one place.
 *
 * Two kinds, kept apart on purpose:
 *
 *   * Service limits: what Google, Cloudflare and GitHub allow the project.
 *     These depend on the billing plan, and prices and allowances change, so
 *     the defaults below are editable in the panel and saved to
 *     `adminConfig/limits` (admin-only in the rules). Check them against each
 *     provider's pricing page once and correct anything that has moved.
 *   * App limits: what this codebase itself enforces, in the rules or in code.
 *     These are facts about the code, not settings, and are listed read-only.
 */

export type Plan = "spark" | "blaze";

export type LimitUnit = "count" | "bytes" | "connections" | "percent";

export interface ServiceLimit {
  key: string;
  service: string;
  label: string;
  unit: LimitUnit;
  /** "day" resets at midnight Pacific for Firestore; "month" on the 1st; "now" is instantaneous. */
  period: "day" | "month" | "now" | "total";
  spark: number;
  blaze: number;
  /** What happens past it on each plan. */
  sparkOver: string;
  blazeOver: string;
}

const GB = 1024 ** 3;

export const SERVICE_LIMITS: ServiceLimit[] = [
  { key: "fs.reads", service: "Firestore", label: "Document reads", unit: "count", period: "day",
    spark: 50_000, blaze: 50_000, sparkOver: "Reads fail until the daily reset", blazeOver: "Billed per 100k" },
  { key: "fs.writes", service: "Firestore", label: "Document writes", unit: "count", period: "day",
    spark: 20_000, blaze: 20_000, sparkOver: "Writes fail until the daily reset", blazeOver: "Billed per 100k" },
  { key: "fs.deletes", service: "Firestore", label: "Document deletes", unit: "count", period: "day",
    spark: 20_000, blaze: 20_000, sparkOver: "Deletes fail until the daily reset", blazeOver: "Billed per 100k" },
  { key: "fs.stored", service: "Firestore", label: "Stored data", unit: "bytes", period: "total",
    spark: 1 * GB, blaze: 1 * GB, sparkOver: "Writes refused", blazeOver: "Billed per GiB-month" },
  { key: "db.connections", service: "Realtime Database", label: "Simultaneous connections", unit: "connections", period: "now",
    spark: 100, blaze: 200_000, sparkOver: "New players cannot connect: presence, chat, signalling all stop",
    blazeOver: "Hard cap per database instance" },
  { key: "db.load", service: "Realtime Database", label: "Database load", unit: "percent", period: "now",
    spark: 100, blaze: 100, sparkOver: "Requests queue and slow down", blazeOver: "Requests queue and slow down" },
  { key: "db.sent", service: "Realtime Database", label: "Data downloaded", unit: "bytes", period: "month",
    spark: 10 * GB, blaze: 10 * GB, sparkOver: "Database disabled until next month", blazeOver: "Billed per GB" },
  { key: "db.stored", service: "Realtime Database", label: "Stored data", unit: "bytes", period: "total",
    spark: 1 * GB, blaze: 1 * GB, sparkOver: "Writes refused", blazeOver: "Billed per GB-month" },
  { key: "gcs.stored", service: "Cloud Storage", label: "Stored files (screenshots)", unit: "bytes", period: "total",
    spark: 5 * GB, blaze: 5 * GB, sparkOver: "Uploads refused", blazeOver: "Billed per GB-month" },
  { key: "gcs.sent", service: "Cloud Storage", label: "Data downloaded", unit: "bytes", period: "month",
    spark: 30 * GB, blaze: 100 * GB, sparkOver: "Downloads refused", blazeOver: "Billed per GB" },
  { key: "gcs.requests", service: "Cloud Storage", label: "Requests", unit: "count", period: "day",
    spark: 70_000, blaze: 70_000, sparkOver: "Requests refused", blazeOver: "Billed per 10k" },
];

/**
 * Services the panel cannot read from here, with the ceiling and where to look.
 * Cloudflare's API refuses browser calls, and GitHub Pages publishes no usage.
 */
export const EXTERNAL_LIMITS: { service: string; label: string; limit: string; note: string; url: string }[] = [
  { service: "Cloudflare Workers", label: "TURN credential requests", limit: "100,000 / day",
    note: "One per player per match that opens a peer connection.",
    url: "https://dash.cloudflare.com/?to=/:account/workers-and-pages" },
  { service: "Cloudflare Realtime", label: "TURN relayed traffic", limit: "1,000 GB / month",
    note: "Only pairs that cannot connect directly use it.",
    url: "https://dash.cloudflare.com/?to=/:account/calls" },
  { service: "GitHub Pages", label: "Site bandwidth", limit: "100 GB / month (soft)",
    note: "Game bundles and the site itself. Site size cap 1 GB.",
    url: "https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits" },
  { service: "Firebase Auth", label: "Google sign-ins", limit: "No daily cap",
    note: "Social sign-in on the standard tier is not metered.",
    url: "https://firebase.google.com/pricing" },
];

/** What the code enforces, read-only. Each line names where. */
export const APP_LIMITS: { area: string; label: string; value: string; where: string }[] = [
  { area: "Rooms", label: "Players per room", value: "8", where: "firestore.rules , lobbies" },
  { area: "Rooms", label: "Room lifetime", value: `${Math.round(LOBBY_TTL_MS / 3_600_000)} h`, where: "src/lib/rooms.ts" },
  { area: "Rooms", label: "Counts as abandoned after", value: `${Math.round(ROOM_STALE_MS / 1000)} s without a host beat`, where: "src/lib/adminMetrics.ts" },
  { area: "Rooms", label: "Guest may take over host after", value: "30 s host silence", where: "firestore.rules , canClaimHost" },
  { area: "Rooms", label: "Game-state fields per player", value: "30", where: "firestore.rules , updates" },
  { area: "Chat", label: "Message length", value: "200 characters", where: "firestore.rules , messages" },
  { area: "Chat", label: "Messages kept on screen", value: "50", where: "src/app/lobby/page.tsx" },
  { area: "Economy", label: "Daily challenges paid", value: `${DAILY_CHALLENGE_CAP} per UTC day`, where: "firestore.rules , challengeStep" },
  { area: "Economy", label: "Gems earnable", value: `${DAILY_CHALLENGE_CAP * GEMS_PER_CHALLENGE} per day (${GEMS_PER_CHALLENGE} each)`, where: "firestore.rules , gemsStep" },
  { area: "Economy", label: "Coins per game purse", value: "10,000,000", where: "src/lib/wallet.ts" },
  { area: "Economy", label: "Games with a purse / unlocks per game", value: "12 / 60", where: "firestore.rules , walletStep" },
  { area: "Stats", label: "Match result step", value: "+1 game, +≤1 win per write", where: "firestore.rules , statsStep" },
  { area: "Bugs", label: "Report title / description", value: "120 / 2,000 characters", where: "firestore.rules , bugReports" },
  { area: "Bugs", label: "Screenshot size", value: "2 MB", where: "storage.rules" },
  { area: "Bugs", label: "Tester / Tester+ badge", value: "10 / 30 approved reports", where: "src/lib/badges.ts" },
  { area: "Social", label: "Friend search results per query", value: "20", where: "firestore.rules , profiles" },
  { area: "Social", label: "Invites", value: "Friends only", where: "firestore.rules , invites" },
  { area: "Diagnostics", label: "Log batch size / kept for", value: "40 entries / 7 days", where: "firestore.rules , diagnostics" },
];

export interface LimitsConfig {
  plan: Plan;
  overrides: Record<string, number>;
}

export const DEFAULT_LIMITS: LimitsConfig = { plan: "spark", overrides: {} };

export function limitFor(l: ServiceLimit, config: LimitsConfig): number {
  const o = config.overrides[l.key];
  return Number.isFinite(o) && o > 0 ? o : config.plan === "blaze" ? l.blaze : l.spark;
}

export async function readLimitsConfig(): Promise<LimitsConfig> {
  const snap = await getDoc(doc(db, "adminConfig", "limits"));
  const data = snap.data() as Partial<LimitsConfig> | undefined;
  if (!data) return DEFAULT_LIMITS;
  const overrides: Record<string, number> = {};
  for (const [k, v] of Object.entries(data.overrides ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) overrides[k] = n;
  }
  return { plan: data.plan === "blaze" ? "blaze" : "spark", overrides };
}

export async function saveLimitsConfig(config: LimitsConfig): Promise<void> {
  await setDoc(doc(db, "adminConfig", "limits"), config);
}
