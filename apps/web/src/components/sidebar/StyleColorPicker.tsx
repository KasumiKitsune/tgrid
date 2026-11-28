import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PaletteSpec, SwatchSpec } from '../../style/types';
import { getLogicalViewportSize, getViewportZoom } from '../../utils/uiScale';
import { ChevronIcon } from '../Icons';
import {
  NEUTRAL_ACADEMIC_COLORS,
  PatternMicroSvg,
  parseHexColor
} from './styleVisuals';

export type ColorRole = 'fill' | 'stroke' | 'text';

export interface StyleColorPickerProps {
  /** Resolved or explicit hex color currently displayed */
  value: string | null | undefined;
  /** Whether the color is currently using default/inherited rather than explicit override */
  isDefault?: boolean;
  /** Active palette specification */
  palette: PaletteSpec;
  /** Whether B&W print preview mode is enabled */
  bwPrintMode: boolean;
  /** Optional custom legend labels per swatch id */
  swatchLabels?: Record<string, string>;
  /** Semantic role to map each palette swatch to its fill / stroke / text color */
  colorRole?: ColorRole;
  /** Currently active swatch id if object is linked to a palette slot */
  activeSwatchId?: string | null;
  /** Text displayed when no color is set */
  emptyLabel?: string;
  /** Reset button label */
  resetLabel?: string;
  ariaLabel: string;
  title?: string;
  onSelectHex: (hex: string) => void;
  onSelectSwatch?: (swatch: SwatchSpec) => void;
  onReset?: () => void;
}

const POPOVER_WIDTH = 244;
const POPOVER_EST_HEIGHT = 208;
const VIEWPORT_MARGIN = 10;

function pickSwatchColorForRole(
  swatch: SwatchSpec,
  role: ColorRole,
  bwPrintMode: boolean
): string {
  if (role === 'stroke') {
    return (bwPrintMode ? swatch.bwStroke : swatch.stroke).toUpperCase();
  }
  if (role === 'text') {
    return (bwPrintMode ? '#000000' : swatch.text).toUpperCase();
  }
  return (bwPrintMode ? swatch.bwGray : swatch.fill).toUpperCase();
}

export const StyleColorPicker: React.FC<StyleColorPickerProps> = ({
  value,
  isDefault = false,
  palette,
  bwPrintMode,
  swatchLabels,
  colorRole = 'fill',
  activeSwatchId = null,
  emptyLabel = '默认',
  resetLabel = '恢复默认',
  ariaLabel,
  title,
  onSelectHex,
  onSelectSwatch,
  onReset
}) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; placement: 'bottom' | 'top' }>({
    left: 0,
    top: 0,
    placement: 'bottom'
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hexInputRef = useRef<HTMLInputElement>(null);

  const normalizedValue = useMemo(() => parseHexColor(value), [value]);
  const [hexDraft, setHexDraft] = useState(() => (normalizedValue ? normalizedValue.slice(1) : ''));
  const [hexInvalid, setHexInvalid] = useState(false);

  // Sync draft whenever popover opens or external value updates
  useEffect(() => {
    setHexDraft(normalizedValue ? normalizedValue.slice(1) : '');
    setHexInvalid(false);
  }, [normalizedValue, open]);

  const activeSwatch = useMemo(() => {
    if (!activeSwatchId) return null;
    return palette.swatches.find((s) => s.id === activeSwatchId) ?? null;
  }, [activeSwatchId, palette.swatches]);

  const useBwPattern =
    colorRole === 'fill' && (bwPrintMode || palette.id === 'journal-bw');

  const updatePosition = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const z = getViewportZoom();
    const rect = btn.getBoundingClientRect();
    const { width: vw, height: vh } = getLogicalViewportSize();

    const triggerLeft = rect.left / z;
    const triggerRight = rect.right / z;
    const triggerTop = rect.top / z;
    const triggerBottom = rect.bottom / z;

    const popW = popoverRef.current
      ? Math.max(POPOVER_WIDTH, popoverRef.current.offsetWidth)
      : POPOVER_WIDTH;
    const popH = popoverRef.current
      ? Math.max(140, popoverRef.current.offsetHeight)
      : POPOVER_EST_HEIGHT;

    // Align right edge with trigger right edge inside narrow right sidebar
    let left = triggerRight - popW;
    if (left < VIEWPORT_MARGIN) {
      left = Math.min(triggerLeft, vw - popW - VIEWPORT_MARGIN);
    }
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - popW - VIEWPORT_MARGIN));

    let top = triggerBottom + 4;
    let placement: 'bottom' | 'top' = 'bottom';
    if (top + popH > vh - VIEWPORT_MARGIN) {
      const aboveTop = triggerTop - popH - 4;
      if (aboveTop >= VIEWPORT_MARGIN) {
        top = aboveTop;
        placement = 'top';
      } else {
        top = Math.max(VIEWPORT_MARGIN, vh - popH - VIEWPORT_MARGIN);
      }
    }

    setPos({ left: Math.round(left), top: Math.round(top), placement });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const raf = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(raf);
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const handleRelayout = () => updatePosition();

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', handleRelayout);
    window.addEventListener('scroll', handleRelayout, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', handleRelayout);
      window.removeEventListener('scroll', handleRelayout, true);
    };
  }, [open, updatePosition]);

  const parsedDraft = useMemo(() => parseHexColor(hexDraft), [hexDraft]);

  const commitHexDraft = useCallback(() => {
    const parsed = parseHexColor(hexDraft);
    if (!parsed) {
      setHexInvalid(true);
      hexInputRef.current?.focus();
      return;
    }
    setHexInvalid(false);
    setHexDraft(parsed.slice(1));
    onSelectHex(parsed);
    setOpen(false);
  }, [hexDraft, onSelectHex]);

  const displayLabel = useMemo(() => {
    if (isDefault && !normalizedValue) return emptyLabel;
    if (activeSwatch) {
      const customLbl = swatchLabels?.[activeSwatch.id]?.trim();
      const slotHex = pickSwatchColorForRole(activeSwatch, colorRole, bwPrintMode);
      if (!normalizedValue || normalizedValue === slotHex) {
        return customLbl ? `${customLbl}` : activeSwatch.name;
      }
    }
    return normalizedValue ?? emptyLabel;
  }, [isDefault, normalizedValue, emptyLabel, activeSwatch, swatchLabels, colorRole, bwPrintMode]);

  const isMonospaceLabel = displayLabel.startsWith('#');

  const popoverNode =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className={`sp-color-popover${pos.placement === 'top' ? ' is-up' : ''}`}
            role="dialog"
            aria-label={ariaLabel}
            style={{ left: pos.left, top: pos.top, width: POPOVER_WIDTH }}
          >
            {/* 1. Active Academic Theme Swatches */}
            <div className="sp-cp-section">
              <div className="sp-cp-head">
                <span className="sp-cp-title">{palette.name}色板</span>
                {useBwPattern && <span className="sp-cp-tag">黑白底纹</span>}
              </div>
              <div className="sp-cp-grid">
                {palette.swatches.map((sw) => {
                  const tileColor = pickSwatchColorForRole(sw, colorRole, bwPrintMode);
                  const isActive =
                    (activeSwatchId !== null && activeSwatchId === sw.id && (!normalizedValue || normalizedValue === tileColor)) ||
                    (normalizedValue !== null && normalizedValue === tileColor && activeSwatchId === null);
                  const customLbl = swatchLabels?.[sw.id]?.trim();
                  const tip = customLbl
                    ? `${sw.name} · ${customLbl} (${tileColor})`
                    : `${sw.name} (${tileColor})`;
                  return (
                    <button
                      key={`cp-pal-${sw.id}`}
                      type="button"
                      className={`sp-cp-tile${isActive ? ' is-active' : ''}`}
                      title={tip}
                      aria-label={tip}
                      aria-pressed={isActive}
                      onClick={() => {
                        if (onSelectSwatch) {
                          onSelectSwatch(sw);
                        } else {
                          onSelectHex(tileColor);
                        }
                        setOpen(false);
                      }}
                    >
                      {useBwPattern ? (
                        <PatternMicroSvg
                          kind={sw.bwPattern}
                          bg={sw.bwGray}
                          fg={sw.bwStroke}
                        />
                      ) : (
                        <span
                          className="sp-cp-tile-fill"
                          style={{
                            backgroundColor: tileColor,
                            boxShadow:
                              colorRole === 'fill'
                                ? `inset 2px 0 0 ${sw.stroke}`
                                : undefined
                          }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 2. Curated Academic Neutral Swatches */}
            <div className="sp-cp-section">
              <div className="sp-cp-head">
                <span className="sp-cp-title">论文常用中性色</span>
              </div>
              <div className="sp-cp-grid">
                {NEUTRAL_ACADEMIC_COLORS.map((item) => {
                  const isActive = normalizedValue === item.hex;
                  return (
                    <button
                      key={`cp-neu-${item.hex}`}
                      type="button"
                      className={`sp-cp-tile${isActive ? ' is-active' : ''}`}
                      title={`${item.name} (${item.hex})`}
                      aria-label={`${item.name} ${item.hex}`}
                      aria-pressed={isActive}
                      onClick={() => {
                        onSelectHex(item.hex);
                        setOpen(false);
                      }}
                    >
                      <span
                        className="sp-cp-tile-fill"
                        style={{ backgroundColor: item.hex }}
                      />
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="sp-cp-divider" />

            {/* 3. Custom HEX Input Row */}
            <div className="sp-cp-section">
              <div className="sp-cp-head">
                <span className="sp-cp-title">自定义 HEX</span>
                {hexInvalid && <span className="sp-cp-err">请输入 3 或 6 位十六进制</span>}
              </div>
              <div className="sp-cp-hex-row">
                <span
                  className={`sp-cp-hex-preview${parsedDraft ? '' : ' is-empty'}`}
                  style={parsedDraft ? { backgroundColor: parsedDraft } : undefined}
                  aria-hidden="true"
                />
                <div className={`sp-cp-hex-box${hexInvalid ? ' is-invalid' : ''}`}>
                  <span className="sp-cp-hex-hash" aria-hidden="true">
                    #
                  </span>
                  <input
                    ref={hexInputRef}
                    type="text"
                    className="sp-cp-hex-input"
                    value={hexDraft}
                    maxLength={7}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="F7E1C4"
                    aria-label="自定义十六进制色值"
                    onChange={(e) => {
                      const raw = e.target.value.replace(/^#/, '').replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
                      setHexDraft(raw.toUpperCase());
                      if (hexInvalid) setHexInvalid(false);
                    }}
                    onPaste={(e) => {
                      const pasted = e.clipboardData.getData('text');
                      const cleaned = pasted.trim().replace(/^#/, '').replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
                      if (cleaned) {
                        e.preventDefault();
                        setHexDraft(cleaned.toUpperCase());
                        setHexInvalid(false);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitHexDraft();
                      }
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="sp-cp-apply-btn"
                  onClick={commitHexDraft}
                >
                  应用
                </button>
              </div>
            </div>

            {onReset && (
              <>
                <div className="sp-cp-divider" />
                <div className="sp-cp-foot">
                  <button
                    type="button"
                    className="sp-cp-reset-btn"
                    disabled={isDefault}
                    onClick={() => {
                      onReset();
                      setOpen(false);
                    }}
                  >
                    {resetLabel}
                  </button>
                </div>
              </>
            )}
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`sp-color-trigger${open ? ' is-open' : ''}${isDefault ? ' is-default' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title ?? ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span
          className={`sp-color-chip${!normalizedValue ? ' is-empty' : ''}`}
          aria-hidden="true"
        >
          {useBwPattern && activeSwatch && (!normalizedValue || normalizedValue === pickSwatchColorForRole(activeSwatch, 'fill', bwPrintMode)) ? (
            <PatternMicroSvg
              kind={activeSwatch.bwPattern}
              bg={activeSwatch.bwGray}
              fg={activeSwatch.bwStroke}
            />
          ) : normalizedValue ? (
            <span
              className="sp-color-chip-fill"
              style={{ backgroundColor: normalizedValue }}
            />
          ) : (
            <span className="sp-color-chip-slash" />
          )}
        </span>
        <span className={`sp-color-label${isMonospaceLabel ? ' is-mono' : ''}`}>
          {displayLabel}
        </span>
        <span className="sp-color-caret" aria-hidden="true">
          <ChevronIcon size={10} />
        </span>
      </button>
      {popoverNode}
    </>
  );
};
