import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  IPA_POPOVER_PAGE_SIZE,
  formatIpaDisplayGlyph,
  type IpaImeState
} from './useIpaIme';

interface IpaModePillProps {
  ime: IpaImeState;
  style?: React.CSSProperties;
  className?: string;
}

export const IpaModePill: React.FC<IpaModePillProps> = ({ ime, style, className = '' }) => {
  if (ime.ipaMode === 'off') return null;

  const stateClass = ime.ipaTempEn
    ? 'is-en'
    : ime.ipaMode === 'praat'
      ? 'is-praat'
      : '';

  return (
    <button
      type="button"
      tabIndex={-1}
      className={`ipa-mode-pill ${stateClass} ${className}`.trim()}
      style={style}
      title={
        ime.ipaMode === 'yunlong'
          ? '点击或轻按 Shift 临时切换英文 / 云龙国际音标（Ctrl+\\ 切换方案）'
          : '点击临时切换英文 / Praat \\xx 输入（Ctrl+\\ 切换方案）'
      }
      onMouseDown={(e) => {
        e.preventDefault();
        ime.toggleTempEn();
      }}
    >
      {ime.ipaTempEn ? 'EN' : ime.ipaMode === 'yunlong' ? '云龙 IPA' : 'Praat \\xx'}
    </button>
  );
};

interface IpaImePopoverProps {
  ime: IpaImeState;
}

export const IpaImePopover: React.FC<IpaImePopoverProps> = ({ ime }) => {
  const popRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!ime.showPopover || !ime.anchorRect) {
      setCoords(null);
      return;
    }
    const anchor = ime.anchorRect;
    const el = popRef.current;
    const popW = el ? Math.max(el.offsetWidth, 236) : 256;
    const popH = el ? Math.max(el.offsetHeight, 180) : 220;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Clamp horizontally so popover near right edge of sidebar never clips off-screen
    const left = Math.max(8, Math.min(vw - popW - 8, anchor.left));

    // Place below anchor when room permits, otherwise flip cleanly above
    const spaceBelow = vh - anchor.bottom - 8;
    const top =
      spaceBelow >= popH
        ? Math.min(vh - popH - 8, anchor.bottom + 6)
        : Math.max(8, anchor.top - popH - 6);

    setCoords({ left: Math.round(left), top: Math.round(top) });
  }, [
    ime.showPopover,
    ime.anchorRect,
    ime.ylBuf,
    ime.ylCands.length,
    ime.prPrefix,
    ime.prMatches.length,
    ime.popPage
  ]);

  if (!ime.showPopover || !ime.anchorRect) return null;

  const isYunlong = Boolean(ime.ylBuf);
  const totalCount = isYunlong ? ime.ylCands.length : ime.prMatches.length;
  const start = ime.popPage * IPA_POPOVER_PAGE_SIZE;
  const ylSlice = isYunlong ? ime.ylCands.slice(start, start + IPA_POPOVER_PAGE_SIZE) : [];
  const prSlice = !isYunlong ? ime.prMatches.slice(start, start + IPA_POPOVER_PAGE_SIZE) : [];

  const fallbackLeft = Math.max(8, Math.min(window.innerWidth - 264, Math.round(ime.anchorRect.left)));
  const fallbackTop = Math.max(
    8,
    Math.min(window.innerHeight - 230, Math.round(ime.anchorRect.bottom + 6))
  );

  const pos = coords ?? { left: fallbackLeft, top: fallbackTop };

  const node = (
    <div
      ref={popRef}
      className="ipa-popover visible"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="ipa-pop-head">
        <span className="ipa-pop-buf">{isYunlong ? ime.ylBuf : `\\${ime.prPrefix ?? ''}`}</span>
        <span className="ipa-pop-meta">
          <span>{isYunlong ? '云龙音标' : 'Praat \\xx'}</span>
          {ime.totalPages > 1 ? (
            <>
              <button
                type="button"
                className="ipa-pop-page-btn"
                disabled={ime.popPage === 0}
                title="上一页 (PageUp / -)"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => ime.stepPopPage(-1)}
              >
                ‹
              </button>
              <span>
                {ime.popPage + 1}/{ime.totalPages}
              </span>
              <button
                type="button"
                className="ipa-pop-page-btn"
                disabled={ime.popPage >= ime.totalPages - 1}
                title="下一页 (PageDown / =)"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => ime.stepPopPage(1)}
              >
                ›
              </button>
            </>
          ) : (
            <span>{totalCount} 项</span>
          )}
        </span>
      </div>
      <div className="ipa-pop-list">
        {isYunlong
          ? ylSlice.map((c, idx) => (
              <div
                key={`${c.code}-${start + idx}`}
                className={`ipa-pop-item ${idx === ime.popIdx ? 'active' : ''}`}
                onClick={() => ime.selectCandidate(c.text)}
              >
                <span className="ipa-pop-idx">{idx + 1}</span>
                <span className="ipa-pop-glyph">{formatIpaDisplayGlyph(c.text)}</span>
                <span className="ipa-pop-desc">{c.code}</span>
                {c.suffix && <span className="ipa-pop-suffix">+{c.suffix}</span>}
              </div>
            ))
          : prSlice.map((m, idx) => (
              <div
                key={`${m.code}-${start + idx}`}
                className={`ipa-pop-item ${idx === ime.popIdx ? 'active' : ''}`}
                onClick={() => ime.selectCandidate(m.ch)}
              >
                <span className="ipa-pop-idx">{idx + 1}</span>
                <span className="ipa-pop-glyph">{formatIpaDisplayGlyph(m.ch)}</span>
                <span className="ipa-pop-desc">\{m.code}</span>
              </div>
            ))}
      </div>
      <div className="ipa-pop-foot">
        {isYunlong ? (
          <>
            <span>Space 选定 · Alt+1–6 快选{ime.totalPages > 1 ? ' · -/= 翻页' : ''}</span>
            <span>Ctrl+Enter 原码</span>
          </>
        ) : (
          <>
            <span>补齐第2字符自动转 · Alt+1–6 快选</span>
            <span>\\ 输入反斜杠</span>
          </>
        )}
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
};
