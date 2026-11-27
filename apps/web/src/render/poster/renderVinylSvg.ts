import type { TextGrid } from '../../bridge/types';
import { measurePx } from '../../layout/richText';
import {
  POSTER_DISPLAY_SANS_STACK,
  POSTER_IPA_STACK,
  POSTER_MONO_STACK,
  POSTER_SANS_STACK,
  VINYL_END_DEG,
  VINYL_R_DEADWAX,
  VINYL_R_HOLE,
  VINYL_R_LABEL,
  VINYL_R_SPEC_IN,
  VINYL_R_SPEC_OUT,
  VINYL_R_TRUE_IN,
  VINYL_R_TRUE_OUT,
  VINYL_R_VINYL_EDGE,
  VINYL_R_WAVE_IN,
  VINYL_R_WAVE_OUT,
  VINYL_R_WEB_IN,
  VINYL_START_DEG,
  VINYL_TOTAL_DEG,
  buildTrueDurationSpans,
  countActiveIntervals,
  escapeXml,
  fmtNum,
  formatCleanSecTick,
  hasBoundaryNear,
  polarPtVinyl,
  renderPrintMarksSvg,
  renderVinylArcTextSvg,
  resolvePosterText,
  svgArcPathVinyl,
  svgSectorPathVinyl,
  timeToAngle,
  truncateByGraphemes,
  wrapCenterLabelQuote
} from './polarSolver';
import {
  POSTER_BLEED_PT,
  type PolarDiscRasterResult,
  type PolarLayout,
  type PosterAutoCopy,
  type PosterConfig
} from './types';

const COL = {
  paper: '#F4F0E8',
  paperInner: '#F6F3EC',
  paperEdge: '#EDE8DD',
  platter: '#FAF7F1',
  ink: '#191816',
  sub: '#686158',
  dim: '#A39A8E',
  hairline: '#D8D0C2',
  red: '#D64028',
  blue: '#1E4E79',
  blueAlt: '#245987',
  slateBlue: '#396B94',
  slateAlt: '#41759F',
  sandA: '#EDE4D3',
  sandB: '#E6DCC8',
  ochreA: '#E2D6BE',
  ochreB: '#D9CCB2',
  stoneA: '#D5CBB7',
  stoneB: '#CCC1AC',
  whiteText: '#FCF9F4',
  gold: '#D49A3A',
  cyan: '#5CE0EC',
  rimBlue: '#4A8AB8',
  labelSub: '#FADAD2',
  tickInk: '#4A443D'
};

interface RingColorSpec {
  even: string;
  odd: string;
  text: string;
  label: string;
  singleUnit: boolean;
}

const VINYL_RING_STYLES: RingColorSpec[] = [
  { even: COL.red, odd: COL.red, text: COL.whiteText, label: COL.red, singleUnit: false },
  { even: COL.blue, odd: COL.blueAlt, text: COL.whiteText, label: COL.blue, singleUnit: false },
  { even: COL.slateBlue, odd: COL.slateAlt, text: COL.whiteText, label: COL.slateBlue, singleUnit: false },
  { even: COL.sandA, odd: COL.sandB, text: COL.ink, label: COL.sub, singleUnit: true },
  { even: COL.ochreA, odd: COL.ochreB, text: COL.ink, label: COL.ink, singleUnit: true },
  { even: COL.stoneA, odd: COL.stoneB, text: COL.ink, label: COL.ink, singleUnit: true }
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function renderCottonFibersPath(w: number, h: number, bleed: number): string {
  const rng = mulberry32(20260606);
  const segs: string[] = [];
  const xMin = -bleed + 12;
  const xSpan = w + 2 * bleed - 24;
  const yMin = -bleed + 12;
  const ySpan = h + 2 * bleed - 24;
  for (let i = 0; i < 340; i++) {
    const x0 = xMin + rng() * xSpan;
    const y0 = yMin + rng() * ySpan;
    const ln = 3 + rng() * 7;
    const ang = rng() * Math.PI;
    const x1 = x0 + ln * Math.cos(ang);
    const y1 = y0 + ln * Math.sin(ang);
    segs.push(`M${fmtNum(x0, 1)} ${fmtNum(y0, 1)}L${fmtNum(x1, 1)} ${fmtNum(y1, 1)}`);
  }
  return segs.join('');
}

function renderBraunTonearmSvg(cx: number, cy: number, rPlatter: number, idPfx: string): string {
  // Dieter Rams / Braun SK 4 minimalist straight-wand tonearm:
  // Anchored along canonical -75.8 deg ray inside the 12 o'clock open wedge, seamlessly bridging
  // to a pure, uncluttered monolithic matte-graphite headshell docked on the 0.00s lead-in groove.
  const rPivot = Math.max(296.0, rPlatter + 54.0);
  const [pivX, pivY] = polarPtVinyl(cx, cy, rPivot, -75.8);
  const [wristX, wristY] = polarPtVinyl(cx, cy, 159.0, -77.2);
  const [tipX, tipY] = polarPtVinyl(cx, cy, 133.5, VINYL_START_DEG);

  // Arm wand basis: u points wrist -> pivot, n is perpendicular
  const vx = pivX - wristX;
  const vy = pivY - wristY;
  const vlen = Math.hypot(vx, vy) || 1;
  const ux = vx / vlen;
  const uy = vy / vlen;
  const nx = -uy;
  const ny = ux;

  const cwEndX = pivX + ux * 29.5;
  const cwEndY = pivY + uy * 29.5;
  const c0x = pivX + ux * 10.5;
  const c0y = pivY + uy * 10.5;
  const c1x = pivX + ux * 12.6;
  const c1y = pivY + uy * 12.6;
  const c2x = pivX + ux * 27.6;
  const c2y = pivY + uy * 27.6;
  const cmx = pivX + ux * 16.8;
  const cmy = pivY + uy * 16.8;

  // Headshell basis: hu points wrist -> stylus tip, hn points left (inner), -hn points right (outer)
  const hsDx = tipX - wristX;
  const hsDy = tipY - wristY;
  const hsLen = Math.hypot(hsDx, hsDy) || 1;
  const hux = hsDx / hsLen;
  const huy = hsDy / hsLen;
  const hnx = -huy;
  const hny = hux;

  const hp = (along: number, across: number): [number, number] => [
    wristX + hux * along + hnx * across,
    wristY + huy * along + hny * across
  ];
  const polyStr = (pts: Array<[number, number]>): string =>
    pts.map(([x, y]) => `${fmtNum(x)},${fmtNum(y)}`).join(' ');

  // Counterweight cylinder (pure architectural form)
  const cwPoly = polyStr([
    [c1x + nx * 5.4, c1y + ny * 5.4],
    [c2x + nx * 5.4, c2y + ny * 5.4],
    [c2x - nx * 5.4, c2y - ny * 5.4],
    [c1x - nx * 5.4, c1y - ny * 5.4]
  ]);
  const cwStepPoly = polyStr([
    [c0x + nx * 3.5, c0y + ny * 3.5],
    [c1x + nx * 3.5, c1y + ny * 3.5],
    [c1x - nx * 3.5, c1y - ny * 3.5],
    [c0x - nx * 3.5, c0y - ny * 3.5]
  ]);

  // Smooth, seamless wand-to-headshell socket:
  // Note: `n = (-uy, ux)` points RIGHT of the wand while `hn = (-huy, hux)` points LEFT of the headshell,
  // so `-n` aligns with `+hn` (LEFT) and `+n` aligns with `-hn` (RIGHT).
  const wandInX = wristX + ux * 1.2;
  const wandInY = wristY + uy * 1.2;
  const wandPoly = polyStr([
    [c0x + nx * 1.25, c0y + ny * 1.25],
    [wandInX + nx * 1.12, wandInY + ny * 1.12],
    [wandInX - nx * 1.12, wandInY - ny * 1.12],
    [c0x - nx * 1.25, c0y - ny * 1.25]
  ]);

  // Unified monolithic tapered Braun headshell with integrated curved wrist socket hugging the wand tube
  const hsBodyLen = Math.max(17.5, hsLen - 3.6);
  const sockX = wristX + ux * 2.6;
  const sockY = wristY + uy * 2.6;
  const sockL: [number, number] = [sockX - nx * 1.32, sockY - ny * 1.32];
  const sockR: [number, number] = [sockX + nx * 1.32, sockY + ny * 1.32];
  const bendL: [number, number] = [wristX - nx * 1.65, wristY - ny * 1.65];
  const bendR: [number, number] = [wristX + nx * 1.65, wristY + ny * 1.65];
  const shL = hp(4.2, 3.05);
  const shR = hp(4.2, -3.05);
  const midL = hp(hsBodyLen - 2.6, 2.65);
  const midR = hp(hsBodyLen - 2.6, -2.65);
  const noseL = hp(hsBodyLen, 2.0);
  const noseR = hp(hsBodyLen, -2.0);

  const hsUnifiedPath =
    `M${fmtNum(sockL[0])} ${fmtNum(sockL[1])}` +
    `Q${fmtNum(bendL[0])} ${fmtNum(bendL[1])} ${fmtNum(shL[0])} ${fmtNum(shL[1])}` +
    `L${fmtNum(midL[0])} ${fmtNum(midL[1])}` +
    `L${fmtNum(noseL[0])} ${fmtNum(noseL[1])}` +
    `L${fmtNum(noseR[0])} ${fmtNum(noseR[1])}` +
    `L${fmtNum(midR[0])} ${fmtNum(midR[1])}` +
    `L${fmtNum(shR[0])} ${fmtNum(shR[1])}` +
    `Q${fmtNum(bendR[0])} ${fmtNum(bendR[1])} ${fmtNum(sockR[0])} ${fmtNum(sockR[1])}Z`;

  // Quiet top specular bevel plane & single precision alignment hairline near nose
  const hsBevelPoly = polyStr([
    hp(4.2, 2.15),
    hp(hsBodyLen - 2.4, 1.85),
    hp(hsBodyLen - 2.4, 0.35),
    hp(4.2, 0.5)
  ]);
  const noseMark0 = hp(hsBodyLen - 5.4, 0);
  const noseMark1 = hp(hsBodyLen - 1.6, 0);
  const cantBase = hp(hsBodyLen - 0.3, 0);

  // Perpendicular metallic gradients for wand & headshell
  const [wA_x, wA_y] = [pivX - nx * 1.4, pivY - ny * 1.4];
  const [wB_x, wB_y] = [pivX + nx * 1.4, pivY + ny * 1.4];
  const [gA_x, gA_y] = hp(12.0, -3.4);
  const [gB_x, gB_y] = hp(12.0, 3.4);

  return (
    `<g id="braun-tonearm">` +
    `<defs>` +
    `<linearGradient id="${idPfx}wand-grad" gradientUnits="userSpaceOnUse" x1="${fmtNum(wA_x)}" y1="${fmtNum(wA_y)}" x2="${fmtNum(wB_x)}" y2="${fmtNum(wB_y)}">` +
    `<stop offset="0%" stop-color="#8A8379"/>` +
    `<stop offset="38%" stop-color="#EDE8DE"/>` +
    `<stop offset="72%" stop-color="#C8C1B4"/>` +
    `<stop offset="100%" stop-color="#6B655D"/>` +
    `</linearGradient>` +
    `<linearGradient id="${idPfx}hs-grad" gradientUnits="userSpaceOnUse" x1="${fmtNum(gA_x)}" y1="${fmtNum(gA_y)}" x2="${fmtNum(gB_x)}" y2="${fmtNum(gB_y)}">` +
    `<stop offset="0%" stop-color="#35322F"/>` +
    `<stop offset="34%" stop-color="#242220"/>` +
    `<stop offset="74%" stop-color="#191816"/>` +
    `<stop offset="100%" stop-color="#2B2825"/>` +
    `</linearGradient>` +
    `</defs>` +
    // Unified, understated ambient drop shadow
    `<g transform="translate(1.8 3.2)">` +
    `<circle cx="${fmtNum(pivX)}" cy="${fmtNum(pivY)}" r="16.2" fill="rgba(25,22,18,0.08)"/>` +
    `<polyline points="${fmtNum(cwEndX)},${fmtNum(cwEndY)} ${fmtNum(wristX)},${fmtNum(wristY)}" fill="none" stroke="rgba(25,22,18,0.09)" stroke-width="3.2" stroke-linecap="round"/>` +
    `<path d="${hsUnifiedPath}" fill="rgba(20,18,15,0.13)"/>` +
    `</g>` +
    // Gimbal base plinth & matte bearing turret
    `<circle cx="${fmtNum(pivX)}" cy="${fmtNum(pivY)}" r="16.2" fill="#ECE7DC" stroke="rgba(25,24,22,0.26)" stroke-width="0.6"/>` +
    `<circle cx="${fmtNum(pivX)}" cy="${fmtNum(pivY)}" r="9.4" fill="#23211F"/>` +
    // Machined counterweight
    `<polygon points="${cwStepPoly}" fill="#46423D"/>` +
    `<polygon points="${cwPoly}" fill="#2B2926"/>` +
    `<line x1="${fmtNum(cmx + nx * 5.4)}" y1="${fmtNum(cmy + ny * 5.4)}" x2="${fmtNum(cmx - nx * 5.4)}" y2="${fmtNum(cmy - ny * 5.4)}" stroke="rgba(240,233,220,0.68)" stroke-width="0.75"/>` +
    // Slender brushed-aluminum wand tube (tucked cleanly into the unified headshell socket)
    `<polygon points="${wandPoly}" fill="url(#${idPfx}wand-grad)" stroke="rgba(45,42,38,0.34)" stroke-width="0.32"/>` +
    // Clean gimbal center cap
    `<circle cx="${fmtNum(pivX)}" cy="${fmtNum(pivY)}" r="3.1" fill="#E5DFD3" stroke="rgba(25,24,22,0.38)" stroke-width="0.45"/>` +
    // Precision cantilever
    `<line x1="${fmtNum(cantBase[0])}" y1="${fmtNum(cantBase[1])}" x2="${fmtNum(tipX)}" y2="${fmtNum(tipY)}" stroke="#C8C1B4" stroke-width="0.85" stroke-linecap="round"/>` +
    // Pure monolithic tapered Braun headshell with seamless curved wrist socket
    `<path d="${hsUnifiedPath}" fill="url(#${idPfx}hs-grad)" stroke="rgba(246,241,232,0.32)" stroke-width="0.38" stroke-linejoin="round"/>` +
    `<polygon points="${hsBevelPoly}" fill="rgba(255,250,242,0.055)"/>` +
    `<line x1="${fmtNum(noseMark0[0])}" y1="${fmtNum(noseMark0[1])}" x2="${fmtNum(noseMark1[0])}" y2="${fmtNum(noseMark1[1])}" stroke="rgba(245,238,225,0.48)" stroke-width="0.48" stroke-linecap="round"/>` +
    // Understated vermilion precision tracking point docked on 0.00s groove
    `<circle cx="${fmtNum(tipX)}" cy="${fmtNum(tipY)}" r="1.65" fill="${COL.red}" stroke="#FAF7F1" stroke-width="0.6"/>` +
    `</g>`
  );
}

export interface RenderVinylParams {
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

export function renderVinylPosterSvg(params: RenderVinylParams): {
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

  const cx = layout.cx;
  const cy = layout.cy;
  const idPfx = previewMode ? 'pv-v-' : 'ex-v-';
  const marginX = 64.0;

  // Emblem zoom so vinyl platter + tonearm + badges sit handsomely inside 900×900
  const maxOuterR = Math.max(layout.rPlatter + 50, layout.rBadge + 24);
  const emblemScale = isEmblem ? Math.min(1.16, 404.0 / Math.max(260, maxOuterR)) : 1.0;

  // --------------------------------------------------------------------------
  // <defs>: Radial paper & soft ambient shadows (ZERO <feGaussianBlur>!)
  // --------------------------------------------------------------------------
  const defs = [
    `<radialGradient id="${idPfx}paper-grad" gradientUnits="userSpaceOnUse" cx="${fmtNum(cx)}" cy="${fmtNum(cy - 30)}" r="780" fx="${fmtNum(cx)}" fy="${fmtNum(cy - 30)}">`,
    `<stop offset="0%" stop-color="${COL.paperInner}"/>`,
    `<stop offset="75%" stop-color="${COL.paper}"/>`,
    `<stop offset="100%" stop-color="${COL.paperEdge}"/>`,
    `</radialGradient>`,
    `<radialGradient id="${idPfx}sh-platter" gradientUnits="userSpaceOnUse" cx="${fmtNum(cx)}" cy="${fmtNum(cy + 10)}" r="${fmtNum(layout.rPlatter + 38)}">`,
    `<stop offset="0%" stop-color="#241C14" stop-opacity="0.11"/>`,
    `<stop offset="${fmtNum(((layout.rPlatter - 42) / (layout.rPlatter + 38)) * 100)}%" stop-color="#241C14" stop-opacity="0.10"/>`,
    `<stop offset="${fmtNum(((layout.rPlatter + 4) / (layout.rPlatter + 38)) * 100)}%" stop-color="#241C14" stop-opacity="0.065"/>`,
    `<stop offset="${fmtNum(((layout.rPlatter + 24) / (layout.rPlatter + 38)) * 100)}%" stop-color="#241C14" stop-opacity="0.02"/>`,
    `<stop offset="100%" stop-color="#241C14" stop-opacity="0"/>`,
    `</radialGradient>`,
    `<radialGradient id="${idPfx}sh-vinyl" gradientUnits="userSpaceOnUse" cx="${fmtNum(cx)}" cy="${fmtNum(cy + 3)}" r="${fmtNum(VINYL_R_VINYL_EDGE + 10)}">`,
    `<stop offset="0%" stop-color="#141210" stop-opacity="0.22"/>`,
    `<stop offset="${fmtNum(((VINYL_R_VINYL_EDGE - 6) / (VINYL_R_VINYL_EDGE + 10)) * 100)}%" stop-color="#141210" stop-opacity="0.20"/>`,
    `<stop offset="${fmtNum(((VINYL_R_VINYL_EDGE + 3) / (VINYL_R_VINYL_EDGE + 10)) * 100)}%" stop-color="#141210" stop-opacity="0.08"/>`,
    `<stop offset="100%" stop-color="#141210" stop-opacity="0"/>`,
    `</radialGradient>`,
    `<linearGradient id="${idPfx}spec-sw" x1="0%" y1="0%" x2="100%" y2="0%">`,
    `<stop offset="0%" stop-color="#151311"/>`,
    `<stop offset="50%" stop-color="#D06A2E"/>`,
    `<stop offset="100%" stop-color="#FFF6DA"/>`,
    `</linearGradient>`
  ].join('');

  // --------------------------------------------------------------------------
  // #paper-bg (omitted when bgMode === 'transparent')
  // --------------------------------------------------------------------------
  const paperBgGroup =
    config.bgMode === 'transparent'
      ? ''
      : `<g id="paper-bg">` +
        `<rect x="${fmtNum(-bleed)}" y="${fmtNum(-bleed)}" width="${fmtNum(widthPt)}" height="${fmtNum(heightPt)}" fill="url(#${idPfx}paper-grad)"/>` +
        `<path d="${renderCottonFibersPath(trimW, trimH, bleed)}" fill="none" stroke="rgba(97,87,71,0.024)" stroke-width="0.32"/>` +
        `</g>`;

  // --------------------------------------------------------------------------
  // #dial-base (Platter + Vinyl Disc + Gold Guides + Center Label)
  // --------------------------------------------------------------------------
  const dialBaseParts: string[] = [];
  // Platter ambient shadow & matte alabaster platter
  dialBaseParts.push(
    `<circle cx="${fmtNum(cx)}" cy="${fmtNum(cy + 10)}" r="${fmtNum(layout.rPlatter + 38)}" fill="url(#${idPfx}sh-platter)"/>`,
    `<circle cx="${fmtNum(cx)}" cy="${fmtNum(cy)}" r="${fmtNum(layout.rPlatter)}" fill="${COL.platter}" stroke="rgba(216,208,194,0.85)" stroke-width="0.65"/>`,
    `<circle cx="${fmtNum(cx)}" cy="${fmtNum(cy + 3)}" r="${fmtNum(VINYL_R_VINYL_EDGE + 10)}" fill="url(#${idPfx}sh-vinyl)"/>`
  );

  // Polar vinyl disc raster (or fallback black disc)
  if (discRaster?.dataUrl) {
    dialBaseParts.push(
      `<image x="${fmtNum(discRaster.xPt)}" y="${fmtNum(discRaster.yPt)}" width="${fmtNum(discRaster.widthPt)}" height="${fmtNum(discRaster.heightPt)}" href="${discRaster.dataUrl}" preserveAspectRatio="none"/>`
    );
  } else {
    dialBaseParts.push(
      `<circle cx="${fmtNum(cx)}" cy="${fmtNum(cy)}" r="${fmtNum(VINYL_R_VINYL_EDGE)}" fill="#151311"/>`
    );
  }

  // Concentric gold micro-guides & lead-in radial cuts
  for (const [rr, op] of [
    [VINYL_R_DEADWAX, 0.3],
    [VINYL_R_SPEC_IN, 0.26],
    [VINYL_R_SPEC_OUT, 0.42]
  ] as const) {
    dialBaseParts.push(
      `<circle cx="${fmtNum(cx)}" cy="${fmtNum(cy)}" r="${fmtNum(rr)}" fill="none" stroke="${COL.gold}" stroke-opacity="${op}" stroke-width="0.5"/>`
    );
  }
  for (const ed of [VINYL_START_DEG, VINYL_END_DEG]) {
    const [x0, y0] = polarPtVinyl(cx, cy, VINYL_R_WAVE_IN, ed);
    const [x1, y1] = polarPtVinyl(cx, cy, VINYL_R_TRUE_OUT, ed);
    dialBaseParts.push(
      `<line x1="${fmtNum(x0)}" y1="${fmtNum(y0)}" x2="${fmtNum(x1)}" y2="${fmtNum(y1)}" stroke="${COL.gold}" stroke-opacity="0.55" stroke-width="0.6"/>`
    );
  }

  // Dynamic frequency labels at -94 deg (cleanly clear of headshell at -72..-76.8 deg)
  if (hasAudio && config.showSpectrogram) {
    const maxK = maxFreq / 1000;
    const midK = maxK * 0.5;
    const midLbl = Number.isInteger(midK) ? `${midK}k` : `${midK.toFixed(1)}k`;
    const maxLbl = Number.isInteger(maxK) ? `${maxK}kHz` : `${maxK.toFixed(1)}kHz`;
    for (const [frac, lbl] of [
      [0, '0'],
      [0.5, midLbl],
      [1, maxLbl]
    ] as const) {
      const rf = VINYL_R_SPEC_IN + frac * (VINYL_R_SPEC_OUT - VINYL_R_SPEC_IN);
      const [fx, fy] = polarPtVinyl(cx, cy, rf, -94.0);
      dialBaseParts.push(
        `<text x="${fmtNum(fx)}" y="${fmtNum(fy)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="5.5" fill="#B4A48A" text-anchor="middle" dominant-baseline="central">${escapeXml(lbl)}</text>`
      );
    }
  }

  // Warm Vermilion Center Record Label (uses evenodd annulus so spindle hole is genuinely transparent!)
  const srLine =
    hasAudio && audioSampleRate > 0
      ? `${(audioSampleRate / 1000).toFixed(audioSampleRate % 1000 === 0 ? 0 : 1)} kHz MONO`
      : 'TEXTGRID EDITION';
  const [quoteL1, quoteL2] = wrapCenterLabelQuote(autoCopy.centerQuote);
  const labelAnnulusPath =
    `M ${fmtNum(cx - VINYL_R_LABEL)} ${fmtNum(cy)} ` +
    `a ${fmtNum(VINYL_R_LABEL)} ${fmtNum(VINYL_R_LABEL)} 0 1 0 ${fmtNum(2 * VINYL_R_LABEL)} 0 ` +
    `a ${fmtNum(VINYL_R_LABEL)} ${fmtNum(VINYL_R_LABEL)} 0 1 0 ${fmtNum(-2 * VINYL_R_LABEL)} 0 ` +
    `M ${fmtNum(cx - VINYL_R_HOLE)} ${fmtNum(cy)} ` +
    `a ${fmtNum(VINYL_R_HOLE)} ${fmtNum(VINYL_R_HOLE)} 0 1 0 ${fmtNum(2 * VINYL_R_HOLE)} 0 ` +
    `a ${fmtNum(VINYL_R_HOLE)} ${fmtNum(VINYL_R_HOLE)} 0 1 0 ${fmtNum(-2 * VINYL_R_HOLE)} 0 Z`;

  dialBaseParts.push(
    `<path d="${labelAnnulusPath}" fill="${COL.red}" fill-rule="evenodd"/>`,
    `<circle cx="${fmtNum(cx)}" cy="${fmtNum(cy)}" r="${fmtNum(VINYL_R_LABEL - 5.0)}" fill="none" stroke="rgba(255,247,235,0.42)" stroke-width="0.55"/>`,
    `<text x="${fmtNum(cx)}" y="${fmtNum(cy - 26.5)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="5.8" font-weight="600" letter-spacing="1.0" fill="${COL.whiteText}" text-anchor="middle" dominant-baseline="central">SIDE A · ${layout.duration.toFixed(2)} SEC</text>`,
    `<text x="${fmtNum(cx)}" y="${fmtNum(cy - 16.8)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="5.6" fill="${COL.labelSub}" text-anchor="middle" dominant-baseline="central">${escapeXml(srLine)}</text>`
  );
  if (quoteL2) {
    dialBaseParts.push(
      `<text x="${fmtNum(cx)}" y="${fmtNum(cy + 16.5)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="6.4" font-weight="500" fill="${COL.whiteText}" text-anchor="middle" dominant-baseline="central">${escapeXml(quoteL1)}</text>`,
      `<text x="${fmtNum(cx)}" y="${fmtNum(cy + 26.8)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="6.4" font-weight="500" fill="${COL.whiteText}" text-anchor="middle" dominant-baseline="central">${escapeXml(quoteL2)}</text>`
    );
  } else {
    dialBaseParts.push(
      `<text x="${fmtNum(cx)}" y="${fmtNum(cy + 21.0)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="6.6" font-weight="500" fill="${COL.whiteText}" text-anchor="middle" dominant-baseline="central">${escapeXml(quoteL1)}</text>`
    );
  }
  // Center spindle hole rim (genuinely hollow when transparent, paper fill when on paper)
  dialBaseParts.push(
    `<circle cx="${fmtNum(cx)}" cy="${fmtNum(cy)}" r="${fmtNum(VINYL_R_HOLE)}" fill="${config.bgMode === 'transparent' ? 'none' : COL.paper}" stroke="rgba(31,26,20,0.45)" stroke-width="0.8"/>`
  );

  // --------------------------------------------------------------------------
  // #acoustic-traces (Waveform + F0 Pitch + 1:1 Rim + Silk Bezier Bridge)
  // --------------------------------------------------------------------------
  const acousticParts: string[] = [];

  // 1:1 Polar Waveform Ring
  const rWaveMid = 0.5 * (VINYL_R_WAVE_IN + VINYL_R_WAVE_OUT);
  const rWaveAmp = 0.46 * (VINYL_R_WAVE_OUT - VINYL_R_WAVE_IN);
  acousticParts.push(
    `<path d="${svgArcPathVinyl(cx, cy, rWaveMid, VINYL_START_DEG, VINYL_END_DEG)}" fill="none" stroke="rgba(217,194,158,0.22)" stroke-width="0.4"/>`
  );
  if (config.showWaveform && waveformBins && waveformBins.length >= 4) {
    const nBins = waveformBins.length;
    const outerPts: string[] = [];
    const innerPts: string[] = [];
    for (let k = 0; k < nBins; k++) {
      const [vmin, vmax] = waveformBins[k];
      const angK = VINYL_START_DEG + ((k + 0.5) / nBins) * VINYL_TOTAL_DEG;
      const [ox, oy] = polarPtVinyl(cx, cy, rWaveMid + vmax * rWaveAmp, angK);
      const [ix, iy] = polarPtVinyl(cx, cy, rWaveMid + vmin * rWaveAmp, angK);
      outerPts.push(`${k === 0 ? 'M' : 'L'}${fmtNum(ox, 1)} ${fmtNum(oy, 1)}`);
      innerPts.push(`L${fmtNum(ix, 1)} ${fmtNum(iy, 1)}`);
    }
    innerPts.reverse();
    acousticParts.push(
      `<path d="${outerPts.join('')}${innerPts.join('')}Z" fill="rgba(242,212,148,0.90)"/>`
    );
  }

  // F0 Pitch Contour Overlay
  if (config.showPitch && f0Runs.length > 0) {
    for (const run of f0Runs) {
      const pts: string[] = [];
      for (let i = 0; i < run.length; i++) {
        const angF = timeToAngle(run[i].t, layout.bnds, layout.thetaLin);
        const rF = VINYL_R_SPEC_IN + 5.0 + run[i].normF0 * (VINYL_R_SPEC_OUT - VINYL_R_SPEC_IN - 10.0);
        const [px, py] = polarPtVinyl(cx, cy, rF, angF);
        pts.push(`${i === 0 ? 'M' : 'L'}${fmtNum(px, 1)} ${fmtNum(py, 1)}`);
      }
      const d = pts.join('');
      acousticParts.push(
        `<path d="${d}" fill="none" stroke="rgba(18,15,13,0.88)" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>`,
        `<path d="${d}" fill="none" stroke="${COL.cyan}" stroke-opacity="0.94" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    }
  }

  // 1:1 True-Duration Reference Ring on Vinyl Rim + Silk Bezier Warp Bridge (Multi-Tier Coverage!)
  const trueSpans = buildTrueDurationSpans(tg, layout);
  const rWebOut = layout.rBridgeOut;
  for (const sp of trueSpans) {
    const dl0 = timeToAngle(sp.a, layout.bnds, layout.thetaLin);
    const dl1 = timeToAngle(sp.b, layout.bnds, layout.thetaLin);
    let fill: string;
    if (sp.isEmpty) {
      fill = 'rgba(82,74,66,0.75)';
    } else if (!layout.ring0IsUmbrella && layout.rings.length >= 2) {
      // Match active speaker's ring color (Ring 0 = Red, Ring 1 = Blue)
      fill = sp.ringIndex === 0 ? COL.red : COL.rimBlue;
    } else {
      fill = sp.activeOrder % 2 === 0 ? COL.rimBlue : COL.red;
    }
    const p = svgSectorPathVinyl(cx, cy, VINYL_R_TRUE_IN, VINYL_R_TRUE_OUT, dl0, dl1);
    if (p) acousticParts.push(`<path d="${p}" fill="${fill}"/>`);
  }

  // Delicate Silk Bezier Warp Bridge (True Time -> Adaptive Ring Angles)
  if (layout.rings.length > 0) {
    const rCp1 = VINYL_R_WEB_IN + 0.38 * (rWebOut - VINYL_R_WEB_IN);
    const rCp2 = VINYL_R_WEB_IN + 0.64 * (rWebOut - VINYL_R_WEB_IN);

    for (const sp of trueSpans) {
      if (sp.isEmpty) continue;
      const dl0 = timeToAngle(sp.a, layout.bnds, layout.thetaLin);
      const dl1 = timeToAngle(sp.b, layout.bnds, layout.thetaLin);
      const dv0 = timeToAngle(sp.a, layout.bnds, layout.thetaVar);
      const dv1 = timeToAngle(sp.b, layout.bnds, layout.thetaVar);
      const [p0sX, p0sY] = polarPtVinyl(cx, cy, VINYL_R_WEB_IN, dl0);
      const [c1sX, c1sY] = polarPtVinyl(cx, cy, rCp1, dl0);
      const [c2sX, c2sY] = polarPtVinyl(cx, cy, rCp2, dv0);
      const [p3sX, p3sY] = polarPtVinyl(cx, cy, rWebOut, dv0);
      const [p3eX, p3eY] = polarPtVinyl(cx, cy, rWebOut, dv1);
      const [c2eX, c2eY] = polarPtVinyl(cx, cy, rCp2, dv1);
      const [c1eX, c1eY] = polarPtVinyl(cx, cy, rCp1, dl1);
      const [p0eX, p0eY] = polarPtVinyl(cx, cy, VINYL_R_WEB_IN, dl1);
      const largeOut = dv1 - dv0 > 180 ? 1 : 0;
      const largeIn = dl1 - dl0 > 180 ? 1 : 0;
      const dRib =
        `M${fmtNum(p0sX)} ${fmtNum(p0sY)}` +
        `C${fmtNum(c1sX)} ${fmtNum(c1sY)} ${fmtNum(c2sX)} ${fmtNum(c2sY)} ${fmtNum(p3sX)} ${fmtNum(p3sY)}` +
        `A${fmtNum(rWebOut)} ${fmtNum(rWebOut)} 0 ${largeOut} 1 ${fmtNum(p3eX)} ${fmtNum(p3eY)}` +
        `C${fmtNum(c2eX)} ${fmtNum(c2eY)} ${fmtNum(c1eX)} ${fmtNum(c1eY)} ${fmtNum(p0eX)} ${fmtNum(p0eY)}` +
        `A${fmtNum(VINYL_R_WEB_IN)} ${fmtNum(VINYL_R_WEB_IN)} 0 ${largeIn} 0 ${fmtNum(p0sX)} ${fmtNum(p0sY)}Z`;
      const ribCol =
        !layout.ring0IsUmbrella && layout.rings.length >= 2
          ? sp.ringIndex === 0
            ? COL.red
            : COL.blue
          : sp.activeOrder % 2 === 0
            ? COL.blue
            : COL.red;
      acousticParts.push(`<path d="${dRib}" fill="${ribCol}" fill-opacity="0.105"/>`);
    }

    for (let i = 0; i < layout.bnds.length; i++) {
      const tVal = layout.bnds[i];
      const dl = layout.thetaLin[i];
      const dv = layout.thetaVar[i];
      const [p0x, p0y] = polarPtVinyl(cx, cy, VINYL_R_WEB_IN, dl);
      const [c1x, c1y] = polarPtVinyl(cx, cy, rCp1, dl);
      const [c2x, c2y] = polarPtVinyl(cx, cy, rCp2, dv);
      const [p3x, p3y] = polarPtVinyl(cx, cy, rWebOut, dv);
      const isWord = hasBoundaryNear(layout.wordBoundaries, tVal);
      const isSyl = !isWord && hasBoundaryNear(layout.sylBoundaries, tVal);
      const stroke = isWord ? COL.sub : isSyl ? COL.sub : COL.dim;
      const op = isWord ? 0.54 : isSyl ? 0.35 : 0.24;
      const sw = isWord ? 0.7 : isSyl ? 0.5 : 0.38;
      acousticParts.push(
        `<path d="M${fmtNum(p0x)} ${fmtNum(p0y)}C${fmtNum(c1x)} ${fmtNum(c1y)} ${fmtNum(c2x)} ${fmtNum(c2y)} ${fmtNum(p3x)} ${fmtNum(p3y)}" fill="none" stroke="${stroke}" stroke-opacity="${op}" stroke-width="${sw}"/>`
      );
    }
  }

  // --------------------------------------------------------------------------
  // #interval-rings (Dynamic 1..6 Concentric Interval Rings + 12 o'clock Labels)
  // --------------------------------------------------------------------------
  const ringsParts: string[] = [];
  for (let rIdx = 0; rIdx < layout.rings.length; rIdx++) {
    const ring = layout.rings[rIdx];
    const style = VINYL_RING_STYLES[Math.min(rIdx, VINYL_RING_STYLES.length - 1)];
    const tier = tg.tiers[ring.tierIdx];
    const fontFamily = ring.isIpaLike ? POSTER_IPA_STACK : POSTER_SANS_STACK;
    const fontWeight = ring.isIpaLike ? 400 : 500;
    const rThick = ring.rOut - ring.rIn;

    // Whisper-light empty-groove hairline rails along full active span
    ringsParts.push(
      `<path d="${svgArcPathVinyl(cx, cy, ring.rIn + 0.6, VINYL_START_DEG, VINYL_END_DEG)}" fill="none" stroke="${COL.hairline}" stroke-opacity="0.68" stroke-width="0.45"/>`,
      `<path d="${svgArcPathVinyl(cx, cy, ring.rOut - 0.6, VINYL_START_DEG, VINYL_END_DEG)}" fill="none" stroke="${COL.hairline}" stroke-opacity="0.68" stroke-width="0.45"/>`
    );

    let voicedCounter = 0;
    for (const iv of tier.intervals) {
      const a = Math.max(layout.tMin, iv.xmin);
      const b = Math.min(layout.tMax, iv.xmax);
      if (b <= a + 1e-7) continue;
      const deg0 = timeToAngle(a, layout.bnds, layout.thetaVar);
      const deg1 = timeToAngle(b, layout.bnds, layout.thetaVar);
      const txt = resolvePosterText(iv.text);

      if (!txt) {
        for (const db of [deg0, deg1]) {
          const [ax, ay] = polarPtVinyl(cx, cy, ring.rIn + 0.6, db);
          const [bx, by] = polarPtVinyl(cx, cy, ring.rOut - 0.6, db);
          ringsParts.push(
            `<line x1="${fmtNum(ax)}" y1="${fmtNum(ay)}" x2="${fmtNum(bx)}" y2="${fmtNum(by)}" stroke="${COL.hairline}" stroke-opacity="0.8" stroke-width="0.45"/>`
          );
        }
        continue;
      }

      const fillC = voicedCounter++ % 2 === 0 ? style.even : style.odd;
      const secPath = svgSectorPathVinyl(cx, cy, ring.rIn, ring.rOut, deg0, deg1);
      if (secPath) {
        ringsParts.push(`<path d="${secPath}" fill="${fillC}"/>`);
      }

      for (const ds of [deg0, deg1]) {
        const [ax, ay] = polarPtVinyl(cx, cy, ring.rIn - 0.2, ds);
        const [bx, by] = polarPtVinyl(cx, cy, ring.rOut + 0.2, ds);
        ringsParts.push(
          `<line x1="${fmtNum(ax)}" y1="${fmtNum(ay)}" x2="${fmtNum(bx)}" y2="${fmtNum(by)}" stroke="${COL.platter}" stroke-width="0.95"/>`
        );
      }

      ringsParts.push(
        renderVinylArcTextSvg({
          cx,
          cy,
          rMid: ring.rMid,
          rThick,
          degStart: deg0,
          degEnd: deg1,
          text: txt,
          fontSize: ring.fontSize,
          fontWeight,
          fontFamily,
          fill: style.text,
          singleUnit: style.singleUnit || ring.isIpaLike
        })
      );
    }

    // 12 o'clock (-93.5 deg) layer index label (crisp & legible inside the 36-deg open wedge)
    const [lx, ly] = polarPtVinyl(cx, cy, ring.rMid, -93.5);
    const labelFs = layout.rings.length <= 3 ? 6.8 : 6.1;
    const shortName = truncateByGraphemes(ring.name, 66, `600 ${labelFs}px ${POSTER_SANS_STACK}`);
    ringsParts.push(
      `<text x="${fmtNum(lx)}" y="${fmtNum(ly)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="${fmtNum(labelFs, 1)}" font-weight="600" fill="${style.label}" text-anchor="middle" dominant-baseline="central">${rIdx + 1} ${escapeXml(shortName)}</text>`
    );
  }

  // --------------------------------------------------------------------------
  // #point-dial (Tone Orbit, Time Axis, Point Markers, Braun Tonearm)
  // --------------------------------------------------------------------------
  const pointDialParts: string[] = [];

  if (layout.pointTierName) {
    pointDialParts.push(
      `<path d="${svgArcPathVinyl(cx, cy, layout.rTone, VINYL_START_DEG, VINYL_END_DEG)}" fill="none" stroke="${COL.dim}" stroke-opacity="0.72" stroke-width="0.6" stroke-dasharray="1.5 2.4"/>`
    );
    const [lx, ly] = polarPtVinyl(cx, cy, layout.rTone + 0.5, -93.5);
    const ptLabelFs = layout.rings.length <= 3 ? 6.8 : 6.1;
    const shortPtName = truncateByGraphemes(layout.pointTierName, 66, `600 ${ptLabelFs}px ${POSTER_SANS_STACK}`);
    pointDialParts.push(
      `<text x="${fmtNum(lx)}" y="${fmtNum(ly)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="${fmtNum(ptLabelFs, 1)}" font-weight="600" fill="${COL.red}" text-anchor="middle" dominant-baseline="central">${layout.rings.length + 1} ${escapeXml(shortPtName)}</text>`
    );
  }

  // Outer timestamp scale arc
  pointDialParts.push(
    `<path d="${svgArcPathVinyl(cx, cy, layout.rTimeAxis, VINYL_START_DEG, VINYL_END_DEG)}" fill="none" stroke="${COL.ink}" stroke-opacity="0.52" stroke-width="0.65"/>`
  );
  for (const ed of [VINYL_START_DEG, VINYL_END_DEG]) {
    const [ax, ay] = polarPtVinyl(cx, cy, layout.rTimeAxis - 2.2, ed);
    const [bx, by] = polarPtVinyl(cx, cy, layout.rTimeAxis + 5.2, ed);
    pointDialParts.push(
      `<line x1="${fmtNum(ax)}" y1="${fmtNum(ay)}" x2="${fmtNum(bx)}" y2="${fmtNum(by)}" stroke="${COL.ink}" stroke-width="1.0"/>`
    );
  }

  // Pre-adjust endpoint point badge angles so badges stay clear of `0` and `tMax` endpoint timestamps
  const resolvedPoints = layout.points.map((pt) => {
    let degBadge = pt.badgeAngleDeg;
    if (degBadge - VINYL_START_DEG < 5.0) {
      degBadge = Math.min(VINYL_END_DEG - 4.5, VINYL_START_DEG + 5.2);
    } else if (VINYL_END_DEG - degBadge < 5.2) {
      degBadge = Math.max(VINYL_START_DEG + 4.5, VINYL_END_DEG - 5.4);
    }
    return { pt, degBadge };
  });

  // Collision-avoided timestamp ticks:
  // Suppress interior (non-endpoint) timestamp labels that fall within ±3.8 deg of any point marker
  // ray so ZERO red leader lines ever impale or cross timestamp numerals!
  const tickItems = layout.bnds.map((tVal) => {
    const deg = timeToAngle(tVal, layout.bnds, layout.thetaVar);
    let prio = 1;
    if (Math.abs(tVal - layout.tMin) < 1e-7 || Math.abs(tVal - layout.tMax) < 1e-7) prio = 5;
    else if (hasBoundaryNear(layout.wordBoundaries, tVal)) prio = 4;
    else if (hasBoundaryNear(layout.sylBoundaries, tVal)) prio = 3;
    else if (hasBoundaryNear(layout.broadBoundaries, tVal)) prio = 2;
    return { t: tVal, deg, prio, str: formatCleanSecTick(tVal, layout.tMin, layout.tMax), showLabel: false };
  });

  const hitsAnyPointRay = (deg: number): boolean =>
    resolvedPoints.some(({ pt, degBadge }) => {
      const lo = Math.min(pt.trueAngleDeg, degBadge) - 3.8;
      const hi = Math.max(pt.trueAngleDeg, degBadge) + 3.8;
      return deg >= lo && deg <= hi;
    });

  const acceptedDegs: number[] = [];
  const minTickSep = 10.5;
  for (const item of [...tickItems].sort((a, b) => b.prio - a.prio || a.deg - b.deg)) {
    if (item.t > layout.tMin + 1e-7 && item.t - layout.tMin < 0.02 && item.prio < 5) continue;
    if (item.prio < 5 && hitsAnyPointRay(item.deg)) continue;
    if (acceptedDegs.every((ad) => Math.abs(item.deg - ad) >= minTickSep)) {
      item.showLabel = true;
      acceptedDegs.push(item.deg);
    }
  }

  const tickFontCss = `400 6.4px ${POSTER_MONO_STACK}`;
  const labelBoxes: Array<{ deg: number; rOut: number }> = [];
  for (const item of tickItems) {
    const tLen = item.prio >= 3 ? 4.0 : 2.4;
    const [p0x, p0y] = polarPtVinyl(cx, cy, layout.rTimeAxis, item.deg);
    const [p1x, p1y] = polarPtVinyl(cx, cy, layout.rTimeAxis + tLen, item.deg);
    pointDialParts.push(
      `<line x1="${fmtNum(p0x)}" y1="${fmtNum(p0y)}" x2="${fmtNum(p1x)}" y2="${fmtNum(p1y)}" stroke="${COL.sub}" stroke-opacity="${item.prio >= 3 ? 0.72 : 0.42}" stroke-width="${item.prio >= 3 ? 0.6 : 0.45}"/>`
    );
    if (!item.showLabel) continue;
    const rLbl = layout.rTimeAxis + 6.0;
    const [px, py] = polarPtVinyl(cx, cy, rLbl, item.deg);
    const rad = (item.deg * Math.PI) / 180;
    const isLeft = Math.cos(rad) < -0.01;
    const rotDeg = isLeft ? item.deg + 180 : item.deg;
    const anchor = isLeft ? 'end' : 'start';
    pointDialParts.push(
      `<text x="0" y="0" transform="translate(${fmtNum(px)} ${fmtNum(py)}) rotate(${fmtNum(rotDeg)})" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="6.4" fill="${COL.tickInk}" text-anchor="${anchor}" dominant-baseline="central">${escapeXml(item.str)}</text>`
    );
    const measuredW = measurePx(item.str, tickFontCss);
    labelBoxes.push({ deg: item.deg, rOut: layout.rTimeAxis + 7.5 + measuredW });
  }

  // Jewel-like Vermilion Point Markers (`01`..`K`) with zero-crossing timestamp clearance
  for (const { pt, degBadge } of resolvedPoints) {
    const degAnchor = pt.trueAngleDeg;
    const radBadge = (degBadge * Math.PI) / 180;

    const [ax, ay] = polarPtVinyl(cx, cy, layout.rTone, degAnchor);
    pointDialParts.push(
      `<circle cx="${fmtNum(ax)}" cy="${fmtNum(ay)}" r="2.2" fill="${COL.red}" stroke="${COL.platter}" stroke-width="1.2"/>`
    );

    let hitRMax: number | null = null;
    for (const lb of labelBoxes) {
      const lo = Math.min(degAnchor, degBadge) - 3.6;
      const hi = Math.max(degAnchor, degBadge) + 3.6;
      if (lb.deg >= lo && lb.deg <= hi) {
        hitRMax = Math.max(hitRMax ?? 0, lb.rOut + 4.5);
      }
    }
    const rDotOut = Math.max(layout.rTimeAxis + 27.5, hitRMax ? hitRMax + 8.5 : 0);

    const [s0x, s0y] = polarPtVinyl(cx, cy, layout.rTone + 2.6, degAnchor);
    const [sMidX, sMidY] = polarPtVinyl(cx, cy, layout.rTimeAxis + 2.5, degAnchor);
    const [sEndX, sEndY] = polarPtVinyl(cx, cy, rDotOut - 3.4, degBadge);

    if (hitRMax !== null) {
      const [s2x, s2y] = polarPtVinyl(cx, cy, hitRMax + 1.5, degBadge);
      pointDialParts.push(
        `<line x1="${fmtNum(s0x)}" y1="${fmtNum(s0y)}" x2="${fmtNum(sMidX)}" y2="${fmtNum(sMidY)}" stroke="${COL.red}" stroke-opacity="0.65" stroke-width="0.62"/>`,
        `<line x1="${fmtNum(s2x)}" y1="${fmtNum(s2y)}" x2="${fmtNum(sEndX)}" y2="${fmtNum(sEndY)}" stroke="${COL.red}" stroke-opacity="0.65" stroke-width="0.62"/>`
      );
    } else if (Math.abs(degBadge - degAnchor) >= 0.4) {
      pointDialParts.push(
        `<polyline points="${fmtNum(s0x)},${fmtNum(s0y)} ${fmtNum(sMidX)},${fmtNum(sMidY)} ${fmtNum(sEndX)},${fmtNum(sEndY)}" fill="none" stroke="${COL.red}" stroke-opacity="0.65" stroke-width="0.62"/>`
      );
    } else {
      pointDialParts.push(
        `<line x1="${fmtNum(s0x)}" y1="${fmtNum(s0y)}" x2="${fmtNum(sEndX)}" y2="${fmtNum(sEndY)}" stroke="${COL.red}" stroke-opacity="0.65" stroke-width="0.62"/>`
      );
    }

    const [dxO, dyO] = polarPtVinyl(cx, cy, rDotOut, degBadge);
    const lblOff = 10.8 + 3.0 * Math.abs(Math.cos(radBadge));
    const [nx, ny] = polarPtVinyl(cx, cy, rDotOut + lblOff, degBadge);
    const numStr = String(pt.idx + 1).padStart(2, '0');
    pointDialParts.push(
      `<circle cx="${fmtNum(dxO)}" cy="${fmtNum(dyO)}" r="2.3" fill="${COL.red}"/>`,
      `<text x="${fmtNum(nx)}" y="${fmtNum(ny)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.6" font-weight="700" fill="${COL.red}" text-anchor="middle" dominant-baseline="central">${numStr}</text>`
    );
  }

  // Straight-wand Braun TP1 Tonearm
  pointDialParts.push(renderBraunTonearmSvg(cx, cy, layout.rPlatter, idPfx));

  // --------------------------------------------------------------------------
  // #editorial-copy (Header, 2-Column Tracklist/Directory, Bottom Legend)
  // --------------------------------------------------------------------------
  let editorialGroup = '';
  if (!isEmblem && !config.pureVisual) {
    const edParts: string[] = [];
    const titleStr = config.copy.title.trim() || autoCopy.title;
    const subStr = config.copy.subtitle.trim() || autoCopy.subtitle;
    const footStr = config.copy.footer.trim();

    // Top-right metadata + Swiss title lockup
    edParts.push(
      `<text x="${fmtNum(trimW - marginX)}" y="72" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="7.8" letter-spacing="1.6" fill="${COL.dim}" text-anchor="end">${escapeXml(autoCopy.sideLabel)}</text>`,
      `<text x="${fmtNum(marginX - 2)}" y="96" font-family="${escapeXml(POSTER_DISPLAY_SANS_STACK)}" font-size="49" font-weight="800" letter-spacing="-1.6" fill="${COL.ink}">ANATOMY OF</text>`,
      `<text x="${fmtNum(marginX - 2)}" y="146" font-family="${escapeXml(POSTER_DISPLAY_SANS_STACK)}" font-size="49" font-weight="800" letter-spacing="-1.6" fill="${COL.ink}">A VOICE</text>`,
      `<text x="${fmtNum(marginX + 216)}" y="144" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="19.5" font-weight="500" letter-spacing="1.1" fill="${COL.red}">${escapeXml(truncateByGraphemes(titleStr, 540, `500 19.5px ${POSTER_SANS_STACK}`))}</text>`,
      `<text x="${fmtNum(marginX)}" y="180" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="10.4" fill="#5A534B">${escapeXml(truncateByGraphemes(subStr, trimW - 2 * marginX, `400 10.4px ${POSTER_SANS_STACK}`))}</text>`
    );

    // Bottom 2-column directory (`tlTop = 942`)
    const tlTop = 942.0;
    const colGap = 36.0;
    const tlColW = (trimW - 2 * marginX - colGap) * 0.5;
    const maxRows = 30;

    if (layout.points.length > 0) {
      const shownPts = layout.points.slice(0, maxRows);
      const overflow = layout.points.length - shownPts.length;
      const half = Math.ceil(shownPts.length / 2);
      const rowStep = shownPts.length <= 12 ? 21.0 : Math.max(12.2, Math.min(18.0, 146.0 / Math.max(1, half)));
      const rowFs = shownPts.length <= 14 ? 7.6 : 6.7;

      const secTitle = `${layout.pointTierName || '标记点'}  ·  POINT ANNOTATIONS`;
      const secRight = `${layout.tMin.toFixed(2)} – ${layout.tMax.toFixed(2)} 秒  ·  共 ${layout.points.length} 处标注${overflow > 0 ? `（显示前 ${maxRows} 条，余 +${overflow}）` : ''}`;

      edParts.push(
        `<text x="${fmtNum(marginX)}" y="${fmtNum(tlTop + 8)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.6" font-weight="600" letter-spacing="1.0" fill="${COL.sub}">${escapeXml(secTitle)}</text>`,
        `<text x="${fmtNum(trimW - marginX)}" y="${fmtNum(tlTop + 8)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.2" letter-spacing="0.6" fill="${COL.dim}" text-anchor="end">${escapeXml(secRight)}</text>`,
        `<line x1="${fmtNum(marginX)}" y1="${fmtNum(tlTop + 16.5)}" x2="${fmtNum(trimW - marginX)}" y2="${fmtNum(tlTop + 16.5)}" stroke="${COL.hairline}" stroke-opacity="0.9" stroke-width="0.5"/>`
      );

      for (let i = 0; i < shownPts.length; i++) {
        const pt = shownPts[i];
        const colI = i < half ? 0 : 1;
        const rowI = i < half ? i : i - half;
        const bx = marginX + colI * (tlColW + colGap);
        const by = tlTop + 31.0 + rowI * rowStep;
        const numStr = String(pt.idx + 1).padStart(2, '0');
        const tStr = `${pt.time.toFixed(2)}s`;
        const noteSuffix = pt.note ? `  ·  ${pt.note}` : '';
        const textMaxW = tlColW - 68;
        const combined = truncateByGraphemes(`${pt.mark}${noteSuffix}`, textMaxW, `500 ${rowFs}px ${POSTER_IPA_STACK}`);

        edParts.push(
          `<text x="${fmtNum(bx)}" y="${fmtNum(by)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="${fmtNum(rowFs)}" font-weight="700" fill="${COL.red}" dominant-baseline="central">${numStr}</text>`,
          `<text x="${fmtNum(bx + 54)}" y="${fmtNum(by)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="${fmtNum(rowFs - 0.2)}" fill="${COL.sub}" text-anchor="end" dominant-baseline="central">${escapeXml(tStr)}</text>`
        );
        if (pt.note) {
          const safeMark = truncateByGraphemes(pt.mark, textMaxW * 0.42, `500 ${rowFs}px ${POSTER_IPA_STACK}`);
          const safeNote = truncateByGraphemes(pt.note, textMaxW * 0.54, `400 ${rowFs}px ${POSTER_SANS_STACK}`);
          edParts.push(
            `<text x="${fmtNum(bx + 66)}" y="${fmtNum(by)}" font-family="${escapeXml(POSTER_IPA_STACK)}" font-size="${fmtNum(rowFs)}" dominant-baseline="central">` +
              `<tspan fill="${COL.ink}" font-weight="500">${escapeXml(safeMark)}</tspan>` +
              `<tspan fill="#9E9588">  ·  </tspan>` +
              `<tspan fill="#5C554C" font-family="${escapeXml(POSTER_SANS_STACK)}">${escapeXml(safeNote)}</tspan>` +
              `</text>`
          );
        } else {
          edParts.push(
            `<text x="${fmtNum(bx + 66)}" y="${fmtNum(by)}" font-family="${escapeXml(POSTER_IPA_STACK)}" font-size="${fmtNum(rowFs)}" font-weight="500" fill="${COL.ink}" dominant-baseline="central">${escapeXml(combined)}</text>`
          );
        }
      }
    } else if (layout.rings.length > 0) {
      // Elegant 2-column tier inventory when no point tier is selected
      edParts.push(
        `<text x="${fmtNum(marginX)}" y="${fmtNum(tlTop + 8)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.6" font-weight="600" letter-spacing="1.0" fill="${COL.sub}">环形层级索引  ·  CONCENTRIC TIER INDEX</text>`,
        `<text x="${fmtNum(trimW - marginX)}" y="${fmtNum(tlTop + 8)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.2" letter-spacing="0.6" fill="${COL.dim}" text-anchor="end">${layout.tMin.toFixed(2)} – ${layout.tMax.toFixed(2)} 秒  ·  由内向外 ${layout.rings.length} 层</text>`,
        `<line x1="${fmtNum(marginX)}" y1="${fmtNum(tlTop + 16.5)}" x2="${fmtNum(trimW - marginX)}" y2="${fmtNum(tlTop + 16.5)}" stroke="${COL.hairline}" stroke-opacity="0.9" stroke-width="0.5"/>`
      );
      const half = Math.ceil(layout.rings.length / 2);
      for (let i = 0; i < layout.rings.length; i++) {
        const ring = layout.rings[i];
        const tier = tg.tiers[ring.tierIdx];
        const cnt = countActiveIntervals(tier, layout.tMin, layout.tMax);
        const colI = i < half ? 0 : 1;
        const rowI = i < half ? i : i - half;
        const bx = marginX + colI * (tlColW + colGap);
        const by = tlTop + 33.0 + rowI * 23.0;
        const st = VINYL_RING_STYLES[Math.min(i, VINYL_RING_STYLES.length - 1)];
        edParts.push(
          `<rect x="${fmtNum(bx)}" y="${fmtNum(by - 3.6)}" width="7.2" height="7.2" fill="${st.even}" stroke="rgba(25,24,22,0.18)" stroke-width="0.4"/>`,
          `<text x="${fmtNum(bx + 15)}" y="${fmtNum(by)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="7.4" fill="${COL.dim}" dominant-baseline="central">${String(i + 1).padStart(2, '0')}</text>`,
          `<text x="${fmtNum(bx + 36)}" y="${fmtNum(by)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="8.0" font-weight="600" fill="${COL.ink}" dominant-baseline="central">${escapeXml(truncateByGraphemes(ring.name, 190, `600 8px ${POSTER_SANS_STACK}`))}</text>`,
          `<text x="${fmtNum(bx + tlColW)}" y="${fmtNum(by)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="7.3" fill="${COL.sub}" text-anchor="end" dominant-baseline="central">${cnt} 段标注</text>`
        );
      }
    }

    // Bottom single-line exhibition legend / footer colophon
    const legY = 1140.0;
    edParts.push(
      `<line x1="${fmtNum(marginX)}" y1="${fmtNum(legY - 11.5)}" x2="${fmtNum(trimW - marginX)}" y2="${fmtNum(legY - 11.5)}" stroke="${COL.hairline}" stroke-opacity="0.85" stroke-width="0.5"/>`
    );

    if (footStr) {
      edParts.push(
        `<text x="${fmtNum(marginX)}" y="${fmtNum(legY + 4.5)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.5" fill="${COL.sub}" dominant-baseline="central">${escapeXml(truncateByGraphemes(footStr, trimW - 2 * marginX, `400 7.5px ${POSTER_SANS_STACK}`))}</text>`
      );
    } else {
      type SwatchItem = { kind: 'rect' | 'dot' | 'line' | 'grad'; swW: number; color: string; label: string };
      const items: SwatchItem[] = [];
      for (let i = 0; i < Math.min(layout.rings.length, 4); i++) {
        const st = VINYL_RING_STYLES[Math.min(i, VINYL_RING_STYLES.length - 1)];
        items.push({
          kind: 'rect',
          swW: 10.0,
          color: st.even,
          label: truncateByGraphemes(layout.rings[i].name, 68, `400 7.4px ${POSTER_SANS_STACK}`)
        });
      }
      if (layout.rings.length >= 5) {
        items.push({
          kind: 'rect',
          swW: 10.0,
          color: COL.ochreB,
          label: truncateByGraphemes(layout.rings[4].name, 68, `400 7.4px ${POSTER_SANS_STACK}`)
        });
      }
      if (layout.points.length > 0) {
        items.push({
          kind: 'dot',
          swW: 9.0,
          color: COL.red,
          label: `01–${String(layout.points.length).padStart(2, '0')} ${truncateByGraphemes(layout.pointTierName || '标点', 60, `400 7.4px ${POSTER_SANS_STACK}`)}`
        });
      }
      if (hasAudio && config.showPitch && f0Runs.length > 0) {
        items.push({ kind: 'line', swW: 13.5, color: COL.cyan, label: '基频曲线' });
      }
      if (hasAudio && (config.showSpectrogram || config.showWaveform)) {
        items.push({ kind: 'grad', swW: 23.5, color: '', label: '声音频谱与声波' });
      }
      if (items.length === 0) {
        edParts.push(
          `<text x="${fmtNum(marginX)}" y="${fmtNum(legY + 4.5)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.4" fill="${COL.sub}" dominant-baseline="central">${escapeXml(autoCopy.footer)}</text>`
        );
      } else {
        const legFontCss = `400 7.4px ${POSTER_SANS_STACK}`;
        const widths = items.map((it) => it.swW + measurePx(it.label, legFontCss));
        const totalW = widths.reduce((a, b) => a + b, 0);
        const availW = trimW - 2 * marginX;
        const maxGap = 36.0;
        const rawGap = items.length > 1 ? (availW - totalW) / (items.length - 1) : 0;
        const gap = items.length > 1 ? Math.max(10.0, Math.min(maxGap, rawGap)) : 0;
        const usedW = totalW + gap * Math.max(0, items.length - 1);
        const spareW = availW - usedW;
        // When legend has few items (leaving >140pt spare), keep swatches crisply grouped on the left
        // and balance the right margin with a subtle mono archive colophon!
        const showRightColophon = spareW > 140;
        let curX = showRightColophon ? marginX : marginX + Math.max(0, spareW * 0.5);
        const cyMid = legY + 4.8;
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (it.kind === 'rect') {
            edParts.push(
              `<rect x="${fmtNum(curX)}" y="${fmtNum(cyMid - 3.1)}" width="6.2" height="6.2" fill="${it.color}" stroke="rgba(25,24,22,0.22)" stroke-width="0.4"/>`
            );
          } else if (it.kind === 'dot') {
            edParts.push(`<circle cx="${fmtNum(curX + 3.0)}" cy="${fmtNum(cyMid)}" r="2.5" fill="${it.color}"/>`);
          } else if (it.kind === 'line') {
            edParts.push(
              `<line x1="${fmtNum(curX)}" y1="${fmtNum(cyMid)}" x2="${fmtNum(curX + 9.5)}" y2="${fmtNum(cyMid)}" stroke="${COL.ink}" stroke-width="2.0"/>`,
              `<line x1="${fmtNum(curX)}" y1="${fmtNum(cyMid)}" x2="${fmtNum(curX + 9.5)}" y2="${fmtNum(cyMid)}" stroke="${it.color}" stroke-width="1.1"/>`
            );
          } else if (it.kind === 'grad') {
            edParts.push(
              `<rect x="${fmtNum(curX)}" y="${fmtNum(cyMid - 3.0)}" width="19.5" height="6.0" fill="url(#${idPfx}spec-sw)"/>`
            );
          }
          edParts.push(
            `<text x="${fmtNum(curX + it.swW)}" y="${fmtNum(cyMid)}" font-family="${escapeXml(POSTER_SANS_STACK)}" font-size="7.4" fill="${COL.sub}" dominant-baseline="central">${escapeXml(it.label)}</text>`
          );
          curX += widths[i] + gap;
        }
        if (showRightColophon) {
          const rightStr = truncateByGraphemes(
            autoCopy.footer,
            Math.max(80, spareW - 24),
            `400 7.1px ${POSTER_MONO_STACK}`
          );
          edParts.push(
            `<text x="${fmtNum(trimW - marginX)}" y="${fmtNum(cyMid)}" font-family="${escapeXml(POSTER_MONO_STACK)}" font-size="7.1" fill="${COL.dim}" text-anchor="end" dominant-baseline="central">${escapeXml(rightStr)}</text>`
          );
        }
      }
    }

    editorialGroup = `<g id="editorial-copy">${edParts.join('')}</g>`;
  }

  // Wrap central dial layers if emblem scaling is active
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
