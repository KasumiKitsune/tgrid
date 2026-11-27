import type { TextGrid, Tier } from '../../bridge/types';
import { measurePx, splitGraphemes } from '../../layout/richText';
import {
  IPA_CHAR_RE,
  POSTER_DISPLAY_SANS_STACK,
  POSTER_IPA_STACK,
  POSTER_MONO_STACK,
  POSTER_SANS_STACK,
  escapeXml,
  fmtNum,
  isTierIpaLike,
  renderPrintMarksSvg,
  resolvePosterText,
  truncateByGraphemes
} from './polarSolver';
import {
  renderBraunSpectrogramDataUrl,
  type PosterAcousticMetrics,
  type PosterSpecMatrix
} from './posterAcoustics';
import { POSTER_BLEED_PT, type PosterAutoCopy, type PosterConfig } from './types';

export interface RenderBraunStripParams {
  tg: TextGrid;
  tMin: number;
  tMax: number;
  config: PosterConfig;
  autoCopy: PosterAutoCopy;
  specMatrix: PosterSpecMatrix | null;
  waveformBins: Array<[number, number]> | null;
  f0Runs: Array<Array<{ t: number; normF0: number }>>;
  metrics: PosterAcousticMetrics;
  hasAudio: boolean;
  audioSampleRate: number;
  maxFreq: number;
  previewMode: boolean;
}

const BRAUN = {
  chassisTop: '#EFECE6',
  chassisMid: '#EAE8E2',
  chassisBot: '#E1DFD8',
  chassisSeamDark: '#CECCC5',
  chassisSeamLight: '#F7F6F2',
  orange: '#E84A27',
  orangeDeep: '#C93A1B',
  ink: '#1A1A18',
  inkSoft: '#353430',
  sub: '#62615C',
  muted: '#8C8B84',
  rule: '#DFDED8',
  ruleMid: '#C7C6BF',
  ruleDark: '#262624',
  paper: '#FFFFFF',
  cellTintPrimary: '#F7F6F1',
  cellTintSecondary: '#F2F1EB',
  gridFine: '#F0EFE9'
};

interface SilenceSpan {
  start: number;
  end: number;
  duration: number;
}

interface AcousticPiece {
  t0: number;
  t1: number;
  effDur: number;
  isSilence: boolean;
  x0: number;
  x1: number;
}

interface AcousticRuler {
  pieces: AcousticPiece[];
  timeToX: (t: number) => number;
  xToTime: (x: number) => number;
}

interface StripTierRow {
  tier: Tier;
  tierIdx: number;
  orderNum: number;
  kind: 'interval' | 'point';
  label: string;
  rowH: number;
  isIpa: boolean;
  fontSize: number;
  fontWeight: number;
  isEmpty: boolean;
}

interface IndexedPointEntry {
  idx: number;
  badge: string;
  time: number;
  rawMark: string;
  shortLabel: string;
  fullLabel: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function dbToAngle(db: number): number {
  const norm = (clamp(db, -30, 0) + 30) / 30;
  return -120 + norm * 240;
}

function hzToAngle(hz: number): number {
  const norm = (clamp(hz, 50, 450) - 50) / 400;
  return -120 + norm * 240;
}

function formatBraunPointShort(rawMark: string, customNote?: string): string {
  if (customNote && customNote.trim()) {
    const noteTrim = customNote.trim();
    return truncateByGraphemes(noteTrim, 72, `500 9.6px ${IPA_CHAR_RE.test(noteTrim) ? POSTER_IPA_STACK : POSTER_SANS_STACK}`);
  }
  const m = resolvePosterText(rawMark);
  if (!m) return '';
  const toneMatch = m.match(/^!?T([0-5])(?:\[(\d+)\])?/i);
  if (toneMatch) {
    const toneNum = toneMatch[1];
    const digits = toneMatch[2] || '';
    const names: Record<string, string> = {
      '1': '一声',
      '2': '二声',
      '3': '三声',
      '4': '四声',
      '0': '轻声',
      '5': '轻声'
    };
    if (toneNum === '0' || toneNum === '5') return '轻声';
    return digits ? `${names[toneNum] || toneNum} ${digits}` : names[toneNum] || m;
  }
  if (/^!?H\*$/i.test(m)) return '重读';
  if (/^[HL]-\s*\/\s*B2$/i.test(m)) return '停顿';
  if (/B4/i.test(m)) return '句尾降调';
  return truncateByGraphemes(m, 72, `500 9.6px ${IPA_CHAR_RE.test(m) ? POSTER_IPA_STACK : POSTER_SANS_STACK}`);
}

function formatBraunPointFull(rawMark: string, customNote?: string): string {
  const cleanMark = resolvePosterText(rawMark);
  const note = customNote?.trim() || '';
  if (note && cleanMark && note !== cleanMark) {
    return `${cleanMark} · ${note}`;
  }
  if (note) return note;
  if (!cleanMark) return '';

  const toneMatch = cleanMark.match(/^!?T([0-5])(?:\[(\d+)\])?$/i);
  if (toneMatch) {
    const toneNum = toneMatch[1];
    const digits = toneMatch[2] || '';
    const desc: Record<string, string> = {
      '1': '一声高平调',
      '2': '二声扬升调',
      '3': '三声低降调',
      '4': '四声全降调',
      '0': '轻声短弱调',
      '5': '轻声短弱调'
    };
    return `${cleanMark} · ${desc[toneNum] || (digits ? `调值 ${digits}` : '')}`;
  }
  if (/^!?H\*$/i.test(cleanMark)) return `${cleanMark} · 语调重音峰`;
  if (/^[HL]-\s*\/\s*B2$/i.test(cleanMark)) return `${cleanMark} · 词界微停顿`;
  if (/B4/i.test(cleanMark)) return `${cleanMark} · 句末边界降调`;
  return cleanMark;
}

function detectLongSilences(
  intervalTiers: Tier[],
  waveformBins: Array<[number, number]> | null,
  gMin: number,
  gMax: number,
  tStart: number,
  tEnd: number
): SilenceSpan[] {
  const activeSpans: Array<[number, number]> = [];
  for (const tier of intervalTiers) {
    for (const iv of tier.intervals) {
      if (resolvePosterText(iv.text) !== '') {
        const a = Math.max(tStart, iv.xmin);
        const b = Math.min(tEnd, iv.xmax);
        if (b > a + 1e-4) activeSpans.push([a, b]);
      }
    }
  }

  if (activeSpans.length === 0 && waveformBins && waveformBins.length > 0) {
    const n = waveformBins.length;
    const totalDur = Math.max(0.01, gMax - gMin);
    for (let i = 0; i < n; i++) {
      const a = gMin + (i / n) * totalDur;
      const b = gMin + ((i + 1) / n) * totalDur;
      if (b <= tStart || a >= tEnd) continue;
      const amp = Math.abs(waveformBins[i][1]) + Math.abs(waveformBins[i][0]);
      if (amp > 0.05) activeSpans.push([Math.max(tStart, a), Math.min(tEnd, b)]);
    }
  }

  if (activeSpans.length === 0) return [];
  activeSpans.sort((u, v) => u[0] - v[0]);
  const merged: Array<[number, number]> = [[activeSpans[0][0], activeSpans[0][1]]];
  for (let i = 1; i < activeSpans.length; i++) {
    const prev = merged[merged.length - 1];
    if (activeSpans[i][0] <= prev[1] + 0.015) {
      prev[1] = Math.max(prev[1], activeSpans[i][1]);
    } else {
      merged.push([activeSpans[i][0], activeSpans[i][1]]);
    }
  }

  const silences: SilenceSpan[] = [];
  let cursor = tStart;
  for (const [a, b] of merged) {
    const gap = a - cursor;
    if (gap >= 0.5) {
      silences.push({ start: cursor, end: a, duration: gap });
    }
    cursor = Math.max(cursor, b);
  }
  if (tEnd - cursor >= 0.5) {
    silences.push({ start: cursor, end: tEnd, duration: tEnd - cursor });
  }
  return silences;
}

function buildAcousticRuler(
  tStart: number,
  tEnd: number,
  xLeft: number,
  trackWidth: number,
  silences: SilenceSpan[]
): AcousticRuler {
  const COMPRESSED_SIL_EQUIV = 0.24;
  const pieces: AcousticPiece[] = [];
  let cursor = tStart;
  for (const s of silences) {
    if (s.start > cursor + 1e-5) {
      pieces.push({ t0: cursor, t1: s.start, effDur: s.start - cursor, isSilence: false, x0: 0, x1: 0 });
    }
    pieces.push({
      t0: s.start,
      t1: s.end,
      effDur: Math.min(s.end - s.start, COMPRESSED_SIL_EQUIV),
      isSilence: true,
      x0: 0,
      x1: 0
    });
    cursor = s.end;
  }
  if (tEnd > cursor + 1e-5) {
    pieces.push({ t0: cursor, t1: tEnd, effDur: tEnd - cursor, isSilence: false, x0: 0, x1: 0 });
  }
  if (pieces.length === 0) {
    pieces.push({
      t0: tStart,
      t1: tEnd,
      effDur: Math.max(0.01, tEnd - tStart),
      isSilence: false,
      x0: 0,
      x1: 0
    });
  }

  const totalEff = Math.max(
    1e-5,
    pieces.reduce((acc, p) => acc + p.effDur, 0)
  );
  let xAcc = xLeft;
  for (const p of pieces) {
    const w = (p.effDur / totalEff) * trackWidth;
    p.x0 = xAcc;
    p.x1 = xAcc + w;
    xAcc += w;
  }

  const timeToX = (t: number): number => {
    if (t <= tStart) return xLeft;
    if (t >= tEnd) return xLeft + trackWidth;
    for (const p of pieces) {
      if (t >= p.t0 && t <= p.t1 + 1e-7) {
        const frac = (t - p.t0) / Math.max(1e-7, p.t1 - p.t0);
        return p.x0 + frac * (p.x1 - p.x0);
      }
    }
    return xLeft + trackWidth;
  };

  const xToTime = (x: number): number => {
    if (x <= xLeft) return tStart;
    if (x >= xLeft + trackWidth) return tEnd;
    for (const p of pieces) {
      if (x >= p.x0 && x <= p.x1 + 1e-5) {
        const frac = (x - p.x0) / Math.max(1e-7, p.x1 - p.x0);
        return p.t0 + frac * (p.t1 - p.t0);
      }
    }
    return tEnd;
  };

  return { pieces, timeToX, xToTime };
}

function buildElasticTextRuler(
  tStart: number,
  tEnd: number,
  xLeft: number,
  trackWidth: number,
  acousticRuler: AcousticRuler,
  tierRows: StripTierRow[]
): { knots: number[]; knotX: Float64Array; timeToTextX: (t: number) => number } {
  const rawTimes: number[] = [tStart, tEnd];
  for (const row of tierRows) {
    if (row.kind !== 'interval') continue;
    for (const iv of row.tier.intervals) {
      const a = clamp(iv.xmin, tStart, tEnd);
      const b = clamp(iv.xmax, tStart, tEnd);
      if (b > a + 1e-5) rawTimes.push(a, b);
    }
  }
  rawTimes.sort((a, b) => a - b);

  const knots: number[] = [rawTimes[0]];
  for (let i = 1; i < rawTimes.length; i++) {
    if (rawTimes[i] - knots[knots.length - 1] > 0.0025) {
      knots.push(rawTimes[i]);
    }
  }
  if (knots.length < 2) knots.push(tEnd);
  else knots[knots.length - 1] = tEnd;

  const M = knots.length - 1;
  const weights = new Float64Array(M);
  const minCellW = new Float64Array(M);
  for (let k = 0; k < M; k++) {
    weights[k] = Math.max(2, acousticRuler.timeToX(knots[k + 1]) - acousticRuler.timeToX(knots[k]));
    minCellW[k] = 1.5;
  }

  const findKnotIdx = (t: number): number => {
    let best = 0;
    let bestDist = Infinity;
    for (let k = 0; k < knots.length; k++) {
      const d = Math.abs(knots[k] - t);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    }
    return best;
  };

  const constraints: Array<{ i0: number; i1: number; req: number }> = [];
  for (const row of tierRows) {
    if (row.kind !== 'interval') continue;
    const fontStack = row.isIpa ? POSTER_IPA_STACK : POSTER_SANS_STACK;
    const fontCss = `${row.fontWeight} ${row.fontSize.toFixed(1)}px ${fontStack}`;
    for (const iv of row.tier.intervals) {
      const txt = resolvePosterText(iv.text);
      if (!txt) continue;
      const a = Math.max(tStart, iv.xmin);
      const b = Math.min(tEnd, iv.xmax);
      if (b - a < 0.003) continue;
      const i0 = findKnotIdx(a);
      const i1 = Math.max(i0 + 1, findKnotIdx(b));
      if (i1 > M) continue;
      const textPx = measurePx(txt, fontCss);
      const needed = Math.min(trackWidth * 0.78, textPx + (row.isIpa ? 16 : 20));
      constraints.push({ i0, i1, req: needed });
    }
  }

  for (let iter = 0; iter < 5; iter++) {
    for (const con of constraints) {
      let cur = 0;
      for (let k = con.i0; k < con.i1; k++) cur += weights[k];
      if (cur < con.req) {
        const extra = con.req - cur;
        const spanSum = Math.max(1e-5, cur);
        for (let k = con.i0; k < con.i1; k++) {
          weights[k] += extra * (weights[k] / spanSum);
          minCellW[k] = Math.max(minCellW[k], weights[k] * 0.82);
        }
      }
    }
    let totalW = 0;
    let totalMin = 0;
    for (let k = 0; k < M; k++) {
      totalW += weights[k];
      totalMin += minCellW[k];
    }
    if (totalMin >= trackWidth * 0.96) {
      const scale = trackWidth / Math.max(1e-5, totalW);
      for (let k = 0; k < M; k++) weights[k] *= scale;
    } else if (totalW > trackWidth) {
      const shrinkable = Math.max(1e-5, totalW - totalMin);
      const targetShrink = totalW - trackWidth;
      for (let k = 0; k < M; k++) {
        const slack = Math.max(0, weights[k] - minCellW[k]);
        weights[k] -= targetShrink * (slack / shrinkable);
      }
    } else {
      const scale = trackWidth / Math.max(1e-5, totalW);
      for (let k = 0; k < M; k++) weights[k] *= scale;
    }
  }

  let finalSum = 0;
  for (let k = 0; k < M; k++) finalSum += weights[k];
  const normFactor = trackWidth / Math.max(1e-5, finalSum);
  const knotX = new Float64Array(knots.length);
  knotX[0] = xLeft;
  for (let k = 0; k < M; k++) {
    knotX[k + 1] = knotX[k] + weights[k] * normFactor;
  }
  knotX[knots.length - 1] = xLeft + trackWidth;

  const timeToTextX = (t: number): number => {
    if (t <= tStart) return xLeft;
    if (t >= tEnd) return xLeft + trackWidth;
    for (let k = 0; k < M; k++) {
      if (t >= knots[k] && t <= knots[k + 1] + 1e-7) {
        const frac = (t - knots[k]) / Math.max(1e-7, knots[k + 1] - knots[k]);
        return knotX[k] + frac * (knotX[k + 1] - knotX[k]);
      }
    }
    return xLeft + trackWidth;
  };

  return { knots, knotX, timeToTextX };
}

function chooseSplitTime(
  intervalTiers: Tier[],
  waveformBins: Array<[number, number]> | null,
  tMin: number,
  tMax: number
): number {
  const mid = (tMin + tMax) * 0.5;
  const dur = Math.max(0.01, tMax - tMin);
  const silences = detectLongSilences(intervalTiers, waveformBins, tMin, tMax, tMin, tMax);

  let bestSplit = mid;
  let bestScore = Infinity;
  for (const s of silences) {
    const sMid = (s.start + s.end) * 0.5;
    const rel = (sMid - tMin) / dur;
    if (rel >= 0.3 && rel <= 0.7) {
      const dist = Math.abs(sMid - mid);
      if (dist < bestScore) {
        bestScore = dist;
        // Split cleanly near the tail of the silence so Segment 2 begins crisply before speech
        // without an awkward leading '//' break colliding with Segment 2's start tick!
        const splitPt = s.duration >= 0.55 ? s.end - Math.min(0.16, s.duration * 0.25) : sMid;
        bestSplit = Math.round(splitPt * 100) / 100;
      }
    }
  }
  if (bestScore < Infinity) return bestSplit;

  for (const tier of intervalTiers) {
    for (const iv of tier.intervals) {
      const b = iv.xmax;
      const rel = (b - tMin) / dur;
      if (rel >= 0.38 && rel <= 0.62 && Math.abs(b - mid) < bestScore) {
        bestScore = Math.abs(b - mid);
        bestSplit = b;
      }
    }
  }
  return bestSplit;
}

/**
 * Museum-grade Braun TG-60 / Dieter Rams recessed analog meter.
 * Numerals sit outside the scale arc so the tapered pointer needle kisses the ticks
 * with ZERO needle-over-number collision. Pure vector + multi-stop gradients (zero SVG filters).
 */
function renderDialSvg(opts: {
  idPfx: string;
  cx: number;
  cy: number;
  r: number;
  minVal: number;
  maxVal: number;
  majorStep: number;
  minorStep: number;
  labelSet: number[];
  titleZh: string;
  subEn: string;
  value: number | null;
  unitSuffix: 'dB' | 'Hz';
  highlightFrom: number | null;
  hideLabels: boolean;
}): string {
  const {
    idPfx,
    cx,
    cy,
    r,
    minVal,
    maxVal,
    majorStep,
    minorStep,
    labelSet,
    titleZh,
    subEn,
    value,
    unitSuffix,
    highlightFrom,
    hideLabels
  } = opts;
  const parts: string[] = [];

  const polar = (radius: number, degFromTop: number): [number, number] => {
    const rad = ((degFromTop - 90) * Math.PI) / 180;
    return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
  };

  // 1. Machined recessed well in anodized aluminum deck
  parts.push(
    `<circle cx="${cx}" cy="${cy}" r="${fmtNum(r + 6.5)}" fill="url(#${idPfx}well-grad)"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${fmtNum(r + 6.5)}" fill="none" stroke="#F7F6F2" stroke-width="0.85" stroke-opacity="0.85"/>`,
    `<circle cx="${fmtNum(cx - 0.5)}" cy="${fmtNum(cy - 0.5)}" r="${fmtNum(r + 4.4)}" fill="none" stroke="#C0BEB6" stroke-width="0.9" stroke-opacity="0.75"/>`
  );

  // 2. Machined dark-anodized outer bezel ring + recessed dial dish
  parts.push(
    `<circle cx="${cx}" cy="${cy}" r="${fmtNum(r + 2.4)}" fill="url(#${idPfx}bezel-grad)"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${fmtNum(r - 0.6)}" fill="url(#${idPfx}dial-face)" stroke="#494844" stroke-width="0.65"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${fmtNum(r - 3.6)}" fill="none" stroke="#DDDCD4" stroke-width="0.65"/>`
  );

  // 3. Scale arc geometry: numerals OUTSIDE arc (rNum), needle stops at rArc + 3 (zero text clash!)
  const sweep = 240;
  const startDeg = -120;
  const rArc = r - 25.5;
  const rMirror = rArc - 4.8;
  const rNum = r - 12.8;

  const [mx0, my0] = polar(rMirror, startDeg);
  const [mx1, my1] = polar(rMirror, startDeg + sweep);
  parts.push(
    `<path d="M ${fmtNum(mx0)} ${fmtNum(my0)} A ${fmtNum(rMirror)} ${fmtNum(rMirror)} 0 1 1 ${fmtNum(mx1)} ${fmtNum(my1)}" fill="none" stroke="#DCDBD4" stroke-width="0.85"/>`
  );

  const [sx, sy] = polar(rArc, startDeg);
  const [ex, ey] = polar(rArc, startDeg + sweep);
  parts.push(
    `<path d="M ${fmtNum(sx)} ${fmtNum(sy)} A ${fmtNum(rArc)} ${fmtNum(rArc)} 0 1 1 ${fmtNum(ex)} ${fmtNum(ey)}" fill="none" stroke="#3B3A37" stroke-width="0.85"/>`
  );

  // Braun orange-red overload / peak band (-3..0 dB)
  if (highlightFrom !== null) {
    const a0 = startDeg + ((highlightFrom - minVal) / (maxVal - minVal)) * sweep;
    const rPeak = rArc + 1.3;
    const [hx0, hy0] = polar(rPeak, a0);
    const [hx1, hy1] = polar(rPeak, startDeg + sweep);
    parts.push(
      `<path d="M ${fmtNum(hx0)} ${fmtNum(hy0)} A ${fmtNum(rPeak)} ${fmtNum(rPeak)} 0 0 1 ${fmtNum(hx1)} ${fmtNum(hy1)}" fill="none" stroke="${BRAUN.orange}" stroke-width="2.4"/>`
    );
  }

  // Graduated ticks + outside numerals
  const totalSteps = Math.round((maxVal - minVal) / minorStep);
  for (let s = 0; s <= totalSteps; s++) {
    const val = minVal + s * minorStep;
    const deg = startDeg + ((val - minVal) / (maxVal - minVal)) * sweep;
    const isMajor = Math.abs((val - minVal) / majorStep - Math.round((val - minVal) / majorStep)) < 1e-4;
    const isPeakZone = highlightFrom !== null && val >= highlightFrom - 1e-4;

    const rIn = isMajor ? rArc - 5.0 : rArc - 1.2;
    const rOut = isMajor ? rArc + 4.2 : rArc + 2.6;
    const [x0, y0] = polar(rIn, deg);
    const [x1, y1] = polar(rOut, deg);
    const strokeCol = isPeakZone ? BRAUN.orange : isMajor ? BRAUN.ink : '#8C8B84';
    parts.push(
      `<line x1="${fmtNum(x0)}" y1="${fmtNum(y0)}" x2="${fmtNum(x1)}" y2="${fmtNum(y1)}" stroke="${strokeCol}" stroke-width="${isMajor ? '1.15' : '0.55'}"/>`
    );

    if (labelSet.includes(Math.round(val))) {
      const [nx, ny] = polar(rNum, deg);
      parts.push(
        `<text x="${fmtNum(nx)}" y="${fmtNum(ny + 2.9)}" text-anchor="middle" font-size="8.4" font-weight="${isPeakZone ? '700' : '600'}" fill="${isPeakZone ? BRAUN.orange : '#353430'}" font-family="${escapeXml(POSTER_MONO_STACK)}">${Math.round(val)}</text>`
      );
    }
  }

  // 4. Recessed digital/mechanical aperture readout & clean Braun dial legend in lower open sector
  if (!hideLabels) {
    const valText = value !== null ? `${value.toFixed(1)} ${unitSuffix}` : `— ${unitSuffix}`;
    const apW = 70;
    const apH = 16.5;
    const apX = cx - apW * 0.5;
    const apY = cy + 25.5;
    parts.push(
      `<rect x="${fmtNum(apX)}" y="${fmtNum(apY)}" width="${apW}" height="${apH}" rx="2" fill="#EAE9E3" stroke="#CECDC6" stroke-width="0.65"/>`,
      `<line x1="${fmtNum(apX + 1)}" y1="${fmtNum(apY + 0.8)}" x2="${fmtNum(apX + apW - 1)}" y2="${fmtNum(apY + 0.8)}" stroke="#D6D5CE" stroke-width="0.6"/>`,
      `<text x="${cx}" y="${fmtNum(apY + 11.7)}" text-anchor="middle" font-size="9.4" font-weight="600" fill="${BRAUN.ink}" font-family="${escapeXml(POSTER_MONO_STACK)}">${escapeXml(valText)}</text>`,
      `<text x="${cx}" y="${fmtNum(cy + 55.5)}" text-anchor="middle" font-size="10.4" font-weight="600" letter-spacing="0.4" fill="${BRAUN.inkSoft}" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(titleZh)}</text>`,
      `<text x="${cx}" y="${fmtNum(cy + 66.2)}" text-anchor="middle" font-size="6.8" font-weight="600" letter-spacing="1.2" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_MONO_STACK)}">${escapeXml(subEn)}</text>`
    );
  }

  // 5. Tapered Braun orange-red precision pointer needle + counterweight tail + cast shadow
  const restVal = unitSuffix === 'dB' ? -28 : 80;
  const initDeg = unitSuffix === 'dB' ? dbToAngle(value ?? restVal) : hzToAngle(value ?? restVal);
  const tipLen = rArc + 2.8;
  const tailLen = 14.5;
  const needlePts = `${fmtNum(cx - 1.45)},${fmtNum(cy + tailLen)} ${fmtNum(cx - 1.75)},${fmtNum(cy)} ${fmtNum(cx - 0.45)},${fmtNum(cy - tipLen)} ${fmtNum(cx + 0.45)},${fmtNum(cy - tipLen)} ${fmtNum(cx + 1.75)},${fmtNum(cy)} ${fmtNum(cx + 1.45)},${fmtNum(cy + tailLen)}`;
  const needleCol = value !== null ? BRAUN.orange : '#8C8B85';

  parts.push(
    `<g transform="translate(1.3, 1.8) rotate(${fmtNum(initDeg)}, ${cx}, ${cy})">` +
      `<polygon points="${needlePts}" fill="rgba(25,25,23,0.14)"/>` +
      `</g>`,
    `<g transform="rotate(${fmtNum(initDeg)}, ${cx}, ${cy})">` +
      `<polygon points="${needlePts}" fill="${needleCol}"/>` +
      `<circle cx="${cx}" cy="${fmtNum(cy + tailLen - 1.5)}" r="1.5" fill="${needleCol}"/>` +
      `</g>`
  );

  // 6. Machined two-tone pivot hub cap
  parts.push(
    `<circle cx="${fmtNum(cx + 0.8)}" cy="${fmtNum(cy + 1.1)}" r="7.2" fill="rgba(25,25,23,0.12)"/>`,
    `<circle cx="${cx}" cy="${cy}" r="6.8" fill="url(#${idPfx}bezel-grad)" stroke="#161614" stroke-width="0.6"/>`,
    `<circle cx="${cx}" cy="${cy}" r="3.1" fill="url(#${idPfx}hub-cap)"/>`,
    `<circle cx="${fmtNum(cx - 0.9)}" cy="${fmtNum(cy - 0.9)}" r="0.85" fill="#FFFFFF" fill-opacity="0.68"/>`
  );

  // 7. Delicate convex crystal-glass reflection arc (upper-left quadrant, zero filters!)
  const rGlass = r - 4.8;
  const [gx0, gy0] = polar(rGlass, -68);
  const [gx1, gy1] = polar(rGlass, -16);
  const [gx2, gy2] = polar(rGlass - 3.0, -56);
  const [gx3, gy3] = polar(rGlass - 3.0, -28);
  parts.push(
    `<path d="M ${fmtNum(gx0)} ${fmtNum(gy0)} A ${fmtNum(rGlass)} ${fmtNum(rGlass)} 0 0 1 ${fmtNum(gx1)} ${fmtNum(gy1)}" fill="none" stroke="#FFFFFF" stroke-opacity="0.46" stroke-width="2.1" stroke-linecap="round"/>`,
    `<path d="M ${fmtNum(gx2)} ${fmtNum(gy2)} A ${fmtNum(rGlass - 3.0)} ${fmtNum(rGlass - 3.0)} 0 0 1 ${fmtNum(gx3)} ${fmtNum(gy3)}" fill="none" stroke="#FFFFFF" stroke-opacity="0.22" stroke-width="1.1" stroke-linecap="round"/>`
  );

  return parts.join('');
}

/**
 * Dieter Rams iconic micro-perforated speaker grille matrix (inspired by Braun TP1 / SK4 / T3).
 */
function renderBraunSpeakerGrille(x: number, y: number, w: number, rows: number, cols: number): string {
  const parts: string[] = [];
  const stepX = w / Math.max(1, cols - 1);
  const stepY = 7.4;
  const rHole = 1.38;
  for (let r = 0; r < rows; r++) {
    const cy = y + r * stepY;
    for (let c = 0; c < cols; c++) {
      const cx = x + c * stepX;
      parts.push(
        `<circle cx="${fmtNum(cx + 0.35)}" cy="${fmtNum(cy + 0.45)}" r="${rHole}" fill="#F6F5F1" fill-opacity="0.72"/>`,
        `<circle cx="${fmtNum(cx)}" cy="${fmtNum(cy)}" r="${rHole}" fill="#4A4945" fill-opacity="0.78"/>`
      );
    }
  }
  return parts.join('');
}

function wrapTitleTwoLines(text: string, maxW: number, fontSize: number): [string, string] {
  const fontCss = `700 ${fontSize.toFixed(1)}px ${POSTER_SANS_STACK}`;
  if (measurePx(text, fontCss) <= maxW) return [text, ''];
  const gs = splitGraphemes(text);
  let bestIdx = Math.ceil(gs.length * 0.54);
  let bestScore = Infinity;
  for (let i = 2; i < gs.length - 1; i++) {
    const l1 = gs.slice(0, i).join('').trim();
    const l2 = gs.slice(i).join('').trim();
    if (!l1 || !l2) continue;
    const w1 = measurePx(l1, fontCss);
    const w2 = measurePx(l2, fontCss);
    const brBonus = /[，。！？、\s·—]/.test(gs[i - 1]) ? -32 : 0;
    const score = Math.max(w1, w2) + Math.abs(w1 - w2) * 0.25 + brBonus;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  const l1 = truncateByGraphemes(gs.slice(0, bestIdx).join('').trim(), maxW, fontCss);
  const l2 = truncateByGraphemes(gs.slice(bestIdx).join('').trim(), maxW, fontCss);
  return [l1, l2];
}

function buildSerratedStripOutline(x: number, y: number, w: number, h: number, toothPitch = 8.0, toothDepth = 3.0): string {
  const yBot = y + h;
  const teeth = Math.max(8, Math.round(w / toothPitch));
  const step = w / teeth;
  const segs: string[] = [`M ${fmtNum(x)} ${fmtNum(y)} H ${fmtNum(x + w)} V ${fmtNum(yBot - toothDepth)}`];
  for (let i = teeth - 1; i >= 0; i--) {
    const xMid = x + (i + 0.5) * step;
    const xLeft = x + i * step;
    segs.push(`L ${fmtNum(xMid)} ${fmtNum(yBot)} L ${fmtNum(xLeft)} ${fmtNum(yBot - toothDepth)}`);
  }
  segs.push(`V ${fmtNum(y)} Z`);
  return segs.join(' ');
}

function buildSmoothF0Path(pts: Array<{ x: number; y: number }>): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) {
    return `M${fmtNum(pts[0].x, 1)},${fmtNum(pts[0].y, 1)}L${fmtNum(pts[1].x, 1)},${fmtNum(pts[1].y, 1)}`;
  }
  const cmds: string[] = [`M${fmtNum(pts[0].x, 1)},${fmtNum(pts[0].y, 1)}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) * 0.5;
    const my = (pts[i].y + pts[i + 1].y) * 0.5;
    cmds.push(`Q${fmtNum(pts[i].x, 1)},${fmtNum(pts[i].y, 1)} ${fmtNum(mx, 1)},${fmtNum(my, 1)}`);
  }
  const last = pts[pts.length - 1];
  cmds.push(`L${fmtNum(last.x, 1)},${fmtNum(last.y, 1)}`);
  return cmds.join('');
}

export function renderBraunStripPosterSvg(params: RenderBraunStripParams): {
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
    metrics,
    hasAudio,
    audioSampleRate,
    maxFreq,
    previewMode
  } = params;

  const isEmblem = config.framing === 'emblem_1_1';
  const trimW = 900.0;
  const trimH = isEmblem ? 900.0 : 1200.0;
  const bleed = config.includeBleed ? POSTER_BLEED_PT : 0;
  const widthPt = trimW + 2 * bleed;
  const heightPt = trimH + 2 * bleed;
  const idPfx = previewMode ? 'pv-bs-' : 'ex-bs-';
  const duration = Math.max(1e-4, tMax - tMin);

  // Active selected interval tiers (0..6) & point tier (0..1)
  const intervalEntries = config.intervalTierIndices
    .filter((idx) => idx >= 0 && idx < tg.tiers.length && tg.tiers[idx].kind === 'intervalTier')
    .slice(0, 6)
    .map((tierIdx) => ({ tierIdx, tier: tg.tiers[tierIdx] }));

  const pointTier =
    config.pointTierIndex !== null &&
    config.pointTierIndex >= 0 &&
    config.pointTierIndex < tg.tiers.length &&
    tg.tiers[config.pointTierIndex].kind === 'textTier'
      ? { tierIdx: config.pointTierIndex, tier: tg.tiers[config.pointTierIndex] }
      : null;

  const indexedPoints: IndexedPointEntry[] = pointTier
    ? pointTier.tier.points
        .filter((pt) => pt.number >= tMin - 1e-7 && pt.number <= tMax + 1e-7 && resolvePosterText(pt.mark) !== '')
        .sort((a, b) => a.number - b.number)
        .map((pt, idx) => {
          const customNote = config.copy.pointNotes[String(idx)];
          return {
            idx,
            badge: String(idx + 1).padStart(2, '0'),
            time: pt.number,
            rawMark: pt.mark,
            shortLabel: formatBraunPointShort(pt.mark, customNote),
            fullLabel: formatBraunPointFull(pt.mark, customNote)
          };
        })
    : [];

  // Show museum-grade numbered point directory at bottom of strip in 3:4 poster mode whenever points exist
  const showPointDirectory = !isEmblem && !config.pureVisual && indexedPoints.length > 0;
  const maxDirEntries = 24;
  const dirEntries = indexedPoints.slice(0, maxDirEntries);
  const dirCols = dirEntries.length > 14 ? 3 : dirEntries.length >= 2 ? 2 : 1;
  const dirRows = showPointDirectory ? Math.ceil(dirEntries.length / dirCols) : 0;
  const dirRowH = dirRows <= 4 ? 17.5 : dirRows <= 6 ? 15.8 : 14.5;
  const dirBlockH = showPointDirectory ? 28 + dirRows * dirRowH + 8 : 0;

  // --------------------------------------------------------------------------
  // <defs>: Multi-stop anodized aluminum, machined bezels, recessed dial face, slot shadow (ZERO SVG filters!)
  // --------------------------------------------------------------------------
  const defs =
    `<linearGradient id="${idPfx}alu" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="${BRAUN.chassisTop}"/>` +
    `<stop offset="38%" stop-color="${BRAUN.chassisMid}"/>` +
    `<stop offset="100%" stop-color="${BRAUN.chassisBot}"/>` +
    `</linearGradient>` +
    `<linearGradient id="${idPfx}well-grad" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="#CAC8C0"/>` +
    `<stop offset="48%" stop-color="#DFDED8"/>` +
    `<stop offset="100%" stop-color="#F2F1EC"/>` +
    `</linearGradient>` +
    `<linearGradient id="${idPfx}bezel-grad" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="#3E3D39"/>` +
    `<stop offset="45%" stop-color="#1E1E1C"/>` +
    `<stop offset="100%" stop-color="#2D2C29"/>` +
    `</linearGradient>` +
    `<radialGradient id="${idPfx}dial-face" cx="46%" cy="42%" r="60%">` +
    `<stop offset="0%" stop-color="#FBFBF8"/>` +
    `<stop offset="72%" stop-color="#F4F3EE"/>` +
    `<stop offset="94%" stop-color="#E7E6DF"/>` +
    `<stop offset="100%" stop-color="#DCDBD3"/>` +
    `</radialGradient>` +
    `<linearGradient id="${idPfx}hub-cap" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="#DDDCDA"/>` +
    `<stop offset="55%" stop-color="#9A9992"/>` +
    `<stop offset="100%" stop-color="#696863"/>` +
    `</linearGradient>` +
    `<linearGradient id="${idPfx}slot-bevel" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="#C6C4BC"/>` +
    `<stop offset="45%" stop-color="#DAD9D2"/>` +
    `<stop offset="100%" stop-color="#ECEBE5"/>` +
    `</linearGradient>` +
    `<linearGradient id="${idPfx}slot-sh" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="#181816" stop-opacity="0.22"/>` +
    `<stop offset="32%" stop-color="#181816" stop-opacity="0.09"/>` +
    `<stop offset="72%" stop-color="#181816" stop-opacity="0.025"/>` +
    `<stop offset="100%" stop-color="#181816" stop-opacity="0"/>` +
    `</linearGradient>` +
    `<linearGradient id="${idPfx}fold-sh" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="#1D1D1B" stop-opacity="0"/>` +
    `<stop offset="48%" stop-color="#1D1D1B" stop-opacity="0.042"/>` +
    `<stop offset="52%" stop-color="#FFFFFF" stop-opacity="0.6"/>` +
    `<stop offset="100%" stop-color="#1D1D1B" stop-opacity="0"/>` +
    `</linearGradient>`;

  // --------------------------------------------------------------------------
  // #paper-bg (Anodized Aluminum Chassis + Subtle Machined Perimeter Chamfer)
  // --------------------------------------------------------------------------
  const paperBgGroup =
    config.bgMode === 'transparent'
      ? ''
      : `<g id="paper-bg">` +
        `<rect x="${fmtNum(-bleed)}" y="${fmtNum(-bleed)}" width="${fmtNum(widthPt)}" height="${fmtNum(heightPt)}" fill="url(#${idPfx}alu)"/>` +
        // Subtle architectural chassis inset perimeter hairline (Dieter Rams precision enclosure)
        `<rect x="22" y="22" width="${fmtNum(trimW - 44)}" height="${fmtNum(trimH - 44)}" rx="4" fill="none" stroke="${BRAUN.chassisSeamDark}" stroke-width="0.75" stroke-opacity="0.65"/>` +
        `<rect x="23" y="23" width="${fmtNum(trimW - 46)}" height="${fmtNum(trimH - 46)}" rx="3.5" fill="none" stroke="${BRAUN.chassisSeamLight}" stroke-width="0.75" stroke-opacity="0.7"/>` +
        `</g>`;

  // --------------------------------------------------------------------------
  // #instrument-panel (Braun TG-60 Fascia, Dual Recessed Meters, Speaker Grille, Machined Exit Slot)
  // --------------------------------------------------------------------------
  const instrumentParts: string[] = [];
  const editorialParts: string[] = [];

  const stripX = 66;
  const stripW = 768;
  const slotY = isEmblem ? 40 : 294;
  const stripY = isEmblem ? 49 : 303;
  const stripH = isEmblem ? 806 : 852;

  if (!isEmblem) {
    // Engraved horizontal fascia seams
    instrumentParts.push(
      `<line x1="66" y1="60" x2="834" y2="60" stroke="${BRAUN.chassisSeamDark}" stroke-width="0.75"/>`,
      `<line x1="66" y1="61" x2="834" y2="61" stroke="${BRAUN.chassisSeamLight}" stroke-width="0.75"/>`,
      `<line x1="478" y1="78" x2="478" y2="266" stroke="${BRAUN.chassisSeamDark}" stroke-width="0.75"/>`,
      `<line x1="479" y1="78" x2="479" y2="266" stroke="${BRAUN.chassisSeamLight}" stroke-width="0.75"/>`,
      `<line x1="48" y1="282" x2="852" y2="282" stroke="${BRAUN.chassisSeamDark}" stroke-width="0.75"/>`,
      `<line x1="48" y1="283" x2="852" y2="283" stroke="${BRAUN.chassisSeamLight}" stroke-width="0.75"/>`
    );

    // Top-left & Top-right Braun Model Nameplate Stamping (omitted in pureVisual)
    if (!config.pureVisual) {
      const kHzStr = audioSampleRate > 0 ? `${(audioSampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz` : 'TEXTGRID';
      const rightHeader = autoCopy.sideLabel || `VOICE RECORDER · ${duration.toFixed(2)}s`;
      editorialParts.push(
        `<text x="66" y="47" font-size="14.5" font-weight="700" letter-spacing="2.2" fill="${BRAUN.ink}" font-family="${escapeXml(POSTER_DISPLAY_SANS_STACK)}">T·GRID</text>`,
        `<line x1="142" y1="35" x2="142" y2="49" stroke="#BDBCB5" stroke-width="0.85"/>`,
        `<text x="152" y="47" font-size="11.2" font-weight="700" letter-spacing="1.2" fill="${BRAUN.orange}" font-family="${escapeXml(POSTER_MONO_STACK)}">TG-60</text>`,
        `<text x="206" y="47" font-size="8.6" font-weight="600" letter-spacing="1.4" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_MONO_STACK)}">AUDIO-LINGUISTIC STRIP RECORDER</text>`,
        `<text x="834" y="47" text-anchor="end" font-size="9.4" font-weight="600" letter-spacing="0.9" fill="${BRAUN.sub}" font-family="${escapeXml(POSTER_MONO_STACK)}">${escapeXml(rightHeader)} · ${escapeXml(kHzStr)}</text>`
      );
    }

    // Dual Recessed Precision Analog Meters
    instrumentParts.push(
      renderDialSvg({
        idPfx,
        cx: 166,
        cy: 172,
        r: 86,
        minVal: -30,
        maxVal: 0,
        majorStep: 5,
        minorStep: 1,
        labelSet: [-30, -25, -20, -15, -10, -5, 0],
        titleZh: '音量 dB',
        subEn: 'PEAK LEVEL',
        value: metrics.peakDb,
        unitSuffix: 'dB',
        highlightFrom: -3,
        hideLabels: config.pureVisual
      }),
      renderDialSvg({
        idPfx,
        cx: 368,
        cy: 172,
        r: 86,
        minVal: 50,
        maxVal: 450,
        majorStep: 50,
        minorStep: 10,
        labelSet: [50, 100, 150, 200, 250, 300, 350, 400, 450],
        titleZh: '平均音高 Hz',
        subEn: 'MEAN F0',
        value: metrics.meanF0,
        unitSuffix: 'Hz',
        highlightFrom: null,
        hideLabels: config.pureVisual
      })
    );

    // Right Cluster Hardware: Recessed Braun Orange Power Jewel + Dieter Rams Micro-Perforated Speaker Grille
    instrumentParts.push(
      `<circle cx="506" cy="92" r="6.8" fill="url(#${idPfx}well-grad)" stroke="#BDBCB5" stroke-width="0.7"/>`,
      `<circle cx="506" cy="92" r="4.3" fill="${BRAUN.orange}"/>`,
      `<circle cx="504.6" cy="90.6" r="1.25" fill="#FF9C84" fill-opacity="0.75"/>`,
      renderBraunSpeakerGrille(500, 236, 334, 4, 34)
    );

    if (!config.pureVisual) {
      const titleStr = config.copy.title.trim() || autoCopy.title;
      const subStr = config.copy.subtitle.trim() || autoCopy.subtitle;
      const rightW = 334;
      const [line1, line2] = wrapTitleTwoLines(titleStr, rightW, 20.0);

      // Status line & duration pill
      const durBadge = `${duration.toFixed(2)}s`;
      editorialParts.push(
        `<text x="520" y="95.5" font-size="9.4" font-weight="600" letter-spacing="1.2" fill="${BRAUN.inkSoft}" font-family="${escapeXml(POSTER_MONO_STACK)}">${hasAudio ? 'SIGNAL ACTIVE · STRIP FEED' : 'ANNOTATION · STRIP FEED'}</text>`,
        `<rect x="780" y="83" width="54" height="17" rx="2" fill="#E1DFD8" stroke="#C7C5BD" stroke-width="0.65"/>`,
        `<text x="807" y="94.5" text-anchor="middle" font-size="9.2" font-weight="600" fill="${BRAUN.ink}" font-family="${escapeXml(POSTER_MONO_STACK)}">${escapeXml(durBadge)}</text>`,
        `<line x1="498" y1="108" x2="834" y2="108" stroke="${BRAUN.chassisSeamDark}" stroke-width="0.7"/>`
      );

      if (!line2) {
        editorialParts.push(
          `<text x="498" y="138" font-size="20.4" font-weight="700" letter-spacing="-0.2" fill="${BRAUN.ink}" font-family="${escapeXml(POSTER_DISPLAY_SANS_STACK)}">${escapeXml(line1)}</text>`,
          `<text x="498" y="161" font-size="11.2" font-weight="400" fill="${BRAUN.sub}" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(truncateByGraphemes(subStr, rightW, `400 11.2px ${POSTER_SANS_STACK}`))}</text>`
        );
      } else {
        editorialParts.push(
          `<text x="498" y="133" font-size="18.2" font-weight="700" letter-spacing="-0.15" fill="${BRAUN.ink}" font-family="${escapeXml(POSTER_DISPLAY_SANS_STACK)}">${escapeXml(line1)}</text>`,
          `<text x="498" y="157" font-size="18.2" font-weight="700" letter-spacing="-0.15" fill="${BRAUN.ink}" font-family="${escapeXml(POSTER_DISPLAY_SANS_STACK)}">${escapeXml(line2)}</text>`,
          `<text x="498" y="177" font-size="10.8" font-weight="400" fill="${BRAUN.sub}" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(truncateByGraphemes(subStr, rightW, `400 10.8px ${POSTER_SANS_STACK}`))}</text>`
        );
      }

      // Precision Technical Spec Strip (3 Braun Tabular Cells)
      const srLabel = audioSampleRate > 0 ? `${(audioSampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz` : '—';
      const freqLabel = hasAudio ? `0–${(maxFreq / 1000).toFixed(1).replace(/\.0$/, '')} kHz` : 'TIME GRID';
      const tierSummary =
        indexedPoints.length > 0
          ? `${intervalEntries.length} 区间 · ${indexedPoints.length} 标点`
          : `${intervalEntries.length} 标注层`;
      const specY0 = 190;
      const specHBox = 32;
      editorialParts.push(
        `<line x1="498" y1="${specY0}" x2="834" y2="${specY0}" stroke="${BRAUN.chassisSeamDark}" stroke-width="0.65"/>`,
        `<line x1="498" y1="${specY0 + specHBox}" x2="834" y2="${specY0 + specHBox}" stroke="${BRAUN.chassisSeamDark}" stroke-width="0.65"/>`,
        `<line x1="600" y1="${specY0 + 5}" x2="600" y2="${specY0 + specHBox - 5}" stroke="${BRAUN.chassisSeamDark}" stroke-width="0.65"/>`,
        `<line x1="712" y1="${specY0 + 5}" x2="712" y2="${specY0 + specHBox - 5}" stroke="${BRAUN.chassisSeamDark}" stroke-width="0.65"/>`,
        `<text x="498" y="${specY0 + 11.5}" font-size="7.2" font-weight="600" letter-spacing="1.0" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_MONO_STACK)}">SAMPLE</text>`,
        `<text x="498" y="${specY0 + 25}" font-size="10.4" font-weight="600" fill="${BRAUN.ink}" font-family="${escapeXml(POSTER_MONO_STACK)}">${escapeXml(srLabel)}</text>`,
        `<text x="612" y="${specY0 + 11.5}" font-size="7.2" font-weight="600" letter-spacing="1.0" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_MONO_STACK)}">SPECTRUM</text>`,
        `<text x="612" y="${specY0 + 25}" font-size="10.4" font-weight="600" fill="${BRAUN.ink}" font-family="${escapeXml(POSTER_MONO_STACK)}">${escapeXml(freqLabel)}</text>`,
        `<text x="724" y="${specY0 + 11.5}" font-size="7.2" font-weight="600" letter-spacing="1.0" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_MONO_STACK)}">TIERS</text>`,
        `<text x="724" y="${specY0 + 25}" font-size="10.2" font-weight="600" fill="${BRAUN.ink}" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(tierSummary)}</text>`
      );
    }
  }

  // Machined Recessed Horizontal Paper Exit Slot + Edge Paper-Guide Brackets
  instrumentParts.push(
    `<rect x="46" y="${slotY}" width="808" height="16" rx="3" fill="url(#${idPfx}slot-bevel)" stroke="#BDBCB4" stroke-width="0.8"/>`,
    `<line x1="48" y1="${slotY + 16.5}" x2="852" y2="${slotY + 16.5}" stroke="#F7F6F2" stroke-width="0.85"/>`,
    `<rect x="54" y="${slotY + 4}" width="792" height="8" rx="1.6" fill="#181816"/>`,
    `<line x1="56" y1="${slotY + 4.8}" x2="844" y2="${slotY + 4.8}" stroke="#33322E" stroke-width="0.7"/>`,
    // Subtle dark brushed paper-guide notches framing stripX..stripX+stripW
    `<rect x="${stripX - 6}" y="${slotY + 3}" width="3.5" height="10" rx="0.8" fill="#44433E"/>`,
    `<rect x="${stripX + stripW + 2.5}" y="${slotY + 3}" width="3.5" height="10" rx="0.8" fill="#44433E"/>`
  );

  // --------------------------------------------------------------------------
  // #paper-strip (Tactile Perforated & Serrated Recording Strip — evenodd cutout!)
  // --------------------------------------------------------------------------
  const holeYs: number[] = [];
  for (let hy = stripY + 22; hy <= stripY + stripH - 18; hy += 26.0) {
    holeYs.push(hy);
  }
  const holeR = 4.1;
  const outerStripPath = buildSerratedStripOutline(stripX, stripY, stripW, stripH, 8.0, 3.0);
  const paperCutoutPathParts: string[] = [outerStripPath];
  for (const hy of holeYs) {
    for (const hx of [83, 817]) {
      paperCutoutPathParts.push(
        `M ${fmtNum(hx - holeR)} ${fmtNum(hy)} a ${holeR} ${holeR} 0 1 0 ${fmtNum(2 * holeR)} 0 a ${holeR} ${holeR} 0 1 0 ${fmtNum(-2 * holeR)} 0 Z`
      );
    }
  }

  const shadowOuter1 = buildSerratedStripOutline(stripX - 2.5, stripY + 7, stripW + 5, stripH + 2, 8.0, 3.0);
  const shadowOuter2 = buildSerratedStripOutline(stripX - 0.8, stripY + 3.5, stripW + 1.6, stripH + 1, 8.0, 3.0);

  const paperStripParts: string[] = [
    // Soft stepped drop shadow (pure SVG vector, zero filter!)
    `<path d="${shadowOuter1}" fill="rgba(26,25,23,0.038)"/>`,
    `<path d="${shadowOuter2}" fill="rgba(26,25,23,0.06)"/>`,
    `<path d="${paperCutoutPathParts.join(' ')}" fill="${BRAUN.paper}" fill-rule="evenodd" stroke="#D5D4CD" stroke-width="0.7"/>`,
    `<rect x="${stripX}" y="${stripY}" width="${stripW}" height="22" fill="url(#${idPfx}slot-sh)"/>`,
    // Fine tractor-feed tear perforation lines
    `<line x1="100" y1="${stripY + 6}" x2="100" y2="${stripY + stripH - 9}" stroke="#E6E5DE" stroke-width="0.75" stroke-dasharray="2.2 3.0"/>`,
    `<line x1="800" y1="${stripY + 6}" x2="800" y2="${stripY + stripH - 9}" stroke="#E6E5DE" stroke-width="0.75" stroke-dasharray="2.2 3.0"/>`
  ];

  // Dimensional inner rim around each punched sprocket hole
  for (const hy of holeYs) {
    for (const hx of [83, 817]) {
      paperStripParts.push(
        `<circle cx="${hx}" cy="${fmtNum(hy, 1)}" r="${holeR}" fill="none" stroke="#CCCBC4" stroke-width="0.75"/>`,
        `<path d="M ${fmtNum(hx - holeR * 0.8)} ${fmtNum(hy + holeR * 0.55)} A ${holeR} ${holeR} 0 0 1 ${fmtNum(hx + holeR * 0.65)} ${fmtNum(hy - holeR * 0.72)}" fill="none" stroke="#B6B5AD" stroke-width="0.65"/>`
      );
    }
  }

  // --------------------------------------------------------------------------
  // Strip Chart Segments (1-strip <= 5.5s, 2-segment folded > 5.5s)
  // --------------------------------------------------------------------------
  const acousticParts: string[] = [];
  const annotationParts: string[] = [];
  const pointParts: string[] = [];

  const renderSegment = (
    segIdx: number,
    segCount: number,
    tStart: number,
    tEnd: number,
    yTop: number,
    segHeight: number
  ) => {
    const xGutterLeft = 105;
    const xTrackLeft = 194;
    const trackWidth = 580;
    const xTrackRight = xTrackLeft + trackWidth;
    const isFolded = segCount > 1;

    const showWave = hasAudio && config.showWaveform && Boolean(waveformBins?.length);
    const showSpec = hasAudio && config.showSpectrogram && Boolean(specMatrix);
    const hasAnyAcousticBand = showWave || showSpec;

    // Collect selected rows for this segment
    const combinedTiers: Array<{ tier: Tier; tierIdx: number; kind: 'interval' | 'point' }> = [
      ...intervalEntries.map((e) => ({ tier: e.tier, tierIdx: e.tierIdx, kind: 'interval' as const })),
      ...(pointTier ? [{ tier: pointTier.tier, tierIdx: pointTier.tierIdx, kind: 'point' as const }] : [])
    ];
    const nRows = combinedTiers.length;

    // Adaptive acoustic band proportions: reward sparse 2–3 tier dialogues with richer acoustic height,
    // while giving 5–6 tier phonetic grids generous room for all text/IPA rows!
    const axisH = isFolded ? 18 : 22;
    const waveH = showWave
      ? isFolded
        ? nRows <= 3
          ? 36
          : nRows === 4
            ? 31
            : 26
        : nRows <= 3
          ? 64
          : 50
      : 0;
    const specH = showSpec
      ? isFolded
        ? nRows <= 3
          ? 100
          : nRows === 4
            ? 86
            : 72
        : nRows <= 3
          ? 184
          : 146
      : hasAnyAcousticBand
        ? 0
        : isFolded
          ? 38
          : 62;
    const gapWaveSpec = showWave && specH > 0 ? (isFolded ? 6 : 8) : 0;
    const polyH = nRows > 0 ? (isFolded ? (nRows <= 3 ? 26 : 22) : 44) : 0;

    const yAxis = yTop;
    const yWaveTop = yAxis + axisH;
    const yWaveBot = yWaveTop + waveH;
    const ySpecTop = yWaveBot + gapWaveSpec;
    const ySpecBot = ySpecTop + specH;
    const yPolyTop = ySpecBot;
    const yPolyBot = yPolyTop + polyH;
    const yRowsTop = yPolyBot;
    const rowsAvailH = Math.max(40, yTop + segHeight - yRowsTop);

    const tierWeights = combinedTiers.map((entry) => {
      if (entry.kind === 'interval') {
        const hasAny = entry.tier.intervals.some(
          (iv) => iv.xmax > tStart + 1e-4 && iv.xmin < tEnd - 1e-4 && resolvePosterText(iv.text) !== ''
        );
        return hasAny ? 1.0 : 0.62;
      }
      // Point tier row using crisp numbered Braun orange badges needs sleek compact height
      return showPointDirectory ? 0.74 : 0.92;
    });
    const wSum = tierWeights.reduce((a, b) => a + b, 0) || 1;

    const tierRows: StripTierRow[] = combinedTiers.map((entry, idx) => {
      const rowH = (tierWeights[idx] / wSum) * rowsAvailH;
      const ipa = entry.kind === 'interval' && isTierIpaLike(entry.tier);
      const rawName = entry.tier.name || (entry.kind === 'point' ? '标点' : `层 ${idx + 1}`);
      const labelMaxW = Math.max(40, xTrackLeft - 10 - (xGutterLeft + 26));
      const label = truncateByGraphemes(rawName, labelMaxW, `500 ${isFolded ? '10.0' : '10.4'}px ${POSTER_SANS_STACK}`);
      let fSize = isFolded ? 12.0 : 13.4;
      let fWeight = 400;
      if (entry.kind === 'interval' && idx === 0 && nRows >= 4) {
        fSize = isFolded ? 12.8 : 14.8;
        fWeight = 600;
      } else if (entry.kind === 'interval' && idx <= 1 && !ipa) {
        fSize = isFolded ? 12.4 : 13.8;
        fWeight = 500;
      } else if (ipa) {
        fSize = isFolded ? 11.2 : 12.4;
        fWeight = 400;
      } else if (entry.kind === 'point') {
        fSize = isFolded ? 9.6 : 10.4;
        fWeight = 500;
      }
      if (rowH < 28) {
        fSize = Math.min(fSize, Math.max(8.6, rowH * 0.44));
      }
      return {
        tier: entry.tier,
        tierIdx: entry.tierIdx,
        orderNum: idx + 1,
        kind: entry.kind,
        label,
        rowH,
        isIpa: ipa,
        fontSize: fSize,
        fontWeight: fWeight,
        isEmpty: entry.kind === 'interval' && tierWeights[idx] < 0.8
      };
    });

    const silences = detectLongSilences(
      intervalEntries.map((e) => e.tier),
      waveformBins,
      tMin,
      tMax,
      tStart,
      tEnd
    );
    const acousticRuler = buildAcousticRuler(tStart, tEnd, xTrackLeft, trackWidth, silences);
    const textRuler = buildElasticTextRuler(tStart, tEnd, xTrackLeft, trackWidth, acousticRuler, tierRows);

    const silenceBreakCenters: number[] = acousticRuler.pieces
      .filter((p) => p.isSilence)
      .map((p) => (p.x0 + p.x1) * 0.5);

    // 1. Calibrated Vernier Time Ruler
    if (isFolded) {
      acousticParts.push(
        `<rect x="${xGutterLeft}" y="${fmtNum(yAxis + 1.5)}" width="44" height="13.5" rx="2" fill="#F2F1EC" stroke="#D8D7D0" stroke-width="0.6"/>`,
        `<text x="${xGutterLeft + 22}" y="${fmtNum(yAxis + 11.2)}" text-anchor="middle" font-size="8.4" font-weight="700" fill="${BRAUN.inkSoft}" letter-spacing="0.5" font-family="${escapeXml(POSTER_MONO_STACK)}">0${segIdx + 1}/0${segCount}</text>`
      );
    } else {
      acousticParts.push(
        `<text x="${xGutterLeft}" y="${fmtNum(yAxis + 13)}" font-size="8.8" font-weight="600" letter-spacing="0.7" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_MONO_STACK)}">TIME · s</text>`
      );
    }

    const yRulerLine = yAxis + axisH - 2;
    acousticParts.push(
      `<line x1="${xTrackLeft}" y1="${fmtNum(yRulerLine)}" x2="${xTrackRight}" y2="${fmtNum(yRulerLine)}" stroke="#BEBDB6" stroke-width="0.7"/>`
    );

    const spanDur = tEnd - tStart;
    const tickStep = spanDur <= 1.2 ? 0.2 : spanDur <= 3.2 ? 0.5 : spanDur <= 8 ? 1.0 : 2.0;
    const minorStep = tickStep * 0.25;

    // Fine vernier minor ticks along active (non-silence) segments
    const firstMinor = Math.ceil((tStart - 1e-5) / minorStep) * minorStep;
    for (let mv = firstMinor; mv <= tEnd + 1e-5; mv += minorStep) {
      const insideSil = silences.some((s) => mv > s.start + 0.02 && mv < s.end - 0.02);
      if (insideSil) continue;
      const mx = acousticRuler.timeToX(mv);
      if (silenceBreakCenters.some((cx) => Math.abs(mx - cx) < 9.5)) continue;
      acousticParts.push(
        `<line x1="${fmtNum(mx)}" y1="${fmtNum(yRulerLine - 2.6)}" x2="${fmtNum(mx)}" y2="${fmtNum(yRulerLine)}" stroke="#C6C5BE" stroke-width="0.5"/>`
      );
    }

    // Major numbered ticks + ultra-faint millimetric vertical chart gridlines
    const tickValues: number[] = [tStart];
    const firstTick = Math.ceil((tStart - 1e-5) / tickStep) * tickStep;
    for (let tv = firstTick; tv <= tEnd + 1e-5; tv += tickStep) {
      if (Math.abs(tv - tickValues[tickValues.length - 1]) > tickStep * 0.28) {
        tickValues.push(tv);
      }
    }
    if (Math.abs(tEnd - tickValues[tickValues.length - 1]) > 1e-4) {
      tickValues.push(tEnd);
    }

    const tickFontCss = `500 8.4px ${POSTER_MONO_STACK}`;
    const tickCandidates = tickValues.map((tv, idx) => {
      const isEndpoint = idx === 0 || idx === tickValues.length - 1;
      const tx = acousticRuler.timeToX(tv);
      const anchor = tx < xTrackLeft + 14 ? 'start' : tx > xTrackRight - 14 ? 'end' : 'middle';
      const label = `${tv.toFixed(1)}s`;
      const w = measurePx(label, tickFontCss);
      const x0 = anchor === 'start' ? tx : anchor === 'end' ? tx - w : tx - w * 0.5;
      const x1 = anchor === 'start' ? tx + w : anchor === 'end' ? tx : tx + w * 0.5;
      const insideSil = !isEndpoint && silences.some((s) => tv > s.start + 0.03 && tv < s.end - 0.03);
      const nearBreak = !isEndpoint && silenceBreakCenters.some((cx) => Math.abs(tx - cx) < 13.5);
      return { idx, isEndpoint, tx, anchor, label, x0, x1, valid: !insideSil && !nearBreak };
    });

    const placedTickBoxes: Array<{ x0: number; x1: number }> = [];
    const acceptedTickIdx = new Set<number>();
    const minTickClearPx = 9.0;
    const priorityTicks = [...tickCandidates].sort(
      (a, b) => Number(b.isEndpoint) - Number(a.isEndpoint) || a.tx - b.tx
    );
    for (const c of priorityTicks) {
      if (!c.valid) continue;
      const collides = placedTickBoxes.some(
        (pb) => c.x0 < pb.x1 + minTickClearPx && c.x1 + minTickClearPx > pb.x0
      );
      if (!collides) {
        acceptedTickIdx.add(c.idx);
        placedTickBoxes.push({ x0: c.x0, x1: c.x1 });
      }
    }

    const majorTickXs: number[] = [];
    for (const c of tickCandidates) {
      if (!acceptedTickIdx.has(c.idx)) continue;
      majorTickXs.push(c.tx);
      acousticParts.push(
        `<line x1="${fmtNum(c.tx)}" y1="${fmtNum(yRulerLine - 5.8)}" x2="${fmtNum(c.tx)}" y2="${fmtNum(yRulerLine)}" stroke="#353430" stroke-width="0.8"/>`,
        `<text x="${fmtNum(c.tx)}" y="${fmtNum(yRulerLine - 7.8)}" text-anchor="${c.anchor}" font-size="8.4" font-weight="500" fill="${BRAUN.sub}" font-family="${escapeXml(POSTER_MONO_STACK)}">${c.label}</text>`
      );
    }

    // Faint vertical millimeter gridlines inside waveform & spectrogram bands
    for (const tx of majorTickXs) {
      if (tx <= xTrackLeft + 2 || tx >= xTrackRight - 2) continue;
      if (showWave) {
        acousticParts.push(
          `<line x1="${fmtNum(tx)}" y1="${fmtNum(yWaveTop)}" x2="${fmtNum(tx)}" y2="${fmtNum(yWaveBot)}" stroke="${BRAUN.gridFine}" stroke-width="0.55"/>`
        );
      }
    }

    // 2. Galvanometer Waveform Track (Envelope Fill + High-Density Precision Stylus Trace)
    const yWaveMid = yWaveTop + waveH * 0.5;
    if (showWave && waveformBins) {
      acousticParts.push(
        `<text x="${xTrackLeft - 11}" y="${fmtNum(yWaveMid + 1.5)}" text-anchor="end" font-size="10.2" font-weight="500" fill="${BRAUN.sub}" font-family="${escapeXml(POSTER_SANS_STACK)}">声波</text>`,
        `<text x="${xTrackLeft - 11}" y="${fmtNum(yWaveMid + 10.5)}" text-anchor="end" font-size="6.8" font-weight="600" letter-spacing="0.8" fill="#A09F98" font-family="${escapeXml(POSTER_MONO_STACK)}">AMP</text>`,
        `<line x1="${xTrackLeft}" y1="${fmtNum(yWaveMid)}" x2="${xTrackRight}" y2="${fmtNum(yWaveMid)}" stroke="#DCDAD3" stroke-width="0.6"/>`,
        // Right calibration ticks (+ / 0 / -)
        `<line x1="${xTrackRight + 2}" y1="${fmtNum(yWaveTop + 2)}" x2="${xTrackRight + 5}" y2="${fmtNum(yWaveTop + 2)}" stroke="#C2C1BA" stroke-width="0.6"/>`,
        `<line x1="${xTrackRight + 2}" y1="${fmtNum(yWaveMid)}" x2="${xTrackRight + 6}" y2="${fmtNum(yWaveMid)}" stroke="#9A9992" stroke-width="0.65"/>`,
        `<line x1="${xTrackRight + 2}" y1="${fmtNum(yWaveBot - 2)}" x2="${xTrackRight + 5}" y2="${fmtNum(yWaveBot - 2)}" stroke="#C2C1BA" stroke-width="0.6"/>`,
        `<text x="${xTrackRight + 8}" y="${fmtNum(yWaveMid + 2.5)}" font-size="7.0" fill="#9E9D96" font-family="${escapeXml(POSTER_MONO_STACK)}">0</text>`
      );

      const wLen = waveformBins.length;
      const samples = 420;
      const halfAmp = waveH * 0.45;
      const cmds: string[] = [];
      let upperPts: string[] = [];
      let lowerPts: string[] = [];
      const flushEnvelope = () => {
        if (upperPts.length >= 2) {
          const poly = [...upperPts, ...lowerPts.reverse()].join(' ');
          acousticParts.push(`<polygon points="${poly}" fill="${BRAUN.ink}" fill-opacity="0.11"/>`);
        }
        upperPts = [];
        lowerPts = [];
      };

      for (let i = 0; i <= samples; i++) {
        const px = xTrackLeft + (i / samples) * trackWidth;
        const inSilGap = silenceBreakCenters.some((cx) => Math.abs(px - cx) < 7.8);
        if (inSilGap) {
          flushEnvelope();
          continue;
        }
        const t = acousticRuler.xToTime(px);
        const bIdx = clamp(Math.round(((t - tMin) / duration) * (wLen - 1)), 0, wLen - 1);
        const [vMin, vMax] = waveformBins[bIdx];
        const y1 = yWaveMid - clamp(vMax, -1, 1) * halfAmp;
        const y2 = yWaveMid - clamp(vMin, -1, 1) * halfAmp;
        upperPts.push(`${fmtNum(px, 1)},${fmtNum(y1, 1)}`);
        lowerPts.push(`${fmtNum(px, 1)},${fmtNum(y2, 1)}`);
        cmds.push(`M${fmtNum(px, 1)},${fmtNum(y1, 1)}L${fmtNum(px, 1)},${fmtNum(y2, 1)}`);
      }
      flushEnvelope();
      acousticParts.push(
        `<path d="${cmds.join('')}" stroke="#1E1E1C" stroke-width="0.72" stroke-linecap="round"/>`
      );
    }

    // 3. Archival Charcoal STFT Spectrogram Band + Calibrated Frequency Scale + Smooth F0 Pitch Contour
    if (specH > 0) {
      const ySpecMid = ySpecTop + specH * 0.5;
      acousticParts.push(
        `<text x="${xTrackLeft - 11}" y="${fmtNum(ySpecMid + 1.5)}" text-anchor="end" font-size="10.2" font-weight="500" fill="${BRAUN.sub}" font-family="${escapeXml(POSTER_SANS_STACK)}">${showSpec ? '声谱' : '时间标尺'}</text>`,
        `<text x="${xTrackLeft - 11}" y="${fmtNum(ySpecMid + 10.5)}" text-anchor="end" font-size="6.8" font-weight="600" letter-spacing="0.8" fill="#A09F98" font-family="${escapeXml(POSTER_MONO_STACK)}">${showSpec ? 'STFT' : 'GRID'}</text>`
      );

      if (showSpec && specMatrix) {
        const breakRanges: Array<[number, number]> = silenceBreakCenters.map((cx) => [
          cx - xTrackLeft - 7.5,
          cx - xTrackLeft + 7.5
        ]);
        const specUrl = renderBraunSpectrogramDataUrl({
          spec: specMatrix,
          tMin,
          tMax,
          xLeft: xTrackLeft,
          trackWidth,
          specHeight: specH,
          xToTime: acousticRuler.xToTime,
          silenceBreakRangesPx: breakRanges,
          previewMode
        });
        if (specUrl) {
          acousticParts.push(
            `<image x="${xTrackLeft}" y="${fmtNum(ySpecTop)}" width="${trackWidth}" height="${fmtNum(specH)}" preserveAspectRatio="none" href="${specUrl}"/>`
          );
        }
      } else {
        // Precision millimeter chart grid for No-Audio / Hidden-Spectrogram mode
        acousticParts.push(
          `<rect x="${xTrackLeft}" y="${fmtNum(ySpecTop)}" width="${trackWidth}" height="${fmtNum(specH)}" fill="#FAF9F5"/>`
        );
        for (let gx = xTrackLeft + 20; gx < xTrackRight; gx += 20) {
          acousticParts.push(
            `<line x1="${gx}" y1="${fmtNum(ySpecTop)}" x2="${gx}" y2="${fmtNum(ySpecBot)}" stroke="#ECEBE5" stroke-width="0.5"/>`
          );
        }
        acousticParts.push(
          `<text x="${fmtNum(xTrackLeft + trackWidth * 0.5)}" y="${fmtNum(ySpecMid + 3.2)}" text-anchor="middle" font-size="9.0" letter-spacing="0.6" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_SANS_STACK)}">${hasAudio ? '频谱已隐藏 · 纸带时间刻度网格' : '无录音底图 · 纸带时间对齐网格'}</text>`
        );
      }

      // Vertical major time calibration hairlines across spectrogram (subtle!)
      for (const tx of majorTickXs) {
        if (tx <= xTrackLeft + 2 || tx >= xTrackRight - 2) continue;
        acousticParts.push(
          `<line x1="${fmtNum(tx)}" y1="${fmtNum(ySpecTop)}" x2="${fmtNum(tx)}" y2="${fmtNum(ySpecBot)}" stroke="rgba(29,29,27,0.055)" stroke-width="0.5"/>`
        );
      }

      // Horizontal frequency guide hairlines + right-margin calibrated kHz scale labels
      for (let g = 1; g <= 3; g++) {
        const gy = ySpecTop + (specH * g) / 4;
        acousticParts.push(
          `<line x1="${xTrackLeft}" y1="${fmtNum(gy)}" x2="${xTrackRight}" y2="${fmtNum(gy)}" stroke="rgba(29,29,27,0.085)" stroke-width="0.5" stroke-dasharray="2 3"/>`
        );
      }
      if (showSpec) {
        const topKhz = `${(maxFreq / 1000).toFixed(1).replace(/\.0$/, '')}k`;
        const midKhz = `${(maxFreq / 2000).toFixed(1).replace(/\.0$/, '')}k`;
        acousticParts.push(
          `<line x1="${xTrackRight + 2}" y1="${fmtNum(ySpecTop + 0.5)}" x2="${xTrackRight + 5.5}" y2="${fmtNum(ySpecTop + 0.5)}" stroke="#7A7972" stroke-width="0.65"/>`,
          `<text x="${xTrackRight + 7.5}" y="${fmtNum(ySpecTop + 5.5)}" font-size="7.2" font-weight="500" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_MONO_STACK)}">${escapeXml(topKhz)}</text>`,
          `<line x1="${xTrackRight + 2}" y1="${fmtNum(ySpecMid)}" x2="${xTrackRight + 5}" y2="${fmtNum(ySpecMid)}" stroke="#B2B1AA" stroke-width="0.6"/>`,
          `<text x="${xTrackRight + 7.5}" y="${fmtNum(ySpecMid + 2.5)}" font-size="7.0" fill="#A09F98" font-family="${escapeXml(POSTER_MONO_STACK)}">${escapeXml(midKhz)}</text>`,
          `<line x1="${xTrackRight + 2}" y1="${fmtNum(ySpecBot - 0.5)}" x2="${xTrackRight + 5.5}" y2="${fmtNum(ySpecBot - 0.5)}" stroke="#7A7972" stroke-width="0.65"/>`,
          `<text x="${xTrackRight + 7.5}" y="${fmtNum(ySpecBot - 0.5)}" font-size="7.2" font-weight="500" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_MONO_STACK)}">0</text>`
        );
      }

      // Smooth Braun orange-red F0 pitch trace (cleanly broken across every silence gap!)
      if (hasAudio && config.showPitch && f0Runs.length > 0 && showSpec) {
        const flushF0Run = (pts: Array<{ x: number; y: number }>) => {
          if (pts.length < 2) return;
          const d = buildSmoothF0Path(pts);
          acousticParts.push(
            `<path d="${d}" fill="none" stroke="#FFFFFF" stroke-opacity="0.82" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round"/>`,
            `<path d="${d}" fill="none" stroke="${BRAUN.orange}" stroke-opacity="0.94" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>`
          );
        };
        for (const run of f0Runs) {
          let curPts: Array<{ x: number; y: number }> = [];
          for (const pt of run) {
            if (pt.t < tStart - 1e-5 || pt.t > tEnd + 1e-5) {
              flushF0Run(curPts);
              curPts = [];
              continue;
            }
            const inSil = silences.some((s) => pt.t > s.start + 0.015 && pt.t < s.end - 0.015);
            if (inSil) {
              flushF0Run(curPts);
              curPts = [];
              continue;
            }
            const px = acousticRuler.timeToX(pt.t);
            if (silenceBreakCenters.some((cx) => Math.abs(px - cx) < 7.5)) {
              flushF0Run(curPts);
              curPts = [];
              continue;
            }
            const py = ySpecBot - 6 - clamp(pt.normF0, 0, 1) * (specH - 12);
            curPts.push({ x: px, y: py });
          }
          flushF0Run(curPts);
        }
      }
    }

    // 4. Clean Vector '//' Silence Break Marks (strictly interior mask so top/bottom frame lines stay unbroken!)
    const drawBreakSlashes = (cx: number, cy: number, halfH: number, sw: number, col: string) =>
      `<line x1="${fmtNum(cx - 3.6)}" y1="${fmtNum(cy + halfH)}" x2="${fmtNum(cx - 0.2)}" y2="${fmtNum(cy - halfH)}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>` +
      `<line x1="${fmtNum(cx + 0.4)}" y1="${fmtNum(cy + halfH)}" x2="${fmtNum(cx + 3.8)}" y2="${fmtNum(cy - halfH)}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>`;

    for (const cx of silenceBreakCenters) {
      acousticParts.push(
        `<rect x="${fmtNum(cx - 6.5)}" y="${fmtNum(yRulerLine - 5.5)}" width="13" height="8.5" fill="#FFFFFF"/>`,
        drawBreakSlashes(cx, yRulerLine - 0.5, 4.0, 0.95, '#4A4945')
      );
      if (showWave) {
        acousticParts.push(
          `<rect x="${fmtNum(cx - 6.5)}" y="${fmtNum(yWaveMid - 5.5)}" width="13" height="11" fill="#FFFFFF"/>`,
          drawBreakSlashes(cx, yWaveMid, 4.5, 0.95, '#6A6963')
        );
      }
      if (specH > 0) {
        acousticParts.push(
          `<rect x="${fmtNum(cx - 7.2)}" y="${fmtNum(ySpecTop + 0.6)}" width="14.4" height="${fmtNum(Math.max(0, specH - 1.2))}" fill="#FFFFFF"/>`,
          drawBreakSlashes(cx, ySpecTop + specH * 0.5, 6.2, 1.05, '#4A4945')
        );
      }
    }

    // Crisp unbroken top and bottom hairline frame on spectrogram (drawn AFTER silence masks!)
    if (specH > 0) {
      acousticParts.push(
        `<line x1="${xTrackLeft}" y1="${fmtNum(ySpecTop)}" x2="${xTrackRight}" y2="${fmtNum(ySpecTop)}" stroke="${BRAUN.ruleDark}" stroke-width="0.8"/>`,
        `<line x1="${xTrackLeft}" y1="${fmtNum(ySpecBot)}" x2="${xTrackRight}" y2="${fmtNum(ySpecBot)}" stroke="${BRAUN.ruleDark}" stroke-width="0.8"/>`
      );
    }

    // 5. Precision Geometric Time-to-Text Alignment Polylines
    if (polyH > 0) {
      const majorTimes: number[] = [];
      for (let r = 0; r < tierRows.length; r++) {
        const tr = tierRows[r];
        if (tr.kind === 'interval' && !tr.isIpa && (tierRows.length <= 3 || r > 0)) {
          for (const iv of tr.tier.intervals) {
            if (resolvePosterText(iv.text) !== '') {
              majorTimes.push(clamp(iv.xmin, tStart, tEnd), clamp(iv.xmax, tStart, tEnd));
            }
          }
        }
      }
      const isMajorKnot = (t: number) => majorTimes.some((mt) => Math.abs(mt - t) < 0.004);
      const stubLen = isFolded ? 4.8 : 7.0;

      for (let k = 0; k < textRuler.knots.length; k++) {
        const kt = textRuler.knots[k];
        const x1 = acousticRuler.timeToX(kt);
        const x2 = textRuler.knotX[k];
        const isOuter = k === 0 || k === textRuler.knots.length - 1;
        const major = !isOuter && isMajorKnot(kt);
        const col = major ? '#3D3C38' : '#ACA9A0';
        const op = isOuter ? '0.42' : major ? '0.84' : '0.56';
        const sw = major ? '0.8' : '0.65';
        const pts = `${fmtNum(x1)},${fmtNum(yPolyTop)} ${fmtNum(x1)},${fmtNum(yPolyTop + stubLen)} ${fmtNum(x2)},${fmtNum(yPolyBot - stubLen)} ${fmtNum(x2)},${fmtNum(yPolyBot)}`;
        acousticParts.push(
          `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-opacity="${op}" stroke-linejoin="round"/>`
        );
        if (major) {
          acousticParts.push(`<circle cx="${fmtNum(x1)}" cy="${fmtNum(yPolyTop)}" r="1.15" fill="#3D3C38" fill-opacity="0.75"/>`);
        }
      }

      annotationParts.push(
        `<line x1="${xGutterLeft}" y1="${fmtNum(yRowsTop)}" x2="${xTrackRight}" y2="${fmtNum(yRowsTop)}" stroke="${BRAUN.ruleDark}" stroke-width="0.85"/>`
      );
    }

    // 6. Borderless Multi-Layer Annotation Grid + Swiss Tier Index Badges + Point Markers
    let yCur = yRowsTop;
    for (let rIdx = 0; rIdx < tierRows.length; rIdx++) {
      const row = tierRows[rIdx];
      const yNext = yCur + row.rowH;
      const yMid = (yCur + yNext) * 0.5;
      const fontStack = row.isIpa ? POSTER_IPA_STACK : POSTER_SANS_STACK;

      // Left gutter: Swiss 2-digit index + subtle material indicator dot + right-aligned tier name
      const idxStr = String(row.orderNum).padStart(2, '0');
      const dotY = yMid - 0.2;
      if (row.kind === 'point') {
        annotationParts.push(`<circle cx="${xGutterLeft + 2.5}" cy="${fmtNum(dotY)}" r="2.2" fill="${BRAUN.orange}"/>`);
      } else if (rIdx === 0) {
        annotationParts.push(`<rect x="${xGutterLeft + 0.5}" y="${fmtNum(dotY - 2.1)}" width="4.2" height="4.2" rx="0.6" fill="${BRAUN.ink}"/>`);
      } else if (rIdx === 1 && !row.isIpa) {
        annotationParts.push(`<rect x="${xGutterLeft + 0.5}" y="${fmtNum(dotY - 2.1)}" width="4.2" height="4.2" rx="0.6" fill="none" stroke="${BRAUN.inkSoft}" stroke-width="1.1"/>`);
      } else {
        annotationParts.push(`<circle cx="${xGutterLeft + 2.5}" cy="${fmtNum(dotY)}" r="1.7" fill="#A6A59E"/>`);
      }

      annotationParts.push(
        `<text x="${xGutterLeft + 8.5}" y="${fmtNum(yMid + 2.8)}" font-size="7.6" font-weight="600" fill="#9E9D96" font-family="${escapeXml(POSTER_MONO_STACK)}">${idxStr}</text>`,
        `<text x="${xGutterLeft + 26}" y="${fmtNum(yMid + 3.4)}" text-anchor="start" font-size="${isFolded ? '10.0' : '10.4'}" font-weight="500" fill="${row.kind === 'point' ? BRAUN.inkSoft : BRAUN.sub}" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(row.label)}</text>`
      );

      if (row.kind === 'interval') {
        let anyRendered = false;
        const useSubtleTint = !row.isIpa;
        const cellFill = rIdx % 2 === 0 ? BRAUN.cellTintPrimary : BRAUN.cellTintSecondary;
        const topAccent = rIdx === 0 ? '#3A3936' : '#8D8C85';

        for (const iv of row.tier.intervals) {
          const rawTxt = resolvePosterText(iv.text);
          if (!rawTxt) continue;
          if (iv.xmax <= tStart + 1e-4 || iv.xmin >= tEnd - 1e-4) continue;

          const clippedLeft = iv.xmin < tStart - 1e-4;
          const clippedRight = iv.xmax > tEnd + 1e-4;
          const a = Math.max(tStart, iv.xmin);
          const b = Math.min(tEnd, iv.xmax);
          if (b - a < 1e-4) continue;

          const x0 = textRuler.timeToTextX(a);
          const x1 = textRuler.timeToTextX(b);
          const cellW = x1 - x0;
          const xCenter = (x0 + x1) * 0.5;

          // Subtle archival paper cell tint for spoken turns / words (makes dialogue rhythm immediately legible!)
          if (useSubtleTint && cellW > 4) {
            const insetY = Math.min(3.5, row.rowH * 0.11);
            annotationParts.push(
              `<rect x="${fmtNum(x0 + 0.8)}" y="${fmtNum(yCur + insetY)}" width="${fmtNum(Math.max(1, cellW - 1.6))}" height="${fmtNum(Math.max(2, row.rowH - insetY * 2))}" rx="1.5" fill="${cellFill}"/>`,
              `<line x1="${fmtNum(x0 + 1.2)}" y1="${fmtNum(yCur + insetY)}" x2="${fmtNum(x1 - 1.2)}" y2="${fmtNum(yCur + insetY)}" stroke="${topAccent}" stroke-opacity="0.45" stroke-width="1.0"/>`
            );
          }

          // Crisp precision boundary ticks on top & bottom hairline
          annotationParts.push(
            `<line x1="${fmtNum(x0)}" y1="${fmtNum(yCur)}" x2="${fmtNum(x0)}" y2="${fmtNum(yCur + 4.5)}" stroke="#AEADA6" stroke-width="0.65"/>`,
            `<line x1="${fmtNum(x1)}" y1="${fmtNum(yCur)}" x2="${fmtNum(x1)}" y2="${fmtNum(yCur + 4.5)}" stroke="#AEADA6" stroke-width="0.65"/>`
          );

          let displayTxt = rawTxt;
          if (clippedLeft && !clippedRight) displayTxt = '…' + displayTxt;
          if (clippedRight && !clippedLeft) displayTxt = displayTxt + ' →';

          let fSz = row.fontSize;
          const sidePad = Math.min(11, Math.max(6.5, cellW * 0.22));
          const maxTxtW = Math.max(5, cellW - sidePad);
          const measured = measurePx(displayTxt, `${row.fontWeight} ${fSz.toFixed(1)}px ${fontStack}`);
          if (measured > maxTxtW && cellW > 8) {
            const ratio = maxTxtW / Math.max(1, measured);
            if (ratio >= 0.62) {
              fSz = Math.max(7.6, fSz * ratio);
            } else {
              fSz = Math.max(7.6, fSz * 0.66);
              displayTxt = truncateByGraphemes(
                displayTxt,
                Math.max(5, maxTxtW - 1),
                `${row.fontWeight} ${fSz.toFixed(1)}px ${fontStack}`
              );
            }
          }

          annotationParts.push(
            `<text x="${fmtNum(xCenter)}" y="${fmtNum(yMid + fSz * 0.35)}" text-anchor="middle" font-size="${fmtNum(fSz)}" font-weight="${row.fontWeight}" fill="${BRAUN.ink}" font-family="${escapeXml(fontStack)}">${escapeXml(displayTxt)}</text>`
          );
          anyRendered = true;
        }
        if (!anyRendered && row.isEmpty) {
          annotationParts.push(
            `<text x="${xTrackLeft + 8}" y="${fmtNum(yMid + 3.5)}" font-size="10.0" fill="#B8B7B0" font-family="${escapeXml(POSTER_SANS_STACK)}">—</text>`
          );
        }
      } else {
        // Point tier row:
        // - With Directory (standard 3:4 poster): crisp collision-resolved Braun orange numbered index badges (01..N)!
        // - Without Directory (emblem 1:1): collision-avoided compact inline tags
        // - pureVisual: pure Braun orange pinhead needles & dots (no text)
        const segPts = indexedPoints.filter((pt) => pt.time >= tStart - 1e-4 && pt.time <= tEnd + 1e-4);

        if (segPts.length === 0) {
          if (!config.pureVisual) {
            pointParts.push(
              `<text x="${xTrackLeft + 8}" y="${fmtNum(yMid + 3.5)}" font-size="10.0" fill="#B8B7B0" font-family="${escapeXml(POSTER_SANS_STACK)}">—</text>`
            );
          }
        } else if (config.pureVisual) {
          for (const pt of segPts) {
            const px = textRuler.timeToTextX(clamp(pt.time, tStart, tEnd));
            pointParts.push(
              `<line x1="${fmtNum(px)}" y1="${fmtNum(yCur)}" x2="${fmtNum(px)}" y2="${fmtNum(yMid)}" stroke="${BRAUN.orange}" stroke-width="1.05"/>`,
              `<circle cx="${fmtNum(px)}" cy="${fmtNum(yMid)}" r="3.2" fill="${BRAUN.orange}"/>`
            );
          }
        } else if (showPointDirectory) {
          // Collision-free horizontal solver for numbered circular badges (r = 7.4)
          const badgeR = row.rowH < 30 ? 6.4 : 7.4;
          const minGap = badgeR * 2 + 3.2;
          const nodes = segPts.map((pt) => {
            const trueX = textRuler.timeToTextX(clamp(pt.time, tStart, tEnd));
            return { pt, trueX, bx: clamp(trueX, xTrackLeft + badgeR + 1, xTrackRight - badgeR - 1) };
          });
          // Relaxation passes so adjacent badges never touch or clip
          for (let iter = 0; iter < 24; iter++) {
            let moved = false;
            for (let i = 0; i < nodes.length - 1; i++) {
              const gap = nodes[i + 1].bx - nodes[i].bx;
              if (gap < minGap) {
                const push = (minGap - gap) * 0.52;
                nodes[i].bx = Math.max(xTrackLeft + badgeR + 1, nodes[i].bx - push);
                nodes[i + 1].bx = Math.min(xTrackRight - badgeR - 1, nodes[i + 1].bx + push);
                moved = true;
              }
            }
            for (let i = 1; i < nodes.length; i++) {
              if (nodes[i].bx < nodes[i - 1].bx + minGap) {
                nodes[i].bx = Math.min(xTrackRight - badgeR - 1, nodes[i - 1].bx + minGap);
              }
            }
            for (let i = nodes.length - 2; i >= 0; i--) {
              if (nodes[i].bx > nodes[i + 1].bx - minGap) {
                nodes[i].bx = Math.max(xTrackLeft + badgeR + 1, nodes[i + 1].bx - minGap);
              }
            }
            if (!moved) break;
          }

          const badgeCy = yCur + row.rowH * 0.56;
          for (const nd of nodes) {
            const stemMidY = yCur + Math.min(6.5, (badgeCy - badgeR - yCur) * 0.55);
            if (Math.abs(nd.bx - nd.trueX) > 1.2) {
              pointParts.push(
                `<polyline points="${fmtNum(nd.trueX)},${fmtNum(yCur)} ${fmtNum(nd.trueX)},${fmtNum(stemMidY)} ${fmtNum(nd.bx)},${fmtNum(badgeCy - badgeR)}" fill="none" stroke="${BRAUN.orange}" stroke-width="0.95" stroke-linejoin="round"/>`
              );
            } else {
              pointParts.push(
                `<line x1="${fmtNum(nd.trueX)}" y1="${fmtNum(yCur)}" x2="${fmtNum(nd.bx)}" y2="${fmtNum(badgeCy - badgeR)}" stroke="${BRAUN.orange}" stroke-width="0.95"/>`
              );
            }
            pointParts.push(
              `<circle cx="${fmtNum(nd.trueX)}" cy="${fmtNum(yCur)}" r="1.4" fill="${BRAUN.orange}"/>`,
              `<circle cx="${fmtNum(nd.bx)}" cy="${fmtNum(badgeCy)}" r="${fmtNum(badgeR)}" fill="${BRAUN.orange}"/>`,
              `<text x="${fmtNum(nd.bx)}" y="${fmtNum(badgeCy + badgeR * 0.39)}" text-anchor="middle" font-size="${fmtNum(badgeR * 1.08)}" font-weight="700" fill="#FFFFFF" font-family="${escapeXml(POSTER_MONO_STACK)}">${nd.pt.badge}</text>`
            );
          }
        } else {
          // Compact inline placement for Emblem 1:1 mode
          const visiblePts = segPts.map((pt) => {
            const px = textRuler.timeToTextX(clamp(pt.time, tStart, tEnd));
            const ptFont = IPA_CHAR_RE.test(pt.shortLabel) ? POSTER_IPA_STACK : POSTER_SANS_STACK;
            const ptFontCss = `${row.fontWeight} ${row.fontSize.toFixed(1)}px ${ptFont}`;
            const w = measurePx(pt.shortLabel, ptFontCss) + 8;
            return { x: px, label: pt.shortLabel, w, font: ptFont };
          });
          let lastRight0 = -999;
          let lastRight1 = -999;
          const canStagger = row.rowH >= 32;
          for (const vp of visiblePts) {
            const boxX = clamp(vp.x, xTrackLeft + vp.w * 0.5, xTrackRight - vp.w * 0.5);
            let lane = 0;
            if (boxX - vp.w * 0.5 < lastRight0 + 2) {
              if (canStagger && boxX - vp.w * 0.5 >= lastRight1 + 2) lane = 1;
              else continue;
            }
            if (lane === 0) lastRight0 = boxX + vp.w * 0.5;
            else lastRight1 = boxX + vp.w * 0.5;
            const textY = lane === 1 ? yCur + row.rowH * 0.8 : yMid + row.fontSize * 0.35;
            pointParts.push(
              `<line x1="${fmtNum(vp.x)}" y1="${fmtNum(yCur)}" x2="${fmtNum(vp.x)}" y2="${fmtNum(yCur + 5.5)}" stroke="${BRAUN.orange}" stroke-width="1.0"/>`,
              `<circle cx="${fmtNum(vp.x)}" cy="${fmtNum(yCur + 5.5)}" r="1.5" fill="${BRAUN.orange}"/>`,
              `<text x="${fmtNum(boxX)}" y="${fmtNum(textY)}" text-anchor="middle" font-size="${fmtNum(row.fontSize)}" font-weight="${row.fontWeight}" fill="${BRAUN.inkSoft}" font-family="${escapeXml(vp.font)}">${escapeXml(vp.label)}</text>`
            );
          }
        }
      }

      annotationParts.push(
        `<line x1="${xGutterLeft}" y1="${fmtNum(yNext)}" x2="${xTrackRight}" y2="${fmtNum(yNext)}" stroke="${rIdx === tierRows.length - 1 ? '#C8C7C0' : BRAUN.rule}" stroke-width="${rIdx === tierRows.length - 1 ? '0.75' : '0.6'}"/>`
      );
      yCur = yNext;
    }
  };

  // Compute vertical space inside paper strip cleanly accounting for optional Point Directory & Colophon
  const innerTop = stripY + (isEmblem ? 24 : 26);
  const colophonTop = stripY + stripH - (isEmblem ? 22 : 42);
  const dirTop = showPointDirectory ? colophonTop - dirBlockH - 6 : colophonTop;
  const segAreaBot = showPointDirectory ? dirTop - 12 : colophonTop - 10;
  const innerAvailH = Math.max(220, segAreaBot - innerTop);

  if (duration <= 5.5) {
    renderSegment(0, 1, tMin, tMax, innerTop, innerAvailH);
  } else {
    const tSplit = chooseSplitTime(
      intervalEntries.map((e) => e.tier),
      waveformBins,
      tMin,
      tMax
    );
    const foldGap = 24;
    const segH = (innerAvailH - foldGap) * 0.5;
    const foldY = innerTop + segH + foldGap * 0.5;
    renderSegment(0, 2, tMin, tSplit, innerTop, segH);
    // Realistic paper fold crease band + subtle edge fold registration notches
    paperStripParts.push(
      `<rect x="${stripX + 34}" y="${fmtNum(foldY - 5)}" width="${stripW - 68}" height="10" fill="url(#${idPfx}fold-sh)"/>`,
      `<line x1="${stripX + 34}" y1="${fmtNum(foldY)}" x2="${stripX + stripW - 34}" y2="${fmtNum(foldY)}" stroke="#C9C8C1" stroke-width="0.7" stroke-dasharray="4 3.5"/>`,
      `<polygon points="${stripX + 34},${fmtNum(foldY - 2.5)} ${stripX + 38.5},${fmtNum(foldY)} ${stripX + 34},${fmtNum(foldY + 2.5)}" fill="#C4C3BC"/>`,
      `<polygon points="${stripX + stripW - 34},${fmtNum(foldY - 2.5)} ${stripX + stripW - 38.5},${fmtNum(foldY)} ${stripX + stripW - 34},${fmtNum(foldY + 2.5)}" fill="#C4C3BC"/>`
    );
    renderSegment(1, 2, tSplit, tMax, innerTop + segH + foldGap, segH);
  }

  // --------------------------------------------------------------------------
  // Swiss-Grid Numbered Point & Event Directory (Zero Truncation!)
  // --------------------------------------------------------------------------
  if (showPointDirectory) {
    const dirX0 = 108;
    const dirX1 = 782;
    const dirW = dirX1 - dirX0;
    const ptTierTitle = pointTier?.tier.name ? pointTier.tier.name : '标点与事件';
    const overflowCount = indexedPoints.length - dirEntries.length;
    const dirRightMeta =
      overflowCount > 0
        ? `01–${String(dirEntries.length).padStart(2, '0')} (共 ${indexedPoints.length} 项)`
        : `${String(dirEntries.length).padStart(2, '0')} ITEMS · ${tMin.toFixed(2)}–${tMax.toFixed(2)}s`;

    editorialParts.push(
      `<line x1="${dirX0}" y1="${fmtNum(dirTop)}" x2="${dirX1}" y2="${fmtNum(dirTop)}" stroke="${BRAUN.ruleDark}" stroke-width="0.9"/>`,
      `<circle cx="${dirX0 + 3.5}" cy="${fmtNum(dirTop + 13.5)}" r="2.8" fill="${BRAUN.orange}"/>`,
      `<text x="${dirX0 + 11}" y="${fmtNum(dirTop + 16.5)}" font-size="9.4" font-weight="700" letter-spacing="0.7" fill="${BRAUN.ink}" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(ptTierTitle)}索引</text>`,
      `<text x="${dirX0 + 11 + measurePx(`${ptTierTitle}索引`, `700 9.4px ${POSTER_SANS_STACK}`) + 8}" y="${fmtNum(dirTop + 16.3)}" font-size="8.2" font-weight="600" letter-spacing="1.0" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_MONO_STACK)}">· EVENT &amp; POINT INDEX</text>`,
      `<text x="${dirX1}" y="${fmtNum(dirTop + 16.3)}" text-anchor="end" font-size="8.2" font-weight="500" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_MONO_STACK)}">${escapeXml(dirRightMeta)}</text>`,
      `<line x1="${dirX0}" y1="${fmtNum(dirTop + 23)}" x2="${dirX1}" y2="${fmtNum(dirTop + 23)}" stroke="${BRAUN.rule}" stroke-width="0.65"/>`
    );

    const colGap = 18;
    const colW = (dirW - colGap * (dirCols - 1)) / dirCols;
    const listTop = dirTop + 28;
    const entryFontSize = dirCols === 3 ? 8.6 : 9.4;

    for (let i = 0; i < dirEntries.length; i++) {
      const entry = dirEntries[i];
      const col = Math.floor(i / dirRows);
      const row = i % dirRows;
      const cx0 = dirX0 + col * (colW + colGap);
      const cyMid = listTop + row * dirRowH + dirRowH * 0.5;
      const timeStr = `${entry.time.toFixed(2)}s`;
      const textStartX = cx0 + (dirCols === 3 ? 52 : 58);
      const availTextW = Math.max(40, cx0 + colW - textStartX - 2);
      const entryFont = IPA_CHAR_RE.test(entry.fullLabel) ? POSTER_IPA_STACK : POSTER_SANS_STACK;
      const entryFontCss = `500 ${entryFontSize.toFixed(1)}px ${entryFont}`;
      const safeLabel = truncateByGraphemes(entry.fullLabel, availTextW, entryFontCss);

      editorialParts.push(
        `<circle cx="${fmtNum(cx0 + 6.5)}" cy="${fmtNum(cyMid)}" r="5.6" fill="${BRAUN.orange}"/>`,
        `<text x="${fmtNum(cx0 + 6.5)}" y="${fmtNum(cyMid + 2.5)}" text-anchor="middle" font-size="7.0" font-weight="700" fill="#FFFFFF" font-family="${escapeXml(POSTER_MONO_STACK)}">${entry.badge}</text>`,
        `<text x="${fmtNum(cx0 + 16)}" y="${fmtNum(cyMid + 2.9)}" font-size="${dirCols === 3 ? '7.8' : '8.4'}" font-weight="500" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_MONO_STACK)}">${escapeXml(timeStr)}</text>`,
        `<text x="${fmtNum(textStartX)}" y="${fmtNum(cyMid + 3.1)}" font-size="${fmtNum(entryFontSize)}" font-weight="500" fill="${BRAUN.inkSoft}" font-family="${escapeXml(entryFont)}">${escapeXml(safeLabel)}</text>`
      );
    }
  }

  // --------------------------------------------------------------------------
  // Bottom Strip Colophon & Acoustic Micro-Legend (hidden in emblem or pureVisual)
  // --------------------------------------------------------------------------
  if (!isEmblem && !config.pureVisual) {
    const yRule = colophonTop;
    const yText = colophonTop + 19;
    const footRight = `${tMin.toFixed(2)}s – ${tMax.toFixed(2)}s`;

    editorialParts.push(
      `<line x1="108" y1="${fmtNum(yRule)}" x2="782" y2="${fmtNum(yRule)}" stroke="${BRAUN.rule}" stroke-width="0.7"/>`
    );

    const customFoot = config.copy.footer.trim();
    if (customFoot) {
      editorialParts.push(
        `<text x="108" y="${fmtNum(yText)}" font-size="9.0" font-weight="500" letter-spacing="0.3" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(truncateByGraphemes(customFoot, 540, `500 9.0px ${POSTER_SANS_STACK}`))}</text>`
      );
    } else {
      // Crisp Dieter Rams technical key swatches
      let lx = 108;
      if (hasAudio && config.showWaveform) {
        editorialParts.push(
          `<line x1="${lx}" y1="${fmtNum(yText - 3)}" x2="${lx + 10}" y2="${fmtNum(yText - 3)}" stroke="${BRAUN.ink}" stroke-width="1.2"/>`,
          `<text x="${lx + 14}" y="${fmtNum(yText)}" font-size="8.6" font-weight="500" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_SANS_STACK)}">声波 AMP</text>`
        );
        lx += 70;
      }
      if (hasAudio && config.showSpectrogram) {
        editorialParts.push(
          `<rect x="${lx}" y="${fmtNum(yText - 6.5)}" width="9" height="6.5" rx="0.8" fill="#42413D"/>`,
          `<text x="${lx + 13}" y="${fmtNum(yText)}" font-size="8.6" font-weight="500" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_SANS_STACK)}">声谱 0–${(maxFreq / 1000).toFixed(1).replace(/\.0$/, '')}kHz</text>`
        );
        lx += 88;
      }
      if (hasAudio && config.showPitch) {
        editorialParts.push(
          `<line x1="${lx}" y1="${fmtNum(yText - 3)}" x2="${lx + 11}" y2="${fmtNum(yText - 3)}" stroke="${BRAUN.orange}" stroke-width="1.6" stroke-linecap="round"/>`,
          `<text x="${lx + 15}" y="${fmtNum(yText)}" font-size="8.6" font-weight="500" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_SANS_STACK)}">音高 F0</text>`
        );
        lx += 64;
      }
      editorialParts.push(
        `<text x="${lx}" y="${fmtNum(yText)}" font-size="8.4" font-weight="500" letter-spacing="0.4" fill="#9E9D96" font-family="${escapeXml(POSTER_SANS_STACK)}">声学纸带记录单 · 时间对齐视图</text>`
      );
    }

    editorialParts.push(
      `<text x="782" y="${fmtNum(yText)}" text-anchor="end" font-size="8.8" font-weight="600" fill="${BRAUN.muted}" font-family="${escapeXml(POSTER_MONO_STACK)}">${escapeXml(footRight)}</text>`
    );
  }

  const editorialGroup = editorialParts.length > 0 ? `<g id="editorial-copy">${editorialParts.join('')}</g>` : '';
  const printMarksGroup = config.includeBleed ? renderPrintMarksSvg(trimW, trimH, bleed) : '';

  const svgMarkup =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmtNum(widthPt)}pt" height="${fmtNum(heightPt)}pt" viewBox="${fmtNum(-bleed)} ${fmtNum(-bleed)} ${fmtNum(widthPt)} ${fmtNum(heightPt)}">` +
    `<defs>${defs}</defs>` +
    paperBgGroup +
    `<g id="instrument-panel">${instrumentParts.join('')}</g>` +
    `<g id="paper-strip">${paperStripParts.join('')}</g>` +
    `<g id="acoustic-traces">${acousticParts.join('')}</g>` +
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
    activePointCount: indexedPoints.length
  };
}
