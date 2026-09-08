"use client";

import { useEffect, useState } from "react";
import { collection, documentId, getDocs, limit, onSnapshot, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import type { FriendProfile } from "@/hooks/useFriends";

/**
 * Incoming (not yet accepted) friend requests, live, for the whole app —
 * not just while the friends panel happens to be open.
 *
 * `useFriends` deliberately keeps its listener closed unless a page asks for
 * it, which is right for the friends *list* but wrong for requests: a badge
 * that only updates once you've already opened the panel can never tell you
 * a request arrived in the first place. This is the always-on, request-only
 * counterpart that the launcher badge and the incoming-request toast both
 * read from.
 */
export function useFriendRequests(): FriendProfile[] {
  const user = useAuthStore((s) => s.user);
  const [requests, setRequests] = useState<FriendProfile[]>([]);

  useEffect(() => {
    if (!user) {
      setRequests([]);
      return;
    }

    let generation = 0;
    let active = true;

    const q = query(collection(db, "connections"), where("participants", "array-contains", user.uid));

    const unsub = onSnapshot(
      q,
      async (snap) => {
        const mine = ++generation;

        const incoming = snap.docs
          .map((d) => {
            const data = d.data();
            if (data.status !== "pending" || data.senderId === user.uid) return null;
            const otherUid = (data.participants as string[]).find((p) => p !== user.uid);
            return otherUid ? { otherUid, connId: d.id } : null;
          })
          .filter((l): l is NonNullable<typeof l> => l !== null);

        if (incoming.length === 0) {
          if (active && mine === generation) setRequests([]);
          return;
        }

        try {
          const uids = [...new Set(incoming.map((l) => l.otherUid))];
          const profileSnap = await getDocs(
            query(collection(db, "profiles"), where(documentId(), "in", uids), limit(uids.length)),
          );
          if (!active || mine !== generation) return;

          const profiles = new Map<string, Record<string, unknown>>();
          for (const d of profileSnap.docs) profiles.set(d.id, d.data());

          const next: FriendProfile[] = incoming
            .map((l): FriendProfile | null => {
              const p = profiles.get(l.otherUid);
              if (!p) return null;
              return {
                uid: l.otherUid,
                displayName: (p.displayName as string) || "Player",
                photoURL: (p.photoURL as string) || "",
                friendCode: p.friendCode as string | undefined,
                connId: l.connId,
              };
            })
            .filter((r): r is FriendProfile => r !== null);

          setRequests(next);
        } catch (err) {
          console.error("Failed to load friend request profiles", err);
        }
      },
      (err) => console.error("Friend requests listener failed", err),
    );

    return () => {
      active = false;
      unsub();
    };
  }, [user]);

  return user ? requests : EMPTY;
}

const EMPTY: FriendProfile[] = [];
