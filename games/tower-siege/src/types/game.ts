import type { EnemyId, MatchRules, TowerId } from '../game/rules';

export type { MatchRules };

/**
 * Who is holding a keep.
 *
 * `local` is played on this device, `remote` arrives over the wire, `bot` is
 * simulated. A seat flips from `remote` to `bot` when somebody drops out and
 * back again when they return, and nothing else in the engine has to care.
 */
export type Control = 'local' | 'remote' | 'bot';

/** What a keep is doing. `build` is the only phase that waits on a human. */
export type Phase = 'build' | 'wave' | 'fallen' | 'won';

/**
 * Preferences that belong to this device and nobody else.
 *
 * Anything that changes how the siege actually plays lives in MatchRules
 * instead. The split matters: every client simulates every keep from the same
 * seed, so a rule one of them disagreed about is a divergence, not a taste.
 */
export interface GameSettings {
  sfxVolume: number;
  /** Range circles under every tower, not only the selected one. */
  showRanges: boolean;
  /** The big WAVE CLEARED / KEEP BREACHED banners. */
  shouts: boolean;
}

export const DEFAULT_SETTINGS: GameSettings = {
  sfxVolume: 0.7,
  showRanges: false,
  shouts: true,
};

// ── the wire ───────────────────────────────────────────────────────────────
//
// A tower defence looks real-time and almost none of it needs sending. Waves
// come from the match seed, every client runs a full engine per player, and
// what actually crosses the wire is only what a client cannot derive: what
// somebody built, what they sent, and how their keep is holding up.
//
// See REQUIREMENTS.md section 7 for why that is enough, and 7.1 for what it
// costs.

/** The host opening the match: the seed everything else is derived from. */
export interface StartPacket {
  t: 'start';
  n: number;
  seed: number;
  /** The host's rules, packed by `packRules`. */
  r: number;
}

/**
 * A tower going up, being upgraded, or being sold.
 *
 * Carries the plot rather than a tower id, because the plot is the thing both
 * sides already agree on: one tile holds one tower, so `p` names it uniquely
 * without either side having to keep an id table in step with the other.
 */
export interface BuildPacket {
  t: 'build';
  n: number;
  /** Match seed, so a write left over from the last match is obvious. */
  s: number;
  /** Plot index: row * COLS + col. */
  p: number;
  /** The tower now standing there, or null for a sale. */
  k: TowerId | null;
  /** Its level after the action. 0 for a fresh build. */
  lv: number;
}

/**
 * Gold spent to push extra enemies into everyone else's next wave.
 *
 * Applied at the next wave boundary rather than immediately, which is what
 * makes it deterministic: every client folds the same sends into the same
 * wave, whatever order the packets happened to arrive in.
 */
export interface SendPacket {
  t: 'send';
  n: number;
  s: number;
  /** What was bought. */
  k: EnemyId;
  /** How many. */
  c: number;
  /** The wave it lands on, stated rather than inferred. */
  w: number;
}

/**
 * How a keep stood at the end of a wave. The owner is authoritative for this.
 *
 * Every client simulates every keep, and two simulations of the same wave can
 * drift by a hair — a shot that connected on one and grazed on the other. This
 * is the correction, and it arrives at the only moment the picture is quiet
 * enough for a correction not to be visible.
 */
export interface StatePacket {
  t: 'state';
  n: number;
  s: number;
  /** Wave just finished. */
  w: number;
  lives: number;
  gold: number;
  /** 1 once this keep has fallen. Stated so nobody has to infer it from lives. */
  down: number;
  /** The host's rules, carried so a late joiner can build a session from any write. */
  r?: number;
}

/** Sent on the way out, so a keep is taken over by a bot rather than abandoned. */
export interface ByePacket {
  t: 'bye';
  n: number;
}

/** Sent when a link opens, so a keep handed to a bot is handed back. */
export interface HelloPacket {
  t: 'hello';
  n: number;
}

/** Written on arrival to clear whatever the last match left in the document. */
export interface IdlePacket {
  t: 'idle';
  n: number;
}

export type NetPacket =
  | StartPacket
  | BuildPacket
  | SendPacket
  | StatePacket
  | ByePacket
  | HelloPacket
  | IdlePacket;
