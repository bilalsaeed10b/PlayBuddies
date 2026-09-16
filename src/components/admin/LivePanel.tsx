"use client";

import { useEffect, useState } from "react";
import { Activity, Crown, Radio, Trash2, Users, WifiOff, X } from "lucide-react";
import { getGame } from "@/lib/games";
import { closeRoom, purgeRooms } from "@/lib/adminActions";
import {
  isRoomLive,
  ROOM_STALE_MS,
  timeAgo,
  type LiveLobby,
  type NetworkHealth,
} from "@/lib/adminMetrics";
import { Avatar, Card, Empty, Pill, Stat } from "./ui";

/**
 * Every room on the platform right now, and who is sitting in it.
 *
 * The hard part is the word "now". Nothing in PlayBuddies ever deletes a
 * lobby document, so `status: 'playing'` is not a fact about the present , it
 * is whatever the room was doing at the moment its last player closed the
 * tab, preserved for ever. Reading the collection raw showed 200 rooms and
 * 96 matches in progress on a platform where nobody was playing at all, most
 * of those rooms days old.
 *
 * What makes a room live is therefore the host's heartbeat (`isRoomLive`),
 * not its status field. Status only says *what kind* of live it is. Rooms
 * that fail that test are not hidden , they are their own tab, with the
 * count in the open, because a few hundred of them is a real thing to know
 * about and the panel is the only place it would ever be visible.
 */
const HOST_STALE_MS = 30_000;

type SubTab = "active" | "waiting" | "stale";

export default function LivePanel({
  lobbies,
  onlineUids,
  totalPlayers,
  health,
  onChanged,
}: {
  lobbies: LiveLobby[];
  onlineUids: Set<string>;
  totalPlayers: number;
  health: NetworkHealth;
  onChanged: () => void;
}) {
  const [subTab, setSubTab] = useState<SubTab>("active");
  const [closing, setClosing] = useState("");
  const [purging, setPurging] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // A ticking clock rather than Date.now() mid-render: the host-quiet counter
  // has to keep counting while the panel sits open, and reading the wall clock
  // during render would freeze it until something else caused a repaint.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Recomputed against the same ticking clock the host-quiet badge uses, so a
  // room crosses from live to stale on screen rather than at the next refresh.
  const live = lobbies.filter((l) => isRoomLive(l, now));
  const stale = lobbies.filter((l) => !isRoomLive(l, now));
  const playing = live.filter((l) => l.status === "playing");
  const waiting = live.filter((l) => l.status !== "playing");
  const seated = live.reduce((n, l) => n + l.playerCount, 0);

  const shown = subTab === "active" ? playing : subTab === "waiting" ? waiting : stale;
  const sorted = [...shown].sort(
    (a, b) => (b.updatedAt?.toMillis?.() ?? 0) - (a.updatedAt?.toMillis?.() ?? 0),
  );

  const purge = async () => {
    if (stale.length === 0) return;
    if (
      !window.confirm(
        `Delete ${stale.length} abandoned room${stale.length === 1 ? "" : "s"}?

` +
          `These have not had a host heartbeat in over ${Math.round(ROOM_STALE_MS / 1000)}s, ` +
          `so nobody is in them. Anyone still on a room's page would be dropped back to the dashboard. ` +
          `This cannot be undone.`,
      )
    ) {
      return;
    }
    setPurging(true);
    setError("");
    try {
      const n = await purgeRooms(stale.map((l) => l.id));
      setNotice(`Cleared ${n} abandoned room${n === 1 ? "" : "s"}.`);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not clear those rooms.");
    } finally {
      setPurging(false);
    }
  };

  const close = async (roomId: string) => {
    if (!window.confirm(`Close room ${roomId}? Everyone in it is dropped back to the dashboard.`)) {
      return;
    }
    setClosing(roomId);
    setError("");
    try {
      await closeRoom(roomId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not close that room.");
    } finally {
      setClosing("");
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat
          label="Mid-match"
          value={playing.length}
          tone="good"
          hint="host beating now"
          icon={<Radio size={13} />}
        />
        <Stat label="Waiting" value={waiting.length} hint="open lobbies" icon={<Users size={13} />} />
        <Stat
          label="Abandoned"
          value={stale.length}
          tone={stale.length > 20 ? "warn" : "default"}
          hint={`no heartbeat in ${Math.round(ROOM_STALE_MS / 1000)}s`}
          icon={<Activity size={13} />}
        />
        <Stat
          label="Online now"
          value={onlineUids.size}
          hint={`${seated} seated in live rooms`}
          icon={<Users size={13} />}
        />
        <Stat
          label="Total players"
          value={totalPlayers}
          hint="registered accounts"
          icon={<Users size={13} />}
        />
      </div>

      <Card
        title="Rooms"
        subtitle={
          subTab === "active"
            ? "Matches in progress right now"
            : subTab === "waiting"
              ? "Open lobbies with a live host"
              : "Rooms whose host stopped reporting , nobody is in these"
        }
        right={
          <div className="flex items-center gap-2">
            {subTab === "stale" && stale.length > 0 && (
              <button
                onClick={purge}
                disabled={purging}
                className="flex items-center gap-1.5 rounded-xl bg-red-500/15 px-3 py-1.5 text-[11px] font-bold text-red-300 hover:bg-red-500/25 disabled:opacity-40 transition-colors"
              >
                <Trash2 size={12} />
                {purging ? "Clearing…" : `Clear all ${stale.length}`}
              </button>
            )}
            <div className="flex gap-1 rounded-xl bg-white/5 p-1">
              {(
                [
                  ["active", `Active (${playing.length})`],
                  ["waiting", `Waiting (${waiting.length})`],
                  ["stale", `Abandoned (${stale.length})`],
                ] as [SubTab, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setSubTab(id)}
                  className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${
                    subTab === id ? "bg-primary text-white" : "text-text-muted hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <Pill tone={health.rtdbConnected ? "good" : "bad"}>
              {health.rtdbConnected ? "live" : "offline"}
            </Pill>
          </div>
        }
      >
        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
        {notice && <p className="text-xs text-emerald-400 mb-3">{notice}</p>}

        {sorted.length === 0 ? (
          <Empty
            icon={<Radio size={36} />}
            text={
              subTab === "active"
                ? "No matches in progress right now."
                : subTab === "waiting"
                  ? "No lobbies sitting open right now."
                  : "Nothing abandoned , every room on the platform has a live host."
            }
          />
        ) : (
          <div className="space-y-3">
            {sorted.map((l) => {
              const hostSeen = l.hostSeenAt?.toMillis?.() ?? 0;
              const hostStale = hostSeen > 0 && now - hostSeen > HOST_STALE_MS;
              return (
                <div key={l.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <div className="flex items-center gap-2 flex-wrap mb-3">
                    <span className="font-mono font-black text-white tracking-widest">{l.id}</span>
                    <Pill tone={l.status === "playing" ? "good" : l.status === "waiting" ? "info" : "neutral"}>
                      {l.status}
                    </Pill>
                    {l.gameId && <Pill tone="info">{getGame(l.gameId)?.name ?? l.gameId}</Pill>}
                    <Pill>{l.playerCount} seated</Pill>
                    {/* In the live tabs this is a countdown worth watching; in
                        the abandoned tab every row would carry a meaningless
                        five-figure one, so the age below says it instead. */}
                    {hostStale && subTab !== "stale" && (
                      <Pill tone="bad">host quiet {Math.round((now - hostSeen) / 1000)}s</Pill>
                    )}
                    {subTab === "stale" && <Pill tone="neutral">last seen {timeAgo(l.hostSeenAt)}</Pill>}
                    <span className="ml-auto text-[11px] text-text-muted">{timeAgo(l.updatedAt)}</span>
                    <button
                      onClick={() => close(l.id)}
                      disabled={closing === l.id}
                      title="Close this room"
                      className="w-7 h-7 rounded-lg hover:bg-red-500/15 flex items-center justify-center text-text-muted hover:text-red-300 disabled:opacity-40 transition-colors"
                    >
                      {closing === l.id ? <X size={13} className="animate-pulse" /> : <Trash2 size={13} />}
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {l.players.map((p) => {
                      const online = onlineUids.has(p.uid);
                      return (
                        <div
                          key={p.uid}
                          className={`flex items-center gap-2 rounded-xl border px-2.5 py-1.5 ${
                            online ? "border-white/10" : "border-red-500/30 bg-red-500/5"
                          }`}
                        >
                          <div className="relative">
                            <Avatar src={p.photoURL} uid={p.uid} size={24} />
                            <span
                              className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#141423] ${
                                online ? "bg-emerald-400" : "bg-red-500"
                              }`}
                            />
                          </div>
                          <span className="text-xs text-white max-w-[9rem] truncate">{p.displayName}</span>
                          {p.uid === l.hostId && <Crown size={11} className="text-amber-400" />}
                          {!online && <WifiOff size={11} className="text-red-400" />}
                          {p.isReady && <Pill tone="good">ready</Pill>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {subTab === "stale" && stale.length > 0 && (
        <p className="text-[11px] text-text-muted leading-relaxed">
          Nothing deletes a lobby when its players leave, so these build up on their own. They are
          harmless apart from the read they cost on every load of this page , clearing them is
          housekeeping, not a fix.
        </p>
      )}
    </div>
  );
}
