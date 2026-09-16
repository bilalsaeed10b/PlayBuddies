"use client";

import { useEffect, useState } from "react";
import { Activity, Crown, Radio, Users, WifiOff } from "lucide-react";
import { getGame } from "@/lib/games";
import { timeAgo, type LiveLobby, type NetworkHealth } from "@/lib/adminMetrics";
import { Avatar, Card, Empty, Pill, Stat } from "./ui";

/**
 * Every room on the platform right now, and who is sitting in it.
 *
 * A host whose heartbeat has gone quiet is called out rather than left to
 * look normal: that is the state where a room still exists, still holds
 * players, and nobody in it can start anything.
 */
const HOST_STALE_MS = 30_000;

export default function LivePanel({
  lobbies,
  onlineUids,
  health,
}: {
  lobbies: LiveLobby[];
  onlineUids: Set<string>;
  health: NetworkHealth;
}) {
  // A ticking clock rather than Date.now() mid-render: the host-quiet counter
  // has to keep counting while the panel sits open, and reading the wall clock
  // during render would freeze it until something else caused a repaint.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const playing = lobbies.filter((l) => l.status === "playing");
  const waiting = lobbies.filter((l) => l.status !== "playing");
  const seated = lobbies.reduce((n, l) => n + l.playerCount, 0);

  const sorted = [...lobbies].sort(
    (a, b) => (b.updatedAt?.toMillis?.() ?? 0) - (a.updatedAt?.toMillis?.() ?? 0),
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Rooms" value={lobbies.length} icon={<Activity size={13} />} />
        <Stat label="Mid-match" value={playing.length} tone="good" icon={<Radio size={13} />} />
        <Stat label="Waiting" value={waiting.length} icon={<Users size={13} />} />
        <Stat
          label="Players online"
          value={onlineUids.size}
          hint={`${seated} seated in rooms`}
          icon={<Users size={13} />}
        />
      </div>

      <Card
        title="Live rooms"
        subtitle="Newest activity first"
        right={
          <Pill tone={health.rtdbConnected ? "good" : "bad"}>
            {health.rtdbConnected ? "presence live" : "presence offline"}
          </Pill>
        }
      >
        {sorted.length === 0 ? (
          <Empty icon={<Radio size={36} />} text="No rooms open right now." />
        ) : (
          <div className="space-y-3">
            {sorted.map((l) => {
              const hostSeen = l.hostSeenAt?.toMillis?.() ?? 0;
              const hostStale = hostSeen > 0 && now - hostSeen > HOST_STALE_MS;
              return (
                <div key={l.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <div className="flex items-center gap-2 flex-wrap mb-3">
                    <span className="font-mono font-black text-white tracking-widest">{l.id}</span>
                    <Pill tone={l.status === "playing" ? "good" : "neutral"}>{l.status}</Pill>
                    {l.gameId && <Pill tone="info">{getGame(l.gameId)?.name ?? l.gameId}</Pill>}
                    <Pill>{l.playerCount} seated</Pill>
                    {hostStale && (
                      <Pill tone="bad">
                        host quiet {Math.round((now - hostSeen) / 1000)}s
                      </Pill>
                    )}
                    <span className="ml-auto text-[11px] text-text-muted">
                      {timeAgo(l.updatedAt)}
                    </span>
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
                          <span className="text-xs text-white max-w-[9rem] truncate">
                            {p.displayName}
                          </span>
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
    </div>
  );
}
