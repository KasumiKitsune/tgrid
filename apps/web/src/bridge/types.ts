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

export type AcousticSplitGranularity =
  | 'delimiter'
  | 'word'
  | 'syllable'
  | 'onset-rime'
  | 'phone'
  | 'tone-split';

export type AcousticSplitSegmentClass =
  | 'voiceless-obs'
  | 'voiced-obs'
  | 'nasal-liquid'
  | 'vowel'
  | 'syllable'
  | 'other';

export interface AcousticSplitF0Frame {
  timeSec: number;
  f0Hz: number;
}

export interface AcousticSplitParams {
  sampleRate: number;
  samplesOriginSec?: number;
  xmin: number;
  xmax: number;
  granularity: AcousticSplitGranularity;
  durationWeights: number[];
  acousticClasses: AcousticSplitSegmentClass[];
  f0Frames?: AcousticSplitF0Frame[];
  useNn?: boolean;
}

export interface AcousticSplitResult {
  cuts: number[];
  confidence: number;
  fallbackToEqual: boolean;
  speechSpan: [number, number];
}

export interface VadParams {
  frameMs?: number;
  hopMs?: number;
  minSpeechMs?: number;
  mergeGapMs?: number;
  splitGapMs?: number;
  padMs?: number;
  snapZeroCrossing?: boolean;
}

export interface VadSegmentResult {
  start: number;
  end: number;
}

export type AcousticSnapKind = 'phone' | 'syllable' | 'none';

export interface AcousticSnapPeak {
  timeSec: number;
  strength: number;
  kind: AcousticSnapKind;
}

export interface AcousticSnapResult {
  found: boolean;
  snappedTimeSec: number;
  confidence: number;
  kind: AcousticSnapKind;
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

export interface NativeFileStat {
  exists: boolean;
  size: number;
  modifiedMs: number;
}

export interface DroppedPathInfo {
  path: string;
  name: string;
  parentDir: string;
  isDir: boolean;
  size: number;
  exists: boolean;
}

export interface CorpusScannedAudioFile {
  relPath: string;
  stem: string;
  duration: number | null;
  sizeBytes: number;
  modifiedMs: number;
}

export interface CorpusScannedFileEntry {
  relPath: string;
  stem: string;
  sizeBytes: number;
  modifiedMs: number;
}

export interface CorpusDirScanResult {
  dirPath: string;
  dirName: string;
  audioFiles: CorpusScannedAudioFile[];
  textGridFiles: CorpusScannedFileEntry[];
  hasProjectFile: boolean;
  projectFileRelPath: string;
  wordListFiles: string[];
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
  loadWavFileSession(path: string, offset: number): Promise<AudioAnalysisSummary | null>;
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
  alignSplitBoundaries(
    samples: Float32Array,
    params: AcousticSplitParams
  ): Promise<AcousticSplitResult>;
  detectSpeechSegmentsNn(
    samples: Float32Array,
    sampleRate: number,
    params?: VadParams
  ): Promise<VadSegmentResult[]>;
  extractAcousticSnapPeaks(
    samples: Float32Array,
    sampleRate: number,
    samplesOriginSec: number,
    xmin: number,
    xmax: number
  ): Promise<AcousticSnapPeak[]>;
  snapAcousticBoundary(
    samples: Float32Array,
    sampleRate: number,
    samplesOriginSec: number,
    targetTimeSec: number,
    windowSec?: number
  ): Promise<AcousticSnapResult>;

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
  readNativeFileIfExists(path: string): Promise<Uint8Array | null>;
  statNativeFile?(path: string): Promise<NativeFileStat | null>;
  inspectDroppedPaths?(paths: string[]): Promise<DroppedPathInfo[] | null>;
  writeNativeFile(path: string, bytes: Uint8Array): Promise<boolean>;
  writeNativeFileAtomic(path: string, bytes: Uint8Array): Promise<boolean>;
  openNativeDirectoryDialog(options?: { title?: string }): Promise<string | null>;
  scanCorpusDir(dir: string): Promise<CorpusDirScanResult | null>;
  findCompanionAudio(tgPath: string): Promise<string | null>;
  revealInExplorer(path: string): Promise<boolean>;
  openExternalUrl(url: string): Promise<void>;
  getLaunchFileArg(): Promise<string | null>;

  // System Clipboard (Desktop uses native OS API without WebView permission prompts)
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
}
