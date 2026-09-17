/**
 * The page stages 2 and 3 are drawn in: where you are in the flow, a body that
 * scrolls on its own, and an action bar that never scrolls away , the button
 * that moves the room forward is the one thing a short landscape phone must
 * never have to hunt for.
 */
import type { ReactNode } from 'react';
import { ArrowLeft, Lock } from 'lucide-react';
import { toneClasses } from './theme';
import type { MenuTheme } from './theme';

const STEPS = ['Menu', 'Loadout', 'Match'];

export function StageFrame({
  theme,
  step,
  title,
  subtitle,
  onBack,
  toolbar,
  status,
  children,
  footer,
}: {
  theme: MenuTheme;
  step: 2 | 3;
  title: string;
  subtitle?: ReactNode;
  /** Host or offline only. A guest follows the host and has nothing to go back to. */
  onBack?: () => void;
  toolbar?: ReactNode;
  /** A banner under the header, e.g. `<HostBadge>`. */
  status?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
}) {
  const t = toneClasses(theme);
  return (
    <div
      className={`mx-auto flex h-full w-full max-w-6xl flex-col gap-3 p-3 sm:gap-4 sm:p-6 short:gap-1.5 short:p-2 ${t.text}`}
    >
      <header className="flex shrink-0 items-center gap-2 sm:gap-3">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back" className="panel shrink-0 rounded-2xl p-3 short:p-2">
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <ol className={`flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.18em] short:hidden ${t.faint}`}>
            {STEPS.map((name, i) => (
              <li key={name} className={`flex items-center gap-1.5 ${i + 1 === step ? theme.accent : ''}`}>
                {i > 0 && <span aria-hidden>›</span>}
                {name}
              </li>
            ))}
          </ol>
          <h2 className="truncate text-lg font-black leading-tight tracking-tight sm:text-2xl short:text-base">{title}</h2>
          {subtitle && (
            <p className={`truncate text-[10px] font-bold uppercase tracking-[0.14em] sm:text-[11px] ${theme.accent}`}>
              {subtitle}
            </p>
          )}
        </div>
        {toolbar && <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">{toolbar}</div>}
      </header>

      {status && <div className="shrink-0">{status}</div>}

      <main className="panel min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-[2rem] p-3 sm:p-5 short:rounded-2xl short:p-2">
        {children}
      </main>

      <footer className="panel shrink-0 rounded-2xl p-2.5 sm:p-3 short:p-1.5">{footer}</footer>
    </div>
  );
}

/** "Host is configuring the match...", with a lock, for a guest's view. */
export function HostBadge({ theme, children }: { theme: MenuTheme; children: ReactNode }) {
  const t = toneClasses(theme);
  return (
    <p
      className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-center text-xs font-black short:py-1 ${t.well} ${theme.accent}`}
    >
      <Lock className="h-3.5 w-3.5 shrink-0" />
      {children}
    </p>
  );
}

/**
 * The bottom bar: one primary button for whoever moves the room forward, a
 * line of text for everyone waiting on them.
 */
export function ActionBar({
  theme,
  label,
  icon,
  onAction,
  disabled,
  note,
  side,
}: {
  theme: MenuTheme;
  label: string;
  icon?: ReactNode;
  /** Omit for a guest: the bar shows `note` alone. */
  onAction?: () => void;
  disabled?: boolean;
  /** Why the button is disabled, what happens next, or what a guest is waiting for. */
  note?: ReactNode;
  /** Anything to the left of the button, e.g. a ready status or a secondary action. */
  side?: ReactNode;
}) {
  const t = toneClasses(theme);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center short:flex-row short:items-center">
      <div className={`min-w-0 flex-1 text-center text-xs font-bold sm:text-left short:text-left ${t.muted}`}>
        {side}
        {note && <p className="leading-snug">{note}</p>}
      </div>
      {onAction && (
        <button
          type="button"
          onClick={onAction}
          disabled={disabled}
          className={`flex shrink-0 items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-black uppercase tracking-wide transition-transform active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100 sm:min-w-[220px] short:px-4 short:py-2 ${theme.primary}`}
        >
          {icon}
          {label}
        </button>
      )}
    </div>
  );
}
