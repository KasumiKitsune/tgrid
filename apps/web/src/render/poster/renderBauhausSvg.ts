import type { TextGrid } from '../../bridge/types';
import { splitGraphemes } from '../../layout/richText';
import {
  BAUHAUS_END_DEG,
  BAUHAUS_R_BRIDGE0,
  BAUHAUS_R_DUR0,
  BAUHAUS_R_DUR1,
  BAUHAUS_R_SPEC0,
  BAUHAUS_R_SPEC1,
  BAUHAUS_R_WAVE0,
  BAUHAUS_R_WAVE1,
  BAUHAUS_START_DEG,
  BAUHAUS_TOTAL_DEG,
  POSTER_DISPLAY_SANS_STACK,
  POSTER_IPA_STACK,
  POSTER_MONO_STACK,
  POSTER_SANS_STACK,
  buildTrueDurationSpans,
  countActiveIntervals,
  escapeXml,
  findParentIntervalIndex,
  fmtNum,
  formatCleanSecTick,
  hasBoundaryNear,
  hasCombiningMarks,
  polarPtBauhaus,
  renderBauhausCurvedSpanSvg,
  renderBauhausSyllableTokenSvg,
  renderBauhausUprightTokenSvg,
  renderPrintMarksSvg,
  resolvePosterText,
  svgArcPathBauhaus,
  svgSectorPathBauhaus,
  timeToAngle,
  truncateByGraphemes
} from './polarSolver';
import {
  POSTER_BLEED_PT,
  type PolarDiscRasterResult,
  type PolarLayout,
  type PosterAutoCopy,
  type PosterConfig
} from './types';

const PAL = {
  paper: '#F2ECE1',
  paperHi: '#FAF7F0',
  sand: '#E5DEC9',
  sandSoft: '#EDE7D8',
  sandLine: '#CFC7B4',
  muted: '#6E675C',
  ink: '#161514',
  red: '#D93829',
  blue: '#1B4F9C',
  yellow: '#EAB308',
  tickGray: '#5A534A'
};

const WORD_TRIAD: Array<[string, string]> = [
  [PAL.red, PAL.paperHi],
  [PAL.yellow, PAL.ink],
  [PAL.blue, PAL.paperHi]
];

const POINT_BADGE_CYCLE = [PAL.red, PAL.yellow, PAL.ink, PAL.blue, PAL.blue, PAL.ink];

function isRedNuanceToken(txt: string): boolean {
  // Highlight unreleased stops, creaky/stacked diacritics in vermilion like reference
  const marks = txt.match(/\p{M}/gu);
  return (marks ? marks.length >= 2 : false) || txt.includes('\u031A') || txt.includes('\u0330');
}

type BauhausRingRole = 0 | 1 | 2 | 3 | 4;

/** Single source of truth for ring visual hierarchy role (used for BOTH sunburst & swatch legend!). */
function getBauhausRingRole(rIdx: number, nRings: number, isIpaLike: boolean): BauhausRingRole {
  if (nRings === 1) return isIpaLike ? 4 : 1;
  if (nRings === 2) return rIdx === 0 ? 1 : isIpaLike ? 4 : 2;
  if (nRings === 3) return rIdx === 0 ? 0 : rIdx === 1 ? 1 : isIpaLike ? 4 : 2;
  if (nRings === 4) return rIdx === 0 ? 0 : rIdx === 1 ? 1 : rIdx === 2 ? (isIpaLike ? 3 : 2) : 4;
  return rIdx === 0 ? 0 : rIdx === 1 ? 1 : rIdx === 2 ? 2 : rIdx === nRings - 1 ? 4 : 3;
}

export interface RenderBauhausParams {
  tg: TextGrid;
  layout: PolarLayout;
  config: PosterConfig;
  autoCopy: PosterAutoCopy;
  discRaster: PolarDiscRasterResult | null;
  waveformBins: Array<[number, number]> | null;
  f0Runs: Array<Array<{ t: number; normF0: number }>>;
  hasAudio: boolean;
  audioSampleRate: number;
  maxFreq: number;
  previewMode: boolean;
}

export function renderBauhausPosterSvg(params: RenderBauhausParams): {
  svgMarkup: string;
  widthPt: number;
  heightPt: number;
  trimWidthPt: number;
  trimHeightPt: number;
  bleedPt: number;
} {
  const {
    tg,
    layout,
    config,
    autoCopy,
    discRaster,
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

  const cx = layout.cx;
  const cy = layout.cy;
  const idPfx = previewMode ? 'pv-b-' : 'ex-b-';

  // Fit 224-deg sunburst cleanly inside 1:1 emblem
  const maxOuterR = Math.max(layout.rTone + 16, layout.rBadge + 18);
  const emblemScale = isEmblem ? Math.min(1.04, 412.0 / Math.max(260, maxOuterR)) : 1.0;

  const specClipPath = svgSectorPathBauhaus(
    cx,
    cy,
    BAUHAUS_R_SPEC0,
    BAUHAUS_R_SPEC1,
    BAUHAUS_START_DEG,
    BAUHAUS_END_DEG
  );

  const defs = `<clipPath id="${idPfx}spec-clip"><path d="${specClipPath}"/></clipPath>`;

  // --------------------------------------------------------------------------
  // #paper-bg (omitted when bgMode === 'transparent')
  // --------------------------------------------------------------------------
  const paperBgGroup =
    config.bgMode === 'transparent'
      ? ''
      : `<g id="paper-bg"><rect x="${fmtNum(-bleed)}" y="${fmtNum(-bleed)}" width="${fmtNum(widthPt)}" height="${fmtNum(heightPt)}" fill="${PAL.paper}"/></g>`;

  // --------------------------------------------------------------------------
  // #dial-base (Moholy-Nagy Diagonal Beam + Core Geometric Triad + Polar Spec)
  // --------------------------------------------------------------------------
  const dialBaseParts: string[] = [];

  // Sand core circle
  dialBaseParts.push(
    `<circle cx="${fmtNum(cx - 20)}" cy="${fmtNum(cy + 24)}" r="74" fill="${PAL.sand}" fill-opacity="0.65"/>`
  );

  // Diagonal beam (-38 deg)
  const beamAngDeg = -38.0;
  const beamRad = (beamAngDeg * Math.PI) / 180;
  const ux = Math.cos(beamRad);
  const uy = Math.sin(beamRad);
  const nx = -uy;
  const ny = ux;
  const sTailScale = isEmblem ? 0.72 : 1.0;

  const beamSpecs: Array<[number, number, number, number, string, number]> = [
    [-295.0 * sTailScale, 92.0, 0.0, 4.5, PAL.ink, 1.0],
    [-235.0 * sTailScale, 58.0, 8.5, 9.0, PAL.red, 0.92],
    [-265.0 * sTailScale, 88.0, -6.0, 0.9, PAL.ink, 0.5]
  ];
  for (const [s0, s1, nOff, thick, col, alpha] of beamSpecs) {
    const p0x = cx + s0 * ux + nOff * nx;
    const p0y = cy + s0 * uy + nOff * ny;
    const p1x = cx + s1 * ux + nOff * nx;
    const p1y = cy + s1 * uy + nOff * ny;
    const poly = [
      [p0x - 0.5 * thick * nx, p0y - 0.5 * thick * ny],
      [p1x - 0.5 * thick * nx, p1y - 0.5 * thick * ny],
      [p1x + 0.5 * thick * nx, p1y + 0.5 * thick * ny],
      [p0x + 0.5 * thick * nx, p0y + 0.5 * thick * ny]
    ]
      .map(([x, y]) => `${fmtNum(x)},${fmtNum(y)}`)
      .join(' ');
    dialBaseParts.push(`<polygon points="${poly}" fill="${col}" fill-opacity="${alpha}"/>`);
  }

  // Angled caption along diagonal beam (shown in full poster mode unless pureVisual)
  if (!isEmblem && !config.pureVisual) {
    const sTxt = -182.0;
    const txB = cx + sTxt * ux + 21.0 * nx;
    const tyB = cy + sTxt * uy + 21.0 * ny;
    const beamCaption = `${layout.tMin.toFixed(2)} – ${layout.tMax.toFixed(2)} 秒  ·  ${
      hasAudio ? '内圈真实声音 / 外圈分层文字' : '内圈时间轴 / 外圈分层文字'
    }`;
    dialBaseParts.push(
      `<text x="0" y="0" transform="translate(${fmtNum(txB)} ${fmtNum(tyB)}) rotate(${fmtNum(beamAngDeg)})" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.8" font-weight="700" fill="${PAL.ink}" text-anchor="middle" dominant-baseline="central">${escapeXml(beamCaption)}</text>`
    );
  }

  // Core Geometric Triad (yellow disk, cobalt ring, center spindle with genuinely transparent hole)
  const spindlePath =
    `M ${fmtNum(cx - 6.0)} ${fmtNum(cy)} ` +
    `a 6 6 0 1 0 12 0 a 6 6 0 1 0 -12 0 ` +
    `M ${fmtNum(cx - 2.2)} ${fmtNum(cy)} ` +
    `a 2.2 2.2 0 1 0 4.4 0 a 2.2 2.2 0 1 0 -4.4 0 Z`;
  dialBaseParts.push(
    `<circle cx="${fmtNum(cx + 10)}" cy="${fmtNum(cy - 8)}" r="30" fill="${PAL.yellow}" fill-opacity="0.90"/>`,
    `<circle cx="${fmtNum(cx - 7)}" cy="${fmtNum(cy + 5)}" r="39" fill="none" stroke="${PAL.blue}" stroke-width="2.0"/>`,
    config.bgMode === 'transparent'
      ? `<path d="${spindlePath}" fill="${PAL.ink}" fill-rule="evenodd"/>`
      : `<circle cx="${fmtNum(cx)}" cy="${fmtNum(cy)}" r="6.0" fill="${PAL.ink}"/><circle cx="${fmtNum(cx)}" cy="${fmtNum(cy)}" r="2.2" fill="${PAL.paper}"/>`
  );

  // Polar Spectrogram Surface OR Crisp Architectural Concentric Rings (No-Audio mode)
  if (discRaster?.dataUrl) {
    dialBaseParts.push(
      `<g clip-path="url(#${idPfx}spec-clip)">` +
        `<image x="${fmtNum(discRaster.xPt)}" y="${fmtNum(discRaster.yPt)}" width="${fmtNum(discRaster.widthPt)}" height="${fmtNum(discRaster.heightPt)}" href="${discRaster.dataUrl}" preserveAspectRatio="none"/>` +
        `</g>`
    );
  } else {
    // Pure Bauhaus architectural concentric rings when audio/spectrogram is off
    dialBaseParts.push(`<path d="${specClipPath}" fill="${PAL.sandSoft}" fill-opacity="0.58"/>`);
    for (const frac of [0.25, 0.5, 0.75]) {
      const rGuide = BAUHAUS_R_SPEC0 + frac * (BAUHAUS_R_SPEC1 - BAUHAUS_R_SPEC0);
      dialBaseParts.push(
        `<path d="${svgArcPathBauhaus(cx, cy, rGuide, BAUHAUS_START_DEG, BAUHAUS_END_DEG)}" fill="none" stroke="${PAL.sandLine}" stroke-width="0.5" stroke-dasharray="2.2 2.4"/>`
      );
    }
  }

  // Spectrogram band boundary arcs
  dialBaseParts.push(
    `<path d="${svgArcPathBauhaus(cx, cy, BAUHAUS_R_SPEC0, BAUHAUS_START_DEG, BAUHAUS_END_DEG)}" fill="none" stroke="${PAL.sandLine}" stroke-width="0.6"/>`,
    `<path d="${svgArcPathBauhaus(cx, cy, BAUHAUS_R_SPEC1, BAUHAUS_START_DEG, BAUHAUS_END_DEG)}" fill="none" stroke="${PAL.sandLine}" stroke-width="0.6"/>`
  );

  // Frequency ticks along PHI_START (cleanly aligned along tangent normal, well clear of diagonal beam)
  if (hasAudio && config.showSpectrogram) {
    const phiStartRad = (BAUHAUS_START_DEG * Math.PI) / 180;
    const tx = -Math.cos(phiStartRad);
    const ty = -Math.sin(phiStartRad);
    const maxK = maxFreq / 1000;
    const midK = maxK * 0.5;
    for (const [frac, lbl] of [
      [0, '0k'],
      [0.5, Number.isInteger(midK) ? `${midK}k` : `${midK.toFixed(1)}k`],
      [1, Number.isInteger(maxK) ? `${maxK}k` : `${maxK.toFixed(1)}k`]
    ] as const) {
      const rf = BAUHAUS_R_SPEC0 + frac * (BAUHAUS_R_SPEC1 - BAUHAUS_R_SPEC0);
      const [px, py] = polarPtBauhaus(cx, cy, rf, BAUHAUS_START_DEG);
      dialBaseParts.push(
        `<line x1="${fmtNum(px)}" y1="${fmtNum(py)}" x2="${fmtNum(px + tx * 3.8)}" y2="${fmtNum(py + ty * 3.8)}" stroke="${PAL.ink}" stroke-width="0.7"/>`,
        `<text x="${fmtNum(px + tx * 9.8)}" y="${fmtNum(py + ty * 9.8)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="6.1" font-weight="600" fill="${PAL.muted}" text-anchor="middle" dominant-baseline="central">${escapeXml(lbl)}</text>`
      );
    }
  }

  // --------------------------------------------------------------------------
  // #acoustic-traces (True-Duration Word Bar + F0 Pitch + Waveform + Silk Bridge)
  // --------------------------------------------------------------------------
  const acousticParts: string[] = [];

  // 1:1 True-Duration Reference Arc (`rDur0..rDur1`) with full multi-tier coverage!
  const trueSpans = buildTrueDurationSpans(tg, layout);
  for (const sp of trueSpans) {
    const p0 = timeToAngle(sp.a, layout.bnds, layout.thetaLin);
    const p1 = timeToAngle(sp.b, layout.bnds, layout.thetaLin);
    const col = sp.isEmpty ? PAL.sand : WORD_TRIAD[sp.activeOrder % WORD_TRIAD.length][0];
    if (p1 - p0 > 0.25) {
      const d = svgSectorPathBauhaus(cx, cy, BAUHAUS_R_DUR0, BAUHAUS_R_DUR1, p0 + 0.09, p1 - 0.09);
      if (d) acousticParts.push(`<path d="${d}" fill="${col}"/>`);
    }
  }

  // F0 Pitch Contour Overlay (paper halo + Bauhaus yellow)
  if (config.showPitch && f0Runs.length > 0) {
    for (const run of f0Runs) {
      const pts: string[] = [];
      for (let i = 0; i < run.length; i++) {
        const degT = BAUHAUS_START_DEG + ((run[i].t - layout.tMin) / layout.duration) * BAUHAUS_TOTAL_DEG;
        const clamped = Math.max(0.05, Math.min(0.95, run[i].normF0));
        const rF = BAUHAUS_R_SPEC0 + clamped * (BAUHAUS_R_SPEC1 - BAUHAUS_R_SPEC0);
        const [px, py] = polarPtBauhaus(cx, cy, rF, degT);
        pts.push(`${i === 0 ? 'M' : 'L'}${fmtNum(px, 1)} ${fmtNum(py, 1)}`);
      }
      const d = pts.join('');
      acousticParts.push(
        `<path d="${d}" fill="none" stroke="${PAL.paper}" stroke-width="2.0" stroke-linecap="round" stroke-linejoin="round"/>`,
        `<path d="${d}" fill="none" stroke="${PAL.yellow}" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    }
  }

  // 1:1 Polar Waveform Envelope (`rWave0..rWave1`)
  const rWmid = 0.5 * (BAUHAUS_R_WAVE0 + BAUHAUS_R_WAVE1);
  const rWhalf = 0.48 * (BAUHAUS_R_WAVE1 - BAUHAUS_R_WAVE0);
  acousticParts.push(
    `<path d="${svgArcPathBauhaus(cx, cy, rWmid, BAUHAUS_START_DEG, BAUHAUS_END_DEG)}" fill="none" stroke="${PAL.sandLine}" stroke-width="0.5"/>`
  );
  if (config.showWaveform && waveformBins && waveformBins.length >= 4) {
    const nBins = waveformBins.length;
    const outPts: string[] = [];
    const inPts: string[] = [];
    for (let k = 0; k < nBins; k++) {
      const [vmin, vmax] = waveformBins[k];
      const degK = BAUHAUS_START_DEG + ((k + 0.5) / nBins) * BAUHAUS_TOTAL_DEG;
      const [ox, oy] = polarPtBauhaus(cx, cy, rWmid + vmax * rWhalf, degK);
      const [ix, iy] = polarPtBauhaus(cx, cy, rWmid + vmin * rWhalf, degK);
      outPts.push(`${k === 0 ? 'M' : 'L'}${fmtNum(ox, 1)} ${fmtNum(oy, 1)}`);
      inPts.push(`L${fmtNum(ix, 1)} ${fmtNum(iy, 1)}`);
    }
    inPts.reverse();
    acousticParts.push(`<path d="${outPts.join('')}${inPts.join('')}Z" fill="${PAL.ink}"/>`);
  }

  // Hierarchical 3-Segment Kinked Polyline Warp Bridge (`rBridge0..layout.rBridgeOut`)
  if (layout.rings.length > 0) {
    const rBridge1 = layout.rBridgeOut;
    let lastLin = -999;
    let lastVar = -999;
    for (let i = 0; i < layout.bnds.length; i++) {
      const bt = layout.bnds[i];
      if (bt > layout.tMin + 1e-7 && bt - layout.tMin < 0.01) continue;
      const isEnd = i === 0 || i === layout.bnds.length - 1;
      const isWord = hasBoundaryNear(layout.wordBoundaries, bt);
      const pt = layout.thetaLin[i];
      const pa = layout.thetaVar[i];
      // Declutter ultra-dense sub-boundaries that sit within 0.75 deg on both inner & outer rims
      if (!isEnd && !isWord && Math.abs(pt - lastLin) < 0.75 && Math.abs(pa - lastVar) < 0.75) {
        continue;
      }
      lastLin = pt;
      lastVar = pa;
      const [p0x, p0y] = polarPtBauhaus(cx, cy, BAUHAUS_R_BRIDGE0, pt);
      const [p1x, p1y] = polarPtBauhaus(cx, cy, BAUHAUS_R_BRIDGE0 + 4.0, pt);
      const [p2x, p2y] = polarPtBauhaus(cx, cy, rBridge1 - 4.0, pa);
      const [p3x, p3y] = polarPtBauhaus(cx, cy, rBridge1 - 0.8, pa);
      const stroke = isEnd || isWord ? PAL.ink : PAL.muted;
      const op = isEnd || isWord ? 1.0 : 0.42;
      const sw = isEnd ? 1.2 : isWord ? 0.95 : 0.45;
      acousticParts.push(
        `<polyline points="${fmtNum(p0x)},${fmtNum(p0y)} ${fmtNum(p1x)},${fmtNum(p1y)} ${fmtNum(p2x)},${fmtNum(p2y)} ${fmtNum(p3x)},${fmtNum(p3y)}" fill="none" stroke="${stroke}" stroke-opacity="${op}" stroke-width="${sw}"/>`
      );
    }
  }

  // --------------------------------------------------------------------------
  // #interval-rings (Dynamic 1..6 Bauhaus Primary Hierarchy Sunburst Rings)
  // --------------------------------------------------------------------------
  const ringsParts: string[] = [];
  const seamDeg = 0.14;
  const nRings = layout.rings.length;
  const wordTier = nRings >= 2 ? tg.tiers[layout.rings[layout.ring0IsUmbrella ? 1 : 0].tierIdx] : null;
  const ringRoles: BauhausRingRole[] = layout.rings.map((r, idx) =>
    getBauhausRingRole(idx, nRings, r.isIpaLike)
  );

  for (let rIdx = 0; rIdx < nRings; rIdx++) {
    const ring = layout.rings[rIdx];
    const tier = tg.tiers[ring.tierIdx];
    const role = ringRoles[rIdx];

    let activeCounter = 0;
    for (const iv of tier.intervals) {
      const a = Math.max(layout.tMin, iv.xmin);
      const b = Math.min(layout.tMax, iv.xmax);
      if (b <= a + 1e-7) continue;
      const d0 = timeToAngle(a, layout.bnds, layout.thetaVar);
      const d1 = timeToAngle(b, layout.bnds, layout.thetaVar);
      if (d1 - d0 <= 2 * seamDeg) continue;

      const txt = resolvePosterText(iv.text);
      if (!txt) {
        const emptyPath = svgSectorPathBauhaus(
          cx,
          cy,
          ring.rIn + 1.0,
          ring.rOut - 1.0,
          d0 + seamDeg,
          d1 - seamDeg
        );
        if (emptyPath) ringsParts.push(`<path d="${emptyPath}" fill="${PAL.sand}"/>`);
        continue;
      }

      const secPath = svgSectorPathBauhaus(cx, cy, ring.rIn, ring.rOut, d0 + seamDeg, d1 - seamDeg);
      if (!secPath) continue;

      if (role === 0) {
        ringsParts.push(`<path d="${secPath}" fill="${PAL.ink}"/>`);
        ringsParts.push(
          renderBauhausCurvedSpanSvg({
            cx,
            cy,
            rMid: ring.rMid,
            deg0: d0,
            deg1: d1,
            text: txt,
            fontSize: ring.fontSize,
            fontWeight: 700,
            fontFamily: POSTER_SANS_STACK,
            fill: PAL.paperHi,
            letterSpacingPt: 0.85
          })
        );
      } else if (role === 1) {
        const [bgC, fgC] = WORD_TRIAD[activeCounter++ % WORD_TRIAD.length];
        ringsParts.push(`<path d="${secPath}" fill="${bgC}"/>`);
        const gLen = splitGraphemes(txt).length;
        const isLongLatin = /^[A-Za-z0-9\s\-_]+$/.test(txt) && txt.length >= 5;
        const spanDeg = d1 - d0;
        // Prefer smooth tangential curved text for multi-char phrases so side-angle wedges never squash!
        if (txt.includes(' ') || isLongLatin || gLen >= 4 || (gLen >= 3 && spanDeg > 16) || spanDeg > 22) {
          ringsParts.push(
            renderBauhausCurvedSpanSvg({
              cx,
              cy,
              rMid: ring.rMid,
              deg0: d0,
              deg1: d1,
              text: txt,
              fontSize: ring.fontSize,
              fontWeight: 700,
              fontFamily: POSTER_SANS_STACK,
              fill: fgC,
              letterSpacingPt: 0.4
            })
          );
        } else if (gLen === 1) {
          ringsParts.push(
            renderBauhausUprightTokenSvg({
              cx,
              cy,
              rIn: ring.rIn,
              rOut: ring.rOut,
              deg0: d0,
              deg1: d1,
              text: txt,
              fontSize: ring.fontSize,
              fontWeight: 700,
              fontFamily: POSTER_SANS_STACK,
              fill: fgC
            })
          );
        } else {
          ringsParts.push(
            renderBauhausSyllableTokenSvg({
              cx,
              cy,
              rIn: ring.rIn,
              rOut: ring.rOut,
              deg0: d0,
              deg1: d1,
              text: txt,
              fontSize: ring.fontSize,
              fontWeight: 700,
              fontFamily: POSTER_SANS_STACK,
              fill: fgC
            })
          );
        }
      } else if (role === 2) {
        const bgC = activeCounter++ % 2 === 0 ? PAL.paperHi : PAL.sandSoft;
        const pwIdx =
          wordTier && layout.ring0IsUmbrella
            ? findParentIntervalIndex(wordTier.intervals, a, b)
            : activeCounter - 1;
        const accent = WORD_TRIAD[pwIdx % WORD_TRIAD.length][0];
        ringsParts.push(
          `<path d="${secPath}" fill="${bgC}" stroke="${PAL.sandLine}" stroke-width="0.65"/>`
        );
        const accentBar = svgSectorPathBauhaus(cx, cy, ring.rIn, ring.rIn + 3.2, d0 + seamDeg, d1 - seamDeg);
        if (accentBar) ringsParts.push(`<path d="${accentBar}" fill="${accent}"/>`);

        const gLen = splitGraphemes(txt).length;
        const spanDeg = d1 - d0;
        const role2Fs = nRings <= 2 ? Math.min(ring.fontSize, 10.6) : Math.min(ring.fontSize, 8.8);
        if (txt.includes(' ') || gLen >= 4 || (gLen >= 3 && spanDeg > 16) || spanDeg > 22) {
          ringsParts.push(
            renderBauhausCurvedSpanSvg({
              cx,
              cy,
              rMid: ring.rMid + 1.2,
              deg0: d0,
              deg1: d1,
              text: txt,
              fontSize: role2Fs,
              fontWeight: 700,
              fontFamily: ring.isIpaLike ? POSTER_IPA_STACK : POSTER_SANS_STACK,
              fill: PAL.ink,
              letterSpacingPt: ring.isIpaLike ? 0.15 : 0.3
            })
          );
        } else {
          ringsParts.push(
            renderBauhausSyllableTokenSvg({
              cx,
              cy,
              rIn: ring.rIn + 2.8,
              rOut: ring.rOut,
              deg0: d0,
              deg1: d1,
              text: txt,
              fontSize: role2Fs,
              fontWeight: 700,
              fontFamily: ring.isIpaLike ? POSTER_IPA_STACK : POSTER_SANS_STACK,
              fill: PAL.ink
            })
          );
        }
      } else if (role === 3) {
        const bgC = activeCounter++ % 2 === 0 ? PAL.paperHi : PAL.sandSoft;
        ringsParts.push(
          `<path d="${secPath}" fill="${bgC}" stroke="${PAL.sandLine}" stroke-width="0.65"/>`
        );
        const gLen = splitGraphemes(txt).length;
        const useUpright = !txt.includes(' ') && gLen <= 3 && d1 - d0 <= 26;
        ringsParts.push(
          useUpright
            ? renderBauhausUprightTokenSvg({
                cx,
                cy,
                rIn: ring.rIn,
                rOut: ring.rOut,
                deg0: d0,
                deg1: d1,
                text: txt,
                fontSize: ring.fontSize,
                fontWeight: 700,
                fontFamily: POSTER_IPA_STACK,
                fill: PAL.ink
              })
            : renderBauhausCurvedSpanSvg({
                cx,
                cy,
                rMid: ring.rMid,
                deg0: d0,
                deg1: d1,
                text: txt,
                fontSize: ring.fontSize,
                fontWeight: 600,
                fontFamily: POSTER_IPA_STACK,
                fill: PAL.ink,
                letterSpacingPt: 0.15
              })
        );
      } else {
        // Role 4 (outermost / narrow IPA): highlight atomic tokens with combining diacritics in yellow/red;
        // curve longer or multi-word phrases cleanly along the arc so they never spill out of slanted sectors.
        const gLen = splitGraphemes(txt).length;
        const isShortAtomic = !txt.includes(' ') && gLen <= 3;
        const isNuance = ring.isIpaLike && isShortAtomic && hasCombiningMarks(txt);
        let bgC: string;
        let fgC: string;
        if (isNuance) {
          const useRed = isRedNuanceToken(txt);
          bgC = useRed ? PAL.red : PAL.yellow;
          fgC = useRed ? PAL.paperHi : PAL.ink;
        } else {
          bgC = activeCounter % 2 === 0 ? PAL.paperHi : PAL.sandSoft;
          fgC = PAL.ink;
        }
        activeCounter++;
        ringsParts.push(
          `<path d="${secPath}" fill="${bgC}" stroke="${isNuance ? PAL.ink : PAL.sandLine}" stroke-width="${isNuance ? 0.85 : 0.65}"/>`
        );
        const useUpright = isShortAtomic && d1 - d0 <= 26;
        ringsParts.push(
          useUpright
            ? renderBauhausUprightTokenSvg({
                cx,
                cy,
                rIn: ring.rIn,
                rOut: ring.rOut,
                deg0: d0,
                deg1: d1,
                text: txt,
                fontSize: ring.fontSize,
                fontWeight: 700,
                fontFamily: POSTER_IPA_STACK,
                fill: fgC
              })
            : renderBauhausCurvedSpanSvg({
                cx,
                cy,
                rMid: ring.rMid,
                deg0: d0,
                deg1: d1,
                text: txt,
                fontSize: ring.fontSize,
                fontWeight: 600,
                fontFamily: POSTER_IPA_STACK,
                fill: fgC,
                letterSpacingPt: 0.15
              })
        );
      }
    }

    // Clean `01`..`0N` tier index markers aligned along a constant 12pt parallel offset before BAUHAUS_START_DEG
    const idxDegOff = ((12.0 / Math.max(120, ring.rMid)) * 180) / Math.PI;
    const [ix, iy] = polarPtBauhaus(cx, cy, ring.rMid, BAUHAUS_START_DEG - idxDegOff);
    ringsParts.push(
      `<text x="${fmtNum(ix)}" y="${fmtNum(iy)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="6.5" font-weight="700" fill="${PAL.muted}" text-anchor="middle" dominant-baseline="central">${String(rIdx + 1).padStart(2, '0')}</text>`
    );
  }

  // --------------------------------------------------------------------------
  // #point-dial (Orbital Wire, Clean Timestamps & Concentric Numbered Halo)
  // --------------------------------------------------------------------------
  const pointDialParts: string[] = [];

  pointDialParts.push(
    `<path d="${svgArcPathBauhaus(cx, cy, layout.rTone, BAUHAUS_START_DEG, BAUHAUS_END_DEG)}" fill="none" stroke="${PAL.ink}" stroke-width="1.0"/>`
  );
  if (layout.pointTierName) {
    const ptIdxDegOff = ((13.0 / Math.max(120, layout.rTone)) * 180) / Math.PI;
    const [ix, iy] = polarPtBauhaus(cx, cy, layout.rTone - 2.0, BAUHAUS_START_DEG - ptIdxDegOff);
    pointDialParts.push(
      `<text x="${fmtNum(ix)}" y="${fmtNum(iy)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="6.5" font-weight="700" fill="${PAL.muted}" text-anchor="middle" dominant-baseline="central">${String(nRings + 1).padStart(2, '0')}</text>`
    );
  }

  // Pre-compute adjusted badge angles so endpoint badges never collide with red 0 / tMax labels
  const resolvedBadges = layout.points.map((pt) => {
    let badgeDeg = pt.badgeAngleDeg;
    if (badgeDeg - BAUHAUS_START_DEG < 4.2) {
      badgeDeg = Math.min(BAUHAUS_END_DEG - 4.0, BAUHAUS_START_DEG + 4.4);
    } else if (BAUHAUS_END_DEG - badgeDeg < 4.2) {
      badgeDeg = Math.max(BAUHAUS_START_DEG + 4.0, BAUHAUS_END_DEG - 4.4);
    }
    return { pt, badgeDeg };
  });

  const hitsAnyBauhausPoint = (deg: number, tolDeg = 3.2): boolean =>
    resolvedBadges.some(({ pt, badgeDeg }) => {
      const lo = Math.min(pt.trueAngleDeg, badgeDeg) - tolDeg;
      const hi = Math.max(pt.trueAngleDeg, badgeDeg) + tolDeg;
      return deg >= lo && deg <= hi;
    });

  const candTimes = layout.bnds
    .filter((bt) => !(bt > layout.tMin + 1e-7 && bt - layout.tMin < 0.01))
    .map((bt) => {
      const isGlob = Math.abs(bt - layout.tMin) < 1e-7 || Math.abs(bt - layout.tMax) < 1e-7;
      const isMajor = hasBoundaryNear(layout.wordBoundaries, bt);
      const prio = isGlob ? 3 : isMajor ? 2 : 1;
      const deg = timeToAngle(bt, layout.bnds, layout.thetaVar);
      return { bt, deg, drawDeg: deg, prio, isGlob, isMajor, show: false };
    });

  const acceptedTickDegs: number[] = [];
  const arcPerDeg = (Math.PI / 180) * (layout.rTone + 10.0);
  for (const c of [...candTimes].sort((a, b) => b.prio - a.prio || a.bt - b.bt)) {
    if (!c.isMajor && !c.isGlob) continue;
    if (c.isGlob) {
      // Slightly offset red start `0` clockwise so it stays completely clear of `0N` tier index label
      c.drawDeg = Math.abs(c.bt - layout.tMin) < 1e-7 ? c.deg + 0.9 : c.deg;
      c.show = true;
      acceptedTickDegs.push(c.drawDeg);
      continue;
    }

    // Check clearance against all point stems & badges; try nudging only if cleanly unobstructed, else suppress!
    let candidateDeg: number | null = c.deg;
    if (hitsAnyBauhausPoint(c.deg, 3.1)) {
      const leftCand = c.deg - 2.9;
      const rightCand = c.deg + 2.9;
      if (
        leftCand > BAUHAUS_START_DEG + 3.0 &&
        !hitsAnyBauhausPoint(leftCand, 3.0) &&
        acceptedTickDegs.every((ad) => Math.abs(leftCand - ad) * arcPerDeg >= 13.5)
      ) {
        candidateDeg = leftCand;
      } else if (
        rightCand < BAUHAUS_END_DEG - 3.0 &&
        !hitsAnyBauhausPoint(rightCand, 3.0) &&
        acceptedTickDegs.every((ad) => Math.abs(rightCand - ad) * arcPerDeg >= 13.5)
      ) {
        candidateDeg = rightCand;
      } else {
        candidateDeg = null;
      }
    }

    if (
      candidateDeg !== null &&
      acceptedTickDegs.every((ad) => Math.abs(candidateDeg! - ad) * arcPerDeg >= 13.5)
    ) {
      c.drawDeg = candidateDeg;
      c.show = true;
      acceptedTickDegs.push(candidateDeg);
    }
  }

  for (const c of candTimes) {
    const tLen = c.isGlob ? 5.5 : c.isMajor ? 4.0 : 2.4;
    const [p0x, p0y] = polarPtBauhaus(cx, cy, layout.rTone, c.deg);
    const [p1x, p1y] = polarPtBauhaus(cx, cy, layout.rTone + tLen, c.deg);
    const col = c.isGlob ? PAL.red : c.isMajor ? PAL.ink : PAL.muted;
    const sw = c.isGlob ? 1.4 : c.isMajor ? 0.8 : 0.5;
    pointDialParts.push(
      `<line x1="${fmtNum(p0x)}" y1="${fmtNum(p0y)}" x2="${fmtNum(p1x)}" y2="${fmtNum(p1y)}" stroke="${col}" stroke-width="${sw}"/>`
    );

    if (c.isGlob) {
      const sgn = Math.abs(c.bt - layout.tMin) < 1e-7 ? 1.0 : -1.0;
      const rad = (c.deg * Math.PI) / 180;
      pointDialParts.push(
        `<line x1="${fmtNum(p1x)}" y1="${fmtNum(p1y)}" x2="${fmtNum(p1x + Math.cos(rad) * sgn * 4.0)}" y2="${fmtNum(p1y + Math.sin(rad) * sgn * 4.0)}" stroke="${PAL.red}" stroke-width="1.4"/>`
      );
    }

    if (c.show) {
      const ds = formatCleanSecTick(c.bt, layout.tMin, layout.tMax).replace(/s$/, '');
      const degDraw = c.drawDeg;
      const rSt = layout.rTone + tLen + 2.6;
      const [lx, ly] = polarPtBauhaus(cx, cy, rSt, degDraw);
      const isLeft = degDraw < 0;
      const rotDeg = isLeft ? degDraw + 90.0 : degDraw - 90.0;
      const anchor = isLeft ? 'end' : 'start';
      pointDialParts.push(
        `<text x="0" y="0" transform="translate(${fmtNum(lx)} ${fmtNum(ly)}) rotate(${fmtNum(rotDeg)})" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="6.5" font-weight="700" fill="${c.isGlob ? PAL.red : PAL.tickGray}" text-anchor="${anchor}" dominant-baseline="central">${escapeXml(ds)}</text>`
      );
    }
  }

  // Concentric circular halo of numbered point badges (`1..K`)
  for (const { pt, badgeDeg } of resolvedBadges) {
    const tc = POINT_BADGE_CYCLE[pt.idx % POINT_BADGE_CYCLE.length];
    const nFg = tc === PAL.yellow ? PAL.ink : PAL.paperHi;
    const [ax, ay] = polarPtBauhaus(cx, cy, layout.rTone, pt.trueAngleDeg);
    const [s0x, s0y] = polarPtBauhaus(cx, cy, layout.rTone + 3.5, pt.trueAngleDeg);
    const [s1x, s1y] = polarPtBauhaus(cx, cy, layout.rBadge - 8.6, badgeDeg);
    const [bx, by] = polarPtBauhaus(cx, cy, layout.rBadge, badgeDeg);

    pointDialParts.push(
      `<circle cx="${fmtNum(ax)}" cy="${fmtNum(ay)}" r="3.0" fill="${tc}"/>`,
      `<line x1="${fmtNum(s0x)}" y1="${fmtNum(s0y)}" x2="${fmtNum(s1x)}" y2="${fmtNum(s1y)}" stroke="${PAL.ink}" stroke-opacity="0.55" stroke-width="0.75"/>`,
      `<circle cx="${fmtNum(bx)}" cy="${fmtNum(by)}" r="8.4" fill="${tc}"/>`,
      `<text x="${fmtNum(bx)}" y="${fmtNum(by)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="${pt.idx >= 99 ? '6.4' : '7.8'}" font-weight="800" fill="${nFg}" text-anchor="middle" dominant-baseline="central">${pt.idx + 1}</text>`
    );
  }

  // --------------------------------------------------------------------------
  // #editorial-copy (Upper-Left Bauhaus Lockup + Bottom Herbert Bayer Directory)
  // --------------------------------------------------------------------------
  let editorialGroup = '';
  if (!isEmblem && !config.pureVisual) {
    const edParts: string[] = [];
    const tx0 = 56.0;
    const totalLayers = nRings + (layout.pointTierName ? 1 : 0);
    const badgeNum = String(Math.max(1, totalLayers)).padStart(2, '0');
    const titleStr = config.copy.title.trim() || autoCopy.title;
    const subStr = config.copy.subtitle.trim() || autoCopy.subtitle;
    const footStr = config.copy.footer.trim() || autoCopy.footer;

    // Top color bar triad + top-right Weimar colophon
    edParts.push(
      `<rect x="${tx0}" y="50" width="54" height="6.5" fill="${PAL.red}"/>`,
      `<rect x="${tx0 + 58}" y="50" width="22" height="6.5" fill="${PAL.yellow}"/>`,
      `<rect x="${tx0 + 84}" y="50" width="12" height="6.5" fill="${PAL.blue}"/>`,
      `<text x="844" y="53.5" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.6" font-weight="700" letter-spacing="0.6" fill="${PAL.muted}" text-anchor="end" dominant-baseline="central">${escapeXml(autoCopy.sideLabel)}</text>`,
      // Monumental SPRACHE / KLANG lockup
      `<text x="${tx0 - 2}" y="106" font-family="${escapeXml(POSTER_DISPLAY_SANS_STACK)}" font-size="52" font-weight="900" letter-spacing="-1.4" fill="${PAL.ink}">SPRACHE</text>`,
      `<text x="${tx0 + 26}" y="157" font-family="${escapeXml(POSTER_DISPLAY_SANS_STACK)}" font-size="50" font-weight="900" letter-spacing="-1.0" fill="${PAL.red}">KLANG</text>`,
      `<rect x="${tx0}" y="126" width="18" height="33" fill="${PAL.ink}"/>`,
      `<text x="${tx0 + 9}" y="142.5" font-family="${escapeXml(POSTER_DISPLAY_SANS_STACK)}" font-size="9.5" font-weight="900" fill="${PAL.paperHi}" text-anchor="middle" dominant-baseline="central">${badgeNum}</text>`,
      `<text x="${tx0}" y="191" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="16" font-weight="700" letter-spacing="1.4" fill="${PAL.ink}">${escapeXml(truncateByGraphemes(titleStr, 360, `700 16px ${POSTER_SANS_STACK}`))}</text>`,
      `<text x="${tx0}" y="212" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="8.8" font-weight="500" fill="#5E574D">${escapeXml(truncateByGraphemes(subStr, 430, `500 8.8px ${POSTER_SANS_STACK}`))}</text>`
    );

    // Bottom Borderless Herbert Bayer 2-Zone Directory (`ySec = 886`)
    const ySec = 886.0;
    const lx0 = 56.0;
    edParts.push(
      `<rect x="${lx0}" y="${ySec}" width="42" height="2.8" fill="${PAL.ink}"/>`,
      `<text x="${lx0}" y="${ySec + 17}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="9.6" font-weight="700" letter-spacing="0.4" fill="${PAL.ink}">${totalLayers > 0 ? `${totalLayers} 层拆解  ·  由内向外` : '声学结构  ·  由内向外'}</text>`
    );

    // Left Zone: Tier Legend Guide — swatch derived directly from each ring's ACTUAL assigned Bauhaus role!
    for (let i = 0; i < nRings; i++) {
      const ring = layout.rings[i];
      const role = ringRoles[i];
      const ry = ySec + 36.0 + i * 19.5;
      const cnt = countActiveIntervals(tg.tiers[ring.tierIdx], layout.tMin, layout.tMax);
      let swatchSvg: string;
      if (role === 0) {
        swatchSvg = `<rect x="${lx0}" y="${fmtNum(ry - 4.5)}" width="9" height="9" fill="${PAL.ink}"/>`;
      } else if (role === 1) {
        swatchSvg = `<rect x="${lx0}" y="${fmtNum(ry - 4.5)}" width="9" height="9" fill="${PAL.red}"/>`;
      } else if (role === 2) {
        swatchSvg =
          nRings >= 4
            ? `<rect x="${lx0}" y="${fmtNum(ry - 4.5)}" width="9" height="9" fill="${PAL.blue}"/>`
            : `<rect x="${lx0}" y="${fmtNum(ry - 4.5)}" width="9" height="9" fill="${PAL.paperHi}" stroke="${PAL.sandLine}" stroke-width="0.75"/>` +
              `<rect x="${lx0}" y="${fmtNum(ry - 4.5)}" width="2.8" height="9" fill="${PAL.blue}"/>`;
      } else if (role === 3) {
        swatchSvg = `<rect x="${lx0}" y="${fmtNum(ry - 4.5)}" width="9" height="9" fill="${PAL.paperHi}" stroke="${PAL.ink}" stroke-width="0.8"/>`;
      } else {
        swatchSvg = `<rect x="${lx0}" y="${fmtNum(ry - 4.5)}" width="9" height="9" fill="${PAL.yellow}"/>`;
      }
      edParts.push(
        swatchSvg,
        `<text x="${lx0 + 15}" y="${fmtNum(ry)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="7.6" font-weight="700" fill="${PAL.muted}" dominant-baseline="central">${String(i + 1).padStart(2, '0')}</text>`,
        `<text x="${lx0 + 34}" y="${fmtNum(ry)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="8.3" font-weight="700" fill="${PAL.ink}" dominant-baseline="central">${escapeXml(truncateByGraphemes(ring.name, 128, `700 8.3px ${POSTER_SANS_STACK}`))}</text>`,
        `<text x="304" y="${fmtNum(ry)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.4" fill="${PAL.muted}" text-anchor="end" dominant-baseline="central">${cnt} 个区间</text>`
      );
    }
    if (layout.pointTierName) {
      const ry = ySec + 36.0 + nRings * 19.5;
      edParts.push(
        `<circle cx="${lx0 + 4.5}" cy="${fmtNum(ry)}" r="4.5" fill="${PAL.red}"/>`,
        `<text x="${lx0 + 15}" y="${fmtNum(ry)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="7.6" font-weight="700" fill="${PAL.muted}" dominant-baseline="central">${String(nRings + 1).padStart(2, '0')}</text>`,
        `<text x="${lx0 + 34}" y="${fmtNum(ry)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="8.3" font-weight="700" fill="${PAL.ink}" dominant-baseline="central">${escapeXml(truncateByGraphemes(layout.pointTierName, 128, `700 8.3px ${POSTER_SANS_STACK}`))}</text>`,
        `<text x="304" y="${fmtNum(ry)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.4" fill="${PAL.muted}" text-anchor="end" dominant-baseline="central">${layout.points.length} 个标点</text>`
      );
    }

    // Adapt divider height gracefully when fewer layers are shown so left/right columns stay visually anchored
    const minNoteY = totalLayers <= 3 ? ySec + 108.0 : totalLayers === 4 ? ySec + 126.0 : ySec + 152.0;
    const noteLineY = Math.max(minNoteY, ySec + 36.0 + (totalLayers + 0.35) * 19.5);
    edParts.push(
      `<line x1="${lx0}" y1="${fmtNum(noteLineY)}" x2="304" y2="${fmtNum(noteLineY)}" stroke="${PAL.sandLine}" stroke-width="0.65"/>`,
      `<text x="${lx0}" y="${fmtNum(noteLineY + 14)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.5" font-weight="700" fill="${PAL.ink}" dominant-baseline="central">内圈声学</text>`,
      `<text x="${lx0 + 46}" y="${fmtNum(noteLineY + 14)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.3" fill="${PAL.muted}" dominant-baseline="central">${hasAudio ? `0–${(maxFreq / 1000).toFixed(0)} kHz 频谱 · 黄色基频 · 声波` : '纯几何时间扇面（未载入录音）'}</text>`,
      `<text x="${lx0}" y="${fmtNum(noteLineY + 31.5)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.5" font-weight="700" fill="${PAL.ink}" dominant-baseline="central">放射细线</text>`,
      `<text x="${lx0 + 46}" y="${fmtNum(noteLineY + 31.5)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.3" fill="${PAL.muted}" dominant-baseline="central">连接内圈真实时间与外圈自适应音标格</text>`,
      `<text x="${lx0}" y="1138" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.2" fill="${PAL.muted}">${escapeXml(truncateByGraphemes(footStr, 788, `400 7.2px ${POSTER_SANS_STACK}`))}</text>`
    );

    // Right Zone (`x = 336..844`): 2-Column Point Directory (capped at 30 rows + overflow)
    const rx0 = 336.0;
    const colW = 244.0;
    const colGap = 20.0;
    const maxRows = 30;

    if (layout.points.length > 0) {
      const shownPts = layout.points.slice(0, maxRows);
      const overflow = layout.points.length - shownPts.length;
      const half = Math.ceil(shownPts.length / 2);
      const rowStep = shownPts.length <= 12 ? 28.5 : Math.max(14.5, Math.min(24.0, 178.0 / Math.max(1, half)));
      const badgeR = shownPts.length <= 16 ? 7.4 : 5.8;
      const rowFs = shownPts.length <= 16 ? 7.6 : 6.7;

      edParts.push(
        `<rect x="${rx0}" y="${ySec}" width="64" height="2.8" fill="${PAL.red}"/>`,
        `<text x="${rx0}" y="${ySec + 17}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="9.6" font-weight="700" letter-spacing="0.4" fill="${PAL.ink}">${escapeXml(layout.pointTierName || '标记点')}  ·  01–${String(layout.points.length).padStart(2, '0')}${overflow > 0 ? ` (+${overflow})` : ''}</text>`
      );

      for (let i = 0; i < shownPts.length; i++) {
        const pt = shownPts[i];
        const colI = i < half ? 0 : 1;
        const rowI = i < half ? i : i - half;
        const cxCol = rx0 + colI * (colW + colGap);
        const ey = ySec + 39.0 + rowI * rowStep;
        const tc = POINT_BADGE_CYCLE[pt.idx % POINT_BADGE_CYCLE.length];
        const nFg = tc === PAL.yellow ? PAL.ink : PAL.paperHi;

        if (rowI > 0) {
          edParts.push(
            `<line x1="${fmtNum(cxCol)}" y1="${fmtNum(ey - rowStep * 0.5)}" x2="${fmtNum(cxCol + colW)}" y2="${fmtNum(ey - rowStep * 0.5)}" stroke="${PAL.sandLine}" stroke-width="0.5"/>`
          );
        }
        edParts.push(
          `<circle cx="${fmtNum(cxCol + 7.5)}" cy="${fmtNum(ey)}" r="${fmtNum(badgeR)}" fill="${tc}"/>`,
          `<text x="${fmtNum(cxCol + 7.5)}" y="${fmtNum(ey)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="${fmtNum(rowFs - 0.3)}" font-weight="800" fill="${nFg}" text-anchor="middle" dominant-baseline="central">${pt.idx + 1}</text>`,
          `<text x="${fmtNum(cxCol + 51)}" y="${fmtNum(ey)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="${fmtNum(rowFs - 0.3)}" fill="${PAL.muted}" text-anchor="end" dominant-baseline="central">${pt.time.toFixed(2)}s</text>`,
          `<text x="${fmtNum(cxCol + 59)}" y="${fmtNum(ey)}" font-family="${escapeXml(POSTER_IPA_STACK)}" font-size="${fmtNum(rowFs + 0.1)}" font-weight="700" fill="${PAL.ink}" dominant-baseline="central">${escapeXml(truncateByGraphemes(pt.mark, pt.note ? 78 : 182, `700 ${rowFs}px ${POSTER_IPA_STACK}`))}</text>`
        );
        if (pt.note) {
          edParts.push(
            `<text x="${fmtNum(cxCol + colW)}" y="${fmtNum(ey)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="${fmtNum(rowFs)}" fill="${PAL.ink}" text-anchor="end" dominant-baseline="central">${escapeXml(truncateByGraphemes(pt.note, 108, `400 ${rowFs}px ${POSTER_SANS_STACK}`))}</text>`
          );
        }
      }
    } else if (nRings > 0) {
      // Clean temporal segment directory from the primary word/utterance tier when no point tier is active
      const srcRing = layout.rings[Math.min(1, nRings - 1)];
      const srcTier = tg.tiers[srcRing.tierIdx];
      const activeIvs = srcTier.intervals
        .filter((iv) => iv.xmax > layout.tMin + 1e-7 && iv.xmin < layout.tMax - 1e-7 && resolvePosterText(iv.text) !== '')
        .slice(0, 12);

      edParts.push(
        `<rect x="${rx0}" y="${ySec}" width="64" height="2.8" fill="${PAL.red}"/>`,
        `<text x="${rx0}" y="${ySec + 17}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="9.6" font-weight="700" letter-spacing="0.4" fill="${PAL.ink}">${escapeXml(srcRing.name)}  ·  时间索引</text>`
      );
      const half = Math.ceil(activeIvs.length / 2);
      for (let i = 0; i < activeIvs.length; i++) {
        const iv = activeIvs[i];
        const colI = i < half ? 0 : 1;
        const rowI = i < half ? i : i - half;
        const cxCol = rx0 + colI * (colW + colGap);
        const ey = ySec + 39.0 + rowI * 28.0;
        const tc = WORD_TRIAD[i % WORD_TRIAD.length][0];
        const nFg = tc === PAL.yellow ? PAL.ink : PAL.paperHi;
        const txt = resolvePosterText(iv.text);
        if (rowI > 0) {
          edParts.push(
            `<line x1="${fmtNum(cxCol)}" y1="${fmtNum(ey - 14)}" x2="${fmtNum(cxCol + colW)}" y2="${fmtNum(ey - 14)}" stroke="${PAL.sandLine}" stroke-width="0.5"/>`
          );
        }
        edParts.push(
          `<rect x="${fmtNum(cxCol)}" y="${fmtNum(ey - 6.5)}" width="13" height="13" fill="${tc}"/>`,
          `<text x="${fmtNum(cxCol + 6.5)}" y="${fmtNum(ey)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.2" font-weight="800" fill="${nFg}" text-anchor="middle" dominant-baseline="central">${i + 1}</text>`,
          `<text x="${fmtNum(cxCol + 20)}" y="${fmtNum(ey)}" font-family="${escapeXml(POSTER_IPA_STACK)}" font-size="8.0" font-weight="700" fill="${PAL.ink}" dominant-baseline="central">${escapeXml(truncateByGraphemes(txt, 126, `700 8px ${POSTER_IPA_STACK}`))}</text>`,
          `<text x="${fmtNum(cxCol + colW)}" y="${fmtNum(ey)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="7.1" fill="${PAL.muted}" text-anchor="end" dominant-baseline="central">${iv.xmin.toFixed(2)}–${iv.xmax.toFixed(2)}s</text>`
        );
      }
    }

    editorialGroup = `<g id="editorial-copy">${edParts.join('')}</g>`;
  }

  const dialTransformOpen =
    emblemScale !== 1.0
      ? `<g transform="translate(${fmtNum(cx)} ${fmtNum(cy)}) scale(${fmtNum(emblemScale, 3)}) translate(${fmtNum(-cx)} ${fmtNum(-cy)})">`
      : '';
  const dialTransformClose = emblemScale !== 1.0 ? '</g>' : '';

  const printMarksGroup = config.includeBleed ? renderPrintMarksSvg(trimW, trimH, bleed) : '';

  const svgMarkup =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmtNum(widthPt)}pt" height="${fmtNum(heightPt)}pt" viewBox="${fmtNum(-bleed)} ${fmtNum(-bleed)} ${fmtNum(widthPt)} ${fmtNum(heightPt)}">` +
    `<defs>${defs}</defs>` +
    paperBgGroup +
    dialTransformOpen +
    `<g id="dial-base">${dialBaseParts.join('')}</g>` +
    `<g id="acoustic-traces">${acousticParts.join('')}</g>` +
    `<g id="interval-rings">${ringsParts.join('')}</g>` +
    `<g id="point-dial">${pointDialParts.join('')}</g>` +
    dialTransformClose +
    editorialGroup +
    printMarksGroup +
    `</svg>`;

  return { svgMarkup, widthPt, heightPt, trimWidthPt: trimW, trimHeightPt: trimH, bleedPt: bleed };
}
