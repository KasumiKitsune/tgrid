export type SmartSplitGranularity =
  | 'delimiter'
  | 'word'
  | 'syllable'
  | 'onset-rime'
  | 'phone'
  | 'tone-split';

export type ContextTierHint =
  | 'WORD'
  | 'SYLLABLE'
  | 'ONSET_RIME'
  | 'PHONE'
  | 'TONE'
  | 'NEUTRAL';

export type AcousticSegmentClass =
  | 'voiceless-obs'
  | 'voiced-obs'
  | 'nasal-liquid'
  | 'vowel'
  | 'syllable'
  | 'other';

export interface SmartSplitContext {
  tierName?: string;
  peerTexts?: readonly string[];
  hasAudio?: boolean;
  punctuationPreference?: 'ignore' | 'attach-prev' | 'keep';
}

export interface SmartSplitCandidate {
  id: string;
  strategyLabel: string;
  menuLabel: string;
  switchLabel: string;
  granularity: SmartSplitGranularity;
  texts: string[];
  durationWeights: number[];
  acousticClasses: AcousticSegmentClass[];
  confidence: number;
  reason: string;
}

export interface SmartSplitPlan {
  sourceText: string;
  usedDecodedPraat: boolean;
  contextHint: ContextTierHint;
  primary: SmartSplitCandidate | null;
  alternatives: SmartSplitCandidate[];
}

// ---------------------------------------------------------------------------
// Character & Phonetic Classification Tables
// ---------------------------------------------------------------------------

const SILENCE_PEER_RE = /^(?:sp|sil|pau|<sil>|<pau>|<sp>|\[sil\]|\[pau\]|#|_|\.{2,})$/i;

const HANZI_RE = /\p{Script=Han}/u;
const HANGUL_SYLLABLE_RE = /[\uAC00-\uD7A3]/;
const HANGUL_ANY_RE = /\p{Script=Hangul}/u;
const KANA_RE = /[\u3040-\u309F\u30A0-\u30FF\u30FC]/;
const SMALL_YOON_KANA_RE = /^[ゃゅょぁぃぅぇぉゎャュョァィゥェォヮヵヶ]$/;
const CJK_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hangul}\u3040-\u309F\u30A0-\u30FF]/u;

const PUNCT_UNIT_RE = /^\p{P}+$/u;
const SENTENCE_END_PUNCT_RE = /[。！？!?…]/;
const SENTENCE_EDGE_PUNCT_RE = /^[.,!?;:，。！？；：、…“”‘’"'（）()《》【】「」『』]+|[.,!?;:，。！？；：、…“”‘’"'（）()《》【】「」『』]+$/g;

const CHAO_TONE_CHAR_RE = /[˥˦˧˨˩]/;
const NUMERIC_TONE_SEQ_RE = /^[0-5]{1,3}(?:[-/][0-5]{1,3})?$/;
const PURE_TONE_TEXT_RE = /^(?:[˥˦˧˨˩]+(?:[-/][˥˦˧˨˩]+)?|[0-5]{1,3}(?:[-/][0-5]{1,3})?)$/;

const TRAILING_CHAO_TONE_RE = /([˥˦˧˨˩]+(?:[-/][˥˦˧˨˩]+)?)$/;
const TRAILING_NUMERIC_TONE_RE = /([0-5]{1,3}(?:[-/][0-5]{1,3})?)$/;

// Combining tone diacritics (acute, grave, circumflex, macron, caron, double acute/grave)
const COMBINING_TONE_MARK_RE = /[\u0300\u0301\u0302\u0304\u030B\u030C\u030F\u1DC4-\u1DC9]/;
const COMBINING_MARK_RE = /^\p{M}$/u;
const SYLLABIC_MARK_RE = /[\u0329\u030D]/;
const VOICELESS_DIACRITIC_RE = /[\u0325\u030A]/;

const STRESS_MARKS = new Set(['ˈ', 'ˌ']);
const PRE_NASAL_SUPERSCRIPTS = new Set(['ᵐ', 'ⁿ', 'ᵑ', 'ᶮ', 'ᶯ']);
const IPA_POST_MODIFIERS = new Set([
  'ʰ', 'ʱ', 'ʷ', 'ʲ', 'ˠ', 'ˤ', 'ˀ', 'ⁿ', 'ˡ', '˞', 'ʼ', 'ː', 'ˑ',
  'ʳ', 'ʴ', 'ʵ', 'ʶ', 'ʸ', 'ˢ', 'ˣ', 'ᵐ', 'ᵑ', 'ᶿ', 'ᶹ', 'ˁ', 'ᶣ', 'ᶢ', 'ᶭ', 'ᶠ', 'ᵈ', 'ᵗ', 'ᶮ', 'ᶯ'
]);

const IMPLICIT_AFFRICATES = new Set([
  'ts', 'dz', 'tʂ', 'dʐ', 'ʈʂ', 'ɖʐ', 'tɕ', 'dʑ', 'tʃ', 'dʒ',
  'pf', 'bv', 'tɬ', 'dɮ', 'cç', 'ɟʝ'
]);

const IPA_VOWELS = new Set([
  'a', 'e', 'i', 'o', 'u', 'y',
  'ɪ', 'ʏ', 'ʊ', 'ø', 'ɘ', 'ɵ', 'ɤ', 'ə', 'ɛ', 'œ', 'ɜ', 'ɞ',
  'ʌ', 'ɔ', 'æ', 'ɐ', 'ɶ', 'ɑ', 'ɒ', 'ɨ', 'ʉ', 'ɯ',
  'ɚ', 'ɝ', 'ɿ', 'ʅ', 'ʮ', 'ʯ'
]);

const VOICELESS_STOPS = new Set(['p', 't', 'ʈ', 'c', 'k', 'q', 'ʡ', 'ʔ']);
const VOICED_STOPS = new Set(['b', 'd', 'ɖ', 'ɟ', 'g', 'ɡ', 'ɢ', 'ɓ', 'ɗ', 'ᶑ', 'ʄ', 'ɠ', 'ʛ']);
const VOICELESS_FRICATIVES = new Set(['ɸ', 'f', 'θ', 's', 'ʃ', 'ʂ', 'ç', 'x', 'χ', 'ħ', 'h', 'ɬ', 'ɕ', 'ɧ']);
const VOICED_FRICATIVES = new Set(['β', 'v', 'ð', 'z', 'ʒ', 'ʐ', 'ʝ', 'ɣ', 'ʁ', 'ʕ', 'ɦ', 'ɮ', 'ʑ']);
const NASALS = new Set(['m', 'ɱ', 'n', 'ɳ', 'ɲ', 'ŋ', 'ɴ']);
const LIQUIDS = new Set(['l', 'ɭ', 'ʎ', 'ʟ', 'r', 'ɾ', 'ɽ', 'ʀ', 'ʙ', 'ɺ', 'ɹ', 'ɻ']);
const GLIDES = new Set(['j', 'w', 'ɥ', 'ɰ', 'ʋ']);

const VOICELESS_AFFRICATES = new Set(['ts', 'tʂ', 'ʈʂ', 'tɕ', 'tʃ', 'pf', 'tɬ', 'cç']);
const VOICED_AFFRICATES = new Set(['dz', 'dʐ', 'ɖʐ', 'dʑ', 'dʒ', 'bv', 'dɮ', 'ɟʝ']);

const STOP_LIKE_FOR_EJECTIVE = new Set([
  'p', 't', 'ʈ', 'c', 'k', 'q', 'ts', 'tʂ', 'ʈʂ', 'tɕ', 'tʃ', 'tɬ', 'cç'
]);

const IPA_DISTINCTIVE_RE = /[ʰʱʷʲˠˤˀːˑʼˈˌɑɒæɐəɚɛɜɝɪɨɯɵøœɔʊʉʌɤɿʅʮʯʈɖɟɡɢʔɸβθðʃʒʂʐɕʑçʝɣχʁħʕɦɬɮɱɳɲŋɴɾɽɹɻɭʎʟɥɰʋ\u0361\u035C˥˦˧˨˩]/;

const HANZI_ORDINAL_PREFIX = new Set([
  '第', '共', '约', '近', '达', '超', '满', '剩', '差', '前', '后',
  '增', '减', '加', '乘', '除', '正', '负', '每', '按', '分', '拆', '选', '含', '有'
]);

const HANZI_MEASURE_AFTER_NUM = new Set([
  '声', '调', '组', '次', '个', '段', '层', '遍', '名', '位', '种', '类',
  '级', '号', '章', '节', '页', '行', '列', '秒', '分', '时', '天', '日',
  '月', '年', '岁', '米', '克', '元', '块', '人', '条', '句', '字', '词', '音'
]);

// Korean Hangul Jamo compatibility tables for N=1 decomposition
const HANGUL_L = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ',
  'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
];
const HANGUL_V = [
  'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ',
  'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'
];
const HANGUL_T = [
  '', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ',
  'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
];

// Complete standard Mandarin Pinyin syllable inventory (~415 syllables)
const PINYIN_SYLLABLES = new Set<string>([
  // Bare finals & special syllables
  'a', 'o', 'e', 'ai', 'ei', 'ao', 'ou', 'an', 'en', 'ang', 'eng', 'er',
  'yi', 'ya', 'ye', 'yao', 'you', 'yan', 'yin', 'yang', 'ying', 'yong',
  'wu', 'wa', 'wo', 'wai', 'wei', 'wan', 'wen', 'wang', 'weng',
  'yu', 'yue', 'yuan', 'yun', 'yo', 'lo', 'hm', 'hng', 'ng', 'm', 'n',
  // b
  'ba', 'bo', 'bai', 'bei', 'bao', 'ban', 'ben', 'bang', 'beng',
  'bi', 'bie', 'biao', 'bian', 'bin', 'bing', 'bu',
  // p
  'pa', 'po', 'pai', 'pei', 'pao', 'pou', 'pan', 'pen', 'pang', 'peng',
  'pi', 'pie', 'piao', 'pian', 'pin', 'ping', 'pu',
  // m
  'ma', 'mo', 'me', 'mai', 'mei', 'mao', 'mou', 'man', 'men', 'mang', 'meng',
  'mi', 'mie', 'miao', 'miu', 'mian', 'min', 'ming', 'mu',
  // f
  'fa', 'fo', 'fei', 'fou', 'fan', 'fen', 'fang', 'feng', 'fu', 'fiao',
  // d
  'da', 'de', 'dai', 'dei', 'dao', 'dou', 'dan', 'den', 'dang', 'deng', 'dong',
  'di', 'dia', 'die', 'diao', 'diu', 'dian', 'ding',
  'du', 'duo', 'dui', 'duan', 'dun',
  // t
  'ta', 'te', 'tai', 'tei', 'tao', 'tou', 'tan', 'tang', 'teng', 'tong',
  'ti', 'tie', 'tiao', 'tian', 'ting',
  'tu', 'tuo', 'tui', 'tuan', 'tun',
  // n
  'na', 'ne', 'nai', 'nei', 'nao', 'nou', 'nan', 'nen', 'nang', 'neng', 'nong',
  'ni', 'nie', 'niao', 'niu', 'nian', 'nin', 'niang', 'ning',
  'nu', 'nuo', 'nuan', 'nun', 'nv', 'nve',
  // l
  'la', 'le', 'lai', 'lei', 'lao', 'lou', 'lan', 'lang', 'leng', 'long',
  'li', 'lia', 'lie', 'liao', 'liu', 'lian', 'lin', 'liang', 'ling',
  'lu', 'luo', 'luan', 'lun', 'lv', 'lve',
  // g
  'ga', 'ge', 'gai', 'gei', 'gao', 'gou', 'gan', 'gen', 'gang', 'geng', 'gong',
  'gu', 'gua', 'guo', 'guai', 'gui', 'guan', 'gun', 'guang',
  // k
  'ka', 'ke', 'kai', 'kei', 'kao', 'kou', 'kan', 'ken', 'kang', 'keng', 'kong',
  'ku', 'kua', 'kuo', 'kuai', 'kui', 'kuan', 'kun', 'kuang',
  // h
  'ha', 'he', 'hai', 'hei', 'hao', 'hou', 'han', 'hen', 'hang', 'heng', 'hong',
  'hu', 'hua', 'huo', 'huai', 'hui', 'huan', 'hun', 'huang',
  // j
  'ji', 'jia', 'jie', 'jiao', 'jiu', 'jian', 'jin', 'jiang', 'jing', 'jiong',
  'ju', 'jue', 'juan', 'jun',
  // q
  'qi', 'qia', 'qie', 'qiao', 'qiu', 'qian', 'qin', 'qiang', 'qing', 'qiong',
  'qu', 'que', 'quan', 'qun',
  // x
  'xi', 'xia', 'xie', 'xiao', 'xiu', 'xian', 'xin', 'xiang', 'xing', 'xiong',
  'xu', 'xue', 'xuan', 'xun',
  // zh
  'zha', 'zhe', 'zhi', 'zhai', 'zhei', 'zhao', 'zhou', 'zhan', 'zhen', 'zhang', 'zheng', 'zhong',
  'zhu', 'zhua', 'zhuo', 'zhuai', 'zhui', 'zhuan', 'zhun', 'zhuang',
  // ch
  'cha', 'che', 'chi', 'chai', 'chao', 'chou', 'chan', 'chen', 'chang', 'cheng', 'chong',
  'chu', 'chua', 'chuo', 'chuai', 'chui', 'chuan', 'chun', 'chuang',
  // sh
  'sha', 'she', 'shi', 'shai', 'shei', 'shao', 'shou', 'shan', 'shen', 'shang', 'sheng',
  'shu', 'shua', 'shuo', 'shuai', 'shui', 'shuan', 'shun', 'shuang',
  // r
  're', 'ri', 'rao', 'rou', 'ran', 'ren', 'rang', 'reng', 'rong',
  'ru', 'rua', 'ruo', 'rui', 'ruan', 'run',
  // z
  'za', 'ze', 'zi', 'zai', 'zei', 'zao', 'zou', 'zan', 'zen', 'zang', 'zeng', 'zong',
  'zu', 'zuo', 'zui', 'zuan', 'zun',
  // c
  'ca', 'ce', 'ci', 'cai', 'cao', 'cou', 'can', 'cen', 'cang', 'ceng', 'cong',
  'cu', 'cuo', 'cui', 'cuan', 'cun',
  // s
  'sa', 'se', 'si', 'sai', 'sei', 'sao', 'sou', 'san', 'sen', 'sang', 'seng', 'song',
  'su', 'suo', 'sui', 'suan', 'sun'
]);

const PINYIN_TONE_CHAR_MAP: Record<string, string> = {
  'ā': 'a', 'á': 'a', 'ǎ': 'a', 'à': 'a',
  'ē': 'e', 'é': 'e', 'ě': 'e', 'è': 'e', 'ê': 'e',
  'ī': 'i', 'í': 'i', 'ǐ': 'i', 'ì': 'i',
  'ō': 'o', 'ó': 'o', 'ǒ': 'o', 'ò': 'o',
  'ū': 'u', 'ú': 'u', 'ǔ': 'u', 'ù': 'u',
  'ǖ': 'v', 'ǘ': 'v', 'ǚ': 'v', 'ǜ': 'v', 'ü': 'v',
  'ń': 'n', 'ň': 'n', 'ǹ': 'n', 'ḿ': 'm',
  'Ā': 'a', 'Á': 'a', 'Ǎ': 'a', 'À': 'a',
  'Ē': 'e', 'É': 'e', 'Ě': 'e', 'È': 'e', 'Ê': 'e',
  'Ī': 'i', 'Í': 'i', 'Ǐ': 'i', 'Ì': 'i',
  'Ō': 'o', 'Ó': 'o', 'Ǒ': 'o', 'Ò': 'o',
  'Ū': 'u', 'Ú': 'u', 'Ǔ': 'u', 'Ù': 'u',
  'Ǖ': 'v', 'Ǘ': 'v', 'Ǚ': 'v', 'Ǜ': 'v', 'Ü': 'v'
};

// ---------------------------------------------------------------------------
// IPA Atomic Segmenter
// ---------------------------------------------------------------------------

interface IpaAtom {
  text: string;
  base: string;
  kind: 'consonant' | 'vowel' | 'glide' | 'other';
  sonority: number;
  acousticClass: AcousticSegmentClass;
  hasAspiration: boolean;
  isLong: boolean;
  isHalfLong: boolean;
  isStressed: boolean;
  weight: number;
}

function stripCombiningToBase(s: string): string {
  // NFD splits precomposed accented Latin vowels (like á -> a + U+0301)
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

function classifySingleBase(
  rawSegment: string,
  base: string,
  hasAspiration: boolean,
  isLong: boolean,
  isHalfLong: boolean
): Pick<IpaAtom, 'kind' | 'sonority' | 'acousticClass' | 'weight'> {
  // Syllabic consonants (m̩, n̩, ŋ̍, ɹ̩, ɻ̩, z̩, ʐ̩) act as vowel nuclei
  if (SYLLABIC_MARK_RE.test(rawSegment) && !IPA_VOWELS.has(base)) {
    const w = isLong ? 1.8 : isHalfLong ? 1.5 : 1.3;
    return { kind: 'vowel', sonority: 6, acousticClass: 'vowel', weight: w };
  }

  if (IPA_VOWELS.has(base)) {
    const w = isLong ? 2.0 : isHalfLong ? 1.7 : 1.4;
    return { kind: 'vowel', sonority: 6, acousticClass: 'vowel', weight: w };
  }

  if (VOICELESS_AFFRICATES.has(base)) {
    const w = hasAspiration ? 1.05 : 0.85;
    return { kind: 'consonant', sonority: 1, acousticClass: 'voiceless-obs', weight: w };
  }

  if (VOICED_AFFRICATES.has(base)) {
    return { kind: 'consonant', sonority: 1, acousticClass: 'voiced-obs', weight: 0.85 };
  }

  // Tie-bar affricate or co-articulation (e.g. t͡s, d͡ʒ, k͡p)
  if (rawSegment.includes('\u0361') || rawSegment.includes('\u035C')) {
    const parts = base.split('');
    const first = parts[0] ?? '';
    const isVoiceless =
      VOICELESS_STOPS.has(first) ||
      VOICELESS_FRICATIVES.has(first) ||
      VOICELESS_DIACRITIC_RE.test(rawSegment) ||
      hasAspiration;
    return {
      kind: 'consonant',
      sonority: 1,
      acousticClass: isVoiceless ? 'voiceless-obs' : 'voiced-obs',
      weight: hasAspiration ? 1.05 : 0.85
    };
  }

  if (VOICELESS_STOPS.has(base)) {
    return {
      kind: 'consonant',
      sonority: 1,
      acousticClass: 'voiceless-obs',
      weight: hasAspiration ? 1.0 : 0.65
    };
  }

  if (VOICED_STOPS.has(base)) {
    const devoiced = VOICELESS_DIACRITIC_RE.test(rawSegment) || hasAspiration;
    return {
      kind: 'consonant',
      sonority: 1,
      acousticClass: devoiced ? 'voiceless-obs' : 'voiced-obs',
      weight: 0.75
    };
  }

  if (VOICELESS_FRICATIVES.has(base)) {
    return { kind: 'consonant', sonority: 2, acousticClass: 'voiceless-obs', weight: 1.0 };
  }

  if (VOICED_FRICATIVES.has(base)) {
    const devoiced = VOICELESS_DIACRITIC_RE.test(rawSegment);
    return {
      kind: 'consonant',
      sonority: 2,
      acousticClass: devoiced ? 'voiceless-obs' : 'voiced-obs',
      weight: 0.85
    };
  }

  if (NASALS.has(base)) {
    return {
      kind: 'consonant',
      sonority: 3,
      acousticClass: 'nasal-liquid',
      weight: isLong ? 1.3 : 0.95
    };
  }

  if (LIQUIDS.has(base)) {
    return {
      kind: 'consonant',
      sonority: 4,
      acousticClass: 'nasal-liquid',
      weight: isLong ? 1.25 : 0.9
    };
  }

  if (GLIDES.has(base)) {
    return {
      kind: 'glide',
      sonority: 5,
      acousticClass: 'nasal-liquid',
      weight: 0.85
    };
  }

  // Fallback for other ASCII letters like x/c/q already covered above; handle anything else
  return { kind: 'other', sonority: 0, acousticClass: 'other', weight: 0.8 };
}

function isStopBase(ch: string): boolean {
  const b = stripCombiningToBase(ch);
  return VOICELESS_STOPS.has(b) || VOICED_STOPS.has(b);
}

/**
 * Tokenize a single continuous IPA / phonetic string (without spaces or trailing tones)
 * into atomic phonetic segments, respecting:
 * - Pre-posed stress marks & pre-nasalization/pre-aspiration superscripts (right-attaching)
 * - Explicit tie-bars U+0361 / U+035C
 * - Implicit affricate whitelist (ts, dz, tʂ, dʐ, tɕ, dʑ, tʃ, dʒ, pf, bv, tɬ, dɮ, cç, ɟʝ, ...)
 * - Combining diacritics (left-attaching)
 * - Post-posed modifiers & length marks (ʰʱʷʲˠˤˀⁿˡ˞ʼːˑ, post-vowel ':', post-stop '\'')
 */
function tokenizeIpaAtoms(text: string): IpaAtom[] {
  if (!text) return [];
  const cps = Array.from(text);

  // Step 1: Group each base code point with its following non-tie combining marks
  const units: string[] = [];
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    if (ch === '\u0361' || ch === '\u035C') {
      // Attach tie-bar to previous unit so step 2 can bridge with next unit
      if (units.length > 0) {
        units[units.length - 1] += ch;
      } else {
        units.push(ch);
      }
      continue;
    }
    if (COMBINING_MARK_RE.test(ch) && units.length > 0) {
      units[units.length - 1] += ch;
    } else {
      units.push(ch);
    }
  }

  // Step 2: Bridge explicit tie-bars (U+0361 / U+035C)
  const bridged: string[] = [];
  for (let i = 0; i < units.length; i++) {
    let u = units[i];
    while ((u.endsWith('\u0361') || u.endsWith('\u035C')) && i + 1 < units.length) {
      u += units[++i];
    }
    bridged.push(u);
  }

  // Step 3: Build atoms with pre-posed prefix buffering, implicit affricates, and post-modifiers
  interface RawAtom {
    prefix: string;
    core: string;
    base: string;
    suffix: string;
  }

  const rawAtoms: RawAtom[] = [];
  let pendingPrefix = '';

  for (let i = 0; i < bridged.length; i++) {
    const u = bridged[i];
    const next = i + 1 < bridged.length ? bridged[i + 1] : '';

    // Stress marks always right-attach
    if (STRESS_MARKS.has(u)) {
      pendingPrefix += u;
      continue;
    }

    // Pre-nasal superscripts (ᵐb, ⁿd, ᵑɡ) or initial pre-aspiration (ʰp) right-attach before a stop/consonant
    if (
      PRE_NASAL_SUPERSCRIPTS.has(u) &&
      next &&
      isStopBase(next) &&
      (rawAtoms.length === 0 ||
        pendingPrefix.length > 0 ||
        IPA_VOWELS.has(rawAtoms[rawAtoms.length - 1].base))
    ) {
      pendingPrefix += u;
      continue;
    }
    if (u === 'ʰ' && (rawAtoms.length === 0 || pendingPrefix.length > 0) && next && isStopBase(next)) {
      pendingPrefix += u;
      continue;
    }

    // Post-posed IPA modifiers left-attach to preceding atom
    if (IPA_POST_MODIFIERS.has(u) && rawAtoms.length > 0 && pendingPrefix.length === 0) {
      rawAtoms[rawAtoms.length - 1].suffix += u;
      continue;
    }

    // ASCII ':' immediately following a vowel attaches as length mark
    if (
      u === ':' &&
      rawAtoms.length > 0 &&
      pendingPrefix.length === 0 &&
      IPA_VOWELS.has(rawAtoms[rawAtoms.length - 1].base)
    ) {
      rawAtoms[rawAtoms.length - 1].suffix += u;
      continue;
    }

    // ASCII '\'' immediately following a stop or affricate attaches as ejective / aspiration
    if (
      u === "'" &&
      rawAtoms.length > 0 &&
      pendingPrefix.length === 0 &&
      STOP_LIKE_FOR_EJECTIVE.has(rawAtoms[rawAtoms.length - 1].base)
    ) {
      rawAtoms[rawAtoms.length - 1].suffix += u;
      continue;
    }

    // Check implicit affricate whitelist with next unit (only when current unit has no tie-bar yet)
    const curBase = stripCombiningToBase(u);
    const nextBase = next ? stripCombiningToBase(next) : '';
    if (
      next &&
      !u.includes('\u0361') &&
      !u.includes('\u035C') &&
      IMPLICIT_AFFRICATES.has(curBase + nextBase)
    ) {
      const combinedCore = u + next;
      const combinedBase = curBase + nextBase;
      rawAtoms.push({
        prefix: pendingPrefix,
        core: combinedCore,
        base: combinedBase,
        suffix: ''
      });
      pendingPrefix = '';
      i++; // consumed next
      continue;
    }

    rawAtoms.push({
      prefix: pendingPrefix,
      core: u,
      base: curBase,
      suffix: ''
    });
    pendingPrefix = '';
  }

  // If dangling stress/prefix at very end, attach to last atom or keep standalone
  if (pendingPrefix) {
    if (rawAtoms.length > 0) {
      rawAtoms[rawAtoms.length - 1].suffix += pendingPrefix;
    } else {
      rawAtoms.push({ prefix: '', core: pendingPrefix, base: '', suffix: '' });
    }
  }

  return rawAtoms.map((a) => {
    const fullText = a.prefix + a.core + a.suffix;
    const hasAspiration = a.suffix.includes('ʰ') || a.suffix.includes('ʱ') || a.suffix.includes("'");
    const isLong = a.suffix.includes('ː') || a.suffix.includes(':');
    const isHalfLong = a.suffix.includes('ˑ');
    const isStressed = a.prefix.includes('ˈ') || a.prefix.includes('ˌ');
    const cls = classifySingleBase(a.core + a.suffix, a.base, hasAspiration, isLong, isHalfLong);
    return {
      text: fullText,
      base: a.base,
      kind: cls.kind,
      sonority: cls.sonority,
      acousticClass: cls.acousticClass,
      hasAspiration,
      isLong,
      isHalfLong,
      isStressed,
      weight: cls.weight
    };
  });
}

// ---------------------------------------------------------------------------
// Outer Wrapper Unwrapping & Source Resolution
// ---------------------------------------------------------------------------

const ASYMMETRIC_WRAPPERS: ReadonlyArray<readonly [string, string, boolean]> = [
  // [open, close, isPhoneticBracket]
  ['[', ']', true],
  ['⟨', '⟩', true],
  ['(', ')', false],
  ['（', '）', false],
  ['“', '”', false],
  ['‘', '’', false],
  ['「', '」', false],
  ['『', '』', false],
  ['【', '】', false],
  ['《', '》', false]
];

function isBalancedWrapped(text: string, open: string, close: string): boolean {
  if (text.length < 2 || !text.startsWith(open) || !text.endsWith(close)) {
    return false;
  }
  if (open === close) {
    // Symmetric delimiter (e.g. /.../ or "..."): interior must contain NO occurrence
    return !text.slice(open.length, text.length - close.length).includes(open);
  }
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === open) depth++;
    else if (ch === close) depth--;
    if (depth === 0 && i < text.length - 1) {
      return false;
    }
    if (depth < 0) return false;
  }
  return depth === 0;
}

interface UnwrapResult {
  body: string;
  strippedWrapper: boolean;
  strippedPhoneticBracket: boolean;
}

function unwrapOuterPairs(trimmed: string): UnwrapResult {
  let cur = trimmed;
  let strippedWrapper = false;
  let strippedPhoneticBracket = false;

  // Iteratively strip balanced outer pairs (e.g. (/tʰiŋ/) -> tʰiŋ)
  for (let guard = 0; guard < 4; guard++) {
    let changed = false;
    if (isBalancedWrapped(cur, '/', '/')) {
      cur = cur.slice(1, -1).trim();
      strippedWrapper = true;
      strippedPhoneticBracket = true;
      changed = true;
    } else if (isBalancedWrapped(cur, '"', '"')) {
      cur = cur.slice(1, -1).trim();
      strippedWrapper = true;
      changed = true;
    } else {
      for (const [open, close, isPhon] of ASYMMETRIC_WRAPPERS) {
        if (isBalancedWrapped(cur, open, close)) {
          cur = cur.slice(open.length, cur.length - close.length).trim();
          strippedWrapper = true;
          if (isPhon) strippedPhoneticBracket = true;
          changed = true;
          break;
        }
      }
    }
    if (!changed || !cur) break;
  }

  return { body: cur, strippedWrapper, strippedPhoneticBracket };
}

// ---------------------------------------------------------------------------
// Context Tier Hint Inference
// ---------------------------------------------------------------------------

function inferHintFromTierName(tierName?: string): ContextTierHint {
  if (!tierName) return 'NEUTRAL';
  const trimmed = tierName.trim();
  if (!trimmed) return 'NEUTRAL';

  // CJK keyword checks (most specific first)
  if (/声韵|声母|韵母/.test(trimmed)) return 'ONSET_RIME';
  if (/音素|音段/.test(trimmed)) return 'PHONE';
  if (/声调|调值|调类|调/.test(trimmed)) return 'TONE';
  if (/音节|单字|汉字|拼音|拍|字/.test(trimmed)) return 'SYLLABLE';
  if (/词汇|词语|词/.test(trimmed)) return 'WORD';

  // ASCII tokens (handle snake_case, kebab-case, camelCase)
  const camelSplit = trimmed.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const tokens = camelSplit.split(/[^a-z0-9]+/).filter(Boolean);
  const tokenSet = new Set(tokens);

  if (
    tokenSet.has('initial') ||
    tokenSet.has('initials') ||
    tokenSet.has('final') ||
    tokenSet.has('finals') ||
    tokenSet.has('onset') ||
    tokenSet.has('onsets') ||
    tokenSet.has('rime') ||
    tokenSet.has('rimes') ||
    tokenSet.has('rhyme') ||
    tokenSet.has('rhymes')
  ) {
    return 'ONSET_RIME';
  }

  if (
    tokenSet.has('phone') ||
    tokenSet.has('phones') ||
    tokenSet.has('phoneme') ||
    tokenSet.has('phonemes') ||
    tokenSet.has('seg') ||
    tokenSet.has('segs') ||
    tokenSet.has('segment') ||
    tokenSet.has('segments')
  ) {
    return 'PHONE';
  }

  if (
    tokenSet.has('tone') ||
    tokenSet.has('tones') ||
    tokenSet.has('pitch')
  ) {
    return 'TONE';
  }

  if (
    tokenSet.has('syl') ||
    tokenSet.has('syls') ||
    tokenSet.has('syll') ||
    tokenSet.has('syllable') ||
    tokenSet.has('syllables') ||
    tokenSet.has('char') ||
    tokenSet.has('chars') ||
    tokenSet.has('hanzi') ||
    tokenSet.has('zi') ||
    tokenSet.has('pinyin') ||
    tokenSet.has('mora') ||
    tokenSet.has('morae')
  ) {
    return 'SYLLABLE';
  }

  if (
    tokenSet.has('word') ||
    tokenSet.has('words') ||
    tokenSet.has('wd') ||
    tokenSet.has('wds') ||
    tokenSet.has('lex') ||
    tokenSet.has('lexical')
  ) {
    return 'WORD';
  }

  return 'NEUTRAL';
}

function splitTrailingTone(text: string): { core: string; tone: string } {
  const chaoMatch = text.match(TRAILING_CHAO_TONE_RE);
  if (chaoMatch && chaoMatch.index !== undefined && chaoMatch.index > 0) {
    return {
      core: text.slice(0, chaoMatch.index),
      tone: chaoMatch[1]
    };
  }
  const numMatch = text.match(TRAILING_NUMERIC_TONE_RE);
  if (numMatch && numMatch.index !== undefined && numMatch.index > 0) {
    const core = text.slice(0, numMatch.index);
    // Do not strip numeric suffix from alphanumeric codes like F0 or V2 if core is single uppercase letter
    if (!/^[A-Z]$/.test(core)) {
      return {
        core,
        tone: numMatch[1]
      };
    }
  }
  return { core: text, tone: '' };
}

function isSingleCjkCharPeer(text: string): boolean {
  const { body } = unwrapOuterPairs(text.trim());
  if (!body || /\s/.test(body)) return false;
  const cleaned = body.replace(SENTENCE_EDGE_PUNCT_RE, '');
  if (!cleaned) return false;
  const { core } = splitTrailingTone(cleaned);
  const chars = Array.from(core);
  if (chars.length === 1 && CJK_SCRIPT_RE.test(chars[0])) {
    return true;
  }
  // Single Kana mora with small yoon (e.g. しゃ)
  if (chars.length === 2 && KANA_RE.test(chars[0]) && SMALL_YOON_KANA_RE.test(chars[1])) {
    return true;
  }
  return false;
}

function inferHintFromPeers(peerTexts?: readonly string[]): ContextTierHint {
  if (!peerTexts || peerTexts.length === 0) return 'NEUTRAL';

  const valid: string[] = [];
  for (const raw of peerTexts) {
    const t = raw.trim();
    if (!t || SILENCE_PEER_RE.test(t)) continue;
    valid.push(t);
  }
  if (valid.length < 3) return 'NEUTRAL';

  const n = valid.length;
  let singleCjkCount = 0;
  let singlePhoneCount = 0;
  let pureConsonantCount = 0;
  let vowelBearingCount = 0;
  let toneOnlyCount = 0;
  const roles: Array<'C' | 'V' | 'O'> = [];

  for (const p of valid) {
    if (isSingleCjkCharPeer(p)) {
      singleCjkCount++;
      roles.push('O');
      continue;
    }
    const { body } = unwrapOuterPairs(p);
    if (!body || /\s/.test(body) || CJK_SCRIPT_RE.test(body)) {
      roles.push('O');
      continue;
    }
    if (PURE_TONE_TEXT_RE.test(body)) {
      toneOnlyCount++;
      roles.push('O');
      continue;
    }
    const { core, tone } = splitTrailingTone(body);
    const atoms = tokenizeIpaAtoms(core);
    if (atoms.length === 0) {
      roles.push('O');
      continue;
    }
    const hasVowel = atoms.some((a) => a.kind === 'vowel');
    const allCons = atoms.every((a) => a.kind === 'consonant' || a.kind === 'glide');

    if (atoms.length === 1 && (atoms[0].kind === 'consonant' || atoms[0].kind === 'vowel' || atoms[0].kind === 'glide')) {
      singlePhoneCount++;
    }
    if (allCons && !tone) {
      pureConsonantCount++;
      roles.push('C');
    } else if (hasVowel || tone) {
      vowelBearingCount++;
      roles.push('V');
    } else {
      roles.push('O');
    }
  }

  if (singleCjkCount / n >= 0.8) return 'SYLLABLE';
  if (toneOnlyCount / n >= 0.8) return 'TONE';

  // Check ONSET_RIME before PHONE when peers have multi-phone rimes (e.g. tɕʰ, yən˥, m, iɛn˧˥)
  const consRatio = pureConsonantCount / n;
  const vowelRatio = vowelBearingCount / n;
  if (consRatio >= 0.35 && consRatio <= 0.55 && vowelRatio >= 0.35) {
    let alternations = 0;
    let comparablePairs = 0;
    for (let i = 0; i < roles.length - 1; i++) {
      if (roles[i] !== 'O' && roles[i + 1] !== 'O') {
        comparablePairs++;
        if (roles[i] !== roles[i + 1]) {
          alternations++;
        }
      }
    }
    // Check that at least some vowel-bearing peers are multi-phone rimes or carry tone,
    // so simple alternating C-V-C-V single-phone tiers aren't misclassified unless truly onset-rime
    let complexRimeCount = 0;
    for (const p of valid) {
      const { body } = unwrapOuterPairs(p);
      const { core, tone } = splitTrailingTone(body);
      const atoms = tokenizeIpaAtoms(core);
      if (atoms.some((a) => a.kind === 'vowel') && (atoms.length >= 2 || tone.length > 0)) {
        complexRimeCount++;
      }
    }
    if (
      comparablePairs > 0 &&
      alternations / comparablePairs >= 0.5 &&
      (complexRimeCount > 0 || singlePhoneCount / n < 0.8)
    ) {
      return 'ONSET_RIME';
    }
  }

  if (singlePhoneCount / n >= 0.8) return 'PHONE';

  return 'NEUTRAL';
}

function inferContextHint(ctx?: SmartSplitContext): ContextTierHint {
  const fromName = inferHintFromTierName(ctx?.tierName);
  if (fromName !== 'NEUTRAL') return fromName;
  return inferHintFromPeers(ctx?.peerTexts);
}

// ---------------------------------------------------------------------------
// Candidate Builders & Formatting Helpers
// ---------------------------------------------------------------------------

function formatMenuLabel(strategyLabel: string, texts: readonly string[]): string {
  const count = texts.length;
  const preview = texts.join(' · ');
  if (count <= 4 && preview.length <= 18) {
    return `智能拆分：${strategyLabel}（${count} 段：${preview}）`;
  }
  return `智能拆分：${strategyLabel}（${count} 段）`;
}

function formatSwitchLabel(strategyLabel: string, count: number): string {
  const keepPrefix =
    strategyLabel === '按空格' ||
    strategyLabel === '按拍' ||
    strategyLabel === '按斜杠' ||
    strategyLabel === '按竖线' ||
    strategyLabel === '按逗号' ||
    strategyLabel === '按顿号' ||
    strategyLabel === '按分号' ||
    strategyLabel === '按连字符' ||
    strategyLabel === '按制表符' ||
    strategyLabel === '按双冒号' ||
    strategyLabel === '按双斜杠';
  if (keepPrefix) {
    return `改为${strategyLabel} ${count} 段`;
  }
  const stem = strategyLabel.startsWith('按') ? strategyLabel.slice(1) : strategyLabel;
  return `改为${stem} ${count} 段`;
}

function estimateSegmentWeightAndClass(
  text: string,
  granularity: SmartSplitGranularity
): { weight: number; acousticClass: AcousticSegmentClass } {
  const trimmed = text.trim();
  if (!trimmed) return { weight: 1.0, acousticClass: 'other' };

  if (PURE_TONE_TEXT_RE.test(trimmed)) {
    return { weight: 0.65, acousticClass: 'other' };
  }
  if (PUNCT_UNIT_RE.test(trimmed)) {
    return { weight: 0.35, acousticClass: 'other' };
  }

  if (CJK_SCRIPT_RE.test(trimmed)) {
    const cleaned = trimmed.replace(SENTENCE_EDGE_PUNCT_RE, '');
    const { core } = splitTrailingTone(cleaned);
    const chars = Array.from(core);
    if (chars.length <= 1) {
      return { weight: 1.0, acousticClass: 'syllable' };
    }
    // Hangul single jamo
    if (chars.length === 1 && /[\u3131-\u3163]/.test(chars[0])) {
      return { weight: 0.85, acousticClass: 'other' };
    }
    return { weight: Math.max(1.0, chars.length), acousticClass: 'syllable' };
  }

  // Hangul compatibility Jamo
  if (/^[\u3131-\u314E]$/.test(trimmed)) {
    const voicelessJamo = new Set(['ㄱ', 'ㄲ', 'ㄷ', 'ㄸ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']);
    const nasalLiquidJamo = new Set(['ㄴ', 'ㄹ', 'ㅁ', 'ㅇ']);
    return {
      weight: voicelessJamo.has(trimmed) ? 0.85 : 0.95,
      acousticClass: voicelessJamo.has(trimmed)
        ? 'voiceless-obs'
        : nasalLiquidJamo.has(trimmed)
          ? 'nasal-liquid'
          : 'voiced-obs'
    };
  }
  if (/^[\u314F-\u3163]$/.test(trimmed)) {
    return { weight: 1.4, acousticClass: 'vowel' };
  }

  const { body } = unwrapOuterPairs(trimmed);
  const { core } = splitTrailingTone(body);
  const atoms = tokenizeIpaAtoms(core);

  if (atoms.length === 0) {
    return { weight: Math.max(0.8, Math.min(2.5, trimmed.length * 0.45)), acousticClass: 'other' };
  }

  const totalWeight = atoms.reduce((sum, a) => sum + a.weight, 0);

  if (granularity === 'phone' || atoms.length === 1) {
    return {
      weight: Number(Math.max(0.4, totalWeight).toFixed(2)),
      acousticClass: atoms[0].acousticClass
    };
  }

  if (granularity === 'onset-rime') {
    const first = atoms[0];
    const hasVowel = atoms.some((a) => a.kind === 'vowel');
    const acousticClass: AcousticSegmentClass =
      first.kind === 'vowel'
        ? 'vowel'
        : hasVowel && first.kind === 'glide'
          ? 'vowel'
          : first.acousticClass;
    return {
      weight: Number(Math.max(0.5, totalWeight).toFixed(2)),
      acousticClass
    };
  }

  return {
    weight: Number(Math.max(0.6, totalWeight).toFixed(2)),
    acousticClass: 'syllable'
  };
}

function makeCandidate(params: {
  id: string;
  strategyLabel: string;
  granularity: SmartSplitGranularity;
  texts: string[];
  confidence: number;
  reason: string;
  weightsOverride?: number[];
  classesOverride?: AcousticSegmentClass[];
}): SmartSplitCandidate | null {
  if (params.texts.length < 2) return null;
  const durationWeights: number[] = [];
  const acousticClasses: AcousticSegmentClass[] = [];

  if (
    params.weightsOverride &&
    params.classesOverride &&
    params.weightsOverride.length === params.texts.length &&
    params.classesOverride.length === params.texts.length
  ) {
    for (let i = 0; i < params.texts.length; i++) {
      durationWeights.push(params.weightsOverride[i]);
      acousticClasses.push(params.classesOverride[i]);
    }
  } else {
    for (const seg of params.texts) {
      const est = estimateSegmentWeightAndClass(seg, params.granularity);
      durationWeights.push(est.weight);
      acousticClasses.push(est.acousticClass);
    }
  }

  return {
    id: params.id,
    strategyLabel: params.strategyLabel,
    menuLabel: formatMenuLabel(params.strategyLabel, params.texts),
    switchLabel: formatSwitchLabel(params.strategyLabel, params.texts.length),
    granularity: params.granularity,
    texts: params.texts,
    durationWeights,
    acousticClasses,
    confidence: Math.max(0, Math.min(1, Number(params.confidence.toFixed(2)))),
    reason: params.reason
  };
}

function buildPlan(
  sourceText: string,
  usedDecodedPraat: boolean,
  contextHint: ContextTierHint,
  candidates: Array<SmartSplitCandidate | null>
): SmartSplitPlan {
  const unique: SmartSplitCandidate[] = [];
  const seenKey = new Set<string>();

  for (const c of candidates) {
    if (!c || c.texts.length < 2) continue;
    const key = c.texts.join('\u0000');
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    unique.push(c);
  }

  if (unique.length === 0) {
    return {
      sourceText,
      usedDecodedPraat,
      contextHint,
      primary: null,
      alternatives: []
    };
  }

  return {
    sourceText,
    usedDecodedPraat,
    contextHint,
    primary: unique[0],
    alternatives: unique.slice(1)
  };
}

// ---------------------------------------------------------------------------
// Stage 1: Explicit Structural Delimiters vs Natural Sentence Punctuation
// ---------------------------------------------------------------------------

const SANDHI_PLACEHOLDER = '\uE001';

function maskToneSandhiSlash(text: string): string {
  // Mask '/' between tone digits or Chao tone letters attached to a preceding non-empty base
  // e.g. 马214/35, tɕʰyən35/55, ma55/21, 妈˥/˧˥
  return text
    .replace(
      /([^\s/\d][0-5]{1,3})\/([0-5]{1,3})(?=$|[^\d/])/g,
      `$1${SANDHI_PLACEHOLDER}$2`
    )
    .replace(
      /([^\s/˥˦˧˨˩][˥˦˧˨˩]+)\/([˥˦˧˨˩]+)(?=$|[^˥˦˧˨˩/])/g,
      `$1${SANDHI_PLACEHOLDER}$2`
    );
}

function maskToneSandhiHyphen(text: string): string {
  // Mask '-' between tone digits or Chao tone letters (e.g. ma55-21, 55-21, ˥-˨˩)
  return text
    .replace(/([0-5]{1,3})-([0-5]{1,3})(?=$|[^\d-])/g, `$1${SANDHI_PLACEHOLDER}$2`)
    .replace(/([˥˦˧˨˩]+)-([˥˦˧˨˩]+)(?=$|[^˥˦˧˨˩-])/g, `$1${SANDHI_PLACEHOLDER}$2`);
}

function isPhoneticTokenList(tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  let phoneticCount = 0;
  for (const t of tokens) {
    if (CJK_SCRIPT_RE.test(t)) return false;
    const { body } = unwrapOuterPairs(t);
    if (!body) continue;
    if (IPA_DISTINCTIVE_RE.test(body)) {
      phoneticCount++;
    }
  }
  if (phoneticCount > 0) return true;
  // Also recognize short ASCII IPA syllables like 'ba da ga' when every token is short lowercase letters
  return tokens.every((t) => {
    const { body } = unwrapOuterPairs(t);
    return /^[a-z0-5'ː:]+$/.test(body) && body.length <= 6;
  });
}

function splitTokensIntoPhones(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (const tok of tokens) {
    const { body } = unwrapOuterPairs(tok);
    const { core, tone } = splitTrailingTone(body);
    const atoms = tokenizeIpaAtoms(core);
    if (atoms.length === 0) {
      if (body) out.push(body);
      continue;
    }
    const parts = atoms.map((a) => a.text);
    if (tone) {
      parts[parts.length - 1] += tone;
    }
    out.push(...parts);
  }
  return out;
}

function tryStage1Delimiters(
  trimmed: string,
  unwrapped: UnwrapResult,
  contextHint: ContextTierHint,
  ctx?: SmartSplitContext
): SmartSplitCandidate[] | null {
  const body = unwrapped.body;

  // 1a. Strong explicit delimiters: | ｜ ‖ :: // \t \n
  const strongRules: ReadonlyArray<{
    id: string;
    label: string;
    re: RegExp;
    reason: string;
  }> = [
    { id: 'delimiter-pipe', label: '按竖线', re: /[|｜‖]+/, reason: '检测到显式竖线分隔符' },
    { id: 'delimiter-double-colon', label: '按双冒号', re: /::+/, reason: '检测到显式双冒号分隔符' },
    { id: 'delimiter-double-slash', label: '按双斜杠', re: /\/\/+/, reason: '检测到显式双斜杠分隔符' },
    { id: 'delimiter-tab', label: '按制表符', re: /\t+/, reason: '检测到显式制表符分隔' },
    { id: 'delimiter-newline', label: '按换行', re: /\r?\n+/, reason: '检测到显式换行分隔' }
  ];

  for (const rule of strongRules) {
    if (rule.re.test(body)) {
      const parts = body
        .split(rule.re)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length >= 2) {
        const primary = makeCandidate({
          id: rule.id,
          strategyLabel: rule.label,
          granularity: 'delimiter',
          texts: parts,
          confidence: 0.98,
          reason: rule.reason
        });
        const list: SmartSplitCandidate[] = [];
        if (primary) list.push(primary);
        if (isPhoneticTokenList(parts)) {
          const phones = splitTokensIntoPhones(parts);
          if (phones.length > parts.length) {
            const altPhone = makeCandidate({
              id: 'phone-from-delim',
              strategyLabel: '按音素',
              granularity: 'phone',
              texts: phones,
              confidence: 0.72,
              reason: '按原子音素进一步切分'
            });
            if (altPhone) list.push(altPhone);
          }
        }
        return list;
      }
    }
  }

  // 1b. Internal slash '/' (excluding wrapped whitespace tokens like '/p/ /t/ /k/' and tone sandhi like '马214/35')
  const wsPartsRaw = body.split(/\s+/).filter(Boolean);
  const allWrappedSlashTokens =
    wsPartsRaw.length >= 2 && wsPartsRaw.every((tok) => /^\/[^/\s]+\/$/.test(tok));

  if (!allWrappedSlashTokens && /[/／]/.test(body)) {
    const masked = maskToneSandhiSlash(body);
    if (/[/／]/.test(masked)) {
      const parts = masked
        .split(/[/／]+/)
        .map((s) => s.replaceAll(SANDHI_PLACEHOLDER, '/').trim())
        .filter(Boolean);
      if (parts.length >= 2) {
        const primary = makeCandidate({
          id: 'delimiter-slash',
          strategyLabel: '按斜杠',
          granularity: 'delimiter',
          texts: parts,
          confidence: 0.95,
          reason: '检测到内部斜杠分隔符'
        });
        return primary ? [primary] : null;
      }
    }
  }

  // 1c. Internal whitespace (including fullwidth space \u3000)
  if (wsPartsRaw.length >= 2) {
    const punctPref = ctx?.punctuationPreference ?? 'ignore';
    const isPhonetic = isPhoneticTokenList(wsPartsRaw);
    const hasCjk = wsPartsRaw.some((t) => CJK_SCRIPT_RE.test(t));

    // Preserve phonemic slashes (/p/ /t/ /k/) and phonetic brackets ([p] [t] [k])
    let wsTokens = wsPartsRaw;
    if (punctPref === 'ignore' && !allWrappedSlashTokens && !isPhonetic) {
      const stripped = wsPartsRaw
        .map((t) => t.replace(SENTENCE_EDGE_PUNCT_RE, '').trim())
        .filter(Boolean);
      if (stripped.length >= 2) {
        wsTokens = stripped;
      }
    }

    const wsGranularity: SmartSplitGranularity = isPhonetic
      ? 'syllable'
      : hasCjk
        ? 'delimiter'
        : 'word';
    const wsCand = makeCandidate({
      id: 'delimiter-space',
      strategyLabel: '按空格',
      granularity: wsGranularity,
      texts: wsTokens,
      confidence: 0.93,
      reason: isPhonetic ? '按空格切分音节或词项' : '检测到内部空格分隔'
    });

    const alts: SmartSplitCandidate[] = [];

    // Context PHONE + whitespace-separated IPA -> penetrate into atomic phones as primary!
    if (isPhonetic) {
      const phones = splitTokensIntoPhones(wsPartsRaw);
      if (phones.length > wsTokens.length) {
        const phoneCand = makeCandidate({
          id: 'phone-penetrate',
          strategyLabel: '按音素',
          granularity: 'phone',
          texts: phones,
          confidence: contextHint === 'PHONE' ? 0.95 : 0.78,
          reason:
            contextHint === 'PHONE'
              ? '当前层上下文指向音素级，穿透空格逐音素切分'
              : '逐原子音素进一步细分'
        });
        if (contextHint === 'PHONE' && phoneCand && wsCand) {
          return [phoneCand, wsCand];
        }
        if (phoneCand) alts.push(phoneCand);
      }
    }

    if (hasCjk) {
      const cjkChars = tokenizeCjkUnits(body, punctPref);
      if (cjkChars.length > wsTokens.length) {
        const charCand = makeCandidate({
          id: 'cjk-char-alt',
          strategyLabel: '按单字',
          granularity: 'syllable',
          texts: cjkChars,
          confidence: 0.76,
          reason: '按单字进一步切分'
        });
        if (charCand) alts.push(charCand);
      }
    }

    // If edge punctuation was stripped on non-phonetic tokens, offer keeping original tokens
    if (wsTokens !== wsPartsRaw) {
      const keepPunctCand = makeCandidate({
        id: 'delimiter-space-punct',
        strategyLabel: '保留标点',
        granularity: wsGranularity,
        texts: wsPartsRaw,
        confidence: 0.7,
        reason: '按空格切分并保留词尾标点'
      });
      if (keepPunctCand) alts.push(keepPunctCand);
    }

    return wsCand ? [wsCand, ...alts] : null;
  }

  // 1d. Enumeration delimiters: 、 ; ； , ，
  // Only treat as structural delimiter when there is no sentence-ending punctuation
  // and segments are short and balanced (prevents splitting '春眠不觉晓，处处闻啼鸟。' into 2 parts).
  const enumRules: ReadonlyArray<{
    id: string;
    label: string;
    re: RegExp;
    strictShort: boolean;
    reason: string;
  }> = [
    { id: 'delimiter-enum-comma', label: '按顿号', re: /、+/, strictShort: false, reason: '检测到并列顿号分隔' },
    { id: 'delimiter-semicolon', label: '按分号', re: /[;；]+/, strictShort: true, reason: '检测到结构分号分隔' },
    { id: 'delimiter-comma', label: '按逗号', re: /[,，]+/, strictShort: true, reason: '检测到短项逗号枚举分隔' }
  ];

  for (const rule of enumRules) {
    if (!rule.re.test(body)) continue;
    const parts = body
      .split(rule.re)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length < 2) continue;

    if (rule.strictShort) {
      if (SENTENCE_END_PUNCT_RE.test(body)) continue;
      const lengths = parts.map((p) => Array.from(p).length);
      const maxLen = Math.max(...lengths);
      const minLen = Math.min(...lengths);
      const hasCjkPart = parts.some((p) => CJK_SCRIPT_RE.test(p));
      const maxAllowed = hasCjkPart ? 4 : 12;
      if (maxLen > maxAllowed) continue;
      if (maxLen / Math.max(1, minLen) > 3) continue;
      // Non-CJK items shouldn't contain internal spaces
      if (!hasCjkPart && parts.some((p) => /\s/.test(p))) continue;
    }

    const cand = makeCandidate({
      id: rule.id,
      strategyLabel: rule.label,
      granularity: 'delimiter',
      texts: parts,
      confidence: rule.strictShort ? 0.88 : 0.94,
      reason: rule.reason
    });
    return cand ? [cand] : null;
  }

  // 1e. Symmetric hyphen (e.g. ba-da-ga, tɕʰ-yən˥), protecting tone sandhi hyphens (55-21)
  if (/[-–—]/.test(body)) {
    const masked = maskToneSandhiHyphen(body);
    if (/[-–—]/.test(masked)) {
      const parts = masked
        .split(/[-–—]+/)
        .map((s) => s.replaceAll(SANDHI_PLACEHOLDER, '-').trim())
        .filter(Boolean);
      if (parts.length >= 2) {
        const cand = makeCandidate({
          id: 'delimiter-hyphen',
          strategyLabel: '按连字符',
          granularity: 'delimiter',
          texts: parts,
          confidence: 0.9,
          reason: '检测到连字符分段'
        });
        return cand ? [cand] : null;
      }
    }
  }

  // Unused parameter guard
  void trimmed;
  return null;
}

// ---------------------------------------------------------------------------
// Stage 2: CJK & Mixed-Script Segmentation (Hanzi, Kana Mora, Hangul)
// ---------------------------------------------------------------------------

function tokenizeJapaneseMora(text: string, punctPref: 'ignore' | 'attach-prev' | 'keep'): string[] {
  const chars = Array.from(text);
  const raw: string[] = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!ch || /^\s+$/.test(ch)) continue;
    if (
      SMALL_YOON_KANA_RE.test(ch) &&
      raw.length > 0 &&
      KANA_RE.test(raw[raw.length - 1]) &&
      !PUNCT_UNIT_RE.test(raw[raw.length - 1])
    ) {
      raw[raw.length - 1] += ch;
    } else {
      raw.push(ch);
    }
  }

  return applyPunctuationMode(raw, punctPref);
}

function applyPunctuationMode(
  units: readonly string[],
  mode: 'ignore' | 'attach-prev' | 'keep'
): string[] {
  if (mode === 'keep') return [...units];
  if (mode === 'ignore') {
    return units.filter((u) => !PUNCT_UNIT_RE.test(u));
  }
  const out: string[] = [];
  let pendingLeading = '';
  for (const u of units) {
    if (PUNCT_UNIT_RE.test(u)) {
      if (out.length > 0) {
        out[out.length - 1] += u;
      } else {
        pendingLeading += u;
      }
    } else {
      out.push(pendingLeading ? pendingLeading + u : u);
      pendingLeading = '';
    }
  }
  if (pendingLeading && out.length > 0) {
    out[out.length - 1] += pendingLeading;
  }
  return out;
}

function isToneSuffixAt(
  chars: readonly string[],
  digitStart: number,
  digitEnd: number,
  prevUnit: string
): boolean {
  if (!prevUnit || !HANZI_RE.test(prevUnit)) return false;
  const digitStr = chars.slice(digitStart, digitEnd).join('');
  if (!NUMERIC_TONE_SEQ_RE.test(digitStr)) return false;

  const prevHanzi = Array.from(prevUnit)[0] ?? '';
  const nextChar = digitEnd < chars.length ? chars[digitEnd] : '';

  // Explicit ordinal/quantifier prefix like 第1声, 共3段, 分4层
  if (HANZI_ORDINAL_PREFIX.has(prevHanzi)) {
    return false;
  }

  // Single digit followed by a measure/counter word (e.g. 买3个, 等2秒) is a numeral, not tone
  if (digitStr.length === 1 && nextChar && HANZI_MEASURE_AFTER_NUM.has(nextChar)) {
    return false;
  }

  return true;
}

function tokenizeCjkUnits(
  text: string,
  punctPref: 'ignore' | 'attach-prev' | 'keep'
): string[] {
  const chars = Array.from(text);
  const units: string[] = [];

  for (let i = 0; i < chars.length; ) {
    const ch = chars[i];
    if (!ch || /^\s+$/.test(ch)) {
      i++;
      continue;
    }

    // Punctuation unit
    if (PUNCT_UNIT_RE.test(ch)) {
      units.push(ch);
      i++;
      continue;
    }

    // Chao tone letters attach to preceding Hanzi/unit
    if (CHAO_TONE_CHAR_RE.test(ch)) {
      let j = i;
      while (
        j < chars.length &&
        (CHAO_TONE_CHAR_RE.test(chars[j]) ||
          ((chars[j] === '/' || chars[j] === '-') &&
            j + 1 < chars.length &&
            CHAO_TONE_CHAR_RE.test(chars[j + 1])))
      ) {
        j++;
      }
      const toneStr = chars.slice(i, j).join('');
      if (units.length > 0 && !PUNCT_UNIT_RE.test(units[units.length - 1])) {
        units[units.length - 1] += toneStr;
      } else {
        units.push(toneStr);
      }
      i = j;
      continue;
    }

    // Hanzi or Hangul syllable stands alone
    if (HANZI_RE.test(ch) || HANGUL_SYLLABLE_RE.test(ch)) {
      units.push(ch);
      i++;
      continue;
    }

    // Kana follows mora rule (small yoon attaches left)
    if (KANA_RE.test(ch)) {
      if (
        SMALL_YOON_KANA_RE.test(ch) &&
        units.length > 0 &&
        KANA_RE.test(units[units.length - 1])
      ) {
        units[units.length - 1] += ch;
      } else {
        units.push(ch);
      }
      i++;
      continue;
    }

    // Digits: could be tone suffix on preceding Hanzi (马35, 马214/35, 妈55麻35) OR standalone number (第1声, 2025年)
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (
        j < chars.length &&
        (/[0-9]/.test(chars[j]) ||
          ((chars[j] === '/' || chars[j] === '-' || chars[j] === '.') &&
            j + 1 < chars.length &&
            /[0-9]/.test(chars[j + 1])))
      ) {
        j++;
      }
      const numStr = chars.slice(i, j).join('');
      if (
        units.length > 0 &&
        isToneSuffixAt(chars, i, j, units[units.length - 1])
      ) {
        units[units.length - 1] += numStr;
      } else {
        units.push(numStr);
      }
      i = j;
      continue;
    }

    // Latin word / alphanumeric code chunk (e.g. VOT, F0, IPA, Hz)
    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < chars.length && /[A-Za-z0-9_']/.test(chars[j])) {
        j++;
      }
      units.push(chars.slice(i, j).join(''));
      i = j;
      continue;
    }

    // Any other symbol
    units.push(ch);
    i++;
  }

  return applyPunctuationMode(units, punctPref);
}

function decomposeSingleHangul(ch: string): string[] | null {
  const code = ch.charCodeAt(0);
  if (code < 0xAC00 || code > 0xD7A3) return null;
  const offset = code - 0xAC00;
  const l = Math.floor(offset / 588);
  const v = Math.floor((offset % 588) / 28);
  const t = offset % 28;
  const out = [HANGUL_L[l], HANGUL_V[v]];
  if (t > 0) out.push(HANGUL_T[t]);
  return out;
}

function mergeErhua(units: readonly string[]): string[] | null {
  const out: string[] = [];
  let merged = false;
  for (let i = 0; i < units.length; i++) {
    const cur = units[i];
    if (
      cur === '儿' &&
      out.length > 0 &&
      HANZI_RE.test(out[out.length - 1]) &&
      out[out.length - 1] !== '儿'
    ) {
      out[out.length - 1] += cur;
      merged = true;
    } else {
      out.push(cur);
    }
  }
  return merged && out.length >= 2 ? out : null;
}

function tryStage2Cjk(
  trimmed: string,
  unwrapped: UnwrapResult,
  ctx?: SmartSplitContext
): SmartSplitCandidate[] | null {
  const body = unwrapped.body;
  if (!CJK_SCRIPT_RE.test(body)) return null;

  const punctPref = ctx?.punctuationPreference ?? 'ignore';
  // For attach-prev / keep, preserve outer quotes/parens if they weren't phonetic brackets
  const workingText =
    punctPref !== 'ignore' && !unwrapped.strippedPhoneticBracket ? trimmed : body;

  const hasHanzi = HANZI_RE.test(workingText);
  const hasHangul = HANGUL_ANY_RE.test(workingText);
  const hasKana = KANA_RE.test(workingText);

  // Pure Kana -> Japanese Mora splitting
  if (hasKana && !hasHanzi && !hasHangul) {
    const morae = tokenizeJapaneseMora(workingText, punctPref);
    if (morae.length >= 2) {
      const cand = makeCandidate({
        id: 'kana-mora',
        strategyLabel: '按拍',
        granularity: 'syllable',
        texts: morae,
        confidence: 0.93,
        reason: '日文假名按拍切分，拗音小假名左粘连，促音拨音长音独立'
      });
      return cand ? [cand] : null;
    }
    return [];
  }

  // Pure Hangul
  if (hasHangul && !hasHanzi && !hasKana) {
    const syls = tokenizeCjkUnits(workingText, punctPref);
    if (syls.length >= 2) {
      const cand = makeCandidate({
        id: 'hangul-syllable',
        strategyLabel: '按音节',
        granularity: 'syllable',
        texts: syls,
        confidence: 0.94,
        reason: '韩文谚文按音节块切分'
      });
      return cand ? [cand] : null;
    }
    // N=1 Hangul drilldown into Jamo (e.g. 한 -> ㅎ | ㅏ | ㄴ)
    if (syls.length === 1 && Array.from(syls[0]).length === 1) {
      const jamo = decomposeSingleHangul(syls[0]);
      if (jamo && jamo.length >= 2) {
        const cand = makeCandidate({
          id: 'hangul-jamo',
          strategyLabel: '按字母',
          granularity: 'phone',
          texts: jamo,
          confidence: 0.9,
          reason: '单韩文音节自动下钻拆分为初声、中声与终声'
        });
        return cand ? [cand] : null;
      }
    }
    return [];
  }

  // Hanzi & mixed Hanzi+Latin/Kana
  const units = tokenizeCjkUnits(workingText, punctPref);

  // N=1 auto drilldown: single Hanzi with tone suffix (e.g. 马35 -> 马 | 35, 马214/35 -> 马 | 214/35)
  if (units.length === 1) {
    const single = units[0];
    const { core, tone } = splitTrailingTone(single);
    if (core && tone) {
      const cand = makeCandidate({
        id: 'cjk-tone-drilldown',
        strategyLabel: '分离声调',
        granularity: 'tone-split',
        texts: [core, tone],
        confidence: 0.88,
        reason: '单字带调值自动下钻拆分为汉字与调值'
      });
      return cand ? [cand] : null;
    }
    return [];
  }

  if (units.length < 2) return [];

  const primary = makeCandidate({
    id: 'cjk-char',
    strategyLabel: '按单字',
    granularity: 'syllable',
    texts: units,
    confidence: 0.94,
    reason: '汉字按单字切分并凝聚夹杂的拉丁词块与调值'
  });

  const results: SmartSplitCandidate[] = [];
  if (primary) results.push(primary);

  // Alternative 1: Clause split when text contains sentence/clause punctuation
  if (/[，,；;。！？!?]/.test(body)) {
    const clauses = body
      .split(/[，,；;。！？!?]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (clauses.length >= 2 && clauses.length < units.length) {
      const hasCommaOnly = /[，,]/.test(body) && !/[；;]/.test(body);
      const clauseCand = makeCandidate({
        id: 'cjk-clause',
        strategyLabel: hasCommaOnly ? '按逗号分句' : '按标点分句',
        granularity: 'delimiter',
        texts: clauses,
        confidence: 0.78,
        reason: '按句内标点切分为短句'
      });
      if (clauseCand) results.push(clauseCand);
    }
  }

  // Alternative 2: Attach punctuation to previous character when punctuation was dropped
  if (punctPref === 'ignore' && /\p{P}/u.test(workingText)) {
    const attached = tokenizeCjkUnits(trimmed, 'attach-prev');
    if (attached.length >= 2 && attached.join('\u0000') !== units.join('\u0000')) {
      const attachCand = makeCandidate({
        id: 'cjk-attach-prev',
        strategyLabel: '标点并入前段',
        granularity: 'syllable',
        texts: attached,
        confidence: 0.74,
        reason: '保留标点并附着至前一单字'
      });
      if (attachCand) results.push(attachCand);
    }
  }

  // Alternative 3: Merge Erhua (儿化) when applicable and still >= 2 segments
  const erhuaMerged = mergeErhua(units);
  if (erhuaMerged) {
    const erhuaCand = makeCandidate({
      id: 'cjk-erhua',
      strategyLabel: '合并儿化',
      granularity: 'syllable',
      texts: erhuaMerged,
      confidence: 0.72,
      reason: '将儿化音节合并为单个区间'
    });
    if (erhuaCand) results.push(erhuaCand);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Stage 3: Tone-Anchored Polysyllabic Strings & Continuous Pinyin
// ---------------------------------------------------------------------------

function splitByToneAnchors(text: string): string[] | null {
  // Match either Chao tone clusters or numeric tone clusters (including sandhi 214/35 or 55-21)
  const toneRe = /[˥˦˧˨˩]+(?:[-/][˥˦˧˨˩]+)?|[0-5]{1,3}(?:[-/][0-5]{1,3})?/g;
  const matches: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = toneRe.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length });
  }

  if (matches.length === 0) return null;

  // Must either have >= 2 tone groups, or 1 internal tone group followed by a valid trailing syllable
  const hasTrailingAfterSingle =
    matches.length === 1 &&
    matches[0].start > 0 &&
    matches[0].end < text.length &&
    tokenizeIpaAtoms(text.slice(matches[0].end)).some((a) => a.kind === 'vowel');

  if (matches.length < 2 && !hasTrailingAfterSingle) {
    return null;
  }

  const segments: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start <= cursor) {
      // Tone without preceding phonetic body: invalid as tone-anchored syllable stream
      return null;
    }
    const seg = text.slice(cursor, match.end);
    segments.push(seg);
    cursor = match.end;
  }

  if (cursor < text.length) {
    const tail = text.slice(cursor);
    if (tail.trim()) {
      segments.push(tail);
    }
  }

  return segments.length >= 2 ? segments : null;
}

function splitSyllablesIntoOnsetRime(syllables: readonly string[]): string[] | null {
  const out: string[] = [];
  let anySplit = false;
  for (const syl of syllables) {
    const { core, tone } = splitTrailingTone(syl);
    const atoms = tokenizeIpaAtoms(core);
    const firstVowel = atoms.findIndex((a) => a.kind === 'vowel');
    if (firstVowel > 0) {
      let splitIdx = firstVowel;
      if (splitIdx >= 2 && atoms[splitIdx - 1].kind === 'glide' && tone.length > 0) {
        splitIdx--;
      }
      const onset = atoms
        .slice(0, splitIdx)
        .map((a) => a.text)
        .join('');
      const rime =
        atoms
          .slice(splitIdx)
          .map((a) => a.text)
          .join('') + tone;
      out.push(onset, rime);
      anySplit = true;
    } else {
      out.push(syl);
    }
  }
  return anySplit && out.length > syllables.length ? out : null;
}

function normalizePinyinText(text: string): { norm: string; hasToneMark: boolean } | null {
  // Reject any distinctive IPA symbols or digits
  if (IPA_DISTINCTIVE_RE.test(text) || /[0-9]/.test(text)) return null;
  let norm = '';
  let hasToneMark = false;
  for (const ch of text) {
    if (ch in PINYIN_TONE_CHAR_MAP) {
      norm += PINYIN_TONE_CHAR_MAP[ch];
      hasToneMark = true;
    } else if (/^[a-zA-Z]$/.test(ch)) {
      norm += ch.toLowerCase();
    } else {
      return null;
    }
  }
  return { norm, hasToneMark };
}

function segmentSinglePinyinChunk(original: string, norm: string): string[] | null {
  const n = norm.length;
  if (n === 0) return null;

  // Backward DP for shortest path (minimum syllable count).
  // Tie-breaking: prefer earlier split when next syllable starts with a consonant (Maximal Onset / Pinyin orthography: fangan -> fan + gan).
  const INF = 1e9;
  const dp = new Array<number>(n + 1).fill(INF);
  const nextIdx = new Array<number>(n + 1).fill(-1);
  dp[n] = 0;

  for (let i = n - 1; i >= 0; i--) {
    const maxLen = Math.min(6, n - i);
    for (let len = 1; len <= maxLen; len++) {
      const sub = norm.slice(i, i + len);
      if (!PINYIN_SYLLABLES.has(sub)) continue;
      const candCost = 1 + dp[i + len];
      if (candCost < dp[i]) {
        dp[i] = candCost;
        nextIdx[i] = i + len;
      } else if (candCost === dp[i] && nextIdx[i] !== -1) {
        // Tie-breaker: prefer split where the following syllable starts with a consonant rather than bare vowel (a/e/o)
        const curNextChar = norm[nextIdx[i]] ?? '';
        const newNextChar = norm[i + len] ?? '';
        const curIsVowelStart = /^[aeo]/.test(curNextChar);
        const newIsVowelStart = /^[aeo]/.test(newNextChar);
        if (curIsVowelStart && !newIsVowelStart) {
          nextIdx[i] = i + len;
        }
      }
    }
  }

  if (dp[0] >= INF) return null;

  const origChars = Array.from(original);
  const out: string[] = [];
  let pos = 0;
  while (pos < n) {
    const end = nextIdx[pos];
    if (end <= pos) return null;
    out.push(origChars.slice(pos, end).join(''));
    pos = end;
  }
  return out;
}

function segmentContinuousPinyin(text: string): { syllables: string[]; hasToneMark: boolean } | null {
  if (text.length < 2) return null;
  // Support apostrophe-separated pinyin (e.g. xi'an, tian'anmen)
  if (text.includes("'")) {
    const chunks = text.split("'");
    if (chunks.some((c) => !c)) return null;
    const allSyls: string[] = [];
    let anyTone = false;
    for (const chunk of chunks) {
      const res = normalizePinyinText(chunk);
      if (!res) return null;
      if (res.hasToneMark) anyTone = true;
      const segs = segmentSinglePinyinChunk(chunk, res.norm);
      if (!segs) return null;
      allSyls.push(...segs);
    }
    return allSyls.length >= 2 ? { syllables: allSyls, hasToneMark: anyTone } : null;
  }

  const res = normalizePinyinText(text);
  if (!res) return null;
  const segs = segmentSinglePinyinChunk(text, res.norm);
  if (!segs || segs.length < 2) return null;
  return { syllables: segs, hasToneMark: res.hasToneMark };
}

function tryStage3ToneAndPinyin(
  body: string,
  contextHint: ContextTierHint
): SmartSplitCandidate[] | null {
  // 3a. Tone-anchored polysyllabic string (e.g. tɕʰyən˥miɛn˧˥, ma214mi51, zhong1guo2)
  const toneSegments = splitByToneAnchors(body);
  if (toneSegments) {
    const anchorCand = makeCandidate({
      id: 'tone-anchor',
      strategyLabel: '按声调锚点',
      granularity: 'syllable',
      texts: toneSegments,
      confidence: 0.94,
      reason: '检测到多组连续声调标记，按调尾切分音节'
    });

    const phones = splitTokensIntoPhones(toneSegments);
    const phoneCand =
      phones.length > toneSegments.length
        ? makeCandidate({
            id: 'phone-from-tone-anchor',
            strategyLabel: '按音素',
            granularity: 'phone',
            texts: phones,
            confidence: contextHint === 'PHONE' ? 0.92 : 0.75,
            reason: '按原子音素切分并保留各音节末声调'
          })
        : null;

    const onsetRimes = splitSyllablesIntoOnsetRime(toneSegments);
    const onsetRimeCand = onsetRimes
      ? makeCandidate({
          id: 'onset-rime-from-tone-anchor',
          strategyLabel: '按声韵',
          granularity: 'onset-rime',
          texts: onsetRimes,
          confidence: contextHint === 'ONSET_RIME' ? 0.91 : 0.72,
          reason: '按声母与带调韵母切分各音节'
        })
      : null;

    if (contextHint === 'PHONE' && phoneCand) {
      return [phoneCand, ...(anchorCand ? [anchorCand] : []), ...(onsetRimeCand ? [onsetRimeCand] : [])];
    }
    if (contextHint === 'ONSET_RIME' && onsetRimeCand) {
      return [onsetRimeCand, ...(anchorCand ? [anchorCand] : []), ...(phoneCand ? [phoneCand] : [])];
    }
    return [
      ...(anchorCand ? [anchorCand] : []),
      ...(phoneCand ? [phoneCand] : []),
      ...(onsetRimeCand ? [onsetRimeCand] : [])
    ];
  }

  // 3b. Continuous Mandarin Pinyin (e.g. chunmian, zhōngguó)
  if (contextHint !== 'PHONE') {
    const py = segmentContinuousPinyin(body);
    if (py) {
      const pyCand = makeCandidate({
        id: 'pinyin-syllable',
        strategyLabel: '按拼音',
        granularity: 'syllable',
        texts: py.syllables,
        confidence: py.hasToneMark ? 0.92 : 0.84,
        reason: py.hasToneMark ? '检测到带调连续拼音，按标准拼音音节切分' : '匹配标准汉语拼音音节表切分'
      });
      const phones = splitTokensIntoPhones(py.syllables);
      const phoneCand =
        phones.length > py.syllables.length
          ? makeCandidate({
              id: 'phone-from-pinyin',
              strategyLabel: '按音素',
              granularity: 'phone',
              texts: phones,
              confidence: 0.65,
              reason: '按字母或音素切分'
            })
          : null;
      return [
        ...(pyCand ? [pyCand] : []),
        ...(phoneCand ? [phoneCand] : [])
      ];
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Stage 4: IPA Atomic Phoneme State Machine, Syllabification & Granularity
// ---------------------------------------------------------------------------

interface VowelPeak {
  start: number;
  end: number; // inclusive
}

function findVowelPeaks(atoms: readonly IpaAtom[]): VowelPeak[] {
  const peaks: VowelPeak[] = [];
  let i = 0;
  while (i < atoms.length) {
    if (atoms[i].kind === 'vowel') {
      const start = i;
      while (i + 1 < atoms.length && atoms[i + 1].kind === 'vowel' && !atoms[i + 1].isStressed) {
        i++;
      }
      peaks.push({ start, end: i });
    }
    i++;
  }
  return peaks;
}

function canFormOnsetCluster(prev: IpaAtom, next: IpaAtom): boolean {
  // Rising sonority: obstruent + liquid/glide (pl, tr, kw, fj)
  if (prev.sonority <= 2 && next.sonority >= 4) return true;
  // s/ʃ + voiceless stop (sp, st, sk)
  if ((prev.base === 's' || prev.base === 'ʃ') && next.sonority === 1 && next.acousticClass === 'voiceless-obs') {
    return true;
  }
  return false;
}

function syllabifyIpaAtoms(atoms: readonly IpaAtom[], peaks: readonly VowelPeak[]): string[] {
  if (peaks.length < 2) {
    return [atoms.map((a) => a.text).join('')];
  }

  const splitIndices: number[] = [];
  for (let p = 0; p < peaks.length - 1; p++) {
    const leftEnd = peaks[p].end;
    const rightStart = peaks[p + 1].start;
    const consCount = rightStart - leftEnd - 1;

    if (consCount <= 0) {
      splitIndices.push(rightStart);
      continue;
    }

    // If any intervocalic consonant carries a stress mark, split right before it
    let stressSplit = -1;
    for (let k = leftEnd + 1; k < rightStart; k++) {
      if (atoms[k].isStressed) {
        stressSplit = k;
        break;
      }
    }
    if (stressSplit !== -1) {
      splitIndices.push(stressSplit);
      continue;
    }

    if (consCount === 1) {
      // Maximal Onset Principle: VCV -> V.CV
      splitIndices.push(leftEnd + 1);
      continue;
    }

    // Multiple intervocalic consonants: maximize valid rising-sonority onset
    let onsetStart = rightStart - 1;
    while (
      onsetStart > leftEnd + 1 &&
      canFormOnsetCluster(atoms[onsetStart - 1], atoms[onsetStart])
    ) {
      onsetStart--;
    }
    splitIndices.push(onsetStart);
  }

  const syllables: string[] = [];
  let prevIdx = 0;
  for (const idx of splitIndices) {
    syllables.push(
      atoms
        .slice(prevIdx, idx)
        .map((a) => a.text)
        .join('')
    );
    prevIdx = idx;
  }
  syllables.push(
    atoms
      .slice(prevIdx)
      .map((a) => a.text)
      .join('')
  );
  return syllables.filter(Boolean);
}

function tryStage4Ipa(
  body: string,
  contextHint: ContextTierHint,
  ctx?: SmartSplitContext
): SmartSplitCandidate[] {
  // Explicit IPA syllable dot separator (e.g. pʰaː.kʷuː)
  if (body.includes('.') && !/^\.|\.$/.test(body)) {
    const dotParts = body.split('.').filter(Boolean);
    if (dotParts.length >= 2) {
      const sylCand = makeCandidate({
        id: 'ipa-dot-syllable',
        strategyLabel: '按音节',
        granularity: 'syllable',
        texts: dotParts,
        confidence: 0.94,
        reason: '检测到音节分隔点，按音节切分'
      });
      const phones = splitTokensIntoPhones(dotParts);
      const phoneCand =
        phones.length > dotParts.length
          ? makeCandidate({
              id: 'ipa-dot-phone',
              strategyLabel: '按音素',
              granularity: 'phone',
              texts: phones,
              confidence: contextHint === 'PHONE' ? 0.93 : 0.76,
              reason: '逐原子音素切分'
            })
          : null;
      if (contextHint === 'PHONE' && phoneCand) {
        return [phoneCand, ...(sylCand ? [sylCand] : [])];
      }
      return [...(sylCand ? [sylCand] : []), ...(phoneCand ? [phoneCand] : [])];
    }
  }

  const { core, tone } = splitTrailingTone(body);
  if (!core) return [];

  const atoms = tokenizeIpaAtoms(core);
  if (atoms.length === 0) return [];

  const hasTone = tone.length > 0 || COMBINING_TONE_MARK_RE.test(core.normalize('NFD'));
  const hasAudio = Boolean(ctx?.hasAudio);

  // Build phone-level segments with tone preserved on the last phone (reversibility invariant)
  const phoneTexts = atoms.map((a) => a.text);
  if (tone) {
    phoneTexts[phoneTexts.length - 1] += tone;
  }

  const phoneWeights = atoms.map((a) => a.weight);
  const phoneClasses = atoms.map((a) => a.acousticClass);

  const peaks = findVowelPeaks(atoms);

  // 4A. Polysyllabic untoned (or final-toned) IPA (e.g. pʰaːkʷuː, tʰiŋtə)
  if (peaks.length >= 2) {
    const sylTexts = syllabifyIpaAtoms(atoms, peaks);
    if (tone && sylTexts.length > 0) {
      sylTexts[sylTexts.length - 1] += tone;
    }

    const sylCand = makeCandidate({
      id: 'ipa-syllable',
      strategyLabel: '按音节',
      granularity: 'syllable',
      texts: sylTexts,
      confidence: contextHint === 'PHONE' ? 0.78 : 0.89,
      reason: '检测到多音节连续音标，按响度与最大声母原则切分音节'
    });

    const phoneCand = makeCandidate({
      id: 'ipa-phone',
      strategyLabel: '按音素',
      granularity: 'phone',
      texts: phoneTexts,
      weightsOverride: phoneWeights,
      classesOverride: phoneClasses,
      confidence: contextHint === 'PHONE' ? 0.93 : 0.78,
      reason:
        contextHint === 'PHONE'
          ? '当前层上下文指向音素级，按原子音段切分'
          : '按原子音素逐段切分'
    });

    if (contextHint === 'PHONE') {
      return [...(phoneCand ? [phoneCand] : []), ...(sylCand ? [sylCand] : [])];
    }
    return [...(sylCand ? [sylCand] : []), ...(phoneCand ? [phoneCand] : [])];
  }

  // 4B. Monosyllabic IPA (peaks.length === 1)
  if (peaks.length === 1) {
    const firstVowelIdx = peaks[0].start;
    let onsetSplitIdx = firstVowelIdx;

    // Sinological medial glide after consonant with tone (e.g. pjɛn˥ -> p | jɛn˥)
    if (
      onsetSplitIdx >= 2 &&
      atoms[onsetSplitIdx - 1].kind === 'glide' &&
      hasTone
    ) {
      onsetSplitIdx--;
    }

    const onsetAtoms = atoms.slice(0, onsetSplitIdx);
    const rimeAtoms = atoms.slice(onsetSplitIdx);
    const hasOnset = onsetAtoms.length > 0 && rimeAtoms.length > 0;

    // Zero-onset monosyllable (e.g. ɑu51, iən˥, a214, aː)
    if (!hasOnset) {
      // N=1 auto drilldown: single vowel + trailing tone (e.g. a214 -> a | 214)
      if (atoms.length === 1 && tone.length > 0) {
        const drillCand = makeCandidate({
          id: 'ipa-tone-drilldown',
          strategyLabel: '分离声调',
          granularity: 'tone-split',
          texts: [core, tone],
          weightsOverride: [atoms[0].weight, 0.65],
          classesOverride: [atoms[0].acousticClass, 'other'],
          confidence: 0.88,
          reason: '单韵母带调自动下钻拆分为韵母与声调'
        });
        return drillCand ? [drillCand] : [];
      }

      const phoneCand = makeCandidate({
        id: 'ipa-phone',
        strategyLabel: '按音素',
        granularity: 'phone',
        texts: phoneTexts,
        weightsOverride: phoneWeights,
        classesOverride: phoneClasses,
        confidence: 0.88,
        reason: '零声母音节按原子音素切分并保持声调在末音段'
      });

      const toneSplitCand =
        tone.length > 0
          ? makeCandidate({
              id: 'ipa-tone-split',
              strategyLabel: '分离声调',
              granularity: 'tone-split',
              texts: [core, tone],
              confidence: contextHint === 'TONE' ? 0.91 : 0.72,
              reason: '将音段主体与声调分离'
            })
          : null;

      if (contextHint === 'TONE' && toneSplitCand) {
        return [toneSplitCand, ...(phoneCand ? [phoneCand] : [])];
      }
      return [...(phoneCand ? [phoneCand] : []), ...(toneSplitCand ? [toneSplitCand] : [])];
    }

    // Has onset + rime
    const onsetText = onsetAtoms.map((a) => a.text).join('');
    const rimeCoreText = rimeAtoms.map((a) => a.text).join('');
    const rimeWithToneText = rimeCoreText + tone;

    const onsetWeight = onsetAtoms.reduce((s, a) => s + a.weight, 0);
    const rimeWeight = rimeAtoms.reduce((s, a) => s + a.weight, 0);
    const onsetClass: AcousticSegmentClass = onsetAtoms[0].acousticClass;
    const rimeClass: AcousticSegmentClass = 'vowel';

    const onsetRimeTexts = [onsetText, rimeWithToneText];
    const isSimpleCV = onsetAtoms.length === 1 && rimeAtoms.length === 1;

    // Simple CV monosyllable (e.g. t͡sʰaː, ma214): unambiguous 2 segments
    if (isSimpleCV) {
      const preferPhoneLabel = contextHint === 'PHONE' || (!hasTone && contextHint !== 'ONSET_RIME');
      const primaryCand = makeCandidate({
        id: preferPhoneLabel ? 'ipa-phone' : 'ipa-onset-rime',
        strategyLabel: preferPhoneLabel ? '按音素' : '按声韵',
        granularity: preferPhoneLabel ? 'phone' : 'onset-rime',
        texts: onsetRimeTexts,
        weightsOverride: [onsetWeight, rimeWeight],
        classesOverride: [onsetClass, rimeClass],
        confidence: 0.94,
        reason: preferPhoneLabel ? '简单单音节按原子音素无歧义切分为 2 段' : '简单单音节按声母与韵母无歧义切分为 2 段'
      });

      const toneSplitCand =
        tone.length > 0 && (!hasAudio || contextHint === 'TONE')
          ? makeCandidate({
              id: 'ipa-onset-rime-tone',
              strategyLabel: '按声韵调',
              granularity: 'tone-split',
              texts: [onsetText, rimeCoreText, tone],
              weightsOverride: [onsetWeight, rimeWeight, 0.65],
              classesOverride: [onsetClass, rimeClass, 'other'],
              confidence: contextHint === 'TONE' ? 0.9 : 0.7,
              reason: '按声母、韵母与声调切分为 3 段'
            })
          : null;

      if (contextHint === 'TONE' && tone.length > 0) {
        const bareToneCand = makeCandidate({
          id: 'ipa-tone-split',
          strategyLabel: '分离声调',
          granularity: 'tone-split',
          texts: [core, tone],
          confidence: 0.92,
          reason: '当前层上下文指向声调，分离音节主体与声调'
        });
        return [
          ...(bareToneCand ? [bareToneCand] : []),
          ...(primaryCand ? [primaryCand] : []),
          ...(toneSplitCand ? [toneSplitCand] : [])
        ];
      }

      return [...(primaryCand ? [primaryCand] : []), ...(toneSplitCand ? [toneSplitCand] : [])];
    }

    // Complex rime / cluster monosyllable (e.g. tɕʰyən˥, tiɑu51, tʰiŋ)
    const onsetRimeCand = makeCandidate({
      id: 'ipa-onset-rime',
      strategyLabel: '按声韵',
      granularity: 'onset-rime',
      texts: onsetRimeTexts,
      weightsOverride: [onsetWeight, rimeWeight],
      classesOverride: [onsetClass, rimeClass],
      confidence:
        contextHint === 'ONSET_RIME'
          ? 0.95
          : contextHint === 'PHONE'
            ? 0.78
            : hasTone
              ? 0.91
              : 0.78,
      reason:
        contextHint === 'ONSET_RIME'
          ? '当前层上下文指向声韵结构，按声母与韵母切分'
          : hasTone
            ? '带调单音节音标默认按声韵 2 段切分'
            : '按声母与整体韵母切分为 2 段'
    });

    const phoneCand = makeCandidate({
      id: 'ipa-phone',
      strategyLabel: '按音素',
      granularity: 'phone',
      texts: phoneTexts,
      weightsOverride: phoneWeights,
      classesOverride: phoneClasses,
      confidence:
        contextHint === 'PHONE'
          ? 0.95
          : contextHint === 'ONSET_RIME'
            ? 0.78
            : hasTone
              ? 0.8
              : 0.9,
      reason:
        contextHint === 'PHONE'
          ? '当前层上下文指向音素级，逐原子音素切分'
          : hasTone
            ? '逐原子音素切分，声调保留在末音段'
            : '无调单音节音标默认逐原子音素切分'
    });

    const onsetRimeToneCand =
      tone.length > 0 && !hasAudio
        ? makeCandidate({
            id: 'ipa-onset-rime-tone',
            strategyLabel: '按声韵调',
            granularity: 'tone-split',
            texts: [onsetText, rimeCoreText, tone],
            weightsOverride: [onsetWeight, rimeWeight, 0.65],
            classesOverride: [onsetClass, rimeClass, 'other'],
            confidence: 0.68,
            reason: '无伴随音频时可按声母、韵母与声调切分为 3 段'
          })
        : null;

    if (contextHint === 'TONE' && tone.length > 0) {
      const bareToneCand = makeCandidate({
        id: 'ipa-tone-split',
        strategyLabel: '分离声调',
        granularity: 'tone-split',
        texts: [core, tone],
        confidence: 0.93,
        reason: '当前层上下文指向声调，分离音节主体与声调'
      });
      return [
        ...(bareToneCand ? [bareToneCand] : []),
        ...(onsetRimeCand ? [onsetRimeCand] : []),
        ...(phoneCand ? [phoneCand] : [])
      ];
    }

    if (contextHint === 'ONSET_RIME') {
      return [
        ...(onsetRimeCand ? [onsetRimeCand] : []),
        ...(phoneCand ? [phoneCand] : []),
        ...(onsetRimeToneCand ? [onsetRimeToneCand] : [])
      ];
    }

    if (contextHint === 'PHONE') {
      return [
        ...(phoneCand ? [phoneCand] : []),
        ...(onsetRimeCand ? [onsetRimeCand] : []),
        ...(onsetRimeToneCand ? [onsetRimeToneCand] : [])
      ];
    }

    // NEUTRAL (or SYLLABLE / WORD):
    // - WITH tone -> Primary: onset-rime (2 segments), Alternative: phone (+ onset-rime-tone if no audio)
    // - WITHOUT tone -> Primary: phone, Alternative: onset-rime
    if (hasTone) {
      return [
        ...(onsetRimeCand ? [onsetRimeCand] : []),
        ...(phoneCand ? [phoneCand] : []),
        ...(onsetRimeToneCand ? [onsetRimeToneCand] : [])
      ];
    }

    return [
      ...(phoneCand ? [phoneCand] : []),
      ...(onsetRimeCand ? [onsetRimeCand] : [])
    ];
  }

  // 4C. Zero vowel peaks (consonant cluster or single consonant with tone)
  if (atoms.length >= 2) {
    const phoneCand = makeCandidate({
      id: 'ipa-cluster-phone',
      strategyLabel: '按音素',
      granularity: 'phone',
      texts: phoneTexts,
      weightsOverride: phoneWeights,
      classesOverride: phoneClasses,
      confidence: 0.85,
      reason: '按原子音素切分辅音串'
    });
    return phoneCand ? [phoneCand] : [];
  }

  if (atoms.length === 1 && tone.length > 0) {
    const drillCand = makeCandidate({
      id: 'ipa-cons-tone-drilldown',
      strategyLabel: '分离声调',
      granularity: 'tone-split',
      texts: [core, tone],
      weightsOverride: [atoms[0].weight, 0.65],
      classesOverride: [atoms[0].acousticClass, 'other'],
      confidence: 0.85,
      reason: '单音段带调自动下钻分离声调'
    });
    return drillCand ? [drillCand] : [];
  }

  // Single atomic unit (e.g. tʰ, tɕʰ, aː, m) -> not splittable
  return [];
}

// ---------------------------------------------------------------------------
// Public Entry Point
// ---------------------------------------------------------------------------

export function inferSmartSplit(
  rawText: string,
  decodedPraatText?: string | null,
  ctx?: SmartSplitContext
): SmartSplitPlan {
  const usedDecodedPraat =
    typeof decodedPraatText === 'string' && decodedPraatText !== rawText;
  const sourceText = usedDecodedPraat ? (decodedPraatText as string) : rawText;
  const contextHint = inferContextHint(ctx);

  const trimmed = sourceText.trim();
  if (!trimmed) {
    return {
      sourceText,
      usedDecodedPraat,
      contextHint,
      primary: null,
      alternatives: []
    };
  }

  const unwrapped = unwrapOuterPairs(trimmed);
  if (!unwrapped.body) {
    return {
      sourceText,
      usedDecodedPraat,
      contextHint,
      primary: null,
      alternatives: []
    };
  }

  // Stage 1: Explicit structural delimiters vs natural sentence punctuation
  const stage1 = tryStage1Delimiters(trimmed, unwrapped, contextHint, ctx);
  if (stage1 && stage1.length > 0) {
    return buildPlan(sourceText, usedDecodedPraat, contextHint, stage1);
  }

  // Stage 2: CJK & Mixed-Script (Hanzi, Kana Mora, Hangul)
  const stage2 = tryStage2Cjk(trimmed, unwrapped, ctx);
  if (stage2 !== null) {
    return buildPlan(sourceText, usedDecodedPraat, contextHint, stage2);
  }

  // Stage 3: Tone-anchored polysyllabic strings & Continuous Pinyin
  const stage3 = tryStage3ToneAndPinyin(unwrapped.body, contextHint);
  if (stage3 && stage3.length > 0) {
    return buildPlan(sourceText, usedDecodedPraat, contextHint, stage3);
  }

  // Stage 4: IPA atomic state machine & granularity tradeoff
  const stage4 = tryStage4Ipa(unwrapped.body, contextHint, ctx);
  return buildPlan(sourceText, usedDecodedPraat, contextHint, stage4);
}
