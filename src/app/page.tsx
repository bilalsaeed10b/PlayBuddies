"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { signInWithPopup } from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import {
  Gamepad2, Users, Zap, Globe, Star, ArrowRight,
  Shield, Trophy, MessageSquare, Play, Menu, X, Loader2
} from "lucide-react";
import { GAMES } from "@/lib/games";

function ScanlineOverlay() {
  return (
    <div 
      className="fixed inset-0 pointer-events-none z-50 opacity-[0.03]"
      style={{
        backgroundImage: 'linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.06), rgba(0, 255, 0, 0.02), rgba(0, 0, 255, 0.06))',
        backgroundSize: '100% 4px, 6px 100%',
      }}
    />
  );
}

function FloatingRetroElements() {
  const [elements, setElements] = useState<{ id: number; size: number; duration: number; x: number; delay: number }[]>([]);

  useEffect(() => {
    setElements(
      Array.from({ length: 12 }, (_, i) => ({
        id: i,
        size: Math.random() * 50 + 20,
        duration: Math.random() * 15 + 10,
        x: Math.random() * 100,
        delay: Math.random() * 10,
      }))
    );
  }, []);

  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
      {elements.map((el, i) => (
        <motion.div
          key={el.id}
          className={`absolute border ${i % 2 === 0 ? 'border-primary/30 bg-primary/5 shadow-[0_0_20px_rgba(37,99,235,0.2)]' : 'border-accent/30 bg-accent/5 shadow-[0_0_20px_rgba(249,115,22,0.2)]'}`}
          style={{ width: el.size, height: el.size, left: `${el.x}%`, bottom: "-20%" }}
          animate={{
            y: ["0vh", "-120vh"],
            rotate: [0, 360],
            opacity: [0, 0.8, 0],
          }}
          transition={{
            duration: el.duration,
            repeat: Infinity,
            delay: el.delay,
            ease: "linear",
          }}
        />
      ))}
    </div>
  );
}

function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { user } = useAuthStore();
  const router = useRouter();
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const handleAuth = async () => {
    if (user) {
      router.push("/dashboard");
    } else {
      setIsLoggingIn(true);
      try {
        await signInWithPopup(auth, googleProvider);
        router.push("/dashboard");
      } catch (error) {
        console.error("Login Error:", error);
      } finally {
        setIsLoggingIn(false);
      }
    }
  };

  return (
    <>
      <motion.nav
        initial={{ y: -100 }}
        animate={{ y: 0 }}
        transition={{ type: "spring", stiffness: 100, damping: 20 }}
        className={`fixed top-0 left-0 right-0 z-40 transition-all duration-300 border-b ${scrolled
          ? "glass-strong border-primary/20 shadow-[0_4px_30px_rgba(37,99,235,0.15)] bg-bg/80 backdrop-blur-xl"
          : "border-transparent bg-transparent"
          }`}
      >
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <motion.div
            className="flex items-center gap-3 cursor-pointer group"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <div className="relative">
              <div className="w-10 h-10 rounded-none border border-primary bg-primary/10 flex items-center justify-center transform rotate-45 group-hover:rotate-90 transition-transform duration-500 shadow-[0_0_15px_rgba(37,99,235,0.4)]">
                <div className="transform -rotate-45 group-hover:-rotate-90 transition-transform duration-500">
                  <Gamepad2 size={20} className="text-primary" />
                </div>
              </div>
            </div>
            <span className="text-2xl font-[family-name:var(--font-display)] uppercase tracking-wider text-white drop-shadow-[0_0_5px_rgba(255,255,255,0.5)]">
              Play<span className="text-accent drop-shadow-[0_0_10px_rgba(249,115,22,0.8)]">Buddies</span>
            </span>
          </motion.div>

          <div className="hidden md:flex items-center gap-10">
            {["Games", "Features", "About"].map((item) => (
              <motion.a
                key={item}
                href={`#${item.toLowerCase()}`}
                className="text-sm uppercase tracking-[0.2em] text-text-secondary hover:text-white transition-colors relative group font-bold"
                whileHover={{ y: -2 }}
              >
                {item}
                <span className="absolute -bottom-2 left-0 w-0 h-[2px] bg-primary group-hover:w-full transition-all duration-300 shadow-[0_0_10px_rgba(37,99,235,0.5)]" />
              </motion.a>
            ))}
          </div>

          <div className="hidden md:flex items-center gap-4">
            {user ? (
              <button
                onClick={() => router.push("/dashboard")}
                className="flex items-center gap-2 hover:opacity-80 transition-opacity"
              >
                <img
                  src={user.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.uid}`}
                  alt="Avatar"
                  className="w-10 h-10 rounded-none border-2 border-primary shadow-[0_0_15px_rgba(37,99,235,0.5)]"
                />
              </button>
            ) : (
              <motion.button
                onClick={handleAuth}
                disabled={isLoggingIn}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="relative px-6 py-2 bg-transparent text-sm font-bold tracking-widest text-white uppercase overflow-hidden group disabled:opacity-75 border border-primary/50"
              >
                <div className="absolute inset-0 bg-primary translate-x-[-100%] group-hover:translate-x-0 transition-transform duration-300 ease-in-out z-0" />
                <span className="relative z-10 flex items-center gap-2 drop-shadow-[0_0_5px_rgba(255,255,255,0.8)]">
                  {isLoggingIn ? <Loader2 size={16} className="animate-spin" /> : null}
                  SYSTEM.LOGIN()
                </span>
                <div className="absolute inset-0 shadow-[inset_0_0_20px_rgba(37,99,235,0.4)] z-0 pointer-events-none" />
              </motion.button>
            )}
          </div>

          <button
            className="md:hidden p-2 text-primary drop-shadow-[0_0_5px_rgba(37,99,235,0.8)]"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X size={28} /> : <Menu size={28} />}
          </button>
        </div>
      </motion.nav>

      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, x: 100 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 100 }}
            className="fixed inset-0 z-30 bg-bg border-l border-primary/30 shadow-[0_0_30px_rgba(37,99,235,0.2)] pt-24 px-6 flex flex-col"
          >
            <div className="flex flex-col gap-6">
              {["Games", "Features", "About"].map((item, i) => (
                <motion.a
                  key={item}
                  href={`#${item.toLowerCase()}`}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.1 }}
                  className="text-3xl font-[family-name:var(--font-display)] uppercase text-white hover:text-primary transition-colors tracking-widest"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {item}
                </motion.a>
              ))}
              <motion.button
                onClick={() => {
                  setMobileMenuOpen(false);
                  handleAuth();
                }}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                className="mt-8 px-8 py-4 bg-primary text-xl font-bold tracking-widest text-white uppercase shadow-[0_0_20px_rgba(37,99,235,0.4)]"
              >
                {isLoggingIn ? <Loader2 size={24} className="animate-spin inline" /> : user ? "DASHBOARD" : "INITIATE_LOGIN"}
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function HeroSection() {
  const router = useRouter();
  const { user } = useAuthStore();
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handlePlay = async () => {
    if (user) {
      router.push("/dashboard");
    } else {
      setIsLoggingIn(true);
      try {
        await signInWithPopup(auth, googleProvider);
        router.push("/dashboard");
      } catch (error) {
        console.error("Login failed:", error);
      } finally {
        setIsLoggingIn(false);
      }
    }
  };

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden py-24 pb-16">
      
      {/* Intense Radial Gradients */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/20 blur-[120px] rounded-full mix-blend-screen pointer-events-none" />
      <div className="absolute top-[60%] left-[60%] -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-accent/20 blur-[100px] rounded-full mix-blend-screen pointer-events-none" />
      
      {/* Grid Pattern */}
      <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHBhdGggZD0iTTAgMGg0MHY0MEgweiIgZmlsbD0ibm9uZSIvPjxwYXRoIGQ9Ik0wIDM5LjVMMzkuNSAzOS41IiBzdHJva2U9InJnYmEoMzcsIDk5LCAyMzUsIDAuMSkiIHN0cm9rZS13aWR0aD0iMSIvPjxwYXRoIGQ9Ik0zOS41IDBMMzkuNSAzOS41IiBzdHJva2U9InJnYmEoMzcsIDk5LCAyMzUsIDAuMSkiIHN0cm9rZS13aWR0aD0iMSIvPjwvc3ZnPg==')] pointer-events-none opacity-50" />

      <motion.div className="relative z-10 max-w-7xl mx-auto px-6 text-center w-full">
        {/* Retro Badge */}
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="inline-flex items-center gap-2 px-6 py-2 mb-10 border border-success/40 bg-success/10 shadow-[0_0_15px_rgba(16,185,129,0.3)] backdrop-blur-sm"
        >
          <motion.div
            className="w-2.5 h-2.5 bg-success shadow-[0_0_8px_#10B981]"
            animate={{ opacity: [1, 0.2, 1] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          />
          <span className="text-sm font-bold text-success tracking-[0.3em] uppercase drop-shadow-[0_0_5px_rgba(16,185,129,0.8)]">
            SYSTEM ONLINE
          </span>
        </motion.div>

        {/* Hero Title */}
        <motion.h1
          className="text-6xl sm:text-7xl md:text-[8rem] lg:text-[10rem] font-black font-[family-name:var(--font-display)] tracking-tighter leading-[0.9] text-white uppercase mb-8 relative"
        >
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className="flex flex-col items-center justify-center gap-0 lg:-gap-4"
          >
            <span className="block drop-shadow-[0_0_20px_rgba(255,255,255,0.2)]">Multiplayer</span>
            <span className="block text-transparent bg-clip-text bg-gradient-to-r from-primary via-accent to-primary animate-gradient-shift filter drop-shadow-[0_0_40px_rgba(37,99,235,0.8)] pb-4 lg:pb-8 glitch-effect" data-text="ARCADE">
              ARCADE
            </span>
          </motion.div>
        </motion.h1>

        {/* Subtitle */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 1 }}
          className="text-lg md:text-2xl text-text-secondary max-w-2xl mx-auto mb-14 tracking-wide font-medium drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]"
        >
          No downloads. No servers. Just invite your crew and instantly sync into retro-styled action.
        </motion.p>

        {/* CTA Area */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-6 mb-20"
        >
          <button
            onClick={handlePlay}
            disabled={isLoggingIn}
            className="relative px-12 py-5 bg-transparent border-2 border-primary text-xl font-[family-name:var(--font-display)] tracking-[0.2em] text-white uppercase overflow-hidden group hover:shadow-[0_0_40px_rgba(37,99,235,0.6)] transition-all duration-300 w-full sm:w-auto"
          >
            <div className="absolute inset-0 bg-primary translate-y-[100%] group-hover:translate-y-0 transition-transform duration-300 ease-in-out z-0" />
            <span className="relative z-10 flex items-center justify-center gap-3 drop-shadow-[0_0_5px_rgba(255,255,255,1)]">
              {isLoggingIn ? <Loader2 size={24} className="animate-spin" /> : <Gamepad2 size={28} />}
              {user ? "ENTER.DASHBOARD()" : "START.GAME()"}
            </span>
          </button>

          <a
            href="#games"
            className="px-8 py-5 text-lg font-bold tracking-widest text-text-muted hover:text-white uppercase transition-colors flex items-center gap-2 group"
          >
            EXPLORE
            <span className="text-primary group-hover:translate-x-2 transition-transform shadow-primary">→</span>
          </a>
        </motion.div>

        {/* Floating App Store Badges (Style integration) */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1 }}
          className="flex flex-wrap items-center justify-center gap-8 md:gap-16 pt-10 border-t border-primary/20"
        >
          {[
            { label: "LATENCY", value: "<100MS", class: "text-success drop-shadow-[0_0_8px_#10B981]" },
            { label: "PLAYERS", value: "INFINITE", class: "text-accent drop-shadow-[0_0_8px_#F97316]" },
            { label: "RATING", value: "5.0 ★", class: "text-yellow-400 drop-shadow-[0_0_8px_#FACC15]" },
          ].map((stat, i) => (
            <div key={stat.label} className="flex flex-col items-center">
              <div className={`text-3xl font-[family-name:var(--font-display)] ${stat.class} tracking-wider`}>{stat.value}</div>
              <div className="text-xs font-bold tracking-[0.3em] text-text-muted mt-2">{stat.label}</div>
            </div>
          ))}
        </motion.div>
      </motion.div>
    </section>
  );
}

function GameCard({ game, index }: { game: (typeof GAMES)[0]; index: number }) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 50 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-100px" }}
      transition={{ delay: index * 0.1, duration: 0.5 }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="relative group bg-bg-alt border border-primary/20 p-1 md:p-2 hover:border-accent hover:shadow-[0_0_30px_rgba(249,115,22,0.3)] transition-all duration-300"
    >
      {/* Background Neon Glow */}
      <div className="absolute -inset-[1px] bg-gradient-to-r from-primary to-accent opacity-0 group-hover:opacity-100 blur-[2px] transition-opacity duration-300 -z-10" />

      <div className="relative h-full bg-surface-dark border border-white/5 p-6 flex flex-col justify-between min-h-[300px] overflow-hidden">
        {/* Cyberpunk accent lines */}
        <div className="absolute top-0 right-0 w-16 h-16 border-t-2 border-r-2 border-primary/40 -translate-y-2 translate-x-2 group-hover:border-primary transition-colors" />
        <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-primary/40 translate-y-2 -translate-x-2 group-hover:border-primary transition-colors" />

        <div className="flex justify-between items-start mb-6 relative z-10">
          <motion.div
            animate={{ rotate: isHovered ? 5 : 0, scale: isHovered ? 1.1 : 1 }}
            className="w-16 h-16 bg-primary/10 border border-primary flex items-center justify-center text-primary shadow-[0_0_15px_rgba(37,99,235,0.4)] group-hover:text-white group-hover:bg-primary transition-colors duration-300"
          >
            {game.icon}
          </motion.div>
          <span className="text-xs font-mono font-bold tracking-widest text-accent border border-accent/30 px-2 py-1 bg-accent/5">
            {game.players}P
          </span>
        </div>

        <div className="relative z-10">
          <p className="text-xs tracking-[0.2em] font-bold text-primary mb-2 uppercase">{game.category}</p>
          <h3 className="text-2xl font-[family-name:var(--font-display)] text-white mb-2 uppercase tracking-wide group-hover:text-accent transition-colors drop-shadow-[0_0_5px_rgba(255,255,255,0.5)]">
            {game.name}
          </h3>
          <p className="text-sm text-text-secondary leading-relaxed font-mono opacity-80 group-hover:opacity-100 transition-opacity">
            {game.description.substring(0, 80)}...
          </p>
        </div>

        {/* Hover Action Strip */}
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: isHovered ? 1 : 0, x: isHovered ? 0 : -20 }}
          className="absolute bottom-0 left-0 w-full h-1 bg-gradient-to-r from-primary to-accent"
        />
        <motion.div
          animate={{ opacity: isHovered ? 1 : 0 }}
          className="absolute bottom-6 right-6 text-primary drop-shadow-[0_0_8px_rgba(37,99,235,1)]"
        >
          <Play size={24} className="fill-current" />
        </motion.div>
      </div>
    </motion.div>
  );
}

function GamesSection() {
  return (
    <section id="games" className="py-32 px-6 relative border-t border-primary/20 bg-bg-alt">
      {/* Decorative scanline overlay specifically for section */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(37,99,235,0.03)_1px,transparent_1px)] bg-[size:100%_4px] pointer-events-none" />

      <div className="max-w-7xl mx-auto relative z-10">
        <div className="mb-16 border-l-4 border-primary pl-6">
          <p className="text-accent font-mono tracking-[0.3em] font-bold mb-2">DATABASE.QUERY()</p>
          <h2 className="text-5xl md:text-6xl font-black font-[family-name:var(--font-display)] tracking-wider text-white uppercase drop-shadow-[0_0_15px_rgba(255,255,255,0.3)]">
            AVAILABLE <span className="text-primary">MODULES</span>
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {GAMES.map((game, i) => (
            <GameCard key={game.id} game={game} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeaturesSection() {
  const features = [
    { icon: Zap, title: "Zero Latency", desc: "WebRTC peer-to-peer syncing. <100ms response.", color: "text-accent border-accent" },
    { icon: Users, title: "Lobby Sync", desc: "Create one lobby, switch games instantly.", color: "text-primary border-primary" },
    { icon: Globe, title: "Universal Port", desc: "Desktop, tablet, phone — all supported natively.", color: "text-success border-success" },
    { icon: Trophy, title: "Leaderboards", desc: "Track stats and climb global arcade rankings.", color: "text-yellow-400 border-yellow-400" },
  ];

  return (
    <section id="features" className="py-32 px-6 bg-bg border-t border-primary/20 relative overflow-hidden">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-20 relative">
          <h2 className="text-4xl md:text-5xl font-black font-[family-name:var(--font-display)] tracking-wider text-white uppercase mb-4">
            SYSTEM <span className="text-accent">CAPABILITIES</span>
          </h2>
          <div className="w-24 h-1 bg-gradient-to-r from-primary to-accent mx-auto shadow-[0_0_10px_rgba(249,115,22,0.8)]" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feat, i) => (
            <motion.div
              key={feat.title}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              whileHover={{ y: -10 }}
              transition={{ delay: i * 0.1 }}
              className="bg-surface-dark border border-white/10 p-8 flex flex-col items-center text-center group hover:bg-surface-light transition-colors"
            >
              <div className={`w-16 h-16 rounded-full border-2 ${feat.color} flex items-center justify-center mb-6 group-hover:scale-110 transition-transform shadow-[0_0_15px_currentColor]`}>
                <feat.icon size={28} className={feat.color.split(" ")[0]} />
              </div>
              <h3 className="text-xl font-bold font-[family-name:var(--font-display)] text-white tracking-widest mb-4 uppercase">{feat.title}</h3>
              <p className="text-text-secondary font-mono text-sm leading-relaxed opacity-80 group-hover:opacity-100">{feat.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCTA() {
  const router = useRouter();
  const { user } = useAuthStore();
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handlePlay = async () => {
    if (user) {
      router.push("/dashboard");
    } else {
      setIsLoggingIn(true);
      try {
        await signInWithPopup(auth, googleProvider);
        router.push("/dashboard");
      } catch (error) {
        console.error("Login failed:", error);
      } finally {
        setIsLoggingIn(false);
      }
    }
  };

  return (
    <section className="py-32 px-6 relative bg-gradient-to-b from-bg to-bg-alt overflow-hidden border-t-2 border-primary">
      <div className="absolute inset-0 bg-primary/5 blur-[100px] pointer-events-none" />
      <div className="max-w-4xl mx-auto text-center relative z-10 border border-primary/30 bg-black/50 backdrop-blur-md p-12 md:p-20">
        <h2 className="text-4xl md:text-6xl font-black font-[family-name:var(--font-display)] text-white uppercase tracking-tight mb-8 drop-shadow-[0_0_10px_rgba(255,255,255,0.5)]">
          READY TO <span className="text-primary glitch-effect" data-text="INITIALIZE?">INITIALIZE?</span>
        </h2>
        <p className="text-xl text-text-secondary mb-12 font-mono">
          &gt; Authentication required for leaderboard sync.<br/>
          &gt; Proceed to gaming environment.
        </p>
        <button
          onClick={handlePlay}
          disabled={isLoggingIn}
          className="mx-auto flex items-center gap-4 px-12 py-6 bg-accent text-white font-[family-name:var(--font-display)] text-2xl tracking-[0.2em] font-black uppercase hover:bg-accent-light shadow-[0_0_40px_rgba(249,115,22,0.6)] transition-all transform hover:scale-105"
        >
          {isLoggingIn ? <Loader2 size={28} className="animate-spin" /> : <Zap size={28} className="fill-current" />}
          {user ? "ACCESS_DASHBOARD" : "CONNECT_SECURE"}
        </button>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <main className="min-h-screen bg-bg text-text selection:bg-primary/50 relative overflow-x-hidden font-sans">
      <ScanlineOverlay />
      <FloatingRetroElements />
      <Navbar />
      <HeroSection />
      <GamesSection />
      <FeaturesSection />
      <FinalCTA />
      
      <footer className="py-8 text-center border-t border-white/10 text-text-muted font-mono text-xs tracking-widest relative z-10 bg-bg-alt">
        <p>PLAYBUDDIES_OS V1.0 © {new Date().getFullYear()} BILAL SAEED. ALL RIGHTS RESERVED.</p>
      </footer>
    </main>
  );
}
