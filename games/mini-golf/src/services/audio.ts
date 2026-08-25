/**
 * Every sound in the game, synthesised.
 *
 * A handful of short noises made of oscillators and shaped noise — no
 * audio files, so there is nothing to download, nothing to decode on a cold
 * start, and nothing to keep in sync with the bundle. A golf course is a quiet
 * place with a few sharp sounds in it; that is a cheaper palette to fake than
 * a sea or a crowd.
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

  /** The click of the club. Pitch rises a little with how hard it was hit. */
  playPutt(power: number) {
    const p = Math.max(0, Math.min(1, power));
    this.knock(0, 0.05, 0.35 + p * 0.3, 3600 + p * 2600);
    this.tone(520 + p * 380, 0, 0.05, 0.09, 'triangle');
  }

  /** Ball off the boards. Duller and lower than the club. */
  playWall() {
    this.knock(0, 0.1, 0.4, 1200);
    this.tone(190, 0, 0.1, 0.1, 'square');
  }

  /** Into the cup: two descending notes, because it is the good one. */
  playDrop() {
    this.tone(680, 0, 0.09, 0.12, 'sine');
    this.tone(430, 0.06, 0.16, 0.13, 'sine');
    this.knock(0.03, 0.09, 0.28, 900);
  }

  /** Into the water. Filtered noise with the cutoff sliding down. */
  playSplash() {
    this.knock(0, 0.3, 0.5, 900);
    this.tone(300, 0, 0.22, 0.07, 'sine');
    this.tone(170, 0.08, 0.24, 0.06, 'sine');
  }

  /** Into a bunker. All thud, no ring. */
  playSand() {
    this.knock(0, 0.16, 0.42, 620);
  }

  /** A selection, a shop purchase, a mode switch. */
  playPop() {
    this.tone(660, 0, 0.07, 0.11, 'triangle');
    this.tone(990, 0.03, 0.08, 0.07, 'triangle');
  }

  /** Your turn has come round. Deliberately soft; it fires a lot. */
  playTurn() {
    this.tone(560, 0, 0.11, 0.06, 'sine');
    this.tone(840, 0.06, 0.12, 0.045, 'sine');
  }

  playEnd(won: boolean) {
    const notes = won ? [523, 659, 784, 1047] : [440, 392, 330, 262];
    notes.forEach((f, i) => this.tone(f, i * 0.11, 0.3, 0.14, 'triangle'));
  }
}

export const audioService = new AudioService();
