import type { TextGrid } from '../bridge/types.ts';
import {
  BW_GRAY_LEVELS,
  BW_PATTERNS,
  DEFAULT_PALETTE_ID,
  cloneStyleDocument,
  createDefaultStyleDocument,
  getPalette,
  getSwatch
} from './palettes.ts';
import type {
  BoundaryStyleOverride,
  BoundaryStylePatch,
  IntervalStyleOverride,
  IntervalStylePatch,
  LineDash,
  PaletteId,
  PatternKind,
  PointShape,
  PointStyleOverride,
  PointStylePatch,
  ResolvedBoundaryStyle,
  ResolvedIntervalStyle,
  ResolvedPointStyle,
  ResolvedTierStyle,
  StyleDocument,
  StyleLegendItem,
  StyleRule,
  SvgPatternSpec,
  TierStylePatch
} from './types.ts';

export const TIME_MATCH_EPS = 1e-4;

const DEFAULT_INTERVAL_FILL_COLOR = '#FFFFFF';
const DEFAULT_EMPTY_FILL_COLOR = '#F2F0EA';
const DEFAULT_EMPTY_FILL_BW = '#F4F4F4';
const DEFAULT_BORDER_COLOR = '#2A2926';
const DEFAULT_BORDER_BW = '#000000';
const DEFAULT_TEXT_COLOR = '#141413';
const DEFAULT_TEXT_BW = '#000000';
const DEFAULT_BOUNDARY_COLOR = '#52504A';
const DEFAULT_BOUNDARY_BW = '#1F1F1F';
const DEFAULT_POINT_COLOR = '#1E3A5F';
const DEFAULT_POINT_BW = '#000000';

let overrideSeq = 0;

function nextOverrideId(prefix: string): string {
  overrideSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${overrideSeq}`;
}

function clampOpacity(val: number | undefined, fallback: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  if (val < 0) return 0;
  if (val > 1) return 1;
  return val;
}

function parseColorRgb(color: string): [number, number, number] | null {
  const trimmed = color.trim();
  const hex3 = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (hex3) {
    const h = hex3[1];
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16)
    ];
  }
  const hex6 = /^#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(trimmed);
  if (hex6) {
    const h = hex6[1];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16)
    ];
  }
  const rgbMatch = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/.exec(
    trimmed
  );
  if (rgbMatch) {
    return [
      Math.max(0, Math.min(255, Math.round(Number(rgbMatch[1])))),
      Math.max(0, Math.min(255, Math.round(Number(rgbMatch[2])))),
      Math.max(0, Math.min(255, Math.round(Number(rgbMatch[3]))))
    ];
  }
  return null;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) {
    return { h: 0, s: 0, l };
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) {
    h = (gn - bn) / d + (gn < bn ? 6 : 0);
  } else if (max === gn) {
    h = (bn - rn) / d + 2;
  } else {
    h = (rn - gn) / d + 4;
  }
  return { h: (h / 6) * 360, s, l };
}

export interface BwColorMapping {
  gray: string;
  pattern: PatternKind;
  stroke: string;
  text: string;
}

/**
 * Deterministic fallback mapping from any custom color string to a printable
 * grayscale level + vector hatch/dot pattern so distinct colors remain
 * distinguishable in black-and-white print exports.
 */
export function mapColorToBwPrint(color: string): BwColorMapping {
  const rgb = parseColorRgb(color);
  if (!rgb) {
    return {
      gray: BW_GRAY_LEVELS[1],
      pattern: 'hatch-diag',
      stroke: '#1A1A1A',
      text: '#000000'
    };
  }
  const [r, g, b] = rgb;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const { h, s } = rgbToHsl(r, g, b);

  // Quantize luminance to 5 print-safe light/mid gray levels so dark text stays legible
  const bucket = Math.max(
    0,
    Math.min(BW_GRAY_LEVELS.length - 1, Math.floor((1 - lum) * BW_GRAY_LEVELS.length))
  );
  const gray = BW_GRAY_LEVELS[bucket];

  // Chromatic colors deterministically receive one of the 6 vector patterns by hue sector;
  // near-neutral grays stay solid ('none').
  let pattern: PatternKind = 'none';
  if (s >= 0.12) {
    const sector = Math.floor(((h % 360) + 360) % 360 / 60) % BW_PATTERNS.length;
    pattern = BW_PATTERNS[sector];
  }

  return {
    gray,
    pattern,
    stroke: '#1A1A1A',
    text: '#000000'
  };
}

function getTierStylePatch(
  doc: StyleDocument,
  tierName: string,
  tierIndex: number
): TierStylePatch | null {
  const byName = doc.tierStyles[tierName];
  const byIndex = doc.tierStyles[`#${tierIndex}`];
  if (!byName && !byIndex) return null;
  if (!byIndex) return byName;
  if (!byName) return byIndex;
  return {
    labelBg: byName.labelBg ?? byIndex.labelBg,
    labelColor: byName.labelColor ?? byIndex.labelColor,
    intervalDefault:
      byIndex.intervalDefault || byName.intervalDefault
        ? mergeIntervalPatches(byIndex.intervalDefault, byName.intervalDefault)
        : undefined,
    boundaryDefault:
      byIndex.boundaryDefault || byName.boundaryDefault
        ? mergeBoundaryPatches(byIndex.boundaryDefault, byName.boundaryDefault)
        : undefined,
    pointDefault:
      byIndex.pointDefault || byName.pointDefault
        ? mergePointPatches(byIndex.pointDefault, byName.pointDefault)
        : undefined
  };
}

export function matchesStyleRule(rule: StyleRule, tierName: string, text: string): boolean {
  if (!rule.enabled) return false;
  if (rule.tierName && rule.tierName.trim().length > 0 && rule.tierName !== tierName) {
    return false;
  }
  const trimmed = text.trim();
  switch (rule.matchKind) {
    case 'empty':
      return trimmed.length === 0;
    case 'non-empty':
      return trimmed.length > 0;
    case 'exact': {
      if (rule.caseSensitive) return text === rule.pattern;
      return text.toLowerCase() === rule.pattern.toLowerCase();
    }
    case 'contains': {
      if (rule.pattern.length === 0) return false;
      if (rule.caseSensitive) return text.includes(rule.pattern);
      return text.toLowerCase().includes(rule.pattern.toLowerCase());
    }
    case 'regex': {
      if (rule.pattern.length === 0) return false;
      try {
        const flags = rule.caseSensitive ? 'u' : 'iu';
        const re = new RegExp(rule.pattern, flags);
        return re.test(text);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

interface EffectiveIntervalAcc {
  swatchId: string | null;
  swatchIdExplicit: boolean;
  fillColor?: string;
  fillColorExplicit: boolean;
  fillOpacity?: number;
  pattern?: PatternKind;
  patternExplicit: boolean;
  borderColor?: string;
  borderColorExplicit: boolean;
  borderWidth?: number;
  borderDash?: LineDash;
  textColor?: string;
  textColorExplicit: boolean;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  hasCustom: boolean;
}

function applyIntervalPatch(
  acc: EffectiveIntervalAcc,
  patch: IntervalStylePatch | undefined,
  paletteId: PaletteId
): void {
  if (!patch) return;

  if (patch.swatchId !== undefined) {
    acc.swatchId = patch.swatchId;
    acc.swatchIdExplicit = true;
    acc.hasCustom = true;
    if (patch.swatchId === null) {
      if (patch.fillColor === undefined) {
        acc.fillColor = undefined;
        acc.fillColorExplicit = false;
      }
      if (patch.borderColor === undefined) {
        acc.borderColor = undefined;
        acc.borderColorExplicit = false;
      }
      if (patch.textColor === undefined) {
        acc.textColor = undefined;
        acc.textColorExplicit = false;
      }
      if (patch.pattern === undefined) {
        acc.pattern = undefined;
        acc.patternExplicit = false;
      }
    } else {
      const swatch = getSwatch(paletteId, patch.swatchId);
      if (swatch) {
        acc.fillColor = swatch.fill;
        acc.fillColorExplicit = false;
        acc.borderColor = swatch.stroke;
        acc.borderColorExplicit = false;
        acc.textColor = swatch.text;
        acc.textColorExplicit = false;
        if (paletteId === 'journal-bw') {
          acc.pattern = swatch.bwPattern;
          acc.patternExplicit = false;
        } else if (!acc.patternExplicit) {
          acc.pattern = 'none';
        }
      }
    }
  }

  if (patch.fillColor !== undefined) {
    acc.fillColor = patch.fillColor;
    acc.fillColorExplicit = true;
    acc.hasCustom = true;
  }
  if (patch.fillOpacity !== undefined) {
    acc.fillOpacity = clampOpacity(patch.fillOpacity, 1);
    acc.hasCustom = true;
  }
  if (patch.pattern !== undefined) {
    acc.pattern = patch.pattern;
    acc.patternExplicit = true;
    acc.hasCustom = true;
  }
  if (patch.borderColor !== undefined) {
    acc.borderColor = patch.borderColor;
    acc.borderColorExplicit = true;
    acc.hasCustom = true;
  }
  if (patch.borderWidth !== undefined) {
    acc.borderWidth = patch.borderWidth;
    acc.hasCustom = true;
  }
  if (patch.borderDash !== undefined) {
    acc.borderDash = patch.borderDash;
    acc.hasCustom = true;
  }
  if (patch.textColor !== undefined) {
    acc.textColor = patch.textColor;
    acc.textColorExplicit = true;
    acc.hasCustom = true;
  }
  if (patch.fontWeight !== undefined) {
    acc.fontWeight = patch.fontWeight;
    acc.hasCustom = true;
  }
  if (patch.fontStyle !== undefined) {
    acc.fontStyle = patch.fontStyle;
    acc.hasCustom = true;
  }
}

function findIntervalOverride(
  doc: StyleDocument,
  tierIndex: number,
  tierName: string,
  itemIndex: number,
  xmin: number,
  xmax: number
): IntervalStyleOverride | null {
  for (const ov of doc.intervalOverrides) {
    if (ov.tierIndex === tierIndex && ov.itemIndex === itemIndex) {
      return ov;
    }
  }
  for (const ov of doc.intervalOverrides) {
    if (
      ov.tierName === tierName &&
      Math.abs(ov.xmin - xmin) <= TIME_MATCH_EPS &&
      Math.abs(ov.xmax - xmax) <= TIME_MATCH_EPS
    ) {
      return ov;
    }
  }
  return null;
}

function finalizeIntervalAcc(
  acc: EffectiveIntervalAcc,
  doc: StyleDocument,
  isEmptyInterval: boolean,
  matchedRuleId: string | null
): ResolvedIntervalStyle {
  const bw = doc.bwPrintMode;
  const swatch = acc.swatchId ? getSwatch(doc.paletteId, acc.swatchId) : null;

  const hasCustomFill =
    acc.fillColor !== undefined ||
    acc.fillOpacity !== undefined ||
    (acc.pattern !== undefined && acc.pattern !== 'none');
  const hasCustomBorder =
    acc.borderColor !== undefined ||
    acc.borderWidth !== undefined ||
    acc.borderDash !== undefined;
  const hasCustomText =
    acc.textColor !== undefined ||
    acc.fontWeight !== undefined ||
    acc.fontStyle !== undefined;

  let fill =
    acc.fillColor ??
    (isEmptyInterval
      ? bw
        ? DEFAULT_EMPTY_FILL_BW
        : DEFAULT_EMPTY_FILL_COLOR
      : DEFAULT_INTERVAL_FILL_COLOR);
  let pattern: PatternKind = acc.pattern ?? 'none';
  let borderColor = acc.borderColor ?? (bw ? DEFAULT_BORDER_BW : DEFAULT_BORDER_COLOR);
  let patternColor = borderColor;
  let textColor = acc.textColor ?? (bw ? DEFAULT_TEXT_BW : DEFAULT_TEXT_COLOR);

  if (bw && acc.hasCustom) {
    if (swatch && !acc.fillColorExplicit) {
      fill = swatch.bwGray;
      pattern = acc.patternExplicit && acc.pattern !== undefined ? acc.pattern : swatch.bwPattern;
      borderColor = acc.borderColorExplicit ? '#1A1A1A' : swatch.bwStroke;
      patternColor = swatch.bwStroke;
      textColor = DEFAULT_TEXT_BW;
    } else if (acc.fillColor !== undefined) {
      const mapped = mapColorToBwPrint(acc.fillColor);
      fill = mapped.gray;
      pattern = acc.patternExplicit && acc.pattern !== undefined ? acc.pattern : mapped.pattern;
      borderColor = mapped.stroke;
      patternColor = mapped.stroke;
      textColor = mapped.text;
    } else {
      borderColor = DEFAULT_BORDER_BW;
      patternColor = DEFAULT_BORDER_BW;
      textColor = DEFAULT_TEXT_BW;
    }
  }

  return {
    swatchId: acc.swatchId,
    fill,
    fillOpacity: clampOpacity(acc.fillOpacity, 1),
    pattern,
    patternColor,
    borderColor,
    borderWidth: acc.borderWidth ?? 1,
    borderDash: acc.borderDash ?? 'solid',
    textColor,
    fontWeight: acc.fontWeight ?? 'normal',
    fontStyle: acc.fontStyle ?? 'normal',
    hasCustom: acc.hasCustom,
    hasCustomFill,
    hasCustomBorder,
    hasCustomText,
    matchedRuleId
  };
}

export function resolveIntervalStyle(
  doc: StyleDocument,
  tg: TextGrid,
  tierIndex: number,
  itemIndex: number
): ResolvedIntervalStyle {
  const tier = tg.tiers[tierIndex];
  const interval = tier?.intervals[itemIndex];
  const tierName = tier?.name ?? '';
  const text = interval?.text ?? '';
  const isEmpty = text.trim().length === 0;

  const acc: EffectiveIntervalAcc = {
    swatchId: null,
    swatchIdExplicit: false,
    fillColorExplicit: false,
    patternExplicit: false,
    borderColorExplicit: false,
    textColorExplicit: false,
    hasCustom: false
  };

  // Layer 1: Global default
  applyIntervalPatch(acc, doc.globalInterval, doc.paletteId);

  // Layer 2: Tier default
  const tierStyle = getTierStylePatch(doc, tierName, tierIndex);
  applyIntervalPatch(acc, tierStyle?.intervalDefault, doc.paletteId);

  // Layer 3: Conditional rules (ordered; later matching rule overrides earlier)
  let matchedRuleId: string | null = null;
  for (const rule of doc.rules) {
    if (rule.intervalStyle && matchesStyleRule(rule, tierName, text)) {
      applyIntervalPatch(acc, rule.intervalStyle, doc.paletteId);
      matchedRuleId = rule.id;
    }
  }

  // Layer 4: Individual interval override
  if (interval) {
    const override = findIntervalOverride(
      doc,
      tierIndex,
      tierName,
      itemIndex,
      interval.xmin,
      interval.xmax
    );
    if (override) {
      applyIntervalPatch(acc, override.style, doc.paletteId);
    }
  }

  return finalizeIntervalAcc(acc, doc, isEmpty, matchedRuleId);
}

interface EffectiveBoundaryAcc {
  swatchId: string | null;
  strokeColor?: string;
  strokeColorExplicit: boolean;
  strokeWidth?: number;
  strokeDash?: LineDash;
  extendToAcoustic?: boolean;
  hasCustom: boolean;
}

function applyBoundaryPatch(
  acc: EffectiveBoundaryAcc,
  patch: BoundaryStylePatch | undefined,
  paletteId: PaletteId
): void {
  if (!patch) return;

  if (patch.swatchId !== undefined) {
    acc.swatchId = patch.swatchId;
    acc.hasCustom = true;
    if (patch.swatchId === null) {
      if (patch.strokeColor === undefined) {
        acc.strokeColor = undefined;
        acc.strokeColorExplicit = false;
      }
    } else {
      const swatch = getSwatch(paletteId, patch.swatchId);
      if (swatch) {
        acc.strokeColor = swatch.stroke;
        acc.strokeColorExplicit = false;
      }
    }
  }

  if (patch.strokeColor !== undefined) {
    acc.strokeColor = patch.strokeColor;
    acc.strokeColorExplicit = true;
    acc.hasCustom = true;
  }
  if (patch.strokeWidth !== undefined) {
    acc.strokeWidth = patch.strokeWidth;
    acc.hasCustom = true;
  }
  if (patch.strokeDash !== undefined) {
    acc.strokeDash = patch.strokeDash;
    acc.hasCustom = true;
  }
  if (patch.extendToAcoustic !== undefined) {
    acc.extendToAcoustic = patch.extendToAcoustic;
    acc.hasCustom = true;
  }
}

export function resolveBoundaryStyle(
  doc: StyleDocument,
  tg: TextGrid,
  tierIndex: number,
  time: number
): ResolvedBoundaryStyle {
  const tier = tg.tiers[tierIndex];
  const tierName = tier?.name ?? '';

  const acc: EffectiveBoundaryAcc = {
    swatchId: null,
    strokeColorExplicit: false,
    hasCustom: false
  };

  // Layer 1: Global boundary default
  applyBoundaryPatch(acc, doc.globalBoundary, doc.paletteId);

  // Layer 2: Tier boundary default
  const tierStyle = getTierStylePatch(doc, tierName, tierIndex);
  applyBoundaryPatch(acc, tierStyle?.boundaryDefault, doc.paletteId);

  // Layer 3: Shared aligned-time boundary override (tierIndex === null)
  for (const ov of doc.boundaryOverrides) {
    if (ov.tierIndex === null && Math.abs(ov.time - time) <= TIME_MATCH_EPS) {
      applyBoundaryPatch(acc, ov.style, doc.paletteId);
      break;
    }
  }

  // Layer 4: Tier-specific boundary override
  for (const ov of doc.boundaryOverrides) {
    if (ov.tierIndex === tierIndex && Math.abs(ov.time - time) <= TIME_MATCH_EPS) {
      applyBoundaryPatch(acc, ov.style, doc.paletteId);
      break;
    }
  }

  const bw = doc.bwPrintMode;
  const swatch = acc.swatchId ? getSwatch(doc.paletteId, acc.swatchId) : null;
  let strokeColor = acc.strokeColor ?? (bw ? DEFAULT_BOUNDARY_BW : DEFAULT_BOUNDARY_COLOR);
  if (bw && acc.hasCustom) {
    strokeColor = swatch && !acc.strokeColorExplicit ? swatch.bwStroke : '#141414';
  }

  return {
    swatchId: acc.swatchId,
    strokeColor,
    strokeWidth: acc.strokeWidth ?? 1,
    strokeDash: acc.strokeDash ?? 'solid',
    extendToAcoustic: acc.extendToAcoustic ?? false,
    hasCustom: acc.hasCustom
  };
}

interface EffectivePointAcc {
  swatchId: string | null;
  color?: string;
  colorExplicit: boolean;
  shape?: PointShape;
  size?: number;
  stemColor?: string;
  stemDash?: LineDash;
  textColor?: string;
  fontWeight?: 'normal' | 'bold';
  hasCustom: boolean;
}

function applyPointPatch(
  acc: EffectivePointAcc,
  patch: PointStylePatch | undefined,
  paletteId: PaletteId
): void {
  if (!patch) return;

  if (patch.swatchId !== undefined) {
    acc.swatchId = patch.swatchId;
    acc.hasCustom = true;
    if (patch.swatchId === null) {
      if (patch.color === undefined) {
        acc.color = undefined;
        acc.colorExplicit = false;
      }
      if (patch.stemColor === undefined) acc.stemColor = undefined;
      if (patch.textColor === undefined) acc.textColor = undefined;
    } else {
      const swatch = getSwatch(paletteId, patch.swatchId);
      if (swatch) {
        acc.color = swatch.stroke;
        acc.colorExplicit = false;
        acc.stemColor = swatch.stroke;
        acc.textColor = swatch.text;
      }
    }
  }

  if (patch.color !== undefined) {
    acc.color = patch.color;
    acc.colorExplicit = true;
    acc.hasCustom = true;
  }
  if (patch.shape !== undefined) {
    acc.shape = patch.shape;
    acc.hasCustom = true;
  }
  if (patch.size !== undefined) {
    acc.size = patch.size;
    acc.hasCustom = true;
  }
  if (patch.stemColor !== undefined) {
    acc.stemColor = patch.stemColor;
    acc.hasCustom = true;
  }
  if (patch.stemDash !== undefined) {
    acc.stemDash = patch.stemDash;
    acc.hasCustom = true;
  }
  if (patch.textColor !== undefined) {
    acc.textColor = patch.textColor;
    acc.hasCustom = true;
  }
  if (patch.fontWeight !== undefined) {
    acc.fontWeight = patch.fontWeight;
    acc.hasCustom = true;
  }
}

function findPointOverride(
  doc: StyleDocument,
  tierIndex: number,
  tierName: string,
  itemIndex: number,
  time: number
): PointStyleOverride | null {
  for (const ov of doc.pointOverrides) {
    if (ov.tierIndex === tierIndex && ov.itemIndex === itemIndex) {
      return ov;
    }
  }
  for (const ov of doc.pointOverrides) {
    if (ov.tierName === tierName && Math.abs(ov.time - time) <= TIME_MATCH_EPS) {
      return ov;
    }
  }
  return null;
}

export function resolvePointStyle(
  doc: StyleDocument,
  tg: TextGrid,
  tierIndex: number,
  itemIndex: number
): ResolvedPointStyle {
  const tier = tg.tiers[tierIndex];
  const point = tier?.points[itemIndex];
  const tierName = tier?.name ?? '';
  const mark = point?.mark ?? '';

  const acc: EffectivePointAcc = {
    swatchId: null,
    colorExplicit: false,
    hasCustom: false
  };

  // Layer 1: Global point default
  applyPointPatch(acc, doc.globalPoint, doc.paletteId);

  // Layer 2: Tier point default
  const tierStyle = getTierStylePatch(doc, tierName, tierIndex);
  applyPointPatch(acc, tierStyle?.pointDefault, doc.paletteId);

  // Layer 3: Conditional rules
  let matchedRuleId: string | null = null;
  for (const rule of doc.rules) {
    if (rule.pointStyle && matchesStyleRule(rule, tierName, mark)) {
      applyPointPatch(acc, rule.pointStyle, doc.paletteId);
      matchedRuleId = rule.id;
    }
  }

  // Layer 4: Individual point override
  if (point) {
    const override = findPointOverride(doc, tierIndex, tierName, itemIndex, point.number);
    if (override) {
      applyPointPatch(acc, override.style, doc.paletteId);
    }
  }

  const bw = doc.bwPrintMode;
  const swatch = acc.swatchId ? getSwatch(doc.paletteId, acc.swatchId) : null;
  let color = acc.color ?? (bw ? DEFAULT_POINT_BW : DEFAULT_POINT_COLOR);
  let stemColor = acc.stemColor ?? color;
  let textColor = acc.textColor ?? (bw ? DEFAULT_TEXT_BW : DEFAULT_TEXT_COLOR);

  if (bw && acc.hasCustom) {
    const bwStroke = swatch && !acc.colorExplicit ? swatch.bwStroke : '#141414';
    color = bwStroke;
    stemColor = bwStroke;
    textColor = DEFAULT_TEXT_BW;
  }

  return {
    swatchId: acc.swatchId,
    color,
    shape: acc.shape ?? 'circle',
    size: acc.size ?? 4,
    stemColor,
    stemDash: acc.stemDash ?? 'solid',
    textColor,
    fontWeight: acc.fontWeight ?? 'normal',
    hasCustom: acc.hasCustom,
    matchedRuleId
  };
}

export function resolveTierStyle(
  doc: StyleDocument,
  tg: TextGrid,
  tierIndex: number
): ResolvedTierStyle {
  const tier = tg.tiers[tierIndex];
  const tierName = tier?.name ?? '';
  const patch = getTierStylePatch(doc, tierName, tierIndex);
  if (!patch || (patch.labelBg === undefined && patch.labelColor === undefined)) {
    return { labelBg: null, labelColor: null, hasCustom: false };
  }
  if (doc.bwPrintMode) {
    const mappedBg = patch.labelBg ? mapColorToBwPrint(patch.labelBg).gray : null;
    return {
      labelBg: mappedBg,
      labelColor: patch.labelColor ? '#000000' : null,
      hasCustom: true
    };
  }
  return {
    labelBg: patch.labelBg ?? null,
    labelColor: patch.labelColor ?? null,
    hasCustom: true
  };
}

function sanitizeColorToken(color: string): string {
  return color
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function makeSvgPatternId(
  kind: Exclude<PatternKind, 'none'>,
  bgColor: string,
  fgColor: string,
  opacity = 1,
  idPrefix = 'tg-pat'
): string {
  const opToken = Math.round(clampOpacity(opacity, 1) * 100);
  return `${idPrefix}-${kind}-${sanitizeColorToken(bgColor)}-${sanitizeColorToken(fgColor)}-${opToken}`;
}

export function collectUsedPatternSpecs(
  doc: StyleDocument,
  tg: TextGrid,
  idPrefix = 'tg-pat'
): SvgPatternSpec[] {
  const seen = new Map<string, SvgPatternSpec>();

  for (let ti = 0; ti < tg.tiers.length; ti += 1) {
    const tier = tg.tiers[ti];
    if (tier.kind !== 'intervalTier') continue;
    for (let ii = 0; ii < tier.intervals.length; ii += 1) {
      const resolved = resolveIntervalStyle(doc, tg, ti, ii);
      if (resolved.pattern === 'none') continue;
      const id = makeSvgPatternId(
        resolved.pattern,
        resolved.fill,
        resolved.patternColor,
        resolved.fillOpacity,
        idPrefix
      );
      if (!seen.has(id)) {
        seen.set(id, {
          id,
          kind: resolved.pattern,
          bgColor: resolved.fill,
          fgColor: resolved.patternColor,
          opacity: resolved.fillOpacity
        });
      }
    }
  }

  return Array.from(seen.values());
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildSvgPatternDefs(specs: readonly SvgPatternSpec[], idPrefix?: string): string {
  if (specs.length === 0) return '';
  const parts: string[] = [];

  for (const spec of specs) {
    const pid = escapeXmlAttr(
      idPrefix && !spec.id.startsWith(idPrefix)
        ? makeSvgPatternId(spec.kind, spec.bgColor, spec.fgColor, spec.opacity, idPrefix)
        : spec.id
    );
    const bg = escapeXmlAttr(spec.bgColor);
    const fg = escapeXmlAttr(spec.fgColor);
    const op = Number(clampOpacity(spec.opacity, 1).toFixed(3));
    const bgOpAttr = op < 1 ? ` fill-opacity="${op}"` : '';

    switch (spec.kind) {
      case 'hatch-diag':
        parts.push(
          `<pattern id="${pid}" width="8" height="8" patternUnits="userSpaceOnUse">` +
            `<rect width="8" height="8" fill="${bg}"${bgOpAttr}/>` +
            `<path d="M-2,2 l4,-4 M0,8 l8,-8 M6,10 l4,-4" stroke="${fg}" stroke-width="0.9" stroke-opacity="0.55" fill="none"/>` +
            `</pattern>`
        );
        break;
      case 'hatch-back':
        parts.push(
          `<pattern id="${pid}" width="8" height="8" patternUnits="userSpaceOnUse">` +
            `<rect width="8" height="8" fill="${bg}"${bgOpAttr}/>` +
            `<path d="M-2,6 l4,4 M0,0 l8,8 M6,-2 l4,4" stroke="${fg}" stroke-width="0.9" stroke-opacity="0.55" fill="none"/>` +
            `</pattern>`
        );
        break;
      case 'crosshatch':
        parts.push(
          `<pattern id="${pid}" width="8" height="8" patternUnits="userSpaceOnUse">` +
            `<rect width="8" height="8" fill="${bg}"${bgOpAttr}/>` +
            `<path d="M0,8 l8,-8 M-2,2 l4,-4 M6,10 l4,-4 M0,0 l8,8 M-2,6 l4,4 M6,-2 l4,4" stroke="${fg}" stroke-width="0.8" stroke-opacity="0.5" fill="none"/>` +
            `</pattern>`
        );
        break;
      case 'dots':
        parts.push(
          `<pattern id="${pid}" width="8" height="8" patternUnits="userSpaceOnUse">` +
            `<rect width="8" height="8" fill="${bg}"${bgOpAttr}/>` +
            `<circle cx="2" cy="2" r="1.05" fill="${fg}" fill-opacity="0.55"/>` +
            `<circle cx="6" cy="6" r="1.05" fill="${fg}" fill-opacity="0.55"/>` +
            `</pattern>`
        );
        break;
      case 'stripes-v':
        parts.push(
          `<pattern id="${pid}" width="6" height="6" patternUnits="userSpaceOnUse">` +
            `<rect width="6" height="6" fill="${bg}"${bgOpAttr}/>` +
            `<line x1="3" y1="0" x2="3" y2="6" stroke="${fg}" stroke-width="0.9" stroke-opacity="0.55"/>` +
            `</pattern>`
        );
        break;
      case 'stripes-h':
        parts.push(
          `<pattern id="${pid}" width="6" height="6" patternUnits="userSpaceOnUse">` +
            `<rect width="6" height="6" fill="${bg}"${bgOpAttr}/>` +
            `<line x1="0" y1="3" x2="6" y2="3" stroke="${fg}" stroke-width="0.9" stroke-opacity="0.55"/>` +
            `</pattern>`
        );
        break;
    }
  }

  return parts.join('');
}

export function buildStyleLegendItems(doc: StyleDocument, tg: TextGrid): StyleLegendItem[] {
  const items: StyleLegendItem[] = [];
  const usedRuleIds = new Set<string>();
  const usedSwatchIds = new Set<string>();
  const ruleCoveredSwatches = new Set<string>();

  for (let ti = 0; ti < tg.tiers.length; ti += 1) {
    const tier = tg.tiers[ti];
    if (tier.kind === 'intervalTier') {
      for (let ii = 0; ii < tier.intervals.length; ii += 1) {
        const res = resolveIntervalStyle(doc, tg, ti, ii);
        if (res.matchedRuleId) usedRuleIds.add(res.matchedRuleId);
        if (res.swatchId) usedSwatchIds.add(res.swatchId);
      }
    } else {
      for (let pi = 0; pi < tier.points.length; pi += 1) {
        const res = resolvePointStyle(doc, tg, ti, pi);
        if (res.matchedRuleId) usedRuleIds.add(res.matchedRuleId);
        if (res.swatchId) usedSwatchIds.add(res.swatchId);
      }
    }
  }

  // 1. Named matching rules
  for (const rule of doc.rules) {
    if (!rule.enabled || !usedRuleIds.has(rule.id)) continue;
    const label = rule.name.trim();
    if (!label) continue;

    if (rule.intervalStyle) {
      const acc: EffectiveIntervalAcc = {
        swatchId: null,
        swatchIdExplicit: false,
        fillColorExplicit: false,
        patternExplicit: false,
        borderColorExplicit: false,
        textColorExplicit: false,
        hasCustom: false
      };
      applyIntervalPatch(acc, rule.intervalStyle, doc.paletteId);
      const resolved = finalizeIntervalAcc(acc, doc, false, rule.id);
      if (resolved.swatchId) ruleCoveredSwatches.add(resolved.swatchId);
      items.push({
        id: `rule:${rule.id}`,
        label,
        source: 'rule',
        kind: 'interval',
        fill: resolved.fill,
        fillOpacity: resolved.fillOpacity,
        pattern: resolved.pattern,
        patternColor: resolved.patternColor,
        borderColor: resolved.borderColor,
        borderDash: resolved.borderDash
      });
    } else if (rule.pointStyle) {
      const acc: EffectivePointAcc = {
        swatchId: null,
        colorExplicit: false,
        hasCustom: false
      };
      applyPointPatch(acc, rule.pointStyle, doc.paletteId);
      const swatch = acc.swatchId ? getSwatch(doc.paletteId, acc.swatchId) : null;
      const color = doc.bwPrintMode
        ? swatch && !acc.colorExplicit
          ? swatch.bwStroke
          : '#141414'
        : acc.color ?? DEFAULT_POINT_COLOR;
      if (acc.swatchId) ruleCoveredSwatches.add(acc.swatchId);
      items.push({
        id: `rule:${rule.id}`,
        label,
        source: 'rule',
        kind: 'point',
        fill: color,
        fillOpacity: 1,
        pattern: 'none',
        patternColor: color,
        borderColor: color,
        borderDash: acc.stemDash ?? 'solid',
        pointShape: acc.shape ?? 'circle'
      });
    }
  }

  // 2. Named swatches actually used in the document
  const palette = getPalette(doc.paletteId);
  for (const swatch of palette.swatches) {
    const customLabel = doc.swatchLabels[swatch.id]?.trim();
    if (!customLabel) continue;
    if (!usedSwatchIds.has(swatch.id)) continue;
    if (ruleCoveredSwatches.has(swatch.id)) {
      const sameNameRule = items.some((it) => it.label === customLabel);
      if (sameNameRule) continue;
    }

    const acc: EffectiveIntervalAcc = {
      swatchId: null,
      swatchIdExplicit: false,
      fillColorExplicit: false,
      patternExplicit: false,
      borderColorExplicit: false,
      textColorExplicit: false,
      hasCustom: false
    };
    applyIntervalPatch(acc, { swatchId: swatch.id }, doc.paletteId);
    const resolved = finalizeIntervalAcc(acc, doc, false, null);

    items.push({
      id: `swatch:${swatch.id}`,
      label: customLabel,
      source: 'swatch',
      kind: 'interval',
      fill: resolved.fill,
      fillOpacity: resolved.fillOpacity,
      pattern: resolved.pattern,
      patternColor: resolved.patternColor,
      borderColor: resolved.borderColor,
      borderDash: resolved.borderDash
    });
  }

  return items;
}

// ============================================================================
// Pure mutation helpers
// ============================================================================

function mergeIntervalPatches(
  base: IntervalStylePatch | undefined,
  next: IntervalStylePatch | undefined
): IntervalStylePatch {
  if (!base) return next ? { ...next } : {};
  if (!next) return { ...base };
  const merged: IntervalStylePatch = { ...base, ...next };
  // If switching swatchId without supplying an explicit fillColor/borderColor/textColor,
  // clear stale explicit color overrides from base so the new swatch takes effect cleanly.
  if (next.swatchId !== undefined && next.swatchId !== base.swatchId) {
    if (next.fillColor === undefined) delete merged.fillColor;
    if (next.borderColor === undefined) delete merged.borderColor;
    if (next.textColor === undefined) delete merged.textColor;
  }
  return merged;
}

function mergeBoundaryPatches(
  base: BoundaryStylePatch | undefined,
  next: BoundaryStylePatch | undefined
): BoundaryStylePatch {
  if (!base) return next ? { ...next } : {};
  if (!next) return { ...base };
  const merged: BoundaryStylePatch = { ...base, ...next };
  if (next.swatchId !== undefined && next.swatchId !== base.swatchId) {
    if (next.strokeColor === undefined) delete merged.strokeColor;
  }
  return merged;
}

function mergePointPatches(
  base: PointStylePatch | undefined,
  next: PointStylePatch | undefined
): PointStylePatch {
  if (!base) return next ? { ...next } : {};
  if (!next) return { ...base };
  const merged: PointStylePatch = { ...base, ...next };
  if (next.swatchId !== undefined && next.swatchId !== base.swatchId) {
    if (next.color === undefined) delete merged.color;
    if (next.stemColor === undefined) delete merged.stemColor;
    if (next.textColor === undefined) delete merged.textColor;
  }
  return merged;
}

export function setIntervalStyleOverride(
  doc: StyleDocument,
  tg: TextGrid,
  tierIndex: number,
  itemIndex: number,
  patch: IntervalStylePatch,
  mode: 'merge' | 'replace' = 'merge'
): StyleDocument {
  const tier = tg.tiers[tierIndex];
  const interval = tier?.intervals[itemIndex];
  if (!tier || !interval) return doc;

  const next = cloneStyleDocument(doc);
  const idx = next.intervalOverrides.findIndex(
    (o) => o.tierIndex === tierIndex && o.itemIndex === itemIndex
  );

  if (idx >= 0) {
    const existing = next.intervalOverrides[idx];
    next.intervalOverrides[idx] = {
      ...existing,
      tierName: tier.name,
      xmin: interval.xmin,
      xmax: interval.xmax,
      textSnapshot: interval.text,
      style: mode === 'replace' ? { ...patch } : mergeIntervalPatches(existing.style, patch)
    };
  } else {
    next.intervalOverrides.push({
      id: nextOverrideId('iv'),
      tierIndex,
      tierName: tier.name,
      itemIndex,
      xmin: interval.xmin,
      xmax: interval.xmax,
      textSnapshot: interval.text,
      style: { ...patch }
    });
  }
  return next;
}

export function setBoundaryStyleOverride(
  doc: StyleDocument,
  tg: TextGrid,
  tierIndex: number | null,
  time: number,
  patch: BoundaryStylePatch,
  mode: 'merge' | 'replace' = 'merge'
): StyleDocument {
  const tierName = tierIndex === null ? '' : tg.tiers[tierIndex]?.name ?? '';
  const next = cloneStyleDocument(doc);
  const idx = next.boundaryOverrides.findIndex(
    (o) => o.tierIndex === tierIndex && Math.abs(o.time - time) <= TIME_MATCH_EPS
  );

  if (idx >= 0) {
    const existing = next.boundaryOverrides[idx];
    next.boundaryOverrides[idx] = {
      ...existing,
      tierName,
      time,
      style: mode === 'replace' ? { ...patch } : mergeBoundaryPatches(existing.style, patch)
    };
  } else {
    next.boundaryOverrides.push({
      id: nextOverrideId('bd'),
      tierIndex,
      tierName,
      time,
      style: { ...patch }
    });
  }
  return next;
}

export function setPointStyleOverride(
  doc: StyleDocument,
  tg: TextGrid,
  tierIndex: number,
  itemIndex: number,
  patch: PointStylePatch,
  mode: 'merge' | 'replace' = 'merge'
): StyleDocument {
  const tier = tg.tiers[tierIndex];
  const point = tier?.points[itemIndex];
  if (!tier || !point) return doc;

  const next = cloneStyleDocument(doc);
  const idx = next.pointOverrides.findIndex(
    (o) => o.tierIndex === tierIndex && o.itemIndex === itemIndex
  );

  if (idx >= 0) {
    const existing = next.pointOverrides[idx];
    next.pointOverrides[idx] = {
      ...existing,
      tierName: tier.name,
      time: point.number,
      markSnapshot: point.mark,
      style: mode === 'replace' ? { ...patch } : mergePointPatches(existing.style, patch)
    };
  } else {
    next.pointOverrides.push({
      id: nextOverrideId('pt'),
      tierIndex,
      tierName: tier.name,
      itemIndex,
      time: point.number,
      markSnapshot: point.mark,
      style: { ...patch }
    });
  }
  return next;
}

export function setTierStylePatch(
  doc: StyleDocument,
  tierKey: string,
  patch: TierStylePatch,
  mode: 'merge' | 'replace' = 'merge'
): StyleDocument {
  const next = cloneStyleDocument(doc);
  const existing = next.tierStyles[tierKey];
  if (mode === 'replace' || !existing) {
    next.tierStyles[tierKey] = {
      ...(patch.labelBg !== undefined ? { labelBg: patch.labelBg } : {}),
      ...(patch.labelColor !== undefined ? { labelColor: patch.labelColor } : {}),
      ...(patch.intervalDefault ? { intervalDefault: { ...patch.intervalDefault } } : {}),
      ...(patch.boundaryDefault ? { boundaryDefault: { ...patch.boundaryDefault } } : {}),
      ...(patch.pointDefault ? { pointDefault: { ...patch.pointDefault } } : {})
    };
  } else {
    next.tierStyles[tierKey] = {
      labelBg: 'labelBg' in patch ? patch.labelBg : existing.labelBg,
      labelColor: 'labelColor' in patch ? patch.labelColor : existing.labelColor,
      intervalDefault:
        patch.intervalDefault !== undefined
          ? mergeIntervalPatches(existing.intervalDefault, patch.intervalDefault)
          : existing.intervalDefault,
      boundaryDefault:
        patch.boundaryDefault !== undefined
          ? mergeBoundaryPatches(existing.boundaryDefault, patch.boundaryDefault)
          : existing.boundaryDefault,
      pointDefault:
        patch.pointDefault !== undefined
          ? mergePointPatches(existing.pointDefault, patch.pointDefault)
          : existing.pointDefault
    };
  }
  return next;
}

export type ClearOverrideTarget =
  | { kind: 'interval'; tierIndex: number; itemIndex: number }
  | { kind: 'boundary'; tierIndex: number | null; time: number }
  | { kind: 'point'; tierIndex: number; itemIndex: number };

export function clearObjectStyleOverride(
  doc: StyleDocument,
  target: ClearOverrideTarget
): StyleDocument {
  const next = cloneStyleDocument(doc);
  if (target.kind === 'interval') {
    next.intervalOverrides = next.intervalOverrides.filter(
      (o) => !(o.tierIndex === target.tierIndex && o.itemIndex === target.itemIndex)
    );
  } else if (target.kind === 'boundary') {
    next.boundaryOverrides = next.boundaryOverrides.filter(
      (o) => !(o.tierIndex === target.tierIndex && Math.abs(o.time - target.time) <= TIME_MATCH_EPS)
    );
  } else {
    next.pointOverrides = next.pointOverrides.filter(
      (o) => !(o.tierIndex === target.tierIndex && o.itemIndex === target.itemIndex)
    );
  }
  return next;
}

export function clearAllStyles(
  doc: StyleDocument,
  options?: { keepPalette?: boolean }
): StyleDocument {
  const paletteId = options?.keepPalette ? doc.paletteId : DEFAULT_PALETTE_ID;
  return createDefaultStyleDocument(paletteId);
}

export function applyStyleToSameTextIntervals(
  doc: StyleDocument,
  tg: TextGrid,
  sourceTierIndex: number,
  sourceItemIndex: number,
  patch: IntervalStylePatch,
  options?: { allTiers?: boolean; caseSensitive?: boolean; mode?: 'merge' | 'replace' }
): StyleDocument {
  const sourceTier = tg.tiers[sourceTierIndex];
  const sourceInterval = sourceTier?.intervals[sourceItemIndex];
  if (!sourceTier || !sourceInterval) return doc;

  const targetText = sourceInterval.text;
  const caseSensitive = options?.caseSensitive ?? true;
  const normalizedTarget = caseSensitive ? targetText : targetText.toLowerCase();
  const allTiers = options?.allTiers ?? false;
  const mode = options?.mode ?? 'merge';

  let current = doc;
  for (let ti = 0; ti < tg.tiers.length; ti += 1) {
    if (!allTiers && ti !== sourceTierIndex) continue;
    const tier = tg.tiers[ti];
    if (tier.kind !== 'intervalTier') continue;
    for (let ii = 0; ii < tier.intervals.length; ii += 1) {
      const ivText = tier.intervals[ii].text;
      const matches = caseSensitive
        ? ivText === normalizedTarget
        : ivText.toLowerCase() === normalizedTarget;
      if (matches) {
        current = setIntervalStyleOverride(current, tg, ti, ii, patch, mode);
      }
    }
  }
  return current;
}
