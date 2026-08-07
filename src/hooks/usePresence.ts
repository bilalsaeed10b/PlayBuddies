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
 * How many of the given friends are online right now.
 *
 * Reads the whole presence/users map once and filters client-side. That is fine
 * at this scale and costs one listener; if the user base grows past a few
 * thousand concurrent, switch to per-friend listeners or a server-side fanout.
 */
export function useFriendsOnline(friendUids: string[]): Set<string> {
  const [onlineUids, setOnlineUids] = useState<Set<string>>(() => new Set());
  const key = useMemo(() => friendUids.slice().sort().join(","), [friendUids]);

  useEffect(() => {
    if (!key) return;
    const wanted = new Set(key.split(","));
    const unsub = onValue(
      ref(rtdb, "presence/users"),
      (snap) => {
        const all = snap.val() || {};
        setOnlineUids(new Set(Object.keys(all).filter((uid) => wanted.has(uid))));
      },
      (e) => console.error("friend presence read failed", e),
    );
    return () => unsub();
  }, [key]);

  return key ? onlineUids : (EMPTY as Set<string>);
}
