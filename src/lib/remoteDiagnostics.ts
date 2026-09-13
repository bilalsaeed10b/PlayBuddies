import { addDoc, collection, serverTimestamp, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BATCH = 40;

export interface RemoteDiagnosticsContext {
  roomId: string;
  gameId: string;
  uid: string;
  who: string;
  session: string;
}

export interface DiagnosticEntry {
  t: string;
  seq: number;
  lvl: "debug" | "info" | "warn" | "error";
  game: string;
  client: string;
  room: string;
  who?: string;
  ev: string;
  data?: Record<string, unknown>;
}

/**
 * Remote collection is for the public HTTPS build. Local/LAN playtests keep
 * using the zero-cost NDJSON collector in scripts/serve.mjs.
 */
export function remoteDiagnosticsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (process.env.NEXT_PUBLIC_REMOTE_DIAGNOSTICS === "off") return false;
  if (process.env.NEXT_PUBLIC_REMOTE_DIAGNOSTICS === "on") return true;
  return window.location.protocol === "https:" &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1";
}

/** Strip malformed or unbounded iframe data before it reaches Firestore. */
export function cleanDiagnosticEntries(
  raw: unknown,
  context: Pick<RemoteDiagnosticsContext, "roomId" | "gameId" | "who">,
): DiagnosticEntry[] {
  if (!Array.isArray(raw)) return [];
  const result: DiagnosticEntry[] = [];
  for (const value of raw.slice(0, MAX_BATCH)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const level = entry.lvl;
    if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") continue;
    const event = shortText(entry.ev, 100);
    const client = shortText(entry.client, 32);
    if (!event || !client) continue;
    const seq = Number(entry.seq);
    result.push({
      t: validIso(entry.t) ? String(entry.t) : new Date().toISOString(),
      seq: Number.isSafeInteger(seq) ? Math.max(0, seq) : 0,
      lvl: level,
      game: context.gameId.slice(0, 48),
      client,
      room: context.roomId,
      who: shortText(entry.who, 60) || context.who.slice(0, 60),
      ev: event,
      ...(entry.data && typeof entry.data === "object"
        ? { data: cleanObject(entry.data as Record<string, unknown>, 0) }
        : {}),
    });
  }
  return result;
}

export async function writeRemoteDiagnostics(
  context: RemoteDiagnosticsContext,
  raw: unknown,
): Promise<number> {
  const entries = cleanDiagnosticEntries(raw, context);
  if (entries.length === 0) return 0;

  await addDoc(collection(db, "diagnostics", context.roomId, "batches"), {
    uid: context.uid,
    who: context.who.slice(0, 60),
    room: context.roomId,
    game: context.gameId.slice(0, 48),
    client: entries[0]?.client ?? "unknown",
    session: context.session.slice(0, 100),
    build: process.env.NEXT_PUBLIC_BUILD_ID ?? "local",
    receivedAt: serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + KEEP_MS),
    entries,
  });
  return entries.length;
}

function shortText(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function validIso(value: unknown): boolean {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function cleanObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth >= 3) return {};
  const out: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 30)) {
    const key = rawKey.slice(0, 60);
    if (!key || rawValue === undefined || typeof rawValue === "function") continue;
    if (typeof rawValue === "string") out[key] = rawValue.slice(0, 500);
    else if (typeof rawValue === "number") out[key] = Number.isFinite(rawValue) ? rawValue : String(rawValue);
    else if (typeof rawValue === "boolean" || rawValue === null) out[key] = rawValue;
    else if (Array.isArray(rawValue)) {
      out[key] = rawValue.slice(0, 30).map((item) => cleanValue(item, depth + 1));
    } else if (typeof rawValue === "object") {
      out[key] = cleanObject(rawValue as Record<string, unknown>, depth + 1);
    }
  }
  return out;
}

function cleanValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean" || value === null) return value;
  // Firestore accepts arrays but rejects an array directly inside another
  // array. Turn that inner list into a tiny named map instead.
  if (Array.isArray(value)) {
    if (depth >= 3) return [];
    return { items: value.slice(0, 30).map((item) => cleanValue(item, depth + 1)) };
  }
  if (value && typeof value === "object") return cleanObject(value as Record<string, unknown>, depth);
  return String(value ?? "");
}
