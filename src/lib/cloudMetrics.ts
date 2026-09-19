"use client";

import { GoogleAuthProvider, reauthenticateWithPopup, type User } from "firebase/auth";
import app from "@/lib/firebase";

/**
 * Real usage numbers, straight from Google Cloud Monitoring.
 *
 * The panel used to say, correctly, that a browser cannot see the project's
 * daily read and write counts , they live in Cloud Monitoring, behind Google
 * Cloud permissions a Firebase sign-in does not carry. That is still true of
 * an ordinary sign-in. It stops being true the moment the admin grants this
 * page one extra, read-only Google permission (`monitoring.read`) with their
 * own Google account: the same account that owns the Firebase project and can
 * already see these numbers in the console. The token is short-lived (about an
 * hour), kept only in this tab's session storage, and never written anywhere.
 *
 * Nothing here can change anything. Monitoring is read-only by construction.
 */

export const MONITORING_SCOPE = "https://www.googleapis.com/auth/monitoring.read";
const TOKEN_KEY = "pb_gcp_monitoring_token";
export const PROJECT_ID = app.options.projectId ?? "playbuddies-556cd";

export const MONITORING_API_URL = `https://console.cloud.google.com/apis/library/monitoring.googleapis.com?project=${PROJECT_ID}`;
export const FIREBASE_USAGE_URL = `https://console.firebase.google.com/project/${PROJECT_ID}/usage`;

interface StoredToken {
  token: string;
  exp: number;
}

export function storedToken(): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as StoredToken;
    if (!t.token || Date.now() > t.exp) return null;
    return t.token;
  } catch {
    return null;
  }
}

export function forgetToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Ask Google for a read-only Monitoring token, as the signed-in admin. */
export async function connectMonitoring(user: User): Promise<string> {
  const provider = new GoogleAuthProvider();
  provider.addScope(MONITORING_SCOPE);
  if (user.email) provider.setCustomParameters({ login_hint: user.email });
  const result = await reauthenticateWithPopup(user, provider);
  const token = GoogleAuthProvider.credentialFromResult(result)?.accessToken;
  if (!token) throw new Error("Google did not return an access token.");
  try {
    // Google issues these for an hour; five minutes of margin.
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, exp: Date.now() + 55 * 60_000 }));
  } catch {
    /* the token still works for this render */
  }
  return token;
}

export class MonitoringError extends Error {
  constructor(
    message: string,
    public kind: "expired" | "disabled" | "denied" | "other",
  ) {
    super(message);
  }
}

export interface Point {
  /** End of the aligned window, epoch ms. */
  t: number;
  v: number;
}

type Aligner = "ALIGN_SUM" | "ALIGN_MAX" | "ALIGN_MEAN";
type Reducer = "REDUCE_SUM" | "REDUCE_MAX";

/**
 * One metric, aligned and reduced to a single series, oldest point first.
 * Resolves to null when the metric has no data or does not exist for this
 * project , a service that has never been used simply has no series.
 */
async function series(
  token: string,
  metric: string,
  startMs: number,
  endMs: number,
  periodS: number,
  aligner: Aligner,
  reducer: Reducer,
): Promise<Point[] | null> {
  const q = new URLSearchParams({
    filter: `metric.type = "${metric}"`,
    "interval.startTime": new Date(startMs).toISOString(),
    "interval.endTime": new Date(endMs).toISOString(),
    "aggregation.alignmentPeriod": `${Math.max(60, Math.ceil(periodS))}s`,
    "aggregation.perSeriesAligner": aligner,
    "aggregation.crossSeriesReducer": reducer,
  });
  const res = await fetch(`https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/timeSeries?${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
    const message = body.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new MonitoringError("The Google token expired. Connect again.", "expired");
    if (res.status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(message)) {
      throw new MonitoringError("The Cloud Monitoring API is switched off for this project.", "disabled");
    }
    if (res.status === 403) throw new MonitoringError(message, "denied");
    // A metric this project has never produced reads as "cannot find".
    if (res.status === 400 || res.status === 404) return null;
    throw new MonitoringError(message, "other");
  }
  const data = (await res.json()) as {
    timeSeries?: { points?: { interval: { endTime: string }; value: { int64Value?: string; doubleValue?: number } }[] }[];
  };
  const points = data.timeSeries?.[0]?.points;
  if (!points || points.length === 0) return null;
  return points
    .map((p) => ({ t: Date.parse(p.interval.endTime), v: Number(p.value.int64Value ?? p.value.doubleValue ?? 0) }))
    .sort((a, b) => a.t - b.t);
}

/** The first metric of a list that has data, for names Google has renamed over time. */
async function firstOf(
  token: string,
  metrics: string[],
  ...rest: [number, number, number, Aligner, Reducer]
): Promise<Point[] | null> {
  for (const m of metrics) {
    const s = await series(token, m, ...rest);
    if (s) return s;
  }
  return null;
}

const total = (s: Point[] | null) => (s ? s.reduce((n, p) => n + p.v, 0) : null);
const last = (s: Point[] | null) => (s && s.length > 0 ? s[s.length - 1].v : null);
const peak = (s: Point[] | null) => (s && s.length > 0 ? Math.max(...s.map((p) => p.v)) : null);

/**
 * Midnight in Los Angeles, as an instant.
 *
 * Firestore's free daily quota resets at midnight Pacific, not UTC, so "reads
 * today" has to mean the same day Google means or the bar would reset hours
 * away from the real one.
 */
export function pacificMidnight(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const y = get("year");
  const m = get("month");
  const d = get("day");
  // Pacific is UTC-7 or UTC-8; whichever of the two lands on 00:00 there.
  for (const offset of [7, 8]) {
    const candidate = Date.UTC(y, m - 1, d, offset);
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(candidate));
    if (Number(hour) === 0) return candidate;
  }
  return Date.UTC(y, m - 1, d, 8);
}

/** First instant of this calendar month, UTC , when monthly bandwidth counts restart. */
export function monthStart(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

export interface CloudUsage {
  fetchedAt: number;
  dayStart: number;
  firestore: {
    reads: number | null;
    writes: number | null;
    deletes: number | null;
    readsHourly: Point[];
    writesHourly: Point[];
  };
  rtdb: {
    connections: number | null;
    connectionsPeak: number | null;
    connectionsHourly: Point[];
    /** 0-100. */
    load: number | null;
    loadPeak: number | null;
    loadHourly: Point[];
    sentMonthBytes: number | null;
    storedBytes: number | null;
  };
  storage: {
    storedBytes: number | null;
    sentMonthBytes: number | null;
    requestsToday: number | null;
  };
}

/** Everything the limits panel draws, in one go. Individual metrics may be null. */
export async function loadCloudUsage(token: string): Promise<CloudUsage> {
  const now = Date.now();
  const dayStart = pacificMidnight(new Date(now));
  const since = Math.max(60, (now - dayStart) / 1000);
  const dayAgo = now - 24 * 3_600_000;
  const month = monthStart(new Date(now));
  const monthS = Math.max(60, (now - month) / 1000);

  const FS = "firestore.googleapis.com/document/";
  const DB = "firebasedatabase.googleapis.com/";
  const GCS = "storage.googleapis.com/";

  // Run in parallel; a metric that fails on its own does not sink the rest ,
  // except auth problems, which are the same for every call and are rethrown.
  const settle = async <T,>(p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof MonitoringError && e.kind !== "other") throw e;
      console.warn("[monitoring]", e);
      return null;
    }
  };

  const [
    reads, writes, deletes, readsHourly, writesHourly,
    conns, connsHourly, load, loadHourly, dbSent, dbStored,
    gcsStored, gcsSent, gcsRequests,
  ] = await Promise.all([
    settle(firstOf(token, [`${FS}read_count`, `${FS}read_ops_count`], dayStart, now, since, "ALIGN_SUM", "REDUCE_SUM")),
    settle(firstOf(token, [`${FS}write_count`, `${FS}write_ops_count`], dayStart, now, since, "ALIGN_SUM", "REDUCE_SUM")),
    settle(firstOf(token, [`${FS}delete_count`, `${FS}delete_ops_count`], dayStart, now, since, "ALIGN_SUM", "REDUCE_SUM")),
    settle(firstOf(token, [`${FS}read_count`, `${FS}read_ops_count`], dayAgo, now, 3600, "ALIGN_SUM", "REDUCE_SUM")),
    settle(firstOf(token, [`${FS}write_count`, `${FS}write_ops_count`], dayAgo, now, 3600, "ALIGN_SUM", "REDUCE_SUM")),
    settle(series(token, `${DB}network/active_connections`, now - 15 * 60_000, now, 300, "ALIGN_MAX", "REDUCE_SUM")),
    settle(series(token, `${DB}network/active_connections`, dayAgo, now, 3600, "ALIGN_MAX", "REDUCE_SUM")),
    settle(series(token, `${DB}io/database_load`, now - 15 * 60_000, now, 300, "ALIGN_MAX", "REDUCE_SUM")),
    settle(series(token, `${DB}io/database_load`, dayAgo, now, 3600, "ALIGN_MAX", "REDUCE_SUM")),
    settle(series(token, `${DB}network/sent_bytes_count`, month, now, monthS, "ALIGN_SUM", "REDUCE_SUM")),
    settle(series(token, `${DB}storage/total_bytes`, now - 2 * 86_400_000, now, 3600, "ALIGN_MAX", "REDUCE_SUM")),
    settle(series(token, `${GCS}storage/total_bytes`, now - 3 * 86_400_000, now, 86_400, "ALIGN_MAX", "REDUCE_SUM")),
    settle(series(token, `${GCS}network/sent_bytes_count`, month, now, monthS, "ALIGN_SUM", "REDUCE_SUM")),
    settle(series(token, `${GCS}api/request_count`, dayStart, now, since, "ALIGN_SUM", "REDUCE_SUM")),
  ]);

  // Database load is reported as a fraction; tolerate a percentage too.
  const pct = (v: number | null) => (v === null ? null : v <= 1.5 ? v * 100 : v);
  const pctSeries = (s: Point[] | null) => (s ?? []).map((p) => ({ t: p.t, v: pct(p.v) ?? 0 }));

  return {
    fetchedAt: now,
    dayStart,
    firestore: {
      reads: total(reads),
      writes: total(writes),
      deletes: total(deletes),
      readsHourly: readsHourly ?? [],
      writesHourly: writesHourly ?? [],
    },
    rtdb: {
      connections: last(conns),
      connectionsPeak: peak(connsHourly),
      connectionsHourly: connsHourly ?? [],
      load: pct(last(load)),
      loadPeak: pct(peak(loadHourly)),
      loadHourly: pctSeries(loadHourly),
      sentMonthBytes: total(dbSent),
      storedBytes: last(dbStored),
    },
    storage: {
      storedBytes: last(gcsStored),
      sentMonthBytes: total(gcsSent),
      requestsToday: total(gcsRequests),
    },
  };
}
