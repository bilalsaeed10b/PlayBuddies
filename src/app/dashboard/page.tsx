
"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/store/useAuthStore";
import { auth, db } from "@/lib/firebase";
import { signOut } from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { getRememberedLobby, forgetLobby } from "@/lib/lastLobby";
import { PLAYABLE_GAMES, gameAccent, playerCountLabel } from "@/lib/games";
import GameThumb from "@/components/GameThumb";
import AuthGuard from "@/components/AuthGuard";
import {
  generateRoomCode,
  normalizeRoomCode,
  isValidRoomCode,
  ROOM_CODE_LENGTH,
  LOBBY_TTL_MS,
} from "@/lib/rooms";
import { useFriends } from "@/hooks/useFriends";
import { useFriendsOnline } from "@/hooks/usePresence";
import {
  Gamepad2,
  LogOut,
  Plus,
  ArrowRight,
  Play,
  Users,
  ChevronDown,
  User,
  ShieldAlert,
} from "lucide-react";
import { isAdminUser } from "@/lib/admin";
import Inbox from "@/components/Inbox";
import DailyChallenges from "@/components/DailyChallenges";
import GemStore, { GemBalance } from "@/components/GemStore";
import { useGemAccount } from "@/hooks/useGemAccount";

const CREATE_LOBBY_TIMEOUT_MS = 12_000;

async function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Lobby creation timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export default function DashboardPage() {
  // Bilal Saeed 123
  const { user, stats: cachedStats, statsFetchedAt, setStats } = useAuthStore();
  // Bilal Saeed 123
  const router = useRouter();
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [userStats, setUserStats] = useState({ gamesPlayed: 0 });
  const [loadingStats, setLoadingStats] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);
  const [gemStoreOpen, setGemStoreOpen] = useState(false);
  const gemAccount = useGemAccount();
  const profileRef = useRef<HTMLDivElement>(null);
  // Read once on mount: localStorage isn't available during the server render,
  // and reading it in the body would make the first paint mismatch.
  const [resumeRoom, setResumeRoom] = useState<string | null>(null);

  // "Friends Online" is derived from live presence. It used to read a
  // `stats.friendsOnline` field on the user document that nothing ever wrote,
  // so it always displayed 0.
  const { friends } = useFriends();
  const friendUids = useMemo(() => friends.map((f) => f.uid), [friends]);
  const onlineFriends = useFriendsOnline(friendUids);

  useEffect(() => {
    if (!user) return;

    // Serve cached stats if fresh (under 5 minutes old) to avoid a read per visit.
    const STALE_THRESHOLD = 5 * 60 * 1000;
    if (cachedStats && Date.now() - statsFetchedAt < STALE_THRESHOLD) {
      setUserStats(cachedStats);
      setLoadingStats(false);
      return;
    }

    let cancelled = false;
    const fetchStats = async () => {
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (cancelled || !snap.exists()) return;
        const data = snap.data();
        const games = data.stats?.gamesPlayed || 0;
        if (useAuthStore.getState().user?.uid !== user.uid) return;
        const freshStats = { gamesPlayed: games };
        setUserStats(freshStats);
        setStats(freshStats);
      } catch (error) {
        console.error("Error fetching user stats:", error);
      } finally {
        if (!cancelled) setLoadingStats(false);
      }
    };
    fetchStats();
    return () => {
      cancelled = true;
    };
    // cachedStats/setStats/statsFetchedAt intentionally omitted — stale-check
    // runs once on mount; adding them would re-fetch on every store update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    setResumeRoom(getRememberedLobby());
  }, []);

  // Close the profile dropdown when clicking outside.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      router.push("/");
    } catch (error) {
      console.error("Error signing out:", error);
    }
  };

  const createLobby = async (gameId: string | null = null) => {
    if (!user || isCreating) return;
    setIsCreating(true);
    setCreateError("");

    // Create means a fresh room. Rejoining the previous room remains available
    // through the separate resume card below. Reading that remembered room
    // here used to put a stale Firestore request in front of every creation;
    // if the read stalled, the button stayed on "Creating..." forever.
    forgetLobby();
    setResumeRoom(null);

    const roomId = generateRoomCode();
    try {
      // `players` is a MAP keyed by uid, and the host is seeded here. The lobby
      // page updates it with dotted paths (`players.<uid>`), which Firestore
      // rejects against an array field , that mismatch meant a host never
      // appeared in the lobby they had just created.
      await withTimeout(
        setDoc(doc(db, "lobbies", roomId), {
          hostId: user.uid,
          hostSeenAt: serverTimestamp(),
          status: "waiting",
          gameId: typeof gameId === "string" ? gameId : null,
          players: {
            [user.uid]: {
              uid: user.uid,
              displayName: (user.displayName || "Player").slice(0, 60),
              photoURL: (user.photoURL || "").slice(0, 500),
              // Joining a lobby is an explicit action; start every new host in
              // the same ready state as invited guests.
              isReady: true,
            },
          },
          createdAt: serverTimestamp(),
          expiresAt: new Date(Date.now() + LOBBY_TTL_MS),
        }),
        CREATE_LOBBY_TIMEOUT_MS,
      );
      router.push(`/lobby?room=${roomId}`);
    } catch (e) {
      console.error("Error creating lobby", e);
      const timedOut = e instanceof Error && e.message === "Lobby creation timed out";
      setCreateError(
        !navigator.onLine
          ? "You are offline. Reconnect, then try again."
          : timedOut
            ? "Lobby creation took too long. Please try again."
            : "Couldn't create the lobby. Please try again.",
      );
      setIsCreating(false);
    }
  };

  const joinLobby = (e: React.FormEvent) => {
    e.preventDefault();
    const code = normalizeRoomCode(joinCode);
    if (!isValidRoomCode(code)) {
      setJoinError("That code doesn't look right. It's 6 letters and numbers.");
      return;
    }
    setJoinError("");
    setIsJoining(true);
    router.push(`/lobby?room=${code}`);
  };

  return (
    <AuthGuard>
      <div className="min-h-screen bg-background relative overflow-hidden">
        {/* Animated Background */}
        <div className="absolute inset-0 bg-grid animate-grid-pulse opacity-50" />
        <div
          className="absolute top-0 right-0 w-[500px] h-[500px] rounded-full mix-blend-screen"
          style={{
            background: "radial-gradient(circle, rgba(139, 92, 246, 0.15) 0%, transparent 70%)",
          }}
        />

        {/* Dashboard Nav */}
        <nav className="relative z-40 glass border-b border-white/5 px-6 py-4 flex items-center justify-between">
          <div
            className="flex items-center gap-3 cursor-pointer"
            onClick={() => router.push("/")}
          >
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              <Gamepad2 size={22} className="text-white" />
            </div>
            <span className="text-xl font-extrabold font-[family-name:var(--font-display)] tracking-tight">
              Play<span className="text-primary">Buddies</span>
            </span>
          </div>

          <div className="flex items-center gap-3" ref={profileRef}>
            <GemBalance gems={gemAccount.gems} onClick={() => setGemStoreOpen(true)} />
            <Inbox />
            {/* Profile pill */}
            <div className="relative">
              <button
                onClick={() => setProfileOpen((v) => !v)}
                className="flex items-center gap-2 glass border border-white/10 hover:border-primary/40 rounded-2xl px-3 py-2 transition-all hover:bg-white/5 group"
                aria-label="Profile menu"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={user?.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.uid}`}
                  alt="Profile"
                  onError={(e) => {
                    e.currentTarget.onerror = null;
                    e.currentTarget.src = `https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.uid}`;
                  }}
                  className="w-8 h-8 rounded-full border-2 border-primary/50"
                />
                <div className="hidden sm:block text-left">
                  <p className="text-sm font-bold text-white leading-tight">{user?.displayName?.split(" ")[0]}</p>
                </div>
                <ChevronDown
                  size={14}
                  className={`text-text-muted transition-transform duration-200 ${profileOpen ? "rotate-180" : ""}`}
                />
              </button>

              {/* Dropdown */}
              {profileOpen && (
                <div className="absolute right-0 top-full mt-2 w-64 glass-solid bg-[#161626] rounded-2xl border border-white/10 shadow-2xl z-50 overflow-hidden">
                  {/* User info header */}
                  <div className="p-4 border-b border-white/10">
                    <div className="flex items-center gap-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={user?.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.uid}`}
                        alt="Profile"
                        onError={(e) => {
                          e.currentTarget.onerror = null;
                          e.currentTarget.src = `https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.uid}`;
                        }}
                        className="w-12 h-12 rounded-full border-2 border-primary/50 shrink-0"
                      />
                      <div className="min-w-0">
                        <p className="font-bold text-white truncate">{user?.displayName}</p>
                        <p className="text-xs text-text-muted truncate">{user?.email}</p>
                      </div>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="grid grid-cols-2 gap-px bg-white/5 border-b border-white/10">
                    <div className="bg-[#161626] p-3 text-center">
                      <p className="text-lg font-black text-white">{onlineFriends.size}</p>
                      <p className="text-[10px] text-text-muted uppercase tracking-wider flex items-center justify-center gap-1">
                        <Users size={10} /> Online
                      </p>
                    </div>
                    <div className="bg-[#161626] p-3 text-center">
                      <p className="text-lg font-black text-white">
                        {loadingStats ? "—" : userStats.gamesPlayed}
                      </p>
                      <p className="text-[10px] text-text-muted uppercase tracking-wider flex items-center justify-center gap-1">
                        <Gamepad2 size={10} /> Played
                      </p>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="p-2 space-y-0.5">
                    <button
                      onClick={() => { setProfileOpen(false); router.push("/profile"); }}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                    >
                      <User size={16} />
                      View Profile
                    </button>
                    {isAdminUser(user) && (
                      <button
                        onClick={() => { setProfileOpen(false); router.push("/admin"); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-amber-300 hover:bg-amber-500/10 transition-colors"
                      >
                        <ShieldAlert size={16} />
                        Admin Panel
                      </button>
                    )}
                    <button
                      onClick={() => { setProfileOpen(false); handleSignOut(); }}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
                    >
                      <LogOut size={16} />
                      Sign Out
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </nav>

        {/* Main Content */}
        <main className="relative z-10 max-w-7xl mx-auto px-6 py-12">
          {/* Header Action */}
          <div className="flex flex-col md:flex-row items-center justify-between gap-6 mb-12">
            <div>
              <h1 className="text-3xl md:text-5xl font-black font-[family-name:var(--font-display)] tracking-tight text-white mb-2">
                Welcome back,{" "}
                <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
                  {user?.displayName?.split(" ")[0]}
                </span>
                !
              </h1>
              <p className="text-text-secondary">
                Select a game to start playing or create a new lobby.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-4">
              <div className="flex flex-col gap-1">
                <form onSubmit={joinLobby} className="flex items-center glass rounded-2xl p-1 border border-white/10 hover:border-white/20 transition-colors">
                  <label htmlFor="join-code" className="sr-only">Room code</label>
                  <input
                    id="join-code"
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    placeholder="Enter Code"
                    value={joinCode}
                    onChange={(e) => {
                      setJoinCode(normalizeRoomCode(e.target.value));
                      if (joinError) setJoinError("");
                    }}
                    className="bg-transparent border-none outline-none text-white px-4 py-2 w-36 uppercase placeholder:text-text-muted/50 placeholder:normal-case placeholder:tracking-normal font-mono font-bold tracking-widest"
                    maxLength={ROOM_CODE_LENGTH}
                    aria-invalid={Boolean(joinError)}
                  />
                  <button
                    type="submit"
                    disabled={isJoining || joinCode.length !== ROOM_CODE_LENGTH}
                    className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-xl text-sm font-bold transition-colors disabled:opacity-50"
                  >
                    {isJoining ? "..." : "Join"}
                  </button>
                </form>
                {joinError && <p className="text-xs text-error px-2">{joinError}</p>}
              </div>

              <div className="text-text-muted font-bold text-sm hidden sm:block">OR</div>

              <div className="flex w-full flex-col gap-1 sm:w-auto">
                <motion.button
                  onClick={() => createLobby()}
                  disabled={isCreating}
                  whileHover={{ scale: 1.05, y: -2 }}
                  whileTap={{ scale: 0.95 }}
                  className="btn-glow flex items-center gap-3 px-8 py-4 bg-gradient-to-r from-primary to-accent rounded-2xl text-white font-bold text-lg shadow-xl shadow-primary/20 disabled:opacity-75 w-full sm:w-auto justify-center"
                >
                  <Plus size={22} className={isCreating ? "animate-spin" : ""} />
                  {isCreating ? "Creating..." : "Create Lobby"}
                </motion.button>
                {createError && (
                  <p role="alert" className="max-w-64 px-2 text-xs text-error">
                    {createError}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Resume banner. The room code only ever lived in the URL, so before
              this a reload or a stray "back" lost the room and the only way
              onward was a brand new lobby , stranding whoever was still in the
              old one. */}
          {resumeRoom && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="glass mb-8 rounded-2xl border border-primary/30 p-5 flex flex-col sm:flex-row sm:items-center gap-4 justify-between"
            >
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-primary/15 text-primary shrink-0">
                  <Gamepad2 size={24} />
                </div>
                <div>
                  <p className="font-bold text-white">You were in a lobby</p>
                  <p className="text-sm text-text-muted">
                    Room <span className="font-mono tracking-widest text-white">{resumeRoom}</span> is
                    still open. Jump back in instead of starting over.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => router.push(`/lobby?room=${resumeRoom}`)}
                  className="px-5 py-3 rounded-xl bg-primary hover:bg-primary/90 text-white font-bold transition-colors flex items-center gap-2"
                >
                  Rejoin <ArrowRight size={16} />
                </button>
                <button
                  onClick={() => {
                    forgetLobby();
                    setResumeRoom(null);
                  }}
                  className="px-4 py-3 rounded-xl border border-white/10 text-text-muted hover:text-white hover:bg-white/5 text-sm font-medium transition-colors"
                >
                  Start fresh
                </button>
              </div>
            </motion.div>
          )}

          {/* Quick Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-16">
            {[
              { label: "Friends Online", value: onlineFriends.size, icon: Users, color: "text-green-400" },
              { label: "Games Played", value: loadingStats ? "-" : userStats.gamesPlayed, icon: Gamepad2, color: "text-blue-400" },
            ].map((stat, i) => (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.1 }}
                className="glass p-6 rounded-2xl flex items-center justify-between group cursor-pointer hover:bg-white/5 transition-colors border border-white/5 hover:border-white/10"
              >
                <div>
                  <p className="text-sm text-text-muted mb-1">{stat.label}</p>
                  <p className="text-3xl font-black text-white">{stat.value}</p>
                </div>
                <div className={`p-4 rounded-xl bg-white/5 ${stat.color}`}>
                  <stat.icon size={28} />
                </div>
              </motion.div>
            ))}
          </div>

          <DailyChallenges state={gemAccount.challenges} onPlay={createLobby} />

          {/* Games Grid */}
          <div>
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                <Play size={24} className="text-primary fill-primary" />
                Available Games
              </h2>
            </div>
            <div className="flex flex-wrap gap-6">
              {PLAYABLE_GAMES.map((game, index) => (
                <motion.div
                  key={game.id}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: index * 0.05 }}
                  className="group relative w-36 sm:w-40 glass rounded-2xl p-4 border border-white/5 hover:border-transparent transition-all cursor-pointer overflow-hidden"
                  onClick={() => createLobby(game.id)}
                >
                  <motion.div
                    className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                    style={{
                      background: `linear-gradient(135deg, ${gameAccent(game).from}33, transparent)`,
                    }}
                  />
                  <div className="relative z-10 flex flex-col items-center text-center">
                    <div className="w-20 h-20 sm:w-24 sm:h-24 mb-4 transform group-hover:scale-110 group-hover:-translate-y-1 transition-transform overflow-hidden rounded-2xl flex items-center justify-center shadow-lg">
                      <GameThumb game={game} size={96} className="w-full h-full" />
                    </div>
                    <h3 className="text-xl font-bold text-white mb-1">{game.name}</h3>
                    <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                      {game.category} • {playerCountLabel(game)}P
                    </p>
                    <div
                      className="absolute inset-x-0 top-full pt-3 text-sm opacity-0 group-hover:opacity-100 transition-opacity bg-clip-text text-transparent font-bold flex items-center justify-center gap-2"
                      style={{ backgroundImage: `linear-gradient(to right, ${gameAccent(game).from}, ${gameAccent(game).to})` }}
                    >
                      Play Now <ArrowRight size={16} />
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </main>
        <GemStore open={gemStoreOpen} gems={gemAccount.gems} onClose={() => setGemStoreOpen(false)} />
      </div>
    </AuthGuard>
  );
}

