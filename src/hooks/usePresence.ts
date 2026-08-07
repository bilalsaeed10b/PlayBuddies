"use client";

import { useEffect, useMemo, useState } from "react";
import { onDisconnect, onValue, ref, remove, serverTimestamp, set } from "firebase/database";
import { rtdb } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";

/**
 * Presence lives in Realtime Database rather than Firestore because RTDB is the
 * only Firebase product with `onDisconnect`, so a closed tab or dropped network
 * clears the flag server-side without anyone having to poll for it.
 *
 * Every hook here waits on `.info/connected` before arming its onDisconnect —
 * registering it before the socket is up means it is silently discarded, which
 * is one reason the previous presence code never worked.
 */

/** Marks the signed-in user online globally. Mount once, high in the tree. */
export function useOnlinePresence() {
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (!user) return;

    const myRef = ref(rtdb, `presence/users/${user.uid}`);
    const connectedRef = ref(rtdb, ".info/connected");

    const unsub = onValue(connectedRef, (snap) => {
      if (snap.val() !== true) return;
      // Re-arm on every reconnect; a fired onDisconnect does not persist.
      onDisconnect(myRef)
        .remove()
        .then(() => set(myRef, { online: true, at: serverTimestamp() }))
        .catch((e) => console.error("presence registration failed", e));
    });

    return () => {
      unsub();
      remove(myRef).catch(() => {});
    };
  }, [user]);
}

const EMPTY: ReadonlySet<string> = new Set();

/** UIDs currently present in a lobby. Also publishes this user's own presence. */
export function useLobbyPresence(roomId: string): Set<string> {
  const user = useAuthStore((s) => s.user);
  const [online, setOnline] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!user || !roomId) return;

    const myRef = ref(rtdb, `presence/lobbies/${roomId}/${user.uid}`);
    const roomRef = ref(rtdb, `presence/lobbies/${roomId}`);
    const connectedRef = ref(rtdb, ".info/connected");

    const unsubConnected = onValue(connectedRef, (snap) => {
      if (snap.val() !== true) return;
      onDisconnect(myRef)
        .remove()
        .then(() => set(myRef, true))
        .catch((e) => console.error("lobby presence registration failed", e));
    });

    const unsubRoom = onValue(
      roomRef,
      (snap) => setOnline(new Set(Object.keys(snap.val() || {}))),
      (e) => console.error("lobby presence read failed", e),
    );

    return () => {
      unsubConnected();
      unsubRoom();
      remove(myRef).catch(() => {});
    };
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
 * client downloaded the entire online-user set — and re-downloaded it whenever
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
        ref(rtdb, `presence/users/${uid}/online`),
        (snap) => {
          if (snap.val() === true) live.add(uid);
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
