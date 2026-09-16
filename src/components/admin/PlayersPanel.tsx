"use client";

import { useMemo, useState } from "react";
import { Bug, Coins, Loader2, Search, Sparkles, Trophy, Users } from "lucide-react";
import { BADGES, TESTER_PLUS_THRESHOLD, TESTER_THRESHOLD, topBadge } from "@/lib/badges";
import { setGrant } from "@/lib/bugs";
import type { BugReport } from "@/lib/bugs";
import { timeAgo, type AdminUser } from "@/lib/adminMetrics";
import BadgeChip from "@/components/BadgeChip";
import { Avatar, Card, Empty, Pill, Stat } from "./ui";

/**
 * Every account, what they have earned, and the manual overrides.
 *
 * The grant switches here are the only way premium is ever awarded, and the
 * only way a tester tier is given out without the ten approved reports behind
 * it. They write to `users/{uid}.grants`, which the rules make admin-only ,
 * that is what stops the badge from being self-serve.
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
  const [busyUid, setBusyUid] = useState("");
  const [error, setError] = useState("");

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

  const toggleGrant = async (uid: string, key: "premium" | "tester" | "testerPlus", next: boolean) => {
    setBusyUid(uid);
    setError("");
    try {
      await setGrant(uid, key, next);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change that grant.");
    } finally {
      setBusyUid("");
    }
  };

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
        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

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
                <div
                  key={u.uid}
                  className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 flex flex-wrap items-center gap-3"
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
                      <Pill tone="info">
                        {TESTER_THRESHOLD - u.bugStats.approved} to Tester
                      </Pill>
                    )}
                    <GrantToggle
                      label="Tester"
                      on={u.grants.tester === true}
                      busy={busyUid === u.uid}
                      onToggle={(next) => toggleGrant(u.uid, "tester", next)}
                    />
                    <GrantToggle
                      label="Tester+"
                      on={u.grants.testerPlus === true}
                      busy={busyUid === u.uid}
                      onToggle={(next) => toggleGrant(u.uid, "testerPlus", next)}
                    />
                    <GrantToggle
                      label="Premium"
                      icon={<Sparkles size={10} />}
                      on={u.grants.premium === true}
                      busy={busyUid === u.uid}
                      onToggle={(next) => toggleGrant(u.uid, "premium", next)}
                    />
                  </div>
                </div>
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
          {TESTER_PLUS_THRESHOLD}. The switches above override that either way.
        </p>
      </Card>
    </div>
  );
}

function GrantToggle({
  label,
  on,
  busy,
  icon,
  onToggle,
}: {
  label: string;
  on: boolean;
  busy: boolean;
  icon?: React.ReactNode;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      disabled={busy}
      onClick={() => onToggle(!on)}
      title={`${on ? "Remove" : "Grant"} ${label}`}
      className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold border transition-colors disabled:opacity-40 ${
        on
          ? "border-amber-400/50 bg-amber-400/15 text-amber-300"
          : "border-white/10 text-text-muted hover:border-white/25"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
