/**
 * The pieces a Stage 3 match setup page is built from: mode cards, rule
 * sections, segmented options and on/off switches.
 *
 * Every one takes `locked`. The host's page and a guest's page are the same
 * page, fed from the same lobby document; a guest's copy just cannot be
 * clicked, and shows the host's current choice rather than a greyed-out
 * guess at it. That is what lets a guest watch the host set the match up
 * live instead of finding out what they are playing at the start.
 */
import type { ReactNode } from 'react';
import { Check, Lock } from 'lucide-react';
import { toneClasses } from './theme';
import type { MenuTheme } from './theme';

export function ModeCard({
  theme,
  title,
  badge,
  description,
  icon,
  selected,
  locked,
  onSelect,
}: {
  theme: MenuTheme;
  title: string;
  /** Short and factual, e.g. "2 players". */
  badge?: string;
  description?: string;
  icon?: ReactNode;
  selected: boolean;
  locked?: boolean;
  onSelect: () => void;
}) {
  const t = toneClasses(theme);
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={locked}
      aria-pressed={selected}
      className={`relative flex flex-col gap-1.5 rounded-2xl border-2 p-3.5 text-left transition-transform disabled:cursor-default short:gap-1 short:p-2 ${
        selected ? theme.selected : t.idle
      } ${locked ? (selected ? '' : 'opacity-55') : 'active:scale-[0.98]'}`}
    >
      <span className="flex items-center gap-2">
        {icon && <span className={`shrink-0 ${selected ? theme.accent : t.muted}`}>{icon}</span>}
        <span className="min-w-0 flex-1 truncate text-sm font-black sm:text-base short:text-xs">{title}</span>
        {selected && <Check className={`h-4 w-4 shrink-0 ${theme.accent}`} />}
      </span>
      {badge && (
        <span className={`w-fit rounded-md px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider ${t.well} ${t.muted}`}>
          {badge}
        </span>
      )}
      {description && <span className={`text-[11px] leading-snug short:hidden ${t.muted}`}>{description}</span>}
    </button>
  );
}

/** A titled block of controls. Shows a lock on a guest's copy so it never reads as broken. */
export function RuleSection({
  theme,
  title,
  hint,
  locked,
  children,
}: {
  theme: MenuTheme;
  title: string;
  hint?: ReactNode;
  locked?: boolean;
  children: ReactNode;
}) {
  const t = toneClasses(theme);
  return (
    <section className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-black">{title}</h3>
          {hint && <p className={`text-[11px] leading-snug ${t.muted}`}>{hint}</p>}
        </div>
        {locked && (
          <span
            className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider ${t.well} ${t.faint}`}
            title="Configured by host"
          >
            <Lock className="h-2.5 w-2.5" /> Host
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

export interface Option<T> {
  value: T;
  label: string;
  sub?: string;
}

export function OptionGroup<T extends string | number | boolean>({
  theme,
  options,
  value,
  onChange,
  locked,
  columns = 3,
}: {
  theme: MenuTheme;
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  locked?: boolean;
  columns?: 2 | 3 | 4 | 5;
}) {
  const t = toneClasses(theme);
  const cols = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4', 5: 'grid-cols-3 sm:grid-cols-5' }[columns];
  return (
    <div className={`grid gap-2 ${cols}`}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            disabled={locked}
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={`rounded-xl border px-2 py-2.5 text-xs font-black transition-colors disabled:cursor-default short:py-1.5 ${
              selected ? theme.selected : t.idle
            } ${locked && !selected ? 'opacity-55' : ''}`}
          >
            {option.label}
            {option.sub && <span className={`mt-0.5 block text-[10px] font-bold ${t.faint}`}>{option.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function ToggleOption({
  theme,
  label,
  hint,
  value,
  onChange,
  locked,
}: {
  theme: MenuTheme;
  label: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  locked?: boolean;
}) {
  const t = toneClasses(theme);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={locked}
      onClick={() => onChange(!value)}
      className={`flex w-full items-center justify-between gap-3 rounded-2xl border px-3 py-2.5 text-left transition-colors disabled:cursor-default short:py-1.5 ${t.idle}`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-black">{label}</span>
        {hint && <span className={`block text-[11px] leading-snug short:hidden ${t.muted}`}>{hint}</span>}
      </span>
      <span
        className={`relative block h-6 w-11 shrink-0 rounded-full border transition-colors ${
          value ? theme.selected : `${t.well} ${t.rule}`
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full shadow transition-all ${
            value ? `left-[22px] ${theme.primary}` : `left-0.5 ${theme.tone === 'dark' ? 'bg-white/60' : 'bg-slate-400'}`
          }`}
        />
      </span>
    </button>
  );
}
