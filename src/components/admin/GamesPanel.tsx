"use client";

import { useMemo } from "react";
import { Bug, Coins, Gamepad2, Radio, Users } from "lucide-react";
import { GAMES, gameAccent, playerCountLabel } from "@/lib/games";
import { CLOSED_STATUSES, type BugReport } from "@/lib/bugs";
import { useGameRollup, type AdminUser, type LiveLobby } from "@/lib/adminMetrics";
import { Card, Pill } from "./ui";

/**
 * Per-game health.
 *
 * "Players" here means accounts holding a balance in that game rather than
 * accounts that have launched it: a coin purse is the only per-game trace a
 * player leaves on their account record, since match counters are global.
 * Labelled accordingly so the number is not mistaken for a play count.
 */
export default function GamesPanel({
  users,
  lobbies,
  reports,
}: {
  users: AdminUser[];
  lobbies: LiveLobby[];
  reports: BugReport[];
}) {
  const { coinsByGame, playersByGame, roomsByGame } = useGameRollup(users, lobbies);

  const bugsByGame = useMemo(() => {
    const open = new Map<string, number>();
    const total = new Map<string, number>();
    for (const r of reports) {
      const key = r.gameId || "__platform__";
      total.set(key, (total.get(key) ?? 0) + 1);
      if (!CLOSED_STATUSES.includes(r.status)) open.set(key, (open.get(key) ?? 0) + 1);
    }
    return { open, total };
  }, [reports]);

  const platformBugs = bugsByGame.total.get("__platform__") ?? 0;

  return (
    <div className="space-y-6">
      <Card title="Games" subtitle={`${GAMES.length} in the catalog`}>
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {GAMES.map((g) => {
            const accent = gameAccent(g);
            const open = bugsByGame.open.get(g.id) ?? 0;
            const total = bugsByGame.total.get(g.id) ?? 0;
            const rooms = roomsByGame.get(g.id) ?? 0;
            return (
              <div
                key={g.id}
                className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 relative overflow-hidden"
              >
                <div
                  className="absolute inset-x-0 top-0 h-1"
                  style={{ background: `linear-gradient(90deg, ${accent.from}, ${accent.to})` }}
                />
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <p className="font-black text-white truncate">{g.name}</p>
                    <p className="text-[11px] text-text-muted truncate">
                      {g.category} · {playerCountLabel(g)} players
                    </p>
                  </div>
                  {g.available === false ? (
                    <Pill tone="neutral">hidden</Pill>
                  ) : rooms > 0 ? (
                    <Pill tone="good">{rooms} live</Pill>
                  ) : (
                    <Pill tone="neutral">idle</Pill>
                  )}
                </div>

                <dl className="grid grid-cols-3 gap-2 text-center">
                  <Metric
                    icon={<Users size={12} />}
                    label="purses"
                    value={playersByGame.get(g.id) ?? 0}
                  />
                  <Metric
                    icon={<Coins size={12} />}
                    label="coins"
                    value={(coinsByGame.get(g.id) ?? 0).toLocaleString()}
                  />
                  <Metric
                    icon={<Bug size={12} />}
                    label="bugs"
                    value={total}
                    tone={open > 0 ? "bad" : "default"}
                    hint={open > 0 ? `${open} open` : undefined}
                  />
                </dl>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid sm:grid-cols-3 gap-3">
        <Card title="Platform reports" subtitle="Filed outside any game">
          <p className="text-3xl font-black text-white">{platformBugs}</p>
        </Card>
        <Card title="Rooms open" subtitle="Across every game">
          <p className="text-3xl font-black text-white flex items-center gap-2">
            <Radio size={22} className="text-emerald-400" />
            {lobbies.length}
          </p>
        </Card>
        <Card title="Catalog" subtitle="Playable vs hidden">
          <p className="text-3xl font-black text-white flex items-center gap-2">
            <Gamepad2 size={22} className="text-primary" />
            {GAMES.filter((g) => g.available !== false).length}
            <span className="text-base text-text-muted font-bold">/ {GAMES.length}</span>
          </p>
        </Card>
      </div>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  tone = "default",
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone?: "default" | "bad";
  hint?: string;
}) {
  return (
    <div className="rounded-xl bg-white/5 py-2">
      <dt className="text-[9px] uppercase tracking-wider text-text-muted flex items-center justify-center gap-1">
        {icon}
        {label}
      </dt>
      <dd
        className={`text-sm font-black tabular-nums ${tone === "bad" ? "text-red-400" : "text-white"}`}
      >
        {value}
      </dd>
      {hint && <p className="text-[9px] text-red-300">{hint}</p>}
    </div>
  );
}
