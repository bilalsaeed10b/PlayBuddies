"use client";

import { useEffect, useState } from "react";
import { Activity, Crown, Radio, Trash2, Users, WifiOff, X } from "lucide-react";
import { getGame } from "@/lib/games";
import { closeRoom } from "@/lib/adminActions";
import { timeAgo, type LiveLobby, type NetworkHealth } from "@/lib/adminMetrics";
import { Avatar, Card, Empty, Pill, Stat } from "./ui";

/**
 * Every room on the platform right now, and who is sitting in it.
 *
 * "All rooms" and "currently playing" used to be the same list, so on a quiet
 * afternoon with nobody mid-match the panel still filled up with every room
 * sitting in its lobby waiting for players , which reads as "the platform is
 * busy" when it is actually idle. The two are now separate tabs, and each
 * says plainly what it means when it's empty rather than falling through to
 * show the other one.
 *
 * A host whose heartbeat has gone quiet is called out rather than left to
 * look normal: that is the state where a room still exists, still holds
 * players, and nobody in it can start anything , and it is also the one case
 * an admin can actually do something about, with the close button below.
 */
const HOST_STALE_MS = 30_000;

type SubTab = "active" | "all";

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
  const [error, setError] = useState("");

  // A ticking clock rather than Date.now() mid-render: the host-quiet counter
  // has to keep counting while the panel sits open, and reading the wall clock
  // during render would freeze it until something else caused a repaint.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const playing = lobbies.filter((l) => l.status === "playing");
  const waiting = lobbies.filter((l) => l.status === "waiting");
  const completed = lobbies.filter((l) => l.status !== "playing" && l.status !== "waiting");
  const seated = lobbies.reduce((n, l) => n + l.playerCount, 0);

  const shown = subTab === "active" ? playing : lobbies;
  const sorted = [...shown].sort(
    (a, b) => (b.updatedAt?.toMillis?.() ?? 0) - (a.updatedAt?.toMillis?.() ?? 0),
  );

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
        <Stat label="Total rooms" value={lobbies.length} icon={<Activity size={13} />} />
        <Stat label="Mid-match" value={playing.length} tone="good" icon={<Radio size={13} />} />
        <Stat label="Waiting" value={waiting.length} icon={<Users size={13} />} />
        <Stat
          label="Online now"
          value={onlineUids.size}
          hint={`${seated} seated in rooms`}
          icon={<Users size={13} />}
        />
        <Stat label="Total players" value={totalPlayers} hint="registered accounts" icon={<Users size={13} />} />
      </div>

      <Card
        title="Live rooms"
        subtitle={subTab === "active" ? "Matches in progress" : "Every room, any state"}
        right={
          <div className="flex items-center gap-2">
            <div className="flex gap-1 rounded-xl bg-white/5 p-1">
              {(
                [
                  ["active", `Active (${playing.length})`],
                  ["all", `All (${lobbies.length})`],
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

        {sorted.length === 0 ? (
          <Empty
            icon={<Radio size={36} />}
            text={
              subTab === "active"
                ? "No matches in progress right now."
                : "No rooms open right now."
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
                    {hostStale && (
                      <Pill tone="bad">host quiet {Math.round((now - hostSeen) / 1000)}s</Pill>
                    )}
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

      {completed.length > 0 && subTab === "all" && (
        <p className="text-[11px] text-text-muted">
          {completed.length} room{completed.length === 1 ? "" : "s"} above finished but haven&apos;t
          been cleared yet.
        </p>
      )}
    </div>
  );
}
