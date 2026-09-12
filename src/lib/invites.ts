import { INVITE_TTL_MS } from "@/lib/rooms";

/** Supports Firestore timestamps while remaining compatible with older invites. */
export function inviteExpiry(data: Record<string, unknown>): number {
  const explicit = data.expiresAt;
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  if (explicit && typeof explicit === "object" && "toMillis" in explicit && typeof (explicit as { toMillis?: unknown }).toMillis === "function") {
    return (explicit as { toMillis: () => number }).toMillis();
  }
  const created = data.createdAt ?? data.timestamp;
  const start = typeof created === "number" ? created : 0;
  return start ? start + INVITE_TTL_MS : 0;
}
