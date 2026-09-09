/** The four seats Quoridor can place on one board. Extra lobby members watch. */
export const MAX_ROOM_PLAYERS = 4;

export interface RoomPlayer {
  uid: string;
  displayName: string;
  fishIndex?: number | null;
}

export interface PlayingPerson {
  uid: string;
  displayName: string;
  skin?: number | null;
}

/**
 * Keep the complete room roster until the host's rules choose the active seats.
 *
 * A guest's saved local rules are not match rules. Trimming here used to make a
 * guest that last played a duel throw away players three and four before the
 * host's 2v2 start packet arrived. The board then had no names for those seats
 * and permanently invented Runner Bots for them on that one client.
 */
export function orderedRoomPlayers(players: Record<string, RoomPlayer>): PlayingPerson[] {
  return Object.entries(players)
    .map(([key, player]) => ({
      uid: player.uid || key,
      displayName: player.displayName || 'Player',
      skin: player.fishIndex,
    }))
    .filter((player) => Boolean(player.uid))
    .sort((a, b) => a.uid.localeCompare(b.uid))
    .slice(0, MAX_ROOM_PLAYERS);
}
