"use client";

import { useEffect } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { generateFriendCode } from "@/lib/rooms";
import { useOnlinePresence } from "@/hooks/usePresence";

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const setUser = useAuthStore((s) => s.setUser);
  const setLoading = useAuthStore((s) => s.setLoading);

  // Publishes this user's online flag for the whole session.
  useOnlinePresence();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setUser(null);
        setLoading(false);
        return;
      }

      const userRef = doc(db, "users", user.uid);
      try {
        const userSnap = await getDoc(userRef);

        if (!userSnap.exists()) {
          await setDoc(userRef, {
            uid: user.uid,
            displayName: user.displayName,
            email: user.email,
            photoURL: user.photoURL,
            friendCode: generateFriendCode(),
            searchableName: user.displayName?.toLowerCase() || "",
            createdAt: serverTimestamp(),
            lastLogin: serverTimestamp(),
            stats: { gamesPlayed: 0, wins: 0 },
          });
        } else {
          // Only write when something actually changed — this runs on every
          // page load, and an unconditional write would cost a write per visit.
          const data = userSnap.data();
          const lastLoginStamp = data.lastLogin?.toMillis?.() || 0;
          const needsCode = !data.friendCode || data.friendCode.length !== 8;
          const shouldUpdate =
            Date.now() - lastLoginStamp > 24 * 60 * 60 * 1000 ||
            data.displayName !== user.displayName ||
            data.photoURL !== user.photoURL ||
            needsCode;

          if (shouldUpdate) {
            await setDoc(
              userRef,
              {
                lastLogin: serverTimestamp(),
                displayName: user.displayName,
                searchableName: user.displayName?.toLowerCase() || "",
                photoURL: user.photoURL,
                ...(needsCode ? { friendCode: generateFriendCode() } : {}),
              },
              { merge: true },
            );
          }
        }
      } catch (error) {
        // A profile write failure shouldn't block sign-in.
        console.error("Error setting user document:", error);
      }

      setUser(user);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [setUser, setLoading]);

  return <>{children}</>;
}
