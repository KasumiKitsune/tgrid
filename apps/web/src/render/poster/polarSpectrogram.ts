import type { AudioAnalysisSummary, PlatformBridge } from '../../bridge/types';
import type { PolarDiscRasterResult, PosterTemplateId } from './types';

export interface PolarSpectrogramParams {
  style: PosterTemplateId;
  bridge: PlatformBridge;
  analysis: AudioAnalysisSummary | null;
  hasAudio: boolean;
  showSpectrogram: boolean;
  tMin: number;
  tMax: number;
  maxFreq: number;
  dynRange: number;
  previewMode: boolean;
  cx: number;
  cy: number;
  startDeg: number;
  totalDeg: number;
  rLabel: number;
  rWaveIn: number;
  rSpecIn: number;
  rSpecOut: number;
  rVinylEdge: number;
}

interface WorkerPayload {
  id: number;
  style: PosterTemplateId;
  sizeW: number;
  sizeH: number;
  x0Pt: number;
  y0Pt: number;
  cxPt: number;
  cyPt: number;
  pxPerPt: number;
  rLabel: number;
  rWaveIn: number;
  rSpecIn: number;
  rSpecOut: number;
  rVinylEdge: number;
  startDeg: number;
  totalDeg: number;
  endDeg: number;
  specCols: number;
  specRows: number;
  specBuf: ArrayBuffer | null;
  hasSpec: boolean;
}

const MAX_CACHE_ENTRIES = 18;
const previewRasterCache = new Map<string, PolarDiscRasterResult>();

export function clearPolarSpecCache(): void {
  previewRasterCache.clear();
}

export function prunePolarSpecCacheForSession(sessionId: number): void {
  const prefix = `${sessionId}|`;
  for (const key of Array.from(previewRasterCache.keys())) {
    if (key.startsWith(prefix)) {
      previewRasterCache.delete(key);
    }
  }
}

function buildCacheKey(p: PolarSpectrogramParams, pxPerPt: number): string {
  const sid = p.analysis?.sessionId ?? -1;
  return [
    sid,
    p.style,
    p.showSpectrogram && p.hasAudio && p.analysis ? '1' : '0',
    p.tMin.toFixed(4),
    p.tMax.toFixed(4),
    p.maxFreq,
    p.dynRange,
    pxPerPt.toFixed(2),
    p.rSpecIn.toFixed(1),
    p.rSpecOut.toFixed(1),
    p.rVinylEdge.toFixed(1)
  ].join('|');
}

function setCacheEntry(key: string, val: PolarDiscRasterResult): void {
  if (previewRasterCache.has(key)) {
    previewRasterCache.delete(key);
  }
  previewRasterCache.set(key, val);
  while (previewRasterCache.size > MAX_CACHE_ENTRIES) {
    const firstKey = previewRasterCache.keys().next().value;
    if (firstKey !== undefined) previewRasterCache.delete(firstKey);
    else break;
  }
}

/**
 * Pure pixel-synthesis routine shared between the inline Blob Web Worker and the main-thread fallback.
 * Returns tightly packed RGBA `Uint8ClampedArray(sizeW * sizeH * 4)`.
 */
function synthesizePolarPixels(payload: WorkerPayload): Uint8ClampedArray {
  const {
    style,
    sizeW,
    sizeH,
    x0Pt,
    y0Pt,
    cxPt,
    cyPt,
    pxPerPt,
    rLabel,
    rWaveIn,
    rSpecIn,
    rSpecOut,
    rVinylEdge,
    startDeg,
    totalDeg,
    endDeg,
    specCols,
    specRows,
    specBuf,
    hasSpec
  } = payload;

  const out = new Uint8ClampedArray(sizeW * sizeH * 4);
  const spec = hasSpec && specBuf ? new Float32Array(specBuf) : null;
  const invScale = 1.0 / pxPerPt;
  const RAD2DEG = 180.0 / Math.PI;
  const specSpan = Math.max(1e-6, rSpecOut - rSpecIn);
  const maxCol = Math.max(0, specCols - 1);
  const maxRow = Math.max(0, specRows - 1);

  const sampleSpec = (uTime: number, uFreq: number): number => {
    if (!spec || specCols < 2 || specRows < 2) return 0;
    const tx = Math.max(0, Math.min(maxCol - 0.001, uTime * maxCol));
    // Rust spectrogram row 0 = maxFreq, row maxRow = 0 Hz
    const fy = Math.max(0, Math.min(maxRow - 0.001, (1.0 - uFreq) * maxRow));
    const x0 = tx | 0;
    const y0 = fy | 0;
    const x1 = x0 + 1 < specCols ? x0 + 1 : x0;
    const y1 = y0 + 1 < specRows ? y0 + 1 : y0;
    const wx = tx - x0;
    const wy = fy - y0;
    const r0 = y0 * specCols;
    const r1 = y1 * specCols;
    const v00 = spec[r0 + x0];
    const v10 = spec[r0 + x1];
    const v01 = spec[r1 + x0];
    const v11 = spec[r1 + x1];
    return (v00 * (1 - wx) + v10 * wx) * (1 - wy) + (v01 * (1 - wx) + v11 * wx) * wy;
  };

  if (style === 'vinyl') {
    // Rich obsidian -> espresso -> burnished copper -> warm amber -> luminous gold -> champagne LUT
    const stops = [0.0, 0.16, 0.36, 0.58, 0.78, 0.92, 1.0];
    const stopR = [20, 38, 96, 174, 224, 246, 255];
    const stopG = [18, 24, 42, 82, 146, 206, 247];
    const stopB = [16, 19, 26, 36, 56, 112, 220];
    const lutR = new Float32Array(256);
    const lutG = new Float32Array(256);
    const lutB = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const u = i / 255.0;
      let seg = 0;
      while (seg < stops.length - 2 && u > stops[seg + 1]) seg++;
      const t = (u - stops[seg]) / Math.max(1e-6, stops[seg + 1] - stops[seg]);
      lutR[i] = stopR[seg] + (stopR[seg + 1] - stopR[seg]) * t;
      lutG[i] = stopG[seg] + (stopG[seg + 1] - stopG[seg]) * t;
      lutB[i] = stopB[seg] + (stopB[seg + 1] - stopB[seg]) * t;
    }

    const rMin = rLabel - 0.6;
    const rMax = rVinylEdge + 0.6;
    const rMin2 = rMin * rMin;
    const rMax2 = rMax * rMax;
    // Limit high-frequency micro-groove frequency below Nyquist of current pixel scale to avoid Moire
    const fineGrooveW = pxPerPt >= 2.5 ? 0.022 : 0.008;

    for (let py = 0; py < sizeH; py++) {
      const dy = y0Pt + (py + 0.5) * invScale - cyPt;
      const dy2 = dy * dy;
      if (dy2 > rMax2) continue;
      const rowOff = py * sizeW * 4;

      for (let px = 0; px < sizeW; px++) {
        const dx = x0Pt + (px + 0.5) * invScale - cxPt;
        const r2 = dx * dx + dy2;
        if (r2 < rMin2 || r2 > rMax2) continue;

        const r = Math.sqrt(r2);
        const ang = Math.atan2(dy, dx) * RAD2DEG;
        let angMod = (ang - startDeg) % 360.0;
        if (angMod < 0) angMod += 360.0;
        angMod += startDeg;
        const inActiveArc = angMod >= startDeg && angMod <= endDeg;

        let rc = 20.0;
        let gc = 18.0;
        let bc = 16.0;

        if (spec && inActiveArc && r >= rSpecIn && r <= rSpecOut) {
          const uTime = (angMod - startDeg) / totalDeg;
          const uFreq = (r - rSpecIn) / specSpan;
          const rawVal = sampleSpec(uTime, uFreq);
          // Smooth tonal curve: lift delicate low-level harmonic texture & gently roll highlights into luminous gold
          let vTone = rawVal > 0 ? Math.pow(rawVal, 0.84) : 0;
          if (vTone > 0.72) {
            const excess = (vTone - 0.72) / 0.28;
            vTone = 0.72 + 0.28 * (1.0 - Math.pow(1.0 - excess, 1.35));
          }
          // Subtle warm obsidian ambient sheen inside the active groove track
          vTone = Math.min(1.0, vTone * 0.96 + 0.032 * (1.0 - 0.45 * uFreq));
          const li = Math.max(0, Math.min(255, (vTone * 255.0 + 0.5) | 0));
          rc = lutR[li];
          gc = lutG[li];
          bc = lutB[li];
        }

        const gWave = Math.sin(r * 7.2);
        const gFine = Math.sin(r * 16.5);
        if (inActiveArc && r >= rWaveIn && r <= rSpecOut) {
          const groove = 1.0 + 0.044 * gWave + fineGrooveW * gFine;
          rc = rc * groove + 2.1 * gWave;
          gc = gc * groove + 1.9 * gWave;
          bc = bc * groove + 1.6 * gWave;
        } else {
          const leadin = 1.0 + 0.024 * Math.sin(r * 5.6);
          rc = rc * leadin + 1.6 * Math.sin(r * 5.6);
          gc = gc * leadin + 1.45 * Math.sin(r * 5.6);
          bc = bc * leadin + 1.25 * Math.sin(r * 5.6);
        }

        // Specular sheen twin lobes at -42 deg and +138 deg with subtle micro-groove shimmer
        const radTerm = (r - 106.0) / 44.0;
        const radTerm2 = radTerm * radTerm;
        const radialEnv = Math.max(0.0, Math.min(1.0, 1.0 - radTerm2 * radTerm2));
        if (radialEnv > 0.001) {
          let sheen = 0.0;
          for (let s = 0; s < 2; s++) {
            const cAng = s === 0 ? -42.0 : 138.0;
            const spiralAng = cAng + 0.07 * (r - 106.0);
            let dAng = (ang - spiralAng + 180.0) % 360.0;
            if (dAng < 0) dAng += 360.0;
            dAng -= 180.0;
            const dBroad = dAng / 15.0;
            const dSharp = dAng / 3.9;
            sheen +=
              (0.115 * Math.exp(-0.5 * dBroad * dBroad) + 0.068 * Math.exp(-0.5 * dSharp * dSharp)) *
              radialEnv;
          }
          const grooveSheen = sheen * (1.0 + 0.2 * gWave);
          rc += grooveSheen * 255.0;
          gc += grooveSheen * 246.0;
          bc += grooveSheen * 230.0;
        }

        // Subtle tactile outer lip bevel
        if (Math.abs(r - (rVinylEdge - 0.9)) < 0.7) {
          rc += 28.0;
          gc += 25.0;
          bc += 22.0;
        }

        let alpha = 1.0;
        if (r > rVinylEdge - 0.4) {
          alpha = Math.max(0.0, Math.min(1.0, rVinylEdge + 0.6 - r));
        }

        const off = rowOff + px * 4;
        out[off] = rc < 0 ? 0 : rc > 255 ? 255 : rc | 0;
        out[off + 1] = gc < 0 ? 0 : gc > 255 ? 255 : gc | 0;
        out[off + 2] = bc < 0 ? 0 : bc > 255 ? 255 : bc | 0;
        out[off + 3] = (alpha * 255.0 + 0.5) | 0;
      }
    }
    return out;
  }

  // Bauhaus 224-deg polar sunburst spectrogram (0 deg = 12 o'clock, clockwise positive)
  const bStops = [0.0, 0.18, 0.52, 0.82, 1.0];
  const bR = [242, 226, 38, 22, 16];
  const bG = [236, 219, 74, 21, 15];
  const bB = [225, 204, 138, 20, 14];
  const lutR = new Float32Array(256);
  const lutG = new Float32Array(256);
  const lutB = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = i / 255.0;
    let seg = 0;
    while (seg < bStops.length - 2 && u > bStops[seg + 1]) seg++;
    const t = (u - bStops[seg]) / Math.max(1e-6, bStops[seg + 1] - bStops[seg]);
    lutR[i] = bR[seg] + (bR[seg + 1] - bR[seg]) * t;
    lutG[i] = bG[seg] + (bG[seg + 1] - bG[seg]) * t;
    lutB[i] = bB[seg] + (bB[seg + 1] - bB[seg]) * t;
  }

  const rMin = rSpecIn - 0.5;
  const rMax = rSpecOut + 0.5;
  const rMin2 = rMin * rMin;
  const rMax2 = rMax * rMax;

  for (let py = 0; py < sizeH; py++) {
    // dy points UP in Bauhaus clock coordinates
    const dy = cyPt - (y0Pt + (py + 0.5) * invScale);
    const dy2 = dy * dy;
    if (dy2 > rMax2) continue;
    const rowOff = py * sizeW * 4;

    for (let px = 0; px < sizeW; px++) {
      const dx = x0Pt + (px + 0.5) * invScale - cxPt;
      const r2 = dx * dx + dy2;
      if (r2 < rMin2 || r2 > rMax2) continue;

      const phiDeg = Math.atan2(dx, dy) * RAD2DEG;
      if (phiDeg < startDeg - 0.25 || phiDeg > endDeg + 0.25) continue;

      const r = Math.sqrt(r2);
      const uTime = Math.max(0.0, Math.min(1.0, (phiDeg - startDeg) / totalDeg));
      const uFreq = Math.max(0.0, Math.min(1.0, (r - rSpecIn) / specSpan));
      const val = spec ? sampleSpec(uTime, uFreq) : 0.0;
      const li = Math.max(0, Math.min(255, (val * 255.0 + 0.5) | 0));
      let rc = lutR[li];
      let gc = lutG[li];
      let bc = lutB[li];

      // High-frequency vermilion boost matching Weimar 1923 palette
      if (uFreq > 0.42 && val > 0.52) {
        const hfA = Math.min(1.0, (uFreq - 0.42) / 0.28);
        const hfB = Math.min(1.0, (val - 0.52) / 0.32);
        const hfW = Math.pow(hfA * hfB, 0.9) * 0.86;
        rc = rc * (1.0 - hfW) + 217.0 * hfW;
        gc = gc * (1.0 - hfW) + 56.0 * hfW;
        bc = bc * (1.0 - hfW) + 41.0 * hfW;
      }

      // Soft anti-aliasing at radial/angular edges
      let alpha = 1.0;
      if (r < rSpecIn + 0.4) alpha = Math.min(alpha, Math.max(0, (r - (rSpecIn - 0.5)) / 0.9));
      if (r > rSpecOut - 0.4) alpha = Math.min(alpha, Math.max(0, (rSpecOut + 0.5 - r) / 0.9));
      if (phiDeg < startDeg) alpha = Math.min(alpha, Math.max(0, (phiDeg - (startDeg - 0.25)) / 0.25));
      if (phiDeg > endDeg) alpha = Math.min(alpha, Math.max(0, (endDeg + 0.25 - phiDeg) / 0.25));

      const off = rowOff + px * 4;
      out[off] = rc < 0 ? 0 : rc > 255 ? 255 : (rc + 0.5) | 0;
      out[off + 1] = gc < 0 ? 0 : gc > 255 ? 255 : (gc + 0.5) | 0;
      out[off + 2] = bc < 0 ? 0 : bc > 255 ? 255 : (bc + 0.5) | 0;
      out[off + 3] = (alpha * 255.0 + 0.5) | 0;
    }
  }
  return out;
}

let sharedWorker: Worker | null = null;
let workerFailed = false;
let workerReqSeq = 1;
const pendingWorkerReqs = new Map<
  number,
  { resolve: (pixels: Uint8ClampedArray) => void; reject: (err: Error) => void }
>();

function getPolarWorker(): Worker | null {
  if (workerFailed || typeof Worker === 'undefined' || typeof Blob === 'undefined') {
    return null;
  }
  if (sharedWorker) return sharedWorker;

  try {
    // Serialize the pure synthesis function directly into an inline Blob Worker
    // (100% offline & vite-plugin-singlefile safe!)
    const workerSrc = `
      const synthesizePolarPixels = ${synthesizePolarPixels.toString()};
      self.onmessage = function(e) {
        const payload = e.data;
        try {
          const pixels = synthesizePolarPixels(payload);
          self.postMessage({ id: payload.id, buffer: pixels.buffer }, [pixels.buffer]);
        } catch (err) {
          self.postMessage({ id: payload.id, error: String(err) });
        }
      };
    `;
    const blob = new Blob([workerSrc], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);

    worker.onmessage = (e: MessageEvent<{ id: number; buffer?: ArrayBuffer; error?: string }>) => {
      const msg = e.data;
      const entry = pendingWorkerReqs.get(msg.id);
      if (!entry) return;
      pendingWorkerReqs.delete(msg.id);
      if (msg.error || !msg.buffer) {
        entry.reject(new Error(msg.error || 'Worker returned empty buffer'));
      } else {
        entry.resolve(new Uint8ClampedArray(msg.buffer));
      }
    };
    worker.onerror = () => {
      workerFailed = true;
      sharedWorker = null;
      for (const [, req] of pendingWorkerReqs) {
        req.reject(new Error('Polar spectrogram worker error'));
      }
      pendingWorkerReqs.clear();
    };
    sharedWorker = worker;
    return worker;
  } catch {
    workerFailed = true;
    return null;
  }
}

async function runPolarSynthesis(payload: WorkerPayload): Promise<Uint8ClampedArray> {
  const worker = getPolarWorker();
  if (!worker) {
    return synthesizePolarPixels(payload);
  }
  const id = workerReqSeq++;
  const msg: WorkerPayload = { ...payload, id };
  try {
    return await new Promise<Uint8ClampedArray>((resolve, reject) => {
      pendingWorkerReqs.set(id, { resolve, reject });
      const transfers: Transferable[] = [];
      if (msg.specBuf) transfers.push(msg.specBuf);
      worker.postMessage(msg, transfers);
    });
  } catch {
    // Fallback to main thread if worker fails
    return synthesizePolarPixels(payload);
  }
}

function pixelsToDataUrl(width: number, height: number, pixels: Uint8ClampedArray): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const copy = new Uint8ClampedArray(pixels.length);
  copy.set(pixels);
  const imgData = new ImageData(copy, width, height);
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * Generates a tightly cropped polar spectrogram / vinyl disc PNG data URL.
 * - For Bauhaus without audio (or spectrogram off), returns `null` so the renderer draws pure vector rings.
 * - For Vinyl without audio (or spectrogram off), synthesizes a full 360° glossy pressed black vinyl disc with grooves & sheen.
 */
export async function renderPolarSpectrogramRaster(
  params: PolarSpectrogramParams
): Promise<PolarDiscRasterResult | null> {
  const wantSpec = Boolean(params.hasAudio && params.analysis && params.showSpectrogram);
  if (params.style === 'bauhaus' && !wantSpec) {
    return null;
  }

  const pxPerPt = params.previewMode ? 1.5 : 4.0;
  const cacheKey = buildCacheKey(params, pxPerPt);
  if (params.previewMode) {
    const hit = previewRasterCache.get(cacheKey);
    if (hit) {
      // Translate cached disc to requested (cx, cy) cleanly
      const xOffset = params.style === 'vinyl' ? params.cx - (params.rVinylEdge + 5.0) : hit.xPt;
      const yOffset = params.style === 'vinyl' ? params.cy - (params.rVinylEdge + 5.0) : hit.yPt;
      if (params.style === 'vinyl') {
        return { ...hit, xPt: xOffset, yPt: yOffset };
      }
      const pad = 4.0;
      const bx0 = Math.floor(params.cx - params.rSpecOut - pad);
      const by0 = Math.floor(params.cy - params.rSpecOut - pad);
      return { ...hit, xPt: bx0, yPt: by0 };
    }
  }

  let specCols = 0;
  let specRows = 0;
  let specFloat: Float32Array | null = null;

  if (wantSpec && params.analysis) {
    const targetCols = params.previewMode ? 720 : 1440;
    const targetRows = params.previewMode ? 160 : 280;
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
    if (rgbaRes.width >= 2 && rgbaRes.height >= 2 && rgbaRes.rgba.length >= rgbaRes.width * rgbaRes.height * 4) {
      specCols = rgbaRes.width;
      specRows = rgbaRes.height;
      const total = specCols * specRows;
      specFloat = new Float32Array(total);
      const src = rgbaRes.rgba;
      for (let i = 0; i < total; i++) {
        specFloat[i] = (255 - src[i * 4]) / 255.0;
      }
    }
  }

  let x0Pt: number;
  let y0Pt: number;
  let widthPt: number;
  let heightPt: number;

  if (params.style === 'vinyl') {
    const padPt = params.rVinylEdge + 5.0;
    x0Pt = params.cx - padPt;
    y0Pt = params.cy - padPt;
    widthPt = 2 * padPt;
    heightPt = 2 * padPt;
  } else {
    const pad = 4.0;
    const phiStartRad = (params.startDeg * Math.PI) / 180;
    const phiEndRad = ((params.startDeg + params.totalDeg) * Math.PI) / 180;
    x0Pt = Math.floor(params.cx - params.rSpecOut - pad);
    const x1Pt = Math.ceil(params.cx + params.rSpecOut + pad);
    y0Pt = Math.floor(params.cy - params.rSpecOut - pad);
    const maxDown = Math.max(-Math.cos(phiStartRad), -Math.cos(phiEndRad), 0);
    const y1Pt = Math.ceil(params.cy + params.rSpecOut * maxDown + pad);
    widthPt = x1Pt - x0Pt;
    heightPt = y1Pt - y0Pt;
  }

  const sizeW = Math.max(8, Math.round(widthPt * pxPerPt));
  const sizeH = Math.max(8, Math.round(heightPt * pxPerPt));

  const pixels = await runPolarSynthesis({
    id: 0,
    style: params.style,
    sizeW,
    sizeH,
    x0Pt,
    y0Pt,
    cxPt: params.cx,
    cyPt: params.cy,
    pxPerPt,
    rLabel: params.rLabel,
    rWaveIn: params.rWaveIn,
    rSpecIn: params.rSpecIn,
    rSpecOut: params.rSpecOut,
    rVinylEdge: params.rVinylEdge,
    startDeg: params.startDeg,
    totalDeg: params.totalDeg,
    endDeg: params.startDeg + params.totalDeg,
    specCols,
    specRows,
    specBuf: specFloat ? (specFloat.buffer as ArrayBuffer) : null,
    hasSpec: Boolean(specFloat)
  });

  const dataUrl = pixelsToDataUrl(sizeW, sizeH, pixels);
  if (!dataUrl) return null;

  const result: PolarDiscRasterResult = {
    dataUrl,
    xPt: x0Pt,
    yPt: y0Pt,
    widthPt,
    heightPt
  };

  if (params.previewMode) {
    setCacheEntry(cacheKey, result);
  }
  return result;
}
