// Auto-synced 2-char Praat Longchar_database trigraph codes (exact match with crates/tg-core/src/ipa_data.rs).
export const PRAAT_TRIGRAPH_CODES: ReadonlySet<string> = new Set([
  "!d", "?d", "-h", "--", "+-", "bs", "'a", "\"l", "\"r", "<<", ">>", "a`", "a'", "a^", "a~", "a\"",
  "ao", "a;", "c'", "c<", "d<", "d-", "e`", "e'", "e^", "e\"", "e<", "e;", "g<", "i`", "i'", "i^",
  "i\"", "l/", "n'", "n~", "n<", "o`", "o'", "o^", "o~", "o\"", "o:", "r<", "s'", "s<", "t<", "u`",
  "u'", "u^", "u\"", "u:", "uo", "y'", "y\"", "z'", "z<", "z!", "A`", "A'", "A^", "A~", "A\"", "Ao",
  "A;", "C'", "C<", "D<", "D-", "E`", "E'", "E^", "E\"", "E<", "E;", "G<", "I`", "I'", "I^", "I\"",
  "L/", "N'", "N~", "N<", "O`", "O'", "O^", "O~", "O\"", "O:", "R<", "S'", "S<", "T<", "U`", "U'",
  "U^", "U\"", "U:", "Uo", "Y'", "Y\"", "Z'", "Z<", "Z!", "ss", "ae", "o/", "c,", "s,", "t,", "th",
  "Ae", "O/", "C,", "S,", "T,", "Th", ".c", "dg", "c/", "Lp", "cu", "eu", "Y=", "SS", "||", "co",
  "re", "a_", "o_", "FI", "FL", "al", "be", "ga", "de", "ep", "ze", "et", "te", "t2", "io", "ka",
  "la", "mu", "nu", "xi", "on", "pi", "ro", "si", "s2", "ta", "up", "fi", "f2", "ci", "ps", "om",
  "o2", "Al", "Be", "Ga", "De", "Ep", "Ze", "Et", "Te", "Io", "Ka", "La", "Mu", "Nu", "Xi", "On",
  "Pi", "Ro", "Si", "Ta", "Up", "Fi", "Ci", "Ps", "Om", "tm", "TM", "no", "xx", ":-", "fd", "bu",
  "'p", "\"p", "At", "dd", "Er", "O|", "e=", "su", "-m", "/d", "Vr", "oc", "oo", "an", "or", "ni",
  "uu", "in", ".3", "=~", "~~", "un", "=/", "=3", "<_", ">_", "c=", "o+", "ox", "Tt", "..", "cl",
  "di", "he", "sp", "<-", "^|", "->", "_|", "<>", "<=", "^#", "=>", "_#", "eq", "dh", "h-", "oe",
  "at", "as", "ay", "ab", "b^", "[f", "]f", "bc", "ct", "cc", "d.", "d^", "e-", "sw", "sr", "ef",
  "er", "kb", "j-", "g^", "gs", "gc", "gf", "rh", "G^", "ht", "h^", "hj", "hc", "i-", "ic", "jc",
  "l~", "l-", "l.", "lz", "lc", "mt", "ml", "mj", "ng", "nj", "n.", "nc", "o-", "Oe", "|1", "|2",
  "|-", "|f", "ff", "rt", "rl", "r.", "f.", "fh", "rc", "ri", "s.", "sh", "j^", "t.", "u-", "hs",
  "vs", "vt", "wt", "yt", "yc", "z.", "zc", "zh", "?g", "9e", "O.", "?-", "9-", "V^", ":f", ".f",
  "hr", "`^", "``", "'^", "''", "^^", "~^", "//", "-/", "~/", "-^", ":^", "0^", "v^", "N^", "cn",
  "cv", "T^", "Tv", "T(", "T)", "+v", ":v", "0v", "vv", "|v", "Nv", "Uv", "Dv", "nv", "~v", "-v",
  ".v", "~<", "3v", "li", "LI", "mv", "wv", "-'", "'-", "`-", "-`", "rf", "fr", "bf", "tf", "cf",
  "'1", "'2", "^h", "^H", "^j", "^w", "^Y", "^y", "^?", "^9", "^l", "^s", "^g", "^M", "^G", "^x",
  "^f", "^n", "^m", "^N", "id", "ir", "_u", "-5", "-4", "-3", "-2", "-1", "|u", "|d", "NE", "SE",
  "NW", "SW", "ts", "tS", "dz", "dZ", "ap", "x^",
]);

export function isValidPraatTrigraphAt(str: string, idx: number): boolean {
  return str[idx] === '\\' && idx + 2 < str.length && PRAAT_TRIGRAPH_CODES.has(str.slice(idx + 1, idx + 3));
}
