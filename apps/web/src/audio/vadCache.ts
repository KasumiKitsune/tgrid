import { getPlatformBridge } from '../bridge/PlatformBridge';
import type { VadPosteriorTrack } from '../bridge/types';
import {
  extractRuleFeatureTrack,
  type RuleFeatureTrack,
  type VadEngineMode
} from './vadPostprocess.ts';

export interface VadExtractProgress {
  doneChunks: number;
  totalChunks: number;
  ratio: number;
  coveredSec: number;
  totalSec: number;
}

export interface ExtractVadTrackOptions {
  /** Rust tg-dsp 会话 ID（存在时优先零拷贝从会话内存分块推理） */
  sessionId?: number | null;
  /** 浏览器解码后的 AudioBuffer（传统规则引擎必需，亦作无 sessionId 时的 PCM 兜底） */
  audioBuffer?: AudioBuffer | null;
  /** 录音总时长（秒） */
  audioDuration: number;
  /** 检测引擎模式 */
  engineMode: VadEngineMode;
  /** 本次需要提取的音频相对起点（秒），默认 0 */
  rangeAudioStart?: number;
  /** 本次需要提取的音频相对终点（秒），默认 audioDuration */
  rangeAudioEnd?: number;
  /** 分块时长（秒），默认 30s */
  chunkSec?: number;
  /** 中断信号 */
  signal?: AbortSignal;
  /** 分块进度回调 */
  onProgress?: (progress: VadExtractProgress) => void;
  /** 每完成一个 30s 分块后立刻回调当前累积后验轨道，便于长录音首秒点亮画布预览 */
  onPartialTrack?: (track: VadPosteriorTrack) => void;
}

export interface CachedVadSession {
  durationSec: number;
  neuralTrack: VadPosteriorTrack | null;
  /** 按 10 ms 帧记录是否已完成推理（1 = 已提取） */
  neuralFrameMask: Uint8Array | null;
  ruleTrack: RuleFeatureTrack | null;
}

const sessionCache = new Map<number, CachedVadSession>();
const bufferCache = new WeakMap<AudioBuffer, CachedVadSession>();
const MAX_SESSION_CACHE = 8;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function getOrCreateCacheEntry(
  sessionId: number | null | undefined,
  audioBuffer: AudioBuffer | null | undefined,
  durationSec: number
): CachedVadSession {
  if (sessionId !== null && sessionId !== undefined && sessionId > 0) {
    const existing = sessionCache.get(sessionId);
    if (existing && Math.abs(existing.durationSec - durationSec) < 0.05) {
      // Refresh LRU insertion order
      sessionCache.delete(sessionId);
      sessionCache.set(sessionId, existing);
      return existing;
    }
    const created: CachedVadSession = {
      durationSec,
      neuralTrack: null,
      neuralFrameMask: null,
      ruleTrack: null
    };
    if (sessionCache.size >= MAX_SESSION_CACHE) {
      const oldestKey = sessionCache.keys().next().value;
      if (oldestKey !== undefined) sessionCache.delete(oldestKey);
    }
    sessionCache.set(sessionId, created);
    return created;
  }

  if (audioBuffer) {
    const existing = bufferCache.get(audioBuffer);
    if (existing) return existing;
    const created: CachedVadSession = {
      durationSec,
      neuralTrack: null,
      neuralFrameMask: null,
      ruleTrack: null
    };
    bufferCache.set(audioBuffer, created);
    return created;
  }

  return {
    durationSec,
    neuralTrack: null,
    neuralFrameMask: null,
    ruleTrack: null
  };
}

/**
 * 将多声道 AudioBuffer 下混为单声道 Float32Array（单声道零拷贝返回 channel 0）。
 */
export function mixAudioBufferToMono(audioBuffer: AudioBuffer): Float32Array {
  if (audioBuffer.numberOfChannels <= 1) {
    return audioBuffer.getChannelData(0);
  }
  const len = audioBuffer.length;
  const chCount = audioBuffer.numberOfChannels;
  const mono = new Float32Array(len);
  const scale = 1 / chCount;
  for (let c = 0; c < chCount; c++) {
    const ch = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) {
      mono[i] += ch[i] * scale;
    }
  }
  return mono;
}

/**
 * 读取已缓存的神经/规则轨道（不会触发新计算）。
 */
export function getCachedVadTracks(
  sessionId?: number | null,
  audioBuffer?: AudioBuffer | null
): { neuralTrack: VadPosteriorTrack | null; ruleTrack: RuleFeatureTrack | null } {
  if (sessionId !== null && sessionId !== undefined && sessionId > 0) {
    const entry = sessionCache.get(sessionId);
    if (entry) {
      return { neuralTrack: entry.neuralTrack, ruleTrack: entry.ruleTrack };
    }
  }
  if (audioBuffer) {
    const entry = bufferCache.get(audioBuffer);
    if (entry) {
      return { neuralTrack: entry.neuralTrack, ruleTrack: entry.ruleTrack };
    }
  }
  return { neuralTrack: null, ruleTrack: null };
}

/**
 * 清除指定会话或全部 VAD 缓存。
 */
export function invalidateVadCache(sessionId?: number): void {
  if (sessionId !== undefined) {
    sessionCache.delete(sessionId);
  } else {
    sessionCache.clear();
  }
}

function createEmptyNeuralTrack(durationSec: number): {
  track: VadPosteriorTrack;
  mask: Uint8Array;
} {
  const numFrames = Math.max(1, Math.round(durationSec * 100));
  return {
    track: {
      hopMs: 10,
      originSec: 0,
      numFrames,
      pVad: new Uint8Array(numFrames),
      pObstruent: new Uint8Array(numFrames),
      pStopCl: new Uint8Array(numFrames)
    },
    mask: new Uint8Array(numFrames)
  };
}

function isRangeCovered(mask: Uint8Array, fLo: number, fHi: number): boolean {
  for (let i = fLo; i < fHi; i++) {
    if (mask[i] === 0) return false;
  }
  return true;
}

function cloneTrackSnapshot(track: VadPosteriorTrack): VadPosteriorTrack {
  return {
    hopMs: track.hopMs,
    originSec: track.originSec,
    numFrames: track.numFrames,
    pVad: track.pVad,
    pObstruent: track.pObstruent,
    pStopCl: track.pStopCl
  };
}

function yieldMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('VAD extraction aborted');
    err.name = 'AbortError';
    throw err;
  }
}

/**
 * 增量提取并缓存神经 10 ms 后验轨道（30 s 分块 + 进度/增量回调 + AbortSignal 取消）。
 */
export async function ensureNeuralVadTrack(
  options: Omit<ExtractVadTrackOptions, 'engineMode'>
): Promise<VadPosteriorTrack> {
  const durationSec = options.audioDuration;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return {
      hopMs: 10,
      originSec: 0,
      numFrames: 0,
      pVad: new Uint8Array(0),
      pObstruent: new Uint8Array(0),
      pStopCl: new Uint8Array(0)
    };
  }

  const entry = getOrCreateCacheEntry(options.sessionId, options.audioBuffer, durationSec);
  if (!entry.neuralTrack || !entry.neuralFrameMask) {
    const init = createEmptyNeuralTrack(durationSec);
    entry.neuralTrack = init.track;
    entry.neuralFrameMask = init.mask;
  }

  const track = entry.neuralTrack;
  const mask = entry.neuralFrameMask;

  const rStart = clamp(options.rangeAudioStart ?? 0, 0, durationSec);
  const rEnd = clamp(options.rangeAudioEnd ?? durationSec, rStart, durationSec);
  if (rEnd <= rStart + 1e-6) {
    return cloneTrackSnapshot(track);
  }

  const chunkSec = Math.max(5, options.chunkSec ?? 30);
  const chunks: Array<{ start: number; end: number; fLo: number; fHi: number }> = [];
  for (let t = rStart; t < rEnd - 1e-6; t += chunkSec) {
    const cEnd = Math.min(rEnd, t + chunkSec);
    const fLo = clamp(Math.floor(t * 100 + 1e-6), 0, track.numFrames);
    const fHi = clamp(Math.ceil(cEnd * 100 - 1e-6), fLo, track.numFrames);
    if (fHi > fLo) {
      chunks.push({ start: t, end: cEnd, fLo, fHi });
    }
  }

  const pending = chunks.filter((c) => !isRangeCovered(mask, c.fLo, c.fHi));
  const totalChunks = chunks.length;
  let doneChunks = totalChunks - pending.length;
  const totalSpan = Math.max(1e-6, rEnd - rStart);

  if (pending.length === 0) {
    options.onProgress?.({
      doneChunks: totalChunks,
      totalChunks,
      ratio: 1,
      coveredSec: totalSpan,
      totalSec: totalSpan
    });
    return cloneTrackSnapshot(track);
  }

  const bridge = getPlatformBridge();
  const hasSession =
    options.sessionId !== null && options.sessionId !== undefined && options.sessionId > 0;
  let monoFallback: Float32Array | null = null;
  let sampleRateFallback = 0;

  if (!hasSession) {
    if (!options.audioBuffer) {
      throw new Error('缺少有效的音频会话或 AudioBuffer，无法提取神经 VAD 特征');
    }
    monoFallback = mixAudioBufferToMono(options.audioBuffer);
    sampleRateFallback = options.audioBuffer.sampleRate;
  }

  options.onProgress?.({
    doneChunks,
    totalChunks,
    ratio: totalChunks > 0 ? doneChunks / totalChunks : 0,
    coveredSec: Math.min(totalSpan, doneChunks * chunkSec),
    totalSec: totalSpan
  });

  for (let idx = 0; idx < pending.length; idx++) {
    throwIfAborted(options.signal);
    if (idx > 0) {
      await yieldMainThread();
      throwIfAborted(options.signal);
    }

    const ch = pending[idx];
    let chunkTrack: VadPosteriorTrack;

    if (hasSession) {
      chunkTrack = await bridge.extractVadPosteriorsChunk(
        options.sessionId!,
        ch.start,
        ch.end
      );
    } else {
      const sr = sampleRateFallback;
      const mono = monoFallback!;
      const overlapSec = 0.5;
      const padL = Math.max(0, ch.start - overlapSec);
      const padR = Math.min(durationSec, ch.end + overlapSec);
      const sLo = Math.max(0, Math.floor(padL * sr));
      const sHi = Math.min(mono.length, Math.ceil(padR * sr));
      const padOrigin = sLo / sr;
      const fullChunk = await bridge.extractVadPosteriorsPcm(
        mono.subarray(sLo, sHi),
        Math.round(sr),
        padOrigin
      );
      // Crop fullChunk to [ch.fLo, ch.fHi)
      const count = ch.fHi - ch.fLo;
      const croppedVad = new Uint8Array(count);
      const croppedObs = new Uint8Array(count);
      const croppedStop = new Uint8Array(count);
      const maxLocal = Math.max(0, fullChunk.numFrames - 1);
      for (let k = 0; k < count; k++) {
        const targetT = (ch.fLo + k) * 0.01;
        const localF = clamp(Math.round((targetT - fullChunk.originSec) * 100), 0, maxLocal);
        if (fullChunk.numFrames > 0) {
          croppedVad[k] = fullChunk.pVad[localF];
          croppedObs[k] = fullChunk.pObstruent[localF];
          croppedStop[k] = fullChunk.pStopCl[localF];
        }
      }
      chunkTrack = {
        hopMs: 10,
        originSec: ch.fLo * 0.01,
        numFrames: count,
        pVad: croppedVad,
        pObstruent: croppedObs,
        pStopCl: croppedStop
      };
    }

    throwIfAborted(options.signal);

    // Copy chunk frames into full cached track
    const baseFrame = Math.round(chunkTrack.originSec * 100);
    for (let k = 0; k < chunkTrack.numFrames; k++) {
      const dst = baseFrame + k;
      if (dst >= 0 && dst < track.numFrames) {
        track.pVad[dst] = chunkTrack.pVad[k];
        track.pObstruent[dst] = chunkTrack.pObstruent[k];
        track.pStopCl[dst] = chunkTrack.pStopCl[k];
        mask[dst] = 1;
      }
    }

    doneChunks++;
    const coveredSec = Math.min(totalSpan, doneChunks * chunkSec);
    options.onProgress?.({
      doneChunks,
      totalChunks,
      ratio: totalChunks > 0 ? doneChunks / totalChunks : 1,
      coveredSec,
      totalSec: totalSpan
    });
    options.onPartialTrack?.(cloneTrackSnapshot(track));
  }

  return cloneTrackSnapshot(track);
}

/**
 * 提取并缓存传统规则 10 ms 特征轨道（基于 AudioBuffer）。
 */
export async function ensureRuleVadTrack(
  options: Omit<ExtractVadTrackOptions, 'engineMode'>
): Promise<RuleFeatureTrack> {
  const durationSec = options.audioDuration;
  const entry = getOrCreateCacheEntry(options.sessionId, options.audioBuffer, durationSec);
  if (entry.ruleTrack && entry.ruleTrack.numFrames > 0) {
    options.onProgress?.({
      doneChunks: 1,
      totalChunks: 1,
      ratio: 1,
      coveredSec: durationSec,
      totalSec: durationSec
    });
    return entry.ruleTrack;
  }

  throwIfAborted(options.signal);
  if (!options.audioBuffer) {
    throw new Error('缺少 AudioBuffer，无法提取传统规则 VAD 特征');
  }

  const mono = mixAudioBufferToMono(options.audioBuffer);
  const track = extractRuleFeatureTrack(mono, options.audioBuffer.sampleRate, 0, 20, 10);
  entry.ruleTrack = track;
  options.onProgress?.({
    doneChunks: 1,
    totalChunks: 1,
    ratio: 1,
    coveredSec: durationSec,
    totalSec: durationSec
  });
  return track;
}

/**
 * 统一特征提取入口：按需返回当前引擎对应的缓存轨道。
 */
export async function extractVadTrack(
  options: ExtractVadTrackOptions
): Promise<{
  neuralTrack: VadPosteriorTrack | null;
  ruleTrack: RuleFeatureTrack | null;
}> {
  if (options.engineMode === 'neural') {
    const neuralTrack = await ensureNeuralVadTrack(options);
    const cached = getCachedVadTracks(options.sessionId, options.audioBuffer);
    return { neuralTrack, ruleTrack: cached.ruleTrack };
  }
  const ruleTrack = await ensureRuleVadTrack(options);
  const cached = getCachedVadTracks(options.sessionId, options.audioBuffer);
  return { neuralTrack: cached.neuralTrack, ruleTrack };
}
