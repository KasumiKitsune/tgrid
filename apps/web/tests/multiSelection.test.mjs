import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeMultiSelection,
  applyAlignMultiSelectionBounds,
  applyClearMultiSelectionText,
  applyMergeContiguousSelection,
  applyMultiSyncDelta,
  computeMultiSyncDeltaBounds,
  resolveMultiBoundaryAction
} from '../src/utils/multiSelection.ts';
import {
  commitToTimeline,
  createHistoryTimeline,
  getCurrentSnapshot,
  produceTgMutation,
  setTimelineCursor
} from '../src/store/historyModel.ts';

function makeMultiTierTg() {
  return {
    name: 'multi.TextGrid',
    xmin: 0,
    xmax: 6.58,
    tiers: [
      {
        kind: 'intervalTier',
        name: '词',
        xmin: 0,
        xmax: 6.58,
        intervals: [
          { xmin: 0, xmax: 1.0, text: '' },
          { xmin: 1.0, xmax: 2.0, text: '你好' },
          { xmin: 2.0, xmax: 4.75, text: '' },
          { xmin: 4.75, xmax: 6.1, text: '听得清' },
          { xmin: 6.1, xmax: 6.58, text: '' }
        ],
        points: []
      },
      {
        kind: 'intervalTier',
        name: '音标',
        xmin: 0,
        xmax: 6.58,
        intervals: [
          { xmin: 0, xmax: 4.75, text: '' },
          { xmin: 4.75, xmax: 6.1, text: 'tʰiŋ˥ tə tɕʰiŋ˥' },
          { xmin: 6.1, xmax: 6.58, text: '' }
        ],
        points: []
      },
      {
        kind: 'intervalTier',
        name: '音节',
        xmin: 0,
        xmax: 6.58,
        intervals: [
          { xmin: 0, xmax: 4.75, text: '' },
          { xmin: 4.75, xmax: 5.25, text: 'tʰiŋ˥' },
          { xmin: 5.25, xmax: 5.55, text: 'tə' },
          { xmin: 5.55, xmax: 6.1, text: 'tɕʰiŋ˥' },
          { xmin: 6.1, xmax: 6.58, text: '' }
        ],
        points: []
      }
    ]
  };
}

function assertContiguousTier(tier) {
  assert.ok(tier.intervals.length >= 1);
  assert.ok(Math.abs(tier.intervals[0].xmin - tier.xmin) <= 1e-9);
  assert.ok(Math.abs(tier.intervals[tier.intervals.length - 1].xmax - tier.xmax) <= 1e-9);
  for (let i = 0; i < tier.intervals.length; i++) {
    assert.ok(tier.intervals[i].xmax > tier.intervals[i].xmin);
    if (i > 0) {
      assert.equal(tier.intervals[i].xmin, tier.intervals[i - 1].xmax);
    }
  }
}

test('topology 1: single-tier contiguous supports merge, elastic resize, remap, and clear', () => {
  const tg = makeMultiTierTg();
  const items = [
    { tierIndex: 2, itemIndex: 1 },
    { tierIndex: 2, itemIndex: 2 }
  ];
  const analysis = analyzeMultiSelection(tg, items, items[1], { start: 4.9, end: 5.4 });
  assert.equal(analysis.topology, 'single-tier-contiguous');
  assert.equal(analysis.capabilities.canMerge, true);
  assert.equal(analysis.capabilities.canClearText, true);
  assert.equal(analysis.capabilities.canGroupMove, true);
  assert.equal(analysis.capabilities.canGroupResize, true);
  assert.equal(analysis.capabilities.canAlignBounds, false);
  assert.equal(analysis.capabilities.canRemapToPlayRange, true);

  // Merge selected 2 contiguous syllables into 1
  const merged = produceTgMutation(tg, (_draft, ctx) => {
    const res = applyMergeContiguousSelection(ctx.editTier, analysis);
    assert.equal(res.changed, true);
    assert.equal(res.mergedCount, 2);
    assert.equal(res.mergedItemIndex, 1);
  });
  const t2 = merged.nextTg.tiers[2];
  assertContiguousTier(t2);
  assert.equal(t2.intervals[1].xmin, 4.75);
  assert.equal(t2.intervals[1].xmax, 5.55);
  assert.equal(t2.intervals[1].text, 'tʰiŋ˥ tə');
  assert.equal(t2.intervals[2].text, 'tɕʰiŋ˥');

  // Elastic left-edge pull on selected 2-item run leaves 3rd syllable untouched!
  const resized = produceTgMutation(tg, (_draft, ctx) => {
    const res = applyMultiSyncDelta(ctx.editTier, tg, analysis.units, 'left-edge', 0.25);
    assert.equal(res.changed, true);
  });
  const t2r = resized.nextTg.tiers[2];
  assertContiguousTier(t2r);
  assert.equal(t2r.intervals[1].xmin, 5.0);
  assert.ok(t2r.intervals[1].xmax > 5.0 && t2r.intervals[1].xmax < 5.55);
  assert.equal(t2r.intervals[2].xmax, 5.55);
  assert.equal(t2r.intervals[3].xmin, 5.55);
  assert.equal(t2r.intervals[3].xmax, 6.1);
});

test('topology 2: explicit cross-tier aligned selection moves ONLY selected tiers (skipping unselected middle tier)', () => {
  const tg = makeMultiTierTg();
  // Select Tier 0 "听得清" + Tier 2's 3 syllables, intentionally skipping Tier 1!
  const items = [
    { tierIndex: 0, itemIndex: 3 },
    { tierIndex: 2, itemIndex: 1 },
    { tierIndex: 2, itemIndex: 2 },
    { tierIndex: 2, itemIndex: 3 }
  ];
  const analysis = analyzeMultiSelection(tg, items, items[0], { start: 5.48, end: 6.32 });
  assert.equal(analysis.topology, 'cross-tier-aligned');
  assert.equal(analysis.capabilities.canMerge, false);
  assert.equal(analysis.capabilities.canGroupMove, true);
  assert.equal(analysis.capabilities.canGroupResize, true);
  assert.equal(analysis.capabilities.canRemapToPlayRange, true);

  const produced = produceTgMutation(tg, (_draft, ctx) => {
    const res = applyAlignMultiSelectionBounds(
      ctx.editTier,
      tg,
      analysis,
      'to-range',
      { start: 5.48, end: 6.32 }
    );
    assert.equal(res.changed, true);
    assert.equal(res.affectedTierCount, 2);
  });

  const next = produced.nextTg;
  for (const t of next.tiers) assertContiguousTier(t);
  // Tier 0 and Tier 2 moved to [5.48, 6.32]
  assert.equal(next.tiers[0].intervals[3].xmin, 5.48);
  assert.equal(next.tiers[0].intervals[3].xmax, 6.32);
  assert.equal(next.tiers[2].intervals[1].xmin, 5.48);
  assert.equal(next.tiers[2].intervals[3].xmax, 6.32);
  // Tier 1 was NOT selected, so it stays untouched at [4.75, 6.10]
  assert.equal(next.tiers[1].intervals[1].xmin, 4.75);
  assert.equal(next.tiers[1].intervals[1].xmax, 6.1);
});

test('topology 3: cross-tier overlapping misaligned selection offers align to-primary & to-envelope', () => {
  const tg = makeMultiTierTg();
  // Misalign Tier 1 to [4.90, 6.25] so it overlaps Tier 0 [4.75, 6.10]
  tg.tiers[1].intervals = [
    { xmin: 0, xmax: 4.9, text: '' },
    { xmin: 4.9, xmax: 6.25, text: 'tʰiŋ˥ tə tɕʰiŋ˥' },
    { xmin: 6.25, xmax: 6.58, text: '' }
  ];
  const items = [
    { tierIndex: 0, itemIndex: 3 },
    { tierIndex: 1, itemIndex: 1 }
  ];
  const analysis = analyzeMultiSelection(tg, items, { tierIndex: 0, itemIndex: 3 });
  assert.equal(analysis.topology, 'cross-tier-overlapping');
  assert.equal(analysis.capabilities.canAlignBounds, true);
  assert.equal(analysis.capabilities.canMerge, false);

  // Align to primary ([4.75, 6.10])
  const toPrimary = produceTgMutation(tg, (_draft, ctx) => {
    const res = applyAlignMultiSelectionBounds(ctx.editTier, tg, analysis, 'to-primary');
    assert.equal(res.changed, true);
  });
  assert.equal(toPrimary.nextTg.tiers[0].intervals[3].xmin, 4.75);
  assert.equal(toPrimary.nextTg.tiers[0].intervals[3].xmax, 6.1);
  assert.equal(toPrimary.nextTg.tiers[1].intervals[1].xmin, 4.75);
  assert.equal(toPrimary.nextTg.tiers[1].intervals[1].xmax, 6.1);

  // Align to union envelope ([4.75, 6.25])
  const toEnvelope = produceTgMutation(tg, (_draft, ctx) => {
    const res = applyAlignMultiSelectionBounds(ctx.editTier, tg, analysis, 'to-envelope');
    assert.equal(res.changed, true);
  });
  assert.equal(toEnvelope.nextTg.tiers[0].intervals[3].xmin, 4.75);
  assert.equal(toEnvelope.nextTg.tiers[0].intervals[3].xmax, 6.25);
  assert.equal(toEnvelope.nextTg.tiers[1].intervals[1].xmin, 4.75);
  assert.equal(toEnvelope.nextTg.tiers[1].intervals[1].xmax, 6.25);
});

test('topology 4: disjoint intervals hide merge/align and support sync move, sync edge shift, and batch clear', () => {
  const tg = makeMultiTierTg();
  // Select two disjoint words on Tier 0: "你好" [1.0, 2.0] and "听得清" [4.75, 6.10]
  // separated by empty interval [2.0, 4.75]
  const items = [
    { tierIndex: 0, itemIndex: 1 },
    { tierIndex: 0, itemIndex: 3 }
  ];
  const analysis = analyzeMultiSelection(tg, items, items[1], { start: 1.5, end: 5.0 });
  assert.equal(analysis.topology, 'disjoint');
  assert.equal(analysis.capabilities.canMerge, false);
  assert.equal(analysis.capabilities.canAlignBounds, false);
  assert.equal(analysis.capabilities.canRemapToPlayRange, false);
  assert.equal(analysis.capabilities.canClearText, true);
  assert.equal(analysis.capabilities.canSyncMove, true);
  assert.equal(analysis.capabilities.canSyncEdgeResize, true);

  // Verify shared empty gap between the 2 disjoint units does NOT artificially cap move delta
  const moveBounds = computeMultiSyncDeltaBounds(tg, analysis.units, 'move');
  assert.equal(moveBounds.minDelta, -1.0); // limited by [0, 1.0] before "你好"
  assert.ok(Math.abs(moveBounds.maxDelta - 0.48) < 1e-6); // limited by [6.10, 6.58] after "听得清"

  // Synchronized move by +0.30s shifts BOTH words and keeps their intervening gap at 2.75s
  const moved = produceTgMutation(tg, (_draft, ctx) => {
    const res = applyMultiSyncDelta(ctx.editTier, tg, analysis.units, 'move', 0.3);
    assert.equal(res.changed, true);
    assert.equal(res.nextItems.length, 2);
  });
  const t0m = moved.nextTg.tiers[0];
  assertContiguousTier(t0m);
  assert.deepEqual(
    t0m.intervals.map((iv) => [iv.xmin, iv.xmax, iv.text]),
    [
      [0, 1.3, ''],
      [1.3, 2.3, '你好'],
      [2.3, 5.05, ''],
      [5.05, 6.4, '听得清'],
      [6.4, 6.58, '']
    ]
  );

  // Synchronized right-edge adjustment (+0.20s on BOTH words)
  const boundaryHit = resolveMultiBoundaryAction(analysis.units, 0, 2.0);
  assert.ok(boundaryHit);
  assert.equal(boundaryHit.side, 'right');

  const edgeMoved = produceTgMutation(tg, (_draft, ctx) => {
    const res = applyMultiSyncDelta(ctx.editTier, tg, analysis.units, 'right-edge', 0.2);
    assert.equal(res.changed, true);
  });
  const t0e = edgeMoved.nextTg.tiers[0];
  assertContiguousTier(t0e);
  assert.equal(t0e.intervals[1].xmax, 2.2);
  assert.equal(t0e.intervals[3].xmax, 6.3);

  // Batch clear text + atomic historyModel undo/redo
  let timeline = createHistoryTimeline('open', tg.name, {
    tg,
    selection: { kind: 'interval', tierIndex: 0, itemIndex: 3, bandIndex: 0 },
    hiddenTierIndices: [],
    playRange: null
  });

  const cleared = produceTgMutation(tg, (_draft, ctx) => {
    const res = applyClearMultiSelectionText(ctx.editTier, items);
    assert.equal(res.changed, true);
    assert.equal(res.clearedCount, 2);
  });
  timeline = commitToTimeline(
    timeline,
    {
      type: 'multi-clear-text',
      title: '批量清空文本',
      detail: '已清空 2 项',
      icon: 'clear'
    },
    {
      tg: cleared.nextTg,
      selection: null,
      hiddenTierIndices: [],
      playRange: null
    }
  );
  assert.equal(getCurrentSnapshot(timeline).tg.tiers[0].intervals[1].text, '');
  assert.equal(getCurrentSnapshot(timeline).tg.tiers[0].intervals[3].text, '');

  // Single undo restores both texts
  timeline = setTimelineCursor(timeline, -1);
  assert.equal(getCurrentSnapshot(timeline).tg.tiers[0].intervals[1].text, '你好');
  assert.equal(getCurrentSnapshot(timeline).tg.tiers[0].intervals[3].text, '听得清');
});
