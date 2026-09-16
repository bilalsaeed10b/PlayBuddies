"use client";

import { useMemo } from "react";
import { AlertTriangle, Clock, Database, HardDrive, Info, Signal, Zap } from "lucide-react";
import {
  FREE_TIER,
  estimateDocBytes,
  formatBytes,
  type AdminUser,
  type LiveLobby,
  type NetworkHealth,
} from "@/lib/adminMetrics";
import type { BugReport } from "@/lib/bugs";
import TrelloPanel from "./TrelloPanel";
import { Card, Meter, Pill, Stat } from "./ui";

/**
 * Quotas, storage and link quality.
 *
 * The honest part of this panel is the "est" mark. Daily read and write counts
 * live in Cloud Monitoring behind a service account; a browser cannot see them,
 * so nothing here pretends to. What is shown instead is what can actually be
 * measured from this client: the size of the documents the panel can read, the
 * number of live connections, and real round trips to both databases.
 *
 * For the true numbers, the Firebase console's Usage tab is the answer, and
 * the panel says so rather than quietly inventing a percentage.
 */
export default function SystemPanel({
  users,
  reports,
  lobbies,
  health,
  onlineCount,
}: {
  users: AdminUser[];
  reports: BugReport[];
  lobbies: LiveLobby[];
  health: NetworkHealth;
  onlineCount: number;
}) {
  const sizes = useMemo(() => {
    const userBytes = users.reduce((n, u) => n + estimateDocBytes(u), 0);
    const reportBytes = reports.reduce((n, r) => n + estimateDocBytes(r), 0);
    const lobbyBytes = lobbies.reduce((n, l) => n + estimateDocBytes(l), 0);
    return { userBytes, reportBytes, lobbyBytes, total: userBytes + reportBytes + lobbyBytes };
  }, [users, reports, lobbies]);

  const shots = reports.filter((r) => r.screenshotURL).length;
  // Screenshots are capped at 2 MB by the rules and land well under it after
  // the client-side WebP pass; 250 KB is a working average for the estimate.
  const shotBytes = shots * 250 * 1024;

  const rtt = health.firestoreRttMs;
  const rttTone = rtt === null ? "default" : rtt > 800 ? "bad" : rtt > 350 ? "warn" : "good";
  const skew = health.clockSkewMs ?? 0;

  return (
    <div className="space-y-6">
      <TrelloPanel />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          label="Firestore RTT"
          value={rtt === null ? "—" : `${rtt}ms`}
          hint="measured just now"
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
          label="Clock skew"
          value={`${skew}ms`}
          hint="this machine vs Firebase"
          tone={Math.abs(skew) > 5000 ? "warn" : "default"}
          icon={<Clock size={13} />}
        />
        <Stat
          label="Concurrent"
          value={`${onlineCount}`}
          hint={`of ${FREE_TIER.rtdbConcurrent} free-tier sockets`}
          tone={onlineCount > FREE_TIER.rtdbConcurrent * 0.8 ? "warn" : "good"}
          icon={<Database size={13} />}
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <Card title="Stored data" subtitle="Sized from the documents this panel can read">
          <div className="space-y-4">
            <Meter
              label="Firestore documents"
              used={sizes.total}
              limit={FREE_TIER.firestoreStorageBytes}
              format={formatBytes}
              estimated
            />
            <Meter
              label="Screenshots in Storage"
              used={shotBytes}
              limit={FREE_TIER.storageBytes}
              format={formatBytes}
              estimated
            />
            <dl className="grid grid-cols-3 gap-2 pt-1">
              <Slice label="Accounts" count={users.length} bytes={sizes.userBytes} />
              <Slice label="Reports" count={reports.length} bytes={sizes.reportBytes} />
              <Slice label="Rooms" count={lobbies.length} bytes={sizes.lobbyBytes} />
            </dl>
          </div>
        </Card>

        <Card title="Free-tier ceilings" subtitle="What the project is allowed per day">
          <div className="space-y-3 text-sm">
            <Ceiling label="Firestore reads" value={FREE_TIER.firestoreReadsPerDay} unit="/ day" />
            <Ceiling label="Firestore writes" value={FREE_TIER.firestoreWritesPerDay} unit="/ day" />
            <Ceiling label="Firestore deletes" value={FREE_TIER.firestoreDeletesPerDay} unit="/ day" />
            <Ceiling label="Realtime DB sockets" value={FREE_TIER.rtdbConcurrent} unit="at once" />
            <Ceiling
              label="Realtime DB egress"
              value={FREE_TIER.rtdbDownloadPerMonthBytes}
              unit="/ month"
              format={formatBytes}
            />
            <Ceiling
              label="Storage uploads"
              value={FREE_TIER.storageUploadsPerDay}
              unit="/ day"
            />
          </div>

          <div className="mt-4 flex items-start gap-2 rounded-xl bg-sky-500/10 border border-sky-500/20 p-3">
            <Info size={14} className="text-sky-300 shrink-0 mt-0.5" />
            <p className="text-[11px] text-sky-100/80 leading-relaxed">
              Consumption against these ceilings is only visible in the Firebase console&apos;s Usage
              tab. A browser has no access to Cloud Monitoring, so this panel counts what it can see
              and marks the rest as an estimate rather than guessing.
            </p>
          </div>
        </Card>
      </div>

      <Card title="Health checks" subtitle="Conditions worth acting on">
        <div className="space-y-2">
          <Check
            ok={health.rtdbConnected}
            good="Realtime database socket is connected."
            bad="Realtime database socket is down , presence and live rooms will look empty."
          />
          <Check
            ok={rtt === null || rtt < 800}
            good="Firestore is answering promptly."
            bad="Firestore round trips are over 800ms , matches will feel laggy."
          />
          <Check
            ok={Math.abs(skew) < 5000}
            good="This machine's clock agrees with Firebase."
            bad="Clock is more than 5s off Firebase , host-handover timing depends on this."
          />
          <Check
            ok={onlineCount < FREE_TIER.rtdbConcurrent * 0.8}
            good={`Concurrent connections are comfortable (${onlineCount}/${FREE_TIER.rtdbConcurrent}).`}
            bad={`Nearing the ${FREE_TIER.rtdbConcurrent}-socket free-tier ceiling.`}
          />
          <Check
            ok={sizes.total < FREE_TIER.firestoreStorageBytes * 0.7}
            good="Firestore storage is well inside the free tier."
            bad="Firestore storage estimate is past 70% of the free tier."
          />
        </div>
      </Card>
    </div>
  );
}

function Slice({ label, count, bytes }: { label: string; count: number; bytes: number }) {
  return (
    <div className="rounded-xl bg-white/5 p-2.5 text-center">
      <dt className="text-[9px] uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className="text-sm font-black text-white tabular-nums">{count}</dd>
      <p className="text-[10px] text-text-muted">{formatBytes(bytes)}</p>
    </div>
  );
}

function Ceiling({
  label,
  value,
  unit,
  format,
}: {
  label: string;
  value: number;
  unit: string;
  format?: (n: number) => string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-secondary text-xs flex items-center gap-2">
        <HardDrive size={12} className="text-text-muted" />
        {label}
      </span>
      <span className="text-xs font-bold text-white tabular-nums">
        {(format ?? ((n: number) => n.toLocaleString()))(value)}{" "}
        <span className="text-text-muted font-normal">{unit}</span>
      </span>
    </div>
  );
}

function Check({ ok, good, bad }: { ok: boolean; good: string; bad: string }) {
  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl border p-3 ${
        ok ? "border-white/10 bg-white/[0.03]" : "border-amber-500/30 bg-amber-500/10"
      }`}
    >
      {ok ? (
        <Pill tone="good">ok</Pill>
      ) : (
        <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
      )}
      <p className={`text-xs leading-relaxed ${ok ? "text-text-secondary" : "text-amber-100"}`}>
        {ok ? good : bad}
      </p>
    </div>
  );
}
