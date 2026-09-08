/**
 * The letters, and what each one is worth.
 *
 * The value is printed on every key rather than hidden in the rules, because
 * "safe letter for one point or rare letter for ten" is the actual decision
 * this game hands you on a turn, and a decision you have to have memorised a
 * table to make is not one most people will make at all.
 *
 * A called letter stays on screen, greyed and struck through, instead of
 * disappearing. What has already been ruled out is half the information in
 * hangman, and removing the key removes the record.
 */
import { ALPHABET, LETTER_VALUE } from '../game/rules';

export default function Keyboard({
  called,
  hits,
  disabled,
  markUsed,
  onPick,
}: {
  called: string[];
  /** Letters that turned out to be in the word — coloured apart from the misses. */
  hits: Set<string>;
  disabled: boolean;
  markUsed: boolean;
  onPick: (letter: string) => void;
}) {
  const used = new Set(called);
  return (
    <div className="grid grid-cols-9 gap-1 sm:gap-1.5">
      {ALPHABET.map((letter) => {
        const isUsed = used.has(letter);
        const wasHit = hits.has(letter);
        return (
          <button
            key={letter}
            type="button"
            disabled={isUsed || disabled}
            onClick={() => onPick(letter)}
            aria-label={`${letter}, worth ${LETTER_VALUE[letter]}`}
            className={`relative flex aspect-[5/6] flex-col items-center justify-center rounded-lg border font-black transition-all ${
              isUsed && markUsed
                ? wasHit
                  ? 'border-lime-400/40 bg-lime-400/10 text-lime-300/70'
                  : 'border-rose-400/30 bg-rose-500/10 text-rose-300/50 line-through'
                : disabled
                  ? 'border-slate-600/40 bg-slate-800/40 text-slate-500'
                  : 'border-slate-400/40 bg-slate-100/95 text-slate-900 active:scale-90 sm:hover:bg-white'
            }`}
          >
            <span className="text-sm leading-none sm:text-lg">{letter}</span>
            <span
              className={`text-[7px] font-bold leading-none sm:text-[9px] ${
                isUsed && markUsed ? 'opacity-50' : 'text-slate-500'
              }`}
            >
              {LETTER_VALUE[letter]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
