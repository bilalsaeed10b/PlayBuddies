"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Check, Gem, Lock, Target } from "lucide-react";
import GameThumb from "@/components/GameThumb";
import { PLAYABLE_GAMES, getGame } from "@/lib/games";
import {
  DAILY_CHALLENGE_CAP,
  GEMS_PER_CHALLENGE,
  goalOf,
  msUntilReset,
  todaysChallenges,
  type ChallengeState,
} from "@/lib/challenges";

function resetLabel(ms: number): string {
  const mins = Math.max(0, Math.ceil(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Today's card: one challenge per game, any three of them paying gems.
 *
 * A card is a way into its game, not just a scoreboard , tapping one opens a
 * lobby for that game, which is the one thing a player looking at "win a round
 * of mini golf" is about to want.
 */
export default function DailyChallenges({
  state,
  onPlay,
}: {
  state: ChallengeState;
  onPlay: (gameId: string) => void;
}) {
  const cards = useMemo(() => todaysChallenges(PLAYABLE_GAMES.map((g) => g.id), state.day), [state.day]);
  const [left, setLeft] = useState(msUntilReset);
  useEffect(() => {
    const t = setInterval(() => setLeft(msUntilReset()), 30_000);
    return () => clearInterval(t);
  }, []);

  const doneCount = state.done.length;
  const capped = doneCount >= DAILY_CHALLENGE_CAP;

  return (
    <section className="mb-16">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
        <h2 className="flex items-center gap-2 text-2xl font-bold text-white">
          <Target size={24} className="text-cyan-300" />
          Daily challenges
        </h2>
        <div className="flex items-center gap-3 text-sm">
          <div className="flex items-center gap-1.5">
            {Array.from({ length: DAILY_CHALLENGE_CAP }, (_, i) => (
              <span
                key={i}
                className={`h-2.5 w-7 rounded-full ${
                  i < doneCount ? "bg-gradient-to-r from-cyan-400 to-violet-500" : "bg-white/10"
                }`}
              />
            ))}
          </div>
          <span className="font-bold text-white">
            {doneCount}/{DAILY_CHALLENGE_CAP} today
          </span>
          <span className="text-text-muted">· new in {resetLabel(left)}</span>
        </div>
      </div>
      <p className="mb-6 text-sm text-text-muted">
        Finish any {DAILY_CHALLENGE_CAP} for {GEMS_PER_CHALLENGE} gems each. Gems only come from here, never from
        matches.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c, i) => {
          const game = getGame(c.gameId);
          if (!game) return null;
          const goal = goalOf(c);
          const done = state.done.includes(c.gameId);
          const progress = Math.min(goal, state.progress[c.gameId] ?? 0);
          const locked = capped && !done;
          return (
            <motion.button
              key={c.id}
              type="button"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
              onClick={() => onPlay(c.gameId)}
              className={`glass group relative flex flex-col gap-3 rounded-2xl border p-4 text-left transition-colors ${
                done
                  ? "border-cyan-300/40 bg-cyan-400/[0.07]"
                  : locked
                    ? "border-white/5 opacity-60"
                    : "border-white/5 hover:border-white/15 hover:bg-white/5"
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl">
                  <GameThumb game={game} size={44} className="h-full w-full" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-bold uppercase tracking-wider text-text-muted">{game.name}</p>
                  <p className="text-sm font-bold leading-snug text-white">{c.title}</p>
                </div>
              </div>

              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-500 transition-[width] duration-500"
                  style={{ width: `${(done ? 1 : progress / goal) * 100}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-xs font-bold">
                <span className="text-text-muted">
                  {done ? "Complete" : goal > 1 ? `${progress}/${goal}` : progress >= 1 ? "Done" : "Not yet"}
                </span>
                {done ? (
                  <span className="flex items-center gap-1 text-cyan-300">
                    <Check size={14} /> +{GEMS_PER_CHALLENGE}
                    <Gem size={13} />
                  </span>
                ) : locked ? (
                  <span className="flex items-center gap-1 text-text-muted">
                    <Lock size={12} /> Daily limit
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-cyan-300">
                    +{GEMS_PER_CHALLENGE}
                    <Gem size={13} />
                  </span>
                )}
              </div>
            </motion.button>
          );
        })}
      </div>
    </section>
  );
}
