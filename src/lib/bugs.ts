import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit as qLimit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Timestamp,
  type Unsubscribe,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { testerGrantsFor } from "@/lib/badges";

/**
 * Bug reports: the player's side of the loop, and the admin's.
 *
 * There is no server, so a report is a document a player writes directly and
 * an admin reads. That shapes three things:
 *
 *   * The reporter writes once and can never edit , a report that could be
 *     rewritten after triage is not evidence of anything.
 *   * Status, notes and the approval flag live on the same document but are
 *     admin-only in the rules, so the queue cannot be gamed from a console.
 *   * The approved-report counter is kept on the *user* document rather than
 *     recounted from this collection, because a player may not list other
 *     people's reports and the badge check has to work from what they can read.
 */

export const BUG_STATUSES = [
  "new",
  "triaged",
  "in_progress",
  "fixed",
  "approved",
  "rejected",
  "duplicate",
] as const;

export type BugStatus = (typeof BUG_STATUSES)[number];

/** Statuses an admin has finished with, for queue counts. */
export const CLOSED_STATUSES: BugStatus[] = ["approved", "rejected", "duplicate"];

export const BUG_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type BugSeverity = (typeof BUG_SEVERITIES)[number];

export const BUG_CATEGORIES = [
  "gameplay",
  "graphics",
  "audio",
  "network",
  "ui",
  "performance",
  "crash",
  "other",
] as const;
export type BugCategory = (typeof BUG_CATEGORIES)[number];

/** Everything captured from the browser at the moment Report was pressed. */
export interface BugContext {
  url: string;
  userAgent: string;
  platform: string;
  language: string;
  viewport: string;
  screen: string;
  devicePixelRatio: number;
  build: string;
  /** Network Information API, where the browser exposes it. */
  connection: string;
  downlinkMbps: number | null;
  rttMs: number | null;
  saveData: boolean;
  online: boolean;
  memoryGb: number | null;
  cores: number | null;
  timezone: string;
}

export interface BugReport {
  id: string;
  uid: string;
  reporterName: string;
  reporterEmail: string;
  reporterPhoto: string;
  title: string;
  description: string;
  gameId: string;
  roomId: string;
  severity: BugSeverity;
  category: BugCategory;
  status: BugStatus;
  /** Storage path, kept so an admin can always re-resolve a stale URL. */
  screenshotPath: string;
  screenshotURL: string;
  context: BugContext;
  adminNotes: string;
  /** Set once, when an admin first moves this report to `approved`. */
  countedForBadge: boolean;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
  resolvedAt: Timestamp | null;
  resolvedBy: string;
}

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 2000;
export const NOTES_MAX = 2000;
/** Matches the cap in storage.rules. */
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;

export function captureContext(): BugContext {
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
    deviceMemory?: number;
  };
  const c = nav.connection;
  return {
    url: location.href.slice(0, 500),
    userAgent: navigator.userAgent.slice(0, 400),
    platform: (navigator.platform || "").slice(0, 60),
    language: (navigator.language || "").slice(0, 20),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    screen: `${window.screen.width}x${window.screen.height}`,
    devicePixelRatio: Math.round((window.devicePixelRatio || 1) * 100) / 100,
    build: (process.env.NEXT_PUBLIC_BUILD_ID || "local").slice(0, 60),
    connection: (c?.effectiveType || "unknown").slice(0, 20),
    downlinkMbps: typeof c?.downlink === "number" ? c.downlink : null,
    rttMs: typeof c?.rtt === "number" ? c.rtt : null,
    saveData: c?.saveData === true,
    online: navigator.onLine,
    memoryGb: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    cores: typeof navigator.hardwareConcurrency === "number" ? navigator.hardwareConcurrency : null,
    timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone || "").slice(0, 60),
  };
}

/**
 * Shrink a screenshot before it goes anywhere near Storage.
 *
 * A raw phone screenshot is several megabytes of PNG; the same frame as a
 * 1600px WebP is a fraction of that and still perfectly legible for reading a
 * misdrawn sprite or a wrong score. The cap in the rules is the backstop, this
 * is what keeps ordinary reports well under it.
 */
export async function compressScreenshot(file: Blob, maxPx = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not prepare the screenshot for upload.");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.82),
  );
  if (!blob) throw new Error("Could not prepare the screenshot for upload.");
  return blob;
}

export interface NewBugReport {
  title: string;
  description: string;
  gameId: string;
  roomId: string;
  severity: BugSeverity;
  category: BugCategory;
  screenshot: Blob | null;
  context: BugContext;
}

export interface Reporter {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
}

/**
 * File one report.
 *
 * The document is created first and the screenshot uploaded against its id,
 * so a failed upload leaves a readable report rather than an orphaned image in
 * a bucket nobody will ever look in. If the upload then fails the report keeps
 * its empty `screenshotPath` and the admin list says the shot is missing.
 */
export async function submitBugReport(reporter: Reporter, input: NewBugReport): Promise<string> {
  const created = await addDoc(collection(db, "bugReports"), {
    uid: reporter.uid,
    reporterName: reporter.displayName.slice(0, 60),
    reporterEmail: reporter.email.slice(0, 320),
    reporterPhoto: reporter.photoURL.slice(0, 500),
    title: input.title.trim().slice(0, TITLE_MAX),
    description: input.description.trim().slice(0, DESCRIPTION_MAX),
    gameId: input.gameId.slice(0, 48),
    roomId: input.roomId.slice(0, 6),
    severity: input.severity,
    category: input.category,
    status: "new" as BugStatus,
    screenshotPath: "",
    screenshotURL: "",
    context: input.context,
    adminNotes: "",
    countedForBadge: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    resolvedAt: null,
    resolvedBy: "",
  });

  if (input.screenshot) {
    const path = `bugShots/${reporter.uid}/${created.id}.webp`;
    const fileRef = ref(storage, path);
    await uploadBytes(fileRef, input.screenshot, { contentType: "image/webp" });
    const url = await getDownloadURL(fileRef);
    await updateDoc(created, { screenshotPath: path, screenshotURL: url });
  }

  // Best-effort: the submitted counter is a convenience for the reporter's own
  // profile, and a report that lands without it is still a report.
  try {
    await setDoc(
      doc(db, "users", reporter.uid),
      { bugStats: { submitted: increment(1) } },
      { merge: true },
    );
  } catch {
    // Ignored on purpose , see above.
  }

  return created.id;
}

function toReport(id: string, data: Record<string, unknown>): BugReport {
  const d = data as Partial<BugReport>;
  return {
    id,
    uid: d.uid ?? "",
    reporterName: d.reporterName ?? "Unknown",
    reporterEmail: d.reporterEmail ?? "",
    reporterPhoto: d.reporterPhoto ?? "",
    title: d.title ?? "(no title)",
    description: d.description ?? "",
    gameId: d.gameId ?? "",
    roomId: d.roomId ?? "",
    severity: (d.severity as BugSeverity) ?? "medium",
    category: (d.category as BugCategory) ?? "other",
    status: (d.status as BugStatus) ?? "new",
    screenshotPath: d.screenshotPath ?? "",
    screenshotURL: d.screenshotURL ?? "",
    context: (d.context as BugContext) ?? ({} as BugContext),
    adminNotes: d.adminNotes ?? "",
    countedForBadge: d.countedForBadge === true,
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
    resolvedAt: d.resolvedAt ?? null,
    resolvedBy: d.resolvedBy ?? "",
  };
}

/** Live queue for the admin panel, newest first. */
export function watchAllReports(
  onChange: (reports: BugReport[]) => void,
  onError: (error: Error) => void,
  max = 300,
): Unsubscribe {
  const q = query(collection(db, "bugReports"), orderBy("createdAt", "desc"), qLimit(max));
  return onSnapshot(q, (snap) => onChange(snap.docs.map((d) => toReport(d.id, d.data()))), onError);
}

/** A player's own reports. The rules allow exactly this query and no wider one. */
export function watchMyReports(
  uid: string,
  onChange: (reports: BugReport[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const q = query(
    collection(db, "bugReports"),
    where("uid", "==", uid),
    orderBy("createdAt", "desc"),
    qLimit(50),
  );
  return onSnapshot(q, (snap) => onChange(snap.docs.map((d) => toReport(d.id, d.data()))), onError);
}

/**
 * Move a report along the queue.
 *
 * Approval is the only status change with a side effect. The report carries
 * `countedForBadge` so that flipping a report to approved, away, and back
 * cannot ratchet a reporter's total , the counter moves exactly once per
 * report, the first time it is approved.
 */
export async function setReportStatus(
  report: BugReport,
  status: BugStatus,
  admin: { uid: string; email: string },
  notes?: string,
): Promise<void> {
  const patch: Record<string, unknown> = {
    status,
    updatedAt: serverTimestamp(),
    resolvedBy: admin.email.slice(0, 320),
  };
  if (notes !== undefined) patch.adminNotes = notes.slice(0, NOTES_MAX);
  if (CLOSED_STATUSES.includes(status)) patch.resolvedAt = serverTimestamp();

  const firstApproval = status === "approved" && !report.countedForBadge;
  if (firstApproval) patch.countedForBadge = true;

  await updateDoc(doc(db, "bugReports", report.id), patch);

  // The status change has already landed by here, so a failure crediting the
  // reporter is a different fact from "the report could not be updated" and
  // says so , otherwise the admin retries a change that already succeeded.
  if (firstApproval) {
    try {
      await creditApprovedReport(report.uid);
    } catch (e) {
      console.error("Approved report was saved but not credited", e);
      throw new Error(
        "Report approved, but crediting the reporter failed. Their badge progress did not move.",
      );
    }
  }
}

/**
 * Credit one approved report to its reporter and award any tester tier it just
 * unlocked.
 *
 * The count is re-read after the increment rather than derived from a value
 * held in the panel, because two admins approving at once would otherwise both
 * compute the same "before" number and one award would be lost.
 */
async function creditApprovedReport(uid: string): Promise<void> {
  const userRef = doc(db, "users", uid);
  await setDoc(userRef, { bugStats: { approved: increment(1) } }, { merge: true });

  const snap = await getDoc(userRef);
  const data = snap.data() as { bugStats?: { approved?: number }; grants?: Record<string, boolean> };
  const approved = Number(data?.bugStats?.approved ?? 0);
  const deserved = testerGrantsFor(approved);
  const grants = data?.grants ?? {};

  const patch: Record<string, boolean> = {};
  if (deserved.tester && grants.tester !== true) patch.tester = true;
  if (deserved.testerPlus && grants.testerPlus !== true) patch.testerPlus = true;
  if (Object.keys(patch).length > 0) await setDoc(userRef, { grants: patch }, { merge: true });
}

/** Admin override for the grant badges that have no automatic trigger. */
export async function setGrant(
  uid: string,
  key: "premium" | "tester" | "testerPlus",
  value: boolean,
): Promise<void> {
  await setDoc(doc(db, "users", uid), { grants: { [key]: value } }, { merge: true });
}

/** One-shot count for panels that do not need a live subscription. */
export async function countReportsByStatus(): Promise<Record<BugStatus, number>> {
  const snap = await getDocs(query(collection(db, "bugReports"), qLimit(1000)));
  const counts = Object.fromEntries(BUG_STATUSES.map((s) => [s, 0])) as Record<BugStatus, number>;
  snap.docs.forEach((d) => {
    const status = (d.data().status as BugStatus) ?? "new";
    if (status in counts) counts[status] += 1;
  });
  return counts;
}
