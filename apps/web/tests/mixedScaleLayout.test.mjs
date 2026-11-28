import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLayout,
  computeSmartMixedTierScales,
  elasticXInBand,
  getTierScaleInBand,
  resolveTierScaleKey,
  resolveTierScaleMode,
  timeFromElasticX,
  timeFromLinearX,
  timeFromTierX,
  xForTierTime
} from '../src/layout/computeLayout.ts';
import { getSnapCoordX, resolveSnap } from '../src/interaction/snapEngine.ts';
import { getStructureLines } from '../src/layout/legendCore.ts';
import {
  cloneStyleDocument,
  createDefaultStyleDocument,
  hasAnyCustomStyle,
  hasCustomLayoutPrefs
} from '../src/style/palettes.ts';
import { clearAllStyles } from '../src/style/resolveStyle.ts';
import {
  buildSvgProjectMetadataXml,
  extractProjectFromSvgText,
  parseStyleSidecar,
  serializeStyleSidecar
} from '../src/style/styleCodec.ts';

function makeIntervalTier(name, intervals, xmin = 0, xmax = 2.0) {
  return {
    name,
    kind: 'intervalTier',
    xmin,
    xmax,
    intervals,
    points: []
  };
}

function makeTextTier(name, points, xmin = 0, xmax = 2.0) {
  return {
    name,
    kind: 'textTier',
    xmin,
    xmax,
    intervals: [],
    points
  };
}

function makeBaseTextGrid() {
  return {
    xmin: 0,
    xmax: 2.0,
    tiers: [
      makeIntervalTier('words', [
        { xmin: 0.0, xmax: 0.5, text: 'hello' },
        { xmin: 0.5, xmax: 1.2, text: 'world' },
        { xmin: 1.2, xmax: 2.0, text: '' }
      ]),
      makeIntervalTier('phones', [
        { xmin: 0.0, xmax: 0.04, text: 'h' },
        { xmin: 0.04, xmax: 0.12, text: 'ə' },
        { xmin: 0.12, xmax: 0.2, text: 'l' },
        { xmin: 0.2, xmax: 0.5, text: 'oʊ' },
        { xmin: 0.5, xmax: 0.56, text: 'w' },
        { xmin: 0.56, xmax: 0.68, text: 'ɜː' },
        { xmin: 0.68, xmax: 0.74, text: 'l' },
        { xmin: 0.74, xmax: 1.2, text: 'd' },
        { xmin: 1.2, xmax: 2.0, text: '' }
      ]),
      makeTextTier('events', [
        { number: 0.04, mark: 'VOT' },
        { number: 0.56, mark: 'burst' }
      ])
    ]
  };
}

test('all-linear and all-elastic degeneration match pure modes identically', () => {
  const tg = makeBaseTextGrid();

  const pureLinear = computeLayout(tg, {
    scaleMode: 'linear',
    wrapMode: 'single',
    targetWidth: 960
  });
  const mixedAllLinear = computeLayout(tg, {
    scaleMode: 'mixed',
    tierScaleOverrides: { words: 'linear', phones: 'linear', events: 'linear' },
    wrapMode: 'single',
    targetWidth: 960
  });

  assert.equal(pureLinear.effectiveScaleMode, 'linear');
  assert.equal(mixedAllLinear.effectiveScaleMode, 'linear');
  assert.equal(pureLinear.maxTransitionNecks, 0);
  assert.equal(mixedAllLinear.maxTransitionNecks, 0);
  assert.equal(pureLinear.bands.length, mixedAllLinear.bands.length);
  assert.equal(pureLinear.width, mixedAllLinear.width);
  assert.equal(pureLinear.height, mixedAllLinear.height);
  assert.equal(pureLinear.bands[0].transitionNecks.length, 0);
  assert.equal(mixedAllLinear.bands[0].transitionNecks.length, 0);

  const pureElastic = computeLayout(tg, {
    scaleMode: 'elastic',
    wrapMode: 'single',
    targetWidth: 960
  });
  const mixedAllElastic = computeLayout(tg, {
    scaleMode: 'mixed',
    tierScaleOverrides: { words: 'elastic', phones: 'elastic', events: 'elastic' },
    wrapMode: 'single',
    targetWidth: 960
  });

  assert.equal(pureElastic.effectiveScaleMode, 'elastic');
  assert.equal(mixedAllElastic.effectiveScaleMode, 'elastic');
  assert.equal(pureElastic.maxTransitionNecks, 1);
  assert.equal(mixedAllElastic.maxTransitionNecks, 1);
  assert.equal(pureElastic.width, mixedAllElastic.width);
  assert.equal(pureElastic.height, mixedAllElastic.height);
  assert.equal(pureElastic.bands[0].transitionNecks.length, 1);
  assert.equal(mixedAllElastic.bands[0].transitionNecks.length, 1);
});

test('mixed single-neck produces contiguous coordSlices and single tick spine above first elastic run', () => {
  const tg = makeBaseTextGrid();
  const layout = computeLayout(tg, {
    scaleMode: 'mixed',
    tierScaleOverrides: { words: 'linear', phones: 'elastic', events: 'elastic' },
    wrapMode: 'single',
    targetWidth: 960
  });

  assert.equal(layout.effectiveScaleMode, 'mixed');
  assert.equal(layout.maxTransitionNecks, 1);
  assert.deepEqual(layout.tierScales, ['linear', 'elastic', 'elastic']);

  const band = layout.bands[0];
  assert.equal(band.hasMixedScales, true);
  assert.equal(band.transitionNecks.length, 1);
  assert.equal(band.transitionNecks[0].direction, 'l2e');
  assert.equal(band.transitionNecks[0].isPrimary, true);

  const wordsTl = band.tiersLayout[0];
  const phonesTl = band.tiersLayout[1];
  const eventsTl = band.tiersLayout[2];
  assert.equal(wordsTl.scaleMode, 'linear');
  assert.equal(phonesTl.scaleMode, 'elastic');
  assert.equal(eventsTl.scaleMode, 'elastic');

  // Linear tier sits directly under acoustic area, neck + tick spine sit between words and phones
  assert.ok(wordsTl.y + wordsTl.h <= band.transitionNecks[0].topY + 1e-6);
  assert.ok(band.transitionNecks[0].botY <= band.tickSpineTopY + 1e-6);
  assert.ok(Math.abs(band.tickSpineBotY - phonesTl.y) < 1e-6);

  // Verify coordSlices form a contiguous partition from band.linearY to band.tiersBottomY
  assert.ok(band.coordSlices.length >= 4);
  assert.ok(Math.abs(band.coordSlices[0].y0 - band.linearY) < 1e-6);
  assert.ok(
    Math.abs(band.coordSlices[band.coordSlices.length - 1].y1 - band.tiersBottomY) < 1e-6
  );
  for (let i = 1; i < band.coordSlices.length; i++) {
    assert.ok(
      Math.abs(band.coordSlices[i].y0 - band.coordSlices[i - 1].y1) < 1e-6,
      `slice ${i} y0 should match previous y1`
    );
  }
  const tickSpineSlices = band.coordSlices.filter((s) => s.kind === 'tick-spine');
  assert.equal(tickSpineSlices.length, 1);
});

test('mixed multi-neck (alternating linear/elastic/linear/elastic) creates compact secondary return necks', () => {
  const tg = {
    xmin: 0,
    xmax: 2.0,
    tiers: [
      makeIntervalTier('sentence', [{ xmin: 0, xmax: 2.0, text: 'hello world' }]),
      makeIntervalTier('phones', [
        { xmin: 0, xmax: 0.05, text: 'h' },
        { xmin: 0.05, xmax: 0.12, text: 'ə' },
        { xmin: 0.12, xmax: 0.5, text: 'loʊ' },
        { xmin: 0.5, xmax: 2.0, text: 'wɜːld' }
      ]),
      makeTextTier('peaks', [
        { number: 0.25, mark: 'H*' },
        { number: 1.1, mark: 'L%' }
      ]),
      makeIntervalTier('notes', [
        { xmin: 0, xmax: 0.5, text: 'onset' },
        { xmin: 0.5, xmax: 2.0, text: 'coda' }
      ])
    ]
  };

  const layout = computeLayout(tg, {
    scaleMode: 'mixed',
    tierScaleOverrides: {
      sentence: 'linear',
      phones: 'elastic',
      peaks: 'linear',
      notes: 'elastic'
    },
    wrapMode: 'single',
    targetWidth: 960
  });

  assert.equal(layout.effectiveScaleMode, 'mixed');
  assert.equal(layout.maxTransitionNecks, 3);

  const band = layout.bands[0];
  assert.equal(band.transitionNecks.length, 3);
  assert.deepEqual(
    band.transitionNecks.map((n) => n.direction),
    ['l2e', 'e2l', 'l2e']
  );
  assert.deepEqual(
    band.transitionNecks.map((n) => n.isPrimary),
    [true, false, false]
  );

  // Secondary return necks must use compact height in [12, 22]
  for (const neck of band.transitionNecks.slice(1)) {
    const h = neck.botY - neck.topY;
    assert.ok(h >= 12 && h <= 22, `secondary neck height ${h} should be in [12, 22]`);
  }

  // Only one tick-spine slice per band
  assert.equal(band.coordSlices.filter((s) => s.kind === 'tick-spine').length, 1);

  // Still strictly contiguous
  for (let i = 1; i < band.coordSlices.length; i++) {
    assert.ok(Math.abs(band.coordSlices[i].y0 - band.coordSlices[i - 1].y1) < 1e-6);
  }
});

test('elastic weight isolation: long linear-tier text does not stretch elastic tier columns', () => {
  const phonesIntervals = [
    { xmin: 0.0, xmax: 0.04, text: 'pʰ' },
    { xmin: 0.04, xmax: 0.1, text: 'a' },
    { xmin: 0.1, xmax: 0.5, text: 't' },
    { xmin: 0.5, xmax: 1.0, text: 'k' }
  ];

  const tgShortLinear = {
    xmin: 0,
    xmax: 1.0,
    tiers: [
      makeIntervalTier('words', [
        { xmin: 0.0, xmax: 0.5, text: 'a' },
        { xmin: 0.5, xmax: 1.0, text: 'b' }
      ], 0, 1.0),
      makeIntervalTier('phones', phonesIntervals, 0, 1.0)
    ]
  };

  const tgLongLinear = {
    xmin: 0,
    xmax: 1.0,
    tiers: [
      makeIntervalTier('words', [
        { xmin: 0.0, xmax: 0.04, text: 'SUPER_LONG_LINEAR_ONLY_ANNOTATION_STRING_XYZ' },
        { xmin: 0.04, xmax: 0.5, text: 'ANOTHER_VERY_LONG_WORD_LABEL_12345' },
        { xmin: 0.5, xmax: 1.0, text: 'b' }
      ], 0, 1.0),
      makeIntervalTier('phones', phonesIntervals, 0, 1.0)
    ]
  };

  const opts = {
    scaleMode: 'mixed',
    tierScaleOverrides: { words: 'linear', phones: 'elastic' },
    wrapMode: 'single',
    targetWidth: 960
  };
  const layA = computeLayout(tgShortLinear, opts);
  const layB = computeLayout(tgLongLinear, opts);

  const phonesA = layA.bands[0].tiersLayout[1].visibleIvs;
  const phonesB = layB.bands[0].tiersLayout[1].visibleIvs;
  assert.equal(phonesA.length, phonesB.length);
  for (let i = 0; i < phonesA.length; i++) {
    assert.ok(
      Math.abs(phonesA[i].w - phonesB[i].w) < 1e-6,
      `elastic phone ${i} width changed (${phonesA[i].w} vs ${phonesB[i].w}) due to linear tier text`
    );
  }
});

test('shared boundary accounting and left/right band edge alignment across linear and elastic tiers', () => {
  const tg = makeBaseTextGrid();
  const layout = computeLayout(tg, {
    scaleMode: 'mixed',
    tierScaleOverrides: { words: 'linear', phones: 'elastic', events: 'linear' },
    wrapMode: 'single',
    targetWidth: 960
  });
  const band = layout.bands[0];

  // Time 0.5 is shared by words (linear) and phones (elastic)
  const col05 = band.spineCols.find((c) => Math.abs(c.t - 0.5) < 1e-9);
  assert.ok(col05, 'spineCol for t=0.5 should exist');
  assert.ok(col05.linearUsage > 0, 't=0.5 should record linearUsage > 0');
  assert.ok(col05.elasticUsage > 0, 't=0.5 should record elasticUsage > 0');

  // Time 0.12 is only on phones (elastic)
  const col012 = band.spineCols.find((c) => Math.abs(c.t - 0.12) < 1e-9);
  assert.ok(col012);
  assert.equal(col012.linearUsage, 0);
  assert.ok(col012.elasticUsage > 0);

  // Both linear and elastic tiers start at originX and end at originX + bandContentW
  const leftEdge = band.originX;
  const rightEdge = band.originX + band.bandContentW;
  assert.ok(Math.abs(xForTierTime(band, 0, band.startT) - leftEdge) < 1e-6);
  assert.ok(Math.abs(xForTierTime(band, 1, band.startT) - leftEdge) < 1e-6);
  assert.ok(Math.abs(xForTierTime(band, 0, band.endT) - rightEdge) < 1e-6);
  assert.ok(Math.abs(xForTierTime(band, 1, band.endT) - rightEdge) < 1e-6);
});

test('mixed mode preserves synchronous >= 0.5s all-tier silence folding and respects linear-tier text', () => {
  const tgSilent = {
    xmin: 0,
    xmax: 3.0,
    tiers: [
      makeIntervalTier('words', [
        { xmin: 0.0, xmax: 0.4, text: 'hi' },
        { xmin: 0.4, xmax: 2.4, text: '' },
        { xmin: 2.4, xmax: 3.0, text: 'bye' }
      ], 0, 3.0),
      makeIntervalTier('phones', [
        { xmin: 0.0, xmax: 0.4, text: 'haɪ' },
        { xmin: 0.4, xmax: 2.4, text: '' },
        { xmin: 2.4, xmax: 3.0, text: 'baɪ' }
      ], 0, 3.0)
    ]
  };

  const layCollapsed = computeLayout(tgSilent, {
    scaleMode: 'mixed',
    tierScaleOverrides: { words: 'linear', phones: 'elastic' },
    wrapMode: 'single',
    targetWidth: 960
  });
  const collapsedSegs = layCollapsed.bands[0].linearSegs.filter((s) => s.collapsed);
  assert.ok(collapsedSegs.length >= 1, 'long all-tier silence should fold in mixed mode');

  // If the linear tier has non-empty text in [0.4, 2.4], it must NOT collapse
  const tgLinearSpeech = {
    xmin: 0,
    xmax: 3.0,
    tiers: [
      makeIntervalTier('words', [
        { xmin: 0.0, xmax: 0.4, text: 'hi' },
        { xmin: 0.4, xmax: 2.4, text: 'sustained phrase' },
        { xmin: 2.4, xmax: 3.0, text: 'bye' }
      ], 0, 3.0),
      makeIntervalTier('phones', [
        { xmin: 0.0, xmax: 0.4, text: 'haɪ' },
        { xmin: 0.4, xmax: 2.4, text: '' },
        { xmin: 2.4, xmax: 3.0, text: 'baɪ' }
      ], 0, 3.0)
    ]
  };
  const layUncollapsed = computeLayout(tgLinearSpeech, {
    scaleMode: 'mixed',
    tierScaleOverrides: { words: 'linear', phones: 'elastic' },
    wrapMode: 'single',
    targetWidth: 960
  });
  assert.equal(
    layUncollapsed.bands[0].linearSegs.filter((s) => s.collapsed).length,
    0,
    'non-empty linear tier interval should prevent silence collapse'
  );
});

test('xForTierTime / timeFromTierX roundtrip and cross-coordinate resolveSnap accuracy', () => {
  const tg = makeBaseTextGrid();
  const layout = computeLayout(tg, {
    scaleMode: 'mixed',
    tierScaleOverrides: { words: 'linear', phones: 'elastic', events: 'linear' },
    wrapMode: 'auto',
    targetWidth: 700
  });

  for (const band of layout.bands) {
    assert.equal(getTierScaleInBand(band, 0), 'linear');
    assert.equal(getTierScaleInBand(band, 1), 'elastic');
    assert.equal(getTierScaleInBand(band, 2), 'linear');

    const sampleTimes = [
      band.startT,
      band.startT + (band.endT - band.startT) * 0.15,
      band.startT + (band.endT - band.startT) * 0.5,
      band.startT + (band.endT - band.startT) * 0.85,
      band.endT
    ];
    for (const ti of [0, 1, 2]) {
      for (const t of sampleTimes) {
        const x = xForTierTime(band, ti, t);
        const rt = timeFromTierX(band, ti, x);
        assert.ok(
          Math.abs(rt - t) < 1e-4,
          `tier ${ti} roundtrip mismatch: t=${t}, x=${x}, rt=${rt}`
        );
        if (ti === 0 || ti === 2) {
          assert.ok(Math.abs(x - band.linearXForTime(t)) < 1e-6);
          assert.ok(Math.abs(rt - timeFromLinearX(band, x)) < 1e-6);
        } else {
          assert.ok(Math.abs(x - elasticXInBand(band, t)) < 1e-6);
          assert.ok(Math.abs(rt - timeFromElasticX(band, x)) < 1e-6);
        }
      }
    }
  }

  // Cross-coordinate magnetic snap: dragging in linear tier (words) near elastic tier boundary (phones t=0.2)
  const singleLay = computeLayout(tg, {
    scaleMode: 'mixed',
    tierScaleOverrides: { words: 'linear', phones: 'elastic', events: 'linear' },
    wrapMode: 'single',
    targetWidth: 960
  });
  const band0 = singleLay.bands[0];
  const linXAt02 = xForTierTime(band0, 0, 0.2);
  const snapFromLinear = resolveSnap({
    tg,
    band: band0,
    pointerX: linXAt02 + 2,
    coordSpace: 'linear',
    isAcousticTrack: false,
    minAllowed: 0.05,
    maxAllowed: 0.9,
    allowEndpoints: false,
    activeTierIndex: 0
  });
  assert.ok(snapFromLinear, 'linear tier drag should snap to elastic tier boundary at t=0.2');
  assert.ok(Math.abs(snapFromLinear.t - 0.2) < 1e-9);
  assert.ok(Math.abs(getSnapCoordX(snapFromLinear, 'linear') - linXAt02) < 1e-6);

  // Reverse direction: dragging in elastic tier (phones) near linear tier boundary (words t=0.5)
  const elXAt05 = xForTierTime(band0, 1, 0.5);
  const snapFromElastic = resolveSnap({
    tg,
    band: band0,
    pointerX: elXAt05 - 2,
    coordSpace: 'elastic',
    isAcousticTrack: false,
    minAllowed: 0.1,
    maxAllowed: 1.5,
    allowEndpoints: false,
    activeTierIndex: 1,
    excludeOwnBoundaryTime: 0.12
  });
  assert.ok(snapFromElastic, 'elastic tier drag should snap to linear tier boundary at t=0.5');
  assert.ok(Math.abs(snapFromElastic.t - 0.5) < 1e-9);
  assert.ok(Math.abs(getSnapCoordX(snapFromElastic, 'elastic') - elXAt05) < 1e-6);
});

test('computeSmartMixedTierScales assigns coarse/event tiers to linear and dense IPA tiers to elastic', () => {
  const tg = {
    xmin: 0,
    xmax: 2.0,
    tiers: [
      makeIntervalTier('utterance', [
        { xmin: 0.0, xmax: 1.0, text: 'hello' },
        { xmin: 1.0, xmax: 2.0, text: 'world' }
      ]),
      makeIntervalTier('phones', [
        { xmin: 0.0, xmax: 0.025, text: 'tʃʰ' },
        { xmin: 0.025, xmax: 0.055, text: 'ɪː' },
        { xmin: 0.055, xmax: 0.08, text: 'ŋɡ' },
        { xmin: 0.08, xmax: 0.11, text: 'wə' },
        { xmin: 0.11, xmax: 0.14, text: 'n̪' },
        { xmin: 0.14, xmax: 0.17, text: 'tʰ' },
        { xmin: 0.17, xmax: 0.2, text: 'aɪ' },
        { xmin: 0.2, xmax: 2.0, text: '' }
      ]),
      makeTextTier('events', [
        { number: 0.15, mark: 'VOT' },
        { number: 0.9, mark: 'H*' }
      ])
    ]
  };

  const smart = computeSmartMixedTierScales(tg, 240);
  assert.equal(smart.utterance, 'linear');
  assert.equal(smart.phones, 'elastic');
  assert.equal(smart.events, 'linear');

  // Empty tier name key uses #<index>
  const unnamedTg = {
    xmin: 0,
    xmax: 1.0,
    tiers: [makeIntervalTier('', [{ xmin: 0, xmax: 1.0, text: 'a' }], 0, 1.0)]
  };
  assert.equal(resolveTierScaleKey(unnamedTg, 0), '#0');
  assert.equal(resolveTierScaleMode(unnamedTg, 0, 'mixed', { '#0': 'linear' }), 'linear');

  // Legend structure lines support 'mixed' in both zh and en
  assert.equal(getStructureLines('mixed', 'zh').length, 3);
  assert.equal(getStructureLines('mixed', 'en').length, 3);
});

test('layoutPrefs roundtrip via .tgstyle.json sidecar, SVG <metadata>, backward compat, and clearAllStyles', () => {
  const tg = makeBaseTextGrid();
  const baseDoc = createDefaultStyleDocument();
  baseDoc.layoutPrefs = {
    scaleMode: 'mixed',
    tierScaleOverrides: {
      words: 'linear',
      phones: 'elastic',
      events: 'linear'
    }
  };

  // Layout prefs do not pollute style badges (hasAnyCustomStyle remains false), but hasCustomLayoutPrefs is true
  assert.equal(hasAnyCustomStyle(baseDoc), false);
  assert.equal(hasCustomLayoutPrefs(baseDoc), true);

  // Clone preserves layoutPrefs deeply
  const cloned = cloneStyleDocument(baseDoc);
  cloned.layoutPrefs.tierScaleOverrides.words = 'elastic';
  assert.equal(baseDoc.layoutPrefs.tierScaleOverrides.words, 'linear');

  // clearAllStyles preserves layoutPrefs
  const cleared = clearAllStyles(baseDoc);
  assert.deepEqual(cleared.layoutPrefs, baseDoc.layoutPrefs);

  // Sidecar JSON roundtrip
  const sidecarText = serializeStyleSidecar(baseDoc);
  const parsedSidecar = parseStyleSidecar(sidecarText);
  assert.ok(parsedSidecar);
  assert.deepEqual(parsedSidecar.layoutPrefs, baseDoc.layoutPrefs);

  // Backward compatibility: legacy sidecar without layoutPrefs parses cleanly with layoutPrefs undefined
  const legacyJson = JSON.stringify({
    version: 1,
    paletteId: 'classic-ink',
    bwPrintMode: false,
    showLegendInExport: false,
    rules: [],
    tierStyles: {},
    intervalOverrides: [],
    boundaryOverrides: [],
    pointOverrides: []
  });
  const parsedLegacy = parseStyleSidecar(legacyJson);
  assert.ok(parsedLegacy);
  assert.equal(parsedLegacy.layoutPrefs, undefined);

  // SVG <metadata> roundtrip
  const metaXml = buildSvgProjectMetadataXml(tg, baseDoc, {
    filename: 'demo.TextGrid'
  });
  const fakeSvg = `<svg xmlns="http://www.w3.org/2000/svg">${metaXml}</svg>`;
  const extracted = extractProjectFromSvgText(fakeSvg);
  assert.ok(extracted);
  assert.ok(extracted.styleDoc);
  assert.deepEqual(extracted.styleDoc.layoutPrefs, baseDoc.layoutPrefs);
});
