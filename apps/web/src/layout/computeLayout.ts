import type { AudioAnalysisSummary, Interval, LinearSeg, TextGrid, TextPoint, Tier } from '../bridge/types.ts';
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
} from './richText.ts';
import {
  collectActiveLegendItems,
  computeLegendLayout,
  type EmbeddedLegendLayout,
  type LegendCatalogItem
} from './legendCore.ts';

export type { RichTextLayout };

export type TierScaleMode = 'linear' | 'elastic';
export type GlobalScaleMode = 'elastic' | 'mixed' | 'linear';

export interface TransitionNeck {
  neckIndex: number;
  direction: 'l2e' | 'e2l';
  topY: number;
  botY: number;
  isPrimary: boolean;
}

export type BandCoordSliceKind = 'linear' | 'elastic' | 'neck-l2e' | 'neck-e2l' | 'tick-spine';

export interface BandCoordSlice {
  kind: BandCoordSliceKind;
  y0: number;
  y1: number;
  neckIndex?: number;
  isPrimary?: boolean;
}

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
  scaleMode: TierScaleMode;
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
  linearUsage: number;
  elasticUsage: number;
  labelVisible: boolean;
  isSliverEdge?: boolean;
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
  tickSpineTopY: number;
  tickSpineBotY: number;
  tiersTopY: number;
  tiersBottomY: number;
  transitionNecks: TransitionNeck[];
  coordSlices: BandCoordSlice[];
  hasMixedScales: boolean;
  hasAnyElasticTier: boolean;
  hasAnyLinearTier: boolean;
  effectiveScaleMode: GlobalScaleMode;
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
  scaleMode: GlobalScaleMode;
  effectiveScaleMode: GlobalScaleMode;
  tierScales: TierScaleMode[];
  maxTransitionNecks: number;
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
  audioBuffer?: AudioBuffer | null;
  audioOffset?: number;
  showSpectrogram?: boolean;
  tierOrder?: 'raw' | 'spec';
  scaleMode?: GlobalScaleMode;
  tierScaleOverrides?: Record<string, TierScaleMode> | null;
  tickPrecision?: '2' | '3' | '4' | 'full' | 'none';
  tickFixedDecimals?: boolean;
  viewDomain?: { min: number; max: number } | null;
  mode?: 'read' | 'edit';
  marginPreset?: 'tight' | 'standard' | 'wide';
  captionHeight?: number;
  scaleBarExtraH?: number;
  richOpts?: RichLayoutOptions | null;
  fontScale?: number;
  hiddenTierIndices?: number[];
  isInteractive?: boolean;
  floatingBarMode?: boolean;
  allowSingleCompress?: boolean;
  viewportHeight?: number;
  shortAudioMode?: boolean;
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

/**
 * Resolve a stable key for per-tier scale overrides, matching `StyleDocument.tierStyles` rules:
 * prefer unique non-empty tier name; fall back to `#<index>` when empty or duplicated.
 */
export function resolveTierScaleKey(tg: TextGrid, tierIndex: number): string {
  const tier = tg.tiers[tierIndex];
  if (!tier) return `#${tierIndex}`;
  const trimmed = tier.name.trim();
  if (!trimmed) return `#${tierIndex}`;
  let dupCount = 0;
  for (let i = 0; i < tg.tiers.length; i++) {
    if (tg.tiers[i].name === tier.name) dupCount++;
  }
  return dupCount === 1 ? tier.name : `#${tierIndex}`;
}

export function resolveTierScaleMode(
  tg: TextGrid,
  tierIndex: number,
  globalScaleMode: GlobalScaleMode,
  tierScaleOverrides?: Record<string, TierScaleMode> | null
): TierScaleMode {
  if (globalScaleMode === 'linear') return 'linear';
  if (globalScaleMode === 'elastic') return 'elastic';
  if (tierScaleOverrides) {
    const key = resolveTierScaleKey(tg, tierIndex);
    const direct = tierScaleOverrides[key];
    if (direct === 'linear' || direct === 'elastic') return direct;
    const byIdx = tierScaleOverrides[`#${tierIndex}`];
    if (byIdx === 'linear' || byIdx === 'elastic') return byIdx;
    const tier = tg.tiers[tierIndex];
    if (tier && tier.name) {
      const byName = tierScaleOverrides[tier.name];
      if (byName === 'linear' || byName === 'elastic') return byName;
    }
  }
  return 'elastic';
}

const audioGlobalPeakCache = new WeakMap<AudioBuffer, number>();

function getAudioGlobalPeak(buffer: AudioBuffer): number {
  const cached = audioGlobalPeakCache.get(buffer);
  if (cached !== undefined) return cached;
  const ch = buffer.getChannelData(0);
  const len = ch.length;
  const stride = Math.max(1, Math.floor(len / 8000));
  let peak = 0;
  for (let i = 0; i < len; i += stride) {
    const v = Math.abs(ch[i]);
    if (v > peak) peak = v;
  }
  audioGlobalPeakCache.set(buffer, peak);
  return peak;
}

/**
 * Fast O(1)-capped acoustic energy check: returns true if the audio slice [tStart, tEnd]
 * contains audible speech/sound energy rather than genuine silence.
 */
function hasAudibleEnergy(
  buffer: AudioBuffer | null | undefined,
  audioOffset: number,
  tStart: number,
  tEnd: number
): boolean {
  if (!buffer) return false;
  const sr = buffer.sampleRate;
  if (!(sr > 0) || buffer.length === 0) return false;
  const globalPeak = getAudioGlobalPeak(buffer);
  if (globalPeak < 1e-4) return false;

  const edgeTrim = Math.min(0.035, Math.max(0, (tEnd - tStart) * 0.1));
  const s0 = Math.max(0, Math.floor((tStart + edgeTrim - audioOffset) * sr));
  const s1 = Math.min(buffer.length, Math.ceil((tEnd - edgeTrim - audioOffset) * sr));
  if (s1 <= s0) return false;

  const ch = buffer.getChannelData(0);
  const winSamples = Math.max(64, Math.round(sr * 0.025));
  const totalSamples = s1 - s0;
  const numWindows = Math.max(1, Math.floor(totalSamples / winSamples));
  const winStep = Math.max(1, Math.floor(numWindows / 120));
  const rmsThreshold = Math.max(0.008, globalPeak * 0.055);

  for (let w = 0; w < numWindows; w += winStep) {
    const ws = s0 + w * winSamples;
    const we = Math.min(s1, ws + winSamples);
    const sampleStep = Math.max(1, Math.floor((we - ws) / 64));
    let sumSq = 0;
    let count = 0;
    for (let i = ws; i < we; i += sampleStep) {
      const v = ch[i];
      sumSq += v * v;
      count++;
    }
    if (count > 0 && Math.sqrt(sumSq / count) >= rmsThreshold) {
      return true;
    }
  }
  return false;
}

export function computeLayout(tg: TextGrid, options: ComputeLayoutOptions): ScoreLayout {
  const {
    wrapMode,
    targetWidth,
    hasAudio,
    audioBuffer = null,
    audioOffset = 0,
    showSpectrogram = true,
    tierOrder = 'raw',
    scaleMode = 'elastic',
    tierScaleOverrides = null,
    tickPrecision = '3',
    tickFixedDecimals = false,
    viewDomain = null,
    mode = 'read',
    marginPreset = 'standard',
    captionHeight = 0,
    scaleBarExtraH = 0,
    richOpts = null,
    fontScale = 1,
    hiddenTierIndices,
    isInteractive = false,
    floatingBarMode = false,
    allowSingleCompress = false,
    viewportHeight = 0,
    shortAudioMode = false,
    legendConfig = null
  } = options;

  const rawHiddenSet = new Set(
    (hiddenTierIndices ?? []).filter(
      (i) => Number.isInteger(i) && i >= 0 && i < tg.tiers.length
    )
  );
  const visibleIndices = tg.tiers.map((_, i) => i).filter((i) => !rawHiddenSet.has(i));
  const hiddenSet = visibleIndices.length > 0 ? rawHiddenSet : new Set<number>();
  const isTierVisible = (ti: number) => !hiddenSet.has(ti);

  const tierScales: TierScaleMode[] = tg.tiers.map((_, ti) =>
    resolveTierScaleMode(tg, ti, scaleMode, tierScaleOverrides)
  );
  let visibleLinearCount = 0;
  let visibleElasticCount = 0;
  for (let ti = 0; ti < tg.tiers.length; ti++) {
    if (!isTierVisible(ti)) continue;
    if (tierScales[ti] === 'linear') visibleLinearCount++;
    else visibleElasticCount++;
  }
  const hasMixedTiers = visibleLinearCount > 0 && visibleElasticCount > 0;
  const effectiveScaleMode: GlobalScaleMode = hasMixedTiers
    ? 'mixed'
    : visibleLinearCount > 0 && visibleElasticCount === 0
      ? 'linear'
      : visibleElasticCount > 0 && visibleLinearCount === 0
        ? 'elastic'
        : scaleMode;
  const isLinear = effectiveScaleMode === 'linear';
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
  const LINEAR_NECK_H = 8;
  const TIER_GAP = 7;
  const baseBandGap =
    marginPreset === 'tight' ? 20 : marginPreset === 'wide' ? 40 : isTinyView ? 24 : 32;
  const BAND_GAP =
    isInteractive && floatingBarMode ? Math.max(baseBandGap, 54) : baseBandGap;
  const MIN_COL_W = isTinyView ? 17 : 19;
  const SILENCE_THRESHOLD = shortAudioMode ? 1.5 : 0.5;
  const SILENCE_COLLAPSE_W = isTinyView ? 46 : 52;

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
  for (let ti = 0; ti < tg.tiers.length; ti++) {
    if (!isTierVisible(ti)) continue;
    const tier = tg.tiers[ti];
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
    for (let ti = 0; ti < tg.tiers.length; ti++) {
      if (!isTierVisible(ti)) continue;
      const tier = tg.tiers[ti];
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
  const totalDur = Math.max(0, spineT[spineT.length - 1] - spineT[0]);
  const tToIdx = new Map<number, number>();
  spineT.forEach((t, i) => tToIdx.set(t, i));

  const spineUsage = new Array<number>(spineT.length).fill(0);
  const spineLinearUsage = new Array<number>(spineT.length).fill(0);
  const spineElasticUsage = new Array<number>(spineT.length).fill(0);
  for (let ti = 0; ti < tg.tiers.length; ti++) {
    if (!isTierVisible(ti)) continue;
    const tier = tg.tiers[ti];
    const isTierLin = tierScales[ti] === 'linear';
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
      if (isTierLin) spineLinearUsage[idx]++;
      else spineElasticUsage[idx]++;
    });
  }

  let maxTierNameW = 28;
  for (let ti = 0; ti < tg.tiers.length; ti++) {
    if (!isTierVisible(ti)) continue;
    const t = tg.tiers[ti];
    const w = t.name === '' ? 14 : measurePx(t.name, tierFontMeasure);
    if (w > maxTierNameW) maxTierNameW = w;
  }
  const mixedBadgeExtraW = hasMixedTiers && !isTinyView ? 22 : 0;
  const gutterMin = isTinyView ? 68 : isCompactView ? 84 : 102;
  const gutterMax = isTinyView ? 92 : isCompactView ? 124 + mixedBadgeExtraW : 192 + mixedBadgeExtraW;
  const GUTTER_FULL = Math.min(
    gutterMax,
    Math.max(gutterMin, Math.ceil((isTinyView ? 40 : 54) + maxTierNameW + 12 + mixedBadgeExtraW))
  );
  const GUTTER_SUBSEQUENT = isTinyView ? 44 : GUTTER_FULL;

  const ANGLE_RAD = (52 * Math.PI) / 180;
  const tickStrings = hideTicks
    ? spineT.map(() => '')
    : buildDisplayTickStrings(spineT, tickPrecision, tickFixedDecimals);
  const isoTickFontMeasure =
    fontScale !== 1 ? `${(9.5 * fontScale).toFixed(2)}px ${MONO_FONT_STACK}` : `9.5px ${MONO_FONT_STACK}`;

  // Pre-compute disambiguated labels for all isolated TextTier point ticks so SPINE_H & RIGHT_OVERHANG
  // reserve full vertical/horizontal clearance before band layout runs (P1-3).
  // In mixed mode, linear TextTiers stay 1:1 aligned to the spectrogram and do not crowd the main elastic spine.
  const globalIsoTimeSet = new Set<number>();
  const globalMinT = spineT[0];
  const globalMaxT = spineT[spineT.length - 1];
  for (let ti = 0; ti < tg.tiers.length; ti++) {
    if (!isTierVisible(ti)) continue;
    if (hasMixedTiers && tierScales[ti] === 'linear') continue;
    const tier = tg.tiers[ti];
    if (tier.kind !== 'textTier') continue;
    for (const pt of tier.points) {
      const t = pt.number;
      if (Number.isFinite(t) && t >= globalMinT && t <= globalMaxT && !tToIdx.has(t)) {
        globalIsoTimeSet.add(t);
      }
    }
  }
  const globalIsoTimes = Array.from(globalIsoTimeSet).sort((a, b2) => a - b2);
  const globalIsoLabels: string[] = hideTicks
    ? globalIsoTimes.map(() => '')
    : globalIsoTimes.map((t) => formatDisplayTick(t, tickPrecision, tickFixedDecimals));
  if (!hideTicks && globalIsoTimes.length > 0 && tickPrecision !== 'full') {
    const allSpineLabelSet = new Set<string>(tickStrings);
    const baseDigits = parseInt(tickPrecision, 10) || 3;
    for (let d = baseDigits + 1; d <= 6; d++) {
      const colliding = new Set<number>();
      for (let i = 0; i < globalIsoTimes.length; i++) {
        if (allSpineLabelSet.has(globalIsoLabels[i])) colliding.add(i);
        if (i > 0 && globalIsoLabels[i] === globalIsoLabels[i - 1]) {
          colliding.add(i - 1);
          colliding.add(i);
        }
      }
      if (colliding.size === 0) break;
      colliding.forEach((idx) => {
        globalIsoLabels[idx] = formatDisplayTick(globalIsoTimes[idx], String(d), tickFixedDecimals);
      });
    }
  }
  const globalIsoLabelMap = new Map<number, string>();
  for (let i = 0; i < globalIsoTimes.length; i++) {
    globalIsoLabelMap.set(globalIsoTimes[i], globalIsoLabels[i]);
  }

  let maxTickW = 22;
  if (!hideTicks) {
    for (const s of tickStrings) {
      const w = measurePx(s, tickFontMeasure);
      if (w > maxTickW) maxTickW = w;
    }
    for (const s of globalIsoLabels) {
      const w = measurePx(s, isoTickFontMeasure);
      if (w > maxTickW) maxTickW = w;
    }
  }
  // +20 (instead of +16) reserves a clean ~4 px breathing gap below the neckBotY separator rule
  const SPINE_H = hideTicks ? 8 : Math.ceil(maxTickW * Math.sin(ANGLE_RAD)) + 20;
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
  const colIsCrossSliver = new Array<boolean>(numCols).fill(false);
  const dx = new Array<number>(numCols).fill(MIN_COL_W);
  const dxWrap = new Array<number>(numCols).fill(MIN_COL_W);
  const colFloor = new Array<number>(numCols).fill(MIN_COL_W);
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
      dxWrap[i] = dx[i];
      colFloor[i] = dx[i];
    }
  } else {
    const minSliverW = isTinyView ? 3 : 4;
    // Activity across ALL visible tiers determines synchronous long-silence folding;
    // elastic-only flags isolate elastic stretching weights so linear tiers never distort elastic columns.
    const colHasAnyVisibleText = new Array<boolean>(numCols).fill(false);
    const colHasActiveText = new Array<boolean>(numCols).fill(false);
    const colHasAnomaly = new Array<boolean>(numCols).fill(false);
    const colExactAtom = new Array<boolean>(numCols).fill(false);
    const colInteriorPt = new Array<boolean>(numCols).fill(false);
    let hasAnyActiveTextAll = false;

    for (let i = 0; i < numCols; i++) {
      const a = spineT[i];
      const b = spineT[i + 1];
      for (let ti = 0; ti < tg.tiers.length; ti++) {
        if (!isTierVisible(ti)) continue;
        const isElasticTier = tierScales[ti] === 'elastic';
        const tm = tierMeta[ti];
        if (tm.kind === 'intervalTier') {
          for (const iv of tm.normalIvs) {
            if (isElasticTier && Math.abs(iv.xmin - a) <= 1e-12 && Math.abs(iv.xmax - b) <= 1e-12) {
              colExactAtom[i] = true;
            }
            if (iv.xmin <= a && iv.xmax >= b && iv.text !== '') {
              colHasAnyVisibleText[i] = true;
              if (isElasticTier) colHasActiveText[i] = true;
            }
          }
          if (!colHasAnomaly[i]) {
            for (const g of tm.gaps) {
              if (g.xmin < b - 1e-12 && g.xmax > a + 1e-12) {
                colHasAnomaly[i] = true;
                break;
              }
            }
          }
          if (!colHasAnomaly[i]) {
            for (const ov of tm.overlaps) {
              if (ov.xmin < b - 1e-12 && ov.xmax > a + 1e-12) {
                colHasAnomaly[i] = true;
                break;
              }
            }
          }
          if (!colHasAnomaly[i]) {
            for (const z of tm.zeroIvs) {
              if (z.xmin >= a - 1e-12 && z.xmin <= b + 1e-12) {
                colHasAnomaly[i] = true;
                break;
              }
            }
          }
        } else {
          for (const pt of tm.finitePts) {
            if (pt.number >= b) break;
            if (pt.number > a) {
              colHasAnyVisibleText[i] = true;
              if (isElasticTier) {
                colHasActiveText[i] = true;
                if (pt.mark !== '') colInteriorPt[i] = true;
              }
              break;
            }
          }
        }
      }
      if (colHasAnyVisibleText[i]) hasAnyActiveTextAll = true;
    }

    for (let i = 0; i < numCols; i++) {
      const a = spineT[i];
      const b = spineT[i + 1];
      const dt = b - a;
      const hasAnyText = colHasAnyVisibleText[i];
      const hasActiveText = colHasActiveText[i];
      const hasAnomaly = colHasAnomaly[i];
      const isExactSingleTierAtom = colExactAtom[i];
      const hasInteriorPoint = colInteriorPt[i];
      const hasAudible =
        Boolean(hasAudio && audioBuffer) &&
        (!hasAnyText || dt >= 0.25) &&
        hasAudibleEnergy(audioBuffer, audioOffset, a, b);

      // Only fold a pause when the document has actual annotations, ALL visible tiers (linear + elastic)
      // are silent, the column contains no structural anomaly, AND (if audio is loaded) has no audible energy.
      const shouldCollapse =
        !(shortAudioMode && totalDur <= 2.5) &&
        hasAnyActiveTextAll &&
        !hasAnyText &&
        !hasAnomaly &&
        dt >= SILENCE_THRESHOLD &&
        !hasAudible;

      if (shouldCollapse) {
        colCollapsed[i] = true;
        dx[i] = SILENCE_COLLAPSE_W;
        colFloor[i] = SILENCE_COLLAPSE_W;
      } else {
        // Short unfolded empty pauses (< 0.5s) or unannotated audio use linear-friendly weight;
        // labeled segments use gentler dt^0.72 curve (vs 0.55) to suppress baseline drift.
        const naturalW = !hasActiveText
          ? Math.round(8 + 150 * Math.max(dt, 0.001))
          : Math.round(12 + 78 * Math.pow(Math.max(dt, 0.001), 0.72));
        if (!isExactSingleTierAtom && !hasInteriorPoint) {
          // Pure cross-tier overlap sliver (or linear-only subdivision inside an elastic interval):
          // exempt from MIN_COL_W=19px inflation; scale cleanly by true duration.
          colIsCrossSliver[i] = true;
          const sliverW = Math.min(naturalW, Math.max(minSliverW, Math.round(dt * 110)));
          dx[i] = sliverW;
          colFloor[i] = sliverW;
        } else {
          dx[i] = Math.max(MIN_COL_W, naturalW);
          // Protect unfolded long voiced/regular columns from being flattened to 19px during water-filling
          const acousticFloor =
            !hasActiveText && hasAudible
              ? Math.min(Math.round(maxBandContentW * 0.42), Math.max(MIN_COL_W, Math.round(dt * 90)))
              : dt >= 0.2
                ? Math.min(
                    Math.round(maxBandContentW * 0.32),
                    Math.max(MIN_COL_W, Math.round(12 + (hasAudible ? 52 : 38) * dt))
                  )
                : MIN_COL_W;
          colFloor[i] = Math.min(dx[i], acousticFloor);
        }
      }
    }

    const MAX_SINGLE_INTERVAL_W =
      wrapMode === 'single' ? 360 : Math.min(360, Math.max(120, Math.floor(maxBandContentW * 0.72)));
    const MAX_GLOSS_INTERVAL_W =
      wrapMode === 'single' ? 440 : Math.min(440, Math.max(120, Math.floor(maxBandContentW * 0.85)));

    tg.tiers.forEach((_tier, ti) => {
      if (!isTierVisible(ti)) return;
      if (tierScales[ti] !== 'elastic') return;
      const tm = tierMeta[ti];
      if (tm.kind === 'intervalTier') {
        for (const iv of tm.normalIvs) {
          if (iv.text === '') continue;
          const aIdx = tToIdx.get(Math.max(vMin, iv.xmin));
          const bIdx = tToIdx.get(Math.min(vMax, iv.xmax));
          if (aIdx === undefined || bIdx === undefined || bIdx <= aIdx) continue;
          let curSpanW = 0;
          let curFloorSpanW = 0;
          for (let c = aIdx; c < bIdx; c++) {
            curSpanW += dx[c];
            curFloorSpanW += colFloor[c];
          }
          const unwrapped = layoutRichText(iv.text, 0, textFontMeasure, mode, effectiveRichOpts);
          const capW = unwrapped.gloss ? MAX_GLOSS_INTERVAL_W : MAX_SINGLE_INTERVAL_W;
          const desiredW = Math.min(unwrapped.width + 28, Math.max(curSpanW, capW));
          const desiredFloorW = Math.min(unwrapped.width + 28, Math.max(curFloorSpanW, capW));
          if (curSpanW < desiredW || curFloorSpanW < desiredFloorW) {
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
              totalWeight += Math.max(1e-4, spineT[c + 1] - spineT[c]);
            }
            if (totalWeight > 0) {
              const extraDx = Math.max(0, desiredW - curSpanW);
              const extraFloor = Math.max(0, desiredFloorW - curFloorSpanW);
              for (let c = aIdx; c < bIdx; c++) {
                if (!useAll && colCollapsed[c]) continue;
                const w = Math.max(1e-4, spineT[c + 1] - spineT[c]);
                const share = w / totalWeight;
                if (extraDx > 0) dx[c] += extraDx * share;
                if (extraFloor > 0) colFloor[c] += extraFloor * share;
              }
            }
          }
        }
        for (const zIv of tm.zeroIvs) {
          if (zIv.text === '') continue;
          const zIdx = tToIdx.get(zIv.xmin);
          if (zIdx === undefined) continue;
          const zRich = layoutRichText(zIv.text, 120, ptFontMeasure, mode, effectiveRichOpts);
          const halfNeed = Math.min(84, Math.ceil((zRich.width + 8) / 2) + 4);
          const cL = zIdx - 1;
          const cR = zIdx;
          if (cL >= 0 && !colCollapsed[cL]) {
            const hasLabeledLeft = tm.normalIvs.some(
              (iv) => Math.abs(iv.xmax - zIv.xmin) <= 1e-12 && iv.text !== ''
            );
            const targetL = hasLabeledLeft
              ? dx[cL] + Math.min(36, Math.ceil(halfNeed * 0.65))
              : Math.max(dx[cL], halfNeed);
            const floorL = hasLabeledLeft
              ? colFloor[cL] + Math.min(28, Math.ceil(halfNeed * 0.55))
              : Math.max(colFloor[cL], Math.min(72, halfNeed));
            dx[cL] = Math.max(dx[cL], targetL);
            colFloor[cL] = Math.min(dx[cL], Math.max(colFloor[cL], floorL));
          }
          if (cR < numCols && !colCollapsed[cR]) {
            const hasLabeledRight = tm.normalIvs.some(
              (iv) => Math.abs(iv.xmin - zIv.xmin) <= 1e-12 && iv.text !== ''
            );
            const targetR = hasLabeledRight
              ? dx[cR] + Math.min(36, Math.ceil(halfNeed * 0.65))
              : Math.max(dx[cR], halfNeed);
            const floorR = hasLabeledRight
              ? colFloor[cR] + Math.min(28, Math.ceil(halfNeed * 0.55))
              : Math.max(colFloor[cR], Math.min(72, halfNeed));
            dx[cR] = Math.max(dx[cR], targetR);
            colFloor[cR] = Math.min(dx[cR], Math.max(colFloor[cR], floorR));
          }
        }
      }
    });

    // Bounded Point Tier width feedback (P0-4): allow adjacent non-empty points within the same column
    // (or immediately adjacent columns) to gently widen their host column by up to +16 px so nearby
    // short marks (e.g. H* / L-) stay cleanly on one row instead of prematurely stacking.
    if (numCols > 0) {
      const MAX_PT_COL_FEEDBACK = 16;
      const ptColExtra = new Float64Array(numCols);
      const findColForTime = (t: number): number => {
        if (t < spineT[0] || t > spineT[numCols]) return -1;
        let lo = 0;
        let hi = numCols - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (t < spineT[mid]) hi = mid - 1;
          else if (t > spineT[mid + 1]) lo = mid + 1;
          else return mid;
        }
        return -1;
      };
      for (let ti = 0; ti < tg.tiers.length; ti++) {
        if (!isTierVisible(ti)) continue;
        if (tierScales[ti] !== 'elastic') continue;
        const tm = tierMeta[ti];
        if (tm.kind !== 'textTier') continue;
        const marked = tm.finitePts.filter(
          (pt) => pt.mark !== '' && pt.number >= spineT[0] && pt.number <= spineT[numCols]
        );
        if (marked.length < 2) continue;
        const widths = marked.map((pt) => {
          const r = layoutRichText(pt.mark, 160, ptFontMeasure, mode, effectiveRichOpts);
          return Math.max(18, Math.ceil(r.width) + 10);
        });
        for (let k = 0; k < marked.length - 1; k++) {
          const p0 = marked[k];
          const p1 = marked[k + 1];
          if (p1.number <= p0.number) continue;
          const c0 = findColForTime(p0.number);
          const c1 = findColForTime(p1.number);
          if (c0 < 0 || c1 < 0) continue;
          const needDist = (widths[k] + widths[k + 1]) / 2 + 3;
          if (c0 === c1 && !colCollapsed[c0]) {
            const dtCol = spineT[c0 + 1] - spineT[c0];
            if (dtCol <= 0) continue;
            const curDist = ((p1.number - p0.number) / dtCol) * dx[c0];
            if (curDist < needDist) {
              const reqColW = (needDist * dtCol) / (p1.number - p0.number);
              const add = Math.min(MAX_PT_COL_FEEDBACK, Math.max(0, reqColW - dx[c0]));
              if (add > ptColExtra[c0]) ptColExtra[c0] = add;
            }
          } else if (c1 === c0 + 1 && !colCollapsed[c0] && !colCollapsed[c1]) {
            const dt0 = spineT[c0 + 1] - spineT[c0];
            const dt1 = spineT[c1 + 1] - spineT[c1];
            if (dt0 <= 0 || dt1 <= 0) continue;
            const curDist =
              ((spineT[c0 + 1] - p0.number) / dt0) * dx[c0] +
              ((p1.number - spineT[c1]) / dt1) * dx[c1];
            if (curDist < needDist) {
              const deficit = needDist - curDist;
              const halfAdd = Math.min(MAX_PT_COL_FEEDBACK, deficit * 0.65);
              if (halfAdd > ptColExtra[c0]) ptColExtra[c0] = halfAdd;
              if (halfAdd > ptColExtra[c1]) ptColExtra[c1] = halfAdd;
            }
          }
        }
      }
      for (let c = 0; c < numCols; c++) {
        if (ptColExtra[c] > 0) {
          dx[c] += ptColExtra[c];
          colFloor[c] += ptColExtra[c];
        }
        if (colFloor[c] > dx[c]) colFloor[c] = dx[c];
      }
    }

    // Dual-constraint wrapping envelope for mixed mode: dxWrap[i] = max(dxElastic[i], dxLinear[i])
    // using a moderate physical density (160-280 px/s) so linear tiers stay legible without over-wrapping.
    if (hasMixedTiers) {
      let activeDur = 0;
      let activeCnt = 0;
      for (let i = 0; i < numCols; i++) {
        if (!colCollapsed[i]) {
          activeDur += Math.max(0, spineT[i + 1] - spineT[i]);
          activeCnt++;
        }
      }
      const mixedLinearPxPerSec =
        activeDur > 1e-6
          ? Math.max(160, Math.min(280, (activeCnt * 18) / activeDur))
          : 200;
      for (let i = 0; i < numCols; i++) {
        if (colCollapsed[i]) {
          dxWrap[i] = dx[i];
        } else {
          const dxLin = Math.max(0, spineT[i + 1] - spineT[i]) * mixedLinearPxPerSec;
          dxWrap[i] = Math.max(dx[i], dxLin);
        }
      }
    } else {
      for (let i = 0; i < numCols; i++) dxWrap[i] = dx[i];
    }
  }

  let finestIntervalTierIdx = -1;
  let maxIvCount = -1;
  tg.tiers.forEach((t, ti) => {
    if (!isTierVisible(ti)) return;
    if (t.kind === 'intervalTier' && t.intervals.length > maxIvCount) {
      maxIvCount = t.intervals.length;
      finestIntervalTierIdx = ti;
    }
  });

  const displayOrder = tg.tiers.map((_, i) => i).filter((i) => isTierVisible(i));
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
      prefW[i + 1] = prefW[i] + dxWrap[i];
    }

    const availW0 = maxBandContentW;
    const availWRest = Math.max(130, targetWidth - PAD_X * 2 - GUTTER_SUBSEQUENT - RIGHT_OVERHANG);

    const diff = new Float64Array(numCols + 1);
    for (let ti = 0; ti < tg.tiers.length; ti++) {
      if (!isTierVisible(ti)) continue;
      const tm = tierMeta[ti];
      if (tm.kind !== 'intervalTier') continue;
      for (const iv of tm.normalIvs) {
        if (iv.xmax <= vMin || iv.xmin >= vMax) continue;
        const aIdx = iv.xmin < vMin ? 0 : tToIdx.get(Math.max(vMin, iv.xmin));
        const bIdx = iv.xmax > vMax ? numCols : tToIdx.get(Math.min(vMax, iv.xmax));
        if (aIdx !== undefined && bIdx !== undefined && bIdx - aIdx >= 2) {
          const ivW = prefW[bIdx] - prefW[aIdx];
          const spanRatio = ivW / Math.max(1, availWRest);
          const w =
            iv.text === ''
              ? 18
              : spanRatio >= 0.95
                ? 18
                : spanRatio > 0.65
                  ? Math.round(120 - ((spanRatio - 0.65) / 0.3) * (120 - 18))
                  : 120;
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

  // Elastic spectrogram height in single-band interactive mode: clamp(108px, 28vh, 220px).
  // Multi-band views and offline exports retain fixed publication height.
  const baseSpecH = isTinyView ? 88 : 108;
  const SPEC_H = showSpec
    ? isInteractive && bands.length === 1 && viewportHeight > 0
      ? Math.round(Math.max(baseSpecH, Math.min(220, viewportHeight * 0.28)))
      : baseSpecH
    : 0;
  const ANCHOR_H = showSpec ? 8 : 0;
  const LINEAR_H = showSpec ? WAVE_H + SPEC_H + ANCHOR_H : hasAudio ? 34 : 11;

  // Helper for P0-4: does any visible IntervalTier start a non-empty interval at `breakT`?
  const hasNonEmptyOnsetAt = (breakT: number): boolean => {
    for (let ti = 0; ti < tg.tiers.length; ti++) {
      if (!isTierVisible(ti)) continue;
      const tm = tierMeta[ti];
      if (tm.kind !== 'intervalTier') continue;
      for (const iv of tm.normalIvs) {
        if (Math.abs(iv.xmin - breakT) <= 1e-12 && iv.text !== '') {
          return true;
        }
      }
    }
    return false;
  };

  let curY = PAD_TOP + captionHeight;
  let totalSvgW = 0;

  const bandLayouts: BandLayout[] = bands.map((b, bandIndex) => {
    const gutterW = bandIndex === 0 ? GUTTER_FULL : GUTTER_SUBSEQUENT;
    const originX = PAD_X + gutterW;
    const startT = spineT[b.startIdx];
    const endT = spineT[b.endIdx];
    const bandCols = Math.max(0, b.endIdx - b.startIdx);

    // 1. Determine band total content width (including single-band interactive expansion)
    let rawBandW = 0;
    let collapsedSum = 0;
    let activeSum = 0;
    let activeColCount = 0;
    for (let i = b.startIdx; i < b.endIdx; i++) {
      rawBandW += dxWrap[i];
      if (colCollapsed[i]) collapsedSum += dxWrap[i];
      else {
        activeSum += dxWrap[i];
        activeColCount++;
      }
    }
    let bandContentW = Math.max(40, rawBandW);
    const isShortSingleBand =
      shortAudioMode &&
      isInteractive &&
      wrapMode === 'auto' &&
      bands.length === 1 &&
      totalDur > 0 &&
      totalDur <= 2.5;
    if (
      !isLinear &&
      bandCols > 0 &&
      (wrapMode === 'single' || (wrapMode === 'auto' && bands.length === 1 && isInteractive))
    ) {
      const rawTargetActive = maxBandContentW - collapsedSum;
      const targetActive = isShortSingleBand
        ? Math.max(
            0,
            Math.min(maxBandContentW, Math.max(660, Math.round(totalDur * 520))) - collapsedSum
          )
        : wrapMode === 'single' || (hasAudio && activeColCount <= 2)
          ? rawTargetActive
          : Math.min(rawTargetActive, 220 + activeColCount * 145);
      if (activeSum > 0 && targetActive > activeSum) {
        bandContentW = Math.max(40, collapsedSum + targetActive);
      } else if (
        wrapMode === 'single' &&
        allowSingleCompress &&
        activeSum > 0 &&
        targetActive < activeSum
      ) {
        let activeFloorSum = 0;
        for (let i = b.startIdx; i < b.endIdx; i++) {
          if (!colCollapsed[i]) activeFloorSum += colFloor[i];
        }
        const compressedActive = Math.max(activeFloorSum, targetActive);
        bandContentW = Math.max(40, collapsedSum + compressedActive);
      }
    }

    // 2. Compute strictly physical linear track widths and piecewise-anchored elastic column widths
    const linearSegs: BandLinearSeg[] = [];
    const colW = new Float64Array(bandCols);

    if (bandCols > 0) {
      if (isLinear) {
        let cxLin = originX;
        for (let k = 0; k < bandCols; k++) {
          const gi = b.startIdx + k;
          const w = dx[gi];
          colW[k] = w;
          linearSegs.push({
            globalIdx: gi,
            t0: spineT[gi],
            t1: spineT[gi + 1],
            x0: cxLin,
            x1: cxLin + w,
            collapsed: false,
            isStretched: false
          });
          cxLin += w;
        }
        bandContentW = Math.max(40, cxLin - originX);
      } else {
        let activeTime = 0;
        let collapsedCount = 0;
        for (let i = b.startIdx; i < b.endIdx; i++) {
          if (colCollapsed[i]) collapsedCount++;
          else activeTime += spineT[i + 1] - spineT[i];
        }
        // Keep collapsed silence width identical between linear & elastic tracks whenever feasible
        const breakLinearW =
          collapsedCount === 0
            ? 0
            : activeColCount === 0
              ? bandContentW / collapsedCount
              : Math.min(
                  SILENCE_COLLAPSE_W,
                  Math.max(20, Math.floor((bandContentW * 0.4) / collapsedCount)),
                  Math.max(16, (bandContentW - 20) / collapsedCount)
                );
        const availLinearW =
          activeColCount === 0 ? 0 : Math.max(20, bandContentW - breakLinearW * collapsedCount);
        const linW = new Float64Array(bandCols);
        const fl = new Float64Array(bandCols);
        let totalActiveFloor = 0;
        for (let k = 0; k < bandCols; k++) {
          const gi = b.startIdx + k;
          const dt = spineT[gi + 1] - spineT[gi];
          if (colCollapsed[gi]) {
            linW[k] = breakLinearW;
            fl[k] = breakLinearW;
          } else {
            linW[k] =
              activeTime > 0
                ? (dt / activeTime) * availLinearW
                : availLinearW / Math.max(1, bandCols - collapsedCount);
            fl[k] = colFloor[gi];
            totalActiveFloor += fl[k];
          }
        }

        // Piecewise-anchored bilateral water-filling:
        // Start from exact linear positions (0 drift), raise text-bound columns to their readability
        // floor, and absorb deficits symmetrically from nearest slack inside the same anchor block
        // first (bounded by collapsed silences & shared multi-tier boundaries), spilling outward only
        // if a dense cluster exceeds its own block's linear budget.
        if (activeColCount === 0) {
          for (let k = 0; k < bandCols; k++) colW[k] = linW[k];
        } else if (totalActiveFloor >= availLinearW - 1e-6) {
          const scale = availLinearW / Math.max(1e-6, totalActiveFloor);
          for (let k = 0; k < bandCols; k++) {
            colW[k] = colCollapsed[b.startIdx + k] ? breakLinearW : fl[k] * scale;
          }
        } else {
          const slack = new Float64Array(bandCols);
          const deficit = new Float64Array(bandCols);
          for (let k = 0; k < bandCols; k++) {
            colW[k] = linW[k];
            if (!colCollapsed[b.startIdx + k]) {
              if (linW[k] > fl[k]) slack[k] = linW[k] - fl[k];
              else if (fl[k] > linW[k]) deficit[k] = fl[k] - linW[k];
            }
          }

          const absorb = (center: number, amount: number, lo: number, hi: number): number => {
            let rem = amount;
            let dl = 1;
            let dr = 1;
            while (rem > 1e-6) {
              while (
                center - dl >= lo &&
                (colCollapsed[b.startIdx + center - dl] || slack[center - dl] <= 1e-6)
              ) {
                dl++;
              }
              while (
                center + dr <= hi &&
                (colCollapsed[b.startIdx + center + dr] || slack[center + dr] <= 1e-6)
              ) {
                dr++;
              }
              const hasL = center - dl >= lo;
              const hasR = center + dr <= hi;
              if (!hasL && !hasR) break;
              if (hasL && hasR) {
                if (dl < dr) {
                  const take = Math.min(rem, slack[center - dl]);
                  slack[center - dl] -= take;
                  colW[center - dl] -= take;
                  rem -= take;
                } else if (dr < dl) {
                  const take = Math.min(rem, slack[center + dr]);
                  slack[center + dr] -= take;
                  colW[center + dr] -= take;
                  rem -= take;
                } else {
                  const half = rem * 0.5;
                  const takeL = Math.min(half, slack[center - dl]);
                  const takeR = Math.min(half, slack[center + dr]);
                  slack[center - dl] -= takeL;
                  colW[center - dl] -= takeL;
                  slack[center + dr] -= takeR;
                  colW[center + dr] -= takeR;
                  rem -= takeL + takeR;
                  if (rem > 1e-6 && slack[center - dl] > 1e-6) {
                    const extraL = Math.min(rem, slack[center - dl]);
                    slack[center - dl] -= extraL;
                    colW[center - dl] -= extraL;
                    rem -= extraL;
                  } else if (rem > 1e-6 && slack[center + dr] > 1e-6) {
                    const extraR = Math.min(rem, slack[center + dr]);
                    slack[center + dr] -= extraR;
                    colW[center + dr] -= extraR;
                    rem -= extraR;
                  }
                }
              } else if (hasL) {
                const take = Math.min(rem, slack[center - dl]);
                slack[center - dl] -= take;
                colW[center - dl] -= take;
                rem -= take;
              } else {
                const take = Math.min(rem, slack[center + dr]);
                slack[center + dr] -= take;
                colW[center + dr] -= take;
                rem -= take;
              }
            }
            return rem;
          };

          // Build piecewise anchor blocks bounded by collapsed pauses and shared multi-tier anchors
          const blockLoOf = new Int32Array(bandCols);
          const blockHiOf = new Int32Array(bandCols);
          let curLo = 0;
          for (let k = 0; k < bandCols; k++) {
            const gi = b.startIdx + k;
            const isSplitStart =
              k > 0 &&
              (colCollapsed[gi] || colCollapsed[gi - 1] || spineUsage[gi] >= 2);
            if (isSplitStart) {
              for (let j = curLo; j < k; j++) {
                blockLoOf[j] = curLo;
                blockHiOf[j] = k - 1;
              }
              curLo = k;
            }
          }
          for (let j = curLo; j < bandCols; j++) {
            blockLoOf[j] = curLo;
            blockHiOf[j] = bandCols - 1;
          }

          // Stage 1: absorb deficits within each column's own anchor block
          const overflow = new Float64Array(bandCols);
          for (let k = 0; k < bandCols; k++) {
            if (deficit[k] <= 1e-6) continue;
            const rem = absorb(k, deficit[k], blockLoOf[k], blockHiOf[k]);
            colW[k] += deficit[k] - rem;
            overflow[k] = rem;
          }

          // Stage 2: absorb any remaining overflow from nearest neighboring blocks
          for (let k = 0; k < bandCols; k++) {
            if (overflow[k] <= 1e-6) continue;
            const rem2 = absorb(k, overflow[k], 0, bandCols - 1);
            colW[k] += overflow[k] - rem2;
          }
        }

        let lx = originX;
        for (let k = 0; k < bandCols; k++) {
          const gi = b.startIdx + k;
          const w = linW[k];
          const elasticW = colW[k];
          const isStretched =
            !colCollapsed[gi] && w > 0.5 && elasticW / w > 1.6 && elasticW - w >= 8;
          linearSegs.push({
            globalIdx: gi,
            t0: spineT[gi],
            t1: spineT[gi + 1],
            x0: lx,
            x1: lx + w,
            collapsed: colCollapsed[gi],
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

    const spineCols: SpineCol[] = [];
    let cx = originX;
    for (let i = b.startIdx; i <= b.endIdx; i++) {
      const isSliverEdge =
        !isLinear &&
        spineUsage[i] === 1 &&
        ((i > 0 && colIsCrossSliver[i - 1]) || (i < numCols && colIsCrossSliver[i]));
      spineCols.push({
        globalIdx: i,
        t: spineT[i],
        x: cx,
        label: tickStrings[i],
        usage: spineUsage[i],
        linearUsage: spineLinearUsage[i],
        elasticUsage: spineElasticUsage[i],
        labelVisible: false,
        ...(isSliverEdge ? { isSliverEdge: true } : {})
      });
      if (i < b.endIdx) cx += colW[i - b.startIdx];
    }
    bandContentW = Math.max(40, cx - originX);
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
      const MIN_TICK_GAP = Math.ceil(20 * fontScale);
      const minEndpointGap = Math.ceil(17 * fontScale);
      const tickOrder = spineCols.map((col, idx) => {
        let prio = 0;
        if (col.t === tg.xmin || col.t === tg.xmax) prio = 3;
        else if (idx === 0 || idx === spineCols.length - 1) prio = 2;
        else if (col.usage >= 2) prio = 1;
        return { idx, x: col.x, prio };
      });
      tickOrder.sort((a, b2) => b2.prio - a.prio || a.idx - b2.idx);
      for (const item of tickOrder) {
        const minGap = item.prio >= 2 ? minEndpointGap : MIN_TICK_GAP;
        let collides = false;
        for (let p = 0; p < placedTickXs.length; p++) {
          if (Math.abs(item.x - placedTickXs[p]) < minGap) {
            collides = true;
            break;
          }
        }
        if (!collides || (item.idx === 0 && placedTickXs.length === 0)) {
          spineCols[item.idx].labelVisible = true;
          placedTickXs.push(item.x);
        }
      }
    }

    const isoTimeSet = new Set<number>();
    for (let ti = 0; ti < tg.tiers.length; ti++) {
      if (!isTierVisible(ti)) continue;
      if (hasMixedTiers && tierScales[ti] === 'linear') continue;
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
      : isoTimes.map(
          (t) => globalIsoLabelMap.get(t) ?? formatDisplayTick(t, tickPrecision, tickFixedDecimals)
        );
    const isolatedPointTicks: IsolatedPointTick[] = [];
    const isoTickGap = Math.ceil(19 * fontScale);
    for (let i = 0; i < isoTimes.length; i++) {
      const t = isoTimes[i];
      const x = isLinear ? linearXForTime(t) : elasticXLocal(t);
      const label = isoLabels[i];
      let collides = false;
      if (!hideTicks) {
        for (let p = 0; p < placedTickXs.length; p++) {
          if (Math.abs(x - placedTickXs[p]) < isoTickGap) {
            collides = true;
            break;
          }
        }
      }
      const labelVisible = !hideTicks && !collides;
      if (labelVisible) placedTickXs.push(x);
      isolatedPointTicks.push({ t, x, label, labelVisible });
    }

    // Dynamic neck height based on maximum horizontal shear in this band (strict straight-line legibility)
    let maxShear = 0;
    if (!isLinear) {
      for (let i = 0; i < spineCols.length; i++) {
        const col = spineCols[i];
        const shear = Math.abs(linearXForTime(col.t) - col.x);
        if (shear > maxShear) maxShear = shear;
      }
    }
    const bandNeckH = isLinear
      ? LINEAR_NECK_H
      : Math.round(Math.max(16, Math.min(42, 16 + Math.max(0, maxShear - 24) * 0.16)));
    const secondaryNeckH = Math.round(
      Math.max(12, Math.min(22, 12 + Math.max(0, maxShear - 20) * 0.08))
    );

    const linearY = curY;
    const waveY = linearY;
    const specY = linearY + WAVE_H;
    const anchorY = specY + SPEC_H;
    const acousticBotY = linearY + LINEAR_H;

    const tiersLayout = new Array<TierLayout>(tg.tiers.length);

    const layoutSingleTier = (ti: number, tierScale: TierScaleMode, tierY: number): number => {
      const tier = tg.tiers[ti];
      const tm = tierMeta[ti];
      const isTierLinear = tierScale === 'linear';
      const xForT = (t: number) => {
        if (isTierLinear) return linearXForTime(t);
        const gi = tToIdx.get(t);
        if (gi !== undefined && gi >= b.startIdx && gi <= b.endIdx) return xForGlobalIdx(gi);
        return elasticXLocal(t);
      };

      if (tm.kind === 'intervalTier') {
        const visibleIvs: VisibleInterval[] = [];
        const baseLaneH = Math.round(32 * fontScale);
        const laneMaxH = new Array<number>(tm.laneCount).fill(baseLaneH);
        for (const iv of tm.normalIvs) {
          if (iv.xmax <= startT || iv.xmin >= endT) continue;
          const clippedLeft = iv.xmin < startT;
          const clippedRight = iv.xmax > endT;
          const x0 = clippedLeft ? originX : xForT(iv.xmin);
          const x1 = clippedRight ? originX + bandContentW : xForT(iv.xmax);
          const w = Math.max(1.5, x1 - x0);
          const showText = !clippedLeft && iv.text !== '';
          const horizMargin = isTierLinear
            ? Math.min(12, Math.max(6, Math.round(w * 0.22)))
            : Math.min(18, Math.max(12, Math.round(w * 0.28)));
          const richMaxW = Math.max(14, w - horizMargin);
          const rich = showText
            ? layoutRichText(iv.text, richMaxW, textFontMeasure, mode, effectiveRichOpts)
            : null;
          const needH = rich
            ? Math.max(baseLaneH, rich.height + Math.round((rich.gloss ? 16 : 12) * fontScale))
            : baseLaneH;
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
          const stretchRatio = !isTierLinear && !hasCollapsedCol && linW > 0.5 ? w / linW : 1;
          const isStretched =
            !isTierLinear && !hasCollapsedCol && stretchRatio > 1.6 && w - linW >= 8;

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
          .filter((iv) => (bandIndex === 0 ? iv.xmin >= startT : iv.xmin > startT) && iv.xmin <= endT)
          .map((iv) => ({
            iv,
            x: xForT(iv.xmin),
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

        const headerBox = { x: PAD_X, y: tierY, w: gutterW - 8, h: totalH };
        const midY = tierY + totalH / 2;
        const nameEditBox = { x: PAD_X + 44, y: midY - 12, w: Math.max(66, gutterW - 52), h: 24 };

        tiersLayout[ti] = {
          tierIndex: ti,
          tier,
          meta: tm,
          scaleMode: tierScale,
          y: tierY,
          h: totalH,
          midY,
          headerBox,
          nameEditBox,
          laneOffsets,
          laneHeights: laneMaxH,
          visibleIvs,
          visibleZeros
        };
        return totalH;
      }

      const bandLeft = originX;
      const bandRight = originX + bandContentW;

      const includeStartBoundary = bandIndex === 0 || hasNonEmptyOnsetAt(startT);
      const hasNextBand = bandIndex < bands.length - 1;
      const deferEndBoundary = hasNextBand && endT < tg.xmax && hasNonEmptyOnsetAt(endT);

      const maxFlagW = Math.min(184, Math.max(88, bandContentW));
      const visiblePts: VisiblePoint[] = tm.finitePts
        .filter(
          (pt) =>
            (includeStartBoundary ? pt.number >= startT : pt.number > startT) &&
            (deferEndBoundary ? pt.number < endT : pt.number <= endT)
        )
        .map((pt) => {
          const x = isTierLinear ? linearXForTime(pt.number) : elasticXLocal(pt.number);
          const rich =
            pt.mark !== ''
              ? layoutRichText(pt.mark, Math.max(48, maxFlagW - 10), ptFontMeasure, mode, effectiveRichOpts)
              : null;
          const boxW = rich ? Math.max(18, Math.ceil(rich.width) + 10) : 0;
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
        while (lvl < levelRightEdge.length && levelRightEdge[lvl] + 3 > left) lvl++;
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
      const wireY = tierY + wireOffsetY;
      const headerBox = { x: PAD_X, y: wireY - 12, w: gutterW - 8, h: 24 };
      const nameEditBox = { x: PAD_X + 44, y: wireY - 12, w: Math.max(66, gutterW - 52), h: 24 };

      tiersLayout[ti] = {
        tierIndex: ti,
        tier,
        meta: tm,
        scaleMode: tierScale,
        y: tierY,
        h: totalH,
        wireY,
        midY: wireY,
        headerBox,
        nameEditBox,
        visiblePts,
        levelY
      };
      return totalH;
    };

    const transitionNecks: TransitionNeck[] = [];
    const coordSlices: BandCoordSlice[] = [];
    let neckTopY = acousticBotY;
    let neckBotY = acousticBotY + bandNeckH;
    let tickSpineTopY = neckBotY;
    let tickSpineBotY = neckBotY + SPINE_H;
    let tiersTopY = tickSpineBotY;
    let tiersBottomY = tiersTopY;

    if (!hasMixedTiers || displayOrder.length === 0) {
      // Pure all-linear or pure all-elastic layout (100% pixel-identical to legacy geometry)
      neckTopY = acousticBotY;
      neckBotY = neckTopY + bandNeckH;
      tickSpineTopY = neckBotY;
      tickSpineBotY = tickSpineTopY + SPINE_H;
      tiersTopY = tickSpineBotY;

      let ty = tiersTopY;
      for (const ti of displayOrder) {
        const h = layoutSingleTier(ti, isLinear ? 'linear' : 'elastic', ty);
        ty += h + TIER_GAP;
      }
      if (displayOrder.length === 0) ty += 28;
      else ty -= TIER_GAP;
      tiersBottomY = ty;

      if (isLinear) {
        coordSlices.push({ kind: 'linear', y0: linearY, y1: neckBotY });
        coordSlices.push({ kind: 'tick-spine', y0: tickSpineTopY, y1: tickSpineBotY });
        coordSlices.push({ kind: 'linear', y0: tiersTopY, y1: tiersBottomY });
      } else {
        transitionNecks.push({
          neckIndex: 0,
          direction: 'l2e',
          topY: neckTopY,
          botY: neckBotY,
          isPrimary: true
        });
        coordSlices.push({ kind: 'linear', y0: linearY, y1: neckTopY });
        coordSlices.push({
          kind: 'neck-l2e',
          y0: neckTopY,
          y1: neckBotY,
          neckIndex: 0,
          isPrimary: true
        });
        coordSlices.push({ kind: 'tick-spine', y0: tickSpineTopY, y1: tickSpineBotY });
        coordSlices.push({ kind: 'elastic', y0: tiersTopY, y1: tiersBottomY });
      }
    } else {
      // Genuine mixed-scale layout: group contiguous same-coordinate tiers into Coordinate Runs
      // and insert automatic transition necks only where coordinate spaces switch.
      const runs: Array<{ mode: TierScaleMode; tierIndices: number[] }> = [];
      for (const ti of displayOrder) {
        const m = tierScales[ti];
        const prev = runs[runs.length - 1];
        if (prev && prev.mode === m) prev.tierIndices.push(ti);
        else runs.push({ mode: m, tierIndices: [ti] });
      }

      const NECK_STUB = 3;
      let curBandY = acousticBotY;
      let prevSpace: TierScaleMode = 'linear';
      let hasPlacedPrimary = false;
      let firstTierY = -1;

      // Start with the top acoustic linear slice
      coordSlices.push({ kind: 'linear', y0: linearY, y1: curBandY });

      for (let ri = 0; ri < runs.length; ri++) {
        const run = runs[ri];
        if (run.mode !== prevSpace) {
          const dir: 'l2e' | 'e2l' = prevSpace === 'linear' ? 'l2e' : 'e2l';
          const isPrimary = !hasPlacedPrimary && dir === 'l2e';
          const nH = isPrimary ? bandNeckH : secondaryNeckH;

          // Leave a crisp 3px vertical stub below the previous tier run before slanting
          if (ri > 0) {
            curBandY += NECK_STUB;
            const prevSlice = coordSlices[coordSlices.length - 1];
            if (prevSlice && prevSlice.kind === prevSpace) {
              prevSlice.y1 = curBandY;
            }
          }

          const nTop = curBandY;
          const nBot = nTop + nH;
          const neckIndex = transitionNecks.length;
          transitionNecks.push({
            neckIndex,
            direction: dir,
            topY: nTop,
            botY: nBot,
            isPrimary
          });
          coordSlices.push({
            kind: dir === 'l2e' ? 'neck-l2e' : 'neck-e2l',
            y0: nTop,
            y1: nBot,
            neckIndex,
            isPrimary
          });
          curBandY = nBot;

          if (isPrimary) {
            neckTopY = nTop;
            neckBotY = nBot;
            tickSpineTopY = curBandY;
            tickSpineBotY = curBandY + SPINE_H;
            coordSlices.push({ kind: 'tick-spine', y0: tickSpineTopY, y1: tickSpineBotY });
            curBandY = tickSpineBotY;
            hasPlacedPrimary = true;
          } else {
            // Leave a crisp 3px vertical landing stub above the next tier run after slanting
            const runSliceStart = curBandY;
            curBandY += NECK_STUB;
            coordSlices.push({ kind: run.mode, y0: runSliceStart, y1: curBandY });
          }
          prevSpace = run.mode;
        } else if (ri === 0 && run.mode === 'linear') {
          // Linear tiers directly below acoustic track: 8px crisp vertical connector
          curBandY += LINEAR_NECK_H;
        }

        const runSliceStartY = curBandY;
        let ty = curBandY;
        if (firstTierY < 0) firstTierY = ty;
        for (let k = 0; k < run.tierIndices.length; k++) {
          const ti = run.tierIndices[k];
          const h = layoutSingleTier(ti, run.mode, ty);
          ty += h;
          if (k < run.tierIndices.length - 1) ty += TIER_GAP;
        }
        curBandY = ty;

        const lastSlice = coordSlices[coordSlices.length - 1];
        if (lastSlice && lastSlice.kind === run.mode) {
          lastSlice.y1 = curBandY;
        } else {
          coordSlices.push({ kind: run.mode, y0: runSliceStartY, y1: curBandY });
        }
      }

      tiersTopY = firstTierY >= 0 ? firstTierY : tickSpineBotY;
      tiersBottomY = curBandY;
    }

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
      tickSpineTopY,
      tickSpineBotY,
      tiersTopY,
      tiersBottomY,
      transitionNecks,
      coordSlices,
      hasMixedScales: hasMixedTiers,
      hasAnyElasticTier: visibleElasticCount > 0,
      hasAnyLinearTier: visibleLinearCount > 0,
      effectiveScaleMode,
      spineCols,
      isolatedPointTicks,
      linearSegs,
      linearXForTime,
      tiersLayout,
      displayOrder,
      finestIntervalTierIdx
    };
    curY = tiersBottomY + BAND_GAP;
    return bandObj;
  });

  const maxTransitionNecks = bandLayouts.reduce(
    (acc, band) => Math.max(acc, band.transitionNecks.length),
    0
  );

  const baseWidth = Math.max(260, Math.ceil(totalSvgW));
  const baseBottomY = Math.ceil(curY - BAND_GAP + scaleBarExtraH);
  let legendItems: LegendCatalogItem[] | null = null;
  let legendLayout: EmbeddedLegendLayout | null = null;

  if (legendConfig && legendConfig.mode !== 'off') {
    legendItems = collectActiveLegendItems(
      tg,
      { bands: bandLayouts, scaleMode: effectiveScaleMode },
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
      scaleMode: effectiveScaleMode,
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
    effectiveScaleMode,
    tierScales,
    maxTransitionNecks,
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

export function getTierScaleInBand(band: BandLayout, tierIndex: number): TierScaleMode {
  const tl = band.tiersLayout[tierIndex];
  if (tl) return tl.scaleMode;
  return band.effectiveScaleMode === 'linear' ? 'linear' : 'elastic';
}

export function xForTierTime(band: BandLayout, tierIndex: number, t: number): number {
  return getTierScaleInBand(band, tierIndex) === 'linear'
    ? band.linearXForTime(t)
    : elasticXInBand(band, t);
}

export function timeFromTierX(band: BandLayout, tierIndex: number, x: number): number {
  return getTierScaleInBand(band, tierIndex) === 'linear'
    ? timeFromLinearX(band, x)
    : timeFromElasticX(band, x);
}

export function coordSpaceAtY(band: BandLayout, y: number): TierScaleMode {
  for (const slice of band.coordSlices) {
    if (y >= slice.y0 && y <= slice.y1) {
      if (slice.kind === 'linear') return 'linear';
      if (slice.kind === 'elastic') return 'elastic';
      if (slice.kind === 'tick-spine') {
        return band.effectiveScaleMode === 'linear' ? 'linear' : 'elastic';
      }
      const mid = (slice.y0 + slice.y1) * 0.5;
      if (slice.kind === 'neck-l2e') return y <= mid ? 'linear' : 'elastic';
      return y <= mid ? 'elastic' : 'linear';
    }
  }
  return band.effectiveScaleMode === 'linear' ? 'linear' : 'elastic';
}

export interface SmartMixedScaleOptions {
  targetWidth?: number;
  fontScale?: number;
  hiddenTierIndices?: number[];
}

const ACOUSTIC_EVENT_TIER_RE =
  /event|burst|vot|onset|offset|acoustic|peak|f0|pitch|burst|release|爆破|事件|声学|极值/i;

/**
 * Automatically classifies tiers into 'linear' (1:1) vs 'elastic' (dual-scale) based on
 * linear-scale text crowding / overflow rate and tier granularity:
 * - Coarse tiers (utterances, sentences, words) and sparse acoustic-event point tiers -> 'linear'
 * - High-density phone / IPA / syllable tiers with text overflow at 1:1 scale -> 'elastic'
 */
export function computeSmartMixedTierScales(
  tg: TextGrid,
  opts: SmartMixedScaleOptions = {}
): Record<string, TierScaleMode> {
  const result: Record<string, TierScaleMode> = {};
  if (!tg.tiers.length) return result;

  const targetWidth = opts.targetWidth ?? 1080;
  const fontScale = opts.fontScale ?? 1;
  const hiddenSet = new Set(opts.hiddenTierIndices ?? []);
  const totalDur = Math.max(0.05, (Number.isFinite(tg.xmax) ? tg.xmax : 1) - (Number.isFinite(tg.xmin) ? tg.xmin : 0));
  const contentW = Math.max(240, targetWidth - 180);
  const estPxPerSec = Math.max(180, Math.min(360, contentW / Math.min(totalDur, 4.5)));

  const textFont = fontScale !== 1 ? `${(12.5 * fontScale).toFixed(2)}px ${IPA_FONT_STACK}` : FONT_TEXT;
  const ptFont = fontScale !== 1 ? `${(11.5 * fontScale).toFixed(2)}px ${IPA_FONT_STACK}` : FONT_PT;

  interface TierMetrics {
    ti: number;
    key: string;
    kind: Tier['kind'];
    count: number;
    overflowRate: number;
    avgDur: number;
    assigned: TierScaleMode;
  }

  const metrics: TierMetrics[] = [];

  for (let ti = 0; ti < tg.tiers.length; ti++) {
    const tier = tg.tiers[ti];
    const key = resolveTierScaleKey(tg, ti);

    if (tier.kind === 'intervalTier') {
      const nonEmpty = tier.intervals.filter(
        (iv) => Number.isFinite(iv.xmin) && Number.isFinite(iv.xmax) && iv.xmax > iv.xmin && iv.text.trim() !== ''
      );
      if (nonEmpty.length === 0) {
        metrics.push({ ti, key, kind: tier.kind, count: 0, overflowRate: 0, avgDur: totalDur, assigned: 'linear' });
        continue;
      }
      let overflowCount = 0;
      let durSum = 0;
      for (const iv of nonEmpty) {
        const dt = iv.xmax - iv.xmin;
        durSum += dt;
        const linW = dt * estPxPerSec;
        const needW = measurePx(iv.text.trim(), textFont) + 12;
        if (needW > linW * 1.05 || linW < 18) {
          overflowCount++;
        }
      }
      const overflowRate = overflowCount / nonEmpty.length;
      const avgDur = durSum / nonEmpty.length;
      const isElastic =
        overflowRate >= 0.22 || (nonEmpty.length >= 4 && avgDur < 0.14 && overflowRate >= 0.12);
      metrics.push({
        ti,
        key,
        kind: tier.kind,
        count: nonEmpty.length,
        overflowRate,
        avgDur,
        assigned: isElastic ? 'elastic' : 'linear'
      });
    } else {
      const pts = tier.points
        .filter((p) => Number.isFinite(p.number))
        .slice()
        .sort((a, b) => a.number - b.number);
      const marked = pts.filter((p) => p.mark.trim() !== '');
      if (marked.length < 2) {
        metrics.push({ ti, key, kind: tier.kind, count: pts.length, overflowRate: 0, avgDur: totalDur, assigned: 'linear' });
        continue;
      }
      const widths = marked.map((p) => Math.max(18, Math.ceil(measurePx(p.mark.trim(), ptFont)) + 10));
      let crowdPairs = 0;
      for (let i = 0; i < marked.length - 1; i++) {
        const dxLin = (marked[i + 1].number - marked[i].number) * estPxPerSec;
        const needDist = (widths[i] + widths[i + 1]) / 2 + 3;
        if (dxLin < needDist) crowdPairs++;
      }
      const crowdRate = crowdPairs / (marked.length - 1);
      const acousticHint = ACOUSTIC_EVENT_TIER_RE.test(tier.name);
      const isElastic = !acousticHint && crowdRate >= 0.35;
      metrics.push({
        ti,
        key,
        kind: tier.kind,
        count: pts.length,
        overflowRate: crowdRate,
        avgDur: totalDur / Math.max(1, pts.length),
        assigned: isElastic ? 'elastic' : 'linear'
      });
    }
  }

  // Fallback contrast guard: if >= 2 visible tiers all ended up in the same bucket despite clear
  // granularity differences, keep the coarsest tier linear and the finest interval tier elastic.
  const visibleMetrics = metrics.filter((m) => !hiddenSet.has(m.ti));
  if (visibleMetrics.length >= 2) {
    const allSame = visibleMetrics.every((m) => m.assigned === visibleMetrics[0].assigned);
    if (allSame) {
      const ivMetrics = visibleMetrics.filter((m) => m.kind === 'intervalTier' && m.count > 0);
      if (ivMetrics.length >= 2) {
        const sortedByDensity = ivMetrics
          .slice()
          .sort((a, b) => a.count - b.count || b.avgDur - a.avgDur || a.ti - b.ti);
        const coarsest = sortedByDensity[0];
        const finest = sortedByDensity[sortedByDensity.length - 1];
        if (finest.count >= coarsest.count * 1.5 || finest.overflowRate > coarsest.overflowRate + 0.08) {
          coarsest.assigned = 'linear';
          finest.assigned = 'elastic';
        }
      } else if (visibleMetrics.some((m) => m.kind === 'textTier') && ivMetrics.length >= 1) {
        const ptMetric = visibleMetrics.find((m) => m.kind === 'textTier')!;
        const ivMetric = ivMetrics[0];
        ptMetric.assigned = 'linear';
        ivMetric.assigned = 'elastic';
      }
    }
  }

  for (const m of metrics) {
    result[m.key] = m.assigned;
  }
  return result;
}
