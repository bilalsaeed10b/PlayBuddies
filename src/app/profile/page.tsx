"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { auth, db, storage } from "@/lib/firebase";
import { updateProfile } from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import {
  BADGES,
  EMPTY_PROGRESS,
  TESTER_THRESHOLD,
  hasBadge,
  NO_BADGE,
  wornBadge,
  testerProgress,
  type BadgeProgress,
} from "@/lib/badges";
import BadgeChip, { BadgeIcon } from "@/components/BadgeChip";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { useAuthStore } from "@/store/useAuthStore";
import AuthGuard from "@/components/AuthGuard";
import {
  Camera,
  Check,
  X,
  ArrowLeft,
  Pencil,
  Gamepad2,
  Trophy,
  Star,
  Crown,
  Loader2,
  Copy,
  Lock,
  Bug,
} from "lucide-react";

// ─── Image resize helper ──────────────────────────────────────────────────────

async function resizeImageFile(file: File, maxPx = 200): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const size = Math.min(img.naturalWidth, img.naturalHeight, maxPx);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("No canvas context"));
      // Centre-crop to square
      const srcX = (img.naturalWidth - size) / 2;
      const srcY = (img.naturalHeight - size) / 2;
      ctx.drawImage(img, srcX, srcY, size, size, 0, 0, size, size);
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error("Canvas toBlob failed"));
          resolve(blob);
        },
        "image/webp",
        0.82,
      );
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  const [displayName, setDisplayName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [savingName, setSavingName] = useState(false);

  const [photoURL, setPhotoURL] = useState("");
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState("");

  const [friendCode, setFriendCode] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);

  const [progress, setProgress] = useState<BadgeProgress>(EMPTY_PROGRESS);
  /**
   * The badge this player chose to wear, read from their public profile.
   *
   * Empty means they have never picked one, which is not the same thing as
   * picking none , see `wornBadge`. An admin handing out a badge writes to
   * `grants` and never to this: the gift is theirs to keep either way, and
   * putting it on is their call alone.
   */
  const [chosenBadge, setChosenBadge] = useState<string>("");
  const [savingBadge, setSavingBadge] = useState("");
  const [loadingStats, setLoadingStats] = useState(true);
  const gamesPlayed = progress.gamesPlayed;
  const wins = progress.wins;

  const [notice, setNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Load profile & stats ──
  useEffect(() => {
    if (!user) return;
    setDisplayName(user.displayName || "Player");
    setPhotoURL(
      user.photoURL ||
        `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.uid}`,
    );

    let cancelled = false;

    (async () => {
      try {
        // Public profile for friendCode
        const profileSnap = await getDoc(doc(db, "profiles", user.uid));
        if (!cancelled && profileSnap.exists()) {
          setFriendCode(profileSnap.data().friendCode || "");
          setChosenBadge(profileSnap.data().badge ?? "");
          // Use profile photoURL if it differs (updated from profile page)
          const pPhoto = profileSnap.data().photoURL;
          if (pPhoto) setPhotoURL(pPhoto);
        }

        // Private stats
        const userSnap = await getDoc(doc(db, "users", user.uid));
        if (!cancelled && userSnap.exists()) {
          const data = userSnap.data();
          setProgress({
            gamesPlayed: data.stats?.gamesPlayed ?? 0,
            wins: data.stats?.wins ?? 0,
            bugsApproved: data.bugStats?.approved ?? 0,
            grants: data.grants ?? {},
          });
        }
      } catch (e) {
        console.error("Profile load error:", e);
      } finally {
        if (!cancelled) setLoadingStats(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  // ── Save display name ──
  const saveName = async () => {
    const name = nameInput.trim().slice(0, 60);
    if (!name || !user) return;
    setSavingName(true);
    try {
      await updateProfile(auth.currentUser!, { displayName: name });
      await setDoc(
        doc(db, "profiles", user.uid),
        { displayName: name, updatedAt: serverTimestamp() },
        { merge: true },
      );
      setDisplayName(name);
      setEditingName(false);
      flash("Display name updated!");
    } catch (e) {
      console.error("Name save error:", e);
      flash("Could not save name. Try again.");
    } finally {
      setSavingName(false);
    }
  };

  // ── Upload avatar ──
  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !user) return;
      setPhotoError("");
      setUploadingPhoto(true);
      try {
        const blob = await resizeImageFile(file, 200);
        const storageRef = ref(storage, `avatars/${user.uid}/avatar.webp`);
        await uploadBytes(storageRef, blob, { contentType: "image/webp" });
        const url = await getDownloadURL(storageRef);

        await updateProfile(auth.currentUser!, { photoURL: url });
        await setDoc(
          doc(db, "profiles", user.uid),
          { photoURL: url, updatedAt: serverTimestamp() },
          { merge: true },
        );
        setPhotoURL(url);
        flash("Photo updated!");
      } catch (err) {
        console.error("Photo upload error:", err);
        setPhotoError("Upload failed. Please try again.");
      } finally {
        setUploadingPhoto(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [user],
  );

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(""), 3000);
  };

  const copyCode = () => {
    navigator.clipboard.writeText(friendCode).catch(() => {});
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  };

  /**
   * Put a badge on, or take it off.
   *
   * Written to the public profile because that is the document everyone else
   * reads a name and a badge from. The rules check it against the grants on
   * the private one, so choosing a badge you were never given is refused by
   * the database rather than only by this button being hidden.
   */
  const wearBadge = async (badgeId: string) => {
    if (!user) return;
    setSavingBadge(badgeId);
    try {
      await setDoc(
        doc(db, "profiles", user.uid),
        { badge: badgeId, updatedAt: serverTimestamp() },
        { merge: true },
      );
      setChosenBadge(badgeId);
      flash(badgeId === NO_BADGE ? "Badge removed." : "Badge updated!");
    } catch (e) {
      console.error("Badge save error:", e);
      flash("Could not change your badge. Try again.");
    } finally {
      setSavingBadge("");
    }
  };

  if (!user) return null;

  const earnedCount = BADGES.filter((b) => hasBadge(b, progress)).length;
  const tester = testerProgress(progress.bugsApproved);
  const wearing = wornBadge(progress, chosenBadge);

  return (
    <AuthGuard>
      <div className="min-h-screen bg-background relative overflow-hidden">
        {/* Background */}
        <div className="absolute inset-0 bg-grid animate-grid-pulse opacity-30" />
        <div
          className="absolute top-0 left-0 w-[600px] h-[600px] rounded-full pointer-events-none"
          style={{
            background:
              "radial-gradient(circle, rgba(139,92,246,0.1) 0%, transparent 70%)",
          }}
        />
        <div
          className="absolute bottom-0 right-0 w-[400px] h-[400px] rounded-full pointer-events-none"
          style={{
            background:
              "radial-gradient(circle, rgba(236,72,153,0.08) 0%, transparent 70%)",
          }}
        />

        {/* Nav */}
        <nav className="relative z-40 glass border-b border-white/5 px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => router.back()}
            className="p-2 rounded-xl hover:bg-white/10 text-text-muted hover:text-white transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-xl font-bold text-white">My Profile</h1>
        </nav>

        {/* Notice toast */}
        <AnimatePresence>
          {notice && (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-primary text-white px-6 py-3 rounded-2xl shadow-2xl text-sm font-bold"
            >
              {notice}
            </motion.div>
          )}
        </AnimatePresence>

        <main className="relative z-10 max-w-3xl mx-auto px-4 sm:px-6 py-10 space-y-8">

          {/* ── Avatar + name card ─────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass rounded-3xl border border-white/10 overflow-hidden"
          >
            {/* Banner strip */}
            <div className="h-28 bg-gradient-to-br from-primary/40 via-accent/20 to-secondary/30 relative">
              <div className="absolute inset-0 bg-grid opacity-20" />
            </div>

            <div className="px-6 pb-6">
              {/* Avatar */}
              <div className="relative -mt-14 mb-4 w-fit">
                <div className="w-28 h-28 rounded-3xl border-4 border-[#0A0A14] overflow-hidden relative group">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photoURL}
                    alt="Avatar"
                    onError={(e) => {
                      e.currentTarget.src = `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.uid}`;
                    }}
                    className="w-full h-full object-cover"
                  />
                  {/* Upload overlay */}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingPhoto}
                    className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1 cursor-pointer"
                    aria-label="Change avatar"
                  >
                    {uploadingPhoto ? (
                      <Loader2 size={24} className="animate-spin text-white" />
                    ) : (
                      <>
                        <Camera size={22} className="text-white" />
                        <span className="text-[10px] text-white font-bold">Change</span>
                      </>
                    )}
                  </button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileChange}
                  aria-label="Upload profile photo"
                />
                {photoError && (
                  <p className="text-xs text-error mt-1">{photoError}</p>
                )}
              </div>

              {/* Name + edit */}
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  {editingName ? (
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        maxLength={60}
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveName();
                          if (e.key === "Escape") setEditingName(false);
                        }}
                        className="bg-white/5 border border-primary/50 rounded-xl px-3 py-2 text-white text-xl font-bold focus:outline-none w-48"
                        aria-label="Display name input"
                      />
                      <button
                        onClick={saveName}
                        disabled={savingName}
                        className="p-2 bg-primary rounded-xl hover:bg-primary/80 transition-colors"
                        aria-label="Save name"
                      >
                        {savingName ? (
                          <Loader2 size={16} className="animate-spin text-white" />
                        ) : (
                          <Check size={16} className="text-white" />
                        )}
                      </button>
                      <button
                        onClick={() => setEditingName(false)}
                        className="p-2 bg-white/10 rounded-xl hover:bg-white/20 transition-colors"
                        aria-label="Cancel"
                      >
                        <X size={16} className="text-text-muted" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <h2 className="text-2xl font-black text-white truncate">
                        {displayName}
                      </h2>
                      <BadgeChip badge={wearing} />
                      <button
                        onClick={() => {
                          setNameInput(displayName);
                          setEditingName(true);
                        }}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-text-muted hover:text-white transition-colors"
                        aria-label="Edit display name"
                      >
                        <Pencil size={14} />
                      </button>
                    </div>
                  )}
                  <p className="text-sm text-text-muted mt-0.5">{user.email}</p>
                </div>

                {/* Friend code */}
                <div className="flex flex-col items-end gap-1">
                  <p className="text-[10px] uppercase tracking-widest text-text-muted font-bold">
                    Friend Code
                  </p>
                  <button
                    onClick={copyCode}
                    className="flex items-center gap-2 font-mono text-lg font-black text-white hover:text-primary transition-colors"
                    title="Copy friend code"
                  >
                    {friendCode || "—"}
                    {codeCopied ? (
                      <Check size={14} className="text-success" />
                    ) : (
                      <Copy size={14} className="text-text-muted" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>

          {/* ── Stats row ─────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="grid grid-cols-2 sm:grid-cols-2 gap-4"
          >
            {[
              {
                label: "Games Played",
                value: loadingStats ? "—" : gamesPlayed,
                icon: <Gamepad2 size={22} />,
                color: "text-blue-400",
                bg: "bg-blue-500/10 border-blue-500/20",
              },
              {
                label: "Wins",
                value: loadingStats ? "—" : wins,
                icon: <Trophy size={22} />,
                color: "text-amber-400",
                bg: "bg-amber-500/10 border-amber-500/20",
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className={`glass rounded-2xl p-5 border flex items-center gap-4 ${stat.bg}`}
              >
                <div className={`${stat.color}`}>{stat.icon}</div>
                <div>
                  <p className="text-2xl font-black text-white">{stat.value}</p>
                  <p className="text-xs text-text-muted">{stat.label}</p>
                </div>
              </div>
            ))}
          </motion.div>

          {/* ── Badges ────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <div className="flex items-center justify-between mb-4 gap-3">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Star size={18} className="text-primary" />
                Badges
              </h3>
              <span className="text-xs text-text-muted bg-white/5 border border-white/10 rounded-full px-3 py-1 whitespace-nowrap">
                {earnedCount} / {BADGES.length} earned
              </span>
            </div>

            {/* Tester progress. Shown to everyone, because the point of the
                bar is to tell a player the badge exists and is reachable. */}
            <div className="glass rounded-2xl border border-white/10 p-4 mb-4">
              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="text-sm font-bold text-white flex items-center gap-2">
                  <Bug size={15} className="text-lime-400" />
                  Tester badge
                </p>
                <span className="text-[11px] text-text-muted tabular-nums">{tester.label}</span>
              </div>
              <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-lime-400 to-emerald-500 transition-[width] duration-500"
                  style={{ width: `${tester.ratio * 100}%` }}
                />
              </div>
              <p className="text-[11px] text-text-muted mt-2">
                {tester.next === null
                  ? "Every tier unlocked. Thanks for the reports."
                  : `Report bugs with the bug button. ${TESTER_THRESHOLD} approved reports earns Tester.`}
              </p>
            </div>

            {earnedCount > 0 && (
              <div className="glass rounded-2xl border border-white/10 p-3 mb-3 flex items-center justify-between gap-3">
                <p className="text-[11px] text-text-muted leading-relaxed">
                  Tap a badge you have earned to wear it beside your name.
                </p>
                <button
                  onClick={() => wearBadge(NO_BADGE)}
                  disabled={savingBadge !== "" || chosenBadge === NO_BADGE}
                  className="shrink-0 rounded-xl border border-white/10 px-3 py-1.5 text-[11px] font-bold text-text-secondary hover:border-white/25 disabled:opacity-40 transition-colors"
                >
                  Wear none
                </button>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {BADGES.map((badge, i) => {
                const earned = hasBadge(badge, progress);
                const isWorn = wearing?.id === badge.id;
                // What is still missing, in the badge's own units. A locked
                // badge that says nothing is just a grey square; one that says
                // "62 / 100 wins" is a reason to play another match.
                const track =
                  badge.winsNeeded !== undefined
                    ? { have: progress.wins, need: badge.winsNeeded }
                    : badge.gamesNeeded !== undefined
                      ? { have: progress.gamesPlayed, need: badge.gamesNeeded }
                      : badge.bugsNeeded !== undefined
                        ? { have: progress.bugsApproved, need: badge.bugsNeeded }
                        : null;
                return (
                  <motion.button
                    key={badge.id}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.15 + i * 0.04 }}
                    title={
                      earned
                        ? isWorn
                          ? `${badge.label} , currently worn`
                          : `Wear ${badge.label}`
                        : badge.description
                    }
                    onClick={() => earned && !isWorn && wearBadge(badge.id)}
                    disabled={!earned || savingBadge !== ""}
                    className={`glass rounded-2xl p-4 border flex flex-col items-center gap-2 text-center transition-all relative overflow-hidden ${
                      isWorn
                        ? "border-primary/60 ring-1 ring-primary/40"
                        : earned
                          ? "border-white/15 hover:border-white/30 cursor-pointer"
                          : "border-white/5 opacity-50 cursor-default"
                    }`}
                  >
                    {earned && (
                      <div
                        className={`absolute inset-0 bg-gradient-to-br ${badge.color} opacity-10`}
                      />
                    )}

                    {/* Granted badges nobody has yet read as locked, not as
                        missing , they are given out, not ground out. */}
                    {!earned && badge.source !== "stat" && (
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center rounded-2xl z-10">
                        <Lock size={20} className="text-amber-400" />
                      </div>
                    )}

                    <div
                      className={`relative z-0 w-12 h-12 rounded-xl flex items-center justify-center bg-gradient-to-br ${badge.color} ${earned ? "" : "grayscale"}`}
                    >
                      <div className="text-white">
                        <BadgeIcon name={badge.icon} size={28} />
                      </div>
                    </div>
                    <div className="relative z-0 w-full">
                      <p className="text-xs font-bold text-white leading-tight">{badge.label}</p>
                      <p className="text-[10px] text-text-muted mt-0.5 leading-tight">
                        {badge.description}
                      </p>

                      {isWorn && (
                        <span className="mt-1.5 inline-block rounded-full bg-primary/20 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-primary">
                          worn
                        </span>
                      )}

                      {!earned && track && (
                        <div className="mt-2">
                          <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                            <div
                              className={`h-full rounded-full bg-gradient-to-r ${badge.color} transition-[width] duration-500`}
                              style={{
                                width: `${Math.min(100, (track.have / track.need) * 100)}%`,
                              }}
                            />
                          </div>
                          <p className="mt-1 text-[9px] text-text-muted tabular-nums">
                            {track.have} / {track.need}
                          </p>
                        </div>
                      )}

                      {!earned && !track && (
                        <p className="mt-1.5 text-[9px] text-amber-400/80">Given by an admin</p>
                      )}
                    </div>
                  </motion.button>
                );
              })}
            </div>
          </motion.div>

          {/* ── Achievements (placeholder) ─────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.18 }}
          >
            <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
              <Trophy size={18} className="text-amber-400" />
              Achievements
            </h3>
            <div className="glass rounded-2xl border border-white/10 p-6 flex flex-col items-center justify-center text-center gap-3 min-h-[120px]">
              <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-text-muted">
                <Trophy size={22} />
              </div>
              <div>
                <p className="text-sm font-bold text-white">Coming Soon</p>
                <p className="text-xs text-text-muted mt-0.5">
                  Achievements track your in-game milestones — launching with the next update.
                </p>
              </div>
            </div>
          </motion.div>

          {/* ── Premium tier card ─────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.22 }}
            className="relative overflow-hidden rounded-3xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 via-yellow-500/5 to-transparent p-6"
          >
            {/* Shimmer */}
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -skew-x-12 animate-pulse" />

            <div className="relative z-10 flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-400 to-yellow-500 flex items-center justify-center shadow-lg shadow-amber-500/30 shrink-0">
                  <Crown size={28} className="text-white" />
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <h3 className="text-lg font-black text-white">
                      PlayWithBuddies
                      <span className="text-amber-400">+</span>
                    </h3>
                    <span className="text-[10px] font-black bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full px-2 py-0.5 uppercase tracking-widest">
                      Coming Soon
                    </span>
                  </div>
                  <p className="text-sm text-text-muted max-w-xs">
                    Exclusive badges, in-game benefits, custom avatars, and more — launching soon.
                  </p>
                </div>
              </div>
              <button
                disabled
                className="shrink-0 px-5 py-2.5 rounded-xl bg-amber-500/20 border border-amber-500/30 text-amber-300 text-sm font-bold cursor-not-allowed opacity-60"
              >
                Get Plus
              </button>
            </div>
          </motion.div>

        </main>
      </div>
    </AuthGuard>
  );
}
