/** Embedded games use account data only. Standalone games keep a local purse. */
export interface Purse {
  coins: number;
  unlocks: number[];
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
      this.purse = { coins: data.coins, unlocks: data.unlocks };
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
    this.purse = purse;
    if (embedded) {
      window.parent.postMessage({
        source: 'playbuddies-game', type: 'wallet-save', gameId: this.gameId,
        requestId: this.requestId, accountId: this.accountId, ...purse,
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

export function reportResult(won: boolean) {
  if (embedded) window.parent.postMessage({ source: 'playbuddies-game', type: 'result', won }, window.location.origin);
}
