import { deleteDoc, doc, increment, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

/**
 * Writes an admin makes that reach outside the bug queue: grants, coin
 * corrections, closing a stuck room.
 *
 * Every function here assumes the caller already passed `isAdmin()` , that
 * assumption is not decoration, it is enforced again at the only place it can
 * actually matter: firestore.rules refuses every one of these writes for a
 * non-admin token regardless of what this file lets you call.
 */

/** The grant badges an admin can hand out or take back by hand. */
export async function setGrant(
  uid: string,
  key: "premium" | "tester" | "testerPlus",
  value: boolean,
): Promise<void> {
  await setDoc(doc(db, "users", uid), { grants: { [key]: value } }, { merge: true });
}

/**
 * Adjust one player's balance in one game by a signed amount.
 *
 * `increment()` rather than a read-then-write: two admins correcting the same
 * player at once should both land, not have the second overwrite the first's
 * read of a now-stale balance.
 */
export async function adjustCoins(uid: string, gameId: string, delta: number): Promise<void> {
  if (!Number.isFinite(delta) || delta === 0) return;
  await setDoc(
    doc(db, "users", uid),
    { coins: { [gameId]: increment(Math.round(delta)) } },
    { merge: true },
  );
}

/**
 * Close a room outright.
 *
 * Ordinary deletion is host-only, which is correct for a normal end-of-match
 * cleanup , the point of this one is the case that isn't ordinary: a host who
 * disconnected and never came back, leaving a room that nobody left in it can
 * close. `canClaimHost()` in the rules exists for the same failure and takes
 * 30 seconds of quiet before it fires; this is the admin's way to not wait.
 */
export async function closeRoom(roomId: string): Promise<void> {
  await deleteDoc(doc(db, "lobbies", roomId));
}
