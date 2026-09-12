"use client";

import { useEffect, useMemo, useState } from "react";
import { onDisconnect, onValue, push, ref, remove, set } from "firebase/database";
import { rtdb } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";

const EMPTY: ReadonlySet<string> = new Set();

export function hasConnections(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && Object.values(value as Record<string, unknown>).some((v) => v === true));
}

/** Each open tab receives an independent child node. */
function registerConnection(path: string) {
  const connection = push(ref(rtdb, path));
  const connected = ref(rtdb, ".info/connected");
  let disposed = false;
  const unsubscribe = onValue(connected, async (snap) => {
    if (snap.val() !== true || disposed) return;
    try {
      await onDisconnect(connection).remove();
      if (!disposed) await set(connection, true);
    } catch (error) {
      console.error("presence registration failed", error);
    }
  });
  return () => {
    disposed = true;
    unsubscribe();
    onDisconnect(connection).cancel().catch(() => {});
    remove(connection).catch(() => {});
  };
}

export function useOnlinePresence() {
  const user = useAuthStore((s) => s.user);
  useEffect(() => {
    if (!user) return;
    return registerConnection(`presenceSessions/users/${user.uid}`);
  }, [user]);
}

export function useLobbyPresence(roomId: string): Set<string> {
  const user = useAuthStore((s) => s.user);
  const [online, setOnline] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!user || !roomId) return;
    const stopConnection = registerConnection(`presenceSessions/lobbies/${roomId}/${user.uid}`);
    const unsubscribe = onValue(ref(rtdb, `presenceSessions/lobbies/${roomId}`), (snap) => {
      const users = snap.val() as Record<string, unknown> | null;
      setOnline(new Set(Object.entries(users || {}).filter(([, sessions]) => hasConnections(sessions)).map(([uid]) => uid)));
    }, (error) => console.error("lobby presence read failed", error));
    return () => { unsubscribe(); stopConnection(); };
  }, [user, roomId]);
  return user && roomId ? online : (EMPTY as Set<string>);
}

export function useFriendsOnline(friendUids: string[]): Set<string> {
  const [onlineUids, setOnlineUids] = useState<Set<string>>(() => new Set());
  const key = useMemo(() => friendUids.slice().sort().join(","), [friendUids]);
  useEffect(() => {
    if (!key) return;
    const live = new Set<string>();
    let frame: number | null = null;
    const flush = () => { frame = null; setOnlineUids(new Set(live)); };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(flush); };
    const unsubs = key.split(",").map((uid) => onValue(ref(rtdb, `presenceSessions/users/${uid}`), (snap) => {
      if (hasConnections(snap.val())) live.add(uid); else live.delete(uid);
      schedule();
    }, (error) => console.error("presence read failed", error)));
    return () => { if (frame !== null) cancelAnimationFrame(frame); unsubs.forEach((unsub) => unsub()); };
  }, [key]);
  return key ? onlineUids : (EMPTY as Set<string>);
}
