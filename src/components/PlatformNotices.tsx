"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Ban, CheckCircle2, Info, Megaphone, Wrench, X } from "lucide-react";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import { isAdminUser } from "@/lib/admin";
import {
  announcementLive,
  suspensionActive,
  useMySuspension,
  usePlatformConfig,
  type AnnouncementTone,
} from "@/lib/platformConfig";

const TONE: Record<AnnouncementTone, { box: string; icon: React.ReactNode }> = {
  info: { box: "border-sky-400/40 bg-sky-950/90 text-sky-50", icon: <Info size={16} className="text-sky-300" /> },
  success: {
    box: "border-emerald-400/40 bg-emerald-950/90 text-emerald-50",
    icon: <CheckCircle2 size={16} className="text-emerald-300" />,
  },
  warning: {
    box: "border-amber-400/40 bg-amber-950/90 text-amber-50",
    icon: <AlertTriangle size={16} className="text-amber-300" />,
  },
  danger: { box: "border-red-400/40 bg-red-950/90 text-red-50", icon: <Megaphone size={16} className="text-red-300" /> },
};

const DISMISS_KEY = "pb_dismissed_announcement";

/**
 * What the admin panel says to everyone: the banner, maintenance mode, and a
 * suspended account's locked door.
 *
 * Admins see the banner and the maintenance strip , they should see what
 * players see , but are never locked out by either, or a maintenance switch
 * flipped by mistake would lock out the one person who could flip it back.
 */
export default function PlatformNotices() {
  const { user } = useAuthStore();
  const config = usePlatformConfig(Boolean(user));
  const suspension = useMySuspension(user?.uid);
  const admin = isAdminUser(user);
  const [dismissed, setDismissed] = useState<string>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) ?? "";
    } catch {
      // Server render, or private mode: dismissals just do not persist.
      return "";
    }
  });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!user) return null;

  if (!admin && suspensionActive(suspension, now)) {
    return (
      <div className="fixed inset-0 z-[400] flex items-center justify-center bg-background/95 p-6 backdrop-blur">
        <div className="glass w-full max-w-md rounded-3xl border border-red-500/30 p-8 text-center">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/15">
            <Ban size={30} className="text-red-400" />
          </div>
          <h1 className="mb-2 text-2xl font-black text-white">Account suspended</h1>
          <p className="mb-1 text-sm text-text-secondary">
            {suspension.reason || "An admin has suspended this account."}
          </p>
          <p className="mb-6 text-xs text-text-muted">
            {suspension.until > 0
              ? `Lifts ${new Date(suspension.until).toLocaleString()}.`
              : "Until an admin lifts it."}
          </p>
          <button
            onClick={() => void signOut(auth)}
            className="rounded-2xl bg-white/10 px-6 py-3 text-sm font-bold text-white hover:bg-white/20"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  const a = config.announcement;
  const showBanner = announcementLive(a, now) && a.id !== dismissed;
  const tone = a ? TONE[a.tone] : TONE.info;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-[150] flex flex-col items-center gap-2 px-3">
      {config.maintenance.on && (
        <div className="pointer-events-auto flex w-full max-w-xl items-center gap-2.5 rounded-2xl border border-amber-400/40 bg-amber-950/90 px-4 py-2.5 text-amber-50 shadow-2xl backdrop-blur">
          <Wrench size={16} className="shrink-0 text-amber-300" />
          <p className="text-xs font-bold leading-snug sm:text-sm">
            {config.maintenance.message || "PlayBuddies is under maintenance. New games are paused for a moment."}
            {admin && <span className="ml-1 font-normal text-amber-200/70">(admin: you can still play)</span>}
          </p>
        </div>
      )}
      <AnimatePresence>
        {showBanner && (
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className={`pointer-events-auto flex w-full max-w-xl items-start gap-2.5 rounded-2xl border px-4 py-2.5 shadow-2xl backdrop-blur ${tone.box}`}
          >
            <span className="mt-0.5 shrink-0">{tone.icon}</span>
            <p className="flex-1 text-xs font-semibold leading-snug sm:text-sm">{a!.text}</p>
            <button
              onClick={() => {
                setDismissed(a!.id);
                try {
                  localStorage.setItem(DISMISS_KEY, a!.id);
                } catch {
                  /* ignore */
                }
              }}
              aria-label="Dismiss"
              className="shrink-0 rounded-lg p-1 opacity-70 hover:bg-white/10 hover:opacity-100"
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
