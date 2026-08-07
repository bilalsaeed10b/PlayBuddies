"use client";

import { useEffect } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { generateFriendCode } from "@/lib/rooms";
import { useOnlinePresence } from "@/hooks/usePresence";

const SYNC_TTL_MS = 24 * 60 * 60 * 1000;
const syncKey = (uid: string) => `pb_profile_sync_v1_${uid}`;

/**
 * Records that this browser has already reconciled the signed-in user's
 * documents, so a repeat visit costs no Firestore reads or writes at all.
 *
 * The cached fingerprint includes name and photo, so a Google profile change
 * still triggers a resync. Worst case the cache is wrong and the profile is a
 * day stale — cheap, and self-correcting.
 */
function isSyncFresh(uid: string, fingerprint: string): boolean {
  try {
    const raw = localStorage.getItem(syncKey(uid));
    if (!raw) return false;
    const { at, fp } = JSON.parse(raw);
    return fp === fingerprint && Date.now() - at < SYNC_TTL_MS;
  } catch {
    return false;
  }
}

function markSynced(uid: string, fingerprint: string) {
  try {
    localStorage.setItem(syncKey(uid), JSON.stringify({ at: Date.now(), fp: fingerprint }));
  } catch {
    /* private mode — we just resync next load */
  }
}

/**
 * Reconciles the two documents backing a user:
 *   users/{uid}    private — email, stats. Readable only by its owner.
 *   profiles/{uid} public  — name, photo, friend code. Readable by everyone.
 *
 * They are split because `allow read` in Firestore also grants `list`: with the
 * email sitting on a broadly-readable document, one query would have returned
 * every user's email address.
 */
async function syncUserDocuments(user: User) {
  const profileRef = doc(db, "profiles", user.uid);
  const profileSnap = await getDoc(profileRef);

  let friendCode: string | undefined = profileSnap.data()?.friendCode;

  if (!friendCode || friendCode.length !== 8) {
    // Carry over a code from before the profile split so existing friend codes
    // keep working, rather than silently reissuing one.
    try {
      const legacy = await getDoc(doc(db, "users", user.uid));
      const legacyCode = legacy.data()?.friendCode;
      friendCode = legacyCode && legacyCode.length === 8 ? legacyCode : generateFriendCode();
    } catch {
      friendCode = generateFriendCode();
    }
  }

  await setDoc(
    profileRef,
    {
      uid: user.uid,
      displayName: (user.displayName || "Player").slice(0, 60),
      photoURL: (user.photoURL || "").slice(0, 500),
      friendCode,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  await setDoc(
    doc(db, "users", user.uid),
    {
      uid: user.uid,
      email: user.email,
      lastLogin: serverTimestamp(),
      ...(profileSnap.exists() ? {} : { createdAt: serverTimestamp(), stats: { gamesPlayed: 0, wins: 0 } }),
    },
    { merge: true },
  );
}

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const setUser = useAuthStore((s) => s.setUser);
  const setLoading = useAuthStore((s) => s.setLoading);

  useOnlinePresence();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setUser(null);
        setLoading(false);
        return;
      }

      // Show the app immediately; document reconciliation is not on the
      // critical path and must never block sign-in.
      setUser(user);
      setLoading(false);

      const fingerprint = `${user.displayName ?? ""}|${user.photoURL ?? ""}`;
      if (isSyncFresh(user.uid, fingerprint)) return;

      try {
        await syncUserDocuments(user);
        markSynced(user.uid, fingerprint);
      } catch (error) {
        console.error("Could not sync user documents:", error);
      }
    });

    return () => unsubscribe();
  }, [setUser, setLoading]);

  return <>{children}</>;
}
