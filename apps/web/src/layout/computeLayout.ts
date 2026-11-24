import type { AudioAnalysisSummary, Interval, LinearSeg, TextGrid, TextPoint, Tier } from '../bridge/types';
import {
  FONT_PT,
  FONT_TEXT,
  FONT_TICK,
  FONT_TIER,
  IPA_FONT_STACK,
  MONO_FONT_STACK,
  SANS_FONT_STACK,
  buildDisplayTickStrings,
  formatDisplayTick,
  layoutRichText,
  measurePx,
  type RichLayoutOptions,
  type RichTextLayout
} from './richText';
import {
  collectActiveLegendItems,
  computeLegendLayout,
  type EmbeddedLegendLayout,
  type LegendCatalogItem
} from './legendCore';

export type { RichTextLayout };

export interface PositionedInterval extends Interval {
  origIdx: number;
  lane: number;
}

export interface PositionedPoint extends TextPoint {
  origIdx: number;
}

export interface VisibleInterval {
  iv: PositionedInterval;
  x0: number;
  x1: number;
  w: number;
  clippedLeft: boolean;
  clippedRight: boolean;
  rich: RichTextLayout | null;
  linW: number;
  stretchRatio: number;
  isStretched: boolean;
}

export interface VisibleZero {
  iv: PositionedInterval;
  x: number;
  rich: RichTextLayout | null;
}

export interface VisiblePoint {
  pt: PositionedPoint;
  x: number;
  bx: number;
  rich: RichTextLayout | null;
  boxW: number;
  boxH: number;
  level: number;
}

export interface IntervalTierMeta {
  kind: 'intervalTier';
  normalIvs: PositionedInterval[];
  zeroIvs: PositionedInterval[];
  laneCount: number;
  gaps: Array<{ xmin: number; xmax: number }>;
  overlaps: Array<{ xmin: number; xmax: number }>;
  unrepairedEmpty: boolean;
}

export interface TextTierMeta {
  kind: 'textTier';
  finitePts: PositionedPoint[];
}

export type TierMeta = IntervalTierMeta | TextTierMeta;

export interface BoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TierLayout {
  tierIndex: number;
  tier: Tier;
  meta: TierMeta;
  y: number;
  h: number;
  midY: number;
  wireY?: number;
  headerBox: BoxRect;
  nameEditBox: BoxRect;
  laneOffsets?: number[];
  laneHeights?: number[];
  visibleIvs?: VisibleInterval[];
  visibleZeros?: VisibleZero[];
  visiblePts?: VisiblePoint[];
  levelY?: number[];
}

export interface SpineCol {
  globalIdx: number;
  t: number;
  x: number;
  label: string;
  usage: number;
  labelVisible: boolean;
}

export interface IsolatedPointTick {
  t: number;
  x: number;
  label: string;
  labelVisible: boolean;
}

export interface BandLinearSeg extends LinearSeg {
  globalIdx: number;
  collapsed: boolean;
  isStretched: boolean;
}

export interface BandLayout {
  bandIndex: number;
  startIdx: number;
  endIdx: number;
  startT: number;
  endT: number;
  gutterW: number;
  originX: number;
  bandContentW: number;
  linearY: number;
  linearH: number;
  waveY: number;
  waveH: number;
  specY: number;
  specH: number;
  anchorY: number;
  anchorH: number;
  neckTopY: number;
  neckBotY: number;
  tiersTopY: number;
  tiersBottomY: number;
  spineCols: SpineCol[];
  isolatedPointTicks: IsolatedPointTick[];
  linearSegs: BandLinearSeg[];
  linearXForTime: (t: number) => number;
  tiersLayout: TierLayout[];
  displayOrder: number[];
  finestIntervalTierIdx: number;
}

export interface ScoreLayout {
  width: number;
  height: number;
  padX: number;
  padTop: number;
  padBottom: number;
  captionHeight: number;
  scaleBarExtraH: number;
  hideTicks: boolean;
  isTinyView: boolean;
  scaleMode: 'elastic' | 'linear';
  legendItems: LegendCatalogItem[] | null;
  legendLayout: EmbeddedLegendLayout | null;
  spineT: number[];
  tToIdx: Map<number, number>;
  colCollapsed: boolean[];
  bands: BandLayout[];
}

export interface ComputeLayoutOptions {
  wrapMode: 'auto' | 'single';
  targetWidth: number;
  hasAudio: boolean;
  showSpectrogram?: boolean;
  tierOrder?: 'raw' | 'spec';
  scaleMode?: 'elastic' | 'linear';
  tickPrecision?: '2' | '3' | '4' | 'full' | 'none';
  tickFixedDecimals?: boolean;
  viewDomain?: { min: number; max: number } | null;
  mode?: 'read' | 'edit';
  marginPreset?: 'tight' | 'standard' | 'wide';
  captionHeight?: number;
  scaleBarExtraH?: number;
  richOpts?: RichLayoutOptions | null;
  fontScale?: number;
  legendConfig?: {
    mode: 'full' | 'compact' | 'off';
    lang: 'zh' | 'en';
    hasAudio: boolean;
    analysis: AudioAnalysisSummary | null;
    maxFreq: number;
    specStrategy: string;
    specOpacity: number;
    pitchOpacity: number;
    formantOpacity: number;
    trigraphMode: 'ipa-only' | 'dual' | 'raw-only';
    hideMetaSymbols: boolean;
    hideStretchCues: boolean;
  } | null;
}

export function computeLayout(tg: TextGrid, options: ComputeLayoutOptions): ScoreLayout {
  const {
    wrapMode,
    targetWidth,
    hasAudio,
    showSpectrogram = true,
    tierOrder = 'raw',
    scaleMode = 'elastic',
    tickPrecision = '3',
    tickFixedDecimals = false,
    viewDomain = null,
    mode = 'read',
    marginPreset = 'standard',
    captionHeight = 0,
    scaleBarExtraH = 0,
    richOpts = null,
    fontScale = 1,
    legendConfig = null
  } = options;

  const isLinear = scaleMode === 'linear';
  const showSpec = hasAudio && showSpectrogram;
  const isCompactView = targetWidth < 680;
  const isTinyView = targetWidth < 460;
  const basePadX = isTinyView ? 10 : isCompactView ? 14 : 24;
  const basePadTop = isTinyView ? 12 : 20;
  const basePadBot = isTinyView ? 16 : 24;
  const PAD_X = marginPreset === 'tight' ? 10 : marginPreset === 'wide' ? 36 : basePadX;
  const PAD_TOP = marginPreset === 'tight' ? 10 : marginPreset === 'wide' ? 28 : basePadTop;
  const PAD_BOTTOM = marginPreset === 'tight' ? 12 : marginPreset === 'wide' ? 32 : basePadBot;

  const WAVE_H = showSpec ? (isTinyView ? 20 : 24) : hasAudio ? 34 : 0;
  const SPEC_H = showSpec ? (isTinyView ? 88 : 108) : 0;
  const ANCHOR_H = showSpec ? 8 : 0;
  const LINEAR_H = showSpec ? WAVE_H + SPEC_H + ANCHOR_H : hasAudio ? 34 : 11;
  const NECK_H = isLinear ? 8 : 16;
  const TIER_GAP = 7;
  const BAND_GAP =
    marginPreset === 'tight' ? 20 : marginPreset === 'wide' ? 40 : isTinyView ? 24 : 32;
  const MIN_COL_W = isTinyView ? 17 : 19;
  const SILENCE_THRESHOLD = 1.6;
  const SILENCE_COLLAPSE_W = isTinyView ? 38 : 48;

  const fontFamily = richOpts?.fontFamily || IPA_FONT_STACK;
  const textFontMeasure =
    fontScale !== 1 || fontFamily !== IPA_FONT_STACK
      ? `${(12.5 * fontScale).toFixed(2)}px ${fontFamily}`
      : FONT_TEXT;
  const ptFontMeasure =
    fontScale !== 1 || fontFamily !== IPA_FONT_STACK
      ? `${(11.5 * fontScale).toFixed(2)}px ${fontFamily}`
      : FONT_PT;
  const tierFontMeasure =
    fontScale !== 1 ? `500 ${(12 * fontScale).toFixed(2)}px ${SANS_FONT_STACK}` : FONT_TIER;
  const tickFontMeasure =
    fontScale !== 1 ? `${(10.5 * fontScale).toFixed(2)}px ${MONO_FONT_STACK}` : FONT_TICK;
  const effectiveRichOpts = richOpts ? { ...richOpts, fontScale } : null;
  const hideTicks = tickPrecision === 'none';

  const hasViewSlice = Boolean(
    viewDomain &&
      Number.isFinite(viewDomain.min) &&
      Number.isFinite(viewDomain.max) &&
      viewDomain.max > viewDomain.min
  );
  const vMin = hasViewSlice ? viewDomain!.min : -Infinity;
  const vMax = hasViewSlice ? viewDomain!.max : Infinity;

  const tsSet = new Set<number>();
  const addTs = (t: number) => {
    if (Number.isFinite(t) && t >= vMin && t <= vMax) tsSet.add(t);
  };
  if (hasViewSlice) {
    tsSet.add(vMin);
    tsSet.add(vMax);
  } else {
    addTs(tg.xmin);
    addTs(tg.xmax);
  }
  for (const tier of tg.tiers) {
    addTs(tier.xmin);
    addTs(tier.xmax);
    if (tier.kind === 'intervalTier') {
      for (const iv of tier.intervals) {
        addTs(iv.xmin);
        addTs(iv.xmax);
      }
    }
  }
  if (tsSet.size <= 2) {
    const ptTimes: number[] = [];
    for (const tier of tg.tiers) {
      if (tier.kind !== 'textTier') continue;
      for (const pt of tier.points) {
        if (Number.isFinite(pt.number) && pt.number >= vMin && pt.number <= vMax) {
          ptTimes.push(pt.number);
        }
      }
    }
    ptTimes.sort((a, b) => a - b);
    let lastAdded = -Infinity;
    for (const t of ptTimes) {
      if (t - lastAdded >= 0.25) {
        tsSet.add(t);
        lastAdded = t;
      }
    }
  }

  const spineT = Array.from(tsSet).sort((a, b) => a - b);
  if (spineT.length === 0) spineT.push(0);
  const tToIdx = new Map<number, number>();
  spineT.forEach((t, i) => tToIdx.set(t, i));

  const spineUsage = new Array<number>(spineT.length).fill(0);
  for (const tier of tg.tiers) {
    const used = new Set<number>();
    if (Number.isFinite(tier.xmin) && tier.xmin !== tg.xmin && tToIdx.has(tier.xmin)) {
      used.add(tToIdx.get(tier.xmin)!);
    }
    if (Number.isFinite(tier.xmax) && tier.xmax !== tg.xmax && tToIdx.has(tier.xmax)) {
      used.add(tToIdx.get(tier.xmax)!);
    }
    if (tier.kind === 'intervalTier') {
      for (const iv of tier.intervals) {
        if (tToIdx.has(iv.xmin)) used.add(tToIdx.get(iv.xmin)!);
        if (tToIdx.has(iv.xmax)) used.add(tToIdx.get(iv.xmax)!);
      }
    } else {
      for (const pt of tier.points) {
        if (tToIdx.has(pt.number)) used.add(tToIdx.get(pt.number)!);
      }
    }
    used.forEach((idx) => {
      spineUsage[idx]++;
    });
  }

  let maxTierNameW = 28;
  for (const t of tg.tiers) {
    const w = t.name === '' ? 14 : measurePx(t.name, tierFontMeasure);
    if (w > maxTierNameW) maxTierNameW = w;
  }
  const gutterMin = isTinyView ? 68 : isCompactView ? 84 : 102;
  const gutterMax = isTinyView ? 92 : isCompactView ? 124 : 192;
  const GUTTER_FULL = Math.min(
    gutterMax,
    Math.max(gutterMin, Math.ceil((isTinyView ? 40 : 54) + maxTierNameW + 12))
  );
  const GUTTER_SUBSEQUENT = isTinyView ? 44 : GUTTER_FULL;

  const ANGLE_RAD = (52 * Math.PI) / 180;
  const tickStrings = hideTicks
    ? spineT.map(() => '')
    : buildDisplayTickStrings(spineT, tickPrecision, tickFixedDecimals);
  let maxTickW = 22;
  if (!hideTicks) {
    for (const s of tickStrings) {
      const w = measurePx(s, tickFontMeasure);
      if (w > maxTickW) maxTickW = w;
    }
  }
  const SPINE_H = hideTicks ? 8 : Math.ceil(maxTickW * Math.sin(ANGLE_RAD)) + 16;
  const RIGHT_OVERHANG = hideTicks
    ? 10
    : Math.min(isTinyView ? 22 : 52, Math.ceil(maxTickW * Math.cos(ANGLE_RAD)) + (isTinyView ? 8 : 16));

  const tierMeta: TierMeta[] = tg.tiers.map((tier) => {
    if (tier.kind === 'intervalTier') {
      const finiteIvs: PositionedInterval[] = tier.intervals
        .map((iv, idx) => ({ ...iv, origIdx: idx, lane: 0 }))
        .filter((iv) => Number.isFinite(iv.xmin) && Number.isFinite(iv.xmax))
        .sort((a, b) => a.xmin - b.xmin || a.xmax - b.xmax);

      const normalIvs: PositionedInterval[] = [];
      const zeroIvs: PositionedInterval[] = [];
      for (const iv of finiteIvs) (iv.xmin === iv.xmax ? zeroIvs : normalIvs).push(iv);

      const laneEnds: number[] = [];
      for (const iv of normalIvs) {
        let placed = -1;
        for (let l = 0; l < laneEnds.length; l++) {
          if (laneEnds[l] <= iv.xmin) {
            placed = l;
            break;
          }
        }
        if (placed === -1) {
          placed = laneEnds.length;
          laneEnds.push(iv.xmax);
        } else {
          laneEnds[placed] = iv.xmax;
        }
        iv.lane = placed;
      }
      const laneCount = Math.max(1, laneEnds.length);

      const gaps: Array<{ xmin: number; xmax: number }> = [];
      const overlaps: Array<{ xmin: number; xmax: number }> = [];
      if (normalIvs.length > 0 && Number.isFinite(tier.xmin) && Number.isFinite(tier.xmax)) {
        const pts: Array<{ t: number; d: number }> = [];
        for (const iv of normalIvs) {
          pts.push({ t: iv.xmin, d: 1 });
          pts.push({ t: iv.xmax, d: -1 });
        }
        pts.sort((a, b) => a.t - b.t || a.d - b.d);
        let curT = tier.xmin;
        let active = 0;
        let pi = 0;
        while (pi < pts.length) {
          const nextT = pts[pi].t;
          if (nextT > curT) {
            const segA = Math.max(curT, tier.xmin);
            const segB = Math.min(nextT, tier.xmax);
            if (segB > segA && active === 0) gaps.push({ xmin: segA, xmax: segB });
            if (active >= 2) overlaps.push({ xmin: curT, xmax: nextT });
          }
          while (pi < pts.length && pts[pi].t === nextT) {
            active += pts[pi].d;
            pi++;
          }
          curT = nextT;
        }
        if (curT < tier.xmax && active === 0) gaps.push({ xmin: curT, xmax: tier.xmax });
      }
      return {
        kind: 'intervalTier',
        normalIvs,
        zeroIvs,
        laneCount,
        gaps,
        overlaps,
        unrepairedEmpty: tier.intervals.length === 0
      };
    }

    const finitePts: PositionedPoint[] = tier.points
      .map((pt, idx) => ({ ...pt, origIdx: idx }))
      .filter((pt) => Number.isFinite(pt.number))
      .sort((a, b) => a.number - b.number);
    return { kind: 'textTier', finitePts };
  });

  const numCols = Math.max(0, spineT.length - 1);
  const colCollapsed = new Array<boolean>(numCols).fill(false);
  const dx = new Array<number>(numCols).fill(MIN_COL_W);
  const maxBandContentW = Math.max(120, targetWidth - PAD_X * 2 - GUTTER_FULL - RIGHT_OVERHANG);

  if (isLinear) {
    const totalSpanT = Math.max(1e-6, spineT[spineT.length - 1] - spineT[0]);
    const basePxPerSec = maxBandContentW / totalSpanT;
    const linearPxPerSec =
      wrapMode === 'single'
        ? basePxPerSec
        : Math.max(basePxPerSec, Math.min(480, Math.max(220, (numCols * 22) / totalSpanT)));
    for (let i = 0; i < numCols; i++) {
      dx[i] = Math.max(0, spineT[i + 1] - spineT[i]) * linearPxPerSec;
    }
  } else {
    for (let i = 0; i < numCols; i++) {
      const a = spineT[i];
      const b = spineT[i + 1];
      const dt = b - a;
      let hasActiveText = false;
      for (let ti = 0; ti < tg.tiers.length; ti++) {
        const tm = tierMeta[ti];
        if (tm.kind === 'intervalTier') {
          for (const iv of tm.normalIvs) {
            if (iv.xmin <= a && iv.xmax >= b && iv.text !== '') {
              hasActiveText = true;
              break;
            }
          }
        } else {
          for (const pt of tm.finitePts) {
            if (pt.number >= b) break;
            if (pt.number > a) {
              hasActiveText = true;
              break;
            }
          }
        }
        if (hasActiveText) break;
      }
      if (!hasActiveText && dt >= SILENCE_THRESHOLD) {
        colCollapsed[i] = true;
        dx[i] = SILENCE_COLLAPSE_W;
      } else {
        dx[i] = Math.max(MIN_COL_W, Math.round(14 + 54 * Math.pow(Math.max(dt, 0.001), 0.55)));
      }
    }

    const MAX_SINGLE_INTERVAL_W =
      wrapMode === 'single' ? 220 : Math.min(220, Math.max(84, Math.floor(maxBandContentW * 0.72)));

    tg.tiers.forEach((_tier, ti) => {
      const tm = tierMeta[ti];
      if (tm.kind === 'intervalTier') {
        for (const iv of tm.normalIvs) {
          if (iv.text === '') continue;
          const aIdx = tToIdx.get(Math.max(vMin, iv.xmin));
          const bIdx = tToIdx.get(Math.min(vMax, iv.xmax));
          if (aIdx === undefined || bIdx === undefined || bIdx <= aIdx) continue;
          let curSpanW = 0;
          for (let c = aIdx; c < bIdx; c++) curSpanW += dx[c];
          const unwrapped = layoutRichText(iv.text, 0, textFontMeasure, mode, effectiveRichOpts);
          const desiredW = Math.min(unwrapped.width + 22, Math.max(curSpanW, MAX_SINGLE_INTERVAL_W));
          if (curSpanW < desiredW) {
            const extra = desiredW - curSpanW;
            let useAll = true;
            for (let c = aIdx; c < bIdx; c++) {
              if (!colCollapsed[c]) {
                useAll = false;
                break;
              }
            }
            let totalWeight = 0;
            for (let c = aIdx; c < bIdx; c++) {
              if (!useAll && colCollapsed[c]) continue;
              totalWeight += Math.pow(Math.max(1e-4, spineT[c + 1] - spineT[c]), 0.85);
            }
            if (totalWeight > 0) {
              for (let c = aIdx; c < bIdx; c++) {
                if (!useAll && colCollapsed[c]) continue;
                const w = Math.pow(Math.max(1e-4, spineT[c + 1] - spineT[c]), 0.85);
                dx[c] += extra * (w / totalWeight);
              }
            }
          }
        }
      }
    });

    if (wrapMode === 'single' && numCols > 0) {
      let collapsedSum = 0;
      let activeSum = 0;
      for (let i = 0; i < numCols; i++) {
        if (colCollapsed[i]) collapsedSum += dx[i];
        else activeSum += dx[i];
      }
      const targetActive = maxBandContentW - collapsedSum;
      if (activeSum > 0 && targetActive > activeSum) {
        const factor = targetActive / activeSum;
        for (let i = 0; i < numCols; i++) {
          if (!colCollapsed[i]) dx[i] *= factor;
        }
      }
    }
  }

  let finestIntervalTierIdx = -1;
  let maxIvCount = -1;
  tg.tiers.forEach((t, ti) => {
    if (t.kind === 'intervalTier' && t.intervals.length > maxIvCount) {
      maxIvCount = t.intervals.length;
      finestIntervalTierIdx = ti;
    }
  });

  const displayOrder = tg.tiers.map((_, i) => i);
  if (showSpec && tierOrder === 'spec') {
    displayOrder.sort((a, b) => {
      const ta = tg.tiers[a];
      const tb = tg.tiers[b];
      const score = (t: Tier) => (t.kind === 'textTier' ? 1e6 + t.points.length : t.intervals.length);
      return score(tb) - score(ta) || a - b;
    });
  }

  const bands: Array<{ startIdx: number; endIdx: number }> = [];
  if (wrapMode === 'single' || numCols === 0) {
    bands.push({ startIdx: 0, endIdx: spineT.length - 1 });
  } else {
    const prefW = new Float64Array(numCols + 1);
    for (let i = 0; i < numCols; i++) {
      prefW[i + 1] = prefW[i] + dx[i];
    }

    const diff = new Float64Array(numCols + 1);
    for (let ti = 0; ti < tg.tiers.length; ti++) {
      const tm = tierMeta[ti];
      if (tm.kind !== 'intervalTier') continue;
      for (const iv of tm.normalIvs) {
        if (iv.xmax <= vMin || iv.xmin >= vMax) continue;
        const aIdx = iv.xmin < vMin ? 0 : tToIdx.get(Math.max(vMin, iv.xmin));
        const bIdx = iv.xmax > vMax ? numCols : tToIdx.get(Math.min(vMax, iv.xmax));
        if (aIdx !== undefined && bIdx !== undefined && bIdx - aIdx >= 2) {
          const w = iv.text !== '' ? 120 : 18;
          diff[aIdx + 1] += w;
          diff[bIdx] -= w;
        }
      }
    }
    const cutPenalty = new Float64Array(numCols + 1);
    let accPenalty = 0;
    for (let k = 1; k < numCols; k++) {
      accPenalty += diff[k];
      cutPenalty[k] = accPenalty;
    }

    const breakCost = new Float64Array(numCols + 1);
    for (let k = 1; k < numCols; k++) {
      breakCost[k] =
        cutPenalty[k] - Math.min(spineUsage[k], 4) * 10 - (colCollapsed[k - 1] ? 20 : 0);
    }

    const availW0 = maxBandContentW;
    const availWRest = Math.max(130, targetWidth - PAD_X * 2 - GUTTER_SUBSEQUENT - RIGHT_OVERHANG);

    if (prefW[numCols] <= availW0) {
      bands.push({ startIdx: 0, endIdx: numCols });
    } else {
      const estBands = Math.max(2, 1 + Math.ceil((prefW[numCols] - availW0) / availWRest));
      const targetFillRatio = Math.max(
        0.62,
        Math.min(0.92, prefW[numCols] / (availW0 + (estBands - 1) * availWRest))
      );
      const dp = new Float64Array(numCols + 1);
      dp.fill(Infinity);
      dp[numCols] = 0;
      const nextIdx = new Int32Array(numCols + 1);
      const BAND_BASE = 28;

      for (let i = numCols - 1; i >= 0; i--) {
        const avail = i === 0 ? availW0 : availWRest;
        let maxK = i + 1;
        while (maxK < numCols && prefW[maxK + 1] - prefW[i] <= avail) {
          maxK++;
        }
        let bestCost = Infinity;
        let bestK = maxK;
        for (let k = i + 1; k <= maxK; k++) {
          const runW = prefW[k] - prefW[i];
          const fill = runW / avail;
          let cost: number;
          if (k === numCols) {
            const shortage = i > 0 ? Math.max(0, targetFillRatio - fill) : 0;
            cost =
              BAND_BASE +
              (i > 0
                ? 160 * shortage * shortage + (fill < 0.45 ? 90 * (0.45 - fill) : 0)
                : 0);
          } else {
            const dev = Math.max(0, targetFillRatio - fill);
            const excess = Math.max(0, fill - targetFillRatio);
            const tinyGuard = fill < 0.38 && k < maxK ? 400 * Math.pow(0.38 - fill, 2) : 0;
            cost =
              BAND_BASE +
              breakCost[k] +
              220 * dev * dev +
              55 * Math.pow(1 - fill, 2) +
              35 * excess * excess +
              tinyGuard +
              dp[k];
          }
          if (cost < bestCost) {
            bestCost = cost;
            bestK = k;
          }
        }
        dp[i] = bestCost;
        nextIdx[i] = bestK;
      }

      let cur = 0;
      while (cur < numCols) {
        const next = nextIdx[cur] > cur && nextIdx[cur] <= numCols ? nextIdx[cur] : cur + 1;
        bands.push({ startIdx: cur, endIdx: next });
        cur = next;
      }
    }
  }

  let curY = PAD_TOP + captionHeight;
  let totalSvgW = 0;

  const bandLayouts: BandLayout[] = bands.map((b, bandIndex) => {
    const gutterW = bandIndex === 0 ? GUTTER_FULL : GUTTER_SUBSEQUENT;
    const originX = PAD_X + gutterW;
    const startT = spineT[b.startIdx];
    const endT = spineT[b.endIdx];

    const spineCols: SpineCol[] = [];
    let cx = originX;
    for (let i = b.startIdx; i <= b.endIdx; i++) {
      spineCols.push({
        globalIdx: i,
        t: spineT[i],
        x: cx,
        label: tickStrings[i],
        usage: spineUsage[i],
        labelVisible: false
      });
      if (i < b.endIdx) cx += dx[i];
    }
    const bandContentW = Math.max(40, cx - originX);
    const bandTotalW = originX + bandContentW + RIGHT_OVERHANG + PAD_X;
    if (bandTotalW > totalSvgW) totalSvgW = bandTotalW;
    const xForGlobalIdx = (gi: number) => spineCols[gi - b.startIdx].x;
    const elasticXLocal = (t: number) => {
      if (!spineCols.length) return originX;
      if (t <= spineCols[0].t) return spineCols[0].x;
      const last = spineCols[spineCols.length - 1];
      if (t >= last.t) return last.x;
      for (let i = 0; i < spineCols.length - 1; i++) {
        if (t >= spineCols[i].t && t <= spineCols[i + 1].t) {
          const dt = spineCols[i + 1].t - spineCols[i].t;
          return dt <= 0
            ? spineCols[i].x
            : spineCols[i].x + ((t - spineCols[i].t) / dt) * (spineCols[i + 1].x - spineCols[i].x);
        }
      }
      return originX;
    };

    const placedTickXs: number[] = [];
    if (!hideTicks) {
      const MIN_TICK_GAP = 15;
      const tickOrder = spineCols.map((col, idx) => {
        let prio = 0;
        if (col.t === tg.xmin || col.t === tg.xmax) prio = 3;
        else if (idx === 0 || idx === spineCols.length - 1) prio = 2;
        else if (col.usage >= 2) prio = 1;
        return { idx, x: col.x, prio };
      });
      tickOrder.sort((a, b2) => b2.prio - a.prio || a.idx - b2.idx);
      for (const item of tickOrder) {
        const minGap = item.prio >= 2 ? 12 : MIN_TICK_GAP;
        let collides = false;
        for (let p = 0; p < placedTickXs.length; p++) {
          if (Math.abs(item.x - placedTickXs[p]) < minGap) {
            collides = true;
            break;
          }
        }
        if (!collides || item.idx === 0) {
          spineCols[item.idx].labelVisible = true;
          placedTickXs.push(item.x);
        }
      }
    }

    const isoTimeSet = new Set<number>();
    for (let ti = 0; ti < tg.tiers.length; ti++) {
      const tm = tierMeta[ti];
      if (tm.kind !== 'textTier') continue;
      for (const pt of tm.finitePts) {
        const t = pt.number;
        if ((bandIndex === 0 ? t >= startT : t > startT) && t <= endT && !tToIdx.has(t)) {
          isoTimeSet.add(t);
        }
      }
    }
    const isoTimes = Array.from(isoTimeSet).sort((a, b2) => a - b2);
    const isoLabels: string[] = hideTicks
      ? isoTimes.map(() => '')
      : isoTimes.map((t) => formatDisplayTick(t, tickPrecision, tickFixedDecimals));
    if (!hideTicks && isoTimes.length > 0 && tickPrecision !== 'full') {
      const spineLabelSet = new Set<string>();
      for (const col of spineCols) spineLabelSet.add(col.label);
      const baseDigits = parseInt(tickPrecision, 10) || 3;
      for (let d = baseDigits + 1; d <= 6; d++) {
        const colliding = new Set<number>();
        for (let i = 0; i < isoTimes.length; i++) {
          if (spineLabelSet.has(isoLabels[i])) colliding.add(i);
          if (i > 0 && isoLabels[i] === isoLabels[i - 1]) {
            colliding.add(i - 1);
            colliding.add(i);
          }
        }
        if (colliding.size === 0) break;
        colliding.forEach((idx) => {
          isoLabels[idx] = formatDisplayTick(isoTimes[idx], String(d), tickFixedDecimals);
        });
      }
    }
    const isolatedPointTicks: IsolatedPointTick[] = [];
    for (let i = 0; i < isoTimes.length; i++) {
      const t = isoTimes[i];
      const x = elasticXLocal(t);
      const label = isoLabels[i];
      let collides = false;
      if (!hideTicks) {
        for (let p = 0; p < placedTickXs.length; p++) {
          if (Math.abs(x - placedTickXs[p]) < 15) {
            collides = true;
            break;
          }
        }
      }
      const labelVisible = !hideTicks && !collides;
      if (labelVisible) placedTickXs.push(x);
      isolatedPointTicks.push({ t, x, label, labelVisible });
    }

    const linearSegs: BandLinearSeg[] = [];
    if (b.endIdx > b.startIdx) {
      if (isLinear) {
        for (let i = b.startIdx; i < b.endIdx; i++) {
          linearSegs.push({
            globalIdx: i,
            t0: spineT[i],
            t1: spineT[i + 1],
            x0: xForGlobalIdx(i),
            x1: xForGlobalIdx(i + 1),
            collapsed: false,
            isStretched: false
          });
        }
      } else {
        let activeTime = 0;
        let collapsedCount = 0;
        for (let i = b.startIdx; i < b.endIdx; i++) {
          if (colCollapsed[i]) collapsedCount++;
          else activeTime += spineT[i + 1] - spineT[i];
        }
        const breakLinearW = collapsedCount > 0 ? Math.min(44, Math.max(24, bandContentW * 0.09)) : 0;
        const availLinearW = Math.max(20, bandContentW - breakLinearW * collapsedCount);
        let lx = originX;
        for (let i = b.startIdx; i < b.endIdx; i++) {
          const dt = spineT[i + 1] - spineT[i];
          const w = colCollapsed[i]
            ? breakLinearW
            : activeTime > 0
              ? (dt / activeTime) * availLinearW
              : availLinearW / Math.max(1, b.endIdx - b.startIdx - collapsedCount);
          const elasticW = dx[i];
          const isStretched =
            !colCollapsed[i] && w > 0.5 && elasticW / w > 1.6 && elasticW - w >= 8;
          linearSegs.push({
            globalIdx: i,
            t0: spineT[i],
            t1: spineT[i + 1],
            x0: lx,
            x1: lx + w,
            collapsed: colCollapsed[i],
            isStretched
          });
          lx += w;
        }
      }
    } else {
      linearSegs.push({
        globalIdx: b.startIdx,
        t0: startT,
        t1: endT,
        x0: originX,
        x1: originX + bandContentW,
        collapsed: false,
        isStretched: false
      });
    }

    const linearXForTime = (t: number) => {
      if (!linearSegs.length) return originX;
      if (t <= linearSegs[0].t0) return linearSegs[0].x0;
      const last = linearSegs[linearSegs.length - 1];
      if (t >= last.t1) return last.x1;
      for (const seg of linearSegs) {
        if (t >= seg.t0 && t <= seg.t1) {
          const dt = seg.t1 - seg.t0;
          return dt <= 0 ? seg.x0 : seg.x0 + ((t - seg.t0) / dt) * (seg.x1 - seg.x0);
        }
      }
      return originX;
    };

    const linearY = curY;
    const waveY = linearY;
    const specY = linearY + WAVE_H;
    const anchorY = specY + SPEC_H;
    const neckTopY = linearY + LINEAR_H;
    const neckBotY = neckTopY + NECK_H;
    const tiersTopY = neckBotY + SPINE_H;

    let ty = tiersTopY;
    const tiersLayout = new Array<TierLayout>(tg.tiers.length);
    for (const ti of displayOrder) {
      const tier = tg.tiers[ti];
      const tm = tierMeta[ti];
      if (tm.kind === 'intervalTier') {
        const visibleIvs: VisibleInterval[] = [];
        const baseLaneH = Math.round(32 * fontScale);
        const laneMaxH = new Array<number>(tm.laneCount).fill(baseLaneH);
        for (const iv of tm.normalIvs) {
          if (iv.xmax <= startT || iv.xmin >= endT) continue;
          const clippedLeft = iv.xmin < startT;
          const clippedRight = iv.xmax > endT;
          const x0 = clippedLeft ? originX : xForGlobalIdx(tToIdx.get(iv.xmin)!);
          const x1 = clippedRight ? originX + bandContentW : xForGlobalIdx(tToIdx.get(iv.xmax)!);
          const w = Math.max(1.5, x1 - x0);
          const showText = !clippedLeft && iv.text !== '';
          const richMaxW = isLinear ? Math.max(12, w - 6) : Math.max(24, w - 16);
          const rich = showText
            ? layoutRichText(iv.text, richMaxW, textFontMeasure, mode, effectiveRichOpts)
            : null;
          const needH = rich ? Math.max(baseLaneH, rich.height + 12) : baseLaneH;
          if (needH > laneMaxH[iv.lane]) laneMaxH[iv.lane] = needH;

          const segT0 = Math.max(iv.xmin, startT);
          const segT1 = Math.min(iv.xmax, endT);
          const linW = Math.max(0, linearXForTime(segT1) - linearXForTime(segT0));
          let hasCollapsedCol = false;
          for (let c = b.startIdx; c < b.endIdx; c++) {
            if (colCollapsed[c] && spineT[c] >= segT0 && spineT[c + 1] <= segT1) {
              hasCollapsedCol = true;
              break;
            }
          }
          const stretchRatio = !isLinear && !hasCollapsedCol && linW > 0.5 ? w / linW : 1;
          const isStretched =
            !isLinear && !hasCollapsedCol && stretchRatio > 1.6 && w - linW >= 8;

          visibleIvs.push({
            iv,
            x0,
            x1,
            w,
            clippedLeft,
            clippedRight,
            rich,
            linW,
            stretchRatio,
            isStretched
          });
        }

        const visibleZeros: VisibleZero[] = tm.zeroIvs
          .filter((iv) => iv.xmin >= startT && iv.xmin <= endT)
          .map((iv) => ({
            iv,
            x: xForGlobalIdx(tToIdx.get(iv.xmin)!),
            rich:
              iv.text !== ''
                ? layoutRichText(iv.text, 120, ptFontMeasure, mode, effectiveRichOpts)
                : null
          }));

        const laneOffsets: number[] = [];
        let totalH = 0;
        for (let l = 0; l < tm.laneCount; l++) {
          laneOffsets.push(totalH);
          totalH += laneMaxH[l];
        }
        if (visibleZeros.length > 0 && totalH < 36) totalH = 36;

        const headerBox = { x: PAD_X, y: ty, w: gutterW - 8, h: totalH };
        const midY = ty + totalH / 2;
        const nameEditBox = { x: PAD_X + 44, y: midY - 12, w: Math.max(66, gutterW - 52), h: 24 };

        tiersLayout[ti] = {
          tierIndex: ti,
          tier,
          meta: tm,
          y: ty,
          h: totalH,
          midY,
          headerBox,
          nameEditBox,
          laneOffsets,
          laneHeights: laneMaxH,
          visibleIvs,
          visibleZeros
        };
        ty += totalH + TIER_GAP;
      } else {
        const bandLeft = originX;
        const bandRight = originX + bandContentW;
        const maxFlagW = Math.min(184, Math.max(88, bandContentW));
        const visiblePts: VisiblePoint[] = tm.finitePts
          .filter((pt) => (bandIndex === 0 ? pt.number >= startT : pt.number > startT) && pt.number <= endT)
          .map((pt) => {
            const x = elasticXLocal(pt.number);
            const rich =
              pt.mark !== ''
                ? layoutRichText(pt.mark, Math.max(48, maxFlagW - 18), ptFontMeasure, mode, effectiveRichOpts)
                : null;
            const boxW = rich ? Math.max(24, Math.ceil(rich.width) + 18) : 0;
            const boxH = rich ? Math.max(20, rich.height + 6) : 0;
            let bx = x - boxW / 2;
            if (bx + boxW > bandRight) bx = bandRight - boxW;
            if (bx < bandLeft) bx = bandLeft;
            return { pt, x, bx, rich, boxW, boxH, level: 0 };
          });

        const levelRightEdge: number[] = [];
        const levelMaxH: number[] = [];
        for (const vp of visiblePts) {
          if (!vp.rich) {
            vp.level = -1;
            continue;
          }
          const left = vp.bx;
          const right = vp.bx + vp.boxW;
          let lvl = 0;
          while (lvl < levelRightEdge.length && levelRightEdge[lvl] + 5 > left) lvl++;
          vp.level = lvl;
          levelRightEdge[lvl] = right;
          levelMaxH[lvl] = Math.max(levelMaxH[lvl] || 0, vp.boxH);
        }

        const wireOffsetY = 12;
        let extraStemH = 14;
        const levelY: number[] = [];
        for (let l = 0; l < levelMaxH.length; l++) {
          const top =
            wireOffsetY +
            11 +
            (l === 0 ? 0 : levelY[l - 1] - wireOffsetY - 11 + levelMaxH[l - 1] + 5);
          levelY.push(top);
          extraStemH = top + levelMaxH[l] + 4;
        }
        const totalH = Math.max(28, extraStemH);
        const wireY = ty + wireOffsetY;
        const headerBox = { x: PAD_X, y: wireY - 12, w: gutterW - 8, h: 24 };
        const nameEditBox = { x: PAD_X + 44, y: wireY - 12, w: Math.max(66, gutterW - 52), h: 24 };

        tiersLayout[ti] = {
          tierIndex: ti,
          tier,
          meta: tm,
          y: ty,
          h: totalH,
          wireY,
          midY: wireY,
          headerBox,
          nameEditBox,
          visiblePts,
          levelY
        };
        ty += totalH + TIER_GAP;
      }
    }

    if (tg.tiers.length === 0) ty += 28;
    else ty -= TIER_GAP;

    const bandObj: BandLayout = {
      bandIndex,
      startIdx: b.startIdx,
      endIdx: b.endIdx,
      startT,
      endT,
      gutterW,
      originX,
      bandContentW,
      linearY,
      linearH: LINEAR_H,
      waveY,
      waveH: WAVE_H,
      specY,
      specH: SPEC_H,
      anchorY,
      anchorH: ANCHOR_H,
      neckTopY,
      neckBotY,
      tiersTopY,
      tiersBottomY: ty,
      spineCols,
      isolatedPointTicks,
      linearSegs,
      linearXForTime,
      tiersLayout,
      displayOrder,
      finestIntervalTierIdx
    };
    curY = ty + BAND_GAP;
    return bandObj;
  });

  const baseWidth = Math.max(260, Math.ceil(totalSvgW));
  const baseBottomY = Math.ceil(curY - BAND_GAP + scaleBarExtraH);
  let legendItems: LegendCatalogItem[] | null = null;
  let legendLayout: EmbeddedLegendLayout | null = null;

  if (legendConfig && legendConfig.mode !== 'off') {
    legendItems = collectActiveLegendItems(
      tg,
      { bands: bandLayouts, scaleMode },
      {
        isExport: true,
        lang: legendConfig.lang,
        hasAudio: legendConfig.hasAudio,
        analysis: legendConfig.analysis,
        maxFreq: legendConfig.maxFreq,
        specStrategy: legendConfig.specStrategy,
        specOpacity: legendConfig.specOpacity,
        pitchOpacity: legendConfig.pitchOpacity,
        formantOpacity: legendConfig.formantOpacity,
        trigraphMode: legendConfig.trigraphMode,
        hideMetaSymbols: legendConfig.hideMetaSymbols,
        hideStretchCues: legendConfig.hideStretchCues
      }
    );
    legendLayout = computeLegendLayout(legendItems, {
      legendMode: legendConfig.mode,
      lang: legendConfig.lang,
      scaleMode,
      figureWidth: baseWidth,
      padX: PAD_X,
      topY: baseBottomY,
      fontScale
    });
  }

  const legendExtraH = legendLayout ? legendLayout.height : 0;

  return {
    width: baseWidth,
    height: Math.max(120, Math.ceil(baseBottomY + legendExtraH + PAD_BOTTOM)),
    padX: PAD_X,
    padTop: PAD_TOP,
    padBottom: PAD_BOTTOM,
    captionHeight,
    scaleBarExtraH,
    hideTicks,
    isTinyView,
    scaleMode,
    legendItems,
    legendLayout,
    spineT,
    tToIdx,
    colCollapsed,
    bands: bandLayouts
  };
}

export function elasticXInBand(band: BandLayout, t: number): number {
  const cols = band.spineCols;
  if (!cols.length) return band.originX;
  if (t <= cols[0].t) return cols[0].x;
  const last = cols[cols.length - 1];
  if (t >= last.t) return last.x;
  for (let i = 0; i < cols.length - 1; i++) {
    if (t >= cols[i].t && t <= cols[i + 1].t) {
      const dt = cols[i + 1].t - cols[i].t;
      return dt <= 0 ? cols[i].x : cols[i].x + ((t - cols[i].t) / dt) * (cols[i + 1].x - cols[i].x);
    }
  }
  return band.originX;
}

export function timeFromElasticX(band: BandLayout, x: number): number {
  const cols = band.spineCols;
  if (!cols.length) return 0;
  if (x <= cols[0].x) return cols[0].t;
  const last = cols[cols.length - 1];
  if (x >= last.x) return last.t;
  for (let i = 0; i < cols.length - 1; i++) {
    if (x >= cols[i].x && x <= cols[i + 1].x) {
      const dx = cols[i + 1].x - cols[i].x;
      return dx <= 0 ? cols[i].t : cols[i].t + ((x - cols[i].x) / dx) * (cols[i + 1].t - cols[i].t);
    }
  }
  return last.t;
}

export function timeFromLinearX(band: BandLayout, x: number): number {
  const segs = band.linearSegs;
  if (!segs.length) return band.startT;
  if (x <= segs[0].x0) return segs[0].t0;
  const last = segs[segs.length - 1];
  if (x >= last.x1) return last.t1;
  for (const seg of segs) {
    if (x >= seg.x0 && x <= seg.x1) {
      const w = seg.x1 - seg.x0;
      return w <= 0 ? seg.t0 : seg.t0 + ((x - seg.x0) / w) * (seg.t1 - seg.t0);
    }
  }
  return last.t1;
}
