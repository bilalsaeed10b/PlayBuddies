/** Room-code generation and shape helpers shared by the dashboard and the lobby. */

/**
 * Unambiguous alphabet — no O/0 or I/1, so a code read aloud or copied off a
 * screen can't land the player in the wrong room.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const ROOM_CODE_LENGTH = 6;

/**
 * A uniformly random room code. Rejection sampling avoids the modulo bias the
 * previous `toString(36).substring()` approach had, and always returns exactly
 * ROOM_CODE_LENGTH characters — the old one produced variable-length codes that
 * the join input could not accept.
 */
export function generateRoomCode(): string {
  const max = 256 - (256 % ALPHABET.length);
  const out: string[] = [];
  const buf = new Uint8Array(ROOM_CODE_LENGTH * 2);

  while (out.length < ROOM_CODE_LENGTH) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= max) continue; // biased tail — draw again
      out.push(ALPHABET[b % ALPHABET.length]);
      if (out.length === ROOM_CODE_LENGTH) break;
    }
  }
  return out.join("");
}

export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, ROOM_CODE_LENGTH);
}

export function isValidRoomCode(code: string): boolean {
  return (
    code.length === ROOM_CODE_LENGTH &&
    [...code].every((c) => ALPHABET.includes(c))
  );
}

/** Lobbies are abandoned rather than deleted; this is how long one stays joinable. */
export const LOBBY_TTL_MS = 2 * 60 * 60 * 1000;

/** How long a lobby invite stays actionable. */
export const INVITE_TTL_MS = 2 * 60 * 1000;

/** Timestamps for a new invite document. */
export function inviteTimestamps() {
  const now = Date.now();
  return { createdAt: now, expiresAt: new Date(now + INVITE_TTL_MS) };
}

export const FRIEND_CODE_LENGTH = 6;

/**
 * A 6-character friend code, always exactly that length.
 *
 * The previous version concatenated two base-36 numbers and sliced to 8, which
 * yields a shorter string whenever both numbers are small — and the search box
 * requires exactly FRIEND_CODE_LENGTH characters, so those users could never
 * be found.
 */
export function generateFriendCode(): string {
  const max = 256 - (256 % ALPHABET.length);
  const out: string[] = [];
  const buf = new Uint8Array(FRIEND_CODE_LENGTH * 2);

  while (out.length < FRIEND_CODE_LENGTH) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= max) continue;
      out.push(ALPHABET[b % ALPHABET.length]);
      if (out.length === FRIEND_CODE_LENGTH) break;
    }
  }
  return out.join("");
}
