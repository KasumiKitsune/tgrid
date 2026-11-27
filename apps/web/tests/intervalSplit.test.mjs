import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCharSplitIntervals,
  buildDelimiterSplitIntervals,
  buildEqualIntervals,
  computeEqualSplitCuts,
  resolveSplitSourceText,
  splitTextByDelimiter,
  splitTextIntoChars
} from '../src/utils/intervalSplit.ts';
import {
  commitToTimeline,
  createHistoryTimeline,
  getCurrentSnapshot,
  produceTgMutation,
  setTimelineCursor
} from '../src/store/historyModel.ts';

test('splitTextIntoChars splits regular CJK text into individual characters', () => {
  assert.deepEqual(splitTextIntoChars('春眠不觉晓'), ['春', '眠', '不', '觉', '晓']);
});

test('splitTextIntoChars ignores leading, trailing, inter-char, and fullwidth whitespace', () => {
  assert.deepEqual(splitTextIntoChars('  春 眠\t不\n觉\u3000晓 \r\n '), [
    '春',
    '眠',
    '不',
    '觉',
    '晓'
  ]);
  assert.deepEqual(splitTextIntoChars(''), []);
  assert.deepEqual(splitTextIntoChars('   \t\n\u3000  '), []);
  assert.deepEqual(splitTextIntoChars('  春  '), ['春']);
});

test('splitTextIntoChars preserves surrogate pairs and combining diacritics', () => {
  // U+20BB7 (𠮷) is a UTF-16 surrogate pair
  assert.deepEqual(splitTextIntoChars('𠮷野家'), ['𠮷', '野', '家']);
  // IPA / Latin base letters with combining diacritical marks
  assert.deepEqual(splitTextIntoChars('a\u0301t\u0329o\u0303'), [
    'a\u0301',
    't\u0329',
    'o\u0303'
  ]);
});

test('buildCharSplitIntervals divides [1.0, 2.0] evenly for 春眠不觉晓', () => {
  const res = buildCharSplitIntervals(1.0, 2.0, '春眠不觉晓');
  assert.equal(res.ok, true);
  assert.equal(res.segments.length, 5);
  assert.deepEqual(res.segments, [
    { xmin: 1.0, xmax: 1.2, text: '春' },
    { xmin: 1.2, xmax: 1.4, text: '眠' },
    { xmin: 1.4, xmax: 1.6, text: '不' },
    { xmin: 1.6, xmax: 1.8, text: '觉' },
    { xmin: 1.8, xmax: 2.0, text: '晓' }
  ]);
});

test('buildCharSplitIntervals rejects insufficient characters and too-short spans', () => {
  const emptyRes = buildCharSplitIntervals(0, 1, '   ');
  assert.equal(emptyRes.ok, false);
  if (!emptyRes.ok) assert.equal(emptyRes.reason, 'insufficient-chars');

  const singleRes = buildCharSplitIntervals(0, 1, ' 晓 ');
  assert.equal(singleRes.ok, false);
  if (!singleRes.ok) assert.equal(singleRes.reason, 'insufficient-chars');

  const shortRes = buildCharSplitIntervals(1.0, 1.0 + 1e-7, '春眠');
  assert.equal(shortRes.ok, false);
  if (!shortRes.ok) assert.equal(shortRes.reason, 'too-short');
});

test('buildCharSplitIntervals supports sentences longer than 20 characters', () => {
  const poem = '春眠不觉晓处处闻啼鸟夜来风雨声花落知多少再加四个字凑';
  const res = buildCharSplitIntervals(0, 5.2, poem);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.segments.length, 26);
    assert.equal(res.segments[0].xmin, 0);
    assert.equal(res.segments[25].xmax, 5.2);
    for (let i = 1; i < res.segments.length; i++) {
      assert.equal(res.segments[i].xmin, res.segments[i - 1].xmax);
      assert.ok(res.segments[i].xmax > res.segments[i].xmin);
    }
    assert.equal(res.segments.map((s) => s.text).join(''), poem);
  }
});

test('computeEqualSplitCuts handles sub-millisecond spans without rounding collapse', () => {
  const cuts = computeEqualSplitCuts(1.0, 1.00005, 5);
  assert.ok(cuts);
  assert.equal(cuts.length, 6);
  assert.equal(cuts[0], 1.0);
  assert.equal(cuts[5], 1.00005);
  for (let i = 1; i < cuts.length; i++) {
    assert.ok(cuts[i] > cuts[i - 1]);
  }
  assert.equal(buildEqualIntervals(2.0, 1.0, ['a', 'b']), null);
});

test('char split commits as a single atomic history entry and restores cleanly on one undo', () => {
  const initialTg = {
    name: 'test.TextGrid',
    xmin: 0,
    xmax: 2,
    tiers: [
      {
        kind: 'intervalTier',
        name: '汉字',
        xmin: 0,
        xmax: 2,
        intervals: [
          { xmin: 0, xmax: 0.5, text: '' },
          { xmin: 0.5, xmax: 1.5, text: '春眠不觉晓' },
          { xmin: 1.5, xmax: 2.0, text: '' }
        ],
        points: []
      }
    ]
  };

  let timeline = createHistoryTimeline('open', 'test.TextGrid', {
    tg: initialTg,
    selection: { kind: 'interval', tierIndex: 0, itemIndex: 1 },
    hiddenTierIndices: [],
    playRange: null
  });

  const targetIv = initialTg.tiers[0].intervals[1];
  const splitRes = buildCharSplitIntervals(targetIv.xmin, targetIv.xmax, targetIv.text);
  assert.equal(splitRes.ok, true);
  if (!splitRes.ok) return;

  const produced = produceTgMutation(initialTg, (_draft, ctx) => {
    const dTier = ctx.editTier(0);
    if (!dTier || dTier.kind !== 'intervalTier') return false;
    dTier.intervals.splice(1, 1, ...splitRes.segments);
  });
  assert.equal(produced.changed, true);

  timeline = commitToTimeline(
    timeline,
    {
      type: 'split-equal',
      title: '按字数等分区间',
      detail: '汉字 · 按字数等分为 5 段 (0.500–1.500s)',
      icon: 'splitEqual',
      tierName: '汉字',
      focusTime: 0.5
    },
    {
      tg: produced.nextTg,
      selection: { kind: 'interval', tierIndex: 0, itemIndex: 1 },
      hiddenTierIndices: [],
      playRange: null
    }
  );

  // Single atomic history entry
  assert.equal(timeline.entries.length, 1);
  assert.equal(timeline.cursor, 0);

  const afterSplit = getCurrentSnapshot(timeline).tg.tiers[0].intervals;
  assert.equal(afterSplit.length, 7);
  assert.deepEqual(
    afterSplit.slice(1, 6).map((iv) => iv.text),
    ['春', '眠', '不', '觉', '晓']
  );

  // One Ctrl+Z restores original interval & text
  timeline = setTimelineCursor(timeline, timeline.cursor - 1);
  assert.equal(timeline.cursor, -1);
  const afterUndo = getCurrentSnapshot(timeline).tg.tiers[0].intervals;
  assert.equal(afterUndo.length, 3);
  assert.deepEqual(afterUndo[1], { xmin: 0.5, xmax: 1.5, text: '春眠不觉晓' });

  // Redo restores all 5 character intervals
  timeline = setTimelineCursor(timeline, timeline.cursor + 1);
  assert.equal(timeline.cursor, 0);
  const afterRedo = getCurrentSnapshot(timeline).tg.tiers[0].intervals;
  assert.equal(afterRedo.length, 7);
  assert.deepEqual(
    afterRedo.slice(1, 6).map((iv) => iv.text),
    ['春', '眠', '不', '觉', '晓']
  );
});

test('splitTextIntoChars handles punctuation modes (ignore, attach-prev, keep)', () => {
  const sentence = '春眠不觉晓，处处闻啼鸟。';
  assert.deepEqual(splitTextIntoChars(sentence), [
    '春',
    '眠',
    '不',
    '觉',
    '晓',
    '处',
    '处',
    '闻',
    '啼',
    '鸟'
  ]);
  assert.deepEqual(splitTextIntoChars(sentence, { punctuation: 'attach-prev' }), [
    '春',
    '眠',
    '不',
    '觉',
    '晓，',
    '处',
    '处',
    '闻',
    '啼',
    '鸟。'
  ]);
  assert.deepEqual(splitTextIntoChars(sentence, { punctuation: 'keep' }), [
    '春',
    '眠',
    '不',
    '觉',
    '晓',
    '，',
    '处',
    '处',
    '闻',
    '啼',
    '鸟',
    '。'
  ]);
  // Leading quotes attach cleanly to the first char under attach-prev
  assert.deepEqual(splitTextIntoChars('“春眠”', { punctuation: 'attach-prev' }), ['“春', '眠”']);
});

test('Praat decoded IPA splits by translated symbols and preserves tie-bars and IPA modifiers', () => {
  const raw = 't\\^hi\\ng t\\sw t\\asu m\\sw';
  const decoded = 'tʰiŋ tə tɑu mə';
  const resolved = resolveSplitSourceText(raw, decoded);
  assert.equal(resolved.usedDecodedPraat, true);
  assert.equal(resolved.text, decoded);

  // Whitespace token split on translated IPA
  assert.deepEqual(splitTextByDelimiter(resolved.text, { preset: 'whitespace' }), [
    'tʰiŋ',
    'tə',
    'tɑu',
    'mə'
  ]);

  // Character/phoneme split keeps tʰ together
  assert.deepEqual(splitTextIntoChars(resolved.text), [
    'tʰ',
    'i',
    'ŋ',
    't',
    'ə',
    't',
    'ɑ',
    'u',
    'm',
    'ə'
  ]);

  // Tie-bars + aspiration + length stay intact; slashes ignored by default
  assert.deepEqual(splitTextIntoChars('/t\u0361sʰaː/'), ['t\u0361sʰ', 'aː']);
  // Single aspirated consonant is 1 unit (not torn into 't' + 'ʰ')
  assert.deepEqual(splitTextIntoChars('tʰ'), ['tʰ']);
});

test('splitTextByDelimiter supports presets, custom literal delimiters, and edge punctuation stripping', () => {
  assert.deepEqual(
    splitTextByDelimiter('  hello   world\tfoo\u3000bar ', { preset: 'whitespace' }),
    ['hello', 'world', 'foo', 'bar']
  );
  assert.deepEqual(
    splitTextByDelimiter("Hello, world! Don't stop.", {
      preset: 'whitespace',
      stripEdgePunctuation: true
    }),
    ['Hello', 'world', "Don't", 'stop']
  );
  assert.deepEqual(
    splitTextByDelimiter('春眠不觉晓，处处闻啼鸟。', {
      preset: 'comma',
      stripEdgePunctuation: true
    }),
    ['春眠不觉晓', '处处闻啼鸟']
  );
  assert.deepEqual(splitTextByDelimiter('春、眠、不、觉、晓', { preset: 'enum-comma' }), [
    '春',
    '眠',
    '不',
    '觉',
    '晓'
  ]);
  assert.deepEqual(splitTextByDelimiter('声母/韵母/声调', { preset: 'slash' }), [
    '声母',
    '韵母',
    '声调'
  ]);
  assert.deepEqual(
    splitTextByDelimiter('a::b::c', { preset: 'custom', customDelimiter: '::' }),
    ['a', 'b', 'c']
  );
  // Regex metacharacters in custom delimiter work literally without throwing
  assert.deepEqual(
    splitTextByDelimiter('a+b+c', { preset: 'custom', customDelimiter: '+' }),
    ['a', 'b', 'c']
  );
  assert.deepEqual(splitTextByDelimiter('a b', { preset: 'custom', customDelimiter: '' }), []);

  const res = buildDelimiterSplitIntervals(0, 2, 'tʰiŋ tə tɑu mə', { preset: 'whitespace' });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.segments, [
      { xmin: 0, xmax: 0.5, text: 'tʰiŋ' },
      { xmin: 0.5, xmax: 1.0, text: 'tə' },
      { xmin: 1.0, xmax: 1.5, text: 'tɑu' },
      { xmin: 1.5, xmax: 2.0, text: 'mə' }
    ]);
  }
});
