import { getPlatformBridge } from '../bridge/PlatformBridge';
import type { VadSegment } from '../corpus/types';
import { useEditorStore } from '../store/useEditorStore';

export interface VadOptions {
  /** 分析帧长（毫秒），默认 20ms */
  frameMs?: number;
  /** 帧移（毫秒），默认 10ms */
  hopMs?: number;
  /** 丢弃短于该时长的瞬态杂音（毫秒），默认 60ms */
  minSpeechMs?: number;
  /** 合并短于该时长的内部停顿（毫秒），默认 180ms */
  mergeGapMs?: number;
  /** 明显停顿断开参考阈值（毫秒），默认 250ms */
  splitGapMs?: number;
  /** 语音段首尾留白（毫秒），默认 25ms */
  padMs?: number;
  /** 可选同步过零点对齐回调 */
  snapZeroCrossing?: (t: number) => number;
}

export interface AsyncVadOptions extends Omit<VadOptions, 'snapZeroCrossing'> {
  /** 可选同步或异步过零点对齐回调（例如 bridge.findZeroCrossing） */
  snapZeroCrossing?: (t: number) => number | Promise<number>;
  /** 覆盖声学辅助引擎模式（默认读取全局偏好设置） */
  engineMode?: 'neural' | 'classic';
  /** 文档时间偏移（文档时间 = 音频时间 + audioOffset），默认 0 */
  audioOffset?: number;
  /** 可选局部作用窗起点（文档时间） */
  scopeStart?: number;
  /** 可选局部作用窗终点（文档时间） */
  scopeEnd?: number;
  /** 中断信号 */
  signal?: AbortSignal;
  /** 分块进度回调 (doneChunks, totalChunks) */
  onProgress?: (doneChunks: number, totalChunks: number) => void;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function detectRawSegments(
  mono: Float32Array,
  sampleRate: number,
  options?: Omit<VadOptions, 'snapZeroCrossing'>
): VadSegment[] {
  if (mono.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return [];
  const duration = mono.length / sampleRate;
  const frameMs = options?.frameMs ?? 20;
  const hopMs = options?.hopMs ?? 10;
  const minSpeechSec = (options?.minSpeechMs ?? 60) / 1000;
  const splitGapSec = (options?.splitGapMs ?? 250) / 1000;
  const mergeGapSec = Math.min((options?.mergeGapMs ?? 180) / 1000, splitGapSec);
  const padSec = (options?.padMs ?? 25) / 1000;

  const winLen = Math.max(16, Math.round((frameMs / 1000) * sampleRate));
  const hopLen = Math.max(8, Math.round((hopMs / 1000) * sampleRate));
  if (mono.length < winLen) return [];

  const frameCount = Math.floor((mono.length - winLen) / hopLen) + 1;
  const logE = new Float32Array(frameCount);
  const zcr = new Float32Array(frameCount);

  for (let f = 0; f < frameCount; f++) {
    const base = f * hopLen;
    let sumSq = 0;
    let crossings = 0;
    let prev = mono[base];
    sumSq += prev * prev;
    for (let i = 1; i < winLen; i++) {
      const cur = mono[base + i];
      sumSq += cur * cur;
      if ((prev >= 0 && cur < 0) || (prev < 0 && cur >= 0)) crossings++;
      prev = cur;
    }
    logE[f] = 10 * Math.log10(sumSq / winLen + 1e-10);
    zcr[f] = crossings / (winLen - 1);
  }

  const sortedE = Float32Array.from(logE).sort();
  const noiseFloor = sortedE[Math.floor((frameCount - 1) * 0.15)];
  const peakEnergy = sortedE[Math.floor((frameCount - 1) * 0.95)];
  const dyn = peakEnergy - noiseFloor;
  if (dyn < 4.5) return [];

  const highTh = noiseFloor + clamp(dyn * 0.42, 8, 18);
  const lowTh = noiseFloor + clamp(dyn * 0.16, 3.5, 9);

  let noiseZcrSum = 0;
  let noiseZcrCount = 0;
  for (let f = 0; f < frameCount; f++) {
    if (logE[f] <= lowTh) {
      noiseZcrSum += zcr[f];
      noiseZcrCount++;
    }
  }
  const baseZcr = noiseZcrCount > 0 ? noiseZcrSum / noiseZcrCount : 0.08;
  const zcrTh = clamp(baseZcr * 1.8 + 0.06, 0.18, 0.45);
  const zcrEnergyFloor = noiseFloor + 2.0;

  const active = new Uint8Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    if (logE[f] < highTh || active[f]) continue;
    active[f] = 1;
    for (let l = f - 1; l >= 0 && !active[l]; l--) {
      if (logE[l] >= lowTh || (logE[l] >= zcrEnergyFloor && zcr[l] >= zcrTh)) active[l] = 1;
      else break;
    }
    for (let r = f + 1; r < frameCount && !active[r]; r++) {
      if (logE[r] >= lowTh || (logE[r] >= zcrEnergyFloor && zcr[r] >= zcrTh)) active[r] = 1;
      else break;
    }
  }

  const raw: VadSegment[] = [];
  let inRun = false;
  let runStart = 0;
  for (let f = 0; f <= frameCount; f++) {
    const on = f < frameCount && active[f] === 1;
    if (on && !inRun) {
      inRun = true;
      runStart = f;
    } else if (!on && inRun) {
      inRun = false;
      const start = (runStart * hopLen) / sampleRate;
      const end = Math.min(duration, ((f - 1) * hopLen + winLen) / sampleRate);
      raw.push({ start, end });
    }
  }

  const merged: VadSegment[] = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && seg.start - prev.end < mergeGapSec) {
      prev.end = Math.max(prev.end, seg.end);
    } else {
      merged.push({ start: seg.start, end: seg.end });
    }
  }

  const padded: VadSegment[] = [];
  for (const seg of merged) {
    if (seg.end - seg.start < minSpeechSec) continue;
    const start = clamp(seg.start - padSec, 0, duration);
    const end = clamp(seg.end + padSec, 0, duration);
    if (end <= start) continue;
    const prev = padded[padded.length - 1];
    if (prev && start <= prev.end) {
      const mid = 0.5 * (prev.end + start);
      prev.end = mid;
      padded.push({ start: mid, end });
    } else {
      padded.push({ start, end });
    }
  }
  return padded;
}

/**
 * 同步双门限（短时对数能量 + 过零率）静音切分。
 */
export function detectSpeechSegments(
  mono: Float32Array,
  sampleRate: number,
  options?: VadOptions
): VadSegment[] {
  const segs = detectRawSegments(mono, sampleRate, options);
  const snap = options?.snapZeroCrossing;
  if (!snap || segs.length === 0) return segs;
  const duration = mono.length / sampleRate;
  return segs
    .map((seg, i) => {
      const lo = i > 0 ? segs[i - 1].end : 0;
      const hi = i + 1 < segs.length ? segs[i + 1].start : duration;
      const s = clamp(snap(seg.start), lo, seg.end);
      const e = clamp(snap(seg.end), s, hi);
      return { start: s, end: e };
    })
    .filter((seg) => seg.end - seg.start > 0.005);
}

function finalizeSegments(
  raw: VadSegment[],
  duration: number,
  options?: Omit<VadOptions, 'snapZeroCrossing'>
): VadSegment[] {
  const minSpeechSec = (options?.minSpeechMs ?? 60) / 1000;
  const splitGapSec = (options?.splitGapMs ?? 250) / 1000;
  const mergeGapSec = Math.min((options?.mergeGapMs ?? 180) / 1000, splitGapSec);
  const padSec = (options?.padMs ?? 25) / 1000;

  const sorted = [...raw].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: VadSegment[] = [];
  for (const seg of sorted) {
    if (!Number.isFinite(seg.start) || !Number.isFinite(seg.end) || seg.end <= seg.start) continue;
    const prev = merged[merged.length - 1];
    if (prev && seg.start - prev.end < mergeGapSec) {
      prev.end = Math.max(prev.end, seg.end);
    } else {
      merged.push({ start: seg.start, end: seg.end });
    }
  }

  const padded: VadSegment[] = [];
  for (const seg of merged) {
    if (seg.end - seg.start < minSpeechSec) continue;
    const start = clamp(seg.start - padSec, 0, duration);
    const end = clamp(seg.end + padSec, 0, duration);
    if (end <= start) continue;
    const prev = padded[padded.length - 1];
    if (prev && start <= prev.end) {
      const mid = 0.5 * (prev.end + start);
      prev.end = mid;
      padded.push({ start: mid, end });
    } else {
      padded.push({ start, end });
    }
  }
  return padded;
}

async function detectNeuralSegmentsChunked(
  mono: Float32Array,
  sampleRate: number,
  options?: AsyncVadOptions
): Promise<VadSegment[]> {
  if (mono.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return [];
  const duration = mono.length / sampleRate;
  const bridge = getPlatformBridge();

  const chunkSec = 30.0;
  const overlapSec = 0.5;
  const collected: VadSegment[] = [];

  let chunkIdx = 0;
  const totalChunks = Math.max(1, Math.ceil(duration / chunkSec));
  for (let tStart = 0; tStart < duration - 1e-6; tStart += chunkSec) {
    if (options?.signal?.aborted) {
      const err = new Error('VAD aborted');
      err.name = 'AbortError';
      throw err;
    }
    if (chunkIdx > 0) {
      // Yield between 30 s chunks so long recordings never block the UI thread
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (options?.signal?.aborted) {
      const err = new Error('VAD aborted');
      err.name = 'AbortError';
      throw err;
    }
    chunkIdx++;

    const tEnd = Math.min(duration, tStart + chunkSec);
    const padL = Math.max(0, tStart - overlapSec);
    const padR = Math.min(duration, tEnd + overlapSec);
    const sLo = Math.max(0, Math.floor(padL * sampleRate));
    const sHi = Math.min(mono.length, Math.ceil(padR * sampleRate));
    if (sHi <= sLo + 16) break;

    const slice = mono.subarray(sLo, sHi);
    const sliceOrigin = sLo / sampleRate;
    const chunkSegs = await bridge.detectSpeechSegmentsNn(slice, Math.round(sampleRate), {
      frameMs: options?.frameMs ?? 20,
      hopMs: options?.hopMs ?? 10,
      minSpeechMs: 20,
      mergeGapMs: options?.mergeGapMs ?? 180,
      splitGapMs: options?.splitGapMs ?? 250,
      padMs: 0,
      snapZeroCrossing: false
    });

    for (const seg of chunkSegs) {
      const gStart = Math.max(tStart, seg.start + sliceOrigin);
      const gEnd = Math.min(tEnd, seg.end + sliceOrigin);
      if (gEnd > gStart + 1e-4) {
        collected.push({ start: gStart, end: gEnd });
      }
    }
    options?.onProgress?.(chunkIdx, totalChunks);
  }

  return finalizeSegments(collected, duration, options);
}

/**
 * 异步语音端点检测：默认启用 AcouSeg 1.0 分块推理（30 s 分块 + 0.5 s 重叠），
 * 经典模式或推理异常时无缝回退至纯规则双门限，支持 audioOffset、局部作用窗、进度与取消控制。
 */
export async function detectSpeechSegmentsAsync(
  mono: Float32Array,
  sampleRate: number,
  options?: AsyncVadOptions
): Promise<VadSegment[]> {
  if (mono.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return [];
  const audioDuration = mono.length / sampleRate;
  const audioOffset = Number.isFinite(options?.audioOffset ?? 0) ? (options?.audioOffset ?? 0) : 0;
  const docMin = audioOffset;
  const docMax = audioOffset + audioDuration;
  const hasScope = options?.scopeStart !== undefined || options?.scopeEnd !== undefined;
  const effDocStart =
    options?.scopeStart !== undefined && Number.isFinite(options.scopeStart)
      ? Math.max(docMin, options.scopeStart)
      : docMin;
  const effDocEnd =
    options?.scopeEnd !== undefined && Number.isFinite(options.scopeEnd)
      ? Math.min(docMax, options.scopeEnd)
      : docMax;
  if (effDocEnd <= effDocStart + 1e-6) return [];

  const sLo = hasScope ? Math.max(0, Math.floor((effDocStart - audioOffset) * sampleRate)) : 0;
  const sHi = hasScope
    ? Math.min(mono.length, Math.ceil((effDocEnd - audioOffset) * sampleRate))
    : mono.length;
  const workingMono = hasScope ? mono.subarray(sLo, sHi) : mono;
  const sliceOriginDoc = audioOffset + sLo / sampleRate;
  const mode = options?.engineMode ?? useEditorStore.getState().acousticEngineMode;
  let segs: VadSegment[] | null = null;
  if (mode === 'neural') {
    try {
      segs = await detectNeuralSegmentsChunked(workingMono, sampleRate, options);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      segs = null;
    }
  }
  if (segs === null) {
    segs = detectRawSegments(workingMono, sampleRate, options);
  }
  const docSegs: VadSegment[] = segs
    .map((seg) => ({
      start: clamp(seg.start + sliceOriginDoc, effDocStart, effDocEnd),
      end: clamp(seg.end + sliceOriginDoc, effDocStart, effDocEnd)
    }))
    .filter((seg) => seg.end - seg.start > 1e-6);

  const snap = options?.snapZeroCrossing;
  if (!snap || docSegs.length === 0) return docSegs;
  const out: VadSegment[] = [];
  for (let i = 0; i < docSegs.length; i++) {
    const seg = docSegs[i];
    const lo = out.length > 0 ? out[out.length - 1].end : effDocStart;
    const hi = i + 1 < docSegs.length ? docSegs[i + 1].start : effDocEnd;
    let s = seg.start;
    let e = seg.end;
    try {
      const snappedStart = await snap(seg.start);
      if (Number.isFinite(snappedStart)) s = clamp(snappedStart, lo, seg.end);
    } catch {
      // 过零点对齐失败时回退原边界
    }
    try {
      const snappedEnd = await snap(seg.end);
      if (Number.isFinite(snappedEnd)) e = clamp(snappedEnd, s, hi);
    } catch {
      // 过零点对齐失败时回退原边界
    }
    if (e - s > 0.005) {
      out.push({ start: s, end: e });
    }
  }
  return out;
}

export * from './vadPostprocess';
export * from './vadCache';
export * from './vadWriter';
