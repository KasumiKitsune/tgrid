import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPlatformBridge } from '../bridge/PlatformBridge';
import { primeTrigraphString } from '../layout/richText';
import { isComposingEvent } from '../shortcuts/registry';
import { formatQuote, formatTierLabel } from '../store/historyModel';
import { useEditorStore } from '../store/useEditorStore';
import { getElementRectScale } from '../utils/uiScale';
import { CloseIcon, UiIcon } from './Icons';

interface FindMatch {
  tierIndex: number;
  kind: 'interval' | 'point';
  itemIndex: number;
  text: string;
  tmin: number;
  tmax: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const FindReplaceBar: React.FC = () => {
  const tg = useEditorStore((s) => s.tg);
  const mode = useEditorStore((s) => s.mode);
  const findBarOpen = useEditorStore((s) => s.findBarOpen);
  const findBarReplaceMode = useEditorStore((s) => s.findBarReplaceMode);
  const openFindBar = useEditorStore((s) => s.openFindBar);
  const closeFindBar = useEditorStore((s) => s.closeFindBar);
  const setSelection = useEditorStore((s) => s.setSelection);
  const setPlayRange = useEditorStore((s) => s.setPlayRange);
  const setPlaybackTime = useEditorStore((s) => s.setPlaybackTime);
  const commitTgMutation = useEditorStore((s) => s.commitTgMutation);
  const toggleTierVisibility = useEditorStore((s) => s.toggleTierVisibility);
  const showToast = useEditorStore((s) => s.showToast);

  const [query, setQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [tierScope, setTierScope] = useState<'all' | number>('all');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [hasNavigated, setHasNavigated] = useState(false);
  const [tierMenuOpen, setTierMenuOpen] = useState(false);
  const [tierFocusIdx, setTierFocusIdx] = useState(0);

  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const tierDropdownRef = useRef<HTMLDivElement>(null);
  const tierTriggerRef = useRef<HTMLButtonElement>(null);

  const tierOptions = useMemo<Array<{ value: 'all' | number; label: string }>>(
    () => [
      { value: 'all', label: `全部层 (${tg.tiers.length})` },
      ...tg.tiers.map((tier, idx) => ({
        value: idx,
        label: `${idx + 1}. ${tier.name || '未命名'}`
      }))
    ],
    [tg.tiers]
  );

  // Close tier dropdown when bar closes or clicking outside
  useEffect(() => {
    if (!findBarOpen) setTierMenuOpen(false);
  }, [findBarOpen]);

  useEffect(() => {
    if (!tierMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (tierDropdownRef.current?.contains(e.target as Node)) return;
      setTierMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setTierMenuOpen(false);
        tierTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [tierMenuOpen]);

  // Keep tierScope valid if tiers shrink or tab switches
  useEffect(() => {
    if (tierScope !== 'all' && tierScope >= tg.tiers.length) {
      setTierScope('all');
    }
  }, [tierScope, tg.tiers.length]);

  // Auto-focus find input when opened
  useEffect(() => {
    if (!findBarOpen) return;
    const raf = requestAnimationFrame(() => {
      const el = findInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [findBarOpen]);

  // Reset navigation anchor when search parameters change
  useEffect(() => {
    setActiveIdx(0);
    setHasNavigated(false);
  }, [query, tierScope, caseSensitive, wholeWord, useRegex]);

  const { matches, regexError } = useMemo<{ matches: FindMatch[]; regexError: string | null }>(() => {
    if (!findBarOpen || query === '') {
      return { matches: [], regexError: null };
    }

    let testFn: (text: string) => boolean;

    if (useRegex) {
      try {
        const pattern = wholeWord ? `^(?:${query})$` : query;
        const re = new RegExp(pattern, caseSensitive ? '' : 'i');
        testFn = (text: string) => re.test(text);
      } catch (err) {
        return {
          matches: [],
          regexError: err instanceof Error ? err.message : '正则表达式语法错误'
        };
      }
    } else if (wholeWord) {
      const needle = caseSensitive ? query : query.toLowerCase();
      testFn = (text: string) => (caseSensitive ? text === needle : text.toLowerCase() === needle);
    } else {
      const needle = caseSensitive ? query : query.toLowerCase();
      testFn = (text: string) =>
        caseSensitive ? text.includes(needle) : text.toLowerCase().includes(needle);
    }

    const found: FindMatch[] = [];
    for (let ti = 0; ti < tg.tiers.length; ti++) {
      if (tierScope !== 'all' && ti !== tierScope) continue;
      const tier = tg.tiers[ti];
      if (tier.kind === 'intervalTier') {
        for (let ii = 0; ii < tier.intervals.length; ii++) {
          const iv = tier.intervals[ii];
          if (testFn(iv.text)) {
            found.push({
              tierIndex: ti,
              kind: 'interval',
              itemIndex: ii,
              text: iv.text,
              tmin: iv.xmin,
              tmax: iv.xmax
            });
          }
        }
      } else {
        for (let pi = 0; pi < tier.points.length; pi++) {
          const pt = tier.points[pi];
          if (testFn(pt.mark)) {
            found.push({
              tierIndex: ti,
              kind: 'point',
              itemIndex: pi,
              text: pt.mark,
              tmin: pt.number,
              tmax: pt.number
            });
          }
        }
      }
    }

    return { matches: found, regexError: null };
  }, [findBarOpen, query, tierScope, caseSensitive, wholeWord, useRegex, tg]);

  const safeActiveIdx =
    matches.length === 0 ? -1 : ((activeIdx % matches.length) + matches.length) % matches.length;

  const scrollMatchIntoView = useCallback((match: FindMatch) => {
    requestAnimationFrame(() => {
      const stageEl = document.getElementById('stage');
      const svgEl = document.getElementById('score-svg');
      if (!stageEl || !svgEl) return;
      const role = match.kind === 'interval' ? 'interval' : 'point';
      const targetEl = svgEl.querySelector<Element>(
        `[data-role="${role}"][data-tier="${match.tierIndex}"][data-idx="${match.itemIndex}"]`
      );
      if (!targetEl) return;
      const z = getElementRectScale(stageEl);
      const elemRect = targetEl.getBoundingClientRect();
      const stageRect = stageEl.getBoundingClientRect();
      const padX = 64 * z;
      const padY = 64 * z;
      if (elemRect.left < stageRect.left + padX) {
        stageEl.scrollLeft += (elemRect.left - (stageRect.left + padX)) / z;
      } else if (elemRect.right > stageRect.right - padX) {
        stageEl.scrollLeft += (elemRect.right - (stageRect.right - padX)) / z;
      }
      if (elemRect.top < stageRect.top + padY) {
        stageEl.scrollTop += (elemRect.top - (stageRect.top + padY)) / z;
      } else if (elemRect.bottom > stageRect.bottom - padY) {
        stageEl.scrollTop += (elemRect.bottom - (stageRect.bottom - padY)) / z;
      }
    });
  }, []);

  const navigateToMatch = useCallback(
    (match: FindMatch) => {
      const st = useEditorStore.getState();
      if (st.hiddenTierIndices.includes(match.tierIndex)) {
        toggleTierVisibility(match.tierIndex);
      }
      if (match.kind === 'interval') {
        setSelection({
          kind: 'interval',
          tierIndex: match.tierIndex,
          itemIndex: match.itemIndex
        });
        if (match.tmax > match.tmin) {
          setPlayRange({ start: match.tmin, end: match.tmax });
        } else {
          setPlayRange(null);
        }
        setPlaybackTime(match.tmin, true);
      } else {
        setSelection({
          kind: 'point',
          tierIndex: match.tierIndex,
          itemIndex: match.itemIndex
        });
        setPlayRange(null);
        setPlaybackTime(match.tmin, true);
      }
      scrollMatchIntoView(match);
    },
    [scrollMatchIntoView, setPlaybackTime, setPlayRange, setSelection, toggleTierVisibility]
  );

  const goNext = useCallback(() => {
    if (matches.length === 0) return;
    let nextIdx: number;
    if (!hasNavigated) {
      setHasNavigated(true);
      nextIdx = 0;
    } else {
      nextIdx = (safeActiveIdx + 1) % matches.length;
    }
    setActiveIdx(nextIdx);
    navigateToMatch(matches[nextIdx]);
  }, [matches, hasNavigated, safeActiveIdx, navigateToMatch]);

  const goPrev = useCallback(() => {
    if (matches.length === 0) return;
    let prevIdx: number;
    if (!hasNavigated) {
      setHasNavigated(true);
      prevIdx = matches.length - 1;
    } else {
      prevIdx = (safeActiveIdx - 1 + matches.length) % matches.length;
    }
    setActiveIdx(prevIdx);
    navigateToMatch(matches[prevIdx]);
  }, [matches, hasNavigated, safeActiveIdx, navigateToMatch]);

  const applyReplacement = useCallback(
    (source: string): string => {
      if (useRegex) {
        const pattern = wholeWord ? `^(?:${query})$` : query;
        const re = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
        return source.replace(re, replaceText);
      }
      if (wholeWord) {
        return replaceText;
      }
      const re = new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi');
      return source.replace(re, () => replaceText);
    },
    [query, replaceText, useRegex, wholeWord, caseSensitive]
  );

  const handleReplaceOne = useCallback(() => {
    if (mode !== 'edit' || matches.length === 0 || safeActiveIdx < 0 || regexError) return;
    const target = matches[safeActiveIdx];
    const nextText = applyReplacement(target.text);
    if (nextText === target.text) {
      goNext();
      return;
    }

    if (nextText.includes('\\')) {
      void primeTrigraphString(nextText, getPlatformBridge()).then(() =>
        useEditorStore.getState().bumpDocVersion()
      );
    }

    const tierName = formatTierLabel(tg.tiers[target.tierIndex]?.name, target.tierIndex);
    commitTgMutation(
      (_draft, ctx) => {
        const dTier = ctx.editTier(target.tierIndex);
        if (!dTier) return false;
        if (target.kind === 'interval' && dTier.kind === 'intervalTier') {
          const iv = dTier.intervals[target.itemIndex];
          if (!iv || iv.text === nextText) return false;
          iv.text = nextText;
        } else if (target.kind === 'point' && dTier.kind === 'textTier') {
          const pt = dTier.points[target.itemIndex];
          if (!pt || pt.mark === nextText) return false;
          pt.mark = nextText;
        } else {
          return false;
        }
      },
      {
        kind: target.kind,
        tierIndex: target.tierIndex,
        itemIndex: target.itemIndex
      },
      {
        type: 'replace-one',
        title: '替换标注文本',
        detail: `${tierName} · ${formatQuote(target.text)}→${formatQuote(nextText)}`,
        icon: 'replace',
        tierName,
        focusTime: target.tmin
      }
    );

    setHasNavigated(true);
  }, [mode, matches, safeActiveIdx, regexError, applyReplacement, goNext, commitTgMutation, tg.tiers]);

  const handleReplaceAll = useCallback(() => {
    if (mode !== 'edit' || matches.length === 0 || regexError) return;

    let changedCount = 0;
    const snapshot = matches.map((m) => ({ ...m }));
    const updates: Array<{ match: FindMatch; nextText: string }> = [];
    for (const m of snapshot) {
      const nextText = applyReplacement(m.text);
      if (nextText !== m.text) {
        updates.push({ match: m, nextText });
        changedCount++;
      }
    }

    if (changedCount === 0) {
      showToast('没有需要替换的内容');
      return;
    }

    commitTgMutation(
      (_draft, ctx) => {
        let applied = 0;
        for (const { match, nextText } of updates) {
          const dTier = ctx.editTier(match.tierIndex);
          if (!dTier) continue;
          if (match.kind === 'interval' && dTier.kind === 'intervalTier') {
            const iv = dTier.intervals[match.itemIndex];
            if (iv && iv.text !== nextText) {
              iv.text = nextText;
              applied++;
            }
          } else if (match.kind === 'point' && dTier.kind === 'textTier') {
            const pt = dTier.points[match.itemIndex];
            if (pt && pt.mark !== nextText) {
              pt.mark = nextText;
              applied++;
            }
          }
        }
        if (applied === 0) return false;
      },
      undefined,
      {
        type: 'replace-all',
        title: '批量替换文本',
        detail: `共替换 ${changedCount} 处 · ${formatQuote(query)}→${formatQuote(replaceText)}`,
        icon: 'replace'
      }
    );

    if (replaceText.includes('\\')) {
      void primeTrigraphString(replaceText, getPlatformBridge()).then(() =>
        useEditorStore.getState().bumpDocVersion()
      );
    }

    showToast(`已替换 ${changedCount} 处标注文本`);
  }, [mode, matches, regexError, applyReplacement, commitTgMutation, replaceText, showToast]);

  if (!findBarOpen) return null;

  const countLabel =
    matches.length === 0
      ? '0 / 0'
      : hasNavigated
        ? `${safeActiveIdx + 1} / ${matches.length}`
        : `— / ${matches.length}`;
  const countClass = `find-replace-count ${query && matches.length === 0 ? 'no-match' : ''}`;
  const isReadOnly = mode !== 'edit';
  const canReplace = !isReadOnly && matches.length > 0 && !regexError;

  return (
    <div
      className="find-replace-bar"
      role="search"
      aria-label="跨层查找与替换"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Find Row */}
      <div className="find-replace-row">
        <button
          type="button"
          className="find-replace-btn icon-only"
          title={findBarReplaceMode ? '收起替换栏' : '展开替换栏'}
          aria-expanded={findBarReplaceMode}
          aria-label={findBarReplaceMode ? '收起替换栏' : '展开替换栏'}
          onClick={() => openFindBar(!findBarReplaceMode)}
        >
          <span
            style={{
              display: 'inline-flex',
              transform: findBarReplaceMode ? 'rotate(90deg)' : 'none',
              transition: 'transform 140ms ease'
            }}
          >
            <UiIcon name="section-chevron" size={12} />
          </span>
        </button>

        <div className="find-replace-input-wrap">
          <input
            ref={findInputRef}
            type="text"
            className="find-replace-input"
            placeholder="查找标注文本…"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (isComposingEvent(e)) return;
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeFindBar();
                return;
              }
              if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') {
                e.preventDefault();
                e.stopPropagation();
                if (e.shiftKey) goPrev();
                else goNext();
              }
            }}
          />
        </div>

        <div className="find-replace-toggles" role="group" aria-label="查找选项">
          <button
            type="button"
            className={`find-replace-toggle ${caseSensitive ? 'active' : ''}`}
            aria-pressed={caseSensitive}
            title="区分大小写"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            Aa
          </button>
          <button
            type="button"
            className={`find-replace-toggle ${wholeWord ? 'active' : ''}`}
            aria-pressed={wholeWord}
            title="全词精确匹配"
            onClick={() => setWholeWord((v) => !v)}
          >
            全词
          </button>
          <button
            type="button"
            className={`find-replace-toggle ${useRegex ? 'active' : ''}`}
            aria-pressed={useRegex}
            title="使用正则表达式"
            onClick={() => setUseRegex((v) => !v)}
          >
            .*
          </button>
        </div>

        <span className={countClass} aria-live="polite">
          {countLabel}
        </span>

        <div className="find-replace-actions">
          <button
            type="button"
            className="find-replace-btn icon-only"
            title="上一个匹配 (Shift+Enter)"
            aria-label="上一个匹配"
            disabled={matches.length === 0}
            onClick={goPrev}
          >
            <UiIcon name="up" size={12} />
          </button>
          <button
            type="button"
            className="find-replace-btn icon-only"
            title="下一个匹配 (Enter)"
            aria-label="下一个匹配"
            disabled={matches.length === 0}
            onClick={goNext}
          >
            <UiIcon name="down" size={12} />
          </button>
        </div>

        <button
          type="button"
          className="find-replace-close"
          title="关闭查找栏 (Esc)"
          aria-label="关闭查找栏"
          onClick={closeFindBar}
        >
          <CloseIcon size={12} />
        </button>
      </div>

      {/* Replace Row */}
      {findBarReplaceMode && (
        <div className="find-replace-row">
          <span style={{ width: 24, flexShrink: 0 }} aria-hidden="true" />
          <div className="find-replace-input-wrap">
            <input
              ref={replaceInputRef}
              type="text"
              className="find-replace-input"
              placeholder={isReadOnly ? '只读模式下不可替换' : '替换为…'}
              spellCheck={false}
              disabled={isReadOnly}
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              onKeyDown={(e) => {
                if (isComposingEvent(e)) return;
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  closeFindBar();
                  return;
                }
                if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') {
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.ctrlKey || e.metaKey || e.altKey) handleReplaceAll();
                  else handleReplaceOne();
                }
              }}
            />
          </div>

          <div className="find-replace-actions">
            <button
              type="button"
              className="find-replace-btn"
              disabled={!canReplace}
              title={isReadOnly ? '请先切换至编辑模式' : '替换当前匹配项 (Enter)'}
              onClick={handleReplaceOne}
            >
              <UiIcon name="replace" size={12} />
              <span>替换</span>
            </button>
            <button
              type="button"
              className="find-replace-btn"
              disabled={!canReplace}
              title={isReadOnly ? '请先切换至编辑模式' : '单步替换全部匹配项（可撤销）'}
              onClick={handleReplaceAll}
            >
              全部替换
            </button>
          </div>
        </div>
      )}

      {/* Regex syntax error */}
      {regexError && <div className="find-replace-err">正则错误：{regexError}</div>}

      {/* Tier scope & subtle hint */}
      <div className="find-replace-meta-row">
        <div className="find-replace-tier-dropdown" ref={tierDropdownRef}>
          <button
            ref={tierTriggerRef}
            type="button"
            className={`find-replace-tier-trigger ${tierMenuOpen ? 'open' : ''}`}
            aria-label="查找层级范围"
            aria-haspopup="listbox"
            aria-expanded={tierMenuOpen}
            onClick={() => {
              if (tierMenuOpen) {
                setTierMenuOpen(false);
              } else {
                const selIdx = tierOptions.findIndex((o) => o.value === tierScope);
                setTierFocusIdx(selIdx >= 0 ? selIdx : 0);
                setTierMenuOpen(true);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                if (!tierMenuOpen) {
                  const selIdx = tierOptions.findIndex((o) => o.value === tierScope);
                  setTierFocusIdx(selIdx >= 0 ? selIdx : 0);
                  setTierMenuOpen(true);
                } else {
                  setTierFocusIdx((i) => (i + 1) % tierOptions.length);
                }
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                if (!tierMenuOpen) {
                  const selIdx = tierOptions.findIndex((o) => o.value === tierScope);
                  setTierFocusIdx(selIdx >= 0 ? selIdx : tierOptions.length - 1);
                  setTierMenuOpen(true);
                } else {
                  setTierFocusIdx((i) => (i - 1 + tierOptions.length) % tierOptions.length);
                }
              } else if (e.key === 'Home' && tierMenuOpen) {
                e.preventDefault();
                e.stopPropagation();
                setTierFocusIdx(0);
              } else if (e.key === 'End' && tierMenuOpen) {
                e.preventDefault();
                e.stopPropagation();
                setTierFocusIdx(tierOptions.length - 1);
              } else if ((e.key === 'Enter' || e.key === ' ') && tierMenuOpen) {
                e.preventDefault();
                e.stopPropagation();
                const chosen = tierOptions[tierFocusIdx];
                if (chosen) setTierScope(chosen.value);
                setTierMenuOpen(false);
              } else if (e.key === 'Escape' && tierMenuOpen) {
                e.preventDefault();
                e.stopPropagation();
                setTierMenuOpen(false);
              }
            }}
          >
            <span className="find-replace-tier-trigger-label">
              {tierOptions.find((o) => o.value === tierScope)?.label ?? `全部层 (${tg.tiers.length})`}
            </span>
            <span className="find-replace-tier-chevron" aria-hidden="true">
              <UiIcon name="section-chevron" size={10} />
            </span>
          </button>

          {tierMenuOpen && (
            <div className="find-replace-tier-menu" role="listbox" aria-label="查找层级范围">
              {tierOptions.map((opt, idx) => {
                const isSelected = opt.value === tierScope;
                const isFocused = idx === tierFocusIdx;
                return (
                  <button
                    key={String(opt.value)}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`find-replace-tier-option ${isSelected ? 'is-selected' : ''} ${
                      isFocused ? 'is-focused' : ''
                    }`}
                    onMouseEnter={() => setTierFocusIdx(idx)}
                    onClick={() => {
                      setTierScope(opt.value);
                      setTierMenuOpen(false);
                      tierTriggerRef.current?.focus();
                    }}
                  >
                    <span className="find-replace-tier-option-text">{opt.label}</span>
                    {isSelected && (
                      <span className="find-replace-tier-check" aria-hidden="true">
                        <UiIcon name="check" size={11} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <span>
          {findBarReplaceMode && isReadOnly
            ? '当前为只读模式，切至编辑后可替换'
            : 'Enter 下一处 · Shift+Enter 上一处'}
        </span>
      </div>
    </div>
  );
};
