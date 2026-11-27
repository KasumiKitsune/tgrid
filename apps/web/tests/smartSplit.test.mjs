import test from 'node:test';
import assert from 'node:assert/strict';
import { inferSmartSplit } from '../src/utils/smartSplit.ts';

function assertCandidateInvariants(cand) {
  assert.ok(cand, 'candidate should exist');
  assert.ok(Array.isArray(cand.texts) && cand.texts.length >= 2, 'candidate must have >= 2 segments');
  assert.equal(cand.durationWeights.length, cand.texts.length, 'durationWeights length mismatch');
  assert.equal(cand.acousticClasses.length, cand.texts.length, 'acousticClasses length mismatch');
  for (const w of cand.durationWeights) {
    assert.ok(Number.isFinite(w) && w > 0, `invalid duration weight: ${w}`);
  }
  assert.ok(cand.confidence >= 0 && cand.confidence <= 1, `confidence out of range: ${cand.confidence}`);
  assert.ok(cand.menuLabel.startsWith('智能拆分：'), `unexpected menuLabel: ${cand.menuLabel}`);
  assert.ok(cand.switchLabel.startsWith('改为'), `unexpected switchLabel: ${cand.switchLabel}`);
  assert.ok(cand.reason.length > 0, 'reason must be non-empty');
}

// ---------------------------------------------------------------------------
// 1. Preprocessing, Praat Decoded Text & Outer Wrapper Protection
// ---------------------------------------------------------------------------

test('Praat decoded text takes precedence and sets usedDecodedPraat', () => {
  const raw = 't\\^hi\\ng t\\sw t\\asu m\\sw';
  const decoded = 'tʰiŋ tə tɑu mə';
  const plan = inferSmartSplit(raw, decoded);

  assert.equal(plan.usedDecodedPraat, true);
  assert.equal(plan.sourceText, decoded);
  assert.equal(plan.contextHint, 'NEUTRAL');
  assertCandidateInvariants(plan.primary);
  assert.deepEqual(plan.primary.texts, ['tʰiŋ', 'tə', 'tɑu', 'mə']);
  assert.equal(plan.primary.strategyLabel, '按空格');
  // Alternative offers phone-level split
  assert.ok(plan.alternatives.some((a) => a.granularity === 'phone' && a.texts.length === 10));
});

test('Outer paired wrappers are stripped cleanly while preserving /p/ /t/ /k/', () => {
  const slashed = inferSmartSplit('/tʰiŋ/');
  assertCandidateInvariants(slashed.primary);
  assert.deepEqual(slashed.primary.texts, ['tʰ', 'i', 'ŋ']);

  const bracketed = inferSmartSplit('[tɕʰyən˥]');
  assertCandidateInvariants(bracketed.primary);
  assert.deepEqual(bracketed.primary.texts, ['tɕʰ', 'yən˥']);

  const quoted = inferSmartSplit('“春眠”');
  assertCandidateInvariants(quoted.primary);
  assert.deepEqual(quoted.primary.texts, ['春', '眠']);

  const quotedAttach = inferSmartSplit('“春眠”', null, { punctuationPreference: 'attach-prev' });
  assertCandidateInvariants(quotedAttach.primary);
  assert.deepEqual(quotedAttach.primary.texts, ['“春', '眠”']);

  const paren = inferSmartSplit('（春眠）');
  assertCandidateInvariants(paren.primary);
  assert.deepEqual(paren.primary.texts, ['春', '眠']);

  // /p/ /t/ /k/ must NOT strip outer '/' nor split on '/'; splits by space preserving slashes
  const phonemicList = inferSmartSplit('/p/ /t/ /k/');
  assertCandidateInvariants(phonemicList.primary);
  assert.deepEqual(phonemicList.primary.texts, ['/p/', '/t/', '/k/']);
  assert.equal(phonemicList.primary.strategyLabel, '按空格');
});

test('Tone sandhi slash and hyphen are protected from delimiter splitting', () => {
  const sandhiHanzi = inferSmartSplit('马214/35');
  assertCandidateInvariants(sandhiHanzi.primary);
  assert.deepEqual(sandhiHanzi.primary.texts, ['马', '214/35']);
  assert.equal(sandhiHanzi.primary.granularity, 'tone-split');

  const sandhiIpa = inferSmartSplit('ma55-21');
  assertCandidateInvariants(sandhiIpa.primary);
  assert.deepEqual(sandhiIpa.primary.texts, ['m', 'a55-21']);
  assert.equal(sandhiIpa.primary.texts.join(''), 'ma55-21');
});

test('Empty, whitespace-only, or unsplittable single atoms return primary: null', () => {
  assert.equal(inferSmartSplit('').primary, null);
  assert.equal(inferSmartSplit('   \t\u3000 ').primary, null);
  assert.equal(inferSmartSplit('春').primary, null);
  assert.equal(inferSmartSplit('tʰ').primary, null);
  assert.equal(inferSmartSplit('t͡sʰ').primary, null);
  assert.equal(inferSmartSplit('aː').primary, null);
  assert.equal(inferSmartSplit('a:').primary, null);
});

// ---------------------------------------------------------------------------
// 2. Context Tier Hint Extraction (Tier Name & Peer Interval Profiling)
// ---------------------------------------------------------------------------

test('Context hint matches tierName keywords accurately', () => {
  assert.equal(inferSmartSplit('tʰiŋ', null, { tierName: 'phone' }).contextHint, 'PHONE');
  assert.equal(inferSmartSplit('tʰiŋ', null, { tierName: '音素层' }).contextHint, 'PHONE');
  assert.equal(inferSmartSplit('tʰiŋ', null, { tierName: 'segment_1' }).contextHint, 'PHONE');
  assert.equal(inferSmartSplit('tʰiŋ', null, { tierName: 'onset_rime' }).contextHint, 'ONSET_RIME');
  assert.equal(inferSmartSplit('tʰiŋ', null, { tierName: '声韵' }).contextHint, 'ONSET_RIME');
  assert.equal(inferSmartSplit('tʰiŋ', null, { tierName: 'initial_final' }).contextHint, 'ONSET_RIME');
  assert.equal(inferSmartSplit('tʰiŋ', null, { tierName: 'syllable' }).contextHint, 'SYLLABLE');
  assert.equal(inferSmartSplit('tʰiŋ', null, { tierName: '汉字' }).contextHint, 'SYLLABLE');
  assert.equal(inferSmartSplit('tʰiŋ', null, { tierName: 'pinyin' }).contextHint, 'SYLLABLE');
  assert.equal(inferSmartSplit('tʰiŋ', null, { tierName: 'word' }).contextHint, 'WORD');
  assert.equal(inferSmartSplit('tʰiŋ', null, { tierName: '词汇' }).contextHint, 'WORD');
  assert.equal(inferSmartSplit('tʰiŋ', null, { tierName: 'tone' }).contextHint, 'TONE');
  assert.equal(inferSmartSplit('tʰiŋ', null, { tierName: '声调' }).contextHint, 'TONE');
  assert.equal(inferSmartSplit('tʰiŋ', null, { tierName: 'IPA' }).contextHint, 'NEUTRAL');
});

test('Context hint infers from peerTexts while filtering silence tokens', () => {
  const cjkPeers = ['', 'sil', '春', '眠', 'sp', '不', '觉', '<sil>', '晓', '#', '_'];
  assert.equal(inferSmartSplit('tɕʰyən˥', null, { peerTexts: cjkPeers }).contextHint, 'SYLLABLE');

  const phonePeers = ['sil', 'tʰ', 'i', 'ŋ', 'pau', 't', 'ə', 'm', 'aː'];
  const phonePlan = inferSmartSplit('tɕʰyən˥', null, { peerTexts: phonePeers });
  assert.equal(phonePlan.contextHint, 'PHONE');
  assert.deepEqual(phonePlan.primary.texts, ['tɕʰ', 'y', 'ə', 'n˥']);

  const onsetRimePeers = ['sp', 'tɕʰ', 'yən˥', 'm', 'iɛn˧˥', 'p', 'u˥˩', 'sil'];
  const orPlan = inferSmartSplit('tʰiŋ', null, { peerTexts: onsetRimePeers });
  assert.equal(orPlan.contextHint, 'ONSET_RIME');
  assert.deepEqual(orPlan.primary.texts, ['tʰ', 'iŋ']);
});

// ---------------------------------------------------------------------------
// 3. Stage 1: Explicit Structural Delimiters vs Natural Sentence Punctuation
// ---------------------------------------------------------------------------

test('Stage 1 handles strong delimiters, internal slash, enum delimiters, and symmetric hyphen', () => {
  assert.deepEqual(inferSmartSplit('a | b | c').primary.texts, ['a', 'b', 'c']);
  assert.deepEqual(inferSmartSplit('a‖b‖c').primary.texts, ['a', 'b', 'c']);
  assert.deepEqual(inferSmartSplit('a::b::c').primary.texts, ['a', 'b', 'c']);
  assert.deepEqual(inferSmartSplit('a//b//c').primary.texts, ['a', 'b', 'c']);
  assert.deepEqual(inferSmartSplit('a\tb\tc').primary.texts, ['a', 'b', 'c']);

  const slashPlan = inferSmartSplit('声母/韵母/声调');
  assert.equal(slashPlan.primary.strategyLabel, '按斜杠');
  assert.deepEqual(slashPlan.primary.texts, ['声母', '韵母', '声调']);

  assert.deepEqual(inferSmartSplit('春、眠、不、觉、晓').primary.texts, ['春', '眠', '不', '觉', '晓']);
  assert.deepEqual(inferSmartSplit('p,t,k').primary.texts, ['p', 't', 'k']);
  assert.deepEqual(inferSmartSplit('声母，韵母，声调').primary.texts, ['声母', '韵母', '声调']);
  assert.deepEqual(inferSmartSplit('a;b;c').primary.texts, ['a', 'b', 'c']);
  assert.deepEqual(inferSmartSplit('ba-da-ga').primary.texts, ['ba', 'da', 'ga']);
});

test('Stage 1 whitespace IPA penetrates into phones when context is PHONE', () => {
  const plan = inferSmartSplit('tʰiŋ tə tɑu mə', null, { tierName: 'phone' });
  assert.equal(plan.contextHint, 'PHONE');
  assertCandidateInvariants(plan.primary);
  assert.equal(plan.primary.granularity, 'phone');
  assert.deepEqual(plan.primary.texts, ['tʰ', 'i', 'ŋ', 't', 'ə', 't', 'ɑ', 'u', 'm', 'ə']);
  assert.ok(plan.alternatives.length >= 1);
  assert.equal(plan.alternatives[0].strategyLabel, '按空格');
  assert.deepEqual(plan.alternatives[0].texts, ['tʰiŋ', 'tə', 'tɑu', 'mə']);
});

// ---------------------------------------------------------------------------
// 4. Stage 2: CJK, Mixed Script, Tone Suffixes vs Ordinals, Kana & Hangul
// ---------------------------------------------------------------------------

test('Stage 2 splits Chinese poem sentence by character rather than comma, with clause & attach-prev alternatives', () => {
  const plan = inferSmartSplit('春眠不觉晓，处处闻啼鸟。');
  assertCandidateInvariants(plan.primary);
  assert.equal(plan.primary.strategyLabel, '按单字');
  assert.equal(plan.primary.menuLabel, '智能拆分：按单字（10 段）');
  assert.deepEqual(plan.primary.texts, ['春', '眠', '不', '觉', '晓', '处', '处', '闻', '啼', '鸟']);

  const clauseAlt = plan.alternatives.find((a) => a.texts.length === 2);
  assert.ok(clauseAlt, 'should offer 2-clause alternative');
  assert.deepEqual(clauseAlt.texts, ['春眠不觉晓', '处处闻啼鸟']);

  const attachAlt = plan.alternatives.find((a) => a.id === 'cjk-attach-prev');
  assert.ok(attachAlt, 'should offer attach-prev punctuation alternative');
  assert.deepEqual(attachAlt.texts, ['春', '眠', '不', '觉', '晓，', '处', '处', '闻', '啼', '鸟。']);
});

test('Stage 2 coalesces Latin/code chunks and distinguishes tone suffixes from ordinals', () => {
  assert.deepEqual(inferSmartSplit('测量VOT时长').primary.texts, ['测', '量', 'VOT', '时', '长']);
  assert.deepEqual(inferSmartSplit('F0曲线').primary.texts, ['F0', '曲', '线']);
  assert.deepEqual(inferSmartSplit('第1声').primary.texts, ['第', '1', '声']);
  assert.deepEqual(inferSmartSplit('妈55麻35').primary.texts, ['妈55', '麻35']);
  assert.deepEqual(inferSmartSplit('妈˥麻˧˥').primary.texts, ['妈˥', '麻˧˥']);

  // N=1 Hanzi with tone drills down
  const singleTone = inferSmartSplit('马35');
  assert.deepEqual(singleTone.primary.texts, ['马', '35']);
  assert.equal(singleTone.primary.granularity, 'tone-split');

  // Erhua merge alternative
  const erhua = inferSmartSplit('一朵花儿');
  assert.deepEqual(erhua.primary.texts, ['一', '朵', '花', '儿']);
  const erhuaAlt = erhua.alternatives.find((a) => a.id === 'cjk-erhua');
  assert.ok(erhuaAlt, 'should offer erhua merge alternative');
  assert.deepEqual(erhuaAlt.texts, ['一', '朵', '花儿']);
});

test('Stage 2 splits Japanese Kana by mora and Korean Hangul by syllable / N=1 Jamo', () => {
  const mora1 = inferSmartSplit('しゃしん');
  assert.equal(mora1.primary.strategyLabel, '按拍');
  assert.deepEqual(mora1.primary.texts, ['しゃ', 'し', 'ん']);

  const mora2 = inferSmartSplit('がっこう');
  assert.deepEqual(mora2.primary.texts, ['が', 'っ', 'こ', 'う']);

  const mora3 = inferSmartSplit('ラーメン');
  assert.deepEqual(mora3.primary.texts, ['ラ', 'ー', 'メ', 'ン']);

  const hangulMulti = inferSmartSplit('안녕하세요');
  assert.deepEqual(hangulMulti.primary.texts, ['안', '녕', '하', '세', '요']);

  const hangulSingle = inferSmartSplit('한');
  assert.equal(hangulSingle.primary.granularity, 'phone');
  assert.deepEqual(hangulSingle.primary.texts, ['ㅎ', 'ㅏ', 'ㄴ']);
});

// ---------------------------------------------------------------------------
// 5. Stage 3: Tone-Anchored Polysyllabic Strings & Continuous Pinyin
// ---------------------------------------------------------------------------

test('Stage 3 splits spaceless tone-anchored polysyllabic strings cleanly', () => {
  const chao = inferSmartSplit('tɕʰyən˥miɛn˧˥');
  assertCandidateInvariants(chao.primary);
  assert.equal(chao.primary.strategyLabel, '按声调锚点');
  assert.deepEqual(chao.primary.texts, ['tɕʰyən˥', 'miɛn˧˥']);

  const numIpa = inferSmartSplit('ma214mi51');
  assert.deepEqual(numIpa.primary.texts, ['ma214', 'mi51']);

  const numPy = inferSmartSplit('zhong1guo2');
  assert.deepEqual(numPy.primary.texts, ['zhong1', 'guo2']);
});

test('Stage 3 segments continuous Mandarin Pinyin (plain and tone-marked)', () => {
  const plain = inferSmartSplit('chunmian');
  assertCandidateInvariants(plain.primary);
  assert.equal(plain.primary.granularity, 'syllable');
  assert.deepEqual(plain.primary.texts, ['chun', 'mian']);

  const toned = inferSmartSplit('zhōngguó');
  assertCandidateInvariants(toned.primary);
  assert.deepEqual(toned.primary.texts, ['zhōng', 'guó']);

  const multi = inferSmartSplit('putonghua');
  assert.deepEqual(multi.primary.texts, ['pu', 'tong', 'hua']);

  const apostrophe = inferSmartSplit("xi'an");
  assert.deepEqual(apostrophe.primary.texts, ['xi', 'an']);
});

// ---------------------------------------------------------------------------
// 6. Stage 4: IPA State Machine, Syllabification & Monosyllabic Granularity
// ---------------------------------------------------------------------------

test('Stage 4 IPA atomic state machine preserves pre-nasal, stress, tie-bars, affricates, modifiers, colon, ejective', () => {
  assert.deepEqual(inferSmartSplit('ᵐba').primary.texts, ['ᵐb', 'a']);
  assert.deepEqual(inferSmartSplit('ˈtʰiŋ').primary.texts, ['ˈtʰ', 'i', 'ŋ']);
  assert.deepEqual(inferSmartSplit('t\u0361sʰaː').primary.texts, ['t\u0361sʰ', 'aː']);
  assert.deepEqual(inferSmartSplit('tʂɑŋ').primary.texts, ['tʂ', 'ɑ', 'ŋ']);
  assert.deepEqual(inferSmartSplit('pa:').primary.texts, ['p', 'a:']);
  assert.deepEqual(inferSmartSplit("p'a").primary.texts, ["p'", 'a']);
});

test('Stage 4 polysyllabic untoned IPA uses SSP/MOP syllable split by default and phone split in PHONE tier', () => {
  const p1 = inferSmartSplit('pʰaːkʷuː');
  assertCandidateInvariants(p1.primary);
  assert.equal(p1.primary.granularity, 'syllable');
  assert.deepEqual(p1.primary.texts, ['pʰaː', 'kʷuː']);
  assert.deepEqual(p1.alternatives[0].texts, ['pʰ', 'aː', 'kʷ', 'uː']);

  const p2 = inferSmartSplit('tʰiŋtə');
  assert.equal(p2.primary.granularity, 'syllable');
  assert.deepEqual(p2.primary.texts, ['tʰiŋ', 'tə']);
  assert.deepEqual(p2.alternatives[0].texts, ['tʰ', 'i', 'ŋ', 't', 'ə']);

  const p2Phone = inferSmartSplit('tʰiŋtə', null, { tierName: 'phone' });
  assert.equal(p2Phone.primary.granularity, 'phone');
  assert.deepEqual(p2Phone.primary.texts, ['tʰ', 'i', 'ŋ', 't', 'ə']);
  assert.deepEqual(p2Phone.alternatives[0].texts, ['tʰiŋ', 'tə']);
});

test('Stage 4 CRITICAL USER DECISION: neutral toned monosyllable defaults to 2-part onset-rime with phone alternative', () => {
  const planNoAudio = inferSmartSplit('tɕʰyən˥', null, { hasAudio: false });
  assert.equal(planNoAudio.contextHint, 'NEUTRAL');
  assertCandidateInvariants(planNoAudio.primary);

  // Primary: 2-part onset-rime
  assert.equal(planNoAudio.primary.granularity, 'onset-rime');
  assert.equal(planNoAudio.primary.strategyLabel, '按声韵');
  assert.deepEqual(planNoAudio.primary.texts, ['tɕʰ', 'yən˥']);
  assert.equal(planNoAudio.primary.menuLabel, '智能拆分：按声韵（2 段：tɕʰ · yən˥）');
  assert.equal(planNoAudio.primary.texts.join(''), 'tɕʰyən˥');
  // Acoustic classes for Phase 2 DSP: voiceless-obs -> vowel
  assert.deepEqual(planNoAudio.primary.acousticClasses, ['voiceless-obs', 'vowel']);
  assert.ok(planNoAudio.primary.durationWeights[1] > planNoAudio.primary.durationWeights[0]);

  // Alternative 1: 4-part phone with tone preserved on last segment
  const phoneAlt = planNoAudio.alternatives[0];
  assertCandidateInvariants(phoneAlt);
  assert.equal(phoneAlt.granularity, 'phone');
  assert.equal(phoneAlt.switchLabel, '改为音素 4 段');
  assert.deepEqual(phoneAlt.texts, ['tɕʰ', 'y', 'ə', 'n˥']);
  assert.equal(phoneAlt.texts.join(''), 'tɕʰyən˥');

  // Alternative 2 (when !hasAudio): 3-part onset-rime-tone
  const toneAlt = planNoAudio.alternatives[1];
  assertCandidateInvariants(toneAlt);
  assert.equal(toneAlt.granularity, 'tone-split');
  assert.deepEqual(toneAlt.texts, ['tɕʰ', 'yən', '˥']);
  assert.equal(toneAlt.texts.join(''), 'tɕʰyən˥');

  // When hasAudio is true, 3-part tone split is omitted
  const planWithAudio = inferSmartSplit('tɕʰyən˥', null, { hasAudio: true });
  assert.deepEqual(planWithAudio.primary.texts, ['tɕʰ', 'yən˥']);
  assert.equal(planWithAudio.alternatives.length, 1);
  assert.deepEqual(planWithAudio.alternatives[0].texts, ['tɕʰ', 'y', 'ə', 'n˥']);

  // Numeric tone complex monosyllable tiɑu51
  const tiau = inferSmartSplit('tiɑu51');
  assert.equal(tiau.primary.granularity, 'onset-rime');
  assert.deepEqual(tiau.primary.texts, ['t', 'iɑu51']);
  assert.deepEqual(tiau.alternatives[0].texts, ['t', 'i', 'ɑ', 'u51']);
  assert.equal(tiau.alternatives[0].texts.join(''), 'tiɑu51');
});

test('Stage 4 monosyllable respects PHONE, ONSET_RIME, and NEUTRAL untoned rules', () => {
  // NEUTRAL untoned tʰiŋ -> primary phone (3), alternative onset-rime (2)
  const neutralUntoned = inferSmartSplit('tʰiŋ');
  assert.equal(neutralUntoned.primary.granularity, 'phone');
  assert.deepEqual(neutralUntoned.primary.texts, ['tʰ', 'i', 'ŋ']);
  assert.equal(neutralUntoned.alternatives[0].granularity, 'onset-rime');
  assert.equal(neutralUntoned.alternatives[0].switchLabel, '改为声韵 2 段');
  assert.deepEqual(neutralUntoned.alternatives[0].texts, ['tʰ', 'iŋ']);

  // ONSET_RIME context overrides untoned tʰiŋ -> primary onset-rime (2)
  const orUntoned = inferSmartSplit('tʰiŋ', null, { tierName: '声韵' });
  assert.equal(orUntoned.primary.granularity, 'onset-rime');
  assert.deepEqual(orUntoned.primary.texts, ['tʰ', 'iŋ']);
  assert.deepEqual(orUntoned.alternatives[0].texts, ['tʰ', 'i', 'ŋ']);

  // PHONE context overrides toned tɕʰyən˥ -> primary phone (4)
  const phoneToned = inferSmartSplit('tɕʰyən˥', null, { tierName: 'phone' });
  assert.equal(phoneToned.primary.granularity, 'phone');
  assert.deepEqual(phoneToned.primary.texts, ['tɕʰ', 'y', 'ə', 'n˥']);
  assert.deepEqual(phoneToned.alternatives[0].texts, ['tɕʰ', 'yən˥']);

  // Simple CV monosyllables: unambiguous 2 segments
  assert.deepEqual(inferSmartSplit('ma214').primary.texts, ['m', 'a214']);
  assert.deepEqual(inferSmartSplit('t\u0361sʰaː').primary.texts, ['t\u0361sʰ', 'aː']);

  // N=1 single vowel with tone drills down
  const singleVowelTone = inferSmartSplit('a214');
  assert.equal(singleVowelTone.primary.granularity, 'tone-split');
  assert.deepEqual(singleVowelTone.primary.texts, ['a', '214']);
});

test('menuLabel preview rule: <= 4 segments AND preview <= 18 chars shows inline preview', () => {
  const shortPreview = inferSmartSplit('tɕʰyən˥');
  assert.equal(shortPreview.primary.menuLabel, '智能拆分：按声韵（2 段：tɕʰ · yən˥）');

  const longPreview = inferSmartSplit('Spring Summer Autumn Winter');
  assert.equal(longPreview.primary.texts.length, 4);
  assert.equal(longPreview.primary.menuLabel, '智能拆分：按空格（4 段）');

  const manySegs = inferSmartSplit('春眠不觉晓');
  assert.equal(manySegs.primary.texts.length, 5);
  assert.equal(manySegs.primary.menuLabel, '智能拆分：按单字（5 段）');
});

test('Edge cases: combining diacritics, sandhi multi-syllable IPA, aspirated stop vs affricate, Pinyin MOP, zero emoji', () => {
  // Combining dental + aspiration + nasalized long vowel
  assert.deepEqual(inferSmartSplit('t\u032Aʰa\u0303ː').primary.texts, ['t\u032Aʰ', 'a\u0303ː']);

  // Sandhi tone inside polysyllabic tone-anchored IPA
  assert.deepEqual(inferSmartSplit('tɕʰyən214/35miɛn51').primary.texts, ['tɕʰyən214/35', 'miɛn51']);

  // Aspirated tʰ followed by s must NOT falsely merge into affricate ts
  assert.deepEqual(inferSmartSplit('tʰs').primary.texts, ['tʰ', 's']);

  // Pinyin tie-breaker prefers consonant onset (fangan -> fan + gan; fang'an -> fang + an)
  assert.deepEqual(inferSmartSplit('fangan').primary.texts, ['fan', 'gan']);
  assert.deepEqual(inferSmartSplit("fang'an").primary.texts, ['fang', 'an']);

  // Zero emoji across generated labels and reasons
  const emojiRe = /\p{Extended_Pictographic}/u;
  const samples = [
    '春眠不觉晓，处处闻啼鸟。',
    'tɕʰyən˥',
    'tʰiŋ',
    'pʰaːkʷuː',
    'chunmian',
    'しゃしん',
    '한',
    '马35',
    'a | b | c'
  ];
  for (const s of samples) {
    const plan = inferSmartSplit(s);
    const all = [plan.primary, ...plan.alternatives].filter(Boolean);
    for (const c of all) {
      assert.equal(emojiRe.test(c.menuLabel), false, `emoji in menuLabel: ${c.menuLabel}`);
      assert.equal(emojiRe.test(c.switchLabel), false, `emoji in switchLabel: ${c.switchLabel}`);
      assert.equal(emojiRe.test(c.reason), false, `emoji in reason: ${c.reason}`);
    }
  }
});
