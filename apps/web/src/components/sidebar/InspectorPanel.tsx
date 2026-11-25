import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';
import { getPlatformBridge } from '../../bridge/PlatformBridge';
import type {
  AudioAnalysisSummary,
  TextGrid,
  TextGridFormat,
  TierDiagnostics
} from '../../bridge/types';
import {
  decodeTrigraphGlossSync,
  formatPraatDouble,
  primeTrigraphString
} from '../../layout/richText';
import type { EditorSelection } from '../../render/renderScoreSvg';
import {
  formatKeyCombo,
  isComposingEvent,
  matchesShortcut
} from '../../shortcuts/registry';
import { useEditorStore } from '../../store/useEditorStore';
import { UiIcon } from '../Icons';
import { IpaImePopover, IpaModePill } from '../IpaImePopover';
import { ScrubNumberInput } from '../ScrubNumberInput';
import { isIpaRelatedElement, useIpaIme } from '../useIpaIme';
import { CollapsibleSection } from './CollapsibleSection';

export interface InspectorPanelHandle {
  insertIpaSymbol: (sym: string, isTieBar?: boolean) => boolean;
  flushDraft: () => void;
}

interface InspectorPanelProps {
  onStartPlayback: (startT: number, endT: number) => void;
}

interface AcousticStats {
  f0Mean: number | null;
  f0Min: number | null;
  f0Max: number | null;
  voicedCount: number;
  f1: number | null;
  f2: number | null;
  f3: number | null;
}

function round6(t: number): number {
  return Number(t.toFixed(6));
}

function formatDurationBadge(durSec: number): string {
  const safe = Math.max(0, durSec);
  if (safe < 1) return `${Math.round(safe * 1000)} ms`;
  return `${safe.toFixed(3)} s`;
}

function formatFormatLabel(fmt: TextGridFormat): string {
  switch (fmt) {
    case 'shortText':
      return '短文本 (.TextGrid)';
    case 'binary':
      return '二进制 (.TextGrid)';
    case 'chronological':
      return '按时间排序文本';
    default:
      return '标准文本 (.TextGrid)';
  }
}

function computeAcousticStats(
  analysis: AudioAnalysisSummary | null,
  tMin: number,
  tMax: number
): AcousticStats | null {
  if (!analysis || !Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax <= tMin) {
    return null;
  }

  let f0Sum = 0;
  let f0Min = Infinity;
  let f0Max = -Infinity;
  let voicedCount = 0;

  for (const p of analysis.pitchTrack) {
    if (p.t < tMin || p.t > tMax) continue;
    if (p.f0 !== null && Number.isFinite(p.f0) && p.f0 > 0) {
      f0Sum += p.f0;
      if (p.f0 < f0Min) f0Min = p.f0;
      if (p.f0 > f0Max) f0Max = p.f0;
      voicedCount++;
    }
  }

  const midT = (tMin + tMax) * 0.5;
  let bestFrame: { t: number; freqs: number[] } | null = null;
  let bestDist = Infinity;
  for (const frame of analysis.formantTrack) {
    if (frame.t < tMin || frame.t > tMax || !frame.freqs.length) continue;
    const d = Math.abs(frame.t - midT);
    if (d < bestDist) {
      bestDist = d;
      bestFrame = frame;
    }
  }

  const readF = (idx: number): number | null => {
    const v = bestFrame?.freqs[idx];
    return v !== undefined && Number.isFinite(v) && v > 0 ? v : null;
  };

  return {
    f0Mean: voicedCount > 0 ? f0Sum / voicedCount : null,
    f0Min: voicedCount > 0 ? f0Min : null,
    f0Max: voicedCount > 0 ? f0Max : null,
    voicedCount,
    f1: readF(0),
    f2: readF(1),
    f3: readF(2)
  };
}

function formatHz(v: number | null, digits = 0): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)} Hz`;
}

type QaIssueKind = 'gap' | 'overlap' | 'zero' | 'micro' | 'space';

interface QaIssue {
  id: string;
  kind: QaIssueKind;
  badge: string;
  tierIndex: number;
  tierName: string;
  time: number;
  detail: string;
  targetSelection: EditorSelection;
  fixableKind?: 'micro-cross' | 'space-interval' | 'space-point';
  itemIndex?: number;
}

const QA_ISSUE_CAP = 120;
const QA_EPS = 1e-9;
const QA_MICRO_THRESHOLD = 0.005;

function scanQaIssues(tg: TextGrid): {
  issues: QaIssue[];
  totalFound: number;
  crossMicroCount: number;
} {
  const issues: QaIssue[] = [];
  let totalFound = 0;
  let crossMicroCount = 0;

  const pushIssue = (issue: QaIssue) => {
    totalFound++;
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

    if (tier.kind === 'intervalTier') {
      const ivs = tier.intervals;
      if (ivs.length === 0) {
        if (tier.xmax > tier.xmin + QA_EPS) {
          pushIssue({
            id: `gap-empty-${ti}`,
            kind: 'gap',
            badge: '空隙',
            tierIndex: ti,
            tierName,
            time: tier.xmin,
            detail: `${tierName} · 无区间覆盖`,
            targetSelection: { kind: 'tier', tierIndex: ti }
          });
        }
        continue;
      }

      if (ivs[0].xmin > tier.xmin + QA_EPS) {
        const ms = (ivs[0].xmin - tier.xmin) * 1000;
        pushIssue({
          id: `gap-lead-${ti}`,
          kind: 'gap',
          badge: '空隙',
          tierIndex: ti,
          tierName,
          time: tier.xmin,
          detail: `${tierName} · 首段前空隙 (${ms.toFixed(1)} ms)`,
          targetSelection: { kind: 'interval', tierIndex: ti, itemIndex: 0 }
        });
      }

      const seenInterior = new Set<number>();
      for (let ii = 0; ii < ivs.length; ii++) {
        const iv = ivs[ii];
        const dur = iv.xmax - iv.xmin;

        if (dur <= QA_EPS) {
          pushIssue({
            id: `zero-${ti}-${ii}`,
            kind: 'zero',
            badge: '零长',
            tierIndex: ti,
            tierName,
            time: iv.xmin,
            detail: `${tierName} · #${ii + 1} 零时长区间`,
            targetSelection: { kind: 'interval', tierIndex: ti, itemIndex: ii }
          });
        } else if (dur < QA_MICRO_THRESHOLD) {
          pushIssue({
            id: `micro-iv-${ti}-${ii}`,
            kind: 'micro',
            badge: '微偏',
            tierIndex: ti,
            tierName,
            time: iv.xmin,
            detail: `${tierName} · #${ii + 1} 极短段 (${(dur * 1000).toFixed(1)} ms)`,
            targetSelection: { kind: 'interval', tierIndex: ti, itemIndex: ii }
          });
        }

        if (ii > 0) {
          const prev = ivs[ii - 1];
          if (iv.xmin > prev.xmax + QA_EPS) {
            const ms = (iv.xmin - prev.xmax) * 1000;
            pushIssue({
              id: `gap-${ti}-${ii}`,
              kind: 'gap',
              badge: '空隙',
              tierIndex: ti,
              tierName,
              time: prev.xmax,
              detail: `${tierName} · #${ii}–#${ii + 1} 空隙 (${ms.toFixed(1)} ms)`,
              targetSelection: { kind: 'interval', tierIndex: ti, itemIndex: ii }
            });
          } else if (iv.xmin < prev.xmax - QA_EPS) {
            const ms = (prev.xmax - iv.xmin) * 1000;
            pushIssue({
              id: `overlap-${ti}-${ii}`,
              kind: 'overlap',
              badge: '重叠',
              tierIndex: ti,
              tierName,
              time: iv.xmin,
              detail: `${tierName} · #${ii}–#${ii + 1} 重叠 (${ms.toFixed(1)} ms)`,
              targetSelection: { kind: 'interval', tierIndex: ti, itemIndex: ii }
            });
          }
        }

        if (iv.text.length > 0 && iv.text !== iv.text.trim()) {
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
      if (last.xmax < tier.xmax - QA_EPS) {
        const ms = (tier.xmax - last.xmax) * 1000;
        pushIssue({
          id: `gap-trail-${ti}`,
          kind: 'gap',
          badge: '空隙',
          tierIndex: ti,
          tierName,
          time: last.xmax,
          detail: `${tierName} · 末段后空隙 (${ms.toFixed(1)} ms)`,
          targetSelection: { kind: 'interval', tierIndex: ti, itemIndex: ivs.length - 1 }
        });
      }
    } else {
      for (let pi = 0; pi < tier.points.length; pi++) {
        const pt = tier.points[pi];
        if (pt.mark.length > 0 && pt.mark !== pt.mark.trim()) {
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

      // Scan backward within < 5ms
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
      // Scan forward within < 5ms
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
        crossMicroCount++;
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

  return { issues, totalFound, crossMicroCount };
}

function isSameQaTarget(a: EditorSelection, b: EditorSelection): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'interval' && b.kind === 'interval') {
    return a.tierIndex === b.tierIndex && a.itemIndex === b.itemIndex;
  }
  if (a.kind === 'point' && b.kind === 'point') {
    return a.tierIndex === b.tierIndex && a.itemIndex === b.itemIndex;
  }
  if (a.kind === 'boundary' && b.kind === 'boundary') {
    return a.tierIndex === b.tierIndex && Math.abs(a.time - b.time) < 1e-9;
  }
  if (a.kind === 'tier' && b.kind === 'tier') {
    return a.tierIndex === b.tierIndex;
  }
  if (a.kind === 'spine' && b.kind === 'spine') {
    return Math.abs(a.time - b.time) < 1e-9;
  }
  return false;
}

export const InspectorPanel = forwardRef<InspectorPanelHandle, InspectorPanelProps>(
  ({ onStartPlayback }, ref) => {
    const tg = useEditorStore((s) => s.tg);
    const mode = useEditorStore((s) => s.mode);
    const setMode = useEditorStore((s) => s.setMode);
    const isReadOnly = mode === 'read';
    const docVersion = useEditorStore((s) => s.docVersion);
    const filename = useEditorStore((s) => s.filename);
    const currentFileFormat = useEditorStore((s) => s.currentFileFormat);
    const sidebarOpen = useEditorStore((s) => s.sidebarOpen);
    const sidebarTab = useEditorStore((s) => s.sidebarTab);
    const selection = useEditorStore((s) => s.selection);
    const setSelection = useEditorStore((s) => s.setSelection);
    const playRange = useEditorStore((s) => s.playRange);
    const setPlayRange = useEditorStore((s) => s.setPlayRange);
    const setPlaybackTime = useEditorStore((s) => s.setPlaybackTime);
    const viewDomain = useEditorStore((s) => s.viewDomain);
    const setViewDomain = useEditorStore((s) => s.setViewDomain);
    const setLoop = useEditorStore((s) => s.setLoop);
    const audioName = useEditorStore((s) => s.audioName);
    const audioDuration = useEditorStore((s) => s.audioDuration);
    const audioSampleRate = useEditorStore((s) => s.audioSampleRate);
    const analysis = useEditorStore((s) => s.analysis);
    const commitTgMutation = useEditorStore((s) => s.commitTgMutation);
    const splitInterval = useEditorStore((s) => s.splitInterval);
    const mergeIntervalWith = useEditorStore((s) => s.mergeIntervalWith);
    const deleteBoundaryAt = useEditorStore((s) => s.deleteBoundaryAt);
    const insertTierAt = useEditorStore((s) => s.insertTierAt);
    const duplicateTier = useEditorStore((s) => s.duplicateTier);
    const moveTier = useEditorStore((s) => s.moveTier);
    const removeTierWithUndoToast = useEditorStore((s) => s.removeTierWithUndoToast);
    const clearTierText = useEditorStore((s) => s.clearTierText);
    const alignMicroBoundaries = useEditorStore((s) => s.alignMicroBoundaries);
    const hiddenTierIndices = useEditorStore((s) => s.hiddenTierIndices);
    const toggleTierVisibility = useEditorStore((s) => s.toggleTierVisibility);
    const normalizeTextGrid = useEditorStore((s) => s.normalizeTextGrid);
    const moveTierBoundary = useEditorStore((s) => s.moveTierBoundary);
    const moveSharedTimestamp = useEditorStore((s) => s.moveSharedTimestamp);
    const openExportModal = useEditorStore((s) => s.openExportModal);
    const showToast = useEditorStore((s) => s.showToast);
    const customShortcuts = useEditorStore((s) => s.customShortcuts);

    const onStartPlaybackRef = useRef(onStartPlayback);
    onStartPlaybackRef.current = onStartPlayback;

    // Skip blur commit right after pressing Escape in tier name text field
    const skipNextBlurRef = useRef(false);

    // Local editing drafts + race-free target tracking
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [textDraft, setTextDraft] = useState('');
    const draftTargetRef = useRef<
      { kind: 'interval' | 'point'; tierIndex: number; itemIndex: number } | null
    >(null);
    const draftValueRef = useRef('');
    const draftDirtyRef = useRef(false);
    const [trigraphPreview, setTrigraphPreview] = useState<string | null>(null);
    const [linkAdjacent, setLinkAdjacent] = useState(true);
    const [boundaryShared, setBoundaryShared] = useState(false);

    // Tier name input draft
    const [tierNameInput, setTierNameInput] = useState('');

    // Diagnostics for document overview
    const [diagnostics, setDiagnostics] = useState<TierDiagnostics[]>([]);

    // Resolve active target objects safely
    const activeInterval =
      selection?.kind === 'interval'
        ? tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex] ?? null
        : null;
    const activePoint =
      selection?.kind === 'point'
        ? tg.tiers[selection.tierIndex]?.points[selection.itemIndex] ?? null
        : null;
    const activeTier =
      selection &&
      (selection.kind === 'tier' ||
        selection.kind === 'interval' ||
        selection.kind === 'point' ||
        selection.kind === 'boundary')
        ? tg.tiers[selection.tierIndex] ?? null
        : null;

    // Commit interval or point text draft to its exact owning target (race-free on rapid selection switch)
    const commitDraftTarget = useCallback(
      (
        tgt: { kind: 'interval' | 'point'; tierIndex: number; itemIndex: number } | null,
        valueToCommit: string
      ) => {
        if (!tgt) return;
        const st = useEditorStore.getState();
        if (st.mode === 'read') return;
        const bridge = getPlatformBridge();
        if (tgt.kind === 'interval') {
          const cur = st.tg.tiers[tgt.tierIndex]?.intervals[tgt.itemIndex];
          if (cur && cur.text !== valueToCommit) {
            void primeTrigraphString(valueToCommit, bridge).then(() => st.bumpDocVersion());
            st.commitTgMutation(
              (draft) => {
                const target = draft.tiers[tgt.tierIndex]?.intervals[tgt.itemIndex];
                if (target) target.text = valueToCommit;
              },
              undefined,
              '编辑区间文本'
            );
          }
        } else if (tgt.kind === 'point') {
          const cur = st.tg.tiers[tgt.tierIndex]?.points[tgt.itemIndex];
          if (cur && cur.mark !== valueToCommit) {
            void primeTrigraphString(valueToCommit, bridge).then(() => st.bumpDocVersion());
            st.commitTgMutation(
              (draft) => {
                const target = draft.tiers[tgt.tierIndex]?.points[tgt.itemIndex];
                if (target) target.mark = valueToCommit;
              },
              undefined,
              '编辑标点文本'
            );
          }
        }
      },
      []
    );

    const handleDraftValueChange = useCallback((v: string) => {
      if (useEditorStore.getState().mode === 'read') return;
      setTextDraft(v);
      draftValueRef.current = v;
      draftDirtyRef.current = true;
    }, []);

    const flushPendingRef = useRef<() => void>(() => {});
    const resetDraftRef = useRef<() => void>(() => {});

    const handleInspectorUnhandledKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (isComposingEvent(e)) return;

        // Audition right inside Inspector textarea via custom/default shortcuts (only modifier or F-key combos so normal typing is never hijacked)
        const isInputSafeTrigger =
          e.ctrlKey || e.metaKey || e.altKey || /^F([1-9]|1[0-9]|2[0-4])$/.test(e.key);
        const isReplayContext =
          isInputSafeTrigger && matchesShortcut('replay-context', e, customShortcuts);
        const isReplayExact =
          !isReplayContext &&
          isInputSafeTrigger &&
          matchesShortcut('replay-selection', e, customShortcuts);
        if (isReplayExact || isReplayContext) {
          e.preventDefault();
          e.stopPropagation();
          const st = useEditorStore.getState();
          const sel = st.selection;
          const withContext = isReplayContext;
          if (sel?.kind === 'interval') {
            const iv = st.tg.tiers[sel.tierIndex]?.intervals[sel.itemIndex];
            if (iv && iv.xmax > iv.xmin) {
              const pad = withContext ? 0.25 : 0;
              const start = Math.max(st.tg.xmin, iv.xmin - pad);
              const end = Math.min(st.tg.xmax, iv.xmax + pad);
              if (!withContext) {
                st.setPlayRange({ start: iv.xmin, end: iv.xmax });
              }
              onStartPlaybackRef.current(start, end);
            }
          } else if (sel?.kind === 'point') {
            const pt = st.tg.tiers[sel.tierIndex]?.points[sel.itemIndex];
            if (pt) {
              if (withContext) {
                const start = Math.max(st.tg.xmin, pt.number - 0.25);
                const end = Math.min(st.tg.xmax, pt.number + 0.25);
                onStartPlaybackRef.current(start, end);
              } else {
                onStartPlaybackRef.current(pt.number, st.tg.xmax);
              }
            }
          }
          return;
        }

        // Tab / Shift+Tab: commit current text and advance to next/prev interval or point while keeping focus
        if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          flushPendingRef.current();
          const st = useEditorStore.getState();
          const sel = st.selection;
          const delta = e.shiftKey ? -1 : 1;
          if (sel?.kind === 'interval') {
            const tier = st.tg.tiers[sel.tierIndex];
            if (tier && tier.kind === 'intervalTier') {
              const nextIdx = sel.itemIndex + delta;
              if (nextIdx >= 0 && nextIdx < tier.intervals.length) {
                const nextIv = tier.intervals[nextIdx];
                st.setSelection({ kind: 'interval', tierIndex: sel.tierIndex, itemIndex: nextIdx });
                if (nextIv && nextIv.xmax > nextIv.xmin) {
                  st.setPlayRange({ start: nextIv.xmin, end: nextIv.xmax });
                  st.setPlaybackTime(nextIv.xmin, true);
                }
              }
            }
          } else if (sel?.kind === 'point') {
            const tier = st.tg.tiers[sel.tierIndex];
            if (tier && tier.kind === 'textTier') {
              const nextIdx = sel.itemIndex + delta;
              if (nextIdx >= 0 && nextIdx < tier.points.length) {
                const nextPt = tier.points[nextIdx];
                st.setSelection({ kind: 'point', tierIndex: sel.tierIndex, itemIndex: nextIdx });
                if (nextPt) {
                  st.setPlaybackTime(nextPt.number, true);
                }
              }
            }
          }
          requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.select();
          });
          return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          flushPendingRef.current();
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          resetDraftRef.current();
          (e.target as HTMLTextAreaElement).blur();
        }
      },
      [customShortcuts]
    );

    const ipaIme = useIpaIme({
      textareaRef,
      value: textDraft,
      onChangeValue: handleDraftValueChange,
      active: Boolean(
        !isReadOnly &&
          sidebarOpen &&
          sidebarTab === 'inspector' &&
          (selection?.kind === 'interval' || selection?.kind === 'point')
      ),
      onUnhandledKeyDown: handleInspectorUnhandledKeyDown
    });

    const flushPendingTextDraft = useCallback(() => {
      const resolved = ipaIme.resolvePendingValue();
      if (resolved !== draftValueRef.current) {
        draftValueRef.current = resolved;
        draftDirtyRef.current = true;
        setTextDraft(resolved);
      }
      ipaIme.clearComposing();
      if (draftDirtyRef.current && draftTargetRef.current) {
        const tgt = draftTargetRef.current;
        const val = draftValueRef.current;
        draftDirtyRef.current = false;
        commitDraftTarget(tgt, val);
      }
    }, [commitDraftTarget, ipaIme]);
    flushPendingRef.current = flushPendingTextDraft;

    resetDraftRef.current = () => {
      ipaIme.clearComposing();
      const orig =
        selection?.kind === 'interval'
          ? activeInterval?.text ?? ''
          : selection?.kind === 'point'
            ? activePoint?.mark ?? ''
            : '';
      draftDirtyRef.current = false;
      draftValueRef.current = orig;
      setTextDraft(orig);
    };

    // Flush any uncommitted text edit when sidebar collapses or switches away from Inspector
    useEffect(() => {
      if (!sidebarOpen || sidebarTab !== 'inspector') {
        flushPendingRef.current();
      }
    }, [sidebarOpen, sidebarTab]);

    // Clear any transient IME state & ensure displayed drafts match committed data on entering read-only mode
    useEffect(() => {
      if (isReadOnly) {
        ipaIme.clearComposing();
        draftDirtyRef.current = false;
        if (selection?.kind === 'interval' && activeInterval) {
          setTextDraft(activeInterval.text);
          draftValueRef.current = activeInterval.text;
        } else if (selection?.kind === 'point' && activePoint) {
          setTextDraft(activePoint.mark);
          draftValueRef.current = activePoint.mark;
        } else if (selection?.kind === 'tier' && activeTier) {
          setTierNameInput(activeTier.name);
        }
      }
    }, [isReadOnly, ipaIme, selection, activeInterval, activePoint, activeTier]);

    // Flush any uncommitted text edit if the Inspector unmounts
    useEffect(() => {
      return () => {
        flushPendingRef.current();
      };
    }, []);

    // Sync local drafts when selection or document data changes
    useEffect(() => {
      const nextTarget =
        selection?.kind === 'interval'
          ? { kind: 'interval' as const, tierIndex: selection.tierIndex, itemIndex: selection.itemIndex }
          : selection?.kind === 'point'
            ? { kind: 'point' as const, tierIndex: selection.tierIndex, itemIndex: selection.itemIndex }
            : null;

      const prevTarget = draftTargetRef.current;
      const targetChanged =
        prevTarget?.kind !== nextTarget?.kind ||
        prevTarget?.tierIndex !== nextTarget?.tierIndex ||
        prevTarget?.itemIndex !== nextTarget?.itemIndex;

      if (targetChanged && draftDirtyRef.current && prevTarget) {
        const valToCommit = draftValueRef.current;
        draftDirtyRef.current = false;
        commitDraftTarget(prevTarget, valToCommit);
      }
      if (targetChanged) {
        ipaIme.clearComposing();
      }

      draftTargetRef.current = nextTarget;

      if (selection?.kind === 'interval' && activeInterval) {
        setTextDraft(activeInterval.text);
        draftValueRef.current = activeInterval.text;
        draftDirtyRef.current = false;
      } else if (selection?.kind === 'point' && activePoint) {
        setTextDraft(activePoint.mark);
        draftValueRef.current = activePoint.mark;
        draftDirtyRef.current = false;
      } else if (selection?.kind === 'tier' && activeTier) {
        setTierNameInput(activeTier.name);
      }
    }, [
      selection,
      activeInterval?.text,
      activePoint?.mark,
      activeTier?.name,
      commitDraftTarget
    ]);

    // Live Praat \xx trigraph preview for interval / point text drafts
    useEffect(() => {
      if (selection?.kind !== 'interval' && selection?.kind !== 'point') {
        setTrigraphPreview(null);
        return;
      }
      if (!textDraft.includes('\\')) {
        setTrigraphPreview(null);
        return;
      }
      const syncCached = decodeTrigraphGlossSync(textDraft);
      if (syncCached) setTrigraphPreview(syncCached);
      let cancelled = false;
      void getPlatformBridge()
        .decodePraatTrigraphs(textDraft)
        .then((res) => {
          if (!cancelled) setTrigraphPreview(res.changed ? res.text : null);
        })
        .catch(() => {
          if (!cancelled) setTrigraphPreview(null);
        });
      return () => {
        cancelled = true;
      };
    }, [selection?.kind, textDraft]);

    // Document structural diagnostics (always active for collapsible QA section)
    useEffect(() => {
      let cancelled = false;
      void getPlatformBridge()
        .scanDiagnostics(tg)
        .then((res) => {
          if (!cancelled) setDiagnostics(res);
        })
        .catch(() => {
          if (!cancelled) setDiagnostics([]);
        });
      return () => {
        cancelled = true;
      };
    }, [tg, docVersion]);

    // Lightweight navigable QA issues list (capped at 120 items)
    const qaScan = useMemo(() => scanQaIssues(tg), [tg]);

    // Allow IpaDock to insert symbols directly into the focused Inspector textarea
    useImperativeHandle(
      ref,
      () => ({
        insertIpaSymbol: (sym: string, isTieBar = false) => {
          if (useEditorStore.getState().mode === 'read') return false;
          const el = textareaRef.current;
          if (!el || document.activeElement !== el || el.readOnly) return false;
          ipaIme.clearComposing();
          return ipaIme.insertAtCaret(sym, isTieBar);
        },
        flushDraft: () => {
          if (useEditorStore.getState().mode === 'read') return;
          flushPendingRef.current();
        }
      }),
      [ipaIme]
    );

    // Acoustic stats for active interval or playRange
    const intervalAcoustic = useMemo(() => {
      if (selection?.kind !== 'interval' || !activeInterval) return null;
      return computeAcousticStats(analysis, activeInterval.xmin, activeInterval.xmax);
    }, [selection?.kind, activeInterval?.xmin, activeInterval?.xmax, analysis]);

    const rangeAcoustic = useMemo(() => {
      if (selection !== null || !playRange) return null;
      return computeAcousticStats(analysis, playRange.start, playRange.end);
    }, [selection, playRange?.start, playRange?.end, analysis]);

    const copyAcousticTsv = (
      stats: AcousticStats,
      tMin: number,
      tMax: number,
      label?: string
    ) => {
      const durSec = Math.max(0, tMax - tMin);
      const showMidFormants = durSec <= 0.30;
      const durMs = (durSec * 1000).toFixed(1);
      const cols = [
        ...(label !== undefined ? [label.replace(/[\t\r\n]+/g, ' ')] : []),
        formatPraatDouble(tMin),
        formatPraatDouble(tMax),
        durMs,
        stats.f0Mean !== null ? stats.f0Mean.toFixed(1) : '',
        stats.f0Min !== null ? stats.f0Min.toFixed(1) : '',
        stats.f0Max !== null ? stats.f0Max.toFixed(1) : '',
        showMidFormants && stats.f1 !== null ? stats.f1.toFixed(0) : '',
        showMidFormants && stats.f2 !== null ? stats.f2.toFixed(0) : '',
        showMidFormants && stats.f3 !== null ? stats.f3.toFixed(0) : ''
      ];
      void navigator.clipboard
        .writeText(cols.join('\t'))
        .then(() => showToast('已复制声学数据（制表符分隔）'))
        .catch(() => showToast('剪贴板写入受限', true));
    };

    // Interval start / end mutations
    const updateIntervalBound = (which: 'start' | 'end', targetVal: number): boolean => {
      if (isReadOnly) return false;
      if (selection?.kind !== 'interval' || !activeInterval) return false;
      const tier = tg.tiers[selection.tierIndex];
      if (!tier || tier.kind !== 'intervalTier') return false;
      const ii = selection.itemIndex;
      const val = round6(targetVal);
      if (!Number.isFinite(val)) return false;

      if (which === 'start') {
        if (val >= activeInterval.xmax) {
          showToast('起始时间必须小于结束时间', true);
          return false;
        }
        const prev = tier.intervals[ii - 1];
        const linked = Boolean(linkAdjacent && prev && Math.abs(prev.xmax - activeInterval.xmin) < 1e-9);
        if (linked && val <= prev.xmin) {
          showToast('起始时间不能越过前一个区间起点', true);
          return false;
        }
        if (val === activeInterval.xmin) return false;
        commitTgMutation(
          (draft) => {
            const dTier = draft.tiers[selection.tierIndex];
            const cur = dTier.intervals[ii];
            const dPrev = dTier.intervals[ii - 1];
            if (linkAdjacent && dPrev && Math.abs(dPrev.xmax - cur.xmin) < 1e-9 && val > dPrev.xmin) {
              dPrev.xmax = val;
            }
            cur.xmin = val;
          },
          undefined,
          '修改区间起点'
        );
        if (playRange && Math.abs(playRange.start - activeInterval.xmin) < 1e-6 && Math.abs(playRange.end - activeInterval.xmax) < 1e-6) {
          setPlayRange({ start: val, end: activeInterval.xmax });
        }
        return true;
      } else {
        if (val <= activeInterval.xmin) {
          showToast('结束时间必须大于起始时间', true);
          return false;
        }
        const next = tier.intervals[ii + 1];
        const linked = Boolean(linkAdjacent && next && Math.abs(next.xmin - activeInterval.xmax) < 1e-9);
        if (linked && val >= next.xmax) {
          showToast('结束时间不能越过下一个区间终点', true);
          return false;
        }
        if (val === activeInterval.xmax) return false;
        commitTgMutation(
          (draft) => {
            const dTier = draft.tiers[selection.tierIndex];
            const cur = dTier.intervals[ii];
            const dNext = dTier.intervals[ii + 1];
            if (linkAdjacent && dNext && Math.abs(dNext.xmin - cur.xmax) < 1e-9 && val < dNext.xmax) {
              dNext.xmin = val;
            }
            cur.xmax = val;
          },
          undefined,
          '修改区间终点'
        );
        if (playRange && Math.abs(playRange.start - activeInterval.xmin) < 1e-6 && Math.abs(playRange.end - activeInterval.xmax) < 1e-6) {
          setPlayRange({ start: activeInterval.xmin, end: val });
        }
        return true;
      }
    };

    // Point timestamp mutation
    const updatePointTime = (targetVal: number): boolean => {
      if (isReadOnly) return false;
      if (selection?.kind !== 'point' || !activePoint || !activeTier) return false;
      const val = round6(Math.max(activeTier.xmin, Math.min(activeTier.xmax, targetVal)));
      if (!Number.isFinite(val) || val === activePoint.number) {
        return false;
      }
      if (activeTier.points.some((p, i) => i !== selection.itemIndex && p.number === val)) {
        showToast('目标时刻已存在标点', true);
        return false;
      }
      let nextIdx = selection.itemIndex;
      commitTgMutation(
        (draft) => {
          const dTier = draft.tiers[selection.tierIndex];
          const pt = dTier.points[selection.itemIndex];
          if (!pt) return;
          pt.number = val;
          dTier.points.sort((a, b) => a.number - b.number);
          nextIdx = dTier.points.indexOf(pt);
        },
        undefined,
        '调整标点时刻'
      );
      setSelection({ kind: 'point', tierIndex: selection.tierIndex, itemIndex: Math.max(0, nextIdx) });
      return true;
    };

    // Boundary or spine timestamp mutation
    const updateBoundaryOrSpineTime = (targetVal: number): boolean => {
      if (isReadOnly) return false;
      if (!selection || (selection.kind !== 'boundary' && selection.kind !== 'spine')) return false;
      const val = round6(targetVal);
      if (!Number.isFinite(val) || Math.abs(val - selection.time) < 1e-9) {
        return false;
      }
      if (selection.kind === 'boundary') {
        if (moveTierBoundary(selection.tierIndex, selection.time, val, boundaryShared)) {
          setSelection({ kind: 'boundary', tierIndex: selection.tierIndex, time: val, bandIndex: selection.bandIndex });
          return true;
        }
        return false;
      } else {
        if (moveSharedTimestamp(selection.time, val)) {
          setSelection({ kind: 'spine', time: val, bandIndex: selection.bandIndex });
          return true;
        }
        return false;
      }
    };

    const handleSnapZeroCrossing = async () => {
      if (isReadOnly) return;
      if (!analysis || !selection || (selection.kind !== 'boundary' && selection.kind !== 'spine')) return;
      try {
        const snapped = round6(
          await getPlatformBridge().findZeroCrossing(analysis.sessionId, selection.time, 0.015)
        );
        if (Math.abs(snapped - selection.time) < 1e-7) {
          showToast('当前位置已位于最近过零点');
          return;
        }
        updateBoundaryOrSpineTime(snapped);
        showToast(`已吸附至最近过零点 (${snapped.toFixed(6)} s)`);
      } catch (err) {
        showToast(`过零点吸附失败：${String(err)}`, true);
      }
    };

    const renderAcousticBlock = (
      stats: AcousticStats | null,
      tMin: number,
      tMax: number,
      label?: string
    ) => {
      if (!analysis || !stats) return null;
      const durSec = Math.max(0, tMax - tMin);
      const showMidFormants = durSec <= 0.30;
      const hasMidFormants = stats.f1 !== null || stats.f2 !== null || stats.f3 !== null;
      return (
        <div className="sb-stack">
          <div className="sb-metric-grid">
            <div className="sb-metric-cell">
              <span className="sb-metric-lbl">平均基频 F₀</span>
              <span className="sb-metric-val">{formatHz(stats.f0Mean, 1)}</span>
            </div>
            <div className="sb-metric-cell">
              <span className="sb-metric-lbl">基频范围</span>
              <span className="sb-metric-val">
                {stats.f0Min !== null && stats.f0Max !== null
                  ? `${stats.f0Min.toFixed(0)}–${stats.f0Max.toFixed(0)} Hz`
                  : '—'}
              </span>
            </div>
          </div>
          {showMidFormants && hasMidFormants && (
            <div className="sb-metric-grid sb-metric-grid-3">
              <div className="sb-metric-cell">
                <span className="sb-metric-lbl">中点 F₁</span>
                <span className="sb-metric-val">{formatHz(stats.f1, 0)}</span>
              </div>
              <div className="sb-metric-cell">
                <span className="sb-metric-lbl">中点 F₂</span>
                <span className="sb-metric-val">{formatHz(stats.f2, 0)}</span>
              </div>
              <div className="sb-metric-cell">
                <span className="sb-metric-lbl">中点 F₃</span>
                <span className="sb-metric-val">{formatHz(stats.f3, 0)}</span>
              </div>
            </div>
          )}
          <button
            type="button"
            className="compact sb-full-btn"
            title={
              showMidFormants
                ? '复制起止时间、时长、基频与共振峰读数（制表符分隔）'
                : '复制起止时间、时长与基频读数（制表符分隔，>300 ms 句段略去中点共振峰）'
            }
            onClick={() => copyAcousticTsv(stats, tMin, tMax, label)}
          >
            <UiIcon name="copy" size={13} />
            <span>复制声学数据</span>
          </button>
          <div className="sb-hint">
            {!showMidFormants
              ? '快速预览参考值（>300 ms 句段略去中点共振峰），正式论文数据请以 Praat 测量为准。'
              : '快速预览参考值，正式论文数据请以 Praat 测量为准。'}
          </div>
        </div>
      );
    };

    const readOnlyBanner = isReadOnly ? (
      <div className="sb-readonly-banner" role="status">
        <span className="sb-readonly-text">当前为只读模式</span>
        <button
          type="button"
          className="compact sb-readonly-btn"
          onClick={() => setMode('edit')}
        >
          切换至编辑
        </button>
      </div>
    ) : null;

    const handleNavigateQaIssue = (issue: QaIssue) => {
      if (hiddenTierIndices.includes(issue.tierIndex)) {
        toggleTierVisibility(issue.tierIndex);
      }
      if (viewDomain && (issue.time < viewDomain.min || issue.time > viewDomain.max)) {
        setViewDomain(null);
      }
      setSelection(issue.targetSelection);
      setPlaybackTime(issue.time, true);
    };

    const handleTrimQaSpace = (issue: QaIssue) => {
      if (isReadOnly || issue.itemIndex === undefined) return;
      const ti = issue.tierIndex;
      const idx = issue.itemIndex;
      if (issue.fixableKind === 'space-interval') {
        commitTgMutation(
          (draft) => {
            const target = draft.tiers[ti]?.intervals[idx];
            if (target) target.text = target.text.trim();
          },
          undefined,
          '清理区间首尾空格'
        );
        showToast('已清理该区间首尾空格');
      } else if (issue.fixableKind === 'space-point') {
        commitTgMutation(
          (draft) => {
            const target = draft.tiers[ti]?.points[idx];
            if (target) target.mark = target.mark.trim();
          },
          undefined,
          '清理标点首尾空格'
        );
        showToast('已清理该标点首尾空格');
      }
    };

    const gapTotal = diagnostics.reduce((acc, d) => acc + d.gapCount, 0);
    const overlapTotal = diagnostics.reduce((acc, d) => acc + d.overlapCount, 0);
    const zeroTotal = diagnostics.reduce((acc, d) => acc + d.zeroDurationCount, 0);
    const microTotal = diagnostics.reduce((acc, d) => acc + (d.microSegmentCount || 0), 0);
    const oodTotal = diagnostics.reduce((acc, d) => acc + (d.outOfDomain ? 1 : 0), 0);
    const structAnomalyTotal = gapTotal + overlapTotal + zeroTotal + oodTotal;
    const qaTotalCount = Math.max(qaScan.totalFound, structAnomalyTotal + microTotal);
    const hasQaIssues = qaTotalCount > 0;

    const qaSectionId =
      selection === null ? 'insp-doc-qa' : hasQaIssues ? 'insp-qa-issues' : 'insp-qa-clean';

    const qaDiagnosticsSection = (
      <CollapsibleSection
        key={qaSectionId}
        id={qaSectionId}
        title="数据体检"
        badge={
          <span className={hasQaIssues ? 'sb-badge-warn' : 'sb-badge-ok'}>
            {hasQaIssues ? `${qaTotalCount} 项异常` : '无异常'}
          </span>
        }
        defaultOpen={selection === null || hasQaIssues}
      >
        <div className="sb-stack">
          {(selection === null || structAnomalyTotal + microTotal > 0) && (
            <div className="sb-kv-list">
              <div className="sb-kv-row">
                <span className="sb-kv-key">区间缝隙</span>
                <span className={`sb-kv-val mono ${gapTotal > 0 ? 'is-warn' : ''}`}>{gapTotal}</span>
              </div>
              <div className="sb-kv-row">
                <span className="sb-kv-key">区间重叠</span>
                <span className={`sb-kv-val mono ${overlapTotal > 0 ? 'is-warn' : ''}`}>
                  {overlapTotal}
                </span>
              </div>
              <div className="sb-kv-row">
                <span className="sb-kv-key">零时长区间</span>
                <span className={`sb-kv-val mono ${zeroTotal > 0 ? 'is-warn' : ''}`}>
                  {zeroTotal}
                </span>
              </div>
              <div className="sb-kv-row">
                <span className="sb-kv-key">极短段 (&lt; 5 ms)</span>
                <span className={`sb-kv-val mono ${microTotal > 0 ? 'is-warn' : ''}`}>
                  {microTotal}
                </span>
              </div>
              <div className="sb-kv-row">
                <span className="sb-kv-key">越界层级</span>
                <span className={`sb-kv-val mono ${oodTotal > 0 ? 'is-warn' : ''}`}>
                  {oodTotal} 层
                </span>
              </div>
            </div>
          )}

          {qaScan.issues.length > 0 ? (
            <>
              <div className="qa-issue-list" role="list" aria-label="数据体检异常列表">
                {qaScan.issues.map((issue) => {
                  const isActive = isSameQaTarget(selection, issue.targetSelection);
                  return (
                    <div
                      key={issue.id}
                      role="listitem"
                      tabIndex={0}
                      className={`qa-issue-item ${isActive ? 'active' : ''}`}
                      title={`${issue.detail} (${issue.time.toFixed(4)} s) — 点击定位`}
                      onClick={() => handleNavigateQaIssue(issue)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleNavigateQaIssue(issue);
                        }
                      }}
                    >
                      <div className="qa-issue-main">
                        <span className={`qa-issue-badge ${issue.kind}`}>{issue.badge}</span>
                        <span className="qa-issue-text">{issue.detail}</span>
                      </div>
                      <span className="qa-issue-time">{issue.time.toFixed(3)}s</span>
                      {!isReadOnly && issue.fixableKind === 'micro-cross' && (
                        <button
                          type="button"
                          className="qa-issue-fix-btn"
                          title={`对齐「${issue.tierName}」跨层微偏边界 (< 5 ms)`}
                          onClick={(e) => {
                            e.stopPropagation();
                            const n = alignMicroBoundaries(issue.tierIndex);
                            showToast(
                              n > 0
                                ? `已对齐「${issue.tierName}」${n} 处微偏边界`
                                : '未发现可安全对齐的微偏边界'
                            );
                          }}
                        >
                          对齐
                        </button>
                      )}
                      {!isReadOnly &&
                        (issue.fixableKind === 'space-interval' ||
                          issue.fixableKind === 'space-point') &&
                        issue.itemIndex !== undefined && (
                          <button
                            type="button"
                            className="qa-issue-fix-btn"
                            title="清理首尾多余空格"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleTrimQaSpace(issue);
                            }}
                          >
                            修
                          </button>
                        )}
                    </div>
                  );
                })}
              </div>
              {qaScan.totalFound > qaScan.issues.length && (
                <div className="sb-hint">
                  已显示前 {qaScan.issues.length} 项（共检出 {qaScan.totalFound} 项异常）。
                </div>
              )}
            </>
          ) : !hasQaIssues ? (
            <div className="sb-status-ok">
              <UiIcon name="check" size={13} />
              <span>各层起止对齐且区间连续，未发现结构、微偏或空格异常。</span>
            </div>
          ) : null}

          <div className="sb-action-grid">
            <button
              type="button"
              className="compact"
              disabled={isReadOnly}
              title={
                isReadOnly
                  ? '请先切换至编辑模式'
                  : '将跨层间距小于 5 ms 的微偏边界对齐至上层参考时刻'
              }
              onClick={() => {
                if (isReadOnly) return;
                const aligned = alignMicroBoundaries();
                if (aligned > 0) {
                  showToast(`已对齐 ${aligned} 处跨层微偏边界 (< 5 ms)`);
                } else {
                  showToast('未发现可安全对齐的跨层微偏边界');
                }
              }}
            >
              <UiIcon name="zeroCross" size={13} />
              <span>对齐微偏边界</span>
            </button>
            <button
              type="button"
              className={`compact ${structAnomalyTotal > 0 ? 'primary' : ''}`}
              disabled={isReadOnly}
              title={isReadOnly ? '请先切换至编辑模式' : '统一各层起止范围并补齐连续区间'}
              onClick={() => {
                if (!isReadOnly) normalizeTextGrid();
              }}
            >
              <UiIcon name="normalize" size={13} />
              <span>一键整理边界</span>
            </button>
          </div>
        </div>
      </CollapsibleSection>
    );

    // 1. INTERVAL SELECTED
    if (selection?.kind === 'interval' && activeInterval && activeTier) {
      const ti = selection.tierIndex;
      const ii = selection.itemIndex;
      const durSec = Math.max(0, activeInterval.xmax - activeInterval.xmin);
      const durMs = durSec * 1000;
      const isZoomedHere = Boolean(
        viewDomain &&
          Math.abs(viewDomain.min - activeInterval.xmin) < 1e-4 &&
          Math.abs(viewDomain.max - activeInterval.xmax) < 1e-4
      );

      const prevIv = activeTier.intervals[ii - 1];
      const nextIv = activeTier.intervals[ii + 1];
      const prevLinked = Boolean(
        linkAdjacent && prevIv && Math.abs(prevIv.xmax - activeInterval.xmin) < 1e-9
      );
      const nextLinked = Boolean(
        linkAdjacent && nextIv && Math.abs(nextIv.xmin - activeInterval.xmax) < 1e-9
      );
      const startMin = prevLinked && prevIv ? prevIv.xmin : undefined;
      const endMax = nextLinked && nextIv ? nextIv.xmax : undefined;

      return (
        <div className="sb-panel-root">
          <div className="sb-context-strip">
            <span className="sb-context-tag">
              第 {ti + 1} 层 · 第 {ii + 1} 段
            </span>
            <span className="sb-context-name" title={activeTier.name || '未命名层'}>
              {activeTier.name || '未命名层'}
            </span>
          </div>
          {readOnlyBanner}

          <CollapsibleSection id="insp-iv-text" title="文本与音标" defaultOpen={true}>
            <div className="sb-stack">
              <div className={`sb-ipa-field-wrap ${!isReadOnly && ipaIme.ipaMode !== 'off' ? 'has-pill' : ''}`}>
                {!isReadOnly && <IpaModePill ime={ipaIme} className="is-sidebar-docked" />}
                <textarea
                  ref={textareaRef}
                  className={`sb-textarea ${isReadOnly ? 'is-readonly' : ''}`}
                  data-ipa-input={isReadOnly ? undefined : '1'}
                  rows={3}
                  spellCheck={false}
                  readOnly={isReadOnly}
                  placeholder={isReadOnly ? '（空区间）' : '输入区间标注文本或音标…'}
                  value={textDraft}
                  onChange={isReadOnly ? undefined : (e) => handleDraftValueChange(e.target.value)}
                  onCompositionStart={isReadOnly ? undefined : ipaIme.onCompositionStart}
                  onCompositionEnd={isReadOnly ? undefined : ipaIme.onCompositionEnd}
                  onKeyDown={isReadOnly ? undefined : ipaIme.onKeyDown}
                  onKeyUp={isReadOnly ? undefined : ipaIme.onKeyUp}
                  onBlur={
                    isReadOnly
                      ? undefined
                      : (e) => {
                          if (isIpaRelatedElement(e.relatedTarget)) return;
                          flushPendingTextDraft();
                        }
                  }
                />
              </div>
              {!isReadOnly && <IpaImePopover ime={ipaIme} />}
              {trigraphPreview && (
                <div className="sb-trigraph-preview">
                  <span className="sb-trigraph-label">音标预览</span>
                  <span className="sb-trigraph-val selectable">{trigraphPreview}</span>
                </div>
              )}
              <div className="sb-hint">
                {isReadOnly
                  ? '只读模式：可选中复制文本，切换至编辑模式后修改。'
                  : `Tab 连编 · Alt+P/F4 重听（+Shift 语境）· ${formatKeyCombo('Mod+Enter')} 提交 · ${formatKeyCombo('Mod+\\')} 切音标。`}
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            id="insp-iv-time"
            title="起止时间与微调"
            badge={formatDurationBadge(durSec)}
            defaultOpen={true}
          >
            <div className="sb-stack">
              <div className="sb-field-grid-2">
                <ScrubNumberInput
                  variant="sidebar"
                  label="起始 (s)"
                  value={activeInterval.xmin}
                  min={startMin}
                  strictMin={prevLinked}
                  max={activeInterval.xmax}
                  strictMax={true}
                  disabled={isReadOnly}
                  formatValue={formatPraatDouble}
                  onCommit={(val) => updateIntervalBound('start', val)}
                />
                <ScrubNumberInput
                  variant="sidebar"
                  label="结束 (s)"
                  value={activeInterval.xmax}
                  min={activeInterval.xmin}
                  strictMin={true}
                  max={endMax}
                  strictMax={nextLinked}
                  disabled={isReadOnly}
                  formatValue={formatPraatDouble}
                  onCommit={(val) => updateIntervalBound('end', val)}
                />
              </div>

              <div className="sb-kv-row">
                <span className="sb-kv-key">区间时长</span>
                <span className="sb-kv-val mono">
                  {durMs.toFixed(1)} ms / {durSec.toFixed(4)} s
                </span>
              </div>

              <div className="sb-nudge-group">
                <span className="sb-nudge-lbl">起始微调</span>
                <div className="sb-nudge-row">
                  {([-0.01, -0.001, 0.001, 0.01] as const).map((delta) => (
                    <button
                      key={`st-${delta}`}
                      type="button"
                      className="compact sb-nudge-btn"
                      disabled={isReadOnly}
                      title={isReadOnly ? '请先切换至编辑模式' : undefined}
                      onClick={() => updateIntervalBound('start', activeInterval.xmin + delta)}
                    >
                      {delta < 0 ? `−${Math.abs(delta * 1000)}` : `+${delta * 1000}`}ms
                    </button>
                  ))}
                </div>
              </div>

              <div className="sb-nudge-group">
                <span className="sb-nudge-lbl">结束微调</span>
                <div className="sb-nudge-row">
                  {([-0.01, -0.001, 0.001, 0.01] as const).map((delta) => (
                    <button
                      key={`en-${delta}`}
                      type="button"
                      className="compact sb-nudge-btn"
                      disabled={isReadOnly}
                      title={isReadOnly ? '请先切换至编辑模式' : undefined}
                      onClick={() => updateIntervalBound('end', activeInterval.xmax + delta)}
                    >
                      {delta < 0 ? `−${Math.abs(delta * 1000)}` : `+${delta * 1000}`}ms
                    </button>
                  ))}
                </div>
              </div>

              <label className={`export-check ${isReadOnly ? 'is-disabled' : ''}`}>
                <input
                  type="checkbox"
                  disabled={isReadOnly}
                  checked={linkAdjacent}
                  onChange={(e) => setLinkAdjacent(e.target.checked)}
                />
                <span>联动相邻边界</span>
              </label>
            </div>
          </CollapsibleSection>

          {analysis && (
            <CollapsibleSection
              id="insp-iv-acoustic"
              title="声学读数"
              badge={intervalAcoustic?.f0Mean ? `${intervalAcoustic.f0Mean.toFixed(0)} Hz` : undefined}
              defaultOpen={true}
            >
              {renderAcousticBlock(
                intervalAcoustic,
                activeInterval.xmin,
                activeInterval.xmax,
                activeInterval.text
              )}
            </CollapsibleSection>
          )}

          <CollapsibleSection id="insp-iv-actions" title="快捷操作" defaultOpen={true}>
            <div className="sb-action-grid">
              <button
                type="button"
                className="compact"
                disabled={isReadOnly || activeInterval.xmax <= activeInterval.xmin}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) splitInterval(ti, ii);
                }}
              >
                <UiIcon name="split" size={13} />
                <span>从正中切分</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly || ii === 0}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) mergeIntervalWith(ti, ii, -1);
                }}
              >
                <UiIcon name="mergeLeft" size={13} />
                <span>向左合并</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly || ii >= activeTier.intervals.length - 1}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) mergeIntervalWith(ti, ii, 1);
                }}
              >
                <UiIcon name="mergeRight" size={13} />
                <span>向右合并</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly || activeInterval.text === ''}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (isReadOnly) return;
                  draftDirtyRef.current = false;
                  draftValueRef.current = '';
                  setTextDraft('');
                  commitTgMutation(
                    (d) => {
                      d.tiers[ti].intervals[ii].text = '';
                    },
                    undefined,
                    '清空区间文本'
                  );
                }}
              >
                <UiIcon name="clear" size={13} />
                <span>清空文本</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={activeInterval.xmax <= activeInterval.xmin}
                onClick={() => {
                  setPlayRange({ start: activeInterval.xmin, end: activeInterval.xmax });
                  onStartPlayback(activeInterval.xmin, activeInterval.xmax);
                }}
              >
                <UiIcon name="play" size={13} />
                <span>播放该区间</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={activeInterval.xmax <= activeInterval.xmin}
                title="前后各扩展 250 ms 带语境试听 (Shift+R / Shift+F4)"
                onClick={() => {
                  const start = Math.max(tg.xmin, activeInterval.xmin - 0.25);
                  const end = Math.min(tg.xmax, activeInterval.xmax + 0.25);
                  onStartPlayback(start, end);
                }}
              >
                <UiIcon name="playContext" size={13} />
                <span>语境 ±250ms</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={activeInterval.xmax <= activeInterval.xmin}
                onClick={() => {
                  setLoop(true);
                  setPlayRange({ start: activeInterval.xmin, end: activeInterval.xmax });
                  onStartPlayback(activeInterval.xmin, activeInterval.xmax);
                }}
              >
                <UiIcon name="loop" size={13} />
                <span>循环播放</span>
              </button>
              {isZoomedHere ? (
                <button type="button" className="compact active" onClick={() => setViewDomain(null)}>
                  <UiIcon name="zoomReset" size={13} />
                  <span>显示全长</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="compact"
                  disabled={activeInterval.xmax <= activeInterval.xmin}
                  onClick={() => setViewDomain({ min: activeInterval.xmin, max: activeInterval.xmax })}
                >
                  <UiIcon name="zoomIn" size={13} />
                  <span>放大查看</span>
                </button>
              )}
              <button
                type="button"
                className="compact"
                disabled={activeInterval.xmax <= activeInterval.xmin}
                onClick={() => openExportModal('selection')}
              >
                <UiIcon name="export" size={13} />
                <span>以此选区导出</span>
              </button>
            </div>
          </CollapsibleSection>
          {qaDiagnosticsSection}
        </div>
      );
    }

    // 2. POINT SELECTED
    if (selection?.kind === 'point' && activePoint && activeTier) {
      const ti = selection.tierIndex;
      const pi = selection.itemIndex;
      return (
        <div className="sb-panel-root">
          <div className="sb-context-strip">
            <span className="sb-context-tag">
              第 {ti + 1} 层 · 第 {pi + 1} 点
            </span>
            <span className="sb-context-name" title={activeTier.name || '未命名点层'}>
              {activeTier.name || '未命名点层'}
            </span>
          </div>
          {readOnlyBanner}

          <CollapsibleSection id="insp-pt-text" title="文本与音标" defaultOpen={true}>
            <div className="sb-stack">
              <div className={`sb-ipa-field-wrap ${!isReadOnly && ipaIme.ipaMode !== 'off' ? 'has-pill' : ''}`}>
                {!isReadOnly && <IpaModePill ime={ipaIme} className="is-sidebar-docked" />}
                <textarea
                  ref={textareaRef}
                  className={`sb-textarea ${isReadOnly ? 'is-readonly' : ''}`}
                  data-ipa-input={isReadOnly ? undefined : '1'}
                  rows={3}
                  spellCheck={false}
                  readOnly={isReadOnly}
                  placeholder={isReadOnly ? '（空白标点）' : '输入标注点文本或音标…'}
                  value={textDraft}
                  onChange={isReadOnly ? undefined : (e) => handleDraftValueChange(e.target.value)}
                  onCompositionStart={isReadOnly ? undefined : ipaIme.onCompositionStart}
                  onCompositionEnd={isReadOnly ? undefined : ipaIme.onCompositionEnd}
                  onKeyDown={isReadOnly ? undefined : ipaIme.onKeyDown}
                  onKeyUp={isReadOnly ? undefined : ipaIme.onKeyUp}
                  onBlur={
                    isReadOnly
                      ? undefined
                      : (e) => {
                          if (isIpaRelatedElement(e.relatedTarget)) return;
                          flushPendingTextDraft();
                        }
                  }
                />
              </div>
              {!isReadOnly && <IpaImePopover ime={ipaIme} />}
              {trigraphPreview && (
                <div className="sb-trigraph-preview">
                  <span className="sb-trigraph-label">音标预览</span>
                  <span className="sb-trigraph-val selectable">{trigraphPreview}</span>
                </div>
              )}
              <div className="sb-hint">
                {isReadOnly
                  ? '只读模式：可选中复制标记，切换至编辑模式后修改。'
                  : `Tab 连编 · Alt+P/F4 重听（+Shift 语境）· ${formatKeyCombo('Mod+Enter')} 提交 · ${formatKeyCombo('Mod+\\')} 切音标。`}
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            id="insp-pt-time"
            title="时刻与微调"
            badge={`${activePoint.number.toFixed(3)} s`}
            defaultOpen={true}
          >
            <div className="sb-stack">
              <ScrubNumberInput
                variant="sidebar"
                label="标注时刻 (s)"
                value={activePoint.number}
                min={activeTier.xmin}
                max={activeTier.xmax}
                disabled={isReadOnly}
                formatValue={formatPraatDouble}
                onCommit={(val) => updatePointTime(val)}
              />

              <div className="sb-nudge-group">
                <span className="sb-nudge-lbl">时刻微调</span>
                <div className="sb-nudge-row">
                  {([-0.01, -0.001, 0.001, 0.01] as const).map((delta) => (
                    <button
                      key={`pt-${delta}`}
                      type="button"
                      className="compact sb-nudge-btn"
                      disabled={isReadOnly}
                      title={isReadOnly ? '请先切换至编辑模式' : undefined}
                      onClick={() => updatePointTime(activePoint.number + delta)}
                    >
                      {delta < 0 ? `−${Math.abs(delta * 1000)}` : `+${delta * 1000}`}ms
                    </button>
                  ))}
                </div>
              </div>

              <div className="sb-hint">
                拖拽时按住 Z 吸附过零点、Alt 临时取消对齐，或按 Shift+←/→（+Alt ±1ms）微调。
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="insp-pt-actions" title="快捷操作" defaultOpen={true}>
            <div className="sb-action-grid">
              <button
                type="button"
                className="compact"
                onClick={() => {
                  setPlayRange(null);
                  onStartPlayback(activePoint.number, tg.xmax);
                }}
              >
                <UiIcon name="play" size={13} />
                <span>从此点播放</span>
              </button>
              <button
                type="button"
                className="compact danger"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (isReadOnly) return;
                  commitTgMutation(
                    (draft) => {
                      draft.tiers[ti].points.splice(pi, 1);
                    },
                    null,
                    '删除标注点'
                  );
                }}
              >
                <UiIcon name="trash" size={13} />
                <span>删除此标注点</span>
              </button>
            </div>
          </CollapsibleSection>
          {qaDiagnosticsSection}
        </div>
      );
    }

    // 3. BOUNDARY OR SPINE SELECTED
    if (selection?.kind === 'boundary' || selection?.kind === 'spine') {
      const isBoundary = selection.kind === 'boundary';
      const tier = isBoundary ? tg.tiers[selection.tierIndex] : null;
      const affectAll = !isBoundary || boundaryShared;
      let bndMin = tg.xmin;
      let bndMax = tg.xmax;
      const tiersToInspect = affectAll ? tg.tiers : tier ? [tier] : [];
      for (const t of tiersToInspect) {
        if (t.kind !== 'intervalTier') continue;
        for (const iv of t.intervals) {
          if (Math.abs(iv.xmax - selection.time) < 1e-6 && iv.xmin > bndMin) {
            bndMin = iv.xmin;
          }
          if (Math.abs(iv.xmin - selection.time) < 1e-6 && iv.xmax < bndMax) {
            bndMax = iv.xmax;
          }
        }
      }
      return (
        <div className="sb-panel-root">
          <div className="sb-context-strip">
            <span className="sb-context-tag">
              {isBoundary ? `第 ${selection.tierIndex + 1} 层 · 边界` : '对齐时刻线'}
            </span>
            <span className="sb-context-name">
              {isBoundary ? tier?.name || '未命名层' : '跨层共享时刻'}
            </span>
          </div>
          {readOnlyBanner}

          <CollapsibleSection
            id="insp-bnd-time"
            title="精确时刻与微调"
            badge={`${selection.time.toFixed(3)} s`}
            defaultOpen={true}
          >
            <div className="sb-stack">
              <ScrubNumberInput
                variant="sidebar"
                label="边界时刻 (s)"
                value={selection.time}
                min={bndMin}
                max={bndMax}
                strictMin={true}
                strictMax={true}
                disabled={isReadOnly}
                formatValue={formatPraatDouble}
                onCommit={(val) => updateBoundaryOrSpineTime(val)}
              />

              <div className="sb-nudge-group">
                <span className="sb-nudge-lbl">精确微调</span>
                <div className="sb-nudge-row">
                  {([-0.01, -0.001, 0.001, 0.01] as const).map((delta) => (
                    <button
                      key={`bnd-${delta}`}
                      type="button"
                      className="compact sb-nudge-btn"
                      disabled={isReadOnly}
                      title={isReadOnly ? '请先切换至编辑模式' : undefined}
                      onClick={() => updateBoundaryOrSpineTime(selection.time + delta)}
                    >
                      {delta < 0 ? `−${Math.abs(delta * 1000)}` : `+${delta * 1000}`}ms
                    </button>
                  ))}
                </div>
              </div>

              {analysis && (
                <button
                  type="button"
                  className="compact sb-full-btn"
                  disabled={isReadOnly}
                  title={
                    isReadOnly
                      ? '请先切换至编辑模式'
                      : '查找音频波形中距此边界最近的过零点并对齐'
                  }
                  onClick={() => void handleSnapZeroCrossing()}
                >
                  <UiIcon name="zeroCross" size={13} />
                  <span>吸附最近过零点</span>
                </button>
              )}

              <div className="sb-hint">
                可直接在上方语谱图区匀速拖拽边界，或按 Shift+←/→（+Alt ±1ms）微调。
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="insp-bnd-actions" title="试听与操作" defaultOpen={true}>
            <div className="sb-stack">
              <div className="sb-setting-block">
                <span className="sb-field-lbl">边界试听</span>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                    gap: 4
                  }}
                >
                  <button
                    type="button"
                    className="compact"
                    style={{ padding: '0 4px', justifyContent: 'center' }}
                    disabled={selection.time <= tg.xmin + 1e-6}
                    title="试听边界前 250 ms"
                    onClick={() => {
                      const start = Math.max(tg.xmin, selection.time - 0.25);
                      onStartPlayback(start, selection.time);
                    }}
                  >
                    前 250ms
                  </button>
                  <button
                    type="button"
                    className="compact"
                    style={{ padding: '0 4px', justifyContent: 'center' }}
                    disabled={tg.xmax <= tg.xmin}
                    title="跨越边界试听前后各 200 ms"
                    onClick={() => {
                      const start = Math.max(tg.xmin, selection.time - 0.2);
                      const end = Math.min(tg.xmax, selection.time + 0.2);
                      onStartPlayback(start, end);
                    }}
                  >
                    跨越 ±200ms
                  </button>
                  <button
                    type="button"
                    className="compact"
                    style={{ padding: '0 4px', justifyContent: 'center' }}
                    disabled={selection.time >= tg.xmax - 1e-6}
                    title="试听边界后 250 ms"
                    onClick={() => {
                      const end = Math.min(tg.xmax, selection.time + 0.25);
                      onStartPlayback(selection.time, end);
                    }}
                  >
                    后 250ms
                  </button>
                </div>
              </div>

              {isBoundary ? (
                <>
                  <div className="sb-setting-block">
                    <span className="sb-field-lbl">移动作用范围</span>
                    <div className="segmented sb-seg-full" role="group">
                      <button
                        type="button"
                        className={`compact ${!boundaryShared ? 'active' : ''}`}
                        disabled={isReadOnly}
                        title={isReadOnly ? '请先切换至编辑模式' : undefined}
                        onClick={() => setBoundaryShared(false)}
                      >
                        仅当前层
                      </button>
                      <button
                        type="button"
                        className={`compact ${boundaryShared ? 'active' : ''}`}
                        disabled={isReadOnly}
                        title={isReadOnly ? '请先切换至编辑模式' : undefined}
                        onClick={() => setBoundaryShared(true)}
                      >
                        联动对齐层
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="compact danger sb-full-btn"
                    disabled={isReadOnly}
                    title={isReadOnly ? '请先切换至编辑模式' : undefined}
                    onClick={() => {
                      if (!isReadOnly) deleteBoundaryAt(selection.tierIndex, selection.time);
                    }}
                  >
                    <UiIcon name="delBoundary" size={13} />
                    <span>删除边界</span>
                  </button>
                </>
              ) : (
                <>
                  <div className="sb-hint">
                    调整此对齐时刻将同步移动所有处于该时间点的区间边界与标注点。
                  </div>
                  <button
                    type="button"
                    className="compact sb-full-btn"
                    onClick={() => {
                      setPlayRange(null);
                      onStartPlayback(selection.time, tg.xmax);
                    }}
                  >
                    <UiIcon name="play" size={13} />
                    <span>从此位置播放</span>
                  </button>
                </>
              )}
            </div>
          </CollapsibleSection>
          {qaDiagnosticsSection}
        </div>
      );
    }

    // 4. TIER SELECTED
    if (selection?.kind === 'tier' && activeTier) {
      const ti = selection.tierIndex;
      const itemCount =
        activeTier.kind === 'intervalTier' ? activeTier.intervals.length : activeTier.points.length;

      const commitTierName = () => {
        if (skipNextBlurRef.current) {
          skipNextBlurRef.current = false;
          return;
        }
        if (isReadOnly) return;
        if (tierNameInput !== activeTier.name) {
          const nextName = tierNameInput;
          commitTgMutation(
            (d) => {
              if (d.tiers[ti]) d.tiers[ti].name = nextName;
            },
            undefined,
            `重命名层级「${nextName || '未命名'}」`
          );
        }
      };

      return (
        <div className="sb-panel-root">
          <div className="sb-context-strip">
            <span className="sb-context-tag">第 {ti + 1} 层</span>
            <span className="sb-context-name" title={activeTier.name || '未命名层'}>
              {activeTier.name || '未命名层'}
            </span>
          </div>
          {readOnlyBanner}

          <CollapsibleSection
            id="insp-tier-info"
            title="层级信息"
            badge={activeTier.kind === 'intervalTier' ? '区间层' : '点层'}
            defaultOpen={true}
          >
            <div className="sb-stack">
              <label className="sb-field">
                <span className="sb-field-lbl">层级名称</span>
                <input
                  type="text"
                  readOnly={isReadOnly}
                  disabled={isReadOnly}
                  value={tierNameInput}
                  onChange={isReadOnly ? undefined : (e) => setTierNameInput(e.target.value)}
                  onBlur={isReadOnly ? undefined : commitTierName}
                  onKeyDown={
                    isReadOnly
                      ? undefined
                      : (e) => {
                          if (isComposingEvent(e)) return;
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                            skipNextBlurRef.current = true;
                            setTierNameInput(activeTier.name);
                            (e.target as HTMLInputElement).blur();
                          }
                        }
                  }
                />
              </label>

              <div className="sb-kv-list">
                <div className="sb-kv-row">
                  <span className="sb-kv-key">层级类型</span>
                  <span className="sb-kv-val">
                    {activeTier.kind === 'intervalTier' ? '区间层 (IntervalTier)' : '点层 (TextTier)'}
                  </span>
                </div>
                <div className="sb-kv-row">
                  <span className="sb-kv-key">条目数量</span>
                  <span className="sb-kv-val mono">
                    {itemCount} {activeTier.kind === 'intervalTier' ? '段区间' : '个标点'}
                  </span>
                </div>
                <div className="sb-kv-row">
                  <span className="sb-kv-key">时间范围</span>
                  <span className="sb-kv-val mono">
                    {formatPraatDouble(activeTier.xmin)} – {formatPraatDouble(activeTier.xmax)} s
                  </span>
                </div>
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="insp-tier-actions" title="层级操作" defaultOpen={true}>
            <div className="sb-action-grid">
              <button
                type="button"
                className="compact"
                disabled={isReadOnly || ti === 0}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) moveTier(ti, -1);
                }}
              >
                <UiIcon name="up" size={13} />
                <span>上移一层</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly || ti >= tg.tiers.length - 1}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) moveTier(ti, 1);
                }}
              >
                <UiIcon name="down" size={13} />
                <span>下移一层</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) insertTierAt(ti, 'intervalTier');
                }}
              >
                <UiIcon name="addIntervalTier" size={13} />
                <span>上方插入区间层</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) insertTierAt(ti + 1, 'intervalTier');
                }}
              >
                <UiIcon name="addIntervalTier" size={13} />
                <span>下方插入区间层</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) insertTierAt(ti + 1, 'textTier');
                }}
              >
                <UiIcon name="addPointTier" size={13} />
                <span>下方插入点层</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : '复制当前层及其全部边界与文本'}
                onClick={() => {
                  if (!isReadOnly) duplicateTier(ti, { copyText: true });
                }}
              >
                <UiIcon name="duplicateTier" size={13} />
                <span>复制整层</span>
              </button>
              {activeTier.kind === 'intervalTier' && (
                <button
                  type="button"
                  className="compact"
                  disabled={isReadOnly}
                  title={isReadOnly ? '请先切换至编辑模式' : '新建区间层并继承当前层所有边界（不含文本）'}
                  onClick={() => {
                    if (!isReadOnly) duplicateTier(ti, { copyText: false });
                  }}
                >
                  <UiIcon name="duplicateTier" size={13} />
                  <span>仅复制边界新建层</span>
                </button>
              )}
              <button
                type="button"
                className="compact"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : '保留所有边界与点位，仅清空本层标注文本'}
                onClick={() => {
                  if (!isReadOnly) clearTierText(ti);
                }}
              >
                <UiIcon name="clear" size={13} />
                <span>清空本层文本</span>
              </button>
              <button
                type="button"
                className="compact danger"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : '删除当前层（支持单步撤销）'}
                onClick={() => {
                  if (!isReadOnly) removeTierWithUndoToast(ti);
                }}
              >
                <UiIcon name="trash" size={13} />
                <span>删除该层</span>
              </button>
            </div>
          </CollapsibleSection>
          {qaDiagnosticsSection}
        </div>
      );
    }

    // 5. PLAY RANGE ACTIVE (NO SELECTION)
    if (playRange && playRange.end > playRange.start) {
      const durSec = Math.max(0, playRange.end - playRange.start);
      const durMs = durSec * 1000;

      const applyRange = (which: 'start' | 'end', rawVal: number): boolean => {
        if (!Number.isFinite(rawVal)) {
          return false;
        }
        const clamped = round6(Math.max(tg.xmin, Math.min(tg.xmax, rawVal)));
        const nextStart = which === 'start' ? clamped : playRange.start;
        const nextEnd = which === 'end' ? clamped : playRange.end;
        if (nextEnd <= nextStart) {
          showToast('选区结束时间必须大于起始时间', true);
          return false;
        }
        setPlayRange({ start: nextStart, end: nextEnd });
        setPlaybackTime(nextStart, true);
        return true;
      };

      return (
        <div className="sb-panel-root">
          <div className="sb-context-strip">
            <span className="sb-context-tag">时间选区</span>
            <span className="sb-context-name mono">
              {playRange.start.toFixed(3)} – {playRange.end.toFixed(3)} s
            </span>
          </div>

          <CollapsibleSection
            id="insp-range-time"
            title="选区时间范围"
            badge={formatDurationBadge(durSec)}
            defaultOpen={true}
          >
            <div className="sb-stack">
              <div className="sb-field-grid-2">
                <ScrubNumberInput
                  variant="sidebar"
                  label="起始 (s)"
                  value={playRange.start}
                  min={tg.xmin}
                  max={playRange.end}
                  strictMax={true}
                  formatValue={formatPraatDouble}
                  onCommit={(val) => applyRange('start', val)}
                />
                <ScrubNumberInput
                  variant="sidebar"
                  label="结束 (s)"
                  value={playRange.end}
                  min={playRange.start}
                  strictMin={true}
                  max={tg.xmax}
                  formatValue={formatPraatDouble}
                  onCommit={(val) => applyRange('end', val)}
                />
              </div>

              <div className="sb-kv-row">
                <span className="sb-kv-key">选区时长</span>
                <span className="sb-kv-val mono">
                  {durMs.toFixed(1)} ms / {durSec.toFixed(4)} s
                </span>
              </div>

              <button
                type="button"
                className="compact sb-full-btn"
                onClick={() => setPlayRange(null)}
              >
                <UiIcon name="clear" size={13} />
                <span>清除选区</span>
              </button>
            </div>
          </CollapsibleSection>

          {analysis && (
            <CollapsibleSection
              id="insp-range-acoustic"
              title="选区声学统计"
              badge={rangeAcoustic?.f0Mean ? `${rangeAcoustic.f0Mean.toFixed(0)} Hz` : undefined}
              defaultOpen={true}
            >
              {renderAcousticBlock(rangeAcoustic, playRange.start, playRange.end)}
            </CollapsibleSection>
          )}

          <CollapsibleSection id="insp-range-actions" title="选区操作" defaultOpen={true}>
            <div className="sb-action-grid">
              <button
                type="button"
                className="compact"
                onClick={() => onStartPlayback(playRange.start, playRange.end)}
              >
                <UiIcon name="play" size={13} />
                <span>播放选区</span>
              </button>
              <button
                type="button"
                className="compact"
                onClick={() => {
                  setLoop(true);
                  onStartPlayback(playRange.start, playRange.end);
                }}
              >
                <UiIcon name="loop" size={13} />
                <span>循环播放</span>
              </button>
              <button
                type="button"
                className="compact"
                onClick={() => setViewDomain({ min: playRange.start, max: playRange.end })}
              >
                <UiIcon name="zoomIn" size={13} />
                <span>放大选区</span>
              </button>
              <button
                type="button"
                className="compact"
                onClick={() => openExportModal('selection')}
              >
                <UiIcon name="export" size={13} />
                <span>以此选区导出</span>
              </button>
            </div>
          </CollapsibleSection>
          {qaDiagnosticsSection}
        </div>
      );
    }

    // 6. DOCUMENT OVERVIEW (NOTHING SELECTED)
    const totalIntervals = tg.tiers.reduce(
      (acc, t) => acc + (t.kind === 'intervalTier' ? t.intervals.length : 0),
      0
    );
    const totalPoints = tg.tiers.reduce(
      (acc, t) => acc + (t.kind === 'textTier' ? t.points.length : 0),
      0
    );
    const totalDur = Math.max(0, (Number.isFinite(tg.xmax) ? tg.xmax : 0) - (Number.isFinite(tg.xmin) ? tg.xmin : 0));

    return (
      <div className="sb-panel-root">
        <div className="sb-context-strip">
          <span className="sb-context-tag">文档概览</span>
          <span className="sb-context-name" title={filename}>
            {filename}
          </span>
        </div>
        {readOnlyBanner}

        <CollapsibleSection
          id="insp-doc-overview"
          title="文档概览"
          badge={`${tg.tiers.length} 层`}
          defaultOpen={true}
        >
          <div className="sb-kv-list">
            <div className="sb-kv-row">
              <span className="sb-kv-key">文件名称</span>
              <span className="sb-kv-val mono sb-ellipsis" title={filename}>
                {filename}
              </span>
            </div>
            <div className="sb-kv-row">
              <span className="sb-kv-key">文件格式</span>
              <span className="sb-kv-val">{formatFormatLabel(currentFileFormat)}</span>
            </div>
            <div className="sb-kv-row">
              <span className="sb-kv-key">时间范围</span>
              <span className="sb-kv-val mono">
                {formatPraatDouble(tg.xmin)} – {formatPraatDouble(tg.xmax)} s
              </span>
            </div>
            <div className="sb-kv-row">
              <span className="sb-kv-key">文档总长</span>
              <span className="sb-kv-val mono">{totalDur.toFixed(3)} s</span>
            </div>
            <div className="sb-kv-row">
              <span className="sb-kv-key">层级数量</span>
              <span className="sb-kv-val mono">{tg.tiers.length} 层</span>
            </div>
            <div className="sb-kv-row">
              <span className="sb-kv-key">标注统计</span>
              <span className="sb-kv-val mono">
                {totalIntervals} 段区间 · {totalPoints} 个标点
              </span>
            </div>
            {audioName && (
              <div className="sb-kv-row">
                <span className="sb-kv-key">配套录音</span>
                <span className="sb-kv-val mono sb-ellipsis" title={audioName}>
                  {audioName} ({audioDuration.toFixed(2)}s · {(audioSampleRate / 1000).toFixed(1)}kHz)
                </span>
              </div>
            )}
          </div>
        </CollapsibleSection>

        {qaDiagnosticsSection}
      </div>
    );
  }
);
