import type { AudioAnalysisSummary, TextGrid } from '../bridge/types.ts';
import {
  IPA_FONT_STACK,
  MONO_FONT_STACK,
  SANS_FONT_STACK,
  SYMBOL_FONT_STACK,
  measurePx
} from './richText.ts';
import type { BandLayout, GlobalScaleMode, RichTextLayout, ScoreLayout } from './computeLayout.ts';

export const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ScorePalette {
  isBw: boolean;
  paper: string;
  ink: string;
  border: string;
  muted: string;
  mutedAlt: string;
  faint: string;
  faintTick: string;
  rule: string;
  gridMajor: string;
  gridMinor: string;
  tickMinor: string;
  waveBg: string;
  waveFill: string;
  waveMid: string;
  linBg: string;
  linWaveFill: string;
  anchorBg: string;
  anchorStroke: string;
  emptyCell: string;
  cellFill: string;
  wire: string;
  pitch: string;
  pitchHalo: string;
  formant: string;
  amber: string;
  microWarn: string;
  gapBg: string;
  gapStroke: string;
  oodBg: string;
  oodStroke: string;
  ovlStroke: string;
  zeroBg: string;
  gloss: string;
  meta: string;
  ctrl: string;
  tierAccents: string[];
}

export const TIER_ACCENTS = ['#1E3A5F', '#4A5568', '#5B4B3A', '#2D5A4A', '#6B3A4E', '#3F4F6B'];

export const WARM_PALETTE: ScorePalette = {
  isBw: false,
  paper: '#FFFFFF',
  ink: '#141413',
  border: '#2A2926',
  muted: '#54514A',
  mutedAlt: '#524F48',
  faint: '#5E5B53',
  faintTick: '#5C5951',
  rule: '#C8C4BA',
  gridMajor: '#C9C5BB',
  gridMinor: '#E5E2DA',
  tickMinor: '#7D7A72',
  waveBg: '#F6F5F0',
  waveFill: '#2B2A27',
  waveMid: '#BDB9AF',
  linBg: '#F3F1EC',
  linWaveFill: '#3A3935',
  anchorBg: '#F2F0EA',
  anchorStroke: '#9E9B92',
  emptyCell: '#F2F0EA',
  cellFill: '#FFFFFF',
  wire: '#52504A',
  pitch: '#1D4ED8',
  pitchHalo: '#FFFFFF',
  formant: '#B91C1C',
  amber: '#B45309',
  microWarn: '#D97706',
  gapBg: '#FBF8F3',
  gapStroke: '#D97706',
  oodBg: '#ECEAE4',
  oodStroke: '#9E9B92',
  ovlStroke: '#B91C1C',
  zeroBg: '#FFFBEB',
  gloss: '#6D28D9',
  meta: '#0F766E',
  ctrl: '#9A3412',
  tierAccents: TIER_ACCENTS
};

export const BW_PALETTE: ScorePalette = {
  isBw: true,
  paper: '#FFFFFF',
  ink: '#000000',
  border: '#000000',
  muted: '#3B3B3B',
  mutedAlt: '#454545',
  faint: '#525252',
  faintTick: '#545454',
  rule: '#B5B5B5',
  gridMajor: '#BDBDBD',
  gridMinor: '#E0E0E0',
  tickMinor: '#595959',
  waveBg: '#FAFAFA',
  waveFill: '#000000',
  waveMid: '#A3A3A3',
  linBg: '#F5F5F5',
  linWaveFill: '#000000',
  anchorBg: '#F5F5F5',
  anchorStroke: '#666666',
  emptyCell: '#F4F4F4',
  cellFill: '#FFFFFF',
  wire: '#1F1F1F',
  pitch: '#000000',
  pitchHalo: '#FFFFFF',
  formant: '#111111',
  amber: '#666666',
  microWarn: '#525252',
  gapBg: '#F7F7F7',
  gapStroke: '#595959',
  oodBg: '#EFEFEF',
  oodStroke: '#737373',
  ovlStroke: '#222222',
  zeroBg: '#F5F5F5',
  gloss: '#555555',
  meta: '#666666',
  ctrl: '#4D4D4D',
  tierAccents: ['#000000', '#262626', '#404040', '#171717', '#525252', '#333333']
};

export function getExportPalette(key: 'warm' | 'bw' | string): ScorePalette {
  return key === 'bw' ? BW_PALETTE : WARM_PALETTE;
}

export function svgEl(
  tag: string,
  attrs: Record<string, string | number | undefined | null> = {},
  parent: Element | null = null
): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

export interface LegendCatalogItem {
  key: string;
  zh: string;
  en: string;
  label: string;
  swatchVariant?: 'contour' | 'raster';
}

export const LEGEND_CATALOG: Array<{ key: string; zh: string; en: string }> = [
  { key: 'labeled-interval', zh: '标注区间', en: 'Labeled interval' },
  { key: 'empty-interval', zh: '空区间 / 静音段', en: 'Empty / silent interval' },
  { key: 'labeled-point', zh: '标注点', en: 'Labeled point' },
  { key: 'empty-point', zh: '空白标注点', en: 'Unlabeled point' },
  { key: 'boundaries', zh: '多层对齐 / 单层边界', en: 'Shared / tier boundary' },
  { key: 'stretch', zh: '短音段加宽显示', en: 'Widened short segment' },
  { key: 'collapsed-pause', zh: '长静音省略 (≥0.5 s)', en: 'Folded silence (≥0.5 s)' },
  { key: 'continuation', zh: '跨行延续区间', en: 'Wrapped continuation' },
  { key: 'spectrogram', zh: '宽带语谱图', en: 'Broadband spectrogram' },
  { key: 'pitch-f0', zh: '基频曲线 (F₀)', en: 'Pitch contour (F₀)' },
  { key: 'formants', zh: '共振峰 (F₁–F₃)', en: 'Formants (F₁–F₃)' },
  { key: 'trigraph', zh: '音标与 Praat 原码', en: 'IPA & Praat trigraph' },
  { key: 'meta-symbols', zh: '空格与换行标记', en: 'Space / line-break mark' },
  { key: 'zero-dur', zh: '零时长区间 (0 s)', en: 'Zero-duration interval' },
  { key: 'gap', zh: '层内空隙', en: 'Unannotated gap' },
  { key: 'overlap', zh: '同层重叠区间', en: 'Overlapping intervals' },
  { key: 'ood', zh: '超出该层时间范围', en: 'Outside tier domain' },
  { key: 'micro-seg', zh: '极短音段 (<5 ms)', en: 'Micro-segment (<5 ms)' }
];

const STRUCTURE_LINES = {
  zh: {
    elastic: [
      '① 顶部原始时间轴 (1:1)：波形、语谱图或各层标注分布',
      '② 对齐连线与时间刻度 (s)：将短音段适度拉宽以便读字',
      '③ 多层级标注：竖线对齐各层的区间与标注点'
    ],
    mixed: [
      '① 顶部原始时间轴与 1:1 线性层：语谱图与粗粒度层严格垂直对齐',
      '② 过渡颈与时间刻度 (s)：将细粒度层按字宽适度展开以便读字',
      '③ 弹性标注层：竖线对齐各层音段边界与标注点'
    ],
    linear: [
      '① 顶部原始时间轴 (1:1)：波形、语谱图或各层标注分布',
      '② 线性时间刻度 (s)：全图按 1:1 真实时长垂直对齐',
      '③ 多层级标注：竖线对齐各层的区间与标注点'
    ]
  },
  en: {
    elastic: [
      '① True-time track (1:1): waveform, spectrogram, or tier activity',
      '② Alignment lines & ticks (s): short segments widened for legibility',
      '③ Annotation tiers: vertical lines align intervals and points'
    ],
    mixed: [
      '① True-time track & 1:1 linear tiers: spectrogram and coarse tiers strictly aligned',
      '② Transition neck & ticks (s): fine tiers widened for label legibility',
      '③ Elastic annotation tiers: vertical lines align intervals and points'
    ],
    linear: [
      '① True-time track (1:1): waveform, spectrogram, or tier activity',
      '② Linear time axis (s): strict 1:1 vertical time alignment',
      '③ Annotation tiers: vertical lines align intervals and points'
    ]
  }
} as const;

export function getStructureLines(scaleMode: GlobalScaleMode, lang: 'zh' | 'en' = 'zh'): string[] {
  return [...STRUCTURE_LINES[lang][scaleMode]];
}

export function formatCaptionTimeText(
  xmin: number,
  xmax: number,
  lang: 'zh' | 'en' = 'zh',
  fmtFn?: (v: number) => string
): string {
  const fmt = fmtFn || ((v: number) => v.toFixed(3));
  const a = Number.isFinite(xmin) ? xmin : 0;
  const b = Number.isFinite(xmax) ? xmax : a;
  const dur = Math.max(0, b - a);
  return lang === 'en'
    ? `${fmt(a)} – ${fmt(b)} s · Duration ${fmt(dur)} s`
    : `${fmt(a)} – ${fmt(b)} s · 时长 ${fmt(dur)} s`;
}

export function resolveScreenCueOpacities(
  cueMode: 'auto' | 'pitch' | 'formant' | 'plain',
  selectionKind?: string | null
): { spec: number; pitch: number; formant: number } {
  if (cueMode === 'pitch') return { spec: 0.46, pitch: 1, formant: 0 };
  if (cueMode === 'formant') return { spec: 0.95, pitch: 0, formant: 0.92 };
  if (cueMode === 'plain') return { spec: 1, pitch: 0, formant: 0 };
  if (selectionKind === 'point') return { spec: 0.42, pitch: 1, formant: 0 };
  if (selectionKind === 'interval' || selectionKind === 'boundary') {
    return { spec: 0.96, pitch: 0.14, formant: 0.88 };
  }
  return { spec: 1, pitch: 0.6, formant: 0 };
}

function richHasMetaTokens(rich: RichTextLayout | null): boolean {
  if (!rich) return false;
  for (const line of rich.lines) {
    for (const tok of line.tokens) {
      if (tok.kind !== 'text') return true;
    }
  }
  return false;
}

export interface CollectLegendOpts {
  isExport?: boolean;
  lang?: 'zh' | 'en';
  hideStretchCues?: boolean;
  hideMetaSymbols?: boolean;
  trigraphMode?: 'ipa-only' | 'dual' | 'raw-only';
  specStrategy?: string;
  specOpacity?: number;
  pitchOpacity?: number;
  formantOpacity?: number;
  cueMode?: 'auto' | 'pitch' | 'formant' | 'plain';
  selectionKind?: string | null;
  hasAudio?: boolean;
  analysis?: AudioAnalysisSummary | null;
  maxFreq?: number;
}

export function collectActiveLegendItems(
  tg: TextGrid,
  layout: Pick<ScoreLayout, 'bands' | 'scaleMode'>,
  opts: CollectLegendOpts = {}
): LegendCatalogItem[] {
  const isExport = Boolean(opts.isExport);
  const lang = opts.lang === 'en' ? 'en' : 'zh';
  const hideStretchCues = Boolean(opts.hideStretchCues);
  const hideMetaSymbols = Boolean(opts.hideMetaSymbols);
  const trigraphMode = opts.trigraphMode || (isExport ? 'ipa-only' : 'dual');
  const specStrategy = opts.specStrategy || 'raster';
  const effectiveScaleMode = layout.scaleMode || 'elastic';

  let { specOpacity, pitchOpacity, formantOpacity } = opts;
  if (!isExport && (specOpacity === undefined || pitchOpacity === undefined || formantOpacity === undefined)) {
    const sc = resolveScreenCueOpacities(opts.cueMode || 'auto', opts.selectionKind);
    specOpacity ??= sc.spec;
    pitchOpacity ??= sc.pitch;
    formantOpacity ??= sc.formant;
  }
  specOpacity ??= 1;
  pitchOpacity ??= 0.6;
  formantOpacity ??= 0;

  const flags: Record<string, boolean> = {};
  for (const item of LEGEND_CATALOG) flags[item.key] = false;

  const hasAudio = Boolean(opts.hasAudio);
  const analysis = opts.analysis || null;
  const maxFreq = opts.maxFreq || 5000;
  const hasSpecBand = hasAudio && layout.bands.some((b) => b.specH > 0);

  if (hasSpecBand && analysis && specStrategy !== 'curves-only' && specOpacity > 0.001) {
    flags['spectrogram'] = true;
  }

  for (const band of layout.bands) {
    if (effectiveScaleMode !== 'linear') {
      for (const seg of band.linearSegs) {
        if (seg.collapsed) flags['collapsed-pause'] = true;
        if (!hideStretchCues && seg.isStretched) flags['stretch'] = true;
      }
    }

    if (!hideStretchCues) {
      for (let i = 1; i < band.spineCols.length; i++) {
        const dt = band.spineCols[i].t - band.spineCols[i - 1].t;
        if (dt > 1e-12 && dt < 0.005 - 1e-9) {
          flags['micro-seg'] = true;
          break;
        }
      }
    }

    if (hasSpecBand && band.specH > 0 && analysis) {
      if (!flags['pitch-f0'] && pitchOpacity > 0.001) {
        for (const p of analysis.pitchTrack) {
          if (p.t < band.startT || p.t > band.endT || p.f0 === null || !Number.isFinite(p.f0)) continue;
          const seg = band.linearSegs.find((s) => p.t >= s.t0 && p.t <= s.t1);
          if (seg && !seg.collapsed) {
            flags['pitch-f0'] = true;
            break;
          }
        }
      }
      if (!flags['formants'] && formantOpacity > 0.001) {
        for (const frame of analysis.formantTrack) {
          if (frame.t < band.startT || frame.t > band.endT) continue;
          const seg = band.linearSegs.find((s) => frame.t >= s.t0 && frame.t <= s.t1);
          if (!seg || seg.collapsed) continue;
          if (frame.freqs.some((f) => f <= maxFreq)) {
            flags['formants'] = true;
            break;
          }
        }
      }
    }

    for (const tl of band.tiersLayout) {
      if (!tl) continue;
      const tier = tl.tier;
      if (!hideMetaSymbols && tier.name === '') flags['meta-symbols'] = true;

      const domStart = Math.max(band.startT, Number.isFinite(tier.xmin) ? tier.xmin : band.startT);
      const domEnd = Math.min(band.endT, Number.isFinite(tier.xmax) ? tier.xmax : band.endT);
      if (domStart > band.startT + 1e-12 || domEnd < band.endT - 1e-12) flags['ood'] = true;

      if (tl.meta.kind === 'intervalTier') {
        for (const g of tl.meta.gaps) {
          if (g.xmax > band.startT && g.xmin < band.endT) {
            flags['gap'] = true;
            break;
          }
        }
        for (const ov of tl.meta.overlaps) {
          if (ov.xmax > band.startT && ov.xmin < band.endT) {
            flags['overlap'] = true;
            break;
          }
        }
        for (const vi of tl.visibleIvs || []) {
          flags['boundaries'] = true;
          if (vi.iv.text === '') flags['empty-interval'] = true;
          else flags['labeled-interval'] = true;
          if (effectiveScaleMode !== 'linear' && !hideStretchCues && vi.isStretched) {
            flags['stretch'] = true;
          }
          if (layout.bands.length > 1 && (vi.clippedLeft || vi.clippedRight)) {
            flags['continuation'] = true;
          }
          if (vi.rich) {
            if ((!isExport || trigraphMode === 'dual') && vi.rich.gloss) flags['trigraph'] = true;
            if (!hideMetaSymbols && richHasMetaTokens(vi.rich)) flags['meta-symbols'] = true;
          }
        }
        for (const vz of tl.visibleZeros || []) {
          flags['boundaries'] = true;
          flags['zero-dur'] = true;
          if (vz.rich) {
            if ((!isExport || trigraphMode === 'dual') && vz.rich.gloss) flags['trigraph'] = true;
            if (!hideMetaSymbols && richHasMetaTokens(vz.rich)) flags['meta-symbols'] = true;
          }
        }
      } else {
        for (const vp of tl.visiblePts || []) {
          flags['boundaries'] = true;
          if (vp.rich) {
            flags['labeled-point'] = true;
            if ((!isExport || trigraphMode === 'dual') && vp.rich.gloss) flags['trigraph'] = true;
            if (!hideMetaSymbols && richHasMetaTokens(vp.rich)) flags['meta-symbols'] = true;
          } else {
            flags['empty-point'] = true;
          }
        }
      }
    }
  }

  void tg;
  const items: LegendCatalogItem[] = [];
  for (const spec of LEGEND_CATALOG) {
    if (!flags[spec.key]) continue;
    const item: LegendCatalogItem = {
      key: spec.key,
      zh: spec.zh,
      en: spec.en,
      label: lang === 'en' ? spec.en : spec.zh
    };
    if (spec.key === 'spectrogram') {
      item.swatchVariant = specStrategy === 'contour' ? 'contour' : 'raster';
    }
    items.push(item);
  }
  return items;
}

function wrapLineToWidth(text: string, maxW: number, font: string): string[] {
  if (maxW <= 20 || measurePx(text, font) <= maxW) return [text];
  const out: string[] = [];
  if (/\s/.test(text)) {
    const words = text.split(/(\s+)/);
    let cur = '';
    for (const part of words) {
      const cand = cur + part;
      if (cur && measurePx(cand.trimEnd(), font) > maxW) {
        out.push(cur.trimEnd());
        cur = part.trimStart();
      } else {
        cur = cand;
      }
    }
    if (cur.trim()) out.push(cur.trimEnd());
  }
  if (out.length === 0 || out.some((l) => measurePx(l, font) > maxW + 2)) {
    const chars = Array.from(text);
    const charOut: string[] = [];
    let cur = '';
    for (const ch of chars) {
      if (cur && measurePx(cur + ch, font) > maxW) {
        charOut.push(cur);
        cur = ch;
      } else {
        cur += ch;
      }
    }
    if (cur) charOut.push(cur);
    return charOut;
  }
  return out;
}

function truncateToWidth(text: string, maxW: number, font: string): string {
  if (measurePx(text, font) <= maxW) return text;
  let s = text;
  while (s.length > 1 && measurePx(s + '…', font) > maxW) {
    s = s.slice(0, -1);
  }
  return s + '…';
}

export interface EmbeddedLegendLayout {
  legendMode: 'full' | 'compact';
  layoutMode: 'compact-grid' | 'stacked' | 'dual';
  lang: 'zh' | 'en';
  scaleMode: GlobalScaleMode;
  topY: number;
  ruleY: number;
  boxX: number;
  boxW: number;
  height: number;
  structFontSize: number;
  itemFontSize: number;
  structBox: {
    x: number;
    y: number;
    w: number;
    h: number;
    diagX: number;
    diagY: number;
    diagW: number;
    diagH: number;
    textX: number;
    textStartY: number;
    lineH: number;
    lines: Array<{ text: string; cont: boolean }>;
  } | null;
  divider: { orientation: 'horizontal' | 'vertical'; x1: number; y1: number; x2: number; y2: number } | null;
  symbolsBox: {
    x: number;
    y: number;
    w: number;
    h: number;
    cols: number;
    rows: number;
    cells: Array<{
      item: LegendCatalogItem;
      x: number;
      y: number;
      w: number;
      h: number;
      swatchX: number;
      swatchY: number;
      labelX: number;
      labelY: number;
      displayLabel: string;
    }>;
  } | null;
  needsSpecGrad: boolean;
  items: LegendCatalogItem[];
}

export function computeLegendLayout(
  items: LegendCatalogItem[],
  opts: {
    legendMode: 'full' | 'compact' | 'off';
    lang: 'zh' | 'en';
    scaleMode: GlobalScaleMode;
    figureWidth: number;
    padX: number;
    topY: number;
    fontScale: number;
  }
): EmbeddedLegendLayout | null {
  if (opts.legendMode === 'off') return null;
  const hasStruct = opts.legendMode === 'full';
  if (!hasStruct && items.length === 0) return null;

  const isEn = opts.lang === 'en';
  const innerAvailW = Math.max(200, opts.figureWidth - opts.padX * 2);
  const boxW = opts.figureWidth > 1200 ? Math.min(840, innerAvailW) : innerAvailW;
  const boxX = opts.padX;
  const isNarrow = opts.figureWidth <= 460;
  const layoutMode: 'compact-grid' | 'stacked' | 'dual' = !hasStruct
    ? 'compact-grid'
    : isNarrow
      ? 'stacked'
      : 'dual';

  const ruleY = opts.topY + 10;
  const contentTopY = ruleY + 10;
  const structFontSize = Number(((isNarrow ? 8.5 : 8.8) * opts.fontScale).toFixed(2));
  const itemFontSize = Number(((isNarrow ? 8.5 : 9) * opts.fontScale).toFixed(2));
  const structFont = `${structFontSize}px ${SANS_FONT_STACK}`;
  const itemFont = `${itemFontSize}px ${SANS_FONT_STACK}`;
  const structLineH = Math.ceil(12.2 * opts.fontScale);
  const rowH = Math.ceil(16.5 * opts.fontScale);
  const swatchW = 22;
  const swatchH = 12;
  const swatchGap = 6;
  const diagW = 56;
  const diagH = 46;
  const diagGap = 10;

  const rawStructLines = hasStruct ? getStructureLines(opts.scaleMode, opts.lang) : [];
  const localizedItems = items.map((it) => ({ ...it, label: isEn ? it.en : it.zh }));

  const buildSymbolCells = (gridX: number, gridY: number, gridW: number, forceCols?: number) => {
    if (localizedItems.length === 0) {
      return { x: gridX, y: gridY, w: gridW, h: 0, cols: 0, rows: 0, cells: [] };
    }
    const itemWidths = localizedItems.map(
      (it) => swatchW + swatchGap + Math.ceil(measurePx(it.label, itemFont)) + 10
    );
    const maxNeededW = Math.max(92, ...itemWidths);
    let cols: number;
    if (forceCols) {
      cols = forceCols;
    } else {
      const maxColsCap = layoutMode === 'compact-grid' ? 5 : 4;
      cols = Math.max(
        1,
        Math.min(maxColsCap, localizedItems.length, Math.floor((gridW + 8) / maxNeededW))
      );
      if (cols === 1 && gridW >= 240 && localizedItems.length >= 2) {
        const p75 = [...itemWidths].sort((a, b) => a - b)[Math.floor(itemWidths.length * 0.75)];
        if (p75 <= gridW / 2) cols = 2;
      }
    }
    const colW = gridW / cols;
    const rows = Math.ceil(localizedItems.length / cols);
    const cells = localizedItems.map((item, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const cx = gridX + c * colW;
      const cy = gridY + r * rowH;
      const maxLabelW = Math.max(24, colW - swatchW - swatchGap - 4);
      return {
        item,
        x: cx,
        y: cy,
        w: colW,
        h: rowH,
        swatchX: cx,
        swatchY: cy + Math.max(0, (rowH - swatchH) / 2),
        labelX: cx + swatchW + swatchGap,
        labelY: cy + rowH / 2 + itemFontSize * 0.34,
        displayLabel: truncateToWidth(item.label, maxLabelW, itemFont)
      };
    });
    return { x: gridX, y: gridY, w: gridW, h: rows * rowH, cols, rows, cells };
  };

  const buildStructBlock = (sx: number, sy: number, sw: number) => {
    const textX = sx + diagW + diagGap;
    const textMaxW = Math.max(70, sw - diagW - diagGap - 4);
    const wrappedLines: Array<{ text: string; cont: boolean }> = [];
    for (const raw of rawStructLines) {
      wrapLineToWidth(raw, textMaxW, structFont).forEach((p, idx) =>
        wrappedLines.push({ text: p, cont: idx > 0 })
      );
    }
    const textBlockH = wrappedLines.length * structLineH;
    const blockH = Math.max(diagH, textBlockH);
    const diagY = sy + Math.max(0, (blockH - diagH) / 2);
    const textStartY = sy + Math.max(0, (blockH - textBlockH) / 2) + structFontSize * 0.95;
    return {
      x: sx,
      y: sy,
      w: sw,
      h: blockH,
      diagX: sx,
      diagY,
      diagW,
      diagH,
      textX,
      textStartY,
      lineH: structLineH,
      lines: wrappedLines
    };
  };

  let structBox: EmbeddedLegendLayout['structBox'] = null;
  let divider: EmbeddedLegendLayout['divider'] = null;
  let symbolsBox: EmbeddedLegendLayout['symbolsBox'] = null;
  let bottomY = contentTopY;

  if (layoutMode === 'compact-grid') {
    symbolsBox = buildSymbolCells(boxX, contentTopY, boxW);
    bottomY = contentTopY + symbolsBox.h;
  } else if (layoutMode === 'stacked') {
    structBox = buildStructBlock(boxX, contentTopY, boxW);
    const midDivY = contentTopY + structBox.h + 7;
    if (localizedItems.length > 0) {
      divider = { orientation: 'horizontal', x1: boxX, y1: midDivY, x2: boxX + boxW, y2: midDivY };
      const symTop = midDivY + 8;
      symbolsBox = buildSymbolCells(boxX, symTop, boxW, boxW >= 220 ? 2 : 1);
      bottomY = symTop + symbolsBox.h;
    } else {
      bottomY = contentTopY + structBox.h;
    }
  } else {
    const maxStructLineW = rawStructLines.reduce(
      (m, s) => Math.max(m, Math.ceil(measurePx(s, structFont))),
      120
    );
    const idealLeftW = diagW + diagGap + maxStructLineW + 14;
    const minLeftW = Math.min(225, Math.floor(boxW * 0.44));
    const maxLeftW = Math.min(320, Math.floor(boxW * 0.46));
    const leftW =
      localizedItems.length > 0
        ? Math.max(minLeftW, Math.min(maxLeftW, idealLeftW))
        : Math.min(boxW, Math.max(240, idealLeftW));

    structBox = buildStructBlock(boxX, contentTopY, leftW);
    if (localizedItems.length > 0) {
      const divX = boxX + leftW + 6;
      const rightX = divX + 10;
      const rightW = Math.max(120, boxX + boxW - rightX);
      symbolsBox = buildSymbolCells(rightX, contentTopY, rightW);
      const zoneH = Math.max(structBox.h, symbolsBox.h);
      divider = { orientation: 'vertical', x1: divX, y1: contentTopY, x2: divX, y2: contentTopY + zoneH };
      bottomY = contentTopY + zoneH;
    } else {
      bottomY = contentTopY + structBox.h;
    }
  }

  return {
    legendMode: opts.legendMode,
    layoutMode,
    lang: opts.lang,
    scaleMode: opts.scaleMode,
    topY: opts.topY,
    ruleY,
    boxX,
    boxW,
    height: Math.ceil(bottomY - opts.topY + 4),
    structFontSize,
    itemFontSize,
    structBox,
    divider,
    symbolsBox,
    needsSpecGrad: localizedItems.some((it) => it.key === 'spectrogram' && it.swatchVariant !== 'contour'),
    items: localizedItems
  };
}

export function renderBand0AxisLabels(
  parent: Element,
  band: BandLayout,
  opts: {
    lang: 'zh' | 'en';
    hasAudio: boolean;
    showSpec: boolean;
    hideTicks: boolean;
    padX: number;
    isTinyView: boolean;
    pal: ScorePalette;
    fScale: number;
    isExp: boolean;
    sem: boolean;
    bNum: number;
    sansFontFamily?: string;
  }
): void {
  const gutterW = Math.max(0, band.originX - opts.padX);
  const gutterAvail = Math.max(0, gutterW - 6);
  if (gutterAvail < 18) return;

  const sansFont = opts.sansFontFamily || SANS_FONT_STACK;
  const fontSize = (opts.isTinyView ? 8.5 : 9) * opts.fScale;
  const font = `${fontSize.toFixed(1)}px ${SANS_FONT_STACK}`;
  const isEn = opts.lang === 'en';
  const pickFit = (full: string, compact: string, minFullW: number) => {
    if (gutterW >= minFullW && measurePx(full, font) <= gutterAvail) return full;
    if (measurePx(compact, font) <= gutterAvail) return compact;
    return null;
  };

  const timeSpine = opts.hideTicks
    ? null
    : pickFit(isEn ? 'Time (s)' : '时间 (s)', 't (s)', isEn ? 62 : 58);

  let physicalTrack: string | null = null;
  if (!opts.hasAudio) {
    physicalTrack = pickFit(isEn ? 'True time (1:1)' : '原始时间 (1:1)', '1:1', isEn ? 68 : 66);
  } else if (!opts.showSpec) {
    physicalTrack = pickFit(isEn ? 'Waveform (1:1)' : '波形 (1:1)', isEn ? 'Wave' : '波形', isEn ? 72 : 52);
  } else {
    physicalTrack = pickFit(isEn ? 'Waveform' : '波形', isEn ? 'Wave' : '波', isEn ? 50 : 24);
  }

  if (!timeSpine && !physicalTrack) return;

  const g = svgEl('g', opts.isExp && opts.sem ? { id: `band-${opts.bNum}-gutter-labels` } : {}, parent);
  const labelX = band.originX - 6;

  if (physicalTrack) {
    const trackY = opts.showSpec
      ? band.waveY + band.waveH / 2 + fontSize * 0.34
      : band.linearY + band.linearH / 2 + fontSize * 0.34;
    svgEl(
      'text',
      {
        x: labelX,
        y: trackY,
        'text-anchor': 'end',
        'font-family': sansFont,
        'font-size': String(Number(fontSize.toFixed(2))),
        fill: opts.pal.muted
      },
      g
    ).textContent = physicalTrack;
  }

  if (timeSpine) {
    svgEl(
      'text',
      {
        x: labelX,
        y: (band.tickSpineBotY ?? band.tiersTopY) - 4,
        'text-anchor': 'end',
        'font-family': sansFont,
        'font-size': String(Number(fontSize.toFixed(2))),
        fill: opts.pal.muted
      },
      g
    ).textContent = timeSpine;
  }
}

export function renderStructureDiagramSVG(
  parent: Element,
  x: number,
  y: number,
  scaleMode: GlobalScaleMode,
  pal: ScorePalette,
  sScale = 1
): SVGElement {
  const sw = (v: number) => Number((v * sScale).toFixed(2));
  const isLin = scaleMode === 'linear';
  const isMixed = scaleMode === 'mixed';
  const g = svgEl('g', {}, parent);

  svgEl('rect', { x: x + 2, y: y + 2, width: 52, height: isMixed ? 8 : 9.5, fill: pal.waveBg, stroke: pal.rule, 'stroke-width': sw(0.85) }, g);
  const bars: Array<[number, number, number]> = [
    [5, 3, 5], [12, 2, 7], [17, 1.5, 8], [21, 2.5, 6],
    [28, 3.5, 4], [36, 2, 7], [43, 3, 5], [48, 3.5, 4]
  ];
  for (const [bx, by, bh] of bars) {
    svgEl('rect', { x: x + bx, y: y + 2 + by * (isMixed ? 0.55 : 0.65), width: 2.2, height: bh * (isMixed ? 0.6 : 0.72), fill: pal.waveFill, opacity: pal.isBw ? 0.8 : 0.45 }, g);
  }

  if (isMixed) {
    // 3-stage mixed structure schematic:
    // Stage 1: 1:1 acoustic + directly vertically aligned linear tier
    const linTopY = y + 10;
    const linTierY = y + 12.5;
    const linTierH = 7.5;
    const lx1 = x + 16;
    const lx2 = x + 26;
    svgEl('line', { x1: x + 2, y1: linTopY, x2: x + 2, y2: linTierY, stroke: pal.ink, 'stroke-width': sw(0.8) }, g);
    svgEl('line', { x1: lx1, y1: linTopY, x2: lx1, y2: linTierY, stroke: pal.faint, 'stroke-width': sw(0.8) }, g);
    svgEl('line', { x1: lx2, y1: linTopY, x2: lx2, y2: linTierY, stroke: pal.faint, 'stroke-width': sw(0.8) }, g);
    svgEl('line', { x1: x + 54, y1: linTopY, x2: x + 54, y2: linTierY, stroke: pal.ink, 'stroke-width': sw(0.8) }, g);

    svgEl('rect', { x: x + 2, y: linTierY, width: lx1 - (x + 2), height: linTierH, fill: pal.emptyCell, stroke: pal.border, 'stroke-width': sw(0.75) }, g);
    svgEl('rect', { x: lx1, y: linTierY, width: lx2 - lx1, height: linTierH, fill: pal.cellFill, stroke: pal.border, 'stroke-width': sw(0.8) }, g);
    svgEl('rect', { x: lx1, y: linTierY, width: lx2 - lx1, height: 1.5, fill: pal.tierAccents[1] || pal.tierAccents[0], opacity: 0.85 }, g);
    svgEl('rect', { x: lx2, y: linTierY, width: x + 54 - lx2, height: linTierH, fill: pal.cellFill, stroke: pal.border, 'stroke-width': sw(0.75) }, g);

    // Stage 2: Transition neck (linear -> elastic) + single tick spine
    const nTopY = linTierY + linTierH;
    const nBotY = y + 30.5;
    const spineY = y + 32.5;
    const ex1 = x + 11;
    const ex2 = x + 38;
    svgEl('polygon', {
      points: `${lx1},${nTopY} ${lx2},${nTopY} ${ex2},${nBotY} ${ex1},${nBotY}`,
      fill: pal.isBw ? '#E5E5E5' : pal.amber,
      opacity: pal.isBw ? 0.9 : 0.16
    }, g);
    const pairs: Array<[number, number]> = [[x + 2, x + 2], [lx1, ex1], [lx2, ex2], [x + 54, x + 54]];
    pairs.forEach(([tx, bx], i) => {
      svgEl('line', { x1: tx, y1: nTopY, x2: bx, y2: nBotY, stroke: i === 0 || i === 3 ? pal.ink : pal.faint, 'stroke-width': sw(0.8) }, g);
      svgEl('line', { x1: bx, y1: nBotY, x2: bx, y2: spineY, stroke: pal.ink, 'stroke-width': sw(0.9) }, g);
    });

    // Stage 3: Expanded elastic tier below
    const elTierY = y + 33.5;
    const elTierH = 9.5;
    svgEl('rect', { x: x + 2, y: elTierY, width: ex1 - (x + 2), height: elTierH, fill: pal.emptyCell, stroke: pal.border, 'stroke-width': sw(0.8) }, g);
    svgEl('rect', { x: ex1, y: elTierY, width: ex2 - ex1, height: elTierH, fill: pal.cellFill, stroke: pal.border, 'stroke-width': sw(0.85) }, g);
    svgEl('rect', { x: ex1, y: elTierY, width: ex2 - ex1, height: 1.8, fill: pal.tierAccents[0], opacity: 0.85 }, g);
    svgEl('line', { x1: ex1 + 4, y1: elTierY + 5.6, x2: ex2 - 4, y2: elTierY + 5.6, stroke: pal.ink, 'stroke-width': sw(0.9) }, g);
    svgEl('rect', { x: ex2, y: elTierY, width: x + 54 - ex2, height: elTierH, fill: pal.cellFill, stroke: pal.border, 'stroke-width': sw(0.8) }, g);
    return g;
  }

  const topY = y + 11.5;
  const botY = y + 23.5;
  const spineY = y + 25.5;
  if (isLin) {
    const xs = [2, 18, 36, 54];
    xs.forEach((off, i) => {
      const lx = x + off;
      svgEl('line', { x1: lx, y1: topY, x2: lx, y2: spineY, stroke: i === 0 || i === xs.length - 1 ? pal.ink : pal.faint, 'stroke-width': sw(0.85) }, g);
      svgEl('line', { x1: lx, y1: spineY - 2.5, x2: lx, y2: spineY, stroke: pal.ink, 'stroke-width': sw(0.95) }, g);
    });
  } else {
    svgEl('polygon', {
      points: `${x + 15},${topY} ${x + 24},${topY} ${x + 37},${botY} ${x + 11},${botY}`,
      fill: pal.isBw ? '#E5E5E5' : pal.amber,
      opacity: pal.isBw ? 0.9 : 0.16
    }, g);
    const pairs: Array<[number, number]> = [[2, 2], [15, 11], [24, 37], [54, 54]];
    pairs.forEach(([tx, bx], i) => {
      svgEl('line', { x1: x + tx, y1: topY, x2: x + bx, y2: botY, stroke: i === 0 || i === 3 ? pal.ink : pal.faint, 'stroke-width': sw(0.85) }, g);
      svgEl('line', { x1: x + bx, y1: botY, x2: x + bx, y2: spineY, stroke: pal.ink, 'stroke-width': sw(0.95) }, g);
    });
  }

  const g1x = isLin ? x + 18 : x + 11;
  const g2x = isLin ? x + 36 : x + 37;
  svgEl('line', { x1: g1x, y1: spineY, x2: g1x, y2: y + 43.5, stroke: pal.gridMajor, 'stroke-width': sw(0.8) }, g);
  svgEl('line', { x1: g2x, y1: spineY, x2: g2x, y2: y + 43.5, stroke: pal.gridMinor, 'stroke-width': sw(0.75), 'stroke-dasharray': '1.5 1.5' }, g);

  const r1Y = y + 26.5;
  const r1H = 9;
  svgEl('rect', { x: x + 2, y: r1Y, width: g1x - (x + 2), height: r1H, fill: pal.emptyCell, stroke: pal.border, 'stroke-width': sw(0.8) }, g);
  svgEl('rect', { x: g1x, y: r1Y, width: g2x - g1x, height: r1H, fill: pal.cellFill, stroke: pal.border, 'stroke-width': sw(0.85) }, g);
  svgEl('rect', { x: g1x, y: r1Y, width: g2x - g1x, height: 1.8, fill: pal.tierAccents[0], opacity: 0.85 }, g);
  svgEl('line', { x1: g1x + 4, y1: r1Y + 5.5, x2: g2x - 4, y2: r1Y + 5.5, stroke: pal.ink, 'stroke-width': sw(0.9) }, g);
  svgEl('rect', { x: g2x, y: r1Y, width: x + 54 - g2x, height: r1H, fill: pal.cellFill, stroke: pal.border, 'stroke-width': sw(0.8) }, g);
  svgEl('rect', { x: g2x, y: r1Y, width: x + 54 - g2x, height: 1.8, fill: pal.tierAccents[0], opacity: 0.85 }, g);

  const wireY = y + 40.5;
  svgEl('line', { x1: x + 2, y1: wireY, x2: x + 54, y2: wireY, stroke: pal.wire, 'stroke-width': sw(0.85) }, g);
  svgEl('polygon', { points: `${g1x},${wireY - 2.8} ${g1x + 2.8},${wireY} ${g1x},${wireY + 2.8} ${g1x - 2.8},${wireY}`, fill: pal.ink }, g);

  return g;
}

export function renderSwatchSVG(
  parent: Element,
  item: LegendCatalogItem,
  x: number,
  y: number,
  pal: ScorePalette,
  opts: {
    sScale?: number;
    inlinePatterns?: boolean;
    idPrefix?: string;
    ipaFontFamily?: string;
    monoFontFamily?: string;
    symbolFontFamily?: string;
  } = {}
): SVGElement {
  const sScale = opts.sScale || 1;
  const inlinePatterns = Boolean(opts.inlinePatterns);
  const pfx = opts.idPrefix || '';
  const sw = (v: number) => Number((v * sScale).toFixed(2));
  const g = svgEl('g', {}, parent);
  const key = item.key;

  if (key === 'labeled-interval') {
    svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 10, fill: pal.cellFill, stroke: pal.border, 'stroke-width': sw(0.9) }, g);
    svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 2.2, fill: pal.tierAccents[0], opacity: pal.isBw ? 0.88 : 0.78 }, g);
    svgEl('line', { x1: x + 6.5, y1: y + 7, x2: x + 15.5, y2: y + 7, stroke: pal.ink, 'stroke-width': sw(1) }, g);
  } else if (key === 'empty-interval') {
    svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 10, fill: pal.emptyCell, stroke: pal.border, 'stroke-width': sw(0.9) }, g);
  } else if (key === 'labeled-point') {
    svgEl('line', { x1: x + 1, y1: y + 4, x2: x + 21, y2: y + 4, stroke: pal.wire, 'stroke-width': sw(0.95) }, g);
    svgEl('line', { x1: x + 11, y1: y + 6.2, x2: x + 11, y2: y + 8, stroke: pal.ink, 'stroke-width': sw(0.9) }, g);
    svgEl('polygon', { points: `${x + 11},${y + 1.5} ${x + 13.5},${y + 4} ${x + 11},${y + 6.5} ${x + 8.5},${y + 4}`, fill: pal.ink }, g);
    svgEl('rect', { x: x + 6, y: y + 8, width: 10, height: 3.4, fill: pal.paper, stroke: pal.ink, 'stroke-width': sw(0.8) }, g);
  } else if (key === 'empty-point') {
    svgEl('line', { x1: x + 1, y1: y + 6, x2: x + 21, y2: y + 6, stroke: pal.wire, 'stroke-width': sw(0.95) }, g);
    svgEl('polygon', { points: `${x + 11},${y + 2.8} ${x + 14.2},${y + 6} ${x + 11},${y + 9.2} ${x + 7.8},${y + 6}`, fill: pal.paper, stroke: pal.ink, 'stroke-width': sw(1.1) }, g);
  } else if (key === 'boundaries') {
    svgEl('line', { x1: x + 7, y1: y + 1, x2: x + 7, y2: y + 11, stroke: pal.ink, 'stroke-width': sw(1.05) }, g);
    svgEl('line', { x1: x + 15, y1: y + 1, x2: x + 15, y2: y + 11, stroke: pal.faint, 'stroke-width': sw(0.9), 'stroke-dasharray': '2 1.5' }, g);
  } else if (key === 'stretch') {
    svgEl('polygon', { points: `${x + 7.5},${y + 1} ${x + 14.5},${y + 1} ${x + 19.5},${y + 7.5} ${x + 2.5},${y + 7.5}`, fill: pal.isBw ? '#E5E5E5' : pal.amber, opacity: pal.isBw ? 0.9 : 0.2 }, g);
    svgEl('line', { x1: x + 7.5, y1: y + 1, x2: x + 2.5, y2: y + 7.5, stroke: pal.faint, 'stroke-width': sw(0.75) }, g);
    svgEl('line', { x1: x + 14.5, y1: y + 1, x2: x + 19.5, y2: y + 7.5, stroke: pal.faint, 'stroke-width': sw(0.75) }, g);
    svgEl('line', { x1: x + 2.5, y1: y + 10.5, x2: x + 19.5, y2: y + 10.5, stroke: pal.amber, 'stroke-width': sw(0.9), 'stroke-dasharray': '2 1.5' }, g);
    svgEl('path', { d: `M${x + 2.5},${y + 8.5} L${x + 2.5},${y + 10.5} M${x + 19.5},${y + 8.5} L${x + 19.5},${y + 10.5}`, fill: 'none', stroke: pal.amber, 'stroke-width': sw(0.9) }, g);
  } else if (key === 'collapsed-pause') {
    svgEl('line', { x1: x + 1.5, y1: y + 2, x2: x + 20.5, y2: y + 2, stroke: pal.rule, 'stroke-width': sw(0.9), 'stroke-dasharray': '2 1.5' }, g);
    svgEl('line', { x1: x + 1.5, y1: y + 10, x2: x + 20.5, y2: y + 10, stroke: pal.rule, 'stroke-width': sw(0.9), 'stroke-dasharray': '2 1.5' }, g);
    svgEl('line', { x1: x + 8, y1: y + 9.5, x2: x + 10.5, y2: y + 2.5, stroke: pal.mutedAlt, 'stroke-width': sw(1.1) }, g);
    svgEl('line', { x1: x + 11.5, y1: y + 9.5, x2: x + 14, y2: y + 2.5, stroke: pal.mutedAlt, 'stroke-width': sw(1.1) }, g);
  } else if (key === 'continuation') {
    svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 10, fill: pal.cellFill, stroke: pal.rule, 'stroke-width': sw(0.8) }, g);
    svgEl('polygon', { points: `${x + 1},${y + 3.2} ${x + 5},${y + 6} ${x + 1},${y + 8.8}`, fill: pal.mutedAlt }, g);
    svgEl('polygon', { points: `${x + 21},${y + 3.2} ${x + 17},${y + 6} ${x + 21},${y + 8.8}`, fill: pal.mutedAlt }, g);
    svgEl('line', { x1: x + 7.5, y1: y + 6, x2: x + 14.5, y2: y + 6, stroke: pal.faint, 'stroke-width': sw(0.9), 'stroke-dasharray': '1.6 1.6' }, g);
  } else if (key === 'spectrogram') {
    if (item.swatchVariant === 'contour') {
      svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 10, fill: pal.paper, stroke: pal.ink, 'stroke-width': sw(0.85) }, g);
      svgEl('rect', { x: x + 2.5, y: y + 2.5, width: 17, height: 7, fill: pal.isBw ? '#DCDCDC' : '#E0DDD5' }, g);
      svgEl('rect', { x: x + 5.5, y: y + 3.8, width: 11, height: 4.5, fill: pal.isBw ? '#8A8A8A' : '#8C8981' }, g);
      svgEl('rect', { x: x + 8.5, y: y + 4.8, width: 5, height: 2.4, fill: pal.isBw ? '#141414' : '#262522' }, g);
    } else if (inlinePatterns) {
      const steps = pal.isBw
        ? ['#F4F4F4', '#C8C8C8', '#8A8A8A', '#474747', '#111111']
        : ['#F4F2EC', '#C8C4BA', '#8A877F', '#4A4842', '#1A1917'];
      steps.forEach((fill, i) => svgEl('rect', { x: x + 1 + i * 4, y: y + 1, width: 4, height: 10, fill }, g));
      svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 10, fill: 'none', stroke: pal.ink, 'stroke-width': sw(0.85) }, g);
    } else {
      svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 10, fill: `url(#${pfx}legend-spec-grad)`, stroke: pal.ink, 'stroke-width': sw(0.85) }, g);
    }
  } else if (key === 'pitch-f0') {
    svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 10, fill: pal.waveBg, stroke: pal.rule, 'stroke-width': sw(0.75) }, g);
    const pd = `M${x + 2.5},${y + 8.5} L${x + 7.5},${y + 4.2} L${x + 13.5},${y + 6.2} L${x + 19.5},${y + 3.2}`;
    svgEl('path', { d: pd, fill: 'none', stroke: pal.pitchHalo, 'stroke-width': sw(2.5), 'stroke-linejoin': 'miter' }, g);
    svgEl('path', { d: pd, fill: 'none', stroke: pal.pitch, 'stroke-width': sw(1.35), 'stroke-linejoin': 'miter' }, g);
  } else if (key === 'formants') {
    svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 10, fill: pal.waveBg, stroke: pal.rule, 'stroke-width': sw(0.75) }, g);
    const pts = [[4, 8.2], [8.5, 7.8], [13, 8.1], [17.5, 8.4], [4, 5.2], [8.5, 4.7], [13, 5.1], [17.5, 5.6], [4, 2.5], [8.5, 2.7], [13, 2.3], [17.5, 2.6]];
    for (const [dx, dy] of pts) {
      if (pal.isBw) {
        svgEl('circle', { cx: x + dx, cy: y + dy, r: 1.35, fill: pal.paper, stroke: pal.formant, 'stroke-width': sw(0.8) }, g);
      } else {
        svgEl('circle', { cx: x + dx, cy: y + dy, r: 1.25, fill: pal.formant, stroke: pal.paper, 'stroke-width': sw(0.55), 'paint-order': 'stroke' }, g);
      }
    }
  } else if (key === 'trigraph') {
    svgEl('text', { x: x + 4.5, y: y + 8.8, 'text-anchor': 'middle', 'font-family': opts.ipaFontFamily || IPA_FONT_STACK, 'font-size': '9.5', fill: pal.ink }, g).textContent = 'ʂ';
    svgEl('text', { x: x + 15.2, y: y + 8.8, 'text-anchor': 'middle', 'font-family': opts.monoFontFamily || MONO_FONT_STACK, 'font-size': '7', fill: pal.gloss }, g).textContent = '\\s.';
  } else if (key === 'meta-symbols') {
    svgEl('text', { x: x + 11, y: y + 9, 'text-anchor': 'middle', 'font-family': opts.symbolFontFamily || SYMBOL_FONT_STACK, 'font-size': '8.2', fill: pal.meta }, g).textContent = '␣↵↪';
  } else if (key === 'zero-dur') {
    svgEl('polygon', { points: `${x + 11},${y + 1} ${x + 14.8},${y + 6} ${x + 11},${y + 11} ${x + 7.2},${y + 6}`, fill: pal.zeroBg, stroke: pal.isBw ? '#333333' : pal.amber, 'stroke-width': sw(1.15) }, g);
  } else if (key === 'gap') {
    if (inlinePatterns) {
      svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 10, fill: pal.gapBg, stroke: pal.gapStroke, 'stroke-width': sw(0.75) }, g);
      for (let ox = 2; ox <= 18; ox += 5) {
        svgEl('line', { x1: x + ox, y1: y + 1, x2: x + Math.min(21, ox + 5), y2: y + 11, stroke: pal.gapStroke, 'stroke-width': sw(0.9), opacity: 0.55 }, g);
      }
    } else {
      svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 10, fill: `url(#${pfx}pat-gap)`, stroke: pal.gapStroke, 'stroke-width': sw(0.75) }, g);
    }
  } else if (key === 'overlap') {
    if (inlinePatterns) {
      svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 10, fill: pal.paper, stroke: pal.ovlStroke, 'stroke-width': sw(0.75) }, g);
      for (let ox = 4; ox <= 20; ox += 5) {
        svgEl('line', { x1: x + ox, y1: y + 1, x2: x + Math.max(1, ox - 5), y2: y + 11, stroke: pal.ovlStroke, 'stroke-width': sw(1), opacity: pal.isBw ? 0.52 : 0.42 }, g);
      }
    } else {
      svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 10, fill: `url(#${pfx}pat-ovl)`, stroke: pal.ovlStroke, 'stroke-width': sw(0.75) }, g);
    }
  } else if (key === 'ood') {
    if (inlinePatterns) {
      svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 10, fill: pal.oodBg, stroke: pal.oodStroke, 'stroke-width': sw(0.7) }, g);
      for (let ox = 4; ox <= 20; ox += 5) {
        svgEl('line', { x1: x + ox, y1: y + 1, x2: x + Math.max(1, ox - 5), y2: y + 11, stroke: pal.oodStroke, 'stroke-width': sw(0.8) }, g);
        if (pal.isBw) {
          svgEl('line', { x1: x + Math.max(1, ox - 5), y1: y + 1, x2: x + ox, y2: y + 11, stroke: pal.oodStroke, 'stroke-width': sw(0.75) }, g);
        }
      }
    } else {
      svgEl('rect', { x: x + 1, y: y + 1, width: 20, height: 10, fill: `url(#${pfx}pat-ood)`, stroke: pal.oodStroke, 'stroke-width': sw(0.7) }, g);
    }
    svgEl('path', { d: `M${x + 4.5},${y + 1} L${x + 1.5},${y + 1} L${x + 1.5},${y + 11} L${x + 4.5},${y + 11}`, fill: 'none', stroke: pal.isBw ? pal.ink : pal.amber, 'stroke-width': sw(1.3) }, g);
  } else if (key === 'micro-seg') {
    svgEl('line', { x1: x + 2, y1: y + 9.5, x2: x + 20, y2: y + 9.5, stroke: pal.rule, 'stroke-width': sw(0.9) }, g);
    svgEl('line', { x1: x + 8.5, y1: y + 5, x2: x + 8.5, y2: y + 9.5, stroke: pal.ink, 'stroke-width': sw(0.95) }, g);
    svgEl('line', { x1: x + 13.5, y1: y + 5, x2: x + 13.5, y2: y + 9.5, stroke: pal.ink, 'stroke-width': sw(0.95) }, g);
    svgEl('rect', { x: x + 8.5, y: y + 5.5, width: 5, height: 3, fill: pal.microWarn }, g);
  }
  return g;
}

const LEG_SUBSCRIPT_MAP: Record<string, string> = {
  '₀': '0',
  '₁': '1',
  '₂': '2',
  '₃': '3'
};

function appendSubscriptRichLabel(textEl: Element, label: string, baseFontSize: number): void {
  const parts = label.split(/([₀₁₂₃])/g);
  if (parts.length <= 1) {
    textEl.textContent = label;
    return;
  }
  const subFontSize = String(Number((baseFontSize * 0.74).toFixed(2)));
  let shifted = false;
  for (const part of parts) {
    if (!part) continue;
    const mapped = LEG_SUBSCRIPT_MAP[part];
    if (mapped) {
      svgEl(
        'tspan',
        {
          ...(shifted ? {} : { dy: '1.8' }),
          'font-size': subFontSize
        },
        textEl
      ).textContent = mapped;
      shifted = true;
    } else if (shifted) {
      svgEl('tspan', { dy: '-1.8' }, textEl).textContent = part;
      shifted = false;
    } else {
      svgEl('tspan', {}, textEl).textContent = part;
    }
  }
}

export function renderEmbeddedLegendSVG(
  svg: Element,
  legendLayout: EmbeddedLegendLayout,
  opts: {
    pal: ScorePalette;
    sScale?: number;
    idPrefix?: string;
    sansFontFamily?: string;
    ipaFontFamily?: string;
    monoFontFamily?: string;
    symbolFontFamily?: string;
  }
): SVGElement {
  const sScale = opts.sScale || 1;
  const sansFont = opts.sansFontFamily || SANS_FONT_STACK;
  const sw = (v: number) => Number((v * sScale).toFixed(2));
  const rootG = svgEl('g', { id: 'export-legend' }, svg);

  svgEl('line', {
    x1: legendLayout.boxX,
    y1: legendLayout.ruleY,
    x2: legendLayout.boxX + legendLayout.boxW,
    y2: legendLayout.ruleY,
    stroke: opts.pal.rule,
    'stroke-width': sw(0.75)
  }, rootG);

  if (legendLayout.structBox) {
    const sb = legendLayout.structBox;
    const structG = svgEl('g', { id: 'export-legend-structure' }, rootG);
    renderStructureDiagramSVG(structG, sb.diagX, sb.diagY, legendLayout.scaleMode, opts.pal, sScale);
    sb.lines.forEach((lineObj, idx) => {
      svgEl('text', {
        x: sb.textX + (lineObj.cont ? 8 : 0),
        y: sb.textStartY + idx * sb.lineH,
        'text-anchor': 'start',
        'font-family': sansFont,
        'font-size': String(legendLayout.structFontSize),
        fill: opts.pal.muted
      }, structG).textContent = lineObj.text;
    });
  }

  if (legendLayout.divider) {
    const dv = legendLayout.divider;
    svgEl('line', {
      x1: dv.x1,
      y1: dv.y1,
      x2: dv.x2,
      y2: dv.y2,
      stroke: opts.pal.rule,
      'stroke-width': sw(0.75)
    }, rootG);
  }

  if (legendLayout.symbolsBox && legendLayout.symbolsBox.cells.length > 0) {
    const symG = svgEl('g', { id: 'export-legend-symbols' }, rootG);
    for (const cell of legendLayout.symbolsBox.cells) {
      renderSwatchSVG(symG, cell.item, cell.swatchX, cell.swatchY, opts.pal, {
        sScale,
        inlinePatterns: false,
        idPrefix: opts.idPrefix,
        ipaFontFamily: opts.ipaFontFamily,
        monoFontFamily: opts.monoFontFamily,
        symbolFontFamily: opts.symbolFontFamily
      });
      const lblEl = svgEl('text', {
        x: cell.labelX,
        y: cell.labelY,
        'text-anchor': 'start',
        'font-family': sansFont,
        'font-size': String(legendLayout.itemFontSize),
        fill: opts.pal.ink
      }, symG);
      appendSubscriptRichLabel(lblEl, cell.displayLabel, legendLayout.itemFontSize);
    }
  }

  return rootG;
}
