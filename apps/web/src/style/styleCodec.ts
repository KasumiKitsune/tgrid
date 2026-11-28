import type { Interval, TextGrid, TextPoint, Tier } from '../bridge/types.ts';
import { DEFAULT_PALETTE_ID, isPaletteId } from './palettes.ts';
import {
  STYLE_SCHEMA_VERSION,
  type BoundaryStyleOverride,
  type BoundaryStylePatch,
  type IntervalStyleOverride,
  type IntervalStylePatch,
  type LayoutPrefs,
  type LineDash,
  type PatternKind,
  type PointShape,
  type PointStyleOverride,
  type PointStylePatch,
  type StyleDocument,
  type StyleRule,
  type StyleRuleMatchKind,
  type SvgProjectPayload,
  type TierStylePatch
} from './types.ts';

export const STYLE_SIDECAR_EXT = '.tgstyle.json';
export const TGRID_SVG_METADATA_NS = 'https://tgrid.app/ns/project/1';

const VALID_PATTERNS = new Set<PatternKind>([
  'none',
  'hatch-diag',
  'hatch-back',
  'crosshatch',
  'dots',
  'stripes-v',
  'stripes-h'
]);

const VALID_DASHES = new Set<LineDash>(['solid', 'dashed', 'dotted']);
const VALID_SHAPES = new Set<PointShape>(['circle', 'diamond', 'triangle', 'square', 'cross']);
const VALID_MATCH_KINDS = new Set<StyleRuleMatchKind>([
  'exact',
  'contains',
  'regex',
  'empty',
  'non-empty'
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function sanitizeIntervalPatch(raw: unknown): IntervalStylePatch | undefined {
  if (!isRecord(raw)) return undefined;
  const out: IntervalStylePatch = {};
  if (raw.swatchId === null || typeof raw.swatchId === 'string') {
    out.swatchId = raw.swatchId;
  }
  if (typeof raw.fillColor === 'string') out.fillColor = raw.fillColor;
  const op = asFiniteNumber(raw.fillOpacity);
  if (op !== undefined) out.fillOpacity = Math.max(0, Math.min(1, op));
  if (typeof raw.pattern === 'string' && VALID_PATTERNS.has(raw.pattern as PatternKind)) {
    out.pattern = raw.pattern as PatternKind;
  }
  if (typeof raw.borderColor === 'string') out.borderColor = raw.borderColor;
  const bw = asFiniteNumber(raw.borderWidth);
  if (bw !== undefined && bw >= 0) out.borderWidth = bw;
  if (typeof raw.borderDash === 'string' && VALID_DASHES.has(raw.borderDash as LineDash)) {
    out.borderDash = raw.borderDash as LineDash;
  }
  if (typeof raw.textColor === 'string') out.textColor = raw.textColor;
  if (raw.fontWeight === 'normal' || raw.fontWeight === 'bold') {
    out.fontWeight = raw.fontWeight;
  }
  if (raw.fontStyle === 'normal' || raw.fontStyle === 'italic') {
    out.fontStyle = raw.fontStyle;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeBoundaryPatch(raw: unknown): BoundaryStylePatch | undefined {
  if (!isRecord(raw)) return undefined;
  const out: BoundaryStylePatch = {};
  if (raw.swatchId === null || typeof raw.swatchId === 'string') {
    out.swatchId = raw.swatchId;
  }
  if (typeof raw.strokeColor === 'string') out.strokeColor = raw.strokeColor;
  const sw = asFiniteNumber(raw.strokeWidth);
  if (sw !== undefined && sw >= 0) out.strokeWidth = sw;
  if (typeof raw.strokeDash === 'string' && VALID_DASHES.has(raw.strokeDash as LineDash)) {
    out.strokeDash = raw.strokeDash as LineDash;
  }
  if (typeof raw.extendToAcoustic === 'boolean') {
    out.extendToAcoustic = raw.extendToAcoustic;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizePointPatch(raw: unknown): PointStylePatch | undefined {
  if (!isRecord(raw)) return undefined;
  const out: PointStylePatch = {};
  if (raw.swatchId === null || typeof raw.swatchId === 'string') {
    out.swatchId = raw.swatchId;
  }
  if (typeof raw.color === 'string') out.color = raw.color;
  if (typeof raw.shape === 'string' && VALID_SHAPES.has(raw.shape as PointShape)) {
    out.shape = raw.shape as PointShape;
  }
  const sz = asFiniteNumber(raw.size);
  if (sz !== undefined && sz > 0) out.size = sz;
  if (typeof raw.stemColor === 'string') out.stemColor = raw.stemColor;
  if (typeof raw.stemDash === 'string' && VALID_DASHES.has(raw.stemDash as LineDash)) {
    out.stemDash = raw.stemDash as LineDash;
  }
  if (typeof raw.textColor === 'string') out.textColor = raw.textColor;
  if (raw.fontWeight === 'normal' || raw.fontWeight === 'bold') {
    out.fontWeight = raw.fontWeight;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeTierPatch(raw: unknown): TierStylePatch | undefined {
  if (!isRecord(raw)) return undefined;
  const out: TierStylePatch = {};
  if (typeof raw.labelBg === 'string') out.labelBg = raw.labelBg;
  if (typeof raw.labelColor === 'string') out.labelColor = raw.labelColor;
  const iv = sanitizeIntervalPatch(raw.intervalDefault);
  if (iv) out.intervalDefault = iv;
  const bd = sanitizeBoundaryPatch(raw.boundaryDefault);
  if (bd) out.boundaryDefault = bd;
  const pt = sanitizePointPatch(raw.pointDefault);
  if (pt) out.pointDefault = pt;
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeRule(raw: unknown): StyleRule | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  const name = asString(raw.name) ?? '';
  const matchKind = raw.matchKind;
  if (!id || typeof matchKind !== 'string' || !VALID_MATCH_KINDS.has(matchKind as StyleRuleMatchKind)) {
    return null;
  }
  const intervalStyle = sanitizeIntervalPatch(raw.intervalStyle);
  const pointStyle = sanitizePointPatch(raw.pointStyle);
  const rule: StyleRule = {
    id,
    name,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    matchKind: matchKind as StyleRuleMatchKind,
    pattern: asString(raw.pattern) ?? ''
  };
  if (typeof raw.tierName === 'string' && raw.tierName.length > 0) {
    rule.tierName = raw.tierName;
  }
  if (typeof raw.caseSensitive === 'boolean') {
    rule.caseSensitive = raw.caseSensitive;
  }
  if (intervalStyle) rule.intervalStyle = intervalStyle;
  if (pointStyle) rule.pointStyle = pointStyle;
  return rule;
}

function sanitizeIntervalOverride(raw: unknown): IntervalStyleOverride | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  const tierIndex = asFiniteNumber(raw.tierIndex);
  const itemIndex = asFiniteNumber(raw.itemIndex);
  const xmin = asFiniteNumber(raw.xmin);
  const xmax = asFiniteNumber(raw.xmax);
  const style = sanitizeIntervalPatch(raw.style);
  if (
    !id ||
    tierIndex === undefined ||
    itemIndex === undefined ||
    xmin === undefined ||
    xmax === undefined ||
    !style
  ) {
    return null;
  }
  return {
    id,
    tierIndex: Math.trunc(tierIndex),
    tierName: asString(raw.tierName) ?? '',
    itemIndex: Math.trunc(itemIndex),
    xmin,
    xmax,
    textSnapshot: asString(raw.textSnapshot) ?? '',
    style
  };
}

function sanitizeBoundaryOverride(raw: unknown): BoundaryStyleOverride | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  const time = asFiniteNumber(raw.time);
  const style = sanitizeBoundaryPatch(raw.style);
  const tierIndex = raw.tierIndex === null ? null : asFiniteNumber(raw.tierIndex);
  if (!id || time === undefined || !style || tierIndex === undefined) {
    return null;
  }
  return {
    id,
    tierIndex: tierIndex === null ? null : Math.trunc(tierIndex),
    tierName: asString(raw.tierName) ?? '',
    time,
    style
  };
}

function sanitizePointOverride(raw: unknown): PointStyleOverride | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  const tierIndex = asFiniteNumber(raw.tierIndex);
  const itemIndex = asFiniteNumber(raw.itemIndex);
  const time = asFiniteNumber(raw.time);
  const style = sanitizePointPatch(raw.style);
  if (
    !id ||
    tierIndex === undefined ||
    itemIndex === undefined ||
    time === undefined ||
    !style
  ) {
    return null;
  }
  return {
    id,
    tierIndex: Math.trunc(tierIndex),
    tierName: asString(raw.tierName) ?? '',
    itemIndex: Math.trunc(itemIndex),
    time,
    markSnapshot: asString(raw.markSnapshot) ?? '',
    style
  };
}

function sanitizeLayoutPrefs(raw: unknown): LayoutPrefs | undefined {
  if (!isRecord(raw)) return undefined;
  const out: LayoutPrefs = {};
  if (raw.scaleMode === 'elastic' || raw.scaleMode === 'mixed' || raw.scaleMode === 'linear') {
    out.scaleMode = raw.scaleMode;
  }
  if (isRecord(raw.tierScaleOverrides)) {
    const cleanOverrides: Record<string, 'linear' | 'elastic'> = {};
    for (const [k, v] of Object.entries(raw.tierScaleOverrides)) {
      if (k && (v === 'linear' || v === 'elastic')) {
        cleanOverrides[k] = v;
      }
    }
    if (Object.keys(cleanOverrides).length > 0) {
      out.tierScaleOverrides = cleanOverrides;
    }
  }
  return out.scaleMode !== undefined || out.tierScaleOverrides !== undefined ? out : undefined;
}

export function getStyleSidecarPath(tgPath: string): string {
  const trimmed = tgPath.trim();
  if (!trimmed) return `untitled${STYLE_SIDECAR_EXT}`;
  if (trimmed.toLowerCase().endsWith(STYLE_SIDECAR_EXT)) return trimmed;

  const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot > lastSlash + 1) {
    return trimmed.slice(0, lastDot) + STYLE_SIDECAR_EXT;
  }
  return trimmed + STYLE_SIDECAR_EXT;
}

export function serializeStyleSidecar(doc: StyleDocument): string {
  const normalized: Record<string, unknown> = {
    schemaVersion: STYLE_SCHEMA_VERSION,
    paletteId: isPaletteId(doc.paletteId) ? doc.paletteId : DEFAULT_PALETTE_ID,
    bwPrintMode: Boolean(doc.bwPrintMode),
    showLegendInExport: Boolean(doc.showLegendInExport),
    swatchLabels: doc.swatchLabels ?? {},
    tierStyles: doc.tierStyles ?? {},
    rules: doc.rules ?? [],
    intervalOverrides: doc.intervalOverrides ?? [],
    boundaryOverrides: doc.boundaryOverrides ?? [],
    pointOverrides: doc.pointOverrides ?? []
  };
  if (doc.globalInterval && Object.keys(doc.globalInterval).length > 0) {
    normalized.globalInterval = doc.globalInterval;
  }
  if (doc.globalBoundary && Object.keys(doc.globalBoundary).length > 0) {
    normalized.globalBoundary = doc.globalBoundary;
  }
  if (doc.globalPoint && Object.keys(doc.globalPoint).length > 0) {
    normalized.globalPoint = doc.globalPoint;
  }
  if (
    doc.orphaned &&
    (doc.orphaned.intervals.length > 0 ||
      doc.orphaned.boundaries.length > 0 ||
      doc.orphaned.points.length > 0)
  ) {
    normalized.orphaned = doc.orphaned;
  }
  const cleanLayoutPrefs = sanitizeLayoutPrefs(doc.layoutPrefs);
  if (cleanLayoutPrefs) {
    normalized.layoutPrefs = cleanLayoutPrefs;
  }
  return JSON.stringify(normalized, null, 2);
}

export function parseStyleSidecar(raw: string | unknown): StyleDocument | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!isRecord(obj)) return null;

  const paletteId = isPaletteId(obj.paletteId) ? obj.paletteId : DEFAULT_PALETTE_ID;
  const bwPrintMode = typeof obj.bwPrintMode === 'boolean' ? obj.bwPrintMode : false;
  const showLegendInExport =
    typeof obj.showLegendInExport === 'boolean' ? obj.showLegendInExport : true;

  const swatchLabels: Record<string, string> = {};
  if (isRecord(obj.swatchLabels)) {
    for (const [k, v] of Object.entries(obj.swatchLabels)) {
      if (typeof v === 'string') swatchLabels[k] = v;
    }
  }

  const tierStyles: Record<string, TierStylePatch> = {};
  if (isRecord(obj.tierStyles)) {
    for (const [k, v] of Object.entries(obj.tierStyles)) {
      const cleaned = sanitizeTierPatch(v);
      if (cleaned) tierStyles[k] = cleaned;
    }
  }

  const rules: StyleRule[] = [];
  if (Array.isArray(obj.rules)) {
    for (const r of obj.rules) {
      const cleaned = sanitizeRule(r);
      if (cleaned) rules.push(cleaned);
    }
  }

  const intervalOverrides: IntervalStyleOverride[] = [];
  if (Array.isArray(obj.intervalOverrides)) {
    for (const o of obj.intervalOverrides) {
      const cleaned = sanitizeIntervalOverride(o);
      if (cleaned) intervalOverrides.push(cleaned);
    }
  }

  const boundaryOverrides: BoundaryStyleOverride[] = [];
  if (Array.isArray(obj.boundaryOverrides)) {
    for (const o of obj.boundaryOverrides) {
      const cleaned = sanitizeBoundaryOverride(o);
      if (cleaned) boundaryOverrides.push(cleaned);
    }
  }

  const pointOverrides: PointStyleOverride[] = [];
  if (Array.isArray(obj.pointOverrides)) {
    for (const o of obj.pointOverrides) {
      const cleaned = sanitizePointOverride(o);
      if (cleaned) pointOverrides.push(cleaned);
    }
  }

  const doc: StyleDocument = {
    schemaVersion: STYLE_SCHEMA_VERSION,
    paletteId,
    bwPrintMode,
    showLegendInExport,
    swatchLabels,
    tierStyles,
    rules,
    intervalOverrides,
    boundaryOverrides,
    pointOverrides
  };

  const globalInterval = sanitizeIntervalPatch(obj.globalInterval);
  if (globalInterval) doc.globalInterval = globalInterval;
  const globalBoundary = sanitizeBoundaryPatch(obj.globalBoundary);
  if (globalBoundary) doc.globalBoundary = globalBoundary;
  const globalPoint = sanitizePointPatch(obj.globalPoint);
  if (globalPoint) doc.globalPoint = globalPoint;

  if (isRecord(obj.orphaned)) {
    const orphIv = Array.isArray(obj.orphaned.intervals)
      ? obj.orphaned.intervals
          .map(sanitizeIntervalOverride)
          .filter((x): x is IntervalStyleOverride => x !== null)
      : [];
    const orphBd = Array.isArray(obj.orphaned.boundaries)
      ? obj.orphaned.boundaries
          .map(sanitizeBoundaryOverride)
          .filter((x): x is BoundaryStyleOverride => x !== null)
      : [];
    const orphPt = Array.isArray(obj.orphaned.points)
      ? obj.orphaned.points
          .map(sanitizePointOverride)
          .filter((x): x is PointStyleOverride => x !== null)
      : [];
    if (orphIv.length > 0 || orphBd.length > 0 || orphPt.length > 0) {
      doc.orphaned = { intervals: orphIv, boundaries: orphBd, points: orphPt };
    }
  }

  const layoutPrefs = sanitizeLayoutPrefs(obj.layoutPrefs);
  if (layoutPrefs) {
    doc.layoutPrefs = layoutPrefs;
  }

  return doc;
}

// ============================================================================
// W3C SVG <metadata> project embedding & extraction
// ============================================================================

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeXmlText(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g,
    (match, entity: string) => {
      switch (entity) {
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'amp':
          return '&';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default: {
          if (entity.startsWith('#x')) {
            const cp = parseInt(entity.slice(2), 16);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
          }
          if (entity.startsWith('#')) {
            const cp = parseInt(entity.slice(1), 10);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
          }
          return match;
        }
      }
    }
  );
}

function sanitizeTextGrid(raw: unknown): TextGrid | null {
  if (!isRecord(raw)) return null;
  const xmin = asFiniteNumber(raw.xmin);
  const xmax = asFiniteNumber(raw.xmax);
  if (xmin === undefined || xmax === undefined || !Array.isArray(raw.tiers)) {
    return null;
  }

  const tiers: Tier[] = [];
  for (const rawTier of raw.tiers) {
    if (!isRecord(rawTier)) return null;
    const kind = rawTier.kind;
    if (kind !== 'intervalTier' && kind !== 'textTier') return null;
    const tMin = asFiniteNumber(rawTier.xmin);
    const tMax = asFiniteNumber(rawTier.xmax);
    if (tMin === undefined || tMax === undefined) return null;

    const intervals: Interval[] = [];
    if (Array.isArray(rawTier.intervals)) {
      for (const rawIv of rawTier.intervals) {
        if (!isRecord(rawIv)) return null;
        const ivMin = asFiniteNumber(rawIv.xmin);
        const ivMax = asFiniteNumber(rawIv.xmax);
        if (ivMin === undefined || ivMax === undefined) return null;
        intervals.push({
          xmin: ivMin,
          xmax: ivMax,
          text: asString(rawIv.text) ?? ''
        });
      }
    }

    const points: TextPoint[] = [];
    if (Array.isArray(rawTier.points)) {
      for (const rawPt of rawTier.points) {
        if (!isRecord(rawPt)) return null;
        const num = asFiniteNumber(rawPt.number);
        if (num === undefined) return null;
        points.push({
          number: num,
          mark: asString(rawPt.mark) ?? ''
        });
      }
    }

    const tier: Tier = {
      kind,
      name: asString(rawTier.name) ?? '',
      xmin: tMin,
      xmax: tMax,
      intervals,
      points
    };
    const displayNum = asFiniteNumber(rawTier.displayNum);
    if (displayNum !== undefined) tier.displayNum = displayNum;
    tiers.push(tier);
  }

  return {
    name: asString(raw.name) ?? '',
    xmin,
    xmax,
    tiers
  };
}

export function buildSvgProjectMetadataXml(
  tg: TextGrid,
  styleDoc: StyleDocument,
  meta?: { filename?: string }
): string {
  const compactTg: TextGrid = {
    name: tg.name,
    xmin: tg.xmin,
    xmax: tg.xmax,
    tiers: tg.tiers.map((tier) => ({
      kind: tier.kind,
      name: tier.name,
      xmin: tier.xmin,
      xmax: tier.xmax,
      intervals:
        tier.kind === 'intervalTier'
          ? tier.intervals.map((iv) => ({ xmin: iv.xmin, xmax: iv.xmax, text: iv.text }))
          : [],
      points:
        tier.kind === 'textTier'
          ? tier.points.map((pt) => ({ number: pt.number, mark: pt.mark }))
          : [],
      ...(tier.displayNum !== undefined ? { displayNum: tier.displayNum } : {})
    }))
  };

  const payload: Record<string, unknown> = {
    version: STYLE_SCHEMA_VERSION,
    tg: compactTg,
    styleDoc: JSON.parse(serializeStyleSidecar(styleDoc))
  };
  if (meta?.filename) {
    payload.filename = meta.filename;
  }

  const encodedJson = escapeXmlText(JSON.stringify(payload));
  return (
    `<metadata>` +
    `<tgrid:project xmlns:tgrid="${TGRID_SVG_METADATA_NS}" version="${STYLE_SCHEMA_VERSION}">` +
    encodedJson +
    `</tgrid:project>` +
    `</metadata>`
  );
}

export function extractProjectFromSvgText(svgText: string): SvgProjectPayload | null {
  if (typeof svgText !== 'string' || svgText.length === 0) return null;

  // Match <tgrid:project ...>...</tgrid:project> or <project xmlns="https://tgrid.app/ns/project/1" ...>
  const tagRegex = /<(?:[a-zA-Z_][\w.-]*:)?project\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z_][\w.-]*:)?project>/i;
  const match = tagRegex.exec(svgText);
  if (!match) return null;

  const attrs = match[1] ?? '';
  const hasTgridNs =
    attrs.includes(TGRID_SVG_METADATA_NS) || /<tgrid:project\b/i.test(match[0]);
  if (!hasTgridNs) return null;

  let body = (match[2] ?? '').trim();
  if (!body) return null;

  const cdataMatch = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(body);
  if (cdataMatch) {
    body = cdataMatch[1].trim();
  } else {
    body = unescapeXmlText(body).trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const tg = sanitizeTextGrid(parsed.tg);
  const styleDoc = parseStyleSidecar(parsed.styleDoc);
  if (!tg || !styleDoc) return null;

  const result: SvgProjectPayload = { tg, styleDoc };
  if (typeof parsed.filename === 'string' && parsed.filename.length > 0) {
    result.filename = parsed.filename;
  }
  return result;
}
