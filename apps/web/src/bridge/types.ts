export type TierKind = 'intervalTier' | 'textTier';
export type TextGridFormat = 'longText' | 'shortText' | 'binary' | 'chronological';
export type CollectionFormat = 'longText' | 'binary';

export interface Interval {
  xmin: number;
  xmax: number;
  text: string;
}

export interface TextPoint {
  number: number;
  mark: string;
}

export interface Tier {
  kind: TierKind;
  name: string;
  xmin: number;
  xmax: number;
  intervals: Interval[];
  points: TextPoint[];
  displayNum?: number;
}

export interface TextGrid {
  name: string;
  xmin: number;
  xmax: number;
  tiers: Tier[];
}

export interface SoundObject {
  name: string;
  xmin: number;
  xmax: number;
  nx: number;
  dx: number;
  x1: number;
  ny: number;
  channels: number[][];
}

export type CollectionItem =
  | ({ type: 'TextGrid' } & TextGrid)
  | ({ type: 'Sound' } & SoundObject);

export interface ParsedDocument {
  sourceFormat: string;
  items: CollectionItem[];
}

export interface EngineInfo {
  name: string;
  version: string;
  backend: string;
}

export interface SliceOptions {
  tierIndices?: number[];
  tMin?: number;
  tMax?: number;
}

export interface TierDiagnostics {
  tierIndex: number;
  gapCount: number;
  overlapCount: number;
  zeroDurationCount: number;
  microSegmentCount: number;
  outOfDomain: boolean;
}

export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
}

export interface LinearSeg {
  x0: number;
  x1: number;
  t0: number;
  t1: number;
  collapsed?: boolean;
}

export interface ContourBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContourPath {
  level: number;
  threshold: number;
  fill: string;
  d: string;
}

export interface PitchPoint {
  t: number;
  f0: number | null;
}

export interface FormantPoint {
  t: number;
  freqs: number[];
}

export interface AudioSummary {
  sampleRate: number;
  sampleCount: number;
  duration: number;
  peakAmplitude: number;
}

export interface AudioAnalysisSummary {
  sessionId: number;
  sampleRate: number;
  sampleCount: number;
  duration: number;
  offset: number;
  peakAmplitude: number;
  specMaxDb: number;
  f0Floor: number;
  f0Ceil: number;
  pitchTrack: PitchPoint[];
  formantTrack: FormantPoint[];
}

export interface SpectrogramRgbaResult {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface IpaCandidate {
  text: string;
  code: string;
  suffix: string;
  synthetic: boolean;
  exact: boolean;
}

export interface YunlongStepResult {
  action: 'passthrough' | 'compose' | 'commit' | 'commit_and_compose' | 'commit_and_literal';
  commit: string;
  recent: string[];
  buffer: string;
}

export interface PraatMatch {
  code: string;
  ch: string;
  cp: number;
  al: number;
  isCombining: boolean;
}

export interface IpaConvertResult {
  text: string;
  changed: boolean;
}

export interface IpaSymbolInfo {
  sym: string;
  display: string;
  name: string;
  yunlong: string[];
  praat: string;
  unicode: string;
  isCombining: boolean;
}

export interface NativeFileFilter {
  name: string;
  extensions: string[];
}

export interface NativeOpenedFile {
  path: string;
  name: string;
  bytes: Uint8Array;
}

export interface PlatformBridge {
  readonly kind: 'tauri' | 'wasm';
  init(): Promise<void>;
  getEngineInfo(): Promise<EngineInfo>;
  parsePraatFile(bytes: Uint8Array, filename: string): Promise<ParsedDocument>;
  parseTextGrid(bytes: Uint8Array): Promise<TextGrid>;
  serializeTextGrid(tg: TextGrid, format: TextGridFormat): Promise<Uint8Array>;
  serializeCollection(items: CollectionItem[], format: CollectionFormat): Promise<Uint8Array>;
  sliceTextGrid(tg: TextGrid, opts: SliceOptions): Promise<TextGrid>;
  scanDiagnostics(tg: TextGrid): Promise<TierDiagnostics[]>;
  buildZipStore(entries: ZipEntryInput[]): Promise<Uint8Array>;

  // IPA Engine
  decodePraatTrigraphs(input: string): Promise<IpaConvertResult>;
  encodePraatTrigraphs(input: string): Promise<IpaConvertResult>;
  hasPraatTrigraphs(input: string): Promise<boolean>;
  getYunlongCandidates(buffer: string): Promise<IpaCandidate[]>;
  stepYunlongChar(buffer: string, ch: string): Promise<YunlongStepResult>;
  getPraatMatches(firstChar?: string): Promise<PraatMatch[]>;
  lookupIpaSymbol(sym: string): Promise<IpaSymbolInfo>;

  // Acoustic DSP Session
  summarizeAudio(samples: Float32Array, sampleRate: number): Promise<AudioSummary>;
  loadPcmSession(samples: Float32Array, sampleRate: number, offset: number): Promise<AudioAnalysisSummary>;
  loadWavSession(bytes: Uint8Array, offset: number): Promise<AudioAnalysisSummary>;
  removeAudioSession(sessionId: number): Promise<void>;
  clearAudioSession(): Promise<void>;
  renderSpectrogramRgba(
    sessionId: number,
    segs: LinearSeg[],
    bandOriginX: number,
    bandContentW: number,
    specH: number,
    maxFreq: number,
    scale: number,
    dynRange: number,
    paletteKey: string
  ): Promise<SpectrogramRgbaResult>;
  computeBandContours(
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
  ): Promise<ContourPath[]>;
  computeWaveformPath(sessionId: number, segs: LinearSeg[], y: number, h: number): Promise<string>;
  findZeroCrossing(sessionId: number, t: number, maxWindowSec: number): Promise<number>;

  // Native Desktop File I/O (Web/WASM returns null / false gracefully)
  openNativeFileDialog(
    filters: NativeFileFilter[],
    options?: { title?: string; multiple?: boolean }
  ): Promise<NativeOpenedFile[] | null>;
  saveNativeFileDialog(
    defaultName: string,
    filters: NativeFileFilter[],
    bytes: Uint8Array,
    options?: { title?: string }
  ): Promise<string | null>;
  readNativeFile(path: string): Promise<NativeOpenedFile | null>;
  writeNativeFile(path: string, bytes: Uint8Array): Promise<boolean>;
  findCompanionAudio(tgPath: string): Promise<string | null>;
  revealInExplorer(path: string): Promise<boolean>;
  openExternalUrl(url: string): Promise<void>;
  getLaunchFileArg(): Promise<string | null>;

  // System Clipboard (Desktop uses native OS API without WebView permission prompts)
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
}
