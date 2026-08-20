import { ArrowRight, Bomb, Circle, Flame, Grip, Link2, Wrench } from 'lucide-react';
import { CARDS, CardId } from '../game/rules';

/**
 * The hand: three cards, dealt fresh every turn, one of them played.
 *
 * Ammunition is a choice rather than a menu. Three is the smallest number that
 * is still a decision and the largest that fits across a phone at a size a
 * thumb can hit without aiming, and dealing a new hand each turn means the
 * interesting shots turn up on their own instead of being hoarded.
 *
 * The strip is also what keeps the aim pad honest: it sits below the pad's
 * bottom edge, so choosing a card can never be mistaken for pulling one back.
 */

const ICONS: Record<CardId, typeof Circle> = {
  round: Circle,
  chain: Link2,
  grape: Grip,
  mortar: Bomb,
  firebomb: Flame,
  bore: ArrowRight,
  patch: Wrench,
};

export const HAND_HEIGHT = 104;
export const HAND_HEIGHT_COMPACT = 76;

export default function CardHand({
  hand,
  selected,
  disabled,
  compact,
  onSelect,
}: {
  hand: CardId[];
  selected: CardId;
  disabled: boolean;
  /** Short screens drop the blurb rather than the cards. */
  compact: boolean;
  onSelect: (card: CardId) => void;
}) {
  return (
    <div
      className="absolute inset-x-0 bottom-0 z-20 flex items-end justify-center gap-2 px-2 pb-2 sm:gap-3 sm:px-4"
      style={{ height: compact ? HAND_HEIGHT_COMPACT : HAND_HEIGHT }}
    >
      {hand.map((id) => {
        const card = CARDS[id];
        const Icon = ICONS[id];
        const active = id === selected;
        return (
          <button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(id)}
            className={`flex h-full min-w-0 flex-1 max-w-[190px] flex-col items-center justify-center gap-0.5 rounded-2xl border px-2 text-center transition-colors disabled:opacity-45 ${
              active
                ? 'border-amber-300 bg-amber-400/25 text-white shadow-[0_0_0_2px_rgba(251,191,36,0.35)]'
                : 'border-white/15 bg-slate-950/65 text-white/75'
            }`}
          >
            <Icon className={`h-5 w-5 shrink-0 ${active ? 'text-amber-200' : 'text-white/60'}`} />
            <span className="w-full truncate text-[11px] font-black uppercase tracking-wide sm:text-xs">
              {card.name}
            </span>
            {!compact && (
              <span className="line-clamp-2 text-[10px] leading-tight text-white/50">{card.blurb}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
