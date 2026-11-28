import type { Interval, TextGrid, Tier } from '../bridge/types';
import type { EditorSelection } from '../render/renderScoreSvg';
import type { VadSegment } from './vadPostprocess.ts';

export type VadWriteMode = 'new-tier' | 'overwrite-tier' | 'split-interval';
export type VadLabelMode = 'blank' | 'speech-silence' | 'numbered';

export interface VadLabelConfig {
  mode: VadLabelMode;
  speechLabel: string;
  silenceLabel: string;
  numberPrefix?: string;
}

export interface VadWriteTarget {
  mode: VadWriteMode;
  /** 目标区间层索引（overwrite-tier / split-interval 生效） */
  targetTierIndex: number;
  /** 新建层名称（new-tier 生效，重名自动顺延 VAD 2 / VAD 3） */
  newTierName: string;
  /** 所选区间索引（split-interval 生效） */
  intervalIndex?: number;
}

export interface VadWritePlanOptions {
  tg: TextGrid;
  /** 已排除误检段的有声段列表（文档时间） */
  segments: ReadonlyArray<VadSegment>;
  /** 作用范围起点（文档时间） */
  scopeStart: number;
  /** 作用范围终点（文档时间） */
  scopeEnd: number;
  target: VadWriteTarget;
  labelConfig: VadLabelConfig;
  /** 最小合法区间时长（秒），默认 0.005（严格匹配 scan_diagnostics 5 ms 阈值） */
  minIntervalSec?: number;
}

export interface VadOverwriteWarning {
  nonEmptyCount: number;
  tierName: string;
}

export interface VadWriteResult {
  ok: boolean;
  reason?: string;
  nextTg: TextGrid;
  writtenTierIndex: number;
  writtenTierName: string;
  speechCount: number;
  totalIntervalsInScope: number;
  focusTime: number;
  historyDetail: string;
}

export const DEFAULT_VAD_LABEL_CONFIG: VadLabelConfig = {
  mode: 'blank',
  speechLabel: 'sounding',
  silenceLabel: 'silent',
  numberPrefix: ''
};

const EPS = 1e-9;
const DEFAULT_MIN_INTERVAL_SEC = 0.005;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function cloneTierShallow(tier: Tier): Tier {
  return {
    ...tier,
    intervals: tier.intervals.map((iv) => ({ ...iv })),
    points: tier.points.map((pt) => ({ ...pt }))
  };
}

/**
 * 为新建 VAD 层生成不重名层名：`VAD` -> `VAD 2` -> `VAD 3`...
 */
export function suggestUniqueVadTierName(tg: TextGrid, baseName = 'VAD'): string {
  const cleanBase = baseName.trim() || 'VAD';
  const existing = new Set(tg.tiers.map((t) => t.name.trim()));
  if (!existing.has(cleanBase)) return cleanBase;
  let seq = 2;
  while (existing.has(`${cleanBase} ${seq}`)) {
    seq++;
  }
  return `${cleanBase} ${seq}`;
}

/**
 * 判断文档是否仅包含 1 个全空白区间层（用于全录音首次 VAD 智能推荐）。
 */
export function isSingleBlankIntervalTierDoc(tg: TextGrid): boolean {
  if (tg.tiers.length !== 1) return false;
  const tier = tg.tiers[0];
  if (!tier || tier.kind !== 'intervalTier') return false;
  return tier.intervals.every((iv) => iv.text.trim().length === 0);
}

/**
 * 拍板智能推荐写入目标：
 * - 若从选中区间触发（`scopeMode === 'interval'`，或未指定范围且当前选中空白/长区间且非单空白层全篇占位）：默认仅切分当前所选区间内部；
 * - 全录音（或框选选区）时，若文档仅有 1 个全空白区间层则默认直接写入该层，否则默认新建独立区间层 `VAD`。
 */
export function getDefaultVadTarget(
  tg: TextGrid,
  selection: EditorSelection,
  scopeMode?: 'all' | 'range' | 'interval'
): VadWriteTarget {
  const newTierName = suggestUniqueVadTierName(tg, 'VAD');
  const firstIntervalTierIdx = tg.tiers.findIndex((t) => t.kind === 'intervalTier');

  if (selection?.kind === 'interval') {
    const tier = tg.tiers[selection.tierIndex];
    const iv = tier?.kind === 'intervalTier' ? tier.intervals[selection.itemIndex] : undefined;
    if (tier && iv && iv.xmax > iv.xmin + EPS) {
      const isSoleBlankFullInterval =
        isSingleBlankIntervalTierDoc(tg) &&
        tier.intervals.length === 1 &&
        Math.abs(iv.xmin - tier.xmin) <= 1e-6 &&
        Math.abs(iv.xmax - tier.xmax) <= 1e-6;
      const isEligibleAutoInterval =
        scopeMode === 'interval' ||
        (scopeMode === undefined &&
          !isSoleBlankFullInterval &&
          (iv.text.trim().length === 0 || iv.xmax - iv.xmin >= 0.4));
      if (isEligibleAutoInterval) {
        return {
          mode: 'split-interval',
          targetTierIndex: selection.tierIndex,
          intervalIndex: selection.itemIndex,
          newTierName
        };
      }
    }
  }

  if (isSingleBlankIntervalTierDoc(tg)) {
    return {
      mode: 'overwrite-tier',
      targetTierIndex: 0,
      newTierName
    };
  }

  return {
    mode: 'new-tier',
    targetTierIndex: firstIntervalTierIdx >= 0 ? firstIntervalTierIdx : 0,
    newTierName
  };
}

/**
 * 统计「覆盖指定层」或「切分所选区间」时会替换多少个已有非空文本区间（驱动琥珀色提醒条）。
 */
export function countOverwrittenTextIntervals(
  tg: TextGrid,
  target: VadWriteTarget,
  scopeStart: number,
  scopeEnd: number
): VadOverwriteWarning {
  if (target.mode === 'new-tier') {
    return { nonEmptyCount: 0, tierName: target.newTierName.trim() || 'VAD' };
  }
  const tier = tg.tiers[target.targetTierIndex];
  if (!tier || tier.kind !== 'intervalTier') {
    return { nonEmptyCount: 0, tierName: '' };
  }
  const tierName = tier.name.trim() || `第 ${target.targetTierIndex + 1} 层`;

  if (target.mode === 'split-interval') {
    const iv =
      target.intervalIndex !== undefined ? tier.intervals[target.intervalIndex] : undefined;
    const hasText = Boolean(iv && iv.text.trim().length > 0);
    return { nonEmptyCount: hasText ? 1 : 0, tierName };
  }

  let nonEmptyCount = 0;
  for (const iv of tier.intervals) {
    if (iv.xmax <= scopeStart + EPS || iv.xmin >= scopeEnd - EPS) continue;
    if (iv.text.trim().length > 0) nonEmptyCount++;
  }
  return { nonEmptyCount, tierName };
}

/**
 * 写入前一次性批量过零点吸附：严格保序、防相邻碰撞、保 >= minIntervalSec。
 */
export async function snapVadSegmentsZeroCrossing(
  segments: ReadonlyArray<VadSegment>,
  scopeStart: number,
  scopeEnd: number,
  snapFn: (t: number) => number | Promise<number>,
  minIntervalSec = DEFAULT_MIN_INTERVAL_SEC
): Promise<VadSegment[]> {
  if (segments.length === 0) return [];
  const sorted = [...segments]
    .map((s) => ({
      start: clamp(s.start, scopeStart, scopeEnd),
      end: clamp(s.end, scopeStart, scopeEnd)
    }))
    .filter((s) => s.end - s.start >= minIntervalSec)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: VadSegment[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i];
    const lo = out.length > 0 ? out[out.length - 1].end : scopeStart;
    const hi = i + 1 < sorted.length ? sorted[i + 1].start : scopeEnd;

    let s = seg.start;
    let e = seg.end;

    // Keep exact scope boundary if segment already touches scope edge
    if (s > scopeStart + EPS) {
      try {
        const snapped = await snapFn(s);
        if (Number.isFinite(snapped)) {
          s = clamp(snapped, lo, seg.end);
        }
      } catch {
        // Fallback to original start
      }
    }
    if (e < scopeEnd - EPS) {
      try {
        const snapped = await snapFn(e);
        if (Number.isFinite(snapped)) {
          e = clamp(snapped, s, hi);
        }
      } catch {
        // Fallback to original end
      }
    }

    if (s - scopeStart > 0 && s - scopeStart < minIntervalSec) {
      s = scopeStart;
    }
    if (scopeEnd - e > 0 && scopeEnd - e < minIntervalSec) {
      e = scopeEnd;
    }
    if (out.length > 0) {
      const prev = out[out.length - 1];
      if (s - prev.end > 0 && s - prev.end < minIntervalSec) {
        const mid = 0.5 * (prev.end + s);
        prev.end = mid;
        s = mid;
      }
    }
    if (e - s >= minIntervalSec) {
      out.push({ start: s, end: e });
    }
  }

  return out;
}

function formatSpeechLabel(index: number, cfg: VadLabelConfig): string {
  if (cfg.mode === 'speech-silence') {
    return (cfg.speechLabel ?? '').trim();
  }
  if (cfg.mode === 'numbered') {
    return `${(cfg.numberPrefix ?? '').trim()}${index + 1}`;
  }
  return '';
}

function formatSilenceLabel(cfg: VadLabelConfig): string {
  if (cfg.mode === 'speech-silence') {
    return (cfg.silenceLabel ?? '').trim();
  }
  return '';
}

/**
 * 在 `[scopeStart, scopeEnd]` 内生成严格无缝、无重叠、无 <5ms 碎片、无首尾空格的区间序列。
 */
export function buildSeamlessScopeIntervals(
  scopeStart: number,
  scopeEnd: number,
  segments: ReadonlyArray<VadSegment>,
  labelConfig: VadLabelConfig,
  minIntervalSec = DEFAULT_MIN_INTERVAL_SEC
): { intervals: Interval[]; speechCount: number } {
  if (!Number.isFinite(scopeStart) || !Number.isFinite(scopeEnd) || scopeEnd <= scopeStart + EPS) {
    return { intervals: [], speechCount: 0 };
  }

  const silText = formatSilenceLabel(labelConfig);

  // 1. Clamp, sort, drop < minIntervalSec fragments
  const cleaned: VadSegment[] = [];
  const sorted = [...segments]
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .map((s) => ({
      start: clamp(s.start, scopeStart, scopeEnd),
      end: clamp(s.end, scopeStart, scopeEnd)
    }))
    .filter((s) => s.end - s.start >= minIntervalSec - EPS)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  for (const seg of sorted) {
    let start = seg.start;
    let end = seg.end;
    if (start - scopeStart < minIntervalSec) {
      start = scopeStart;
    }
    if (scopeEnd - end < minIntervalSec) {
      end = scopeEnd;
    }
    if (end - start < minIntervalSec - EPS) continue;

    const prev = cleaned[cleaned.length - 1];
    if (prev) {
      if (start < prev.end - EPS) {
        // Overlapping inputs: merge cleanly
        prev.end = Math.max(prev.end, end);
        if (scopeEnd - prev.end < minIntervalSec) prev.end = scopeEnd;
        continue;
      }
      if (start - prev.end < minIntervalSec) {
        // Sub-5ms silence sliver between two speech segments: meet cleanly at midpoint
        const mid = 0.5 * (prev.end + start);
        if (mid - prev.start >= minIntervalSec - EPS && end - mid >= minIntervalSec - EPS) {
          prev.end = mid;
          start = mid;
        } else {
          prev.end = Math.max(prev.end, end);
          continue;
        }
      }
    }
    cleaned.push({ start, end });
  }

  if (cleaned.length === 0) {
    return {
      intervals: [{ xmin: scopeStart, xmax: scopeEnd, text: silText }],
      speechCount: 0
    };
  }

  // 2. Emit strictly contiguous alternating silence + speech intervals
  const intervals: Interval[] = [];
  let cursor = scopeStart;
  let speechIdx = 0;

  for (const seg of cleaned) {
    if (seg.start > cursor + EPS) {
      intervals.push({ xmin: cursor, xmax: seg.start, text: silText });
    }
    const segStart = intervals.length > 0 ? intervals[intervals.length - 1].xmax : scopeStart;
    intervals.push({
      xmin: segStart,
      xmax: seg.end,
      text: formatSpeechLabel(speechIdx, labelConfig)
    });
    speechIdx++;
    cursor = seg.end;
  }

  if (scopeEnd > cursor + EPS) {
    intervals.push({ xmin: cursor, xmax: scopeEnd, text: silText });
  } else if (intervals.length > 0) {
    intervals[intervals.length - 1].xmax = scopeEnd;
  }

  // Exact endpoint & continuity lock
  if (intervals.length > 0) {
    intervals[0].xmin = scopeStart;
    intervals[intervals.length - 1].xmax = scopeEnd;
    for (let i = 1; i < intervals.length; i++) {
      intervals[i].xmin = intervals[i - 1].xmax;
    }
  }

  return { intervals, speechCount: speechIdx };
}

/**
 * 将局部作用窗 `[scopeStart, scopeEnd]` 内的新区间无缝拼接回已有区间层，
 * 窗外已有区间与文本 100% 保持原样，且保证拼接处绝不产生空隙、重叠或 <5ms 碎片。
 */
export function spliceScopeIntervalsIntoTier(
  tier: Tier,
  scopeStart: number,
  scopeEnd: number,
  scopeIntervals: ReadonlyArray<Interval>,
  minIntervalSec = DEFAULT_MIN_INTERVAL_SEC
): Interval[] {
  const s0 = clamp(scopeStart, tier.xmin, tier.xmax);
  const s1 = clamp(scopeEnd, s0, tier.xmax);
  if (s1 <= s0 + EPS || scopeIntervals.length === 0) {
    return tier.intervals.map((iv) => ({ ...iv }));
  }

  const leftKept: Interval[] = [];
  const rightKept: Interval[] = [];

  for (const iv of tier.intervals) {
    if (iv.xmax <= s0 + EPS) {
      leftKept.push({ ...iv });
    } else if (iv.xmin >= s1 - EPS) {
      rightKept.push({ ...iv });
    } else {
      // Interval straddles s0 and/or s1
      if (iv.xmin < s0 - EPS) {
        leftKept.push({ xmin: iv.xmin, xmax: s0, text: iv.text });
      }
      if (iv.xmax > s1 + EPS) {
        rightKept.push({ xmin: s1, xmax: iv.xmax, text: iv.text });
      }
    }
  }

  const mid = scopeIntervals.map((iv) => ({ ...iv }));

  // Absorb tiny < minIntervalSec clipped remnant at left splice boundary if empty
  if (leftKept.length > 0) {
    const lastLeft = leftKept[leftKept.length - 1];
    if (lastLeft.xmax - lastLeft.xmin < minIntervalSec - EPS) {
      if (lastLeft.text.trim().length === 0) {
        mid[0].xmin = lastLeft.xmin;
        leftKept.pop();
      } else if (mid[0].xmax - mid[0].xmin > minIntervalSec * 2) {
        const needed = minIntervalSec - (lastLeft.xmax - lastLeft.xmin);
        lastLeft.xmax += needed;
        mid[0].xmin = lastLeft.xmax;
      }
    }
  }

  // Absorb tiny < minIntervalSec clipped remnant at right splice boundary if empty
  if (rightKept.length > 0) {
    const firstRight = rightKept[0];
    if (firstRight.xmax - firstRight.xmin < minIntervalSec - EPS) {
      if (firstRight.text.trim().length === 0) {
        mid[mid.length - 1].xmax = firstRight.xmax;
        rightKept.shift();
      } else if (mid[mid.length - 1].xmax - mid[mid.length - 1].xmin > minIntervalSec * 2) {
        const needed = minIntervalSec - (firstRight.xmax - firstRight.xmin);
        firstRight.xmin -= needed;
        mid[mid.length - 1].xmax = firstRight.xmin;
      }
    }
  }

  const combined = [...leftKept, ...mid, ...rightKept];
  if (combined.length > 0) {
    combined[0].xmin = tier.xmin;
    combined[combined.length - 1].xmax = tier.xmax;
    for (let i = 1; i < combined.length; i++) {
      combined[i].xmin = combined[i - 1].xmax;
    }
  }
  return combined;
}

/**
 * 执行 VAD 写入计划，返回不可变新 TextGrid（绝不篡改全局 xmin / xmax）。
 */
export function applyVadWritePlan(opts: VadWritePlanOptions): VadWriteResult {
  const { tg, segments, target, labelConfig } = opts;
  const minIntervalSec = opts.minIntervalSec ?? DEFAULT_MIN_INTERVAL_SEC;

  const docStart = tg.xmin;
  const docEnd = tg.xmax;
  if (!Number.isFinite(docStart) || !Number.isFinite(docEnd) || docEnd <= docStart + EPS) {
    return {
      ok: false,
      reason: '文档时间域无效',
      nextTg: tg,
      writtenTierIndex: -1,
      writtenTierName: '',
      speechCount: 0,
      totalIntervalsInScope: 0,
      focusTime: docStart,
      historyDetail: ''
    };
  }

  const clampedStart = clamp(opts.scopeStart, docStart, docEnd);
  const clampedEnd = clamp(opts.scopeEnd, clampedStart, docEnd);
  if (clampedEnd <= clampedStart + EPS) {
    return {
      ok: false,
      reason: '作用范围无效或与文档时间域无交集',
      nextTg: tg,
      writtenTierIndex: -1,
      writtenTierName: '',
      speechCount: 0,
      totalIntervalsInScope: 0,
      focusTime: docStart,
      historyDetail: ''
    };
  }

  const isFullScope =
    Math.abs(clampedStart - docStart) <= 1e-6 && Math.abs(clampedEnd - docEnd) <= 1e-6;

  // Mode 1: Split inside selected interval
  if (target.mode === 'split-interval') {
    const srcTier = tg.tiers[target.targetTierIndex];
    if (!srcTier || srcTier.kind !== 'intervalTier') {
      return {
        ok: false,
        reason: '目标层不是有效的区间层',
        nextTg: tg,
        writtenTierIndex: -1,
        writtenTierName: '',
        speechCount: 0,
        totalIntervalsInScope: 0,
        focusTime: clampedStart,
        historyDetail: ''
      };
    }
    const ivIdx = target.intervalIndex ?? -1;
    const srcIv = srcTier.intervals[ivIdx];
    if (!srcIv || srcIv.xmax <= srcIv.xmin + EPS) {
      return {
        ok: false,
        reason: '未找到待切分的目标区间',
        nextTg: tg,
        writtenTierIndex: -1,
        writtenTierName: '',
        speechCount: 0,
        totalIntervalsInScope: 0,
        focusTime: clampedStart,
        historyDetail: ''
      };
    }

    const ivStart = srcIv.xmin;
    const ivEnd = srcIv.xmax;
    const { intervals: built, speechCount } = buildSeamlessScopeIntervals(
      ivStart,
      ivEnd,
      segments,
      labelConfig,
      minIntervalSec
    );
    if (built.length === 0) {
      return {
        ok: false,
        reason: '区间内未生成有效切分结果',
        nextTg: tg,
        writtenTierIndex: target.targetTierIndex,
        writtenTierName: srcTier.name,
        speechCount: 0,
        totalIntervalsInScope: 0,
        focusTime: ivStart,
        historyDetail: ''
      };
    }

    const nextTier = cloneTierShallow(srcTier);
    nextTier.intervals.splice(ivIdx, 1, ...built);
    const nextTiers = tg.tiers.slice();
    nextTiers[target.targetTierIndex] = nextTier;
    const tierName = nextTier.name.trim() || `层 ${target.targetTierIndex + 1}`;

    return {
      ok: true,
      nextTg: { ...tg, tiers: nextTiers },
      writtenTierIndex: target.targetTierIndex,
      writtenTierName: tierName,
      speechCount,
      totalIntervalsInScope: built.length,
      focusTime: ivStart,
      historyDetail: `${tierName} · 区间内检出 ${speechCount} 个有声段 (${ivStart.toFixed(3)}–${ivEnd.toFixed(3)}s)`
    };
  }

  // Mode 2: Overwrite specified interval tier within [clampedStart, clampedEnd]
  if (target.mode === 'overwrite-tier') {
    const srcTier = tg.tiers[target.targetTierIndex];
    if (!srcTier || srcTier.kind !== 'intervalTier') {
      return {
        ok: false,
        reason: '目标层不是有效的区间层',
        nextTg: tg,
        writtenTierIndex: -1,
        writtenTierName: '',
        speechCount: 0,
        totalIntervalsInScope: 0,
        focusTime: clampedStart,
        historyDetail: ''
      };
    }

    const scopeStartInTier = clamp(clampedStart, srcTier.xmin, srcTier.xmax);
    const scopeEndInTier = clamp(clampedEnd, scopeStartInTier, srcTier.xmax);
    const { intervals: built, speechCount } = buildSeamlessScopeIntervals(
      scopeStartInTier,
      scopeEndInTier,
      segments,
      labelConfig,
      minIntervalSec
    );
    const nextTier = cloneTierShallow(srcTier);
    const isFullTier =
      Math.abs(scopeStartInTier - srcTier.xmin) <= 1e-6 &&
      Math.abs(scopeEndInTier - srcTier.xmax) <= 1e-6;
    nextTier.intervals = isFullTier
      ? built
      : spliceScopeIntervalsIntoTier(
          srcTier,
          scopeStartInTier,
          scopeEndInTier,
          built,
          minIntervalSec
        );
    const nextTiers = tg.tiers.slice();
    nextTiers[target.targetTierIndex] = nextTier;
    const tierName = nextTier.name.trim() || `层 ${target.targetTierIndex + 1}`;

    return {
      ok: true,
      nextTg: { ...tg, tiers: nextTiers },
      writtenTierIndex: target.targetTierIndex,
      writtenTierName: tierName,
      speechCount,
      totalIntervalsInScope: built.length,
      focusTime: scopeStartInTier,
      historyDetail: isFullScope
        ? `${tierName} · 全录音检出 ${speechCount} 个有声段`
        : `${tierName} · 检出 ${speechCount} 个有声段 (${scopeStartInTier.toFixed(3)}–${scopeEndInTier.toFixed(3)}s)`
    };
  }

  // Mode 3: Create new independent IntervalTier
  const finalName = suggestUniqueVadTierName(tg, target.newTierName || 'VAD');
  const { intervals: scopeBuilt, speechCount } = buildSeamlessScopeIntervals(
    clampedStart,
    clampedEnd,
    segments,
    labelConfig,
    minIntervalSec
  );
  const fullIntervals: Interval[] = [];
  if (clampedStart > docStart + EPS) {
    if (clampedStart - docStart < minIntervalSec && scopeBuilt.length > 0) {
      scopeBuilt[0].xmin = docStart;
    } else {
      fullIntervals.push({ xmin: docStart, xmax: clampedStart, text: '' });
    }
  }
  fullIntervals.push(...scopeBuilt);
  if (docEnd > clampedEnd + EPS) {
    if (docEnd - clampedEnd < minIntervalSec && fullIntervals.length > 0) {
      fullIntervals[fullIntervals.length - 1].xmax = docEnd;
    } else {
      fullIntervals.push({ xmin: clampedEnd, xmax: docEnd, text: '' });
    }
  }
  if (fullIntervals.length > 0) {
    fullIntervals[0].xmin = docStart;
    fullIntervals[fullIntervals.length - 1].xmax = docEnd;
    for (let i = 1; i < fullIntervals.length; i++) {
      fullIntervals[i].xmin = fullIntervals[i - 1].xmax;
    }
  }

  const newTier: Tier = {
    kind: 'intervalTier',
    name: finalName,
    xmin: docStart,
    xmax: docEnd,
    intervals: fullIntervals,
    points: []
  };
  const nextTiers = [...tg.tiers, newTier];
  const writtenTierIndex = nextTiers.length - 1;

  return {
    ok: true,
    nextTg: { ...tg, tiers: nextTiers },
    writtenTierIndex,
    writtenTierName: finalName,
    speechCount,
    totalIntervalsInScope: scopeBuilt.length,
    focusTime: clampedStart,
    historyDetail: isFullScope
      ? `新建层「${finalName}」· 检出 ${speechCount} 个有声段`
      : `新建层「${finalName}」· 检出 ${speechCount} 个有声段 (${clampedStart.toFixed(3)}–${clampedEnd.toFixed(3)}s)`
  };
}
