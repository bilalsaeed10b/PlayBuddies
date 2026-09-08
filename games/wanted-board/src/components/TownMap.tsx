/**
 * The town: a wagon wheel of nine places, everybody's piece on one of them.
 *
 * Drawn in DOM and SVG rather than on a canvas, which is the right call for a
 * game whose entire animation budget is "a token slides to a neighbouring
 * place once every twenty seconds". A CSS transform transition does that for
 * free, at whatever the display's refresh rate is, and it stays crisp on a
 * phone without anybody having to think about backing stores or device pixel
 * ratios — none of which a canvas would have given us here.
 */
import { useEffect, useRef, useState } from 'react';
import { BANK, PLACES, ROADS, SEAT_COLORS } from '../game/rules';
import OutlawToken from './OutlawToken';
import type { Seat, WantedEngine } from '../engine/WantedEngine';

/**
 * The largest square that fits the space this map has been given.
 *
 * Measured rather than expressed in CSS, because a square that has to fit
 * *both* a width and a height is the one thing `aspect-ratio` cannot express
 * on its own: with an explicit width it derives a height and lets `max-height`
 * clip rather than shrink, so a phone in landscape drew a 293px board into a
 * 167px slot and the town sat on top of the roster. A ResizeObserver and one
 * `min()` is less code than the CSS that almost works.
 */
function useSquare(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      setSize(Math.max(0, Math.floor(Math.min(box.width, box.height))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

/**
 * Where a token sits when several share one place.
 *
 * Fanned along a short arc rather than stacked, so four pieces in the Saloon
 * are four readable pieces and not a pile with one face showing. The offsets
 * are in percentage points of the board box, matching PLACES' own units.
 */
function fan(index: number, count: number): { dx: number; dy: number } {
  if (count <= 1) return { dx: 0, dy: 0 };
  const spread = Math.min(9, 4.5 * (count - 1));
  const t = count === 1 ? 0 : index / (count - 1) - 0.5;
  return { dx: t * spread * 2, dy: Math.abs(t) * 2.2 - 1.1 };
}

export default function TownMap({
  engine,
  seats,
  /** Seats driven from this device — theirs are the pieces drawn largest. */
  localSeats,
  /** Places the current chooser may ride to, lit up while they are deciding. */
  highlight,
  onPick,
  /** This seat's own trap, if it has one. Nobody ever sees anybody else's. */
  myTrap,
  /** Who is laying low, once the round has been revealed. Empty while choosing. */
  hiddenSeats,
  /** What the current reveal beat has somebody saying, and where. */
  bubbles,
}: {
  engine: WantedEngine;
  seats: Seat[];
  localSeats: number[];
  highlight: number[];
  onPick?: (place: number) => void;
  myTrap?: number;
  hiddenSeats: number[];
  bubbles?: { seat: number; text: string }[];
}) {
  const [box, size] = useSquare();
  // A bank-and-spoke wheel needs more room to stay readable than the old
  // ring did — nine places drawn into the same 560px cap the six-place ring
  // used sat cramped, especially the four rim-only places tucked between a
  // spoke and its neighbour.
  // Minus a marker's worth of room. Every place is drawn centred on its point
  // on the square and then pulled back by half its own size, so a place sitting
  // on the rim hangs outside the square by half a token -- about 28px. The
  // square itself always fitted; the pieces standing on its edge did not, and
  // the row's `overflow-hidden` cut the bottom one off with no way to reach it.
  const edge = Math.max(0, Math.min(size - 56, 760));
  return (
    <div ref={box} className="flex h-full w-full items-center justify-center">
      {/* shrink-0 is load-bearing: the wrapper is a row flex, so without it the
          square is a flex item free to have its *width* squeezed while its
          explicit height stays put — which drew a 186x298 "square". */}
      <div className="relative shrink-0" style={{ width: edge, height: edge }}>
      {/* Roads. Under everything, and deliberately faint — the graph is a fact
          about the rules, not the thing you should be looking at. Four spokes
          plus the rim, not a single loop, so "which roads reach the Bank
          directly" is something the map itself shows rather than something a
          player has to remember. */}
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden>
        {ROADS.map(([a, b]) => (
          <line
            key={`${a}-${b}`}
            x1={PLACES[a].x}
            y1={PLACES[a].y}
            x2={PLACES[b].x}
            y2={PLACES[b].y}
            stroke="#8b6f47"
            strokeWidth={a === BANK || b === BANK ? '1.1' : '0.9'}
            strokeDasharray="2.4 2"
            opacity={a === BANK || b === BANK ? '0.7' : '0.5'}
          />
        ))}
      </svg>

      {PLACES.map((place, i) => {
        const lit = highlight.includes(i);
        const isBank = i === BANK;
        return (
          <button
            key={place.name}
            type="button"
            disabled={!lit || !onPick}
            onClick={() => onPick?.(i)}
            className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-2xl border-2 px-2 py-1.5 text-center transition-all ${
              lit
                ? 'border-rose-700 bg-rose-100/90 shadow-[0_0_0_5px_rgba(190,18,60,0.16)]'
                : isBank
                  ? 'border-amber-800/60 bg-amber-100/80'
                  : 'border-amber-900/25 bg-[#f7ecd6]/80'
            } ${lit && onPick ? 'cursor-pointer active:scale-95' : 'cursor-default'}`}
            style={{ left: `${place.x}%`, top: `${place.y}%`, width: isBank ? '29%' : '24%' }}
          >
            <span className="text-[11px] font-black uppercase leading-none tracking-[0.12em] text-amber-950 sm:text-sm">
              {place.name}
            </span>
            <span className="mt-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-900/45 sm:text-[10px]">
              {isBank ? 'cash in here' : place.tag}
            </span>
            {myTrap === i && (
              /* Only ever your own. A trap the whole table could see would not
                 be a trap, and this is the one piece of private information on
                 the board. */
              <span className="mt-0.5 rounded-full bg-amber-900 px-1.5 py-px text-[7px] font-black uppercase tracking-wider text-amber-100 sm:text-[8px]">
                your trap
              </span>
            )}
          </button>
        );
      })}

      {/* Pieces, positioned absolutely and keyed by seat so React keeps the
          same node across a move and the CSS transition actually runs. */}
      {seats.map((seat, i) => {
        const state = engine.players[i];
        if (!state) return null;
        const place = PLACES[state.place];
        const here = engine.seatsAt(state.place);
        const { dx, dy } = fan(here.indexOf(i), here.length);
        const mine = localSeats.includes(i);
        const colors = SEAT_COLORS[i % SEAT_COLORS.length];
        const bubbleText = bubbles?.find((b) => b.seat === i)?.text;
        return (
          <div
            key={seat.id}
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 transition-[left,top] duration-700 ease-in-out"
            style={{ left: `${place.x + dx}%`, top: `${place.y + dy + 9}%`, zIndex: bubbleText ? 50 : 10 + i }}
          >
            <div className="relative flex flex-col items-center">
              {bubbleText && (
                <span
                  key={`${i}-${bubbleText}`}
                  className="absolute -top-2 left-1/2 z-10 w-max max-w-[38vw] -translate-x-1/2 -translate-y-full animate-[bubble_1.7s_ease-out] rounded-xl border border-amber-900/20 bg-white px-2 py-1 text-[10px] font-bold leading-tight text-amber-950 shadow-md sm:max-w-[220px] sm:text-[11px]"
                >
                  {bubbleText}
                  <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-amber-900/20 bg-white" />
                </span>
              )}
              <OutlawToken
                skin={seat.skin}
                size={mine ? 42 : 34}
                ring={colors.main}
                hidden={hiddenSeats.includes(i)}
              />
              <span
                className="mt-0.5 rounded-full px-1.5 text-[8px] font-black tabular-nums text-white shadow-sm sm:text-[9px]"
                style={{ background: colors.main }}
              >
                ${state.bounty}
              </span>
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}
