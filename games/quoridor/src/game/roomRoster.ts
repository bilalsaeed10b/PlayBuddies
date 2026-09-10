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

export type Team = 0 | 1;

/**
 * A deterministic, balanced assignment for the humans currently in a 2v2 room.
 * Saved host choices win until a side reaches its two-seat capacity; missing
 * or stale values are then filled across the other side.
 */
export function balancedTeams(
  people: PlayingPerson[],
  saved: Record<string, number> = {},
): Record<string, Team> {
  const result: Record<string, Team> = {};
  const counts = [0, 0];
  for (let i = 0; i < people.length; i++) {
    const requested: Team = saved[people[i].uid] === 1 ? 1 : saved[people[i].uid] === 0 ? 0 : (i % 2) as Team;
    const team: Team = counts[requested] < 2 ? requested : ((1 - requested) as Team);
    result[people[i].uid] = team;
    counts[team]++;
  }
  return result;
}

/**
 * Put Gold into seats 0/2 and Blue into 1/3, matching Quoridor's alternating
 * turn order and the paired starting edges. Undefined slots are deliberate:
 * in a three-human match the missing partner is filled by a bot on that team.
 */
export function teamSeatOrder(
  people: PlayingPerson[],
  saved: Record<string, number> = {},
): Array<PlayingPerson | undefined> {
  const assignment = balancedTeams(people, saved);
  const gold = people.filter((person) => assignment[person.uid] === 0);
  const blue = people.filter((person) => assignment[person.uid] === 1);
  return [gold[0], blue[0], gold[1], blue[1]];
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
