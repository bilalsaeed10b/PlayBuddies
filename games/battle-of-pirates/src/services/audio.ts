/**
 * Every sound in the game, synthesised.
 *
 * Not one audio file ships with this bundle. A sea battle needs a boom, a
 * splinter, a splash and some surf, and a handful of oscillators over a noise
 * buffer weigh nothing next to four MP3s, load instantly and never 404 -- on a
 * phone on a bad connection that is the difference between a game with sound
 * and a game with a spinner.
 *
 * The context is created lazily because browsers refuse to start one outside a
 * user gesture, and one created on page load just sits suspended forever.
 */
class AudioService {
  private ctx: AudioContext | null = null;
  private bed: GainNode | null = null;
  private sfx: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private surf: AudioBufferSourceNode | null = null;
  private levels = { bgm: 0.3, sfx: 0.7 };

  private ready(): AudioContext | null {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      try {
        this.ctx = new Ctor();
      } catch {
        return null;
      }
      this.bed = this.ctx.createGain();
      this.sfx = this.ctx.createGain();
      this.bed.gain.value = this.levels.bgm * 0.5;
      this.sfx.gain.value = this.levels.sfx;
      this.bed.connect(this.ctx.destination);
      this.sfx.connect(this.ctx.destination);
      this.noise = this.makeNoise(this.ctx);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** Two seconds of white noise, reused by every percussive sound in the game. */
  private makeNoise(ctx: AudioContext): AudioBuffer | null {
    try {
      const frames = ctx.sampleRate * 2;
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
      return buffer;
    } catch {
      return null;
    }
  }

  setVolumes(bgm: number, sfx: number) {
    this.levels = { bgm, sfx };
    if (!this.ctx) return;
    this.bed?.gain.setTargetAtTime(bgm * 0.5, this.ctx.currentTime, 0.15);
    this.sfx?.gain.setTargetAtTime(sfx, this.ctx.currentTime, 0.1);
    if (bgm <= 0.001) this.stopSurf();
    else this.startSurf();
  }

  /** Called from a click handler, which is the only moment a context may start. */
  unlock() {
    this.ready();
    if (this.levels.bgm > 0.001) this.startSurf();
  }

  /**
   * The sea, under everything.
   *
   * Filtered noise with a slow swell on the gain. It is four nodes and it
   * costs nothing, and without it the gaps between turns are silent in a way
   * that makes the whole scene feel like a screenshot.
   */
  private startSurf() {
    const ctx = this.ready();
    if (!ctx || !this.bed || !this.noise || this.surf) return;
    try {
      const source = ctx.createBufferSource();
      source.buffer = this.noise;
      source.loop = true;

      const band = ctx.createBiquadFilter();
      band.type = 'lowpass';
      band.frequency.value = 520;
      band.Q.value = 0.4;

      const swell = ctx.createGain();
      swell.gain.value = 0.16;

      // A slow LFO on the swell, so the surf breathes instead of hissing.
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 0.13;
      lfoGain.gain.value = 0.09;
      lfo.connect(lfoGain);
      lfoGain.connect(swell.gain);

      source.connect(band);
      band.connect(swell);
      swell.connect(this.bed);
      source.start();
      lfo.start();
      this.surf = source;
    } catch {
      /* no surf, still a game */
    }
  }

  private stopSurf() {
    try {
      this.surf?.stop();
    } catch {
      /* already stopped */
    }
    this.surf = null;
  }

  private tone(
    type: OscillatorType,
    from: number,
    to: number,
    dur: number,
    gain: number,
    curve: 'exp' | 'lin' = 'exp',
    delay = 0,
  ) {
    const ctx = this.ready();
    if (!ctx || !this.sfx) return;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    const t = ctx.currentTime + delay;

    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    else osc.frequency.linearRampToValueAtTime(to, t + dur);

    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.005);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(amp);
    amp.connect(this.sfx);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  /** A shaped burst of the noise buffer: the basis of every impact in the game. */
  private hiss(dur: number, gain: number, from: number, to: number, type: BiquadFilterType = 'lowpass', delay = 0) {
    const ctx = this.ready();
    if (!ctx || !this.sfx || !this.noise) return;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    const amp = ctx.createGain();
    const t = ctx.currentTime + delay;

    filter.type = type;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), t + dur);

    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    source.connect(filter);
    filter.connect(amp);
    amp.connect(this.sfx);
    // A random offset into two seconds of noise, so ten cannon shots are not
    // ten identical cannon shots.
    source.start(t, Math.random() * 1.5, dur + 0.05);
  }

  /** The cannon. `power` is the charge that went into it, 0 to 1. */
  playFire(power: number) {
    const p = Math.max(0.2, Math.min(1, power));
    this.hiss(0.4 + p * 0.25, 0.55 * p + 0.2, 900, 90);
    this.tone('sine', 150 * (1.1 - p * 0.3), 34, 0.42, 0.42, 'exp');
    this.tone('square', 90, 40, 0.13, 0.13);
  }

  /** Timber. Heavier the harder it lands. */
  playHull(power: number) {
    const p = Math.max(0.2, Math.min(1, power));
    this.hiss(0.26, 0.35 * p + 0.12, 2600, 260, 'bandpass');
    this.tone('triangle', 220 - p * 90, 60, 0.24, 0.3);
    if (p > 0.7) this.tone('sawtooth', 620, 130, 0.16, 0.12, 'exp', 0.02);
  }

  playSplash() {
    this.hiss(0.42, 0.24, 4200, 700, 'highpass');
    this.tone('sine', 420, 150, 0.16, 0.08);
  }

  playRock() {
    this.hiss(0.2, 0.3, 3400, 900, 'bandpass');
    this.tone('square', 300, 110, 0.1, 0.1);
  }

  playBurn() {
    this.hiss(0.5, 0.14, 1800, 420, 'bandpass');
  }

  playSink() {
    this.hiss(0.9, 0.3, 1400, 120);
    [200, 160, 120, 84].forEach((f, i) => this.tone('triangle', f, f * 0.7, 0.5, 0.2, 'exp', i * 0.16));
  }

  playDeal() {
    this.hiss(0.09, 0.16, 5200, 1400, 'bandpass');
  }

  playPop() {
    this.tone('sine', 660, 1240, 0.08, 0.14);
  }

  playEnd(won: boolean) {
    const notes = won ? [392, 523, 659, 784] : [392, 330, 262, 196];
    notes.forEach((f, i) => this.tone('triangle', f, f, 0.26, 0.2, 'lin', i * 0.15));
  }
}

export const audioService = new AudioService();
