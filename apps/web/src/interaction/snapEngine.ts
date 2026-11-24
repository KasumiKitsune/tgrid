import type { TextGrid } from '../bridge/types';
import { elasticXInBand, type BandLayout } from '../layout/computeLayout';

export type SnapTargetKind =
  | 'cross-tier-boundary'
  | 'slot-edge'
  | 'point'
  | 'play-range'
  | 'playhead';

export interface SnapResult {
  t: number;
  x: number;
  linX: number;
  kind: SnapTargetKind;
  priority: number;
  label: string;
  sourceTiers: string[];
  exact: boolean;
  distPx: number;
}

export interface SnapContext {
  tg: TextGrid;
  band: BandLayout;
  pointerX: number;
  fromSpec: boolean;
  minAllowed: number;
  maxAllowed: number;
  allowEndpoints?: boolean;
  activeTierIndex?: number;
  excludeOwnBoundaryTime?: number;
  excludePoint?: { tierIndex: number; time: number };
  slotEdges?: number[];
  playRange?: { start: number; end: number } | null;
  currentTime?: number;
  showPlayhead?: boolean;
  bypassAlt?: boolean;
  stickyTime?: number | null;
  hiddenTierIndices?: number[];
}

export interface DualEdgeSnapContext {
  tg: TextGrid;
  band: BandLayout;
  rawXmin: number;
  duration: number;
  fromSpec: boolean;
  minXmin: number;
  maxXmax: number;
  activeTierIndex?: number;
  excludeStartTime?: number;
  excludeEndTime?: number;
  slotEdges?: number[];
  playRange?: { start: number; end: number } | null;
  currentTime?: number;
  showPlayhead?: boolean;
  bypassAlt?: boolean;
  stickyStartTime?: number | null;
  stickyEndTime?: number | null;
  hiddenTierIndices?: number[];
}

export interface DualEdgeSnapResult {
  newXmin: number;
  newXmax: number;
  startSnap: SnapResult | null;
  endSnap: SnapResult | null;
}

interface RawCandidate {
  t: number;
  kind: SnapTargetKind;
  priority: number;
  label: string;
  tierName?: string;
}

interface MergedCandidate {
  t: number;
  kind: SnapTargetKind;
  priority: number;
  label: string;
  sourceTiers: string[];
  x: number;
  linX: number;
  targetX: number;
  distPx: number;
}

const TIME_COINCIDE_EPS = 1e-12;
const STRICT_BOUND_EPS = 1e-9;

function formatTierNamesLabel(names: string[], suffix = ''): string {
  if (names.length === 0) return suffix ? `对齐${suffix}` : '对齐边界';
  if (names.length === 1) return `对齐「${names[0]}」${suffix}`;
  if (names.length === 2) return `对齐「${names[0]} · ${names[1]}」${suffix}`;
  return `对齐「${names[0]} · ${names[1]}」等 ${names.length} 层${suffix}`;
}

export function resolveSnap(ctx: SnapContext): SnapResult | null {
  if (ctx.bypassAlt) return null;

  const { tg, band, pointerX, fromSpec, minAllowed, maxAllowed, allowEndpoints = false } = ctx;
  const hiddenSet = new Set(ctx.hiddenTierIndices ?? []);
  const allHidden = tg.tiers.length > 0 && tg.tiers.every((_, i) => hiddenSet.has(i));
  const isTierVisible = (ti: number) => allHidden || !hiddenSet.has(ti);

  const isAllowed = (t: number): boolean => {
    if (!Number.isFinite(t)) return false;
    if (t < band.startT - STRICT_BOUND_EPS || t > band.endT + STRICT_BOUND_EPS) return false;
    if (allowEndpoints) {
      return t >= minAllowed - TIME_COINCIDE_EPS && t <= maxAllowed + TIME_COINCIDE_EPS;
    }
    return t > minAllowed + STRICT_BOUND_EPS && t < maxAllowed - STRICT_BOUND_EPS;
  };

  const slotEdges = ctx.slotEdges ?? [];
  const isSlotEdge = (t: number) =>
    slotEdges.some((se) => Number.isFinite(se) && Math.abs(se - t) <= TIME_COINCIDE_EPS);

  const raw: RawCandidate[] = [];

  // P1: Interval boundaries on visible IntervalTiers
  for (let ti = 0; ti < tg.tiers.length; ti++) {
    if (!isTierVisible(ti)) continue;
    const tier = tg.tiers[ti];
    if (tier.kind !== 'intervalTier') continue;
    const tierName = tier.name || `层 ${ti + 1}`;
    const seen = new Set<number>();
    const addBoundary = (t: number) => {
      if (!isAllowed(t) || seen.has(t)) return;
      if (ti === ctx.activeTierIndex) {
        if (
          ctx.excludeOwnBoundaryTime !== undefined &&
          Math.abs(t - ctx.excludeOwnBoundaryTime) <= TIME_COINCIDE_EPS
        ) {
          return;
        }
        if (isSlotEdge(t)) return;
      }
      seen.add(t);
      raw.push({
        t,
        kind: 'cross-tier-boundary',
        priority: 1,
        label: '',
        tierName
      });
    };

    addBoundary(tier.xmin);
    addBoundary(tier.xmax);
    for (const iv of tier.intervals) {
      addBoundary(iv.xmin);
      addBoundary(iv.xmax);
    }
  }

  // P2: Active slot edges
  for (const se of slotEdges) {
    if (!isAllowed(se)) continue;
    raw.push({
      t: se,
      kind: 'slot-edge',
      priority: 2,
      label: '对齐 本层边界'
    });
  }

  // P3: Points on visible TextTiers
  for (let ti = 0; ti < tg.tiers.length; ti++) {
    if (!isTierVisible(ti)) continue;
    const tier = tg.tiers[ti];
    if (tier.kind !== 'textTier') continue;
    const tierName = tier.name || `层 ${ti + 1}`;
    for (const pt of tier.points) {
      if (
        ctx.excludePoint &&
        ctx.excludePoint.tierIndex === ti &&
        Math.abs(pt.number - ctx.excludePoint.time) <= TIME_COINCIDE_EPS
      ) {
        continue;
      }
      if (!isAllowed(pt.number)) continue;
      raw.push({
        t: pt.number,
        kind: 'point',
        priority: 3,
        label: '',
        tierName
      });
    }
  }

  // P4: Play range & playhead reference lines
  if (ctx.playRange) {
    if (isAllowed(ctx.playRange.start)) {
      raw.push({
        t: ctx.playRange.start,
        kind: 'play-range',
        priority: 4,
        label: '对齐 选区起点'
      });
    }
    if (isAllowed(ctx.playRange.end)) {
      raw.push({
        t: ctx.playRange.end,
        kind: 'play-range',
        priority: 4,
        label: '对齐 选区终点'
      });
    }
  }
  if (ctx.showPlayhead && ctx.currentTime !== undefined && isAllowed(ctx.currentTime)) {
    raw.push({
      t: ctx.currentTime,
      kind: 'playhead',
      priority: 4,
      label: '对齐 播放头'
    });
  }

  if (raw.length === 0) return null;

  // Sort by timestamp and group coincident timestamps (<= 1e-12)
  raw.sort((a, b) => a.t - b.t || a.priority - b.priority);

  const merged: MergedCandidate[] = [];
  let gi = 0;
  while (gi < raw.length) {
    const groupStart = gi;
    const anchorT = raw[gi].t;
    gi++;
    while (gi < raw.length && Math.abs(raw[gi].t - anchorT) <= TIME_COINCIDE_EPS) {
      gi++;
    }

    let bestPriority = Infinity;
    for (let k = groupStart; k < gi; k++) {
      if (raw[k].priority < bestPriority) bestPriority = raw[k].priority;
    }

    let rep = raw[groupStart];
    for (let k = groupStart; k < gi; k++) {
      if (raw[k].priority === bestPriority) {
        rep = raw[k];
        break;
      }
    }

    const sourceTiers: string[] = [];
    if (bestPriority === 1 || bestPriority === 3) {
      const seenNames = new Set<string>();
      for (let k = groupStart; k < gi; k++) {
        const item = raw[k];
        if (item.priority === bestPriority && item.tierName && !seenNames.has(item.tierName)) {
          seenNames.add(item.tierName);
          sourceTiers.push(item.tierName);
        }
      }
    }

    const label =
      bestPriority === 1
        ? formatTierNamesLabel(sourceTiers)
        : bestPriority === 3
          ? formatTierNamesLabel(sourceTiers, '标点')
          : rep.label;

    const x = elasticXInBand(band, rep.t);
    const linX = band.linearXForTime(rep.t);
    const targetX = fromSpec ? linX : x;
    merged.push({
      t: rep.t,
      kind: rep.kind,
      priority: bestPriority,
      label,
      sourceTiers,
      x,
      linX,
      targetX,
      distPx: Math.abs(pointerX - targetX)
    });
  }

  // Sort by targetX to compute unique adjacent pixel gaps
  merged.sort((a, b) => a.targetX - b.targetX || a.priority - b.priority);
  const uniqueXs: number[] = [];
  for (const c of merged) {
    if (uniqueXs.length === 0 || Math.abs(c.targetX - uniqueXs[uniqueXs.length - 1]) > 1e-6) {
      uniqueXs.push(c.targetX);
    }
  }

  const getMinAdjacentGapPx = (targetX: number): number => {
    if (uniqueXs.length <= 1) return Infinity;
    let lo = 0;
    let hi = uniqueXs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (uniqueXs[mid] < targetX - 1e-6) lo = mid + 1;
      else hi = mid;
    }
    const idx = lo;
    const leftGap = idx > 0 ? Math.abs(uniqueXs[idx] - uniqueXs[idx - 1]) : Infinity;
    const rightGap = idx < uniqueXs.length - 1 ? Math.abs(uniqueXs[idx + 1] - uniqueXs[idx]) : Infinity;
    return Math.min(leftGap, rightGap);
  };

  // Find closest candidate overall to check linear density guard if needed
  let closestCand = merged[0];
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].distPx < closestCand.distPx) closestCand = merged[i];
  }
  const closestGap = getMinAdjacentGapPx(closestCand.targetX);
  if (fromSpec && closestGap < 4) {
    return null;
  }

  const inRange: MergedCandidate[] = [];
  for (const c of merged) {
    const gap = getMinAdjacentGapPx(c.targetX);
    let tol: number;
    if (fromSpec) {
      if (gap < 4) continue;
      tol = Math.min(6, Math.max(2.5, gap * 0.35));
    } else {
      tol = Math.min(10, Math.max(4, gap * 0.42));
    }
    const isSticky =
      ctx.stickyTime != null && Math.abs(c.t - ctx.stickyTime) <= TIME_COINCIDE_EPS;
    const effTol = tol + (isSticky ? 2 : 0);
    if (c.distPx <= effTol) {
      inRange.push(c);
    }
  }

  if (inRange.length === 0) return null;

  let bestDist = Infinity;
  for (const c of inRange) {
    if (c.distPx < bestDist) bestDist = c.distPx;
  }

  const eligible = inRange.filter((c) => c.distPx <= bestDist + 2);
  eligible.sort((a, b) => a.priority - b.priority || a.distPx - b.distPx);
  const win = eligible[0];

  return {
    t: win.t,
    x: win.x,
    linX: win.linX,
    kind: win.kind,
    priority: win.priority,
    label: win.label,
    sourceTiers: win.sourceTiers,
    exact: true,
    distPx: win.distPx
  };
}

function probeCoincidentEdgeSnap(
  ctx: DualEdgeSnapContext,
  edgeTime: number,
  minAllowed: number,
  maxAllowed: number,
  excludeOwnBoundaryTime?: number
): SnapResult | null {
  const ptrX = ctx.fromSpec
    ? ctx.band.linearXForTime(edgeTime)
    : elasticXInBand(ctx.band, edgeTime);
  const res = resolveSnap({
    tg: ctx.tg,
    band: ctx.band,
    pointerX: ptrX,
    fromSpec: ctx.fromSpec,
    minAllowed,
    maxAllowed,
    allowEndpoints: true,
    activeTierIndex: ctx.activeTierIndex,
    excludeOwnBoundaryTime,
    slotEdges: ctx.slotEdges,
    playRange: ctx.playRange,
    currentTime: ctx.currentTime,
    showPlayhead: ctx.showPlayhead,
    bypassAlt: false,
    stickyTime: edgeTime,
    hiddenTierIndices: ctx.hiddenTierIndices
  });
  if (res && Math.abs(res.t - edgeTime) <= STRICT_BOUND_EPS) {
    return res;
  }
  return null;
}

export function resolveDualEdgeSnap(ctx: DualEdgeSnapContext): DualEdgeSnapResult {
  const maxStart = Math.max(ctx.minXmin, ctx.maxXmax - ctx.duration);
  const clampedStart = Math.max(ctx.minXmin, Math.min(maxStart, ctx.rawXmin));
  const clampedEnd = clampedStart + ctx.duration;

  if (ctx.bypassAlt || !Number.isFinite(ctx.duration) || ctx.duration <= 0) {
    return {
      newXmin: clampedStart,
      newXmax: clampedEnd,
      startSnap: null,
      endSnap: null
    };
  }

  const startPtrX = ctx.fromSpec
    ? ctx.band.linearXForTime(clampedStart)
    : elasticXInBand(ctx.band, clampedStart);
  const endPtrX = ctx.fromSpec
    ? ctx.band.linearXForTime(clampedEnd)
    : elasticXInBand(ctx.band, clampedEnd);

  const startCand = resolveSnap({
    tg: ctx.tg,
    band: ctx.band,
    pointerX: startPtrX,
    fromSpec: ctx.fromSpec,
    minAllowed: ctx.minXmin,
    maxAllowed: maxStart,
    allowEndpoints: true,
    activeTierIndex: ctx.activeTierIndex,
    excludeOwnBoundaryTime: ctx.excludeStartTime,
    slotEdges: ctx.slotEdges,
    playRange: ctx.playRange,
    currentTime: ctx.currentTime,
    showPlayhead: ctx.showPlayhead,
    bypassAlt: false,
    stickyTime: ctx.stickyStartTime,
    hiddenTierIndices: ctx.hiddenTierIndices
  });

  const endCand = resolveSnap({
    tg: ctx.tg,
    band: ctx.band,
    pointerX: endPtrX,
    fromSpec: ctx.fromSpec,
    minAllowed: ctx.minXmin + ctx.duration,
    maxAllowed: ctx.maxXmax,
    allowEndpoints: true,
    activeTierIndex: ctx.activeTierIndex,
    excludeOwnBoundaryTime: ctx.excludeEndTime,
    slotEdges: ctx.slotEdges,
    playRange: ctx.playRange,
    currentTime: ctx.currentTime,
    showPlayhead: ctx.showPlayhead,
    bypassAlt: false,
    stickyTime: ctx.stickyEndTime,
    hiddenTierIndices: ctx.hiddenTierIndices
  });

  if (!startCand && !endCand) {
    return {
      newXmin: clampedStart,
      newXmax: clampedEnd,
      startSnap: null,
      endSnap: null
    };
  }

  let useStart: boolean;
  if (startCand && !endCand) {
    useStart = true;
  } else if (!startCand && endCand) {
    useStart = false;
  } else {
    const s = startCand!;
    const e = endCand!;
    if (Math.abs(s.distPx - e.distPx) <= 2) {
      useStart = s.priority <= e.priority;
    } else {
      useStart = s.distPx <= e.distPx;
    }
  }

  if (useStart && startCand) {
    const newXmin = startCand.t;
    const newXmax = newXmin + ctx.duration;
    if (newXmin < ctx.minXmin - TIME_COINCIDE_EPS || newXmax > ctx.maxXmax + TIME_COINCIDE_EPS) {
      return { newXmin: clampedStart, newXmax: clampedEnd, startSnap: null, endSnap: null };
    }
    const pairedEnd =
      endCand && Math.abs(endCand.t - newXmax) <= STRICT_BOUND_EPS
        ? endCand
        : probeCoincidentEdgeSnap(
            ctx,
            newXmax,
            ctx.minXmin + ctx.duration,
            ctx.maxXmax,
            ctx.excludeEndTime
          );
    return {
      newXmin,
      newXmax: pairedEnd ? pairedEnd.t : newXmax,
      startSnap: startCand,
      endSnap: pairedEnd
    };
  }

  if (endCand) {
    const newXmax = endCand.t;
    const newXmin = newXmax - ctx.duration;
    if (newXmin < ctx.minXmin - TIME_COINCIDE_EPS || newXmax > ctx.maxXmax + TIME_COINCIDE_EPS) {
      return { newXmin: clampedStart, newXmax: clampedEnd, startSnap: null, endSnap: null };
    }
    const pairedStart =
      startCand && Math.abs(startCand.t - newXmin) <= STRICT_BOUND_EPS
        ? startCand
        : probeCoincidentEdgeSnap(ctx, newXmin, ctx.minXmin, maxStart, ctx.excludeStartTime);
    return {
      newXmin: pairedStart ? pairedStart.t : newXmin,
      newXmax,
      startSnap: pairedStart,
      endSnap: endCand
    };
  }

  return {
    newXmin: clampedStart,
    newXmax: clampedEnd,
    startSnap: null,
    endSnap: null
  };
}
