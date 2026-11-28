import type { DroppedPathInfo } from '../bridge/types';

export const BULK_DROP_NEW_TAB_THRESHOLD = 5;
export const BULK_DROP_STANDALONE_AUDIO_THRESHOLD = 2;
export const BULK_DROP_DIRECTORY_THRESHOLD = 2;
export const BULK_DROP_TOTAL_ENTRIES_THRESHOLD = 8;
export const BULK_DROP_MAX_INDIVIDUAL_TABS = 20;

const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm', 'opus']);
const DOC_EXTENSIONS = new Set(['textgrid', 'collection', 'intervaltier', 'texttier', 'txt']);
const IGNORED_SYSTEM_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

export interface DropDirectoryHandleLike {
  kind: 'directory';
  name: string;
  entries(): AsyncIterableIterator<[string, unknown]>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<unknown>;
  queryPermission?(opts?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(opts?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export interface DropInputEntry {
  id: string;
  name: string;
  isDir: boolean;
  size: number;
  path?: string | null;
  parentDir?: string | null;
  file?: File | null;
  /** Web 端拖入文件夹时，优先保留可写 File System Access 目录句柄 */
  dirHandle?: DropDirectoryHandleLike | null;
  /** Web 端降级 webkitGetAsEntry 读取到的一级文件列表 */
  dirFiles?: File[] | null;
}

export interface DropDirectoryCandidate {
  id: string;
  name: string;
  path?: string | null;
  dirHandle?: DropDirectoryHandleLike | null;
  dirFiles?: File[] | null;
  alreadyOpenTabId: string | null;
}

export type DropOpenUnitKind = 'paired' | 'doc' | 'audio';

export interface DropOpenUnit {
  id: string;
  kind: DropOpenUnitKind;
  stem: string;
  label: string;
  size: number;
  doc?: DropInputEntry;
  audio?: DropInputEntry;
  alreadyOpenTabId: string | null;
}

export interface DropAlreadyOpenItem {
  id: string;
  name: string;
  tabId: string;
  isDir: boolean;
  path?: string | null;
}

export interface DropUnsupportedItem {
  id: string;
  name: string;
  size: number;
}

export type DropCorpusRecommendation =
  | {
      mode: 'tauri-dir';
      dirPath: string;
      folderName: string;
      preferredItemStem?: string;
      itemCount: number;
    }
  | {
      mode: 'web-files';
      folderName: string;
      files: File[];
      itemCount: number;
    };

export interface DropExistingMatcher {
  findOpenFileTabId?: (path: string) => string | null;
  findOpenCorpusTabId?: (dirPath: string) => string | null;
}

export type DropIntakeDecision = 'empty' | 'switch-existing' | 'direct' | 'confirm';

export interface DropIntakePlan {
  totalRawCount: number;
  directories: DropDirectoryCandidate[];
  openUnits: DropOpenUnit[];
  alreadyOpen: DropAlreadyOpenItem[];
  unsupported: DropUnsupportedItem[];
  pairedCount: number;
  standaloneDocCount: number;
  standaloneAudioCount: number;
  newDirectoryCount: number;
  estimatedNewTabs: number;
  selectableNewCount: number;
  exceedsIndividualCap: boolean;
  corpusRecommendation: DropCorpusRecommendation | null;
  decision: DropIntakeDecision;
  triggerReasons: string[];
}

export function splitFileStemAndExt(filename: string): { stem: string; ext: string } {
  const base = filename.split(/[\\/]/).pop() || filename;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return { stem: base, ext: '' };
  return {
    stem: base.slice(0, dot),
    ext: base.slice(dot + 1).toLowerCase()
  };
}

export function classifyExtension(filename: string): 'doc' | 'audio' | 'unsupported' {
  const base = (filename.split(/[\\/]/).pop() || filename).trim();
  if (!base) return 'unsupported';
  const lower = base.toLowerCase();
  if (IGNORED_SYSTEM_NAMES.has(lower) || base.startsWith('.')) {
    return 'unsupported';
  }
  const { stem, ext } = splitFileStemAndExt(base);
  if (!stem || !ext) return 'unsupported';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (DOC_EXTENSIONS.has(ext)) return 'doc';
  return 'unsupported';
}

export function normalizeDropPathKey(rawPath: string): string {
  return rawPath.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

export function getDirDisplayName(dirPath: string): string {
  const cleaned = dirPath.trim().replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned || '语料文件夹';
}

export function formatFileSizeShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function entriesFromDroppedPaths(infos: DroppedPathInfo[]): DropInputEntry[] {
  const seen = new Set<string>();
  const result: DropInputEntry[] = [];
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    if (!info || !info.exists || !info.path) continue;
    const key = normalizeDropPathKey(info.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: `path_${i}_${key}`,
      name: info.name || getDirDisplayName(info.path),
      isDir: Boolean(info.isDir),
      size: info.isDir ? 0 : Math.max(0, info.size || 0),
      path: info.path,
      parentDir: info.parentDir || ''
    });
  }
  return result;
}

export function entriesFromFiles(files: FileList | File[]): DropInputEntry[] {
  const list = Array.from(files);
  return list.map((file, i) => ({
    id: `file_${i}_${file.name}_${file.size}_${file.lastModified}`,
    name: file.name,
    isDir: false,
    size: file.size,
    path: null,
    parentDir: null,
    file
  }));
}

interface WebKitEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, error?: (err: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      success: (entries: WebKitEntryLike[]) => void,
      error?: (err: unknown) => void
    ) => void;
  };
}

function readWebKitFileEntry(entry: WebKitEntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    if (!entry.file) {
      resolve(null);
      return;
    }
    try {
      entry.file(
        (file) => resolve(file),
        () => resolve(null)
      );
    } catch {
      resolve(null);
    }
  });
}

async function readWebKitDirTopLevelFiles(dirEntry: WebKitEntryLike): Promise<File[]> {
  if (!dirEntry.createReader) return [];
  const reader = dirEntry.createReader();
  const childEntries: WebKitEntryLike[] = [];

  for (let guard = 0; guard < 128; guard++) {
    const batch = await new Promise<WebKitEntryLike[]>((resolve) => {
      try {
        reader.readEntries(
          (rows) => resolve(rows || []),
          () => resolve([])
        );
      } catch {
        resolve([]);
      }
    });
    if (batch.length === 0) break;
    childEntries.push(...batch);
  }

  const files: File[] = [];
  for (const child of childEntries) {
    if (!child.isFile) continue;
    const f = await readWebKitFileEntry(child);
    if (f) files.push(f);
  }
  return files;
}

function isFsaDirectoryHandle(raw: unknown): raw is DropDirectoryHandleLike {
  return (
    Boolean(raw) &&
    typeof raw === 'object' &&
    (raw as { kind?: unknown }).kind === 'directory' &&
    typeof (raw as { entries?: unknown }).entries === 'function'
  );
}

function isFsaFileHandle(raw: unknown): raw is { kind: 'file'; name: string; getFile: () => Promise<File> } {
  return (
    Boolean(raw) &&
    typeof raw === 'object' &&
    (raw as { kind?: unknown }).kind === 'file' &&
    typeof (raw as { getFile?: unknown }).getFile === 'function'
  );
}

/**
 * 从浏览器的 DragEvent.dataTransfer 中轻量提取拖入条目。
 * 必须在 drop 事件同步栈中调用，避免浏览器清空 DataTransferItemList。
 */
export async function extractWebDropEntries(dataTransfer: DataTransfer): Promise<DropInputEntry[]> {
  const rawItems = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  if (rawItems.length === 0) {
    return dataTransfer.files?.length ? entriesFromFiles(dataTransfer.files) : [];
  }

  interface SyncCapturedItem {
    index: number;
    handlePromise: Promise<unknown> | null;
    webkitEntry: WebKitEntryLike | null;
    fallbackFile: File | null;
  }

  // 在事件同步阶段先捕获全部句柄、webkitEntry 与 File 引用
  const captured: SyncCapturedItem[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    if (item.kind !== 'file') continue;
    const itemExt = item as DataTransferItem & {
      getAsFileSystemHandle?: () => Promise<unknown>;
      webkitGetAsEntry?: () => WebKitEntryLike | null;
    };
    let handlePromise: Promise<unknown> | null = null;
    if (typeof itemExt.getAsFileSystemHandle === 'function') {
      try {
        handlePromise = itemExt.getAsFileSystemHandle().catch(() => null);
      } catch {
        handlePromise = null;
      }
    }
    let webkitEntry: WebKitEntryLike | null = null;
    if (typeof itemExt.webkitGetAsEntry === 'function') {
      try {
        webkitEntry = itemExt.webkitGetAsEntry();
      } catch {
        webkitEntry = null;
      }
    }
    let fallbackFile: File | null = null;
    try {
      fallbackFile = item.getAsFile();
    } catch {
      fallbackFile = null;
    }
    captured.push({ index: i, handlePromise, webkitEntry, fallbackFile });
  }

  const entries: DropInputEntry[] = [];
  for (const cap of captured) {
    if (cap.handlePromise) {
      const handle = await cap.handlePromise;
      if (isFsaDirectoryHandle(handle)) {
        entries.push({
          id: `web_dir_fsa_${cap.index}_${handle.name}`,
          name: handle.name || '语料文件夹',
          isDir: true,
          size: 0,
          path: null,
          parentDir: null,
          dirHandle: handle
        });
        continue;
      }
      if (isFsaFileHandle(handle)) {
        try {
          const f = await handle.getFile();
          entries.push({
            id: `web_file_fsa_${cap.index}_${f.name}_${f.size}`,
            name: f.name,
            isDir: false,
            size: f.size,
            path: null,
            parentDir: null,
            file: f
          });
          continue;
        } catch {
          // 降级到 webkitEntry / fallbackFile
        }
      }
    }

    if (cap.webkitEntry?.isDirectory) {
      const dirFiles = await readWebKitDirTopLevelFiles(cap.webkitEntry);
      entries.push({
        id: `web_dir_wk_${cap.index}_${cap.webkitEntry.name}`,
        name: cap.webkitEntry.name || '语料文件夹',
        isDir: true,
        size: 0,
        path: null,
        parentDir: null,
        dirFiles
      });
      continue;
    }

    if (cap.fallbackFile) {
      const f = cap.fallbackFile;
      entries.push({
        id: `web_file_${cap.index}_${f.name}_${f.size}_${f.lastModified}`,
        name: f.name,
        isDir: false,
        size: f.size,
        path: null,
        parentDir: null,
        file: f
      });
    } else if (cap.webkitEntry?.isFile) {
      const f = await readWebKitFileEntry(cap.webkitEntry);
      if (f) {
        entries.push({
          id: `web_file_wk_${cap.index}_${f.name}_${f.size}`,
          name: f.name,
          isDir: false,
          size: f.size,
          path: null,
          parentDir: null,
          file: f
        });
      }
    }
  }

  return entries;
}

function pairPriorityForAudio(filename: string): number {
  const { ext } = splitFileStemAndExt(filename);
  if (ext === 'wav') return 0;
  if (ext === 'flac') return 1;
  if (ext === 'mp3') return 2;
  if (ext === 'm4a') return 3;
  return 4;
}

function pairPriorityForDoc(filename: string): number {
  const { ext } = splitFileStemAndExt(filename);
  if (ext === 'textgrid') return 0;
  if (ext === 'intervaltier' || ext === 'texttier') return 1;
  if (ext === 'collection') return 2;
  return 3;
}

function isCorpusCompatibleFile(entry: DropInputEntry): boolean {
  const { ext } = splitFileStemAndExt(entry.name);
  return ext === 'textgrid' || AUDIO_EXTENSIONS.has(ext);
}

function makeGroupKey(entry: DropInputEntry): string {
  const { stem } = splitFileStemAndExt(entry.name);
  const parentKey = entry.parentDir ? normalizeDropPathKey(entry.parentDir) : '';
  return `${parentKey}::${stem.toLowerCase()}`;
}

export function analyzeDropIntake(
  entries: DropInputEntry[],
  matcher?: DropExistingMatcher
): DropIntakePlan {
  const totalRawCount = entries.length;
  const directories: DropDirectoryCandidate[] = [];
  const docEntries: DropInputEntry[] = [];
  const audioEntries: DropInputEntry[] = [];
  const unsupported: DropUnsupportedItem[] = [];
  const alreadyOpen: DropAlreadyOpenItem[] = [];
  const seenOpenTabs = new Set<string>();

  for (const entry of entries) {
    if (entry.isDir) {
      const openTabId =
        entry.path && matcher?.findOpenCorpusTabId
          ? matcher.findOpenCorpusTabId(entry.path)
          : null;
      if (openTabId && !seenOpenTabs.has(`dir:${openTabId}`)) {
        seenOpenTabs.add(`dir:${openTabId}`);
        alreadyOpen.push({
          id: entry.id,
          name: entry.name,
          tabId: openTabId,
          isDir: true,
          path: entry.path
        });
      }
      directories.push({
        id: entry.id,
        name: entry.name,
        path: entry.path,
        dirHandle: entry.dirHandle,
        dirFiles: entry.dirFiles,
        alreadyOpenTabId: openTabId
      });
      continue;
    }

    const kind = classifyExtension(entry.name);
    if (kind === 'doc') {
      docEntries.push(entry);
    } else if (kind === 'audio') {
      audioEntries.push(entry);
    } else {
      unsupported.push({
        id: entry.id,
        name: entry.name,
        size: entry.size
      });
    }
  }

  // 按 (parentDir, stem) 分组进行标注与音频的精准配对
  const audioByGroup = new Map<string, DropInputEntry[]>();
  for (const a of audioEntries) {
    const key = makeGroupKey(a);
    const list = audioByGroup.get(key) ?? [];
    list.push(a);
    audioByGroup.set(key, list);
  }
  for (const list of audioByGroup.values()) {
    list.sort((a, b) => pairPriorityForAudio(a.name) - pairPriorityForAudio(b.name));
  }

  const sortedDocs = [...docEntries].sort((a, b) => {
    const prio = pairPriorityForDoc(a.name) - pairPriorityForDoc(b.name);
    if (prio !== 0) return prio;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  const openUnits: DropOpenUnit[] = [];
  const consumedAudioIds = new Set<string>();
  let pairedCount = 0;
  let standaloneDocCount = 0;
  let standaloneAudioCount = 0;

  for (const doc of sortedDocs) {
    const openTabId =
      doc.path && matcher?.findOpenFileTabId ? matcher.findOpenFileTabId(doc.path) : null;
    if (openTabId && !seenOpenTabs.has(`file:${openTabId}`)) {
      seenOpenTabs.add(`file:${openTabId}`);
      alreadyOpen.push({
        id: doc.id,
        name: doc.name,
        tabId: openTabId,
        isDir: false,
        path: doc.path
      });
    }

    const key = makeGroupKey(doc);
    const audioCandidates = audioByGroup.get(key);
    const matchedAudio = audioCandidates?.find((a) => !consumedAudioIds.has(a.id));
    const { stem } = splitFileStemAndExt(doc.name);

    if (matchedAudio) {
      consumedAudioIds.add(matchedAudio.id);
      pairedCount += 1;
      openUnits.push({
        id: `pair_${doc.id}_${matchedAudio.id}`,
        kind: 'paired',
        stem,
        label: `${doc.name} + ${matchedAudio.name}`,
        size: doc.size + matchedAudio.size,
        doc,
        audio: matchedAudio,
        alreadyOpenTabId: openTabId
      });
    } else {
      standaloneDocCount += 1;
      openUnits.push({
        id: `doc_${doc.id}`,
        kind: 'doc',
        stem,
        label: doc.name,
        size: doc.size,
        doc,
        alreadyOpenTabId: openTabId
      });
    }
  }

  for (const audio of audioEntries) {
    if (consumedAudioIds.has(audio.id)) continue;
    const { stem } = splitFileStemAndExt(audio.name);
    standaloneAudioCount += 1;
    openUnits.push({
      id: `audio_${audio.id}`,
      kind: 'audio',
      stem,
      label: audio.name,
      size: audio.size,
      audio,
      alreadyOpenTabId: null
    });
  }

  // 按文件名排序展示，配对项和独立文档靠前
  openUnits.sort((a, b) => {
    const order = (k: DropOpenUnitKind) => (k === 'paired' ? 0 : k === 'doc' ? 1 : 2);
    const diff = order(a.kind) - order(b.kind);
    if (diff !== 0) return diff;
    return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
  });

  const newDirectories = directories.filter((d) => !d.alreadyOpenTabId);
  const newUnits = openUnits.filter((u) => !u.alreadyOpenTabId);
  const newDocOrPairedUnits = newUnits.filter((u) => u.kind === 'paired' || u.kind === 'doc');
  const newStandaloneAudios = newUnits.filter((u) => u.kind === 'audio');

  // 计算预计新增独立标签页数量：
  // 单个独立音频在无其他批量项时会直接挂载到当前标签页（不新增标签）；
  // 若有 >= 2 个独立音频，则按独立标签页分别打开时每个算 1 个。
  const audioTabContribution =
    newStandaloneAudios.length >= BULK_DROP_STANDALONE_AUDIO_THRESHOLD
      ? newStandaloneAudios.length
      : 0;
  const estimatedNewTabs =
    newDirectories.length + newDocOrPairedUnits.length + audioTabContribution;

  // 可在批量弹窗中勾选的新项总数（已打开的项默认不计入硬上限）
  const selectableNewCount = newDirectories.length + newUnits.length;
  const exceedsIndividualCap = selectableNewCount > BULK_DROP_MAX_INDIVIDUAL_TABS;

  // 计算是否推荐「作为词表文件夹打开（仅占 1 个标签页）」
  const corpusEligibleEntries = [...docEntries, ...audioEntries].filter(isCorpusCompatibleFile);
  let corpusRecommendation: DropCorpusRecommendation | null = null;
  if (directories.length === 0 && corpusEligibleEntries.length >= 2) {
    const uniqueStems = new Set(
      corpusEligibleEntries.map((e) => splitFileStemAndExt(e.name).stem.toLowerCase())
    );
    const hasAudioOrMultiStems =
      audioEntries.length >= 2 ||
      (audioEntries.length >= 1 && uniqueStems.size >= 2) ||
      uniqueStems.size >= 2;

    if (hasAudioOrMultiStems) {
      const desktopDirs = corpusEligibleEntries
        .map((e) => e.parentDir?.trim() || '')
        .filter((d) => d.length > 0);
      const allDesktopWithDir = desktopDirs.length === corpusEligibleEntries.length;

      if (allDesktopWithDir) {
        const firstNorm = normalizeDropPathKey(desktopDirs[0]);
        const sameParent = desktopDirs.every((d) => normalizeDropPathKey(d) === firstNorm);
        if (sameParent) {
          const commonDir = desktopDirs[0];
          const firstPreferred = openUnits[0]?.stem;
          corpusRecommendation = {
            mode: 'tauri-dir',
            dirPath: commonDir,
            folderName: getDirDisplayName(commonDir),
            preferredItemStem: firstPreferred,
            itemCount: uniqueStems.size
          };
        }
      } else {
        const webFiles = corpusEligibleEntries
          .map((e) => e.file)
          .filter((f): f is File => Boolean(f));
        if (webFiles.length === corpusEligibleEntries.length && webFiles.length >= 2) {
          corpusRecommendation = {
            mode: 'web-files',
            folderName: `拖入的词表（${uniqueStems.size} 条）`,
            files: webFiles,
            itemCount: uniqueStems.size
          };
        }
      }
    }
  }

  // 判定决策：empty / switch-existing / direct / confirm
  const hasAnyValid = directories.length > 0 || openUnits.length > 0;
  const hasAnyNew = newDirectories.length > 0 || newUnits.length > 0;
  const triggerReasons: string[] = [];

  if (!hasAnyValid) {
    return {
      totalRawCount,
      directories,
      openUnits,
      alreadyOpen,
      unsupported,
      pairedCount,
      standaloneDocCount,
      standaloneAudioCount,
      newDirectoryCount: newDirectories.length,
      estimatedNewTabs,
      selectableNewCount,
      exceedsIndividualCap,
      corpusRecommendation: null,
      decision: 'empty',
      triggerReasons
    };
  }

  // 全部有效项都已经在标签栏中打开（且没有需要额外加载的新音频或待挂载音频）
  const hasNewAudioForAlreadyOpen = openUnits.some(
    (u) => u.alreadyOpenTabId && u.kind === 'paired' && Boolean(u.audio)
  );
  if (!hasAnyNew && alreadyOpen.length > 0 && !hasNewAudioForAlreadyOpen) {
    return {
      totalRawCount,
      directories,
      openUnits,
      alreadyOpen,
      unsupported,
      pairedCount,
      standaloneDocCount,
      standaloneAudioCount,
      newDirectoryCount: 0,
      estimatedNewTabs: 0,
      selectableNewCount: 0,
      exceedsIndividualCap: false,
      corpusRecommendation: null,
      decision: 'switch-existing',
      triggerReasons
    };
  }

  if (estimatedNewTabs >= BULK_DROP_NEW_TAB_THRESHOLD) {
    triggerReasons.push(`预计新增 ${estimatedNewTabs} 个独立标签页`);
  }
  if (newStandaloneAudios.length >= BULK_DROP_STANDALONE_AUDIO_THRESHOLD) {
    triggerReasons.push(`包含 ${newStandaloneAudios.length} 个独立音频文件`);
  }
  if (directories.length >= BULK_DROP_DIRECTORY_THRESHOLD) {
    triggerReasons.push(`同时拖入了 ${directories.length} 个文件夹`);
  }
  if (totalRawCount > BULK_DROP_TOTAL_ENTRIES_THRESHOLD) {
    triggerReasons.push(`单次拖入共 ${totalRawCount} 个条目`);
  }

  const decision: DropIntakeDecision = triggerReasons.length > 0 ? 'confirm' : 'direct';

  return {
    totalRawCount,
    directories,
    openUnits,
    alreadyOpen,
    unsupported,
    pairedCount,
    standaloneDocCount,
    standaloneAudioCount,
    newDirectoryCount: newDirectories.length,
    estimatedNewTabs,
    selectableNewCount,
    exceedsIndividualCap,
    corpusRecommendation,
    decision,
    triggerReasons
  };
}
