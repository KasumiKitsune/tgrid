import { create } from 'zustand';
import type { AudioAnalysisSummary, TextGrid, TextGridFormat, TierKind } from '../bridge/types';
import { createSample } from '../data/samples';
import type { EditorSelection } from '../render/renderScoreSvg';
import type { ScoreLayout } from '../layout/computeLayout';

export type IpaInputMode = 'off' | 'yunlong' | 'praat';
export type SidebarTab = 'inspector' | 'tiers' | 'settings';
export type EditInspectorMode = 'sidebar' | 'floating';
export type ExportRangePreset = 'all' | 'view' | 'selection' | 'custom';

const SIDEBAR_PREFS_KEY = 'tgrid_sidebar_prefs_v1';

interface StoredSidebarPrefs {
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  sidebarWidth: number;
  editInspectorMode: EditInspectorMode;
  autoOpenInspectorOnSelect: boolean;
  showMicroLoupe: boolean;
}

const DEFAULT_SIDEBAR_PREFS: StoredSidebarPrefs = {
  sidebarOpen: false,
  sidebarTab: 'inspector',
  sidebarWidth: 300,
  editInspectorMode: 'sidebar',
  autoOpenInspectorOnSelect: true,
  showMicroLoupe: true
};

function clampSidebarWidth(w: number): number {
  return Math.max(240, Math.min(460, Math.round(Number.isFinite(w) ? w : 300)));
}

function loadSidebarPrefs(): StoredSidebarPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(SIDEBAR_PREFS_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      const tab: SidebarTab =
        raw.sidebarTab === 'inspector' || raw.sidebarTab === 'tiers' || raw.sidebarTab === 'settings'
          ? raw.sidebarTab
          : DEFAULT_SIDEBAR_PREFS.sidebarTab;
      // Map legacy 'both' preference cleanly to 'floating'
      const mode: EditInspectorMode =
        raw.editInspectorMode === 'sidebar'
          ? 'sidebar'
          : raw.editInspectorMode === 'floating' || raw.editInspectorMode === 'both'
            ? 'floating'
            : DEFAULT_SIDEBAR_PREFS.editInspectorMode;
      return {
        sidebarOpen: typeof raw.sidebarOpen === 'boolean' ? raw.sidebarOpen : DEFAULT_SIDEBAR_PREFS.sidebarOpen,
        sidebarTab: tab,
        sidebarWidth: clampSidebarWidth(raw.sidebarWidth),
        editInspectorMode: mode,
        autoOpenInspectorOnSelect:
          typeof raw.autoOpenInspectorOnSelect === 'boolean'
            ? raw.autoOpenInspectorOnSelect
            : DEFAULT_SIDEBAR_PREFS.autoOpenInspectorOnSelect,
        showMicroLoupe:
          typeof raw.showMicroLoupe === 'boolean'
            ? raw.showMicroLoupe
            : DEFAULT_SIDEBAR_PREFS.showMicroLoupe
      };
    }
  } catch {
    // ignore storage errors
  }
  return { ...DEFAULT_SIDEBAR_PREFS };
}

function saveSidebarPrefs(prefs: StoredSidebarPrefs): void {
  try {
    localStorage.setItem(SIDEBAR_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage errors
  }
}

function extractSidebarPrefs(
  s: Pick<
    EditorState,
    | 'sidebarOpen'
    | 'sidebarTab'
    | 'sidebarWidth'
    | 'editInspectorMode'
    | 'autoOpenInspectorOnSelect'
    | 'showMicroLoupe'
  >,
  overrides?: Partial<StoredSidebarPrefs>
): StoredSidebarPrefs {
  return {
    sidebarOpen: overrides?.sidebarOpen ?? s.sidebarOpen,
    sidebarTab: overrides?.sidebarTab ?? s.sidebarTab,
    sidebarWidth: overrides?.sidebarWidth ?? s.sidebarWidth,
    editInspectorMode: overrides?.editInspectorMode ?? s.editInspectorMode,
    autoOpenInspectorOnSelect:
      overrides?.autoOpenInspectorOnSelect ?? s.autoOpenInspectorOnSelect,
    showMicroLoupe: overrides?.showMicroLoupe ?? s.showMicroLoupe
  };
}

const initialSidebarPrefs = loadSidebarPrefs();

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastState {
  message: string;
  isError: boolean;
  visible: boolean;
  action?: ToastAction | null;
}

export interface UndoSnapshot {
  tg: TextGrid;
  selection: EditorSelection;
}

export interface TabRecord {
  id: string;
  tg: TextGrid;
  collectionTgs: TextGrid[];
  collectionActiveIdx: number;
  filename: string;
  currentFilePath: string | null;
  currentFileFormat: TextGridFormat;
  isDirty: boolean;
  cleanUndoDepth: number | null;
  undoStack: UndoSnapshot[];
  redoStack: UndoSnapshot[];
  viewDomain: { min: number; max: number } | null;
  selection: EditorSelection;
  playRange: { start: number; end: number } | null;
  currentTime: number;
  audioName: string;
  audioOffset: number;
  audioDuration: number;
  audioSampleRate: number;
  analysis: AudioAnalysisSummary | null;
  isBlankPlaceholder: boolean;
}

export interface CreateTabOptions {
  tg?: TextGrid;
  filename?: string;
  collectionTgs?: TextGrid[];
  activeIdx?: number;
  filePath?: string | null;
  fileFormat?: TextGridFormat;
  isBlankPlaceholder?: boolean;
  activate?: boolean;
}

export interface CloseTabResult {
  removedSessionId: number | null;
  removedTabId: string;
  nextActiveTabId: string;
}

export interface EditorState {
  // Multi-tab workspace state
  tabs: TabRecord[];
  activeTabId: string;

  // Active-tab mirrored top-level document fields (fast reactive selectors)
  tg: TextGrid;
  collectionTgs: TextGrid[];
  collectionActiveIdx: number;
  filename: string;
  currentFilePath: string | null;
  currentFileFormat: TextGridFormat;
  isDirty: boolean;
  cleanUndoDepth: number | null;
  mode: 'read' | 'edit';
  wrapMode: 'auto' | 'single';
  scaleMode: 'elastic' | 'linear';
  tickPrecision: '2' | '3' | '4' | 'full';
  viewDomain: { min: number; max: number } | null;
  targetWidth: number;
  selection: EditorSelection;
  playRange: { start: number; end: number } | null;
  currentTime: number;
  showPlayhead: boolean;
  playing: boolean;
  loop: boolean;
  rate: number;
  volume: number;
  legendOpen: boolean;

  // Audio & Acoustic (per-tab mirrored)
  audioName: string;
  audioOffset: number;
  audioDuration: number;
  audioSampleRate: number;
  analysis: AudioAnalysisSummary | null;
  showSpectrogram: boolean;
  cueMode: 'auto' | 'pitch' | 'formant' | 'plain';
  tierOrder: 'raw' | 'spec';
  maxFreq: 5000 | 8000 | 10000;

  // IPA System
  ipaMode: IpaInputMode;
  ipaDockOpen: boolean;
  ipaFloating: boolean;

  // Office-Style Right Sidebar & Edit Inspector Preferences
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  sidebarWidth: number;
  editInspectorMode: EditInspectorMode;
  autoOpenInspectorOnSelect: boolean;
  showMicroLoupe: boolean;

  // Modals & Layout ref
  exportOpen: boolean;
  exportPresetRange: ExportRangePreset | null;
  layout: ScoreLayout | null;
  undoStack: UndoSnapshot[];
  redoStack: UndoSnapshot[];
  toast: ToastState;
  docVersion: number;

  // Multi-tab actions
  createNewTab: (opts?: CreateTabOptions) => string;
  switchTab: (tabId: string) => void;
  closeTabImmediate: (tabId: string) => CloseTabResult;
  getDirtyTabs: () => TabRecord[];
  findTabByPath: (filePath: string) => TabRecord | null;
  markTabSaved: (
    tabId: string,
    meta?: { filePath?: string | null; filename?: string; fileFormat?: TextGridFormat }
  ) => void;
  setAudioMetaForTab: (
    tabId: string,
    meta: {
      name: string;
      offset: number;
      duration: number;
      sampleRate: number;
      analysis: AudioAnalysisSummary | null;
    }
  ) => void;

  // Active document actions
  setDocument: (
    tg: TextGrid,
    filename: string,
    collectionTgs?: TextGrid[],
    activeIdx?: number,
    meta?: { filePath?: string | null; fileFormat?: TextGridFormat; isBlankPlaceholder?: boolean }
  ) => void;
  markSaved: (meta?: { filePath?: string | null; filename?: string; fileFormat?: TextGridFormat }) => void;
  switchCollectionItem: (idx: number) => void;
  commitTgMutation: (mutator: (draft: TextGrid) => void, nextSelection?: EditorSelection) => void;
  undo: () => void;
  redo: () => void;
  setMode: (mode: 'read' | 'edit') => void;
  setWrapMode: (wrapMode: 'auto' | 'single') => void;
  setScaleMode: (scaleMode: 'elastic' | 'linear') => void;
  setTickPrecision: (prec: '2' | '3' | '4' | 'full') => void;
  setViewDomain: (domain: { min: number; max: number } | null) => void;
  setTargetWidth: (w: number) => void;
  setSelection: (sel: EditorSelection) => void;
  setPlayRange: (range: { start: number; end: number } | null) => void;
  setPlaybackTime: (t: number, showPlayhead: boolean) => void;
  setPlaying: (playing: boolean) => void;
  setLoop: (loop: boolean) => void;
  setRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  toggleLegend: () => void;
  setAudioMeta: (meta: {
    name: string;
    offset: number;
    duration: number;
    sampleRate: number;
    analysis: AudioAnalysisSummary | null;
  }) => void;
  setShowSpectrogram: (v: boolean) => void;
  setCueMode: (m: 'auto' | 'pitch' | 'formant' | 'plain') => void;
  setTierOrder: (o: 'raw' | 'spec') => void;
  setMaxFreq: (f: 5000 | 8000 | 10000) => void;
  setIpaMode: (m: IpaInputMode) => void;
  cycleIpaMode: () => void;
  setIpaDockOpen: (open: boolean) => void;
  setIpaFloating: (floating: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleSidebarTab: (tab: SidebarTab) => void;
  setSidebarWidth: (w: number) => void;
  setEditInspectorMode: (m: EditInspectorMode) => void;
  setAutoOpenInspectorOnSelect: (auto: boolean) => void;
  setShowMicroLoupe: (show: boolean) => void;
  setExportOpen: (open: boolean) => void;
  openExportModal: (presetRange?: ExportRangePreset | null) => void;
  clearExportPresetRange: () => void;
  setLayout: (layout: ScoreLayout | null) => void;
  showToast: (message: string, isError?: boolean, action?: ToastAction | null) => void;
  hideToast: () => void;
  bumpDocVersion: () => void;

  // Domain edit helpers
  splitInterval: (tierIndex: number, itemIndex: number, splitT?: number) => void;
  mergeIntervalWith: (tierIndex: number, itemIndex: number, dir: -1 | 1) => void;
  deleteBoundaryAt: (tierIndex: number, time: number) => void;
  addPointAt: (tierIndex: number, t: number) => number | null;
  insertTierAt: (index: number, kind: TierKind) => void;
  moveTier: (tierIndex: number, delta: -1 | 1) => void;
  deleteTier: (tierIndex: number) => void;
  normalizeTextGrid: () => void;
  moveTierBoundary: (tierIndex: number, oldT: number, newT: number, shared: boolean) => boolean;
  moveSharedTimestamp: (oldT: number, newT: number) => boolean;
}

function cloneTg(tg: TextGrid): TextGrid {
  return JSON.parse(JSON.stringify(tg)) as TextGrid;
}

function roundTimeClean(t: number): number {
  return Number(t.toFixed(6));
}

function normalizePathKey(p: string): string {
  return p.trim().replace(/\//g, '\\').toLowerCase();
}

let nextTabSeq = 1;
function generateTabId(): string {
  return `tab-${nextTabSeq++}`;
}

function createTabRecord(opts?: CreateTabOptions): TabRecord {
  const isDefaultBlank = !opts?.tg;
  const tg = opts?.tg ?? createSample('blank').tg;
  const filename = opts?.filename ?? tg.name ?? '未命名.TextGrid';
  return {
    id: generateTabId(),
    tg,
    collectionTgs: opts?.collectionTgs ?? [],
    collectionActiveIdx: opts?.activeIdx ?? 0,
    filename,
    currentFilePath: opts?.filePath ?? null,
    currentFileFormat: opts?.fileFormat ?? 'longText',
    isDirty: false,
    cleanUndoDepth: 0,
    undoStack: [],
    redoStack: [],
    viewDomain: null,
    selection: null,
    playRange: null,
    currentTime: Number.isFinite(tg.xmin) ? tg.xmin : 0,
    audioName: '',
    audioOffset: 0,
    audioDuration: 0,
    audioSampleRate: 0,
    analysis: null,
    isBlankPlaceholder: opts?.isBlankPlaceholder ?? isDefaultBlank
  };
}

function fieldsFromTab(tab: TabRecord) {
  return {
    activeTabId: tab.id,
    tg: tab.tg,
    collectionTgs: tab.collectionTgs,
    collectionActiveIdx: tab.collectionActiveIdx,
    filename: tab.filename,
    currentFilePath: tab.currentFilePath,
    currentFileFormat: tab.currentFileFormat,
    isDirty: tab.isDirty,
    cleanUndoDepth: tab.cleanUndoDepth,
    undoStack: tab.undoStack,
    redoStack: tab.redoStack,
    viewDomain: tab.viewDomain,
    selection: tab.selection,
    playRange: tab.playRange,
    currentTime: tab.currentTime,
    audioName: tab.audioName,
    audioOffset: tab.audioOffset,
    audioDuration: tab.audioDuration,
    audioSampleRate: tab.audioSampleRate,
    analysis: tab.analysis
  };
}

function syncActivePatch(s: EditorState, patch: Partial<TabRecord>) {
  return {
    ...patch,
    tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, ...patch } : t))
  };
}

export function getBoundaryBoundsForTier(tier: TextGrid['tiers'][number], oldT: number) {
  let minAllowed = -Infinity;
  let maxAllowed = Infinity;
  if (tier.kind === 'intervalTier') {
    for (const iv of tier.intervals) {
      if (iv.xmax === oldT) minAllowed = Math.max(minAllowed, iv.xmin + 1e-6);
      if (iv.xmin === oldT) maxAllowed = Math.min(maxAllowed, iv.xmax - 1e-6);
    }
  }
  return { minAllowed, maxAllowed };
}

function validateSelectionForTg(tg: TextGrid, sel: EditorSelection): EditorSelection {
  if (!sel) return null;
  if (sel.kind === 'interval') {
    const tier = tg.tiers[sel.tierIndex];
    if (!tier || tier.kind !== 'intervalTier' || !tier.intervals[sel.itemIndex]) return null;
    return { ...sel };
  }
  if (sel.kind === 'point') {
    const tier = tg.tiers[sel.tierIndex];
    if (!tier || tier.kind !== 'textTier' || !tier.points[sel.itemIndex]) return null;
    return { ...sel };
  }
  if (sel.kind === 'boundary') {
    const tier = tg.tiers[sel.tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return null;
    const exists = tier.intervals.some((iv) => iv.xmin === sel.time || iv.xmax === sel.time);
    return exists ? { ...sel } : null;
  }
  if (sel.kind === 'tier') {
    return tg.tiers[sel.tierIndex] ? { ...sel } : null;
  }
  if (sel.kind === 'spine') {
    return Number.isFinite(sel.time) ? { ...sel } : null;
  }
  return null;
}

function loadSavedVolume(): number {
  try {
    const raw = localStorage.getItem('tg_audio_volume');
    if (raw !== null) {
      const v = parseFloat(raw);
      if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
    }
  } catch {
    // ignore
  }
  return 0.9;
}

let toastTimeout: ReturnType<typeof setTimeout> | null = null;
const initialSample = createSample('poem');
const initialTab = createTabRecord({
  tg: initialSample.tg,
  filename: initialSample.tg.name,
  filePath: null,
  fileFormat: 'longText',
  isBlankPlaceholder: false
});

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [initialTab],
  ...fieldsFromTab(initialTab),

  mode: 'read',
  wrapMode: 'auto',
  scaleMode: 'elastic',
  tickPrecision: '3',
  targetWidth: 1120,
  showPlayhead: false,
  playing: false,
  loop: false,
  rate: 1.0,
  volume: loadSavedVolume(),
  legendOpen: false,

  showSpectrogram: true,
  cueMode: 'auto',
  tierOrder: 'raw',
  maxFreq: 5000,

  ipaMode: (() => {
    try {
      const m = localStorage.getItem('tg_ipa_mode');
      if (m === 'off' || m === 'yunlong' || m === 'praat') return m;
    } catch {
      // ignore
    }
    return 'off';
  })(),
  ipaDockOpen: false,
  ipaFloating: (() => {
    try {
      return localStorage.getItem('tg_ipa_dock_mode') === 'floating';
    } catch {
      return false;
    }
  })(),

  sidebarOpen: initialSidebarPrefs.sidebarOpen,
  sidebarTab: initialSidebarPrefs.sidebarTab,
  sidebarWidth: initialSidebarPrefs.sidebarWidth,
  editInspectorMode: initialSidebarPrefs.editInspectorMode,
  autoOpenInspectorOnSelect: initialSidebarPrefs.autoOpenInspectorOnSelect,
  showMicroLoupe: initialSidebarPrefs.showMicroLoupe,

  exportOpen: false,
  exportPresetRange: null,
  layout: null,
  toast: { message: '', isError: false, visible: false, action: null },
  docVersion: 1,

  createNewTab: (opts) => {
    const newTab = createTabRecord(opts);
    const shouldActivate = opts?.activate !== false;
    set((s) => {
      const updatedTabs = s.tabs.map((t) =>
        t.id === s.activeTabId ? { ...t, currentTime: s.currentTime } : t
      );
      const nextTabs = [...updatedTabs, newTab];
      if (!shouldActivate) {
        return { tabs: nextTabs };
      }
      return {
        tabs: nextTabs,
        ...fieldsFromTab(newTab),
        showPlayhead: false,
        playing: false,
        docVersion: s.docVersion + 1
      };
    });
    return newTab.id;
  },

  switchTab: (tabId) =>
    set((s) => {
      if (tabId === s.activeTabId) return s;
      const target = s.tabs.find((t) => t.id === tabId);
      if (!target) return s;
      const updatedTabs = s.tabs.map((t) =>
        t.id === s.activeTabId ? { ...t, currentTime: s.currentTime } : t
      );
      return {
        tabs: updatedTabs,
        ...fieldsFromTab(target),
        showPlayhead: false,
        playing: false,
        docVersion: s.docVersion + 1
      };
    }),

  closeTabImmediate: (tabId) => {
    const cur = get();
    const idx = cur.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) {
      return { removedSessionId: null, removedTabId: tabId, nextActiveTabId: cur.activeTabId };
    }
    const target = cur.tabs[idx];
    const removedSessionId = target.analysis?.sessionId ?? null;
    const remaining = cur.tabs.filter((t) => t.id !== tabId);

    if (remaining.length === 0) {
      const fresh = createTabRecord({ isBlankPlaceholder: true });
      set((s) => ({
        tabs: [fresh],
        ...fieldsFromTab(fresh),
        showPlayhead: false,
        playing: false,
        docVersion: s.docVersion + 1
      }));
      return { removedSessionId, removedTabId: tabId, nextActiveTabId: fresh.id };
    }

    if (tabId === cur.activeTabId) {
      const nextActive = remaining[Math.min(idx, remaining.length - 1)];
      set((s) => ({
        tabs: remaining,
        ...fieldsFromTab(nextActive),
        showPlayhead: false,
        playing: false,
        docVersion: s.docVersion + 1
      }));
      return { removedSessionId, removedTabId: tabId, nextActiveTabId: nextActive.id };
    }

    set({ tabs: remaining });
    return { removedSessionId, removedTabId: tabId, nextActiveTabId: cur.activeTabId };
  },

  getDirtyTabs: () => get().tabs.filter((t) => t.isDirty),

  findTabByPath: (filePath) => {
    if (!filePath) return null;
    const key = normalizePathKey(filePath);
    return get().tabs.find((t) => t.currentFilePath && normalizePathKey(t.currentFilePath) === key) ?? null;
  },

  markTabSaved: (tabId, meta) =>
    set((s) => {
      const target = s.tabs.find((t) => t.id === tabId);
      if (!target) return s;
      const patch: Partial<TabRecord> = {
        isDirty: false,
        cleanUndoDepth: target.undoStack.length,
        isBlankPlaceholder: false,
        ...(meta?.filePath !== undefined ? { currentFilePath: meta.filePath } : {}),
        ...(meta?.filename !== undefined ? { filename: meta.filename } : {}),
        ...(meta?.fileFormat !== undefined ? { currentFileFormat: meta.fileFormat } : {})
      };
      const nextTabs = s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t));
      if (tabId === s.activeTabId) {
        return {
          tabs: nextTabs,
          isDirty: false,
          cleanUndoDepth: patch.cleanUndoDepth!,
          ...(meta?.filePath !== undefined ? { currentFilePath: meta.filePath } : {}),
          ...(meta?.filename !== undefined ? { filename: meta.filename } : {}),
          ...(meta?.fileFormat !== undefined ? { currentFileFormat: meta.fileFormat } : {})
        };
      }
      return { tabs: nextTabs };
    }),

  setAudioMetaForTab: (tabId, meta) =>
    set((s) => {
      const target = s.tabs.find((t) => t.id === tabId);
      if (!target) return s;
      const patch: Partial<TabRecord> = {
        audioName: meta.name,
        audioOffset: meta.offset,
        audioDuration: meta.duration,
        audioSampleRate: meta.sampleRate,
        analysis: meta.analysis,
        ...(meta.name ? { isBlankPlaceholder: false } : {})
      };
      const nextTabs = s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t));
      if (tabId === s.activeTabId) {
        return {
          tabs: nextTabs,
          audioName: meta.name,
          audioOffset: meta.offset,
          audioDuration: meta.duration,
          audioSampleRate: meta.sampleRate,
          analysis: meta.analysis
        };
      }
      return { tabs: nextTabs };
    }),

  setDocument: (tg, filename, collectionTgs = [], activeIdx = 0, meta) =>
    set((s) => {
      const patch: Partial<TabRecord> = {
        tg,
        filename,
        currentFilePath: meta?.filePath ?? null,
        currentFileFormat: meta?.fileFormat ?? 'longText',
        isDirty: false,
        cleanUndoDepth: 0,
        collectionTgs,
        collectionActiveIdx: activeIdx,
        viewDomain: null,
        selection: null,
        playRange: null,
        currentTime: Number.isFinite(tg.xmin) ? tg.xmin : 0,
        undoStack: [],
        redoStack: [],
        isBlankPlaceholder: meta?.isBlankPlaceholder ?? false
      };
      return {
        ...syncActivePatch(s, patch),
        showPlayhead: false,
        docVersion: s.docVersion + 1
      };
    }),

  markSaved: (meta) => {
    const activeId = get().activeTabId;
    get().markTabSaved(activeId, meta);
  },

  switchCollectionItem: (idx) =>
    set((s) => {
      if (idx < 0 || idx >= s.collectionTgs.length) return s;
      const nextCollection = [...s.collectionTgs];
      if (s.collectionActiveIdx >= 0 && s.collectionActiveIdx < nextCollection.length) {
        nextCollection[s.collectionActiveIdx] = s.tg;
      }
      const nextTg = nextCollection[idx];
      const patch: Partial<TabRecord> = {
        collectionTgs: nextCollection,
        collectionActiveIdx: idx,
        tg: nextTg,
        filename: nextTg.name || s.filename,
        viewDomain: null,
        selection: null,
        playRange: null,
        undoStack: [],
        redoStack: [],
        cleanUndoDepth: s.isDirty ? null : 0
      };
      return {
        ...syncActivePatch(s, patch),
        docVersion: s.docVersion + 1
      };
    }),

  commitTgMutation: (mutator, nextSelection) =>
    set((s) => {
      const prevSnapshot: UndoSnapshot = {
        tg: cloneTg(s.tg),
        selection: s.selection ? { ...s.selection } : null
      };
      const draft = cloneTg(s.tg);
      mutator(draft);
      const undoStack = [...s.undoStack, prevSnapshot];
      let nextCleanDepth =
        s.cleanUndoDepth !== null && s.undoStack.length < s.cleanUndoDepth ? null : s.cleanUndoDepth;
      if (undoStack.length > 80) {
        undoStack.shift();
        if (nextCleanDepth !== null) {
          nextCleanDepth = nextCleanDepth > 0 ? nextCleanDepth - 1 : null;
        }
      }
      const nextCollection =
        s.collectionTgs.length > 0
          ? s.collectionTgs.map((item, i) => (i === s.collectionActiveIdx ? draft : item))
          : s.collectionTgs;
      const patch: Partial<TabRecord> = {
        tg: draft,
        collectionTgs: nextCollection,
        undoStack,
        redoStack: [],
        isDirty: true,
        cleanUndoDepth: nextCleanDepth,
        selection: nextSelection !== undefined ? nextSelection : s.selection,
        isBlankPlaceholder: false
      };
      return {
        ...syncActivePatch(s, patch),
        docVersion: s.docVersion + 1
      };
    }),

  undo: () =>
    set((s) => {
      if (s.undoStack.length === 0) return s;
      const prev = s.undoStack[s.undoStack.length - 1];
      const undoStack = s.undoStack.slice(0, -1);
      const redoStack = [
        ...s.redoStack,
        { tg: cloneTg(s.tg), selection: s.selection ? { ...s.selection } : null }
      ];
      const nextCollection =
        s.collectionTgs.length > 0
          ? s.collectionTgs.map((item, i) => (i === s.collectionActiveIdx ? prev.tg : item))
          : s.collectionTgs;
      const viewDomain =
        s.viewDomain && (s.viewDomain.max <= prev.tg.xmin || s.viewDomain.min >= prev.tg.xmax)
          ? null
          : s.viewDomain;
      const patch: Partial<TabRecord> = {
        tg: prev.tg,
        collectionTgs: nextCollection,
        undoStack,
        redoStack,
        isDirty: s.cleanUndoDepth === null || undoStack.length !== s.cleanUndoDepth,
        viewDomain,
        selection: validateSelectionForTg(prev.tg, prev.selection)
      };
      return {
        ...syncActivePatch(s, patch),
        docVersion: s.docVersion + 1
      };
    }),

  redo: () =>
    set((s) => {
      if (s.redoStack.length === 0) return s;
      const next = s.redoStack[s.redoStack.length - 1];
      const redoStack = s.redoStack.slice(0, -1);
      const undoStack = [
        ...s.undoStack,
        { tg: cloneTg(s.tg), selection: s.selection ? { ...s.selection } : null }
      ];
      const nextCollection =
        s.collectionTgs.length > 0
          ? s.collectionTgs.map((item, i) => (i === s.collectionActiveIdx ? next.tg : item))
          : s.collectionTgs;
      const viewDomain =
        s.viewDomain && (s.viewDomain.max <= next.tg.xmin || s.viewDomain.min >= next.tg.xmax)
          ? null
          : s.viewDomain;
      const patch: Partial<TabRecord> = {
        tg: next.tg,
        collectionTgs: nextCollection,
        undoStack,
        redoStack,
        isDirty: s.cleanUndoDepth === null || undoStack.length !== s.cleanUndoDepth,
        viewDomain,
        selection: validateSelectionForTg(next.tg, next.selection)
      };
      return {
        ...syncActivePatch(s, patch),
        docVersion: s.docVersion + 1
      };
    }),

  setMode: (mode) => set({ mode, ...(mode === 'read' ? { ipaDockOpen: false } : {}) }),
  setWrapMode: (wrapMode) =>
    set((s) => ({
      wrapMode,
      ...(wrapMode === 'auto' && s.targetWidth > 2400 ? { targetWidth: 2400 } : {})
    })),
  setScaleMode: (scaleMode) => set({ scaleMode }),
  setTickPrecision: (tickPrecision) => set({ tickPrecision }),
  setViewDomain: (viewDomain) => set((s) => syncActivePatch(s, { viewDomain })),
  setTargetWidth: (w) => set({ targetWidth: Math.max(280, Math.min(18000, Math.round(w))) }),
  setSelection: (selection) => set((s) => syncActivePatch(s, { selection })),
  setPlayRange: (playRange) => set((s) => syncActivePatch(s, { playRange })),
  setPlaybackTime: (currentTime, showPlayhead) => set({ currentTime, showPlayhead }),
  setPlaying: (playing) => set({ playing }),
  setLoop: (loop) => set({ loop }),
  setRate: (rate) => set({ rate }),
  setVolume: (volume) => {
    const clamped = Math.max(0, Math.min(1, volume));
    try {
      localStorage.setItem('tg_audio_volume', String(clamped));
    } catch {
      // ignore
    }
    set({ volume: clamped });
  },
  toggleLegend: () => set((s) => ({ legendOpen: !s.legendOpen })),
  setAudioMeta: (meta) => {
    const activeId = get().activeTabId;
    get().setAudioMetaForTab(activeId, meta);
  },
  setShowSpectrogram: (showSpectrogram) => set({ showSpectrogram }),
  setCueMode: (cueMode) => set({ cueMode }),
  setTierOrder: (tierOrder) => set({ tierOrder }),
  setMaxFreq: (maxFreq) => set({ maxFreq }),
  setIpaMode: (ipaMode) => {
    try {
      localStorage.setItem('tg_ipa_mode', ipaMode);
    } catch {
      // ignore
    }
    set({ ipaMode });
  },
  cycleIpaMode: () => {
    const order: IpaInputMode[] = ['off', 'yunlong', 'praat'];
    const cur = get().ipaMode;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    get().setIpaMode(next);
    const labels: Record<IpaInputMode, string> = {
      off: '已关闭',
      yunlong: '云龙国际音标',
      praat: 'Praat \\xx'
    };
    get().showToast(`音标输入：${labels[next]}`);
  },
  setIpaDockOpen: (ipaDockOpen) => set({ ipaDockOpen }),
  setIpaFloating: (ipaFloating) => {
    try {
      localStorage.setItem('tg_ipa_dock_mode', ipaFloating ? 'floating' : 'docked');
    } catch {
      // ignore
    }
    set({ ipaFloating });
  },
  setSidebarOpen: (sidebarOpen) =>
    set((s) => {
      saveSidebarPrefs(extractSidebarPrefs(s, { sidebarOpen }));
      return { sidebarOpen };
    }),
  setSidebarTab: (sidebarTab) =>
    set((s) => {
      saveSidebarPrefs(extractSidebarPrefs(s, { sidebarTab }));
      return { sidebarTab };
    }),
  toggleSidebarTab: (tab) =>
    set((s) => {
      const nextOpen = s.sidebarOpen && s.sidebarTab === tab ? false : true;
      const nextTab = tab;
      saveSidebarPrefs(extractSidebarPrefs(s, { sidebarOpen: nextOpen, sidebarTab: nextTab }));
      return { sidebarOpen: nextOpen, sidebarTab: nextTab };
    }),
  setSidebarWidth: (w) =>
    set((s) => {
      const sidebarWidth = clampSidebarWidth(w);
      saveSidebarPrefs(extractSidebarPrefs(s, { sidebarWidth }));
      return { sidebarWidth };
    }),
  setEditInspectorMode: (editInspectorMode) =>
    set((s) => {
      saveSidebarPrefs(extractSidebarPrefs(s, { editInspectorMode }));
      return { editInspectorMode };
    }),
  setAutoOpenInspectorOnSelect: (autoOpenInspectorOnSelect) =>
    set((s) => {
      saveSidebarPrefs(extractSidebarPrefs(s, { autoOpenInspectorOnSelect }));
      return { autoOpenInspectorOnSelect };
    }),
  setShowMicroLoupe: (showMicroLoupe) =>
    set((s) => {
      saveSidebarPrefs(extractSidebarPrefs(s, { showMicroLoupe }));
      return { showMicroLoupe };
    }),
  setExportOpen: (exportOpen) => set({ exportOpen, ...(exportOpen ? {} : { exportPresetRange: null }) }),
  openExportModal: (presetRange = null) => set({ exportOpen: true, exportPresetRange: presetRange }),
  clearExportPresetRange: () => set({ exportPresetRange: null }),
  setLayout: (layout) => set({ layout }),
  bumpDocVersion: () => set((s) => ({ docVersion: s.docVersion + 1 })),

  showToast: (message, isError = false, action = null) => {
    set({ toast: { message, isError, visible: true, action } });
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      set((s) => ({ toast: { ...s.toast, visible: false } }));
    }, action ? 4800 : 2400);
  },

  hideToast: () => {
    if (toastTimeout) clearTimeout(toastTimeout);
    set((s) => ({ toast: { ...s.toast, visible: false } }));
  },

  splitInterval: (tierIndex, itemIndex, splitT) => {
    const st = get();
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return;
    const iv = tier.intervals[itemIndex];
    if (!iv) return;
    const t =
      splitT !== undefined && Number.isFinite(splitT)
        ? roundTimeClean(splitT)
        : roundTimeClean((iv.xmin + iv.xmax) / 2);
    if (t <= iv.xmin || t >= iv.xmax) {
      st.showToast('切分时间必须位于区间起止之间', true);
      return;
    }
    st.commitTgMutation(
      (draft) => {
        const dTier = draft.tiers[tierIndex];
        const dIv = dTier.intervals[itemIndex];
        const right = { xmin: t, xmax: dIv.xmax, text: '' };
        dIv.xmax = t;
        dTier.intervals.splice(itemIndex + 1, 0, right);
      },
      { kind: 'interval', tierIndex, itemIndex: itemIndex + 1 }
    );
  },

  mergeIntervalWith: (tierIndex, itemIndex, dir) => {
    const st = get();
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return;
    const targetIdx = itemIndex + dir;
    if (targetIdx < 0 || targetIdx >= tier.intervals.length) return;
    const aIdx = Math.min(itemIndex, targetIdx);
    const bIdx = Math.max(itemIndex, targetIdx);
    st.commitTgMutation(
      (draft) => {
        const dTier = draft.tiers[tierIndex];
        const a = dTier.intervals[aIdx];
        const b = dTier.intervals[bIdx];
        a.xmax = b.xmax;
        a.text = a.text && b.text ? `${a.text} ${b.text}` : a.text || b.text;
        dTier.intervals.splice(bIdx, 1);
      },
      { kind: 'interval', tierIndex, itemIndex: aIdx }
    );
  },

  deleteBoundaryAt: (tierIndex, time) => {
    const st = get();
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return;
    const leftIdx = tier.intervals.findIndex((iv) => iv.xmax === time);
    const rightIdx = tier.intervals.findIndex((iv) => iv.xmin === time);
    if (leftIdx !== -1 && rightIdx !== -1 && leftIdx !== rightIdx) {
      st.mergeIntervalWith(tierIndex, leftIdx, 1);
    }
  },

  addPointAt: (tierIndex, t) => {
    const st = get();
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'textTier') return null;
    const cleanT = roundTimeClean(Math.min(tier.xmax, Math.max(tier.xmin, t)));
    if (tier.points.some((p) => p.number === cleanT)) {
      st.showToast('该时间点已存在标点');
      return null;
    }
    let insertedIdx = 0;
    st.commitTgMutation((draft) => {
      const dTier = draft.tiers[tierIndex];
      const pt = { number: cleanT, mark: '' };
      dTier.points.push(pt);
      dTier.points.sort((a, b) => a.number - b.number);
      insertedIdx = dTier.points.indexOf(pt);
    });
    get().setSelection({ kind: 'point', tierIndex, itemIndex: insertedIdx });
    return insertedIdx;
  },

  insertTierAt: (index, kind) => {
    const st = get();
    st.commitTgMutation(
      (draft) => {
        const n = draft.tiers.length + 1;
        draft.tiers.splice(
          index,
          0,
          kind === 'intervalTier'
            ? {
                kind: 'intervalTier',
                name: `区间层 ${n}`,
                xmin: draft.xmin,
                xmax: draft.xmax,
                intervals: [{ xmin: draft.xmin, xmax: draft.xmax, text: '' }],
                points: []
              }
            : {
                kind: 'textTier',
                name: `点层 ${n}`,
                xmin: draft.xmin,
                xmax: draft.xmax,
                intervals: [],
                points: []
              }
        );
      },
      { kind: 'tier', tierIndex: index }
    );
  },

  moveTier: (tierIndex, delta) => {
    const st = get();
    const target = tierIndex + delta;
    if (target < 0 || target >= st.tg.tiers.length) return;
    if (st.analysis && st.showSpectrogram && st.tierOrder === 'spec') {
      set({ tierOrder: 'raw' });
    }
    st.commitTgMutation(
      (draft) => {
        const tmp = draft.tiers[target];
        draft.tiers[target] = draft.tiers[tierIndex];
        draft.tiers[tierIndex] = tmp;
      },
      { kind: 'tier', tierIndex: target }
    );
  },

  deleteTier: (tierIndex) => {
    const st = get();
    st.commitTgMutation((draft) => {
      draft.tiers.splice(tierIndex, 1);
    }, null);
  },

  normalizeTextGrid: () => {
    const st = get();
    st.commitTgMutation((draft) => {
      const gMin = draft.xmin;
      const gMax = draft.xmax;
      for (const tier of draft.tiers) {
        tier.xmin = gMin;
        tier.xmax = gMax;
        if (tier.kind === 'intervalTier') {
          tier.intervals.sort((a, b) => a.xmin - b.xmin || a.xmax - b.xmax);
          const clean = [];
          let cursor = gMin;
          for (const iv of tier.intervals) {
            const a = Math.max(cursor, Math.min(gMax, iv.xmin));
            const b = Math.max(a, Math.min(gMax, iv.xmax));
            if (a > cursor) clean.push({ xmin: cursor, xmax: a, text: '' });
            if (b > a) {
              clean.push({ xmin: a, xmax: b, text: iv.text });
              cursor = b;
            }
          }
          if (cursor < gMax || clean.length === 0) clean.push({ xmin: cursor, xmax: gMax, text: '' });
          tier.intervals = clean;
        } else {
          tier.points = tier.points
            .filter((p) => Number.isFinite(p.number) && p.number >= gMin && p.number <= gMax)
            .sort((a, b) => a.number - b.number);
        }
      }
    }, null);
    st.showToast('已对齐各层范围并补齐连续区间');
  },

  moveTierBoundary: (tierIndex, oldT, newT, shared) => {
    const st = get();
    if (shared) return st.moveSharedTimestamp(oldT, newT);
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return false;
    const { minAllowed, maxAllowed } = getBoundaryBoundsForTier(tier, oldT);
    if (newT <= minAllowed - 1e-9 || newT >= maxAllowed + 1e-9) {
      st.showToast('边界不能越过相邻区间', true);
      return false;
    }
    st.commitTgMutation((draft) => {
      for (const iv of draft.tiers[tierIndex].intervals) {
        if (iv.xmax === oldT) iv.xmax = newT;
        if (iv.xmin === oldT) iv.xmin = newT;
      }
    });
    return true;
  },

  moveSharedTimestamp: (oldT, newT) => {
    const st = get();
    let minAllowed = -Infinity;
    let maxAllowed = Infinity;
    for (const tier of st.tg.tiers) {
      if (tier.kind === 'intervalTier') {
        const b = getBoundaryBoundsForTier(tier, oldT);
        minAllowed = Math.max(minAllowed, b.minAllowed);
        maxAllowed = Math.min(maxAllowed, b.maxAllowed);
      }
    }
    if (newT <= minAllowed - 1e-9 || newT >= maxAllowed + 1e-9) {
      st.showToast('移动超出相邻边界允许范围', true);
      return false;
    }
    st.commitTgMutation((draft) => {
      if (draft.xmin === oldT && newT <= draft.xmax) draft.xmin = newT;
      if (draft.xmax === oldT && newT >= draft.xmin) draft.xmax = newT;
      for (const tier of draft.tiers) {
        if (tier.xmin === oldT && newT <= tier.xmax) tier.xmin = newT;
        if (tier.xmax === oldT && newT >= tier.xmin) tier.xmax = newT;
        if (tier.kind === 'intervalTier') {
          for (const iv of tier.intervals) {
            if (iv.xmax === oldT) iv.xmax = newT;
            if (iv.xmin === oldT) iv.xmin = newT;
          }
        } else {
          for (const pt of tier.points) if (pt.number === oldT) pt.number = newT;
          tier.points.sort((a, b) => a.number - b.number);
        }
      }
    });
    return true;
  }
}));
