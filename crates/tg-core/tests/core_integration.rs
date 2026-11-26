use std::fs;
use std::path::Path;
use tg_core::ipa::ipa_engine;
use tg_core::model::{
    CollectionFormat, CollectionItem, ContourBox, Interval, SliceOptions, TextGrid, TextGridFormat,
    TextPoint, Tier, TierKind, ZipEntryInput,
};
use tg_core::zip::crc32;
use tg_core::{
    build_zip_store, decode_praat_trigraphs, encode_praat_trigraphs, generate_spectrogram_contours,
    get_praat_matches, get_yunlong_candidates, has_praat_trigraphs, lookup_ipa_symbol,
    parse_praat_bytes, parse_textgrid_bytes, scan_diagnostics, serialize_collection,
    serialize_textgrid, slice_textgrid, step_yunlong_char,
};

fn assert_textgrid_approx_eq(a: &TextGrid, b: &TextGrid, tol: f64) {
    assert!(
        (a.xmin - b.xmin).abs() <= tol,
        "xmin mismatch: {} vs {}",
        a.xmin,
        b.xmin
    );
    assert!(
        (a.xmax - b.xmax).abs() <= tol,
        "xmax mismatch: {} vs {}",
        a.xmax,
        b.xmax
    );
    assert_eq!(a.tiers.len(), b.tiers.len(), "tier count mismatch");
    for (ti, (ta, tb)) in a.tiers.iter().zip(b.tiers.iter()).enumerate() {
        assert_eq!(ta.kind, tb.kind, "tier {ti} kind mismatch");
        assert_eq!(ta.name, tb.name, "tier {ti} name mismatch");
        assert!(
            (ta.xmin - tb.xmin).abs() <= tol,
            "tier {ti} xmin mismatch: {} vs {}",
            ta.xmin,
            tb.xmin
        );
        assert!(
            (ta.xmax - tb.xmax).abs() <= tol,
            "tier {ti} xmax mismatch: {} vs {}",
            ta.xmax,
            tb.xmax
        );
        match ta.kind {
            TierKind::IntervalTier => {
                assert_eq!(
                    ta.intervals.len(),
                    tb.intervals.len(),
                    "tier {ti} interval count mismatch"
                );
                for (ii, (ia, ib)) in ta.intervals.iter().zip(tb.intervals.iter()).enumerate() {
                    assert!(
                        (ia.xmin - ib.xmin).abs() <= tol,
                        "tier {ti} interval {ii} xmin mismatch"
                    );
                    assert!(
                        (ia.xmax - ib.xmax).abs() <= tol,
                        "tier {ti} interval {ii} xmax mismatch"
                    );
                    assert_eq!(ia.text, ib.text, "tier {ti} interval {ii} text mismatch");
                }
            }
            TierKind::TextTier => {
                assert_eq!(
                    ta.points.len(),
                    tb.points.len(),
                    "tier {ti} point count mismatch"
                );
                for (pi, (pa, pb)) in ta.points.iter().zip(tb.points.iter()).enumerate() {
                    assert!(
                        (pa.number - pb.number).abs() <= tol,
                        "tier {ti} point {pi} time mismatch"
                    );
                    assert_eq!(pa.mark, pb.mark, "tier {ti} point {pi} mark mismatch");
                }
            }
        }
    }
}

#[test]
fn test_sample_dialogue_parse_and_roundtrip_all_formats() {
    let sample_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/web/public/samples/two_speaker_dialogue.TextGrid");
    let bytes = fs::read(&sample_path).expect("read two_speaker_dialogue.TextGrid");
    let doc = parse_praat_bytes(&bytes, "two_speaker_dialogue.TextGrid").expect("parse dialogue");
    assert_eq!(doc.items.len(), 1);
    let tg = match &doc.items[0] {
        CollectionItem::TextGrid(tg) => tg,
        _ => panic!("expected TextGrid"),
    };
    assert!(tg.tiers.len() >= 2);
    assert!(tg.xmax > 10.0);

    for fmt in [
        TextGridFormat::LongText,
        TextGridFormat::ShortText,
        TextGridFormat::Binary,
        TextGridFormat::Chronological,
    ] {
        let out = serialize_textgrid(tg, fmt).expect("serialize");
        let parsed = parse_textgrid_bytes(&out).expect("re-parse");
        assert_textgrid_approx_eq(tg, &parsed, 1e-6);
    }
}

#[test]
fn test_all_praat_extreme_examples_parse_and_roundtrip() {
    let dir = Path::new(r"C:\Users\Sager\Desktop\Praat_Extreme_Examples");
    if !dir.exists() {
        eprintln!("Skipping external Praat_Extreme_Examples fixture test (directory not present)");
        return;
    }

    let files = [
        "01_multilingual_quotes.TextGrid",
        "02_two_speaker_dialogue.TextGrid",
        "03_rapid_staccato_utf16be.TextGrid",
        "04_short_text_variant.TextGrid",
        "05_binary_variant.TextGrid",
        "06_chronological_dialogue.TextGrid",
        "07_hybrid_torture_test.TextGrid",
        "08_standalone_points.TextTier",
        "08_standalone_tier.IntervalTier",
        "09_bundle_long_text.Collection",
        "10_bundle_short_text.Collection",
        "11_bundle_binary_nested.Collection",
    ];

    for fname in files {
        let path = dir.join(fname);
        assert!(path.exists(), "missing fixture: {}", path.display());
        let bytes = fs::read(&path).expect("read fixture");
        let doc = parse_praat_bytes(&bytes, fname)
            .unwrap_or_else(|e| panic!("failed to parse {fname}: {e}"));
        assert!(!doc.items.is_empty(), "{fname} produced 0 items");

        for item in &doc.items {
            if let CollectionItem::TextGrid(tg) = item {
                for fmt in [
                    TextGridFormat::LongText,
                    TextGridFormat::ShortText,
                    TextGridFormat::Binary,
                    TextGridFormat::Chronological,
                ] {
                    let serialized = serialize_textgrid(tg, fmt)
                        .unwrap_or_else(|e| panic!("serialize {fname} as {fmt:?} failed: {e}"));
                    let reparsed = parse_textgrid_bytes(&serialized)
                        .unwrap_or_else(|e| panic!("reparse {fname} from {fmt:?} failed: {e}"));
                    assert_textgrid_approx_eq(tg, &reparsed, 1e-6);
                }
            }
        }

        // Also test Collection round-trip for Collection fixtures
        if fname.ends_with(".Collection") {
            for cfmt in [CollectionFormat::LongText, CollectionFormat::Binary] {
                let col_bytes = serialize_collection(&doc.items, cfmt)
                    .unwrap_or_else(|e| panic!("serialize collection {fname} as {cfmt:?}: {e}"));
                let col_reparsed = parse_praat_bytes(&col_bytes, fname)
                    .unwrap_or_else(|e| panic!("reparse collection {fname} from {cfmt:?}: {e}"));
                assert_eq!(
                    doc.items.len(),
                    col_reparsed.items.len(),
                    "{fname} collection item count mismatch for {cfmt:?}"
                );
            }
        }
    }
}

#[test]
fn test_praat_negative_and_malformed_inputs() {
    // 1. Numeric token where string expected
    let bad_class = br#"File type = "ooTextFile"
Object class = "TextGrid"
xmin = 0
xmax = 1
tiers? <exists>
size = 1
item []:
    item [1]:
        class = 666
        name = "A"
        xmin = 0
        xmax = 1
        intervals: size = 1
        intervals [1]:
            xmin = 0
            xmax = 1
            text = "ok"
"#;
    assert!(parse_praat_bytes(bad_class, "bad_class.TextGrid").is_err());

    // 2. Trailing characters directly attached to closing quote
    let bad_quote = br#"File type = "ooTextFile"
Object class = "TextGrid"
xmin = 0
xmax = 1
tiers? <exists>
size = 1
item []:
    item [1]:
        class = "IntervalTier"
        name = "A"x
        xmin = 0
        xmax = 1
        intervals: size = 1
        intervals [1]:
            xmin = 0
            xmax = 1
            text = "ok"
"#;
    assert!(parse_praat_bytes(bad_quote, "bad_quote.TextGrid").is_err());

    // 3. Invalid boolean case <EXISTS>
    let bad_bool = br#"File type = "ooTextFile"
Object class = "TextGrid"
xmin = 0
xmax = 1
tiers? <EXISTS>
size = 0
"#;
    assert!(parse_praat_bytes(bad_bool, "bad_bool.TextGrid").is_err());

    // 4. Legacy non-Praat PointTier rejected
    let bad_tier_class = br#"File type = "ooTextFile"
Object class = "TextGrid"
xmin = 0
xmax = 1
tiers? <exists>
size = 1
item []:
    item [1]:
        class = "PointTier"
        name = "pts"
        xmin = 0
        xmax = 1
        points: size = 0
"#;
    assert!(parse_praat_bytes(bad_tier_class, "bad_tier.TextGrid").is_err());

    // 5. Inverted domain xmin > xmax rejected
    let bad_domain = br#"File type = "ooTextFile"
Object class = "TextGrid"
xmin = 2.0
xmax = 1.0
tiers? <exists>
size = 0
"#;
    assert!(parse_praat_bytes(bad_domain, "bad_domain.TextGrid").is_err());
}

#[test]
fn test_unicode_astral_and_quote_escaping_roundtrip() {
    let tg = TextGrid {
        name: "unicode_test".to_string(),
        xmin: 0.0,
        xmax: 2.0,
        tiers: vec![
            Tier {
                kind: TierKind::IntervalTier,
                name: "说\"话\"者 🎙️".to_string(),
                xmin: 0.0,
                xmax: 2.0,
                intervals: vec![
                    Interval {
                        xmin: 0.0,
                        xmax: 1.0,
                        text: "He said \"hello\"\nline2 🎵".to_string(),
                    },
                    Interval {
                        xmin: 1.0,
                        xmax: 2.0,
                        text: r"\sh\ae\ng\^h\-5 ʃæŋʰ˥".to_string(),
                    },
                ],
                points: vec![],
                display_num: None,
            },
            Tier {
                kind: TierKind::TextTier,
                name: "事件".to_string(),
                xmin: 0.0,
                xmax: 2.0,
                intervals: vec![],
                points: vec![TextPoint {
                    number: 1.25,
                    mark: "H* \"quoted\" 𝄞".to_string(),
                }],
                display_num: None,
            },
        ],
    };

    for fmt in [
        TextGridFormat::LongText,
        TextGridFormat::ShortText,
        TextGridFormat::Binary,
        TextGridFormat::Chronological,
    ] {
        let bytes = serialize_textgrid(&tg, fmt).expect("serialize unicode");
        let reparsed = parse_textgrid_bytes(&bytes).expect("reparse unicode");
        assert_textgrid_approx_eq(&tg, &reparsed, 1e-9);
    }
}

#[test]
fn test_slice_textgrid_and_diagnostics() {
    let tg = TextGrid {
        name: "diag".to_string(),
        xmin: 0.0,
        xmax: 3.0,
        tiers: vec![
            Tier {
                kind: TierKind::IntervalTier,
                name: "T1".to_string(),
                xmin: 0.0,
                xmax: 3.0,
                intervals: vec![
                    Interval { xmin: 0.0, xmax: 1.0, text: "a".into() },
                    Interval { xmin: 1.0, xmax: 2.0, text: "b".into() },
                    Interval { xmin: 2.0, xmax: 3.0, text: "c".into() },
                ],
                points: vec![],
                display_num: None,
            },
            Tier {
                kind: TierKind::IntervalTier,
                name: "T2_faulty".to_string(),
                xmin: 0.0,
                xmax: 3.5, // out of domain!
                intervals: vec![
                    Interval { xmin: 0.0, xmax: 0.002, text: "micro".into() }, // micro < 5ms
                    Interval { xmin: 0.002, xmax: 0.002, text: "zero".into() }, // zero duration
                    Interval { xmin: 0.5, xmax: 1.5, text: "gap_before".into() }, // gap 0.002..0.5
                    Interval { xmin: 1.2, xmax: 2.5, text: "overlap".into() }, // overlap 1.5 > 1.2
                ],
                points: vec![],
                display_num: None,
            },
            Tier {
                kind: TierKind::TextTier,
                name: "T3_pts".to_string(),
                xmin: 0.0,
                xmax: 3.0,
                intervals: vec![],
                points: vec![
                    TextPoint { number: 0.2, mark: "p1".into() },
                    TextPoint { number: 1.5, mark: "p2".into() },
                    TextPoint { number: 2.8, mark: "p3".into() },
                ],
                display_num: None,
            },
        ],
    };

    let diags = scan_diagnostics(&tg);
    assert_eq!(diags.len(), 3);
    assert_eq!(diags[0].gap_count, 0);
    assert_eq!(diags[0].overlap_count, 0);
    assert_eq!(diags[0].zero_duration_count, 0);
    assert_eq!(diags[0].micro_segment_count, 0);
    assert!(!diags[0].out_of_domain);

    assert!(diags[1].out_of_domain);
    assert_eq!(diags[1].micro_segment_count, 1);
    assert_eq!(diags[1].zero_duration_count, 1);
    assert!(diags[1].gap_count >= 1);
    assert_eq!(diags[1].overlap_count, 1);

    // Non-mutating slice preserving original 1-based display_num
    let sliced = slice_textgrid(
        &tg,
        &SliceOptions {
            tier_indices: Some(vec![0, 2]),
            t_min: Some(0.5),
            t_max: Some(2.5),
        },
    );
    assert_eq!(sliced.tiers.len(), 2);
    assert_eq!(sliced.tiers[0].display_num, Some(1));
    assert_eq!(sliced.tiers[1].display_num, Some(3));
    assert!((sliced.xmin - 0.5).abs() < 1e-9);
    assert!((sliced.xmax - 2.5).abs() < 1e-9);
    assert_eq!(sliced.tiers[0].intervals.len(), 3);
    assert!((sliced.tiers[0].intervals[0].xmin - 0.5).abs() < 1e-9);
    assert!((sliced.tiers[0].intervals[2].xmax - 2.5).abs() < 1e-9);
    assert_eq!(sliced.tiers[1].points.len(), 1);
    assert_eq!(sliced.tiers[1].points[0].mark, "p2");
    // Original must be untouched
    assert_eq!(tg.tiers.len(), 3);
    assert_eq!(tg.tiers[0].display_num, None);
}

#[test]
fn test_ipa_engine_counts_yunlong_and_praat() {
    let eng = ipa_engine();
    assert_eq!(eng.yunlong_entry_count(), 647, "Yunlong dictionary must have 647 entries");
    assert_eq!(eng.praat_entry_count(), 408, "Praat Longchar_database must have 408 entries");

    // Yunlong candidate lookups
    let ss_cands = get_yunlong_candidates("ss");
    assert!(ss_cands.iter().any(|c| c.text == "ʃ" && c.exact));

    let tone55 = get_yunlong_candidates("/55");
    assert!(tone55.iter().any(|c| c.text == "˥" && c.exact));

    let tone214 = get_yunlong_candidates("/214");
    assert!(tone214.iter().any(|c| c.text == "˨˩˦" && c.exact));

    let step1 = step_yunlong_char("", 's');
    assert_eq!(step1.action, "compose");
    assert_eq!(step1.buffer, "s");

    // Praat trigraph decode/encode round-trip
    let encoded_src = r"\sh\ae\ng\^h\-5";
    assert!(has_praat_trigraphs(encoded_src));
    let decoded = decode_praat_trigraphs(encoded_src);
    assert!(decoded.changed);
    assert_eq!(decoded.text, "ʃæŋʰ˥");

    let reencoded = encode_praat_trigraphs(&decoded.text);
    assert!(reencoded.changed);
    let redecoded = decode_praat_trigraphs(&reencoded.text);
    assert_eq!(redecoded.text, "ʃæŋʰ˥");

    // Starter & prefix matches
    let starters = get_praat_matches(None);
    assert!(starters.len() >= 30);
    let s_matches = get_praat_matches(Some('s'));
    assert!(s_matches.iter().any(|m| m.code == "sh" && m.ch == "ʃ"));

    // Symbol inspector
    let info = lookup_ipa_symbol("ʃ");
    assert_eq!(info.praat, r"\sh");
    assert!(!info.yunlong.is_empty());
    assert_eq!(info.unicode, "U+0283");
}

#[test]
fn test_marching_squares_contours_and_palettes() {
    let cols = 40;
    let rows = 24;
    let mut grid = vec![0.0f32; cols * rows];
    for r in 0..rows {
        for c in 0..cols {
            let dx = (c as f32 - 20.0) / 8.0;
            let dy = (r as f32 - 12.0) / 5.0;
            grid[r * cols + c] = (-0.5 * (dx * dx + dy * dy)).exp();
        }
    }

    let box_rect = ContourBox {
        x: 10.0,
        y: 20.0,
        width: 400.0,
        height: 120.0,
    };

    for levels in [4usize, 6, 8] {
        for palette in ["warm", "bw"] {
            let paths = generate_spectrogram_contours(&grid, cols, rows, box_rect, levels, palette);
            assert!(!paths.is_empty(), "expected contour paths for levels={levels}, palette={palette}");
            for p in &paths {
                assert!(p.d.starts_with('M'), "path must start with M");
                assert!(p.d.ends_with('Z'), "contour ring must be closed with Z");
                assert!(
                    p.fill.starts_with("rgb(") || p.fill.starts_with('#'),
                    "fill color must be rgb(...) or hex, got {}",
                    p.fill
                );
                if palette == "bw" {
                    let inner = p
                        .fill
                        .strip_prefix("rgb(")
                        .and_then(|s| s.strip_suffix(')'))
                        .expect("bw contour fill must be rgb(g,g,g)");
                    let comps: Vec<u8> = inner
                        .split(',')
                        .map(|c| c.trim().parse::<u8>().expect("valid channel u8"))
                        .collect();
                    assert_eq!(comps.len(), 3, "expected 3 RGB channels in {}", p.fill);
                    assert!(
                        comps[0] == comps[1] && comps[1] == comps[2],
                        "bw contour fill must be strictly achromatic, got {}",
                        p.fill
                    );
                }
            }
        }
    }
}

#[test]
fn test_crc32_and_zip_store_archive() {
    assert_eq!(crc32(b"123456789"), 0xCBF4_3926);

    let entries = vec![
        ZipEntryInput {
            name: "图谱/score.svg".to_string(),
            data: b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>".to_vec(),
        },
        ZipEntryInput {
            name: "assets/band_0.png".to_string(),
            data: vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
        },
    ];
    let zip = build_zip_store(&entries);

    // Local File Header signature at offset 0
    assert_eq!(&zip[0..4], &0x0403_4B50u32.to_le_bytes());
    // UTF-8 EFS flag 0x0800 at offset 6..8
    assert_eq!(u16::from_le_bytes([zip[6], zip[7]]), 0x0800);
    // EOCD signature in last 22 bytes
    let eocd = &zip[zip.len() - 22..];
    assert_eq!(&eocd[0..4], &0x0605_4B50u32.to_le_bytes());
    assert_eq!(u16::from_le_bytes([eocd[8], eocd[9]]), 2);
    assert_eq!(u16::from_le_bytes([eocd[10], eocd[11]]), 2);

    // Central directory offset points to CD signature
    let cd_offset = u32::from_le_bytes([eocd[16], eocd[17], eocd[18], eocd[19]]) as usize;
    assert_eq!(&zip[cd_offset..cd_offset + 4], &0x0201_4B50u32.to_le_bytes());
}

#[test]
fn test_extreme_zero_duration_empty_tier_and_micro_tolerance() {
    let raw = r#"File type = "ooTextFile"
Object class = "TextGrid" ! extreme boundary torture

xmin = 0
xmax = 10.56
tiers? <exists> size = 4
item []:
    item [1]:
        class = "IntervalTier"
        name = "微距边界与浮点容差"
        xmin = 0
        xmax = 10.56
        intervals: size = 4
        intervals [1]:
            xmin = 0.0
            xmax = 3.385
            text = "ok"
        intervals [2]:
            xmin = 3.385
            xmax = 3.3882
            text = "!"
        intervals [3]:
            xmin = 5.545
            xmax = 5.55
            text = "exact_5ms_ieee754"
        intervals [4]:
            xmin = 5.55
            xmax = 10.56
            text = "tail"
    item [2]:
        class = "IntervalTier"
        name = "异常态_同起点零时长与正时长"
        xmin = 1.16
        xmax = 9.995
        intervals: size = 5
        intervals [1]:
            xmin = 3.385
            xmax = 3.715
            text = "←左侧缝隙恢复"
        intervals [2]:
            xmin = 3.715
            xmax = 3.715
            text = "0ms零时长"
        intervals [3]:
            xmin = 3.715
            xmax = 4.1
            text = ""
        intervals [4]:
            xmin = 4.1
            xmax = 5.35
            text = "重叠1"
        intervals [5]:
            xmin = 4.6
            xmax = 5.55
            text = "重叠2"
    item [3]:
        class = "IntervalTier"
        name = "零区间空层_ZeroIntervals"
        xmin = 0
        xmax = 10.56
        intervals: size = 0
    item [4]:
        class = "MarkTier"
        name = "遗留MarkTier_空点子域"
        xmin = 2.51
        xmax = 8.77
        points: size = 0
"#;

    let tg = parse_textgrid_bytes(raw.as_bytes()).expect("parse extreme torture textgrid");
    assert_eq!(tg.tiers.len(), 4);

    // 1. Same-xmin zero-duration [3.715, 3.715] AND following positive [3.715, 4.1] must BOTH survive
    let t2 = &tg.tiers[1];
    assert_eq!(t2.intervals.len(), 5, "must not drop [3.715, 4.1] sharing xmin with [3.715, 3.715]");
    assert_eq!(t2.intervals[1].xmin, 3.715);
    assert_eq!(t2.intervals[1].xmax, 3.715);
    assert_eq!(t2.intervals[1].text, "0ms零时长");
    assert_eq!(t2.intervals[2].xmin, 3.715);
    assert_eq!(t2.intervals[2].xmax, 4.1);
    assert_eq!(t2.intervals[2].text, "");

    // 2. Empty IntervalTier (intervals: size = 0) must stay empty (no silent v_repair)
    let t3 = &tg.tiers[2];
    assert_eq!(t3.kind, TierKind::IntervalTier);
    assert!(
        t3.intervals.is_empty(),
        "size = 0 IntervalTier must remain empty on parse, got {} intervals",
        t3.intervals.len()
    );

    // 3. Round-trip across all 4 formats preserves both zero-duration pair and empty tier
    for fmt in [
        TextGridFormat::LongText,
        TextGridFormat::ShortText,
        TextGridFormat::Binary,
        TextGridFormat::Chronological,
    ] {
        let bytes = serialize_textgrid(&tg, fmt).expect("serialize extreme torture");
        let reparsed = parse_textgrid_bytes(&bytes).expect("reparse extreme torture");
        assert_textgrid_approx_eq(&tg, &reparsed, 1e-9);
    }

    // 4. IEEE-754 floating tolerance: 5.55 - 5.545 (~0.004999999999999893) is exact 5ms, NOT micro!
    // Only [3.385, 3.3882] (3.2ms) should be counted as micro_segment_count == 1.
    let diags = scan_diagnostics(&tg);
    assert_eq!(
        diags[0].micro_segment_count, 1,
        "5.55 - 5.545 must not false-positive as < 5ms micro-segment"
    );
    assert_eq!(diags[1].zero_duration_count, 1);
}
