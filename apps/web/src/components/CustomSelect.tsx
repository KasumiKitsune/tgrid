import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getLogicalViewportSize, getViewportZoom } from '../utils/uiScale';
import { ChevronIcon } from './Icons';

export interface CustomSelectOption<T extends string = string> {
  value: T;
  label: string;
  meta?: string;
  disabled?: boolean;
  title?: string;
}

export interface CustomSelectProps<T extends string = string> {
  value: T;
  options: ReadonlyArray<CustomSelectOption<T>>;
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: 'default' | 'compact';
  align?: 'left' | 'right';
  ariaLabel?: string;
  title?: string;
  className?: string;
  menuClassName?: string;
  maxMenuHeight?: number;
}

const VIEWPORT_MARGIN = 8;
const MENU_GAP = 4;

interface MenuPos {
  left: number;
  top: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
  placement: 'bottom' | 'top';
}

export function CustomSelect<T extends string = string>({
  value,
  options,
  onChange,
  placeholder = '请选择',
  disabled = false,
  size = 'default',
  align = 'left',
  ariaLabel,
  title,
  className,
  menuClassName,
  maxMenuHeight = 240
}: CustomSelectProps<T>): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const [pos, setPos] = useState<MenuPos>({
    left: 0,
    top: 0,
    minWidth: 120,
    maxWidth: 280,
    maxHeight: maxMenuHeight,
    placement: 'bottom'
  });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectedIndex = useMemo(
    () => options.findIndex((opt) => opt.value === value),
    [options, value]
  );
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const findNextEnabledIndex = useCallback(
    (start: number, delta: 1 | -1): number => {
      const len = options.length;
      if (len === 0) return -1;
      for (let step = 0; step < len; step++) {
        const idx = (start + delta * step + len) % len;
        if (!options[idx]?.disabled) return idx;
      }
      return -1;
    },
    [options]
  );

  const findEdgeEnabledIndex = useCallback(
    (fromEnd: boolean): number => {
      const len = options.length;
      if (len === 0) return -1;
      if (!fromEnd) {
        for (let i = 0; i < len; i++) {
          if (!options[i]?.disabled) return i;
        }
      } else {
        for (let i = len - 1; i >= 0; i--) {
          if (!options[i]?.disabled) return i;
        }
      }
      return -1;
    },
    [options]
  );

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
    const triggerWidth = Math.max(0, triggerRight - triggerLeft);

    const maxAllowedWidth = Math.max(120, vw - VIEWPORT_MARGIN * 2);
    const minWidth = Math.min(Math.max(Math.round(triggerWidth), 120), maxAllowedWidth);
    const maxWidth = Math.min(Math.max(minWidth, 260), maxAllowedWidth);

    const measuredWidth = menuRef.current
      ? Math.min(Math.max(menuRef.current.offsetWidth, minWidth), maxWidth)
      : minWidth;

    const rowH = size === 'compact' ? 27 : 30;
    const estHeight = Math.min(maxMenuHeight, options.length * rowH + 8);
    const measuredHeight = menuRef.current
      ? Math.min(maxMenuHeight, Math.max(36, menuRef.current.scrollHeight + 2))
      : estHeight;

    const spaceBelow = Math.max(0, vh - triggerBottom - MENU_GAP - VIEWPORT_MARGIN);
    const spaceAbove = Math.max(0, triggerTop - MENU_GAP - VIEWPORT_MARGIN);

    let placement: 'bottom' | 'top' = 'bottom';
    let availHeight = spaceBelow;
    if (spaceBelow < measuredHeight && spaceAbove > spaceBelow) {
      placement = 'top';
      availHeight = spaceAbove;
    }

    const finalMaxHeight = Math.max(72, Math.min(maxMenuHeight, Math.floor(availHeight)));
    const actualHeight = Math.min(measuredHeight, finalMaxHeight);

    let top =
      placement === 'bottom'
        ? triggerBottom + MENU_GAP
        : triggerTop - actualHeight - MENU_GAP;
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - actualHeight - VIEWPORT_MARGIN));

    let left = align === 'right' ? triggerRight - measuredWidth : triggerLeft;
    if (left + measuredWidth > vw - VIEWPORT_MARGIN) {
      left = triggerRight - measuredWidth;
    }
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - measuredWidth - VIEWPORT_MARGIN));

    setPos({
      left: Math.round(left),
      top: Math.round(top),
      minWidth: Math.round(minWidth),
      maxWidth: Math.round(maxWidth),
      maxHeight: finalMaxHeight,
      placement
    });
  }, [align, maxMenuHeight, options.length, size]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const raf = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(raf);
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    if (focusedIndex >= 0) {
      optionRefs.current[focusedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [open, focusedIndex]);

  useEffect(() => {
    if (disabled && open) {
      setOpen(false);
    }
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
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

    const handleResize = () => updatePosition();
    const handleScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      updatePosition();
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [open, updatePosition]);

  const openMenu = useCallback(
    (initialIdx?: number) => {
      if (disabled || options.length === 0) return;
      const start =
        initialIdx !== undefined && initialIdx >= 0 && !options[initialIdx]?.disabled
          ? initialIdx
          : selectedIndex >= 0 && !options[selectedIndex]?.disabled
            ? selectedIndex
            : findEdgeEnabledIndex(false);
      setFocusedIndex(start);
      setOpen(true);
    },
    [disabled, findEdgeEnabledIndex, options, selectedIndex]
  );

  const selectIndex = useCallback(
    (idx: number) => {
      const opt = options[idx];
      if (!opt || opt.disabled) return;
      if (opt.value !== value) {
        onChange(opt.value);
      }
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange, options, value]
  );

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (!open) {
        openMenu();
      } else {
        const next = findNextEnabledIndex(focusedIndex < 0 ? 0 : focusedIndex + 1, 1);
        if (next >= 0) setFocusedIndex(next);
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (!open) {
        openMenu();
      } else {
        const prev = findNextEnabledIndex(
          focusedIndex < 0 ? options.length - 1 : focusedIndex - 1,
          -1
        );
        if (prev >= 0) setFocusedIndex(prev);
      }
      return;
    }

    if (e.key === 'Home' && open) {
      e.preventDefault();
      e.stopPropagation();
      const first = findEdgeEnabledIndex(false);
      if (first >= 0) setFocusedIndex(first);
      return;
    }

    if (e.key === 'End' && open) {
      e.preventDefault();
      e.stopPropagation();
      const last = findEdgeEnabledIndex(true);
      if (last >= 0) setFocusedIndex(last);
      return;
    }

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (!open) {
        openMenu();
      } else if (focusedIndex >= 0) {
        selectIndex(focusedIndex);
      } else {
        setOpen(false);
      }
      return;
    }

    if (e.key === 'Tab' && open) {
      setOpen(false);
    }
  };

  const triggerClasses = [
    'tg-select-trigger',
    size === 'compact' ? 'is-compact' : '',
    open ? 'is-open' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ');

  const menuClasses = [
    'tg-select-menu',
    size === 'compact' ? 'is-compact' : '',
    pos.placement === 'top' ? 'is-up' : '',
    menuClassName ?? ''
  ]
    .filter(Boolean)
    .join(' ');

  const menuNode =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={menuRef}
            className={menuClasses}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              left: pos.left,
              top: pos.top,
              minWidth: pos.minWidth,
              maxWidth: pos.maxWidth,
              maxHeight: pos.maxHeight
            }}
          >
            {options.map((opt, idx) => {
              const isSelected = opt.value === value;
              const isFocused = idx === focusedIndex;
              return (
                <button
                  key={`${opt.value}-${idx}`}
                  ref={(el) => {
                    optionRefs.current[idx] = el;
                  }}
                  type="button"
                  role="option"
                  disabled={opt.disabled}
                  aria-selected={isSelected}
                  title={opt.title ?? opt.label}
                  className={`tg-select-option${isSelected ? ' selected' : ''}${
                    isFocused ? ' is-focused' : ''
                  }`}
                  onMouseEnter={() => {
                    if (!opt.disabled) setFocusedIndex(idx);
                  }}
                  onMouseDown={(e) => {
                    // Keep focus behavior crisp without blur flicker before click
                    e.preventDefault();
                  }}
                  onClick={() => selectIndex(idx)}
                >
                  <span className="tg-select-option-label">{opt.label}</span>
                  {opt.meta && <span className="tg-select-option-meta">{opt.meta}</span>}
                </button>
              );
            })}
          </div>,
          document.body
        )
      : null;

  const displayLabel = selectedOption?.label ?? placeholder;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClasses}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title ?? selectedOption?.title ?? displayLabel}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            openMenu();
          }
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className={`tg-select-value${!selectedOption ? ' is-placeholder' : ''}`}>
          {displayLabel}
        </span>
        <ChevronIcon />
      </button>
      {menuNode}
    </>
  );
}
