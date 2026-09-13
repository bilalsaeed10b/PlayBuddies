"use client";

import { useEffect, useMemo, useState } from "react";
import { onDisconnect, onValue, push, ref, remove, set } from "firebase/database";
import { rtdb } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import { hasConnections } from "@/lib/presence";

/** Registers one connection per hook, including each tab and device. */
function registerConnection(path: string) {
  const connection = push(ref(rtdb, path));
  const disconnect = onDisconnect(connection);
  let disposed = false;
  const unsub = onValue(ref(rtdb, ".info/connected"), (snap) => {
    if (snap.val() !== true || disposed) return;
    void disconnect.remove().then(async () => {
      if (disposed) { await disconnect.cancel(); return; }
      await set(connection, true);
      if (disposed) await remove(connection);
    }).catch((error) => console.error("Presence registration failed", error));
  });
  return () => {
    disposed = true;
    unsub();
    // Remove just this tab, never another tab's or device's connection.
    void remove(connection).then(() => disconnect.cancel()).catch(() => {});
  };
}

/** Marks the signed-in user online globally. Mount once, high in the tree. */
export function useOnlinePresence() {
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (!user) return;

    return registerConnection(`presenceSessions/users/${user.uid}`);
  }, [user]);
}

const EMPTY: ReadonlySet<string> = new Set();

/** UIDs currently present in a lobby. Also publishes this user's own presence. */
export function useLobbyPresence(roomId: string): Set<string> {
  const user = useAuthStore((s) => s.user);
  const [online, setOnline] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!user || !roomId) return;

    const close = registerConnection(`presenceSessions/lobbies/${roomId}/${user.uid}`);
    const unsubRoom = onValue(
      ref(rtdb, `presenceSessions/lobbies/${roomId}`),
      (snap) => setOnline(new Set(Object.entries(snap.val() || {})
        .filter(([, connections]) => hasConnections(connections)).map(([uid]) => uid))),
      (error) => console.error("Lobby presence read failed", error),
    );
    return () => { unsubRoom(); close(); };
  }, [user, roomId]);

  // Derived rather than written from the effect, so signing out or leaving a
  // room clears the roster without an extra render pass.
  return user && roomId ? online : (EMPTY as Set<string>);
}

/**
 * Which of the given friends are online right now.
 *
 * One listener per friend, on that friend's own node. The earlier version
 * subscribed to all of `presence/users` and filtered locally, which meant every
 * client downloaded the entire online-user set , and re-downloaded it whenever
 * anyone anywhere on the platform connected or disconnected. That cost grows
 * with total traffic rather than with your friend count, and it is also why the
 * database rules no longer expose `presence/users` as a readable whole.
 */
export function useFriendsOnline(friendUids: string[]): Set<string> {
  const [onlineUids, setOnlineUids] = useState<Set<string>>(() => new Set());
  const key = useMemo(() => friendUids.slice().sort().join(","), [friendUids]);

  useEffect(() => {
    if (!key) return;
    const uids = key.split(",");

    // Accumulated outside state so N callbacks don't cause N renders.
    const live = new Set<string>();
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      setOnlineUids(new Set(live));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(flush);
    };

    const unsubs = uids.map((uid) =>
      onValue(
        ref(rtdb, `presenceSessions/users/${uid}`),
        (snap) => {
          if (hasConnections(snap.val())) live.add(uid);
          else live.delete(uid);
          schedule();
        },
        (e) => console.error(`presence read failed for ${uid}`, e),
      ),
    );

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      unsubs.forEach((u) => u());
    };
  }, [key]);

  return key ? onlineUids : (EMPTY as Set<string>);
}
