"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { onValue, ref } from "firebase/database";
import {
  Activity,
  AlertTriangle,
  CloudCog,
  ExternalLink,
  Gauge,
  Link2,
  Loader2,
  RefreshCw,
  Save,
  Server,
  Users,
} from "lucide-react";
import { rtdb } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import {
  FIREBASE_USAGE_URL,
  MONITORING_API_URL,
  MonitoringError,
  connectMonitoring,
  forgetToken,
  loadCloudUsage,
  storedToken,
  type CloudUsage,
  type Point,
} from "@/lib/cloudMetrics";
import {
  APP_LIMITS,
  DEFAULT_LIMITS,
  EXTERNAL_LIMITS,
  SERVICE_LIMITS,
  limitFor,
  readLimitsConfig,
  saveLimitsConfig,
  type LimitsConfig,
  type ServiceLimit,
} from "@/lib/platformLimits";
import {
  estimateDocBytes,
  formatBytes,
  isRoomLive,
  seatedCount,
  type AdminUser,
  type LiveLobby,
  type NetworkHealth,
} from "@/lib/adminMetrics";
import type { BugReport } from "@/lib/bugs";
import { getGame } from "@/lib/games";
import { Card, Pill, Stat } from "./ui";

/**
 * Every limit the platform runs under, and how close it is to each one.
 *
 * Two sources, labelled apart everywhere they appear:
 *   * Measured , read from Google Cloud Monitoring once the admin connects it.
 *     These are the real daily counts Firebase bills and throttles against.
 *   * Estimated , worked out from what this panel can see for itself, marked
 *     "est", used where Monitoring is not connected or has no series.
 */
export default function LimitsPanel({
  users,
  reports,
  lobbies,
  health,
  onlineUids,
}: {
  users: AdminUser[];
  reports: BugReport[];
  lobbies: LiveLobby[];
  onlineUids: ReadonlySet<string>;
  health: NetworkHealth;
}) {
  const { user } = useAuthStore();
  const [config, setConfig] = useState<LimitsConfig>(DEFAULT_LIMITS);
  const [token, setToken] = useState<string | null>(null);
  const [usage, setUsage] = useState<CloudUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; kind: string } | null>(null);
  const sessions = useSessionCount();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setToken(storedToken());
    readLimitsConfig().then(setConfig).catch(() => {});
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  const refresh = useCallback(async (t: string) => {
    setBusy(true);
    setProblem(null);
    try {
      setUsage(await loadCloudUsage(t));
    } catch (e) {
      if (e instanceof MonitoringError) {
        if (e.kind === "expired") {
          forgetToken();
          setToken(null);
        }
        setProblem({ text: e.message, kind: e.kind });
      } else {
        setProblem({ text: e instanceof Error ? e.message : "Could not read Cloud Monitoring.", kind: "other" });
      }
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    void refresh(token);
    // Monitoring updates about once a minute; two minutes is plenty.
    const t = setInterval(() => void refresh(token), 120_000);
    return () => clearInterval(t);
  }, [token, refresh]);

  const connect = async () => {
    if (!user) return;
    setBusy(true);
    setProblem(null);
    try {
      setToken(await connectMonitoring(user));
    } catch (e) {
      setProblem({ text: e instanceof Error ? e.message : "Google sign-in was cancelled.", kind: "other" });
      setBusy(false);
    }
  };

  // -- what this panel can measure without Monitoring ------------------------
  const live = lobbies.filter((l) => isRoomLive(l, now, onlineUids));
  const playing = live.filter((l) => l.status === "playing");
  const inMatch = playing.reduce((n, l) => n + seatedCount(l, onlineUids), 0);
  const estimates = useMemo(() => {
    const fsBytes = [...users, ...reports, ...lobbies].reduce((n, d) => n + estimateDocBytes(d), 0);
    const shots = reports.filter((r) => r.screenshotURL).length * 250 * 1024;
    return { fsBytes, shots };
  }, [users, reports, lobbies]);

  const byGame = useMemo(() => {
    const m = new Map<string, { rooms: number; players: number }>();
    for (const l of playing) {
      const row = m.get(l.gameId) ?? { rooms: 0, players: 0 };
      row.rooms += 1;
      row.players += seatedCount(l, onlineUids);
      m.set(l.gameId, row);
    }
    return [...m.entries()].sort((a, b) => b[1].players - a[1].players);
  }, [playing, onlineUids]);

  /** The measured value for a limit, or an estimate marked as one, or nothing. */
  const reading = (l: ServiceLimit): { used: number | null; estimated: boolean } => {
    const u = usage;
    const measured: Record<string, number | null | undefined> = {
      "fs.reads": u?.firestore.reads,
      "fs.writes": u?.firestore.writes,
      "fs.deletes": u?.firestore.deletes,
      "db.connections": u?.rtdb.connections,
      "db.load": u?.rtdb.load,
      "db.sent": u?.rtdb.sentMonthBytes,
      "db.stored": u?.rtdb.storedBytes,
      "gcs.stored": u?.storage.storedBytes,
      "gcs.sent": u?.storage.sentMonthBytes,
      "gcs.requests": u?.storage.requestsToday,
    };
    const m = measured[l.key];
    if (typeof m === "number") return { used: m, estimated: false };
    const est: Record<string, number> = {
      "fs.stored": estimates.fsBytes,
      "db.connections": sessions,
      "gcs.stored": estimates.shots,
    };
    return l.key in est ? { used: est[l.key], estimated: true } : { used: null, estimated: false };
  };

  const dayFraction = usage ? Math.min(1, Math.max(0.02, (now - usage.dayStart) / 86_400_000)) : null;
  const connLimit = limitFor(SERVICE_LIMITS.find((l) => l.key === "db.connections")!, config);
  const connNow = usage?.rtdb.connections ?? sessions;

  const alerts = SERVICE_LIMITS.map((l) => ({ l, r: reading(l), limit: limitFor(l, config) }))
    .filter(({ r, limit }) => r.used !== null && limit > 0 && r.used / limit >= 0.7)
    .map(({ l, r, limit }) => ({ l, ratio: (r.used ?? 0) / limit }));

  return (
    <div className="space-y-6">
      {/* ── connection + plan ── */}
      <Card
        title="Limits & load"
        subtitle="Real usage from Google Cloud Monitoring, against your plan's ceilings"
        right={
          <div className="flex items-center gap-1 rounded-xl bg-white/5 p-1">
            {(["spark", "blaze"] as const).map((p) => (
              <button
                key={p}
                onClick={() => {
                  const next = { ...config, plan: p };
                  setConfig(next);
                  void saveLimitsConfig(next).catch(() => {});
                }}
                className={`rounded-lg px-3 py-1.5 text-xs font-black uppercase tracking-wider ${
                  config.plan === p ? "bg-primary text-white" : "text-text-muted hover:text-white"
                }`}
              >
                {p === "spark" ? "Spark (free)" : "Blaze (pay as you go)"}
              </button>
            ))}
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          {token ? (
            <>
              <Pill tone="good">Monitoring connected</Pill>
              <span className="text-[11px] text-text-muted">
                {usage ? `Updated ${Math.max(0, Math.round((now - usage.fetchedAt) / 1000))}s ago` : "Reading…"}
              </span>
              <button
                onClick={() => void refresh(token)}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-1.5 text-xs font-bold text-text-secondary hover:border-white/25 disabled:opacity-50"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
              </button>
              <button
                onClick={() => {
                  forgetToken();
                  setToken(null);
                  setUsage(null);
                }}
                className="text-[11px] font-bold text-text-muted hover:text-white"
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => void connect()}
                disabled={busy}
                className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                Connect Google Cloud metrics
              </button>
              <p className="max-w-xl text-[11px] leading-relaxed text-text-muted">
                Asks your Google account for read-only Monitoring access (one hour, this tab only) so the bars below show
                the real daily counts. Without it they fall back to estimates.
              </p>
            </>
          )}
          <a
            href={FIREBASE_USAGE_URL}
            target="_blank"
            rel="noreferrer"
            className="ml-auto flex items-center gap-1 text-[11px] font-bold text-sky-300 hover:underline"
          >
            Firebase usage console <ExternalLink size={11} />
          </a>
        </div>
        {problem && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
            <div className="text-xs text-amber-100">
              <p className="font-bold">{problem.text}</p>
              {problem.kind === "disabled" && (
                <a href={MONITORING_API_URL} target="_blank" rel="noreferrer" className="text-amber-300 underline">
                  Enable the Cloud Monitoring API, then connect again
                </a>
              )}
              {problem.kind === "denied" && (
                <p className="text-amber-200/70">This Google account needs the Monitoring Viewer role on the project.</p>
              )}
            </div>
          </div>
        )}
      </Card>

      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map(({ l, ratio }) => (
            <div
              key={l.key}
              className={`flex items-center gap-2.5 rounded-xl border p-3 text-xs ${
                ratio >= 0.9 ? "border-red-500/40 bg-red-500/10 text-red-100" : "border-amber-500/30 bg-amber-500/10 text-amber-100"
              }`}
            >
              <AlertTriangle size={14} className={ratio >= 0.9 ? "text-red-400" : "text-amber-400"} />
              <span className="font-bold">
                {l.service} · {l.label} at {Math.round(ratio * 100)}%
              </span>
              <span className="opacity-70">· past it: {(config.plan === "spark" ? l.sparkOver : l.blazeOver).toLowerCase()}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── live load ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat
          label="Connections"
          value={`${connNow}`}
          hint={`of ${connLimit.toLocaleString()} ${usage?.rtdb.connections != null ? "" : "(est: open tabs)"}`}
          tone={connNow / connLimit > 0.9 ? "bad" : connNow / connLimit > 0.7 ? "warn" : "good"}
          icon={<Users size={13} />}
        />
        <Stat
          label="Database load"
          value={usage?.rtdb.load != null ? `${usage.rtdb.load.toFixed(1)}%` : "—"}
          hint={usage?.rtdb.loadPeak != null ? `peak ${usage.rtdb.loadPeak.toFixed(1)}% / 24h` : "needs Monitoring"}
          tone={(usage?.rtdb.load ?? 0) > 80 ? "bad" : (usage?.rtdb.load ?? 0) > 50 ? "warn" : "default"}
          icon={<Gauge size={13} />}
        />
        <Stat label="Live rooms" value={live.length} hint={`${playing.length} mid-match`} icon={<Activity size={13} />} />
        <Stat label="In a match" value={inMatch} hint="players seated in live games" icon={<Server size={13} />} />
        <Stat
          label="Peak connections"
          value={usage?.rtdb.connectionsPeak != null ? usage.rtdb.connectionsPeak : "—"}
          hint="last 24h"
          icon={<Users size={13} />}
        />
        <Stat
          label="Round trip"
          value={health.firestoreRttMs != null ? `${health.firestoreRttMs}ms` : "—"}
          hint={`RTDB ${health.rtdbRttMs ?? "—"}ms`}
          tone={(health.firestoreRttMs ?? 0) > 800 ? "bad" : (health.firestoreRttMs ?? 0) > 350 ? "warn" : "good"}
          icon={<Activity size={13} />}
        />
      </div>

      {/* ── quotas ── */}
      <div className="grid gap-6 lg:grid-cols-2">
        {["Firestore", "Realtime Database", "Cloud Storage"].map((service) => (
          <Card key={service} title={service} subtitle={service === "Firestore" ? "Daily counts reset at midnight Pacific" : undefined}>
            <div className="space-y-4">
              {SERVICE_LIMITS.filter((l) => l.service === service).map((l) => {
                const r = reading(l);
                const limit = limitFor(l, config);
                const projected =
                  l.period === "day" && r.used !== null && !r.estimated && dayFraction ? r.used / dayFraction : null;
                return (
                  <QuotaRow
                    key={l.key}
                    limit={l}
                    ceiling={limit}
                    used={r.used}
                    estimated={r.estimated}
                    projected={projected}
                    overText={config.plan === "spark" ? l.sparkOver : l.blazeOver}
                  />
                );
              })}
            </div>
          </Card>
        ))}

        <Card title="Last 24 hours" subtitle="Hourly, from Cloud Monitoring">
          {usage ? (
            <div className="space-y-5">
              <MiniBars title="Firestore reads / hour" points={usage.firestore.readsHourly} format={(v) => v.toLocaleString()} />
              <MiniBars title="Firestore writes / hour" points={usage.firestore.writesHourly} format={(v) => v.toLocaleString()} />
              <MiniBars title="Peak connections / hour" points={usage.rtdb.connectionsHourly} format={(v) => `${v}`} />
              <MiniBars title="Peak database load / hour" points={usage.rtdb.loadHourly} format={(v) => `${v.toFixed(1)}%`} />
            </div>
          ) : (
            <p className="py-8 text-center text-xs text-text-muted">Connect Google Cloud metrics to see the last day.</p>
          )}
        </Card>
      </div>

      {/* ── what is playing right now ── */}
      <Card title="Load by game" subtitle="Live matches right now">
        {byGame.length === 0 ? (
          <p className="py-4 text-center text-xs text-text-muted">Nobody is mid-match.</p>
        ) : (
          <div className="space-y-2">
            {byGame.map(([gameId, row]) => (
              <div key={gameId} className="flex items-center gap-3 text-xs">
                <span className="w-40 truncate font-bold text-white">{getGame(gameId)?.name ?? gameId}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-sky-400"
                    style={{ width: `${(row.players / Math.max(1, inMatch)) * 100}%` }}
                  />
                </div>
                <span className="w-32 text-right tabular-nums text-text-secondary">
                  {row.players} players · {row.rooms} rooms
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Other services" subtitle="Not readable from a browser , ceilings and where to check">
          <div className="space-y-3">
            {EXTERNAL_LIMITS.map((e) => (
              <div key={e.label} className="flex items-start justify-between gap-3 rounded-xl bg-white/[0.03] p-3">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-white">
                    {e.service} · <span className="font-normal text-text-secondary">{e.label}</span>
                  </p>
                  <p className="text-[11px] text-text-muted">{e.note}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs font-black tabular-nums text-white">{e.limit}</p>
                  <a href={e.url} target="_blank" rel="noreferrer" className="text-[10px] font-bold text-sky-300 hover:underline">
                    Open ↗
                  </a>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="App limits" subtitle="Enforced by this codebase , change them in code">
          <div className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
            {APP_LIMITS.map((a) => (
              <div key={a.label} className="flex items-start justify-between gap-3 rounded-lg bg-white/[0.03] px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs text-text-secondary">
                    <span className="mr-1.5 text-[9px] font-black uppercase tracking-wider text-text-muted">{a.area}</span>
                    {a.label}
                  </p>
                  <p className="font-mono text-[10px] text-text-muted">{a.where}</p>
                </div>
                <span className="shrink-0 text-xs font-black tabular-nums text-white">{a.value}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <LimitEditor config={config} onSaved={setConfig} />
    </div>
  );
}

/** Open presence sessions: one per open tab, which is one Realtime Database connection each. */
function useSessionCount(): number {
  const [n, setN] = useState(0);
  useEffect(
    () =>
      onValue(
        ref(rtdb, "presenceSessions/users"),
        (snap) => {
          let count = 0;
          for (const sessions of Object.values((snap.val() ?? {}) as Record<string, Record<string, boolean>>)) {
            count += Object.values(sessions ?? {}).filter((v) => v === true).length;
          }
          setN(count);
        },
        () => setN(0),
      ),
    [],
  );
  return n;
}

function formatFor(l: ServiceLimit, n: number): string {
  if (l.unit === "bytes") return formatBytes(n);
  if (l.unit === "percent") return `${n.toFixed(1)}%`;
  return Math.round(n).toLocaleString();
}

const PERIOD: Record<ServiceLimit["period"], string> = {
  day: "today",
  month: "this month",
  now: "right now",
  total: "stored",
};

function QuotaRow({
  limit,
  ceiling,
  used,
  estimated,
  projected,
  overText,
}: {
  limit: ServiceLimit;
  ceiling: number;
  used: number | null;
  estimated: boolean;
  projected: number | null;
  overText: string;
}) {
  const ratio = used !== null && ceiling > 0 ? used / ceiling : 0;
  const tone = ratio >= 0.9 ? "bg-red-500" : ratio >= 0.7 ? "bg-amber-400" : "bg-emerald-400";
  const status = ratio >= 0.9 ? "Critical" : ratio >= 0.7 ? "High" : "OK";
  return (
    <div title={`Past the limit: ${overText}`}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-bold text-text-secondary">
          {limit.label}
          <span className="text-[10px] font-normal text-text-muted">{PERIOD[limit.period]}</span>
          {estimated && (
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-text-muted">est</span>
          )}
        </span>
        <span className="text-[11px] tabular-nums text-text-muted">
          {used === null ? "no data" : `${formatFor(limit, used)} / ${formatFor(limit, ceiling)}`}
          {used !== null && (
            <span className={`ml-1.5 font-bold ${ratio >= 0.9 ? "text-red-400" : ratio >= 0.7 ? "text-amber-400" : "text-emerald-400"}`}>
              {Math.round(ratio * 100)}% · {status}
            </span>
          )}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(1, ratio) * 100}%` }} />
      </div>
      {projected !== null && (
        <p className={`mt-1 text-[10px] ${projected > ceiling ? "text-amber-300" : "text-text-muted"}`}>
          On pace for {formatFor(limit, projected)} by the reset
          {projected > ceiling ? `, over the limit (${overText.toLowerCase()})` : ""}
        </p>
      )}
    </div>
  );
}

/**
 * One series as thin hourly bars, with a hover readout. Single series, so no
 * legend: the title names it.
 */
function MiniBars({ title, points, format }: { title: string; points: Point[]; format: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...points.map((p) => p.v));
  const W = 480;
  const H = 56;
  const gap = 2;
  const bw = points.length > 0 ? Math.max(2, W / points.length - gap) : 0;
  const shown = hover !== null ? points[hover] : points[points.length - 1];
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-bold text-text-secondary">{title}</span>
        <span className="text-[11px] tabular-nums text-text-muted">
          {shown
            ? `${format(shown.v)} · ${new Date(shown.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "no data"}
        </span>
      </div>
      {points.length === 0 ? (
        <div className="flex h-14 items-center justify-center rounded-lg bg-white/[0.03] text-[11px] text-text-muted">
          No series for this metric
        </div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" preserveAspectRatio="none" onMouseLeave={() => setHover(null)}>
          <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="currentColor" className="text-white/15" strokeWidth="1" />
          {points.map((p, i) => {
            const h = Math.max(1, (p.v / max) * (H - 4));
            const x = i * (bw + gap);
            return (
              <g key={p.t} onMouseEnter={() => setHover(i)}>
                {/* Hit target: the full column, taller than the bar. */}
                <rect x={x} y={0} width={bw + gap} height={H} fill="transparent" />
                <rect
                  x={x}
                  y={H - h}
                  width={bw}
                  height={h}
                  rx={Math.min(2, bw / 2)}
                  className={hover === i ? "fill-sky-300" : "fill-sky-500"}
                />
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/** Correct any default that no longer matches the provider's pricing page. */
function LimitEditor({ config, onSaved }: { config: LimitsConfig; onSaved: (c: LimitsConfig) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  const save = async () => {
    const overrides: Record<string, number> = { ...config.overrides };
    for (const [k, v] of Object.entries(draft)) {
      const n = Number(v);
      if (v.trim() === "") delete overrides[k];
      else if (Number.isFinite(n) && n > 0) overrides[k] = n;
    }
    setSaving(true);
    try {
      const next = { ...config, overrides };
      await saveLimitsConfig(next);
      onSaved(next);
      setDraft({});
      setNote("Saved.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Edit ceilings"
      subtitle="Defaults come from each provider's pricing page. Bytes are raw bytes; blank resets to the default."
      right={
        <button onClick={() => setOpen((o) => !o)} className="text-xs font-bold text-sky-300 hover:underline">
          {open ? "Hide" : "Show"}
        </button>
      }
    >
      {open && (
        <div className="space-y-2">
          {SERVICE_LIMITS.map((l) => (
            <div key={l.key} className="flex items-center gap-3 text-xs">
              <span className="w-64 truncate text-text-secondary">
                {l.service} · {l.label}
              </span>
              <span className="w-28 text-right tabular-nums text-text-muted">
                default {formatFor(l, config.plan === "blaze" ? l.blaze : l.spark)}
              </span>
              <input
                value={draft[l.key] ?? (config.overrides[l.key] ? String(config.overrides[l.key]) : "")}
                onChange={(e) => setDraft((d) => ({ ...d, [l.key]: e.target.value }))}
                placeholder="default"
                inputMode="numeric"
                className="w-40 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 tabular-nums text-white outline-none"
              />
            </div>
          ))}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => void save()}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save ceilings
            </button>
            {note && <span className="text-[11px] text-text-muted">{note}</span>}
            <CloudCog size={14} className="ml-auto text-text-muted" />
          </div>
        </div>
      )}
    </Card>
  );
}
