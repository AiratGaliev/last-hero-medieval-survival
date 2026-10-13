// ============ Процедурный звук на WebAudio ============
// Никаких внешних аудиофайлов: всё синтезируется на лету.

type SfxName =
  | 'hit' | 'shoot' | 'pickup' | 'levelup' | 'hurt' | 'die'
  | 'explosion' | 'boss' | 'click' | 'victory' | 'gameover' | 'slam';

class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private musicStep = 0;
  muted = false;

  private ensure(): boolean {
    if (typeof window === 'undefined') return false;
    if (!this.ctx) {
      try {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
        this.sfxGain = this.ctx.createGain();
        this.sfxGain.gain.value = 0.55;
        this.sfxGain.connect(this.master);
        this.musicGain = this.ctx.createGain();
        this.musicGain.gain.value = 0.16;
        this.musicGain.connect(this.master);
      } catch {
        return false;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return true;
  }

  unlock(): void {
    this.ensure();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, this.ctx.currentTime, 0.02);
    }
    return this.muted;
  }

  private tone(
    freq: number, dur: number, type: OscillatorType,
    vol: number, delay = 0, slideTo?: number,
  ): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(this.sfxGain);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }

  private noise(dur: number, vol: number, delay = 0, lowpass = 1200): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = lowpass;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(filt); filt.connect(g); g.connect(this.sfxGain);
    src.start(t0);
  }

  play(name: SfxName): void {
    if (!this.ensure()) return;
    switch (name) {
      case 'hit': this.tone(220 + Math.random() * 60, 0.08, 'square', 0.12, 0, 140); break;
      case 'shoot': this.tone(880, 0.09, 'triangle', 0.1, 0, 320); break;
      case 'pickup': this.tone(660, 0.05, 'square', 0.06); this.tone(990, 0.06, 'square', 0.06, 0.05); break;
      case 'levelup':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.12, 'square', 0.12, i * 0.09));
        break;
      case 'hurt': this.tone(160, 0.18, 'sawtooth', 0.16, 0, 70); this.noise(0.1, 0.1); break;
      case 'die': this.tone(300, 0.12, 'square', 0.08, 0, 90); this.noise(0.08, 0.06); break;
      case 'explosion': this.noise(0.5, 0.3, 0, 700); this.tone(90, 0.4, 'sawtooth', 0.2, 0, 35); break;
      case 'slam': this.noise(0.25, 0.22, 0, 400); this.tone(70, 0.25, 'square', 0.18, 0, 40); break;
      case 'boss':
        this.tone(80, 0.7, 'sawtooth', 0.25, 0, 45);
        this.tone(120, 0.7, 'square', 0.15, 0.15, 60);
        this.noise(0.6, 0.2, 0.2, 300);
        break;
      case 'click': this.tone(440, 0.05, 'square', 0.08); break;
      case 'victory':
        [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.16, 'square', 0.12, i * 0.13));
        break;
      case 'gameover':
        [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.14, i * 0.25));
        break;
    }
  }

  // ---- Фоновая музыка: простой чиптюн-секвенсор ----
  private static readonly MELODY = [
    // 32 шага, частоты (Гц), 0 = пауза
    440, 0, 523, 0, 659, 0, 587, 0, 523, 0, 440, 0, 392, 0, 440, 0,
    523, 0, 659, 0, 784, 0, 659, 0, 587, 0, 523, 0, 440, 0, 0, 0,
  ];
  private static readonly BASS = [
    110, 0, 110, 0, 147, 0, 131, 0, 110, 0, 110, 0, 98, 0, 110, 0,
    131, 0, 131, 0, 165, 0, 147, 0, 131, 0, 110, 0, 110, 0, 0, 0,
  ];

  startMusic(): void {
    if (!this.ensure() || this.musicTimer) return;
    const stepMs = 180; // ~ темп
    this.musicTimer = setInterval(() => {
      if (!this.ctx || !this.musicGain || this.muted) return;
      const m = AudioSystem.MELODY[this.musicStep % 32];
      const b = AudioSystem.BASS[this.musicStep % 32];
      const t0 = this.ctx.currentTime;
      if (m) {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = m;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.5, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
        osc.connect(g); g.connect(this.musicGain);
        osc.start(t0); osc.stop(t0 + 0.2);
      }
      if (b) {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = b;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.7, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
        osc.connect(g); g.connect(this.musicGain);
        osc.start(t0); osc.stop(t0 + 0.25);
      }
      this.musicStep++;
    }, stepMs);
  }

  stopMusic(): void {
    if (this.musicTimer) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }
}

// Синглтон в браузере
export const audio = new AudioSystem();
