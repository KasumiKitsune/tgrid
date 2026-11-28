import {
  STYLE_SCHEMA_VERSION,
  type PaletteId,
  type PaletteSpec,
  type PatternKind,
  type StyleDocument,
  type StyleRule,
  type SwatchSpec,
  type TierStylePatch
} from './types.ts';

export const DEFAULT_PALETTE_ID: PaletteId = 'warm-academic';

export const BW_GRAY_LEVELS = [
  '#F4F4F4',
  '#E8E8E8',
  '#DADADA',
  '#CACACA',
  '#B8B8B8'
] as const;

export const BW_PATTERNS: readonly Exclude<PatternKind, 'none'>[] = [
  'hatch-diag',
  'hatch-back',
  'dots',
  'crosshatch',
  'stripes-v',
  'stripes-h'
] as const;

export const PALETTES: readonly PaletteSpec[] = [
  {
    id: 'warm-academic',
    name: '暖纸学术',
    description: '贴合暖纸与墨线视觉体系，适合语音学论文与日常标注',
    swatches: [
      {
        id: 's1',
        name: '暖杏',
        fill: '#F7E1C4',
        stroke: '#A9611B',
        text: '#3B2006',
        bwGray: '#EFEFEF',
        bwPattern: 'hatch-diag',
        bwStroke: '#1A1A1A'
      },
      {
        id: 's2',
        name: '浅蓝',
        fill: '#D6E7F5',
        stroke: '#2A5E91',
        text: '#0F2A44',
        bwGray: '#E6E6E6',
        bwPattern: 'hatch-back',
        bwStroke: '#1A1A1A'
      },
      {
        id: 's3',
        name: '竹青',
        fill: '#D4EDE2',
        stroke: '#236E55',
        text: '#0F3327',
        bwGray: '#F2F2F2',
        bwPattern: 'dots',
        bwStroke: '#222222'
      },
      {
        id: 's4',
        name: '赭红',
        fill: '#F3D6D0',
        stroke: '#A23A2C',
        text: '#46150E',
        bwGray: '#DCDCDC',
        bwPattern: 'crosshatch',
        bwStroke: '#141414'
      },
      {
        id: 's5',
        name: '淡紫',
        fill: '#E5DBF3',
        stroke: '#66489D',
        text: '#291947',
        bwGray: '#E8E8E8',
        bwPattern: 'stripes-v',
        bwStroke: '#1F1F1F'
      },
      {
        id: 's6',
        name: '鹅黄',
        fill: '#F6EDC0',
        stroke: '#967414',
        text: '#3C2D05',
        bwGray: '#F4F4F4',
        bwPattern: 'stripes-h',
        bwStroke: '#262626'
      },
      {
        id: 's7',
        name: '烟灰',
        fill: '#E7E4DC',
        stroke: '#69665E',
        text: '#2B2A26',
        bwGray: '#E2E2E2',
        bwPattern: 'none',
        bwStroke: '#333333'
      },
      {
        id: 's8',
        name: '墨青',
        fill: '#D3E1E5',
        stroke: '#2D5A68',
        text: '#132A32',
        bwGray: '#CECECE',
        bwPattern: 'hatch-diag',
        bwStroke: '#111111'
      }
    ]
  },
  {
    id: 'colorblind-safe',
    name: '色盲友好',
    description: '基于 Okabe-Ito 与 Paul Tol 学术色觉无障碍规范，红绿色弱亦可清晰分辨',
    swatches: [
      {
        id: 's1',
        name: '橘黄',
        fill: '#FBE5B6',
        stroke: '#C48100',
        text: '#3F2800',
        bwGray: '#F0F0F0',
        bwPattern: 'hatch-diag',
        bwStroke: '#1A1A1A'
      },
      {
        id: 's2',
        name: '天蓝',
        fill: '#D3ECF9',
        stroke: '#2B83B8',
        text: '#0C2D42',
        bwGray: '#E6E6E6',
        bwPattern: 'hatch-back',
        bwStroke: '#1A1A1A'
      },
      {
        id: 's3',
        name: '蓝绿',
        fill: '#C8EDE1',
        stroke: '#00805D',
        text: '#003224',
        bwGray: '#F2F2F2',
        bwPattern: 'dots',
        bwStroke: '#1F1F1F'
      },
      {
        id: 's4',
        name: '明黄',
        fill: '#FAF2B4',
        stroke: '#9B8E10',
        text: '#3A3404',
        bwGray: '#F5F5F5',
        bwPattern: 'stripes-h',
        bwStroke: '#242424'
      },
      {
        id: 's5',
        name: '靛蓝',
        fill: '#C9E1F3',
        stroke: '#005F96',
        text: '#00263D',
        bwGray: '#DADADA',
        bwPattern: 'stripes-v',
        bwStroke: '#141414'
      },
      {
        id: 's6',
        name: '朱红',
        fill: '#F7D5BE',
        stroke: '#B84E00',
        text: '#441B00',
        bwGray: '#D4D4D4',
        bwPattern: 'crosshatch',
        bwStroke: '#141414'
      },
      {
        id: 's7',
        name: '紫红',
        fill: '#F1D9E7',
        stroke: '#9D4D7B',
        text: '#3E192E',
        bwGray: '#E2E2E2',
        bwPattern: 'dots',
        bwStroke: '#1C1C1C'
      },
      {
        id: 's8',
        name: '中性灰',
        fill: '#E5E5E5',
        stroke: '#666666',
        text: '#222222',
        bwGray: '#DDDDDD',
        bwPattern: 'none',
        bwStroke: '#2E2E2E'
      }
    ]
  },
  {
    id: 'presentation',
    name: '演示汇报',
    description: '高区分度且不刺眼，适合课堂教学、学术报告与投影展示',
    swatches: [
      {
        id: 's1',
        name: '琥珀橙',
        fill: '#FDE0BC',
        stroke: '#D96B16',
        text: '#4B2103',
        bwGray: '#EFEFEF',
        bwPattern: 'hatch-diag',
        bwStroke: '#181818'
      },
      {
        id: 's2',
        name: '钴蓝',
        fill: '#CFE4FC',
        stroke: '#1E64C8',
        text: '#0C2652',
        bwGray: '#E4E4E4',
        bwPattern: 'hatch-back',
        bwStroke: '#181818'
      },
      {
        id: 's3',
        name: '松绿',
        fill: '#CBEFE0',
        stroke: '#16835B',
        text: '#083524',
        bwGray: '#F2F2F2',
        bwPattern: 'dots',
        bwStroke: '#1C1C1C'
      },
      {
        id: 's4',
        name: '珊瑚红',
        fill: '#FBD2D2',
        stroke: '#C7343A',
        text: '#4C1013',
        bwGray: '#D8D8D8',
        bwPattern: 'crosshatch',
        bwStroke: '#141414'
      },
      {
        id: 's5',
        name: '堇紫',
        fill: '#E2D6FA',
        stroke: '#6D42C7',
        text: '#281452',
        bwGray: '#E6E6E6',
        bwPattern: 'stripes-v',
        bwStroke: '#1A1A1A'
      },
      {
        id: 's6',
        name: '明杏黄',
        fill: '#FEF0B3',
        stroke: '#B58407',
        text: '#422F02',
        bwGray: '#F4F4F4',
        bwPattern: 'stripes-h',
        bwStroke: '#222222'
      },
      {
        id: 's7',
        name: '石板灰',
        fill: '#E2E6EC',
        stroke: '#556275',
        text: '#1E2530',
        bwGray: '#E0E0E0',
        bwPattern: 'none',
        bwStroke: '#2B2B2B'
      },
      {
        id: 's8',
        name: '海青',
        fill: '#C9EDF2',
        stroke: '#0F7B8C',
        text: '#07323A',
        bwGray: '#D0D0D0',
        bwPattern: 'hatch-diag',
        bwStroke: '#141414'
      }
    ]
  },
  {
    id: 'journal-bw',
    name: '期刊黑白印刷',
    description: '纯灰度与纯矢量底纹组合，直接适配黑白期刊与纸质印刷排版',
    swatches: [
      {
        id: 's1',
        name: '右斜细纹',
        fill: '#F2F2F2',
        stroke: '#1A1A1A',
        text: '#000000',
        bwGray: '#F2F2F2',
        bwPattern: 'hatch-diag',
        bwStroke: '#1A1A1A'
      },
      {
        id: 's2',
        name: '左斜细纹',
        fill: '#EAEAEA',
        stroke: '#1A1A1A',
        text: '#000000',
        bwGray: '#EAEAEA',
        bwPattern: 'hatch-back',
        bwStroke: '#1A1A1A'
      },
      {
        id: 's3',
        name: '均匀圆点',
        fill: '#F5F5F5',
        stroke: '#222222',
        text: '#000000',
        bwGray: '#F5F5F5',
        bwPattern: 'dots',
        bwStroke: '#222222'
      },
      {
        id: 's4',
        name: '交叉网纹',
        fill: '#DFDFDF',
        stroke: '#111111',
        text: '#000000',
        bwGray: '#DFDFDF',
        bwPattern: 'crosshatch',
        bwStroke: '#111111'
      },
      {
        id: 's5',
        name: '竖向条纹',
        fill: '#ECECEC',
        stroke: '#1F1F1F',
        text: '#000000',
        bwGray: '#ECECEC',
        bwPattern: 'stripes-v',
        bwStroke: '#1F1F1F'
      },
      {
        id: 's6',
        name: '横向条纹',
        fill: '#F0F0F0',
        stroke: '#242424',
        text: '#000000',
        bwGray: '#F0F0F0',
        bwPattern: 'stripes-h',
        bwStroke: '#242424'
      },
      {
        id: 's7',
        name: '浅灰纯底',
        fill: '#E5E5E5',
        stroke: '#333333',
        text: '#000000',
        bwGray: '#E5E5E5',
        bwPattern: 'none',
        bwStroke: '#333333'
      },
      {
        id: 's8',
        name: '中灰纯底',
        fill: '#CECECE',
        stroke: '#1A1A1A',
        text: '#000000',
        bwGray: '#CECECE',
        bwPattern: 'none',
        bwStroke: '#1A1A1A'
      }
    ]
  }
] as const;

export const PALETTE_MAP: Record<PaletteId, PaletteSpec> = {
  'warm-academic': PALETTES[0],
  'colorblind-safe': PALETTES[1],
  presentation: PALETTES[2],
  'journal-bw': PALETTES[3]
};

export interface BuiltinStyleRulePreset {
  id: string;
  label: string;
  description: string;
  rule: Omit<StyleRule, 'id'>;
}

export const BUILTIN_STYLE_RULE_PRESETS: readonly BuiltinStyleRulePreset[] = [
  {
    id: 'preset-silence',
    label: '静音/空白区间标淡灰',
    description: '将未填文字的静音或空白区间标记为烟灰色',
    rule: {
      name: '静音/空白',
      enabled: true,
      matchKind: 'empty',
      pattern: '',
      intervalStyle: { swatchId: 's7' }
    }
  },
  {
    id: 'preset-vowels',
    label: '元音标暖杏色',
    description: '匹配常见元音及国际音标元音字符',
    rule: {
      name: '元音',
      enabled: true,
      matchKind: 'regex',
      pattern: '[aeiouɑɒæɐəɜɛɪɔʊʌʏøœɨʉɯɤ]',
      caseSensitive: false,
      intervalStyle: { swatchId: 's1' }
    }
  },
  {
    id: 'preset-voiceless-stops',
    label: '清塞音标浅蓝色',
    description: '匹配常见清塞音及送气变体',
    rule: {
      name: '清塞音',
      enabled: true,
      matchKind: 'regex',
      pattern: '^[ptkcqʔ][ʰh]?$',
      caseSensitive: true,
      intervalStyle: { swatchId: 's2' }
    }
  },
  {
    id: 'preset-nasals',
    label: '鼻音标竹青色',
    description: '匹配常见鼻音及国际音标鼻音符号',
    rule: {
      name: '鼻音',
      enabled: true,
      matchKind: 'regex',
      pattern: '[mnŋɲɳɴ]',
      caseSensitive: false,
      intervalStyle: { swatchId: 's3' }
    }
  }
] as const;

export function isPaletteId(value: unknown): value is PaletteId {
  return (
    value === 'warm-academic' ||
    value === 'colorblind-safe' ||
    value === 'presentation' ||
    value === 'journal-bw'
  );
}

export function getPalette(id?: PaletteId | string | null): PaletteSpec {
  if (id && isPaletteId(id)) {
    return PALETTE_MAP[id];
  }
  return PALETTE_MAP[DEFAULT_PALETTE_ID];
}

export function getSwatch(
  paletteId: PaletteId | string | null | undefined,
  swatchId: string | null | undefined
): SwatchSpec | null {
  if (!swatchId) return null;
  const palette = getPalette(paletteId);
  return palette.swatches.find((s) => s.id === swatchId) ?? null;
}

export function createDefaultStyleDocument(paletteId: PaletteId = DEFAULT_PALETTE_ID): StyleDocument {
  return {
    schemaVersion: STYLE_SCHEMA_VERSION,
    paletteId: isPaletteId(paletteId) ? paletteId : DEFAULT_PALETTE_ID,
    bwPrintMode: false,
    showLegendInExport: true,
    swatchLabels: {},
    tierStyles: {},
    rules: [],
    intervalOverrides: [],
    boundaryOverrides: [],
    pointOverrides: []
  };
}

function cloneTierStylePatch(patch: TierStylePatch): TierStylePatch {
  const out: TierStylePatch = {};
  if (patch.labelBg !== undefined) out.labelBg = patch.labelBg;
  if (patch.labelColor !== undefined) out.labelColor = patch.labelColor;
  if (patch.intervalDefault !== undefined) out.intervalDefault = { ...patch.intervalDefault };
  if (patch.boundaryDefault !== undefined) out.boundaryDefault = { ...patch.boundaryDefault };
  if (patch.pointDefault !== undefined) out.pointDefault = { ...patch.pointDefault };
  return out;
}

export function cloneStyleDocument(doc: StyleDocument): StyleDocument {
  const tierStyles: Record<string, TierStylePatch> = {};
  for (const [key, val] of Object.entries(doc.tierStyles)) {
    tierStyles[key] = cloneTierStylePatch(val);
  }
  const cloned: StyleDocument = {
    schemaVersion: STYLE_SCHEMA_VERSION,
    paletteId: doc.paletteId,
    bwPrintMode: doc.bwPrintMode,
    showLegendInExport: doc.showLegendInExport,
    swatchLabels: { ...doc.swatchLabels },
    tierStyles,
    rules: doc.rules.map((r) => ({
      ...r,
      ...(r.intervalStyle ? { intervalStyle: { ...r.intervalStyle } } : {}),
      ...(r.pointStyle ? { pointStyle: { ...r.pointStyle } } : {})
    })),
    intervalOverrides: doc.intervalOverrides.map((o) => ({
      ...o,
      style: { ...o.style }
    })),
    boundaryOverrides: doc.boundaryOverrides.map((o) => ({
      ...o,
      style: { ...o.style }
    })),
    pointOverrides: doc.pointOverrides.map((o) => ({
      ...o,
      style: { ...o.style }
    }))
  };
  if (doc.globalInterval) cloned.globalInterval = { ...doc.globalInterval };
  if (doc.globalBoundary) cloned.globalBoundary = { ...doc.globalBoundary };
  if (doc.globalPoint) cloned.globalPoint = { ...doc.globalPoint };
  if (doc.orphaned) {
    cloned.orphaned = {
      intervals: doc.orphaned.intervals.map((o) => ({ ...o, style: { ...o.style } })),
      boundaries: doc.orphaned.boundaries.map((o) => ({ ...o, style: { ...o.style } })),
      points: doc.orphaned.points.map((o) => ({ ...o, style: { ...o.style } }))
    };
  }
  return cloned;
}

function hasNonEmptyPatch(patch: object | undefined): boolean {
  if (!patch) return false;
  for (const val of Object.values(patch)) {
    if (val !== undefined) {
      if (typeof val === 'object' && val !== null) {
        if (hasNonEmptyPatch(val)) return true;
      } else {
        return true;
      }
    }
  }
  return false;
}

export function hasAnyCustomStyle(doc: StyleDocument | null | undefined): boolean {
  if (!doc) return false;
  if (doc.paletteId !== DEFAULT_PALETTE_ID) return true;
  if (doc.bwPrintMode) return true;
  if (doc.rules.length > 0) return true;
  if (doc.intervalOverrides.length > 0) return true;
  if (doc.boundaryOverrides.length > 0) return true;
  if (doc.pointOverrides.length > 0) return true;
  if (hasNonEmptyPatch(doc.globalInterval)) return true;
  if (hasNonEmptyPatch(doc.globalBoundary)) return true;
  if (hasNonEmptyPatch(doc.globalPoint)) return true;
  for (const label of Object.values(doc.swatchLabels)) {
    if (label && label.trim().length > 0) return true;
  }
  for (const tierStyle of Object.values(doc.tierStyles)) {
    if (hasNonEmptyPatch(tierStyle)) return true;
  }
  if (doc.orphaned) {
    if (
      doc.orphaned.intervals.length > 0 ||
      doc.orphaned.boundaries.length > 0 ||
      doc.orphaned.points.length > 0
    ) {
      return true;
    }
  }
  return false;
}

let ruleSeq = 0;

export function createRuleFromPreset(
  presetId: string,
  overrides?: Partial<StyleRule>
): StyleRule | null {
  const preset = BUILTIN_STYLE_RULE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;
  ruleSeq += 1;
  return {
    id: overrides?.id ?? `rule-${presetId}-${Date.now().toString(36)}-${ruleSeq}`,
    name: preset.rule.name,
    enabled: preset.rule.enabled,
    matchKind: preset.rule.matchKind,
    pattern: preset.rule.pattern,
    caseSensitive: preset.rule.caseSensitive,
    ...(preset.rule.intervalStyle ? { intervalStyle: { ...preset.rule.intervalStyle } } : {}),
    ...(preset.rule.pointStyle ? { pointStyle: { ...preset.rule.pointStyle } } : {}),
    ...overrides
  };
}
