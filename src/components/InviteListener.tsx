"use client";

import { useEffect, useState } from "react";
import { db } from "@/lib/firebase";
import { collection, query, where, onSnapshot, doc, deleteDoc } from "firebase/firestore";
import { useAuthStore } from "@/store/useAuthStore";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { MessageCircle, X, Check } from "lucide-react";

const INVITE_TTL_MS = 60_000;

interface Invite {
  id: string;
  fromUid: string;
  fromName: string;
  roomId: string;
  createdAt: number;
}

export default function InviteListener() {
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const [allInvites, setInvites] = useState<Invite[]>(() => []);
  const invites = user ? allInvites : [];

  useEffect(() => {
    if (!user) return;

    const q = query(collection(db, "invites"), where("targetId", "==", user.uid));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const now = Date.now();
        const active: Invite[] = [];

        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          const createdAt = data.createdAt ?? data.timestamp ?? 0;
          if (now - createdAt > INVITE_TTL_MS) {
            // Recipient-side cleanup. Invites for users who never sign in again
            // are swept by the scheduled cleanup, not from here.
            deleteDoc(doc(db, "invites", docSnap.id)).catch(() => {});
          } else {
            active.push({
              id: docSnap.id,
              fromUid: data.fromUid,
              fromName: data.fromName || "A friend",
              roomId: data.roomId,
              createdAt,
            });
          }
        });

        active.sort((a, b) => b.createdAt - a.createdAt);
        setInvites(active);
      },
      (e) => console.error("Invite listener failed", e),
    );

    return () => unsubscribe();
  }, [user]);

  // Expire invites on screen without needing another server round trip.
  useEffect(() => {
    if (invites.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setInvites((prev) => prev.filter((i) => now - i.createdAt <= INVITE_TTL_MS));
    }, 5000);
    return () => clearInterval(timer);
  }, [invites.length]);

  const acceptInvite = async (invite: Invite) => {
    setInvites((prev) => prev.filter((i) => i.id !== invite.id));
    deleteDoc(doc(db, "invites", invite.id)).catch(() => {});
    router.push(`/lobby?room=${invite.roomId}`);
  };

  const declineInvite = async (inviteId: string) => {
    setInvites((prev) => prev.filter((i) => i.id !== inviteId));
    deleteDoc(doc(db, "invites", inviteId)).catch(() => {});
  };

  if (!user || invites.length === 0) return null;

  return (
    <div className="fixed top-24 right-6 z-[120] flex flex-col gap-3 max-w-sm w-full">
      <AnimatePresence>
        {invites.map((invite) => (
          <motion.div
            key={invite.id}
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, y: -20 }}
            className="glass-solid bg-[#161626] p-4 rounded-2xl shadow-2xl border border-primary/50 relative overflow-hidden"
          >
            <div className="absolute top-0 left-0 w-1 h-full bg-primary" />
            <div className="flex items-start gap-4">
              <div className="bg-primary/20 p-3 rounded-xl">
                <MessageCircle size={24} className="text-primary" />
              </div>
              <div className="flex-1">
                <h4 className="text-white font-bold">{invite.fromName}</h4>
                <p className="text-text-muted text-sm mb-3">Invited you to play!</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => acceptInvite(invite)}
                    className="flex-1 bg-primary hover:bg-primary/80 text-white font-bold py-2 px-4 rounded-xl text-sm transition-colors flex justify-center items-center gap-2"
                  >
                    <Check size={16} /> Join
                  </button>
                  <button
                    onClick={() => declineInvite(invite.id)}
                    aria-label="Decline invite"
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
