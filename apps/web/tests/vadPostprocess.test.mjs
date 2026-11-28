import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VAD_PRESETS,
  applyVadPreset,
  createDefaultVadParams,
  detectVadPreset,
  extractRuleFeatureTrack,
  postprocessNeuralTrack,
  postprocessRuleTrack
} from '../src/audio/vadPostprocess.ts';
import {
  DEFAULT_VAD_LABEL_CONFIG,
  applyVadWritePlan,
  buildSeamlessScopeIntervals,
  countOverwrittenTextIntervals,
  getDefaultVadTarget,
  snapVadSegmentsZeroCrossing,
  suggestUniqueVadTierName
} from '../src/audio/vadWriter.ts';
import { scanTextGridQa } from '../src/utils/qaDiagnostics.ts';
import { formatVadHistoryDetail } from '../src/store/historyModel.ts';

function makePosteriorTrack(numFrames, filler) {
  const pVad = new Uint8Array(numFrames);
  const pObstruent = new Uint8Array(numFrames);
  const pStopCl = new Uint8Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const res = filler(f);
    pVad[f] = res.vad ?? 0;
    pObstruent[f] = res.obs ?? 0;
    pStopCl[f] = res.stop ?? 0;
  }
  return {
    hopMs: 10,
    originSec: 0,
    numFrames,
    pVad,
    pObstruent,
    pStopCl
  };
}

function assertSeamlessTier(tier, docMin, docMax) {
  assert.equal(tier.kind, 'intervalTier');
  assert.ok(Math.abs(tier.xmin - docMin) < 1e-9);
  assert.ok(Math.abs(tier.xmax - docMax) < 1e-9);
  assert.ok(tier.intervals.length > 0);
  assert.ok(Math.abs(tier.intervals[0].xmin - tier.xmin) < 1e-9);
  assert.ok(Math.abs(tier.intervals[tier.intervals.length - 1].xmax - tier.xmax) < 1e-9);
  for (let i = 0; i < tier.intervals.length; i++) {
    const iv = tier.intervals[i];
    assert.ok(iv.xmax - iv.xmin >= 0.005 - 1e-9, `interval #${i} too short: ${(iv.xmax - iv.xmin) * 1000}ms`);
    if (i > 0) {
      assert.equal(iv.xmin, tier.intervals[i - 1].xmax, `gap/overlap at interval #${i}`);
    }
  }
}

test('neural hysteresis expands through lowProbTh and obsProtectTh and bridges stop closure', () => {
  // 2.0s track (200 frames @ 10ms)
  // [20..25): soft voiceless fricative (obs=0.25, vad=0.08)
  // [25..50): core speech (vad=0.80)
  // [50..60): 100ms word-internal stop closure (vad=0.05, stop=0.60)
  // [60..85): post-stop speech (vad=0.75)
  // [85..92): low tail (vad=0.20)
  // [140..143): 30ms transient spike (should be dropped by minSpeechMs=60)
  const track = makePosteriorTrack(200, (f) => {
    if (f >= 20 && f < 25) return { vad: 20, obs: 64, stop: 0 };
    if (f >= 25 && f < 50) return { vad: 204, obs: 10, stop: 0 };
    if (f >= 50 && f < 60) return { vad: 12, obs: 0, stop: 153 };
    if (f >= 60 && f < 85) return { vad: 192, obs: 10, stop: 0 };
    if (f >= 85 && f < 92) return { vad: 52, obs: 0, stop: 0 };
    if (f >= 140 && f < 143) return { vad: 220, obs: 0, stop: 0 };
    return { vad: 5, obs: 0, stop: 0 };
  });

  const params = createDefaultVadParams('standard', 'neural');
  params.padMs = 0;
  params.mergeGapMs = 40; // smaller than 100ms stop closure, so stop bridge MUST do the bridging

  const segs = postprocessNeuralTrack(track, params, { audioDuration: 2.0, audioOffset: 0 });
  assert.equal(segs.length, 1);
  assert.ok(Math.abs(segs[0].start - 0.20) < 1e-6, `expected obs-protected start 0.20, got ${segs[0].start}`);
  assert.ok(Math.abs(segs[0].end - 0.92) < 1e-6, `expected low-tail end 0.92, got ${segs[0].end}`);

  // Disabling stop closure bridge splits the two syllables cleanly
  const noBridge = { ...params, maxStopGapMs: 0 };
  const splitSegs = postprocessNeuralTrack(track, noBridge, { audioDuration: 2.0, audioOffset: 0 });
  assert.equal(splitSegs.length, 2);
  assert.ok(Math.abs(splitSegs[0].end - 0.50) < 1e-6);
  assert.ok(Math.abs(splitSegs[1].start - 0.60) < 1e-6);
});

test('presets are strictly monotonic and round-trip detectVadPreset', () => {
  const tight = createDefaultVadParams('tight', 'neural');
  const std = createDefaultVadParams('standard', 'neural');
  const loose = createDefaultVadParams('loose', 'neural');

  assert.equal(detectVadPreset(tight), 'tight');
  assert.equal(detectVadPreset(std), 'standard');
  assert.equal(detectVadPreset(loose), 'loose');
  assert.equal(detectVadPreset({ ...std, minSpeechMs: 95 }), 'custom');
  assert.equal(detectVadPreset(applyVadPreset({ ...std, minSpeechMs: 95 }, 'loose')), 'loose');

  assert.ok(VAD_PRESETS.tight.highProbTh > VAD_PRESETS.standard.highProbTh);
  assert.ok(VAD_PRESETS.standard.highProbTh > VAD_PRESETS.loose.highProbTh);
  assert.ok(VAD_PRESETS.tight.obsProtectTh > VAD_PRESETS.standard.obsProtectTh);
  assert.ok(VAD_PRESETS.standard.obsProtectTh > VAD_PRESETS.loose.obsProtectTh);
});

test('padding resolves adjacent collisions cleanly at midpoint and honors audioOffset + partial scope', () => {
  // Two speech bursts at audio [0.20..0.40] and [0.50..0.70] (100ms gap)
  const track = makePosteriorTrack(120, (f) => {
    if ((f >= 20 && f < 40) || (f >= 50 && f < 70)) return { vad: 220 };
    return { vad: 0 };
  });

  const params = createDefaultVadParams('standard', 'neural');
  params.mergeGapMs = 50; // keep separate
  params.padMs = 80; // 80ms pad each side exceeds 100ms gap -> midpoint at 0.45 audio time

  const audioOffset = 10.0;
  const fullSegs = postprocessNeuralTrack(track, params, {
    audioDuration: 1.2,
    audioOffset
  });
  assert.equal(fullSegs.length, 2);
  assert.ok(Math.abs(fullSegs[0].start - 10.12) < 1e-6);
  assert.ok(Math.abs(fullSegs[0].end - 10.45) < 1e-6);
  assert.ok(Math.abs(fullSegs[1].start - 10.45) < 1e-6);
  assert.ok(Math.abs(fullSegs[1].end - 10.78) < 1e-6);

  // Local scope [10.48, 10.90] only sees the second burst and clamps strictly inside scope
  const scopedSegs = postprocessNeuralTrack(track, params, {
    audioDuration: 1.2,
    audioOffset,
    scopeStart: 10.48,
    scopeEnd: 10.90
  });
  assert.equal(scopedSegs.length, 1);
  assert.ok(scopedSegs[0].start >= 10.48 - 1e-9);
  assert.ok(scopedSegs[0].end <= 10.90 + 1e-9);
});

test('classic rule feature extraction and postprocessing detects speech bursts cleanly', () => {
  const sr = 16000;
  const duration = 2.0;
  const mono = new Float32Array(sr * duration);
  // Voiced tone burst at [0.5s, 1.1s]
  for (let i = Math.floor(0.5 * sr); i < Math.floor(1.1 * sr); i++) {
    mono[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / sr);
  }
  const ruleTrack = extractRuleFeatureTrack(mono, sr, 0, 20, 10);
  assert.ok(ruleTrack.numFrames >= 195);
  assert.equal(ruleTrack.pNorm.length, ruleTrack.numFrames);

  const params = createDefaultVadParams('standard', 'classic');
  const segs = postprocessRuleTrack(ruleTrack, params, {
    audioDuration: duration,
    audioOffset: 2.0
  });
  assert.equal(segs.length, 1);
  assert.ok(segs[0].start >= 2.45 && segs[0].start <= 2.55);
  assert.ok(segs[0].end >= 3.05 && segs[0].end <= 3.15);
});

test('getDefaultVadTarget implements approved smart target recommendation rules', () => {
  const blankSingleDoc = {
    name: 'blank.TextGrid',
    xmin: 0,
    xmax: 5,
    tiers: [
      {
        kind: 'intervalTier',
        name: 'Layer1',
        xmin: 0,
        xmax: 5,
        intervals: [{ xmin: 0, xmax: 5, text: '' }],
        points: []
      }
    ]
  };
  // Single blank interval tier -> directly write into tier 0
  const t1 = getDefaultVadTarget(blankSingleDoc, null, 'all');
  assert.equal(t1.mode, 'overwrite-tier');
  assert.equal(t1.targetTierIndex, 0);

  // Non-empty single tier -> create new VAD tier
  const annotatedDoc = {
    ...blankSingleDoc,
    tiers: [
      {
        ...blankSingleDoc.tiers[0],
        intervals: [
          { xmin: 0, xmax: 2, text: 'hello' },
          { xmin: 2, xmax: 5, text: '' }
        ]
      }
    ]
  };
  const t2 = getDefaultVadTarget(annotatedDoc, null, 'all');
  assert.equal(t2.mode, 'new-tier');
  assert.equal(t2.newTierName, 'VAD');

  // Selecting an empty interval -> default to split-interval
  const t3 = getDefaultVadTarget(
    annotatedDoc,
    { kind: 'interval', tierIndex: 0, itemIndex: 1 },
    undefined
  );
  assert.equal(t3.mode, 'split-interval');
  assert.equal(t3.targetTierIndex, 0);
  assert.equal(t3.intervalIndex, 1);

  // Unique VAD tier naming increments cleanly
  const withVad = {
    ...annotatedDoc,
    tiers: [
      ...annotatedDoc.tiers,
      { kind: 'intervalTier', name: 'VAD', xmin: 0, xmax: 5, intervals: [], points: [] },
      { kind: 'intervalTier', name: 'VAD 2', xmin: 0, xmax: 5, intervals: [], points: [] }
    ]
  };
  assert.equal(suggestUniqueVadTierName(withVad, 'VAD'), 'VAD 3');
});

test('vadWriter enforces seamless intervals, zero QA diagnostics, preserves out-of-scope text, and supports all label modes', () => {
  const baseTg = {
    name: 'field.TextGrid',
    xmin: 0,
    xmax: 10,
    tiers: [
      {
        kind: 'intervalTier',
        name: 'word',
        xmin: 0,
        xmax: 10,
        intervals: [
          { xmin: 0, xmax: 2.0, text: '已有开头' },
          { xmin: 2.0, xmax: 7.0, text: '' },
          { xmin: 7.0, xmax: 10.0, text: '已有结尾' }
        ],
        points: []
      }
    ]
  };

  // Include tricky edge cases: a 2ms micro sliver at start, a 2ms gap between segments, and a 3ms tiny fragment
  const trickySegs = [
    { start: 2.002, end: 3.10 },
    { start: 3.102, end: 3.80 },
    { start: 4.50, end: 4.503 }, // 3ms micro-fragment -> dropped
    { start: 5.00, end: 6.998 } // 2ms trailing sliver -> snapped to 7.0
  ];

  // 1. split-interval inside [2.0, 7.0] with speech-silence labels
  const splitRes = applyVadWritePlan({
    tg: baseTg,
    segments: trickySegs,
    scopeStart: 2.0,
    scopeEnd: 7.0,
    target: { mode: 'split-interval', targetTierIndex: 0, intervalIndex: 1, newTierName: 'VAD' },
    labelConfig: { mode: 'speech-silence', speechLabel: 'sounding', silenceLabel: 'silent' }
  });
  assert.equal(splitRes.ok, true);
  assert.equal(splitRes.speechCount, 3);
  assertSeamlessTier(splitRes.nextTg.tiers[0], 0, 10);
  // Out-of-scope annotations untouched!
  assert.equal(splitRes.nextTg.tiers[0].intervals[0].text, '已有开头');
  assert.equal(splitRes.nextTg.tiers[0].intervals[splitRes.nextTg.tiers[0].intervals.length - 1].text, '已有结尾');
  assert.equal(scanTextGridQa(splitRes.nextTg).counts.total, 0);

  // 2. new-tier with numbered labels and partial scope
  const newTierRes = applyVadWritePlan({
    tg: baseTg,
    segments: [
      { start: 2.5, end: 3.5 },
      { start: 4.2, end: 5.8 }
    ],
    scopeStart: 2.0,
    scopeEnd: 7.0,
    target: { mode: 'new-tier', targetTierIndex: 0, newTierName: 'VAD' },
    labelConfig: { mode: 'numbered', speechLabel: '', silenceLabel: '', numberPrefix: 'S' }
  });
  assert.equal(newTierRes.ok, true);
  assert.equal(newTierRes.nextTg.tiers.length, 2);
  assert.equal(newTierRes.writtenTierName, 'VAD');
  assertSeamlessTier(newTierRes.nextTg.tiers[1], 0, 10);
  const nonEmptyTexts = newTierRes.nextTg.tiers[1].intervals
    .map((iv) => iv.text)
    .filter(Boolean);
  assert.deepEqual(nonEmptyTexts, ['S1', 'S2']);
  assert.equal(scanTextGridQa(newTierRes.nextTg).counts.total, 0);

  // 3. overwrite-tier counts overwritten text intervals accurately and preserves out-of-scope content
  const warn = countOverwrittenTextIntervals(
    baseTg,
    { mode: 'overwrite-tier', targetTierIndex: 0, newTierName: 'VAD' },
    0,
    10
  );
  assert.equal(warn.nonEmptyCount, 2);

  const partialOverwrite = applyVadWritePlan({
    tg: baseTg,
    segments: [{ start: 3.0, end: 4.5 }],
    scopeStart: 2.5,
    scopeEnd: 6.5,
    target: { mode: 'overwrite-tier', targetTierIndex: 0, newTierName: 'VAD' },
    labelConfig: DEFAULT_VAD_LABEL_CONFIG
  });
  assert.equal(partialOverwrite.ok, true);
  assertSeamlessTier(partialOverwrite.nextTg.tiers[0], 0, 10);
  assert.equal(partialOverwrite.nextTg.tiers[0].intervals[0].text, '已有开头');
  assert.equal(
    partialOverwrite.nextTg.tiers[0].intervals[partialOverwrite.nextTg.tiers[0].intervals.length - 1].text,
    '已有结尾'
  );
  assert.equal(scanTextGridQa(partialOverwrite.nextTg).counts.total, 0);
});

test('snapVadSegmentsZeroCrossing keeps monotonic order and avoids sub-5ms slivers', async () => {
  const segs = [
    { start: 1.0, end: 1.5 },
    { start: 1.52, end: 2.0 }
  ];
  const snapped = await snapVadSegmentsZeroCrossing(segs, 0.0, 3.0, async (t) => t + 0.002);
  assert.equal(snapped.length, 2);
  assert.ok(snapped[0].end <= snapped[1].start);
  assert.ok(snapped[0].end - snapped[0].start >= 0.005);
  assert.ok(snapped[1].end - snapped[1].start >= 0.005);

  const built = buildSeamlessScopeIntervals(0, 3, snapped, DEFAULT_VAD_LABEL_CONFIG);
  assert.equal(built.speechCount, 2);
  assert.equal(built.intervals[0].xmin, 0);
  assert.equal(built.intervals[built.intervals.length - 1].xmax, 3);
  assert.ok(formatVadHistoryDetail('VAD', 2, 0, 3, false).includes('检出 2 个有声段'));
});
