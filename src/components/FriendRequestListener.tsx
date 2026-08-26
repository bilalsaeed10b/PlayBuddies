"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { UserPlus, X, Check } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import { useFriendRequests } from "@/hooks/useFriendRequests";
import { acceptFriendRequest, declineFriendRequest } from "@/lib/friends";

const SEEN_KEY = "pb_seen_friend_requests_v1";

function loadSeen(): Set<string> {
  try {
    const raw = sessionStorage.getItem(SEEN_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>) {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    /* private mode — the toast just reappears next reload, which is fine */
  }
}

/**
 * Pops a toast the moment a friend request arrives, anywhere in the app —
 * including mid-lobby, where the friends panel used to not even mount.
 *
 * A request that was already pending before this component ever mounted
 * (the common case: you signed in and someone had asked days ago) does not
 * toast — it's already sitting in the panel's badge, and re-announcing it on
 * every page load would be noise, not news. Only requests that appear after
 * the baseline is established, and haven't already been shown this session,
 * trigger the toast.
 */
export default function FriendRequestListener() {
  const user = useAuthStore((s) => s.user);
  const requests = useFriendRequests();
  const [toasts, setToasts] = useState<string[]>([]);
  const baseline = useRef<Set<string> | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const [dismissing, setDismissing] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user) {
      baseline.current = null;
      return;
    }
    seen.current = loadSeen();
  }, [user]);

  useEffect(() => {
    if (!user) return;

    if (baseline.current === null) {
      // First snapshot after mount/sign-in establishes what was already
      // pending — none of it is "new".
      baseline.current = new Set(requests.map((r) => r.connId));
      for (const r of requests) seen.current.add(r.connId);
      return;
    }

    const fresh = requests.filter((r) => !seen.current.has(r.connId));
    if (fresh.length === 0) return;

    for (const r of fresh) seen.current.add(r.connId);
    saveSeen(seen.current);
    setToasts((prev) => [...prev, ...fresh.map((r) => r.connId)]);
  }, [requests, user]);

  const dismiss = (connId: string) => {
    setDismissing((prev) => new Set(prev).add(connId));
    setTimeout(() => {
      setToasts((prev) => prev.filter((id) => id !== connId));
      setDismissing((prev) => {
        const next = new Set(prev);
        next.delete(connId);
        return next;
      });
    }, 200);
  };

  const accept = async (connId: string) => {
    dismiss(connId);
    await acceptFriendRequest(connId);
  };

  const decline = async (connId: string) => {
    dismiss(connId);
    await declineFriendRequest(connId);
  };

  if (!user) return null;

  const visible = toasts
    .map((connId) => requests.find((r) => r.connId === connId))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);

  if (visible.length === 0) return null;

  return (
    <div className="fixed top-24 right-6 z-[120] flex flex-col gap-3 max-w-sm w-full">
      <AnimatePresence>
        {visible.map((req) => (
          <motion.div
            key={req.connId}
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={
              dismissing.has(req.connId)
                ? { opacity: 0, scale: 0.9, y: -20 }
                : { opacity: 1, x: 0, scale: 1 }
            }
            exit={{ opacity: 0, scale: 0.9, y: -20 }}
            className="glass-solid p-4 rounded-2xl shadow-2xl border border-red-500/50 relative overflow-hidden"
          >
            <div className="absolute top-0 left-0 w-1 h-full bg-red-500" />
            <div className="flex items-start gap-4">
              <div className="bg-red-500/20 p-3 rounded-xl">
                <UserPlus size={24} className="text-red-400" />
              </div>
              <div className="flex-1">
                <h4 className="text-white font-bold">{req.displayName}</h4>
                <p className="text-text-muted text-sm mb-3">Sent you a friend request</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => accept(req.connId)}
                    className="flex-1 bg-primary hover:bg-primary/80 text-white font-bold py-2 px-4 rounded-xl text-sm transition-colors flex justify-center items-center gap-2"
                  >
                    <Check size={16} /> Accept
                  </button>
                  <button
                    onClick={() => decline(req.connId)}
                    aria-label="Decline friend request"
                    className="p-2 bg-white/5 hover:bg-white/10 text-text-muted hover:text-white rounded-xl transition-colors"
                  >
                    <X size={20} />
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
