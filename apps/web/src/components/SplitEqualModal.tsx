import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, UiIcon } from './Icons';

export interface SplitEqualDialogState {
  tierIndex: number;
  itemIndex: number;
  tierName: string;
  text: string;
  xmin: number;
  xmax: number;
}

interface SplitEqualModalProps {
  state: SplitEqualDialogState | null;
  onCancel: () => void;
  onConfirm: (count: number) => void;
}

const MIN_SEGMENTS = 2;
const MAX_SEGMENTS = 20;
const QUICK_PRESETS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20] as const;

function clampSegments(n: number): number {
  if (!Number.isFinite(n)) return 4;
  return Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, Math.round(n)));
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0 ms';
  if (sec >= 1) return `${sec.toFixed(3)} s`;
  if (sec >= 0.01) return `${(sec * 1000).toFixed(1)} ms`;
  return `${(sec * 1000).toFixed(2)} ms`;
}

function formatSec(sec: number): string {
  if (!Number.isFinite(sec)) return '0.000 s';
  return `${sec.toFixed(3)} s`;
}

export const SplitEqualModal: React.FC<SplitEqualModalProps> = ({
  state,
  onCancel,
  onConfirm
}) => {
  const [count, setCount] = useState<number>(4);
  const sliderRef = useRef<HTMLInputElement>(null);
  const backdropPointerDownRef = useRef(false);
  const lastStateRef = useRef<SplitEqualDialogState | null>(null);

  if (state) {
    lastStateRef.current = state;
  }

  const open = Boolean(state);
  const view = state ?? lastStateRef.current;

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      sliderRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const totalDur = view ? Math.max(0, view.xmax - view.xmin) : 0;
  const segDur = count > 0 ? totalDur / count : 0;
  const tooShort = totalDur <= 0 || segDur <= 1e-7;

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }

      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl?.dataset.splitAction === 'cancel') return;
        e.preventDefault();
        e.stopPropagation();
        if (!tooShort) {
          onConfirm(count);
        }
        return;
      }

      // Allow arrow keys to adjust count anywhere in the modal without double-stepping when slider is focused
      if (
        (e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown') &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        if (document.activeElement === sliderRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        const delta = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : -1;
        setCount((prev) => clampSegments(prev + delta));
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open, count, tooShort, onCancel, onConfirm]);

  if (!view) return null;

  const progressPct = ((count - MIN_SEGMENTS) / (MAX_SEGMENTS - MIN_SEGMENTS)) * 100;
  const displayText = view.text.trim();

  return createPortal(
    <div
      className={`modal-backdrop ${open ? 'open' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      aria-labelledby="split-equal-modal-title"
      onPointerDown={(e) => {
        backdropPointerDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (backdropPointerDownRef.current && e.target === e.currentTarget) {
          onCancel();
        }
        backdropPointerDownRef.current = false;
      }}
    >
      <div className="modal-card split-equal-modal-card">
        <div className="modal-head">
          <span id="split-equal-modal-title" className="modal-title">
            <UiIcon name="splitEqual" size={14} />
            <span>等分区间</span>
          </span>
          <button
            type="button"
            className="icon-btn compact"
            data-split-action="cancel"
            title="取消 (Esc)"
            aria-label="取消"
            onClick={onCancel}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="modal-body split-equal-modal-body">
          {/* Interval context strip */}
          <div className="split-equal-meta">
            <div className="split-equal-meta-row">
              <span className="split-equal-tier-tag" title={view.tierName}>
                {view.tierName}
              </span>
              <span
                className={`split-equal-text-preview${displayText ? '' : ' is-empty'}`}
                title={displayText || '空白区间'}
              >
                {displayText ? `「${displayText}」` : '（空白区间）'}
              </span>
            </div>
            <div className="split-equal-time-row">
              <span>
                {formatSec(view.xmin)} — {formatSec(view.xmax)}
              </span>
              <span className="split-equal-dur-total">总长 {formatDuration(totalDur)}</span>
            </div>
          </div>

          {/* Visual equal-segment schematic */}
          <div className="split-equal-schematic-wrap" aria-hidden="true">
            <div
              className="split-equal-schematic"
              style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: count }, (_, idx) => (
                <div
                  key={idx}
                  className={`split-equal-cell${idx === 0 && displayText ? ' has-text' : ''}`}
                >
                  {count <= 10 ? (
                    <span className="split-equal-cell-idx">{idx + 1}</span>
                  ) : idx === 0 || idx === count - 1 ? (
                    <span className="split-equal-cell-idx">{idx + 1}</span>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="split-equal-schematic-axis">
              <span>{formatSec(view.xmin)}</span>
              <span className="split-equal-avg">
                每段约 <strong>{formatDuration(segDur)}</strong>
              </span>
              <span>{formatSec(view.xmax)}</span>
            </div>
          </div>

          {/* Slider + Stepper + Live Count */}
          <div className="split-equal-slider-block">
            <div className="split-equal-slider-head">
              <label htmlFor="split-equal-range" className="split-equal-label">
                等分段数
              </label>
              <div className="split-equal-stepper">
                <button
                  type="button"
                  className="icon-btn compact split-equal-step-btn"
                  title="减少 1 段 (←)"
                  aria-label="减少一段"
                  disabled={count <= MIN_SEGMENTS}
                  onClick={() => setCount((c) => clampSegments(c - 1))}
                >
                  <UiIcon name="stepper-minus" size={11} />
                </button>
                <span className="split-equal-count-badge" aria-live="polite">
                  <strong>{count}</strong>
                  <span>段</span>
                </span>
                <button
                  type="button"
                  className="icon-btn compact split-equal-step-btn"
                  title="增加 1 段 (→)"
                  aria-label="增加一段"
                  disabled={count >= MAX_SEGMENTS}
                  onClick={() => setCount((c) => clampSegments(c + 1))}
                >
                  <UiIcon name="stepper-plus" size={11} />
                </button>
              </div>
            </div>

            <div className="split-equal-range-wrap">
              <input
                ref={sliderRef}
                id="split-equal-range"
                type="range"
                className="split-equal-range"
                min={MIN_SEGMENTS}
                max={MAX_SEGMENTS}
                step={1}
                value={count}
                aria-label="等分段数"
                aria-valuetext={`${count} 段，每段约 ${formatDuration(segDur)}`}
                style={{ '--split-pct': `${progressPct}%` } as React.CSSProperties}
                onChange={(e) => setCount(clampSegments(Number(e.target.value)))}
              />
              <div className="split-equal-range-ticks" aria-hidden="true">
                <span>2</span>
                <span>5</span>
                <span>10</span>
                <span>15</span>
                <span>20</span>
              </div>
            </div>

            <div className="split-equal-presets" role="group" aria-label="常用等分段数">
              {QUICK_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`compact split-equal-preset-btn${count === n ? ' active' : ''}`}
                  onClick={() => setCount(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          {tooShort && (
            <div className="split-equal-warning" role="alert">
              当前区间时长过短，无法等分为 {count} 段，请减少段数。
            </div>
          )}
        </div>

        <div className="unsaved-modal-foot split-equal-foot">
          <span className="split-equal-foot-hint">← → 微调 · Enter 确认</span>
          <div className="unsaved-foot-right">
            <button type="button" data-split-action="cancel" onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              disabled={tooShort}
              onClick={() => onConfirm(count)}
            >
              等分为 {count} 段
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
