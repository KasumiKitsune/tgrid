import type { VadPosteriorTrack } from '../bridge/types';

export type VadEngineMode = 'neural' | 'classic';
export type VadSensitivityPreset = 'tight' | 'standard' | 'loose' | 'custom';

export interface VadSegment {
  start: number;
  end: number;
}

export interface VadPostprocessParams {
  /** 检测引擎：神经 AcouSeg 1.0 或 传统双门限规则 */
  engineMode: VadEngineMode;
  /** 触发阈值（神经：p_vad 起点门限 0..1；规则：动态范围高门限比例） */
  highProbTh: number;
  /** 延展阈值（神经：滞回扩张门限 0..1；规则：动态范围低门限比例） */
  lowProbTh: number;
  /** 清擦音/送气保护门限（p_obstruent >= obsProtectTh 时保持延展，数值越低保护越强） */
  obsProtectTh: number;
  /** 词内塞音闭塞桥接上限（ms），<= 此长度且平均 P(STOP_CL) >= 0.35 的静默自动桥接 */
  maxStopGapMs: number;
  /** 塞音闭塞桥接概率下限，默认 0.35 */
  stopClosureProbTh?: number;
  /** 最短有声时长（ms），短于此时长的瞬态杂音被丢弃 */
  minSpeechMs: number;
  /** 最短停顿 / 合并间隙（ms），短于此时长的内部静默合并为同一语音段 */
  mergeGapMs: number;
  /** 语音段首尾留白（ms） */
  padMs: number;
  /** 经典规则最低能量动态范围（dB），低于此值视为纯平稳底噪 */
  ruleMinDynDb?: number;
}

export interface RuleFeatureTrack {
  hopMs: number;
  frameMs: number;
  originSec: number;
  durationSec: number;
  numFrames: number;
  logE: Float32Array;
  zcr: Float32Array;
  noiseFloorDb: number;
  peakEnergyDb: number;
  /** 归一化至 0..255 的相对能量包络，供波形底部曲线实时预览 */
  pNorm: Uint8Array;
}

export interface VadPostprocessContext {
  /** 配套录音总时长（秒） */
  audioDuration: number;
  /** 文档时间偏移（文档时间 = 音频时间 + audioOffset），默认 0 */
  audioOffset?: number;
  /** 可选局部作用窗起点（文档时间） */
  scopeStart?: number;
  /** 可选局部作用窗终点（文档时间） */
  scopeEnd?: number;
}

export type VadPresetConfig = Omit<VadPostprocessParams, 'engineMode' | 'stopClosureProbTh' | 'ruleMinDynDb'>;

/**
 * 三档灵敏度预设（严格单调：紧凑比标准更严格，宽松比标准更敏感）。
 * 标准档与 Rust `detect_speech_segments_nn` 默认参数完全一致。
 */
export const VAD_PRESETS: Record<Exclude<VadSensitivityPreset, 'custom'>, VadPresetConfig> = {
  tight: {
    highProbTh: 0.56,
    lowProbTh: 0.24,
    obsProtectTh: 0.20,
    maxStopGapMs: 120,
    minSpeechMs: 80,
    mergeGapMs: 120,
    padMs: 15
  },
  standard: {
    highProbTh: 0.44,
    lowProbTh: 0.16,
    obsProtectTh: 0.12,
    maxStopGapMs: 160,
    minSpeechMs: 60,
    mergeGapMs: 180,
    padMs: 25
  },
  loose: {
    highProbTh: 0.30,
    lowProbTh: 0.10,
    obsProtectTh: 0.08,
    maxStopGapMs: 200,
    minSpeechMs: 40,
    mergeGapMs: 280,
    padMs: 40
  }
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createDefaultVadParams(
  preset: Exclude<VadSensitivityPreset, 'custom'> = 'standard',
  engineMode: VadEngineMode = 'neural'
): VadPostprocessParams {
  return {
    engineMode,
    ...VAD_PRESETS[preset],
    stopClosureProbTh: 0.35,
    ruleMinDynDb: 4.5
  };
}

export function applyVadPreset(
  current: VadPostprocessParams,
  preset: Exclude<VadSensitivityPreset, 'custom'>
): VadPostprocessParams {
  return {
    ...current,
    ...VAD_PRESETS[preset]
  };
}

export function detectVadPreset(params: VadPostprocessParams): VadSensitivityPreset {
  const keys: Array<Exclude<VadSensitivityPreset, 'custom'>> = ['tight', 'standard', 'loose'];
  for (const key of keys) {
    const p = VAD_PRESETS[key];
    const sameCore =
      Math.abs(params.highProbTh - p.highProbTh) < 1e-4 &&
      Math.abs(params.lowProbTh - p.lowProbTh) < 1e-4 &&
      Math.abs(params.minSpeechMs - p.minSpeechMs) < 0.5 &&
      Math.abs(params.mergeGapMs - p.mergeGapMs) < 0.5 &&
      Math.abs(params.padMs - p.padMs) < 0.5;
    if (!sameCore) continue;
    if (params.engineMode === 'classic') {
      return key;
    }
    if (
      Math.abs(params.obsProtectTh - p.obsProtectTh) < 1e-4 &&
      Math.abs(params.maxStopGapMs - p.maxStopGapMs) < 0.5
    ) {
      return key;
    }
  }
  return 'custom';
}

/**
 * 一次性提取传统规则双门限所需的 10 ms 帧级对数能量与过零率特征，
 * 后续拖动任意滑块仅执行纯线性后处理（< 1 ms）。
 */
export function extractRuleFeatureTrack(
  mono: Float32Array,
  sampleRate: number,
  originSec = 0,
  frameMs = 20,
  hopMs = 10
): RuleFeatureTrack {
  const safeOrigin = Number.isFinite(originSec) ? originSec : 0;
  if (mono.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return {
      hopMs,
      frameMs,
      originSec: safeOrigin,
      durationSec: 0,
      numFrames: 0,
      logE: new Float32Array(0),
      zcr: new Float32Array(0),
      noiseFloorDb: -100,
      peakEnergyDb: -100,
      pNorm: new Uint8Array(0)
    };
  }

  const durationSec = mono.length / sampleRate;
  const winLen = Math.max(16, Math.round((frameMs / 1000) * sampleRate));
  const hopLen = Math.max(8, Math.round((hopMs / 1000) * sampleRate));
  if (mono.length < winLen) {
    return {
      hopMs,
      frameMs,
      originSec: safeOrigin,
      durationSec,
      numFrames: 0,
      logE: new Float32Array(0),
      zcr: new Float32Array(0),
      noiseFloorDb: -100,
      peakEnergyDb: -100,
      pNorm: new Uint8Array(0)
    };
  }

  const numFrames = Math.floor((mono.length - winLen) / hopLen) + 1;
  const logE = new Float32Array(numFrames);
  const zcr = new Float32Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
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
  const noiseFloorDb = sortedE[Math.floor((numFrames - 1) * 0.15)];
  const peakEnergyDb = sortedE[Math.floor((numFrames - 1) * 0.95)];
  const dyn = Math.max(1e-6, peakEnergyDb - noiseFloorDb);
  const pNorm = new Uint8Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const norm = clamp((logE[f] - noiseFloorDb) / dyn, 0, 1);
    pNorm[f] = Math.round(norm * 255);
  }

  return {
    hopMs,
    frameMs,
    originSec: safeOrigin,
    durationSec,
    numFrames,
    logE,
    zcr,
    noiseFloorDb,
    peakEnergyDb,
    pNorm
  };
}

function resolveEffectiveDocScope(ctx: VadPostprocessContext): {
  audioOffset: number;
  effDocStart: number;
  effDocEnd: number;
  winAudioStart: number;
  winAudioEnd: number;
} | null {
  if (!Number.isFinite(ctx.audioDuration) || ctx.audioDuration <= 0) return null;
  const audioOffset = Number.isFinite(ctx.audioOffset ?? 0) ? (ctx.audioOffset ?? 0) : 0;
  const docAudioMin = audioOffset;
  const docAudioMax = audioOffset + ctx.audioDuration;
  const effDocStart =
    ctx.scopeStart !== undefined && Number.isFinite(ctx.scopeStart)
      ? Math.max(docAudioMin, ctx.scopeStart)
      : docAudioMin;
  const effDocEnd =
    ctx.scopeEnd !== undefined && Number.isFinite(ctx.scopeEnd)
      ? Math.min(docAudioMax, ctx.scopeEnd)
      : docAudioMax;
  if (effDocEnd <= effDocStart + 1e-6) return null;
  return {
    audioOffset,
    effDocStart,
    effDocEnd,
    winAudioStart: effDocStart - audioOffset,
    winAudioEnd: effDocEnd - audioOffset
  };
}

function finalizeRunsInDocScope(
  rawDocSegments: VadSegment[],
  effDocStart: number,
  effDocEnd: number,
  params: VadPostprocessParams
): VadSegment[] {
  if (rawDocSegments.length === 0) return [];
  const mergeGapSec = Math.max(0, params.mergeGapMs) / 1000;
  const minSpeechSec = Math.max(0, params.minSpeechMs) / 1000;
  const padSec = Math.max(0, params.padMs) / 1000;

  // 1. Merge gaps shorter than mergeGapSec
  const merged: VadSegment[] = [];
  for (const seg of rawDocSegments) {
    if (seg.end <= seg.start) continue;
    const prev = merged[merged.length - 1];
    if (prev && seg.start - prev.end < mergeGapSec) {
      prev.end = Math.max(prev.end, seg.end);
    } else {
      merged.push({ start: seg.start, end: seg.end });
    }
  }

  // 2. Filter transient bursts < minSpeechSec, apply +/- pad, clamp to scope, resolve collision at midpoint
  const padded: VadSegment[] = [];
  for (const seg of merged) {
    if (seg.end - seg.start < minSpeechSec) continue;
    const start = clamp(seg.start - padSec, effDocStart, effDocEnd);
    const end = clamp(seg.end + padSec, effDocStart, effDocEnd);
    if (end <= start + 1e-6) continue;
    const prev = padded[padded.length - 1];
    if (prev && start <= prev.end) {
      const mid = 0.5 * (prev.end + start);
      prev.end = mid;
      if (end > mid + 1e-6) {
        padded.push({ start: mid, end });
      }
    } else {
      padded.push({ start, end });
    }
  }

  return padded.filter((s) => s.end - s.start > 1e-6);
}

/**
 * 神经后验 10 ms 帧级纯线性后处理（< 2 ms @ 10 分钟音频）：
 * 滞回双门限扩张 + 清擦音保护 + 词内塞音闭塞桥接 + 合并/过滤/留白防撞 + 局部窗与 audioOffset 换算。
 */
export function postprocessNeuralTrack(
  track: VadPosteriorTrack,
  params: VadPostprocessParams,
  ctx: VadPostprocessContext
): VadSegment[] {
  if (!track || track.numFrames <= 0 || track.pVad.length === 0) return [];
  const scope = resolveEffectiveDocScope(ctx);
  if (!scope) return [];

  const hopSec = (track.hopMs > 0 ? track.hopMs : 10) / 1000;
  const fStart = clamp(
    Math.floor((scope.winAudioStart - track.originSec) / hopSec + 1e-6),
    0,
    track.numFrames
  );
  const fEnd = clamp(
    Math.ceil((scope.winAudioEnd - track.originSec) / hopSec - 1e-6),
    fStart,
    track.numFrames
  );
  const len = fEnd - fStart;
  if (len <= 0) return [];

  const highProb = clamp(params.highProbTh, 0.01, 0.99);
  const lowProb = clamp(Math.min(params.lowProbTh, highProb), 0.01, highProb);
  const obsProb = clamp(params.obsProtectTh, 0.01, 1.0);

  const hiQ = Math.round(highProb * 255);
  const loQ = Math.round(lowProb * 255);
  const obsQ = Math.round(obsProb * 255);
  const useObsProtect = obsProb < 0.995;

  const pVad = track.pVad;
  const pObs = track.pObstruent;
  const pStop = track.pStopCl;

  const active = new Uint8Array(len);

  // 1. Hysteresis probability expansion with voiceless obstruent protection
  for (let i = 0; i < len; i++) {
    const gf = fStart + i;
    if (pVad[gf] < hiQ || active[i]) continue;
    active[i] = 1;

    for (let l = i - 1; l >= 0 && !active[l]; l--) {
      const gl = fStart + l;
      if (pVad[gl] >= loQ || (useObsProtect && pObs[gl] >= obsQ)) {
        active[l] = 1;
      } else {
        break;
      }
    }
    for (let r = i + 1; r < len && !active[r]; r++) {
      const gr = fStart + r;
      if (pVad[gr] >= loQ || (useObsProtect && pObs[gr] >= obsQ)) {
        active[r] = 1;
      } else {
        break;
      }
    }
  }

  // 2. Bridge word-internal stop closures (<= maxStopGapMs with mean P(STOP_CL) >= stopClosureProbTh)
  const maxStopGapFrames = Math.max(0, Math.round(params.maxStopGapMs / (hopSec * 1000)));
  const stopClThQ = clamp(params.stopClosureProbTh ?? 0.35, 0.05, 0.99) * 255;

  if (maxStopGapFrames > 0) {
    let i = 0;
    while (i < len) {
      if (!active[i]) {
        const gStart = i;
        while (i < len && !active[i]) i++;
        const gEnd = i;
        const gap = gEnd - gStart;
        if (gStart > 0 && gEnd < len && gap <= maxStopGapFrames) {
          let sumStop = 0;
          for (let k = gStart; k < gEnd; k++) {
            sumStop += pStop[fStart + k];
          }
          if (sumStop / gap >= stopClThQ) {
            for (let k = gStart; k < gEnd; k++) {
              active[k] = 1;
            }
          }
        }
      } else {
        i++;
      }
    }
  }

  // 3. Extract contiguous runs in document time, clamped to effective scope
  const rawDoc: VadSegment[] = [];
  let inRun = false;
  let runStart = 0;
  for (let i = 0; i <= len; i++) {
    const on = i < len && active[i] === 1;
    if (on && !inRun) {
      inRun = true;
      runStart = i;
    } else if (!on && inRun) {
      inRun = false;
      const t0 = Math.max(
        scope.effDocStart,
        track.originSec + (fStart + runStart) * hopSec + scope.audioOffset
      );
      const t1 = Math.min(
        scope.effDocEnd,
        track.originSec + (fStart + i) * hopSec + scope.audioOffset
      );
      if (t1 > t0 + 1e-6) {
        rawDoc.push({ start: t0, end: t1 });
      }
    }
  }

  return finalizeRunsInDocScope(rawDoc, scope.effDocStart, scope.effDocEnd, params);
}

/**
 * 传统规则双门限 10 ms 帧级纯线性后处理（< 1 ms）：
 * 基于缓存的 logE + ZCR 动态分位数滞回扩张 + 合并/过滤/留白防撞 + 局部窗与 audioOffset 换算。
 */
export function postprocessRuleTrack(
  track: RuleFeatureTrack,
  params: VadPostprocessParams,
  ctx: VadPostprocessContext
): VadSegment[] {
  if (!track || track.numFrames <= 0 || track.logE.length === 0) return [];
  const scope = resolveEffectiveDocScope(ctx);
  if (!scope) return [];

  const hopSec = (track.hopMs > 0 ? track.hopMs : 10) / 1000;
  const winSec = (track.frameMs > 0 ? track.frameMs : 20) / 1000;
  const fStart = clamp(
    Math.floor((scope.winAudioStart - track.originSec) / hopSec + 1e-6),
    0,
    track.numFrames
  );
  const fEnd = clamp(
    Math.ceil((scope.winAudioEnd - track.originSec) / hopSec - 1e-6),
    fStart,
    track.numFrames
  );
  const len = fEnd - fStart;
  if (len <= 0) return [];

  const logE = track.logE;
  const zcr = track.zcr;

  // Use local scope quantiles when scope has >= 20 frames; otherwise fall back to global track stats
  let noiseFloor = track.noiseFloorDb;
  let peakEnergy = track.peakEnergyDb;
  if (len >= 20 && (fStart > 0 || fEnd < track.numFrames)) {
    const localSorted = Float32Array.from(logE.subarray(fStart, fEnd)).sort();
    const localFloor = localSorted[Math.floor((len - 1) * 0.15)];
    const localPeak = localSorted[Math.floor((len - 1) * 0.95)];
    if (localPeak - localFloor >= (params.ruleMinDynDb ?? 4.5)) {
      noiseFloor = localFloor;
      peakEnergy = localPeak;
    }
  }

  const dyn = peakEnergy - noiseFloor;
  if (dyn < (params.ruleMinDynDb ?? 4.5)) return [];

  const highRatio = clamp(params.highProbTh, 0.08, 0.92);
  const lowRatio = clamp(Math.min(params.lowProbTh, highRatio), 0.04, highRatio);
  const highTh = noiseFloor + clamp(dyn * highRatio, 4.5, 22.0);
  const lowTh = Math.min(highTh, noiseFloor + clamp(dyn * lowRatio, 2.0, 12.0));

  let noiseZcrSum = 0;
  let noiseZcrCount = 0;
  for (let i = 0; i < len; i++) {
    const gf = fStart + i;
    if (logE[gf] <= lowTh) {
      noiseZcrSum += zcr[gf];
      noiseZcrCount++;
    }
  }
  const baseZcr = noiseZcrCount > 0 ? noiseZcrSum / noiseZcrCount : 0.08;
  const zcrTh = clamp(baseZcr * 1.8 + 0.06, 0.18, 0.45);
  const zcrEnergyFloor = noiseFloor + 2.0;

  const active = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const gf = fStart + i;
    if (logE[gf] < highTh || active[i]) continue;
    active[i] = 1;
    for (let l = i - 1; l >= 0 && !active[l]; l--) {
      const gl = fStart + l;
      if (logE[gl] >= lowTh || (logE[gl] >= zcrEnergyFloor && zcr[gl] >= zcrTh)) {
        active[l] = 1;
      } else {
        break;
      }
    }
    for (let r = i + 1; r < len && !active[r]; r++) {
      const gr = fStart + r;
      if (logE[gr] >= lowTh || (logE[gr] >= zcrEnergyFloor && zcr[gr] >= zcrTh)) {
        active[r] = 1;
      } else {
        break;
      }
    }
  }

  const rawDoc: VadSegment[] = [];
  let inRun = false;
  let runStart = 0;
  for (let i = 0; i <= len; i++) {
    const on = i < len && active[i] === 1;
    if (on && !inRun) {
      inRun = true;
      runStart = i;
    } else if (!on && inRun) {
      inRun = false;
      const t0 = Math.max(
        scope.effDocStart,
        track.originSec + (fStart + runStart) * hopSec + scope.audioOffset
      );
      const t1 = Math.min(
        scope.effDocEnd,
        track.originSec + (fStart + i - 1) * hopSec + winSec + scope.audioOffset
      );
      if (t1 > t0 + 1e-6) {
        rawDoc.push({ start: t0, end: t1 });
      }
    }
  }

  return finalizeRunsInDocScope(rawDoc, scope.effDocStart, scope.effDocEnd, params);
}

/**
 * 统一后处理分发入口：根据 `params.engineMode` 选用神经或传统规则缓存轨道。
 */
export function postprocessVadTracks(input: {
  neuralTrack: VadPosteriorTrack | null;
  ruleTrack: RuleFeatureTrack | null;
  params: VadPostprocessParams;
  ctx: VadPostprocessContext;
}): VadSegment[] {
  if (input.params.engineMode === 'neural') {
    if (input.neuralTrack && input.neuralTrack.numFrames > 0) {
      return postprocessNeuralTrack(input.neuralTrack, input.params, input.ctx);
    }
    return [];
  }
  if (input.ruleTrack && input.ruleTrack.numFrames > 0) {
    return postprocessRuleTrack(input.ruleTrack, input.params, input.ctx);
  }
  return [];
}
