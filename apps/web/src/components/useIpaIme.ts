import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getPlatformBridge,
  type IpaCandidate,
  type PraatMatch
} from '../bridge/PlatformBridge';
import { splitGraphemes } from '../layout/richText';
import { matchesShortcut } from '../shortcuts/registry';
import { useEditorStore, type IpaInputMode } from '../store/useEditorStore';

const CONSONANT_BASES = new Set(
  Array.from(
    'bcdfghjklmnpqrstvwxzʈɖɟɡɢʔʡɱɳɲŋɴʙʀɾɽⱱɺɸβθðʃʒʂʐçʝɣχʁħʕʜʢɦɧʋɹɻɰʍɥɕʑɭʎʟɫɬɮɓɗᶑʄɠʛʘǀǃǂǁȶȡȵȴ'
  )
);

export function findSmartTieBarSplit(before: string): { splitAt: number } | null {
  if (!before || before.length < 2) return null;
  const gs = splitGraphemes(before);
  if (gs.length < 2) return null;
  const g1 = gs[gs.length - 2];
  const g2 = gs[gs.length - 1];
  const b1 = Array.from(g1)[0];
  const b2 = Array.from(g2)[0];
  if (
    !g1.includes('\u0361') &&
    !g1.includes('\u035C') &&
    !g2.includes('\u0361') &&
    !g2.includes('\u035C') &&
    CONSONANT_BASES.has(b1) &&
    CONSONANT_BASES.has(b2)
  ) {
    return { splitAt: before.length - g2.length };
  }
  return null;
}

export const IPA_POPOVER_PAGE_SIZE = 6;

export function isCombiningDiacritic(sym: string): boolean {
  if (!sym || sym.length === 0) return false;
  const cp = sym.codePointAt(0) || 0;
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff)
  );
}

export function formatIpaDisplayGlyph(sym: string): string {
  if (!sym) return '';
  if (sym === '\u0361') return '\u25CC\u0361\u25CC';
  if (sym === '\u035C') return '\u25CC\u035C\u25CC';
  if (isCombiningDiacritic(sym)) return '\u25CC' + sym;
  return sym;
}

export function isIpaRelatedElement(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(
    el.closest('.ipa-dock') ||
      el.closest('.ipa-popover') ||
      el.closest('.ipa-mode-pill') ||
      el.closest('.ipa-ctrl-noblur') ||
      el.closest('.context-menu')
  );
}

export interface UseIpaImeOptions {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChangeValue: (nextVal: string) => void;
  active?: boolean;
  onUnhandledKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

export interface IpaImeState {
  ipaMode: IpaInputMode;
  ipaTempEn: boolean;
  ylBuf: string;
  ylCands: IpaCandidate[];
  prPrefix: string | null;
  prMatches: PraatMatch[];
  popPage: number;
  totalPages: number;
  popIdx: number;
  showPopover: boolean;
  anchorRect: DOMRect | null;
  insertAtCaret: (sym: string, isTieBar?: boolean) => boolean;
  clearComposing: () => void;
  resolvePendingValue: () => string;
  selectCandidate: (text: string) => void;
  stepPopPage: (delta: -1 | 1) => void;
  toggleTempEn: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onKeyUp: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
}

export function useIpaIme({
  textareaRef,
  value,
  onChangeValue,
  active = true,
  onUnhandledKeyDown
}: UseIpaImeOptions): IpaImeState {
  const ipaMode = useEditorStore((s) => s.ipaMode);
  const cycleIpaMode = useEditorStore((s) => s.cycleIpaMode);
  const customShortcuts = useEditorStore((s) => s.customShortcuts);

  const osComposingRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  const [ipaTempEn, setIpaTempEn] = useState(false);
  const [ylBuf, setYlBuf] = useState('');
  const [ylCands, setYlCands] = useState<IpaCandidate[]>([]);
  const [prPrefix, setPrPrefix] = useState<string | null>(null);
  const [prMatches, setPrMatches] = useState<PraatMatch[]>([]);
  const [popPage, setPopPage] = useState(0);
  const [popIdx, setPopIdx] = useState(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const ylBufRef = useRef(ylBuf);
  ylBufRef.current = ylBuf;
  const ylCandsRef = useRef(ylCands);
  ylCandsRef.current = ylCands;
  const prPrefixRef = useRef(prPrefix);
  prPrefixRef.current = prPrefix;
  const prMatchesRef = useRef(prMatches);
  prMatchesRef.current = prMatches;
  const popPageRef = useRef(popPage);
  popPageRef.current = popPage;
  const popIdxRef = useRef(popIdx);
  popIdxRef.current = popIdx;

  const refreshAnchorRect = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      setAnchorRect(el.getBoundingClientRect());
    }
  }, [textareaRef]);

  const clearComposing = useCallback(() => {
    setYlBuf('');
    setYlCands([]);
    setPrPrefix(null);
    setPrMatches([]);
    setPopPage(0);
    setPopIdx(0);
    ylBufRef.current = '';
    ylCandsRef.current = [];
    prPrefixRef.current = null;
    prMatchesRef.current = [];
    popPageRef.current = 0;
    popIdxRef.current = 0;
  }, []);

  const totalItems = ylBuf ? ylCands.length : prPrefix !== null ? prMatches.length : 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / IPA_POPOVER_PAGE_SIZE));

  const stepPopPage = useCallback((delta: -1 | 1) => {
    const len = ylBufRef.current
      ? ylCandsRef.current.length
      : prPrefixRef.current !== null
        ? prMatchesRef.current.length
        : 0;
    const pages = Math.max(1, Math.ceil(len / IPA_POPOVER_PAGE_SIZE));
    const nextPage = Math.max(0, Math.min(pages - 1, popPageRef.current + delta));
    popPageRef.current = nextPage;
    popIdxRef.current = 0;
    setPopPage(nextPage);
    setPopIdx(0);
  }, []);

  // Reset composing buffers & temporary English toggle if mode changes or input becomes inactive
  useEffect(() => {
    clearComposing();
    setIpaTempEn(false);
  }, [ipaMode, active, clearComposing]);

  const showPopover = Boolean(active && (ylBuf || prPrefix !== null));

  // Keep popover anchored if the viewport resizes or a scroll container moves
  useEffect(() => {
    if (!showPopover) return;
    refreshAnchorRect();
    const onRelayout = () => refreshAnchorRect();
    window.addEventListener('resize', onRelayout);
    window.addEventListener('scroll', onRelayout, true);
    return () => {
      window.removeEventListener('resize', onRelayout);
      window.removeEventListener('scroll', onRelayout, true);
    };
  }, [showPopover, refreshAnchorRect]);

  const insertAtCaret = useCallback(
    (sym: string, isTieBar = false): boolean => {
      const el = textareaRef.current;
      if (!el) return false;
      const curVal = valueRef.current;
      const start = el.selectionStart ?? curVal.length;
      const end = el.selectionEnd ?? curVal.length;
      let nextVal = '';
      let nextCaret = start + sym.length;
      if (isTieBar && start === end) {
        const split = findSmartTieBarSplit(curVal.slice(0, start));
        if (split) {
          nextVal = curVal.slice(0, split.splitAt) + sym + curVal.slice(split.splitAt);
          nextCaret = start + sym.length;
        } else {
          nextVal = curVal.slice(0, start) + sym + curVal.slice(end);
        }
      } else {
        nextVal = curVal.slice(0, start) + sym + curVal.slice(end);
      }
      valueRef.current = nextVal;
      onChangeValue(nextVal);
      requestAnimationFrame(() => {
        if (!textareaRef.current) return;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextCaret, nextCaret);
      });
      return true;
    },
    [textareaRef, onChangeValue]
  );

  const selectCandidate = useCallback(
    (text: string) => {
      insertAtCaret(text);
      clearComposing();
    },
    [insertAtCaret, clearComposing]
  );

  const resolvePendingValue = useCallback((): string => {
    const curVal = valueRef.current;
    const buf = ylBufRef.current;
    const cands = ylCandsRef.current;
    const pfx = prPrefixRef.current;
    let commitStr = '';
    if (buf && cands.length > 0) {
      const globalIdx = popPageRef.current * IPA_POPOVER_PAGE_SIZE + popIdxRef.current;
      commitStr = cands[globalIdx]?.text || cands[0].text;
    } else if (pfx !== null) {
      commitStr = '\\' + pfx;
    }
    if (!commitStr) return curVal;
    const el = textareaRef.current;
    if (el) {
      const start = el.selectionStart ?? curVal.length;
      const end = el.selectionEnd ?? curVal.length;
      return curVal.slice(0, start) + commitStr + curVal.slice(end);
    }
    return curVal + commitStr;
  }, [textareaRef]);

  const toggleTempEn = useCallback(() => {
    if (ylBufRef.current && ylCandsRef.current.length > 0) {
      const gIdx = popPageRef.current * IPA_POPOVER_PAGE_SIZE + popIdxRef.current;
      insertAtCaret(ylCandsRef.current[gIdx]?.text || ylCandsRef.current[0].text);
    }
    clearComposing();
    setIpaTempEn((v) => !v);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [insertAtCaret, clearComposing, textareaRef]);

  const handleKeyDownAsync = useCallback(
    async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (osComposingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;

      if (matchesShortcut('ipa-cycle', e, customShortcuts)) {
        e.preventDefault();
        e.stopPropagation();
        clearComposing();
        cycleIpaMode();
        return;
      }

      if (ipaMode !== 'off' && matchesShortcut('ipa-temp-en', e, customShortcuts)) {
        e.preventDefault();
        e.stopPropagation();
        toggleTempEn();
        return;
      }

      const curYlBuf = ylBufRef.current;
      const curYlCands = ylCandsRef.current;
      const curPrPrefix = prPrefixRef.current;
      const curPrMatches = prMatchesRef.current;
      const curPopPage = popPageRef.current;
      const curPopIdx = popIdxRef.current;

      // Active IPA popover navigation & selection
      const isPopOpen = Boolean(curYlBuf || curPrPrefix !== null);
      const popListLen = curYlBuf ? curYlCands.length : curPrPrefix !== null ? curPrMatches.length : 0;
      const curTotalPages = Math.max(1, Math.ceil(popListLen / IPA_POPOVER_PAGE_SIZE));

      // Alt + 1..6 quick candidate selection (conflict-free with Chao tone digits & Praat codes)
      if (isPopOpen && popListLen > 0 && e.altKey && !e.ctrlKey && !e.metaKey) {
        const digit =
          e.key >= '1' && e.key <= '6'
            ? parseInt(e.key, 10)
            : /^Digit[1-6]$/.test(e.code)
              ? parseInt(e.code.slice(5), 10)
              : 0;
        if (digit >= 1 && digit <= IPA_POPOVER_PAGE_SIZE) {
          const targetIdx = curPopPage * IPA_POPOVER_PAGE_SIZE + (digit - 1);
          if (curYlBuf && curYlCands[targetIdx]) {
            e.preventDefault();
            insertAtCaret(curYlCands[targetIdx].text);
            clearComposing();
            return;
          }
          if (curPrPrefix !== null && curPrMatches[targetIdx]) {
            e.preventDefault();
            insertAtCaret(curPrMatches[targetIdx].ch);
            clearComposing();
            return;
          }
        }
      }

      if (isPopOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          clearComposing();
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (popListLen > 0) {
            e.preventDefault();
            let cur = curPopPage * IPA_POPOVER_PAGE_SIZE + curPopIdx + (e.key === 'ArrowDown' ? 1 : -1);
            if (cur < 0) cur = popListLen - 1;
            if (cur >= popListLen) cur = 0;
            const nextPage = Math.floor(cur / IPA_POPOVER_PAGE_SIZE);
            const nextIdx = cur % IPA_POPOVER_PAGE_SIZE;
            popPageRef.current = nextPage;
            popIdxRef.current = nextIdx;
            setPopPage(nextPage);
            setPopIdx(nextIdx);
            return;
          }
        }
        if (e.key === 'PageDown' || e.key === 'PageUp') {
          if (popListLen > 0) {
            e.preventDefault();
            const nextPage =
              e.key === 'PageDown'
                ? Math.min(curTotalPages - 1, curPopPage + 1)
                : Math.max(0, curPopPage - 1);
            popPageRef.current = nextPage;
            popIdxRef.current = 0;
            setPopPage(nextPage);
            setPopIdx(0);
            return;
          }
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          const raw = curYlBuf ? curYlBuf : '\\' + (curPrPrefix ?? '');
          clearComposing();
          if (raw) insertAtCaret(raw);
          return;
        }
        if (e.key === ' ' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey)) {
          e.preventDefault();
          const globalIdx = curPopPage * IPA_POPOVER_PAGE_SIZE + curPopIdx;
          if (curYlBuf && curYlCands[globalIdx]) {
            insertAtCaret(curYlCands[globalIdx].text);
            clearComposing();
          } else if (curPrPrefix !== null && curPrMatches[globalIdx]) {
            insertAtCaret(curPrMatches[globalIdx].ch);
            clearComposing();
          }
          return;
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          if (curYlBuf) {
            const nextBuf = curYlBuf.slice(0, -1);
            if (!nextBuf) {
              clearComposing();
            } else {
              ylBufRef.current = nextBuf;
              setYlBuf(nextBuf);
              const cands = await getPlatformBridge().getYunlongCandidates(nextBuf);
              ylCandsRef.current = cands;
              setYlCands(cands);
              popPageRef.current = 0;
              popIdxRef.current = 0;
              setPopPage(0);
              setPopIdx(0);
              refreshAnchorRect();
            }
          } else if (curPrPrefix !== null) {
            if (curPrPrefix === '') {
              clearComposing();
            } else {
              prPrefixRef.current = '';
              setPrPrefix('');
              const ms = await getPlatformBridge().getPraatMatches();
              prMatchesRef.current = ms;
              setPrMatches(ms);
              popPageRef.current = 0;
              popIdxRef.current = 0;
              setPopPage(0);
              setPopIdx(0);
              refreshAnchorRect();
            }
          }
          return;
        }
      }

      // Yunlong / Praat \xx character interception
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && !ipaTempEn) {
        if (ipaMode === 'yunlong') {
          // '-' / '=' pagination when multi-page and not a valid prefix extension
          if (
            curYlBuf &&
            (e.key === '-' || e.key === '=') &&
            curTotalPages > 1 &&
            !curYlCands.some((c) => c.suffix.startsWith(e.key))
          ) {
            e.preventDefault();
            const nextPage =
              e.key === '-'
                ? Math.max(0, curPopPage - 1)
                : Math.min(curTotalPages - 1, curPopPage + 1);
            popPageRef.current = nextPage;
            popIdxRef.current = 0;
            setPopPage(nextPage);
            setPopIdx(0);
            return;
          }

          e.preventDefault();
          refreshAnchorRect();
          const res = await getPlatformBridge().stepYunlongChar(curYlBuf, e.key);
          if (res.action === 'passthrough') {
            insertAtCaret(e.key);
            clearComposing();
          } else if (res.action === 'commit' || res.action === 'commit_and_literal') {
            if (res.commit) insertAtCaret(res.commit);
            clearComposing();
          } else if (res.action === 'compose' || res.action === 'commit_and_compose') {
            if (res.commit) insertAtCaret(res.commit);
            ylBufRef.current = res.buffer;
            setYlBuf(res.buffer);
            const cands = await getPlatformBridge().getYunlongCandidates(res.buffer);
            ylCandsRef.current = cands;
            setYlCands(cands);
            popPageRef.current = 0;
            popIdxRef.current = 0;
            setPopPage(0);
            setPopIdx(0);
            refreshAnchorRect();
          }
          return;
        }

        if (ipaMode === 'praat') {
          if (curPrPrefix === null && e.key === '\\') {
            e.preventDefault();
            refreshAnchorRect();
            prPrefixRef.current = '';
            setPrPrefix('');
            const ms = await getPlatformBridge().getPraatMatches();
            prMatchesRef.current = ms;
            setPrMatches(ms);
            popPageRef.current = 0;
            popIdxRef.current = 0;
            setPopPage(0);
            setPopIdx(0);
            return;
          }
          if (curPrPrefix === '') {
            e.preventDefault();
            if (e.key === '\\') {
              clearComposing();
              insertAtCaret('\\');
              return;
            }
            refreshAnchorRect();
            prPrefixRef.current = e.key;
            setPrPrefix(e.key);
            const ms = await getPlatformBridge().getPraatMatches(e.key);
            if (ms.length === 0) {
              insertAtCaret('\\' + e.key);
              clearComposing();
            } else {
              prMatchesRef.current = ms;
              setPrMatches(ms);
              popPageRef.current = 0;
              popIdxRef.current = 0;
              setPopPage(0);
              setPopIdx(0);
            }
            return;
          }
          if (curPrPrefix !== null && curPrPrefix.length === 1) {
            if (
              (e.key === '-' || e.key === '=') &&
              curTotalPages > 1 &&
              !curPrMatches.some((m) => m.code[1] === e.key)
            ) {
              e.preventDefault();
              const nextPage =
                e.key === '-'
                  ? Math.max(0, curPopPage - 1)
                  : Math.min(curTotalPages - 1, curPopPage + 1);
              popPageRef.current = nextPage;
              popIdxRef.current = 0;
              setPopPage(nextPage);
              setPopIdx(0);
              return;
            }
            e.preventDefault();
            if (e.key === '\\') {
              insertAtCaret('\\' + curPrPrefix);
              refreshAnchorRect();
              prPrefixRef.current = '';
              setPrPrefix('');
              const ms = await getPlatformBridge().getPraatMatches();
              prMatchesRef.current = ms;
              setPrMatches(ms);
              popPageRef.current = 0;
              popIdxRef.current = 0;
              setPopPage(0);
              setPopIdx(0);
              return;
            }
            const seq = '\\' + curPrPrefix + e.key;
            const dec = await getPlatformBridge().decodePraatTrigraphs(seq);
            insertAtCaret(dec.changed ? dec.text : seq);
            clearComposing();
            return;
          }
        }
      }

      onUnhandledKeyDown?.(e);
    },
    [
      clearComposing,
      customShortcuts,
      cycleIpaMode,
      insertAtCaret,
      ipaMode,
      ipaTempEn,
      onUnhandledKeyDown,
      refreshAnchorRect,
      toggleTempEn
    ]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      void handleKeyDownAsync(e);
    },
    [handleKeyDownAsync]
  );

  const onKeyUp = useCallback((_e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Bare Shift toggle intentionally removed to avoid conflicts with OS IME switching
  }, []);

  const onCompositionStart = useCallback(() => {
    osComposingRef.current = true;
    clearComposing();
  }, [clearComposing]);

  const onCompositionEnd = useCallback(() => {
    osComposingRef.current = false;
  }, []);

  return {
    ipaMode,
    ipaTempEn,
    ylBuf,
    ylCands,
    prPrefix,
    prMatches,
    popPage,
    totalPages,
    popIdx,
    showPopover,
    anchorRect,
    insertAtCaret,
    clearComposing,
    resolvePendingValue,
    selectCandidate,
    stepPopPage,
    toggleTempEn,
    onKeyDown,
    onKeyUp,
    onCompositionStart,
    onCompositionEnd
  };
}
