// Bilal Saeed xxxxx
"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/store/useAuthStore";
import { auth, db } from "@/lib/firebase";
import { signOut } from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { GAMES } from "@/lib/games";
import AuthGuard from "@/components/AuthGuard";
import {
  Gamepad2,
  LogOut,
  Plus,
  ArrowRight,
  User as UserIcon,
  Play,
  Trophy,
  Users,
} from "lucide-react";

export default function DashboardPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const [isCreating, setIsCreating] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [userStats, setUserStats] = useState({ friendsOnline: 0, gamesPlayed: 0, winRate: "0%" });
  const [loadingStats, setLoadingStats] = useState(true);

  useEffect(() => {
    if (!user) return;
    const fetchStats = async () => {
      try {
        const userRef = doc(db, "users", user.uid);
        const snap = await getDoc(userRef);
        if (snap.exists()) {
          const data = snap.data();
          const games = data.stats?.gamesPlayed || 0;
          const wins = data.stats?.wins || 0;
          const winRate = games > 0 ? Math.round((wins / games) * 100) + "%" : "0%";
          setUserStats({
            friendsOnline: data.stats?.friendsOnline || 0,
            gamesPlayed: games,
            winRate: winRate,
          });
        }
      } catch (error) {
        console.error("Error fetching user stats:", error);
      } finally {
        setLoadingStats(false);
      }
    };
    fetchStats();
  }, [user]);

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      router.push("/");
    } catch (error) {
      console.error("Error signing out:", error);
    }
  };

  const createLobby = async (gameId: string | null = null) => {
    if (!user) return;
    setIsCreating(true);
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    try {
      await setDoc(doc(db, "lobbies", roomId), {
        hostId: user.uid,
        status: "waiting",
        gameId: typeof gameId === 'string' ? gameId : null,
        players: [],
        createdAt: serverTimestamp(),
      });
      router.push(`/lobby/${roomId}`);
    } catch (e) {
      console.error("Error creating lobby", e);
      setIsCreating(false);
    }
  };

  const joinLobby = (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCode || joinCode.trim() === "") return;
    setIsJoining(true);
    router.push(`/lobby/${joinCode.trim().toUpperCase()}`);
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
        <nav className="relative z-10 glass border-b border-white/5 px-6 py-4 flex items-center justify-between">
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

          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
                <p className="text-sm font-bold text-white">{user?.displayName}</p>
                <p className="text-xs text-text-muted">{user?.email}</p>
              </div>
              <img
                src={user?.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.uid}`}
                alt="Profile"
                className="w-10 h-10 rounded-full border-2 border-primary/50"
              />
            </div>
            <button
              onClick={handleSignOut}
              className="p-2 rounded-lg glass hover:bg-white/10 text-text-muted hover:text-white transition-colors"
              title="Sign Out"
            >
              <LogOut size={20} />
            </button>
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
              <form onSubmit={joinLobby} className="flex items-center glass rounded-2xl p-1 border border-white/10 hover:border-white/20 transition-colors">
                <input 
                  type="text" 
                  placeholder="Enter Code" 
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  className="bg-transparent border-none outline-none text-white px-4 py-2 w-32 uppercase placeholder:text-text-muted/50 placeholder:normal-case font-mono font-bold"
                  maxLength={6}
                />
                <button 
                  type="submit"
                  disabled={isJoining || joinCode.length < 3}
                  className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-xl text-sm font-bold transition-colors disabled:opacity-50"
                >
                  {isJoining ? "..." : "Join"}
                </button>
              </form>
              
              <div className="text-text-muted font-bold text-sm hidden sm:block">OR</div>

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
            </div>
          </div>

          {/* Quick Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-16">
            {[
              { label: "Friends Online", value: loadingStats ? "-" : userStats.friendsOnline, icon: Users, color: "text-green-400" },
              { label: "Games Played", value: loadingStats ? "-" : userStats.gamesPlayed, icon: Gamepad2, color: "text-blue-400" },
              { label: "Win Rate", value: loadingStats ? "-" : userStats.winRate, icon: Trophy, color: "text-yellow-400" },
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

          {/* Games Grid */}
          <div>
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                <Play size={24} className="text-primary fill-primary" />
                Available Games
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {GAMES.map((game, index) => (
                <motion.div
                  key={game.id}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: index * 0.05 }}
                  className="group relative glass rounded-2xl p-6 border border-white/5 hover:border-transparent transition-all cursor-pointer overflow-hidden"
                  onClick={() => createLobby(game.id)}
                >
                  <motion.div
                    className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                    style={{
                      background: `linear-gradient(135deg, ${game.borderColor}, transparent)`,
                    }}
                  />
                  <div className="relative z-10">
                    <div className="w-16 h-16 sm:w-20 sm:h-20 mb-4 transform group-hover:scale-110 group-hover:-translate-y-1 transition-transform overflow-hidden rounded-2xl flex items-center justify-center shadow-lg">
                      {game.icon}
                    </div>
                    <h3 className="text-xl font-bold text-white mb-1">{game.name}</h3>
                    <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-4">
                      {game.category} • {game.players}P
                    </p>
                    <div className={`text-sm opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-r ${game.color} bg-clip-text text-transparent font-bold flex items-center gap-2`}>
                      Play Now <ArrowRight size={16} />
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
// Bilal Saeed xxxxx
