import type { IconName } from '@tgrid/icons';
import type { TextGrid, Tier } from '../bridge/types';
import type { EditorSelection } from '../render/renderScoreSvg';
import type { StyleDocument } from '../style/types.ts';
import { cloneStyleDocument } from '../style/palettes.ts';

export type HistoryActionType =
  // 1. 文本与标注
  | 'edit-interval-text'
  | 'edit-point-text'
  | 'clear-interval-text'
  | 'clear-point-text'
  | 'clear-tier-text'
  | 'cut-text'
  | 'paste-text'
  | 'replace-one'
  | 'replace-all'
  | 'convert-ipa'
  // 2. 切分与创建
  | 'split-interval'
  | 'split-all-tiers'
  | 'split-equal'
  | 'create-interval'
  | 'add-point'
  | 'project-boundary'
  | 'copy-interval-span'
  | 'vad-segment'
  // 3. 边界与时刻调整
  | 'move-boundary'
  | 'move-shared-boundary'
  | 'edit-interval-edge'
  | 'slide-interval'
  | 'move-block'
  | 'resize-block'
  | 'remap-block'
  | 'multi-clear-text'
  | 'multi-merge'
  | 'multi-align'
  | 'multi-transform'
  | 'move-point'
  | 'snap-zero-crossing'
  | 'snap-acoustic-edge'
  // 4. 删除与合并
  | 'merge-interval'
  | 'delete-boundary'
  | 'delete-boundary-all'
  | 'clear-and-remove-edge'
  | 'delete-point'
  | 'delete-zero-interval'
  // 5. 层级结构
  | 'insert-tier'
  | 'duplicate-tier'
  | 'derive-point-tier'
  | 'rename-tier'
  | 'reorder-tier'
  | 'delete-tier'
  | 'edit-tier-bounds'
  // 6. 文档与数据体检
  | 'edit-global-bounds'
  | 'normalize-tg'
  | 'align-micro-boundaries'
  | 'qa-fix-gap'
  | 'qa-fix-overlap'
  | 'qa-fix-ood'
  | 'qa-trim-space'
  // 7. 样式与主题
  | 'style-edit'
  | 'style-theme'
  | 'style-rule'
  | 'style-clear'
  | 'style-brush';

/** 合并规则描述：同 key 且在时间窗口内的连续微调自动合并为一条记录 */
export interface HistoryCoalesceSpec {
  key: string;
  windowMs?: number;
  originValue?: number | string;
  latestValue?: number | string;
  chainPrevLatest?: number | string;
  formatMergedDetail?: (origin: number | string, latest: number | string, count: number) => string;
}

/** 统一的操作语义元数据 */
export interface HistoryActionMeta {
  type: HistoryActionType;
  title: string;
  detail?: string;
  icon: IconName;
  tierName?: string;
  focusTime?: number;
  coalesce?: HistoryCoalesceSpec;
}

/** 完整可还原的文档状态快照（Tier 级结构共享，非破坏性不可变） */
export interface HistoryStateSnapshot {
  tg: TextGrid;
  selection: EditorSelection;
  hiddenTierIndices: number[];
  playRange: { start: number; end: number } | null;
  styleDoc?: StyleDocument;
}

export type BaselineKind = 'open' | 'blank' | 'sample' | 'cleared';

/** 初始基线快照（固定置顶，永不随上限裁剪丢失） */
export interface HistoryBaseline {
  id: string;
  title: string;
  detail: string;
  icon: IconName;
  timestamp: number;
  snapshot: HistoryStateSnapshot;
}

/** 单条操作历史记录（存储操作执行后的 Post-State） */
export interface HistoryEntry {
  id: string;
  stepNumber: number;
  meta: HistoryActionMeta;
  timestamp: number;
  mergeCount: number;
  coalesceOrigin?: number | string;
  coalesceLatest?: number | string;
  snapshot: HistoryStateSnapshot;
}

/** 单文档完整历史时间线 */
export interface HistoryTimeline {
  baseline: HistoryBaseline;
  entries: HistoryEntry[];
  cursor: number;
  savedEntryId: string | null;
  prunedCount: number;
  nextStepSeq: number;
  maxEntries: number;
  coalesceEligibleEntryId: string | null;
}

export interface MutationContext {
  editTier: (tierIndex: number) => Tier | undefined;
  setNextSelection: (sel: EditorSelection) => void;
  setNextHiddenTiers: (hidden: number[]) => void;
  setNextPlayRange: (range: { start: number; end: number } | null) => void;
}

export interface ProducedMutation {
  changed: boolean;
  nextTg: TextGrid;
  hasNextSelection: boolean;
  nextSelection?: EditorSelection;
  hasNextHiddenTiers: boolean;
  nextHiddenTiers?: number[];
  hasNextPlayRange: boolean;
  nextPlayRange?: { start: number; end: number } | null;
}

export const DEFAULT_HISTORY_LIMIT = 50;
export const MIN_HISTORY_LIMIT = 10;
export const MAX_HISTORY_LIMIT = 200;
export const DEFAULT_COALESCE_WINDOW_MS = 800;

const HISTORY_LIMIT_STORAGE_KEY = 'tgrid_history_limit_v1';

export function clampHistoryLimit(val: number): number {
  if (!Number.isFinite(val)) return DEFAULT_HISTORY_LIMIT;
  return Math.max(MIN_HISTORY_LIMIT, Math.min(MAX_HISTORY_LIMIT, Math.round(val)));
}

export function loadSavedHistoryLimit(): number {
  try {
    const raw = localStorage.getItem(HISTORY_LIMIT_STORAGE_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return clampHistoryLimit(parsed);
      }
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_HISTORY_LIMIT;
}

export function saveHistoryLimit(limit: number): void {
  try {
    localStorage.setItem(HISTORY_LIMIT_STORAGE_KEY, String(clampHistoryLimit(limit)));
  } catch {
    // ignore storage errors
  }
}

let nextBaselineSeq = 1;
let nextEntrySeq = 1;

function nextBaselineId(): string {
  return `base-${nextBaselineSeq++}`;
}

function nextEntryId(): string {
  return `h-${nextEntrySeq++}`;
}

// ============================================================================
// Semantic Formatting Helpers
// ============================================================================

export function formatTimeSec(t: number): string {
  if (!Number.isFinite(t)) return '0.000s';
  return `${t.toFixed(3)}s`;
}

export function formatTimeSpan(t0: number, t1: number): string {
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return '0.000–0.000s';
  return `${t0.toFixed(3)}–${t1.toFixed(3)}s`;
}

export function formatDurationLabel(durSec: number): string {
  const safe = Math.max(0, Number.isFinite(durSec) ? durSec : 0);
  if (safe < 1) return `${Math.round(safe * 1000)}ms`;
  return `${safe.toFixed(3)}s`;
}

export function formatDeltaTime(deltaSec: number): string {
  if (!Number.isFinite(deltaSec)) return '+0ms';
  if (Math.abs(deltaSec) < 1e-9) return '+0ms';
  const sign = deltaSec >= 0 ? '+' : '−';
  const absSec = Math.abs(deltaSec);
  if (absSec < 1) {
    const absMs = absSec * 1000;
    if (absMs < 10 && Math.abs(absMs - Math.round(absMs)) >= 0.05) {
      return `${sign}${absMs.toFixed(1)}ms`;
    }
    return `${sign}${Math.round(absMs)}ms`;
  }
  return `${sign}${absSec.toFixed(3)}s`;
}

export function formatQuote(text: string, maxChars = 10): string {
  const normalized = (text ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (normalized.length === 0) return '「」';
  const glyphs = Array.from(normalized);
  if (glyphs.length <= maxChars) return `「${normalized}」`;
  return `「${glyphs.slice(0, maxChars).join('')}…」`;
}

export function formatTierLabel(name: string | undefined, fallbackIdx?: number): string {
  const clean = (name ?? '').trim();
  if (clean) return clean;
  if (fallbackIdx !== undefined) return `层 ${fallbackIdx + 1}`;
  return '未命名层';
}

export function formatDocBaselineDetail(filename: string, tg: TextGrid): string {
  const dur = Math.max(
    0,
    (Number.isFinite(tg.xmax) ? tg.xmax : 0) - (Number.isFinite(tg.xmin) ? tg.xmin : 0)
  );
  return `${filename || tg.name || '未命名.TextGrid'} · ${tg.tiers.length} 层 · ${dur.toFixed(2)}s`;
}

export function formatVadHistoryDetail(
  tierName: string,
  speechCount: number,
  scopeStart?: number,
  scopeEnd?: number,
  isFullScope = false
): string {
  const label = formatTierLabel(tierName);
  if (!isFullScope && scopeStart !== undefined && scopeEnd !== undefined) {
    return `${label} · 检出 ${speechCount} 个有声段 (${formatTimeSpan(scopeStart, scopeEnd)})`;
  }
  return `${label} · 全录音检出 ${speechCount} 个有声段`;
}

// ============================================================================
// Tier-Level Copy-on-Write Helpers
// ============================================================================

export function cloneTier(tier: Tier): Tier {
  return {
    ...tier,
    intervals: tier.intervals.map((iv) => ({ ...iv })),
    points: tier.points.map((pt) => ({ ...pt }))
  };
}

export function cloneSnapshot(snap: HistoryStateSnapshot): HistoryStateSnapshot {
  const cloned: HistoryStateSnapshot = {
    tg: snap.tg,
    selection: snap.selection ? { ...snap.selection } : null,
    hiddenTierIndices: [...snap.hiddenTierIndices],
    playRange: snap.playRange ? { ...snap.playRange } : null
  };
  if (snap.styleDoc !== undefined) {
    cloned.styleDoc = cloneStyleDocument(snap.styleDoc);
  }
  return cloned;
}

export function produceTgMutation(
  baseTg: TextGrid,
  mutator: (draft: TextGrid, ctx: MutationContext) => boolean | void
): ProducedMutation {
  const draft: TextGrid = {
    ...baseTg,
    tiers: [...baseTg.tiers]
  };
  const clonedSet = new Set<number>();

  let hasNextSelection = false;
  let nextSelection: EditorSelection = null;
  let hasNextHiddenTiers = false;
  let nextHiddenTiers: number[] | undefined;
  let hasNextPlayRange = false;
  let nextPlayRange: { start: number; end: number } | null | undefined;

  const ctx: MutationContext = {
    editTier: (tierIndex: number) => {
      if (tierIndex < 0 || tierIndex >= draft.tiers.length) return undefined;
      if (!clonedSet.has(tierIndex)) {
        draft.tiers[tierIndex] = cloneTier(draft.tiers[tierIndex]);
        clonedSet.add(tierIndex);
      }
      return draft.tiers[tierIndex];
    },
    setNextSelection: (sel) => {
      hasNextSelection = true;
      nextSelection = sel ? { ...sel } : null;
    },
    setNextHiddenTiers: (hidden) => {
      hasNextHiddenTiers = true;
      nextHiddenTiers = [...hidden];
    },
    setNextPlayRange: (range) => {
      hasNextPlayRange = true;
      nextPlayRange = range ? { ...range } : null;
    }
  };

  const res = mutator(draft, ctx);
  if (res === false) {
    return {
      changed: false,
      nextTg: baseTg,
      hasNextSelection: false,
      hasNextHiddenTiers: false,
      hasNextPlayRange: false
    };
  }

  return {
    changed: true,
    nextTg: draft,
    hasNextSelection,
    nextSelection,
    hasNextHiddenTiers,
    nextHiddenTiers,
    hasNextPlayRange,
    nextPlayRange
  };
}

// ============================================================================
// History Timeline Core Operations
// ============================================================================

const BASELINE_META: Record<BaselineKind, { title: string; icon: IconName }> = {
  open: { title: '打开文件', icon: 'folder' },
  blank: { title: '新建空白', icon: 'tab-add' },
  sample: { title: '载入示例', icon: 'samples' },
  cleared: { title: '清空历史基线', icon: 'reset' }
};

export function createBaseline(
  kind: BaselineKind,
  filename: string,
  snapshot: HistoryStateSnapshot
): HistoryBaseline {
  const cfg = BASELINE_META[kind];
  return {
    id: nextBaselineId(),
    title: cfg.title,
    detail: formatDocBaselineDetail(filename, snapshot.tg),
    icon: cfg.icon,
    timestamp: Date.now(),
    snapshot: cloneSnapshot(snapshot)
  };
}

export function createHistoryTimeline(
  kind: BaselineKind,
  filename: string,
  snapshot: HistoryStateSnapshot,
  maxEntries = DEFAULT_HISTORY_LIMIT
): HistoryTimeline {
  const baseline = createBaseline(kind, filename, snapshot);
  return {
    baseline,
    entries: [],
    cursor: -1,
    savedEntryId: baseline.id,
    prunedCount: 0,
    nextStepSeq: 1,
    maxEntries: clampHistoryLimit(maxEntries),
    coalesceEligibleEntryId: null
  };
}

export function getCurrentEntryId(tl: HistoryTimeline): string {
  if (tl.cursor < 0 || tl.cursor >= tl.entries.length) {
    return tl.baseline.id;
  }
  return tl.entries[tl.cursor].id;
}

export function getCurrentSnapshot(tl: HistoryTimeline): HistoryStateSnapshot {
  if (tl.cursor < 0 || tl.cursor >= tl.entries.length) {
    return tl.baseline.snapshot;
  }
  return tl.entries[tl.cursor].snapshot;
}

export function isTimelineDirty(tl: HistoryTimeline): boolean {
  return tl.savedEntryId === null || getCurrentEntryId(tl) !== tl.savedEntryId;
}

export function canUndoTimeline(tl: HistoryTimeline): boolean {
  return tl.cursor >= 0;
}

export function canRedoTimeline(tl: HistoryTimeline): boolean {
  return tl.cursor < tl.entries.length - 1;
}

export function getLatestUndoEntry(tl: HistoryTimeline): HistoryEntry | null {
  if (tl.cursor < 0 || tl.cursor >= tl.entries.length) return null;
  return tl.entries[tl.cursor];
}

export function getLatestRedoEntry(tl: HistoryTimeline): HistoryEntry | null {
  if (tl.cursor + 1 >= tl.entries.length) return null;
  return tl.entries[tl.cursor + 1];
}

function valuesMatchForChain(
  a: number | string | undefined,
  b: number | string | undefined
): boolean {
  if (a === undefined || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-9;
  }
  return a === b;
}

function trimTimelineEntries(
  entries: HistoryEntry[],
  cursor: number,
  maxEntries: number,
  prunedCount: number,
  savedEntryId: string | null
): {
  entries: HistoryEntry[];
  cursor: number;
  prunedCount: number;
  savedEntryId: string | null;
} {
  const nextEntries = [...entries];
  let nextCursor = cursor;
  let nextPruned = prunedCount;
  let nextSavedId = savedEntryId;
  const limit = clampHistoryLimit(maxEntries);

  // Never delete baseline, active cursor, or any entries after cursor
  while (nextEntries.length > limit && nextCursor > 0) {
    const removed = nextEntries.shift()!;
    nextCursor--;
    nextPruned++;
    if (removed.id === nextSavedId) {
      nextSavedId = null;
    }
  }

  return {
    entries: nextEntries,
    cursor: nextCursor,
    prunedCount: nextPruned,
    savedEntryId: nextSavedId
  };
}

export function commitToTimeline(
  tl: HistoryTimeline,
  meta: HistoryActionMeta,
  nextSnapshot: HistoryStateSnapshot,
  now = Date.now()
): HistoryTimeline {
  const safeSnapshot = cloneSnapshot(nextSnapshot);
  const atTail = tl.cursor === tl.entries.length - 1;
  const latest = atTail && tl.cursor >= 0 ? tl.entries[tl.cursor] : null;
  const spec = meta.coalesce;

  const canCoalesce = Boolean(
    latest &&
      spec &&
      tl.coalesceEligibleEntryId === latest.id &&
      latest.id !== tl.savedEntryId &&
      latest.meta.type === meta.type &&
      latest.meta.coalesce &&
      latest.meta.coalesce.key === spec.key &&
      now - latest.timestamp <= (spec.windowMs ?? DEFAULT_COALESCE_WINDOW_MS) &&
      (spec.chainPrevLatest === undefined ||
        valuesMatchForChain(latest.coalesceLatest, spec.chainPrevLatest))
  );

  if (canCoalesce && latest && spec) {
    const nextMergeCount = latest.mergeCount + 1;
    const originVal = latest.coalesceOrigin ?? latest.meta.coalesce?.originValue ?? spec.originValue;
    const latestVal = spec.latestValue;
    const mergedDetail =
      spec.formatMergedDetail && originVal !== undefined && latestVal !== undefined
        ? spec.formatMergedDetail(originVal, latestVal, nextMergeCount)
        : meta.detail;

    const updatedEntry: HistoryEntry = {
      ...latest,
      meta: {
        ...meta,
        detail: mergedDetail
      },
      timestamp: now,
      mergeCount: nextMergeCount,
      coalesceOrigin: originVal,
      coalesceLatest: latestVal,
      snapshot: safeSnapshot
    };

    const nextEntries = tl.entries.slice();
    nextEntries[tl.cursor] = updatedEntry;
    return {
      ...tl,
      entries: nextEntries,
      coalesceEligibleEntryId: updatedEntry.id
    };
  }

  let nextSavedId = tl.savedEntryId;
  let baseEntries: HistoryEntry[];
  if (tl.cursor < tl.entries.length - 1) {
    const discarded = tl.entries.slice(tl.cursor + 1);
    if (nextSavedId !== null && discarded.some((e) => e.id === nextSavedId)) {
      nextSavedId = null;
    }
    baseEntries = tl.entries.slice(0, tl.cursor + 1);
  } else {
    baseEntries = tl.entries.slice();
  }

  const entryId = nextEntryId();
  const newEntry: HistoryEntry = {
    id: entryId,
    stepNumber: tl.nextStepSeq,
    meta,
    timestamp: now,
    mergeCount: 1,
    coalesceOrigin: spec?.originValue,
    coalesceLatest: spec?.latestValue,
    snapshot: safeSnapshot
  };

  const trimmed = trimTimelineEntries(
    [...baseEntries, newEntry],
    baseEntries.length,
    tl.maxEntries,
    tl.prunedCount,
    nextSavedId
  );

  return {
    ...tl,
    entries: trimmed.entries,
    cursor: trimmed.cursor,
    savedEntryId: trimmed.savedEntryId,
    prunedCount: trimmed.prunedCount,
    nextStepSeq: tl.nextStepSeq + 1,
    coalesceEligibleEntryId: spec ? entryId : null
  };
}

export function setTimelineCursor(tl: HistoryTimeline, targetCursor: number): HistoryTimeline {
  const clamped = Math.max(-1, Math.min(tl.entries.length - 1, Math.trunc(targetCursor)));
  if (clamped === tl.cursor && tl.coalesceEligibleEntryId === null) {
    return tl;
  }
  return {
    ...tl,
    cursor: clamped,
    coalesceEligibleEntryId: null
  };
}

export function markTimelineSaved(tl: HistoryTimeline): HistoryTimeline {
  return {
    ...tl,
    savedEntryId: getCurrentEntryId(tl),
    coalesceEligibleEntryId: null
  };
}

export function sealTimelineCoalesce(tl: HistoryTimeline): HistoryTimeline {
  if (tl.coalesceEligibleEntryId === null) return tl;
  return {
    ...tl,
    coalesceEligibleEntryId: null
  };
}

export function setTimelineMaxEntries(tl: HistoryTimeline, maxEntries: number): HistoryTimeline {
  const limit = clampHistoryLimit(maxEntries);
  const trimmed = trimTimelineEntries(tl.entries, tl.cursor, limit, tl.prunedCount, tl.savedEntryId);
  return {
    ...tl,
    maxEntries: limit,
    entries: trimmed.entries,
    cursor: trimmed.cursor,
    prunedCount: trimmed.prunedCount,
    savedEntryId: trimmed.savedEntryId
  };
}

export function clearTimelineToCurrent(
  tl: HistoryTimeline,
  filename: string,
  currentSnapshot: HistoryStateSnapshot
): HistoryTimeline {
  const wasSavedAtCurrent =
    tl.savedEntryId !== null && getCurrentEntryId(tl) === tl.savedEntryId;
  const newBaseline = createBaseline('cleared', filename, currentSnapshot);
  return {
    baseline: newBaseline,
    entries: [],
    cursor: -1,
    savedEntryId: wasSavedAtCurrent ? newBaseline.id : null,
    prunedCount: 0,
    nextStepSeq: 1,
    maxEntries: tl.maxEntries,
    coalesceEligibleEntryId: null
  };
}
