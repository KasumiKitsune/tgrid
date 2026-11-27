import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBlockTransformToDraft,
  clampBlockTargetSpan,
  computeBlockSafeBounds,
  findAlignedBlock,
  remapInteriorBoundaries,
  resolveBlockForBoundaryDrag
} from '../src/utils/blockTransform.ts';
import {
  commitToTimeline,
  createHistoryTimeline,
  getCurrentSnapshot,
  produceTgMutation,
  setTimelineCursor
} from '../src/store/historyModel.ts';

/**
 * Build the exact 3-tier scenario from the user screenshot:
 * - Tier 0 (词):    [0, 4.75] "" | [4.75, 6.10] "听得清" | [6.10, 6.58] ""
 * - Tier 1 (音标):  [0, 4.75] "" | [4.75, 6.10] "tʰiŋ˥ tə tɕʰiŋ˥" | [6.10, 6.58] ""
 * - Tier 2 (音节):  [0, 4.75] "" | [4.75, 5.25] "tʰiŋ˥" | [5.25, 5.55] "tə" | [5.55, 6.10] "tɕʰiŋ˥" | [6.10, 6.58] ""
 */
function makeScreenshotTg() {
  return {
    name: 'tingdeqing.TextGrid',
    xmin: 0,
    xmax: 6.58,
    tiers: [
      {
        kind: 'intervalTier',
        name: '词',
        xmin: 0,
        xmax: 6.58,
        intervals: [
          { xmin: 0, xmax: 4.75, text: '' },
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
    assert.ok(tier.intervals[i].xmax > tier.intervals[i].xmin, `tier ${tier.name} iv ${i} positive dur`);
    if (i > 0) {
      assert.equal(tier.intervals[i].xmin, tier.intervals[i - 1].xmax);
    }
  }
}

test('3-tier nested block translation shifts all aligned tiers and interior sub-boundaries rigidly', () => {
  const tg = makeScreenshotTg();
  const block = findAlignedBlock(tg, { xmin: 4.75, xmax: 6.1, tierIndex: 0, itemIndex: 1 });
  assert.ok(block);
  assert.deepEqual(block.tierIndices, [0, 1, 2]);
  assert.deepEqual(block.intervalSlices[2].interiorTimes, [5.25, 5.55]);

  const safe = computeBlockSafeBounds(tg, block);
  assert.equal(safe.minXmin, 0);
  assert.equal(safe.maxXmax, 6.58);

  const clamped = clampBlockTargetSpan(block, safe, 4.95, 6.3, 'move');
  assert.equal(clamped.changed, true);
  assert.equal(clamped.targetXmin, 4.95);
  assert.equal(clamped.targetXmax, 6.3);

  const produced = produceTgMutation(tg, (_draft, ctx) => {
    const res = applyBlockTransformToDraft(ctx.editTier, block, clamped.targetXmin, clamped.targetXmax);
    assert.equal(res.changed, true);
    assert.equal(res.affectedTierCount, 3);
    assert.equal(res.nextAnchorItemIndex, 1);
  });

  assert.equal(produced.changed, true);
  const next = produced.nextTg;
  for (const tier of next.tiers) assertContiguousTier(tier);

  assert.equal(next.tiers[0].intervals[1].xmin, 4.95);
  assert.equal(next.tiers[0].intervals[1].xmax, 6.3);
  assert.equal(next.tiers[1].intervals[1].xmin, 4.95);
  assert.equal(next.tiers[1].intervals[1].xmax, 6.3);
  assert.deepEqual(
    next.tiers[2].intervals.slice(1, 4).map((iv) => [iv.xmin, iv.xmax, iv.text]),
    [
      [4.95, 5.45, 'tʰiŋ˥'],
      [5.45, 5.75, 'tə'],
      [5.75, 6.3, 'tɕʰiŋ˥']
    ]
  );
});

test('elastic left-edge resize smoothly crosses original interior sub-boundary (5.25s -> 5.48s) without deadlock', () => {
  const tg = makeScreenshotTg();
  // Even when dragging 4.75s from Tier 2 (fine tier), resolver picks the enclosing 3-tier block [4.75, 6.10]
  const resolved = resolveBlockForBoundaryDrag(tg, 2, 4.75, null, []);
  assert.ok(resolved);
  assert.equal(resolved.side, 'left');
  assert.equal(resolved.block.xmin, 4.75);
  assert.equal(resolved.block.xmax, 6.1);

  const safe = computeBlockSafeBounds(tg, resolved.block);
  // Drag left edge 4.75 -> 5.48 (well past original interior boundary 5.25!), keeping right edge fixed at 6.10
  const clamped = clampBlockTargetSpan(resolved.block, safe, 5.48, 6.1, 'resize');
  assert.equal(clamped.changed, true);
  assert.equal(clamped.clampedLeft, false);
  assert.equal(clamped.clampedRight, false);
  assert.equal(clamped.targetXmin, 5.48);
  assert.equal(clamped.targetXmax, 6.1);

  const produced = produceTgMutation(tg, (_draft, ctx) => {
    applyBlockTransformToDraft(ctx.editTier, resolved.block, clamped.targetXmin, clamped.targetXmax);
  });

  const t2 = produced.nextTg.tiers[2];
  assertContiguousTier(t2);
  // Original ratios inside [4.75, 6.10] (dur=1.35):
  // 5.25 => (0.50/1.35) of [5.48, 6.10] (dur=0.62) => 5.48 + 0.229630 = 5.709630
  // 5.55 => (0.80/1.35) of [5.48, 6.10] (dur=0.62) => 5.48 + 0.367407 = 5.847407
  assert.equal(t2.intervals[1].xmin, 5.48);
  assert.ok(Math.abs(t2.intervals[1].xmax - 5.70963) < 1e-5);
  assert.ok(Math.abs(t2.intervals[2].xmax - 5.847407) < 1e-5);
  assert.equal(t2.intervals[3].xmax, 6.1);
  assert.ok(t2.intervals[1].xmax < t2.intervals[2].xmax);
  assert.ok(t2.intervals[2].xmax < t2.intervals[3].xmax);
});

test('remap to [5.48, 6.32] simultaneously translates and scales all 3 tiers cleanly', () => {
  const tg = makeScreenshotTg();
  const block = findAlignedBlock(tg, { xmin: 4.75, xmax: 6.1, tierIndex: 0, itemIndex: 1 });
  assert.ok(block);
  const safe = computeBlockSafeBounds(tg, block);
  const clamped = clampBlockTargetSpan(block, safe, 5.48, 6.32, 'remap');
  assert.equal(clamped.targetXmin, 5.48);
  assert.equal(clamped.targetXmax, 6.32);

  const produced = produceTgMutation(tg, (_draft, ctx) => {
    applyBlockTransformToDraft(ctx.editTier, block, clamped.targetXmin, clamped.targetXmax);
  });

  const next = produced.nextTg;
  for (const tier of next.tiers) assertContiguousTier(tier);
  assert.equal(next.tiers[0].intervals[1].xmin, 5.48);
  assert.equal(next.tiers[0].intervals[1].xmax, 6.32);
  assert.equal(next.tiers[1].intervals[1].xmin, 5.48);
  assert.equal(next.tiers[1].intervals[1].xmax, 6.32);
  // Original ratios (0.50/1.35, 0.80/1.35) mapped to dur=0.84:
  // 5.48 + 0.311111 = 5.791111; 5.48 + 0.497778 = 5.977778
  assert.ok(Math.abs(next.tiers[2].intervals[1].xmax - 5.791111) < 1e-5);
  assert.ok(Math.abs(next.tiers[2].intervals[2].xmax - 5.977778) < 1e-5);
  assert.equal(next.tiers[2].intervals[3].xmax, 6.32);
});

test('strictly excludes hidden tiers and wider parent tiers crossing the anchor span', () => {
  const tg = makeScreenshotTg();
  // Add a wider parent sentence tier (index 3) and a hidden aligned tier (index 4)
  tg.tiers.push(
    {
      kind: 'intervalTier',
      name: '整句',
      xmin: 0,
      xmax: 6.58,
      intervals: [
        { xmin: 0, xmax: 1.0, text: '' },
        { xmin: 1.0, xmax: 6.5, text: '你听得清吗' },
        { xmin: 6.5, xmax: 6.58, text: '' }
      ],
      points: []
    },
    {
      kind: 'intervalTier',
      name: '隐藏备注',
      xmin: 0,
      xmax: 6.58,
      intervals: [
        { xmin: 0, xmax: 4.75, text: '' },
        { xmin: 4.75, xmax: 6.1, text: 'secret' },
        { xmin: 6.1, xmax: 6.58, text: '' }
      ],
      points: []
    }
  );

  const block = findAlignedBlock(tg, { xmin: 4.75, xmax: 6.1, tierIndex: 0, itemIndex: 1 }, [4]);
  assert.ok(block);
  assert.deepEqual(block.tierIndices, [0, 1, 2]);

  const produced = produceTgMutation(tg, (_draft, ctx) => {
    applyBlockTransformToDraft(ctx.editTier, block, 5.48, 6.32);
  });

  // Wider parent tier (3) and hidden tier (4) must remain completely untouched
  assert.equal(produced.nextTg.tiers[3].intervals[1].xmin, 1.0);
  assert.equal(produced.nextTg.tiers[3].intervals[1].xmax, 6.5);
  assert.equal(produced.nextTg.tiers[4].intervals[1].xmin, 4.75);
  assert.equal(produced.nextTg.tiers[4].intervals[1].xmax, 6.1);
});

test('hard-clamps against adjacent non-empty neighbors and fills newly opened gap when moving away', () => {
  const tg = makeScreenshotTg();
  // Make Tier 1 have a non-empty left neighbor touching 4.75s, and Tier 2 have a non-empty right neighbor at 6.30s
  tg.tiers[1].intervals = [
    { xmin: 0, xmax: 3.5, text: '' },
    { xmin: 3.5, xmax: 4.75, text: '前词' },
    { xmin: 4.75, xmax: 6.1, text: 'tʰiŋ˥ tə tɕʰiŋ˥' },
    { xmin: 6.1, xmax: 6.58, text: '' }
  ];
  tg.tiers[2].intervals = [
    { xmin: 0, xmax: 4.75, text: '' },
    { xmin: 4.75, xmax: 5.25, text: 'tʰiŋ˥' },
    { xmin: 5.25, xmax: 5.55, text: 'tə' },
    { xmin: 5.55, xmax: 6.1, text: 'tɕʰiŋ˥' },
    { xmin: 6.1, xmax: 6.3, text: '' },
    { xmin: 6.3, xmax: 6.58, text: '后音' }
  ];

  const block = findAlignedBlock(tg, { xmin: 4.75, xmax: 6.1, tierIndex: 0, itemIndex: 1 });
  assert.ok(block);
  const safe = computeBlockSafeBounds(tg, block);

  // Left blocked hard at 4.75 by Tier 1's non-empty "前词"; right allowed up to 6.30 (empty gap on Tier 2)
  assert.equal(safe.minXmin, 4.75);
  assert.equal(safe.leftBlockerTierIndex, 1);
  assert.equal(safe.leftBlockerIsNonEmpty, true);
  assert.equal(safe.maxXmax, 6.3);
  assert.equal(safe.rightBlockerTierIndex, 2);

  // Attempting to push left past 4.75 and right past 6.30 must clamp to [4.75, 6.30]
  const clampedBoth = clampBlockTargetSpan(block, safe, 4.2, 6.5, 'remap');
  assert.equal(clampedBoth.clampedLeft, true);
  assert.equal(clampedBoth.clampedRight, true);
  assert.equal(clampedBoth.targetXmin, 4.75);
  assert.equal(clampedBoth.targetXmax, 6.3);

  // Moving RIGHT away from Tier 1's non-empty "前词" ([4.75, 6.10] -> [5.20, 6.30]):
  // - Tier 1 must NOT stretch "前词"; it must insert a new empty interval [4.75, 5.20]
  // - Tier 2 must consume its empty right neighbor [6.10, 6.30] cleanly (dropNext) without touching "后音"
  const produced = produceTgMutation(tg, (_draft, ctx) => {
    applyBlockTransformToDraft(ctx.editTier, block, 5.2, 6.3);
  });

  const next = produced.nextTg;
  for (const tier of next.tiers) assertContiguousTier(tier);

  // Tier 1: [0,3.5]"" | [3.5,4.75]"前词" | [4.75,5.20]"" | [5.20,6.30]"tʰiŋ˥ tə tɕʰiŋ˥" | [6.30,6.58]""
  assert.deepEqual(
    next.tiers[1].intervals.map((iv) => [iv.xmin, iv.xmax, iv.text]),
    [
      [0, 3.5, ''],
      [3.5, 4.75, '前词'],
      [4.75, 5.2, ''],
      [5.2, 6.3, 'tʰiŋ˥ tə tɕʰiŋ˥'],
      [6.3, 6.58, '']
    ]
  );

  // Tier 2: empty [6.10, 6.30] dropped cleanly, "后音" stays untouched at [6.30, 6.58]
  const lastT2 = next.tiers[2].intervals[next.tiers[2].intervals.length - 1];
  assert.deepEqual(lastT2, { xmin: 6.3, xmax: 6.58, text: '后音' });
  assert.equal(next.tiers[2].intervals.length, 5);
});

test('consumes both left and right empty neighbors cleanly when flushed to full domain', () => {
  const tg = makeScreenshotTg();
  const block = findAlignedBlock(tg, { xmin: 4.75, xmax: 6.1, tierIndex: 0, itemIndex: 1 });
  assert.ok(block);

  const produced = produceTgMutation(tg, (_draft, ctx) => {
    const res = applyBlockTransformToDraft(ctx.editTier, block, 0, 6.58);
    assert.equal(res.nextAnchorItemIndex, 0);
  });

  const next = produced.nextTg;
  for (const tier of next.tiers) assertContiguousTier(tier);
  assert.equal(next.tiers[0].intervals.length, 1);
  assert.deepEqual(next.tiers[0].intervals[0], { xmin: 0, xmax: 6.58, text: '听得清' });
  assert.equal(next.tiers[2].intervals.length, 3);
  assert.equal(next.tiers[2].intervals[0].xmin, 0);
  assert.equal(next.tiers[2].intervals[2].xmax, 6.58);
});

test('transforms visible TextTier points inside [a, b] proportionally without moving outside points', () => {
  const tg = makeScreenshotTg();
  tg.tiers.push({
    kind: 'textTier',
    name: '调峰',
    xmin: 0,
    xmax: 6.58,
    intervals: [],
    points: [
      { number: 2.0, mark: '外左' },
      { number: 4.75, mark: '起点' },
      { number: 5.425, mark: '中点' },
      { number: 6.1, mark: '终点' },
      { number: 6.5, mark: '外右' }
    ]
  });

  const block = findAlignedBlock(tg, { xmin: 4.75, xmax: 6.1, tierIndex: 0, itemIndex: 1 });
  assert.ok(block);
  assert.equal(block.pointSlices.length, 1);
  assert.deepEqual(block.pointSlices[0].pointIndices, [1, 2, 3]);

  const produced = produceTgMutation(tg, (_draft, ctx) => {
    applyBlockTransformToDraft(ctx.editTier, block, 5.48, 6.32);
  });

  const pts = produced.nextTg.tiers[3].points;
  assert.deepEqual(pts, [
    { number: 2.0, mark: '外左' },
    { number: 5.48, mark: '起点' },
    { number: 5.9, mark: '中点' },
    { number: 6.32, mark: '终点' },
    { number: 6.5, mark: '外右' }
  ]);
});

test('enforces minimum sub-interval spacing under extreme compression', () => {
  const mapped = remapInteriorBoundaries(4.75, 6.1, [5.25, 5.55], 5.5, 5.503, 0.001);
  assert.equal(mapped.length, 2);
  assert.ok(mapped[0] > 5.5);
  assert.ok(mapped[1] > mapped[0]);
  assert.ok(5.503 > mapped[1]);
});

test('commits as a single atomic historyModel entry and restores all tiers on one undo/redo', () => {
  const initialTg = makeScreenshotTg();
  let timeline = createHistoryTimeline('open', initialTg.name, {
    tg: initialTg,
    selection: { kind: 'interval', tierIndex: 0, itemIndex: 1, bandIndex: 0 },
    hiddenTierIndices: [],
    playRange: { start: 5.48, end: 6.32 }
  });

  const block = findAlignedBlock(initialTg, { xmin: 4.75, xmax: 6.1, tierIndex: 0, itemIndex: 1 });
  assert.ok(block);

  const produced = produceTgMutation(initialTg, (_draft, ctx) => {
    const res = applyBlockTransformToDraft(ctx.editTier, block, 5.48, 6.32);
    ctx.setNextSelection({
      kind: 'interval',
      tierIndex: block.anchorTierIndex,
      itemIndex: res.nextAnchorItemIndex,
      bandIndex: 0
    });
    ctx.setNextPlayRange({ start: res.finalXmin, end: res.finalXmax });
  });

  timeline = commitToTimeline(
    timeline,
    {
      type: 'remap-block',
      title: '跨层重映射时间块',
      detail: '3 层 · 4.750–6.100s → 5.480–6.320s',
      icon: 'nudgeShared',
      focusTime: 5.48
    },
    {
      tg: produced.nextTg,
      selection: produced.nextSelection ?? null,
      hiddenTierIndices: [],
      playRange: produced.nextPlayRange ?? null
    }
  );

  assert.equal(timeline.entries.length, 1);
  assert.equal(getCurrentSnapshot(timeline).tg.tiers[2].intervals[1].xmin, 5.48);

  // Single undo restores all 3 tiers identically to baseline
  timeline = setTimelineCursor(timeline, -1);
  assert.deepEqual(getCurrentSnapshot(timeline).tg, initialTg);

  // Single redo re-applies all 3 tiers
  timeline = setTimelineCursor(timeline, 0);
  assert.equal(getCurrentSnapshot(timeline).tg.tiers[0].intervals[1].xmin, 5.48);
  assert.equal(getCurrentSnapshot(timeline).tg.tiers[0].intervals[1].xmax, 6.32);
  assert.equal(getCurrentSnapshot(timeline).tg.tiers[2].intervals[3].xmax, 6.32);
});

test('elastic pull-inward from tier.xmax (6.58s) and tier.xmin (0.0s) generates trailing/leading empty intervals cleanly', () => {
  // Right-flush 3-tier block touching tier.xmax = 6.58s (exact user screenshot scenario)
  const tgRight = {
    name: 'flush-right.TextGrid',
    xmin: 0,
    xmax: 6.58,
    tiers: [
      {
        kind: 'intervalTier',
        name: '词',
        xmin: 0,
        xmax: 6.58,
        intervals: [
          { xmin: 0, xmax: 5.23, text: '' },
          { xmin: 5.23, xmax: 6.58, text: '听得清' }
        ],
        points: []
      },
      {
        kind: 'intervalTier',
        name: '音标',
        xmin: 0,
        xmax: 6.58,
        intervals: [
          { xmin: 0, xmax: 5.23, text: '' },
          { xmin: 5.23, xmax: 6.58, text: 'tʰiŋ˥ tə tɕʰiŋ˥' }
        ],
        points: []
      },
      {
        kind: 'intervalTier',
        name: '音节',
        xmin: 0,
        xmax: 6.58,
        intervals: [
          { xmin: 0, xmax: 5.23, text: '' },
          { xmin: 5.23, xmax: 5.73, text: 'tʰiŋ˥' },
          { xmin: 5.73, xmax: 6.03, text: 'tə' },
          { xmin: 6.03, xmax: 6.58, text: 'tɕʰiŋ˥' }
        ],
        points: []
      }
    ]
  };

  const resolvedRight = resolveBlockForBoundaryDrag(tgRight, 0, 6.58, null, []);
  assert.ok(resolvedRight);
  assert.equal(resolvedRight.side, 'right');
  const safeRight = computeBlockSafeBounds(tgRight, resolvedRight.block);
  assert.equal(safeRight.maxXmax, 6.58);

  // Pull right boundary 6.58 -> 6.32 inward: all 3 tiers shrink and insert [6.32, 6.58] "" tail
  const clampedRight = clampBlockTargetSpan(resolvedRight.block, safeRight, 5.23, 6.32, 'resize');
  assert.equal(clampedRight.targetXmax, 6.32);

  const producedRight = produceTgMutation(tgRight, (_draft, ctx) => {
    applyBlockTransformToDraft(
      ctx.editTier,
      resolvedRight.block,
      clampedRight.targetXmin,
      clampedRight.targetXmax
    );
  });
  for (const tier of producedRight.nextTg.tiers) {
    assertContiguousTier(tier);
    const tail = tier.intervals[tier.intervals.length - 1];
    assert.deepEqual(tail, { xmin: 6.32, xmax: 6.58, text: '' });
  }

  // Left-flush 2-tier block touching tier.xmin = 0.0s
  const tgLeft = {
    name: 'flush-left.TextGrid',
    xmin: 0,
    xmax: 2.0,
    tiers: [
      {
        kind: 'intervalTier',
        name: '词',
        xmin: 0,
        xmax: 2.0,
        intervals: [
          { xmin: 0, xmax: 1.0, text: '开头' },
          { xmin: 1.0, xmax: 2.0, text: '' }
        ],
        points: []
      },
      {
        kind: 'intervalTier',
        name: '音节',
        xmin: 0,
        xmax: 2.0,
        intervals: [
          { xmin: 0, xmax: 0.4, text: 'kʰai' },
          { xmin: 0.4, xmax: 1.0, text: 'tʰou' },
          { xmin: 1.0, xmax: 2.0, text: '' }
        ],
        points: []
      }
    ]
  };

  const resolvedLeft = resolveBlockForBoundaryDrag(tgLeft, 1, 0, null, []);
  assert.ok(resolvedLeft);
  assert.equal(resolvedLeft.side, 'left');
  const producedLeft = produceTgMutation(tgLeft, (_draft, ctx) => {
    const res = applyBlockTransformToDraft(ctx.editTier, resolvedLeft.block, 0.2, 1.0);
    assert.equal(res.nextAnchorItemIndex, 1);
  });
  for (const tier of producedLeft.nextTg.tiers) {
    assertContiguousTier(tier);
    assert.deepEqual(tier.intervals[0], { xmin: 0, xmax: 0.2, text: '' });
  }
  assert.equal(producedLeft.nextTg.tiers[1].intervals[1].xmin, 0.2);
  assert.equal(producedLeft.nextTg.tiers[1].intervals[1].xmax, 0.52);
});
