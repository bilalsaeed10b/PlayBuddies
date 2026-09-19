"use client";

import { useEffect, useState } from "react";
import { onValue, ref, remove, set, update } from "firebase/database";
import { rtdb } from "@/lib/firebase";

/**
 * Switches the admin panel flips for everyone at once.
 *
 * Kept in Realtime Database at `platform/config` rather than Firestore: every
 * signed-in page listens to it, and a Realtime Database listener costs nothing
 * per change, where a Firestore one bills a read per open tab every time the
 * admin touches a switch. See database.rules.json for who may read and write.
 *
 * These are *soft* controls. PlayWithBuddies has no server, so maintenance mode and
 * a disabled game are enforced by the pages that read them, not by the
 * database; a hand-edited client could ignore them. They are for steering an
 * honest crowd , closing the doors before a deploy, pulling a broken game
 * while it is fixed , not for stopping an attacker. Suspension is the same.
 */

export type AnnouncementTone = "info" | "success" | "warning" | "danger";

export interface Announcement {
  text: string;
  tone: AnnouncementTone;
  /** Epoch ms after which it stops showing; 0 for until cleared. */
  until: number;
  /** Changes with every new announcement, so a dismissal only hides that one. */
  id: string;
}

export interface PlatformConfig {
  announcement: Announcement | null;
  maintenance: { on: boolean; message: string };
  /** Games taken out of the catalog, by id. */
  disabledGames: Record<string, boolean>;
}

export const DEFAULT_CONFIG: PlatformConfig = {
  announcement: null,
  maintenance: { on: false, message: "" },
  disabledGames: {},
};

const TONES: AnnouncementTone[] = ["info", "success", "warning", "danger"];

function cleanConfig(raw: unknown): PlatformConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;
  const r = raw as Record<string, unknown>;
  const a = r.announcement as Partial<Announcement> | undefined;
  const m = r.maintenance as { on?: unknown; message?: unknown } | undefined;
  const d = r.disabledGames as Record<string, unknown> | undefined;
  return {
    announcement:
      a && typeof a.text === "string" && a.text.trim()
        ? {
            text: a.text.slice(0, 280),
            tone: TONES.includes(a.tone as AnnouncementTone) ? (a.tone as AnnouncementTone) : "info",
            until: Number.isFinite(Number(a.until)) ? Number(a.until) : 0,
            id: typeof a.id === "string" ? a.id : a.text,
          }
        : null,
    maintenance: { on: m?.on === true, message: typeof m?.message === "string" ? m.message.slice(0, 280) : "" },
    disabledGames: Object.fromEntries(
      Object.entries(d ?? {}).filter(([, v]) => v === true).map(([k]) => [k, true]),
    ),
  };
}

/** The live platform switches. Defaults (everything open) until the first read lands. */
export function usePlatformConfig(enabled = true): PlatformConfig {
  const [config, setConfig] = useState<PlatformConfig>(DEFAULT_CONFIG);
  useEffect(() => {
    if (!enabled) return;
    return onValue(
      ref(rtdb, "platform/config"),
      (snap) => setConfig(cleanConfig(snap.val())),
      // Unreadable (rules not deployed yet, or signed out) reads as "nothing
      // switched on", which is the state the platform was in before this.
      () => setConfig(DEFAULT_CONFIG),
    );
  }, [enabled]);
  return config;
}

/** Whether an announcement should still be on screen. */
export function announcementLive(a: Announcement | null, now = Date.now()): a is Announcement {
  return Boolean(a && (a.until === 0 || a.until > now));
}

// -- admin writes -------------------------------------------------------------

export async function setAnnouncement(text: string, tone: AnnouncementTone, hours: number): Promise<void> {
  const clean = text.trim().slice(0, 280);
  if (!clean) {
    await remove(ref(rtdb, "platform/config/announcement"));
    return;
  }
  const until = hours > 0 ? Date.now() + hours * 3_600_000 : 0;
  await set(ref(rtdb, "platform/config/announcement"), {
    text: clean,
    tone,
    until,
    id: `${Date.now().toString(36)}`,
  });
}

export async function setMaintenance(on: boolean, message: string): Promise<void> {
  await set(ref(rtdb, "platform/config/maintenance"), { on, message: message.trim().slice(0, 280) });
}

export async function setGameDisabled(gameId: string, disabled: boolean): Promise<void> {
  await update(ref(rtdb, "platform/config/disabledGames"), { [gameId]: disabled ? true : null });
}

// -- suspensions --------------------------------------------------------------

export interface Suspension {
  reason: string;
  at: number;
  by: string;
  /** Epoch ms when it lifts on its own; 0 for until lifted by hand. */
  until: number;
}

function cleanSuspension(raw: unknown): Suspension | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Suspension>;
  return {
    reason: typeof r.reason === "string" ? r.reason : "",
    at: Number(r.at) || 0,
    by: typeof r.by === "string" ? r.by : "",
    until: Number(r.until) || 0,
  };
}

export function suspensionActive(s: Suspension | null, now = Date.now()): s is Suspension {
  return Boolean(s && (s.until === 0 || s.until > now));
}

/** This player's own suspension, if there is one. */
export function useMySuspension(uid: string | null | undefined): Suspension | null {
  const [state, setState] = useState<Suspension | null>(null);
  useEffect(() => {
    if (!uid) return;
    return onValue(
      ref(rtdb, `platform/bans/${uid}`),
      (snap) => setState(cleanSuspension(snap.val())),
      () => setState(null),
    );
  }, [uid]);
  return uid ? state : null;
}

/** Every suspension, for the admin panel. */
export function useSuspensions(enabled: boolean): Record<string, Suspension> {
  const [all, setAll] = useState<Record<string, Suspension>>({});
  useEffect(() => {
    if (!enabled) return;
    return onValue(
      ref(rtdb, "platform/bans"),
      (snap) => {
        const out: Record<string, Suspension> = {};
        for (const [uid, raw] of Object.entries((snap.val() ?? {}) as Record<string, unknown>)) {
          const s = cleanSuspension(raw);
          if (s) out[uid] = s;
        }
        setAll(out);
      },
      () => setAll({}),
    );
  }, [enabled]);
  return all;
}

export async function suspendPlayer(uid: string, reason: string, hours: number, by: string): Promise<void> {
  await set(ref(rtdb, `platform/bans/${uid}`), {
    reason: reason.trim().slice(0, 280),
    at: Date.now(),
    by,
    until: hours > 0 ? Date.now() + hours * 3_600_000 : 0,
  });
}

export async function liftSuspension(uid: string): Promise<void> {
  await remove(ref(rtdb, `platform/bans/${uid}`));
}
