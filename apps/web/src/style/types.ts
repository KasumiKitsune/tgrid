import type { TextGrid } from '../bridge/types.ts';

export const STYLE_SCHEMA_VERSION = 1 as const;

export type PaletteId =
  | 'warm-academic'
  | 'colorblind-safe'
  | 'presentation'
  | 'journal-bw';

export type PatternKind =
  | 'none'
  | 'hatch-diag'
  | 'hatch-back'
  | 'crosshatch'
  | 'dots'
  | 'stripes-v'
  | 'stripes-h';

export type LineDash = 'solid' | 'dashed' | 'dotted';

export type PointShape = 'circle' | 'diamond' | 'triangle' | 'square' | 'cross';

export type StyleRuleMatchKind = 'exact' | 'contains' | 'regex' | 'empty' | 'non-empty';

export interface SwatchSpec {
  id: string;
  name: string;
  fill: string;
  stroke: string;
  text: string;
  bwGray: string;
  bwPattern: PatternKind;
  bwStroke: string;
}

export interface PaletteSpec {
  id: PaletteId;
  name: string;
  description: string;
  swatches: readonly SwatchSpec[];
}

export interface IntervalStylePatch {
  swatchId?: string | null;
  fillColor?: string;
  fillOpacity?: number;
  pattern?: PatternKind;
  borderColor?: string;
  borderWidth?: number;
  borderDash?: LineDash;
  textColor?: string;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
}

export interface BoundaryStylePatch {
  swatchId?: string | null;
  strokeColor?: string;
  strokeWidth?: number;
  strokeDash?: LineDash;
  extendToAcoustic?: boolean;
}

export interface PointStylePatch {
  swatchId?: string | null;
  color?: string;
  shape?: PointShape;
  size?: number;
  stemColor?: string;
  stemDash?: LineDash;
  textColor?: string;
  fontWeight?: 'normal' | 'bold';
}

export interface TierStylePatch {
  labelBg?: string;
  labelColor?: string;
  intervalDefault?: IntervalStylePatch;
  boundaryDefault?: BoundaryStylePatch;
  pointDefault?: PointStylePatch;
}

export interface StyleRule {
  id: string;
  name: string;
  enabled: boolean;
  tierName?: string;
  matchKind: StyleRuleMatchKind;
  pattern: string;
  caseSensitive?: boolean;
  intervalStyle?: IntervalStylePatch;
  pointStyle?: PointStylePatch;
}

export interface IntervalStyleOverride {
  id: string;
  tierIndex: number;
  tierName: string;
  itemIndex: number;
  xmin: number;
  xmax: number;
  textSnapshot: string;
  style: IntervalStylePatch;
}

export interface BoundaryStyleOverride {
  id: string;
  tierIndex: number | null;
  tierName: string;
  time: number;
  style: BoundaryStylePatch;
}

export interface PointStyleOverride {
  id: string;
  tierIndex: number;
  tierName: string;
  itemIndex: number;
  time: number;
  markSnapshot: string;
  style: PointStylePatch;
}

export interface OrphanedStyleOverrides {
  intervals: IntervalStyleOverride[];
  boundaries: BoundaryStyleOverride[];
  points: PointStyleOverride[];
}

export interface StyleDocument {
  schemaVersion: typeof STYLE_SCHEMA_VERSION;
  paletteId: PaletteId;
  bwPrintMode: boolean;
  showLegendInExport: boolean;
  swatchLabels: Record<string, string>;
  globalInterval?: IntervalStylePatch;
  globalBoundary?: BoundaryStylePatch;
  globalPoint?: PointStylePatch;
  tierStyles: Record<string, TierStylePatch>;
  rules: StyleRule[];
  intervalOverrides: IntervalStyleOverride[];
  boundaryOverrides: BoundaryStyleOverride[];
  pointOverrides: PointStyleOverride[];
  orphaned?: OrphanedStyleOverrides;
}

export type StyleBrush =
  | { kind: 'interval'; patch: IntervalStylePatch; sticky: boolean }
  | { kind: 'boundary'; patch: BoundaryStylePatch; sticky: boolean }
  | { kind: 'point'; patch: PointStylePatch; sticky: boolean }
  | { kind: 'tier'; patch: TierStylePatch; sticky: boolean };

export interface ResolvedIntervalStyle {
  swatchId: string | null;
  fill: string;
  fillOpacity: number;
  pattern: PatternKind;
  patternColor: string;
  borderColor: string;
  borderWidth: number;
  borderDash: LineDash;
  textColor: string;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  hasCustom: boolean;
  hasCustomFill: boolean;
  hasCustomBorder: boolean;
  hasCustomText: boolean;
  matchedRuleId: string | null;
}

export interface ResolvedBoundaryStyle {
  swatchId: string | null;
  strokeColor: string;
  strokeWidth: number;
  strokeDash: LineDash;
  extendToAcoustic: boolean;
  hasCustom: boolean;
}

export interface ResolvedPointStyle {
  swatchId: string | null;
  color: string;
  shape: PointShape;
  size: number;
  stemColor: string;
  stemDash: LineDash;
  textColor: string;
  fontWeight: 'normal' | 'bold';
  hasCustom: boolean;
  matchedRuleId: string | null;
}

export interface ResolvedTierStyle {
  labelBg: string | null;
  labelColor: string | null;
  hasCustom: boolean;
}

export interface SvgPatternSpec {
  id: string;
  kind: Exclude<PatternKind, 'none'>;
  bgColor: string;
  fgColor: string;
  opacity: number;
}

export interface StyleLegendItem {
  id: string;
  label: string;
  source: 'rule' | 'swatch';
  kind: 'interval' | 'point';
  fill: string;
  fillOpacity: number;
  pattern: PatternKind;
  patternColor: string;
  borderColor: string;
  borderDash: LineDash;
  pointShape?: PointShape;
}

export interface ReconcileCategoryReport {
  exact: number;
  fuzzy: number;
  orphaned: number;
}

export interface ReconcileReport {
  exactMatches: number;
  fuzzyMatches: number;
  orphanedCount: number;
  recoveredFromOrphaned: number;
  details: {
    intervals: ReconcileCategoryReport;
    boundaries: ReconcileCategoryReport;
    points: ReconcileCategoryReport;
  };
}

export interface SvgProjectPayload {
  tg: TextGrid;
  styleDoc: StyleDocument;
  filename?: string;
}
