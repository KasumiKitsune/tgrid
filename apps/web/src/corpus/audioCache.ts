import type { CorpusAudioCacheEntry } from './types';

export type CorpusAudioEvictHandler = (
  sessionId: number,
  entry: CorpusAudioCacheEntry,
  projectId: string
) => void;

export type CorpusAudioCacheInput = Omit<CorpusAudioCacheEntry, 'itemId' | 'lastUsed'> & {
  lastUsed?: number;
};

/**
 * 按 projectId 隔离的轻量音频解码与分析会话 LRU 缓存（默认容量 4）。
 * 覆盖上一条、当前条、下一条及 1 条余量；淘汰或清理时通过回调释放后端会话与频谱缓存。
 */
export class CorpusAudioCache {
  private readonly capacity: number;
  private readonly buckets = new Map<string, Map<string, CorpusAudioCacheEntry>>();
  private defaultOnEvict: CorpusAudioEvictHandler | null;

  constructor(capacity = 4, onEvict?: CorpusAudioEvictHandler) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.defaultOnEvict = onEvict ?? null;
  }

  setOnEvict(handler: CorpusAudioEvictHandler | null): void {
    this.defaultOnEvict = handler;
  }

  private notifyEvict(
    projectId: string,
    entry: CorpusAudioCacheEntry,
    onEvict?: CorpusAudioEvictHandler
  ): void {
    const cb = onEvict ?? this.defaultOnEvict;
    if (!cb) return;
    try {
      cb(entry.analysis.sessionId, entry, projectId);
    } catch {
      // 忽略清理回调中的非致命异常，确保 LRU 状态一致
    }
  }

  get(projectId: string, itemId: string): CorpusAudioCacheEntry | undefined {
    const bucket = this.buckets.get(projectId);
    if (!bucket) return undefined;
    const hit = bucket.get(itemId);
    if (!hit) return undefined;
    hit.lastUsed = Date.now();
    // 移至 Map 尾部，保持头部为最久未使用项
    bucket.delete(itemId);
    bucket.set(itemId, hit);
    return hit;
  }

  has(projectId: string, itemId: string): boolean {
    return this.buckets.get(projectId)?.has(itemId) ?? false;
  }

  set(
    projectId: string,
    itemId: string,
    input: CorpusAudioCacheInput,
    onEvict?: CorpusAudioEvictHandler
  ): CorpusAudioCacheEntry {
    let bucket = this.buckets.get(projectId);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(projectId, bucket);
    }

    const existing = bucket.get(itemId);
    if (existing) {
      bucket.delete(itemId);
      if (existing.analysis.sessionId !== input.analysis.sessionId) {
        this.notifyEvict(projectId, existing, onEvict);
      }
    }

    const entry: CorpusAudioCacheEntry = {
      itemId,
      buffer: input.buffer,
      mono: input.mono,
      analysis: input.analysis,
      lastUsed: input.lastUsed ?? Date.now()
    };
    bucket.set(itemId, entry);

    while (bucket.size > this.capacity) {
      const oldestKey = bucket.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = bucket.get(oldestKey);
      bucket.delete(oldestKey);
      if (oldest) {
        this.notifyEvict(projectId, oldest, onEvict);
      }
    }

    return entry;
  }

  delete(projectId: string, itemId: string, onEvict?: CorpusAudioEvictHandler): boolean {
    const bucket = this.buckets.get(projectId);
    if (!bucket) return false;
    const existing = bucket.get(itemId);
    if (!existing) return false;
    bucket.delete(itemId);
    if (bucket.size === 0) {
      this.buckets.delete(projectId);
    }
    this.notifyEvict(projectId, existing, onEvict);
    return true;
  }

  clearProject(projectId: string, onEvict?: CorpusAudioEvictHandler): void {
    const bucket = this.buckets.get(projectId);
    if (!bucket) return;
    this.buckets.delete(projectId);
    for (const entry of bucket.values()) {
      this.notifyEvict(projectId, entry, onEvict);
    }
  }

  clearAll(onEvict?: CorpusAudioEvictHandler): void {
    const entries = Array.from(this.buckets.entries());
    this.buckets.clear();
    for (const [projectId, bucket] of entries) {
      for (const entry of bucket.values()) {
        this.notifyEvict(projectId, entry, onEvict);
      }
    }
  }

  size(projectId: string): number {
    return this.buckets.get(projectId)?.size ?? 0;
  }
}

export const corpusAudioCache = new CorpusAudioCache(4);
