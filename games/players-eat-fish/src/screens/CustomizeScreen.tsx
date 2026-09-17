import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Crown, Fish as FishIcon } from 'lucide-react';
import { ActionBar, HostBadge, StageFrame } from '@shared/menu/StageFrame';
import FishGrid from '../components/FishGrid';
import { FISH_ASSETS, fishSrc } from '../game/fish';
import { THEME } from './menuTheme';

/** One fish being chosen: an online player, or a seat at this keyboard. */
export interface FishSlot {
  /** The player's uid online, `seat-N` offline , the same ids GameView uses. */
  key: string;
  label: string;
  fish: number | null | undefined;
  /** Whether this device picks for this slot. */
  editable: boolean;
  isHost?: boolean;
}

const picked = (s: FishSlot): s is FishSlot & { fish: number } => s.fish !== undefined && s.fish !== null;

/**
 * Stage 2: everyone picks a fish.
 *
 * The same screen online and offline. Online, each player writes only their
 * own `fishIndex` and watches the others' picks arrive in the roster strip; at
 * one keyboard every seat is this device's to pick for, one after another.
 * A locked fish is bought and picked in the same tap, if the coins are there.
 */
export default function CustomizeScreen({
  slots,
  role,
  unlocked,
  coins,
  toolbar,
  hostName,
  lateJoin,
  onPick,
  onBack,
  onNext,
}: {
  slots: FishSlot[];
  /** Who moves the flow on: this device offline, the host online, nobody for a guest. */
  role: 'local' | 'host' | 'guest';
  unlocked: number[];
  coins: number;
  toolbar: ReactNode;
  hostName?: string;
  /**
   * A guest who still has no fish after the room moved past this stage, so is
   * kept here: the host is on the match page ('setup') or a match is running
   * ('underway'). Picking a fish takes them on.
   */
  lateJoin?: 'setup' | 'underway';
  onPick: (key: string, index: number) => void;
  onBack?: () => void;
  onNext: () => void;
}) {
  const mine = slots.filter((s) => s.editable);
  const [activeKey, setActiveKey] = useState(() => mine[0]?.key ?? '');
  const active = mine.find((s) => s.key === activeKey) ?? mine[0];
  const host = hostName || 'the host';

  const pickedBy = useMemo(() => {
    const map: Record<number, string[]> = {};
    for (const s of slots) if (s !== active && picked(s)) (map[s.fish] ??= []).push(s.label);
    return map;
  }, [slots, active]);

  const pick = (index: number) => {
    if (!active) return;
    if (!unlocked.includes(index) && coins < FISH_ASSETS[index].price) return;
    const firstPick = !picked(active);
    onPick(active.key, index);
    // At one keyboard, the next person up gets the grid as soon as this seat
    // has a fish, the way the old one-seat-at-a-time picker worked. A seat
    // changing its mind stays put.
    if (firstPick && mine.length > 1) {
      const next = mine.find((s) => s !== active && !picked(s));
      if (next) setActiveKey(next.key);
    }
  };

  const waiting = slots.filter((s) => !picked(s)).length;
  const iAmReady = mine.length > 0 && mine.every(picked);

  let note: string;
  let disabled = false;
  if (role === 'local') {
    disabled = waiting > 0;
    note =
      waiting === 0
        ? 'Everyone has a fish. Next, the match rules.'
        : slots.length === 1
          ? 'Pick a fish to continue.'
          : `Pick a fish for ${waiting} more ${waiting === 1 ? 'player' : 'players'}.`;
  } else if (role === 'host') {
    disabled = !iAmReady;
    note = !iAmReady
      ? 'Pick your fish first.'
      : waiting > 0
        ? `${waiting} still choosing. They can finish picking after you move on.`
        : 'Everyone is ready. Next, the match rules.';
  } else {
    note = iAmReady ? `Ready. Waiting for ${host} to set up the match...` : 'Pick a fish to be ready.';
  }

  const status =
    role !== 'guest' ? undefined : (
      <HostBadge theme={THEME}>
        {lateJoin === 'underway'
          ? 'A match is underway. Pick a fish to dive in.'
          : lateJoin === 'setup'
            ? `${hostName || 'The host'} is setting up the match. Pick a fish to join.`
            : `${hostName || 'The host'} moves the room on when everyone is set`}
      </HostBadge>
    );

  return (
    <StageFrame
      theme={THEME}
      step={2}
      title={active && mine.length > 1 ? `${active.label}: pick a fish` : 'Pick your fish'}
      subtitle={`${slots.length} in the water · every fish starts the same size`}
      onBack={onBack}
      toolbar={toolbar}
      status={status}
      footer={
        <ActionBar
          theme={THEME}
          label="Next: Match rules"
          onAction={role === 'guest' ? undefined : onNext}
          disabled={disabled}
          note={note}
        />
      }
    >
      <div className="flex flex-col gap-3 short:gap-2">
        <div className="flex shrink-0 gap-2 overflow-x-auto overscroll-contain pb-1">
          {slots.map((s) => {
            const selectable = s.editable && mine.length > 1;
            return (
              <button
                key={s.key}
                type="button"
                disabled={!selectable}
                onClick={() => setActiveKey(s.key)}
                className={`flex shrink-0 items-center gap-2 rounded-2xl border px-2 py-1.5 text-left disabled:cursor-default ${
                  s === active && mine.length > 1 ? THEME.selected : 'border-black/10 bg-white/50'
                }`}
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-black/10 bg-white/60 p-1">
                  {picked(s) ? (
                    <img src={fishSrc(s.fish)} alt="" className="max-h-full max-w-full object-contain" />
                  ) : (
                    <FishIcon className="h-4 w-4 text-slate-400" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="flex max-w-[120px] items-center gap-1 truncate text-xs font-black">
                    {s.label}
                    {s.isHost && <Crown className="h-3 w-3 shrink-0 text-amber-500" />}
                  </span>
                  <span
                    className={`block max-w-[120px] truncate text-[9px] font-black uppercase tracking-wider ${
                      picked(s) ? 'text-emerald-700' : 'text-slate-400'
                    }`}
                  >
                    {picked(s) ? `Ready · ${FISH_ASSETS[s.fish]?.name ?? 'Fish'}` : 'Choosing...'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {active ? (
          <FishGrid
            unlocked={unlocked}
            coins={coins}
            onPick={pick}
            selected={active.fish ?? null}
            pickedBy={pickedBy}
            mode="pick"
          />
        ) : (
          <p className="py-10 text-center text-sm font-bold text-slate-500">Joining the reef...</p>
        )}
      </div>
    </StageFrame>
  );
}
