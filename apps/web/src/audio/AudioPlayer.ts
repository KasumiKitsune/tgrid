export interface AudioPlaybackCallbacks {
  onTimeUpdate: (t: number, showPlayhead: boolean) => void;
  onPlayingChange: (playing: boolean) => void;
}

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private offset = 0;
  private playing = false;
  private loop = false;
  private rate = 1.0;
  private volume = 0.9;
  private playStartWall = 0;
  private playStartTime = 0;
  private playEndTime = 0;
  private rafId: number | null = null;
  private callbacks: AudioPlaybackCallbacks;

  constructor(callbacks: AudioPlaybackCallbacks, initialVolume = 0.9) {
    this.callbacks = callbacks;
    this.volume = Math.max(0, Math.min(1, initialVolume));
  }

  ensureContext(): AudioContext {
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = this.volume;
      this.gainNode.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  getBuffer(): AudioBuffer | null {
    return this.buffer;
  }

  getOffset(): number {
    return this.offset;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  setLoop(next: boolean): void {
    this.loop = next;
  }

  setVolume(val: number): void {
    this.volume = Math.max(0, Math.min(1, val));
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
  }

  setRate(val: number): void {
    const safeRate = Number.isFinite(val) && val > 0 ? val : 1.0;
    if (this.playing) {
      const elapsed = (performance.now() / 1000 - this.playStartWall) * this.rate;
      const cur = Math.min(this.playEndTime, this.playStartTime + elapsed);
      const endT = this.playEndTime;
      this.rate = safeRate;
      if (endT > cur + 0.002) {
        this.start(cur, endT);
      }
      return;
    }
    this.rate = safeRate;
    if (this.source) {
      this.source.playbackRate.value = safeRate;
    }
  }

  async decodeAudioBytes(bytes: Uint8Array, offset = 0): Promise<{ buffer: AudioBuffer; mono: Float32Array }> {
    const ctx = this.ensureContext();
    const copy = bytes.slice().buffer;
    const buffer = await ctx.decodeAudioData(copy);
    this.stop(false);
    this.buffer = buffer;
    this.offset = offset;
    const len = buffer.length;
    const mono = new Float32Array(len);
    const ch0 = buffer.getChannelData(0);
    if (buffer.numberOfChannels > 1) {
      const ch1 = buffer.getChannelData(1);
      for (let i = 0; i < len; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);
    } else {
      mono.set(ch0);
    }
    return { buffer, mono };
  }

  loadFromSoundObject(channels: number[][], sampleRate: number, offset = 0): { buffer: AudioBuffer; mono: Float32Array } {
    const ctx = this.ensureContext();
    const ny = Math.max(1, channels.length);
    const nx = channels[0]?.length || 0;
    const buffer = ctx.createBuffer(ny, Math.max(1, nx), Math.max(1000, Math.round(sampleRate)));
    for (let ch = 0; ch < ny; ch++) {
      const dst = buffer.getChannelData(ch);
      const src = channels[ch] || [];
      for (let i = 0; i < nx; i++) dst[i] = src[i] ?? 0;
    }
    this.stop(false);
    this.buffer = buffer;
    this.offset = offset;
    const mono = new Float32Array(nx);
    const ch0 = buffer.getChannelData(0);
    if (ny > 1) {
      const ch1 = buffer.getChannelData(1);
      for (let i = 0; i < nx; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);
    } else {
      mono.set(ch0);
    }
    return { buffer, mono };
  }

  setBuffer(buffer: AudioBuffer | null, offset = 0): void {
    this.stop(false);
    this.buffer = buffer;
    this.offset = offset;
  }

  clear(): void {
    this.stop(true);
    this.buffer = null;
    this.offset = 0;
  }

  start(startT: number, endT: number): void {
    if (!Number.isFinite(startT) || !Number.isFinite(endT) || endT <= startT) return;
    this.stop(false);
    this.playing = true;
    this.playStartTime = startT;
    this.playEndTime = endT;
    this.playStartWall = performance.now() / 1000;
    this.callbacks.onPlayingChange(true);

    if (this.buffer) {
      const ctx = this.ensureContext();
      const bufStart = Math.max(0, startT - this.offset);
      const bufDur = Math.max(
        0,
        Math.min(this.buffer.duration - bufStart, endT - Math.max(startT, this.offset))
      );
      const delay = Math.max(0, (this.offset - startT) / this.rate);
      if (bufDur > 0.001) {
        const src = ctx.createBufferSource();
        src.buffer = this.buffer;
        src.playbackRate.value = this.rate;
        src.connect(this.gainNode!);
        src.start(ctx.currentTime + delay, bufStart, bufDur);
        this.source = src;
      }
    }

    const tick = () => {
      if (!this.playing) return;
      const elapsed = (performance.now() / 1000 - this.playStartWall) * this.rate;
      const cur = this.playStartTime + elapsed;
      if (cur >= this.playEndTime) {
        if (this.loop) {
          this.start(this.playStartTime, this.playEndTime);
          return;
        }
        this.callbacks.onTimeUpdate(this.playEndTime, true);
        this.stop(false);
        return;
      }
      this.callbacks.onTimeUpdate(cur, true);
      this.rafId = requestAnimationFrame(tick);
    };
    this.callbacks.onTimeUpdate(startT, true);
    this.rafId = requestAnimationFrame(tick);
  }

  stop(resetTime = false, resetTarget = 0): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // ignore
      }
      this.source.disconnect();
      this.source = null;
    }
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    const wasPlaying = this.playing;
    this.playing = false;
    if (wasPlaying) this.callbacks.onPlayingChange(false);
    if (resetTime) {
      this.callbacks.onTimeUpdate(resetTarget, false);
    }
  }
}
