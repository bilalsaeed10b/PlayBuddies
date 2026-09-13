import { INVITE_TTL_MS } from "./rooms";

export function inviteExpiry(data: { createdAt?: unknown; timestamp?: unknown; expiresAt?: unknown }): number {
  const expiry = data.expiresAt;
  if (typeof expiry === "number" && Number.isFinite(expiry)) return expiry;
  if (expiry && typeof expiry === "object" && "toMillis" in expiry && typeof expiry.toMillis === "function") {
    return expiry.toMillis();
  }
  if (expiry instanceof Date) return expiry.getTime();
  const created = Number(data.createdAt ?? data.timestamp ?? 0);
  return Number.isFinite(created) ? created + INVITE_TTL_MS : 0;
}
