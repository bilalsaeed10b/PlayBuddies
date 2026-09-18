/** Embedded games use account data only. Standalone games keep a local purse. */
export interface Purse {
  coins: number;
  unlocks: number[];
  /**
   * Badges an admin granted this account, read-only here.
   *
   * Handed down with the wallet so a game can unlock a badge-only item (the
   * Tester ships in Battle of Pirates). Never sent back up: the lobby page
   * only ever writes coins and unlocks from a save, and the grants on the
   * account are writable by an admin alone.
   */
  grants?: Record<string, boolean>;
}

/** Only true/false entries under short keys survive the trip across the frame. */
function cleanGrants(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 8)) {
    if (typeof v === 'boolean') out[k.slice(0, 24)] = v;
  }
  return out;
}

const embedded = window.parent !== window;
const empty = (): Purse => ({ coins: 0, unlocks: [] });

export class GameWallet {
  private purse: Purse = empty();
  private ready = false;
  private requestId = '';
  private accountId = '';
  private timer: number | null = null;
  private listener: ((event: MessageEvent) => void) | null = null;
  private readonly coinsKey: string;

  constructor(private gameId: string, private unlockKey: string) {
    this.coinsKey = `fishy_coins_${gameId}`;
    // Never import a previous account's or standalone player's local data.
    if (!embedded) {
      try {
        const coins = Number(localStorage.getItem(this.coinsKey) || 0);
        const unlocks = JSON.parse(localStorage.getItem(unlockKey) || '[]');
        this.purse = {
          coins: Number.isFinite(coins) ? Math.max(0, Math.round(coins)) : 0,
          unlocks: Array.isArray(unlocks) ? unlocks.filter(Number.isInteger) : [],
        };
      } catch { /* Storage may be unavailable; start the standalone purse empty. */ }
    }
  }

  get current(): Purse { return this.purse; }

  open(onWallet: (purse: Purse) => void) {
    this.close();
    this.ready = false;
    if (!embedded) {
      this.ready = true;
      onWallet(this.purse);
      return;
    }
    this.requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.listener = (event) => {
      const data = event.data;
      if (event.source !== window.parent || event.origin !== window.location.origin ||
          data?.source !== 'playbuddies-host' || data.type !== 'wallet' ||
          data.requestId !== this.requestId || data.gameId !== this.gameId ||
          typeof data.accountId !== 'string' || !data.accountId || this.ready) return;
      if (!Number.isFinite(data.coins) || !Array.isArray(data.unlocks)) return;
      this.accountId = data.accountId;
      this.purse = { coins: data.coins, unlocks: data.unlocks, grants: cleanGrants(data.grants) };
      this.ready = true;
      if (this.timer !== null) window.clearInterval(this.timer);
      this.timer = null;
      onWallet(this.purse);
    };
    window.addEventListener('message', this.listener);
    const request = () => window.parent.postMessage({
      source: 'playbuddies-game', type: 'wallet-request',
      gameId: this.gameId, requestId: this.requestId,
    }, window.location.origin);
    // Retry a missing/failed account response; never save an empty fallback.
    this.timer = window.setInterval(request, 2000);
    request();
  }

  save(purse: Purse) {
    if (!this.ready) return;
    // A save carries coins and unlocks; the grants were never the game's to set.
    this.purse = { coins: purse.coins, unlocks: purse.unlocks, grants: this.purse.grants };
    if (embedded) {
      window.parent.postMessage({
        source: 'playbuddies-game', type: 'wallet-save', gameId: this.gameId,
        requestId: this.requestId, accountId: this.accountId,
        coins: purse.coins, unlocks: purse.unlocks,
      }, window.location.origin);
    } else {
      try {
        localStorage.setItem(this.coinsKey, String(purse.coins));
        localStorage.setItem(this.unlockKey, JSON.stringify(purse.unlocks));
      } catch { /* Standalone play can continue without persistence. */ }
    }
  }

  close() {
    if (this.listener) window.removeEventListener('message', this.listener);
    if (this.timer !== null) window.clearInterval(this.timer);
    this.listener = null;
    this.timer = null;
    this.ready = false;
  }
}

/**
 * A match finished. `detail` is a few numbers from it (ships sunk, moves, the
 * wave reached) that the platform's daily challenges are judged on; see
 * src/lib/challenges.ts for which game reports what.
 */
export function reportResult(won: boolean, detail: Record<string, number> = {}) {
  if (embedded) {
    window.parent.postMessage({ source: 'playbuddies-game', type: 'result', won, detail }, window.location.origin);
  }
}

/**
 * A run ended in a game with no winner to report, such as a life in Players
 * Eat Fish. It counts toward that game's daily challenge but is not a match:
 * it touches neither games played nor wins.
 */
export function reportRun(detail: Record<string, number> = {}) {
  if (embedded) {
    window.parent.postMessage({ source: 'playbuddies-game', type: 'run', detail }, window.location.origin);
  }
}
