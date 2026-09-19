"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Bug, Clock, Gauge, Signal, Users, Zap } from "lucide-react";
import { CLOSED_STATUSES, type BugReport } from "@/lib/bugs";
import {
  isRoomLive,
  seatedCount,
  oldestAgeHours,
  timeAgo,
  workloadScore,
  type AdminUser,
  type LiveLobby,
  type NetworkHealth,
} from "@/lib/adminMetrics";
import { getGame } from "@/lib/games";
import { Card, Empty, Pill, Stat } from "./ui";

/**
 * The first screen: how much is on fire, and how much is waiting on you.
 *
 * Built entirely from data the other tabs already subscribe to, so this is a
 * different arrangement of the same moment rather than a second set of reads.
 */
export default function OverviewPanel({
  reports,
  users,
  lobbies,
  onlineCount,
  onlineUids,
  health,
  onJump,
}: {
  onlineUids: ReadonlySet<string>;
  reports: BugReport[];
  users: AdminUser[];
  lobbies: LiveLobby[];
  onlineCount: number;
  health: NetworkHealth;
  onJump: (tab: "bugs" | "live" | "players" | "games" | "system") => void;
}) {
  const open = reports.filter((r) => !CLOSED_STATUSES.includes(r.status));
  const critical = open.filter((r) => r.severity === "critical" || r.severity === "high");
  const load = workloadScore(open);
  const oldest = oldestAgeHours(open);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const liveRooms = lobbies.filter((l) => isRoomLive(l, now, onlineUids));
  const activeRooms = liveRooms.filter((l) => l.status === "playing");
  const playersInRooms = liveRooms.reduce((n, l) => n + seatedCount(l, onlineUids), 0);

  const loadTone = load > 40 ? "bad" : load > 15 ? "warn" : "good";
  const rtt = health.firestoreRttMs;
  const rttTone = rtt === null ? "default" : rtt > 800 ? "bad" : rtt > 350 ? "warn" : "good";

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          label="Workload"
          value={load}
          hint={`${open.length} open · ${critical.length} urgent`}
          tone={loadTone}
          icon={<Gauge size={13} />}
          onClick={() => onJump("bugs")}
        />
        <Stat
          label="Online now"
          value={onlineCount}
          hint={`${playersInRooms} seated in rooms`}
          icon={<Users size={13} />}
          onClick={() => onJump("live")}
        />
        <Stat
          label="Live rooms"
          value={lobbies.length}
          hint={`${activeRooms.length} mid-match`}
          icon={<Activity size={13} />}
          onClick={() => onJump("live")}
        />
        <Stat
          label="Accounts"
          value={users.length}
          hint={`${users.filter((u) => u.gamesPlayed > 0).length} have played`}
          icon={<Users size={13} />}
          onClick={() => onJump("players")}
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <Card
          title="Needs you"
          subtitle={oldest !== null ? `Oldest open report is ${oldest}h old` : "Queue is clear"}
          right={<Pill tone={loadTone === "good" ? "good" : loadTone === "warn" ? "warn" : "bad"}>{open.length} open</Pill>}
        >
          {open.length === 0 ? (
            <Empty icon={<Bug size={34} />} text="No open reports." />
          ) : (
            <ul className="space-y-2">
              {open
                .slice()
                .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
                .slice(0, 6)
                .map((r) => (
                  <li key={r.id}>
                    <button
                      onClick={() => onJump("bugs")}
                      className="w-full text-left flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-white/5 transition-colors"
                    >
                      <AlertTriangle
                        size={14}
                        className={
                          r.severity === "critical"
                            ? "text-red-400"
                            : r.severity === "high"
                              ? "text-orange-400"
                              : "text-text-muted"
                        }
                      />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-white truncate">{r.title}</span>
                        <span className="block text-[11px] text-text-muted truncate">
                          {r.gameId ? getGame(r.gameId)?.name ?? r.gameId : "Platform"} ·{" "}
                          {timeAgo(r.createdAt)}
                        </span>
                      </span>
                      <Pill tone={r.severity === "low" ? "neutral" : "warn"}>{r.severity}</Pill>
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </Card>

        <Card title="Connection" subtitle={`Probed ${health.lastProbeAt ? timeAgoMs(health.lastProbeAt) : "—"}`}>
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Firestore"
              value={rtt === null ? "—" : `${rtt}ms`}
              hint="round trip"
              tone={rttTone}
              icon={<Zap size={13} />}
            />
            <Stat
              label="Realtime DB"
              value={health.rtdbRttMs === null ? "—" : `${health.rtdbRttMs}ms`}
              hint={health.rtdbConnected ? "socket up" : "socket down"}
              tone={health.rtdbConnected ? "good" : "bad"}
              icon={<Signal size={13} />}
            />
            <Stat
              label="Link"
              value={health.effectiveType}
              hint={health.downlinkMbps ? `${health.downlinkMbps} Mbps down` : "browser estimate"}
              icon={<Activity size={13} />}
            />
            <Stat
              label="Clock skew"
              value={health.clockSkewMs === null ? "—" : `${health.clockSkewMs}ms`}
              hint="this machine vs Firebase"
              tone={Math.abs(health.clockSkewMs ?? 0) > 5000 ? "warn" : "default"}
              icon={<Clock size={13} />}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}

function severityRank(s: string): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[s] ?? 0;
}

function timeAgoMs(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}
