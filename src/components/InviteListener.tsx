"use client";

import { useEffect, useState } from "react";
import { onChildAdded, ref, remove } from "firebase/database";
import { rtdb } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import { motion, AnimatePresence } from "framer-motion";
import { Gamepad2, X, Check } from "lucide-react";
import { useRouter } from "next/navigation";

export default function InviteListener() {
  const { user } = useAuthStore();
  const router = useRouter();
  const [invites, setInvites] = useState<any[]>([]);

  useEffect(() => {
    if (!user) return;

    const invitesRef = ref(rtdb, `invites/${user.uid}`);
    
    // Listen for new invites
    const unsub = onChildAdded(invitesRef, (snap) => {
      const data = snap.val();
      const inviteId = snap.key;
      
      // Ignore very old invites (e.g. older than 5 minutes)
      if (Date.now() - data.timestamp > 5 * 60 * 1000) {
        remove(ref(rtdb, `invites/${user.uid}/${inviteId}`));
        return;
      }

      setInvites(prev => [...prev, { ...data, inviteId }]);

      // Auto-remove invite UI after 30 seconds
      setTimeout(() => {
        setInvites(prev => prev.filter(i => i.inviteId !== inviteId));
        remove(ref(rtdb, `invites/${user.uid}/${inviteId}`)).catch(() => {});
      }, 30000);
    });

    return () => unsub();
  }, [user]);

  const acceptInvite = async (inviteId: string, roomId: string) => {
    if (!user) return;
    setInvites(prev => prev.filter(i => i.inviteId !== inviteId));
    await remove(ref(rtdb, `invites/${user.uid}/${inviteId}`));
    router.push(`/lobby?room=${roomId}`);
  };

  const declineInvite = async (inviteId: string) => {
    if (!user) return;
    setInvites(prev => prev.filter(i => i.inviteId !== inviteId));
    await remove(ref(rtdb, `invites/${user.uid}/${inviteId}`));
  };

  if (!user || invites.length === 0) return null;

  return (
    <div className="fixed top-24 right-6 z-[120] flex flex-col gap-4">
      <AnimatePresence>
        {invites.map(invite => (
          <motion.div
            key={invite.inviteId}
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 50, scale: 0.9 }}
            className="glass-solid p-4 rounded-2xl shadow-2xl border-2 border-primary/50 w-80 relative overflow-hidden flex flex-col gap-3"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-primary/10 to-transparent pointer-events-none" />
            
            <div className="flex items-center gap-3 relative z-10">
              <div className="p-2 bg-primary/20 rounded-full text-primary">
                <Gamepad2 size={24} />
              </div>
              <div className="flex-1">
                <h4 className="text-white font-bold text-sm">Game Invite</h4>
                <p className="text-xs text-text-muted"><span className="text-white font-bold">{invite.fromName}</span> invited you</p>
              </div>
            </div>

            <div className="flex gap-2 relative z-10">
              <button 
                onClick={() => declineInvite(invite.inviteId)}
                className="flex-1 py-1.5 flex items-center justify-center gap-1 rounded-lg text-xs font-bold bg-white/5 hover:bg-white/10 text-white transition-colors"
              >
                <X size={14} /> Decline
              </button>
              <button 
                onClick={() => acceptInvite(invite.inviteId, invite.roomId)}
                className="flex-1 py-1.5 flex items-center justify-center gap-1 rounded-lg text-xs font-bold bg-primary hover:bg-accent text-white transition-colors"
              >
                <Check size={14} /> Accept
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
