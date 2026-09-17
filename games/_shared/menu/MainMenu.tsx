/**
 * Stage 1: the title screen every game opens on.
 *
 * Three choices and nothing else. Skins, rules and teams used to all be on
 * screen the moment a game loaded; they now each wait for their own stage.
 *
 * In a room, only the host picks how the room plays. A guest sees the same
 * screen with both play buttons locked, so nobody can split off into a solo
 * game while the party is waiting on them. Settings stay open to everyone ,
 * they only ever touch this device.
 */
import type { ReactNode } from 'react';
import { Lock, Settings as SettingsIcon, User, Users } from 'lucide-react';
import { toneClasses } from './theme';
import type { MenuTheme } from './theme';

export function MainMenu({
  theme,
  title,
  toolbar,
  online,
  isHost,
  hostName,
  onSingle,
  onMulti,
  onSettings,
  singleHint = 'You against the bots',
  multiHint = 'Everyone in this room',
  secondary,
  footer,
}: {
  theme: MenuTheme;
  /** The game's own logo and tagline. */
  title: ReactNode;
  /** Top-right buttons: coins, fullscreen, leave. */
  toolbar?: ReactNode;
  /** Opened from a PlayBuddies room. */
  online: boolean;
  isHost: boolean;
  hostName?: string;
  onSingle: () => void;
  /** Omit to hide Multiplayer, e.g. opened on its own or in the platform's solo mode. */
  onMulti?: () => void;
  onSettings: () => void;
  singleHint?: string;
  multiHint?: string;
  /** Extra, smaller options under the three main buttons, e.g. couch play or stats. */
  secondary?: ReactNode;
  footer?: ReactNode;
}) {
  const t = toneClasses(theme);
  const locked = online && !isHost;

  return (
    <div className={`flex h-full flex-col overflow-y-auto overscroll-contain p-4 sm:p-6 short:p-2 ${t.text}`}>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{toolbar}</div>

      <div className="flex flex-1 flex-col items-center justify-center gap-5 py-4 short:flex-row short:gap-4 short:py-1">
        <div className="text-center short:flex-1">{title}</div>

        <div className="panel w-full max-w-md space-y-3 rounded-[2rem] p-5 short:max-w-sm short:space-y-2 short:p-3">
          {locked && (
            <p
              className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-center text-xs font-black ${t.well} ${theme.accent}`}
            >
              <Lock className="h-3.5 w-3.5 shrink-0" />
              Waiting for {hostName || 'the host'} to choose how to play...
            </p>
          )}

          <MenuButton
            theme={theme}
            primary
            locked={locked}
            icon={<User className="h-5 w-5" />}
            label="Single Player"
            hint={singleHint}
            onClick={onSingle}
          />
          {onMulti && (
            <MenuButton
              theme={theme}
              locked={locked}
              icon={<Users className="h-5 w-5" />}
              label="Multiplayer"
              hint={multiHint}
              onClick={onMulti}
            />
          )}
          <MenuButton
            theme={theme}
            icon={<SettingsIcon className="h-5 w-5" />}
            label="Game Settings"
            hint="Audio, graphics and controls"
            onClick={onSettings}
          />

          {secondary}
        </div>

        {footer}
      </div>
    </div>
  );
}

function MenuButton({
  theme,
  primary,
  locked,
  icon,
  label,
  hint,
  onClick,
}: {
  theme: MenuTheme;
  primary?: boolean;
  locked?: boolean;
  icon: ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  const t = toneClasses(theme);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={locked}
      className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 short:py-2 ${
        primary ? `border-transparent ${theme.primary}` : t.idle
      }`}
    >
      <span className="shrink-0">{locked ? <Lock className="h-5 w-5" /> : icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-black leading-tight short:text-sm">{label}</span>
        <span className={`block truncate text-[11px] font-bold ${primary ? 'opacity-70' : t.muted}`}>{hint}</span>
      </span>
    </button>
  );
}
