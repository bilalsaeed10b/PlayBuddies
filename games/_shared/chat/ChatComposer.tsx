/**
 * The text box itself. It only owns what's typed , sending it, and what
 * happens to the words after, belongs entirely to whichever game mounts it.
 */
import { useEffect, useRef, useState } from 'react';

export const CHAT_MAX_LEN = 80;

export function ChatComposer({
  open,
  onClose,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue('');
    // The input isn't in the DOM yet on the same tick it mounts.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const text = value.trim();
    if (text) onSend(text.slice(0, CHAT_MAX_LEN));
    onClose();
  };

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-[60] flex justify-center px-3 pb-3"
      // Stops a drag-to-aim gesture starting on top of the composer from
      // reaching the game underneath it.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex w-full max-w-sm items-center gap-2 rounded-2xl border border-white/15 bg-slate-950/90 p-2 shadow-2xl backdrop-blur-md">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, CHAT_MAX_LEN))}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') onClose();
          }}
          onBlur={onClose}
          placeholder="Say something…"
          className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/40"
        />
        <button
          // A touch on the send button blurs the input first, which would
          // close the composer before the click is even seen.
          onMouseDown={(e) => e.preventDefault()}
          onClick={submit}
          className="shrink-0 rounded-xl bg-sky-500 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-sky-400"
        >
          Send
        </button>
      </div>
    </div>
  );
}
