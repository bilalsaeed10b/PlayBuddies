"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import { cleanGems, cleanState, dayKey, type ChallengeState } from "@/lib/challenges";

export interface GemAccount {
  gems: number;
  challenges: ChallengeState;
  loading: boolean;
}

/**
 * The signed-in player's gem balance and today's challenge record, live.
 *
 * Live rather than read once, because both change from somewhere else: a
 * challenge finishes on the lobby page, an admin credits a purchase from the
 * panel. A balance that only refreshed on reload would read wrong at exactly
 * the moment somebody looks at it to check.
 *
 * The day is re-read on every snapshot and on a timer at UTC midnight, so a
 * dashboard left open overnight turns over to the new card on its own.
 */
export function useGemAccount(): GemAccount {
  const user = useAuthStore((s) => s.user);
  const [state, setState] = useState<{ gems: number; raw: unknown; loading: boolean }>({
    gems: 0,
    raw: null,
    loading: true,
  });
  const [day, setDay] = useState(dayKey);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(
      doc(db, "users", user.uid),
      (snap) => {
        const data = snap.data() ?? {};
        setState({ gems: cleanGems(data.gems), raw: data.challenges, loading: false });
        setDay(dayKey());
      },
      (err) => {
        console.error("Could not watch the gem balance:", err);
        setState((s) => ({ ...s, loading: false }));
      },
    );
  }, [user]);

  useEffect(() => {
    const now = new Date();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const t = setTimeout(() => setDay(dayKey()), next - now.getTime() + 1000);
    return () => clearTimeout(t);
  }, [day]);

  return { gems: state.gems, challenges: cleanState(state.raw, day), loading: state.loading };
}
