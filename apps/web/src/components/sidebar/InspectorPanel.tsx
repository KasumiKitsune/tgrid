import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';
import { getTabAudioBuffer } from '../../audio/tabAudioStore';
import { getPlatformBridge } from '../../bridge/PlatformBridge';
import type {
  AudioAnalysisSummary,
  TextGrid,
  TextGridFormat
} from '../../bridge/types';
import { resolveTierScaleMode } from '../../layout/computeLayout';
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
import {
  formatDeltaTime,
  formatQuote,
  formatTierLabel,
  formatTimeSec
} from '../../store/historyModel';
import { useEditorStore } from '../../store/useEditorStore';
import { alignSplitBoundariesAcoustically } from '../../utils/acousticSplitClient';
import {
  formatAcousticSnapToast,
  snapBoundaryAcoustically
} from '../../utils/acousticSnapClient';
import {
  BLOCK_ALIGN_EPS,
  computeBlockSafeBounds,
  findAlignedBlock
} from '../../utils/blockTransform';
import {
  analyzeMultiSelection,
  computeMultiSyncDeltaBounds,
  type MultiSyncAction
} from '../../utils/multiSelection';
import {
  formatAlignMicroFeedback,
  scanTextGridQa,
  type QaIssue,
  type QaIssueKind
} from '../../utils/qaDiagnostics';
import type { SmartSplitCandidate } from '../../utils/smartSplit';
import { UiIcon } from '../Icons';
import { IpaImePopover, IpaModePill } from '../IpaImePopover';
import { ScrubNumberInput } from '../ScrubNumberInput';
import { ToggleSwitch } from '../ToggleSwitch';
import { isIpaRelatedElement, useIpaIme } from '../useIpaIme';
import {
  BoundaryBalanceBar,
  BoundaryMicroWave,
  IntervalF0Sparkline,
  SmartSplitInlineCard
} from './InspectorVisuals';
import '../../styles/inspector.css';

export interface InspectorPanelHandle {
  insertIpaSymbol: (sym: string, isTieBar?: boolean) => boolean;
  flushDraft: () => void;
}

interface InspectorPanelProps {
  onStartPlayback: (startT: number, endT: number) => void;
  audioBuffer?: AudioBuffer | null;
  onOpenSplitModal?: (tierIndex: number, itemIndex: number) => void;
}

type AnchorMode = 'start' | 'duration' | 'end';
type IntervalNudgeTarget = 'start' | 'move' | 'end';
type NudgeStepMs = 1 | 5 | 10;
type QaFilterKey = 'all' | QaIssueKind;

interface AcousticStats {
  f0Mean: number | null;
  f0Min: number | null;
  f0Max: number | null;
  voicedCount: number;
  totalFrames: number;
  voicedRatio: number | null;
  rmsDb: number | null;
  f1: number | null;
  f2: number | null;
  f3: number | null;
}

interface InstantAcousticStats {
  f0: number | null;
  f1: number | null;
  f2: number | null;
  f3: number | null;
}

interface InspectorCardProps {
  title: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  tight?: boolean;
  children: React.ReactNode;
}

const InspectorCard: React.FC<InspectorCardProps> = ({
  title,
  badge,
  actions,
  tight = false,
  children
}) => (
  <section className="insp-card">
    <header className="insp-card-head">
      <span className="insp-card-title">{title}</span>
      <div className="insp-card-actions">
        {badge}
        {actions}
      </div>
    </header>
    <div className={`insp-card-body${tight ? ' is-tight' : ''}`}>{children}</div>
  </section>
);

function round6(t: number): number {
  return Number(t.toFixed(6));
}

function formatDurationBadge(durSec: number): string {
  const safe = Math.max(0, Number.isFinite(durSec) ? durSec : 0);
  if (safe < 1) return `${(safe * 1000).toFixed(safe < 0.01 ? 1 : 0)} ms`;
  return `${safe.toFixed(3)} s`;
}

function formatShortDur(durSec: number): string {
  const safe = Math.max(0, Number.isFinite(durSec) ? durSec : 0);
  if (safe >= 1) return `${safe.toFixed(2)}s`;
  const ms = safe * 1000;
  return ms >= 10 ? `${Math.round(ms)}ms` : `${ms.toFixed(1)}ms`;
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

function formatMultiKindLabel(kind: string): string {
  switch (kind) {
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

function computeRmsDb(
  audioBuffer: AudioBuffer | null,
  audioOffset: number,
  tMin: number,
  tMax: number
): number | null {
  if (!audioBuffer || audioBuffer.length === 0 || !Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax <= tMin) {
    return null;
  }
  const sr = audioBuffer.sampleRate;
  const raw = audioBuffer.getChannelData(0);
  const s0 = Math.max(0, Math.floor((tMin - audioOffset) * sr));
  const s1 = Math.min(raw.length, Math.ceil((tMax - audioOffset) * sr));
  if (s1 <= s0) return null;
  const step = Math.max(1, Math.floor((s1 - s0) / 4096));
  let sumSq = 0;
  let count = 0;
  for (let i = s0; i < s1; i += step) {
    const v = raw[i];
    sumSq += v * v;
    count++;
  }
  if (count === 0) return null;
  const rms = Math.sqrt(sumSq / count);
  if (rms <= 1e-7) return null;
  return 20 * Math.log10(rms);
}

function computeAcousticStats(
  analysis: AudioAnalysisSummary | null,
  audioBuffer: AudioBuffer | null,
  audioOffset: number,
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
  let totalFrames = 0;

  for (const p of analysis.pitchTrack) {
    if (p.t < tMin || p.t > tMax) continue;
    totalFrames++;
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
    totalFrames,
    voicedRatio: totalFrames > 0 ? voicedCount / totalFrames : null,
    rmsDb: computeRmsDb(audioBuffer, audioOffset, tMin, tMax),
    f1: readF(0),
    f2: readF(1),
    f3: readF(2)
  };
}

function computeInstantAcoustic(
  analysis: AudioAnalysisSummary | null,
  timeSec: number
): InstantAcousticStats | null {
  if (!analysis || !Number.isFinite(timeSec)) return null;
  const maxWin = 0.03;

  let bestF0: number | null = null;
  let bestF0Dist = maxWin;
  for (const p of analysis.pitchTrack) {
    const d = Math.abs(p.t - timeSec);
    if (d < bestF0Dist && p.f0 !== null && Number.isFinite(p.f0) && p.f0 > 0) {
      bestF0Dist = d;
      bestF0 = p.f0;
    }
  }

  let bestFrame: { t: number; freqs: number[] } | null = null;
  let bestFormantDist = maxWin;
  for (const frame of analysis.formantTrack) {
    if (!frame.freqs.length) continue;
    const d = Math.abs(frame.t - timeSec);
    if (d < bestFormantDist) {
      bestFormantDist = d;
      bestFrame = frame;
    }
  }

  const readF = (idx: number): number | null => {
    const v = bestFrame?.freqs[idx];
    return v !== undefined && Number.isFinite(v) && v > 0 ? v : null;
  };

  return {
    f0: bestF0,
    f1: readF(0),
    f2: readF(1),
    f3: readF(2)
  };
}

function findNearestZeroCrossingLocal(
  audioBuffer: AudioBuffer | null,
  audioOffset: number,
  timeSec: number,
  halfWindowSec = 0.015
): number | null {
  if (!audioBuffer || audioBuffer.length < 2 || !Number.isFinite(timeSec)) return null;
  const sr = audioBuffer.sampleRate;
  if (!Number.isFinite(sr) || sr <= 0) return null;
  const raw = audioBuffer.getChannelData(0);
  const centerIdx = (timeSec - audioOffset) * sr;
  const halfSamples = Math.ceil(halfWindowSec * sr);
  const lo = Math.max(0, Math.floor(centerIdx) - halfSamples);
  const hi = Math.min(raw.length - 2, Math.ceil(centerIdx) + halfSamples);
  if (lo > hi) return null;

  let bestT: number | null = null;
  let bestDist = Infinity;

  for (let i = lo; i <= hi; i++) {
    const a = raw[i];
    const b = raw[i + 1];
    if (a === 0) {
      const t = audioOffset + i / sr;
      const d = Math.abs(t - timeSec);
      if (d < bestDist) {
        bestDist = d;
        bestT = t;
      }
    } else if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
      const frac = Math.abs(a) / (Math.abs(a) + Math.abs(b));
      const t = audioOffset + (i + frac) / sr;
      const d = Math.abs(t - timeSec);
      if (d < bestDist) {
        bestDist = d;
        bestT = t;
      }
    }
  }
  return bestT !== null ? round6(bestT) : null;
}

function formatHz(v: number | null, digits = 0): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)} Hz`;
}

function collectTierInteriorBoundaries(tg: TextGrid, tierIndex: number): number[] {
  const tier = tg.tiers[tierIndex];
  if (!tier || tier.kind !== 'intervalTier') return [];
  const eps = 1e-7;
  const times: number[] = [];
  for (const iv of tier.intervals) {
    if (iv.xmin > tier.xmin + eps && iv.xmin < tier.xmax - eps) {
      times.push(iv.xmin);
    }
    if (iv.xmax > tier.xmin + eps && iv.xmax < tier.xmax - eps) {
      times.push(iv.xmax);
    }
  }
  times.sort((a, b) => a - b);
  const deduped: number[] = [];
  for (const t of times) {
    if (deduped.length === 0 || Math.abs(t - deduped[deduped.length - 1]) > 1e-6) {
      deduped.push(t);
    }
  }
  return deduped;
}

function collectAllInteriorBoundaries(tg: TextGrid): number[] {
  const eps = 1e-7;
  const times: number[] = [];
  for (const tier of tg.tiers) {
    if (tier.kind !== 'intervalTier') continue;
    for (const iv of tier.intervals) {
      if (iv.xmin > tier.xmin + eps && iv.xmin < tier.xmax - eps) times.push(iv.xmin);
      if (iv.xmax > tier.xmin + eps && iv.xmax < tier.xmax - eps) times.push(iv.xmax);
    }
  }
  times.sort((a, b) => a - b);
  const deduped: number[] = [];
  for (const t of times) {
    if (deduped.length === 0 || Math.abs(t - deduped[deduped.length - 1]) > 1e-6) {
      deduped.push(t);
    }
  }
  return deduped;
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
  ({ onStartPlayback, audioBuffer, onOpenSplitModal }, ref) => {
    const tg = useEditorStore((s) => s.tg);
    const mode = useEditorStore((s) => s.mode);
    const setMode = useEditorStore((s) => s.setMode);
    const isReadOnly = mode === 'read';
    const filename = useEditorStore((s) => s.filename);
    const currentFileFormat = useEditorStore((s) => s.currentFileFormat);
    const sidebarOpen = useEditorStore((s) => s.sidebarOpen);
    const sidebarTab = useEditorStore((s) => s.sidebarTab);
    const selection = useEditorStore((s) => s.selection);
    const setSelection = useEditorStore((s) => s.setSelection);
    const multiSelection = useEditorStore((s) => s.multiSelection);
    const setMultiSelectionPrimary = useEditorStore((s) => s.setMultiSelectionPrimary);
    const removeFromMultiSelection = useEditorStore((s) => s.removeFromMultiSelection);
    const mergeMultiSelection = useEditorStore((s) => s.mergeMultiSelection);
    const alignMultiSelectionBounds = useEditorStore((s) => s.alignMultiSelectionBounds);
    const syncTransformMultiSelection = useEditorStore((s) => s.syncTransformMultiSelection);
    const playRange = useEditorStore((s) => s.playRange);
    const setPlayRange = useEditorStore((s) => s.setPlayRange);
    const setPlaybackTime = useEditorStore((s) => s.setPlaybackTime);
    const viewDomain = useEditorStore((s) => s.viewDomain);
    const setViewDomain = useEditorStore((s) => s.setViewDomain);
    const audioName = useEditorStore((s) => s.audioName);
    const audioOffset = useEditorStore((s) => s.audioOffset);
    const audioDuration = useEditorStore((s) => s.audioDuration);
    const audioSampleRate = useEditorStore((s) => s.audioSampleRate);
    const analysis = useEditorStore((s) => s.analysis);
    const activeTabId = useEditorStore((s) => s.activeTabId);
    const commitTgMutation = useEditorStore((s) => s.commitTgMutation);
    const updateIntervalBoundsWithAnchor = useEditorStore((s) => s.updateIntervalBoundsWithAnchor);
    const convertSelectionIpa = useEditorStore((s) => s.convertSelectionIpa);
    const movePointToTime = useEditorStore((s) => s.movePointToTime);
    const splitIntervalWithCuts = useEditorStore((s) => s.splitIntervalWithCuts);
    const splitIntervalEqualN = useEditorStore((s) => s.splitIntervalEqualN);
    const smartSplitUseAcoustic = useEditorStore((s) => s.smartSplitUseAcoustic);
    const setSmartSplitUseAcoustic = useEditorStore((s) => s.setSmartSplitUseAcoustic);
    const projectBoundaryToTier = useEditorStore((s) => s.projectBoundaryToTier);
    const alignMicroBoundaries = useEditorStore((s) => s.alignMicroBoundaries);
    const hiddenTierIndices = useEditorStore((s) => s.hiddenTierIndices);
    const scaleMode = useEditorStore((s) => s.scaleMode);
    const tierScaleOverrides = useEditorStore((s) => s.tierScaleOverrides);
    const setTierScaleMode = useEditorStore((s) => s.setTierScaleMode);
    const toggleTierVisibility = useEditorStore((s) => s.toggleTierVisibility);
    const soloTier = useEditorStore((s) => s.soloTier);
    const showAllTiers = useEditorStore((s) => s.showAllTiers);
    const normalizeTextGrid = useEditorStore((s) => s.normalizeTextGrid);
    const moveTierBoundary = useEditorStore((s) => s.moveTierBoundary);
    const moveSharedTimestamp = useEditorStore((s) => s.moveSharedTimestamp);
    const transformAlignedBlock = useEditorStore((s) => s.transformAlignedBlock);
    const showToast = useEditorStore((s) => s.showToast);
    const customShortcuts = useEditorStore((s) => s.customShortcuts);

    const effectiveAudioBuffer = useMemo(() => {
      void audioName;
      void audioDuration;
      return audioBuffer ?? getTabAudioBuffer(activeTabId);
    }, [audioBuffer, activeTabId, audioName, audioDuration]);

    const onStartPlaybackRef = useRef(onStartPlayback);
    onStartPlaybackRef.current = onStartPlayback;

    const skipNextBlurRef = useRef(false);
    const splitRunSeqRef = useRef(0);

    // Local editing drafts + race-free target tracking
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [textDraft, setTextDraft] = useState('');
    const draftTargetRef = useRef<
      { kind: 'interval' | 'point'; tierIndex: number; itemIndex: number } | null
    >(null);
    const draftValueRef = useRef('');
    const draftDirtyRef = useRef(false);
    const [trigraphPreview, setTrigraphPreview] = useState<string | null>(null);

    // Precision control states
    const [linkAdjacent, setLinkAdjacent] = useState(true);
    const [ivAnchor, setIvAnchor] = useState<AnchorMode>('start');
    const [ivNudgeTarget, setIvNudgeTarget] = useState<IntervalNudgeTarget>('start');
    const [nudgeStepMs, setNudgeStepMs] = useState<NudgeStepMs>(5);
    const [boundaryShared, setBoundaryShared] = useState(false);
    const [rangeAnchor, setRangeAnchor] = useState<AnchorMode>('start');
    const [qaFilter, setQaFilter] = useState<QaFilterKey>('all');

    // Multi-selection precision controls
    const [multiSyncAction, setMultiSyncAction] = useState<MultiSyncAction>('move');
    const [multiTargetStart, setMultiTargetStart] = useState<number>(0);
    const [multiTargetEnd, setMultiTargetEnd] = useState<number>(0);
    const [deltaResetTick, setDeltaResetTick] = useState<number>(0);

    // Tier name input draft
    const [tierNameInput, setTierNameInput] = useState('');
    const tierNameDraftRef = useRef<{ tierIndex: number; origName: string; val: string }>({
      tierIndex: -1,
      origName: '',
      val: ''
    });

    const isMultiMode = multiSelection.length >= 2;

    const multiAnalysis = useMemo(() => {
      if (!isMultiMode) return null;
      const primaryRef =
        selection?.kind === 'interval'
          ? { tierIndex: selection.tierIndex, itemIndex: selection.itemIndex }
          : null;
      return analyzeMultiSelection(tg, multiSelection, primaryRef, playRange);
    }, [isMultiMode, tg, multiSelection, selection, playRange]);

    // Keep multi-selection target start/end synced when envelope changes
    useEffect(() => {
      if (multiAnalysis && multiAnalysis.count >= 2) {
        setMultiTargetStart(round6(multiAnalysis.envelopeXmin));
        setMultiTargetEnd(round6(multiAnalysis.envelopeXmax));
      }
    }, [multiAnalysis?.envelopeXmin, multiAnalysis?.envelopeXmax, multiAnalysis?.count]);

    // Resolve active target objects safely
    const activeInterval =
      !isMultiMode && selection?.kind === 'interval'
        ? tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex] ?? null
        : null;
    const activePoint =
      !isMultiMode && selection?.kind === 'point'
        ? tg.tiers[selection.tierIndex]?.points[selection.itemIndex] ?? null
        : null;
    const activeTier =
      !isMultiMode &&
      selection &&
      (selection.kind === 'tier' ||
        selection.kind === 'interval' ||
        selection.kind === 'point' ||
        selection.kind === 'boundary')
        ? tg.tiers[selection.tierIndex] ?? null
        : null;

    // Commit interval or point text draft to its exact owning target
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
          const tier = st.tg.tiers[tgt.tierIndex];
          const cur = tier?.intervals[tgt.itemIndex];
          if (tier && cur && cur.text !== valueToCommit) {
            const tierName = formatTierLabel(tier.name, tgt.tierIndex);
            const oldText = cur.text;
            const focusT = cur.xmin;
            void primeTrigraphString(valueToCommit, bridge).then(() => st.bumpDocVersion());
            st.commitTgMutation(
              (_draft, ctx) => {
                const dTier = ctx.editTier(tgt.tierIndex);
                const target = dTier?.intervals[tgt.itemIndex];
                if (!target || target.text === valueToCommit) return false;
                target.text = valueToCommit;
              },
              undefined,
              {
                type: 'edit-interval-text',
                title: '编辑区间文本',
                detail: `${tierName} · ${formatQuote(oldText)}→${formatQuote(valueToCommit)}`,
                icon: 'edit',
                tierName,
                focusTime: focusT
              }
            );
          }
        } else if (tgt.kind === 'point') {
          const tier = st.tg.tiers[tgt.tierIndex];
          const cur = tier?.points[tgt.itemIndex];
          if (tier && cur && cur.mark !== valueToCommit) {
            const tierName = formatTierLabel(tier.name, tgt.tierIndex);
            const oldMark = cur.mark;
            const ptTime = cur.number;
            void primeTrigraphString(valueToCommit, bridge).then(() => st.bumpDocVersion());
            st.commitTgMutation(
              (_draft, ctx) => {
                const dTier = ctx.editTier(tgt.tierIndex);
                const target = dTier?.points[tgt.itemIndex];
                if (!target || target.mark === valueToCommit) return false;
                target.mark = valueToCommit;
              },
              undefined,
              {
                type: 'edit-point-text',
                title: '编辑标点文本',
                detail: `${tierName} · ${formatTimeSec(ptTime)} ${formatQuote(oldMark)}→${formatQuote(valueToCommit)}`,
                icon: 'edit',
                tierName,
                focusTime: ptTime
              }
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

        if (
          (e.ctrlKey || e.metaKey) &&
          (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter')
        ) {
          e.preventDefault();
          e.stopPropagation();
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
          !isMultiMode &&
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

    useEffect(() => {
      if (!sidebarOpen || sidebarTab !== 'inspector') {
        flushPendingRef.current();
      }
    }, [sidebarOpen, sidebarTab]);

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

    useEffect(() => {
      return () => {
        flushPendingRef.current();
      };
    }, []);

    // Sync local drafts when selection or document data changes
    useEffect(() => {
      const nextTarget =
        !isMultiMode && selection?.kind === 'interval'
          ? { kind: 'interval' as const, tierIndex: selection.tierIndex, itemIndex: selection.itemIndex }
          : !isMultiMode && selection?.kind === 'point'
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

      if (!isMultiMode && selection?.kind === 'interval' && activeInterval) {
        setTextDraft(activeInterval.text);
        draftValueRef.current = activeInterval.text;
        draftDirtyRef.current = false;
      } else if (!isMultiMode && selection?.kind === 'point' && activePoint) {
        setTextDraft(activePoint.mark);
        draftValueRef.current = activePoint.mark;
        draftDirtyRef.current = false;
      } else if (!isMultiMode && selection?.kind === 'tier' && activeTier) {
        setTierNameInput(activeTier.name);
        tierNameDraftRef.current = {
          tierIndex: selection.tierIndex,
          origName: activeTier.name,
          val: activeTier.name
        };
      } else {
        tierNameDraftRef.current = { tierIndex: -1, origName: '', val: '' };
      }
    }, [
      isMultiMode,
      selection,
      activeInterval?.text,
      activePoint?.mark,
      activeTier?.name,
      commitDraftTarget
    ]);

    // Live Praat \xx trigraph preview for interval / point text drafts
    useEffect(() => {
      if (isMultiMode || (selection?.kind !== 'interval' && selection?.kind !== 'point')) {
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
    }, [isMultiMode, selection?.kind, textDraft]);

    // Unified synchronous QA diagnostics
    const qaScan = useMemo(() => scanTextGridQa(tg), [tg]);

    // Imperative handle for IpaDock & draft flushing
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
          const td = tierNameDraftRef.current;
          if (td.tierIndex >= 0 && td.val !== td.origName) {
            const st = useEditorStore.getState();
            const tier = st.tg.tiers[td.tierIndex];
            if (tier && tier.name !== td.val) {
              const nextName = td.val;
              const prevName = tier.name;
              td.origName = nextName;
              st.commitTgMutation(
                (_d, ctx) => {
                  const dTier = ctx.editTier(td.tierIndex);
                  if (!dTier || dTier.name === nextName) return false;
                  dTier.name = nextName;
                },
                undefined,
                {
                  type: 'rename-tier',
                  title: '重命名层级',
                  detail: `${formatQuote(prevName)}→${formatQuote(nextName)}`,
                  icon: 'edit',
                  tierName: formatTierLabel(nextName, td.tierIndex)
                }
              );
            }
          }
        }
      }),
      [ipaIme]
    );

    // Acoustic stats
    const intervalAcoustic = useMemo(() => {
      if (isMultiMode || selection?.kind !== 'interval' || !activeInterval) return null;
      return computeAcousticStats(
        analysis,
        effectiveAudioBuffer,
        audioOffset,
        activeInterval.xmin,
        activeInterval.xmax
      );
    }, [
      isMultiMode,
      selection?.kind,
      activeInterval?.xmin,
      activeInterval?.xmax,
      analysis,
      effectiveAudioBuffer,
      audioOffset
    ]);

    const rangeAcoustic = useMemo(() => {
      if (isMultiMode || selection !== null || !playRange || playRange.end <= playRange.start) {
        return null;
      }
      return computeAcousticStats(
        analysis,
        effectiveAudioBuffer,
        audioOffset,
        playRange.start,
        playRange.end
      );
    }, [
      isMultiMode,
      selection,
      playRange?.start,
      playRange?.end,
      analysis,
      effectiveAudioBuffer,
      audioOffset
    ]);

    const pointInstantAcoustic = useMemo(() => {
      if (isMultiMode || selection?.kind !== 'point' || !activePoint) return null;
      return computeInstantAcoustic(analysis, activePoint.number);
    }, [isMultiMode, selection?.kind, activePoint?.number, analysis]);

    // Nearest zero crossing for boundary / spine / point wave view
    const waveFocusTime =
      !isMultiMode && (selection?.kind === 'boundary' || selection?.kind === 'spine')
        ? selection.time
        : !isMultiMode && selection?.kind === 'point' && activePoint
          ? activePoint.number
          : null;

    const nearestZeroForWave = useMemo(() => {
      if (waveFocusTime === null) return null;
      return findNearestZeroCrossingLocal(effectiveAudioBuffer, audioOffset, waveFocusTime, 0.015);
    }, [effectiveAudioBuffer, audioOffset, waveFocusTime]);

    // Aligned block for single interval
    const alignedBlock = useMemo(() => {
      if (isMultiMode || selection?.kind !== 'interval' || !activeInterval) return null;
      const blk = findAlignedBlock(
        tg,
        {
          xmin: activeInterval.xmin,
          xmax: activeInterval.xmax,
          tierIndex: selection.tierIndex,
          itemIndex: selection.itemIndex
        },
        hiddenTierIndices
      );
      if (!blk) return null;
      if (blk.intervalSlices.length <= 1 && blk.pointSlices.length === 0) return null;
      return blk;
    }, [isMultiMode, selection, activeInterval, tg, hiddenTierIndices]);

    const alignedBlockSafeBounds = useMemo(() => {
      if (!alignedBlock) return null;
      return computeBlockSafeBounds(tg, alignedBlock);
    }, [tg, alignedBlock]);

    // Peer texts for smart split
    const activeTierPeerTexts = useMemo(() => {
      if (isMultiMode || selection?.kind !== 'interval' || !activeTier || activeTier.kind !== 'intervalTier') {
        return [];
      }
      const peers: string[] = [];
      for (let i = 0; i < activeTier.intervals.length; i++) {
        if (i === selection.itemIndex) continue;
        const txt = activeTier.intervals[i].text.trim();
        if (txt) {
          peers.push(txt);
          if (peers.length >= 24) break;
        }
      }
      return peers;
    }, [isMultiMode, selection, activeTier]);

    // Clipboard helpers
    const copyTextValue = (text: string, label: string) => {
      void getPlatformBridge()
        .writeClipboardText(text)
        .then(() => showToast(`已复制${label}`))
        .catch(() => showToast('剪贴板写入受限', true));
    };

    const copyAcousticTsv = (
      stats: AcousticStats,
      tMin: number,
      tMax: number,
      label?: string
    ) => {
      const durSec = Math.max(0, tMax - tMin);
      const showMidFormants = durSec <= 0.3;
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
      copyTextValue(cols.join('\t'), '声学数据（制表符分隔）');
    };

    const copyPointAcousticTsv = (
      stats: InstantAcousticStats,
      timeSec: number,
      mark: string
    ) => {
      const cols = [
        mark.replace(/[\t\r\n]+/g, ' '),
        formatPraatDouble(timeSec),
        stats.f0 !== null ? stats.f0.toFixed(1) : '',
        stats.f1 !== null ? stats.f1.toFixed(0) : '',
        stats.f2 !== null ? stats.f2.toFixed(0) : '',
        stats.f3 !== null ? stats.f3.toFixed(0) : ''
      ];
      copyTextValue(cols.join('\t'), '标点声学数据（制表符分隔）');
    };

    // Resolve zero crossing via bridge or local fallback
    const resolveNearestZero = async (targetTime: number): Promise<number | null> => {
      if (analysis) {
        try {
          const snapped = round6(
            await getPlatformBridge().findZeroCrossing(analysis.sessionId, targetTime, 0.015)
          );
          if (Number.isFinite(snapped)) return snapped;
        } catch {
          // fallback to local PCM search
        }
      }
      return findNearestZeroCrossingLocal(effectiveAudioBuffer, audioOffset, targetTime, 0.015);
    };

    // Boundary or spine timestamp mutation
    const updateBoundaryOrSpineTime = (
      targetVal: number,
      snapKind?: boolean | 'zero' | 'acoustic'
    ): boolean => {
      if (isReadOnly) return false;
      if (!selection || (selection.kind !== 'boundary' && selection.kind !== 'spine')) return false;
      const val = round6(targetVal);
      if (!Number.isFinite(val) || Math.abs(val - selection.time) < 1e-9) {
        return false;
      }
      const moveOpts =
        snapKind === true || snapKind === 'zero'
          ? {
              coalesce: false,
              actionMeta: { type: 'snap-zero-crossing' as const }
            }
          : snapKind === 'acoustic'
            ? {
                coalesce: false,
                actionMeta: { type: 'snap-acoustic-edge' as const }
              }
            : undefined;
      if (selection.kind === 'boundary') {
        return moveTierBoundary(selection.tierIndex, selection.time, val, boundaryShared, {
          ...moveOpts,
          nextSelection: {
            kind: 'boundary',
            tierIndex: selection.tierIndex,
            time: val,
            bandIndex: selection.bandIndex
          }
        });
      }
      return moveSharedTimestamp(selection.time, val, {
        ...moveOpts,
        nextSelection: {
          kind: 'spine',
          time: val,
          bandIndex: selection.bandIndex
        }
      });
    };

    const handleSnapBoundaryZero = async () => {
      if (isReadOnly || !selection || (selection.kind !== 'boundary' && selection.kind !== 'spine')) {
        return;
      }
      const snapped = await resolveNearestZero(selection.time);
      if (snapped === null) {
        showToast('未检测到附近过零点', true);
        return;
      }
      if (Math.abs(snapped - selection.time) < 1e-7) {
        showToast('当前位置已位于最近过零点');
        return;
      }
      if (updateBoundaryOrSpineTime(snapped, 'zero')) {
        showToast(`已吸附至最近过零点 (${snapped.toFixed(6)} s)`);
      }
    };

    const handleSnapBoundaryAcoustic = async () => {
      if (isReadOnly || !selection || (selection.kind !== 'boundary' && selection.kind !== 'spine')) {
        return;
      }
      if (!effectiveAudioBuffer) {
        showToast('请先载入录音以使用声学边界吸附');
        return;
      }
      try {
        const res = await snapBoundaryAcoustically(
          effectiveAudioBuffer,
          audioOffset,
          selection.time,
          0.045
        );
        if (!res.found) {
          showToast('附近未检测到明显声学边界');
          return;
        }
        const snapped = round6(res.snappedTimeSec);
        if (Math.abs(snapped - selection.time) < 1e-6) {
          showToast('当前位置已位于最近声学边界');
          return;
        }
        if (updateBoundaryOrSpineTime(snapped, 'acoustic')) {
          showToast(formatAcousticSnapToast(selection.time, snapped));
        }
      } catch {
        showToast('声学边界吸附失败', true);
      }
    };

    const handleSnapIntervalEdgeZero = async (which: 'start' | 'end') => {
      if (isReadOnly || selection?.kind !== 'interval' || !activeInterval) return;
      const origT = which === 'start' ? activeInterval.xmin : activeInterval.xmax;
      const snapped = await resolveNearestZero(origT);
      if (snapped === null) {
        showToast('未检测到附近过零点', true);
        return;
      }
      if (Math.abs(snapped - origT) < 1e-7) {
        showToast('该边界已位于最近过零点');
        return;
      }
      const ok =
        which === 'start'
          ? updateIntervalBoundsWithAnchor(
              selection.tierIndex,
              selection.itemIndex,
              { xmin: snapped },
              'end',
              linkAdjacent
            )
          : updateIntervalBoundsWithAnchor(
              selection.tierIndex,
              selection.itemIndex,
              { xmax: snapped },
              'start',
              linkAdjacent
            );
      if (ok) {
        showToast(`已将${which === 'start' ? '起点' : '终点'}吸附至过零点 (${snapped.toFixed(6)} s)`);
      }
    };

    const handleSnapIntervalEdgeAcoustic = async (which: 'start' | 'end') => {
      if (isReadOnly || selection?.kind !== 'interval' || !activeInterval) return;
      if (!effectiveAudioBuffer) {
        showToast('请先载入录音以使用声学边界吸附');
        return;
      }
      const origT = which === 'start' ? activeInterval.xmin : activeInterval.xmax;
      try {
        const res = await snapBoundaryAcoustically(effectiveAudioBuffer, audioOffset, origT, 0.045);
        if (!res.found) {
          showToast('附近未检测到明显声学边界');
          return;
        }
        const snapped = round6(res.snappedTimeSec);
        if (Math.abs(snapped - origT) < 1e-6) {
          showToast('该边界已位于最近声学边界');
          return;
        }
        const ok =
          which === 'start'
            ? updateIntervalBoundsWithAnchor(
                selection.tierIndex,
                selection.itemIndex,
                { xmin: snapped },
                'end',
                linkAdjacent
              )
            : updateIntervalBoundsWithAnchor(
                selection.tierIndex,
                selection.itemIndex,
                { xmax: snapped },
                'start',
                linkAdjacent
              );
        if (ok) {
          showToast(
            formatAcousticSnapToast(
              origT,
              snapped,
              which === 'start' ? '已将起点吸附至声学边界' : '已将终点吸附至声学边界'
            )
          );
        }
      } catch {
        showToast('声学边界吸附失败', true);
      }
    };

    const handleSnapPointZero = async () => {
      if (isReadOnly || selection?.kind !== 'point' || !activePoint) return;
      const snapped = await resolveNearestZero(activePoint.number);
      if (snapped === null) {
        showToast('未检测到附近过零点', true);
        return;
      }
      if (Math.abs(snapped - activePoint.number) < 1e-7) {
        showToast('当前标点已位于最近过零点');
        return;
      }
      if (movePointToTime(selection.tierIndex, selection.itemIndex, snapped, '吸附过零点')) {
        showToast(`已吸附至最近过零点 (${snapped.toFixed(6)} s)`);
      }
    };

    const handleSnapPointAcoustic = async () => {
      if (isReadOnly || selection?.kind !== 'point' || !activePoint) return;
      if (!effectiveAudioBuffer) {
        showToast('请先载入录音以使用声学边界吸附');
        return;
      }
      try {
        const res = await snapBoundaryAcoustically(
          effectiveAudioBuffer,
          audioOffset,
          activePoint.number,
          0.045
        );
        if (!res.found) {
          showToast('附近未检测到明显声学边界');
          return;
        }
        const snapped = round6(res.snappedTimeSec);
        if (Math.abs(snapped - activePoint.number) < 1e-6) {
          showToast('当前标点已位于最近声学边界');
          return;
        }
        if (movePointToTime(selection.tierIndex, selection.itemIndex, snapped, '吸附声学边界')) {
          showToast(formatAcousticSnapToast(activePoint.number, snapped));
        }
      } catch {
        showToast('声学边界吸附失败', true);
      }
    };

    const handleSnapPointNearestBoundary = () => {
      if (isReadOnly || selection?.kind !== 'point' || !activePoint) return;
      const allBnds = collectAllInteriorBoundaries(tg);
      if (allBnds.length === 0) {
        showToast('文档中暂无可吸附的区间边界', true);
        return;
      }
      let bestT: number | null = null;
      let bestDist = Infinity;
      for (const t of allBnds) {
        const d = Math.abs(t - activePoint.number);
        if (d < bestDist) {
          bestDist = d;
          bestT = t;
        }
      }
      if (bestT === null) return;
      if (bestDist < 1e-7) {
        showToast('当前标点已对齐该边界');
        return;
      }
      if (movePointToTime(selection.tierIndex, selection.itemIndex, bestT, '吸附附近边界')) {
        showToast(`已吸附至最近边界 (${bestT.toFixed(4)} s)`);
      }
    };

    const handleMovePointIntervalMid = () => {
      if (isReadOnly || selection?.kind !== 'point' || !activePoint) return;
      const t = activePoint.number;
      let bestMid: number | null = null;
      let bestLabel = '';
      for (let ti = 0; ti < tg.tiers.length; ti++) {
        const tier = tg.tiers[ti];
        if (tier.kind !== 'intervalTier') continue;
        const iv = tier.intervals.find((x) => t >= x.xmin - 1e-9 && t <= x.xmax + 1e-9 && x.xmax > x.xmin);
        if (!iv) continue;
        const mid = round6((iv.xmin + iv.xmax) * 0.5);
        if (iv.text.trim() !== '') {
          bestMid = mid;
          bestLabel = tier.name || `第 ${ti + 1} 层`;
          break;
        }
        if (bestMid === null) {
          bestMid = mid;
          bestLabel = tier.name || `第 ${ti + 1} 层`;
        }
      }
      if (bestMid === null) {
        showToast('未找到包含此标点的区间', true);
        return;
      }
      if (Math.abs(bestMid - t) < 1e-7) {
        showToast('标点已位于区间中点');
        return;
      }
      if (movePointToTime(selection.tierIndex, selection.itemIndex, bestMid, '移到区间中点')) {
        showToast(`已移至「${bestLabel}」所属区间中点 (${bestMid.toFixed(4)} s)`);
      }
    };

    // Smart split apply handler (inline card)
    const handleApplyInlineSmartSplit = useCallback(
      async (candidate: SmartSplitCandidate, useAcoustic: boolean) => {
        if (isReadOnly) return;
        const st = useEditorStore.getState();
        const sel = st.selection;
        if (sel?.kind !== 'interval') return;
        const ti = sel.tierIndex;
        const ii = sel.itemIndex;
        const tier = st.tg.tiers[ti];
        if (!tier || tier.kind !== 'intervalTier') return;
        const iv = tier.intervals[ii];
        if (!iv || iv.xmax <= iv.xmin || candidate.texts.length < 2) return;

        flushPendingRef.current();

        const snapshot = { xmin: iv.xmin, xmax: iv.xmax, text: iv.text };
        const startTabId = st.activeTabId;
        const startCorpusId = st.corpusActiveEntryId;
        const seq = ++splitRunSeqRef.current;

        let cuts: number[] | null = null;
        let usedAcoustic = false;

        if (useAcoustic && effectiveAudioBuffer) {
          try {
            const res = await alignSplitBoundariesAcoustically({
              audioBuffer: effectiveAudioBuffer,
              xmin: snapshot.xmin,
              xmax: snapshot.xmax,
              granularity: candidate.granularity,
              durationWeights: candidate.durationWeights,
              acousticClasses: candidate.acousticClasses
            });
            if (res && res.usedAcoustic && res.cuts.length === candidate.texts.length - 1) {
              cuts = res.cuts;
              usedAcoustic = true;
            }
          } catch {
            cuts = null;
            usedAcoustic = false;
          }

          if (seq !== splitRunSeqRef.current) return;
          const latest = useEditorStore.getState();
          if (latest.activeTabId !== startTabId || latest.corpusActiveEntryId !== startCorpusId) {
            return;
          }
          const curIv = latest.tg.tiers[ti]?.intervals[ii];
          if (
            !curIv ||
            curIv.xmin !== snapshot.xmin ||
            curIv.xmax !== snapshot.xmax ||
            curIv.text !== snapshot.text
          ) {
            return;
          }
        }

        const modeWord = usedAcoustic ? '声学拆分为' : '拆分为';
        splitIntervalWithCuts(ti, ii, candidate.texts, cuts, {
          title: `智能拆分（${candidate.strategyLabel}）`,
          detailPrefix: `${candidate.strategyLabel}${modeWord}`,
          toastLabel: `已${candidate.strategyLabel}${modeWord}`
        });
      },
      [isReadOnly, effectiveAudioBuffer, splitIntervalWithCuts]
    );

    // Create interval from playRange on a target interval tier
    const handleCreateIntervalFromPlayRange = (tierIndex: number) => {
      if (isReadOnly || !playRange || playRange.end <= playRange.start) return;
      const tier = tg.tiers[tierIndex];
      if (!tier || tier.kind !== 'intervalTier') return;
      const eps = 1e-6;
      const a = round6(Math.max(tier.xmin, Math.min(tier.xmax, playRange.start)));
      const b = round6(Math.max(tier.xmin, Math.min(tier.xmax, playRange.end)));
      if (b <= a + 1e-5) {
        showToast('选区超出该层范围或时长过短', true);
        return;
      }
      const tierName = formatTierLabel(tier.name, tierIndex);
      const ok = commitTgMutation(
        (_draft, ctx) => {
          const dTier = ctx.editTier(tierIndex);
          if (!dTier || dTier.kind !== 'intervalTier') return false;
          const ivs = dTier.intervals;

          // Split any interval strictly containing a
          for (let i = 0; i < ivs.length; i++) {
            const iv = ivs[i];
            if (iv.xmin < a - eps && iv.xmax > a + eps) {
              ivs.splice(i + 1, 0, { xmin: a, xmax: iv.xmax, text: '' });
              iv.xmax = a;
              break;
            }
          }
          // Split any interval strictly containing b
          for (let i = 0; i < ivs.length; i++) {
            const iv = ivs[i];
            if (iv.xmin < b - eps && iv.xmax > b + eps) {
              ivs.splice(i + 1, 0, { xmin: b, xmax: iv.xmax, text: '' });
              iv.xmax = b;
              break;
            }
          }

          // Collect intervals inside [a, b]
          let firstInside = -1;
          let lastInside = -1;
          for (let i = 0; i < ivs.length; i++) {
            if (ivs[i].xmin >= a - eps && ivs[i].xmax <= b + eps) {
              if (firstInside === -1) firstInside = i;
              lastInside = i;
            }
          }

          let targetIdx = 0;
          if (firstInside !== -1 && lastInside >= firstInside) {
            const mergedText = ivs
              .slice(firstInside, lastInside + 1)
              .map((x) => x.text)
              .filter((t) => t !== '')
              .join(' ');
            ivs.splice(firstInside, lastInside - firstInside + 1, {
              xmin: a,
              xmax: b,
              text: mergedText
            });
            targetIdx = firstInside;
          } else {
            let insertAt = ivs.findIndex((x) => x.xmin >= a - eps);
            if (insertAt === -1) insertAt = ivs.length;
            ivs.splice(insertAt, 0, { xmin: a, xmax: b, text: '' });
            targetIdx = insertAt;
          }

          ctx.setNextSelection({ kind: 'interval', tierIndex, itemIndex: targetIdx });
        },
        undefined,
        {
          type: 'create-interval',
          title: '按选区新建区间',
          detail: `${tierName} · ${formatTimeSec(a)}–${formatTimeSec(b)}`,
          icon: 'createFromRange',
          tierName,
          focusTime: a
        }
      );
      if (ok) {
        showToast(`已在「${tierName}」创建区间`);
      }
    };

    // QA navigation & fixes
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
      const tierName = formatTierLabel(issue.tierName, ti);
      if (issue.fixableKind === 'space-interval') {
        const ok = commitTgMutation(
          (_draft, ctx) => {
            const dTier = ctx.editTier(ti);
            const target = dTier?.intervals[idx];
            if (!target) return false;
            const trimmed = target.text.trim();
            if (trimmed === target.text) return false;
            target.text = trimmed;
          },
          undefined,
          {
            type: 'qa-trim-space',
            title: '清理首尾空格',
            detail: `${tierName} · ${formatTimeSec(issue.time)}`,
            icon: 'clear',
            tierName,
            focusTime: issue.time
          }
        );
        if (ok) showToast('已清理该区间首尾空格');
      } else if (issue.fixableKind === 'space-point') {
        const ok = commitTgMutation(
          (_draft, ctx) => {
            const dTier = ctx.editTier(ti);
            const target = dTier?.points[idx];
            if (!target) return false;
            const trimmed = target.mark.trim();
            if (trimmed === target.mark) return false;
            target.mark = trimmed;
          },
          undefined,
          {
            type: 'qa-trim-space',
            title: '清理首尾空格',
            detail: `${tierName} · ${formatTimeSec(issue.time)}`,
            icon: 'clear',
            tierName,
            focusTime: issue.time
          }
        );
        if (ok) showToast('已清理该标点首尾空格');
      }
    };

    const handleSingleRowQaFix = (issue: QaIssue) => {
      if (isReadOnly) return;
      const ti = issue.tierIndex;
      const eps = 1e-9;
      const tierName = formatTierLabel(issue.tierName, ti);

      if (issue.fixableKind === 'micro-cross') {
        const res = alignMicroBoundaries(ti);
        const fb = formatAlignMicroFeedback(res, issue.tierName);
        showToast(fb.message, fb.isError);
        return;
      }

      if (issue.fixableKind === 'space-interval' || issue.fixableKind === 'space-point') {
        handleTrimQaSpace(issue);
        return;
      }

      if (issue.fixableKind === 'zero-delete' && issue.itemIndex !== undefined) {
        const ii = issue.itemIndex;
        const ok = commitTgMutation(
          (_draft, ctx) => {
            const dTier = ctx.editTier(ti);
            if (!dTier || dTier.kind !== 'intervalTier') return false;
            const iv = dTier.intervals[ii];
            if (!iv || iv.xmax - iv.xmin > 1e-12) return false;
            dTier.intervals.splice(ii, 1);
            ctx.setNextSelection(null);
          },
          undefined,
          {
            type: 'delete-zero-interval',
            title: '删除零时长区间',
            detail: `${tierName} · ${formatTimeSec(issue.time)}`,
            icon: 'trash',
            tierName,
            focusTime: issue.time
          }
        );
        if (ok) showToast('已删除该零时长区间');
        return;
      }

      if (issue.fixableKind === 'gap-fill') {
        const ok = commitTgMutation(
          (_draft, ctx) => {
            const dTier = ctx.editTier(ti);
            if (!dTier || dTier.kind !== 'intervalTier') return false;
            const ivs = dTier.intervals;
            let insertedIdx = 0;
            let didInsert = false;
            if (ivs.length === 0) {
              if (dTier.xmax > dTier.xmin + eps) {
                ivs.push({ xmin: dTier.xmin, xmax: dTier.xmax, text: '' });
                insertedIdx = 0;
                didInsert = true;
              }
            } else if (issue.itemIndex === 0 && ivs[0].xmin > dTier.xmin + eps) {
              ivs.unshift({ xmin: dTier.xmin, xmax: ivs[0].xmin, text: '' });
              insertedIdx = 0;
              didInsert = true;
            } else if (issue.itemIndex === ivs.length && ivs[ivs.length - 1].xmax < dTier.xmax - eps) {
              ivs.push({ xmin: ivs[ivs.length - 1].xmax, xmax: dTier.xmax, text: '' });
              insertedIdx = ivs.length - 1;
              didInsert = true;
            } else {
              const ii = issue.itemIndex;
              if (ii !== undefined && ii > 0 && ii < ivs.length) {
                const prev = ivs[ii - 1];
                const cur = ivs[ii];
                if (cur.xmin > prev.xmax + eps) {
                  ivs.splice(ii, 0, { xmin: prev.xmax, xmax: cur.xmin, text: '' });
                  insertedIdx = ii;
                  didInsert = true;
                }
              }
            }
            if (!didInsert) return false;
            ctx.setNextSelection({ kind: 'interval', tierIndex: ti, itemIndex: insertedIdx });
          },
          undefined,
          {
            type: 'qa-fix-gap',
            title: '补齐区间空隙',
            detail: `${tierName} · ${formatTimeSec(issue.time)}`,
            icon: 'normalize',
            tierName,
            focusTime: issue.time
          }
        );
        if (ok) showToast('已插入空白区间填补空隙');
        return;
      }

      if (issue.fixableKind === 'overlap-resolve' && issue.itemIndex !== undefined) {
        const ii = issue.itemIndex;
        const ok = commitTgMutation(
          (_draft, ctx) => {
            const dTier = ctx.editTier(ti);
            if (!dTier || dTier.kind !== 'intervalTier' || ii < 1 || ii >= dTier.intervals.length) {
              return false;
            }
            const prev = dTier.intervals[ii - 1];
            const cur = dTier.intervals[ii];
            if (!(prev.xmax > cur.xmin + eps)) return false;

            const oldPrevXmax = prev.xmax;
            if (cur.xmin <= prev.xmin + eps && cur.xmax <= oldPrevXmax + eps) {
              if (!prev.text && cur.text) prev.text = cur.text;
              dTier.intervals.splice(ii, 1);
              ctx.setNextSelection({ kind: 'interval', tierIndex: ti, itemIndex: Math.max(0, ii - 1) });
              return;
            }

            let cut: number;
            if (!prev.text && cur.text && cur.xmin > prev.xmin + eps) {
              cut = cur.xmin;
            } else if (prev.text && !cur.text && oldPrevXmax < cur.xmax - eps) {
              cut = oldPrevXmax;
            } else {
              const ovLo = Math.max(prev.xmin, cur.xmin);
              const ovHi = Math.min(oldPrevXmax, cur.xmax);
              cut = Number(((ovLo + ovHi) / 2).toFixed(6));
            }
            cut = Math.max(prev.xmin + 1e-6, Math.min(cur.xmax - 1e-6, cut));
            if (!(cut > prev.xmin + eps && cut < cur.xmax - eps)) return false;

            prev.xmax = cut;
            cur.xmin = cut;
            if (oldPrevXmax > cur.xmax + eps) {
              dTier.intervals.splice(ii + 1, 0, {
                xmin: cur.xmax,
                xmax: oldPrevXmax,
                text: ''
              });
            }
            ctx.setNextSelection({ kind: 'interval', tierIndex: ti, itemIndex: Math.max(0, ii - 1) });
          },
          undefined,
          {
            type: 'qa-fix-overlap',
            title: '消解区间重叠',
            detail: `${tierName} · ${formatTimeSec(issue.time)}`,
            icon: 'normalize',
            tierName,
            focusTime: issue.time
          }
        );
        if (ok) showToast('已消解该处重叠边界');
        return;
      }

      if (issue.fixableKind === 'ood-tier') {
        const ok = commitTgMutation(
          (draft, ctx) => {
            const dTier = ctx.editTier(ti);
            if (!dTier) return false;
            const gMin = draft.xmin;
            const gMax = draft.xmax;
            dTier.xmin = gMin;
            dTier.xmax = gMax;
            if (dTier.kind === 'intervalTier') {
              const kept = [];
              for (const iv of dTier.intervals) {
                if (!Number.isFinite(iv.xmin) || !Number.isFinite(iv.xmax)) continue;
                const a = Math.max(gMin, Math.min(gMax, iv.xmin));
                const b = Math.max(a, Math.min(gMax, iv.xmax));
                if (b > a + 1e-12 || (iv.xmin === iv.xmax && a >= gMin && a <= gMax)) {
                  kept.push({ xmin: a, xmax: b, text: iv.text });
                }
              }
              dTier.intervals = kept;
            } else {
              dTier.points = dTier.points.filter(
                (p) => Number.isFinite(p.number) && p.number >= gMin && p.number <= gMax
              );
            }
            ctx.setNextSelection({ kind: 'tier', tierIndex: ti });
          },
          undefined,
          {
            type: 'qa-fix-ood',
            title: '对齐越界层级',
            detail: `${tierName} · ${formatTimeSec(tg.xmin)}–${formatTimeSec(tg.xmax)}`,
            icon: 'normalize',
            tierName,
            focusTime: tg.xmin
          }
        );
        if (ok) showToast(`已将「${issue.tierName}」起止范围对齐至文档全局范围`);
      }
    };

    // Issues specifically matching the currently selected object
    const objectIssues = useMemo<QaIssue[]>(() => {
      if (qaScan.issues.length === 0) return [];
      if (isMultiMode && multiAnalysis) {
        const keySet = new Set(multiAnalysis.items.map((it) => `${it.tierIndex}:${it.itemIndex}`));
        return qaScan.issues.filter(
          (iss) =>
            iss.targetSelection?.kind === 'interval' &&
            keySet.has(`${iss.targetSelection.tierIndex}:${iss.targetSelection.itemIndex}`)
        );
      }
      if (!selection) return [];
      if (selection.kind === 'interval' && activeInterval) {
        return qaScan.issues.filter((iss) => {
          if (
            iss.targetSelection?.kind === 'interval' &&
            iss.targetSelection.tierIndex === selection.tierIndex &&
            iss.targetSelection.itemIndex === selection.itemIndex
          ) {
            return true;
          }
          if (
            iss.fixableKind === 'micro-cross' &&
            iss.tierIndex === selection.tierIndex &&
            (Math.abs(iss.time - activeInterval.xmin) < 1e-6 ||
              Math.abs(iss.time - activeInterval.xmax) < 1e-6)
          ) {
            return true;
          }
          return false;
        });
      }
      if (selection.kind === 'point') {
        return qaScan.issues.filter(
          (iss) =>
            iss.targetSelection?.kind === 'point' &&
            iss.targetSelection.tierIndex === selection.tierIndex &&
            iss.targetSelection.itemIndex === selection.itemIndex
        );
      }
      if (selection.kind === 'boundary') {
        return qaScan.issues.filter(
          (iss) =>
            iss.tierIndex === selection.tierIndex && Math.abs(iss.time - selection.time) < 1e-6
        );
      }
      if (selection.kind === 'spine') {
        return qaScan.issues.filter((iss) => Math.abs(iss.time - selection.time) < 1e-6);
      }
      if (selection.kind === 'tier') {
        return qaScan.issues.filter((iss) => iss.tierIndex === selection.tierIndex);
      }
      return [];
    }, [qaScan.issues, isMultiMode, multiAnalysis, selection, activeInterval]);

    const renderObjectIssueBar = () => {
      if (objectIssues.length === 0) return null;
      const primaryIssue = objectIssues.find((i) => Boolean(i.fixableKind)) ?? objectIssues[0];
      const extraCount = objectIssues.length - 1;
      return (
        <div className="insp-issue-bar" role="status">
          <span className="insp-issue-text" title={objectIssues.map((i) => i.detail).join('；')}>
            {primaryIssue.detail}
            {extraCount > 0 ? `（另有 ${extraCount} 项问题）` : ''}
          </span>
          {!isReadOnly && primaryIssue.fixableKind && (
            <button
              type="button"
              className="insp-btn"
              onClick={() => handleSingleRowQaFix(primaryIssue)}
            >
              一键修复
            </button>
          )}
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

    // Shared top object header renderer
    const renderObjectHeader = (opts: {
      accentClass: string;
      accentColor: string;
      typeLabel: string;
      title: string;
      sub?: string;
      stepper?: {
        current: number;
        total: number;
        onPrev: () => void;
        onNext: () => void;
        prevDisabled?: boolean;
        nextDisabled?: boolean;
        prevTitle?: string;
        nextTitle?: string;
      };
    }) => (
      <header
        className={`insp-id-head ${opts.accentClass}`}
        style={{ '--insp-accent': opts.accentColor } as React.CSSProperties}
      >
        <span className="insp-id-accent" aria-hidden="true" />
        <div className="insp-id-meta">
          <div className="insp-id-top">
            <span className="insp-id-type">{opts.typeLabel}</span>
            <span className="insp-id-title" title={opts.title}>
              {opts.title}
            </span>
          </div>
          {opts.sub && (
            <span className="insp-id-sub" title={opts.sub}>
              {opts.sub}
            </span>
          )}
        </div>
        {opts.stepper && opts.stepper.total > 0 && (
          <div className="insp-stepper" role="group" aria-label="切换上一项或下一项">
            <button
              type="button"
              disabled={opts.stepper.prevDisabled ?? opts.stepper.current <= 1}
              title={opts.stepper.prevTitle ?? '上一项'}
              aria-label={opts.stepper.prevTitle ?? '上一项'}
              onClick={opts.stepper.onPrev}
            >
              ‹
            </button>
            <span className="insp-stepper-count">
              {opts.stepper.current} / {opts.stepper.total}
            </span>
            <button
              type="button"
              disabled={opts.stepper.nextDisabled ?? opts.stepper.current >= opts.stepper.total}
              title={opts.stepper.nextTitle ?? '下一项'}
              aria-label={opts.stepper.nextTitle ?? '下一项'}
              onClick={opts.stepper.onNext}
            >
              ›
            </button>
          </div>
        )}
      </header>
    );

    // =========================================================================
    // STATE 1: MULTI-SELECTION (multiSelection.length >= 2 — takes priority!)
    // =========================================================================
    if (isMultiMode && multiAnalysis && multiAnalysis.count >= 2) {
      const envDur = Math.max(0, multiAnalysis.envelopeXmax - multiAnalysis.envelopeXmin);
      const kindLabel = formatMultiKindLabel(multiAnalysis.topology);

      // Group selected intervals by tier
      const groupedByTier = new Map<number, number[]>();
      for (const item of multiAnalysis.items) {
        let arr = groupedByTier.get(item.tierIndex);
        if (!arr) {
          arr = [];
          groupedByTier.set(item.tierIndex, arr);
        }
        arr.push(item.itemIndex);
      }
      const sortedTierIndices = Array.from(groupedByTier.keys()).sort((a, b) => a - b);
      for (const ti of sortedTierIndices) {
        groupedByTier.get(ti)!.sort((a, b) => a - b);
      }

      const orderedItems = sortedTierIndices.flatMap((ti) =>
        groupedByTier.get(ti)!.map((ii) => ({ tierIndex: ti, itemIndex: ii }))
      );
      const primaryPos = multiAnalysis.primary
        ? orderedItems.findIndex(
            (x) =>
              x.tierIndex === multiAnalysis.primary!.tierIndex &&
              x.itemIndex === multiAnalysis.primary!.itemIndex
          )
        : 0;

      const stepMultiPrimary = (delta: -1 | 1) => {
        if (orderedItems.length === 0) return;
        const base = primaryPos >= 0 ? primaryPos : 0;
        const nextIdx = (base + delta + orderedItems.length) % orderedItems.length;
        const nextRef = orderedItems[nextIdx];
        setMultiSelectionPrimary(nextRef);
        const iv = tg.tiers[nextRef.tierIndex]?.intervals[nextRef.itemIndex];
        if (iv) setPlaybackTime(iv.xmin, true);
      };

      const syncBounds = computeMultiSyncDeltaBounds(tg, multiAnalysis.units, multiSyncAction);
      const minDeltaMs = syncBounds.minDelta * 1000;
      const maxDeltaMs = syncBounds.maxDelta * 1000;
      const canSyncShift =
        !isReadOnly && (maxDeltaMs - minDeltaMs > 0.01 || Math.abs(minDeltaMs) > 0.01 || Math.abs(maxDeltaMs) > 0.01);

      const blockerNames: string[] = [];
      if (syncBounds.leftBlockerTierName && Math.abs(minDeltaMs) < 0.05) {
        blockerNames.push(`左侧受阻：${syncBounds.leftBlockerTierName}`);
      }
      if (syncBounds.rightBlockerTierName && Math.abs(maxDeltaMs) < 0.05) {
        blockerNames.push(`右侧受阻：${syncBounds.rightBlockerTierName}`);
      }

      const canApplyTargetRange =
        !isReadOnly &&
        Number.isFinite(multiTargetStart) &&
        Number.isFinite(multiTargetEnd) &&
        multiTargetEnd > multiTargetStart + 1e-5;

      const mergedPreviewText =
        multiAnalysis.capabilities.canMerge && multiAnalysis.units.length === 1
          ? (() => {
              const u = multiAnalysis.units[0];
              const tier = tg.tiers[u.tierIndex];
              if (!tier || tier.kind !== 'intervalTier') return '';
              return tier.intervals
                .slice(u.startItemIndex, u.endItemIndex + 1)
                .map((iv) => iv.text)
                .filter((t) => t !== '')
                .join(' ');
            })()
          : '';

      const applyMultiSyncDeltaMs = (deltaMs: number): boolean => {
        if (isReadOnly || !Number.isFinite(deltaMs) || Math.abs(deltaMs) < 1e-4) return false;
        const ok = syncTransformMultiSelection(multiSyncAction, deltaMs / 1000);
        if (ok) setDeltaResetTick((t) => t + 1);
        return ok;
      };

      return (
        <div className="insp-root">
          {renderObjectHeader({
            accentClass: 'accent-multi',
            accentColor: '#4F46E5',
            typeLabel: '多选',
            title: `已选 ${multiAnalysis.count} 个区间`,
            sub: `${multiAnalysis.tierIndices.length} 层 · 合并时长 ${formatDurationBadge(envDur)}`,
            stepper: {
              current: Math.max(1, primaryPos + 1),
              total: orderedItems.length,
              onPrev: () => stepMultiPrimary(-1),
              onNext: () => stepMultiPrimary(1),
              prevDisabled: orderedItems.length <= 1,
              nextDisabled: orderedItems.length <= 1,
              prevTitle: '切换上一项为主选参考',
              nextTitle: '切换下一项为主选参考'
            }
          })}
          {readOnlyBanner}
          {renderObjectIssueBar()}

          {/* Card 1: 已选区间与主选参考 */}
          <InspectorCard
            title="已选区间与主选参考"
            badge={
              <>
                <span className="insp-badge is-purple">{kindLabel}</span>
                <span className="insp-badge">{formatDurationBadge(envDur)}</span>
              </>
            }
          >
            <div className="insp-multi-list" role="list" aria-label="已选区间清单">
              {sortedTierIndices.map((ti) => {
                const tier = tg.tiers[ti];
                if (!tier || tier.kind !== 'intervalTier') return null;
                const indices = groupedByTier.get(ti)!;
                const tLabel = tier.name || `第 ${ti + 1} 层`;
                return (
                  <React.Fragment key={`mg-${ti}`}>
                    <div className="insp-multi-group-head">
                      <span>{tLabel}</span>
                      <span>{indices.length} 段</span>
                    </div>
                    {indices.map((ii) => {
                      const iv = tier.intervals[ii];
                      if (!iv) return null;
                      const isPrimary =
                        multiAnalysis.primary?.tierIndex === ti &&
                        multiAnalysis.primary?.itemIndex === ii;
                      const ivDur = Math.max(0, iv.xmax - iv.xmin);
                      return (
                        <div
                          key={`mi-${ti}-${ii}`}
                          role="listitem"
                          className={`insp-multi-row is-clickable${isPrimary ? ' is-primary' : ''}`}
                          title="点击设为主选参考项"
                          onClick={() => {
                            setMultiSelectionPrimary({ tierIndex: ti, itemIndex: ii });
                            setPlaybackTime(iv.xmin, true);
                          }}
                        >
                          <div className="insp-multi-row-main">
                            <span className="insp-multi-row-text">
                              {iv.text.trim() ? iv.text : '（空白）'}
                            </span>
                            <span className="insp-multi-row-meta">
                              #{ii + 1} · {iv.xmin.toFixed(3)}–{iv.xmax.toFixed(3)} s ·{' '}
                              {formatShortDur(ivDur)}
                            </span>
                          </div>
                          {isPrimary && <span className="insp-badge is-blue">主选</span>}
                          <button
                            type="button"
                            className="insp-icon-btn"
                            title="移出当前多选"
                            aria-label="移出当前多选"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeFromMultiSelection({ tierIndex: ti, itemIndex: ii });
                            }}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </div>
          </InspectorCard>

          {/* Card 2: 边界对齐 */}
          <InspectorCard title="边界对齐">
            <div className="insp-kv-grid">
              <div className="insp-kv-item is-wide">
                <span className="insp-kv-label">主选范围</span>
                <span className="insp-kv-val">
                  {multiAnalysis.primary
                    ? `${multiAnalysis.primary.xmin.toFixed(3)} – ${multiAnalysis.primary.xmax.toFixed(3)} s`
                    : '—'}
                </span>
              </div>
              <div className="insp-kv-item is-wide">
                <span className="insp-kv-label">合并范围</span>
                <span className="insp-kv-val">
                  {multiAnalysis.envelopeXmin.toFixed(3)} – {multiAnalysis.envelopeXmax.toFixed(3)} s
                </span>
              </div>
            </div>

            <div className="insp-time-grid">
              <div className="insp-time-cell">
                <span className="insp-field-label">目标起点 (s)</span>
                <ScrubNumberInput
                  variant="sidebar"
                  value={multiTargetStart}
                  min={tg.xmin}
                  max={multiTargetEnd}
                  strictMax={true}
                  disabled={isReadOnly}
                  formatValue={formatPraatDouble}
                  onCommit={(val) => {
                    setMultiTargetStart(round6(val));
                    return true;
                  }}
                />
              </div>
              <div className="insp-time-cell">
                <span className="insp-field-label">目标终点 (s)</span>
                <ScrubNumberInput
                  variant="sidebar"
                  value={multiTargetEnd}
                  min={multiTargetStart}
                  strictMin={true}
                  max={tg.xmax}
                  disabled={isReadOnly}
                  formatValue={formatPraatDouble}
                  onCommit={(val) => {
                    setMultiTargetEnd(round6(val));
                    return true;
                  }}
                />
              </div>
            </div>

            {playRange && playRange.end > playRange.start && (
              <button
                type="button"
                className="insp-btn is-xs is-full"
                disabled={isReadOnly}
                onClick={() => {
                  setMultiTargetStart(round6(playRange.start));
                  setMultiTargetEnd(round6(playRange.end));
                }}
              >
                填入当前播放选区 ({playRange.start.toFixed(3)}–{playRange.end.toFixed(3)} s)
              </button>
            )}

            <div className="insp-row-wrap">
              <button
                type="button"
                className="insp-btn is-xs"
                style={{ flex: '1 1 0' }}
                disabled={isReadOnly || !multiAnalysis.capabilities.canAlignBounds}
                title={
                  multiAnalysis.capabilities.canAlignBounds
                    ? '将其他所选区间对齐到主选区间的起止位置'
                    : '仅跨层重叠的多选区间支持对齐到主选'
                }
                onClick={() => alignMultiSelectionBounds('to-primary')}
              >
                对齐到主选
              </button>
              <button
                type="button"
                className="insp-btn is-xs"
                style={{ flex: '1 1 0' }}
                disabled={isReadOnly || !multiAnalysis.capabilities.canAlignBounds}
                title={
                  multiAnalysis.capabilities.canAlignBounds
                    ? '将全部所选区间对齐到当前合并范围'
                    : '仅跨层重叠的多选区间支持对齐到合并范围'
                }
                onClick={() => alignMultiSelectionBounds('to-envelope')}
              >
                对齐到合并范围
              </button>
            </div>
            <button
              type="button"
              className="insp-btn insp-btn-soft is-xs is-full"
              disabled={!canApplyTargetRange}
              onClick={() =>
                alignMultiSelectionBounds('to-range', {
                  start: multiTargetStart,
                  end: multiTargetEnd
                })
              }
            >
              应用目标范围
            </button>
          </InspectorCard>

          {/* Card 3: 同步微调 */}
          <InspectorCard title="同步微调">
            <div className="insp-seg" role="group" aria-label="同步调整方式">
              {(
                [
                  ['move', '整体移动'],
                  ['left-edge', '调左边界'],
                  ['right-edge', '调右边界']
                ] as const
              ).map(([act, lbl]) => (
                <button
                  key={act}
                  type="button"
                  className={multiSyncAction === act ? 'active' : ''}
                  disabled={isReadOnly}
                  onClick={() => setMultiSyncAction(act)}
                >
                  {lbl}
                </button>
              ))}
            </div>

            <div className="insp-kv-item is-wide">
              <span className="insp-kv-label">可移动范围</span>
              <span className="insp-kv-val">
                {minDeltaMs <= -0.05 ? `${minDeltaMs.toFixed(1)}` : '0'} ～ +
                {maxDeltaMs >= 0.05 ? maxDeltaMs.toFixed(1) : '0'} ms
              </span>
            </div>
            {blockerNames.length > 0 && (
              <div className="sb-hint">{blockerNames.join('；')}</div>
            )}

            <div className="insp-time-cell">
              <span className="insp-field-label">毫秒偏移 (ms，回车或拖拽提交)</span>
              <ScrubNumberInput
                key={`multi-sync-delta-${deltaResetTick}-${multiSyncAction}`}
                variant="sidebar"
                value={0}
                min={minDeltaMs}
                max={maxDeltaMs}
                stepSec={1}
                fineStepSec={0.5}
                coarseStepSec={10}
                decimals={1}
                disabled={!canSyncShift}
                onCommit={(valMs) => applyMultiSyncDeltaMs(valMs)}
              />
            </div>

            <div className="insp-nudge-row">
              <div className="insp-nudge-group" role="group" aria-label="微调步长">
                {([1, 5, 10] as const).map((step) => (
                  <button
                    key={step}
                    type="button"
                    className={nudgeStepMs === step ? 'active' : ''}
                    disabled={isReadOnly}
                    onClick={() => setNudgeStepMs(step)}
                  >
                    {step}ms
                  </button>
                ))}
              </div>
              <div className="insp-nudge-step-btns">
                <button
                  type="button"
                  disabled={!canSyncShift || minDeltaMs > -0.01}
                  title={`向左调整 ${nudgeStepMs} ms`}
                  onClick={() => applyMultiSyncDeltaMs(-nudgeStepMs)}
                >
                  −
                </button>
                <button
                  type="button"
                  disabled={!canSyncShift || maxDeltaMs < 0.01}
                  title={`向右调整 ${nudgeStepMs} ms`}
                  onClick={() => applyMultiSyncDeltaMs(nudgeStepMs)}
                >
                  +
                </button>
              </div>
            </div>
          </InspectorCard>

          {/* Card 4: 合并预览 (only when canMerge) */}
          {multiAnalysis.capabilities.canMerge && (
            <InspectorCard title="合并预览" badge={<span className="insp-badge is-blue">可合并</span>}>
              <div className="insp-praat-preview" title={mergedPreviewText || '（空白）'}>
                <span className="insp-praat-label">合并后文本</span>
                <span className="insp-praat-val">
                  {mergedPreviewText ? mergedPreviewText : '（空白）'}
                </span>
              </div>
              <button
                type="button"
                className="insp-btn insp-btn-primary is-full"
                disabled={isReadOnly}
                onClick={() => mergeMultiSelection()}
              >
                合并为一段
              </button>
            </InspectorCard>
          )}
        </div>
      );
    }

    // =========================================================================
    // STATE 2: SINGLE INTERVAL SELECTED
    // =========================================================================
    if (selection?.kind === 'interval' && activeInterval && activeTier) {
      const ti = selection.tierIndex;
      const ii = selection.itemIndex;
      const totalInTier = activeTier.intervals.length;
      const durSec = Math.max(0, activeInterval.xmax - activeInterval.xmin);
      const durMs = durSec * 1000;

      const prevIv = activeTier.intervals[ii - 1] ?? null;
      const nextIv = activeTier.intervals[ii + 1] ?? null;

      const selectSiblingInterval = (targetIdx: number) => {
        if (targetIdx < 0 || targetIdx >= totalInTier) return;
        flushPendingTextDraft();
        const targetIv = activeTier.intervals[targetIdx];
        setSelection({ kind: 'interval', tierIndex: ti, itemIndex: targetIdx });
        if (targetIv && targetIv.xmax > targetIv.xmin) {
          setPlayRange({ start: targetIv.xmin, end: targetIv.xmax });
          setPlaybackTime(targetIv.xmin, true);
        }
      };

      const prevLinked = Boolean(
        linkAdjacent && prevIv && Math.abs(prevIv.xmax - activeInterval.xmin) < 1e-9
      );
      const nextLinked = Boolean(
        linkAdjacent && nextIv && Math.abs(nextIv.xmin - activeInterval.xmax) < 1e-9
      );
      const startMin = prevLinked && prevIv ? prevIv.xmin : activeTier.xmin;
      const endMax = nextLinked && nextIv ? nextIv.xmax : activeTier.xmax;

      const handleIntervalNudge = (dir: -1 | 1) => {
        if (isReadOnly) return;
        const deltaSec = (dir * nudgeStepMs) / 1000;
        if (ivNudgeTarget === 'start') {
          updateIntervalBoundsWithAnchor(
            ti,
            ii,
            { xmin: activeInterval.xmin + deltaSec },
            'end',
            linkAdjacent
          );
        } else if (ivNudgeTarget === 'move') {
          updateIntervalBoundsWithAnchor(
            ti,
            ii,
            { xmin: activeInterval.xmin + deltaSec },
            'duration',
            linkAdjacent
          );
        } else {
          updateIntervalBoundsWithAnchor(
            ti,
            ii,
            { xmax: activeInterval.xmax + deltaSec },
            'start',
            linkAdjacent
          );
        }
      };

      const handleClearIntervalText = () => {
        if (isReadOnly) return;
        flushPendingTextDraft();
        if (activeInterval.text === '' && textDraft === '') return;
        const oldText = activeInterval.text;
        const tierName = formatTierLabel(activeTier.name, ti);
        draftDirtyRef.current = false;
        draftValueRef.current = '';
        setTextDraft('');
        commitTgMutation(
          (_d, ctx) => {
            const dTier = ctx.editTier(ti);
            const target = dTier?.intervals[ii];
            if (!target || target.text === '') return false;
            target.text = '';
          },
          undefined,
          {
            type: 'clear-interval-text',
            title: '清空区间文本',
            detail: `${tierName} · 原${formatQuote(oldText)}`,
            icon: 'clear',
            tierName,
            focusTime: activeInterval.xmin
          }
        );
      };

      const hasAudioOrAnalysis = Boolean(analysis || effectiveAudioBuffer);
      const showMidFormants = durSec <= 0.3;

      const blockMinDeltaMs =
        alignedBlock && alignedBlockSafeBounds
          ? (alignedBlockSafeBounds.minXmin - alignedBlock.xmin) * 1000
          : 0;
      const blockMaxDeltaMs =
        alignedBlock && alignedBlockSafeBounds
          ? (alignedBlockSafeBounds.maxXmax - alignedBlock.xmax) * 1000
          : 0;
      const canShiftBlock =
        !isReadOnly &&
        alignedBlock !== null &&
        alignedBlockSafeBounds !== null &&
        (blockMaxDeltaMs > 0.05 || blockMinDeltaMs < -0.05);

      const playRangeDiffersFromBlock = Boolean(
        playRange &&
          playRange.end > playRange.start + 0.001 &&
          (Math.abs(playRange.start - activeInterval.xmin) > 1e-4 ||
            Math.abs(playRange.end - activeInterval.xmax) > 1e-4)
      );

      const applyBlockShiftMs = (deltaMs: number): boolean => {
        if (isReadOnly || !alignedBlock || !Number.isFinite(deltaMs) || Math.abs(deltaMs) < 1e-4) {
          return false;
        }
        const deltaSec = deltaMs / 1000;
        const res = transformAlignedBlock(
          ti,
          ii,
          activeInterval.xmin + deltaSec,
          activeInterval.xmax + deltaSec,
          { mode: 'move' }
        );
        if (res.changed) setDeltaResetTick((t) => t + 1);
        return res.changed;
      };

      return (
        <div className="insp-root">
          {renderObjectHeader({
            accentClass: 'accent-interval',
            accentColor: '#2563EB',
            typeLabel: '区间',
            title: activeTier.name || `第 ${ti + 1} 层`,
            sub: `第 ${ti + 1} 层 · ${activeInterval.xmin.toFixed(3)}–${activeInterval.xmax.toFixed(3)} s`,
            stepper: {
              current: ii + 1,
              total: totalInTier,
              onPrev: () => selectSiblingInterval(ii - 1),
              onNext: () => selectSiblingInterval(ii + 1),
              prevTitle: '上一区间',
              nextTitle: '下一区间'
            }
          })}
          {readOnlyBanner}
          {renderObjectIssueBar()}

          {/* Card 1: 文本与音标 */}
          <InspectorCard
            title="文本与音标"
            actions={
              <>
                <button
                  type="button"
                  className="insp-icon-btn"
                  disabled={textDraft === ''}
                  title="复制区间文本"
                  aria-label="复制区间文本"
                  onClick={() => copyTextValue(textDraft, '区间文本')}
                >
                  <UiIcon name="copy" size={12} />
                </button>
                <button
                  type="button"
                  className="insp-icon-btn"
                  disabled={isReadOnly || textDraft === ''}
                  title="转为 Unicode 音标"
                  aria-label="转为 Unicode 音标"
                  onClick={() => {
                    flushPendingTextDraft();
                    void convertSelectionIpa('to-unicode');
                  }}
                >
                  <UiIcon name="convertUnicode" size={12} />
                </button>
                <button
                  type="button"
                  className="insp-icon-btn"
                  disabled={isReadOnly || textDraft === ''}
                  title="转为 Praat 转义编码"
                  aria-label="转为 Praat 转义编码"
                  onClick={() => {
                    flushPendingTextDraft();
                    void convertSelectionIpa('to-praat');
                  }}
                >
                  <UiIcon name="convertPraat" size={12} />
                </button>
                <button
                  type="button"
                  className="insp-icon-btn"
                  disabled={isReadOnly || textDraft === ''}
                  title="清空文本"
                  aria-label="清空文本"
                  onClick={handleClearIntervalText}
                >
                  <UiIcon name="clear" size={12} />
                </button>
              </>
            }
          >
            <div className={`sb-ipa-field-wrap ${!isReadOnly && ipaIme.ipaMode !== 'off' ? 'has-pill' : ''}`}>
              {!isReadOnly && <IpaModePill ime={ipaIme} className="is-sidebar-docked" />}
              <textarea
                ref={textareaRef}
                className={`insp-textarea ${isReadOnly ? 'is-readonly' : ''}`}
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
                        ipaIme.onBlur();
                        if (isIpaRelatedElement(e.relatedTarget)) return;
                        flushPendingTextDraft();
                      }
                }
              />
            </div>
            {!isReadOnly && <IpaImePopover ime={ipaIme} />}
            {trigraphPreview && (
              <div
                className="insp-praat-preview"
                title="文本含 Praat 转义码时显示实时音标对照"
              >
                <span className="insp-praat-label">
                  {ipaIme.ipaMode === 'off' ? 'Praat 对照' : '音标预览'}
                </span>
                <span className="insp-praat-val selectable">{trigraphPreview}</span>
              </div>
            )}

            {/* 前后区间跳转条 */}
            <div className="insp-neighbor-strip" aria-label="前后区间">
              <button
                type="button"
                className="insp-neighbor-btn"
                disabled={!prevIv}
                title={
                  prevIv
                    ? `跳转到前段：${prevIv.text || '（空白）'} (${formatShortDur(prevIv.xmax - prevIv.xmin)})`
                    : '已是本层首段'
                }
                onClick={() => selectSiblingInterval(ii - 1)}
              >
                <span>←</span>
                <span className="insp-neighbor-text">
                  {prevIv ? prevIv.text.trim() || '空白' : '无'}
                </span>
                {prevIv && (
                  <span className="insp-neighbor-dur">
                    · {formatShortDur(prevIv.xmax - prevIv.xmin)}
                  </span>
                )}
              </button>
              <span className="insp-neighbor-cur">当前</span>
              <button
                type="button"
                className="insp-neighbor-btn is-right"
                disabled={!nextIv}
                title={
                  nextIv
                    ? `跳转到后段：${nextIv.text || '（空白）'} (${formatShortDur(nextIv.xmax - nextIv.xmin)})`
                    : '已是本层末段'
                }
                onClick={() => selectSiblingInterval(ii + 1)}
              >
                <span className="insp-neighbor-text">
                  {nextIv ? nextIv.text.trim() || '空白' : '无'}
                </span>
                {nextIv && (
                  <span className="insp-neighbor-dur">
                    · {formatShortDur(nextIv.xmax - nextIv.xmin)}
                  </span>
                )}
                <span>→</span>
              </button>
            </div>
            <div className="sb-hint">
              {isReadOnly
                ? '只读模式：可选中复制文本，切换至编辑模式后修改。'
                : `Tab 连编 · Alt+P/F4 试听 · ${formatKeyCombo('Mod+Enter')} 提交 · ${formatKeyCombo('Mod+\\')} 切音标`}
            </div>
          </InspectorCard>

          {/* Card 2: 时间与时长 */}
          <InspectorCard
            title="时间与时长"
            badge={<span className="insp-badge is-blue">{formatDurationBadge(durSec)}</span>}
          >
            <div className="insp-anchor-group" role="group" aria-label="固定方式">
              {(
                [
                  ['start', '固定起点'],
                  ['duration', '固定时长'],
                  ['end', '固定终点']
                ] as const
              ).map(([aKey, aLabel]) => (
                <button
                  key={aKey}
                  type="button"
                  className={ivAnchor === aKey ? 'active' : ''}
                  disabled={isReadOnly}
                  onClick={() => setIvAnchor(aKey)}
                >
                  {aLabel}
                </button>
              ))}
            </div>

            <div className="insp-time-grid">
              <div className="insp-time-cell">
                <span className="insp-field-label">起始 (s)</span>
                <div className="insp-time-input-row">
                  <ScrubNumberInput
                    variant="sidebar"
                    value={activeInterval.xmin}
                    min={ivAnchor === 'duration' ? activeTier.xmin : startMin}
                    strictMin={ivAnchor !== 'duration' && prevLinked}
                    max={ivAnchor === 'duration' ? activeTier.xmax - durSec : activeInterval.xmax}
                    strictMax={ivAnchor !== 'duration'}
                    disabled={isReadOnly}
                    formatValue={formatPraatDouble}
                    onCommit={(val) =>
                      updateIntervalBoundsWithAnchor(ti, ii, { xmin: val }, ivAnchor, linkAdjacent)
                    }
                  />
                  {hasAudioOrAnalysis && (
                    <>
                      <button
                        type="button"
                        className="insp-icon-btn"
                        disabled={isReadOnly || !effectiveAudioBuffer}
                        title="起点吸附到附近声学边界（AcouSeg 1.0）"
                        aria-label="起点吸附到附近声学边界"
                        onClick={() => void handleSnapIntervalEdgeAcoustic('start')}
                      >
                        <UiIcon name="nudgeBoundary" size={12} />
                      </button>
                      <button
                        type="button"
                        className="insp-icon-btn"
                        disabled={isReadOnly}
                        title="起点吸附到最近过零点"
                        aria-label="起点吸附到最近过零点"
                        onClick={() => void handleSnapIntervalEdgeZero('start')}
                      >
                        <UiIcon name="zeroCross" size={12} />
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="insp-time-cell">
                <span className="insp-field-label">结束 (s)</span>
                <div className="insp-time-input-row">
                  <ScrubNumberInput
                    variant="sidebar"
                    value={activeInterval.xmax}
                    min={ivAnchor === 'duration' ? activeTier.xmin + durSec : activeInterval.xmin}
                    strictMin={ivAnchor !== 'duration'}
                    max={ivAnchor === 'duration' ? activeTier.xmax : endMax}
                    strictMax={ivAnchor !== 'duration' && nextLinked}
                    disabled={isReadOnly}
                    formatValue={formatPraatDouble}
                    onCommit={(val) =>
                      updateIntervalBoundsWithAnchor(ti, ii, { xmax: val }, ivAnchor, linkAdjacent)
                    }
                  />
                  {hasAudioOrAnalysis && (
                    <>
                      <button
                        type="button"
                        className="insp-icon-btn"
                        disabled={isReadOnly || !effectiveAudioBuffer}
                        title="终点吸附到附近声学边界（AcouSeg 1.0）"
                        aria-label="终点吸附到附近声学边界"
                        onClick={() => void handleSnapIntervalEdgeAcoustic('end')}
                      >
                        <UiIcon name="nudgeBoundary" size={12} />
                      </button>
                      <button
                        type="button"
                        className="insp-icon-btn"
                        disabled={isReadOnly}
                        title="终点吸附到最近过零点"
                        aria-label="终点吸附到最近过零点"
                        onClick={() => void handleSnapIntervalEdgeZero('end')}
                      >
                        <UiIcon name="zeroCross" size={12} />
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="insp-time-cell is-span-2">
                <span className="insp-field-label">时长 (ms)</span>
                <ScrubNumberInput
                  variant="sidebar"
                  value={durMs}
                  min={0.1}
                  stepSec={1}
                  fineStepSec={0.1}
                  coarseStepSec={10}
                  decimals={1}
                  disabled={isReadOnly}
                  onCommit={(valMs) =>
                    updateIntervalBoundsWithAnchor(
                      ti,
                      ii,
                      { duration: valMs / 1000 },
                      ivAnchor === 'duration' ? 'start' : ivAnchor,
                      linkAdjacent
                    )
                  }
                />
              </div>
            </div>

            {/* 单行紧凑微调 */}
            <div className="insp-nudge-row" aria-label="快捷微调">
              <div className="insp-nudge-group" role="group" aria-label="调整目标">
                {(
                  [
                    ['start', '起点'],
                    ['move', '整体'],
                    ['end', '终点']
                  ] as const
                ).map(([tKey, tLbl]) => (
                  <button
                    key={tKey}
                    type="button"
                    className={ivNudgeTarget === tKey ? 'active' : ''}
                    disabled={isReadOnly}
                    onClick={() => setIvNudgeTarget(tKey)}
                  >
                    {tLbl}
                  </button>
                ))}
              </div>
              <div className="insp-nudge-group" role="group" aria-label="步长">
                {([1, 5, 10] as const).map((step) => (
                  <button
                    key={step}
                    type="button"
                    className={nudgeStepMs === step ? 'active' : ''}
                    disabled={isReadOnly}
                    onClick={() => setNudgeStepMs(step)}
                  >
                    {step}
                  </button>
                ))}
              </div>
              <div className="insp-nudge-step-btns">
                <button
                  type="button"
                  disabled={isReadOnly}
                  title={`减少 ${nudgeStepMs} ms`}
                  onClick={() => handleIntervalNudge(-1)}
                >
                  −
                </button>
                <button
                  type="button"
                  disabled={isReadOnly}
                  title={`增加 ${nudgeStepMs} ms`}
                  onClick={() => handleIntervalNudge(1)}
                >
                  +
                </button>
              </div>
            </div>

            <ToggleSwitch
              compact
              label="联动相邻边界"
              disabled={isReadOnly}
              checked={linkAdjacent}
              onChange={setLinkAdjacent}
            />
          </InspectorCard>

          {/* Card 3: 跨层联动 (only when aligned block spans multiple tiers) */}
          {alignedBlock && alignedBlockSafeBounds && (
            <InspectorCard
              title="跨层联动"
              badge={
                <span className="insp-badge is-blue">{alignedBlock.tierIndices.length} 层对齐</span>
              }
            >
              <div className="insp-tier-list">
                {alignedBlock.intervalSlices.map((sl) => {
                  const subCount = sl.endItemIndex - sl.startItemIndex + 1;
                  return (
                    <div key={`blk-iv-${sl.tierIndex}`} className="insp-tier-row">
                      <div className="insp-tier-row-main">
                        <span className="insp-tier-row-name">{sl.tierName}</span>
                        <span className="insp-tier-row-meta">
                          {sl.isExactSingle ? '单段完全对齐' : `含 ${subCount} 个子段`}
                        </span>
                      </div>
                      {sl.tierIndex === ti && <span className="insp-badge is-blue">当前层</span>}
                    </div>
                  );
                })}
                {alignedBlock.pointSlices.map((ps) => (
                  <div key={`blk-pt-${ps.tierIndex}`} className="insp-tier-row">
                    <div className="insp-tier-row-main">
                      <span className="insp-tier-row-name">{ps.tierName}</span>
                      <span className="insp-tier-row-meta">
                        点层 · 内含 {ps.pointIndices.length} 个标点
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="insp-kv-item is-wide">
                <span className="insp-kv-label">可移动范围</span>
                <span className="insp-kv-val">
                  {blockMinDeltaMs <= -0.05 ? blockMinDeltaMs.toFixed(1) : '0'} ～ +
                  {blockMaxDeltaMs >= 0.05 ? blockMaxDeltaMs.toFixed(1) : '0'} ms
                </span>
              </div>

              <div className="insp-time-cell">
                <span className="insp-field-label">跨层平移 Δ (ms)</span>
                <ScrubNumberInput
                  key={`blk-shift-${deltaResetTick}-${ti}-${ii}`}
                  variant="sidebar"
                  value={0}
                  min={blockMinDeltaMs}
                  max={blockMaxDeltaMs}
                  stepSec={1}
                  fineStepSec={0.5}
                  coarseStepSec={10}
                  decimals={1}
                  disabled={!canShiftBlock}
                  onCommit={(valMs) => applyBlockShiftMs(valMs)}
                />
              </div>

              {playRangeDiffersFromBlock && playRange && (
                <button
                  type="button"
                  className="insp-btn insp-btn-soft is-xs is-full"
                  disabled={isReadOnly}
                  onClick={() =>
                    transformAlignedBlock(ti, ii, playRange.start, playRange.end, { mode: 'remap' })
                  }
                >
                  移到播放选区 ({playRange.start.toFixed(3)}–{playRange.end.toFixed(3)} s)
                </button>
              )}
            </InspectorCard>
          )}

          {/* Card 4: 智能拆分预览卡 */}
          <SmartSplitInlineCard
            rawText={activeInterval.text}
            decodedPraatText={trigraphPreview}
            tierName={activeTier.name}
            peerTexts={activeTierPeerTexts}
            xmin={activeInterval.xmin}
            xmax={activeInterval.xmax}
            hasAudio={Boolean(effectiveAudioBuffer)}
            useAcoustic={smartSplitUseAcoustic}
            disabled={isReadOnly}
            onToggleAcoustic={setSmartSplitUseAcoustic}
            onApplyCandidate={(cand, useAc) => void handleApplyInlineSmartSplit(cand, useAc)}
            onOpenAdvancedModal={() => {
              if (onOpenSplitModal) {
                onOpenSplitModal(ti, ii);
              } else if (!isReadOnly) {
                splitIntervalEqualN(ti, ii, 2);
              }
            }}
          />

          {/* Card 5: 声学数据 (when audio analysis is present) */}
          {analysis && intervalAcoustic && (
            <InspectorCard
              title="声学数据"
              badge={
                intervalAcoustic.f0Mean ? (
                  <span className="insp-badge is-blue">{intervalAcoustic.f0Mean.toFixed(0)} Hz</span>
                ) : undefined
              }
            >
              <IntervalF0Sparkline
                pitchTrack={analysis.pitchTrack}
                xmin={activeInterval.xmin}
                xmax={activeInterval.xmax}
                meanF0={intervalAcoustic.f0Mean}
                minF0={intervalAcoustic.f0Min}
                maxF0={intervalAcoustic.f0Max}
                voicedRatio={intervalAcoustic.voicedRatio}
                rmsDb={intervalAcoustic.rmsDb}
                formants={
                  showMidFormants
                    ? {
                        f1: intervalAcoustic.f1,
                        f2: intervalAcoustic.f2,
                        f3: intervalAcoustic.f3
                      }
                    : null
                }
                onCopyTsv={() =>
                  copyAcousticTsv(
                    intervalAcoustic,
                    activeInterval.xmin,
                    activeInterval.xmax,
                    activeInterval.text
                  )
                }
              />
            </InspectorCard>
          )}
        </div>
      );
    }

    // =========================================================================
    // STATE 3: BOUNDARY OR SPINE SELECTED
    // =========================================================================
    if (selection?.kind === 'boundary' || selection?.kind === 'spine') {
      const isBoundary = selection.kind === 'boundary';
      const tier = isBoundary ? tg.tiers[selection.tierIndex] : null;
      const affectAll = !isBoundary || boundaryShared;
      const bTime = selection.time;

      let bndMin = tg.xmin;
      let bndMax = tg.xmax;
      const tiersToInspect = affectAll ? tg.tiers : tier ? [tier] : [];
      for (const t of tiersToInspect) {
        if (t.kind !== 'intervalTier') continue;
        for (const iv of t.intervals) {
          if (Math.abs(iv.xmax - bTime) < 1e-6 && iv.xmin > bndMin) {
            bndMin = iv.xmin;
          }
          if (Math.abs(iv.xmin - bTime) < 1e-6 && iv.xmax < bndMax) {
            bndMax = iv.xmax;
          }
        }
      }

      // Stepper list for boundaries
      const boundaryList = isBoundary
        ? collectTierInteriorBoundaries(tg, selection.tierIndex)
        : collectAllInteriorBoundaries(tg);
      const curBndIdx = boundaryList.findIndex((t) => Math.abs(t - bTime) < 1e-5);

      const stepBoundary = (delta: -1 | 1) => {
        if (boundaryList.length === 0 || curBndIdx < 0) return;
        const nextIdx = curBndIdx + delta;
        if (nextIdx < 0 || nextIdx >= boundaryList.length) return;
        const nextT = boundaryList[nextIdx];
        if (isBoundary) {
          setSelection({
            kind: 'boundary',
            tierIndex: selection.tierIndex,
            time: nextT,
            bandIndex: selection.bandIndex
          });
        } else {
          setSelection({
            kind: 'spine',
            time: nextT,
            bandIndex: selection.bandIndex
          });
        }
        setPlaybackTime(nextT, true);
      };

      // Left / right neighbor intervals for BoundaryBalanceBar
      let balanceTierIdx = isBoundary ? selection.tierIndex : -1;
      if (!isBoundary) {
        balanceTierIdx = tg.tiers.findIndex(
          (t) =>
            t.kind === 'intervalTier' &&
            t.intervals.some(
              (iv) => Math.abs(iv.xmax - bTime) < 1e-6 || Math.abs(iv.xmin - bTime) < 1e-6
            )
        );
      }
      const balanceTier = balanceTierIdx >= 0 ? tg.tiers[balanceTierIdx] : null;
      const leftIdx =
        balanceTier && balanceTier.kind === 'intervalTier'
          ? balanceTier.intervals.findIndex((iv) => Math.abs(iv.xmax - bTime) < 1e-6)
          : -1;
      const rightIdx =
        balanceTier && balanceTier.kind === 'intervalTier'
          ? balanceTier.intervals.findIndex((iv) => Math.abs(iv.xmin - bTime) < 1e-6)
          : -1;
      const leftIv =
        balanceTier && balanceTier.kind === 'intervalTier' && leftIdx >= 0
          ? balanceTier.intervals[leftIdx]
          : null;
      const rightIv =
        balanceTier && balanceTier.kind === 'intervalTier' && rightIdx >= 0
          ? balanceTier.intervals[rightIdx]
          : null;

      // Cross-tier alignment classification
      const alignedTiers: Array<{ tierIndex: number; name: string; kindLabel: string }> = [];
      const microOffsetTiers: Array<{
        tierIndex: number;
        name: string;
        kind: 'intervalTier' | 'textTier';
        actualTime: number;
        pointIndex?: number;
        offsetMs: number;
      }> = [];
      const otherIntervalTiers: Array<{ tierIndex: number; name: string }> = [];

      const microThreshold = 0.005;
      for (let ti = 0; ti < tg.tiers.length; ti++) {
        const t = tg.tiers[ti];
        const tName = t.name || `第 ${ti + 1} 层`;
        if (t.kind === 'intervalTier') {
          const bnds = collectTierInteriorBoundaries(tg, ti);
          const exact = bnds.find((x) => Math.abs(x - bTime) <= 1e-6);
          if (exact !== undefined) {
            alignedTiers.push({ tierIndex: ti, name: tName, kindLabel: '区间边界' });
          } else {
            let bestNear: number | null = null;
            let bestDist = microThreshold;
            for (const x of bnds) {
              const d = Math.abs(x - bTime);
              if (d > 1e-6 && d < bestDist) {
                bestDist = d;
                bestNear = x;
              }
            }
            if (bestNear !== null) {
              microOffsetTiers.push({
                tierIndex: ti,
                name: tName,
                kind: 'intervalTier',
                actualTime: bestNear,
                offsetMs: (bestNear - bTime) * 1000
              });
            } else if (bTime > t.xmin + 1e-6 && bTime < t.xmax - 1e-6) {
              otherIntervalTiers.push({ tierIndex: ti, name: tName });
            }
          }
        } else {
          const exactPt = t.points.find((p) => Math.abs(p.number - bTime) <= 1e-6);
          if (exactPt) {
            alignedTiers.push({ tierIndex: ti, name: tName, kindLabel: '标点' });
          } else {
            let bestPtIdx = -1;
            let bestDist = microThreshold;
            for (let pi = 0; pi < t.points.length; pi++) {
              const d = Math.abs(t.points[pi].number - bTime);
              if (d > 1e-6 && d < bestDist) {
                bestDist = d;
                bestPtIdx = pi;
              }
            }
            if (bestPtIdx >= 0) {
              const ptT = t.points[bestPtIdx].number;
              microOffsetTiers.push({
                tierIndex: ti,
                name: tName,
                kind: 'textTier',
                actualTime: ptT,
                pointIndex: bestPtIdx,
                offsetMs: (ptT - bTime) * 1000
              });
            }
          }
        }
      }

      return (
        <div className="insp-root">
          {renderObjectHeader({
            accentClass: isBoundary ? 'accent-boundary' : 'accent-spine',
            accentColor: '#D97706',
            typeLabel: isBoundary ? '边界' : '对齐时刻',
            title: isBoundary ? tier?.name || `第 ${selection.tierIndex + 1} 层` : '跨层共享时刻',
            sub: `${bTime.toFixed(4)} s`,
            stepper:
              curBndIdx >= 0
                ? {
                    current: curBndIdx + 1,
                    total: boundaryList.length,
                    onPrev: () => stepBoundary(-1),
                    onNext: () => stepBoundary(1),
                    prevTitle: '上一边界',
                    nextTitle: '下一边界'
                  }
                : undefined
          })}
          {readOnlyBanner}
          {renderObjectIssueBar()}

          {/* Card 1: 附近波形 */}
          {effectiveAudioBuffer && (
            <InspectorCard title="附近波形" tight>
              <BoundaryMicroWave
                audioBuffer={effectiveAudioBuffer}
                timeSec={bTime - audioOffset}
                nearestZeroSec={
                  nearestZeroForWave !== null ? nearestZeroForWave - audioOffset : null
                }
                accentColor="#D97706"
                disabled={isReadOnly}
                onSnapZero={() => void handleSnapBoundaryZero()}
                onSnapAcoustic={() => void handleSnapBoundaryAcoustic()}
              />
            </InspectorCard>
          )}

          {/* Card 2: 时刻与左右占比 */}
          <InspectorCard
            title="时刻与左右占比"
            badge={<span className="insp-badge is-amber">{bTime.toFixed(3)} s</span>}
          >
            <div className="insp-time-cell">
              <span className="insp-field-label">边界时刻 (s)</span>
              <ScrubNumberInput
                variant="sidebar"
                value={bTime}
                min={bndMin}
                max={bndMax}
                strictMin={true}
                strictMax={true}
                disabled={isReadOnly}
                formatValue={formatPraatDouble}
                onCommit={(val) => updateBoundaryOrSpineTime(val)}
              />
            </div>

            {(leftIv || rightIv) && (
              <BoundaryBalanceBar
                leftText={leftIv ? leftIv.text : ''}
                rightText={rightIv ? rightIv.text : ''}
                leftDurSec={leftIv ? Math.max(0, leftIv.xmax - leftIv.xmin) : 0}
                rightDurSec={rightIv ? Math.max(0, rightIv.xmax - rightIv.xmin) : 0}
                onJumpLeft={
                  leftIv && leftIdx >= 0
                    ? () => {
                        setSelection({
                          kind: 'interval',
                          tierIndex: balanceTierIdx,
                          itemIndex: leftIdx
                        });
                        setPlayRange({ start: leftIv.xmin, end: leftIv.xmax });
                        setPlaybackTime(leftIv.xmin, true);
                      }
                    : undefined
                }
                onJumpRight={
                  rightIv && rightIdx >= 0
                    ? () => {
                        setSelection({
                          kind: 'interval',
                          tierIndex: balanceTierIdx,
                          itemIndex: rightIdx
                        });
                        setPlayRange({ start: rightIv.xmin, end: rightIv.xmax });
                        setPlaybackTime(rightIv.xmin, true);
                      }
                    : undefined
                }
              />
            )}

            {/* 单行微调 */}
            <div className="insp-nudge-row" aria-label="时刻微调">
              <span className="insp-field-label" style={{ paddingLeft: 2 }}>
                微调
              </span>
              <div className="insp-nudge-group" role="group" aria-label="步长">
                {([1, 5, 10] as const).map((step) => (
                  <button
                    key={step}
                    type="button"
                    className={nudgeStepMs === step ? 'active' : ''}
                    disabled={isReadOnly}
                    onClick={() => setNudgeStepMs(step)}
                  >
                    {step}ms
                  </button>
                ))}
              </div>
              <div className="insp-nudge-step-btns">
                <button
                  type="button"
                  disabled={isReadOnly}
                  title={`向左移动 ${nudgeStepMs} ms`}
                  onClick={() => updateBoundaryOrSpineTime(bTime - nudgeStepMs / 1000)}
                >
                  −
                </button>
                <button
                  type="button"
                  disabled={isReadOnly}
                  title={`向右移动 ${nudgeStepMs} ms`}
                  onClick={() => updateBoundaryOrSpineTime(bTime + nudgeStepMs / 1000)}
                >
                  +
                </button>
              </div>
            </div>

            {/* 三连试听 */}
            <div className="insp-play-trio" role="group" aria-label="边界试听">
              <button
                type="button"
                disabled={bTime <= tg.xmin + 1e-6}
                title="试听边界前 250 ms"
                onClick={() => onStartPlayback(Math.max(tg.xmin, bTime - 0.25), bTime)}
              >
                前 250ms
              </button>
              <button
                type="button"
                disabled={tg.xmax <= tg.xmin}
                title="跨越边界试听前后各 200 ms"
                onClick={() =>
                  onStartPlayback(Math.max(tg.xmin, bTime - 0.2), Math.min(tg.xmax, bTime + 0.2))
                }
              >
                跨 ±200ms
              </button>
              <button
                type="button"
                disabled={bTime >= tg.xmax - 1e-6}
                title="试听边界后 250 ms"
                onClick={() => onStartPlayback(bTime, Math.min(tg.xmax, bTime + 0.25))}
              >
                后 250ms
              </button>
            </div>
          </InspectorCard>

          {/* Card 3: 跨层对齐清单 */}
          <InspectorCard
            title="跨层对齐"
            badge={<span className="insp-badge">{alignedTiers.length} 层已对齐</span>}
          >
            {isBoundary ? (
              <div className="insp-seg" role="group" aria-label="边界移动范围">
                <button
                  type="button"
                  className={!boundaryShared ? 'active' : ''}
                  disabled={isReadOnly}
                  onClick={() => setBoundaryShared(false)}
                >
                  仅当前层
                </button>
                <button
                  type="button"
                  className={boundaryShared ? 'active' : ''}
                  disabled={isReadOnly}
                  onClick={() => setBoundaryShared(true)}
                >
                  联动对齐层
                </button>
              </div>
            ) : (
              <div className="sb-hint">移动此对齐时刻将同步移动全部对齐层的边界与标点。</div>
            )}

            {alignedTiers.length > 0 && (
              <>
                <div className="insp-multi-group-head">
                  <span>已对齐层</span>
                  <span>{alignedTiers.length}</span>
                </div>
                <div className="insp-tier-list">
                  {alignedTiers.map((item) => (
                    <div key={`al-${item.tierIndex}`} className="insp-tier-row">
                      <div className="insp-tier-row-main">
                        <span className="insp-tier-row-name">{item.name}</span>
                        <span className="insp-tier-row-meta">{item.kindLabel}</span>
                      </div>
                      {isBoundary && item.tierIndex === selection.tierIndex && (
                        <span className="insp-badge is-amber">当前</span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {microOffsetTiers.length > 0 && (
              <>
                <div className="insp-multi-group-head">
                  <span>微偏层 (&lt; 5 ms)</span>
                  <span>{microOffsetTiers.length}</span>
                </div>
                <div className="insp-tier-list">
                  {microOffsetTiers.map((item) => (
                    <div key={`mo-${item.tierIndex}`} className="insp-tier-row">
                      <div className="insp-tier-row-main">
                        <span className="insp-tier-row-name">{item.name}</span>
                        <span className="insp-tier-row-meta">
                          偏差 {item.offsetMs >= 0 ? '+' : ''}
                          {item.offsetMs.toFixed(1)} ms
                        </span>
                      </div>
                      <button
                        type="button"
                        className="insp-btn insp-btn-soft is-xs"
                        disabled={isReadOnly}
                        onClick={() => {
                          if (item.kind === 'intervalTier') {
                            const ok = moveTierBoundary(
                              item.tierIndex,
                              item.actualTime,
                              bTime,
                              false
                            );
                            if (ok) showToast(`已将「${item.name}」对齐至 ${bTime.toFixed(4)} s`);
                          } else if (item.pointIndex !== undefined) {
                            const ok = movePointToTime(
                              item.tierIndex,
                              item.pointIndex,
                              bTime,
                              '跨层微偏对齐'
                            );
                            if (ok) showToast(`已将「${item.name}」标点对齐至 ${bTime.toFixed(4)} s`);
                          }
                        }}
                      >
                        对齐
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {otherIntervalTiers.length > 0 && (
              <>
                <div className="insp-multi-group-head">
                  <span>其他区间层</span>
                  <span>{otherIntervalTiers.length}</span>
                </div>
                <div className="insp-tier-list">
                  {otherIntervalTiers.map((item) => (
                    <div key={`ot-${item.tierIndex}`} className="insp-tier-row">
                      <div className="insp-tier-row-main">
                        <span className="insp-tier-row-name">{item.name}</span>
                        <span className="insp-tier-row-meta">此位置暂无边界</span>
                      </div>
                      <button
                        type="button"
                        className="insp-btn is-xs"
                        disabled={isReadOnly}
                        onClick={() => {
                          const ok = projectBoundaryToTier(item.tierIndex, bTime);
                          if (ok) showToast(`已将边界复制到「${item.name}」`);
                        }}
                      >
                        复制边界
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </InspectorCard>
        </div>
      );
    }

    // =========================================================================
    // STATE 4: POINT SELECTED
    // =========================================================================
    if (selection?.kind === 'point' && activePoint && activeTier) {
      const ti = selection.tierIndex;
      const pi = selection.itemIndex;
      const totalPts = activeTier.points.length;

      const selectSiblingPoint = (nextIdx: number) => {
        if (nextIdx < 0 || nextIdx >= totalPts) return;
        flushPendingTextDraft();
        const nextPt = activeTier.points[nextIdx];
        setSelection({ kind: 'point', tierIndex: ti, itemIndex: nextIdx });
        if (nextPt) setPlaybackTime(nextPt.number, true);
      };

      const handleClearPointMark = () => {
        if (isReadOnly) return;
        flushPendingTextDraft();
        if (activePoint.mark === '' && textDraft === '') return;
        const oldMark = activePoint.mark;
        const tierName = formatTierLabel(activeTier.name, ti);
        draftDirtyRef.current = false;
        draftValueRef.current = '';
        setTextDraft('');
        commitTgMutation(
          (_d, ctx) => {
            const dTier = ctx.editTier(ti);
            const target = dTier?.points[pi];
            if (!target || target.mark === '') return false;
            target.mark = '';
          },
          undefined,
          {
            type: 'edit-point-text',
            title: '清空标点文本',
            detail: `${tierName} · ${formatTimeSec(activePoint.number)} 原${formatQuote(oldMark)}`,
            icon: 'clear',
            tierName,
            focusTime: activePoint.number
          }
        );
      };

      // Locate point inside every interval tier
      const tierPositions: Array<{
        tierIndex: number;
        tierName: string;
        itemIndex: number;
        text: string;
        pct: number;
      }> = [];
      for (let k = 0; k < tg.tiers.length; k++) {
        const t = tg.tiers[k];
        if (t.kind !== 'intervalTier') continue;
        const foundIdx = t.intervals.findIndex(
          (iv) =>
            iv.xmax > iv.xmin &&
            activePoint.number >= iv.xmin - BLOCK_ALIGN_EPS &&
            activePoint.number <= iv.xmax + BLOCK_ALIGN_EPS
        );
        if (foundIdx >= 0) {
          const iv = t.intervals[foundIdx];
          const pct = Math.max(
            0,
            Math.min(100, Math.round(((activePoint.number - iv.xmin) / (iv.xmax - iv.xmin)) * 100))
          );
          tierPositions.push({
            tierIndex: k,
            tierName: t.name || `第 ${k + 1} 层`,
            itemIndex: foundIdx,
            text: iv.text,
            pct
          });
        }
      }

      return (
        <div className="insp-root">
          {renderObjectHeader({
            accentClass: 'accent-point',
            accentColor: '#0D9488',
            typeLabel: '标点',
            title: activeTier.name || `第 ${ti + 1} 层`,
            sub: `第 ${ti + 1} 层 · ${activePoint.number.toFixed(4)} s`,
            stepper: {
              current: pi + 1,
              total: totalPts,
              onPrev: () => selectSiblingPoint(pi - 1),
              onNext: () => selectSiblingPoint(pi + 1),
              prevTitle: '上一标点',
              nextTitle: '下一标点'
            }
          })}
          {readOnlyBanner}
          {renderObjectIssueBar()}

          {/* Card 1: 标记与音标 */}
          <InspectorCard
            title="标记与音标"
            actions={
              <>
                <button
                  type="button"
                  className="insp-icon-btn"
                  disabled={textDraft === ''}
                  title="复制标点文字"
                  aria-label="复制标点文字"
                  onClick={() => copyTextValue(textDraft, '标点文字')}
                >
                  <UiIcon name="copy" size={12} />
                </button>
                <button
                  type="button"
                  className="insp-icon-btn"
                  disabled={isReadOnly || textDraft === ''}
                  title="转为 Unicode 音标"
                  aria-label="转为 Unicode 音标"
                  onClick={() => {
                    flushPendingTextDraft();
                    void convertSelectionIpa('to-unicode');
                  }}
                >
                  <UiIcon name="convertUnicode" size={12} />
                </button>
                <button
                  type="button"
                  className="insp-icon-btn"
                  disabled={isReadOnly || textDraft === ''}
                  title="转为 Praat 转义编码"
                  aria-label="转为 Praat 转义编码"
                  onClick={() => {
                    flushPendingTextDraft();
                    void convertSelectionIpa('to-praat');
                  }}
                >
                  <UiIcon name="convertPraat" size={12} />
                </button>
                <button
                  type="button"
                  className="insp-icon-btn"
                  disabled={isReadOnly || textDraft === ''}
                  title="清空标点文字"
                  aria-label="清空标点文字"
                  onClick={handleClearPointMark}
                >
                  <UiIcon name="clear" size={12} />
                </button>
              </>
            }
          >
            <div className={`sb-ipa-field-wrap ${!isReadOnly && ipaIme.ipaMode !== 'off' ? 'has-pill' : ''}`}>
              {!isReadOnly && <IpaModePill ime={ipaIme} className="is-sidebar-docked" />}
              <textarea
                ref={textareaRef}
                className={`insp-textarea ${isReadOnly ? 'is-readonly' : ''}`}
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
                        ipaIme.onBlur();
                        if (isIpaRelatedElement(e.relatedTarget)) return;
                        flushPendingTextDraft();
                      }
                }
              />
            </div>
            {!isReadOnly && <IpaImePopover ime={ipaIme} />}
            {trigraphPreview && (
              <div className="insp-praat-preview" title="文本含 Praat 转义码时显示实时音标对照">
                <span className="insp-praat-label">
                  {ipaIme.ipaMode === 'off' ? 'Praat 对照' : '音标预览'}
                </span>
                <span className="insp-praat-val selectable">{trigraphPreview}</span>
              </div>
            )}
          </InspectorCard>

          {/* Card 2: 时刻与附近波形 */}
          <InspectorCard
            title="时刻与附近波形"
            badge={<span className="insp-badge is-teal">{activePoint.number.toFixed(3)} s</span>}
          >
            {effectiveAudioBuffer && (
              <BoundaryMicroWave
                audioBuffer={effectiveAudioBuffer}
                timeSec={activePoint.number - audioOffset}
                nearestZeroSec={
                  nearestZeroForWave !== null ? nearestZeroForWave - audioOffset : null
                }
                accentColor="#0D9488"
                disabled={isReadOnly}
                onSnapZero={() => void handleSnapPointZero()}
              />
            )}

            <div className="insp-time-cell">
              <span className="insp-field-label">标注时刻 (s)</span>
              <ScrubNumberInput
                variant="sidebar"
                value={activePoint.number}
                min={activeTier.xmin}
                max={activeTier.xmax}
                disabled={isReadOnly}
                formatValue={formatPraatDouble}
                onCommit={(val) => movePointToTime(ti, pi, val)}
              />
            </div>

            <div className="insp-nudge-row" aria-label="时刻微调">
              <span className="insp-field-label" style={{ paddingLeft: 2 }}>
                微调
              </span>
              <div className="insp-nudge-group" role="group" aria-label="步长">
                {([1, 5, 10] as const).map((step) => (
                  <button
                    key={step}
                    type="button"
                    className={nudgeStepMs === step ? 'active' : ''}
                    disabled={isReadOnly}
                    onClick={() => setNudgeStepMs(step)}
                  >
                    {step}ms
                  </button>
                ))}
              </div>
              <div className="insp-nudge-step-btns">
                <button
                  type="button"
                  disabled={isReadOnly}
                  title={`向左移动 ${nudgeStepMs} ms`}
                  onClick={() => movePointToTime(ti, pi, activePoint.number - nudgeStepMs / 1000)}
                >
                  −
                </button>
                <button
                  type="button"
                  disabled={isReadOnly}
                  title={`向右移动 ${nudgeStepMs} ms`}
                  onClick={() => movePointToTime(ti, pi, activePoint.number + nudgeStepMs / 1000)}
                >
                  +
                </button>
              </div>
            </div>

            <div className="insp-row-wrap">
              <button
                type="button"
                className="insp-btn is-xs"
                style={{ flex: '1 1 0' }}
                disabled={isReadOnly || !effectiveAudioBuffer}
                title="吸附至附近音素或音节声学边界（AcouSeg 1.0）"
                onClick={() => void handleSnapPointAcoustic()}
              >
                吸附声学边界
              </button>
              <button
                type="button"
                className="insp-btn is-xs"
                style={{ flex: '1 1 0' }}
                disabled={isReadOnly || (!analysis && !effectiveAudioBuffer)}
                onClick={() => void handleSnapPointZero()}
              >
                吸附过零点
              </button>
            </div>
            <div className="insp-row-wrap">
              <button
                type="button"
                className="insp-btn is-xs"
                style={{ flex: '1 1 0' }}
                disabled={isReadOnly}
                onClick={handleSnapPointNearestBoundary}
              >
                吸附附近边界
              </button>
              <button
                type="button"
                className="insp-btn is-xs"
                style={{ flex: '1 1 0' }}
                disabled={isReadOnly}
                onClick={handleMovePointIntervalMid}
              >
                移到区间中点
              </button>
            </div>
          </InspectorCard>

          {/* Card 3: 在各层中的位置与声学数据 */}
          {(tierPositions.length > 0 || (analysis && pointInstantAcoustic)) && (
            <InspectorCard title="在各层中的位置与声学数据">
              {tierPositions.length > 0 && (
                <div className="insp-tier-list">
                  {tierPositions.map((pos) => (
                    <div
                      key={`pt-pos-${pos.tierIndex}`}
                      className="insp-progress-row is-clickable"
                      title={`点击跳转到「${pos.tierName}」该区间`}
                      onClick={() => {
                        setSelection({
                          kind: 'interval',
                          tierIndex: pos.tierIndex,
                          itemIndex: pos.itemIndex
                        });
                        const iv = tg.tiers[pos.tierIndex]?.intervals[pos.itemIndex];
                        if (iv) {
                          setPlayRange({ start: iv.xmin, end: iv.xmax });
                          setPlaybackTime(iv.xmin, true);
                        }
                      }}
                    >
                      <div className="insp-progress-head">
                        <span className="insp-progress-label">
                          {pos.tierName} &ldquo;{pos.text.trim() || '空白'}&rdquo;
                        </span>
                        <span className="insp-progress-val">{pos.pct}% 处</span>
                      </div>
                      <div className="insp-progress-track">
                        <div className="insp-progress-fill" style={{ width: `${pos.pct}%` }} />
                        <span className="insp-progress-marker" style={{ left: `${pos.pct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {analysis && pointInstantAcoustic && (
                <>
                  {tierPositions.length > 0 && <div className="insp-divider" />}
                  <div className="insp-kv-grid">
                    <div className="insp-kv-item">
                      <span className="insp-kv-label">瞬时基频 F0</span>
                      <span className="insp-kv-val">{formatHz(pointInstantAcoustic.f0, 1)}</span>
                    </div>
                    <div className="insp-kv-item">
                      <span className="insp-kv-label">F1</span>
                      <span className="insp-kv-val">{formatHz(pointInstantAcoustic.f1, 0)}</span>
                    </div>
                    <div className="insp-kv-item">
                      <span className="insp-kv-label">F2</span>
                      <span className="insp-kv-val">{formatHz(pointInstantAcoustic.f2, 0)}</span>
                    </div>
                    <div className="insp-kv-item">
                      <span className="insp-kv-label">F3</span>
                      <span className="insp-kv-val">{formatHz(pointInstantAcoustic.f3, 0)}</span>
                    </div>
                  </div>
                  <div className="insp-f0-foot">
                    <button
                      type="button"
                      className="insp-btn is-xs"
                      onClick={() =>
                        copyPointAcousticTsv(
                          pointInstantAcoustic,
                          activePoint.number,
                          activePoint.mark
                        )
                      }
                    >
                      复制数据 (TSV)
                    </button>
                  </div>
                </>
              )}
            </InspectorCard>
          )}
        </div>
      );
    }

    // =========================================================================
    // STATE 5A: TIER SELECTED
    // =========================================================================
    if (selection?.kind === 'tier' && activeTier) {
      const ti = selection.tierIndex;
      const totalItems =
        activeTier.kind === 'intervalTier' ? activeTier.intervals.length : activeTier.points.length;
      const filledItems =
        activeTier.kind === 'intervalTier'
          ? activeTier.intervals.filter((iv) => iv.text.trim() !== '').length
          : activeTier.points.filter((pt) => pt.mark.trim() !== '').length;
      const fillPct = totalItems > 0 ? Math.round((filledItems / totalItems) * 100) : 0;

      const isHidden = hiddenTierIndices.includes(ti);
      const isSolo =
        tg.tiers.length > 1 &&
        !isHidden &&
        hiddenTierIndices.length === tg.tiers.length - 1;

      const commitTierName = () => {
        if (skipNextBlurRef.current) {
          skipNextBlurRef.current = false;
          return;
        }
        if (isReadOnly) return;
        if (tierNameInput !== activeTier.name) {
          const nextName = tierNameInput;
          const prevName = activeTier.name;
          tierNameDraftRef.current.origName = nextName;
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
        }
      };

      const stepTier = (delta: -1 | 1) => {
        const nextIdx = ti + delta;
        if (nextIdx < 0 || nextIdx >= tg.tiers.length) return;
        commitTierName();
        setSelection({ kind: 'tier', tierIndex: nextIdx });
      };

      return (
        <div className="insp-root">
          {renderObjectHeader({
            accentClass: 'accent-tier',
            accentColor: '#475569',
            typeLabel: '层级',
            title: activeTier.name || `第 ${ti + 1} 层`,
            sub: `${activeTier.kind === 'intervalTier' ? '区间层' : '点层'} · ${totalItems} 项`,
            stepper: {
              current: ti + 1,
              total: tg.tiers.length,
              onPrev: () => stepTier(-1),
              onNext: () => stepTier(1),
              prevTitle: '上一层',
              nextTitle: '下一层'
            }
          })}
          {readOnlyBanner}
          {renderObjectIssueBar()}

          <InspectorCard
            title="层级信息"
            badge={
              <span className={`insp-badge ${activeTier.kind === 'intervalTier' ? 'is-blue' : 'is-purple'}`}>
                {activeTier.kind === 'intervalTier' ? '区间层' : '点层'}
              </span>
            }
          >
            <label className="sb-field">
              <span className="insp-field-label">层级名称</span>
              <input
                type="text"
                readOnly={isReadOnly}
                disabled={isReadOnly}
                value={tierNameInput}
                onChange={
                  isReadOnly
                    ? undefined
                    : (e) => {
                        setTierNameInput(e.target.value);
                        tierNameDraftRef.current.val = e.target.value;
                      }
                }
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

            <div className="insp-kv-grid">
              <div className="insp-kv-item">
                <span className="insp-kv-label">总条目</span>
                <span className="insp-kv-val">
                  {totalItems} {activeTier.kind === 'intervalTier' ? '段' : '点'}
                </span>
              </div>
              <div className="insp-kv-item">
                <span className="insp-kv-label">已填写</span>
                <span className="insp-kv-val">
                  {filledItems} ({fillPct}%)
                </span>
              </div>
              <div className="insp-kv-item is-wide">
                <span className="insp-kv-label">时间范围</span>
                <span className="insp-kv-val">
                  {formatPraatDouble(activeTier.xmin)} – {formatPraatDouble(activeTier.xmax)} s
                </span>
              </div>
            </div>

            <div className="insp-progress-row">
              <div className="insp-progress-head">
                <span className="insp-progress-label">填写进度</span>
                <span className="insp-progress-val">
                  {filledItems} / {totalItems} ({fillPct}%)
                </span>
              </div>
              <div className="insp-progress-track">
                <div className="insp-progress-fill" style={{ width: `${fillPct}%` }} />
              </div>
            </div>

            <div className="insp-divider" />

            <div className="insp-inline-row" style={{ marginBottom: 6 }}>
              <span className="insp-field-label" style={{ marginBottom: 0 }}>
                时间比例
              </span>
              {(() => {
                const curTierScale = resolveTierScaleMode(
                  tg,
                  ti,
                  scaleMode,
                  tierScaleOverrides
                );
                return (
                  <div className="segmented" role="group" aria-label="本层时间比例">
                    <button
                      type="button"
                      className={`compact ${curTierScale === 'linear' ? 'active' : ''}`}
                      aria-pressed={curTierScale === 'linear'}
                      title="按 1:1 真实物理时长与语谱图垂直对齐"
                      onClick={() => setTierScaleMode(ti, 'linear')}
                    >
                      线性 (1:1)
                    </button>
                    <button
                      type="button"
                      className={`compact ${curTierScale === 'elastic' ? 'active' : ''}`}
                      aria-pressed={curTierScale === 'elastic'}
                      title="按文字宽度自适应展开，便于阅读密集标注"
                      onClick={() => setTierScaleMode(ti, 'elastic')}
                    >
                      自适应双尺
                    </button>
                  </div>
                );
              })()}
            </div>

            <ToggleSwitch
              compact
              label="隐藏此层"
              checked={isHidden}
              onChange={() => toggleTierVisibility(ti)}
            />
            <ToggleSwitch
              compact
              label="仅看此层"
              disabled={tg.tiers.length <= 1}
              checked={isSolo}
              onChange={(next) => {
                if (next) soloTier(ti);
                else showAllTiers();
              }}
            />
          </InspectorCard>
        </div>
      );
    }

    // =========================================================================
    // STATE 5B: PLAY RANGE ACTIVE (NO OBJECT SELECTED)
    // =========================================================================
    if (playRange && playRange.end > playRange.start) {
      const durSec = Math.max(0, playRange.end - playRange.start);
      const durMs = durSec * 1000;
      const showMidFormants = durSec <= 0.3;

      const applyRangePatch = (patch: { start?: number; end?: number; duration?: number }): boolean => {
        let nextStart = playRange.start;
        let nextEnd = playRange.end;
        const curDur = playRange.end - playRange.start;

        if (patch.duration !== undefined) {
          const d = Math.max(0.0001, patch.duration);
          if (rangeAnchor === 'end') {
            nextStart = round6(Math.max(tg.xmin, playRange.end - d));
          } else {
            nextEnd = round6(Math.min(tg.xmax, playRange.start + d));
          }
        } else if (patch.start !== undefined) {
          const clamped = round6(Math.max(tg.xmin, Math.min(tg.xmax, patch.start)));
          if (rangeAnchor === 'duration') {
            const maxStart = Math.max(tg.xmin, tg.xmax - curDur);
            nextStart = round6(Math.min(clamped, maxStart));
            nextEnd = round6(Math.min(tg.xmax, nextStart + curDur));
          } else {
            nextStart = clamped;
          }
        } else if (patch.end !== undefined) {
          const clamped = round6(Math.max(tg.xmin, Math.min(tg.xmax, patch.end)));
          if (rangeAnchor === 'duration') {
            const minEnd = Math.min(tg.xmax, tg.xmin + curDur);
            nextEnd = round6(Math.max(clamped, minEnd));
            nextStart = round6(Math.max(tg.xmin, nextEnd - curDur));
          } else {
            nextEnd = clamped;
          }
        }

        if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextEnd <= nextStart + 1e-6) {
          showToast('选区结束时间必须大于起始时间', true);
          return false;
        }
        setPlayRange({ start: nextStart, end: nextEnd });
        setPlaybackTime(nextStart, true);
        return true;
      };

      const intervalTiers = tg.tiers
        .map((t, idx) => ({ tier: t, idx }))
        .filter((x) => x.tier.kind === 'intervalTier');

      return (
        <div className="insp-root">
          {renderObjectHeader({
            accentClass: 'accent-range',
            accentColor: '#2563EB',
            typeLabel: '选区',
            title: `${playRange.start.toFixed(3)} – ${playRange.end.toFixed(3)} s`,
            sub: `时长 ${formatDurationBadge(durSec)}`
          })}
          {readOnlyBanner}

          <InspectorCard
            title="选区时间与时长"
            badge={<span className="insp-badge is-blue">{formatDurationBadge(durSec)}</span>}
          >
            <div className="insp-anchor-group" role="group" aria-label="选区固定方式">
              {(
                [
                  ['start', '固定起点'],
                  ['duration', '固定时长'],
                  ['end', '固定终点']
                ] as const
              ).map(([aKey, aLabel]) => (
                <button
                  key={aKey}
                  type="button"
                  className={rangeAnchor === aKey ? 'active' : ''}
                  onClick={() => setRangeAnchor(aKey)}
                >
                  {aLabel}
                </button>
              ))}
            </div>

            <div className="insp-time-grid">
              <div className="insp-time-cell">
                <span className="insp-field-label">起始 (s)</span>
                <ScrubNumberInput
                  variant="sidebar"
                  value={playRange.start}
                  min={tg.xmin}
                  max={rangeAnchor === 'duration' ? tg.xmax - durSec : playRange.end}
                  strictMax={rangeAnchor !== 'duration'}
                  formatValue={formatPraatDouble}
                  onCommit={(val) => applyRangePatch({ start: val })}
                />
              </div>
              <div className="insp-time-cell">
                <span className="insp-field-label">结束 (s)</span>
                <ScrubNumberInput
                  variant="sidebar"
                  value={playRange.end}
                  min={rangeAnchor === 'duration' ? tg.xmin + durSec : playRange.start}
                  strictMin={rangeAnchor !== 'duration'}
                  max={tg.xmax}
                  formatValue={formatPraatDouble}
                  onCommit={(val) => applyRangePatch({ end: val })}
                />
              </div>
              <div className="insp-time-cell is-span-2">
                <span className="insp-field-label">时长 (ms)</span>
                <ScrubNumberInput
                  variant="sidebar"
                  value={durMs}
                  min={0.1}
                  stepSec={1}
                  fineStepSec={0.1}
                  coarseStepSec={10}
                  decimals={1}
                  onCommit={(valMs) => applyRangePatch({ duration: valMs / 1000 })}
                />
              </div>
            </div>

            <button
              type="button"
              className="insp-btn is-xs is-full"
              onClick={() => setPlayRange(null)}
            >
              清除时间选区
            </button>
          </InspectorCard>

          {analysis && rangeAcoustic && (
            <InspectorCard
              title="声学数据"
              badge={
                rangeAcoustic.f0Mean ? (
                  <span className="insp-badge is-blue">{rangeAcoustic.f0Mean.toFixed(0)} Hz</span>
                ) : undefined
              }
            >
              <IntervalF0Sparkline
                pitchTrack={analysis.pitchTrack}
                xmin={playRange.start}
                xmax={playRange.end}
                meanF0={rangeAcoustic.f0Mean}
                minF0={rangeAcoustic.f0Min}
                maxF0={rangeAcoustic.f0Max}
                voicedRatio={rangeAcoustic.voicedRatio}
                rmsDb={rangeAcoustic.rmsDb}
                formants={
                  showMidFormants
                    ? { f1: rangeAcoustic.f1, f2: rangeAcoustic.f2, f3: rangeAcoustic.f3 }
                    : null
                }
                onCopyTsv={() => copyAcousticTsv(rangeAcoustic, playRange.start, playRange.end)}
              />
            </InspectorCard>
          )}

          {intervalTiers.length > 0 && (
            <InspectorCard title="按选区新建区间">
              <div className="insp-tier-list">
                {intervalTiers.map(({ tier, idx }) => (
                  <div key={`cr-${idx}`} className="insp-tier-row">
                    <div className="insp-tier-row-main">
                      <span className="insp-tier-row-name">{tier.name || `第 ${idx + 1} 层`}</span>
                      <span className="insp-tier-row-meta">{tier.intervals.length} 段区间</span>
                    </div>
                    <button
                      type="button"
                      className="insp-btn insp-btn-soft is-xs"
                      disabled={isReadOnly}
                      onClick={() => handleCreateIntervalFromPlayRange(idx)}
                    >
                      在此层新建区间
                    </button>
                  </div>
                ))}
              </div>
            </InspectorCard>
          )}
        </div>
      );
    }

    // =========================================================================
    // STATE 5C: PURE EMPTY SELECTION — DOCUMENT OVERVIEW + GLOBAL DATA CHECK
    // =========================================================================
    const totalIntervals = tg.tiers.reduce(
      (acc, t) => acc + (t.kind === 'intervalTier' ? t.intervals.length : 0),
      0
    );
    const totalPoints = tg.tiers.reduce(
      (acc, t) => acc + (t.kind === 'textTier' ? t.points.length : 0),
      0
    );
    const totalDur = Math.max(
      0,
      (Number.isFinite(tg.xmax) ? tg.xmax : 0) - (Number.isFinite(tg.xmin) ? tg.xmin : 0)
    );

    const { counts } = qaScan;
    const structAnomalyTotal = counts.gaps + counts.overlaps + counts.zeros + counts.outOfDomain;
    const qaTotalCount = counts.total;
    const hasQaIssues = qaTotalCount > 0;

    const allQaFilterTabs: Array<{ key: QaFilterKey; label: string; count: number }> = [
      { key: 'all', label: '全部', count: qaScan.issues.length },
      { key: 'gap', label: '空隙', count: counts.gaps },
      { key: 'overlap', label: '重叠', count: counts.overlaps },
      { key: 'micro', label: '极短/微偏', count: counts.microSegments + counts.crossMicros },
      { key: 'space', label: '空格', count: counts.spaces },
      { key: 'zero', label: '零长', count: counts.zeros },
      { key: 'ood', label: '越界', count: counts.outOfDomain }
    ];
    const qaFilterTabs = allQaFilterTabs.filter((tab) => tab.key === 'all' || tab.count > 0);

    const effectiveQaFilter: QaFilterKey = qaFilterTabs.some((t) => t.key === qaFilter)
      ? qaFilter
      : 'all';
    const visibleQaIssues =
      effectiveQaFilter === 'all'
        ? qaScan.issues
        : qaScan.issues.filter((iss) => iss.kind === effectiveQaFilter);

    return (
      <div className="insp-root">
        {renderObjectHeader({
          accentClass: 'accent-doc',
          accentColor: '#475569',
          typeLabel: '文档',
          title: filename,
          sub: `${tg.tiers.length} 层 · 总长 ${totalDur.toFixed(3)} s`
        })}
        {readOnlyBanner}

        {/* 文档概览 */}
        <InspectorCard
          title="文档概览"
          badge={<span className="insp-badge">{tg.tiers.length} 层</span>}
        >
          <div className="sb-kv-list">
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
        </InspectorCard>

        {/* 各层填写进度 */}
        {tg.tiers.length > 0 && (
          <InspectorCard title="各层填写进度">
            <div className="insp-tier-list">
              {tg.tiers.map((tier, idx) => {
                const total =
                  tier.kind === 'intervalTier' ? tier.intervals.length : tier.points.length;
                const filled =
                  tier.kind === 'intervalTier'
                    ? tier.intervals.filter((iv) => iv.text.trim() !== '').length
                    : tier.points.filter((pt) => pt.mark.trim() !== '').length;
                const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
                const isHidden = hiddenTierIndices.includes(idx);
                return (
                  <div
                    key={`doc-tier-${idx}`}
                    className="insp-progress-row is-clickable"
                    title={`点击选中「${tier.name || `第 ${idx + 1} 层`}」`}
                    onClick={() => setSelection({ kind: 'tier', tierIndex: idx })}
                  >
                    <div className="insp-progress-head">
                      <span className="insp-progress-label">
                        {tier.name || `第 ${idx + 1} 层`}
                        {isHidden ? '（已隐藏）' : ''}
                      </span>
                      <span className="insp-progress-val">
                        {filled}/{total} · {pct}%
                      </span>
                    </div>
                    <div className="insp-progress-track">
                      <div className="insp-progress-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </InspectorCard>
        )}

        {/* 全局数据检查中心（仅在纯空选态展示） */}
        <InspectorCard
          title="数据检查"
          badge={
            <span className={`insp-badge ${hasQaIssues ? 'is-amber' : 'is-teal'}`}>
              {hasQaIssues ? `${qaTotalCount} 项异常` : '无异常'}
            </span>
          }
        >
          {hasQaIssues && qaFilterTabs.length > 1 && (
            <div className="insp-row-wrap" role="tablist" aria-label="异常类型筛选">
              {qaFilterTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={effectiveQaFilter === tab.key}
                  className={`insp-btn is-xs ${effectiveQaFilter === tab.key ? 'insp-btn-soft' : ''}`}
                  onClick={() => setQaFilter(tab.key)}
                >
                  {tab.label} ({tab.count})
                </button>
              ))}
            </div>
          )}

          {visibleQaIssues.length > 0 ? (
            <>
              <div className="qa-issue-list" role="list" aria-label="数据检查异常列表">
                {visibleQaIssues.map((issue) => {
                  const isActive = isSameQaTarget(selection, issue.targetSelection);
                  const fixActionMeta: { label: string; title: string } | null =
                    issue.fixableKind === 'micro-cross'
                      ? { label: '对齐', title: `对齐「${issue.tierName}」跨层微偏边界 (< 5 ms)` }
                      : issue.fixableKind === 'gap-fill'
                        ? { label: '补', title: '插入空白区间填补此处空隙' }
                        : issue.fixableKind === 'zero-delete'
                          ? { label: '删', title: '删除该零时长区间' }
                          : issue.fixableKind === 'overlap-resolve'
                            ? { label: '齐', title: '截断交叠边界以消除重叠（保留非空文本）' }
                            : issue.fixableKind === 'ood-tier'
                              ? { label: '齐', title: '将此层级范围对齐至文档全局起止' }
                              : issue.fixableKind === 'space-interval' ||
                                  issue.fixableKind === 'space-point'
                                ? { label: '修', title: '清理首尾多余空格' }
                                : null;
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
                        <span
                          className="qa-issue-text"
                          title={`${issue.detail} (${issue.time.toFixed(4)} s)`}
                        >
                          {issue.detail}
                        </span>
                      </div>
                      <span className="qa-issue-time">{issue.time.toFixed(3)}s</span>
                      {!isReadOnly && fixActionMeta && (
                        <button
                          type="button"
                          className="qa-issue-fix-btn"
                          title={fixActionMeta.title}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSingleRowQaFix(issue);
                          }}
                        >
                          {fixActionMeta.label}
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
          ) : (
            <div className="sb-status-ok">
              <UiIcon name="check" size={13} />
              <span>各层起止对齐且区间连续，未发现结构、微偏或空格异常。</span>
            </div>
          )}

          <div className="insp-row-wrap">
            <button
              type="button"
              className="insp-btn is-xs"
              style={{ flex: '1 1 0' }}
              disabled={isReadOnly}
              title={
                isReadOnly
                  ? '请先切换至编辑模式'
                  : '将跨层间距小于 5 ms 的微偏边界对齐至上层参考时刻'
              }
              onClick={() => {
                if (isReadOnly) return;
                const res = alignMicroBoundaries();
                const fb = formatAlignMicroFeedback(res);
                showToast(fb.message, fb.isError);
              }}
            >
              <UiIcon name="zeroCross" size={12} />
              <span>对齐微偏边界</span>
            </button>
            <button
              type="button"
              className={`insp-btn is-xs ${structAnomalyTotal > 0 ? 'insp-btn-primary' : ''}`}
              style={{ flex: '1 1 0' }}
              disabled={isReadOnly}
              title={isReadOnly ? '请先切换至编辑模式' : '统一各层起止范围并补齐连续区间'}
              onClick={() => {
                if (!isReadOnly) normalizeTextGrid();
              }}
            >
              <UiIcon name="normalize" size={12} />
              <span>整理边界</span>
            </button>
          </div>
        </InspectorCard>
      </div>
    );
  }
);
