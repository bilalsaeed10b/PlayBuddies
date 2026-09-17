import type { ReactNode } from 'react';
import { Crown, Fish as FishIcon, Play, Waves } from 'lucide-react';
import { ActionBar, HostBadge, StageFrame } from '@shared/menu/StageFrame';
import { ModeCard, RuleSection, ToggleOption } from '@shared/menu/MatchControls';
import { FISH_ASSETS, fishSrc } from '../game/fish';
import { THEME } from './menuTheme';

/** One fish on the roster: an online player, or a seat at this keyboard. */
export interface ReefMember {
  key: string;
  name: string;
  fish: number | null | undefined;
  you?: boolean;
  host?: boolean;
  /** Which keys this seat steers with, when several people share a keyboard. */
  keys?: string;
}

/**
 * Stage 3: the match setup page.
 *
 * The reef has one way to play and one rule, Friendly Fish, and this page
 * shows exactly that rather than inventing choices the engine does not have.
 * Online, the rule lives on the lobby document itself: the host's toggle
 * writes it and every guest's locked copy of this page reads it back from the
 * same snapshot, so a guest sees it flip the moment the host flips it.
 */
export default function ModesScreen({
  kind,
  locked,
  hostName,
  underway,
  toolbar,
  members,
  friendlyFish,
  onFriendlyFish,
  onBack,
  action,
  note,
}: {
  /** An online room, one player at this device, or several sharing its keyboard. */
  kind: 'room' | 'solo' | 'couch';
  /** A guest's copy: the same page, nothing on it clickable. */
  locked: boolean;
  hostName?: string;
  /** A match is already running in this room. */
  underway?: boolean;
  toolbar: ReactNode;
  members: ReefMember[];
  friendlyFish: boolean;
  onFriendlyFish: (value: boolean) => void;
  onBack?: () => void;
  /** The one button in the footer, if this device has one to press. */
  action?: { label: string; onClick: () => void; disabled?: boolean };
  note: string;
}) {
  const count = `${members.length} ${members.length === 1 ? 'player' : 'players'}`;
  const summary = [
    'Free-for-all',
    kind === 'solo' ? 'solo run' : friendlyFish ? 'friendly fish' : 'players can eat players',
    kind === 'couch' ? `${count} on one keyboard` : kind === 'room' ? count : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <StageFrame
      theme={THEME}
      step={3}
      title="Match rules"
      subtitle={summary}
      onBack={onBack}
      toolbar={toolbar}
      status={
        locked ? (
          <HostBadge theme={THEME}>
            {underway
              ? `${hostName || 'The host'} has a match underway`
              : `${hostName || 'The host'} is configuring the match...`}
          </HostBadge>
        ) : undefined
      }
      footer={
        <ActionBar
          theme={THEME}
          label={action?.label ?? 'Dive in'}
          icon={<Play className="h-4 w-4 fill-current" />}
          onAction={action?.onClick}
          disabled={action?.disabled}
          note={note}
        />
      }
    >
      <div className="grid gap-5 lg:grid-cols-3 short:gap-3">
        <div className="space-y-5 lg:col-span-2 short:space-y-3">
          <RuleSection theme={THEME} title="Game mode" locked={locked}>
            <ModeCard
              theme={THEME}
              title="Free-for-all"
              badge={kind === 'solo' ? 'Solo' : kind === 'couch' ? `${count} · one keyboard` : `${count} · one shared reef`}
              description="Eat anything smaller, dodge anything bigger, and steer clear of the Zombie Shark. There is no finish line: an eaten fish swims back in when its player moves."
              icon={<Waves className="h-4 w-4" />}
              selected
              locked
              onSelect={() => {}}
            />
          </RuleSection>

          {kind !== 'solo' && (
            <RuleSection theme={THEME} title="Rules" locked={locked}>
              <ToggleOption
                theme={THEME}
                label="Friendly Fish"
                hint={
                  friendlyFish
                    ? "Players cannot eat each other. Only the reef's own fish are food, and they can still eat you."
                    : 'Bigger players can eat smaller players.'
                }
                value={friendlyFish}
                locked={locked}
                onChange={onFriendlyFish}
              />
            </RuleSection>
          )}
        </div>

        <RuleSection theme={THEME} title={`In the water · ${members.length}`}>
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-1">
            {members.map((m) => {
              const hasFish = m.fish !== undefined && m.fish !== null;
              return (
                <div key={m.key} className="flex items-center gap-2 rounded-xl border border-black/5 bg-white/50 p-1.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-black/10 bg-white/60 p-1">
                    {hasFish ? (
                      <img src={fishSrc(m.fish as number)} alt="" className="max-h-full max-w-full object-contain" />
                    ) : (
                      <FishIcon className="h-4 w-4 text-slate-400" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 truncate text-xs font-black">
                      <span className="truncate">{m.name}</span>
                      {m.host && <Crown className="h-3 w-3 shrink-0 text-amber-500" />}
                      {m.you && <span className="shrink-0 font-bold text-slate-400">· you</span>}
                    </span>
                    <span
                      className={`block truncate text-[9px] font-black uppercase tracking-wider ${
                        hasFish ? 'text-emerald-700' : 'text-slate-400'
                      }`}
                    >
                      {hasFish ? FISH_ASSETS[m.fish as number]?.name ?? 'Fish' : 'Choosing...'}
                      {m.keys && <span className="text-slate-500"> · {m.keys}</span>}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </RuleSection>
      </div>
    </StageFrame>
  );
}
