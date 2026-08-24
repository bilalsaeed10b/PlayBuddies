/**
 * The corner tray every game's match screen shows: fullscreen, settings,
 * leave, and end game. One shared component so a game can't quietly end up
 * with a slightly different (or missing) version of it the way the four
 * games' own copies of fullscreen.ts already had, once, before this existed.
 */
import { useEffect, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { ArrowLeft, LogOut, Maximize2, Minimize2, Settings as SettingsIcon } from 'lucide-react';
import { askHostToEndGame, toggleFullscreen } from './fullscreen';

export type TrayTheme = 'dark' | 'light';

const THEME: Record<TrayTheme, { icon: string; labelled: string }> = {
  dark: {
    icon: 'rounded-2xl border border-white/20 bg-slate-950/60 p-2.5 text-white backdrop-blur-md',
    labelled:
      'flex items-center gap-1.5 rounded-2xl border border-white/20 bg-slate-950/60 px-3 py-2.5 text-xs font-bold text-white backdrop-blur-md',
  },
  light: {
    icon: 'rounded-xl border border-black/10 bg-white/80 p-2 text-slate-800 transition-colors hover:bg-white',
    labelled:
      'flex items-center gap-1.5 rounded-xl border border-black/10 bg-white/80 px-3 py-2 text-sm font-bold text-slate-800 transition-colors hover:bg-white',
  },
};

/**
 * Tracks real fullscreen state and drives the toggle button. Split out from
 * the component itself so a game can read `isFull` (or drive the toggle from
 * somewhere else entirely, like a touch pad's first-touch gesture) without
 * wiring up a second `fullscreenchange` listener of its own.
 *
 * `onChange` is the escape hatch for a game whose canvas needs an explicit
 * resize on top of what the browser's own layout gives it for free — Fish Eat
 * Fish's engine is the one that needs it. It fires from the real
 * `fullscreenchange` event, and again ~200ms after an explicit toggle to cover
 * the CSS-only fallback path (iOS, or a denied fullscreen request), where
 * `fullscreenchange` never fires at all.
 */
export function useFullscreenTray(shellRef: RefObject<HTMLElement | null>, onChange?: (isFull: boolean) => void) {
  const [isFull, setIsFull] = useState(false);

  useEffect(() => {
    const handle = () => {
      const now = Boolean(document.fullscreenElement);
      setIsFull(now);
      onChange?.(now);
    };
    document.addEventListener('fullscreenchange', handle);
    return () => document.removeEventListener('fullscreenchange', handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = () => {
    const next = !isFull;
    toggleFullscreen(shellRef.current ?? document.documentElement, next);
    setIsFull(next);
    setTimeout(() => onChange?.(next), 200);
  };

  return { isFull, toggle };
}

export default function ControlsTray({
  shellRef,
  online,
  isHost,
  onSettings,
  onExit,
  theme = 'dark',
  before,
  onFullscreenChange,
}: {
  shellRef: RefObject<HTMLElement | null>;
  /** A real online match. An offline one (couch, solo vs. bots) always shows End Game. */
  online: boolean;
  /** Whether this device is the room's real host — online guests never see End Game. */
  isHost: boolean;
  onSettings: () => void;
  onExit: () => void;
  theme?: TrayTheme;
  /** Extra content rendered before the standard buttons — a wifi/ping badge, say. */
  before?: ReactNode;
  /** See useFullscreenTray's onChange — only needed if a game's canvas wants a manual resize. */
  onFullscreenChange?: (isFull: boolean) => void;
}) {
  const { isFull, toggle } = useFullscreenTray(shellRef, onFullscreenChange);
  const cls = THEME[theme];

  return (
    <div className="flex items-center gap-2">
      {before}
      <button onClick={toggle} className={cls.icon} title={isFull ? 'Exit full screen' : 'Full screen'}>
        {isFull ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
      </button>
      <button onClick={onSettings} className={cls.icon} title="Settings">
        <SettingsIcon className="h-5 w-5" />
      </button>
      <button onClick={onExit} className={cls.icon} title="Leave">
        <ArrowLeft className="h-5 w-5" />
      </button>
      {(!online || isHost) && (
        <button onClick={askHostToEndGame} className={cls.labelled} title="End the match for everyone">
          <LogOut className="h-4 w-4" /> End Game
        </button>
      )}
    </div>
  );
}
