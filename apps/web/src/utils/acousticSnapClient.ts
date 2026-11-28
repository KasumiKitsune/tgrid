import { getPlatformBridge } from '../bridge/PlatformBridge';
import type { AcousticSnapPeak, AcousticSnapResult } from '../bridge/types';

const SNAP_CONTEXT_PAD_SEC = 0.5;
const MAX_CACHE_ENTRIES_PER_BUFFER = 24;

interface CachedPeakWindow {
  audioOffset: number;
  xmin: number;
  xmax: number;
  peaks: AcousticSnapPeak[];
}

const peakCacheByBuffer = new WeakMap<AudioBuffer, CachedPeakWindow[]>();
const inflightByBuffer = new WeakMap<AudioBuffer, Map<string, Promise<AcousticSnapPeak[]>>>();

function extractMonoSlice(
  audioBuffer: AudioBuffer,
  startSec: number,
  endSec: number
): { mono: Float32Array; sampleRate: number; originSec: number } | null {
  const sampleRate = audioBuffer.sampleRate;
  const totalSamples = audioBuffer.length;
  const numChannels = audioBuffer.numberOfChannels;
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate < 4000 ||
    totalSamples <= 0 ||
    numChannels <= 0 ||
    !Number.isFinite(startSec) ||
    !Number.isFinite(endSec) ||
    endSec <= startSec
  ) {
    return null;
  }

  const startIdx = Math.max(0, Math.min(totalSamples, Math.floor(startSec * sampleRate)));
  const endIdx = Math.max(startIdx, Math.min(totalSamples, Math.ceil(endSec * sampleRate)));
  const sliceLen = endIdx - startIdx;
  if (sliceLen < 16) {
    return null;
  }

  let mono: Float32Array;
  if (numChannels === 1) {
    mono = audioBuffer.getChannelData(0).subarray(startIdx, endIdx);
  } else {
    mono = new Float32Array(sliceLen);
    const invCh = 1 / numChannels;
    for (let ch = 0; ch < numChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < sliceLen; i++) {
        mono[i] += data[startIdx + i] * invCh;
      }
    }
  }

  return {
    mono,
    sampleRate: Math.round(sampleRate),
    originSec: startIdx / sampleRate
  };
}

/**
 * Synchronously lookup cached acoustic snap peaks covering `[xmin, xmax]` (in grid time).
 */
export function getCachedAcousticSnapPeaks(
  audioBuffer: AudioBuffer | null,
  audioOffset: number,
  xmin: number,
  xmax: number
): AcousticSnapPeak[] | null {
  if (!audioBuffer) return null;
  const entries = peakCacheByBuffer.get(audioBuffer);
  if (!entries || entries.length === 0) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (
      Math.abs(e.audioOffset - audioOffset) <= 1e-6 &&
      e.xmin <= xmin + 1e-3 &&
      e.xmax >= xmax - 1e-3
    ) {
      return e.peaks;
    }
  }
  return null;
}

/**
 * Asynchronously extract and cache `TGrid-AcouSeg 1.0` acoustic boundary candidate peaks
 * for `[xmin, xmax]` (in grid time). Peaks are returned sorted by ascending `timeSec` (grid time).
 */
export async function prefetchAcousticSnapPeaks(
  audioBuffer: AudioBuffer | null,
  audioOffset: number,
  xmin: number,
  xmax: number
): Promise<AcousticSnapPeak[]> {
  if (!audioBuffer || !Number.isFinite(xmin) || !Number.isFinite(xmax) || xmax <= xmin) {
    return [];
  }

  const audioDur = audioBuffer.duration;
  const clampedMin = Math.max(audioOffset, xmin);
  const clampedMax = Math.min(audioOffset + audioDur, xmax);
  if (clampedMax <= clampedMin + 0.01) {
    return [];
  }

  const cached = getCachedAcousticSnapPeaks(audioBuffer, audioOffset, clampedMin, clampedMax);
  if (cached) return cached;

  const key = `${audioOffset.toFixed(4)}:${clampedMin.toFixed(2)}:${clampedMax.toFixed(2)}`;
  let inflightMap = inflightByBuffer.get(audioBuffer);
  if (!inflightMap) {
    inflightMap = new Map();
    inflightByBuffer.set(audioBuffer, inflightMap);
  }
  const existing = inflightMap.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const localMin = clampedMin - audioOffset;
      const localMax = clampedMax - audioOffset;
      const slice = extractMonoSlice(
        audioBuffer,
        localMin - SNAP_CONTEXT_PAD_SEC,
        localMax + SNAP_CONTEXT_PAD_SEC
      );
      if (!slice) return [];

      const rawPeaks = await getPlatformBridge().extractAcousticSnapPeaks(
        slice.mono,
        slice.sampleRate,
        slice.originSec,
        localMin,
        localMax
      );

      const gridPeaks: AcousticSnapPeak[] = rawPeaks.map((p) => ({
        timeSec: Number((p.timeSec + audioOffset).toFixed(6)),
        strength: p.strength,
        kind: p.kind
      }));

      let entries = peakCacheByBuffer.get(audioBuffer);
      if (!entries) {
        entries = [];
        peakCacheByBuffer.set(audioBuffer, entries);
      }
      entries.push({
        audioOffset,
        xmin: clampedMin,
        xmax: clampedMax,
        peaks: gridPeaks
      });
      if (entries.length > MAX_CACHE_ENTRIES_PER_BUFFER) {
        entries.shift();
      }
      return gridPeaks;
    } catch {
      return [];
    } finally {
      inflightMap?.delete(key);
    }
  })();

  inflightMap.set(key, promise);
  return promise;
}

/**
 * One-click snap of a single grid timestamp to the strongest nearby `TGrid-AcouSeg 1.0`
 * phone/syllable boundary within `±windowSec` (default 45 ms).
 */
export async function snapBoundaryAcoustically(
  audioBuffer: AudioBuffer | null,
  audioOffset: number,
  targetTimeSec: number,
  windowSec = 0.045
): Promise<AcousticSnapResult> {
  if (!audioBuffer || !Number.isFinite(targetTimeSec)) {
    return {
      found: false,
      snappedTimeSec: targetTimeSec,
      confidence: 0,
      kind: 'none'
    };
  }

  const localTarget = targetTimeSec - audioOffset;
  const pad = windowSec + SNAP_CONTEXT_PAD_SEC;
  const slice = extractMonoSlice(audioBuffer, localTarget - pad, localTarget + pad);
  if (!slice) {
    return {
      found: false,
      snappedTimeSec: targetTimeSec,
      confidence: 0,
      kind: 'none'
    };
  }

  const res = await getPlatformBridge().snapAcousticBoundary(
    slice.mono,
    slice.sampleRate,
    slice.originSec,
    localTarget,
    windowSec
  );

  if (!res.found || !Number.isFinite(res.snappedTimeSec)) {
    return {
      found: false,
      snappedTimeSec: targetTimeSec,
      confidence: 0,
      kind: 'none'
    };
  }

  return {
    found: true,
    snappedTimeSec: Number((res.snappedTimeSec + audioOffset).toFixed(6)),
    confidence: res.confidence,
    kind: res.kind
  };
}

/**
 * Format a concise user-facing toast message for one-click acoustic boundary snap.
 */
export function formatAcousticSnapToast(
  origTimeSec: number,
  snappedTimeSec: number,
  prefix = '已吸附至声学边界'
): string {
  const deltaMs = Math.round((snappedTimeSec - origTimeSec) * 1000);
  const deltaStr = deltaMs >= 0 ? `+${deltaMs} ms` : `${deltaMs} ms`;
  return `${prefix} (${snappedTimeSec.toFixed(3)} s, ${deltaStr})`;
}
