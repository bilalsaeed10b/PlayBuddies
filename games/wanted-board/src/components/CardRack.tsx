/**
 * The five cards, and the act of committing to one.
 *
 * Locking in is deliberately a second, separate tap rather than something a
 * card press does on its own. Everything in this game is simultaneous and
 * therefore irreversible the instant it lands, and a mis-tap that costs
 * somebody a whole bounty because their thumb brushed "Cash In" would be the
 * single worst feeling available here. The confirm also gives the targeting
 * cards somewhere to live: pick the card, then pick the place, then commit.
 */
import { CARDS, CARD_ORDER, PLACES } from '../game/rules';
import type { CardId } from '../game/rules';

const GLYPH: Record<CardId, string> = {
  ride: '→',
  layLow: '▽',
  ambush: '✷',
  trap: '⊘',
  cashIn: '$',
};

export default function CardRack({
  legal,
  selected,
  target,
  locked,
  hints,
  onSelect,
  onLock,
}: {
  legal: CardId[];
  selected: CardId | null;
  /** The chosen destination, once a targeting card needs one. */
  target: number | null;
  /** Already committed for this round — the rack goes read-only until the reveal. */
  locked: boolean;
  hints: boolean;
  onSelect: (card: CardId) => void;
  onLock: () => void;
}) {
  const meta = selected ? CARDS[selected] : null;
  const needsTarget = Boolean(meta?.needsTarget);
  const ready = Boolean(selected) && (!needsTarget || target !== null);

  return (
    <div className="w-full space-y-2">
      <div className="grid grid-cols-5 gap-1.5 sm:gap-2">
        {CARD_ORDER.map((id) => {
          const card = CARDS[id];
          const allowed = legal.includes(id);
          const isSelected = selected === id;
          return (
            <button
              key={id}
              type="button"
              disabled={!allowed || locked}
              onClick={() => onSelect(id)}
              className={`flex min-h-[62px] flex-col items-center justify-center gap-0.5 rounded-xl border-2 px-1 py-1.5 transition-all sm:min-h-[74px] ${
                isSelected
                  ? 'border-rose-700 bg-rose-100 shadow-[0_0_0_3px_rgba(190,18,60,0.2)]'
                  : allowed
                    ? 'border-amber-900/25 bg-[#f7ecd6] active:scale-95'
                    : 'border-amber-900/10 bg-amber-900/5 opacity-40'
              } ${locked ? 'opacity-60' : ''}`}
            >
              <span className={`text-lg leading-none sm:text-xl ${isSelected ? 'text-rose-800' : 'text-amber-900'}`}>
                {GLYPH[id]}
              </span>
              <span
                className={`text-[8px] font-black uppercase leading-tight tracking-wide sm:text-[9px] ${
                  isSelected ? 'text-rose-900' : 'text-amber-950'
                }`}
              >
                {card.name}
              </span>
            </button>
          );
        })}
      </div>

      {/* One line that always says exactly what is about to happen, because the
          cost of being wrong about that is a whole round. */}
      <div className="min-h-[34px] rounded-xl border border-amber-900/15 bg-amber-900/5 px-3 py-1.5 text-center">
        {!selected ? (
          <p className="text-[11px] font-bold text-amber-900/60">Pick a card. Everybody reveals at once.</p>
        ) : needsTarget && target === null ? (
          <p className="text-[11px] font-black uppercase tracking-wide text-rose-800">
            {selected === 'ride' ? 'Tap where you are riding' : 'Tap the place to rig'}
          </p>
        ) : (
          <p className="text-[11px] font-bold text-amber-950">
            <span className="font-black uppercase tracking-wide">{meta?.name}</span>
            {needsTarget && target !== null && <> · {PLACES[target]?.name}</>}
            {hints && meta && <span className="block text-[10px] font-medium text-amber-900/55">{meta.blurb}</span>}
          </p>
        )}
      </div>

      <button
        type="button"
        disabled={!ready || locked}
        onClick={onLock}
        className={`w-full rounded-2xl py-3 text-base font-black uppercase tracking-[0.18em] transition-transform ${
          locked
            ? 'bg-amber-900/15 text-amber-900/50'
            : ready
              ? 'bg-rose-800 text-amber-50 active:scale-95'
              : 'bg-amber-900/15 text-amber-900/40'
        }`}
      >
        {locked ? 'Locked in — waiting' : 'Lock it in'}
      </button>
    </div>
  );
}
