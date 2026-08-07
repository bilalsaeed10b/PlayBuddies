"use client";

import { useEffect, useState } from "react";
import {
  collection,
  documentId,
  getDocs,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";

export interface FriendProfile {
  uid: string;
  displayName: string;
  photoURL: string;
  friendCode?: string;
  connId: string;
}

interface FriendsState {
  friends: FriendProfile[];
  requests: FriendProfile[];
  loading: boolean;
}

/** Firestore caps `in` queries at 30 values, so profiles are fetched in chunks. */
const IN_QUERY_LIMIT = 30;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Live friends + incoming requests for the signed-in user.
 *
 * Replaces the previous per-connection `getDoc` loop, which issued one
 * sequential round trip per friend on every snapshot and had no cancellation,
 * so a slow earlier response could overwrite a newer one. Profiles are now
 * batched, fetched in parallel, and stale responses are discarded.
 *
 * Pass `enabled: false` to keep the listener closed — used so pages that don't
 * show friends don't hold an open subscription.
 */
export function useFriends(enabled = true): FriendsState {
  const user = useAuthStore((s) => s.user);
  const [state, setState] = useState<FriendsState>(() => ({
    friends: [],
    requests: [],
    loading: true,
  }));

  useEffect(() => {
    if (!user || !enabled) return;

    let generation = 0;
    let active = true;

    const q = query(
      collection(db, "connections"),
      where("participants", "array-contains", user.uid),
    );

    const unsub = onSnapshot(
      q,
      async (snap) => {
        const mine = ++generation;

        const links = snap.docs
          .map((d) => {
            const data = d.data();
            const otherUid = (data.participants as string[]).find((p) => p !== user.uid);
            return otherUid
              ? { otherUid, connId: d.id, status: data.status, senderId: data.senderId }
              : null;
          })
          .filter((l): l is NonNullable<typeof l> => l !== null);

        if (links.length === 0) {
          if (active && mine === generation) {
            setState({ friends: [], requests: [], loading: false });
          }
          return;
        }

        try {
          const uids = [...new Set(links.map((l) => l.otherUid))];
          const batches = await Promise.all(
            chunk(uids, IN_QUERY_LIMIT).map((ids) =>
              getDocs(query(collection(db, "users"), where(documentId(), "in", ids))),
            ),
          );

          // A newer snapshot landed while these were in flight — drop this result.
          if (!active || mine !== generation) return;

          const profiles = new Map<string, Record<string, unknown>>();
          for (const b of batches) {
            for (const d of b.docs) profiles.set(d.id, d.data());
          }

          const friends: FriendProfile[] = [];
          const requests: FriendProfile[] = [];

          for (const link of links) {
            const p = profiles.get(link.otherUid);
            if (!p) continue;
            const entry: FriendProfile = {
              uid: link.otherUid,
              displayName: (p.displayName as string) || "Player",
              photoURL: (p.photoURL as string) || "",
              friendCode: p.friendCode as string | undefined,
              connId: link.connId,
            };
            if (link.status === "accepted") friends.push(entry);
            else if (link.status === "pending" && link.senderId !== user.uid) requests.push(entry);
          }

          friends.sort((a, b) => a.displayName.localeCompare(b.displayName));
          setState({ friends, requests, loading: false });
        } catch (err) {
          console.error("Failed to load friend profiles", err);
          if (active && mine === generation) {
            setState((s) => ({ ...s, loading: false }));
          }
        }
      },
      (err) => {
        console.error("Friends listener failed", err);
        if (active) setState((s) => ({ ...s, loading: false }));
      },
    );

    return () => {
      active = false;
      unsub();
    };
  }, [user, enabled]);

  // Derived so a signed-out or disabled hook reports empty immediately.
  return user && enabled ? state : IDLE;
}

const IDLE: FriendsState = { friends: [], requests: [], loading: false };
