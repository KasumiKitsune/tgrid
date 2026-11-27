import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getPlatformBridge } from '../bridge/PlatformBridge';
import { decodeTrigraphGlossSync, primeTrigraphString } from '../layout/richText';
import {
  resolveSplitSourceText,
  splitTextByDelimiter,
  splitTextIntoChars,
  type PunctuationMode,
  type SplitDelimiterPreset
} from '../utils/intervalSplit';
import { inferSmartSplit, type SmartSplitCandidate } from '../utils/smartSplit';
import { CloseIcon, UiIcon } from './Icons';
import { ToggleSwitch } from './ToggleSwitch';

export interface SplitEqualDialogState {
  tierIndex: number;
  itemIndex: number;
  tierName: string;
  text: string;
  xmin: number;
  xmax: number;
  peerTexts?: string[];
}

export type SplitEqualMode = 'smart' | 'count' | 'chars' | 'delimiter';

export type SplitEqualConfirmPayload =
  | { mode: 'count'; count: number }
  | { mode: 'chars'; texts: string[]; punctuationMode: PunctuationMode; useAcoustic?: boolean }
  | { mode: 'delimiter'; texts: string[]; delimiterLabel: string; useAcoustic?: boolean }
  | { mode: 'smart'; candidate: SmartSplitCandidate; useAcoustic: boolean };

interface SplitEqualModalProps {
  state: SplitEqualDialogState | null;
  hasAudio: boolean;
  useAcoustic: boolean;
  onToggleAcoustic: (enabled: boolean) => void;
  onCancel: () => void;
  onConfirm: (payload: SplitEqualConfirmPayload) => void;
}

const MIN_SEGMENTS = 2;
const MAX_SEGMENTS = 20;
const QUICK_PRESETS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20] as const;
const MAX_SMART_CANDIDATES = 4;
const MAX_CARD_PREVIEW_TOKENS = 10;

const DELIMITER_PRESETS: ReadonlyArray<{
  id: SplitDelimiterPreset;
  label: string;
  shortLabel: string;
}> = [
  { id: 'whitespace', label: '空格', shortLabel: '空格' },
  { id: 'comma', label: '逗号 ,', shortLabel: '逗号' },
  { id: 'enum-comma', label: '顿号 、', shortLabel: '顿号' },
  { id: 'slash', label: '斜杠 /', shortLabel: '斜杠' },
  { id: 'pipe', label: '竖线 |', shortLabel: '竖线' },
  { id: 'semicolon', label: '分号 ;', shortLabel: '分号' },
  { id: 'hyphen', label: '连字符 -', shortLabel: '连字符' },
  { id: 'custom', label: '自定义', shortLabel: '自定义' }
];

const PUNCTUATION_MODES: ReadonlyArray<{ id: PunctuationMode; label: string }> = [
  { id: 'ignore', label: '忽略标点' },
  { id: 'attach-prev', label: '并入前段' },
  { id: 'keep', label: '保留独立段' }
];

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
  hasAudio,
  useAcoustic,
  onToggleAcoustic,
  onCancel,
  onConfirm
}) => {
  const [mode, setMode] = useState<SplitEqualMode>('smart');
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>('');
  const [count, setCount] = useState<number>(4);
  const [punctuationMode, setPunctuationMode] = useState<PunctuationMode>('ignore');
  const [delimiterPreset, setDelimiterPreset] = useState<SplitDelimiterPreset>('whitespace');
  const [customDelimiter, setCustomDelimiter] = useState<string>('');
  const [stripEdgePunctuation, setStripEdgePunctuation] = useState<boolean>(true);
  const [trigraphTick, setTrigraphTick] = useState<number>(0);

  const sliderRef = useRef<HTMLInputElement>(null);
  const customDelimInputRef = useRef<HTMLInputElement>(null);
  const backdropPointerDownRef = useRef(false);
  const lastStateRef = useRef<SplitEqualDialogState | null>(null);
  const openedStateRef = useRef<SplitEqualDialogState | null>(null);
  const userPickedModeRef = useRef<boolean>(false);

  if (state) {
    lastStateRef.current = state;
  }

  const open = Boolean(state);
  const view = state ?? lastStateRef.current;

  // Prime Praat trigraph decode cache if needed when opening modal
  useEffect(() => {
    if (!open || !view?.text || !view.text.includes('\\')) return;
    if (decodeTrigraphGlossSync(view.text) !== null) return;
    let cancelled = false;
    void primeTrigraphString(view.text, getPlatformBridge()).then(() => {
      if (!cancelled) setTrigraphTick((t) => t + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [open, view?.text]);

  const decodedPraat = useMemo(() => {
    void trigraphTick;
    if (!view) return null;
    return decodeTrigraphGlossSync(view.text);
  }, [view, trigraphTick]);

  const resolvedSource = useMemo(() => {
    if (!view) return { text: '', usedDecodedPraat: false };
    return resolveSplitSourceText(view.text, decodedPraat);
  }, [view, decodedPraat]);

  const smartPlan = useMemo(() => {
    if (!view) return null;
    return inferSmartSplit(view.text, decodedPraat, {
      tierName: view.tierName,
      peerTexts: view.peerTexts,
      hasAudio
    });
  }, [view, decodedPraat, hasAudio]);

  const smartCandidates = useMemo<SmartSplitCandidate[]>(() => {
    if (!smartPlan?.primary) return [];
    return [smartPlan.primary, ...smartPlan.alternatives].slice(0, MAX_SMART_CANDIDATES);
  }, [smartPlan]);

  // Set default mode on each modal open: smart if primary exists, otherwise count
  useEffect(() => {
    if (!state) {
      openedStateRef.current = null;
      userPickedModeRef.current = false;
      return;
    }
    const primary = smartPlan?.primary ?? null;
    if (openedStateRef.current !== state) {
      openedStateRef.current = state;
      userPickedModeRef.current = false;
      setMode(primary ? 'smart' : 'count');
      setSelectedCandidateId(primary ? primary.id : '');
    } else if (!userPickedModeRef.current && primary && mode !== 'smart') {
      // Async Praat trigraph decoding resolved and unlocked a smart recommendation
      setMode('smart');
      setSelectedCandidateId(primary.id);
    }
  }, [state, smartPlan, mode]);

  const selectedCandidate = useMemo<SmartSplitCandidate | null>(() => {
    if (smartCandidates.length === 0) return null;
    return smartCandidates.find((c) => c.id === selectedCandidateId) ?? smartCandidates[0];
  }, [smartCandidates, selectedCandidateId]);

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      if (mode === 'count') {
        sliderRef.current?.focus();
      } else if (mode === 'delimiter' && delimiterPreset === 'custom') {
        customDelimInputRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, mode, delimiterPreset]);

  const charTokens = useMemo(
    () => splitTextIntoChars(resolvedSource.text, { punctuation: punctuationMode }),
    [resolvedSource.text, punctuationMode]
  );

  const delimiterTokens = useMemo(
    () =>
      splitTextByDelimiter(resolvedSource.text, {
        preset: delimiterPreset,
        customDelimiter,
        stripEdgePunctuation
      }),
    [resolvedSource.text, delimiterPreset, customDelimiter, stripEdgePunctuation]
  );

  const activeTokens =
    mode === 'smart'
      ? (selectedCandidate?.texts ?? null)
      : mode === 'chars'
        ? charTokens
        : mode === 'delimiter'
          ? delimiterTokens
          : null;

  const effectiveCount = mode === 'count' ? count : (activeTokens?.length ?? 0);
  const totalDur = view ? Math.max(0, view.xmax - view.xmin) : 0;
  const segDur = effectiveCount > 0 ? totalDur / effectiveCount : 0;
  const insufficientTokens = mode !== 'count' && effectiveCount < 2;
  const missingCustomDelimiter =
    mode === 'delimiter' && delimiterPreset === 'custom' && customDelimiter.length === 0;
  const tooShort = !insufficientTokens && (totalDur <= 0 || effectiveCount < 2 || segDur <= 1e-7);
  const canConfirm =
    !insufficientTokens &&
    !missingCustomDelimiter &&
    !tooShort &&
    (mode !== 'smart' || Boolean(selectedCandidate));

  const delimiterLabel = useMemo(() => {
    if (delimiterPreset === 'custom') {
      return customDelimiter ? `「${customDelimiter}」` : '自定义分隔符';
    }
    return DELIMITER_PRESETS.find((p) => p.id === delimiterPreset)?.shortLabel ?? '空格';
  }, [delimiterPreset, customDelimiter]);

  const handleSelectMode = (nextMode: SplitEqualMode) => {
    userPickedModeRef.current = true;
    setMode(nextMode);
  };

  const submitCurrent = () => {
    if (!canConfirm) return;
    const effectiveAcoustic = hasAudio && useAcoustic;
    if (mode === 'smart' && selectedCandidate) {
      onConfirm({
        mode: 'smart',
        candidate: selectedCandidate,
        useAcoustic: effectiveAcoustic
      });
    } else if (mode === 'count') {
      onConfirm({ mode: 'count', count });
    } else if (mode === 'chars') {
      onConfirm({
        mode: 'chars',
        texts: charTokens,
        punctuationMode,
        useAcoustic: effectiveAcoustic
      });
    } else if (mode === 'delimiter') {
      onConfirm({
        mode: 'delimiter',
        texts: delimiterTokens,
        delimiterLabel,
        useAcoustic: effectiveAcoustic
      });
    }
  };

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
        submitCurrent();
        return;
      }

      // Allow arrow keys to adjust count in count-mode without interfering with text inputs
      if (
        mode === 'count' &&
        (e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown') &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        const activeEl = document.activeElement;
        if (
          activeEl === sliderRef.current ||
          activeEl instanceof HTMLInputElement ||
          activeEl instanceof HTMLTextAreaElement
        ) {
          return;
        }
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
  });

  if (!view) return null;

  const progressPct = ((count - MIN_SEGMENTS) / (MAX_SEGMENTS - MIN_SEGMENTS)) * 100;
  const displayRawText = view.text.trim();
  const displayDecodedText = resolvedSource.usedDecodedPraat ? resolvedSource.text.trim() : '';
  const acousticActive = hasAudio && useAcoustic && mode !== 'count';

  // Schematic cells (cap grid columns at 12 so text stays readable)
  const MAX_SCHEMATIC_CELLS = 12;
  const schematicTokens =
    mode === 'count'
      ? null
      : activeTokens && activeTokens.length >= 2
        ? activeTokens
        : null;

  const confirmText =
    effectiveCount >= 2
      ? mode === 'smart'
        ? `拆分为 ${effectiveCount} 段`
        : acousticActive
          ? `拆分为 ${effectiveCount} 段`
          : `等分为 ${effectiveCount} 段`
      : mode === 'smart'
        ? '确认拆分'
        : '确认等分';

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
            <span>自定义等分</span>
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
                className={`split-equal-text-preview${displayRawText ? '' : ' is-empty'}`}
                title={displayRawText || '空白区间'}
              >
                {displayRawText ? `「${displayRawText}」` : '（空白区间）'}
              </span>
            </div>
            {resolvedSource.usedDecodedPraat && (
              <div className="split-equal-praat-row" title={displayDecodedText}>
                <span className="split-equal-praat-badge">转译音标</span>
                <span className="split-equal-praat-text">「{displayDecodedText}」</span>
              </div>
            )}
            <div className="split-equal-time-row">
              <span>
                {formatSec(view.xmin)} — {formatSec(view.xmax)}
              </span>
              <span className="split-equal-dur-total">总长 {formatDuration(totalDur)}</span>
            </div>
          </div>

          {/* Mode tabs */}
          <div className="split-equal-mode-tabs" role="tablist" aria-label="拆分方式">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'smart'}
              className={`split-equal-mode-tab${mode === 'smart' ? ' active' : ''}`}
              onClick={() => handleSelectMode('smart')}
            >
              智能推荐
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'count'}
              className={`split-equal-mode-tab${mode === 'count' ? ' active' : ''}`}
              onClick={() => handleSelectMode('count')}
            >
              指定段数
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'chars'}
              className={`split-equal-mode-tab${mode === 'chars' ? ' active' : ''}`}
              onClick={() => handleSelectMode('chars')}
            >
              按字数等分
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'delimiter'}
              className={`split-equal-mode-tab${mode === 'delimiter' ? ' active' : ''}`}
              onClick={() => handleSelectMode('delimiter')}
            >
              按分隔符分词
            </button>
          </div>

          {/* Visual equal-segment schematic */}
          <div className="split-equal-schematic-wrap" aria-hidden="true">
            {mode === 'count' ? (
              <div
                className="split-equal-schematic"
                style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
              >
                {Array.from({ length: count }, (_, idx) => (
                  <div
                    key={idx}
                    className={`split-equal-cell${idx === 0 && displayRawText ? ' has-text' : ''}`}
                  >
                    {count <= 10 ? (
                      <span className="split-equal-cell-idx">{idx + 1}</span>
                    ) : idx === 0 || idx === count - 1 ? (
                      <span className="split-equal-cell-idx">{idx + 1}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : schematicTokens ? (
              <div
                className="split-equal-schematic"
                style={{
                  gridTemplateColumns: `repeat(${Math.min(schematicTokens.length, MAX_SCHEMATIC_CELLS)}, minmax(0, 1fr))`
                }}
              >
                {schematicTokens.length <= MAX_SCHEMATIC_CELLS ? (
                  schematicTokens.map((tok, idx) => (
                    <div key={idx} className="split-equal-cell has-text" title={tok}>
                      <span className="split-equal-cell-tok">{tok}</span>
                    </div>
                  ))
                ) : (
                  <>
                    {schematicTokens.slice(0, MAX_SCHEMATIC_CELLS - 2).map((tok, idx) => (
                      <div key={idx} className="split-equal-cell has-text" title={tok}>
                        <span className="split-equal-cell-tok">{tok}</span>
                      </div>
                    ))}
                    <div className="split-equal-cell is-ellipsis">
                      <span className="split-equal-cell-idx">…</span>
                    </div>
                    <div
                      className="split-equal-cell has-text"
                      title={schematicTokens[schematicTokens.length - 1]}
                    >
                      <span className="split-equal-cell-tok">
                        {schematicTokens[schematicTokens.length - 1]}
                      </span>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="split-equal-schematic is-invalid">
                <div className="split-equal-cell">
                  <span className="split-equal-cell-idx">
                    {mode === 'smart'
                      ? '暂无智能拆分方案'
                      : missingCustomDelimiter
                        ? '请输入分隔符'
                        : '切分结果不足 2 段'}
                  </span>
                </div>
              </div>
            )}

            <div className="split-equal-schematic-axis">
              <span>{formatSec(view.xmin)}</span>
              <span className="split-equal-avg">
                {effectiveCount >= 2 ? (
                  acousticActive ? (
                    <>
                      共 <strong>{effectiveCount}</strong> 段 · 声学对齐（均约{' '}
                      <strong>{formatDuration(segDur)}</strong>）
                    </>
                  ) : (
                    <>
                      共 <strong>{effectiveCount}</strong> 段 · 每段约{' '}
                      <strong>{formatDuration(segDur)}</strong>
                    </>
                  )
                ) : (
                  '未形成有效分段'
                )}
              </span>
              <span>{formatSec(view.xmax)}</span>
            </div>

            {mode !== 'smart' && schematicTokens && schematicTokens.length > 0 && (
              <div className="split-equal-token-strip" title="切分预览">
                {schematicTokens.slice(0, 24).map((tok, idx) => (
                  <span key={idx} className="split-equal-token-chip" title={tok}>
                    {tok}
                  </span>
                ))}
                {schematicTokens.length > 24 && (
                  <span className="split-equal-token-more">
                    +{schematicTokens.length - 24} 段
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Mode-specific controls */}
          {mode === 'smart' && (
            <div className="split-equal-slider-block split-equal-smart-block">
              {smartCandidates.length > 0 ? (
                <div
                  className="split-equal-smart-list"
                  role="radiogroup"
                  aria-label="智能拆分候选方案"
                >
                  {smartCandidates.map((cand, idx) => {
                    const isSelected = selectedCandidate?.id === cand.id;
                    const visibleTokens = cand.texts.slice(0, MAX_CARD_PREVIEW_TOKENS);
                    const overflowCount = cand.texts.length - visibleTokens.length;
                    return (
                      <button
                        key={cand.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        className={`split-equal-smart-card${isSelected ? ' active' : ''}`}
                        onClick={() => setSelectedCandidateId(cand.id)}
                      >
                        <div className="split-equal-smart-head">
                          <span className="split-equal-smart-title-wrap">
                            <span className="split-equal-smart-radio-dot" aria-hidden="true" />
                            <span className="split-equal-smart-title">{cand.strategyLabel}</span>
                            {idx === 0 && (
                              <span className="split-equal-smart-rec-tag">推荐</span>
                            )}
                          </span>
                          <span className="split-equal-smart-count">{cand.texts.length} 段</span>
                        </div>
                        <div className="split-equal-smart-reason">{cand.reason}</div>
                        <div className="split-equal-smart-preview">
                          {visibleTokens.map((tok, tIdx) => (
                            <span key={tIdx} className="split-equal-smart-tok" title={tok}>
                              {tok}
                            </span>
                          ))}
                          {overflowCount > 0 && (
                            <span className="split-equal-smart-more">+{overflowCount}</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="split-equal-smart-empty">
                  {displayRawText
                    ? '当前文本为单一最小单元，暂无可推荐的自动拆分方案。请切换至「指定段数」或其他模式手动切分。'
                    : '当前为空白区间，无文本可供智能分析。请切换至「指定段数」进行均匀等分。'}
                </div>
              )}
            </div>
          )}

          {mode === 'count' && (
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
          )}

          {mode === 'chars' && (
            <div className="split-equal-slider-block">
              <div className="split-equal-option-row">
                <span className="split-equal-label">标点处理</span>
                <div className="split-equal-seg-group" role="group" aria-label="标点处理方式">
                  {PUNCTUATION_MODES.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`compact split-equal-seg-btn${punctuationMode === opt.id ? ' active' : ''}`}
                      onClick={() => setPunctuationMode(opt.id)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="split-equal-option-note">
                {resolvedSource.usedDecodedPraat
                  ? '已检测到 Praat 音标输入码，将按转译后的音标拆分，并保持送气、长音等修饰符与基字符一体。'
                  : '自动跳过空白字符，保持带附标/送气/长音修饰符的音标与生僻字完整不被截断。'}
              </div>
            </div>
          )}

          {mode === 'delimiter' && (
            <div className="split-equal-slider-block">
              <div className="split-equal-option-col">
                <span className="split-equal-label">分词符</span>
                <div className="split-equal-delim-grid" role="group" aria-label="常用分词符">
                  {DELIMITER_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`compact split-equal-delim-btn${delimiterPreset === preset.id ? ' active' : ''}`}
                      onClick={() => setDelimiterPreset(preset.id)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                {delimiterPreset === 'custom' && (
                  <input
                    ref={customDelimInputRef}
                    type="text"
                    className="split-equal-custom-input"
                    value={customDelimiter}
                    placeholder="输入自定义分词符，例如 :: 、 · 或 +"
                    aria-label="自定义分词符"
                    onChange={(e) => setCustomDelimiter(e.target.value)}
                  />
                )}
              </div>

              <div className="split-equal-option-row">
                <span className="split-equal-label">词端标点</span>
                <div className="split-equal-seg-group" role="group" aria-label="分词后标点处理">
                  <button
                    type="button"
                    className={`compact split-equal-seg-btn${stripEdgePunctuation ? ' active' : ''}`}
                    onClick={() => setStripEdgePunctuation(true)}
                  >
                    忽略首尾标点
                  </button>
                  <button
                    type="button"
                    className={`compact split-equal-seg-btn${!stripEdgePunctuation ? ' active' : ''}`}
                    onClick={() => setStripEdgePunctuation(false)}
                  >
                    保留原样
                  </button>
                </div>
              </div>

              {resolvedSource.usedDecodedPraat && (
                <div className="split-equal-option-note">
                  已检测到 Praat 音标输入码，将按转译后的音标文本执行分词。
                </div>
              )}
            </div>
          )}

          {/* Acoustic boundary alignment toggle (only when audio is loaded and not pure count mode) */}
          {hasAudio && mode !== 'count' && (
            <div className="split-equal-acoustic-box">
              <ToggleSwitch
                label={<span className="split-equal-acoustic-label">声学边界对齐</span>}
                checked={useAcoustic}
                onChange={onToggleAcoustic}
                ariaLabel="声学边界对齐"
              />
              <div className="split-equal-acoustic-note">
                根据录音能量与频谱突变自动吸附切分点，听不清时自动退回均匀等分。
              </div>
            </div>
          )}

          {missingCustomDelimiter ? (
            <div className="split-equal-warning" role="alert">
              请输入用于切分的自定义分词符。
            </div>
          ) : insufficientTokens && mode !== 'smart' ? (
            <div className="split-equal-warning" role="alert">
              {mode === 'chars'
                ? '当前文本有效字数不足 2 段，无法按字数等分。'
                : `按${delimiterLabel}切分后不足 2 段，请更换分词符。`}
            </div>
          ) : tooShort ? (
            <div className="split-equal-warning" role="alert">
              当前区间时长过短，无法等分为 {effectiveCount} 段。
            </div>
          ) : null}
        </div>

        <div className="unsaved-modal-foot split-equal-foot">
          <span className="split-equal-foot-hint">
            {mode === 'count' ? '← → 微调 · Enter 确认' : 'Enter 确认 · Esc 取消'}
          </span>
          <div className="unsaved-foot-right">
            <button type="button" data-split-action="cancel" onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              disabled={!canConfirm}
              onClick={submitCurrent}
            >
              <UiIcon name="splitEqual" size={13} />
              <span>{confirmText}</span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
