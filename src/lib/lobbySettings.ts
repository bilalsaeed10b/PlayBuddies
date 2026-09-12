import { deleteField } from "firebase/firestore";

/** Reset settings that belong to the previous game before choosing another. */
export function gameSelectionUpdate(gameId: string, playerIds: string[]) {
  const update: Record<string, unknown> = {
    gameId,
    status: "waiting",
    matchStarted: false,
    matchRules: deleteField(),
    matchSeed: deleteField(),
    battleTeams: deleteField(),
    quoridorTeams: deleteField(),
    soloMode: deleteField(),
    collectedGems: deleteField(),
    level: deleteField(),
  };
  for (const uid of playerIds) {
    update[`players.${uid}.fishIndex`] = deleteField();
    update[`players.${uid}.role`] = deleteField();
    update[`players.${uid}.isReady`] = true;
  }
  return update;
}
