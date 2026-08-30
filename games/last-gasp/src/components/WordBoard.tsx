/**
 * The word, as blanks and revealed letters.
 *
 * Sized from the word's own length rather than a fixed breakpoint, because a
 * four-letter answer and a twelve-letter one have to sit in the same slot on
 * the same phone, and a size that fits the long one wastes the short one.
 */
export default function WordBoard({
  board,
  /** Reveal everything, greying out what nobody actually guessed. */
  exposed,
  word,
}: {
  board: (string | null)[];
  exposed?: boolean;
  word: string;
}) {
  // Twelve letters is the longest answer in the list; below that the tiles
  // grow to fill the space rather than leaving the board looking sparse.
  const wide = board.length > 9;
  const size = wide ? 'w-[7.2vw] max-w-9 text-lg sm:max-w-11 sm:text-2xl' : 'w-[9vw] max-w-12 text-2xl sm:max-w-14 sm:text-4xl';

  return (
    <div className="flex flex-wrap items-end justify-center gap-1.5 sm:gap-2">
      {board.map((letter, i) => {
        const shown = exposed ? word[i] : letter;
        const guessed = letter !== null;
        return (
          <div key={i} className={`flex flex-col items-center ${size}`}>
            <span
              className={`flex h-[1.35em] w-full items-center justify-center font-black tabular-nums transition-colors duration-300 ${
                guessed ? 'text-slate-50' : exposed ? 'text-rose-400/80' : 'text-transparent'
              }`}
            >
              {shown ?? ''}
            </span>
            <span
              className={`h-[3px] w-full rounded-full transition-colors duration-300 ${
                guessed ? 'bg-slate-200' : 'bg-slate-500/60'
              }`}
            />
          </div>
        );
      })}
    </div>
  );
}
