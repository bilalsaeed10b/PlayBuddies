import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  increment,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { BADGES_BY_ID, type GrantKey } from "@/lib/badges";
import { INBOX_BODY_MAX, INBOX_TITLE_MAX, sendInboxMessage } from "@/lib/inbox";
import { getGame } from "@/lib/games";

/**
 * Writes an admin makes that reach outside the bug queue: grants, coin
 * corrections, closing a stuck room.
 *
 * Every function here assumes the caller already passed `isAdmin()` , that
 * assumption is not decoration, it is enforced again at the only place it can
 * actually matter: firestore.rules refuses every one of these writes for a
 * non-admin token regardless of what this file lets you call.
 *
 * Anything a player would want to know about lands in their inbox, and those
 * sends are deliberately best-effort: a grant that succeeded and a
 * notification that did not is still a grant, and failing the whole action
 * would invite an admin to hand out the same reward twice.
 */

/** Which badge each grant key unlocks, for the message the player receives. */
const BADGE_FOR_GRANT: Record<GrantKey, string> = {
  premium: "premium",
  tester: "tester",
  testerPlus: "tester_plus",
};

/**
 * Hand out or take back one of the grant badges.
 *
 * A grant unlocks a badge; it does not put it on. What a player wears is
 * `profiles/{uid}.badge`, which only they can write , so this is a gift, and
 * the choice to display it stays with the person wearing it.
 */
export async function setGrant(uid: string, key: GrantKey, value: boolean): Promise<void> {
  await setDoc(doc(db, "users", uid), { grants: { [key]: value } }, { merge: true });

  if (!value) return;
  const badge = BADGES_BY_ID[BADGE_FOR_GRANT[key]];
  if (!badge) return;
  try {
    await sendInboxMessage(uid, {
      kind: "badge",
      title: `${badge.label} unlocked`,
      body: `You have been given the ${badge.label} badge. Put it on from your profile whenever you like , it is yours either way.`,
      badgeId: badge.id,
    });
  } catch (e) {
    console.error("Grant landed but the inbox message did not", e);
  }
}

/**
 * Adjust one player's balance in one game by a signed amount.
 *
 * `increment()` rather than a read-then-write: two admins correcting the same
 * player at once should both land, not have the second overwrite the first's
 * read of a now-stale balance.
 */
export async function adjustCoins(
  uid: string,
  gameId: string,
  delta: number,
  reason = "",
): Promise<void> {
  if (!Number.isFinite(delta) || delta === 0) return;
  const amount = Math.round(delta);
  await setDoc(
    doc(db, "users", uid),
    { coins: { [gameId]: increment(amount) } },
    { merge: true },
  );

  const game = getGame(gameId)?.name ?? gameId;
  try {
    await sendInboxMessage(uid, {
      kind: "coins",
      title: amount > 0 ? `+${amount} coins in ${game}` : `${amount} coins in ${game}`,
      body:
        reason.trim() ||
        (amount > 0
          ? `An admin added ${amount} coins to your ${game} purse.`
          : `An admin adjusted your ${game} purse by ${amount} coins.`),
      amount,
      gameId,
    });
  } catch (e) {
    console.error("Coins landed but the inbox message did not", e);
  }
}

/**
 * Adjust a player's gem balance by a signed amount.
 *
 * This is the only way gems arrive other than a daily challenge, and it is
 * deliberate that it is an admin's hand: until real payments run through a
 * server that can confirm them, a purchase made some other way is credited
 * here. The rules let a player's own client add gems two at a time against a
 * completed challenge and nothing else.
 */
export async function adjustGems(uid: string, delta: number, reason = ""): Promise<void> {
  if (!Number.isFinite(delta) || delta === 0) return;
  const amount = Math.round(delta);
  await setDoc(doc(db, "users", uid), { gems: increment(amount) }, { merge: true });

  try {
    await sendInboxMessage(uid, {
      kind: "gems",
      title: amount > 0 ? `+${amount} gems` : `${amount} gems`,
      body:
        reason.trim() ||
        (amount > 0 ? `An admin added ${amount} gems to your account.` : `An admin adjusted your gems by ${amount}.`),
      amount,
    });
  } catch (e) {
    console.error("Gems landed but the inbox message did not", e);
  }
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

/**
 * Delete a batch of abandoned rooms in one go.
 *
 * Nothing in the app has ever deleted a lobby document, so these accumulate
 * for the life of the project , a few hundred rooms whose players closed the
 * tab days ago, every one of them still read on every admin page load. The
 * caller decides which ids are stale (see `isRoomLive`); this only carries
 * them out, 400 at a time, which is inside Firestore's 500-write batch limit.
 */
export async function purgeRooms(roomIds: string[]): Promise<number> {
  let done = 0;
  for (let i = 0; i < roomIds.length; i += 400) {
    const slice = roomIds.slice(i, i + 400);
    const batch = writeBatch(db);
    for (const id of slice) batch.delete(doc(db, "lobbies", id));
    await batch.commit();
    done += slice.length;
  }
  return done;
}

// -- whole-platform actions ----------------------------------------------------

/** Firestore's batch limit is 500 writes; stay well inside it. */
const BATCH = 400;

/**
 * One message into every listed player's inbox.
 *
 * A write per player, so the panel shows the count before it is sent; on the
 * free plan a few thousand of these is a real share of the day's 20k writes.
 */
export async function broadcastInbox(
  uids: string[],
  message: { title: string; body: string },
): Promise<number> {
  let sent = 0;
  for (let i = 0; i < uids.length; i += BATCH) {
    const batch = writeBatch(db);
    for (const uid of uids.slice(i, i + BATCH)) {
      batch.set(doc(collection(db, "users", uid, "inbox")), {
        kind: "note",
        title: message.title.slice(0, INBOX_TITLE_MAX),
        body: message.body.slice(0, INBOX_BODY_MAX),
        amount: null,
        gameId: "",
        badgeId: "",
        read: false,
        createdAt: serverTimestamp(),
      });
    }
    await batch.commit();
    sent += Math.min(BATCH, uids.length - i);
  }
  return sent;
}

/**
 * The same reward for everyone listed: gems, or coins in one game, plus the
 * inbox note that says why. Two writes a player, batched.
 */
export async function rewardEveryone(
  uids: string[],
  reward: { kind: "gems" } | { kind: "coins"; gameId: string },
  amount: number,
  reason: string,
): Promise<number> {
  const n = Math.round(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const game = reward.kind === "coins" ? getGame(reward.gameId)?.name ?? reward.gameId : "";
  const title = reward.kind === "gems" ? `+${n} gems` : `+${n} coins in ${game}`;
  const body = reason.trim() || (reward.kind === "gems" ? `A gift of ${n} gems for everyone.` : `A gift of ${n} coins for everyone.`);
  const per = 2;
  const step = Math.floor(BATCH / per);
  let done = 0;
  for (let i = 0; i < uids.length; i += step) {
    const batch = writeBatch(db);
    for (const uid of uids.slice(i, i + step)) {
      batch.set(
        doc(db, "users", uid),
        reward.kind === "gems" ? { gems: increment(n) } : { coins: { [reward.gameId]: increment(n) } },
        { merge: true },
      );
      batch.set(doc(collection(db, "users", uid, "inbox")), {
        kind: reward.kind,
        title: title.slice(0, INBOX_TITLE_MAX),
        body: body.slice(0, INBOX_BODY_MAX),
        amount: n,
        gameId: reward.kind === "coins" ? reward.gameId : "",
        badgeId: "",
        read: false,
        createdAt: serverTimestamp(),
      });
    }
    await batch.commit();
    done += Math.min(step, uids.length - i);
  }
  return done;
}

/** Close every room at once, live or not. The emergency brake. */
export async function closeAllRooms(roomIds: string[]): Promise<number> {
  return purgeRooms(roomIds);
}

// -- one player ----------------------------------------------------------------

/** A plain note from an admin, into one player's inbox. */
export async function sendNote(uid: string, title: string, body: string): Promise<void> {
  await sendInboxMessage(uid, { kind: "note", title: title.trim() || "A message from PlayWithBuddies", body: body.trim() });
}

/** Set the match counters outright , a correction, not an increment. */
export async function setStats(uid: string, gamesPlayed: number, wins: number): Promise<void> {
  const games = Math.max(0, Math.round(gamesPlayed));
  const w = Math.max(0, Math.min(games, Math.round(wins)));
  await setDoc(doc(db, "users", uid), { stats: { gamesPlayed: games, wins: w } }, { merge: true });
}

/** Wipe today's daily-challenge record, so the three completions are available again. */
export async function resetChallenges(uid: string): Promise<void> {
  await updateDoc(doc(db, "users", uid), { challenges: deleteField() });
}

/** Empty one game's purse and shop unlocks for a player. */
export async function resetGameWallet(uid: string, gameId: string): Promise<void> {
  await updateDoc(doc(db, "users", uid), {
    [`coins.${gameId}`]: deleteField(),
    [`unlocks.${gameId}`]: deleteField(),
  });
}
