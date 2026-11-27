import type { TextGrid, Tier } from '../bridge/types';

export const BLOCK_ALIGN_EPS = 1e-5;
export const BLOCK_MIN_SEG_DUR = 0.001;

export interface BlockAnchorSpan {
  xmin: number;
  xmax: number;
  tierIndex?: number;
  itemIndex?: number;
}

export interface AlignedBlockIntervalSlice {
  tierIndex: number;
  tierName: string;
  startItemIndex: number;
  endItemIndex: number;
  isExactSingle: boolean;
  interiorTimes: number[];
  prevItemIndex: number | null;
  prevIsEmpty: boolean;
  nextItemIndex: number | null;
  nextIsEmpty: boolean;
}

export interface AlignedBlockPointSlice {
  tierIndex: number;
  tierName: string;
  pointIndices: number[];
}

export interface AlignedBlock {
  xmin: number;
  xmax: number;
  anchorTierIndex: number;
  anchorItemIndex: number;
  intervalSlices: AlignedBlockIntervalSlice[];
  pointSlices: AlignedBlockPointSlice[];
  tierIndices: number[];
}

export interface BlockSafeBounds {
  minXmin: number;
  maxXmax: number;
  minDuration: number;
  maxSubIntervalCount: number;
  leftBlockerTierIndex: number | null;
  leftBlockerTierName: string | null;
  leftBlockerIsNonEmpty: boolean;
  rightBlockerTierIndex: number | null;
  rightBlockerTierName: string | null;
  rightBlockerIsNonEmpty: boolean;
}

export type BlockTransformMode = 'move' | 'resize' | 'remap';

export interface BlockClampResult {
  targetXmin: number;
  targetXmax: number;
  clampedLeft: boolean;
  clampedRight: boolean;
  clampedMinWidth: boolean;
  blockerTierIndex: number | null;
  blockerTierName: string | null;
  changed: boolean;
}

export interface AppliedBlockTransformResult {
  changed: boolean;
  nextAnchorItemIndex: number;
  affectedTierCount: number;
  finalXmin: number;
  finalXmax: number;
}

export interface ResolvedBoundaryBlock {
  block: AlignedBlock;
  side: 'left' | 'right';
}

export interface SimpleSelectionHint {
  kind: string;
  tierIndex?: number;
  itemIndex?: number;
}

function roundTime6(t: number): number {
  return Number(t.toFixed(6));
}

function formatTierNameFallback(tier: Tier, tierIndex: number): string {
  const trimmed = tier.name?.trim();
  return trimmed || `层 ${tierIndex + 1}`;
}

function isTierVisible(tierCount: number, tierIndex: number, hiddenSet: Set<number>): boolean {
  if (tierCount <= 0) return false;
  if (hiddenSet.size >= tierCount) {
    let allHidden = true;
    for (let i = 0; i < tierCount; i++) {
      if (!hiddenSet.has(i)) {
        allHidden = false;
        break;
      }
    }
    if (allHidden) return true;
  }
  return !hiddenSet.has(tierIndex);
}

/**
 * Identify all visible tiers participating in the aligned nested time block [xmin, xmax]:
 * - Interval tiers with either an exact matching single interval [a, b] or a contiguous
 *   sequence of sub-intervals spanning [a, b], containing at least one non-empty interval
 *   (or being the explicit anchor tier).
 * - Strictly excludes hidden tiers, wider parent tiers crossing a/b, and half-overlapping tiers.
 * - Point tiers (TextTier) with points inside [a - eps, b + eps].
 */
export function findAlignedBlock(
  tg: TextGrid,
  anchor: BlockAnchorSpan,
  hiddenTierIndices: readonly number[] = []
): AlignedBlock | null {
  const a = anchor.xmin;
  const b = anchor.xmax;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a + 1e-9) {
    return null;
  }

  const hiddenSet = new Set(hiddenTierIndices);
  const tierCount = tg.tiers.length;
  const intervalSlices: AlignedBlockIntervalSlice[] = [];
  const pointSlices: AlignedBlockPointSlice[] = [];

  for (let ti = 0; ti < tierCount; ti++) {
    if (!isTierVisible(tierCount, ti, hiddenSet)) continue;
    const tier = tg.tiers[ti];
    const tierName = formatTierNameFallback(tier, ti);

    if (tier.kind === 'intervalTier') {
      const ivs = tier.intervals;
      if (ivs.length === 0) continue;

      let startIdx = -1;
      for (let i = 0; i < ivs.length; i++) {
        if (Math.abs(ivs[i].xmin - a) <= BLOCK_ALIGN_EPS && ivs[i].xmax > ivs[i].xmin + 1e-12) {
          startIdx = i;
          break;
        }
      }
      if (startIdx === -1) continue;

      let endIdx = -1;
      for (let j = startIdx; j < ivs.length; j++) {
        if (j > startIdx && Math.abs(ivs[j - 1].xmax - ivs[j].xmin) > BLOCK_ALIGN_EPS) {
          break;
        }
        if (Math.abs(ivs[j].xmax - b) <= BLOCK_ALIGN_EPS) {
          endIdx = j;
          break;
        }
        if (ivs[j].xmax > b + BLOCK_ALIGN_EPS) {
          break;
        }
      }
      if (endIdx === -1 || endIdx < startIdx) continue;

      let hasNonEmpty = false;
      for (let k = startIdx; k <= endIdx; k++) {
        if (ivs[k].text !== '') {
          hasNonEmpty = true;
          break;
        }
      }
      if (!hasNonEmpty && ti !== anchor.tierIndex) {
        continue;
      }

      const interiorTimes: number[] = [];
      for (let k = startIdx; k < endIdx; k++) {
        interiorTimes.push(ivs[k].xmax);
      }

      const prevItemIndex =
        startIdx > 0 && Math.abs(ivs[startIdx - 1].xmax - ivs[startIdx].xmin) <= BLOCK_ALIGN_EPS
          ? startIdx - 1
          : null;
      const prevIsEmpty = prevItemIndex !== null && ivs[prevItemIndex].text === '';

      const nextItemIndex =
        endIdx + 1 < ivs.length &&
        Math.abs(ivs[endIdx + 1].xmin - ivs[endIdx].xmax) <= BLOCK_ALIGN_EPS
          ? endIdx + 1
          : null;
      const nextIsEmpty = nextItemIndex !== null && ivs[nextItemIndex].text === '';

      intervalSlices.push({
        tierIndex: ti,
        tierName,
        startItemIndex: startIdx,
        endItemIndex: endIdx,
        isExactSingle: startIdx === endIdx,
        interiorTimes,
        prevItemIndex,
        prevIsEmpty,
        nextItemIndex,
        nextIsEmpty
      });
    } else if (tier.kind === 'textTier') {
      const pointIndices: number[] = [];
      for (let pi = 0; pi < tier.points.length; pi++) {
        const t = tier.points[pi].number;
        if (Number.isFinite(t) && t >= a - BLOCK_ALIGN_EPS && t <= b + BLOCK_ALIGN_EPS) {
          pointIndices.push(pi);
        }
      }
      if (pointIndices.length > 0) {
        pointSlices.push({
          tierIndex: ti,
          tierName,
          pointIndices
        });
      }
    }
  }

  if (intervalSlices.length === 0) {
    return null;
  }

  const anchorSlice =
    (anchor.tierIndex !== undefined
      ? intervalSlices.find((s) => s.tierIndex === anchor.tierIndex)
      : undefined) ??
    intervalSlices.find((s) => s.isExactSingle) ??
    intervalSlices[0];

  const anchorItemIndex =
    anchor.tierIndex === anchorSlice.tierIndex &&
    anchor.itemIndex !== undefined &&
    anchor.itemIndex >= anchorSlice.startItemIndex &&
    anchor.itemIndex <= anchorSlice.endItemIndex
      ? anchor.itemIndex
      : anchorSlice.startItemIndex;

  const tierIndices = [
    ...intervalSlices.map((s) => s.tierIndex),
    ...pointSlices.map((s) => s.tierIndex)
  ].sort((x, y) => x - y);

  return {
    xmin: a,
    xmax: b,
    anchorTierIndex: anchorSlice.tierIndex,
    anchorItemIndex,
    intervalSlices,
    pointSlices,
    tierIndices
  };
}

/**
 * Compute the intersection of safe movement bounds [minXmin, maxXmax] across all
 * participating tiers in the aligned block:
 * - Adjacent empty intervals may be consumed completely down to their far edge.
 * - Adjacent non-empty intervals act as a hard stop (Hard Clamp) at block.xmin / block.xmax.
 * - Enforces minimum total width based on maximum sub-interval count across fine tiers.
 */
export function computeBlockSafeBounds(
  tg: TextGrid,
  block: AlignedBlock,
  minSegDur = BLOCK_MIN_SEG_DUR
): BlockSafeBounds {
  let minXmin = Number.isFinite(tg.xmin) ? tg.xmin : -Infinity;
  let maxXmax = Number.isFinite(tg.xmax) ? tg.xmax : Infinity;
  let maxSubIntervalCount = 1;

  let leftBlockerTierIndex: number | null = null;
  let leftBlockerTierName: string | null = null;
  let leftBlockerIsNonEmpty = false;

  let rightBlockerTierIndex: number | null = null;
  let rightBlockerTierName: string | null = null;
  let rightBlockerIsNonEmpty = false;

  for (const slice of block.intervalSlices) {
    const tier = tg.tiers[slice.tierIndex];
    if (!tier || tier.kind !== 'intervalTier') continue;

    const subCount = slice.endItemIndex - slice.startItemIndex + 1;
    if (subCount > maxSubIntervalCount) {
      maxSubIntervalCount = subCount;
    }

    let tierMin: number;
    let tierLeftNonEmpty = false;
    if (slice.prevItemIndex !== null) {
      const prevIv = tier.intervals[slice.prevItemIndex];
      if (slice.prevIsEmpty) {
        tierMin = prevIv.xmin;
      } else {
        tierMin = block.xmin;
        tierLeftNonEmpty = true;
      }
    } else if (slice.startItemIndex > 0) {
      tierMin = Math.max(tier.xmin, tier.intervals[slice.startItemIndex - 1].xmax);
    } else {
      tierMin = tier.xmin;
    }

    if (
      tierMin > minXmin + 1e-12 ||
      (Math.abs(tierMin - minXmin) <= 1e-12 && tierLeftNonEmpty && !leftBlockerIsNonEmpty)
    ) {
      minXmin = tierMin;
      leftBlockerTierIndex = slice.tierIndex;
      leftBlockerTierName = slice.tierName;
      leftBlockerIsNonEmpty = tierLeftNonEmpty;
    }

    let tierMax: number;
    let tierRightNonEmpty = false;
    if (slice.nextItemIndex !== null) {
      const nextIv = tier.intervals[slice.nextItemIndex];
      if (slice.nextIsEmpty) {
        tierMax = nextIv.xmax;
      } else {
        tierMax = block.xmax;
        tierRightNonEmpty = true;
      }
    } else if (slice.endItemIndex + 1 < tier.intervals.length) {
      tierMax = Math.min(tier.xmax, tier.intervals[slice.endItemIndex + 1].xmin);
    } else {
      tierMax = tier.xmax;
    }

    if (
      tierMax < maxXmax - 1e-12 ||
      (Math.abs(tierMax - maxXmax) <= 1e-12 && tierRightNonEmpty && !rightBlockerIsNonEmpty)
    ) {
      maxXmax = tierMax;
      rightBlockerTierIndex = slice.tierIndex;
      rightBlockerTierName = slice.tierName;
      rightBlockerIsNonEmpty = tierRightNonEmpty;
    }
  }

  for (const ps of block.pointSlices) {
    const tier = tg.tiers[ps.tierIndex];
    if (!tier) continue;
    if (Number.isFinite(tier.xmin) && tier.xmin > minXmin + 1e-12) {
      minXmin = tier.xmin;
      leftBlockerTierIndex = ps.tierIndex;
      leftBlockerTierName = ps.tierName;
      leftBlockerIsNonEmpty = false;
    }
    if (Number.isFinite(tier.xmax) && tier.xmax < maxXmax - 1e-12) {
      maxXmax = tier.xmax;
      rightBlockerTierIndex = ps.tierIndex;
      rightBlockerTierName = ps.tierName;
      rightBlockerIsNonEmpty = false;
    }
  }

  const origDur = Math.max(0, block.xmax - block.xmin);
  const rawMinDur = maxSubIntervalCount * Math.max(1e-5, minSegDur);
  const minDuration = Math.min(origDur, rawMinDur);

  return {
    minXmin,
    maxXmax,
    minDuration,
    maxSubIntervalCount,
    leftBlockerTierIndex,
    leftBlockerTierName,
    leftBlockerIsNonEmpty,
    rightBlockerTierIndex,
    rightBlockerTierName,
    rightBlockerIsNonEmpty
  };
}

/**
 * Clamp a requested target [rawXmin, rawXmax] against the block's safe bounds.
 */
export function clampBlockTargetSpan(
  block: AlignedBlock,
  safe: BlockSafeBounds,
  rawXmin: number,
  rawXmax: number,
  mode: BlockTransformMode = 'remap'
): BlockClampResult {
  const origDur = block.xmax - block.xmin;
  let targetXmin = Math.min(rawXmin, rawXmax);
  let targetXmax = Math.max(rawXmin, rawXmax);
  let clampedLeft = false;
  let clampedRight = false;
  let clampedMinWidth = false;

  if (mode === 'move') {
    const dur = origDur;
    const maxAllowedStart = safe.maxXmax - dur;
    if (maxAllowedStart < safe.minXmin - 1e-12) {
      return {
        targetXmin: block.xmin,
        targetXmax: block.xmax,
        clampedLeft: true,
        clampedRight: true,
        clampedMinWidth: false,
        blockerTierIndex: safe.leftBlockerTierIndex ?? safe.rightBlockerTierIndex,
        blockerTierName: safe.leftBlockerTierName ?? safe.rightBlockerTierName,
        changed: false
      };
    }
    if (targetXmin < safe.minXmin - 1e-12) {
      targetXmin = safe.minXmin;
      clampedLeft = true;
    }
    if (targetXmin > maxAllowedStart + 1e-12) {
      targetXmin = maxAllowedStart;
      clampedRight = true;
    }
    targetXmax = targetXmin + dur;
    if (targetXmax > safe.maxXmax) {
      targetXmax = safe.maxXmax;
      targetXmin = Math.max(safe.minXmin, targetXmax - dur);
    }
  } else {
    if (targetXmin < safe.minXmin - 1e-12) {
      targetXmin = safe.minXmin;
      clampedLeft = true;
    }
    if (targetXmax > safe.maxXmax + 1e-12) {
      targetXmax = safe.maxXmax;
      clampedRight = true;
    }
    if (targetXmin > safe.maxXmax - safe.minDuration) {
      targetXmin = Math.max(safe.minXmin, safe.maxXmax - safe.minDuration);
      clampedRight = true;
    }
    if (targetXmax < safe.minXmin + safe.minDuration) {
      targetXmax = Math.min(safe.maxXmax, safe.minXmin + safe.minDuration);
      clampedLeft = true;
    }
    if (targetXmax - targetXmin < safe.minDuration - 1e-12) {
      clampedMinWidth = true;
      const anchorLeftFixed = Math.abs(rawXmin - block.xmin) <= 1e-9;
      const anchorRightFixed = Math.abs(rawXmax - block.xmax) <= 1e-9;
      if (anchorLeftFixed && !anchorRightFixed) {
        targetXmax = Math.min(safe.maxXmax, targetXmin + safe.minDuration);
      } else if (anchorRightFixed && !anchorLeftFixed) {
        targetXmin = Math.max(safe.minXmin, targetXmax - safe.minDuration);
      } else {
        const mid = (targetXmin + targetXmax) * 0.5;
        targetXmin = Math.max(safe.minXmin, mid - safe.minDuration * 0.5);
        targetXmax = Math.min(safe.maxXmax, targetXmin + safe.minDuration);
        if (targetXmax - targetXmin < safe.minDuration) {
          targetXmin = Math.max(safe.minXmin, targetXmax - safe.minDuration);
        }
      }
    }
  }

  let blockerTierIndex: number | null = null;
  let blockerTierName: string | null = null;
  if (clampedLeft && !clampedRight) {
    blockerTierIndex = safe.leftBlockerTierIndex;
    blockerTierName = safe.leftBlockerTierName;
  } else if (clampedRight && !clampedLeft) {
    blockerTierIndex = safe.rightBlockerTierIndex;
    blockerTierName = safe.rightBlockerTierName;
  } else if (clampedLeft && clampedRight) {
    blockerTierIndex = safe.leftBlockerTierIndex ?? safe.rightBlockerTierIndex;
    blockerTierName = safe.leftBlockerTierName ?? safe.rightBlockerTierName;
  }

  const changed =
    targetXmax > targetXmin + 1e-9 &&
    (Math.abs(targetXmin - block.xmin) > 1e-9 || Math.abs(targetXmax - block.xmax) > 1e-9);

  return {
    targetXmin,
    targetXmax,
    clampedLeft,
    clampedRight,
    clampedMinWidth,
    blockerTierIndex,
    blockerTierName,
    changed
  };
}

/**
 * Map interior boundary timestamps from [oldA, oldB] to [newA, newB] via affine scaling
 * (or exact rigid shift when width is preserved), guaranteeing strict monotonicity and
 * minimum sub-interval spacing.
 */
export function remapInteriorBoundaries(
  oldA: number,
  oldB: number,
  interiorTimes: readonly number[],
  newA: number,
  newB: number,
  minSegDur = BLOCK_MIN_SEG_DUR
): number[] {
  const m = interiorTimes.length;
  if (m === 0) return [];
  const oldDur = oldB - oldA;
  const newDur = newB - newA;
  if (oldDur <= 1e-12 || newDur <= 1e-12) {
    return interiorTimes.slice();
  }

  const segCount = m + 1;
  const isPureShift = Math.abs(newDur - oldDur) <= 1e-9;
  const dt = newA - oldA;
  const scale = newDur / oldDur;
  const raw = new Array<number>(m);

  for (let i = 0; i < m; i++) {
    const t = interiorTimes[i];
    const mapped = isPureShift ? t + dt : newA + (t - oldA) * scale;
    raw[i] = newDur >= 1e-4 ? roundTime6(mapped) : mapped;
  }

  // Enforce strict monotonicity with proportional minimum segment floor
  const effMin = Math.min(minSegDur, newDur / (segCount * 2));
  const out = new Array<number>(m);
  for (let i = 0; i < m; i++) {
    const lo = (i === 0 ? newA : out[i - 1]) + effMin;
    const hi = newB - (m - i) * effMin;
    let val = raw[i];
    if (val < lo) val = lo;
    if (val > hi) val = hi;
    out[i] = val;
  }

  // Final strict monotonicity safety pass against floating-point ties
  for (let i = 0; i < m; i++) {
    const prev = i === 0 ? newA : out[i - 1];
    const next = i === m - 1 ? newB : out[i + 1];
    if (out[i] <= prev || out[i] >= next) {
      out[i] = prev + ((next - prev) * (i + 1)) / (m + 1);
    }
  }

  return out;
}

/**
 * Map a single timestamp (e.g. a TextTier point) from [oldA, oldB] to [newA, newB].
 */
export function remapTimestampInBlock(
  oldA: number,
  oldB: number,
  t: number,
  newA: number,
  newB: number
): number {
  if (Math.abs(t - oldA) <= BLOCK_ALIGN_EPS) return newA;
  if (Math.abs(t - oldB) <= BLOCK_ALIGN_EPS) return newB;
  const oldDur = oldB - oldA;
  const newDur = newB - newA;
  if (oldDur <= 1e-12 || newDur <= 1e-12) return t;
  const isPureShift = Math.abs(newDur - oldDur) <= 1e-9;
  const raw = isPureShift ? t + (newA - oldA) : newA + ((t - oldA) / oldDur) * newDur;
  const rounded = newDur >= 1e-4 ? roundTime6(raw) : raw;
  return Math.max(newA, Math.min(newB, rounded));
}

/**
 * Resolve which aligned block and which edge ('left' | 'right') should be elastically resized
 * when Mod+dragging a boundary at `origTime` on `tierIndex`.
 * Prefers the widest visible aligned block touching `origTime` (so dragging 4.75s from a fine
 * sub-tier still resizes the enclosing 3-tier block cleanly).
 */
export function resolveBlockForBoundaryDrag(
  tg: TextGrid,
  tierIndex: number,
  origTime: number,
  selection: SimpleSelectionHint | null | undefined,
  hiddenTierIndices: readonly number[] = []
): ResolvedBoundaryBlock | null {
  if (!Number.isFinite(origTime)) return null;
  const hiddenSet = new Set(hiddenTierIndices);
  const tierCount = tg.tiers.length;

  const candidates: Array<{ block: AlignedBlock; side: 'left' | 'right'; priority: number }> = [];
  const seenSpans = new Set<string>();

  const tryCandidate = (
    candTierIdx: number,
    candItemIdx: number,
    xmin: number,
    xmax: number,
    side: 'left' | 'right',
    isSelected: boolean
  ) => {
    const key = `${side}:${xmin.toFixed(6)}:${xmax.toFixed(6)}`;
    if (seenSpans.has(key)) return;
    seenSpans.add(key);

    const block = findAlignedBlock(
      tg,
      { xmin, xmax, tierIndex: candTierIdx, itemIndex: candItemIdx },
      hiddenTierIndices
    );
    if (!block) return;

    const span = xmax - xmin;
    const priority =
      (isSelected ? 1000 : 0) +
      block.intervalSlices.length * 100 +
      (block.intervalSlices.some((s) => s.interiorTimes.length > 0) ? 50 : 0) +
      span;
    candidates.push({ block, side, priority });
  };

  // First inspect the explicitly selected interval if it touches origTime
  if (
    selection &&
    selection.kind === 'interval' &&
    selection.tierIndex !== undefined &&
    selection.itemIndex !== undefined
  ) {
    const selTier = tg.tiers[selection.tierIndex];
    const selIv = selTier?.kind === 'intervalTier' ? selTier.intervals[selection.itemIndex] : null;
    if (selIv && selIv.text !== '' && selIv.xmax > selIv.xmin) {
      if (Math.abs(selIv.xmin - origTime) <= BLOCK_ALIGN_EPS) {
        tryCandidate(
          selection.tierIndex,
          selection.itemIndex,
          selIv.xmin,
          selIv.xmax,
          'left',
          true
        );
      } else if (Math.abs(selIv.xmax - origTime) <= BLOCK_ALIGN_EPS) {
        tryCandidate(
          selection.tierIndex,
          selection.itemIndex,
          selIv.xmin,
          selIv.xmax,
          'right',
          true
        );
      }
    }
  }

  // Scan all visible interval tiers for non-empty intervals starting or ending at origTime
  for (let ti = 0; ti < tierCount; ti++) {
    if (!isTierVisible(tierCount, ti, hiddenSet)) continue;
    const tier = tg.tiers[ti];
    if (tier.kind !== 'intervalTier') continue;

    for (let ii = 0; ii < tier.intervals.length; ii++) {
      const iv = tier.intervals[ii];
      if (iv.text === '' || iv.xmax <= iv.xmin) continue;
      if (Math.abs(iv.xmin - origTime) <= BLOCK_ALIGN_EPS) {
        tryCandidate(ti, ii, iv.xmin, iv.xmax, 'left', false);
      } else if (Math.abs(iv.xmax - origTime) <= BLOCK_ALIGN_EPS) {
        tryCandidate(ti, ii, iv.xmin, iv.xmax, 'right', false);
      }
    }
  }

  if (candidates.length === 0) return null;

  // Prefer candidates that include the dragged tierIndex
  const containingDragged = candidates.filter((c) =>
    c.block.intervalSlices.some((s) => s.tierIndex === tierIndex)
  );
  const pool = containingDragged.length > 0 ? containingDragged : candidates;
  pool.sort((a, b) => b.priority - a.priority);

  return { block: pool[0].block, side: pool[0].side };
}

/**
 * Apply the validated block transform to draft tiers (via `editTier` mutator callback,
 * compatible with `historyModel.produceTgMutation` and `useEditorStore.commitTgMutation`).
 * Handles:
 * - Rigid shift & proportional affine scaling of interior sub-boundaries
 * - Consuming adjacent empty intervals (`dropPrev` / `dropNext`) when flushed to their far edge
 * - Inserting new empty gap intervals when moving away from non-empty neighbors or tier bounds
 * - Remapping and re-sorting TextTier points inside the block without colliding outside points
 */
export function applyBlockTransformToDraft(
  editTier: (tierIndex: number) => Tier | undefined,
  block: AlignedBlock,
  targetXmin: number,
  targetXmax: number,
  minSegDur = BLOCK_MIN_SEG_DUR
): AppliedBlockTransformResult {
  const oldA = block.xmin;
  const oldB = block.xmax;
  if (
    !Number.isFinite(targetXmin) ||
    !Number.isFinite(targetXmax) ||
    targetXmax <= targetXmin + 1e-9 ||
    (Math.abs(targetXmin - oldA) <= 1e-9 && Math.abs(targetXmax - oldB) <= 1e-9)
  ) {
    return {
      changed: false,
      nextAnchorItemIndex: block.anchorItemIndex,
      affectedTierCount: 0,
      finalXmin: oldA,
      finalXmax: oldB
    };
  }

  let finalXmin = targetXmin;
  let finalXmax = targetXmax;

  // Snap exact flush to any empty neighbor edge across slices within tiny floating tolerance
  // so zero-width empty neighbors are cleanly dropped without leaving 1e-12 slivers.
  const flushedSliceMeta = new Map<
    number,
    { dropPrev: boolean; dropNext: boolean; prevBound?: number; nextBound?: number }
  >();

  let changed = false;
  let affectedTierCount = 0;
  let nextAnchorItemIndex = block.anchorItemIndex;

  // First pass: detect exact edge flushes across all participating slices to unify finalXmin/finalXmax
  for (const slice of block.intervalSlices) {
    const tier = editTier(slice.tierIndex);
    if (!tier || tier.kind !== 'intervalTier') continue;
    const prevIv = slice.prevItemIndex !== null ? tier.intervals[slice.prevItemIndex] : null;
    const nextIv = slice.nextItemIndex !== null ? tier.intervals[slice.nextItemIndex] : null;
    const dropPrev = Boolean(slice.prevIsEmpty && prevIv && finalXmin <= prevIv.xmin + 1e-9);
    const dropNext = Boolean(slice.nextIsEmpty && nextIv && finalXmax >= nextIv.xmax - 1e-9);
    if (dropPrev && prevIv) finalXmin = prevIv.xmin;
    if (dropNext && nextIv) finalXmax = nextIv.xmax;
    flushedSliceMeta.set(slice.tierIndex, {
      dropPrev,
      dropNext,
      prevBound: prevIv?.xmin,
      nextBound: nextIv?.xmax
    });
  }

  // Second pass: mutate each participating interval tier
  for (const slice of block.intervalSlices) {
    const tier = editTier(slice.tierIndex);
    if (!tier || tier.kind !== 'intervalTier') continue;

    const meta = flushedSliceMeta.get(slice.tierIndex);
    const prevIv = slice.prevItemIndex !== null ? tier.intervals[slice.prevItemIndex] : null;
    const nextIv = slice.nextItemIndex !== null ? tier.intervals[slice.nextItemIndex] : null;
    const dropPrev = Boolean(
      meta?.dropPrev || (slice.prevIsEmpty && prevIv && finalXmin <= prevIv.xmin + 1e-9)
    );
    const dropNext = Boolean(
      meta?.dropNext || (slice.nextIsEmpty && nextIv && finalXmax >= nextIv.xmax - 1e-9)
    );

    const mappedInterior = remapInteriorBoundaries(
      oldA,
      oldB,
      slice.interiorTimes,
      finalXmin,
      finalXmax,
      minSegDur
    );

    const startIdx = slice.startItemIndex;
    const endIdx = slice.endItemIndex;
    const subCount = endIdx - startIdx + 1;

    for (let k = 0; k < subCount; k++) {
      const iv = tier.intervals[startIdx + k];
      iv.xmin = k === 0 ? finalXmin : mappedInterior[k - 1];
      iv.xmax = k === subCount - 1 ? finalXmax : mappedInterior[k];
    }

    // Handle right side first (indices after endIdx do not shift startIdx)
    if (dropNext && slice.nextItemIndex !== null) {
      tier.intervals.splice(slice.nextItemIndex, 1);
    } else if (slice.nextItemIndex !== null && slice.nextIsEmpty && tier.intervals[slice.nextItemIndex]) {
      tier.intervals[slice.nextItemIndex].xmin = finalXmax;
    } else if (finalXmax < oldB - 1e-9) {
      // Moved left away from a non-empty right neighbor or tier end -> fill newly opened gap with empty interval
      tier.intervals.splice(endIdx + 1, 0, {
        xmin: finalXmax,
        xmax: oldB,
        text: ''
      });
    }

    // Handle left side (may shift indices by -1 or +1)
    let indexDelta = 0;
    if (dropPrev && slice.prevItemIndex !== null) {
      tier.intervals.splice(slice.prevItemIndex, 1);
      indexDelta = -1;
    } else if (slice.prevItemIndex !== null && slice.prevIsEmpty && tier.intervals[slice.prevItemIndex]) {
      tier.intervals[slice.prevItemIndex].xmax = finalXmin;
    } else if (finalXmin > oldA + 1e-9) {
      // Moved right away from a non-empty left neighbor or tier start -> fill newly opened gap with empty interval
      tier.intervals.splice(startIdx, 0, {
        xmin: oldA,
        xmax: finalXmin,
        text: ''
      });
      indexDelta = 1;
    }

    if (slice.tierIndex === block.anchorTierIndex) {
      nextAnchorItemIndex = Math.max(0, block.anchorItemIndex + indexDelta);
    }

    changed = true;
    affectedTierCount++;
  }

  // Third pass: mutate participating point tiers
  for (const ps of block.pointSlices) {
    const tier = editTier(ps.tierIndex);
    if (!tier || tier.kind !== 'textTier') continue;

    const movingSet = new Set(ps.pointIndices);
    const outsideTimes = tier.points
      .filter((_, idx) => !movingSet.has(idx))
      .map((p) => p.number);

    let tierTouched = false;
    for (const pi of ps.pointIndices) {
      const pt = tier.points[pi];
      if (!pt) continue;
      let nextT = remapTimestampInBlock(oldA, oldB, pt.number, finalXmin, finalXmax);
      // Avoid exact timestamp collision with outside points
      if (outsideTimes.some((ot) => Math.abs(ot - nextT) < 1e-6)) {
        const nudgedRight = nextT + 1e-5;
        const nudgedLeft = nextT - 1e-5;
        if (
          nudgedRight <= finalXmax &&
          !outsideTimes.some((ot) => Math.abs(ot - nudgedRight) < 1e-6)
        ) {
          nextT = roundTime6(nudgedRight);
        } else if (
          nudgedLeft >= finalXmin &&
          !outsideTimes.some((ot) => Math.abs(ot - nudgedLeft) < 1e-6)
        ) {
          nextT = roundTime6(nudgedLeft);
        }
      }
      if (Math.abs(nextT - pt.number) > 1e-12) {
        pt.number = nextT;
        tierTouched = true;
      }
    }

    if (tierTouched) {
      tier.points.sort((a, b) => a.number - b.number);
      changed = true;
      affectedTierCount++;
    }
  }

  return {
    changed,
    nextAnchorItemIndex,
    affectedTierCount,
    finalXmin,
    finalXmax
  };
}
