
"use client";

import { useState, useEffect, useRef } from "react";
import {
  motion,
  AnimatePresence,
  useScroll,
  useTransform,
  useSpring,
  useInView,
  useMotionValue,
  useVelocity,
  useAnimationFrame,
} from "framer-motion";
import { useRouter } from "next/navigation";
import { signInWithPopup } from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import {
  Gamepad2,
  Users,
  Zap,
  Globe,
  Star,
  ArrowRight,
  Sparkles,
  Shield,
  Trophy,
  MessageSquare,
  Play,
  Menu,
  X,
  Loader2,
  ChevronDown,
  Wifi,
  Lock,
} from "lucide-react";
import { GAMES } from "@/lib/games";

// ─── Wrap (mod) helper ───────────────────────────────────────────────────────
function wrap(min: number, max: number, v: number) {
  const range = max - min;
  return ((((v - min) % range) + range) % range) + min;
}

// ─── Cursor Spotlight ────────────────────────────────────────────────────────
function CursorSpotlight() {
  const [pos, setPos] = useState({ x: -999, y: -999 });
  useEffect(() => {
    const move = (e: MouseEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener("mousemove", move);
    return () => window.removeEventListener("mousemove", move);
  }, []);
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[1] transition-opacity duration-300"
      style={{
        background: `radial-gradient(600px circle at ${pos.x}px ${pos.y}px, rgba(139,92,246,0.07), transparent 50%)`,
      }}
    />
  );
}

// ─── Floating Particles ───────────────────────────────────────────────────────
function FloatingParticles() {
  const [particles, setParticles] = useState<
    { id: number; x: number; y: number; size: number; dur: number; delay: number; color: string }[]
  >([]);
  useEffect(() => {
    const colors = [
      "rgba(139,92,246,0.5)",
      "rgba(236,72,153,0.4)",
      "rgba(59,130,246,0.3)",
      "rgba(16,185,129,0.3)",
    ];
    setParticles(
      Array.from({ length: 40 }, (_, i) => ({
        id: i,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: Math.random() * 3 + 1,
        dur: Math.random() * 20 + 12,
        delay: Math.random() * 12,
        color: colors[Math.floor(Math.random() * colors.length)],
      }))
    );
  }, []);
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
      {particles.map((p) => (
        <motion.div
          key={p.id}
          className="absolute rounded-full"
          style={{ width: p.size, height: p.size, left: `${p.x}%`, top: `${p.y}%`, background: p.color }}
          animate={{ y: [0, -300, 0], x: [0, 40, -40, 0], opacity: [0, 0.8, 0] }}
          transition={{ duration: p.dur, repeat: Infinity, delay: p.delay, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}

// ─── Animated Grid ────────────────────────────────────────────────────────────
function AnimatedGrid() {
  return (
    <motion.div
      className="fixed inset-0 pointer-events-none z-0"
      style={{
        backgroundImage:
          "linear-gradient(rgba(139,92,246,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(139,92,246,0.04) 1px, transparent 1px)",
        backgroundSize: "80px 80px",
      }}
      animate={{ backgroundPosition: ["0px 0px", "80px 80px"] }}
      transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
    />
  );
}

// ─── Navbar ─────────────────────────────────────────────────────────────────
function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user } = useAuthStore();
  const router = useRouter();
  const [logging, setLogging] = useState(false);

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", fn);
    return () => window.removeEventListener("scroll", fn);
  }, []);

  const handleAuth = async () => {
    if (user) { router.push("/dashboard"); return; }
    setLogging(true);
    try { await signInWithPopup(auth, googleProvider); router.push("/dashboard"); }
    catch (e) { console.error(e); }
    finally { setLogging(false); }
  };

  return (
    <>
      <motion.nav
        initial={{ y: -80 }}
        animate={{ y: 0 }}
        transition={{ type: "spring", stiffness: 120, damping: 20 }}
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${
          scrolled ? "py-3 backdrop-blur-2xl bg-[#0A0A14]/80 border-b border-white/5 shadow-xl shadow-black/30" : "py-5"
        }`}
      >
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between">
          <motion.div className="flex items-center gap-3 cursor-pointer" whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}>
            <div className="relative">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-pink-500 flex items-center justify-center shadow-lg shadow-violet-500/30">
                <Gamepad2 size={20} className="text-white" />
              </div>
              <motion.div
                className="absolute inset-0 rounded-xl bg-gradient-to-br from-violet-500 to-pink-500 blur-md"
                animate={{ opacity: [0.4, 0.8, 0.4] }}
                transition={{ duration: 2, repeat: Infinity }}
              />
            </div>
            <span className="text-xl font-black tracking-tight font-[family-name:var(--font-display)]">
              Play<span className="bg-gradient-to-r from-violet-400 to-pink-400 bg-clip-text text-transparent">Buddies</span>
            </span>
          </motion.div>

          <div className="hidden md:flex items-center gap-8">
            {["Games", "Features", "About"].map((item) => (
              <motion.a
                key={item}
                href={`#${item.toLowerCase()}`}
                className="text-sm text-white/60 hover:text-white transition-colors relative group"
                whileHover={{ y: -1 }}
              >
                {item}
                <span className="absolute -bottom-0.5 left-0 w-0 h-px bg-gradient-to-r from-violet-400 to-pink-400 group-hover:w-full transition-all duration-300" />
              </motion.a>
            ))}
          </div>

          <div className="hidden md:flex items-center gap-3">
            {user ? (
              <motion.button onClick={() => router.push("/dashboard")} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                <img src={user.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.uid}`} alt="Avatar" className="w-9 h-9 rounded-full border-2 border-violet-500/50" />
              </motion.button>
            ) : (
              <motion.button
                onClick={handleAuth}
                disabled={logging}
                whileHover={{ scale: 1.05, y: -2 }}
                whileTap={{ scale: 0.95 }}
                className="relative px-6 py-2.5 rounded-xl text-sm font-bold text-white overflow-hidden group"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-violet-600 to-pink-600 group-hover:from-violet-500 group-hover:to-pink-500 transition-all duration-300" />
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300" style={{ background: "linear-gradient(135deg, rgba(255,255,255,0.1), transparent)" }} />
                <span className="relative flex items-center gap-2">
                  {logging ? <Loader2 size={14} className="animate-spin" /> : null}
                  Play Now
                </span>
              </motion.button>
            )}
          </div>

          <button className="md:hidden p-2 text-white/70 hover:text-white" onClick={() => setMobileOpen(!mobileOpen)}>
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </motion.nav>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="fixed inset-0 z-40 backdrop-blur-2xl bg-[#0A0A14]/95 flex flex-col items-center justify-center gap-8"
          >
            {["Games", "Features", "About"].map((item, i) => (
              <motion.a
                key={item}
                href={`#${item.toLowerCase()}`}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.08 }}
                className="text-3xl font-black text-white hover:text-violet-400 transition-colors"
                onClick={() => setMobileOpen(false)}
              >
                {item}
              </motion.a>
            ))}
            <motion.button
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              onClick={() => { setMobileOpen(false); handleAuth(); }}
              className="mt-4 px-10 py-4 bg-gradient-to-r from-violet-600 to-pink-600 rounded-2xl text-white text-xl font-bold"
            >
              {user ? "Dashboard" : "Play Now"}
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

// ─── Scroll Indicator ─────────────────────────────────────────────────────────
function ScrollIndicator() {
  return (
    <motion.div
      className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 2 }}
    >
      <span className="text-xs text-white/40 uppercase tracking-[0.2em] font-semibold">Scroll</span>
      <motion.div
        className="w-px h-12 bg-gradient-to-b from-violet-500 to-transparent"
        animate={{ scaleY: [0, 1, 0], originY: 0 }}
        transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div animate={{ y: [0, 6, 0] }} transition={{ duration: 1.2, repeat: Infinity }}>
        <ChevronDown size={16} className="text-white/40" />
      </motion.div>
    </motion.div>
  );
}

// ─── Hero Section ─────────────────────────────────────────────────────────────
function HeroSection() {
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { user } = useAuthStore();
  const [logging, setLogging] = useState(false);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });

  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], [0, 200]);
  const opacity = useTransform(scrollYProgress, [0, 0.6], [1, 0]);
  const scale = useTransform(scrollYProgress, [0, 0.5], [1, 0.92]);

  useEffect(() => {
    const fn = (e: MouseEvent) => setMouse({ x: (e.clientX / window.innerWidth - 0.5) * 30, y: (e.clientY / window.innerHeight - 0.5) * 30 });
    window.addEventListener("mousemove", fn);
    return () => window.removeEventListener("mousemove", fn);
  }, []);

  const handlePlay = async () => {
    if (user) { router.push("/dashboard"); return; }
    setLogging(true);
    try { await signInWithPopup(auth, googleProvider); router.push("/dashboard"); }
    catch (e) { console.error(e); }
    finally { setLogging(false); }
  };

  return (
    <section ref={ref} className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden">
      {/* Parallax orbs */}
      <motion.div style={{ y }} className="absolute inset-0 pointer-events-none">
        <motion.div
          className="absolute w-[700px] h-[700px] rounded-full"
          style={{ background: "radial-gradient(circle, rgba(139,92,246,0.18) 0%, transparent 70%)", top: "0%", left: "-5%" }}
          animate={{ x: [0, 60, 0], y: [0, -40, 0] }}
          transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute w-[500px] h-[500px] rounded-full"
          style={{ background: "radial-gradient(circle, rgba(236,72,153,0.14) 0%, transparent 70%)", top: "30%", right: "-5%" }}
          animate={{ x: [0, -50, 0], y: [0, 60, 0] }}
          transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute w-[400px] h-[400px] rounded-full"
          style={{ background: "radial-gradient(circle, rgba(59,130,246,0.12) 0%, transparent 70%)", bottom: "10%", left: "40%" }}
          animate={{ x: [0, 40, -30, 0], y: [0, -50, 30, 0] }}
          transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }}
        />
      </motion.div>

      <motion.div style={{ opacity, scale }} className="relative z-10 text-center px-6 max-w-6xl mx-auto pt-24">
        {/* Live badge */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, type: "spring", stiffness: 150 }}
          className="inline-flex items-center gap-2.5 px-5 py-2 rounded-full mb-10 border border-emerald-500/30 bg-emerald-500/5 backdrop-blur-sm"
        >
          <motion.div
            className="w-2 h-2 rounded-full bg-emerald-400"
            animate={{ scale: [1, 1.5, 1], opacity: [1, 0.4, 1] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          />
          <span className="text-xs font-bold text-emerald-400 tracking-[0.18em] uppercase">Platform Live</span>
          <span className="text-xs text-white/30">·</span>
          <span className="text-xs text-white/50 font-medium">Free Forever</span>
        </motion.div>

        {/* Main heading with parallax per word */}
        <h1 className="text-[clamp(3.5rem,10vw,9rem)] font-black leading-[0.88] tracking-tighter font-[family-name:var(--font-display)] mb-8">
          {[
            { text: "Your", delay: 0.4, dx: -80 },
            { text: "Friends", delay: 0.5, dx: 80 },
            { text: "Are", delay: 0.6, dx: -50 },
          ].map(({ text, delay, dx }) => (
            <motion.span
              key={text}
              initial={{ opacity: 0, x: dx }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay, type: "spring", stiffness: 100, damping: 16 }}
              className="block text-white"
            >
              {text}
            </motion.span>
          ))}
          <motion.span
            initial={{ opacity: 0, scale: 0.6, filter: "blur(30px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            transition={{ delay: 0.8, duration: 1.2, type: "spring", bounce: 0.4 }}
            className="block bg-gradient-to-br from-violet-400 via-pink-400 to-blue-400 bg-clip-text text-transparent pb-4"
            style={{ transform: `translate(${mouse.x * 0.5}px, ${mouse.y * 0.5}px)`, display: "inline-block" }}
          >
            Waiting.
          </motion.span>
        </h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1 }}
          className="text-lg md:text-xl text-white/50 max-w-xl mx-auto mb-12 leading-relaxed"
        >
          The ultimate web arcade — instantly play co-op games with your crew.{" "}
          <span className="text-white/30 text-base">No downloads. Zero installs. Pure fun.</span>
        </motion.p>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.1 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-20"
        >
          <motion.button
            onClick={handlePlay}
            disabled={logging}
            whileHover={{ scale: 1.06, y: -4 }}
            whileTap={{ scale: 0.96 }}
            className="relative group px-10 py-5 rounded-2xl text-white font-black text-lg overflow-hidden shadow-2xl shadow-violet-500/25"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-violet-600 via-purple-600 to-pink-600 group-hover:from-violet-500 group-hover:via-purple-500 group-hover:to-pink-500 transition-all duration-300" />
            <motion.div
              className="absolute inset-0 opacity-0 group-hover:opacity-100"
              style={{ background: "linear-gradient(135deg, rgba(255,255,255,0.15), transparent 50%)" }}
              transition={{ duration: 0.3 }}
            />
            <span className="relative flex items-center gap-3">
              {logging ? <Loader2 size={22} className="animate-spin" /> : <Gamepad2 size={22} />}
              {user ? "Enter Dashboard" : "Login & Play Free"}
              <motion.span animate={{ x: [0, 5, 0] }} transition={{ duration: 1.4, repeat: Infinity }}>
                <ArrowRight size={20} />
              </motion.span>
            </span>
          </motion.button>

          <motion.button
            onClick={() => document.getElementById("games")?.scrollIntoView({ behavior: "smooth" })}
            whileHover={{ scale: 1.04, y: -2 }}
            whileTap={{ scale: 0.96 }}
            className="px-8 py-5 rounded-2xl text-white/70 hover:text-white font-bold text-base border border-white/10 hover:border-white/25 backdrop-blur-sm transition-all duration-300 flex items-center gap-2"
          >
            <Play size={16} className="text-violet-400" />
            Browse Games
          </motion.button>
        </motion.div>

        {/* Stats */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.3 }}
          className="flex flex-wrap items-center justify-center gap-10 pt-8 border-t border-white/[0.06]"
        >
          {[
            { icon: Zap, label: "Instant Matchmaking", value: "<1s" },
            { icon: Star, label: "Always Free", value: "$0" },
            { icon: Globe, label: "Browser Native", value: "Any Device" },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex items-center gap-3 group">
              <div className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center group-hover:border-violet-500/40 group-hover:bg-violet-500/10 transition-all duration-300">
                <Icon size={18} className="text-white/50 group-hover:text-violet-400 transition-colors duration-300" />
              </div>
              <div className="text-left">
                <div className="text-xl font-black text-white">{value}</div>
                <div className="text-xs text-white/40 font-semibold tracking-wider uppercase">{label}</div>
              </div>
            </div>
          ))}
        </motion.div>
      </motion.div>

      <ScrollIndicator />
    </section>
  );
}

// ─── Marquee Ticker ───────────────────────────────────────────────────────────
function MarqueeTicker() {
  const baseX = useMotionValue(0);
  const velocity = useVelocity(baseX);
  const smoothVelocity = useSpring(velocity, { damping: 50, stiffness: 400 });
  const velocityFactor = useTransform(smoothVelocity, [0, 1000], [0, 5]);
  const x = useTransform(baseX, (v) => `${wrap(-50, 0, v)}%`);
  const directionFactor = useRef(1);

  useAnimationFrame((_, delta) => {
    const moveBy = directionFactor.current * -0.025 * delta;
    baseX.set(baseX.get() + moveBy);
  });

  const items = ["🎮 Co-op Mode", "⚡ Zero Lag", "🌍 Play Anywhere", "🏆 Leaderboards", "💬 In-Game Chat", "🔒 Anti-Cheat", "🎯 Instant Lobbies", "✨ Free Forever"];
  const doubled = [...items, ...items, ...items, ...items];

  return (
    <div className="relative overflow-hidden py-6 border-y border-white/[0.05] bg-white/[0.01]">
      <div className="absolute left-0 top-0 bottom-0 w-32 bg-gradient-to-r from-[#0A0A14] to-transparent z-10" />
      <div className="absolute right-0 top-0 bottom-0 w-32 bg-gradient-to-l from-[#0A0A14] to-transparent z-10" />
      <motion.div style={{ x }} className="flex whitespace-nowrap">
        {doubled.map((item, i) => (
          <span key={i} className="mx-6 text-sm font-bold text-white/30 tracking-widest uppercase flex items-center gap-2 shrink-0">
            {item}
            <span className="w-1.5 h-1.5 rounded-full bg-violet-500/50 ml-6" />
          </span>
        ))}
      </motion.div>
    </div>
  );
}

// ─── Games Section ────────────────────────────────────────────────────────────
function GameCard({ game, index }: { game: (typeof GAMES)[0]; index: number }) {
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width - 0.5;
    const cy = (e.clientY - rect.top) / rect.height - 0.5;
    setTilt({ x: cy * 10, y: cx * -10 });
  };

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 60 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ delay: index * 0.12, type: "spring", stiffness: 80, damping: 16 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setTilt({ x: 0, y: 0 }); }}
      onMouseMove={handleMouseMove}
      style={{ rotateX: tilt.x, rotateY: tilt.y, transformStyle: "preserve-3d", perspective: 1000 }}
      className={`relative group rounded-3xl overflow-hidden cursor-pointer ${game.featured ? "md:col-span-2 md:row-span-2" : ""}`}
    >
      {/* Gradient border glow */}
      <motion.div
        className="absolute inset-0 rounded-3xl z-0"
        animate={{ opacity: hovered ? 1 : 0 }}
        transition={{ duration: 0.3 }}
        style={{ background: `linear-gradient(135deg, ${game.borderColor}, transparent 60%)`, padding: 1 }}
      />

      <div
        className={`relative h-full flex flex-col rounded-3xl border border-white/[0.06] ${hovered ? "border-violet-500/30" : ""} transition-colors duration-500 overflow-hidden`}
        style={{ background: game.bgColor, minHeight: game.featured ? "380px" : "240px" }}
      >
        {/* Shimmer sweep */}
        <motion.div
          className="absolute inset-0 pointer-events-none z-10"
          animate={{ x: hovered ? ["−100%", "200%"] : "−100%" }}
          transition={{ duration: 0.8, ease: "easeInOut" }}
          style={{ background: "linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.06) 50%, transparent 60%)" }}
        />

        <div className={`relative z-10 h-full p-7 flex flex-col ${game.featured ? "md:flex-row md:items-center md:gap-10" : "justify-between"}`}>
          {/* Icon */}
          <motion.div
            className={`overflow-hidden rounded-2xl shrink-0 ${game.featured ? "w-44 h-44 md:w-60 md:h-60 mb-8 md:mb-0" : "w-20 h-20 mb-4"}`}
            animate={{ scale: hovered ? 1.08 : 1, y: hovered ? -6 : 0 }}
            transition={{ type: "spring", stiffness: 200, damping: 16 }}
          >
            {game.icon}
          </motion.div>

          {/* Text */}
          <div className="flex-1 flex flex-col justify-end">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xs font-bold uppercase tracking-widest text-white/40 bg-white/5 px-3 py-1 rounded-full">
                {game.featured ? `🔥 Featured · ${game.category}` : game.category}
              </span>
              <span className="text-xs font-mono text-white/30">{game.players}P</span>
            </div>
            <h3 className={`font-black text-white mb-1 leading-tight ${game.featured ? "text-4xl md:text-5xl" : "text-2xl"}`}>{game.name}</h3>
            <p className="text-xs text-white/40 uppercase tracking-widest font-semibold mb-3">{game.subtitle}</p>
            {game.featured && <p className="text-sm text-white/60 max-w-lg leading-relaxed">{game.description}</p>}
          </div>
        </div>

        {/* Hover play button */}
        <motion.div
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: hovered ? 1 : 0, scale: hovered ? 1 : 0.5 }}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none"
        >
          <div className={`w-16 h-16 rounded-full bg-gradient-to-br ${game.color} flex items-center justify-center shadow-2xl border-2 border-white/20`}>
            <Play size={24} className="text-white fill-white ml-1" />
          </div>
        </motion.div>

        {/* Animated scan line on hover */}
        <motion.div
          className="absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-violet-400/50 to-transparent z-10 pointer-events-none"
          animate={{ top: hovered ? ["0%", "100%"] : "0%" }}
          transition={{ duration: 1.5, repeat: hovered ? Infinity : 0, ease: "linear" }}
        />
      </div>
    </motion.div>
  );
}

function GamesSection() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });

  return (
    <section id="games" className="relative py-36 px-6">
      <div className="max-w-7xl mx-auto">
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 40 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.7, ease: "easeOut" }}
          className="text-center mb-20"
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/10 bg-white/[0.03] mb-6">
            <Gamepad2 size={13} className="text-violet-400" />
            <span className="text-xs font-bold text-white/50 tracking-[0.18em] uppercase">Game Arcade</span>
          </div>
          <h2 className="text-5xl md:text-7xl font-black font-[family-name:var(--font-display)] tracking-tighter mb-4">
            <span className="text-white">Choose Your</span>
            <br />
            <span className="bg-gradient-to-r from-violet-400 to-pink-400 bg-clip-text text-transparent">Battleground</span>
          </h2>
          <p className="text-white/40 max-w-lg mx-auto text-base">Curated multiplayer games built for maximum fun with your crew.</p>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 auto-rows-auto">
          {GAMES.map((game, i) => <GameCard key={game.id} game={game} index={i} />)}
        </div>
      </div>
    </section>
  );
}

// ─── Features Section ─────────────────────────────────────────────────────────
const features = [
  { icon: Zap, title: "Zero Lag Multiplayer", desc: "WebRTC peer-to-peer with server fallback. <100ms latency guaranteed.", gradient: "from-yellow-500 to-orange-500", glow: "rgba(234,179,8,0.2)" },
  { icon: Users, title: "Universal Lobbies", desc: "One lobby, any game. Switch games without disconnecting your friends.", gradient: "from-blue-500 to-cyan-500", glow: "rgba(59,130,246,0.2)" },
  { icon: Shield, title: "Anti-Cheat", desc: "Server-authoritative state. The server is the single truth — no funny business.", gradient: "from-emerald-500 to-green-500", glow: "rgba(16,185,129,0.2)" },
  { icon: Globe, title: "Play Anywhere", desc: "Any device with a browser — desktop, tablet, phone. Just share a link.", gradient: "from-violet-500 to-purple-500", glow: "rgba(139,92,246,0.2)" },
  { icon: MessageSquare, title: "In-Game Chat", desc: "Text and emoji chat built into every lobby. Strategize or trash talk.", gradient: "from-pink-500 to-rose-500", glow: "rgba(236,72,153,0.2)" },
  { icon: Trophy, title: "Leaderboards", desc: "Track wins, K/D, and high scores. Compete on global & friend boards.", gradient: "from-amber-500 to-yellow-500", glow: "rgba(245,158,11,0.2)" },
];

function FeaturesSection() {
  return (
    <section id="features" className="relative py-36 px-6">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: "radial-gradient(ellipse 80% 50% at 50% 50%, rgba(139,92,246,0.06), transparent)" }}
      />
      <div className="max-w-7xl mx-auto relative">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7 }}
          className="text-center mb-20"
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/10 bg-white/[0.03] mb-6">
            <Sparkles size={13} className="text-pink-400" />
            <span className="text-xs font-bold text-white/50 tracking-[0.18em] uppercase">Why PlayBuddies</span>
          </div>
          <h2 className="text-5xl md:text-7xl font-black font-[family-name:var(--font-display)] tracking-tighter mb-4">
            <span className="text-white">Built for</span>
            <br />
            <span className="bg-gradient-to-r from-pink-400 to-violet-400 bg-clip-text text-transparent">Real Gamers</span>
          </h2>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 50 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ delay: i * 0.09, type: "spring", stiffness: 80 }}
              whileHover={{ y: -8, transition: { type: "spring", stiffness: 300 } }}
              className="group relative p-8 rounded-3xl border border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] transition-all duration-500 overflow-hidden cursor-default"
            >
              {/* Glow bg */}
              <motion.div
                className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
                style={{ background: `radial-gradient(circle at 30% 30%, ${f.glow}, transparent 60%)` }}
              />
              {/* Shimmer border */}
              <motion.div
                className="absolute inset-0 rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
                style={{ background: `linear-gradient(135deg, ${f.glow.replace("0.2", "0.4")}, transparent)`, padding: 1 }}
              />

              <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${f.gradient} flex items-center justify-center mb-6 shadow-lg`} style={{ boxShadow: `0 8px 24px ${f.glow}` }}>
                <f.icon size={22} className="text-white" />
              </div>
              <h3 className="text-lg font-black text-white mb-3 group-hover:text-transparent group-hover:bg-gradient-to-r group-hover:bg-clip-text group-hover:from-white group-hover:to-white/60 transition-all duration-500">
                {f.title}
              </h3>
              <p className="text-sm text-white/45 leading-relaxed group-hover:text-white/65 transition-colors duration-500">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── How It Works ─────────────────────────────────────────────────────────────
function HowItWorks() {
  const steps = [
    { step: "01", title: "Login with Google", desc: "One click. No new accounts, no passwords.", emoji: "🔑", color: "from-violet-500 to-purple-600" },
    { step: "02", title: "Pick a Game", desc: "Browse our arcade of 10+ multiplayer games.", emoji: "🎮", color: "from-blue-500 to-cyan-600" },
    { step: "03", title: "Invite Friends", desc: "Share a link. They click, they're in. Instant.", emoji: "📨", color: "from-pink-500 to-rose-600" },
    { step: "04", title: "Play!", desc: "Real-time multiplayer, zero lag, maximum fun.", emoji: "🏆", color: "from-amber-500 to-orange-600" },
  ];

  return (
    <section id="about" className="relative py-36 px-6 overflow-hidden">
      <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse 60% 40% at 80% 60%, rgba(59,130,246,0.07), transparent)" }} />
      <div className="max-w-6xl mx-auto relative">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7 }}
          className="text-center mb-24"
        >
          <h2 className="text-5xl md:text-7xl font-black font-[family-name:var(--font-display)] tracking-tighter mb-4">
            <span className="text-white">How It </span>
            <span className="bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-transparent">Works</span>
          </h2>
          <p className="text-white/40 text-base">Zero to gaming with friends in under 30 seconds.</p>
        </motion.div>

        <div className="relative">
          {/* Connecting line */}
          <div className="hidden lg:block absolute top-[52px] left-0 right-0 h-px z-0">
            <motion.div
              initial={{ scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 1.2, ease: "easeInOut" }}
              className="h-full bg-gradient-to-r from-violet-500/30 via-pink-500/30 to-amber-500/30 origin-left"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 relative z-10">
            {steps.map((step, i) => (
              <motion.div
                key={step.step}
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.15, type: "spring", stiffness: 80 }}
                className="text-center group"
              >
                <motion.div
                  whileHover={{ scale: 1.1, y: -8 }}
                  transition={{ type: "spring", stiffness: 300 }}
                  className="relative mx-auto w-24 h-24 rounded-3xl border border-white/[0.07] bg-white/[0.02] flex items-center justify-center mb-6 group-hover:border-white/20 transition-all duration-300"
                >
                  <span className="text-4xl">{step.emoji}</span>
                  <div className={`absolute -top-3 -right-3 w-8 h-8 rounded-full bg-gradient-to-br ${step.color} flex items-center justify-center text-[11px] font-black text-white shadow-lg`}>
                    {step.step}
                  </div>
                </motion.div>
                <h3 className="text-base font-black text-white mb-2 group-hover:text-violet-300 transition-colors duration-300">{step.title}</h3>
                <p className="text-sm text-white/40 leading-relaxed">{step.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── CTA Section ──────────────────────────────────────────────────────────────
function CTASection() {
  const router = useRouter();
  const { user } = useAuthStore();
  const [logging, setLogging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const bgScale = useTransform(scrollYProgress, [0, 1], [0.85, 1.1]);

  const handlePlay = async () => {
    if (user) { router.push("/dashboard"); return; }
    setLogging(true);
    try { await signInWithPopup(auth, googleProvider); router.push("/dashboard"); }
    catch (e) { console.error(e); }
    finally { setLogging(false); }
  };

  return (
    <section ref={ref} className="relative py-36 px-6 overflow-hidden">
      <motion.div style={{ scale: bgScale }} className="absolute inset-[-20%] pointer-events-none">
        <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse 60% 60% at 50% 50%, rgba(139,92,246,0.18), transparent)" }} />
      </motion.div>

      <div className="max-w-4xl mx-auto relative">
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 40 }}
          whileInView={{ opacity: 1, scale: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ type: "spring", stiffness: 80, damping: 16 }}
          className="relative p-16 md:p-24 rounded-[2.5rem] text-center overflow-hidden border border-white/[0.07]"
          style={{ background: "linear-gradient(135deg, rgba(139,92,246,0.08), rgba(236,72,153,0.05), rgba(10,10,20,0.8))" }}
        >
          {/* Animated border glow */}
          <motion.div
            className="absolute inset-0 rounded-[2.5rem] pointer-events-none"
            animate={{ opacity: [0.3, 0.7, 0.3] }}
            transition={{ duration: 4, repeat: Infinity }}
            style={{ background: "linear-gradient(135deg, rgba(139,92,246,0.2), transparent 40%, rgba(236,72,153,0.15) 100%)", padding: 1 }}
          />

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.2 }}
          >
            <h2 className="text-5xl md:text-7xl font-black font-[family-name:var(--font-display)] tracking-tighter mb-6">
              Ready to{" "}
              <span className="bg-gradient-to-r from-violet-400 via-pink-400 to-blue-400 bg-clip-text text-transparent">Play?</span>
            </h2>
            <p className="text-lg text-white/50 mb-12 max-w-lg mx-auto">
              Create a room, send a link, and start playing with friends instantly.
            </p>
            <motion.button
              onClick={handlePlay}
              disabled={logging}
              whileHover={{ scale: 1.06, y: -4 }}
              whileTap={{ scale: 0.96 }}
              className="relative group px-12 py-5 rounded-2xl text-white font-black text-lg overflow-hidden shadow-2xl shadow-violet-500/30 inline-flex items-center gap-3 mx-auto"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-violet-600 via-purple-600 to-pink-600 group-hover:from-violet-500 group-hover:to-pink-500 transition-all duration-300" />
              <span className="relative flex items-center gap-3">
                {logging ? <Loader2 size={22} className="animate-spin" /> : <Gamepad2 size={22} />}
                {user ? "Go to Dashboard" : "Login with Google & Play"}
              </span>
            </motion.button>

            <div className="flex items-center justify-center gap-6 mt-8">
              {[{ icon: Lock, text: "Secure Login" }, { icon: Star, text: "Free Forever" }, { icon: Wifi, text: "No Downloads" }].map(({ icon: Icon, text }) => (
                <div key={text} className="flex items-center gap-1.5 text-xs text-white/30 font-semibold">
                  <Icon size={12} className="text-white/20" />
                  {text}
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer className="relative border-t border-white/[0.05] py-12 px-6">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-600 to-pink-600 flex items-center justify-center">
            <Gamepad2 size={15} className="text-white" />
          </div>
          <span className="text-base font-black font-[family-name:var(--font-display)]">
            Play<span className="bg-gradient-to-r from-violet-400 to-pink-400 bg-clip-text text-transparent">Buddies</span>
          </span>
        </div>
        <div className="flex items-center gap-8">
          {["Privacy", "Terms", "Contact"].map((link) => (
            <a key={link} href="#" className="text-sm text-white/30 hover:text-white/70 transition-colors">{link}</a>
          ))}
        </div>
        <div className="text-sm text-white/25">© 2026 PlayBuddies by Bilal Saeed</div>
      </div>
    </footer>
  );
}

// ─── Page-level Loading Screen ────────────────────────────────────────────────
function LoadingScreen() {
  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.05 }}
      transition={{ duration: 0.7, ease: [0.76, 0, 0.24, 1] }}
      className="fixed inset-0 z-[100] bg-[#060608] flex flex-col items-center justify-center gap-8"
    >
      <motion.div
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 200, damping: 18 }}
        className="relative"
      >
        <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-violet-600 to-pink-600 flex items-center justify-center shadow-2xl shadow-violet-500/40">
          <Gamepad2 size={38} className="text-white" />
        </div>
        <motion.div
          className="absolute inset-0 rounded-2xl bg-gradient-to-br from-violet-600 to-pink-600 blur-xl"
          animate={{ opacity: [0.4, 0.9, 0.4] }}
          transition={{ duration: 1.5, repeat: Infinity }}
        />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="w-48 h-1 bg-white/5 rounded-full overflow-hidden"
      >
        <motion.div
          initial={{ x: "-100%" }}
          animate={{ x: "0%" }}
          transition={{ duration: 0.9, ease: [0.76, 0, 0.24, 1] }}
          className="h-full bg-gradient-to-r from-violet-500 to-pink-500 rounded-full"
        />
      </motion.div>
    </motion.div>
  );
}

// ─── Home Page ────────────────────────────────────────────────────────────────
export default function Home() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { const t = setTimeout(() => setLoaded(true), 900); return () => clearTimeout(t); }, []);

  return (
    <main className="relative overflow-hidden" style={{ background: "#0A0A14" }}>
      <AnimatePresence>{!loaded && <LoadingScreen />}</AnimatePresence>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: loaded ? 1 : 0 }}
        transition={{ duration: 0.6 }}
      >
        <AnimatedGrid />
        <FloatingParticles />
        <CursorSpotlight />
        <Navbar />
        <HeroSection />
        <MarqueeTicker />
        <GamesSection />
        <FeaturesSection />
        <HowItWorks />
        <CTASection />
        <Footer />
      </motion.div>
    </main>
  );
}
