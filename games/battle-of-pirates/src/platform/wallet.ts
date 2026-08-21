/**
 * The player's purse, and where it actually lives.
 *
 * Coins and unlocked items used to be nothing but two localStorage keys. That
 * is a per browser store with no idea who is signed in, so the same person
 * arrived on a second device, or cleared their history, and found an empty
 * purse. Worse, two people sharing a computer shared a balance.
 *
 * A game cannot fix that itself. It runs sandboxed in an iframe with no
 * Firebase session of its own, so it asks the PlayBuddies page it is embedded
 * in, and that page reads and writes the signed-in account.
 *
 * Opened on its own, with no host to ask, everything falls back to
 * localStorage and the game plays exactly as it always did.
 */

/** How long to wait for the host before deciding there is not one. */
const HANDSHAKE_MS = 1500;

const COINS_KEY = 'fishy_coins';

export interface Purse {
  coins: number;
  /** Item indices this player owns in THIS game. */
  unlocks: number[];
}

const embedded = (() => {
  try {
    return window.parent !== window;
  } catch {
    return false;
  }
})();

function readLocal(unlockKey: string): Purse {
  try {
    const coins = Number(localStorage.getItem(COINS_KEY) || 0);
    const raw = localStorage.getItem(unlockKey);
    const unlocks: number[] = raw ? JSON.parse(raw) : [];
    return {
      coins: Number.isFinite(coins) ? Math.max(0, Math.round(coins)) : 0,
      unlocks: Array.isArray(unlocks) ? unlocks.filter((n) => Number.isInteger(n)) : [],
    };
  } catch {
    return { coins: 0, unlocks: [] };
  }
}

function writeLocal(unlockKey: string, purse: Purse) {
  try {
    localStorage.setItem(COINS_KEY, String(purse.coins));
    localStorage.setItem(unlockKey, JSON.stringify(purse.unlocks));
  } catch {
    /* private browsing: the account copy is the real one anyway */
  }
}

/**
 * The wallet for one game.
 *
 * `gameId` is the key this game's unlocks sit under in the account record, and
 * `unlockKey` is the localStorage key the game shipped with, kept so an
 * existing player's collection carries over rather than vanishing.
 */
export class GameWallet {
  private unlocksByGame: Record<string, number[]> = {};
  private purse: Purse;
  private settled = false;
  private onChange: ((purse: Purse) => void) | null = null;
  private timer: number | null = null;
  private listener: ((e: MessageEvent) => void) | null = null;

  constructor(
    private gameId: string,
    private unlockKey: string,
  ) {
    this.purse = readLocal(unlockKey);
  }

  /** What to show right now. Replaced once the account answers. */
  get current(): Purse {
    return this.purse;
  }

  /**
   * Ask the host for the account balance.
   *
   * `onWallet` fires once, either with the account's purse or, if there is no
   * host listening, with whatever was in localStorage.
   */
  open(onWallet: (purse: Purse) => void) {
    this.onChange = onWallet;

    if (!embedded) {
      this.settle(this.purse);
      return;
    }

    this.listener = (e: MessageEvent) => {
      const data = e.data;
      if (!data || data.source !== 'playbuddies-host' || data.type !== 'wallet') return;
      if (e.source !== window.parent) return;

      this.unlocksByGame =
        data.unlocks && typeof data.unlocks === 'object' ? { ...data.unlocks } : {};
      const mine = this.unlocksByGame[this.gameId];
      const accountCoins = Number(data.coins);

      // Never hand back less than the browser already had. A player who earned
      // coins before any of this existed keeps them, and the first save pushes
      // that balance up to the account.
      const local = readLocal(this.unlockKey);
      this.settle({
        coins: Math.max(Number.isFinite(accountCoins) ? accountCoins : 0, local.coins),
        unlocks: [...new Set([...(Array.isArray(mine) ? mine : []), ...local.unlocks])],
      });
    };
    window.addEventListener('message', this.listener);

    // No host, a host that predates this protocol, or one that never answers.
    this.timer = window.setTimeout(() => this.settle(this.purse), HANDSHAKE_MS);

    window.parent.postMessage({ source: 'playbuddies-game', type: 'wallet-request' }, '*');
  }

  private settle(purse: Purse) {
    if (this.settled) return;
    this.settled = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.purse = purse;
    writeLocal(this.unlockKey, purse);
    this.onChange?.(purse);
  }

  /** Save a new balance. Local always, and to the account when there is one. */
  save(purse: Purse) {
    this.purse = purse;
    writeLocal(this.unlockKey, purse);
    if (!embedded) return;
    this.unlocksByGame[this.gameId] = purse.unlocks;
    window.parent.postMessage(
      {
        source: 'playbuddies-game',
        type: 'wallet-save',
        coins: purse.coins,
        unlocks: this.unlocksByGame,
      },
      '*',
    );
  }

  close() {
    if (this.listener) window.removeEventListener('message', this.listener);
    this.listener = null;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * One finished match, for the dashboard's Games Played and Win Rate.
 *
 * Only reported from an embedded game: played on its own there is no account
 * for it to count towards.
 */
export function reportResult(won: boolean) {
  if (!embedded) return;
  window.parent.postMessage({ source: 'playbuddies-game', type: 'result', won }, '*');
}
