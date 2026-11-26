import { invoke } from '@tauri-apps/api/core';
import type {
  AudioAnalysisSummary,
  AudioSummary,
  CollectionFormat,
  CollectionItem,
  ContourBox,
  ContourPath,
  EngineInfo,
  IpaCandidate,
  IpaConvertResult,
  IpaSymbolInfo,
  LinearSeg,
  NativeFileFilter,
  NativeOpenedFile,
  ParsedDocument,
  PlatformBridge,
  PraatMatch,
  SliceOptions,
  SpectrogramRgbaResult,
  TextGrid,
  TextGridFormat,
  TierDiagnostics,
  YunlongStepResult,
  ZipEntryInput
} from './types';

const LAST_DIR_KEY = 'tgrid_last_dir_v1';

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function getBaseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function getDirName(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
  return idx > 0 ? filePath.slice(0, idx) : '';
}

function joinDirAndFile(dir: string, filename: string): string {
  if (!dir) return filename;
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith('\\') || dir.endsWith('/') ? `${dir}${filename}` : `${dir}${sep}${filename}`;
}

function loadLastDir(): string {
  try {
    return localStorage.getItem(LAST_DIR_KEY) || '';
  } catch {
    return '';
  }
}

function rememberDirFromPath(filePath: string): void {
  const dir = getDirName(filePath);
  if (!dir) return;
  try {
    localStorage.setItem(LAST_DIR_KEY, dir);
  } catch {
    // ignore storage errors
  }
}

function unpackRgba(raw: number[]): SpectrogramRgbaResult {
  const bytes = new Uint8Array(raw);
  if (bytes.length < 8) {
    return { width: 0, height: 0, rgba: new Uint8ClampedArray(0) };
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint32(0, false);
  const height = dv.getUint32(4, false);
  const rgba = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 8, bytes.byteLength - 8);
  return { width, height, rgba };
}

export class TauriBridge implements PlatformBridge {
  readonly kind = 'tauri' as const;

  async init(): Promise<void> {
    // Tauri native commands are immediately available via IPC
  }

  async getEngineInfo(): Promise<EngineInfo> {
    return invoke<EngineInfo>('engine_info');
  }

  async parsePraatFile(bytes: Uint8Array, filename: string): Promise<ParsedDocument> {
    return invoke<ParsedDocument>('parse_praat_bytes', {
      bytes: Array.from(bytes),
      filename
    });
  }

  async parseTextGrid(bytes: Uint8Array): Promise<TextGrid> {
    return invoke<TextGrid>('parse_textgrid_bytes', { bytes: Array.from(bytes) });
  }

  async serializeTextGrid(tg: TextGrid, format: TextGridFormat): Promise<Uint8Array> {
    const out = await invoke<number[]>('serialize_textgrid', { tg, format });
    return new Uint8Array(out);
  }

  async serializeCollection(items: CollectionItem[], format: CollectionFormat): Promise<Uint8Array> {
    const out = await invoke<number[]>('serialize_collection', { items, format });
    return new Uint8Array(out);
  }

  async sliceTextGrid(tg: TextGrid, opts: SliceOptions): Promise<TextGrid> {
    return invoke<TextGrid>('slice_textgrid', { tg, opts });
  }

  async scanDiagnostics(tg: TextGrid): Promise<TierDiagnostics[]> {
    return invoke<TierDiagnostics[]>('scan_diagnostics', { tg });
  }

  async buildZipStore(entries: ZipEntryInput[]): Promise<Uint8Array> {
    const payload = entries.map((e) => ({ name: e.name, data: Array.from(e.data) }));
    const out = await invoke<number[]>('build_zip_store', { entries: payload });
    return new Uint8Array(out);
  }

  async decodePraatTrigraphs(input: string): Promise<IpaConvertResult> {
    return invoke<IpaConvertResult>('decode_praat_trigraphs', { input });
  }

  async encodePraatTrigraphs(input: string): Promise<IpaConvertResult> {
    return invoke<IpaConvertResult>('encode_praat_trigraphs', { input });
  }

  async hasPraatTrigraphs(input: string): Promise<boolean> {
    return invoke<boolean>('has_praat_trigraphs', { input });
  }

  async getYunlongCandidates(buffer: string): Promise<IpaCandidate[]> {
    return invoke<IpaCandidate[]>('get_yunlong_candidates', { buffer });
  }

  async stepYunlongChar(buffer: string, ch: string): Promise<YunlongStepResult> {
    return invoke<YunlongStepResult>('step_yunlong_char', { buffer, ch });
  }

  async getPraatMatches(firstChar?: string): Promise<PraatMatch[]> {
    return invoke<PraatMatch[]>('get_praat_matches', { firstChar: firstChar ?? null });
  }

  async lookupIpaSymbol(sym: string): Promise<IpaSymbolInfo> {
    return invoke<IpaSymbolInfo>('lookup_ipa_symbol', { sym });
  }

  async summarizeAudio(samples: Float32Array, sampleRate: number): Promise<AudioSummary> {
    return invoke<AudioSummary>('summarize_audio', {
      samples: Array.from(samples),
      sampleRate
    });
  }

  async loadPcmSession(
    samples: Float32Array,
    sampleRate: number,
    offset: number
  ): Promise<AudioAnalysisSummary> {
    return invoke<AudioAnalysisSummary>('load_pcm_session', {
      samples: Array.from(samples),
      sampleRate,
      offset
    });
  }

  async loadWavSession(bytes: Uint8Array, offset: number): Promise<AudioAnalysisSummary> {
    return invoke<AudioAnalysisSummary>('load_wav_session', {
      bytes: Array.from(bytes),
      offset
    });
  }

  async removeAudioSession(sessionId: number): Promise<void> {
    await invoke('remove_audio_session', { sessionId });
  }

  async clearAudioSession(): Promise<void> {
    await invoke('clear_audio_session');
  }

  async renderSpectrogramRgba(
    sessionId: number,
    segs: LinearSeg[],
    bandOriginX: number,
    bandContentW: number,
    specH: number,
    maxFreq: number,
    scale: number,
    dynRange: number,
    paletteKey: string
  ): Promise<SpectrogramRgbaResult> {
    const raw = await invoke<number[]>('render_spectrogram_rgba_packed', {
      sessionId,
      segs,
      bandOriginX,
      bandContentW,
      specH,
      maxFreq,
      scale,
      dynRange,
      paletteKey
    });
    return unpackRgba(raw);
  }

  async computeBandContours(
    sessionId: number,
    segs: LinearSeg[],
    bandOriginX: number,
    bandContentW: number,
    maxFreq: number,
    cols: number,
    rows: number,
    dynRange: number,
    smooth: boolean,
    box: ContourBox,
    levels: number,
    paletteKey: string
  ): Promise<ContourPath[]> {
    return invoke<ContourPath[]>('compute_band_contours', {
      sessionId,
      segs,
      bandOriginX,
      bandContentW,
      maxFreq,
      cols,
      rows,
      dynRange,
      smooth,
      boxRect: box,
      levels,
      paletteKey
    });
  }

  async computeWaveformPath(
    sessionId: number,
    segs: LinearSeg[],
    y: number,
    h: number
  ): Promise<string> {
    return invoke<string>('compute_waveform_path', { sessionId, segs, y, h });
  }

  async findZeroCrossing(sessionId: number, t: number, maxWindowSec: number): Promise<number> {
    return invoke<number>('find_zero_crossing', { sessionId, t, maxWindowSec });
  }

  async openNativeFileDialog(
    filters: NativeFileFilter[],
    options?: { title?: string; multiple?: boolean }
  ): Promise<NativeOpenedFile[] | null> {
    if (!hasTauriInternals()) return null;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const lastDir = loadLastDir();
    const selected = await open({
      title: options?.title,
      filters,
      multiple: options?.multiple ?? false,
      defaultPath: lastDir || undefined
    });
    if (!selected) return null;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return null;
    rememberDirFromPath(paths[0]);
    const results: NativeOpenedFile[] = [];
    for (const p of paths) {
      const raw = await invoke<number[]>('read_local_file', { path: p });
      results.push({ path: p, name: getBaseName(p), bytes: new Uint8Array(raw) });
    }
    return results;
  }

  async saveNativeFileDialog(
    defaultName: string,
    filters: NativeFileFilter[],
    bytes: Uint8Array,
    options?: { title?: string }
  ): Promise<string | null> {
    if (!hasTauriInternals()) return null;
    const { save } = await import('@tauri-apps/plugin-dialog');
    const lastDir = loadLastDir();
    const selectedPath = await save({
      title: options?.title,
      filters,
      defaultPath: joinDirAndFile(lastDir, defaultName)
    });
    if (!selectedPath) return null;
    rememberDirFromPath(selectedPath);
    await invoke('write_local_file', { path: selectedPath, bytes: Array.from(bytes) });
    return selectedPath;
  }

  async readNativeFile(path: string): Promise<NativeOpenedFile | null> {
    if (!hasTauriInternals()) return null;
    const raw = await invoke<number[]>('read_local_file', { path });
    rememberDirFromPath(path);
    return { path, name: getBaseName(path), bytes: new Uint8Array(raw) };
  }

  async writeNativeFile(path: string, bytes: Uint8Array): Promise<boolean> {
    if (!hasTauriInternals()) return false;
    await invoke('write_local_file', { path, bytes: Array.from(bytes) });
    rememberDirFromPath(path);
    return true;
  }

  async findCompanionAudio(tgPath: string): Promise<string | null> {
    if (!hasTauriInternals()) return null;
    return invoke<string | null>('find_companion_audio', { tgPath });
  }

  async revealInExplorer(path: string): Promise<boolean> {
    if (!hasTauriInternals()) return false;
    await invoke('reveal_in_explorer', { path });
    return true;
  }

  async openExternalUrl(url: string): Promise<void> {
    if (hasTauriInternals()) {
      await invoke('open_external_url', { url });
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async getLaunchFileArg(): Promise<string | null> {
    if (!hasTauriInternals()) return null;
    return invoke<string | null>('get_launch_file_arg');
  }

  async readClipboardText(): Promise<string> {
    if (hasTauriInternals()) {
      return invoke<string>('read_clipboard_text');
    }
    return navigator.clipboard.readText();
  }

  async writeClipboardText(text: string): Promise<void> {
    if (hasTauriInternals()) {
      await invoke('write_clipboard_text', { text });
      return;
    }
    await navigator.clipboard.writeText(text);
  }
}
