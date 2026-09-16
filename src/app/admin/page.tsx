"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowLeft,
  Bug,
  Database,
  Gauge,
  Gamepad2,
  Loader2,
  Moon,
  RefreshCw,
  ShieldAlert,
  Signal,
  Sun,
  Users,
} from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import { isAdminUser } from "@/lib/admin";
import { useAdminTheme } from "@/lib/useAdminTheme";
import AuthGuard from "@/components/AuthGuard";
import BugQueuePanel from "@/components/admin/BugQueuePanel";
import PlayersPanel from "@/components/admin/PlayersPanel";
import GamesPanel from "@/components/admin/GamesPanel";
import LivePanel from "@/components/admin/LivePanel";
import SystemPanel from "@/components/admin/SystemPanel";
import OverviewPanel from "@/components/admin/OverviewPanel";
import { useAllUsers, useLiveLobbies, useNetworkHealth, useOnlineUids } from "@/lib/adminMetrics";
import { watchAllReports, type BugReport } from "@/lib/bugs";

const TABS = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "bugs", label: "Bug queue", icon: Bug },
  { id: "live", label: "Live rooms", icon: Activity },
  { id: "players", label: "Players", icon: Users },
  { id: "games", label: "Games", icon: Gamepad2 },
  { id: "system", label: "System", icon: Database },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * The admin panel.
 *
 * Everything below the allowlist check is UI. The real gate is in
 * firestore.rules and storage.rules, which refuse the reads this page makes
 * unless the token carries an admin address , this component only decides
 * whether to render a panel or a locked door, and a hostile client editing the
 * bundle to skip it gets a screen full of permission errors and nothing else.
 */
export default function AdminPage() {
  return (
    <AuthGuard>
      <AdminShell />
    </AuthGuard>
  );
}

function AdminShell() {
  const { user } = useAuthStore();
  const router = useRouter();
  const [tab, setTab] = useState<TabId>("overview");
  const [refreshKey, setRefreshKey] = useState(0);
  const [theme, toggleTheme] = useAdminTheme();

  const allowed = isAdminUser(user);

  // One set of subscriptions for the whole panel, shared by every tab, so
  // switching tabs costs nothing and every number on screen came from the
  // same moment.
  const [reports, setReports] = useState<BugReport[]>([]);
  const [reportsError, setReportsError] = useState("");
  const [reportsLoading, setReportsLoading] = useState(true);

  useEffect(() => {
    if (!allowed) return;
    return watchAllReports(
      (list) => {
        setReports(list);
        setReportsLoading(false);
        setReportsError("");
      },
      (e) => {
        setReportsError(e.message);
        setReportsLoading(false);
      },
    );
  }, [allowed]);

  const { lobbies, error: lobbyError } = useLiveLobbies(allowed);
  const { users, loading: usersLoading, error: usersError } = useAllUsers(allowed, refreshKey);
  const onlineUids = useOnlineUids(allowed);
  const health = useNetworkHealth(allowed, user?.uid ?? "");

  const onlineSet = useMemo(() => new Set(onlineUids), [onlineUids]);

  if (!allowed) return <LockedDoor email={user?.email ?? ""} onBack={() => router.push("/dashboard")} />;

  const errors = [reportsError, lobbyError, usersError].filter(Boolean);

  return (
    <div
      data-theme={theme}
      style={{ colorScheme: theme }}
      className="adm-bg min-h-screen relative"
    >
      <div className="absolute inset-0 bg-grid opacity-40 pointer-events-none" />

      <nav className="relative z-30 glass border-b border-white/5 px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => router.push("/dashboard")}
            className="w-9 h-9 rounded-xl hover:bg-white/10 flex items-center justify-center text-text-muted shrink-0"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-orange-500 flex items-center justify-center shrink-0">
            <ShieldAlert size={20} className="text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-black text-white leading-tight">Admin</h1>
            <p className="text-[11px] text-text-muted truncate">{user?.email}</p>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <LiveDot online={health.rtdbConnected} />
          <button
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle theme"
            className="w-9 h-9 rounded-xl glass border border-white/10 hover:border-white/25 flex items-center justify-center text-text-secondary transition-colors"
          >
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="flex items-center gap-2 px-3 py-2 rounded-xl glass border border-white/10 hover:border-white/25 text-xs font-bold text-text-secondary transition-colors"
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </nav>

      <div className="relative z-20 border-b border-white/5 px-2 sm:px-6 overflow-x-auto">
        <div className="flex gap-1 min-w-max">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-bold border-b-2 transition-colors whitespace-nowrap ${
                tab === id
                  ? "border-primary text-white"
                  : "border-transparent text-text-muted hover:text-white"
              }`}
            >
              <Icon size={15} />
              {label}
              {id === "bugs" && openCount(reports) > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-red-500 text-white text-[10px] font-black">
                  {openCount(reports)}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-8">
        {errors.length > 0 && (
          <div className="mb-6 rounded-2xl border border-red-500/30 bg-red-500/10 p-4">
            <p className="text-sm font-bold text-red-300 mb-1">Some data could not be read</p>
            {errors.map((e) => (
              <p key={e} className="text-xs text-red-200/80">
                {e}
              </p>
            ))}
            <p className="text-xs text-red-200/60 mt-2">
              If this says “Missing or insufficient permissions”, deploy the rules:{" "}
              <code className="font-mono">firebase deploy --only firestore:rules,storage</code>
            </p>
          </div>
        )}

        {reportsLoading && usersLoading ? (
          <div className="py-24 flex flex-col items-center gap-3">
            <Loader2 size={32} className="animate-spin text-primary" />
            <p className="text-text-muted text-sm">Reading the platform…</p>
          </div>
        ) : (
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
          >
            {tab === "overview" && (
              <OverviewPanel
                reports={reports}
                users={users}
                lobbies={lobbies}
                onlineCount={onlineSet.size}
                health={health}
                onJump={setTab}
              />
            )}
            {tab === "bugs" && (
              <BugQueuePanel
                reports={reports}
                admin={{ uid: user?.uid ?? "", email: user?.email ?? "" }}
                onChanged={() => setRefreshKey((k) => k + 1)}
              />
            )}
            {tab === "live" && (
              <LivePanel
                lobbies={lobbies}
                onlineUids={onlineSet}
                totalPlayers={users.length}
                health={health}
                onChanged={() => setRefreshKey((k) => k + 1)}
              />
            )}
            {tab === "players" && (
              <PlayersPanel
                users={users}
                loading={usersLoading}
                onlineUids={onlineSet}
                reports={reports}
                onChanged={() => setRefreshKey((k) => k + 1)}
              />
            )}
            {tab === "games" && <GamesPanel users={users} lobbies={lobbies} reports={reports} />}
            {tab === "system" && (
              <SystemPanel users={users} reports={reports} lobbies={lobbies} health={health} onlineCount={onlineSet.size} />
            )}
          </motion.div>
        )}
      </main>
    </div>
  );
}

function openCount(reports: BugReport[]): number {
  return reports.filter((r) => !["approved", "rejected", "duplicate"].includes(r.status)).length;
}

function LiveDot({ online }: { online: boolean }) {
  return (
    <span className="hidden sm:flex items-center gap-2 text-[11px] font-bold text-text-muted">
      <span
        className={`w-2 h-2 rounded-full ${online ? "bg-emerald-400 animate-pulse" : "bg-red-500"}`}
      />
      <Signal size={12} />
      {online ? "Live" : "Offline"}
    </span>
  );
}

function LockedDoor({ email, onBack }: { email: string; onBack: () => void }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="glass rounded-3xl border border-white/10 p-10 max-w-md text-center">
        <div className="w-16 h-16 mx-auto rounded-2xl bg-red-500/15 flex items-center justify-center mb-5">
          <ShieldAlert size={30} className="text-red-400" />
        </div>
        <h1 className="text-2xl font-black text-white mb-2">Admins only</h1>
        <p className="text-sm text-text-secondary mb-1">
          {email ? `${email} is not on the admin list.` : "This account is not on the admin list."}
        </p>
        <p className="text-xs text-text-muted mb-6">
          The database enforces this too , signing in elsewhere will not help.
        </p>
        <button
          onClick={onBack}
          className="px-6 py-3 rounded-2xl bg-white/10 hover:bg-white/20 text-white font-bold text-sm transition-colors"
        >
          Back to dashboard
        </button>
      </div>
    </div>
  );
}
