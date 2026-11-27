import { create } from 'zustand';
import type { AudioAnalysisSummary, TextGrid, TextGridFormat, TierKind } from '../bridge/types';
import { createSample } from '../data/samples';
import type { EditorSelection } from '../render/renderScoreSvg';
import type { ScoreLayout } from '../layout/computeLayout';
import { getShortcutEntry, normalizeKeyCombo } from '../shortcuts/registry';
import {
  canRedoTimeline,
  canUndoTimeline,
  clampHistoryLimit,
  clearTimelineToCurrent,
  cloneTier,
  commitToTimeline,
  createHistoryTimeline,
  formatDeltaTime,
  formatDocBaselineDetail,
  formatDurationLabel,
  formatQuote,
  formatTierLabel,
  formatTimeSec,
  formatTimeSpan,
  getCurrentEntryId,
  getCurrentSnapshot,
  getLatestRedoEntry,
  getLatestUndoEntry,
  isTimelineDirty,
  loadSavedHistoryLimit,
  markTimelineSaved,
  produceTgMutation,
  saveHistoryLimit,
  sealTimelineCoalesce,
  setTimelineCursor,
  setTimelineMaxEntries,
  type BaselineKind,
  type HistoryActionMeta,
  type HistoryTimeline,
  type MutationContext
} from './historyModel';
import {
  clampCustomF0Range,
  loadF0RangePrefs,
  saveF0RangePrefs,
  type F0RangeMode
} from '../utils/f0Range';
import {
  clampCanvasScale,
  clampUiScale,
  loadSavedCanvasScale,
  loadSavedUiScale,
  saveCanvasScale,
  saveUiScale
} from '../utils/uiScale';
import type {
  CorpusFilterState,
  CorpusItemRecord,
  CorpusOptions,
  CorpusProjectState
} from '../corpus/types';

export type IpaInputMode = 'off' | 'yunlong' | 'praat';
export type SidebarTab = 'inspector' | 'tiers' | 'history' | 'settings' | 'customize';
export type PreferencesSection = 'editing' | 'general' | 'floating' | 'shortcuts';
export type EditInspectorMode = 'sidebar' | 'floating';
export type ExportRangePreset = 'all' | 'view' | 'selection' | 'custom';
export type RibbonTabId = 'file' | 'annotate' | 'tiers' | 'view' | 'tools' | 'corpus';

export type FloatingBarTarget = 'interval' | 'point' | 'boundary' | 'tier';
export type FloatingBarPresetKey = 'full' | 'compact' | 'minimal';

export interface FloatingBarItemMeta {
  id: string;
  label: string;
  previewLabel: string;
  defaultVisible: boolean;
}

export interface FloatingBarSectionConfig {
  order: string[];
  hidden: string[];
}

export type FloatingBarConfig = Record<FloatingBarTarget, FloatingBarSectionConfig>;

const FLOATING_BAR_TARGETS: FloatingBarTarget[] = ['interval', 'point', 'boundary', 'tier'];

export const FLOATING_BAR_CATALOG: Record<FloatingBarTarget, FloatingBarItemMeta[]> = {
  interval: [
    { id: 'iv-times', label: '起止时间框（可拖拽调值）', previewLabel: '起 / 止', defaultVisible: true },
    { id: 'iv-dur', label: '区间时长 (ms)', previewLabel: '240 ms', defaultVisible: true },
    { id: 'iv-edit', label: '改字', previewLabel: '改字', defaultVisible: true },
    { id: 'iv-clear', label: '清空文本', previewLabel: '清空', defaultVisible: true },
    { id: 'iv-split', label: '正中切分', previewLabel: '切分', defaultVisible: true },
    { id: 'iv-split-equal', label: '等分为 2 段', previewLabel: '等分', defaultVisible: false },
    { id: 'iv-merge-left', label: '向左合并', previewLabel: '合左', defaultVisible: true },
    { id: 'iv-merge-right', label: '向右合并', previewLabel: '合右', defaultVisible: true },
    { id: 'iv-play', label: '播放区间', previewLabel: '播放', defaultVisible: true },
    { id: 'iv-play-ctx', label: '语境播放 (±250ms)', previewLabel: '±250ms', defaultVisible: false },
    { id: 'iv-zoom', label: '放大 / 全长', previewLabel: '放大', defaultVisible: true },
    { id: 'iv-copy-text', label: '复制文本', previewLabel: '复制', defaultVisible: false }
  ],
  point: [
    { id: 'pt-time', label: '标点时间框（可拖拽调值）', previewLabel: '时间', defaultVisible: true },
    { id: 'pt-edit', label: '改字', previewLabel: '改字', defaultVisible: true },
    { id: 'pt-play-ctx', label: '语境播放 (±250ms)', previewLabel: '±250ms', defaultVisible: true },
    { id: 'pt-play', label: '从此处播放', previewLabel: '播放', defaultVisible: true },
    { id: 'pt-delete', label: '删除标点', previewLabel: '删除', defaultVisible: true }
  ],
  boundary: [
    { id: 'bnd-time', label: '边界时间框（可拖拽调值）', previewLabel: '边界', defaultVisible: true },
    { id: 'bnd-zero', label: '吸附过零点', previewLabel: '过零', defaultVisible: false },
    { id: 'bnd-audition', label: '试听 ±200ms', previewLabel: '试听', defaultVisible: true },
    { id: 'bnd-delete', label: '删除边界', previewLabel: '删除边界', defaultVisible: true }
  ],
  tier: [
    { id: 'tier-name', label: '层名称框', previewLabel: '层名', defaultVisible: true },
    { id: 'tier-bounds', label: '层起止时间框', previewLabel: '起 / 止', defaultVisible: true },
    { id: 'tier-move', label: '上移 / 下移', previewLabel: '上/下移', defaultVisible: true },
    { id: 'tier-delete', label: '删除层级', previewLabel: '删除', defaultVisible: true }
  ]
};

function buildFloatingBarSectionFromVisible(
  target: FloatingBarTarget,
  visibleIds: readonly string[]
): FloatingBarSectionConfig {
  const visibleSet = new Set(visibleIds);
  const catalog = FLOATING_BAR_CATALOG[target];
  return {
    order: catalog.map((item) => item.id),
    hidden: catalog.filter((item) => !visibleSet.has(item.id)).map((item) => item.id)
  };
}

export const DEFAULT_FLOATING_BAR_CONFIG: FloatingBarConfig = {
  interval: {
    order: FLOATING_BAR_CATALOG.interval.map((item) => item.id),
    hidden: FLOATING_BAR_CATALOG.interval.filter((item) => !item.defaultVisible).map((item) => item.id)
  },
  point: {
    order: FLOATING_BAR_CATALOG.point.map((item) => item.id),
    hidden: FLOATING_BAR_CATALOG.point.filter((item) => !item.defaultVisible).map((item) => item.id)
  },
  boundary: {
    order: FLOATING_BAR_CATALOG.boundary.map((item) => item.id),
    hidden: FLOATING_BAR_CATALOG.boundary.filter((item) => !item.defaultVisible).map((item) => item.id)
  },
  tier: {
    order: FLOATING_BAR_CATALOG.tier.map((item) => item.id),
    hidden: FLOATING_BAR_CATALOG.tier.filter((item) => !item.defaultVisible).map((item) => item.id)
  }
};

export const FLOATING_BAR_PRESETS: Record<FloatingBarPresetKey, FloatingBarConfig> = {
  full: {
    interval: buildFloatingBarSectionFromVisible('interval', [
      'iv-times',
      'iv-dur',
      'iv-edit',
      'iv-clear',
      'iv-split',
      'iv-merge-left',
      'iv-merge-right',
      'iv-play',
      'iv-zoom'
    ]),
    point: buildFloatingBarSectionFromVisible('point', [
      'pt-time',
      'pt-edit',
      'pt-play-ctx',
      'pt-play',
      'pt-delete'
    ]),
    boundary: buildFloatingBarSectionFromVisible('boundary', [
      'bnd-time',
      'bnd-zero',
      'bnd-audition',
      'bnd-delete'
    ]),
    tier: buildFloatingBarSectionFromVisible('tier', [
      'tier-name',
      'tier-bounds',
      'tier-move',
      'tier-delete'
    ])
  },
  compact: {
    interval: buildFloatingBarSectionFromVisible('interval', [
      'iv-dur',
      'iv-edit',
      'iv-clear',
      'iv-split',
      'iv-merge-left',
      'iv-merge-right',
      'iv-play',
      'iv-zoom'
    ]),
    point: buildFloatingBarSectionFromVisible('point', ['pt-edit', 'pt-play-ctx', 'pt-play', 'pt-delete']),
    boundary: buildFloatingBarSectionFromVisible('boundary', ['bnd-audition', 'bnd-delete']),
    tier: buildFloatingBarSectionFromVisible('tier', ['tier-name', 'tier-move', 'tier-delete'])
  },
  minimal: {
    interval: buildFloatingBarSectionFromVisible('interval', ['iv-edit', 'iv-split', 'iv-play']),
    point: buildFloatingBarSectionFromVisible('point', ['pt-edit', 'pt-play-ctx', 'pt-play']),
    boundary: buildFloatingBarSectionFromVisible('boundary', ['bnd-audition', 'bnd-delete']),
    tier: buildFloatingBarSectionFromVisible('tier', ['tier-name', 'tier-delete'])
  }
};

const FLOATING_BAR_STORAGE_KEY = 'tg_floating_bar_config';
const CUSTOM_SHORTCUTS_STORAGE_KEY = 'tg_custom_shortcuts';

function cloneFloatingBarConfig(cfg: FloatingBarConfig): FloatingBarConfig {
  return {
    interval: { order: [...cfg.interval.order], hidden: [...cfg.interval.hidden] },
    point: { order: [...cfg.point.order], hidden: [...cfg.point.hidden] },
    boundary: { order: [...cfg.boundary.order], hidden: [...cfg.boundary.hidden] },
    tier: { order: [...cfg.tier.order], hidden: [...cfg.tier.hidden] }
  };
}

function sanitizeFloatingBarConfig(raw: unknown): FloatingBarConfig {
  const result = cloneFloatingBarConfig(DEFAULT_FLOATING_BAR_CONFIG);
  if (!raw || typeof raw !== 'object') return result;
  const obj = raw as Record<string, unknown>;

  for (const target of FLOATING_BAR_TARGETS) {
    const catalog = FLOATING_BAR_CATALOG[target];
    const validIds = new Set(catalog.map((item) => item.id));
    const secRaw = obj[target];
    if (!secRaw || typeof secRaw !== 'object') continue;
    const sec = secRaw as { order?: unknown; hidden?: unknown };

    const seenOrder = new Set<string>();
    const order: string[] = [];
    if (Array.isArray(sec.order)) {
      for (const id of sec.order) {
        if (typeof id === 'string' && validIds.has(id) && !seenOrder.has(id)) {
          seenOrder.add(id);
          order.push(id);
        }
      }
    }
    const newlyAddedIds = new Set<string>();
    for (const item of catalog) {
      if (!seenOrder.has(item.id)) {
        seenOrder.add(item.id);
        order.push(item.id);
        newlyAddedIds.add(item.id);
      }
    }

    const hiddenSet = new Set<string>();
    if (Array.isArray(sec.hidden)) {
      for (const id of sec.hidden) {
        if (typeof id === 'string' && validIds.has(id)) {
          hiddenSet.add(id);
        }
      }
    }
    // For newly introduced catalog items not yet stored in user's config, honor defaultVisible
    for (const item of catalog) {
      if (newlyAddedIds.has(item.id) && !item.defaultVisible) {
        hiddenSet.add(item.id);
      }
    }

    result[target] = {
      order,
      hidden: order.filter((id) => hiddenSet.has(id))
    };
  }

  return result;
}

function loadFloatingBarConfig(): FloatingBarConfig {
  try {
    const raw = JSON.parse(localStorage.getItem(FLOATING_BAR_STORAGE_KEY) || 'null');
    return sanitizeFloatingBarConfig(raw);
  } catch {
    return cloneFloatingBarConfig(DEFAULT_FLOATING_BAR_CONFIG);
  }
}

function saveFloatingBarConfig(cfg: FloatingBarConfig): void {
  try {
    localStorage.setItem(FLOATING_BAR_STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // ignore storage errors
  }
}

function areKeyListsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sanitizeCustomShortcuts(raw: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const obj = raw as Record<string, unknown>;
  for (const [actionId, val] of Object.entries(obj)) {
    const entry = getShortcutEntry(actionId);
    if (!entry || entry.rebindable === false) continue;
    if (!Array.isArray(val)) continue;
    const cleanKeys = Array.from(
      new Set(
        val
          .filter((k): k is string => typeof k === 'string')
          .map((k) => normalizeKeyCombo(k))
          .filter((k) => k.length > 0)
      )
    );
    const defaultKeys = entry.keys.map((k) => normalizeKeyCombo(k)).filter(Boolean);
    if (!areKeyListsEqual(cleanKeys, defaultKeys)) {
      result[actionId] = cleanKeys;
    }
  }
  return result;
}

function loadCustomShortcuts(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_SHORTCUTS_STORAGE_KEY) || 'null');
    return sanitizeCustomShortcuts(raw);
  } catch {
    return {};
  }
}

function saveCustomShortcuts(overrides: Record<string, string[]>): void {
  try {
    localStorage.setItem(CUSTOM_SHORTCUTS_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // ignore storage errors
  }
}

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
        raw.sidebarTab === 'inspector' ||
        raw.sidebarTab === 'tiers' ||
        raw.sidebarTab === 'history' ||
        raw.sidebarTab === 'settings' ||
        raw.sidebarTab === 'customize'
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
const initialF0RangePrefs = loadF0RangePrefs();

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface AlignMicroResult {
  aligned: number;
  skippedPointCollision: number;
  skippedBoundConstraint: number;
}

export interface ToastState {
  message: string;
  isError: boolean;
  visible: boolean;
  action?: ToastAction | null;
}

export interface HistoryNavSignal {
  seq: number;
  tabId: string;
  focusTime?: number;
  selection: EditorSelection;
}

export interface HistoryJumpOptions {
  showToastLabel?: 'undo' | 'redo';
}

export interface BoundaryMoveOptions {
  coalesce?: boolean;
  nextSelection?: EditorSelection;
  actionMeta?: Partial<HistoryActionMeta>;
}

export interface PendingAutoEditTarget {
  kind: 'interval';
  tierIndex: number;
  itemIndex: number;
  caretAtEnd?: boolean;
}

export interface ActivateCorpusEntryPayload {
  tabId?: string;
  itemId: string;
  tg: TextGrid;
  filename: string;
  currentFilePath: string | null;
  currentFileFormat?: TextGridFormat;
  selection?: EditorSelection;
  playRange?: { start: number; end: number } | null;
  audioName: string;
  audioOffset?: number;
  audioDuration: number;
  audioSampleRate: number;
  analysis: AudioAnalysisSummary | null;
  loadSeq?: number;
  itemPatch?: Partial<
    Pick<
      CorpusItemRecord,
      'status' | 'hasTextGrid' | 'ipaPreview' | 'duration' | 'note' | 'updatedAt' | 'label' | 'missing'
    >
  >;
  pendingAutoEditTarget?: PendingAutoEditTarget | null;
}

export interface TabRecord {
  id: string;
  kind?: 'single' | 'corpus';
  corpus?: CorpusProjectState;
  tg: TextGrid;
  collectionTgs: TextGrid[];
  collectionActiveIdx: number;
  filename: string;
  currentFilePath: string | null;
  currentFileFormat: TextGridFormat;
  isDirty: boolean;
  baselineKind: BaselineKind;
  history: HistoryTimeline;
  collectionHistories: Record<number, HistoryTimeline>;
  viewDomain: { min: number; max: number } | null;
  selection: EditorSelection;
  lastActiveTierIndex: number;
  hiddenTierIndices: number[];
  playRange: { start: number; end: number } | null;
  currentTime: number;
  audioName: string;
  audioLoading: boolean;
  audioOffset: number;
  audioDuration: number;
  audioSampleRate: number;
  analysis: AudioAnalysisSummary | null;
  isBlankPlaceholder: boolean;
}

export interface CreateTabOptions {
  kind?: 'single' | 'corpus';
  corpus?: CorpusProjectState;
  tg?: TextGrid;
  filename?: string;
  collectionTgs?: TextGrid[];
  activeIdx?: number;
  filePath?: string | null;
  fileFormat?: TextGridFormat;
  isBlankPlaceholder?: boolean;
  baselineKind?: BaselineKind;
  activate?: boolean;
}

export interface CloseTabResult {
  removedSessionId: number | null;
  removedCorpusProjectId: string | null;
  removedTabId: string;
  nextActiveTabId: string;
}

export interface EditorState {
  // Multi-tab workspace state
  tabs: TabRecord[];
  activeTabId: string;
  corpusActiveEntryId: string | null;
  pendingAutoEditTarget: PendingAutoEditTarget | null;

  // Active-tab mirrored top-level document fields (fast reactive selectors)
  tg: TextGrid;
  collectionTgs: TextGrid[];
  collectionActiveIdx: number;
  filename: string;
  currentFilePath: string | null;
  currentFileFormat: TextGridFormat;
  isDirty: boolean;
  baselineKind: BaselineKind;
  history: HistoryTimeline;
  collectionHistories: Record<number, HistoryTimeline>;
  historyLimit: number;
  lastHistoryNav: HistoryNavSignal | null;
  mode: 'read' | 'edit';
  wrapMode: 'auto' | 'single';
  scaleMode: 'elastic' | 'linear';
  tickPrecision: '2' | '3' | '4' | 'full';
  tickFixedDecimals: boolean;
  viewDomain: { min: number; max: number } | null;
  targetWidth: number;
  widthAutoFit: boolean;
  stageAvailableWidth: number;
  selection: EditorSelection;
  lastActiveTierIndex: number;
  hiddenTierIndices: number[];
  playRange: { start: number; end: number } | null;
  currentTime: number;
  showPlayhead: boolean;
  playing: boolean;
  loop: boolean;
  followPlayhead: boolean;
  rate: number;
  volume: number;
  legendOpen: boolean;

  // Audio & Acoustic (per-tab mirrored)
  audioName: string;
  audioLoading: boolean;
  audioOffset: number;
  audioDuration: number;
  audioSampleRate: number;
  analysis: AudioAnalysisSummary | null;
  showSpectrogram: boolean;
  cueMode: 'auto' | 'pitch' | 'formant' | 'plain';
  tierOrder: 'raw' | 'spec';
  maxFreq: 5000 | 8000 | 10000;
  maxFreqUserSet: boolean;
  f0RangeMode: F0RangeMode;
  f0RangeCustom: [number, number];

  // IPA System
  ipaMode: IpaInputMode;
  ipaDockOpen: boolean;
  ipaFloating: boolean;

  // Classic Tiered Ribbon State
  ribbonTab: RibbonTabId;
  ribbonCollapsed: boolean;
  restoreSessionOnStartup: boolean;

  // Office-Style Right Sidebar & Edit Inspector Preferences
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  sidebarWidth: number;
  editInspectorMode: EditInspectorMode;
  autoOpenInspectorOnSelect: boolean;
  showMicroLoupe: boolean;
  showCorpusStatusMarks: boolean;
  uiScale: number;
  canvasScale: number;

  // Customization State (Floating Bar & Rebindable Shortcuts)
  floatingBarConfig: FloatingBarConfig;
  customShortcuts: Record<string, string[]>;

  // Modals & Layout ref
  exportOpen: boolean;
  exportPresetRange: ExportRangePreset | null;
  posterOpen: boolean;
  aboutOpen: boolean;
  findBarOpen: boolean;
  findBarReplaceMode: boolean;
  shortcutsOpen: boolean;
  preferencesOpen: boolean;
  preferencesSection: PreferencesSection;
  layout: ScoreLayout | null;
  toast: ToastState;
  docVersion: number;

  // Multi-tab actions
  createNewTab: (opts?: CreateTabOptions) => string;
  switchTab: (tabId: string) => void;
  closeTabImmediate: (tabId: string) => CloseTabResult;
  getDirtyTabs: () => TabRecord[];
  findTabByPath: (filePath: string) => TabRecord | null;
  findCorpusTabByRootKey: (rootKey: string) => TabRecord | null;
  openCorpusTab: (corpus: CorpusProjectState, opts?: { activate?: boolean }) => string;
  activateCorpusEntry: (payload: ActivateCorpusEntryPayload) => void;
  updateCorpusItemMeta: (
    itemId: string,
    patch: Partial<
      Pick<
        CorpusItemRecord,
        'status' | 'hasTextGrid' | 'ipaPreview' | 'duration' | 'note' | 'updatedAt' | 'label' | 'missing'
      >
    >,
    tabId?: string
  ) => void;
  setCorpusFilter: (patch: Partial<CorpusFilterState>, tabId?: string) => void;
  setCorpusOptions: (patch: Partial<CorpusOptions>, tabId?: string) => void;
  toggleCorpusSidebar: (open?: boolean, tabId?: string) => void;
  setCorpusSidebarWidth: (width: number, tabId?: string) => void;
  setCorpusSaveState: (
    patch: Partial<
      Pick<CorpusProjectState, 'saveStatus' | 'lastSaveError' | 'dirtyCount' | 'loadSeq' | 'tierTemplate'>
    >,
    tabId?: string
  ) => void;
  setPendingAutoEditTarget: (target: PendingAutoEditTarget | null) => void;
  clearPendingAutoEditTarget: () => void;
  markTabSaved: (
    tabId: string,
    meta?: {
      filePath?: string | null;
      filename?: string;
      fileFormat?: TextGridFormat;
      markAllCollectionItems?: boolean;
    }
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
  setAudioLoadingForTab: (tabId: string, loading: boolean) => void;

  // Active document actions
  setDocument: (
    tg: TextGrid,
    filename: string,
    collectionTgs?: TextGrid[],
    activeIdx?: number,
    meta?: {
      filePath?: string | null;
      fileFormat?: TextGridFormat;
      isBlankPlaceholder?: boolean;
      baselineKind?: BaselineKind;
    }
  ) => void;
  markSaved: (meta?: {
    filePath?: string | null;
    filename?: string;
    fileFormat?: TextGridFormat;
    markAllCollectionItems?: boolean;
  }) => void;
  switchCollectionItem: (idx: number) => void;
  commitTgMutation: (
    mutator: (draft: TextGrid, ctx: MutationContext) => boolean | void,
    nextSelection: EditorSelection | undefined,
    meta: HistoryActionMeta
  ) => boolean;
  jumpToHistory: (targetCursor: number, opts?: HistoryJumpOptions) => boolean;
  jumpToSavedPoint: () => boolean;
  clearHistoryToCurrent: () => boolean;
  setHistoryLimit: (limit: number) => void;
  undo: () => boolean;
  redo: () => boolean;
  setMode: (mode: 'read' | 'edit') => void;
  setWrapMode: (wrapMode: 'auto' | 'single') => void;
  setScaleMode: (scaleMode: 'elastic' | 'linear') => void;
  setTickPrecision: (prec: '2' | '3' | '4' | 'full') => void;
  setTickFixedDecimals: (v: boolean) => void;
  setViewDomain: (domain: { min: number; max: number } | null) => void;
  setTargetWidth: (w: number) => void;
  setWidthAutoFit: (v: boolean) => void;
  setStageAvailableWidth: (w: number) => void;
  setSelection: (sel: EditorSelection) => void;
  toggleTierVisibility: (tierIndex: number) => void;
  soloTier: (tierIndex: number) => void;
  showAllTiers: () => void;
  setPlayRange: (range: { start: number; end: number } | null) => void;
  setPlaybackTime: (t: number, showPlayhead: boolean) => void;
  setPlaying: (playing: boolean) => void;
  setLoop: (loop: boolean) => void;
  setFollowPlayhead: (v: boolean) => void;
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
  setF0RangeMode: (m: F0RangeMode) => void;
  setF0RangeCustom: (minHz: number, maxHz: number) => void;
  setIpaMode: (m: IpaInputMode) => void;
  cycleIpaMode: () => void;
  setIpaDockOpen: (open: boolean) => void;
  setIpaFloating: (floating: boolean) => void;
  setRibbonTab: (tab: RibbonTabId) => void;
  setRibbonCollapsed: (collapsed: boolean) => void;
  toggleRibbonCollapsed: () => void;
  setRestoreSessionOnStartup: (enabled: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleSidebarTab: (tab: SidebarTab) => void;
  setSidebarWidth: (w: number) => void;
  setEditInspectorMode: (m: EditInspectorMode) => void;
  setAutoOpenInspectorOnSelect: (auto: boolean) => void;
  setShowMicroLoupe: (show: boolean) => void;
  setShowCorpusStatusMarks: (show: boolean) => void;
  setUiScale: (scale: number) => void;
  setCanvasScale: (scale: number) => void;
  toggleFloatingBarItem: (target: FloatingBarTarget, itemId: string) => void;
  reorderFloatingBarItem: (target: FloatingBarTarget, fromId: string, toId: string) => void;
  applyFloatingBarPreset: (preset: FloatingBarPresetKey) => void;
  resetFloatingBarConfig: () => void;
  setCustomShortcut: (actionId: string, keys: string[], clearConflictIds?: string[]) => void;
  resetCustomShortcut: (actionId: string) => void;
  resetAllCustomShortcuts: () => void;
  setExportOpen: (open: boolean) => void;
  openExportModal: (presetRange?: ExportRangePreset | null) => void;
  clearExportPresetRange: () => void;
  setPosterOpen: (open: boolean) => void;
  setAboutOpen: (open: boolean) => void;
  openFindBar: (replaceMode?: boolean) => void;
  closeFindBar: () => void;
  setShortcutsOpen: (v: boolean) => void;
  setPreferencesOpen: (open: boolean, section?: PreferencesSection) => void;
  setPreferencesSection: (section: PreferencesSection) => void;
  setLayout: (layout: ScoreLayout | null) => void;
  showToast: (message: string, isError?: boolean, action?: ToastAction | null) => void;
  hideToast: () => void;
  bumpDocVersion: () => void;

  // Domain edit helpers
  splitInterval: (
    tierIndex: number,
    itemIndex: number,
    splitTime?: number,
    opts?: { exact?: boolean }
  ) => boolean;
  mergeIntervalWith: (tierIndex: number, itemIndex: number, dir: -1 | 1) => void;
  deleteBoundaryAt: (tierIndex: number, time: number) => void;
  deleteBoundaryAcrossAllTiers: (time: number) => boolean;
  addPointAt: (tierIndex: number, time: number, opts?: { exact?: boolean }) => number | null;
  insertTierAt: (index: number, kind: TierKind) => void;
  duplicateTier: (tierIndex: number, opts: { copyText: boolean; insertAt?: number }) => number;
  derivePointTierFromIntervals: (tierIndex: number, anchor: 'start' | 'mid' | 'end') => number;
  moveTier: (tierIndex: number, delta: -1 | 1) => void;
  reorderTier: (fromIdx: number, toIdx: number, overrideSelection?: EditorSelection) => void;
  deleteTier: (tierIndex: number) => void;
  removeTierWithUndoToast: (tierIndex: number) => void;
  clearTierText: (tierIndex: number) => void;
  projectBoundaryToTier: (targetTierIndex: number, time: number) => boolean;
  copyIntervalSpanToTier: (
    srcTierIdx: number,
    itemIdx: number,
    targetTierIdx: number,
    copyText: boolean
  ) => boolean;
  splitIntervalEqualN: (tierIndex: number, itemIndex: number, n: number) => boolean;
  alignMicroBoundaries: (targetTierIndex?: number, thresholdSec?: number) => AlignMicroResult;
  updateBlankTabDuration: (audioOffset: number, audioDuration: number) => boolean;
  normalizeTextGrid: () => void;
  moveTierBoundary: (
    tierIndex: number,
    oldT: number,
    newT: number,
    shared: boolean,
    opts?: BoundaryMoveOptions
  ) => boolean;
  moveSharedTimestamp: (oldT: number, newT: number, opts?: BoundaryMoveOptions) => boolean;
}

let beforeHistoryNavigateHook: (() => void) | null = null;

export function registerBeforeHistoryNavigate(fn: (() => void) | null): void {
  beforeHistoryNavigateHook = fn;
}

function flushBeforeHistoryNavigate(): void {
  beforeHistoryNavigateHook?.();
}

let nextHistoryNavSeq = 1;

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

const CORPUS_HISTORY_CACHE_MAX = 6;
const corpusHistoryCache = new Map<string, HistoryTimeline>();

function getCorpusHistoryCacheKey(tabId: string, itemId: string): string {
  return `${tabId}::${itemId}`;
}

function cacheCorpusEntryHistory(tabId: string, itemId: string, timeline: HistoryTimeline): void {
  const key = getCorpusHistoryCacheKey(tabId, itemId);
  corpusHistoryCache.delete(key);
  corpusHistoryCache.set(key, sealTimelineCoalesce(timeline));
  while (corpusHistoryCache.size > CORPUS_HISTORY_CACHE_MAX) {
    const oldestKey = corpusHistoryCache.keys().next().value;
    if (oldestKey === undefined) break;
    corpusHistoryCache.delete(oldestKey);
  }
}

function getCachedCorpusEntryHistory(tabId: string, itemId: string): HistoryTimeline | null {
  const key = getCorpusHistoryCacheKey(tabId, itemId);
  const found = corpusHistoryCache.get(key);
  if (!found) return null;
  corpusHistoryCache.delete(key);
  corpusHistoryCache.set(key, found);
  return found;
}

function clearCorpusHistoryCacheForTab(tabId: string): void {
  const prefix = `${tabId}::`;
  for (const key of Array.from(corpusHistoryCache.keys())) {
    if (key.startsWith(prefix)) {
      corpusHistoryCache.delete(key);
    }
  }
}

function clampCorpusSidebarWidth(w: number): number {
  return Math.max(220, Math.min(440, Math.round(Number.isFinite(w) ? w : 280)));
}

function computeCollectionDirty(
  activeHistory: HistoryTimeline,
  collectionHistories: Record<number, HistoryTimeline>,
  activeIdx: number
): boolean {
  if (isTimelineDirty(activeHistory)) return true;
  for (const [k, tl] of Object.entries(collectionHistories)) {
    if (Number(k) !== activeIdx && isTimelineDirty(tl)) return true;
  }
  return false;
}

function createTabRecord(opts?: CreateTabOptions, historyLimit = loadSavedHistoryLimit()): TabRecord {
  const isDefaultBlank = !opts?.tg;
  const tg = opts?.tg ?? createSample('blank').tg;
  const filename = opts?.filename ?? tg.name ?? '未命名.TextGrid';
  const collectionTgs = opts?.collectionTgs ?? [];
  const activeIdx = opts?.activeIdx ?? 0;
  const isBlank = opts?.isBlankPlaceholder ?? isDefaultBlank;
  const baselineKind: BaselineKind = opts?.baselineKind ?? (isBlank ? 'blank' : 'open');
  const history = createHistoryTimeline(
    baselineKind,
    filename,
    {
      tg,
      selection: null,
      hiddenTierIndices: [],
      playRange: null
    },
    historyLimit
  );
  const collectionHistories: Record<number, HistoryTimeline> =
    collectionTgs.length > 0 ? { [activeIdx]: history } : {};
  return {
    id: generateTabId(),
    kind: opts?.kind ?? 'single',
    corpus: opts?.corpus,
    tg,
    collectionTgs,
    collectionActiveIdx: activeIdx,
    filename,
    currentFilePath: opts?.filePath ?? null,
    currentFileFormat: opts?.fileFormat ?? 'longText',
    isDirty: false,
    baselineKind,
    history,
    collectionHistories,
    viewDomain: null,
    selection: null,
    lastActiveTierIndex: 0,
    hiddenTierIndices: [],
    playRange: null,
    currentTime: Number.isFinite(tg.xmin) ? tg.xmin : 0,
    audioName: '',
    audioLoading: false,
    audioOffset: 0,
    audioDuration: 0,
    audioSampleRate: 0,
    analysis: null,
    isBlankPlaceholder: isBlank
  };
}

function fieldsFromTab(tab: TabRecord) {
  return {
    activeTabId: tab.id,
    corpusActiveEntryId: tab.corpus?.activeItemId ?? null,
    tg: tab.tg,
    collectionTgs: tab.collectionTgs,
    collectionActiveIdx: tab.collectionActiveIdx,
    filename: tab.filename,
    currentFilePath: tab.currentFilePath,
    currentFileFormat: tab.currentFileFormat,
    isDirty: tab.isDirty,
    baselineKind: tab.baselineKind,
    history: tab.history,
    collectionHistories: tab.collectionHistories,
    viewDomain: tab.viewDomain,
    selection: tab.selection,
    lastActiveTierIndex: tab.lastActiveTierIndex,
    hiddenTierIndices: tab.hiddenTierIndices,
    playRange: tab.playRange,
    currentTime: tab.currentTime,
    audioName: tab.audioName,
    audioLoading: tab.audioLoading,
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

function extractTierIndex(sel: EditorSelection): number | null {
  if (!sel) return null;
  if (
    sel.kind === 'interval' ||
    sel.kind === 'point' ||
    sel.kind === 'boundary' ||
    sel.kind === 'tier'
  ) {
    return sel.tierIndex;
  }
  return null;
}

function clampTierIndex(idx: number, tierCount: number): number {
  if (tierCount <= 0) return 0;
  if (!Number.isFinite(idx) || idx < 0) return 0;
  return Math.min(tierCount - 1, Math.floor(idx));
}

function sanitizeHiddenTiers(indices: number[], tierCount: number): number[] {
  if (tierCount <= 1) return [];
  const uniq = Array.from(
    new Set(indices.filter((i) => Number.isInteger(i) && i >= 0 && i < tierCount))
  ).sort((a, b) => a - b);
  if (uniq.length >= tierCount) return [];
  return uniq;
}

function remapHiddenOnInsert(hidden: number[], insertIdx: number, nextTierCount: number): number[] {
  return sanitizeHiddenTiers(
    hidden.map((i) => (i >= insertIdx ? i + 1 : i)),
    nextTierCount
  );
}

function remapHiddenOnDelete(hidden: number[], delIdx: number, nextTierCount: number): number[] {
  return sanitizeHiddenTiers(
    hidden.filter((i) => i !== delIdx).map((i) => (i > delIdx ? i - 1 : i)),
    nextTierCount
  );
}

function remapIndexOnReorder(idx: number, fromIdx: number, toIdx: number): number {
  if (idx === fromIdx) return toIdx;
  if (fromIdx < toIdx) {
    if (idx > fromIdx && idx <= toIdx) return idx - 1;
  } else if (fromIdx > toIdx) {
    if (idx >= toIdx && idx < fromIdx) return idx + 1;
  }
  return idx;
}

function remapHiddenOnReorder(
  hidden: number[],
  fromIdx: number,
  toIdx: number,
  tierCount: number
): number[] {
  return sanitizeHiddenTiers(
    hidden.map((i) => remapIndexOnReorder(i, fromIdx, toIdx)),
    tierCount
  );
}

function loadFollowPlayhead(): boolean {
  try {
    return localStorage.getItem('tg_follow_playhead') !== '0';
  } catch {
    return true;
  }
}

function loadShowCorpusStatusMarks(): boolean {
  try {
    return localStorage.getItem('tg_corpus_show_status') !== '0';
  } catch {
    return true;
  }
}

const RIBBON_COLLAPSED_STORAGE_KEY = 'tg_ribbon_collapsed';

function loadRibbonCollapsed(): boolean {
  try {
    return localStorage.getItem(RIBBON_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveRibbonCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(RIBBON_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // ignore storage errors
  }
}

const RESTORE_SESSION_STORAGE_KEY = 'tg_restore_session_v1';
const HAS_OPENED_STORAGE_KEY = 'tg_has_opened_v1';

function loadRestoreSessionOnStartup(): boolean {
  try {
    return localStorage.getItem(RESTORE_SESSION_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function saveRestoreSessionOnStartup(enabled: boolean): void {
  try {
    localStorage.setItem(RESTORE_SESSION_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore storage errors
  }
}

function consumeIsFirstOpen(): boolean {
  try {
    const alreadyOpened = localStorage.getItem(HAS_OPENED_STORAGE_KEY) === '1';
    if (!alreadyOpened) {
      localStorage.setItem(HAS_OPENED_STORAGE_KEY, '1');
      return true;
    }
    return false;
  } catch {
    return true;
  }
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

function clampTabTemporalToTg(
  tg: TextGrid,
  curTime: number,
  playRange: { start: number; end: number } | null,
  viewDomain: { min: number; max: number } | null
): {
  currentTime: number;
  playRange: { start: number; end: number } | null;
  viewDomain: { min: number; max: number } | null;
} {
  const gMin = Number.isFinite(tg.xmin) ? tg.xmin : 0;
  const gMax = Number.isFinite(tg.xmax) && tg.xmax >= gMin ? tg.xmax : gMin;
  const eps = 1e-9;

  const nextTime = Number.isFinite(curTime)
    ? Math.max(gMin, Math.min(gMax, curTime))
    : gMin;

  let nextPlayRange: { start: number; end: number } | null = null;
  if (playRange && Number.isFinite(playRange.start) && Number.isFinite(playRange.end)) {
    const s = Math.max(gMin, playRange.start);
    const e = Math.min(gMax, playRange.end);
    if (e > s + eps) {
      nextPlayRange = { start: s, end: e };
    }
  }

  let nextViewDomain: { min: number; max: number } | null = null;
  if (viewDomain && Number.isFinite(viewDomain.min) && Number.isFinite(viewDomain.max)) {
    const min = Math.max(gMin, viewDomain.min);
    const max = Math.min(gMax, viewDomain.max);
    if (max > min + eps && !(min <= gMin + eps && max >= gMax - eps)) {
      nextViewDomain = { min, max };
    }
  }

  return { currentTime: nextTime, playRange: nextPlayRange, viewDomain: nextViewDomain };
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
const initialHistoryLimit = loadSavedHistoryLimit();
const initialIsFirstOpen = consumeIsFirstOpen();
const initialSample = createSample(initialIsFirstOpen ? 'poem' : 'blank');
const initialTab = createTabRecord(
  {
    tg: initialSample.tg,
    filename: initialSample.tg.name,
    filePath: null,
    fileFormat: 'longText',
    isBlankPlaceholder: !initialIsFirstOpen,
    baselineKind: initialIsFirstOpen ? 'sample' : 'blank'
  },
  initialHistoryLimit
);

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [initialTab],
  ...fieldsFromTab(initialTab),
  pendingAutoEditTarget: null,
  historyLimit: initialHistoryLimit,
  lastHistoryNav: null,

  mode: initialIsFirstOpen ? 'read' : 'edit',
  wrapMode: 'auto',
  scaleMode: 'elastic',
  tickPrecision: '3',
  tickFixedDecimals: (() => {
    try {
      return localStorage.getItem('tg_tick_fixed_decimals') === '1';
    } catch {
      return false;
    }
  })(),
  targetWidth: 1120,
  widthAutoFit: true,
  stageAvailableWidth: 1120,
  showPlayhead: false,
  playing: false,
  loop: false,
  followPlayhead: loadFollowPlayhead(),
  rate: 1.0,
  volume: loadSavedVolume(),
  legendOpen: false,

  showSpectrogram: true,
  cueMode: 'auto',
  tierOrder: 'raw',
  maxFreq: 8000,
  maxFreqUserSet: false,
  f0RangeMode: initialF0RangePrefs.mode,
  f0RangeCustom: initialF0RangePrefs.custom,

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

  ribbonTab: 'annotate',
  ribbonCollapsed: loadRibbonCollapsed(),
  restoreSessionOnStartup: loadRestoreSessionOnStartup(),

  sidebarOpen: initialSidebarPrefs.sidebarOpen,
  sidebarTab: initialSidebarPrefs.sidebarTab,
  sidebarWidth: initialSidebarPrefs.sidebarWidth,
  editInspectorMode: initialSidebarPrefs.editInspectorMode,
  autoOpenInspectorOnSelect: initialSidebarPrefs.autoOpenInspectorOnSelect,
  showMicroLoupe: initialSidebarPrefs.showMicroLoupe,
  showCorpusStatusMarks: loadShowCorpusStatusMarks(),
  uiScale: loadSavedUiScale(),
  canvasScale: loadSavedCanvasScale(),

  floatingBarConfig: loadFloatingBarConfig(),
  customShortcuts: loadCustomShortcuts(),

  exportOpen: false,
  exportPresetRange: null,
  posterOpen: false,
  aboutOpen: false,
  findBarOpen: false,
  findBarReplaceMode: false,
  shortcutsOpen: false,
  preferencesOpen: false,
  preferencesSection: 'editing',
  layout: null,
  toast: { message: '', isError: false, visible: false, action: null },
  docVersion: 1,

  createNewTab: (opts) => {
    const newTab = createTabRecord(opts, get().historyLimit);
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
        ...(newTab.kind !== 'corpus' && s.ribbonTab === 'corpus'
          ? { ribbonTab: 'annotate' as RibbonTabId }
          : {}),
        pendingAutoEditTarget: null,
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
      const smartMaxFreq =
        !s.maxFreqUserSet && target.audioSampleRate > 0
          ? ((target.audioSampleRate >= 16000 ? 8000 : 5000) as 5000 | 8000 | 10000)
          : s.maxFreq;
      return {
        tabs: updatedTabs,
        ...fieldsFromTab(target),
        ...(target.kind !== 'corpus' && s.ribbonTab === 'corpus'
          ? { ribbonTab: 'annotate' as RibbonTabId }
          : {}),
        pendingAutoEditTarget: null,
        maxFreq: smartMaxFreq,
        showPlayhead: false,
        playing: false,
        docVersion: s.docVersion + 1
      };
    }),

  closeTabImmediate: (tabId) => {
    const cur = get();
    const idx = cur.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) {
      return {
        removedSessionId: null,
        removedCorpusProjectId: null,
        removedTabId: tabId,
        nextActiveTabId: cur.activeTabId
      };
    }
    const target = cur.tabs[idx];
    const removedSessionId = target.analysis?.sessionId ?? null;
    const removedCorpusProjectId = target.kind === 'corpus' ? (target.corpus?.projectId ?? null) : null;
    clearCorpusHistoryCacheForTab(tabId);
    const remaining = cur.tabs.filter((t) => t.id !== tabId);

    if (remaining.length === 0) {
      const fresh = createTabRecord({ isBlankPlaceholder: true });
      set((s) => ({
        tabs: [fresh],
        ...fieldsFromTab(fresh),
        ...(s.ribbonTab === 'corpus' ? { ribbonTab: 'annotate' as RibbonTabId } : {}),
        pendingAutoEditTarget: null,
        showPlayhead: false,
        playing: false,
        docVersion: s.docVersion + 1
      }));
      return {
        removedSessionId,
        removedCorpusProjectId,
        removedTabId: tabId,
        nextActiveTabId: fresh.id
      };
    }

    if (tabId === cur.activeTabId) {
      const nextActive = remaining[Math.min(idx, remaining.length - 1)];
      set((s) => ({
        tabs: remaining,
        ...fieldsFromTab(nextActive),
        ...(nextActive.kind !== 'corpus' && s.ribbonTab === 'corpus'
          ? { ribbonTab: 'annotate' as RibbonTabId }
          : {}),
        pendingAutoEditTarget: null,
        showPlayhead: false,
        playing: false,
        docVersion: s.docVersion + 1
      }));
      return {
        removedSessionId,
        removedCorpusProjectId,
        removedTabId: tabId,
        nextActiveTabId: nextActive.id
      };
    }

    set({ tabs: remaining });
    return {
      removedSessionId,
      removedCorpusProjectId,
      removedTabId: tabId,
      nextActiveTabId: cur.activeTabId
    };
  },

  getDirtyTabs: () => get().tabs.filter((t) => t.isDirty),

  findTabByPath: (filePath) => {
    if (!filePath) return null;
    const key = normalizePathKey(filePath);
    return (
      get().tabs.find(
        (t) =>
          t.kind !== 'corpus' &&
          t.currentFilePath &&
          normalizePathKey(t.currentFilePath) === key
      ) ?? null
    );
  },

  findCorpusTabByRootKey: (rootKey) => {
    if (!rootKey) return null;
    const key = normalizePathKey(rootKey);
    return (
      get().tabs.find(
        (t) =>
          t.kind === 'corpus' &&
          t.corpus &&
          (t.corpus.rootKey === rootKey || normalizePathKey(t.corpus.rootKey) === key)
      ) ?? null
    );
  },

  openCorpusTab: (corpus, opts) => {
    const normalizedCorpus: CorpusProjectState = {
      ...corpus,
      sidebarWidth: clampCorpusSidebarWidth(corpus.sidebarWidth)
    };
    const newTab = createTabRecord(
      {
        kind: 'corpus',
        corpus: normalizedCorpus,
        filename: normalizedCorpus.projectName || '文件夹项目',
        filePath: null,
        fileFormat: normalizedCorpus.defaultSaveFormat ?? 'longText',
        isBlankPlaceholder: false,
        baselineKind: 'open'
      },
      get().historyLimit
    );
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
        mode: 'edit',
        pendingAutoEditTarget: null,
        showPlayhead: false,
        playing: false,
        lastHistoryNav: null,
        docVersion: s.docVersion + 1
      };
    });
    return newTab.id;
  },

  activateCorpusEntry: (payload) =>
    set((s) => {
      const targetTabId = payload.tabId ?? s.activeTabId;
      const target = s.tabs.find((t) => t.id === targetTabId);
      if (!target || target.kind !== 'corpus' || !target.corpus) return s;

      const prevActiveId = target.corpus.activeItemId;
      if (prevActiveId && prevActiveId !== payload.itemId) {
        const prevHistory = target.id === s.activeTabId ? s.history : target.history;
        cacheCorpusEntryHistory(target.id, prevActiveId, prevHistory);
      }

      const nextSelection = validateSelectionForTg(payload.tg, payload.selection ?? null);
      const temporal = clampTabTemporalToTg(
        payload.tg,
        Number.isFinite(payload.tg.xmin) ? payload.tg.xmin : 0,
        payload.playRange ?? null,
        null
      );
      const selTierIdx = extractTierIndex(nextSelection);
      const nextLastActive =
        selTierIdx !== null ? clampTierIndex(selTierIdx, payload.tg.tiers.length) : 0;

      let nextHistory: HistoryTimeline | null = null;
      const cachedHistory = getCachedCorpusEntryHistory(target.id, payload.itemId);
      if (cachedHistory) {
        const cachedSnap = getCurrentSnapshot(cachedHistory);
        if (JSON.stringify(cachedSnap.tg) === JSON.stringify(payload.tg)) {
          nextHistory = sealTimelineCoalesce(cachedHistory);
        }
      }
      if (!nextHistory) {
        nextHistory = createHistoryTimeline(
          'open',
          payload.filename,
          {
            tg: payload.tg,
            selection: nextSelection,
            hiddenTierIndices: [],
            playRange: temporal.playRange
          },
          s.historyLimit
        );
      }

      let nextItems = target.corpus.items;
      let nextItemMap = target.corpus.itemMap;
      if (payload.itemPatch && target.corpus.itemMap[payload.itemId]) {
        const prevItem = target.corpus.itemMap[payload.itemId];
        const updatedItem: CorpusItemRecord = { ...prevItem, ...payload.itemPatch };
        const idx = target.corpus.items.findIndex((it) => it.id === payload.itemId);
        if (idx >= 0) {
          nextItems = target.corpus.items.slice();
          nextItems[idx] = updatedItem;
        }
        nextItemMap = { ...target.corpus.itemMap, [payload.itemId]: updatedItem };
      }

      const nextCorpus: CorpusProjectState = {
        ...target.corpus,
        activeItemId: payload.itemId,
        loadSeq: payload.loadSeq ?? target.corpus.loadSeq,
        items: nextItems,
        itemMap: nextItemMap
      };

      const nextTab: TabRecord = {
        ...target,
        tg: payload.tg,
        filename: payload.filename,
        currentFilePath: payload.currentFilePath,
        currentFileFormat: payload.currentFileFormat ?? target.corpus.defaultSaveFormat ?? 'longText',
        isDirty: isTimelineDirty(nextHistory),
        baselineKind: 'open',
        history: nextHistory,
        viewDomain: null,
        selection: nextSelection,
        lastActiveTierIndex: nextLastActive,
        hiddenTierIndices: [],
        playRange: temporal.playRange,
        currentTime: temporal.currentTime,
        audioName: payload.audioName,
        audioLoading: false,
        audioOffset: payload.audioOffset ?? 0,
        audioDuration: payload.audioDuration,
        audioSampleRate: payload.audioSampleRate,
        analysis: payload.analysis,
        isBlankPlaceholder: false,
        corpus: nextCorpus
      };

      const nextTabs = s.tabs.map((t) => (t.id === targetTabId ? nextTab : t));
      if (targetTabId !== s.activeTabId) {
        return { tabs: nextTabs };
      }

      const smartMaxFreq =
        !s.maxFreqUserSet && payload.audioSampleRate > 0
          ? ((payload.audioSampleRate >= 16000 ? 8000 : 5000) as 5000 | 8000 | 10000)
          : s.maxFreq;

      return {
        tabs: nextTabs,
        ...fieldsFromTab(nextTab),
        maxFreq: smartMaxFreq,
        pendingAutoEditTarget:
          payload.pendingAutoEditTarget !== undefined ? payload.pendingAutoEditTarget : null,
        showPlayhead: false,
        playing: false,
        lastHistoryNav: null,
        docVersion: s.docVersion + 1
      };
    }),

  updateCorpusItemMeta: (itemId, patch, tabId) =>
    set((s) => {
      const targetTabId = tabId ?? s.activeTabId;
      const target = s.tabs.find((t) => t.id === targetTabId);
      if (!target || target.kind !== 'corpus' || !target.corpus) return s;
      const prevItem = target.corpus.itemMap[itemId];
      if (!prevItem) return s;
      const updatedItem: CorpusItemRecord = { ...prevItem, ...patch };
      const idx = target.corpus.items.findIndex((it) => it.id === itemId);
      const nextItems = target.corpus.items.slice();
      if (idx >= 0) nextItems[idx] = updatedItem;
      const nextCorpus: CorpusProjectState = {
        ...target.corpus,
        items: nextItems,
        itemMap: { ...target.corpus.itemMap, [itemId]: updatedItem }
      };
      return {
        tabs: s.tabs.map((t) => (t.id === targetTabId ? { ...t, corpus: nextCorpus } : t))
      };
    }),

  setCorpusFilter: (patch, tabId) =>
    set((s) => {
      const targetTabId = tabId ?? s.activeTabId;
      const target = s.tabs.find((t) => t.id === targetTabId);
      if (!target || target.kind !== 'corpus' || !target.corpus) return s;
      const nextCorpus: CorpusProjectState = {
        ...target.corpus,
        filter: { ...target.corpus.filter, ...patch }
      };
      return {
        tabs: s.tabs.map((t) => (t.id === targetTabId ? { ...t, corpus: nextCorpus } : t))
      };
    }),

  setCorpusOptions: (patch, tabId) =>
    set((s) => {
      const targetTabId = tabId ?? s.activeTabId;
      const target = s.tabs.find((t) => t.id === targetTabId);
      if (!target || target.kind !== 'corpus' || !target.corpus) return s;
      const nextCorpus: CorpusProjectState = {
        ...target.corpus,
        options: { ...target.corpus.options, ...patch }
      };
      return {
        tabs: s.tabs.map((t) => (t.id === targetTabId ? { ...t, corpus: nextCorpus } : t))
      };
    }),

  toggleCorpusSidebar: (open, tabId) =>
    set((s) => {
      const targetTabId = tabId ?? s.activeTabId;
      const target = s.tabs.find((t) => t.id === targetTabId);
      if (!target || target.kind !== 'corpus' || !target.corpus) return s;
      const nextOpen = open !== undefined ? open : !target.corpus.sidebarOpen;
      if (nextOpen === target.corpus.sidebarOpen) return s;
      const nextCorpus: CorpusProjectState = {
        ...target.corpus,
        sidebarOpen: nextOpen
      };
      return {
        tabs: s.tabs.map((t) => (t.id === targetTabId ? { ...t, corpus: nextCorpus } : t))
      };
    }),

  setCorpusSidebarWidth: (width, tabId) =>
    set((s) => {
      const targetTabId = tabId ?? s.activeTabId;
      const target = s.tabs.find((t) => t.id === targetTabId);
      if (!target || target.kind !== 'corpus' || !target.corpus) return s;
      const nextWidth = clampCorpusSidebarWidth(width);
      if (nextWidth === target.corpus.sidebarWidth) return s;
      const nextCorpus: CorpusProjectState = {
        ...target.corpus,
        sidebarWidth: nextWidth
      };
      return {
        tabs: s.tabs.map((t) => (t.id === targetTabId ? { ...t, corpus: nextCorpus } : t))
      };
    }),

  setCorpusSaveState: (patch, tabId) =>
    set((s) => {
      const targetTabId = tabId ?? s.activeTabId;
      const target = s.tabs.find((t) => t.id === targetTabId);
      if (!target || target.kind !== 'corpus' || !target.corpus) return s;
      const nextCorpus: CorpusProjectState = {
        ...target.corpus,
        ...patch
      };
      return {
        tabs: s.tabs.map((t) => (t.id === targetTabId ? { ...t, corpus: nextCorpus } : t))
      };
    }),

  setPendingAutoEditTarget: (pendingAutoEditTarget) => set({ pendingAutoEditTarget }),
  clearPendingAutoEditTarget: () => set({ pendingAutoEditTarget: null }),

  markTabSaved: (tabId, meta) =>
    set((s) => {
      const target = s.tabs.find((t) => t.id === tabId);
      if (!target) return s;
      const activeHistory = tabId === s.activeTabId ? s.history : target.history;
      const activeColHistories =
        tabId === s.activeTabId ? s.collectionHistories : target.collectionHistories;
      const nextHistory = markTimelineSaved(activeHistory);
      const nextColHistories: Record<number, HistoryTimeline> = {};
      if (target.collectionTgs.length > 0) {
        for (const [k, tl] of Object.entries(activeColHistories)) {
          nextColHistories[Number(k)] = meta?.markAllCollectionItems ? markTimelineSaved(tl) : tl;
        }
        nextColHistories[target.collectionActiveIdx] = nextHistory;
      }
      const nextDirty =
        target.collectionTgs.length > 0
          ? computeCollectionDirty(nextHistory, nextColHistories, target.collectionActiveIdx)
          : isTimelineDirty(nextHistory);
      const patch: Partial<TabRecord> = {
        isDirty: nextDirty,
        history: nextHistory,
        collectionHistories: nextColHistories,
        isBlankPlaceholder: false,
        ...(meta?.filePath !== undefined ? { currentFilePath: meta.filePath } : {}),
        ...(meta?.filename !== undefined ? { filename: meta.filename } : {}),
        ...(meta?.fileFormat !== undefined ? { currentFileFormat: meta.fileFormat } : {})
      };
      const nextTabs = s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t));
      if (tabId === s.activeTabId) {
        return {
          tabs: nextTabs,
          isDirty: nextDirty,
          history: nextHistory,
          collectionHistories: nextColHistories,
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
        const smartMaxFreq =
          !s.maxFreqUserSet && meta.sampleRate > 0
            ? ((meta.sampleRate >= 16000 ? 8000 : 5000) as 5000 | 8000 | 10000)
            : s.maxFreq;
        return {
          tabs: nextTabs,
          audioName: meta.name,
          audioOffset: meta.offset,
          audioDuration: meta.duration,
          audioSampleRate: meta.sampleRate,
          analysis: meta.analysis,
          maxFreq: smartMaxFreq
        };
      }
      return { tabs: nextTabs };
    }),

  setAudioLoadingForTab: (tabId, loading) =>
    set((s) => {
      const target = s.tabs.find((t) => t.id === tabId);
      if (!target || target.audioLoading === loading) return s;
      const nextTabs = s.tabs.map((t) => (t.id === tabId ? { ...t, audioLoading: loading } : t));
      if (tabId === s.activeTabId) {
        return { tabs: nextTabs, audioLoading: loading };
      }
      return { tabs: nextTabs };
    }),

  setDocument: (tg, filename, collectionTgs = [], activeIdx = 0, meta) =>
    set((s) => {
      const isBlank = meta?.isBlankPlaceholder ?? false;
      const baselineKind: BaselineKind = meta?.baselineKind ?? (isBlank ? 'blank' : 'open');
      const history = createHistoryTimeline(
        baselineKind,
        filename,
        {
          tg,
          selection: null,
          hiddenTierIndices: [],
          playRange: null
        },
        s.historyLimit
      );
      const collectionHistories: Record<number, HistoryTimeline> =
        collectionTgs.length > 0 ? { [activeIdx]: history } : {};
      const patch: Partial<TabRecord> = {
        tg,
        filename,
        currentFilePath: meta?.filePath ?? null,
        currentFileFormat: meta?.fileFormat ?? 'longText',
        isDirty: false,
        baselineKind,
        history,
        collectionHistories,
        collectionTgs,
        collectionActiveIdx: activeIdx,
        viewDomain: null,
        selection: null,
        lastActiveTierIndex: 0,
        hiddenTierIndices: [],
        playRange: null,
        currentTime: Number.isFinite(tg.xmin) ? tg.xmin : 0,
        audioLoading: false,
        isBlankPlaceholder: isBlank
      };
      return {
        ...syncActivePatch(s, patch),
        showPlayhead: false,
        lastHistoryNav: null,
        docVersion: s.docVersion + 1
      };
    }),

  markSaved: (meta) => {
    const activeId = get().activeTabId;
    get().markTabSaved(activeId, meta);
  },

  switchCollectionItem: (idx) =>
    set((s) => {
      if (idx === s.collectionActiveIdx || idx < 0 || idx >= s.collectionTgs.length) return s;
      const nextCollection = [...s.collectionTgs];
      const nextHistories: Record<number, HistoryTimeline> = { ...s.collectionHistories };
      if (s.collectionActiveIdx >= 0 && s.collectionActiveIdx < nextCollection.length) {
        nextCollection[s.collectionActiveIdx] = s.tg;
        nextHistories[s.collectionActiveIdx] = sealTimelineCoalesce(s.history);
      }

      const rawTargetTg = nextCollection[idx];
      let targetHistory = nextHistories[idx];
      if (!targetHistory) {
        targetHistory = createHistoryTimeline(
          s.baselineKind,
          rawTargetTg.name || s.filename,
          {
            tg: rawTargetTg,
            selection: null,
            hiddenTierIndices: [],
            playRange: null
          },
          s.historyLimit
        );
      } else {
        targetHistory = sealTimelineCoalesce(targetHistory);
      }
      nextHistories[idx] = targetHistory;

      const targetSnap = getCurrentSnapshot(targetHistory);
      const nextTg = targetSnap.tg;
      nextCollection[idx] = nextTg;
      const nextSelection = validateSelectionForTg(nextTg, targetSnap.selection);
      const nextHidden = sanitizeHiddenTiers(targetSnap.hiddenTierIndices, nextTg.tiers.length);
      const temporal = clampTabTemporalToTg(nextTg, s.currentTime, targetSnap.playRange, null);
      const selTierIdx = extractTierIndex(nextSelection);
      const nextLastActive =
        selTierIdx !== null ? clampTierIndex(selTierIdx, nextTg.tiers.length) : 0;
      const nextDirty = computeCollectionDirty(targetHistory, nextHistories, idx);

      const patch: Partial<TabRecord> = {
        collectionTgs: nextCollection,
        collectionActiveIdx: idx,
        collectionHistories: nextHistories,
        history: targetHistory,
        isDirty: nextDirty,
        tg: nextTg,
        filename: nextTg.name || s.filename,
        viewDomain: null,
        selection: nextSelection,
        lastActiveTierIndex: nextLastActive,
        hiddenTierIndices: nextHidden,
        playRange: temporal.playRange,
        currentTime: temporal.currentTime
      };
      return {
        ...syncActivePatch(s, patch),
        showPlayhead: false,
        docVersion: s.docVersion + 1
      };
    }),

  commitTgMutation: (mutator, nextSelection, meta) => {
    let committed = false;
    set((s) => {
      const produced = produceTgMutation(s.tg, mutator);
      if (!produced.changed) return s;
      committed = true;

      const nextTg = produced.nextTg;
      const rawSelection = produced.hasNextSelection
        ? produced.nextSelection!
        : nextSelection !== undefined
          ? nextSelection
          : s.selection;
      const resolvedSelection = validateSelectionForTg(nextTg, rawSelection);
      const rawHidden = produced.hasNextHiddenTiers
        ? produced.nextHiddenTiers!
        : s.hiddenTierIndices;
      const nextHidden = sanitizeHiddenTiers(rawHidden, nextTg.tiers.length);
      const rawPlayRange = produced.hasNextPlayRange ? produced.nextPlayRange! : s.playRange;
      const temporal = clampTabTemporalToTg(nextTg, s.currentTime, rawPlayRange, s.viewDomain);

      const selTierIdx = extractTierIndex(resolvedSelection);
      const nextLastActive =
        selTierIdx !== null
          ? clampTierIndex(selTierIdx, nextTg.tiers.length)
          : clampTierIndex(s.lastActiveTierIndex, nextTg.tiers.length);

      const nextHistory = commitToTimeline(s.history, meta, {
        tg: nextTg,
        selection: resolvedSelection,
        hiddenTierIndices: nextHidden,
        playRange: temporal.playRange
      });

      const nextCollection =
        s.collectionTgs.length > 0
          ? s.collectionTgs.map((item, i) => (i === s.collectionActiveIdx ? nextTg : item))
          : s.collectionTgs;
      const nextCollectionHistories =
        s.collectionTgs.length > 0
          ? { ...s.collectionHistories, [s.collectionActiveIdx]: nextHistory }
          : s.collectionHistories;
      const nextDirty =
        s.collectionTgs.length > 0
          ? computeCollectionDirty(nextHistory, nextCollectionHistories, s.collectionActiveIdx)
          : isTimelineDirty(nextHistory);

      const patch: Partial<TabRecord> = {
        tg: nextTg,
        collectionTgs: nextCollection,
        collectionHistories: nextCollectionHistories,
        history: nextHistory,
        isDirty: nextDirty,
        selection: resolvedSelection,
        lastActiveTierIndex: nextLastActive,
        hiddenTierIndices: nextHidden,
        currentTime: temporal.currentTime,
        playRange: temporal.playRange,
        viewDomain: temporal.viewDomain,
        isBlankPlaceholder: false
      };
      return {
        ...syncActivePatch(s, patch),
        docVersion: s.docVersion + 1
      };
    });
    return committed;
  },

  jumpToHistory: (targetCursor, opts) => {
    if (get().mode === 'read') {
      get().showToast('当前为只读模式，切至编辑模式后可回退历史（按 E 切换）', false, {
        label: '切至编辑',
        onClick: () => useEditorStore.getState().setMode('edit')
      });
      return false;
    }

    flushBeforeHistoryNavigate();

    let jumped = false;
    let toastMessage: string | null = null;
    set((s) => {
      const h = s.history;
      const clampedTarget = Math.max(-1, Math.min(h.entries.length - 1, Math.trunc(targetCursor)));
      if (clampedTarget === h.cursor) return s;

      const departingEntry = h.cursor >= 0 ? h.entries[h.cursor] : null;
      const targetEntry = clampedTarget >= 0 ? h.entries[clampedTarget] : null;
      const targetSnap = clampedTarget === -1 ? h.baseline.snapshot : targetEntry!.snapshot;

      const nextHistory = setTimelineCursor(h, clampedTarget);
      const nextTg = targetSnap.tg;
      const nextSelection = validateSelectionForTg(nextTg, targetSnap.selection);
      const nextHidden = sanitizeHiddenTiers(targetSnap.hiddenTierIndices, nextTg.tiers.length);
      const temporal = clampTabTemporalToTg(
        nextTg,
        s.currentTime,
        targetSnap.playRange,
        s.viewDomain
      );

      const selTierIdx = extractTierIndex(nextSelection);
      const nextLastActive =
        selTierIdx !== null
          ? clampTierIndex(selTierIdx, nextTg.tiers.length)
          : clampTierIndex(s.lastActiveTierIndex, nextTg.tiers.length);

      const nextCollection =
        s.collectionTgs.length > 0
          ? s.collectionTgs.map((item, i) => (i === s.collectionActiveIdx ? nextTg : item))
          : s.collectionTgs;
      const nextCollectionHistories =
        s.collectionTgs.length > 0
          ? { ...s.collectionHistories, [s.collectionActiveIdx]: nextHistory }
          : s.collectionHistories;
      const nextDirty =
        s.collectionTgs.length > 0
          ? computeCollectionDirty(nextHistory, nextCollectionHistories, s.collectionActiveIdx)
          : isTimelineDirty(nextHistory);

      const focusTime = targetEntry?.meta.focusTime ?? departingEntry?.meta.focusTime;
      const navSignal: HistoryNavSignal = {
        seq: nextHistoryNavSeq++,
        tabId: s.activeTabId,
        focusTime,
        selection: nextSelection
      };

      jumped = true;
      if (opts?.showToastLabel === 'undo' && departingEntry) {
        const suffix = departingEntry.meta.tierName ? `「${departingEntry.meta.tierName}」` : '';
        toastMessage = `已撤销：${departingEntry.meta.title}${suffix}`;
      } else if (opts?.showToastLabel === 'redo' && targetEntry) {
        const suffix = targetEntry.meta.tierName ? `「${targetEntry.meta.tierName}」` : '';
        toastMessage = `已重做：${targetEntry.meta.title}${suffix}`;
      }

      const patch: Partial<TabRecord> = {
        tg: nextTg,
        collectionTgs: nextCollection,
        collectionHistories: nextCollectionHistories,
        history: nextHistory,
        isDirty: nextDirty,
        currentTime: temporal.currentTime,
        playRange: temporal.playRange,
        viewDomain: temporal.viewDomain,
        selection: nextSelection,
        lastActiveTierIndex: nextLastActive,
        hiddenTierIndices: nextHidden
      };
      return {
        ...syncActivePatch(s, patch),
        lastHistoryNav: navSignal,
        docVersion: s.docVersion + 1
      };
    });

    if (toastMessage) {
      get().showToast(toastMessage);
    }
    return jumped;
  },

  jumpToSavedPoint: () => {
    if (get().mode === 'read') {
      get().showToast('当前为只读模式，切至编辑模式后可回退历史（按 E 切换）', false, {
        label: '切至编辑',
        onClick: () => useEditorStore.getState().setMode('edit')
      });
      return false;
    }
    flushBeforeHistoryNavigate();
    const h = get().history;
    if (h.savedEntryId === null || getCurrentEntryId(h) === h.savedEntryId) {
      return false;
    }
    const targetCursor =
      h.baseline.id === h.savedEntryId
        ? -1
        : h.entries.findIndex((e) => e.id === h.savedEntryId);
    if (targetCursor < -1 || (h.baseline.id !== h.savedEntryId && targetCursor === -1)) {
      return false;
    }
    const ok = get().jumpToHistory(targetCursor);
    if (ok) {
      get().showToast('已恢复至上次保存状态');
    }
    return ok;
  },

  clearHistoryToCurrent: () => {
    if (get().mode === 'read') {
      get().showToast('当前为只读模式，切至编辑模式后可清空历史（按 E 切换）', false, {
        label: '切至编辑',
        onClick: () => useEditorStore.getState().setMode('edit')
      });
      return false;
    }
    flushBeforeHistoryNavigate();
    let cleared = false;
    set((s) => {
      if (s.history.entries.length === 0) return s;
      cleared = true;
      const curSnapshot = {
        tg: s.tg,
        selection: s.selection,
        hiddenTierIndices: s.hiddenTierIndices,
        playRange: s.playRange
      };
      const nextHistory = clearTimelineToCurrent(s.history, s.filename, curSnapshot);
      const nextCollectionHistories =
        s.collectionTgs.length > 0
          ? { ...s.collectionHistories, [s.collectionActiveIdx]: nextHistory }
          : s.collectionHistories;
      const nextDirty =
        s.collectionTgs.length > 0
          ? computeCollectionDirty(nextHistory, nextCollectionHistories, s.collectionActiveIdx)
          : isTimelineDirty(nextHistory);
      const patch: Partial<TabRecord> = {
        history: nextHistory,
        collectionHistories: nextCollectionHistories,
        isDirty: nextDirty
      };
      return syncActivePatch(s, patch);
    });
    if (cleared) {
      get().showToast('已清空操作历史，当前状态已设为基线');
    }
    return cleared;
  },

  setHistoryLimit: (limit) => {
    const nextLimit = clampHistoryLimit(limit);
    saveHistoryLimit(nextLimit);
    set((s) => {
      const nextTabs = s.tabs.map((tab) => {
        const curHistory = tab.id === s.activeTabId ? s.history : tab.history;
        const curColHistories =
          tab.id === s.activeTabId ? s.collectionHistories : tab.collectionHistories;
        const nextHistory = setTimelineMaxEntries(curHistory, nextLimit);
        const nextColHistories: Record<number, HistoryTimeline> = {};
        if (tab.collectionTgs.length > 0) {
          for (const [k, tl] of Object.entries(curColHistories)) {
            nextColHistories[Number(k)] = setTimelineMaxEntries(tl, nextLimit);
          }
          nextColHistories[tab.collectionActiveIdx] = nextHistory;
        }
        const nextDirty =
          tab.collectionTgs.length > 0
            ? computeCollectionDirty(nextHistory, nextColHistories, tab.collectionActiveIdx)
            : isTimelineDirty(nextHistory);
        return {
          ...tab,
          history: nextHistory,
          collectionHistories: nextColHistories,
          isDirty: nextDirty
        };
      });
      const activeTab = nextTabs.find((t) => t.id === s.activeTabId);
      return {
        historyLimit: nextLimit,
        tabs: nextTabs,
        ...(activeTab
          ? {
              history: activeTab.history,
              collectionHistories: activeTab.collectionHistories,
              isDirty: activeTab.isDirty
            }
          : {})
      };
    });
  },

  undo: () => {
    if (get().mode === 'read') {
      get().showToast('当前为只读模式，切至编辑模式后可回退历史（按 E 切换）', false, {
        label: '切至编辑',
        onClick: () => useEditorStore.getState().setMode('edit')
      });
      return false;
    }
    flushBeforeHistoryNavigate();
    const h = get().history;
    if (!canUndoTimeline(h)) return false;
    return get().jumpToHistory(h.cursor - 1, { showToastLabel: 'undo' });
  },

  redo: () => {
    if (get().mode === 'read') {
      get().showToast('当前为只读模式，切至编辑模式后可重做历史（按 E 切换）', false, {
        label: '切至编辑',
        onClick: () => useEditorStore.getState().setMode('edit')
      });
      return false;
    }
    flushBeforeHistoryNavigate();
    const h = get().history;
    if (!canRedoTimeline(h)) return false;
    return get().jumpToHistory(h.cursor + 1, { showToastLabel: 'redo' });
  },

  setMode: (mode) => set({ mode, ...(mode === 'read' ? { ipaDockOpen: false } : {}) }),
  setWrapMode: (wrapMode) =>
    set((s) => {
      if (s.wrapMode === wrapMode) return s;
      return {
        wrapMode,
        widthAutoFit: true,
        ...(wrapMode === 'auto' && s.targetWidth > 2400 ? { targetWidth: 2400 } : {})
      };
    }),
  setScaleMode: (scaleMode) => set({ scaleMode }),
  setTickPrecision: (tickPrecision) => set({ tickPrecision }),
  setTickFixedDecimals: (tickFixedDecimals) => {
    try {
      localStorage.setItem('tg_tick_fixed_decimals', tickFixedDecimals ? '1' : '0');
    } catch {
      // ignore
    }
    set({ tickFixedDecimals });
  },
  setViewDomain: (viewDomain) => set((s) => syncActivePatch(s, { viewDomain })),
  setTargetWidth: (w) =>
    set({
      targetWidth: Math.max(280, Math.min(18000, Math.round(w))),
      widthAutoFit: false
    }),
  setWidthAutoFit: (widthAutoFit) => set({ widthAutoFit }),
  setStageAvailableWidth: (w) =>
    set((s) => {
      const next = Math.max(260, Math.round(Number.isFinite(w) ? w : 1120));
      return s.stageAvailableWidth === next ? s : { stageAvailableWidth: next };
    }),
  setSelection: (selection) =>
    set((s) => {
      const ti = extractTierIndex(selection);
      const patch: Partial<TabRecord> =
        ti !== null
          ? { selection, lastActiveTierIndex: clampTierIndex(ti, s.tg.tiers.length) }
          : { selection };
      return syncActivePatch(s, patch);
    }),
  toggleTierVisibility: (tierIndex) => {
    const st = get();
    const total = st.tg.tiers.length;
    if (tierIndex < 0 || tierIndex >= total) return;
    const isHidden = st.hiddenTierIndices.includes(tierIndex);
    if (isHidden) {
      const nextHidden = st.hiddenTierIndices.filter((i) => i !== tierIndex);
      set((s) => syncActivePatch(s, { hiddenTierIndices: nextHidden }));
      return;
    }
    const visibleCount = total - st.hiddenTierIndices.length;
    if (visibleCount <= 1) {
      st.showToast('至少保留一个可见层级');
      return;
    }
    const nextHidden = sanitizeHiddenTiers([...st.hiddenTierIndices, tierIndex], total);
    set((s) => syncActivePatch(s, { hiddenTierIndices: nextHidden }));
  },
  soloTier: (tierIndex) => {
    const st = get();
    const total = st.tg.tiers.length;
    if (tierIndex < 0 || tierIndex >= total) return;
    if (total <= 1) {
      set((s) => syncActivePatch(s, { hiddenTierIndices: [] }));
      return;
    }
    const alreadySolo =
      st.hiddenTierIndices.length === total - 1 && !st.hiddenTierIndices.includes(tierIndex);
    const nextHidden = alreadySolo
      ? []
      : st.tg.tiers.map((_, i) => i).filter((i) => i !== tierIndex);
    set((s) => syncActivePatch(s, { hiddenTierIndices: nextHidden }));
  },
  showAllTiers: () => set((s) => syncActivePatch(s, { hiddenTierIndices: [] })),
  setPlayRange: (playRange) => set((s) => syncActivePatch(s, { playRange })),
  setPlaybackTime: (currentTime, showPlayhead) => set({ currentTime, showPlayhead }),
  setPlaying: (playing) => set({ playing }),
  setLoop: (loop) => set({ loop }),
  setFollowPlayhead: (followPlayhead) => {
    try {
      localStorage.setItem('tg_follow_playhead', followPlayhead ? '1' : '0');
    } catch {
      // ignore
    }
    set({ followPlayhead });
  },
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
  setMaxFreq: (maxFreq) => set({ maxFreq, maxFreqUserSet: true }),
  setF0RangeMode: (f0RangeMode) =>
    set((s) => {
      saveF0RangePrefs(f0RangeMode, s.f0RangeCustom);
      return { f0RangeMode };
    }),
  setF0RangeCustom: (minHz, maxHz) =>
    set((s) => {
      const f0RangeCustom = clampCustomF0Range(minHz, maxHz);
      saveF0RangePrefs(s.f0RangeMode, f0RangeCustom);
      return { f0RangeCustom };
    }),
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
      praat: 'Praat 音标'
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
  setRibbonTab: (ribbonTab) => set({ ribbonTab }),
  setRibbonCollapsed: (ribbonCollapsed) => {
    saveRibbonCollapsed(ribbonCollapsed);
    set({ ribbonCollapsed });
  },
  toggleRibbonCollapsed: () =>
    set((s) => {
      const next = !s.ribbonCollapsed;
      saveRibbonCollapsed(next);
      return { ribbonCollapsed: next };
    }),
  setRestoreSessionOnStartup: (restoreSessionOnStartup) => {
    saveRestoreSessionOnStartup(restoreSessionOnStartup);
    set({ restoreSessionOnStartup });
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
  setShowCorpusStatusMarks: (showCorpusStatusMarks) => {
    try {
      localStorage.setItem('tg_corpus_show_status', showCorpusStatusMarks ? '1' : '0');
    } catch {
      // ignore storage errors
    }
    set({ showCorpusStatusMarks });
  },
  setUiScale: (scale) => {
    const uiScale = clampUiScale(scale);
    saveUiScale(uiScale);
    set({ uiScale });
  },
  setCanvasScale: (scale) => {
    const canvasScale = clampCanvasScale(scale);
    saveCanvasScale(canvasScale);
    set({ canvasScale });
  },
  toggleFloatingBarItem: (target, itemId) =>
    set((s) => {
      const sec = s.floatingBarConfig[target];
      if (!sec || !sec.order.includes(itemId)) return s;
      const isHidden = sec.hidden.includes(itemId);
      const nextHidden = isHidden
        ? sec.hidden.filter((id) => id !== itemId)
        : sec.order.filter((id) => id === itemId || sec.hidden.includes(id));
      const nextConfig: FloatingBarConfig = {
        ...s.floatingBarConfig,
        [target]: {
          order: [...sec.order],
          hidden: nextHidden
        }
      };
      saveFloatingBarConfig(nextConfig);
      return { floatingBarConfig: nextConfig };
    }),
  reorderFloatingBarItem: (target, fromId, toId) =>
    set((s) => {
      const sec = s.floatingBarConfig[target];
      if (!sec || fromId === toId) return s;
      const fromIdx = sec.order.indexOf(fromId);
      const toIdx = sec.order.indexOf(toId);
      if (fromIdx === -1 || toIdx === -1) return s;
      const nextOrder = [...sec.order];
      const [moved] = nextOrder.splice(fromIdx, 1);
      nextOrder.splice(toIdx, 0, moved);
      const hiddenSet = new Set(sec.hidden);
      const nextConfig: FloatingBarConfig = {
        ...s.floatingBarConfig,
        [target]: {
          order: nextOrder,
          hidden: nextOrder.filter((id) => hiddenSet.has(id))
        }
      };
      saveFloatingBarConfig(nextConfig);
      return { floatingBarConfig: nextConfig };
    }),
  applyFloatingBarPreset: (preset) =>
    set(() => {
      const base = FLOATING_BAR_PRESETS[preset];
      if (!base) return {};
      const nextConfig = cloneFloatingBarConfig(base);
      saveFloatingBarConfig(nextConfig);
      return { floatingBarConfig: nextConfig };
    }),
  resetFloatingBarConfig: () =>
    set(() => {
      const nextConfig = cloneFloatingBarConfig(DEFAULT_FLOATING_BAR_CONFIG);
      saveFloatingBarConfig(nextConfig);
      return { floatingBarConfig: nextConfig };
    }),
  setCustomShortcut: (actionId, keys, clearConflictIds) =>
    set((s) => {
      const entry = getShortcutEntry(actionId);
      if (!entry || entry.rebindable === false) return s;
      const cleanKeys = Array.from(
        new Set(keys.map((k) => normalizeKeyCombo(k)).filter((k) => k.length > 0))
      );
      const defaultKeys = entry.keys.map((k) => normalizeKeyCombo(k)).filter(Boolean);
      const next: Record<string, string[]> = { ...s.customShortcuts };
      if (Array.isArray(clearConflictIds)) {
        for (const cid of clearConflictIds) {
          if (cid === actionId) continue;
          const conflictEntry = getShortcutEntry(cid);
          if (conflictEntry && conflictEntry.rebindable !== false) {
            next[cid] = [];
          }
        }
      }
      if (areKeyListsEqual(cleanKeys, defaultKeys)) {
        delete next[actionId];
      } else {
        next[actionId] = cleanKeys;
      }
      saveCustomShortcuts(next);
      return { customShortcuts: next };
    }),
  resetCustomShortcut: (actionId) =>
    set((s) => {
      if (!Object.prototype.hasOwnProperty.call(s.customShortcuts, actionId)) return s;
      const next = { ...s.customShortcuts };
      delete next[actionId];
      saveCustomShortcuts(next);
      return { customShortcuts: next };
    }),
  resetAllCustomShortcuts: () =>
    set(() => {
      saveCustomShortcuts({});
      return { customShortcuts: {} };
    }),
  setExportOpen: (exportOpen) => set({ exportOpen, ...(exportOpen ? {} : { exportPresetRange: null }) }),
  openExportModal: (presetRange = null) => set({ exportOpen: true, exportPresetRange: presetRange }),
  clearExportPresetRange: () => set({ exportPresetRange: null }),
  setPosterOpen: (posterOpen) => set({ posterOpen }),
  setAboutOpen: (aboutOpen) => set({ aboutOpen }),
  openFindBar: (replaceMode = false) =>
    set({ findBarOpen: true, findBarReplaceMode: Boolean(replaceMode) }),
  closeFindBar: () => set({ findBarOpen: false, findBarReplaceMode: false }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setPreferencesOpen: (preferencesOpen, section) =>
    set((s) => ({
      preferencesOpen,
      preferencesSection: section ?? s.preferencesSection
    })),
  setPreferencesSection: (preferencesSection) => set({ preferencesSection }),
  setLayout: (layout) => set({ layout }),
  bumpDocVersion: () => set((s) => ({ docVersion: s.docVersion + 1 })),

  showToast: (message, isError = false, action = null) => {
    set({ toast: { message, isError, visible: true, action } });
    if (toastTimeout) clearTimeout(toastTimeout);
    const duration = action || isError ? 4200 : 2400;
    toastTimeout = setTimeout(() => {
      set((s) => ({ toast: { ...s.toast, visible: false } }));
    }, duration);
  },

  hideToast: () => {
    if (toastTimeout) clearTimeout(toastTimeout);
    set((s) => ({ toast: { ...s.toast, visible: false } }));
  },

  splitInterval: (tierIndex, itemIndex, splitTime, opts) => {
    const st = get();
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return false;
    const iv = tier.intervals[itemIndex];
    if (!iv) return false;
    const t =
      splitTime !== undefined && Number.isFinite(splitTime)
        ? opts?.exact
          ? splitTime
          : roundTimeClean(splitTime)
        : roundTimeClean((iv.xmin + iv.xmax) / 2);
    if (t <= iv.xmin || t >= iv.xmax) {
      st.showToast('切分时间必须位于区间起止之间', true);
      return false;
    }
    const tierName = formatTierLabel(tier.name, tierIndex);
    return st.commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(tierIndex);
        if (!dTier || dTier.kind !== 'intervalTier') return false;
        const dIv = dTier.intervals[itemIndex];
        if (!dIv || t <= dIv.xmin || t >= dIv.xmax) return false;
        const right = { xmin: t, xmax: dIv.xmax, text: '' };
        dIv.xmax = t;
        dTier.intervals.splice(itemIndex + 1, 0, right);
      },
      { kind: 'interval', tierIndex, itemIndex: itemIndex + 1 },
      {
        type: 'split-interval',
        title: '切分区间',
        detail: `${tierName} · ${formatTimeSec(t)}`,
        icon: 'split',
        tierName,
        focusTime: t
      }
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
    const origA = tier.intervals[aIdx];
    const origB = tier.intervals[bIdx];
    if (!origA || !origB) return;
    const tierName = formatTierLabel(tier.name, tierIndex);
    st.commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(tierIndex);
        if (!dTier || dTier.kind !== 'intervalTier') return false;
        const a = dTier.intervals[aIdx];
        const b = dTier.intervals[bIdx];
        if (!a || !b) return false;
        a.xmax = b.xmax;
        a.text = a.text && b.text ? `${a.text} ${b.text}` : a.text || b.text;
        dTier.intervals.splice(bIdx, 1);
      },
      { kind: 'interval', tierIndex, itemIndex: aIdx },
      {
        type: 'merge-interval',
        title: dir === -1 ? '向左合并' : '向右合并',
        detail: `${tierName} · ${formatQuote(origA.text)}+${formatQuote(origB.text)}`,
        icon: dir === -1 ? 'mergeLeft' : 'mergeRight',
        tierName,
        focusTime: origA.xmin
      }
    );
  },

  deleteBoundaryAt: (tierIndex, time) => {
    const st = get();
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return;
    const leftIdx = tier.intervals.findIndex((iv) => iv.xmax === time);
    const rightIdx = tier.intervals.findIndex((iv) => iv.xmin === time);
    if (leftIdx === -1 || rightIdx === -1 || leftIdx === rightIdx) return;
    const aIdx = Math.min(leftIdx, rightIdx);
    const bIdx = Math.max(leftIdx, rightIdx);
    const tierName = formatTierLabel(tier.name, tierIndex);
    st.commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(tierIndex);
        if (!dTier || dTier.kind !== 'intervalTier') return false;
        const a = dTier.intervals[aIdx];
        const b = dTier.intervals[bIdx];
        if (!a || !b) return false;
        a.xmax = b.xmax;
        a.text = a.text && b.text ? `${a.text} ${b.text}` : a.text || b.text;
        dTier.intervals.splice(bIdx, 1);
      },
      { kind: 'interval', tierIndex, itemIndex: aIdx },
      {
        type: 'delete-boundary',
        title: '删除边界',
        detail: `${tierName} · ${formatTimeSec(time)}`,
        icon: 'delBoundary',
        tierName,
        focusTime: time
      }
    );
  },

  deleteBoundaryAcrossAllTiers: (time) => {
    const st = get();
    if (!Number.isFinite(time)) return false;
    const eps = 1e-9;
    let matchCount = 0;
    let selectedTierMergedIdx: number | null = null;
    const selTier = st.selection?.kind === 'boundary' ? st.selection.tierIndex : -1;

    for (let ti = 0; ti < st.tg.tiers.length; ti++) {
      const tier = st.tg.tiers[ti];
      if (tier.kind !== 'intervalTier') continue;
      const leftIdx = tier.intervals.findIndex((iv) => Math.abs(iv.xmax - time) <= eps);
      const rightIdx = tier.intervals.findIndex((iv) => Math.abs(iv.xmin - time) <= eps);
      if (leftIdx !== -1 && rightIdx !== -1 && leftIdx !== rightIdx) {
        matchCount++;
        if (ti === selTier) {
          selectedTierMergedIdx = Math.min(leftIdx, rightIdx);
        }
      }
    }

    if (matchCount === 0) return false;

    const nextSelection: EditorSelection =
      selTier >= 0 && selectedTierMergedIdx !== null
        ? { kind: 'interval', tierIndex: selTier, itemIndex: selectedTierMergedIdx }
        : null;

    return st.commitTgMutation(
      (draft, ctx) => {
        let applied = 0;
        for (let ti = 0; ti < draft.tiers.length; ti++) {
          const origTier = draft.tiers[ti];
          if (origTier.kind !== 'intervalTier') continue;
          const leftIdx = origTier.intervals.findIndex((iv) => Math.abs(iv.xmax - time) <= eps);
          const rightIdx = origTier.intervals.findIndex((iv) => Math.abs(iv.xmin - time) <= eps);
          if (leftIdx !== -1 && rightIdx !== -1 && leftIdx !== rightIdx) {
            const dTier = ctx.editTier(ti);
            if (!dTier || dTier.kind !== 'intervalTier') continue;
            const aIdx = Math.min(leftIdx, rightIdx);
            const bIdx = Math.max(leftIdx, rightIdx);
            const a = dTier.intervals[aIdx];
            const b = dTier.intervals[bIdx];
            a.xmax = b.xmax;
            a.text = a.text && b.text ? `${a.text} ${b.text}` : a.text || b.text;
            dTier.intervals.splice(bIdx, 1);
            applied++;
          }
        }
        if (applied === 0) return false;
      },
      nextSelection,
      {
        type: 'delete-boundary-all',
        title: '跨层删除边界',
        detail: `${matchCount} 个层级 · ${formatTimeSec(time)}`,
        icon: 'delBoundaryAll',
        focusTime: time
      }
    );
  },

  addPointAt: (tierIndex, time, opts) => {
    const st = get();
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'textTier') return null;
    const clamped = Math.min(tier.xmax, Math.max(tier.xmin, time));
    const finalT = opts?.exact ? clamped : roundTimeClean(clamped);
    if (tier.points.some((p) => p.number === finalT)) {
      st.showToast('该时间点已存在标点');
      return null;
    }
    const tierName = formatTierLabel(tier.name, tierIndex);
    let insertedIdx = 0;
    const ok = st.commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(tierIndex);
        if (!dTier || dTier.kind !== 'textTier') return false;
        const pt = { number: finalT, mark: '' };
        dTier.points.push(pt);
        dTier.points.sort((a, b) => a.number - b.number);
        insertedIdx = dTier.points.indexOf(pt);
        ctx.setNextSelection({ kind: 'point', tierIndex, itemIndex: insertedIdx });
      },
      undefined,
      {
        type: 'add-point',
        title: '添加标注点',
        detail: `${tierName} · ${formatTimeSec(finalT)}`,
        icon: 'addPointTier',
        tierName,
        focusTime: finalT
      }
    );
    return ok ? insertedIdx : null;
  },

  insertTierAt: (index, kind) => {
    const st = get();
    const insertAt = Math.max(0, Math.min(st.tg.tiers.length, index));
    const nextHidden = remapHiddenOnInsert(st.hiddenTierIndices, insertAt, st.tg.tiers.length + 1);
    const n = st.tg.tiers.length + 1;
    const newName = kind === 'intervalTier' ? `区间层 ${n}` : `点层 ${n}`;
    st.commitTgMutation(
      (draft, ctx) => {
        draft.tiers.splice(
          insertAt,
          0,
          kind === 'intervalTier'
            ? {
                kind: 'intervalTier',
                name: newName,
                xmin: draft.xmin,
                xmax: draft.xmax,
                intervals: [{ xmin: draft.xmin, xmax: draft.xmax, text: '' }],
                points: []
              }
            : {
                kind: 'textTier',
                name: newName,
                xmin: draft.xmin,
                xmax: draft.xmax,
                intervals: [],
                points: []
              }
        );
        ctx.setNextHiddenTiers(nextHidden);
      },
      { kind: 'tier', tierIndex: insertAt },
      {
        type: 'insert-tier',
        title: kind === 'intervalTier' ? '新建区间层' : '新建点层',
        detail: `${formatQuote(newName)} · 位置 #${insertAt + 1}`,
        icon: kind === 'intervalTier' ? 'addIntervalTier' : 'addPointTier',
        tierName: newName
      }
    );
  },

  duplicateTier: (tierIndex, opts) => {
    const st = get();
    const src = st.tg.tiers[tierIndex];
    if (!src) return -1;
    const copyText = Boolean(opts.copyText);
    const insertAt = Math.max(0, Math.min(st.tg.tiers.length, opts.insertAt ?? tierIndex + 1));
    const newName = `${src.name || '层'}${copyText ? ' (副本)' : ' (同界)'}`;
    const nextHidden = remapHiddenOnInsert(st.hiddenTierIndices, insertAt, st.tg.tiers.length + 1);

    const ok = st.commitTgMutation(
      (draft, ctx) => {
        const dSrc = draft.tiers[tierIndex];
        if (!dSrc) return false;
        const cloned =
          dSrc.kind === 'intervalTier'
            ? {
                kind: 'intervalTier' as const,
                name: newName,
                xmin: dSrc.xmin,
                xmax: dSrc.xmax,
                intervals: dSrc.intervals.map((iv) => ({
                  xmin: iv.xmin,
                  xmax: iv.xmax,
                  text: copyText ? iv.text : ''
                })),
                points: []
              }
            : {
                kind: 'textTier' as const,
                name: newName,
                xmin: dSrc.xmin,
                xmax: dSrc.xmax,
                intervals: [],
                points: dSrc.points.map((pt) => ({
                  number: pt.number,
                  mark: copyText ? pt.mark : ''
                }))
              };
        draft.tiers.splice(insertAt, 0, cloned);
        ctx.setNextHiddenTiers(nextHidden);
      },
      { kind: 'tier', tierIndex: insertAt },
      {
        type: 'duplicate-tier',
        title: copyText ? '复制层级' : '仅复制边界',
        detail: formatQuote(newName),
        icon: 'duplicateTier',
        tierName: newName
      }
    );
    return ok ? insertAt : -1;
  },

  derivePointTierFromIntervals: (tierIndex, anchor) => {
    const st = get();
    const src = st.tg.tiers[tierIndex];
    if (!src || src.kind !== 'intervalTier') return -1;
    const insertAt = tierIndex + 1;
    const anchorLabel = anchor === 'start' ? '起点' : anchor === 'mid' ? '中点' : '终点';
    const newName = `${src.name || '层'} · ${anchorLabel}`;
    const nextHidden = remapHiddenOnInsert(st.hiddenTierIndices, insertAt, st.tg.tiers.length + 1);

    const rawTimes: number[] = [];
    for (const iv of src.intervals) {
      if (iv.text.trim() === '') continue;
      if (!Number.isFinite(iv.xmin) || !Number.isFinite(iv.xmax)) continue;
      const t =
        anchor === 'start'
          ? iv.xmin
          : anchor === 'end'
            ? iv.xmax
            : (iv.xmin + iv.xmax) / 2;
      const clamped = Math.min(src.xmax, Math.max(src.xmin, t));
      rawTimes.push(clamped);
    }
    rawTimes.sort((a, b) => a - b);
    const dedupPoints: Array<{ number: number; mark: string }> = [];
    for (const t of rawTimes) {
      if (
        dedupPoints.length === 0 ||
        Math.abs(t - dedupPoints[dedupPoints.length - 1].number) > 1e-12
      ) {
        dedupPoints.push({ number: t, mark: '' });
      }
    }

    const ok = st.commitTgMutation(
      (draft, ctx) => {
        draft.tiers.splice(insertAt, 0, {
          kind: 'textTier',
          name: newName,
          xmin: src.xmin,
          xmax: src.xmax,
          intervals: [],
          points: dedupPoints
        });
        ctx.setNextHiddenTiers(nextHidden);
      },
      { kind: 'tier', tierIndex: insertAt },
      {
        type: 'derive-point-tier',
        title: '派生点层',
        detail: `${formatQuote(newName)} · ${dedupPoints.length} 个点`,
        icon: 'derivePointTier',
        tierName: newName
      }
    );
    return ok ? insertAt : -1;
  },

  reorderTier: (fromIdx, toIdx, overrideSelection) => {
    const st = get();
    const n = st.tg.tiers.length;
    if (fromIdx < 0 || fromIdx >= n || toIdx < 0 || toIdx >= n || fromIdx === toIdx) return;
    const srcName = formatTierLabel(st.tg.tiers[fromIdx]?.name, fromIdx);
    const nextHidden = remapHiddenOnReorder(st.hiddenTierIndices, fromIdx, toIdx, n);
    const nextLastActive = remapIndexOnReorder(st.lastActiveTierIndex, fromIdx, toIdx);
    const prevSel = st.selection;
    let nextSelection: EditorSelection = overrideSelection !== undefined ? overrideSelection : prevSel;
    if (overrideSelection === undefined && prevSel && extractTierIndex(prevSel) !== null) {
      nextSelection = {
        ...prevSel,
        tierIndex: remapIndexOnReorder(extractTierIndex(prevSel)!, fromIdx, toIdx)
      } as EditorSelection;
    }

    const switchedFromSpec = st.tierOrder === 'spec';
    if (switchedFromSpec) {
      set({ tierOrder: 'raw' });
    }

    st.commitTgMutation(
      (draft, ctx) => {
        if (!draft.tiers[fromIdx]) return false;
        const [moved] = draft.tiers.splice(fromIdx, 1);
        draft.tiers.splice(toIdx, 0, moved);
        ctx.setNextHiddenTiers(nextHidden);
        ctx.setNextSelection(nextSelection);
      },
      nextSelection,
      {
        type: 'reorder-tier',
        title: '调整层级顺序',
        detail: `${formatQuote(srcName)} · 第 ${fromIdx + 1} 层 → 第 ${toIdx + 1} 层`,
        icon: 'navVertical',
        tierName: srcName,
        coalesce: {
          key: 'reorder-tier',
          originValue: fromIdx,
          latestValue: toIdx,
          chainPrevLatest: fromIdx,
          formatMergedDetail: (orig, latest) =>
            `${formatQuote(srcName)} · 第 ${Number(orig) + 1} 层 → 第 ${Number(latest) + 1} 层`
        }
      }
    );
    if (extractTierIndex(nextSelection) === null) {
      set((s) =>
        syncActivePatch(s, {
          lastActiveTierIndex: clampTierIndex(nextLastActive, n)
        })
      );
    }
    if (switchedFromSpec) {
      get().showToast('已切回原始层序以反映调整');
    }
  },

  moveTier: (tierIndex, delta) => {
    const st = get();
    const target = tierIndex + delta;
    if (target < 0 || target >= st.tg.tiers.length) return;
    st.reorderTier(tierIndex, target, { kind: 'tier', tierIndex: target });
  },

  removeTierWithUndoToast: (tierIndex) => {
    const st = get();
    const tier = st.tg.tiers[tierIndex];
    if (!tier) return;
    const name = formatTierLabel(tier.name, tierIndex);
    const itemCount = tier.kind === 'intervalTier' ? tier.intervals.length : tier.points.length;
    const itemUnit = tier.kind === 'intervalTier' ? '段区间' : '个标点';
    const nextCount = st.tg.tiers.length - 1;
    const nextHidden = remapHiddenOnDelete(st.hiddenTierIndices, tierIndex, nextCount);
    const nextTierIdx = nextCount > 0 ? Math.min(tierIndex, nextCount - 1) : 0;
    const nextSelection: EditorSelection =
      nextCount > 0 ? { kind: 'tier', tierIndex: nextTierIdx } : null;

    const ok = st.commitTgMutation(
      (draft, ctx) => {
        if (!draft.tiers[tierIndex]) return false;
        draft.tiers.splice(tierIndex, 1);
        ctx.setNextHiddenTiers(nextHidden);
        ctx.setNextSelection(nextSelection);
      },
      nextSelection,
      {
        type: 'delete-tier',
        title: '删除层级',
        detail: `${formatQuote(name)} · 含 ${itemCount} ${itemUnit}`,
        icon: 'trash',
        tierName: name
      }
    );
    if (ok) {
      get().showToast(`已删除层级「${name}」`, false, {
        label: '撤销',
        onClick: () => useEditorStore.getState().undo()
      });
    }
  },

  deleteTier: (tierIndex) => {
    get().removeTierWithUndoToast(tierIndex);
  },

  clearTierText: (tierIndex) => {
    const st = get();
    const tier = st.tg.tiers[tierIndex];
    if (!tier) return;
    const name = formatTierLabel(tier.name, tierIndex);
    const nonEmptyCount =
      tier.kind === 'intervalTier'
        ? tier.intervals.filter((iv) => iv.text !== '').length
        : tier.points.filter((pt) => pt.mark !== '').length;
    if (nonEmptyCount === 0) {
      st.showToast(`层级「${name}」文本已为空`);
      return;
    }
    const ok = st.commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(tierIndex);
        if (!dTier) return false;
        if (dTier.kind === 'intervalTier') {
          for (const iv of dTier.intervals) iv.text = '';
        } else {
          for (const pt of dTier.points) pt.mark = '';
        }
      },
      undefined,
      {
        type: 'clear-tier-text',
        title: '清空整层文本',
        detail: `${name} · ${nonEmptyCount} 处已清空`,
        icon: 'clear',
        tierName: name
      }
    );
    if (ok) {
      get().showToast(`已清空层级「${name}」文本`, false, {
        label: '撤销',
        onClick: () => useEditorStore.getState().undo()
      });
    }
  },

  projectBoundaryToTier: (targetTierIndex, time) => {
    const st = get();
    const tier = st.tg.tiers[targetTierIndex];
    if (!tier || tier.kind !== 'intervalTier' || !Number.isFinite(time)) return false;
    const targetName = formatTierLabel(tier.name, targetTierIndex);
    const eps = 1e-9;
    const alreadyExists = tier.intervals.some(
      (iv) => Math.abs(iv.xmin - time) <= eps || Math.abs(iv.xmax - time) <= eps
    );
    if (alreadyExists) {
      st.showToast(`目标层「${targetName}」已存在该边界`);
      return false;
    }
    const itemIdx = tier.intervals.findIndex((iv) => iv.xmin < time && time < iv.xmax);
    if (itemIdx === -1) {
      st.showToast(`该时刻不在「${targetName}」有效区间内`, true);
      return false;
    }
    const ok = st.commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(targetTierIndex);
        if (!dTier || dTier.kind !== 'intervalTier') return false;
        const dIv = dTier.intervals[itemIdx];
        if (!dIv || !(dIv.xmin < time && time < dIv.xmax)) return false;
        const right = { xmin: time, xmax: dIv.xmax, text: '' };
        dIv.xmax = time;
        dTier.intervals.splice(itemIdx + 1, 0, right);
      },
      undefined,
      {
        type: 'project-boundary',
        title: '投射边界至层',
        detail: `→ ${targetName} · ${formatTimeSec(time)}`,
        icon: 'projectToTier',
        tierName: targetName,
        focusTime: time
      }
    );
    if (ok) {
      get().showToast(`已将边界投射至「${targetName}」`);
    }
    return ok;
  },

  copyIntervalSpanToTier: (srcTierIdx, itemIdx, targetTierIdx, copyText) => {
    const st = get();
    if (srcTierIdx === targetTierIdx) return false;
    const srcTier = st.tg.tiers[srcTierIdx];
    const targetTier = st.tg.tiers[targetTierIdx];
    if (!srcTier || srcTier.kind !== 'intervalTier') return false;
    if (!targetTier || targetTier.kind !== 'intervalTier') return false;
    const srcIv = srcTier.intervals[itemIdx];
    if (!srcIv || srcIv.xmax <= srcIv.xmin) return false;

    const srcName = formatTierLabel(srcTier.name, srcTierIdx);
    const targetName = formatTierLabel(targetTier.name, targetTierIdx);
    const t0 = srcIv.xmin;
    const t1 = srcIv.xmax;
    const eps = 1e-12;

    const overlappingIndices: number[] = [];
    for (let i = 0; i < targetTier.intervals.length; i++) {
      const iv = targetTier.intervals[i];
      if (iv.xmax > t0 + eps && iv.xmin < t1 - eps) {
        overlappingIndices.push(i);
      }
    }

    if (overlappingIndices.length === 0) {
      st.showToast(`目标层「${targetName}」该时段无可用区间`, true);
      return false;
    }

    const firstIdx = overlappingIndices[0];
    const lastIdx = overlappingIndices[overlappingIndices.length - 1];
    const firstIv = targetTier.intervals[firstIdx];
    const lastIv = targetTier.intervals[lastIdx];

    if (firstIv.xmin > t0 + eps || lastIv.xmax < t1 - eps) {
      st.showToast(`目标层「${targetName}」范围未完整覆盖所选时段`, true);
      return false;
    }

    if (overlappingIndices.length === 1) {
      const tIv = firstIv;
      const exactMatch = Math.abs(tIv.xmin - t0) <= eps && Math.abs(tIv.xmax - t1) <= eps;
      if (exactMatch) {
        if (!copyText) {
          st.showToast(`目标层「${targetName}」已存在相同起止边界`);
          return false;
        }
        if (tIv.text === srcIv.text) {
          st.showToast(`目标层「${targetName}」文本已相同`);
          return false;
        }
        const ok = st.commitTgMutation(
          (_draft, ctx) => {
            const dTier = ctx.editTier(targetTierIdx);
            if (!dTier || dTier.kind !== 'intervalTier' || !dTier.intervals[firstIdx]) return false;
            dTier.intervals[firstIdx].text = srcIv.text;
          },
          { kind: 'interval', tierIndex: targetTierIdx, itemIndex: firstIdx },
          {
            type: 'copy-interval-span',
            title: '复制区间至层',
            detail: `${srcName} → ${targetName} · 含文本`,
            icon: 'projectToTier',
            tierName: targetName,
            focusTime: t0
          }
        );
        if (ok) get().showToast(`已复制文本至「${targetName}」`);
        return ok;
      }

      const hasLeft = t0 > tIv.xmin + eps;
      const hasRight = t1 < tIv.xmax - eps;
      const midOffset = hasLeft ? 1 : 0;

      const ok = st.commitTgMutation(
        (_draft, ctx) => {
          const dTier = ctx.editTier(targetTierIdx);
          if (!dTier || dTier.kind !== 'intervalTier') return false;
          const cur = dTier.intervals[firstIdx];
          if (!cur) return false;
          const replacement: Array<{ xmin: number; xmax: number; text: string }> = [];
          if (hasLeft) {
            replacement.push({ xmin: cur.xmin, xmax: t0, text: cur.text });
          }
          replacement.push({
            xmin: t0,
            xmax: t1,
            text: copyText ? srcIv.text : hasLeft ? '' : cur.text
          });
          if (hasRight) {
            replacement.push({ xmin: t1, xmax: cur.xmax, text: '' });
          }
          dTier.intervals.splice(firstIdx, 1, ...replacement);
        },
        { kind: 'interval', tierIndex: targetTierIdx, itemIndex: firstIdx + midOffset },
        {
          type: 'copy-interval-span',
          title: '复制区间至层',
          detail: `${srcName} → ${targetName} · ${copyText ? '含文本' : '仅边界'}`,
          icon: 'projectToTier',
          tierName: targetName,
          focusTime: t0
        }
      );
      if (ok) get().showToast(`已复制${copyText ? '区间及文本' : '区间边界'}至「${targetName}」`);
      return ok;
    }

    // Multiple overlapping intervals: only allow cleanly if all are empty & contiguous
    for (let k = firstIdx; k <= lastIdx; k++) {
      const iv = targetTier.intervals[k];
      if (iv.text.trim() !== '') {
        st.showToast(`目标层「${targetName}」该时段存在已标注区间冲突`, true);
        return false;
      }
      if (k < lastIdx && Math.abs(iv.xmax - targetTier.intervals[k + 1].xmin) > 1e-9) {
        st.showToast(`目标层「${targetName}」该时段存在区间空隙`, true);
        return false;
      }
    }

    const hasLeft = t0 > firstIv.xmin + eps;
    const hasRight = t1 < lastIv.xmax - eps;
    const midOffset = hasLeft ? 1 : 0;

    const ok = st.commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(targetTierIdx);
        if (!dTier || dTier.kind !== 'intervalTier') return false;
        const replacement: Array<{ xmin: number; xmax: number; text: string }> = [];
        if (hasLeft) replacement.push({ xmin: firstIv.xmin, xmax: t0, text: '' });
        replacement.push({ xmin: t0, xmax: t1, text: copyText ? srcIv.text : '' });
        if (hasRight) replacement.push({ xmin: t1, xmax: lastIv.xmax, text: '' });
        dTier.intervals.splice(firstIdx, lastIdx - firstIdx + 1, ...replacement);
      },
      { kind: 'interval', tierIndex: targetTierIdx, itemIndex: firstIdx + midOffset },
      {
        type: 'copy-interval-span',
        title: '复制区间至层',
        detail: `${srcName} → ${targetName} · ${copyText ? '含文本' : '仅边界'}`,
        icon: 'projectToTier',
        tierName: targetName,
        focusTime: t0
      }
    );
    if (ok) get().showToast(`已复制${copyText ? '区间及文本' : '区间边界'}至「${targetName}」`);
    return ok;
  },

  splitIntervalEqualN: (tierIndex, itemIndex, n) => {
    const st = get();
    const count = Math.floor(n);
    if (!Number.isFinite(count) || count < 2 || count > 20) {
      st.showToast('等分段数须在 2 至 20 之间', true);
      return false;
    }
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return false;
    const iv = tier.intervals[itemIndex];
    if (!iv || iv.xmax <= iv.xmin) return false;
    const step = (iv.xmax - iv.xmin) / count;
    if (step <= 1e-7) {
      st.showToast('区间时长过短，无法继续等分', true);
      return false;
    }

    const useRound = step >= 1e-4;
    const cuts: number[] = [iv.xmin];
    for (let k = 1; k < count; k++) {
      const rawT = iv.xmin + step * k;
      const t = useRound ? roundTimeClean(rawT) : rawT;
      if (t <= cuts[cuts.length - 1] || t >= iv.xmax) {
        st.showToast('区间时长过短，无法继续等分', true);
        return false;
      }
      cuts.push(t);
    }
    cuts.push(iv.xmax);

    const segs = Array.from({ length: count }, (_, k) => ({
      xmin: cuts[k],
      xmax: cuts[k + 1],
      text: k === 0 ? iv.text : ''
    }));
    const tierName = formatTierLabel(tier.name, tierIndex);

    const ok = st.commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(tierIndex);
        if (!dTier || dTier.kind !== 'intervalTier') return false;
        dTier.intervals.splice(itemIndex, 1, ...segs);
      },
      { kind: 'interval', tierIndex, itemIndex },
      {
        type: 'split-equal',
        title: '等分区间',
        detail: `${tierName} · 等分为 ${count} 段 (${formatTimeSpan(iv.xmin, iv.xmax)})`,
        icon: 'splitEqual',
        tierName,
        focusTime: iv.xmin
      }
    );
    if (ok) get().showToast(`已将区间等分为 ${count} 段`);
    return ok;
  },

  alignMicroBoundaries: (targetTierIndex, thresholdSec = 0.005) => {
    const st = get();
    const thresh = Math.max(1e-6, thresholdSec - 1e-9);
    const eps = 1e-12;
    const workingTiers = st.tg.tiers.map((t) => cloneTier(t));
    const dirtyTierSet = new Set<number>();
    let alignedCount = 0;
    let skippedPointCollision = 0;
    let skippedBoundConstraint = 0;

    type RefEntry = { t: number; tierIdx: number };

    const findBestRef = (t: number, refs: RefEntry[]): number | null => {
      let bestT: number | null = null;
      let bestDist = thresh;
      let bestPrio = Infinity;
      for (const r of refs) {
        const dist = Math.abs(r.t - t);
        if (dist <= eps || dist >= thresh) continue;
        if (
          dist < bestDist - eps ||
          (Math.abs(dist - bestDist) <= eps && r.tierIdx < bestPrio)
        ) {
          bestDist = dist;
          bestPrio = r.tierIdx;
          bestT = r.t;
        }
      }
      return bestT;
    };

    const collectTierRefs = (ti: number, refs: RefEntry[]) => {
      const tier = workingTiers[ti];
      if (!tier || tier.kind !== 'intervalTier') return;
      const seen = new Set<number>();
      const push = (t: number) => {
        if (!Number.isFinite(t) || seen.has(t)) return;
        seen.add(t);
        refs.push({ t, tierIdx: ti });
      };
      push(tier.xmin);
      push(tier.xmax);
      for (const iv of tier.intervals) {
        push(iv.xmin);
        push(iv.xmax);
      }
    };

    const alignIntervalTier = (ti: number, refs: RefEntry[]) => {
      const tier = workingTiers[ti];
      if (!tier || tier.kind !== 'intervalTier' || refs.length === 0) return;
      const interiorSet = new Set<number>();
      for (const iv of tier.intervals) {
        if (iv.xmin > tier.xmin + eps && iv.xmin < tier.xmax - eps) interiorSet.add(iv.xmin);
        if (iv.xmax > tier.xmin + eps && iv.xmax < tier.xmax - eps) interiorSet.add(iv.xmax);
      }
      const interiorTimes = Array.from(interiorSet).sort((a, b) => a - b);
      for (const oldT of interiorTimes) {
        const refT = findBestRef(oldT, refs);
        if (refT === null) continue;
        let minAllowed = tier.xmin;
        let maxAllowed = tier.xmax;
        for (const iv of tier.intervals) {
          if (Math.abs(iv.xmax - oldT) <= eps) minAllowed = Math.max(minAllowed, iv.xmin);
          if (Math.abs(iv.xmin - oldT) <= eps) maxAllowed = Math.min(maxAllowed, iv.xmax);
        }
        if (refT > minAllowed + 1e-9 && refT < maxAllowed - 1e-9) {
          for (const iv of tier.intervals) {
            if (Math.abs(iv.xmax - oldT) <= eps) iv.xmax = refT;
            if (Math.abs(iv.xmin - oldT) <= eps) iv.xmin = refT;
          }
          alignedCount++;
          dirtyTierSet.add(ti);
        } else {
          skippedBoundConstraint++;
        }
      }
    };

    const alignTextTier = (ti: number, refs: RefEntry[]) => {
      const tier = workingTiers[ti];
      if (!tier || tier.kind !== 'textTier' || refs.length === 0) return;
      let changed = false;
      for (let i = 0; i < tier.points.length; i++) {
        const pt = tier.points[i];
        const refT = findBestRef(pt.number, refs);
        if (refT === null) continue;
        if (refT < tier.xmin - eps || refT > tier.xmax + eps) {
          skippedBoundConstraint++;
          continue;
        }
        const collides = tier.points.some(
          (other, idx) => idx !== i && Math.abs(other.number - refT) <= eps
        );
        if (collides) {
          skippedPointCollision++;
          continue;
        }
        pt.number = refT;
        alignedCount++;
        changed = true;
      }
      if (changed) {
        tier.points.sort((a, b) => a.number - b.number);
        dirtyTierSet.add(ti);
      }
    };

    if (targetTierIndex !== undefined) {
      const targetTier = workingTiers[targetTierIndex];
      if (!targetTier) {
        return { aligned: 0, skippedPointCollision: 0, skippedBoundConstraint: 0 };
      }
      const refs: RefEntry[] = [];
      for (let ti = 0; ti < workingTiers.length; ti++) {
        if (ti === targetTierIndex) continue;
        collectTierRefs(ti, refs);
      }
      if (targetTier.kind === 'intervalTier') {
        alignIntervalTier(targetTierIndex, refs);
      } else {
        alignTextTier(targetTierIndex, refs);
      }
    } else {
      const refs: RefEntry[] = [];
      for (let ti = 0; ti < workingTiers.length; ti++) {
        if (workingTiers[ti].kind !== 'intervalTier') continue;
        alignIntervalTier(ti, refs);
        collectTierRefs(ti, refs);
      }
      for (let ti = 0; ti < workingTiers.length; ti++) {
        if (workingTiers[ti].kind !== 'textTier') continue;
        alignTextTier(ti, refs);
      }
    }

    if (alignedCount === 0) {
      return { aligned: 0, skippedPointCollision, skippedBoundConstraint };
    }

    const tierName =
      targetTierIndex !== undefined
        ? formatTierLabel(st.tg.tiers[targetTierIndex]?.name, targetTierIndex)
        : undefined;

    st.commitTgMutation(
      (d) => {
        for (const ti of dirtyTierSet) {
          if (d.tiers[ti]) d.tiers[ti] = workingTiers[ti];
        }
      },
      undefined,
      {
        type: 'align-micro-boundaries',
        title: '对齐微偏边界',
        detail: `${tierName ?? '全文档'} · 对齐 ${alignedCount} 处 (<5ms)`,
        icon: 'zeroCross',
        tierName
      }
    );
    return { aligned: alignedCount, skippedPointCollision, skippedBoundConstraint };
  },

  updateBlankTabDuration: (audioOffset, audioDuration) => {
    const st = get();
    if (!Number.isFinite(audioOffset) || !Number.isFinite(audioDuration) || audioDuration <= 0) {
      return false;
    }
    const activeTab = st.tabs.find((t) => t.id === st.activeTabId);
    if (
      !activeTab ||
      !activeTab.isBlankPlaceholder ||
      activeTab.isDirty ||
      st.history.entries.length > 0
    ) {
      return false;
    }
    for (const tier of activeTab.tg.tiers) {
      if (tier.kind === 'intervalTier') {
        if (tier.intervals.length > 1) return false;
        if (tier.intervals.length === 1 && tier.intervals[0].text !== '') return false;
      } else {
        if (tier.points.length > 0) return false;
      }
    }

    const nextMin = audioOffset;
    const nextMax = audioOffset + audioDuration;
    const nextTg: TextGrid = {
      ...activeTab.tg,
      xmin: nextMin,
      xmax: nextMax,
      tiers: activeTab.tg.tiers.map((tier) => {
        const cloned = cloneTier(tier);
        cloned.xmin = nextMin;
        cloned.xmax = nextMax;
        if (cloned.kind === 'intervalTier' && cloned.intervals.length === 1) {
          cloned.intervals[0].xmin = nextMin;
          cloned.intervals[0].xmax = nextMax;
        }
        return cloned;
      })
    };

    set((s) => {
      const nextCollection =
        s.collectionTgs.length > 0
          ? s.collectionTgs.map((item, i) => (i === s.collectionActiveIdx ? nextTg : item))
          : s.collectionTgs;
      const nextHistory: HistoryTimeline = {
        ...s.history,
        baseline: {
          ...s.history.baseline,
          detail: formatDocBaselineDetail(s.filename, nextTg),
          snapshot: {
            ...s.history.baseline.snapshot,
            tg: nextTg
          }
        }
      };
      const nextCollectionHistories =
        s.collectionTgs.length > 0
          ? { ...s.collectionHistories, [s.collectionActiveIdx]: nextHistory }
          : s.collectionHistories;
      const patch: Partial<TabRecord> = {
        tg: nextTg,
        collectionTgs: nextCollection,
        history: nextHistory,
        collectionHistories: nextCollectionHistories,
        viewDomain: null,
        currentTime: nextMin
      };
      return {
        ...syncActivePatch(s, patch),
        docVersion: s.docVersion + 1
      };
    });
    return true;
  },

  normalizeTextGrid: () => {
    const st = get();
    st.commitTgMutation(
      (draft, ctx) => {
        const gMin = draft.xmin;
        const gMax = draft.xmax;
        for (let ti = 0; ti < draft.tiers.length; ti++) {
          const tier = ctx.editTier(ti);
          if (!tier) continue;
          tier.xmin = gMin;
          tier.xmax = gMax;
          if (tier.kind === 'intervalTier') {
            tier.intervals.sort((a, b) => a.xmin - b.xmin || a.xmax - b.xmax);
            const clean = [];
            let cursor = gMin;
            for (const iv of tier.intervals) {
              if (!Number.isFinite(iv.xmin) || !Number.isFinite(iv.xmax)) continue;
              const a = Math.max(cursor, Math.min(gMax, iv.xmin));
              const b = Math.max(a, Math.min(gMax, iv.xmax));
              if (a > cursor) {
                clean.push({ xmin: cursor, xmax: a, text: '' });
                cursor = a;
              }
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
      },
      null,
      {
        type: 'normalize-tg',
        title: '规整边界与范围',
        detail: '统一各层起止并补齐连续区间',
        icon: 'normalize'
      }
    );
    st.showToast('已对齐各层范围并补齐连续区间');
  },

  moveTierBoundary: (tierIndex, oldT, newT, shared, opts) => {
    const st = get();
    if (shared) return st.moveSharedTimestamp(oldT, newT, opts);
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return false;
    const { minAllowed, maxAllowed } = getBoundaryBoundsForTier(tier, oldT);
    if (newT <= minAllowed - 1e-9 || newT >= maxAllowed + 1e-9) {
      st.showToast('边界不能越过相邻区间', true);
      return false;
    }
    const leftIdx = tier.intervals.findIndex((iv) => iv.xmax === oldT);
    const rightIdx = tier.intervals.findIndex((iv) => iv.xmin === oldT);
    const bndKey = leftIdx >= 0 ? `L${leftIdx}` : `R${rightIdx}`;
    const tierName = formatTierLabel(tier.name, tierIndex);
    const isZeroSnap = opts?.actionMeta?.type === 'snap-zero-crossing';

    const meta: HistoryActionMeta = isZeroSnap
      ? {
          type: 'snap-zero-crossing',
          title: '吸附过零点',
          detail: `${tierName} · ${formatTimeSec(oldT)} → ${formatTimeSec(newT)} (${formatDeltaTime(newT - oldT)})`,
          icon: 'zeroCross',
          tierName,
          focusTime: newT
        }
      : {
          type: 'move-boundary',
          title: '移动边界',
          detail: `${tierName} · ${formatTimeSec(oldT)} → ${formatTimeSec(newT)} (${formatDeltaTime(newT - oldT)})`,
          icon: 'nudgeBoundary',
          tierName,
          focusTime: newT,
          coalesce:
            opts?.coalesce === false
              ? undefined
              : {
                  key: `move-bnd:${tierIndex}:${bndKey}`,
                  originValue: oldT,
                  latestValue: newT,
                  chainPrevLatest: oldT,
                  formatMergedDetail: (orig, latest, count) => {
                    const o = Number(orig);
                    const l = Number(latest);
                    return `${tierName} · ${formatTimeSec(o)} → ${formatTimeSec(l)} (${formatDeltaTime(l - o)}${count > 1 ? ` · ${count}次` : ''})`;
                  }
                }
        };

    return st.commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(tierIndex);
        if (!dTier || dTier.kind !== 'intervalTier') return false;
        let touched = false;
        for (const iv of dTier.intervals) {
          if (iv.xmax === oldT) {
            iv.xmax = newT;
            touched = true;
          }
          if (iv.xmin === oldT) {
            iv.xmin = newT;
            touched = true;
          }
        }
        if (!touched) return false;
        if (opts?.nextSelection !== undefined) {
          ctx.setNextSelection(opts.nextSelection);
        }
      },
      undefined,
      meta
    );
  },

  moveSharedTimestamp: (oldT, newT, opts) => {
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

    const isZeroSnap = opts?.actionMeta?.type === 'snap-zero-crossing';
    const meta: HistoryActionMeta = isZeroSnap
      ? {
          type: 'snap-zero-crossing',
          title: '吸附过零点',
          detail: `跨层对齐 · ${formatTimeSec(oldT)} → ${formatTimeSec(newT)} (${formatDeltaTime(newT - oldT)})`,
          icon: 'zeroCross',
          focusTime: newT
        }
      : {
          type: 'move-shared-boundary',
          title: '跨层移动边界',
          detail: `对齐时刻 · ${formatTimeSec(oldT)} → ${formatTimeSec(newT)} (${formatDeltaTime(newT - oldT)})`,
          icon: 'nudgeShared',
          focusTime: newT,
          coalesce:
            opts?.coalesce === false
              ? undefined
              : {
                  key: 'move-shared',
                  originValue: oldT,
                  latestValue: newT,
                  chainPrevLatest: oldT,
                  formatMergedDetail: (orig, latest, count) => {
                    const o = Number(orig);
                    const l = Number(latest);
                    return `对齐时刻 · ${formatTimeSec(o)} → ${formatTimeSec(l)} (${formatDeltaTime(l - o)}${count > 1 ? ` · ${count}次` : ''})`;
                  }
                }
        };

    return st.commitTgMutation(
      (draft, ctx) => {
        let changed = false;
        if (draft.xmin === oldT && newT <= draft.xmax) {
          draft.xmin = newT;
          changed = true;
        }
        if (draft.xmax === oldT && newT >= draft.xmin) {
          draft.xmax = newT;
          changed = true;
        }
        for (let ti = 0; ti < draft.tiers.length; ti++) {
          const origTier = draft.tiers[ti];
          const hitsBound =
            (origTier.xmin === oldT && newT <= origTier.xmax) ||
            (origTier.xmax === oldT && newT >= origTier.xmin);
          const hitsItem =
            origTier.kind === 'intervalTier'
              ? origTier.intervals.some((iv) => iv.xmax === oldT || iv.xmin === oldT)
              : origTier.points.some((pt) => pt.number === oldT);
          if (!hitsBound && !hitsItem) continue;

          const tier = ctx.editTier(ti);
          if (!tier) continue;
          if (tier.xmin === oldT && newT <= tier.xmax) {
            tier.xmin = newT;
            changed = true;
          }
          if (tier.xmax === oldT && newT >= tier.xmin) {
            tier.xmax = newT;
            changed = true;
          }
          if (tier.kind === 'intervalTier') {
            for (const iv of tier.intervals) {
              if (iv.xmax === oldT) {
                iv.xmax = newT;
                changed = true;
              }
              if (iv.xmin === oldT) {
                iv.xmin = newT;
                changed = true;
              }
            }
          } else {
            for (const pt of tier.points) {
              if (pt.number === oldT) {
                pt.number = newT;
                changed = true;
              }
            }
            tier.points.sort((a, b) => a.number - b.number);
          }
        }
        if (!changed) return false;
        if (opts?.nextSelection !== undefined) {
          ctx.setNextSelection(opts.nextSelection);
        }
      },
      undefined,
      meta
    );
  }
}));
