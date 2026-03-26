
"use client";

import { useEffect } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";

export default function AuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { setUser, setLoading } = useAuthStore();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        // Create or update user profile in Firestore
        const userRef = doc(db, "users", user.uid);
        try {
          const userSnap = await getDoc(userRef);
          if (!userSnap.exists()) {
            await setDoc(userRef, {
              uid: user.uid,
              displayName: user.displayName,
              email: user.email,
              photoURL: user.photoURL,
              createdAt: serverTimestamp(),
              lastLogin: serverTimestamp(),
              status: "online",
              stats: {
                friendsOnline: 0,
                gamesPlayed: 0,
                wins: 0,
              }
            });
          } else {
            await setDoc(
              userRef,
              {
                lastLogin: serverTimestamp(),
                status: "online",
                displayName: user.displayName, // Update info if changed
                photoURL: user.photoURL,
              },
              { merge: true }
            );
          }
        } catch (error) {
          console.error("Error setting user document:", error);
        }
      }

      setUser(user);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [setUser, setLoading]);

  return <>{children}</>;
}

