"use client";

import { useMemo, useState } from "react";
import { Bug, ChevronRight, Coins, Loader2, Search, Trophy, Users } from "lucide-react";
import { BADGES, TESTER_PLUS_THRESHOLD, TESTER_THRESHOLD, topBadge } from "@/lib/badges";
import type { BugReport } from "@/lib/bugs";
import { timeAgo, type AdminUser } from "@/lib/adminMetrics";
import BadgeChip from "@/components/BadgeChip";
import PlayerDetailModal from "./PlayerDetailModal";
import { Avatar, Card, Empty, Pill, Stat } from "./ui";

/**
 * Every account, at a glance. Click one to open it.
 *
 * The row itself is read-only , grants and coin corrections live behind the
 * click, in PlayerDetailModal, so a row can be scanned without accidentally
 * flipping a switch meant for the player you're actually looking at.
 */
export default function PlayersPanel({
  users,
  loading,
  onlineUids,
  reports,
  onChanged,
}: {
  users: AdminUser[];
  loading: boolean;
  onlineUids: Set<string>;
  reports: BugReport[];
  onChanged: () => void;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"recent" | "games" | "wins" | "bugs">("games");
  const [selectedUid, setSelectedUid] = useState("");

  const reportsByUid = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of reports) map.set(r.uid, (map.get(r.uid) ?? 0) + 1);
    return map;
  }, [reports]);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = users.filter(
      (u) =>
        !needle ||
        u.email.toLowerCase().includes(needle) ||
        u.displayName.toLowerCase().includes(needle) ||
        u.uid.toLowerCase().includes(needle),
    );
    const key = {
      recent: (u: AdminUser) => u.createdAt?.toMillis?.() ?? 0,
      games: (u: AdminUser) => u.gamesPlayed,
      wins: (u: AdminUser) => u.wins,
      bugs: (u: AdminUser) => u.bugStats.approved,
    }[sort];
    return filtered.sort((a, b) => key(b) - key(a));
  }, [users, search, sort]);

  const selected = selectedUid ? users.find((u) => u.uid === selectedUid) ?? null : null;

  const testers = users.filter((u) => u.grants.tester === true).length;
  const premium = users.filter((u) => u.grants.premium === true).length;
  const totalCoins = users.reduce(
    (sum, u) => sum + Object.values(u.coins ?? {}).reduce((a, b) => a + Number(b ?? 0), 0),
    0,
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Accounts" value={users.length} icon={<Users size={13} />} />
        <Stat label="Online" value={onlineUids.size} tone="good" icon={<Users size={13} />} />
        <Stat label="Testers" value={testers} hint={`${premium} premium`} icon={<Bug size={13} />} />
        <Stat
          label="Coins in circulation"
          value={totalCoins.toLocaleString()}
          hint="all games combined"
          icon={<Coins size={13} />}
        />
      </div>

      <Card
        title="Players"
        subtitle={`${shown.length} shown`}
        right={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search"
                className="w-36 sm:w-48 bg-white/5 border border-white/10 rounded-xl pl-8 pr-3 py-1.5 text-xs text-white outline-none focus:border-primary/50"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              className="bg-white/5 border border-white/10 rounded-xl px-2 py-1.5 text-xs text-white outline-none"
            >
              <option value="games">Most played</option>
              <option value="wins">Most wins</option>
              <option value="bugs">Most approved bugs</option>
              <option value="recent">Newest</option>
            </select>
          </div>
        }
      >
        {loading ? (
          <div className="py-12 flex justify-center">
            <Loader2 size={26} className="animate-spin text-primary" />
          </div>
        ) : shown.length === 0 ? (
          <Empty icon={<Users size={36} />} text="No accounts match." />
        ) : (
          <div className="space-y-2">
            {shown.map((u) => {
              const badge = topBadge({
                gamesPlayed: u.gamesPlayed,
                wins: u.wins,
                bugsApproved: u.bugStats.approved,
                grants: u.grants,
              });
              const coins = Object.values(u.coins ?? {}).reduce((a, b) => a + Number(b ?? 0), 0);
              return (
                <button
                  key={u.uid}
                  onClick={() => setSelectedUid(u.uid)}
                  className="w-full text-left rounded-2xl border border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/5 p-3 flex flex-wrap items-center gap-3 transition-colors"
                >
                  <div className="relative">
                    <Avatar src={u.photoURL} uid={u.uid} size={36} />
                    {onlineUids.has(u.uid) && (
                      <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-[#141423]" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-bold text-white text-sm truncate">
                        {u.displayName || u.email || u.uid.slice(0, 8)}
                      </span>
                      <BadgeChip badge={badge} size="xs" />
                    </div>
                    <p className="text-[11px] text-text-muted truncate">
                      {u.email || u.uid} · joined {timeAgo(u.createdAt)}
                    </p>
                  </div>

                  <div className="flex items-center gap-3 text-[11px] text-text-secondary">
                    <span title="Games played" className="flex items-center gap-1">
                      <Trophy size={11} /> {u.gamesPlayed}
                      <span className="text-text-muted">/{u.wins}w</span>
                    </span>
                    <span title="Coins" className="flex items-center gap-1">
                      <Coins size={11} /> {coins.toLocaleString()}
                    </span>
                    <span title="Bug reports approved / filed" className="flex items-center gap-1">
                      <Bug size={11} /> {u.bugStats.approved}
                      <span className="text-text-muted">
                        /{reportsByUid.get(u.uid) ?? u.bugStats.submitted}
                      </span>
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 ml-auto">
                    {u.bugStats.approved > 0 && u.bugStats.approved < TESTER_THRESHOLD && (
                      <Pill tone="info">{TESTER_THRESHOLD - u.bugStats.approved} to Tester</Pill>
                    )}
                    <ChevronRight size={16} className="text-text-muted" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Badge catalog" subtitle="What players can earn, and how">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {BADGES.map((b) => (
            <div
              key={b.id}
              className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3"
            >
              <BadgeChip badge={b} showLabel={false} />
              <div className="min-w-0">
                <p className="text-sm font-bold text-white truncate">{b.label}</p>
                <p className="text-[11px] text-text-muted truncate">{b.description}</p>
              </div>
              <Pill tone={b.source === "stat" ? "neutral" : b.source === "bug" ? "good" : "warn"}>
                {b.source === "stat" ? "earned" : b.source === "bug" ? "bugs" : "granted"}
              </Pill>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-text-muted mt-3">
          Tester unlocks itself at {TESTER_THRESHOLD} approved reports, Tester+ at{" "}
          {TESTER_PLUS_THRESHOLD}. Open a player to override either by hand.
        </p>
      </Card>

      {selected && (
        <PlayerDetailModal
          user={selected}
          online={onlineUids.has(selected.uid)}
          reports={reports}
          onClose={() => setSelectedUid("")}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

