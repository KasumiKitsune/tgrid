import {
  initSync,
  engine_info_json,
  parse_praat_to_json,
  parse_textgrid_to_json,
  serialize_textgrid_from_json,
  serialize_collection_from_json,
  slice_textgrid_json,
  scan_diagnostics_json,
  build_zip_store_packed,
  decode_praat_trigraphs_json,
  encode_praat_trigraphs_json,
  has_praat_trigraphs,
  get_yunlong_candidates_json,
  step_yunlong_char_json,
  get_praat_matches_json,
  lookup_ipa_symbol_json,
  summarize_audio_json,
  load_pcm_session_json,
  load_wav_session_json,
  remove_audio_session,
  clear_audio_session,
  render_spectrogram_rgba_packed,
  compute_band_contours_json,
  compute_waveform_path,
  find_zero_crossing
} from '../wasm-pkg/tg_wasm';
import wasmUrl from '../wasm-pkg/tg_wasm_bg.wasm?url';
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

function decodeDataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function unpackRgba(packed: Uint8Array): SpectrogramRgbaResult {
  if (packed.length < 8) {
    return { width: 0, height: 0, rgba: new Uint8ClampedArray(0) };
  }
  const dv = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const width = dv.getUint32(0, false);
  const height = dv.getUint32(4, false);
  const rgba = new Uint8ClampedArray(packed.buffer, packed.byteOffset + 8, packed.byteLength - 8);
  return { width, height, rgba };
}

export class WebWasmBridge implements PlatformBridge {
  readonly kind = 'wasm' as const;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      if (wasmUrl.startsWith('data:')) {
        // Single-file offline HTML mode (works cleanly under file:// with zero CORS issues)
        const bytes = decodeDataUrlToBytes(wasmUrl);
        initSync({ module: bytes });
      } else {
        const mod =
          typeof WebAssembly.compileStreaming === 'function'
            ? await WebAssembly.compileStreaming(fetch(wasmUrl)).catch(async () => {
                const resp = await fetch(wasmUrl);
                return new Uint8Array(await resp.arrayBuffer());
              })
            : new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
        initSync({ module: mod });
      }
      this.initialized = true;
    })();
    return this.initPromise;
  }

  async getEngineInfo(): Promise<EngineInfo> {
    await this.init();
    return JSON.parse(engine_info_json()) as EngineInfo;
  }

  async parsePraatFile(bytes: Uint8Array, filename: string): Promise<ParsedDocument> {
    await this.init();
    return JSON.parse(parse_praat_to_json(bytes, filename)) as ParsedDocument;
  }

  async parseTextGrid(bytes: Uint8Array): Promise<TextGrid> {
    await this.init();
    return JSON.parse(parse_textgrid_to_json(bytes)) as TextGrid;
  }

  async serializeTextGrid(tg: TextGrid, format: TextGridFormat): Promise<Uint8Array> {
    await this.init();
    return serialize_textgrid_from_json(JSON.stringify(tg), format);
  }

  async serializeCollection(items: CollectionItem[], format: CollectionFormat): Promise<Uint8Array> {
    await this.init();
    return serialize_collection_from_json(JSON.stringify(items), format);
  }

  async sliceTextGrid(tg: TextGrid, opts: SliceOptions): Promise<TextGrid> {
    await this.init();
    return JSON.parse(slice_textgrid_json(JSON.stringify(tg), JSON.stringify(opts))) as TextGrid;
  }

  async scanDiagnostics(tg: TextGrid): Promise<TierDiagnostics[]> {
    await this.init();
    return JSON.parse(scan_diagnostics_json(JSON.stringify(tg))) as TierDiagnostics[];
  }

  async buildZipStore(entries: ZipEntryInput[]): Promise<Uint8Array> {
    await this.init();
    const names = entries.map((e) => e.name);
    const lengths = new Uint32Array(entries.length);
    let total = 0;
    for (let i = 0; i < entries.length; i++) {
      lengths[i] = entries[i].data.length;
      total += entries[i].data.length;
    }
    const flat = new Uint8Array(total);
    let off = 0;
    for (const e of entries) {
      flat.set(e.data, off);
      off += e.data.length;
    }
    return build_zip_store_packed(JSON.stringify(names), lengths, flat);
  }

  async decodePraatTrigraphs(input: string): Promise<IpaConvertResult> {
    await this.init();
    return JSON.parse(decode_praat_trigraphs_json(input)) as IpaConvertResult;
  }

  async encodePraatTrigraphs(input: string): Promise<IpaConvertResult> {
    await this.init();
    return JSON.parse(encode_praat_trigraphs_json(input)) as IpaConvertResult;
  }

  async hasPraatTrigraphs(input: string): Promise<boolean> {
    await this.init();
    return has_praat_trigraphs(input);
  }

  async getYunlongCandidates(buffer: string): Promise<IpaCandidate[]> {
    await this.init();
    return JSON.parse(get_yunlong_candidates_json(buffer)) as IpaCandidate[];
  }

  async stepYunlongChar(buffer: string, ch: string): Promise<YunlongStepResult> {
    await this.init();
    return JSON.parse(step_yunlong_char_json(buffer, ch)) as YunlongStepResult;
  }

  async getPraatMatches(firstChar?: string): Promise<PraatMatch[]> {
    await this.init();
    return JSON.parse(get_praat_matches_json(firstChar ?? '')) as PraatMatch[];
  }

  async lookupIpaSymbol(sym: string): Promise<IpaSymbolInfo> {
    await this.init();
    return JSON.parse(lookup_ipa_symbol_json(sym)) as IpaSymbolInfo;
  }

  async summarizeAudio(samples: Float32Array, sampleRate: number): Promise<AudioSummary> {
    await this.init();
    return JSON.parse(summarize_audio_json(samples, sampleRate)) as AudioSummary;
  }

  async loadPcmSession(
    samples: Float32Array,
    sampleRate: number,
    offset: number
  ): Promise<AudioAnalysisSummary> {
    await this.init();
    return JSON.parse(load_pcm_session_json(samples, sampleRate, offset)) as AudioAnalysisSummary;
  }

  async loadWavSession(bytes: Uint8Array, offset: number): Promise<AudioAnalysisSummary> {
    await this.init();
    return JSON.parse(load_wav_session_json(bytes, offset)) as AudioAnalysisSummary;
  }

  async removeAudioSession(sessionId: number): Promise<void> {
    await this.init();
    remove_audio_session(sessionId);
  }

  async clearAudioSession(): Promise<void> {
    await this.init();
    clear_audio_session();
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
    await this.init();
    const packed = render_spectrogram_rgba_packed(
      sessionId,
      JSON.stringify(segs),
      bandOriginX,
      bandContentW,
      specH,
      maxFreq,
      scale,
      dynRange,
      paletteKey
    );
    return unpackRgba(packed);
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
    await this.init();
    return JSON.parse(
      compute_band_contours_json(
        sessionId,
        JSON.stringify(segs),
        bandOriginX,
        bandContentW,
        maxFreq,
        cols,
        rows,
        dynRange,
        smooth,
        JSON.stringify(box),
        levels,
        paletteKey
      )
    ) as ContourPath[];
  }

  async computeWaveformPath(
    sessionId: number,
    segs: LinearSeg[],
    y: number,
    h: number
  ): Promise<string> {
    await this.init();
    return compute_waveform_path(sessionId, JSON.stringify(segs), y, h);
  }

  async findZeroCrossing(sessionId: number, t: number, maxWindowSec: number): Promise<number> {
    await this.init();
    return find_zero_crossing(sessionId, t, maxWindowSec);
  }

  async openNativeFileDialog(
    _filters: NativeFileFilter[],
    _options?: { title?: string; multiple?: boolean }
  ): Promise<NativeOpenedFile[] | null> {
    return null;
  }

  async saveNativeFileDialog(
    _defaultName: string,
    _filters: NativeFileFilter[],
    _bytes: Uint8Array,
    _options?: { title?: string }
  ): Promise<string | null> {
    return null;
  }

  async readNativeFile(_path: string): Promise<NativeOpenedFile | null> {
    return null;
  }

  async writeNativeFile(_path: string, _bytes: Uint8Array): Promise<boolean> {
    return false;
  }

  async findCompanionAudio(_tgPath: string): Promise<string | null> {
    return null;
  }

  async revealInExplorer(_path: string): Promise<boolean> {
    return false;
  }

  async openExternalUrl(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async getLaunchFileArg(): Promise<string | null> {
    return null;
  }

  async readClipboardText(): Promise<string> {
    return navigator.clipboard.readText();
  }

  async writeClipboardText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall through to execCommand fallback
      }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(ta);
    }
  }
}
