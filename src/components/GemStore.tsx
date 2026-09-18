"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Gem, Target, X } from "lucide-react";
import { DAILY_CHALLENGE_CAP, GEMS_PER_CHALLENGE } from "@/lib/challenges";

/**
 * What the gem packs will cost.
 *
 * Shown but not sold yet. Taking real money needs a payment provider and a
 * server of our own to confirm each payment before a single gem is credited
 * , a static site that credited gems from the browser would be crediting
 * whoever edited the request, not whoever paid. Until that exists the buttons
 * say so, rather than pretending.
 */
const PACKS = [
  { gems: 20, price: "$0.99", label: "Handful" },
  { gems: 110, price: "$4.99", label: "Pouch", bonus: "+10%" },
  { gems: 240, price: "$9.99", label: "Chest", bonus: "+20%" },
  { gems: 650, price: "$24.99", label: "Vault", bonus: "+30%" },
];

/** The balance chip for a nav bar. */
export function GemBalance({ gems, onClick }: { gems: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-2xl border border-cyan-300/25 bg-cyan-400/10 px-3 py-2 text-sm font-black text-white transition-colors hover:bg-cyan-400/20"
      aria-label={`${gems} gems. Open the gem store`}
    >
      <Gem size={16} className="text-cyan-300" />
      {gems}
    </button>
  );
}

export default function GemStore({
  open,
  gems,
  onClose,
}: {
  open: boolean;
  gems: number;
  onClose: () => void;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 12 }}
            onClick={(e) => e.stopPropagation()}
            className="relative max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-[#141424] p-6 shadow-2xl"
          >
            <button
              onClick={onClose}
              className="absolute right-4 top-4 rounded-xl p-2 text-text-muted hover:bg-white/5 hover:text-white"
              aria-label="Close"
            >
              <X size={18} />
            </button>

            <div className="mb-6 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-400 to-violet-500">
                <Gem size={24} className="text-white" />
              </div>
              <div>
                <h2 className="text-xl font-black text-white">Gems</h2>
                <p className="text-sm text-text-muted">
                  You have <span className="font-bold text-white">{gems}</span>
                </p>
              </div>
            </div>

            <div className="mb-6 rounded-2xl border border-cyan-300/20 bg-cyan-400/[0.06] p-4">
              <p className="mb-1 flex items-center gap-2 text-sm font-bold text-white">
                <Target size={16} className="text-cyan-300" /> Earn them free
              </p>
              <p className="text-sm text-text-muted">
                Every game has a daily challenge. Finish any {DAILY_CHALLENGE_CAP} a day for {GEMS_PER_CHALLENGE} gems
                each, up to {DAILY_CHALLENGE_CAP * GEMS_PER_CHALLENGE} a day.
              </p>
            </div>

            <p className="mb-3 text-xs font-black uppercase tracking-[0.18em] text-text-muted">Buy gems</p>
            <div className="grid grid-cols-2 gap-3">
              {PACKS.map((p) => (
                <div key={p.label} className="relative flex flex-col items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-center">
                  {p.bonus && (
                    <span className="absolute right-2 top-2 rounded-full bg-violet-500/80 px-2 py-0.5 text-[10px] font-black text-white">
                      {p.bonus}
                    </span>
                  )}
                  <Gem size={22} className="text-cyan-300" />
                  <p className="text-lg font-black text-white">{p.gems}</p>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-text-muted">{p.label}</p>
                  <button
                    disabled
                    className="mt-2 w-full cursor-not-allowed rounded-xl bg-white/10 py-2 text-sm font-bold text-white/60"
                    title="Purchases are not live yet"
                  >
                    {p.price}
                  </button>
                </div>
              ))}
            </div>
            <p className="mt-4 text-center text-xs text-text-muted">
              Purchases aren&apos;t live yet. They open once secure payments are set up.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
