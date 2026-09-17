import { Check, Lock } from 'lucide-react';
import { FISH_ASSETS, FISH_CATEGORIES, fishSrc } from '../game/fish';

/**
 * The fish catalogue as a grid, grouped by size class. The shop sells from it
 * and the loadout stage (Stage 2) picks from it; a locked fish shows its price
 * either way.
 */
export default function FishGrid({
  unlocked,
  coins,
  onPick,
  selected,
  pickedBy,
  mode,
}: {
  unlocked: number[];
  coins: number;
  onPick: (index: number) => void;
  selected: number | null;
  /**
   * Everyone else who has also picked this fish. Purely informational , size
   * is what tells fish apart in the water, so nothing stops two players
   * choosing the same one.
   */
  pickedBy: Record<number, string[]>;
  mode: 'shop' | 'pick';
}) {
  return (
    <div className="space-y-5">
      {FISH_CATEGORIES.map((category) => {
        const entries = FISH_ASSETS.map((fish, index) => ({ fish, index })).filter(
          (e) => e.fish.category === category,
        );
        if (!entries.length) return null;

        return (
          <section key={category} className="space-y-2">
            <h3 className="border-b border-black/10 pb-1.5 text-[10px] sm:text-[11px] font-black uppercase tracking-[0.2em] text-emerald-700/80">
              {category} class
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 sm:gap-3">
              {entries.map(({ fish, index }) => {
                const isUnlocked = unlocked.includes(index);
                const others = pickedBy[index] ?? [];
                const isSelected = selected === index;
                const affordable = coins >= fish.price;

                return (
                  <button
                    key={index}
                    onClick={() => onPick(index)}
                    disabled={mode === 'shop' && (isUnlocked || !affordable)}
                    aria-pressed={mode === 'pick' ? isSelected : undefined}
                    className={`relative flex flex-col items-center gap-1 overflow-hidden rounded-xl sm:rounded-2xl border p-1.5 sm:p-2 transition-all ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-500/20 shadow-[0_0_0_3px_rgba(16,185,129,0.2)] scale-[1.02]'
                        : isUnlocked
                          ? 'border-black/10 bg-white/40 hover:bg-white/70 active:scale-95'
                          : 'border-amber-400/40 bg-amber-400/10'
                    }`}
                  >
                    {!isUnlocked && (
                      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/55 backdrop-blur-[1px]">
                        <Lock className="mb-0.5 h-3.5 w-3.5 text-amber-300" />
                        <span className="text-[9px] font-black text-amber-300">{fish.price}</span>
                      </div>
                    )}
                    <div className="flex h-11 sm:h-14 items-center justify-center">
                      <img
                        src={fishSrc(index)}
                        alt={fish.name}
                        loading="lazy"
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <span className="w-full truncate text-center text-[9px] sm:text-[10px] font-bold uppercase tracking-wide">
                      {fish.name}
                    </span>
                    {others.length > 0 && (
                      <span className="w-full truncate text-[8px] sm:text-[9px] font-bold uppercase text-slate-400">
                        Also played by {others.join(', ')}
                      </span>
                    )}
                    {mode === 'shop' && isUnlocked && (
                      <span className="flex items-center gap-1 text-[9px] sm:text-[10px] font-bold text-emerald-600">
                        <Check className="h-3 w-3" /> owned
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
