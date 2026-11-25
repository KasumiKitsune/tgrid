import React, { useCallback, useEffect, useRef, useState } from 'react';
import { isComposingEvent } from '../shortcuts/registry';

export interface ScrubNumberInputProps {
  label?: string;
  value: number;
  min?: number;
  max?: number;
  strictMin?: boolean;
  strictMax?: boolean;
  stepSec?: number;
  fineStepSec?: number;
  coarseStepSec?: number;
  decimals?: number;
  disabled?: boolean;
  variant?: 'floating' | 'sidebar';
  className?: string;
  title?: string;
  formatValue?: (val: number) => string;
  onScrubPreview?: (val: number) => void;
  onScrubEnd?: () => void;
  onCommit: (val: number) => boolean | void;
}

const STRICT_EPS = 1e-4;
const DRAG_THRESHOLD_PX = 3;

export const ScrubNumberInput: React.FC<ScrubNumberInputProps> = ({
  label,
  value,
  min,
  max,
  strictMin = false,
  strictMax = false,
  stepSec = 0.001,
  fineStepSec = 0.0001,
  coarseStepSec = 0.01,
  decimals = 6,
  disabled = false,
  variant = 'floating',
  className,
  title,
  formatValue,
  onScrubPreview,
  onScrubEnd,
  onCommit
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const focusedRef = useRef(false);
  const scrubbingRef = useRef(false);
  const suppressBlurCommitRef = useRef(false);
  const activeCleanupRef = useRef<(() => void) | null>(null);

  const clampAndRound = useCallback(
    (raw: number): number => {
      let lo =
        min !== undefined && Number.isFinite(min) ? (strictMin ? min + STRICT_EPS : min) : -Infinity;
      let hi =
        max !== undefined && Number.isFinite(max) ? (strictMax ? max - STRICT_EPS : max) : Infinity;

      if (lo > hi) {
        if (
          min !== undefined &&
          max !== undefined &&
          Number.isFinite(min) &&
          Number.isFinite(max)
        ) {
          const mid = (min + max) / 2;
          lo = mid;
          hi = mid;
        }
      }

      const clamped = Math.min(hi, Math.max(lo, raw));
      const factor = Math.pow(10, decimals);
      let rounded = Math.round(clamped * factor) / factor;
      if (rounded < lo) rounded = Math.min(hi, lo);
      if (rounded > hi) rounded = Math.max(lo, hi);
      rounded = Number(rounded.toFixed(decimals));
      return Object.is(rounded, -0) ? 0 : rounded;
    },
    [min, max, strictMin, strictMax, decimals]
  );

  const formatDisplay = useCallback(
    (v: number): string => {
      if (!Number.isFinite(v)) return '';
      if (formatValue) return formatValue(v);
      const clean = Number(v.toFixed(decimals));
      return String(Object.is(clean, -0) ? 0 : clean);
    },
    [formatValue, decimals]
  );

  const [draft, setDraft] = useState<string>(() => formatDisplay(value));
  const [isFocused, setIsFocused] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);

  // Keep local draft synchronized when idle (neither typing nor scrubbing)
  useEffect(() => {
    if (!focusedRef.current && !scrubbingRef.current) {
      setDraft(formatDisplay(value));
    }
  }, [value, formatDisplay]);

  // Ensure global listeners & cursor locks are always cleaned up on unmount
  useEffect(() => {
    return () => {
      activeCleanupRef.current?.();
      activeCleanupRef.current = null;
    };
  }, []);

  const commitDraftValue = useCallback(
    (text: string) => {
      const parsed = parseFloat(text.trim());
      if (!Number.isFinite(parsed)) {
        setDraft(formatDisplay(value));
        return;
      }
      const next = clampAndRound(parsed);
      if (Math.abs(next - value) <= 1e-12) {
        setDraft(formatDisplay(value));
        return;
      }
      const res = onCommit(next);
      if (res === false) {
        setDraft(formatDisplay(value));
      } else {
        setDraft(formatDisplay(next));
      }
    },
    [clampAndRound, formatDisplay, onCommit, value]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (disabled || e.button !== 0) return;

      const targetEl = e.target as Node | null;
      const isInputTarget = Boolean(inputRef.current && targetEl === inputRef.current);

      // If input is already focused and the user clicks inside it, allow normal text cursor/selection.
      if (isInputTarget && focusedRef.current) {
        return;
      }

      e.preventDefault();
      activeCleanupRef.current?.();

      const startY = e.clientY;
      const startVal = Number.isFinite(value) ? value : 0;
      let latestVal = startVal;
      let enteredScrub = false;
      let cancelled = false;
      let prevBodyCursor = '';
      let prevBodyUserSelect = '';

      const restoreBodyStyles = () => {
        if (enteredScrub) {
          document.body.style.cursor = prevBodyCursor;
          document.body.style.userSelect = prevBodyUserSelect;
        }
      };

      const cleanup = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
        window.removeEventListener('keydown', onKeyDown, true);
        restoreBodyStyles();
        if (scrubbingRef.current) {
          scrubbingRef.current = false;
          setIsScrubbing(false);
        }
        activeCleanupRef.current = null;
      };

      const onKeyDown = (ke: KeyboardEvent) => {
        if (ke.key !== 'Escape') return;
        if (!enteredScrub) return;
        ke.preventDefault();
        ke.stopPropagation();
        cancelled = true;
        cleanup();
        setDraft(formatDisplay(startVal));
        onScrubEnd?.();
      };

      const onPointerMove = (ev: PointerEvent) => {
        if (cancelled) return;
        const deltaY = ev.clientY - startY;
        if (!enteredScrub) {
          if (Math.abs(deltaY) < DRAG_THRESHOLD_PX) return;
          enteredScrub = true;
          scrubbingRef.current = true;
          setIsScrubbing(true);
          if (focusedRef.current && inputRef.current) {
            suppressBlurCommitRef.current = true;
            inputRef.current.blur();
          }
          prevBodyCursor = document.body.style.cursor;
          prevBodyUserSelect = document.body.style.userSelect;
          document.body.style.cursor = 'ns-resize';
          document.body.style.userSelect = 'none';
        }

        const deltaPx = startY - ev.clientY; // drag up increases, drag down decreases
        const step = ev.shiftKey
          ? fineStepSec
          : ev.ctrlKey || ev.metaKey
            ? coarseStepSec
            : stepSec;
        const rawNext = startVal + Math.round(deltaPx / 2) * step;
        const nextVal = clampAndRound(rawNext);
        if (Math.abs(nextVal - latestVal) > 1e-12) {
          latestVal = nextVal;
          setDraft(formatDisplay(nextVal));
          onScrubPreview?.(nextVal);
        }
      };

      const finishPointer = (isCancel: boolean) => {
        if (cancelled) return;
        const wasScrubbing = enteredScrub;
        cleanup();

        if (!wasScrubbing) {
          if (!isCancel && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
          }
          return;
        }

        onScrubEnd?.();
        if (isCancel) {
          setDraft(formatDisplay(startVal));
          return;
        }

        if (Math.abs(latestVal - startVal) > 1e-9) {
          const res = onCommit(latestVal);
          if (res === false) {
            setDraft(formatDisplay(startVal));
          } else {
            setDraft(formatDisplay(latestVal));
          }
        } else {
          setDraft(formatDisplay(startVal));
        }
      };

      const onPointerUp = () => finishPointer(false);
      const onPointerCancel = () => finishPointer(true);

      activeCleanupRef.current = cleanup;
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('keydown', onKeyDown, true);
    },
    [
      disabled,
      value,
      fineStepSec,
      coarseStepSec,
      stepSec,
      clampAndRound,
      formatDisplay,
      onScrubPreview,
      onScrubEnd,
      onCommit
    ]
  );

  const handleFocus = useCallback(() => {
    focusedRef.current = true;
    suppressBlurCommitRef.current = false;
    setIsFocused(true);
  }, []);

  const handleBlur = useCallback(() => {
    focusedRef.current = false;
    setIsFocused(false);
    if (suppressBlurCommitRef.current) {
      suppressBlurCommitRef.current = false;
      return;
    }
    commitDraftValue(draft);
  }, [commitDraftValue, draft]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (isComposingEvent(e)) return;

      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        commitDraftValue(draft);
        suppressBlurCommitRef.current = true;
        inputRef.current?.blur();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDraft(formatDisplay(value));
        suppressBlurCommitRef.current = true;
        inputRef.current?.blur();
        return;
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        const parsed = parseFloat(draft.trim());
        const base = Number.isFinite(parsed) ? parsed : value;
        const step = e.shiftKey
          ? fineStepSec
          : e.ctrlKey || e.metaKey
            ? coarseStepSec
            : stepSec;
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        const next = clampAndRound(base + dir * step);
        const res = onCommit(next);
        if (res === false) {
          setDraft(formatDisplay(value));
        } else {
          setDraft(formatDisplay(next));
        }
      }
    },
    [
      commitDraftValue,
      draft,
      formatDisplay,
      value,
      fineStepSec,
      coarseStepSec,
      stepSec,
      clampAndRound,
      onCommit
    ]
  );

  const defaultTitle =
    title ?? '上下拖拽微调数值（Shift 超精 / Ctrl 粗调），单击输入精确值';

  const rootClasses = [
    'scrub-field',
    `variant-${variant}`,
    isScrubbing ? 'is-scrubbing' : '',
    isFocused ? 'is-focused' : '',
    disabled ? 'is-disabled' : '',
    className || ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClasses} title={defaultTitle} onPointerDown={handlePointerDown}>
      {label ? <span className="scrub-label">{label}</span> : null}
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        className="scrub-input"
        value={draft}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
};
