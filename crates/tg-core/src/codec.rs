use crate::model::{
    CollectionFormat, CollectionItem, Interval, ParsedDocument, SoundObject, TextGrid,
    TextGridFormat, TextPoint, Tier, TierKind,
};
use crate::CoreError;

const WIN1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}', '\u{017D}', '\u{008F}',
    '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
];

#[inline]
fn is_praat_space(ch: char) -> bool {
    matches!(
        ch as u32,
        0x09 | 0x0A
            | 0x0B
            | 0x0C
            | 0x0D
            | 0x20
            | 0x0085
            | 0x00A0
            | 0x1680
            | 0x2000..=0x200A
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
    )
}

pub fn format_praat_double(val: f64) -> String {
    if !val.is_finite() {
        return "--undefined--".to_string();
    }
    if val == 0.0 {
        return "0".to_string();
    }
    val.to_string()
}

pub fn escape_praat_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        if ch == '"' {
            out.push_str("\"\"");
        } else {
            out.push(ch);
        }
    }
    out.push('"');
    out
}

fn decode_utf16_bytes(bytes: &[u8], big_endian: bool) -> String {
    let count = bytes.len() / 2;
    let mut units = Vec::with_capacity(count);
    for i in 0..count {
        let pair = [bytes[i * 2], bytes[i * 2 + 1]];
        let u = if big_endian {
            u16::from_be_bytes(pair)
        } else {
            u16::from_le_bytes(pair)
        };
        units.push(u);
    }
    let decoded = String::from_utf16_lossy(&units);
    // Normalize \r\u0085, \r\n, \r, \u0085, \u000C, \u2028, \u2029 -> \n
    let mut out = String::with_capacity(decoded.len());
    let mut chars = decoded.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if matches!(chars.peek(), Some('\n') | Some('\u{0085}')) {
                    chars.next();
                }
                out.push('\n');
            }
            '\u{0085}' | '\u{000C}' | '\u{2028}' | '\u{2029}' => out.push('\n'),
            _ => out.push(c),
        }
    }
    out
}

fn decode_win1252(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for &b in bytes {
        if (0x80..=0x9F).contains(&b) {
            out.push(WIN1252_HIGH[(b - 0x80) as usize]);
        } else {
            out.push(b as char);
        }
    }
    out
}

fn normalize_crlf(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

pub fn decode_praat_text_bytes(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        return decode_utf16_bytes(&bytes[2..], true);
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        return decode_utf16_bytes(&bytes[2..], false);
    }
    let start = if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        3
    } else {
        0
    };
    let slice = &bytes[start..];
    let has_nul = slice.contains(&0);
    let cleaned_vec;
    let clean = if has_nul {
        cleaned_vec = slice.iter().copied().filter(|&b| b != 0).collect::<Vec<u8>>();
        cleaned_vec.as_slice()
    } else {
        slice
    };
    let text = match std::str::from_utf8(clean) {
        Ok(s) => s.to_string(),
        Err(_) => decode_win1252(clean),
    };
    normalize_crlf(&text)
}

/* ============================================================================
 * AbcioTextScanner (Long Text, Short Text, Hybrid, Chronological)
 * ============================================================================ */

struct AbcioTextScanner {
    chars: Vec<char>,
    pos: usize,
}

impl AbcioTextScanner {
    fn new(text: &str) -> Self {
        Self {
            chars: text.chars().collect(),
            pos: 0,
        }
    }

    fn has_more_tokens(&self) -> bool {
        let mut p = self.pos;
        let n = self.chars.len();
        while p < n {
            let c = self.chars[p];
            if is_praat_space(c) {
                p += 1;
                continue;
            }
            if c == '!' {
                while p < n && self.chars[p] != '\n' {
                    p += 1;
                }
                if p < n {
                    p += 1;
                }
                continue;
            }
            return true;
        }
        false
    }

    fn scan_to_start(&mut self, valid: &str, err_starts: &str) -> Result<char, CoreError> {
        let n = self.chars.len();
        loop {
            if self.pos >= n {
                return Err(CoreError::Parse("Early end of text".into()));
            }
            let c = self.chars[self.pos];
            self.pos += 1;
            if is_praat_space(c) {
                continue;
            }
            if c == '!' {
                while self.pos < n && self.chars[self.pos] != '\n' {
                    self.pos += 1;
                }
                if self.pos < n {
                    self.pos += 1;
                }
                continue;
            }
            if valid.contains(c) {
                return Ok(c);
            }
            if err_starts.contains(c) {
                return Err(CoreError::Parse(format!(
                    "Unexpected token start '{c}' at char offset {}",
                    self.pos - 1
                )));
            }
            // Skip label word until whitespace
            loop {
                if self.pos >= n {
                    return Err(CoreError::Parse(
                        "Early end of text after label word".into(),
                    ));
                }
                let nc = self.chars[self.pos];
                self.pos += 1;
                if is_praat_space(nc) {
                    break;
                }
            }
        }
    }

    fn read_string(&mut self) -> Result<String, CoreError> {
        self.scan_to_start("\"", "0123456789+-<")?;
        let mut out = String::new();
        let n = self.chars.len();
        loop {
            if self.pos >= n {
                return Err(CoreError::Parse("Unclosed string literal".into()));
            }
            let c = self.chars[self.pos];
            self.pos += 1;
            if c == '"' {
                if self.pos >= n {
                    return Ok(out);
                }
                let nxt = self.chars[self.pos];
                if nxt == '"' {
                    self.pos += 1;
                    out.push('"');
                } else if is_praat_space(nxt) {
                    self.pos += 1;
                    return Ok(out);
                } else {
                    return Err(CoreError::Parse(format!(
                        "Character '{nxt}' following closing quote"
                    )));
                }
            } else {
                out.push(c);
            }
        }
    }

    fn read_enum(&mut self) -> Result<String, CoreError> {
        self.scan_to_start("<", "0123456789+-\"")?;
        let mut buf = String::new();
        let n = self.chars.len();
        loop {
            if self.pos >= n {
                return Err(CoreError::Parse("Unclosed <enum> token".into()));
            }
            let c = self.chars[self.pos];
            self.pos += 1;
            if c == '>' {
                if buf.is_empty() {
                    return Err(CoreError::Parse("Empty <> enum token".into()));
                }
                return Ok(buf);
            }
            if is_praat_space(c) && c != ' ' {
                return Err(CoreError::Parse(
                    "Illegal non-space whitespace inside <enum>".into(),
                ));
            }
            if buf.chars().count() >= 39 {
                return Err(CoreError::Parse("<enum> token exceeds 39 chars".into()));
            }
            buf.push(c);
        }
    }

    fn read_exists(&mut self) -> Result<bool, CoreError> {
        let tok = self.read_enum()?;
        if tok == "exists" || tok == "Exists" {
            Ok(true)
        } else if tok == "absent" || tok == "Absent" {
            Ok(false)
        } else {
            Err(CoreError::Parse(format!("Invalid existence token <{tok}>")))
        }
    }

    fn read_numeric_word(&mut self, first: char) -> Result<String, CoreError> {
        let mut word = String::with_capacity(16);
        word.push(first);
        let n = self.chars.len();
        while self.pos < n {
            let c = self.chars[self.pos];
            self.pos += 1;
            if is_praat_space(c) {
                break;
            }
            if (c as u32) > 127 || word.len() >= 40 {
                return Err(CoreError::Parse("Invalid or overlong numeric token".into()));
            }
            word.push(c);
        }
        Ok(word)
    }

    fn read_i32(&mut self) -> Result<i32, CoreError> {
        let first = self.scan_to_start("0123456789+-", "\"<")?;
        let word = self.read_numeric_word(first)?;
        if !is_valid_int_word(&word) {
            return Err(CoreError::Parse(format!("Invalid integer token: {word}")));
        }
        let val: i64 = word
            .parse()
            .map_err(|_| CoreError::Parse(format!("Invalid integer token: {word}")))?;
        if val < (i32::MIN as i64) || val > (i32::MAX as i64) {
            return Err(CoreError::Parse(format!("i32 out of range: {val}")));
        }
        Ok(val as i32)
    }

    fn read_r64(&mut self) -> Result<f64, CoreError> {
        let word = loop {
            let first = self.scan_to_start("0123456789+-", "\"<")?;
            let w = self.read_numeric_word(first)?;
            if w != "+" {
                break w;
            }
        };
        if let Some(slash) = word.find('/') {
            let num = melder_atof(&word[..slash]);
            let den = melder_atof(&word[slash + 1..]);
            if !num.is_finite() || !den.is_finite() || den == 0.0 {
                return Ok(f64::NAN);
            }
            let r = num / den;
            return Ok(if r.is_finite() { r } else { f64::NAN });
        }
        Ok(melder_atof(&word))
    }
}

fn is_valid_int_word(w: &str) -> bool {
    let bytes = w.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let start = if bytes[0] == b'+' || bytes[0] == b'-' {
        1
    } else {
        0
    };
    if start >= bytes.len() {
        return false;
    }
    bytes[start..].iter().all(|b| b.is_ascii_digit())
}

fn parse_hex_float(token: &str) -> Option<f64> {
    let bytes = token.as_bytes();
    let (sign, rest) = if bytes.first() == Some(&b'-') {
        (-1.0, &token[1..])
    } else if bytes.first() == Some(&b'+') {
        (1.0, &token[1..])
    } else {
        (1.0, token)
    };
    let body = rest
        .strip_prefix("0x")
        .or_else(|| rest.strip_prefix("0X"))?;
    let (mant, exp_part) = match body.find(['p', 'P']) {
        Some(idx) => (&body[..idx], Some(&body[idx + 1..])),
        None => (body, None),
    };
    let (int_h, frac_h) = match mant.find('.') {
        Some(idx) => (&mant[..idx], &mant[idx + 1..]),
        None => (mant, ""),
    };
    if int_h.is_empty() || !int_h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    if !frac_h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut val = 0.0_f64;
    for b in int_h.bytes() {
        val = val * 16.0 + hex_digit(b)? as f64;
    }
    let mut scale = 1.0 / 16.0;
    for b in frac_h.bytes() {
        val += hex_digit(b)? as f64 * scale;
        scale /= 16.0;
    }
    let exp: i32 = match exp_part {
        Some(ep) => {
            if !is_valid_int_word(ep) {
                return None;
            }
            ep.parse().ok()?
        }
        None => 0,
    };
    let res = sign * val * 2.0_f64.powi(exp);
    if res.is_finite() {
        Some(res)
    } else {
        None
    }
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn is_valid_dec_float(token: &str) -> bool {
    let bytes = token.as_bytes();
    let mut i = 0;
    let n = bytes.len();
    if i < n && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < n && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == int_start {
        return false;
    }
    if i < n && bytes[i] == b'.' {
        i += 1;
        while i < n && bytes[i].is_ascii_digit() {
            i += 1;
        }
    }
    if i < n && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < n && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < n && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return false;
        }
    }
    if i < n && bytes[i] == b'%' {
        i += 1;
    }
    i == n
}

fn melder_atof(token: &str) -> f64 {
    if token.is_empty() {
        return f64::NAN;
    }
    let bytes = token.as_bytes();
    let idx = if bytes[0] == b'+' || bytes[0] == b'-' {
        1
    } else {
        0
    };
    if idx >= bytes.len() || !bytes[idx].is_ascii_digit() {
        return f64::NAN;
    }
    if token[idx..].starts_with("0x") || token[idx..].starts_with("0X") {
        return parse_hex_float(token).unwrap_or(f64::NAN);
    }
    if !is_valid_dec_float(token) {
        return f64::NAN;
    }
    let (core, pct) = match token.strip_suffix('%') {
        Some(c) => (c, true),
        None => (token, false),
    };
    match core.parse::<f64>() {
        Ok(mut v) => {
            if pct {
                v *= 0.01;
            }
            if v.is_finite() {
                v
            } else {
                f64::NAN
            }
        }
        Err(_) => f64::NAN,
    }
}

/* ============================================================================
 * BinaryReader / BinaryWriter (ooBinaryFile, Big-Endian)
 * ============================================================================ */

struct BinaryReader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> BinaryReader<'a> {
    fn new(bytes: &'a [u8], pos: usize) -> Self {
        Self { bytes, pos }
    }

    fn ensure(&self, n: usize) -> Result<(), CoreError> {
        if self.pos.checked_add(n).is_none_or(|end| end > self.bytes.len()) {
            return Err(CoreError::Parse("Unexpected EOF in binary stream".into()));
        }
        Ok(())
    }

    fn read_u8(&mut self) -> Result<u8, CoreError> {
        self.ensure(1)?;
        let v = self.bytes[self.pos];
        self.pos += 1;
        Ok(v)
    }

    fn read_bool8(&mut self) -> Result<bool, CoreError> {
        Ok(self.read_u8()? != 0)
    }

    fn read_u16(&mut self) -> Result<u16, CoreError> {
        self.ensure(2)?;
        let v = u16::from_be_bytes([self.bytes[self.pos], self.bytes[self.pos + 1]]);
        self.pos += 2;
        Ok(v)
    }

    fn read_i32(&mut self) -> Result<i32, CoreError> {
        self.ensure(4)?;
        let v = i32::from_be_bytes([
            self.bytes[self.pos],
            self.bytes[self.pos + 1],
            self.bytes[self.pos + 2],
            self.bytes[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }

    fn read_r32(&mut self) -> Result<f32, CoreError> {
        self.ensure(4)?;
        let v = f32::from_be_bytes([
            self.bytes[self.pos],
            self.bytes[self.pos + 1],
            self.bytes[self.pos + 2],
            self.bytes[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(if v.is_finite() { v } else { f32::NAN })
    }

    fn read_r64(&mut self) -> Result<f64, CoreError> {
        self.ensure(8)?;
        let mut arr = [0u8; 8];
        arr.copy_from_slice(&self.bytes[self.pos..self.pos + 8]);
        self.pos += 8;
        let v = f64::from_be_bytes(arr);
        Ok(if v.is_finite() { v } else { f64::NAN })
    }

    fn read_w8(&mut self) -> Result<String, CoreError> {
        let len = self.read_u8()?;
        if len == 0xFF {
            let cp_count = self.read_u8()? as usize;
            return self.read_utf16be_codepoints(cp_count);
        }
        let n = len as usize;
        self.ensure(n)?;
        let mut s = String::with_capacity(n);
        for i in 0..n {
            s.push(self.bytes[self.pos + i] as char);
        }
        self.pos += n;
        Ok(s)
    }

    fn read_w16(&mut self) -> Result<String, CoreError> {
        let prefix = self.read_u16()?;
        if prefix != 0xFFFF {
            let n = prefix as usize;
            self.ensure(n)?;
            let mut s = String::with_capacity(n);
            for i in 0..n {
                s.push(self.bytes[self.pos + i] as char);
            }
            self.pos += n;
            Ok(s)
        } else {
            let cp_count = self.read_u16()? as usize;
            self.read_utf16be_codepoints(cp_count)
        }
    }

    fn read_utf16be_codepoints(&mut self, cp_count: usize) -> Result<String, CoreError> {
        let mut out = String::with_capacity(cp_count);
        for _ in 0..cp_count {
            let u1 = self.read_u16()?;
            if (0xD800..=0xDBFF).contains(&u1) {
                let u2 = self.read_u16()?;
                if !(0xDC00..=0xDFFF).contains(&u2) {
                    return Err(CoreError::Parse("Corrupted UTF-16BE surrogate pair".into()));
                }
                let cp = 0x10000 + (((u1 as u32) - 0xD800) << 10) + ((u2 as u32) - 0xDC00);
                let ch = char::from_u32(cp)
                    .ok_or_else(|| CoreError::Parse("Invalid Unicode scalar value".into()))?;
                out.push(ch);
            } else if (0xDC00..=0xDFFF).contains(&u1) {
                return Err(CoreError::Parse("Lone UTF-16BE low surrogate".into()));
            } else {
                let ch = char::from_u32(u1 as u32)
                    .ok_or_else(|| CoreError::Parse("Invalid BMP scalar value".into()))?;
                out.push(ch);
            }
        }
        Ok(out)
    }
}

struct BinaryWriter {
    buf: Vec<u8>,
}

impl BinaryWriter {
    fn new() -> Self {
        Self {
            buf: Vec::with_capacity(1024),
        }
    }

    fn write_ascii_raw(&mut self, s: &str) {
        self.buf.extend_from_slice(s.as_bytes());
    }

    fn write_u8(&mut self, v: u8) {
        self.buf.push(v);
    }

    fn write_i32(&mut self, v: i32) {
        self.buf.extend_from_slice(&v.to_be_bytes());
    }

    fn write_r64(&mut self, v: f64) {
        let val = if v.is_finite() { v } else { f64::NAN };
        self.buf.extend_from_slice(&val.to_be_bytes());
    }

    fn write_w8(&mut self, s: &str) {
        let chars: Vec<char> = s.chars().take(254).collect();
        if chars.iter().all(|&c| (c as u32) <= 0x7F) {
            self.buf.push(chars.len() as u8);
            for c in chars {
                self.buf.push(c as u8);
            }
        } else {
            self.buf.push(0xFF);
            self.buf.push(chars.len() as u8);
            let mut u16_buf = [0u16; 2];
            for c in chars {
                for u in c.encode_utf16(&mut u16_buf) {
                    self.buf.extend_from_slice(&u.to_be_bytes());
                }
            }
        }
    }

    fn write_w16(&mut self, s: &str) {
        let chars: Vec<char> = s.chars().take(65534).collect();
        if chars.iter().all(|&c| (c as u32) <= 0x7F) {
            self.buf.extend_from_slice(&(chars.len() as u16).to_be_bytes());
            for c in chars {
                self.buf.push(c as u8);
            }
        } else {
            self.buf.extend_from_slice(&0xFFFFu16.to_be_bytes());
            self.buf.extend_from_slice(&(chars.len() as u16).to_be_bytes());
            let mut u16_buf = [0u16; 2];
            for c in chars {
                for u in c.encode_utf16(&mut u16_buf) {
                    self.buf.extend_from_slice(&u.to_be_bytes());
                }
            }
        }
    }

    fn into_bytes(self) -> Vec<u8> {
        self.buf
    }
}

/* ============================================================================
 * Object Readers (Text & Binary)
 * ============================================================================ */

fn split_class_token(tok: &str) -> (&str, i32) {
    match tok.find(' ') {
        Some(sp) => {
            let ver = tok[sp + 1..].trim().parse::<i32>().unwrap_or(0);
            (&tok[..sp], ver)
        }
        None => (tok, 0),
    }
}

fn cmp_interval_key(a: &Interval, b: &Interval) -> std::cmp::Ordering {
    let a_fin = a.xmin.is_finite() && a.xmax.is_finite();
    let b_fin = b.xmin.is_finite() && b.xmax.is_finite();
    match (a_fin, b_fin) {
        (true, true) => a.xmin.total_cmp(&b.xmin).then_with(|| a.xmax.total_cmp(&b.xmax)),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => std::cmp::Ordering::Equal,
    }
}

/// Insert interval in stable ascending `(xmin, xmax)` order without dropping intervals that share `xmin`
/// (e.g. a zero-duration `[t, t]` immediately followed by `[t, xmax]`).
fn insert_sorted_interval(list: &mut Vec<Interval>, item: Interval) {
    if !item.xmin.is_finite() || !item.xmax.is_finite() {
        list.push(item);
        return;
    }
    let pos = list.partition_point(|cur| cmp_interval_key(cur, &item) != std::cmp::Ordering::Greater);
    list.insert(pos, item);
}

fn insert_sorted_unique<T, F>(list: &mut Vec<T>, item: T, key_fn: F)
where
    F: Fn(&T) -> f64,
{
    let k = key_fn(&item);
    if !k.is_finite() {
        list.push(item);
        return;
    }
    let mut lo = 0usize;
    let mut hi = list.len();
    while lo < hi {
        let mid = (lo + hi) >> 1;
        let mk = key_fn(&list[mid]);
        if !mk.is_finite() {
            hi = mid;
        } else if mk < k {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    if lo < list.len() && key_fn(&list[lo]) == k {
        return;
    }
    list.insert(lo, item);
}

fn read_interval_tier_text(sc: &mut AbcioTextScanner, name: String) -> Result<Tier, CoreError> {
    let xmin = sc.read_r64()?;
    let xmax = sc.read_r64()?;
    if xmin > xmax {
        return Err(CoreError::Parse("IntervalTier xmin > xmax".into()));
    }
    let size = sc.read_i32()?;
    if size < 0 {
        return Err(CoreError::Parse("Negative IntervalTier size".into()));
    }
    let mut intervals = Vec::with_capacity(size as usize);
    for _ in 0..size {
        let a = sc.read_r64()?;
        let b = sc.read_r64()?;
        if a > b {
            return Err(CoreError::Parse("Interval xmin > xmax".into()));
        }
        let text = sc.read_string()?;
        insert_sorted_interval(
            &mut intervals,
            Interval {
                xmin: a,
                xmax: b,
                text,
            },
        );
    }
    Ok(Tier {
        kind: TierKind::IntervalTier,
        name,
        xmin,
        xmax,
        intervals,
        points: Vec::new(),
        display_num: None,
    })
}

fn read_text_tier_text(sc: &mut AbcioTextScanner, name: String) -> Result<Tier, CoreError> {
    let xmin = sc.read_r64()?;
    let xmax = sc.read_r64()?;
    if xmin > xmax {
        return Err(CoreError::Parse("TextTier xmin > xmax".into()));
    }
    let size = sc.read_i32()?;
    if size < 0 {
        return Err(CoreError::Parse("Negative TextTier size".into()));
    }
    let mut points = Vec::with_capacity(size as usize);
    for _ in 0..size {
        let number = sc.read_r64()?;
        let mark = sc.read_string()?;
        insert_sorted_unique(&mut points, TextPoint { number, mark }, |pt| pt.number);
    }
    Ok(Tier {
        kind: TierKind::TextTier,
        name,
        xmin,
        xmax,
        intervals: Vec::new(),
        points,
        display_num: None,
    })
}

fn read_textgrid_text(sc: &mut AbcioTextScanner, name: String) -> Result<TextGrid, CoreError> {
    let xmin = sc.read_r64()?;
    let xmax = sc.read_r64()?;
    if xmin > xmax {
        return Err(CoreError::Parse("TextGrid xmin > xmax".into()));
    }
    if !sc.read_exists()? {
        return Err(CoreError::Parse("TextGrid tiers marked <absent>".into()));
    }
    let size = sc.read_i32()?;
    if size < 0 {
        return Err(CoreError::Parse("Negative tier count".into()));
    }
    let mut tiers = Vec::with_capacity(size as usize);
    for _ in 0..size {
        let cls_tok = sc.read_string()?;
        let (class_name, version) = split_class_token(&cls_tok);
        if version > 0 {
            return Err(CoreError::Parse(format!("Unsupported tier version: {cls_tok}")));
        }
        let tier_name = sc.read_string()?;
        match class_name {
            "IntervalTier" => {
                tiers.push(read_interval_tier_text(sc, tier_name)?);
            }
            "TextTier" | "MarkTier" => {
                tiers.push(read_text_tier_text(sc, tier_name)?);
            }
            other => {
                return Err(CoreError::Parse(format!("Unknown tier class \"{other}\"")));
            }
        }
    }
    Ok(TextGrid {
        name,
        xmin,
        xmax,
        tiers,
    })
}

fn read_sound_text(sc: &mut AbcioTextScanner, name: String) -> Result<SoundObject, CoreError> {
    let xmin = sc.read_r64()?;
    let xmax = sc.read_r64()?;
    let nx = sc.read_i32()?;
    if nx < 0 {
        return Err(CoreError::Parse("Negative Sound nx".into()));
    }
    let dx = sc.read_r64()?;
    let x1 = sc.read_r64()?;
    let _ymin = sc.read_r64()?;
    let _ymax = sc.read_r64()?;
    let ny = sc.read_i32()?;
    if ny < 0 {
        return Err(CoreError::Parse("Negative Sound ny".into()));
    }
    let _dy = sc.read_r64()?;
    let _y1 = sc.read_r64()?;
    let mut channels = Vec::with_capacity(ny as usize);
    for _ in 0..ny {
        let mut ch = Vec::with_capacity(nx as usize);
        for _ in 0..nx {
            ch.push(sc.read_r64()? as f32);
        }
        channels.push(ch);
    }
    Ok(SoundObject {
        name,
        xmin,
        xmax,
        nx: nx as usize,
        dx,
        x1,
        ny: ny as usize,
        channels,
    })
}

fn read_object_text(
    sc: &mut AbcioTextScanner,
    class_tok: &str,
    name: String,
) -> Result<Vec<CollectionItem>, CoreError> {
    let (class_name, version) = split_class_token(class_tok);
    match class_name {
        "TextGrid" => {
            if version > 0 {
                return Err(CoreError::Parse(format!(
                    "Unsupported TextGrid version: {class_tok}"
                )));
            }
            Ok(vec![CollectionItem::TextGrid(read_textgrid_text(sc, name)?)])
        }
        "IntervalTier" => {
            let t = read_interval_tier_text(sc, name.clone())?;
            let (xmin, xmax) = (t.xmin, t.xmax);
            Ok(vec![CollectionItem::TextGrid(TextGrid {
                name,
                xmin,
                xmax,
                tiers: vec![t],
            })])
        }
        "TextTier" | "MarkTier" => {
            let t = read_text_tier_text(sc, name.clone())?;
            let (xmin, xmax) = (t.xmin, t.xmax);
            Ok(vec![CollectionItem::TextGrid(TextGrid {
                name,
                xmin,
                xmax,
                tiers: vec![t],
            })])
        }
        "Sound" => Ok(vec![CollectionItem::Sound(read_sound_text(sc, name)?)]),
        "Collection" => {
            let size = sc.read_i32()?;
            if size < 0 {
                return Err(CoreError::Parse("Negative Collection size".into()));
            }
            let mut items = Vec::new();
            for _ in 0..size {
                let sub_cls = sc.read_string()?;
                let sub_name = sc.read_string()?;
                items.extend(read_object_text(sc, &sub_cls, sub_name)?);
            }
            Ok(items)
        }
        other => Err(CoreError::Parse(format!(
            "Unsupported Praat object class \"{other}\""
        ))),
    }
}

fn read_chronological_textgrid(
    text: &str,
    name: String,
) -> Result<Vec<CollectionItem>, CoreError> {
    let mut sc = AbcioTextScanner::new(text);
    if sc.read_string()? != "Praat chronological TextGrid text file" {
        return Err(CoreError::Parse("Invalid chronological header".into()));
    }
    let xmin = sc.read_r64()?;
    let xmax = sc.read_r64()?;
    if xmin > xmax {
        return Err(CoreError::Parse("TextGrid xmin > xmax".into()));
    }
    let num_tiers = sc.read_i32()?;
    if num_tiers < 0 {
        return Err(CoreError::Parse("Negative tier count".into()));
    }
    let mut tiers = Vec::with_capacity(num_tiers as usize);
    for _ in 0..num_tiers {
        let cls = sc.read_string()?;
        let t_name = sc.read_string()?;
        let t_min = sc.read_r64()?;
        let t_max = sc.read_r64()?;
        if t_min > t_max {
            return Err(CoreError::Parse("Tier xmin > xmax".into()));
        }
        match cls.as_str() {
            "IntervalTier" => tiers.push(Tier {
                kind: TierKind::IntervalTier,
                name: t_name,
                xmin: t_min,
                xmax: t_max,
                intervals: Vec::new(),
                points: Vec::new(),
                display_num: None,
            }),
            "TextTier" => tiers.push(Tier {
                kind: TierKind::TextTier,
                name: t_name,
                xmin: t_min,
                xmax: t_max,
                intervals: Vec::new(),
                points: Vec::new(),
                display_num: None,
            }),
            other => {
                return Err(CoreError::Parse(format!(
                    "Unsupported tier class \"{other}\" in chronological file"
                )));
            }
        }
    }

    while sc.has_more_tokens() {
        let tier_num = sc.read_i32()?;
        if tier_num < 1 || (tier_num as usize) > tiers.len() {
            return Err(CoreError::Parse(format!("Invalid tier number {tier_num}")));
        }
        let tier = &mut tiers[(tier_num - 1) as usize];
        match tier.kind {
            TierKind::IntervalTier => {
                let a = sc.read_r64()?;
                let b = sc.read_r64()?;
                if a > b {
                    return Err(CoreError::Parse("Interval xmin > xmax".into()));
                }
                let txt = sc.read_string()?;
                insert_sorted_interval(
                    &mut tier.intervals,
                    Interval {
                        xmin: a,
                        xmax: b,
                        text: txt,
                    },
                );
            }
            TierKind::TextTier => {
                let number = sc.read_r64()?;
                let mark = sc.read_string()?;
                insert_sorted_unique(&mut tier.points, TextPoint { number, mark }, |pt| pt.number);
            }
        }
    }

    Ok(vec![CollectionItem::TextGrid(TextGrid {
        name,
        xmin,
        xmax,
        tiers,
    })])
}

fn read_interval_tier_binary(br: &mut BinaryReader<'_>, name: String) -> Result<Tier, CoreError> {
    let xmin = br.read_r64()?;
    let xmax = br.read_r64()?;
    if xmin > xmax {
        return Err(CoreError::Parse("IntervalTier xmin > xmax".into()));
    }
    let size = br.read_i32()?;
    if size < 0 {
        return Err(CoreError::Parse("Negative IntervalTier size".into()));
    }
    let mut intervals = Vec::with_capacity(size as usize);
    for _ in 0..size {
        let a = br.read_r64()?;
        let b = br.read_r64()?;
        if a > b {
            return Err(CoreError::Parse("Interval xmin > xmax".into()));
        }
        let text = br.read_w16()?;
        insert_sorted_interval(
            &mut intervals,
            Interval {
                xmin: a,
                xmax: b,
                text,
            },
        );
    }
    Ok(Tier {
        kind: TierKind::IntervalTier,
        name,
        xmin,
        xmax,
        intervals,
        points: Vec::new(),
        display_num: None,
    })
}

fn read_text_tier_binary(br: &mut BinaryReader<'_>, name: String) -> Result<Tier, CoreError> {
    let xmin = br.read_r64()?;
    let xmax = br.read_r64()?;
    if xmin > xmax {
        return Err(CoreError::Parse("TextTier xmin > xmax".into()));
    }
    let size = br.read_i32()?;
    if size < 0 {
        return Err(CoreError::Parse("Negative TextTier size".into()));
    }
    let mut points = Vec::with_capacity(size as usize);
    for _ in 0..size {
        let number = br.read_r64()?;
        let mark = br.read_w16()?;
        insert_sorted_unique(&mut points, TextPoint { number, mark }, |pt| pt.number);
    }
    Ok(Tier {
        kind: TierKind::TextTier,
        name,
        xmin,
        xmax,
        intervals: Vec::new(),
        points,
        display_num: None,
    })
}

fn read_textgrid_binary(br: &mut BinaryReader<'_>, name: String) -> Result<TextGrid, CoreError> {
    let xmin = br.read_r64()?;
    let xmax = br.read_r64()?;
    if xmin > xmax {
        return Err(CoreError::Parse("TextGrid xmin > xmax".into()));
    }
    if !br.read_bool8()? {
        return Err(CoreError::Parse(
            "Binary TextGrid tiers marked absent".into(),
        ));
    }
    let size = br.read_i32()?;
    if size < 0 {
        return Err(CoreError::Parse("Negative tier count".into()));
    }
    let mut tiers = Vec::with_capacity(size as usize);
    for _ in 0..size {
        let cls_tok = br.read_w8()?;
        let (class_name, version) = split_class_token(&cls_tok);
        if version > 0 {
            return Err(CoreError::Parse(format!("Unsupported tier version: {cls_tok}")));
        }
        let tier_name = br.read_w16()?;
        match class_name {
            "IntervalTier" => {
                tiers.push(read_interval_tier_binary(br, tier_name)?);
            }
            "TextTier" | "MarkTier" => {
                tiers.push(read_text_tier_binary(br, tier_name)?);
            }
            other => {
                return Err(CoreError::Parse(format!("Unknown tier class \"{other}\"")));
            }
        }
    }
    Ok(TextGrid {
        name,
        xmin,
        xmax,
        tiers,
    })
}

fn read_sound_binary(
    br: &mut BinaryReader<'_>,
    name: String,
    version: i32,
) -> Result<SoundObject, CoreError> {
    let xmin = br.read_r64()?;
    let xmax = br.read_r64()?;
    let nx = br.read_i32()?;
    if nx < 0 {
        return Err(CoreError::Parse("Negative Sound nx".into()));
    }
    let dx = br.read_r64()?;
    let x1 = br.read_r64()?;
    let _ymin = br.read_r64()?;
    let _ymax = br.read_r64()?;
    let ny = br.read_i32()?;
    if ny < 0 {
        return Err(CoreError::Parse("Negative Sound ny".into()));
    }
    let _dy = br.read_r64()?;
    let _y1 = br.read_r64()?;
    let mut channels = Vec::with_capacity(ny as usize);
    for _ in 0..ny {
        let mut ch = Vec::with_capacity(nx as usize);
        if version >= 2 {
            for _ in 0..nx {
                ch.push(br.read_r64()? as f32);
            }
        } else {
            for _ in 0..nx {
                ch.push(br.read_r32()?);
            }
        }
        channels.push(ch);
    }
    Ok(SoundObject {
        name,
        xmin,
        xmax,
        nx: nx as usize,
        dx,
        x1,
        ny: ny as usize,
        channels,
    })
}

fn read_object_binary(
    br: &mut BinaryReader<'_>,
    class_tok: &str,
    name: String,
) -> Result<Vec<CollectionItem>, CoreError> {
    let (class_name, version) = split_class_token(class_tok);
    match class_name {
        "TextGrid" => {
            if version > 0 {
                return Err(CoreError::Parse(format!(
                    "Unsupported TextGrid version: {class_tok}"
                )));
            }
            Ok(vec![CollectionItem::TextGrid(read_textgrid_binary(
                br, name,
            )?)])
        }
        "IntervalTier" => {
            let t = read_interval_tier_binary(br, name.clone())?;
            let (xmin, xmax) = (t.xmin, t.xmax);
            Ok(vec![CollectionItem::TextGrid(TextGrid {
                name,
                xmin,
                xmax,
                tiers: vec![t],
            })])
        }
        "TextTier" | "MarkTier" => {
            let t = read_text_tier_binary(br, name.clone())?;
            let (xmin, xmax) = (t.xmin, t.xmax);
            Ok(vec![CollectionItem::TextGrid(TextGrid {
                name,
                xmin,
                xmax,
                tiers: vec![t],
            })])
        }
        "Sound" => Ok(vec![CollectionItem::Sound(read_sound_binary(
            br, name, version,
        )?)]),
        "Collection" => {
            let size = br.read_i32()?;
            if size < 0 {
                return Err(CoreError::Parse("Negative Collection size".into()));
            }
            let mut items = Vec::new();
            for _ in 0..size {
                let sub_cls = br.read_w8()?;
                let sub_name = br.read_w16()?;
                items.extend(read_object_binary(br, &sub_cls, sub_name)?);
            }
            Ok(items)
        }
        other => Err(CoreError::Parse(format!(
            "Unsupported embedded class \"{other}\" in binary stream"
        ))),
    }
}

/* ============================================================================
 * Public Entry Points: Parse & Serialize
 * ============================================================================ */

pub fn parse_praat_bytes(bytes: &[u8], filename: &str) -> Result<ParsedDocument, CoreError> {
    if bytes.is_empty() {
        return Err(CoreError::Parse("Empty input".into()));
    }

    if bytes.len() > 13 && &bytes[..12] == b"ooBinaryFile" {
        let mut br = BinaryReader::new(bytes, 12);
        let top_cls = br.read_w8()?;
        let items = read_object_binary(&mut br, &top_cls, filename.to_string())?;
        return Ok(ParsedDocument {
            source_format: "binary".to_string(),
            items,
        });
    }

    let text = decode_praat_text_bytes(bytes);
    if text
        .trim_start()
        .starts_with("\"Praat chronological TextGrid text file\"")
    {
        let items = read_chronological_textgrid(&text, filename.to_string())?;
        return Ok(ParsedDocument {
            source_format: "chronological".to_string(),
            items,
        });
    }

    let (line1, rest) = match text.find('\n') {
        Some(idx) => (&text[..idx], &text[idx + 1..]),
        None => (text.as_str(), ""),
    };
    if line1.contains("ooText2File") {
        return Err(CoreError::Parse(
            "Unsupported future ooText2File format".into(),
        ));
    }
    if line1.contains("ooTextFile") {
        let mut sc = AbcioTextScanner::new(rest);
        let top_cls = sc.read_string()?;
        let items = read_object_text(&mut sc, &top_cls, filename.to_string())?;
        let fmt = if rest.contains("xmin =") || rest.contains("item [") {
            "longText"
        } else {
            "shortText"
        };
        return Ok(ParsedDocument {
            source_format: fmt.to_string(),
            items,
        });
    }

    Err(CoreError::Parse(
        "Unrecognized Praat TextGrid or Collection file".into(),
    ))
}

pub fn parse_textgrid_bytes(bytes: &[u8]) -> Result<TextGrid, CoreError> {
    let doc = parse_praat_bytes(bytes, "")?;
    for item in doc.items {
        if let CollectionItem::TextGrid(tg) = item {
            return Ok(tg);
        }
    }
    Err(CoreError::Parse(
        "No TextGrid found inside Praat document".into(),
    ))
}

pub fn serialize_textgrid(tg: &TextGrid, format: TextGridFormat) -> Result<Vec<u8>, CoreError> {
    match format {
        TextGridFormat::LongText => Ok(serialize_long_text(tg).into_bytes()),
        TextGridFormat::ShortText => Ok(serialize_short_text(tg).into_bytes()),
        TextGridFormat::Binary => Ok(serialize_binary(tg)),
        TextGridFormat::Chronological => Ok(serialize_chronological(tg).into_bytes()),
    }
}

pub fn serialize_long_text(tg: &TextGrid) -> String {
    let mut lines = Vec::with_capacity(16 + tg.tiers.len() * 12);
    lines.push("File type = \"ooTextFile\"".to_string());
    lines.push("Object class = \"TextGrid\"".to_string());
    lines.push(String::new());
    lines.push(format!("xmin = {} ", format_praat_double(tg.xmin)));
    lines.push(format!("xmax = {} ", format_praat_double(tg.xmax)));
    lines.push("tiers? <exists> ".to_string());
    lines.push(format!("size = {} ", tg.tiers.len()));
    lines.push(if tg.tiers.is_empty() {
        "item []: (empty)".to_string()
    } else {
        "item []: ".to_string()
    });

    for (idx, tier) in tg.tiers.iter().enumerate() {
        lines.push(format!("    item [{}]:", idx + 1));
        lines.push(format!(
            "        class = {} ",
            escape_praat_str(tier.kind.praat_class_name())
        ));
        lines.push(format!("        name = {} ", escape_praat_str(&tier.name)));
        lines.push(format!(
            "        xmin = {} ",
            format_praat_double(tier.xmin)
        ));
        lines.push(format!(
            "        xmax = {} ",
            format_praat_double(tier.xmax)
        ));
        match tier.kind {
            TierKind::IntervalTier => {
                lines.push(format!(
                    "        intervals: size = {} ",
                    tier.intervals.len()
                ));
                for (j, iv) in tier.intervals.iter().enumerate() {
                    lines.push(format!("        intervals [{}]:", j + 1));
                    lines.push(format!(
                        "            xmin = {} ",
                        format_praat_double(iv.xmin)
                    ));
                    lines.push(format!(
                        "            xmax = {} ",
                        format_praat_double(iv.xmax)
                    ));
                    lines.push(format!(
                        "            text = {} ",
                        escape_praat_str(&iv.text)
                    ));
                }
            }
            TierKind::TextTier => {
                lines.push(format!("        points: size = {} ", tier.points.len()));
                for (j, pt) in tier.points.iter().enumerate() {
                    lines.push(format!("        points [{}]:", j + 1));
                    lines.push(format!(
                        "            number = {} ",
                        format_praat_double(pt.number)
                    ));
                    lines.push(format!(
                        "            mark = {} ",
                        escape_praat_str(&pt.mark)
                    ));
                }
            }
        }
    }

    let mut out = lines.join("\n");
    out.push('\n');
    out
}

pub fn serialize_short_text(tg: &TextGrid) -> String {
    let mut lines = Vec::with_capacity(12 + tg.tiers.len() * 10);
    lines.push("File type = \"ooTextFile\"".to_string());
    lines.push("Object class = \"TextGrid\"".to_string());
    lines.push(String::new());
    lines.push(format_praat_double(tg.xmin));
    lines.push(format_praat_double(tg.xmax));
    lines.push("<exists>".to_string());
    lines.push(tg.tiers.len().to_string());

    for tier in &tg.tiers {
        lines.push(escape_praat_str(tier.kind.praat_class_name()));
        lines.push(escape_praat_str(&tier.name));
        lines.push(format_praat_double(tier.xmin));
        lines.push(format_praat_double(tier.xmax));
        match tier.kind {
            TierKind::IntervalTier => {
                lines.push(tier.intervals.len().to_string());
                for iv in &tier.intervals {
                    lines.push(format_praat_double(iv.xmin));
                    lines.push(format_praat_double(iv.xmax));
                    lines.push(escape_praat_str(&iv.text));
                }
            }
            TierKind::TextTier => {
                lines.push(tier.points.len().to_string());
                for pt in &tier.points {
                    lines.push(format_praat_double(pt.number));
                    lines.push(escape_praat_str(&pt.mark));
                }
            }
        }
    }

    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn write_textgrid_body_binary(bw: &mut BinaryWriter, tg: &TextGrid) {
    bw.write_r64(tg.xmin);
    bw.write_r64(tg.xmax);
    bw.write_u8(1);
    bw.write_i32(tg.tiers.len() as i32);
    for tier in &tg.tiers {
        bw.write_w8(tier.kind.praat_class_name());
        bw.write_w16(&tier.name);
        bw.write_r64(tier.xmin);
        bw.write_r64(tier.xmax);
        match tier.kind {
            TierKind::IntervalTier => {
                bw.write_i32(tier.intervals.len() as i32);
                for iv in &tier.intervals {
                    bw.write_r64(iv.xmin);
                    bw.write_r64(iv.xmax);
                    bw.write_w16(&iv.text);
                }
            }
            TierKind::TextTier => {
                bw.write_i32(tier.points.len() as i32);
                for pt in &tier.points {
                    bw.write_r64(pt.number);
                    bw.write_w16(&pt.mark);
                }
            }
        }
    }
}

pub fn serialize_binary(tg: &TextGrid) -> Vec<u8> {
    let mut bw = BinaryWriter::new();
    bw.write_ascii_raw("ooBinaryFile");
    bw.write_w8("TextGrid");
    write_textgrid_body_binary(&mut bw, tg);
    bw.into_bytes()
}

pub fn serialize_chronological(tg: &TextGrid) -> String {
    let mut lines = vec![
        "\"Praat chronological TextGrid text file\"".to_string(),
        format!(
            "{} {}   ! Time domain.",
            format_praat_double(tg.xmin),
            format_praat_double(tg.xmax)
        ),
        format!("{}   ! Number of tiers.", tg.tiers.len()),
    ];

    enum Ev<'a> {
        Iv(&'a Interval),
        Pt(&'a TextPoint),
    }
    struct ChronoEvent<'a> {
        t: f64,
        tier_idx: usize,
        tier_name: &'a str,
        ev: Ev<'a>,
    }

    let mut events = Vec::new();
    for (idx, tier) in tg.tiers.iter().enumerate() {
        lines.push(format!(
            "{} {} {} {}",
            escape_praat_str(tier.kind.praat_class_name()),
            escape_praat_str(&tier.name),
            format_praat_double(tier.xmin),
            format_praat_double(tier.xmax)
        ));
        match tier.kind {
            TierKind::IntervalTier => {
                for iv in &tier.intervals {
                    events.push(ChronoEvent {
                        t: iv.xmin,
                        tier_idx: idx,
                        tier_name: &tier.name,
                        ev: Ev::Iv(iv),
                    });
                }
            }
            TierKind::TextTier => {
                for pt in &tier.points {
                    events.push(ChronoEvent {
                        t: pt.number,
                        tier_idx: idx,
                        tier_name: &tier.name,
                        ev: Ev::Pt(pt),
                    });
                }
            }
        }
    }

    events.sort_by(|a, b| {
        a.t.total_cmp(&b.t)
            .then_with(|| a.tier_idx.cmp(&b.tier_idx))
            .then_with(|| match (&a.ev, &b.ev) {
                (Ev::Iv(ia), Ev::Iv(ib)) => ia.xmax.total_cmp(&ib.xmax),
                _ => std::cmp::Ordering::Equal,
            })
    });

    for item in events {
        lines.push(String::new());
        let safe_name = item.tier_name.replace(['\r', '\n'], " ");
        if !safe_name.is_empty() {
            lines.push(format!("! {safe_name}:"));
        }
        match item.ev {
            Ev::Iv(iv) => {
                lines.push(format!(
                    "{} {} {}",
                    item.tier_idx + 1,
                    format_praat_double(iv.xmin),
                    format_praat_double(iv.xmax)
                ));
                lines.push(escape_praat_str(&iv.text));
            }
            Ev::Pt(pt) => {
                lines.push(format!(
                    "{} {} ",
                    item.tier_idx + 1,
                    format_praat_double(pt.number)
                ));
                lines.push(escape_praat_str(&pt.mark));
            }
        }
    }

    lines.join("\n")
}

fn write_sound_body_binary(bw: &mut BinaryWriter, sound: &SoundObject) {
    let ny = sound.ny.max(sound.channels.len()).max(1);
    let nx = sound
        .nx
        .max(sound.channels.first().map(|c| c.len()).unwrap_or(0));
    let dx = if sound.dx > 0.0 {
        sound.dx
    } else {
        1.0 / 16000.0
    };
    let xmin = if sound.xmin.is_finite() {
        sound.xmin
    } else {
        0.0
    };
    let xmax = if sound.xmax.is_finite() {
        sound.xmax
    } else {
        xmin + (nx as f64) * dx
    };
    let x1 = if sound.x1.is_finite() {
        sound.x1
    } else {
        xmin + 0.5 * dx
    };

    bw.write_r64(xmin);
    bw.write_r64(xmax);
    bw.write_i32(nx as i32);
    bw.write_r64(dx);
    bw.write_r64(x1);
    bw.write_r64(1.0);
    bw.write_r64(ny as f64);
    bw.write_i32(ny as i32);
    bw.write_r64(1.0);
    bw.write_r64(1.0);

    for ch in 0..ny {
        let samples = sound.channels.get(ch);
        for i in 0..nx {
            let v = samples.and_then(|s| s.get(i)).copied().unwrap_or(0.0) as f64;
            bw.write_r64(if v.is_finite() { v } else { 0.0 });
        }
    }
}

pub fn serialize_collection(
    items: &[CollectionItem],
    format: CollectionFormat,
) -> Result<Vec<u8>, CoreError> {
    match format {
        CollectionFormat::Binary => {
            let mut bw = BinaryWriter::new();
            bw.write_ascii_raw("ooBinaryFile");
            bw.write_w8("Collection");
            bw.write_i32(items.len() as i32);
            for item in items {
                match item {
                    CollectionItem::TextGrid(tg) => {
                        bw.write_w8("TextGrid");
                        bw.write_w16(&tg.name);
                        write_textgrid_body_binary(&mut bw, tg);
                    }
                    CollectionItem::Sound(snd) => {
                        bw.write_w8("Sound 2");
                        bw.write_w16(&snd.name);
                        write_sound_body_binary(&mut bw, snd);
                    }
                }
            }
            Ok(bw.into_bytes())
        }
        CollectionFormat::LongText => {
            let mut lines = vec![
                "File type = \"ooTextFile\"".to_string(),
                "Object class = \"Collection\"".to_string(),
                String::new(),
                format!("size = {} ", items.len()),
                if items.is_empty() {
                    "item []: (empty)".to_string()
                } else {
                    "item []: ".to_string()
                },
            ];
            for (idx, item) in items.iter().enumerate() {
                lines.push(format!("    item [{}]:", idx + 1));
                match item {
                    CollectionItem::Sound(snd) => {
                        let ny = snd.ny.max(snd.channels.len()).max(1);
                        let nx = snd
                            .nx
                            .max(snd.channels.first().map(|c| c.len()).unwrap_or(0));
                        let dx = if snd.dx > 0.0 { snd.dx } else { 1.0 / 16000.0 };
                        let xmin = if snd.xmin.is_finite() { snd.xmin } else { 0.0 };
                        let xmax = if snd.xmax.is_finite() {
                            snd.xmax
                        } else {
                            xmin + (nx as f64) * dx
                        };
                        let x1 = if snd.x1.is_finite() {
                            snd.x1
                        } else {
                            xmin + 0.5 * dx
                        };
                        lines.push("        class = \"Sound 2\" ".to_string());
                        lines.push(format!("        name = {} ", escape_praat_str(&snd.name)));
                        lines.push(format!("        xmin = {} ", format_praat_double(xmin)));
                        lines.push(format!("        xmax = {} ", format_praat_double(xmax)));
                        lines.push(format!("        nx = {nx} "));
                        lines.push(format!("        dx = {} ", format_praat_double(dx)));
                        lines.push(format!("        x1 = {} ", format_praat_double(x1)));
                        lines.push("        ymin = 1 ".to_string());
                        lines.push(format!("        ymax = {ny} "));
                        lines.push(format!("        ny = {ny} "));
                        lines.push("        dy = 1 ".to_string());
                        lines.push("        y1 = 1 ".to_string());
                        lines.push("        z [] []: ".to_string());
                        for ch in 0..ny {
                            lines.push(format!("            z [{}] []:", ch + 1));
                            let samples = snd.channels.get(ch);
                            for i in 0..nx {
                                let v = samples.and_then(|s| s.get(i)).copied().unwrap_or(0.0)
                                    as f64;
                                lines.push(format!(
                                    "                z [{}] [{}] = {} ",
                                    ch + 1,
                                    i + 1,
                                    format_praat_double(v)
                                ));
                            }
                        }
                    }
                    CollectionItem::TextGrid(tg) => {
                        lines.push("        class = \"TextGrid\" ".to_string());
                        lines.push(format!("        name = {} ", escape_praat_str(&tg.name)));
                        lines.push(format!("        xmin = {} ", format_praat_double(tg.xmin)));
                        lines.push(format!("        xmax = {} ", format_praat_double(tg.xmax)));
                        lines.push("        tiers? <exists> ".to_string());
                        lines.push(format!("        size = {} ", tg.tiers.len()));
                        lines.push(if tg.tiers.is_empty() {
                            "        item []: (empty)".to_string()
                        } else {
                            "        item []: ".to_string()
                        });
                        for (t_idx, tier) in tg.tiers.iter().enumerate() {
                            lines.push(format!("            item [{}]:", t_idx + 1));
                            lines.push(format!(
                                "                class = {} ",
                                escape_praat_str(tier.kind.praat_class_name())
                            ));
                            lines.push(format!(
                                "                name = {} ",
                                escape_praat_str(&tier.name)
                            ));
                            lines.push(format!(
                                "                xmin = {} ",
                                format_praat_double(tier.xmin)
                            ));
                            lines.push(format!(
                                "                xmax = {} ",
                                format_praat_double(tier.xmax)
                            ));
                            match tier.kind {
                                TierKind::IntervalTier => {
                                    lines.push(format!(
                                        "                intervals: size = {} ",
                                        tier.intervals.len()
                                    ));
                                    for (j, iv) in tier.intervals.iter().enumerate() {
                                        lines.push(format!(
                                            "                intervals [{}]:",
                                            j + 1
                                        ));
                                        lines.push(format!(
                                            "                    xmin = {} ",
                                            format_praat_double(iv.xmin)
                                        ));
                                        lines.push(format!(
                                            "                    xmax = {} ",
                                            format_praat_double(iv.xmax)
                                        ));
                                        lines.push(format!(
                                            "                    text = {} ",
                                            escape_praat_str(&iv.text)
                                        ));
                                    }
                                }
                                TierKind::TextTier => {
                                    lines.push(format!(
                                        "                points: size = {} ",
                                        tier.points.len()
                                    ));
                                    for (j, pt) in tier.points.iter().enumerate() {
                                        lines.push(format!("                points [{}]:", j + 1));
                                        lines.push(format!(
                                            "                    number = {} ",
                                            format_praat_double(pt.number)
                                        ));
                                        lines.push(format!(
                                            "                    mark = {} ",
                                            escape_praat_str(&pt.mark)
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }
            }
            let mut out = lines.join("\n");
            out.push('\n');
            Ok(out.into_bytes())
        }
    }
}
