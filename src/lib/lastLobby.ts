import { isValidRoomCode, normalizeRoomCode, LOBBY_TTL_MS } from "./rooms";

/**
 * Remembers the room this browser was last in.
 *
 * Without it, closing the tab or navigating away loses the room entirely — the
 * code only ever existed in the URL — so the only way back was to create a new
 * lobby and re-invite everyone. Lobbies also expire, so a remembered code is
 * discarded once it is older than the room could possibly be.
 */
const KEY = "pb_last_lobby_v1";

interface StoredLobby {
  room: string;
  at: number;
}

export function rememberLobby(room: string): void {
  const code = normalizeRoomCode(room);
  if (!isValidRoomCode(code)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ room: code, at: Date.now() } satisfies StoredLobby));
  } catch {
    /* private mode — resume just won't be offered */
  }
}

export function getRememberedLobby(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const { room, at } = JSON.parse(raw) as StoredLobby;
    if (!isValidRoomCode(room) || Date.now() - at > LOBBY_TTL_MS) {
      forgetLobby();
      return null;
    }
    return room;
  } catch {
    return null;
  }
}

export function forgetLobby(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clean up */
  }
}
