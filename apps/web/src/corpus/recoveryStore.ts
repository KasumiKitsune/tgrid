import type { TextGrid, TextGridFormat } from '../bridge/types';
import type {
  CorpusFileFingerprint,
  CorpusItemStatus,
  CorpusTierTemplateItem,
  CorpusWorkspaceMode
} from './types';

export const RECOVERY_DB_NAME = 'tgrid_corpus_recovery_v1';
export const RECOVERY_DB_VERSION = 1;

export const RECOVERY_STORE_PROJECTS = 'projects';
export const RECOVERY_STORE_ITEM_DRAFTS = 'itemDrafts';
export const RECOVERY_STORE_ORIGINAL_SNAPSHOTS = 'originalSnapshots';

export const RECOVERY_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RECOVERY_DRAFT_WARN_BYTES = 100 * 1024 * 1024;
export const RECOVERY_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RECOVERY_SNAPSHOT_MAX_BYTES = 30 * 1024 * 1024;

const PROBE_PROJECT_KEY = '__tgrid_idb_probe__';

export interface RecoveryProjectItemMetaDelta {
  status?: CorpusItemStatus;
  note?: string;
  ipaPreview?: string;
  label?: string;
  updatedAt?: number;
}

export interface RecoveryProjectMetaDelta {
  tierTemplate?: CorpusTierTemplateItem[];
  defaultSaveFormat?: TextGridFormat;
  activeItemId?: string | null;
  itemMeta?: Record<string, RecoveryProjectItemMetaDelta>;
}

export interface RecoveryProjectRecord {
  projectKey: string;
  projectName: string;
  mode: CorpusWorkspaceMode;
  nativeDirPath?: string;
  updatedAt: number;
  draftCount: number;
  metaDelta?: RecoveryProjectMetaDelta;
}

export interface RecoveryItemDraftRecord {
  key: string;
  projectKey: string;
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
  approxBytes: number;
}

export interface RecoveryOriginalSnapshotRecord {
  key: string;
  projectKey: string;
  itemId: string;
  tgRelPath: string;
  bytes: Uint8Array;
  sizeBytes: number;
  fingerprint: CorpusFileFingerprint | null;
  updatedAt: number;
}

export interface ProjectRecoveryBundle {
  project: RecoveryProjectRecord | null;
  drafts: RecoveryItemDraftRecord[];
}

export interface RecoveryProbeResult {
  available: boolean;
  degraded: boolean;
  reason?: string;
}

export interface RecoveryStorageStats {
  degraded: boolean;
  projectCount: number;
  draftCount: number;
  draftBytes: number;
  snapshotCount: number;
  snapshotBytes: number;
  totalBytes: number;
  overDraftWarnLimit: boolean;
}

export interface RecoveryPruneResult {
  removedDrafts: number;
  removedSnapshots: number;
  removedProjects: number;
  freedBytes: number;
}

export type SaveItemDraftRecoveryInput = Omit<RecoveryItemDraftRecord, 'key' | 'approxBytes'> & {
  approxBytes?: number;
};

export interface SaveOriginalSnapshotInput {
  projectKey: string;
  itemId: string;
  tgRelPath: string;
  bytes: Uint8Array;
  fingerprint?: CorpusFileFingerprint | null;
  updatedAt?: number;
  overwrite?: boolean;
}

/**
 * 基于文件夹名与排序后的文件名列表（音频与 TextGrid），计算确定性 FNV-1a 32 位哈希（8 位小写十六进制）。
 * 解决 Web 端不同路径下的同名文件夹互相冲突问题。
 */
export function computeCorpusDirFingerprint(dirName: string, fileNames: string[]): string {
  const normDir = (dirName || '').trim().toLowerCase();
  const uniqueNames = new Set<string>();
  for (const name of fileNames) {
    const cleaned = (name || '').trim().toLowerCase();
    if (cleaned) {
      uniqueNames.add(cleaned);
    }
  }
  const sortedNames = Array.from(uniqueNames).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const payload = `${normDir}\0${sortedNames.join('\0')}`;
  const bytes = new TextEncoder().encode(payload);

  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 生成带 FNV-1a 指纹的 Web 词表项目唯一键。
 */
export function buildWebCorpusRootKey(
  mode: 'web-fsa' | 'web-fallback',
  dirName: string,
  fileNames: string[]
): string {
  const cleanDir = (dirName || '语料文件夹').trim() || '语料文件夹';
  const hash = computeCorpusDirFingerprint(cleanDir, fileNames);
  return `${mode}:${cleanDir}:${hash}`;
}

export function shouldSkipRecovery(projectKey: string): boolean {
  return !projectKey || projectKey.startsWith('sample:') || projectKey === PROBE_PROJECT_KEY;
}

export function makeRecoveryItemKey(projectKey: string, itemId: string): string {
  return `${projectKey}::${itemId}`;
}

function estimateTextGridBytes(tg: TextGrid): number {
  let bytes = 128 + (tg.name?.length ?? 0) * 2;
  if (!Array.isArray(tg.tiers)) return bytes;
  for (const tier of tg.tiers) {
    bytes += 96 + (tier.name?.length ?? 0) * 2;
    if (Array.isArray(tier.intervals)) {
      for (const iv of tier.intervals) {
        bytes += 40 + (iv.text?.length ?? 0) * 2;
      }
    }
    if (Array.isArray(tier.points)) {
      for (const pt of tier.points) {
        bytes += 32 + (pt.mark?.length ?? 0) * 2;
      }
    }
  }
  return bytes;
}

function estimateDraftBytes(draft: {
  tg: TextGrid;
  tgRelPath: string;
  ipaPreview: string;
  noteOverride?: string;
}): number {
  return (
    estimateTextGridBytes(draft.tg) +
    (draft.tgRelPath?.length ?? 0) * 2 +
    (draft.ipaPreview?.length ?? 0) * 2 +
    (draft.noteOverride?.length ?? 0) * 2 +
    160
  );
}

let cachedProbe: RecoveryProbeResult | null = null;
let inflightProbe: Promise<RecoveryProbeResult> | null = null;

export function isRecoveryStorageDegraded(): boolean {
  return cachedProbe?.degraded === true;
}

function openRecoveryDbRaw(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      resolve(db);
    };
    try {
      const req = indexedDB.open(RECOVERY_DB_NAME, RECOVERY_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(RECOVERY_STORE_PROJECTS)) {
          db.createObjectStore(RECOVERY_STORE_PROJECTS, { keyPath: 'projectKey' });
        }
        if (!db.objectStoreNames.contains(RECOVERY_STORE_ITEM_DRAFTS)) {
          const store = db.createObjectStore(RECOVERY_STORE_ITEM_DRAFTS, { keyPath: 'key' });
          store.createIndex('byProject', 'projectKey', { unique: false });
          store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(RECOVERY_STORE_ORIGINAL_SNAPSHOTS)) {
          const store = db.createObjectStore(RECOVERY_STORE_ORIGINAL_SNAPSHOTS, {
            keyPath: 'key'
          });
          store.createIndex('byProject', 'projectKey', { unique: false });
          store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
        }
      };
      req.onsuccess = () => finish(req.result);
      req.onerror = () => finish(null);
      req.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

/**
 * 轻量探活 IndexedDB（特别针对单文件离线 HTML 的 file:// 协议安全限制）。
 * 禁用或报错时静默降级，返回 { available: false, degraded: true }，绝不抛出未捕获异常。
 */
export async function probeRecoveryStorage(force = false): Promise<RecoveryProbeResult> {
  if (!force && cachedProbe) return cachedProbe;
  if (!force && inflightProbe) return inflightProbe;

  const task = (async (): Promise<RecoveryProbeResult> => {
    if (typeof indexedDB === 'undefined') {
      const res: RecoveryProbeResult = {
        available: false,
        degraded: true,
        reason: '当前运行环境不支持本地缓存数据库'
      };
      cachedProbe = res;
      return res;
    }

    const db = await openRecoveryDbRaw();
    if (!db) {
      const res: RecoveryProbeResult = {
        available: false,
        degraded: true,
        reason: '浏览器限制了本地缓存访问，已降级为纯内存暂存'
      };
      cachedProbe = res;
      return res;
    }

    const ok = await new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction(RECOVERY_STORE_PROJECTS, 'readwrite');
        const store = tx.objectStore(RECOVERY_STORE_PROJECTS);
        store.put({
          projectKey: PROBE_PROJECT_KEY,
          projectName: '',
          mode: 'web-fallback',
          updatedAt: Date.now(),
          draftCount: 0
        } satisfies RecoveryProjectRecord);
        store.delete(PROBE_PROJECT_KEY);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });

    try {
      db.close();
    } catch {
      // ignore close errors
    }

    const res: RecoveryProbeResult = ok
      ? { available: true, degraded: false }
      : {
          available: false,
          degraded: true,
          reason: '浏览器禁止写入本地缓存，已降级为纯内存暂存'
        };
    cachedProbe = res;
    return res;
  })();

  inflightProbe = task;
  try {
    return await task;
  } finally {
    if (inflightProbe === task) {
      inflightProbe = null;
    }
  }
}

async function openUsableDb(): Promise<IDBDatabase | null> {
  const probe = await probeRecoveryStorage();
  if (!probe.available) return null;
  const db = await openRecoveryDbRaw();
  if (!db) {
    cachedProbe = {
      available: false,
      degraded: true,
      reason: '无法打开本地恢复缓存数据库'
    };
    return null;
  }
  return db;
}

function runReadonly<T>(
  db: IDBDatabase,
  storeNames: string | string[],
  executor: (tx: IDBTransaction) => Promise<T>,
  fallback: T
): Promise<T> {
  return new Promise<T>((resolve) => {
    let finished = false;
    const done = (val: T) => {
      if (finished) return;
      finished = true;
      try {
        db.close();
      } catch {
        // ignore
      }
      resolve(val);
    };
    try {
      const tx = db.transaction(storeNames, 'readonly');
      tx.onerror = () => done(fallback);
      tx.onabort = () => done(fallback);
      executor(tx)
        .then((res) => done(res))
        .catch(() => done(fallback));
    } catch {
      done(fallback);
    }
  });
}

function runReadwrite<T>(
  db: IDBDatabase,
  storeNames: string | string[],
  executor: (tx: IDBTransaction) => Promise<T> | T,
  fallback: T
): Promise<T> {
  return new Promise<T>((resolve) => {
    let finished = false;
    let resultVal: T = fallback;
    const done = (val: T) => {
      if (finished) return;
      finished = true;
      try {
        db.close();
      } catch {
        // ignore
      }
      resolve(val);
    };
    try {
      const tx = db.transaction(storeNames, 'readwrite');
      tx.oncomplete = () => done(resultVal);
      tx.onerror = () => done(fallback);
      tx.onabort = () => done(fallback);
      Promise.resolve(executor(tx))
        .then((res) => {
          resultVal = res;
        })
        .catch(() => {
          try {
            tx.abort();
          } catch {
            // ignore
          }
          done(fallback);
        });
    } catch {
      done(fallback);
    }
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function normalizeSnapshotRecord(raw: RecoveryOriginalSnapshotRecord): RecoveryOriginalSnapshotRecord {
  const bytes =
    raw.bytes instanceof Uint8Array
      ? raw.bytes
      : new Uint8Array(raw.bytes as unknown as ArrayBuffer);
  return {
    ...raw,
    bytes,
    sizeBytes: typeof raw.sizeBytes === 'number' && raw.sizeBytes >= 0 ? raw.sizeBytes : bytes.byteLength
  };
}

export async function saveProjectRecoveryMeta(
  record: Omit<RecoveryProjectRecord, 'updatedAt'> & { updatedAt?: number }
): Promise<boolean> {
  if (shouldSkipRecovery(record.projectKey)) return false;
  const db = await openUsableDb();
  if (!db) return false;

  const full: RecoveryProjectRecord = {
    ...record,
    updatedAt: record.updatedAt ?? Date.now()
  };

  return runReadwrite(
    db,
    RECOVERY_STORE_PROJECTS,
    (tx) => {
      tx.objectStore(RECOVERY_STORE_PROJECTS).put(full);
      return true;
    },
    false
  );
}

export async function getProjectRecoveryMeta(
  projectKey: string
): Promise<RecoveryProjectRecord | null> {
  if (shouldSkipRecovery(projectKey)) return null;
  const db = await openUsableDb();
  if (!db) return null;

  return runReadonly(
    db,
    RECOVERY_STORE_PROJECTS,
    async (tx) => {
      const row = (await reqToPromise(
        tx.objectStore(RECOVERY_STORE_PROJECTS).get(projectKey)
      )) as RecoveryProjectRecord | undefined;
      return row ?? null;
    },
    null
  );
}

export async function listRecoveryProjects(): Promise<RecoveryProjectRecord[]> {
  const db = await openUsableDb();
  if (!db) return [];

  return runReadonly(
    db,
    RECOVERY_STORE_PROJECTS,
    async (tx) => {
      const rows = (await reqToPromise(
        tx.objectStore(RECOVERY_STORE_PROJECTS).getAll()
      )) as RecoveryProjectRecord[];
      return (rows || [])
        .filter((r) => r && !shouldSkipRecovery(r.projectKey))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    },
    []
  );
}

export async function saveItemDraftRecovery(
  draft: SaveItemDraftRecoveryInput,
  projectHeader?: {
    projectName: string;
    mode: CorpusWorkspaceMode;
    nativeDirPath?: string;
    metaDelta?: RecoveryProjectMetaDelta;
  }
): Promise<boolean> {
  if (shouldSkipRecovery(draft.projectKey)) return false;
  const db = await openUsableDb();
  if (!db) return false;

  const record: RecoveryItemDraftRecord = {
    ...draft,
    key: makeRecoveryItemKey(draft.projectKey, draft.itemId),
    approxBytes: draft.approxBytes ?? estimateDraftBytes(draft)
  };

  const stores = projectHeader
    ? [RECOVERY_STORE_ITEM_DRAFTS, RECOVERY_STORE_PROJECTS]
    : [RECOVERY_STORE_ITEM_DRAFTS];

  return runReadwrite(
    db,
    stores,
    async (tx) => {
      const draftStore = tx.objectStore(RECOVERY_STORE_ITEM_DRAFTS);
      draftStore.put(record);
      if (projectHeader) {
        const projStore = tx.objectStore(RECOVERY_STORE_PROJECTS);
        const existing = (await reqToPromise(projStore.get(draft.projectKey))) as
          | RecoveryProjectRecord
          | undefined;
        const idx = draftStore.index('byProject');
        const allKeys = (await reqToPromise(
          idx.getAllKeys(IDBKeyRange.only(draft.projectKey))
        )) as IDBValidKey[];
        projStore.put({
          projectKey: draft.projectKey,
          projectName: projectHeader.projectName || existing?.projectName || '语料文件夹',
          mode: projectHeader.mode || existing?.mode || 'web-fallback',
          nativeDirPath: projectHeader.nativeDirPath ?? existing?.nativeDirPath,
          updatedAt: Math.max(record.updatedAt, Date.now()),
          draftCount: Math.max(1, allKeys.length),
          metaDelta: projectHeader.metaDelta ?? existing?.metaDelta
        } satisfies RecoveryProjectRecord);
      }
      return true;
    },
    false
  );
}

export async function deleteItemDraftRecovery(projectKey: string, itemId: string): Promise<void> {
  if (shouldSkipRecovery(projectKey)) return;
  const db = await openUsableDb();
  if (!db) return;

  await runReadwrite(
    db,
    [RECOVERY_STORE_ITEM_DRAFTS, RECOVERY_STORE_PROJECTS],
    async (tx) => {
      const draftStore = tx.objectStore(RECOVERY_STORE_ITEM_DRAFTS);
      draftStore.delete(makeRecoveryItemKey(projectKey, itemId));

      const idx = draftStore.index('byProject');
      const remainingKeys = (await reqToPromise(
        idx.getAllKeys(IDBKeyRange.only(projectKey))
      )) as IDBValidKey[];

      const projStore = tx.objectStore(RECOVERY_STORE_PROJECTS);
      const proj = (await reqToPromise(projStore.get(projectKey))) as
        | RecoveryProjectRecord
        | undefined;
      if (proj) {
        const hasMetaDelta = Boolean(
          proj.metaDelta &&
            ((proj.metaDelta.itemMeta && Object.keys(proj.metaDelta.itemMeta).length > 0) ||
              proj.metaDelta.tierTemplate ||
              proj.metaDelta.defaultSaveFormat)
        );
        if (remainingKeys.length === 0 && !hasMetaDelta) {
          projStore.delete(projectKey);
        } else {
          projStore.put({
            ...proj,
            draftCount: remainingKeys.length,
            updatedAt: Date.now()
          });
        }
      }
      return true;
    },
    false
  );
}

export async function loadProjectRecovery(
  projectKey: string
): Promise<ProjectRecoveryBundle | null> {
  if (shouldSkipRecovery(projectKey)) return null;
  const db = await openUsableDb();
  if (!db) return null;

  return runReadonly(
    db,
    [RECOVERY_STORE_PROJECTS, RECOVERY_STORE_ITEM_DRAFTS],
    async (tx) => {
      const project = ((await reqToPromise(
        tx.objectStore(RECOVERY_STORE_PROJECTS).get(projectKey)
      )) ?? null) as RecoveryProjectRecord | null;
      const idx = tx.objectStore(RECOVERY_STORE_ITEM_DRAFTS).index('byProject');
      const drafts = (await reqToPromise(
        idx.getAll(IDBKeyRange.only(projectKey))
      )) as RecoveryItemDraftRecord[];
      const sortedDrafts = (drafts || []).sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
      if (!project && sortedDrafts.length === 0) {
        return null;
      }
      return { project, drafts: sortedDrafts };
    },
    null
  );
}

export async function deleteProjectRecovery(
  projectKey: string,
  opts?: { includeSnapshots?: boolean }
): Promise<void> {
  if (shouldSkipRecovery(projectKey)) return;
  const db = await openUsableDb();
  if (!db) return;

  const storeNames = opts?.includeSnapshots
    ? [RECOVERY_STORE_PROJECTS, RECOVERY_STORE_ITEM_DRAFTS, RECOVERY_STORE_ORIGINAL_SNAPSHOTS]
    : [RECOVERY_STORE_PROJECTS, RECOVERY_STORE_ITEM_DRAFTS];

  await runReadwrite(
    db,
    storeNames,
    async (tx) => {
      tx.objectStore(RECOVERY_STORE_PROJECTS).delete(projectKey);

      const draftStore = tx.objectStore(RECOVERY_STORE_ITEM_DRAFTS);
      const draftKeys = (await reqToPromise(
        draftStore.index('byProject').getAllKeys(IDBKeyRange.only(projectKey))
      )) as IDBValidKey[];
      for (const k of draftKeys) {
        draftStore.delete(k);
      }

      if (opts?.includeSnapshots) {
        const snapStore = tx.objectStore(RECOVERY_STORE_ORIGINAL_SNAPSHOTS);
        const snapKeys = (await reqToPromise(
          snapStore.index('byProject').getAllKeys(IDBKeyRange.only(projectKey))
        )) as IDBValidKey[];
        for (const k of snapKeys) {
          snapStore.delete(k);
        }
      }
      return true;
    },
    false
  );
}

/**
 * 首次覆写磁盘原文件前留存一份原件字节快照（默认每条仅留存首份原件，不覆盖更早的原件）。
 */
export async function saveOriginalSnapshotOnce(
  input: SaveOriginalSnapshotInput
): Promise<boolean> {
  if (shouldSkipRecovery(input.projectKey)) return false;
  const db = await openUsableDb();
  if (!db) return false;

  const key = makeRecoveryItemKey(input.projectKey, input.itemId);
  const copy = input.bytes.slice();
  const record: RecoveryOriginalSnapshotRecord = {
    key,
    projectKey: input.projectKey,
    itemId: input.itemId,
    tgRelPath: input.tgRelPath,
    bytes: copy,
    sizeBytes: copy.byteLength,
    fingerprint: input.fingerprint ?? null,
    updatedAt: input.updatedAt ?? Date.now()
  };

  return runReadwrite(
    db,
    RECOVERY_STORE_ORIGINAL_SNAPSHOTS,
    async (tx) => {
      const store = tx.objectStore(RECOVERY_STORE_ORIGINAL_SNAPSHOTS);
      if (!input.overwrite) {
        const existing = await reqToPromise(store.get(key));
        if (existing) return false;
      }
      store.put(record);
      return true;
    },
    false
  );
}

export async function getOriginalSnapshot(
  projectKey: string,
  itemId: string
): Promise<RecoveryOriginalSnapshotRecord | null> {
  if (shouldSkipRecovery(projectKey)) return null;
  const db = await openUsableDb();
  if (!db) return null;

  return runReadonly(
    db,
    RECOVERY_STORE_ORIGINAL_SNAPSHOTS,
    async (tx) => {
      const row = (await reqToPromise(
        tx
          .objectStore(RECOVERY_STORE_ORIGINAL_SNAPSHOTS)
          .get(makeRecoveryItemKey(projectKey, itemId))
      )) as RecoveryOriginalSnapshotRecord | undefined;
      return row ? normalizeSnapshotRecord(row) : null;
    },
    null
  );
}

export async function listOriginalSnapshots(
  projectKey: string
): Promise<RecoveryOriginalSnapshotRecord[]> {
  if (shouldSkipRecovery(projectKey)) return [];
  const db = await openUsableDb();
  if (!db) return [];

  return runReadonly(
    db,
    RECOVERY_STORE_ORIGINAL_SNAPSHOTS,
    async (tx) => {
      const rows = (await reqToPromise(
        tx
          .objectStore(RECOVERY_STORE_ORIGINAL_SNAPSHOTS)
          .index('byProject')
          .getAll(IDBKeyRange.only(projectKey))
      )) as RecoveryOriginalSnapshotRecord[];
      return (rows || []).map(normalizeSnapshotRecord);
    },
    []
  );
}

export async function deleteOriginalSnapshot(projectKey: string, itemId: string): Promise<void> {
  if (shouldSkipRecovery(projectKey)) return;
  const db = await openUsableDb();
  if (!db) return;

  await runReadwrite(
    db,
    RECOVERY_STORE_ORIGINAL_SNAPSHOTS,
    (tx) => {
      tx.objectStore(RECOVERY_STORE_ORIGINAL_SNAPSHOTS).delete(
        makeRecoveryItemKey(projectKey, itemId)
      );
      return true;
    },
    false
  );
}

/**
 * 执行定时与配额回收：
 * - 清理超过 30 天的异常退出草稿与无草稿且超期的项目记录；
 * - 清理超过 7 天的覆写前原件快照，并在原件快照总大小超过 30MB 时按最旧优先淘汰。
 */
export async function pruneRecoveryStorage(now = Date.now()): Promise<RecoveryPruneResult> {
  const empty: RecoveryPruneResult = {
    removedDrafts: 0,
    removedSnapshots: 0,
    removedProjects: 0,
    freedBytes: 0
  };
  const db = await openUsableDb();
  if (!db) return empty;

  const draftCutoff = now - RECOVERY_DRAFT_TTL_MS;
  const snapshotCutoff = now - RECOVERY_SNAPSHOT_TTL_MS;

  return runReadwrite(
    db,
    [RECOVERY_STORE_PROJECTS, RECOVERY_STORE_ITEM_DRAFTS, RECOVERY_STORE_ORIGINAL_SNAPSHOTS],
    async (tx) => {
      const result: RecoveryPruneResult = { ...empty };

      const draftStore = tx.objectStore(RECOVERY_STORE_ITEM_DRAFTS);
      const allDrafts = (await reqToPromise(draftStore.getAll())) as RecoveryItemDraftRecord[];
      const liveDraftCountByProject = new Map<string, number>();

      for (const draft of allDrafts || []) {
        if ((draft.updatedAt ?? 0) < draftCutoff) {
          draftStore.delete(draft.key);
          result.removedDrafts += 1;
          result.freedBytes += draft.approxBytes ?? 0;
        } else {
          liveDraftCountByProject.set(
            draft.projectKey,
            (liveDraftCountByProject.get(draft.projectKey) ?? 0) + 1
          );
        }
      }

      const projStore = tx.objectStore(RECOVERY_STORE_PROJECTS);
      const allProjects = (await reqToPromise(projStore.getAll())) as RecoveryProjectRecord[];
      for (const proj of allProjects || []) {
        if (proj.projectKey === PROBE_PROJECT_KEY) {
          projStore.delete(proj.projectKey);
          continue;
        }
        const liveCount = liveDraftCountByProject.get(proj.projectKey) ?? 0;
        const hasMetaDelta = Boolean(
          proj.metaDelta &&
            ((proj.metaDelta.itemMeta && Object.keys(proj.metaDelta.itemMeta).length > 0) ||
              proj.metaDelta.tierTemplate ||
              proj.metaDelta.defaultSaveFormat)
        );
        if (liveCount === 0 && (!hasMetaDelta || (proj.updatedAt ?? 0) < draftCutoff)) {
          projStore.delete(proj.projectKey);
          result.removedProjects += 1;
        } else if (proj.draftCount !== liveCount) {
          projStore.put({ ...proj, draftCount: liveCount });
        }
      }

      const snapStore = tx.objectStore(RECOVERY_STORE_ORIGINAL_SNAPSHOTS);
      const allSnaps = (await reqToPromise(
        snapStore.getAll()
      )) as RecoveryOriginalSnapshotRecord[];
      const keptSnaps: RecoveryOriginalSnapshotRecord[] = [];

      for (const rawSnap of allSnaps || []) {
        const snap = normalizeSnapshotRecord(rawSnap);
        if ((snap.updatedAt ?? 0) < snapshotCutoff) {
          snapStore.delete(snap.key);
          result.removedSnapshots += 1;
          result.freedBytes += snap.sizeBytes;
        } else {
          keptSnaps.push(snap);
        }
      }

      let totalSnapBytes = keptSnaps.reduce((acc, s) => acc + s.sizeBytes, 0);
      if (totalSnapBytes > RECOVERY_SNAPSHOT_MAX_BYTES) {
        keptSnaps.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
        for (const snap of keptSnaps) {
          if (totalSnapBytes <= RECOVERY_SNAPSHOT_MAX_BYTES) break;
          snapStore.delete(snap.key);
          totalSnapBytes -= snap.sizeBytes;
          result.removedSnapshots += 1;
          result.freedBytes += snap.sizeBytes;
        }
      }

      return result;
    },
    empty
  );
}

/**
 * 供偏好设置页展示本地恢复缓存占用统计。
 */
export async function getRecoveryStorageStats(): Promise<RecoveryStorageStats> {
  const probe = await probeRecoveryStorage();
  if (!probe.available) {
    return {
      degraded: true,
      projectCount: 0,
      draftCount: 0,
      draftBytes: 0,
      snapshotCount: 0,
      snapshotBytes: 0,
      totalBytes: 0,
      overDraftWarnLimit: false
    };
  }

  const db = await openRecoveryDbRaw();
  if (!db) {
    return {
      degraded: true,
      projectCount: 0,
      draftCount: 0,
      draftBytes: 0,
      snapshotCount: 0,
      snapshotBytes: 0,
      totalBytes: 0,
      overDraftWarnLimit: false
    };
  }

  return runReadonly<RecoveryStorageStats>(
    db,
    [RECOVERY_STORE_PROJECTS, RECOVERY_STORE_ITEM_DRAFTS, RECOVERY_STORE_ORIGINAL_SNAPSHOTS],
    async (tx) => {
      const projects = ((await reqToPromise(
        tx.objectStore(RECOVERY_STORE_PROJECTS).getAll()
      )) as RecoveryProjectRecord[]).filter((p) => p && !shouldSkipRecovery(p.projectKey));
      const drafts = (await reqToPromise(
        tx.objectStore(RECOVERY_STORE_ITEM_DRAFTS).getAll()
      )) as RecoveryItemDraftRecord[];
      const snaps = (await reqToPromise(
        tx.objectStore(RECOVERY_STORE_ORIGINAL_SNAPSHOTS).getAll()
      )) as RecoveryOriginalSnapshotRecord[];

      let draftBytes = 0;
      for (const d of drafts || []) {
        draftBytes +=
          typeof d.approxBytes === 'number' && d.approxBytes > 0
            ? d.approxBytes
            : estimateDraftBytes(d);
      }

      let snapshotBytes = 0;
      for (const s of snaps || []) {
        const size =
          typeof s.sizeBytes === 'number' && s.sizeBytes >= 0
            ? s.sizeBytes
            : s.bytes instanceof Uint8Array
              ? s.bytes.byteLength
              : 0;
        snapshotBytes += size;
      }

      const totalBytes = draftBytes + snapshotBytes;
      return {
        degraded: false,
        projectCount: projects.length,
        draftCount: (drafts || []).length,
        draftBytes,
        snapshotCount: (snaps || []).length,
        snapshotBytes,
        totalBytes,
        overDraftWarnLimit: draftBytes >= RECOVERY_DRAFT_WARN_BYTES
      };
    },
    {
      degraded: true,
      projectCount: 0,
      draftCount: 0,
      draftBytes: 0,
      snapshotCount: 0,
      snapshotBytes: 0,
      totalBytes: 0,
      overDraftWarnLimit: false
    }
  );
}

/**
 * 供偏好设置页「清理过期备份」按钮调用：
 * 默认回收超期草稿（>30 天）与超期/超额原件备份（>7 天或 >30MB）；
 * 传入 { clearAllSnapshots: true } 时可清空全部原件备份（不影响未保存崩溃草稿）。
 */
export async function clearExpiredRecoverySnapshots(opts?: {
  clearAllSnapshots?: boolean;
  now?: number;
}): Promise<RecoveryPruneResult> {
  const base = await pruneRecoveryStorage(opts?.now);
  if (!opts?.clearAllSnapshots) {
    return base;
  }

  const db = await openUsableDb();
  if (!db) return base;

  const extra = await runReadwrite(
    db,
    RECOVERY_STORE_ORIGINAL_SNAPSHOTS,
    async (tx) => {
      const store = tx.objectStore(RECOVERY_STORE_ORIGINAL_SNAPSHOTS);
      const snaps = (await reqToPromise(store.getAll())) as RecoveryOriginalSnapshotRecord[];
      let removed = 0;
      let freed = 0;
      for (const rawSnap of snaps || []) {
        const snap = normalizeSnapshotRecord(rawSnap);
        store.delete(snap.key);
        removed += 1;
        freed += snap.sizeBytes;
      }
      return { removed, freed };
    },
    { removed: 0, freed: 0 }
  );

  return {
    removedDrafts: base.removedDrafts,
    removedProjects: base.removedProjects,
    removedSnapshots: base.removedSnapshots + extra.removed,
    freedBytes: base.freedBytes + extra.freed
  };
}
