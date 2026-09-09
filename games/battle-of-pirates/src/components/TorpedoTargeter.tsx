import { useCallback, useEffect, useRef, useState } from 'react';
import { Crosshair, X } from 'lucide-react';

interface Point { x: number; y: number }

/** A direct sea gesture: press anywhere, drag the reticle onto a ship, release. */
export default function TorpedoTargeter({
  bottomInset,
  onTarget,
  onCancel,
}: {
  bottomInset: number;
  onTarget: (clientX: number, clientY: number, bounds: DOMRect) => boolean;
  onCancel: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const [start, setStart] = useState<Point | null>(null);
  const [point, setPoint] = useState<Point | null>(null);
  const [missed, setMissed] = useState(false);

  const abort = useCallback(() => {
    pointer.current = null;
    setStart(null);
    setPoint(null);
  }, []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', key);
    window.addEventListener('blur', abort);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', abort);
    };
  }, [abort, onCancel]);

  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== null) return;
    event.preventDefault();
    pointer.current = event.pointerId;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* continue inside the sea */ }
    const p = { x: event.clientX, y: event.clientY };
    setStart(p); setPoint(p); setMissed(false);
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId) return;
    setPoint({ x: event.clientX, y: event.clientY });
  };
  const up = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    const bounds = rootRef.current?.getBoundingClientRect();
    const hit = Boolean(bounds && onTarget(event.clientX, event.clientY, bounds));
    setStart(null); setPoint(null); setMissed(!hit);
  };

  return (
    <div
      ref={rootRef}
      className="absolute inset-x-0 top-[52px] z-[25] touch-none select-none"
      style={{ bottom: bottomInset }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={abort}
    >
      <div className={`pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full border px-3 py-1 text-center text-[10px] font-black uppercase tracking-wider backdrop-blur-md ${missed ? 'border-rose-300/60 bg-rose-950/85 text-rose-100' : 'border-sky-300/50 bg-slate-950/80 text-sky-100'}`}>
        {missed ? 'Missed the ship · drag again' : 'Drag the torpedo onto an enemy ship'}
      </div>
      <button
        type="button"
        aria-label="Cancel torpedo targeting"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onCancel}
        className="absolute right-3 top-2 flex h-9 w-9 touch-manipulation items-center justify-center rounded-full border border-white/20 bg-slate-950/80 text-white/70 backdrop-blur-md hover:bg-slate-800"
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
      {point && (
        <svg aria-hidden="true" className="pointer-events-none fixed inset-0 h-full w-full overflow-visible">
          {start && <line x1={start.x} y1={start.y} x2={point.x} y2={point.y} stroke="rgba(125,211,252,.72)" strokeWidth="4" strokeDasharray="8 8" />}
          <circle cx={point.x} cy={point.y} r="34" fill="rgba(14,116,144,.13)" stroke="#7dd3fc" strokeWidth="3" />
          <circle cx={point.x} cy={point.y} r="12" fill="none" stroke="#e0f2fe" strokeWidth="2" />
          <path d={`M ${point.x - 48} ${point.y} H ${point.x - 16} M ${point.x + 16} ${point.y} H ${point.x + 48} M ${point.x} ${point.y - 48} V ${point.y - 16} M ${point.x} ${point.y + 16} V ${point.y + 48}`} stroke="#e0f2fe" strokeWidth="3" />
        </svg>
      )}
      {!point && <Crosshair aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 text-sky-200/25" />}
    </div>
  );
}
