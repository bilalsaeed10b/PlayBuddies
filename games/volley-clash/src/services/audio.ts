/**
 * Every sound in the game, synthesised.
 *
 * Not a single audio file ships with this bundle. A volleyball needs four
 * noises — a bump, a spike, a whistle and a fanfare — and four oscillators
 * weigh nothing next to four MP3s, load instantly, and never 404.
 *
 * The context is created lazily because browsers refuse to start one before a
 * user gesture, and an AudioContext created on page load just sits suspended.
 */
class AudioService {
  private ctx: AudioContext | null = null;
  private bgm: GainNode | null = null;
  private sfx: GainNode | null = null;
  private levels = { bgm: 0.4, sfx: 0.7 };

  private ready(): AudioContext | null {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      this.bgm = this.ctx.createGain();
      this.sfx = this.ctx.createGain();
      this.bgm.gain.value = this.levels.bgm;
      this.sfx.gain.value = this.levels.sfx;
      this.bgm.connect(this.ctx.destination);
      this.sfx.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  setVolumes(bgm: number, sfx: number) {
    this.levels = { bgm, sfx };
    if (!this.ctx) return;
    this.bgm?.gain.setTargetAtTime(bgm, this.ctx.currentTime, 0.1);
    this.sfx?.gain.setTargetAtTime(sfx, this.ctx.currentTime, 0.1);
  }

  /** Called from a click handler so the context is allowed to start. */
  unlock() {
    this.ready();
  }

  private blip(
    type: OscillatorType,
    from: number,
    to: number,
    dur: number,
    gain: number,
    curve: 'exp' | 'lin' = 'exp',
  ) {
    const ctx = this.ready();
    if (!ctx || !this.sfx) return;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    const t = ctx.currentTime;

    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    else osc.frequency.linearRampToValueAtTime(to, t + dur);

    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.001, t + dur);

    osc.connect(amp);
    amp.connect(this.sfx);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /**
   * Contact. `power` is the charge that went into it, 0–1.
   *
   * A soft bump and a full spike are the same synth with a different pitch and
   * a different wave — which is exactly how they sound in real life, and it
   * means a player can hear how hard the other side hit it without looking.
   */
  playHit(power: number) {
    if (power > 0.6) {
      this.blip('square', 220, 60, 0.16, 0.28);
      this.blip('sawtooth', 900, 180, 0.12, 0.14);
    } else {
      this.blip('sine', 480 + power * 300, 200, 0.09, 0.2);
    }
  }

  playWhistle() {
    this.blip('sine', 1650, 1850, 0.12, 0.14, 'lin');
    window.setTimeout(() => this.blip('sine', 1850, 1600, 0.16, 0.14, 'lin'), 120);
  }

  playWin(won: boolean) {
    const notes = won ? [523, 659, 784, 1047] : [523, 440, 349, 262];
    notes.forEach((f, i) => {
      window.setTimeout(() => this.blip('triangle', f, f, 0.22, 0.2, 'lin'), i * 130);
    });
  }

  playPop() {
    this.blip('sine', 700, 1400, 0.08, 0.16);
  }
}

export const audioService = new AudioService();
