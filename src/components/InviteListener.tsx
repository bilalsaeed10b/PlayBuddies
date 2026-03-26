"use client";

import { useEffect, useState } from "react";
import { rtdb } from "@/lib/firebase";
import { ref, onChildAdded, onValue, remove, child } from "firebase/database";
import { useAuthStore } from "@/store/useAuthStore";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { MessageCircle, X, Check } from "lucide-react";

export default function InviteListener() {
  const { user } = useAuthStore();
  const router = useRouter();
  const [invites, setInvites] = useState<any[]>([]);

  useEffect(() => {
    if (!user) return;

    const invitesRef = ref(rtdb, `invites/${user.uid}`);
    
    const unsubscribe = onChildAdded(invitesRef, (snapshot) => {
      const inviteData = snapshot.val();
      const inviteKey = snapshot.key;
      
      if (!inviteData) return;
      
      // Auto-ignore old invites (older than 1 minute)
      if (Date.now() - inviteData.timestamp > 60000) {
        remove(ref(rtdb, `invites/${user.uid}/${inviteKey}`));
        return;
      }

      setInvites(prev => [...prev, { id: inviteKey, ...inviteData }]);
      
      // Auto-remove visually after 15 seconds
      setTimeout(() => {
        setInvites(prev => prev.filter(i => i.id !== inviteKey));
        remove(ref(rtdb, `invites/${user.uid}/${inviteKey}`)).catch(() => {});
      }, 15000);
    });

    return () => unsubscribe();
  }, [user]);

  const acceptInvite = (invite: any) => {
    // Remove from UI
    setInvites(prev => prev.filter(i => i.id !== invite.id));
    // Remove from DB
    remove(ref(rtdb, `invites/${user?.uid}/${invite.id}`));
    
    // Navigate to lobby
    router.push(`/lobby?room=${invite.roomId}`);
  };

  const declineInvite = (inviteId: string) => {
    setInvites(prev => prev.filter(i => i.id !== inviteId));
    remove(ref(rtdb, `invites/${user?.uid}/${inviteId}`));
  };

  if (!user || invites.length === 0) return null;

  return (
    <div className="fixed top-24 right-6 z-[120] flex flex-col gap-3 max-w-sm w-full">
      <AnimatePresence>
        {invites.map(invite => (
          <motion.div
            key={invite.id}
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, y: -20 }}
            className="glass-solid p-4 rounded-2xl shadow-2xl border border-primary/50 relative overflow-hidden"
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
