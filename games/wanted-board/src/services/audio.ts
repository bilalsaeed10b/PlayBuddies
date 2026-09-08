/**
 * Every sound in the game, synthesised.
 *
 * Six short noises made of oscillators and one burst of shaped noise — no
 * audio files, so there is nothing to download, nothing to decode on a cold
 * start, and nothing to keep in sync with the bundle. The whole board is
 * quiet wood and clacking pieces; that is a cheaper palette to fake than a
 * sea or a crowd.
 */

class AudioService {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private volume = 0.7;

  /**
   * Browsers refuse to start an AudioContext outside a real gesture, so this
   * is called from the first tap or key press rather than on load. Calling it
   * again afterwards is free.
   */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    } catch {
      /* no audio on this device; the game is perfectly playable silent */
    }
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  private tone(freq: number, at: number, len: number, gain: number, type: OscillatorType = 'sine') {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.volume <= 0) return;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.connect(env);
    env.connect(this.master);
    osc.start(t);
    osc.stop(t + len + 0.02);
  }

  /** Shaped noise — the wood in "a wall going into a groove". */
  private knock(at: number, len: number, gain: number, cutoff: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.volume <= 0) return;
    const t = ctx.currentTime + at;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * len));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 3;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const env = ctx.createGain();
    env.gain.value = gain;
    src.connect(filter);
    filter.connect(env);
    env.connect(this.master);
    src.start(t);
  }


  /** A card turned face down onto the table. */
  playLock() {
    this.knock(0, 0.07, 0.42, 2400);
    this.tone(320, 0.01, 0.06, 0.05, 'triangle');
  }

  /** A hoofbeat, for somebody riding out. */
  playRide() {
    this.knock(0, 0.06, 0.35, 900);
    this.knock(0.07, 0.05, 0.24, 780);
  }

  /** A shot: the ambush landing. */
  playShot() {
    this.knock(0, 0.16, 0.9, 5200);
    this.tone(90, 0, 0.14, 0.28, 'square');
  }

  /** A trap springing — tighter and meaner than a shot, and half the money. */
  playSnap() {
    this.knock(0, 0.08, 0.7, 3800);
    this.tone(180, 0, 0.07, 0.14, 'sawtooth');
  }

  /** A hammer clicking on nothing. Somebody ambushed an empty room. */
  playMiss() {
    this.knock(0, 0.04, 0.35, 1800);
    this.tone(140, 0.03, 0.05, 0.06, 'square');
  }

  /** Coins into the vault. */
  playBank() {
    this.tone(880, 0, 0.09, 0.1, 'triangle');
    this.tone(1320, 0.06, 0.1, 0.08, 'triangle');
    this.tone(1760, 0.13, 0.16, 0.06, 'triangle');
  }

  /** The round's cards flipping over, one per player. */
  playFlip() {
    this.knock(0, 0.05, 0.3, 3200);
  }

  playPop() {
    this.tone(660, 0, 0.07, 0.09, 'triangle');
  }

  /** Somebody won the night. */
  playEnd(won: boolean) {
    if (won) {
      this.tone(523, 0, 0.16, 0.11, 'triangle');
      this.tone(659, 0.1, 0.16, 0.11, 'triangle');
      this.tone(784, 0.2, 0.3, 0.11, 'triangle');
    } else {
      this.tone(392, 0, 0.2, 0.09, 'sine');
      this.tone(294, 0.16, 0.36, 0.09, 'sine');
    }
  }
}

export const audioService = new AudioService();
