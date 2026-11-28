import type { TextGrid, TextGridFormat } from '../bridge/types';
import type {
  CorpusFileFingerprint,
  CorpusFileStat,
  CorpusItemRecord,
  CorpusItemStatus
} from './types';

export interface CorpusItemDraft {
  itemId: string;
  tgRelPath: string;
  tg: TextGrid;
  format: TextGridFormat;
  baseFingerprint: CorpusFileFingerprint | null;
  hadDiskTextGrid: boolean;
  ipaPreview: string;
  statusOverride?: CorpusItemStatus;
  noteOverride?: string;
  updatedAt: number;
}

export interface SyncDraftWithDirtyOptions {
  isTgDirty: boolean;
  hasMetaOverride?: boolean;
  draft?: CorpusItemDraft;
}

/**
 * 判定磁盘原文件在打开后是否被外部程序（如 Praat）修改、创建或删除。
 * - `base` 为 null 表示加载时磁盘不存在对应 `.TextGrid`；若此时磁盘已出现同名文件，则视为冲突。
 * - `base` 为 `{ size, modifiedMs }` 时，磁盘文件消失、大小变化或修改时间变化均视为冲突。
 * - `current` 为 null/undefined（当前适配器无法探测磁盘状态）时返回 false。
 */
export function hasExternalFileConflict(
  base: CorpusFileFingerprint | null | undefined,
  current: CorpusFileStat | CorpusFileFingerprint | null | undefined,
  hadDiskTextGrid?: boolean
): boolean {
  if (!current) return false;
  const currentExists = 'exists' in current ? current.exists : true;

  if (base == null) {
    if (hadDiskTextGrid === true) {
      return false;
    }
    if (base === null || hadDiskTextGrid === false) {
      return currentExists;
    }
    return false;
  }

  if (!currentExists) {
    return true;
  }

  return base.size !== current.size || base.modifiedMs !== current.modifiedMs;
}

/**
 * 将磁盘词条记录与内存暂存草稿合并为展示视图，不修改原对象。
 */
export function mergeItemWithDraft(
  item: CorpusItemRecord,
  draft: CorpusItemDraft | null | undefined
): CorpusItemRecord {
  if (!draft) return item;
  return {
    ...item,
    ipaPreview: draft.ipaPreview,
    status: draft.statusOverride ?? item.status,
    note: draft.noteOverride ?? item.note,
    updatedAt: Math.max(item.updatedAt, draft.updatedAt)
  };
}

/**
 * 按 projectId 管理词表模式多词条内存暂存区。
 */
export class CorpusDraftManager {
  private readonly projects = new Map<string, Map<string, CorpusItemDraft>>();
  private readonly projectIndexDirtyFlags = new Map<string, boolean>();

  setDraft(projectId: string, draft: CorpusItemDraft): void {
    let bucket = this.projects.get(projectId);
    if (!bucket) {
      bucket = new Map<string, CorpusItemDraft>();
      this.projects.set(projectId, bucket);
    }
    bucket.set(draft.itemId, draft);
  }

  getDraft(projectId: string, itemId: string): CorpusItemDraft | null {
    return this.projects.get(projectId)?.get(itemId) ?? null;
  }

  hasDraft(projectId: string, itemId: string): boolean {
    return this.projects.get(projectId)?.has(itemId) ?? false;
  }

  deleteDraft(projectId: string, itemId: string): boolean {
    const bucket = this.projects.get(projectId);
    if (!bucket) return false;
    const removed = bucket.delete(itemId);
    if (bucket.size === 0) {
      this.projects.delete(projectId);
    }
    return removed;
  }

  /**
   * 写盘完成后竞态保护：仅当内存暂存仍是本次写盘时的同一份快照才清除脏草稿；
   * 若异步写盘期间用户继续编辑产生了新快照，则保留最新草稿不误清。
   */
  clearDraftIfUnchanged(
    projectId: string,
    itemId: string,
    expectedTg: TextGrid,
    expectedUpdatedAt?: number
  ): boolean {
    const current = this.getDraft(projectId, itemId);
    if (!current) return false;
    if (current.tg !== expectedTg) return false;
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
      return false;
    }
    return this.deleteDraft(projectId, itemId);
  }

  /**
   * 根据时间线脏标记（如 Ctrl+Z 撤销回基线）与元数据改写状态同步暂存区。
   * 返回同步后该词条是否仍处于未保存态。
   */
  syncDraftWithDirtyState(
    projectId: string,
    itemId: string,
    opts: SyncDraftWithDirtyOptions
  ): boolean {
    if (!opts.isTgDirty && !opts.hasMetaOverride) {
      this.deleteDraft(projectId, itemId);
      return false;
    }
    if (opts.draft) {
      this.setDraft(projectId, opts.draft);
      return true;
    }
    return this.hasDraft(projectId, itemId);
  }

  clearProject(projectId: string): void {
    this.projects.delete(projectId);
    this.projectIndexDirtyFlags.delete(projectId);
  }

  clearAll(): void {
    this.projects.clear();
    this.projectIndexDirtyFlags.clear();
  }

  getProjectDrafts(projectId: string): CorpusItemDraft[] {
    const bucket = this.projects.get(projectId);
    if (!bucket) return [];
    return Array.from(bucket.values());
  }

  getUnsavedItemIds(projectId: string): string[] {
    const bucket = this.projects.get(projectId);
    if (!bucket) return [];
    return Array.from(bucket.keys());
  }

  getDirtyCount(projectId: string): number {
    return this.projects.get(projectId)?.size ?? 0;
  }

  setProjectIndexDirty(projectId: string, dirty: boolean): void {
    if (dirty) {
      this.projectIndexDirtyFlags.set(projectId, true);
    } else {
      this.projectIndexDirtyFlags.delete(projectId);
    }
  }

  isProjectIndexDirty(projectId: string): boolean {
    return this.projectIndexDirtyFlags.get(projectId) === true;
  }

  isProjectDirty(projectId: string): boolean {
    return this.getDirtyCount(projectId) > 0 || this.isProjectIndexDirty(projectId);
  }

  buildMergedItems(projectId: string, items: CorpusItemRecord[]): CorpusItemRecord[] {
    const bucket = this.projects.get(projectId);
    if (!bucket || bucket.size === 0) return items;
    return items.map((item) => {
      const draft = bucket.get(item.id);
      return draft ? mergeItemWithDraft(item, draft) : item;
    });
  }
}

export const corpusDraftManager = new CorpusDraftManager();
