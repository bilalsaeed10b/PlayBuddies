
"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence, useScroll, useTransform } from "framer-motion";
import { useRouter } from "next/navigation";
import { signInWithPopup } from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import {
  Gamepad2,
  Users,
  Zap,
  Globe,
  ChevronRight,
  Star,
  ArrowRight,
  Sparkles,
  Shield,
  Trophy,
  MessageSquare,
  Play,
  Monitor,
  Smartphone,
  Menu,
  X,
  Loader2,
} from "lucide-react";

import { GAMES } from "@/lib/games";


function FloatingParticles() {
  const [particles, setParticles] = useState<
    {
      id: number;
      x: number;
      y: number;
      size: number;
      duration: number;
      delay: number;
      color: string;
    }[]
  >([]);

  useEffect(() => {
    const colors = [
      "rgba(139, 92, 246, 0.3)",
      "rgba(236, 72, 153, 0.2)",
      "rgba(59, 130, 246, 0.2)",
      "rgba(16, 185, 129, 0.15)",
    ];
    const p = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: Math.random() * 4 + 2,
      duration: Math.random() * 15 + 10,
      delay: Math.random() * 10,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    setParticles(p);
  }, []);

  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
      {particles.map((p) => (
        <motion.div
          key={p.id}
          className="absolute rounded-full"
          style={{
            width: p.size,
            height: p.size,
            left: `${p.x}%`,
            top: `${p.y}%`,
            background: p.color,
          }}
          animate={{
            y: [0, -200, -400, -200, 0],
            x: [0, 30, -20, 40, 0],
            opacity: [0, 0.6, 1, 0.6, 0],
            scale: [0.5, 1, 1.2, 1, 0.5],
          }}
          transition={{
            duration: p.duration,
            repeat: Infinity,
            delay: p.delay,
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  );
}


function AnimatedOrbs() {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
      <motion.div
        className="absolute w-[600px] h-[600px] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(139, 92, 246, 0.12) 0%, transparent 70%)",
          top: "10%",
          left: "5%",
        }}
        animate={{
          x: [0, 100, -50, 80, 0],
          y: [0, -60, 40, -80, 0],
          scale: [1, 1.2, 0.9, 1.1, 1],
        }}
        transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute w-[500px] h-[500px] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(236, 72, 153, 0.1) 0%, transparent 70%)",
          top: "50%",
          right: "10%",
        }}
        animate={{
          x: [0, -80, 50, -40, 0],
          y: [0, 80, -60, 30, 0],
          scale: [1, 0.9, 1.2, 1.1, 1],
        }}
        transition={{ duration: 25, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute w-[400px] h-[400px] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(59, 130, 246, 0.08) 0%, transparent 70%)",
          bottom: "10%",
          left: "40%",
        }}
        animate={{
          x: [0, 60, -80, 40, 0],
          y: [0, -40, 60, -20, 0],
          scale: [1, 1.1, 0.95, 1.15, 1],
        }}
        transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
      />
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
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${scrolled
          ? "glass-strong shadow-2xl shadow-black/20"
          : "bg-transparent"
          }`}
      >
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          {/* Logo */}
          <motion.div
            className="flex items-center gap-3 cursor-pointer"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <div className="relative">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                <Gamepad2 size={22} className="text-white" />
              </div>
              <motion.div
                className="absolute inset-0 rounded-xl bg-gradient-to-br from-primary to-accent"
                animate={{ scale: [1, 1.3, 1], opacity: [0.5, 0, 0.5] }}
                transition={{ duration: 2, repeat: Infinity }}
              />
            </div>
            <span className="text-xl font-extrabold font-[family-name:var(--font-display)] tracking-tight">
              Play
              <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
                Buddies
              </span>
            </span>
          </motion.div>

          {/* Desktop Nav Links */}
          <div className="hidden md:flex items-center gap-8">
            {["Games", "Features", "About"].map((item) => (
              <motion.a
                key={item}
                href={`#${item.toLowerCase()}`}
                className="text-sm text-text-secondary hover:text-white transition-colors relative group"
                whileHover={{ y: -2 }}
              >
                {item}
                <span className="absolute -bottom-1 left-0 w-0 h-0.5 bg-gradient-to-r from-primary to-accent group-hover:w-full transition-all duration-300" />
              </motion.a>
            ))}
          </div>

          {/* CTA */}
          <div className="hidden md:flex items-center gap-4">
            {user ? (
              <button
                onClick={() => router.push("/dashboard")}
                className="flex items-center gap-2 hover:opacity-80 transition-opacity"
              >
                <img
                  src={user.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.uid}`}
                  alt="Avatar"
                  className="w-10 h-10 rounded-full border-2 border-primary/50"
                />
              </button>
            ) : (
              <motion.button
                onClick={handleAuth}
                disabled={isLoggingIn}
                whileHover={{ scale: 1.05, y: -2 }}
                whileTap={{ scale: 0.95 }}
                className="btn-glow flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-primary to-accent rounded-xl text-sm font-bold text-white shadow-lg shadow-primary/20 disabled:opacity-75"
              >
                {isLoggingIn ? <Loader2 size={16} className="animate-spin" /> : null}
                Play Now
              </motion.button>
            )}
          </div>

          {/* Mobile Menu Toggle */}
          <button
            className="md:hidden p-2"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </motion.nav>

      {/* Mobile Menu Overlay */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed inset-0 z-40 glass-strong pt-24 px-6"
          >
            <div className="flex flex-col gap-6">
              {["Games", "Features", "About"].map((item, i) => (
                <motion.a
                  key={item}
                  href={`#${item.toLowerCase()}`}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.1 }}
                  className="text-2xl font-bold text-white"
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
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 }}
                className="btn-glow flex items-center justify-center gap-2 w-full mt-4 px-8 py-4 bg-gradient-to-r from-primary to-accent rounded-xl text-lg font-bold text-white"
              >
                {isLoggingIn ? <Loader2 size={24} className="animate-spin" /> : user ? "Go to Dashboard" : "Play Now"}
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}


function HeroSection() {
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { user } = useAuthStore();
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouse = (e: MouseEvent) => {
      setMousePos({
        x: (e.clientX / window.innerWidth - 0.5) * 20,
        y: (e.clientY / window.innerHeight - 0.5) * 20,
      });
    };
    window.addEventListener("mousemove", handleMouse);
    return () => window.removeEventListener("mousemove", handleMouse);
  }, []);

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
    <section
      ref={containerRef}
      className="relative min-h-[90vh] flex flex-col items-center justify-center overflow-hidden py-16"
    >

      {/* Animated Grid Background */}
      <div className="absolute inset-0 bg-grid animate-grid-pulse" />

      {/* Radial Gradient Overlays */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 0%, rgba(139, 92, 246, 0.15) 0%, transparent 50%)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 80% 80%, rgba(236, 72, 153, 0.1) 0%, transparent 50%)",
        }}
      />


      <motion.div
        className="relative z-10 max-w-6xl mx-auto px-6 text-center pt-10"
      >

        {/* Status Badge */}
        <motion.div
          initial={{ opacity: 0, y: 30, rotateX: 90 }}
          animate={{ opacity: 1, y: 0, rotateX: 0 }}
          transition={{ delay: 0.2, type: "spring", stiffness: 150, damping: 12 }}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full glass mb-8 border border-success/30 shadow-[0_0_20px_rgba(16,185,129,0.15)] relative overflow-hidden group tracking-wider"
        >
          <div className="absolute inset-0 bg-success/10 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000" />
          <motion.div
            className="w-2.5 h-2.5 rounded-full bg-success shadow-[0_0_10px_#10B981]"
            animate={{ scale: [1, 1.3, 1], opacity: [1, 0.5, 1] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          />
          <span className="text-xs font-bold text-success tracking-[0.2em] uppercase">
            Platform • Live Now
          </span>
        </motion.div>


        {/* Main Heading */}
        <motion.h1
          className="text-6xl sm:text-7xl md:text-8xl lg:text-[7rem] font-black font-[family-name:var(--font-display)] tracking-tighter leading-[0.85] mb-8"
        >
          <motion.span
            initial={{ opacity: 0, x: -100, rotateY: -45 }}
            animate={{ opacity: 1, x: 0, rotateY: 0 }}
            transition={{ delay: 0.4, duration: 1, type: "spring", bounce: 0.4 }}
            className="block text-white"
          >
            Your Friends
          </motion.span>
          <motion.span
            initial={{ opacity: 0, x: 100, rotateY: 45 }}
            animate={{ opacity: 1, x: 0, rotateY: 0 }}
            transition={{ delay: 0.5, duration: 1, type: "spring", bounce: 0.4 }}
            className="block text-white"
          >
            Are
          </motion.span>
          <motion.span
            initial={{ opacity: 0, scale: 0.5, filter: "blur(20px)", y: 50 }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)", y: 0 }}
            transition={{ delay: 0.7, duration: 1.2, type: "spring", bounce: 0.5 }}
            className="block bg-gradient-to-br from-primary via-accent to-secondary bg-clip-text text-transparent animate-gradient-shift pb-6 drop-shadow-2xl glitch-effect"
            data-text="Waiting."
            style={{
              transform: `translate(${mousePos.x * 0.8}px, ${mousePos.y * 0.8}px) scale(1.05)`,
              display: "inline-block",
            }}
          >
            Waiting.
          </motion.span>
        </motion.h1>


        {/* Subheading */}
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          className="text-lg md:text-2xl text-text-secondary max-w-2xl mx-auto mb-12 leading-relaxed font-medium"
        >
          The ultimate web arcade. Create a lobby, invite your crew, and play immediately.
          <br className="hidden sm:block mt-2" />
          <span className="text-text-muted text-base">
            No downloads. No installs. Just fun.
          </span>
        </motion.p>

        {/* CTA Button */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8 }}
          className="flex justify-center mb-16"
        >
          <motion.button
            onClick={handlePlay}
            disabled={isLoggingIn}
            whileHover={{ scale: 1.05, y: -3 }}
            whileTap={{ scale: 0.95 }}
            className="btn-glow group w-full sm:w-auto px-12 py-6 bg-transparent rounded-3xl text-white font-black text-xl flex items-center justify-center gap-4 shadow-[0_0_50px_rgba(139,92,246,0.2)] hover:shadow-[0_0_80px_rgba(236,72,153,0.4)] transition-shadow duration-500 disabled:opacity-75 relative z-10 uppercase tracking-wide border border-white/10 overflow-visible"
          >
            {/* The crazy background layer that animates independently */}
            <div className="absolute inset-0 bg-gradient-to-r from-primary via-accent to-secondary rounded-3xl z-[-1] opacity-80 group-hover:opacity-100 transition-opacity animate-gradient-shift blur-[2px] group-hover:blur-[8px]" />
            <div className="absolute inset-[2px] bg-background rounded-[22px] z-[-1] border border-white/5" />
            
            {isLoggingIn ? (
              <Loader2 size={26} className="animate-spin text-accent" />
            ) : (
              <motion.div
                animate={{ rotate: [0, -10, 10, -10, 0] }}
                transition={{ duration: 2, repeat: Infinity, repeatDelay: 3 }}
              >
                <Gamepad2 size={28} className="fill-primary/20 text-primary group-hover:text-accent transition-colors duration-500" />
              </motion.div>
            )}
            
            <span className="relative z-10 group-hover:text-neon transition-colors duration-300">
              {user ? "Enter Dashboard" : "Login & Play Now"}
            </span>

            {!isLoggingIn && (
              <motion.div
                animate={{ x: [0, 8, 0] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                className="relative z-10 bg-white/10 p-2 rounded-full backdrop-blur-sm"
              >
                <ArrowRight size={20} className="text-white" />
              </motion.div>
            )}
          </motion.button>
        </motion.div>

        {/* Stats Bar */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1 }}
          className="flex flex-wrap items-center justify-center gap-8 md:gap-16 pt-8 border-t border-white/10"
        >
          {[
            { label: "Co-op Mode", value: "Ready", icon: Gamepad2 },
            { label: "Matchmaking", value: "Instant", icon: Zap },
            { label: "Cost", value: "$0 Always", icon: Star },
          ].map((stat, i) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1.2 + i * 0.1 }}
              className="flex items-center gap-4 group"
            >
              <div className="p-3 rounded-xl bg-white/5 group-hover:bg-primary/20 transition-colors">
                <stat.icon
                  size={24}
                  className="text-text-muted group-hover:text-primary transition-colors"
                />
              </div>
              <div className="text-left">
                <div className="text-2xl font-black text-white">{stat.value}</div>
                <div className="text-sm font-semibold tracking-wider uppercase text-text-muted">{stat.label}</div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </motion.div>
    </section>
  );
}


function GameCard({
  game,
  index,
}: {
  game: (typeof GAMES)[0];
  index: number;
}) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ delay: index * 0.1, type: "spring", stiffness: 100 }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`game-card relative group rounded-2xl overflow-hidden cursor-pointer ${game.featured ? "md:col-span-2 md:row-span-2" : ""
        }`}
      style={{ background: game.bgColor }}
    >
      {/* Gradient border on hover */}
      <motion.div
        className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{
          background: `linear-gradient(135deg, ${game.borderColor}, transparent, ${game.borderColor})`,
          padding: "1px",
        }}
      />

      <div
        className={`relative h-full p-6 md:p-10 flex flex-col ${game.featured ? "md:flex-row md:items-center md:gap-12" : "justify-between"} rounded-2xl border border-white/5 group-hover:border-transparent transition-colors`}
        style={{ minHeight: game.featured ? "360px" : "220px" }}
      >
        {/* Game Icon / Logo (Always Left for featured) */}
        <motion.div
          className={`flex items-center justify-center ${
            game.featured 
              ? "w-40 h-40 md:w-56 md:h-56 mb-10 md:mb-0" 
              : "w-20 h-20 my-4"
          } mx-auto md:mx-0 shrink-0 overflow-hidden rounded-[2.5rem]`}
          animate={{ 
            scale: isHovered ? (game.featured ? 1.05 : 1.1) : 1, 
            y: isHovered ? -10 : 0,
            rotate: isHovered && game.featured ? [0, -2, 2, 0] : 0 
          }}
          transition={{ 
            scale: { type: "spring", stiffness: 200 },
            rotate: { duration: 0.5, repeat: Infinity }
          }}
        >
          {game.icon}
        </motion.div>

        {/* Content Container (Right for featured, Bottom for normal) */}
        <div className={`flex flex-col flex-1 h-full ${game.featured ? "text-center md:text-left" : "justify-between"}`}>
          {/* Top Metadata Row (Integrated for featured) */}
          <div className={`flex items-start justify-between ${game.featured ? "mb-8" : "mb-2"}`}>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-bold uppercase tracking-wider ${game.featured ? "text-primary bg-primary/10 border border-primary/20" : "text-text-muted bg-white/5"} px-3 py-1 rounded-full`}>
                {game.featured ? `🔥 Featured: ${game.category}` : game.category}
              </span>
              <span className="text-xs font-mono text-text-muted">
                {game.players}P
              </span>
            </div>
            
            {/* Arrow shown only for normal cards here, featured gets it in the bottom text card */}
            {!game.featured && (
              <motion.div
                animate={{ rotate: isHovered ? 45 : 0 }}
                transition={{ type: "spring", stiffness: 200 }}
              >
                <ArrowRight size={18} className="text-text-muted group-hover:text-white transition-colors" />
              </motion.div>
            )}
          </div>

          {!game.featured && <div className="flex-1" />}

          {/* Text Info Container */}
          <div className={`z-10 bg-background/40 backdrop-blur-md p-6 rounded-xl border border-white/5 opacity-100 group-hover:bg-background/60 group-hover:border-primary/20 transition-all duration-500 relative ${game.featured ? "-mx-2 md:mx-0 shadow-2xl" : "-mx-2 -mb-2 mt-auto"}`}>
            <div className="flex justify-between items-start mb-2">
              <h3 className={`${game.featured ? "text-3xl md:text-5xl" : "text-lg md:text-xl"} font-black text-white group-hover:text-transparent group-hover:bg-gradient-to-r group-hover:bg-clip-text group-hover:from-white group-hover:to-primary transition-all duration-500`}>
                {game.name}
              </h3>
              {game.featured && (
                <motion.div
                  animate={{ x: isHovered ? 5 : 0 }}
                  className="mt-2"
                >
                  <ArrowRight size={32} className="text-primary" />
                </motion.div>
              )}
            </div>
            
            <p className="text-xs text-text-muted uppercase tracking-wider font-semibold mb-3 group-hover:text-text-secondary transition-colors duration-500">
              {game.subtitle}
            </p>
            
            {game.featured && (
              <p className="text-sm md:text-base text-text-secondary leading-relaxed max-w-xl group-hover:text-white/80 transition-colors">
                {game.description}
              </p>
            )}
          </div>
        </div>

        {/* Floating Play Button for featured or hover state */}
        <motion.div
          initial={{ opacity: 0, scale: 0.5, rotate: -45 }}
          animate={{ opacity: isHovered ? 1 : 0, scale: isHovered ? 1 : 0.5, rotate: isHovered ? 0 : -45 }}
          transition={{ duration: 0.4, type: "spring" }}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none"
        >
          <div className={`w-20 h-20 rounded-full bg-gradient-to-r ${game.color} flex items-center justify-center shadow-[0_0_40px_rgba(255,255,255,0.3)] border-2 border-white/20`}>
            <Play size={32} className="text-white fill-white ml-2" />
          </div>
        </motion.div>

        <div className="absolute inset-0 pointer-events-none z-0">
          <motion.div
            className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
            style={{
              background: "linear-gradient(45deg, transparent 40%, rgba(255,255,255,0.1) 50%, transparent 60%)",
            }}
          />
        </div>

        <div className="super-glow-line" />
      </div>
    </motion.div>
  );
}


function GamesSection() {
  return (
    <section id="games" className="relative py-32 px-6">
      <div className="max-w-7xl mx-auto">
        {/* Section Header */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <motion.div className="inline-flex items-center gap-2 px-4 py-2 rounded-full glass mb-6">
            <Gamepad2 size={14} className="text-primary" />
            <span className="text-xs font-semibold text-text-secondary tracking-wider uppercase">
              Game Arcade
            </span>
          </motion.div>
          <h2 className="text-4xl md:text-6xl font-black font-[family-name:var(--font-display)] tracking-tight mb-4">
            <span className="text-white">Choose Your</span>
            <br />
            <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent inline-block animate-float-complex">
              Battleground
            </span>
          </h2>
          <p className="text-text-secondary max-w-xl mx-auto">
            A curated collection of multiplayer games. Designed for maximum fun with
            friends.
          </p>
        </motion.div>

        {/* Games Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 auto-rows-auto">
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
    {
      icon: Zap,
      title: "Zero Lag Multiplayer",
      description:
        "WebRTC peer-to-peer connections with server fallback. Experience real-time gameplay with <100ms latency.",
      gradient: "from-yellow-500 to-orange-500",
      glow: "shadow-orange-500/20",
    },
    {
      icon: Users,
      title: "Universal Lobbies",
      description:
        "Create one lobby, play any game. Switch between games without disconnecting your friends.",
      gradient: "from-blue-500 to-cyan-500",
      glow: "shadow-blue-500/20",
    },
    {
      icon: Shield,
      title: "Anti-Cheat Protection",
      description:
        "Server-authoritative game state. The server is the single source of truth — no funny business.",
      gradient: "from-green-500 to-emerald-500",
      glow: "shadow-green-500/20",
    },
    {
      icon: Globe,
      title: "Play Anywhere",
      description:
        "Works on any device with a browser. Desktop, tablet, or phone — just share a link and play.",
      gradient: "from-purple-500 to-violet-500",
      glow: "shadow-purple-500/20",
    },
    {
      icon: MessageSquare,
      title: "In-Game Chat",
      description:
        "Text and emoji chat built into every game. Coordinate strategies or just trash talk your friends.",
      gradient: "from-pink-500 to-rose-500",
      glow: "shadow-pink-500/20",
    },
    {
      icon: Trophy,
      title: "Leaderboards & Stats",
      description:
        "Track your wins, K/D ratio, and high scores. Compete on global and friend leaderboards.",
      gradient: "from-amber-500 to-yellow-500",
      glow: "shadow-amber-500/20",
    },
  ];

  return (
    <section id="features" className="relative py-32 px-6">
      {/* Background accent */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 20% 50%, rgba(139, 92, 246, 0.06) 0%, transparent 50%)",
        }}
      />

      <div className="max-w-7xl mx-auto relative">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <motion.div className="inline-flex items-center gap-2 px-4 py-2 rounded-full glass mb-6">
            <Sparkles size={14} className="text-accent" />
            <span className="text-xs font-semibold text-text-secondary tracking-wider uppercase">
              Why PlayBuddies
            </span>
          </motion.div>
          <h2 className="text-4xl md:text-6xl font-black font-[family-name:var(--font-display)] tracking-tight mb-4">
            <span className="text-white">Built for</span>
            <br />
            <span className="bg-gradient-to-r from-accent to-primary bg-clip-text text-transparent inline-block animate-float-slow">
              Real Gamers
            </span>
          </h2>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, i) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ delay: i * 0.1 }}
              whileHover={{ y: -5 }}
              className="group p-8 rounded-2xl glass hover:bg-white/[0.03] transition-all duration-300 cursor-default"
            >
              <motion.div
                className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${feature.gradient} flex items-center justify-center mb-6 shadow-xl ${feature.glow}`}
                whileHover={{ scale: 1.1, rotate: 5 }}
              >
                <feature.icon size={24} className="text-white" />
              </motion.div>
              <h3 className="text-xl font-black text-white mb-3 group-hover:text-transparent group-hover:bg-gradient-to-r group-hover:bg-clip-text group-hover:from-white group-hover:to-white/50 transition-all duration-500">
                {feature.title}
              </h3>
              <p className="text-sm text-text-secondary leading-relaxed group-hover:text-white/80 transition-colors duration-500">
                {feature.description}
              </p>

            <div className="super-glow-line rounded-2xl" />
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}


function HowItWorks() {
  const steps = [
    {
      step: "01",
      title: "Login with Google",
      description: "One click. That's it. No new accounts, no passwords.",
      icon: "🔑",
    },
    {
      step: "02",
      title: "Pick a Game",
      description: "Browse our arcade of 10+ multiplayer games.",
      icon: "🎮",
    },
    {
      step: "03",
      title: "Invite Friends",
      description: "Share a link. They click, they're in. Instant.",
      icon: "📨",
    },
    {
      step: "04",
      title: "Play!",
      description: "Game on. Real-time multiplayer, zero lag.",
      icon: "🏆",
    },
  ];

  return (
    <section id="about" className="relative py-32 px-6">
      <div className="max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-20"
        >
          <h2 className="text-4xl md:text-6xl font-black font-[family-name:var(--font-display)] tracking-tight mb-4">
            <span className="text-white">How It</span>{" "}
            <span className="bg-gradient-to-r from-secondary to-primary bg-clip-text text-transparent">
              Works
            </span>
          </h2>
          <p className="text-text-secondary">
            From zero to playing with friends in under 30 seconds.
          </p>
        </motion.div>

        <div className="relative">
          {/* Connecting line */}
          <div className="hidden lg:block absolute top-1/2 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-primary/20 to-transparent -translate-y-1/2" />

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
            {steps.map((step, i) => (
              <motion.div
                key={step.step}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.15 }}
                className="relative text-center group"
              >
                <motion.div
                  whileHover={{ scale: 1.1, y: -5 }}
                  className="relative mx-auto w-24 h-24 rounded-3xl glass flex items-center justify-center mb-6 group-hover:shadow-lg group-hover:shadow-primary/10 transition-shadow"
                >
                  <span className="text-4xl">{step.icon}</span>
                  <div className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center text-xs font-bold text-white shadow-lg">
                    {step.step}
                  </div>
                </motion.div>
                <h3 className="text-lg font-bold text-white mb-2">
                  {step.title}
                </h3>
                <p className="text-sm text-text-secondary">{step.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}


function CTASection() {
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
    <section className="relative py-32 px-6 overflow-hidden">
      {/* Background blobs */}
      <motion.div
        className="absolute w-[800px] h-[800px] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(139, 92, 246, 0.15) 0%, transparent 60%)",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
        }}
        animate={{ scale: [1, 1.2, 1], opacity: [0.5, 0.8, 0.5] }}
        transition={{ duration: 5, repeat: Infinity }}
      />

      <div className="max-w-4xl mx-auto relative text-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          className="p-12 md:p-20 rounded-3xl glass relative overflow-hidden"
        >
          {/* Animated gradient border */}
          <div className="absolute inset-0 rounded-3xl p-[1px]">
            <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-primary via-accent to-secondary opacity-20 animate-gradient-shift bg-[length:300%_300%]" />
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-4xl md:text-6xl font-black font-[family-name:var(--font-display)] tracking-tight mb-6">
              Ready to{" "}
              <span className="bg-gradient-to-r from-primary via-accent to-secondary bg-clip-text text-transparent">
                Play?
              </span>
            </h2>
            <p className="text-lg text-text-secondary mb-10 max-w-xl mx-auto">
              Join thousands of players. Create a room, send a link, and start
              playing with friends in seconds.
            </p>
            <motion.button
              onClick={handlePlay}
              disabled={isLoggingIn}
              whileHover={{ scale: 1.05, y: -3 }}
              whileTap={{ scale: 0.95 }}
              className="btn-glow px-10 py-5 bg-gradient-to-r from-primary to-accent rounded-2xl text-white font-bold text-lg shadow-2xl shadow-primary/30 flex items-center gap-3 mx-auto disabled:opacity-75"
            >
              {isLoggingIn ? (
                <Loader2 size={22} className="animate-spin" />
              ) : (
                <Gamepad2 size={22} />
              )}
              {user ? "Go to Dashboard" : "Login with Google & Play"}
              {!isLoggingIn && <ChevronRight size={18} />}
            </motion.button>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}


function Footer() {
  return (
    <footer className="relative border-t border-white/5 py-16 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row items-center justify-between gap-8">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              <Gamepad2 size={16} className="text-white" />
            </div>
            <span className="text-lg font-bold font-[family-name:var(--font-display)]">
              Play
              <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
                Buddies
              </span>
            </span>
          </div>

          {/* Links */}
          <div className="flex items-center gap-8">
            {["Privacy", "Terms", "Contact"].map((link) => (
              <a
                key={link}
                href="#"
                className="text-sm text-text-muted hover:text-white transition-colors"
              >
                {link}
              </a>
            ))}
          </div>

          {/* Copyright */}
          <div className="text-sm text-text-muted">
            © 2026 PlayBuddies by Bilal Saeed
          </div>
        </div>
      </div>
    </footer>
  );
}



export default function Home() {
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    // Reveal page after a short delay
    const timer = setTimeout(() => setIsLoaded(true), 100);
    return () => clearTimeout(timer);
  }, []);

  return (
    <main className="relative bg-background overflow-hidden">
      {/* Initial Reveal Animation Overlay */}
      <AnimatePresence>
        {!isLoaded && (
          <motion.div
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8, ease: "easeInOut" }}
            className="fixed inset-0 z-[100] bg-surface-dark flex items-center justify-center"
          >
            <div className="flex flex-col items-center gap-6">
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.5 }}
                className="w-20 h-20 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-2xl shadow-primary/20"
              >
                <Gamepad2 size={40} className="text-white" />
              </motion.div>
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.2, duration: 0.5 }}
                className="h-1 w-48 bg-white/10 rounded-full overflow-hidden"
              >
                <motion.div
                  initial={{ x: "-100%" }}
                  animate={{ x: "0%" }}
                  transition={{ duration: 0.8, ease: "easeInOut" }}
                  className="h-full w-full bg-gradient-to-r from-primary to-accent"
                />
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: isLoaded ? 1 : 0, scale: isLoaded ? 1 : 0.98 }}
        transition={{ duration: 1, ease: "easeOut" }}
      >
        <FloatingParticles />
        <AnimatedOrbs />
        <Navbar />
        <HeroSection />
        <GamesSection />
        <FeaturesSection />
        <HowItWorks />
        <CTASection />
        <Footer />
      </motion.div>
    </main>
  );
}


