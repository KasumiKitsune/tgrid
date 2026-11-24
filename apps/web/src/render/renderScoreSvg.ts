import type { AudioAnalysisSummary, ContourPath, TextGrid } from '../bridge/types';
import {
  IPA_FONT_STACK,
  MONO_FONT_STACK,
  SANS_FONT_STACK,
  decodeTrigraphGlossSync,
  formatPraatDouble,
  measurePx,
  splitGraphemes,
  type RichTextLayout
} from '../layout/richText';
import {
  WARM_PALETTE,
  renderBand0AxisLabels,
  renderEmbeddedLegendSVG,
  svgEl,
  type ScorePalette
} from '../layout/legendCore';
import { elasticXInBand, type BandLayout, type ScoreLayout } from '../layout/computeLayout';

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
  y0: number;
  y1: number;
  cursorY?: number;
  snapX: number | null;
  snapMode?: boolean;
  snapLabel?: string | null;
  showCompactTag?: boolean;
  time: number;
}

export interface EdgeSnapVisual {
  x: number;
  linX: number;
  label: string;
}

export interface IntervalDragPreviewState {
  bandIndex: number;
  tierIndex: number;
  mode: 'create' | 'move';
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
  fontScale: number;
  strokeScale: number;
  trigraphMode: 'ipa-only' | 'dual' | 'raw-only';
  hideMetaSymbols: boolean;
  hideStretchCues: boolean;
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
}

export interface RenderScoreInput {
  tg: TextGrid;
  layout: ScoreLayout;
  hasAudio: boolean;
  audioBuffer: AudioBuffer | null;
  audioOffset: number;
  analysis: AudioAnalysisSummary | null;
  maxFreq: number;
  mode: 'read' | 'edit';
  selection: EditorSelection;
  playRange: { start: number; end: number } | null;
  currentTime: number;
  showPlayhead: boolean;
  dragPreview: DragPreviewState | null;
  intervalDragPreview?: IntervalDragPreviewState | null;
  screenSpecUrls?: Map<number, string>;
  exportCtx?: RenderScoreExportContext | null;
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
  styleOpts: { isExport: boolean; fontFamily: string; palette: ScorePalette; fontScale: number } | null
): void {
  if (!rich) return;
  const isExport = Boolean(styleOpts?.isExport);
  const fontFamily = styleOpts?.fontFamily || IPA_FONT_STACK;
  const pal = styleOpts?.palette || WARM_PALETTE;
  const fScale = styleOpts?.fontScale || 1;
  const effSize = Number((fontSize * fScale).toFixed(2));
  const glossSize = Number((9.5 * fScale).toFixed(2));
  const glossRawSize = Number((9 * fScale).toFixed(2));
  const textWrap = svgEl('g', isExport ? {} : { 'data-text-node': '1' }, parent);
  let curY = y;

  if (rich.gloss && !rich.glossIsRaw) {
    const gt = svgEl(
      'text',
      {
        x,
        y: curY + Math.round(9 * fScale),
        'text-anchor': align,
        'font-family': fontFamily,
        'font-size': String(glossSize),
        'font-style': 'italic',
        fill: pal.gloss,
        ...(isExport ? {} : { 'data-legend-keys': 'trigraph' })
      },
      textWrap
    );
    gt.textContent = rich.gloss;
    curY += rich.glossH;
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
        'xml:space': 'preserve'
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
      if (tok.kind === 'text') ts.setAttribute('fill', pal.ink);
      else if (tok.kind === 'wrap') {
        ts.setAttribute('fill', pal.isBw ? pal.meta : pal.faint);
        ts.setAttribute('font-size', String(Number((effSize - 1.5).toFixed(2))));
      } else if (tok.kind === 'ctrl') {
        ts.setAttribute('fill', pal.ctrl);
        ts.setAttribute('font-family', '"JetBrains Mono", Consolas, monospace');
        ts.setAttribute('font-size', String(glossSize));
      } else {
        ts.setAttribute('fill', pal.meta);
      }
    }
    curY += rich.lineH;
  }

  if (rich.gloss && rich.glossIsRaw) {
    const gt = svgEl(
      'text',
      {
        x,
        y: curY + Math.round(9 * fScale),
        'text-anchor': align,
        'font-family': MONO_FONT_STACK,
        'font-size': String(glossRawSize),
        fill: pal.gloss,
        opacity: '0.78',
        ...(isExport ? {} : { 'data-legend-keys': 'trigraph' })
      },
      textWrap
    );
    gt.textContent = rich.gloss;
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

export function renderInteractiveOverlay(
  layerG: Element | null,
  layout: ScoreLayout,
  input: Pick<
    RenderScoreInput,
    | 'selection'
    | 'playRange'
    | 'currentTime'
    | 'showPlayhead'
    | 'dragPreview'
    | 'intervalDragPreview'
    | 'hasAudio'
  >
): void {
  if (!layerG) return;
  while (layerG.firstChild) layerG.removeChild(layerG.firstChild);

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
          const elX = elasticXInBand(band, t);
          const isEnd = side === 'end';
          const mainOpacity = isEnd ? 0.94 : 0.78;
          const tierOpacity = isEnd ? 0.9 : 0.72;
          const capDir = isEnd ? -1 : 1;

          // 1. Vertical line through top acoustic/linear zone + subtle architectural bracket cap
          svgEl(
            'line',
            {
              x1: linX,
              y1: band.linearY - 2,
              x2: linX,
              y2: band.neckTopY,
              stroke: rangeColor,
              'stroke-width': 1.35,
              opacity: mainOpacity
            },
            layerG
          );
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

          // 2. Sloped projection line through the neck
          svgEl(
            'line',
            {
              x1: linX,
              y1: band.neckTopY,
              x2: elX,
              y2: band.neckBotY,
              stroke: rangeColor,
              'stroke-width': 1.35,
              opacity: mainOpacity
            },
            layerG
          );

          // 3. Vertical dashed projection line through spine and all annotation tiers
          svgEl(
            'line',
            {
              x1: elX,
              y1: band.neckBotY,
              x2: elX,
              y2: band.tiersBottomY + 4,
              stroke: rangeColor,
              'stroke-width': 1.35,
              'stroke-dasharray': '4 3',
              opacity: tierOpacity
            },
            layerG
          );
        }
      };

      drawRangeProjection(start, 'start');
      drawRangeProjection(end, 'end');
    }
  }

  const drawSelectionNeck = (band: BandLayout, t: number, color = '#1D4ED8') => {
    const linX = band.linearXForTime(t);
    const elX = elasticXInBand(band, t);
    const tickTopY = input.hasAudio && band.specH > 0 ? band.anchorY : band.linearY;
    svgEl(
      'line',
      {
        x1: linX,
        y1: tickTopY,
        x2: linX,
        y2: band.neckTopY,
        stroke: color,
        'stroke-width': 1.4,
        opacity: 0.85
      },
      layerG
    );
    svgEl(
      'line',
      {
        x1: linX,
        y1: band.neckTopY,
        x2: elX,
        y2: band.neckBotY,
        stroke: color,
        'stroke-width': 1.4,
        opacity: 0.85
      },
      layerG
    );
  };

  const isPlayRangeEdge = (t: number) =>
    Boolean(
      input.playRange &&
        Number.isFinite(input.playRange.start) &&
        Number.isFinite(input.playRange.end) &&
        input.playRange.end > input.playRange.start &&
        (Math.abs(input.playRange.start - t) <= 1e-6 || Math.abs(input.playRange.end - t) <= 1e-6)
    );

  const sel = input.selection;
  if (sel) {
    for (const band of layout.bands) {
      if (sel.kind === 'interval') {
        const tl = band.tiersLayout[sel.tierIndex];
        if (!tl) continue;
        for (const vi of tl.visibleIvs || []) {
          if (vi.iv.origIdx === sel.itemIndex) {
            if (!vi.clippedLeft && !isPlayRangeEdge(vi.iv.xmin)) {
              drawSelectionNeck(band, vi.iv.xmin, '#1D4ED8');
            }
            if (!vi.clippedRight && !isPlayRangeEdge(vi.iv.xmax)) {
              drawSelectionNeck(band, vi.iv.xmax, '#1D4ED8');
            }
            const ly = tl.y + (tl.laneOffsets?.[vi.iv.lane] || 0);
            const lh = tl.laneHeights?.[vi.iv.lane] || tl.h;
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
            drawSelectionNeck(band, vp.pt.number, '#1D4ED8');
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
        const idx = layout.tToIdx.get(sel.time);
        if (idx === undefined || idx < band.startIdx || idx > band.endIdx) continue;
        const bx = band.spineCols[idx - band.startIdx].x;
        drawSelectionNeck(band, sel.time, '#1D4ED8');
        svgEl('line', { x1: bx, y1: tl.y - 2, x2: bx, y2: tl.y + tl.h + 2, stroke: '#1D4ED8', 'stroke-width': 2.5 }, layerG);
      } else if (sel.kind === 'spine') {
        if (sel.time < band.startT || sel.time > band.endT) continue;
        const idx = layout.tToIdx.get(sel.time);
        const bx =
          idx !== undefined && idx >= band.startIdx && idx <= band.endIdx
            ? band.spineCols[idx - band.startIdx].x
            : elasticXInBand(band, sel.time);
        drawSelectionNeck(band, sel.time, '#1D4ED8');
        svgEl('line', { x1: bx, y1: band.tiersTopY - 6, x2: bx, y2: band.tiersBottomY, stroke: '#1D4ED8', 'stroke-width': 1.8 }, layerG);
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
    for (const band of layout.bands) {
      const inBand = (band.bandIndex === 0 ? t >= band.startT : t > band.startT) && t <= band.endT;
      if (!inBand && !(layout.bands.length === 1 && t === band.startT)) continue;
      const lx = band.linearXForTime(t);
      const ex = elasticXInBand(band, t);
      svgEl(
        'path',
        {
          d: `M${lx},${band.linearY - 2} L${lx},${band.neckTopY} L${ex},${band.neckBotY} L${ex},${band.tiersBottomY + 2}`,
          fill: 'none',
          stroke: '#B91C1C',
          'stroke-width': 1.6
        },
        layerG
      );
      svgEl(
        'polygon',
        { points: `${lx - 4},${band.linearY - 5} ${lx + 4},${band.linearY - 5} ${lx},${band.linearY}`, fill: '#B91C1C' },
        layerG
      );
    }
  }

  if (input.dragPreview) {
    const { bandIndex, x, linearX, y0, y1, cursorY, snapX, snapMode, snapLabel, showCompactTag, time } = input.dragPreview;
    const isSnapped = snapX !== null || Boolean(snapMode);
    const colStroke = isSnapped ? '#B45309' : '#1D4ED8';
    const band = layout.bands[bandIndex];
    if (band && Number.isFinite(linearX)) {
      if (band.specH > 0) {
        const gapY = Number.isFinite(cursorY)
          ? Math.max(band.specY + 14, Math.min(band.specY + band.specH - 14, cursorY!))
          : band.specY + band.specH * 0.5;
        const gapHalf = 14;
        svgEl('line', { x1: linearX, y1: band.waveY, x2: linearX, y2: Math.max(band.specY, gapY - gapHalf), stroke: colStroke, 'stroke-width': 1.4 }, layerG);
        svgEl('line', { x1: linearX, y1: Math.min(band.specY + band.specH, gapY + gapHalf), x2: linearX, y2: band.neckTopY, stroke: colStroke, 'stroke-width': 1.4 }, layerG);
        svgEl('line', { x1: linearX - 7, y1: gapY, x2: linearX - 3, y2: gapY, stroke: colStroke, 'stroke-width': 1.1 }, layerG);
        svgEl('line', { x1: linearX + 3, y1: gapY, x2: linearX + 7, y2: gapY, stroke: colStroke, 'stroke-width': 1.1 }, layerG);
        svgEl('line', { x1: linearX, y1: band.neckTopY, x2: x, y2: band.neckBotY, stroke: colStroke, 'stroke-width': 1.1, opacity: 0.8 }, layerG);
      } else {
        svgEl('line', { x1: linearX, y1: band.linearY, x2: linearX, y2: band.neckTopY, stroke: colStroke, 'stroke-width': 1.2, opacity: 0.85 }, layerG);
        svgEl('line', { x1: linearX, y1: band.neckTopY, x2: x, y2: band.neckBotY, stroke: colStroke, 'stroke-width': 1.1, opacity: 0.8 }, layerG);
      }
    }

    // Cross-tier magnetic alignment: amber solid full-height guide across ALL tiers in the band
    if (band && snapX !== null) {
      svgEl(
        'line',
        { x1: snapX, y1: band.neckBotY, x2: snapX, y2: band.tiersTopY, stroke: '#B45309', 'stroke-width': 1.2, opacity: 0.65 },
        layerG
      );
      svgEl(
        'line',
        { x1: snapX, y1: band.tiersTopY, x2: snapX, y2: band.tiersBottomY, stroke: '#B45309', 'stroke-width': 1.8 },
        layerG
      );
    } else {
      svgEl(
        'line',
        { x1: x, y1: y0, x2: x, y2: y1, stroke: colStroke, 'stroke-width': 1.8, 'stroke-dasharray': isSnapped ? 'none' : '3 2' },
        layerG
      );
    }

    // Compact coordinate & snap pill when micro-loupe isn't visible (no audio loaded or loupe toggled off)
    if (showCompactTag !== false) {
      const timeStr = formatPraatDouble(time);
      const txt = snapLabel ? `${timeStr} s · ${snapLabel}` : `${timeStr} s`;
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
      snapX,
      snapSide,
      snapLabel,
      text
    } = input.intervalDragPreview;
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
    const startColor = sSnap ? '#B45309' : '#1D4ED8';
    const endColor = eSnap ? '#B45309' : '#1D4ED8';
    const px0 = Math.min(x0, x1);
    const px1 = Math.max(x0, x1);
    const lx0 = Math.min(linX0, linX1);
    const lx1 = Math.max(linX0, linX1);
    const rectW = Math.max(1, px1 - px0);
    const rectH = Math.max(1, y1 - y0);

    if (band && Number.isFinite(lx0) && Number.isFinite(lx1)) {
      svgEl(
        'rect',
        {
          x: lx0,
          y: band.linearY,
          width: Math.max(1, lx1 - lx0),
          height: Math.max(1, band.neckTopY - band.linearY),
          fill: '#1D4ED8',
          opacity: 0.14
        },
        layerG
      );
      svgEl(
        'line',
        {
          x1: linX0,
          y1: band.linearY,
          x2: linX0,
          y2: band.neckTopY,
          stroke: startColor,
          'stroke-width': 1.4,
          opacity: 0.9
        },
        layerG
      );
      svgEl(
        'line',
        {
          x1: linX1,
          y1: band.linearY,
          x2: linX1,
          y2: band.neckTopY,
          stroke: endColor,
          'stroke-width': 1.4,
          opacity: 0.9
        },
        layerG
      );
      svgEl(
        'line',
        {
          x1: linX0,
          y1: band.neckTopY,
          x2: x0,
          y2: band.neckBotY,
          stroke: startColor,
          'stroke-width': 1.2,
          opacity: 0.82
        },
        layerG
      );
      svgEl(
        'line',
        {
          x1: linX1,
          y1: band.neckTopY,
          x2: x1,
          y2: band.neckBotY,
          stroke: endColor,
          'stroke-width': 1.2,
          opacity: 0.82
        },
        layerG
      );
    }

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

    const drawMagneticGuide = (guideX: number) => {
      if (!band) return;
      svgEl(
        'line',
        {
          x1: guideX,
          y1: band.neckBotY,
          x2: guideX,
          y2: band.tiersTopY,
          stroke: '#B45309',
          'stroke-width': 1.2,
          opacity: 0.65
        },
        layerG
      );
      svgEl(
        'line',
        {
          x1: guideX,
          y1: band.tiersTopY,
          x2: guideX,
          y2: band.tiersBottomY,
          stroke: '#B45309',
          'stroke-width': 1.6
        },
        layerG
      );
    };

    if (sSnap) drawMagneticGuide(sSnap.x);
    if (eSnap && (!sSnap || Math.abs(eSnap.x - sSnap.x) > 0.5)) drawMagneticGuide(eSnap.x);
    if (legacyOnlySnapX !== null) drawMagneticGuide(legacyOnlySnapX);

    const durMs = Math.max(0, Math.round((tEnd - tStart) * 1000));
    const baseTxt = `${formatPraatDouble(tStart)} – ${formatPraatDouble(tEnd)} s (${durMs} ms)`;
    const anySnap = Boolean(sSnap || eSnap || legacyOnlySnapX !== null);
    let snapSuffix = '';
    if (sSnap && eSnap) {
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
    const fy = Math.max(4, (anySnap && band ? Math.min(y0, band.tiersTopY) : y0) - 22);
    const isSnapped = anySnap || Boolean(snapLabel);
    svgEl('rect', { x: fx, y: fy, width: tw, height: 18, fill: isSnapped ? '#B45309' : '#141413' }, layerG);
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
  svg.setAttribute('width', String(layout.width));
  svg.setAttribute('height', String(layout.height));
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);

  const isExp = Boolean(exportCtx);
  const sem = Boolean(exportCtx?.semanticGroups);
  const pal = exportCtx?.palette || WARM_PALETTE;
  const pfx = isExp ? exportCtx?.idPrefix || '' : '';
  const transparentBg = Boolean(exportCtx?.transparentBg);
  const hideMeta = Boolean(exportCtx?.hideMetaSymbols);
  const hideStretch = Boolean(exportCtx?.hideStretchCues);
  const fScale = exportCtx?.fontScale || 1;
  const sScale = exportCtx?.strokeScale || 1;
  const fontFamily = exportCtx?.fontFamily || IPA_FONT_STACK;
  const richStyle = isExp ? { isExport: true, fontFamily, palette: pal, fontScale: fScale } : null;
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

  if (isExp && layout.legendLayout?.needsSpecGrad) {
    const lg = svgEl('linearGradient', { id: `${pfx}legend-spec-grad`, x1: '0%', y1: '0%', x2: '100%', y2: '0%' }, defs);
    svgEl('stop', { offset: '0%', 'stop-color': pal.isBw ? '#F5F5F5' : '#F4F2EC' }, lg);
    svgEl('stop', { offset: '55%', 'stop-color': pal.isBw ? '#8C8C8C' : '#8A877F' }, lg);
    svgEl('stop', { offset: '100%', 'stop-color': pal.isBw ? '#000000' : '#181715' }, lg);
  }

  if (!transparentBg) {
    const bgAttrs: Record<string, string | number> = { x: 0, y: 0, width: layout.width, height: layout.height, fill: pal.paper };
    if (isExp && sem) bgAttrs.id = 'export-backdrop';
    svgEl('rect', bgAttrs, svg);
  }

  if (isExp && exportCtx?.showCaption && layout.captionHeight > 0) {
    const capG = svgEl('g', sem ? { id: 'export-caption' } : {}, svg);
    const capY = layout.padTop + 12;
    const leftX = layout.padX;
    const rightX = layout.width - layout.padX;
    svgEl('text', { x: leftX, y: capY, 'text-anchor': 'start', 'font-family': SANS_FONT_STACK, 'font-size': fs(12), 'font-weight': '600', fill: pal.ink }, capG).textContent = exportCtx.captionTitle;
    svgEl('text', { x: rightX, y: capY, 'text-anchor': 'end', 'font-family': MONO_FONT_STACK, 'font-size': fs(10), fill: pal.muted }, capG).textContent = exportCtx.captionTimeText;
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
          const dotHalf = 1.1 * sScale;
          for (const frame of analysis.formantTrack) {
            if (frame.t < band.startT || frame.t > band.endT) continue;
            const seg = band.linearSegs.find((s) => frame.t >= s.t0 && frame.t <= s.t1);
            if (!seg || seg.collapsed) continue;
            const fx = band.linearXForTime(frame.t);
            for (const freq of frame.freqs) {
              if (freq > maxFreq) continue;
              const fy = band.specY + band.specH * (1 - freq / maxFreq);
              svgEl('rect', { x: fx - dotHalf, y: fy - dotHalf, width: dotHalf * 2, height: dotHalf * 2, fill: pal.formant }, formG);
            }
          }
        }

        // F0 Pitch contour
        if (!isExp || pitchOpacity > 0.001) {
          const pitchG = svgEl(
            'g',
            isExp
              ? { ...(sem ? { id: `band-${bNum}-pitch-f0` } : {}), ...(pitchOpacity < 0.999 ? { opacity: String(pitchOpacity) } : {}) }
              : { class: 'pitch-layer', 'data-legend-keys': 'pitch-f0' },
            specContent
          );
          let pathD = '';
          let penDown = false;
          const f0Ceil = analysis.f0Ceil || 500;
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
            const py = band.specY + band.specH - 8 - ((Math.max(65, Math.min(f0Ceil, p.f0)) - 65) / (f0Ceil - 65)) * (band.specH - 16);
            pathD += penDown ? ` L${px.toFixed(1)},${py.toFixed(1)}` : ` M${px.toFixed(1)},${py.toFixed(1)}`;
            penDown = true;
          }
          if (pathD) {
            svgEl('path', { d: pathD, fill: 'none', stroke: pal.pitchHalo, 'stroke-width': sw(3.2), 'stroke-linejoin': 'miter' }, pitchG);
            svgEl('path', { d: pathD, fill: 'none', stroke: pal.pitch, 'stroke-width': sw(1.5), 'stroke-linejoin': 'miter' }, pitchG);
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
        svgEl('line', { x1: lx, y1: band.specY, x2: lx, y2: band.specY + (isMajor ? 6 : 4), ...notchAttrs }, specContent);
        svgEl('line', { x1: lx, y1: band.specY + band.specH - (isMajor ? 6 : 4), x2: lx, y2: band.specY + band.specH, ...notchAttrs }, specContent);
      }

      for (const tl of band.tiersLayout) {
        if (!tl || tl.meta.kind !== 'textTier') continue;
        for (const vp of tl.visiblePts || []) {
          const lx = band.linearXForTime(vp.pt.number);
          svgEl('polygon', {
            points: `${lx},${band.specY - 3} ${lx + 3},${band.specY} ${lx},${band.specY + 3} ${lx - 3},${band.specY}`,
            fill: vp.rich ? pal.pitch : pal.paper,
            stroke: pal.pitch,
            'stroke-width': sw(1),
            ...(isExp ? {} : { 'data-legend-keys': vp.rich ? 'labeled-point' : 'empty-point' })
          }, specG);
        }
      }

      svgEl('rect', { x: band.originX, y: band.specY, width: band.bandContentW, height: band.specH, fill: 'none', stroke: pal.ink, 'stroke-width': sw(1) }, specG);

      // Frequency Axis Labels
      const compactAxis = band.gutterW < 64;
      const axisG = svgEl('g', isExp && sem ? { id: `band-${bNum}-axis` } : {}, bG);
      svgEl('line', { x1: band.originX - 3, y1: band.specY + 0.5, x2: band.originX, y2: band.specY + 0.5, stroke: pal.muted, 'stroke-width': sw(0.9) }, axisG);
      svgEl('line', { x1: band.originX - 3, y1: band.specY + band.specH - 0.5, x2: band.originX, y2: band.specY + band.specH - 0.5, stroke: pal.muted, 'stroke-width': sw(0.9) }, axisG);
      svgEl('text', { x: band.originX - 5.5, y: band.specY + 7, 'text-anchor': 'end', 'font-family': MONO_FONT_STACK, 'font-size': fs(8.5), fill: pal.muted }, axisG).textContent = compactAxis ? `${maxFreq / 1000}k` : `${maxFreq / 1000} kHz`;
      svgEl('text', { x: band.originX - 5.5, y: band.specY + band.specH - 1, 'text-anchor': 'end', 'font-family': MONO_FONT_STACK, 'font-size': fs(8.5), fill: pal.muted }, axisG).textContent = compactAxis ? '0' : '0 Hz';

      // F0 Range Readout
      if (analysis && band.bandContentW >= 90 && (!isExp || pitchOpacity > 0.001)) {
        const f0Ceil = analysis.f0Ceil || 500;
        const f0Lbl = `F0 65–${f0Ceil} Hz`;
        const f0LblW = Math.ceil(measurePx(f0Lbl, `${(8.5 * fScale).toFixed(1)}px ${MONO_FONT_STACK}`)) + 8;
        const f0BoxX = band.originX + band.bandContentW - f0LblW - 4;
        const f0BoxY = band.specY + 4;
        const f0AxisG = svgEl(
          'g',
          isExp ? (pitchOpacity < 0.999 ? { opacity: String(pitchOpacity) } : {}) : { class: 'pitch-layer', 'data-legend-keys': 'pitch-f0' },
          specG
        );
        svgEl('rect', { x: f0BoxX, y: f0BoxY, width: f0LblW, height: Math.round(13 * fScale), fill: pal.paper, 'fill-opacity': '0.86', stroke: pal.pitch, 'stroke-opacity': '0.28', 'stroke-width': '0.6' }, f0AxisG);
        svgEl('text', { x: f0BoxX + f0LblW - 4, y: f0BoxY + Math.round(9.5 * fScale), 'text-anchor': 'end', 'font-family': MONO_FONT_STACK, 'font-size': fs(8.5), fill: pal.pitch }, f0AxisG).textContent = f0Lbl;
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
        bNum
      });
    }

    // B. Projection Neck
    const neckG = svgEl('g', isExp && sem ? { id: `band-${bNum}-neck` } : {}, bG);
    if (layout.scaleMode !== 'linear' && !hideStretch) {
      for (const seg of band.linearSegs) {
        if (!seg.isStretched) continue;
        const c0 = band.spineCols[seg.globalIdx - band.startIdx];
        const c1 = band.spineCols[seg.globalIdx + 1 - band.startIdx];
        if (!c0 || !c1) continue;
        svgEl('polygon', {
          points: `${seg.x0},${band.neckTopY} ${seg.x1},${band.neckTopY} ${c1.x},${band.neckBotY} ${c0.x},${band.neckBotY}`,
          fill: pal.isBw ? '#E5E5E5' : pal.amber,
          opacity: pal.isBw ? 0.85 : 0.065,
          ...(isExp ? {} : { 'data-legend-keys': 'stretch' })
        }, neckG);
      }
    }
    for (let i = 0; i < band.spineCols.length; i++) {
      const col = band.spineCols[i];
      const lx = lxs[i];
      const isMajor =
        col.usage >= 2 ||
        col.t === tg.xmin ||
        col.t === tg.xmax ||
        i === 0 ||
        i === band.spineCols.length - 1;
      const minLinGap = minLinGapAt(i);
      const slant = Math.abs(col.x - lx);
      const isUltraDenseMinor = !isMajor && (minLinGap < 8 || (avgLinGap < 12 && slant > 16));
      const isModDenseMinor = !isMajor && !isUltraDenseMinor && (avgLinGap < 22 || minLinGap < 14);

      if (!hasAudio || band.specH === 0) {
        svgEl(
          'line',
          {
            x1: lx,
            y1: band.linearY,
            x2: lx,
            y2: band.neckTopY,
            stroke: isMajor ? pal.ink : pal.faint,
            'stroke-width': sw(isMajor ? 1 : 0.7),
            opacity: isUltraDenseMinor ? 0.45 : hasAudio ? 0.45 : 0.75
          },
          neckG
        );
      } else {
        const ancAttrs: Record<string, string | number> = {
          x1: lx,
          y1: band.anchorY,
          x2: lx,
          y2: band.neckTopY,
          stroke: isMajor ? pal.ink : pal.faint,
          'stroke-width': sw(isMajor ? 1 : 0.7)
        };
        if (isUltraDenseMinor) ancAttrs.opacity = 0.45;
        svgEl('line', ancAttrs, neckG);
      }

      if (isMajor) {
        svgEl(
          'line',
          {
            x1: lx,
            y1: band.neckTopY,
            x2: col.x,
            y2: band.neckBotY,
            stroke: pal.faint,
            'stroke-width': sw(0.9)
          },
          neckG
        );
      } else if (isUltraDenseMinor) {
        svgEl(
          'line',
          {
            x1: lx,
            y1: band.neckTopY,
            x2: lx,
            y2: band.neckTopY + 3.5,
            stroke: pal.rule,
            'stroke-width': sw(0.65),
            opacity: 0.55
          },
          neckG
        );
        svgEl(
          'line',
          {
            x1: col.x,
            y1: band.neckBotY - 3.5,
            x2: col.x,
            y2: band.neckBotY,
            stroke: pal.rule,
            'stroke-width': sw(0.65),
            opacity: 0.55
          },
          neckG
        );
      } else if (isModDenseMinor) {
        svgEl(
          'line',
          {
            x1: lx,
            y1: band.neckTopY,
            x2: col.x,
            y2: band.neckBotY,
            stroke: pal.rule,
            'stroke-width': sw(0.55),
            opacity: 0.36
          },
          neckG
        );
      } else {
        svgEl(
          'line',
          {
            x1: lx,
            y1: band.neckTopY,
            x2: col.x,
            y2: band.neckBotY,
            stroke: pal.rule,
            'stroke-width': sw(0.7)
          },
          neckG
        );
      }
    }

    // C. Timestamp Spine
    const spineG = svgEl('g', isExp && sem ? { id: `band-${bNum}-axis-time` } : {}, bG);
    let lastVisibleTickStr: string | null = null;
    for (let i = 0; i < band.spineCols.length; i++) {
      const col = band.spineCols[i];
      const prevCol = i > 0 ? band.spineCols[i - 1] : null;
      const isGlobalStart = col.t === tg.xmin;
      const isGlobalEnd = col.t === tg.xmax;
      const isMajor = col.usage >= 2 || isGlobalStart || isGlobalEnd;
      const exactTooltip = `${formatPraatDouble(col.t)} s`;

      if (!hideStretch && prevCol && col.t - prevCol.t > 0 && col.t - prevCol.t < 0.005) {
        svgEl('rect', {
          x: prevCol.x, y: band.tiersTopY - 4, width: col.x - prevCol.x, height: 3, fill: pal.microWarn,
          ...(isExp ? {} : { 'data-legend-keys': 'micro-seg' })
        }, spineG);
      }

      svgEl('line', { x1: col.x, y1: band.tiersTopY - 5, x2: col.x, y2: band.tiersTopY, stroke: isMajor ? pal.ink : pal.tickMinor, 'stroke-width': sw(isMajor ? 1.3 : 0.9) }, spineG);

      if (isGlobalStart && isGlobalEnd) {
        svgEl('path', { d: `M${col.x - 4},${band.tiersTopY - 7} L${col.x + 4},${band.tiersTopY - 7} M${col.x - 4},${band.tiersTopY - 7} L${col.x - 4},${band.tiersTopY} M${col.x + 4},${band.tiersTopY - 7} L${col.x + 4},${band.tiersTopY}`, fill: 'none', stroke: pal.ink, 'stroke-width': sw(1.4) }, spineG);
      } else if (isGlobalStart) {
        svgEl('path', { d: `M${col.x + 4},${band.tiersTopY - 6} L${col.x},${band.tiersTopY - 6} L${col.x},${band.tiersTopY}`, fill: 'none', stroke: pal.ink, 'stroke-width': sw(1.5) }, spineG);
      } else if (isGlobalEnd) {
        svgEl('path', { d: `M${col.x - 4},${band.tiersTopY - 6} L${col.x},${band.tiersTopY - 6} L${col.x},${band.tiersTopY}`, fill: 'none', stroke: pal.ink, 'stroke-width': sw(1.5) }, spineG);
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
            y: band.tiersTopY - 8,
            transform: `rotate(-52, ${col.x + 1}, ${band.tiersTopY - 8})`,
            'text-anchor': 'start',
            'font-family': MONO_FONT_STACK,
            'font-size': fs(10.5)
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
          svgEl('rect', { x: col.x - 1, y: band.tiersTopY - 7.5, width: 2, height: 2, fill: isMajor ? pal.muted : pal.faintTick }, spineG);
        } else {
          const hitG = svgEl('g', { 'data-role': 'spine-tick', 'data-time': String(col.t), 'data-band': band.bandIndex }, spineG);
          svgEl('title', {}, hitG).textContent = exactTooltip;
          svgEl('rect', { x: col.x - 4, y: band.tiersTopY - 14, width: 8, height: 14, fill: 'transparent', 'data-ui-only': '1' }, hitG);
          svgEl('rect', { x: col.x - 1, y: band.tiersTopY - 7.5, width: 2, height: 2, fill: isMajor ? pal.muted : pal.faintTick }, hitG);
        }
      }

      svgEl('line', {
        x1: col.x, y1: band.tiersTopY, x2: col.x, y2: band.tiersBottomY,
        stroke: isMajor ? pal.gridMajor : pal.gridMinor,
        'stroke-width': sw(isMajor ? 0.9 : 0.7),
        'stroke-dasharray': isMajor ? 'none' : '2 2',
        ...(isExp ? {} : { 'data-legend-keys': 'boundaries' })
      }, spineG);
    }

    for (const ptTick of band.isolatedPointTicks) {
      const exactTooltip = `${formatPraatDouble(ptTick.t)} s`;
      svgEl(
        'line',
        {
          x1: ptTick.x,
          y1: band.tiersTopY - 4,
          x2: ptTick.x,
          y2: band.tiersTopY,
          stroke: pal.tickMinor,
          'stroke-width': sw(0.8)
        },
        spineG
      );
      if (!layout.hideTicks) {
        if (ptTick.labelVisible) {
          const tAttrs: Record<string, string | number> = {
            x: ptTick.x + 1,
            y: band.tiersTopY - 8,
            transform: `rotate(-52, ${ptTick.x + 1}, ${band.tiersTopY - 8})`,
            'text-anchor': 'start',
            'font-family': MONO_FONT_STACK,
            'font-size': fs(9.5),
            fill: pal.muted
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
              y: band.tiersTopY - 7.5,
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
              y: band.tiersTopY - 14,
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
              y: band.tiersTopY - 7.5,
              width: 2,
              height: 2,
              fill: pal.faintTick
            },
            hitG
          );
        }
      }
      if (ptTick.labelVisible) {
        svgEl(
          'line',
          {
            x1: ptTick.x,
            y1: band.tiersTopY,
            x2: ptTick.x,
            y2: band.tiersBottomY,
            stroke: pal.gridMinor,
            'stroke-width': sw(0.65),
            'stroke-dasharray': '2 3',
            opacity: 0.45
          },
          spineG
        );
      }
    }

    // D. Multi-Tier Tracks
    for (const ti of band.displayOrder) {
      const tl = band.tiersLayout[ti];
      if (!tl) continue;
      const tier = tl.tier;
      const displayNum = tier.displayNum ?? ti + 1;
      const accent = pal.tierAccents[(displayNum - 1) % pal.tierAccents.length];
      const tierSlug = safeId(tier.name || `tier-${displayNum}`);
      const tG = svgEl('g', isExp ? (sem ? { id: `band-${bNum}-tier-${displayNum}-${tierSlug}` } : {}) : { 'data-tier': ti }, bG);

      // Left Tier Header
      const hb = tl.headerBox;
      const hdrG = svgEl('g', isExp ? {} : { 'data-role': 'tier-header', 'data-tier': ti, 'data-band': band.bandIndex }, tG);
      if (!isExp) {
        svgEl('title', {}, hdrG).textContent = `${displayNum}. ${tier.name || '(空层名)'} [${tier.kind === 'intervalTier' ? 'IntervalTier' : 'TextTier'}]`;
        svgEl('rect', { class: 'hdr-bg', x: hb.x, y: hb.y, width: hb.w, height: hb.h, fill: 'transparent' }, hdrG);
        svgEl('rect', { class: 'hdr-accent', x: hb.x, y: hb.y, width: 2.5, height: hb.h, fill: accent, 'data-ui-only': '1' }, hdrG);
      }

      const midY = tl.midY;
      const numRightX = hb.x + (layout.isTinyView ? 14 : 20);
      svgEl('text', {
        x: numRightX, y: midY + 4, 'text-anchor': 'end',
        'font-family': MONO_FONT_STACK, 'font-size': fs(layout.isTinyView ? 9.5 : 10.5), fill: pal.mutedAlt
      }, hdrG).textContent = String(displayNum);

      const gx = hb.x + (layout.isTinyView ? 19 : 27);
      if (tier.kind === 'intervalTier') {
        svgEl('rect', { x: gx, y: midY - 4.5, width: 12, height: 9, fill: transparentBg ? 'none' : pal.paper, stroke: accent, 'stroke-width': sw(1.2) }, hdrG);
        svgEl('line', { x1: gx + 6, y1: midY - 4.5, x2: gx + 6, y2: midY + 4.5, stroke: accent, 'stroke-width': sw(1.1) }, hdrG);
      } else {
        svgEl('line', { x1: gx - 1, y1: midY, x2: gx + 13, y2: midY, stroke: pal.wire, 'stroke-width': sw(1.1) }, hdrG);
        svgEl('polygon', { points: `${gx + 6},${midY - 3.5} ${gx + 9.5},${midY} ${gx + 6},${midY + 3.5} ${gx + 2.5},${midY}`, fill: pal.ink }, hdrG);
      }

      const nameX = gx + (layout.isTinyView ? 16 : 19);
      const maxNameW = hb.w - (nameX - hb.x) - 3;
      if (band.bandIndex === 0 || maxNameW >= 18) {
        const isPrimaryBand = band.bandIndex === 0;
        const nameWrap = svgEl('g', !isExp && isPrimaryBand ? { 'data-tier-name-node': ti } : {}, hdrG);
        if (tier.name === '') {
          if (!hideMeta) {
            svgEl('text', {
              x: nameX, y: midY + 4, 'font-family': SANS_FONT_STACK, 'font-size': fs(isPrimaryBand ? 11.5 : 10.5), fill: pal.meta, opacity: isPrimaryBand ? '1' : '0.75',
              ...(isExp ? {} : { 'data-legend-keys': 'meta-symbols' })
            }, nameWrap).textContent = '∅';
          }
        } else {
          const namePxSize = (isPrimaryBand || !layout.isTinyView ? 12 : 11) * fScale;
          const nameFont = `500 ${namePxSize.toFixed(2)}px ${SANS_FONT_STACK}`;
          const displayName = truncateTierNameMiddle(tier.name, maxNameW, nameFont);
          svgEl('text', {
            x: nameX, y: midY + 4, 'font-family': SANS_FONT_STACK,
            'font-size': String(Number(namePxSize.toFixed(2))), 'font-weight': '500',
            fill: isPrimaryBand ? pal.ink : pal.muted
          }, nameWrap).textContent = displayName;
        }
      }

      const safeColX = (t: number) => {
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
          for (const vi of tl.visibleIvs || []) {
            const iv = vi.iv;
            const ly = tl.y + (tl.laneOffsets?.[iv.lane] || 0);
            const lh = tl.laneHeights?.[iv.lane] || tl.h;
            const isEmpty = iv.text === '';

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
            if (cellBg !== 'none') svgEl('rect', { x: vi.x0, y: ly, width: vi.w, height: lh, fill: cellBg }, ivG);
            if (!isExp) svgEl('rect', { class: 'iv-hover', x: vi.x0, y: ly, width: vi.w, height: lh, fill: 'rgba(29, 78, 216, 0.055)', 'data-ui-only': '1' }, ivG);
            if (!isEmpty) svgEl('rect', { x: vi.x0, y: ly, width: vi.w, height: 2 * sScale, fill: accent, opacity: pal.isBw ? 0.85 : 0.72 }, ivG);

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

            if (isEmpty) {
              for (let c = band.startIdx; c < band.endIdx; c++) {
                if (!layout.colCollapsed[c]) continue;
                const ct0 = layout.spineT[c];
                const ct1 = layout.spineT[c + 1];
                if (iv.xmin <= ct0 && iv.xmax >= ct1) {
                  const mx = (band.spineCols[c - band.startIdx].x + band.spineCols[c + 1 - band.startIdx].x) / 2;
                  const my = ly + lh / 2;
                  const cpTarget = isExp ? ivG : svgEl('g', { 'data-legend-keys': 'collapsed-pause', 'pointer-events': 'none' }, ivG);
                  svgEl('line', { x1: mx - 4, y1: my + 5, x2: mx - 0.5, y2: my - 5, stroke: pal.anchorStroke, 'stroke-width': sw(1) }, cpTarget);
                  svgEl('line', { x1: mx + 1.5, y1: my + 5, x2: mx + 5, y2: my - 5, stroke: pal.anchorStroke, 'stroke-width': sw(1) }, cpTarget);
                }
              }
            }

            if (!vi.clippedLeft) {
              svgEl('line', { x1: vi.x0, y1: ly, x2: vi.x0, y2: ly + lh, stroke: pal.ink, 'stroke-width': sw(1.1) }, ivG);
            } else {
              const tieY = ly + lh / 2;
              const contTarget = isExp ? ivG : svgEl('g', { 'data-legend-keys': 'continuation', 'pointer-events': 'none' }, ivG);
              svgEl('polygon', { points: `${vi.x0},${tieY - 3.5} ${vi.x0 + 5},${tieY} ${vi.x0},${tieY + 3.5}`, fill: pal.mutedAlt }, contTarget);
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
                  svgEl('text', { x: vi.x0 + 8.5, y: tieY + 4, 'text-anchor': 'start', 'font-family': fontFamily, 'font-size': fs(11), 'font-style': 'italic', fill: pal.faint }, contTarget).textContent = ghostStr;
                  const railStart = vi.x0 + 8.5 + ghostW + 6;
                  const railEnd = vi.x1 - (vi.clippedRight ? 9 : 6);
                  if (railEnd - railStart >= 10) svgEl('line', { x1: railStart, y1: tieY, x2: railEnd, y2: tieY, stroke: pal.rule, 'stroke-width': sw(0.85), 'stroke-dasharray': '2 2' }, contTarget);
                  renderedGhost = true;
                }
              }
              if (!renderedGhost) {
                svgEl('line', { x1: vi.x0 + 2, y1: tieY - 1.5, x2: vi.x1 - 6, y2: tieY - 1.5, stroke: pal.faintTick, 'stroke-width': sw(0.9) }, contTarget);
                svgEl('line', { x1: vi.x0 + 2, y1: tieY + 1.5, x2: vi.x1 - 6, y2: tieY + 1.5, stroke: pal.faintTick, 'stroke-width': sw(0.9) }, contTarget);
              }
            }

            if (!vi.clippedRight) {
              svgEl('line', { x1: vi.x1, y1: ly, x2: vi.x1, y2: ly + lh, stroke: pal.ink, 'stroke-width': sw(1.1) }, ivG);
            } else {
              const tieY = ly + lh / 2;
              svgEl('polygon', {
                points: `${vi.x1 - 5},${tieY - 3.5} ${vi.x1},${tieY} ${vi.x1 - 5},${tieY + 3.5}`, fill: pal.mutedAlt,
                ...(isExp ? {} : { 'data-legend-keys': 'continuation', 'pointer-events': 'none' })
              }, ivG);
            }

            if (vi.rich) {
              const needsClip = layout.scaleMode === 'linear' || vi.rich.width > vi.w - 4;
              if (needsClip) {
                const cid = `${pfx}ivc-${band.bandIndex}-${ti}-${ivClipCounter++}`;
                const icp = svgEl('clipPath', { id: cid }, defs);
                svgEl('rect', { x: vi.x0 + 1, y: ly + 1, width: Math.max(1, vi.w - 2), height: Math.max(1, lh - 2) }, icp);
                const clipWrap = svgEl('g', { 'clip-path': `url(#${cid})` }, ivG);
                renderRichTextSVG(clipWrap, vi.rich, vi.x0 + vi.w / 2, ly + (lh - vi.rich.height) / 2 + 1, 'middle', 12.5, richStyle);
              } else {
                renderRichTextSVG(ivG, vi.rich, vi.x0 + vi.w / 2, ly + (lh - vi.rich.height) / 2 + 1, 'middle', 12.5, richStyle);
              }
            }
          }

          for (const ov of tl.meta.overlaps) {
            if (ov.xmax <= band.startT || ov.xmin >= band.endT) continue;
            const ox0 = ov.xmin <= band.startT ? band.originX : safeColX(ov.xmin);
            const ox1 = ov.xmax >= band.endT ? band.originX + band.bandContentW : safeColX(ov.xmax);
            svgEl('rect', { x: ox0, y: tl.y, width: Math.max(1, ox1 - ox0), height: tl.h, fill: `url(#${pfx}pat-ovl)`, ...(isExp ? {} : { 'pointer-events': 'none', 'data-legend-keys': 'overlap' }) }, tG);
          }

          for (const vz of tl.visibleZeros || []) {
            const zG = svgEl('g', isExp ? {} : { 'data-role': 'interval', 'data-tier': ti, 'data-idx': vz.iv.origIdx, 'data-band': band.bandIndex, 'data-legend-keys': 'zero-dur' }, tG);
            const cx = vz.x;
            const cy = tl.y + tl.h / 2;
            const zeroStroke = pal.isBw ? '#333333' : pal.amber;
            svgEl('polygon', { points: `${cx},${tl.y} ${cx + 5},${cy} ${cx},${tl.y + tl.h} ${cx - 5},${cy}`, fill: pal.paper, stroke: zeroStroke, 'stroke-width': sw(1.3) }, zG);
            if (vz.rich) {
              const bw = vz.rich.width + 8;
              const bh = vz.rich.height + 4;
              svgEl('rect', { x: cx - bw / 2, y: cy - bh / 2, width: bw, height: bh, fill: pal.zeroBg, stroke: zeroStroke, 'stroke-width': sw(1) }, zG);
              renderRichTextSVG(zG, vz.rich, cx, cy - vz.rich.height / 2, 'middle', 11, richStyle);
            }
          }

          if (!isExp && mode === 'edit') {
            const bSet = new Set<number>();
            const visIvs = tl.visibleIvs || [];
            for (const vi of visIvs) {
              if (!vi.clippedLeft && vi.iv.xmin > tier.xmin && vi.iv.xmin < tier.xmax) bSet.add(vi.iv.xmin);
              if (!vi.clippedRight && vi.iv.xmax > tier.xmin && vi.iv.xmax < tier.xmax) bSet.add(vi.iv.xmax);
            }
            bSet.forEach((bt) => {
              const bx = safeColX(bt);
              const leftIv = visIvs.find((vi) => Math.abs(vi.iv.xmax - bt) < 1e-9);
              const rightIv = visIvs.find((vi) => Math.abs(vi.iv.xmin - bt) < 1e-9);
              const leftHit = leftIv
                ? Math.min(leftIv.iv.text === '' ? 3 : 4.5, Math.max(1.5, leftIv.w * 0.25))
                : 3;
              const rightHit = rightIv
                ? Math.min(rightIv.iv.text === '' ? 3 : 4.5, Math.max(1.5, rightIv.w * 0.25))
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
          const strokeCol = isOutOfBounds ? pal.amber : pal.ink;

          const pG = svgEl('g', isExp ? {} : {
            'data-role': 'point', 'data-tier': ti, 'data-idx': pt.origIdx, 'data-band': band.bandIndex,
            'data-legend-keys': vp.rich ? 'labeled-point' : 'empty-point'
          }, tG);
          if (!isExp) {
            svgEl('title', {}, pG).textContent = `${pt.mark ? pt.mark + '\n' : ''}${formatPraatDouble(pt.number)} s`;
          }
          if (!vp.rich) {
            if (!isExp) svgEl('rect', { x: px - 8, y: wy - 8, width: 16, height: 16, fill: 'transparent', 'data-ui-only': '1' }, pG);
            svgEl('polygon', {
              ...(isExp ? {} : { class: 'pt-diamond hollow' }),
              points: `${px},${wy - 4.5} ${px + 4.5},${wy} ${px},${wy + 4.5} ${px - 4.5},${wy}`,
              fill: pal.paper, stroke: strokeCol, 'stroke-width': sw(1.3)
            }, pG);
          } else {
            const boxY = tl.y + (tl.levelY?.[vp.level] || 0);
            if (!isExp) svgEl('rect', { x: px - 7, y: wy - 7, width: 14, height: 14, fill: 'transparent', 'data-ui-only': '1' }, pG);
            svgEl('line', { ...(isExp ? {} : { class: 'pt-stem' }), x1: px, y1: wy + 3.5, x2: px, y2: boxY, stroke: strokeCol, 'stroke-width': sw(1) }, pG);
            svgEl('polygon', { ...(isExp ? {} : { class: 'pt-diamond' }), points: `${px},${wy - 4} ${px + 4},${wy} ${px},${wy + 4} ${px - 4},${wy}`, fill: strokeCol, stroke: strokeCol, 'stroke-width': sw(0.8) }, pG);
            svgEl('rect', { ...(isExp ? {} : { class: 'pt-flag' }), x: vp.bx, y: boxY, width: vp.boxW, height: vp.boxH, fill: pal.paper, stroke: strokeCol, 'stroke-width': sw(1) }, pG);
            renderRichTextSVG(pG, vp.rich, vp.bx + vp.boxW / 2, boxY + (vp.boxH - vp.rich.height) / 2, 'middle', 11.5, richStyle);
          }
        }
      }

      if (Number.isFinite(tier.xmin) && tier.xmin !== tg.xmin && tier.xmin >= band.startT && tier.xmin <= band.endT) {
        const cx = safeColX(tier.xmin);
        svgEl('path', { d: `M${cx + 5},${tl.y} L${cx},${tl.y} L${cx},${tl.y + tl.h} L${cx + 5},${tl.y + tl.h}`, fill: 'none', stroke: pal.isBw ? pal.ink : pal.amber, 'stroke-width': sw(2), ...(isExp ? {} : { 'data-legend-keys': 'ood' }) }, tG);
      }
      if (Number.isFinite(tier.xmax) && tier.xmax !== tg.xmax && tier.xmax >= band.startT && tier.xmax <= band.endT) {
        const cx = safeColX(tier.xmax);
        svgEl('path', { d: `M${cx - 5},${tl.y} L${cx},${tl.y} L${cx},${tl.y + tl.h} L${cx - 5},${tl.y + tl.h}`, fill: 'none', stroke: pal.isBw ? pal.ink : pal.amber, 'stroke-width': sw(2), ...(isExp ? {} : { 'data-legend-keys': 'ood' }) }, tG);
      }
    }
  }

  // Linear Scale Bar
  if (isExp && exportCtx?.showLinearScaleBar && layout.scaleMode === 'linear' && layout.bands.length > 0) {
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
      svgEl('text', { x: xLeft - 6, y: yMid + 3.5, 'text-anchor': 'end', 'font-family': MONO_FONT_STACK, 'font-size': fs(9.5), fill: pal.muted }, sbG).textContent = spec.label;
    }
  }

  // Tier 2: Embedded Bottom Legend Bar
  if (isExp && layout.legendLayout) {
    renderEmbeddedLegendSVG(svg, layout.legendLayout, { pal, sScale, idPrefix: pfx });
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
