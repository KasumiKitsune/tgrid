import type { AudioAnalysisSummary, ContourPath, TextGrid } from '../bridge/types';
import {
  IPA_FONT_STACK,
  MONO_FONT_STACK,
  SANS_FONT_STACK,
  SYMBOL_FONT_STACK,
  decodeTrigraphGlossSync,
  formatPraatDouble,
  measurePx,
  splitGraphemes,
  type RichTextLayout
} from '../layout/richText';
import {
  SVG_NS,
  WARM_PALETTE,
  renderBand0AxisLabels,
  renderEmbeddedLegendSVG,
  svgEl,
  type ScorePalette
} from '../layout/legendCore';
import {
  elasticXInBand,
  xForTierTime,
  type BandLayout,
  type ScoreLayout,
  type TierScaleMode
} from '../layout/computeLayout';
import type { F0RangeBounds } from '../utils/f0Range';
import { createDefaultStyleDocument, hasAnyCustomStyle } from '../style/palettes';
import {
  buildStyleLegendItems,
  buildSvgPatternDefs,
  collectUsedPatternSpecs,
  makeSvgPatternId,
  resolveBoundaryStyle,
  resolveIntervalStyle,
  resolvePointStyle,
  resolveTierStyle
} from '../style/resolveStyle';
import { buildSvgProjectMetadataXml } from '../style/styleCodec';
import type {
  LineDash,
  PointShape,
  ResolvedBoundaryStyle,
  StyleDocument,
  StyleLegendItem,
  SvgPatternSpec
} from '../style/types';
import { renderVadPreviewOverlayAllBands, type VadOverlayState } from './renderVadOverlay';

export type EditorSelection =
  | { kind: 'interval'; tierIndex: number; itemIndex: number; bandIndex?: number }
  | { kind: 'point'; tierIndex: number; itemIndex: number; bandIndex?: number }
  | { kind: 'boundary'; tierIndex: number; time: number; bandIndex?: number }
  | { kind: 'spine'; time: number; bandIndex?: number }
  | { kind: 'tier'; tierIndex: number; bandIndex?: number }
  | null;

export interface DragPreviewState {
  bandIndex: number;
  x: number;
  linearX: number;
  origTime?: number;
  origX?: number;
  origLinearX?: number;
  y0: number;
  y1: number;
  cursorY?: number;
  snapX: number | null;
  snapTime?: number | null;
  snapMode?: boolean;
  snapLabel?: string | null;
  showCompactTag?: boolean;
  coordSpace?: TierScaleMode;
  time: number;
}

export interface EdgeSnapVisual {
  x: number;
  linX: number;
  t?: number;
  label: string;
}

export interface BlockTierPreviewSlice {
  tierIndex: number;
  x0?: number;
  x1?: number;
  y0: number;
  y1: number;
  interiorXs: number[];
  interiorLinXs?: number[];
  pointXs?: number[];
  blockedSide?: 'left' | 'right' | null;
}

export interface MultiUnitPreviewBox {
  tierIndex: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  interiorXs: number[];
  blockedSide?: 'left' | 'right' | null;
}

export interface IntervalDragPreviewState {
  bandIndex: number;
  tierIndex: number;
  mode: 'create' | 'move' | 'block-move' | 'block-resize' | 'multi-sync';
  tStart: number;
  tEnd: number;
  x0: number;
  x1: number;
  linX0: number;
  linX1: number;
  y0: number;
  y1: number;
  startSnap?: EdgeSnapVisual | null;
  endSnap?: EdgeSnapVisual | null;
  compressWarningSide?: 'left' | 'right' | null;
  blockSlices?: BlockTierPreviewSlice[];
  multiUnitPreviews?: MultiUnitPreviewBox[];
  multiSyncLabel?: string | null;
  blockCount?: number;
  blockedSide?: 'left' | 'right' | null;
  blockedLabel?: string | null;
  resizeFixedSide?: 'left' | 'right' | null;
  // Keep legacy fields optional for compatibility
  snapX?: number | null;
  snapSide?: 'start' | 'end' | null;
  snapLabel?: string | null;
  text?: string;
}

export type BandSpecRenderResult =
  | { kind: 'none' }
  | { kind: 'contour'; paths: ContourPath[] }
  | { kind: 'embed-defs'; defId: string; dataUrl: string }
  | { kind: 'external-zip'; relHref: string }
  | { kind: 'raster-png'; dataUrl: string };

export interface RenderScoreExportContext {
  palette: ScorePalette;
  transparentBg: boolean;
  fontFamily: string;
  sansFontFamily?: string;
  monoFontFamily?: string;
  symbolFontFamily?: string;
  fontScale: number;
  strokeScale: number;
  trigraphMode: 'ipa-only' | 'dual' | 'raw-only';
  hideMetaSymbols: boolean;
  hideStretchCues: boolean;
  hideScaleBadges?: boolean;
  legendMode: 'full' | 'compact' | 'off';
  legendLang: 'zh' | 'en';
  showCaption: boolean;
  captionTitle: string;
  captionTimeText: string;
  showLinearScaleBar: boolean;
  semanticGroups: boolean;
  idPrefix?: string;
  sanitizeId: (name: string) => string;
  computeScaleBar: (band: BandLayout) => { sec: number; pxLen: number; label: string } | null;
  specStrategy: string;
  specOpacity: number;
  pitchOpacity: number;
  formantOpacity: number;
  bandSpecResults: Map<number, BandSpecRenderResult>;
  bwPrintMode?: boolean;
  showStyleLegend?: boolean;
  embedProjectMetadata?: boolean;
  metadataFilename?: string;
}

export interface RenderScoreInput {
  tg: TextGrid;
  layout: ScoreLayout;
  hasAudio: boolean;
  audioBuffer: AudioBuffer | null;
  audioOffset: number;
  analysis: AudioAnalysisSummary | null;
  maxFreq: number;
  f0RangeOverride?: F0RangeBounds | null;
  mode: 'read' | 'edit';
  selection: EditorSelection;
  multiSelection?: Array<{ tierIndex: number; itemIndex: number }>;
  playRange: { start: number; end: number } | null;
  currentTime: number;
  showPlayhead: boolean;
  dragPreview: DragPreviewState | null;
  intervalDragPreview?: IntervalDragPreviewState | null;
  screenSpecUrls?: Map<number, string>;
  exportCtx?: RenderScoreExportContext | null;
  styleDoc?: StyleDocument | null;
  showStyleLegendPreview?: boolean;
  vadOverlay?: VadOverlayState | null;
}

function dashArrayFor(dash: LineDash | undefined, sScale = 1): string | undefined {
  if (!dash || dash === 'solid') return undefined;
  if (dash === 'dashed') {
    return sScale === 1
      ? '5,3'
      : `${Number((5 * sScale).toFixed(2))},${Number((3 * sScale).toFixed(2))}`;
  }
  if (dash === 'dotted') {
    return sScale === 1
      ? '1.5,2.5'
      : `${Number((1.5 * sScale).toFixed(2))},${Number((2.5 * sScale).toFixed(2))}`;
  }
  return undefined;
}

function renderPointMarkerSVG(
  parent: Element,
  cx: number,
  cy: number,
  shape: PointShape,
  radius: number,
  opts: {
    fill: string;
    stroke: string;
    strokeWidth: number;
    className?: string;
    legendKey?: string;
  }
): SVGElement {
  const baseAttrs: Record<string, string | number | undefined> = {
    ...(opts.className ? { class: opts.className } : {}),
    ...(opts.legendKey ? { 'data-legend-keys': opts.legendKey } : {})
  };
  const r = Math.max(1.5, radius);

  switch (shape) {
    case 'circle':
      return svgEl(
        'circle',
        {
          ...baseAttrs,
          cx,
          cy,
          r,
          fill: opts.fill,
          stroke: opts.stroke,
          'stroke-width': opts.strokeWidth
        },
        parent
      );
    case 'square': {
      const s = Number((r * 0.88).toFixed(2));
      return svgEl(
        'rect',
        {
          ...baseAttrs,
          x: cx - s,
          y: cy - s,
          width: s * 2,
          height: s * 2,
          fill: opts.fill,
          stroke: opts.stroke,
          'stroke-width': opts.strokeWidth
        },
        parent
      );
    }
    case 'triangle': {
      const topY = cy - r * 1.12;
      const botY = cy + r * 0.82;
      const halfW = r * 1.05;
      return svgEl(
        'polygon',
        {
          ...baseAttrs,
          points: `${cx},${topY} ${cx + halfW},${botY} ${cx - halfW},${botY}`,
          fill: opts.fill,
          stroke: opts.stroke,
          'stroke-width': opts.strokeWidth
        },
        parent
      );
    }
    case 'cross': {
      const s = Number((r * 0.85).toFixed(2));
      return svgEl(
        'path',
        {
          ...baseAttrs,
          d: `M${cx - s},${cy - s} L${cx + s},${cy + s} M${cx + s},${cy - s} L${cx - s},${cy + s}`,
          fill: 'none',
          stroke: opts.stroke,
          'stroke-width': Math.max(1.5, opts.strokeWidth),
          'stroke-linecap': 'round'
        },
        parent
      );
    }
    case 'diamond':
    default:
      return svgEl(
        'polygon',
        {
          ...baseAttrs,
          points: `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`,
          fill: opts.fill,
          stroke: opts.stroke,
          'stroke-width': opts.strokeWidth
        },
        parent
      );
  }
}

interface StyleLegendPositionedItem {
  item: StyleLegendItem;
  x: number;
  y: number;
  swatchX: number;
  swatchY: number;
  labelX: number;
  labelY: number;
}

interface ComputedStyleLegendLayout {
  ruleY: number;
  boxX: number;
  boxW: number;
  itemFontSize: number;
  swatchW: number;
  swatchH: number;
  extraHeight: number;
  entries: StyleLegendPositionedItem[];
}

function computeStyleLegendLayout(
  items: readonly StyleLegendItem[],
  layout: ScoreLayout,
  fScale: number
): ComputedStyleLegendLayout | null {
  if (items.length === 0) return null;
  const boxX = layout.padX;
  const innerAvailW = Math.max(180, layout.width - layout.padX * 2);
  const boxW = layout.width > 1200 ? Math.min(840, innerAvailW) : innerAvailW;
  const itemFontSize = Number((9 * fScale).toFixed(2));
  const itemFont = `${itemFontSize}px ${SANS_FONT_STACK}`;
  const swatchW = 14;
  const swatchH = 10;
  const swatchGap = 5;
  const itemGapX = 14;
  const rowH = Math.ceil(16 * fScale);

  const baseBottom = layout.height - layout.padBottom;
  const ruleY = baseBottom + 8;
  const rowsTopY = ruleY + 9;

  let curX = boxX;
  let curRow = 0;
  const entries: StyleLegendPositionedItem[] = [];

  for (const item of items) {
    const labelW = Math.ceil(measurePx(item.label, itemFont));
    const entryW = swatchW + swatchGap + labelW;
    if (curX > boxX && curX + entryW > boxX + boxW) {
      curX = boxX;
      curRow += 1;
    }
    const rowY = rowsTopY + curRow * rowH;
    entries.push({
      item,
      x: curX,
      y: rowY,
      swatchX: curX,
      swatchY: rowY + Math.max(0, (rowH - swatchH) / 2),
      labelX: curX + swatchW + swatchGap,
      labelY: rowY + rowH / 2 + itemFontSize * 0.34
    });
    curX += entryW + itemGapX;
  }

  const totalRows = curRow + 1;
  const contentEndY = rowsTopY + totalRows * rowH;
  const extraHeight = Math.ceil(contentEndY + 6 - baseBottom);

  return {
    ruleY,
    boxX,
    boxW,
    itemFontSize,
    swatchW,
    swatchH,
    extraHeight,
    entries
  };
}

function truncateTierNameMiddle(name: string, maxW: number, font: string): string {
  if (measurePx(name, font) <= maxW) return name;
  const graphemes = splitGraphemes(name);
  if (graphemes.length <= 1) return name;
  let lo = 2;
  let hi = graphemes.length - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const keep = (lo + hi) >> 1;
    const tailLen = Math.max(1, Math.floor(keep / 2));
    const headLen = keep - tailLen;
    const candidate =
      graphemes.slice(0, headLen).join('') +
      '…' +
      graphemes.slice(graphemes.length - tailLen).join('');
    if (measurePx(candidate, font) <= maxW) {
      best = candidate;
      lo = keep + 1;
    } else {
      hi = keep - 1;
    }
  }
  if (best !== null) return best;
  return graphemes[0] + '…';
}

function renderRichTextSVG(
  parent: Element,
  rich: RichTextLayout | null,
  x: number,
  y: number,
  align: 'start' | 'middle' | 'end',
  fontSize: number,
  styleOpts: {
    isExport: boolean;
    fontFamily: string;
    monoFontFamily?: string;
    symbolFontFamily?: string;
    palette: ScorePalette;
    fontScale: number;
  } | null,
  textScale = 1,
  textStyle?: {
    color?: string;
    fontWeight?: 'normal' | 'bold';
    fontStyle?: 'normal' | 'italic';
  } | null
): void {
  if (!rich) return;
  const isExport = Boolean(styleOpts?.isExport);
  const fontFamily = styleOpts?.fontFamily || IPA_FONT_STACK;
  const monoFamily = styleOpts?.monoFontFamily || MONO_FONT_STACK;
  const symbolFamily = styleOpts?.symbolFontFamily || SYMBOL_FONT_STACK;
  const pal = styleOpts?.palette || WARM_PALETTE;
  const baseScale = styleOpts?.fontScale || 1;
  const fScale = baseScale * textScale;
  const effSize = Number((fontSize * fScale).toFixed(2));
  const glossSize = Number((11.2 * fScale).toFixed(2));
  const glossRawSize = Number((10.2 * fScale).toFixed(2));
  const ctrlSize = Number((9.5 * fScale).toFixed(2));
  const customColor = textStyle?.color;
  const customWeight = textStyle?.fontWeight === 'bold' ? 'bold' : undefined;
  const customStyle = textStyle?.fontStyle === 'italic' ? 'italic' : undefined;
  const textWrap = svgEl('g', isExport ? {} : { 'data-text-node': '1' }, parent);
  let curY = y;

  const glossLines = rich.glossLines?.length ? rich.glossLines : rich.gloss ? [rich.gloss] : [];
  const glossLineH =
    (rich.glossLineH || Math.round((rich.glossIsRaw ? 14 : 15) * baseScale)) * textScale;
  const effLineH = rich.lineH * textScale;

  if (glossLines.length > 0 && !rich.glossIsRaw) {
    for (const gl of glossLines) {
      const gt = svgEl(
        'text',
        {
          x,
          y: curY + Math.round(11 * fScale),
          'text-anchor': align,
          'font-family': fontFamily,
          'font-size': String(glossSize),
          fill: customColor || pal.gloss,
          ...(customColor ? { opacity: '0.84' } : {}),
          ...(customWeight ? { 'font-weight': customWeight } : {}),
          ...(customStyle ? { 'font-style': customStyle } : {}),
          ...(isExport ? {} : { 'data-legend-keys': 'trigraph' })
        },
        textWrap
      );
      gt.textContent = gl;
      curY += glossLineH;
    }
    curY += Math.round(3 * fScale);
  }

  for (const line of rich.lines) {
    const tx = svgEl(
      'text',
      {
        x,
        y: curY + Math.round(12.5 * fScale),
        'text-anchor': align,
        'font-family': fontFamily,
        'font-size': String(effSize),
        'xml:space': 'preserve',
        ...(customWeight ? { 'font-weight': customWeight } : {}),
        ...(customStyle ? { 'font-style': customStyle } : {})
      },
      textWrap
    );
    for (const tok of line.tokens) {
      const ts = svgEl(
        'tspan',
        !isExport && tok.kind !== 'text' ? { 'data-legend-keys': 'meta-symbols' } : {},
        tx
      );
      ts.textContent = tok.str;
      if (tok.kind === 'text') ts.setAttribute('fill', customColor || pal.ink);
      else if (tok.kind === 'wrap') {
        ts.setAttribute('fill', pal.isBw ? pal.meta : pal.faint);
        ts.setAttribute('font-family', symbolFamily);
        ts.setAttribute('font-size', String(Number((effSize - 1.5).toFixed(2))));
      } else if (tok.kind === 'ctrl') {
        ts.setAttribute('fill', pal.ctrl);
        ts.setAttribute('font-family', monoFamily);
        ts.setAttribute('font-size', String(ctrlSize));
      } else {
        ts.setAttribute('fill', pal.meta);
        ts.setAttribute('font-family', symbolFamily);
      }
    }
    curY += effLineH;
  }

  if (glossLines.length > 0 && rich.glossIsRaw) {
    curY += Math.round(2 * fScale);
    for (const gl of glossLines) {
      const gt = svgEl(
        'text',
        {
          x,
          y: curY + Math.round(10.5 * fScale),
          'text-anchor': align,
          'font-family': monoFamily,
          'font-size': String(glossRawSize),
          fill: customColor || pal.gloss,
          opacity: customColor ? '0.78' : '0.88',
          ...(isExport ? {} : { 'data-legend-keys': 'trigraph' })
        },
        textWrap
      );
      gt.textContent = gl;
      curY += glossLineH;
    }
  }
}

export function buildWaveformPolygonPath(
  audioBuffer: AudioBuffer | null,
  soundOffset: number,
  segs: BandLayout['linearSegs'],
  y: number,
  h: number
): string {
  if (!audioBuffer || audioBuffer.length === 0) return '';
  const sr = audioBuffer.sampleRate;
  const ch0 = audioBuffer.getChannelData(0);
  const totalSamples = ch0.length;
  const midY = y + h / 2;
  const amp = h / 2 - 2.5;
  let d = '';
  for (const seg of segs) {
    if (seg.collapsed) continue;
    const pxW = Math.floor(seg.x1 - seg.x0);
    if (pxW < 2) continue;
    const dt = seg.t1 - seg.t0;
    if (dt <= 0) continue;
    const upper: string[] = [];
    const lower: string[] = [];
    const step = Math.max(1, Math.floor(pxW / 600));
    for (let px = 0; px <= pxW; px += step) {
      const t0 = seg.t0 + (px / pxW) * dt - soundOffset;
      const t1 = seg.t0 + ((px + step) / pxW) * dt - soundOffset;
      let s0 = Math.floor(t0 * sr);
      let s1 = Math.ceil(t1 * sr);
      if (s1 <= 0 || s0 >= totalSamples) {
        upper.push(`${(seg.x0 + px).toFixed(1)},${midY.toFixed(1)}`);
        lower.push(`${(seg.x0 + px).toFixed(1)},${midY.toFixed(1)}`);
        continue;
      }
      s0 = Math.max(0, s0);
      s1 = Math.min(totalSamples - 1, Math.max(s0, s1));
      let minV = 0;
      let maxV = 0;
      const stride = Math.max(1, Math.floor((s1 - s0) / 48));
      for (let s = s0; s <= s1; s += stride) {
        const v = ch0[s];
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
      const xStr = (seg.x0 + px).toFixed(1);
      upper.push(`${xStr},${(midY - maxV * amp).toFixed(1)}`);
      lower.push(`${xStr},${(midY - minV * amp).toFixed(1)}`);
    }
    if (upper.length > 1) {
      d += `M ${upper[0]} L ${upper.slice(1).join(' L ')} L ${lower.reverse().join(' L ')} Z `;
    }
  }
  return d;
}

export interface TimePolylineStyle {
  stroke: string;
  strokeWidth: number;
  opacity?: number;
  dashArray?: string;
  neckStrokeWidth?: number;
  neckOpacity?: number;
  neckDashArray?: string;
  tierDashArray?: string;
  tierOpacity?: number;
  tierStrokeWidth?: number;
  dockOpacity?: number;
  dockStrokeWidth?: number;
  skipTickSpine?: boolean;
  hideTicks?: boolean;
  gapWindow?: { y0: number; y1: number } | null;
}

/**
 * Unified vertical/sloped time-axis polyline renderer that traverses 0 / 1 / N transition necks
 * cleanly across `band.coordSlices` and automatically docks around the rotated -52° timestamp spine.
 */
export function renderTimePolyline(
  parent: Element,
  band: BandLayout,
  t: number,
  yFrom: number,
  yTo: number,
  style: TimePolylineStyle
): void {
  const topY = Math.min(yFrom, yTo);
  const botY = Math.max(yFrom, yTo);
  if (botY <= topY + 1e-6) return;

  const lx = band.linearXForTime(t);
  const ex = elasticXInBand(band, t);
  const acousticBotY = band.linearY + band.linearH;
  const skipTicks = style.skipTickSpine !== false && !style.hideTicks;

  const drawSeg = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    segKind: 'acoustic' | 'tier' | 'neck' | 'dock'
  ) => {
    if (Math.abs(y2 - y1) <= 1e-6 && Math.abs(x2 - x1) <= 1e-6) return;
    const swVal =
      segKind === 'neck'
        ? (style.neckStrokeWidth ?? style.strokeWidth)
        : segKind === 'tier'
          ? (style.tierStrokeWidth ?? style.strokeWidth)
          : segKind === 'dock'
            ? (style.dockStrokeWidth ?? style.strokeWidth)
            : style.strokeWidth;
    const opVal =
      segKind === 'neck'
        ? (style.neckOpacity ?? style.opacity)
        : segKind === 'tier'
          ? (style.tierOpacity ?? style.opacity)
          : segKind === 'dock'
            ? (style.dockOpacity ?? style.opacity)
            : style.opacity;
    const dashVal =
      segKind === 'dock'
        ? undefined
        : segKind === 'neck'
          ? (style.neckDashArray ?? style.dashArray)
          : segKind === 'tier'
            ? (style.tierDashArray ?? style.dashArray)
            : style.dashArray;
    svgEl(
      'line',
      {
        x1,
        y1,
        x2,
        y2,
        stroke: style.stroke,
        'stroke-width': swVal,
        ...(dashVal ? { 'stroke-dasharray': dashVal } : {}),
        ...(opVal !== undefined ? { opacity: opVal } : {})
      },
      parent
    );
  };

  const drawVerticalWithGap = (
    x: number,
    y1: number,
    y2: number,
    segKind: 'acoustic' | 'tier'
  ) => {
    const gap = style.gapWindow;
    if (gap && gap.y1 > y1 && gap.y0 < y2) {
      if (gap.y0 > y1) drawSeg(x, y1, x, Math.min(y2, gap.y0), segKind);
      if (gap.y1 < y2) drawSeg(x, Math.max(y1, gap.y1), x, y2, segKind);
    } else {
      drawSeg(x, y1, x, y2, segKind);
    }
  };

  // Top overhang above band.linearY (e.g., playhead cap stub)
  if (topY < band.linearY) {
    drawSeg(lx, topY, lx, Math.min(botY, band.linearY), 'acoustic');
  }

  for (const slice of band.coordSlices) {
    const sy0 = Math.max(topY, slice.y0);
    const sy1 = Math.min(botY, slice.y1);
    if (sy1 <= sy0 + 1e-6) continue;

    if (slice.kind === 'linear') {
      // Split across acoustic boundary if different tier styling is requested
      if (
        (style.tierDashArray !== undefined || style.tierOpacity !== undefined || style.tierStrokeWidth !== undefined) &&
        sy0 < acousticBotY &&
        sy1 > acousticBotY
      ) {
        drawVerticalWithGap(lx, sy0, acousticBotY, 'acoustic');
        drawVerticalWithGap(lx, acousticBotY, sy1, 'tier');
      } else {
        const segKind = sy0 >= acousticBotY - 1e-6 ? 'tier' : 'acoustic';
        drawVerticalWithGap(lx, sy0, sy1, segKind);
      }
    } else if (slice.kind === 'elastic') {
      drawVerticalWithGap(ex, sy0, sy1, 'tier');
    } else if (slice.kind === 'neck-l2e' || slice.kind === 'neck-e2l') {
      const span = Math.max(1e-6, slice.y1 - slice.y0);
      const u0 = (sy0 - slice.y0) / span;
      const u1 = (sy1 - slice.y0) / span;
      const topX = slice.kind === 'neck-l2e' ? lx : ex;
      const botX = slice.kind === 'neck-l2e' ? ex : lx;
      drawSeg(
        topX + (botX - topX) * u0,
        sy0,
        topX + (botX - topX) * u1,
        sy1,
        'neck'
      );
    } else if (slice.kind === 'tick-spine') {
      const spineX = band.effectiveScaleMode === 'linear' ? lx : ex;
      if (skipTicks && slice.y1 - slice.y0 > 8) {
        const topDockEnd = Math.min(sy1, slice.y0 + 3);
        if (topDockEnd > sy0) drawSeg(spineX, sy0, spineX, topDockEnd, 'dock');
        const botDockStart = Math.max(sy0, slice.y1 - 3);
        if (sy1 > botDockStart) drawSeg(spineX, botDockStart, spineX, sy1, 'dock');
      } else {
        drawSeg(spineX, sy0, spineX, sy1, 'tier');
      }
    }
  }

  // Bottom overhang below band.tiersBottomY
  if (botY > band.tiersBottomY) {
    const lastSlice = band.coordSlices[band.coordSlices.length - 1];
    const botX = !lastSlice || lastSlice.kind === 'linear' ? lx : ex;
    drawSeg(botX, Math.max(topY, band.tiersBottomY), botX, botY, 'tier');
  }
}

/**
 * Renders translucent span focus trapezoids across all traversed transition necks between [yFrom, yTo].
 */
export function renderTimeSpanFocus(
  parent: Element,
  band: BandLayout,
  t0: number,
  t1: number,
  style: {
    fill: string;
    fillOpacity?: number;
    yFrom?: number;
    yTo?: number;
  }
): void {
  const segT0 = Math.max(band.startT, Math.min(t0, t1));
  const segT1 = Math.min(band.endT, Math.max(t0, t1));
  if (segT1 <= segT0) return;
  const yTop = style.yFrom ?? band.linearY;
  const yBot = style.yTo ?? band.tiersBottomY;
  const lx0 = band.linearXForTime(segT0);
  const lx1 = band.linearXForTime(segT1);
  const ex0 = elasticXInBand(band, segT0);
  const ex1 = elasticXInBand(band, segT1);
  const baseOp = style.fillOpacity ?? 0.13;

  for (const slice of band.coordSlices) {
    if (slice.kind !== 'neck-l2e' && slice.kind !== 'neck-e2l') continue;
    if (slice.y1 <= yTop + 1e-6 || slice.y0 >= yBot - 1e-6) continue;
    const tx0 = slice.kind === 'neck-l2e' ? lx0 : ex0;
    const tx1 = slice.kind === 'neck-l2e' ? lx1 : ex1;
    const bx0 = slice.kind === 'neck-l2e' ? ex0 : lx0;
    const bx1 = slice.kind === 'neck-l2e' ? ex1 : lx1;
    svgEl(
      'polygon',
      {
        points: `${tx0},${slice.y0} ${tx1},${slice.y0} ${bx1},${slice.y1} ${bx0},${slice.y1}`,
        fill: style.fill,
        'fill-opacity': slice.isPrimary === false ? Number((baseOp * 0.65).toFixed(3)) : baseOp
      },
      parent
    );
  }
}

export function renderInteractiveOverlay(
  layerG: Element | null,
  layout: ScoreLayout,
  input: Pick<
    RenderScoreInput,
    | 'selection'
    | 'multiSelection'
    | 'playRange'
    | 'currentTime'
    | 'showPlayhead'
    | 'dragPreview'
    | 'intervalDragPreview'
    | 'hasAudio'
  > &
    Partial<Pick<RenderScoreInput, 'tg' | 'styleDoc' | 'vadOverlay'>>
): void {
  if (!layerG) return;
  while (layerG.firstChild) layerG.removeChild(layerG.firstChild);

  if (input.vadOverlay?.active) {
    renderVadPreviewOverlayAllBands(layerG, layout, input.vadOverlay);
  }

  const hasCustomStyle = Boolean(input.tg && input.styleDoc && hasAnyCustomStyle(input.styleDoc));

  const getCustomBorderInset = (tierIndex: number, itemIndex: number): number | null => {
    if (!hasCustomStyle || !input.tg || !input.styleDoc) return null;
    const st = resolveIntervalStyle(input.styleDoc, input.tg, tierIndex, itemIndex);
    if (!st.hasCustom || !st.hasCustomBorder || st.borderWidth <= 0) return null;
    return Math.max(0.5, st.borderWidth / 2);
  };

  // Non-occluding selection focus for intervals carrying a custom border:
  // draws subtle interior tint plus top/bottom focus rails strictly inside [x0, x1] in TIER_GAP clearance
  // (or inset corner reticles when an interior multi-lane lacks vertical clearance) so custom dash/width stays 100% visible
  // without intruding horizontally into adjacent intervals.
  const drawCustomBorderIntervalFocus = (
    x0: number,
    w: number,
    ly: number,
    lh: number,
    lane: number,
    laneCount: number,
    opts: {
      color: string;
      fillOpacity: number;
      strokeWidth: number;
      dashArray?: string;
      borderInset: number;
    }
  ) => {
    svgEl(
      'rect',
      {
        x: x0,
        y: ly,
        width: w,
        height: lh,
        fill: opts.color,
        'fill-opacity': opts.fillOpacity
      },
      layerG
    );

    const x1 = x0 + w;
    const canTopRail = lane === 0;
    const canBotRail = lane === laneCount - 1;
    const railAttrs: Record<string, string | number> = {
      fill: 'none',
      stroke: opts.color,
      'stroke-width': opts.strokeWidth,
      ...(opts.dashArray ? { 'stroke-dasharray': opts.dashArray } : {})
    };

    if (canTopRail) {
      const railY = ly - 2.2;
      if (w >= 8) {
        const rx0 = x0 + 0.75;
        const rx1 = x1 - 0.75;
        svgEl(
          'path',
          {
            d: `M${rx0},${ly - 0.2} L${rx0},${railY} L${rx1},${railY} L${rx1},${ly - 0.2}`,
            ...railAttrs
          },
          layerG
        );
      } else {
        svgEl('line', { x1: x0, y1: railY, x2: x1, y2: railY, ...railAttrs }, layerG);
      }
    }

    if (canBotRail) {
      const railY = ly + lh + 2.2;
      if (w >= 8) {
        const rx0 = x0 + 0.75;
        const rx1 = x1 - 0.75;
        svgEl(
          'path',
          {
            d: `M${rx0},${ly + lh + 0.2} L${rx0},${railY} L${rx1},${railY} L${rx1},${ly + lh + 0.2}`,
            ...railAttrs
          },
          layerG
        );
      } else {
        svgEl('line', { x1: x0, y1: railY, x2: x1, y2: railY, ...railAttrs }, layerG);
      }
    }

    if (!canTopRail || !canBotRail) {
      const pad = opts.borderInset + 2;
      const arm = Math.min(4, Math.max(2, Math.floor((Math.min(w, lh) - pad * 2) / 3)));
      if (w >= pad * 2 + arm * 2 && lh >= pad * 2 + arm * 2) {
        const ix0 = x0 + pad;
        const ix1 = x1 - pad;
        const iy0 = ly + pad;
        const iy1 = ly + lh - pad;
        const parts: string[] = [];
        if (!canTopRail) {
          parts.push(`M${ix0},${iy0 + arm} L${ix0},${iy0} L${ix0 + arm},${iy0}`);
          parts.push(`M${ix1 - arm},${iy0} L${ix1},${iy0} L${ix1},${iy0 + arm}`);
        }
        if (!canBotRail) {
          parts.push(`M${ix0},${iy1 - arm} L${ix0},${iy1} L${ix0 + arm},${iy1}`);
          parts.push(`M${ix1 - arm},${iy1} L${ix1},${iy1} L${ix1},${iy1 - arm}`);
        }
        if (parts.length > 0) {
          svgEl(
            'path',
            {
              d: parts.join(' '),
              fill: 'none',
              stroke: opts.color,
              'stroke-width': 1.35,
              opacity: 0.9
            },
            layerG
          );
        }
      }
    }
  };

  // Spine-safe vertical guide & neck focus helpers backed by unified coordSlices renderer
  const drawNeckFocusTrapezoid = (
    band: BandLayout,
    t0: number,
    t1: number,
    fillColor = '#1D4ED8',
    fillOpacity = 0.13,
    yTo?: number
  ) => {
    renderTimeSpanFocus(layerG, band, t0, t1, {
      fill: fillColor,
      fillOpacity,
      yFrom: band.linearY,
      yTo: yTo ?? band.tiersBottomY
    });
  };

  if (input.playRange) {
    const { start, end } = input.playRange;
    const hasSpan = Number.isFinite(start) && Number.isFinite(end) && end > start;
    const rangeColor = '#1F4E8C';

    for (const band of layout.bands) {
      if (end <= band.startT || start >= band.endT) continue;
      const lx0 = band.linearXForTime(Math.max(start, band.startT));
      const lx1 = band.linearXForTime(Math.min(end, band.endT));
      svgEl(
        'rect',
        {
          x: lx0,
          y: band.linearY,
          width: Math.max(1, lx1 - lx0),
          height: band.linearH,
          fill: rangeColor,
          opacity: 0.11
        },
        layerG
      );
      if (hasSpan) {
        drawNeckFocusTrapezoid(band, start, end, '#1D4ED8', 0.13);
      }
    }

    if (hasSpan) {
      const drawRangeProjection = (t: number, side: 'start' | 'end') => {
        for (const band of layout.bands) {
          const ownsBoundary =
            side === 'start'
              ? t >= band.startT && t < band.endT
              : t > band.startT && t <= band.endT;
          if (!ownsBoundary) continue;

          const linX = band.linearXForTime(t);
          const isEnd = side === 'end';
          const mainOpacity = isEnd ? 0.94 : 0.78;
          const tierOpacity = isEnd ? 0.9 : 0.72;
          const capDir = isEnd ? -1 : 1;

          svgEl(
            'path',
            {
              d: `M${linX + capDir * 4.5},${band.linearY - 2.5} L${linX},${band.linearY - 2.5} L${linX},${band.linearY + 1}`,
              fill: 'none',
              stroke: rangeColor,
              'stroke-width': 1.45,
              opacity: mainOpacity
            },
            layerG
          );
          renderTimePolyline(layerG, band, t, band.linearY - 2, band.tiersBottomY + 4, {
            stroke: rangeColor,
            strokeWidth: 1.35,
            opacity: mainOpacity,
            tierDashArray: '4 3',
            tierOpacity,
            dockOpacity: mainOpacity,
            hideTicks: layout.hideTicks
          });
        }
      };

      drawRangeProjection(start, 'start');
      drawRangeProjection(end, 'end');
    }
  }

  const drawSelectionNeck = (
    band: BandLayout,
    t: number,
    color = '#1D4ED8',
    yBottom?: number
  ) => {
    const linX = band.linearXForTime(t);
    const tickTopY = input.hasAudio && band.specH > 0 ? band.anchorY : band.linearY;
    if (input.hasAudio && band.specH > 0) {
      svgEl(
        'line',
        {
          x1: linX,
          y1: band.specY,
          x2: linX,
          y2: band.anchorY,
          stroke: color,
          'stroke-width': 1,
          'stroke-dasharray': '3 2.5',
          opacity: 0.5
        },
        layerG
      );
    }
    const targetY = yBottom ?? band.neckBotY;
    renderTimePolyline(layerG, band, t, tickTopY, targetY, {
      stroke: color,
      strokeWidth: 1.4,
      opacity: 0.85,
      tierOpacity: 0.55,
      tierDashArray: '2.5 2',
      dockOpacity: 0.85,
      hideTicks: layout.hideTicks
    });
  };

  const isPlayRangeEdge = (t: number) =>
    Boolean(
      input.playRange &&
        Number.isFinite(input.playRange.start) &&
        Number.isFinite(input.playRange.end) &&
        input.playRange.end > input.playRange.start &&
        (Math.abs(input.playRange.start - t) <= 1e-6 || Math.abs(input.playRange.end - t) <= 1e-6)
    );

  const isSameSpanAsPlayRange = (t0: number, t1: number) =>
    Boolean(
      input.playRange &&
        Number.isFinite(input.playRange.start) &&
        Number.isFinite(input.playRange.end) &&
        input.playRange.end > input.playRange.start &&
        Math.abs(input.playRange.start - t0) <= 1e-6 &&
        Math.abs(input.playRange.end - t1) <= 1e-6
    );

  const sel = input.selection;
  const multiSel = input.multiSelection && input.multiSelection.length >= 2 ? input.multiSelection : null;
  if (multiSel) {
    const primaryKey =
      sel?.kind === 'interval' ? `${sel.tierIndex}:${sel.itemIndex}` : '';
    const multiKeySet = new Set(multiSel.map((m) => `${m.tierIndex}:${m.itemIndex}`));
    for (const band of layout.bands) {
      for (const item of multiSel) {
        const key = `${item.tierIndex}:${item.itemIndex}`;
        if (key === primaryKey) continue; // Primary interval is drawn below with stronger accent
        const tl = band.tiersLayout[item.tierIndex];
        if (!tl) continue;
        for (const vi of tl.visibleIvs || []) {
          if (vi.iv.origIdx === item.itemIndex) {
            const ly = tl.y + (tl.laneOffsets?.[vi.iv.lane] || 0);
            const lh = tl.laneHeights?.[vi.iv.lane] || tl.h;
            const customBorderInset = getCustomBorderInset(item.tierIndex, item.itemIndex);
            if (customBorderInset !== null) {
              drawCustomBorderIntervalFocus(
                vi.x0,
                vi.w,
                ly,
                lh,
                vi.iv.lane ?? 0,
                tl.laneHeights?.length ?? 1,
                {
                  color: '#2563EB',
                  fillOpacity: 0.08,
                  strokeWidth: 1.4,
                  dashArray: '4 2',
                  borderInset: customBorderInset
                }
              );
            } else {
              svgEl(
                'rect',
                {
                  x: vi.x0 + 0.5,
                  y: ly + 0.5,
                  width: Math.max(1, vi.w - 1),
                  height: lh - 1,
                  fill: '#2563EB',
                  'fill-opacity': 0.11,
                  stroke: '#2563EB',
                  'stroke-width': 1.5,
                  'stroke-dasharray': '4 2'
                },
                layerG
              );
            }
            // Small corner accent dot distinguishing secondary multi-selected intervals
            if (vi.w >= 10) {
              svgEl(
                'rect',
                {
                  x: vi.x0 + 2,
                  y: ly + 2,
                  width: 4,
                  height: 4,
                  fill: '#2563EB',
                  opacity: 0.85
                },
                layerG
              );
            }
          }
        }
      }
      if (sel?.kind === 'interval' && multiKeySet.has(primaryKey)) {
        const tl = band.tiersLayout[sel.tierIndex];
        if (tl) {
          for (const vi of tl.visibleIvs || []) {
            if (vi.iv.origIdx === sel.itemIndex && vi.w >= 10) {
              const ly = tl.y + (tl.laneOffsets?.[vi.iv.lane] || 0);
              svgEl(
                'rect',
                {
                  x: vi.x0 + 2,
                  y: ly + 2,
                  width: 5,
                  height: 5,
                  fill: '#1D4ED8'
                },
                layerG
              );
            }
          }
        }
      }
    }
  }

  if (sel) {
    for (const band of layout.bands) {
      if (sel.kind === 'interval') {
        const tl = band.tiersLayout[sel.tierIndex];
        if (!tl) continue;
        for (const vi of tl.visibleIvs || []) {
          if (vi.iv.origIdx === sel.itemIndex) {
            if (!isSameSpanAsPlayRange(vi.iv.xmin, vi.iv.xmax)) {
              drawNeckFocusTrapezoid(band, vi.iv.xmin, vi.iv.xmax, '#1D4ED8', 0.13, tl.y);
            }
            if (!vi.clippedLeft && !isPlayRangeEdge(vi.iv.xmin)) {
              drawSelectionNeck(band, vi.iv.xmin, '#1D4ED8', tl.y);
            }
            if (!vi.clippedRight && !isPlayRangeEdge(vi.iv.xmax)) {
              drawSelectionNeck(band, vi.iv.xmax, '#1D4ED8', tl.y);
            }
            const ly = tl.y + (tl.laneOffsets?.[vi.iv.lane] || 0);
            const lh = tl.laneHeights?.[vi.iv.lane] || tl.h;
            const customBorderInset = getCustomBorderInset(sel.tierIndex, sel.itemIndex);
            if (customBorderInset !== null) {
              drawCustomBorderIntervalFocus(
                vi.x0,
                vi.w,
                ly,
                lh,
                vi.iv.lane ?? 0,
                tl.laneHeights?.length ?? 1,
                {
                  color: '#1D4ED8',
                  fillOpacity: 0.055,
                  strokeWidth: 1.5,
                  borderInset: customBorderInset
                }
              );
            } else {
              svgEl(
                'rect',
                {
                  x: vi.x0 + 0.5,
                  y: ly + 0.5,
                  width: Math.max(1, vi.w - 1),
                  height: lh - 1,
                  fill: '#1D4ED8',
                  'fill-opacity': 0.08,
                  stroke: '#1D4ED8',
                  'stroke-width': 1.8
                },
                layerG
              );
            }
          }
        }
        for (const vz of tl.visibleZeros || []) {
          if (vz.iv.origIdx === sel.itemIndex) {
            svgEl(
              'rect',
              { x: vz.x - 6, y: tl.y, width: 12, height: tl.h, fill: 'none', stroke: '#1D4ED8', 'stroke-width': 1.8 },
              layerG
            );
          }
        }
      } else if (sel.kind === 'point') {
        const tl = band.tiersLayout[sel.tierIndex];
        if (!tl || tl.wireY === undefined) continue;
        for (const vp of tl.visiblePts || []) {
          if (vp.pt.origIdx === sel.itemIndex) {
            drawSelectionNeck(band, vp.pt.number, '#1D4ED8', tl.y);
            svgEl(
              'polygon',
              {
                points: `${vp.x},${tl.wireY - 6.5} ${vp.x + 6.5},${tl.wireY} ${vp.x},${tl.wireY + 6.5} ${vp.x - 6.5},${tl.wireY}`,
                fill: 'none',
                stroke: '#1D4ED8',
                'stroke-width': 1.8
              },
              layerG
            );
            if (vp.rich && tl.levelY) {
              const boxY = tl.y + tl.levelY[vp.level];
              svgEl(
                'rect',
                {
                  x: vp.bx - 1,
                  y: boxY - 1,
                  width: vp.boxW + 2,
                  height: vp.boxH + 2,
                  fill: '#1D4ED8',
                  'fill-opacity': 0.08,
                  stroke: '#1D4ED8',
                  'stroke-width': 1.6
                },
                layerG
              );
            }
          }
        }
      } else if (sel.kind === 'boundary') {
        const tl = band.tiersLayout[sel.tierIndex];
        if (!tl || sel.time < band.startT || sel.time > band.endT) continue;
        const bx = xForTierTime(band, sel.tierIndex, sel.time);
        drawSelectionNeck(band, sel.time, '#1D4ED8', tl.y);
        svgEl('line', { x1: bx, y1: tl.y - 2, x2: bx, y2: tl.y + tl.h + 2, stroke: '#1D4ED8', 'stroke-width': 2.5 }, layerG);
      } else if (sel.kind === 'spine') {
        if (sel.time < band.startT || sel.time > band.endT) continue;
        drawSelectionNeck(band, sel.time, '#1D4ED8', band.tickSpineTopY);
        renderTimePolyline(layerG, band, sel.time, band.tickSpineBotY - 6, band.tiersBottomY, {
          stroke: '#1D4ED8',
          strokeWidth: 1.8,
          skipTickSpine: false,
          hideTicks: layout.hideTicks
        });
      } else if (sel.kind === 'tier') {
        const tl = band.tiersLayout[sel.tierIndex];
        if (!tl) continue;
        const hb = tl.headerBox;
        svgEl(
          'rect',
          { x: hb.x, y: hb.y, width: hb.w, height: hb.h, fill: '#1D4ED8', 'fill-opacity': 0.07, stroke: '#1D4ED8', 'stroke-width': 1.5 },
          layerG
        );
      }
    }
  }

  if (input.showPlayhead && Number.isFinite(input.currentTime)) {
    const t = input.currentTime;
    const isRangeEndEdge = Boolean(
      input.playRange &&
        input.playRange.end > input.playRange.start &&
        Math.abs(t - input.playRange.end) < 1e-9
    );
    const lastBandIdx = layout.bands.length - 1;
    for (let bi = 0; bi < layout.bands.length; bi++) {
      const band = layout.bands[bi];
      const inBand = isRangeEndEdge
        ? (bi === 0 ? t >= band.startT : t > band.startT) && t <= band.endT
        : t >= band.startT && (bi === lastBandIdx ? t <= band.endT : t < band.endT);
      if (!inBand && !(layout.bands.length === 1 && t === band.startT)) continue;
      const lx = band.linearXForTime(t);
      renderTimePolyline(layerG, band, t, band.linearY - 2, band.tiersBottomY + 2, {
        stroke: '#B91C1C',
        strokeWidth: 1.6,
        hideTicks: layout.hideTicks
      });
      svgEl(
        'polygon',
        { points: `${lx - 4},${band.linearY - 5} ${lx + 4},${band.linearY - 5} ${lx},${band.linearY}`, fill: '#B91C1C' },
        layerG
      );
    }
  }

  if (input.dragPreview) {
    const {
      bandIndex,
      x,
      linearX,
      origTime,
      origX,
      origLinearX,
      y0,
      y1,
      cursorY,
      snapX,
      snapTime,
      snapMode,
      snapLabel,
      showCompactTag,
      time
    } = input.dragPreview;
    const isSnapped = snapX !== null || snapTime != null || Boolean(snapMode);
    const colStroke = isSnapped ? '#B45309' : '#1D4ED8';
    const band = layout.bands[bandIndex];
    if (band && Number.isFinite(linearX)) {
      const acousticBotY = band.linearY + band.linearH;
      if (
        origLinearX !== undefined &&
        Number.isFinite(origLinearX) &&
        Math.abs(linearX - origLinearX) > 0.5
      ) {
        svgEl(
          'rect',
          {
            x: Math.min(origLinearX, linearX),
            y: band.linearY,
            width: Math.abs(linearX - origLinearX),
            height: Math.max(1, acousticBotY - band.linearY),
            fill: '#1D4ED8',
            'fill-opacity': 0.13
          },
          layerG
        );
        svgEl(
          'line',
          {
            x1: origLinearX,
            y1: band.linearY,
            x2: origLinearX,
            y2: acousticBotY,
            stroke: '#1D4ED8',
            'stroke-width': 1,
            'stroke-dasharray': '2 2',
            opacity: 0.45
          },
          layerG
        );
      }
      const gapY =
        band.specH > 0
          ? Number.isFinite(cursorY)
            ? Math.max(band.specY + 14, Math.min(band.specY + band.specH - 14, cursorY!))
            : band.specY + band.specH * 0.5
          : null;
      const gapHalf = 14;
      if (gapY !== null) {
        svgEl('line', { x1: linearX - 7, y1: gapY, x2: linearX - 3, y2: gapY, stroke: colStroke, 'stroke-width': 1.1 }, layerG);
        svgEl('line', { x1: linearX + 3, y1: gapY, x2: linearX + 7, y2: gapY, stroke: colStroke, 'stroke-width': 1.1 }, layerG);
      }
      const guideT = snapTime ?? time;
      if (isSnapped && (snapX !== null || snapTime != null)) {
        renderTimePolyline(layerG, band, guideT, band.specH > 0 ? band.waveY : band.linearY, band.tiersBottomY, {
          stroke: '#B45309',
          strokeWidth: 1.5,
          tierStrokeWidth: 1.8,
          neckStrokeWidth: 1.35,
          neckOpacity: 0.9,
          dockStrokeWidth: 1.35,
          dockOpacity: 0.85,
          hideTicks: layout.hideTicks,
          gapWindow: gapY !== null ? { y0: Math.max(band.specY, gapY - gapHalf), y1: Math.min(band.specY + band.specH, gapY + gapHalf) } : null
        });
      } else {
        renderTimePolyline(layerG, band, guideT, band.specH > 0 ? band.waveY : band.linearY, y0, {
          stroke: colStroke,
          strokeWidth: band.specH > 0 ? 1.4 : 1.2,
          opacity: band.specH > 0 ? 1 : 0.85,
          neckStrokeWidth: 1.1,
          neckOpacity: 0.8,
          tierStrokeWidth: 1.1,
          tierOpacity: 0.45,
          tierDashArray: '3 2',
          hideTicks: layout.hideTicks,
          gapWindow: gapY !== null ? { y0: Math.max(band.specY, gapY - gapHalf), y1: Math.min(band.specY + band.specH, gapY + gapHalf) } : null
        });
      }
    }

    // Translucent displacement band on the active tier(s) from original X to dragged X
    if (origX !== undefined && Number.isFinite(origX) && Math.abs(x - origX) > 0.5) {
      svgEl(
        'rect',
        {
          x: Math.min(origX, x),
          y: y0,
          width: Math.abs(x - origX),
          height: Math.max(1, y1 - y0),
          fill: '#1D4ED8',
          'fill-opacity': 0.11
        },
        layerG
      );
      svgEl(
        'line',
        {
          x1: origX,
          y1: y0,
          x2: origX,
          y2: y1,
          stroke: '#1D4ED8',
          'stroke-width': 1,
          'stroke-dasharray': '2 2',
          opacity: 0.45
        },
        layerG
      );
    }

    if (!(band && isSnapped && (snapX !== null || snapTime != null))) {
      svgEl(
        'line',
        { x1: x, y1: y0, x2: x, y2: y1, stroke: colStroke, 'stroke-width': 1.8, 'stroke-dasharray': isSnapped ? 'none' : '3 2' },
        layerG
      );
    }

    // Compact coordinate & snap pill when micro-loupe isn't visible (no audio loaded or loupe toggled off)
    if (showCompactTag !== false) {
      const timeStr = formatPraatDouble(time);
      let timePart = `${timeStr} s`;
      if (origTime !== undefined && Number.isFinite(origTime)) {
        const deltaMs = Math.round((time - origTime) * 1000);
        const deltaStr = deltaMs === 0 ? 'Δ 0 ms' : deltaMs > 0 ? `Δ +${deltaMs} ms` : `Δ ${deltaMs} ms`;
        timePart = `${timeStr} s (${deltaStr})`;
      }
      const txt = snapLabel ? `${timePart} · ${snapLabel}` : timePart;
      const tw = measurePx(txt, `10.5px ${MONO_FONT_STACK}`) + 12;
      const fx = Math.max(4, Math.min(layout.width - tw - 4, x - tw / 2));
      const fy = Math.max(4, (snapX !== null && band ? Math.min(y0, band.tiersTopY) : y0) - 22);
      svgEl('rect', { x: fx, y: fy, width: tw, height: 18, fill: isSnapped ? '#B45309' : '#141413' }, layerG);
      svgEl(
        'text',
        { x: fx + tw / 2, y: fy + 12.5, 'text-anchor': 'middle', 'font-family': MONO_FONT_STACK, 'font-size': '10', fill: '#FFFFFF' },
        layerG
      ).textContent = txt;
    }
  }

  if (input.intervalDragPreview) {
    const {
      bandIndex,
      mode: dragMode,
      tStart,
      tEnd,
      x0,
      x1,
      linX0,
      linX1,
      y0,
      y1,
      startSnap,
      endSnap,
      compressWarningSide,
      blockSlices,
      multiUnitPreviews,
      multiSyncLabel,
      blockCount,
      blockedSide,
      blockedLabel,
      resizeFixedSide,
      snapX,
      snapSide,
      snapLabel,
      text
    } = input.intervalDragPreview;
    const isMultiSyncMode =
      dragMode === 'multi-sync' && Boolean(multiUnitPreviews && multiUnitPreviews.length > 0);
    const isBlockMode =
      (dragMode === 'block-move' || dragMode === 'block-resize') &&
      Boolean(blockSlices && blockSlices.length > 0);
    const band = layout.bands[bandIndex];
    const sSnap: EdgeSnapVisual | null =
      startSnap ??
      (snapSide === 'start' && snapX != null
        ? { x: snapX, linX: linX0, label: snapLabel || '' }
        : null);
    const eSnap: EdgeSnapVisual | null =
      endSnap ??
      (snapSide === 'end' && snapX != null
        ? { x: snapX, linX: linX1, label: snapLabel || '' }
        : null);
    const legacyOnlySnapX = !sSnap && !eSnap && snapX != null ? snapX : null;
    const startColor = blockedSide === 'left' ? '#DC2626' : sSnap ? '#B45309' : '#1D4ED8';
    const endColor = blockedSide === 'right' ? '#DC2626' : eSnap ? '#B45309' : '#1D4ED8';
    const px0 = Math.min(x0, x1);
    const px1 = Math.max(x0, x1);
    const lx0 = Math.min(linX0, linX1);
    const lx1 = Math.max(linX0, linX1);
    const rectW = Math.max(1, px1 - px0);
    const rectH = Math.max(1, y1 - y0);

    if (band && Number.isFinite(lx0) && Number.isFinite(lx1)) {
      const acousticBotY = band.linearY + band.linearH;
      svgEl(
        'rect',
        {
          x: lx0,
          y: band.linearY,
          width: Math.max(1, lx1 - lx0),
          height: Math.max(1, acousticBotY - band.linearY),
          fill: '#1D4ED8',
          opacity: isBlockMode ? 0.16 : 0.14
        },
        layerG
      );
      if (isBlockMode && blockSlices) {
        const seenLinX = new Set<number>();
        for (const slice of blockSlices) {
          for (const ilx of slice.interiorLinXs ?? []) {
            const key = Math.round(ilx * 2);
            if (!Number.isFinite(ilx) || seenLinX.has(key)) continue;
            seenLinX.add(key);
            svgEl(
              'line',
              {
                x1: ilx,
                y1: band.linearY,
                x2: ilx,
                y2: acousticBotY,
                stroke: '#1D4ED8',
                'stroke-width': 1.1,
                'stroke-dasharray': '3 3',
                opacity: 0.55
              },
              layerG
            );
          }
        }
      }
      renderTimeSpanFocus(layerG, band, tStart, tEnd, {
        fill: '#1D4ED8',
        fillOpacity: 0.15,
        yFrom: band.linearY,
        yTo: band.tiersBottomY
      });
      renderTimePolyline(layerG, band, tStart, band.linearY, y0, {
        stroke: startColor,
        strokeWidth: blockedSide === 'left' ? 2.0 : 1.4,
        opacity: 0.92,
        neckStrokeWidth: 1.3,
        neckOpacity: 0.88,
        tierOpacity: 0.45,
        tierDashArray: '3 2',
        hideTicks: layout.hideTicks
      });
      renderTimePolyline(layerG, band, tEnd, band.linearY, y0, {
        stroke: endColor,
        strokeWidth: blockedSide === 'right' ? 2.0 : 1.4,
        opacity: 0.92,
        neckStrokeWidth: 1.3,
        neckOpacity: 0.88,
        tierOpacity: 0.45,
        tierDashArray: '3 2',
        hideTicks: layout.hideTicks
      });
    }

    let pillAnchorY0 = y0;

    if (dragMode === 'create') {
      svgEl(
        'rect',
        {
          x: px0,
          y: y0,
          width: rectW,
          height: rectH,
          fill: '#1D4ED8',
          'fill-opacity': 0.13,
          stroke: '#1D4ED8',
          'stroke-width': 1.8,
          'stroke-dasharray': '4 3'
        },
        layerG
      );
    } else if (isMultiSyncMode && multiUnitPreviews) {
      let minTopY = y0;
      for (const box of multiUnitPreviews) {
        if (box.y0 < minTopY) minTopY = box.y0;
        const bx0 = Math.min(box.x0, box.x1);
        const bx1 = Math.max(box.x0, box.x1);
        const bw = Math.max(1, bx1 - bx0);
        const bh = Math.max(1, box.y1 - box.y0);
        svgEl(
          'rect',
          {
            x: bx0,
            y: box.y0,
            width: bw,
            height: bh,
            fill: '#1D4ED8',
            'fill-opacity': 0.14,
            stroke: '#1D4ED8',
            'stroke-width': 1.65
          },
          layerG
        );
        for (const ix of box.interiorXs) {
          if (!Number.isFinite(ix) || ix <= bx0 + 0.5 || ix >= bx1 - 0.5) continue;
          svgEl(
            'line',
            {
              x1: ix,
              y1: box.y0 + 1,
              x2: ix,
              y2: box.y1 - 1,
              stroke: '#1D4ED8',
              'stroke-width': 1.4,
              'stroke-dasharray': '3 2',
              opacity: 0.92
            },
            layerG
          );
        }
        if (box.blockedSide === 'left' || box.blockedSide === 'right') {
          const stopX = box.blockedSide === 'left' ? bx0 : bx1;
          svgEl(
            'line',
            {
              x1: stopX,
              y1: box.y0 - 1,
              x2: stopX,
              y2: box.y1 + 1,
              stroke: '#DC2626',
              'stroke-width': 2.8
            },
            layerG
          );
        }
      }
      pillAnchorY0 = minTopY;
    } else if (isBlockMode && blockSlices) {
      let envY0 = y0;
      let envY1 = y1;
      for (const slice of blockSlices) {
        if (slice.y0 < envY0) envY0 = slice.y0;
        if (slice.y1 > envY1) envY1 = slice.y1;
      }
      pillAnchorY0 = envY0;

      // Vertical/sloped linking rails across all participating tiers (bends cleanly through transition necks)
      if (band) {
        renderTimePolyline(layerG, band, tStart, envY0, envY1, {
          stroke: blockedSide === 'left' ? '#DC2626' : '#1D4ED8',
          strokeWidth: blockedSide === 'left' ? 2.2 : 1.5,
          dashArray: blockedSide === 'left' ? undefined : '3 2',
          opacity: 0.72,
          hideTicks: layout.hideTicks
        });
        renderTimePolyline(layerG, band, tEnd, envY0, envY1, {
          stroke: blockedSide === 'right' ? '#DC2626' : '#1D4ED8',
          strokeWidth: blockedSide === 'right' ? 2.2 : 1.5,
          dashArray: blockedSide === 'right' ? undefined : '3 2',
          opacity: 0.72,
          hideTicks: layout.hideTicks
        });
      }

      for (const slice of blockSlices) {
        const sH = Math.max(1, slice.y1 - slice.y0);
        const sx0 =
          slice.x0 !== undefined && slice.x1 !== undefined
            ? Math.min(slice.x0, slice.x1)
            : band
              ? Math.min(
                  xForTierTime(band, slice.tierIndex, tStart),
                  xForTierTime(band, slice.tierIndex, tEnd)
                )
              : px0;
        const sx1 =
          slice.x0 !== undefined && slice.x1 !== undefined
            ? Math.max(slice.x0, slice.x1)
            : band
              ? Math.max(
                  xForTierTime(band, slice.tierIndex, tStart),
                  xForTierTime(band, slice.tierIndex, tEnd)
                )
              : px1;
        const sW = Math.max(1, sx1 - sx0);
        svgEl(
          'rect',
          {
            x: sx0,
            y: slice.y0,
            width: sW,
            height: sH,
            fill: '#1D4ED8',
            'fill-opacity': 0.13,
            stroke: '#1D4ED8',
            'stroke-width': 1.6
          },
          layerG
        );

        // Remapped interior sub-boundary ghost lines inside fine tiers
        for (const ix of slice.interiorXs) {
          if (!Number.isFinite(ix) || ix <= sx0 + 0.5 || ix >= sx1 - 0.5) continue;
          svgEl(
            'line',
            {
              x1: ix,
              y1: slice.y0 + 1,
              x2: ix,
              y2: slice.y1 - 1,
              stroke: '#1D4ED8',
              'stroke-width': 1.45,
              'stroke-dasharray': '3 2',
              opacity: 0.92
            },
            layerG
          );
        }

        // Remapped point markers for participating TextTiers
        if (slice.pointXs && slice.pointXs.length > 0) {
          const midY = (slice.y0 + slice.y1) * 0.5;
          for (const ptx of slice.pointXs) {
            if (!Number.isFinite(ptx)) continue;
            svgEl(
              'line',
              {
                x1: ptx,
                y1: slice.y0 + 2,
                x2: ptx,
                y2: slice.y1 - 2,
                stroke: '#1D4ED8',
                'stroke-width': 1.1,
                'stroke-dasharray': '2 2',
                opacity: 0.75
              },
              layerG
            );
            svgEl(
              'circle',
              {
                cx: ptx,
                cy: midY,
                r: 3.2,
                fill: '#FFFFFF',
                stroke: '#1D4ED8',
                'stroke-width': 1.5
              },
              layerG
            );
          }
        }

        // Hard-stop red highlight on blocking tier edge
        if (slice.blockedSide === 'left' || slice.blockedSide === 'right') {
          const bx = slice.blockedSide === 'left' ? sx0 : sx1;
          svgEl(
            'line',
            {
              x1: bx,
              y1: slice.y0 - 1,
              x2: bx,
              y2: slice.y1 + 1,
              stroke: '#DC2626',
              'stroke-width': 2.8
            },
            layerG
          );
        }
      }

      if (dragMode === 'block-resize' && (resizeFixedSide === 'left' || resizeFixedSide === 'right')) {
        const anchorT = resizeFixedSide === 'left' ? tStart : tEnd;
        if (band) {
          renderTimePolyline(layerG, band, anchorT, envY0 - 2, envY1 + 2, {
            stroke: '#0F172A',
            strokeWidth: 2.2,
            opacity: 0.8,
            hideTicks: layout.hideTicks
          });
        }
      }

      if (text && rectW >= 20) {
        const flat = text.replace(/[\r\n\t]+/g, ' ').trim();
        if (flat) {
          const font = `12px ${IPA_FONT_STACK}`;
          const maxTxtW = rectW - 8;
          let displayTxt = flat;
          if (measurePx(displayTxt, font) > maxTxtW) {
            const graphemes = splitGraphemes(displayTxt);
            while (graphemes.length > 1 && measurePx(graphemes.join('') + '…', font) > maxTxtW) {
              graphemes.pop();
            }
            displayTxt = graphemes.length > 0 ? graphemes.join('') + '…' : '';
          }
          if (displayTxt && measurePx(displayTxt, font) <= maxTxtW + 4) {
            svgEl(
              'text',
              {
                x: px0 + rectW / 2,
                y: y0 + rectH / 2 + 4,
                'text-anchor': 'middle',
                'font-family': IPA_FONT_STACK,
                'font-size': '12',
                fill: '#1E3A8A',
                opacity: 0.88
              },
              layerG
            ).textContent = displayTxt;
          }
        }
      }
    } else {
      svgEl(
        'rect',
        {
          x: px0,
          y: y0,
          width: rectW,
          height: rectH,
          fill: '#1D4ED8',
          'fill-opacity': 0.16,
          stroke: '#1D4ED8',
          'stroke-width': 1.8
        },
        layerG
      );
      if (text && rectW >= 20) {
        const flat = text.replace(/[\r\n\t]+/g, ' ').trim();
        if (flat) {
          const font = `12px ${IPA_FONT_STACK}`;
          const maxTxtW = rectW - 8;
          let displayTxt = flat;
          if (measurePx(displayTxt, font) > maxTxtW) {
            const graphemes = splitGraphemes(displayTxt);
            while (graphemes.length > 1 && measurePx(graphemes.join('') + '…', font) > maxTxtW) {
              graphemes.pop();
            }
            displayTxt = graphemes.length > 0 ? graphemes.join('') + '…' : '';
          }
          if (displayTxt && measurePx(displayTxt, font) <= maxTxtW + 4) {
            svgEl(
              'text',
              {
                x: px0 + rectW / 2,
                y: y0 + rectH / 2 + 4,
                'text-anchor': 'middle',
                'font-family': IPA_FONT_STACK,
                'font-size': '12',
                fill: '#1E3A8A',
                opacity: 0.84
              },
              layerG
            ).textContent = displayTxt;
          }
        }
      }
    }

    if (compressWarningSide === 'left' || compressWarningSide === 'right') {
      const warnX = compressWarningSide === 'left' ? px0 : px1;
      svgEl(
        'line',
        {
          x1: warnX,
          y1: y0 - 1,
          x2: warnX,
          y2: y1 + 1,
          stroke: '#B45309',
          'stroke-width': 2.2
        },
        layerG
      );
    }

    const drawMagneticGuide = (guideT: number) => {
      if (!band) return;
      renderTimePolyline(layerG, band, guideT, band.linearY, band.tiersBottomY, {
        stroke: '#B45309',
        strokeWidth: 1.6,
        neckStrokeWidth: 1.35,
        dockStrokeWidth: 1.25,
        dockOpacity: 0.85,
        hideTicks: layout.hideTicks
      });
    };

    if (sSnap) drawMagneticGuide(sSnap.t ?? tStart);
    if (eSnap && (!sSnap || Math.abs(eSnap.x - sSnap.x) > 0.5)) drawMagneticGuide(eSnap.t ?? tEnd);
    if (legacyOnlySnapX !== null) drawMagneticGuide(snapSide === 'end' ? tEnd : tStart);

    const durMs = Math.max(0, Math.round((tEnd - tStart) * 1000));
    const modePrefix = isMultiSyncMode
      ? `${multiSyncLabel || `复选同步 (${blockCount ?? multiUnitPreviews?.length ?? 2}项)`} · `
      : isBlockMode
        ? `${dragMode === 'block-move' ? '跨层平移' : '跨层缩放'} ${blockCount ?? blockSlices?.length ?? 1}层 · `
        : '';
    const baseTxt = `${modePrefix}${formatPraatDouble(tStart)} – ${formatPraatDouble(tEnd)} s (${durMs} ms)`;
    const anySnap = Boolean(sSnap || eSnap || legacyOnlySnapX !== null);
    let snapSuffix = '';
    if (blockedLabel) {
      snapSuffix = blockedLabel;
    } else if (sSnap && eSnap) {
      snapSuffix = '双端对齐';
    } else if (sSnap && sSnap.label) {
      snapSuffix = sSnap.label;
    } else if (eSnap && eSnap.label) {
      snapSuffix = eSnap.label;
    } else if (snapLabel) {
      snapSuffix = snapLabel;
    }
    const txt = snapSuffix ? `${baseTxt} · ${snapSuffix}` : baseTxt;
    const tw = measurePx(txt, `10.5px ${MONO_FONT_STACK}`) + 12;
    const fx = Math.max(4, Math.min(layout.width - tw - 4, (px0 + px1) / 2 - tw / 2));
    const fy = Math.max(4, (anySnap && band ? Math.min(pillAnchorY0, band.tiersTopY) : pillAnchorY0) - 22);
    const isBlocked = Boolean(blockedLabel || blockedSide);
    const isSnapped = !isBlocked && (anySnap || Boolean(snapLabel));
    const pillBg = isBlocked ? '#B91C1C' : isSnapped ? '#B45309' : '#141413';
    svgEl('rect', { x: fx, y: fy, width: tw, height: 18, fill: pillBg }, layerG);
    svgEl(
      'text',
      {
        x: fx + tw / 2,
        y: fy + 12.5,
        'text-anchor': 'middle',
        'font-family': MONO_FONT_STACK,
        'font-size': '10',
        fill: '#FFFFFF'
      },
      layerG
    ).textContent = txt;
  }
}

export function renderScoreSvg(svg: SVGSVGElement, input: RenderScoreInput): void {
  const { tg, layout, hasAudio, audioBuffer, audioOffset, analysis, maxFreq, mode, exportCtx } = input;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const isExp = Boolean(exportCtx);
  const sem = Boolean(exportCtx?.semanticGroups);
  const pal = exportCtx?.palette || WARM_PALETTE;
  const pfx = isExp ? exportCtx?.idPrefix || '' : '';
  const patPrefix = `${pfx}tg-pat`;
  const transparentBg = Boolean(exportCtx?.transparentBg);
  const hideMeta = Boolean(exportCtx?.hideMetaSymbols);
  const hideStretch = Boolean(exportCtx?.hideStretchCues);
  const fScale = exportCtx?.fontScale || 1;
  const sScale = exportCtx?.strokeScale || 1;
  const fontFamily = exportCtx?.fontFamily || IPA_FONT_STACK;
  const sansFont = exportCtx?.sansFontFamily || SANS_FONT_STACK;
  const monoFont = exportCtx?.monoFontFamily || MONO_FONT_STACK;
  const symbolFont = exportCtx?.symbolFontFamily || SYMBOL_FONT_STACK;

  const rawStyleDoc = input.styleDoc ?? null;
  const effectiveStyleDoc: StyleDocument | null = rawStyleDoc
    ? exportCtx?.bwPrintMode !== undefined && exportCtx.bwPrintMode !== rawStyleDoc.bwPrintMode
      ? { ...rawStyleDoc, bwPrintMode: exportCtx.bwPrintMode }
      : rawStyleDoc
    : null;
  const hasStyle = Boolean(effectiveStyleDoc && hasAnyCustomStyle(effectiveStyleDoc));

  const shouldShowStyleLegend = isExp
    ? (exportCtx?.showStyleLegend ?? effectiveStyleDoc?.showLegendInExport ?? false)
    : Boolean(input.showStyleLegendPreview);
  const styleLegendItems: StyleLegendItem[] =
    shouldShowStyleLegend && effectiveStyleDoc
      ? buildStyleLegendItems(effectiveStyleDoc, tg)
      : [];
  const styleLegendLayout =
    styleLegendItems.length > 0
      ? computeStyleLegendLayout(styleLegendItems, layout, fScale)
      : null;

  const finalHeight = styleLegendLayout
    ? Math.ceil(layout.height + styleLegendLayout.extraHeight)
    : layout.height;

  svg.setAttribute('width', String(layout.width));
  svg.setAttribute('height', String(finalHeight));
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${finalHeight}`);

  // W3C <metadata> project embedding (inserted before <defs>)
  if (isExp && exportCtx?.embedProjectMetadata) {
    const metadataXml = buildSvgProjectMetadataXml(
      tg,
      effectiveStyleDoc ?? createDefaultStyleDocument(),
      { filename: exportCtx.metadataFilename }
    );
    try {
      const parsedMeta = new DOMParser().parseFromString(
        `<svg xmlns="${SVG_NS}">${metadataXml}</svg>`,
        'image/svg+xml'
      );
      const metaNode = parsedMeta.documentElement.firstElementChild;
      if (metaNode && metaNode.localName === 'metadata' && !parsedMeta.querySelector('parsererror')) {
        svg.appendChild(svg.ownerDocument.importNode(metaNode, true));
      }
    } catch {
      // Ignore XML parsing errors in non-DOM environments
    }
  }

  const richStyle = isExp
    ? {
        isExport: true,
        fontFamily,
        monoFontFamily: monoFont,
        symbolFontFamily: symbolFont,
        palette: pal,
        fontScale: fScale
      }
    : null;
  const sw = (v: number) => Number((v * sScale).toFixed(2));
  const fs = (v: number) => String(Number((v * fScale).toFixed(2)));
  const safeId = (s: string) =>
    exportCtx?.sanitizeId ? exportCtx.sanitizeId(s) : String(s).replace(/[^A-Za-z0-9_\u4e00-\u9fff-]+/g, '-');

  const embeddedSpecDefs: Array<{ id: string; href: string; width: number; height: number }> = [];

  const defs = svgEl('defs', {}, svg);
  const pGap = svgEl('pattern', { id: `${pfx}pat-gap`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  svgEl('rect', { width: 6, height: 6, fill: pal.gapBg }, pGap);
  svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: pal.gapStroke, 'stroke-width': 1.1, opacity: pal.isBw ? 0.52 : 0.45 }, pGap);

  const pOod = svgEl('pattern', { id: `${pfx}pat-ood`, width: 6, height: 6, patternUnits: 'userSpaceOnUse' }, defs);
  svgEl('rect', { width: 6, height: 6, fill: pal.oodBg }, pOod);
  svgEl('path', {
    d: pal.isBw
      ? 'M0,6 L6,0 M-1,1 L1,-1 M5,7 L7,5 M0,0 L6,6 M-1,5 L1,7 M5,-1 L7,1'
      : 'M0,6 L6,0 M-1,1 L1,-1 M5,7 L7,5',
    stroke: pal.oodStroke,
    'stroke-width': 0.85
  }, pOod);

  const pOvl = svgEl('pattern', { id: `${pfx}pat-ovl`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-45)' }, defs);
  svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: pal.ovlStroke, 'stroke-width': 1.2, opacity: pal.isBw ? 0.42 : 0.28 }, pOvl);

  // Inject used vector style <pattern> definitions into <defs>
  if (effectiveStyleDoc && (hasStyle || styleLegendItems.length > 0)) {
    const patternSpecs: SvgPatternSpec[] = collectUsedPatternSpecs(effectiveStyleDoc, tg, patPrefix);
    const seenPatIds = new Set(patternSpecs.map((s) => s.id));
    for (const item of styleLegendItems) {
      if (item.pattern === 'none') continue;
      const pid = makeSvgPatternId(
        item.pattern,
        item.fill,
        item.patternColor,
        item.fillOpacity,
        patPrefix
      );
      if (!seenPatIds.has(pid)) {
        seenPatIds.add(pid);
        patternSpecs.push({
          id: pid,
          kind: item.pattern,
          bgColor: item.fill,
          fgColor: item.patternColor,
          opacity: item.fillOpacity
        });
      }
    }
    const patMarkup = buildSvgPatternDefs(patternSpecs, patPrefix);
    if (patMarkup) {
      try {
        const parsedPat = new DOMParser().parseFromString(
          `<svg xmlns="${SVG_NS}"><defs>${patMarkup}</defs></svg>`,
          'image/svg+xml'
        );
        const parsedDefs = parsedPat.documentElement.firstElementChild;
        if (parsedDefs && !parsedPat.querySelector('parsererror')) {
          for (const child of Array.from(parsedDefs.children)) {
            defs.appendChild(svg.ownerDocument.importNode(child, true));
          }
        }
      } catch {
        // Ignore XML parsing errors in non-DOM environments
      }
    }
  }

  if (isExp && layout.legendLayout?.needsSpecGrad) {
    const lg = svgEl('linearGradient', { id: `${pfx}legend-spec-grad`, x1: '0%', y1: '0%', x2: '100%', y2: '0%' }, defs);
    svgEl('stop', { offset: '0%', 'stop-color': pal.isBw ? '#F5F5F5' : '#F4F2EC' }, lg);
    svgEl('stop', { offset: '55%', 'stop-color': pal.isBw ? '#8C8C8C' : '#8A877F' }, lg);
    svgEl('stop', { offset: '100%', 'stop-color': pal.isBw ? '#000000' : '#181715' }, lg);
  }

  if (!transparentBg) {
    const bgAttrs: Record<string, string | number> = { x: 0, y: 0, width: layout.width, height: finalHeight, fill: pal.paper };
    if (isExp && sem) bgAttrs.id = 'export-backdrop';
    svgEl('rect', bgAttrs, svg);
  }

  if (isExp && exportCtx?.showCaption && layout.captionHeight > 0) {
    const capG = svgEl('g', sem ? { id: 'export-caption' } : {}, svg);
    const capY = layout.padTop + 12;
    const leftX = layout.padX;
    const rightX = layout.width - layout.padX;
    svgEl('text', { x: leftX, y: capY, 'text-anchor': 'start', 'font-family': sansFont, 'font-size': fs(12), 'font-weight': '600', fill: pal.ink }, capG).textContent = exportCtx.captionTitle;
    svgEl('text', { x: rightX, y: capY, 'text-anchor': 'end', 'font-family': monoFont, 'font-size': fs(10), fill: pal.muted }, capG).textContent = exportCtx.captionTimeText;
    svgEl('line', { x1: leftX, y1: capY + 6, x2: rightX, y2: capY + 6, stroke: pal.rule, 'stroke-width': sw(0.75) }, capG);
  }

  const graphicRoot = svgEl('g', isExp ? (sem ? { id: 'score-content' } : {}) : { id: 'pure-graphic' }, svg);

  for (const band of layout.bands) {
    const bNum = band.bandIndex + 1;
    const bG = svgEl('g', isExp ? (sem ? { id: `band-${bNum}` } : {}) : { 'data-band': band.bandIndex }, graphicRoot);
    const lxs = band.spineCols.map((c) => band.linearXForTime(c.t));
    const avgLinGap =
      band.spineCols.length > 1 ? band.bandContentW / (band.spineCols.length - 1) : band.bandContentW;
    const minLinGapAt = (i: number) =>
      Math.min(
        i > 0 ? lxs[i] - lxs[i - 1] : Infinity,
        i + 1 < lxs.length ? lxs[i + 1] - lxs[i] : Infinity
      );

    // A. Linear Physical Time Track
    if (hasAudio && band.specH > 0) {
      const specOpacity = isExp ? (exportCtx!.specOpacity ?? 1) : 1;
      const pitchOpacity = isExp ? (exportCtx!.pitchOpacity ?? 0.65) : 1;
      const formantOpacity = isExp ? (exportCtx!.formantOpacity ?? 0) : 1;
      const isCurvesOnly = isExp && exportCtx!.specStrategy === 'curves-only';

      const wavG = svgEl('g', isExp ? (sem ? { id: `band-${bNum}-waveform` } : {}) : { 'data-role': 'linear-bar', 'data-band': band.bandIndex }, bG);
      svgEl('rect', { x: band.originX, y: band.waveY, width: band.bandContentW, height: band.waveH, fill: transparentBg ? 'none' : pal.waveBg, stroke: pal.rule, 'stroke-width': sw(1) }, wavG);
      const wfD = buildWaveformPolygonPath(audioBuffer, audioOffset, band.linearSegs, band.waveY, band.waveH);
      if (wfD) svgEl('path', { d: wfD, fill: pal.waveFill, opacity: pal.isBw ? 0.92 : 0.82 }, wavG);
      svgEl('line', { x1: band.originX, y1: band.waveY + band.waveH / 2, x2: band.originX + band.bandContentW, y2: band.waveY + band.waveH / 2, stroke: pal.waveMid, 'stroke-width': sw(0.6) }, wavG);

      const clipId = `${pfx}spec-clip-${band.bandIndex}`;
      const cp = svgEl('clipPath', { id: clipId }, defs);
      svgEl('rect', { x: band.originX, y: band.specY, width: band.bandContentW, height: band.specH }, cp);

      const specG = svgEl('g', isExp ? (sem ? { id: `band-${bNum}-spectrogram` } : {}) : { 'data-role': 'spec-area', 'data-band': band.bandIndex }, bG);
      if (!transparentBg || (!isCurvesOnly && !(isExp && exportCtx!.specStrategy === 'contour'))) {
        svgEl('rect', { x: band.originX, y: band.specY, width: band.bandContentW, height: band.specH, fill: transparentBg ? 'none' : pal.paper }, specG);
      }

      const specContent = svgEl('g', { 'clip-path': `url(#${clipId})` }, specG);
      if (analysis) {
        if (isExp) {
          const res = exportCtx!.bandSpecResults.get(band.bandIndex);
          if (!isCurvesOnly && specOpacity > 0.001 && res) {
            if (res.kind === 'contour' && res.paths.length > 0) {
              const cG = svgEl('g', specOpacity < 0.999 ? { opacity: String(specOpacity) } : {}, specContent);
              for (const layer of res.paths) {
                if (!layer.d) continue;
                svgEl('path', { d: layer.d, fill: layer.fill, 'fill-rule': 'evenodd', stroke: 'none' }, cG);
              }
            } else if (res.kind === 'embed-defs' && res.dataUrl) {
              embeddedSpecDefs.push({ id: res.defId, href: res.dataUrl, width: band.bandContentW, height: band.specH });
              const useAttrs: Record<string, string | number> = { href: `#${res.defId}`, x: band.originX, y: band.specY };
              if (specOpacity < 0.999) useAttrs.opacity = String(specOpacity);
              svgEl('use', useAttrs, specContent);
            } else if (res.kind === 'external-zip' && res.relHref) {
              const imgAttrs: Record<string, string | number> = {
                href: res.relHref, x: band.originX, y: band.specY, width: band.bandContentW, height: band.specH, preserveAspectRatio: 'none'
              };
              if (specOpacity < 0.999) imgAttrs.opacity = String(specOpacity);
              svgEl('image', imgAttrs, specContent);
            } else if (res.kind === 'raster-png' && res.dataUrl) {
              const imgAttrs: Record<string, string | number> = {
                href: res.dataUrl, x: band.originX, y: band.specY, width: band.bandContentW, height: band.specH, preserveAspectRatio: 'none'
              };
              if (specOpacity < 0.999) imgAttrs.opacity = String(specOpacity);
              svgEl('image', imgAttrs, specContent);
            }
          }
        } else {
          const dataUrl = input.screenSpecUrls?.get(band.bandIndex);
          if (dataUrl) {
            svgEl('image', {
              class: 'spec-img',
              href: dataUrl,
              x: band.originX,
              y: band.specY,
              width: band.bandContentW,
              height: band.specH,
              preserveAspectRatio: 'none',
              'data-legend-keys': 'spectrogram'
            }, specContent);
          }
        }

        // 1 kHz edge notches
        for (let f = 1000; f < maxFreq; f += 1000) {
          const fy = band.specY + band.specH * (1 - f / maxFreq);
          svgEl('line', { x1: band.originX, y1: fy, x2: band.originX + 4, y2: fy, stroke: pal.faint, 'stroke-width': sw(0.8) }, specContent);
          svgEl('line', { x1: band.originX + band.bandContentW - 4, y1: fy, x2: band.originX + band.bandContentW, y2: fy, stroke: pal.faint, 'stroke-width': sw(0.8) }, specContent);
        }

        // LPC Formants
        if (!isExp || formantOpacity > 0.001) {
          const formG = svgEl(
            'g',
            isExp
              ? { ...(sem ? { id: `band-${bNum}-formants` } : {}), ...(formantOpacity < 0.999 ? { opacity: String(formantOpacity) } : {}) }
              : { class: 'formant-layer', 'data-legend-keys': 'formants' },
            specContent
          );
          const dotR = (pal.isBw ? 1.45 : 1.35) * sScale;
          for (const frame of analysis.formantTrack) {
            if (frame.t < band.startT || frame.t > band.endT) continue;
            const seg = band.linearSegs.find((s) => frame.t >= s.t0 && frame.t <= s.t1);
            if (!seg || seg.collapsed) continue;
            const fx = band.linearXForTime(frame.t);
            for (const freq of frame.freqs) {
              if (freq > maxFreq) continue;
              const fy = band.specY + band.specH * (1 - freq / maxFreq);
              if (pal.isBw) {
                svgEl(
                  'circle',
                  {
                    cx: fx,
                    cy: fy,
                    r: dotR,
                    fill: pal.paper,
                    stroke: pal.formant,
                    'stroke-width': sw(0.85)
                  },
                  formG
                );
              } else {
                svgEl(
                  'circle',
                  {
                    cx: fx,
                    cy: fy,
                    r: dotR,
                    fill: pal.formant,
                    stroke: pal.paper,
                    'stroke-width': sw(0.65),
                    'paint-order': 'stroke'
                  },
                  formG
                );
              }
            }
          }
        }

        // F0 Pitch contour
        if (!isExp || pitchOpacity > 0.001) {
          // Keep pitchHalo at 100% solid paper opacity so dark spectrogram energy never bleeds
          // through the halo; only soften the foreground F0 stroke itself (P1-1).
          const pitchG = svgEl(
            'g',
            isExp
              ? sem
                ? { id: `band-${bNum}-pitch-f0` }
                : {}
              : { class: 'pitch-layer', 'data-legend-keys': 'pitch-f0' },
            specContent
          );
          let pathD = '';
          let penDown = false;
          const f0Floor = input.f0RangeOverride ? input.f0RangeOverride.floor : (analysis.f0Floor ?? 65);
          const f0Ceil = input.f0RangeOverride
            ? Math.max(f0Floor + 25, input.f0RangeOverride.ceil)
            : Math.max(f0Floor + 50, analysis.f0Ceil || 500);
          for (const p of analysis.pitchTrack) {
            if (p.t < band.startT || p.t > band.endT || p.f0 === null || !Number.isFinite(p.f0)) {
              penDown = false;
              continue;
            }
            const seg = band.linearSegs.find((s) => p.t >= s.t0 && p.t <= s.t1);
            if (!seg || seg.collapsed) {
              penDown = false;
              continue;
            }
            const px = band.linearXForTime(p.t);
            const py =
              band.specY +
              band.specH -
              8 -
              ((Math.max(f0Floor, Math.min(f0Ceil, p.f0)) - f0Floor) / (f0Ceil - f0Floor)) *
                (band.specH - 16);
            pathD += penDown ? ` L${px.toFixed(1)},${py.toFixed(1)}` : ` M${px.toFixed(1)},${py.toFixed(1)}`;
            penDown = true;
          }
          if (pathD) {
            svgEl(
              'path',
              {
                ...(isExp ? {} : { class: 'pitch-halo' }),
                d: pathD,
                fill: 'none',
                stroke: pal.pitchHalo,
                'stroke-width': sw(3.2),
                'stroke-linejoin': 'miter'
              },
              pitchG
            );
            svgEl(
              'path',
              {
                ...(isExp ? {} : { class: 'pitch-stroke' }),
                d: pathD,
                fill: 'none',
                stroke: pal.pitch,
                'stroke-width': sw(1.5),
                'stroke-linejoin': 'miter',
                ...(isExp && pitchOpacity < 0.999 ? { 'stroke-opacity': String(pitchOpacity) } : {})
              },
              pitchG
            );
          }
        }
      }

      for (let i = 0; i < band.spineCols.length; i++) {
        const col = band.spineCols[i];
        const lx = lxs[i];
        const isMajor = col.usage >= 2 || col.t === tg.xmin || col.t === tg.xmax;
        const notchAttrs: Record<string, string | number> = {
          stroke: isMajor ? pal.ink : pal.tickMinor,
          'stroke-width': sw(isMajor ? 1.1 : 0.8)
        };
        if (!isMajor && minLinGapAt(i) < 8) notchAttrs.opacity = 0.42;
        svgEl('line', { x1: lx, y1: band.specY, x2: lx, y2: band.specY + (isMajor ? 6 : 4), ...notchAttrs }, specG);
        svgEl('line', { x1: lx, y1: band.specY + band.specH - (isMajor ? 6 : 4), x2: lx, y2: band.specY + band.specH, ...notchAttrs }, specG);
      }

      for (const tl of band.tiersLayout) {
        if (!tl || tl.meta.kind !== 'textTier') continue;
        for (const vp of tl.visiblePts || []) {
          const lx = band.linearXForTime(vp.pt.number);
          const ptStyle = hasStyle ? resolvePointStyle(effectiveStyleDoc!, tg, tl.tierIndex, vp.pt.origIdx) : null;
          if (ptStyle?.hasCustom) {
            const topR = Math.min(4, Math.max(2.4, ptStyle.size * 0.72));
            renderPointMarkerSVG(specG, lx, band.specY, ptStyle.shape, topR, {
              fill: ptStyle.shape === 'cross' ? 'none' : vp.rich ? ptStyle.color : pal.paper,
              stroke: ptStyle.color,
              strokeWidth: sw(ptStyle.shape === 'cross' ? 1.5 : 1),
              legendKey: isExp ? undefined : vp.rich ? 'labeled-point' : 'empty-point'
            });
          } else {
            svgEl('polygon', {
              points: `${lx},${band.specY - 3} ${lx + 3},${band.specY} ${lx},${band.specY + 3} ${lx - 3},${band.specY}`,
              fill: vp.rich ? pal.pitch : pal.paper,
              stroke: pal.pitch,
              'stroke-width': sw(1),
              ...(isExp ? {} : { 'data-legend-keys': vp.rich ? 'labeled-point' : 'empty-point' })
            }, specG);
          }
        }
      }

      svgEl('rect', { x: band.originX, y: band.specY, width: band.bandContentW, height: band.specH, fill: 'none', stroke: pal.ink, 'stroke-width': sw(1) }, specG);

      // Frequency Axis Labels
      const compactAxis = band.gutterW < 64;
      const axisG = svgEl('g', isExp && sem ? { id: `band-${bNum}-axis` } : {}, bG);
      svgEl('line', { x1: band.originX - 3, y1: band.specY + 0.5, x2: band.originX, y2: band.specY + 0.5, stroke: pal.muted, 'stroke-width': sw(0.9) }, axisG);
      svgEl('line', { x1: band.originX - 3, y1: band.specY + band.specH - 0.5, x2: band.originX, y2: band.specY + band.specH - 0.5, stroke: pal.muted, 'stroke-width': sw(0.9) }, axisG);
      svgEl('text', { x: band.originX - 5.5, y: band.specY + 7, 'text-anchor': 'end', 'font-family': monoFont, 'font-size': fs(8.5), fill: pal.muted }, axisG).textContent = compactAxis ? `${maxFreq / 1000}k` : `${maxFreq / 1000} kHz`;
      svgEl('text', { x: band.originX - 5.5, y: band.specY + band.specH - 1, 'text-anchor': 'end', 'font-family': monoFont, 'font-size': fs(8.5), fill: pal.muted }, axisG).textContent = compactAxis ? '0' : '0 Hz';

      // F0 Range Readout
      if (analysis && band.bandContentW >= 90 && (!isExp || pitchOpacity > 0.001)) {
        const f0Floor = input.f0RangeOverride ? input.f0RangeOverride.floor : (analysis.f0Floor ?? 65);
        const f0Ceil = input.f0RangeOverride
          ? Math.max(f0Floor + 25, input.f0RangeOverride.ceil)
          : Math.max(f0Floor + 50, analysis.f0Ceil || 500);
        const f0Lbl = `F0 ${Math.round(f0Floor)}–${Math.round(f0Ceil)} Hz`;
        const f0LblW = Math.ceil(measurePx(f0Lbl, `${(8.5 * fScale).toFixed(1)}px ${monoFont}`)) + 8;
        const f0BoxX = band.originX + band.bandContentW - f0LblW - 4;
        const f0BoxY = band.specY + 4;
        const f0AxisG = svgEl(
          'g',
          isExp
            ? pitchOpacity < 0.999
              ? { opacity: String(Math.max(0.55, pitchOpacity)) }
              : {}
            : { class: 'pitch-layer pitch-badge', 'data-legend-keys': 'pitch-f0' },
          specG
        );
        svgEl('rect', { x: f0BoxX, y: f0BoxY, width: f0LblW, height: Math.round(13 * fScale), fill: pal.paper, 'fill-opacity': '0.88', stroke: pal.pitch, 'stroke-opacity': '0.28', 'stroke-width': '0.6' }, f0AxisG);
        svgEl('text', { x: f0BoxX + f0LblW - 4, y: f0BoxY + Math.round(9.5 * fScale), 'text-anchor': 'end', 'font-family': monoFont, 'font-size': fs(8.5), fill: pal.pitch }, f0AxisG).textContent = f0Lbl;
      }

      // 1:1 Anchor Strip
      const ancG = svgEl('g', isExp ? (sem ? { id: `band-${bNum}-anchor` } : {}) : { 'data-role': 'linear-bar', 'data-band': band.bandIndex }, bG);
      svgEl('rect', { x: band.originX, y: band.anchorY, width: band.bandContentW, height: band.anchorH, fill: transparentBg ? 'none' : pal.anchorBg, stroke: pal.anchorStroke, 'stroke-width': sw(0.9) }, ancG);
      if (band.finestIntervalTierIdx >= 0) {
        const fineTl = band.tiersLayout[band.finestIntervalTierIdx];
        if (fineTl) {
          for (const vi of fineTl.visibleIvs || []) {
            const ax0 = band.linearXForTime(Math.max(vi.iv.xmin, band.startT));
            const ax1 = band.linearXForTime(Math.min(vi.iv.xmax, band.endT));
            if (ax1 <= ax0) continue;
            if (vi.iv.text !== '') svgEl('rect', { x: ax0, y: band.anchorY + 1, width: Math.max(0.5, ax1 - ax0), height: band.anchorH - 2, fill: pal.ink, opacity: 0.24 }, ancG);
            svgEl('line', { x1: ax0, y1: band.anchorY, x2: ax0, y2: band.anchorY + band.anchorH, stroke: pal.border, 'stroke-width': sw(0.9) }, ancG);
          }
        }
      }

      for (const seg of band.linearSegs) {
        if (!seg.collapsed) continue;
        const swSeg = seg.x1 - seg.x0;
        const mx = (seg.x0 + seg.x1) / 2;
        const cpG = svgEl('g', isExp ? {} : { 'data-legend-keys': 'collapsed-pause' }, bG);
        if (!transparentBg) svgEl('rect', { x: seg.x0, y: band.waveY, width: swSeg, height: band.linearH, fill: pal.paper }, cpG);
        svgEl('line', { x1: seg.x0, y1: band.waveY, x2: seg.x1, y2: band.waveY, stroke: pal.rule, 'stroke-width': sw(1), 'stroke-dasharray': '2 2' }, cpG);
        svgEl('line', { x1: seg.x0, y1: band.specY, x2: seg.x1, y2: band.specY, stroke: pal.rule, 'stroke-width': sw(1), 'stroke-dasharray': '2 2' }, cpG);
        svgEl('line', { x1: seg.x0, y1: band.anchorY + band.anchorH, x2: seg.x1, y2: band.anchorY + band.anchorH, stroke: pal.rule, 'stroke-width': sw(1), 'stroke-dasharray': '2 2' }, cpG);
        const my = band.specY + band.specH / 2;
        svgEl('line', { x1: mx - 6, y1: my + 9, x2: mx - 1, y2: my - 9, stroke: pal.mutedAlt, 'stroke-width': sw(1.2) }, cpG);
        svgEl('line', { x1: mx + 1, y1: my + 9, x2: mx + 6, y2: my - 9, stroke: pal.mutedAlt, 'stroke-width': sw(1.2) }, cpG);
      }
    } else {
      const linG = svgEl('g', isExp ? (sem ? { id: `band-${bNum}-waveform` } : {}) : { 'data-role': 'linear-bar', 'data-band': band.bandIndex }, bG);
      svgEl('rect', { x: band.originX, y: band.linearY, width: band.bandContentW, height: band.linearH, fill: transparentBg ? 'none' : pal.linBg, stroke: pal.rule, 'stroke-width': sw(1) }, linG);
      if (hasAudio && audioBuffer) {
        const wfD = buildWaveformPolygonPath(audioBuffer, audioOffset, band.linearSegs, band.linearY, band.linearH);
        if (wfD) svgEl('path', { d: wfD, fill: pal.linWaveFill, opacity: pal.isBw ? 0.92 : 0.78 }, linG);
        svgEl('line', { x1: band.originX, y1: band.linearY + band.linearH / 2, x2: band.originX + band.bandContentW, y2: band.linearY + band.linearH / 2, stroke: pal.waveMid, 'stroke-width': sw(0.6) }, linG);
      } else {
        for (const seg of band.linearSegs) {
          if (seg.collapsed) continue;
          let activeCount = 0;
          for (const tl of band.tiersLayout) {
            if (!tl) continue;
            if (tl.meta.kind === 'intervalTier') {
              for (const vi of tl.visibleIvs || []) {
                if (vi.iv.text !== '' && vi.iv.xmin <= seg.t0 && vi.iv.xmax >= seg.t1) {
                  activeCount++;
                  break;
                }
              }
            }
          }
          if (activeCount > 0) {
            svgEl('rect', { x: seg.x0, y: band.linearY + 2, width: Math.max(0.5, seg.x1 - seg.x0), height: band.linearH - 4, fill: pal.ink, opacity: Math.min(0.45, 0.14 + activeCount * 0.09) }, linG);
          }
        }
      }
      for (const seg of band.linearSegs) {
        if (!seg.collapsed) continue;
        const cpG = svgEl('g', isExp ? {} : { 'data-legend-keys': 'collapsed-pause' }, linG);
        if (!transparentBg) svgEl('rect', { x: seg.x0, y: band.linearY, width: seg.x1 - seg.x0, height: band.linearH, fill: pal.paper }, cpG);
        svgEl('line', { x1: seg.x0, y1: band.linearY, x2: seg.x1, y2: band.linearY, stroke: pal.rule, 'stroke-width': sw(1), 'stroke-dasharray': '2 2' }, cpG);
        svgEl('line', { x1: seg.x0, y1: band.linearY + band.linearH, x2: seg.x1, y2: band.linearY + band.linearH, stroke: pal.rule, 'stroke-width': sw(1), 'stroke-dasharray': '2 2' }, cpG);
        const mx = (seg.x0 + seg.x1) / 2;
        const my = band.linearY + band.linearH / 2;
        svgEl('line', { x1: mx - 5, y1: my + 5, x2: mx - 1, y2: my - 5, stroke: pal.mutedAlt, 'stroke-width': sw(1.2) }, cpG);
        svgEl('line', { x1: mx + 1, y1: my + 5, x2: mx + 5, y2: my - 5, stroke: pal.mutedAlt, 'stroke-width': sw(1.2) }, cpG);
      }
    }

    // Tier 1: Band 0 Left-Gutter Axis Micro-Labels
    if (band.bandIndex === 0) {
      renderBand0AxisLabels(bG, band, {
        lang: exportCtx?.legendLang || 'zh',
        hasAudio,
        showSpec: Boolean(hasAudio && band.specH > 0),
        hideTicks: layout.hideTicks,
        padX: layout.padX,
        isTinyView: layout.isTinyView,
        pal,
        fScale,
        isExp,
        sem,
        bNum,
        sansFontFamily: sansFont
      });
    }

    // B. Projection Necks (strict straight-line academic geometry; supports 0 / 1 / N transition necks)
    const neckG = svgEl('g', isExp && sem ? { id: `band-${bNum}-neck` } : {}, bG);
    const acousticBotY = band.linearY + band.linearH;
    const bwBoost = pal.isBw ? 0.12 : 0;
    const hasMultiTierShared = band.spineCols.some(
      (c, idx) => idx > 0 && idx < band.spineCols.length - 1 && c.usage >= 2
    );

    // 1. Top physical anchor ticks inside [linearY, acousticBotY]
    for (let i = 0; i < band.spineCols.length; i++) {
      const col = band.spineCols[i];
      const lx = lxs[i];
      const isBandEdgeOrGlobal =
        col.t === tg.xmin ||
        col.t === tg.xmax ||
        i === 0 ||
        i === band.spineCols.length - 1;
      const minLinGap = minLinGapAt(i);
      const isCrossShared = band.hasMixedScales && col.linearUsage > 0 && col.elasticUsage > 0;
      const isMajor = hasMultiTierShared
        ? isBandEdgeOrGlobal || isCrossShared || col.usage >= 2
        : isBandEdgeOrGlobal;
      const isSliverMinor = !isMajor && Boolean(col.isSliverEdge);

      if (!hasAudio || band.specH === 0) {
        svgEl(
          'line',
          {
            x1: lx,
            y1: band.linearY,
            x2: lx,
            y2: acousticBotY,
            stroke: isMajor ? pal.ink : pal.faint,
            'stroke-width': sw(isMajor ? 1 : 0.65),
            opacity: !isMajor && (isSliverMinor || minLinGap < 10) ? 0.38 : hasAudio ? 0.45 : 0.72
          },
          neckG
        );
      } else {
        const ancAttrs: Record<string, string | number> = {
          x1: lx,
          y1: band.anchorY,
          x2: lx,
          y2: acousticBotY,
          stroke: isMajor ? pal.ink : pal.faint,
          'stroke-width': sw(isMajor ? 1 : 0.65)
        };
        if (!isMajor && (isSliverMinor || minLinGap < 10)) ancAttrs.opacity = 0.4;
        svgEl('line', ancAttrs, neckG);
      }
    }

    // 2. Vertical 1:1 connector directly below acoustic track when all-linear or when first tier run is linear
    const firstTierScale =
      band.displayOrder.length > 0 ? band.tiersLayout[band.displayOrder[0]]?.scaleMode : undefined;
    if (band.transitionNecks.length === 0) {
      for (let i = 0; i < band.spineCols.length; i++) {
        const col = band.spineCols[i];
        const lx = lxs[i];
        const isBandEdgeOrGlobal =
          col.t === tg.xmin ||
          col.t === tg.xmax ||
          i === 0 ||
          i === band.spineCols.length - 1;
        const isMajor = hasMultiTierShared ? isBandEdgeOrGlobal || col.usage >= 2 : isBandEdgeOrGlobal;
        svgEl(
          'line',
          {
            x1: lx,
            y1: band.neckTopY,
            x2: col.x,
            y2: band.neckBotY,
            stroke: isMajor ? pal.faint : pal.rule,
            'stroke-width': sw(isMajor ? 0.9 : 0.65),
            opacity: Math.min(1, (isMajor ? 0.78 : 0.5) + bwBoost)
          },
          neckG
        );
      }
    } else if (band.hasMixedScales && firstTierScale === 'linear' && band.tiersTopY > acousticBotY) {
      // Crisp 1:1 physical short ticks bridging acoustic track into top linear tier(s)
      for (let i = 0; i < band.spineCols.length; i++) {
        const col = band.spineCols[i];
        const lx = lxs[i];
        const isBandEdgeOrGlobal =
          col.t === tg.xmin ||
          col.t === tg.xmax ||
          i === 0 ||
          i === band.spineCols.length - 1;
        if (!isBandEdgeOrGlobal && col.linearUsage === 0) continue;
        const isCrossShared = col.linearUsage > 0 && col.elasticUsage > 0;
        const isMajor = isBandEdgeOrGlobal || isCrossShared || col.linearUsage >= 2;
        svgEl(
          'line',
          {
            x1: lx,
            y1: acousticBotY,
            x2: lx,
            y2: band.tiersTopY,
            stroke: isMajor ? pal.ink : pal.faint,
            'stroke-width': sw(isMajor ? 0.95 : 0.65),
            opacity: Math.min(1, (isMajor ? 0.78 : 0.52) + bwBoost)
          },
          neckG
        );
      }
    }

    // 3. Render every coordinate-transition neck (primary neck full style; secondary return necks compact & muted)
    for (const neck of band.transitionNecks) {
      const neckH = Math.max(1, neck.botY - neck.topY);
      const isL2E = neck.direction === 'l2e';
      const isPrimary = neck.isPrimary;

      if (isPrimary && !hideStretch) {
        for (const seg of band.linearSegs) {
          if (!seg.isStretched) continue;
          const c0 = band.spineCols[seg.globalIdx - band.startIdx];
          const c1 = band.spineCols[seg.globalIdx + 1 - band.startIdx];
          if (!c0 || !c1) continue;
          const tx0 = isL2E ? seg.x0 : c0.x;
          const tx1 = isL2E ? seg.x1 : c1.x;
          const bx0 = isL2E ? c0.x : seg.x0;
          const bx1 = isL2E ? c1.x : seg.x1;
          svgEl('polygon', {
            points: `${tx0},${neck.topY} ${tx1},${neck.topY} ${bx1},${neck.botY} ${bx0},${neck.botY}`,
            fill: pal.isBw ? '#E8E8E8' : pal.amber,
            opacity: pal.isBw ? 0.72 : 0.05,
            ...(isExp ? {} : { 'data-legend-keys': 'stretch' })
          }, neckG);
        }
      }

      const secAtten = isPrimary ? 1 : 0.62;
      for (let i = 0; i < band.spineCols.length; i++) {
        const col = band.spineCols[i];
        const lx = lxs[i];
        const topX = isL2E ? lx : col.x;
        const botX = isL2E ? col.x : lx;
        const isBandEdgeOrGlobal =
          col.t === tg.xmin ||
          col.t === tg.xmax ||
          i === 0 ||
          i === band.spineCols.length - 1;
        const minLinGap = minLinGapAt(i);
        const slant = Math.abs(col.x - lx);
        const slantRatio = slant / neckH;
        const isHighDensitySlant = avgLinGap < 14 && slant > 32;
        const isCrossShared = band.hasMixedScales && col.linearUsage > 0 && col.elasticUsage > 0;
        const isMajor = hasMultiTierShared
          ? isBandEdgeOrGlobal || isCrossShared || col.usage >= (isHighDensitySlant ? 3 : 2)
          : isBandEdgeOrGlobal;
        const isSliverMinor = !isMajor && Boolean(col.isSliverEdge);

        if (isBandEdgeOrGlobal) {
          svgEl(
            'line',
            {
              x1: topX,
              y1: neck.topY,
              x2: botX,
              y2: neck.botY,
              stroke: pal.faint,
              'stroke-width': sw(isPrimary ? 0.95 : 0.8),
              opacity: Math.min(1, 0.78 * secAtten + bwBoost)
            },
            neckG
          );
        } else if (isCrossShared) {
          // Cross-coordinate shared boundary anchor: elevated contrast so readers effortlessly track word-to-phone alignment
          const crossOp = slantRatio > 2.8 ? 0.68 : 0.86;
          svgEl(
            'line',
            {
              x1: topX,
              y1: neck.topY,
              x2: botX,
              y2: neck.botY,
              stroke: isPrimary ? pal.ink : pal.faint,
              'stroke-width': sw(isPrimary ? 1.05 : 0.8),
              opacity: Math.min(1, crossOp * secAtten + bwBoost)
            },
            neckG
          );
        } else if (isMajor) {
          const majorOp = slantRatio > 2.8 ? 0.54 : 0.72;
          svgEl(
            'line',
            {
              x1: topX,
              y1: neck.topY,
              x2: botX,
              y2: neck.botY,
              stroke: pal.faint,
              'stroke-width': sw(isPrimary ? 0.9 : 0.7),
              opacity: Math.min(1, majorOp * secAtten + bwBoost)
            },
            neckG
          );
        } else {
          const minorOp = isSliverMinor
            ? 0.34
            : minLinGap < 8
              ? 0.42
              : slantRatio > 2.8
                ? 0.42
                : 0.52;
          svgEl(
            'line',
            {
              x1: topX,
              y1: neck.topY,
              x2: botX,
              y2: neck.botY,
              stroke: pal.faint,
              'stroke-width': sw(isPrimary ? 0.7 : 0.55),
              opacity: Math.min(1, minorOp * secAtten + bwBoost)
            },
            neckG
          );
        }
      }
    }

    // Subtle horizontal separator below primary neck breaks `\` vs `-52° /` X-clashes (P1-3)
    if (!layout.hideTicks) {
      svgEl(
        'line',
        {
          x1: band.originX,
          y1: band.tickSpineTopY + 0.5,
          x2: band.originX + band.bandContentW,
          y2: band.tickSpineTopY + 0.5,
          stroke: pal.rule,
          'stroke-width': sw(0.75),
          opacity: 0.45
        },
        neckG
      );
    }

    // C. Timestamp Spine (single -52° spine per band anchored at tickSpineBotY) & Per-Run Vertical Grid Lines
    const spineG = svgEl('g', isExp && sem ? { id: `band-${bNum}-axis-time` } : {}, bG);
    const spineBaseY = band.tickSpineBotY;
    const tierGridSlices = band.coordSlices.filter(
      (s) => (s.kind === 'linear' && s.y1 > acousticBotY + 1e-6) || s.kind === 'elastic'
    );
    let lastVisibleTickStr: string | null = null;
    for (let i = 0; i < band.spineCols.length; i++) {
      const col = band.spineCols[i];
      const lx = lxs[i];
      const prevCol = i > 0 ? band.spineCols[i - 1] : null;
      const isGlobalStart = col.t === tg.xmin;
      const isGlobalEnd = col.t === tg.xmax;
      const isBandEdge = i === 0 || i === band.spineCols.length - 1;
      const isCrossShared = band.hasMixedScales && col.linearUsage > 0 && col.elasticUsage > 0;
      const isMajor = col.usage >= 2 || isCrossShared || isGlobalStart || isGlobalEnd;
      const exactTooltip = `${formatPraatDouble(col.t)} s`;

      if (!hideStretch && prevCol && col.t - prevCol.t > 1e-12 && col.t - prevCol.t < 0.005 - 1e-9) {
        svgEl('rect', {
          x: prevCol.x, y: spineBaseY - 4, width: col.x - prevCol.x, height: 3, fill: pal.microWarn,
          ...(isExp ? {} : { 'data-legend-keys': 'micro-seg' })
        }, spineG);
      }

      svgEl('line', { x1: col.x, y1: spineBaseY - 5, x2: col.x, y2: spineBaseY, stroke: isMajor ? pal.ink : pal.tickMinor, 'stroke-width': sw(isMajor ? 1.3 : 0.9) }, spineG);

      if (isGlobalStart && isGlobalEnd) {
        svgEl('path', { d: `M${col.x - 4},${spineBaseY - 7} L${col.x + 4},${spineBaseY - 7} M${col.x - 4},${spineBaseY - 7} L${col.x - 4},${spineBaseY} M${col.x + 4},${spineBaseY - 7} L${col.x + 4},${spineBaseY}`, fill: 'none', stroke: pal.ink, 'stroke-width': sw(1.4) }, spineG);
      } else if (isGlobalStart) {
        svgEl('path', { d: `M${col.x + 4},${spineBaseY - 6} L${col.x},${spineBaseY - 6} L${col.x},${spineBaseY}`, fill: 'none', stroke: pal.ink, 'stroke-width': sw(1.5) }, spineG);
      } else if (isGlobalEnd) {
        svgEl('path', { d: `M${col.x - 4},${spineBaseY - 6} L${col.x},${spineBaseY - 6} L${col.x},${spineBaseY}`, fill: 'none', stroke: pal.ink, 'stroke-width': sw(1.5) }, spineG);
      }

      if (!layout.hideTicks) {
        if (col.labelVisible) {
          const str = col.label;
          let commonLen = 0;
          if (lastVisibleTickStr) {
            const lim = Math.min(str.length, lastVisibleTickStr.length);
            while (commonLen < lim && str[commonLen] === lastVisibleTickStr[commonLen]) commonLen++;
            if (commonLen < 2 || commonLen >= str.length) commonLen = 0;
          }
          lastVisibleTickStr = str;

          const tAttrs: Record<string, string | number> = {
            x: col.x + 1,
            y: spineBaseY - 8,
            transform: `rotate(-52, ${col.x + 1}, ${spineBaseY - 8})`,
            'text-anchor': 'start',
            'font-family': monoFont,
            'font-size': fs(10.5),
            ...(!transparentBg
              ? {
                  stroke: pal.paper,
                  'stroke-width': sw(2.6),
                  'paint-order': 'stroke',
                  'stroke-linejoin': 'round'
                }
              : {})
          };
          if (!isExp) {
            tAttrs['data-role'] = 'spine-tick';
            tAttrs['data-time'] = String(col.t);
            tAttrs['data-band'] = band.bandIndex;
          }
          const tEl = svgEl('text', tAttrs, spineG);
          if (!isExp) svgEl('title', {}, tEl).textContent = exactTooltip;

          if (commonLen > 0) {
            svgEl('tspan', { fill: pal.faintTick }, tEl).textContent = str.slice(0, commonLen);
            svgEl('tspan', { fill: pal.ink, 'font-weight': isMajor ? '600' : '500' }, tEl).textContent = str.slice(commonLen);
          } else {
            svgEl('tspan', { fill: pal.ink, 'font-weight': isMajor ? '600' : '400' }, tEl).textContent = str;
          }
        } else if (isExp) {
          svgEl('rect', { x: col.x - 1, y: spineBaseY - 7.5, width: 2, height: 2, fill: isMajor ? pal.muted : pal.faintTick }, spineG);
        } else {
          const hitG = svgEl('g', { 'data-role': 'spine-tick', 'data-time': String(col.t), 'data-band': band.bandIndex }, spineG);
          svgEl('title', {}, hitG).textContent = exactTooltip;
          svgEl('rect', { x: col.x - 4, y: spineBaseY - 14, width: 8, height: 14, fill: 'transparent', 'data-ui-only': '1' }, hitG);
          svgEl('rect', { x: col.x - 1, y: spineBaseY - 7.5, width: 2, height: 2, fill: isMajor ? pal.muted : pal.faintTick }, hitG);
        }
      }

      for (const slice of tierGridSlices) {
        const gy0 = Math.max(slice.y0, band.tiersTopY);
        const gy1 = slice.y1;
        if (gy1 <= gy0 + 0.5) continue;
        if (slice.kind === 'linear') {
          if (band.hasMixedScales && !isBandEdge && !isGlobalStart && !isGlobalEnd && col.linearUsage === 0) {
            continue;
          }
          const linMajor = isGlobalStart || isGlobalEnd || isCrossShared || col.linearUsage >= 2;
          svgEl('line', {
            x1: lx, y1: gy0, x2: lx, y2: gy1,
            stroke: linMajor ? pal.gridMajor : pal.gridMinor,
            'stroke-width': sw(linMajor ? 0.9 : 0.7),
            'stroke-dasharray': linMajor ? 'none' : '2 2',
            ...(isExp ? {} : { 'data-legend-keys': 'boundaries' })
          }, spineG);
        } else {
          svgEl('line', {
            x1: col.x, y1: gy0, x2: col.x, y2: gy1,
            stroke: isMajor ? pal.gridMajor : pal.gridMinor,
            'stroke-width': sw(isMajor ? 0.9 : 0.7),
            'stroke-dasharray': isMajor ? 'none' : '2 2',
            ...(isExp ? {} : { 'data-legend-keys': 'boundaries' })
          }, spineG);
        }
      }
    }

    for (const ptTick of band.isolatedPointTicks) {
      const exactTooltip = `${formatPraatDouble(ptTick.t)} s`;
      svgEl(
        'line',
        {
          x1: ptTick.x,
          y1: spineBaseY - 4,
          x2: ptTick.x,
          y2: spineBaseY,
          stroke: pal.tickMinor,
          'stroke-width': sw(0.8)
        },
        spineG
      );
      if (!layout.hideTicks) {
        if (ptTick.labelVisible) {
          const tAttrs: Record<string, string | number> = {
            x: ptTick.x + 1,
            y: spineBaseY - 8,
            transform: `rotate(-52, ${ptTick.x + 1}, ${spineBaseY - 8})`,
            'text-anchor': 'start',
            'font-family': monoFont,
            'font-size': fs(9.5),
            fill: pal.muted,
            ...(!transparentBg
              ? {
                  stroke: pal.paper,
                  'stroke-width': sw(2.4),
                  'paint-order': 'stroke',
                  'stroke-linejoin': 'round'
                }
              : {})
          };
          if (!isExp) {
            tAttrs['data-role'] = 'spine-tick';
            tAttrs['data-time'] = String(ptTick.t);
            tAttrs['data-band'] = band.bandIndex;
          }
          const tEl = svgEl('text', tAttrs, spineG);
          if (!isExp) svgEl('title', {}, tEl).textContent = exactTooltip;
          svgEl('tspan', {}, tEl).textContent = ptTick.label;
        } else if (isExp) {
          svgEl(
            'rect',
            {
              x: ptTick.x - 1,
              y: spineBaseY - 7.5,
              width: 2,
              height: 2,
              fill: pal.faintTick
            },
            spineG
          );
        } else {
          const hitG = svgEl(
            'g',
            { 'data-role': 'spine-tick', 'data-time': String(ptTick.t), 'data-band': band.bandIndex },
            spineG
          );
          svgEl('title', {}, hitG).textContent = exactTooltip;
          svgEl(
            'rect',
            {
              x: ptTick.x - 4,
              y: spineBaseY - 14,
              width: 8,
              height: 14,
              fill: 'transparent',
              'data-ui-only': '1'
            },
            hitG
          );
          svgEl(
            'rect',
            {
              x: ptTick.x - 1,
              y: spineBaseY - 7.5,
              width: 2,
              height: 2,
              fill: pal.faintTick
            },
            hitG
          );
        }
      }
      if (ptTick.labelVisible) {
        const ptTargetSlices = band.hasMixedScales
          ? tierGridSlices.filter((s) => s.kind === 'elastic')
          : tierGridSlices;
        for (const slice of ptTargetSlices) {
          const gy0 = Math.max(slice.y0, band.tiersTopY);
          if (slice.y1 <= gy0 + 0.5) continue;
          svgEl(
            'line',
            {
              x1: ptTick.x,
              y1: gy0,
              x2: ptTick.x,
              y2: slice.y1,
              stroke: pal.gridMinor,
              'stroke-width': sw(0.65),
              'stroke-dasharray': '2 3',
              opacity: 0.45
            },
            spineG
          );
        }
      }
    }

    // D. Multi-Tier Tracks
    const acousticExtMap = new Map<
      string,
      { time: number; elX: number; tierTopY: number; style: ResolvedBoundaryStyle }
    >();
    const recordAcousticExt = (
      bt: number,
      elX: number,
      tierTopY: number,
      bStyle: ResolvedBoundaryStyle
    ) => {
      if (!bStyle.extendToAcoustic) return;
      const key = `${Math.round(bt * 1e6)}|${bStyle.strokeColor}|${bStyle.strokeWidth}|${bStyle.strokeDash}`;
      const existing = acousticExtMap.get(key);
      if (!existing || tierTopY > existing.tierTopY) {
        acousticExtMap.set(key, { time: bt, elX, tierTopY, style: bStyle });
      }
    };

    for (const ti of band.displayOrder) {
      const tl = band.tiersLayout[ti];
      if (!tl) continue;
      const tier = tl.tier;
      const displayNum = tier.displayNum ?? ti + 1;
      const accent = pal.tierAccents[(displayNum - 1) % pal.tierAccents.length];
      const tierSlug = safeId(tier.name || `tier-${displayNum}`);
      const tG = svgEl('g', isExp ? (sem ? { id: `band-${bNum}-tier-${displayNum}-${tierSlug}` } : {}) : { 'data-tier': ti }, bG);
      const tierStyle = hasStyle ? resolveTierStyle(effectiveStyleDoc!, tg, ti) : null;

      // Left Tier Header
      const hb = tl.headerBox;
      const hdrG = svgEl('g', isExp ? {} : { 'data-role': 'tier-header', 'data-tier': ti, 'data-band': band.bandIndex }, tG);
      if (!isExp) {
        svgEl('title', {}, hdrG).textContent = `${displayNum}. ${tier.name || '(空层名)'} [${tier.kind === 'intervalTier' ? 'IntervalTier' : 'TextTier'}]`;
        svgEl('rect', { class: 'hdr-hit', x: 0, y: tl.y, width: band.originX, height: tl.h, fill: 'transparent', 'data-ui-only': '1' }, hdrG);
        svgEl('rect', { class: 'hdr-bg', x: hb.x, y: hb.y, width: hb.w, height: hb.h, fill: tierStyle?.labelBg || 'transparent' }, hdrG);
        svgEl('rect', { class: 'hdr-accent', x: hb.x, y: hb.y, width: 2.5, height: hb.h, fill: accent, 'data-ui-only': '1' }, hdrG);
      } else if (tierStyle?.labelBg) {
        svgEl('rect', { x: hb.x, y: hb.y, width: hb.w, height: hb.h, fill: tierStyle.labelBg }, hdrG);
      }

      const midY = tl.midY;
      const numRightX = hb.x + (layout.isTinyView ? 14 : 20);
      svgEl('text', {
        x: numRightX, y: midY + 4, 'text-anchor': 'end',
        'font-family': monoFont, 'font-size': fs(layout.isTinyView ? 9.5 : 10.5),
        fill: tierStyle?.labelColor || pal.mutedAlt,
        ...(tierStyle?.labelColor ? { opacity: '0.72' } : {})
      }, hdrG).textContent = String(displayNum);

      const gx = hb.x + (layout.isTinyView ? 19 : 27);
      if (tier.kind === 'intervalTier') {
        svgEl('rect', { x: gx, y: midY - 4.5, width: 12, height: 9, fill: transparentBg ? 'none' : pal.paper, stroke: accent, 'stroke-width': sw(1.2) }, hdrG);
        svgEl('line', { x1: gx + 6, y1: midY - 4.5, x2: gx + 6, y2: midY + 4.5, stroke: accent, 'stroke-width': sw(1.1) }, hdrG);
      } else {
        svgEl('line', { x1: gx - 1, y1: midY, x2: gx + 13, y2: midY, stroke: pal.wire, 'stroke-width': sw(1.1) }, hdrG);
        svgEl('polygon', { points: `${gx + 6},${midY - 3.5} ${gx + 9.5},${midY} ${gx + 6},${midY + 3.5} ${gx + 2.5},${midY}`, fill: tierStyle?.labelColor || pal.ink }, hdrG);
      }

      const showStaticMixedBadge =
        band.hasMixedScales &&
        tl.scaleMode === 'linear' &&
        !layout.isTinyView &&
        !(isExp && exportCtx?.hideScaleBadges);
      const showInteractiveScalePill = !isExp && !layout.isTinyView && hb.w >= 72;
      const pillReserveW = showStaticMixedBadge ? 22 : 0;

      const nameX = gx + (layout.isTinyView ? 16 : 19);
      const maxNameW = Math.max(12, hb.w - (nameX - hb.x) - 3 - pillReserveW);
      if (band.bandIndex === 0 || maxNameW >= 18) {
        const isPrimaryBand = band.bandIndex === 0;
        const nameWrap = svgEl('g', !isExp && isPrimaryBand ? { 'data-tier-name-node': ti } : {}, hdrG);
        if (tier.name === '') {
          if (!hideMeta) {
            svgEl('text', {
              x: nameX, y: midY + 4, 'font-family': symbolFont, 'font-size': fs(isPrimaryBand ? 11.5 : 10.5), fill: tierStyle?.labelColor || pal.meta, opacity: isPrimaryBand ? '1' : '0.75',
              ...(isExp ? {} : { 'data-legend-keys': 'meta-symbols' })
            }, nameWrap).textContent = '∅';
          }
        } else {
          const namePxSize = (isPrimaryBand || !layout.isTinyView ? 12 : 11) * fScale;
          const nameFont = `500 ${namePxSize.toFixed(2)}px ${SANS_FONT_STACK}`;
          const displayName = truncateTierNameMiddle(tier.name, maxNameW, nameFont);
          svgEl('text', {
            x: nameX, y: midY + 4, 'font-family': sansFont,
            'font-size': String(Number(namePxSize.toFixed(2))), 'font-weight': '500',
            fill: tierStyle?.labelColor || (isPrimaryBand ? pal.ink : pal.muted),
            ...(tierStyle?.labelColor && !isPrimaryBand ? { opacity: '0.82' } : {})
          }, nameWrap).textContent = displayName;
        }
      }

      // Publication-grade restrained monochrome 1:1 micro-badge (export / mixed linear tiers)
      // and interactive hover/pinned scale toggle capsule (both edit & read modes)
      if (isExp) {
        if (showStaticMixedBadge && (band.bandIndex === 0 || hb.w >= 72)) {
          const bw = 18;
          const bh = 11;
          const bx = hb.x + hb.w - bw - 1;
          const by = midY - bh / 2;
          const badgeG = svgEl('g', {}, hdrG);
          svgEl(
            'rect',
            {
              x: bx,
              y: by,
              width: bw,
              height: bh,
              rx: 1.5,
              fill: 'none',
              stroke: pal.muted,
              'stroke-width': sw(0.65),
              opacity: 0.58
            },
            badgeG
          );
          svgEl(
            'text',
            {
              x: bx + bw / 2,
              y: midY + 2.7 * fScale,
              'text-anchor': 'middle',
              'font-family': monoFont,
              'font-size': fs(7.5),
              fill: pal.muted,
              opacity: 0.78
            },
            badgeG
          ).textContent = '1:1';
        }
      } else if (showInteractiveScalePill) {
        const isTierLin = tl.scaleMode === 'linear';
        const isPinned = band.hasMixedScales && isTierLin;
        const pillW = isTierLin ? 24 : 28;
        const pillH = 15;
        const pillX = hb.x + hb.w - pillW - 4;
        const pillY = midY - pillH / 2;
        const pillG = svgEl(
          'g',
          {
            class: `tier-scale-pill ${isTierLin ? 'is-linear' : 'is-elastic'}${isPinned ? ' is-pinned' : ''}`,
            'data-role': 'tier-scale-toggle',
            'data-tier': ti,
            'data-band': band.bandIndex,
            'data-ui-only': '1'
          },
          hdrG
        );
        svgEl('title', {}, pillG).textContent = isTierLin
          ? '当前：线性 (1:1) · 点击切换为自适应双尺'
          : '当前：自适应双尺 · 点击切换为线性 (1:1)';
        svgEl(
          'rect',
          {
            class: 'tier-scale-pill-bg',
            x: pillX,
            y: pillY,
            width: pillW,
            height: pillH,
            rx: 0,
            fill: isTierLin ? '#EDF2FF' : '#F8F7F4',
            stroke: isTierLin ? '#93C5FD' : '#D6D3C9',
            'stroke-width': 1
          },
          pillG
        );
        svgEl(
          'text',
          {
            class: 'tier-scale-pill-txt',
            x: pillX + pillW / 2,
            y: midY + 3,
            'text-anchor': 'middle',
            'font-family': isTierLin ? monoFont : sansFont,
            'font-size': isTierLin ? '8.5' : '8.2',
            'font-weight': isTierLin ? '600' : '500',
            fill: isTierLin ? '#1D4ED8' : '#57534E'
          },
          pillG
        ).textContent = isTierLin ? '1:1' : '弹性';
      }

      const safeColX = (t: number) => {
        if (tl.scaleMode === 'linear') return band.linearXForTime(t);
        const gi = layout.tToIdx.get(t);
        if (gi !== undefined && gi >= band.startIdx && gi <= band.endIdx) return band.spineCols[gi - band.startIdx].x;
        return elasticXInBand(band, t);
      };
      const domStart = Math.max(band.startT, Number.isFinite(tier.xmin) ? tier.xmin : band.startT);
      const domEnd = Math.min(band.endT, Number.isFinite(tier.xmax) ? tier.xmax : band.endT);
      const domStartX = domStart <= band.startT ? band.originX : domStart >= band.endT ? band.originX + band.bandContentW : safeColX(domStart);
      const domEndX = domEnd >= band.endT ? band.originX + band.bandContentW : domEnd <= band.startT ? band.originX : safeColX(domEnd);

      if (domStartX > band.originX) svgEl('rect', { x: band.originX, y: tl.y, width: domStartX - band.originX, height: tl.h, fill: `url(#${pfx}pat-ood)`, ...(isExp ? {} : { 'data-legend-keys': 'ood' }) }, tG);
      if (domEndX < band.originX + band.bandContentW) svgEl('rect', { x: domEndX, y: tl.y, width: band.originX + band.bandContentW - domEndX, height: tl.h, fill: `url(#${pfx}pat-ood)`, ...(isExp ? {} : { 'data-legend-keys': 'ood' }) }, tG);

      if (tl.meta.kind === 'intervalTier') {
        if (tl.meta.unrepairedEmpty) {
          if (domEndX > domStartX) {
            svgEl('rect', { x: domStartX, y: tl.y, width: domEndX - domStartX, height: tl.h, fill: transparentBg ? 'none' : pal.waveBg, stroke: pal.faint, 'stroke-width': sw(1), 'stroke-dasharray': '3 3' }, tG);
          }
        } else {
          for (const g of tl.meta.gaps) {
            if (g.xmax <= band.startT || g.xmin >= band.endT) continue;
            const gx0 = g.xmin <= band.startT ? band.originX : safeColX(g.xmin);
            const gx1 = g.xmax >= band.endT ? band.originX + band.bandContentW : safeColX(g.xmax);
            svgEl('rect', { x: gx0, y: tl.y + 1, width: Math.max(1, gx1 - gx0), height: tl.h - 2, fill: `url(#${pfx}pat-gap)`, ...(isExp ? {} : { 'data-legend-keys': 'gap' }) }, tG);
          }

          let ivClipCounter = 0;
          const tierCustomBoundaries = new Map<
            string,
            { x: number; y0: number; y1: number; style: ResolvedBoundaryStyle }
          >();
          for (const vi of tl.visibleIvs || []) {
            const iv = vi.iv;
            const ly = tl.y + (tl.laneOffsets?.[iv.lane] || 0);
            const lh = tl.laneHeights?.[iv.lane] || tl.h;
            const isEmpty = iv.text === '';
            const ivStyle = hasStyle ? resolveIntervalStyle(effectiveStyleDoc!, tg, ti, iv.origIdx) : null;
            const ivTextStyle =
              ivStyle?.hasCustom && ivStyle.hasCustomText
                ? {
                    color: ivStyle.textColor,
                    fontWeight: ivStyle.fontWeight,
                    fontStyle: ivStyle.fontStyle
                  }
                : null;

            const ivG = svgEl('g', isExp ? {} : {
              'data-role': 'interval', 'data-tier': ti, 'data-idx': iv.origIdx, 'data-band': band.bandIndex,
              'data-empty': isEmpty ? '1' : '0',
              'data-legend-keys': isEmpty ? 'empty-interval' : 'labeled-interval'
            }, tG);
            if (!isExp) {
              const durMs = Math.round((iv.xmax - iv.xmin) * 1000);
              const stretchNote = vi.isStretched ? ` · 按字宽展开 ${vi.stretchRatio.toFixed(1)}×` : '';
              svgEl('title', {}, ivG).textContent = `${iv.text ? iv.text + '\n' : ''}${formatPraatDouble(iv.xmin)} – ${formatPraatDouble(iv.xmax)} s (${durMs} ms${stretchNote})`;
            }

            const cellBg = transparentBg ? 'none' : isEmpty ? pal.emptyCell : pal.cellFill;
            const customFillActive = Boolean(ivStyle?.hasCustom && ivStyle.hasCustomFill);
            if (!customFillActive || (ivStyle!.fillOpacity < 0.999 && cellBg !== 'none')) {
              if (cellBg !== 'none') svgEl('rect', { x: vi.x0, y: ly, width: vi.w, height: lh, fill: cellBg }, ivG);
            }
            if (customFillActive && ivStyle) {
              if (ivStyle.pattern === 'none') {
                const fillRectAttrs: Record<string, string | number> = {
                  x: vi.x0,
                  y: ly,
                  width: vi.w,
                  height: lh,
                  fill: ivStyle.fill
                };
                if (ivStyle.fillOpacity < 0.999) fillRectAttrs['fill-opacity'] = ivStyle.fillOpacity;
                svgEl('rect', fillRectAttrs, ivG);
              } else {
                if (ivStyle.fillOpacity >= 0.999) {
                  svgEl('rect', { x: vi.x0, y: ly, width: vi.w, height: lh, fill: ivStyle.fill }, ivG);
                }
                const patId = makeSvgPatternId(
                  ivStyle.pattern,
                  ivStyle.fill,
                  ivStyle.patternColor,
                  ivStyle.fillOpacity,
                  patPrefix
                );
                svgEl('rect', { x: vi.x0, y: ly, width: vi.w, height: lh, fill: `url(#${patId})` }, ivG);
              }
            }
            if (!isExp) svgEl('rect', { class: 'iv-hover', x: vi.x0, y: ly, width: vi.w, height: lh, fill: 'rgba(29, 78, 216, 0.055)', 'data-ui-only': '1' }, ivG);
            if (!isEmpty && !(ivStyle?.hasCustom && ivStyle.hasCustomBorder)) {
              const barColor = customFillActive && ivStyle ? ivStyle.borderColor : accent;
              svgEl('rect', { x: vi.x0, y: ly, width: vi.w, height: 2 * sScale, fill: barColor, opacity: pal.isBw ? 0.85 : 0.72 }, ivG);
            }

            if (!hideStretch && vi.isStretched && vi.w >= 14) {
              const yB = ly + lh - 2.5;
              const xL = vi.x0 + 3.5;
              const xR = vi.x1 - 3.5;
              const stTarget = isExp ? ivG : svgEl('g', { 'data-legend-keys': 'stretch', 'pointer-events': 'none' }, ivG);
              svgEl('line', { x1: xL, y1: yB, x2: xR, y2: yB, stroke: pal.amber, 'stroke-width': sw(0.9), 'stroke-dasharray': '2 2', opacity: 0.52 }, stTarget);
              svgEl('path', { d: `M${xL},${yB - 2.5} L${xL},${yB} M${xR},${yB - 2.5} L${xR},${yB}`, fill: 'none', stroke: pal.amber, 'stroke-width': sw(0.9), opacity: 0.65 }, stTarget);
            }

            svgEl('line', { x1: vi.x0, y1: ly, x2: vi.x1, y2: ly, stroke: pal.border, 'stroke-width': sw(1) }, ivG);
            svgEl('line', { x1: vi.x0, y1: ly + lh, x2: vi.x1, y2: ly + lh, stroke: pal.border, 'stroke-width': sw(1) }, ivG);

            if (ivStyle?.hasCustom && ivStyle.hasCustomBorder && ivStyle.borderWidth > 0) {
              const bw = sw(ivStyle.borderWidth);
              const inset = Math.max(0.5, bw / 2);
              if (vi.w > inset * 2 && lh > inset * 2) {
                const bDash = dashArrayFor(ivStyle.borderDash, sScale);
                svgEl(
                  'rect',
                  {
                    x: vi.x0 + inset,
                    y: ly + inset,
                    width: Math.max(0.5, vi.w - inset * 2),
                    height: Math.max(0.5, lh - inset * 2),
                    fill: 'none',
                    stroke: ivStyle.borderColor,
                    'stroke-width': bw,
                    ...(bDash ? { 'stroke-dasharray': bDash } : {}),
                    ...(isExp ? {} : { 'pointer-events': 'none' })
                  },
                  ivG
                );
              }
            }

            if (isEmpty) {
              const formatSilenceDur = (dt: number): string => {
                if (dt >= 10) return `${dt.toFixed(1)}s`;
                if (dt >= 0.1) return `${dt.toFixed(2)}s`;
                return `${Math.round(dt * 1000)}ms`;
              };
              let hasCollapsedChild = false;
              for (let c = band.startIdx; c < band.endIdx; c++) {
                if (!layout.colCollapsed[c]) continue;
                const ct0 = layout.spineT[c];
                const ct1 = layout.spineT[c + 1];
                if (iv.xmin <= ct0 && iv.xmax >= ct1) {
                  hasCollapsedChild = true;
                  const cx0 = safeColX(ct0);
                  const cx1 = safeColX(ct1);
                  const colW = cx1 - cx0;
                  const mx = (cx0 + cx1) / 2;
                  const my = ly + lh / 2;
                  const cpTarget = isExp ? ivG : svgEl('g', { 'data-legend-keys': 'collapsed-pause', 'pointer-events': 'none' }, ivG);
                  const durStr = formatSilenceDur(ct1 - ct0);
                  const durFont = `${(9 * fScale).toFixed(2)}px ${monoFont}`;
                  const txtW = measurePx(durStr, durFont);
                  const slashW = 8;
                  const gap = 3;
                  if (colW >= slashW + gap + txtW + 6) {
                    const startX = mx - (slashW + gap + txtW) / 2;
                    svgEl('line', { x1: startX, y1: my + 4.5, x2: startX + 3, y2: my - 4.5, stroke: pal.mutedAlt, 'stroke-width': sw(1) }, cpTarget);
                    svgEl('line', { x1: startX + 4.5, y1: my + 4.5, x2: startX + 7.5, y2: my - 4.5, stroke: pal.mutedAlt, 'stroke-width': sw(1) }, cpTarget);
                    svgEl(
                      'text',
                      {
                        x: startX + slashW + gap,
                        y: my + 3.1 * fScale,
                        'text-anchor': 'start',
                        'font-family': monoFont,
                        'font-size': fs(9),
                        fill: pal.mutedAlt
                      },
                      cpTarget
                    ).textContent = durStr;
                  } else {
                    svgEl('line', { x1: mx - 4, y1: my + 5, x2: mx - 0.5, y2: my - 5, stroke: pal.mutedAlt, 'stroke-width': sw(1) }, cpTarget);
                    svgEl('line', { x1: mx + 1.5, y1: my + 5, x2: mx + 5, y2: my - 5, stroke: pal.mutedAlt, 'stroke-width': sw(1) }, cpTarget);
                  }
                }
              }
              // P1-4: Subtle duration hint inside unfolded empty silence cells (hidden when export purification hideStretchCues is active)
              if (!hasCollapsedChild && !vi.clippedLeft && !vi.clippedRight && !hideStretch && vi.w >= 44) {
                const dt = iv.xmax - iv.xmin;
                if (dt > 1e-4) {
                  svgEl(
                    'text',
                    {
                      x: vi.x0 + vi.w / 2,
                      y: ly + lh / 2 + 3.2 * fScale,
                      'text-anchor': 'middle',
                      'font-family': monoFont,
                      'font-size': fs(9.5),
                      fill: pal.mutedAlt,
                      ...(isExp ? {} : { 'pointer-events': 'none' })
                    },
                    ivG
                  ).textContent = formatSilenceDur(dt);
                }
              }
            }

            if (!vi.clippedLeft) {
              const leftBStyle = hasStyle ? resolveBoundaryStyle(effectiveStyleDoc!, tg, ti, iv.xmin) : null;
              if (leftBStyle?.hasCustom) {
                const bKey = `${iv.lane}:${Math.round(iv.xmin * 1e6)}`;
                tierCustomBoundaries.set(bKey, { x: vi.x0, y0: ly, y1: ly + lh, style: leftBStyle });
                recordAcousticExt(iv.xmin, vi.x0, tl.y, leftBStyle);
              } else {
                svgEl('line', { x1: vi.x0, y1: ly, x2: vi.x0, y2: ly + lh, stroke: pal.ink, 'stroke-width': sw(1.1) }, ivG);
              }
            } else {
              const tieY = ly + lh / 2;
              const contTarget = isExp ? ivG : svgEl('g', { 'data-legend-keys': 'continuation', 'pointer-events': 'none' }, ivG);
              svgEl('polygon', { points: `${vi.x0},${tieY - 3.5} ${vi.x0 + 5},${tieY} ${vi.x0},${tieY + 3.5}`, fill: pal.muted }, contTarget);
              let renderedGhost = false;
              if (!isEmpty && vi.w >= 34) {
                const availGhostW = vi.w - (vi.clippedRight ? 22 : 16);
                const ghostFont = `italic ${(11 * fScale).toFixed(2)}px ${fontFamily}`;
                const trigMode = exportCtx?.trigraphMode;
                const decodedG = decodeTrigraphGlossSync(iv.text);
                const ghostSrc =
                  trigMode === 'raw-only'
                    ? iv.text
                    : ((trigMode === 'ipa-only' || trigMode === 'dual' || mode === 'read') && decodedG) || iv.text;
                const flatText = hideMeta ? ghostSrc.replace(/[\n\t]+/g, ' ') : ghostSrc.replace(/\n/g, '↵').replace(/\t/g, '⇥');
                let ghostStr = '…' + flatText;
                if (measurePx(ghostStr, ghostFont) > availGhostW) {
                  let trimmed = flatText;
                  while (trimmed.length > 1 && measurePx('…' + trimmed + '…', ghostFont) > availGhostW) trimmed = trimmed.slice(0, -1);
                  ghostStr = '…' + trimmed + '…';
                }
                const ghostW = measurePx(ghostStr, ghostFont);
                if (ghostW <= availGhostW + 2) {
                  svgEl(
                    'text',
                    {
                      x: vi.x0 + 8.5,
                      y: tieY + 4,
                      'text-anchor': 'start',
                      'font-family': fontFamily,
                      'font-size': fs(11),
                      'font-style': 'italic',
                      ...(ivTextStyle?.fontWeight === 'bold' ? { 'font-weight': 'bold' } : {}),
                      fill: ivTextStyle?.color || pal.muted,
                      ...(ivTextStyle?.color ? { opacity: '0.78' } : {})
                    },
                    contTarget
                  ).textContent = ghostStr;
                  const railStart = vi.x0 + 8.5 + ghostW + 6;
                  const railEnd = vi.x1 - (vi.clippedRight ? 9 : 6);
                  if (railEnd - railStart >= 10) svgEl('line', { x1: railStart, y1: tieY, x2: railEnd, y2: tieY, stroke: pal.anchorStroke, 'stroke-width': sw(0.85), 'stroke-dasharray': '2 2' }, contTarget);
                  renderedGhost = true;
                }
              }
              if (!renderedGhost) {
                svgEl('line', { x1: vi.x0 + 2, y1: tieY - 1.5, x2: vi.x1 - 6, y2: tieY - 1.5, stroke: pal.faint, 'stroke-width': sw(0.9) }, contTarget);
                svgEl('line', { x1: vi.x0 + 2, y1: tieY + 1.5, x2: vi.x1 - 6, y2: tieY + 1.5, stroke: pal.faint, 'stroke-width': sw(0.9) }, contTarget);
              }
            }

            if (!vi.clippedRight) {
              const rightBStyle = hasStyle ? resolveBoundaryStyle(effectiveStyleDoc!, tg, ti, iv.xmax) : null;
              if (rightBStyle?.hasCustom) {
                const bKey = `${iv.lane}:${Math.round(iv.xmax * 1e6)}`;
                tierCustomBoundaries.set(bKey, { x: vi.x1, y0: ly, y1: ly + lh, style: rightBStyle });
                recordAcousticExt(iv.xmax, vi.x1, tl.y, rightBStyle);
              } else {
                svgEl('line', { x1: vi.x1, y1: ly, x2: vi.x1, y2: ly + lh, stroke: pal.ink, 'stroke-width': sw(1.1) }, ivG);
              }
            } else {
              const tieY = ly + lh / 2;
              svgEl('polygon', {
                points: `${vi.x1 - 5},${tieY - 3.5} ${vi.x1},${tieY} ${vi.x1 - 5},${tieY + 3.5}`, fill: pal.muted,
                ...(isExp ? {} : { 'data-legend-keys': 'continuation', 'pointer-events': 'none' })
              }, ivG);
            }

            if (vi.rich) {
              let leftInset = 0;
              let rightInset = 0;
              for (const vz of tl.visibleZeros || []) {
                if (!vz.rich) continue;
                const halfBadge = (vz.rich.width + 8) / 2 + 3;
                if (!vi.clippedLeft && Math.abs(vz.iv.xmin - vi.iv.xmin) <= 1e-12) {
                  leftInset = Math.max(leftInset, Math.min(vi.w * 0.42, halfBadge));
                }
                if (!vi.clippedRight && Math.abs(vz.iv.xmin - vi.iv.xmax) <= 1e-12) {
                  rightInset = Math.max(rightInset, Math.min(vi.w * 0.42, halfBadge));
                }
              }
              const textAvailW = Math.max(8, vi.w - leftInset - rightInset);
              const safeSidePad = textAvailW >= 22 ? 6 : Math.max(2.5, textAvailW * 0.16);
              const padL = leftInset > 0 ? 2 : safeSidePad;
              const padR = rightInset > 0 ? 2 : safeSidePad;
              const innerAvailW = Math.max(5, textAvailW - padL - padR);
              const textCenterX = vi.x0 + leftInset + padL + innerAvailW / 2;
              const fitScale =
                vi.rich.width > innerAvailW
                  ? Math.max(0.72, Math.min(1, innerAvailW / vi.rich.width))
                  : 1;
              const drawY = ly + (lh - vi.rich.height * fitScale) / 2 + 1;
              const needsClip = tl.scaleMode === 'linear' || vi.rich.width * fitScale > innerAvailW + 0.5;
              if (needsClip) {
                const cid = `${pfx}ivc-${band.bandIndex}-${ti}-${ivClipCounter++}`;
                const icp = svgEl('clipPath', { id: cid }, defs);
                svgEl('rect', {
                  x: vi.x0 + Math.max(1, leftInset + padL - 0.5),
                  y: ly + 1,
                  width: Math.max(1, innerAvailW + 1),
                  height: Math.max(1, lh - 2)
                }, icp);
                const clipWrap = svgEl('g', { 'clip-path': `url(#${cid})` }, ivG);
                renderRichTextSVG(clipWrap, vi.rich, textCenterX, drawY, 'middle', 12.5, richStyle, fitScale, ivTextStyle);
              } else {
                renderRichTextSVG(ivG, vi.rich, textCenterX, drawY, 'middle', 12.5, richStyle, fitScale, ivTextStyle);
              }
            }
          }

          if (tierCustomBoundaries.size > 0) {
            const bndOverlayG = svgEl(
              'g',
              isExp ? {} : { 'pointer-events': 'none' },
              tG
            );
            for (const bnd of tierCustomBoundaries.values()) {
              const dash = dashArrayFor(bnd.style.strokeDash, sScale);
              svgEl(
                'line',
                {
                  x1: bnd.x,
                  y1: bnd.y0,
                  x2: bnd.x,
                  y2: bnd.y1,
                  stroke: bnd.style.strokeColor,
                  'stroke-width': sw(Math.max(0.5, bnd.style.strokeWidth)),
                  ...(dash ? { 'stroke-dasharray': dash } : {})
                },
                bndOverlayG
              );
            }
          }

          for (const ov of tl.meta.overlaps) {
            if (ov.xmax <= band.startT || ov.xmin >= band.endT) continue;
            const ox0 = ov.xmin <= band.startT ? band.originX : safeColX(ov.xmin);
            const ox1 = ov.xmax >= band.endT ? band.originX + band.bandContentW : safeColX(ov.xmax);
            svgEl('rect', { x: ox0, y: tl.y, width: Math.max(1, ox1 - ox0), height: tl.h, fill: `url(#${pfx}pat-ovl)`, ...(isExp ? {} : { 'pointer-events': 'none', 'data-legend-keys': 'overlap' }) }, tG);
          }

          for (const vz of tl.visibleZeros || []) {
            const zStyle = hasStyle ? resolveIntervalStyle(effectiveStyleDoc!, tg, ti, vz.iv.origIdx) : null;
            const zG = svgEl('g', isExp ? {} : { 'data-role': 'interval', 'data-tier': ti, 'data-idx': vz.iv.origIdx, 'data-band': band.bandIndex, 'data-legend-keys': 'zero-dur' }, tG);
            const cx = vz.x;
            const cy = tl.y + tl.h / 2;
            const zeroStroke = zStyle?.hasCustomBorder ? zStyle.borderColor : pal.isBw ? '#333333' : pal.amber;
            const zeroBg = zStyle?.hasCustomFill ? zStyle.fill : pal.zeroBg;
            svgEl('polygon', { points: `${cx},${tl.y} ${cx + 5},${cy} ${cx},${tl.y + tl.h} ${cx - 5},${cy}`, fill: pal.paper, stroke: zeroStroke, 'stroke-width': sw(1.3) }, zG);
            if (vz.rich) {
              const bw = vz.rich.width + 8;
              const bh = vz.rich.height + 4;
              const bandLeft = band.originX;
              const bandRight = band.originX + band.bandContentW;
              let bx = cx - bw / 2;
              if (bx + bw > bandRight) bx = bandRight - bw;
              if (bx < bandLeft) bx = bandLeft;
              svgEl('rect', { x: bx, y: cy - bh / 2, width: bw, height: bh, fill: zeroBg, stroke: zeroStroke, 'stroke-width': sw(1) }, zG);
              renderRichTextSVG(
                zG,
                vz.rich,
                bx + bw / 2,
                cy - vz.rich.height / 2,
                'middle',
                11,
                richStyle,
                1,
                zStyle?.hasCustom && zStyle.hasCustomText
                  ? { color: zStyle.textColor, fontWeight: zStyle.fontWeight, fontStyle: zStyle.fontStyle }
                  : null
              );
            }
          }

          if (!isExp && mode === 'edit') {
            const bSet = new Set<number>();
            const visIvs = tl.visibleIvs || [];
            const lastIntervalIdx = tier.intervals.length - 1;
            for (const vi of visIvs) {
              if (!vi.clippedLeft && vi.iv.xmin > tier.xmin && vi.iv.xmin < tier.xmax) bSet.add(vi.iv.xmin);
              if (!vi.clippedRight && vi.iv.xmax > tier.xmin && vi.iv.xmax < tier.xmax) bSet.add(vi.iv.xmax);
              // Allow grabbing outer tier.xmin / tier.xmax edge when flush interval is non-empty (pull-inward shrink)
              if (
                !vi.clippedLeft &&
                vi.iv.origIdx === 0 &&
                vi.iv.text.trim() !== '' &&
                Math.abs(vi.iv.xmin - tier.xmin) <= 1e-9
              ) {
                bSet.add(vi.iv.xmin);
              }
              if (
                !vi.clippedRight &&
                vi.iv.origIdx === lastIntervalIdx &&
                vi.iv.text.trim() !== '' &&
                Math.abs(vi.iv.xmax - tier.xmax) <= 1e-9
              ) {
                bSet.add(vi.iv.xmax);
              }
            }
            bSet.forEach((bt) => {
              const bx = safeColX(bt);
              const leftIv = visIvs.find((vi) => Math.abs(vi.iv.xmax - bt) < 1e-9);
              const rightIv = visIvs.find((vi) => Math.abs(vi.iv.xmin - bt) < 1e-9);
              const isOuterLeft = !leftIv && Math.abs(bt - tier.xmin) <= 1e-9;
              const isOuterRight = !rightIv && Math.abs(bt - tier.xmax) <= 1e-9;
              const leftHit = leftIv
                ? Math.min(leftIv.iv.text === '' ? 3 : 4.5, Math.max(1.5, leftIv.w * 0.25))
                : isOuterLeft
                  ? 5
                  : 3;
              const rightHit = rightIv
                ? Math.min(rightIv.iv.text === '' ? 3 : 4.5, Math.max(1.5, rightIv.w * 0.25))
                : isOuterRight
                  ? 5
                  : 3;
              const bHandle = svgEl('g', { 'data-role': 'boundary', 'data-tier': ti, 'data-time': String(bt), 'data-band': band.bandIndex, 'data-ui-only': '1' }, tG);
              svgEl('rect', { x: bx - leftHit, y: tl.y, width: leftHit + rightHit, height: tl.h, fill: 'transparent' }, bHandle);
              svgEl('line', { class: 'bnd-vis', x1: bx, y1: tl.y - 2, x2: bx, y2: tl.y + tl.h + 2, stroke: '#1D4ED8', 'stroke-width': 2.2 }, bHandle);
              svgEl('rect', { class: 'bnd-vis', x: bx - 2.5, y: tl.y - 3, width: 5, height: 3, fill: '#1D4ED8' }, bHandle);
              svgEl('rect', { class: 'bnd-vis', x: bx - 2.5, y: tl.y + tl.h, width: 5, height: 3, fill: '#1D4ED8' }, bHandle);
            });
          }
        }
      } else {
        const wy = tl.wireY!;
        const wireG = svgEl('g', isExp ? {} : { 'data-role': 'texttier-wire', 'data-tier': ti, 'data-band': band.bandIndex }, tG);
        if (domEndX > domStartX) {
          if (!isExp) svgEl('rect', { x: domStartX, y: wy - 9, width: domEndX - domStartX, height: 18, fill: 'transparent' }, wireG);
          svgEl('line', { x1: domStartX, y1: wy, x2: domEndX, y2: wy, stroke: pal.wire, 'stroke-width': sw(1.1) }, wireG);
        }

        const drawPts = [...(tl.visiblePts || [])].sort((a, b) => b.level - a.level);
        for (const vp of drawPts) {
          const pt = vp.pt;
          const px = vp.x;
          const isOutOfBounds = (Number.isFinite(tier.xmin) && pt.number < tier.xmin) || (Number.isFinite(tier.xmax) && pt.number > tier.xmax);
          const ptStyle = hasStyle ? resolvePointStyle(effectiveStyleDoc!, tg, ti, pt.origIdx) : null;
          const strokeCol = isOutOfBounds ? pal.amber : ptStyle?.hasCustom ? ptStyle.color : pal.ink;

          const pG = svgEl('g', isExp ? {} : {
            'data-role': 'point', 'data-tier': ti, 'data-idx': pt.origIdx, 'data-band': band.bandIndex,
            'data-legend-keys': vp.rich ? 'labeled-point' : 'empty-point'
          }, tG);
          if (!isExp) {
            svgEl('title', {}, pG).textContent = `${pt.mark ? pt.mark + '\n' : ''}${formatPraatDouble(pt.number)} s`;
          }
          if (!vp.rich) {
            if (!isExp) svgEl('rect', { x: px - 8, y: wy - 8, width: 16, height: 16, fill: 'transparent', 'data-ui-only': '1' }, pG);
            if (ptStyle?.hasCustom) {
              const r = Math.max(2, Math.min(10, ptStyle.size));
              renderPointMarkerSVG(pG, px, wy, ptStyle.shape, r, {
                fill: ptStyle.shape === 'cross' ? 'none' : pal.paper,
                stroke: strokeCol,
                strokeWidth: sw(ptStyle.shape === 'cross' ? 1.8 : 1.3),
                className: isExp ? undefined : 'pt-diamond hollow'
              });
            } else {
              svgEl('polygon', {
                ...(isExp ? {} : { class: 'pt-diamond hollow' }),
                points: `${px},${wy - 4.5} ${px + 4.5},${wy} ${px},${wy + 4.5} ${px - 4.5},${wy}`,
                fill: pal.paper, stroke: strokeCol, 'stroke-width': sw(1.3)
              }, pG);
            }
          } else {
            const boxY = tl.y + (tl.levelY?.[vp.level] || 0);
            const stemTargetX =
              vp.boxW >= 4
                ? Math.max(vp.bx + 1, Math.min(vp.bx + vp.boxW - 1, px))
                : vp.bx + vp.boxW / 2;
            if (!isExp) svgEl('rect', { x: px - 7, y: wy - 7, width: 14, height: 14, fill: 'transparent', 'data-ui-only': '1' }, pG);
            if (ptStyle?.hasCustom) {
              const r = Math.max(2, Math.min(10, ptStyle.size));
              const stemCol = isOutOfBounds ? pal.amber : ptStyle.stemColor;
              const stemDash = dashArrayFor(ptStyle.stemDash, sScale);
              svgEl(
                'line',
                {
                  ...(isExp ? {} : { class: 'pt-stem' }),
                  x1: px,
                  y1: wy + Math.max(2.5, r * 0.85),
                  x2: stemTargetX,
                  y2: boxY,
                  stroke: stemCol,
                  'stroke-width': sw(1),
                  ...(stemDash ? { 'stroke-dasharray': stemDash } : {})
                },
                pG
              );
              renderPointMarkerSVG(pG, px, wy, ptStyle.shape, r, {
                fill: ptStyle.shape === 'cross' ? 'none' : strokeCol,
                stroke: strokeCol,
                strokeWidth: sw(ptStyle.shape === 'cross' ? 1.8 : 0.8),
                className: isExp ? undefined : 'pt-diamond'
              });
              svgEl(
                'rect',
                {
                  ...(isExp ? {} : { class: 'pt-flag' }),
                  x: vp.bx,
                  y: boxY,
                  width: vp.boxW,
                  height: vp.boxH,
                  fill: pal.paper,
                  stroke: stemCol,
                  'stroke-width': sw(1)
                },
                pG
              );
              renderRichTextSVG(
                pG,
                vp.rich,
                vp.bx + vp.boxW / 2,
                boxY + (vp.boxH - vp.rich.height) / 2,
                'middle',
                11.5,
                richStyle,
                1,
                { color: ptStyle.textColor, fontWeight: ptStyle.fontWeight }
              );
            } else {
              svgEl('line', { ...(isExp ? {} : { class: 'pt-stem' }), x1: px, y1: wy + 3.5, x2: stemTargetX, y2: boxY, stroke: strokeCol, 'stroke-width': sw(1) }, pG);
              svgEl('polygon', { ...(isExp ? {} : { class: 'pt-diamond' }), points: `${px},${wy - 4} ${px + 4},${wy} ${px},${wy + 4} ${px - 4},${wy}`, fill: strokeCol, stroke: strokeCol, 'stroke-width': sw(0.8) }, pG);
              svgEl('rect', { ...(isExp ? {} : { class: 'pt-flag' }), x: vp.bx, y: boxY, width: vp.boxW, height: vp.boxH, fill: pal.paper, stroke: strokeCol, 'stroke-width': sw(1) }, pG);
              renderRichTextSVG(pG, vp.rich, vp.bx + vp.boxW / 2, boxY + (vp.boxH - vp.rich.height) / 2, 'middle', 11.5, richStyle);
            }
          }
        }
      }

      const tierHasValidSpanInBand = domEnd > domStart + 1e-12;
      const isZeroSpanTier =
        Number.isFinite(tier.xmin) &&
        Number.isFinite(tier.xmax) &&
        Math.abs(tier.xmax - tier.xmin) <= 1e-12;
      const showTierStartBracket =
        Number.isFinite(tier.xmin) &&
        tier.xmin !== tg.xmin &&
        ((tierHasValidSpanInBand && tier.xmin >= band.startT && tier.xmin < band.endT) ||
          (isZeroSpanTier &&
            (band.bandIndex === 0 ? tier.xmin >= band.startT : tier.xmin > band.startT) &&
            tier.xmin <= band.endT));
      const showTierEndBracket =
        Number.isFinite(tier.xmax) &&
        tier.xmax !== tg.xmax &&
        ((tierHasValidSpanInBand && tier.xmax > band.startT && tier.xmax <= band.endT) ||
          (isZeroSpanTier &&
            (band.bandIndex === 0 ? tier.xmax >= band.startT : tier.xmax > band.startT) &&
            tier.xmax <= band.endT));

      if (showTierStartBracket) {
        const cx = safeColX(tier.xmin);
        svgEl('path', { d: `M${cx + 5},${tl.y} L${cx},${tl.y} L${cx},${tl.y + tl.h} L${cx + 5},${tl.y + tl.h}`, fill: 'none', stroke: pal.isBw ? pal.ink : pal.amber, 'stroke-width': sw(2), ...(isExp ? {} : { 'data-legend-keys': 'ood' }) }, tG);
      }
      if (showTierEndBracket) {
        const cx = safeColX(tier.xmax);
        svgEl('path', { d: `M${cx - 5},${tl.y} L${cx},${tl.y} L${cx},${tl.y + tl.h} L${cx - 5},${tl.y + tl.h}`, fill: 'none', stroke: pal.isBw ? pal.ink : pal.amber, 'stroke-width': sw(2), ...(isExp ? {} : { 'data-legend-keys': 'ood' }) }, tG);
      }
    }

    // Shared aligned-time boundary overrides extending to acoustic zone
    if (hasStyle && effectiveStyleDoc) {
      for (const ov of effectiveStyleDoc.boundaryOverrides) {
        if (ov.tierIndex !== null || !ov.style.extendToAcoustic) continue;
        if (ov.time < band.startT - 1e-6 || ov.time > band.endT + 1e-6) continue;
        const resolved = resolveBoundaryStyle(effectiveStyleDoc, tg, -1, ov.time);
        if (!resolved.extendToAcoustic) continue;
        const gi = layout.tToIdx.get(ov.time);
        const elX =
          gi !== undefined && gi >= band.startIdx && gi <= band.endIdx
            ? band.spineCols[gi - band.startIdx].x
            : elasticXInBand(band, ov.time);
        recordAcousticExt(ov.time, elX, band.tiersBottomY, resolved);
      }
    }

    // Draw upward boundary reference lines through waveform / spectrogram acoustic area & any transition necks
    const hasAcousticArea = Boolean(
      hasAudio && (band.specH > 0 || band.waveH > 0 || (audioBuffer && band.linearH > 0))
    );
    if (hasAcousticArea && acousticExtMap.size > 0) {
      const acousticTopY = band.specH > 0 ? band.waveY : band.linearY;
      const extG = svgEl(
        'g',
        isExp ? (sem ? { id: `band-${bNum}-boundary-guides` } : {}) : { 'pointer-events': 'none' },
        bG
      );

      for (const ext of acousticExtMap.values()) {
        const dash = dashArrayFor(ext.style.strokeDash, sScale);
        const lineW = sw(Math.max(0.95, ext.style.strokeWidth));
        renderTimePolyline(extG, band, ext.time, acousticTopY, ext.tierTopY, {
          stroke: ext.style.strokeColor,
          strokeWidth: lineW,
          dashArray: dash,
          opacity: 0.78,
          neckStrokeWidth: sw(Math.max(0.85, ext.style.strokeWidth * 0.9)),
          neckOpacity: 0.72,
          tierStrokeWidth: sw(Math.max(0.85, ext.style.strokeWidth * 0.85)),
          tierOpacity: 0.55,
          dockOpacity: 0.72,
          hideTicks: layout.hideTicks
        });
      }
    }
  }

  // Linear Scale Bar
  if (
    isExp &&
    exportCtx?.showLinearScaleBar &&
    (layout.effectiveScaleMode === 'linear' || layout.effectiveScaleMode === 'mixed') &&
    layout.bands.length > 0
  ) {
    const lastBand = layout.bands[layout.bands.length - 1];
    const spec = exportCtx.computeScaleBar(lastBand);
    if (spec && spec.pxLen >= 16) {
      const sbG = svgEl('g', sem ? { id: 'export-scalebar' } : {}, svg);
      const yMid = lastBand.tiersBottomY + 13;
      const xRight = lastBand.originX + lastBand.bandContentW;
      const xLeft = Math.max(lastBand.originX, xRight - spec.pxLen);
      svgEl('line', { x1: xLeft, y1: yMid, x2: xRight, y2: yMid, stroke: pal.ink, 'stroke-width': sw(1.1) }, sbG);
      svgEl('line', { x1: xLeft, y1: yMid - 3.5, x2: xLeft, y2: yMid + 3.5, stroke: pal.ink, 'stroke-width': sw(1.1) }, sbG);
      svgEl('line', { x1: xRight, y1: yMid - 3.5, x2: xRight, y2: yMid + 3.5, stroke: pal.ink, 'stroke-width': sw(1.1) }, sbG);
      svgEl('text', { x: xLeft - 6, y: yMid + 3.5, 'text-anchor': 'end', 'font-family': monoFont, 'font-size': fs(9.5), fill: pal.muted }, sbG).textContent = spec.label;
    }
  }

  // Tier 2: Embedded Bottom Legend Bar
  if (isExp && layout.legendLayout) {
    renderEmbeddedLegendSVG(svg, layout.legendLayout, {
      pal,
      sScale,
      idPrefix: pfx,
      sansFontFamily: sansFont,
      ipaFontFamily: fontFamily,
      monoFontFamily: monoFont,
      symbolFontFamily: symbolFont
    });
  }

  // Auto Bottom Style Legend Bar
  if (styleLegendLayout && styleLegendLayout.entries.length > 0) {
    const slG = svgEl(
      'g',
      isExp
        ? sem
          ? { id: 'export-style-legend' }
          : {}
        : { id: 'style-legend-preview', 'pointer-events': 'none' },
      svg
    );
    svgEl(
      'line',
      {
        x1: styleLegendLayout.boxX,
        y1: styleLegendLayout.ruleY,
        x2: styleLegendLayout.boxX + styleLegendLayout.boxW,
        y2: styleLegendLayout.ruleY,
        stroke: pal.rule,
        'stroke-width': sw(0.75)
      },
      slG
    );

    for (const entry of styleLegendLayout.entries) {
      const { item, swatchX, swatchY, labelX, labelY } = entry;
      const w = styleLegendLayout.swatchW;
      const h = styleLegendLayout.swatchH;
      if (item.kind === 'point') {
        const cy = swatchY + h / 2;
        svgEl(
          'line',
          {
            x1: swatchX,
            y1: cy,
            x2: swatchX + w,
            y2: cy,
            stroke: pal.wire,
            'stroke-width': sw(0.9)
          },
          slG
        );
        const shape = item.pointShape ?? 'circle';
        renderPointMarkerSVG(slG, swatchX + w / 2, cy, shape, 3.4, {
          fill: shape === 'cross' ? 'none' : item.fill,
          stroke: item.borderColor,
          strokeWidth: sw(shape === 'cross' ? 1.5 : 0.9)
        });
      } else {
        const dash = dashArrayFor(item.borderDash, sScale);
        if (item.pattern !== 'none') {
          const patId = makeSvgPatternId(
            item.pattern,
            item.fill,
            item.patternColor,
            item.fillOpacity,
            patPrefix
          );
          svgEl(
            'rect',
            {
              x: swatchX,
              y: swatchY,
              width: w,
              height: h,
              fill: `url(#${patId})`,
              stroke: item.borderColor,
              'stroke-width': sw(0.9),
              ...(dash ? { 'stroke-dasharray': dash } : {})
            },
            slG
          );
        } else {
          svgEl(
            'rect',
            {
              x: swatchX,
              y: swatchY,
              width: w,
              height: h,
              fill: item.fill,
              ...(item.fillOpacity < 0.999 ? { 'fill-opacity': item.fillOpacity } : {}),
              stroke: item.borderColor,
              'stroke-width': sw(0.9),
              ...(dash ? { 'stroke-dasharray': dash } : {})
            },
            slG
          );
        }
      }
      svgEl(
        'text',
        {
          x: labelX,
          y: labelY,
          'text-anchor': 'start',
          'font-family': sansFont,
          'font-size': String(styleLegendLayout.itemFontSize),
          fill: pal.ink
        },
        slG
      ).textContent = item.label;
    }
  }

  // Tail embedded spectrogram <defs>
  if (isExp && embeddedSpecDefs.length > 0) {
    const tailDefs = svgEl('defs', { id: 'embedded-spectrograms' }, svg);
    for (const item of embeddedSpecDefs) {
      svgEl('image', { id: item.id, width: item.width, height: item.height, preserveAspectRatio: 'none', href: item.href }, tailDefs);
    }
  }

  if (!isExp) {
    const interG = svgEl('g', { id: 'interactive-layer', 'pointer-events': 'none' }, svg);
    svgEl('g', { id: 'hover-guide-layer' }, interG);
    const overlayG = svgEl('g', { id: 'selection-playhead-layer' }, interG);
    renderInteractiveOverlay(overlayG, layout, input);
  }
}
