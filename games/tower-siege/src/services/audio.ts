/**
 * Sound, synthesised rather than shipped.
 *
 * A tower defence fires a great many times a second and none of those shots
 * deserve a network request. Everything here is a few oscillator nodes, which
 * costs nothing to download and lets a shot's pitch follow what fired it.
 *
 * The context is created on the first real gesture and never before: a browser
 * refuses one made at load, and a refused context is a game with no sound for
 * the rest of the session.
 */
class AudioService {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private volume = 0.7;
  /**
   * The last time each kind of sound played.
   *
   * Forty arrows landing in one frame is forty oscillators, which is both
   * inaudible as anything but a click and enough to stall a phone. One of each
   * kind per short window is all that is actually heard.
   */
  private last = new Map<string, number>();

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
      this.ctx = null;
    }
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  /** True if this kind has not played inside `gap` seconds. */
  private free(kind: string, gap: number): boolean {
    if (!this.ctx) return false;
    const now = this.ctx.currentTime;
    if ((this.last.get(kind) ?? -1) + gap > now) return false;
    this.last.set(kind, now);
    return true;
  }

  private blip(freq: number, dur: number, type: OscillatorType, gain: number, slideTo?: number) {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), now + dur);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  private noise(dur: number, gain: number, freq: number) {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    const frames = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start(now);
  }

  shoot() {
    if (!this.free('shoot', 0.05)) return;
    this.blip(760, 0.06, 'square', 0.05, 420);
  }

  boom() {
    if (!this.free('boom', 0.07)) return;
    this.noise(0.24, 0.16, 900);
    this.blip(90, 0.2, 'sine', 0.13, 40);
  }

  build() {
    this.blip(300, 0.09, 'triangle', 0.14, 560);
    this.blip(600, 0.13, 'sine', 0.08, 900);
  }

  sell() {
    this.blip(520, 0.1, 'triangle', 0.12, 240);
  }

  leak() {
    if (!this.free('leak', 0.12)) return;
    this.blip(200, 0.3, 'sawtooth', 0.14, 80);
  }

  clear() {
    this.blip(520, 0.12, 'sine', 0.13, 780);
    window.setTimeout(() => this.blip(780, 0.18, 'sine', 0.12, 1040), 90);
  }

  fall() {
    this.blip(180, 0.7, 'sawtooth', 0.18, 45);
    this.noise(0.7, 0.14, 500);
  }

  end(won: boolean) {
    const notes = won ? [523, 659, 784, 1047] : [440, 349, 262];
    notes.forEach((n, i) => window.setTimeout(() => this.blip(n, 0.3, 'triangle', 0.13), i * 130));
  }
}

export const audioService = new AudioService();
