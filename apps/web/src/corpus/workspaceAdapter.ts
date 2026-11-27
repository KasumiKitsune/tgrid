import type {
  CorpusDirScanResult,
  CorpusScannedAudioFile,
  CorpusScannedFileEntry,
  PlatformBridge,
  ZipEntryInput
} from '../bridge/types';
import { CORPUS_PROJECT_FILENAME, type CorpusWorkspaceMode } from './types';

export interface CorpusWorkspaceAdapter {
  readonly projectId: string;
  readonly rootKey: string;
  readonly projectName: string;
  readonly mode: CorpusWorkspaceMode;
  readonly writable: boolean;
  readonly readOnlyReason?: string;
  /** 仅 Tauri 桌面端返回本地目录绝对路径，Web 端为 undefined */
  readonly nativeDirPath?: string;

  scan(): Promise<CorpusDirScanResult>;
  readFile(relPath: string): Promise<Uint8Array>;
  readFileIfExists(relPath: string): Promise<Uint8Array | null>;
  writeFile(relPath: string, bytes: Uint8Array): Promise<void>;
  /** 仅 Tauri 桌面端返回本地绝对路径，Web 端返回 null */
  resolveNativePath(relPath: string): string | null;
  /** 打包导出所有修改过的文件为 .zip（主要用于 Web 降级只读模式） */
  exportModifiedZip(bridge: PlatformBridge): Promise<{ bytes: Uint8Array; fileCount: number }>;
  /** 当前暂存待导出的已修改文件数 */
  getPendingExportCount(): number;
  /** 清理适配器资源 */
  dispose(): void;
}

const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac', 'opus']);
const WORDLIST_EXTENSIONS = new Set(['csv', 'tsv', 'xlsx']);

const adapterRegistry = new Map<string, CorpusWorkspaceAdapter>();
let nextProjectSeq = 1;

function createProjectId(): string {
  return `corpus_${Date.now().toString(36)}_${nextProjectSeq++}`;
}

export function registerCorpusAdapter(adapter: CorpusWorkspaceAdapter): void {
  adapterRegistry.set(adapter.projectId, adapter);
}

export function getCorpusAdapter(projectId: string): CorpusWorkspaceAdapter | null {
  return adapterRegistry.get(projectId) ?? null;
}

export function disposeCorpusAdapter(projectId: string): void {
  const existing = adapterRegistry.get(projectId);
  if (!existing) return;
  adapterRegistry.delete(projectId);
  existing.dispose();
}

function splitFileName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return {
    stem: name.slice(0, dot),
    ext: name.slice(dot + 1).toLowerCase()
  };
}

function joinNativePath(dir: string, relPath: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  const cleanDir = dir.replace(/[\\/]+$/, '');
  const cleanRel = relPath.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep);
  return `${cleanDir}${sep}${cleanRel}`;
}

/**
 * 从 WAV 前 4KB RIFF 头解析音频时长（秒），不读取全量音频字节。
 */
export function probeWavDurationFromHeaderBytes(
  bytes: Uint8Array,
  totalFileSize?: number
): number | null {
  if (bytes.length < 44) return null;
  if (
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x41 ||
    bytes[10] !== 0x56 ||
    bytes[11] !== 0x45
  ) {
    return null;
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  let effByteRate: number | null = null;
  let dataBytes: number | null = null;

  while (pos + 8 <= bytes.length) {
    const id =
      String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const chunkSize = dv.getUint32(pos + 4, true);
    pos += 8;

    if (id === 'fmt ') {
      if (pos + 16 > bytes.length) break;
      const numChannels = dv.getUint16(pos + 2, true);
      const sampleRate = dv.getUint32(pos + 4, true);
      const byteRate = dv.getUint32(pos + 8, true);
      const bitsPerSample = dv.getUint16(pos + 14, true);
      if (byteRate > 0) {
        effByteRate = byteRate;
      } else if (sampleRate > 0 && numChannels > 0 && bitsPerSample >= 8) {
        effByteRate = sampleRate * numChannels * (bitsPerSample / 8);
      }
    } else if (id === 'data') {
      if (chunkSize > 0 && chunkSize !== 0xffffffff) {
        dataBytes = chunkSize;
      } else if (typeof totalFileSize === 'number' && totalFileSize > pos) {
        dataBytes = totalFileSize - pos;
      }
      if (effByteRate != null) break;
    }

    const step = chunkSize + (chunkSize & 1);
    if (step < 0 || pos + step > bytes.length) break;
    pos += step;
  }

  if (effByteRate && dataBytes && effByteRate > 0 && dataBytes > 0) {
    const dur = dataBytes / effByteRate;
    if (Number.isFinite(dur) && dur > 0) return dur;
  }
  return null;
}

// ---------- IndexedDB 轻量镜像（供 Web 降级模式暂存已修改文件） ----------

const IDB_NAME = 'tgrid_corpus_fallback_v1';
const IDB_STORE = 'files';

interface MirrorEntry {
  key: string;
  rootKey: string;
  relPath: string;
  bytes: Uint8Array;
  updatedAt: number;
}

function openMirrorDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          const store = db.createObjectStore(IDB_STORE, { keyPath: 'key' });
          store.createIndex('rootKey', 'rootKey', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbLoadRootEntries(rootKey: string): Promise<MirrorEntry[]> {
  const db = await openMirrorDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const idx = tx.objectStore(IDB_STORE).index('rootKey');
      const req = idx.getAll(IDBKeyRange.only(rootKey));
      req.onsuccess = () => {
        const rows = (req.result as MirrorEntry[]) || [];
        resolve(
          rows.map((r) => ({
            ...r,
            bytes: r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes)
          }))
        );
      };
      req.onerror = () => resolve([]);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    } catch {
      db.close();
      resolve([]);
    }
  });
}

async function idbPutEntry(entry: MirrorEntry): Promise<void> {
  const db = await openMirrorDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(entry);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

// ---------- 1. Tauri 桌面端适配器 ----------

class TauriCorpusAdapter implements CorpusWorkspaceAdapter {
  readonly projectId = createProjectId();
  readonly rootKey: string;
  readonly projectName: string;
  readonly mode = 'tauri' as const;
  readonly writable = true;

  private readonly bridge: PlatformBridge;
  private readonly dirPath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private modifiedPaths = new Set<string>();

  constructor(bridge: PlatformBridge, dirPath: string) {
    this.bridge = bridge;
    this.dirPath = dirPath;
    const normalized = dirPath.replace(/[\\/]+$/, '');
    this.rootKey = `tauri:${normalized.replace(/\\/g, '/').toLowerCase()}`;
    const parts = normalized.split(/[\\/]/).filter(Boolean);
    this.projectName = parts[parts.length - 1] || dirPath;
  }

  get nativeDirPath(): string {
    return this.dirPath;
  }

  resolveNativePath(relPath: string): string {
    return joinNativePath(this.dirPath, relPath);
  }

  async scan(): Promise<CorpusDirScanResult> {
    const result = await this.bridge.scanCorpusDir(this.dirPath);
    if (!result) {
      throw new Error('当前环境不支持本地目录扫描');
    }
    return result;
  }

  async readFile(relPath: string): Promise<Uint8Array> {
    const fullPath = this.resolveNativePath(relPath);
    const bytes = await this.bridge.readNativeFileIfExists(fullPath);
    if (!bytes) {
      throw new Error(`找不到文件: ${relPath}`);
    }
    return bytes;
  }

  async readFileIfExists(relPath: string): Promise<Uint8Array | null> {
    return this.bridge.readNativeFileIfExists(this.resolveNativePath(relPath));
  }

  writeFile(relPath: string, bytes: Uint8Array): Promise<void> {
    const copy = bytes.slice();
    const task = this.writeQueue.then(async () => {
      const ok = await this.bridge.writeNativeFileAtomic(this.resolveNativePath(relPath), copy);
      if (!ok) {
        throw new Error(`无法保存文件: ${relPath}`);
      }
      this.modifiedPaths.add(relPath);
    });
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  async exportModifiedZip(
    bridge: PlatformBridge
  ): Promise<{ bytes: Uint8Array; fileCount: number }> {
    const entries: ZipEntryInput[] = [];
    for (const relPath of this.modifiedPaths) {
      const data = await this.readFileIfExists(relPath);
      if (data) {
        entries.push({ name: relPath, data });
      }
    }
    const bytes = await bridge.buildZipStore(entries);
    return { bytes, fileCount: entries.length };
  }

  getPendingExportCount(): number {
    return 0;
  }

  dispose(): void {
    this.modifiedPaths.clear();
  }
}

// ---------- 2. Web Chromium File System Access API 适配器 ----------

interface FsaFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: BufferSource | Blob | string): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
}

interface FsaDirectoryHandle {
  kind: 'directory';
  name: string;
  entries(): AsyncIterableIterator<[string, FsaFileHandle | FsaDirectoryHandle]>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsaFileHandle>;
  queryPermission?(opts?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(opts?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

class WebFsaCorpusAdapter implements CorpusWorkspaceAdapter {
  readonly projectId = createProjectId();
  readonly rootKey: string;
  readonly projectName: string;
  readonly mode = 'web-fsa' as const;
  readonly writable: boolean;
  readonly readOnlyReason?: string;

  private readonly dirHandle: FsaDirectoryHandle;
  private fileHandleByLower = new Map<string, FsaFileHandle>();
  private modifiedFallback = new Map<string, { relPath: string; bytes: Uint8Array }>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dirHandle: FsaDirectoryHandle, writable: boolean, readOnlyReason?: string) {
    this.dirHandle = dirHandle;
    this.projectName = dirHandle.name || '语料文件夹';
    this.rootKey = `web-fsa:${this.projectName}`;
    this.writable = writable;
    this.readOnlyReason = readOnlyReason;
  }

  resolveNativePath(): null {
    return null;
  }

  async scan(): Promise<CorpusDirScanResult> {
    this.fileHandleByLower.clear();
    const audioFiles: CorpusScannedAudioFile[] = [];
    const textGridFiles: CorpusScannedFileEntry[] = [];
    const wordListFiles: string[] = [];
    let hasProjectFile = false;
    let projectFileRelPath = CORPUS_PROJECT_FILENAME;

    const wavHandles: Array<{ item: CorpusScannedAudioFile; handle: FsaFileHandle }> = [];

    for await (const [name, handle] of this.dirHandle.entries()) {
      if (handle.kind !== 'file') continue;
      this.fileHandleByLower.set(name.toLowerCase(), handle);

      if (name.toLowerCase() === CORPUS_PROJECT_FILENAME) {
        hasProjectFile = true;
        projectFileRelPath = name;
        continue;
      }
      if (name.startsWith('.')) continue;

      const { stem, ext } = splitFileName(name);
      if (!stem) continue;

      if (AUDIO_EXTENSIONS.has(ext)) {
        const rec: CorpusScannedAudioFile = {
          relPath: name,
          stem,
          duration: null,
          sizeBytes: 0,
          modifiedMs: 0
        };
        audioFiles.push(rec);
        if (ext === 'wav') {
          wavHandles.push({ item: rec, handle });
        }
      } else if (ext === 'textgrid') {
        textGridFiles.push({
          relPath: name,
          stem,
          sizeBytes: 0,
          modifiedMs: 0
        });
      } else if (WORDLIST_EXTENSIONS.has(ext)) {
        wordListFiles.push(name);
      }
    }

    // 少量 WAV 文件时直接读前 4KB 头补充时长，大目录保持秒开延迟到切入时补齐
    if (wavHandles.length <= 200) {
      for (const { item, handle } of wavHandles) {
        try {
          const f = await handle.getFile();
          item.sizeBytes = f.size;
          item.modifiedMs = f.lastModified;
          const head = new Uint8Array(await f.slice(0, 4096).arrayBuffer());
          item.duration = probeWavDurationFromHeaderBytes(head, f.size);
        } catch {
          // 忽略单个文件读头失败
        }
      }
    }

    audioFiles.sort((a, b) => a.relPath.toLowerCase().localeCompare(b.relPath.toLowerCase()));
    textGridFiles.sort((a, b) => a.relPath.toLowerCase().localeCompare(b.relPath.toLowerCase()));
    wordListFiles.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    return {
      dirPath: this.projectName,
      dirName: this.projectName,
      audioFiles,
      textGridFiles,
      hasProjectFile,
      projectFileRelPath,
      wordListFiles
    };
  }

  private async getHandleIfExists(relPath: string): Promise<FsaFileHandle | null> {
    const cached = this.fileHandleByLower.get(relPath.toLowerCase());
    if (cached) return cached;
    try {
      const handle = await this.dirHandle.getFileHandle(relPath, { create: false });
      this.fileHandleByLower.set(relPath.toLowerCase(), handle);
      return handle;
    } catch {
      return null;
    }
  }

  async readFile(relPath: string): Promise<Uint8Array> {
    const bytes = await this.readFileIfExists(relPath);
    if (!bytes) {
      throw new Error(`找不到文件: ${relPath}`);
    }
    return bytes;
  }

  async readFileIfExists(relPath: string): Promise<Uint8Array | null> {
    const mem = this.modifiedFallback.get(relPath.toLowerCase());
    if (mem) return mem.bytes.slice();
    const handle = await this.getHandleIfExists(relPath);
    if (!handle) return null;
    try {
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  writeFile(relPath: string, bytes: Uint8Array): Promise<void> {
    const copy = bytes.slice();
    const task = this.writeQueue.then(async () => {
      if (!this.writable) {
        this.modifiedFallback.set(relPath.toLowerCase(), { relPath, bytes: copy });
        await idbPutEntry({
          key: `${this.rootKey}::${relPath.toLowerCase()}`,
          rootKey: this.rootKey,
          relPath,
          bytes: copy,
          updatedAt: Date.now()
        });
        return;
      }

      const handle = await this.dirHandle.getFileHandle(relPath, { create: true });
      this.fileHandleByLower.set(relPath.toLowerCase(), handle);
      const writable = await handle.createWritable();
      try {
        await writable.write(copy as unknown as BufferSource);
        await writable.close();
      } catch (err) {
        try {
          await writable.abort?.();
        } catch {
          // ignore
        }
        throw err;
      }
    });
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  async exportModifiedZip(
    bridge: PlatformBridge
  ): Promise<{ bytes: Uint8Array; fileCount: number }> {
    const entries: ZipEntryInput[] = Array.from(this.modifiedFallback.values()).map((item) => ({
      name: item.relPath,
      data: item.bytes
    }));
    const bytes = await bridge.buildZipStore(entries);
    return { bytes, fileCount: entries.length };
  }

  getPendingExportCount(): number {
    return this.modifiedFallback.size;
  }

  dispose(): void {
    this.fileHandleByLower.clear();
    this.modifiedFallback.clear();
  }
}

// ---------- 3. Web 降级模式适配器（file:// / Firefox / Safari） ----------

class WebFallbackCorpusAdapter implements CorpusWorkspaceAdapter {
  readonly projectId = createProjectId();
  readonly rootKey: string;
  readonly projectName: string;
  readonly mode = 'web-fallback' as const;
  readonly writable = false;
  readonly readOnlyReason =
    '当前浏览器环境不支持直接写入本地文件夹，修改已暂存到本地缓存，请完成后导出压缩包。';

  private readonly filesByLower = new Map<string, { relPath: string; file: File }>();
  private readonly modifiedByLower = new Map<string, { relPath: string; bytes: Uint8Array }>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(projectName: string, fileEntries: Array<{ relPath: string; file: File }>) {
    this.projectName = projectName || '语料文件夹';
    for (const entry of fileEntries) {
      this.filesByLower.set(entry.relPath.toLowerCase(), entry);
    }
    this.rootKey = `web-fallback:${this.projectName.toLowerCase()}:${fileEntries.length}`;
  }

  resolveNativePath(): null {
    return null;
  }

  async scan(): Promise<CorpusDirScanResult> {
    // 恢复同一目录之前暂存在 IndexedDB 中的修改
    const cachedRows = await idbLoadRootEntries(this.rootKey);
    for (const row of cachedRows) {
      this.modifiedByLower.set(row.relPath.toLowerCase(), {
        relPath: row.relPath,
        bytes: row.bytes
      });
    }

    const audioFiles: CorpusScannedAudioFile[] = [];
    const textGridByLower = new Map<string, CorpusScannedFileEntry>();
    const wordListFiles: string[] = [];
    let hasProjectFile = false;
    let projectFileRelPath = CORPUS_PROJECT_FILENAME;

    for (const { relPath, file } of this.filesByLower.values()) {
      if (relPath.toLowerCase() === CORPUS_PROJECT_FILENAME) {
        hasProjectFile = true;
        projectFileRelPath = relPath;
        continue;
      }
      if (relPath.startsWith('.')) continue;

      const { stem, ext } = splitFileName(relPath);
      if (!stem) continue;

      if (AUDIO_EXTENSIONS.has(ext)) {
        audioFiles.push({
          relPath,
          stem,
          duration: null,
          sizeBytes: file.size,
          modifiedMs: file.lastModified
        });
      } else if (ext === 'textgrid') {
        textGridByLower.set(relPath.toLowerCase(), {
          relPath,
          stem,
          sizeBytes: file.size,
          modifiedMs: file.lastModified
        });
      } else if (WORDLIST_EXTENSIONS.has(ext)) {
        wordListFiles.push(relPath);
      }
    }

    for (const { relPath, bytes } of this.modifiedByLower.values()) {
      const lower = relPath.toLowerCase();
      if (lower === CORPUS_PROJECT_FILENAME) {
        hasProjectFile = true;
        projectFileRelPath = relPath;
        continue;
      }
      const { stem, ext } = splitFileName(relPath);
      if (ext === 'textgrid' && stem) {
        textGridByLower.set(lower, {
          relPath,
          stem,
          sizeBytes: bytes.length,
          modifiedMs: Date.now()
        });
      }
    }

    const textGridFiles = Array.from(textGridByLower.values());
    audioFiles.sort((a, b) => a.relPath.toLowerCase().localeCompare(b.relPath.toLowerCase()));
    textGridFiles.sort((a, b) => a.relPath.toLowerCase().localeCompare(b.relPath.toLowerCase()));
    wordListFiles.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    return {
      dirPath: this.projectName,
      dirName: this.projectName,
      audioFiles,
      textGridFiles,
      hasProjectFile,
      projectFileRelPath,
      wordListFiles
    };
  }

  async readFile(relPath: string): Promise<Uint8Array> {
    const bytes = await this.readFileIfExists(relPath);
    if (!bytes) {
      throw new Error(`找不到文件: ${relPath}`);
    }
    return bytes;
  }

  async readFileIfExists(relPath: string): Promise<Uint8Array | null> {
    const lower = relPath.toLowerCase();
    const modified = this.modifiedByLower.get(lower);
    if (modified) return modified.bytes.slice();
    const entry = this.filesByLower.get(lower);
    if (!entry) return null;
    return new Uint8Array(await entry.file.arrayBuffer());
  }

  writeFile(relPath: string, bytes: Uint8Array): Promise<void> {
    const copy = bytes.slice();
    const lower = relPath.toLowerCase();
    this.modifiedByLower.set(lower, { relPath, bytes: copy });

    const task = this.writeQueue.then(async () => {
      await idbPutEntry({
        key: `${this.rootKey}::${lower}`,
        rootKey: this.rootKey,
        relPath,
        bytes: copy,
        updatedAt: Date.now()
      });
    });
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  async exportModifiedZip(
    bridge: PlatformBridge
  ): Promise<{ bytes: Uint8Array; fileCount: number }> {
    const entries: ZipEntryInput[] = Array.from(this.modifiedByLower.values()).map((item) => ({
      name: item.relPath,
      data: item.bytes
    }));
    const bytes = await bridge.buildZipStore(entries);
    return { bytes, fileCount: entries.length };
  }

  getPendingExportCount(): number {
    return this.modifiedByLower.size;
  }

  dispose(): void {
    this.filesByLower.clear();
    this.modifiedByLower.clear();
  }
}

// ---------- 4. 内存示例适配器（用于内置文件夹项目示例） ----------

class MemoryCorpusAdapter implements CorpusWorkspaceAdapter {
  readonly projectId = createProjectId();
  readonly rootKey: string;
  readonly projectName: string;
  readonly mode = 'web-fallback' as const;
  readonly writable = true;

  private readonly filesByLower = new Map<string, { relPath: string; bytes: Uint8Array }>();

  constructor(
    rootKey: string,
    projectName: string,
    initialFiles: Array<{ relPath: string; bytes: Uint8Array }>
  ) {
    this.rootKey = rootKey;
    this.projectName = projectName;
    for (const f of initialFiles) {
      this.filesByLower.set(f.relPath.toLowerCase(), {
        relPath: f.relPath,
        bytes: f.bytes.slice()
      });
    }
  }

  resolveNativePath(): null {
    return null;
  }

  async scan(): Promise<CorpusDirScanResult> {
    const audioFiles: CorpusScannedAudioFile[] = [];
    const textGridFiles: CorpusScannedFileEntry[] = [];
    const wordListFiles: string[] = [];
    let hasProjectFile = false;
    let projectFileRelPath = CORPUS_PROJECT_FILENAME;

    for (const { relPath, bytes } of this.filesByLower.values()) {
      if (relPath.toLowerCase() === CORPUS_PROJECT_FILENAME) {
        hasProjectFile = true;
        projectFileRelPath = relPath;
        continue;
      }
      if (relPath.startsWith('.')) continue;

      const { stem, ext } = splitFileName(relPath);
      if (!stem) continue;

      if (AUDIO_EXTENSIONS.has(ext)) {
        audioFiles.push({
          relPath,
          stem,
          duration: null,
          sizeBytes: bytes.length,
          modifiedMs: Date.now()
        });
      } else if (ext === 'textgrid') {
        textGridFiles.push({
          relPath,
          stem,
          sizeBytes: bytes.length,
          modifiedMs: Date.now()
        });
      } else if (WORDLIST_EXTENSIONS.has(ext)) {
        wordListFiles.push(relPath);
      }
    }

    audioFiles.sort((a, b) => a.relPath.toLowerCase().localeCompare(b.relPath.toLowerCase()));
    textGridFiles.sort((a, b) => a.relPath.toLowerCase().localeCompare(b.relPath.toLowerCase()));
    wordListFiles.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    return {
      dirPath: this.projectName,
      dirName: this.projectName,
      audioFiles,
      textGridFiles,
      hasProjectFile,
      projectFileRelPath,
      wordListFiles
    };
  }

  async readFile(relPath: string): Promise<Uint8Array> {
    const bytes = await this.readFileIfExists(relPath);
    if (!bytes) {
      throw new Error(`找不到文件: ${relPath}`);
    }
    return bytes;
  }

  async readFileIfExists(relPath: string): Promise<Uint8Array | null> {
    const entry = this.filesByLower.get(relPath.toLowerCase());
    return entry ? entry.bytes.slice() : null;
  }

  async writeFile(relPath: string, bytes: Uint8Array): Promise<void> {
    this.filesByLower.set(relPath.toLowerCase(), {
      relPath,
      bytes: bytes.slice()
    });
  }

  async exportModifiedZip(
    bridge: PlatformBridge
  ): Promise<{ bytes: Uint8Array; fileCount: number }> {
    const entries: ZipEntryInput[] = Array.from(this.filesByLower.values()).map((item) => ({
      name: item.relPath,
      data: item.bytes
    }));
    const bytes = await bridge.buildZipStore(entries);
    return { bytes, fileCount: entries.length };
  }

  getPendingExportCount(): number {
    return 0;
  }

  dispose(): void {
    this.filesByLower.clear();
  }
}

export function createMemoryCorpusAdapter(opts: {
  rootKey: string;
  projectName: string;
  files: Array<{ relPath: string; bytes: Uint8Array }>;
}): CorpusWorkspaceAdapter {
  const adapter = new MemoryCorpusAdapter(opts.rootKey, opts.projectName, opts.files);
  registerCorpusAdapter(adapter);
  return adapter;
}

// ---------- 工厂入口 ----------

export function isWebDirectoryPickerSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker ===
      'function'
  );
}

/**
 * Tauri 桌面端打开文件夹工作区适配器；若未传 dirPath 则弹出原生目录选择框。
 */
export async function openTauriCorpusAdapter(
  bridge: PlatformBridge,
  dirPath?: string
): Promise<CorpusWorkspaceAdapter | null> {
  const chosenDir = dirPath || (await bridge.openNativeDirectoryDialog({ title: '选择文件夹' }));
  if (!chosenDir) return null;
  const adapter = new TauriCorpusAdapter(bridge, chosenDir);
  registerCorpusAdapter(adapter);
  return adapter;
}

/**
 * Web Chromium 安全上下文打开文件夹工作区适配器（支持静默读写）。
 * 用户取消选择返回 null。
 */
export async function openWebFsaCorpusAdapter(): Promise<CorpusWorkspaceAdapter | null> {
  if (!isWebDirectoryPickerSupported()) return null;
  const picker = (
    window as unknown as {
      showDirectoryPicker: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FsaDirectoryHandle>;
    }
  ).showDirectoryPicker;

  let dirHandle: FsaDirectoryHandle;
  try {
    dirHandle = await picker({ mode: 'readwrite' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return null;
    }
    throw err;
  }

  let writable = true;
  let readOnlyReason: string | undefined;
  try {
    const perm = (await dirHandle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
    if (perm !== 'granted') {
      const req = (await dirHandle.requestPermission?.({ mode: 'readwrite' })) ?? 'denied';
      if (req !== 'granted') {
        writable = false;
        readOnlyReason = '未授予文件夹写入权限，修改将暂存到本地缓存，请完成后导出压缩包。';
      }
    }
  } catch {
    writable = false;
    readOnlyReason = '浏览器限制了目录写入权限，修改将暂存到本地缓存，请完成后导出压缩包。';
  }

  const adapter = new WebFsaCorpusAdapter(dirHandle, writable, readOnlyReason);
  registerCorpusAdapter(adapter);
  return adapter;
}

/**
 * 从 <input type="file" webkitdirectory> 或拖拽文件列表构造 Web 降级模式适配器。
 * 仅提取一级目录内的文件，避免预读全部字节。
 */
export function createWebFallbackCorpusAdapter(
  fileList: FileList | File[]
): CorpusWorkspaceAdapter | null {
  const files = Array.from(fileList);
  if (files.length === 0) return null;

  let rootName = '语料文件夹';
  const topLevel: Array<{ relPath: string; file: File }> = [];

  for (const file of files) {
    const rawRel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    if (rawRel) {
      const parts = rawRel.split('/').filter(Boolean);
      if (parts.length >= 2 && rootName === '语料文件夹') {
        rootName = parts[0];
      }
      // 仅扫描一级目录
      if (parts.length === 2) {
        topLevel.push({ relPath: parts[1], file });
      }
    } else {
      topLevel.push({ relPath: file.name, file });
    }
  }

  if (topLevel.length === 0) {
    // 兜底：若用户选中的文件全部在更深一层，使用文件名本身
    for (const file of files) {
      topLevel.push({ relPath: file.name, file });
    }
  }

  const adapter = new WebFallbackCorpusAdapter(rootName, topLevel);
  registerCorpusAdapter(adapter);
  return adapter;
}

/**
 * Web 端统一入口：优先调用 showDirectoryPicker，不可用时回退到传入的 webkitdirectory 文件选择器。
 */
export async function openWebCorpusAdapter(
  pickFallbackFiles?: () => Promise<FileList | File[] | null>
): Promise<CorpusWorkspaceAdapter | null> {
  if (isWebDirectoryPickerSupported()) {
    return openWebFsaCorpusAdapter();
  }
  if (!pickFallbackFiles) return null;
  const files = await pickFallbackFiles();
  if (!files || files.length === 0) return null;
  return createWebFallbackCorpusAdapter(files);
}
