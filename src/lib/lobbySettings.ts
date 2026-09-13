import { deleteField } from "firebase/firestore";

/** Every entry point that switches games must clear the previous game's state. */
export function gameSelectionUpdate(gameId: string, playerIds: string[]) {
  const reset: Record<string, ReturnType<typeof deleteField> | boolean | string> = {
    gameId, status: "waiting", matchStarted: false,
    matchRules: deleteField(), matchSeed: deleteField(),
    battleTeams: deleteField(), quoridorTeams: deleteField(),
    soloMode: deleteField(), collectedGems: deleteField(), level: deleteField(),
  };
  for (const uid of playerIds) {
    reset[`players.${uid}.fishIndex`] = deleteField();
    reset[`players.${uid}.role`] = deleteField();
    reset[`players.${uid}.isReady`] = true;
  }
  return reset;
}
