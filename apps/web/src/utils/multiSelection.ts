import type { TextGrid, Tier } from '../bridge/types';
import {
  BLOCK_ALIGN_EPS,
  BLOCK_MIN_SEG_DUR,
  remapInteriorBoundaries
} from './blockTransform.ts';

export interface IntervalRef {
  tierIndex: number;
  itemIndex: number;
}

export type MultiSelectionTopology =
  | 'none'
  | 'single'
  | 'single-tier-contiguous'
  | 'cross-tier-aligned'
  | 'cross-tier-overlapping'
  | 'disjoint';

export interface MultiSelectionUnit {
  tierIndex: number;
  tierName: string;
  startItemIndex: number;
  endItemIndex: number;
  xmin: number;
  xmax: number;
  interiorTimes: number[];
  prevItemIndex: number | null;
  prevIsEmpty: boolean;
  nextItemIndex: number | null;
  nextIsEmpty: boolean;
  /** Indices of sibling units on the same tier if adjacent through a single empty interval */
  prevSharedWithUnitIdx: number | null;
  nextSharedWithUnitIdx: number | null;
}

export interface MultiSelectionCapabilities {
  canMerge: boolean;
  canClearText: boolean;
  canGroupMove: boolean;
  canGroupResize: boolean;
  canAlignBounds: boolean;
  canSyncMove: boolean;
  canSyncEdgeResize: boolean;
  canRemapToPlayRange: boolean;
}

export interface PrimaryIntervalInfo {
  tierIndex: number;
  itemIndex: number;
  xmin: number;
  xmax: number;
  text: string;
}

export interface MultiSelectionAnalysis {
  topology: MultiSelectionTopology;
  items: IntervalRef[];
  count: number;
  tierIndices: number[];
  nonEmptyCount: number;
  units: MultiSelectionUnit[];
  envelopeXmin: number;
  envelopeXmax: number;
  primary: PrimaryIntervalInfo | null;
  capabilities: MultiSelectionCapabilities;
}

export type MultiSyncAction = 'move' | 'left-edge' | 'right-edge';

export interface MultiSyncDeltaBounds {
  minDelta: number;
  maxDelta: number;
  leftBlockerTierIndex: number | null;
  leftBlockerTierName: string | null;
  rightBlockerTierIndex: number | null;
  rightBlockerTierName: string | null;
}

export interface MultiTransformApplyResult {
  changed: boolean;
  nextItems: IntervalRef[];
  affectedTierCount: number;
}

export interface MultiAlignApplyResult {
  changed: boolean;
  nextItems: IntervalRef[];
  affectedTierCount: number;
  clampedCount: number;
  blockerTierName: string | null;
  targetXmin: number;
  targetXmax: number;
}

function roundTime6(t: number): number {
  return Number(t.toFixed(6));
}

function formatTierName(tier: Tier, tierIndex: number): string {
  const trimmed = tier.name?.trim();
  return trimmed || `层 ${tierIndex + 1}`;
}

export function sanitizeIntervalRefs(
  tg: TextGrid,
  rawItems: readonly IntervalRef[]
): IntervalRef[] {
  const seen = new Set<string>();
  const out: IntervalRef[] = [];
  for (const ref of rawItems) {
    if (!Number.isInteger(ref.tierIndex) || !Number.isInteger(ref.itemIndex)) continue;
    const tier = tg.tiers[ref.tierIndex];
    if (!tier || tier.kind !== 'intervalTier') continue;
    const iv = tier.intervals[ref.itemIndex];
    if (!iv || iv.xmax <= iv.xmin) continue;
    const key = `${ref.tierIndex}:${ref.itemIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tierIndex: ref.tierIndex, itemIndex: ref.itemIndex });
  }
  return out;
}

export function isIntervalInMultiSelection(
  items: readonly IntervalRef[],
  tierIndex: number,
  itemIndex: number
): boolean {
  return items.some((it) => it.tierIndex === tierIndex && it.itemIndex === itemIndex);
}

/**
 * Group valid selected intervals per tier into maximal contiguous runs (`MultiSelectionUnit`).
 */
export function buildMultiSelectionUnits(
  tg: TextGrid,
  items: readonly IntervalRef[]
): MultiSelectionUnit[] {
  const byTier = new Map<number, number[]>();
  for (const ref of items) {
    let arr = byTier.get(ref.tierIndex);
    if (!arr) {
      arr = [];
      byTier.set(ref.tierIndex, arr);
    }
    arr.push(ref.itemIndex);
  }

  const tierIndices = Array.from(byTier.keys()).sort((a, b) => a - b);
  const units: MultiSelectionUnit[] = [];

  for (const ti of tierIndices) {
    const tier = tg.tiers[ti];
    if (!tier || tier.kind !== 'intervalTier') continue;
    const ivs = tier.intervals;
    const sortedIdxs = Array.from(new Set(byTier.get(ti)!)).sort((a, b) => a - b);
    const tierName = formatTierName(tier, ti);

    let runStartPos = 0;
    const tierUnitStartIndex = units.length;
    while (runStartPos < sortedIdxs.length) {
      let runEndPos = runStartPos;
      while (
        runEndPos + 1 < sortedIdxs.length &&
        sortedIdxs[runEndPos + 1] === sortedIdxs[runEndPos] + 1 &&
        Math.abs(ivs[sortedIdxs[runEndPos]].xmax - ivs[sortedIdxs[runEndPos + 1]].xmin) <=
          BLOCK_ALIGN_EPS
      ) {
        runEndPos++;
      }

      const startItemIndex = sortedIdxs[runStartPos];
      const endItemIndex = sortedIdxs[runEndPos];
      const interiorTimes: number[] = [];
      for (let k = startItemIndex; k < endItemIndex; k++) {
        interiorTimes.push(ivs[k].xmax);
      }

      const prevItemIndex =
        startItemIndex > 0 &&
        Math.abs(ivs[startItemIndex - 1].xmax - ivs[startItemIndex].xmin) <= BLOCK_ALIGN_EPS
          ? startItemIndex - 1
          : null;
      const prevIsEmpty = prevItemIndex !== null && ivs[prevItemIndex].text === '';

      const nextItemIndex =
        endItemIndex + 1 < ivs.length &&
        Math.abs(ivs[endItemIndex + 1].xmin - ivs[endItemIndex].xmax) <= BLOCK_ALIGN_EPS
          ? endItemIndex + 1
          : null;
      const nextIsEmpty = nextItemIndex !== null && ivs[nextItemIndex].text === '';

      units.push({
        tierIndex: ti,
        tierName,
        startItemIndex,
        endItemIndex,
        xmin: ivs[startItemIndex].xmin,
        xmax: ivs[endItemIndex].xmax,
        interiorTimes,
        prevItemIndex,
        prevIsEmpty,
        nextItemIndex,
        nextIsEmpty,
        prevSharedWithUnitIdx: null,
        nextSharedWithUnitIdx: null
      });

      runStartPos = runEndPos + 1;
    }

    // Detect adjacent units on the same tier separated by a single shared empty interval
    for (let uIdx = tierUnitStartIndex + 1; uIdx < units.length; uIdx++) {
      const prevU = units[uIdx - 1];
      const curU = units[uIdx];
      if (
        prevU.nextItemIndex !== null &&
        prevU.nextIsEmpty &&
        prevU.nextItemIndex === curU.prevItemIndex
      ) {
        prevU.nextSharedWithUnitIdx = uIdx;
        curU.prevSharedWithUnitIdx = uIdx - 1;
      }
    }
  }

  return units;
}

/**
 * Analyze the topology of the currently multi-selected intervals and determine
 * which operations are valid and sensible.
 */
export function analyzeMultiSelection(
  tg: TextGrid,
  rawItems: readonly IntervalRef[],
  primaryRef?: IntervalRef | null,
  playRange?: { start: number; end: number } | null
): MultiSelectionAnalysis {
  const items = sanitizeIntervalRefs(tg, rawItems);
  const count = items.length;
  const emptyCaps: MultiSelectionCapabilities = {
    canMerge: false,
    canClearText: false,
    canGroupMove: false,
    canGroupResize: false,
    canAlignBounds: false,
    canSyncMove: false,
    canSyncEdgeResize: false,
    canRemapToPlayRange: false
  };

  if (count === 0) {
    return {
      topology: 'none',
      items: [],
      count: 0,
      tierIndices: [],
      nonEmptyCount: 0,
      units: [],
      envelopeXmin: 0,
      envelopeXmax: 0,
      primary: null,
      capabilities: emptyCaps
    };
  }

  const units = buildMultiSelectionUnits(tg, items);
  const tierIndices = Array.from(new Set(items.map((it) => it.tierIndex))).sort((a, b) => a - b);

  let nonEmptyCount = 0;
  let envelopeXmin = Infinity;
  let envelopeXmax = -Infinity;
  for (const ref of items) {
    const iv = tg.tiers[ref.tierIndex].intervals[ref.itemIndex];
    if (iv.text !== '') nonEmptyCount++;
    if (iv.xmin < envelopeXmin) envelopeXmin = iv.xmin;
    if (iv.xmax > envelopeXmax) envelopeXmax = iv.xmax;
  }

  const resolvedPrimaryRef =
    (primaryRef &&
      items.find(
        (it) => it.tierIndex === primaryRef.tierIndex && it.itemIndex === primaryRef.itemIndex
      )) ||
    items[items.length - 1];
  const pIv = tg.tiers[resolvedPrimaryRef.tierIndex].intervals[resolvedPrimaryRef.itemIndex];
  const primary: PrimaryIntervalInfo = {
    tierIndex: resolvedPrimaryRef.tierIndex,
    itemIndex: resolvedPrimaryRef.itemIndex,
    xmin: pIv.xmin,
    xmax: pIv.xmax,
    text: pIv.text
  };

  if (count === 1) {
    return {
      topology: 'single',
      items,
      count: 1,
      tierIndices,
      nonEmptyCount,
      units,
      envelopeXmin,
      envelopeXmax,
      primary,
      capabilities: {
        ...emptyCaps,
        canClearText: nonEmptyCount > 0
      }
    };
  }

  const hasValidRange = Boolean(playRange && playRange.end - playRange.start >= 0.001);
  const rangeDiffersFromEnvelope = Boolean(
    hasValidRange &&
      playRange &&
      (Math.abs(playRange.start - envelopeXmin) > 1e-4 ||
        Math.abs(playRange.end - envelopeXmax) > 1e-4)
  );

  // 1. Single-tier contiguous
  if (tierIndices.length === 1 && units.length === 1) {
    return {
      topology: 'single-tier-contiguous',
      items,
      count,
      tierIndices,
      nonEmptyCount,
      units,
      envelopeXmin,
      envelopeXmax,
      primary,
      capabilities: {
        canMerge: true,
        canClearText: nonEmptyCount > 0,
        canGroupMove: true,
        canGroupResize: true,
        canAlignBounds: false,
        canSyncMove: true,
        canSyncEdgeResize: true,
        canRemapToPlayRange: rangeDiffersFromEnvelope
      }
    };
  }

  // Check if every participating tier has exactly 1 contiguous run
  const oneUnitPerTier = tierIndices.length >= 2 && units.length === tierIndices.length;

  if (oneUnitPerTier) {
    const firstXmin = units[0].xmin;
    const firstXmax = units[0].xmax;
    const allAligned = units.every(
      (u) =>
        Math.abs(u.xmin - firstXmin) <= BLOCK_ALIGN_EPS &&
        Math.abs(u.xmax - firstXmax) <= BLOCK_ALIGN_EPS
    );

    if (allAligned) {
      return {
        topology: 'cross-tier-aligned',
        items,
        count,
        tierIndices,
        nonEmptyCount,
        units,
        envelopeXmin,
        envelopeXmax,
        primary,
        capabilities: {
          canMerge: false,
          canClearText: nonEmptyCount > 0,
          canGroupMove: true,
          canGroupResize: true,
          canAlignBounds: false,
          canSyncMove: true,
          canSyncEdgeResize: true,
          canRemapToPlayRange: rangeDiffersFromEnvelope
        }
      };
    }

    // Check if cross-tier runs overlap in time (either common intersection or pairwise overlap chain)
    const sortedByStart = [...units].sort((a, b) => a.xmin - b.xmin);
    let maxEndSoFar = sortedByStart[0].xmax;
    let connectedOverlap = true;
    for (let i = 1; i < sortedByStart.length; i++) {
      if (sortedByStart[i].xmin >= maxEndSoFar - 1e-6) {
        connectedOverlap = false;
        break;
      }
      if (sortedByStart[i].xmax > maxEndSoFar) {
        maxEndSoFar = sortedByStart[i].xmax;
      }
    }

    if (connectedOverlap) {
      return {
        topology: 'cross-tier-overlapping',
        items,
        count,
        tierIndices,
        nonEmptyCount,
        units,
        envelopeXmin,
        envelopeXmax,
        primary,
        capabilities: {
          canMerge: false,
          canClearText: nonEmptyCount > 0,
          canGroupMove: false,
          canGroupResize: false,
          canAlignBounds: true,
          canSyncMove: true,
          canSyncEdgeResize: true,
          canRemapToPlayRange: hasValidRange
        }
      };
    }
  }

  // Otherwise: disjoint intervals (same-tier non-contiguous or cross-tier non-overlapping)
  return {
    topology: 'disjoint',
    items,
    count,
    tierIndices,
    nonEmptyCount,
    units,
    envelopeXmin,
    envelopeXmax,
    primary,
    capabilities: {
      canMerge: false,
      canClearText: nonEmptyCount > 0,
      canGroupMove: false,
      canGroupResize: false,
      canAlignBounds: false,
      canSyncMove: true,
      canSyncEdgeResize: true,
      canRemapToPlayRange: false
    }
  };
}

/**
 * Determine if a boundary (tierIndex, origTime) is the outer left or right edge
 * of one of the multi-selected units.
 */
export function resolveMultiBoundaryAction(
  units: readonly MultiSelectionUnit[],
  tierIndex: number,
  origTime: number
): { unit: MultiSelectionUnit; side: 'left' | 'right' } | null {
  for (const unit of units) {
    if (unit.tierIndex !== tierIndex) continue;
    if (Math.abs(unit.xmin - origTime) <= BLOCK_ALIGN_EPS) {
      return { unit, side: 'left' };
    }
    if (Math.abs(unit.xmax - origTime) <= BLOCK_ALIGN_EPS) {
      return { unit, side: 'right' };
    }
  }
  return null;
}

/**
 * Compute the common safe delta range [minDelta, maxDelta] across all selected units
 * for synchronized rigid translation or synchronized left/right outer-edge adjustment.
 */
export function computeMultiSyncDeltaBounds(
  tg: TextGrid,
  units: readonly MultiSelectionUnit[],
  action: MultiSyncAction,
  minSegDur = BLOCK_MIN_SEG_DUR
): MultiSyncDeltaBounds {
  let minDelta = -Infinity;
  let maxDelta = Infinity;
  let leftBlockerTierIndex: number | null = null;
  let leftBlockerTierName: string | null = null;
  let rightBlockerTierIndex: number | null = null;
  let rightBlockerTierName: string | null = null;

  for (const u of units) {
    const tier = tg.tiers[u.tierIndex];
    if (!tier || tier.kind !== 'intervalTier') continue;
    const subCount = u.endItemIndex - u.startItemIndex + 1;
    const origDur = Math.max(0, u.xmax - u.xmin);
    const minDur = Math.min(origDur, subCount * Math.max(1e-5, minSegDur));

    let uMin = -Infinity;
    let uMax = Infinity;

    if (action === 'move') {
      // If left empty gap is shared with a sibling unit moving by the same delta, the gap moves rigidly and does not constrain us
      if (u.prevSharedWithUnitIdx !== null) {
        uMin = -Infinity;
      } else if (u.prevItemIndex !== null) {
        uMin = u.prevIsEmpty ? tier.intervals[u.prevItemIndex].xmin - u.xmin : 0;
      } else if (u.startItemIndex > 0) {
        uMin = Math.max(tier.xmin, tier.intervals[u.startItemIndex - 1].xmax) - u.xmin;
      } else {
        uMin = tier.xmin - u.xmin;
      }

      if (u.nextSharedWithUnitIdx !== null) {
        uMax = Infinity;
      } else if (u.nextItemIndex !== null) {
        uMax = u.nextIsEmpty ? tier.intervals[u.nextItemIndex].xmax - u.xmax : 0;
      } else if (u.endItemIndex + 1 < tier.intervals.length) {
        uMax = Math.min(tier.xmax, tier.intervals[u.endItemIndex + 1].xmin) - u.xmax;
      } else {
        uMax = tier.xmax - u.xmax;
      }
    } else if (action === 'left-edge') {
      // Moving xmin -> xmin + delta while keeping xmax fixed
      if (u.prevItemIndex !== null) {
        uMin = u.prevIsEmpty ? tier.intervals[u.prevItemIndex].xmin - u.xmin : 0;
      } else if (u.startItemIndex > 0) {
        uMin = Math.max(tier.xmin, tier.intervals[u.startItemIndex - 1].xmax) - u.xmin;
      } else {
        uMin = tier.xmin - u.xmin;
      }
      uMax = Math.max(0, origDur - minDur);
    } else {
      // action === 'right-edge': moving xmax -> xmax + delta while keeping xmin fixed
      uMin = -Math.max(0, origDur - minDur);
      if (u.nextItemIndex !== null) {
        uMax = u.nextIsEmpty ? tier.intervals[u.nextItemIndex].xmax - u.xmax : 0;
      } else if (u.endItemIndex + 1 < tier.intervals.length) {
        uMax = Math.min(tier.xmax, tier.intervals[u.endItemIndex + 1].xmin) - u.xmax;
      } else {
        uMax = tier.xmax - u.xmax;
      }
    }

    if (uMin > minDelta + 1e-12) {
      minDelta = uMin;
      leftBlockerTierIndex = u.tierIndex;
      leftBlockerTierName = u.tierName;
    }
    if (uMax < maxDelta - 1e-12) {
      maxDelta = uMax;
      rightBlockerTierIndex = u.tierIndex;
      rightBlockerTierName = u.tierName;
    }
  }

  if (!Number.isFinite(minDelta)) minDelta = 0;
  if (!Number.isFinite(maxDelta)) maxDelta = 0;

  return {
    minDelta,
    maxDelta,
    leftBlockerTierIndex,
    leftBlockerTierName,
    rightBlockerTierIndex,
    rightBlockerTierName
  };
}

/**
 * Batch clear text across all selected intervals (single atomic draft mutation).
 */
export function applyClearMultiSelectionText(
  editTier: (tierIndex: number) => Tier | undefined,
  items: readonly IntervalRef[]
): { changed: boolean; clearedCount: number } {
  let clearedCount = 0;
  for (const ref of items) {
    const tier = editTier(ref.tierIndex);
    if (!tier || tier.kind !== 'intervalTier') continue;
    const iv = tier.intervals[ref.itemIndex];
    if (!iv || iv.text === '') continue;
    iv.text = '';
    clearedCount++;
  }
  return { changed: clearedCount > 0, clearedCount };
}

/**
 * Merge a single-tier contiguous multi-selection into one interval, joining non-empty texts in order.
 */
export function applyMergeContiguousSelection(
  editTier: (tierIndex: number) => Tier | undefined,
  analysis: MultiSelectionAnalysis
): { changed: boolean; tierIndex: number; mergedItemIndex: number; mergedCount: number } {
  if (analysis.topology !== 'single-tier-contiguous' || analysis.units.length !== 1) {
    return { changed: false, tierIndex: -1, mergedItemIndex: -1, mergedCount: 0 };
  }
  const unit = analysis.units[0];
  const tier = editTier(unit.tierIndex);
  if (!tier || tier.kind !== 'intervalTier') {
    return { changed: false, tierIndex: -1, mergedItemIndex: -1, mergedCount: 0 };
  }
  const count = unit.endItemIndex - unit.startItemIndex + 1;
  if (count < 2) {
    return { changed: false, tierIndex: -1, mergedItemIndex: -1, mergedCount: 0 };
  }
  const slice = tier.intervals.slice(unit.startItemIndex, unit.endItemIndex + 1);
  const nonEmptyTexts = slice.map((iv) => iv.text).filter((t) => t !== '');
  const mergedText = nonEmptyTexts.join(' ');
  const first = tier.intervals[unit.startItemIndex];
  const last = tier.intervals[unit.endItemIndex];
  first.xmax = last.xmax;
  first.text = mergedText;
  tier.intervals.splice(unit.startItemIndex + 1, count - 1);

  return {
    changed: true,
    tierIndex: unit.tierIndex,
    mergedItemIndex: unit.startItemIndex,
    mergedCount: count
  };
}

interface UnitTarget {
  unit: MultiSelectionUnit;
  newXmin: number;
  newXmax: number;
}

/**
 * Internal helper that applies per-unit [newXmin, newXmax] targets across tiers safely
 * (processing right-to-left within each tier to preserve lower indices during splice).
 */
function applyPerUnitTargets(
  editTier: (tierIndex: number) => Tier | undefined,
  unitTargets: readonly UnitTarget[],
  minSegDur = BLOCK_MIN_SEG_DUR
): MultiTransformApplyResult {
  const byTier = new Map<number, UnitTarget[]>();
  for (const ut of unitTargets) {
    let arr = byTier.get(ut.unit.tierIndex);
    if (!arr) {
      arr = [];
      byTier.set(ut.unit.tierIndex, arr);
    }
    arr.push(ut);
  }

  let changed = false;
  let affectedTierCount = 0;
  const nextItems: IntervalRef[] = [];

  for (const [ti, targets] of byTier.entries()) {
    const tier = editTier(ti);
    if (!tier || tier.kind !== 'intervalTier') continue;

    // Sort left-to-right first to record references to exact interval objects so we can
    // reliably recover their final indices after splices!
    targets.sort((a, b) => a.unit.startItemIndex - b.unit.startItemIndex);
    const trackedObjects: Array<Tier['intervals'][number]> = [];
    for (const ut of targets) {
      for (let k = ut.unit.startItemIndex; k <= ut.unit.endItemIndex; k++) {
        const obj = tier.intervals[k];
        if (obj) trackedObjects.push(obj);
      }
    }

    let tierChanged = false;
    // Process right-to-left so splices at higher indices never shift lower unit indices
    for (let idx = targets.length - 1; idx >= 0; idx--) {
      const { unit, newXmin: rawNewA, newXmax: rawNewB } = targets[idx];
      const oldA = unit.xmin;
      const oldB = unit.xmax;
      if (
        !Number.isFinite(rawNewA) ||
        !Number.isFinite(rawNewB) ||
        rawNewB <= rawNewA + 1e-9 ||
        (Math.abs(rawNewA - oldA) <= 1e-9 && Math.abs(rawNewB - oldB) <= 1e-9)
      ) {
        continue;
      }

      const prevIv = unit.prevItemIndex !== null ? tier.intervals[unit.prevItemIndex] : null;
      const nextIv = unit.nextItemIndex !== null ? tier.intervals[unit.nextItemIndex] : null;
      const prevIsSharedEmpty = unit.prevSharedWithUnitIdx !== null;
      const nextIsSharedEmpty = unit.nextSharedWithUnitIdx !== null;

      let finalA = rawNewA;
      let finalB = rawNewB;

      const dropPrev = Boolean(
        !prevIsSharedEmpty && unit.prevIsEmpty && prevIv && finalA <= prevIv.xmin + 1e-9
      );
      const dropNext = Boolean(
        !nextIsSharedEmpty && unit.nextIsEmpty && nextIv && finalB >= nextIv.xmax - 1e-9
      );
      if (dropPrev && prevIv) finalA = prevIv.xmin;
      if (dropNext && nextIv) finalB = nextIv.xmax;

      const mappedInterior = remapInteriorBoundaries(
        oldA,
        oldB,
        unit.interiorTimes,
        finalA,
        finalB,
        minSegDur
      );
      const subCount = unit.endItemIndex - unit.startItemIndex + 1;
      for (let k = 0; k < subCount; k++) {
        const iv = tier.intervals[unit.startItemIndex + k];
        iv.xmin = k === 0 ? finalA : mappedInterior[k - 1];
        iv.xmax = k === subCount - 1 ? finalB : mappedInterior[k];
      }

      // Right neighbor
      if (dropNext && unit.nextItemIndex !== null) {
        tier.intervals.splice(unit.nextItemIndex, 1);
      } else if (unit.nextItemIndex !== null && unit.nextIsEmpty && tier.intervals[unit.nextItemIndex]) {
        tier.intervals[unit.nextItemIndex].xmin = finalB;
      } else if (finalB < oldB - 1e-9) {
        tier.intervals.splice(unit.endItemIndex + 1, 0, {
          xmin: finalB,
          xmax: oldB,
          text: ''
        });
      }

      // Left neighbor
      if (dropPrev && unit.prevItemIndex !== null) {
        tier.intervals.splice(unit.prevItemIndex, 1);
      } else if (unit.prevItemIndex !== null && unit.prevIsEmpty && tier.intervals[unit.prevItemIndex]) {
        tier.intervals[unit.prevItemIndex].xmax = finalA;
      } else if (finalA > oldA + 1e-9) {
        tier.intervals.splice(unit.startItemIndex, 0, {
          xmin: oldA,
          xmax: finalA,
          text: ''
        });
      }

      tierChanged = true;
    }

    if (tierChanged) {
      changed = true;
      affectedTierCount++;
    }

    for (const obj of trackedObjects) {
      const finalIdx = tier.intervals.indexOf(obj);
      if (finalIdx !== -1) {
        nextItems.push({ tierIndex: ti, itemIndex: finalIdx });
      }
    }
  }

  return { changed, nextItems, affectedTierCount };
}

/**
 * Apply a synchronized delta across all selected units (rigid move or left/right edge shift).
 */
export function applyMultiSyncDelta(
  editTier: (tierIndex: number) => Tier | undefined,
  tg: TextGrid,
  units: readonly MultiSelectionUnit[],
  action: MultiSyncAction,
  rawDelta: number,
  minSegDur = BLOCK_MIN_SEG_DUR
): MultiTransformApplyResult & { finalDelta: number } {
  const bounds = computeMultiSyncDeltaBounds(tg, units, action, minSegDur);
  const clampedDelta = Math.max(bounds.minDelta, Math.min(bounds.maxDelta, rawDelta));
  if (!Number.isFinite(clampedDelta) || Math.abs(clampedDelta) <= 1e-9) {
    return {
      changed: false,
      nextItems: [],
      affectedTierCount: 0,
      finalDelta: 0
    };
  }

  const unitTargets: UnitTarget[] = units.map((unit) => {
    const newXmin =
      action === 'right-edge' ? unit.xmin : roundTime6(unit.xmin + clampedDelta);
    const newXmax =
      action === 'left-edge' ? unit.xmax : roundTime6(unit.xmax + clampedDelta);
    return { unit, newXmin, newXmax };
  });

  const res = applyPerUnitTargets(editTier, unitTargets, minSegDur);
  return { ...res, finalDelta: clampedDelta };
}

/**
 * Align all selected cross-tier units (or single-tier contiguous run) to:
 * - 'to-primary': primary selected interval's [xmin, xmax]
 * - 'to-envelope': union envelope [envelopeXmin, envelopeXmax]
 * - 'to-range': explicit custom range [start, end] (e.g. spectrogram playRange)
 */
export function applyAlignMultiSelectionBounds(
  editTier: (tierIndex: number) => Tier | undefined,
  tg: TextGrid,
  analysis: MultiSelectionAnalysis,
  mode: 'to-primary' | 'to-envelope' | 'to-range',
  customRange?: { start: number; end: number } | null,
  minSegDur = BLOCK_MIN_SEG_DUR
): MultiAlignApplyResult {
  let targetXmin: number;
  let targetXmax: number;
  if (mode === 'to-primary') {
    if (!analysis.primary) {
      return {
        changed: false,
        nextItems: analysis.items,
        affectedTierCount: 0,
        clampedCount: 0,
        blockerTierName: null,
        targetXmin: 0,
        targetXmax: 0
      };
    }
    targetXmin = analysis.primary.xmin;
    targetXmax = analysis.primary.xmax;
  } else if (mode === 'to-envelope') {
    targetXmin = analysis.envelopeXmin;
    targetXmax = analysis.envelopeXmax;
  } else {
    if (!customRange || customRange.end - customRange.start < 0.001) {
      return {
        changed: false,
        nextItems: analysis.items,
        affectedTierCount: 0,
        clampedCount: 0,
        blockerTierName: null,
        targetXmin: 0,
        targetXmax: 0
      };
    }
    targetXmin = roundTime6(customRange.start);
    targetXmax = roundTime6(customRange.end);
  }

  let clampedCount = 0;
  let blockerTierName: string | null = null;
  const unitTargets: UnitTarget[] = [];

  for (const unit of analysis.units) {
    const tier = tg.tiers[unit.tierIndex];
    if (!tier || tier.kind !== 'intervalTier') continue;
    const subCount = unit.endItemIndex - unit.startItemIndex + 1;
    const minDur = Math.min(unit.xmax - unit.xmin, subCount * Math.max(1e-5, minSegDur));

    const minAllowed =
      unit.prevItemIndex !== null
        ? unit.prevIsEmpty
          ? tier.intervals[unit.prevItemIndex].xmin
          : unit.xmin
        : unit.startItemIndex > 0
          ? Math.max(tier.xmin, tier.intervals[unit.startItemIndex - 1].xmax)
          : tier.xmin;

    const maxAllowed =
      unit.nextItemIndex !== null
        ? unit.nextIsEmpty
          ? tier.intervals[unit.nextItemIndex].xmax
          : unit.xmax
        : unit.endItemIndex + 1 < tier.intervals.length
          ? Math.min(tier.xmax, tier.intervals[unit.endItemIndex + 1].xmin)
          : tier.xmax;

    let a = targetXmin;
    let b = targetXmax;
    let clampedThis = false;
    if (a < minAllowed - 1e-12) {
      a = minAllowed;
      clampedThis = true;
    }
    if (b > maxAllowed + 1e-12) {
      b = maxAllowed;
      clampedThis = true;
    }
    if (b - a < minDur) {
      clampedThis = true;
      if (a + minDur <= maxAllowed) {
        b = a + minDur;
      } else {
        a = Math.max(minAllowed, b - minDur);
      }
    }
    if (clampedThis) {
      clampedCount++;
      if (!blockerTierName) blockerTierName = unit.tierName;
    }
    unitTargets.push({ unit, newXmin: a, newXmax: b });
  }

  const applied = applyPerUnitTargets(editTier, unitTargets, minSegDur);
  return {
    changed: applied.changed,
    nextItems: applied.changed ? applied.nextItems : analysis.items,
    affectedTierCount: applied.affectedTierCount,
    clampedCount,
    blockerTierName,
    targetXmin,
    targetXmax
  };
}
