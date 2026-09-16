/**
 * Recent chat text per sender, each clearing itself a few seconds after it
 * arrives. The only state a bubble layer needs , where to draw it, and how
 * the words got here, both stay with the caller since those are the two
 * things that differ in every game.
 */
import { useCallback, useRef, useState } from 'react';
import { SPEECH_BUBBLE_LIFETIME_MS } from '../ui/SpeechBubble';

export function useBubbleFeed() {
  const [bubbles, setBubbles] = useState<Record<string, string>>({});
  // Per-key generation counter, so a message that arrives while an older one
  // from the same sender is still fading out doesn't get clobbered by that
  // older message's own expiry timer firing after it.
  const gen = useRef<Record<string, number>>({});

  const show = useCallback((key: string, text: string) => {
    const my = (gen.current[key] ?? 0) + 1;
    gen.current[key] = my;
    setBubbles((prev) => ({ ...prev, [key]: text }));
    window.setTimeout(() => {
      if (gen.current[key] !== my) return;
      setBubbles((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }, SPEECH_BUBBLE_LIFETIME_MS);
  }, []);

  return { bubbles, show };
}
