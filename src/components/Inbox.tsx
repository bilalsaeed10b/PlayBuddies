"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, Bug, Check, Coins, Gift, Sparkles, X } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import { BADGES_BY_ID } from "@/lib/badges";
import { markAllRead, markRead, watchInbox, type InboxMessage } from "@/lib/inbox";
import { BadgeIcon } from "@/components/BadgeChip";

/**
 * The player's side of everything an admin does to their account.
 *
 * Two surfaces over one subscription: a bell that carries the unread count,
 * and a one-time popup the first time an unread message is seen in a session.
 * The popup exists because the messages that land here are rewards , coins
 * for a bug someone actually went and found , and a reward nobody notices is
 * not much of a reward.
 */
export default function Inbox() {
  const { user } = useAuthStore();
  // Keyed on the uid so signing in as someone else throws the whole thing
  // away rather than needing an effect to reset each piece of state , which
  // is also the difference between a clean subscription and one that briefly
  // shows the last account's messages to the new one.
  if (!user) return null;
  return <InboxFor key={user.uid} uid={user.uid} />;
}

function InboxFor({ uid }: { uid: string }) {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [open, setOpen] = useState(false);
  const [popup, setPopup] = useState<InboxMessage[] | null>(null);
  // A ref, not state: this must not cause a render of its own, and the first
  // snapshot to arrive is the only one that can ever set it.
  const greeted = useRef(false);

  useEffect(() => {
    return watchInbox(
      uid,
      (list) => {
        setMessages(list);
        // Once per sign-in, for whatever was already waiting. A message that
        // lands while the player is sitting on the page gets the bell's
        // unread count, not a modal thrown over what they were doing.
        if (!greeted.current) {
          greeted.current = true;
          const unread = list.filter((m) => !m.read);
          if (unread.length > 0) setPopup(unread.slice(0, 3));
        }
      },
      (e) => console.error("Inbox read failed", e),
    );
  }, [uid]);

  const unreadCount = messages.filter((m) => !m.read).length;

  const dismissPopup = async () => {
    const shown = popup ?? [];
    setPopup(null);
    try {
      for (const m of shown) await markRead(uid, m.id);
    } catch (e) {
      console.error("Could not mark those read", e);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={unreadCount > 0 ? `Inbox, ${unreadCount} unread` : "Inbox"}
        className="relative w-10 h-10 rounded-xl hover:bg-white/10 flex items-center justify-center text-text-secondary transition-colors"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-black flex items-center justify-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <InboxPanel
            messages={messages}
            onClose={() => setOpen(false)}
            onReadAll={() => markAllRead(uid, messages).catch(() => {})}
            onRead={(id) => markRead(uid, id).catch(() => {})}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {popup && popup.length > 0 && (
          <RewardPopup messages={popup} onClose={dismissPopup} onOpenInbox={() => {
            void dismissPopup();
            setOpen(true);
          }} />
        )}
      </AnimatePresence>
    </>
  );
}

function InboxPanel({
  messages,
  onClose,
  onRead,
  onReadAll,
}: {
  messages: InboxMessage[];
  onClose: () => void;
  onRead: (id: string) => void;
  onReadAll: () => void;
}) {
  const unread = messages.filter((m) => !m.read).length;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-[75] bg-black/70 backdrop-blur-sm flex items-start justify-center p-4 pt-20"
    >
      <motion.div
        initial={{ opacity: 0, y: -16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -16, scale: 0.97 }}
        onClick={(e) => e.stopPropagation()}
        className="glass-solid bg-[#141423] w-full max-w-md rounded-3xl border border-white/10 shadow-2xl max-h-[70vh] flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              <Bell size={17} className="text-white" />
            </div>
            <div>
              <p className="font-black text-white leading-tight">Inbox</p>
              <p className="text-[11px] text-text-muted">
                {unread > 0 ? `${unread} unread` : "Nothing new"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {unread > 0 && (
              <button
                onClick={onReadAll}
                className="px-2.5 py-1.5 rounded-lg hover:bg-white/10 text-[11px] font-bold text-text-secondary"
              >
                Mark all read
              </button>
            )}
            <button
              onClick={onClose}
              aria-label="Close"
              className="w-9 h-9 rounded-xl hover:bg-white/10 flex items-center justify-center text-text-muted"
            >
              <X size={17} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-3 space-y-2">
          {messages.length === 0 ? (
            <div className="py-12 text-center">
              <Bell size={32} className="mx-auto text-text-muted/40 mb-3" />
              <p className="text-sm text-text-secondary">Nothing here yet.</p>
              <p className="text-[11px] text-text-muted mt-1">
                Rewards, badges and approved bug reports land here.
              </p>
            </div>
          ) : (
            messages.map((m) => (
              <button
                key={m.id}
                onClick={() => !m.read && onRead(m.id)}
                className={`w-full text-left flex gap-3 rounded-2xl border p-3 transition-colors ${
                  m.read
                    ? "border-white/5 bg-white/[0.02]"
                    : "border-primary/30 bg-primary/5 hover:bg-primary/10"
                }`}
              >
                <MessageIcon message={m} />
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-sm leading-tight ${m.read ? "text-text-secondary font-bold" : "text-white font-black"}`}
                  >
                    {m.title}
                  </p>
                  <p className="text-[11px] text-text-muted mt-0.5 leading-relaxed">{m.body}</p>
                </div>
                {!m.read && <span className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1.5" />}
              </button>
            ))
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

/** The one that interrupts: what was waiting when they signed in. */
function RewardPopup({
  messages,
  onClose,
  onOpenInbox,
}: {
  messages: InboxMessage[];
  onClose: () => void;
  onOpenInbox: () => void;
}) {
  const coins = messages.filter((m) => m.kind === "coins").reduce((n, m) => n + (m.amount ?? 0), 0);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[90] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        onClick={(e) => e.stopPropagation()}
        className="glass-solid bg-[#141423] w-full max-w-sm rounded-3xl border border-white/10 shadow-2xl p-6 text-center"
      >
        <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-amber-400 to-yellow-500 flex items-center justify-center mb-4">
          <Gift size={30} className="text-black" />
        </div>
        <h2 className="text-xl font-black text-white">
          {coins > 0 ? `You received ${coins.toLocaleString()} coins` : "You have something waiting"}
        </h2>
        <p className="text-xs text-text-muted mt-1">
          {messages.length === 1 ? "While you were away" : `${messages.length} new messages`}
        </p>

        <div className="mt-5 space-y-2 text-left">
          {messages.map((m) => (
            <div key={m.id} className="flex gap-3 rounded-2xl bg-white/5 p-3">
              <MessageIcon message={m} />
              <div className="min-w-0">
                <p className="text-sm font-bold text-white leading-tight">{m.title}</p>
                <p className="text-[11px] text-text-muted mt-0.5 leading-relaxed">{m.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            onClick={onOpenInbox}
            className="rounded-2xl border border-white/15 bg-white/5 py-3 text-sm font-bold text-white/80"
          >
            Open inbox
          </button>
          <button
            onClick={onClose}
            className="rounded-2xl bg-gradient-to-r from-amber-400 to-yellow-500 py-3 text-sm font-black text-black"
          >
            Nice
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function MessageIcon({ message }: { message: InboxMessage }) {
  if (message.kind === "badge") {
    const badge = BADGES_BY_ID[message.badgeId];
    if (badge) {
      return (
        <div
          className={`w-9 h-9 rounded-xl shrink-0 flex items-center justify-center bg-gradient-to-br ${badge.color}`}
        >
          <BadgeIcon name={badge.icon} size={18} />
        </div>
      );
    }
    return <Icon tone="from-amber-400 to-yellow-500" node={<Sparkles size={17} />} />;
  }
  if (message.kind === "coins") {
    return <Icon tone="from-amber-400 to-orange-500" node={<Coins size={17} />} />;
  }
  if (message.kind === "bug") {
    return <Icon tone="from-lime-400 to-emerald-500" node={<Bug size={17} />} />;
  }
  return <Icon tone="from-primary to-accent" node={<Check size={17} />} />;
}

function Icon({ tone, node }: { tone: string; node: React.ReactNode }) {
  return (
    <div
      className={`w-9 h-9 rounded-xl shrink-0 flex items-center justify-center bg-gradient-to-br ${tone} text-black`}
    >
      {node}
    </div>
  );
}
