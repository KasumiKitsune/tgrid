import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getPlatformBridge, isTauriRuntime } from '../bridge/PlatformBridge';
import type { BuiltinSampleId } from '../data/samples';
import {
  AutoPlayIcon,
  AutoSplitIcon,
  CorpusExportZipIcon,
  CorpusFolderIcon,
  CorpusNextIcon,
  CorpusPrevIcon,
  CorpusSidebarToggleIcon
} from '../corpus/corpusIcons';
import {
  decodeTrigraphGlossSync,
  formatPraatDouble,
  primeTrigraphString
} from '../layout/richText';
import {
  IS_MAC,
  formatKeyCombo,
  getEffectiveShortcutHint,
  isComposingEvent
} from '../shortcuts/registry';
import {
  canRedoTimeline,
  canUndoTimeline,
  formatDurationLabel,
  formatQuote,
  formatTierLabel,
  formatTimeSec,
  formatTimeSpan,
  getLatestRedoEntry,
  getLatestUndoEntry
} from '../store/historyModel';
import { useEditorStore, type RibbonTabId } from '../store/useEditorStore';
import { alignSplitBoundariesAcoustically } from '../utils/acousticSplitClient';
import {
  resolveSplitSourceText,
  splitTextByDelimiter,
  splitTextIntoChars
} from '../utils/intervalSplit';
import { analyzeMultiSelection } from '../utils/multiSelection';
import { formatAlignMicroFeedback } from '../utils/qaDiagnostics';
import { inferSmartSplit, type SmartSplitCandidate } from '../utils/smartSplit';
import { PALETTES, getPalette } from '../style/palettes';
import {
  TIME_MATCH_EPS,
  resolveBoundaryStyle,
  resolveIntervalStyle,
  resolvePointStyle,
  resolveTierStyle
} from '../style/resolveStyle';
import type {
  BoundaryStylePatch,
  IntervalStylePatch,
  PatternKind,
  PointShape,
  PointStylePatch,
  StyleBrush
} from '../style/types';
import { getElementRectScale } from '../utils/uiScale';
import { ChevronIcon, UiIcon } from './Icons';
import {
  PATTERN_OPTIONS,
  POINT_SHAPE_OPTIONS,
  PointShapeIcon,
  SwatchVisualFill
} from './sidebar/styleVisuals';
import type { ExportActionKind } from './Topbar';
import '../styles/stylePanel.css';

export interface RibbonContextActions {
  audioBuffer: AudioBuffer | null;
  onStartPlayback: (startT: number, endT: number) => void;
  onStopPlayback?: () => void;
  onOpenSplitModal: (tierIndex: number, itemIndex: number) => void;
}

const RibbonActionsContext = React.createContext<RibbonContextActions | null>(null);

export const RibbonContextProvider = RibbonActionsContext.Provider;

export interface RibbonBarProps {
  onOpenTextGridPicker: () => void;
  onOpenCorpusFolder: () => void;
  onOpenAudioPicker: () => void;
  onLoadSample: (id: BuiltinSampleId) => void;
  onExportAction: (kind: ExportActionKind) => void;
  onBatchConvertIpa: (direction: 'toUnicode' | 'toPraat') => void;
  audioBuffer?: AudioBuffer | null;
  onStartPlayback?: (startT: number, endT: number) => void;
  onOpenSplitModal?: (tierIndex: number, itemIndex: number) => void;
  corpusCanPrev?: boolean;
  corpusCanNext?: boolean;
  onCorpusPrev?: () => void;
  onCorpusNext?: () => void;
  onToggleCorpusAutoPlay?: () => void;
  onToggleCorpusAutoVad?: () => void;
  onCorpusSaveCurrent?: () => void;
  onCorpusSaveAll?: () => void;
  onToggleCorpusAutoSave?: () => void;
  corpusSaveProgress?: { done: number; total: number } | null;
  onExportCorpusZip?: () => void;
  exportingCorpusZip?: boolean;
}

type ContextualTabKind = 'multi' | 'interval' | 'boundary' | 'point' | 'tier';

type RibbonPopoutMenuId =
  | 'export'
  | 'samples'
  | 'col'
  | 'smart-split'
  | 'copy-interval-tier'
  | 'project-boundary'
  | 'derive-point-tier'
  | 'style-palette';

interface PopoutPos {
  left: number;
  top: number;
}

const BASE_TABS: Array<{ id: RibbonTabId; label: string }> = [
  { id: 'file', label: '文件' },
  { id: 'annotate', label: '标注' },
  { id: 'tiers', label: '层与时间' },
  { id: 'view', label: '视图' },
  { id: 'tools', label: '工具' }
];

function round6(t: number): number {
  return Number(t.toFixed(6));
}

function collectPeerTexts(
  intervals: readonly { text: string }[],
  selfIndex: number,
  maxEachSide = 20
): string[] {
  const peers: string[] = [];
  let leftCount = 0;
  for (let idx = selfIndex - 1; idx >= 0 && leftCount < maxEachSide; idx--) {
    const t = intervals[idx]?.text.trim();
    if (t) {
      peers.push(t);
      leftCount++;
    }
  }
  let rightCount = 0;
  for (let idx = selfIndex + 1; idx < intervals.length && rightCount < maxEachSide; idx++) {
    const t = intervals[idx]?.text.trim();
    if (t) {
      peers.push(t);
      rightCount++;
    }
  }
  return peers;
}

const CUE_MODES: Array<{ id: 'auto' | 'pitch' | 'formant' | 'plain'; label: string; title: string }> = [
  { id: 'auto', label: '自动', title: '根据语音与声学特征自动叠加提示曲线' },
  { id: 'pitch', label: '基频', title: '在语谱图上叠加基频曲线 (F0)' },
  { id: 'formant', label: '共振峰', title: '在语谱图上叠加共振峰轨迹 (F1–F3)' },
  { id: 'plain', label: '纯语谱', title: '仅显示宽带语谱图，不叠加声学曲线' }
];

const preventBlur = (e: React.MouseEvent) => {
  e.preventDefault();
};

export const RibbonBar: React.FC<RibbonBarProps> = ({
  onOpenTextGridPicker,
  onOpenCorpusFolder,
  onOpenAudioPicker,
  onLoadSample,
  onExportAction,
  onBatchConvertIpa,
  audioBuffer: audioBufferProp,
  onStartPlayback: onStartPlaybackProp,
  onOpenSplitModal: onOpenSplitModalProp,
  corpusCanPrev,
  corpusCanNext,
  onCorpusPrev,
  onCorpusNext,
  onToggleCorpusAutoPlay,
  onToggleCorpusAutoVad,
  onCorpusSaveCurrent,
  onCorpusSaveAll,
  onToggleCorpusAutoSave,
  corpusSaveProgress,
  onExportCorpusZip,
  exportingCorpusZip = false
}) => {
  const isDesktop = isTauriRuntime();
  const ctxActions = useContext(RibbonActionsContext);
  const audioBuffer = audioBufferProp !== undefined ? audioBufferProp : (ctxActions?.audioBuffer ?? null);
  const onStartPlayback = onStartPlaybackProp ?? ctxActions?.onStartPlayback;
  const onStopPlayback = ctxActions?.onStopPlayback;
  const onOpenSplitModal = onOpenSplitModalProp ?? ctxActions?.onOpenSplitModal;

  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const currentFilePath = useEditorStore((s) => s.currentFilePath);
  const tg = useEditorStore((s) => s.tg);
  const collectionTgs = useEditorStore((s) => s.collectionTgs);
  const collectionActiveIdx = useEditorStore((s) => s.collectionActiveIdx);
  const switchCollectionItem = useEditorStore((s) => s.switchCollectionItem);
  const history = useEditorStore((s) => s.history);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);

  const ribbonTab = useEditorStore((s) => s.ribbonTab);
  const setRibbonTab = useEditorStore((s) => s.setRibbonTab);
  const ribbonCollapsed = useEditorStore((s) => s.ribbonCollapsed);
  const setRibbonCollapsed = useEditorStore((s) => s.setRibbonCollapsed);
  const toggleRibbonCollapsed = useEditorStore((s) => s.toggleRibbonCollapsed);
  const autoSwitchContextualRibbon = useEditorStore((s) => s.autoSwitchContextualRibbon);
  const smartSplitUseAcoustic = useEditorStore((s) => s.smartSplitUseAcoustic);
  const setSmartSplitUseAcoustic = useEditorStore((s) => s.setSmartSplitUseAcoustic);

  const selection = useEditorStore((s) => s.selection);
  const multiSelection = useEditorStore((s) => s.multiSelection);
  const playRange = useEditorStore((s) => s.playRange);
  const setPlayRange = useEditorStore((s) => s.setPlayRange);
  const setPlaybackTime = useEditorStore((s) => s.setPlaybackTime);
  const viewDomain = useEditorStore((s) => s.viewDomain);
  const setViewDomain = useEditorStore((s) => s.setViewDomain);
  const loop = useEditorStore((s) => s.loop);
  const playing = useEditorStore((s) => s.playing);
  const setLoop = useEditorStore((s) => s.setLoop);
  const hiddenTierIndices = useEditorStore((s) => s.hiddenTierIndices);
  const analysis = useEditorStore((s) => s.analysis);
  const openExportModal = useEditorStore((s) => s.openExportModal);

  // Contextual editing actions
  const splitInterval = useEditorStore((s) => s.splitInterval);
  const splitIntervalEqualN = useEditorStore((s) => s.splitIntervalEqualN);
  const splitIntervalByChars = useEditorStore((s) => s.splitIntervalByChars);
  const splitIntervalByDelimiter = useEditorStore((s) => s.splitIntervalByDelimiter);
  const splitIntervalWithCuts = useEditorStore((s) => s.splitIntervalWithCuts);
  const mergeIntervalWith = useEditorStore((s) => s.mergeIntervalWith);
  const copyIntervalSpanToTier = useEditorStore((s) => s.copyIntervalSpanToTier);
  const transformAlignedBlock = useEditorStore((s) => s.transformAlignedBlock);
  const convertSelectionIpa = useEditorStore((s) => s.convertSelectionIpa);
  const mergeMultiSelection = useEditorStore((s) => s.mergeMultiSelection);
  const clearMultiSelectionText = useEditorStore((s) => s.clearMultiSelectionText);
  const clearMultiSelection = useEditorStore((s) => s.clearMultiSelection);
  const alignMultiSelectionBounds = useEditorStore((s) => s.alignMultiSelectionBounds);
  const syncTransformMultiSelection = useEditorStore((s) => s.syncTransformMultiSelection);
  const moveTierBoundary = useEditorStore((s) => s.moveTierBoundary);
  const moveSharedTimestamp = useEditorStore((s) => s.moveSharedTimestamp);
  const projectBoundaryToTier = useEditorStore((s) => s.projectBoundaryToTier);
  const deleteBoundaryAt = useEditorStore((s) => s.deleteBoundaryAt);
  const deleteBoundaryAcrossAllTiers = useEditorStore((s) => s.deleteBoundaryAcrossAllTiers);
  const alignMicroBoundaries = useEditorStore((s) => s.alignMicroBoundaries);
  const movePointToTime = useEditorStore((s) => s.movePointToTime);
  const duplicateTier = useEditorStore((s) => s.duplicateTier);
  const derivePointTierFromIntervals = useEditorStore((s) => s.derivePointTierFromIntervals);
  const moveTier = useEditorStore((s) => s.moveTier);
  const toggleTierVisibility = useEditorStore((s) => s.toggleTierVisibility);
  const soloTier = useEditorStore((s) => s.soloTier);
  const clearTierText = useEditorStore((s) => s.clearTierText);
  const removeTierWithUndoToast = useEditorStore((s) => s.removeTierWithUndoToast);

  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const isReadOnly = mode === 'read';

  const ipaMode = useEditorStore((s) => s.ipaMode);
  const setIpaMode = useEditorStore((s) => s.setIpaMode);
  const ipaDockOpen = useEditorStore((s) => s.ipaDockOpen);
  const setIpaDockOpen = useEditorStore((s) => s.setIpaDockOpen);

  const legendOpen = useEditorStore((s) => s.legendOpen);
  const toggleLegend = useEditorStore((s) => s.toggleLegend);
  const sidebarOpen = useEditorStore((s) => s.sidebarOpen);
  const sidebarTab = useEditorStore((s) => s.sidebarTab);
  const setSidebarOpen = useEditorStore((s) => s.setSidebarOpen);
  const toggleSidebarTab = useEditorStore((s) => s.toggleSidebarTab);

  const scaleMode = useEditorStore((s) => s.scaleMode);
  const setScaleMode = useEditorStore((s) => s.setScaleMode);
  const wrapMode = useEditorStore((s) => s.wrapMode);
  const setWrapMode = useEditorStore((s) => s.setWrapMode);
  const audioName = useEditorStore((s) => s.audioName);
  const showSpectrogram = useEditorStore((s) => s.showSpectrogram);
  const setShowSpectrogram = useEditorStore((s) => s.setShowSpectrogram);
  const cueMode = useEditorStore((s) => s.cueMode);
  const setCueMode = useEditorStore((s) => s.setCueMode);
  const canvasScale = useEditorStore((s) => s.canvasScale);
  const setCanvasScale = useEditorStore((s) => s.setCanvasScale);

  const insertTierAt = useEditorStore((s) => s.insertTierAt);
  const normalizeTextGrid = useEditorStore((s) => s.normalizeTextGrid);
  const commitTgMutation = useEditorStore((s) => s.commitTgMutation);
  const showToast = useEditorStore((s) => s.showToast);

  const openFindBar = useEditorStore((s) => s.openFindBar);
  const setShortcutsOpen = useEditorStore((s) => s.setShortcutsOpen);
  const setAboutOpen = useEditorStore((s) => s.setAboutOpen);
  const preferencesOpen = useEditorStore((s) => s.preferencesOpen);
  const preferencesSection = useEditorStore((s) => s.preferencesSection);
  const setPreferencesOpen = useEditorStore((s) => s.setPreferencesOpen);
  const customShortcuts = useEditorStore((s) => s.customShortcuts);

  const showCorpusStatusMarks = useEditorStore((s) => s.showCorpusStatusMarks);
  const setShowCorpusStatusMarks = useEditorStore((s) => s.setShowCorpusStatusMarks);
  const corpusAutoSave = useEditorStore((s) => s.corpusAutoSave);
  const isDirty = useEditorStore((s) => s.isDirty);
  const toggleCorpusSidebar = useEditorStore((s) => s.toggleCorpusSidebar);
  const setCorpusOptions = useEditorStore((s) => s.setCorpusOptions);

  // Appearance & Style state / actions
  const styleDoc = useEditorStore((s) => s.styleDoc);
  const styleBrush = useEditorStore((s) => s.styleBrush);
  const setStylePalette = useEditorStore((s) => s.setStylePalette);
  const setStyleBwPrintMode = useEditorStore((s) => s.setStyleBwPrintMode);
  const setStyleShowLegend = useEditorStore((s) => s.setStyleShowLegend);
  const setIntervalStyle = useEditorStore((s) => s.setIntervalStyle);
  const setMultiIntervalStyle = useEditorStore((s) => s.setMultiIntervalStyle);
  const setBoundaryStyle = useEditorStore((s) => s.setBoundaryStyle);
  const setPointStyle = useEditorStore((s) => s.setPointStyle);
  const setTierStyle = useEditorStore((s) => s.setTierStyle);
  const clearSelectionStyle = useEditorStore((s) => s.clearSelectionStyle);
  const setStyleBrush = useEditorStore((s) => s.setStyleBrush);
  const clearStyleBrush = useEditorStore((s) => s.clearStyleBrush);

  const activePalette = useMemo(() => getPalette(styleDoc.paletteId), [styleDoc.paletteId]);

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);
  const activeCorpus = activeTab?.kind === 'corpus' ? (activeTab.corpus ?? null) : null;
  const isCorpus = Boolean(activeCorpus);

  // If user switches to a single-file tab while on 'corpus', fall back to 'annotate'
  useEffect(() => {
    if (!isCorpus && ribbonTab === 'corpus') {
      setRibbonTab('annotate');
    }
  }, [isCorpus, ribbonTab, setRibbonTab]);

  const effectiveBaseTab: RibbonTabId = !isCorpus && ribbonTab === 'corpus' ? 'annotate' : ribbonTab;

  // Derive active contextual object tab kind (works in both sidebar and floating bar modes)
  const contextualKind: ContextualTabKind | null = useMemo(() => {
    if (multiSelection.length >= 2) return 'multi';
    if (!selection) return null;
    if (selection.kind === 'interval') return 'interval';
    if (selection.kind === 'boundary' || selection.kind === 'spine') return 'boundary';
    if (selection.kind === 'point') return 'point';
    if (selection.kind === 'tier') return 'tier';
    return null;
  }, [multiSelection.length, selection]);

  const contextualTabLabel = useMemo(() => {
    if (contextualKind === 'multi') return `多选 (${multiSelection.length})`;
    if (contextualKind === 'interval') return '区间';
    if (contextualKind === 'boundary') {
      return selection?.kind === 'spine' ? '对齐时刻' : '边界';
    }
    if (contextualKind === 'point') return '标点';
    if (contextualKind === 'tier') return '层级';
    return '';
  }, [contextualKind, multiSelection.length, selection?.kind]);

  // Smart contextual tab state machine (auto-enter, auto-return, anti-disturbance manual lock)
  const [showContextualTab, setShowContextualTab] = useState(false);
  const prevContextualKindRef = useRef<ContextualTabKind | null>(null);
  const manualBaseLockKindRef = useRef<ContextualTabKind | null>(null);

  useEffect(() => {
    const prevKind = prevContextualKindRef.current;
    if (contextualKind === prevKind) return;
    prevContextualKindRef.current = contextualKind;

    if (contextualKind === null) {
      manualBaseLockKindRef.current = null;
      setShowContextualTab(false);
      return;
    }

    // Object kind changed (or entered from null): lift any previous manual lock
    manualBaseLockKindRef.current = null;

    // Only auto-switch when editing, preference enabled, and ribbon is expanded
    if (!isReadOnly && autoSwitchContextualRibbon && !ribbonCollapsed) {
      setShowContextualTab(true);
    } else {
      // Read-only or collapsed or auto-switch off: never force-switch or expand
      setShowContextualTab(false);
    }
  }, [contextualKind, isReadOnly, autoSwitchContextualRibbon, ribbonCollapsed]);

  const isContextualViewActive = Boolean(contextualKind && showContextualTab);
  const effectiveTab: RibbonTabId = effectiveBaseTab;

  // Local state for boundary linkage mode and Praat trigraph decode refresh
  const [boundaryShared, setBoundaryShared] = useState(false);
  const [trigraphTick, setTrigraphTick] = useState(0);
  const [smartSplitBusy, setSmartSplitBusy] = useState(false);
  const smartSplitSeqRef = useRef(0);

  // Active selection resolved entities
  const activeIntervalTier =
    selection?.kind === 'interval' ? tg.tiers[selection.tierIndex] ?? null : null;
  const activeInterval =
    selection?.kind === 'interval' && activeIntervalTier?.kind === 'intervalTier'
      ? activeIntervalTier.intervals[selection.itemIndex] ?? null
      : null;

  const activePointTier =
    selection?.kind === 'point' ? tg.tiers[selection.tierIndex] ?? null : null;
  const activePoint =
    selection?.kind === 'point' && activePointTier?.kind === 'textTier'
      ? activePointTier.points[selection.itemIndex] ?? null
      : null;

  const activeTierObj =
    selection?.kind === 'tier' ? tg.tiers[selection.tierIndex] ?? null : null;

  // Prime Praat trigraph cache for active interval text so smart-split candidates stay accurate
  useEffect(() => {
    const raw = activeInterval?.text ?? '';
    if (!raw || !raw.includes('\\')) return;
    if (decodeTrigraphGlossSync(raw) !== null) return;
    let cancelled = false;
    void primeTrigraphString(raw, getPlatformBridge()).then(() => {
      if (!cancelled) setTrigraphTick((t) => t + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [activeInterval?.text]);

  const intervalSmartPlan = useMemo(() => {
    void trigraphTick;
    if (
      selection?.kind !== 'interval' ||
      !activeInterval ||
      !activeIntervalTier ||
      activeIntervalTier.kind !== 'intervalTier'
    ) {
      return null;
    }
    const peerTexts = collectPeerTexts(activeIntervalTier.intervals, selection.itemIndex);
    const decoded = decodeTrigraphGlossSync(activeInterval.text);
    return inferSmartSplit(activeInterval.text, decoded, {
      tierName: activeIntervalTier.name,
      peerTexts,
      hasAudio: Boolean(audioBuffer)
    });
  }, [
    selection,
    activeInterval,
    activeIntervalTier,
    audioBuffer,
    trigraphTick
  ]);

  const intervalSplitTextStats = useMemo(() => {
    void trigraphTick;
    if (!activeInterval) {
      return { canCharSplit: false, charCount: 0, canSpaceSplit: false, spaceCount: 0 };
    }
    const decoded = decodeTrigraphGlossSync(activeInterval.text);
    const resolved = resolveSplitSourceText(activeInterval.text, decoded).text;
    const chars = splitTextIntoChars(resolved, { punctuation: 'ignore' });
    const spaces = splitTextByDelimiter(resolved, {
      preset: 'whitespace',
      stripEdgePunctuation: true
    });
    return {
      canCharSplit: chars.length >= 2,
      charCount: chars.length,
      canSpaceSplit: spaces.length >= 2,
      spaceCount: spaces.length
    };
  }, [activeInterval, trigraphTick]);

  const multiAnalysis = useMemo(() => {
    if (multiSelection.length < 2) return null;
    const primaryRef =
      selection?.kind === 'interval'
        ? { tierIndex: selection.tierIndex, itemIndex: selection.itemIndex }
        : null;
    return analyzeMultiSelection(tg, multiSelection, primaryRef, playRange);
  }, [tg, multiSelection, selection, playRange]);

  // Shortcut hints
  const openFilesHint = getEffectiveShortcutHint('open-files', customShortcuts);
  const openAudioHint = getEffectiveShortcutHint('open-audio', customShortcuts);
  const saveFileHint = getEffectiveShortcutHint('save-file', customShortcuts);
  const saveAsHint = getEffectiveShortcutHint('save-as', customShortcuts);
  const exportFigureHint = getEffectiveShortcutHint('export-figure', customShortcuts);
  const findOpenHint = getEffectiveShortcutHint('find-open', customShortcuts);
  const replaceOpenHint = getEffectiveShortcutHint('replace-open', customShortcuts);
  const shortcutsModalHint = getEffectiveShortcutHint('shortcuts-modal', customShortcuts);
  const sidebarToggleHint = getEffectiveShortcutHint('sidebar-toggle', customShortcuts);
  const ipaCycleHint = getEffectiveShortcutHint('ipa-cycle', customShortcuts);
  const ipaTempEnHint = getEffectiveShortcutHint('ipa-temp-en', customShortcuts);
  const ipaDockHint = getEffectiveShortcutHint('ipa-dock-toggle', customShortcuts);

  // Undo / Redo state
  const canUndo = canUndoTimeline(history);
  const canRedo = canRedoTimeline(history);
  const undoEntry = getLatestUndoEntry(history);
  const redoEntry = getLatestRedoEntry(history);
  const undoShortcut = formatKeyCombo('Mod+Z');
  const redoShortcut = formatKeyCombo(IS_MAC ? 'Mod+Shift+Z' : 'Mod+Y');
  const undoTitle = undoEntry
    ? `撤销：${undoEntry.meta.title}${undoEntry.meta.detail ? ` (${undoEntry.meta.detail})` : ''} (${undoShortcut})`
    : `撤销 (${undoShortcut})`;
  const redoTitle = redoEntry
    ? `重做：${redoEntry.meta.title}${redoEntry.meta.detail ? ` (${redoEntry.meta.detail})` : ''} (${redoShortcut})`
    : `重做 (${redoShortcut})`;
  const histCountLabel =
    history.cursor < history.entries.length - 1
      ? `${history.cursor + 1}/${history.entries.length}`
      : String(history.entries.length);

  // Global time bounds local state (replicated faithfully from EditStrip.tsx)
  const [minText, setMinText] = useState(formatPraatDouble(tg.xmin));
  const [maxText, setMaxText] = useState(formatPraatDouble(tg.xmax));
  const skipMinBlurRef = useRef(false);
  const skipMaxBlurRef = useRef(false);

  useEffect(() => {
    setMinText(formatPraatDouble(tg.xmin));
    setMaxText(formatPraatDouble(tg.xmax));
  }, [tg.xmin, tg.xmax]);

  const commitGlobalMin = () => {
    if (skipMinBlurRef.current) {
      skipMinBlurRef.current = false;
      return;
    }
    if (isReadOnly) {
      setMinText(formatPraatDouble(tg.xmin));
      return;
    }
    const val = parseFloat(minText);
    if (!Number.isFinite(val) || val >= tg.xmax) {
      showToast('全局起点必须严格小于终点', true);
      setMinText(formatPraatDouble(tg.xmin));
      return;
    }
    if (val !== tg.xmin) {
      const oldMin = tg.xmin;
      commitTgMutation(
        (draft, ctx) => {
          draft.xmin = val;
          for (let ti = 0; ti < draft.tiers.length; ti++) {
            const origTier = draft.tiers[ti];
            const touchesBound = origTier.xmin === oldMin;
            const touchesFirstIv =
              origTier.kind === 'intervalTier' &&
              origTier.intervals.length > 0 &&
              origTier.intervals[0].xmin === oldMin &&
              origTier.intervals[0].xmax > val;
            if (!touchesBound && !touchesFirstIv) continue;
            const dTier = ctx.editTier(ti);
            if (!dTier) continue;
            if (dTier.xmin === oldMin) dTier.xmin = val;
            if (
              dTier.kind === 'intervalTier' &&
              dTier.intervals.length > 0 &&
              dTier.intervals[0].xmin === oldMin &&
              dTier.intervals[0].xmax > val
            ) {
              dTier.intervals[0].xmin = val;
            }
          }
        },
        undefined,
        {
          type: 'edit-global-bounds',
          title: '修改全局起点',
          detail: `起点 ${oldMin.toFixed(3)}s → ${val.toFixed(3)}s`,
          icon: 'copyTime',
          focusTime: val
        }
      );
    }
  };

  const commitGlobalMax = () => {
    if (skipMaxBlurRef.current) {
      skipMaxBlurRef.current = false;
      return;
    }
    if (isReadOnly) {
      setMaxText(formatPraatDouble(tg.xmax));
      return;
    }
    const val = parseFloat(maxText);
    if (!Number.isFinite(val) || val <= tg.xmin) {
      showToast('全局终点必须严格大于起点', true);
      setMaxText(formatPraatDouble(tg.xmax));
      return;
    }
    if (val !== tg.xmax) {
      const oldMax = tg.xmax;
      commitTgMutation(
        (draft, ctx) => {
          draft.xmax = val;
          for (let ti = 0; ti < draft.tiers.length; ti++) {
            const origTier = draft.tiers[ti];
            const touchesBound = origTier.xmax === oldMax;
            const lastOrig =
              origTier.kind === 'intervalTier' && origTier.intervals.length > 0
                ? origTier.intervals[origTier.intervals.length - 1]
                : null;
            const touchesLastIv = Boolean(
              lastOrig && lastOrig.xmax === oldMax && lastOrig.xmin < val
            );
            if (!touchesBound && !touchesLastIv) continue;
            const dTier = ctx.editTier(ti);
            if (!dTier) continue;
            if (dTier.xmax === oldMax) dTier.xmax = val;
            if (dTier.kind === 'intervalTier' && dTier.intervals.length > 0) {
              const last = dTier.intervals[dTier.intervals.length - 1];
              if (last.xmax === oldMax && last.xmin < val) {
                last.xmax = val;
              }
            }
          }
        },
        undefined,
        {
          type: 'edit-global-bounds',
          title: '修改全局终点',
          detail: `终点 ${oldMax.toFixed(3)}s → ${val.toFixed(3)}s`,
          icon: 'copyTime',
          focusTime: val
        }
      );
    }
  };

  // Dropdown state: 'export' lives in .ribbon-tabrow (overflow visible),
  // while panel menus are detached popouts inside .ribbon-bar to never clip on .ribbon-panel scroll.
  const [openMenu, setOpenMenu] = useState<RibbonPopoutMenuId | null>(null);
  const [popoutPos, setPopoutPos] = useState<PopoutPos | null>(null);
  const ribbonBarRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ribbonBarRef.current && !ribbonBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenMenu(null);
        if (useEditorStore.getState().styleBrush) {
          useEditorStore.getState().clearStyleBrush();
        }
      }
    };
    const onResize = () => {
      setOpenMenu((cur) => (cur && cur !== 'export' ? null : cur));
    };
    document.addEventListener('click', onDocClick);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useEffect(() => {
    setOpenMenu(null);
  }, [effectiveTab, isContextualViewActive, contextualKind, ribbonCollapsed]);

  const togglePopoutMenu = (
    menu: Exclude<RibbonPopoutMenuId, 'export'>,
    triggerEl: HTMLElement
  ) => {
    if (openMenu === menu) {
      setOpenMenu(null);
      return;
    }
    const barEl = ribbonBarRef.current;
    if (barEl) {
      const barRect = barEl.getBoundingClientRect();
      const btnRect = triggerEl.getBoundingClientRect();
      const scale = getElementRectScale(barEl);
      const rawLeft = (btnRect.left - barRect.left) / scale;
      const barLogicalW = barRect.width / scale;
      const clampedLeft = Math.max(4, Math.min(rawLeft, Math.max(4, barLogicalW - 260)));
      setPopoutPos({
        left: clampedLeft,
        top: (btnRect.bottom - barRect.top) / scale + 4
      });
    }
    setOpenMenu(menu);
  };

  // Corpus prev/next fallback computation when optional props are omitted
  const corpusFallbackNav = useMemo(() => {
    if (!activeCorpus) return { canPrev: false, canNext: false };
    const idx = activeCorpus.activeItemId
      ? activeCorpus.items.findIndex((it) => it.id === activeCorpus.activeItemId)
      : -1;
    const total = activeCorpus.items.length;
    return {
      canPrev: idx > 0 && total > 0,
      canNext: total > 0 && (idx === -1 || idx < total - 1)
    };
  }, [activeCorpus]);

  const resolvedCorpusCanPrev =
    corpusCanPrev !== undefined ? corpusCanPrev : corpusFallbackNav.canPrev;
  const resolvedCorpusCanNext =
    corpusCanNext !== undefined ? corpusCanNext : corpusFallbackNav.canNext;

  const handleToggleAutoPlay = () => {
    if (onToggleCorpusAutoPlay) {
      onToggleCorpusAutoPlay();
      return;
    }
    if (activeCorpus) {
      setCorpusOptions({ autoPlay: !activeCorpus.options.autoPlay });
    }
  };

  const handleToggleAutoVad = () => {
    if (onToggleCorpusAutoVad) {
      onToggleCorpusAutoVad();
      return;
    }
    if (activeCorpus) {
      setCorpusOptions({ autoVad: !activeCorpus.options.autoVad });
    }
  };

  const handleTabClick = (tabId: RibbonTabId) => {
    if (contextualKind !== null) {
      // User explicitly chose a base tab while an object is selected: lock until selection kind changes
      manualBaseLockKindRef.current = contextualKind;
    }
    if (isContextualViewActive) {
      setShowContextualTab(false);
      setRibbonTab(tabId);
      if (ribbonCollapsed) {
        setRibbonCollapsed(false);
      }
      return;
    }
    if (tabId === effectiveTab) {
      if (ribbonCollapsed) {
        setRibbonCollapsed(false);
      }
      return;
    }
    setRibbonTab(tabId);
    if (ribbonCollapsed) {
      setRibbonCollapsed(false);
    }
  };

  const handleTabDoubleClick = (tabId: RibbonTabId) => {
    if (!isContextualViewActive && tabId === effectiveTab) {
      toggleRibbonCollapsed();
    }
  };

  const handleContextualTabClick = () => {
    if (!contextualKind) return;
    manualBaseLockKindRef.current = null;
    if (isContextualViewActive) {
      if (ribbonCollapsed) {
        setRibbonCollapsed(false);
      }
      return;
    }
    setShowContextualTab(true);
    if (ribbonCollapsed) {
      setRibbonCollapsed(false);
    }
  };

  const handleContextualTabDoubleClick = () => {
    if (isContextualViewActive) {
      toggleRibbonCollapsed();
    }
  };

  // --- Contextual Action Helpers ---

  const executeSmartSplitCandidate = async (
    tierIndex: number,
    itemIndex: number,
    ivSnapshot: { xmin: number; xmax: number; text: string },
    candidate: SmartSplitCandidate,
    useAcoustic: boolean
  ) => {
    if (isReadOnly || candidate.texts.length < 2 || ivSnapshot.xmax <= ivSnapshot.xmin) return;
    const seq = ++smartSplitSeqRef.current;
    const startState = useEditorStore.getState();
    const startTabId = startState.activeTabId;
    const startCorpusEntryId = startState.corpusActiveEntryId;

    let cuts: number[] | null = null;
    let usedAcoustic = false;

    if (useAcoustic && audioBuffer) {
      setSmartSplitBusy(true);
      try {
        const res = await alignSplitBoundariesAcoustically({
          audioBuffer,
          xmin: ivSnapshot.xmin,
          xmax: ivSnapshot.xmax,
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
      } finally {
        if (seq === smartSplitSeqRef.current) {
          setSmartSplitBusy(false);
        }
      }

      if (seq !== smartSplitSeqRef.current) return;
      const latest = useEditorStore.getState();
      if (
        latest.activeTabId !== startTabId ||
        latest.corpusActiveEntryId !== startCorpusEntryId
      ) {
        return;
      }
      const curTier = latest.tg.tiers[tierIndex];
      if (!curTier || curTier.kind !== 'intervalTier') return;
      const curIv = curTier.intervals[itemIndex];
      if (
        !curIv ||
        curIv.xmin !== ivSnapshot.xmin ||
        curIv.xmax !== ivSnapshot.xmax ||
        curIv.text !== ivSnapshot.text
      ) {
        return;
      }
    }

    const modeWord = usedAcoustic ? '声学拆分为' : '拆分为';
    splitIntervalWithCuts(tierIndex, itemIndex, candidate.texts, cuts, {
      title: `智能拆分（${candidate.strategyLabel}）`,
      detailPrefix: `${candidate.strategyLabel}${modeWord}`,
      toastLabel: `已${candidate.strategyLabel}${modeWord}`
    });
  };

  const handleCreateIntervalFromRange = (
    ti: number,
    ii: number,
    bandIndex?: number
  ) => {
    if (isReadOnly || !playRange || playRange.end - playRange.start < 0.001) return;
    const tier = tg.tiers[ti];
    if (!tier || tier.kind !== 'intervalTier') return;
    const iv = tier.intervals[ii];
    if (!iv || iv.text !== '' || iv.xmax <= iv.xmin) return;

    let t0 = Math.max(iv.xmin, Math.min(iv.xmax, round6(playRange.start)));
    let t1 = Math.max(iv.xmin, Math.min(iv.xmax, round6(playRange.end)));
    const hasLeft = t0 > iv.xmin + 1e-9;
    const hasRight = t1 < iv.xmax - 1e-9;
    if (!hasLeft) t0 = iv.xmin;
    if (!hasRight) t1 = iv.xmax;
    if (t1 - t0 < 0.001) {
      showToast('当前选区范围过短，无法新建区间', true);
      return;
    }

    const replacements: Array<{ xmin: number; xmax: number; text: string }> = [];
    if (hasLeft) replacements.push({ xmin: iv.xmin, xmax: t0, text: '' });
    const createdIdx = ii + replacements.length;
    replacements.push({ xmin: t0, xmax: t1, text: '' });
    if (hasRight) replacements.push({ xmin: t1, xmax: iv.xmax, text: '' });

    const tierName = formatTierLabel(tier.name, ti);
    const ok = commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(ti);
        if (!dTier || dTier.kind !== 'intervalTier' || !dTier.intervals[ii]) return false;
        dTier.intervals.splice(ii, 1, ...replacements);
        ctx.setNextPlayRange({ start: t0, end: t1 });
      },
      { kind: 'interval', tierIndex: ti, itemIndex: createdIdx, bandIndex },
      {
        type: 'create-interval',
        title: '按选区新建区间',
        detail: `${tierName} · ${formatTimeSpan(t0, t1)} (${formatDurationLabel(t1 - t0)})`,
        icon: 'createFromRange',
        tierName,
        focusTime: t0
      }
    );
    if (ok && !useEditorStore.getState().playing) {
      setPlaybackTime(t0, true);
    }
  };

  const handleSnapBoundaryZeroCrossing = async () => {
    if (isReadOnly || !analysis || !selection) return;
    if (selection.kind !== 'boundary' && selection.kind !== 'spine') return;
    try {
      const snapped = round6(
        await getPlatformBridge().findZeroCrossing(analysis.sessionId, selection.time, 0.015)
      );
      if (Math.abs(snapped - selection.time) < 1e-7) {
        showToast('当前位置已位于最近过零点');
        return;
      }
      let ok = false;
      if (selection.kind === 'boundary') {
        ok = moveTierBoundary(selection.tierIndex, selection.time, snapped, boundaryShared, {
          coalesce: false,
          actionMeta: { type: 'snap-zero-crossing' },
          nextSelection: {
            kind: 'boundary',
            tierIndex: selection.tierIndex,
            time: snapped,
            bandIndex: selection.bandIndex
          }
        });
      } else {
        ok = moveSharedTimestamp(selection.time, snapped, {
          coalesce: false,
          actionMeta: { type: 'snap-zero-crossing' },
          nextSelection: {
            kind: 'spine',
            time: snapped,
            bandIndex: selection.bandIndex
          }
        });
      }
      if (ok) {
        showToast(`已吸附至最近过零点 (${snapped.toFixed(6)} s)`);
      }
    } catch (err) {
      showToast(`过零点吸附失败：${String(err)}`, true);
    }
  };

  const handleSnapPointZeroCrossing = async () => {
    if (isReadOnly || !analysis || selection?.kind !== 'point' || !activePoint) return;
    try {
      const snapped = round6(
        await getPlatformBridge().findZeroCrossing(analysis.sessionId, activePoint.number, 0.015)
      );
      if (Math.abs(snapped - activePoint.number) < 1e-7) {
        showToast('当前标点已位于最近过零点');
        return;
      }
      if (movePointToTime(selection.tierIndex, selection.itemIndex, snapped, '吸附过零点')) {
        showToast(`已吸附至最近过零点 (${snapped.toFixed(6)} s)`);
      }
    } catch (err) {
      showToast(`过零点吸附失败：${String(err)}`, true);
    }
  };

  const handleSnapPointNearestBoundary = () => {
    if (isReadOnly || selection?.kind !== 'point' || !activePoint || !activePointTier) return;
    const ti = selection.tierIndex;
    const pi = selection.itemIndex;
    const curT = activePoint.number;
    const hiddenSet = new Set(hiddenTierIndices);
    const allHidden = hiddenSet.size >= tg.tiers.length;

    let bestT: number | null = null;
    let bestDist = Infinity;

    for (let idx = 0; idx < tg.tiers.length; idx++) {
      if (!allHidden && hiddenSet.has(idx)) continue;
      const tier = tg.tiers[idx];
      if (tier.kind !== 'intervalTier') continue;
      for (const iv of tier.intervals) {
        for (const cand of [iv.xmin, iv.xmax]) {
          if (cand < activePointTier.xmin - 1e-9 || cand > activePointTier.xmax + 1e-9) continue;
          const d = Math.abs(cand - curT);
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
    if (movePointToTime(ti, pi, round6(bestT), '吸附附近边界')) {
      showToast(`已吸附至附近边界 (${bestT.toFixed(4)} s)`);
    }
  };

  const handleMovePointToIntervalMid = () => {
    if (isReadOnly || selection?.kind !== 'point' || !activePoint || !activePointTier) return;
    const ti = selection.tierIndex;
    const pi = selection.itemIndex;
    const curT = activePoint.number;
    const hiddenSet = new Set(hiddenTierIndices);
    const allHidden = hiddenSet.size >= tg.tiers.length;

    // Prefer the closest visible interval tier to the current point tier
    const intervalTierOrder = tg.tiers
      .map((tier, idx) => ({ tier, idx }))
      .filter(({ tier, idx }) => tier.kind === 'intervalTier' && (allHidden || !hiddenSet.has(idx)))
      .sort((a, b) => Math.abs(a.idx - ti) - Math.abs(b.idx - ti));

    let targetMid: number | null = null;
    for (const { tier } of intervalTierOrder) {
      const iv = tier.intervals.find(
        (seg) => seg.xmax > seg.xmin && seg.xmin <= curT + 1e-6 && seg.xmax >= curT - 1e-6
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
    if (Math.abs(targetMid - curT) <= 1e-7) {
      showToast('标点已位于该区间中点');
      return;
    }
    if (movePointToTime(ti, pi, targetMid, '移到区间中点')) {
      showToast(`已移至区间中点 (${targetMid.toFixed(4)} s)`);
    }
  };

  const renderFileTab = () => (
    <>
      {collectionTgs.length > 1 && (
        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ribbon-col-trigger ${openMenu === 'col' ? 'is-menu-open' : ''}`}
                  title="切换当前集合文件中的 TextGrid 对象"
                  onClick={(e) => togglePopoutMenu('col', e.currentTarget)}
                >
                  <UiIcon name="fileCollection" size={13} />
                  <span className="ribbon-col-name">
                    {collectionActiveIdx + 1}. {collectionTgs[collectionActiveIdx]?.name || 'TextGrid'}
                  </span>
                  <ChevronIcon size={10} />
                </button>
              </div>
              <div className="ribbon-row">
                <span style={{ fontSize: 10.5, color: 'var(--ink-faint)', padding: '0 2px' }}>
                  共 {collectionTgs.length} 个对象
                </span>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">集合对象</div>
        </div>
      )}

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            type="button"
            className="ribbon-big-btn"
            title={
              openFilesHint
                ? `打开 TextGrid / Collection / 单层文件 (${openFilesHint})`
                : '打开 TextGrid / Collection / 单层文件'
            }
            onClick={onOpenTextGridPicker}
          >
            <UiIcon name="folder" size={22} />
            <span>打开 TextGrid</span>
          </button>
          <button
            type="button"
            className="ribbon-big-btn"
            title="打开文件夹，批量标注录音与 TextGrid"
            onClick={onOpenCorpusFolder}
          >
            <CorpusFolderIcon size={22} />
            <span>打开文件夹</span>
          </button>
          <div className="ribbon-stack">
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn"
                title={openAudioHint ? `载入配套录音 (${openAudioHint})` : '载入配套录音'}
                onClick={onOpenAudioPicker}
              >
                <UiIcon name="waveform" size={13} />
                <span>打开录音</span>
              </button>
            </div>
            <div className="ribbon-row">
              <button
                type="button"
                className={`ribbon-sm-btn ${openMenu === 'samples' ? 'is-menu-open' : ''}`}
                aria-expanded={openMenu === 'samples'}
                title="载入内置示例或新建空白文件"
                onClick={(e) => togglePopoutMenu('samples', e.currentTarget)}
              >
                <UiIcon name="samples" size={13} />
                <span>示例</span>
                <ChevronIcon size={10} />
              </button>
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">打开</div>
      </div>

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            type="button"
            className="ribbon-big-btn"
            title={saveFileHint ? `保存 TextGrid (${saveFileHint})` : '保存 TextGrid'}
            onClick={() => onExportAction('save')}
          >
            <UiIcon name="save" size={22} />
            <span>保存</span>
          </button>
          <button
            type="button"
            className="ribbon-big-btn"
            title={exportFigureHint ? `自定义导出图像 (${exportFigureHint})` : '自定义导出图像'}
            onClick={() => onExportAction('dialog')}
          >
            <UiIcon name="export" size={22} />
            <span>导出图像…</span>
          </button>
          <div className="ribbon-stack">
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn"
                title="快速导出矢量图 (.svg)"
                onClick={() => onExportAction('svg')}
              >
                <UiIcon name="exportSvg" size={13} />
                <span>导出矢量图 (.svg)</span>
              </button>
              <button
                type="button"
                className="ribbon-sm-btn"
                title="快速导出高清图片 (.png)"
                onClick={() => onExportAction('png')}
              >
                <UiIcon name="exportPng" size={13} />
                <span>导出高清图片 (.png)</span>
              </button>
            </div>
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn"
                title="打开声纹海报生成器"
                onClick={() => onExportAction('poster')}
              >
                <UiIcon name="exportSvg" size={13} />
                <span>导出声纹海报…</span>
              </button>
              {isDesktop && (
                <button
                  type="button"
                  className="ribbon-sm-btn"
                  title={saveAsHint ? `另存为 (${saveAsHint})` : '另存为'}
                  onClick={() => onExportAction('save-as')}
                >
                  <UiIcon name="saveAs" size={13} />
                  <span>另存为…</span>
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">保存与导出</div>
      </div>
    </>
  );

  const renderAnnotateTab = () => (
    <>
      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            type="button"
            className={`ribbon-big-btn ipa-ctrl-noblur ${ipaDockOpen ? 'ribbon-soft-active' : ''}`}
            aria-pressed={ipaDockOpen}
            title={
              ipaDockHint
                ? `打开 / 关闭交互式国际音标虚拟键盘 (${ipaDockHint})`
                : '打开 / 关闭交互式国际音标虚拟键盘'
            }
            onMouseDown={preventBlur}
            onClick={() => setIpaDockOpen(!ipaDockOpen)}
          >
            <UiIcon name="keyboard" size={22} />
            <span>音标盘</span>
          </button>

          <div className="ribbon-stack">
            <div className="ribbon-row">
              <div
                className="ribbon-seg ipa-ctrl-noblur"
                role="group"
                aria-label="国际音标输入方案"
                title={
                  ipaCycleHint
                    ? `国际音标输入方案 (${ipaCycleHint} 切换；不影响画布与属性栏显示已有 \\xx 转义对照)`
                    : '国际音标输入方案（不影响画布与属性栏显示已有 \\xx 转义对照）'
                }
                onMouseDown={preventBlur}
              >
                <button
                  type="button"
                  className={ipaMode === 'off' ? 'is-active' : ''}
                  title="关闭音标键盘输入（文本中已有的 Praat \\xx 转义仍会显示对照）"
                  onClick={() => setIpaMode('off')}
                >
                  关闭
                </button>
                <button
                  type="button"
                  className={ipaMode === 'yunlong' ? 'is-active' : ''}
                  title={
                    ipaTempEnHint
                      ? `云龙国际音标输入方案 (${ipaTempEnHint} 临时切英文)`
                      : '云龙国际音标输入方案'
                  }
                  onClick={() => setIpaMode('yunlong')}
                >
                  云龙
                </button>
                <button
                  type="button"
                  className={ipaMode === 'praat' ? 'is-active' : ''}
                  title={
                    ipaTempEnHint
                      ? `Praat 音标转义输入（即时转 Unicode IPA，${ipaTempEnHint} 临时切英文）`
                      : 'Praat 音标转义输入（即时转 Unicode IPA）'
                  }
                  onClick={() => setIpaMode('praat')}
                >
                  Praat
                </button>
              </div>
            </div>
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn ipa-ctrl-noblur"
                title="将全文 Praat 转义音标批量转为 Unicode IPA"
                onMouseDown={preventBlur}
                onClick={() => onBatchConvertIpa('toUnicode')}
              >
                <UiIcon name="convertUnicode" size={13} />
                <span>转 Unicode</span>
              </button>
              <button
                type="button"
                className="ribbon-sm-btn ipa-ctrl-noblur"
                title="将全文 Unicode IPA 批量转为 Praat 转义编码"
                onMouseDown={preventBlur}
                onClick={() => onBatchConvertIpa('toPraat')}
              >
                <UiIcon name="convertPraat" size={13} />
                <span>转 Praat</span>
              </button>
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">国际音标</div>
      </div>

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            type="button"
            className="ribbon-big-btn ipa-ctrl-noblur"
            title={findOpenHint ? `查找与替换 (${findOpenHint})` : '查找与替换'}
            onMouseDown={preventBlur}
            onClick={() => openFindBar(false)}
          >
            <UiIcon name="search" size={22} />
            <span>查找与替换</span>
          </button>
          <div className="ribbon-stack">
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn ipa-ctrl-noblur"
                title={replaceOpenHint ? `替换标注文本 (${replaceOpenHint})` : '替换标注文本'}
                onMouseDown={preventBlur}
                onClick={() => openFindBar(true)}
              >
                <UiIcon name="replace" size={13} />
                <span>替换文本…</span>
              </button>
            </div>
            <div className="ribbon-row">
              <button
                type="button"
                className={`ribbon-sm-btn ipa-ctrl-noblur ${
                  sidebarOpen && sidebarTab === 'history' ? 'ribbon-soft-active' : ''
                }`}
                aria-pressed={sidebarOpen && sidebarTab === 'history'}
                title="打开 / 收起操作历史面板 (Alt+4)"
                onMouseDown={preventBlur}
                onClick={() => toggleSidebarTab('history')}
              >
                <UiIcon name="history" size={13} />
                <span>操作历史</span>
                <span className="ribbon-count-pill">{histCountLabel}</span>
              </button>
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">编辑与历史</div>
      </div>

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            type="button"
            className={`ribbon-big-btn ipa-ctrl-noblur ${legendOpen ? 'ribbon-soft-active' : ''}`}
            aria-pressed={legendOpen}
            title="在底部显示或隐藏交互式读图图例"
            onMouseDown={preventBlur}
            onClick={toggleLegend}
          >
            <UiIcon name="legend" size={22} />
            <span>读图图例</span>
          </button>
          <div className="ribbon-stack">
            <div className="ribbon-row">
              <button
                type="button"
                className={`ribbon-sm-btn ipa-ctrl-noblur ${
                  sidebarOpen && sidebarTab === 'inspector' ? 'ribbon-soft-active' : ''
                }`}
                aria-pressed={sidebarOpen && sidebarTab === 'inspector'}
                title="在右侧边栏打开或收起属性面板 (Alt+1)"
                onMouseDown={preventBlur}
                onClick={() => toggleSidebarTab('inspector')}
              >
                <UiIcon name="inspector" size={13} />
                <span>属性面板</span>
              </button>
            </div>
            <div className="ribbon-row">
              <button
                type="button"
                className={`ribbon-sm-btn ipa-ctrl-noblur ${
                  sidebarOpen && sidebarTab === 'settings' ? 'ribbon-soft-active' : ''
                }`}
                aria-pressed={sidebarOpen && sidebarTab === 'settings'}
                title="在右侧边栏打开画布排版与声学图谱 (Alt+5)"
                onMouseDown={preventBlur}
                onClick={() => toggleSidebarTab('settings')}
              >
                <UiIcon name="waveform" size={13} />
                <span>画布与声学</span>
              </button>
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">参考与面板</div>
      </div>
    </>
  );

  const renderTiersTab = () => {
    const readOnlyHint = '仅编辑模式下可用，请先切至编辑模式';
    return (
      <>
        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={isReadOnly}
              title={isReadOnly ? readOnlyHint : '在底部新建一个区间层 (IntervalTier)'}
              onMouseDown={preventBlur}
              onClick={() => insertTierAt(tg.tiers.length, 'intervalTier')}
            >
              <UiIcon name="addIntervalTier" size={22} />
              <span>+ 区间层</span>
            </button>
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={isReadOnly}
              title={isReadOnly ? readOnlyHint : '在底部新建一个点层 (TextTier)'}
              onMouseDown={preventBlur}
              onClick={() => insertTierAt(tg.tiers.length, 'textTier')}
            >
              <UiIcon name="addPointTier" size={22} />
              <span>+ 点层</span>
            </button>
          </div>
          <div className="ribbon-group-label">新建层</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={isReadOnly}
              title={isReadOnly ? readOnlyHint : '补齐缝隙并统一各层起止时间'}
              onMouseDown={preventBlur}
              onClick={normalizeTextGrid}
            >
              <UiIcon name="normalize" size={22} />
              <span>整理边界</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ipa-ctrl-noblur ${
                    sidebarOpen && sidebarTab === 'tiers' ? 'ribbon-soft-active' : ''
                  }`}
                  aria-pressed={sidebarOpen && sidebarTab === 'tiers'}
                  title="打开 / 收起层管理面板 (Alt+3)"
                  onMouseDown={preventBlur}
                  onClick={() => toggleSidebarTab('tiers')}
                >
                  <UiIcon name="layers" size={13} />
                  <span>层管理面板</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ipa-ctrl-noblur ${
                    sidebarOpen && sidebarTab === 'inspector' ? 'ribbon-soft-active' : ''
                  }`}
                  aria-pressed={sidebarOpen && sidebarTab === 'inspector'}
                  title="打开 / 收起属性面板 (Alt+1)"
                  onMouseDown={preventBlur}
                  onClick={() => toggleSidebarTab('inspector')}
                >
                  <UiIcon name="inspector" size={13} />
                  <span>属性面板</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">整理</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <label
                  className="ribbon-field"
                  title={isReadOnly ? readOnlyHint : '修改文档全局起点时间 (秒)，回车确认 / Esc 取消'}
                >
                  <span className="ribbon-field-lbl">起点</span>
                  <input
                    type="number"
                    step="any"
                    disabled={isReadOnly}
                    aria-label="全局起点时间"
                    value={minText}
                    onChange={(e) => setMinText(e.target.value)}
                    onBlur={commitGlobalMin}
                    onKeyDown={(e) => {
                      if (isComposingEvent(e)) return;
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        skipMinBlurRef.current = true;
                        setMinText(formatPraatDouble(tg.xmin));
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </label>
              </div>
              <div className="ribbon-row">
                <label
                  className="ribbon-field"
                  title={isReadOnly ? readOnlyHint : '修改文档全局终点时间 (秒)，回车确认 / Esc 取消'}
                >
                  <span className="ribbon-field-lbl">终点</span>
                  <input
                    type="number"
                    step="any"
                    disabled={isReadOnly}
                    aria-label="全局终点时间"
                    value={maxText}
                    onChange={(e) => setMaxText(e.target.value)}
                    onBlur={commitGlobalMax}
                    onKeyDown={(e) => {
                      if (isComposingEvent(e)) return;
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        skipMaxBlurRef.current = true;
                        setMaxText(formatPraatDouble(tg.xmax));
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </label>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">时间范围</div>
        </div>
      </>
    );
  };

  const renderViewTab = () => {
    const scalePct = Math.round(canvasScale * 100);
    const isDefaultScale = Math.abs(canvasScale - 1) < 0.005;
    const hasAudio = Boolean(audioName);

    return (
      <>
        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className={`ribbon-big-btn ${scaleMode === 'elastic' ? 'ribbon-soft-active' : ''}`}
              aria-pressed={scaleMode === 'elastic'}
              title="自适应时间比例：自动放宽短音段以便阅读标注文字"
              onClick={() => setScaleMode('elastic')}
            >
              <UiIcon name="toggleScale" size={22} />
              <span>自适应</span>
            </button>
            <button
              type="button"
              className={`ribbon-big-btn ${scaleMode === 'linear' ? 'ribbon-soft-active' : ''}`}
              aria-pressed={scaleMode === 'linear'}
              title="严格线性时间比例：与声学波形和语谱图等比对齐"
              onClick={() => setScaleMode('linear')}
            >
              <UiIcon name="navHorizontal" size={22} />
              <span>线性</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ${wrapMode === 'auto' ? 'ribbon-soft-active' : ''}`}
                  aria-pressed={wrapMode === 'auto'}
                  title={
                    wrapMode === 'auto'
                      ? '当前：自动折行多行排版（点击切为单行展开）'
                      : '当前：单行横向展开（点击切为自动折行）'
                  }
                  onClick={() => setWrapMode(wrapMode === 'auto' ? 'single' : 'auto')}
                >
                  <UiIcon name="wrapToggle" size={13} />
                  <span>自动折行</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ${legendOpen ? 'ribbon-soft-active' : ''}`}
                  aria-pressed={legendOpen}
                  title="显示或隐藏底部交互式读图图例"
                  onClick={toggleLegend}
                >
                  <UiIcon name="legend" size={13} />
                  <span>读图图例</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">时间与折行</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className={`ribbon-big-btn ${hasAudio && showSpectrogram ? 'ribbon-soft-active' : ''}`}
              disabled={!hasAudio}
              aria-pressed={hasAudio && showSpectrogram}
              title={
                hasAudio
                  ? showSpectrogram
                    ? '隐藏宽带语谱图'
                    : '显示宽带语谱图'
                  : '请先载入配套录音后查看语谱图'
              }
              onClick={() => setShowSpectrogram(!showSpectrogram)}
            >
              <UiIcon name="waveform" size={22} />
              <span>宽带语图</span>
            </button>

            <div className="ribbon-stack">
              <div className="ribbon-row">
                <div
                  className="ribbon-seg"
                  role="group"
                  aria-label="声学曲线提示层"
                  title={hasAudio ? '选择语谱图叠加的声学曲线' : '载入录音后可切换声学曲线'}
                >
                  {CUE_MODES.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      disabled={!hasAudio || !showSpectrogram}
                      className={cueMode === item.id ? 'is-active' : ''}
                      title={item.title}
                      onClick={() => setCueMode(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn"
                  disabled={isDefaultScale}
                  title={`恢复谱面画布缩放为 100%（当前 ${scalePct}%，${formatKeyCombo('Mod+0')}）`}
                  onClick={() => setCanvasScale(1)}
                >
                  <UiIcon name="reset" size={13} />
                  <span>重置画布缩放</span>
                  {!isDefaultScale && <span className="ribbon-count-pill">{scalePct}%</span>}
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">声学曲线</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className={`ribbon-big-btn ipa-ctrl-noblur ${
                styleDoc.bwPrintMode ? 'ribbon-soft-active' : ''
              }`}
              aria-pressed={styleDoc.bwPrintMode}
              title="一键预览黑白期刊印刷效果（彩色自动映射为灰度与矢量底纹）"
              onMouseDown={preventBlur}
              onClick={() => setStyleBwPrintMode(!styleDoc.bwPrintMode)}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                aria-hidden="true"
              >
                <rect x="2.5" y="2.5" width="15" height="15" />
                <line x1="2.5" y1="8.5" x2="8.5" y2="2.5" />
                <line x1="2.5" y1="14.5" x2="14.5" y2="2.5" />
                <line x1="5.5" y1="17.5" x2="17.5" y2="5.5" />
                <line x1="11.5" y1="17.5" x2="17.5" y2="11.5" />
              </svg>
              <span>黑白底纹</span>
            </button>

            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn rb-palette-trigger ipa-ctrl-noblur ${
                    openMenu === 'style-palette' ? 'is-menu-open' : ''
                  }`}
                  aria-expanded={openMenu === 'style-palette'}
                  title={`当前学术色板：${activePalette.name}（点击切换 4 套配色方案）`}
                  onMouseDown={preventBlur}
                  onClick={(e) => togglePopoutMenu('style-palette', e.currentTarget)}
                >
                  <span className="rb-palette-mini-strip" aria-hidden="true">
                    {activePalette.swatches.slice(0, 4).map((sw) => (
                      <span
                        key={sw.id}
                        className="rb-palette-mini-bar"
                        style={{
                          background: styleDoc.bwPrintMode ? sw.bwGray : sw.fill,
                          borderColor: styleDoc.bwPrintMode ? sw.bwStroke : sw.stroke
                        }}
                      />
                    ))}
                  </span>
                  <span>{activePalette.name}</span>
                  <ChevronIcon size={10} />
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ipa-ctrl-noblur ${
                    styleDoc.showLegendInExport ? 'ribbon-soft-active' : ''
                  }`}
                  aria-pressed={styleDoc.showLegendInExport}
                  title="在画布与导出图像底部预览并包含样式图例"
                  onMouseDown={preventBlur}
                  onClick={() => setStyleShowLegend(!styleDoc.showLegendInExport)}
                >
                  <UiIcon name="legend" size={13} />
                  <span>样式图例</span>
                </button>
                <button
                  type="button"
                  className={`ribbon-sm-btn ipa-ctrl-noblur ${
                    sidebarOpen && sidebarTab === 'style' ? 'ribbon-soft-active' : ''
                  }`}
                  aria-pressed={sidebarOpen && sidebarTab === 'style'}
                  title="打开 / 收起样式面板 (Alt+2)"
                  onMouseDown={preventBlur}
                  onClick={() => toggleSidebarTab('style')}
                >
                  <UiIcon name="stylePalette" size={13} />
                  <span>样式面板</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">学术外观</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ${sidebarOpen ? 'ribbon-soft-active' : ''}`}
                  aria-pressed={sidebarOpen}
                  title={
                    sidebarToggleHint
                      ? `展开或收起右侧边栏 (${sidebarToggleHint})`
                      : '展开或收起右侧边栏'
                  }
                  onClick={() => setSidebarOpen(!sidebarOpen)}
                >
                  <UiIcon name="sidebarToggle" size={13} />
                  <span>右侧栏</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ${
                    sidebarOpen && sidebarTab === 'settings' ? 'ribbon-soft-active' : ''
                  }`}
                  aria-pressed={sidebarOpen && sidebarTab === 'settings'}
                  title="打开 / 收起画布与声学面板 (Alt+5)"
                  onClick={() => toggleSidebarTab('settings')}
                >
                  <UiIcon name="waveform" size={13} />
                  <span>画布与声学</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">侧边栏</div>
        </div>
      </>
    );
  };

  const renderToolsTab = () => (
    <>
      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            type="button"
            className="ribbon-big-btn ipa-ctrl-noblur"
            title={findOpenHint ? `查找与替换 (${findOpenHint})` : '查找与替换'}
            onMouseDown={preventBlur}
            onClick={() => openFindBar(false)}
          >
            <UiIcon name="search" size={22} />
            <span>查找与替换</span>
          </button>
          <div className="ribbon-stack">
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn ipa-ctrl-noblur"
                title="将全文 Praat 转义音标批量转为 Unicode IPA"
                onMouseDown={preventBlur}
                onClick={() => onBatchConvertIpa('toUnicode')}
              >
                <UiIcon name="convertUnicode" size={13} />
                <span>转 Unicode IPA</span>
              </button>
            </div>
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn ipa-ctrl-noblur"
                title="将全文 Unicode IPA 批量转为 Praat 转义编码"
                onMouseDown={preventBlur}
                onClick={() => onBatchConvertIpa('toPraat')}
              >
                <UiIcon name="convertPraat" size={13} />
                <span>转 Praat 转义</span>
              </button>
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">查找与转换</div>
      </div>

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            type="button"
            className="ribbon-big-btn"
            title={shortcutsModalHint ? `快捷键指南 (${shortcutsModalHint})` : '快捷键指南'}
            onClick={() => setShortcutsOpen(true)}
          >
            <UiIcon name="shortcuts" size={22} />
            <span>快捷键指南</span>
          </button>
          <div className="ribbon-stack">
            <div className="ribbon-row">
              <button
                type="button"
                className={`ribbon-sm-btn ${
                  preferencesOpen &&
                  (preferencesSection === 'floating' || preferencesSection === 'shortcuts')
                    ? 'ribbon-soft-active'
                    : ''
                }`}
                aria-pressed={
                  preferencesOpen &&
                  (preferencesSection === 'floating' || preferencesSection === 'shortcuts')
                }
                title="自定义悬浮条按钮与快捷键 (Alt+6)"
                onClick={() => setPreferencesOpen(true, 'floating')}
              >
                <UiIcon name="customize" size={13} />
                <span>自定义悬浮条与快捷键</span>
              </button>
              <button
                type="button"
                className={`ribbon-sm-btn ${
                  sidebarOpen && sidebarTab === 'history' ? 'ribbon-soft-active' : ''
                }`}
                aria-pressed={sidebarOpen && sidebarTab === 'history'}
                title="操作历史记录 (Alt+4)"
                onClick={() => toggleSidebarTab('history')}
              >
                <UiIcon name="history" size={13} />
                <span>操作历史</span>
              </button>
            </div>
            <div className="ribbon-row">
              <button
                type="button"
                className={`ribbon-sm-btn ${preferencesOpen ? 'ribbon-soft-active' : ''}`}
                aria-pressed={preferencesOpen}
                title={`打开偏好设置中心 (${formatKeyCombo('Mod+,')})`}
                onClick={() => setPreferencesOpen(true, 'editing')}
              >
                <UiIcon name="gear" size={13} />
                <span>偏好设置</span>
              </button>
              <button
                type="button"
                className="ribbon-sm-btn"
                title="查看 T·Grid 版本与说明"
                onClick={() => setAboutOpen(true)}
              >
                <UiIcon name="info" size={13} />
                <span>关于 T·Grid</span>
              </button>
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">效率与关于</div>
      </div>
    </>
  );

  const renderCorpusTab = () => {
    if (!activeCorpus) return null;
    const corpusExt = activeCorpus as typeof activeCorpus & {
      unsavedItemIds?: string[];
      projectIndexDirty?: boolean;
    };
    const unsavedIds = corpusExt.unsavedItemIds ?? [];
    const unsavedCount = Math.max(unsavedIds.length, isDirty ? 1 : 0);
    const hasPendingSave = unsavedCount > 0 || Boolean(corpusExt.projectIndexDirty);
    const isSaving = activeCorpus.saveStatus === 'saving';
    const corpusSaveAllHint = getEffectiveShortcutHint('corpus-save-all', customShortcuts);
    const canExportZip = Boolean(onExportCorpusZip);
    const zipCount = Math.max(unsavedCount, activeCorpus.dirtyCount);
    const zipTitle = activeCorpus.writable
      ? '将当前未保存词条打包导出为 .zip 备份'
      : zipCount > 0
        ? `导出已修改的 ${zipCount} 项标注文件 (.zip)`
        : '导出当前文件夹已修改的标注文件 (.zip)';

    const saveAllLabel =
      isSaving && corpusSaveProgress && corpusSaveProgress.total > 0
        ? `保存中 ${corpusSaveProgress.done}/${corpusSaveProgress.total}`
        : isSaving
          ? '正在保存…'
          : unsavedCount > 0
            ? `保存全部 (${unsavedCount})`
            : corpusExt.projectIndexDirty
              ? '保存项目状态'
              : '保存全部';

    return (
      <>
        <div className="ribbon-group">
          <div className="ribbon-group-body">
            {activeCorpus.writable ? (
              <>
                <button
                  type="button"
                  className={`ribbon-big-btn ipa-ctrl-noblur ${isDirty ? 'ribbon-soft-active' : ''}`}
                  disabled={!activeCorpus.activeItemId || isSaving || !onCorpusSaveCurrent}
                  title={
                    saveFileHint
                      ? `保存当前词条到文件夹 (${saveFileHint})`
                      : '保存当前词条到文件夹'
                  }
                  onMouseDown={preventBlur}
                  onClick={() => onCorpusSaveCurrent?.()}
                >
                  <UiIcon name="save" size={22} />
                  <span>保存当前词</span>
                </button>
                <button
                  type="button"
                  className={`ribbon-big-btn ipa-ctrl-noblur ${hasPendingSave ? 'ribbon-soft-active' : ''}`}
                  disabled={!hasPendingSave || isSaving || !onCorpusSaveAll}
                  title={
                    corpusSaveAllHint
                      ? `批量保存全部未保存词条与项目索引 (${corpusSaveAllHint})`
                      : '批量保存全部未保存词条与项目索引'
                  }
                  onMouseDown={preventBlur}
                  onClick={() => onCorpusSaveAll?.()}
                >
                  <UiIcon name="saveAs" size={22} />
                  <span>{saveAllLabel}</span>
                </button>
                <div className="ribbon-stack">
                  <div className="ribbon-row">
                    <button
                      type="button"
                      className={`ribbon-sm-btn ipa-ctrl-noblur ${corpusAutoSave ? 'ribbon-soft-active' : ''}`}
                      aria-pressed={corpusAutoSave}
                      disabled={!onToggleCorpusAutoSave}
                      title={
                        corpusAutoSave
                          ? '已开启自动保存（编辑停顿约 1 秒及切词时自动覆盖原文件，覆盖前会保留原件备份）；点击关闭'
                          : '默认关闭自动保存以保护磁盘原文件；开启后将在编辑停顿和切词时自动写回原文件夹'
                      }
                      onMouseDown={preventBlur}
                      onClick={() => onToggleCorpusAutoSave?.()}
                    >
                      <UiIcon name="check" size={13} />
                      <span>{corpusAutoSave ? '自动保存：开' : '自动保存：关'}</span>
                    </button>
                  </div>
                  <div className="ribbon-row">
                    <button
                      type="button"
                      className="ribbon-sm-btn"
                      disabled={!canExportZip || exportingCorpusZip || zipCount === 0}
                      title={zipTitle}
                      onClick={() => onExportCorpusZip?.()}
                    >
                      <CorpusExportZipIcon size={13} />
                      <span>{exportingCorpusZip ? '打包中…' : '导出草稿 (.zip)'}</span>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="ribbon-big-btn"
                  disabled={!canExportZip || exportingCorpusZip}
                  title={zipTitle}
                  onClick={() => onExportCorpusZip?.()}
                >
                  <CorpusExportZipIcon size={22} />
                  <span>
                    {exportingCorpusZip
                      ? '正在打包…'
                      : zipCount > 0
                        ? `导出修改 (${zipCount})`
                        : '导出修改 (.zip)'}
                  </span>
                </button>
                <div className="ribbon-stack">
                  <div className="ribbon-row">
                    <button
                      type="button"
                      className="ribbon-sm-btn"
                      disabled
                      title={activeCorpus.readOnlyReason || '当前浏览器只读模式无法直接写回磁盘，不支持开启自动保存'}
                    >
                      <UiIcon name="warning" size={13} />
                      <span>自动保存不可用</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="ribbon-group-label">保存与导出</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className={`ribbon-big-btn ipa-ctrl-noblur ${
                activeCorpus.options.autoPlay ? 'ribbon-soft-active' : ''
              }`}
              aria-pressed={activeCorpus.options.autoPlay}
              title="切换词条后自动播放当前语音段"
              onMouseDown={preventBlur}
              onClick={handleToggleAutoPlay}
            >
              <AutoPlayIcon size={22} />
              <span>自动播放</span>
            </button>
            <button
              type="button"
              className={`ribbon-big-btn ipa-ctrl-noblur ${
                activeCorpus.options.autoVad ? 'ribbon-soft-active' : ''
              }`}
              aria-pressed={activeCorpus.options.autoVad}
              title="打开无标注文件的音频时，自动按静音切分起止边界"
              onMouseDown={preventBlur}
              onClick={handleToggleAutoVad}
            >
              <AutoSplitIcon size={22} />
              <span>自动切分</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ${showCorpusStatusMarks ? 'ribbon-soft-active' : ''}`}
                  aria-pressed={showCorpusStatusMarks}
                  title="显示或隐藏词条的未标、已完成、存疑、需重录标记"
                  onClick={() => setShowCorpusStatusMarks(!showCorpusStatusMarks)}
                >
                  <UiIcon name="check" size={13} />
                  <span>显示状态标记</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ${activeCorpus.sidebarOpen ? 'ribbon-soft-active' : ''}`}
                  aria-pressed={activeCorpus.sidebarOpen}
                  title="展开或收起左侧词条列表栏"
                  onClick={() => toggleCorpusSidebar()}
                >
                  <CorpusSidebarToggleIcon collapsed={!activeCorpus.sidebarOpen} size={13} />
                  <span>左侧词条栏</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">批量设置</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn"
                  disabled={!resolvedCorpusCanPrev || !onCorpusPrev}
                  title="切换至上一条词条 (Alt+[)"
                  onClick={() => onCorpusPrev?.()}
                >
                  <CorpusPrevIcon size={13} />
                  <span>上一条词条</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn"
                  disabled={!resolvedCorpusCanNext || !onCorpusNext}
                  title="切换至下一条词条 (Alt+])"
                  onClick={() => onCorpusNext?.()}
                >
                  <CorpusNextIcon size={13} />
                  <span>下一条词条</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">导航</div>
        </div>
      </>
    );
  };

  // --- Shared Contextual Appearance Ribbon Group ---
  const renderContextualAppearanceGroup = (opts: {
    activeSwatchId: string | null;
    swatchVariant?: 'fill' | 'line';
    onPickSwatch: (swatchId: string) => void;
    quickControl: React.ReactNode;
    brushKind: StyleBrush['kind'];
    buildBrush: (sticky: boolean) => StyleBrush;
    hasCustom: boolean;
  }) => {
    const isBrushActive = styleBrush?.kind === opts.brushKind;
    const isBrushSticky = Boolean(isBrushActive && styleBrush?.sticky);

    return (
      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <div className="ribbon-stack">
            <div className="ribbon-row">
              <div
                className="rb-swatch-strip ipa-ctrl-noblur"
                role="group"
                aria-label="学术色槽快选"
                onMouseDown={preventBlur}
              >
                {activePalette.swatches.map((sw) => {
                  const selected = opts.activeSwatchId === sw.id;
                  const customLabel = styleDoc.swatchLabels[sw.id]?.trim();
                  const tip = customLabel ? `${sw.name} · ${customLabel}` : sw.name;
                  return (
                    <button
                      key={`rb-sw-${sw.id}`}
                      type="button"
                      className={`rb-swatch-dot${selected ? ' is-active' : ''}`}
                      title={tip}
                      aria-label={tip}
                      aria-pressed={selected}
                      onClick={() => opts.onPickSwatch(sw.id)}
                    >
                      <SwatchVisualFill
                        swatch={sw}
                        bwMode={styleDoc.bwPrintMode}
                        paletteId={styleDoc.paletteId}
                        variant={opts.swatchVariant ?? 'fill'}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="ribbon-row">
              {opts.quickControl}
              <button
                type="button"
                className={`ribbon-sm-btn rb-brush-btn ipa-ctrl-noblur${
                  isBrushSticky ? ' is-sticky' : isBrushActive ? ' is-active' : ''
                }`}
                aria-pressed={isBrushActive}
                title="单击吸取样式单次刷；双击锁定连续刷；再次点击或按 Esc 退出"
                onMouseDown={preventBlur}
                onClick={(e) => {
                  if (e.detail >= 2) return;
                  if (styleBrush) {
                    clearStyleBrush();
                    return;
                  }
                  setStyleBrush(opts.buildBrush(false));
                  showToast('已开启格式刷：点击画布中同类对象应用样式（双击可锁定连续刷）');
                }}
                onDoubleClick={() => {
                  setStyleBrush(opts.buildBrush(true));
                  showToast('已锁定连续格式刷：可连续刷入多个对象，按 Esc 退出');
                }}
              >
                <UiIcon name="formatBrush" size={13} />
                <span>{isBrushSticky ? '连续刷' : '格式刷'}</span>
              </button>
              <button
                type="button"
                className="ribbon-sm-btn ipa-ctrl-noblur"
                disabled={!opts.hasCustom}
                title={opts.hasCustom ? '清除当前选中对象的自定义外观' : '当前对象为默认样式'}
                onMouseDown={preventBlur}
                onClick={() => clearSelectionStyle()}
              >
                <UiIcon name="clear" size={13} />
                <span>清除样式</span>
              </button>
              <button
                type="button"
                className={`ribbon-sm-btn ipa-ctrl-noblur ${
                  sidebarOpen && sidebarTab === 'style' ? 'ribbon-soft-active' : ''
                }`}
                aria-pressed={sidebarOpen && sidebarTab === 'style'}
                title="打开 / 收起样式面板 (Alt+2)"
                onMouseDown={preventBlur}
                onClick={() => toggleSidebarTab('style')}
              >
                <UiIcon name="stylePalette" size={13} />
                <span>样式面板</span>
              </button>
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">外观</div>
      </div>
    );
  };

  const cycleNextPattern = (cur: PatternKind): PatternKind => {
    const idx = PATTERN_OPTIONS.findIndex((o) => o.kind === cur);
    const next = PATTERN_OPTIONS[(idx + 1) % PATTERN_OPTIONS.length];
    return next ? next.kind : 'none';
  };

  const cycleNextPointShape = (cur: PointShape): PointShape => {
    const idx = POINT_SHAPE_OPTIONS.findIndex((o) => o.shape === cur);
    const next = POINT_SHAPE_OPTIONS[(idx + 1) % POINT_SHAPE_OPTIONS.length];
    return next ? next.shape : 'circle';
  };

  const extractRibbonIntervalPatch = (
    ti: number,
    ii: number,
    resolved: ReturnType<typeof resolveIntervalStyle>
  ): IntervalStylePatch => {
    const existing = styleDoc.intervalOverrides.find(
      (o) => o.tierIndex === ti && o.itemIndex === ii
    );
    if (existing) return { ...existing.style };
    if (!resolved.hasCustom) return {};
    const patch: IntervalStylePatch = {};
    if (resolved.swatchId) patch.swatchId = resolved.swatchId;
    else if (resolved.hasCustomFill) patch.fillColor = resolved.fill;
    if (resolved.fillOpacity !== 1) patch.fillOpacity = resolved.fillOpacity;
    if (resolved.pattern !== 'none') patch.pattern = resolved.pattern;
    if (resolved.hasCustomBorder) {
      if (!resolved.swatchId) patch.borderColor = resolved.borderColor;
      if (resolved.borderWidth !== 1) patch.borderWidth = resolved.borderWidth;
      if (resolved.borderDash !== 'solid') patch.borderDash = resolved.borderDash;
    }
    if (resolved.hasCustomText) {
      if (!resolved.swatchId) patch.textColor = resolved.textColor;
      if (resolved.fontWeight !== 'normal') patch.fontWeight = resolved.fontWeight;
      if (resolved.fontStyle !== 'normal') patch.fontStyle = resolved.fontStyle;
    }
    return patch;
  };

  const extractRibbonBoundaryPatch = (
    tierIdx: number | null,
    time: number,
    resolved: ReturnType<typeof resolveBoundaryStyle>
  ): BoundaryStylePatch => {
    const existing = styleDoc.boundaryOverrides.find(
      (o) => o.tierIndex === tierIdx && Math.abs(o.time - time) <= TIME_MATCH_EPS
    );
    if (existing) return { ...existing.style };
    if (!resolved.hasCustom) return {};
    const patch: BoundaryStylePatch = {};
    if (resolved.swatchId) patch.swatchId = resolved.swatchId;
    else patch.strokeColor = resolved.strokeColor;
    if (resolved.strokeWidth !== 1) patch.strokeWidth = resolved.strokeWidth;
    if (resolved.strokeDash !== 'solid') patch.strokeDash = resolved.strokeDash;
    if (resolved.extendToAcoustic) patch.extendToAcoustic = true;
    return patch;
  };

  const extractRibbonPointPatch = (
    ti: number,
    pi: number,
    resolved: ReturnType<typeof resolvePointStyle>
  ): PointStylePatch => {
    const existing = styleDoc.pointOverrides.find(
      (o) => o.tierIndex === ti && o.itemIndex === pi
    );
    if (existing) return { ...existing.style };
    if (!resolved.hasCustom) return {};
    const patch: PointStylePatch = {};
    if (resolved.swatchId) patch.swatchId = resolved.swatchId;
    else {
      patch.color = resolved.color;
      patch.stemColor = resolved.stemColor;
      patch.textColor = resolved.textColor;
    }
    if (resolved.shape !== 'circle') patch.shape = resolved.shape;
    if (resolved.size !== 4) patch.size = resolved.size;
    if (resolved.stemDash !== 'solid') patch.stemDash = resolved.stemDash;
    if (resolved.fontWeight !== 'normal') patch.fontWeight = resolved.fontWeight;
    return patch;
  };

  const renderIntervalCtxTab = () => {
    if (
      selection?.kind !== 'interval' ||
      !activeInterval ||
      !activeIntervalTier ||
      activeIntervalTier.kind !== 'intervalTier'
    ) {
      return null;
    }
    const ti = selection.tierIndex;
    const ii = selection.itemIndex;
    const iv = activeInterval;
    const durValid = iv.xmax > iv.xmin;
    const readOnlyHint = '仅编辑模式下可用，请先切至编辑模式';
    const primarySmart = intervalSmartPlan?.primary ?? null;
    const otherIntervalTiers = tg.tiers
      .map((tier, idx) => ({ tier, idx }))
      .filter(({ tier, idx }) => idx !== ti && tier.kind === 'intervalTier');

    const hasValidRange = Boolean(playRange && playRange.end - playRange.start >= 0.001);
    const canRemapToRange = Boolean(
      !isReadOnly &&
        durValid &&
        hasValidRange &&
        playRange &&
        (Math.abs(playRange.start - iv.xmin) > 1e-4 || Math.abs(playRange.end - iv.xmax) > 1e-4)
    );
    const canCreateFromRange = Boolean(
      !isReadOnly &&
        iv.text === '' &&
        durValid &&
        hasValidRange &&
        playRange &&
        iv.xmin <= playRange.start + 1e-6 &&
        iv.xmax >= playRange.end - 1e-6
    );
    const isZoomedHere = Boolean(
      viewDomain &&
        Math.abs(viewDomain.min - iv.xmin) < 1e-6 &&
        Math.abs(viewDomain.max - iv.xmax) < 1e-6
    );

    const smartMainTitle = isReadOnly
      ? readOnlyHint
      : primarySmart
        ? `${primarySmart.menuLabel}${smartSplitUseAcoustic && audioBuffer ? '（启用声学边界对齐）' : ''}`
        : '打开自定义拆分设置';

    return (
      <>
        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <div
              className={`ribbon-split-big ${openMenu === 'smart-split' ? 'is-menu-open' : ''} ${
                isReadOnly || !durValid ? 'is-disabled' : ''
              }`}
            >
              <button
                type="button"
                className="ribbon-split-main ipa-ctrl-noblur"
                disabled={isReadOnly || !durValid || smartSplitBusy}
                title={smartMainTitle}
                onMouseDown={preventBlur}
                onClick={() => {
                  if (isReadOnly || !durValid) return;
                  if (primarySmart) {
                    void executeSmartSplitCandidate(
                      ti,
                      ii,
                      { xmin: iv.xmin, xmax: iv.xmax, text: iv.text },
                      primarySmart,
                      smartSplitUseAcoustic
                    );
                  } else if (onOpenSplitModal) {
                    onOpenSplitModal(ti, ii);
                  }
                }}
              >
                <UiIcon name="autoSplit" size={22} />
                <span>{smartSplitBusy ? '拆分中…' : '智能拆分'}</span>
              </button>
              <button
                type="button"
                className="ribbon-split-caret ipa-ctrl-noblur"
                disabled={isReadOnly || !durValid || smartSplitBusy}
                aria-expanded={openMenu === 'smart-split'}
                aria-label="更多拆分方式"
                title={isReadOnly ? readOnlyHint : '展开备选策略、等分与自定义拆分'}
                onMouseDown={preventBlur}
                onClick={(e) => togglePopoutMenu('smart-split', e.currentTarget)}
              >
                <ChevronIcon size={9} />
              </button>
            </div>

            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={isReadOnly || !durValid}
              title={isReadOnly ? readOnlyHint : '在当前区间正中插入边界，一分为二'}
              onMouseDown={preventBlur}
              onClick={() => {
                if (!isReadOnly && durValid) splitInterval(ti, ii);
              }}
            >
              <UiIcon name="split" size={22} />
              <span>正中切分</span>
            </button>

            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || ii === 0}
                  title={isReadOnly ? readOnlyHint : '与左侧相邻区间合并'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly && ii > 0) mergeIntervalWith(ti, ii, -1);
                  }}
                >
                  <UiIcon name="mergeLeft" size={13} />
                  <span>向左合并</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || ii >= activeIntervalTier.intervals.length - 1}
                  title={isReadOnly ? readOnlyHint : '与右侧相邻区间合并'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly && ii < activeIntervalTier.intervals.length - 1) {
                      mergeIntervalWith(ti, ii, 1);
                    }
                  }}
                >
                  <UiIcon name="mergeRight" size={13} />
                  <span>向右合并</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">拆分与合并</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className={`ribbon-big-btn ipa-ctrl-noblur ${
                openMenu === 'copy-interval-tier' ? 'is-menu-open' : ''
              }`}
              disabled={isReadOnly || !durValid || otherIntervalTiers.length === 0}
              aria-expanded={openMenu === 'copy-interval-tier'}
              title={
                isReadOnly
                  ? readOnlyHint
                  : otherIntervalTiers.length === 0
                    ? '当前没有其他区间层可复制'
                    : '将当前区间的边界（或含文本）复制到其他区间层'
              }
              onMouseDown={preventBlur}
              onClick={(e) => togglePopoutMenu('copy-interval-tier', e.currentTarget)}
            >
              <UiIcon name="projectToTier" size={22} />
              <span className="ribbon-big-label-caret">
                <span>复制到层</span>
                <ChevronIcon size={9} />
              </span>
            </button>

            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={!canRemapToRange}
                  title={
                    isReadOnly
                      ? readOnlyHint
                      : canRemapToRange && playRange
                        ? `将当前区间及对齐层整体调整到选区 (${playRange.start.toFixed(2)}–${playRange.end.toFixed(2)} s，Shift+I)`
                        : '请先在时间轴拖选目标范围，再一键贴合 (Shift+I)'
                  }
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!canRemapToRange || !playRange) return;
                    transformAlignedBlock(ti, ii, playRange.start, playRange.end, {
                      mode: 'remap',
                      bandIndex: selection.bandIndex
                    });
                  }}
                >
                  <UiIcon name="nudgeShared" size={13} />
                  <span>移到当前选区</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={!canCreateFromRange}
                  title={
                    isReadOnly
                      ? readOnlyHint
                      : canCreateFromRange
                        ? '在当前空白区间内按已框选范围切出新区间'
                        : '选中包含框选范围的空白区间后可按选区新建'
                  }
                  onMouseDown={preventBlur}
                  onClick={() => handleCreateIntervalFromRange(ti, ii, selection.bandIndex)}
                >
                  <UiIcon name="createFromRange" size={13} />
                  <span>按选区新建</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">跨层与位置</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || iv.text === ''}
                  title={isReadOnly ? readOnlyHint : '清空当前区间的标注文本'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (isReadOnly || iv.text === '') return;
                    const oldText = iv.text;
                    const tierName = formatTierLabel(activeIntervalTier.name, ti);
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
                        focusTime: iv.xmin
                      }
                    );
                  }}
                >
                  <UiIcon name="clear" size={13} />
                  <span>清空文本</span>
                </button>
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={!iv.text}
                  title="复制当前区间文本到剪贴板"
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!iv.text) return;
                    void getPlatformBridge()
                      .writeClipboardText(iv.text)
                      .then(() => showToast('已复制区间文本'))
                      .catch(() => showToast('剪贴板写入受限', true));
                  }}
                >
                  <UiIcon name="copy" size={13} />
                  <span>复制文本</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || !iv.text}
                  title={isReadOnly ? readOnlyHint : '将当前区间的 Praat 转义转为 Unicode 音标'}
                  onMouseDown={preventBlur}
                  onClick={() => void convertSelectionIpa('to-unicode')}
                >
                  <UiIcon name="convertUnicode" size={13} />
                  <span>转 Unicode</span>
                </button>
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || !iv.text}
                  title={isReadOnly ? readOnlyHint : '将当前区间的 Unicode 音标转为 Praat 转义'}
                  onMouseDown={preventBlur}
                  onClick={() => void convertSelectionIpa('to-praat')}
                >
                  <UiIcon name="convertPraat" size={13} />
                  <span>转 Praat</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">文字与音标</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={!durValid || !onStartPlayback}
              title="播放当前区间音频"
              onMouseDown={preventBlur}
              onClick={() => {
                if (!durValid || !onStartPlayback) return;
                setPlayRange({ start: iv.xmin, end: iv.xmax });
                onStartPlayback(iv.xmin, iv.xmax);
              }}
            >
              <UiIcon name="play" size={22} />
              <span>播放区间</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={!durValid || !onStartPlayback}
                  title="前后各扩展 250 ms 试听当前区间"
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!durValid || !onStartPlayback) return;
                    const start = Math.max(tg.xmin, iv.xmin - 0.25);
                    const end = Math.min(tg.xmax, iv.xmax + 0.25);
                    onStartPlayback(start, end);
                  }}
                >
                  <UiIcon name="playContext" size={13} />
                  <span>前后试听</span>
                </button>
                <button
                  type="button"
                  className={`ribbon-sm-btn ipa-ctrl-noblur ${loop ? 'ribbon-soft-active' : ''}`}
                  aria-pressed={loop}
                  disabled={!loop && (!durValid || !onStartPlayback)}
                  title={loop ? '关闭循环并停止反复播放' : '开启循环并反复播放当前区间'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (loop) {
                      setLoop(false);
                      if (playing) onStopPlayback?.();
                      return;
                    }
                    if (!durValid || !onStartPlayback) return;
                    setLoop(true);
                    setPlayRange({ start: iv.xmin, end: iv.xmax });
                    onStartPlayback(iv.xmin, iv.xmax);
                  }}
                >
                  <UiIcon name="loop" size={13} />
                  <span>{loop ? '退出循环' : '循环播放'}</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ipa-ctrl-noblur ${isZoomedHere ? 'ribbon-soft-active' : ''}`}
                  disabled={!durValid}
                  title={isZoomedHere ? '恢复显示文档全长' : '放大视野到当前区间'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (isZoomedHere) {
                      setViewDomain(null);
                    } else if (durValid) {
                      setViewDomain({ min: iv.xmin, max: iv.xmax });
                    }
                  }}
                >
                  <UiIcon name={isZoomedHere ? 'zoomReset' : 'zoomIn'} size={13} />
                  <span>{isZoomedHere ? '显示全长' : '放大查看'}</span>
                </button>
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={!durValid}
                  title="以当前区间范围打开导出图像设置"
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!durValid) return;
                    setPlayRange({ start: iv.xmin, end: iv.xmax });
                    openExportModal('selection');
                  }}
                >
                  <UiIcon name="export" size={13} />
                  <span>导出区间…</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">试听与视图</div>
        </div>

        {(() => {
          const ivStyle = resolveIntervalStyle(styleDoc, tg, ti, ii);
          const patOpt = PATTERN_OPTIONS.find((o) => o.kind === ivStyle.pattern);
          return renderContextualAppearanceGroup({
            activeSwatchId: ivStyle.swatchId,
            swatchVariant: 'fill',
            onPickSwatch: (swatchId) =>
              setIntervalStyle(ti, ii, {
                swatchId,
                fillColor: undefined,
                borderColor: undefined,
                textColor: undefined
              }),
            quickControl: (
              <button
                type="button"
                className={`ribbon-sm-btn ipa-ctrl-noblur ${
                  ivStyle.pattern !== 'none' ? 'ribbon-soft-active' : ''
                }`}
                title={`点击循环切换矢量底纹（当前：${patOpt?.label ?? '无底纹'}）`}
                onMouseDown={preventBlur}
                onClick={() =>
                  setIntervalStyle(ti, ii, { pattern: cycleNextPattern(ivStyle.pattern) })
                }
              >
                <span>底纹: {patOpt?.shortLabel ?? '无'}</span>
              </button>
            ),
            brushKind: 'interval',
            buildBrush: (sticky) => ({
              kind: 'interval',
              patch: extractRibbonIntervalPatch(ti, ii, ivStyle),
              sticky
            }),
            hasCustom: ivStyle.hasCustom
          });
        })()}
      </>
    );
  };

  const renderMultiCtxTab = () => {
    if (!multiAnalysis || multiSelection.length < 2) return null;
    const { capabilities, envelopeXmin, envelopeXmax, nonEmptyCount } = multiAnalysis;
    const spanValid = envelopeXmax > envelopeXmin;
    const readOnlyHint = '仅编辑模式下可用，请先切至编辑模式';
    const isZoomedSpan = Boolean(
      viewDomain &&
        Math.abs(viewDomain.min - envelopeXmin) < 1e-6 &&
        Math.abs(viewDomain.max - envelopeXmax) < 1e-6
    );

    return (
      <>
        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={isReadOnly || !capabilities.canMerge}
              title={
                isReadOnly
                  ? readOnlyHint
                  : capabilities.canMerge
                    ? '将同层相邻的多个已选区间合并为一段'
                    : '仅当所选为同层连续区间时可合并'
              }
              onMouseDown={preventBlur}
              onClick={() => {
                if (!isReadOnly && capabilities.canMerge) mergeMultiSelection();
              }}
            >
              <UiIcon name="mergeLeft" size={22} />
              <span>合并连续段</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || !capabilities.canClearText}
                  title={isReadOnly ? readOnlyHint : '清空所有已选区间的文本'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly && capabilities.canClearText) clearMultiSelectionText();
                  }}
                >
                  <UiIcon name="clear" size={13} />
                  <span>批量清空文本</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  title="退出多选状态，恢复单选"
                  onMouseDown={preventBlur}
                  onClick={clearMultiSelection}
                >
                  <UiIcon name="CloseIcon" size={13} />
                  <span>取消复选</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">批量操作</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={isReadOnly || !capabilities.canAlignBounds}
              title={
                isReadOnly
                  ? readOnlyHint
                  : capabilities.canAlignBounds
                    ? '将其他已选区间的起止边界对齐到主选区间'
                    : '当前多选分布不支持直接对齐边界'
              }
              onMouseDown={preventBlur}
              onClick={() => {
                if (!isReadOnly && capabilities.canAlignBounds) {
                  alignMultiSelectionBounds('to-primary');
                }
              }}
            >
              <UiIcon name="normalize" size={22} />
              <span>对齐到主选</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || !capabilities.canAlignBounds}
                  title={isReadOnly ? readOnlyHint : '将各层已选区间起止边界统一对齐到整体合并范围'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly && capabilities.canAlignBounds) {
                      alignMultiSelectionBounds('to-envelope');
                    }
                  }}
                >
                  <UiIcon name="nudgeShared" size={13} />
                  <span>对齐到合并范围</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || !capabilities.canRemapToPlayRange || !playRange}
                  title={
                    isReadOnly
                      ? readOnlyHint
                      : capabilities.canRemapToPlayRange && playRange
                        ? `将已选区间整体贴合到当前选区 (${playRange.start.toFixed(2)}–${playRange.end.toFixed(2)} s)`
                        : '请先在时间轴拖选目标选区'
                  }
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly && capabilities.canRemapToPlayRange && playRange) {
                      alignMultiSelectionBounds('to-range', playRange);
                    }
                  }}
                >
                  <UiIcon name="createFromRange" size={13} />
                  <span>移到当前选区</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">对齐边界</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || !capabilities.canSyncMove}
                  title={isReadOnly ? readOnlyHint : '将全部已选区间同步向左平移 10 ms'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly && capabilities.canSyncMove) {
                      syncTransformMultiSelection('move', -0.01);
                    }
                  }}
                >
                  <UiIcon name="seekBack" size={13} />
                  <span>整体左移 10ms</span>
                </button>
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || !capabilities.canSyncMove}
                  title={isReadOnly ? readOnlyHint : '将全部已选区间同步向右平移 10 ms'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly && capabilities.canSyncMove) {
                      syncTransformMultiSelection('move', 0.01);
                    }
                  }}
                >
                  <UiIcon name="seekForward" size={13} />
                  <span>整体右移 10ms</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || nonEmptyCount === 0}
                  title={isReadOnly ? readOnlyHint : '将已选区间中的 Praat 转义批量转为 Unicode 音标'}
                  onMouseDown={preventBlur}
                  onClick={() => void convertSelectionIpa('to-unicode')}
                >
                  <UiIcon name="convertUnicode" size={13} />
                  <span>批量转 Unicode</span>
                </button>
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || nonEmptyCount === 0}
                  title={isReadOnly ? readOnlyHint : '将已选区间中的 Unicode 音标批量转为 Praat 转义'}
                  onMouseDown={preventBlur}
                  onClick={() => void convertSelectionIpa('to-praat')}
                >
                  <UiIcon name="convertPraat" size={13} />
                  <span>批量转 Praat</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">同步微调</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={!spanValid || !onStartPlayback}
              title="播放所选区间的合并范围"
              onMouseDown={preventBlur}
              onClick={() => {
                if (!spanValid || !onStartPlayback) return;
                setPlayRange({ start: envelopeXmin, end: envelopeXmax });
                onStartPlayback(envelopeXmin, envelopeXmax);
              }}
            >
              <UiIcon name="play" size={22} />
              <span>播放所选范围</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ipa-ctrl-noblur ${isZoomedSpan ? 'ribbon-soft-active' : ''}`}
                  disabled={!spanValid}
                  title={isZoomedSpan ? '恢复显示文档全长' : '放大视野到所选合并范围'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (isZoomedSpan) {
                      setViewDomain(null);
                    } else if (spanValid) {
                      setViewDomain({ min: envelopeXmin, max: envelopeXmax });
                    }
                  }}
                >
                  <UiIcon name={isZoomedSpan ? 'zoomReset' : 'zoomIn'} size={13} />
                  <span>{isZoomedSpan ? '显示全长' : '放大查看'}</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={!spanValid}
                  title="以所选合并范围打开导出图像设置"
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!spanValid) return;
                    setPlayRange({ start: envelopeXmin, end: envelopeXmax });
                    openExportModal('selection');
                  }}
                >
                  <UiIcon name="export" size={13} />
                  <span>导出所选…</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">试听与视图</div>
        </div>

        {(() => {
          const primaryRef =
            selection?.kind === 'interval'
              ? { tierIndex: selection.tierIndex, itemIndex: selection.itemIndex }
              : multiSelection[0];
          const primaryStyle = primaryRef
            ? resolveIntervalStyle(styleDoc, tg, primaryRef.tierIndex, primaryRef.itemIndex)
            : null;
          const curPattern: PatternKind = primaryStyle?.pattern ?? 'none';
          const patOpt = PATTERN_OPTIONS.find((o) => o.kind === curPattern);
          return renderContextualAppearanceGroup({
            activeSwatchId: primaryStyle?.swatchId ?? null,
            swatchVariant: 'fill',
            onPickSwatch: (swatchId) =>
              setMultiIntervalStyle(multiSelection, {
                swatchId,
                fillColor: undefined,
                borderColor: undefined,
                textColor: undefined
              }),
            quickControl: (
              <button
                type="button"
                className={`ribbon-sm-btn ipa-ctrl-noblur ${
                  curPattern !== 'none' ? 'ribbon-soft-active' : ''
                }`}
                title={`批量循环切换所选区间矢量底纹（当前：${patOpt?.label ?? '无底纹'}）`}
                onMouseDown={preventBlur}
                onClick={() =>
                  setMultiIntervalStyle(multiSelection, { pattern: cycleNextPattern(curPattern) })
                }
              >
                <span>底纹: {patOpt?.shortLabel ?? '无'}</span>
              </button>
            ),
            brushKind: 'interval',
            buildBrush: (sticky) => ({
              kind: 'interval',
              patch:
                primaryRef && primaryStyle
                  ? extractRibbonIntervalPatch(
                      primaryRef.tierIndex,
                      primaryRef.itemIndex,
                      primaryStyle
                    )
                  : {},
              sticky
            }),
            hasCustom: Boolean(primaryStyle?.hasCustom)
          });
        })()}
      </>
    );
  };

  const renderBoundaryCtxTab = () => {
    if (!selection || (selection.kind !== 'boundary' && selection.kind !== 'spine')) return null;
    const isBoundary = selection.kind === 'boundary';
    const t = selection.time;
    const readOnlyHint = '仅编辑模式下可用，请先切至编辑模式';
    const hasAudioSession = Boolean(analysis && audioBuffer);
    const targetProjectTiers = tg.tiers
      .map((tier, idx) => ({ tier, idx }))
      .filter(({ tier, idx }) => tier.kind === 'intervalTier' && (!isBoundary || idx !== selection.tierIndex));

    return (
      <>
        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={isReadOnly || !hasAudioSession}
              title={
                isReadOnly
                  ? readOnlyHint
                  : hasAudioSession
                    ? '将当前边界吸附到音频波形中最近的过零点'
                    : '请先载入配套录音后使用过零点吸附'
              }
              onMouseDown={preventBlur}
              onClick={() => void handleSnapBoundaryZeroCrossing()}
            >
              <UiIcon name="zeroCross" size={22} />
              <span>吸附过零点</span>
            </button>

            <div className="ribbon-stack">
              <div className="ribbon-row">
                <div
                  className="ribbon-seg ipa-ctrl-noblur"
                  role="group"
                  aria-label="边界联动范围"
                  onMouseDown={preventBlur}
                >
                  <button
                    type="button"
                    className={isBoundary && !boundaryShared ? 'is-active' : ''}
                    disabled={isReadOnly || !isBoundary}
                    title={
                      !isBoundary
                        ? '对齐时刻始终联动所有对齐层'
                        : '仅移动当前层上的这条边界'
                    }
                    onClick={() => setBoundaryShared(false)}
                  >
                    仅当前层
                  </button>
                  <button
                    type="button"
                    className={!isBoundary || boundaryShared ? 'is-active' : ''}
                    disabled={isReadOnly}
                    title="同步移动所有对齐在同一时刻的层边界与标点"
                    onClick={() => setBoundaryShared(true)}
                  >
                    联动对齐层
                  </button>
                </div>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly}
                  title={isReadOnly ? readOnlyHint : '自动对齐跨层小于 5 ms 的微小偏差'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (isReadOnly) return;
                    const ti = isBoundary ? selection.tierIndex : undefined;
                    const tierName = ti !== undefined ? tg.tiers[ti]?.name : undefined;
                    const res = alignMicroBoundaries(ti);
                    const fb = formatAlignMicroFeedback(res, tierName);
                    showToast(fb.message, fb.isError);
                  }}
                >
                  <UiIcon name="normalize" size={13} />
                  <span>对齐附近微偏</span>
                </button>
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  title="复制当前边界时刻到剪贴板"
                  onMouseDown={preventBlur}
                  onClick={() => {
                    void getPlatformBridge()
                      .writeClipboardText(formatPraatDouble(t))
                      .then(() => showToast(`已复制时刻 ${formatPraatDouble(t)} s`))
                      .catch(() => showToast('剪贴板写入受限', true));
                  }}
                >
                  <UiIcon name="copyTime" size={13} />
                  <span>复制时刻</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">定位与联动</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className={`ribbon-big-btn ipa-ctrl-noblur ${
                openMenu === 'project-boundary' ? 'is-menu-open' : ''
              }`}
              disabled={isReadOnly || targetProjectTiers.length === 0}
              aria-expanded={openMenu === 'project-boundary'}
              title={
                isReadOnly
                  ? readOnlyHint
                  : targetProjectTiers.length === 0
                    ? '当前没有其他区间层'
                    : '将当前边界复制到其他区间层'
              }
              onMouseDown={preventBlur}
              onClick={(e) => togglePopoutMenu('project-boundary', e.currentTarget)}
            >
              <UiIcon name="projectToTier" size={22} />
              <span className="ribbon-big-label-caret">
                <span>复制到其他层</span>
                <ChevronIcon size={9} />
              </span>
            </button>
          </div>
          <div className="ribbon-group-label">跨层处理</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn is-danger ipa-ctrl-noblur"
              disabled={isReadOnly}
              title={
                isReadOnly
                  ? readOnlyHint
                  : isBoundary
                    ? '删除当前层上的这条边界并合并左右区间'
                    : '删除此对齐时刻上的全部边界'
              }
              onMouseDown={preventBlur}
              onClick={() => {
                if (isReadOnly) return;
                if (isBoundary) {
                  deleteBoundaryAt(selection.tierIndex, t);
                } else {
                  deleteBoundaryAcrossAllTiers(t);
                }
              }}
            >
              <UiIcon name="delBoundary" size={22} />
              <span>删除边界</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn is-danger ipa-ctrl-noblur"
                  disabled={isReadOnly}
                  title={isReadOnly ? readOnlyHint : '一次性删除所有层上处于该时刻的对齐边界'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly) deleteBoundaryAcrossAllTiers(t);
                  }}
                >
                  <UiIcon name="delBoundaryAll" size={13} />
                  <span>删全部对齐边界</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">删除边界</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={!onStartPlayback || tg.xmax <= tg.xmin}
              title="跨越当前边界试听前后各 200 ms"
              onMouseDown={preventBlur}
              onClick={() => {
                if (!onStartPlayback) return;
                const start = Math.max(tg.xmin, t - 0.2);
                const end = Math.min(tg.xmax, t + 0.2);
                if (end > start) onStartPlayback(start, end);
              }}
            >
              <UiIcon name="playContext" size={22} />
              <span>跨界试听 ±200ms</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={!onStartPlayback || t <= tg.xmin + 1e-6}
                  title="试听边界前 250 ms"
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!onStartPlayback) return;
                    const start = Math.max(tg.xmin, t - 0.25);
                    if (t > start) onStartPlayback(start, t);
                  }}
                >
                  <UiIcon name="seekBack" size={13} />
                  <span>前 250ms</span>
                </button>
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={!onStartPlayback || t >= tg.xmax - 1e-6}
                  title="试听边界后 250 ms"
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!onStartPlayback) return;
                    const end = Math.min(tg.xmax, t + 0.25);
                    if (end > t) onStartPlayback(t, end);
                  }}
                >
                  <UiIcon name="seekForward" size={13} />
                  <span>后 250ms</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={!onStartPlayback || t >= tg.xmax - 1e-6}
                  title="从当前边界时刻向后播放至结尾"
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!onStartPlayback) return;
                    setPlayRange(null);
                    onStartPlayback(t, tg.xmax);
                  }}
                >
                  <UiIcon name="play" size={13} />
                  <span>从此处播放</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">试听边界</div>
        </div>

        {(() => {
          const targetTierIndex = isBoundary ? selection.tierIndex : null;
          const bndStyle = resolveBoundaryStyle(
            styleDoc,
            tg,
            isBoundary ? selection.tierIndex : -1,
            t
          );
          return renderContextualAppearanceGroup({
            activeSwatchId: bndStyle.swatchId,
            swatchVariant: 'line',
            onPickSwatch: (swatchId) =>
              setBoundaryStyle(targetTierIndex, t, { swatchId, strokeColor: undefined }),
            quickControl: (
              <button
                type="button"
                className={`ribbon-sm-btn ipa-ctrl-noblur ${
                  bndStyle.extendToAcoustic ? 'ribbon-soft-active' : ''
                }`}
                aria-pressed={bndStyle.extendToAcoustic}
                title="向上贯穿至波形与语谱图，绘制垂直对齐参考线"
                onMouseDown={preventBlur}
                onClick={() =>
                  setBoundaryStyle(targetTierIndex, t, {
                    extendToAcoustic: !bndStyle.extendToAcoustic
                  })
                }
              >
                <span>贯穿声学区</span>
              </button>
            ),
            brushKind: 'boundary',
            buildBrush: (sticky) => ({
              kind: 'boundary',
              patch: extractRibbonBoundaryPatch(targetTierIndex, t, bndStyle),
              sticky
            }),
            hasCustom: bndStyle.hasCustom
          });
        })()}
      </>
    );
  };

  const renderPointCtxTab = () => {
    if (
      selection?.kind !== 'point' ||
      !activePoint ||
      !activePointTier ||
      activePointTier.kind !== 'textTier'
    ) {
      return null;
    }
    const ti = selection.tierIndex;
    const pi = selection.itemIndex;
    const pt = activePoint;
    const readOnlyHint = '仅编辑模式下可用，请先切至编辑模式';
    const hasAudioSession = Boolean(analysis && audioBuffer);

    return (
      <>
        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={isReadOnly || !hasAudioSession}
              title={
                isReadOnly
                  ? readOnlyHint
                  : hasAudioSession
                    ? '将当前标点吸附到波形中最近的过零点'
                    : '请先载入配套录音后使用过零点吸附'
              }
              onMouseDown={preventBlur}
              onClick={() => void handleSnapPointZeroCrossing()}
            >
              <UiIcon name="zeroCross" size={22} />
              <span>吸附过零点</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly}
                  title={isReadOnly ? readOnlyHint : '将当前标点吸附到其他区间层最近的边界'}
                  onMouseDown={preventBlur}
                  onClick={handleSnapPointNearestBoundary}
                >
                  <UiIcon name="nudgeBoundary" size={13} />
                  <span>吸附附近边界</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly}
                  title={isReadOnly ? readOnlyHint : '将当前标点移到所在区间的正中时刻'}
                  onMouseDown={preventBlur}
                  onClick={handleMovePointToIntervalMid}
                >
                  <UiIcon name="nudgeFine" size={13} />
                  <span>移到区间中点</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">对齐与吸附</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || pt.mark === ''}
                  title={isReadOnly ? readOnlyHint : '清空当前标点的文字标记'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (isReadOnly || pt.mark === '') return;
                    const oldMark = pt.mark;
                    const tierName = formatTierLabel(activePointTier.name, ti);
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
                        title: '清空标点文字',
                        detail: `${tierName} · ${formatTimeSec(pt.number)} 原${formatQuote(oldMark)}`,
                        icon: 'clear',
                        tierName,
                        focusTime: pt.number
                      }
                    );
                  }}
                >
                  <UiIcon name="clear" size={13} />
                  <span>清空文字</span>
                </button>
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={!pt.mark}
                  title="复制当前标点文字到剪贴板"
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!pt.mark) return;
                    void getPlatformBridge()
                      .writeClipboardText(pt.mark)
                      .then(() => showToast('已复制标点文字'))
                      .catch(() => showToast('剪贴板写入受限', true));
                  }}
                >
                  <UiIcon name="copy" size={13} />
                  <span>复制文字</span>
                </button>
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  title="复制当前标点时刻到剪贴板"
                  onMouseDown={preventBlur}
                  onClick={() => {
                    void getPlatformBridge()
                      .writeClipboardText(formatPraatDouble(pt.number))
                      .then(() => showToast(`已复制时刻 ${formatPraatDouble(pt.number)} s`))
                      .catch(() => showToast('剪贴板写入受限', true));
                  }}
                >
                  <UiIcon name="copyTime" size={13} />
                  <span>复制时刻</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || !pt.mark}
                  title={isReadOnly ? readOnlyHint : '将当前标点的 Praat 转义转为 Unicode 音标'}
                  onMouseDown={preventBlur}
                  onClick={() => void convertSelectionIpa('to-unicode')}
                >
                  <UiIcon name="convertUnicode" size={13} />
                  <span>转 Unicode</span>
                </button>
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || !pt.mark}
                  title={isReadOnly ? readOnlyHint : '将当前标点的 Unicode 音标转为 Praat 转义'}
                  onMouseDown={preventBlur}
                  onClick={() => void convertSelectionIpa('to-praat')}
                >
                  <UiIcon name="convertPraat" size={13} />
                  <span>转 Praat</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">文字与音标</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={!onStartPlayback || tg.xmax <= tg.xmin}
              title="试听当前标点前后各 250 ms"
              onMouseDown={preventBlur}
              onClick={() => {
                if (!onStartPlayback) return;
                const start = Math.max(tg.xmin, pt.number - 0.25);
                const end = Math.min(tg.xmax, pt.number + 0.25);
                if (end > start) onStartPlayback(start, end);
              }}
            >
              <UiIcon name="playContext" size={22} />
              <span>前后试听 ±250ms</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={!onStartPlayback || pt.number >= tg.xmax - 1e-6}
                  title="从当前标点时刻向后播放"
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!onStartPlayback) return;
                    setPlayRange(null);
                    onStartPlayback(pt.number, tg.xmax);
                  }}
                >
                  <UiIcon name="play" size={13} />
                  <span>从此处播放</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn is-danger ipa-ctrl-noblur"
                  disabled={isReadOnly}
                  title={isReadOnly ? readOnlyHint : '删除当前标点（支持撤销）'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (isReadOnly) return;
                    const tierName = formatTierLabel(activePointTier.name, ti);
                    const ptNum = pt.number;
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
                        detail: `${tierName} · ${formatTimeSec(ptNum)} ${formatQuote(ptMark)}`,
                        icon: 'trash',
                        tierName,
                        focusTime: ptNum
                      }
                    );
                  }}
                >
                  <UiIcon name="trash" size={13} />
                  <span>删除标点</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">试听与删除</div>
        </div>

        {(() => {
          const ptStyle = resolvePointStyle(styleDoc, tg, ti, pi);
          const shapeOpt = POINT_SHAPE_OPTIONS.find((o) => o.shape === ptStyle.shape);
          return renderContextualAppearanceGroup({
            activeSwatchId: ptStyle.swatchId,
            swatchVariant: 'line',
            onPickSwatch: (swatchId) =>
              setPointStyle(ti, pi, {
                swatchId,
                color: undefined,
                stemColor: undefined,
                textColor: undefined
              }),
            quickControl: (
              <button
                type="button"
                className={`ribbon-sm-btn ipa-ctrl-noblur ${
                  ptStyle.shape !== 'circle' ? 'ribbon-soft-active' : ''
                }`}
                title={`点击循环切换标点形状（当前：${shapeOpt?.label ?? '圆点'}）`}
                onMouseDown={preventBlur}
                onClick={() =>
                  setPointStyle(ti, pi, { shape: cycleNextPointShape(ptStyle.shape) })
                }
              >
                <PointShapeIcon shape={ptStyle.shape} size={12} />
                <span>{shapeOpt?.label ?? '圆点'}</span>
              </button>
            ),
            brushKind: 'point',
            buildBrush: (sticky) => ({
              kind: 'point',
              patch: extractRibbonPointPatch(ti, pi, ptStyle),
              sticky
            }),
            hasCustom: ptStyle.hasCustom
          });
        })()}
      </>
    );
  };

  const renderTierCtxTab = () => {
    if (selection?.kind !== 'tier' || !activeTierObj) return null;
    const ti = selection.tierIndex;
    const tier = activeTierObj;
    const isIntervalTier = tier.kind === 'intervalTier';
    const isHidden = hiddenTierIndices.includes(ti);
    const isSoloed =
      tg.tiers.length > 1 &&
      !isHidden &&
      hiddenTierIndices.length === tg.tiers.length - 1;
    const readOnlyHint = '仅编辑模式下可用，请先切至编辑模式';

    return (
      <>
        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={isReadOnly}
              title={isReadOnly ? readOnlyHint : '复制当前层及其全部内容到下方'}
              onMouseDown={preventBlur}
              onClick={() => {
                if (!isReadOnly) duplicateTier(ti, { copyText: true });
              }}
            >
              <UiIcon name="duplicateTier" size={22} />
              <span>复制整层</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || !isIntervalTier}
                  title={
                    isReadOnly
                      ? readOnlyHint
                      : isIntervalTier
                        ? '仅复制时间边界结构，不复制文本'
                        : '仅区间层支持仅复制边界'
                  }
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly && isIntervalTier) {
                      duplicateTier(ti, { copyText: false });
                    }
                  }}
                >
                  <UiIcon name="layers" size={13} />
                  <span>仅复制边界</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ipa-ctrl-noblur ${
                    openMenu === 'derive-point-tier' ? 'is-menu-open' : ''
                  }`}
                  disabled={isReadOnly || !isIntervalTier}
                  aria-expanded={openMenu === 'derive-point-tier'}
                  title={
                    isReadOnly
                      ? readOnlyHint
                      : isIntervalTier
                        ? '按本层各非空区间的起点、中点或终点生成新点层'
                        : '仅区间层可生成点层'
                  }
                  onMouseDown={preventBlur}
                  onClick={(e) => togglePopoutMenu('derive-point-tier', e.currentTarget)}
                >
                  <UiIcon name="derivePointTier" size={13} />
                  <span>生成点层</span>
                  <ChevronIcon size={10} />
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">复制与生成</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly}
                  title={isReadOnly ? readOnlyHint : '在当前层上方插入一个新区间层'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly) insertTierAt(ti, 'intervalTier');
                  }}
                >
                  <UiIcon name="addIntervalTier" size={13} />
                  <span>上方插层</span>
                </button>
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly}
                  title={isReadOnly ? readOnlyHint : '在当前层下方插入一个新区间层'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly) insertTierAt(ti + 1, 'intervalTier');
                  }}
                >
                  <UiIcon name="addIntervalTier" size={13} />
                  <span>下方插层</span>
                </button>
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly}
                  title={isReadOnly ? readOnlyHint : '在当前层下方插入一个新点层'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly) insertTierAt(ti + 1, 'textTier');
                  }}
                >
                  <UiIcon name="addPointTier" size={13} />
                  <span>插入点层</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || ti <= 0}
                  title={isReadOnly ? readOnlyHint : '将当前层向上移动一位'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly && ti > 0) moveTier(ti, -1);
                  }}
                >
                  <UiIcon name="up" size={13} />
                  <span>上移</span>
                </button>
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly || ti >= tg.tiers.length - 1}
                  title={isReadOnly ? readOnlyHint : '将当前层向下移动一位'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly && ti < tg.tiers.length - 1) moveTier(ti, 1);
                  }}
                >
                  <UiIcon name="down" size={13} />
                  <span>下移</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">插入与顺序</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={isReadOnly}
              title={isReadOnly ? readOnlyHint : '对齐本层与其他层之间小于 5 ms 的微偏边界'}
              onMouseDown={preventBlur}
              onClick={() => {
                if (isReadOnly) return;
                const res = alignMicroBoundaries(ti);
                const fb = formatAlignMicroFeedback(res, tier.name);
                showToast(fb.message, fb.isError);
              }}
            >
              <UiIcon name="normalize" size={22} />
              <span>对齐本层微偏</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ipa-ctrl-noblur ${isHidden ? 'ribbon-soft-active' : ''}`}
                  disabled={tg.tiers.length <= 1}
                  title={isHidden ? '在画布中重新显示此层' : '在画布中暂时隐藏此层'}
                  onMouseDown={preventBlur}
                  onClick={() => toggleTierVisibility(ti)}
                >
                  <UiIcon name={isHidden ? 'showTier' : 'hideTier'} size={13} />
                  <span>{isHidden ? '显示此层' : '隐藏此层'}</span>
                </button>
                <button
                  type="button"
                  className={`ribbon-sm-btn ipa-ctrl-noblur ${isSoloed ? 'ribbon-soft-active' : ''}`}
                  disabled={tg.tiers.length <= 1}
                  title={isSoloed ? '恢复显示全部层级' : '仅在画布中显示当前这一层'}
                  onMouseDown={preventBlur}
                  onClick={() => soloTier(ti)}
                >
                  <UiIcon name="showTier" size={13} />
                  <span>仅看此层</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn ipa-ctrl-noblur"
                  disabled={isReadOnly}
                  title={isReadOnly ? readOnlyHint : '清空本层所有区间或标点的文本（保留边界）'}
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly) clearTierText(ti);
                  }}
                >
                  <UiIcon name="clear" size={13} />
                  <span>清空文本</span>
                </button>
                <button
                  type="button"
                  className="ribbon-sm-btn is-danger ipa-ctrl-noblur"
                  disabled={isReadOnly || tg.tiers.length <= 1}
                  title={
                    isReadOnly
                      ? readOnlyHint
                      : tg.tiers.length <= 1
                        ? '文档至少需要保留一个层级'
                        : '删除当前层级（支持撤销）'
                  }
                  onMouseDown={preventBlur}
                  onClick={() => {
                    if (!isReadOnly && tg.tiers.length > 1) removeTierWithUndoToast(ti);
                  }}
                >
                  <UiIcon name="trash" size={13} />
                  <span>删除此层</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">整理与显隐</div>
        </div>

        {(() => {
          const tierPatch = styleDoc.tierStyles[tier.name] ?? styleDoc.tierStyles[`#${ti}`] ?? null;
          const resolvedTier = resolveTierStyle(styleDoc, tg, ti);
          const activeSwatch = isIntervalTier
            ? tierPatch?.intervalDefault?.swatchId ?? null
            : tierPatch?.pointDefault?.swatchId ?? null;
          const curPat: PatternKind = tierPatch?.intervalDefault?.pattern ?? 'none';
          const patOpt = PATTERN_OPTIONS.find((o) => o.kind === curPat);
          const curShape: PointShape = tierPatch?.pointDefault?.shape ?? 'circle';
          const shapeOpt = POINT_SHAPE_OPTIONS.find((o) => o.shape === curShape);
          const hasCustomTier = Boolean(
            resolvedTier.hasCustom ||
              tierPatch?.intervalDefault ||
              tierPatch?.boundaryDefault ||
              tierPatch?.pointDefault
          );
          return renderContextualAppearanceGroup({
            activeSwatchId: activeSwatch,
            swatchVariant: isIntervalTier ? 'fill' : 'line',
            onPickSwatch: (swatchId) =>
              setTierStyle(
                ti,
                isIntervalTier
                  ? { intervalDefault: { swatchId } }
                  : { pointDefault: { swatchId } }
              ),
            quickControl: isIntervalTier ? (
              <button
                type="button"
                className={`ribbon-sm-btn ipa-ctrl-noblur ${
                  curPat !== 'none' ? 'ribbon-soft-active' : ''
                }`}
                title={`点击循环切换本层默认底纹（当前：${patOpt?.label ?? '无底纹'}）`}
                onMouseDown={preventBlur}
                onClick={() =>
                  setTierStyle(ti, { intervalDefault: { pattern: cycleNextPattern(curPat) } })
                }
              >
                <span>底纹: {patOpt?.shortLabel ?? '无'}</span>
              </button>
            ) : (
              <button
                type="button"
                className={`ribbon-sm-btn ipa-ctrl-noblur ${
                  curShape !== 'circle' ? 'ribbon-soft-active' : ''
                }`}
                title={`点击循环切换本层默认标点形状（当前：${shapeOpt?.label ?? '圆点'}）`}
                onMouseDown={preventBlur}
                onClick={() =>
                  setTierStyle(ti, { pointDefault: { shape: cycleNextPointShape(curShape) } })
                }
              >
                <PointShapeIcon shape={curShape} size={12} />
                <span>{shapeOpt?.label ?? '圆点'}</span>
              </button>
            ),
            brushKind: 'tier',
            buildBrush: (sticky) => ({
              kind: 'tier',
              patch: tierPatch ? { ...tierPatch } : {},
              sticky
            }),
            hasCustom: hasCustomTier
          });
        })()}
      </>
    );
  };

  return (
    <div className="ribbon-bar" ref={ribbonBarRef}>
      {/* Row 1: 28px Underline Ribbon Tab Row + Right Pinned Global Controls */}
      <div className="ribbon-tabrow">
        <div
          className="ribbon-tabs ipa-ctrl-noblur"
          role="tablist"
          aria-label="功能页签"
          onMouseDown={preventBlur}
        >
          {BASE_TABS.map((tab) => {
            const isActive = !isContextualViewActive && effectiveTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`ribbon-tab ${isActive ? 'is-active' : ''}`}
                title="点击切换页签，双击当前页签可收起或展开工具区"
                onClick={() => handleTabClick(tab.id)}
                onDoubleClick={() => handleTabDoubleClick(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
          {(isCorpus || contextualKind !== null) && (
            <span className="ribbon-tab-sep" aria-hidden="true" />
          )}
          {isCorpus && (
            <button
              type="button"
              role="tab"
              aria-selected={!isContextualViewActive && effectiveTab === 'corpus'}
              className={`ribbon-tab is-contextual ${
                !isContextualViewActive && effectiveTab === 'corpus' ? 'is-active' : ''
              }`}
              title="文件夹批量标注设置与导航（双击可收起或展开工具区）"
              onClick={() => handleTabClick('corpus')}
              onDoubleClick={() => handleTabDoubleClick('corpus')}
            >
              词表
            </button>
          )}
          {contextualKind !== null && (
            <button
              type="button"
              role="tab"
              aria-selected={isContextualViewActive}
              data-ctx-kind={contextualKind}
              className={`ribbon-tab is-contextual-obj ${isContextualViewActive ? 'is-active' : ''}`}
              title={`当前选中对象的快捷操作：${contextualTabLabel}（双击可收起或展开工具区）`}
              onClick={handleContextualTabClick}
              onDoubleClick={handleContextualTabDoubleClick}
            >
              {contextualTabLabel}
            </button>
          )}
        </div>

        <div className="ribbon-right-pin">
          <button
            type="button"
            className="ribbon-pin-btn ipa-ctrl-noblur"
            title={undoTitle}
            disabled={!canUndo}
            onMouseDown={preventBlur}
            onClick={undo}
          >
            <UiIcon name="undo" size={13} />
            <span className="ribbon-pin-label">撤销</span>
          </button>
          <button
            type="button"
            className="ribbon-pin-btn ipa-ctrl-noblur"
            title={redoTitle}
            disabled={!canRedo}
            onMouseDown={preventBlur}
            onClick={redo}
          >
            <UiIcon name="redo" size={13} />
            <span className="ribbon-pin-label">重做</span>
          </button>

          <span className="ribbon-pin-sep" aria-hidden="true" />

          <div
            className="ribbon-mode-seg ipa-ctrl-noblur"
            role="group"
            aria-label="浏览与编辑模式"
            onMouseDown={preventBlur}
          >
            <button
              type="button"
              className={mode === 'read' ? 'is-active' : ''}
              aria-pressed={mode === 'read'}
              title="只读浏览模式"
              onClick={() => setMode('read')}
            >
              <UiIcon name="readMode" size={12} />
              <span>只读</span>
            </button>
            <button
              type="button"
              className={mode === 'edit' ? 'is-active' : ''}
              aria-pressed={mode === 'edit'}
              title="编辑标注模式 (E)"
              onClick={() => setMode('edit')}
            >
              <UiIcon name="edit" size={12} />
              <span>编辑</span>
            </button>
          </div>

          <span className="ribbon-pin-sep" aria-hidden="true" />

          <div className={`menu-wrap ribbon-export-wrap ${openMenu === 'export' ? 'open' : ''}`}>
            <button
              type="button"
              className="ribbon-export-btn ribbon-ink-primary"
              aria-expanded={openMenu === 'export'}
              onClick={() => setOpenMenu(openMenu === 'export' ? null : 'export')}
            >
              <span className="btn-lead">
                <UiIcon name="export" size={13} />
                <span>导出与保存</span>
              </span>
              <ChevronIcon size={10} />
            </button>
            <div className="dropdown">
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('save');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>
                    {isDesktop && !currentFilePath ? '保存 (.TextGrid)…' : '保存 (.TextGrid)'}
                  </span>
                </span>
                {saveFileHint && <span className="shortcut">{saveFileHint}</span>}
              </button>
              {isDesktop && (
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenu(null);
                    onExportAction('save-as');
                  }}
                >
                  <span className="btn-lead">
                    <UiIcon name="saveAs" size={13} />
                    <span>另存为…</span>
                  </span>
                  {saveAsHint && <span className="shortcut">{saveAsHint}</span>}
                </button>
              )}
              <div className="menu-divider" />
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('svg');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="exportSvg" size={13} />
                  <span>导出矢量图 (.svg)</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('png');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="exportPng" size={13} />
                  <span>导出高清图片 (.png)</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('dialog');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="export" size={13} />
                  <span>自定义导出图像…</span>
                </span>
                {exportFigureHint && <span className="shortcut">{exportFigureHint}</span>}
              </button>
              <div className="menu-divider" />
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('poster');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="exportSvg" size={13} />
                  <span>导出声纹海报…</span>
                </span>
              </button>
              <div className="menu-divider" />
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('long');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>保存标准文本 (.TextGrid)</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('short');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>保存短文本 (.TextGrid)</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('binary');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>保存二进制 (.TextGrid)</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('chrono');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>保存按时间排序文本</span>
                </span>
              </button>
              <div className="menu-divider" />
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('col-bin');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="fileCollection" size={13} />
                  <span>保存集合 (.Collection 二进制)</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('col-text');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="fileCollection" size={13} />
                  <span>保存集合 (.Collection 文本)</span>
                </span>
              </button>
            </div>
          </div>

          <button
            type="button"
            className={`ribbon-collapse-btn ipa-ctrl-noblur ${ribbonCollapsed ? 'is-collapsed' : ''}`}
            aria-expanded={!ribbonCollapsed}
            title={ribbonCollapsed ? '展开工具区' : '收起工具区'}
            aria-label={ribbonCollapsed ? '展开工具区' : '收起工具区'}
            onMouseDown={preventBlur}
            onClick={toggleRibbonCollapsed}
          >
            <ChevronIcon size={11} />
          </button>
        </div>
      </div>

      {/* Row 2: 74px Classic Tiered Ribbon Panel */}
      <div className={`ribbon-panel-shell ${ribbonCollapsed ? 'is-collapsed' : ''}`}>
        <div
          ref={panelRef}
          className="ribbon-panel"
          role="toolbar"
          aria-label="当前页签工具区"
          onScroll={() => {
            if (openMenu && openMenu !== 'export') {
              setOpenMenu(null);
            }
          }}
        >
          {isContextualViewActive ? (
            <>
              {contextualKind === 'interval' && renderIntervalCtxTab()}
              {contextualKind === 'multi' && renderMultiCtxTab()}
              {contextualKind === 'boundary' && renderBoundaryCtxTab()}
              {contextualKind === 'point' && renderPointCtxTab()}
              {contextualKind === 'tier' && renderTierCtxTab()}
            </>
          ) : (
            <>
              {effectiveTab === 'file' && renderFileTab()}
              {effectiveTab === 'annotate' && renderAnnotateTab()}
              {effectiveTab === 'tiers' && renderTiersTab()}
              {effectiveTab === 'view' && renderViewTab()}
              {effectiveTab === 'tools' && renderToolsTab()}
              {effectiveTab === 'corpus' && renderCorpusTab()}
            </>
          )}
        </div>
      </div>

      {/* Detached Popout Menus (mounted outside scrollable .ribbon-panel so they never clip) */}
      {openMenu === 'samples' && popoutPos && (
        <div
          className="ribbon-popout-menu"
          role="menu"
          style={{ left: popoutPos.left, top: popoutPos.top }}
        >
          <button
            type="button"
            onClick={() => {
              setOpenMenu(null);
              onLoadSample('dialogue');
            }}
          >
            <span className="btn-lead">
              <UiIcon name="waveform" size={13} />
              <span>双人对话与声谱（含录音）</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpenMenu(null);
              onLoadSample('corpus');
            }}
          >
            <span className="btn-lead">
              <CorpusFolderIcon size={13} />
              <span>文件夹批量标注示例（5 条）</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpenMenu(null);
              onLoadSample('poem');
            }}
          >
            <span className="btn-lead">
              <UiIcon name="samples" size={13} />
              <span>普通话与音标示例</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpenMenu(null);
              onLoadSample('edge');
            }}
          >
            <span className="btn-lead">
              <UiIcon name="samples" size={13} />
              <span>完整字符与边界示例</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpenMenu(null);
              onLoadSample('wild');
            }}
          >
            <span className="btn-lead">
              <UiIcon name="samples" size={13} />
              <span>长停顿与特殊结构示例</span>
            </span>
          </button>
          <div className="menu-divider" />
          <button
            type="button"
            onClick={() => {
              setOpenMenu(null);
              onLoadSample('blank');
            }}
          >
            <span className="btn-lead">
              <UiIcon name="tab-add" size={13} />
              <span>新建空白文件</span>
            </span>
            <span className="shortcut">{formatKeyCombo('Mod+T')}</span>
          </button>
        </div>
      )}

      {openMenu === 'col' && popoutPos && collectionTgs.length > 1 && (
        <div
          className="ribbon-popout-menu"
          role="menu"
          style={{ left: popoutPos.left, top: popoutPos.top }}
        >
          {collectionTgs.map((item, idx) => (
            <button
              key={`${item.name}-${idx}`}
              type="button"
              className={idx === collectionActiveIdx ? 'selected' : ''}
              onClick={() => {
                switchCollectionItem(idx);
                setOpenMenu(null);
              }}
            >
              <span>
                {idx + 1}. {item.name || `TextGrid ${idx + 1}`}
              </span>
            </button>
          ))}
        </div>
      )}

      {openMenu === 'smart-split' &&
        popoutPos &&
        selection?.kind === 'interval' &&
        activeInterval &&
        activeIntervalTier?.kind === 'intervalTier' && (
          <div
            className="ribbon-popout-menu ipa-ctrl-noblur"
            role="menu"
            style={{ left: popoutPos.left, top: popoutPos.top }}
            onMouseDown={preventBlur}
          >
            {intervalSmartPlan?.primary && (
              <>
                <div className="ribbon-menu-heading">推荐拆分方案</div>
                {[intervalSmartPlan.primary, ...intervalSmartPlan.alternatives]
                  .slice(0, 4)
                  .map((cand, cIdx) => (
                    <button
                      key={cand.id}
                      type="button"
                      onClick={() => {
                        setOpenMenu(null);
                        void executeSmartSplitCandidate(
                          selection.tierIndex,
                          selection.itemIndex,
                          {
                            xmin: activeInterval.xmin,
                            xmax: activeInterval.xmax,
                            text: activeInterval.text
                          },
                          cand,
                          smartSplitUseAcoustic
                        );
                      }}
                    >
                      <span className="btn-lead">
                        <UiIcon name="autoSplit" size={13} />
                        <span>{cand.strategyLabel}</span>
                      </span>
                      <span className={`ribbon-menu-badge ${cIdx === 0 ? 'is-primary' : ''}`}>
                        {cIdx === 0 ? `首推 · ${cand.texts.length}段` : `${cand.texts.length}段`}
                      </span>
                    </button>
                  ))}
                {audioBuffer && (
                  <>
                    <div className="menu-divider" />
                    <button
                      type="button"
                      onClick={() => setSmartSplitUseAcoustic(!smartSplitUseAcoustic)}
                    >
                      <span className="btn-lead">
                        <UiIcon name="waveform" size={13} />
                        <span>声学边界对齐</span>
                      </span>
                      <span className="ribbon-menu-badge">
                        {smartSplitUseAcoustic ? '已开启' : '已关闭'}
                      </span>
                    </button>
                  </>
                )}
                <div className="menu-divider" />
              </>
            )}

            <div className="ribbon-menu-heading">快速等分与按文本拆分</div>
            {([2, 3, 4] as const).map((n) => (
              <button
                key={`eq-${n}`}
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  splitIntervalEqualN(selection.tierIndex, selection.itemIndex, n);
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="splitEqual" size={13} />
                  <span>等分为 {n} 段</span>
                </span>
              </button>
            ))}
            <button
              type="button"
              disabled={!intervalSplitTextStats.canCharSplit}
              onClick={() => {
                setOpenMenu(null);
                splitIntervalByChars(selection.tierIndex, selection.itemIndex, {
                  punctuation: 'ignore'
                });
              }}
            >
              <span className="btn-lead">
                <UiIcon name="splitEqual" size={13} />
                <span>按字数拆分</span>
              </span>
              {intervalSplitTextStats.canCharSplit && (
                <span className="ribbon-menu-badge">{intervalSplitTextStats.charCount}段</span>
              )}
            </button>
            <button
              type="button"
              disabled={!intervalSplitTextStats.canSpaceSplit}
              onClick={() => {
                setOpenMenu(null);
                splitIntervalByDelimiter(selection.tierIndex, selection.itemIndex, {
                  preset: 'whitespace',
                  stripEdgePunctuation: true
                });
              }}
            >
              <span className="btn-lead">
                <UiIcon name="splitEqual" size={13} />
                <span>按空格拆分</span>
              </span>
              {intervalSplitTextStats.canSpaceSplit && (
                <span className="ribbon-menu-badge">{intervalSplitTextStats.spaceCount}段</span>
              )}
            </button>
            <div className="menu-divider" />
            <button
              type="button"
              disabled={!onOpenSplitModal}
              onClick={() => {
                setOpenMenu(null);
                onOpenSplitModal?.(selection.tierIndex, selection.itemIndex);
              }}
            >
              <span className="btn-lead">
                <UiIcon name="customize" size={13} />
                <span>自定义等分…</span>
              </span>
            </button>
          </div>
        )}

      {openMenu === 'copy-interval-tier' &&
        popoutPos &&
        selection?.kind === 'interval' &&
        activeInterval && (
          <div
            className="ribbon-popout-menu ipa-ctrl-noblur"
            role="menu"
            style={{ left: popoutPos.left, top: popoutPos.top }}
            onMouseDown={preventBlur}
          >
            <div className="ribbon-menu-heading">复制区间到其他层</div>
            {tg.tiers
              .map((tier, idx) => ({ tier, idx }))
              .filter(({ tier, idx }) => idx !== selection.tierIndex && tier.kind === 'intervalTier')
              .map(({ tier, idx }) => (
                <div key={`copy-iv-${idx}`} className="ribbon-menu-tier-row">
                  <span
                    className="ribbon-menu-tier-name"
                    title={tier.name || `层 ${idx + 1}`}
                  >
                    {idx + 1}. {tier.name || '未命名层'}
                  </span>
                  <div className="ribbon-menu-tier-actions">
                    <button
                      type="button"
                      title="复制起止边界并保留文本"
                      onClick={() => {
                        setOpenMenu(null);
                        copyIntervalSpanToTier(selection.tierIndex, selection.itemIndex, idx, true);
                      }}
                    >
                      含文本
                    </button>
                    <button
                      type="button"
                      title="仅复制起止边界，不覆盖文本"
                      onClick={() => {
                        setOpenMenu(null);
                        copyIntervalSpanToTier(selection.tierIndex, selection.itemIndex, idx, false);
                      }}
                    >
                      仅边界
                    </button>
                  </div>
                </div>
              ))}
          </div>
        )}

      {openMenu === 'project-boundary' &&
        popoutPos &&
        selection &&
        (selection.kind === 'boundary' || selection.kind === 'spine') && (
          <div
            className="ribbon-popout-menu ipa-ctrl-noblur"
            role="menu"
            style={{ left: popoutPos.left, top: popoutPos.top }}
            onMouseDown={preventBlur}
          >
            <div className="ribbon-menu-heading">复制边界到其他区间层</div>
            {tg.tiers
              .map((tier, idx) => ({ tier, idx }))
              .filter(
                ({ tier, idx }) =>
                  tier.kind === 'intervalTier' &&
                  (selection.kind !== 'boundary' || idx !== selection.tierIndex)
              )
              .map(({ tier, idx }) => {
                const alreadyAligned =
                  tier.kind === 'intervalTier' &&
                  tier.intervals.some(
                    (iv) =>
                      Math.abs(iv.xmin - selection.time) <= 1e-5 ||
                      Math.abs(iv.xmax - selection.time) <= 1e-5
                  );
                return (
                  <button
                    key={`proj-bnd-${idx}`}
                    type="button"
                    disabled={alreadyAligned}
                    onClick={() => {
                      setOpenMenu(null);
                      if (!alreadyAligned) {
                        projectBoundaryToTier(idx, selection.time);
                      }
                    }}
                  >
                    <span className="btn-lead">
                      <UiIcon name="projectToTier" size={13} />
                      <span>
                        {idx + 1}. {tier.name || '未命名层'}
                      </span>
                    </span>
                    {alreadyAligned && (
                      <span className="ribbon-menu-check">
                        <UiIcon name="check" size={12} />
                        <span>已对齐</span>
                      </span>
                    )}
                  </button>
                );
              })}
          </div>
        )}

      {openMenu === 'derive-point-tier' &&
        popoutPos &&
        selection?.kind === 'tier' &&
        activeTierObj?.kind === 'intervalTier' && (
          <div
            className="ribbon-popout-menu ipa-ctrl-noblur"
            role="menu"
            style={{ left: popoutPos.left, top: popoutPos.top }}
            onMouseDown={preventBlur}
          >
            <div className="ribbon-menu-heading">按区间位置生成点层</div>
            <button
              type="button"
              onClick={() => {
                setOpenMenu(null);
                derivePointTierFromIntervals(selection.tierIndex, 'start');
              }}
            >
              <span className="btn-lead">
                <UiIcon name="derivePointTier" size={13} />
                <span>按区间起点生成</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setOpenMenu(null);
                derivePointTierFromIntervals(selection.tierIndex, 'mid');
              }}
            >
              <span className="btn-lead">
                <UiIcon name="derivePointTier" size={13} />
                <span>按区间中点生成</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setOpenMenu(null);
                derivePointTierFromIntervals(selection.tierIndex, 'end');
              }}
            >
              <span className="btn-lead">
                <UiIcon name="derivePointTier" size={13} />
                <span>按区间终点生成</span>
              </span>
            </button>
          </div>
        )}

      {openMenu === 'style-palette' && popoutPos && (
        <div
          className="ribbon-popout-menu ipa-ctrl-noblur"
          role="menu"
          style={{ left: popoutPos.left, top: popoutPos.top }}
          onMouseDown={preventBlur}
        >
          <div className="ribbon-menu-heading">选择学术配色方案</div>
          {PALETTES.map((pal) => {
            const isSelected = pal.id === styleDoc.paletteId;
            return (
              <button
                key={`rb-pal-${pal.id}`}
                type="button"
                className={`rb-palette-opt${isSelected ? ' is-selected' : ''}`}
                onClick={() => {
                  setStylePalette(pal.id);
                  setOpenMenu(null);
                }}
              >
                <div className="rb-palette-menu-item">
                  <div className="rb-palette-menu-top">
                    <span className="btn-lead">
                      <span className="rb-palette-mini-strip" aria-hidden="true">
                        {pal.swatches.slice(0, 4).map((sw) => (
                          <span
                            key={sw.id}
                            className="rb-palette-mini-bar"
                            style={{
                              background: sw.fill,
                              borderColor: sw.stroke
                            }}
                          />
                        ))}
                      </span>
                      <span>{pal.name}</span>
                    </span>
                    {isSelected && (
                      <span className="ribbon-menu-check">
                        <UiIcon name="check" size={12} />
                        <span>当前</span>
                      </span>
                    )}
                  </div>
                  <span className="rb-palette-menu-desc">{pal.description}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
