/**
 * Lightweight Web Audio notification sounds.
 * No audio files needed — synthesized entirely in JS.
 * All functions are no-ops when the browser has no AudioContext support.
 */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    } catch {
      return null;
    }
  }
  return ctx;
}

/**
 * Plays a short, soft "pop" — suitable for incoming chat messages.
 * Volume and duration are intentionally subtle so it doesn't startle.
 */
export function playPop(): void {
  const ac = getCtx();
  if (!ac) return;

  // Resume context if the browser suspended it (autoplay policy).
  if (ac.state === "suspended") {
    ac.resume().catch(() => {});
  }

  const now = ac.currentTime;

  const osc = ac.createOscillator();
  const gain = ac.createGain();

  osc.connect(gain);
  gain.connect(ac.destination);

  osc.type = "sine";
  // Start at 820 Hz and drop to 420 Hz — clear, punchy bubble pop that cuts through.
  osc.frequency.setValueAtTime(820, now);
  osc.frequency.exponentialRampToValueAtTime(420, now + 0.08);

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.55, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

  osc.start(now);
  osc.stop(now + 0.18);
}

/**
 * Plays a gentle two-tone chime — suitable for friend requests / invites.
 */
export function playChime(): void {
  const ac = getCtx();
  if (!ac) return;

  if (ac.state === "suspended") {
    ac.resume().catch(() => {});
  }

  const now = ac.currentTime;

  [[880, 0], [1100, 0.12]].forEach(([freq, delay]) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);

    osc.type = "sine";
    osc.frequency.value = freq;

    const t = now + delay;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.12, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

    osc.start(t);
    osc.stop(t + 0.35);
  });
}
