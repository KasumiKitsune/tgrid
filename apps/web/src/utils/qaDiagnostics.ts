import type { TextGrid } from '../bridge/types';
import type { EditorSelection } from '../render/renderScoreSvg';
import type { AlignMicroResult } from '../store/useEditorStore';

export function formatAlignMicroFeedback(
  res: AlignMicroResult,
  tierName?: string
): { message: string; isError: boolean } {
  if (res.aligned > 0) {
    return {
      message: tierName
        ? `已对齐「${tierName}」${res.aligned} 处微偏边界`
        : `已对齐 ${res.aligned} 处跨层微偏边界 (< 5 ms)`,
      isError: false
    };
  }
  if (res.skippedPointCollision > 0 && res.skippedBoundConstraint > 0) {
    return {
      message: '存在同层标点碰撞及区间边界重叠约束，建议先清理冲突或点击「一键整理边界」',
      isError: true
    };
  }
  if (res.skippedPointCollision > 0) {
    return {
      message: '目标时刻已存在同层标点，已跳过对齐以免重叠覆盖',
      isError: true
    };
  }
  if (res.skippedBoundConstraint > 0) {
    return {
      message: '附近存在重叠或极短区间约束，建议先点击「一键整理边界」后再对齐',
      isError: true
    };
  }
  return {
    message: tierName ? `未发现「${tierName}」可对齐的微偏边界` : '未发现可安全对齐的跨层微偏边界',
    isError: false
  };
}

export type QaIssueKind = 'gap' | 'overlap' | 'zero' | 'micro' | 'space' | 'ood';

export type QaFixableKind =
  | 'gap-fill'
  | 'overlap-resolve'
  | 'zero-delete'
  | 'micro-cross'
  | 'space-interval'
  | 'space-point'
  | 'ood-tier';

export interface QaIssue {
  id: string;
  kind: QaIssueKind;
  badge: string;
  tierIndex: number;
  tierName: string;
  time: number;
  detail: string;
  targetSelection: EditorSelection;
  fixableKind?: QaFixableKind;
  itemIndex?: number;
  gapStart?: number;
  gapEnd?: number;
}

export interface QaCounts {
  gaps: number;
  overlaps: number;
  zeros: number;
  microSegments: number;
  crossMicros: number;
  spaces: number;
  outOfDomain: number;
  total: number;
}

export interface QaScanResult {
  counts: QaCounts;
  issues: QaIssue[];
  totalFound: number;
}

export const QA_ISSUE_CAP = 120;
const QA_EPS = 1e-9;
const QA_ZERO_EPS = 1e-12;
const QA_MICRO_THRESHOLD = 0.005 - 1e-9;

/**
 * Single source of truth for TextGrid structural, micro-offset, space, and domain QA diagnostics.
 * Structural thresholds mirror Rust `tg_core::ops::scan_diagnostics`.
 */
export function scanTextGridQa(tg: TextGrid): QaScanResult {
  const counts: QaCounts = {
    gaps: 0,
    overlaps: 0,
    zeros: 0,
    microSegments: 0,
    crossMicros: 0,
    spaces: 0,
    outOfDomain: 0,
    total: 0
  };
  const issues: QaIssue[] = [];

  const pushIssue = (issue: QaIssue) => {
    if (issues.length < QA_ISSUE_CAP) {
      issues.push(issue);
    }
  };

  interface BoundaryRef {
    t: number;
    tierIndex: number;
    tierName: string;
    kind: 'boundary' | 'point';
    itemIndex?: number;
  }

  const boundaryRefs: BoundaryRef[] = [];

  for (let ti = 0; ti < tg.tiers.length; ti++) {
    const tier = tg.tiers[ti];
    const tierName = tier.name || `第 ${ti + 1} 层`;

    const tierOod =
      Number.isFinite(tier.xmin) &&
      Number.isFinite(tier.xmax) &&
      Number.isFinite(tg.xmin) &&
      Number.isFinite(tg.xmax) &&
      (Math.abs(tier.xmin - tg.xmin) > QA_EPS || Math.abs(tier.xmax - tg.xmax) > QA_EPS);

    if (tierOod) {
      counts.outOfDomain++;
      pushIssue({
        id: `ood-${ti}`,
        kind: 'ood',
        badge: '越界',
        tierIndex: ti,
        tierName,
        time: Math.abs(tier.xmin - tg.xmin) > QA_EPS ? tier.xmin : tier.xmax,
        detail: `${tierName} · 层域 [${tier.xmin.toFixed(3)}, ${tier.xmax.toFixed(3)}] ≠ 全局 [${tg.xmin.toFixed(3)}, ${tg.xmax.toFixed(3)}]`,
        targetSelection: { kind: 'tier', tierIndex: ti },
        fixableKind: 'ood-tier'
      });
    }

    if (tier.kind === 'intervalTier') {
      const ivs = tier.intervals;
      if (ivs.length === 0) {
        if (Number.isFinite(tier.xmin) && Number.isFinite(tier.xmax) && tier.xmax > tier.xmin + QA_EPS) {
          counts.gaps++;
          pushIssue({
            id: `gap-empty-${ti}`,
            kind: 'gap',
            badge: '空隙',
            tierIndex: ti,
            tierName,
            time: tier.xmin,
            detail: `${tierName} · 无区间覆盖`,
            targetSelection: { kind: 'tier', tierIndex: ti },
            fixableKind: 'gap-fill',
            gapStart: tier.xmin,
            gapEnd: tier.xmax
          });
        }
        continue;
      }

      if (Number.isFinite(tier.xmin) && Number.isFinite(ivs[0].xmin) && ivs[0].xmin > tier.xmin + QA_EPS) {
        const ms = (ivs[0].xmin - tier.xmin) * 1000;
        counts.gaps++;
        pushIssue({
          id: `gap-lead-${ti}`,
          kind: 'gap',
          badge: '空隙',
          tierIndex: ti,
          tierName,
          time: tier.xmin,
          detail: `${tierName} · 首段前空隙 (${ms.toFixed(1)} ms)`,
          targetSelection: { kind: 'interval', tierIndex: ti, itemIndex: 0 },
          fixableKind: 'gap-fill',
          itemIndex: 0,
          gapStart: tier.xmin,
          gapEnd: ivs[0].xmin
        });
      }

      const seenInterior = new Set<number>();
      for (let ii = 0; ii < ivs.length; ii++) {
        const iv = ivs[ii];
        const dur = iv.xmax - iv.xmin;

        if (dur <= QA_ZERO_EPS) {
          counts.zeros++;
          pushIssue({
            id: `zero-${ti}-${ii}`,
            kind: 'zero',
            badge: '零长',
            tierIndex: ti,
            tierName,
            time: iv.xmin,
            detail: `${tierName} · #${ii + 1} 零时长区间`,
            targetSelection: { kind: 'interval', tierIndex: ti, itemIndex: ii },
            fixableKind: 'zero-delete',
            itemIndex: ii
          });
        } else if (dur < QA_MICRO_THRESHOLD) {
          counts.microSegments++;
          pushIssue({
            id: `micro-iv-${ti}-${ii}`,
            kind: 'micro',
            badge: '极短',
            tierIndex: ti,
            tierName,
            time: iv.xmin,
            detail: `${tierName} · #${ii + 1} 极短段 (${(dur * 1000).toFixed(1)} ms)`,
            targetSelection: { kind: 'interval', tierIndex: ti, itemIndex: ii }
          });
        }

        if (ii > 0) {
          const prev = ivs[ii - 1];
          const diff = iv.xmin - prev.xmax;
          if (diff > QA_EPS) {
            const ms = diff * 1000;
            counts.gaps++;
            pushIssue({
              id: `gap-${ti}-${ii}`,
              kind: 'gap',
              badge: '空隙',
              tierIndex: ti,
              tierName,
              time: prev.xmax,
              detail: `${tierName} · #${ii}–#${ii + 1} 空隙 (${ms.toFixed(1)} ms)`,
              targetSelection: { kind: 'interval', tierIndex: ti, itemIndex: ii },
              fixableKind: 'gap-fill',
              itemIndex: ii,
              gapStart: prev.xmax,
              gapEnd: iv.xmin
            });
          } else if (diff < -QA_EPS) {
            const ms = -diff * 1000;
            counts.overlaps++;
            pushIssue({
              id: `overlap-${ti}-${ii}`,
              kind: 'overlap',
              badge: '重叠',
              tierIndex: ti,
              tierName,
              time: iv.xmin,
              detail: `${tierName} · #${ii}–#${ii + 1} 重叠 (${ms.toFixed(1)} ms)`,
              targetSelection: { kind: 'interval', tierIndex: ti, itemIndex: ii },
              fixableKind: 'overlap-resolve',
              itemIndex: ii
            });
          }
        }

        if (iv.text.length > 0 && iv.text !== iv.text.trim()) {
          counts.spaces++;
          pushIssue({
            id: `space-iv-${ti}-${ii}`,
            kind: 'space',
            badge: '空格',
            tierIndex: ti,
            tierName,
            time: iv.xmin,
            detail: `${tierName} · #${ii + 1} 首尾含空格`,
            targetSelection: { kind: 'interval', tierIndex: ti, itemIndex: ii },
            fixableKind: 'space-interval',
            itemIndex: ii
          });
        }

        if (iv.xmin > tier.xmin + QA_EPS && iv.xmin < tier.xmax - QA_EPS && !seenInterior.has(iv.xmin)) {
          seenInterior.add(iv.xmin);
          boundaryRefs.push({ t: iv.xmin, tierIndex: ti, tierName, kind: 'boundary' });
        }
        if (iv.xmax > tier.xmin + QA_EPS && iv.xmax < tier.xmax - QA_EPS && !seenInterior.has(iv.xmax)) {
          seenInterior.add(iv.xmax);
          boundaryRefs.push({ t: iv.xmax, tierIndex: ti, tierName, kind: 'boundary' });
        }
      }

      const last = ivs[ivs.length - 1];
      if (Number.isFinite(tier.xmax) && Number.isFinite(last.xmax) && last.xmax < tier.xmax - QA_EPS) {
        const ms = (tier.xmax - last.xmax) * 1000;
        counts.gaps++;
        pushIssue({
          id: `gap-trail-${ti}`,
          kind: 'gap',
          badge: '空隙',
          tierIndex: ti,
          tierName,
          time: last.xmax,
          detail: `${tierName} · 末段后空隙 (${ms.toFixed(1)} ms)`,
          targetSelection: { kind: 'interval', tierIndex: ti, itemIndex: ivs.length - 1 },
          fixableKind: 'gap-fill',
          itemIndex: ivs.length,
          gapStart: last.xmax,
          gapEnd: tier.xmax
        });
      }
    } else {
      for (let pi = 0; pi < tier.points.length; pi++) {
        const pt = tier.points[pi];
        if (pt.mark.length > 0 && pt.mark !== pt.mark.trim()) {
          counts.spaces++;
          pushIssue({
            id: `space-pt-${ti}-${pi}`,
            kind: 'space',
            badge: '空格',
            tierIndex: ti,
            tierName,
            time: pt.number,
            detail: `${tierName} · 点 #${pi + 1} 首尾含空格`,
            targetSelection: { kind: 'point', tierIndex: ti, itemIndex: pi },
            fixableKind: 'space-point',
            itemIndex: pi
          });
        }
        boundaryRefs.push({
          t: pt.number,
          tierIndex: ti,
          tierName,
          kind: 'point',
          itemIndex: pi
        });
      }
    }
  }

  // Cross-tier micro boundary misalignment (0 < |t1 - t2| < 5 ms)
  if (boundaryRefs.length > 1) {
    boundaryRefs.sort((a, b) => a.t - b.t || a.tierIndex - b.tierIndex);
    const reportedKeys = new Set<string>();

    for (let i = 0; i < boundaryRefs.length; i++) {
      const b = boundaryRefs[i];
      let bestRef: BoundaryRef | null = null;
      let bestDist = QA_MICRO_THRESHOLD;

      for (let j = i - 1; j >= 0; j--) {
        const a = boundaryRefs[j];
        const diff = b.t - a.t;
        if (diff >= QA_MICRO_THRESHOLD) break;
        if (diff <= QA_EPS || a.tierIndex === b.tierIndex) continue;
        const isPriorityRef =
          (a.kind === 'boundary' && b.kind === 'point') ||
          (a.kind === b.kind && a.tierIndex < b.tierIndex);
        if (isPriorityRef && diff < bestDist) {
          bestDist = diff;
          bestRef = a;
        }
      }
      for (let j = i + 1; j < boundaryRefs.length; j++) {
        const a = boundaryRefs[j];
        const diff = a.t - b.t;
        if (diff >= QA_MICRO_THRESHOLD) break;
        if (diff <= QA_EPS || a.tierIndex === b.tierIndex) continue;
        const isPriorityRef =
          (a.kind === 'boundary' && b.kind === 'point') ||
          (a.kind === b.kind && a.tierIndex < b.tierIndex);
        if (isPriorityRef && diff < bestDist) {
          bestDist = diff;
          bestRef = a;
        }
      }

      if (bestRef) {
        const key = `${b.tierIndex}:${b.t.toFixed(9)}`;
        if (reportedKeys.has(key)) continue;
        reportedKeys.add(key);
        counts.crossMicros++;
        pushIssue({
          id: `micro-x-${b.tierIndex}-${i}`,
          kind: 'micro',
          badge: '微偏',
          tierIndex: b.tierIndex,
          tierName: b.tierName,
          time: b.t,
          detail: `${b.tierName} ↔ ${bestRef.tierName} 偏 ${(bestDist * 1000).toFixed(1)} ms`,
          targetSelection:
            b.kind === 'point' && b.itemIndex !== undefined
              ? { kind: 'point', tierIndex: b.tierIndex, itemIndex: b.itemIndex }
              : { kind: 'boundary', tierIndex: b.tierIndex, time: b.t },
          fixableKind: 'micro-cross'
        });
      }
    }
  }

  counts.total =
    counts.gaps +
    counts.overlaps +
    counts.zeros +
    counts.microSegments +
    counts.crossMicros +
    counts.spaces +
    counts.outOfDomain;

  return {
    counts,
    issues,
    totalFound: counts.total
  };
}
