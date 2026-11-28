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
import {
  buildCharSplitIntervals,
  buildDelimiterSplitIntervals,
  buildEqualIntervals,
  resolveSplitSourceText,
  type CharSplitOptions,
  type DelimiterSplitOptions,
  type EqualSplitSegment
} from '../utils/intervalSplit';
import {
  applyBlockTransformToDraft,
  clampBlockTargetSpan,
  computeBlockSafeBounds,
  findAlignedBlock,
  type BlockTransformMode
} from '../utils/blockTransform';
import {
  analyzeMultiSelection,
  applyAlignMultiSelectionBounds,
  applyClearMultiSelectionText,
  applyMergeContiguousSelection,
  applyMultiSyncDelta,
  sanitizeIntervalRefs,
  type IntervalRef,
  type MultiSyncAction
} from '../utils/multiSelection';
import { getPlatformBridge } from '../bridge/PlatformBridge';
import { isValidPraatTrigraphAt } from '../layout/praatTrigraphCodes';
import { decodeTrigraphGlossSync, primeTrigraphString } from '../layout/richText';
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

export type FloatingBarTarget = 'interval' | 'multi' | 'boundary' | 'point' | 'tier';
export type FloatingBarPresetKey = 'full' | 'compact' | 'minimal';
export type FloatingBarDensity = 'compact' | 'standard' | 'numeric';

export interface FloatingBarItemMeta {
  id: string;
  label: string;
  previewLabel: string;
  compactLabel?: string;
  defaultVisible: boolean;
}

export interface FloatingBarSectionConfig {
  order: string[];
  hidden: string[];
}

export type FloatingBarConfig = Record<FloatingBarTarget, FloatingBarSectionConfig>;

const FLOATING_BAR_TARGETS: FloatingBarTarget[] = ['interval', 'multi', 'boundary', 'point', 'tier'];

export const FLOATING_BAR_CATALOG: Record<FloatingBarTarget, FloatingBarItemMeta[]> = {
  interval: [
    { id: 'iv-play', label: '播放区间', previewLabel: '播放', compactLabel: '播放', defaultVisible: true },
    { id: 'iv-play-ctx', label: '前后试听 (±250ms)', previewLabel: '前后试听', compactLabel: '试听', defaultVisible: true },
    { id: 'iv-edit', label: '改字', previewLabel: '改字', compactLabel: '改字', defaultVisible: true },
    { id: 'iv-split', label: '智能拆分（含切分 / 等分）', previewLabel: '智能拆分', compactLabel: '拆分', defaultVisible: true },
    { id: 'iv-merge-left', label: '向左合并', previewLabel: '向左合并', compactLabel: '合左', defaultVisible: true },
    { id: 'iv-merge-right', label: '向右合并', previewLabel: '向右合并', compactLabel: '合右', defaultVisible: true },
    { id: 'iv-zoom', label: '放大 / 恢复全长', previewLabel: '放大', compactLabel: '放大', defaultVisible: true },
    { id: 'iv-copy-to-tier', label: '复制到层', previewLabel: '复制到层', compactLabel: '复制层', defaultVisible: false },
    { id: 'iv-copy-text', label: '复制文本', previewLabel: '复制文本', compactLabel: '复制', defaultVisible: false },
    { id: 'iv-clear', label: '清空文本', previewLabel: '清空', compactLabel: '清空', defaultVisible: false }
  ],
  multi: [
    { id: 'ml-merge', label: '合并所选区间', previewLabel: '合并 3 段', compactLabel: '合并', defaultVisible: true },
    { id: 'ml-align', label: '对齐边界（主选 / 合并 / 选区）', previewLabel: '对齐边界', compactLabel: '对齐', defaultVisible: true },
    { id: 'ml-play', label: '播放合并范围', previewLabel: '播放范围', compactLabel: '播放', defaultVisible: true },
    { id: 'ml-nudge', label: '整体左移 / 右移 5ms', previewLabel: '±5ms', compactLabel: '±5ms', defaultVisible: true },
    { id: 'ml-clear', label: '批量清空文本', previewLabel: '清空 (3)', compactLabel: '清空', defaultVisible: true },
    { id: 'ml-zoom', label: '放大查看范围', previewLabel: '放大', compactLabel: '放大', defaultVisible: false }
  ],
  boundary: [
    { id: 'bnd-zero', label: '吸附过零点', previewLabel: '吸附过零', compactLabel: '过零', defaultVisible: true },
    { id: 'bnd-link', label: '仅本层 / 联动对齐层', previewLabel: '仅本层 | 联动对齐层', compactLabel: '本层 | 联动', defaultVisible: true },
    { id: 'bnd-audition', label: '跨界试听 (±200ms)', previewLabel: '试听 ±200ms', compactLabel: '试听', defaultVisible: true },
    { id: 'bnd-project', label: '复制到其他层（含微偏对齐）', previewLabel: '复制到其他层', compactLabel: '复制层', defaultVisible: true },
    { id: 'bnd-delete', label: '删除边界', previewLabel: '删除边界', compactLabel: '删除', defaultVisible: true },
    { id: 'bnd-copy-time', label: '复制边界时刻', previewLabel: '复制时刻', compactLabel: '时刻', defaultVisible: false }
  ],
  point: [
    { id: 'pt-edit', label: '改字', previewLabel: '改字', compactLabel: '改字', defaultVisible: true },
    { id: 'pt-align', label: '对齐吸附（过零 / 边界 / 中点）', previewLabel: '对齐吸附', compactLabel: '吸附', defaultVisible: true },
    { id: 'pt-play-ctx', label: '前后试听 (±250ms)', previewLabel: '试听 ±250ms', compactLabel: '试听', defaultVisible: true },
    { id: 'pt-nudge', label: '微调时刻 (±5ms)', previewLabel: '±5ms', compactLabel: '±5ms', defaultVisible: true },
    { id: 'pt-delete', label: '删除标点', previewLabel: '删除', compactLabel: '删除', defaultVisible: true },
    { id: 'pt-snap-boundary', label: '对齐附近边界', previewLabel: '对齐边界', compactLabel: '对界', defaultVisible: false },
    { id: 'pt-move-mid', label: '移到区间中点', previewLabel: '区间中点', compactLabel: '中点', defaultVisible: false },
    { id: 'pt-play', label: '从此处向后播放', previewLabel: '向后播放', compactLabel: '播放', defaultVisible: false }
  ],
  tier: [
    { id: 'tier-name', label: '层名快编', previewLabel: '层名快编', compactLabel: '改名', defaultVisible: true },
    { id: 'tier-visibility', label: '隐藏 / 显示此层', previewLabel: '隐藏', compactLabel: '隐藏', defaultVisible: true },
    { id: 'tier-solo', label: '仅看此层 / 显示全部', previewLabel: '仅看此层', compactLabel: '仅看', defaultVisible: true },
    { id: 'tier-duplicate', label: '复制层（整层 / 仅边界）', previewLabel: '复制层', compactLabel: '复制', defaultVisible: true },
    { id: 'tier-move', label: '上移 / 下移', previewLabel: '上/下移', compactLabel: '移层', defaultVisible: true },
    { id: 'tier-clear', label: '清空整层文本', previewLabel: '清空文本', compactLabel: '清空', defaultVisible: false },
    { id: 'tier-delete', label: '删除层级', previewLabel: '删除层级', compactLabel: '删除', defaultVisible: false }
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
  multi: {
    order: FLOATING_BAR_CATALOG.multi.map((item) => item.id),
    hidden: FLOATING_BAR_CATALOG.multi.filter((item) => !item.defaultVisible).map((item) => item.id)
  },
  boundary: {
    order: FLOATING_BAR_CATALOG.boundary.map((item) => item.id),
    hidden: FLOATING_BAR_CATALOG.boundary.filter((item) => !item.defaultVisible).map((item) => item.id)
  },
  point: {
    order: FLOATING_BAR_CATALOG.point.map((item) => item.id),
    hidden: FLOATING_BAR_CATALOG.point.filter((item) => !item.defaultVisible).map((item) => item.id)
  },
  tier: {
    order: FLOATING_BAR_CATALOG.tier.map((item) => item.id),
    hidden: FLOATING_BAR_CATALOG.tier.filter((item) => !item.defaultVisible).map((item) => item.id)
  }
};

export const FLOATING_BAR_PRESETS: Record<FloatingBarPresetKey, FloatingBarConfig> = {
  full: {
    interval: buildFloatingBarSectionFromVisible(
      'interval',
      FLOATING_BAR_CATALOG.interval.map((item) => item.id)
    ),
    multi: buildFloatingBarSectionFromVisible(
      'multi',
      FLOATING_BAR_CATALOG.multi.map((item) => item.id)
    ),
    boundary: buildFloatingBarSectionFromVisible(
      'boundary',
      FLOATING_BAR_CATALOG.boundary.map((item) => item.id)
    ),
    point: buildFloatingBarSectionFromVisible(
      'point',
      FLOATING_BAR_CATALOG.point.map((item) => item.id)
    ),
    tier: buildFloatingBarSectionFromVisible(
      'tier',
      FLOATING_BAR_CATALOG.tier.map((item) => item.id)
    )
  },
  compact: {
    interval: buildFloatingBarSectionFromVisible(
      'interval',
      FLOATING_BAR_CATALOG.interval.filter((i) => i.defaultVisible).map((i) => i.id)
    ),
    multi: buildFloatingBarSectionFromVisible(
      'multi',
      FLOATING_BAR_CATALOG.multi.filter((i) => i.defaultVisible).map((i) => i.id)
    ),
    boundary: buildFloatingBarSectionFromVisible(
      'boundary',
      FLOATING_BAR_CATALOG.boundary.filter((i) => i.defaultVisible).map((i) => i.id)
    ),
    point: buildFloatingBarSectionFromVisible(
      'point',
      FLOATING_BAR_CATALOG.point.filter((i) => i.defaultVisible).map((i) => i.id)
    ),
    tier: buildFloatingBarSectionFromVisible(
      'tier',
      FLOATING_BAR_CATALOG.tier.filter((i) => i.defaultVisible).map((i) => i.id)
    )
  },
  minimal: {
    interval: buildFloatingBarSectionFromVisible('interval', ['iv-play', 'iv-edit', 'iv-split']),
    multi: buildFloatingBarSectionFromVisible('multi', ['ml-merge', 'ml-align', 'ml-play']),
    boundary: buildFloatingBarSectionFromVisible('boundary', ['bnd-zero', 'bnd-link', 'bnd-delete']),
    point: buildFloatingBarSectionFromVisible('point', ['pt-edit', 'pt-align', 'pt-delete']),
    tier: buildFloatingBarSectionFromVisible('tier', ['tier-name', 'tier-visibility', 'tier-move'])
  }
};

const FLOATING_BAR_STORAGE_KEY = 'tg_floating_bar_config';
const CUSTOM_SHORTCUTS_STORAGE_KEY = 'tg_custom_shortcuts';

function cloneFloatingBarConfig(cfg: FloatingBarConfig): FloatingBarConfig {
  return {
    interval: { order: [...cfg.interval.order], hidden: [...cfg.interval.hidden] },
    multi: { order: [...cfg.multi.order], hidden: [...cfg.multi.hidden] },
    boundary: { order: [...cfg.boundary.order], hidden: [...cfg.boundary.hidden] },
    point: { order: [...cfg.point.order], hidden: [...cfg.point.hidden] },
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

export interface TransformAlignedBlockOptions {
  mode?: BlockTransformMode;
  bandIndex?: number;
  silentToast?: boolean;
}

export interface TransformAlignedBlockResult {
  ok: boolean;
  changed: boolean;
  clamped: boolean;
  blockerTierName: string | null;
  affectedTierCount: number;
  finalXmin: number;
  finalXmax: number;
  reason?: 'invalid-anchor' | 'no-change' | 'blocked';
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
      | 'status'
      | 'hasTextGrid'
      | 'ipaPreview'
      | 'duration'
      | 'note'
      | 'updatedAt'
      | 'label'
      | 'missing'
      | 'parseError'
      | 'baseFingerprint'
    >
  >;
  pendingAutoEditTarget?: PendingAutoEditTarget | null;
  /** 强制抛弃缓存历史并重建干净基线（如单条还原为磁盘原文件时） */
  resetHistory?: boolean;
  /** 当草稿已存在但内存历史已被淘汰时，将新基线标记为未保存态 */
  initialDirty?: boolean;
}

export interface CorpusUnsavedStatePatch {
  unsavedItemIds?: string[];
  projectIndexDirty?: boolean;
  dirtyCount?: number;
  recoveryDegraded?: boolean;
  pendingRecoveryCount?: number;
  saveStatus?: CorpusProjectState['saveStatus'];
  lastSaveError?: string | null;
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
  multiSelection: IntervalRef[];
  lastActiveTierIndex: number;
  hiddenTierIndices: number[];
  playRange: { start: number; end: number } | null;
  currentTime: number;
  audioName: string;
  audioLoading: boolean;
  corpusSwitching: boolean;
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

export interface CloseTabsResult {
  removedTabIds: string[];
  removedSessionIds: number[];
  removedCorpusProjectIds: string[];
  nextActiveTabId: string;
  activeTabChanged: boolean;
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
  multiSelection: IntervalRef[];
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
  corpusSwitching: boolean;
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
  autoSwitchContextualRibbon: boolean;
  restoreSessionOnStartup: boolean;
  smartSplitUseAcoustic: boolean;
  corpusAutoSave: boolean;

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
  floatingBarDensity: FloatingBarDensity;
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
  closeTabsImmediate: (tabIds: string[], preferredActiveTabId?: string) => CloseTabsResult;
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
        | 'status'
        | 'hasTextGrid'
        | 'ipaPreview'
        | 'duration'
        | 'note'
        | 'updatedAt'
        | 'label'
        | 'missing'
        | 'parseError'
        | 'baseFingerprint'
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
  syncCorpusUnsavedState: (patch: CorpusUnsavedStatePatch, tabId?: string) => void;
  clearCorpusEntryHistory: (itemId: string, tabId?: string) => void;
  markCorpusEntryHistorySaved: (itemId: string, tabId?: string) => void;
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
  setCorpusSwitchingForTab: (tabId: string, switching: boolean) => void;

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
  toggleMultiSelectInterval: (tierIndex: number, itemIndex: number, bandIndex?: number) => void;
  setMultiSelection: (items: IntervalRef[], primary?: IntervalRef | null, bandIndex?: number) => void;
  setMultiSelectionPrimary: (ref: { tierIndex: number; itemIndex: number }) => void;
  removeFromMultiSelection: (ref: { tierIndex: number; itemIndex: number }) => void;
  clearMultiSelection: () => void;
  clearMultiSelectionText: () => boolean;
  mergeMultiSelection: () => boolean;
  alignMultiSelectionBounds: (
    mode: 'to-primary' | 'to-envelope' | 'to-range',
    customRange?: { start: number; end: number } | null
  ) => boolean;
  syncTransformMultiSelection: (
    action: MultiSyncAction,
    delta: number,
    opts?: { bandIndex?: number; silentToast?: boolean }
  ) => boolean;
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
  setAutoSwitchContextualRibbon: (v: boolean) => void;
  setRestoreSessionOnStartup: (enabled: boolean) => void;
  setSmartSplitUseAcoustic: (enabled: boolean) => void;
  setCorpusAutoSave: (enabled: boolean) => void;
  setFloatingBarDensity: (density: FloatingBarDensity) => void;
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
  movePointToTime: (
    tierIndex: number,
    pointIndex: number,
    targetTime: number,
    label?: string
  ) => boolean;
  updateIntervalBoundsWithAnchor: (
    tierIndex: number,
    itemIndex: number,
    patch: { xmin?: number; xmax?: number; duration?: number },
    anchor: 'start' | 'duration' | 'end',
    linkNeighbors?: boolean
  ) => boolean;
  convertSelectionIpa: (direction: 'to-unicode' | 'to-praat') => Promise<boolean>;
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
  splitIntervalWithCuts: (
    tierIndex: number,
    itemIndex: number,
    texts: readonly string[],
    cuts?: readonly number[] | null,
    meta?: { title?: string; detailPrefix?: string; toastLabel?: string }
  ) => boolean;
  replaceJustSplitInterval: (
    tierIndex: number,
    startItemIndex: number,
    prevCount: number,
    originalXmin: number,
    originalXmax: number,
    nextTexts: readonly string[],
    nextCuts?: readonly number[] | null,
    meta?: { title?: string; detailPrefix?: string; toastLabel?: string }
  ) => boolean;
  splitIntervalWithTexts: (
    tierIndex: number,
    itemIndex: number,
    texts: readonly string[],
    meta?: { title?: string; detailPrefix?: string; toastLabel?: string }
  ) => boolean;
  splitIntervalByChars: (
    tierIndex: number,
    itemIndex: number,
    options?: CharSplitOptions
  ) => boolean;
  splitIntervalByDelimiter: (
    tierIndex: number,
    itemIndex: number,
    options?: DelimiterSplitOptions
  ) => boolean;
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
  transformAlignedBlock: (
    anchorTierIndex: number,
    anchorItemIndex: number,
    targetXmin: number,
    targetXmax: number,
    opts?: TransformAlignedBlockOptions
  ) => TransformAlignedBlockResult;
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

const CORPUS_HISTORY_CACHE_MAX = 20;
const corpusHistoryCache = new Map<string, HistoryTimeline>();

function getCorpusHistoryCacheKey(tabId: string, itemId: string): string {
  return `${tabId}::${itemId}`;
}

function cacheCorpusEntryHistory(
  tabId: string,
  itemId: string,
  timeline: HistoryTimeline,
  protectedUnsavedIds?: readonly string[]
): void {
  const key = getCorpusHistoryCacheKey(tabId, itemId);
  corpusHistoryCache.delete(key);
  corpusHistoryCache.set(key, sealTimelineCoalesce(timeline));
  const protectedKeys = new Set<string>();
  if (protectedUnsavedIds && protectedUnsavedIds.length > 0) {
    for (const uid of protectedUnsavedIds) {
      protectedKeys.add(getCorpusHistoryCacheKey(tabId, uid));
    }
  }
  while (corpusHistoryCache.size > CORPUS_HISTORY_CACHE_MAX) {
    let victimKey: string | undefined;
    for (const [candidateKey, candidateTl] of corpusHistoryCache.entries()) {
      if (candidateKey === key) continue;
      if (!isTimelineDirty(candidateTl) && !protectedKeys.has(candidateKey)) {
        victimKey = candidateKey;
        break;
      }
    }
    if (victimKey === undefined) {
      for (const candidateKey of corpusHistoryCache.keys()) {
        if (candidateKey !== key) {
          victimKey = candidateKey;
          break;
        }
      }
    }
    if (victimKey === undefined) break;
    corpusHistoryCache.delete(victimKey);
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

function deleteCachedCorpusEntryHistory(tabId: string, itemId: string): void {
  corpusHistoryCache.delete(getCorpusHistoryCacheKey(tabId, itemId));
}

function markCachedCorpusEntryHistorySaved(tabId: string, itemId: string): void {
  const key = getCorpusHistoryCacheKey(tabId, itemId);
  const found = corpusHistoryCache.get(key);
  if (!found) return;
  corpusHistoryCache.set(key, markTimelineSaved(found));
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
    multiSelection: [],
    lastActiveTierIndex: 0,
    hiddenTierIndices: [],
    playRange: null,
    currentTime: Number.isFinite(tg.xmin) ? tg.xmin : 0,
    audioName: '',
    audioLoading: false,
    corpusSwitching: false,
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
    multiSelection: tab.multiSelection,
    lastActiveTierIndex: tab.lastActiveTierIndex,
    hiddenTierIndices: tab.hiddenTierIndices,
    playRange: tab.playRange,
    currentTime: tab.currentTime,
    audioName: tab.audioName,
    audioLoading: tab.audioLoading,
    corpusSwitching: tab.corpusSwitching,
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
const SMART_SPLIT_ACOUSTIC_STORAGE_KEY = 'tg_smart_split_acoustic_v1';
const AUTO_SWITCH_CTX_RIBBON_STORAGE_KEY = 'tg_auto_ctx_ribbon_v1';
const CORPUS_AUTO_SAVE_STORAGE_KEY = 'tg_corpus_auto_save_v1';
const FLOATING_BAR_DENSITY_STORAGE_KEY = 'tg_floating_bar_density_v1';

function loadCorpusAutoSave(): boolean {
  try {
    return localStorage.getItem(CORPUS_AUTO_SAVE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveCorpusAutoSave(enabled: boolean): void {
  try {
    localStorage.setItem(CORPUS_AUTO_SAVE_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore storage errors
  }
}

function loadFloatingBarDensity(): FloatingBarDensity {
  try {
    const raw = localStorage.getItem(FLOATING_BAR_DENSITY_STORAGE_KEY);
    if (raw === 'compact' || raw === 'standard' || raw === 'numeric') {
      return raw;
    }
  } catch {
    // ignore storage errors
  }
  return 'standard';
}

function saveFloatingBarDensity(density: FloatingBarDensity): void {
  try {
    localStorage.setItem(FLOATING_BAR_DENSITY_STORAGE_KEY, density);
  } catch {
    // ignore storage errors
  }
}

function loadAutoSwitchContextualRibbon(): boolean {
  try {
    return localStorage.getItem(AUTO_SWITCH_CTX_RIBBON_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function saveAutoSwitchContextualRibbon(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_SWITCH_CTX_RIBBON_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore storage errors
  }
}

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

function loadSmartSplitUseAcoustic(): boolean {
  try {
    return localStorage.getItem(SMART_SPLIT_ACOUSTIC_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function saveSmartSplitUseAcoustic(enabled: boolean): void {
  try {
    localStorage.setItem(SMART_SPLIT_ACOUSTIC_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore storage errors
  }
}

function buildIntervalsFromCuts(
  xmin: number,
  xmax: number,
  texts: readonly string[],
  cuts?: readonly number[] | null
): EqualSplitSegment[] | null {
  const count = texts.length;
  if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || xmax <= xmin || count < 2) {
    return null;
  }
  if (cuts && cuts.length === count - 1) {
    let valid = true;
    let prev = xmin;
    for (let i = 0; i < cuts.length; i++) {
      const t = cuts[i];
      if (!Number.isFinite(t) || t <= prev || t >= xmax) {
        valid = false;
        break;
      }
      prev = t;
    }
    if (valid) {
      return Array.from({ length: count }, (_, k) => ({
        xmin: k === 0 ? xmin : cuts[k - 1],
        xmax: k === count - 1 ? xmax : cuts[k],
        text: texts[k]
      }));
    }
  }
  return buildEqualIntervals(xmin, xmax, texts);
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
  if (tier.kind === 'intervalTier' && tier.intervals.length > 0) {
    const firstIv = tier.intervals[0];
    const lastIv = tier.intervals[tier.intervals.length - 1];
    if (Math.abs(oldT - tier.xmin) <= 1e-9) {
      // Outer start edge: only non-empty first interval may pull inward (rightward)
      if (firstIv && Math.abs(firstIv.xmin - oldT) <= 1e-9 && firstIv.text.trim() !== '') {
        return { minAllowed: tier.xmin, maxAllowed: firstIv.xmax - 1e-6 };
      }
      return { minAllowed: -Infinity, maxAllowed: Infinity };
    }
    if (Math.abs(oldT - tier.xmax) <= 1e-9) {
      // Outer end edge: only non-empty last interval may pull inward (leftward)
      if (lastIv && Math.abs(lastIv.xmax - oldT) <= 1e-9 && lastIv.text.trim() !== '') {
        return { minAllowed: lastIv.xmin + 1e-6, maxAllowed: tier.xmax };
      }
      return { minAllowed: -Infinity, maxAllowed: Infinity };
    }
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
  autoSwitchContextualRibbon: loadAutoSwitchContextualRibbon(),
  restoreSessionOnStartup: loadRestoreSessionOnStartup(),
  smartSplitUseAcoustic: loadSmartSplitUseAcoustic(),
  corpusAutoSave: loadCorpusAutoSave(),

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
  floatingBarDensity: loadFloatingBarDensity(),
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

  closeTabsImmediate: (tabIds, preferredActiveTabId) => {
    const cur = get();
    const removeSet = new Set(tabIds);
    const toRemove = cur.tabs.filter((t) => removeSet.has(t.id));
    if (toRemove.length === 0) {
      return {
        removedTabIds: [],
        removedSessionIds: [],
        removedCorpusProjectIds: [],
        nextActiveTabId: cur.activeTabId,
        activeTabChanged: false
      };
    }

    const removedTabIds: string[] = [];
    const removedSessionIds: number[] = [];
    const removedCorpusProjectIds: string[] = [];
    for (const target of toRemove) {
      removedTabIds.push(target.id);
      if (target.analysis?.sessionId !== undefined && target.analysis?.sessionId !== null) {
        removedSessionIds.push(target.analysis.sessionId);
      }
      if (target.kind === 'corpus' && target.corpus?.projectId) {
        removedCorpusProjectIds.push(target.corpus.projectId);
      }
      clearCorpusHistoryCacheForTab(target.id);
    }

    const remaining = cur.tabs.filter((t) => !removeSet.has(t.id));
    if (remaining.length === 0) {
      const fresh = createTabRecord({ isBlankPlaceholder: true }, cur.historyLimit);
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
        removedTabIds,
        removedSessionIds,
        removedCorpusProjectIds,
        nextActiveTabId: fresh.id,
        activeTabChanged: true
      };
    }

    const preferredTab = preferredActiveTabId
      ? remaining.find((t) => t.id === preferredActiveTabId) ?? null
      : null;
    const activeStillPresent = remaining.some((t) => t.id === cur.activeTabId);

    if (!preferredTab && activeStillPresent) {
      set({ tabs: remaining });
      return {
        removedTabIds,
        removedSessionIds,
        removedCorpusProjectIds,
        nextActiveTabId: cur.activeTabId,
        activeTabChanged: false
      };
    }

    const oldActiveIdx = cur.tabs.findIndex((t) => t.id === cur.activeTabId);
    const nextActive =
      preferredTab ?? remaining[Math.min(Math.max(0, oldActiveIdx), remaining.length - 1)];
    const activeTabChanged = nextActive.id !== cur.activeTabId;

    if (!activeTabChanged) {
      set({ tabs: remaining });
      return {
        removedTabIds,
        removedSessionIds,
        removedCorpusProjectIds,
        nextActiveTabId: nextActive.id,
        activeTabChanged: false
      };
    }

    set((s) => {
      const smartMaxFreq =
        !s.maxFreqUserSet && nextActive.audioSampleRate > 0
          ? ((nextActive.audioSampleRate >= 16000 ? 8000 : 5000) as 5000 | 8000 | 10000)
          : s.maxFreq;
      return {
        tabs: remaining,
        ...fieldsFromTab(nextActive),
        ...(nextActive.kind !== 'corpus' && s.ribbonTab === 'corpus'
          ? { ribbonTab: 'annotate' as RibbonTabId }
          : {}),
        pendingAutoEditTarget: null,
        maxFreq: smartMaxFreq,
        showPlayhead: false,
        playing: false,
        docVersion: s.docVersion + 1
      };
    });

    return {
      removedTabIds,
      removedSessionIds,
      removedCorpusProjectIds,
      nextActiveTabId: nextActive.id,
      activeTabChanged: true
    };
  },

  getDirtyTabs: () =>
    get().tabs.filter((t) => {
      if (t.isDirty) return true;
      if (t.kind === 'corpus' && t.corpus) {
        const ext = t.corpus as CorpusProjectState & {
          unsavedItemIds?: string[];
          projectIndexDirty?: boolean;
        };
        if ((ext.unsavedItemIds?.length ?? 0) > 0 || Boolean(ext.projectIndexDirty)) {
          return true;
        }
      }
      return false;
    }),

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
      const unsavedIds = (
        target.corpus as CorpusProjectState & { unsavedItemIds?: string[] }
      ).unsavedItemIds;
      if (prevActiveId && prevActiveId !== payload.itemId) {
        const prevHistory = target.id === s.activeTabId ? s.history : target.history;
        cacheCorpusEntryHistory(target.id, prevActiveId, prevHistory, unsavedIds);
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
      if (payload.resetHistory) {
        deleteCachedCorpusEntryHistory(target.id, payload.itemId);
      } else {
        const cachedHistory = getCachedCorpusEntryHistory(target.id, payload.itemId);
        if (cachedHistory) {
          const cachedSnap = getCurrentSnapshot(cachedHistory);
          if (JSON.stringify(cachedSnap.tg) === JSON.stringify(payload.tg)) {
            nextHistory = sealTimelineCoalesce(cachedHistory);
          }
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
        if (payload.initialDirty) {
          nextHistory = { ...nextHistory, savedEntryId: null };
        }
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
        corpusSwitching: false,
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

  syncCorpusUnsavedState: (patch, tabId) =>
    set((s) => {
      const targetTabId = tabId ?? s.activeTabId;
      const target = s.tabs.find((t) => t.id === targetTabId);
      if (!target || target.kind !== 'corpus' || !target.corpus) return s;
      const nextCorpus = {
        ...target.corpus,
        ...patch
      } as CorpusProjectState;
      return {
        tabs: s.tabs.map((t) => (t.id === targetTabId ? { ...t, corpus: nextCorpus } : t))
      };
    }),

  clearCorpusEntryHistory: (itemId, tabId) => {
    const targetTabId = tabId ?? get().activeTabId;
    deleteCachedCorpusEntryHistory(targetTabId, itemId);
  },

  markCorpusEntryHistorySaved: (itemId, tabId) => {
    const targetTabId = tabId ?? get().activeTabId;
    markCachedCorpusEntryHistorySaved(targetTabId, itemId);
  },

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

  setCorpusSwitchingForTab: (tabId, switching) =>
    set((s) => {
      const target = s.tabs.find((t) => t.id === tabId);
      if (!target || target.corpusSwitching === switching) return s;
      const nextTabs = s.tabs.map((t) => (t.id === tabId ? { ...t, corpusSwitching: switching } : t));
      if (tabId === s.activeTabId) {
        return { tabs: nextTabs, corpusSwitching: switching };
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
        multiSelection: [],
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
          ? {
              selection,
              multiSelection: [],
              lastActiveTierIndex: clampTierIndex(ti, s.tg.tiers.length)
            }
          : { selection, multiSelection: [] };
      return syncActivePatch(s, patch);
    }),

  toggleMultiSelectInterval: (tierIndex, itemIndex, bandIndex) =>
    set((s) => {
      const tier = s.tg.tiers[tierIndex];
      const iv = tier?.kind === 'intervalTier' ? tier.intervals[itemIndex] : null;
      if (!tier || !iv || iv.xmax <= iv.xmin) return s;

      const cur = sanitizeIntervalRefs(s.tg, s.multiSelection);
      const nextBand = bandIndex ?? s.selection?.bandIndex ?? 0;

      if (cur.length < 2) {
        if (
          s.selection?.kind === 'interval' &&
          (s.selection.tierIndex !== tierIndex || s.selection.itemIndex !== itemIndex)
        ) {
          const prevTier = s.tg.tiers[s.selection.tierIndex];
          const prevIv =
            prevTier?.kind === 'intervalTier' ? prevTier.intervals[s.selection.itemIndex] : null;
          if (prevIv && prevIv.xmax > prevIv.xmin) {
            const nextMulti = sanitizeIntervalRefs(s.tg, [
              { tierIndex: s.selection.tierIndex, itemIndex: s.selection.itemIndex },
              { tierIndex, itemIndex }
            ]);
            return syncActivePatch(s, {
              selection: { kind: 'interval', tierIndex, itemIndex, bandIndex: nextBand },
              multiSelection: nextMulti,
              lastActiveTierIndex: clampTierIndex(tierIndex, s.tg.tiers.length)
            });
          }
        }
        return syncActivePatch(s, {
          selection: { kind: 'interval', tierIndex, itemIndex, bandIndex: nextBand },
          multiSelection: [],
          lastActiveTierIndex: clampTierIndex(tierIndex, s.tg.tiers.length)
        });
      }

      const existsIdx = cur.findIndex(
        (it) => it.tierIndex === tierIndex && it.itemIndex === itemIndex
      );
      if (existsIdx !== -1) {
        const remaining = cur.filter((_, idx) => idx !== existsIdx);
        if (remaining.length <= 1) {
          const only = remaining[0];
          return syncActivePatch(s, {
            selection: only
              ? {
                  kind: 'interval',
                  tierIndex: only.tierIndex,
                  itemIndex: only.itemIndex,
                  bandIndex: nextBand
                }
              : null,
            multiSelection: [],
            lastActiveTierIndex: only
              ? clampTierIndex(only.tierIndex, s.tg.tiers.length)
              : s.lastActiveTierIndex
          });
        }
        const wasPrimary =
          s.selection?.kind === 'interval' &&
          s.selection.tierIndex === tierIndex &&
          s.selection.itemIndex === itemIndex;
        const nextPrimary = wasPrimary ? remaining[remaining.length - 1] : null;
        return syncActivePatch(s, {
          selection: nextPrimary
            ? {
                kind: 'interval',
                tierIndex: nextPrimary.tierIndex,
                itemIndex: nextPrimary.itemIndex,
                bandIndex: nextBand
              }
            : s.selection,
          multiSelection: remaining
        });
      }

      const appended = [...cur, { tierIndex, itemIndex }];
      return syncActivePatch(s, {
        selection: { kind: 'interval', tierIndex, itemIndex, bandIndex: nextBand },
        multiSelection: appended,
        lastActiveTierIndex: clampTierIndex(tierIndex, s.tg.tiers.length)
      });
    }),

  setMultiSelection: (items, primary, bandIndex) =>
    set((s) => {
      const clean = sanitizeIntervalRefs(s.tg, items);
      const nextBand = bandIndex ?? s.selection?.bandIndex ?? 0;
      if (clean.length === 0) {
        return syncActivePatch(s, { multiSelection: [] });
      }
      if (clean.length === 1) {
        const only = clean[0];
        return syncActivePatch(s, {
          selection: {
            kind: 'interval',
            tierIndex: only.tierIndex,
            itemIndex: only.itemIndex,
            bandIndex: nextBand
          },
          multiSelection: [],
          lastActiveTierIndex: clampTierIndex(only.tierIndex, s.tg.tiers.length)
        });
      }
      const p =
        (primary &&
          clean.find(
            (it) => it.tierIndex === primary.tierIndex && it.itemIndex === primary.itemIndex
          )) ||
        clean[clean.length - 1];
      return syncActivePatch(s, {
        selection: {
          kind: 'interval',
          tierIndex: p.tierIndex,
          itemIndex: p.itemIndex,
          bandIndex: nextBand
        },
        multiSelection: clean,
        lastActiveTierIndex: clampTierIndex(p.tierIndex, s.tg.tiers.length)
      });
    }),

  setMultiSelectionPrimary: (ref) =>
    set((s) => {
      const clean = sanitizeIntervalRefs(s.tg, s.multiSelection);
      if (clean.length < 2) return s;
      const found = clean.find(
        (it) => it.tierIndex === ref.tierIndex && it.itemIndex === ref.itemIndex
      );
      if (!found) return s;
      const nextBand = s.selection?.bandIndex ?? 0;
      return syncActivePatch(s, {
        selection: {
          kind: 'interval',
          tierIndex: found.tierIndex,
          itemIndex: found.itemIndex,
          bandIndex: nextBand
        },
        multiSelection: clean,
        lastActiveTierIndex: clampTierIndex(found.tierIndex, s.tg.tiers.length)
      });
    }),

  removeFromMultiSelection: (ref) =>
    set((s) => {
      const clean = sanitizeIntervalRefs(s.tg, s.multiSelection);
      if (clean.length === 0) return s;
      const remaining = clean.filter(
        (it) => !(it.tierIndex === ref.tierIndex && it.itemIndex === ref.itemIndex)
      );
      if (remaining.length === clean.length) return s;
      const nextBand = s.selection?.bandIndex ?? 0;
      if (remaining.length <= 1) {
        const only = remaining[0];
        return syncActivePatch(s, {
          selection: only
            ? {
                kind: 'interval',
                tierIndex: only.tierIndex,
                itemIndex: only.itemIndex,
                bandIndex: nextBand
              }
            : null,
          multiSelection: [],
          lastActiveTierIndex: only
            ? clampTierIndex(only.tierIndex, s.tg.tiers.length)
            : s.lastActiveTierIndex
        });
      }
      const wasPrimary =
        s.selection?.kind === 'interval' &&
        s.selection.tierIndex === ref.tierIndex &&
        s.selection.itemIndex === ref.itemIndex;
      const nextPrimary = wasPrimary ? remaining[remaining.length - 1] : null;
      return syncActivePatch(s, {
        selection: nextPrimary
          ? {
              kind: 'interval',
              tierIndex: nextPrimary.tierIndex,
              itemIndex: nextPrimary.itemIndex,
              bandIndex: nextBand
            }
          : s.selection,
        multiSelection: remaining,
        lastActiveTierIndex: nextPrimary
          ? clampTierIndex(nextPrimary.tierIndex, s.tg.tiers.length)
          : s.lastActiveTierIndex
      });
    }),

  clearMultiSelection: () =>
    set((s) => (s.multiSelection.length === 0 ? s : syncActivePatch(s, { multiSelection: [] }))),

  clearMultiSelectionText: () => {
    const st = get();
    const clean = sanitizeIntervalRefs(st.tg, st.multiSelection);
    if (clean.length < 2) return false;
    let clearedCount = 0;
    const primarySel = st.selection;
    const committed = st.commitTgMutation(
      (_draft, ctx) => {
        const res = applyClearMultiSelectionText(ctx.editTier, clean);
        clearedCount = res.clearedCount;
        return res.changed;
      },
      primarySel,
      {
        type: 'multi-clear-text',
        title: '批量清空文本',
        detail: `已清空 ${clean.length} 项所选区间`,
        icon: 'clear'
      }
    );
    if (!committed) {
      st.showToast('所选区间均为空白');
      return false;
    }
    const primaryRef =
      primarySel?.kind === 'interval'
        ? { tierIndex: primarySel.tierIndex, itemIndex: primarySel.itemIndex }
        : null;
    get().setMultiSelection(clean, primaryRef, primarySel?.bandIndex);
    st.showToast(`已清空 ${clearedCount} 项区间文本`);
    return true;
  },

  mergeMultiSelection: () => {
    const st = get();
    const primaryRef =
      st.selection?.kind === 'interval'
        ? { tierIndex: st.selection.tierIndex, itemIndex: st.selection.itemIndex }
        : null;
    const analysis = analyzeMultiSelection(st.tg, st.multiSelection, primaryRef, st.playRange);
    if (!analysis.capabilities.canMerge) {
      st.showToast('仅支持合并同一层内的连续复选区间', true);
      return false;
    }
    const tier = st.tg.tiers[analysis.units[0].tierIndex];
    const tierName = formatTierLabel(tier?.name, analysis.units[0].tierIndex);
    const bandIndex = st.selection?.bandIndex ?? 0;
    let mergedCount = 0;
    const committed = st.commitTgMutation(
      (_draft, ctx) => {
        const res = applyMergeContiguousSelection(ctx.editTier, analysis);
        if (!res.changed) return false;
        mergedCount = res.mergedCount;
        ctx.setNextSelection({
          kind: 'interval',
          tierIndex: res.tierIndex,
          itemIndex: res.mergedItemIndex,
          bandIndex
        });
        ctx.setNextPlayRange({ start: analysis.envelopeXmin, end: analysis.envelopeXmax });
      },
      undefined,
      {
        type: 'multi-merge',
        title: `合并所选区间 (${analysis.count} 段)`,
        detail: `${tierName} · ${formatTimeSpan(analysis.envelopeXmin, analysis.envelopeXmax)}`,
        icon: 'mergeRight',
        tierName,
        focusTime: analysis.envelopeXmin
      }
    );
    if (committed) {
      st.showToast(`已合并 ${mergedCount} 段连续区间`);
    }
    return committed;
  },

  alignMultiSelectionBounds: (mode, customRange) => {
    const st = get();
    const primaryRef =
      st.selection?.kind === 'interval'
        ? { tierIndex: st.selection.tierIndex, itemIndex: st.selection.itemIndex }
        : null;
    const analysis = analyzeMultiSelection(st.tg, st.multiSelection, primaryRef, st.playRange);
    if (analysis.count < 2) return false;
    if (mode === 'to-range' && (!customRange || customRange.end - customRange.start < 0.001)) {
      return false;
    }

    let result = {
      changed: false,
      nextItems: analysis.items,
      affectedTierCount: 0,
      clampedCount: 0,
      blockerTierName: null as string | null,
      targetXmin: analysis.envelopeXmin,
      targetXmax: analysis.envelopeXmax
    };
    const title =
      mode === 'to-range'
        ? '重映射所选区间到选区'
        : mode === 'to-primary'
          ? '对齐所选区间至主选边界'
          : '对齐所选区间至整体范围';
    const bandIndex = st.selection?.bandIndex ?? 0;

    const committed = st.commitTgMutation(
      (_draft, ctx) => {
        result = applyAlignMultiSelectionBounds(ctx.editTier, st.tg, analysis, mode, customRange);
        if (!result.changed) return false;
        const firstNext = result.nextItems[0];
        if (firstNext) {
          ctx.setNextSelection({
            kind: 'interval',
            tierIndex: firstNext.tierIndex,
            itemIndex: firstNext.itemIndex,
            bandIndex
          });
        }
        ctx.setNextPlayRange({ start: result.targetXmin, end: result.targetXmax });
      },
      undefined,
      {
        type: mode === 'to-range' ? 'remap-block' : 'multi-align',
        title,
        detail: `${analysis.count} 项 · ${formatTimeSpan(result.targetXmin, result.targetXmax)}`,
        icon: 'nudgeShared',
        focusTime: result.targetXmin
      }
    );
    if (!committed) {
      if (result.clampedCount > 0 && result.blockerTierName) {
        st.showToast(`受「${result.blockerTierName}」相邻非空区间阻挡，无法对齐`, true);
      } else {
        st.showToast('所选区间边界已对齐');
      }
      return false;
    }

    get().setMultiSelection(result.nextItems, result.nextItems[0] ?? null, bandIndex);
    if (result.clampedCount > 0 && result.blockerTierName) {
      st.showToast(`受「${result.blockerTierName}」阻挡，其余区间已对齐至安全范围`);
    } else if (mode === 'to-range') {
      st.showToast(
        `已将所选 ${analysis.count} 项重映射到 ${formatTimeSpan(result.targetXmin, result.targetXmax)}`
      );
    } else {
      st.showToast(`已对齐 ${result.affectedTierCount} 层所选区间边界`);
    }
    return true;
  },

  syncTransformMultiSelection: (action, delta, opts) => {
    const st = get();
    const primaryRef =
      st.selection?.kind === 'interval'
        ? { tierIndex: st.selection.tierIndex, itemIndex: st.selection.itemIndex }
        : null;
    const analysis = analyzeMultiSelection(st.tg, st.multiSelection, primaryRef, st.playRange);
    if (analysis.count < 2 || analysis.units.length === 0) return false;

    const bandIndex = opts?.bandIndex ?? st.selection?.bandIndex ?? 0;
    let nextItems: IntervalRef[] = analysis.items;
    let finalDelta = 0;

    const title =
      action === 'move'
        ? '同步平移所选区间'
        : action === 'left-edge'
          ? '同步调整所选左边界'
          : '同步调整所选右边界';

    const committed = st.commitTgMutation(
      (_draft, ctx) => {
        const res = applyMultiSyncDelta(ctx.editTier, st.tg, analysis.units, action, delta);
        if (!res.changed) return false;
        nextItems = res.nextItems;
        finalDelta = res.finalDelta;
        const nextPrimary = res.nextItems[res.nextItems.length - 1] ?? res.nextItems[0];
        if (nextPrimary) {
          ctx.setNextSelection({
            kind: 'interval',
            tierIndex: nextPrimary.tierIndex,
            itemIndex: nextPrimary.itemIndex,
            bandIndex
          });
        }
      },
      undefined,
      {
        type: 'multi-transform',
        title,
        detail: `${analysis.count} 项 · ${formatDeltaTime(delta)}`,
        icon: action === 'move' ? 'navHorizontal' : 'nudgeShared',
        focusTime: analysis.envelopeXmin + delta
      }
    );

    if (!committed) return false;
    get().setMultiSelection(nextItems, nextItems[nextItems.length - 1] ?? null, bandIndex);
    if (!opts?.silentToast) {
      st.showToast(`${title}（${analysis.count} 项 · ${formatDeltaTime(finalDelta)}）`);
    }
    return true;
  },
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
  setAutoSwitchContextualRibbon: (autoSwitchContextualRibbon) => {
    saveAutoSwitchContextualRibbon(autoSwitchContextualRibbon);
    set({ autoSwitchContextualRibbon });
  },
  setRestoreSessionOnStartup: (restoreSessionOnStartup) => {
    saveRestoreSessionOnStartup(restoreSessionOnStartup);
    set({ restoreSessionOnStartup });
  },
  setSmartSplitUseAcoustic: (smartSplitUseAcoustic) => {
    saveSmartSplitUseAcoustic(smartSplitUseAcoustic);
    set({ smartSplitUseAcoustic });
  },
  setCorpusAutoSave: (corpusAutoSave) => {
    saveCorpusAutoSave(corpusAutoSave);
    set({ corpusAutoSave });
  },
  setFloatingBarDensity: (floatingBarDensity) => {
    saveFloatingBarDensity(floatingBarDensity);
    set({ floatingBarDensity });
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

  movePointToTime: (tierIndex, pointIndex, targetTime, label) => {
    const st = get();
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'textTier') return false;
    const pt = tier.points[pointIndex];
    if (!pt || !Number.isFinite(targetTime)) return false;

    const eps = 1e-9;
    if (targetTime < tier.xmin - eps || targetTime > tier.xmax + eps) {
      st.showToast('标点时刻不能超出当前层级范围', true);
      return false;
    }
    const clampedT = Math.min(tier.xmax, Math.max(tier.xmin, targetTime));
    if (Math.abs(clampedT - pt.number) <= 1e-12) return false;

    if (tier.points.some((p, i) => i !== pointIndex && Math.abs(p.number - clampedT) <= eps)) {
      st.showToast('目标时刻已存在标点', true);
      return false;
    }

    const oldT = pt.number;
    const tierName = formatTierLabel(tier.name, tierIndex);
    const isZeroSnap = Boolean(label && label.includes('过零'));
    const bandIndex = st.selection?.bandIndex ?? 0;

    return st.commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(tierIndex);
        if (!dTier || dTier.kind !== 'textTier') return false;
        const targetPt = dTier.points[pointIndex];
        if (!targetPt) return false;
        targetPt.number = clampedT;
        dTier.points.sort((a, b) => a.number - b.number);
        const nextIdx = dTier.points.indexOf(targetPt);
        ctx.setNextSelection({
          kind: 'point',
          tierIndex,
          itemIndex: Math.max(0, nextIdx),
          bandIndex
        });
      },
      undefined,
      {
        type: isZeroSnap ? 'snap-zero-crossing' : 'move-point',
        title: label || '移动标注点',
        detail: `${tierName} · ${formatTimeSec(oldT)} → ${formatTimeSec(clampedT)} (${formatDeltaTime(clampedT - oldT)})`,
        icon: isZeroSnap ? 'zeroCross' : 'nudgeFine',
        tierName,
        focusTime: clampedT,
        coalesce: label
          ? undefined
          : {
              key: `move-point:${tierIndex}`,
              originValue: oldT,
              latestValue: clampedT,
              chainPrevLatest: oldT,
              formatMergedDetail: (orig, latest, count) => {
                const o = Number(orig);
                const l = Number(latest);
                return `${tierName} · ${formatTimeSec(o)} → ${formatTimeSec(l)} (${formatDeltaTime(l - o)}${count > 1 ? ` · ${count}次` : ''})`;
              }
            }
      }
    );
  },

  updateIntervalBoundsWithAnchor: (tierIndex, itemIndex, patch, anchor, linkNeighbors = true) => {
    const st = get();
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return false;
    const iv = tier.intervals[itemIndex];
    if (!iv || !Number.isFinite(iv.xmin) || !Number.isFinite(iv.xmax)) return false;

    const oldXmin = iv.xmin;
    const oldXmax = iv.xmax;
    const oldDur = oldXmax - oldXmin;
    const hasXmin = patch.xmin !== undefined;
    const hasXmax = patch.xmax !== undefined;
    const hasDur = patch.duration !== undefined;
    if (!hasXmin && !hasXmax && !hasDur) return false;

    if (
      (hasXmin && !Number.isFinite(patch.xmin!)) ||
      (hasXmax && !Number.isFinite(patch.xmax!)) ||
      (hasDur && !Number.isFinite(patch.duration!))
    ) {
      return false;
    }

    const eps = 1e-9;
    const minGap = 1e-6;
    if (hasDur && patch.duration! <= minGap) {
      st.showToast('区间时长必须大于 0', true);
      return false;
    }

    let nextXmin = oldXmin;
    let nextXmax = oldXmax;

    if (hasDur) {
      if (anchor === 'end') {
        nextXmax = hasXmax ? patch.xmax! : oldXmax;
        nextXmin = nextXmax - patch.duration!;
      } else {
        nextXmin = hasXmin ? patch.xmin! : oldXmin;
        nextXmax = nextXmin + patch.duration!;
      }
    } else if (hasXmin && hasXmax) {
      nextXmin = patch.xmin!;
      nextXmax = patch.xmax!;
    } else if (hasXmin) {
      nextXmin = patch.xmin!;
      nextXmax = anchor === 'duration' ? nextXmin + oldDur : oldXmax;
    } else if (hasXmax) {
      nextXmax = patch.xmax!;
      nextXmin = anchor === 'duration' ? nextXmax - oldDur : oldXmin;
    }

    if (Math.abs(nextXmin - tier.xmin) <= 1e-12) nextXmin = tier.xmin;
    if (Math.abs(nextXmax - tier.xmax) <= 1e-12) nextXmax = tier.xmax;

    if (!Number.isFinite(nextXmin) || !Number.isFinite(nextXmax) || nextXmax <= nextXmin + minGap) {
      st.showToast('区间终点必须严格大于起点', true);
      return false;
    }

    if (Math.abs(nextXmin - oldXmin) <= 1e-12 && Math.abs(nextXmax - oldXmax) <= 1e-12) {
      return false;
    }

    if (nextXmin < tier.xmin - eps || nextXmax > tier.xmax + eps) {
      st.showToast('区间起止不能超出当前层级范围', true);
      return false;
    }
    nextXmin = Math.max(tier.xmin, nextXmin);
    nextXmax = Math.min(tier.xmax, nextXmax);

    const link = linkNeighbors !== false;
    const prev = itemIndex > 0 ? tier.intervals[itemIndex - 1] : null;
    const next = itemIndex + 1 < tier.intervals.length ? tier.intervals[itemIndex + 1] : null;
    const hasContigPrev = Boolean(prev && Math.abs(prev.xmax - oldXmin) <= eps);
    const hasContigNext = Boolean(next && Math.abs(next.xmin - oldXmax) <= eps);
    const movedLeft = Math.abs(nextXmin - oldXmin) > 1e-12;
    const movedRight = Math.abs(nextXmax - oldXmax) > 1e-12;

    if (prev && movedLeft) {
      if (link && hasContigPrev) {
        if (nextXmin <= prev.xmin + minGap) {
          st.showToast('起点不能越过左侧相邻区间', true);
          return false;
        }
      } else if (nextXmin < prev.xmax - eps) {
        st.showToast('起点不能与左侧相邻区间重叠', true);
        return false;
      }
    }

    if (next && movedRight) {
      if (link && hasContigNext) {
        if (nextXmax >= next.xmax - minGap) {
          st.showToast('终点不能越过右侧相邻区间', true);
          return false;
        }
      } else if (nextXmax > next.xmin + eps) {
        st.showToast('终点不能与右侧相邻区间重叠', true);
        return false;
      }
    }

    const insertLeadEmpty =
      link && !prev && movedLeft && Math.abs(oldXmin - tier.xmin) <= eps && nextXmin > tier.xmin + eps;
    const insertTailEmpty =
      link && !next && movedRight && Math.abs(oldXmax - tier.xmax) <= eps && nextXmax < tier.xmax - eps;

    const isSlide = anchor === 'duration' && movedLeft && movedRight;
    const tierName = formatTierLabel(tier.name, tierIndex);
    const bandIndex = st.selection?.bandIndex ?? 0;
    const nextItemIndex = insertLeadEmpty ? itemIndex + 1 : itemIndex;

    const title = isSlide
      ? '平移区间'
      : movedLeft && movedRight
        ? '调整区间起止'
        : movedLeft
          ? '调整区间起点'
          : '调整区间终点';
    const detail = isSlide
      ? `${tierName} · ${formatTimeSpan(oldXmin, oldXmax)} → ${formatTimeSpan(nextXmin, nextXmax)} (${formatDeltaTime(nextXmin - oldXmin)})`
      : movedLeft && !movedRight
        ? `${tierName} · 起点 ${formatTimeSec(oldXmin)} → ${formatTimeSec(nextXmin)} (${formatDeltaTime(nextXmin - oldXmin)})`
        : !movedLeft && movedRight
          ? `${tierName} · 终点 ${formatTimeSec(oldXmax)} → ${formatTimeSec(nextXmax)} (${formatDeltaTime(nextXmax - oldXmax)})`
          : `${tierName} · ${formatTimeSpan(nextXmin, nextXmax)} (${formatDurationLabel(nextXmax - nextXmin)})`;

    const coalesceOrigin = movedLeft ? oldXmin : oldXmax;
    const coalesceLatest = movedLeft ? nextXmin : nextXmax;

    return st.commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(tierIndex);
        if (!dTier || dTier.kind !== 'intervalTier') return false;
        const cur = dTier.intervals[itemIndex];
        if (!cur) return false;
        const dPrev = itemIndex > 0 ? dTier.intervals[itemIndex - 1] : null;
        const dNext = itemIndex + 1 < dTier.intervals.length ? dTier.intervals[itemIndex + 1] : null;

        if (link && hasContigPrev && movedLeft && dPrev) {
          dPrev.xmax = nextXmin;
        }
        if (link && hasContigNext && movedRight && dNext) {
          dNext.xmin = nextXmax;
        }
        cur.xmin = nextXmin;
        cur.xmax = nextXmax;

        if (insertTailEmpty) {
          dTier.intervals.push({ xmin: nextXmax, xmax: dTier.xmax, text: '' });
        }
        if (insertLeadEmpty) {
          dTier.intervals.unshift({ xmin: dTier.xmin, xmax: nextXmin, text: '' });
        }

        ctx.setNextSelection({
          kind: 'interval',
          tierIndex,
          itemIndex: nextItemIndex,
          bandIndex
        });
        ctx.setNextPlayRange({ start: nextXmin, end: nextXmax });
      },
      undefined,
      {
        type: isSlide ? 'slide-interval' : 'edit-interval-edge',
        title,
        detail,
        icon: isSlide ? 'navHorizontal' : 'nudgeFine',
        tierName,
        focusTime: movedLeft ? nextXmin : nextXmax,
        coalesce:
          insertLeadEmpty || insertTailEmpty
            ? undefined
            : {
                key: isSlide
                  ? `slide-iv:${tierIndex}:${itemIndex}`
                  : `edge:${tierIndex}:${itemIndex}:${anchor}:${movedLeft ? 'L' : ''}${movedRight ? 'R' : ''}`,
                originValue: coalesceOrigin,
                latestValue: coalesceLatest,
                chainPrevLatest: coalesceOrigin,
                formatMergedDetail: (orig, latest, count) => {
                  const o = Number(orig);
                  const l = Number(latest);
                  const edgeLabel = isSlide
                    ? '平移'
                    : movedLeft && !movedRight
                      ? '起点'
                      : !movedLeft && movedRight
                        ? '终点'
                        : '起止';
                  return `${tierName} · ${edgeLabel} ${formatTimeSec(o)} → ${formatTimeSec(l)} (${formatDeltaTime(l - o)}${count > 1 ? ` · ${count}次` : ''})`;
                }
              }
      }
    );
  },

  convertSelectionIpa: async (direction) => {
    const st = get();
    const bridge = getPlatformBridge();
    const activeTabIdAtStart = st.activeTabId;
    const convertText = (text: string) =>
      direction === 'to-unicode'
        ? bridge.decodePraatTrigraphs(text)
        : bridge.encodePraatTrigraphs(text);
    const actionTitle = direction === 'to-unicode' ? '转为 Unicode 音标' : '转为 Praat 转义';
    const doneLabel = direction === 'to-unicode' ? 'Unicode 音标' : 'Praat 转义';

    const cleanMulti = sanitizeIntervalRefs(st.tg, st.multiSelection);
    if (cleanMulti.length >= 2) {
      const snapshotItems = cleanMulti
        .map((ref) => {
          const t = st.tg.tiers[ref.tierIndex];
          const iv = t?.kind === 'intervalTier' ? t.intervals[ref.itemIndex] : null;
          return iv ? { ...ref, oldText: iv.text } : null;
        })
        .filter((x): x is { tierIndex: number; itemIndex: number; oldText: string } => x !== null);

      const converted = await Promise.all(
        snapshotItems.map(async (item) => {
          if (!item.oldText) return { ...item, newText: item.oldText, changed: false };
          const res = await convertText(item.oldText);
          const changed = res.changed && res.text !== item.oldText;
          if (changed && direction === 'to-praat') {
            await primeTrigraphString(res.text, bridge);
          }
          return { ...item, newText: changed ? res.text : item.oldText, changed };
        })
      );

      const updates = converted.filter((item) => item.changed);
      const cur = get();
      if (cur.activeTabId !== activeTabIdAtStart) return false;
      if (updates.length === 0) {
        cur.showToast('当前内容无需转换');
        return false;
      }

      const primarySel = cur.selection;
      let appliedCount = 0;
      const committed = cur.commitTgMutation(
        (_draft, ctx) => {
          for (const u of updates) {
            const dTier = ctx.editTier(u.tierIndex);
            if (!dTier || dTier.kind !== 'intervalTier') continue;
            const dIv = dTier.intervals[u.itemIndex];
            if (!dIv || dIv.text !== u.oldText) continue;
            dIv.text = u.newText;
            appliedCount++;
          }
          if (appliedCount === 0) return false;
        },
        primarySel,
        {
          type: 'convert-ipa',
          title: actionTitle,
          detail: `批量转换 ${updates.length} 项区间`,
          icon: 'ipaMode'
        }
      );

      if (!committed) {
        get().showToast('当前内容无需转换');
        return false;
      }

      const primaryRef =
        primarySel?.kind === 'interval'
          ? { tierIndex: primarySel.tierIndex, itemIndex: primarySel.itemIndex }
          : null;
      get().setMultiSelection(cleanMulti, primaryRef, primarySel?.bandIndex);
      get().showToast(`已将 ${appliedCount} 项转为 ${doneLabel}`);
      return true;
    }

    const sel = st.selection;
    if (sel?.kind === 'interval') {
      const tier = st.tg.tiers[sel.tierIndex];
      const iv = tier?.kind === 'intervalTier' ? tier.intervals[sel.itemIndex] : null;
      if (!tier || !iv) return false;
      if (!iv.text) {
        st.showToast('当前内容无需转换');
        return false;
      }
      const oldText = iv.text;
      const res = await convertText(oldText);
      const cur = get();
      if (cur.activeTabId !== activeTabIdAtStart) return false;
      if (!res.changed || res.text === oldText) {
        cur.showToast('当前内容无需转换');
        return false;
      }
      if (direction === 'to-praat') {
        await primeTrigraphString(res.text, bridge);
      }
      const tierName = formatTierLabel(tier.name, sel.tierIndex);
      const committed = get().commitTgMutation(
        (_draft, ctx) => {
          const dTier = ctx.editTier(sel.tierIndex);
          if (!dTier || dTier.kind !== 'intervalTier') return false;
          const dIv = dTier.intervals[sel.itemIndex];
          if (!dIv || dIv.text !== oldText) return false;
          dIv.text = res.text;
        },
        sel,
        {
          type: 'convert-ipa',
          title: actionTitle,
          detail: `${tierName} · ${formatQuote(oldText)} → ${formatQuote(res.text)}`,
          icon: 'ipaMode',
          tierName,
          focusTime: iv.xmin
        }
      );
      if (committed) {
        get().showToast(`已转为 ${doneLabel}`);
      }
      return committed;
    }

    if (sel?.kind === 'point') {
      const tier = st.tg.tiers[sel.tierIndex];
      const pt = tier?.kind === 'textTier' ? tier.points[sel.itemIndex] : null;
      if (!tier || !pt) return false;
      if (!pt.mark) {
        st.showToast('当前内容无需转换');
        return false;
      }
      const oldMark = pt.mark;
      const res = await convertText(oldMark);
      const cur = get();
      if (cur.activeTabId !== activeTabIdAtStart) return false;
      if (!res.changed || res.text === oldMark) {
        cur.showToast('当前内容无需转换');
        return false;
      }
      if (direction === 'to-praat') {
        await primeTrigraphString(res.text, bridge);
      }
      const tierName = formatTierLabel(tier.name, sel.tierIndex);
      const committed = get().commitTgMutation(
        (_draft, ctx) => {
          const dTier = ctx.editTier(sel.tierIndex);
          if (!dTier || dTier.kind !== 'textTier') return false;
          const dPt = dTier.points[sel.itemIndex];
          if (!dPt || dPt.mark !== oldMark) return false;
          dPt.mark = res.text;
        },
        sel,
        {
          type: 'convert-ipa',
          title: actionTitle,
          detail: `${tierName} · ${formatQuote(oldMark)} → ${formatQuote(res.text)}`,
          icon: 'ipaMode',
          tierName,
          focusTime: pt.number
        }
      );
      if (committed) {
        get().showToast(`已转为 ${doneLabel}`);
      }
      return committed;
    }

    st.showToast('请先选中区间或标点');
    return false;
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

    const texts = Array.from({ length: count }, (_, k) => (k === 0 ? iv.text : ''));
    const segs = buildEqualIntervals(iv.xmin, iv.xmax, texts);
    if (!segs) {
      st.showToast('区间时长过短，无法继续等分', true);
      return false;
    }
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

  splitIntervalWithCuts: (tierIndex, itemIndex, texts, cuts, meta) => {
    const st = get();
    if (texts.length < 2) return false;
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return false;
    const iv = tier.intervals[itemIndex];
    if (!iv || iv.xmax <= iv.xmin) return false;

    const segs = buildIntervalsFromCuts(iv.xmin, iv.xmax, texts, cuts);
    if (!segs) {
      st.showToast('区间时长过短，无法继续拆分', true);
      return false;
    }

    const count = texts.length;
    const tierName = formatTierLabel(tier.name, tierIndex);
    const title = meta?.title ?? '等分区间';
    const detailPrefix = meta?.detailPrefix ?? '等分为';
    const toastLabel = meta?.toastLabel ?? '已将区间等分为';

    const ok = st.commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(tierIndex);
        if (!dTier || dTier.kind !== 'intervalTier') return false;
        dTier.intervals.splice(itemIndex, 1, ...segs);
      },
      { kind: 'interval', tierIndex, itemIndex },
      {
        type: 'split-equal',
        title,
        detail: `${tierName} · ${detailPrefix} ${count} 段 (${formatTimeSpan(iv.xmin, iv.xmax)})`,
        icon: 'splitEqual',
        tierName,
        focusTime: iv.xmin
      }
    );
    if (ok) get().showToast(`${toastLabel} ${count} 段`);
    return ok;
  },

  replaceJustSplitInterval: (
    tierIndex,
    startItemIndex,
    prevCount,
    originalXmin,
    originalXmax,
    nextTexts,
    nextCuts,
    meta
  ) => {
    const st = get();
    if (
      prevCount < 1 ||
      nextTexts.length < 2 ||
      startItemIndex < 0 ||
      !Number.isFinite(originalXmin) ||
      !Number.isFinite(originalXmax) ||
      originalXmax <= originalXmin
    ) {
      return false;
    }
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return false;
    if (startItemIndex + prevCount > tier.intervals.length) return false;

    const slice = tier.intervals.slice(startItemIndex, startItemIndex + prevCount);
    if (
      slice.length !== prevCount ||
      slice[0].xmin !== originalXmin ||
      slice[slice.length - 1].xmax !== originalXmax
    ) {
      return false;
    }

    const segs = buildIntervalsFromCuts(originalXmin, originalXmax, nextTexts, nextCuts);
    if (!segs) {
      st.showToast('区间时长过短，无法继续拆分', true);
      return false;
    }

    const count = nextTexts.length;
    const tierName = formatTierLabel(tier.name, tierIndex);
    const title = meta?.title ?? '切换拆分粒度';
    const detailPrefix = meta?.detailPrefix ?? '拆分为';
    const toastLabel = meta?.toastLabel ?? '已切换为';

    const ok = st.commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(tierIndex);
        if (!dTier || dTier.kind !== 'intervalTier') return false;
        const curSlice = dTier.intervals.slice(startItemIndex, startItemIndex + prevCount);
        if (
          curSlice.length !== prevCount ||
          curSlice[0].xmin !== originalXmin ||
          curSlice[curSlice.length - 1].xmax !== originalXmax
        ) {
          return false;
        }
        dTier.intervals.splice(startItemIndex, prevCount, ...segs);
      },
      { kind: 'interval', tierIndex, itemIndex: startItemIndex },
      {
        type: 'split-equal',
        title,
        detail: `${tierName} · ${detailPrefix} ${count} 段 (${formatTimeSpan(originalXmin, originalXmax)})`,
        icon: 'splitEqual',
        tierName,
        focusTime: originalXmin
      }
    );
    if (ok) get().showToast(`${toastLabel} ${count} 段`);
    return ok;
  },

  splitIntervalWithTexts: (tierIndex, itemIndex, texts, meta) => {
    return get().splitIntervalWithCuts(tierIndex, itemIndex, texts, null, meta);
  },

  splitIntervalByChars: (tierIndex, itemIndex, options) => {
    const st = get();
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return false;
    const iv = tier.intervals[itemIndex];
    if (!iv || iv.xmax <= iv.xmin) return false;

    const runWithText = (rawText: string, decodedText: string | null): boolean => {
      const sourceText = resolveSplitSourceText(rawText, decodedText).text;
      const res = buildCharSplitIntervals(iv.xmin, iv.xmax, sourceText, options);
      if (!res.ok) {
        if (res.reason === 'insufficient-chars') {
          get().showToast('有效字数不足 2 字，无法按字数等分', true);
        } else {
          get().showToast('区间时长过短，无法继续等分', true);
        }
        return false;
      }
      return get().splitIntervalWithTexts(tierIndex, itemIndex, res.chars, {
        title: '按字数等分区间',
        detailPrefix: '按字数等分为',
        toastLabel: '已按字数等分为'
      });
    };

    const cachedDecoded = decodeTrigraphGlossSync(iv.text);
    if (cachedDecoded === null && iv.text.includes('\\')) {
      let hasTrigraph = false;
      for (let idx = 0; idx < iv.text.length - 2; idx++) {
        if (isValidPraatTrigraphAt(iv.text, idx)) {
          hasTrigraph = true;
          break;
        }
      }
      if (hasTrigraph) {
        const expectedText = iv.text;
        const expectedXmin = iv.xmin;
        const expectedXmax = iv.xmax;
        void primeTrigraphString(expectedText, getPlatformBridge()).then(() => {
          const curTier = get().tg.tiers[tierIndex];
          if (!curTier || curTier.kind !== 'intervalTier') return;
          const curIv = curTier.intervals[itemIndex];
          if (
            !curIv ||
            curIv.text !== expectedText ||
            curIv.xmin !== expectedXmin ||
            curIv.xmax !== expectedXmax
          ) {
            return;
          }
          runWithText(curIv.text, decodeTrigraphGlossSync(curIv.text));
        });
        return true;
      }
    }

    return runWithText(iv.text, cachedDecoded);
  },

  splitIntervalByDelimiter: (tierIndex, itemIndex, options) => {
    const st = get();
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return false;
    const iv = tier.intervals[itemIndex];
    if (!iv || iv.xmax <= iv.xmin) return false;

    const preset = options?.preset ?? 'whitespace';
    const modeName = preset === 'whitespace' ? '空格分词' : '分词';

    const runWithText = (rawText: string, decodedText: string | null): boolean => {
      const sourceText = resolveSplitSourceText(rawText, decodedText).text;
      const res = buildDelimiterSplitIntervals(iv.xmin, iv.xmax, sourceText, options);
      if (!res.ok) {
        if (res.reason === 'insufficient-tokens') {
          get().showToast(`按${modeName}切分不足 2 段，无法等分`, true);
        } else {
          get().showToast('区间时长过短，无法继续等分', true);
        }
        return false;
      }
      return get().splitIntervalWithTexts(tierIndex, itemIndex, res.tokens, {
        title: `按${modeName}等分区间`,
        detailPrefix: `按${modeName}等分为`,
        toastLabel: `已按${modeName}等分为`
      });
    };

    const cachedDecoded = decodeTrigraphGlossSync(iv.text);
    if (cachedDecoded === null && iv.text.includes('\\')) {
      let hasTrigraph = false;
      for (let idx = 0; idx < iv.text.length - 2; idx++) {
        if (isValidPraatTrigraphAt(iv.text, idx)) {
          hasTrigraph = true;
          break;
        }
      }
      if (hasTrigraph) {
        const expectedText = iv.text;
        const expectedXmin = iv.xmin;
        const expectedXmax = iv.xmax;
        void primeTrigraphString(expectedText, getPlatformBridge()).then(() => {
          const curTier = get().tg.tiers[tierIndex];
          if (!curTier || curTier.kind !== 'intervalTier') return;
          const curIv = curTier.intervals[itemIndex];
          if (
            !curIv ||
            curIv.text !== expectedText ||
            curIv.xmin !== expectedXmin ||
            curIv.xmax !== expectedXmax
          ) {
            return;
          }
          runWithText(curIv.text, decodeTrigraphGlossSync(curIv.text));
        });
        return true;
      }
    }

    return runWithText(iv.text, cachedDecoded);
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
    if (!tier || tier.kind !== 'intervalTier' || tier.intervals.length === 0) return false;

    const isOuterStart = Math.abs(oldT - tier.xmin) <= 1e-9;
    const isOuterEnd = Math.abs(oldT - tier.xmax) <= 1e-9;
    const { minAllowed, maxAllowed } = getBoundaryBoundsForTier(tier, oldT);

    if (isOuterStart) {
      const firstIv = tier.intervals[0];
      if (!firstIv || firstIv.text.trim() === '') return false;
      if (newT <= tier.xmin + 1e-9 || newT >= firstIv.xmax - 1e-6) {
        st.showToast('外端边界只能向内侧收缩且不能越过相邻边界', true);
        return false;
      }
    } else if (isOuterEnd) {
      const lastIv = tier.intervals[tier.intervals.length - 1];
      if (!lastIv || lastIv.text.trim() === '') return false;
      if (newT >= tier.xmax - 1e-9 || newT <= lastIv.xmin + 1e-6) {
        st.showToast('外端边界只能向内侧收缩且不能越过相邻边界', true);
        return false;
      }
    } else if (newT <= minAllowed - 1e-9 || newT >= maxAllowed + 1e-9) {
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
          title: isOuterStart || isOuterEnd ? '收缩外端边界' : '移动边界',
          detail: `${tierName} · ${formatTimeSec(oldT)} → ${formatTimeSec(newT)} (${formatDeltaTime(newT - oldT)})`,
          icon: 'nudgeBoundary',
          tierName,
          focusTime: newT,
          coalesce:
            opts?.coalesce === false || isOuterStart || isOuterEnd
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
        if (!dTier || dTier.kind !== 'intervalTier' || dTier.intervals.length === 0) return false;
        let touched = false;
        if (isOuterStart) {
          const first = dTier.intervals[0];
          if (!first || first.text.trim() === '' || newT <= first.xmin + 1e-9 || newT >= first.xmax - 1e-6) {
            return false;
          }
          const origMin = first.xmin;
          first.xmin = newT;
          dTier.intervals.unshift({ xmin: origMin, xmax: newT, text: '' });
          touched = true;
        } else if (isOuterEnd) {
          const last = dTier.intervals[dTier.intervals.length - 1];
          if (!last || last.text.trim() === '' || newT >= last.xmax - 1e-9 || newT <= last.xmin + 1e-6) {
            return false;
          }
          const origMax = last.xmax;
          last.xmax = newT;
          dTier.intervals.push({ xmin: newT, xmax: origMax, text: '' });
          touched = true;
        } else {
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
    const isGlobalOuterStart = Math.abs(oldT - st.tg.xmin) <= 1e-9;
    const isGlobalOuterEnd = Math.abs(oldT - st.tg.xmax) <= 1e-9;
    let minAllowed = -Infinity;
    let maxAllowed = Infinity;
    for (const tier of st.tg.tiers) {
      if (tier.kind === 'intervalTier') {
        const b = getBoundaryBoundsForTier(tier, oldT);
        minAllowed = Math.max(minAllowed, b.minAllowed);
        maxAllowed = Math.min(maxAllowed, b.maxAllowed);
      }
    }
    if (isGlobalOuterStart) {
      if (newT <= st.tg.xmin + 1e-9 || newT >= maxAllowed + 1e-9) {
        st.showToast('外端边界只能向内侧收缩且不能越过相邻边界', true);
        return false;
      }
    } else if (isGlobalOuterEnd) {
      if (newT >= st.tg.xmax - 1e-9 || newT <= minAllowed - 1e-9) {
        st.showToast('外端边界只能向内侧收缩且不能越过相邻边界', true);
        return false;
      }
    } else if (newT <= minAllowed - 1e-9 || newT >= maxAllowed + 1e-9) {
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
          title: isGlobalOuterStart || isGlobalOuterEnd ? '跨层收缩外端边界' : '跨层移动边界',
          detail: `对齐时刻 · ${formatTimeSec(oldT)} → ${formatTimeSec(newT)} (${formatDeltaTime(newT - oldT)})`,
          icon: 'nudgeShared',
          focusTime: newT,
          coalesce:
            opts?.coalesce === false || isGlobalOuterStart || isGlobalOuterEnd
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
        if (isGlobalOuterStart || isGlobalOuterEnd) {
          // Pull-inward from audio/tier outer edges: preserve tier/draft domain and insert empty lead/tail
          for (let ti = 0; ti < draft.tiers.length; ti++) {
            const origTier = draft.tiers[ti];
            if (origTier.kind === 'intervalTier' && origTier.intervals.length > 0) {
              if (isGlobalOuterStart) {
                const firstOrig = origTier.intervals[0];
                if (
                  Math.abs(firstOrig.xmin - oldT) <= 1e-9 &&
                  firstOrig.text.trim() !== '' &&
                  newT > firstOrig.xmin + 1e-9 &&
                  newT < firstOrig.xmax - 1e-6
                ) {
                  const tier = ctx.editTier(ti);
                  if (!tier || tier.kind !== 'intervalTier') continue;
                  const first = tier.intervals[0];
                  const origMin = first.xmin;
                  first.xmin = newT;
                  tier.intervals.unshift({ xmin: origMin, xmax: newT, text: '' });
                  changed = true;
                }
              } else if (isGlobalOuterEnd) {
                const lastOrig = origTier.intervals[origTier.intervals.length - 1];
                if (
                  Math.abs(lastOrig.xmax - oldT) <= 1e-9 &&
                  lastOrig.text.trim() !== '' &&
                  newT < lastOrig.xmax - 1e-9 &&
                  newT > lastOrig.xmin + 1e-6
                ) {
                  const tier = ctx.editTier(ti);
                  if (!tier || tier.kind !== 'intervalTier') continue;
                  const last = tier.intervals[tier.intervals.length - 1];
                  const origMax = last.xmax;
                  last.xmax = newT;
                  tier.intervals.push({ xmin: newT, xmax: origMax, text: '' });
                  changed = true;
                }
              }
            } else if (origTier.kind === 'textTier') {
              if (origTier.points.some((pt) => Math.abs(pt.number - oldT) <= 1e-9)) {
                const tier = ctx.editTier(ti);
                if (!tier || tier.kind !== 'textTier') continue;
                for (const pt of tier.points) {
                  if (Math.abs(pt.number - oldT) <= 1e-9) {
                    pt.number = newT;
                    changed = true;
                  }
                }
                tier.points.sort((a, b) => a.number - b.number);
              }
            }
          }
        } else {
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
        }
        if (!changed) return false;
        if (opts?.nextSelection !== undefined) {
          ctx.setNextSelection(opts.nextSelection);
        }
      },
      undefined,
      meta
    );
  },

  transformAlignedBlock: (anchorTierIndex, anchorItemIndex, targetXmin, targetXmax, opts) => {
    const st = get();
    const anchorTier = st.tg.tiers[anchorTierIndex];
    const anchorIv =
      anchorTier && anchorTier.kind === 'intervalTier' ? anchorTier.intervals[anchorItemIndex] : null;
    if (!anchorTier || !anchorIv || anchorIv.xmax <= anchorIv.xmin) {
      return {
        ok: false,
        changed: false,
        clamped: false,
        blockerTierName: null,
        affectedTierCount: 0,
        finalXmin: 0,
        finalXmax: 0,
        reason: 'invalid-anchor'
      };
    }

    const mode: BlockTransformMode = opts?.mode ?? 'remap';
    const block = findAlignedBlock(
      st.tg,
      {
        xmin: anchorIv.xmin,
        xmax: anchorIv.xmax,
        tierIndex: anchorTierIndex,
        itemIndex: anchorItemIndex
      },
      st.hiddenTierIndices
    );
    if (!block) {
      return {
        ok: false,
        changed: false,
        clamped: false,
        blockerTierName: null,
        affectedTierCount: 0,
        finalXmin: anchorIv.xmin,
        finalXmax: anchorIv.xmax,
        reason: 'invalid-anchor'
      };
    }

    const safe = computeBlockSafeBounds(st.tg, block);
    const clamped = clampBlockTargetSpan(block, safe, targetXmin, targetXmax, mode);
    const wasClamped = clamped.clampedLeft || clamped.clampedRight || clamped.clampedMinWidth;

    if (!clamped.changed) {
      if (!opts?.silentToast) {
        if (wasClamped && clamped.blockerTierName) {
          st.showToast(`受「${clamped.blockerTierName}」相邻非空区间阻挡，无法移动`, true);
        } else if (wasClamped) {
          st.showToast('目标范围超出安全边界，无法移动', true);
        }
      }
      return {
        ok: false,
        changed: false,
        clamped: wasClamped,
        blockerTierName: clamped.blockerTierName,
        affectedTierCount: 0,
        finalXmin: anchorIv.xmin,
        finalXmax: anchorIv.xmax,
        reason: wasClamped ? 'blocked' : 'no-change'
      };
    }

    const tierCount = block.tierIndices.length;
    const textHint = anchorIv.text ? formatQuote(anchorIv.text, 8) : '';
    const historyType =
      mode === 'move' ? 'move-block' : mode === 'resize' ? 'resize-block' : 'remap-block';
    const historyTitle =
      mode === 'move'
        ? '跨层平移时间块'
        : mode === 'resize'
          ? '跨层弹性缩放'
          : '跨层重映射到选区';
    const historyIcon = mode === 'move' ? 'navHorizontal' : 'nudgeShared';
    const detail =
      mode === 'move'
        ? `${tierCount} 层${textHint} · ${formatDeltaTime(clamped.targetXmin - block.xmin)}`
        : `${tierCount} 层${textHint} · ${formatTimeSpan(block.xmin, block.xmax)} → ${formatTimeSpan(clamped.targetXmin, clamped.targetXmax)}`;

    let appliedResult = {
      changed: false,
      nextAnchorItemIndex: block.anchorItemIndex,
      affectedTierCount: 0,
      finalXmin: clamped.targetXmin,
      finalXmax: clamped.targetXmax
    };

    const committed = st.commitTgMutation(
      (_draft, ctx) => {
        appliedResult = applyBlockTransformToDraft(
          ctx.editTier,
          block,
          clamped.targetXmin,
          clamped.targetXmax
        );
        if (!appliedResult.changed) return false;
        ctx.setNextSelection({
          kind: 'interval',
          tierIndex: block.anchorTierIndex,
          itemIndex: appliedResult.nextAnchorItemIndex,
          bandIndex: opts?.bandIndex ?? st.selection?.bandIndex ?? 0
        });
        ctx.setNextPlayRange({
          start: appliedResult.finalXmin,
          end: appliedResult.finalXmax
        });
      },
      undefined,
      {
        type: historyType,
        title: historyTitle,
        detail,
        icon: historyIcon,
        tierName: formatTierLabel(anchorTier.name, anchorTierIndex),
        focusTime: clamped.targetXmin
      }
    );

    if (!committed) {
      return {
        ok: false,
        changed: false,
        clamped: wasClamped,
        blockerTierName: clamped.blockerTierName,
        affectedTierCount: 0,
        finalXmin: anchorIv.xmin,
        finalXmax: anchorIv.xmax,
        reason: 'no-change'
      };
    }

    if (!opts?.silentToast) {
      const layerWord = `${appliedResult.affectedTierCount} 层`;
      if (wasClamped && clamped.blockerTierName) {
        st.showToast(
          `受「${clamped.blockerTierName}」相邻区间阻挡，已贴合至安全范围（${layerWord}）`
        );
      } else if (mode === 'remap') {
        st.showToast(
          `已将 ${layerWord} 跨层重映射到 ${formatTimeSpan(appliedResult.finalXmin, appliedResult.finalXmax)}`
        );
      }
    }

    return {
      ok: true,
      changed: true,
      clamped: wasClamped,
      blockerTierName: clamped.blockerTierName,
      affectedTierCount: appliedResult.affectedTierCount,
      finalXmin: appliedResult.finalXmin,
      finalXmax: appliedResult.finalXmax
    };
  }
}));
