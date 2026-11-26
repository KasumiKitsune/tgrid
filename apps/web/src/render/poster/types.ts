import type { AudioAnalysisSummary, PlatformBridge, TextGrid } from '../../bridge/types';
import type { F0RangeBounds } from '../../utils/f0Range';
import type { EditorSelection } from '../renderScoreSvg';

export type PosterTemplateId =
  | 'vinyl'
  | 'bauhaus'
  | 'braun_strip'
  | 'folding_fan'
  | 'risograph';
export type PosterFraming = 'poster_3_4' | 'emblem_1_1';
export type PosterBgMode = 'paper' | 'transparent';
export type PosterRangeMode = 'all' | 'view' | 'selection';
export type PosterPngScale = 2 | 3 | 4;

export interface PosterTemplateMeta {
  id: PosterTemplateId;
  nameZh: string;
  subtitleZh: string;
  eraLabel: string;
  layoutKind: 'polar' | 'linear';
  sweepDeg: number;
  paperColor: string;
  accentColor: string;
}

export const POSTER_TEMPLATE_ORDER: PosterTemplateId[] = [
  'vinyl',
  'bauhaus',
  'braun_strip',
  'folding_fan',
  'risograph'
];

export const POSTER_TEMPLATE_REGISTRY: Record<PosterTemplateId, PosterTemplateMeta> = {
  vinyl: {
    id: 'vinyl',
    nameZh: '黑胶声纹',
    subtitleZh: '瑞士精密唱片 · 324° 环轨',
    eraLabel: 'SWISS / BRAUN',
    layoutKind: 'polar',
    sweepDeg: 324,
    paperColor: '#F4F0E8',
    accentColor: '#D64028'
  },
  bauhaus: {
    id: 'bauhaus',
    nameZh: '包豪斯日晷',
    subtitleZh: '魏玛几何放射 · 224° 扇面',
    eraLabel: 'WEIMAR 1923',
    layoutKind: 'polar',
    sweepDeg: 224,
    paperColor: '#F2ECE1',
    accentColor: '#1B4F9C'
  },
  braun_strip: {
    id: 'braun_strip',
    nameZh: '博朗纸带',
    subtitleZh: '工业记录仪 · 双尺走纸',
    eraLabel: 'BRAUN / RAMS',
    layoutKind: 'linear',
    sweepDeg: 0,
    paperColor: '#EAE9E4',
    accentColor: '#E84A27'
  },
  folding_fan: {
    id: 'folding_fan',
    nameZh: '东方折扇',
    subtitleZh: '宋明水墨扇谱 · 135° 展扇',
    eraLabel: 'SONG / MING',
    layoutKind: 'polar',
    sweepDeg: 135,
    paperColor: '#F7F5EE',
    accentColor: '#2D666B'
  },
  risograph: {
    id: 'risograph',
    nameZh: '孔版印画',
    subtitleZh: '三色错位叠印 · 半色调丝带',
    eraLabel: 'RISOGRAPH',
    layoutKind: 'linear',
    sweepDeg: 0,
    paperColor: '#F8F4EA',
    accentColor: '#FF5277'
  }
};

export interface PosterCopyOverrides {
  title: string;
  subtitle: string;
  footer: string;
  pointNotes: Record<string, string>;
}

export interface PosterPrefs {
  template: PosterTemplateId;
  framing: PosterFraming;
  bgMode: PosterBgMode;
  includeBleed: boolean;
  rangeMode: PosterRangeMode;
  showSpectrogram: boolean;
  showWaveform: boolean;
  showPitch: boolean;
  pngScale: PosterPngScale;
  pureVisual: boolean;
}

export interface PosterConfig extends PosterPrefs {
  intervalTierIndices: number[];
  pointTierIndex: number | null;
  copy: PosterCopyOverrides;
}

export interface PosterRenderInput {
  bridge: PlatformBridge;
  tg: TextGrid;
  filename: string;
  config: PosterConfig;
  previewMode: boolean;
  viewDomain: { min: number; max: number } | null;
  playRange: { start: number; end: number } | null;
  selection: EditorSelection;
  hasAudio: boolean;
  audioBuffer: AudioBuffer | null;
  audioOffset: number;
  audioSampleRate: number;
  analysis: AudioAnalysisSummary | null;
  maxFreq: number;
  f0RangeOverride?: F0RangeBounds | null;
  dynRange?: number;
}

export interface PolarColumn {
  idx: number;
  a: number;
  b: number;
  dt: number;
  allEmpty: boolean;
  degLin: number;
  degFloor: number;
  degVar: number;
  lin0: number;
  lin1: number;
  var0: number;
  var1: number;
}

export interface PolarRingBand {
  tierIdx: number;
  ringIndex: number;
  name: string;
  rIn: number;
  rOut: number;
  rMid: number;
  fontSize: number;
  isIpaLike: boolean;
  hasCombining: boolean;
}

export interface PolarPointPlacement {
  idx: number;
  time: number;
  rawMark: string;
  mark: string;
  note: string;
  trueAngleDeg: number;
  badgeAngleDeg: number;
}

export interface PolarLayout {
  template: PosterTemplateId;
  cx: number;
  cy: number;
  startDeg: number;
  totalDeg: number;
  endDeg: number;
  tMin: number;
  tMax: number;
  duration: number;
  bnds: number[];
  cols: PolarColumn[];
  thetaLin: number[];
  thetaVar: number[];
  rings: PolarRingBand[];
  pointTierIdx: number | null;
  pointTierName: string | null;
  points: PolarPointPlacement[];
  rTone: number;
  rTimeAxis: number;
  rPlatter: number;
  rBadge: number;
  rBridgeOut: number;
  ring0IsUmbrella: boolean;
  wordBoundaries: number[];
  sylBoundaries: number[];
  broadBoundaries: number[];
}

export interface PosterAutoCopy {
  title: string;
  subtitle: string;
  footer: string;
  centerQuote: string;
  sideLabel: string;
}

export interface PolarDiscRasterResult {
  dataUrl: string;
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
}

export interface PosterResult {
  svgMarkup: string;
  widthPt: number;
  heightPt: number;
  trimWidthPt: number;
  trimHeightPt: number;
  bleedPt: number;
  tMin: number;
  tMax: number;
  duration: number;
  estimatedBytes: number;
  autoCopy: PosterAutoCopy;
  activeIntervalCount: number;
  activePointCount: number;
}

/** 3mm bleed in PostScript points (3 / 25.4 * 72 ≈ 8.504 pt). */
export const POSTER_BLEED_PT = 8.504;
