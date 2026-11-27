export interface AudioPlaybackCallbacks {
  onTimeUpdate: (t: number, showPlayhead: boolean) => void;
  onPlayingChange: (playing: boolean) => void;
}

// Small schedule lookahead so the WebAudio render thread never misses or clips frame 0
const SCHEDULE_LOOKAHEAD_SEC = 0.02;

/**
 * 无副作用的纯音频解码函数：将音频字节解码为 AudioBuffer 并下混为单声道 Float32Array，
 * 不会打断当前播放状态，也不会覆盖 AudioPlayer 内部缓冲。
 */
export async function decodeAudioPure(
  ctx: AudioContext,
  bytes: Uint8Array
): Promise<{ buffer: AudioBuffer; mono: Float32Array }> {
  const copy = bytes.slice().buffer;
  const buffer = await ctx.decodeAudioData(copy);
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

  private playToken = 0;
  private clockMode: 'audio' | 'wall' = 'wall';
  private playStartWall = 0;
  private playStartTime = 0;
  private playEndTime = 0;
  private audioAnchorCtxTime = 0;
  private audioScheduledAtCtxTime = 0;
  private lastReportedTime = 0;
  private rafId: number | null = null;
  private callbacks: AudioPlaybackCallbacks;

  constructor(callbacks: AudioPlaybackCallbacks, initialVolume = 0.9) {
    this.callbacks = callbacks;
    this.volume = Math.max(0, Math.min(1, initialVolume));
  }

  ensureContext(autoResume = false): AudioContext {
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
      } catch {
        this.ctx = new AC();
      }
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = this.volume;
      this.gainNode.connect(this.ctx.destination);
    }
    if (autoResume && this.ctx.state === 'suspended') {
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
    const safeVol = Math.max(0, Math.min(1, val));
    this.volume = safeVol;
    if (this.gainNode) {
      this.gainNode.gain.value = safeVol;
    }
  }

  private getReportedLatency(ctx: AudioContext): number {
    const baseLat =
      typeof ctx.baseLatency === 'number' && Number.isFinite(ctx.baseLatency) && ctx.baseLatency > 0
        ? ctx.baseLatency
        : 0;
    const outLat =
      typeof ctx.outputLatency === 'number' &&
      Number.isFinite(ctx.outputLatency) &&
      ctx.outputLatency > 0
        ? ctx.outputLatency
        : 0;
    return Math.min(2.0, baseLat + outLat);
  }

  /**
   * Returns the AudioContext timestamp of the audio frame currently audible at the
   * output hardware (speakers/headphones). Uses hardware `getOutputTimestamp()` when
   * available and primed, falling back to `ctx.currentTime - (baseLatency + outputLatency)`.
   * Never advances while the audio render thread has not yet started moving `ctx.currentTime`.
   */
  private getAudibleCtxTime(ctx: AudioContext): number {
    const rawCtx = ctx.currentTime;
    // Before the audio thread processes its first quantum after scheduling, stay at anchor
    if (rawCtx <= this.audioScheduledAtCtxTime + 1e-6) {
      return Math.min(rawCtx, this.audioAnchorCtxTime);
    }

    if (typeof ctx.getOutputTimestamp === 'function') {
      try {
        const ts = ctx.getOutputTimestamp();
        if (
          ts &&
          typeof ts.contextTime === 'number' &&
          typeof ts.performanceTime === 'number' &&
          Number.isFinite(ts.contextTime) &&
          Number.isFinite(ts.performanceTime) &&
          ts.contextTime > 0 &&
          ts.performanceTime > 0
        ) {
          // Bound high-res interpolation so a stalled hardware stream can never run away
          const perfDelta = (performance.now() - ts.performanceTime) / 1000;
          const clampedDelta = Math.max(-0.05, Math.min(0.25, perfDelta));
          const est = ts.contextTime + clampedDelta;
          const lag = rawCtx - est;
          if (Number.isFinite(est) && lag >= -0.05 && lag <= 2.5) {
            return Math.min(rawCtx, Math.max(0, est));
          }
        }
      } catch {
        // Fall through to latency-compensated currentTime
      }
    }

    return Math.max(0, rawCtx - this.getReportedLatency(ctx));
  }

  private getCurrentPlaybackTime(): number {
    if (!this.playing) return this.lastReportedTime;
    if (this.clockMode === 'audio' && this.ctx) {
      if (this.ctx.state !== 'running') return this.lastReportedTime;
      const audibleCtx = this.getAudibleCtxTime(this.ctx);
      const elapsed = Math.max(0, audibleCtx - this.audioAnchorCtxTime) * this.rate;
      return Math.min(this.playEndTime, Math.max(this.lastReportedTime, this.playStartTime + elapsed));
    }
    const elapsed = Math.max(0, performance.now() / 1000 - this.playStartWall) * this.rate;
    return Math.min(this.playEndTime, Math.max(this.lastReportedTime, this.playStartTime + elapsed));
  }

  setRate(val: number): void {
    const safeRate = Number.isFinite(val) && val > 0 ? val : 1.0;
    if (Math.abs(safeRate - this.rate) < 1e-6) return;
    if (this.playing) {
      const cur = this.getCurrentPlaybackTime();
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
    const ctx = this.ensureContext(false);
    const decoded = await decodeAudioPure(ctx, bytes);
    this.stop(false);
    this.buffer = decoded.buffer;
    this.offset = offset;
    return decoded;
  }

  loadFromSoundObject(channels: number[][], sampleRate: number, offset = 0): { buffer: AudioBuffer; mono: Float32Array } {
    const ctx = this.ensureContext(false);
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

  private scheduleAudioAndStartLoop(
    ctx: AudioContext,
    token: number,
    startT: number,
    endT: number,
    bufStart: number,
    bufDur: number,
    delay: number
  ): void {
    if (token !== this.playToken || !this.playing || !this.buffer) return;

    const nowCtx = ctx.currentTime;
    const anchorCtx = nowCtx + SCHEDULE_LOOKAHEAD_SEC;
    const srcStartCtx = anchorCtx + delay;
    const srcStopCtx = srcStartCtx + bufDur / this.rate;

    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.gainNode!);
    // Use explicit stop(srcStopCtx) in AudioContext seconds instead of start()'s 3rd duration arg
    // to avoid cross-browser playbackRate duration ambiguities.
    src.start(srcStartCtx, bufStart);
    src.stop(srcStopCtx);
    this.source = src;

    this.clockMode = 'audio';
    this.audioAnchorCtxTime = anchorCtx;
    this.audioScheduledAtCtxTime = nowCtx;

    const expectedEndCtx = anchorCtx + (endT - startT) / this.rate;

    const tick = () => {
      if (!this.playing || token !== this.playToken) return;

      // Hold playhead cleanly if the OS/browser temporarily suspends the audio context
      if (ctx.state !== 'running') {
        this.rafId = requestAnimationFrame(tick);
        return;
      }

      const rawCtx = ctx.currentTime;
      const audibleCtx = this.getAudibleCtxTime(ctx);
      const elapsed = Math.max(0, audibleCtx - anchorCtx) * this.rate;
      const cur = Math.max(this.lastReportedTime, startT + elapsed);
      const safetyEndCtx = expectedEndCtx + Math.min(2.5, this.getReportedLatency(ctx) + 0.35);

      if (cur >= endT || rawCtx >= safetyEndCtx) {
        if (this.loop) {
          this.start(startT, endT);
          return;
        }
        this.lastReportedTime = endT;
        this.callbacks.onTimeUpdate(endT, true);
        this.stop(false);
        return;
      }

      if (Math.abs(cur - this.lastReportedTime) > 1e-6) {
        this.lastReportedTime = cur;
        this.callbacks.onTimeUpdate(cur, true);
      }
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private startWallClockLoop(token: number, startT: number, endT: number): void {
    this.clockMode = 'wall';
    this.playStartWall = performance.now() / 1000;

    const tick = () => {
      if (!this.playing || token !== this.playToken) return;
      const elapsed = Math.max(0, performance.now() / 1000 - this.playStartWall) * this.rate;
      const cur = Math.max(this.lastReportedTime, startT + elapsed);
      if (cur >= endT) {
        if (this.loop) {
          this.start(startT, endT);
          return;
        }
        this.lastReportedTime = endT;
        this.callbacks.onTimeUpdate(endT, true);
        this.stop(false);
        return;
      }
      if (Math.abs(cur - this.lastReportedTime) > 1e-6) {
        this.lastReportedTime = cur;
        this.callbacks.onTimeUpdate(cur, true);
      }
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  start(startT: number, endT: number): void {
    if (!Number.isFinite(startT) || !Number.isFinite(endT) || endT <= startT) return;
    this.stop(false);

    const token = ++this.playToken;
    this.playing = true;
    this.playStartTime = startT;
    this.playEndTime = endT;
    this.lastReportedTime = startT;
    this.callbacks.onPlayingChange(true);
    this.callbacks.onTimeUpdate(startT, true);

    if (this.buffer) {
      const bufStart = Math.max(0, startT - this.offset);
      const bufDur = Math.max(
        0,
        Math.min(this.buffer.duration - bufStart, endT - Math.max(startT, this.offset))
      );
      const delay = Math.max(0, (this.offset - startT) / this.rate);

      if (bufDur > 0.001) {
        const ctx = this.ensureContext(false);
        if (ctx.state !== 'running') {
          // Trigger resume() synchronously inside the user gesture, and wait for it to resolve
          // before scheduling audio or moving the playhead so playhead never runs ahead of audio.
          const resumePromise = ctx.resume();
          void resumePromise.then(
            () => {
              if (token !== this.playToken || !this.playing) return;
              this.scheduleAudioAndStartLoop(ctx, token, startT, endT, bufStart, bufDur, delay);
            },
            () => {
              if (token === this.playToken && this.playing) {
                this.stop(false);
              }
            }
          );
          return;
        }
        this.scheduleAudioAndStartLoop(ctx, token, startT, endT, bufStart, bufDur, delay);
        return;
      }
    }

    this.startWallClockLoop(token, startT, endT);
  }

  stop(resetTime = false, resetTarget = 0): void {
    this.playToken++;
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
      this.lastReportedTime = resetTarget;
      this.callbacks.onTimeUpdate(resetTarget, false);
    }
  }
}
