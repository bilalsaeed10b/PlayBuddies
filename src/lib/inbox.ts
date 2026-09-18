import {
  collection,
  doc,
  limit as qLimit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type Timestamp,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

/**
 * The player's inbox: things the platform did to their account.
 *
 * Deliberately only platform-level events , coins an admin granted, a badge
 * unlocked, a bug report approved. Anything that happens inside a game stays
 * inside that game; an inbox that also carried "you lost a match" would be a
 * notification feed nobody reads, and the one message that actually matters
 * (someone gave you 500 coins for finding a bug) would be buried in it.
 *
 * Lives at `users/{uid}/inbox/{id}` rather than a top-level collection so the
 * existing owner-only read on the user document covers it: a player can list
 * their own messages and nobody else's, with no query-shape rule to get wrong.
 */

export const INBOX_KINDS = ["coins", "gems", "badge", "bug", "note"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export interface InboxMessage {
  id: string;
  kind: InboxKind;
  title: string;
  body: string;
  /** Set for `coins` and `gems`: how many, and for coins, in which game's purse. */
  amount: number | null;
  gameId: string;
  /** Set for `badge`: which one, so the UI can draw the real chip. */
  badgeId: string;
  read: boolean;
  createdAt: Timestamp | null;
}

export const INBOX_TITLE_MAX = 80;
export const INBOX_BODY_MAX = 400;

function toMessage(id: string, data: Record<string, unknown>): InboxMessage {
  const d = data as Partial<InboxMessage>;
  return {
    id,
    kind: (d.kind as InboxKind) ?? "note",
    title: d.title ?? "",
    body: d.body ?? "",
    amount: typeof d.amount === "number" ? d.amount : null,
    gameId: d.gameId ?? "",
    badgeId: d.badgeId ?? "",
    read: d.read === true,
    createdAt: d.createdAt ?? null,
  };
}

/** Live inbox for the signed-in player, newest first. */
export function watchInbox(
  uid: string,
  onChange: (messages: InboxMessage[]) => void,
  onError?: (error: Error) => void,
  max = 50,
): Unsubscribe {
  const q = query(
    collection(db, "users", uid, "inbox"),
    orderBy("createdAt", "desc"),
    qLimit(max),
  );
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => toMessage(d.id, d.data()))),
    (e) => onError?.(e),
  );
}

export interface NewInboxMessage {
  kind: InboxKind;
  title: string;
  body: string;
  amount?: number;
  gameId?: string;
  badgeId?: string;
}

/**
 * Post one message into a player's inbox.
 *
 * Admin-only in the rules. Never awaited by the action that triggers it ,
 * see the callers in adminActions.ts: a coin grant that landed but whose
 * notification failed is still a coin grant, and reporting it as a failure
 * would invite the admin to grant the coins a second time.
 */
export async function sendInboxMessage(uid: string, input: NewInboxMessage): Promise<void> {
  const ref = doc(collection(db, "users", uid, "inbox"));
  await setDoc(ref, {
    kind: input.kind,
    title: input.title.slice(0, INBOX_TITLE_MAX),
    body: input.body.slice(0, INBOX_BODY_MAX),
    amount: typeof input.amount === "number" ? Math.round(input.amount) : null,
    gameId: (input.gameId ?? "").slice(0, 48),
    badgeId: (input.badgeId ?? "").slice(0, 24),
    read: false,
    createdAt: serverTimestamp(),
  });
}

export async function markRead(uid: string, messageId: string): Promise<void> {
  await updateDoc(doc(db, "users", uid, "inbox", messageId), { read: true });
}

export async function markAllRead(uid: string, messages: InboxMessage[]): Promise<void> {
  const unread = messages.filter((m) => !m.read).slice(0, 400);
  if (unread.length === 0) return;
  const batch = writeBatch(db);
  for (const m of unread) batch.update(doc(db, "users", uid, "inbox", m.id), { read: true });
  await batch.commit();
}
