import type { User } from "firebase/auth";

/**
 * Who may open the admin panel.
 *
 * This list is duplicated in firestore.rules and storage.rules, and the copies
 * there are the ones that actually matter. Everything in this file is UI: it
 * decides whether to render the panel and whether to show the link to it. A
 * hostile client can edit the shipped bundle and walk straight past it, which
 * is fine , the reads and writes the panel makes are refused by the rules
 * unless the signed-in token carries one of these addresses.
 *
 * Emails rather than uids because Google sign-in is the only provider, an
 * address is stable and knowable, and a uid would have to be copied out of the
 * console before the first admin could ever sign in.
 */
export const ADMIN_EMAILS = [
  "bilalsaeed10b@gmail.com",
  "bilalsaeed12b@gmail.com",
] as const;

/** Where bug reports are addressed. Shown in the UI, not used to send mail. */
export const BUG_INBOX_EMAIL = "bilalsaeed12b@gmail.com";

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return (ADMIN_EMAILS as readonly string[]).includes(email.toLowerCase());
}

/**
 * Google verifies the address on its own accounts, so `emailVerified` is
 * normally already true here. It is checked anyway: the rules check it too,
 * and a UI that let an unverified token into the panel would only produce a
 * screen full of permission errors.
 */
export function isAdminUser(user: User | null | undefined): boolean {
  return Boolean(user && user.emailVerified && isAdminEmail(user.email));
}
