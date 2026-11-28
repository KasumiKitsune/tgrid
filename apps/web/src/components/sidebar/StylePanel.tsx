import React, { useMemo, useRef, useState } from 'react';
import {
  BUILTIN_STYLE_RULE_PRESETS,
  PALETTES,
  getPalette,
  hasAnyCustomStyle
} from '../../style/palettes';
import {
  TIME_MATCH_EPS,
  resolveBoundaryStyle,
  resolveIntervalStyle,
  resolvePointStyle,
  resolveTierStyle
} from '../../style/resolveStyle';
import type {
  BoundaryStylePatch,
  IntervalStylePatch,
  PatternKind,
  PointStylePatch,
  StyleDocument,
  StyleRule,
  StyleRuleMatchKind,
  TierStylePatch
} from '../../style/types';
import { useEditorStore } from '../../store/useEditorStore';
import { TGridIcon, UiIcon } from '../Icons';
import { CustomSelect, type CustomSelectOption } from '../CustomSelect';
import { ToggleSwitch } from '../ToggleSwitch';
import { StyleColorPicker } from './StyleColorPicker';
import {
  LINE_DASH_OPTIONS,
  LineDashMicroSvg,
  PATTERN_OPTIONS,
  POINT_SHAPE_OPTIONS,
  PatternMicroSvg,
  PointShapeIcon,
  SwatchVisualFill,
  normalizeHexColor
} from './styleVisuals';
import '../../styles/stylePanel.css';

// ============================================================================
// Constants & Helpers
// ============================================================================

const INTERVAL_BORDER_WIDTHS = [0.8, 1.2, 1.8, 2.4] as const;
const BOUNDARY_STROKE_WIDTHS = [1, 1.5, 2, 3] as const;
const POINT_SIZE_OPTIONS: ReadonlyArray<{ size: number; label: string }> = [
  { size: 3.5, label: '小' },
  { size: 5, label: '中' },
  { size: 6.5, label: '大' }
];

const RULE_MATCH_KINDS: ReadonlyArray<{ value: StyleRuleMatchKind; label: string }> = [
  { value: 'exact', label: '精确匹配' },
  { value: 'contains', label: '包含文本' },
  { value: 'regex', label: '正则表达式' },
  { value: 'empty', label: '空白区间' },
  { value: 'non-empty', label: '非空区间' }
];

const COMPACT_PRESETS: ReadonlyArray<{ id: string; label: string; swatchId: string }> = [
  { id: 'preset-silence', label: '静音标淡灰', swatchId: 's7' },
  { id: 'preset-vowels', label: '元音标暖杏', swatchId: 's1' },
  { id: 'preset-voiceless-stops', label: '清塞音标浅蓝', swatchId: 's2' },
  { id: 'preset-nasals', label: '鼻音标竹青', swatchId: 's3' }
];

function isValidRegexPattern(pattern: string): boolean {
  if (!pattern) return true;
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}

function resolveTierKeyForLookup(
  doc: StyleDocument,
  tierName: string,
  tierIndex: number
): TierStylePatch | null {
  return doc.tierStyles[tierName] ?? doc.tierStyles[`#${tierIndex}`] ?? null;
}

function extractIntervalOverrideOrResolvedPatch(
  doc: StyleDocument,
  tierIndex: number,
  itemIndex: number,
  resolved: ReturnType<typeof resolveIntervalStyle>
): IntervalStylePatch {
  const existing = doc.intervalOverrides.find(
    (o) => o.tierIndex === tierIndex && o.itemIndex === itemIndex
  );
  if (existing) return { ...existing.style };
  if (!resolved.hasCustom) return {};
  const patch: IntervalStylePatch = {};
  if (resolved.swatchId) {
    patch.swatchId = resolved.swatchId;
  } else if (resolved.hasCustomFill) {
    patch.fillColor = resolved.fill;
  }
  if (resolved.fillOpacity !== 1) patch.fillOpacity = resolved.fillOpacity;
  if (resolved.pattern !== 'none') patch.pattern = resolved.pattern;
  if (resolved.hasCustomBorder) {
    if (!resolved.swatchId) patch.borderColor = resolved.borderColor;
    if (resolved.borderWidth !== 1) patch.borderWidth = resolved.borderWidth;
    if (resolved.borderDash !== 'solid') patch.borderDash = resolved.borderDash;
  }
  if (resolved.hasCustomText) {
    if (!resolved.swatchId) patch.textColor = resolved.textColor;
    if (resolved.fontWeight !== 'normal') patch.fontWeight = resolved.fontWeight;
    if (resolved.fontStyle !== 'normal') patch.fontStyle = resolved.fontStyle;
  }
  return patch;
}

function extractBoundaryOverrideOrResolvedPatch(
  doc: StyleDocument,
  tierIndex: number | null,
  time: number,
  resolved: ReturnType<typeof resolveBoundaryStyle>
): BoundaryStylePatch {
  const existing = doc.boundaryOverrides.find(
    (o) => o.tierIndex === tierIndex && Math.abs(o.time - time) <= TIME_MATCH_EPS
  );
  if (existing) return { ...existing.style };
  if (!resolved.hasCustom) return {};
  const patch: BoundaryStylePatch = {};
  if (resolved.swatchId) {
    patch.swatchId = resolved.swatchId;
  } else {
    patch.strokeColor = resolved.strokeColor;
  }
  if (resolved.strokeWidth !== 1) patch.strokeWidth = resolved.strokeWidth;
  if (resolved.strokeDash !== 'solid') patch.strokeDash = resolved.strokeDash;
  if (resolved.extendToAcoustic) patch.extendToAcoustic = true;
  return patch;
}

function extractPointOverrideOrResolvedPatch(
  doc: StyleDocument,
  tierIndex: number,
  itemIndex: number,
  resolved: ReturnType<typeof resolvePointStyle>
): PointStylePatch {
  const existing = doc.pointOverrides.find(
    (o) => o.tierIndex === tierIndex && o.itemIndex === itemIndex
  );
  if (existing) return { ...existing.style };
  if (!resolved.hasCustom) return {};
  const patch: PointStylePatch = {};
  if (resolved.swatchId) {
    patch.swatchId = resolved.swatchId;
  } else {
    patch.color = resolved.color;
    patch.stemColor = resolved.stemColor;
    patch.textColor = resolved.textColor;
  }
  if (resolved.shape !== 'circle') patch.shape = resolved.shape;
  if (resolved.size !== 4) patch.size = resolved.size;
  if (resolved.stemDash !== 'solid') patch.stemDash = resolved.stemDash;
  if (resolved.fontWeight !== 'normal') patch.fontWeight = resolved.fontWeight;
  return patch;
}

// ============================================================================
// Flat Office-Style Accordion Section
// ============================================================================

interface AccordionProps {
  title: string;
  meta?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

const AccordionSection: React.FC<AccordionProps> = ({
  title,
  meta,
  open,
  onToggle,
  children
}) => (
  <section className={`sp-acc${open ? ' is-open' : ''}`}>
    <button
      type="button"
      className="sp-acc-head"
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="sp-acc-head-left">
        <TGridIcon name="section-chevron" size={12} className="sp-acc-chev" />
        <span>{title}</span>
      </span>
      {meta && <span className="sp-acc-meta">{meta}</span>}
    </button>
    <div className="sp-acc-collapse" aria-hidden={!open}>
      <div className="sp-acc-collapse-inner">
        <div className="sp-acc-body">{children}</div>
      </div>
    </div>
  </section>
);

// ============================================================================
// Main StylePanel Component
// ============================================================================

type StylePanelSubTab = 'object' | 'theme';

export const StylePanel: React.FC = () => {
  const tg = useEditorStore((s) => s.tg);
  const selection = useEditorStore((s) => s.selection);
  const multiSelection = useEditorStore((s) => s.multiSelection);
  const styleDoc = useEditorStore((s) => s.styleDoc);
  const styleBrush = useEditorStore((s) => s.styleBrush);
  const showToast = useEditorStore((s) => s.showToast);

  const setStylePalette = useEditorStore((s) => s.setStylePalette);
  const setStyleBwPrintMode = useEditorStore((s) => s.setStyleBwPrintMode);
  const setStyleShowLegend = useEditorStore((s) => s.setStyleShowLegend);
  const setStyleSwatchLabel = useEditorStore((s) => s.setStyleSwatchLabel);
  const setIntervalStyle = useEditorStore((s) => s.setIntervalStyle);
  const setMultiIntervalStyle = useEditorStore((s) => s.setMultiIntervalStyle);
  const setBoundaryStyle = useEditorStore((s) => s.setBoundaryStyle);
  const setPointStyle = useEditorStore((s) => s.setPointStyle);
  const setTierStyle = useEditorStore((s) => s.setTierStyle);
  const applyStyleToSameText = useEditorStore((s) => s.applyStyleToSameText);
  const clearSelectionStyle = useEditorStore((s) => s.clearSelectionStyle);
  const clearAllDocumentStyles = useEditorStore((s) => s.clearAllDocumentStyles);
  const upsertStyleRule = useEditorStore((s) => s.upsertStyleRule);
  const removeStyleRule = useEditorStore((s) => s.removeStyleRule);
  const toggleStyleRule = useEditorStore((s) => s.toggleStyleRule);
  const applyStyleRulePreset = useEditorStore((s) => s.applyStyleRulePreset);
  const clearOrphanedStyles = useEditorStore((s) => s.clearOrphanedStyles);
  const setStyleBrush = useEditorStore((s) => s.setStyleBrush);
  const clearStyleBrush = useEditorStore((s) => s.clearStyleBrush);

  const [activeTab, setActiveTab] = useState<StylePanelSubTab>('object');

  // Accordion open states (Interval: Fill open, Border & Text collapsed by default)
  const [accOpen, setAccOpen] = useState<Record<string, boolean>>({
    'iv-fill': true,
    'iv-border': false,
    'iv-text': false,
    'bd-line': true,
    'bd-extend': true,
    'pt-marker': true,
    'pt-stem': true,
    'tier-label': true,
    'tier-default': true,
    'theme-palette': true,
    'theme-export': true,
    'theme-rules': true
  });

  const [swatchLabelsOpen, setSwatchLabelsOpen] = useState(false);
  const [expandedRuleIds, setExpandedRuleIds] = useState<Record<string, boolean>>({});
  const ruleSeqRef = useRef(0);

  const toggleAcc = (key: string) => {
    setAccOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleRuleExpanded = (ruleId: string) => {
    setExpandedRuleIds((prev) => ({ ...prev, [ruleId]: !prev[ruleId] }));
  };

  const palette = useMemo(() => getPalette(styleDoc.paletteId), [styleDoc.paletteId]);
  const hasAnyStyle = useMemo(() => hasAnyCustomStyle(styleDoc), [styleDoc]);

  const orphanedCount = useMemo(() => {
    const o = styleDoc.orphaned;
    if (!o) return 0;
    return o.intervals.length + o.boundaries.length + o.points.length;
  }, [styleDoc.orphaned]);

  const isMultiMode = multiSelection.length >= 2;
  const activeKind: 'multi' | 'interval' | 'boundary' | 'spine' | 'point' | 'tier' | 'none' =
    isMultiMode
      ? 'multi'
      : selection?.kind === 'interval'
        ? 'interval'
        : selection?.kind === 'boundary'
          ? 'boundary'
          : selection?.kind === 'spine'
            ? 'spine'
            : selection?.kind === 'point'
              ? 'point'
              : selection?.kind === 'tier'
                ? 'tier'
                : 'none';

  // --- Format Painter Helpers ---
  const handleBrushClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    createBrush: (sticky: boolean) => Parameters<typeof setStyleBrush>[0]
  ) => {
    if (e.detail >= 2) return;
    if (styleBrush) {
      clearStyleBrush();
      return;
    }
    const next = createBrush(false);
    if (next) {
      setStyleBrush(next);
      showToast('已吸取样式：单击画布同类对象即可刷入（双击格式刷可连续刷）');
    }
  };

  const handleBrushDoubleClick = (
    createBrush: (sticky: boolean) => Parameters<typeof setStyleBrush>[0]
  ) => {
    const next = createBrush(true);
    if (next) {
      setStyleBrush(next);
      showToast('已锁定连续格式刷：可连续点击多个对象，按 Esc 或再次点击退出');
    }
  };

  // ============================================================================
  // Shared Context Strip Builder
  // ============================================================================
  const renderContextBar = (opts: {
    kindClass: string;
    label: string;
    status?: string;
    isBrushActive: boolean;
    isBrushSticky: boolean;
    canReset: boolean;
    brushTitle: string;
    onBrushClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    onBrushDoubleClick: () => void;
    onReset: () => void;
  }) => (
    <div className="sp-ctx-bar">
      <div className="sp-ctx-info">
        <span className={`sp-ctx-dot ${opts.kindClass}`} aria-hidden="true" />
        <span className="sp-ctx-text" title={opts.label}>
          {opts.label}
        </span>
        {opts.status && <span className="sp-ctx-status">{opts.status}</span>}
      </div>
      <div className="sp-ctx-actions">
        <button
          type="button"
          className={`sp-ctx-icon-btn${
            opts.isBrushSticky
              ? ' is-brush-sticky'
              : opts.isBrushActive
                ? ' is-brush-active'
                : ''
          }`}
          aria-pressed={opts.isBrushActive}
          aria-label="格式刷"
          title={opts.brushTitle}
          onClick={opts.onBrushClick}
          onDoubleClick={opts.onBrushDoubleClick}
        >
          <UiIcon name="formatBrush" size={13} />
        </button>
        <button
          type="button"
          className="sp-ctx-icon-btn"
          disabled={!opts.canReset}
          aria-label="重置此项样式"
          title={opts.canReset ? '重置当前对象的自定义样式' : '当前对象为默认样式'}
          onClick={opts.onReset}
        >
          <UiIcon name="clear" size={13} />
        </button>
      </div>
    </div>
  );

  // ============================================================================
  // Tab 1: Object Style Content
  // ============================================================================
  const renderObjectTab = () => {
    if (activeKind === 'none') {
      return (
        <div className="sp-empty-state">
          <div className="sp-empty-icon" aria-hidden="true">
            <UiIcon name="stylePalette" size={18} />
          </div>
          <div className="sp-empty-title">未选中画布对象</div>
          <div className="sp-empty-desc">
            在画布点选区间、边界、标点或层级，即可在此精细调整填充、线条、底纹与文字外观。
          </div>
          <button
            type="button"
            className="sp-action-btn"
            style={{ maxWidth: 204, marginTop: 4 }}
            onClick={() => setActiveTab('theme')}
          >
            <span>主题与自动着色规则</span>
          </button>
        </div>
      );
    }

    // 1. INTERVAL or MULTI-INTERVAL
    if (activeKind === 'interval' || activeKind === 'multi') {
      const isMulti = activeKind === 'multi';
      const primaryRef = isMulti
        ? selection?.kind === 'interval'
          ? { tierIndex: selection.tierIndex, itemIndex: selection.itemIndex }
          : multiSelection[0]
        : selection?.kind === 'interval'
          ? { tierIndex: selection.tierIndex, itemIndex: selection.itemIndex }
          : null;

      if (!primaryRef) return null;
      const tier = tg.tiers[primaryRef.tierIndex];
      const iv = tier?.kind === 'intervalTier' ? tier.intervals[primaryRef.itemIndex] : null;
      if (!tier || !iv) return null;

      const resolved = resolveIntervalStyle(
        styleDoc,
        tg,
        primaryRef.tierIndex,
        primaryRef.itemIndex
      );
      const existingOverride = styleDoc.intervalOverrides.find(
        (o) => o.tierIndex === primaryRef.tierIndex && o.itemIndex === primaryRef.itemIndex
      );

      const applyPatch = (patch: IntervalStylePatch, opts?: { coalesce?: boolean }) => {
        if (isMulti) {
          setMultiIntervalStyle(multiSelection, patch, opts);
        } else {
          setIntervalStyle(primaryRef.tierIndex, primaryRef.itemIndex, patch, opts);
        }
      };

      const fillHex = normalizeHexColor(resolved.fill, '#FFFFFF');
      const borderHex = normalizeHexColor(resolved.borderColor, '#2A2926');
      const textHex = normalizeHexColor(resolved.textColor, '#141413');
      const opacityPct = Math.round(resolved.fillOpacity * 100);
      const isBrushActive = styleBrush?.kind === 'interval';
      const isBrushSticky = Boolean(isBrushActive && styleBrush?.sticky);
      const canApplySameText = !isMulti && iv.text.trim().length > 0;

      const tierName = tier.name || `层 ${primaryRef.tierIndex + 1}`;
      const ivQuote = iv.text.trim() ? `「${iv.text.trim()}」` : '（空）';
      const ctxLabel = isMulti
        ? `多选 · ${multiSelection.length} 个区间`
        : `区间 · ${tierName} #${primaryRef.itemIndex + 1}${ivQuote}`;

      const ctxStatus =
        !isMulti && resolved.matchedRuleId && !existingOverride
          ? '规则命中'
          : undefined;

      const activeSwatchObj = resolved.swatchId
        ? palette.swatches.find((s) => s.id === resolved.swatchId) ?? null
        : null;
      const fillSummary = activeSwatchObj
        ? `${styleDoc.swatchLabels[activeSwatchObj.id]?.trim() || activeSwatchObj.name} · ${opacityPct}%`
        : resolved.hasCustomFill
          ? `${fillHex} · ${opacityPct}%`
          : undefined;

      const dashLabel =
        LINE_DASH_OPTIONS.find((d) => d.dash === resolved.borderDash)?.label ?? '实线';
      const borderSummary = resolved.hasCustomBorder
        ? `${dashLabel} ${resolved.borderWidth}px`
        : undefined;

      const buildIntervalBrush = (sticky: boolean) => ({
        kind: 'interval' as const,
        patch: extractIntervalOverrideOrResolvedPatch(
          styleDoc,
          primaryRef.tierIndex,
          primaryRef.itemIndex,
          resolved
        ),
        sticky
      });

      return (
        <>
          {renderContextBar({
            kindClass: isMulti ? 'kind-multi' : 'kind-interval',
            label: ctxLabel,
            status: ctxStatus,
            isBrushActive,
            isBrushSticky,
            canReset: resolved.hasCustom,
            brushTitle: '格式刷：单击吸取并刷入下一个区间，双击锁定连续刷',
            onBrushClick: (e) => handleBrushClick(e, buildIntervalBrush),
            onBrushDoubleClick: () => handleBrushDoubleClick(buildIntervalBrush),
            onReset: () => clearSelectionStyle()
          })}

          <div className="sp-scroll-content">
            {/* 1. Fill & Pattern */}
            <AccordionSection
              title="填充与底纹"
              meta={fillSummary}
              open={Boolean(accOpen['iv-fill'])}
              onToggle={() => toggleAcc('iv-fill')}
            >
              {/* 8 Academic Swatch Chips */}
              <div className="sp-field-block">
                <div className="sp-field-head">
                  <span className="sp-field-label">学术色槽</span>
                  <button
                    type="button"
                    className="sp-link-action"
                    disabled={!resolved.hasCustom}
                    onClick={() => clearSelectionStyle()}
                  >
                    还原默认
                  </button>
                </div>
                <div className="sp-swatch-grid">
                  {palette.swatches.map((sw) => {
                    const isSelected = resolved.swatchId === sw.id;
                    const customLbl = styleDoc.swatchLabels[sw.id]?.trim();
                    const titleText = customLbl ? `${sw.name} · ${customLbl}` : sw.name;
                    return (
                      <button
                        key={sw.id}
                        type="button"
                        className={`sp-swatch-chip${isSelected ? ' is-active' : ''}`}
                        title={titleText}
                        aria-pressed={isSelected}
                        onClick={() =>
                          applyPatch({
                            swatchId: sw.id,
                            fillColor: undefined,
                            borderColor: undefined,
                            textColor: undefined
                          })
                        }
                      >
                        <div className="sp-swatch-preview">
                          <SwatchVisualFill
                            swatch={sw}
                            bwMode={styleDoc.bwPrintMode}
                            paletteId={styleDoc.paletteId}
                          />
                          {isSelected && <span className="sp-swatch-dot-mark" aria-hidden="true" />}
                        </div>
                        <span className="sp-swatch-name">{customLbl || sw.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Fill Color */}
              <div className="sp-form-row">
                <span className="sp-form-lbl">填充颜色</span>
                <div className="sp-form-ctrl">
                  <StyleColorPicker
                    value={resolved.hasCustomFill || resolved.swatchId ? fillHex : null}
                    isDefault={!resolved.hasCustomFill && !resolved.swatchId}
                    palette={palette}
                    bwPrintMode={styleDoc.bwPrintMode}
                    swatchLabels={styleDoc.swatchLabels}
                    colorRole="fill"
                    activeSwatchId={existingOverride?.style.fillColor ? null : resolved.swatchId}
                    ariaLabel="选择区间填充颜色"
                    onSelectHex={(hex) => applyPatch({ fillColor: hex })}
                    onReset={() =>
                      applyPatch({
                        swatchId: null,
                        fillColor: undefined
                      })
                    }
                  />
                </div>
              </div>

              {/* Opacity */}
              <div className="sp-form-row">
                <span className="sp-form-lbl">透明度</span>
                <div className="sp-range-wrap">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={opacityPct}
                    className="sp-range-slider"
                    style={{ '--sp-range-pct': `${opacityPct}%` } as React.CSSProperties}
                    aria-label="填充透明度"
                    title={`填充透明度 ${opacityPct}%`}
                    onChange={(e) =>
                      applyPatch(
                        { fillOpacity: Number(e.target.value) / 100 },
                        { coalesce: true }
                      )
                    }
                  />
                  <span className="sp-range-val">{opacityPct}%</span>
                </div>
              </div>

              {/* Vector Pattern */}
              <div className="sp-field-block">
                <span className="sp-field-label">矢量底纹</span>
                <div className="sp-pattern-grid" role="radiogroup" aria-label="矢量底纹">
                  {PATTERN_OPTIONS.map((opt) => {
                    const active = resolved.pattern === opt.kind;
                    return (
                      <button
                        key={opt.kind}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`sp-pattern-btn${active ? ' is-active' : ''}`}
                        title={opt.label}
                        onClick={() => applyPatch({ pattern: opt.kind })}
                      >
                        <div className="sp-pattern-preview">
                          <PatternMicroSvg
                            kind={opt.kind}
                            bg={styleDoc.bwPrintMode ? '#F2F2F2' : fillHex}
                            fg={styleDoc.bwPrintMode ? '#1A1A1A' : borderHex}
                          />
                        </div>
                        <span className="sp-pattern-label">{opt.shortLabel}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </AccordionSection>

            {/* 2. Border & Line */}
            <AccordionSection
              title="边框与线条"
              meta={borderSummary}
              open={Boolean(accOpen['iv-border'])}
              onToggle={() => toggleAcc('iv-border')}
            >
              <div className="sp-form-row">
                <span className="sp-form-lbl">边框颜色</span>
                <div className="sp-form-ctrl">
                  <StyleColorPicker
                    value={resolved.hasCustomBorder || resolved.swatchId ? borderHex : null}
                    isDefault={!resolved.hasCustomBorder && !resolved.swatchId}
                    palette={palette}
                    bwPrintMode={styleDoc.bwPrintMode}
                    swatchLabels={styleDoc.swatchLabels}
                    colorRole="stroke"
                    activeSwatchId={existingOverride?.style.borderColor ? null : resolved.swatchId}
                    ariaLabel="选择区间边框颜色"
                    onSelectHex={(hex) => applyPatch({ borderColor: hex })}
                    onReset={() => applyPatch({ borderColor: undefined })}
                  />
                </div>
              </div>

              <div className="sp-form-row">
                <span className="sp-form-lbl">线宽</span>
                <div className="sp-seg" role="group" aria-label="边框线宽">
                  {INTERVAL_BORDER_WIDTHS.map((w) => (
                    <button
                      key={w}
                      type="button"
                      className={`sp-seg-btn${
                        Math.abs(resolved.borderWidth - w) < 0.05 ? ' is-active' : ''
                      }`}
                      onClick={() => applyPatch({ borderWidth: w })}
                    >
                      {w}
                    </button>
                  ))}
                </div>
              </div>

              <div className="sp-form-row">
                <span className="sp-form-lbl">线型</span>
                <div className="sp-seg" role="group" aria-label="边框线型">
                  {LINE_DASH_OPTIONS.map((opt) => (
                    <button
                      key={opt.dash}
                      type="button"
                      className={`sp-seg-btn is-dash-btn${
                        resolved.borderDash === opt.dash ? ' is-active' : ''
                      }`}
                      onClick={() => applyPatch({ borderDash: opt.dash })}
                    >
                      <LineDashMicroSvg dash={opt.dash} />
                      <span className="sp-dash-lbl">{opt.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </AccordionSection>

            {/* 3. Text & Batch */}
            <AccordionSection
              title="文字与批量"
              meta={
                resolved.fontWeight === 'bold' || resolved.fontStyle === 'italic'
                  ? [
                      resolved.fontWeight === 'bold' ? '加粗' : '',
                      resolved.fontStyle === 'italic' ? '斜体' : ''
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : undefined
              }
              open={Boolean(accOpen['iv-text'])}
              onToggle={() => toggleAcc('iv-text')}
            >
              <div className="sp-form-row">
                <span className="sp-form-lbl">文字颜色</span>
                <div className="sp-form-ctrl">
                  <StyleColorPicker
                    value={resolved.hasCustomText || resolved.swatchId ? textHex : null}
                    isDefault={!resolved.hasCustomText && !resolved.swatchId}
                    palette={palette}
                    bwPrintMode={styleDoc.bwPrintMode}
                    swatchLabels={styleDoc.swatchLabels}
                    colorRole="text"
                    activeSwatchId={existingOverride?.style.textColor ? null : resolved.swatchId}
                    ariaLabel="选择区间文字颜色"
                    onSelectHex={(hex) => applyPatch({ textColor: hex })}
                    onReset={() => applyPatch({ textColor: undefined })}
                  />
                </div>
              </div>

              <div className="sp-form-row">
                <span className="sp-form-lbl">字形</span>
                <div className="sp-fmt-group">
                  <button
                    type="button"
                    className={`sp-fmt-btn${resolved.fontWeight === 'bold' ? ' is-active' : ''}`}
                    aria-pressed={resolved.fontWeight === 'bold'}
                    onClick={() =>
                      applyPatch({
                        fontWeight: resolved.fontWeight === 'bold' ? 'normal' : 'bold'
                      })
                    }
                  >
                    <span style={{ fontWeight: 700 }}>B</span>
                    <span>加粗</span>
                  </button>
                  <button
                    type="button"
                    className={`sp-fmt-btn${resolved.fontStyle === 'italic' ? ' is-active' : ''}`}
                    aria-pressed={resolved.fontStyle === 'italic'}
                    onClick={() =>
                      applyPatch({
                        fontStyle: resolved.fontStyle === 'italic' ? 'normal' : 'italic'
                      })
                    }
                  >
                    <span style={{ fontStyle: 'italic', fontFamily: 'Georgia, serif' }}>I</span>
                    <span>斜体</span>
                  </button>
                </div>
              </div>

              {!isMulti && (
                <>
                  <div className="sp-hairline" />
                  <button
                    type="button"
                    className="sp-action-btn"
                    disabled={!canApplySameText}
                    title={
                      canApplySameText
                        ? `将当前区间的外观套用到本层所有文本为「${iv.text}」的区间`
                        : '当前区间文本为空，无法按同名批量套用'
                    }
                    onClick={() => {
                      if (!canApplySameText) return;
                      const patch = extractIntervalOverrideOrResolvedPatch(
                        styleDoc,
                        primaryRef.tierIndex,
                        primaryRef.itemIndex,
                        resolved
                      );
                      const count = applyStyleToSameText(primaryRef.tierIndex, iv.text, patch);
                      showToast(`已将样式套用到本层 ${count} 个「${iv.text}」区间`);
                    }}
                  >
                    <span>应用到本层所有同名区间</span>
                  </button>
                </>
              )}
            </AccordionSection>
          </div>
        </>
      );
    }

    // 2. BOUNDARY / SPINE
    if (
      (activeKind === 'boundary' || activeKind === 'spine') &&
      selection &&
      (selection.kind === 'boundary' || selection.kind === 'spine')
    ) {
      const isBoundary = selection.kind === 'boundary';
      const targetTierIndex = isBoundary ? selection.tierIndex : null;
      const bTime = selection.time;
      const resolved = resolveBoundaryStyle(
        styleDoc,
        tg,
        isBoundary ? selection.tierIndex : -1,
        bTime
      );
      const existingOverride = styleDoc.boundaryOverrides.find(
        (o) => o.tierIndex === targetTierIndex && Math.abs(o.time - bTime) <= TIME_MATCH_EPS
      );
      const strokeHex = normalizeHexColor(resolved.strokeColor, '#52504A');
      const isBrushActive = styleBrush?.kind === 'boundary';
      const isBrushSticky = Boolean(isBrushActive && styleBrush?.sticky);

      const applyPatch = (patch: BoundaryStylePatch, opts?: { coalesce?: boolean }) => {
        setBoundaryStyle(targetTierIndex, bTime, patch, opts);
      };

      const buildBoundaryBrush = (sticky: boolean) => ({
        kind: 'boundary' as const,
        patch: extractBoundaryOverrideOrResolvedPatch(
          styleDoc,
          targetTierIndex,
          bTime,
          resolved
        ),
        sticky
      });

      const tierName = isBoundary
        ? tg.tiers[selection.tierIndex]?.name || `层 ${selection.tierIndex + 1}`
        : '';
      const ctxLabel = isBoundary
        ? `边界 · ${tierName} · ${bTime.toFixed(3)} s`
        : `对齐时刻 · ${bTime.toFixed(3)} s`;

      return (
        <>
          {renderContextBar({
            kindClass: isBoundary ? 'kind-boundary' : 'kind-spine',
            label: ctxLabel,
            status: resolved.extendToAcoustic ? '贯穿声学区' : undefined,
            isBrushActive,
            isBrushSticky,
            canReset: resolved.hasCustom,
            brushTitle: '格式刷：单击吸取当前边界样式刷入另一条边界，双击锁定连续刷',
            onBrushClick: (e) => handleBrushClick(e, buildBoundaryBrush),
            onBrushDoubleClick: () => handleBrushDoubleClick(buildBoundaryBrush),
            onReset: () => clearSelectionStyle()
          })}

          <div className="sp-scroll-content">
            <AccordionSection
              title="线条样式"
              open={Boolean(accOpen['bd-line'])}
              onToggle={() => toggleAcc('bd-line')}
            >
              <div className="sp-form-row">
                <span className="sp-form-lbl">线条颜色</span>
                <div className="sp-form-ctrl">
                  <StyleColorPicker
                    value={resolved.hasCustom ? strokeHex : null}
                    isDefault={!resolved.hasCustom}
                    palette={palette}
                    bwPrintMode={styleDoc.bwPrintMode}
                    swatchLabels={styleDoc.swatchLabels}
                    colorRole="stroke"
                    activeSwatchId={existingOverride?.style.strokeColor ? null : resolved.swatchId}
                    ariaLabel="选择边界线条颜色"
                    onSelectSwatch={(sw) =>
                      applyPatch({ swatchId: sw.id, strokeColor: undefined })
                    }
                    onSelectHex={(hex) => applyPatch({ strokeColor: hex })}
                    onReset={() => applyPatch({ swatchId: null, strokeColor: undefined })}
                  />
                </div>
              </div>

              <div className="sp-form-row">
                <span className="sp-form-lbl">线宽</span>
                <div className="sp-seg" role="group" aria-label="边界线宽">
                  {BOUNDARY_STROKE_WIDTHS.map((w) => (
                    <button
                      key={w}
                      type="button"
                      className={`sp-seg-btn${
                        Math.abs(resolved.strokeWidth - w) < 0.05 ? ' is-active' : ''
                      }`}
                      onClick={() => applyPatch({ strokeWidth: w })}
                    >
                      {w}
                    </button>
                  ))}
                </div>
              </div>

              <div className="sp-form-row">
                <span className="sp-form-lbl">线型</span>
                <div className="sp-seg" role="group" aria-label="边界线型">
                  {LINE_DASH_OPTIONS.map((opt) => (
                    <button
                      key={opt.dash}
                      type="button"
                      className={`sp-seg-btn is-dash-btn${
                        resolved.strokeDash === opt.dash ? ' is-active' : ''
                      }`}
                      onClick={() => applyPatch({ strokeDash: opt.dash })}
                    >
                      <LineDashMicroSvg dash={opt.dash} />
                      <span className="sp-dash-lbl">{opt.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </AccordionSection>

            <AccordionSection
              title="声学区贯穿"
              open={Boolean(accOpen['bd-extend'])}
              onToggle={() => toggleAcc('bd-extend')}
            >
              <ToggleSwitch
                label="向上贯穿至波形与语谱图"
                checked={resolved.extendToAcoustic}
                onChange={(next) => applyPatch({ extendToAcoustic: next })}
              />
              <div className="sp-hint-note">
                在波形与语谱图区绘制垂直对齐参考线，便于论文声学对照。
              </div>
            </AccordionSection>
          </div>
        </>
      );
    }

    // 3. POINT
    if (activeKind === 'point' && selection?.kind === 'point') {
      const ti = selection.tierIndex;
      const pi = selection.itemIndex;
      const tier = tg.tiers[ti];
      const pt = tier?.kind === 'textTier' ? tier.points[pi] : null;
      if (!tier || !pt) return null;

      const resolved = resolvePointStyle(styleDoc, tg, ti, pi);
      const existingOverride = styleDoc.pointOverrides.find(
        (o) => o.tierIndex === ti && o.itemIndex === pi
      );
      const colorHex = normalizeHexColor(resolved.color, '#1E3A5F');
      const textHex = normalizeHexColor(resolved.textColor, '#141413');
      const isBrushActive = styleBrush?.kind === 'point';
      const isBrushSticky = Boolean(isBrushActive && styleBrush?.sticky);

      const applyPatch = (patch: PointStylePatch, opts?: { coalesce?: boolean }) => {
        setPointStyle(ti, pi, patch, opts);
      };

      const buildPointBrush = (sticky: boolean) => ({
        kind: 'point' as const,
        patch: extractPointOverrideOrResolvedPatch(styleDoc, ti, pi, resolved),
        sticky
      });

      const tierName = tier.name || `层 ${ti + 1}`;
      const ptQuote = pt.mark.trim() ? `「${pt.mark.trim()}」` : '';
      const ctxLabel = `标点 · ${tierName} #${pi + 1}${ptQuote}`;

      return (
        <>
          {renderContextBar({
            kindClass: 'kind-point',
            label: ctxLabel,
            isBrushActive,
            isBrushSticky,
            canReset: resolved.hasCustom,
            brushTitle: '格式刷：单击吸取当前标点样式刷入另一个标点，双击锁定连续刷',
            onBrushClick: (e) => handleBrushClick(e, buildPointBrush),
            onBrushDoubleClick: () => handleBrushDoubleClick(buildPointBrush),
            onReset: () => clearSelectionStyle()
          })}

          <div className="sp-scroll-content">
            <AccordionSection
              title="标记外观"
              open={Boolean(accOpen['pt-marker'])}
              onToggle={() => toggleAcc('pt-marker')}
            >
              <div className="sp-field-block">
                <span className="sp-field-label">标点形状</span>
                <div className="sp-shape-grid" role="radiogroup" aria-label="标点形状">
                  {POINT_SHAPE_OPTIONS.map((opt) => {
                    const active = resolved.shape === opt.shape;
                    return (
                      <button
                        key={opt.shape}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`sp-shape-btn${active ? ' is-active' : ''}`}
                        onClick={() => applyPatch({ shape: opt.shape })}
                      >
                        <PointShapeIcon
                          shape={opt.shape}
                          size={14}
                          color={active ? 'var(--accent-blue)' : colorHex}
                        />
                        <span className="sp-shape-label">{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="sp-form-row">
                <span className="sp-form-lbl">标记颜色</span>
                <div className="sp-form-ctrl">
                  <StyleColorPicker
                    value={resolved.hasCustom ? colorHex : null}
                    isDefault={!resolved.hasCustom}
                    palette={palette}
                    bwPrintMode={styleDoc.bwPrintMode}
                    swatchLabels={styleDoc.swatchLabels}
                    colorRole="stroke"
                    activeSwatchId={existingOverride?.style.color ? null : resolved.swatchId}
                    ariaLabel="选择标点标记颜色"
                    onSelectSwatch={(sw) =>
                      applyPatch({
                        swatchId: sw.id,
                        color: undefined,
                        stemColor: undefined,
                        textColor: undefined
                      })
                    }
                    onSelectHex={(hex) => applyPatch({ color: hex, stemColor: hex })}
                    onReset={() =>
                      applyPatch({
                        swatchId: null,
                        color: undefined,
                        stemColor: undefined
                      })
                    }
                  />
                </div>
              </div>

              <div className="sp-form-row">
                <span className="sp-form-lbl">标记大小</span>
                <div className="sp-seg" role="group" aria-label="标记大小">
                  {POINT_SIZE_OPTIONS.map((opt) => {
                    const active = Math.abs(resolved.size - opt.size) < 0.75;
                    return (
                      <button
                        key={opt.size}
                        type="button"
                        className={`sp-seg-btn${active ? ' is-active' : ''}`}
                        onClick={() => applyPatch({ size: opt.size })}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </AccordionSection>

            <AccordionSection
              title="引线与文字"
              open={Boolean(accOpen['pt-stem'])}
              onToggle={() => toggleAcc('pt-stem')}
            >
              <div className="sp-form-row">
                <span className="sp-form-lbl">引线线型</span>
                <div className="sp-seg" role="group" aria-label="引线线型">
                  {LINE_DASH_OPTIONS.map((opt) => (
                    <button
                      key={opt.dash}
                      type="button"
                      className={`sp-seg-btn is-dash-btn${
                        resolved.stemDash === opt.dash ? ' is-active' : ''
                      }`}
                      onClick={() => applyPatch({ stemDash: opt.dash })}
                    >
                      <LineDashMicroSvg dash={opt.dash} />
                      <span className="sp-dash-lbl">{opt.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="sp-form-row">
                <span className="sp-form-lbl">文字颜色</span>
                <div className="sp-form-ctrl">
                  <StyleColorPicker
                    value={resolved.hasCustom ? textHex : null}
                    isDefault={!resolved.hasCustom}
                    palette={palette}
                    bwPrintMode={styleDoc.bwPrintMode}
                    swatchLabels={styleDoc.swatchLabels}
                    colorRole="text"
                    activeSwatchId={existingOverride?.style.textColor ? null : resolved.swatchId}
                    ariaLabel="选择标点文字颜色"
                    onSelectHex={(hex) => applyPatch({ textColor: hex })}
                    onReset={() => applyPatch({ textColor: undefined })}
                  />
                </div>
              </div>

              <div className="sp-form-row">
                <span className="sp-form-lbl">字形</span>
                <div className="sp-fmt-group">
                  <button
                    type="button"
                    className={`sp-fmt-btn${resolved.fontWeight === 'bold' ? ' is-active' : ''}`}
                    aria-pressed={resolved.fontWeight === 'bold'}
                    onClick={() =>
                      applyPatch({
                        fontWeight: resolved.fontWeight === 'bold' ? 'normal' : 'bold'
                      })
                    }
                  >
                    <span style={{ fontWeight: 700 }}>B</span>
                    <span>加粗</span>
                  </button>
                </div>
              </div>
            </AccordionSection>
          </div>
        </>
      );
    }

    // 4. TIER
    if (activeKind === 'tier' && selection?.kind === 'tier') {
      const ti = selection.tierIndex;
      const tier = tg.tiers[ti];
      if (!tier) return null;
      const isIntervalTier = tier.kind === 'intervalTier';
      const resolvedTier = resolveTierStyle(styleDoc, tg, ti);
      const tierPatch = resolveTierKeyForLookup(styleDoc, tier.name, ti);
      const hasAnyTierStyle = Boolean(
        resolvedTier.hasCustom ||
          tierPatch?.intervalDefault ||
          tierPatch?.boundaryDefault ||
          tierPatch?.pointDefault
      );
      const isBrushActive = styleBrush?.kind === 'tier';
      const isBrushSticky = Boolean(isBrushActive && styleBrush?.sticky);

      const buildTierBrush = (sticky: boolean) => ({
        kind: 'tier' as const,
        patch: tierPatch ? { ...tierPatch } : {},
        sticky
      });

      const tierName = tier.name || `层 ${ti + 1}`;
      const ctxLabel = `层级 · ${tierName}`;

      return (
        <>
          {renderContextBar({
            kindClass: 'kind-tier',
            label: ctxLabel,
            status: isIntervalTier ? '区间层' : '标点层',
            isBrushActive,
            isBrushSticky,
            canReset: hasAnyTierStyle,
            brushTitle: '格式刷：单击吸取当前层级样式刷入其他层，双击锁定连续刷',
            onBrushClick: (e) => handleBrushClick(e, buildTierBrush),
            onBrushDoubleClick: () => handleBrushDoubleClick(buildTierBrush),
            onReset: () => clearSelectionStyle()
          })}

          <div className="sp-scroll-content">
            <AccordionSection
              title="层标签外观"
              open={Boolean(accOpen['tier-label'])}
              onToggle={() => toggleAcc('tier-label')}
            >
              <div className="sp-form-row">
                <span className="sp-form-lbl">标签底色</span>
                <div className="sp-form-ctrl">
                  <StyleColorPicker
                    value={resolvedTier.labelBg}
                    isDefault={!resolvedTier.labelBg}
                    palette={palette}
                    bwPrintMode={styleDoc.bwPrintMode}
                    swatchLabels={styleDoc.swatchLabels}
                    colorRole="fill"
                    ariaLabel="选择层标签底色"
                    onSelectHex={(hex) => setTierStyle(ti, { labelBg: hex })}
                    onReset={() => setTierStyle(ti, { labelBg: undefined })}
                  />
                </div>
              </div>

              <div className="sp-form-row">
                <span className="sp-form-lbl">文字颜色</span>
                <div className="sp-form-ctrl">
                  <StyleColorPicker
                    value={resolvedTier.labelColor}
                    isDefault={!resolvedTier.labelColor}
                    palette={palette}
                    bwPrintMode={styleDoc.bwPrintMode}
                    swatchLabels={styleDoc.swatchLabels}
                    colorRole="text"
                    ariaLabel="选择层标签文字颜色"
                    onSelectHex={(hex) => setTierStyle(ti, { labelColor: hex })}
                    onReset={() => setTierStyle(ti, { labelColor: undefined })}
                  />
                </div>
              </div>
            </AccordionSection>

            <AccordionSection
              title="层级默认配色"
              open={Boolean(accOpen['tier-default'])}
              onToggle={() => toggleAcc('tier-default')}
            >
              {isIntervalTier ? (
                <>
                  <div className="sp-field-block">
                    <div className="sp-field-head">
                      <span className="sp-field-label">本层区间默认色槽</span>
                      {tierPatch?.intervalDefault?.swatchId && (
                        <button
                          type="button"
                          className="sp-link-action"
                          onClick={() =>
                            setTierStyle(ti, { intervalDefault: { swatchId: null } })
                          }
                        >
                          清除
                        </button>
                      )}
                    </div>
                    <div className="sp-swatch-grid">
                      {palette.swatches.map((sw) => {
                        const active = tierPatch?.intervalDefault?.swatchId === sw.id;
                        return (
                          <button
                            key={`tier-iv-${sw.id}`}
                            type="button"
                            className={`sp-swatch-chip${active ? ' is-active' : ''}`}
                            title={`设置本层区间默认色槽：${sw.name}`}
                            aria-pressed={active}
                            onClick={() =>
                              setTierStyle(ti, {
                                intervalDefault: { swatchId: active ? null : sw.id }
                              })
                            }
                          >
                            <div className="sp-swatch-preview">
                              <SwatchVisualFill
                                swatch={sw}
                                bwMode={styleDoc.bwPrintMode}
                                paletteId={styleDoc.paletteId}
                              />
                              {active && <span className="sp-swatch-dot-mark" aria-hidden="true" />}
                            </div>
                            <span className="sp-swatch-name">{sw.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="sp-field-block">
                    <div className="sp-field-head">
                      <span className="sp-field-label">本层边界默认色槽</span>
                      {tierPatch?.boundaryDefault?.swatchId && (
                        <button
                          type="button"
                          className="sp-link-action"
                          onClick={() =>
                            setTierStyle(ti, { boundaryDefault: { swatchId: null } })
                          }
                        >
                          清除
                        </button>
                      )}
                    </div>
                    <div className="sp-swatch-inline">
                      {palette.swatches.map((sw) => {
                        const active = tierPatch?.boundaryDefault?.swatchId === sw.id;
                        return (
                          <button
                            key={`tier-bd-${sw.id}`}
                            type="button"
                            className={`sp-swatch-mini${active ? ' is-active' : ''}`}
                            title={`本层边界默认色：${sw.name}`}
                            aria-pressed={active}
                            onClick={() =>
                              setTierStyle(ti, {
                                boundaryDefault: { swatchId: active ? null : sw.id }
                              })
                            }
                          >
                            <SwatchVisualFill
                              swatch={sw}
                              bwMode={styleDoc.bwPrintMode}
                              paletteId={styleDoc.paletteId}
                              variant="line"
                            />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              ) : (
                <div className="sp-field-block">
                  <div className="sp-field-head">
                    <span className="sp-field-label">本层标点默认色槽</span>
                    {tierPatch?.pointDefault?.swatchId && (
                      <button
                        type="button"
                        className="sp-link-action"
                        onClick={() => setTierStyle(ti, { pointDefault: { swatchId: null } })}
                      >
                        清除
                      </button>
                    )}
                  </div>
                  <div className="sp-swatch-grid">
                    {palette.swatches.map((sw) => {
                      const active = tierPatch?.pointDefault?.swatchId === sw.id;
                      return (
                        <button
                          key={`tier-pt-${sw.id}`}
                          type="button"
                          className={`sp-swatch-chip${active ? ' is-active' : ''}`}
                          title={`设置本层标点默认色槽：${sw.name}`}
                          aria-pressed={active}
                          onClick={() =>
                            setTierStyle(ti, {
                              pointDefault: { swatchId: active ? null : sw.id }
                            })
                          }
                        >
                          <div className="sp-swatch-preview">
                            <SwatchVisualFill
                              swatch={sw}
                              bwMode={styleDoc.bwPrintMode}
                              paletteId={styleDoc.paletteId}
                              variant="line"
                            />
                            {active && <span className="sp-swatch-dot-mark" aria-hidden="true" />}
                          </div>
                          <span className="sp-swatch-name">{sw.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </AccordionSection>
          </div>
        </>
      );
    }

    return null;
  };

  // ============================================================================
  // Tab 2: Theme & Conditional Rules Content
  // ============================================================================
  const renderThemeTab = () => {
    const handleAddRule = () => {
      ruleSeqRef.current += 1;
      const swatchIdx = styleDoc.rules.length % palette.swatches.length;
      const defaultSwatchId = palette.swatches[swatchIdx]?.id ?? 's1';
      const defaultTierName =
        selection?.kind === 'tier' ? tg.tiers[selection.tierIndex]?.name || undefined : undefined;
      const newId = `rule-custom-${Date.now().toString(36)}-${ruleSeqRef.current}`;
      const newRule: StyleRule = {
        id: newId,
        name: `规则 ${styleDoc.rules.length + 1}`,
        enabled: true,
        tierName: defaultTierName,
        matchKind: 'contains',
        pattern: '',
        caseSensitive: false,
        intervalStyle: { swatchId: defaultSwatchId }
      };
      upsertStyleRule(newRule);
      setExpandedRuleIds((prev) => ({ ...prev, [newId]: true }));
    };

    const uniqueTierNames = Array.from(
      new Set(tg.tiers.map((t) => t.name).filter((n) => n.trim().length > 0))
    );
    const enabledRuleCount = styleDoc.rules.filter((r) => r.enabled).length;

    return (
      <div className="sp-scroll-content">
        {/* 1. Academic Palettes */}
        <AccordionSection
          title="学术配色方案"
          meta={palette.name}
          open={Boolean(accOpen['theme-palette'])}
          onToggle={() => toggleAcc('theme-palette')}
        >
          <div className="sp-palette-grid" role="radiogroup" aria-label="学术配色方案">
            {PALETTES.map((pal) => {
              const isActive = pal.id === styleDoc.paletteId;
              return (
                <button
                  key={pal.id}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  className={`sp-palette-card${isActive ? ' is-active' : ''}`}
                  title={pal.description}
                  onClick={() => setStylePalette(pal.id)}
                >
                  <div className="sp-palette-card-top">
                    <span className="sp-palette-name">{pal.name}</span>
                    {isActive && (
                      <span className="sp-palette-check" aria-hidden="true">
                        <UiIcon name="check" size={12} />
                      </span>
                    )}
                  </div>
                  <div className="sp-palette-strip" aria-hidden="true">
                    {pal.swatches.slice(0, 4).map((sw) => (
                      <span key={sw.id} className="sp-palette-dot">
                        <SwatchVisualFill
                          swatch={sw}
                          bwMode={false}
                          paletteId={pal.id}
                        />
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </AccordionSection>

        {/* 2. Export & Legend */}
        <AccordionSection
          title="出图与图例"
          meta={styleDoc.bwPrintMode ? '黑白印刷' : undefined}
          open={Boolean(accOpen['theme-export'])}
          onToggle={() => toggleAcc('theme-export')}
        >
          <ToggleSwitch
            label="黑白印刷预览（自动套用矢量底纹）"
            title="实时将彩色填充转换为灰度与矢量底纹，便于确认黑白期刊印刷区分度"
            checked={styleDoc.bwPrintMode}
            onChange={(next) => setStyleBwPrintMode(next)}
          />
          <ToggleSwitch
            label="画布与导出显示底部图例"
            title="在谱面底部及导出图像中显示已命名的色槽与规则图例"
            checked={styleDoc.showLegendInExport}
            onChange={(next) => setStyleShowLegend(next)}
          />

          {/* Collapsible Swatch Legend Naming Drawer */}
          <div className={`sp-sub-drawer${swatchLabelsOpen ? ' is-open' : ''}`}>
            <button
              type="button"
              className="sp-sub-drawer-head"
              aria-expanded={swatchLabelsOpen}
              onClick={() => setSwatchLabelsOpen((v) => !v)}
            >
              <span>色槽图例命名</span>
              <TGridIcon name="section-chevron" size={11} className="sp-sub-drawer-chev" />
            </button>
            <div className="sp-sub-drawer-collapse" aria-hidden={!swatchLabelsOpen}>
              <div className="sp-sub-drawer-collapse-inner">
                <div className="sp-sub-drawer-body">
                  {palette.swatches.map((sw) => {
                    const val = styleDoc.swatchLabels[sw.id] ?? '';
                    return (
                      <div key={`lbl-${sw.id}`} className="sp-swatch-label-row">
                        <span className="sp-swatch-label-chip" title={sw.name}>
                          <SwatchVisualFill
                            swatch={sw}
                            bwMode={styleDoc.bwPrintMode}
                            paletteId={styleDoc.paletteId}
                          />
                        </span>
                        <span className="sp-swatch-label-slot" title={sw.name}>
                          {sw.name}
                        </span>
                        <input
                          type="text"
                          className="sp-input"
                          value={val}
                          placeholder="图例含义，如元音"
                          aria-label={`${sw.name}图例含义`}
                          onChange={(e) => setStyleSwatchLabel(sw.id, e.target.value)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {orphanedCount > 0 && (
            <div className="sp-orphan-bar" role="status">
              <span>检测到 {orphanedCount} 项因外部修改失配的历史样式。</span>
              <button
                type="button"
                className="sp-orphan-btn"
                onClick={() => {
                  clearOrphanedStyles();
                  showToast('已清理失配样式记录');
                }}
              >
                清理
              </button>
            </div>
          )}

          <button
            type="button"
            className="sp-action-btn is-subtle is-danger-subtle"
            disabled={!hasAnyStyle}
            title={
              hasAnyStyle
                ? '重置全文档配色、规则与各对象自定义样式（支持撤销）'
                : '当前文档尚无自定义样式'
            }
            onClick={() => {
              clearAllDocumentStyles();
              showToast('已清空全文档自定义样式');
            }}
          >
            <UiIcon name="clear" size={12} />
            <span>清空全文档样式</span>
          </button>
        </AccordionSection>

        {/* 3. Conditional Auto-Coloring Rules */}
        <AccordionSection
          title="条件自动着色规则"
          meta={
            styleDoc.rules.length > 0
              ? `${enabledRuleCount}/${styleDoc.rules.length}`
              : '0 条'
          }
          open={Boolean(accOpen['theme-rules'])}
          onToggle={() => toggleAcc('theme-rules')}
        >
          {/* One-click Preset Pills */}
          <div className="sp-field-block">
            <span className="sp-field-label">一键预设</span>
            <div className="sp-preset-strip">
              {COMPACT_PRESETS.map((preset) => {
                const fullPreset = BUILTIN_STYLE_RULE_PRESETS.find((p) => p.id === preset.id);
                const sw = palette.swatches.find((s) => s.id === preset.swatchId);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className="sp-preset-pill"
                    title={fullPreset?.description ?? preset.label}
                    onClick={() => {
                      applyStyleRulePreset(preset.id);
                      showToast(`已添加规则：${preset.label}`);
                    }}
                  >
                    <span
                      className="sp-preset-dot"
                      style={{
                        background: styleDoc.bwPrintMode
                          ? sw?.bwGray ?? '#E5E5E5'
                          : sw?.fill ?? '#F7E1C4',
                        borderColor: styleDoc.bwPrintMode
                          ? sw?.bwStroke ?? '#1A1A1A'
                          : sw?.stroke ?? '#57544D'
                      }}
                    />
                    <span>{preset.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Rules List */}
          <div className="sp-rule-list">
            {styleDoc.rules.length === 0 ? (
              <div className="sp-rule-empty">
                尚无自动着色规则。点击上方预设或新增规则，可按文本或正则自动批量配色并生成图例。
              </div>
            ) : (
              styleDoc.rules.map((rule) => {
                const isExpanded = Boolean(expandedRuleIds[rule.id]);
                const swatchId = rule.intervalStyle?.swatchId ?? rule.pointStyle?.swatchId ?? 's1';
                const swatch =
                  palette.swatches.find((s) => s.id === swatchId) ?? palette.swatches[0];
                const curPattern: PatternKind = rule.intervalStyle?.pattern ?? 'none';
                const needsPatternInput =
                  rule.matchKind !== 'empty' && rule.matchKind !== 'non-empty';
                const regexInvalid =
                  rule.matchKind === 'regex' && !isValidRegexPattern(rule.pattern);

                const matchKindLabel =
                  RULE_MATCH_KINDS.find((m) => m.value === rule.matchKind)?.label ??
                  rule.matchKind;
                const summaryText = needsPatternInput
                  ? rule.pattern || '未填内容'
                  : matchKindLabel;

                const updateRule = (patch: Partial<StyleRule>) => {
                  upsertStyleRule({
                    ...rule,
                    ...patch
                  });
                };

                return (
                  <div
                    key={rule.id}
                    className={`sp-rule-card${rule.enabled ? '' : ' is-disabled'}${
                      isExpanded ? '' : ' is-collapsed'
                    }`}
                  >
                    <div className="sp-rule-head">
                      <input
                        type="checkbox"
                        className="sp-rule-check"
                        checked={rule.enabled}
                        aria-label={`启用规则 ${rule.name || rule.id}`}
                        title={rule.enabled ? '暂停此规则' : '启用此规则'}
                        onChange={(e) => toggleStyleRule(rule.id, e.target.checked)}
                      />
                      <span className="sp-rule-preview-chip" title={swatch.name}>
                        {curPattern !== 'none' ? (
                          <PatternMicroSvg
                            kind={curPattern}
                            bg={styleDoc.bwPrintMode ? swatch.bwGray : swatch.fill}
                            fg={styleDoc.bwPrintMode ? swatch.bwStroke : swatch.stroke}
                          />
                        ) : (
                          <SwatchVisualFill
                            swatch={swatch}
                            bwMode={styleDoc.bwPrintMode}
                            paletteId={styleDoc.paletteId}
                          />
                        )}
                      </span>
                      <button
                        type="button"
                        className="sp-rule-head-toggle"
                        aria-expanded={isExpanded}
                        onClick={() => toggleRuleExpanded(rule.id)}
                      >
                        <TGridIcon name="section-chevron" size={11} className="sp-rule-chev" />
                        <span className="sp-rule-title">{rule.name || '未命名规则'}</span>
                        <span className="sp-rule-summary" title={summaryText}>
                          {summaryText}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="sp-rule-del-btn"
                        title="删除此规则"
                        aria-label={`删除规则 ${rule.name || rule.id}`}
                        onClick={() => removeStyleRule(rule.id)}
                      >
                        <UiIcon name="trash" size={12} />
                      </button>
                    </div>

                    <div className="sp-rule-collapse" aria-hidden={!isExpanded}>
                      <div className="sp-rule-collapse-inner">
                        <div className="sp-rule-body">
                        <div className="sp-rule-grid">
                          <div className="sp-rule-field is-full">
                            <span className="sp-rule-field-lbl">规则名称（同步作图例名）</span>
                            <input
                              type="text"
                              className="sp-input"
                              value={rule.name}
                              placeholder="例如：元音、送气音"
                              onChange={(e) => updateRule({ name: e.target.value })}
                            />
                          </div>

                          <div className="sp-rule-field">
                            <span className="sp-rule-field-lbl">匹配方式</span>
                            <CustomSelect<StyleRuleMatchKind>
                              size="compact"
                              ariaLabel="匹配方式"
                              value={rule.matchKind}
                              options={RULE_MATCH_KINDS}
                              onChange={(nextKind) =>
                                updateRule({
                                  matchKind: nextKind
                                })
                              }
                            />
                          </div>

                          <div className="sp-rule-field">
                            <span className="sp-rule-field-lbl">作用层级</span>
                            <CustomSelect<string>
                              size="compact"
                              align="right"
                              ariaLabel="作用层级"
                              value={rule.tierName ?? ''}
                              options={(() => {
                                const opts: CustomSelectOption<string>[] = [
                                  { value: '', label: '全部层级' },
                                  ...uniqueTierNames.map((tn) => ({ value: tn, label: tn }))
                                ];
                                if (rule.tierName && !uniqueTierNames.includes(rule.tierName)) {
                                  opts.push({
                                    value: rule.tierName,
                                    label: `${rule.tierName}（当前无此层）`
                                  });
                                }
                                return opts;
                              })()}
                              onChange={(nextTier) =>
                                updateRule({
                                  tierName: nextTier || undefined
                                })
                              }
                            />
                          </div>

                          {needsPatternInput && (
                            <div className="sp-rule-field is-full">
                              <span className="sp-rule-field-lbl">
                                {rule.matchKind === 'regex' ? '正则表达式' : '匹配内容'}
                              </span>
                              <input
                                type="text"
                                className="sp-input is-mono"
                                value={rule.pattern}
                                placeholder={
                                  rule.matchKind === 'regex'
                                    ? '例如：[aeiouəɪʊ]'
                                    : '输入目标文本'
                                }
                                onChange={(e) => updateRule({ pattern: e.target.value })}
                              />
                              {regexInvalid && (
                                <span className="sp-input-error">正则表达式语法有误</span>
                              )}
                            </div>
                          )}
                        </div>

                        <div className="sp-rule-field">
                          <span className="sp-rule-field-lbl">色槽</span>
                          <div className="sp-swatch-inline">
                            {palette.swatches.map((sw) => {
                              const active = swatchId === sw.id;
                              return (
                                <button
                                  key={`r-${rule.id}-${sw.id}`}
                                  type="button"
                                  className={`sp-swatch-mini${active ? ' is-active' : ''}`}
                                  title={sw.name}
                                  aria-pressed={active}
                                  onClick={() => {
                                    const targetTier = rule.tierName
                                      ? tg.tiers.find((t) => t.name === rule.tierName)
                                      : null;
                                    const isPointTarget = targetTier?.kind === 'textTier';
                                    updateRule({
                                      ...(isPointTarget
                                        ? {
                                            pointStyle: {
                                              ...rule.pointStyle,
                                              swatchId: sw.id
                                            }
                                          }
                                        : {
                                            intervalStyle: {
                                              ...rule.intervalStyle,
                                              swatchId: sw.id
                                            },
                                            ...(rule.pointStyle
                                              ? {
                                                  pointStyle: {
                                                    ...rule.pointStyle,
                                                    swatchId: sw.id
                                                  }
                                                }
                                              : {})
                                          })
                                    });
                                  }}
                                >
                                  <SwatchVisualFill
                                    swatch={sw}
                                    bwMode={styleDoc.bwPrintMode}
                                    paletteId={styleDoc.paletteId}
                                  />
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div className="sp-rule-field">
                          <span className="sp-rule-field-lbl">底纹</span>
                          <div className="sp-rule-pattern-strip">
                            {PATTERN_OPTIONS.map((opt) => {
                              const active = curPattern === opt.kind;
                              return (
                                <button
                                  key={`rp-${rule.id}-${opt.kind}`}
                                  type="button"
                                  className={`sp-rule-pat-btn${active ? ' is-active' : ''}`}
                                  title={opt.label}
                                  aria-pressed={active}
                                  onClick={() =>
                                    updateRule({
                                      intervalStyle: {
                                        ...rule.intervalStyle,
                                        swatchId,
                                        pattern: opt.kind
                                      }
                                    })
                                  }
                                >
                                  <PatternMicroSvg
                                    kind={opt.kind}
                                    bg={styleDoc.bwPrintMode ? swatch.bwGray : swatch.fill}
                                    fg={styleDoc.bwPrintMode ? swatch.bwStroke : swatch.stroke}
                                  />
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                );
              })
            )}
          </div>

          <button type="button" className="sp-action-btn" onClick={handleAddRule}>
            <TGridIcon name="stepper-plus" size={12} />
            <span>新增着色规则</span>
          </button>
        </AccordionSection>
      </div>
    );
  };

  return (
    <div className="style-panel">
      {/* Top Primary Text Tabs (PowerPoint "对象样式 | 主题与规则" style) */}
      <div className="sp-tabs" role="tablist" aria-label="样式面板分区">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'object'}
          className={`sp-tab-btn${activeTab === 'object' ? ' is-active' : ''}`}
          onClick={() => setActiveTab('object')}
        >
          <span>对象样式</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'theme'}
          className={`sp-tab-btn${activeTab === 'theme' ? ' is-active' : ''}`}
          onClick={() => setActiveTab('theme')}
        >
          <span>主题与规则</span>
          {styleDoc.rules.length > 0 && (
            <span className="sp-tab-count">{styleDoc.rules.length}</span>
          )}
        </button>
      </div>

      {activeTab === 'object' ? renderObjectTab() : renderThemeTab()}
    </div>
  );
};
