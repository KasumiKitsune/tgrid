import type { TextGrid, Tier } from '../../bridge/types';
import { measurePx, splitGraphemes } from '../../layout/richText';
import {
  POSTER_IPA_STACK,
  POSTER_MONO_STACK,
  POSTER_SANS_STACK,
  POSTER_SERIF_STACK,
  countActiveIntervals,
  escapeXml,
  fmtNum,
  hasCombiningMarks,
  isTierIpaLike,
  renderPrintMarksSvg,
  resolvePosterText,
  truncateByGraphemes
} from './polarSolver';
import { renderFanSpectrogramRaster, type PosterSpecMatrix } from './posterAcoustics';
import { POSTER_BLEED_PT, type PosterAutoCopy, type PosterConfig } from './types';

export interface RenderFoldingFanParams {
  tg: TextGrid;
  tMin: number;
  tMax: number;
  config: PosterConfig;
  autoCopy: PosterAutoCopy;
  specMatrix: PosterSpecMatrix | null;
  waveformBins: Array<[number, number]> | null;
  f0Runs: Array<Array<{ t: number; normF0: number }>>;
  hasAudio: boolean;
  maxFreq: number;
  previewMode: boolean;
}

/**
 * Song/Ming 135° Open Folding Fan geometry tuned for gallery-perfect vertical rhythm on 900×1200 pt:
 * - Upper-left calligraphy title + carved seal + top-right colophon: y = 56..164
 * - Open 135° folding fan + outer numbered scholarly medallions: y = 274..809
 * - Refined two-zone Song/Ming scholarly annotation directory + archival colophon: y = 876..1154
 */
const FAN = {
  cx: 374,
  cy: 744,
  degStart: -128,
  degEnd: 7,
  rHead: 52,
  rCadenceIn: 146.5,
  rCadenceOut: 150.2,
  rSpecIn: 156,
  rSpecOut: 244,
  rBridgeOut: 274,
  rLeafOut: 432,
  rRimOut: 439,
  rBadge: 462
};

const PAL = {
  paper: '#F6F3EB',
  paperHi: '#FCFBF6',
  paperEdge: '#EAE3D4',
  paperRule: '#D8D1C2',
  inkDeep: '#24211D',
  inkMid: '#595146',
  inkSoft: '#7D7466',
  bambooDeep: '#6B5437',
  bambooDark: '#826847',
  bambooMid: '#A98656',
  bambooLight: '#CBB695',
  jadeDeep: '#1E4C52',
  jadeRim: '#2D666B',
  jadeMid: '#488183',
  sealRed: '#B63B2A',
  sealDark: '#8F2D20'
};

/** Harmonious Song/Ming mineral pigment cycle shared 1:1 by fan-rim medallions & bottom directory. */
const POINT_PIGMENT_CYCLE = [PAL.sealRed, PAL.bambooMid, PAL.jadeRim, PAL.inkDeep];

const COMBINING_RE = /\p{M}/gu;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g;
const IPA_GLYPH_RE = /[\u0250-\u02AF\u02B0-\u02FF\u0300-\u036F\u1D00-\u1DBF]/;

interface FanRingStyle {
  swatchFill: string;
  swatchStroke: string;
  cellFillEven: string;
  cellFillOdd: string;
  filletColor: string;
  filletThick: number;
  textColor: string;
  guideColor: string;
  cadenceColor: string;
}

/** Single source of truth for each ring's Song/Ming silk wash & bottom-left directory swatch. */
function getFanRingStyle(
  ti: number,
  nTiers: number,
  isIpa: boolean,
  isPinyin: boolean
): FanRingStyle {
  if (nTiers <= 1) {
    return {
      swatchFill: PAL.jadeRim,
      swatchStroke: 'none',
      cellFillEven: 'rgba(45,102,107,0.065)',
      cellFillOdd: 'rgba(45,102,107,0.036)',
      filletColor: PAL.jadeRim,
      filletThick: 2.3,
      textColor: '#1E3C40',
      guideColor: PAL.jadeRim,
      cadenceColor: PAL.jadeRim
    };
  }
  if (nTiers === 2) {
    if (ti === 0) {
      return {
        swatchFill: PAL.jadeRim,
        swatchStroke: 'none',
        cellFillEven: 'rgba(45,102,107,0.072)',
        cellFillOdd: 'rgba(45,102,107,0.042)',
        filletColor: PAL.jadeRim,
        filletThick: 2.4,
        textColor: '#1C393D',
        guideColor: PAL.jadeRim,
        cadenceColor: PAL.jadeRim
      };
    }
    return {
      swatchFill: PAL.bambooMid,
      swatchStroke: 'none',
      cellFillEven: 'rgba(169,134,86,0.088)',
      cellFillOdd: 'rgba(169,134,86,0.052)',
      filletColor: PAL.bambooMid,
      filletThick: 2.4,
      textColor: '#2E251B',
      guideColor: '#8B6D43',
      cadenceColor: PAL.bambooMid
    };
  }
  // 3..6 tier scholarly hierarchy
  if (ti === 0) {
    return {
      swatchFill: PAL.inkDeep,
      swatchStroke: 'none',
      cellFillEven: 'rgba(36,33,29,0.055)',
      cellFillOdd: 'rgba(36,33,29,0.035)',
      filletColor: PAL.inkDeep,
      filletThick: 1.9,
      textColor: '#302B25',
      guideColor: PAL.inkMid,
      cadenceColor: PAL.inkDeep
    };
  }
  if (ti === 1) {
    return {
      swatchFill: PAL.jadeRim,
      swatchStroke: 'none',
      cellFillEven: 'rgba(45,102,107,0.078)',
      cellFillOdd: 'rgba(45,102,107,0.044)',
      filletColor: PAL.jadeRim,
      filletThick: 2.2,
      textColor: '#1B3A3E',
      guideColor: PAL.jadeRim,
      cadenceColor: PAL.jadeRim
    };
  }
  if (isPinyin || (ti === 2 && !isIpa)) {
    return {
      swatchFill: PAL.bambooMid,
      swatchStroke: 'none',
      cellFillEven: 'rgba(169,134,86,0.072)',
      cellFillOdd: 'rgba(169,134,86,0.040)',
      filletColor: PAL.bambooMid,
      filletThick: 1.5,
      textColor: '#564B3D',
      guideColor: '#8B6D43',
      cadenceColor: PAL.bambooMid
    };
  }
  if (ti === nTiers - 1) {
    return {
      swatchFill: PAL.jadeMid,
      swatchStroke: 'none',
      cellFillEven: 'rgba(72,129,131,0.068)',
      cellFillOdd: 'rgba(72,129,131,0.032)',
      filletColor: PAL.jadeMid,
      filletThick: 1.5,
      textColor: PAL.jadeDeep,
      guideColor: PAL.jadeDeep,
      cadenceColor: PAL.jadeMid
    };
  }
  return {
    swatchFill: PAL.paperHi,
    swatchStroke: PAL.bambooDark,
    cellFillEven: 'rgba(255,254,250,0.44)',
    cellFillOdd: 'rgba(182,168,142,0.065)',
    filletColor: PAL.bambooLight,
    filletThick: 1.1,
    textColor: '#3D372F',
    guideColor: PAL.inkSoft,
    cadenceColor: PAL.bambooDark
  };
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function polarXY(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = degToRad(deg);
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPathD(cx: number, cy: number, r: number, d1: number, d2: number): string {
  if (Math.abs(d2 - d1) < 1e-4) return '';
  const [x1, y1] = polarXY(cx, cy, r, d1);
  const [x2, y2] = polarXY(cx, cy, r, d2);
  const large = Math.abs(d2 - d1) > 180 ? 1 : 0;
  const sweep = d2 >= d1 ? 1 : 0;
  return `M ${fmtNum(x1)} ${fmtNum(y1)} A ${fmtNum(r)} ${fmtNum(r)} 0 ${large} ${sweep} ${fmtNum(x2)} ${fmtNum(y2)}`;
}

function sectorPathD(cx: number, cy: number, rIn: number, rOut: number, d1: number, d2: number): string {
  if (d2 <= d1 + 1e-4) return '';
  const [ox1, oy1] = polarXY(cx, cy, rOut, d1);
  const [ox2, oy2] = polarXY(cx, cy, rOut, d2);
  const [ix2, iy2] = polarXY(cx, cy, rIn, d2);
  const [ix1, iy1] = polarXY(cx, cy, rIn, d1);
  const large = Math.abs(d2 - d1) > 180 ? 1 : 0;
  return (
    `M ${fmtNum(ox1)} ${fmtNum(oy1)} ` +
    `A ${fmtNum(rOut)} ${fmtNum(rOut)} 0 ${large} 1 ${fmtNum(ox2)} ${fmtNum(oy2)} ` +
    `L ${fmtNum(ix2)} ${fmtNum(iy2)} ` +
    `A ${fmtNum(rIn)} ${fmtNum(rIn)} 0 ${large} 0 ${fmtNum(ix1)} ${fmtNum(iy1)} Z`
  );
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function renderXuanPaperFibersPath(w: number, h: number, bleed: number): string {
  const rng = mulberry32(202611);
  const segs: string[] = [];
  const xMin = -bleed + 8;
  const xSpan = w + 2 * bleed - 16;
  const yMin = -bleed + 8;
  const ySpan = h + 2 * bleed - 16;
  for (let i = 0; i < 420; i++) {
    const x = xMin + rng() * xSpan;
    const y = yMin + rng() * ySpan;
    const len = 3 + rng() * 9;
    const ang = rng() * Math.PI * 2;
    const cx = x + Math.cos(ang + 0.3) * len * 0.5;
    const cy = y + Math.sin(ang + 0.3) * len * 0.5;
    const ex = x + Math.cos(ang) * len;
    const ey = y + Math.sin(ang) * len;
    segs.push(`M${fmtNum(x, 1)} ${fmtNum(y, 1)}Q${fmtNum(cx, 1)} ${fmtNum(cy, 1)} ${fmtNum(ex, 1)} ${fmtNum(ey, 1)}`);
  }
  return segs.join('');
}

function visualBaseUnits(str: string): number {
  const s = str.replace(COMBINING_RE, '');
  const cjkCount = (s.match(CJK_RE) || []).length;
  const otherCount = Math.max(0, splitGraphemes(s).length - cjkCount);
  return cjkCount * 1.05 + otherCount * 0.6;
}

function isBoundaryBreakMark(rawMark: string): boolean {
  const m = resolvePosterText(rawMark);
  if (!m) return false;
  return (
    /^(H-|L-|H-L%|L-L%|L-H%|H-H%|%[HL]|B[1-4])(\s*\/\s*B[1-4])?$/i.test(m) ||
    /\/\s*B[1-4]$/i.test(m)
  );
}

interface FanSlice {
  t0: number;
  t1: number;
  dur: number;
  anyText: boolean;
  isEdgeSilence: boolean;
  isLongSilence: boolean;
  weight: number;
}

interface FanCadenceSpan {
  a: number;
  b: number;
  tierIdx: number;
  activeOrder: number;
  isEmpty: boolean;
}

interface FanScaleMap {
  xmin: number;
  xmax: number;
  totalDur: number;
  slices: FanSlice[];
  cleanKnots: number[];
  knotInnerDeg: number[];
  knotOuterDeg: number[];
  timeToInnerDeg: (t: number) => number;
  timeToOuterDeg: (t: number) => number;
  primaryRibTimes: number[];
  longSilences: FanSlice[];
  cadenceSpans: FanCadenceSpan[];
}

function buildFanDualScaleMap(intervalTiers: Tier[], tMin: number, tMax: number): FanScaleMap {
  const totalDur = Math.max(0.001, tMax - tMin);
  const { degStart, degEnd, rBridgeOut, rLeafOut } = FAN;
  const spanDeg = degEnd - degStart;
  const spanRad = degToRad(spanDeg);

  const timeSet = new Set<number>([tMin, tMax]);
  for (const tier of intervalTiers) {
    for (const iv of tier.intervals) {
      if (iv.xmax <= tMin + 1e-7 || iv.xmin >= tMax - 1e-7) continue;
      const a = Math.max(tMin, Math.min(tMax, iv.xmin));
      const b = Math.max(tMin, Math.min(tMax, iv.xmax));
      timeSet.add(Number(a.toFixed(6)));
      timeSet.add(Number(b.toFixed(6)));
    }
  }

  const knots = Array.from(timeSet).sort((a, b) => a - b);
  const cleanKnots: number[] = [knots[0]];
  for (let i = 1; i < knots.length; i++) {
    if (knots[i] - cleanKnots[cleanKnots.length - 1] > 0.0005) {
      cleanKnots.push(knots[i]);
    }
  }
  if (cleanKnots.length < 2) cleanKnots.push(tMax);
  else cleanKnots[cleanKnots.length - 1] = tMax;

  const sliceCount = Math.max(1, cleanKnots.length - 1);
  const slices: FanSlice[] = [];
  for (let i = 0; i < sliceCount; i++) {
    const t0 = cleanKnots[i];
    const t1 = cleanKnots[i + 1];
    const dur = Math.max(0.0001, t1 - t0);
    const tMid = 0.5 * (t0 + t1);
    let anyText = false;
    for (const tier of intervalTiers) {
      if (tier.intervals.some((iv) => iv.xmin <= tMid && tMid <= iv.xmax && resolvePosterText(iv.text) !== '')) {
        anyText = true;
        break;
      }
    }
    const isEdgeSilence = !anyText && (i === 0 || i === sliceCount - 1);
    const isLongSilence = !anyText && dur >= 0.5;
    slices.push({ t0, t1, dur, anyText, isEdgeSilence, isLongSilence, weight: 0 });
  }

  const activeDurSum = slices.reduce((acc, s) => acc + (s.anyText ? s.dur : 0), 0) || totalDur;
  for (const s of slices) {
    if (!s.anyText) {
      if (s.isEdgeSilence) {
        s.weight = Math.min(0.007, (s.dur / totalDur) * 0.18);
      } else if (s.isLongSilence) {
        s.weight = 0.025;
      } else {
        s.weight = Math.max(0.008, Math.min(0.018, (s.dur / totalDur) * 0.45));
      }
    } else {
      s.weight = Math.pow(s.dur / activeDurSum, 0.72);
    }
  }

  // Three-pass minimum fan-cell arc width guarantee across all tiers
  const nTiers = Math.max(1, intervalTiers.length);
  const leafThick = rLeafOut - rBridgeOut;
  for (let pass = 0; pass < 3; pass++) {
    const wTotal = slices.reduce((a, b) => a + b.weight, 0) || 1;
    for (const s of slices) s.weight /= wTotal;

    for (let ti = intervalTiers.length - 1; ti >= 0; ti--) {
      const tier = intervalTiers[ti];
      const rIn = rBridgeOut + (ti / nTiers) * leafThick;
      const rOut = rBridgeOut + ((ti + 1) / nTiers) * leafThick;
      const rMid = 0.5 * (rIn + rOut);
      const fontSize = nTiers >= 5 ? (ti === 0 ? 12.6 : ti === 1 ? 13.2 : ti === 2 ? 11.0 : 12.2) : 13.2;

      for (const iv of tier.intervals) {
        const txt = resolvePosterText(iv.text);
        if (!txt) continue;
        const a = Math.max(tMin, iv.xmin);
        const b = Math.min(tMax, iv.xmax);
        if (b <= a + 1e-5) continue;
        const covered = slices.filter((s) => s.t1 > a + 1e-5 && s.t0 < b - 1e-5);
        if (!covered.length) continue;

        const units = visualBaseUnits(txt);
        const neededPx =
          units <= 3.1
            ? Math.max(25.0, units * fontSize + 12)
            : Math.min(rMid * spanRad * 0.76, units * fontSize * 0.98 + 22);
        const minShare = neededPx / (rMid * spanRad);
        const curShare = covered.reduce((acc, s) => acc + s.weight, 0);
        if (curShare < minShare && curShare > 0) {
          const addEach = (minShare - curShare) / covered.length;
          for (const s of covered) s.weight += addEach;
        }
      }
    }
  }

  const finalW = slices.reduce((a, b) => a + b.weight, 0) || 1;
  const knotOuterDeg: number[] = [degStart];
  let acc = 0;
  for (const s of slices) {
    acc += s.weight / finalW;
    knotOuterDeg.push(degStart + acc * spanDeg);
  }
  knotOuterDeg[knotOuterDeg.length - 1] = degEnd;
  const knotInnerDeg = cleanKnots.map((t) => degStart + ((t - tMin) / totalDur) * spanDeg);

  const timeToInnerDeg = (t: number): number => {
    const tc = Math.max(tMin, Math.min(tMax, t));
    return degStart + ((tc - tMin) / totalDur) * spanDeg;
  };

  const timeToOuterDeg = (t: number): number => {
    if (t <= cleanKnots[0]) return knotOuterDeg[0];
    if (t >= cleanKnots[cleanKnots.length - 1]) return knotOuterDeg[knotOuterDeg.length - 1];
    let lo = 0;
    let hi = cleanKnots.length - 2;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < cleanKnots[mid]) hi = mid - 1;
      else if (t > cleanKnots[mid + 1]) lo = mid + 1;
      else {
        const span = cleanKnots[mid + 1] - cleanKnots[mid] || 1e-6;
        const frac = (t - cleanKnots[mid]) / span;
        return knotOuterDeg[mid] + frac * (knotOuterDeg[mid + 1] - knotOuterDeg[mid]);
      }
    }
    return knotOuterDeg[Math.min(lo, knotOuterDeg.length - 1)];
  };

  // Primary bamboo ribs aligned to word/speaker tier boundaries
  const ribTimesSet = new Set<number>([tMin, tMax]);
  const primaryTier = intervalTiers.length >= 2 ? intervalTiers[1] : intervalTiers[0];
  if (primaryTier) {
    for (const iv of primaryTier.intervals) {
      if (iv.xmax <= tMin + 1e-7 || iv.xmin >= tMax - 1e-7) continue;
      ribTimesSet.add(Number(Math.max(tMin, Math.min(tMax, iv.xmin)).toFixed(6)));
      ribTimesSet.add(Number(Math.max(tMin, Math.min(tMax, iv.xmax)).toFixed(6)));
    }
  }
  if (intervalTiers.length === 2) {
    for (const iv of intervalTiers[0].intervals) {
      if (iv.xmax <= tMin + 1e-7 || iv.xmin >= tMax - 1e-7) continue;
      ribTimesSet.add(Number(Math.max(tMin, Math.min(tMax, iv.xmin)).toFixed(6)));
      ribTimesSet.add(Number(Math.max(tMin, Math.min(tMax, iv.xmax)).toFixed(6)));
    }
  }
  if (ribTimesSet.size <= 2) {
    for (let k = 1; k < 10; k++) {
      ribTimesSet.add(tMin + (k / 10) * totalDur);
    }
  }

  const primaryRibTimes = Array.from(ribTimesSet)
    .filter((t) => t >= tMin && t <= tMax)
    .sort((a, b) => a - b);

  const filteredRibTimes: number[] = [primaryRibTimes[0]];
  for (let i = 1; i < primaryRibTimes.length - 1; i++) {
    const t = primaryRibTimes[i];
    const prev = filteredRibTimes[filteredRibTimes.length - 1];
    if (
      Math.abs(timeToOuterDeg(t) - timeToOuterDeg(prev)) >= 2.8 &&
      Math.abs(timeToOuterDeg(tMax) - timeToOuterDeg(t)) >= 1.5
    ) {
      filteredRibTimes.push(t);
    }
  }
  filteredRibTimes.push(tMax);

  // Build 1:1 true-duration cadence spans for inner rim + subtle silk warp bridge ribbons
  const cadenceSpans: FanCadenceSpan[] = [];
  if (intervalTiers.length > 0) {
    const isUmbrella =
      intervalTiers.length >= 3 &&
      intervalTiers[0].intervals.filter(
        (iv) => iv.xmax > tMin + 1e-7 && iv.xmin < tMax - 1e-7 && resolvePosterText(iv.text) !== ''
      ).length <= 1;

    if (isUmbrella || intervalTiers.length === 1) {
      const refIdx = isUmbrella ? 1 : 0;
      const refTier = intervalTiers[refIdx];
      let order = 0;
      for (const iv of refTier.intervals) {
        const a = Math.max(tMin, iv.xmin);
        const b = Math.min(tMax, iv.xmax);
        if (b <= a + 1e-7) continue;
        const isEmpty = resolvePosterText(iv.text) === '';
        cadenceSpans.push({
          a,
          b,
          tierIdx: refIdx,
          activeOrder: isEmpty ? -1 : order++,
          isEmpty
        });
      }
    } else {
      // Multi-speaker / parallel tier coverage (e.g., Speaker_A + Speaker_B)
      const candCount = Math.min(2, intervalTiers.length);
      const rawSpans: Array<{ a: number; b: number; tierIdx: number; ivIdx: number; isEmpty: boolean }> = [];
      for (const s of slices) {
        const mid = 0.5 * (s.t0 + s.t1);
        let chosenTier = -1;
        let chosenIv = -1;
        for (let k = 0; k < candCount; k++) {
          const ivIdx = intervalTiers[k].intervals.findIndex(
            (iv) => iv.xmin - 1e-6 <= mid && mid <= iv.xmax + 1e-6 && resolvePosterText(iv.text) !== ''
          );
          if (ivIdx >= 0) {
            chosenTier = k;
            chosenIv = ivIdx;
            break;
          }
        }
        const isEmpty = chosenTier < 0;
        const prev = rawSpans[rawSpans.length - 1];
        if (
          prev &&
          prev.isEmpty === isEmpty &&
          prev.tierIdx === chosenTier &&
          prev.ivIdx === chosenIv &&
          Math.abs(prev.b - s.t0) <= 1e-5
        ) {
          prev.b = s.t1;
        } else {
          rawSpans.push({ a: s.t0, b: s.t1, tierIdx: chosenTier, ivIdx: chosenIv, isEmpty });
        }
      }
      let order = 0;
      for (const sp of rawSpans) {
        cadenceSpans.push({
          a: sp.a,
          b: sp.b,
          tierIdx: sp.tierIdx,
          activeOrder: sp.isEmpty ? -1 : order++,
          isEmpty: sp.isEmpty
        });
      }
    }
  }

  const longSilences = slices.filter((s) => s.isLongSilence && !s.isEdgeSilence);

  return {
    xmin: tMin,
    xmax: tMax,
    totalDur,
    slices,
    cleanKnots,
    knotInnerDeg,
    knotOuterDeg,
    timeToInnerDeg,
    timeToOuterDeg,
    primaryRibTimes: filteredRibTimes,
    longSilences,
    cadenceSpans
  };
}

/**
 * Zero-<textPath> curved arc text placement along the upper fan arch (100% WebView2/Illustrator safe).
 * Automatically renders IPA graphemes inside mixed CJK/Latin strings with POSTER_IPA_STACK.
 */
function renderFanCurvedArcTextSvg(opts: {
  cx: number;
  cy: number;
  rMid: number;
  rThick: number;
  deg1: number;
  deg2: number;
  text: string;
  fontSize: number;
  fontWeight: string;
  fontFamily: string;
  fill: string;
  letterSpacing: number;
}): string {
  const { cx, cy, rMid, rThick, deg1, deg2, text, fontSize, fontWeight, fontFamily, fill, letterSpacing } = opts;
  if (!text) return '';
  const dSpan = deg2 - deg1;
  const padDeg = Math.min(1.15, dSpan * 0.06);
  const availArc = Math.max(14, rMid * degToRad(dSpan - 2 * padDeg) - 6);
  const degMid = 0.5 * (deg1 + deg2);

  let effSize = Math.min(fontSize, rThick * 0.68);
  let display = text;
  const baseCss = `${fontWeight} ${effSize.toFixed(1)}px ${fontFamily}`;
  const gsInit = splitGraphemes(text);
  const rawW = measurePx(text, baseCss) + Math.max(0, gsInit.length - 1) * letterSpacing;
  if (rawW > availArc && rawW > 0) {
    const ratio = availArc / rawW;
    if (ratio >= 0.64) {
      effSize = Math.max(8.4, effSize * ratio);
    } else {
      effSize = Math.max(8.0, effSize * 0.68);
      display = truncateByGraphemes(text, availArc, `${fontWeight} ${effSize.toFixed(1)}px ${fontFamily}`);
    }
  }

  const FULLWIDTH_PUNC_RE = /^[，。、！？；：]$/;
  const gs = splitGraphemes(display);
  const widths = gs.map((g) => {
    const gFont = IPA_GLYPH_RE.test(g) ? POSTER_IPA_STACK : fontFamily;
    const effCss = `${fontWeight} ${effSize.toFixed(1)}px ${gFont}`;
    if (g.trim() === '') return Math.max(effSize * 0.28, measurePx(' ', effCss));
    const measured = Math.max(effSize * 0.28, measurePx(g, effCss));
    return FULLWIDTH_PUNC_RE.test(g) ? measured * 0.72 : measured;
  });
  const totalW = widths.reduce((a, b) => a + b, 0) + Math.max(0, gs.length - 1) * letterSpacing;

  let cursor = 0;
  const out: string[] = [];
  for (let i = 0; i < gs.length; i++) {
    const g = gs[i];
    const gw = widths[i];
    const cxLocal = cursor + gw * 0.5;
    cursor += gw + letterSpacing;
    if (!g.trim()) continue;
    const s = cxLocal - totalW * 0.5;
    const dDeg = ((s / rMid) * 180) / Math.PI;
    const angDeg = degMid + dDeg;
    const rotDeg = angDeg + 90; // upright tangential along upper arch (-128°..+7°)
    const [px, py] = polarXY(cx, cy, rMid, angDeg);
    const gFont = IPA_GLYPH_RE.test(g) ? POSTER_IPA_STACK : fontFamily;
    out.push(
      `<text x="0" y="0" transform="translate(${fmtNum(px)} ${fmtNum(py)}) rotate(${fmtNum(rotDeg)})" font-family="${escapeXml(gFont)}" font-size="${fmtNum(effSize)}" font-weight="${fontWeight}" fill="${fill}" text-anchor="middle" dominant-baseline="central">${escapeXml(g)}</text>`
    );
  }
  return out.join('');
}

/**
 * Renders a sculpted Song/Ming bamboo outer master guard rib (`大骨`) with tapered shaft,
 * rounded handle extension behind the pivot, waist shoulder at the paper leaf edge,
 * and delicate sunlit bevel highlight.
 */
function renderBambooGuardRibSvg(opts: {
  cx: number;
  cy: number;
  deg: number;
  rHead: number;
  rSpecIn: number;
  rRimOut: number;
  sideSign: 1 | -1; // +1 for left guard (outward is CCW), -1 for right guard (outward is CW)
  gradId: string;
}): string {
  const { cx, cy, deg, rHead, rSpecIn, rRimOut, sideSign, gradId } = opts;
  const rad = degToRad(deg);
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  // Perpendicular pointing toward the exterior edge of the fan
  const nx = -uy * sideSign;
  const ny = ux * sideSign;

  const pt = (along: number, across: number): [number, number] => [
    cx + along * ux + across * nx,
    cy + along * uy + across * ny
  ];

  // Outer profile (exterior side) & inner profile (facing fan leaf)
  const tailA = pt(-rHead * 0.92, 2.2);
  const tailTip = pt(-rHead * 1.04, 0.0);
  const tailB = pt(-rHead * 0.92, -2.2);
  const pivOut = pt(0, 3.0);
  const pivIn = pt(0, -2.6);
  const waistOut = pt(rSpecIn - 2, 3.4);
  const waistIn = pt(rSpecIn - 2, -1.6);
  const leafStartOut = pt(rSpecIn + 5, 2.8);
  const leafStartIn = pt(rSpecIn + 5, -0.7);
  const tipOut = pt(rRimOut + 1.2, 2.1);
  const tipIn = pt(rRimOut + 1.2, -0.5);

  const d =
    `M ${fmtNum(tailTip[0])} ${fmtNum(tailTip[1])} ` +
    `Q ${fmtNum(tailA[0])} ${fmtNum(tailA[1])} ${fmtNum(pivOut[0])} ${fmtNum(pivOut[1])} ` +
    `L ${fmtNum(waistOut[0])} ${fmtNum(waistOut[1])} ` +
    `L ${fmtNum(leafStartOut[0])} ${fmtNum(leafStartOut[1])} ` +
    `L ${fmtNum(tipOut[0])} ${fmtNum(tipOut[1])} ` +
    `L ${fmtNum(tipIn[0])} ${fmtNum(tipIn[1])} ` +
    `L ${fmtNum(leafStartIn[0])} ${fmtNum(leafStartIn[1])} ` +
    `L ${fmtNum(waistIn[0])} ${fmtNum(waistIn[1])} ` +
    `L ${fmtNum(pivIn[0])} ${fmtNum(pivIn[1])} ` +
    `Q ${fmtNum(tailB[0])} ${fmtNum(tailB[1])} ${fmtNum(tailTip[0])} ${fmtNum(tailTip[1])} Z`;

  // Delicate ivory specular highlight running along the ridge of the bamboo guard
  const hi0 = pt(-rHead * 0.72, 0.7);
  const hi1 = pt(rSpecIn - 3, 1.3);
  const hi2 = pt(rRimOut - 2, 0.9);

  return (
    `<path d="${d}" fill="url(#${gradId})" stroke="${PAL.bambooDeep}" stroke-width="0.58" stroke-linejoin="round"/>` +
    `<polyline points="${fmtNum(hi0[0])},${fmtNum(hi0[1])} ${fmtNum(hi1[0])},${fmtNum(hi1[1])} ${fmtNum(hi2[0])},${fmtNum(hi2[1])}" fill="none" stroke="rgba(255,250,238,0.44)" stroke-width="0.65" stroke-linecap="round"/>`
  );
}

/**
 * Resolve outer-rim numbered medallion angles with smooth collision-avoidance so ZERO medallions
 * overlap even on dense 12–30 point tiers, while staying cleanly within [degStart+2.4, degEnd-2.4].
 */
function solveFanPointAngles(
  sortedPoints: Array<{ number: number; mark: string }>,
  scaleMap: FanScaleMap
): Array<{ idx: number; time: number; rawMark: string; mark: string; isBreak: boolean; trueDeg: number; badgeDeg: number }> {
  const { degStart, degEnd, rBadge } = FAN;
  const totalDeg = degEnd - degStart;
  const items = sortedPoints.map((pt, idx) => {
    const trueDeg = scaleMap.timeToOuterDeg(pt.number);
    return {
      idx,
      time: pt.number,
      rawMark: pt.mark,
      mark: resolvePosterText(pt.mark) || `P${idx + 1}`,
      isBreak: isBoundaryBreakMark(pt.mark),
      trueDeg,
      badgeDeg: Math.max(degStart + 2.4, Math.min(degEnd - 2.4, trueDeg))
    };
  });

  if (items.length >= 2) {
    const badgeR = items.length <= 16 ? 7.8 : 6.6;
    const geomMinSep = (((2 * badgeR + 5.2) / rBadge) * 180) / Math.PI;
    const minSep = Math.max(2.1, Math.min(geomMinSep, (totalDeg - 6.0) / Math.max(1, items.length * 1.05)));
    const loClamp = degStart + 2.2;
    const hiClamp = degEnd - 2.2;

    for (let iter = 0; iter < 42; iter++) {
      let moved = false;
      for (let i = 0; i < items.length - 1; i++) {
        const gap = items[i + 1].badgeDeg - items[i].badgeDeg;
        if (gap < minSep) {
          const push = (minSep - gap) * 0.52;
          items[i].badgeDeg = Math.max(loClamp, items[i].badgeDeg - push);
          items[i + 1].badgeDeg = Math.min(hiClamp, items[i + 1].badgeDeg + push);
          moved = true;
        }
      }
      for (let i = 1; i < items.length; i++) {
        if (items[i].badgeDeg < items[i - 1].badgeDeg + minSep) {
          items[i].badgeDeg = Math.min(hiClamp, items[i - 1].badgeDeg + minSep);
        }
      }
      for (let i = items.length - 2; i >= 0; i--) {
        if (items[i].badgeDeg > items[i + 1].badgeDeg - minSep) {
          items[i].badgeDeg = Math.max(loClamp, items[i + 1].badgeDeg - minSep);
        }
      }
      if (!moved) break;
    }
  }

  return items;
}

export function renderFoldingFanPosterSvg(params: RenderFoldingFanParams): {
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
    maxFreq,
    previewMode
  } = params;

  const isEmblem = config.framing === 'emblem_1_1';
  const trimW = 900.0;
  const trimH = isEmblem ? 900.0 : 1200.0;
  const bleed = config.includeBleed ? POSTER_BLEED_PT : 0;
  const widthPt = trimW + 2 * bleed;
  const heightPt = trimH + 2 * bleed;
  const idPfx = previewMode ? 'pv-ff-' : 'ex-ff-';
  const marginX = 56.0;

  const {
    cx,
    cy,
    degStart,
    degEnd,
    rHead,
    rCadenceIn,
    rCadenceOut,
    rSpecIn,
    rSpecOut,
    rBridgeOut,
    rLeafOut,
    rRimOut,
    rBadge
  } = FAN;

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
    : [];

  const scaleMap = buildFanDualScaleMap(intervalTiers, tMin, tMax);
  const resolvedPoints = solveFanPointAngles(sortedPoints, scaleMap);

  const nTiers = intervalTiers.length;
  const ringMeta = intervalTiers.map((tier, ti) => {
    const isIpa = isTierIpaLike(tier);
    const isPinyin = /拼音|pinyin|arpabet/i.test(tier.name || '');
    const style = getFanRingStyle(ti, nTiers, isIpa, isPinyin);
    let maxUnits = 0;
    for (const iv of tier.intervals) {
      if (iv.xmax <= tMin + 1e-7 || iv.xmin >= tMax - 1e-7) continue;
      const t = resolvePosterText(iv.text);
      if (t) maxUnits = Math.max(maxUnits, visualBaseUnits(t));
    }
    const isPhraseTier = !isIpa && !isPinyin && (maxUnits > 4.2 || nTiers <= 2);
    return { tier, isIpa, isPinyin, isPhraseTier, style };
  });

  // --------------------------------------------------------------------------
  // <defs>: Xuan paper vignette, bamboo shading, azurite brocade, jade pivot, spec clip
  // --------------------------------------------------------------------------
  const specClipD = sectorPathD(cx, cy, rSpecIn, rSpecOut, degStart, degEnd);
  const defs = [
    `<radialGradient id="${idPfx}xuan-bg" gradientUnits="userSpaceOnUse" cx="430" cy="480" r="820">`,
    `<stop offset="0%" stop-color="#FDFCF7"/>`,
    `<stop offset="68%" stop-color="${PAL.paper}"/>`,
    `<stop offset="100%" stop-color="${PAL.paperEdge}"/>`,
    `</radialGradient>`,
    `<radialGradient id="${idPfx}leaf-grad" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${rLeafOut}">`,
    `<stop offset="${fmtNum((rSpecIn / rLeafOut) * 100)}%" stop-color="#FAF7EF" stop-opacity="0.90"/>`,
    `<stop offset="${fmtNum(((rSpecIn + 0.36 * (rLeafOut - rSpecIn)) / rLeafOut) * 100)}%" stop-color="#FDFCF8" stop-opacity="0.97"/>`,
    `<stop offset="100%" stop-color="#F9F5EB" stop-opacity="0.99"/>`,
    `</radialGradient>`,
    `<radialGradient id="${idPfx}mist-base" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${rSpecIn + 20}">`,
    `<stop offset="${fmtNum((rSpecIn / (rSpecIn + 20)) * 100)}%" stop-color="#3E7C7E" stop-opacity="0.15"/>`,
    `<stop offset="100%" stop-color="#3E7C7E" stop-opacity="0"/>`,
    `</radialGradient>`,
    `<linearGradient id="${idPfx}brocade-grad" gradientUnits="userSpaceOnUse" x1="${cx - 320}" y1="${cy - 340}" x2="${cx + 420}" y2="${cy + 60}">`,
    `<stop offset="0%" stop-color="#225258"/>`,
    `<stop offset="48%" stop-color="${PAL.jadeRim}"/>`,
    `<stop offset="100%" stop-color="#1E4A50"/>`,
    `</linearGradient>`,
    `<linearGradient id="${idPfx}bamboo-guard" x1="0%" y1="100%" x2="100%" y2="0%">`,
    `<stop offset="0%" stop-color="#745B3B"/>`,
    `<stop offset="46%" stop-color="#A6875B"/>`,
    `<stop offset="78%" stop-color="#C8B18B"/>`,
    `<stop offset="100%" stop-color="#9A7E56"/>`,
    `</linearGradient>`,
    `<radialGradient id="${idPfx}bamboo-head" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy + 14}" r="${rHead + 8}">`,
    `<stop offset="0%" stop-color="#DFCBA8"/>`,
    `<stop offset="62%" stop-color="#B99C71"/>`,
    `<stop offset="100%" stop-color="#8B6F4B"/>`,
    `</radialGradient>`,
    `<radialGradient id="${idPfx}pivot-bezel" cx="35%" cy="30%" r="70%">`,
    `<stop offset="0%" stop-color="#C6A678"/>`,
    `<stop offset="55%" stop-color="#856945"/>`,
    `<stop offset="100%" stop-color="#523E26"/>`,
    `</radialGradient>`,
    `<radialGradient id="${idPfx}pivot-jade" cx="35%" cy="32%" r="70%">`,
    `<stop offset="0%" stop-color="#609B9C"/>`,
    `<stop offset="58%" stop-color="${PAL.jadeRim}"/>`,
    `<stop offset="100%" stop-color="#15373B"/>`,
    `</radialGradient>`,
    `<clipPath id="${idPfx}spec-clip"><path d="${specClipD}"/></clipPath>`
  ].join('');

  // --------------------------------------------------------------------------
  // #paper-bg (Xuan paper backdrop + natural mulberry fibers, omitted when transparent)
  // --------------------------------------------------------------------------
  const paperBgGroup =
    config.bgMode === 'transparent'
      ? ''
      : `<g id="paper-bg">` +
        `<rect x="${fmtNum(-bleed)}" y="${fmtNum(-bleed)}" width="${fmtNum(widthPt)}" height="${fmtNum(heightPt)}" fill="url(#${idPfx}xuan-bg)"/>` +
        `<path d="${renderXuanPaperFibersPath(trimW, trimH, bleed)}" fill="none" stroke="rgba(164,148,122,0.068)" stroke-width="0.45"/>` +
        `</g>`;

  // --------------------------------------------------------------------------
  // #fan-base (Ambient Shadow, Scalloped Bamboo Head, Fan Leaf Paper, Fold Pleats, Inner Time Ticks)
  // --------------------------------------------------------------------------
  const fanBaseParts: string[] = [];

  // Subtle ambient contact shadow beneath the open paper fan leaf (pure vector, zero blur filter)
  fanBaseParts.push(
    `<g transform="translate(2.2 4.2)">` +
      `<path d="${sectorPathD(cx, cy, rSpecIn, rRimOut, degStart, degEnd)}" fill="rgba(42,34,24,0.055)"/>` +
      `</g>`
  );

  // Fan leaf Xuan-silk substrate & atmospheric mist wash
  fanBaseParts.push(
    `<path d="${sectorPathD(cx, cy, rSpecIn, rLeafOut, degStart, degEnd)}" fill="url(#${idPfx}leaf-grad)"/>`,
    `<path d="${sectorPathD(cx, cy, rSpecIn, rSpecIn + 20, degStart, degEnd)}" fill="url(#${idPfx}mist-base)"/>`
  );

  // Alternating folded-paper pleat highlights along primary bamboo ribs
  const ribs = scaleMap.primaryRibTimes;
  for (let i = 0; i < ribs.length - 1; i++) {
    const d1 = scaleMap.timeToOuterDeg(ribs[i]);
    const d2 = scaleMap.timeToOuterDeg(ribs[i + 1]);
    const pleatFill = i % 2 === 0 ? 'rgba(255,255,252,0.36)' : 'rgba(176,160,132,0.048)';
    const pleatPath = sectorPathD(cx, cy, rBridgeOut, rLeafOut, d1, d2);
    if (pleatPath) fanBaseParts.push(`<path d="${pleatPath}" fill="${pleatFill}"/>`);
  }

  // Carved Scalloped Bamboo Head (`扇头`) behind Pivot with layered facets
  const headDeg1 = degStart + 180;
  const headDeg2 = degEnd + 180;
  const headRibCount = 11;
  let headWaveD = `M ${cx} ${cy}`;
  for (let i = 0; i <= headRibCount; i++) {
    const dA = headDeg1 + (i / headRibCount) * (headDeg2 - headDeg1);
    const [tx, ty] = polarXY(cx, cy, rHead, dA);
    if (i === 0) {
      headWaveD += ` L ${fmtNum(tx)} ${fmtNum(ty)}`;
    } else {
      const dPrev = headDeg1 + ((i - 0.5) / headRibCount) * (headDeg2 - headDeg1);
      const [mx, my] = polarXY(cx, cy, rHead + 5.2, dPrev);
      headWaveD += ` Q ${fmtNum(mx)} ${fmtNum(my)} ${fmtNum(tx)} ${fmtNum(ty)}`;
    }
  }
  headWaveD += ' Z';

  // Soft shadow under bamboo head
  fanBaseParts.push(
    `<g transform="translate(1.4 2.6)"><path d="${headWaveD}" fill="rgba(42,32,20,0.075)"/></g>`,
    `<path d="${headWaveD}" fill="url(#${idPfx}bamboo-head)" fill-opacity="0.46" stroke="${PAL.bambooDark}" stroke-width="0.95"/>`
  );
  // Subtle alternating bamboo stick shading inside the scalloped head
  for (let i = 0; i < headRibCount; i++) {
    const dA = headDeg1 + (i / headRibCount) * (headDeg2 - headDeg1);
    const dB = headDeg1 + ((i + 1) / headRibCount) * (headDeg2 - headDeg1);
    if (i % 2 === 0) {
      const [ax, ay] = polarXY(cx, cy, rHead, dA);
      const [bx, by] = polarXY(cx, cy, rHead, dB);
      fanBaseParts.push(
        `<path d="M ${cx} ${cy} L ${fmtNum(ax)} ${fmtNum(ay)} L ${fmtNum(bx)} ${fmtNum(by)} Z" fill="rgba(255,250,238,0.22)"/>`
      );
    }
    if (i > 0) {
      const [tx, ty] = polarXY(cx, cy, rHead, dA);
      fanBaseParts.push(
        `<line x1="${cx}" y1="${cy}" x2="${fmtNum(tx)}" y2="${fmtNum(ty)}" stroke="${PAL.bambooDark}" stroke-width="0.72" opacity="0.58"/>`
      );
    }
  }
  // Delicate inner collar arc on the bamboo head
  fanBaseParts.push(
    `<path d="${arcPathD(cx, cy, 18.5, headDeg1, headDeg2)}" fill="none" stroke="${PAL.bambooDeep}" stroke-width="0.65" opacity="0.42"/>`
  );

  // 1:1 True-Duration Inner Cadence Arc (`rCadenceIn..rCadenceOut`) — instant multi-speaker / word rhythm!
  if (scaleMap.cadenceSpans.length > 0) {
    for (const sp of scaleMap.cadenceSpans) {
      const d0 = scaleMap.timeToInnerDeg(sp.a);
      const d1 = scaleMap.timeToInnerDeg(sp.b);
      if (d1 - d0 <= 0.18) continue;
      let fill: string;
      if (sp.isEmpty) {
        fill = 'rgba(182,169,146,0.28)';
      } else if (nTiers === 2) {
        fill = ringMeta[sp.tierIdx]?.style.cadenceColor || PAL.jadeRim;
      } else {
        fill = sp.activeOrder % 2 === 0 ? PAL.jadeRim : PAL.bambooMid;
      }
      const p = sectorPathD(cx, cy, rCadenceIn, rCadenceOut, d0 + 0.08, d1 - 0.08);
      if (p) fanBaseParts.push(`<path d="${p}" fill="${fill}" opacity="${sp.isEmpty ? '0.65' : '0.86'}"/>`);
    }
  }

  // Inner true-time scale ticks along `rCadenceIn`
  const stepSec =
    scaleMap.totalDur <= 2.2
      ? 0.5
      : scaleMap.totalDur <= 5.5
        ? 0.5
        : scaleMap.totalDur <= 12.5
          ? 2.0
          : Math.ceil(scaleMap.totalDur / 6);
  const firstTick = Math.ceil((tMin + stepSec * 0.28) / stepSec) * stepSec;
  for (let t = firstTick; t < tMax - stepSec * 0.22; t += stepSec) {
    const deg = scaleMap.timeToInnerDeg(t);
    const [x1, y1] = polarXY(cx, cy, rCadenceIn - 4.2, deg);
    const [x2, y2] = polarXY(cx, cy, rCadenceIn, deg);
    const [tx, ty] = polarXY(cx, cy, rCadenceIn - 12.2, deg);
    const lbl = Math.abs(t - Math.round(t)) < 0.05 ? `${Math.round(t)}s` : `${t.toFixed(1)}s`;
    fanBaseParts.push(
      `<line x1="${fmtNum(x1)}" y1="${fmtNum(y1)}" x2="${fmtNum(x2)}" y2="${fmtNum(y2)}" stroke="#8F7858" stroke-width="0.72" opacity="0.72"/>`,
      `<text x="${fmtNum(tx)}" y="${fmtNum(ty)}" text-anchor="middle" dominant-baseline="central" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="7.6" fill="#7D6C54" opacity="0.88">${lbl}</text>`
    );
  }

  // Subtle frequency axis micro-ticks along right guard outer normal (`0k / mid / max`)
  if (hasAudio && config.showSpectrogram) {
    const rightNormRad = degToRad(degEnd + 90);
    const nx = Math.cos(rightNormRad);
    const ny = Math.sin(rightNormRad);
    const maxK = maxFreq / 1000;
    const midK = maxK * 0.5;
    for (const [frac, lbl] of [
      [0, '0k'],
      [0.5, Number.isInteger(midK) ? `${midK}k` : `${midK.toFixed(1)}k`],
      [1, Number.isInteger(maxK) ? `${maxK}k` : `${maxK.toFixed(1)}k`]
    ] as const) {
      const rf = rSpecIn + frac * (rSpecOut - rSpecIn);
      const [ex, ey] = polarXY(cx, cy, rf, degEnd);
      fanBaseParts.push(
        `<line x1="${fmtNum(ex + nx * 3.0)}" y1="${fmtNum(ey + ny * 3.0)}" x2="${fmtNum(ex + nx * 6.4)}" y2="${fmtNum(ey + ny * 6.4)}" stroke="#6F8C8C" stroke-width="0.65" opacity="0.75"/>`,
        `<text x="${fmtNum(ex + nx * 13.5)}" y="${fmtNum(ey + ny * 13.5)}" text-anchor="middle" dominant-baseline="central" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="6.4" fill="#6F7D79" opacity="0.85">${escapeXml(lbl)}</text>`
      );
    }
  }

  // --------------------------------------------------------------------------
  // #acoustic-traces (Mineral Ink-Wash Mountain Spectrogram + Distant/Near Ridges + Pitch + Silk Warp + Bamboo Ribs)
  // --------------------------------------------------------------------------
  const acousticParts: string[] = [];

  if (hasAudio && config.showSpectrogram && specMatrix) {
    const mistZones = scaleMap.longSilences.map((s) => ({
      u0: (s.t0 - scaleMap.xmin) / scaleMap.totalDur,
      u1: (s.t1 - scaleMap.xmin) / scaleMap.totalDur
    }));
    const fanRaster = renderFanSpectrogramRaster({
      spec: specMatrix,
      waveformBins: config.showWaveform ? waveformBins : null,
      cx,
      cy,
      degStart,
      degEnd,
      rSpecIn,
      rSpecOut,
      mistZones,
      previewMode
    });
    if (fanRaster?.dataUrl) {
      acousticParts.push(
        `<g clip-path="url(#${idPfx}spec-clip)">` +
          `<image x="${fmtNum(fanRaster.xPt)}" y="${fmtNum(fanRaster.yPt)}" width="${fmtNum(fanRaster.widthPt)}" height="${fmtNum(fanRaster.heightPt)}" href="${fanRaster.dataUrl}" preserveAspectRatio="none"/>` +
          `</g>`
      );
    }
  } else {
    // Graceful No-Audio / Spectrogram-off Song-style concentric celadon silk horizon rings
    for (const frac of [0.25, 0.5, 0.75]) {
      const rGuide = rSpecIn + frac * (rSpecOut - rSpecIn);
      acousticParts.push(
        `<path d="${arcPathD(cx, cy, rGuide, degStart, degEnd)}" fill="none" stroke="#89B1AE" stroke-width="0.55" stroke-dasharray="2.4 3.2" opacity="0.58"/>`
      );
    }
  }

  // Song Ink-Wash Layered Mountain Silhouettes & Ridge Line (from real waveformBins!)
  if (hasAudio && config.showWaveform && waveformBins && waveformBins.length >= 4) {
    const envLen = 220;
    const rawEnv = new Float32Array(envLen);
    let peak = 0.05;
    for (let i = 0; i < envLen; i++) {
      const wi = Math.min(waveformBins.length - 1, Math.floor((i / envLen) * waveformBins.length));
      const amp = Math.max(Math.abs(waveformBins[wi][0]), Math.abs(waveformBins[wi][1]));
      rawEnv[i] = amp;
      if (amp > peak) peak = amp;
    }
    const smoothEnv = new Float32Array(envLen);
    const farEnv = new Float32Array(envLen);
    for (let i = 0; i < envLen; i++) {
      let sum = 0;
      let wSum = 0;
      for (let k = -4; k <= 4; k++) {
        const idx = Math.max(0, Math.min(envLen - 1, i + k));
        const w = 5 - Math.abs(k);
        sum += (rawEnv[idx] / peak) * w;
        wSum += w;
      }
      smoothEnv[i] = sum / wSum;
      let fSum = 0;
      let fwSum = 0;
      for (let k = -9; k <= 9; k++) {
        const idx = Math.max(0, Math.min(envLen - 1, i + k));
        const w = 10 - Math.abs(k);
        fSum += (rawEnv[idx] / peak) * w;
        fwSum += w;
      }
      farEnv[i] = fSum / fwSum;
    }

    // Distant misty-jade mountain backdrop silhouette
    const farPts: string[] = [];
    for (let i = 0; i <= envLen - 1; i++) {
      const u = i / (envLen - 1);
      const deg = degStart + u * (degEnd - degStart);
      const rFar = rSpecIn + 12 + farEnv[i] * (rSpecOut - rSpecIn - 16);
      const [px, py] = polarXY(cx, cy, rFar, deg);
      farPts.push(`${i === 0 ? 'M' : 'L'}${fmtNum(px, 1)} ${fmtNum(py, 1)}`);
    }
    for (let i = envLen - 1; i >= 0; i--) {
      const u = i / (envLen - 1);
      const deg = degStart + u * (degEnd - degStart);
      const [px, py] = polarXY(cx, cy, rSpecIn, deg);
      farPts.push(`L${fmtNum(px, 1)} ${fmtNum(py, 1)}`);
    }
    acousticParts.push(`<path d="${farPts.join('')}Z" fill="rgba(72,129,131,0.068)"/>`);

    // Near mountain ink-wash body
    const fillPts: string[] = [];
    for (let i = 0; i <= envLen - 1; i++) {
      const u = i / (envLen - 1);
      const deg = degStart + u * (degEnd - degStart);
      const rCrest = rSpecIn + 5 + smoothEnv[i] * (rSpecOut - rSpecIn - 10);
      const [px, py] = polarXY(cx, cy, rCrest, deg);
      fillPts.push(`${i === 0 ? 'M' : 'L'}${fmtNum(px, 1)} ${fmtNum(py, 1)}`);
    }
    for (let i = envLen - 1; i >= 0; i--) {
      const u = i / (envLen - 1);
      const deg = degStart + u * (degEnd - degStart);
      const [px, py] = polarXY(cx, cy, rSpecIn, deg);
      fillPts.push(`L${fmtNum(px, 1)} ${fmtNum(py, 1)}`);
    }
    acousticParts.push(`<path d="${fillPts.join('')}Z" fill="rgba(45,102,107,0.105)"/>`);

    // Delicate ink ridge stroke broken cleanly over long silences
    const ridgeRuns: string[] = [];
    let curRun: string[] = [];
    for (let i = 0; i < envLen; i++) {
      const u = i / (envLen - 1);
      const t = scaleMap.xmin + u * scaleMap.totalDur;
      const inSil = scaleMap.longSilences.some((s) => t > s.t0 + 0.04 && t < s.t1 - 0.04);
      if (inSil || smoothEnv[i] < 0.022) {
        if (curRun.length >= 2) ridgeRuns.push(curRun.join(''));
        curRun = [];
        continue;
      }
      const deg = degStart + u * (degEnd - degStart);
      const rCrest = rSpecIn + 6 + smoothEnv[i] * (rSpecOut - rSpecIn - 10);
      const [px, py] = polarXY(cx, cy, rCrest, deg);
      curRun.push(`${curRun.length === 0 ? 'M' : 'L'}${fmtNum(px, 1)} ${fmtNum(py, 1)}`);
    }
    if (curRun.length >= 2) ridgeRuns.push(curRun.join(''));
    if (ridgeRuns.length > 0) {
      acousticParts.push(
        `<path d="${ridgeRuns.join('')}" fill="none" stroke="rgba(28,74,80,0.52)" stroke-width="1.05" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    }
  }

  // Optional F0 Pitch Cinnabar Hairline Overlay (luminous Xuan halo + cinnabar silk stroke)
  if (hasAudio && config.showPitch && f0Runs.length > 0) {
    for (const run of f0Runs) {
      const pts: string[] = [];
      for (const pt of run) {
        const deg = scaleMap.timeToInnerDeg(pt.t);
        const rF = rSpecIn + 9 + Math.max(0, Math.min(1, pt.normF0)) * (rSpecOut - rSpecIn - 17);
        const [px, py] = polarXY(cx, cy, rF, deg);
        pts.push(`${pts.length === 0 ? 'M' : 'L'}${fmtNum(px, 1)} ${fmtNum(py, 1)}`);
      }
      if (pts.length >= 2) {
        const d = pts.join('');
        acousticParts.push(
          `<path d="${d}" fill="none" stroke="${PAL.paper}" stroke-opacity="0.78" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
          `<path d="${d}" fill="none" stroke="${PAL.sealRed}" stroke-opacity="0.86" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/>`
        );
      }
    }
  }

  // Whisper-light tinted silk warp ribbons inside the dual-scale bridge (`rSpecOut..rBridgeOut`)
  if (nTiers > 0 && scaleMap.cadenceSpans.length > 0) {
    const rCp1 = rSpecOut + (rBridgeOut - rSpecOut) * 0.4;
    const rCp2 = rSpecOut + (rBridgeOut - rSpecOut) * 0.62;
    for (const sp of scaleMap.cadenceSpans) {
      if (sp.isEmpty) continue;
      const dl0 = scaleMap.timeToInnerDeg(sp.a);
      const dl1 = scaleMap.timeToInnerDeg(sp.b);
      const dv0 = scaleMap.timeToOuterDeg(sp.a);
      const dv1 = scaleMap.timeToOuterDeg(sp.b);
      if (dv1 - dv0 < 0.25) continue;
      const [p0sX, p0sY] = polarXY(cx, cy, rSpecOut, dl0);
      const [c1sX, c1sY] = polarXY(cx, cy, rCp1, dl0);
      const [c2sX, c2sY] = polarXY(cx, cy, rCp2, dv0);
      const [p3sX, p3sY] = polarXY(cx, cy, rBridgeOut, dv0);
      const [p3eX, p3eY] = polarXY(cx, cy, rBridgeOut, dv1);
      const [c2eX, c2eY] = polarXY(cx, cy, rCp2, dv1);
      const [c1eX, c1eY] = polarXY(cx, cy, rCp1, dl1);
      const [p0eX, p0eY] = polarXY(cx, cy, rSpecOut, dl1);
      const ribColor =
        nTiers === 2
          ? ringMeta[sp.tierIdx]?.style.cadenceColor || PAL.jadeRim
          : sp.activeOrder % 2 === 0
            ? PAL.jadeRim
            : PAL.bambooMid;
      const dRib =
        `M${fmtNum(p0sX)} ${fmtNum(p0sY)}` +
        `C${fmtNum(c1sX)} ${fmtNum(c1sY)} ${fmtNum(c2sX)} ${fmtNum(c2sY)} ${fmtNum(p3sX)} ${fmtNum(p3sY)}` +
        `A${fmtNum(rBridgeOut)} ${fmtNum(rBridgeOut)} 0 0 1 ${fmtNum(p3eX)} ${fmtNum(p3eY)}` +
        `C${fmtNum(c2eX)} ${fmtNum(c2eY)} ${fmtNum(c1eX)} ${fmtNum(c1eY)} ${fmtNum(p0eX)} ${fmtNum(p0eY)}` +
        `A${fmtNum(rSpecOut)} ${fmtNum(rSpecOut)} 0 0 0 ${fmtNum(p0sX)} ${fmtNum(p0sY)}Z`;
      acousticParts.push(`<path d="${dRib}" fill="${ribColor}" fill-opacity="0.065"/>`);
    }
  }

  // Dual-scale Bamboo Ribs (Tapered exposed bamboo sticks -> subtle spectrogram fold -> Bezier silk bridge -> outer leaf fold)
  ribs.forEach((t, idx) => {
    const isGuard = idx === 0 || idx === ribs.length - 1;
    if (isGuard) return; // Master guards rendered separately as sculpted bamboo blades

    const dIn = scaleMap.timeToInnerDeg(t);
    const dOut = scaleMap.timeToOuterDeg(t);

    const [pBaseX, pBaseY] = polarXY(cx, cy, 8, dIn);
    const [pStickEndX, pStickEndY] = polarXY(cx, cy, rSpecIn, dIn);
    const [s1x, s1y] = polarXY(cx, cy, rSpecOut, dIn);
    const [c1x, c1y] = polarXY(cx, cy, rSpecOut + 12, dIn);
    const [c2x, c2y] = polarXY(cx, cy, rBridgeOut - 12, dOut);
    const [b0x, b0y] = polarXY(cx, cy, rBridgeOut, dOut);
    const [l0x, l0y] = polarXY(cx, cy, rLeafOut, dOut);

    // Exposed bamboo stick (`r=8..rSpecIn`) with subtle bone thickness
    acousticParts.push(
      `<line x1="${fmtNum(pBaseX)}" y1="${fmtNum(pBaseY)}" x2="${fmtNum(pStickEndX)}" y2="${fmtNum(pStickEndY)}" stroke="${PAL.bambooDark}" stroke-width="1.05" stroke-opacity="0.56"/>`,
      // Delicate ghosted crease through the ink-wash mountain band (`rSpecIn..rSpecOut`)
      `<line x1="${fmtNum(pStickEndX)}" y1="${fmtNum(pStickEndY)}" x2="${fmtNum(s1x)}" y2="${fmtNum(s1y)}" stroke="${PAL.bambooMid}" stroke-width="0.72" stroke-opacity="0.34"/>`,
      // Smooth silk dual-scale bridge + outer fan-leaf fold (`rSpecOut..rLeafOut`)
      `<path d="M ${fmtNum(s1x)} ${fmtNum(s1y)} C ${fmtNum(c1x)} ${fmtNum(c1y)}, ${fmtNum(c2x)} ${fmtNum(c2y)}, ${fmtNum(b0x)} ${fmtNum(b0y)} L ${fmtNum(l0x)} ${fmtNum(l0y)}" fill="none" stroke="${PAL.bambooDark}" stroke-width="0.86" stroke-opacity="0.58"/>`,
      `<circle cx="${fmtNum(s1x)}" cy="${fmtNum(s1y)}" r="1.25" fill="${PAL.jadeRim}" opacity="0.62"/>`,
      `<circle cx="${fmtNum(b0x)}" cy="${fmtNum(b0y)}" r="1.25" fill="${PAL.bambooDark}" opacity="0.65"/>`
    );
  });

  // Secondary dashed bamboo bridge lines for syllable/sub-tier boundaries
  const syllableTier = intervalTiers.length >= 3 ? intervalTiers[2] : null;
  if (syllableTier) {
    for (const iv of syllableTier.intervals) {
      for (const rawT of [iv.xmin, iv.xmax]) {
        const t = Math.max(tMin, Math.min(tMax, rawT));
        if (ribs.some((pt) => Math.abs(pt - t) < 0.005)) continue;
        const dIn = scaleMap.timeToInnerDeg(t);
        const dOut = scaleMap.timeToOuterDeg(t);
        const [p1x, p1y] = polarXY(cx, cy, rSpecOut, dIn);
        const [c1x, c1y] = polarXY(cx, cy, rSpecOut + 11, dIn);
        const [c2x, c2y] = polarXY(cx, cy, rBridgeOut - 11, dOut);
        const [p2x, p2y] = polarXY(cx, cy, rBridgeOut, dOut);
        acousticParts.push(
          `<path d="M ${fmtNum(p1x)} ${fmtNum(p1y)} C ${fmtNum(c1x)} ${fmtNum(c1y)}, ${fmtNum(c2x)} ${fmtNum(c2y)}, ${fmtNum(p2x)} ${fmtNum(p2y)}" fill="none" stroke="#AE9878" stroke-width="0.62" stroke-dasharray="2.2 1.8" opacity="0.55"/>`
        );
      }
    }
  }

  // --------------------------------------------------------------------------
  // #annotation-layers (Ring Silk Washes, Pigment Fillets, Typography, Brocade Rim, Master Guards)
  // --------------------------------------------------------------------------
  const annotationParts: string[] = [];

  const ringWeights = intervalTiers.map((_, idx) =>
    nTiers >= 5 ? [0.88, 0.96, 1.0, 1.04, 1.12, 1.0][idx] || 1.0 : 1.0
  );
  const totalRingW = ringWeights.reduce((a, b) => a + b, 0) || 1;
  const leafSpan = rLeafOut - rBridgeOut;
  const ringBounds: Array<{ rIn: number; rOut: number; rMid: number }> = [];

  let rCursor = rBridgeOut;
  for (let i = 0; i < nTiers; i++) {
    const rNext =
      i === nTiers - 1 ? rLeafOut : rCursor + (ringWeights[i] / totalRingW) * leafSpan;
    ringBounds.push({ rIn: rCursor, rOut: rNext, rMid: 0.5 * (rCursor + rNext) });
    rCursor = rNext;
  }

  // 1. Multi-tier active cell mineral silk washes, inner pigment fillets & typography
  ringMeta.forEach(({ tier, isIpa, isPinyin, isPhraseTier, style }, ti) => {
    const { rIn, rOut, rMid } = ringBounds[ti];
    const rThick = rOut - rIn;
    const activeCnt = countActiveIntervals(tier, tMin, tMax);
    const isUtterance = ti === 0 && nTiers >= 2 && activeCnt <= 1;
    let activeCellCounter = 0;

    for (const iv of tier.intervals) {
      const a = Math.max(tMin, iv.xmin);
      const b = Math.min(tMax, iv.xmax);
      if (b <= a + 1e-6) continue;
      const d1 = scaleMap.timeToOuterDeg(a);
      const d2 = scaleMap.timeToOuterDeg(b);
      const dSpan = d2 - d1;
      if (dSpan <= 0.15) continue;

      if (!ribs.some((pt) => Math.abs(pt - a) < 0.004)) {
        const [ax, ay] = polarXY(cx, cy, rIn, d1);
        const [bx, by] = polarXY(cx, cy, rOut, d1);
        annotationParts.push(
          `<line x1="${fmtNum(ax)}" y1="${fmtNum(ay)}" x2="${fmtNum(bx)}" y2="${fmtNum(by)}" stroke="${PAL.bambooLight}" stroke-width="0.6" opacity="0.56"/>`
        );
      }

      const txt = resolvePosterText(iv.text);
      if (!txt) continue;

      const idxActive = activeCellCounter++;
      const gLen = splitGraphemes(txt).length;
      const isNarrowNuance =
        isIpa && ti === nTiers - 1 && !txt.includes(' ') && gLen <= 3 && hasCombiningMarks(txt);

      // Subtle mineral silk wash + crisp inner pigment fillet so every active tier has unmistakable visual identity.
      // For a continuous umbrella utterance band (e.g. a full poem/sentence in Ring 0), lay an opaque warm Xuan-silk
      // ribbon first so sub-tier bamboo ribs and pleats never slash across or bleach out the calligraphy!
      const cellPath = sectorPathD(cx, cy, rIn + 0.4, rOut - 0.4, d1 + 0.08, d2 - 0.08);
      if (cellPath) {
        if (isUtterance) {
          annotationParts.push(`<path d="${cellPath}" fill="#F4F0E5" opacity="0.96"/>`);
        }
        const cellFill = isNarrowNuance
          ? 'rgba(182,59,42,0.11)'
          : idxActive % 2 === 0
            ? style.cellFillEven
            : style.cellFillOdd;
        annotationParts.push(`<path d="${cellPath}" fill="${cellFill}"/>`);
      }

      const filletCol = isNarrowNuance ? PAL.sealRed : style.filletColor;
      const filletThick = isNarrowNuance ? 2.2 : style.filletThick;
      const filletPath = sectorPathD(cx, cy, rIn + 0.4, rIn + 0.4 + filletThick, d1 + 0.12, d2 - 0.12);
      if (filletPath) {
        annotationParts.push(
          `<path d="${filletPath}" fill="${filletCol}" opacity="${isNarrowNuance ? '0.86' : '0.78'}"/>`
        );
      }

      const dMid = 0.5 * (d1 + d2);
      const arcLenPx = rMid * degToRad(dSpan);
      const units = visualBaseUnits(txt);

      let fontFamily = POSTER_SERIF_STACK;
      let fontSize = nTiers <= 2 ? 14.2 : nTiers === 3 ? 13.6 : 13.2;
      let fill = isNarrowNuance ? PAL.sealDark : style.textColor;
      let fontWeight = '600';

      if (isIpa) {
        fontFamily = POSTER_IPA_STACK;
        fontSize = ti === nTiers - 1 ? 12.6 : 12.0;
        fontWeight = ti === nTiers - 1 ? '600' : '500';
      } else if (isPinyin) {
        fontFamily = POSTER_SANS_STACK;
        fontSize = txt.includes(' ') ? 10.0 : 11.2;
        fontWeight = '500';
      } else if (isUtterance) {
        fontSize = nTiers <= 3 ? 14.2 : 12.8;
        fontWeight = '500';
      }

      // Consistent calligraphy orientation:
      // - Dialogue / phrase tiers ALWAYS flow tangentially along the fan arch (so `明白!` matches `[chuckle] 呵哼，`)
      // - Atomic short tokens (single-char words, IPA phones) stay upright centered so combining marks stay crystal sharp
      const useCurvedArc = isUtterance || isPhraseTier || units > 2.8 || txt.includes(' ');
      if (!useCurvedArc) {
        const effBase = Math.min(fontSize, rThick * 0.68);
        const baseCss = `${fontWeight} ${effBase.toFixed(1)}px ${fontFamily}`;
        const measuredW = measurePx(txt, baseCss);
        const maxBoxW = Math.min(arcLenPx - 4, rThick * 0.92);
        let effSize = effBase;
        let display = txt;
        if (measuredW > maxBoxW && measuredW > 0) {
          const ratio = maxBoxW / measuredW;
          if (ratio >= 0.66) {
            effSize = Math.max(8.4, effBase * ratio);
          } else {
            effSize = Math.max(8.0, effBase * 0.68);
            display = truncateByGraphemes(
              txt,
              Math.max(8, maxBoxW),
              `${fontWeight} ${effSize.toFixed(1)}px ${fontFamily}`
            );
          }
        }
        const [px, py] = polarXY(cx, cy, rMid + filletThick * 0.5, dMid);
        annotationParts.push(
          `<text x="${fmtNum(px)}" y="${fmtNum(py)}" text-anchor="middle" dominant-baseline="central" font-family="${escapeXml(fontFamily)}" font-size="${fmtNum(effSize)}" font-weight="${fontWeight}" fill="${fill}">${escapeXml(display)}</text>`
        );
      } else {
        const opticalOutwardNudge = isIpa || isPinyin ? 0.6 : 1.5;
        annotationParts.push(
          renderFanCurvedArcTextSvg({
            cx,
            cy,
            rMid: rMid + filletThick * 0.5 + opticalOutwardNudge,
            rThick: Math.max(12, rThick - filletThick),
            deg1: d1,
            deg2: d2,
            text: txt,
            fontSize,
            fontWeight,
            fontFamily,
            fill,
            letterSpacing: isUtterance ? (units <= 16 ? 2.4 : 1.1) : nTiers <= 2 ? 0.35 : 0.2
          })
        );
      }
    }
  });

  // 2. Long Silence Mist Bands + Refined '//' Marks
  for (const s of scaleMap.longSilences) {
    const dInMid = 0.5 * (scaleMap.timeToInnerDeg(s.t0) + scaleMap.timeToInnerDeg(s.t1));
    const dOut1 = scaleMap.timeToOuterDeg(s.t0);
    const dOut2 = scaleMap.timeToOuterDeg(s.t1);
    const dOutMid = 0.5 * (dOut1 + dOut2);
    const mistSec = sectorPathD(cx, cy, rBridgeOut, rLeafOut, dOut1, dOut2);
    if (mistSec) {
      annotationParts.push(`<path d="${mistSec}" fill="${PAL.paper}" fill-opacity="0.72"/>`);
    }
    const [mix, miy] = polarXY(cx, cy, 0.5 * (rSpecIn + rSpecOut), dInMid);
    const [mox, moy] = polarXY(cx, cy, 0.5 * (rBridgeOut + rLeafOut), dOutMid);
    annotationParts.push(
      `<text x="${fmtNum(mix)}" y="${fmtNum(miy)}" text-anchor="middle" dominant-baseline="central" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="9.6" fill="#5D8384" opacity="0.66">//</text>`,
      `<text x="${fmtNum(mox)}" y="${fmtNum(moy)}" text-anchor="middle" dominant-baseline="central" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="10.2" fill="#A2937C" opacity="0.68">//</text>`
    );
  }

  // 3. Concentric Fan Arcs & Double-Trimmed Azurite Brocade Outer Rim (`石青锦边`)
  annotationParts.push(
    `<path d="${arcPathD(cx, cy, rSpecIn, degStart, degEnd)}" fill="none" stroke="${PAL.bambooDark}" stroke-width="0.95" opacity="0.75"/>`,
    `<path d="${arcPathD(cx, cy, rSpecOut, degStart, degEnd)}" fill="none" stroke="#5A8385" stroke-width="0.85" opacity="0.72"/>`,
    `<path d="${arcPathD(cx, cy, rBridgeOut, degStart, degEnd)}" fill="none" stroke="${PAL.bambooDark}" stroke-width="0.95" opacity="0.76"/>`
  );
  for (let i = 0; i < nTiers - 1; i++) {
    annotationParts.push(
      `<path d="${arcPathD(cx, cy, ringBounds[i].rOut, degStart, degEnd)}" fill="none" stroke="#B09D80" stroke-width="0.72" opacity="0.66"/>`
    );
  }
  // Delicate golden-ochre silk inner trim + azurite brocade band + outer deep-jade hairline
  annotationParts.push(
    `<path d="${sectorPathD(cx, cy, rLeafOut - 1.5, rLeafOut, degStart, degEnd)}" fill="#C9AE7E" opacity="0.78"/>`,
    `<path d="${sectorPathD(cx, cy, rLeafOut, rRimOut, degStart, degEnd)}" fill="url(#${idPfx}brocade-grad)" opacity="0.94"/>`,
    `<path d="${arcPathD(cx, cy, rLeafOut, degStart, degEnd)}" fill="none" stroke="#183F44" stroke-width="0.6" opacity="0.58"/>`,
    `<path d="${arcPathD(cx, cy, rRimOut, degStart, degEnd)}" fill="none" stroke="#16393E" stroke-width="0.7" opacity="0.75"/>`
  );

  // 4. Sculpted Master Bamboo Guard Ribs (`左右大骨`) framing the fan cleanly
  annotationParts.push(
    renderBambooGuardRibSvg({
      cx,
      cy,
      deg: degStart,
      rHead,
      rSpecIn,
      rRimOut,
      sideSign: -1,
      gradId: `${idPfx}bamboo-guard`
    }),
    renderBambooGuardRibSvg({
      cx,
      cy,
      deg: degEnd,
      rHead,
      rSpecIn,
      rRimOut,
      sideSign: 1,
      gradId: `${idPfx}bamboo-guard`
    })
  );

  // 5. Left-edge refined Song-style tier index + name guides along left guard outer normal
  const pushRingGuide = (rCenter: number, idxLabel: string | null, text: string, color: string) => {
    const [ex, ey] = polarXY(cx, cy, rCenter, degStart);
    const normalRad = degToRad(degStart - 90);
    const nx = Math.cos(normalRad);
    const ny = Math.sin(normalRad);
    const gx = ex + nx * 12.5;
    const gy = ey + ny * 12.5;
    const tickX0 = ex + nx * 3.8;
    const tickY0 = ey + ny * 3.8;
    const tickX1 = ex + nx * 8.2;
    const tickY1 = ey + ny * 8.2;
    const maxW = Math.max(40, gx - 28);
    const fullLabel = idxLabel ? `${idxLabel} ${text}` : text;
    const shortLbl = truncateByGraphemes(fullLabel, maxW, `500 9.6px ${POSTER_SERIF_STACK}`);
    annotationParts.push(
      `<line x1="${fmtNum(tickX0)}" y1="${fmtNum(tickY0)}" x2="${fmtNum(tickX1)}" y2="${fmtNum(tickY1)}" stroke="${color}" stroke-width="0.75" opacity="0.65"/>`,
      `<text x="${fmtNum(gx)}" y="${fmtNum(gy)}" text-anchor="end" dominant-baseline="central" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="9.6" font-weight="500" letter-spacing="0.3" fill="${color}">${escapeXml(shortLbl)}</text>`
    );
  };
  pushRingGuide(
    0.5 * (rSpecIn + rSpecOut),
    null,
    hasAudio && config.showSpectrogram ? '青绿声谱' : '时序弧度',
    PAL.jadeRim
  );
  ringMeta.forEach(({ tier, style }, ti) => {
    pushRingGuide(
      ringBounds[ti].rMid,
      String(ti + 1).padStart(2, '0'),
      tier.name || `第 ${ti + 1} 层`,
      style.guideColor
    );
  });
  if (pointTier) {
    pushRingGuide(
      rRimOut + 2,
      String(nTiers + 1).padStart(2, '0'),
      pointTier.name || '标点',
      PAL.sealRed
    );
  }

  // --------------------------------------------------------------------------
  // #point-markers (Outer Rim Numbered Scholarly Seal Medallions + Carved Jade/Brass Pivot Rivet)
  // --------------------------------------------------------------------------
  const pointParts: string[] = [];
  if (resolvedPoints.length > 0) {
    const badgeR = resolvedPoints.length <= 16 ? 7.8 : 6.6;
    const numFs = resolvedPoints.length >= 100 ? 6.2 : resolvedPoints.length <= 16 ? 7.6 : 6.7;

    for (const pt of resolvedPoints) {
      const pigment = POINT_PIGMENT_CYCLE[pt.idx % POINT_PIGMENT_CYCLE.length];
      const [ax, ay] = polarXY(cx, cy, rRimOut + 0.8, pt.trueDeg);
      const [s0x, s0y] = polarXY(cx, cy, rRimOut + 3.2, pt.trueDeg);
      const [s1x, s1y] = polarXY(cx, cy, rBadge - badgeR - 1.2, pt.badgeDeg);
      const [bx, by] = polarXY(cx, cy, rBadge, pt.badgeDeg);

      pointParts.push(
        `<circle cx="${fmtNum(ax)}" cy="${fmtNum(ay)}" r="2.3" fill="${pigment}" stroke="${PAL.paperHi}" stroke-width="0.9"/>`,
        `<line x1="${fmtNum(s0x)}" y1="${fmtNum(s0y)}" x2="${fmtNum(s1x)}" y2="${fmtNum(s1y)}" stroke="${pigment}" stroke-opacity="0.62" stroke-width="0.78"/>`,
        ...(pt.isBreak
          ? [
              `<circle cx="${fmtNum(bx)}" cy="${fmtNum(by)}" r="${fmtNum(badgeR + 1.7)}" fill="none" stroke="${pigment}" stroke-opacity="0.46" stroke-width="0.65"/>`
            ]
          : []),
        `<circle cx="${fmtNum(bx)}" cy="${fmtNum(by)}" r="${fmtNum(badgeR)}" fill="${pigment}"/>`,
        `<circle cx="${fmtNum(bx)}" cy="${fmtNum(by)}" r="${fmtNum(badgeR - 1.5)}" fill="none" stroke="${PAL.paperHi}" stroke-opacity="0.34" stroke-width="0.45"/>`,
        `<text x="${fmtNum(bx)}" y="${fmtNum(by)}" text-anchor="middle" dominant-baseline="central" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="${fmtNum(numFs)}" font-weight="800" fill="${PAL.paperHi}">${pt.idx + 1}</text>`
      );
    }
  }

  // Carved Ox-Horn / Aged Brass & Celadon Jade Pivot Rivet (`扇钉`)
  pointParts.push(
    `<circle cx="${fmtNum(cx + 0.9)}" cy="${fmtNum(cy + 1.4)}" r="8.8" fill="rgba(36,28,18,0.14)"/>`,
    `<circle cx="${cx}" cy="${cy}" r="8.2" fill="url(#${idPfx}pivot-bezel)" stroke="#473620" stroke-width="0.75"/>`,
    `<circle cx="${cx}" cy="${cy}" r="5.3" fill="#E3CFA9" stroke="#7A603E" stroke-width="0.5"/>`,
    `<circle cx="${cx}" cy="${cy}" r="3.0" fill="url(#${idPfx}pivot-jade)" stroke="#16393D" stroke-width="0.4"/>`,
    `<circle cx="${fmtNum(cx - 0.95)}" cy="${fmtNum(cy - 0.95)}" r="0.85" fill="#FAF7EF" opacity="0.82"/>`
  );

  // --------------------------------------------------------------------------
  // #editorial-copy (Upper-Left Song/Ming Title + Seal + Top-Right Colophon + Bottom 2-Zone Directory)
  // --------------------------------------------------------------------------
  let editorialGroup = '';
  if (!isEmblem && !config.pureVisual) {
    const totalLayers = nTiers + (pointTier ? 1 : 0);
    const titleStr = truncateByGraphemes(
      config.copy.title.trim() || autoCopy.title,
      460,
      `600 52px ${POSTER_SERIF_STACK}`
    );
    const subStr = truncateByGraphemes(
      config.copy.subtitle.trim() || autoCopy.subtitle,
      590,
      `400 13.8px ${POSTER_SERIF_STACK}`
    );
    const footStr = config.copy.footer.trim() || autoCopy.footer;

    const titleGs = splitGraphemes(titleStr);
    const titleMeasuredW =
      measurePx(titleStr, `600 54px ${POSTER_SERIF_STACK}`) + Math.max(0, titleGs.length - 1) * 7.5;
    const sealX = Math.min(720, Math.max(132, marginX + titleMeasuredW + 18));

    const edParts: string[] = [
      // Upper-left Song/Ming calligraphy title lockup
      `<text x="${marginX}" y="112" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="54" font-weight="600" letter-spacing="8" fill="${PAL.inkDeep}">${escapeXml(titleStr)}</text>`,
      // Refined Song/Ming Carved Cinnabar White-Text Seal Stamp 「听竹」
      `<g transform="translate(${fmtNum(sealX)}, 71)">` +
        `<path d="M 3.2,1.1 L 25.4,0.8 C 27.2,0.9 28.1,2.0 28.2,3.9 L 28.0,36.6 C 27.8,38.4 26.8,39.4 24.9,39.6 L 3.8,39.3 C 1.8,39.1 0.9,38.0 0.8,36.0 L 1.0,3.8 C 1.1,2.0 1.9,1.2 3.2,1.1 Z" fill="${PAL.sealRed}" opacity="0.93"/>` +
        // Subtle hand-carved inner border with organic vintage ink-stone breaks
        `<path d="M 3.9,4.0 L 24.7,4.0 L 24.7,36.0 L 3.9,36.0 Z" fill="none" stroke="${PAL.paperHi}" stroke-width="0.72" stroke-dasharray="17 1.5 11 1.3 15 1.6" opacity="0.76"/>` +
        // Delicate stone-paste speckles on the outer rim for tactile stamped feel
        `<circle cx="2.2" cy="14.5" r="0.55" fill="${PAL.paper}" opacity="0.45"/>` +
        `<circle cx="26.5" cy="28.2" r="0.6" fill="${PAL.paper}" opacity="0.4"/>` +
        `<circle cx="15.0" cy="1.8" r="0.45" fill="${PAL.paper}" opacity="0.38"/>` +
        // Authentic vertically stacked classical Song serif glyphs 「听 / 竹」
        `<g transform="translate(14.3, 12.8) scale(0.92, 1.04)">` +
          `<text x="0" y="0" text-anchor="middle" dominant-baseline="central" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="13.8" font-weight="700" fill="${PAL.paperHi}">听</text>` +
        `</g>` +
        `<g transform="translate(14.3, 27.6) scale(0.92, 1.04)">` +
          `<text x="0" y="0" text-anchor="middle" dominant-baseline="central" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="13.8" font-weight="700" fill="${PAL.paperHi}">竹</text>` +
        `</g>` +
        `</g>`,
      `<text x="${marginX + 2}" y="150" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="13.8" letter-spacing="0.9" fill="#635B50">${escapeXml(subStr)}</text>`,

      // Top-right Song/Ming archival colophon balancing the composition
      `<text x="${trimW - marginX}" y="76" text-anchor="end" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="9.4" font-weight="500" letter-spacing="1.4" fill="${PAL.inkSoft}">${escapeXml(autoCopy.sideLabel)}</text>`,
      `<rect x="${trimW - marginX - 66}" y="86" width="48" height="1.7" fill="${PAL.jadeRim}" opacity="0.82"/>`,
      `<rect x="${trimW - marginX - 15}" y="86" width="15" height="1.7" fill="${PAL.bambooMid}" opacity="0.82"/>`,
      `<text x="${trimW - marginX}" y="101" text-anchor="end" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="7.3" letter-spacing="0.6" fill="#928778">${totalLayers > 0 ? `${String(totalLayers).padStart(2, '0')} LAYERS` : 'ACOUSTIC FAN'}  ·  ${hasAudio ? `0–${(maxFreq / 1000).toFixed(0)} kHz` : 'TEXTGRID ONLY'}</text>`
    ];

    // ------------------------------------------------------------------------
    // Bottom Two-Zone Song/Ming Scholarly Annotation Directory (`ySec = 876`)
    // ------------------------------------------------------------------------
    const ySec = 876.0;
    const lx0 = marginX;
    const leftEndX = 308.0;

    // Left Zone Header
    edParts.push(
      `<rect x="${lx0}" y="${ySec}" width="42" height="2.4" fill="${PAL.jadeRim}"/>`,
      `<rect x="${lx0 + 45}" y="${ySec}" width="11" height="2.4" fill="${PAL.bambooMid}"/>`,
      `<text x="${lx0}" y="${ySec + 18}" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="10.4" font-weight="700" letter-spacing="0.7" fill="${PAL.inkDeep}">${totalLayers > 0 ? `${totalLayers} 层拆解  ·  由内向外` : '扇面声学  ·  由内向外'}</text>`
    );

    // Left Zone Tier Legend Rows (swatches 1:1 with each fan ring's actual Song/Ming pigment)
    const tierRowStep = totalLayers >= 7 ? 18.2 : 20.2;
    ringMeta.forEach(({ tier, style }, i) => {
      const ry = ySec + 39.0 + i * tierRowStep;
      const cnt = countActiveIntervals(tier, tMin, tMax);
      const swStroke =
        style.swatchStroke !== 'none'
          ? ` stroke="${style.swatchStroke}" stroke-width="0.8"`
          : '';
      edParts.push(
        `<rect x="${lx0}" y="${fmtNum(ry - 4.5)}" width="9" height="9" rx="1.2" fill="${style.swatchFill}"${swStroke}/>`,
        `<text x="${lx0 + 15}" y="${fmtNum(ry)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="7.6" font-weight="700" fill="${PAL.inkSoft}" dominant-baseline="central">${String(i + 1).padStart(2, '0')}</text>`,
        `<text x="${lx0 + 34}" y="${fmtNum(ry)}" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="8.6" font-weight="600" fill="${PAL.inkDeep}" dominant-baseline="central">${escapeXml(truncateByGraphemes(tier.name || `第 ${i + 1} 层`, 132, `600 8.6px ${POSTER_SERIF_STACK}`))}</text>`,
        `<text x="${leftEndX}" y="${fmtNum(ry)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.4" fill="${PAL.inkSoft}" text-anchor="end" dominant-baseline="central">${cnt} 个区间</text>`
      );
    });
    if (pointTier) {
      const ry = ySec + 39.0 + nTiers * tierRowStep;
      edParts.push(
        `<circle cx="${lx0 + 4.5}" cy="${fmtNum(ry)}" r="4.5" fill="${PAL.sealRed}"/>`,
        `<text x="${lx0 + 15}" y="${fmtNum(ry)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="7.6" font-weight="700" fill="${PAL.inkSoft}" dominant-baseline="central">${String(nTiers + 1).padStart(2, '0')}</text>`,
        `<text x="${lx0 + 34}" y="${fmtNum(ry)}" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="8.6" font-weight="600" fill="${PAL.inkDeep}" dominant-baseline="central">${escapeXml(truncateByGraphemes(pointTier.name || '标点', 132, `600 8.6px ${POSTER_SERIF_STACK}`))}</text>`,
        `<text x="${leftEndX}" y="${fmtNum(ry)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.4" fill="${PAL.inkSoft}" text-anchor="end" dominant-baseline="central">${resolvedPoints.length} 个标点</text>`
      );
    }

    // Left Zone Hairline Divider + Concise Acoustic Key
    const minNoteY = totalLayers <= 3 ? ySec + 112.0 : totalLayers === 4 ? ySec + 130.0 : ySec + 154.0;
    const noteLineY = Math.max(minNoteY, ySec + 39.0 + (totalLayers + 0.3) * tierRowStep);
    const acousticDesc = hasAudio
      ? `0–${(maxFreq / 1000).toFixed(0)} kHz 青绿频谱 · 朱砂基频 · 远山轮廓`
      : '纯宣纸时序扇面（未载入录音）';
    edParts.push(
      `<line x1="${lx0}" y1="${fmtNum(noteLineY)}" x2="${leftEndX}" y2="${fmtNum(noteLineY)}" stroke="${PAL.paperRule}" stroke-width="0.65"/>`,
      `<text x="${lx0}" y="${fmtNum(noteLineY + 15)}" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="7.8" font-weight="700" fill="${PAL.inkDeep}" dominant-baseline="central">扇面声景</text>`,
      `<text x="${lx0 + 46}" y="${fmtNum(noteLineY + 15)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.3" fill="${PAL.inkSoft}" dominant-baseline="central">${escapeXml(acousticDesc)}</text>`,
      `<text x="${lx0}" y="${fmtNum(noteLineY + 32.5)}" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="7.8" font-weight="700" fill="${PAL.inkDeep}" dominant-baseline="central">竹骨连线</text>`,
      `<text x="${lx0 + 46}" y="${fmtNum(noteLineY + 32.5)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.3" fill="${PAL.inkSoft}" dominant-baseline="central">连接内弧物理时长与外弧自适应字格</text>`
    );

    // Right Zone (`x = 340..844`): 2-Column Numbered Scholarly Directory
    const rx0 = 340.0;
    const colGap = 20.0;
    const colW = (trimW - marginX - rx0 - colGap) * 0.5; // 242.0 pt
    const maxRows = 30;

    if (resolvedPoints.length > 0) {
      const shownPts = resolvedPoints.slice(0, maxRows);
      const overflow = resolvedPoints.length - shownPts.length;
      const half = Math.ceil(shownPts.length / 2);
      const rowStep =
        half <= 5
          ? 29.5
          : half === 6
            ? 26.8
            : Math.max(13.8, Math.min(23.5, 194.0 / Math.max(1, half - 1)));
      const badgeR = shownPts.length <= 16 ? 7.3 : 5.8;
      const rowFs = shownPts.length <= 16 ? 7.8 : 6.7;

      edParts.push(
        `<rect x="${rx0}" y="${ySec}" width="62" height="2.4" fill="${PAL.sealRed}"/>`,
        `<text x="${rx0}" y="${ySec + 18}" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="10.4" font-weight="700" letter-spacing="0.6" fill="${PAL.inkDeep}">${escapeXml(pointTier?.name || '标记点')}  ·  01–${String(resolvedPoints.length).padStart(2, '0')}${overflow > 0 ? ` (+${overflow})` : ''}</text>`,
        `<text x="${trimW - marginX}" y="${ySec + 18}" text-anchor="end" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="7.2" fill="#928778">${tMin.toFixed(2)} – ${tMax.toFixed(2)}s</text>`
      );

      for (let i = 0; i < shownPts.length; i++) {
        const pt = shownPts[i];
        const colI = i < half ? 0 : 1;
        const rowI = i < half ? i : i - half;
        const cxCol = rx0 + colI * (colW + colGap);
        const ey = ySec + 41.0 + rowI * rowStep;
        const pigment = POINT_PIGMENT_CYCLE[pt.idx % POINT_PIGMENT_CYCLE.length];
        const note = (config.copy.pointNotes[String(pt.idx)] || '').trim();

        if (rowI > 0) {
          edParts.push(
            `<line x1="${fmtNum(cxCol)}" y1="${fmtNum(ey - rowStep * 0.5)}" x2="${fmtNum(cxCol + colW)}" y2="${fmtNum(ey - rowStep * 0.5)}" stroke="${PAL.paperRule}" stroke-width="0.55"/>`
          );
        }
        edParts.push(
          `<circle cx="${fmtNum(cxCol + 7.5)}" cy="${fmtNum(ey)}" r="${fmtNum(badgeR)}" fill="${pigment}"/>`,
          `<circle cx="${fmtNum(cxCol + 7.5)}" cy="${fmtNum(ey)}" r="${fmtNum(badgeR - 1.4)}" fill="none" stroke="${PAL.paperHi}" stroke-opacity="0.32" stroke-width="0.42"/>`,
          `<text x="${fmtNum(cxCol + 7.5)}" y="${fmtNum(ey)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="${fmtNum(rowFs - 0.4)}" font-weight="800" fill="${PAL.paperHi}" text-anchor="middle" dominant-baseline="central">${pt.idx + 1}</text>`,
          `<text x="${fmtNum(cxCol + 51)}" y="${fmtNum(ey)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="${fmtNum(rowFs - 0.4)}" fill="${PAL.inkSoft}" text-anchor="end" dominant-baseline="central">${pt.time.toFixed(2)}s</text>`,
          `<text x="${fmtNum(cxCol + 59)}" y="${fmtNum(ey)}" font-family="${escapeXml(POSTER_IPA_STACK)}" font-size="${fmtNum(rowFs)}" font-weight="600" fill="${PAL.inkDeep}" dominant-baseline="central">${escapeXml(truncateByGraphemes(pt.mark, note ? 80 : colW - 60, `600 ${rowFs}px ${POSTER_IPA_STACK}`))}</text>`
        );
        if (note) {
          edParts.push(
            `<text x="${fmtNum(cxCol + colW)}" y="${fmtNum(ey)}" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="${fmtNum(rowFs)}" fill="${PAL.inkMid}" text-anchor="end" dominant-baseline="central">${escapeXml(truncateByGraphemes(note, 98, `400 ${rowFs}px ${POSTER_SERIF_STACK}`))}</text>`
          );
        }
      }
    } else if (nTiers > 0) {
      // Clean 2-column primary-tier temporal index when no point tier is selected
      interface TemporalIndexItem {
        xmin: number;
        xmax: number;
        text: string;
        pigment: string;
      }
      const items: TemporalIndexItem[] = [];
      let heading = '';

      if (nTiers === 2) {
        heading = '双人对白  ·  时序索引';
        for (let k = 0; k < 2; k++) {
          const pig = ringMeta[k].style.swatchFill;
          for (const iv of intervalTiers[k].intervals) {
            if (iv.xmax <= tMin + 1e-7 || iv.xmin >= tMax - 1e-7) continue;
            const txt = resolvePosterText(iv.text);
            if (!txt) continue;
            items.push({ xmin: Math.max(tMin, iv.xmin), xmax: Math.min(tMax, iv.xmax), text: txt, pigment: pig });
          }
        }
        items.sort((a, b) => a.xmin - b.xmin);
      } else {
        const srcIdx = Math.min(1, nTiers - 1);
        const srcTier = intervalTiers[srcIdx];
        heading = `${srcTier.name || '主层级'}  ·  时序索引`;
        let order = 0;
        for (const iv of srcTier.intervals) {
          if (iv.xmax <= tMin + 1e-7 || iv.xmin >= tMax - 1e-7) continue;
          const txt = resolvePosterText(iv.text);
          if (!txt) continue;
          const pig = order++ % 2 === 0 ? PAL.jadeRim : PAL.bambooMid;
          items.push({ xmin: Math.max(tMin, iv.xmin), xmax: Math.min(tMax, iv.xmax), text: txt, pigment: pig });
        }
      }

      const shown = items.slice(0, 14);
      const overflow = items.length - shown.length;
      const half = Math.ceil(shown.length / 2);
      const rowStep = half <= 5 ? 29.0 : 25.0;

      edParts.push(
        `<rect x="${rx0}" y="${ySec}" width="62" height="2.4" fill="${PAL.sealRed}"/>`,
        `<text x="${rx0}" y="${ySec + 18}" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="10.4" font-weight="700" letter-spacing="0.6" fill="${PAL.inkDeep}">${escapeXml(heading)}${overflow > 0 ? ` (+${overflow})` : ''}</text>`,
        `<text x="${trimW - marginX}" y="${ySec + 18}" text-anchor="end" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="7.2" fill="#928778">${tMin.toFixed(2)} – ${tMax.toFixed(2)}s</text>`
      );

      for (let i = 0; i < shown.length; i++) {
        const item = shown[i];
        const colI = i < half ? 0 : 1;
        const rowI = i < half ? i : i - half;
        const cxCol = rx0 + colI * (colW + colGap);
        const ey = ySec + 41.0 + rowI * rowStep;

        if (rowI > 0) {
          edParts.push(
            `<line x1="${fmtNum(cxCol)}" y1="${fmtNum(ey - rowStep * 0.5)}" x2="${fmtNum(cxCol + colW)}" y2="${fmtNum(ey - rowStep * 0.5)}" stroke="${PAL.paperRule}" stroke-width="0.55"/>`
          );
        }
        edParts.push(
          `<rect x="${fmtNum(cxCol)}" y="${fmtNum(ey - 6.5)}" width="13" height="13" rx="1.6" fill="${item.pigment}"/>`,
          `<text x="${fmtNum(cxCol + 6.5)}" y="${fmtNum(ey)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.2" font-weight="800" fill="${PAL.paperHi}" text-anchor="middle" dominant-baseline="central">${i + 1}</text>`,
          `<text x="${fmtNum(cxCol + 20)}" y="${fmtNum(ey)}" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="8.2" font-weight="600" fill="${PAL.inkDeep}" dominant-baseline="central">${escapeXml(truncateByGraphemes(item.text, colW - 88, `600 8.2px ${POSTER_SERIF_STACK}`))}</text>`,
          `<text x="${fmtNum(cxCol + colW)}" y="${fmtNum(ey)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="7.1" fill="${PAL.inkSoft}" text-anchor="end" dominant-baseline="central">${item.xmin.toFixed(2)}–${item.xmax.toFixed(2)}s</text>`
        );
      }
    }

    // Bottom quiet archival colophon hairline + edition footer
    edParts.push(
      `<line x1="${marginX}" y1="1134" x2="${trimW - marginX}" y2="1134" stroke="${PAL.paperRule}" stroke-opacity="0.72" stroke-width="0.5"/>`,
      `<text x="${marginX}" y="1150" font-family="${escapeXml(POSTER_SERIF_STACK)}" font-size="7.6" letter-spacing="0.4" fill="#857A6A" dominant-baseline="central">${escapeXml(truncateByGraphemes(footStr, 560, `400 7.6px ${POSTER_SERIF_STACK}`))}</text>`,
      `<text x="${trimW - marginX}" y="1150" text-anchor="end" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="6.8" letter-spacing="1.1" fill="#9E9281" dominant-baseline="central">SONG / MING FOLDING FAN EDITION</text>`
    );

    editorialGroup = `<g id="editorial-copy">${edParts.join('')}</g>`;
  }

  // Emblem 1:1 centers the full open folding fan + outer medallions gracefully inside 900×900
  // Raw fan + badges bounding box: x in [~56..844], y in [~274..810] -> center ~(450, 542)
  const emblemOpen = isEmblem
    ? `<g transform="translate(450 450) scale(1.01) translate(-450 -542)">`
    : '';
  const emblemClose = isEmblem ? '</g>' : '';

  const printMarksGroup = config.includeBleed ? renderPrintMarksSvg(trimW, trimH, bleed) : '';

  const svgMarkup =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmtNum(widthPt)}pt" height="${fmtNum(heightPt)}pt" viewBox="${fmtNum(-bleed)} ${fmtNum(-bleed)} ${fmtNum(widthPt)} ${fmtNum(heightPt)}">` +
    `<defs>${defs}</defs>` +
    paperBgGroup +
    emblemOpen +
    `<g id="fan-base">${fanBaseParts.join('')}</g>` +
    `<g id="acoustic-traces">${acousticParts.join('')}</g>` +
    `<g id="annotation-layers">${annotationParts.join('')}</g>` +
    `<g id="point-markers">${pointParts.join('')}</g>` +
    emblemClose +
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
