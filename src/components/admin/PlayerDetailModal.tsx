"use client";

import { useState } from "react";
import { Bug, Coins, Gem, Loader2, Sparkles, Trophy, X } from "lucide-react";
import { PLAYABLE_GAMES, getGame } from "@/lib/games";
import { adjustCoins, adjustGems, setGrant } from "@/lib/adminActions";
import { topBadge } from "@/lib/badges";
import type { BugReport } from "@/lib/bugs";
import { timeAgo, type AdminUser } from "@/lib/adminMetrics";
import BadgeChip from "@/components/BadgeChip";
import { Avatar, Pill } from "./ui";

const CLOSED = ["approved", "rejected", "duplicate"];

/**
 * One player, opened up.
 *
 * The coin editor is the reason this exists: `adjustCoins` writes straight to
 * Firestore the moment Apply is pressed, no confirmation dialog, because a
 * coin correction is meant to be as cheap to make as it is to notice was
 * needed , and it is reversible by applying the opposite amount, unlike the
 * grant switches or closing a room.
 */
export default function PlayerDetailModal({
  user,
  online,
  reports,
  onClose,
  onChanged,
}: {
  user: AdminUser;
  online: boolean;
  reports: BugReport[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [gameId, setGameId] = useState(PLAYABLE_GAMES[0]?.id ?? "");
  const [amount, setAmount] = useState(100);
  // Goes into the message the player actually reads. A reward that arrives
  // with no explanation is indistinguishable from a bug in the wallet.
  const [reason, setReason] = useState("");
  const [gemAmount, setGemAmount] = useState(20);
  const [gemReason, setGemReason] = useState("");

  const badge = topBadge({
    gamesPlayed: user.gamesPlayed,
    wins: user.wins,
    bugsApproved: user.bugStats.approved,
    grants: user.grants,
  });

  const theirReports = reports.filter((r) => r.uid === user.uid).slice(0, 8);
  const coinEntries = Object.entries(user.coins ?? {}).filter(([, v]) => Number(v) !== 0);

  const toggleGrant = async (key: "premium" | "tester" | "testerPlus", next: boolean) => {
    setBusy(true);
    setError("");
    try {
      await setGrant(user.uid, key, next);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change that grant.");
    } finally {
      setBusy(false);
    }
  };

  const applyCoins = async (sign: 1 | -1) => {
    if (!gameId || amount === 0) return;
    setBusy(true);
    setError("");
    try {
      await adjustCoins(user.uid, gameId, sign * Math.abs(amount), reason);
      setReason("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change that balance.");
    } finally {
      setBusy(false);
    }
  };

  const applyGems = async (sign: 1 | -1) => {
    if (gemAmount === 0) return;
    setBusy(true);
    setError("");
    try {
      await adjustGems(user.uid, sign * Math.abs(gemAmount), gemReason);
      setGemReason("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the gem balance.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-solid bg-[#141423] w-full max-w-lg rounded-3xl border border-white/10 shadow-2xl max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-3 p-5 border-b border-white/10 sticky top-0 bg-[#141423] z-10">
          <div className="flex items-center gap-3 min-w-0">
            <div className="relative shrink-0">
              <Avatar src={user.photoURL} uid={user.uid} size={44} />
              {online && (
                <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-emerald-400 border-2 border-[#141423]" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <p className="font-black text-white truncate">
                  {user.displayName || user.email || user.uid.slice(0, 8)}
                </p>
                <BadgeChip badge={badge} size="xs" />
              </div>
              <p className="text-[11px] text-text-muted truncate">{user.email || "no email on file"}</p>
              <p className="text-[10px] text-text-muted font-mono truncate">{user.uid}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-text-muted shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div className="grid grid-cols-4 gap-2">
            <MiniStat label="Played" value={user.gamesPlayed} />
            <MiniStat label="Won" value={user.wins} />
            <MiniStat label="Bugs OK" value={user.bugStats.approved} />
            <MiniStat label="Joined" value={timeAgo(user.createdAt)} small />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-text-muted mb-2">
              Gift a badge
            </h3>
            <div className="flex flex-wrap gap-2">
              <GrantToggle
                label="Tester"
                on={user.grants.tester === true}
                busy={busy}
                onToggle={(v) => toggleGrant("tester", v)}
              />
              <GrantToggle
                label="Tester+"
                on={user.grants.testerPlus === true}
                busy={busy}
                onToggle={(v) => toggleGrant("testerPlus", v)}
              />
              <GrantToggle
                label="Premium+"
                icon={<Sparkles size={11} />}
                on={user.grants.premium === true}
                busy={busy}
                onToggle={(v) => toggleGrant("premium", v)}
              />
            </div>
            <p className="mt-2 text-[10px] text-text-muted leading-relaxed">
              Unlocks the badge and tells them so. Which one they actually wear is their choice,
              made from their own profile , this does not put it on for them.
            </p>
          </section>

          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-text-muted mb-2">
              Coins
            </h3>
            {coinEntries.length > 0 && (
              <div className="grid grid-cols-2 gap-1.5 mb-3">
                {coinEntries.map(([gid, v]) => (
                  <div
                    key={gid}
                    className="flex items-center justify-between rounded-lg bg-white/5 px-2.5 py-1.5 text-xs"
                  >
                    <span className="text-text-secondary truncate">{getGame(gid)?.name ?? gid}</span>
                    <span className="font-bold text-white tabular-nums">{Number(v).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2">
              <select
                value={gameId}
                onChange={(e) => setGameId(e.target.value)}
                className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-xl px-2.5 py-2 text-xs text-white outline-none"
              >
                {PLAYABLE_GAMES.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                value={amount}
                onChange={(e) => setAmount(Math.max(1, Math.round(Number(e.target.value) || 0)))}
                className="w-20 bg-white/5 border border-white/10 rounded-xl px-2.5 py-2 text-xs text-white outline-none tabular-nums"
              />
              <button
                disabled={busy}
                onClick={() => applyCoins(1)}
                className="px-3 py-2 rounded-xl bg-emerald-500/20 text-emerald-300 text-xs font-bold hover:bg-emerald-500/30 disabled:opacity-40 transition-colors flex items-center gap-1"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Coins size={12} />}
                Add
              </button>
              <button
                disabled={busy}
                onClick={() => applyCoins(-1)}
                className="px-3 py-2 rounded-xl bg-red-500/15 text-red-300 text-xs font-bold hover:bg-red-500/25 disabled:opacity-40 transition-colors"
              >
                Take
              </button>
            </div>

            <input
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 200))}
              placeholder="Why? e.g. Reward for finding the Quoridor bot bug"
              className="mt-2 w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2 text-xs text-white outline-none placeholder:text-text-muted/60"
            />
            <p className="mt-1 text-[10px] text-text-muted">
              This is the message that lands in their inbox. Left blank, they just see the amount.
            </p>
          </section>

          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-text-muted mb-2 flex items-center gap-1.5">
              Gems <span className="text-white tabular-nums">· {user.gems.toLocaleString()}</span>
            </h3>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={gemAmount}
                onChange={(e) => setGemAmount(Math.max(1, Math.round(Number(e.target.value) || 0)))}
                className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-xl px-2.5 py-2 text-xs text-white outline-none tabular-nums"
              />
              <button
                disabled={busy}
                onClick={() => applyGems(1)}
                className="px-3 py-2 rounded-xl bg-cyan-500/20 text-cyan-300 text-xs font-bold hover:bg-cyan-500/30 disabled:opacity-40 transition-colors flex items-center gap-1"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Gem size={12} />}
                Add
              </button>
              <button
                disabled={busy}
                onClick={() => applyGems(-1)}
                className="px-3 py-2 rounded-xl bg-red-500/15 text-red-300 text-xs font-bold hover:bg-red-500/25 disabled:opacity-40 transition-colors"
              >
                Take
              </button>
            </div>
            <input
              value={gemReason}
              onChange={(e) => setGemReason(e.target.value.slice(0, 200))}
              placeholder="Why? e.g. Chest pack, paid 18 Sep"
              className="mt-2 w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2 text-xs text-white outline-none placeholder:text-text-muted/60"
            />
            <p className="mt-1 text-[10px] text-text-muted">
              Until card payments are live, this is how a purchase gets credited.
            </p>
          </section>

          {theirReports.length > 0 && (
            <section>
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-text-muted mb-2">
                Bug reports filed
              </h3>
              <div className="space-y-1.5">
                {theirReports.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center gap-2 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs"
                  >
                    <Bug size={12} className="text-text-muted shrink-0" />
                    <span className="text-text-secondary truncate flex-1">{r.title}</span>
                    <Pill tone={CLOSED.includes(r.status) ? (r.status === "approved" ? "good" : "neutral") : "warn"}>
                      {r.status}
                    </Pill>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, small }: { label: string; value: React.ReactNode; small?: boolean }) {
  return (
    <div className="rounded-xl bg-white/5 py-2 text-center">
      <p className="text-[9px] uppercase tracking-wider text-text-muted flex items-center justify-center gap-1">
        {label === "Won" && <Trophy size={9} />}
        {label}
      </p>
      <p className={`font-black text-white tabular-nums ${small ? "text-[11px]" : "text-sm"}`}>{value}</p>
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
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors disabled:opacity-40 ${
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
