import type { PlatformBridge, TextGrid } from '../bridge/types';
import { isValidPraatTrigraphAt } from './praatTrigraphCodes';

export const IPA_FONT_STACK =
  '"TGrid IPA Sans", "Andika", "Charis SIL", "Doulos SIL", "Gentium Plus", "Gentium Book Plus", "Segoe UI", "Lucida Grande", "Helvetica Neue", "Geneva", "Cambria", "Lucida Sans Unicode", "Noto Sans", "DejaVu Sans", "Liberation Sans", "FreeSans", "Inter", "Noto Sans CJK SC", "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols 2", sans-serif';
export const SERIF_FONT_STACK =
  '"TGrid IPA Serif", "Charis SIL", "Gentium Plus", "Doulos SIL", "Times New Roman", "Source Han Serif SC", "Noto Serif SC", "Songti SC", "STZhongsong", "SimSun", "DejaVu Serif", "Noto Sans Symbols 2", serif';
export const SANS_FONT_STACK =
  '"Inter", "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "WenQuanYi Micro Hei", system-ui, -apple-system, sans-serif';
export const MONO_FONT_STACK =
  '"JetBrains Mono", "SF Mono", "Cascadia Code", "Menlo", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols 2", monospace';
export const SYMBOL_FONT_STACK =
  '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols 2", "Noto Sans Symbols", "DejaVu Sans", "Cambria Math", "Lucida Sans Unicode", sans-serif';

// Concise single-primary-font stacks for journal vector compatibility (Adobe Illustrator / Inkscape)
export const IPA_COMPAT_FONT_STACK = '"Andika", sans-serif';
export const SERIF_COMPAT_FONT_STACK = '"Charis SIL", "Times New Roman", serif';
export const SANS_COMPAT_FONT_STACK = '"Inter", "Noto Sans SC", sans-serif';
export const MONO_COMPAT_FONT_STACK = '"JetBrains Mono", monospace';
export const SYMBOL_COMPAT_FONT_STACK = '"Segoe UI Symbol", "Apple Symbols", sans-serif';

export const FONT_TEXT = `12.5px ${IPA_FONT_STACK}`;
export const FONT_GLOSS = `11.2px ${IPA_FONT_STACK}`;
export const FONT_GLOSS_RAW = `10.2px ${MONO_FONT_STACK}`;
export const FONT_TIER = `500 12px ${SANS_FONT_STACK}`;
export const FONT_TICK = `10.5px ${MONO_FONT_STACK}`;
export const FONT_PT = `11.5px ${IPA_FONT_STACK}`;

let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (!measureCtx && typeof document !== 'undefined') {
    measureCtx = document.createElement('canvas').getContext('2d');
  }
  return measureCtx;
}

export function resetFontMeasureCache(): void {
  measureCtx = null;
}

export function measurePx(text: string, font: string): number {
  const ctx = getMeasureCtx();
  if (!ctx) return text.length * 7;
  ctx.font = font;
  return ctx.measureText(text).width;
}

export function formatPraatDouble(val: number): string {
  if (!Number.isFinite(val)) return '--undefined--';
  if (Object.is(val, -0) || val === 0) return '0';
  return String(val);
}

export function formatDisplayTick(
  val: number,
  precisionMode = '3',
  fixedDecimals = false
): string {
  if (!Number.isFinite(val)) return '--undefined--';
  if (precisionMode === 'full') return formatPraatDouble(val);
  const digits = parseInt(precisionMode, 10) || 3;
  const cleanVal = Object.is(val, -0) || Math.abs(val) < 1e-12 ? 0 : val;
  if (fixedDecimals) {
    const fixed = cleanVal.toFixed(digits);
    return fixed === '-0' || /^-0\.0+$/.test(fixed) ? (0).toFixed(digits) : fixed;
  }
  if (cleanVal === 0) return '0';
  const fixed = cleanVal.toFixed(digits);
  const stripped = fixed.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  return stripped === '-0' ? '0' : stripped;
}

export function buildDisplayTickStrings(
  spineT: number[],
  precisionMode = '3',
  fixedDecimals = false
): string[] {
  if (precisionMode === 'full') return spineT.map(formatPraatDouble);
  const baseDigits = parseInt(precisionMode, 10) || 3;
  const labels = spineT.map((t) => formatDisplayTick(t, String(baseDigits), fixedDecimals));
  for (let d = baseDigits + 1; d <= 6; d++) {
    const colliding = new Set<number>();
    for (let i = 1; i < spineT.length; i++) {
      if (spineT[i] !== spineT[i - 1] && labels[i] === labels[i - 1]) {
        colliding.add(i - 1);
        colliding.add(i);
      }
    }
    if (colliding.size === 0) break;
    colliding.forEach((idx) => {
      labels[idx] = formatDisplayTick(spineT[idx], String(d), fixedDecimals);
    });
  }
  return labels;
}

/**
 * Synchronous Praat trigraph decode cache populated by Rust `tg-core` via PlatformBridge.
 * Guarantees 100% Rust single-source-of-truth across both Tauri IPC and WASM.
 */
const trigraphDecodeCache = new Map<string, string | null>();

export async function prefetchTrigraphCache(tg: TextGrid, bridge: PlatformBridge): Promise<void> {
  const pending = new Set<string>();
  for (const tier of tg.tiers) {
    if (tier.kind === 'intervalTier') {
      for (const iv of tier.intervals) {
        if (iv.text.includes('\\') && !trigraphDecodeCache.has(iv.text)) {
          pending.add(iv.text);
        }
      }
    } else {
      for (const pt of tier.points) {
        if (pt.mark.includes('\\') && !trigraphDecodeCache.has(pt.mark)) {
          pending.add(pt.mark);
        }
      }
    }
  }
  if (pending.size === 0) return;
  await Promise.all(
    Array.from(pending).map(async (s) => {
      const res = await bridge.decodePraatTrigraphs(s);
      trigraphDecodeCache.set(s, res.changed ? res.text : null);
    })
  );
}

export async function primeTrigraphString(str: string, bridge: PlatformBridge): Promise<void> {
  if (!str.includes('\\') || trigraphDecodeCache.has(str)) return;
  const res = await bridge.decodePraatTrigraphs(str);
  trigraphDecodeCache.set(str, res.changed ? res.text : null);
}

export function decodeTrigraphGlossSync(str: string): string | null {
  if (!str || str.indexOf('\\') === -1) return null;
  return trigraphDecodeCache.get(str) ?? null;
}

const GRAPHEME_SEGMENTER =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

export function splitGraphemes(str: string): string[] {
  const raw = GRAPHEME_SEGMENTER
    ? Array.from(GRAPHEME_SEGMENTER.segment(str), (s) => s.segment)
    : str.match(/\P{M}\p{M}*|./gu) || Array.from(str);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let g = raw[i];
    while ((g.endsWith('\u0361') || g.endsWith('\u035C')) && i + 1 < raw.length) {
      g += raw[++i];
    }
    out.push(g);
  }
  return out;
}

export interface RichToken {
  kind: 'text' | 'tab' | 'space-meta' | 'ctrl' | 'newline' | 'wrap';
  str: string;
}

export interface RichLine {
  tokens: RichToken[];
  width: number;
}

export interface RichTextLayout {
  lines: RichLine[];
  width: number;
  height: number;
  lineH: number;
  gloss: string | null;
  glossLines: string[];
  glossLineH: number;
  glossH: number;
  glossIsRaw: boolean;
}

export interface RichLayoutOptions {
  hideMetaSymbols?: boolean;
  trigraphMode?: 'ipa-only' | 'dual' | 'raw-only' | null;
  fontFamily?: string;
  fontScale?: number;
}

export function tokenizeLine(
  rawLine: string,
  hasTrailingNewline: boolean,
  hideMetaSymbols = false
): RichToken[] {
  const tokens: RichToken[] = [];
  const n = rawLine.length;
  let i = 0;
  while (i < n) {
    const code = rawLine.charCodeAt(i);
    if (rawLine[i] === '\t') {
      tokens.push(hideMetaSymbols ? { kind: 'text', str: '  ' } : { kind: 'tab', str: '⇥' });
      i++;
    } else if (rawLine[i] === ' ') {
      let j = i;
      while (j < n && rawLine[j] === ' ') j++;
      const runLen = j - i;
      if (!hideMetaSymbols && (i === 0 || j === n || runLen > 1)) {
        for (let k = 0; k < runLen; k++) tokens.push({ kind: 'space-meta', str: '␣' });
      } else {
        tokens.push({ kind: 'text', str: ' '.repeat(runLen) });
      }
      i = j;
    } else if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x00a0 ||
      (code >= 0x200b && code <= 0x200f) ||
      code === 0xfeff
    ) {
      if (!hideMetaSymbols) {
        tokens.push({ kind: 'ctrl', str: `[${code.toString(16).toUpperCase().padStart(4, '0')}]` });
      }
      i++;
    } else {
      let j = i;
      while (j < n) {
        const c = rawLine.charCodeAt(j);
        if (
          rawLine[j] === ' ' ||
          rawLine[j] === '\t' ||
          c < 0x20 ||
          (c >= 0x7f && c <= 0x9f) ||
          c === 0x00a0 ||
          (c >= 0x200b && c <= 0x200f) ||
          c === 0xfeff
        ) {
          break;
        }
        j++;
      }
      tokens.push({ kind: 'text', str: rawLine.slice(i, j) });
      i = j;
    }
  }
  if (hasTrailingNewline && !hideMetaSymbols) tokens.push({ kind: 'newline', str: '↵' });
  return tokens;
}

function buildSymbolFont(baseFont: string, sizeDelta = 0): string {
  const m = baseFont.match(/(\d+(?:\.\d+)?)px/);
  const basePx = m ? parseFloat(m[1]) : 12.5;
  const effPx = Math.max(8, basePx + sizeDelta);
  return `${effPx.toFixed(2)}px ${SYMBOL_FONT_STACK}`;
}

export function tokenWidth(tok: RichToken, font: string, fontScale = 1): number {
  if (tok.kind === 'ctrl') {
    return measurePx(tok.str, `${(9.5 * fontScale).toFixed(2)}px ${MONO_FONT_STACK}`) + 2;
  }
  if (tok.kind === 'wrap') {
    return measurePx(tok.str, buildSymbolFont(font, -1.5 * fontScale)) + 2.5;
  }
  if (tok.kind !== 'text') {
    return measurePx(tok.str, buildSymbolFont(font)) + 2.5;
  }
  return measurePx(tok.str, font) * 1.04;
}

/** Measure a sequence of RichTokens by coalescing adjacent plain text runs into whole-string measurements. */
export function measureTokensWidth(tokens: RichToken[], font: string, fontScale = 1): number {
  let total = 0;
  let textBuf = '';
  const flushText = () => {
    if (textBuf) {
      total += measurePx(textBuf, font) * 1.04;
      textBuf = '';
    }
  };
  for (const tok of tokens) {
    if (tok.kind === 'text') {
      textBuf += tok.str;
    } else {
      flushText();
      total += tokenWidth(tok, font, fontScale);
    }
  }
  flushText();
  return total;
}

/** Split text into atomic units, preserving dictionary-verified Praat `\xx` trigraphs and grapheme clusters. */
export function splitTextAtoms(str: string, preservePraatTrigraphs: boolean): string[] {
  if (!preservePraatTrigraphs || !str.includes('\\')) {
    return splitGraphemes(str);
  }
  const out: string[] = [];
  let plain = '';
  const flushPlain = () => {
    if (plain) {
      out.push(...splitGraphemes(plain));
      plain = '';
    }
  };
  let i = 0;
  while (i < str.length) {
    if (isValidPraatTrigraphAt(str, i)) {
      flushPlain();
      out.push(str.slice(i, i + 3));
      i += 3;
    } else {
      plain += str[i];
      i += 1;
    }
  }
  flushPlain();
  return out;
}

/** Split raw Praat escape string or IPA gloss into atomic units (keeping dictionary-valid `\xx` escapes intact). */
function splitGlossAtoms(str: string, isRaw: boolean): string[] {
  return splitTextAtoms(str, isRaw);
}

function measureGlossPx(text: string, font: string): number {
  return measurePx(text, font) * 1.04;
}

function truncateGlossLine(text: string, maxWidth: number, font: string, isRaw: boolean): string {
  if (measureGlossPx(text, font) <= maxWidth) return text;
  const atoms = splitGlossAtoms(text, isRaw);
  const ell = '…';
  while (atoms.length > 1 && measureGlossPx(atoms.join('') + ell, font) > maxWidth) {
    atoms.pop();
  }
  const cand = atoms.join('') + ell;
  return measureGlossPx(cand, font) <= maxWidth ? cand : ell;
}

function wrapGlossText(
  text: string,
  maxWidth: number,
  font: string,
  isRaw: boolean,
  maxLines: number
): { lines: string[]; maxLineW: number } {
  const fullW = measureGlossPx(text, font);
  if (!maxWidth || maxWidth <= 0 || fullW <= maxWidth) {
    return { lines: [text], maxLineW: fullW };
  }

  // Prefer word/space boundaries first so Praat tokens stay readable
  const parts = text.split(/( +)/).filter((p) => p.length > 0);
  const lines: string[] = [];
  let cur = '';

  const flushCur = () => {
    const trimmed = cur.trimEnd();
    if (trimmed) lines.push(trimmed);
    cur = '';
  };

  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    const isSpace = /^ +$/.test(part);
    if (isSpace && cur === '') continue;

    const candidate = cur + part;
    if (cur !== '' && measureGlossPx(candidate.trimEnd(), font) > maxWidth) {
      if (lines.length + 1 >= maxLines) {
        const rest = parts.slice(pi).join('').trimStart();
        const combined = cur ? `${cur.trimEnd()} ${rest}` : rest;
        lines.push(truncateGlossLine(combined, maxWidth, font, isRaw));
        cur = '';
        break;
      }
      flushCur();
      if (isSpace) continue;
    }

    if (cur === '' && measureGlossPx(part, font) > maxWidth) {
      // Single long token wider than maxWidth: split on Praat trigraph / grapheme boundaries
      const atoms = splitGlossAtoms(part, isRaw);
      let chunk = '';
      for (let ai = 0; ai < atoms.length; ai++) {
        const a = atoms[ai];
        if (chunk !== '' && measureGlossPx(chunk + a, font) > maxWidth) {
          if (lines.length + 1 >= maxLines) {
            const tail = chunk + atoms.slice(ai).join('') + parts.slice(pi + 1).join('');
            lines.push(truncateGlossLine(tail, maxWidth, font, isRaw));
            chunk = '';
            pi = parts.length;
            break;
          }
          lines.push(chunk);
          chunk = a;
        } else {
          chunk += a;
        }
      }
      cur = chunk;
    } else {
      cur += part;
    }
  }
  if (cur.trimEnd() && lines.length < maxLines) {
    lines.push(cur.trimEnd());
  }
  if (lines.length === 0) {
    lines.push(truncateGlossLine(text, maxWidth, font, isRaw));
  }

  const maxLineW = lines.reduce((m, l) => Math.max(m, measureGlossPx(l, font)), 0);
  return { lines, maxLineW };
}

export function layoutRichText(
  str: string,
  maxWidth: number,
  font: string,
  mode: 'read' | 'edit' = 'edit',
  richOpts: RichLayoutOptions | null = null
): RichTextLayout {
  if (str === '') {
    return {
      lines: [],
      width: 0,
      height: 0,
      lineH: 17,
      gloss: null,
      glossLines: [],
      glossLineH: 15,
      glossH: 0,
      glossIsRaw: false
    };
  }
  const hideMeta = Boolean(richOpts?.hideMetaSymbols);
  const trigraphMode = richOpts?.trigraphMode ?? null;
  const fontScale = richOpts?.fontScale || 1;
  const decoded = decodeTrigraphGlossSync(str);

  let primaryStr = str;
  let gloss: string | null = null;
  let glossIsRaw = false;

  if (trigraphMode === 'ipa-only') {
    primaryStr = decoded || str;
    gloss = null;
    glossIsRaw = false;
  } else if (trigraphMode === 'raw-only') {
    primaryStr = str;
    gloss = null;
    glossIsRaw = false;
  } else if (trigraphMode === 'dual') {
    glossIsRaw = Boolean(decoded);
    primaryStr = decoded || str;
    const rawFlat = hideMeta
      ? str.replace(/\n/g, ' ').replace(/\t/g, ' ')
      : str.replace(/\n/g, '↵').replace(/\t/g, '⇥');
    gloss = decoded ? rawFlat : null;
  } else {
    glossIsRaw = Boolean(decoded && mode === 'read');
    primaryStr = glossIsRaw ? decoded! : str;
    gloss = decoded
      ? glossIsRaw
        ? str.replace(/\n/g, '↵').replace(/\t/g, '⇥')
        : decoded
      : null;
  }

  const rawLines = primaryStr.split('\n');
  const visualLines: RichLine[] = [];

  for (let li = 0; li < rawLines.length; li++) {
    const hasNl = li < rawLines.length - 1;
    if (li === rawLines.length - 1 && rawLines[li] === '' && rawLines.length > 1) break;
    const tokens = tokenizeLine(rawLines[li], hasNl, hideMeta);
    if (!maxWidth || maxWidth <= 0) {
      visualLines.push({
        tokens,
        width: measureTokensWidth(tokens, font, fontScale)
      });
      continue;
    }

    let curTokens: RichToken[] = [];
    const wrapPrefixW = hideMeta ? 0 : tokenWidth({ kind: 'wrap', str: '↪' }, font, fontScale);
    const spaceUpgradeExtra = hideMeta
      ? 0
      : Math.max(
          0,
          tokenWidth({ kind: 'space-meta', str: '␣' }, font, fontScale) -
            tokenWidth({ kind: 'text', str: ' ' }, font, fontScale)
        );

    const pushLine = () => {
      if (
        !hideMeta &&
        curTokens.length > 0 &&
        curTokens[curTokens.length - 1].kind === 'text' &&
        curTokens[curTokens.length - 1].str === ' '
      ) {
        curTokens[curTokens.length - 1] = { kind: 'space-meta', str: '␣' };
      }
      visualLines.push({
        tokens: curTokens,
        width: measureTokensWidth(curTokens, font, fontScale)
      });
    };

    for (const tok of tokens) {
      const candW = measureTokensWidth([...curTokens, tok], font, fontScale);
      const tailExtra =
        !hideMeta &&
        curTokens.length > 0 &&
        curTokens[curTokens.length - 1].kind === 'text' &&
        curTokens[curTokens.length - 1].str === ' '
          ? spaceUpgradeExtra
          : 0;

      if (candW + tailExtra > maxWidth) {
        const tokW = tokenWidth(tok, font, fontScale);
        if (
          tok.kind === 'text' &&
          tok.str.length > 1 &&
          (curTokens.length === 0 || tokW > maxWidth - wrapPrefixW)
        ) {
          const atoms = splitTextAtoms(tok.str, true);
          if (atoms.length > 1) {
            let piece = '';
            for (const atom of atoms) {
              const nextPiece = piece + atom;
              const testTokens = [...curTokens, { kind: 'text' as const, str: nextPiece }];
              const testW = measureTokensWidth(testTokens, font, fontScale);
              const pieceTailExtra =
                piece === '' &&
                !hideMeta &&
                curTokens.length > 0 &&
                curTokens[curTokens.length - 1].kind === 'text' &&
                curTokens[curTokens.length - 1].str === ' '
                  ? spaceUpgradeExtra
                  : 0;
              if (testW + pieceTailExtra > maxWidth && (curTokens.length > 0 || piece.length > 0)) {
                if (piece) {
                  curTokens.push({ kind: 'text', str: piece });
                  piece = '';
                }
                pushLine();
                curTokens = hideMeta ? [] : [{ kind: 'wrap', str: '↪' }];
              }
              piece += atom;
            }
            if (piece) curTokens.push({ kind: 'text', str: piece });
            continue;
          }
        }
        if (curTokens.length > 0) {
          pushLine();
          curTokens = hideMeta ? [tok] : [{ kind: 'wrap', str: '↪' }, tok];
        } else {
          curTokens.push(tok);
        }
      } else {
        curTokens.push(tok);
      }
    }
    if (curTokens.length > 0) {
      visualLines.push({
        tokens: curTokens,
        width: measureTokensWidth(curTokens, font, fontScale)
      });
    }
  }

  const lineH = Math.round(17 * fontScale);
  const glossLineH = Math.round((glossIsRaw ? 14 : 15) * fontScale);
  const glossFontSize = (glossIsRaw ? 10.2 : 11.2) * fontScale;
  const glossGap = glossIsRaw ? Math.round(2 * fontScale) : Math.round(3 * fontScale);
  const glossFont = glossIsRaw
    ? `${glossFontSize.toFixed(2)}px ${MONO_FONT_STACK}`
    : `${glossFontSize.toFixed(2)}px ${richOpts?.fontFamily || IPA_FONT_STACK}`;
  const maxGlossLines = maxWidth > 0 && maxWidth < 56 ? 2 : 3;
  const glossWrap = gloss
    ? wrapGlossText(gloss, maxWidth, glossFont, glossIsRaw, maxGlossLines)
    : { lines: [], maxLineW: 0 };
  const glossH = glossWrap.lines.length > 0 ? glossWrap.lines.length * glossLineH + glossGap : 0;
  const width = Math.max(
    visualLines.reduce((m, l) => Math.max(m, l.width), 0),
    glossWrap.maxLineW
  );
  return {
    lines: visualLines,
    width,
    height: visualLines.length * lineH + glossH,
    lineH,
    gloss,
    glossLines: glossWrap.lines,
    glossLineH,
    glossH,
    glossIsRaw
  };
}
