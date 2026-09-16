/**
 * The tap target for chat. Shown on every device , not just touch , since a
 * game that disables the `T` shortcut (its own keyboard already means
 * something else) still needs some way in on desktop.
 */
import { MessageCircle } from 'lucide-react';

export function ChatButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      aria-label="Chat"
      title="Chat"
      className={`pointer-events-auto rounded-2xl border border-white/20 bg-slate-950/60 p-2.5 text-white backdrop-blur-md transition-colors hover:bg-slate-900/70 ${className}`}
    >
      <MessageCircle className="h-5 w-5" />
    </button>
  );
}
