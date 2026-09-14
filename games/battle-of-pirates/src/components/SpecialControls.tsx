import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CloudRain, Crosshair, Heart, Sparkles, X } from 'lucide-react';

export type SpecialKind = 'torpedo' | 'acid-rain' | 'heal';

export interface SpecialControlsProps {
  charge: number;
  enabled: boolean;
  targeting: boolean;
  ships: { id: string; name: string; team: 0 | 1; hp: number; maxHp: number }[];
  shooter: number;
  onUse: (kind: SpecialKind) => void;
  onBeginTargeting: (kind: SpecialKind) => void;
  onCancelTargeting: () => void;
  onOpenChange?: (open: boolean) => void;
}

const OPTIONS = [
  { id: 'torpedo', name: 'Torpedo', amount: '25 damage', scope: 'Drag onto one ship', Icon: Crosshair },
  { id: 'acid-rain', name: 'Acid Rain', amount: '10 damage', scope: 'Every enemy', Icon: CloudRain },
  { id: 'heal', name: 'Heal', amount: '20-25 HP', scope: 'Any friendly ship', Icon: Heart },
] as const;

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950';

/** Compact card fan over the sea. It never obscures the battle with a modal. */
export default function SpecialControls({
  charge,
  enabled,
  targeting,
  ships,
  shooter,
  onUse,
  onBeginTargeting,
  onCancelTargeting,
  onOpenChange,
}: SpecialControlsProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const changeRef = useRef(onOpenChange);
  const [open, setOpen] = useState(false);
  const charges = Math.max(0, Math.min(3, Math.floor(Number.isFinite(charge) ? charge : 0)));
  const ship = ships[shooter];
  const enemies = ships.filter((enemy) => enemy.hp > 0 && ship && enemy.team !== ship.team);
  const teamHealing = ship ? ships.some(s => s.team === ship.team && s.hp > 0 && s.hp < s.maxHp) : false;
  const ready = charges === 3;
  const canOpen = enabled && ready && Boolean(ship && ship.hp > 0);

  useEffect(() => { changeRef.current = onOpenChange; }, [onOpenChange]);
  const close = useCallback(() => {
    setOpen(false);
    changeRef.current?.(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', escape);
    };
  }, [open, close]);

  useEffect(() => {
    if (open && !canOpen) close();
  }, [open, canOpen, close]);

  const choose = (kind: SpecialKind) => {
    if (!canOpen) return;
    close();
    if (kind === 'torpedo' || kind === 'heal') onBeginTargeting(kind);
    else onUse(kind);
  };

  return (
    <div
      ref={rootRef}
      className="absolute bottom-[112px] left-3 z-30 w-[148px] [@media(max-height:559px)]:bottom-[84px]"
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {open && (
        <section
          id={`${id}-picker`}
          role="dialog"
          aria-label="Choose a special attack"
          className="absolute bottom-full left-0 mb-2 w-[min(390px,calc(100vw_-_24px))] rounded-2xl border border-amber-200/35 bg-slate-950/95 p-2 shadow-2xl backdrop-blur-lg"
        >
          <div className="mb-1.5 flex items-center gap-2 px-1">
            <Sparkles aria-hidden="true" className="h-4 w-4 text-amber-300" />
            <strong className="flex-1 text-[11px] text-amber-100">Choose one · uses your turn</strong>
            <button type="button" aria-label="Close special cards" onClick={close} className={`flex h-8 w-8 items-center justify-center rounded-lg text-white/60 hover:bg-white/10 ${focusRing}`}>
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {OPTIONS.map(({ id: option, name, amount, scope, Icon }) => {
              const unavailable = option === 'heal' ? !teamHealing : enemies.length === 0;
              return (
                <button
                  key={option}
                  type="button"
                  disabled={unavailable}
                  onClick={() => choose(option)}
                  className={`group flex min-h-[102px] min-w-0 touch-manipulation flex-col items-center justify-center rounded-xl border border-white/15 bg-white/[0.06] px-1.5 py-2 text-center transition hover:-translate-y-1 hover:border-amber-300/70 hover:bg-amber-300/10 disabled:translate-y-0 disabled:opacity-35 ${focusRing}`}
                >
                  <Icon aria-hidden="true" className={`mb-1 h-5 w-5 ${option === 'heal' ? 'text-emerald-300' : option === 'acid-rain' ? 'text-lime-300' : 'text-sky-300'}`} />
                  <span className="text-[11px] font-black leading-4 text-white">{name}</span>
                  <span className="text-[10px] font-bold leading-4 text-amber-200">{amount}</span>
                  <span className="text-[9px] leading-3 text-white/55">{option === 'heal' && !teamHealing ? 'Team HP full' : scope}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${id}-picker`}
        aria-disabled={targeting ? false : !canOpen}
        onClick={() => {
          if (targeting) { onCancelTargeting(); return; }
          if (!canOpen) return;
          const next = !open;
          setOpen(next);
          changeRef.current?.(next);
        }}
        className={`flex min-h-12 w-full touch-manipulation items-center gap-2 rounded-xl border px-2.5 py-2 text-left shadow-lg transition-colors ${focusRing} ${
          targeting
            ? 'border-sky-300 bg-sky-950/95 text-sky-100 shadow-sky-300/20'
            : canOpen
              ? 'border-amber-300/70 bg-slate-950/95 text-amber-100 shadow-amber-400/10 hover:bg-slate-900 active:bg-slate-800'
              : 'border-white/20 bg-slate-950/85 text-slate-300'
        }`}
      >
        {targeting ? <Crosshair aria-hidden="true" className="h-4 w-4 shrink-0 text-sky-300" /> : <Sparkles aria-hidden="true" className={`h-4 w-4 shrink-0 ${ready ? 'text-amber-300' : 'text-slate-400'}`} />}
        <span className="min-w-0 flex-1">
          <span className="block whitespace-nowrap text-[11px] font-black leading-4">
            {targeting ? 'Cancel targeting' : ready ? 'Special ready' : 'Special attack'}
          </span>
          {targeting ? (
            <span className="block text-[9px] leading-3 text-sky-200/70">Tap to cancel</span>
          ) : (
            <span aria-hidden="true" className="mt-1 flex items-center gap-1">
              {[1, 2, 3].map((step) => <span key={step} className={`h-1.5 flex-1 rounded-full ${charges >= step ? 'bg-amber-300' : 'bg-slate-600'}`} />)}
              <span className="ml-1 text-[10px] font-bold leading-none tabular-nums">{charges}/3</span>
            </span>
          )}
        </span>
      </button>
      <span role="progressbar" aria-label="Special attack charge" aria-valuemin={0} aria-valuemax={3} aria-valuenow={charges} className="sr-only">
        {charges} of 3 successful attacks.
      </span>
    </div>
  );
}
