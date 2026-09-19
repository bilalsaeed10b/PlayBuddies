"use client";

import { useState } from "react";
import { Ban, Loader2, MessageSquare, RotateCcw, ShieldCheck, Trophy } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import { PLAYABLE_GAMES } from "@/lib/games";
import { resetChallenges, resetGameWallet, sendNote, setStats } from "@/lib/adminActions";
import type { AdminUser } from "@/lib/adminMetrics";
import { liftSuspension, suspendPlayer, suspensionActive, useSuspensions } from "@/lib/platformConfig";
import { isAdminEmail } from "@/lib/admin";
import { Pill } from "./ui";

/**
 * The heavier levers on one account, below the badge and balance editors.
 *
 * Suspension is enforced by the pages the player opens (see PlatformNotices):
 * there is no server to refuse them outright. It is for an honest crowd, the
 * same as maintenance mode , a determined player with a modified client is a
 * rules problem, not a switch.
 */
export default function PlayerControls({ user, onChanged }: { user: AdminUser; onChanged: () => void }) {
  const admin = useAuthStore((s) => s.user);
  const suspensions = useSuspensions(true);
  const suspension = suspensions[user.uid] ?? null;
  const suspended = suspensionActive(suspension);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const [reason, setReason] = useState("");
  const [hours, setHours] = useState(24);
  const [mTitle, setMTitle] = useState("");
  const [mBody, setMBody] = useState("");
  const [games, setGames] = useState(user.gamesPlayed);
  const [wins, setWins] = useState(user.wins);
  const [walletGame, setWalletGame] = useState(PLAYABLE_GAMES[0]?.id ?? "");

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setError("");
    setNote("");
    try {
      const msg = await fn();
      if (msg) setNote(msg);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not go through.");
    } finally {
      setBusy("");
    }
  };

  const isAdminAccount = isAdminEmail(user.email);
  const input = "bg-white/5 border border-white/10 rounded-xl px-2.5 py-2 text-xs text-white outline-none placeholder:text-text-muted/60";
  const spin = (key: string, icon: React.ReactNode) => (busy === key ? <Loader2 size={12} className="animate-spin" /> : icon);

  return (
    <section className="space-y-5 border-t border-white/10 pt-5">
      {(note || error) && <p className={`text-xs ${error ? "text-red-400" : "text-emerald-300"}`}>{error || note}</p>}

      {/* suspend */}
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-text-muted">
          Account status {suspended ? <Pill tone="bad">suspended</Pill> : <Pill tone="good">active</Pill>}
        </h3>
        {suspended ? (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-red-500/10 p-3">
            <p className="text-xs text-red-100">
              {suspension.reason || "No reason given"} ·{" "}
              {suspension.until ? `until ${new Date(suspension.until).toLocaleString()}` : "indefinite"}
            </p>
            <button
              onClick={() => void run("lift", async () => { await liftSuspension(user.uid); return "Suspension lifted."; })}
              className="flex shrink-0 items-center gap-1 rounded-xl bg-emerald-500/20 px-3 py-2 text-xs font-bold text-emerald-300"
            >
              {spin("lift", <ShieldCheck size={12} />)} Lift
            </button>
          </div>
        ) : isAdminAccount ? (
          <p className="text-[11px] text-text-muted">Admin accounts cannot be suspended.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input value={reason} onChange={(e) => setReason(e.target.value.slice(0, 280))} placeholder="Reason they will see" className={`${input} min-w-0 flex-1`} />
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className={input}>
              <option value={1}>1 hour</option>
              <option value={24}>1 day</option>
              <option value={168}>1 week</option>
              <option value={720}>30 days</option>
              <option value={0}>Indefinite</option>
            </select>
            <button
              onClick={() =>
                void run("suspend", async () => {
                  if (!window.confirm(`Suspend ${user.displayName || user.email}? They are locked out of every page.`)) return;
                  await suspendPlayer(user.uid, reason, hours, admin?.email ?? "admin");
                  setReason("");
                  return "Suspended.";
                })
              }
              className="flex items-center gap-1 rounded-xl bg-red-500/20 px-3 py-2 text-xs font-bold text-red-300 hover:bg-red-500/30"
            >
              {spin("suspend", <Ban size={12} />)} Suspend
            </button>
          </div>
        )}
      </div>

      {/* message */}
      <div>
        <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-text-muted">Send a message</h3>
        <input value={mTitle} onChange={(e) => setMTitle(e.target.value.slice(0, 80))} placeholder="Title" className={`${input} mb-2 w-full`} />
        <textarea value={mBody} onChange={(e) => setMBody(e.target.value.slice(0, 400))} rows={2} placeholder="Message" className={`${input} w-full resize-none`} />
        <button
          disabled={!mBody.trim()}
          onClick={() => void run("note", async () => { await sendNote(user.uid, mTitle, mBody); setMTitle(""); setMBody(""); return "Sent to their inbox."; })}
          className="mt-2 flex items-center gap-1 rounded-xl bg-primary/80 px-3 py-2 text-xs font-bold text-white disabled:opacity-40"
        >
          {spin("note", <MessageSquare size={12} />)} Send
        </button>
      </div>

      {/* stats */}
      <div>
        <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-text-muted">Correct match record</h3>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[11px] text-text-muted">Played</label>
          <input type="number" min={0} value={games} onChange={(e) => setGames(Math.max(0, Math.round(Number(e.target.value) || 0)))} className={`${input} w-24 tabular-nums`} />
          <label className="text-[11px] text-text-muted">Won</label>
          <input type="number" min={0} value={wins} onChange={(e) => setWins(Math.max(0, Math.round(Number(e.target.value) || 0)))} className={`${input} w-24 tabular-nums`} />
          <button
            onClick={() => void run("stats", async () => { await setStats(user.uid, games, wins); return "Record updated."; })}
            className="flex items-center gap-1 rounded-xl border border-white/10 px-3 py-2 text-xs font-bold text-text-secondary hover:border-white/25"
          >
            {spin("stats", <Trophy size={12} />)} Save
          </button>
        </div>
        <p className="mt-1 text-[10px] text-text-muted">Wins are capped at games played. Stat badges follow these numbers.</p>
      </div>

      {/* resets */}
      <div>
        <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-text-muted">Resets</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void run("chal", async () => { await resetChallenges(user.uid); return "Today's challenges reset."; })}
            className="flex items-center gap-1 rounded-xl border border-white/10 px-3 py-2 text-xs font-bold text-text-secondary hover:border-white/25"
          >
            {spin("chal", <RotateCcw size={12} />)} Reset today&apos;s challenges
          </button>
          <select value={walletGame} onChange={(e) => setWalletGame(e.target.value)} className={input}>
            {PLAYABLE_GAMES.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              void run("wallet", async () => {
                const name = PLAYABLE_GAMES.find((g) => g.id === walletGame)?.name ?? walletGame;
                if (!window.confirm(`Empty ${name} coins and shop unlocks for this player?`)) return;
                await resetGameWallet(user.uid, walletGame);
                return `${name} purse emptied.`;
              })
            }
            className="flex items-center gap-1 rounded-xl border border-red-500/30 px-3 py-2 text-xs font-bold text-red-300 hover:bg-red-500/10"
          >
            {spin("wallet", <RotateCcw size={12} />)} Empty purse &amp; unlocks
          </button>
        </div>
      </div>
    </section>
  );
}
