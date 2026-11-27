import type { TextGrid } from '../../bridge/types';
import { isTauriRuntime } from '../../bridge/PlatformBridge';
import { prefetchTrigraphCache } from '../../layout/richText';
import { ensureIpaFontsLoaded, injectIpaFontsIntoSvg } from '../../utils/ipaFontEmbed';
import {
  computeEffectivePngScale,
  getBaseStem,
  triggerBlobDownload
} from '../exporter';
import type { EditorSelection } from '../renderScoreSvg';
import {
  BAUHAUS_R_SPEC0,
  BAUHAUS_R_SPEC1,
  BAUHAUS_START_DEG,
  BAUHAUS_TOTAL_DEG,
  VINYL_R_LABEL,
  VINYL_R_SPEC_IN,
  VINYL_R_SPEC_OUT,
  VINYL_R_VINYL_EDGE,
  VINYL_R_WAVE_IN,
  VINYL_START_DEG,
  VINYL_TOTAL_DEG,
  derivePosterAutoCopy,
  extractPolarWaveformBins,
  extractVoicedPitchRuns,
  isTierIpaLike,
  parseWaveformPathToBins,
  solvePolarLayout,
  tierHasCombiningMarks
} from './polarSolver';
import { renderPolarSpectrogramRaster } from './polarSpectrogram';
import {
  computePosterAcousticMetrics,
  fetchPosterSpecMatrix
} from './posterAcoustics';
import { renderBauhausPosterSvg } from './renderBauhausSvg';
import { renderBraunStripPosterSvg } from './renderBraunStripSvg';
import { renderFoldingFanPosterSvg } from './renderFoldingFanSvg';
import { renderRisographPosterSvg } from './renderRisographSvg';
import { renderVinylPosterSvg } from './renderVinylSvg';
import {
  POSTER_TEMPLATE_ORDER,
  type PolarRingBand,
  type PosterPrefs,
  type PosterRangeMode,
  type PosterRenderInput,
  type PosterResult,
  type PosterTemplateId
} from './types';

export const POSTER_STORAGE_KEY = 'tgrid-poster-prefs-v1';

export const DEFAULT_POSTER_PREFS: PosterPrefs = {
  template: 'vinyl',
  framing: 'poster_3_4',
  bgMode: 'paper',
  includeBleed: false,
  rangeMode: 'all',
  showSpectrogram: true,
  showWaveform: true,
  showPitch: true,
  pngScale: 3,
  pureVisual: false
};

export function loadPosterPrefs(): PosterPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(POSTER_STORAGE_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      const tplRaw = r.template;
      const template: PosterTemplateId =
        typeof tplRaw === 'string' && POSTER_TEMPLATE_ORDER.includes(tplRaw as PosterTemplateId)
          ? (tplRaw as PosterTemplateId)
          : 'vinyl';
      return {
        template,
        framing: r.framing === 'emblem_1_1' ? 'emblem_1_1' : 'poster_3_4',
        bgMode: r.bgMode === 'transparent' ? 'transparent' : 'paper',
        includeBleed: Boolean(r.includeBleed),
        rangeMode:
          r.rangeMode === 'view' || r.rangeMode === 'selection' || r.rangeMode === 'all'
            ? r.rangeMode
            : 'all',
        showSpectrogram: typeof r.showSpectrogram === 'boolean' ? r.showSpectrogram : true,
        showWaveform: typeof r.showWaveform === 'boolean' ? r.showWaveform : true,
        showPitch: typeof r.showPitch === 'boolean' ? r.showPitch : true,
        pngScale: r.pngScale === 2 || r.pngScale === 3 || r.pngScale === 4 ? r.pngScale : 3,
        pureVisual: Boolean(r.pureVisual)
      };
    }
  } catch {
    // ignore storage errors
  }
  return { ...DEFAULT_POSTER_PREFS };
}

export function savePosterPrefs(prefs: PosterPrefs): void {
  try {
    localStorage.setItem(POSTER_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage errors
  }
}

export function getDefaultPosterTierSelection(tg: TextGrid): {
  intervalTierIndices: number[];
  pointTierIndex: number | null;
} {
  const intervalTierIndices: number[] = [];
  let pointTierIndex: number | null = null;
  for (let i = 0; i < tg.tiers.length; i++) {
    const t = tg.tiers[i];
    if (t.kind === 'intervalTier') {
      if (intervalTierIndices.length < 5) {
        intervalTierIndices.push(i);
      }
    } else if (t.kind === 'textTier' && pointTierIndex === null) {
      pointTierIndex = i;
    }
  }
  return { intervalTierIndices, pointTierIndex };
}

export function resolvePosterTimeRange(
  tg: TextGrid,
  rangeMode: PosterRangeMode,
  viewDomain: { min: number; max: number } | null,
  playRange: { start: number; end: number } | null,
  selection: EditorSelection
): { tMin: number; tMax: number; duration: number } {
  const gMin = Number.isFinite(tg.xmin) ? tg.xmin : 0;
  const gMax = Number.isFinite(tg.xmax) && tg.xmax > gMin ? tg.xmax : gMin + 1;

  let tMin = gMin;
  let tMax = gMax;

  if (rangeMode === 'view' && viewDomain && viewDomain.max > viewDomain.min + 1e-5) {
    tMin = Math.max(gMin, viewDomain.min);
    tMax = Math.min(gMax, viewDomain.max);
  } else if (rangeMode === 'selection') {
    if (playRange && playRange.end > playRange.start + 1e-5) {
      tMin = Math.max(gMin, playRange.start);
      tMax = Math.min(gMax, playRange.end);
    } else if (selection?.kind === 'interval') {
      const iv = tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex];
      if (iv && iv.xmax > iv.xmin + 1e-5) {
        tMin = Math.max(gMin, iv.xmin);
        tMax = Math.min(gMax, iv.xmax);
      }
    }
  }

  if (tMax <= tMin + 1e-5) {
    tMin = gMin;
    tMax = gMax;
  }
  return { tMin, tMax, duration: Math.max(1e-4, tMax - tMin) };
}

/**
 * Main entry: renders the complete artistic voiceprint poster SVG (preview or full export quality).
 */
export async function renderPoster(input: PosterRenderInput): Promise<PosterResult> {
  const { bridge, tg, config, previewMode } = input;
  const { tMin, tMax, duration } = resolvePosterTimeRange(
    tg,
    config.rangeMode,
    input.viewDomain,
    input.playRange,
    input.selection
  );

  // Slice to active time range while preserving original tier indices 1:1
  const [slicedTg] = await Promise.all([
    bridge.sliceTextGrid(tg, { tMin, tMax }),
    ensureIpaFontsLoaded(['sans'])
  ]);
  await prefetchTrigraphCache(slicedTg, bridge);

  const isEmblem = config.framing === 'emblem_1_1';
  const sampleRate = input.audioSampleRate || input.analysis?.sampleRate || 0;
  const maxFreq = input.maxFreq || 8000;

  // Extract waveform bins (shared across all 5 templates)
  const extractWaveform = async (nBins: number): Promise<Array<[number, number]> | null> => {
    if (!input.hasAudio || !config.showWaveform) return null;
    let bins = extractPolarWaveformBins(input.audioBuffer, input.audioOffset, tMin, tMax, nBins);
    if (!bins && input.analysis) {
      try {
        const wfPath = await bridge.computeWaveformPath(
          input.analysis.sessionId,
          [{ x0: 0, x1: nBins, t0: tMin, t1: tMax, collapsed: false }],
          0,
          100
        );
        bins = parseWaveformPathToBins(wfPath, 0, 100, nBins);
      } catch {
        bins = null;
      }
    }
    return bins;
  };

  // Voiced F0 pitch runs (shared across all 5 templates)
  const f0Runs =
    input.hasAudio && config.showPitch
      ? extractVoicedPitchRuns(input.analysis, tMin, tMax, input.f0RangeOverride)
      : [];

  // --------------------------------------------------------------------------
  // Branch A: New Hybrid Templates (`braun_strip`, `folding_fan`, `risograph`)
  // --------------------------------------------------------------------------
  if (
    config.template === 'braun_strip' ||
    config.template === 'folding_fan' ||
    config.template === 'risograph'
  ) {
    const validRings: PolarRingBand[] = config.intervalTierIndices
      .filter((idx) => idx >= 0 && idx < slicedTg.tiers.length && slicedTg.tiers[idx].kind === 'intervalTier')
      .slice(0, 6)
      .map((tierIdx, ringIndex) => {
        const tier = slicedTg.tiers[tierIdx];
        return {
          tierIdx,
          ringIndex,
          name: tier.name || `层 ${ringIndex + 1}`,
          rIn: 0,
          rOut: 0,
          rMid: 0,
          fontSize: 10,
          isIpaLike: isTierIpaLike(tier),
          hasCombining: tierHasCombiningMarks(tier)
        };
      });

    const pointTierObj =
      config.pointTierIndex !== null &&
      config.pointTierIndex >= 0 &&
      config.pointTierIndex < slicedTg.tiers.length &&
      slicedTg.tiers[config.pointTierIndex].kind === 'textTier'
        ? slicedTg.tiers[config.pointTierIndex]
        : null;

    const autoCopy = derivePosterAutoCopy({
      tg: slicedTg,
      filename: input.filename,
      template: config.template,
      tMin,
      tMax,
      rings: validRings,
      pointTierName: pointTierObj ? pointTierObj.name || '标点层' : null,
      hasAudio: input.hasAudio,
      audioSampleRate: sampleRate
    });

    const [specMatrix, waveformBins] = await Promise.all([
      fetchPosterSpecMatrix({
        bridge,
        analysis: input.analysis,
        hasAudio: input.hasAudio,
        showSpectrogram: config.showSpectrogram,
        tMin,
        tMax,
        maxFreq,
        dynRange: input.dynRange ?? 54,
        previewMode
      }),
      extractWaveform(previewMode ? 360 : 540)
    ]);

    const rendered =
      config.template === 'braun_strip'
        ? renderBraunStripPosterSvg({
            tg: slicedTg,
            tMin,
            tMax,
            config,
            autoCopy,
            specMatrix,
            waveformBins,
            f0Runs,
            metrics: computePosterAcousticMetrics({
              hasAudio: input.hasAudio,
              audioBuffer: input.audioBuffer,
              audioOffset: input.audioOffset,
              analysis: input.analysis,
              tMin,
              tMax
            }),
            hasAudio: input.hasAudio,
            audioSampleRate: sampleRate,
            maxFreq,
            previewMode
          })
        : config.template === 'folding_fan'
          ? renderFoldingFanPosterSvg({
              tg: slicedTg,
              tMin,
              tMax,
              config,
              autoCopy,
              specMatrix,
              waveformBins,
              f0Runs,
              hasAudio: input.hasAudio,
              maxFreq,
              previewMode
            })
          : renderRisographPosterSvg({
              tg: slicedTg,
              tMin,
              tMax,
              config,
              autoCopy,
              specMatrix,
              waveformBins,
              f0Runs,
              hasAudio: input.hasAudio,
              audioSampleRate: sampleRate,
              previewMode
            });

    const estimatedBytes = new TextEncoder().encode(rendered.svgMarkup).length;
    return {
      svgMarkup: rendered.svgMarkup,
      widthPt: rendered.widthPt,
      heightPt: rendered.heightPt,
      trimWidthPt: rendered.trimWidthPt,
      trimHeightPt: rendered.trimHeightPt,
      bleedPt: rendered.bleedPt,
      tMin,
      tMax,
      duration,
      estimatedBytes,
      autoCopy,
      activeIntervalCount: rendered.activeIntervalCount,
      activePointCount: rendered.activePointCount
    };
  }

  // --------------------------------------------------------------------------
  // Branch B: Polar Exhibition Templates (`vinyl`, `bauhaus`)
  // --------------------------------------------------------------------------
  const cx = config.template === 'vinyl' ? 450.0 : isEmblem ? 450.0 : 472.0;
  const cy = config.template === 'vinyl' ? (isEmblem ? 468.0 : 568.0) : isEmblem ? 548.0 : 574.0;

  const layout = solvePolarLayout({
    template: config.template,
    tg: slicedTg,
    tMin,
    tMax,
    intervalTierIndices: config.intervalTierIndices,
    pointTierIndex: config.pointTierIndex,
    pointNotes: config.copy.pointNotes,
    cx,
    cy
  });

  const autoCopy = derivePosterAutoCopy({
    tg: slicedTg,
    filename: input.filename,
    template: config.template,
    tMin,
    tMax,
    rings: layout.rings,
    pointTierName: layout.pointTierName,
    hasAudio: input.hasAudio,
    audioSampleRate: sampleRate
  });

  // 1. Polar spectrogram / vinyl disc raster (inline Blob Worker + preview cache)
  const discRaster = await renderPolarSpectrogramRaster({
    style: config.template,
    bridge,
    analysis: input.analysis,
    hasAudio: input.hasAudio,
    showSpectrogram: config.showSpectrogram,
    tMin,
    tMax,
    maxFreq,
    dynRange: input.dynRange ?? (config.template === 'vinyl' ? 60 : 52),
    previewMode,
    cx,
    cy,
    startDeg: config.template === 'vinyl' ? VINYL_START_DEG : BAUHAUS_START_DEG,
    totalDeg: config.template === 'vinyl' ? VINYL_TOTAL_DEG : BAUHAUS_TOTAL_DEG,
    rLabel: VINYL_R_LABEL,
    rWaveIn: VINYL_R_WAVE_IN,
    rSpecIn: config.template === 'vinyl' ? VINYL_R_SPEC_IN : BAUHAUS_R_SPEC0,
    rSpecOut: config.template === 'vinyl' ? VINYL_R_SPEC_OUT : BAUHAUS_R_SPEC1,
    rVinylEdge: VINYL_R_VINYL_EDGE
  });

  // 2. Polar waveform bins (direct AudioBuffer extraction with Rust path fallback)
  const waveformBins = await extractWaveform(
    config.template === 'vinyl' ? (previewMode ? 480 : 720) : previewMode ? 420 : 620
  );

  // 3. Assemble full SVG poster
  const rendered =
    config.template === 'vinyl'
      ? renderVinylPosterSvg({
          tg: slicedTg,
          layout,
          config,
          autoCopy,
          discRaster,
          waveformBins,
          f0Runs,
          hasAudio: input.hasAudio,
          audioSampleRate: sampleRate,
          maxFreq,
          previewMode
        })
      : renderBauhausPosterSvg({
          tg: slicedTg,
          layout,
          config,
          autoCopy,
          discRaster,
          waveformBins,
          f0Runs,
          hasAudio: input.hasAudio,
          audioSampleRate: sampleRate,
          maxFreq,
          previewMode
        });

  const estimatedBytes = new TextEncoder().encode(rendered.svgMarkup).length;

  return {
    ...rendered,
    tMin,
    tMax,
    duration,
    estimatedBytes,
    autoCopy,
    activeIntervalCount: layout.rings.length,
    activePointCount: layout.points.length
  };
}

export async function renderPosterPreview(input: PosterRenderInput): Promise<PosterResult> {
  return renderPoster({ ...input, previewMode: true });
}

export async function renderPosterPngBlob(input: PosterRenderInput): Promise<{
  blob: Blob;
  width: number;
  height: number;
  effectiveScale: number;
  scaleCapped: boolean;
}> {
  const res = await renderPoster({ ...input, previewMode: false });
  const embeddedSvg = await injectIpaFontsIntoSvg(res.svgMarkup);
  const { effectiveScale, scaleCapped } = computeEffectivePngScale(
    res.widthPt,
    res.heightPt,
    input.config.pngScale
  );
  const w = Math.max(1, Math.round(res.widthPt * effectiveScale));
  const h = Math.max(1, Math.round(res.heightPt * effectiveScale));

  const url = URL.createObjectURL(new Blob([embeddedSvg], { type: 'image/svg+xml;charset=utf-8' }));

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          URL.revokeObjectURL(url);
          reject(new Error('无法创建 2D 画布上下文'));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('PNG 编码失败'));
            return;
          }
          resolve({ blob, width: w, height: h, effectiveScale, scaleCapped });
        }, 'image/png');
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      let detail = '';
      try {
        const parsed = new DOMParser().parseFromString(embeddedSvg, 'image/svg+xml');
        const errNode = parsed.querySelector('parsererror');
        if (errNode?.textContent) {
          detail = ` (${errNode.textContent.replace(/\s+/g, ' ').trim().slice(0, 140)})`;
        }
      } catch {
        // ignore
      }
      reject(new Error(`海报 SVG 光栅化失败${detail}`));
    };
    img.src = url;
  });
}

function buildPosterFileStem(filename: string, template: string, framing: string): string {
  const stem = getBaseStem(filename);
  const frameTag = framing === 'emblem_1_1' ? 'emblem' : 'poster';
  return `${stem}_${template}_${frameTag}`;
}

export async function exportPosterSvg(
  input: PosterRenderInput
): Promise<{ savedPath: string | null; filename: string; bytes: number }> {
  const res = await renderPoster({ ...input, previewMode: false });
  const embeddedSvg = await injectIpaFontsIntoSvg(res.svgMarkup);
  const svgBytes = new TextEncoder().encode(embeddedSvg);
  const fname = `${buildPosterFileStem(input.filename, input.config.template, input.config.framing)}.svg`;

  if (isTauriRuntime()) {
    const savedPath = await input.bridge.saveNativeFileDialog(
      fname,
      [{ name: '矢量海报 (SVG)', extensions: ['svg'] }],
      svgBytes,
      { title: '导出声纹海报 (SVG)' }
    );
    return { savedPath, filename: fname, bytes: svgBytes.length };
  }

  triggerBlobDownload(new Blob([embeddedSvg], { type: 'image/svg+xml;charset=utf-8' }), fname);
  return { savedPath: null, filename: fname, bytes: svgBytes.length };
}

export async function exportPosterPng(
  input: PosterRenderInput
): Promise<{
  savedPath: string | null;
  filename: string;
  width: number;
  height: number;
  effectiveScale: number;
  scaleCapped: boolean;
}> {
  const png = await renderPosterPngBlob(input);
  const fname = `${buildPosterFileStem(input.filename, input.config.template, input.config.framing)}.png`;

  if (isTauriRuntime()) {
    const bytes = new Uint8Array(await png.blob.arrayBuffer());
    const savedPath = await input.bridge.saveNativeFileDialog(
      fname,
      [{ name: '高清海报 (PNG)', extensions: ['png'] }],
      bytes,
      { title: '导出声纹海报 (PNG)' }
    );
    return {
      savedPath,
      filename: fname,
      width: png.width,
      height: png.height,
      effectiveScale: png.effectiveScale,
      scaleCapped: png.scaleCapped
    };
  }

  triggerBlobDownload(png.blob, fname);
  return {
    savedPath: null,
    filename: fname,
    width: png.width,
    height: png.height,
    effectiveScale: png.effectiveScale,
    scaleCapped: png.scaleCapped
  };
}

export async function copyPosterPngToClipboard(
  input: PosterRenderInput
): Promise<{ width: number; height: number }> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('当前环境不支持复制图片到剪贴板');
  }
  const png = await renderPosterPngBlob(input);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png.blob })]);
  return { width: png.width, height: png.height };
}

/**
 * Native OS Print / Save-as-PDF via an isolated hidden iframe carrying the pure vector SVG.
 * Detects `beforeprint` / `afterprint` or synchronous dialog blocking so silent suppression is reported cleanly.
 */
export async function printPosterPdf(input: PosterRenderInput): Promise<{ printTriggered: boolean }> {
  const res = await renderPoster({ ...input, previewMode: false });
  const embeddedSvg = await injectIpaFontsIntoSvg(res.svgMarkup);
  const wMm = (res.widthPt * 25.4) / 72;
  const hMm = (res.heightPt * 25.4) / 72;
  const cleanSvg = embeddedSvg.replace(/^<\?xml[^>]*\?>\s*/i, '');

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.left = '-9999px';
  iframe.style.top = '0';
  iframe.style.width = '1px';
  iframe.style.height = '1px';
  iframe.style.border = '0';
  iframe.style.opacity = '0';
  iframe.style.pointerEvents = 'none';
  document.body.appendChild(iframe);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    } catch {
      // ignore
    }
  };

  try {
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    const win = iframe.contentWindow;
    if (!doc || !win) {
      cleanup();
      throw new Error('无法初始化打印视图');
    }
    doc.open();
    doc.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${buildPosterFileStem(input.filename, input.config.template, input.config.framing)}</title>
<style>
  @page { size: ${wMm.toFixed(1)}mm ${hMm.toFixed(1)}mm; margin: 0; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    overflow: hidden;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  svg {
    display: block;
    width: 100vw;
    height: 100vh;
    max-width: 100%;
    max-height: 100%;
  }
</style>
</head>
<body>${cleanSvg}</body>
</html>`);
    doc.close();

    // Wait briefly for embedded data-URI fonts & raster images inside iframe to settle
    try {
      await Promise.race([
        doc.fonts?.ready ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, 1200))
      ]);
    } catch {
      // ignore font check error in print iframe
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 160));

    let printTriggered = false;
    const onPrintStart = () => {
      printTriggered = true;
    };
    const onAfterPrint = () => {
      printTriggered = true;
      cleanup();
    };
    win.addEventListener('beforeprint', onPrintStart, { once: true });
    win.addEventListener('afterprint', onAfterPrint, { once: true });

    const callStart = performance.now();
    win.focus();
    win.print();
    const callElapsed = performance.now() - callStart;
    if (callElapsed >= 200) {
      printTriggered = true;
    }

    if (!printTriggered) {
      await new Promise<void>((resolve) => setTimeout(resolve, 450));
    }

    setTimeout(cleanup, printTriggered ? 60_000 : 1_500);
    return { printTriggered };
  } catch (err) {
    cleanup();
    throw err;
  }
}
