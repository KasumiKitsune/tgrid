import test from 'node:test';
import assert from 'node:assert/strict';

import { STYLE_SCHEMA_VERSION } from '../src/style/types.ts';
import {
  BUILTIN_STYLE_RULE_PRESETS,
  BW_GRAY_LEVELS,
  PALETTES,
  cloneStyleDocument,
  createDefaultStyleDocument,
  createRuleFromPreset,
  getPalette,
  getSwatch,
  hasAnyCustomStyle
} from '../src/style/palettes.ts';
import {
  applyStyleToSameTextIntervals,
  buildStyleLegendItems,
  buildSvgPatternDefs,
  clearAllStyles,
  clearObjectStyleOverride,
  collectUsedPatternSpecs,
  mapColorToBwPrint,
  matchesStyleRule,
  resolveBoundaryStyle,
  resolveIntervalStyle,
  resolvePointStyle,
  resolveTierStyle,
  setBoundaryStyleOverride,
  setIntervalStyleOverride,
  setPointStyleOverride,
  setTierStylePatch
} from '../src/style/resolveStyle.ts';
import {
  propagateStylesOnBoundaryMove,
  propagateStylesOnMerge,
  propagateStylesOnSplit,
  propagateStylesOnTierChange,
  reconcileStyleDocument
} from '../src/style/reconcileStyle.ts';
import {
  TGRID_SVG_METADATA_NS,
  buildSvgProjectMetadataXml,
  extractProjectFromSvgText,
  getStyleSidecarPath,
  parseStyleSidecar,
  serializeStyleSidecar
} from '../src/style/styleCodec.ts';

function makeSampleTextGrid() {
  return {
    name: 'sample.TextGrid',
    xmin: 0,
    xmax: 3.0,
    tiers: [
      {
        kind: 'intervalTier',
        name: '词',
        xmin: 0,
        xmax: 3.0,
        intervals: [
          { xmin: 0, xmax: 0.5, text: '' },
          { xmin: 0.5, xmax: 1.5, text: '你好' },
          { xmin: 1.5, xmax: 2.5, text: '北京' },
          { xmin: 2.5, xmax: 3.0, text: '' }
        ],
        points: []
      },
      {
        kind: 'intervalTier',
        name: '音素',
        xmin: 0,
        xmax: 3.0,
        intervals: [
          { xmin: 0, xmax: 0.5, text: '' },
          { xmin: 0.5, xmax: 0.8, text: 'pʰ' },
          { xmin: 0.8, xmax: 1.2, text: 'a' },
          { xmin: 1.2, xmax: 1.5, text: 'ŋ' },
          { xmin: 1.5, xmax: 2.0, text: 't' },
          { xmin: 2.0, xmax: 2.5, text: 'ə' },
          { xmin: 2.5, xmax: 3.0, text: '' }
        ],
        points: []
      },
      {
        kind: 'textTier',
        name: '声调标点',
        xmin: 0,
        xmax: 3.0,
        intervals: [],
        points: [
          { number: 0.95, mark: 'H*' },
          { number: 2.2, mark: 'L%' }
        ]
      }
    ]
  };
}

// ============================================================================
// 1. Palettes & BW print mapping
// ============================================================================

test('palettes provide 4 academic sets with 8 swatches and BW pattern specs', () => {
  assert.equal(PALETTES.length, 4);
  const ids = PALETTES.map((p) => p.id);
  assert.deepEqual(ids, ['warm-academic', 'colorblind-safe', 'presentation', 'journal-bw']);

  for (const palette of PALETTES) {
    assert.equal(palette.swatches.length, 8);
    const swatchIds = palette.swatches.map((s) => s.id);
    assert.deepEqual(swatchIds, ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
    for (const sw of palette.swatches) {
      assert.ok(sw.name.length > 0);
      assert.match(sw.fill, /^#[0-9A-Fa-f]{6}$/);
      assert.match(sw.stroke, /^#[0-9A-Fa-f]{6}$/);
      assert.match(sw.text, /^#[0-9A-Fa-f]{6}$/);
      assert.match(sw.bwGray, /^#[0-9A-Fa-f]{6}$/);
      assert.match(sw.bwStroke, /^#[0-9A-Fa-f]{6}$/);
    }
  }

  assert.equal(getPalette('unknown-id').id, 'warm-academic');
  assert.equal(getSwatch('warm-academic', 's1')?.name, '暖杏');
  assert.equal(getSwatch('warm-academic', 's99'), null);
});

test('BW print mode maps swatches and custom hex colors deterministically to grayscale + vector patterns', () => {
  const tg = makeSampleTextGrid();
  let doc = createDefaultStyleDocument('warm-academic');
  doc = setIntervalStyleOverride(doc, tg, 0, 1, { swatchId: 's1' });
  doc = setIntervalStyleOverride(doc, tg, 0, 2, { fillColor: '#3B82F6', borderColor: '#1D4ED8' });

  // Color mode first
  const colorIv1 = resolveIntervalStyle(doc, tg, 0, 1);
  assert.equal(colorIv1.fill, getSwatch('warm-academic', 's1').fill);
  assert.equal(colorIv1.pattern, 'none');

  // Enable BW print mode
  doc.bwPrintMode = true;
  const bwIv1 = resolveIntervalStyle(doc, tg, 0, 1);
  assert.equal(bwIv1.fill, getSwatch('warm-academic', 's1').bwGray);
  assert.equal(bwIv1.pattern, getSwatch('warm-academic', 's1').bwPattern);
  assert.equal(bwIv1.borderColor, getSwatch('warm-academic', 's1').bwStroke);
  assert.equal(bwIv1.textColor, '#000000');

  // Custom chromatic hex falls back to deterministic grayscale + non-none pattern
  const bwIv2 = resolveIntervalStyle(doc, tg, 0, 2);
  assert.ok(BW_GRAY_LEVELS.includes(bwIv2.fill));
  assert.notEqual(bwIv2.pattern, 'none');
  assert.equal(bwIv2.textColor, '#000000');

  // Two distinct hues map to distinct patterns; neutral gray stays solid ('none')
  const redMap = mapColorToBwPrint('#E53935');
  const blueMap = mapColorToBwPrint('#1E88E5');
  const grayMap = mapColorToBwPrint('#B0B0B0');
  assert.notEqual(redMap.pattern, blueMap.pattern);
  assert.equal(grayMap.pattern, 'none');

  // Journal BW palette applies vector patterns even when bwPrintMode is false
  const jDoc = setIntervalStyleOverride(createDefaultStyleDocument('journal-bw'), tg, 0, 1, {
    swatchId: 's4'
  });
  const jRes = resolveIntervalStyle(jDoc, tg, 0, 1);
  assert.equal(jRes.pattern, 'crosshatch');
});

// ============================================================================
// 2. Four-layer inheritance & rule matching
// ============================================================================

test('interval style follows four-layer inheritance: global < tier < rule < override', () => {
  const tg = makeSampleTextGrid();
  let doc = createDefaultStyleDocument('warm-academic');

  // Layer 1: global
  doc.globalInterval = {
    swatchId: 's7',
    borderWidth: 1.5,
    fontStyle: 'italic'
  };
  let r = resolveIntervalStyle(doc, tg, 1, 2); // 'a'
  assert.equal(r.swatchId, 's7');
  assert.equal(r.borderWidth, 1.5);
  assert.equal(r.fontStyle, 'italic');
  assert.equal(r.hasCustom, true);

  // Layer 2: tier default overrides global
  doc = setTierStylePatch(doc, '音素', {
    labelBg: '#F0ECE2',
    labelColor: '#1E3A5F',
    intervalDefault: {
      swatchId: 's6',
      borderWidth: 2
    }
  });
  r = resolveIntervalStyle(doc, tg, 1, 2);
  assert.equal(r.swatchId, 's6');
  assert.equal(r.borderWidth, 2);
  assert.equal(r.fontStyle, 'italic'); // inherited from global

  const tierStyle = resolveTierStyle(doc, tg, 1);
  assert.equal(tierStyle.labelBg, '#F0ECE2');
  assert.equal(tierStyle.labelColor, '#1E3A5F');
  assert.equal(tierStyle.hasCustom, true);

  // Layer 3: conditional rule overrides tier default
  const vowelRule = createRuleFromPreset('preset-vowels', { id: 'r-vowel', tierName: '音素' });
  assert.ok(vowelRule);
  doc.rules.push(vowelRule);
  r = resolveIntervalStyle(doc, tg, 1, 2); // 'a' matches vowel rule
  assert.equal(r.swatchId, 's1');
  assert.equal(r.matchedRuleId, 'r-vowel');
  assert.equal(r.borderWidth, 2); // still inherited from tier

  // Layer 4: individual override overrides rule; partial patch preserves lower swatch
  doc = setIntervalStyleOverride(doc, tg, 1, 2, { fontWeight: 'bold' });
  r = resolveIntervalStyle(doc, tg, 1, 2);
  assert.equal(r.swatchId, 's1');
  assert.equal(r.fontWeight, 'bold');

  // Explicit swatch override replaces rule swatch
  doc = setIntervalStyleOverride(doc, tg, 1, 2, { swatchId: 's4', borderDash: 'dashed' });
  r = resolveIntervalStyle(doc, tg, 1, 2);
  assert.equal(r.swatchId, 's4');
  assert.equal(r.fill, getSwatch('warm-academic', 's4').fill);
  assert.equal(r.borderDash, 'dashed');
  assert.equal(r.fontWeight, 'bold');

  // Clearing swatchId with null removes swatch fill while keeping explicit fields
  doc = setIntervalStyleOverride(doc, tg, 1, 2, { swatchId: null }, 'replace');
  r = resolveIntervalStyle(doc, tg, 1, 2);
  assert.equal(r.swatchId, null);
  assert.equal(r.fill, '#FFFFFF');
});

test('conditional rules support exact, contains, regex, empty, non-empty, tier scoping and invalid regex safety', () => {
  const mk = (partial) => ({
    id: 'r',
    name: 'test',
    enabled: true,
    matchKind: 'exact',
    pattern: '',
    ...partial
  });

  assert.equal(matchesStyleRule(mk({ matchKind: 'exact', pattern: 'a' }), '音素', 'A'), true);
  assert.equal(
    matchesStyleRule(mk({ matchKind: 'exact', pattern: 'a', caseSensitive: true }), '音素', 'A'),
    false
  );
  assert.equal(matchesStyleRule(mk({ matchKind: 'contains', pattern: '京' }), '词', '北京'), true);
  assert.equal(matchesStyleRule(mk({ matchKind: 'empty' }), '词', '   '), true);
  assert.equal(matchesStyleRule(mk({ matchKind: 'empty' }), '词', 'a'), false);
  assert.equal(matchesStyleRule(mk({ matchKind: 'non-empty' }), '词', 'a'), true);
  assert.equal(
    matchesStyleRule(mk({ matchKind: 'regex', pattern: '^[ptk][ʰh]?$', caseSensitive: true }), '音素', 'pʰ'),
    true
  );
  assert.equal(
    matchesStyleRule(mk({ matchKind: 'regex', pattern: '[invalid(' }), '音素', 'a'),
    false
  );
  assert.equal(
    matchesStyleRule(mk({ matchKind: 'exact', pattern: 'a', tierName: '音素' }), '词', 'a'),
    false
  );
  assert.equal(
    matchesStyleRule(mk({ matchKind: 'exact', pattern: 'a', enabled: false }), '音素', 'a'),
    false
  );

  // Built-in presets sanity check
  assert.equal(BUILTIN_STYLE_RULE_PRESETS.length, 4);
  const tg = makeSampleTextGrid();
  const doc = createDefaultStyleDocument();
  doc.rules = BUILTIN_STYLE_RULE_PRESETS.map((p) => createRuleFromPreset(p.id));

  assert.equal(resolveIntervalStyle(doc, tg, 1, 0).swatchId, 's7'); // silence
  assert.equal(resolveIntervalStyle(doc, tg, 1, 1).swatchId, 's2'); // pʰ voiceless stop
  assert.equal(resolveIntervalStyle(doc, tg, 1, 2).swatchId, 's1'); // a vowel
  assert.equal(resolveIntervalStyle(doc, tg, 1, 3).swatchId, 's3'); // ŋ nasal
});

test('boundary and point resolution support shared boundaries, tier defaults, rules and overrides', () => {
  const tg = makeSampleTextGrid();
  let doc = createDefaultStyleDocument('warm-academic');

  doc.globalBoundary = { strokeWidth: 1.2 };
  doc = setTierStylePatch(doc, '词', { boundaryDefault: { strokeDash: 'dotted' } });
  // Shared boundary at t = 1.5
  doc = setBoundaryStyleOverride(doc, tg, null, 1.5, {
    swatchId: 's4',
    strokeWidth: 2,
    extendToAcoustic: true
  });
  // Tier-specific override at t = 1.5 on tier 0 overrides shared boundary
  doc = setBoundaryStyleOverride(doc, tg, 0, 1.5, {
    swatchId: 's2',
    strokeDash: 'dashed'
  });

  const bTier1 = resolveBoundaryStyle(doc, tg, 1, 1.5);
  assert.equal(bTier1.swatchId, 's4');
  assert.equal(bTier1.strokeWidth, 2);
  assert.equal(bTier1.extendToAcoustic, true);

  const bTier0 = resolveBoundaryStyle(doc, tg, 0, 1.5);
  assert.equal(bTier0.swatchId, 's2');
  assert.equal(bTier0.strokeDash, 'dashed');
  assert.equal(bTier0.extendToAcoustic, true); // inherited from shared boundary

  // Point rules & overrides
  doc.rules.push({
    id: 'r-high-tone',
    name: '高调目标',
    enabled: true,
    tierName: '声调标点',
    matchKind: 'contains',
    pattern: 'H',
    pointStyle: { swatchId: 's4', shape: 'diamond', size: 6 }
  });
  doc = setPointStyleOverride(doc, tg, 2, 1, {
    swatchId: 's2',
    shape: 'triangle',
    stemDash: 'dashed',
    fontWeight: 'bold'
  });

  const p0 = resolvePointStyle(doc, tg, 2, 0);
  assert.equal(p0.shape, 'diamond');
  assert.equal(p0.size, 6);
  assert.equal(p0.matchedRuleId, 'r-high-tone');

  const p1 = resolvePointStyle(doc, tg, 2, 1);
  assert.equal(p1.shape, 'triangle');
  assert.equal(p1.stemDash, 'dashed');
  assert.equal(p1.fontWeight, 'bold');
});

test('SVG pattern defs, legend items and pure mutation helpers work consistently', () => {
  const tg = makeSampleTextGrid();
  let doc = createDefaultStyleDocument('warm-academic');
  doc.swatchLabels = { s1: '元音', s2: '目标词' };
  doc.rules.push(createRuleFromPreset('preset-vowels', { id: 'r-v', tierName: '音素' }));
  doc = applyStyleToSameTextIntervals(doc, tg, 0, 1, { swatchId: 's2', pattern: 'hatch-diag' });

  const specs = collectUsedPatternSpecs(doc, tg, 'exp');
  assert.equal(specs.length, 1);
  assert.equal(specs[0].kind, 'hatch-diag');
  const defs = buildSvgPatternDefs(specs);
  assert.ok(defs.includes('<pattern id="exp-hatch-diag-'));
  assert.ok(defs.includes('patternUnits="userSpaceOnUse"'));

  const legend = buildStyleLegendItems(doc, tg);
  assert.equal(legend.length, 2);
  assert.deepEqual(
    legend.map((i) => i.label),
    ['元音', '目标词']
  );

  // Clearing single override & clearing all
  doc = clearObjectStyleOverride(doc, { kind: 'interval', tierIndex: 0, itemIndex: 1 });
  assert.equal(doc.intervalOverrides.length, 0);

  const cleared = clearAllStyles(doc, { keepPalette: true });
  assert.equal(hasAnyCustomStyle(cleared), false);
});

// ============================================================================
// 3. Edit propagation (split / merge / boundary move / tier change)
// ============================================================================

test('propagateStylesOnSplit inherits style on non-empty children, skips empty silence, and shifts indices', () => {
  const tg = makeSampleTextGrid();
  let doc = createDefaultStyleDocument();
  // Style interval 1 ('你好', 0.5-1.5) and interval 2 ('北京', 1.5-2.5)
  doc = setIntervalStyleOverride(doc, tg, 0, 1, { swatchId: 's1' });
  doc = setIntervalStyleOverride(doc, tg, 0, 2, { swatchId: 's2' });

  // Split interval 1 into 3 pieces: '你', '' (silence), '好'
  const afterSplit = propagateStylesOnSplit(doc, 0, '词', 1, 0.5, 1.5, [
    { xmin: 0.5, xmax: 0.9, text: '你' },
    { xmin: 0.9, xmax: 1.1, text: '' },
    { xmin: 1.1, xmax: 1.5, text: '好' }
  ]);

  const byIdx = new Map(afterSplit.intervalOverrides.map((o) => [o.itemIndex, o]));
  assert.equal(byIdx.get(1)?.style.swatchId, 's1');
  assert.equal(byIdx.get(1)?.textSnapshot, '你');
  assert.equal(byIdx.has(2), false); // empty silence does NOT retain color block
  assert.equal(byIdx.get(3)?.style.swatchId, 's1');
  assert.equal(byIdx.get(3)?.textSnapshot, '好');
  assert.equal(byIdx.get(4)?.style.swatchId, 's2'); // shifted from 2 -> 4
});

test('propagateStylesOnMerge prioritizes primary or non-empty interval, compresses indices and drops interior boundaries', () => {
  const tg = makeSampleTextGrid();
  let doc = createDefaultStyleDocument();
  doc = setIntervalStyleOverride(doc, tg, 0, 0, { swatchId: 's7' }); // ''
  doc = setIntervalStyleOverride(doc, tg, 0, 1, { swatchId: 's1' }); // '你好'
  doc = setIntervalStyleOverride(doc, tg, 0, 2, { swatchId: 's2' }); // '北京'
  doc = setBoundaryStyleOverride(doc, tg, 0, 0.5, { swatchId: 's4' }); // interior boundary
  doc = setBoundaryStyleOverride(doc, tg, 0, 1.5, { swatchId: 's3' }); // outer boundary

  // Merge [0..1] without explicit primary -> prefers non-empty interval 1 ('s1') over empty 0 ('s7')
  const merged = propagateStylesOnMerge(
    doc,
    0,
    '词',
    0,
    1,
    { xmin: 0, xmax: 1.5, text: '你好' }
  );
  const ov0 = merged.intervalOverrides.find((o) => o.itemIndex === 0);
  const ov1 = merged.intervalOverrides.find((o) => o.itemIndex === 1);
  assert.equal(ov0?.style.swatchId, 's1');
  assert.equal(ov0?.xmin, 0);
  assert.equal(ov0?.xmax, 1.5);
  assert.equal(ov1?.style.swatchId, 's2'); // shifted from 2 -> 1
  // Interior boundary at 0.5 removed, outer boundary at 1.5 preserved
  assert.equal(merged.boundaryOverrides.length, 1);
  assert.equal(merged.boundaryOverrides[0].time, 1.5);

  // Merge [1..2] with explicit primaryIndex = 2 -> chooses 's2'
  const mergedPrimary = propagateStylesOnMerge(
    doc,
    0,
    '词',
    1,
    2,
    { xmin: 0.5, xmax: 2.5, text: '你好北京' },
    2
  );
  const chosen = mergedPrimary.intervalOverrides.find((o) => o.itemIndex === 1);
  assert.equal(chosen?.style.swatchId, 's2');
});

test('propagateStylesOnBoundaryMove updates single tier vs linked tiers and shared boundaries', () => {
  const tg = makeSampleTextGrid();
  let doc = createDefaultStyleDocument();
  doc = setIntervalStyleOverride(doc, tg, 0, 1, { swatchId: 's1' }); // 0.5-1.5
  doc = setIntervalStyleOverride(doc, tg, 0, 2, { swatchId: 's2' }); // 1.5-2.5
  doc = setIntervalStyleOverride(doc, tg, 1, 3, { swatchId: 's3' }); // 1.2-1.5
  doc = setBoundaryStyleOverride(doc, tg, 0, 1.5, { swatchId: 's4' });
  doc = setBoundaryStyleOverride(doc, tg, null, 1.5, { swatchId: 's5' });

  // Unlinked move on tier 0: only tier 0 moves from 1.5 -> 1.65
  const unlinked = propagateStylesOnBoundaryMove(doc, 0, '词', 1.5, 1.65, false);
  assert.equal(unlinked.intervalOverrides.find((o) => o.tierIndex === 0 && o.itemIndex === 1)?.xmax, 1.65);
  assert.equal(unlinked.intervalOverrides.find((o) => o.tierIndex === 0 && o.itemIndex === 2)?.xmin, 1.65);
  assert.equal(unlinked.intervalOverrides.find((o) => o.tierIndex === 1 && o.itemIndex === 3)?.xmax, 1.5);
  assert.equal(unlinked.boundaryOverrides.find((o) => o.tierIndex === 0)?.time, 1.65);
  assert.equal(unlinked.boundaryOverrides.find((o) => o.tierIndex === null)?.time, 1.5);

  // Linked move: all aligned tiers & shared boundary follow
  const linked = propagateStylesOnBoundaryMove(doc, 0, '词', 1.5, 1.65, true);
  assert.equal(linked.intervalOverrides.find((o) => o.tierIndex === 1 && o.itemIndex === 3)?.xmax, 1.65);
  assert.equal(linked.boundaryOverrides.find((o) => o.tierIndex === null)?.time, 1.65);
});

test('propagateStylesOnTierChange remaps reordered tiers and #index tierStyles', () => {
  const prevTg = makeSampleTextGrid();
  let doc = createDefaultStyleDocument();
  doc = setTierStylePatch(doc, '#0', { labelBg: '#EEE8D5' });
  doc = setIntervalStyleOverride(doc, prevTg, 0, 1, { swatchId: 's1' });

  // Swap tier 0 ('词') and tier 1 ('音素')
  const nextTg = {
    ...prevTg,
    tiers: [prevTg.tiers[1], prevTg.tiers[0], prevTg.tiers[2]]
  };

  const synced = propagateStylesOnTierChange(doc, prevTg, nextTg);
  assert.equal(synced.tierStyles['#1']?.labelBg, '#EEE8D5');
  assert.equal(synced.tierStyles['#0'], undefined);
  assert.equal(synced.intervalOverrides[0].tierIndex, 1);
  assert.equal(synced.intervalOverrides[0].tierName, '词');
});

// ============================================================================
// 4. Three-tier reconciliation after external Praat edits
// ============================================================================

test('reconcileStyleDocument handles exact hits, fuzzy recovery and orphaned preservation', () => {
  const tg = makeSampleTextGrid();
  let doc = createDefaultStyleDocument();
  doc = setIntervalStyleOverride(doc, tg, 0, 1, { swatchId: 's1' }); // '你好' 0.5-1.5
  doc = setIntervalStyleOverride(doc, tg, 0, 2, { swatchId: 's2' }); // '北京' 1.5-2.5
  doc = setIntervalStyleOverride(doc, tg, 1, 2, { swatchId: 's3' }); // 'a' 0.8-1.2
  doc = setBoundaryStyleOverride(doc, tg, 0, 1.5, { swatchId: 's4' });
  doc = setPointStyleOverride(doc, tg, 2, 0, { swatchId: 's5', shape: 'diamond' }); // H* @ 0.95

  // Simulate external Praat edit:
  // - Tier 0: inserted an interval at start (index shifted), '你好' exact times 0.5-1.5,
  //   '北京' nudged slightly to 1.54-2.46 and edited to '北京市' (fuzzy match)
  // - Tier 1: 'a' deleted completely (becomes orphaned)
  // - Tier 2: H* nudged from 0.95 to 0.99 (fuzzy match)
  const editedTg = {
    name: 'sample.TextGrid',
    xmin: 0,
    xmax: 3.0,
    tiers: [
      {
        kind: 'intervalTier',
        name: '词',
        xmin: 0,
        xmax: 3.0,
        intervals: [
          { xmin: 0, xmax: 0.2, text: '' },
          { xmin: 0.2, xmax: 0.5, text: '嗯' },
          { xmin: 0.5, xmax: 1.5, text: '你好' },
          { xmin: 1.54, xmax: 2.46, text: '北京市' },
          { xmin: 2.46, xmax: 3.0, text: '' }
        ],
        points: []
      },
      {
        kind: 'intervalTier',
        name: '音素',
        xmin: 0,
        xmax: 3.0,
        intervals: [
          { xmin: 0, xmax: 0.5, text: '' },
          { xmin: 0.5, xmax: 3.0, text: '其他' }
        ],
        points: []
      },
      {
        kind: 'textTier',
        name: '声调标点',
        xmin: 0,
        xmax: 3.0,
        intervals: [],
        points: [
          { number: 0.99, mark: 'H*' },
          { number: 2.2, mark: 'L%' }
        ]
      }
    ]
  };

  const { doc: reconciled, report } = reconcileStyleDocument(doc, editedTg);
  assert.equal(report.details.intervals.exact, 1); // '你好' exact time hit at new itemIndex 2
  assert.equal(report.details.intervals.fuzzy, 1); // '北京' -> '北京市' fuzzy hit at itemIndex 3
  assert.equal(report.details.intervals.orphaned, 1); // 'a' orphaned
  assert.equal(report.details.boundaries.exact, 1); // boundary 1.5 still exists on tier 0
  assert.equal(report.details.points.fuzzy, 1); // H* 0.95 -> 0.99 fuzzy hit

  const nihao = reconciled.intervalOverrides.find((o) => o.style.swatchId === 's1');
  const beijing = reconciled.intervalOverrides.find((o) => o.style.swatchId === 's2');
  assert.equal(nihao?.itemIndex, 2);
  assert.equal(beijing?.itemIndex, 3);
  assert.equal(beijing?.textSnapshot, '北京市');
  assert.equal(reconciled.orphaned?.intervals.length, 1);
  assert.equal(reconciled.orphaned?.intervals[0].style.swatchId, 's3');

  // If external edit is reverted back to original TextGrid, orphaned style is recovered automatically
  const { doc: recovered, report: recoveryReport } = reconcileStyleDocument(reconciled, tg);
  assert.equal(recoveryReport.recoveredFromOrphaned, 1);
  assert.equal(recovered.orphaned, undefined);
  assert.equal(recovered.intervalOverrides.some((o) => o.style.swatchId === 's3'), true);
});

// ============================================================================
// 5. Sidecar codec & SVG <metadata> roundtrip
// ============================================================================

test('sidecar codec serializes, parses tolerantly, derives paths and tracks hasAnyCustomStyle', () => {
  assert.equal(getStyleSidecarPath('C:\\data\\rec01.TextGrid'), 'C:\\data\\rec01.tgstyle.json');
  assert.equal(getStyleSidecarPath('/tmp/audio/foo.Collection'), '/tmp/audio/foo.tgstyle.json');
  assert.equal(getStyleSidecarPath('barename'), 'barename.tgstyle.json');

  const emptyDoc = createDefaultStyleDocument();
  assert.equal(hasAnyCustomStyle(emptyDoc), false);

  const tg = makeSampleTextGrid();
  let customDoc = cloneStyleDocument(emptyDoc);
  customDoc.paletteId = 'colorblind-safe';
  customDoc.swatchLabels = { s1: '元音' };
  customDoc = setIntervalStyleOverride(customDoc, tg, 0, 1, {
    swatchId: 's1',
    fillOpacity: 0.85,
    fontWeight: 'bold'
  });
  assert.equal(hasAnyCustomStyle(customDoc), true);

  const json = serializeStyleSidecar(customDoc);
  const parsed = parseStyleSidecar(json);
  assert.ok(parsed);
  assert.equal(parsed.schemaVersion, STYLE_SCHEMA_VERSION);
  assert.equal(parsed.paletteId, 'colorblind-safe');
  assert.equal(parsed.swatchLabels.s1, '元音');
  assert.equal(parsed.intervalOverrides.length, 1);
  assert.equal(parsed.intervalOverrides[0].style.fillOpacity, 0.85);

  // Tolerant parsing sanitizes bad fields & rejects malformed JSON
  assert.equal(parseStyleSidecar('{broken json'), null);
  assert.equal(parseStyleSidecar('[]'), null);
  const sanitized = parseStyleSidecar(
    JSON.stringify({
      paletteId: 'nonexistent-palette',
      intervalOverrides: [
        {
          id: 'ok',
          tierIndex: 0,
          tierName: '词',
          itemIndex: 1,
          xmin: 0,
          xmax: 1,
          textSnapshot: 'x',
          style: { fillOpacity: 9.9, pattern: 'invalid-pattern', borderWidth: 2 }
        },
        { id: 'bad-missing-coords' }
      ]
    })
  );
  assert.ok(sanitized);
  assert.equal(sanitized.paletteId, 'warm-academic');
  assert.equal(sanitized.intervalOverrides.length, 1);
  assert.equal(sanitized.intervalOverrides[0].style.fillOpacity, 1);
  assert.equal(sanitized.intervalOverrides[0].style.pattern, undefined);
  assert.equal(sanitized.intervalOverrides[0].style.borderWidth, 2);
});

test('SVG <metadata> roundtrips TextGrid + StyleDocument with XML special chars and IPA safely', () => {
  const tg = makeSampleTextGrid();
  tg.tiers[0].intervals[1].text = 'tʰiŋ˥ <a&b> "quote" ]]> ŋ';
  let styleDoc = createDefaultStyleDocument('presentation');
  styleDoc.bwPrintMode = true;
  styleDoc.swatchLabels = { s2: '送气清塞音 <C>' };
  styleDoc = setIntervalStyleOverride(styleDoc, tg, 0, 1, {
    swatchId: 's2',
    pattern: 'crosshatch',
    fontWeight: 'bold'
  });

  const metaXml = buildSvgProjectMetadataXml(tg, styleDoc, { filename: 'demo_<1>&2.TextGrid' });
  assert.ok(metaXml.includes(TGRID_SVG_METADATA_NS));
  assert.ok(metaXml.startsWith('<metadata><tgrid:project '));
  assert.ok(metaXml.endsWith('</tgrid:project></metadata>'));
  // Ensure raw '<a&b>' was XML-escaped inside the payload
  assert.equal(metaXml.includes('<a&b>'), false);

  const fullSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400">${metaXml}<rect width="800" height="400" fill="#fff"/></svg>`;
  const extracted = extractProjectFromSvgText(fullSvg);
  assert.ok(extracted);
  assert.equal(extracted.filename, 'demo_<1>&2.TextGrid');
  assert.equal(extracted.tg.tiers[0].intervals[1].text, 'tʰiŋ˥ <a&b> "quote" ]]> ŋ');
  assert.equal(extracted.styleDoc.paletteId, 'presentation');
  assert.equal(extracted.styleDoc.bwPrintMode, true);
  assert.equal(extracted.styleDoc.swatchLabels.s2, '送气清塞音 <C>');
  assert.equal(extracted.styleDoc.intervalOverrides[0].style.pattern, 'crosshatch');

  // Plain SVG without TGrid metadata returns null safely
  const plainSvg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  assert.equal(extractProjectFromSvgText(plainSvg), null);

  // SVG with unrelated metadata returns null safely
  const foreignMetaSvg =
    '<svg xmlns="http://www.w3.org/2000/svg"><metadata><rdf:RDF xmlns:rdf="http://example.com">hi</rdf:RDF></metadata></svg>';
  assert.equal(extractProjectFromSvgText(foreignMetaSvg), null);

  // Corrupted TGrid metadata returns null safely
  const brokenMetaSvg = `<svg><metadata><tgrid:project xmlns:tgrid="${TGRID_SVG_METADATA_NS}">{not valid json</tgrid:project></metadata></svg>`;
  assert.equal(extractProjectFromSvgText(brokenMetaSvg), null);
});
