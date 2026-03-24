
"use client";

import { useEffect } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db, rtdb } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { ref, set, onDisconnect, serverTimestamp as rtdbTimestamp } from "firebase/database";

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
          
          let generatedFriendCode = "";
          if (!userSnap.exists() || !userSnap.data().friendCode) {
            const array = new Uint32Array(2);
            crypto.getRandomValues(array);
            generatedFriendCode = (array[0].toString(36) + array[1].toString(36)).substring(0, 8).toUpperCase();
          }

          if (!userSnap.exists()) {
              await setDoc(userRef, {
                uid: user.uid,
                displayName: user.displayName,
                friendCode: generatedFriendCode,
                searchableName: user.displayName?.toLowerCase() || "",
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
              const data = userSnap.data();
              const lastLoginStamp = data.lastLogin?.toMillis?.() || 0;
              const now = Date.now();
              const shouldUpdate = 
                now - lastLoginStamp > 24 * 60 * 60 * 1000 || 
                data.displayName !== user.displayName || 
                data.photoURL !== user.photoURL ||
                !data.friendCode;

              if (shouldUpdate) {
                await setDoc(
                  userRef,
                  {
                    lastLogin: serverTimestamp(),
                    status: "online",
                    displayName: user.displayName, 
                    searchableName: user.displayName?.toLowerCase() || "",
                    photoURL: user.photoURL,
                    ...(generatedFriendCode ? { friendCode: generatedFriendCode } : {}),
                  },
                  { merge: true }
                );
              }
            }

            // Bind Global RTDB Presence
            const statusRef = ref(rtdb, `status/${user.uid}`);
            onDisconnect(statusRef).set({ state: "offline", last_changed: rtdbTimestamp() }).then(() => {
              set(statusRef, { state: "online", last_changed: rtdbTimestamp() });
            });
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

