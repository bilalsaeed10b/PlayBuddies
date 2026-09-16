import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  getDocs,
  limit as qLimit,
  onSnapshot,
  query,
  type Timestamp,
} from "firebase/firestore";
import { get, onValue, ref } from "firebase/database";
import { db, rtdb } from "@/lib/firebase";

/**
 * What the admin panel can actually know, and what it only estimates.
 *
 * PlayBuddies has no server, so the panel is just another signed-in client
 * with wider read rules. That is a real limit and it is surfaced rather than
 * papered over:
 *
 *   * Live rooms, players, bug reports and account records are *counted* ,
 *     these are documents the panel reads directly and the numbers are exact.
 *   * Quota consumption is *estimated*. Reads and writes per day live in
 *     Cloud Monitoring, which needs a service account; a browser cannot see
 *     them. The panel counts the operations it performs itself and sizes the
 *     stored data from the documents it can see, and both are labelled as
 *     estimates in the UI.
 *
 * A dashboard that invented a "47% of quota" bar from numbers it could not
 * read would be worse than one that says plainly which figures are measured.
 */

/** Spark (free) plan ceilings, for the limits panel. */
export const FREE_TIER = {
  firestoreReadsPerDay: 50_000,
  firestoreWritesPerDay: 20_000,
  firestoreDeletesPerDay: 20_000,
  firestoreStorageBytes: 1024 ** 3,
  rtdbConcurrent: 100,
  rtdbStorageBytes: 1024 ** 3,
  rtdbDownloadPerMonthBytes: 10 * 1024 ** 3,
  storageBytes: 5 * 1024 ** 3,
  storageUploadsPerDay: 20_000,
  storageDownloadsPerDay: 50_000,
} as const;

export interface LiveLobby {
  id: string;
  hostId: string;
  gameId: string;
  status: string;
  playerCount: number;
  players: { uid: string; displayName: string; photoURL: string; isReady: boolean }[];
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
  hostSeenAt: Timestamp | null;
}

export interface AdminUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
  gamesPlayed: number;
  wins: number;
  coins: Record<string, number>;
  unlocks: Record<string, number[]>;
  grants: Record<string, boolean>;
  bugStats: { submitted: number; approved: number };
  createdAt: Timestamp | null;
}

/**
 * Every live room.
 *
 * `list` on lobbies is admin-only for a reason , this single subscription
 * returns every room code on the platform along with who is in it, which is
 * exactly the read that would let a stranger walk into any game.
 */
export function useLiveLobbies(enabled: boolean) {
  const [lobbies, setLobbies] = useState<LiveLobby[]>([]);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!enabled) return;
    const unsub = onSnapshot(
      query(collection(db, "lobbies"), qLimit(200)),
      (snap) => {
        setLobbies(
          snap.docs.map((d) => {
            const data = d.data() as Record<string, unknown>;
            const players = (data.players ?? {}) as Record<string, Record<string, unknown>>;
            return {
              id: d.id,
              hostId: String(data.hostId ?? ""),
              gameId: String(data.gameId ?? data.selectedGame ?? ""),
              status: String(data.status ?? "waiting"),
              playerCount: Object.keys(players).length,
              players: Object.values(players).map((p) => ({
                uid: String(p.uid ?? ""),
                displayName: String(p.displayName ?? "Player"),
                photoURL: String(p.photoURL ?? ""),
                isReady: p.isReady === true,
              })),
              createdAt: (data.createdAt as Timestamp) ?? null,
              updatedAt: (data.updatedAt as Timestamp) ?? null,
              hostSeenAt: (data.hostSeenAt as Timestamp) ?? null,
            };
          }),
        );
        setError("");
      },
      (e) => setError(e.message),
    );
    return unsub;
  }, [enabled]);

  return { lobbies, error };
}

/** Every account. One read per visit rather than a live subscription. */
export function useAllUsers(enabled: boolean, refreshKey: number) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  // Loading is derived rather than stored: the fetch restarts whenever
  // refreshKey moves, and a stored flag would have to be set synchronously
  // inside the effect to keep up with it.
  const [loadedKey, setLoadedKey] = useState(-1);
  const [error, setError] = useState("");
  const loading = loadedKey !== refreshKey;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getDocs(query(collection(db, "users"), qLimit(1000)))
      .then((snap) => {
        if (cancelled) return;
        setUsers(
          snap.docs.map((d) => {
            const data = d.data() as Record<string, unknown>;
            const stats = (data.stats ?? {}) as Record<string, number>;
            const bugStats = (data.bugStats ?? {}) as Record<string, number>;
            return {
              uid: d.id,
              email: String(data.email ?? ""),
              displayName: String(data.displayName ?? data.name ?? ""),
              photoURL: String(data.photoURL ?? ""),
              gamesPlayed: Number(stats.gamesPlayed ?? 0),
              wins: Number(stats.wins ?? 0),
              coins: (data.coins ?? {}) as Record<string, number>,
              unlocks: (data.unlocks ?? {}) as Record<string, number[]>,
              grants: (data.grants ?? {}) as Record<string, boolean>,
              bugStats: {
                submitted: Number(bugStats.submitted ?? 0),
                approved: Number(bugStats.approved ?? 0),
              },
              createdAt: (data.createdAt as Timestamp) ?? null,
            };
          }),
        );
        setError("");
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoadedKey(refreshKey));
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);

  return { users, loading, error };
}

/** Uids currently online, straight off the presence tree. */
export function useOnlineUids(enabled: boolean) {
  const [uids, setUids] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    const unsub = onValue(ref(rtdb, "presence/users"), (snap) => {
      const value = (snap.val() ?? {}) as Record<string, { online?: boolean }>;
      setUids(Object.entries(value).filter(([, v]) => v?.online === true).map(([uid]) => uid));
    });
    return unsub;
  }, [enabled]);

  return uids;
}

export interface NetworkHealth {
  /** Round trip of a real write to the realtime database, in ms. */
  rtdbRttMs: number | null;
  /** Round trip of a real read from Firestore, in ms. */
  firestoreRttMs: number | null;
  /** How far this machine's clock sits from Firebase's, in ms. */
  clockSkewMs: number | null;
  /** Whether the realtime database socket is currently up. */
  rtdbConnected: boolean;
  /** The browser's own view of the link, where it exposes one. */
  effectiveType: string;
  downlinkMbps: number | null;
  rttMs: number | null;
  online: boolean;
  lastProbeAt: number;
}

/**
 * Measured link quality, not reported link quality.
 *
 * `navigator.connection` describes the browser's guess about the radio; it says
 * nothing about whether Firebase in asia-southeast1 is answering. Both are
 * shown, because a "4g" badge next to a 900ms round trip is the single most
 * useful thing this panel can tell you when someone says the game feels slow.
 */
export function useNetworkHealth(enabled: boolean, uid: string, periodMs = 15_000): NetworkHealth {
  const [health, setHealth] = useState<NetworkHealth>({
    rtdbRttMs: null,
    firestoreRttMs: null,
    clockSkewMs: null,
    rtdbConnected: false,
    effectiveType: "unknown",
    downlinkMbps: null,
    rttMs: null,
    online: true,
    lastProbeAt: 0,
  });
  const busy = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const unsubConnected = onValue(ref(rtdb, ".info/connected"), (snap) => {
      setHealth((h) => ({ ...h, rtdbConnected: snap.val() === true }));
    });
    const unsubOffset = onValue(ref(rtdb, ".info/serverTimeOffset"), (snap) => {
      const offset = Number(snap.val());
      setHealth((h) => ({ ...h, clockSkewMs: Number.isFinite(offset) ? Math.round(offset) : null }));
    });

    const probe = async () => {
      if (busy.current) return;
      busy.current = true;
      const nav = navigator as Navigator & {
        connection?: { effectiveType?: string; downlink?: number; rtt?: number };
      };

      let rtdbRttMs: number | null = null;
      try {
        // A read, not a write. Writing a probe value would mean either
        // inventing a path the presence rules reject or overwriting this
        // admin's own live presence node, and a read measures the same link.
        // The admin's own presence node is used because it is a real server
        // round trip that the rules already allow this account to make.
        const started = performance.now();
        await get(ref(rtdb, `presence/users/${uid}`));
        rtdbRttMs = Math.round(performance.now() - started);
      } catch {
        rtdbRttMs = null;
      }

      let firestoreRttMs: number | null = null;
      try {
        const started = performance.now();
        await getDocs(query(collection(db, "bugReports"), qLimit(1)));
        firestoreRttMs = Math.round(performance.now() - started);
      } catch {
        firestoreRttMs = null;
      }

      setHealth((h) => ({
        ...h,
        rtdbRttMs,
        firestoreRttMs,
        effectiveType: nav.connection?.effectiveType ?? "unknown",
        downlinkMbps: typeof nav.connection?.downlink === "number" ? nav.connection.downlink : null,
        rttMs: typeof nav.connection?.rtt === "number" ? nav.connection.rtt : null,
        online: navigator.onLine,
        lastProbeAt: Date.now(),
      }));
      busy.current = false;
    };

    void probe();
    const timer = setInterval(probe, periodMs);
    return () => {
      clearInterval(timer);
      unsubConnected();
      unsubOffset();
    };
  }, [enabled, uid, periodMs]);

  return health;
}

/** Rough byte size of a document, for the storage estimate. */
export function estimateDocBytes(value: unknown): number {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    return 0;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function timeAgo(ts: Timestamp | null | undefined): string {
  if (!ts) return "—";
  const then = ts.toMillis?.() ?? 0;
  if (!then) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * How much is waiting on you, as one number.
 *
 * Weighted by severity rather than a plain open count, because twelve cosmetic
 * reports and one crash are not the same afternoon.
 */
export function workloadScore(open: { severity: string }[]): number {
  const weight: Record<string, number> = { critical: 8, high: 4, medium: 2, low: 1 };
  return open.reduce((total, r) => total + (weight[r.severity] ?? 1), 0);
}

/** Age of the oldest item in a list of dated things, in hours. */
export function oldestAgeHours(items: { createdAt: Timestamp | null }[]): number | null {
  const times = items
    .map((i) => i.createdAt?.toMillis?.() ?? 0)
    .filter((t) => t > 0);
  if (times.length === 0) return null;
  return Math.round((Date.now() - Math.min(...times)) / 3_600_000);
}

/** Per-game rollup for the games panel. */
export function useGameRollup(users: AdminUser[], lobbies: LiveLobby[]) {
  return useMemo(() => {
    const coinsByGame = new Map<string, number>();
    const playersByGame = new Map<string, number>();
    for (const u of users) {
      for (const [gameId, amount] of Object.entries(u.coins ?? {})) {
        coinsByGame.set(gameId, (coinsByGame.get(gameId) ?? 0) + Number(amount ?? 0));
        playersByGame.set(gameId, (playersByGame.get(gameId) ?? 0) + 1);
      }
    }
    const roomsByGame = new Map<string, number>();
    for (const l of lobbies) {
      if (!l.gameId) continue;
      roomsByGame.set(l.gameId, (roomsByGame.get(l.gameId) ?? 0) + 1);
    }
    return { coinsByGame, playersByGame, roomsByGame };
  }, [users, lobbies]);
}
