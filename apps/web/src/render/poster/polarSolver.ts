import type { AudioAnalysisSummary, Interval, TextGrid, Tier } from '../../bridge/types';
import {
  IPA_FONT_STACK,
  MONO_FONT_STACK,
  SANS_FONT_STACK,
  SERIF_FONT_STACK,
  decodeTrigraphGlossSync,
  measurePx,
  splitGraphemes
} from '../../layout/richText';
import type {
  PolarColumn,
  PolarLayout,
  PolarPointPlacement,
  PolarRingBand,
  PosterAutoCopy,
  PosterTemplateId
} from './types';

export const POSTER_SANS_STACK = SANS_FONT_STACK;
export const POSTER_SERIF_STACK = SERIF_FONT_STACK;
export const POSTER_CJK_SERIF_STACK =
  '"Source Han Serif SC", "Noto Serif SC", "Songti SC", "STZhongsong", "STSong", "FZXiaoBiaoSong-B05S", "SimSun", "DejaVu Serif", serif';
export const POSTER_DISPLAY_SANS_STACK =
  '"Inter", "Helvetica Neue", "Arial Black", "Segoe UI", "Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
export const POSTER_IPA_STACK = IPA_FONT_STACK;
export const POSTER_MONO_STACK = MONO_FONT_STACK;

// Vinyl core radii (exact Swiss/Braun geometry)
export const VINYL_START_DEG = -72.0;
export const VINYL_TOTAL_DEG = 324.0;
export const VINYL_END_DEG = VINYL_START_DEG + VINYL_TOTAL_DEG; // +252.0 deg
export const VINYL_R_HOLE = 7.2;
export const VINYL_R_LABEL = 58.0;
export const VINYL_R_DEADWAX = 66.5;
export const VINYL_R_WAVE_IN = 68.0;
export const VINYL_R_WAVE_OUT = 79.5;
export const VINYL_R_SPEC_IN = 81.0;
export const VINYL_R_SPEC_OUT = 136.5;
export const VINYL_R_TRUE_IN = 138.0;
export const VINYL_R_TRUE_OUT = 141.0;
export const VINYL_R_VINYL_EDGE = 144.0;
export const VINYL_R_WEB_IN = 145.5;
export const VINYL_R_WEB_OUT = 167.5;

// Bauhaus core radii (exact Weimar 1923 geometry)
export const BAUHAUS_START_DEG = -106.0;
export const BAUHAUS_TOTAL_DEG = 224.0;
export const BAUHAUS_END_DEG = BAUHAUS_START_DEG + BAUHAUS_TOTAL_DEG; // +118.0 deg
export const BAUHAUS_R_DUR0 = 100.0;
export const BAUHAUS_R_DUR1 = 103.5;
export const BAUHAUS_R_SPEC0 = 106.0;
export const BAUHAUS_R_SPEC1 = 144.0;
export const BAUHAUS_R_WAVE0 = 146.5;
export const BAUHAUS_R_WAVE1 = 162.5;
export const BAUHAUS_R_BRIDGE0 = 165.0;
export const BAUHAUS_R_BRIDGE1 = 190.0;

const COMBINING_RE = /\p{M}/u;
export const IPA_CHAR_RE =
  /[\u00E6\u00E7\u00F0\u00F8\u0127\u014B\u0153\u0188\u0199\u01A5\u01AD\u01C0-\u01C3\u0221\u0234-\u0236\u0241\u0250-\u02AF\u02B0-\u02FF\u0300-\u036F\u03B2\u03B8\u03C7\u1D00-\u1DBF\u1DC4-\u1DC9\u203F\u2C71\uA700-\uA71F\uA7F9\uAB66\uAB67]/;
const IPA_NAME_RE = /ipa|phon|音标|音素|宽式|严式|窄式/i;

export function escapeXml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtNum(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(digits).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  return s === '-0' ? '0' : s;
}

export function resolvePosterText(raw: string): string {
  if (!raw) return '';
  const decoded = decodeTrigraphGlossSync(raw) ?? raw;
  return decoded.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function hasCombiningMarks(s: string): boolean {
  return COMBINING_RE.test(s);
}

export function isTierIpaLike(tier: Tier): boolean {
  if (IPA_NAME_RE.test(tier.name || '')) return true;
  let hits = 0;
  let total = 0;
  for (const iv of tier.intervals) {
    const t = resolvePosterText(iv.text);
    if (!t) continue;
    total++;
    if (IPA_CHAR_RE.test(t)) hits++;
  }
  return total > 0 && hits / total >= 0.22;
}

export function tierHasCombiningMarks(tier: Tier): boolean {
  for (const iv of tier.intervals) {
    const t = resolvePosterText(iv.text);
    if (t && COMBINING_RE.test(t)) return true;
  }
  return false;
}

/** Vinyl polar coordinates: 0 deg = 3 o'clock, clockwise positive. */
export function polarPtVinyl(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** Bauhaus clock-dial polar coordinates: 0 deg = 12 o'clock, clockwise positive. */
export function polarPtBauhaus(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

/** SVG annular sector path using Vinyl angle convention (0° = 3 o'clock, clockwise positive). */
export function svgSectorPathVinyl(
  cx: number,
  cy: number,
  rIn: number,
  rOut: number,
  deg0: number,
  deg1: number
): string {
  if (deg1 <= deg0 + 1e-4) return '';
  const sweep = deg1 - deg0;
  const large = sweep > 180 ? 1 : 0;
  const [ox0, oy0] = polarPtVinyl(cx, cy, rOut, deg0);
  const [ox1, oy1] = polarPtVinyl(cx, cy, rOut, deg1);
  const [ix1, iy1] = polarPtVinyl(cx, cy, rIn, deg1);
  const [ix0, iy0] = polarPtVinyl(cx, cy, rIn, deg0);
  return (
    `M ${fmtNum(ox0)} ${fmtNum(oy0)} ` +
    `A ${fmtNum(rOut)} ${fmtNum(rOut)} 0 ${large} 1 ${fmtNum(ox1)} ${fmtNum(oy1)} ` +
    `L ${fmtNum(ix1)} ${fmtNum(iy1)} ` +
    `A ${fmtNum(rIn)} ${fmtNum(rIn)} 0 ${large} 0 ${fmtNum(ix0)} ${fmtNum(iy0)} Z`
  );
}

/** SVG annular sector path using Bauhaus angle convention (0° = 12 o'clock, clockwise positive). */
export function svgSectorPathBauhaus(
  cx: number,
  cy: number,
  rIn: number,
  rOut: number,
  deg0: number,
  deg1: number
): string {
  return svgSectorPathVinyl(cx, cy, rIn, rOut, deg0 - 90, deg1 - 90);
}

/** SVG circular arc stroke path using Vinyl angle convention. */
export function svgArcPathVinyl(cx: number, cy: number, r: number, deg0: number, deg1: number): string {
  if (deg1 <= deg0 + 1e-4) return '';
  const large = deg1 - deg0 > 180 ? 1 : 0;
  const [x0, y0] = polarPtVinyl(cx, cy, r, deg0);
  const [x1, y1] = polarPtVinyl(cx, cy, r, deg1);
  return `M ${fmtNum(x0)} ${fmtNum(y0)} A ${fmtNum(r)} ${fmtNum(r)} 0 ${large} 1 ${fmtNum(x1)} ${fmtNum(y1)}`;
}

/** SVG circular arc stroke path using Bauhaus angle convention. */
export function svgArcPathBauhaus(cx: number, cy: number, r: number, deg0: number, deg1: number): string {
  return svgArcPathVinyl(cx, cy, r, deg0 - 90, deg1 - 90);
}

/** Piecewise-linear time -> angle lookup matching both reference scripts. */
export function timeToAngle(t: number, bnds: number[], thetas: number[]): number {
  if (!bnds.length || !thetas.length) return 0;
  if (t <= bnds[0]) return thetas[0];
  if (t >= bnds[bnds.length - 1]) return thetas[thetas.length - 1];
  let lo = 0;
  let hi = bnds.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (bnds[mid] <= t) lo = mid;
    else hi = mid;
  }
  const dt = bnds[lo + 1] - bnds[lo];
  const u = dt <= 1e-12 ? 0 : Math.max(0, Math.min(1, (t - bnds[lo]) / dt));
  return thetas[lo] + u * (thetas[lo + 1] - thetas[lo]);
}

function allocateVinylRings(
  tiers: Array<{ tierIdx: number; tier: Tier; isIpaLike: boolean; hasCombining: boolean }>
): { rings: PolarRingBand[]; rTone: number; rTimeAxis: number; rPlatter: number; rBridgeOut: number } {
  const n = tiers.length;
  if (n === 0) {
    return { rings: [], rTone: 176.0, rTimeAxis: 184.0, rPlatter: 200.0, rBridgeOut: VINYL_R_WEB_OUT };
  }

  // Exact 5-tier sculpted radii from Swiss/Braun Vinyl reference
  const ref5: Array<[number, number, number]> = [
    [168.5, 185.5, 8.6],
    [187.2, 205.8, 9.0],
    [207.5, 225.5, 7.6],
    [227.2, 246.2, 8.4],
    [247.9, 268.5, 8.5]
  ];

  const rings: PolarRingBand[] = [];
  if (n === 5) {
    for (let i = 0; i < 5; i++) {
      const [baseIn, baseOut, fs] = ref5[i];
      rings.push({
        tierIdx: tiers[i].tierIdx,
        ringIndex: i,
        name: tiers[i].tier.name || `层 ${i + 1}`,
        rIn: baseIn,
        rOut: baseOut,
        rMid: 0.5 * (baseIn + baseOut),
        fontSize: fs,
        isIpaLike: tiers[i].isIpaLike,
        hasCombining: tiers[i].hasCombining
      });
    }
    return { rings, rTone: 274.2, rTimeAxis: 280.0, rPlatter: 287.0, rBridgeOut: VINYL_R_WEB_OUT };
  }

  // Dynamic monumental framing for n = 1..4 & 6 tiers: breathe the silk bridge and ring bands so
  // platter diameter stays commanding (~262..287pt) across all tier counts!
  const rBridgeOut = n === 1 ? 186.0 : n === 2 ? 176.0 : n === 3 ? 171.0 : n === 4 ? 168.5 : VINYL_R_WEB_OUT;
  const startR = rBridgeOut + 1.5;
  const gap = n >= 6 ? 1.4 : n === 4 ? 2.0 : n === 3 ? 2.4 : n === 2 ? 3.2 : 3.0;
  const baseThick = n === 1 ? 42.0 : n === 2 ? 33.5 : n === 3 ? 27.5 : n === 4 ? 22.2 : 15.8;
  let cursor = startR;
  for (let i = 0; i < n; i++) {
    const extra = tiers[i].hasCombining ? 2.0 : tiers[i].isIpaLike ? 1.0 : 0;
    const thick = baseThick + extra + (i === n - 1 ? 1.2 : 0);
    const rIn = cursor;
    const rOut = cursor + thick;
    const fs = Math.min(10.8, Math.max(7.4, n <= 2 ? 10.2 : n === 3 ? 9.6 : thick * 0.42));
    rings.push({
      tierIdx: tiers[i].tierIdx,
      ringIndex: i,
      name: tiers[i].tier.name || `层 ${i + 1}`,
      rIn,
      rOut,
      rMid: 0.5 * (rIn + rOut),
      fontSize: fs,
      isIpaLike: tiers[i].isIpaLike,
      hasCombining: tiers[i].hasCombining
    });
    cursor = rOut + gap;
  }
  const outer = rings[rings.length - 1].rOut;
  const toneGap = n <= 2 ? 7.0 : 6.0;
  return {
    rings,
    rTone: outer + toneGap,
    rTimeAxis: outer + toneGap + 6.2,
    rPlatter: outer + toneGap + 14.2,
    rBridgeOut
  };
}

function allocateBauhausRings(
  tiers: Array<{ tierIdx: number; tier: Tier; isIpaLike: boolean; hasCombining: boolean }>
): { rings: PolarRingBand[]; rTone: number; rBadge: number; rBridgeOut: number } {
  const n = tiers.length;
  if (n === 0) {
    return { rings: [], rTone: 204.0, rBadge: 242.0, rBridgeOut: BAUHAUS_R_BRIDGE1 };
  }

  // Exact 5-tier radii from Weimar 1923 Bauhaus Sunburst reference (with generous badge clearance)
  const ref5: Array<[number, number, number]> = [
    [190.0, 215.0, 10.5],
    [218.0, 246.0, 10.2],
    [249.0, 276.0, 8.8],
    [279.0, 306.0, 9.2],
    [309.0, 339.0, 9.4]
  ];

  const rings: PolarRingBand[] = [];
  if (n === 5) {
    for (let i = 0; i < 5; i++) {
      const [rIn, rOut, fs] = ref5[i];
      rings.push({
        tierIdx: tiers[i].tierIdx,
        ringIndex: i,
        name: tiers[i].tier.name || `层 ${i + 1}`,
        rIn,
        rOut,
        rMid: 0.5 * (rIn + rOut),
        fontSize: fs,
        isIpaLike: tiers[i].isIpaLike,
        hasCombining: tiers[i].hasCombining
      });
    }
    return { rings, rTone: 349.0, rBadge: 386.0, rBridgeOut: BAUHAUS_R_BRIDGE1 };
  }

  // Monumental sunburst framing for n = 1..4 & 6 tiers: keep commanding outer presence (~318..352pt)
  const rBridgeOut = n === 1 ? 216.0 : n === 2 ? 210.0 : n === 3 ? 200.0 : n === 4 ? 194.0 : BAUHAUS_R_BRIDGE1;
  const startR = rBridgeOut;
  const gap = n >= 6 ? 2.4 : n === 4 ? 3.2 : n === 3 ? 3.8 : 4.8;
  const baseThick = n === 1 ? 52.0 : n === 2 ? 44.5 : n === 3 ? 40.0 : n === 4 ? 33.5 : 23.0;
  let cursor = startR;
  for (let i = 0; i < n; i++) {
    const extra = tiers[i].hasCombining ? 2.0 : tiers[i].isIpaLike ? 1.0 : 0;
    const thick = baseThick + extra + (i === n - 1 ? 1.5 : 0);
    const rIn = cursor;
    const rOut = cursor + thick;
    const fs = Math.min(11.8, Math.max(8.0, n <= 2 ? 11.2 : n === 3 ? 10.6 : thick * 0.34));
    rings.push({
      tierIdx: tiers[i].tierIdx,
      ringIndex: i,
      name: tiers[i].tier.name || `层 ${i + 1}`,
      rIn,
      rOut,
      rMid: 0.5 * (rIn + rOut),
      fontSize: fs,
      isIpaLike: tiers[i].isIpaLike,
      hasCombining: tiers[i].hasCombining
    });
    cursor = rOut + gap;
  }
  const outer = rings[rings.length - 1].rOut;
  const rTone = outer + 11.0;
  // Minimum 38pt badge clearance beyond rTone so radial timestamps never collide with badge circles
  const rBadge = Math.min(388.0, rTone + 38.0);
  return { rings, rTone, rBadge, rBridgeOut };
}

function collectTierBoundaries(tier: Tier | undefined, tMin: number, tMax: number): number[] {
  if (!tier || tier.kind !== 'intervalTier') return [];
  const out: number[] = [];
  for (const iv of tier.intervals) {
    const a = Math.max(tMin, Math.min(tMax, iv.xmin));
    const b = Math.max(tMin, Math.min(tMax, iv.xmax));
    if (b > a + 1e-8) {
      out.push(a, b);
    }
  }
  return out;
}

function mergeSortedTimes(raw: number[], eps = 1e-7): number[] {
  if (!raw.length) return [];
  const sorted = [...raw].sort((a, b) => a - b);
  const out: number[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - out[out.length - 1] > eps) {
      out.push(sorted[i]);
    }
  }
  return out;
}

/**
 * Generalized Multi-Tier Polar Adaptive Width Solver.
 * Supports 0..6 interval tiers + 0..1 point tier with collision-avoided point badges.
 */
export function solvePolarLayout(params: {
  template: PosterTemplateId;
  tg: TextGrid;
  tMin: number;
  tMax: number;
  intervalTierIndices: number[];
  pointTierIndex: number | null;
  pointNotes: Record<string, string>;
  cx: number;
  cy: number;
}): PolarLayout {
  const { template, tg, tMin, tMax, intervalTierIndices, pointTierIndex, pointNotes, cx, cy } = params;
  const duration = Math.max(1e-4, tMax - tMin);
  const startDeg = template === 'vinyl' ? VINYL_START_DEG : BAUHAUS_START_DEG;
  const totalDeg = template === 'vinyl' ? VINYL_TOTAL_DEG : BAUHAUS_TOTAL_DEG;
  const endDeg = startDeg + totalDeg;

  const validIntervalTiers = intervalTierIndices
    .filter((idx) => idx >= 0 && idx < tg.tiers.length && tg.tiers[idx].kind === 'intervalTier')
    .slice(0, 6)
    .map((tierIdx) => {
      const tier = tg.tiers[tierIdx];
      return {
        tierIdx,
        tier,
        isIpaLike: isTierIpaLike(tier),
        hasCombining: tierHasCombiningMarks(tier)
      };
    });

  let rings: PolarRingBand[];
  let rTone: number;
  let rTimeAxis: number;
  let rPlatter: number;
  let rBadge: number;
  let rBridgeOut: number;

  if (template === 'vinyl') {
    const alloc = allocateVinylRings(validIntervalTiers);
    rings = alloc.rings;
    rTone = alloc.rTone;
    rTimeAxis = alloc.rTimeAxis;
    rPlatter = alloc.rPlatter;
    rBadge = alloc.rTimeAxis + 28.0;
    rBridgeOut = alloc.rBridgeOut;
  } else {
    const alloc = allocateBauhausRings(validIntervalTiers);
    rings = alloc.rings;
    rTone = alloc.rTone;
    rTimeAxis = alloc.rTone;
    rPlatter = alloc.rTone + 10.0;
    rBadge = alloc.rBadge;
    rBridgeOut = alloc.rBridgeOut;
  }

  // Detect whether Ring 0 is genuinely a single-utterance umbrella tier (e.g., 3..6 tier hierarchy)
  let ring0IsUmbrella = false;
  if (rings.length >= 3) {
    const r0Tier = tg.tiers[rings[0].tierIdx];
    const r0Active = r0Tier.intervals.filter(
      (iv) => iv.xmax > tMin + 1e-8 && iv.xmin < tMax - 1e-8 && resolvePosterText(iv.text) !== ''
    );
    if (r0Active.length <= 1) {
      const cov = r0Active.reduce(
        (acc, iv) => acc + Math.max(0, Math.min(tMax, iv.xmax) - Math.max(tMin, iv.xmin)),
        0
      );
      if (cov / duration > 0.6) {
        ring0IsUmbrella = true;
      }
    }
  }

  // 1. Unified boundary spine across active interval tiers
  const rawBnds: number[] = [tMin, tMax];
  for (const t of validIntervalTiers) {
    for (const iv of t.tier.intervals) {
      if (iv.xmax <= tMin + 1e-8 || iv.xmin >= tMax - 1e-8) continue;
      rawBnds.push(Math.max(tMin, Math.min(tMax, iv.xmin)));
      rawBnds.push(Math.max(tMin, Math.min(tMax, iv.xmax)));
    }
  }
  const bnds = mergeSortedTimes(rawBnds, 1e-7);
  if (bnds.length < 2) {
    bnds.length = 0;
    bnds.push(tMin, tMax);
  }
  const nCols = bnds.length - 1;

  // 2. Column linear angles & minimum angular floors
  const densityScale = nCols > 42 ? Math.max(0.32, 42 / nCols) : 1.0;
  const cols: PolarColumn[] = [];
  for (let i = 0; i < nCols; i++) {
    const a = bnds[i];
    const b = bnds[i + 1];
    const dt = Math.max(1e-9, b - a);
    let allEmpty = true;
    for (const t of validIntervalTiers) {
      const hasNonEmpty = t.tier.intervals.some(
        (iv) => iv.xmin <= a + 1e-7 && iv.xmax >= b - 1e-7 && resolvePosterText(iv.text) !== ''
      );
      if (hasNonEmpty) {
        allEmpty = false;
        break;
      }
    }
    const degLin = (dt / duration) * totalDeg;
    const isTrailing = i === nCols - 1;
    let degFloor: number;
    if (allEmpty) {
      if (dt < 0.015) {
        degFloor = 0.85 * densityScale;
      } else if (template === 'bauhaus') {
        if (dt < 0.15) {
          degFloor = 4.6 * densityScale;
        } else if (isTrailing) {
          degFloor = 9.5 * densityScale;
        } else {
          // Keep interior multi-turn dialogue pauses sleek so they never starve spoken intervals
          degFloor = Math.min(5.2, Math.max(2.8, degLin * 0.55)) * densityScale;
        }
      } else {
        degFloor = isTrailing ? 6.0 * densityScale : Math.min(5.2, Math.max(2.6, degLin * 0.58)) * densityScale;
      }
    } else {
      degFloor = (template === 'vinyl' ? 5.4 : 4.5) * densityScale;
    }
    cols.push({
      idx: i,
      a,
      b,
      dt,
      allEmpty,
      degLin,
      degFloor,
      degVar: degLin,
      lin0: startDeg,
      lin1: startDeg,
      var0: startDeg,
      var1: startDeg
    });
  }

  // 3. Demand-driven text width expansion across ALL active rings
  //    (ONLY skip Ring 0 in Bauhaus when Ring 0 is genuinely a single-utterance umbrella tier!)
  const startRingForDemand = template === 'bauhaus' && ring0IsUmbrella ? 1 : 0;
  for (let rIdx = startRingForDemand; rIdx < rings.length; rIdx++) {
    const ring = rings[rIdx];
    const tier = tg.tiers[ring.tierIdx];
    const fontStack = ring.isIpaLike ? POSTER_IPA_STACK : POSTER_SANS_STACK;
    const fontWeight = template === 'bauhaus' ? 700 : 600;
    const fontCss = `${fontWeight} ${ring.fontSize.toFixed(1)}px ${fontStack}`;
    const basePad = template === 'vinyl' ? (ring.isIpaLike ? 15.5 : 17.5) : 18.0;

    for (const iv of tier.intervals) {
      if (iv.xmax <= tMin + 1e-8 || iv.xmin >= tMax - 1e-8) continue;
      const txt = resolvePosterText(iv.text);
      if (!txt) continue;
      const a = Math.max(tMin, iv.xmin);
      const b = Math.min(tMax, iv.xmax);
      const span: number[] = [];
      for (let c = 0; c < nCols; c++) {
        if (cols[c].a >= a - 1e-7 && cols[c].b <= b + 1e-7) {
          span.push(c);
        }
      }
      if (!span.length) continue;

      const gsLen = splitGraphemes(txt).length;
      const spacingBonus = template === 'bauhaus' ? Math.max(0, gsLen - 1) * 0.35 : 0;
      const tw = measurePx(txt, fontCss) + spacingBonus;
      const pad = gsLen <= 3 ? basePad : basePad + 4.0;
      const degNeed = (((tw * 1.08 + pad) / ring.rMid) * 180.0) / Math.PI;
      let curSum = 0;
      for (const ci of span) curSum += cols[ci].degFloor;
      if (degNeed > curSum) {
        const diff = degNeed - curSum;
        const weights = span.map((ci) => Math.pow(cols[ci].dt, 0.85));
        const sw = weights.reduce((acc, w) => acc + w, 0);
        for (let k = 0; k < span.length; k++) {
          const share = sw > 0 ? weights[k] / sw : 1 / span.length;
          cols[span[k]].degFloor += diff * share;
        }
      }
    }
  }

  // 4. Proximity-weighted adaptive redistribution
  const wVar = cols.map((c) => c.degLin);

  // Bauhaus trailing silence cap so long silent tails don't starve speech cells
  if (template === 'bauhaus' && nCols > 3 && cols[nCols - 1].allEmpty && cols[nCols - 1].dt > 0.25) {
    const capTail = 13.5;
    if (wVar[nCols - 1] > capTail) {
      const freed = wVar[nCols - 1] - capTail;
      wVar[nCols - 1] = capTail;
      let speechSum = 0;
      for (let k = 1; k < nCols - 1; k++) speechSum += wVar[k];
      if (speechSum > 1e-9) {
        for (let k = 1; k < nCols - 1; k++) {
          wVar[k] += freed * (wVar[k] / speechSum);
        }
      }
    }
  }

  const sumFloors = cols.reduce((acc, c) => acc + c.degFloor, 0);
  if (sumFloors >= totalDeg) {
    const s = totalDeg / Math.max(1e-9, sumFloors);
    for (let i = 0; i < nCols; i++) {
      wVar[i] = cols[i].degFloor * s;
    }
  } else {
    for (let iter = 0; iter < 50; iter++) {
      let totalDeficit = 0;
      const deficits = new Float64Array(nCols);
      const surpluses = new Float64Array(nCols);
      for (let i = 0; i < nCols; i++) {
        const d = cols[i].degFloor - wVar[i];
        if (d > 1e-7) {
          deficits[i] = d;
          totalDeficit += d;
        } else if (d < -1e-7) {
          surpluses[i] = -d;
        }
      }
      if (totalDeficit < 1e-6) break;

      for (let i = 0; i < nCols; i++) {
        if (deficits[i] <= 1e-7) continue;
        const need = deficits[i];
        let wSum = 0;
        const donors: Array<[number, number]> = [];
        for (let j = 0; j < nCols; j++) {
          if (surpluses[j] > 1e-7) {
            const pw = surpluses[j] / Math.pow(Math.abs(j - i) + 0.8, 1.35);
            donors.push([j, pw]);
            wSum += pw;
          }
        }
        if (wSum <= 1e-12) break;
        for (const [j, pw] of donors) {
          const take = Math.min(surpluses[j], need * (pw / wSum));
          wVar[j] -= take;
          wVar[i] += take;
          surpluses[j] -= take;
        }
      }
    }

    // Exact sum closure
    const curTotal = wVar.reduce((acc, v) => acc + v, 0);
    const err = totalDeg - curTotal;
    if (Math.abs(err) > 1e-8) {
      let freeSum = 0;
      const free = wVar.map((v, i) => {
        const f = Math.max(0, v - cols[i].degFloor);
        freeSum += f;
        return f;
      });
      for (let i = 0; i < nCols; i++) {
        wVar[i] += err * (freeSum > 1e-9 ? free[i] / freeSum : 1 / nCols);
      }
    }
  }

  let curLin = startDeg;
  let curVar = startDeg;
  const thetaLin: number[] = [curLin];
  const thetaVar: number[] = [curVar];
  for (let i = 0; i < nCols; i++) {
    cols[i].degVar = wVar[i];
    cols[i].lin0 = curLin;
    cols[i].var0 = curVar;
    curLin += cols[i].degLin;
    curVar += cols[i].degVar;
    cols[i].lin1 = curLin;
    cols[i].var1 = curVar;
    thetaLin.push(curLin);
    thetaVar.push(curVar);
  }
  thetaLin[thetaLin.length - 1] = endDeg;
  thetaVar[thetaVar.length - 1] = endDeg;

  // 5. Point tier collision-avoidance solver
  const pointTier =
    pointTierIndex !== null &&
    pointTierIndex >= 0 &&
    pointTierIndex < tg.tiers.length &&
    tg.tiers[pointTierIndex].kind === 'textTier'
      ? tg.tiers[pointTierIndex]
      : null;

  const points: PolarPointPlacement[] = [];
  if (pointTier) {
    const rawPts = pointTier.points
      .filter((pt) => pt.number >= tMin - 1e-7 && pt.number <= tMax + 1e-7)
      .sort((a, b) => a.number - b.number);

    for (let i = 0; i < rawPts.length; i++) {
      const pt = rawPts[i];
      const mark = resolvePosterText(pt.mark) || `P${i + 1}`;
      const trueAngleDeg = timeToAngle(pt.number, bnds, thetaVar);
      const key = `${i}`;
      points.push({
        idx: i,
        time: pt.number,
        rawMark: pt.mark,
        mark,
        note: (pointNotes[key] || '').trim(),
        trueAngleDeg,
        badgeAngleDeg: trueAngleDeg
      });
    }

    if (points.length >= 2) {
      // Ensure circular badges never crowd or touch each other at rBadge
      const geomMinSep =
        template === 'bauhaus'
          ? (((2 * 8.4 + 6.0) / Math.max(200, rBadge)) * 180) / Math.PI
          : (((2 * 4.5 + 8.0) / Math.max(200, rBadge)) * 180) / Math.PI;
      const desiredSep = Math.max(geomMinSep, template === 'bauhaus' ? 6.4 : 5.6);
      const minSepDeg = Math.max(
        3.2,
        Math.min(desiredSep, (totalDeg - 8) / Math.max(1, points.length * 1.1))
      );
      const loClamp = startDeg + 1.4;
      const hiClamp = endDeg - 1.4;
      for (let iter = 0; iter < 40; iter++) {
        let moved = false;
        for (let i = 0; i < points.length - 1; i++) {
          const gap = points[i + 1].badgeAngleDeg - points[i].badgeAngleDeg;
          if (gap < minSepDeg) {
            const push = (minSepDeg - gap) * 0.52;
            points[i].badgeAngleDeg = Math.max(loClamp, points[i].badgeAngleDeg - push);
            points[i + 1].badgeAngleDeg = Math.min(hiClamp, points[i + 1].badgeAngleDeg + push);
            moved = true;
          }
        }
        // Forward clamp sweep
        for (let i = 1; i < points.length; i++) {
          if (points[i].badgeAngleDeg < points[i - 1].badgeAngleDeg + minSepDeg) {
            points[i].badgeAngleDeg = Math.min(hiClamp, points[i - 1].badgeAngleDeg + minSepDeg);
          }
        }
        // Backward clamp sweep
        for (let i = points.length - 2; i >= 0; i--) {
          if (points[i].badgeAngleDeg > points[i + 1].badgeAngleDeg - minSepDeg) {
            points[i].badgeAngleDeg = Math.max(loClamp, points[i + 1].badgeAngleDeg - minSepDeg);
          }
        }
        if (!moved) break;
      }
    }
  }

  // Hierarchy boundary sets for silk warp & time ticks:
  // When Ring 0 is NOT a single-utterance umbrella (e.g. 2-speaker dialogue), include BOTH Ring 0 and Ring 1
  // in wordBoundaries so every speaker's turn boundaries get crisp major ticks and bridges!
  const wordRaw: number[] = [tMin, tMax];
  if (ring0IsUmbrella) {
    wordRaw.push(...collectTierBoundaries(tg.tiers[rings[1].tierIdx], tMin, tMax));
  } else {
    if (rings.length >= 1) wordRaw.push(...collectTierBoundaries(tg.tiers[rings[0].tierIdx], tMin, tMax));
    if (rings.length >= 2) wordRaw.push(...collectTierBoundaries(tg.tiers[rings[1].tierIdx], tMin, tMax));
  }
  const sylTierIdx = rings.length >= 3 ? rings[2].tierIdx : -1;
  const broadTierIdx = rings.length >= 4 ? rings[3].tierIdx : -1;

  const wordBoundaries = mergeSortedTimes(wordRaw, 1e-6);
  const sylBoundaries = mergeSortedTimes(
    sylTierIdx >= 0 ? collectTierBoundaries(tg.tiers[sylTierIdx], tMin, tMax) : [],
    1e-6
  );
  const broadBoundaries = mergeSortedTimes(
    broadTierIdx >= 0 ? collectTierBoundaries(tg.tiers[broadTierIdx], tMin, tMax) : [],
    1e-6
  );

  return {
    template,
    cx,
    cy,
    startDeg,
    totalDeg,
    endDeg,
    tMin,
    tMax,
    duration,
    bnds,
    cols,
    thetaLin,
    thetaVar,
    rings,
    pointTierIdx: pointTier ? pointTierIndex : null,
    pointTierName: pointTier ? pointTier.name || '标点层' : null,
    points,
    rTone,
    rTimeAxis,
    rPlatter,
    rBadge,
    rBridgeOut,
    ring0IsUmbrella,
    wordBoundaries,
    sylBoundaries,
    broadBoundaries
  };
}

export function truncateByGraphemes(text: string, maxWidth: number, fontCss: string): string {
  if (measurePx(text, fontCss) <= maxWidth) return text;
  const gs = splitGraphemes(text);
  const ell = '…';
  while (gs.length > 1 && measurePx(gs.join('') + ell, fontCss) > maxWidth) {
    gs.pop();
  }
  const cand = gs.join('') + ell;
  return measurePx(cand, fontCss) <= maxWidth ? cand : gs[0] || ell;
}

/**
 * Zero-<textPath> Vinyl curved / single-unit arc typography.
 * Automatically flips reading direction in lower hemisphere so text is never upside down.
 */
export function renderVinylArcTextSvg(opts: {
  cx: number;
  cy: number;
  rMid: number;
  rThick: number;
  degStart: number;
  degEnd: number;
  text: string;
  fontSize: number;
  fontWeight: number | string;
  fontFamily: string;
  fill: string;
  singleUnit?: boolean;
}): string {
  const { cx, cy, rMid, rThick, degStart, degEnd, text, fontSize, fontWeight, fontFamily, fill, singleUnit } = opts;
  if (!text) return '';

  const degMid = 0.5 * (degStart + degEnd);
  const degMidRad = (degMid * Math.PI) / 180;
  const lowerHemi = Math.sin(degMidRad) > 0.02;
  const rEff = lowerHemi ? rMid + 0.65 : rMid;
  const availArc = (Math.abs(degEnd - degStart) * Math.PI * rEff) / 180;
  if (availArc < 4.5) return '';

  const graphemes = splitGraphemes(text);
  const fontCss = `${fontWeight} ${fontSize.toFixed(1)}px ${fontFamily}`;

  // Single unit (short atomic IPA phoneme or <= 2 graphemes with no spaces): render as one intact shaped <text>
  // preserving OpenType stacked combining diacritic anchors; longer/multi-word phrases always curve along the arc!
  const isShortAtomic = !text.includes(' ') && graphemes.length <= 3;
  if ((singleUnit && isShortAtomic) || (!text.includes(' ') && graphemes.length <= 2)) {
    const gw = Math.max(1, measurePx(text, fontCss));
    const sideMargin = Math.min(8.0, Math.max(4.8, availArc * 0.22));
    const maxW = Math.max(4.5, availArc - sideMargin);
    let effSize = fontSize;
    let display = text;
    if (gw > maxW) {
      const ratio = maxW / gw;
      if (ratio >= 0.56) {
        effSize = Math.max(5.0, fontSize * ratio);
      } else if (rThick >= 14 && availArc < 14 && graphemes.length <= 4) {
        // Ultra-narrow sector: rotate along radial spoke
        const spokeScale = Math.min(1, (rThick - 4) / gw);
        effSize = Math.max(5.2, fontSize * Math.max(0.58, spokeScale));
        const [px, py] = polarPtVinyl(cx, cy, rMid, degMid);
        const isLeft = Math.cos(degMidRad) < -0.01;
        const spokeRot = isLeft ? degMid + 180 : degMid;
        return `<text x="0" y="0" transform="translate(${fmtNum(px)} ${fmtNum(py)}) rotate(${fmtNum(spokeRot)})" font-family="${escapeXml(fontFamily)}" font-size="${fmtNum(effSize)}" font-weight="${fontWeight}" fill="${fill}" text-anchor="middle" dominant-baseline="central">${escapeXml(display)}</text>`;
      } else {
        effSize = Math.max(5.4, fontSize * 0.62);
        display = truncateByGraphemes(text, maxW, `${fontWeight} ${effSize.toFixed(1)}px ${fontFamily}`);
      }
    }
    const [px, py] = polarPtVinyl(cx, cy, rEff, degMid);
    const rotDeg = degMid + (lowerHemi ? -90 : 90);
    return `<text x="0" y="0" transform="translate(${fmtNum(px)} ${fmtNum(py)}) rotate(${fmtNum(rotDeg)})" font-family="${escapeXml(fontFamily)}" font-size="${fmtNum(effSize)}" font-weight="${fontWeight}" fill="${fill}" text-anchor="middle" dominant-baseline="central">${escapeXml(display)}</text>`;
  }

  // Multi-grapheme phrase along circular arc (per-grapheme placement, zero <textPath>)
  const totalW = Math.max(1, measurePx(text, fontCss));
  let effSize = fontSize;
  let displayText = text;
  const maxArcW = Math.max(8, availArc - Math.min(10.5, Math.max(6.8, availArc * 0.18)));
  if (totalW > maxArcW) {
    const ratio = maxArcW / totalW;
    if (ratio >= 0.64) {
      effSize = fontSize * ratio;
    } else {
      effSize = fontSize * 0.68;
      displayText = truncateByGraphemes(text, maxArcW, `${fontWeight} ${effSize.toFixed(1)}px ${fontFamily}`);
    }
  }

  const effFontCss = `${fontWeight} ${effSize.toFixed(1)}px ${fontFamily}`;
  const dispGraphemes = splitGraphemes(displayText);
  const widths = dispGraphemes.map((g) => Math.max(effSize * 0.28, measurePx(g, effFontCss)));
  const sumW = widths.reduce((a, b) => a + b, 0);

  let cursor = 0;
  const parts: string[] = [];
  for (let i = 0; i < dispGraphemes.length; i++) {
    const g = dispGraphemes[i];
    const gw = widths[i];
    const cxLocal = cursor + gw * 0.5;
    cursor += gw;
    if (!g.trim()) continue;
    const s = cxLocal - sumW * 0.5;
    const dDeg = ((s / rEff) * 180) / Math.PI;
    const angDeg = lowerHemi ? degMid - dDeg : degMid + dDeg;
    const rotDeg = angDeg + (lowerHemi ? -90 : 90);
    const [px, py] = polarPtVinyl(cx, cy, rEff, angDeg);
    parts.push(
      `<text x="0" y="0" transform="translate(${fmtNum(px)} ${fmtNum(py)}) rotate(${fmtNum(rotDeg)})" font-family="${escapeXml(fontFamily)}" font-size="${fmtNum(effSize)}" font-weight="${fontWeight}" fill="${fill}" text-anchor="middle" dominant-baseline="central">${escapeXml(g)}</text>`
    );
  }
  return parts.join('');
}

/**
 * Bauhaus canonical 0° clock-dial upright token renderer (preserves true phonetic orientation for IPA).
 */
export function renderBauhausUprightTokenSvg(opts: {
  cx: number;
  cy: number;
  rIn: number;
  rOut: number;
  deg0: number;
  deg1: number;
  text: string;
  fontSize: number;
  fontWeight: number | string;
  fontFamily: string;
  fill: string;
}): string {
  const { cx, cy, rIn, rOut, deg0, deg1, text, fontSize, fontWeight, fontFamily, fill } = opts;
  if (!text) return '';
  const degMid = 0.5 * (deg0 + deg1);
  const phiMid = (degMid * Math.PI) / 180;
  const rMid = 0.5 * (rIn + rOut);
  const [mx, my] = polarPtBauhaus(cx, cy, rMid, degMid);

  const radialSpan = rOut - rIn;
  const tangSpan = ((Math.abs(deg1 - deg0) * Math.PI) / 180) * rMid;
  if (tangSpan < 4.5) return '';

  const cAbs = Math.abs(Math.cos(phiMid));
  const sAbs = Math.abs(Math.sin(phiMid));
  const availW = Math.max(10.0, tangSpan * cAbs + radialSpan * sAbs - 6.5);

  const baseFontCss = `${fontWeight} ${fontSize.toFixed(1)}px ${fontFamily}`;
  const gw = measurePx(text, baseFontCss);
  let effSize = fontSize;
  let display = text;
  if (gw > availW && gw > 0) {
    const scale = availW / gw;
    if (scale >= 0.72) {
      effSize = fontSize * scale;
    } else {
      effSize = Math.max(6.2, fontSize * 0.72);
      display = truncateByGraphemes(text, availW, `${fontWeight} ${effSize.toFixed(1)}px ${fontFamily}`);
    }
  }

  return `<text x="${fmtNum(mx)}" y="${fmtNum(my)}" font-family="${escapeXml(fontFamily)}" font-size="${fmtNum(effSize)}" font-weight="${fontWeight}" fill="${fill}" text-anchor="middle" dominant-baseline="central">${escapeXml(display)}</text>`;
}

/**
 * Bauhaus syllable / multi-char token renderer (tangential on upper arch, radial beyond ±72°
 * ONLY when radial orientation genuinely offers more space than the tangential arc).
 */
export function renderBauhausSyllableTokenSvg(opts: {
  cx: number;
  cy: number;
  rIn: number;
  rOut: number;
  deg0: number;
  deg1: number;
  text: string;
  fontSize: number;
  fontWeight: number | string;
  fontFamily: string;
  fill: string;
}): string {
  const { cx, cy, rIn, rOut, deg0, deg1, text, fontSize, fontWeight, fontFamily, fill } = opts;
  if (!text) return '';
  const degMid = 0.5 * (deg0 + deg1);
  const rMidBase = 0.5 * (rIn + rOut);

  const radialMaxW = Math.max(10.0, rOut - rIn - 4.5);
  const tangMaxW = Math.max(9.0, (((Math.abs(deg1 - deg0) * Math.PI) / 180) * rMidBase) - 6.5);
  const gLen = splitGraphemes(text).length;

  let rotDeg: number;
  let maxW: number;
  const preferRadial = Math.abs(degMid) > 72.0 && gLen <= 3 && radialMaxW >= tangMaxW * 0.92;
  const lowerHemi = !preferRadial && Math.abs(degMid) > 89.0;
  const rMid = lowerHemi ? rMidBase + 0.85 : rMidBase;
  const [mx, my] = polarPtBauhaus(cx, cy, rMid, degMid);
  if (preferRadial) {
    rotDeg = degMid < 0 ? degMid + 90.0 : degMid - 90.0;
    maxW = radialMaxW;
  } else {
    rotDeg = lowerHemi ? degMid + 180.0 : degMid;
    maxW = tangMaxW;
  }

  const baseFontCss = `${fontWeight} ${fontSize.toFixed(1)}px ${fontFamily}`;
  const gw = measurePx(text, baseFontCss);
  let effSize = fontSize;
  let display = text;
  if (gw > maxW && gw > 0) {
    const scale = maxW / gw;
    if (scale >= 0.68) {
      effSize = fontSize * scale;
    } else {
      effSize = Math.max(6.2, fontSize * 0.70);
      display = truncateByGraphemes(text, maxW, `${fontWeight} ${effSize.toFixed(1)}px ${fontFamily}`);
    }
  }

  return `<text x="0" y="0" transform="translate(${fmtNum(mx)} ${fmtNum(my)}) rotate(${fmtNum(rotDeg)})" font-family="${escapeXml(fontFamily)}" font-size="${fmtNum(effSize)}" font-weight="${fontWeight}" fill="${fill}" text-anchor="middle" dominant-baseline="central">${escapeXml(display)}</text>`;
}

/**
 * Bauhaus curved span typography (per-grapheme placement along upper sunburst arch, zero <textPath>).
 */
export function renderBauhausCurvedSpanSvg(opts: {
  cx: number;
  cy: number;
  rMid: number;
  deg0: number;
  deg1: number;
  text: string;
  fontSize: number;
  fontWeight: number | string;
  fontFamily: string;
  fill: string;
  letterSpacingPt?: number;
}): string {
  const {
    cx,
    cy,
    rMid,
    deg0,
    deg1,
    text,
    fontSize,
    fontWeight,
    fontFamily,
    fill,
    letterSpacingPt = 0.35
  } = opts;
  if (!text) return '';

  // Prefer the upper [-68°, +68°] arch ONLY when an utterance-wide span crosses both sides of 12 o'clock
  const spansFullArch = deg0 < -45 && deg1 > 45 && deg1 - deg0 > 120;
  const pLo = spansFullArch ? Math.max(deg0, -68.0) : deg0;
  const pHi = spansFullArch ? Math.min(deg1, 68.0) : deg1;
  const degMid = 0.5 * (pLo + pHi);
  // Flip tangential direction 180° past 3/9 o'clock equator (y > cy) with optical radial centering
  const lowerHemi = Math.abs(degMid) > 89.0;
  const rEff = lowerHemi ? rMid + 0.85 : rMid;
  const rawArc = ((Math.abs(pHi - pLo) * Math.PI) / 180) * rEff;
  const edgePad = Math.min(10.0, Math.max(5.5, rawArc * 0.16));
  const availArc = Math.max(10.0, rawArc - edgePad);

  let effSize = fontSize;
  let displayText = text;
  const baseFontCss = `${fontWeight} ${effSize.toFixed(1)}px ${fontFamily}`;
  const rawW = measurePx(text, baseFontCss) + Math.max(0, splitGraphemes(text).length - 1) * letterSpacingPt;
  if (rawW > availArc && rawW > 0) {
    const ratio = availArc / rawW;
    if (ratio >= 0.60) {
      effSize = Math.max(6.4, fontSize * ratio);
    } else {
      effSize = Math.max(6.2, fontSize * 0.64);
      displayText = truncateByGraphemes(text, availArc, `${fontWeight} ${effSize.toFixed(1)}px ${fontFamily}`);
    }
  }

  const effFontCss = `${fontWeight} ${effSize.toFixed(1)}px ${fontFamily}`;
  const gs = splitGraphemes(displayText);
  const widths = gs.map((g) =>
    g.trim() === '' ? Math.max(effSize * 0.28, measurePx(' ', effFontCss)) : Math.max(effSize * 0.28, measurePx(g, effFontCss))
  );
  const totalW = widths.reduce((a, b) => a + b, 0) + Math.max(0, gs.length - 1) * letterSpacingPt;

  let cursor = 0;
  const out: string[] = [];
  for (let i = 0; i < gs.length; i++) {
    const g = gs[i];
    const gw = widths[i];
    const cxLocal = cursor + gw * 0.5;
    cursor += gw + letterSpacingPt;
    if (!g.trim()) continue;
    const s = cxLocal - totalW * 0.5;
    const dDeg = ((s / rEff) * 180) / Math.PI;
    const degC = lowerHemi ? degMid - dDeg : degMid + dDeg;
    const rotDeg = lowerHemi ? degC + 180 : degC;
    const [px, py] = polarPtBauhaus(cx, cy, rEff, degC);
    out.push(
      `<text x="0" y="0" transform="translate(${fmtNum(px)} ${fmtNum(py)}) rotate(${fmtNum(rotDeg)})" font-family="${escapeXml(fontFamily)}" font-size="${fmtNum(effSize)}" font-weight="${fontWeight}" fill="${fill}" text-anchor="middle" dominant-baseline="central">${escapeXml(g)}</text>`
    );
  }
  return out.join('');
}

/** Direct min/max waveform envelope extraction from decoded AudioBuffer. */
export function extractPolarWaveformBins(
  audioBuffer: AudioBuffer | null,
  audioOffset: number,
  tMin: number,
  tMax: number,
  nBins: number
): Array<[number, number]> | null {
  if (!audioBuffer || audioBuffer.length === 0 || tMax <= tMin) return null;
  const sr = audioBuffer.sampleRate;
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
  const len = ch0.length;

  const sStart = Math.max(0, Math.min(len - 1, Math.floor((tMin - audioOffset) * sr)));
  const sEnd = Math.max(sStart + 1, Math.min(len, Math.ceil((tMax - audioOffset) * sr)));
  if (sEnd <= sStart) return null;

  const rawMin = new Float32Array(nBins);
  const rawMax = new Float32Array(nBins);
  let peak = 1e-6;
  const span = sEnd - sStart;

  for (let k = 0; k < nBins; k++) {
    const i0 = sStart + Math.floor((k / nBins) * span);
    const i1 = Math.max(i0 + 1, sStart + Math.floor(((k + 1) / nBins) * span));
    const end = Math.min(len, i1);
    let mn = 0;
    let mx = 0;
    const step = end - i0 > 240 ? Math.floor((end - i0) / 120) : 1;
    for (let i = i0; i < end; i += step) {
      const v = ch1 ? 0.5 * (ch0[i] + ch1[i]) : ch0[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    rawMin[k] = mn;
    rawMax[k] = mx;
    const a = Math.max(Math.abs(mn), Math.abs(mx));
    if (a > peak) peak = a;
  }

  const bins: Array<[number, number]> = new Array(nBins);
  for (let k = 0; k < nBins; k++) {
    bins[k] = [rawMin[k] / peak, rawMax[k] / peak];
  }
  return bins;
}

/** Fallback waveform bin extraction from Rust `computeWaveformPath` SVG path if AudioBuffer is unavailable. */
export function parseWaveformPathToBins(
  svgPath: string,
  y: number,
  h: number,
  nBins: number
): Array<[number, number]> | null {
  if (!svgPath || h <= 0) return null;
  const coords: Array<[number, number]> = [];
  const re = /[ML]\s*(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svgPath)) !== null) {
    coords.push([parseFloat(m[1]), parseFloat(m[2])]);
  }
  if (coords.length < 4) return null;
  const midY = y + h * 0.5;
  const halfH = Math.max(1, h * 0.48);
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const [cx] of coords) {
    if (cx < xMin) xMin = cx;
    if (cx > xMax) xMax = cx;
  }
  const xSpan = Math.max(1, xMax - xMin);
  const mins = new Float32Array(nBins);
  const maxs = new Float32Array(nBins);
  for (const [cx, cy] of coords) {
    const b = Math.max(0, Math.min(nBins - 1, Math.floor(((cx - xMin) / xSpan) * nBins)));
    const amp = (midY - cy) / halfH;
    if (amp < mins[b]) mins[b] = amp;
    if (amp > maxs[b]) maxs[b] = amp;
  }
  return Array.from({ length: nBins }, (_, i) => [
    Math.max(-1, Math.min(1, mins[i])),
    Math.max(-1, Math.min(1, maxs[i]))
  ]);
}

/** Extract contiguous voiced F0 runs normalized into [0, 1] using [f0Floor, f0Ceil]. */
export function extractVoicedPitchRuns(
  analysis: AudioAnalysisSummary | null,
  tMin: number,
  tMax: number,
  f0RangeOverride?: { floor: number; ceil: number } | null
): Array<Array<{ t: number; normF0: number }>> {
  if (!analysis || !analysis.pitchTrack || analysis.pitchTrack.length < 2) return [];
  const floor = f0RangeOverride ? f0RangeOverride.floor : Math.max(50, analysis.f0Floor || 75);
  const ceil = f0RangeOverride
    ? Math.max(floor + 25, f0RangeOverride.ceil)
    : Math.max(floor + 80, analysis.f0Ceil || 480);
  const span = ceil - floor;

  const runs: Array<Array<{ t: number; normF0: number }>> = [];
  let cur: Array<{ t: number; normF0: number }> = [];
  let lastT = -Infinity;

  for (const pt of analysis.pitchTrack) {
    if (pt.t < tMin - 1e-6 || pt.t > tMax + 1e-6) continue;
    if (pt.f0 !== null && Number.isFinite(pt.f0) && pt.f0 > 0) {
      if (cur.length > 0 && pt.t - lastT > 0.045) {
        if (cur.length >= 2) runs.push(cur);
        cur = [];
      }
      const normF0 = Math.max(0, Math.min(1, (pt.f0 - floor) / span));
      cur.push({ t: pt.t, normF0 });
      lastT = pt.t;
    } else {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

/** Clean numeric timestamp formatter matching exhibition poster ticks. */
export function formatCleanSecTick(v: number, tMin: number, tMax: number): string {
  if (Math.abs(v - tMin) < 1e-6 && Math.abs(v) < 1e-6) return '0';
  if (Math.abs(v - tMax) < 1e-6) return `${v.toFixed(2)}s`;
  const rounded = Math.round(v * 100);
  if (Math.abs(v * 100 - rounded) < 0.08) {
    return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') || '0';
  }
  return v.toFixed(2);
}

/** Sanitize quote strings by trimming dangling unclosed brackets/quotes when truncated. */
function cleanQuoteClause(raw: string, maxGraphemes: number): string {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  const gs = splitGraphemes(cleaned);
  if (gs.length <= maxGraphemes) return cleaned;
  let cut = gs.slice(0, maxGraphemes - 1).join('').trim();
  // Strip any trailing dangling opening bracket or unmatched quote
  cut = cut.replace(/[\s,，、：:([{"'“‘「【]+$/, '');
  const openSq = (cut.match(/\[/g) || []).length;
  const closeSq = (cut.match(/\]/g) || []).length;
  if (openSq > closeSq) {
    const lastIdx = cut.lastIndexOf('[');
    if (lastIdx > 2) cut = cut.slice(0, lastIdx).trim();
  }
  const dqCount = (cut.match(/"/g) || []).length;
  if (dqCount % 2 === 1) {
    const lastIdx = cut.lastIndexOf('"');
    if (lastIdx > 2) cut = cut.slice(0, lastIdx).trim();
  }
  const sqCount = (cut.match(/'/g) || []).length;
  if (sqCount % 2 === 1) {
    const lastIdx = cut.lastIndexOf("'");
    if (lastIdx > 2) cut = cut.slice(0, lastIdx).trim();
  }
  cut = cut.replace(/[\s,，、：:([{"'“‘「【]+$/, '');
  return (cut || gs.slice(0, maxGraphemes - 1).join('')) + '…';
}

function joinClausesCleanly(clauses: string[], maxGraphemes: number): string {
  if (!clauses.length) return '';
  if (clauses.length === 1) return cleanQuoteClause(clauses[0], maxGraphemes);
  const picked: string[] = [];
  let accLen = 0;
  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i];
    const cLen = splitGraphemes(c).length;
    const sep = picked.length > 0 && !/[。？！，、,.?!]$/.test(picked[picked.length - 1]) ? ' ' : '';
    const nextLen = accLen + sep.length + cLen;
    if (picked.length > 0 && nextLen > maxGraphemes) {
      break;
    }
    picked.push(c);
    accLen = nextLen;
  }
  const joined = picked.reduce((acc, c, idx) => {
    if (idx === 0) return c;
    return /[。？！，、,.?!]$/.test(acc) ? `${acc}${c}` : `${acc} ${c}`;
  }, '');
  if (picked.length < clauses.length) {
    const trimmed = joined.replace(/[。，、,.]+$/, '');
    return cleanQuoteClause(trimmed, maxGraphemes - 1).replace(/…$/, '') + '…';
  }
  return cleanQuoteClause(joined, maxGraphemes);
}

const ZH_LAYER_NUM = ['', '单', '双', '三', '四', '五', '六', '七'];

/** Derive clean, jargon-free museum exhibition copy dynamically from the current TextGrid. */
export function derivePosterAutoCopy(params: {
  tg: TextGrid;
  filename: string;
  template: PosterTemplateId;
  tMin: number;
  tMax: number;
  rings: PolarRingBand[];
  pointTierName: string | null;
  hasAudio: boolean;
  audioSampleRate: number;
}): PosterAutoCopy {
  const { tg, filename, template, tMin, tMax, rings, pointTierName, hasAudio, audioSampleRate } = params;
  const dur = Math.max(0, tMax - tMin);
  const stem = (filename || tg.name || 'TextGrid').replace(/\.[^.]+$/, '') || 'TextGrid';
  const totalLayers = rings.length + (pointTierName ? 1 : 0);

  // Extract representative clauses: for 2-speaker parallel dialogues, interleave opening turns chronologically;
  // for hierarchical single-utterance tiers, use Ring 0 cleanly.
  const clauses: string[] = [];
  if (rings.length > 0) {
    const r0Tier = tg.tiers[rings[0].tierIdx];
    const r0Active = r0Tier.intervals
      .filter((iv) => iv.xmax > tMin + 1e-7 && iv.xmin < tMax - 1e-7 && resolvePosterText(iv.text) !== '')
      .map((iv) => ({ t: iv.xmin, text: resolvePosterText(iv.text) }));

    if (rings.length === 2 && r0Active.length >= 2) {
      const r1Tier = tg.tiers[rings[1].tierIdx];
      const r1Active = r1Tier.intervals
        .filter((iv) => iv.xmax > tMin + 1e-7 && iv.xmin < tMax - 1e-7 && resolvePosterText(iv.text) !== '')
        .map((iv) => ({ t: iv.xmin, text: resolvePosterText(iv.text) }));
      const merged = [...r0Active, ...r1Active].sort((a, b) => a.t - b.t);
      for (const item of merged) {
        // Skip stage directions like "[chuckle]" at the very start of quote snippets
        const cleanTxt = item.text.replace(/^\[[^\]]+\]\s*/, '').trim() || item.text;
        clauses.push(cleanTxt);
      }
    } else {
      for (const item of r0Active) {
        clauses.push(item.text);
      }
    }
  }

  const shortQuote = clauses.length > 0 ? joinClausesCleanly(clauses, 24) : cleanQuoteClause(stem, 24);
  const centerQuote = clauses.length > 0 ? joinClausesCleanly(clauses, 15) : cleanQuoteClause(stem, 15);

  const srStr =
    hasAudio && audioSampleRate > 0
      ? `${(audioSampleRate / 1000).toFixed(audioSampleRate % 1000 === 0 ? 0 : 1)} kHz`
      : '无音频底图';

  const layerPhrase =
    totalLayers > 1 ? `${totalLayers} 层声学与标注拆解` : totalLayers === 1 ? '单层语音标注展开' : '声学声纹图谱';

  const zhCount = ZH_LAYER_NUM[totalLayers] || `${totalLayers}`;
  let title: string;
  let subtitle: string;
  let sideLabel: string;

  if (template === 'vinyl') {
    title = totalLayers > 0 ? '声纹唱片' : '声纹唱片档案';
    subtitle = `「${shortQuote}」 · ${dur.toFixed(2)} 秒${hasAudio ? '语音' : '标注'} · ${layerPhrase}`;
    sideLabel = `SIDE A  ·  ${dur.toFixed(2)} SEC  ·  33⅓`;
  } else if (template === 'bauhaus') {
    title = totalLayers > 0 ? `${zhCount}层声学拆解` : '声学几何展开';
    subtitle = `「${shortQuote}」 · ${dur.toFixed(2)} 秒${hasAudio ? '语音' : '标注'} · ${layerPhrase}`;
    sideLabel = `BAUHAUS WEIMAR  ·  ${hasAudio && audioSampleRate > 0 ? `${srStr} 语音手稿` : '语音标注手稿'}`;
  } else if (template === 'braun_strip') {
    title = shortQuote || '语音声谱记录';
    subtitle = `${hasAudio && audioSampleRate > 0 ? `${srStr} 采样` : '无音频底图'} · ${
      totalLayers > 0 ? `${totalLayers} 层标注记录` : '声学纸带记录'
    }`;
    sideLabel = `VOICE RECORDER · ${dur.toFixed(2)}s`;
  } else if (template === 'folding_fan') {
    title = '弦外之音';
    const fanKind = rings.length === 2 ? '双人对话扇谱' : totalLayers > 0 ? '语音扇谱' : '声纹扇面';
    subtitle = `「${shortQuote}」 · ${dur.toFixed(2)} 秒${fanKind}`;
    sideLabel = `折扇声谱 · ${dur.toFixed(2)}s`;
  } else {
    // risograph
    title = '声音印画';
    subtitle = shortQuote;
    sideLabel = `RISOGRAPH SOUND PRINT  ·  ${dur.toFixed(2)}s`;
  }

  const footer = `时长 ${dur.toFixed(2)} 秒 (${tMin.toFixed(2)}–${tMax.toFixed(2)}s) · ${srStr} · ${stem}`;

  return {
    title,
    subtitle,
    footer,
    centerQuote,
    sideLabel
  };
}

/** Wrap short quote into 1–2 optically balanced centered lines for Vinyl center label. */
export function wrapCenterLabelQuote(quote: string): [string, string] {
  // Strip outer quotes if already wrapped so we never double-wrap
  const base = quote.replace(/^[“"「『]+|[”"」』]+$/g, '').trim() || quote;
  const labelFont = `500 6.4px ${POSTER_SANS_STACK}`;
  const maxLinePx = 76.0;
  if (measurePx(`“${base}”`, labelFont) <= maxLinePx) {
    return [`“${base}”`, ''];
  }

  const gs = splitGraphemes(base);
  const fullW = measurePx(base, labelFont);
  const targetHalf = fullW * 0.5;
  let bestSplit = Math.max(1, Math.floor(gs.length / 2));
  let bestScore = Infinity;

  for (let i = 2; i < gs.length - 1; i++) {
    const l1 = gs.slice(0, i).join('').trim();
    const l2 = gs.slice(i).join('').trim();
    if (!l1 || !l2) continue;
    const w1 = measurePx(l1, labelFont);
    const w2 = measurePx(l2, labelFont);
    const prev = gs[i - 1];
    const curr = gs[i];
    const isBreak = curr === ' ' || /[？。！，?!,]/.test(prev);
    const balance = Math.abs(w1 - targetHalf) + Math.abs(w2 - targetHalf);
    const penalty = isBreak ? 0 : 12.0;
    const score = balance + penalty;
    if (score < bestScore) {
      bestScore = score;
      bestSplit = i;
    }
  }

  const line1 = gs.slice(0, bestSplit).join('').trim();
  const line2Raw = gs.slice(bestSplit).join('').trim();
  const line2 =
    measurePx(`${line2Raw}”`, labelFont) > maxLinePx
      ? truncateByGraphemes(line2Raw, maxLinePx - 6, labelFont)
      : line2Raw;
  return [`“${line1}`, `${line2}”`];
}

/** Compute non-empty interval count for a tier inside [tMin, tMax]. */
export function countActiveIntervals(tier: Tier, tMin: number, tMax: number): number {
  let count = 0;
  for (const iv of tier.intervals) {
    if (iv.xmax <= tMin + 1e-7 || iv.xmin >= tMax - 1e-7) continue;
    if (resolvePosterText(iv.text) !== '') count++;
  }
  return count;
}

/** Render 3mm print bleed crop & registration marks inside `#print-marks`. */
export function renderPrintMarksSvg(trimW: number, trimH: number, bleed: number): string {
  const markLen = 6.0;
  const gap = 2.0;
  const c = '#161514';
  const lines: string[] = [];

  // 4 corners: top-left (0,0), top-right (trimW,0), bottom-left (0,trimH), bottom-right (trimW,trimH)
  const corners: Array<[number, number, number, number]> = [
    [0, 0, -1, -1],
    [trimW, 0, 1, -1],
    [0, trimH, -1, 1],
    [trimW, trimH, 1, 1]
  ];
  for (const [x, y, sx, sy] of corners) {
    // Horizontal tick outside trim
    lines.push(
      `<line x1="${fmtNum(x + sx * gap)}" y1="${fmtNum(y)}" x2="${fmtNum(x + sx * (gap + markLen))}" y2="${fmtNum(y)}" stroke="${c}" stroke-width="0.45"/>`
    );
    // Vertical tick outside trim
    lines.push(
      `<line x1="${fmtNum(x)}" y1="${fmtNum(y + sy * gap)}" x2="${fmtNum(x)}" y2="${fmtNum(y + sy * (gap + markLen))}" stroke="${c}" stroke-width="0.45"/>`
    );
  }

  // Subtle top/bottom/left/right center registration crosses in bleed margin
  const regPos: Array<[number, number]> = [
    [trimW * 0.5, -bleed * 0.55],
    [trimW * 0.5, trimH + bleed * 0.55],
    [-bleed * 0.55, trimH * 0.5],
    [trimW + bleed * 0.55, trimH * 0.5]
  ];
  for (const [rx, ry] of regPos) {
    lines.push(
      `<circle cx="${fmtNum(rx)}" cy="${fmtNum(ry)}" r="1.8" fill="none" stroke="${c}" stroke-width="0.35"/>` +
        `<line x1="${fmtNum(rx - 3.2)}" y1="${fmtNum(ry)}" x2="${fmtNum(rx + 3.2)}" y2="${fmtNum(ry)}" stroke="${c}" stroke-width="0.35"/>` +
        `<line x1="${fmtNum(rx)}" y1="${fmtNum(ry - 3.2)}" x2="${fmtNum(rx)}" y2="${fmtNum(ry + 3.2)}" stroke="${c}" stroke-width="0.35"/>`
    );
  }

  return `<g id="print-marks">${lines.join('')}</g>`;
}

/** Helper to check if a timestamp matches any boundary in a sorted list within tolerance. */
export function hasBoundaryNear(sortedBnds: number[], t: number, eps = 1e-6): boolean {
  let lo = 0;
  let hi = sortedBnds.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const diff = sortedBnds[mid] - t;
    if (Math.abs(diff) <= eps) return true;
    if (diff < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Find parent interval index (for Bauhaus Ring 3 parent color accent bar). */
export function findParentIntervalIndex(parentIvs: Interval[], xm0: number, xm1: number): number {
  const mid = 0.5 * (xm0 + xm1);
  let activeIdx = 0;
  for (const iv of parentIvs) {
    if (resolvePosterText(iv.text) === '') continue;
    if (iv.xmin - 1e-5 <= mid && mid <= iv.xmax + 1e-5) return activeIdx;
    activeIdx++;
  }
  return 0;
}

export interface TrueDurationSpan {
  a: number;
  b: number;
  ringIndex: number;
  activeOrder: number;
  isEmpty: boolean;
}

/**
 * Builds complete 1:1 true-duration coverage spans across all active rings so that:
 * - Hierarchical 3..6 tier TextGrids use Ring 1 (word tier) verbatim like the exhibition references.
 * - Multi-speaker / 2-tier dialogues cover EVERY active speaker's speech segments with their matching ring index!
 */
export function buildTrueDurationSpans(tg: TextGrid, layout: PolarLayout): TrueDurationSpan[] {
  const nRings = layout.rings.length;
  if (nRings === 0) return [];

  // Classic umbrella hierarchy (e.g. 5-tier utterance -> word -> pinyin -> IPA) or single ring
  if (layout.ring0IsUmbrella || nRings === 1) {
    const refRingIndex = layout.ring0IsUmbrella ? 1 : 0;
    const refTier = tg.tiers[layout.rings[refRingIndex].tierIdx];
    const spans: TrueDurationSpan[] = [];
    let activeOrder = 0;
    for (const iv of refTier.intervals) {
      const a = Math.max(layout.tMin, iv.xmin);
      const b = Math.min(layout.tMax, iv.xmax);
      if (b <= a + 1e-7) continue;
      const isEmpty = resolvePosterText(iv.text) === '';
      spans.push({
        a,
        b,
        ringIndex: refRingIndex,
        activeOrder: isEmpty ? -1 : activeOrder++,
        isEmpty
      });
    }
    return spans;
  }

  // Multi-tier parallel / dialogue coverage across elementary columns
  // Look across Ring 0 and Ring 1 (or all rings up to 2) so every speaker turn is represented!
  const candidateRings = layout.rings.slice(0, Math.min(2, nRings));
  const rawSpans: Array<{ a: number; b: number; ringIndex: number; ivIdx: number; isEmpty: boolean }> = [];

  for (const col of layout.cols) {
    const mid = 0.5 * (col.a + col.b);
    let chosenRing = -1;
    let chosenIv = -1;
    for (let k = 0; k < candidateRings.length; k++) {
      const r = candidateRings[k];
      const tier = tg.tiers[r.tierIdx];
      const ivIdx = tier.intervals.findIndex(
        (iv) => iv.xmin - 1e-6 <= mid && mid <= iv.xmax + 1e-6 && resolvePosterText(iv.text) !== ''
      );
      if (ivIdx >= 0) {
        chosenRing = r.ringIndex;
        chosenIv = ivIdx;
        break;
      }
    }
    const isEmpty = chosenRing < 0;
    const prev = rawSpans[rawSpans.length - 1];
    if (
      prev &&
      prev.isEmpty === isEmpty &&
      prev.ringIndex === chosenRing &&
      prev.ivIdx === chosenIv &&
      Math.abs(prev.b - col.a) <= 1e-6
    ) {
      prev.b = col.b;
    } else {
      rawSpans.push({ a: col.a, b: col.b, ringIndex: chosenRing, ivIdx: chosenIv, isEmpty });
    }
  }

  let activeOrder = 0;
  return rawSpans.map((sp) => ({
    a: sp.a,
    b: sp.b,
    ringIndex: sp.ringIndex,
    activeOrder: sp.isEmpty ? -1 : activeOrder++,
    isEmpty: sp.isEmpty
  }));
}
