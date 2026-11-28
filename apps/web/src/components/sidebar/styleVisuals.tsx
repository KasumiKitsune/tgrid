import React, { useId } from 'react';
import type {
  LineDash,
  PaletteId,
  PatternKind,
  PointShape,
  SwatchSpec
} from '../../style/types';
import { UiIcon } from '../Icons';

// ============================================================================
// Shared Option Catalogs & Helpers
// ============================================================================

export const PATTERN_OPTIONS: ReadonlyArray<{
  kind: PatternKind;
  label: string;
  shortLabel: string;
}> = [
  { kind: 'none', label: '无底纹', shortLabel: '无' },
  { kind: 'hatch-back', label: '左斜线', shortLabel: '左斜' },
  { kind: 'hatch-diag', label: '右斜线', shortLabel: '右斜' },
  { kind: 'crosshatch', label: '交叉格', shortLabel: '交叉' },
  { kind: 'dots', label: '点阵', shortLabel: '点阵' },
  { kind: 'stripes-v', label: '竖条', shortLabel: '竖条' },
  { kind: 'stripes-h', label: '横条', shortLabel: '横条' }
];

export const POINT_SHAPE_OPTIONS: ReadonlyArray<{ shape: PointShape; label: string }> = [
  { shape: 'circle', label: '圆点' },
  { shape: 'diamond', label: '菱形' },
  { shape: 'triangle', label: '三角' },
  { shape: 'square', label: '方块' },
  { shape: 'cross', label: '十字' }
];

export const LINE_DASH_OPTIONS: ReadonlyArray<{ dash: LineDash; label: string }> = [
  { dash: 'solid', label: '实线' },
  { dash: 'dashed', label: '虚线' },
  { dash: 'dotted', label: '点线' }
];

export const NEUTRAL_ACADEMIC_COLORS: ReadonlyArray<{ hex: string; name: string }> = [
  { hex: '#FFFFFF', name: '纯白' },
  { hex: '#FAF9F6', name: '暖纸' },
  { hex: '#ECE9E1', name: '浅米灰' },
  { hex: '#D3CFC5', name: '暖灰线' },
  { hex: '#9CA3AF', name: '中浅灰' },
  { hex: '#52525B', name: '深炭灰' },
  { hex: '#27272A', name: '墨炭' },
  { hex: '#111827', name: '纯墨黑' }
];

export function parseHexColor(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const raw = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return `#${raw.toUpperCase()}`;
  }
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`.toUpperCase();
  }
  return null;
}

export function normalizeHexColor(
  color: string | null | undefined,
  fallback: string
): string {
  return parseHexColor(color) ?? fallback;
}

// ============================================================================
// Crisp Architectural Vector Icons & Micro Previews
// ============================================================================

export const StylePaletteIcon: React.FC<{ size?: number; className?: string }> = ({
  size = 16,
  className
}) => <UiIcon name="stylePalette" size={size} className={className} />;

export const FormatBrushIcon: React.FC<{ size?: number; className?: string }> = ({
  size = 13,
  className
}) => <UiIcon name="formatBrush" size={size} className={className} />;

export const LineDashMicroSvg: React.FC<{
  dash: LineDash;
  color?: string;
}> = ({ dash, color = 'currentColor' }) => {
  const dashArray =
    dash === 'dashed' ? '4.5 2.5' : dash === 'dotted' ? '1.6 2.2' : undefined;
  return (
    <svg width="24" height="8" viewBox="0 0 24 8" aria-hidden="true">
      <line
        x1="1"
        y1="4"
        x2="23"
        y2="4"
        stroke={color}
        strokeWidth="1.6"
        strokeDasharray={dashArray}
      />
    </svg>
  );
};

export const PatternMicroSvg: React.FC<{
  kind: PatternKind;
  bg?: string;
  fg?: string;
  className?: string;
}> = ({ kind, bg = '#FFFFFF', fg = '#141413', className }) => {
  const uid = useId().replace(/:/g, '');
  const patId = `sp-pat-${uid}`;
  return (
    <svg
      viewBox="0 0 32 16"
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
    >
      {kind !== 'none' && (
        <defs>
          {kind === 'hatch-diag' && (
            <pattern id={patId} width="6" height="6" patternUnits="userSpaceOnUse">
              <rect width="6" height="6" fill={bg} />
              <path
                d="M-1.5,1.5 l3,-3 M0,6 l6,-6 M4.5,7.5 l3,-3"
                stroke={fg}
                strokeWidth="0.95"
                strokeOpacity="0.72"
              />
            </pattern>
          )}
          {kind === 'hatch-back' && (
            <pattern id={patId} width="6" height="6" patternUnits="userSpaceOnUse">
              <rect width="6" height="6" fill={bg} />
              <path
                d="M-1.5,4.5 l3,3 M0,0 l6,6 M4.5,-1.5 l3,3"
                stroke={fg}
                strokeWidth="0.95"
                strokeOpacity="0.72"
              />
            </pattern>
          )}
          {kind === 'crosshatch' && (
            <pattern id={patId} width="6" height="6" patternUnits="userSpaceOnUse">
              <rect width="6" height="6" fill={bg} />
              <path
                d="M-1.5,1.5 l3,-3 M0,6 l6,-6 M4.5,7.5 l3,-3 M-1.5,4.5 l3,3 M0,0 l6,6 M4.5,-1.5 l3,3"
                stroke={fg}
                strokeWidth="0.8"
                strokeOpacity="0.65"
              />
            </pattern>
          )}
          {kind === 'dots' && (
            <pattern id={patId} width="6" height="6" patternUnits="userSpaceOnUse">
              <rect width="6" height="6" fill={bg} />
              <circle cx="1.6" cy="1.6" r="1.0" fill={fg} fillOpacity="0.72" />
              <circle cx="4.6" cy="4.6" r="1.0" fill={fg} fillOpacity="0.72" />
            </pattern>
          )}
          {kind === 'stripes-v' && (
            <pattern id={patId} width="5" height="5" patternUnits="userSpaceOnUse">
              <rect width="5" height="5" fill={bg} />
              <line
                x1="2.5"
                y1="0"
                x2="2.5"
                y2="5"
                stroke={fg}
                strokeWidth="0.95"
                strokeOpacity="0.72"
              />
            </pattern>
          )}
          {kind === 'stripes-h' && (
            <pattern id={patId} width="5" height="5" patternUnits="userSpaceOnUse">
              <rect width="5" height="5" fill={bg} />
              <line
                x1="0"
                y1="2.5"
                x2="5"
                y2="2.5"
                stroke={fg}
                strokeWidth="0.95"
                strokeOpacity="0.72"
              />
            </pattern>
          )}
        </defs>
      )}
      <rect
        x="0"
        y="0"
        width="32"
        height="16"
        fill={kind === 'none' ? bg : `url(#${patId})`}
      />
    </svg>
  );
};

export const PointShapeIcon: React.FC<{
  shape: PointShape;
  size?: number;
  color?: string;
}> = ({ shape, size = 14, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
    {shape === 'circle' && <circle cx="7" cy="7" r="3.6" fill={color} />}
    {shape === 'diamond' && <polygon points="7,2.4 11.6,7 7,11.6 2.4,7" fill={color} />}
    {shape === 'triangle' && <polygon points="7,2.5 11.8,10.8 2.2,10.8" fill={color} />}
    {shape === 'square' && <rect x="3.4" y="3.4" width="7.2" height="7.2" fill={color} />}
    {shape === 'cross' && (
      <path
        d="M7 2.5V11.5M2.5 7H11.5"
        stroke={color}
        strokeWidth="1.9"
        strokeLinecap="square"
      />
    )}
  </svg>
);

export const SwatchVisualFill: React.FC<{
  swatch: SwatchSpec;
  bwMode: boolean;
  paletteId: PaletteId;
  variant?: 'fill' | 'line';
}> = ({ swatch, bwMode, paletteId, variant = 'fill' }) => {
  const useBwPattern = bwMode || paletteId === 'journal-bw';
  if (variant === 'line') {
    const lineColor = bwMode ? swatch.bwStroke : swatch.stroke;
    const bgColor = bwMode ? '#F4F4F4' : '#FAF9F6';
    return (
      <div style={{ width: '100%', height: '100%', background: bgColor, position: 'relative' }}>
        <span className="sp-swatch-line-bar" style={{ background: lineColor }} />
      </div>
    );
  }
  if (useBwPattern) {
    return (
      <PatternMicroSvg kind={swatch.bwPattern} bg={swatch.bwGray} fg={swatch.bwStroke} />
    );
  }
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: swatch.fill,
        borderLeft: `3px solid ${swatch.stroke}`
      }}
    />
  );
};
