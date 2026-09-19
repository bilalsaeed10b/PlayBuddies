"use client";

import { useMemo, useState } from "react";
import {
  Ban,
  Coins,
  Gem,
  Loader2,
  Megaphone,
  Power,
  Send,
  Trash2,
  Wrench,
} from "lucide-react";
import { GAMES, PLAYABLE_GAMES } from "@/lib/games";
import { broadcastInbox, closeAllRooms, purgeRooms, rewardEveryone } from "@/lib/adminActions";
import { isRoomLive, type AdminUser, type LiveLobby } from "@/lib/adminMetrics";
import {
  announcementLive,
  liftSuspension,
  setAnnouncement,
  setGameDisabled,
  setMaintenance,
  usePlatformConfig,
  useSuspensions,
  type AnnouncementTone,
} from "@/lib/platformConfig";
import { Avatar, Card, Pill } from "./ui";

/**
 * Levers that act on the whole platform at once.
 *
 * Everything with a blast radius asks first and says how many players or
 * writes it will touch, because on the free plan a broadcast to every account
 * is a visible share of the day's write quota, and nothing here has an undo
 * except doing the opposite.
 */
export default function ControlPanel({
  users,
  lobbies,
  onChanged,
}: {
  users: AdminUser[];
  lobbies: LiveLobby[];
  onChanged: () => void;
}) {
  const config = usePlatformConfig(true);
  const suspensions = useSuspensions(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not go through.");
    } finally {
      setBusy("");
    }
  };

  const uids = useMemo(() => users.map((u) => u.uid), [users]);
  const usersById = useMemo(() => new Map(users.map((u) => [u.uid, u])), [users]);

  // -- announcement --
  const [text, setText] = useState("");
  const [tone, setTone] = useState<AnnouncementTone>("info");
  const [hours, setHours] = useState(24);
  const current = announcementLive(config.announcement) ? config.announcement : null;

  // -- maintenance --
  const [maintMsg, setMaintMsg] = useState("");

  // -- broadcast --
  const [bTitle, setBTitle] = useState("");
  const [bBody, setBBody] = useState("");

  // -- reward --
  const [rKind, setRKind] = useState<"gems" | "coins">("gems");
  const [rGame, setRGame] = useState(PLAYABLE_GAMES[0]?.id ?? "");
  const [rAmount, setRAmount] = useState(10);
  const [rReason, setRReason] = useState("");

  const stale = lobbies.filter((l) => !isRoomLive(l));
  const suspendedIds = Object.keys(suspensions);

  return (
    <div className="space-y-6">
      {(notice || error) && (
        <div
          className={`rounded-xl border p-3 text-xs font-bold ${
            error ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
          }`}
        >
          {error || notice}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── announcement ── */}
        <Card title="Site banner" subtitle="Shown at the top of every page for every signed-in player">
          {current && (
            <div className="mb-3 flex items-start justify-between gap-3 rounded-xl bg-white/5 p-3">
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-2">
                  <Pill tone={current.tone === "danger" ? "bad" : current.tone === "warning" ? "warn" : current.tone === "success" ? "good" : "info"}>
                    live · {current.tone}
                  </Pill>
                  <span className="text-[10px] text-text-muted">
                    {current.until ? `until ${new Date(current.until).toLocaleString()}` : "until cleared"}
                  </span>
                </div>
                <p className="text-xs text-white">{current.text}</p>
              </div>
              <button
                onClick={() => void run("ann", async () => { await setAnnouncement("", "info", 0); return "Banner cleared."; })}
                className="shrink-0 text-[11px] font-bold text-red-300 hover:underline"
              >
                Clear
              </button>
            </div>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 280))}
            rows={2}
            placeholder="e.g. New game out: Tower Siege! Or: servers restart at 9pm."
            className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-text-muted/60"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={tone}
              onChange={(e) => setTone(e.target.value as AnnouncementTone)}
              className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white outline-none"
            >
              <option value="info">Info</option>
              <option value="success">Good news</option>
              <option value="warning">Warning</option>
              <option value="danger">Urgent</option>
            </select>
            <select
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white outline-none"
            >
              <option value={1}>1 hour</option>
              <option value={6}>6 hours</option>
              <option value={24}>1 day</option>
              <option value={72}>3 days</option>
              <option value={168}>1 week</option>
              <option value={0}>Until cleared</option>
            </select>
            <span className="text-[10px] text-text-muted">{text.length}/280</span>
            <button
              disabled={!text.trim() || busy === "ann"}
              onClick={() =>
                void run("ann", async () => {
                  await setAnnouncement(text, tone, hours);
                  setText("");
                  return "Banner published.";
                })
              }
              className="ml-auto flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-white disabled:opacity-40"
            >
              {busy === "ann" ? <Loader2 size={12} className="animate-spin" /> : <Megaphone size={12} />} Publish
            </button>
          </div>
        </Card>

        {/* ── maintenance ── */}
        <Card
          title="Maintenance mode"
          subtitle="Pauses new rooms and joining for everyone but admins. Matches already running carry on."
          right={config.maintenance.on ? <Pill tone="warn">on</Pill> : <Pill tone="good">off</Pill>}
        >
          <input
            value={maintMsg}
            onChange={(e) => setMaintMsg(e.target.value.slice(0, 280))}
            placeholder={config.maintenance.message || "Message players see (optional)"}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-text-muted/60"
          />
          <div className="mt-3 flex gap-2">
            <button
              disabled={busy === "maint"}
              onClick={() =>
                void run("maint", async () => {
                  const on = !config.maintenance.on;
                  if (on && !window.confirm("Turn maintenance mode on? Players cannot start or join rooms until you turn it off.")) return;
                  await setMaintenance(on, maintMsg || config.maintenance.message);
                  return on ? "Maintenance mode is on." : "Maintenance mode is off.";
                })
              }
              className={`flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold text-white disabled:opacity-40 ${
                config.maintenance.on ? "bg-emerald-600" : "bg-amber-600"
              }`}
            >
              {busy === "maint" ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
              {config.maintenance.on ? "Turn off" : "Turn on"}
            </button>
            {config.maintenance.on && maintMsg && (
              <button
                onClick={() => void run("maint", async () => { await setMaintenance(true, maintMsg); return "Message updated."; })}
                className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold text-text-secondary"
              >
                Update message
              </button>
            )}
          </div>
        </Card>
      </div>

      {/* ── games on/off ── */}
      <Card title="Games" subtitle="A game switched off disappears from the dashboard and cannot be started. Admins still see it.">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {GAMES.map((g) => {
            const off = config.disabledGames[g.id] === true;
            return (
              <button
                key={g.id}
                disabled={busy === `game:${g.id}`}
                onClick={() =>
                  void run(`game:${g.id}`, async () => {
                    await setGameDisabled(g.id, !off);
                    return `${g.name} is ${off ? "back on" : "switched off"}.`;
                  })
                }
                className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-xs font-bold transition-colors ${
                  off ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-white/10 bg-white/[0.03] text-white hover:border-white/25"
                }`}
              >
                <span className="truncate">{g.name}</span>
                {busy === `game:${g.id}` ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <span className="flex items-center gap-1">
                    <Power size={12} /> {off ? "Off" : "On"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── broadcast ── */}
        <Card title="Message everyone" subtitle={`Lands in all ${users.length} inboxes · ${users.length} writes`}>
          <input
            value={bTitle}
            onChange={(e) => setBTitle(e.target.value.slice(0, 80))}
            placeholder="Title"
            className="mb-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-text-muted/60"
          />
          <textarea
            value={bBody}
            onChange={(e) => setBBody(e.target.value.slice(0, 400))}
            rows={3}
            placeholder="Message"
            className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-text-muted/60"
          />
          <button
            disabled={!bTitle.trim() || !bBody.trim() || busy === "bcast" || users.length === 0}
            onClick={() =>
              void run("bcast", async () => {
                if (!window.confirm(`Send "${bTitle}" to all ${users.length} players?`)) return;
                const n = await broadcastInbox(uids, { title: bTitle, body: bBody });
                setBTitle("");
                setBBody("");
                return `Sent to ${n} players.`;
              })
            }
            className="mt-2 flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-white disabled:opacity-40"
          >
            {busy === "bcast" ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Send to everyone
          </button>
        </Card>

        {/* ── reward ── */}
        <Card title="Reward everyone" subtitle={`An event gift for all ${users.length} players · ${users.length * 2} writes`}>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg bg-white/5 p-1">
              {(["gems", "coins"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setRKind(k)}
                  className={`flex items-center gap-1 rounded-md px-3 py-1 text-xs font-bold ${
                    rKind === k ? "bg-primary text-white" : "text-text-muted"
                  }`}
                >
                  {k === "gems" ? <Gem size={12} /> : <Coins size={12} />} {k}
                </button>
              ))}
            </div>
            {rKind === "coins" && (
              <select
                value={rGame}
                onChange={(e) => setRGame(e.target.value)}
                className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white outline-none"
              >
                {PLAYABLE_GAMES.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
            <input
              type="number"
              min={1}
              value={rAmount}
              onChange={(e) => setRAmount(Math.max(1, Math.round(Number(e.target.value) || 0)))}
              className="w-24 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs tabular-nums text-white outline-none"
            />
          </div>
          <input
            value={rReason}
            onChange={(e) => setRReason(e.target.value.slice(0, 200))}
            placeholder="Why? e.g. Thanks for playing through launch week!"
            className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white outline-none placeholder:text-text-muted/60"
          />
          <button
            disabled={busy === "reward" || users.length === 0}
            onClick={() =>
              void run("reward", async () => {
                const what = rKind === "gems" ? `${rAmount} gems` : `${rAmount} coins in ${GAMES.find((g) => g.id === rGame)?.name}`;
                if (!window.confirm(`Give ${what} to all ${users.length} players?`)) return;
                const n = await rewardEveryone(uids, rKind === "gems" ? { kind: "gems" } : { kind: "coins", gameId: rGame }, rAmount, rReason);
                setRReason("");
                onChanged();
                return `Gave ${what} to ${n} players.`;
              })
            }
            className="mt-2 flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-500 px-4 py-2 text-xs font-bold text-white disabled:opacity-40"
          >
            {busy === "reward" ? <Loader2 size={12} className="animate-spin" /> : <Gem size={12} />} Give to everyone
          </button>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── rooms ── */}
        <Card title="Rooms" subtitle={`${lobbies.length} room documents · ${lobbies.length - stale.length} live · ${stale.length} abandoned`}>
          <div className="flex flex-wrap gap-2">
            <button
              disabled={stale.length === 0 || busy === "stale"}
              onClick={() =>
                void run("stale", async () => {
                  if (!window.confirm(`Delete ${stale.length} abandoned rooms?`)) return;
                  const n = await purgeRooms(stale.map((l) => l.id));
                  onChanged();
                  return `Cleared ${n} abandoned rooms.`;
                })
              }
              className="flex items-center gap-1.5 rounded-xl border border-white/10 px-4 py-2 text-xs font-bold text-text-secondary hover:border-white/25 disabled:opacity-40"
            >
              {busy === "stale" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Clear abandoned ({stale.length})
            </button>
            <button
              disabled={lobbies.length === 0 || busy === "all"}
              onClick={() =>
                void run("all", async () => {
                  if (!window.confirm(`Close ALL ${lobbies.length} rooms, including live matches? Everyone is sent back to the dashboard.`)) return;
                  if (window.prompt('Type CLOSE to confirm') !== "CLOSE") return;
                  const n = await closeAllRooms(lobbies.map((l) => l.id));
                  onChanged();
                  return `Closed ${n} rooms.`;
                })
              }
              className="flex items-center gap-1.5 rounded-xl bg-red-600/80 px-4 py-2 text-xs font-bold text-white hover:bg-red-600 disabled:opacity-40"
            >
              {busy === "all" ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />} Close every room
            </button>
          </div>
          <p className="mt-2 text-[11px] text-text-muted">Close every room is the emergency brake: it ends live matches too.</p>
        </Card>

        {/* ── suspensions ── */}
        <Card title="Suspended accounts" subtitle="Suspend from a player's card on the Players tab">
          {suspendedIds.length === 0 ? (
            <p className="py-4 text-center text-xs text-text-muted">Nobody is suspended.</p>
          ) : (
            <div className="space-y-2">
              {suspendedIds.map((uid) => {
                const s = suspensions[uid];
                const u = usersById.get(uid);
                return (
                  <div key={uid} className="flex items-center gap-3 rounded-xl bg-white/[0.03] p-2.5">
                    <Avatar src={u?.photoURL} uid={uid} size={28} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold text-white">{u?.displayName || u?.email || uid}</p>
                      <p className="truncate text-[10px] text-text-muted">
                        {s.reason || "No reason given"} · {s.until ? `until ${new Date(s.until).toLocaleString()}` : "indefinite"}
                      </p>
                    </div>
                    <button
                      disabled={busy === `lift:${uid}`}
                      onClick={() => void run(`lift:${uid}`, async () => { await liftSuspension(uid); return "Suspension lifted."; })}
                      className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] font-bold text-emerald-300 hover:border-emerald-400/40"
                    >
                      <Ban size={11} /> Lift
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
