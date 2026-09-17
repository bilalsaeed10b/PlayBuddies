import type { MenuTheme } from '@shared/menu/theme';

/**
 * The reef's colours for the shared menu stages: frosted white panels with
 * dark text (hence 'light'), emerald for anything you can press or have chosen.
 */
export const THEME: MenuTheme = {
  tone: 'light',
  primary: 'bg-emerald-600 text-white',
  selected: 'border-emerald-500 bg-emerald-500/20',
  accent: 'text-emerald-700',
};
