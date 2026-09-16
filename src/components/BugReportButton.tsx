"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bug, X, Upload, Camera, Check, Loader2, ImageOff, Trash2 } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import { PLAYABLE_GAMES } from "@/lib/games";
import { BUG_INBOX_EMAIL } from "@/lib/admin";
import {
  BUG_CATEGORIES,
  BUG_SEVERITIES,
  DESCRIPTION_MAX,
  SCREENSHOT_MAX_BYTES,
  TITLE_MAX,
  captureContext,
  compressScreenshot,
  submitBugReport,
  type BugCategory,
  type BugSeverity,
} from "@/lib/bugs";

const SEVERITY_STYLE: Record<BugSeverity, string> = {
  low: "border-white/15 text-text-secondary",
  medium: "border-amber-400/40 text-amber-300",
  high: "border-orange-400/50 text-orange-300",
  critical: "border-red-500/60 text-red-300",
};

/**
 * The floating "Report a bug" entry point and its form.
 *
 * Mounted globally so a player can file a report from wherever the bug
 * actually happened, which matters because the form captures the page it was
 * opened on: a report filed later from the dashboard would carry the
 * dashboard's context and be worth much less.
 *
 * A screenshot can arrive three ways , picked from disk, pasted from the
 * clipboard (the fastest path on a desktop, where the bug is one PrintScreen
 * away) or grabbed with the screen-capture API where the browser offers it.
 */
export default function BugReportButton() {
  const { user } = useAuthStore();
  const [open, setOpen] = useState(false);

  if (!user) return null;

  return (
    <>
      <motion.button
        onClick={() => setOpen(true)}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.94 }}
        title="Report a bug"
        aria-label="Report a bug"
        className="fixed bottom-6 left-6 z-[60] w-12 h-12 rounded-2xl glass border border-white/10 hover:border-lime-400/50 flex items-center justify-center text-lime-300 shadow-xl shadow-black/30 transition-colors"
      >
        <Bug size={20} />
      </motion.button>

      <AnimatePresence>
        {open && <BugReportModal onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </>
  );
}

function BugReportModal({ onClose }: { onClose: () => void }) {
  const { user } = useAuthStore();
  // Read straight off the URL rather than through useSearchParams: this is
  // mounted globally, and that hook forces every page under it into a Suspense
  // boundary on a statically exported build.
  const roomId = (new URLSearchParams(window.location.search).get("room") || "").slice(0, 6);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [gameId, setGameId] = useState("");
  const [severity, setSeverity] = useState<BugSeverity>("medium");
  const [category, setCategory] = useState<BugCategory>("gameplay");
  const [shot, setShot] = useState<{ blob: Blob; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Object URLs are per-blob, so the old one has to go when a second
  // screenshot replaces the first, not only when the modal closes.
  useEffect(() => {
    return () => {
      if (shot) URL.revokeObjectURL(shot.preview);
    };
  }, [shot]);

  const acceptImage = useCallback(async (file: Blob) => {
    setError("");
    try {
      const blob = await compressScreenshot(file);
      if (blob.size > SCREENSHOT_MAX_BYTES) {
        setError("That screenshot is still too large after compression. Try cropping it.");
        return;
      }
      setShot((previous) => {
        if (previous) URL.revokeObjectURL(previous.preview);
        return { blob, preview: URL.createObjectURL(blob) };
      });
    } catch {
      setError("That file could not be read as an image.");
    }
  }, []);

  // Paste anywhere in the form. Listening on the window rather than a single
  // field means Ctrl+V works without first clicking the right box.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith("image/"),
      );
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        void acceptImage(file);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptImage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * Grab the screen through the capture API.
   *
   * The stream is stopped the moment one frame is off it , leaving it running
   * would keep the browser's "sharing your screen" indicator up long after the
   * screenshot was taken, which reads as the site still watching.
   */
  const captureScreen = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      await new Promise((r) => setTimeout(r, 240));
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      track.stop();
      stream.getTracks().forEach((t) => t.stop());
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.9));
      if (blob) await acceptImage(blob);
    } catch {
      setError("Screen capture was cancelled or is not available in this browser.");
    }
  };

  const submit = async () => {
    if (!user) return;
    if (title.trim().length < 4) {
      setError("Give the bug a short title so it can be found in the list.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await submitBugReport(
        {
          uid: user.uid,
          displayName: user.displayName || "Player",
          email: user.email || "",
          photoURL: user.photoURL || "",
        },
        {
          title,
          description,
          gameId,
          roomId,
          severity,
          category,
          screenshot: shot?.blob ?? null,
          context: captureContext(),
        },
      );
      setDone(true);
      setTimeout(onClose, 1800);
    } catch (e) {
      console.error("Bug report failed", e);
      setError("The report could not be sent. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 16 }}
        onClick={(e) => e.stopPropagation()}
        className="glass-solid bg-[#141423] w-full max-w-lg rounded-3xl border border-white/10 shadow-2xl max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-5 border-b border-white/10 sticky top-0 bg-[#141423] z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-lime-400 to-emerald-500 flex items-center justify-center">
              <Bug size={20} className="text-black" />
            </div>
            <div>
              <h2 className="font-black text-white text-lg leading-tight">Report a bug</h2>
              <p className="text-[11px] text-text-muted">Goes to {BUG_INBOX_EMAIL}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-xl hover:bg-white/10 flex items-center justify-center text-text-muted"
          >
            <X size={18} />
          </button>
        </div>

        {done ? (
          <div className="p-10 text-center">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-emerald-500/20 flex items-center justify-center mb-4">
              <Check size={32} className="text-emerald-400" />
            </div>
            <p className="font-bold text-white text-lg">Report filed</p>
            <p className="text-sm text-text-secondary mt-1">
              Ten approved reports earns you the Tester badge.
            </p>
          </div>
        ) : (
          <div className="p-5 space-y-4">
            <Field label="What went wrong?">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))}
                placeholder="Ship kept firing after it sank"
                className="w-full bg-white/5 border border-white/10 focus:border-primary/50 rounded-xl px-4 py-2.5 text-white outline-none placeholder:text-text-muted/50"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Game">
                <select
                  value={gameId}
                  onChange={(e) => setGameId(e.target.value)}
                  // The popup list for a native <select> is browser/OS chrome,
                  // not something Tailwind's dark classes touch. Explicitly
                  // pinning color-scheme here (rather than relying on the
                  // inherited `html { color-scheme: dark }`) is what actually
                  // keeps that popup dark on Windows Chrome/Edge.
                  style={{ colorScheme: "dark" }}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white outline-none text-sm"
                >
                  <option value="">Platform / not a game</option>
                  {PLAYABLE_GAMES.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Area">
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as BugCategory)}
                  style={{ colorScheme: "dark" }}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white outline-none text-sm capitalize"
                >
                  {BUG_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="How bad is it?">
              <div className="grid grid-cols-4 gap-2">
                {BUG_SEVERITIES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setSeverity(s)}
                    className={`py-2 rounded-xl border text-xs font-bold capitalize transition-colors ${
                      severity === s
                        ? `${SEVERITY_STYLE[s]} bg-white/10`
                        : "border-white/10 text-text-muted hover:bg-white/5"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="What happened, and what did you expect?">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
                rows={4}
                placeholder="Steps to reproduce help most. What you did, what happened, what should have happened."
                className="w-full bg-white/5 border border-white/10 focus:border-primary/50 rounded-xl px-4 py-2.5 text-white outline-none text-sm resize-none placeholder:text-text-muted/50"
              />
            </Field>

            <Field label="Screenshot (paste, upload or capture)">
              {shot ? (
                <div className="relative rounded-xl overflow-hidden border border-white/10">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={shot.preview} alt="Screenshot" className="w-full max-h-52 object-contain bg-black/40" />
                  <button
                    onClick={() => setShot(null)}
                    className="absolute top-2 right-2 w-8 h-8 rounded-lg bg-black/70 hover:bg-red-500/80 flex items-center justify-center text-white"
                    aria-label="Remove screenshot"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="flex items-center justify-center gap-2 py-3 rounded-xl border border-dashed border-white/15 hover:border-primary/40 hover:bg-white/5 text-sm text-text-secondary transition-colors"
                  >
                    <Upload size={15} /> Upload
                  </button>
                  <button
                    onClick={captureScreen}
                    className="flex items-center justify-center gap-2 py-3 rounded-xl border border-dashed border-white/15 hover:border-primary/40 hover:bg-white/5 text-sm text-text-secondary transition-colors"
                  >
                    <Camera size={15} /> Capture
                  </button>
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void acceptImage(file);
                  e.target.value = "";
                }}
              />
            </Field>

            <p className="flex items-start gap-2 text-[11px] text-text-muted leading-relaxed">
              <ImageOff size={13} className="shrink-0 mt-0.5" />
              Your page, browser, screen size and network quality are attached automatically. Only
              you and an admin can ever open the screenshot.
            </p>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <button
              onClick={submit}
              disabled={busy || title.trim().length < 4}
              className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-gradient-to-r from-lime-400 to-emerald-500 text-black font-black disabled:opacity-40 transition-opacity"
            >
              {busy ? <Loader2 size={18} className="animate-spin" /> : <Bug size={18} />}
              {busy ? "Sending…" : "Send report"}
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
