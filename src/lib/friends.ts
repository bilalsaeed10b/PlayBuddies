/** Friend lookup and request logic shared by the friends panel and the lobby. */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { FRIEND_CODE_LENGTH } from "@/lib/rooms";

export { FRIEND_CODE_LENGTH };

export interface CodeMatch {
  uid: string;
  displayName: string;
  photoURL: string;
  friendCode: string;
}

/**
 * Looks up public profiles by their friend code, excluding the caller.
 *
 * Searches `/profiles`, which by design holds no email or stats, and states an
 * explicit limit — the security rules reject profile queries that don't bound
 * themselves.
 */
export async function findByFriendCode(code: string, selfUid: string): Promise<CodeMatch[]> {
  const snap = await getDocs(
    query(collection(db, "profiles"), where("friendCode", "==", code), limit(5)),
  );
  return snap.docs
    .map((d) => {
      const data = d.data();
      return {
        uid: d.id,
        displayName: (data.displayName as string) || "Player",
        photoURL: (data.photoURL as string) || "",
        friendCode: data.friendCode as string,
      };
    })
    .filter((p) => p.uid !== selfUid);
}

export type FriendRequestOutcome = "sent" | "already-friends" | "already-pending" | "error";

/**
 * Sends a friend request, guarding against clobbering an existing link — a
 * plain `setDoc` would reset an already-accepted friendship back to
 * "pending", and re-sending a pending one is a wasted write that looks to the
 * sender like nothing happened.
 */
export async function sendFriendRequest(myUid: string, targetUid: string): Promise<FriendRequestOutcome> {
  const connId = [myUid, targetUid].sort().join("_");
  const ref = doc(db, "connections", connId);
  try {
    const existing = await getDoc(ref);
    if (existing.exists()) {
      return existing.data().status === "accepted" ? "already-friends" : "already-pending";
    }
    await setDoc(ref, {
      participants: [myUid, targetUid].sort(),
      status: "pending",
      senderId: myUid,
      createdAt: serverTimestamp(),
    });
    return "sent";
  } catch (e) {
    console.error("Could not send friend request", e);
    return "error";
  }
}
