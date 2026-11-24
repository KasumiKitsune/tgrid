use crate::ipa_data::{
    IPA_GLOSSARY, PRAAT_AL0_PACK, PRAAT_AL1_PACK, PRAAT_AL2_PACK, YUNLONG_INITIALS,
    YUNLONG_NON_TONE_PACK,
};
use crate::model::{IpaCandidate, IpaConvertResult, IpaSymbolInfo, PraatMatch, YunlongStepResult};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::OnceLock;

#[derive(Debug, Clone)]
struct YlExact {
    text: String,
    code: String,
    order: usize,
}

#[derive(Debug, Default)]
struct YlNode {
    children: BTreeMap<char, YlNode>,
    exact: Vec<YlExact>,
}

#[derive(Debug, Clone)]
struct PraatEntry {
    code: String,
    ch: char,
    cp: u32,
    al: u8,
    rank: u8,
    is_combining: bool,
}

pub struct IpaEngine {
    yl_root: YlNode,
    yl_initials: HashSet<char>,
    yl_entry_count: usize,
    char_to_yunlong: HashMap<String, Vec<String>>,
    praat_entries: Vec<PraatEntry>,
    praat_by_code: HashMap<String, usize>,
    char_to_praat: HashMap<char, String>,
    glossary: HashMap<&'static str, &'static str>,
}

#[inline]
pub fn is_combining_code_point(cp: u32) -> bool {
    (0x0300..=0x036F).contains(&cp)
        || (0x1DC0..=0x1DFF).contains(&cp)
        || (0x1AB0..=0x1AFF).contains(&cp)
        || (0x20D0..=0x20FF).contains(&cp)
}

pub fn format_display_glyph(sym: &str) -> String {
    if sym.is_empty() {
        return String::new();
    }
    if sym == "\u{0361}" {
        return "\u{25CC}\u{0361}\u{25CC}".to_string();
    }
    if sym == "\u{035C}" {
        return "\u{25CC}\u{035C}\u{25CC}".to_string();
    }
    if let Some(first) = sym.chars().next() {
        if is_combining_code_point(first as u32) {
            let mut out = String::with_capacity(sym.len() + 3);
            out.push('\u{25CC}');
            out.push_str(sym);
            return out;
        }
    }
    sym.to_string()
}

pub fn format_unicode_points(sym: &str) -> String {
    sym.chars()
        .map(|c| format!("U+{:04X}", c as u32))
        .collect::<Vec<_>>()
        .join(" ")
}

impl IpaEngine {
    fn build() -> Self {
        let mut engine = Self {
            yl_root: YlNode::default(),
            yl_initials: YUNLONG_INITIALS.chars().collect(),
            yl_entry_count: 0,
            char_to_yunlong: HashMap::new(),
            praat_entries: Vec::with_capacity(420),
            praat_by_code: HashMap::with_capacity(420),
            char_to_praat: HashMap::with_capacity(420),
            glossary: IPA_GLOSSARY.iter().copied().collect(),
        };

        // 1. Deterministic Yunlong Chao tone generator (330 entries)
        let sets: [(&str, [char; 5], [char; 5]); 2] = [
            (
                "/",
                ['\u{A70C}', '\u{A70B}', '\u{A70A}', '\u{A709}', '\u{A708}'],
                ['\u{02E9}', '\u{02E8}', '\u{02E7}', '\u{02E6}', '\u{02E5}'],
            ),
            (
                "\\",
                ['\u{A711}', '\u{A710}', '\u{A70F}', '\u{A70E}', '\u{A70D}'],
                ['\u{A716}', '\u{A715}', '\u{A714}', '\u{A713}', '\u{A712}'],
            ),
        ];

        for (pfx, dot, bar) in sets {
            for a in 0..5 {
                let ca = char::from_digit((a + 1) as u32, 10).unwrap();
                engine.add_yunlong_entry(format!("{pfx}{ca}"), dot[a].to_string());
                for b in 0..5 {
                    let cb = char::from_digit((b + 1) as u32, 10).unwrap();
                    let t2 = if a == b {
                        bar[a].to_string()
                    } else {
                        format!("{}{}", bar[a], bar[b])
                    };
                    engine.add_yunlong_entry(format!("{pfx}{ca}{cb}"), t2);
                    for c in 0..5 {
                        let cc = char::from_digit((c + 1) as u32, 10).unwrap();
                        let t3 = if a == b && b == c {
                            format!("{}{}", bar[a], bar[a])
                        } else {
                            format!("{}{}{}", bar[a], bar[b], bar[c])
                        };
                        engine.add_yunlong_entry(format!("{pfx}{ca}{cb}{cc}"), t3);
                    }
                }
            }
        }
        for a in 0..5 {
            let ca = char::from_digit((a + 1) as u32, 10).unwrap();
            engine.add_yunlong_entry(format!("p{ca}0"), sets[0].1[a].to_string());
            engine.add_yunlong_entry(format!("p{ca}{ca}"), sets[0].2[a].to_string());
            engine.add_yunlong_entry(format!("pp{ca}0"), sets[1].1[a].to_string());
            engine.add_yunlong_entry(format!("pp{ca}{ca}"), sets[1].2[a].to_string());
        }

        // 2. Unpack exact 317 non-tone Yunlong entries
        let toks: Vec<&str> = YUNLONG_NON_TONE_PACK.split(' ').collect();
        let mut i = 0;
        while i + 1 < toks.len() {
            engine.add_yunlong_entry(toks[i].to_string(), toks[i + 1].to_string());
            i += 2;
        }

        // 3. Unpack exact 408 Praat Longchar_database entries in C++ order (0 -> 1 -> 2)
        engine.unpack_praat(PRAAT_AL0_PACK, 0);
        engine.unpack_praat(PRAAT_AL1_PACK, 1);
        engine.unpack_praat(PRAAT_AL2_PACK, 2);

        engine
    }

    fn add_yunlong_entry(&mut self, code: String, text: String) {
        let order = self.yl_entry_count;
        self.yl_entry_count += 1;
        let mut node = &mut self.yl_root;
        for c in code.chars() {
            node = node.children.entry(c).or_default();
        }
        node.exact.push(YlExact {
            text: text.clone(),
            code: code.clone(),
            order,
        });
        self.char_to_yunlong
            .entry(text.clone())
            .or_default()
            .push(code.clone());
        if text.contains('\u{FE00}') {
            let bare = text.replace('\u{FE00}', "");
            self.char_to_yunlong.entry(bare).or_default().push(code);
        }
    }

    fn unpack_praat(&mut self, pack: &str, al: u8) {
        let rank = match al {
            2 => 0,
            0 => 1,
            _ => 2,
        };
        let chars: Vec<char> = pack.chars().collect();
        let mut i = 0;
        while i + 2 < chars.len() {
            let mut code = String::with_capacity(2);
            code.push(chars[i]);
            code.push(chars[i + 1]);
            let ch = chars[i + 2];
            let cp = ch as u32;
            let idx = self.praat_entries.len();
            self.praat_entries.push(PraatEntry {
                code: code.clone(),
                ch,
                cp,
                al,
                rank,
                is_combining: is_combining_code_point(cp),
            });
            self.praat_by_code.insert(code.clone(), idx);
            if cp > 128 {
                self.char_to_praat.insert(ch, code);
            }
            i += 3;
        }
    }

    fn get_yl_node(&self, prefix: &str) -> Option<&YlNode> {
        let mut node = &self.yl_root;
        for c in prefix.chars() {
            node = node.children.get(&c)?;
        }
        Some(node)
    }

    pub fn yunlong_entry_count(&self) -> usize {
        self.yl_entry_count
    }

    pub fn praat_entry_count(&self) -> usize {
        self.praat_entries.len()
    }

    pub fn is_yunlong_auto_leaf(&self, buffer: &str) -> bool {
        matches!(
            self.get_yl_node(buffer),
            Some(node) if node.children.is_empty() && node.exact.len() == 1
        )
    }

    pub fn get_yunlong_candidates(&self, buffer: &str) -> Vec<IpaCandidate> {
        if buffer.is_empty() {
            return Vec::new();
        }
        let Some(node) = self.get_yl_node(buffer) else {
            return Vec::new();
        };

        let mut list = Vec::new();
        if buffer.chars().count() == 1 && node.exact.is_empty() {
            list.push(IpaCandidate {
                text: buffer.to_string(),
                code: buffer.to_string(),
                suffix: String::new(),
                synthetic: true,
                exact: true,
            });
        }
        for item in &node.exact {
            list.push(IpaCandidate {
                text: item.text.clone(),
                code: item.code.clone(),
                suffix: String::new(),
                synthetic: false,
                exact: true,
            });
        }

        let mut queue: VecDeque<(&YlNode, String)> = VecDeque::new();
        for (&ch, child) in &node.children {
            queue.push_back((child, ch.to_string()));
        }
        let mut desc: Vec<(usize, usize, IpaCandidate)> = Vec::new();
        while let Some((cur, suffix)) = queue.pop_front() {
            if desc.len() >= 180 {
                break;
            }
            for item in &cur.exact {
                desc.push((
                    suffix.chars().count(),
                    item.order,
                    IpaCandidate {
                        text: item.text.clone(),
                        code: item.code.clone(),
                        suffix: suffix.clone(),
                        synthetic: false,
                        exact: false,
                    },
                ));
            }
            for (&ch, child) in &cur.children {
                let mut next_suf = suffix.clone();
                next_suf.push(ch);
                queue.push_back((child, next_suf));
            }
        }
        desc.sort_by_key(|(slen, ord, _)| (*slen, *ord));
        for (_, _, c) in desc {
            list.push(c);
        }
        list
    }

    pub fn step_yunlong_char(&self, buffer: &str, ch: char) -> YunlongStepResult {
        if buffer.is_empty() {
            if !self.yl_initials.contains(&ch) {
                return YunlongStepResult {
                    action: "passthrough".into(),
                    commit: String::new(),
                    recent: Vec::new(),
                    buffer: String::new(),
                };
            }
            let s = ch.to_string();
            if self.is_yunlong_auto_leaf(&s) {
                let leaf = self.get_yl_node(&s).unwrap().exact[0].text.clone();
                return YunlongStepResult {
                    action: "commit".into(),
                    commit: leaf.clone(),
                    recent: vec![leaf],
                    buffer: String::new(),
                };
            }
            return YunlongStepResult {
                action: "compose".into(),
                commit: String::new(),
                recent: Vec::new(),
                buffer: s,
            };
        }

        let mut next_buf = String::with_capacity(buffer.len() + 4);
        next_buf.push_str(buffer);
        next_buf.push(ch);

        if self.get_yl_node(&next_buf).is_some() {
            if self.is_yunlong_auto_leaf(&next_buf) {
                let leaf = self.get_yl_node(&next_buf).unwrap().exact[0].text.clone();
                return YunlongStepResult {
                    action: "commit".into(),
                    commit: leaf.clone(),
                    recent: vec![leaf],
                    buffer: String::new(),
                };
            }
            return YunlongStepResult {
                action: "compose".into(),
                commit: String::new(),
                recent: Vec::new(),
                buffer: next_buf,
            };
        }

        let cands = self.get_yunlong_candidates(buffer);
        let first_commit = cands
            .first()
            .map(|c| c.text.clone())
            .unwrap_or_else(|| buffer.to_string());

        if ch.is_ascii_digit() {
            let mut commit = first_commit.clone();
            commit.push(ch);
            return YunlongStepResult {
                action: "commit_and_literal".into(),
                commit,
                recent: vec![first_commit],
                buffer: String::new(),
            };
        }

        if self.yl_initials.contains(&ch) {
            let s = ch.to_string();
            if self.is_yunlong_auto_leaf(&s) {
                let leaf = self.get_yl_node(&s).unwrap().exact[0].text.clone();
                return YunlongStepResult {
                    action: "commit".into(),
                    commit: format!("{first_commit}{leaf}"),
                    recent: vec![first_commit, leaf],
                    buffer: String::new(),
                };
            }
            return YunlongStepResult {
                action: "commit_and_compose".into(),
                commit: first_commit.clone(),
                recent: vec![first_commit],
                buffer: s,
            };
        }

        let mut commit = first_commit.clone();
        commit.push(ch);
        YunlongStepResult {
            action: "commit_and_literal".into(),
            commit,
            recent: vec![first_commit],
            buffer: String::new(),
        }
    }

    pub fn get_praat_matches(&self, first_char: Option<char>) -> Vec<PraatMatch> {
        const STARTERS: &[&str] = &[
            "sw", "sh", "s.", "cc", "zc", "ef", "er", "sr", "ng", "nj", "^h", ":f", "-5", "-4",
            "-3", "-2", "-1", "'1", "'2", "?g", "as", "ab", "ct", "ae", "ic", "hs", "vt", "dh",
            "tf", "bf", "~^", "0v", "|v", "li", "id", "ir", "bs",
        ];

        match first_char {
            None => STARTERS
                .iter()
                .filter_map(|&code| self.praat_by_code.get(code).map(|&idx| &self.praat_entries[idx]))
                .map(|e| PraatMatch {
                    code: e.code.clone(),
                    ch: e.ch.to_string(),
                    cp: e.cp,
                    al: e.al,
                    is_combining: e.is_combining,
                })
                .collect(),
            Some(fc) => {
                let mut matches: Vec<&PraatEntry> = self
                    .praat_entries
                    .iter()
                    .filter(|e| e.code.starts_with(fc))
                    .collect();
                matches.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.code.cmp(&b.code)));
                matches
                    .into_iter()
                    .map(|e| PraatMatch {
                        code: e.code.clone(),
                        ch: e.ch.to_string(),
                        cp: e.cp,
                        al: e.al,
                        is_combining: e.is_combining,
                    })
                    .collect()
            }
        }
    }

    pub fn decode_praat_trigraphs(&self, input: &str) -> IpaConvertResult {
        if !input.contains('\\') {
            return IpaConvertResult {
                text: input.to_string(),
                changed: false,
            };
        }
        let chars: Vec<char> = input.chars().collect();
        let n = chars.len();
        let mut out = String::with_capacity(input.len());
        let mut changed = false;
        let mut i = 0;
        let mut code_buf = String::with_capacity(2);
        while i < n {
            if chars[i] == '\\' && i + 2 < n {
                code_buf.clear();
                code_buf.push(chars[i + 1]);
                code_buf.push(chars[i + 2]);
                if let Some(&idx) = self.praat_by_code.get(&code_buf) {
                    out.push(self.praat_entries[idx].ch);
                    changed = true;
                    i += 3;
                    continue;
                }
            }
            out.push(chars[i]);
            i += 1;
        }
        IpaConvertResult {
            text: if changed { out } else { input.to_string() },
            changed,
        }
    }

    pub fn has_praat_trigraphs(&self, input: &str) -> bool {
        if !input.contains('\\') {
            return false;
        }
        let chars: Vec<char> = input.chars().collect();
        let n = chars.len();
        let mut code_buf = String::with_capacity(2);
        for i in 0..n {
            if chars[i] == '\\' && i + 2 < n {
                code_buf.clear();
                code_buf.push(chars[i + 1]);
                code_buf.push(chars[i + 2]);
                if self.praat_by_code.contains_key(&code_buf) {
                    return true;
                }
            }
        }
        false
    }

    pub fn encode_praat_trigraphs(&self, input: &str) -> IpaConvertResult {
        if input.is_empty() {
            return IpaConvertResult {
                text: String::new(),
                changed: false,
            };
        }
        let mut out = String::with_capacity(input.len());
        let mut changed = false;
        for ch in input.chars() {
            if (ch as u32) > 128 {
                if let Some(code) = self.char_to_praat.get(&ch) {
                    out.push('\\');
                    out.push_str(code);
                    changed = true;
                    continue;
                }
            }
            out.push(ch);
        }
        IpaConvertResult {
            text: if changed { out } else { input.to_string() },
            changed,
        }
    }

    pub fn lookup_symbol(&self, sym: &str) -> IpaSymbolInfo {
        let mut yl_codes: Vec<String> = self
            .char_to_yunlong
            .get(sym)
            .cloned()
            .unwrap_or_default();
        let mut seen = HashSet::new();
        yl_codes.retain(|c| seen.insert(c.clone()));
        yl_codes.sort_by(|a, b| {
            let is_p = |s: &str| {
                let bytes = s.as_bytes();
                (bytes.len() >= 2 && bytes[0] == b'p' && bytes[1].is_ascii_digit())
                    || (bytes.len() >= 3
                        && bytes[0] == b'p'
                        && bytes[1] == b'p'
                        && bytes[2].is_ascii_digit())
            };
            is_p(a).cmp(&is_p(b)).then_with(|| a.len().cmp(&b.len()))
        });
        yl_codes.truncate(2);

        let praat = if sym == "\\" {
            "\\bs".to_string()
        } else {
            let mut chars = sym.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => self
                    .char_to_praat
                    .get(&c)
                    .map(|code| format!("\\{code}"))
                    .unwrap_or_default(),
                _ => String::new(),
            }
        };

        let is_combining = {
            let mut chars = sym.chars();
            matches!((chars.next(), chars.next()), (Some(c), None) if is_combining_code_point(c as u32))
        };

        IpaSymbolInfo {
            sym: sym.to_string(),
            display: format_display_glyph(sym),
            name: self.glossary.get(sym).copied().unwrap_or("").to_string(),
            yunlong: yl_codes,
            praat,
            unicode: format_unicode_points(sym),
            is_combining,
        }
    }
}

pub fn ipa_engine() -> &'static IpaEngine {
    static ENGINE: OnceLock<IpaEngine> = OnceLock::new();
    ENGINE.get_or_init(IpaEngine::build)
}
