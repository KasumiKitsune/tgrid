import type { AudioAnalysisSummary, PlatformBridge, TextGrid, ZipEntryInput } from '../bridge/types';
import { computeLayout, type BandLayout, type ScoreLayout } from '../layout/computeLayout';
import {
  SVG_NS,
  formatCaptionTimeText,
  getExportPalette,
  resolveScreenCueOpacities
} from '../layout/legendCore';
import {
  IPA_FONT_STACK,
  SERIF_FONT_STACK,
  formatDisplayTick,
  prefetchTrigraphCache
} from '../layout/richText';
import {
  renderScoreSvg,
  type BandSpecRenderResult,
  type EditorSelection
} from './renderScoreSvg';

export interface ExportPrefs {
  format: 'svg' | 'png';
  rangeMode: 'all' | 'view' | 'selection' | 'custom';
  customStart: number | null;
  customEnd: number | null;
  specMode: 'contour' | 'external-zip' | 'curves-only' | 'embed-defs';
  pngScale: 2 | 3 | 6;
  pngShowBackdrop: boolean;
  widthPreset: 'window' | 'single-col' | 'full-col' | 'single-line';
  palette: 'warm' | 'bw';
  transparentBg: boolean;
  presentationBoost: boolean;
  trigraphMode: 'ipa-only' | 'dual' | 'raw-only';
  hideMetaSymbols: boolean;
  hideStretchCues: boolean;
  showCaption: boolean;
  showLinearScaleBar: boolean;
  scaleMode: 'follow' | 'linear' | 'adaptive';
  tickPrecision: '2' | '3' | 'full' | 'none';
  tickFixedDecimals: boolean;
  marginPreset: 'tight' | 'standard' | 'wide';
  specDynRange: 45 | 52 | 58;
  contourLevels: 4 | 6 | 8;
  semanticGroups: boolean;
  roundCoords: boolean;
  fontStrategy: 'ipa' | 'serif';
  legendMode: 'full' | 'compact' | 'off';
  legendLang: 'zh' | 'en';
  activePreset: 'screen' | 'journal' | 'slides' | 'lines' | null;
}

export const EXPORT_STORAGE_KEY = 'textgrid_export_prefs_v1';
const MAX_CANVAS_DIM = 16384;
const MAX_CANVAS_AREA = 16384 * 8192;

export const DEFAULT_EXPORT_PREFS: ExportPrefs = {
  format: 'svg',
  rangeMode: 'all',
  customStart: null,
  customEnd: null,
  specMode: 'contour',
  pngScale: 3,
  pngShowBackdrop: true,
  widthPreset: 'window',
  palette: 'warm',
  transparentBg: false,
  presentationBoost: false,
  trigraphMode: 'ipa-only',
  hideMetaSymbols: true,
  hideStretchCues: false,
  showCaption: false,
  showLinearScaleBar: true,
  scaleMode: 'follow',
  tickPrecision: '3',
  tickFixedDecimals: false,
  marginPreset: 'standard',
  specDynRange: 52,
  contourLevels: 6,
  semanticGroups: true,
  roundCoords: true,
  fontStrategy: 'ipa',
  legendMode: 'compact',
  legendLang: 'zh',
  activePreset: null
};

export function loadExportPrefs(): ExportPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPORT_STORAGE_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      const merged = { ...DEFAULT_EXPORT_PREFS, ...raw } as ExportPrefs;
      const dr = Number((raw as { specDynRange?: unknown }).specDynRange);
      if (dr !== 45 && dr !== 52 && dr !== 58) {
        merged.specDynRange = dr === 40 ? 45 : 52;
      }
      return merged;
    }
  } catch {
    // ignore storage failures
  }
  return { ...DEFAULT_EXPORT_PREFS };
}

export function saveExportPrefs(prefs: ExportPrefs): void {
  try {
    localStorage.setItem(EXPORT_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

export function applyPresetToPrefs(
  cur: ExportPrefs,
  presetId: 'screen' | 'journal' | 'slides' | 'lines',
  ctx: { tickPrecision: string; tickFixedDecimals?: boolean; legendOpen: boolean }
): ExportPrefs {
  const next: ExportPrefs = { ...cur, activePreset: presetId };
  if (presetId === 'screen') {
    next.palette = 'warm';
    next.transparentBg = false;
    next.presentationBoost = false;
    next.widthPreset = 'window';
    next.scaleMode = 'follow';
    next.tickPrecision =
      ctx.tickPrecision === '2' || ctx.tickPrecision === '3' || ctx.tickPrecision === 'full'
        ? ctx.tickPrecision
        : '3';
    next.tickFixedDecimals = Boolean(ctx.tickFixedDecimals);
    next.marginPreset = 'standard';
    next.trigraphMode = 'dual';
    next.hideMetaSymbols = false;
    next.hideStretchCues = false;
    next.showCaption = false;
    next.specDynRange = 52;
    next.specMode = 'embed-defs';
    next.pngShowBackdrop = true;
    next.pngScale = 3;
    next.legendMode = ctx.legendOpen ? 'full' : 'off';
  } else if (presetId === 'journal') {
    next.palette = 'bw';
    next.transparentBg = false;
    next.presentationBoost = false;
    next.widthPreset = 'full-col';
    next.tickFixedDecimals = true;
    next.marginPreset = 'standard';
    next.trigraphMode = 'ipa-only';
    next.hideMetaSymbols = true;
    next.hideStretchCues = true;
    next.specMode = 'contour';
    next.contourLevels = 6;
    next.specDynRange = 52;
    next.pngScale = 6;
    next.pngShowBackdrop = true;
    next.showLinearScaleBar = true;
    next.legendMode = 'compact';
  } else if (presetId === 'slides') {
    next.palette = 'warm';
    next.transparentBg = false;
    next.presentationBoost = true;
    next.widthPreset = 'full-col';
    next.tickFixedDecimals = false;
    next.marginPreset = 'standard';
    next.trigraphMode = 'ipa-only';
    next.hideMetaSymbols = true;
    next.hideStretchCues = true;
    next.specMode = 'contour';
    next.contourLevels = 6;
    next.specDynRange = 52;
    next.pngScale = 3;
    next.pngShowBackdrop = true;
    next.legendMode = 'full';
  } else if (presetId === 'lines') {
    next.specMode = 'curves-only';
    next.pngShowBackdrop = false;
    next.presentationBoost = false;
    next.trigraphMode = 'ipa-only';
    next.hideMetaSymbols = true;
    next.hideStretchCues = true;
    next.legendMode = 'compact';
  }
  return next;
}

export function sanitizeSvgId(name: string): string {
  const cleaned = String(name || 'tier')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_\u4e00-\u9fff-]/g, '')
    .slice(0, 28);
  return cleaned || 'tier';
}

const COMPACT_GEO_ATTRS = new Set([
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height',
  'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'viewBox',
  'transform', 'stroke-width', 'font-size', 'opacity', 'fill-opacity', 'stroke-opacity'
]);

export function compactSvgMarkup(svgStr: string): string {
  if (!svgStr) return '';
  return svgStr.replace(/<([A-Za-z][A-Za-z0-9:-]*)(\s+[^>]*?)?(\/?)>/g, (full, tag, attrs, selfClose) => {
    if (!attrs) return full;
    const cleanAttrs = attrs.replace(
      /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"/g,
      (attrFull: string, name: string, val: string) => {
        if (!COMPACT_GEO_ATTRS.has(name)) return attrFull;
        const compacted = val.replace(/-?\d+\.\d+/g, (numStr) => {
          const n = Number(numStr);
          if (!Number.isFinite(n)) return numStr;
          const s = n.toFixed(2).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
          return s === '-0' ? '0' : s;
        });
        return `${name}="${compacted}"`;
      }
    );
    return `<${tag}${cleanAttrs}${selfClose}>`;
  });
}

export function computeLinearScaleBarSpec(band: BandLayout): { sec: number; pxLen: number; label: string } | null {
  if (!band.linearSegs.length) return null;
  let totalDt = 0;
  let totalDx = 0;
  for (const seg of band.linearSegs) {
    if (seg.collapsed) continue;
    const dt = seg.t1 - seg.t0;
    const dx = seg.x1 - seg.x0;
    if (dt > 0 && dx > 0) {
      totalDt += dt;
      totalDx += dx;
    }
  }
  if (totalDt <= 0 || totalDx <= 0) return null;
  const pxPerSec = totalDx / totalDt;
  const candidates = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10];
  const maxBarPx = Math.min(140, band.bandContentW * 0.45);
  let chosen = candidates[0];
  let bestScore = Infinity;
  for (const sec of candidates) {
    const px = sec * pxPerSec;
    if (px > maxBarPx) continue;
    const score = Math.abs(px - 88);
    if (score < bestScore) {
      bestScore = score;
      chosen = sec;
    }
  }
  const pxLen = chosen * pxPerSec;
  const label = chosen < 1 ? `${Math.round(chosen * 1000)} ms` : `${chosen} s`;
  return { sec: chosen, pxLen, label };
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '约 1 KB';
  if (bytes < 1024) return `约 ${bytes} B`;
  if (bytes < 1024 * 1024) return `约 ${Math.round(bytes / 1024)} KB`;
  return `约 ${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function rgbaToPngDataUrl(width: number, height: number, rgba: Uint8ClampedArray): string {
  if (width <= 0 || height <= 0 || rgba.length < width * height * 4) return '';
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const copy = new Uint8ClampedArray(width * height * 4);
  copy.set(rgba.subarray(0, width * height * 4));
  const imgData = new ImageData(copy, width, height);
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/png');
}

export function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const idx = dataUrl.indexOf(',');
  if (idx === -1) return new Uint8Array(0);
  const bin = atob(dataUrl.slice(idx + 1));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export function computeEffectivePngScale(
  w: number,
  h: number,
  requestedScale: number
): { effectiveScale: number; scaleCapped: boolean } {
  const maxByW = MAX_CANVAS_DIM / Math.max(1, w);
  const maxByH = MAX_CANVAS_DIM / Math.max(1, h);
  const maxByArea = Math.sqrt(MAX_CANVAS_AREA / Math.max(1, w * h));
  const limit = Math.min(maxByW, maxByH, maxByArea);
  if (requestedScale <= limit) return { effectiveScale: requestedScale, scaleCapped: false };
  return { effectiveScale: Math.max(1, Math.floor(limit * 10) / 10), scaleCapped: true };
}

export interface ExportSceneInput {
  bridge: PlatformBridge;
  tg: TextGrid;
  filename: string;
  prefs: ExportPrefs;
  tierIndices: number[];
  previewMode: boolean;
  stageWidth: number;
  uiWrapMode: 'auto' | 'single';
  uiScaleMode: 'elastic' | 'linear';
  uiTargetWidth: number;
  uiWidthAutoFit?: boolean;
  viewDomain: { min: number; max: number } | null;
  playRange: { start: number; end: number } | null;
  selection: EditorSelection;
  hasAudio: boolean;
  audioBuffer: AudioBuffer | null;
  audioOffset: number;
  analysis: AudioAnalysisSummary | null;
  showSpectrogram: boolean;
  cueMode: 'auto' | 'pitch' | 'formant' | 'plain';
  tierOrder: 'raw' | 'spec';
  maxFreq: number;
  forceSpecStrategy?: string;
}

export interface ExportRenderOutput {
  svgMarkup: string;
  layout: ScoreLayout;
  specStrategy: string;
  effectiveScale: number;
  scaleCapped: boolean;
  externalAssets: Array<{ name: string; data?: Uint8Array; estimatedBytes?: number }>;
  estimatedBytes: number;
}

export function getBaseStem(filename: string): string {
  return (filename || 'TextGrid').replace(/\.[^.]+$/, '') || 'TextGrid';
}

export async function renderOffscreenExport(input: ExportSceneInput): Promise<ExportRenderOutput> {
  const { bridge, tg, prefs, previewMode } = input;
  const gMin = Number.isFinite(tg.xmin) ? tg.xmin : 0;
  const gMax = Number.isFinite(tg.xmax) ? tg.xmax : gMin + 1;

  let tMin: number | undefined;
  let tMax: number | undefined;
  if (prefs.rangeMode === 'view' && input.viewDomain) {
    tMin = input.viewDomain.min;
    tMax = input.viewDomain.max;
  } else if (prefs.rangeMode === 'selection') {
    if (input.playRange && input.playRange.end > input.playRange.start) {
      tMin = input.playRange.start;
      tMax = input.playRange.end;
    } else if (input.selection?.kind === 'interval') {
      const iv = tg.tiers[input.selection.tierIndex]?.intervals[input.selection.itemIndex];
      if (iv && iv.xmax > iv.xmin) {
        tMin = iv.xmin;
        tMax = iv.xmax;
      }
    }
  } else if (
    prefs.rangeMode === 'custom' &&
    prefs.customStart !== null &&
    prefs.customEnd !== null &&
    prefs.customEnd > prefs.customStart + 1e-6
  ) {
    tMin = Math.max(gMin, prefs.customStart);
    tMax = Math.min(gMax, prefs.customEnd);
  }

  const vtg = await bridge.sliceTextGrid(tg, {
    tierIndices: input.tierIndices.length ? input.tierIndices : undefined,
    tMin,
    tMax
  });
  await prefetchTrigraphCache(vtg, bridge);

  const dur = Math.max(0.05, (Number.isFinite(vtg.xmax) ? vtg.xmax : 1) - (Number.isFinite(vtg.xmin) ? vtg.xmin : 0));

  let wrapMode: 'auto' | 'single' = 'auto';
  let targetWidth = 740;
  if (prefs.widthPreset === 'window') {
    wrapMode = input.uiWrapMode;
    targetWidth =
      input.uiWrapMode === 'auto'
        ? input.uiWidthAutoFit
          ? input.stageWidth
          : Math.min(input.uiTargetWidth, input.stageWidth)
        : input.uiWidthAutoFit
          ? input.stageWidth
          : input.uiTargetWidth;
  } else if (prefs.widthPreset === 'single-col') {
    wrapMode = 'auto';
    targetWidth = 380;
  } else if (prefs.widthPreset === 'full-col') {
    wrapMode = 'auto';
    targetWidth = 740;
  } else if (prefs.widthPreset === 'single-line') {
    wrapMode = 'single';
    targetWidth = Math.max(760, Math.min(4600, Math.round(dur * 240)));
  }

  const effectiveScaleMode: 'elastic' | 'linear' =
    prefs.scaleMode === 'follow'
      ? input.uiScaleMode
      : prefs.scaleMode === 'linear'
        ? 'linear'
        : 'elastic';

  const specAvailable = Boolean(input.hasAudio && input.showSpectrogram && input.analysis);
  let specStrategy = 'curves-only';
  if (specAvailable) {
    specStrategy =
      prefs.format === 'png'
        ? prefs.pngShowBackdrop
          ? 'raster-png'
          : 'curves-only'
        : prefs.specMode;
  }
  if (input.forceSpecStrategy) {
    specStrategy = input.forceSpecStrategy;
  }

  const fontFamily = prefs.fontStrategy === 'serif' ? SERIF_FONT_STACK : IPA_FONT_STACK;
  const fontScale = prefs.presentationBoost ? 1.14 : 1;
  const strokeScale = prefs.presentationBoost ? 1.25 : 1;
  const captionHeight = prefs.showCaption ? 26 : 0;
  const scaleBarExtraH = prefs.showLinearScaleBar && effectiveScaleMode === 'linear' ? 22 : 0;

  // Decouple exported layer opacities from transient editor selection state (P0-2)
  const sc = resolveScreenCueOpacities(input.cueMode, null);
  const cueOps = {
    spec: specStrategy === 'curves-only' ? 0 : sc.spec,
    pitch: specStrategy === 'curves-only' && sc.pitch <= 0.01 && sc.formant <= 0.01 ? 0.95 : sc.pitch,
    formant: sc.formant
  };

  const layout = computeLayout(vtg, {
    wrapMode,
    targetWidth,
    hasAudio: input.hasAudio,
    showSpectrogram: specAvailable,
    tierOrder: input.tierOrder,
    scaleMode: effectiveScaleMode,
    tickPrecision: prefs.tickPrecision,
    tickFixedDecimals: prefs.tickFixedDecimals,
    viewDomain: null,
    mode: 'read',
    allowSingleCompress:
      prefs.widthPreset === 'window' && wrapMode === 'single' && !input.uiWidthAutoFit,
    marginPreset: prefs.marginPreset,
    captionHeight,
    scaleBarExtraH,
    richOpts: {
      hideMetaSymbols: prefs.hideMetaSymbols,
      trigraphMode: prefs.trigraphMode,
      fontFamily,
      fontScale
    },
    fontScale,
    legendConfig:
      prefs.legendMode !== 'off'
        ? {
            mode: prefs.legendMode,
            lang: prefs.legendLang,
            hasAudio: input.hasAudio,
            analysis: input.analysis,
            maxFreq: input.maxFreq,
            specStrategy,
            specOpacity: cueOps.spec,
            pitchOpacity: cueOps.pitch,
            formantOpacity: cueOps.formant,
            trigraphMode: prefs.trigraphMode,
            hideMetaSymbols: prefs.hideMetaSymbols,
            hideStretchCues: prefs.hideStretchCues
          }
        : null
  });

  const scaleCheck =
    prefs.format === 'png'
      ? computeEffectivePngScale(layout.width, layout.height, prefs.pngScale)
      : { effectiveScale: 1, scaleCapped: false };

  const rasterScale = previewMode ? 2 : prefs.format === 'png' ? scaleCheck.effectiveScale : 3;
  const idPrefix = previewMode ? 'exp-prev-' : '';
  const stem = getBaseStem(input.filename);
  const externalAssets: Array<{ name: string; data?: Uint8Array; estimatedBytes?: number }> = [];
  const bandSpecResults = new Map<number, BandSpecRenderResult>();

  if (specAvailable && input.analysis && specStrategy !== 'curves-only' && cueOps.spec > 0.001) {
    const sessionId = input.analysis.sessionId;
    for (const band of layout.bands) {
      if (band.specH <= 0) continue;
      const bNum = band.bandIndex + 1;
      const segs = band.linearSegs.map((s) => ({
        x0: s.x0,
        x1: s.x1,
        t0: s.t0,
        t1: s.t1,
        collapsed: s.collapsed
      }));
      if (specStrategy === 'contour') {
        const cols = Math.max(120, Math.min(240, Math.round(band.bandContentW * 0.36)));
        const rows = Math.max(44, Math.min(64, Math.round(band.specH * 0.56)));
        const paths = await bridge.computeBandContours(
          sessionId,
          segs,
          band.originX,
          band.bandContentW,
          input.maxFreq,
          cols,
          rows,
          prefs.specDynRange,
          true,
          { x: band.originX, y: band.specY, width: band.bandContentW, height: band.specH },
          prefs.contourLevels,
          prefs.palette
        );
        bandSpecResults.set(band.bandIndex, { kind: 'contour', paths });
      } else {
        const scale = specStrategy === 'raster-png' ? rasterScale : previewMode ? 1.5 : 3;
        const rgbaRes = await bridge.renderSpectrogramRgba(
          sessionId,
          segs,
          band.originX,
          band.bandContentW,
          band.specH,
          input.maxFreq,
          scale,
          prefs.specDynRange,
          prefs.palette
        );
        const dataUrl = rgbaToPngDataUrl(rgbaRes.width, rgbaRes.height, rgbaRes.rgba);
        if (specStrategy === 'embed-defs') {
          bandSpecResults.set(band.bandIndex, { kind: 'embed-defs', defId: `${idPrefix}spec-band-${bNum}`, dataUrl });
        } else if (specStrategy === 'external-zip') {
          const fname = `${stem}_spec_band${bNum}.png`;
          if (!previewMode) {
            externalAssets.push({ name: fname, data: dataUrlToUint8Array(dataUrl) });
            bandSpecResults.set(band.bandIndex, { kind: 'external-zip', relHref: `./${fname}` });
          } else {
            externalAssets.push({ name: fname, estimatedBytes: Math.round(dataUrl.length * 0.75 * 2.6) });
            bandSpecResults.set(band.bandIndex, { kind: 'raster-png', dataUrl });
          }
        } else {
          bandSpecResults.set(band.bandIndex, { kind: 'raster-png', dataUrl });
        }
      }
    }
  }

  const offSvg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  offSvg.setAttribute('xmlns', SVG_NS);

  renderScoreSvg(offSvg, {
    tg: vtg,
    layout,
    hasAudio: input.hasAudio,
    audioBuffer: input.audioBuffer,
    audioOffset: input.audioOffset,
    analysis: input.analysis,
    maxFreq: input.maxFreq,
    mode: 'read',
    selection: null,
    playRange: null,
    currentTime: 0,
    showPlayhead: false,
    dragPreview: null,
    exportCtx: {
      palette: getExportPalette(prefs.palette),
      transparentBg: prefs.transparentBg,
      fontFamily,
      fontScale,
      strokeScale,
      trigraphMode: prefs.trigraphMode,
      hideMetaSymbols: prefs.hideMetaSymbols,
      hideStretchCues: prefs.hideStretchCues,
      legendMode: prefs.legendMode,
      legendLang: prefs.legendLang,
      showCaption: prefs.showCaption,
      captionTitle: stem,
      captionTimeText: formatCaptionTimeText(vtg.xmin, vtg.xmax, prefs.legendLang, (v) => {
        const prec = String(prefs.tickPrecision);
        if (prefs.tickFixedDecimals && (prec === '2' || prec === '3' || prec === '4')) {
          return formatDisplayTick(v, prec, true);
        }
        return formatDisplayTick(v, '3');
      }),
      showLinearScaleBar: prefs.showLinearScaleBar,
      semanticGroups: prefs.semanticGroups,
      idPrefix,
      sanitizeId: sanitizeSvgId,
      computeScaleBar: computeLinearScaleBarSpec,
      specStrategy,
      specOpacity: cueOps.spec,
      pitchOpacity: cueOps.pitch,
      formantOpacity: cueOps.formant,
      bandSpecResults
    }
  });

  let svgMarkup = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(offSvg);
  if (prefs.roundCoords) svgMarkup = compactSvgMarkup(svgMarkup);

  const svgBytes = new TextEncoder().encode(svgMarkup).length;
  let estimatedBytes = svgBytes;
  if (prefs.format === 'svg' && specStrategy === 'external-zip') {
    const assetSum = externalAssets.reduce((acc, a) => acc + (a.data ? a.data.length : a.estimatedBytes || 0), 0);
    estimatedBytes = svgBytes + assetSum + 512;
  } else if (prefs.format === 'png') {
    const outW = Math.round(layout.width * scaleCheck.effectiveScale);
    const outH = Math.round(layout.height * scaleCheck.effectiveScale);
    const factor = specStrategy === 'curves-only' ? 0.06 : 0.16;
    estimatedBytes = Math.max(8192, Math.round(outW * outH * factor));
  }

  return {
    svgMarkup,
    layout,
    specStrategy,
    effectiveScale: scaleCheck.effectiveScale,
    scaleCapped: scaleCheck.scaleCapped,
    externalAssets,
    estimatedBytes
  };
}

export async function renderOffscreenPngBlob(
  input: ExportSceneInput
): Promise<{ blob: Blob; width: number; height: number; effectiveScale: number; scaleCapped: boolean }> {
  const pre = await renderOffscreenExport({ ...input, prefs: { ...input.prefs, format: 'png' }, previewMode: false });
  const scale = pre.effectiveScale;
  const w = Math.max(1, Math.round(pre.layout.width * scale));
  const h = Math.max(1, Math.round(pre.layout.height * scale));
  const url = URL.createObjectURL(new Blob([pre.svgMarkup], { type: 'image/svg+xml;charset=utf-8' }));

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        if (!input.prefs.transparentBg) {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, w, h);
        }
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('画布生成图像失败'));
            return;
          }
          resolve({ blob, width: w, height: h, effectiveScale: scale, scaleCapped: pre.scaleCapped });
        }, 'image/png');
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图像渲染失败'));
    };
    img.src = url;
  });
}

export async function buildExportZipBytes(
  bridge: PlatformBridge,
  stem: string,
  svgMarkup: string,
  externalAssets: Array<{ name: string; data?: Uint8Array }>
): Promise<Uint8Array> {
  const entries: ZipEntryInput[] = [
    { name: `${stem}.svg`, data: new TextEncoder().encode(svgMarkup) }
  ];
  for (const a of externalAssets) {
    if (a.data) entries.push({ name: a.name, data: a.data });
  }
  return bridge.buildZipStore(entries);
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
