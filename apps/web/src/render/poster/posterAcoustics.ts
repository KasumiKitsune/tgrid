import type { AudioAnalysisSummary, PlatformBridge } from '../../bridge/types';
import type { PolarDiscRasterResult } from './types';

/**
 * Normalized STFT spectrogram matrix (`cols × rows`), row 0 = 0 Hz (low freq), row `rows - 1` = maxFreq.
 * Values are normalized in `[0, 1]` where 1 = strongest acoustic energy.
 */
export interface PosterSpecMatrix {
  cols: number;
  rows: number;
  /** Row-major `[row * cols + col]`, row 0 = 0 Hz, row rows-1 = maxFreq. */
  data: Float32Array;
}

export interface PosterAcousticMetrics {
  peakDb: number | null;
  meanF0: number | null;
}

const MAX_SPEC_CACHE = 16;
const specMatrixCache = new Map<string, PosterSpecMatrix>();

export function clearPosterAcousticsCache(): void {
  specMatrixCache.clear();
}

export function prunePosterAcousticsCacheForSession(sessionId: number): void {
  const prefix = `${sessionId}|`;
  for (const key of Array.from(specMatrixCache.keys())) {
    if (key.startsWith(prefix)) {
      specMatrixCache.delete(key);
    }
  }
}

function setSpecCache(key: string, val: PosterSpecMatrix): void {
  if (specMatrixCache.has(key)) specMatrixCache.delete(key);
  specMatrixCache.set(key, val);
  while (specMatrixCache.size > MAX_SPEC_CACHE) {
    const first = specMatrixCache.keys().next().value;
    if (first !== undefined) specMatrixCache.delete(first);
    else break;
  }
}

/**
 * Fetch real STFT spectrogram matrix from TGrid's Rust/WASM DSP bridge (`bw` palette),
 * flipped cleanly so row 0 = 0 Hz and row `rows - 1` = `maxFreq`.
 */
export async function fetchPosterSpecMatrix(params: {
  bridge: PlatformBridge;
  analysis: AudioAnalysisSummary | null;
  hasAudio: boolean;
  showSpectrogram: boolean;
  tMin: number;
  tMax: number;
  maxFreq: number;
  dynRange: number;
  previewMode: boolean;
}): Promise<PosterSpecMatrix | null> {
  if (!params.hasAudio || !params.analysis || !params.showSpectrogram) {
    return null;
  }
  const targetCols = params.previewMode ? 480 : 960;
  const targetRows = params.previewMode ? 128 : 224;
  const key = [
    params.analysis.sessionId,
    params.tMin.toFixed(4),
    params.tMax.toFixed(4),
    params.maxFreq,
    params.dynRange,
    targetCols,
    targetRows
  ].join('|');

  if (params.previewMode) {
    const hit = specMatrixCache.get(key);
    if (hit) return hit;
  }

  const seg = {
    x0: 0,
    x1: targetCols,
    t0: params.tMin,
    t1: params.tMax,
    collapsed: false
  };
  const rgbaRes = await params.bridge.renderSpectrogramRgba(
    params.analysis.sessionId,
    [seg],
    0,
    targetCols,
    targetRows,
    params.maxFreq,
    1,
    params.dynRange,
    'bw'
  );
  if (
    rgbaRes.width < 2 ||
    rgbaRes.height < 2 ||
    rgbaRes.rgba.length < rgbaRes.width * rgbaRes.height * 4
  ) {
    return null;
  }

  const cols = rgbaRes.width;
  const rows = rgbaRes.height;
  const out = new Float32Array(cols * rows);
  const src = rgbaRes.rgba;

  // Rust `renderSpectrogramRgba` outputs row 0 = maxFreq, row rows-1 = 0 Hz.
  // Flip vertically here so consumers can rely on row 0 = 0 Hz, row rows-1 = maxFreq.
  for (let r = 0; r < rows; r++) {
    const srcRow = rows - 1 - r;
    const dstOff = r * cols;
    const srcOff = srcRow * cols;
    for (let c = 0; c < cols; c++) {
      out[dstOff + c] = (255 - src[(srcOff + c) * 4]) / 255.0;
    }
  }

  const result: PosterSpecMatrix = { cols, rows, data: out };
  if (params.previewMode) {
    setSpecCache(key, result);
  }
  return result;
}

function sampleSpecBilinear(mat: PosterSpecMatrix, uTime: number, uFreq: number): number {
  const { cols, rows, data } = mat;
  const fc = Math.max(0, Math.min(cols - 1.0001, uTime * (cols - 1)));
  const fr = Math.max(0, Math.min(rows - 1.0001, uFreq * (rows - 1)));
  const c0 = fc | 0;
  const r0 = fr | 0;
  const c1 = c0 + 1 < cols ? c0 + 1 : c0;
  const r1 = r0 + 1 < rows ? r0 + 1 : r0;
  const wc = fc - c0;
  const wr = fr - r0;
  const off0 = r0 * cols;
  const off1 = r1 * cols;
  const top = data[off0 + c0] * (1 - wc) + data[off0 + c1] * wc;
  const bot = data[off1 + c0] * (1 - wc) + data[off1 + c1] * wc;
  return top * (1 - wr) + bot * wr;
}

/**
 * Compute real peak amplitude (dB) and mean voiced F0 (Hz) inside `[tMin, tMax]`.
 */
export function computePosterAcousticMetrics(params: {
  hasAudio: boolean;
  audioBuffer: AudioBuffer | null;
  audioOffset: number;
  analysis: AudioAnalysisSummary | null;
  tMin: number;
  tMax: number;
}): PosterAcousticMetrics {
  const { hasAudio, audioBuffer, audioOffset, analysis, tMin, tMax } = params;
  if (!hasAudio) return { peakDb: null, meanF0: null };

  // 1. Peak dB inside active [tMin, tMax] slice
  let peakAmp = 0;
  if (audioBuffer && audioBuffer.length > 0 && tMax > tMin) {
    const sr = audioBuffer.sampleRate;
    const ch0 = audioBuffer.getChannelData(0);
    const s0 = Math.max(0, Math.min(ch0.length - 1, Math.floor((tMin - audioOffset) * sr)));
    const s1 = Math.max(s0 + 1, Math.min(ch0.length, Math.ceil((tMax - audioOffset) * sr)));
    const step = s1 - s0 > 120_000 ? Math.floor((s1 - s0) / 60_000) : 1;
    for (let i = s0; i < s1; i += step) {
      const v = Math.abs(ch0[i]);
      if (v > peakAmp) peakAmp = v;
    }
  } else if (analysis && analysis.peakAmplitude > 0) {
    peakAmp = analysis.peakAmplitude;
  }

  const peakDb =
    peakAmp > 1e-5
      ? Math.max(-30, Math.min(0, Math.round(20 * Math.log10(peakAmp) * 10) / 10))
      : null;

  // 2. Mean voiced F0 inside [tMin, tMax]
  let meanF0: number | null = null;
  if (analysis?.pitchTrack?.length) {
    let sum = 0;
    let cnt = 0;
    for (const pt of analysis.pitchTrack) {
      if (pt.t < tMin - 1e-6 || pt.t > tMax + 1e-6) continue;
      if (pt.f0 !== null && Number.isFinite(pt.f0) && pt.f0 >= 45 && pt.f0 <= 800) {
        sum += pt.f0;
        cnt++;
      }
    }
    if (cnt > 0) {
      meanF0 = Math.round((sum / cnt) * 10) / 10;
    }
  }

  return { peakDb, meanF0 };
}

/**
 * Braun Strip Recorder: High-resolution monochrome charcoal spectrogram on crisp white strip paper.
 */
export function renderBraunSpectrogramDataUrl(params: {
  spec: PosterSpecMatrix;
  tMin: number;
  tMax: number;
  xLeft: number;
  trackWidth: number;
  specHeight: number;
  xToTime: (x: number) => number;
  silenceBreakRangesPx: Array<[number, number]>;
  previewMode: boolean;
}): string {
  const { spec, tMin, tMax, xLeft, trackWidth, specHeight, xToTime, silenceBreakRangesPx, previewMode } =
    params;
  const scale = previewMode ? 1.5 : 3.0;
  const W = Math.max(40, Math.round(trackWidth * scale));
  const H = Math.max(20, Math.round(specHeight * scale));
  const cvs = document.createElement('canvas');
  cvs.width = W;
  cvs.height = H;
  const ctx = cvs.getContext('2d');
  if (!ctx) return '';

  const img = ctx.createImageData(W, H);
  const out = img.data;
  const dur = Math.max(1e-5, tMax - tMin);

  for (let px = 0; px < W; px++) {
    const localX = px / scale;
    let inBreak = false;
    for (let b = 0; b < silenceBreakRangesPx.length; b++) {
      if (localX >= silenceBreakRangesPx[b][0] && localX <= silenceBreakRangesPx[b][1]) {
        inBreak = true;
        break;
      }
    }

    const t = xToTime(xLeft + localX);
    const uTime = Math.max(0, Math.min(1, (t - tMin) / dur));

    for (let py = 0; py < H; py++) {
      const idx = (py * W + px) * 4;
      if (inBreak) {
        out[idx] = 255;
        out[idx + 1] = 255;
        out[idx + 2] = 255;
        out[idx + 3] = 255;
        continue;
      }
      const uFreq = 1.0 - py / Math.max(1, H - 1);
      const rawVal = sampleSpecBilinear(spec, uTime, uFreq);

      // Clean archival noise-floor gate + S-curve formant contrast so paper stays pure #FFFFFF
      let ink = 0;
      if (rawVal > 0.075) {
        const norm = Math.max(0, Math.min(1, (rawVal - 0.075) / 0.84));
        // Gentle S-curve: suppresses low-level haze while keeping speech formants crisp & velvety
        const shaped = Math.pow(norm, 0.92);
        const sCurve = shaped * shaped * (3 - 2 * shaped);
        ink = Math.min(1, shaped * 0.42 + sCurve * 0.64);
      }

      // Archival carbon-graphite ink (#161614) over crisp #FFFFFF chart paper
      out[idx] = Math.round(255 - ink * (255 - 22));
      out[idx + 1] = Math.round(255 - ink * (255 - 22));
      out[idx + 2] = Math.round(255 - ink * (255 - 20));
      out[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  return cvs.toDataURL('image/png');
}

function inkMountainColor(intensity: number, vFreq: number): [number, number, number, number] {
  if (intensity <= 0.032) return [246, 243, 235, 0];
  const t = Math.min(1, Math.pow((intensity - 0.032) / 0.968, 0.74));
  // Song/Ming mineral pigment depth: deeper azurite/pine-soot ink at low-mid frequencies,
  // luminous malachite-celadon through mid harmonics, delicate jade mist at upper crest.
  const freqShift = Math.max(0, Math.min(1, vFreq));
  let r: number;
  let g: number;
  let b: number;
  let a: number;
  if (t < 0.34) {
    const k = t / 0.34;
    r = 178 + (104 - 178) * k;
    g = 205 + (158 - 205) * k;
    b = 197 + (153 - 197) * k;
    a = k * 0.56;
  } else if (t < 0.70) {
    const k = (t - 0.34) / 0.36;
    r = 104 + (42 - 104) * k;
    g = 158 + (105 - 158) * k;
    b = 153 + (109 - 153) * k;
    a = 0.56 + k * 0.30;
  } else {
    const k = (t - 0.70) / 0.30;
    r = 42 + (20 - 42) * k;
    g = 105 + (55 - 105) * k;
    b = 109 + (62 - 109) * k;
    a = 0.86 + k * 0.11;
  }
  // Subtle malachite warmth in mid-upper hills, deeper pine-ink shadow at valley base
  const midLift = Math.sin(freqShift * Math.PI);
  r = Math.max(16, Math.min(235, r + midLift * 6 - (1 - freqShift) * 7));
  g = Math.max(38, Math.min(235, g + midLift * 10 - (1 - freqShift) * 5));
  b = Math.max(44, Math.min(235, b + midLift * 4));
  // Poetic upper-edge mist airiness
  if (freqShift > 0.78) {
    const mistK = (freqShift - 0.78) / 0.22;
    a *= 1 - mistK * 0.28;
  }
  return [r, g, b, a];
}

/**
 * Oriental Folding Fan: Tightly cropped polar mineral azurite/turquoise ink-wash mountain
 * spectrogram (`rSpecIn..rSpecOut`, `degStart..degEnd`) with alpha transparency so it composites
 * natively over Xuan paper OR transparent emblem backgrounds.
 */
export function renderFanSpectrogramRaster(params: {
  spec: PosterSpecMatrix;
  waveformBins: Array<[number, number]> | null;
  cx: number;
  cy: number;
  degStart: number;
  degEnd: number;
  rSpecIn: number;
  rSpecOut: number;
  mistZones: Array<{ u0: number; u1: number }>;
  previewMode: boolean;
}): PolarDiscRasterResult | null {
  const { spec, waveformBins, cx, cy, degStart, degEnd, rSpecIn, rSpecOut, mistZones, previewMode } =
    params;

  // Tight bounding box covering the open folding-fan arc sector (safe for degEnd up to +12°)
  const pad = 4.0;
  const x0Pt = Math.floor(cx - rSpecOut - pad);
  const x1Pt = Math.ceil(cx + rSpecOut + pad);
  const y0Pt = Math.floor(cy - rSpecOut - pad);
  const y1Pt = Math.ceil(cy + rSpecOut * 0.24 + pad);
  const widthPt = x1Pt - x0Pt;
  const heightPt = y1Pt - y0Pt;

  const pxPerPt = previewMode ? 1.5 : 3.2;
  const W = Math.max(16, Math.round(widthPt * pxPerPt));
  const H = Math.max(16, Math.round(heightPt * pxPerPt));
  const cvs = document.createElement('canvas');
  cvs.width = W;
  cvs.height = H;
  const ctx = cvs.getContext('2d');
  if (!ctx) return null;

  // Smooth amplitude mountain crest envelope from waveform bins (or poetic undulating fallback)
  const envLen = 360;
  const smoothEnv = new Float32Array(envLen);
  if (waveformBins && waveformBins.length >= 4) {
    const rawEnv = new Float32Array(envLen);
    let peak = 0.05;
    for (let i = 0; i < envLen; i++) {
      const wi = Math.min(waveformBins.length - 1, Math.floor((i / envLen) * waveformBins.length));
      const amp = Math.max(Math.abs(waveformBins[wi][0]), Math.abs(waveformBins[wi][1]));
      rawEnv[i] = amp;
      if (amp > peak) peak = amp;
    }
    for (let i = 0; i < envLen; i++) {
      let sum = 0;
      let wSum = 0;
      for (let k = -5; k <= 5; k++) {
        const idx = Math.max(0, Math.min(envLen - 1, i + k));
        const w = 6 - Math.abs(k);
        sum += (rawEnv[idx] / peak) * w;
        wSum += w;
      }
      smoothEnv[i] = sum / wSum;
    }
  } else {
    smoothEnv.fill(0.65);
  }

  const img = ctx.createImageData(W, H);
  const out = img.data;
  const invScale = 1.0 / pxPerPt;
  const RAD2DEG = 180.0 / Math.PI;
  const degSpan = Math.max(1e-4, degEnd - degStart);
  const rSpan = Math.max(1e-4, rSpecOut - rSpecIn);

  for (let py = 0; py < H; py++) {
    const dy = y0Pt + (py + 0.5) * invScale - cy;
    const rowOff = py * W * 4;
    for (let px = 0; px < W; px++) {
      const dx = x0Pt + (px + 0.5) * invScale - cx;
      const r = Math.hypot(dx, dy);
      if (r < rSpecIn - 0.5 || r > rSpecOut + 0.5) continue;

      const deg = Math.atan2(dy, dx) * RAD2DEG;
      if (deg < degStart - 0.25 || deg > degEnd + 0.25) continue;

      const u = Math.max(0, Math.min(1, (deg - degStart) / degSpan));
      const v = Math.max(0, Math.min(1, (r - rSpecIn) / rSpan));
      const specVal = sampleSpecBilinear(spec, u, v);

      const ei = Math.min(envLen - 1, Math.floor(u * envLen));
      const envH = 0.26 + 0.74 * Math.pow(smoothEnv[ei], 0.50);
      const mountainMask =
        v <= envH
          ? 1.0
          : Math.max(0.26, Math.exp(-Math.pow((v - envH) / 0.28, 2)) + specVal * 0.62);

      // Smoothstep misty-valley dissolution across long pauses instead of sharp rectangular cuts
      let mistFactor = 1.0;
      for (let mz = 0; mz < mistZones.length; mz++) {
        const z = mistZones[mz];
        if (u >= z.u0 && u <= z.u1) {
          const edgeDist = Math.min(u - z.u0, z.u1 - u);
          const fadeSpan = Math.min(0.026, (z.u1 - z.u0) * 0.44);
          if (edgeDist < fadeSpan && fadeSpan > 1e-6) {
            const p = edgeDist / fadeSpan;
            const smooth = p * p * (3 - 2 * p);
            mistFactor = 0.08 + (1 - smooth) * 0.52;
          } else {
            mistFactor = 0.08;
          }
          break;
        }
      }

      const innerFeather = Math.min(1, Math.max(0, (r - (rSpecIn - 0.5)) / 3.2));
      const outerFeather = Math.min(1, Math.max(0, (rSpecOut + 0.5 - r) / 4.2));
      // Subtle lower-valley ink grounding wash under voiced regions
      const valleyLift = v < 0.16 && smoothEnv[ei] > 0.08 ? (1 - v / 0.16) * 0.14 * smoothEnv[ei] : 0;
      const eff = Math.min(
        1,
        (specVal * mountainMask * 1.22 + valleyLift) * mistFactor * innerFeather * outerFeather
      );
      if (eff <= 0.032) continue;

      const [cr, cg, cb, ca] = inkMountainColor(eff, v);
      const off = rowOff + px * 4;
      out[off] = Math.round(cr);
      out[off + 1] = Math.round(cg);
      out[off + 2] = Math.round(cb);
      out[off + 3] = Math.round(Math.max(0, Math.min(1, ca)) * 255);
    }
  }

  ctx.putImageData(img, 0, 0);
  const dataUrl = cvs.toDataURL('image/png');
  if (!dataUrl) return null;

  return { dataUrl, xPt: x0Pt, yPt: y0Pt, widthPt, heightPt };
}

function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let cachedGrainTileCanvas: HTMLCanvasElement | null = null;
function getRisoGrainTileCanvas(): HTMLCanvasElement | null {
  if (cachedGrainTileCanvas) return cachedGrainTileCanvas;
  if (typeof document === 'undefined') return null;
  const tile = document.createElement('canvas');
  tile.width = 160;
  tile.height = 160;
  const tctx = tile.getContext('2d');
  if (!tctx) return null;
  const img = tctx.createImageData(160, 160);
  const rng = makeSeededRng(20261126);
  for (let i = 0; i < img.data.length; i += 4) {
    const r = rng();
    const punch = r < 0.07 ? 52 : r < 0.21 ? 24 : 0;
    img.data[i] = 0;
    img.data[i + 1] = 0;
    img.data[i + 2] = 0;
    img.data[i + 3] = punch;
  }
  tctx.putImageData(img, 0, 0);
  cachedGrainTileCanvas = tile;
  return tile;
}

export interface RisoPieceSegment {
  t0: number;
  t1: number;
  x0: number;
  x1: number;
}

export interface RisoPieceBreak {
  t0: number;
  t1: number;
  dur: number;
  x0: number;
  x1: number;
  xc: number;
}

/**
 * Risograph Sound Print: Renders the iconic 3-plate overprint halftone spectrogram,
 * dual-plate offset waveform, smooth yellow+pink F0 pitch curve, and `//` silence marks
 * on an offscreen Canvas with genuine soybean-ink stencil grain and `multiply` compositing.
 * Output has a clean transparent background so it layers over `#F8F4EA` paper or transparent exports!
 */
export function renderRisoAcousticBandDataUrl(params: {
  spec: PosterSpecMatrix | null;
  waveformBins: Array<[number, number]> | null;
  f0Runs: Array<Array<{ t: number; normF0: number }>>;
  showSpectrogram: boolean;
  showWaveform: boolean;
  showPitch: boolean;
  hasAudio: boolean;
  tMin: number;
  tMax: number;
  contentLeft: number;
  contentW: number;
  waveTop: number;
  waveH: number;
  specTop: number;
  specH: number;
  segments: RisoPieceSegment[];
  breaks: RisoPieceBreak[];
  timeToX: (t: number) => number;
  xToTime: (x: number) => number;
  previewMode: boolean;
}): { dataUrl: string; xPt: number; yPt: number; widthPt: number; heightPt: number } | null {
  const {
    spec,
    waveformBins,
    f0Runs,
    showSpectrogram,
    showWaveform,
    showPitch,
    hasAudio,
    tMin,
    tMax,
    contentLeft,
    contentW,
    waveTop,
    waveH,
    specTop,
    specH,
    segments,
    breaks,
    timeToX,
    xToTime,
    previewMode
  } = params;

  const pad = 8;
  const x0Pt = contentLeft - pad;
  const y0Pt = waveTop - pad;
  const widthPt = contentW + pad * 2;
  const heightPt = specTop + specH - waveTop + pad * 2;
  const scale = previewMode ? 1.5 : 3.0;

  const W = Math.max(32, Math.round(widthPt * scale));
  const H = Math.max(32, Math.round(heightPt * scale));

  const makePlate = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.scale(scale, scale);
      ctx.translate(-x0Pt, -y0Pt);
    }
    return { canvas: c, ctx };
  };

  const yellow = makePlate();
  const pink = makePlate();
  const cyan = makePlate();
  if (!yellow.ctx || !pink.ctx || !cyan.ctx) return null;

  const pYellow = yellow.ctx;
  const pPink = pink.ctx;
  const pCyan = cyan.ctx;

  const RISO_PINK = '#FF5277';
  const RISO_CYAN = '#00A5C8';
  const RISO_YELLOW = '#FFD026';

  const waveMidY = waveTop + waveH * 0.5;
  const specBot = specTop + specH;
  const dur = Math.max(1e-5, tMax - tMin);

  const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
    const rr = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  };

  for (const seg of segments) {
    const segW = seg.x1 - seg.x0;
    if (segW < 2) continue;

    // Subtle warm paper-tint substrate behind each active spectrogram plate
    pYellow.save();
    pYellow.fillStyle = RISO_YELLOW;
    pYellow.globalAlpha = 0.08;
    roundRect(pYellow, seg.x0, specTop, segW, specH, 2.5);
    pYellow.fill();
    pYellow.restore();

    // Precision cyan plate framing hairlines (top & bottom of spectrogram + waveform zero axis)
    pCyan.save();
    pCyan.strokeStyle = RISO_CYAN;
    pCyan.globalAlpha = 0.28;
    pCyan.lineWidth = 0.7;
    pCyan.beginPath();
    pCyan.moveTo(seg.x0, waveMidY);
    pCyan.lineTo(seg.x1, waveMidY);
    pCyan.moveTo(seg.x0, specTop);
    pCyan.lineTo(seg.x1, specTop);
    pCyan.moveTo(seg.x0, specBot);
    pCyan.lineTo(seg.x1, specBot);
    pCyan.stroke();

    // Subtle mid-frequency guide rule inside spectrogram plate
    pCyan.globalAlpha = 0.12;
    pCyan.lineWidth = 0.55;
    pCyan.setLineDash([2.5, 4.0]);
    pCyan.beginPath();
    pCyan.moveTo(seg.x0, specTop + specH * 0.5);
    pCyan.lineTo(seg.x1, specTop + specH * 0.5);
    pCyan.stroke();
    pCyan.restore();

    // Crisp dual-plate offset waveform (Sunflower Yellow under-pass + Coral Pink key pass)
    if (hasAudio && showWaveform && waveformBins && waveformBins.length > 0) {
      const stepPx = 2.4;
      pYellow.save();
      pPink.save();
      pYellow.strokeStyle = RISO_YELLOW;
      pPink.strokeStyle = RISO_PINK;
      pYellow.lineWidth = 1.25;
      pPink.lineWidth = 1.15;
      pYellow.lineCap = 'round';
      pPink.lineCap = 'round';
      pYellow.globalAlpha = 0.88;
      pPink.globalAlpha = 0.86;

      for (let x = seg.x0 + 1.2; x <= seg.x1 - 1.2; x += stepPx) {
        const t = xToTime(x);
        const norm = (t - tMin) / dur;
        const bIdx = Math.min(waveformBins.length - 1, Math.max(0, Math.floor(norm * waveformBins.length)));
        const lo = Math.max(-1, Math.min(0, waveformBins[bIdx][0]));
        const hi = Math.max(0, Math.min(1, waveformBins[bIdx][1]));
        const ampHi = Math.pow(hi, 0.76) * (waveH * 0.47);
        const ampLo = Math.pow(Math.abs(lo), 0.76) * (waveH * 0.47);
        if (ampHi + ampLo < 0.75) continue;

        pYellow.beginPath();
        pYellow.moveTo(x + 1.35, waveMidY - ampHi + 0.95);
        pYellow.lineTo(x + 1.35, waveMidY + ampLo + 0.95);
        pYellow.stroke();

        pPink.beginPath();
        pPink.moveTo(x, waveMidY - ampHi);
        pPink.lineTo(x, waveMidY + ampLo);
        pPink.stroke();
      }
      pYellow.restore();
      pPink.restore();
    } else if (!hasAudio) {
      // No-Audio geometric Risograph pulse rhythm dots
      pPink.save();
      pYellow.save();
      pPink.fillStyle = RISO_PINK;
      pYellow.fillStyle = RISO_YELLOW;
      pPink.globalAlpha = 0.56;
      pYellow.globalAlpha = 0.68;
      for (let x = seg.x0 + 5; x <= seg.x1 - 5; x += 8.5) {
        const wave = 0.42 + 0.58 * Math.abs(Math.sin(x * 0.068));
        const r = 1.25 + wave * 1.75;
        pYellow.beginPath();
        pYellow.arc(x + 1.15, waveMidY + 0.85, r, 0, Math.PI * 2);
        pYellow.fill();
        pPink.beginPath();
        pPink.arc(x, waveMidY, r * 0.85, 0, Math.PI * 2);
        pPink.fill();
      }
      pPink.restore();
      pYellow.restore();
    }

    // Authentic 3-Plate Staggered Risograph Halftone Dot Spectrogram
    // (Lake Cyan harmonic body + Coral Pink formant peaks + warm Yellow vocalic core)
    if (hasAudio && showSpectrogram && spec) {
      const dotStepX = 3.6;
      const dotStepY = 3.5;
      pCyan.save();
      pPink.save();
      pYellow.save();
      pCyan.fillStyle = RISO_CYAN;
      pPink.fillStyle = RISO_PINK;
      pYellow.fillStyle = RISO_YELLOW;
      pCyan.globalAlpha = 0.86;
      pPink.globalAlpha = 0.68;
      pYellow.globalAlpha = 0.42;

      let rowCounter = 0;
      for (let y = specTop + 2.2; y <= specBot - 2.2; y += dotStepY) {
        const freqNorm = 1 - (y - specTop) / specH;
        const stagger = rowCounter % 2 === 1 ? dotStepX * 0.5 : 0;
        rowCounter++;

        for (let x = seg.x0 + 1.8 + stagger; x <= seg.x1 - 1.8; x += dotStepX) {
          const t = xToTime(x);
          const tNorm = Math.max(0, Math.min(1, (t - tMin) / dur));
          const val = sampleSpecBilinear(spec, tNorm, freqNorm);
          if (val < 0.095) continue;

          const intensity = Math.pow((val - 0.095) / 0.905, 0.86);
          const radius = 0.36 + intensity * 1.54;
          pCyan.beginPath();
          pCyan.arc(x, y, radius, 0, Math.PI * 2);
          pCyan.fill();

          if (val > 0.34 && freqNorm < 0.52) {
            const yRad = 0.32 + ((val - 0.34) / 0.66) * 0.92;
            pYellow.beginPath();
            pYellow.arc(x - 0.65, y + 0.6, yRad, 0, Math.PI * 2);
            pYellow.fill();
          }

          if (val > 0.485) {
            const pRadius = 0.32 + ((val - 0.485) / 0.515) * 1.12;
            pPink.beginPath();
            pPink.arc(x + 0.82, y - 0.62, pRadius, 0, Math.PI * 2);
            pPink.fill();
          }
        }
      }
      pYellow.restore();
      pCyan.restore();
      pPink.restore();
    } else {
      // Refined geometric Risograph halftone matrix when no audio or spectrogram disabled
      pCyan.save();
      pPink.save();
      pCyan.fillStyle = RISO_CYAN;
      pPink.fillStyle = RISO_PINK;
      pCyan.globalAlpha = 0.26;
      pPink.globalAlpha = 0.14;
      const dotStep = 7.4;
      let rc = 0;
      for (let y = specTop + 6; y <= specBot - 6; y += dotStep) {
        const st = rc % 2 === 1 ? dotStep * 0.5 : 0;
        rc++;
        const vNorm = 1 - (y - specTop) / specH;
        const bandEnv = Math.exp(-Math.pow((vNorm - 0.34) / 0.28, 2));
        for (let x = seg.x0 + 5 + st; x <= seg.x1 - 5; x += dotStep) {
          const r = 0.78 + bandEnv * 1.28 * (0.62 + 0.38 * Math.sin(x * 0.042 + rc));
          pCyan.beginPath();
          pCyan.arc(x, y, r, 0, Math.PI * 2);
          pCyan.fill();
          if (bandEnv > 0.68) {
            pPink.beginPath();
            pPink.arc(x + 0.8, y - 0.6, r * 0.62, 0, Math.PI * 2);
            pPink.fill();
          }
        }
      }
      pPink.restore();
      pCyan.restore();
    }
  }

  // Smooth F0 Pitch Melody Ribbon (Sunflower Yellow under-stroke + Coral Pink core stroke)
  if (hasAudio && showPitch && f0Runs.length > 0) {
    const strokeSmooth = (ctx: CanvasRenderingContext2D, pts: Array<{ x: number; y: number }>, dx: number, dy: number) => {
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(pts[0].x + dx, pts[0].y + dy);
      for (let i = 1; i < pts.length - 1; i++) {
        const xc = (pts[i].x + pts[i + 1].x) * 0.5 + dx;
        const yc = (pts[i].y + pts[i + 1].y) * 0.5 + dy;
        ctx.quadraticCurveTo(pts[i].x + dx, pts[i].y + dy, xc, yc);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x + dx, last.y + dy);
      ctx.stroke();
    };

    const clippedRuns: Array<Array<{ x: number; y: number }>> = [];
    for (const run of f0Runs) {
      let cur: Array<{ x: number; y: number }> = [];
      for (const pt of run) {
        const inBreak = breaks.some((b) => pt.t >= b.t0 && pt.t <= b.t1);
        if (inBreak) {
          if (cur.length >= 2 && cur[cur.length - 1].x - cur[0].x >= 3.0) clippedRuns.push(cur);
          cur = [];
          continue;
        }
        const x = timeToX(pt.t);
        const y = specBot - 11 - Math.max(0, Math.min(1, pt.normF0)) * (specH - 22);
        cur.push({ x, y });
      }
      if (cur.length >= 2 && cur[cur.length - 1].x - cur[0].x >= 3.0) clippedRuns.push(cur);
    }

    pYellow.save();
    pYellow.strokeStyle = RISO_YELLOW;
    pYellow.lineWidth = 3.6;
    pYellow.lineCap = 'round';
    pYellow.lineJoin = 'round';
    pYellow.globalAlpha = 0.94;
    clippedRuns.forEach((r) => strokeSmooth(pYellow, r, 1.35, 1.05));
    pYellow.restore();

    pPink.save();
    pPink.strokeStyle = RISO_PINK;
    pPink.lineWidth = 2.0;
    pPink.lineCap = 'round';
    pPink.lineJoin = 'round';
    pPink.globalAlpha = 0.92;
    clippedRuns.forEach((r) => strokeSmooth(pPink, r, 0, 0));
    pPink.restore();
  }

  // `//` compressed silence break markers (Crisp Pink + Cyan dual-slash)
  for (const br of breaks) {
    const cx = br.xc;
    for (const bandY of [waveMidY, (specTop + specBot) * 0.5]) {
      const slashH = bandY === waveMidY ? 6.5 : 11;
      for (const [ctx, col, shift] of [
        [pPink, RISO_PINK, -2.8],
        [pCyan, RISO_CYAN, 2.8]
      ] as const) {
        ctx.save();
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.82;
        ctx.lineWidth = 1.75;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx + shift + 2.8, bandY - slashH);
        ctx.lineTo(cx + shift - 2.8, bandY + slashH);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Apply soybean-ink stencil grain punch to each color plate
  const grainTile = getRisoGrainTileCanvas();
  if (grainTile) {
    for (const plate of [yellow, pink, cyan]) {
      const ctx = plate.ctx!;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'destination-out';
      const pat = ctx.createPattern(grainTile, 'repeat');
      if (pat) {
        ctx.fillStyle = pat;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();
    }
  }

  // Composite the 3 plates with refined analog Risograph registration offsets & multiply blending
  const outCanvas = document.createElement('canvas');
  outCanvas.width = W;
  outCanvas.height = H;
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) return null;

  outCtx.globalCompositeOperation = 'multiply';
  outCtx.drawImage(yellow.canvas, 1.5 * scale, 1.2 * scale);
  outCtx.drawImage(pink.canvas, 1.3 * scale, -1.0 * scale);
  outCtx.drawImage(cyan.canvas, -1.2 * scale, 1.1 * scale);

  const dataUrl = outCanvas.toDataURL('image/png');
  if (!dataUrl) return null;

  return { dataUrl, xPt: x0Pt, yPt: y0Pt, widthPt, heightPt };
}
