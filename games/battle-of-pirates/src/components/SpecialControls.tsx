import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CloudRain, Crosshair, Heart, Sparkles, X } from 'lucide-react';

export type SpecialKind = 'torpedo' | 'acid-rain' | 'heal';

export interface SpecialControlsProps {
  charge: number;
  /** True only while the local ship is aiming; do not gate this on picker state. */
  enabled: boolean;
  ships: { id: string; name: string; team: 0 | 1; hp: number; maxHp: number }[];
  /** Index into ships. Torpedo targets use the same, unfiltered array indices. */
  shooter: number;
  onUse: (kind: SpecialKind, target?: number) => void;
  /** Also gate the parent's pointer, keyboard and held-key firing paths. */
  onOpenChange?: (open: boolean) => void;
}

const OPTIONS = [
  { id: 'torpedo', name: 'Torpedo', amount: '25 damage', scope: 'One enemy', Icon: Crosshair },
  { id: 'acid-rain', name: 'Acid Rain', amount: '10 damage', scope: 'Every enemy', Icon: CloudRain },
  { id: 'heal', name: 'Heal', amount: '+25 HP', scope: 'Your ship', Icon: Heart },
] as const;

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950';

/** A small launcher above CardHand; the native modal keeps the sea inert. */
export default function SpecialControls({
  charge,
  enabled,
  ships,
  shooter,
  onUse,
  onOpenChange,
}: SpecialControlsProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openRef = useRef(false);
  const openingShip = useRef<{ index: number; id: string } | null>(null);
  const changeRef = useRef(onOpenChange);
  const backdropPress = useRef(false);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<SpecialKind>('torpedo');
  // Keep identity, not a filtered list index, while the fleet changes underneath us.
  const [targetId, setTargetId] = useState('');

  const charges = Math.max(0, Math.min(3, Math.floor(Number.isFinite(charge) ? charge : 0)));
  const ship = ships[shooter];
  const enemies = ships
    .map((enemy, index) => ({ ...enemy, index }))
    .filter((enemy) => enemy.hp > 0 && ship && enemy.team !== ship.team);
  const healing = ship ? Math.max(0, Math.min(25, ship.maxHp - ship.hp)) : 0;
  const ready = charges === 3;
  const canOpen = enabled && ready && Boolean(ship && ship.hp > 0);
  const target = enemies.find((enemy) => enemy.id === targetId);
  const canConfirm = canOpen && (kind === 'torpedo' ? Boolean(target) : kind === 'heal' ? healing > 0 : enemies.length > 0);

  useEffect(() => {
    changeRef.current = onOpenChange;
  }, [onOpenChange]);

  const closePicker = useCallback(() => {
    if (!openRef.current) return;
    openRef.current = false;
    backdropPress.current = false;
    dialogRef.current?.close();
    setOpen(false);
    changeRef.current?.(false);
    // aria-disabled keeps the trigger focusable even when the turn just ended.
    triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (open && (!canOpen || openingShip.current?.index !== shooter || openingShip.current?.id !== ship?.id)) {
      closePicker();
    }
  }, [open, canOpen, shooter, ship?.id, closePicker]);

  useEffect(() => () => {
    if (openRef.current) {
      openRef.current = false;
      changeRef.current?.(false);
    }
  }, []);

  const openPicker = () => {
    if (!canOpen || openRef.current || !dialogRef.current) return;
    setKind('torpedo');
    setTargetId('');
    openingShip.current = { index: shooter, id: ship.id };
    dialogRef.current.showModal();
    openRef.current = true;
    setOpen(true);
    changeRef.current?.(true);
  };

  const useSpecial = () => {
    if (!openRef.current || !canConfirm) return;
    const targetIndex = kind === 'torpedo' ? target?.index : undefined;
    // Close synchronously to reject repeated activation before the next render.
    closePicker();
    onUse(kind, targetIndex);
  };

  const outsidePanel = (x: number, y: number) => {
    const bounds = dialogRef.current?.getBoundingClientRect();
    return Boolean(bounds && (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom));
  };

  const confirmLabel = kind === 'torpedo'
    ? target ? `Launch at ${target.name}` : 'Choose an enemy'
    : kind === 'acid-rain' ? 'Unleash Acid Rain' : healing > 0 ? `Restore ${healing} HP` : 'Already at full HP';

  return (
    <div
      className="absolute bottom-[112px] left-3 z-30 w-[148px] [@media(max-height:559px)]:bottom-[84px]"
      // Do not let game shortcuts consume Space/arrow keys used by these controls.
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${id}-picker`}
        aria-describedby={`${id}-charge ${id}-hint`}
        aria-disabled={!canOpen}
        onClick={openPicker}
        className={`flex min-h-12 w-full touch-manipulation items-center gap-2 rounded-xl border px-2.5 py-2 text-left shadow-lg transition-colors ${focusRing} ${
          canOpen
            ? 'border-amber-300/70 bg-slate-950/95 text-amber-100 shadow-amber-400/10 hover:bg-slate-900 active:bg-slate-800'
            : 'border-white/20 bg-slate-950/85 text-slate-300'
        }`}
      >
        <Sparkles aria-hidden="true" className={`h-4 w-4 shrink-0 ${ready ? 'text-amber-300' : 'text-slate-400'}`} />
        <span className="min-w-0 flex-1">
          <span className="block whitespace-nowrap text-[11px] font-black leading-4">
            {ready ? 'Special ready' : 'Special attack'}
          </span>
          <span aria-hidden="true" className="mt-1 flex items-center gap-1">
            {[1, 2, 3].map((step) => (
              <span key={step} className={`h-1.5 flex-1 rounded-full ${charges >= step ? 'bg-amber-300' : 'bg-slate-600'}`} />
            ))}
            <span className="ml-1 text-[10px] font-bold leading-none tabular-nums">{charges}/3</span>
          </span>
        </span>
      </button>
      <span
        id={`${id}-charge`}
        role="progressbar"
        aria-label="Special attack charge"
        aria-valuemin={0}
        aria-valuemax={3}
        aria-valuenow={charges}
        aria-valuetext={`${charges} of 3 successful attacks${ready ? '. Special ready.' : '.'}`}
        className="sr-only"
      >
        {charges} of 3 charges.
      </span>
      <span id={`${id}-hint`} className="sr-only">
        Uses your turn. Recharge with 3 successful attacks. {enabled ? '' : 'Available on your aiming turn.'}
      </span>

      <dialog
        ref={dialogRef}
        id={`${id}-picker`}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-rules`}
        onCancel={(event) => {
          event.preventDefault();
          closePicker();
        }}
        onClose={() => {
          // A queued native close event must not dismiss a newly reopened picker.
          if (!dialogRef.current?.open) closePicker();
        }}
        onPointerDown={(event) => {
          backdropPress.current = event.target === event.currentTarget && outsidePanel(event.clientX, event.clientY);
        }}
        onPointerCancel={() => { backdropPress.current = false; }}
        onClick={(event) => {
          if (backdropPress.current && event.target === event.currentTarget && outsidePanel(event.clientX, event.clientY)) {
            closePicker();
          }
          backdropPress.current = false;
        }}
        className="fixed inset-0 m-auto max-h-[calc(100dvh_-_24px)] w-[min(360px,calc(100vw_-_24px))] max-w-none flex-col overflow-hidden rounded-2xl border border-amber-200/30 bg-slate-950 p-0 text-slate-100 shadow-2xl backdrop:bg-slate-950/65 [&[open]]:flex"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 py-1 pl-3 pr-1">
          <Sparkles aria-hidden="true" className="h-4 w-4 text-amber-300" />
          <h2 id={`${id}-title`} className="flex-1 text-sm font-black">Special attack</h2>
          <span className="rounded-full bg-amber-300/10 px-2 py-1 text-[10px] font-bold text-amber-200">3/3 charged</span>
          <button
            type="button"
            aria-label="Close special attack picker"
            autoFocus
            onClick={closePicker}
            className={`flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-xl text-slate-300 hover:bg-white/10 ${focusRing}`}
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain p-3">
          <p id={`${id}-rules`} className="text-[11px] leading-4 text-slate-300">
            <strong className="font-bold text-amber-200">Uses your turn.</strong> Recharge with 3 successful attacks.
          </p>
          <fieldset>
            <legend className="sr-only">Choose a special attack</legend>
            <div className="grid grid-cols-3 gap-1.5">
              {OPTIONS.map(({ id: option, name, amount, scope, Icon }) => {
                const unavailable = option === 'heal' ? healing <= 0 : enemies.length === 0;
                return (
                  <label key={option} className="relative min-w-0">
                    <input
                      type="radio"
                      name={`${id}-kind`}
                      value={option}
                      checked={kind === option}
                      disabled={unavailable}
                      onChange={() => setKind(option)}
                      className="peer sr-only"
                    />
                    <span className="flex min-h-[88px] touch-manipulation cursor-pointer flex-col items-center justify-center rounded-xl border border-white/15 bg-white/5 px-1 py-2 text-center peer-checked:border-amber-300/70 peer-checked:bg-amber-300/10 peer-checked:text-amber-100 peer-focus-visible:ring-2 peer-focus-visible:ring-amber-200 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-950 peer-disabled:cursor-default peer-disabled:opacity-45">
                      <Icon aria-hidden="true" className={`mb-1 h-4 w-4 ${option === 'heal' ? 'text-emerald-300' : option === 'acid-rain' ? 'text-lime-300' : 'text-sky-300'}`} />
                      <span className="text-[11px] font-black leading-4">{name}</span>
                      <span className="text-[11px] font-bold leading-4">{amount}</span>
                      <span className="text-[10px] leading-4 text-slate-300">{option === 'heal' && healing <= 0 ? 'HP already full' : scope}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {kind === 'torpedo' ? (
            <div>
              <label htmlFor={`${id}-target`} className="mb-1 block text-[11px] font-bold text-slate-300">Enemy target · 25 damage</label>
              <select
                id={`${id}-target`}
                value={target?.id ?? ''}
                disabled={enemies.length === 0}
                onChange={(event) => setTargetId(event.target.value)}
                className={`min-h-11 w-full min-w-0 touch-manipulation rounded-xl border border-white/25 bg-slate-900 px-2 text-xs text-white disabled:opacity-50 ${focusRing}`}
              >
                <option value="" disabled>{enemies.length ? 'Choose an enemy…' : 'No enemies afloat'}</option>
                {enemies.map((enemy) => (
                  <option key={enemy.id} value={enemy.id}>{enemy.name} · {enemy.hp}/{enemy.maxHp} HP</option>
                ))}
              </select>
            </div>
          ) : (
            <p className="min-h-11 break-words rounded-xl bg-white/5 px-3 py-2 text-xs leading-4 text-slate-300">
              {kind === 'acid-rain'
                ? `Hits every living enemy for 10 damage each (${enemies.length} ${enemies.length === 1 ? 'ship' : 'ships'}).`
                : `${ship?.name ?? 'Your ship'} gains ${healing} HP, up to 25. Capped at full health (${ship?.maxHp ?? 0} HP).`}
            </p>
          )}
        </div>

        <div className="shrink-0 border-t border-white/10 p-3">
          <button
            type="button"
            disabled={!canConfirm}
            onClick={useSpecial}
            className={`min-h-11 w-full touch-manipulation break-words rounded-xl bg-amber-300 px-3 py-2 text-xs font-black text-slate-950 hover:bg-amber-200 disabled:cursor-default disabled:bg-slate-800 disabled:text-slate-400 ${focusRing}`}
          >
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </div>
  );
}
