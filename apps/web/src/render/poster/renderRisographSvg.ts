import type { TextGrid, Tier } from '../../bridge/types';
import { measurePx, splitGraphemes } from '../../layout/richText';
import {
  IPA_CHAR_RE,
  POSTER_CJK_SERIF_STACK,
  POSTER_DISPLAY_SANS_STACK,
  POSTER_IPA_STACK,
  POSTER_MONO_STACK,
  POSTER_SANS_STACK,
  escapeXml,
  fmtNum,
  hasCombiningMarks,
  isTierIpaLike,
  renderPrintMarksSvg,
  resolvePosterText,
  truncateByGraphemes
} from './polarSolver';
import {
  renderRisoAcousticBandDataUrl,
  type PosterSpecMatrix,
  type RisoPieceBreak,
  type RisoPieceSegment
} from './posterAcoustics';
import { POSTER_BLEED_PT, type PosterAutoCopy, type PosterConfig } from './types';

export interface RenderRisographParams {
  tg: TextGrid;
  tMin: number;
  tMax: number;
  config: PosterConfig;
  autoCopy: PosterAutoCopy;
  specMatrix: PosterSpecMatrix | null;
  waveformBins: Array<[number, number]> | null;
  f0Runs: Array<Array<{ t: number; normF0: number }>>;
  hasAudio: boolean;
  audioSampleRate: number;
  previewMode: boolean;
}

const RISO = {
  paper: '#F8F4EA',
  paperDeep: '#EDE5D5',
  pink: '#FF5277',
  cyan: '#00A5C8',
  yellow: '#FFD026',
  navy: '#172A42',
  muted: '#5A6778'
};

type InkKey = 'pink' | 'yellow' | 'cyan';

const PLATE_OFFSET: Record<InkKey, { dx: number; dy: number }> = {
  pink: { dx: 1.5, dy: -1.1 },
  cyan: { dx: -1.35, dy: 1.2 },
  yellow: { dx: 1.65, dy: 1.25 }
};

const TONE_VOWEL_MAP: Record<string, string[]> = {
  a: ['ā', 'á', 'ǎ', 'à', 'a'],
  e: ['ē', 'é', 'ě', 'è', 'e'],
  i: ['ī', 'í', 'ǐ', 'ì', 'i'],
  o: ['ō', 'ó', 'ǒ', 'ò', 'o'],
  u: ['ū', 'ú', 'ǔ', 'ù', 'u'],
  v: ['ǖ', 'ǘ', 'ǚ', 'ǜ', 'ü'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ', 'ü']
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function renderRisoCottonFibersPath(w: number, h: number, bleed: number): string {
  const rng = mulberry32(908172);
  const segs: string[] = [];
  const xMin = -bleed + 10;
  const xSpan = w + 2 * bleed - 20;
  const yMin = -bleed + 10;
  const ySpan = h + 2 * bleed - 20;
  for (let i = 0; i < 380; i++) {
    const x0 = xMin + rng() * xSpan;
    const y0 = yMin + rng() * ySpan;
    const ln = 2.8 + rng() * 7.5;
    const ang = rng() * Math.PI * 2;
    segs.push(
      `M${fmtNum(x0, 1)} ${fmtNum(y0, 1)}L${fmtNum(x0 + Math.cos(ang) * ln, 1)} ${fmtNum(y0 + Math.sin(ang) * ln, 1)}`
    );
  }
  return segs.join('');
}

function cleanDisplayTierName(raw: string): string {
  return raw
    .trim()
    .replace(/[_]+/g, ' ')
    .replace(/\s{2,}/g, ' ');
}

function formatSpeakerLabel(rawName: string, speakerIdx: number, compact = false): string {
  const cleaned = cleanDisplayTierName(rawName || '');
  if (!cleaned) return compact ? `SPK ${speakerIdx + 1}` : `说话人 ${speakerIdx + 1}`;
  const m = cleaned.match(/^(?:speaker|spk)\s*([A-Za-z0-9]+)$/i);
  if (m) {
    const id = m[1].toUpperCase();
    return compact ? `SPK ${id}` : `Speaker ${id}`;
  }
  const zh = cleaned.match(/^说话人\s*([A-Za-z0-9甲乙丙丁]+)$/);
  if (zh) {
    return compact ? `${zh[1]}` : `说话人 ${zh[1]}`;
  }
  return cleaned;
}

function syllableNumericToToneMark(syl: string): string {
  const m = syl.trim().match(/^([a-zA-ZüÜvV]+)([0-5])$/);
  if (!m) return syl.trim();
  const letters = m[1].toLowerCase().replace(/v/g, 'ü');
  const tone = parseInt(m[2], 10);
  if (tone === 0 || tone === 5) return letters;
  const idx = tone - 1;
  let targetPos = -1;
  if (letters.includes('a')) targetPos = letters.indexOf('a');
  else if (letters.includes('o')) targetPos = letters.indexOf('o');
  else if (letters.includes('e')) targetPos = letters.indexOf('e');
  else if (letters.includes('iu')) targetPos = letters.indexOf('u');
  else if (letters.includes('ui')) targetPos = letters.indexOf('i');
  else {
    for (let i = letters.length - 1; i >= 0; i--) {
      if (TONE_VOWEL_MAP[letters[i]]) {
        targetPos = i;
        break;
      }
    }
  }
  if (targetPos < 0) return letters;
  const ch = letters[targetPos];
  const marked = TONE_VOWEL_MAP[ch]?.[idx] || ch;
  return letters.slice(0, targetPos) + marked + letters.slice(targetPos + 1);
}

function formatPronunciation(rawList: string[], wordText: string): string {
  const joined = rawList.filter(Boolean).join(' ').trim();
  if (!joined) return '';
  if (/^[A-Z0-9\s]+$/.test(joined) && joined.includes(' ')) {
    if (wordText && /[A-Za-z]/.test(wordText)) {
      return wordText.replace(/([a-z])([A-Z])/g, '$1 · $2').toLowerCase();
    }
    return joined.toLowerCase();
  }
  return rawList
    .map((part) => part.split(/\s+/).map(syllableNumericToToneMark).join(' '))
    .join(' ');
}

function sanitizeRawMark(raw: string): string {
  return resolvePosterText(raw)
    .replace(/\((?:[^()]{0,36})\)/g, '')
    .replace(/\b(?:IntervalTier|TextTier|meanF0|F0_max|F0_min|ZCR|peakDb)\b/gi, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function humanizePointForPill(rawMark: string, customNote?: string): string {
  if (customNote && customNote.trim()) return customNote.trim();
  const s = resolvePosterText(rawMark);
  if (!s) return '';

  // Mandarin tones & ToBI prosody
  if (/^!?T1\b/.test(s) || /^!?T1\[/.test(s)) return '一声 55';
  if (/^!?T2\b/.test(s) || /^!?T2\[/.test(s)) return '二声 35';
  if (/^!?T3\b/.test(s) || /^!?T3\[/.test(s)) return '三声 21';
  if (/^!?T4\b/.test(s) || /^!?T4\[/.test(s)) return '四声 51';
  if (/^T0\b/.test(s) || /^T0\[/.test(s)) return '轻声';
  if (s === 'H*') return '重音焦点';
  if (s === '!H*') return '次重音';
  if (s.includes('H-L%') || s.includes('B4')) return '句末降调';
  if (s.includes('H-') || s.includes('L-')) return '短语停顿';

  // Dialogue & acoustic event markers (never leak ugly snake_case into narrow pills)
  if (/retroflex[_ ]?sibilant/i.test(s)) return '卷舌音 ʂ';
  if (/dental[_ ]?sibilant/i.test(s)) return '平舌音 s';
  if (/contrastive[_ ]?focus|intensity[_ ]?max/i.test(s)) return '重读强调';
  if (/chuckle|laugh/i.test(s)) return '轻笑回应';
  if (/final[_ ]?falling/i.test(s)) return '句末降调';
  if (/emphatic/i.test(s)) return '高调回应';
  if (/^Turn\d+[_ ]?Speaker[_ ]?[A-Za-z0-9]+[_ ]?onset$/i.test(s)) return '';
  if (/^Turn\d+[_ ]?Speaker[_ ]?[A-Za-z0-9]+/i.test(s)) {
    const rest = s.replace(/^Turn\d+[_ ]?Speaker[_ ]?[A-Za-z0-9]+[_ ]*/i, '').trim();
    if (!rest || /^onset$/i.test(rest)) return '';
    return sanitizeRawMark(rest);
  }

  return sanitizeRawMark(s);
}

interface PointDirectoryEntry {
  idx: number;
  time: number;
  primaryTag: string;
  detailNote: string;
  inkKey: InkKey;
}

function buildPointDirectoryEntry(
  pt: { idx: number; time: number; mark: string },
  customNote: string | undefined,
  inkKey: InkKey
): PointDirectoryEntry {
  const raw = resolvePosterText(pt.mark);
  const userNote = (customNote || '').trim();

  if (userNote) {
    return {
      idx: pt.idx,
      time: pt.time,
      primaryTag: sanitizeRawMark(raw) || `P${pt.idx + 1}`,
      detailNote: userNote,
      inkKey
    };
  }

  // Turn onset events (clean editorial display in the bottom directory!)
  const turnOnset = raw.match(/^Turn(\d+)[_ ]?Speaker[_ ]?([A-Za-z0-9]+)[_ ]?onset$/i);
  if (turnOnset) {
    return {
      idx: pt.idx,
      time: pt.time,
      primaryTag: `轮次 ${turnOnset[1]} 起始`,
      detailNote: `Speaker ${turnOnset[2].toUpperCase()}`,
      inkKey
    };
  }

  // Dialogue & acoustic event landmarks
  if (/retroflex[_ ]?sibilant/i.test(raw)) {
    return { idx: pt.idx, time: pt.time, primaryTag: '卷舌擦音 ʂ', detailNote: 'Retroflex sibilant', inkKey };
  }
  if (/dental[_ ]?sibilant/i.test(raw)) {
    return { idx: pt.idx, time: pt.time, primaryTag: '平舌擦音 s', detailNote: 'Dental sibilant', inkKey };
  }
  if (/contrastive[_ ]?focus|intensity[_ ]?max/i.test(raw)) {
    return { idx: pt.idx, time: pt.time, primaryTag: '重读峰值', detailNote: 'Intensity focus peak', inkKey };
  }
  if (/chuckle|laugh/i.test(raw)) {
    return { idx: pt.idx, time: pt.time, primaryTag: '轻笑回应', detailNote: 'Paralinguistic chuckle', inkKey };
  }
  if (/final[_ ]?falling/i.test(raw)) {
    return { idx: pt.idx, time: pt.time, primaryTag: '句末降调', detailNote: 'Final falling contour', inkKey };
  }
  if (/emphatic/i.test(raw)) {
    return { idx: pt.idx, time: pt.time, primaryTag: '高调强调', detailNote: 'Emphatic response', inkKey };
  }

  // Mandarin tones & ToBI labels — keep scholarly code + crisp Chinese gloss (parity with Vinyl/Bauhaus)
  if (/^!?T1(?:\[|\b)/.test(raw)) {
    return { idx: pt.idx, time: pt.time, primaryTag: raw, detailNote: '一声高平调', inkKey };
  }
  if (/^!?T2(?:\[|\b)/.test(raw)) {
    return { idx: pt.idx, time: pt.time, primaryTag: raw, detailNote: '二声扬升调', inkKey };
  }
  if (/^!?T3(?:\[|\b)/.test(raw)) {
    return { idx: pt.idx, time: pt.time, primaryTag: raw, detailNote: '三声低降调', inkKey };
  }
  if (/^!T4(?:\[|\b)/.test(raw)) {
    return { idx: pt.idx, time: pt.time, primaryTag: raw, detailNote: '四声连读微降', inkKey };
  }
  if (/^T4(?:\[|\b)/.test(raw)) {
    return { idx: pt.idx, time: pt.time, primaryTag: raw, detailNote: '四声全降调', inkKey };
  }
  if (/^T0(?:\[|\b)/.test(raw)) {
    return { idx: pt.idx, time: pt.time, primaryTag: raw, detailNote: '轻声短弱调', inkKey };
  }
  if (raw === 'H*') {
    return { idx: pt.idx, time: pt.time, primaryTag: 'H*', detailNote: '重音焦点峰', inkKey };
  }
  if (raw === '!H*') {
    return { idx: pt.idx, time: pt.time, primaryTag: '!H*', detailNote: '次重音阶降', inkKey };
  }
  if (raw.includes('H-L%') || raw.includes('B4')) {
    return { idx: pt.idx, time: pt.time, primaryTag: raw, detailNote: '句末降调收尾', inkKey };
  }
  if (raw.includes('H-') || raw.includes('L-')) {
    return { idx: pt.idx, time: pt.time, primaryTag: raw, detailNote: '词间短语停顿', inkKey };
  }

  // Generic clean fallback
  const cleaned = sanitizeRawMark(raw) || `节点 ${pt.idx + 1}`;
  const sepMatch = cleaned.match(/^([^·:–—-]{1,22})\s*[·:–—-]\s*(.+)$/);
  if (sepMatch) {
    return {
      idx: pt.idx,
      time: pt.time,
      primaryTag: sepMatch[1].trim(),
      detailNote: sepMatch[2].trim(),
      inkKey
    };
  }
  return { idx: pt.idx, time: pt.time, primaryTag: cleaned, detailNote: '', inkKey };
}

interface PiecewiseAxis {
  segments: RisoPieceSegment[];
  breaks: RisoPieceBreak[];
  timeToX: (t: number) => number;
  xToTime: (x: number) => number;
}

function buildPiecewiseTimeAxis(
  xmin: number,
  xmax: number,
  activeIntervals: Array<{ xmin: number; xmax: number }>,
  pixelLeft: number,
  pixelRight: number
): PiecewiseAxis {
  const totalWidth = pixelRight - pixelLeft;
  const totalDur = Math.max(0.05, xmax - xmin);

  if (!activeIntervals.length) {
    return {
      segments: [{ t0: xmin, t1: xmax, x0: pixelLeft, x1: pixelRight }],
      breaks: [],
      timeToX: (t) => pixelLeft + ((Math.max(xmin, Math.min(xmax, t)) - xmin) / totalDur) * totalWidth,
      xToTime: (x) => xmin + ((Math.max(pixelLeft, Math.min(pixelRight, x)) - pixelLeft) / totalWidth) * totalDur
    };
  }

  const pad = Math.min(0.045, totalDur * 0.018);
  const sorted = activeIntervals
    .map((iv) => ({ t0: Math.max(xmin, iv.xmin - pad), t1: Math.min(xmax, iv.xmax + pad) }))
    .filter((iv) => iv.t1 > iv.t0)
    .sort((a, b) => a.t0 - b.t0);

  const merged: Array<{ t0: number; t1: number }> = [];
  for (const iv of sorted) {
    if (!merged.length || iv.t0 > merged[merged.length - 1].t1 + 0.001) {
      merged.push({ t0: iv.t0, t1: iv.t1 });
    } else {
      merged[merged.length - 1].t1 = Math.max(merged[merged.length - 1].t1, iv.t1);
    }
  }

  const rawParts: Array<{ type: 'time' | 'break'; t0: number; t1: number }> = [];
  let cursor = xmin;
  for (const m of merged) {
    if (m.t0 > cursor + 1e-4) {
      const gapDur = m.t0 - cursor;
      const isInternal = cursor > xmin + 1e-3 && m.t0 < xmax - 1e-3;
      rawParts.push({ type: gapDur >= 0.5 && isInternal ? 'break' : 'time', t0: cursor, t1: m.t0 });
    }
    rawParts.push({ type: 'time', t0: m.t0, t1: m.t1 });
    cursor = m.t1;
  }
  if (xmax > cursor + 1e-4) {
    rawParts.push({ type: xmax - cursor >= 0.85 ? 'break' : 'time', t0: cursor, t1: xmax });
  }

  const parts: Array<{ type: 'time' | 'break'; t0: number; t1: number }> = [];
  for (const p of rawParts) {
    if (p.type === 'time' && parts.length && parts[parts.length - 1].type === 'time') {
      parts[parts.length - 1].t1 = p.t1;
    } else {
      parts.push({ ...p });
    }
  }

  const breakCount = parts.filter((p) => p.type === 'break').length;
  const breakGapPx = breakCount > 0 ? Math.min(26, Math.floor((totalWidth * 0.16) / breakCount)) : 0;
  const availSpeechPx = totalWidth - breakCount * breakGapPx;
  const totalSpeechDur = Math.max(
    0.05,
    parts.filter((p) => p.type === 'time').reduce((acc, p) => acc + (p.t1 - p.t0), 0)
  );

  const segments: RisoPieceSegment[] = [];
  const breaks: RisoPieceBreak[] = [];
  let xCursor = pixelLeft;
  for (const p of parts) {
    if (p.type === 'break') {
      const xNext = xCursor + breakGapPx;
      breaks.push({ t0: p.t0, t1: p.t1, dur: p.t1 - p.t0, x0: xCursor, x1: xNext, xc: (xCursor + xNext) * 0.5 });
      xCursor = xNext;
    } else {
      const w = ((p.t1 - p.t0) / totalSpeechDur) * availSpeechPx;
      segments.push({ t0: p.t0, t1: p.t1, x0: xCursor, x1: xCursor + w });
      xCursor += w;
    }
  }

  const timeToX = (t: number): number => {
    const c = Math.max(xmin, Math.min(xmax, t));
    for (const seg of segments) {
      if (c >= seg.t0 - 1e-5 && c <= seg.t1 + 1e-5) {
        const r = (c - seg.t0) / Math.max(1e-6, seg.t1 - seg.t0);
        return seg.x0 + r * (seg.x1 - seg.x0);
      }
    }
    for (const br of breaks) {
      if (c >= br.t0 && c <= br.t1) {
        const r = (c - br.t0) / Math.max(1e-6, br.t1 - br.t0);
        return br.x0 + r * (br.x1 - br.x0);
      }
    }
    return pixelRight;
  };

  const xToTime = (x: number): number => {
    const c = Math.max(pixelLeft, Math.min(pixelRight, x));
    for (const seg of segments) {
      if (c >= seg.x0 && c <= seg.x1) {
        const r = (c - seg.x0) / Math.max(1e-6, seg.x1 - seg.x0);
        return seg.t0 + r * (seg.t1 - seg.t0);
      }
    }
    for (const br of breaks) {
      if (c >= br.x0 && c <= br.x1) return br.t1;
    }
    return xmin;
  };

  return { segments, breaks, timeToX, xToTime };
}

interface RisoCard {
  index: number;
  xmin: number;
  xmax: number;
  mainText: string;
  subLabel: string;
  subLabelCompact: string;
  speakerIdx: number;
  row1Text: string;
  row2Tokens: Array<{ text: string; highlight: boolean }>;
  toneTags: string[];
  fallbackStamp: string;
  inkKey: InkKey;
  isDialogue: boolean;
}

function extractBracketIpa(str: string): string[] {
  const matches: string[] = [];
  const re = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    if (!/^(chuckle|laugh|breath|pause|silence|sigh|cough)$/i.test(m[1].trim())) {
      matches.push(m[1].trim());
    }
  }
  return matches;
}

function stripBracketIpaForCard(str: string): { cleanText: string; hasChuckle: boolean } {
  const hasChuckle = /\[(chuckle|laugh)\]/i.test(str);
  const cleanText = str.replace(/\s*\[[^\]]+\]/g, '').replace(/"/g, '').trim();
  return { cleanText, hasChuckle };
}

function buildRisoCards(params: {
  intervalTiers: Tier[];
  sortedPoints: Array<{ idx: number; time: number; mark: string }>;
  pointNotes: Record<string, string>;
  tMin: number;
  tMax: number;
}): {
  cards: RisoCard[];
  isDialogueMode: boolean;
  row1Tag: string;
  row2Tag: string;
  row3Tag: string;
  layerSummary: string;
  allSpeechIntervals: Array<{ xmin: number; xmax: number }>;
} {
  const { intervalTiers, sortedPoints, pointNotes, tMin, tMax } = params;
  const duration = Math.max(0.01, tMax - tMin);
  const inkCycle: InkKey[] = ['pink', 'yellow', 'cyan', 'pink', 'yellow', 'cyan', 'pink'];

  const allSpeechIntervals: Array<{ xmin: number; xmax: number }> = [];
  for (const t of intervalTiers) {
    for (const iv of t.intervals) {
      if (iv.xmax <= tMin + 1e-6 || iv.xmin >= tMax - 1e-6) continue;
      if (resolvePosterText(iv.text) !== '') {
        allSpeechIntervals.push({ xmin: Math.max(tMin, iv.xmin), xmax: Math.min(tMax, iv.xmax) });
      }
    }
  }

  // Detect parallel multi-speaker dialogue (2+ speaker tiers, or 2 non-umbrella alternating tiers)
  const speakerTiers = intervalTiers.filter((t) => /speaker|说话人|spk|甲|乙/i.test(t.name || ''));
  const isTwoParallelNonIpa =
    intervalTiers.length === 2 &&
    !isTierIpaLike(intervalTiers[0]) &&
    !isTierIpaLike(intervalTiers[1]) &&
    intervalTiers[0].intervals.filter((iv) => resolvePosterText(iv.text) !== '').length >= 2 &&
    intervalTiers[1].intervals.filter((iv) => resolvePosterText(iv.text) !== '').length >= 2;

  if (speakerTiers.length >= 2 || isTwoParallelNonIpa) {
    const spkList = speakerTiers.length >= 2 ? speakerTiers : intervalTiers;
    const rawTurns: Array<{
      speakerIdx: number;
      speakerLabel: string;
      speakerCompact: string;
      xmin: number;
      xmax: number;
      rawText: string;
    }> = [];

    spkList.forEach((st, sIdx) => {
      const label = formatSpeakerLabel(st.name || '', sIdx, false);
      const compact = formatSpeakerLabel(st.name || '', sIdx, true);
      for (const iv of st.intervals) {
        if (iv.xmax <= tMin + 1e-6 || iv.xmin >= tMax - 1e-6) continue;
        const txt = resolvePosterText(iv.text);
        if (!txt) continue;
        rawTurns.push({
          speakerIdx: sIdx,
          speakerLabel: label,
          speakerCompact: compact,
          xmin: Math.max(tMin, iv.xmin),
          xmax: Math.min(tMax, iv.xmax),
          rawText: txt
        });
      }
    });
    rawTurns.sort((a, b) => a.xmin - b.xmin);

    const mergedTurns: typeof rawTurns = [];
    for (const turn of rawTurns) {
      const prev = mergedTurns[mergedTurns.length - 1];
      const gap = prev ? turn.xmin - prev.xmax : 999;
      const combinedLen = prev ? splitGraphemes(prev.rawText).length + splitGraphemes(turn.rawText).length : 0;
      const bothHaveBracket = prev && /\[/.test(prev.rawText) && /\[/.test(turn.rawText);
      if (
        prev &&
        prev.speakerIdx === turn.speakerIdx &&
        gap < 0.44 &&
        !bothHaveBracket &&
        combinedLen <= 24 &&
        rawTurns.length > 6
      ) {
        prev.xmax = turn.xmax;
        prev.rawText = `${prev.rawText} ${turn.rawText}`;
      } else {
        mergedTurns.push({ ...turn });
      }
    }

    let finalTurns = mergedTurns;
    if (finalTurns.length > 7) {
      const groupSize = Math.ceil(finalTurns.length / 6);
      const grouped: typeof rawTurns = [];
      for (let i = 0; i < finalTurns.length; i += groupSize) {
        const chunk = finalTurns.slice(i, i + groupSize);
        grouped.push({
          speakerIdx: chunk[0].speakerIdx,
          speakerLabel: chunk[0].speakerLabel,
          speakerCompact: chunk[0].speakerCompact,
          xmin: chunk[0].xmin,
          xmax: chunk[chunk.length - 1].xmax,
          rawText: chunk.map((c) => c.rawText).join(' ')
        });
      }
      finalTurns = grouped;
    }

    const cards: RisoCard[] = finalTurns.map((turn, idx) => {
      const ipaList = extractBracketIpa(turn.rawText);
      const { cleanText, hasChuckle } = stripBracketIpaForCard(turn.rawText);
      const cleanWord = cleanText || turn.rawText;
      const matchedPts = sortedPoints
        .filter((p) => p.time >= turn.xmin - 0.08 && p.time <= turn.xmax + 0.08)
        .map((p) => humanizePointForPill(p.mark, pointNotes[String(p.idx)]))
        .filter(Boolean);
      if (hasChuckle && !matchedPts.includes('轻笑回应')) {
        matchedPts.unshift('轻笑回应');
      }
      const uniqueTags = Array.from(new Set(matchedPts));
      const fallbackStamp = turn.speakerIdx === 0 ? '发话轮次' : '回应轮次';
      return {
        index: idx,
        xmin: turn.xmin,
        xmax: turn.xmax,
        mainText: cleanWord,
        subLabel: turn.speakerLabel,
        subLabelCompact: turn.speakerCompact,
        speakerIdx: turn.speakerIdx,
        // In dialogue mode, avoid repeating identical bracket IPA in both Row 1 & Row 2;
        // elevate extracted contrast IPA directly into Row 2's focal overprint badge row!
        row1Text: '',
        row2Tokens: ipaList.map((tok) => ({ text: tok, highlight: true })),
        toneTags: uniqueTags,
        fallbackStamp,
        inkKey: inkCycle[idx % inkCycle.length],
        isDialogue: true
      };
    });

    const cleanSpkNames = spkList.map((t, i) => formatSpeakerLabel(t.name || '', i, false));
    const summary = `${duration.toFixed(2)} 秒  ·  ${cleanSpkNames.join(' / ')}${
      sortedPoints.length ? `  ·  ${sortedPoints.length} 关键节点` : ''
    }`;
    return {
      cards,
      isDialogueMode: true,
      row1Tag: '',
      row2Tag: '对比音标',
      row3Tag: sortedPoints.length ? '语调焦点' : '轮次',
      layerSummary: summary,
      allSpeechIntervals
    };
  }

  // 0 interval tiers (audio-only mode): generate 5 clean rhythmic time cards
  if (intervalTiers.length === 0) {
    const segN = 5;
    const cards: RisoCard[] = [];
    for (let i = 0; i < segN; i++) {
      const a = tMin + (i / segN) * duration;
      const b = tMin + ((i + 1) / segN) * duration;
      const matchedPts = sortedPoints
        .filter((p) => p.time >= a - 0.02 && p.time <= b + 0.02)
        .map((p) => humanizePointForPill(p.mark, pointNotes[String(p.idx)]))
        .filter(Boolean);
      cards.push({
        index: i,
        xmin: a,
        xmax: b,
        mainText: String(i + 1).padStart(2, '0'),
        subLabel: `${(b - a).toFixed(2)}s`,
        subLabelCompact: `${(b - a).toFixed(2)}s`,
        speakerIdx: -1,
        row1Text: '',
        row2Tokens: [],
        toneTags: Array.from(new Set(matchedPts)),
        fallbackStamp: '',
        inkKey: inkCycle[i % inkCycle.length],
        isDialogue: false
      });
    }
    return {
      cards,
      isDialogueMode: false,
      row1Tag: '',
      row2Tag: '',
      row3Tag: sortedPoints.length ? '节点' : '',
      layerSummary: `${duration.toFixed(2)} 秒  ·  纯声学版画`,
      allSpeechIntervals
    };
  }

  // Hierarchical / General N-tier mapping (1..6 tiers)
  let tier0IsUmbrella = false;
  if (intervalTiers.length >= 2) {
    const r0Active = intervalTiers[0].intervals.filter(
      (iv) => iv.xmax > tMin + 1e-6 && iv.xmin < tMax - 1e-6 && resolvePosterText(iv.text) !== ''
    );
    const r1Active = intervalTiers[1].intervals.filter(
      (iv) => iv.xmax > tMin + 1e-6 && iv.xmin < tMax - 1e-6 && resolvePosterText(iv.text) !== ''
    );
    if (r0Active.length <= 1 && r1Active.length >= 2) {
      tier0IsUmbrella = true;
    }
  }

  const wordTierIdx = tier0IsUmbrella ? 1 : 0;
  const wordTier = intervalTiers[wordTierIdx];
  const remaining = intervalTiers.filter((_, idx) => idx !== wordTierIdx && !(tier0IsUmbrella && idx === 0));

  const pinyinTier = remaining.find((t) => /pinyin|arpabet|拼音|注音|syllable|音节/i.test(t.name || '')) ?? null;
  const restAfterPy = remaining.filter((t) => t !== pinyinTier);
  const broadTier =
    restAfterPy.find((t) => /broad|宽式|phoneme|音位/i.test(t.name || '')) ?? restAfterPy[0] ?? null;
  const narrowTier =
    restAfterPy.find((t) => t !== broadTier && /narrow|严式|allophone|音素|ipa/i.test(t.name || '')) ??
    restAfterPy.find((t) => t !== broadTier) ??
    null;

  let rawWords = wordTier.intervals
    .filter((iv) => iv.xmax > tMin + 1e-6 && iv.xmin < tMax - 1e-6 && resolvePosterText(iv.text) !== '')
    .map((iv) => ({
      xmin: Math.max(tMin, iv.xmin),
      xmax: Math.min(tMax, iv.xmax),
      text: resolvePosterText(iv.text)
    }));

  if (rawWords.length === 0) {
    rawWords = [{ xmin: tMin, xmax: tMax, text: cleanDisplayTierName(wordTier.name || '语音片段') }];
  }

  if (rawWords.length > 7) {
    const groupSize = Math.ceil(rawWords.length / 6);
    const grouped: typeof rawWords = [];
    for (let i = 0; i < rawWords.length; i += groupSize) {
      const chunk = rawWords.slice(i, i + groupSize);
      grouped.push({
        xmin: chunk[0].xmin,
        xmax: chunk[chunk.length - 1].xmax,
        text: chunk.map((c) => c.text).join(' ')
      });
    }
    rawWords = grouped;
  }

  const cards: RisoCard[] = rawWords.map((w, idx) => {
    const overlapOk = (iv: { xmin: number; xmax: number }) =>
      Math.min(w.xmax, iv.xmax) - Math.max(w.xmin, iv.xmin) > 0.006;

    const pyList = pinyinTier
      ? pinyinTier.intervals
          .filter((iv) => overlapOk(iv) && resolvePosterText(iv.text) !== '')
          .map((iv) => resolvePosterText(iv.text))
      : [];
    const subLabel = formatPronunciation(pyList, w.text);

    const broadList = broadTier
      ? broadTier.intervals
          .filter((iv) => overlapOk(iv) && resolvePosterText(iv.text) !== '')
          .map((iv) => resolvePosterText(iv.text))
      : [];
    const narrowList = narrowTier
      ? narrowTier.intervals
          .filter((iv) => overlapOk(iv) && resolvePosterText(iv.text) !== '')
          .map((iv) => resolvePosterText(iv.text))
      : [];

    const broadSet = new Set(broadList);
    const tokSrc = narrowList.length ? narrowList : broadTier && isTierIpaLike(broadTier) ? broadList : [];
    const row2Tokens = tokSrc.slice(0, 12).map((tok) => ({
      text: tok,
      highlight: hasCombiningMarks(tok) && (!broadSet.has(tok) || /[\u0300-\u036f\u02de\u031a\u0320-\u033f]/.test(tok))
    }));

    const matchedTones = sortedPoints
      .filter((p) => p.time >= w.xmin - 0.015 && p.time <= w.xmax + 0.015)
      .map((p) => humanizePointForPill(p.mark, pointNotes[String(p.idx)]))
      .filter(Boolean);
    const primaryTones = matchedTones.filter((t) => t !== '短语停顿');
    const chosenTones = Array.from(new Set(primaryTones.length ? primaryTones : matchedTones));

    const broadIsIpa = broadTier ? isTierIpaLike(broadTier) : false;
    return {
      index: idx,
      xmin: w.xmin,
      xmax: w.xmax,
      mainText: w.text,
      subLabel,
      subLabelCompact: subLabel,
      speakerIdx: -1,
      row1Text: broadList.length
        ? broadIsIpa
          ? `/${broadList.join(' ')}/`
          : broadList.join(' ')
        : '',
      row2Tokens: narrowList.length ? row2Tokens : [],
      toneTags: chosenTones,
      fallbackStamp: '',
      inkKey: inkCycle[idx % inkCycle.length],
      isDialogue: false
    };
  });

  const tierNames = intervalTiers.map((t) => cleanDisplayTierName(t.name)).filter(Boolean).slice(0, 4);
  if (sortedPoints.length > 0) tierNames.push('声调');
  const layerSummary = `${duration.toFixed(2)} 秒  ·  ${tierNames.join(' / ') || '语音印记'}`;

  return {
    cards,
    isDialogueMode: false,
    row1Tag: broadTier ? truncateByGraphemes(cleanDisplayTierName(broadTier.name || '音标'), 44, `700 10px ${POSTER_SANS_STACK}`) : '',
    row2Tag: narrowTier ? truncateByGraphemes(cleanDisplayTierName(narrowTier.name || '细节'), 44, `700 10px ${POSTER_SANS_STACK}`) : '',
    row3Tag: sortedPoints.length ? '声调' : '',
    layerSummary,
    allSpeechIntervals
  };
}

function wrapCardText(text: string, maxW: number, fontSize: number): { lines: string[]; effFontSize: number } {
  let fs = fontSize;
  const tryWrap = (f: number): string[] => {
    const css = `900 ${f.toFixed(1)}px ${POSTER_SANS_STACK}`;
    if (measurePx(text, css) <= maxW) return [text];
    const gs = splitGraphemes(text);
    if (gs.length <= 2) return [text];

    let bestSplit = Math.ceil(gs.length / 2);
    let minScore = Infinity;
    for (let i = 1; i < gs.length; i++) {
      const left = gs.slice(0, i).join('').trim();
      const right = gs.slice(i).join('').trim();
      if (!left || !right) continue;
      const w1 = measurePx(left, css);
      const w2 = measurePx(right, css);
      if (w1 > maxW * 1.15 || w2 > maxW * 1.15) continue;

      // Strongly reward natural punctuation/space breaks and penalize orphaned 1-char trailing fragments
      const prevChar = gs[i - 1];
      const nextChar = gs[i];
      const punctBonus = /[，。！？、；：,\s]/.test(prevChar) ? -110 : 0;
      const orphanPenalty =
        splitGraphemes(right).length <= 1 || (splitGraphemes(right).length === 2 && /[！？。，?!.]/.test(gs[gs.length - 1]))
          ? 70
          : 0;
      // Avoid splitting mid-Latin word (e.g. `shī` or `TextGrid`)
      const latinSplitPenalty = /[A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùüǖǘǚǜ]/.test(prevChar) && /[A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùüǖǘǚǜ]/.test(nextChar) ? 95 : 0;
      const balancePenalty = Math.abs(w1 - w2) * 0.25;
      const score = Math.max(w1, w2) + punctBonus + orphanPenalty + latinSplitPenalty + balancePenalty;
      if (score < minScore) {
        minScore = score;
        bestSplit = i;
      }
    }
    return [gs.slice(0, bestSplit).join('').trim(), gs.slice(bestSplit).join('').trim()];
  };

  let lines = tryWrap(fs);
  while (
    lines.some((ln) => measurePx(ln, `900 ${fs.toFixed(1)}px ${POSTER_SANS_STACK}`) > maxW) &&
    fs > 12.2
  ) {
    fs -= 1.0;
    lines = tryWrap(fs);
  }
  // If short 2–5 grapheme phrase wrapped awkwardly, see if a tiny 1.5pt reduction fits on one punchy line
  if (lines.length === 2 && splitGraphemes(text).length <= 5 && fs >= 14.5) {
    const oneLineFs = Math.max(13.2, fs - 1.8);
    if (measurePx(text, `900 ${oneLineFs.toFixed(1)}px ${POSTER_SANS_STACK}`) <= maxW) {
      return { lines: [text], effFontSize: oneLineFs };
    }
  }
  const finalCss = `900 ${fs.toFixed(1)}px ${POSTER_SANS_STACK}`;
  lines = lines.map((ln) => truncateByGraphemes(ln, maxW + 1.5, finalCss));
  return { lines, effFontSize: fs };
}

function fitSubLabelText(
  fullLabel: string,
  compactLabel: string,
  maxW: number,
  baseSize = 11.4,
  minSize = 9.0
): { text: string; fontSize: number } {
  for (let fs = baseSize; fs >= minSize; fs -= 0.5) {
    if (measurePx(fullLabel, `700 ${fs.toFixed(1)}px ${POSTER_SANS_STACK}`) <= maxW) {
      return { text: fullLabel, fontSize: fs };
    }
  }
  if (compactLabel && compactLabel !== fullLabel) {
    for (let fs = Math.min(baseSize, 10.6); fs >= minSize; fs -= 0.5) {
      if (measurePx(compactLabel, `700 ${fs.toFixed(1)}px ${POSTER_SANS_STACK}`) <= maxW) {
        return { text: compactLabel, fontSize: fs };
      }
    }
    return {
      text: truncateByGraphemes(compactLabel, maxW, `700 ${minSize.toFixed(1)}px ${POSTER_SANS_STACK}`),
      fontSize: minSize
    };
  }
  return {
    text: truncateByGraphemes(fullLabel, maxW, `700 ${minSize.toFixed(1)}px ${POSTER_SANS_STACK}`),
    fontSize: minSize
  };
}

function renderRegMarkSvg(x: number, y: number): string {
  const rOuter = 5.6;
  const rInner = 2.0;
  const arm = 11.5;
  const mk = (col: string, dx: number, dy: number) =>
    `<g transform="translate(${fmtNum(dx)} ${fmtNum(dy)})" stroke="${col}" stroke-opacity="0.76" stroke-width="0.82" fill="none" style="mix-blend-mode:multiply">` +
    `<circle cx="${fmtNum(x)}" cy="${fmtNum(y)}" r="${rOuter}"/>` +
    `<circle cx="${fmtNum(x)}" cy="${fmtNum(y)}" r="${rInner}"/>` +
    `<line x1="${fmtNum(x - arm)}" y1="${fmtNum(y)}" x2="${fmtNum(x + arm)}" y2="${fmtNum(y)}"/>` +
    `<line x1="${fmtNum(x)}" y1="${fmtNum(y - arm)}" x2="${fmtNum(x)}" y2="${fmtNum(y + arm)}"/>` +
    `</g>`;
  const yellowDot =
    `<circle cx="${fmtNum(x + PLATE_OFFSET.yellow.dx * 0.55)}" cy="${fmtNum(y + PLATE_OFFSET.yellow.dy * 0.55)}" r="1.4" fill="${RISO.yellow}" fill-opacity="0.88" style="mix-blend-mode:multiply"/>`;
  return (
    yellowDot +
    mk(RISO.pink, PLATE_OFFSET.pink.dx * 0.85, PLATE_OFFSET.pink.dy * 0.85) +
    mk(RISO.cyan, PLATE_OFFSET.cyan.dx * 0.85, PLATE_OFFSET.cyan.dy * 0.85)
  );
}

export function renderRisographPosterSvg(params: RenderRisographParams): {
  svgMarkup: string;
  widthPt: number;
  heightPt: number;
  trimWidthPt: number;
  trimHeightPt: number;
  bleedPt: number;
  activeIntervalCount: number;
  activePointCount: number;
} {
  const {
    tg,
    tMin,
    tMax,
    config,
    autoCopy,
    specMatrix,
    waveformBins,
    f0Runs,
    hasAudio,
    audioSampleRate,
    previewMode
  } = params;

  const isEmblem = config.framing === 'emblem_1_1';
  const trimW = 900.0;
  const trimH = isEmblem ? 900.0 : 1200.0;
  const bleed = config.includeBleed ? POSTER_BLEED_PT : 0;
  const widthPt = trimW + 2 * bleed;
  const heightPt = trimH + 2 * bleed;
  const idPfx = previewMode ? 'pv-rs-' : 'ex-rs-';
  const duration = Math.max(0.01, tMax - tMin);

  const intervalEntries = config.intervalTierIndices
    .filter((idx) => idx >= 0 && idx < tg.tiers.length && tg.tiers[idx].kind === 'intervalTier')
    .slice(0, 6)
    .map((tierIdx) => ({ tierIdx, tier: tg.tiers[tierIdx] }));
  const intervalTiers = intervalEntries.map((e) => e.tier);

  const pointTier =
    config.pointTierIndex !== null &&
    config.pointTierIndex >= 0 &&
    config.pointTierIndex < tg.tiers.length &&
    tg.tiers[config.pointTierIndex].kind === 'textTier'
      ? tg.tiers[config.pointTierIndex]
      : null;

  const sortedPoints = pointTier
    ? pointTier.points
        .filter((pt) => pt.number >= tMin - 1e-7 && pt.number <= tMax + 1e-7)
        .sort((a, b) => a.number - b.number)
        .map((pt, idx) => ({ idx, time: pt.number, mark: pt.mark }))
    : [];

  const model = buildRisoCards({
    intervalTiers,
    sortedPoints,
    pointNotes: config.copy.pointNotes,
    tMin,
    tMax
  });

  const marginX = 68;
  const contentLeft = marginX;
  const contentRight = trimW - marginX;
  const contentW = contentRight - contentLeft;

  const timeAxis = buildPiecewiseTimeAxis(tMin, tMax, model.allSpeechIntervals, contentLeft, contentRight);

  const showPointDirectory = !isEmblem && !config.pureVisual && sortedPoints.length > 0;
  const hasAnyRow1 = model.cards.some((c) => Boolean(c.row1Text));
  const hasAnyRow2 = model.cards.some((c) => c.row2Tokens.length > 0);
  const hasAnyTone = model.cards.some((c) => c.toneTags.length > 0 || Boolean(c.fallbackStamp));

  // Adaptive vertical stage architecture across 3:4 full poster (with/without directory) and 1:1 emblem
  const waveTop = isEmblem ? 84 : config.pureVisual ? 116 : 216;
  const waveH = isEmblem ? 50 : 46;
  const specTop = waveTop + waveH + 8;
  const specH = isEmblem ? 132 : showPointDirectory ? 114 : 122;
  const specBot = specTop + specH;

  const timeTickBaselineY = specBot + 22;
  const ribbonTopY = specBot + 29;

  // Compact vertical rhythm when bottom Point Directory is active; airy monumental rhythm otherwise
  const blockBaseY = isEmblem
    ? 444
    : showPointDirectory
      ? hasAnyRow1 && hasAnyRow2
        ? 546
        : 556
      : config.pureVisual
        ? 520
        : 588;
  const blockH = isEmblem ? 114 : showPointDirectory ? 104 : 110;
  const staggerOffsets = showPointDirectory ? [0, 17, -5, 14, 3, 19, -2] : [0, 21, -6, 17, 4, 23, -2];

  // --------------------------------------------------------------------------
  // <defs>: Warm Cotton Paper Gradient + Pure-SVG Risograph Screen Grain Patterns
  // (Zero <feTurbulence> / <feGaussianBlur> filters for fast, crisp vector export!)
  // --------------------------------------------------------------------------
  const grainDotColor = config.bgMode === 'transparent' ? '#FFFFFF' : RISO.paper;
  const defs =
    `<radialGradient id="${idPfx}paper-grad" gradientUnits="userSpaceOnUse" cx="${fmtNum(trimW * 0.5)}" cy="${fmtNum(trimH * 0.44)}" r="${fmtNum(trimW * 0.88)}">` +
    `<stop offset="0%" stop-color="#FFFDF8"/>` +
    `<stop offset="68%" stop-color="${RISO.paper}"/>` +
    `<stop offset="100%" stop-color="${RISO.paperDeep}"/>` +
    `</radialGradient>` +
    `<pattern id="${idPfx}ink-grain" width="5" height="5" patternUnits="userSpaceOnUse">` +
    `<circle cx="1.2" cy="1.2" r="0.48" fill="${grainDotColor}" fill-opacity="0.14"/>` +
    `<circle cx="3.7" cy="3.6" r="0.42" fill="${grainDotColor}" fill-opacity="0.11"/>` +
    `</pattern>` +
    `<pattern id="${idPfx}paper-tooth" width="14" height="14" patternUnits="userSpaceOnUse">` +
    `<circle cx="2.5" cy="3.5" r="0.55" fill="#B6A58B" fill-opacity="0.08"/>` +
    `<circle cx="9.5" cy="10.5" r="0.45" fill="#9E8E76" fill-opacity="0.07"/>` +
    `</pattern>`;

  // --------------------------------------------------------------------------
  // #paper-bg (omitted when bgMode === 'transparent')
  // --------------------------------------------------------------------------
  const paperBgGroup =
    config.bgMode === 'transparent'
      ? ''
      : `<g id="paper-bg">` +
        `<rect x="${fmtNum(-bleed)}" y="${fmtNum(-bleed)}" width="${fmtNum(widthPt)}" height="${fmtNum(heightPt)}" fill="url(#${idPfx}paper-grad)"/>` +
        `<rect x="${fmtNum(-bleed)}" y="${fmtNum(-bleed)}" width="${fmtNum(widthPt)}" height="${fmtNum(heightPt)}" fill="url(#${idPfx}paper-tooth)"/>` +
        `<path d="${renderRisoCottonFibersPath(trimW, trimH, bleed)}" fill="none" stroke="rgba(186,172,148,0.16)" stroke-width="0.58"/>` +
        `</g>`;

  // --------------------------------------------------------------------------
  // #registration-marks (4 corner 3-plate Risograph bullseye targets)
  // --------------------------------------------------------------------------
  const regMarksGroup =
    `<g id="registration-marks">` +
    renderRegMarkSvg(36, 36) +
    renderRegMarkSvg(trimW - 36, 36) +
    renderRegMarkSvg(36, trimH - 36) +
    renderRegMarkSvg(trimW - 36, trimH - 36) +
    `</g>`;

  // --------------------------------------------------------------------------
  // #acoustic-traces (3-plate Multiply Halftone Spectrogram + Waveform + F0 + Axis)
  // --------------------------------------------------------------------------
  const acousticParts: string[] = [];

  // Subtle left-margin printmaker band labels (`声波` / `频谱`)
  if (!isEmblem) {
    if (!hasAudio || config.showWaveform) {
      acousticParts.push(
        `<text x="${contentLeft - 12}" y="${fmtNum(waveTop + waveH * 0.5 + 3.2)}" text-anchor="end" font-size="9.2" font-weight="700" fill="${RISO.pink}" fill-opacity="0.72" font-family="${escapeXml(POSTER_SANS_STACK)}">声波</text>`
      );
    }
    if (!hasAudio || config.showSpectrogram) {
      acousticParts.push(
        `<text x="${contentLeft - 12}" y="${fmtNum(specTop + specH * 0.5 + 3.2)}" text-anchor="end" font-size="9.2" font-weight="700" fill="${RISO.cyan}" fill-opacity="0.76" font-family="${escapeXml(POSTER_SANS_STACK)}">频谱</text>`
      );
    }
  }

  const bandRaster = renderRisoAcousticBandDataUrl({
    spec: specMatrix,
    waveformBins,
    f0Runs,
    showSpectrogram: config.showSpectrogram,
    showWaveform: config.showWaveform,
    showPitch: config.showPitch,
    hasAudio,
    tMin,
    tMax,
    contentLeft,
    contentW,
    waveTop,
    waveH,
    specTop,
    specH,
    segments: timeAxis.segments,
    breaks: timeAxis.breaks,
    timeToX: timeAxis.timeToX,
    xToTime: timeAxis.xToTime,
    previewMode
  });
  if (bandRaster?.dataUrl) {
    acousticParts.push(
      `<image x="${fmtNum(bandRaster.xPt)}" y="${fmtNum(bandRaster.yPt)}" width="${fmtNum(bandRaster.widthPt)}" height="${fmtNum(bandRaster.heightPt)}" href="${bandRaster.dataUrl}" preserveAspectRatio="none" style="mix-blend-mode:multiply"/>`
    );
  }

  // Subtle time-axis calibration hairlines & non-colliding timestamps below spectrogram
  if (timeAxis.breaks.length === 0) {
    const stepSec = duration <= 3.5 ? 0.5 : duration <= 8 ? 1.0 : 2.0;
    const endX = timeAxis.timeToX(tMax);
    const tickCss = `600 9.4px ${POSTER_MONO_STACK}`;
    const endLbl = `${tMax.toFixed(2)}s`;
    const endBoxLeft = endX - measurePx(endLbl, tickCss);
    let lastTickRight = -100;
    for (let dt = 0; dt <= duration + 0.01; dt += stepSec) {
      if (dt > duration - 0.18 && Math.abs(dt - duration) > 0.02) continue;
      const tVal = tMin + dt;
      const tx = timeAxis.timeToX(tVal);
      const anchor = dt < 0.05 ? 'start' : 'middle';
      const lbl = `${tVal.toFixed(1)}s`;
      const lblW = measurePx(lbl, tickCss);
      const boxL = anchor === 'start' ? tx : tx - lblW * 0.5;
      const boxR = anchor === 'start' ? tx + lblW : tx + lblW * 0.5;
      if (boxL < lastTickRight + 10 || boxR > endBoxLeft - 10) continue;
      lastTickRight = boxR;
      acousticParts.push(
        `<line x1="${fmtNum(tx)}" y1="${specBot + 1.5}" x2="${fmtNum(tx)}" y2="${specBot + 5.5}" stroke="${RISO.navy}" stroke-opacity="0.46" stroke-width="0.75"/>`,
        `<text x="${fmtNum(tx)}" y="${specBot + 16}" text-anchor="${anchor}" font-size="9.4" font-weight="600" fill="${RISO.navy}" fill-opacity="0.52" font-family="${escapeXml(POSTER_MONO_STACK)}">${lbl}</text>`
      );
    }
    acousticParts.push(
      `<line x1="${fmtNum(endX)}" y1="${specBot + 1.5}" x2="${fmtNum(endX)}" y2="${specBot + 5.5}" stroke="${RISO.navy}" stroke-opacity="0.46" stroke-width="0.75"/>`,
      `<text x="${fmtNum(endX)}" y="${specBot + 16}" text-anchor="end" font-size="9.4" font-weight="600" fill="${RISO.navy}" fill-opacity="0.52" font-family="${escapeXml(POSTER_MONO_STACK)}">${endLbl}</text>`
    );
  } else {
    let lastLabelX = -100;
    timeAxis.segments.forEach((seg, idx) => {
      const sx = seg.x0;
      if (sx - lastLabelX >= 42) {
        acousticParts.push(
          `<line x1="${fmtNum(sx)}" y1="${specBot + 1.5}" x2="${fmtNum(sx)}" y2="${specBot + 5.5}" stroke="${RISO.navy}" stroke-opacity="0.46" stroke-width="0.75"/>`,
          `<text x="${fmtNum(sx + (idx === 0 ? 0 : 2))}" y="${specBot + 16}" text-anchor="${idx === 0 ? 'start' : 'middle'}" font-size="9.4" font-weight="600" fill="${RISO.navy}" fill-opacity="0.52" font-family="${escapeXml(POSTER_MONO_STACK)}">${seg.t0.toFixed(1)}s</text>`
        );
        lastLabelX = sx;
      }
      if (idx === timeAxis.segments.length - 1 && seg.x1 - lastLabelX >= 40) {
        acousticParts.push(
          `<line x1="${fmtNum(seg.x1)}" y1="${specBot + 1.5}" x2="${fmtNum(seg.x1)}" y2="${specBot + 5.5}" stroke="${RISO.navy}" stroke-opacity="0.46" stroke-width="0.75"/>`,
          `<text x="${fmtNum(seg.x1)}" y="${specBot + 16}" text-anchor="end" font-size="9.4" font-weight="600" fill="${RISO.navy}" fill-opacity="0.52" font-family="${escapeXml(POSTER_MONO_STACK)}">${seg.t1.toFixed(2)}s</text>`
        );
      }
    });
  }

  // Micro event locator pins along spectrogram top edge linking acoustic time to bottom 01–K directory
  if (showPointDirectory) {
    const pinCycle: InkKey[] = ['pink', 'yellow', 'cyan'];
    sortedPoints.forEach((pt, idx) => {
      const px = timeAxis.timeToX(pt.time);
      const col = RISO[pinCycle[idx % pinCycle.length]];
      acousticParts.push(
        `<line x1="${fmtNum(px)}" y1="${specTop - 3.5}" x2="${fmtNum(px)}" y2="${specTop + 3.0}" stroke="${RISO.navy}" stroke-opacity="0.42" stroke-width="0.7"/>`,
        `<circle cx="${fmtNum(px)}" cy="${specTop - 4.2}" r="2.2" fill="${col}" fill-opacity="0.92" style="mix-blend-mode:multiply"/>`
      );
    });
  }

  // Subtle horizontal divider rule beneath time ticks so ribbon caps never touch timestamps
  acousticParts.push(
    `<line x1="${contentLeft}" y1="${fmtNum(timeTickBaselineY)}" x2="${contentRight}" y2="${fmtNum(timeTickBaselineY)}" stroke="${RISO.navy}" stroke-opacity="0.09" stroke-width="0.65"/>`
  );

  // --------------------------------------------------------------------------
  // Card Column Geometry & Balanced Weighting (prevents cramped narrow cards!)
  // --------------------------------------------------------------------------
  const cards = model.cards;
  const nCards = Math.max(1, cards.length);
  const cardGap = nCards <= 5 ? 16 : 11.5;
  const netCardsW = contentW - cardGap * (nCards - 1);

  const weights = cards.map((c) => {
    const gLen = splitGraphemes(c.mainText).length;
    const isLatin = /[A-Za-z]/.test(c.mainText);
    const textW = c.isDialogue
      ? Math.max(1.16, 0.86 + gLen * (isLatin ? 0.14 : 0.13))
      : Math.max(1.0, gLen * (isLatin ? 0.27 : 0.42));
    const ipaW = Math.max(1.0, (c.row2Tokens.length || 2) * 0.24);
    return Math.max(c.isDialogue ? 1.16 : 1.0, Math.min(2.05, Math.max(textW, ipaW)));
  });
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;

  let curCardX = contentLeft;
  const cardLayouts = cards.map((card, i) => {
    const w = (weights[i] / weightSum) * netCardsW;
    const x0 = curCardX;
    const x1 = curCardX + w;
    curCardX = x1 + cardGap;

    const topX0 = timeAxis.timeToX(card.xmin);
    const topX1 = Math.max(topX0 + 6, timeAxis.timeToX(card.xmax));
    const y0 = blockBaseY + staggerOffsets[i % staggerOffsets.length];
    const y1 = y0 + blockH;

    return { ...card, topX0, topX1, x0, x1, w, xc: (x0 + x1) * 0.5, y0, y1 };
  });

  // --------------------------------------------------------------------------
  // #overprint-ribbons (Signature Translucent Multiply Crossing Bezier Ribbons)
  // --------------------------------------------------------------------------
  const ribbonParts: string[] = [];
  const avgBlockTop = cardLayouts.reduce((a, c) => a + c.y0, 0) / Math.max(1, cardLayouts.length);
  const ribSpanY = Math.max(80, avgBlockTop - ribbonTopY);

  if (cardLayouts.length >= 2) {
    const f = cardLayouts[0];
    const l = cardLayouts[cardLayouts.length - 1];
    const wy1 = ribbonTopY + ribSpanY * 0.34;
    const wy2 = ribbonTopY + ribSpanY * 0.16;
    const wy3 = ribbonTopY + ribSpanY * 0.68;
    const wy4 = ribbonTopY + ribSpanY * 0.44;
    const waveThick = 17;
    const waveD =
      `M ${fmtNum(f.x0)} ${fmtNum(wy1)} ` +
      `C ${fmtNum(contentLeft + contentW * 0.32)} ${fmtNum(wy2)}, ${fmtNum(contentLeft + contentW * 0.68)} ${fmtNum(wy3)}, ${fmtNum(l.x1)} ${fmtNum(wy4)} ` +
      `L ${fmtNum(l.x1)} ${fmtNum(wy4 + waveThick)} ` +
      `C ${fmtNum(contentLeft + contentW * 0.68)} ${fmtNum(wy3 + waveThick + 2)}, ${fmtNum(contentLeft + contentW * 0.32)} ${fmtNum(wy2 + waveThick + 2)}, ${fmtNum(f.x0)} ${fmtNum(wy1 + waveThick)} Z`;
    ribbonParts.push(
      `<path d="${waveD}" fill="${RISO.yellow}" fill-opacity="0.24" transform="translate(${PLATE_OFFSET.yellow.dx} ${PLATE_OFFSET.yellow.dy})" style="mix-blend-mode:multiply"/>`
    );
  }

  const plateMeta: Record<InkKey, { color: string; alpha: number; underCol: string; underKey: InkKey }> = {
    pink: { color: RISO.pink, alpha: 0.48, underCol: RISO.yellow, underKey: 'yellow' },
    yellow: { color: RISO.yellow, alpha: 0.66, underCol: RISO.pink, underKey: 'pink' },
    cyan: { color: RISO.cyan, alpha: 0.48, underCol: RISO.yellow, underKey: 'yellow' }
  };

  cardLayouts.forEach((cl, idx) => {
    const pm = plateMeta[cl.inkKey];
    const off = PLATE_OFFSET[cl.inkKey];
    // Compensate vertical plate offset at the block seam so NO white gap ever splits ribbon & block!
    const localTopY = ribbonTopY - off.dy * 0.45;
    const localBotY = cl.y0 - off.dy + (config.bgMode === 'transparent' ? 0.6 : 6.0);
    const midY1 = localTopY + (localBotY - localTopY) * 0.40;
    const midY2 = localTopY + (localBotY - localTopY) * 0.66;
    const swell = nCards > 1 ? 13.5 : 0;
    const leftSwell = idx === 0 ? 1.5 : swell;
    const rightSwell = idx === nCards - 1 ? 1.5 : swell;

    const ribD =
      `M ${fmtNum(cl.topX0)} ${fmtNum(localTopY)} ` +
      `C ${fmtNum(cl.topX0 - leftSwell)} ${fmtNum(midY1)}, ${fmtNum(cl.x0 - leftSwell)} ${fmtNum(midY2)}, ${fmtNum(cl.x0)} ${fmtNum(localBotY)} ` +
      `L ${fmtNum(cl.x1)} ${fmtNum(localBotY)} ` +
      `C ${fmtNum(cl.x1 + rightSwell)} ${fmtNum(midY2)}, ${fmtNum(cl.topX1 + rightSwell)} ${fmtNum(midY1)}, ${fmtNum(cl.topX1)} ${fmtNum(localTopY)} Z`;

    ribbonParts.push(
      `<g transform="translate(${off.dx} ${off.dy})" style="mix-blend-mode:multiply">` +
        `<line x1="${fmtNum(cl.topX0)}" y1="${fmtNum(localTopY - 1.6)}" x2="${fmtNum(cl.topX1)}" y2="${fmtNum(localTopY - 1.6)}" stroke="${pm.color}" stroke-opacity="0.90" stroke-width="2.4" stroke-linecap="round"/>` +
        `<path d="${ribD}" fill="${pm.color}" fill-opacity="${pm.alpha}" stroke="${pm.color}" stroke-opacity="0.62" stroke-width="0.8"/>` +
        `</g>`
    );
  });

  // --------------------------------------------------------------------------
  // #annotation-layers & #point-markers (Staggered Spot-Color Blocks + Dynamic Rows)
  // --------------------------------------------------------------------------
  const annotationParts: string[] = [];
  const pointParts: string[] = [];

  const maxBlockBotY = Math.max(...cardLayouts.map((c) => c.y1));
  const stemBottomY = maxBlockBotY + (isEmblem ? 22 : showPointDirectory ? 18 : 28);

  // Dynamically compute lower annotation row Y positions so absent tiers NEVER leave empty voids!
  let cursorY = stemBottomY;
  let rowBroadY = 0;
  let rowNarrowY = 0;
  let rowToneY = 0;
  const dividerYs: number[] = [];

  if (hasAnyRow1) {
    rowBroadY = cursorY + (showPointDirectory ? 24 : 30);
    cursorY = rowBroadY;
  }
  if (hasAnyRow2 && (!isEmblem || !hasAnyRow1)) {
    if (hasAnyRow1) {
      dividerYs.push(cursorY + (showPointDirectory ? 16 : 22));
      rowNarrowY = cursorY + (showPointDirectory ? 46 : 58);
    } else {
      rowNarrowY = cursorY + (showPointDirectory ? 32 : 40);
    }
    const maxTokCount = Math.max(...cardLayouts.map((c) => c.row2Tokens.length), 0);
    cursorY = rowNarrowY + (maxTokCount > 6 ? 26 : 12);
  }
  if (hasAnyTone && !isEmblem) {
    if (hasAnyRow1 || hasAnyRow2) {
      dividerYs.push(cursorY + (showPointDirectory ? 16 : 24));
      rowToneY = cursorY + (showPointDirectory ? 42 : 56);
    } else {
      rowToneY = cursorY + 34;
    }
    cursorY = rowToneY;
  }
  const rowTimeY = isEmblem
    ? Math.min(826, cursorY + 42)
    : cursorY + (showPointDirectory ? 32 : 48);

  if (!isEmblem) {
    for (const lineY of dividerYs) {
      annotationParts.push(
        `<line x1="${contentLeft}" y1="${fmtNum(lineY)}" x2="${contentRight}" y2="${fmtNum(lineY)}" stroke="${RISO.cyan}" stroke-opacity="0.22" stroke-width="0.75" stroke-dasharray="2.2 4.5"/>`
      );
    }
    const pushMarginTag = (label: string, y: number, color: string) => {
      if (!label) return;
      annotationParts.push(
        `<text x="${contentLeft - 12}" y="${fmtNum(y)}" text-anchor="end" font-size="9.8" font-weight="700" fill="${color}" fill-opacity="0.82" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(label)}</text>`
      );
    };
    if (hasAnyRow1) pushMarginTag(model.row1Tag, rowBroadY, RISO.cyan);
    if (hasAnyRow2) pushMarginTag(model.row2Tag, rowNarrowY, RISO.pink);
    if (hasAnyTone) pushMarginTag(model.row3Tag, rowToneY, RISO.navy);
    pushMarginTag('时间', rowTimeY, RISO.muted);
  }

  const knockoutFill = config.bgMode === 'transparent' ? '#FFFFFF' : RISO.paper;

  for (const cl of cardLayouts) {
    const pm = plateMeta[cl.inkKey];
    const off = PLATE_OFFSET[cl.inkKey];

    // +4.5px L-shaped offset under-plate accent block (behind opaque main block)
    annotationParts.push(
      `<rect x="${fmtNum(cl.x0 + 4.5)}" y="${fmtNum(cl.y0 + 4.5)}" width="${fmtNum(cl.w)}" height="${blockH}" rx="4.5" fill="${pm.underCol}" fill-opacity="0.64"/>`
    );

    // Opaque paper back-knockout (keeps vibrant spot ink pure over crossing ribbons!)
    if (config.bgMode !== 'transparent') {
      annotationParts.push(
        `<rect x="${fmtNum(cl.x0)}" y="${fmtNum(cl.y0)}" width="${fmtNum(cl.w)}" height="${blockH}" rx="4.5" fill="${RISO.paper}"/>`
      );
    }

    // Main vibrant Risograph spot-color block + subtle stencil screen grain overlay
    annotationParts.push(
      `<rect x="${fmtNum(cl.x0)}" y="${fmtNum(cl.y0)}" width="${fmtNum(cl.w)}" height="${blockH}" rx="4.5" fill="${pm.color}" fill-opacity="${cl.inkKey === 'yellow' ? '0.97' : '0.94'}"/>`,
      `<rect x="${fmtNum(cl.x0)}" y="${fmtNum(cl.y0)}" width="${fmtNum(cl.w)}" height="${blockH}" rx="4.5" fill="url(#${idPfx}ink-grain)"/>`
    );

    // Refined top-left index number (`01`..`07`) for gallery-grade typographic precision
    const idxTag = String(cl.index + 1).padStart(2, '0');
    const inkFg = cl.inkKey === 'yellow' ? RISO.navy : knockoutFill;
    annotationParts.push(
      `<text x="${fmtNum(cl.x0 + 7.5)}" y="${fmtNum(cl.y0 + 14)}" font-size="8.0" font-weight="700" letter-spacing="0.4" fill="${inkFg}" fill-opacity="${cl.inkKey === 'yellow' ? '0.58' : '0.72'}" font-family="${escapeXml(POSTER_MONO_STACK)}">${idxTag}</text>`
    );

    // Optional tiny speaker-role geometric glyph in top-right of dialogue cards (● = A, ◆ = B)
    if (cl.isDialogue && cl.speakerIdx >= 0) {
      const gx = cl.x1 - 10;
      const gy = cl.y0 + 11.5;
      if (cl.speakerIdx % 2 === 0) {
        annotationParts.push(
          `<circle cx="${fmtNum(gx)}" cy="${fmtNum(gy)}" r="2.6" fill="${inkFg}" fill-opacity="${cl.inkKey === 'yellow' ? '0.62' : '0.76'}"/>`
        );
      } else {
        annotationParts.push(
          `<rect x="${fmtNum(gx - 2.3)}" y="${fmtNum(gy - 2.3)}" width="4.6" height="4.6" transform="rotate(45 ${fmtNum(gx)} ${fmtNum(gy)})" fill="none" stroke="${inkFg}" stroke-opacity="${cl.inkKey === 'yellow' ? '0.72' : '0.84'}" stroke-width="1.15"/>`
        );
      }
    }

    // Block headline typography
    const padX = cl.w < 84 ? 6.5 : 9;
    const maxTextW = Math.max(26, cl.w - padX * 2);
    let baseFs = cl.isDialogue ? 18.5 : 29;
    if (/[A-Za-z]/.test(cl.mainText) && cl.mainText.length >= 6) baseFs = 24;
    const { lines, effFontSize } = wrapCardText(cl.mainText, maxTextW, baseFs);

    const textCenterY = cl.subLabel ? cl.y0 + blockH * 0.44 : cl.y0 + blockH * 0.52;
    const lineStep = effFontSize * 1.24;
    const firstLineY = textCenterY - ((lines.length - 1) * lineStep) * 0.5;

    // Subtle hairline separator above subLabel
    if (cl.subLabel) {
      annotationParts.push(
        `<line x1="${fmtNum(cl.x0 + 10)}" y1="${fmtNum(cl.y1 - 24)}" x2="${fmtNum(cl.x1 - 10)}" y2="${fmtNum(cl.y1 - 24)}" stroke="${inkFg}" stroke-opacity="${cl.inkKey === 'yellow' ? '0.18' : '0.26'}" stroke-width="0.65"/>`
      );
    }

    if (cl.inkKey !== 'yellow') {
      lines.forEach((ln, li) => {
        annotationParts.push(
          `<text x="${fmtNum(cl.xc)}" y="${fmtNum(firstLineY + li * lineStep)}" text-anchor="middle" dominant-baseline="central" font-size="${fmtNum(effFontSize)}" font-weight="900" fill="${knockoutFill}" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(ln)}</text>`
        );
      });
      if (cl.subLabel) {
        const fittedSub = fitSubLabelText(cl.subLabel, cl.subLabelCompact, maxTextW, 11.2, 8.8);
        annotationParts.push(
          `<text x="${fmtNum(cl.xc)}" y="${fmtNum(cl.y1 - 10.5)}" text-anchor="middle" font-size="${fmtNum(fittedSub.fontSize)}" font-weight="700" letter-spacing="0.2" fill="${knockoutFill}" fill-opacity="0.94" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(fittedSub.text)}</text>`
        );
      }
    } else {
      // Sunflower Yellow block: deep pine navy text + delicate coral pink offset shadow
      lines.forEach((ln, li) => {
        const ly = firstLineY + li * lineStep;
        annotationParts.push(
          `<text x="${fmtNum(cl.xc + 1.2)}" y="${fmtNum(ly + 1.0)}" text-anchor="middle" dominant-baseline="central" font-size="${fmtNum(effFontSize)}" font-weight="900" fill="${RISO.pink}" fill-opacity="0.38" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(ln)}</text>`,
          `<text x="${fmtNum(cl.xc)}" y="${fmtNum(ly)}" text-anchor="middle" dominant-baseline="central" font-size="${fmtNum(effFontSize)}" font-weight="900" fill="${RISO.navy}" fill-opacity="0.96" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(ln)}</text>`
        );
      });
      if (cl.subLabel) {
        const fittedSub = fitSubLabelText(cl.subLabel, cl.subLabelCompact, maxTextW, 11.2, 8.8);
        annotationParts.push(
          `<text x="${fmtNum(cl.xc)}" y="${fmtNum(cl.y1 - 10.5)}" text-anchor="middle" font-size="${fmtNum(fittedSub.fontSize)}" font-weight="700" letter-spacing="0.2" fill="${RISO.navy}" fill-opacity="0.86" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(fittedSub.text)}</text>`
        );
      }
    }

    // Dotted lead stem beneath block
    annotationParts.push(
      `<line x1="${fmtNum(cl.xc)}" y1="${fmtNum(cl.y1 + 6)}" x2="${fmtNum(cl.xc)}" y2="${fmtNum(stemBottomY)}" stroke="${pm.color}" stroke-opacity="0.58" stroke-width="1.05" stroke-dasharray="2.0 3.0" transform="translate(${off.dx * 0.35} 0)"/>`
    );

    // Row 1: Broad IPA / Secondary tier
    if (hasAnyRow1 && cl.row1Text) {
      let bFont = 13.8;
      const maxRow1W = Math.max(16, cl.w - 8);
      while (measurePx(cl.row1Text, `500 ${bFont.toFixed(1)}px ${POSTER_IPA_STACK}`) > maxRow1W && bFont > 9.8) {
        bFont -= 0.7;
      }
      const bDisp = truncateByGraphemes(cl.row1Text, maxRow1W, `500 ${bFont.toFixed(1)}px ${POSTER_IPA_STACK}`);
      annotationParts.push(
        `<text x="${fmtNum(cl.xc)}" y="${fmtNum(rowBroadY)}" text-anchor="middle" font-size="${fmtNum(bFont)}" font-weight="500" fill="${RISO.navy}" fill-opacity="0.78" font-family="${escapeXml(POSTER_IPA_STACK)}">${escapeXml(bDisp)}</text>`
      );
    } else if (hasAnyRow1) {
      annotationParts.push(
        `<circle cx="${fmtNum(cl.xc)}" cy="${fmtNum(rowBroadY - 4)}" r="1.5" fill="${RISO.navy}" fill-opacity="0.20"/>`
      );
    }

    // Row 2: Narrow IPA tokens OR Dialogue Focal Contrast IPA with signature Yellow+Pink overprint circles
    if (hasAnyRow2 && (!isEmblem || !hasAnyRow1)) {
      if (cl.row2Tokens.length > 0) {
        const toks = cl.row2Tokens;
        const tokenRows =
          toks.length > 6
            ? [toks.slice(0, Math.ceil(toks.length / 2)), toks.slice(Math.ceil(toks.length / 2))]
            : [toks];
        let nFont = toks.length >= 5 ? 15.2 : 16.8;

        const maxRowW = Math.max(
          ...tokenRows.map((tr) => {
            const gapX = tr.length >= 5 ? 4.2 : 6.4;
            return (
              tr.reduce((acc, tk) => acc + measurePx(tk.text, `600 ${nFont.toFixed(1)}px ${POSTER_IPA_STACK}`), 0) +
              gapX * Math.max(0, tr.length - 1)
            );
          })
        );
        if (maxRowW > cl.w - 8 && maxRowW > 0) {
          nFont = Math.max(10.0, nFont * ((cl.w - 8) / maxRowW));
        }

        const fontCss = `600 ${nFont.toFixed(1)}px ${POSTER_IPA_STACK}`;
        tokenRows.forEach((tRow, rIdx) => {
          const gapX = tRow.length >= 5 ? 4.2 : 6.4;
          const widths = tRow.map((tk) => Math.max(6, measurePx(tk.text, fontCss)));
          const rowW = widths.reduce((a, b) => a + b, 0) + gapX * Math.max(0, tRow.length - 1);
          let tx = cl.xc - rowW * 0.5;
          const ty = tokenRows.length === 2 ? rowNarrowY - 6 + rIdx * 23 : rowNarrowY + 4;

          tRow.forEach((tk, kIdx) => {
            const tw = widths[kIdx];
            const tokenCx = tx + tw * 0.5;
            if (tk.highlight) {
              const rad = Math.max(9.2, Math.min(18, tw * 0.58 + 2.5));
              annotationParts.push(
                `<circle cx="${fmtNum(tokenCx)}" cy="${fmtNum(ty - 5.2)}" r="${fmtNum(rad)}" fill="${RISO.yellow}" fill-opacity="0.80" style="mix-blend-mode:multiply"/>`,
                `<circle cx="${fmtNum(tokenCx + 1.4)}" cy="${fmtNum(ty - 4.0)}" r="${fmtNum(rad)}" fill="${RISO.pink}" fill-opacity="0.22" style="mix-blend-mode:multiply"/>`
              );
            }
            annotationParts.push(
              `<text x="${fmtNum(tx)}" y="${fmtNum(ty)}" font-size="${fmtNum(nFont)}" font-weight="600" fill="${RISO.navy}" fill-opacity="${tk.highlight ? '0.98' : '0.86'}" font-family="${escapeXml(POSTER_IPA_STACK)}">${escapeXml(tk.text)}</text>`
            );
            tx += tw + gapX;
          });
        });
      } else if (cl.isDialogue) {
        // Refined duration/cadence anchor on non-IPA dialogue turns so Row 2 has zero gaping blank holes
        const durTag = `${(cl.xmax - cl.xmin).toFixed(2)}s`;
        annotationParts.push(
          `<line x1="${fmtNum(cl.xc - 11)}" y1="${fmtNum(rowNarrowY - 1)}" x2="${fmtNum(cl.xc + 11)}" y2="${fmtNum(rowNarrowY - 1)}" stroke="${pm.color}" stroke-opacity="0.34" stroke-width="0.9"/>`,
          `<text x="${fmtNum(cl.xc)}" y="${fmtNum(rowNarrowY + 12)}" text-anchor="middle" font-size="9.0" font-weight="600" fill="${RISO.navy}" fill-opacity="0.42" font-family="${escapeXml(POSTER_MONO_STACK)}">${durTag}</text>`
        );
      } else {
        annotationParts.push(
          `<circle cx="${fmtNum(cl.xc)}" cy="${fmtNum(rowNarrowY)}" r="1.5" fill="${RISO.navy}" fill-opacity="0.20"/>`
        );
      }
    }

    // Row 3: Tone / Event Stamp Pill (zero double-ellipsis truncation!)
    if (hasAnyTone && !isEmblem) {
      const candidateTags = cl.toneTags.length ? cl.toneTags : cl.fallbackStamp ? [cl.fallbackStamp] : [];
      if (candidateTags.length > 0) {
        // Prefer joining 2 tags ONLY if they fit comfortably without truncation; otherwise show the single crisp primary tag
        let chosenStamp = candidateTags[0];
        if (candidateTags.length >= 2) {
          const joined = `${candidateTags[0]} · ${candidateTags[1]}`;
          const joinFont = IPA_CHAR_RE.test(joined) ? POSTER_IPA_STACK : POSTER_SANS_STACK;
          if (measurePx(joined, `600 9.6px ${joinFont}`) <= cl.w - 20) {
            chosenStamp = joined;
          }
        }
        const stampFont = IPA_CHAR_RE.test(chosenStamp) ? POSTER_IPA_STACK : POSTER_SANS_STACK;
        const maxStampTextW = Math.max(18, cl.w - 22);
        let tFont = 10.6;
        while (measurePx(chosenStamp, `600 ${tFont.toFixed(1)}px ${stampFont}`) > maxStampTextW && tFont > 8.6) {
          tFont -= 0.4;
        }
        const dispTone = truncateByGraphemes(chosenStamp, maxStampTextW, `600 ${tFont.toFixed(1)}px ${stampFont}`);
        const stampW = Math.min(cl.w, measurePx(dispTone, `600 ${tFont.toFixed(1)}px ${stampFont}`) + 22);
        pointParts.push(
          `<rect x="${fmtNum(cl.xc - stampW * 0.5)}" y="${fmtNum(rowToneY - 13.5)}" width="${fmtNum(stampW)}" height="20" rx="10" fill="${pm.color}" fill-opacity="${cl.inkKey === 'yellow' ? '0.44' : '0.17'}" style="mix-blend-mode:multiply"/>`,
          `<text x="${fmtNum(cl.xc)}" y="${fmtNum(rowToneY - 0.5)}" text-anchor="middle" font-size="${fmtNum(tFont)}" font-weight="600" fill="${RISO.navy}" fill-opacity="0.90" font-family="${escapeXml(stampFont)}">${escapeXml(dispTone)}</text>`
        );
      } else {
        pointParts.push(
          `<circle cx="${fmtNum(cl.xc)}" cy="${fmtNum(rowToneY - 3.5)}" r="1.5" fill="${RISO.navy}" fill-opacity="0.22"/>`
        );
      }
    }

    // Row 4: Time Interval Footer
    pointParts.push(
      `<text x="${fmtNum(cl.xc)}" y="${fmtNum(rowTimeY)}" text-anchor="middle" font-size="9.2" font-weight="600" fill="${RISO.navy}" fill-opacity="0.48" font-family="${escapeXml(POSTER_MONO_STACK)}">${cl.xmin.toFixed(2)}–${cl.xmax.toFixed(2)}s</text>`
    );
  }

  // --------------------------------------------------------------------------
  // Museum-Grade Bottom Point & Event Directory (`01–K`) in `poster_3_4`
  // Eliminates bottom empty void & matches Swiss Vinyl / Bauhaus precision!
  // --------------------------------------------------------------------------
  if (showPointDirectory) {
    const dirCycle: InkKey[] = ['pink', 'yellow', 'cyan'];
    const entries: PointDirectoryEntry[] = sortedPoints.map((pt, i) =>
      buildPointDirectoryEntry(pt, config.copy.pointNotes[String(pt.idx)], dirCycle[i % dirCycle.length])
    );

    const dirTopY = Math.max(rowTimeY + 28, 856);
    const dirBottomLimit = 1094;
    const availDirH = Math.max(90, dirBottomLimit - (dirTopY + 34));

    // Adaptive 2-column (<= 12 items) or 3-column (> 12 items) layout
    const nCols = entries.length > 12 ? 3 : 2;
    const maxRows = Math.max(3, Math.min(6, Math.floor(availDirH / 24.5)));
    const maxVisible = nCols * maxRows;
    const visibleEntries = entries.slice(0, maxVisible);
    const overflowCount = entries.length - visibleEntries.length;
    const actualRows = Math.ceil(visibleEntries.length / nCols);
    const rowStep = Math.min(30, Math.max(22.5, availDirH / Math.max(actualRows, 1)));

    const rawPtTierName = cleanDisplayTierName(pointTier?.name || '');
    const dirTitleZh = model.isDialogueMode
      ? '关键节点与事件'
      : /tone|声调|prosody|韵律/i.test(rawPtTierName)
        ? '声调与停顿标记'
        : rawPtTierName || '关键节点标注';
    const dirTitleEn = model.isDialogueMode ? 'EVENTS & LANDMARKS' : 'TONES & ACCENTS';
    const countLabel = `01–${String(entries.length).padStart(2, '0')}  ·  ${tMin.toFixed(2)} – ${tMax.toFixed(2)}s${
      overflowCount > 0 ? `  (+${overflowCount})` : ''
    }`;

    // Directory Header with 3-Plate Multiply Mini-Bar & Hairline Rule
    pointParts.push(
      `<rect x="${contentLeft}" y="${fmtNum(dirTopY)}" width="18" height="3.2" fill="${RISO.pink}" fill-opacity="0.90" style="mix-blend-mode:multiply"/>`,
      `<rect x="${contentLeft + 15}" y="${fmtNum(dirTopY)}" width="18" height="3.2" fill="${RISO.yellow}" fill-opacity="0.95" style="mix-blend-mode:multiply"/>`,
      `<rect x="${contentLeft + 30}" y="${fmtNum(dirTopY)}" width="18" height="3.2" fill="${RISO.cyan}" fill-opacity="0.90" style="mix-blend-mode:multiply"/>`,
      `<text x="${contentLeft}" y="${fmtNum(dirTopY + 18)}" font-size="10.2" font-weight="800" letter-spacing="0.5" fill="${RISO.navy}" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(dirTitleZh)}  ·  <tspan font-weight="700" fill="${RISO.cyan}" letter-spacing="1.0">${escapeXml(dirTitleEn)}</tspan></text>`,
      `<text x="${contentRight}" y="${fmtNum(dirTopY + 18)}" text-anchor="end" font-size="9.0" font-weight="600" fill="${RISO.navy}" fill-opacity="0.52" font-family="${escapeXml(POSTER_MONO_STACK)}">${escapeXml(countLabel)}</text>`,
      `<line x1="${contentLeft}" y1="${fmtNum(dirTopY + 25.5)}" x2="${contentRight}" y2="${fmtNum(dirTopY + 25.5)}" stroke="${RISO.navy}" stroke-opacity="0.16" stroke-width="0.75"/>`
    );

    const colGap = nCols === 3 ? 22 : 34;
    const colW = (contentW - colGap * (nCols - 1)) / nCols;
    const listStartY = dirTopY + 42;

    visibleEntries.forEach((entry, i) => {
      const colIdx = Math.floor(i / actualRows);
      const rowIdx = i % actualRows;
      const cx0 = contentLeft + colIdx * (colW + colGap);
      const ry = listStartY + rowIdx * rowStep;
      const inkCol = RISO[entry.inkKey];
      const badgeTextCol = entry.inkKey === 'yellow' ? RISO.navy : knockoutFill;
      const badgeNum = String(entry.idx + 1).padStart(2, '0');

      // Subtle row separator rule
      if (rowIdx > 0) {
        pointParts.push(
          `<line x1="${fmtNum(cx0)}" y1="${fmtNum(ry - rowStep * 0.52)}" x2="${fmtNum(cx0 + colW)}" y2="${fmtNum(ry - rowStep * 0.52)}" stroke="${RISO.navy}" stroke-opacity="0.08" stroke-width="0.6"/>`
        );
      }

      // Risograph ink-circle badge with subtle offset ghost ring
      const bx = cx0 + 7.5;
      const by = ry - 3.2;
      const shadowCol = entry.inkKey === 'yellow' ? RISO.pink : RISO.yellow;
      pointParts.push(
        `<circle cx="${fmtNum(bx + 1.0)}" cy="${fmtNum(by + 0.8)}" r="7.2" fill="${shadowCol}" fill-opacity="0.34" style="mix-blend-mode:multiply"/>`,
        `<circle cx="${fmtNum(bx)}" cy="${fmtNum(by)}" r="7.2" fill="${inkCol}" fill-opacity="${entry.inkKey === 'yellow' ? '0.96' : '0.90'}" style="mix-blend-mode:multiply"/>`,
        `<text x="${fmtNum(bx)}" y="${fmtNum(by)}" text-anchor="middle" dominant-baseline="central" font-size="7.2" font-weight="800" fill="${badgeTextCol}" font-family="${escapeXml(POSTER_MONO_STACK)}">${badgeNum}</text>`
      );

      // Monospace timestamp
      const timeX = cx0 + 21;
      const timeStr = `${entry.time.toFixed(2)}s`;
      pointParts.push(
        `<text x="${fmtNum(timeX)}" y="${fmtNum(ry)}" font-size="8.6" font-weight="600" fill="${RISO.navy}" fill-opacity="0.52" font-family="${escapeXml(POSTER_MONO_STACK)}">${timeStr}</text>`
      );

      // Bold primary tag + muted detail note
      const tagX = timeX + (tMax >= 10 ? 40 : 35);
      const availTextW = Math.max(40, cx0 + colW - tagX);

      const tagFont = IPA_CHAR_RE.test(entry.primaryTag) ? POSTER_IPA_STACK : POSTER_SANS_STACK;
      if (entry.detailNote) {
        const tagMaxW = Math.min(availTextW * 0.52, nCols === 3 ? 88 : 132);
        const tagCss = `700 9.6px ${tagFont}`;
        const tagDisp = truncateByGraphemes(entry.primaryTag, tagMaxW, tagCss);
        const tagW = measurePx(tagDisp, tagCss);
        const noteX = tagX + tagW + 8;
        const noteAvailW = Math.max(24, cx0 + colW - noteX);
        const noteFont = IPA_CHAR_RE.test(entry.detailNote) ? POSTER_IPA_STACK : POSTER_SANS_STACK;
        const noteDisp = truncateByGraphemes(entry.detailNote, noteAvailW, `500 9.0px ${noteFont}`);

        pointParts.push(
          `<text x="${fmtNum(tagX)}" y="${fmtNum(ry)}" font-size="9.6" font-weight="700" fill="${RISO.navy}" fill-opacity="0.94" font-family="${escapeXml(tagFont)}">${escapeXml(tagDisp)}</text>`,
          `<text x="${fmtNum(noteX)}" y="${fmtNum(ry)}" font-size="9.0" font-weight="500" fill="${RISO.muted}" fill-opacity="0.88" font-family="${escapeXml(noteFont)}">${escapeXml(noteDisp)}</text>`
        );
      } else {
        const tagDisp = truncateByGraphemes(entry.primaryTag, availTextW, `700 9.6px ${tagFont}`);
        pointParts.push(
          `<text x="${fmtNum(tagX)}" y="${fmtNum(ry)}" font-size="9.6" font-weight="700" fill="${RISO.navy}" fill-opacity="0.94" font-family="${escapeXml(tagFont)}">${escapeXml(tagDisp)}</text>`
        );
      }
    });
  }

  // --------------------------------------------------------------------------
  // #editorial-copy (3-Plate Press Header + Misaligned Lockup + Press Colophon)
  // --------------------------------------------------------------------------
  let editorialGroup = '';
  if (!isEmblem && !config.pureVisual) {
    const edParts: string[] = [];
    const titleCn = truncateByGraphemes(
      config.copy.title.trim() || autoCopy.title,
      280,
      `900 35px ${POSTER_CJK_SERIF_STACK}`
    );

    // Top 3-Plate Risograph Overprint Press Bar (iconic printmaker signature)
    edParts.push(
      `<rect x="${contentLeft}" y="58" width="38" height="4.8" rx="1" fill="${RISO.pink}" fill-opacity="0.90" style="mix-blend-mode:multiply"/>`,
      `<rect x="${contentLeft + 33}" y="58" width="28" height="4.8" rx="1" fill="${RISO.yellow}" fill-opacity="0.94" style="mix-blend-mode:multiply"/>`,
      `<rect x="${contentLeft + 56}" y="58" width="20" height="4.8" rx="1" fill="${RISO.cyan}" fill-opacity="0.90" style="mix-blend-mode:multiply"/>`
    );

    // Top metadata eyebrow
    edParts.push(
      `<text x="${contentLeft}" y="82" font-size="10.5" font-weight="700" letter-spacing="2.0" fill="${RISO.cyan}" font-family="${escapeXml(POSTER_SANS_STACK)}" transform="translate(${PLATE_OFFSET.cyan.dx * 0.7} ${PLATE_OFFSET.cyan.dy * 0.7})">${escapeXml(autoCopy.sideLabel)}</text>`,
      `<text x="${contentRight}" y="82" text-anchor="end" font-size="11.0" font-weight="600" fill="${RISO.navy}" fill-opacity="0.66" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(truncateByGraphemes(model.layerSummary, 430, `600 11px ${POSTER_SANS_STACK}`))}</text>`
    );

    // Monumental Misaligned Overprint Title (`VOICE & PRINT` + Chinese serif lockup)
    const titleY = 142;
    edParts.push(
      `<text x="${fmtNum(contentLeft + 2.5)}" y="${fmtNum(titleY + 2.1)}" font-size="54" font-weight="900" letter-spacing="-1.0" fill="${RISO.yellow}" fill-opacity="0.94" font-family="${escapeXml(POSTER_DISPLAY_SANS_STACK)}" style="mix-blend-mode:multiply">VOICE &amp; PRINT</text>`,
      `<text x="${contentLeft}" y="${titleY}" font-size="54" font-weight="900" letter-spacing="-1.0" fill="${RISO.pink}" fill-opacity="0.92" font-family="${escapeXml(POSTER_DISPLAY_SANS_STACK)}" style="mix-blend-mode:multiply">VOICE &amp; PRINT</text>`,
      `<text x="${fmtNum(contentRight + 1.8)}" y="${fmtNum(titleY - 1 + 1.4)}" text-anchor="end" font-size="35" font-weight="900" fill="${RISO.pink}" fill-opacity="0.44" font-family="${escapeXml(POSTER_CJK_SERIF_STACK)}" style="mix-blend-mode:multiply">${escapeXml(titleCn)}</text>`,
      `<text x="${contentRight}" y="${titleY - 1}" text-anchor="end" font-size="35" font-weight="900" fill="${RISO.cyan}" fill-opacity="0.95" font-family="${escapeXml(POSTER_CJK_SERIF_STACK)}" style="mix-blend-mode:multiply">${escapeXml(titleCn)}</text>`
    );

    // Right 3-dot acoustic legend (measure first so subtitle never collides!)
    const subY = 184;
    const legendItems: Array<{ label: string; color: string; on: boolean }> = [
      { label: '声波起伏', color: RISO.pink, on: !hasAudio || config.showWaveform },
      { label: '声音频谱', color: RISO.cyan, on: !hasAudio || config.showSpectrogram },
      { label: '声调曲线', color: RISO.yellow, on: hasAudio && config.showPitch && f0Runs.length > 0 }
    ].filter((it) => it.on);

    let lx = contentRight;
    const legCss = `600 10.8px ${POSTER_SANS_STACK}`;
    for (let i = legendItems.length - 1; i >= 0; i--) {
      const item = legendItems[i];
      const tw = measurePx(item.label, legCss);
      lx -= tw;
      edParts.push(
        `<text x="${fmtNum(lx)}" y="${subY - 1}" font-size="10.8" font-weight="600" fill="${RISO.navy}" fill-opacity="0.68" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(item.label)}</text>`
      );
      lx -= 10.5;
      edParts.push(
        `<circle cx="${fmtNum(lx + 3)}" cy="${subY - 4.8}" r="4.0" fill="${item.color}" fill-opacity="0.92" style="mix-blend-mode:multiply"/>`
      );
      lx -= 13;
    }

    // Subtitle overlapping squares + quote (dynamically bounded against legend!)
    const rawSub = config.copy.subtitle.trim() || autoCopy.subtitle;
    const subQuote = rawSub.startsWith('「') ? rawSub : `「${rawSub}」`;
    const subMaxW = Math.max(180, lx - (contentLeft + 26) - 10);
    edParts.push(
      `<rect x="${contentLeft}" y="${subY - 13.5}" width="13.5" height="15" rx="2" fill="${RISO.yellow}" style="mix-blend-mode:multiply"/>`,
      `<rect x="${contentLeft + 3.8}" y="${subY - 10.5}" width="13.5" height="15" rx="2" fill="${RISO.pink}" fill-opacity="0.74" style="mix-blend-mode:multiply"/>`,
      `<text x="${contentLeft + 25}" y="${subY}" font-size="16.2" font-weight="700" fill="${RISO.navy}" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(truncateByGraphemes(subQuote, subMaxW, `700 16.2px ${POSTER_SANS_STACK}`))}</text>`,
      `<line x1="${contentLeft}" y1="200" x2="${contentRight}" y2="200" stroke="${RISO.navy}" stroke-opacity="0.12" stroke-width="0.75"/>`
    );

    // Bottom 3-Color Risograph Studio Colophon + Drum Density Step Bar (`y = 1134`)
    const footRuleY = 1110;
    const footY = 1134;
    const swX = contentLeft + 6.5;
    const footLeft =
      config.copy.footer.trim() ||
      '3-COLOR RISOGRAPH OVERPRINT  ·  CORAL PINK / LAKE CYAN / SUNFLOWER YELLOW';
    const srTag =
      hasAudio && audioSampleRate > 0
        ? `${(audioSampleRate / 1000).toFixed(audioSampleRate % 1000 === 0 ? 0 : 1)} kHz  ·  VOICE & PRINT`
        : 'TEXTGRID EDITION  ·  VOICE & PRINT';

    // Authentic 3-plate ink density step wedge (3 opacity steps × 3 drums) beside right colophon
    const srWidth = measurePx(srTag, `600 9.4px ${POSTER_MONO_STACK}`);
    const wedgeRight = contentRight - srWidth - 18;
    const wedgeParts: string[] = [];
    const drumCols = [RISO.pink, RISO.yellow, RISO.cyan];
    const stepOps = [0.92, 0.52, 0.22];
    const cellW = 5.5;
    const wedgeW = drumCols.length * stepOps.length * cellW + 8;
    let wx = wedgeRight - wedgeW;
    drumCols.forEach((col, dIdx) => {
      stepOps.forEach((op) => {
        wedgeParts.push(
          `<rect x="${fmtNum(wx)}" y="${fmtNum(footY - 8.2)}" width="${cellW}" height="6.8" fill="${col}" fill-opacity="${op}" style="mix-blend-mode:multiply"/>`
        );
        wx += cellW;
      });
      if (dIdx < drumCols.length - 1) wx += 4;
    });

    const maxFootLeftW = Math.max(220, wedgeRight - wedgeW - (contentLeft + 38) - 14);
    edParts.push(
      `<line x1="${contentLeft}" y1="${footRuleY}" x2="${contentRight}" y2="${footRuleY}" stroke="${RISO.navy}" stroke-opacity="0.14" stroke-width="0.7"/>`,
      `<circle cx="${swX}" cy="${footY - 4.2}" r="6.2" fill="${RISO.pink}" fill-opacity="0.88" style="mix-blend-mode:multiply"/>`,
      `<circle cx="${swX + 8.5}" cy="${footY - 4.2}" r="6.2" fill="${RISO.yellow}" fill-opacity="0.90" style="mix-blend-mode:multiply"/>`,
      `<circle cx="${swX + 17}" cy="${footY - 4.2}" r="6.2" fill="${RISO.cyan}" fill-opacity="0.88" style="mix-blend-mode:multiply"/>`,
      `<text x="${contentLeft + 34}" y="${footY}" font-size="9.2" font-weight="600" letter-spacing="1.1" fill="${RISO.navy}" fill-opacity="0.52" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(truncateByGraphemes(footLeft, maxFootLeftW, `600 9.2px ${POSTER_SANS_STACK}`))}</text>`,
      ...wedgeParts,
      `<text x="${contentRight}" y="${footY}" text-anchor="end" font-size="9.4" font-weight="600" letter-spacing="0.7" fill="${RISO.navy}" fill-opacity="0.54" font-family="${escapeXml(POSTER_MONO_STACK)}">${escapeXml(srTag)}</text>`
    );

    editorialGroup = `<g id="editorial-copy">${edParts.join('')}</g>`;
  }

  const printMarksGroup = config.includeBleed ? renderPrintMarksSvg(trimW, trimH, bleed) : '';

  const svgMarkup =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmtNum(widthPt)}pt" height="${fmtNum(heightPt)}pt" viewBox="${fmtNum(-bleed)} ${fmtNum(-bleed)} ${fmtNum(widthPt)} ${fmtNum(heightPt)}">` +
    `<defs>${defs}</defs>` +
    paperBgGroup +
    regMarksGroup +
    `<g id="acoustic-traces">${acousticParts.join('')}</g>` +
    `<g id="overprint-ribbons">${ribbonParts.join('')}</g>` +
    `<g id="annotation-layers">${annotationParts.join('')}</g>` +
    `<g id="point-markers">${pointParts.join('')}</g>` +
    editorialGroup +
    printMarksGroup +
    `</svg>`;

  return {
    svgMarkup,
    widthPt,
    heightPt,
    trimWidthPt: trimW,
    trimHeightPt: trimH,
    bleedPt: bleed,
    activeIntervalCount: intervalEntries.length,
    activePointCount: sortedPoints.length
  };
}
