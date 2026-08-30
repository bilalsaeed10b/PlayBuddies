/**
 * Every sound in the game, synthesised.
 *
 * A handful of short noises made of oscillators and one burst of shaped
 * noise — no audio files, so there is nothing to download, nothing to decode
 * on a cold start and nothing to keep in sync with the bundle. The palette
 * here is chalk on slate: dry taps and scrapes rather than anything warm.
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
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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

  /** Shaped noise — the chalk in "a line going onto a board". */
  private scrape(at: number, len: number, gain: number, cutoff: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.volume <= 0) return;
    const t = ctx.currentTime + at;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * len));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = cutoff;
    filter.Q.value = 0.7;
    const env = ctx.createGain();
    env.gain.value = gain;
    src.connect(filter);
    filter.connect(env);
    env.connect(this.master);
    src.start(t);
  }

  /** A letter that was there. Rises with how many copies it found. */
  playHit(copies = 1) {
    const base = 620;
    for (let i = 0; i < Math.min(copies, 4); i++) {
      this.tone(base * (1 + i * 0.26), i * 0.055, 0.11, 0.09, 'triangle');
    }
  }

  /** A letter that was not. One more line on the board. */
  playMiss() {
    this.scrape(0, 0.14, 0.5, 1900);
    this.tone(150, 0.01, 0.09, 0.07, 'square');
  }

  /** Somebody called the word and got it. */
  playSolve() {
    this.tone(523, 0, 0.13, 0.1, 'triangle');
    this.tone(659, 0.09, 0.13, 0.1, 'triangle');
    this.tone(880, 0.18, 0.26, 0.09, 'triangle');
  }

  /** Somebody called the word and did not get it. */
  playWrong() {
    this.tone(220, 0, 0.16, 0.11, 'sawtooth');
    this.tone(165, 0.12, 0.26, 0.09, 'sawtooth');
  }

  /** The last line. The drop. */
  playHang() {
    this.scrape(0, 0.3, 0.75, 900);
    this.tone(110, 0.02, 0.4, 0.2, 'sawtooth');
    this.tone(55, 0.14, 0.5, 0.16, 'sine');
  }

  /** A key press. */
  playTap() {
    this.tone(720, 0, 0.045, 0.055, 'triangle');
  }

  /** The clock running out from under somebody. */
  playTick() {
    this.tone(980, 0, 0.035, 0.05, 'square');
  }

  /** The match is done. */
  playEnd(won: boolean) {
    if (won) {
      this.tone(523, 0, 0.15, 0.11, 'triangle');
      this.tone(659, 0.1, 0.15, 0.11, 'triangle');
      this.tone(784, 0.2, 0.15, 0.11, 'triangle');
      this.tone(1046, 0.3, 0.34, 0.1, 'triangle');
    } else {
      this.tone(392, 0, 0.2, 0.09, 'sine');
      this.tone(294, 0.16, 0.4, 0.09, 'sine');
    }
  }
}

export const audioService = new AudioService();
