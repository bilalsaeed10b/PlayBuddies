/**
 * The pre-match flow every game shares: a title screen, a loadout screen, a
 * match setup page. The match itself is the fourth stage, and stays signalled
 * by `matchStarted` exactly as it always was.
 *
 * Online, the host writes the current stage into the lobby document and every
 * client renders whatever it says, so the room moves as one. The field name is
 * the same in every game so the platform can reset it in one place when a
 * different game is launched into the same room.
 */
export type MenuStage = 'menu' | 'customize' | 'modes';

export const MENU_STAGE_FIELD = 'menuStage';

export function parseStage(value: unknown): MenuStage {
  return value === 'customize' || value === 'modes' ? value : 'menu';
}
