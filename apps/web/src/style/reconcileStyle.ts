import type { Interval, TextGrid, Tier } from '../bridge/types.ts';
import { cloneStyleDocument } from './palettes.ts';
import { TIME_MATCH_EPS } from './resolveStyle.ts';
import type {
  BoundaryStyleOverride,
  IntervalStyleOverride,
  PointStyleOverride,
  ReconcileReport,
  StyleDocument,
  TierStylePatch
} from './types.ts';

const FUZZY_THRESHOLD = 0.45;
const BOUNDARY_INSIDE_EPS = 1e-6;

let splitIdSeq = 0;
function nextDerivedId(baseId: string, suffix: number): string {
  splitIdSeq += 1;
  return `${baseId}-s${suffix}-${splitIdSeq}`;
}

function normalizedLevenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 && lb === 0) return 1;
  if (la === 0 || lb === 0) return 0;

  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j;

  for (let i = 1; i <= la; i += 1) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return 1 - prev[lb] / Math.max(la, lb);
}

function intervalIoU(aMin: number, aMax: number, bMin: number, bMax: number): number {
  const inter = Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
  if (inter <= 0) return 0;
  const union = Math.max(aMax, bMax) - Math.min(aMin, bMin);
  if (union <= 0) return 0;
  return inter / union;
}

// ============================================================================
// Live edit propagation helpers (pure functions)
// ============================================================================

/**
 * Propagate interval overrides when interval `origIndex` on `tierIndex` is split
 * into `newIntervals` (length >= 1).
 * - Non-empty child segments inherit the original interval style.
 * - Empty/silence child segments do NOT inherit color blocks.
 * - Subsequent interval indices on the same tier shift by `(newIntervals.length - 1)`.
 */
export function propagateStylesOnSplit(
  doc: StyleDocument,
  tierIndex: number,
  tierName: string,
  origIndex: number,
  origXmin: number,
  origXmax: number,
  newIntervals: readonly Interval[]
): StyleDocument {
  if (newIntervals.length === 0) return doc;
  const delta = newIntervals.length - 1;
  const next = cloneStyleDocument(doc);

  let sourceOverride: IntervalStyleOverride | null = null;
  const updatedOverrides: IntervalStyleOverride[] = [];

  for (const ov of next.intervalOverrides) {
    const isSameTier = ov.tierIndex === tierIndex;
    const isTarget =
      isSameTier &&
      (ov.itemIndex === origIndex ||
        (Math.abs(ov.xmin - origXmin) <= TIME_MATCH_EPS &&
          Math.abs(ov.xmax - origXmax) <= TIME_MATCH_EPS));

    if (isTarget) {
      sourceOverride = ov;
      continue;
    }

    if (isSameTier && ov.itemIndex > origIndex) {
      updatedOverrides.push({
        ...ov,
        tierName,
        itemIndex: ov.itemIndex + delta
      });
    } else {
      updatedOverrides.push(ov);
    }
  }

  if (sourceOverride) {
    let emitted = 0;
    for (let k = 0; k < newIntervals.length; k += 1) {
      const child = newIntervals[k];
      if (child.text.trim().length === 0) continue;
      updatedOverrides.push({
        id: emitted === 0 ? sourceOverride.id : nextDerivedId(sourceOverride.id, k),
        tierIndex,
        tierName,
        itemIndex: origIndex + k,
        xmin: child.xmin,
        xmax: child.xmax,
        textSnapshot: child.text,
        style: { ...sourceOverride.style }
      });
      emitted += 1;
    }
  }

  next.intervalOverrides = updatedOverrides;
  return next;
}

/**
 * Propagate interval & boundary overrides when contiguous intervals
 * `[startIndex..endIndex]` on `tierIndex` are merged into `mergedInterval`.
 * - Priority for inherited style: `primaryIndex` (if styled) -> first non-empty styled
 *   interval -> first styled interval in range.
 * - Subsequent interval indices shift left by `(endIndex - startIndex)`.
 * - Tier-specific boundary overrides strictly inside the merged span are removed.
 */
export function propagateStylesOnMerge(
  doc: StyleDocument,
  tierIndex: number,
  tierName: string,
  startIndex: number,
  endIndex: number,
  mergedInterval: Interval,
  primaryIndex?: number
): StyleDocument {
  if (endIndex < startIndex) return doc;
  const removedCount = endIndex - startIndex;
  const next = cloneStyleDocument(doc);

  const inRange: IntervalStyleOverride[] = [];
  const kept: IntervalStyleOverride[] = [];

  for (const ov of next.intervalOverrides) {
    if (ov.tierIndex === tierIndex && ov.itemIndex >= startIndex && ov.itemIndex <= endIndex) {
      inRange.push(ov);
    } else if (ov.tierIndex === tierIndex && ov.itemIndex > endIndex) {
      kept.push({
        ...ov,
        tierName,
        itemIndex: ov.itemIndex - removedCount
      });
    } else {
      kept.push(ov);
    }
  }

  if (inRange.length > 0) {
    let chosen: IntervalStyleOverride | undefined;
    if (primaryIndex !== undefined) {
      chosen = inRange.find((o) => o.itemIndex === primaryIndex);
    }
    if (!chosen) {
      chosen = inRange.find((o) => o.textSnapshot.trim().length > 0);
    }
    if (!chosen) {
      chosen = inRange[0];
    }

    kept.push({
      id: chosen.id,
      tierIndex,
      tierName,
      itemIndex: startIndex,
      xmin: mergedInterval.xmin,
      xmax: mergedInterval.xmax,
      textSnapshot: mergedInterval.text,
      style: { ...chosen.style }
    });
  }

  next.intervalOverrides = kept;

  // Remove tier-specific boundary overrides eliminated inside the merged interval
  next.boundaryOverrides = next.boundaryOverrides.filter((b) => {
    if (b.tierIndex !== tierIndex) return true;
    return !(
      b.time > mergedInterval.xmin + BOUNDARY_INSIDE_EPS &&
      b.time < mergedInterval.xmax - BOUNDARY_INSIDE_EPS
    );
  });

  return next;
}

/**
 * Propagate boundary & adjacent interval overrides when a boundary moves from
 * `oldTime` to `newTime`. When `linked` is true, aligned boundaries & adjacent
 * interval edges across all tiers (plus shared global boundary overrides) move together.
 */
export function propagateStylesOnBoundaryMove(
  doc: StyleDocument,
  tierIndex: number,
  _tierName: string,
  oldTime: number,
  newTime: number,
  linked: boolean
): StyleDocument {
  if (Math.abs(newTime - oldTime) <= 1e-12) return doc;
  const next = cloneStyleDocument(doc);

  next.boundaryOverrides = next.boundaryOverrides.map((ov) => {
    const matchesTier = linked ? true : ov.tierIndex === tierIndex;
    if (matchesTier && Math.abs(ov.time - oldTime) <= TIME_MATCH_EPS) {
      return { ...ov, time: newTime };
    }
    return ov;
  });

  next.intervalOverrides = next.intervalOverrides.map((ov) => {
    if (!linked && ov.tierIndex !== tierIndex) return ov;
    let xmin = ov.xmin;
    let xmax = ov.xmax;
    let changed = false;
    if (Math.abs(ov.xmin - oldTime) <= TIME_MATCH_EPS) {
      xmin = newTime;
      changed = true;
    }
    if (Math.abs(ov.xmax - oldTime) <= TIME_MATCH_EPS) {
      xmax = newTime;
      changed = true;
    }
    return changed ? { ...ov, xmin, xmax } : ov;
  });

  return next;
}

/**
 * General structural change synchronizer (tier add/delete/reorder/rename,
 * arbitrary interval/point insert/delete). Remaps `#<index>` tier styles and
 * reconciles all object overrides against `nextTg`.
 */
export function propagateStylesOnTierChange(
  doc: StyleDocument,
  prevTg: TextGrid,
  nextTg: TextGrid
): StyleDocument {
  const next = cloneStyleDocument(doc);

  // Build prevTierIndex -> nextTierIndex map by (name, kind) occurrence order
  const prevToNextTier = new Map<number, number>();
  const usedNextTiers = new Set<number>();

  for (let pi = 0; pi < prevTg.tiers.length; pi += 1) {
    const pt = prevTg.tiers[pi];
    for (let ni = 0; ni < nextTg.tiers.length; ni += 1) {
      if (usedNextTiers.has(ni)) continue;
      const nt = nextTg.tiers[ni];
      if (nt.name === pt.name && nt.kind === pt.kind) {
        prevToNextTier.set(pi, ni);
        usedNextTiers.add(ni);
        break;
      }
    }
  }

  // Fallback for renamed tier at the same position with same kind
  for (let pi = 0; pi < prevTg.tiers.length; pi += 1) {
    if (prevToNextTier.has(pi)) continue;
    const pt = prevTg.tiers[pi];
    if (
      pi < nextTg.tiers.length &&
      !usedNextTiers.has(pi) &&
      nextTg.tiers[pi].kind === pt.kind
    ) {
      prevToNextTier.set(pi, pi);
      usedNextTiers.add(pi);
    }
  }

  // Remap index-keyed `#<n>` tierStyles and renamed tierStyle keys
  const remappedTierStyles: Record<string, TierStylePatch> = {};
  for (const [key, patch] of Object.entries(next.tierStyles)) {
    const idxMatch = /^#(\d+)$/.exec(key);
    if (idxMatch) {
      const oldIdx = Number(idxMatch[1]);
      const newIdx = prevToNextTier.get(oldIdx);
      if (newIdx !== undefined) {
        remappedTierStyles[`#${newIdx}`] = patch;
      }
    } else {
      // Check if tier was renamed from key -> newName
      const prevIdx = prevTg.tiers.findIndex((t) => t.name === key);
      if (prevIdx >= 0) {
        const mappedIdx = prevToNextTier.get(prevIdx);
        if (mappedIdx !== undefined) {
          remappedTierStyles[nextTg.tiers[mappedIdx].name] = patch;
        }
      } else if (nextTg.tiers.some((t) => t.name === key)) {
        remappedTierStyles[key] = patch;
      }
    }
  }
  next.tierStyles = remappedTierStyles;

  // Update tier hints on overrides before running reconciliation
  next.intervalOverrides = next.intervalOverrides.map((ov) => {
    const mapped = prevToNextTier.get(ov.tierIndex);
    if (mapped !== undefined) {
      return { ...ov, tierIndex: mapped, tierName: nextTg.tiers[mapped].name };
    }
    return ov;
  });
  next.boundaryOverrides = next.boundaryOverrides.map((ov) => {
    if (ov.tierIndex === null) return ov;
    const mapped = prevToNextTier.get(ov.tierIndex);
    if (mapped !== undefined) {
      return { ...ov, tierIndex: mapped, tierName: nextTg.tiers[mapped].name };
    }
    return ov;
  });
  next.pointOverrides = next.pointOverrides.map((ov) => {
    const mapped = prevToNextTier.get(ov.tierIndex);
    if (mapped !== undefined) {
      return { ...ov, tierIndex: mapped, tierName: nextTg.tiers[mapped].name };
    }
    return ov;
  });

  return reconcileStyleDocument(next, nextTg).doc;
}

// ============================================================================
// Three-tier external reconciliation
// ============================================================================

function findTargetTierIndex(
  tg: TextGrid,
  tierName: string,
  preferredIndex: number,
  expectedKind: Tier['kind']
): number {
  // 1. Exact name + kind match; if duplicate names exist, pick closest to preferredIndex
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < tg.tiers.length; i += 1) {
    const t = tg.tiers[i];
    if (t.kind === expectedKind && t.name === tierName) {
      const dist = Math.abs(i - preferredIndex);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
  }
  if (bestIdx >= 0) return bestIdx;

  // 2. Same preferred index & kind (tier may have been renamed externally)
  if (
    preferredIndex >= 0 &&
    preferredIndex < tg.tiers.length &&
    tg.tiers[preferredIndex].kind === expectedKind
  ) {
    return preferredIndex;
  }

  return -1;
}

function collectTierBoundaryTimes(tier: Tier): number[] {
  const times: number[] = [];
  if (tier.kind === 'intervalTier') {
    for (let i = 0; i < tier.intervals.length; i += 1) {
      const iv = tier.intervals[i];
      if (i === 0) times.push(iv.xmin);
      times.push(iv.xmax);
    }
  } else {
    for (const pt of tier.points) {
      times.push(pt.number);
    }
  }
  return times;
}

function collectAllBoundaryTimes(tg: TextGrid): number[] {
  const raw: number[] = [];
  for (const tier of tg.tiers) {
    for (const t of collectTierBoundaryTimes(tier)) {
      raw.push(t);
    }
  }
  raw.sort((a, b) => a - b);
  const dedup: number[] = [];
  for (const t of raw) {
    if (dedup.length === 0 || Math.abs(t - dedup[dedup.length - 1]) > 1e-6) {
      dedup.push(t);
    }
  }
  return dedup;
}

/**
 * Three-tier reconciliation of a StyleDocument against an externally edited TextGrid:
 * - Level 1 (Exact): same tier + time within 1e-4s (or same index & time).
 * - Level 2 (Fuzzy):
 *     - Intervals: IoU * 0.65 + textSimilarity * 0.25 + indexProximity * 0.10 >= 0.45
 *     - Boundaries / Points: proximity + text similarity within adaptive time window >= 0.45
 * - Level 3 (Orphaned): unmatched overrides are preserved in `doc.orphaned` instead of discarded.
 */
export function reconcileStyleDocument(
  doc: StyleDocument,
  tg: TextGrid
): { doc: StyleDocument; report: ReconcileReport } {
  const next = cloneStyleDocument(doc);
  const domainDuration = Math.max(0.1, tg.xmax - tg.xmin);
  const boundaryWindow = Math.max(0.15, Math.min(0.5, domainDuration * 0.05));

  const report: ReconcileReport = {
    exactMatches: 0,
    fuzzyMatches: 0,
    orphanedCount: 0,
    recoveredFromOrphaned: 0,
    details: {
      intervals: { exact: 0, fuzzy: 0, orphaned: 0 },
      boundaries: { exact: 0, fuzzy: 0, orphaned: 0 },
      points: { exact: 0, fuzzy: 0, orphaned: 0 }
    }
  };

  // --- 1. Intervals ---
  const intervalInputs: Array<{ ov: IntervalStyleOverride; fromOrphaned: boolean }> = [
    ...next.intervalOverrides.map((ov) => ({ ov, fromOrphaned: false })),
    ...(next.orphaned?.intervals ?? []).map((ov) => ({ ov, fromOrphaned: true }))
  ];
  const matchedIntervals: IntervalStyleOverride[] = [];
  const orphanedIntervals: IntervalStyleOverride[] = [];
  const occupiedIntervals = new Set<string>();
  const pendingIntervalFuzzy: Array<{
    ov: IntervalStyleOverride;
    targetTierIdx: number;
    fromOrphaned: boolean;
  }> = [];

  for (const entry of intervalInputs) {
    const { ov, fromOrphaned } = entry;
    const targetTierIdx = findTargetTierIndex(tg, ov.tierName, ov.tierIndex, 'intervalTier');
    if (targetTierIdx < 0) {
      orphanedIntervals.push(ov);
      continue;
    }
    const tier = tg.tiers[targetTierIdx];

    // Level 1: exact match
    let exactIdx = -1;
    // Check same itemIndex first
    if (ov.itemIndex >= 0 && ov.itemIndex < tier.intervals.length) {
      const iv = tier.intervals[ov.itemIndex];
      const key = `${targetTierIdx}:${ov.itemIndex}`;
      if (
        !occupiedIntervals.has(key) &&
        Math.abs(iv.xmin - ov.xmin) <= TIME_MATCH_EPS &&
        Math.abs(iv.xmax - ov.xmax) <= TIME_MATCH_EPS
      ) {
        exactIdx = ov.itemIndex;
      }
    }
    if (exactIdx < 0) {
      for (let ii = 0; ii < tier.intervals.length; ii += 1) {
        const key = `${targetTierIdx}:${ii}`;
        if (occupiedIntervals.has(key)) continue;
        const iv = tier.intervals[ii];
        if (
          Math.abs(iv.xmin - ov.xmin) <= TIME_MATCH_EPS &&
          Math.abs(iv.xmax - ov.xmax) <= TIME_MATCH_EPS
        ) {
          exactIdx = ii;
          break;
        }
      }
    }

    if (exactIdx >= 0) {
      const iv = tier.intervals[exactIdx];
      occupiedIntervals.add(`${targetTierIdx}:${exactIdx}`);
      matchedIntervals.push({
        ...ov,
        tierIndex: targetTierIdx,
        tierName: tier.name,
        itemIndex: exactIdx,
        xmin: iv.xmin,
        xmax: iv.xmax,
        textSnapshot: iv.text
      });
      report.details.intervals.exact += 1;
      if (fromOrphaned) report.recoveredFromOrphaned += 1;
    } else {
      pendingIntervalFuzzy.push({ ov, targetTierIdx, fromOrphaned });
    }
  }

  // Level 2: fuzzy interval matching (greedy best score >= 0.45)
  const intervalCandidates: Array<{
    pendingIdx: number;
    targetTierIdx: number;
    itemIdx: number;
    score: number;
  }> = [];

  for (let p = 0; p < pendingIntervalFuzzy.length; p += 1) {
    const { ov, targetTierIdx } = pendingIntervalFuzzy[p];
    const tier = tg.tiers[targetTierIdx];
    for (let ii = 0; ii < tier.intervals.length; ii += 1) {
      if (occupiedIntervals.has(`${targetTierIdx}:${ii}`)) continue;
      const iv = tier.intervals[ii];
      const iou = intervalIoU(ov.xmin, ov.xmax, iv.xmin, iv.xmax);
      const textSim = normalizedLevenshteinSimilarity(ov.textSnapshot, iv.text);
      const idxProx = 1 / (1 + Math.abs(ii - ov.itemIndex));
      const score = iou * 0.65 + textSim * 0.25 + idxProx * 0.1;
      if (score >= FUZZY_THRESHOLD) {
        intervalCandidates.push({ pendingIdx: p, targetTierIdx, itemIdx: ii, score });
      }
    }
  }

  intervalCandidates.sort((a, b) => b.score - a.score);
  const matchedPendingIntervals = new Set<number>();

  for (const cand of intervalCandidates) {
    if (matchedPendingIntervals.has(cand.pendingIdx)) continue;
    const key = `${cand.targetTierIdx}:${cand.itemIdx}`;
    if (occupiedIntervals.has(key)) continue;

    const { ov, fromOrphaned } = pendingIntervalFuzzy[cand.pendingIdx];
    const tier = tg.tiers[cand.targetTierIdx];
    const iv = tier.intervals[cand.itemIdx];

    occupiedIntervals.add(key);
    matchedPendingIntervals.add(cand.pendingIdx);
    matchedIntervals.push({
      ...ov,
      tierIndex: cand.targetTierIdx,
      tierName: tier.name,
      itemIndex: cand.itemIdx,
      xmin: iv.xmin,
      xmax: iv.xmax,
      textSnapshot: iv.text
    });
    report.details.intervals.fuzzy += 1;
    if (fromOrphaned) report.recoveredFromOrphaned += 1;
  }

  for (let p = 0; p < pendingIntervalFuzzy.length; p += 1) {
    if (!matchedPendingIntervals.has(p)) {
      orphanedIntervals.push(pendingIntervalFuzzy[p].ov);
    }
  }
  report.details.intervals.orphaned = orphanedIntervals.length;

  // --- 2. Boundaries ---
  const boundaryInputs: Array<{ ov: BoundaryStyleOverride; fromOrphaned: boolean }> = [
    ...next.boundaryOverrides.map((ov) => ({ ov, fromOrphaned: false })),
    ...(next.orphaned?.boundaries ?? []).map((ov) => ({ ov, fromOrphaned: true }))
  ];
  const matchedBoundaries: BoundaryStyleOverride[] = [];
  const orphanedBoundaries: BoundaryStyleOverride[] = [];
  const allTimes = collectAllBoundaryTimes(tg);

  for (const { ov, fromOrphaned } of boundaryInputs) {
    let targetTierIdx: number | null = null;
    let targetTierName = '';
    let candidateTimes: number[];

    if (ov.tierIndex === null) {
      candidateTimes = allTimes;
    } else {
      const foundIdx = findTargetTierIndex(tg, ov.tierName, ov.tierIndex, 'intervalTier');
      if (foundIdx < 0) {
        orphanedBoundaries.push(ov);
        continue;
      }
      targetTierIdx = foundIdx;
      targetTierName = tg.tiers[foundIdx].name;
      candidateTimes = collectTierBoundaryTimes(tg.tiers[foundIdx]);
    }

    let bestTime: number | null = null;
    let bestDiff = Infinity;
    for (const t of candidateTimes) {
      const diff = Math.abs(t - ov.time);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestTime = t;
      }
    }

    if (bestTime !== null && bestDiff <= TIME_MATCH_EPS) {
      matchedBoundaries.push({
        ...ov,
        tierIndex: targetTierIdx,
        tierName: targetTierName,
        time: bestTime
      });
      report.details.boundaries.exact += 1;
      if (fromOrphaned) report.recoveredFromOrphaned += 1;
    } else if (bestTime !== null && bestDiff <= boundaryWindow) {
      const score = 1 - bestDiff / boundaryWindow;
      if (score >= FUZZY_THRESHOLD) {
        matchedBoundaries.push({
          ...ov,
          tierIndex: targetTierIdx,
          tierName: targetTierName,
          time: bestTime
        });
        report.details.boundaries.fuzzy += 1;
        if (fromOrphaned) report.recoveredFromOrphaned += 1;
      } else {
        orphanedBoundaries.push(ov);
      }
    } else {
      orphanedBoundaries.push(ov);
    }
  }
  report.details.boundaries.orphaned = orphanedBoundaries.length;

  // --- 3. Points ---
  const pointInputs: Array<{ ov: PointStyleOverride; fromOrphaned: boolean }> = [
    ...next.pointOverrides.map((ov) => ({ ov, fromOrphaned: false })),
    ...(next.orphaned?.points ?? []).map((ov) => ({ ov, fromOrphaned: true }))
  ];
  const matchedPoints: PointStyleOverride[] = [];
  const orphanedPoints: PointStyleOverride[] = [];
  const occupiedPoints = new Set<string>();
  const pendingPointFuzzy: Array<{
    ov: PointStyleOverride;
    targetTierIdx: number;
    fromOrphaned: boolean;
  }> = [];

  for (const { ov, fromOrphaned } of pointInputs) {
    const targetTierIdx = findTargetTierIndex(tg, ov.tierName, ov.tierIndex, 'textTier');
    if (targetTierIdx < 0) {
      orphanedPoints.push(ov);
      continue;
    }
    const tier = tg.tiers[targetTierIdx];

    // Level 1: exact match
    let exactIdx = -1;
    for (let pi = 0; pi < tier.points.length; pi += 1) {
      if (occupiedPoints.has(`${targetTierIdx}:${pi}`)) continue;
      if (Math.abs(tier.points[pi].number - ov.time) <= TIME_MATCH_EPS) {
        exactIdx = pi;
        if (tier.points[pi].mark === ov.markSnapshot) break;
      }
    }

    if (exactIdx >= 0) {
      const pt = tier.points[exactIdx];
      occupiedPoints.add(`${targetTierIdx}:${exactIdx}`);
      matchedPoints.push({
        ...ov,
        tierIndex: targetTierIdx,
        tierName: tier.name,
        itemIndex: exactIdx,
        time: pt.number,
        markSnapshot: pt.mark
      });
      report.details.points.exact += 1;
      if (fromOrphaned) report.recoveredFromOrphaned += 1;
    } else {
      pendingPointFuzzy.push({ ov, targetTierIdx, fromOrphaned });
    }
  }

  // Level 2: fuzzy point matching
  const pointCandidates: Array<{
    pendingIdx: number;
    targetTierIdx: number;
    itemIdx: number;
    score: number;
  }> = [];

  for (let p = 0; p < pendingPointFuzzy.length; p += 1) {
    const { ov, targetTierIdx } = pendingPointFuzzy[p];
    const tier = tg.tiers[targetTierIdx];
    for (let pi = 0; pi < tier.points.length; pi += 1) {
      if (occupiedPoints.has(`${targetTierIdx}:${pi}`)) continue;
      const pt = tier.points[pi];
      const diff = Math.abs(pt.number - ov.time);
      if (diff > boundaryWindow) continue;
      const timeProx = Math.max(0, 1 - diff / boundaryWindow);
      const textSim = normalizedLevenshteinSimilarity(ov.markSnapshot, pt.mark);
      const idxProx = 1 / (1 + Math.abs(pi - ov.itemIndex));
      const score = timeProx * 0.65 + textSim * 0.25 + idxProx * 0.1;
      if (score >= FUZZY_THRESHOLD) {
        pointCandidates.push({ pendingIdx: p, targetTierIdx, itemIdx: pi, score });
      }
    }
  }

  pointCandidates.sort((a, b) => b.score - a.score);
  const matchedPendingPoints = new Set<number>();

  for (const cand of pointCandidates) {
    if (matchedPendingPoints.has(cand.pendingIdx)) continue;
    const key = `${cand.targetTierIdx}:${cand.itemIdx}`;
    if (occupiedPoints.has(key)) continue;

    const { ov, fromOrphaned } = pendingPointFuzzy[cand.pendingIdx];
    const tier = tg.tiers[cand.targetTierIdx];
    const pt = tier.points[cand.itemIdx];

    occupiedPoints.add(key);
    matchedPendingPoints.add(cand.pendingIdx);
    matchedPoints.push({
      ...ov,
      tierIndex: cand.targetTierIdx,
      tierName: tier.name,
      itemIndex: cand.itemIdx,
      time: pt.number,
      markSnapshot: pt.mark
    });
    report.details.points.fuzzy += 1;
    if (fromOrphaned) report.recoveredFromOrphaned += 1;
  }

  for (let p = 0; p < pendingPointFuzzy.length; p += 1) {
    if (!matchedPendingPoints.has(p)) {
      orphanedPoints.push(pendingPointFuzzy[p].ov);
    }
  }
  report.details.points.orphaned = orphanedPoints.length;

  // Assemble result
  next.intervalOverrides = matchedIntervals;
  next.boundaryOverrides = matchedBoundaries;
  next.pointOverrides = matchedPoints;

  if (
    orphanedIntervals.length > 0 ||
    orphanedBoundaries.length > 0 ||
    orphanedPoints.length > 0
  ) {
    next.orphaned = {
      intervals: orphanedIntervals,
      boundaries: orphanedBoundaries,
      points: orphanedPoints
    };
  } else {
    delete next.orphaned;
  }

  report.exactMatches =
    report.details.intervals.exact +
    report.details.boundaries.exact +
    report.details.points.exact;
  report.fuzzyMatches =
    report.details.intervals.fuzzy +
    report.details.boundaries.fuzzy +
    report.details.points.fuzzy;
  report.orphanedCount =
    report.details.intervals.orphaned +
    report.details.boundaries.orphaned +
    report.details.points.orphaned;

  return { doc: next, report };
}
