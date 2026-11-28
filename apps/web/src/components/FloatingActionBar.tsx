import React, {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { getPlatformBridge } from '../bridge/PlatformBridge';
import type { TextGrid } from '../bridge/types';
import {
  decodeTrigraphGlossSync,
  formatPraatDouble,
  primeTrigraphString
} from '../layout/richText';
import type { EditorSelection } from '../render/renderScoreSvg';
import { getEffectiveShortcutHint, isComposingEvent } from '../shortcuts/registry';
import {
  formatDeltaTime,
  formatQuote,
  formatTierLabel,
  formatTimeSec
} from '../store/historyModel';
import {
  getBoundaryBoundsForTier,
  useEditorStore,
  type FloatingBarDensity
} from '../store/useEditorStore';
import type { MultiSelectionAnalysis } from '../utils/multiSelection';
import { formatAlignMicroFeedback } from '../utils/qaDiagnostics';
import { inferSmartSplit, type SmartSplitCandidate } from '../utils/smartSplit';
import { getViewportZoom } from '../utils/uiScale';
import { ChevronIcon, CloseIcon, UiIcon } from './Icons';
import { ScrubNumberInput } from './ScrubNumberInput';
import '../styles/floatingBar.css';

export type FloatingInlineTarget =
  | { kind: 'interval'; tierIndex: number; itemIndex: number }
  | { kind: 'point'; tierIndex: number; itemIndex: number }
  | { kind: 'tier-name'; tierIndex: number };

export interface FloatingActionBarProps {
  selection: NonNullable<EditorSelection>;
  multiAnalysis: MultiSelectionAnalysis;
  audioBuffer: AudioBuffer | null;
  visible: boolean;
  position: { left: number; top: number };
  isDragging: boolean;
  onDragHandlePointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onStartPlayback: (startT: number, endT: number) => void;
  onOpenInline: (target: FloatingInlineTarget) => void;
  onCopyText: (text: string, label: string) => void;
  onShowScrubPreview: (previewT: number, tierIndex: number, fullBand: boolean) => void;
  onClearScrubPreview: () => void;
  onRunSmartSplit: (
    tierIndex: number,
    itemIndex: number,
    ivSnapshot: { xmin: number; xmax: number; text: string },
    candidate: SmartSplitCandidate,
    alternatives: SmartSplitCandidate[],
    useAcoustic: boolean
  ) => Promise<boolean>;
  onOpenSplitModal: (tierIndex: number, itemIndex: number) => void;
}

type PopoverId = 'time' | 'split' | 'align' | 'project' | 'duplicate' | 'more';

function round6(t: number): number {
  return Number(t.toFixed(6));
}

function formatCompactSec(t: number): string {
  if (!Number.isFinite(t)) return '0.000';
  return t.toFixed(3);
}

function formatCompactDur(durSec: number): string {
  const safe = Math.max(0, Number.isFinite(durSec) ? durSec : 0);
  if (safe >= 1) return `${safe.toFixed(2)}s`;
  const ms = safe * 1000;
  return ms >= 10 ? `${Math.round(ms)}ms` : `${ms.toFixed(1)}ms`;
}

function formatMultiSummaryLabel(topology: MultiSelectionAnalysis['topology']): string {
  switch (topology) {
    case 'single-tier-contiguous':
      return '同层连续';
    case 'cross-tier-aligned':
      return '跨层对齐';
    case 'cross-tier-overlapping':
      return '跨层重叠';
    default:
      return '分散区间';
  }
}

function truncateLabel(text: string, maxLen = 18): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '空白';
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

function collectPeerTextsLocal(
  intervals: readonly { text: string }[],
  selfIndex: number,
  maxEachSide = 20
): string[] {
  const peers: string[] = [];
  let left = 0;
  for (let i = selfIndex - 1; i >= 0 && left < maxEachSide; i--) {
    const t = intervals[i]?.text.trim();
    if (t) {
      peers.push(t);
      left++;
    }
  }
  let right = 0;
  for (let i = selfIndex + 1; i < intervals.length && right < maxEachSide; i++) {
    const t = intervals[i]?.text.trim();
    if (t) {
      peers.push(t);
      right++;
    }
  }
  return peers;
}

function getBoundaryBounds(
  tg: TextGrid,
  tierIndex: number,
  oldT: number,
  shared: boolean
): { minAllowed: number; maxAllowed: number } {
  let minAllowed = -Infinity;
  let maxAllowed = Infinity;
  if (shared) {
    for (const t of tg.tiers) {
      if (t.kind === 'intervalTier') {
        const b = getBoundaryBoundsForTier(t, oldT);
        minAllowed = Math.max(minAllowed, b.minAllowed);
        maxAllowed = Math.min(maxAllowed, b.maxAllowed);
      }
    }
  } else {
    const tier = tg.tiers[tierIndex];
    if (tier) {
      const b = getBoundaryBoundsForTier(tier, oldT);
      minAllowed = b.minAllowed;
      maxAllowed = b.maxAllowed;
    }
  }
  return { minAllowed, maxAllowed };
}

const DragGripIcon: React.FC = () => (
  <svg width={11} height={11} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
    <circle cx="4" cy="2.5" r="0.95" />
    <circle cx="8" cy="2.5" r="0.95" />
    <circle cx="4" cy="6" r="0.95" />
    <circle cx="8" cy="6" r="0.95" />
    <circle cx="4" cy="9.5" r="0.95" />
    <circle cx="8" cy="9.5" r="0.95" />
  </svg>
);

const MoreDotsIcon: React.FC = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.2" />
    <circle cx="8" cy="8" r="1.2" />
    <circle cx="12.5" cy="8" r="1.2" />
  </svg>
);

const CollapseIcon: React.FC = () => (
  <svg
    width={12}
    height={12}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M4 8h8" />
  </svg>
);

const ExpandIcon: React.FC = () => (
  <svg
    width={12}
    height={12}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 10l3-3 3 3" />
  </svg>
);

const NudgeLeftIcon: React.FC = () => (
  <svg
    width={13}
    height={13}
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.55}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8.5 3.5L5 7l3.5 3.5" />
  </svg>
);

const NudgeRightIcon: React.FC = () => (
  <svg
    width={13}
    height={13}
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.55}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5.5 3.5L9 7l-3.5 3.5" />
  </svg>
);

const AnchoredPopover: React.FC<{
  open: boolean;
  alignRight?: boolean;
  className?: string;
  children: React.ReactNode;
}> = ({ open, alignRight = false, className = '', children }) => {
  const popRef = useRef<HTMLDivElement>(null);
  const [openUp, setOpenUp] = useState(false);
  const [shiftX, setShiftX] = useState(0);

  useLayoutEffect(() => {
    if (!open) {
      setOpenUp(false);
      setShiftX(0);
      return;
    }
    const el = popRef.current;
    if (!el) return;

    const z = getViewportZoom();
    const pad = 10 * z;
    // Measure in default downward placement first
    const rect = el.getBoundingClientRect();
    const overflowBottom = rect.bottom - (window.innerHeight - pad);
    const spaceAbove = rect.top - pad;
    const nextUp = overflowBottom > 0 && spaceAbove > rect.height + 16 * z;

    let nextShiftX = 0;
    if (rect.right > window.innerWidth - pad) {
      nextShiftX -= (rect.right - (window.innerWidth - pad)) / z;
    }
    if (rect.left + nextShiftX * z < pad) {
      nextShiftX += (pad - (rect.left + nextShiftX * z)) / z;
    }
    setOpenUp(nextUp);
    setShiftX(Math.round(nextShiftX));
  }, [open, alignRight, children]);

  if (!open) return null;

  return (
    <div
      ref={popRef}
      className={`fb-arch-popover ${alignRight ? 'align-right' : ''} ${openUp ? 'is-up' : ''} ${className}`}
      style={shiftX !== 0 ? { marginLeft: shiftX } : undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
};

export const FloatingActionBar = forwardRef<HTMLDivElement, FloatingActionBarProps>(
  (
    {
      selection,
      multiAnalysis,
      audioBuffer,
      visible,
      position,
      isDragging,
      onDragHandlePointerDown,
      onStartPlayback,
      onOpenInline,
      onCopyText,
      onShowScrubPreview,
      onClearScrubPreview,
      onRunSmartSplit,
      onOpenSplitModal
    },
    ref
  ) => {
    const tg = useEditorStore((s) => s.tg);
    const viewDomain = useEditorStore((s) => s.viewDomain);
    const setViewDomain = useEditorStore((s) => s.setViewDomain);
    const playRange = useEditorStore((s) => s.playRange);
    const setPlayRange = useEditorStore((s) => s.setPlayRange);
    const analysis = useEditorStore((s) => s.analysis);
    const hiddenTierIndices = useEditorStore((s) => s.hiddenTierIndices);
    const floatingBarConfig = useEditorStore((s) => s.floatingBarConfig);
    const floatingBarDensity: FloatingBarDensity = useEditorStore((s) => s.floatingBarDensity);
    const customShortcuts = useEditorStore((s) => s.customShortcuts);
    const smartSplitUseAcoustic = useEditorStore((s) => s.smartSplitUseAcoustic);
    const setSmartSplitUseAcoustic = useEditorStore((s) => s.setSmartSplitUseAcoustic);
    const setSelection = useEditorStore((s) => s.setSelection);
    const setSidebarTab = useEditorStore((s) => s.setSidebarTab);
    const setSidebarOpen = useEditorStore((s) => s.setSidebarOpen);
    const commitTgMutation = useEditorStore((s) => s.commitTgMutation);
    const showToast = useEditorStore((s) => s.showToast);

    const splitInterval = useEditorStore((s) => s.splitInterval);
    const splitIntervalEqualN = useEditorStore((s) => s.splitIntervalEqualN);
    const mergeIntervalWith = useEditorStore((s) => s.mergeIntervalWith);
    const deleteBoundaryAt = useEditorStore((s) => s.deleteBoundaryAt);
    const deleteBoundaryAcrossAllTiers = useEditorStore((s) => s.deleteBoundaryAcrossAllTiers);
    const moveTierBoundary = useEditorStore((s) => s.moveTierBoundary);
    const moveSharedTimestamp = useEditorStore((s) => s.moveSharedTimestamp);
    const movePointToTime = useEditorStore((s) => s.movePointToTime);
    const projectBoundaryToTier = useEditorStore((s) => s.projectBoundaryToTier);
    const copyIntervalSpanToTier = useEditorStore((s) => s.copyIntervalSpanToTier);
    const alignMicroBoundaries = useEditorStore((s) => s.alignMicroBoundaries);
    const convertSelectionIpa = useEditorStore((s) => s.convertSelectionIpa);

    const clearMultiSelection = useEditorStore((s) => s.clearMultiSelection);
    const clearMultiSelectionText = useEditorStore((s) => s.clearMultiSelectionText);
    const mergeMultiSelection = useEditorStore((s) => s.mergeMultiSelection);
    const alignMultiSelectionBounds = useEditorStore((s) => s.alignMultiSelectionBounds);
    const syncTransformMultiSelection = useEditorStore((s) => s.syncTransformMultiSelection);

    const toggleTierVisibility = useEditorStore((s) => s.toggleTierVisibility);
    const soloTier = useEditorStore((s) => s.soloTier);
    const showAllTiers = useEditorStore((s) => s.showAllTiers);
    const duplicateTier = useEditorStore((s) => s.duplicateTier);
    const moveTier = useEditorStore((s) => s.moveTier);
    const clearTierText = useEditorStore((s) => s.clearTierText);
    const removeTierWithUndoToast = useEditorStore((s) => s.removeTierWithUndoToast);

    const rootLocalRef = useRef<HTMLDivElement | null>(null);
    const setCombinedRef = useCallback(
      (node: HTMLDivElement | null) => {
        rootLocalRef.current = node;
        if (typeof ref === 'function') {
          ref(node);
        } else if (ref) {
          ref.current = node;
        }
      },
      [ref]
    );

    const [openPop, setOpenPop] = useState<PopoverId | null>(null);
    const [collapsed, setCollapsed] = useState(false);
    const [boundaryLinked, setBoundaryLinked] = useState<boolean>(selection.kind === 'spine');
    const [trigraphRev, setTrigraphRev] = useState(0);

    const isMulti = multiAnalysis.count >= 2 && selection.kind === 'interval';

    const selectionIdentity = useMemo(() => {
      if (isMulti) {
        return `multi:${multiAnalysis.count}:${multiAnalysis.envelopeXmin}:${multiAnalysis.envelopeXmax}`;
      }
      if (selection.kind === 'interval' || selection.kind === 'point') {
        return `${selection.kind}:${selection.tierIndex}:${selection.itemIndex}`;
      }
      if (selection.kind === 'boundary') {
        return `boundary:${selection.tierIndex}:${selection.time}`;
      }
      if (selection.kind === 'spine') {
        return `spine:${selection.time}`;
      }
      return `tier:${selection.tierIndex}`;
    }, [isMulti, multiAnalysis.count, multiAnalysis.envelopeXmin, multiAnalysis.envelopeXmax, selection]);

    // Close popovers on target switch & sync default boundary linkage
    useEffect(() => {
      setOpenPop(null);
      if (selection.kind === 'spine') {
        setBoundaryLinked(true);
      } else if (selection.kind === 'boundary') {
        setBoundaryLinked(false);
      }
    }, [selectionIdentity, selection.kind]);

    // Close open popover when clicking outside or pressing Escape
    useEffect(() => {
      if (!openPop) return;
      const onPointerDown = (e: PointerEvent) => {
        const root = rootLocalRef.current;
        if (root && e.target instanceof Node && root.contains(e.target)) return;
        setOpenPop(null);
      };
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setOpenPop(null);
        }
      };
      document.addEventListener('pointerdown', onPointerDown, true);
      window.addEventListener('keydown', onKeyDown, true);
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true);
        window.removeEventListener('keydown', onKeyDown, true);
      };
    }, [openPop]);

    // Prime Praat trigraph decode for single interval smart-split preview
    const activeSingleInterval =
      !isMulti && selection.kind === 'interval'
        ? tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex] ?? null
        : null;

    useEffect(() => {
      if (!activeSingleInterval?.text || !activeSingleInterval.text.includes('\\')) return;
      let cancelled = false;
      void primeTrigraphString(activeSingleInterval.text, getPlatformBridge()).then(() => {
        if (!cancelled) setTrigraphRev((v) => v + 1);
      });
      return () => {
        cancelled = true;
      };
    }, [activeSingleInterval?.text]);

    const smartSplitPlan = useMemo(() => {
      if (isMulti || selection.kind !== 'interval') return null;
      const tier = tg.tiers[selection.tierIndex];
      const iv = tier?.intervals[selection.itemIndex];
      if (!tier || !iv || iv.xmax <= iv.xmin) return null;
      const decoded = decodeTrigraphGlossSync(iv.text);
      const peers = collectPeerTextsLocal(tier.intervals, selection.itemIndex);
      return inferSmartSplit(iv.text, decoded, {
        tierName: tier.name,
        peerTexts: peers,
        hasAudio: Boolean(audioBuffer)
      });
    }, [isMulti, selection, tg, audioBuffer, trigraphRev]);

    const togglePop = useCallback((id: PopoverId) => {
      setOpenPop((prev) => (prev === id ? null : id));
    }, []);

    const openInspectorSidebar = useCallback(() => {
      setOpenPop(null);
      setSidebarTab('inspector');
      setSidebarOpen(true);
    }, [setSidebarTab, setSidebarOpen]);

    const isCompact = floatingBarDensity === 'compact';
    const isNumeric = floatingBarDensity === 'numeric';

    // Helper: derive exact ordered visible & hidden item IDs from user config
    const getOrderedPartition = useCallback(
      (target: 'interval' | 'multi' | 'boundary' | 'point' | 'tier') => {
        const sec = floatingBarConfig[target];
        const order = sec?.order ?? [];
        const hiddenSet = new Set(sec?.hidden ?? []);
        const visibleIds = order.filter((id) => !hiddenSet.has(id));
        const hiddenIds = order.filter((id) => hiddenSet.has(id));
        return { visibleIds, hiddenIds, hiddenSet };
      },
      [floatingBarConfig]
    );

    const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (isComposingEvent(e)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.currentTarget.blur();
      }
    };

    // --- Action Helpers for Interval ---
    const commitIntervalStart = useCallback(
      (ti: number, ii: number, val: number): boolean => {
        const tier = tg.tiers[ti];
        const iv = tier?.intervals[ii];
        if (!tier || !iv) return false;
        const prev = tier.intervals[ii - 1];
        if (val >= iv.xmax) {
          showToast('起点必须严格小于终点', true);
          return false;
        }
        if (prev && prev.xmax === iv.xmin && val <= prev.xmin) {
          showToast('起点不能越过左侧相邻区间', true);
          return false;
        }
        if (Math.abs(val - iv.xmin) <= 1e-12) return true;
        const tierName = formatTierLabel(tier.name, ti);
        const oldVal = iv.xmin;
        commitTgMutation(
          (_draft, ctx) => {
            const dTier = ctx.editTier(ti);
            if (!dTier || dTier.kind !== 'intervalTier') return false;
            const dPrev = dTier.intervals[ii - 1];
            const cur = dTier.intervals[ii];
            if (!cur) return false;
            if (dPrev && dPrev.xmax === cur.xmin && val > dPrev.xmin) dPrev.xmax = val;
            cur.xmin = val;
            ctx.setNextPlayRange({ start: val, end: cur.xmax });
          },
          undefined,
          {
            type: 'edit-interval-edge',
            title: '调整区间起点',
            detail: `${tierName} · 起点 ${formatTimeSec(oldVal)} → ${formatTimeSec(val)} (${formatDeltaTime(val - oldVal)})`,
            icon: 'nudgeFine',
            tierName,
            focusTime: val,
            coalesce: {
              key: `edge:${ti}:${ii}:start`,
              originValue: oldVal,
              latestValue: val,
              chainPrevLatest: oldVal,
              formatMergedDetail: (orig, latest, count) => {
                const o = Number(orig);
                const l = Number(latest);
                return `${tierName} · 起点 ${formatTimeSec(o)} → ${formatTimeSec(l)} (${formatDeltaTime(l - o)}${count > 1 ? ` · ${count}次` : ''})`;
              }
            }
          }
        );
        return true;
      },
      [tg, showToast, commitTgMutation]
    );

    const commitIntervalEnd = useCallback(
      (ti: number, ii: number, val: number): boolean => {
        const tier = tg.tiers[ti];
        const iv = tier?.intervals[ii];
        if (!tier || !iv) return false;
        const next = tier.intervals[ii + 1];
        if (val <= iv.xmin) {
          showToast('终点必须严格大于起点', true);
          return false;
        }
        if (next && next.xmin === iv.xmax && val >= next.xmax) {
          showToast('终点不能越过右侧相邻区间', true);
          return false;
        }
        if (Math.abs(val - iv.xmax) <= 1e-12) return true;
        const tierName = formatTierLabel(tier.name, ti);
        const oldVal = iv.xmax;
        commitTgMutation(
          (_draft, ctx) => {
            const dTier = ctx.editTier(ti);
            if (!dTier || dTier.kind !== 'intervalTier') return false;
            const dNext = dTier.intervals[ii + 1];
            const cur = dTier.intervals[ii];
            if (!cur) return false;
            if (dNext && dNext.xmin === cur.xmax && val < dNext.xmax) dNext.xmin = val;
            cur.xmax = val;
            ctx.setNextPlayRange({ start: cur.xmin, end: val });
          },
          undefined,
          {
            type: 'edit-interval-edge',
            title: '调整区间终点',
            detail: `${tierName} · 终点 ${formatTimeSec(oldVal)} → ${formatTimeSec(val)} (${formatDeltaTime(val - oldVal)})`,
            icon: 'nudgeFine',
            tierName,
            focusTime: val,
            coalesce: {
              key: `edge:${ti}:${ii}:end`,
              originValue: oldVal,
              latestValue: val,
              chainPrevLatest: oldVal,
              formatMergedDetail: (orig, latest, count) => {
                const o = Number(orig);
                const l = Number(latest);
                return `${tierName} · 终点 ${formatTimeSec(o)} → ${formatTimeSec(l)} (${formatDeltaTime(l - o)}${count > 1 ? ` · ${count}次` : ''})`;
              }
            }
          }
        );
        return true;
      },
      [tg, showToast, commitTgMutation]
    );

    const nudgeIntervalSpan = useCallback(
      (ti: number, ii: number, delta: number) => {
        const tier = tg.tiers[ti];
        const iv = tier?.intervals[ii];
        if (!tier || !iv) return;
        const prev = tier.intervals[ii - 1];
        const next = tier.intervals[ii + 1];
        const nextMin = round6(iv.xmin + delta);
        const nextMax = round6(iv.xmax + delta);
        if (prev && prev.xmax === iv.xmin && nextMin <= prev.xmin + 1e-4) {
          showToast('已抵近左侧相邻区间边界', true);
          return;
        }
        if (next && next.xmin === iv.xmax && nextMax >= next.xmax - 1e-4) {
          showToast('已抵近右侧相邻区间边界', true);
          return;
        }
        if (nextMin < tier.xmin - 1e-9 || nextMax > tier.xmax + 1e-9) {
          showToast('已抵近层级时间边界', true);
          return;
        }
        const tierName = formatTierLabel(tier.name, ti);
        commitTgMutation(
          (_d, ctx) => {
            const dTier = ctx.editTier(ti);
            if (!dTier || dTier.kind !== 'intervalTier') return false;
            const dPrev = dTier.intervals[ii - 1];
            const dNext = dTier.intervals[ii + 1];
            const cur = dTier.intervals[ii];
            if (!cur) return false;
            if (dPrev && dPrev.xmax === cur.xmin) dPrev.xmax = nextMin;
            if (dNext && dNext.xmin === cur.xmax) dNext.xmin = nextMax;
            cur.xmin = nextMin;
            cur.xmax = nextMax;
            ctx.setNextPlayRange({ start: nextMin, end: nextMax });
          },
          undefined,
          {
            type: 'edit-interval-edge',
            title: '平移区间',
            detail: `${tierName} · ${formatDeltaTime(delta)}`,
            icon: 'nudgeFine',
            tierName,
            focusTime: nextMin
          }
        );
      },
      [tg, showToast, commitTgMutation]
    );

    const snapIntervalEdgeZeroCrossing = useCallback(
      async (ti: number, ii: number, edge: 'start' | 'end') => {
        if (!analysis) {
          showToast('请先载入录音以使用过零点吸附');
          return;
        }
        const tier = tg.tiers[ti];
        const iv = tier?.intervals[ii];
        if (!tier || !iv) return;
        const targetT = edge === 'start' ? iv.xmin : iv.xmax;
        try {
          const zt = round6(
            await getPlatformBridge().findZeroCrossing(analysis.sessionId, targetT, 0.015)
          );
          if (!Number.isFinite(zt) || Math.abs(zt - targetT) < 1e-7) {
            showToast(edge === 'start' ? '起点已位于最近过零点' : '终点已位于最近过零点');
            return;
          }
          const ok =
            edge === 'start' ? commitIntervalStart(ti, ii, zt) : commitIntervalEnd(ti, ii, zt);
          if (ok) {
            showToast(`已将${edge === 'start' ? '起点' : '终点'}吸附至过零点 (${formatPraatDouble(zt)} s)`);
          }
        } catch {
          showToast('过零点吸附失败', true);
        }
      },
      [analysis, tg, showToast, commitIntervalStart, commitIntervalEnd]
    );

    const moveIntervalToPlayRange = useCallback(
      (ti: number, ii: number) => {
        if (!playRange || playRange.end <= playRange.start) {
          showToast('当前没有有效的播放选区', true);
          return;
        }
        const tier = tg.tiers[ti];
        const iv = tier?.intervals[ii];
        if (!tier || !iv) return;
        const prev = tier.intervals[ii - 1];
        const next = tier.intervals[ii + 1];
        const t0 = round6(playRange.start);
        const t1 = round6(playRange.end);
        if (prev && prev.xmax === iv.xmin && t0 <= prev.xmin + 1e-4) {
          showToast('选区起点超出左侧相邻区间，无法移入', true);
          return;
        }
        if (next && next.xmin === iv.xmax && t1 >= next.xmax - 1e-4) {
          showToast('选区终点超出右侧相邻区间，无法移入', true);
          return;
        }
        const tierName = formatTierLabel(tier.name, ti);
        commitTgMutation(
          (_d, ctx) => {
            const dTier = ctx.editTier(ti);
            if (!dTier || dTier.kind !== 'intervalTier') return false;
            const dPrev = dTier.intervals[ii - 1];
            const dNext = dTier.intervals[ii + 1];
            const cur = dTier.intervals[ii];
            if (!cur) return false;
            if (dPrev && dPrev.xmax === cur.xmin) dPrev.xmax = t0;
            if (dNext && dNext.xmin === cur.xmax) dNext.xmin = t1;
            cur.xmin = t0;
            cur.xmax = t1;
          },
          undefined,
          {
            type: 'edit-interval-edge',
            title: '移到当前选区',
            detail: `${tierName} · ${formatTimeSec(t0)}–${formatTimeSec(t1)}`,
            icon: 'nudgeShared',
            tierName,
            focusTime: t0
          }
        );
        showToast('已将区间边界移到当前选区');
      },
      [playRange, tg, showToast, commitTgMutation]
    );

    // --- Action Helpers for Boundary / Spine ---
    const snapBoundaryOrSpineZeroCrossing = useCallback(
      async (linked: boolean) => {
        if (selection.kind !== 'boundary' && selection.kind !== 'spine') return;
        if (!analysis) {
          showToast('请先载入录音以使用过零点吸附');
          return;
        }
        try {
          const zt = round6(
            await getPlatformBridge().findZeroCrossing(analysis.sessionId, selection.time, 0.015)
          );
          if (!Number.isFinite(zt) || Math.abs(zt - selection.time) < 1e-7) {
            showToast('当前已位于最近过零点');
            return;
          }
          let ok = false;
          if (selection.kind === 'boundary') {
            ok = moveTierBoundary(selection.tierIndex, selection.time, zt, linked, {
              coalesce: false,
              actionMeta: { type: 'snap-zero-crossing' },
              nextSelection: {
                kind: 'boundary',
                tierIndex: selection.tierIndex,
                time: zt,
                bandIndex: selection.bandIndex
              }
            });
          } else {
            ok = moveSharedTimestamp(selection.time, zt, {
              coalesce: false,
              actionMeta: { type: 'snap-zero-crossing' },
              nextSelection: {
                kind: 'spine',
                time: zt,
                bandIndex: selection.bandIndex
              }
            });
          }
          if (ok) {
            showToast(
              linked
                ? `已联动吸附至过零点 (${formatPraatDouble(zt)} s)`
                : `已吸附至过零点 (${formatPraatDouble(zt)} s)`
            );
          }
        } catch {
          showToast('过零点吸附失败', true);
        }
      },
      [selection, analysis, moveTierBoundary, moveSharedTimestamp, showToast]
    );

    const nudgeBoundaryOrSpine = useCallback(
      (delta: number, linked: boolean) => {
        if (selection.kind !== 'boundary' && selection.kind !== 'spine') return;
        const { minAllowed, maxAllowed } = getBoundaryBounds(
          tg,
          selection.kind === 'boundary' ? selection.tierIndex : 0,
          selection.time,
          linked || selection.kind === 'spine'
        );
        const rawNext = round6(selection.time + delta);
        const clamped = Math.max(
          Number.isFinite(minAllowed) ? minAllowed + 1e-4 : -Infinity,
          Math.min(Number.isFinite(maxAllowed) ? maxAllowed - 1e-4 : Infinity, rawNext)
        );
        const nextT = round6(clamped);
        if (Math.abs(nextT - selection.time) < 1e-7) {
          showToast('已抵近相邻边界限制', true);
          return;
        }
        if (selection.kind === 'boundary') {
          moveTierBoundary(selection.tierIndex, selection.time, nextT, linked, {
            nextSelection: {
              kind: 'boundary',
              tierIndex: selection.tierIndex,
              time: nextT,
              bandIndex: selection.bandIndex
            }
          });
        } else {
          moveSharedTimestamp(selection.time, nextT, {
            nextSelection: {
              kind: 'spine',
              time: nextT,
              bandIndex: selection.bandIndex
            }
          });
        }
      },
      [selection, tg, moveTierBoundary, moveSharedTimestamp, showToast]
    );

    // --- Action Helpers for Point ---
    const snapPointZeroCrossing = useCallback(async () => {
      if (selection.kind !== 'point') return;
      const tier = tg.tiers[selection.tierIndex];
      const pt = tier?.points[selection.itemIndex];
      if (!tier || !pt) return;
      if (!analysis) {
        showToast('请先载入录音以使用过零点吸附');
        return;
      }
      try {
        const zt = round6(
          await getPlatformBridge().findZeroCrossing(analysis.sessionId, pt.number, 0.015)
        );
        if (!Number.isFinite(zt) || Math.abs(zt - pt.number) < 1e-7) {
          showToast('当前标点已位于最近过零点');
          return;
        }
        if (movePointToTime(selection.tierIndex, selection.itemIndex, zt, '吸附过零点')) {
          showToast(`已吸附至过零点 (${formatPraatDouble(zt)} s)`);
        }
      } catch {
        showToast('过零点吸附失败', true);
      }
    }, [selection, tg, analysis, movePointToTime, showToast]);

    const snapPointNearestBoundary = useCallback(() => {
      if (selection.kind !== 'point') return;
      const tier = tg.tiers[selection.tierIndex];
      const pt = tier?.points[selection.itemIndex];
      if (!tier || !pt) return;
      const hiddenSet = new Set(hiddenTierIndices);
      const allHidden = hiddenSet.size >= tg.tiers.length;
      let bestT: number | null = null;
      let bestDist = Infinity;
      for (let idx = 0; idx < tg.tiers.length; idx++) {
        if (!allHidden && hiddenSet.has(idx)) continue;
        const t = tg.tiers[idx];
        if (t.kind !== 'intervalTier') continue;
        for (const iv of t.intervals) {
          for (const cand of [iv.xmin, iv.xmax]) {
            if (cand < tier.xmin - 1e-9 || cand > tier.xmax + 1e-9) continue;
            const d = Math.abs(cand - pt.number);
            if (d < bestDist) {
              bestDist = d;
              bestT = cand;
            }
          }
        }
      }
      if (bestT === null) {
        showToast('未找到可吸附的区间边界', true);
        return;
      }
      if (bestDist <= 1e-7) {
        showToast('当前标点已对齐最近边界');
        return;
      }
      if (movePointToTime(selection.tierIndex, selection.itemIndex, round6(bestT), '吸附附近边界')) {
        showToast(`已吸附至附近边界 (${bestT.toFixed(4)} s)`);
      }
    }, [selection, tg, hiddenTierIndices, movePointToTime, showToast]);

    const movePointToIntervalMid = useCallback(() => {
      if (selection.kind !== 'point') return;
      const tier = tg.tiers[selection.tierIndex];
      const pt = tier?.points[selection.itemIndex];
      if (!tier || !pt) return;
      const hiddenSet = new Set(hiddenTierIndices);
      const allHidden = hiddenSet.size >= tg.tiers.length;
      const ordered = tg.tiers
        .map((t, idx) => ({ t, idx }))
        .filter(({ t, idx }) => t.kind === 'intervalTier' && (allHidden || !hiddenSet.has(idx)))
        .sort((a, b) => Math.abs(a.idx - selection.tierIndex) - Math.abs(b.idx - selection.tierIndex));

      let targetMid: number | null = null;
      for (const { t } of ordered) {
        const iv = t.intervals.find(
          (seg) => seg.xmax > seg.xmin && seg.xmin <= pt.number + 1e-6 && seg.xmax >= pt.number - 1e-6
        );
        if (iv) {
          targetMid = round6((iv.xmin + iv.xmax) / 2);
          break;
        }
      }
      if (targetMid === null) {
        showToast('当前时刻没有可对齐的区间', true);
        return;
      }
      if (Math.abs(targetMid - pt.number) <= 1e-7) {
        showToast('标点已位于该区间中点');
        return;
      }
      if (movePointToTime(selection.tierIndex, selection.itemIndex, targetMid, '移到区间中点')) {
        showToast(`已移至区间中点 (${targetMid.toFixed(4)} s)`);
      }
    }, [selection, tg, hiddenTierIndices, movePointToTime, showToast]);

    const nudgePointTime = useCallback(
      (delta: number) => {
        if (selection.kind !== 'point') return;
        const tier = tg.tiers[selection.tierIndex];
        const pt = tier?.points[selection.itemIndex];
        if (!tier || !pt) return;
        const nextT = round6(Math.max(tier.xmin, Math.min(tier.xmax, pt.number + delta)));
        if (Math.abs(nextT - pt.number) < 1e-7) return;
        if (tier.points.some((p, i) => i !== selection.itemIndex && Math.abs(p.number - nextT) < 1e-7)) {
          showToast('目标时刻已存在标点', true);
          return;
        }
        movePointToTime(selection.tierIndex, selection.itemIndex, nextT, '微调标点时刻');
      },
      [selection, tg, movePointToTime, showToast]
    );

    // =========================================================================
    // Resolve Object Kind, Metadata, Mini Action, Time Popover & Action Body
    // =========================================================================

    const objClass: 'interval' | 'multi' | 'boundary' | 'point' | 'tier' = isMulti
      ? 'multi'
      : selection.kind === 'spine' || selection.kind === 'boundary'
        ? 'boundary'
        : selection.kind;

    let kindLabel = '';
    let ctxLabel = '';
    let timeSummary = '';
    let quickPlayHandler: (() => void) | null = null;
    let timePopoverContent: React.ReactNode = null;
    let bodyContent: React.ReactNode = null;

    // -------------------------------------------------------------------------
    // 1. MULTI-SELECTION (≥2 intervals)
    // -------------------------------------------------------------------------
    if (isMulti) {
      const caps = multiAnalysis.capabilities;
      const envMin = multiAnalysis.envelopeXmin;
      const envMax = multiAnalysis.envelopeXmax;
      const envDur = Math.max(0, envMax - envMin);
      const canShift = caps.canSyncMove || caps.canGroupMove;
      const canAlignMenu = caps.canAlignBounds || Boolean(caps.canRemapToPlayRange && playRange);

      kindLabel = '多选';
      ctxLabel = `已选 ${multiAnalysis.count} 段 · ${formatMultiSummaryLabel(multiAnalysis.topology)}`;
      timeSummary = `${formatCompactSec(envMin)}–${formatCompactSec(envMax)}s · ${formatCompactDur(envDur)}`;

      quickPlayHandler = () => {
        if (envMax > envMin) {
          setPlayRange({ start: envMin, end: envMax });
          onStartPlayback(envMin, envMax);
        }
      };

      timePopoverContent = (
        <div className="fb-arch-time-pop">
          <div className="fb-arch-time-head">
            <span>合并范围（{multiAnalysis.count} 段 · {formatMultiSummaryLabel(multiAnalysis.topology)}）</span>
            <span>{formatCompactDur(envDur)}</span>
          </div>
          <div className="fb-arch-time-grid">
            <div className="fb-arch-time-col">
              <span className="fb-arch-time-col-lbl">合并起点 (s)</span>
              <div className="fb-arch-time-readonly">{formatPraatDouble(envMin)}</div>
            </div>
            <div className="fb-arch-time-col">
              <span className="fb-arch-time-col-lbl">合并终点 (s)</span>
              <div className="fb-arch-time-readonly">{formatPraatDouble(envMax)}</div>
            </div>
          </div>
          <div className="fb-arch-time-foot">
            <span>整体平移</span>
            <div className="fb-arch-time-steps">
              <button
                type="button"
                className="fb-arch-step-btn"
                disabled={!canShift}
                onClick={() => syncTransformMultiSelection('move', -0.005)}
              >
                -5ms
              </button>
              <button
                type="button"
                className="fb-arch-step-btn"
                disabled={!canShift}
                onClick={() => syncTransformMultiSelection('move', -0.001)}
              >
                -1ms
              </button>
              <button
                type="button"
                className="fb-arch-step-btn"
                disabled={!canShift}
                onClick={() => syncTransformMultiSelection('move', 0.001)}
              >
                +1ms
              </button>
              <button
                type="button"
                className="fb-arch-step-btn"
                disabled={!canShift}
                onClick={() => syncTransformMultiSelection('move', 0.005)}
              >
                +5ms
              </button>
            </div>
          </div>
        </div>
      );

      const { visibleIds: multiVisible, hiddenIds: multiHidden } = getOrderedPartition('multi');
      const isZoomedMulti = Boolean(
        viewDomain &&
          Math.abs(viewDomain.min - envMin) < 1e-4 &&
          Math.abs(viewDomain.max - envMax) < 1e-4
      );

      const renderMultiAction = (id: string): React.ReactNode => {
        switch (id) {
          case 'ml-merge':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn is-primary"
                disabled={!caps.canMerge}
                title={
                  caps.canMerge
                    ? `合并所选 ${multiAnalysis.count} 个连续区间`
                    : '仅同层连续选中的区间可合并'
                }
                onClick={() => {
                  setOpenPop(null);
                  mergeMultiSelection();
                }}
              >
                <UiIcon name="mergeRight" size={13} />
                <span>{isCompact ? '合并' : `合并 ${multiAnalysis.count} 段`}</span>
              </button>
            );
          case 'ml-align':
            return (
              <div key={id} className="fb-arch-anchor">
                <button
                  type="button"
                  className={`fb-arch-btn ${openPop === 'align' ? 'is-open' : ''}`}
                  disabled={!canAlignMenu}
                  title="批量对齐所选区间的起止边界"
                  onClick={() => togglePop('align')}
                >
                  <UiIcon name="nudgeShared" size={13} />
                  <span>{isCompact ? '对齐' : '对齐边界'}</span>
                  <ChevronIcon size={10} />
                </button>
                <AnchoredPopover open={openPop === 'align'}>
                  <div className="fb-arch-pop-title">批量边界对齐</div>
                  <button
                    type="button"
                    className="fb-arch-pop-item is-rec"
                    disabled={!caps.canAlignBounds}
                    onClick={() => {
                      setOpenPop(null);
                      alignMultiSelectionBounds('to-primary');
                    }}
                  >
                    <span className="fb-arch-pop-lead">
                      <UiIcon name="nudgeShared" size={13} />
                      <span>对齐到主选区间</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="fb-arch-pop-item"
                    disabled={!caps.canAlignBounds}
                    onClick={() => {
                      setOpenPop(null);
                      alignMultiSelectionBounds('to-envelope');
                    }}
                  >
                    <span className="fb-arch-pop-lead">
                      <UiIcon name="nudgeShared" size={13} />
                      <span>对齐到合并范围</span>
                    </span>
                    <span className="fb-arch-pop-sub">{formatCompactDur(envDur)}</span>
                  </button>
                  <button
                    type="button"
                    className="fb-arch-pop-item"
                    disabled={!(caps.canRemapToPlayRange && playRange)}
                    onClick={() => {
                      if (!playRange) return;
                      setOpenPop(null);
                      alignMultiSelectionBounds('to-range', playRange);
                    }}
                  >
                    <span className="fb-arch-pop-lead">
                      <UiIcon name="createFromRange" size={13} />
                      <span>移到当前选区</span>
                    </span>
                  </button>
                </AnchoredPopover>
              </div>
            );
          case 'ml-play':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn"
                disabled={envMax <= envMin}
                title="播放所选区间合并范围"
                onClick={() => quickPlayHandler?.()}
              >
                <UiIcon name="play" size={13} />
                <span>{isCompact ? '播放' : '播放范围'}</span>
              </button>
            );
          case 'ml-nudge':
            return (
              <React.Fragment key={id}>
                <button
                  type="button"
                  className="fb-arch-btn is-icon"
                  disabled={!canShift}
                  title="整体左移 5 ms"
                  onClick={() => syncTransformMultiSelection('move', -0.005)}
                >
                  <NudgeLeftIcon />
                </button>
                <button
                  type="button"
                  className="fb-arch-btn is-icon"
                  disabled={!canShift}
                  title="整体右移 5 ms"
                  onClick={() => syncTransformMultiSelection('move', 0.005)}
                >
                  <NudgeRightIcon />
                </button>
              </React.Fragment>
            );
          case 'ml-clear':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn is-danger"
                disabled={!caps.canClearText}
                title={`批量清空所选 ${multiAnalysis.nonEmptyCount} 项文本`}
                onClick={() => {
                  setOpenPop(null);
                  clearMultiSelectionText();
                }}
              >
                <UiIcon name="clear" size={13} />
                <span>{isCompact ? '清空' : `清空 (${multiAnalysis.nonEmptyCount})`}</span>
              </button>
            );
          case 'ml-zoom':
            return (
              <button
                key={id}
                type="button"
                className={`fb-arch-btn is-icon ${isZoomedMulti ? 'is-active-toggle' : ''}`}
                disabled={!isZoomedMulti && envMax <= envMin}
                title={isZoomedMulti ? '恢复全长视野' : '放大查看所选范围'}
                onClick={() =>
                  isZoomedMulti ? setViewDomain(null) : setViewDomain({ min: envMin, max: envMax })
                }
              >
                <UiIcon name={isZoomedMulti ? 'zoomReset' : 'zoomIn'} size={13} />
              </button>
            );
          default:
            return null;
        }
      };

      const renderMultiOverflowItem = (id: string): React.ReactNode => {
        switch (id) {
          case 'ml-merge':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                disabled={!caps.canMerge}
                onClick={() => {
                  setOpenPop(null);
                  mergeMultiSelection();
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="mergeRight" size={13} />
                  <span>合并所选 {multiAnalysis.count} 段</span>
                </span>
              </button>
            );
          case 'ml-align':
            return (
              <React.Fragment key={id}>
                <button
                  type="button"
                  className="fb-arch-pop-item"
                  disabled={!caps.canAlignBounds}
                  onClick={() => {
                    setOpenPop(null);
                    alignMultiSelectionBounds('to-primary');
                  }}
                >
                  <span className="fb-arch-pop-lead">
                    <UiIcon name="nudgeShared" size={13} />
                    <span>对齐到主选区间</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="fb-arch-pop-item"
                  disabled={!caps.canAlignBounds}
                  onClick={() => {
                    setOpenPop(null);
                    alignMultiSelectionBounds('to-envelope');
                  }}
                >
                  <span className="fb-arch-pop-lead">
                    <UiIcon name="nudgeShared" size={13} />
                    <span>对齐到合并范围</span>
                  </span>
                </button>
              </React.Fragment>
            );
          case 'ml-play':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                disabled={envMax <= envMin}
                onClick={() => {
                  setOpenPop(null);
                  quickPlayHandler?.();
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="play" size={13} />
                  <span>播放合并范围</span>
                </span>
              </button>
            );
          case 'ml-nudge':
            return (
              <React.Fragment key={id}>
                <button
                  type="button"
                  className="fb-arch-pop-item"
                  disabled={!canShift}
                  onClick={() => syncTransformMultiSelection('move', -0.005)}
                >
                  <span className="fb-arch-pop-lead">
                    <NudgeLeftIcon />
                    <span>整体左移 5 ms</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="fb-arch-pop-item"
                  disabled={!canShift}
                  onClick={() => syncTransformMultiSelection('move', 0.005)}
                >
                  <span className="fb-arch-pop-lead">
                    <NudgeRightIcon />
                    <span>整体右移 5 ms</span>
                  </span>
                </button>
              </React.Fragment>
            );
          case 'ml-zoom':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                disabled={!isZoomedMulti && envMax <= envMin}
                onClick={() => {
                  setOpenPop(null);
                  if (isZoomedMulti) setViewDomain(null);
                  else setViewDomain({ min: envMin, max: envMax });
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name={isZoomedMulti ? 'zoomReset' : 'zoomIn'} size={13} />
                  <span>{isZoomedMulti ? '恢复全长视野' : '放大查看所选范围'}</span>
                </span>
              </button>
            );
          case 'ml-clear':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item is-danger"
                disabled={!caps.canClearText}
                onClick={() => {
                  setOpenPop(null);
                  clearMultiSelectionText();
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="clear" size={13} />
                  <span>批量清空文本 ({multiAnalysis.nonEmptyCount})</span>
                </span>
              </button>
            );
          default:
            return null;
        }
      };

      bodyContent = (
        <>
          {multiVisible.map((id) => renderMultiAction(id))}
          {multiVisible.length > 0 && <div className="fb-arch-sep" />}

          <div className="fb-arch-anchor">
            <button
              type="button"
              className={`fb-arch-btn is-icon ${openPop === 'more' ? 'is-open' : ''}`}
              title="更多批量操作"
              onClick={() => togglePop('more')}
            >
              <MoreDotsIcon />
            </button>
            <AnchoredPopover open={openPop === 'more'} alignRight>
              <div className="fb-arch-pop-title">更多批量操作</div>
              {multiHidden.length > 0 && (
                <>
                  {multiHidden.map((id) => renderMultiOverflowItem(id))}
                  <div className="fb-arch-pop-div" />
                </>
              )}
              <button
                type="button"
                className="fb-arch-pop-item"
                disabled={multiAnalysis.nonEmptyCount === 0}
                onClick={() => {
                  setOpenPop(null);
                  void convertSelectionIpa('to-unicode');
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="convertUnicode" size={13} />
                  <span>批量转 Unicode 音标</span>
                </span>
              </button>
              <button
                type="button"
                className="fb-arch-pop-item"
                disabled={multiAnalysis.nonEmptyCount === 0}
                onClick={() => {
                  setOpenPop(null);
                  void convertSelectionIpa('to-praat');
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="convertPraat" size={13} />
                  <span>批量转 Praat 转义码</span>
                </span>
              </button>
              <div className="fb-arch-pop-div" />
              <button type="button" className="fb-arch-pop-item" onClick={openInspectorSidebar}>
                <span className="fb-arch-pop-lead">
                  <UiIcon name="inspector" size={13} />
                  <span>在右侧属性栏管理</span>
                </span>
              </button>
            </AnchoredPopover>
          </div>

          <button
            type="button"
            className="fb-arch-btn is-icon"
            title="取消复选 (Esc)"
            onClick={() => {
              setOpenPop(null);
              clearMultiSelection();
            }}
          >
            <CloseIcon size={12} />
          </button>
        </>
      );
    }

    // -------------------------------------------------------------------------
    // 2. SINGLE INTERVAL
    // -------------------------------------------------------------------------
    else if (selection.kind === 'interval') {
      const ti = selection.tierIndex;
      const ii = selection.itemIndex;
      const tier = tg.tiers[ti];
      const iv = tier?.intervals[ii];
      if (!tier || !iv) return null;

      const tierName = formatTierLabel(tier.name, ti);
      const durSec = Math.max(0, iv.xmax - iv.xmin);
      const prev = tier.intervals[ii - 1];
      const next = tier.intervals[ii + 1];
      const hasContigPrev = Boolean(prev && prev.xmax === iv.xmin);
      const hasContigNext = Boolean(next && next.xmin === iv.xmax);
      const isZoomedHere = Boolean(
        viewDomain &&
          Math.abs(viewDomain.min - iv.xmin) < 1e-4 &&
          Math.abs(viewDomain.max - iv.xmax) < 1e-4
      );
      const otherIntervalTiers = tg.tiers
        .map((t, idx) => ({ t, idx }))
        .filter(({ t, idx }) => t.kind === 'intervalTier' && idx !== ti);

      kindLabel = '区间';
      ctxLabel = `${tierName} #${ii + 1} · ${truncateLabel(iv.text, 16)}`;
      timeSummary = `${formatCompactSec(iv.xmin)}–${formatCompactSec(iv.xmax)}s · ${formatCompactDur(durSec)}`;

      const playInterval = () => {
        if (iv.xmax <= iv.xmin) return;
        setPlayRange({ start: iv.xmin, end: iv.xmax });
        onStartPlayback(iv.xmin, iv.xmax);
      };
      const playContext = () => {
        if (iv.xmax <= iv.xmin) return;
        const s = Math.max(tg.xmin, iv.xmin - 0.25);
        const en = Math.min(tg.xmax, iv.xmax + 0.25);
        if (en > s) onStartPlayback(s, en);
      };
      const clearIntervalText = () => {
        if (iv.text === '') return;
        const oldText = iv.text;
        commitTgMutation(
          (_d, ctx) => {
            const dTier = ctx.editTier(ti);
            const target = dTier?.intervals[ii];
            if (!target || target.text === '') return false;
            target.text = '';
          },
          selection,
          {
            type: 'clear-interval-text',
            title: '清空区间文本',
            detail: `${tierName} · 原${formatQuote(oldText)}`,
            icon: 'clear',
            tierName,
            focusTime: iv.xmin
          }
        );
      };

      const executePrimarySmartSplit = () => {
        setOpenPop(null);
        if (iv.xmax <= iv.xmin) return;
        if (smartSplitPlan?.primary) {
          void onRunSmartSplit(
            ti,
            ii,
            { xmin: iv.xmin, xmax: iv.xmax, text: iv.text },
            smartSplitPlan.primary,
            smartSplitPlan.alternatives,
            smartSplitUseAcoustic && Boolean(audioBuffer)
          );
        } else {
          splitInterval(ti, ii);
        }
      };

      quickPlayHandler = playInterval;

      const { visibleIds: ivVisible, hiddenIds: ivHidden } = getOrderedPartition('interval');

      timePopoverContent = (
        <div className="fb-arch-time-pop">
          <div className="fb-arch-time-head">
            <span>精确起止时间（可上下拖拽调值）</span>
            <span>{formatCompactDur(durSec)}</span>
          </div>
          <div className="fb-arch-time-grid">
            <div className="fb-arch-time-col">
              <span className="fb-arch-time-col-lbl">起点 (s)</span>
              <ScrubNumberInput
                variant="floating"
                value={iv.xmin}
                min={hasContigPrev && prev ? prev.xmin : undefined}
                strictMin={hasContigPrev}
                max={iv.xmax}
                strictMax
                formatValue={formatPraatDouble}
                onScrubPreview={(previewT) => onShowScrubPreview(previewT, ti, false)}
                onScrubEnd={onClearScrubPreview}
                onCommit={(val) => commitIntervalStart(ti, ii, val)}
              />
            </div>
            <div className="fb-arch-time-col">
              <span className="fb-arch-time-col-lbl">终点 (s)</span>
              <ScrubNumberInput
                variant="floating"
                value={iv.xmax}
                min={iv.xmin}
                strictMin
                max={hasContigNext && next ? next.xmax : undefined}
                strictMax={hasContigNext}
                formatValue={formatPraatDouble}
                onScrubPreview={(previewT) => onShowScrubPreview(previewT, ti, false)}
                onScrubEnd={onClearScrubPreview}
                onCommit={(val) => commitIntervalEnd(ti, ii, val)}
              />
            </div>
          </div>
          <div className="fb-arch-time-foot">
            <span>过零吸附</span>
            <div className="fb-arch-time-steps">
              <button
                type="button"
                className="fb-arch-step-btn"
                disabled={!analysis}
                title="将区间起点吸附至最近波形过零点"
                onClick={() => void snapIntervalEdgeZeroCrossing(ti, ii, 'start')}
              >
                起·过零
              </button>
              <button
                type="button"
                className="fb-arch-step-btn"
                disabled={!analysis}
                title="将区间终点吸附至最近波形过零点"
                onClick={() => void snapIntervalEdgeZeroCrossing(ti, ii, 'end')}
              >
                止·过零
              </button>
            </div>
          </div>
          <div className="fb-arch-time-foot">
            <span>平移微调</span>
            <div className="fb-arch-time-steps">
              <button
                type="button"
                className="fb-arch-step-btn"
                onClick={() => nudgeIntervalSpan(ti, ii, -0.005)}
              >
                -5ms
              </button>
              <button
                type="button"
                className="fb-arch-step-btn"
                onClick={() => nudgeIntervalSpan(ti, ii, -0.001)}
              >
                -1ms
              </button>
              <button
                type="button"
                className="fb-arch-step-btn"
                onClick={() => nudgeIntervalSpan(ti, ii, 0.001)}
              >
                +1ms
              </button>
              <button
                type="button"
                className="fb-arch-step-btn"
                onClick={() => nudgeIntervalSpan(ti, ii, 0.005)}
              >
                +5ms
              </button>
            </div>
          </div>
        </div>
      );

      const renderIntervalAction = (id: string): React.ReactNode => {
        switch (id) {
          case 'iv-play':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn is-primary"
                disabled={iv.xmax <= iv.xmin}
                title="播放当前区间"
                onClick={playInterval}
              >
                <UiIcon name="play" size={13} />
                <span>播放</span>
              </button>
            );
          case 'iv-play-ctx':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn"
                disabled={iv.xmax <= iv.xmin}
                title="前后扩展 250ms 试听"
                onClick={playContext}
              >
                <UiIcon name="playContext" size={13} />
                <span>{isCompact ? '试听' : '前后试听'}</span>
              </button>
            );
          case 'iv-edit':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn"
                title="编辑区间文本 (双击区间)"
                onClick={() => {
                  setOpenPop(null);
                  onOpenInline(selection);
                }}
              >
                <UiIcon name="edit" size={13} />
                <span>改字</span>
              </button>
            );
          case 'iv-split':
            return (
              <div key={id} className="fb-arch-anchor">
                <div className="fb-arch-split-group">
                  <button
                    type="button"
                    className="fb-arch-btn is-split-main"
                    disabled={iv.xmax <= iv.xmin}
                    title={
                      smartSplitPlan?.primary
                        ? `执行首推拆分：${smartSplitPlan.primary.strategyLabel}（${smartSplitPlan.primary.texts.length} 段${smartSplitUseAcoustic && audioBuffer ? ' · 声学对齐' : ''}）`
                        : '在区间正中切分'
                    }
                    onClick={executePrimarySmartSplit}
                  >
                    <UiIcon name="autoSplit" size={13} />
                    <span>{isCompact ? '拆分' : '智能拆分'}</span>
                  </button>
                  <button
                    type="button"
                    className={`fb-arch-btn is-split-caret ${openPop === 'split' ? 'is-open' : ''}`}
                    disabled={iv.xmax <= iv.xmin}
                    title="展开更多拆分策略与等分选项"
                    aria-expanded={openPop === 'split'}
                    onClick={() => togglePop('split')}
                  >
                    <ChevronIcon size={10} />
                  </button>
                </div>
                <AnchoredPopover open={openPop === 'split'}>
                  <div className="fb-arch-pop-title">智能与规则拆分</div>
                  {smartSplitPlan?.primary && (
                    <button
                      type="button"
                      className="fb-arch-pop-item is-rec"
                      onClick={executePrimarySmartSplit}
                    >
                      <span className="fb-arch-pop-lead">
                        <UiIcon name="autoSplit" size={13} />
                        <span>{smartSplitPlan.primary.strategyLabel}</span>
                      </span>
                      <span className="fb-arch-pop-sub">
                        {smartSplitPlan.primary.texts.length} 段
                        {smartSplitUseAcoustic && audioBuffer ? ' · 声学' : ''}
                      </span>
                    </button>
                  )}
                  {smartSplitPlan?.alternatives.slice(0, 3).map((alt) => (
                    <button
                      key={alt.id}
                      type="button"
                      className="fb-arch-pop-item"
                      onClick={() => {
                        setOpenPop(null);
                        const otherAlts = [
                          ...(smartSplitPlan.primary ? [smartSplitPlan.primary] : []),
                          ...smartSplitPlan.alternatives.filter((c) => c.id !== alt.id)
                        ];
                        void onRunSmartSplit(
                          ti,
                          ii,
                          { xmin: iv.xmin, xmax: iv.xmax, text: iv.text },
                          alt,
                          otherAlts,
                          smartSplitUseAcoustic && Boolean(audioBuffer)
                        );
                      }}
                    >
                      <span className="fb-arch-pop-lead">
                        <UiIcon name="split" size={13} />
                        <span>{alt.strategyLabel}</span>
                      </span>
                      <span className="fb-arch-pop-sub">{alt.texts.length} 段</span>
                    </button>
                  ))}
                  <div
                    className={`fb-arch-pop-toggle-row ${!audioBuffer ? 'is-disabled' : ''}`}
                    role="checkbox"
                    aria-checked={smartSplitUseAcoustic && Boolean(audioBuffer)}
                    onClick={() => {
                      if (!audioBuffer) return;
                      setSmartSplitUseAcoustic(!smartSplitUseAcoustic);
                    }}
                  >
                    <span className="fb-arch-pop-lead">
                      <UiIcon name="waveform" size={13} />
                      <span>声学切点对齐{!audioBuffer ? '（需录音）' : ''}</span>
                    </span>
                    <span
                      className={`fb-arch-pop-check ${smartSplitUseAcoustic && audioBuffer ? 'is-on' : ''}`}
                    >
                      {smartSplitUseAcoustic && audioBuffer && <UiIcon name="check" size={10} />}
                    </span>
                  </div>
                  <div className="fb-arch-pop-div" />
                  <button
                    type="button"
                    className="fb-arch-pop-item"
                    onClick={() => {
                      setOpenPop(null);
                      splitInterval(ti, ii);
                    }}
                  >
                    <span className="fb-arch-pop-lead">
                      <UiIcon name="split" size={13} />
                      <span>正中切分</span>
                    </span>
                    <span className="fb-arch-pop-sub">2 段</span>
                  </button>
                  {([2, 3, 4] as const).map((n) => (
                    <button
                      key={n}
                      type="button"
                      className="fb-arch-pop-item"
                      onClick={() => {
                        setOpenPop(null);
                        splitIntervalEqualN(ti, ii, n);
                      }}
                    >
                      <span className="fb-arch-pop-lead">
                        <UiIcon name="splitEqual" size={13} />
                        <span>等分为 {n} 段</span>
                      </span>
                      <span className="fb-arch-pop-sub">{formatCompactDur(durSec / n)}</span>
                    </button>
                  ))}
                  <div className="fb-arch-pop-div" />
                  <button
                    type="button"
                    className="fb-arch-pop-item"
                    onClick={() => {
                      setOpenPop(null);
                      onOpenSplitModal(ti, ii);
                    }}
                  >
                    <span className="fb-arch-pop-lead">
                      <UiIcon name="customize" size={13} />
                      <span>自定义拆分与等分…</span>
                    </span>
                    <span className="fb-arch-pop-sub">N 段</span>
                  </button>
                </AnchoredPopover>
              </div>
            );
          case 'iv-merge-left':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn is-icon"
                disabled={ii === 0}
                title="向左合并"
                onClick={() => mergeIntervalWith(ti, ii, -1)}
              >
                <UiIcon name="mergeLeft" size={13} />
              </button>
            );
          case 'iv-merge-right':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn is-icon"
                disabled={ii >= tier.intervals.length - 1}
                title="向右合并"
                onClick={() => mergeIntervalWith(ti, ii, 1)}
              >
                <UiIcon name="mergeRight" size={13} />
              </button>
            );
          case 'iv-zoom':
            return (
              <button
                key={id}
                type="button"
                className={`fb-arch-btn is-icon ${isZoomedHere ? 'is-active-toggle' : ''}`}
                disabled={!isZoomedHere && iv.xmax <= iv.xmin}
                title={isZoomedHere ? '恢复全长视野' : '放大查看当前区间'}
                onClick={() =>
                  isZoomedHere ? setViewDomain(null) : setViewDomain({ min: iv.xmin, max: iv.xmax })
                }
              >
                <UiIcon name={isZoomedHere ? 'zoomReset' : 'zoomIn'} size={13} />
              </button>
            );
          case 'iv-copy-to-tier':
            return (
              <div key={id} className="fb-arch-anchor">
                <button
                  type="button"
                  className={`fb-arch-btn ${openPop === 'project' ? 'is-open' : ''}`}
                  disabled={otherIntervalTiers.length === 0}
                  title="将当前区间与文本复制到其他区间层"
                  onClick={() => togglePop('project')}
                >
                  <UiIcon name="projectToTier" size={13} />
                  <span>{isCompact ? '复制层' : '复制到层'}</span>
                  <ChevronIcon size={10} />
                </button>
                <AnchoredPopover open={openPop === 'project'}>
                  <div className="fb-arch-pop-title">复制到其他层</div>
                  {otherIntervalTiers.map(({ t, idx }) => (
                    <button
                      key={idx}
                      type="button"
                      className="fb-arch-pop-item"
                      onClick={() => {
                        setOpenPop(null);
                        copyIntervalSpanToTier(ti, ii, idx, true);
                      }}
                    >
                      <span className="fb-arch-pop-lead">
                        <UiIcon name="projectToTier" size={13} />
                        <span>{formatTierLabel(t.name, idx)}</span>
                      </span>
                      <span className="fb-arch-pop-sub">第 {idx + 1} 层</span>
                    </button>
                  ))}
                </AnchoredPopover>
              </div>
            );
          case 'iv-copy-text':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn"
                disabled={iv.text === ''}
                title="复制区间文本"
                onClick={() => {
                  setOpenPop(null);
                  onCopyText(iv.text, '区间文本');
                }}
              >
                <UiIcon name="copy" size={13} />
                <span>{isCompact ? '复制' : '复制文本'}</span>
              </button>
            );
          case 'iv-clear':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn is-danger"
                disabled={iv.text === ''}
                title="清空区间文本"
                onClick={() => {
                  setOpenPop(null);
                  clearIntervalText();
                }}
              >
                <UiIcon name="clear" size={13} />
                <span>清空</span>
              </button>
            );
          default:
            return null;
        }
      };

      const renderIntervalOverflowItem = (id: string): React.ReactNode => {
        switch (id) {
          case 'iv-play':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                disabled={iv.xmax <= iv.xmin}
                onClick={() => {
                  setOpenPop(null);
                  playInterval();
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="play" size={13} />
                  <span>播放区间</span>
                </span>
              </button>
            );
          case 'iv-play-ctx':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                disabled={iv.xmax <= iv.xmin}
                onClick={() => {
                  setOpenPop(null);
                  playContext();
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="playContext" size={13} />
                  <span>前后试听 ±250ms</span>
                </span>
              </button>
            );
          case 'iv-edit':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                onClick={() => {
                  setOpenPop(null);
                  onOpenInline(selection);
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="edit" size={13} />
                  <span>改字</span>
                </span>
              </button>
            );
          case 'iv-split':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                disabled={iv.xmax <= iv.xmin}
                onClick={executePrimarySmartSplit}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="autoSplit" size={13} />
                  <span>智能拆分</span>
                </span>
              </button>
            );
          case 'iv-merge-left':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                disabled={ii === 0}
                onClick={() => {
                  setOpenPop(null);
                  mergeIntervalWith(ti, ii, -1);
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="mergeLeft" size={13} />
                  <span>向左合并</span>
                </span>
              </button>
            );
          case 'iv-merge-right':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                disabled={ii >= tier.intervals.length - 1}
                onClick={() => {
                  setOpenPop(null);
                  mergeIntervalWith(ti, ii, 1);
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="mergeRight" size={13} />
                  <span>向右合并</span>
                </span>
              </button>
            );
          case 'iv-zoom':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                onClick={() => {
                  setOpenPop(null);
                  if (isZoomedHere) setViewDomain(null);
                  else setViewDomain({ min: iv.xmin, max: iv.xmax });
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name={isZoomedHere ? 'zoomReset' : 'zoomIn'} size={13} />
                  <span>{isZoomedHere ? '恢复全长视野' : '放大查看此段'}</span>
                </span>
              </button>
            );
          case 'iv-copy-to-tier':
            if (otherIntervalTiers.length === 0) return null;
            return (
              <React.Fragment key={id}>
                <div className="fb-arch-pop-title">复制到其他层</div>
                {otherIntervalTiers.map(({ t, idx }) => (
                  <button
                    key={idx}
                    type="button"
                    className="fb-arch-pop-item"
                    onClick={() => {
                      setOpenPop(null);
                      copyIntervalSpanToTier(ti, ii, idx, true);
                    }}
                  >
                    <span className="fb-arch-pop-lead">
                      <UiIcon name="projectToTier" size={13} />
                      <span>{formatTierLabel(t.name, idx)}</span>
                    </span>
                    <span className="fb-arch-pop-sub">第 {idx + 1} 层</span>
                  </button>
                ))}
              </React.Fragment>
            );
          case 'iv-copy-text':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                disabled={iv.text === ''}
                onClick={() => {
                  setOpenPop(null);
                  onCopyText(iv.text, '区间文本');
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="copy" size={13} />
                  <span>复制文本</span>
                </span>
              </button>
            );
          case 'iv-clear':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item is-danger"
                disabled={iv.text === ''}
                onClick={() => {
                  setOpenPop(null);
                  clearIntervalText();
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="clear" size={13} />
                  <span>清空区间文本</span>
                </span>
              </button>
            );
          default:
            return null;
        }
      };

      bodyContent = (
        <>
          {isNumeric && (
            <>
              <div className="fb-arch-inline-fields">
                <ScrubNumberInput
                  variant="floating"
                  label="起"
                  value={iv.xmin}
                  min={hasContigPrev && prev ? prev.xmin : undefined}
                  strictMin={hasContigPrev}
                  max={iv.xmax}
                  strictMax
                  formatValue={formatPraatDouble}
                  onScrubPreview={(previewT) => onShowScrubPreview(previewT, ti, false)}
                  onScrubEnd={onClearScrubPreview}
                  onCommit={(val) => commitIntervalStart(ti, ii, val)}
                />
                <ScrubNumberInput
                  variant="floating"
                  label="止"
                  value={iv.xmax}
                  min={iv.xmin}
                  strictMin
                  max={hasContigNext && next ? next.xmax : undefined}
                  strictMax={hasContigNext}
                  formatValue={formatPraatDouble}
                  onScrubPreview={(previewT) => onShowScrubPreview(previewT, ti, false)}
                  onScrubEnd={onClearScrubPreview}
                  onCommit={(val) => commitIntervalEnd(ti, ii, val)}
                />
              </div>
              {ivVisible.length > 0 && <div className="fb-arch-sep" />}
            </>
          )}

          {ivVisible.map((id) => renderIntervalAction(id))}
          {ivVisible.length > 0 && <div className="fb-arch-sep" />}

          <div className="fb-arch-anchor">
            <button
              type="button"
              className={`fb-arch-btn is-icon ${openPop === 'more' ? 'is-open' : ''}`}
              title="更多区间操作"
              onClick={() => togglePop('more')}
            >
              <MoreDotsIcon />
            </button>
            <AnchoredPopover open={openPop === 'more'} alignRight>
              <div className="fb-arch-pop-title">更多区间操作</div>
              {ivHidden.length > 0 && (
                <>
                  {ivHidden.map((id) => renderIntervalOverflowItem(id))}
                  <div className="fb-arch-pop-div" />
                </>
              )}
              <button
                type="button"
                className="fb-arch-pop-item"
                disabled={iv.text === ''}
                onClick={() => {
                  setOpenPop(null);
                  void convertSelectionIpa('to-unicode');
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="convertUnicode" size={13} />
                  <span>转为 Unicode 音标</span>
                </span>
              </button>
              <button
                type="button"
                className="fb-arch-pop-item"
                disabled={iv.text === ''}
                onClick={() => {
                  setOpenPop(null);
                  void convertSelectionIpa('to-praat');
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="convertPraat" size={13} />
                  <span>转为 Praat 转义码</span>
                </span>
              </button>
              <button
                type="button"
                className="fb-arch-pop-item"
                disabled={!playRange || playRange.end <= playRange.start}
                onClick={() => {
                  setOpenPop(null);
                  moveIntervalToPlayRange(ti, ii);
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="createFromRange" size={13} />
                  <span>移到当前选区</span>
                </span>
              </button>
              <div className="fb-arch-pop-div" />
              <button type="button" className="fb-arch-pop-item" onClick={openInspectorSidebar}>
                <span className="fb-arch-pop-lead">
                  <UiIcon name="inspector" size={13} />
                  <span>在右侧属性栏打开</span>
                </span>
              </button>
            </AnchoredPopover>
          </div>
        </>
      );
    }

    // -------------------------------------------------------------------------
    // 3. BOUNDARY / SPINE
    // -------------------------------------------------------------------------
    else if (selection.kind === 'boundary' || selection.kind === 'spine') {
      const t = selection.time;
      const isSpine = selection.kind === 'spine';
      const effectiveLinked = isSpine || boundaryLinked;

      // Find all interval tiers having an interior boundary at t
      const matchedTierIndices: number[] = [];
      tg.tiers.forEach((tier, idx) => {
        if (tier.kind !== 'intervalTier') return;
        const hasBnd = tier.intervals.some(
          (iv, i) => i > 0 && Math.abs(iv.xmin - t) <= 1e-6
        );
        if (hasBnd) matchedTierIndices.push(idx);
      });

      const otherIntervalTiers = tg.tiers
        .map((tier, idx) => ({ tier, idx }))
        .filter(({ tier, idx }) => {
          if (tier.kind !== 'intervalTier') return false;
          if (!isSpine && idx === selection.tierIndex) return false;
          return !matchedTierIndices.includes(idx);
        });

      const { minAllowed, maxAllowed } = getBoundaryBounds(
        tg,
        isSpine ? 0 : selection.tierIndex,
        t,
        effectiveLinked
      );

      let neighborDesc = '';
      if (!isSpine) {
        const tier = tg.tiers[selection.tierIndex];
        const tierName = formatTierLabel(tier?.name, selection.tierIndex);
        const leftIv = tier?.intervals.find((iv) => Math.abs(iv.xmax - t) <= 1e-6);
        const rightIv = tier?.intervals.find((iv) => Math.abs(iv.xmin - t) <= 1e-6);
        neighborDesc =
          leftIv || rightIv
            ? `${tierName} · ${truncateLabel(leftIv?.text || '', 8)} | ${truncateLabel(rightIv?.text || '', 8)}`
            : tierName;
      } else {
        neighborDesc =
          matchedTierIndices.length > 0
            ? `对齐 ${matchedTierIndices.length} 层`
            : '全局对齐时刻';
      }

      kindLabel = isSpine ? '对齐时刻' : '边界';
      ctxLabel = neighborDesc;
      timeSummary = `${formatCompactSec(t)} s`;

      const auditionCross = () => {
        const s = Math.max(tg.xmin, t - 0.2);
        const en = Math.min(tg.xmax, t + 0.2);
        if (en > s) onStartPlayback(s, en);
      };

      quickPlayHandler = auditionCross;

      const zHint = getEffectiveShortcutHint('snap-zero-crossing', customShortcuts);
      const { visibleIds: bndVisible, hiddenIds: bndHidden } = getOrderedPartition('boundary');

      const commitBoundaryTime = (val: number) => {
        if (isSpine) {
          return moveSharedTimestamp(t, val, {
            nextSelection: { kind: 'spine', time: val, bandIndex: selection.bandIndex }
          });
        }
        return moveTierBoundary(selection.tierIndex, t, val, effectiveLinked, {
          nextSelection: {
            kind: 'boundary',
            tierIndex: selection.tierIndex,
            time: val,
            bandIndex: selection.bandIndex
          }
        });
      };

      timePopoverContent = (
        <div className="fb-arch-time-pop">
          <div className="fb-arch-time-head">
            <span>{isSpine ? '对齐时刻微调' : '边界精确时刻'}</span>
            <span>{effectiveLinked ? '联动对齐层' : '仅本层'}</span>
          </div>
          <div className="fb-arch-time-grid is-single">
            <div className="fb-arch-time-col">
              <span className="fb-arch-time-col-lbl">时刻 (s) · {neighborDesc}</span>
              <ScrubNumberInput
                variant="floating"
                value={t}
                min={Number.isFinite(minAllowed) ? minAllowed : undefined}
                strictMin={Number.isFinite(minAllowed)}
                max={Number.isFinite(maxAllowed) ? maxAllowed : undefined}
                strictMax={Number.isFinite(maxAllowed)}
                formatValue={formatPraatDouble}
                onScrubPreview={(previewT) =>
                  onShowScrubPreview(previewT, isSpine ? 0 : selection.tierIndex, effectiveLinked)
                }
                onScrubEnd={onClearScrubPreview}
                onCommit={commitBoundaryTime}
              />
            </div>
          </div>
          <div className="fb-arch-time-foot">
            <span>步进微调</span>
            <div className="fb-arch-time-steps">
              <button
                type="button"
                className="fb-arch-step-btn"
                onClick={() => nudgeBoundaryOrSpine(-0.005, effectiveLinked)}
              >
                -5ms
              </button>
              <button
                type="button"
                className="fb-arch-step-btn"
                onClick={() => nudgeBoundaryOrSpine(-0.001, effectiveLinked)}
              >
                -1ms
              </button>
              <button
                type="button"
                className="fb-arch-step-btn"
                onClick={() => nudgeBoundaryOrSpine(0.001, effectiveLinked)}
              >
                +1ms
              </button>
              <button
                type="button"
                className="fb-arch-step-btn"
                onClick={() => nudgeBoundaryOrSpine(0.005, effectiveLinked)}
              >
                +5ms
              </button>
            </div>
          </div>
        </div>
      );

      const renderBoundaryAction = (id: string): React.ReactNode => {
        switch (id) {
          case 'bnd-zero':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn is-primary"
                disabled={!analysis}
                title={zHint ? `吸附最近音频过零点 (${zHint})` : '吸附最近音频过零点'}
                onClick={() => void snapBoundaryOrSpineZeroCrossing(effectiveLinked)}
              >
                <UiIcon name="zeroCross" size={13} />
                <span>{isCompact ? '过零' : '吸附过零'}</span>
              </button>
            );
          case 'bnd-link':
            return (
              <div key={id} className="fb-arch-seg" role="group" aria-label="边界移动联动方式">
                <button
                  type="button"
                  className={`fb-arch-seg-btn ${!effectiveLinked ? 'is-on' : ''}`}
                  disabled={isSpine && matchedTierIndices.length === 0}
                  title="仅调整当前层的边界"
                  onClick={() => {
                    if (isSpine) {
                      if (matchedTierIndices.length > 0) {
                        setSelection({
                          kind: 'boundary',
                          tierIndex: matchedTierIndices[0],
                          time: t,
                          bandIndex: selection.bandIndex
                        });
                        setBoundaryLinked(false);
                      }
                    } else {
                      setBoundaryLinked(false);
                    }
                  }}
                >
                  {isCompact ? '本层' : '仅本层'}
                </button>
                <button
                  type="button"
                  className={`fb-arch-seg-btn ${effectiveLinked ? 'is-on' : ''}`}
                  title="同时移动所有层上对齐此处的边界"
                  onClick={() => setBoundaryLinked(true)}
                >
                  {isCompact ? '联动' : '联动对齐层'}
                  {matchedTierIndices.length > 1 ? ` (${matchedTierIndices.length})` : ''}
                </button>
              </div>
            );
          case 'bnd-audition':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn"
                title="跨界试听前后各 200 ms"
                onClick={auditionCross}
              >
                <UiIcon name="playContext" size={13} />
                <span>{isCompact ? '试听' : '试听 ±200ms'}</span>
              </button>
            );
          case 'bnd-project':
            return (
              <div key={id} className="fb-arch-anchor">
                <button
                  type="button"
                  className={`fb-arch-btn ${openPop === 'project' ? 'is-open' : ''}`}
                  title="将此边界复制到其他区间层"
                  onClick={() => togglePop('project')}
                >
                  <UiIcon name="projectToTier" size={13} />
                  <span>{isCompact ? '复制层' : '复制到其他层'}</span>
                  <ChevronIcon size={10} />
                </button>
                <AnchoredPopover open={openPop === 'project'}>
                  <div className="fb-arch-pop-title">复制边界到其他层</div>
                  {otherIntervalTiers.length > 0 ? (
                    otherIntervalTiers.map(({ tier: tgtTier, idx }) => (
                      <button
                        key={idx}
                        type="button"
                        className="fb-arch-pop-item"
                        onClick={() => {
                          setOpenPop(null);
                          projectBoundaryToTier(idx, t);
                        }}
                      >
                        <span className="fb-arch-pop-lead">
                          <UiIcon name="projectToTier" size={13} />
                          <span>{formatTierLabel(tgtTier.name, idx)}</span>
                        </span>
                        <span className="fb-arch-pop-sub">第 {idx + 1} 层</span>
                      </button>
                    ))
                  ) : (
                    <div className="fb-arch-pop-title" style={{ fontWeight: 400 }}>
                      所有区间层均已存在此边界
                    </div>
                  )}
                  <div className="fb-arch-pop-div" />
                  <button
                    type="button"
                    className="fb-arch-pop-item"
                    onClick={() => {
                      setOpenPop(null);
                      const res = alignMicroBoundaries(undefined, 0.005);
                      const fb = formatAlignMicroFeedback(res);
                      showToast(fb.message, fb.isError);
                    }}
                  >
                    <span className="fb-arch-pop-lead">
                      <UiIcon name="nudgeShared" size={13} />
                      <span>对齐附近跨层微偏</span>
                    </span>
                    <span className="fb-arch-pop-sub">&lt;5ms</span>
                  </button>
                </AnchoredPopover>
              </div>
            );
          case 'bnd-delete':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn is-danger"
                title={
                  effectiveLinked
                    ? '删除所有对齐层上位于此处的边界'
                    : '删除当前层的此边界并合并左右区间'
                }
                onClick={() => {
                  setOpenPop(null);
                  if (effectiveLinked) {
                    deleteBoundaryAcrossAllTiers(t);
                  } else if (!isSpine) {
                    deleteBoundaryAt(selection.tierIndex, t);
                  }
                }}
              >
                <UiIcon name={effectiveLinked ? 'delBoundaryAll' : 'delBoundary'} size={13} />
                <span>{isCompact ? '删除' : effectiveLinked ? '删全部边界' : '删除边界'}</span>
              </button>
            );
          case 'bnd-copy-time':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn"
                title="复制边界时刻"
                onClick={() => {
                  setOpenPop(null);
                  onCopyText(formatPraatDouble(t), '边界时刻');
                }}
              >
                <UiIcon name="copyTime" size={13} />
                <span>{isCompact ? '时刻' : '复制时刻'}</span>
              </button>
            );
          default:
            return null;
        }
      };

      const renderBoundaryOverflowItem = (id: string): React.ReactNode => {
        switch (id) {
          case 'bnd-zero':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                disabled={!analysis}
                onClick={() => {
                  setOpenPop(null);
                  void snapBoundaryOrSpineZeroCrossing(effectiveLinked);
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="zeroCross" size={13} />
                  <span>吸附过零点</span>
                </span>
              </button>
            );
          case 'bnd-link':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                disabled={isSpine && matchedTierIndices.length === 0}
                onClick={() => {
                  setOpenPop(null);
                  if (effectiveLinked) {
                    if (isSpine && matchedTierIndices.length > 0) {
                      setSelection({
                        kind: 'boundary',
                        tierIndex: matchedTierIndices[0],
                        time: t,
                        bandIndex: selection.bandIndex
                      });
                    }
                    setBoundaryLinked(false);
                  } else {
                    setBoundaryLinked(true);
                  }
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="nudgeShared" size={13} />
                  <span>{effectiveLinked ? '切换为仅调整本层' : '切换为联动对齐层'}</span>
                </span>
              </button>
            );
          case 'bnd-audition':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                onClick={() => {
                  setOpenPop(null);
                  auditionCross();
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="playContext" size={13} />
                  <span>跨界试听 ±200ms</span>
                </span>
              </button>
            );
          case 'bnd-project':
            return (
              <React.Fragment key={id}>
                {otherIntervalTiers.length > 0 && (
                  <>
                    <div className="fb-arch-pop-title">复制到其他层</div>
                    {otherIntervalTiers.map(({ tier: tgtTier, idx }) => (
                      <button
                        key={idx}
                        type="button"
                        className="fb-arch-pop-item"
                        onClick={() => {
                          setOpenPop(null);
                          projectBoundaryToTier(idx, t);
                        }}
                      >
                        <span className="fb-arch-pop-lead">
                          <UiIcon name="projectToTier" size={13} />
                          <span>{formatTierLabel(tgtTier.name, idx)}</span>
                        </span>
                        <span className="fb-arch-pop-sub">第 {idx + 1} 层</span>
                      </button>
                    ))}
                  </>
                )}
                <button
                  type="button"
                  className="fb-arch-pop-item"
                  onClick={() => {
                    setOpenPop(null);
                    const res = alignMicroBoundaries(undefined, 0.005);
                    const fb = formatAlignMicroFeedback(res);
                    showToast(fb.message, fb.isError);
                  }}
                >
                  <span className="fb-arch-pop-lead">
                    <UiIcon name="nudgeShared" size={13} />
                    <span>对齐附近跨层微偏</span>
                  </span>
                  <span className="fb-arch-pop-sub">&lt;5ms</span>
                </button>
              </React.Fragment>
            );
          case 'bnd-copy-time':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                onClick={() => {
                  setOpenPop(null);
                  onCopyText(formatPraatDouble(t), '边界时刻');
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="copyTime" size={13} />
                  <span>复制时刻</span>
                </span>
              </button>
            );
          case 'bnd-delete':
            return null;
          default:
            return null;
        }
      };

      const bndOverflowItems = bndHidden.filter((id) => id !== 'bnd-delete');

      bodyContent = (
        <>
          {isNumeric && (
            <>
              <div className="fb-arch-inline-fields">
                <ScrubNumberInput
                  variant="floating"
                  label={isSpine ? '时刻' : '边界'}
                  value={t}
                  min={Number.isFinite(minAllowed) ? minAllowed : undefined}
                  strictMin={Number.isFinite(minAllowed)}
                  max={Number.isFinite(maxAllowed) ? maxAllowed : undefined}
                  strictMax={Number.isFinite(maxAllowed)}
                  formatValue={formatPraatDouble}
                  onScrubPreview={(previewT) =>
                    onShowScrubPreview(previewT, isSpine ? 0 : selection.tierIndex, effectiveLinked)
                  }
                  onScrubEnd={onClearScrubPreview}
                  onCommit={commitBoundaryTime}
                />
              </div>
              {bndVisible.length > 0 && <div className="fb-arch-sep" />}
            </>
          )}

          {bndVisible.map((id) => renderBoundaryAction(id))}
          {bndVisible.length > 0 && <div className="fb-arch-sep" />}

          <div className="fb-arch-anchor">
            <button
              type="button"
              className={`fb-arch-btn is-icon ${openPop === 'more' ? 'is-open' : ''}`}
              title="更多边界操作"
              onClick={() => togglePop('more')}
            >
              <MoreDotsIcon />
            </button>
            <AnchoredPopover open={openPop === 'more'} alignRight>
              <div className="fb-arch-pop-title">更多边界操作</div>
              {bndOverflowItems.length > 0 && (
                <>
                  {bndOverflowItems.map((id) => renderBoundaryOverflowItem(id))}
                  <div className="fb-arch-pop-div" />
                </>
              )}
              <button
                type="button"
                className="fb-arch-pop-item"
                onClick={() => {
                  setOpenPop(null);
                  const s = Math.max(tg.xmin, t - 0.25);
                  if (t > s) onStartPlayback(s, t);
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="play" size={13} />
                  <span>仅听边界前 250ms</span>
                </span>
              </button>
              <button
                type="button"
                className="fb-arch-pop-item"
                onClick={() => {
                  setOpenPop(null);
                  const en = Math.min(tg.xmax, t + 0.25);
                  if (en > t) onStartPlayback(t, en);
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="play" size={13} />
                  <span>仅听边界后 250ms</span>
                </span>
              </button>
              <div className="fb-arch-pop-div" />
              {!isSpine && (
                <button
                  type="button"
                  className="fb-arch-pop-item is-danger"
                  onClick={() => {
                    setOpenPop(null);
                    deleteBoundaryAt(selection.tierIndex, t);
                  }}
                >
                  <span className="fb-arch-pop-lead">
                    <UiIcon name="delBoundary" size={13} />
                    <span>删除本层边界</span>
                  </span>
                </button>
              )}
              <button
                type="button"
                className="fb-arch-pop-item is-danger"
                onClick={() => {
                  setOpenPop(null);
                  deleteBoundaryAcrossAllTiers(t);
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="delBoundaryAll" size={13} />
                  <span>删除全部对齐边界</span>
                </span>
              </button>
              <div className="fb-arch-pop-div" />
              <button type="button" className="fb-arch-pop-item" onClick={openInspectorSidebar}>
                <span className="fb-arch-pop-lead">
                  <UiIcon name="inspector" size={13} />
                  <span>在右侧属性栏打开</span>
                </span>
              </button>
            </AnchoredPopover>
          </div>
        </>
      );
    }

    // -------------------------------------------------------------------------
    // 4. POINT
    // -------------------------------------------------------------------------
    else if (selection.kind === 'point') {
      const ti = selection.tierIndex;
      const pi = selection.itemIndex;
      const tier = tg.tiers[ti];
      const pt = tier?.points[pi];
      if (!tier || !pt) return null;

      const tierName = formatTierLabel(tier.name, ti);
      kindLabel = '标点';
      ctxLabel = `${tierName} · ${truncateLabel(pt.mark, 14)}`;
      timeSummary = `${formatCompactSec(pt.number)} s`;

      const auditionPoint = () => {
        const s = Math.max(tg.xmin, pt.number - 0.25);
        const en = Math.min(tg.xmax, pt.number + 0.25);
        if (en > s) onStartPlayback(s, en);
      };

      const deletePoint = () => {
        const ptTime = pt.number;
        const ptMark = pt.mark;
        commitTgMutation(
          (_draft, ctx) => {
            const dTier = ctx.editTier(ti);
            if (!dTier || !dTier.points[pi]) return false;
            dTier.points.splice(pi, 1);
          },
          null,
          {
            type: 'delete-point',
            title: '删除标注点',
            detail: `${tierName} · ${formatTimeSec(ptTime)} ${formatQuote(ptMark)}`,
            icon: 'trash',
            tierName,
            focusTime: ptTime
          }
        );
      };

      const clearPointMark = () => {
        if (pt.mark === '') return;
        const oldMark = pt.mark;
        commitTgMutation(
          (_d, ctx) => {
            const dTier = ctx.editTier(ti);
            const target = dTier?.points[pi];
            if (!target || target.mark === '') return false;
            target.mark = '';
          },
          selection,
          {
            type: 'clear-point-text',
            title: '清空标点文字',
            detail: `${tierName} · 原${formatQuote(oldMark)}`,
            icon: 'clear',
            tierName,
            focusTime: pt.number
          }
        );
      };

      const commitPointTime = (val: number): boolean => {
        if (tier.points.some((p, i) => i !== pi && Math.abs(p.number - val) < 1e-9)) {
          showToast('目标时刻已存在标点', true);
          return false;
        }
        if (Math.abs(val - pt.number) <= 1e-12) return true;
        return movePointToTime(ti, pi, val, '移动标注点');
      };

      quickPlayHandler = auditionPoint;

      const { visibleIds: ptVisible, hiddenIds: ptHidden, hiddenSet: ptHiddenSet } =
        getOrderedPartition('point');

      timePopoverContent = (
        <div className="fb-arch-time-pop">
          <div className="fb-arch-time-head">
            <span>标点精确时刻</span>
            <span>{truncateLabel(pt.mark, 10)}</span>
          </div>
          <div className="fb-arch-time-grid is-single">
            <div className="fb-arch-time-col">
              <span className="fb-arch-time-col-lbl">时刻 (s)</span>
              <ScrubNumberInput
                variant="floating"
                value={pt.number}
                min={Number.isFinite(tier.xmin) ? tier.xmin : undefined}
                max={Number.isFinite(tier.xmax) ? tier.xmax : undefined}
                formatValue={formatPraatDouble}
                onScrubPreview={(previewT) => onShowScrubPreview(previewT, ti, false)}
                onScrubEnd={onClearScrubPreview}
                onCommit={commitPointTime}
              />
            </div>
          </div>
          <div className="fb-arch-time-foot">
            <span>步进微调</span>
            <div className="fb-arch-time-steps">
              <button
                type="button"
                className="fb-arch-step-btn"
                onClick={() => nudgePointTime(-0.005)}
              >
                -5ms
              </button>
              <button
                type="button"
                className="fb-arch-step-btn"
                onClick={() => nudgePointTime(-0.001)}
              >
                -1ms
              </button>
              <button
                type="button"
                className="fb-arch-step-btn"
                onClick={() => nudgePointTime(0.001)}
              >
                +1ms
              </button>
              <button
                type="button"
                className="fb-arch-step-btn"
                onClick={() => nudgePointTime(0.005)}
              >
                +5ms
              </button>
            </div>
          </div>
          <div className="fb-arch-time-foot">
            <span>快速吸附</span>
            <div className="fb-arch-time-steps">
              <button
                type="button"
                className="fb-arch-step-btn"
                disabled={!analysis}
                onClick={() => void snapPointZeroCrossing()}
              >
                过零点
              </button>
              <button
                type="button"
                className="fb-arch-step-btn"
                onClick={movePointToIntervalMid}
              >
                区间中点
              </button>
            </div>
          </div>
        </div>
      );

      const renderPointAction = (id: string): React.ReactNode => {
        switch (id) {
          case 'pt-edit':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn is-primary"
                title="编辑标点文字"
                onClick={() => {
                  setOpenPop(null);
                  onOpenInline(selection);
                }}
              >
                <UiIcon name="edit" size={13} />
                <span>改字</span>
              </button>
            );
          case 'pt-align':
            return (
              <div key={id} className="fb-arch-anchor">
                <button
                  type="button"
                  className={`fb-arch-btn ${openPop === 'align' ? 'is-open' : ''}`}
                  title="吸附到过零点、附近边界或区间中点"
                  onClick={() => togglePop('align')}
                >
                  <UiIcon name="zeroCross" size={13} />
                  <span>{isCompact ? '吸附' : '对齐吸附'}</span>
                  <ChevronIcon size={10} />
                </button>
                <AnchoredPopover open={openPop === 'align'}>
                  <div className="fb-arch-pop-title">标点对齐与吸附</div>
                  <button
                    type="button"
                    className="fb-arch-pop-item is-rec"
                    disabled={!analysis}
                    onClick={() => {
                      setOpenPop(null);
                      void snapPointZeroCrossing();
                    }}
                  >
                    <span className="fb-arch-pop-lead">
                      <UiIcon name="zeroCross" size={13} />
                      <span>吸附波形过零点</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="fb-arch-pop-item"
                    onClick={() => {
                      setOpenPop(null);
                      snapPointNearestBoundary();
                    }}
                  >
                    <span className="fb-arch-pop-lead">
                      <UiIcon name="nudgeShared" size={13} />
                      <span>吸附附近区间边界</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="fb-arch-pop-item"
                    onClick={() => {
                      setOpenPop(null);
                      movePointToIntervalMid();
                    }}
                  >
                    <span className="fb-arch-pop-lead">
                      <UiIcon name="split" size={13} />
                      <span>移到所在区间中点</span>
                    </span>
                  </button>
                </AnchoredPopover>
              </div>
            );
          case 'pt-play-ctx':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn"
                title="标点前后试听 ±250ms"
                onClick={auditionPoint}
              >
                <UiIcon name="playContext" size={13} />
                <span>{isCompact ? '试听' : '试听 ±250ms'}</span>
              </button>
            );
          case 'pt-nudge':
            return (
              <React.Fragment key={id}>
                <button
                  type="button"
                  className="fb-arch-btn is-icon"
                  title="左移 5 ms"
                  onClick={() => nudgePointTime(-0.005)}
                >
                  <NudgeLeftIcon />
                </button>
                <button
                  type="button"
                  className="fb-arch-btn is-icon"
                  title="右移 5 ms"
                  onClick={() => nudgePointTime(0.005)}
                >
                  <NudgeRightIcon />
                </button>
              </React.Fragment>
            );
          case 'pt-delete':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn is-danger"
                title="删除当前标点"
                onClick={() => {
                  setOpenPop(null);
                  deletePoint();
                }}
              >
                <UiIcon name="trash" size={13} />
                <span>删除</span>
              </button>
            );
          case 'pt-snap-boundary':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn"
                title="吸附至附近区间边界"
                onClick={() => {
                  setOpenPop(null);
                  snapPointNearestBoundary();
                }}
              >
                <UiIcon name="nudgeShared" size={13} />
                <span>{isCompact ? '对界' : '对齐边界'}</span>
              </button>
            );
          case 'pt-move-mid':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn"
                title="移到所在区间中点"
                onClick={() => {
                  setOpenPop(null);
                  movePointToIntervalMid();
                }}
              >
                <UiIcon name="split" size={13} />
                <span>{isCompact ? '中点' : '区间中点'}</span>
              </button>
            );
          case 'pt-play':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn"
                title="从此处向后播放"
                onClick={() => {
                  setOpenPop(null);
                  setPlayRange(null);
                  onStartPlayback(pt.number, tg.xmax);
                }}
              >
                <UiIcon name="play" size={13} />
                <span>{isCompact ? '播放' : '向后播放'}</span>
              </button>
            );
          default:
            return null;
        }
      };

      const renderPointOverflowItem = (id: string): React.ReactNode => {
        switch (id) {
          case 'pt-edit':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                onClick={() => {
                  setOpenPop(null);
                  onOpenInline(selection);
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="edit" size={13} />
                  <span>改字</span>
                </span>
              </button>
            );
          case 'pt-align':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                disabled={!analysis}
                onClick={() => {
                  setOpenPop(null);
                  void snapPointZeroCrossing();
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="zeroCross" size={13} />
                  <span>吸附波形过零点</span>
                </span>
              </button>
            );
          case 'pt-snap-boundary':
            if (!ptHiddenSet.has('pt-align')) return null;
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                onClick={() => {
                  setOpenPop(null);
                  snapPointNearestBoundary();
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="nudgeShared" size={13} />
                  <span>吸附附近区间边界</span>
                </span>
              </button>
            );
          case 'pt-move-mid':
            if (!ptHiddenSet.has('pt-align')) return null;
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                onClick={() => {
                  setOpenPop(null);
                  movePointToIntervalMid();
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="split" size={13} />
                  <span>移到所在区间中点</span>
                </span>
              </button>
            );
          case 'pt-play-ctx':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                onClick={() => {
                  setOpenPop(null);
                  auditionPoint();
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="playContext" size={13} />
                  <span>前后试听 ±250ms</span>
                </span>
              </button>
            );
          case 'pt-nudge':
            return (
              <React.Fragment key={id}>
                <button
                  type="button"
                  className="fb-arch-pop-item"
                  onClick={() => nudgePointTime(-0.005)}
                >
                  <span className="fb-arch-pop-lead">
                    <NudgeLeftIcon />
                    <span>左移 5 ms</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="fb-arch-pop-item"
                  onClick={() => nudgePointTime(0.005)}
                >
                  <span className="fb-arch-pop-lead">
                    <NudgeRightIcon />
                    <span>右移 5 ms</span>
                  </span>
                </button>
              </React.Fragment>
            );
          case 'pt-play':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                onClick={() => {
                  setOpenPop(null);
                  setPlayRange(null);
                  onStartPlayback(pt.number, tg.xmax);
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="play" size={13} />
                  <span>从此处向后播放</span>
                </span>
              </button>
            );
          case 'pt-delete':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item is-danger"
                onClick={() => {
                  setOpenPop(null);
                  deletePoint();
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="trash" size={13} />
                  <span>删除标点</span>
                </span>
              </button>
            );
          default:
            return null;
        }
      };

      const ptOverflowNodes = ptHidden
        .map((id) => renderPointOverflowItem(id))
        .filter((node) => node !== null);

      bodyContent = (
        <>
          {isNumeric && (
            <>
              <div className="fb-arch-inline-fields">
                <ScrubNumberInput
                  variant="floating"
                  label="时刻"
                  value={pt.number}
                  min={Number.isFinite(tier.xmin) ? tier.xmin : undefined}
                  max={Number.isFinite(tier.xmax) ? tier.xmax : undefined}
                  formatValue={formatPraatDouble}
                  onScrubPreview={(previewT) => onShowScrubPreview(previewT, ti, false)}
                  onScrubEnd={onClearScrubPreview}
                  onCommit={commitPointTime}
                />
              </div>
              {ptVisible.length > 0 && <div className="fb-arch-sep" />}
            </>
          )}

          {ptVisible.map((id) => renderPointAction(id))}
          {ptVisible.length > 0 && <div className="fb-arch-sep" />}

          <div className="fb-arch-anchor">
            <button
              type="button"
              className={`fb-arch-btn is-icon ${openPop === 'more' ? 'is-open' : ''}`}
              title="更多标点操作"
              onClick={() => togglePop('more')}
            >
              <MoreDotsIcon />
            </button>
            <AnchoredPopover open={openPop === 'more'} alignRight>
              <div className="fb-arch-pop-title">更多标点操作</div>
              {ptOverflowNodes.length > 0 && (
                <>
                  {ptOverflowNodes}
                  <div className="fb-arch-pop-div" />
                </>
              )}
              <button
                type="button"
                className="fb-arch-pop-item"
                onClick={() => {
                  setOpenPop(null);
                  onCopyText(formatPraatDouble(pt.number), '标点时刻');
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="copyTime" size={13} />
                  <span>复制时刻</span>
                </span>
              </button>
              <button
                type="button"
                className="fb-arch-pop-item"
                disabled={pt.mark === ''}
                onClick={() => {
                  setOpenPop(null);
                  onCopyText(pt.mark, '标点文本');
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="copy" size={13} />
                  <span>复制文本</span>
                </span>
              </button>
              <div className="fb-arch-pop-div" />
              <button
                type="button"
                className="fb-arch-pop-item"
                disabled={pt.mark === ''}
                onClick={() => {
                  setOpenPop(null);
                  void convertSelectionIpa('to-unicode');
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="convertUnicode" size={13} />
                  <span>转为 Unicode 音标</span>
                </span>
              </button>
              <button
                type="button"
                className="fb-arch-pop-item"
                disabled={pt.mark === ''}
                onClick={() => {
                  setOpenPop(null);
                  void convertSelectionIpa('to-praat');
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="convertPraat" size={13} />
                  <span>转为 Praat 转义码</span>
                </span>
              </button>
              <div className="fb-arch-pop-div" />
              <button
                type="button"
                className="fb-arch-pop-item is-danger"
                disabled={pt.mark === ''}
                onClick={() => {
                  setOpenPop(null);
                  clearPointMark();
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="clear" size={13} />
                  <span>清空标点文字</span>
                </span>
              </button>
              <button type="button" className="fb-arch-pop-item" onClick={openInspectorSidebar}>
                <span className="fb-arch-pop-lead">
                  <UiIcon name="inspector" size={13} />
                  <span>在右侧属性栏打开</span>
                </span>
              </button>
            </AnchoredPopover>
          </div>
        </>
      );
    }

    // -------------------------------------------------------------------------
    // 5. TIER
    // -------------------------------------------------------------------------
    else if (selection.kind === 'tier') {
      const ti = selection.tierIndex;
      const tier = tg.tiers[ti];
      if (!tier) return null;

      const tierName = formatTierLabel(tier.name, ti);
      const isIntervalTier = tier.kind === 'intervalTier';
      const itemCount = isIntervalTier ? tier.intervals.length : tier.points.length;
      const isHidden = hiddenTierIndices.includes(ti);
      const isSoloed =
        tg.tiers.length > 1 &&
        !isHidden &&
        tg.tiers.every((_, idx) => idx === ti || hiddenTierIndices.includes(idx));

      kindLabel = '层级';
      ctxLabel = `${tierName} · ${isIntervalTier ? `区间层 (${itemCount} 段)` : `标点层 (${itemCount} 点)`}`;
      timeSummary = `${formatCompactSec(tier.xmin)}–${formatCompactSec(tier.xmax)}s`;

      quickPlayHandler = () => {
        if (tier.xmax > tier.xmin) {
          onStartPlayback(tier.xmin, tier.xmax);
        }
      };

      const commitTierName = (nextName: string) => {
        if (nextName === tier.name) return;
        const prevName = tier.name;
        commitTgMutation(
          (_d, ctx) => {
            const dTier = ctx.editTier(ti);
            if (!dTier || dTier.name === nextName) return false;
            dTier.name = nextName;
          },
          undefined,
          {
            type: 'rename-tier',
            title: '重命名层级',
            detail: `${formatQuote(prevName)}→${formatQuote(nextName)}`,
            icon: 'edit',
            tierName: formatTierLabel(nextName, ti)
          }
        );
      };

      const commitTierBound = (which: 'min' | 'max', val: number): boolean => {
        if (which === 'min') {
          if (!Number.isFinite(val) || val >= tier.xmax) {
            showToast('起点必须严格小于终点', true);
            return false;
          }
          if (val === tier.xmin) return true;
          const oldV = tier.xmin;
          commitTgMutation(
            (_d, ctx) => {
              const dTier = ctx.editTier(ti);
              if (!dTier || dTier.xmin === val) return false;
              dTier.xmin = val;
            },
            undefined,
            {
              type: 'edit-tier-bounds',
              title: '修改层起点',
              detail: `${formatQuote(tierName)} · ${formatTimeSec(oldV)} → ${formatTimeSec(val)}`,
              icon: 'copyTime',
              tierName,
              focusTime: val
            }
          );
          return true;
        }
        if (!Number.isFinite(val) || val <= tier.xmin) {
          showToast('终点必须严格大于起点', true);
          return false;
        }
        if (val === tier.xmax) return true;
        const oldV = tier.xmax;
        commitTgMutation(
          (_d, ctx) => {
            const dTier = ctx.editTier(ti);
            if (!dTier || dTier.xmax === val) return false;
            dTier.xmax = val;
          },
          undefined,
          {
            type: 'edit-tier-bounds',
            title: '修改层终点',
            detail: `${formatQuote(tierName)} · ${formatTimeSec(oldV)} → ${formatTimeSec(val)}`,
            icon: 'copyTime',
            tierName,
            focusTime: val
          }
        );
        return true;
      };

      const { visibleIds: tierVisible, hiddenIds: tierHidden, hiddenSet: tierHiddenSet } =
        getOrderedPartition('tier');

      timePopoverContent = (
        <div className="fb-arch-time-pop">
          <div className="fb-arch-time-head">
            <span>层级时间范围</span>
            <span>第 {ti + 1} 层</span>
          </div>
          <div className="fb-arch-time-grid">
            <div className="fb-arch-time-col">
              <span className="fb-arch-time-col-lbl">层起点 (s)</span>
              <ScrubNumberInput
                variant="floating"
                value={tier.xmin}
                max={tier.xmax}
                strictMax
                formatValue={formatPraatDouble}
                onCommit={(val) => commitTierBound('min', val)}
              />
            </div>
            <div className="fb-arch-time-col">
              <span className="fb-arch-time-col-lbl">层终点 (s)</span>
              <ScrubNumberInput
                variant="floating"
                value={tier.xmax}
                min={tier.xmin}
                strictMin
                formatValue={formatPraatDouble}
                onCommit={(val) => commitTierBound('max', val)}
              />
            </div>
          </div>
        </div>
      );

      const renderTierAction = (id: string): React.ReactNode => {
        switch (id) {
          case 'tier-name':
            if (isNumeric) {
              return (
                <label key={id} className="fb-arch-inline-text">
                  <span>层名</span>
                  <input
                    type="text"
                    defaultValue={tier.name}
                    key={`fb-tn-${ti}-${tier.name}`}
                    onKeyDown={blurOnEnter}
                    onBlur={(e) => commitTierName(e.target.value)}
                  />
                </label>
              );
            }
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn is-primary"
                title="原地编辑层名称"
                onClick={() => {
                  setOpenPop(null);
                  onOpenInline({ kind: 'tier-name', tierIndex: ti });
                }}
              >
                <UiIcon name="edit" size={13} />
                <span>{isCompact ? '改名' : '层名快编'}</span>
              </button>
            );
          case 'tier-visibility':
            return (
              <button
                key={id}
                type="button"
                className={`fb-arch-btn ${isHidden ? 'is-active-toggle' : ''}`}
                title={isHidden ? '在谱面中显示此层' : '在谱面中暂时隐藏此层'}
                onClick={() => toggleTierVisibility(ti)}
              >
                <UiIcon name={isHidden ? 'showTier' : 'hideTier'} size={13} />
                <span>{isHidden ? '显示' : '隐藏'}</span>
              </button>
            );
          case 'tier-solo':
            return (
              <button
                key={id}
                type="button"
                className={`fb-arch-btn ${isSoloed ? 'is-active-toggle' : ''}`}
                disabled={tg.tiers.length <= 1}
                title={isSoloed ? '恢复显示全部层级' : '仅显示当前层级'}
                onClick={() => (isSoloed ? showAllTiers() : soloTier(ti))}
              >
                <UiIcon name="layers" size={13} />
                <span>{isSoloed ? (isCompact ? '全部' : '显示全部') : isCompact ? '仅看' : '仅看此层'}</span>
              </button>
            );
          case 'tier-duplicate':
            return (
              <div key={id} className="fb-arch-anchor">
                <button
                  type="button"
                  className={`fb-arch-btn ${openPop === 'duplicate' ? 'is-open' : ''}`}
                  title="复制整层或仅复制边界"
                  onClick={() => togglePop('duplicate')}
                >
                  <UiIcon name="duplicateTier" size={13} />
                  <span>{isCompact ? '复制' : '复制层'}</span>
                  <ChevronIcon size={10} />
                </button>
                <AnchoredPopover open={openPop === 'duplicate'}>
                  <div className="fb-arch-pop-title">复制当前层级</div>
                  <button
                    type="button"
                    className="fb-arch-pop-item is-rec"
                    onClick={() => {
                      setOpenPop(null);
                      duplicateTier(ti, { copyText: true });
                    }}
                  >
                    <span className="fb-arch-pop-lead">
                      <UiIcon name="duplicateTier" size={13} />
                      <span>复制整层（含文本）</span>
                    </span>
                  </button>
                  {isIntervalTier && (
                    <button
                      type="button"
                      className="fb-arch-pop-item"
                      onClick={() => {
                        setOpenPop(null);
                        duplicateTier(ti, { copyText: false });
                      }}
                    >
                      <span className="fb-arch-pop-lead">
                        <UiIcon name="addIntervalTier" size={13} />
                        <span>仅复制边界（空白层）</span>
                      </span>
                    </button>
                  )}
                </AnchoredPopover>
              </div>
            );
          case 'tier-move':
            return (
              <React.Fragment key={id}>
                <button
                  type="button"
                  className="fb-arch-btn is-icon"
                  disabled={ti === 0}
                  title="上移一层"
                  onClick={() => moveTier(ti, -1)}
                >
                  <UiIcon name="up" size={13} />
                </button>
                <button
                  type="button"
                  className="fb-arch-btn is-icon"
                  disabled={ti >= tg.tiers.length - 1}
                  title="下移一层"
                  onClick={() => moveTier(ti, 1)}
                >
                  <UiIcon name="down" size={13} />
                </button>
              </React.Fragment>
            );
          case 'tier-clear':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn is-danger"
                title="清空整层文本"
                onClick={() => {
                  setOpenPop(null);
                  clearTierText(ti);
                }}
              >
                <UiIcon name="clear" size={13} />
                <span>{isCompact ? '清空' : '清空文本'}</span>
              </button>
            );
          case 'tier-delete':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-btn is-danger"
                title="删除当前层级"
                onClick={() => {
                  setOpenPop(null);
                  removeTierWithUndoToast(ti);
                }}
              >
                <UiIcon name="trash" size={13} />
                <span>{isCompact ? '删除' : '删除层级'}</span>
              </button>
            );
          default:
            return null;
        }
      };

      const renderTierOverflowItem = (id: string): React.ReactNode => {
        switch (id) {
          case 'tier-name':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                onClick={() => {
                  setOpenPop(null);
                  onOpenInline({ kind: 'tier-name', tierIndex: ti });
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="edit" size={13} />
                  <span>重命名层级</span>
                </span>
              </button>
            );
          case 'tier-visibility':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                onClick={() => {
                  setOpenPop(null);
                  toggleTierVisibility(ti);
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name={isHidden ? 'showTier' : 'hideTier'} size={13} />
                  <span>{isHidden ? '显示此层' : '隐藏此层'}</span>
                </span>
              </button>
            );
          case 'tier-solo':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item"
                disabled={tg.tiers.length <= 1}
                onClick={() => {
                  setOpenPop(null);
                  if (isSoloed) showAllTiers();
                  else soloTier(ti);
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="layers" size={13} />
                  <span>{isSoloed ? '恢复显示全部层' : '仅看此层'}</span>
                </span>
              </button>
            );
          case 'tier-duplicate':
            return (
              <React.Fragment key={id}>
                <button
                  type="button"
                  className="fb-arch-pop-item"
                  onClick={() => {
                    setOpenPop(null);
                    duplicateTier(ti, { copyText: true });
                  }}
                >
                  <span className="fb-arch-pop-lead">
                    <UiIcon name="duplicateTier" size={13} />
                    <span>复制整层（含文本）</span>
                  </span>
                </button>
                {isIntervalTier && (
                  <button
                    type="button"
                    className="fb-arch-pop-item"
                    onClick={() => {
                      setOpenPop(null);
                      duplicateTier(ti, { copyText: false });
                    }}
                  >
                    <span className="fb-arch-pop-lead">
                      <UiIcon name="addIntervalTier" size={13} />
                      <span>仅复制边界（空白层）</span>
                    </span>
                  </button>
                )}
              </React.Fragment>
            );
          case 'tier-move':
            return (
              <React.Fragment key={id}>
                <button
                  type="button"
                  className="fb-arch-pop-item"
                  disabled={ti === 0}
                  onClick={() => {
                    setOpenPop(null);
                    moveTier(ti, -1);
                  }}
                >
                  <span className="fb-arch-pop-lead">
                    <UiIcon name="up" size={13} />
                    <span>上移一层</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="fb-arch-pop-item"
                  disabled={ti >= tg.tiers.length - 1}
                  onClick={() => {
                    setOpenPop(null);
                    moveTier(ti, 1);
                  }}
                >
                  <span className="fb-arch-pop-lead">
                    <UiIcon name="down" size={13} />
                    <span>下移一层</span>
                  </span>
                </button>
              </React.Fragment>
            );
          case 'tier-clear':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item is-danger"
                onClick={() => {
                  setOpenPop(null);
                  clearTierText(ti);
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="clear" size={13} />
                  <span>清空整层文本</span>
                </span>
              </button>
            );
          case 'tier-delete':
            return (
              <button
                key={id}
                type="button"
                className="fb-arch-pop-item is-danger"
                onClick={() => {
                  setOpenPop(null);
                  removeTierWithUndoToast(ti);
                }}
              >
                <span className="fb-arch-pop-lead">
                  <UiIcon name="trash" size={13} />
                  <span>删除此层级</span>
                </span>
              </button>
            );
          default:
            return null;
        }
      };

      bodyContent = (
        <>
          {isNumeric && tierHiddenSet.has('tier-name') && (
            <>
              <label className="fb-arch-inline-text">
                <span>层名</span>
                <input
                  type="text"
                  defaultValue={tier.name}
                  key={`fb-tn-hd-${ti}-${tier.name}`}
                  onKeyDown={blurOnEnter}
                  onBlur={(e) => commitTierName(e.target.value)}
                />
              </label>
              {tierVisible.length > 0 && <div className="fb-arch-sep" />}
            </>
          )}

          {tierVisible.map((id) => renderTierAction(id))}
          {tierVisible.length > 0 && <div className="fb-arch-sep" />}

          <div className="fb-arch-anchor">
            <button
              type="button"
              className={`fb-arch-btn is-icon ${openPop === 'more' ? 'is-open' : ''}`}
              title="更多层级操作"
              onClick={() => togglePop('more')}
            >
              <MoreDotsIcon />
            </button>
            <AnchoredPopover open={openPop === 'more'} alignRight>
              <div className="fb-arch-pop-title">更多层级操作</div>
              {tierHidden.length > 0 && (
                <>
                  {tierHidden.map((id) => renderTierOverflowItem(id))}
                  <div className="fb-arch-pop-div" />
                </>
              )}
              <button type="button" className="fb-arch-pop-item" onClick={openInspectorSidebar}>
                <span className="fb-arch-pop-lead">
                  <UiIcon name="inspector" size={13} />
                  <span>在右侧属性栏打开</span>
                </span>
              </button>
            </AnchoredPopover>
          </div>
        </>
      );
    } else {
      return null;
    }

    return (
      <div
        ref={setCombinedRef}
        className={`fb-arch-host ${visible ? 'visible' : ''} ${isDragging ? 'is-dragging' : ''}`}
        style={{ left: position.left, top: position.top }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {collapsed ? (
          <div className={`fb-arch-mini fb-obj-${objClass}`}>
            <span
              className="fb-arch-drag"
              title="按住拖移工具栏位置"
              onPointerDown={(e) => {
                setOpenPop(null);
                onDragHandlePointerDown(e);
              }}
            >
              <DragGripIcon />
            </span>
            <span className="fb-arch-kind">{kindLabel}</span>
            <span className="fb-arch-mini-time">{timeSummary}</span>
            {quickPlayHandler && (
              <button
                type="button"
                className="fb-arch-util-btn"
                title="快速播放"
                onClick={quickPlayHandler}
              >
                <UiIcon name="play" size={11} />
              </button>
            )}
            <button
              type="button"
              className="fb-arch-util-btn"
              title="展开浮动工具栏"
              onClick={() => setCollapsed(false)}
            >
              <ExpandIcon />
              <span>展开</span>
            </button>
          </div>
        ) : (
          <div className={`fb-arch fb-obj-${objClass} ${isCompact ? 'is-compact' : ''}`}>
            <div className="fb-arch-head">
              <div className="fb-arch-head-left">
                <span
                  className="fb-arch-drag"
                  title="按住拖移工具栏位置（切换选中对象自动重置）"
                  onPointerDown={(e) => {
                    setOpenPop(null);
                    onDragHandlePointerDown(e);
                  }}
                >
                  <DragGripIcon />
                </span>
                <span className="fb-arch-kind">{kindLabel}</span>
                <span className="fb-arch-ctx" title={ctxLabel}>
                  {ctxLabel}
                </span>
                <div className="fb-arch-anchor">
                  <button
                    type="button"
                    className={`fb-arch-time-trigger ${openPop === 'time' ? 'is-open' : ''}`}
                    title="点击展开精确时间输入与微调"
                    aria-expanded={openPop === 'time'}
                    onClick={() => togglePop('time')}
                  >
                    <span>{timeSummary}</span>
                    <ChevronIcon size={9} />
                  </button>
                  <AnchoredPopover open={openPop === 'time'}>{timePopoverContent}</AnchoredPopover>
                </div>
              </div>
              <div className="fb-arch-head-right">
                <button
                  type="button"
                  className="fb-arch-util-btn"
                  title="打开右侧属性栏"
                  onClick={openInspectorSidebar}
                >
                  <UiIcon name="inspector" size={11} />
                </button>
                <button
                  type="button"
                  className="fb-arch-util-btn"
                  title="折叠为极窄迷你条"
                  onClick={() => {
                    setOpenPop(null);
                    setCollapsed(true);
                  }}
                >
                  <CollapseIcon />
                </button>
              </div>
            </div>
            <div className="fb-arch-body">{bodyContent}</div>
          </div>
        )}
      </div>
    );
  }
);

FloatingActionBar.displayName = 'FloatingActionBar';
