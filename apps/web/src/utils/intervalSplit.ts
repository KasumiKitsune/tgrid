let cachedGraphemeSegmenter: Intl.Segmenter | null | undefined;

function getGraphemeSegmenter(): Intl.Segmenter | null {
  if (cachedGraphemeSegmenter !== undefined) {
    return cachedGraphemeSegmenter;
  }
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      cachedGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return cachedGraphemeSegmenter;
    } catch {
      cachedGraphemeSegmenter = null;
      return null;
    }
  }
  cachedGraphemeSegmenter = null;
  return null;
}

/**
 * IPA post-posed spacing modifiers (aspiration, palatalization, labialization,
 * length, ejective, nasal/lateral release, glottalization, etc.) that belong
 * to the immediately preceding base phonetic symbol rather than standing alone.
 */
const IPA_POST_MODIFIER_RE = /^[ʰʱʲʳʴʵʶʷʸˠˡˢˣˤːˑʼⁿᵐᵑᶿᶹˀˁᶣᶢᶭᶠ]+$/;

/** Matches a unit composed solely of Unicode punctuation characters. */
const PUNCTUATION_UNIT_RE = /^\p{P}+$/u;

/** Strips leading and trailing Unicode punctuation while keeping interior punctuation (e.g. don't). */
const EDGE_PUNCTUATION_RE = /^\p{P}+|\p{P}+$/gu;

export type PunctuationMode = 'ignore' | 'attach-prev' | 'keep';

export type SplitDelimiterPreset =
  | 'whitespace'
  | 'comma'
  | 'enum-comma'
  | 'slash'
  | 'pipe'
  | 'semicolon'
  | 'hyphen'
  | 'custom';

export interface CharSplitOptions {
  punctuation?: PunctuationMode;
}

export interface DelimiterSplitOptions {
  preset?: SplitDelimiterPreset;
  customDelimiter?: string;
  stripEdgePunctuation?: boolean;
}

export interface ResolvedSplitSource {
  text: string;
  usedDecodedPraat: boolean;
}

/**
 * Resolve the effective text used for splitting.
 * When Praat trigraph codes have a translated IPA form, split on the translated IPA.
 */
export function resolveSplitSourceText(
  rawText: string,
  decodedPraatText?: string | null
): ResolvedSplitSource {
  if (typeof decodedPraatText === 'string' && decodedPraatText !== rawText) {
    return { text: decodedPraatText, usedDecodedPraat: true };
  }
  return { text: rawText, usedDecodedPraat: false };
}

export function isPunctuationUnit(unit: string): boolean {
  return unit.length > 0 && PUNCTUATION_UNIT_RE.test(unit);
}

/**
 * Split text into character / phonetic units:
 * - Preserves surrogate pairs & combining diacritics via Intl.Segmenter.
 * - Keeps IPA tie-bar affricates/co-articulations (U+0361 / U+035C) joined.
 * - Attaches IPA post-posed modifiers (e.g. tʰ, aː, kʷ) to the preceding base symbol.
 * - Ignores whitespace.
 * - Handles punctuation via `options.punctuation` (defaults to 'ignore').
 */
export function splitTextIntoChars(
  text: string,
  options?: CharSplitOptions
): string[] {
  if (!text) return [];
  const punctuationMode: PunctuationMode = options?.punctuation ?? 'ignore';
  const segmenter = getGraphemeSegmenter();
  const rawGraphemes = segmenter
    ? Array.from(segmenter.segment(text), (item) => item.segment)
    : Array.from(text);

  // Step 1: Join IPA tie-bars (U+0361 / U+035C) with the immediately following non-whitespace grapheme
  const tieJoined: string[] = [];
  for (let i = 0; i < rawGraphemes.length; i++) {
    let g = rawGraphemes[i];
    while (
      (g.endsWith('\u0361') || g.endsWith('\u035C')) &&
      i + 1 < rawGraphemes.length &&
      !/^\s+$/.test(rawGraphemes[i + 1])
    ) {
      g += rawGraphemes[++i];
    }
    tieJoined.push(g);
  }

  // Step 2: Strip whitespace and attach IPA post-modifiers to preceding non-punctuation base unit
  const units: string[] = [];
  let afterWhitespace = true;
  for (const unit of tieJoined) {
    if (!unit || /^\s+$/.test(unit)) {
      afterWhitespace = true;
      continue;
    }
    if (
      !afterWhitespace &&
      units.length > 0 &&
      IPA_POST_MODIFIER_RE.test(unit) &&
      !isPunctuationUnit(units[units.length - 1])
    ) {
      units[units.length - 1] += unit;
    } else {
      units.push(unit);
    }
    afterWhitespace = false;
  }

  if (punctuationMode === 'keep') {
    return units;
  }

  if (punctuationMode === 'ignore') {
    return units.filter((u) => !isPunctuationUnit(u));
  }

  // punctuationMode === 'attach-prev'
  const out: string[] = [];
  let pendingLeadingPunct = '';
  for (const unit of units) {
    if (isPunctuationUnit(unit)) {
      if (out.length > 0) {
        out[out.length - 1] += unit;
      } else {
        pendingLeadingPunct += unit;
      }
    } else {
      out.push(pendingLeadingPunct ? pendingLeadingPunct + unit : unit);
      pendingLeadingPunct = '';
    }
  }
  return out;
}

/**
 * Split text into tokens using a preset delimiter or custom literal delimiter.
 * Trims surrounding whitespace on every token, drops empty tokens, and optionally
 * strips leading/trailing punctuation while preserving interior punctuation (e.g. don't).
 */
export function splitTextByDelimiter(
  text: string,
  options?: DelimiterSplitOptions
): string[] {
  if (!text) return [];
  const preset: SplitDelimiterPreset = options?.preset ?? 'whitespace';
  const stripEdgePunctuation = Boolean(options?.stripEdgePunctuation);

  let rawParts: string[];
  switch (preset) {
    case 'whitespace':
      rawParts = text.split(/\s+/);
      break;
    case 'comma':
      rawParts = text.split(/[,，]+/);
      break;
    case 'enum-comma':
      rawParts = text.split(/[、]+/);
      break;
    case 'slash':
      rawParts = text.split(/[/／]+/);
      break;
    case 'pipe':
      rawParts = text.split(/[|｜]+/);
      break;
    case 'semicolon':
      rawParts = text.split(/[;；]+/);
      break;
    case 'hyphen':
      rawParts = text.split(/[-—–]+/);
      break;
    case 'custom': {
      const delim = options?.customDelimiter ?? '';
      if (delim.length === 0) return [];
      rawParts = text.split(delim);
      break;
    }
  }

  const out: string[] = [];
  for (const part of rawParts) {
    let token = part.trim();
    if (!token) continue;
    if (stripEdgePunctuation) {
      token = token.replace(EDGE_PUNCTUATION_RE, '').trim();
      if (!token) continue;
    }
    out.push(token);
  }
  return out;
}

export function roundSplitTimeClean(t: number): number {
  return Number(t.toFixed(6));
}

export function computeEqualSplitCuts(
  xmin: number,
  xmax: number,
  count: number
): number[] | null {
  if (
    !Number.isFinite(xmin) ||
    !Number.isFinite(xmax) ||
    xmax <= xmin ||
    !Number.isInteger(count) ||
    count < 2
  ) {
    return null;
  }

  const step = (xmax - xmin) / count;
  if (step <= 1e-7) return null;

  const useRound = step >= 1e-4;
  const cuts: number[] = [xmin];
  for (let k = 1; k < count; k++) {
    const rawT = xmin + step * k;
    const t = useRound ? roundSplitTimeClean(rawT) : rawT;
    if (t <= cuts[cuts.length - 1] || t >= xmax) {
      return null;
    }
    cuts.push(t);
  }
  cuts.push(xmax);
  return cuts;
}

export interface EqualSplitSegment {
  xmin: number;
  xmax: number;
  text: string;
}

export function buildEqualIntervals(
  xmin: number,
  xmax: number,
  texts: readonly string[]
): EqualSplitSegment[] | null {
  const count = texts.length;
  const cuts = computeEqualSplitCuts(xmin, xmax, count);
  if (!cuts) return null;
  return Array.from({ length: count }, (_, k) => ({
    xmin: cuts[k],
    xmax: cuts[k + 1],
    text: texts[k]
  }));
}

export type CharSplitResult =
  | { ok: true; chars: string[]; segments: EqualSplitSegment[] }
  | { ok: false; reason: 'insufficient-chars' | 'too-short'; chars: string[] };

export function buildCharSplitIntervals(
  xmin: number,
  xmax: number,
  text: string,
  options?: CharSplitOptions
): CharSplitResult {
  const chars = splitTextIntoChars(text, options);
  if (chars.length < 2) {
    return { ok: false, reason: 'insufficient-chars', chars };
  }
  const segments = buildEqualIntervals(xmin, xmax, chars);
  if (!segments) {
    return { ok: false, reason: 'too-short', chars };
  }
  return { ok: true, chars, segments };
}

export type DelimiterSplitResult =
  | { ok: true; tokens: string[]; segments: EqualSplitSegment[] }
  | { ok: false; reason: 'insufficient-tokens' | 'too-short'; tokens: string[] };

export function buildDelimiterSplitIntervals(
  xmin: number,
  xmax: number,
  text: string,
  options?: DelimiterSplitOptions
): DelimiterSplitResult {
  const tokens = splitTextByDelimiter(text, options);
  if (tokens.length < 2) {
    return { ok: false, reason: 'insufficient-tokens', tokens };
  }
  const segments = buildEqualIntervals(xmin, xmax, tokens);
  if (!segments) {
    return { ok: false, reason: 'too-short', tokens };
  }
  return { ok: true, tokens, segments };
}
