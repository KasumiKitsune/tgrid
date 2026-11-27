import { getPlatformBridge } from '../bridge/PlatformBridge';
import type { AcousticSegmentClass, SmartSplitGranularity } from './smartSplit';

export interface AcousticSplitRequest {
  audioBuffer: AudioBuffer;
  xmin: number;
  xmax: number;
  granularity: SmartSplitGranularity;
  durationWeights: readonly number[];
  acousticClasses: readonly AcousticSegmentClass[];
}

export interface AcousticSplitResponse {
  /** Length = K - 1 strictly increasing interior timestamps in seconds */
  cuts: number[];
  confidence: number;
  usedAcoustic: boolean;
}

const SLICE_PAD_SEC = 0.05;

export async function alignSplitBoundariesAcoustically(
  req: AcousticSplitRequest
): Promise<AcousticSplitResponse | null> {
  const { audioBuffer, xmin, xmax, granularity, durationWeights, acousticClasses } = req;
  if (!audioBuffer || durationWeights.length < 2) {
    return null;
  }

  const sampleRate = audioBuffer.sampleRate;
  const totalSamples = audioBuffer.length;
  const numChannels = audioBuffer.numberOfChannels;

  if (
    !Number.isFinite(sampleRate) ||
    sampleRate < 4000 ||
    totalSamples <= 0 ||
    numChannels <= 0 ||
    !Number.isFinite(xmin) ||
    !Number.isFinite(xmax) ||
    xmax <= xmin
  ) {
    return null;
  }

  const startIdx = Math.max(
    0,
    Math.min(totalSamples, Math.floor((xmin - SLICE_PAD_SEC) * sampleRate))
  );
  const endIdx = Math.max(
    startIdx,
    Math.min(totalSamples, Math.ceil((xmax + SLICE_PAD_SEC) * sampleRate))
  );
  const sliceLen = endIdx - startIdx;
  if (sliceLen <= 0) {
    return null;
  }

  let mono: Float32Array;
  if (numChannels === 1) {
    mono = audioBuffer.getChannelData(0).subarray(startIdx, endIdx);
  } else {
    mono = new Float32Array(sliceLen);
    const invChannels = 1 / numChannels;
    for (let ch = 0; ch < numChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < sliceLen; i++) {
        mono[i] += data[startIdx + i] * invChannels;
      }
    }
  }

  const bridge = getPlatformBridge();
  const res = await bridge.alignSplitBoundaries(mono, {
    sampleRate: Math.round(sampleRate),
    samplesOriginSec: startIdx / sampleRate,
    xmin,
    xmax,
    granularity,
    durationWeights: Array.from(durationWeights),
    acousticClasses: Array.from(acousticClasses)
  });

  return {
    cuts: res.cuts,
    confidence: res.confidence,
    usedAcoustic: !res.fallbackToEqual
  };
}
