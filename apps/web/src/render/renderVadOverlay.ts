import { xForTierTime, type BandLayout, type ScoreLayout } from '../layout/computeLayout';
import { svgEl } from '../layout/legendCore';

export interface VadPreviewSegmentItem {
  /** 0-based segment index in current preview list */
  index: number;
  /** Document-time start (seconds) */
  start: number;
  /** Document-time end (seconds) */
  end: number;
  /** True if user excluded this false-positive segment */
  excluded: boolean;
}

export interface VadOverlayState {
  active: boolean;
  segments: ReadonlyArray<VadPreviewSegmentItem>;
  activeSegmentIndex?: number | null;
  hoveredSegmentIndex?: number | null;
  /** Partial scope window in document time; when isPartial is true, outside area receives subtle shade */
  scope?: { start: number; end: number; isPartial: boolean } | null;
  /** Target tier index to project dashed boundaries onto (null = project subtly across all tiers) */
  targetTierIndex?: number | null;
  /** Show 16px p_vad probability curve + dynamic threshold dashed line at bottom of waveform */
  showProbabilityCurve?: boolean;
  /** Quantized 0..255 10ms probability array (neural pVad or classic normalized energy) */
  probCurve?: Uint8Array | null;
  /** Frame hop in ms (default 10) */
  probHopMs?: number;
  /** Audio-relative start sec of probCurve[0] (default 0) */
  probOriginSec?: number;
  /** Document audioOffset (docTime = audioTime + audioOffset) */
  audioOffset?: number;
  /** High trigger threshold in [0, 1] for horizontal dashed line */
  highProbTh?: number;
  /** Low hysteresis threshold in [0, 1] for subtle secondary dotted line */
  lowProbTh?: number;
}

const VAD_TEAL = '#0D9488';
const VAD_TEAL_DARK = '#0F766E';
const VAD_THRESH_AMBER = '#D97706';
const VAD_EXCLUDED_GRAY = '#6B7280';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 在单个折行 Band 内绘制 VAD 实时预览覆层：
 * 1. 局部作用窗外极淡遮罩与边界虚线；
 * 2. 青绿色半透明有声预览段（#0D9488）与被剔除段极淡灰虚线框（带 data-vad-seg-index 交互属性）；
 * 3. 目标区间层虚线边界投影与微弱填充提示；
 * 4. 波形区底部 16px 10ms 概率曲线与动态触发阈值水平虚线。
 */
export function renderVadPreviewOverlay(
  layerG: Element | null,
  band: BandLayout,
  _layout: ScoreLayout,
  state: VadOverlayState
): void {
  if (!layerG || !state.active) return;

  const bandG = svgEl(
    'g',
    {
      class: 'vad-overlay-band',
      'data-band-index': band.bandIndex
    },
    layerG
  );

  const bandRightX = band.originX + band.bandContentW;
  const hasAcousticZone = band.linearH > 2;
  const hasTiersZone = band.tiersBottomY > band.tiersTopY;

  // 1. Partial scope window exterior dim mask (respects per-tier linear/elastic scale in mixed mode)
  if (state.scope && state.scope.isPartial) {
    const scStart = state.scope.start;
    const scEnd = state.scope.end;

    const drawAcousticShade = (x0: number, x1: number) => {
      if (hasAcousticZone && x1 > x0 + 0.5) {
        svgEl(
          'rect',
          {
            x: x0,
            y: band.linearY,
            width: x1 - x0,
            height: band.linearH,
            fill: '#141413',
            'fill-opacity': 0.065,
            'pointer-events': 'none'
          },
          bandG
        );
      }
    };

    const drawTierShade = (y: number, h: number, x0: number, x1: number) => {
      if (h > 0.5 && x1 > x0 + 0.5) {
        svgEl(
          'rect',
          {
            x: x0,
            y,
            width: x1 - x0,
            height: h,
            fill: '#141413',
            'fill-opacity': 0.05,
            'pointer-events': 'none'
          },
          bandG
        );
      }
    };

    if (scEnd <= band.startT || scStart >= band.endT) {
      drawAcousticShade(band.originX, bandRightX);
      if (hasTiersZone) {
        drawTierShade(band.tiersTopY, band.tiersBottomY - band.tiersTopY, band.originX, bandRightX);
      }
    } else {
      if (scStart > band.startT) {
        const lx = band.linearXForTime(scStart);
        drawAcousticShade(band.originX, lx);
        if (hasAcousticZone) {
          svgEl(
            'line',
            {
              x1: lx,
              y1: band.linearY,
              x2: lx,
              y2: band.linearY + band.linearH,
              stroke: VAD_TEAL_DARK,
              'stroke-width': 1.1,
              'stroke-dasharray': '3 2',
              opacity: 0.65,
              'pointer-events': 'none'
            },
            bandG
          );
        }
        for (const tl of band.tiersLayout) {
          const tx = xForTierTime(band, tl.tierIndex, scStart);
          drawTierShade(tl.y, tl.h, band.originX, tx);
        }
      }
      if (scEnd < band.endT) {
        const lx = band.linearXForTime(scEnd);
        drawAcousticShade(lx, bandRightX);
        if (hasAcousticZone) {
          svgEl(
            'line',
            {
              x1: lx,
              y1: band.linearY,
              x2: lx,
              y2: band.linearY + band.linearH,
              stroke: VAD_TEAL_DARK,
              'stroke-width': 1.1,
              'stroke-dasharray': '3 2',
              opacity: 0.65,
              'pointer-events': 'none'
            },
            bandG
          );
        }
        for (const tl of band.tiersLayout) {
          const tx = xForTierTime(band, tl.tierIndex, scEnd);
          drawTierShade(tl.y, tl.h, tx, bandRightX);
        }
      }
    }
  }

  // Locate target tier layout inside this band (if specified)
  const targetTierLayout =
    state.targetTierIndex !== null && state.targetTierIndex !== undefined
      ? band.tiersLayout.find((tl) => tl.tierIndex === state.targetTierIndex) ?? null
      : null;

  // 2. Speech preview segments (acoustic band + mixed-scale-accurate tier dashed projection)
  for (const seg of state.segments) {
    if (seg.end <= band.startT || seg.start >= band.endT) continue;
    const visStart = Math.max(seg.start, band.startT);
    const visEnd = Math.min(seg.end, band.endT);
    if (visEnd <= visStart) continue;

    const lx0 = band.linearXForTime(visStart);
    const lx1 = band.linearXForTime(visEnd);
    const w = Math.max(1.5, lx1 - lx0);

    const isSelected = state.activeSegmentIndex === seg.index;
    const isHovered = state.hoveredSegmentIndex === seg.index;

    if (seg.excluded) {
      // Excluded segment: faint gray dashed box, clickable to restore (Alt+click) or audition
      if (hasAcousticZone) {
        svgEl(
          'rect',
          {
            class: 'vad-preview-seg is-excluded',
            x: lx0,
            y: band.linearY + 1,
            width: w,
            height: Math.max(2, band.linearH - 2),
            fill: VAD_EXCLUDED_GRAY,
            'fill-opacity': isHovered || isSelected ? 0.11 : 0.05,
            stroke: VAD_EXCLUDED_GRAY,
            'stroke-width': isSelected ? 1.25 : 0.9,
            'stroke-dasharray': '3 2.5',
            'stroke-opacity': 0.55,
            'data-vad-seg-index': seg.index,
            'data-vad-excluded': '1',
            style: 'pointer-events: all; cursor: pointer;'
          },
          bandG
        );
        if (w >= 18) {
          const cx = lx1 - 6.5;
          const cy = band.linearY + 7.5;
          svgEl(
            'path',
            {
              d: `M${cx - 2.5},${cy - 2.5} L${cx + 2.5},${cy + 2.5} M${cx + 2.5},${cy - 2.5} L${cx - 2.5},${cy + 2.5}`,
              stroke: VAD_EXCLUDED_GRAY,
              'stroke-width': 1.1,
              'stroke-linecap': 'round',
              opacity: 0.72,
              'pointer-events': 'none'
            },
            bandG
          );
        }
      }
      continue;
    }

    // Active (kept) speech segment
    if (hasAcousticZone) {
      const fillOpacity = isSelected ? 0.22 : isHovered ? 0.17 : 0.13;
      svgEl(
        'rect',
        {
          class: `vad-preview-seg${isSelected ? ' is-selected' : ''}`,
          x: lx0,
          y: band.linearY,
          width: w,
          height: band.linearH,
          fill: VAD_TEAL,
          'fill-opacity': fillOpacity,
          'data-vad-seg-index': seg.index,
          'data-vad-excluded': '0',
          style: 'pointer-events: all; cursor: pointer;'
        },
        bandG
      );

      // Top 2px teal accent bar
      svgEl(
        'rect',
        {
          x: lx0,
          y: band.linearY,
          width: w,
          height: isSelected ? 2.5 : 2,
          fill: VAD_TEAL,
          'fill-opacity': isSelected ? 0.95 : 0.75,
          'pointer-events': 'none'
        },
        bandG
      );

      // Crisp left/right boundaries inside acoustic zone
      if (seg.start >= band.startT) {
        svgEl(
          'line',
          {
            x1: lx0,
            y1: band.linearY,
            x2: lx0,
            y2: band.linearY + band.linearH,
            stroke: VAD_TEAL_DARK,
            'stroke-width': isSelected ? 1.5 : 1,
            opacity: isSelected ? 0.95 : 0.72,
            'pointer-events': 'none'
          },
          bandG
        );
      }
      if (seg.end <= band.endT) {
        svgEl(
          'line',
          {
            x1: lx1,
            y1: band.linearY,
            x2: lx1,
            y2: band.linearY + band.linearH,
            stroke: VAD_TEAL_DARK,
            'stroke-width': isSelected ? 1.5 : 1,
            opacity: isSelected ? 0.95 : 0.72,
            'pointer-events': 'none'
          },
          bandG
        );
      }

      // Compact index badge inside wide segments
      if (w >= 26 && seg.start >= band.startT) {
        const badge = svgEl(
          'text',
          {
            x: lx0 + 4,
            y: band.linearY + 11.5,
            fill: VAD_TEAL_DARK,
            'font-size': 9.5,
            'font-weight': isSelected ? 700 : 600,
            'font-family': 'var(--font-mono)',
            opacity: isSelected ? 0.96 : 0.8,
            'pointer-events': 'none'
          },
          bandG
        );
        badge.textContent = `#${seg.index + 1}`;
      }

      // Subtle neck bridge connecting linear acoustic span to first elastic/target tier span
      if (band.neckBotY > band.neckTopY + 1) {
        const neckTierIdx =
          targetTierLayout?.tierIndex ?? band.tiersLayout[0]?.tierIndex ?? -1;
        const neckBotX0 =
          neckTierIdx >= 0 ? xForTierTime(band, neckTierIdx, visStart) : lx0;
        const neckBotX1 =
          neckTierIdx >= 0 ? xForTierTime(band, neckTierIdx, visEnd) : lx1;
        svgEl(
          'polygon',
          {
            points: `${lx0},${band.neckTopY} ${lx1},${band.neckTopY} ${neckBotX1},${band.neckBotY} ${neckBotX0},${band.neckBotY}`,
            fill: VAD_TEAL,
            'fill-opacity': isSelected ? 0.14 : 0.07,
            'pointer-events': 'none'
          },
          bandG
        );
      }
    }

    // Target tier dashed boundary projection (strictly uses xForTierTime for linear/elastic/mixed accuracy)
    if (hasTiersZone) {
      const tiersToProject = targetTierLayout ? [targetTierLayout] : band.tiersLayout;
      for (const tl of tiersToProject) {
        const tx0 = xForTierTime(band, tl.tierIndex, visStart);
        const tx1 = xForTierTime(band, tl.tierIndex, visEnd);
        const tw = Math.max(1, tx1 - tx0);
        const isTarget = Boolean(targetTierLayout);

        if (isTarget) {
          svgEl(
            'rect',
            {
              x: tx0,
              y: tl.y + 0.5,
              width: tw,
              height: Math.max(1, tl.h - 1),
              fill: VAD_TEAL,
              'fill-opacity': isSelected ? 0.13 : 0.065,
              'pointer-events': 'none'
            },
            bandG
          );
        }

        const drawTierDashedEdge = (tx: number) => {
          svgEl(
            'line',
            {
              x1: tx,
              y1: tl.y,
              x2: tx,
              y2: tl.y + tl.h,
              stroke: VAD_TEAL,
              'stroke-width': isSelected ? 1.5 : 1.15,
              'stroke-dasharray': '3 2.5',
              opacity: isTarget ? (isSelected ? 0.95 : 0.82) : 0.45,
              'pointer-events': 'none'
            },
            bandG
          );
        };

        if (seg.start >= band.startT) drawTierDashedEdge(tx0);
        if (seg.end <= band.endT) drawTierDashedEdge(tx1);
      }
    }
  }

  // 3. Waveform bottom 16px p_vad probability curve + dynamic threshold dashed line
  if (
    state.showProbabilityCurve &&
    state.probCurve &&
    state.probCurve.length > 0 &&
    band.waveH >= 18
  ) {
    const probCurve = state.probCurve;
    const hopSec = (state.probHopMs && state.probHopMs > 0 ? state.probHopMs : 10) / 1000;
    const originSec = Number.isFinite(state.probOriginSec ?? 0) ? (state.probOriginSec ?? 0) : 0;
    const audioOffset = Number.isFinite(state.audioOffset ?? 0) ? (state.audioOffset ?? 0) : 0;

    const curveH = clamp(Math.round(band.waveH * 0.30), 12, 18);
    const baseY = band.waveY + band.waveH - 1;
    const bandAudioStart = band.startT - audioOffset;
    const bandAudioEnd = band.endT - audioOffset;
    const f0 = clamp(Math.floor((bandAudioStart - originSec) / hopSec), 0, probCurve.length - 1);
    const f1 = clamp(Math.ceil((bandAudioEnd - originSec) / hopSec), f0, probCurve.length - 1);

    if (f1 > f0) {
      // Subtle baseline
      svgEl(
        'line',
        {
          x1: band.originX,
          y1: baseY,
          x2: bandRightX,
          y2: baseY,
          stroke: VAD_TEAL,
          'stroke-width': 0.75,
          opacity: 0.24,
          'pointer-events': 'none'
        },
        bandG
      );

      // Peak-preserving downsampling to <= 260 points per band for crisp 60fps SVG rendering
      const frameSpan = f1 - f0 + 1;
      const maxPts = Math.min(260, Math.max(40, Math.round(band.bandContentW * 0.5)));
      const step = Math.max(1, Math.floor(frameSpan / maxPts));

      const pts: Array<[number, number]> = [];
      for (let f = f0; f <= f1; f += step) {
        const endBin = Math.min(f1, f + step - 1);
        let maxQ = 0;
        let peakFrame = f;
        for (let k = f; k <= endBin; k++) {
          const q = probCurve[k];
          if (q > maxQ) {
            maxQ = q;
            peakFrame = k;
          }
        }
        const tDoc = clamp(originSec + (peakFrame + 0.5) * hopSec + audioOffset, band.startT, band.endT);
        const x = band.linearXForTime(tDoc);
        const y = baseY - (maxQ / 255) * curveH;
        pts.push([x, y]);
      }

      if (pts.length >= 2) {
        const lineD = pts
          .map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
          .join(' ');
        const areaD = `${lineD} L${pts[pts.length - 1][0].toFixed(1)},${baseY.toFixed(1)} L${pts[0][0].toFixed(1)},${baseY.toFixed(1)} Z`;

        svgEl(
          'path',
          {
            d: areaD,
            fill: VAD_TEAL,
            'fill-opacity': 0.14,
            'pointer-events': 'none'
          },
          bandG
        );
        svgEl(
          'path',
          {
            d: lineD,
            fill: 'none',
            stroke: VAD_TEAL,
            'stroke-width': 1.15,
            'stroke-linejoin': 'round',
            opacity: 0.88,
            'pointer-events': 'none'
          },
          bandG
        );
      }

      // Dynamic high trigger threshold dashed line
      if (state.highProbTh !== undefined && Number.isFinite(state.highProbTh)) {
        const thY = baseY - clamp(state.highProbTh, 0, 1) * curveH;
        svgEl(
          'line',
          {
            x1: band.originX,
            y1: thY,
            x2: bandRightX,
            y2: thY,
            stroke: VAD_THRESH_AMBER,
            'stroke-width': 1,
            'stroke-dasharray': '4 2.5',
            opacity: 0.9,
            'pointer-events': 'none'
          },
          bandG
        );
      }

      // Subtle low hysteresis threshold dotted line
      if (state.lowProbTh !== undefined && Number.isFinite(state.lowProbTh)) {
        const lowY = baseY - clamp(state.lowProbTh, 0, 1) * curveH;
        svgEl(
          'line',
          {
            x1: band.originX,
            y1: lowY,
            x2: bandRightX,
            y2: lowY,
            stroke: VAD_TEAL_DARK,
            'stroke-width': 0.75,
            'stroke-dasharray': '2 2.5',
            opacity: 0.45,
            'pointer-events': 'none'
          },
          bandG
        );
      }
    }
  }
}

/**
 * 便捷批量入口：遍历 ScoreLayout 全部 Band 并叠加 VAD 预览覆层。
 */
export function renderVadPreviewOverlayAllBands(
  layerG: Element | null,
  layout: ScoreLayout,
  state: VadOverlayState
): void {
  if (!layerG || !state.active) return;
  for (const band of layout.bands) {
    renderVadPreviewOverlay(layerG, band, layout, state);
  }
}
