/**
 * The handful of colours a game hands the shared menu screens.
 *
 * Full class strings rather than a colour name, so Tailwind sees every class
 * it has to generate written out literally in the game's own source.
 */
export interface MenuTheme {
  /** 'dark' for light text on dark panels, 'light' for dark text on light panels. */
  tone: 'dark' | 'light';
  /** The main call to action, e.g. `bg-amber-400 text-slate-900`. */
  primary: string;
  /** A chosen card or option, e.g. `border-amber-400 bg-amber-400/15`. */
  selected: string;
  /** Step numbers, kickers and badges, e.g. `text-amber-300`. */
  accent: string;
}

export function toneClasses(theme: MenuTheme) {
  return theme.tone === 'dark'
    ? {
        text: 'text-white',
        muted: 'text-white/60',
        faint: 'text-white/40',
        idle: 'border-white/15 bg-white/5 hover:bg-white/10',
        well: 'bg-black/25',
        rule: 'border-white/10',
      }
    : {
        text: 'text-slate-900',
        muted: 'text-slate-600',
        faint: 'text-slate-400',
        idle: 'border-black/10 bg-white/60 hover:bg-white',
        well: 'bg-black/5',
        rule: 'border-black/10',
      };
}
