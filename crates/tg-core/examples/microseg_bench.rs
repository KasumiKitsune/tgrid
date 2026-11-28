use serde::Deserialize;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::Path;
use std::time::Instant;
use tg_core::acoustic_split::{
    align_split_boundaries, AcousticClass, AcousticSplitInput, AcousticSplitOutput,
    SplitGranularity,
};
use tg_core::model::TierKind;
use tg_core::nn::{
    align_split_boundaries_hybrid, detect_speech_segments_dsp, detect_speech_segments_nn,
    extract_features, MicroSegNet, VadParams,
};
use tg_core::parse_textgrid_bytes;

fn read_wav_mono(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!("not a valid WAV file: {}", path.display()));
    }
    let mut off = 12usize;
    let mut audio_fmt = 0u16;
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits_per_sample = 0u16;
    let mut data_slice: Option<&[u8]> = None;

    while off + 8 <= bytes.len() {
        let id = &bytes[off..off + 4];
        let size = u32::from_le_bytes([
            bytes[off + 4],
            bytes[off + 5],
            bytes[off + 6],
            bytes[off + 7],
        ]) as usize;
        off += 8;
        if off + size > bytes.len() {
            break;
        }
        if id == b"fmt " && size >= 16 {
            audio_fmt = u16::from_le_bytes([bytes[off], bytes[off + 1]]);
            channels = u16::from_le_bytes([bytes[off + 2], bytes[off + 3]]);
            sample_rate = u32::from_le_bytes([
                bytes[off + 4],
                bytes[off + 5],
                bytes[off + 6],
                bytes[off + 7],
            ]);
            bits_per_sample = u16::from_le_bytes([bytes[off + 14], bytes[off + 15]]);
        } else if id == b"data" {
            data_slice = Some(&bytes[off..off + size]);
        }
        off += size + (size & 1);
    }

    let data = data_slice.ok_or_else(|| "missing WAV data chunk".to_string())?;
    let ch = channels.max(1) as usize;
    let samples = match (audio_fmt, bits_per_sample) {
        (1, 16) => {
            let n_frames = data.len() / (2 * ch);
            let mut out = Vec::with_capacity(n_frames);
            for f in 0..n_frames {
                let mut acc = 0.0f32;
                for c in 0..ch {
                    let p = (f * ch + c) * 2;
                    let s = i16::from_le_bytes([data[p], data[p + 1]]);
                    acc += (s as f32) / 32768.0;
                }
                out.push(acc / (ch as f32));
            }
            out
        }
        (3, 32) => {
            let n_frames = data.len() / (4 * ch);
            let mut out = Vec::with_capacity(n_frames);
            for f in 0..n_frames {
                let mut acc = 0.0f32;
                for c in 0..ch {
                    let p = (f * ch + c) * 4;
                    let s = f32::from_le_bytes([data[p], data[p + 1], data[p + 2], data[p + 3]]);
                    acc += s;
                }
                out.push(acc / (ch as f32));
            }
            out
        }
        _ => {
            return Err(format!(
                "unsupported WAV format={audio_fmt} bits={bits_per_sample}"
            ));
        }
    };
    Ok((samples, sample_rate))
}

fn infer_acoustic_class(label: &str, granularity: SplitGranularity) -> (AcousticClass, f64) {
    if matches!(granularity, SplitGranularity::Syllable | SplitGranularity::Word) {
        return (AcousticClass::Syllable, 1.0);
    }
    let s = label.trim();
    if s.is_empty() {
        return (AcousticClass::Other, 1.0);
    }
    let first = s.chars().next().unwrap_or(' ');
    if matches!(
        first,
        'p' | 't' | 'k' | 'q' | 'ʔ' | 'f' | 's' | 'ʃ' | 'ʂ' | 'ɕ' | 'x' | 'χ' | 'h' | 'θ' | 'ç' | 'ɬ'
    ) {
        return (AcousticClass::VoicelessObs, 0.85);
    }
    if matches!(
        first,
        'b' | 'd' | 'g' | 'ɡ' | 'v' | 'z' | 'ʒ' | 'ʐ' | 'ʑ' | 'ð' | 'ɣ' | 'ʁ' | 'ɦ' | 'ɖ' | 'ɟ'
    ) {
        return (AcousticClass::VoicedObs, 0.85);
    }
    if matches!(
        first,
        'm' | 'n' | 'ŋ' | 'ɲ' | 'ɳ' | 'l' | 'ɭ' | 'r' | 'ɹ' | 'ɻ' | 'ɾ' | 'j' | 'w' | 'ɥ' | 'ʋ'
    ) {
        return (AcousticClass::NasalLiquid, 0.90);
    }
    (AcousticClass::Vowel, 1.25)
}

#[derive(Default)]
struct SplitMetrics {
    name: String,
    n_cases: usize,
    n_cuts: usize,
    fallbacks: usize,
    errors_ms: Vec<f64>,
    total_time_ms: f64,
}

impl SplitMetrics {
    fn record(&mut self, out: &tg_core::acoustic_split::AcousticSplitOutput, gt_cuts: &[f64], ms: f64) {
        self.n_cases += 1;
        self.total_time_ms += ms;
        if out.fallback_to_equal {
            self.fallbacks += 1;
        }
        for (&pred, &gt) in out.cuts.iter().zip(gt_cuts.iter()) {
            self.n_cuts += 1;
            self.errors_ms.push((pred - gt).abs() * 1000.0);
        }
    }

    fn summary_json(&self) -> String {
        let n = self.errors_ms.len();
        if n == 0 {
            return format!(
                "{{\"name\":\"{}\",\"cases\":{},\"cuts\":0}}",
                self.name, self.n_cases
            );
        }
        let mae = self.errors_ms.iter().sum::<f64>() / (n as f64);
        let mut sorted = self.errors_ms.clone();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let p50 = sorted[n / 2];
        let p90 = sorted[((n - 1) as f64 * 0.90).round() as usize];
        let hit10 = 100.0 * (self.errors_ms.iter().filter(|&&e| e <= 10.0).count() as f64) / (n as f64);
        let hit20 = 100.0 * (self.errors_ms.iter().filter(|&&e| e <= 20.0).count() as f64) / (n as f64);
        let cat50 = 100.0 * (self.errors_ms.iter().filter(|&&e| e > 50.0).count() as f64) / (n as f64);
        let fb_rate = 100.0 * (self.fallbacks as f64) / (self.n_cases.max(1) as f64);
        let avg_ms = self.total_time_ms / (self.n_cases.max(1) as f64);
        format!(
            "{{\"name\":\"{}\",\"cases\":{},\"cuts\":{},\"mae_ms\":{:.2},\"p50_ms\":{:.2},\"p90_ms\":{:.2},\"hit10_pct\":{:.2},\"hit20_pct\":{:.2},\"err_gt50_pct\":{:.2},\"fallback_pct\":{:.2},\"avg_latency_ms\":{:.3}}}",
            self.name, self.n_cases, n, mae, p50, p90, hit10, hit20, cat50, fb_rate, avg_ms
        )
    }
}

struct EvalPair {
    wav: &'static str,
    tg: &'static str,
    parent_tier: &'static str,
    child_tier: &'static str,
    granularity: SplitGranularity,
    is_stress: bool,
}

fn add_fieldwork_interference(samples: &[f32], sr: u32) -> Vec<f32> {
    // Deterministic in-memory fieldwork noise injection:
    // 50Hz mains hum + 2nd/3rd harmonics (SNR ~14 dB) + high-ZCR synthetic paper rustle in silences
    let mut out = samples.to_vec();
    let rms = (samples.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>()
        / (samples.len().max(1) as f64))
        .sqrt();
    let hum_amp = (rms * 0.16) as f32;
    let fs = sr as f64;
    let mut rng = 0x5EED_CAFE_1234_5678u64;
    let mut next_signed = || -> f32 {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        let u = (rng >> 11) as f64 / ((1u64 << 53) as f64);
        (2.0 * u - 1.0) as f32
    };
    let mut prev_w = 0.0f32;
    for (i, s) in out.iter_mut().enumerate() {
        let t = (i as f64) / fs;
        let hum = ((2.0 * std::f64::consts::PI * 50.0 * t).sin()
            + 0.4 * (2.0 * std::f64::consts::PI * 100.0 * t).sin()
            + 0.25 * (2.0 * std::f64::consts::PI * 150.0 * t).sin()) as f32;
        let w = next_signed();
        let hp = w - 0.92 * prev_w;
        prev_w = w;
        // Inject brief paper-rustle bursts every ~3.5s
        let cyc = t % 3.5;
        let burst = if (0.05..0.22).contains(&cyc) {
            hp * (rms as f32) * 0.35
        } else {
            0.0
        };
        *s = (*s + hum * hum_amp + burst).clamp(-0.99, 0.99);
    }
    out
}

fn eval_suite(root: &Path, model: Option<&MicroSegNet>) {
    let pairs = [
        // samples/tts_stress_tests (millisecond-exact forced-aligned ground truth)
        EvalPair {
            wav: "samples/tts_stress_tests/01_code_switch_fast_pause.wav",
            tg: "samples/tts_stress_tests/01_code_switch_fast_pause.TextGrid",
            parent_tier: "utterance",
            child_tier: "word",
            granularity: SplitGranularity::Word,
            is_stress: true,
        },
        EvalPair {
            wav: "samples/tts_stress_tests/01_code_switch_fast_pause.wav",
            tg: "samples/tts_stress_tests/01_code_switch_fast_pause.TextGrid",
            parent_tier: "word",
            child_tier: "syllable_ipa",
            granularity: SplitGranularity::Syllable,
            is_stress: true,
        },
        EvalPair {
            wav: "samples/tts_stress_tests/02_fricatives_whisper_short.wav",
            tg: "samples/tts_stress_tests/02_fricatives_whisper_short.TextGrid",
            parent_tier: "word",
            child_tier: "phone_ipa",
            granularity: SplitGranularity::Phone,
            is_stress: true,
        },
        EvalPair {
            wav: "samples/tts_stress_tests/04_fieldwork_carrier_ipa.wav",
            tg: "samples/tts_stress_tests/04_fieldwork_carrier_ipa.TextGrid",
            parent_tier: "word",
            child_tier: "phone_ipa",
            granularity: SplitGranularity::Phone,
            is_stress: true,
        },
        // samples/tts_split_eval (UI demo / coarse-grid reference)
        EvalPair {
            wav: "samples/tts_split_eval/01_long_monologue_zh.wav",
            tg: "samples/tts_split_eval/01_long_monologue_zh.TextGrid",
            parent_tier: "句子",
            child_tier: "汉字",
            granularity: SplitGranularity::Syllable,
            is_stress: false,
        },
        EvalPair {
            wav: "samples/tts_split_eval/03_wordlist_continuous_long.wav",
            tg: "samples/tts_split_eval/03_wordlist_continuous_long.TextGrid",
            parent_tier: "词表",
            child_tier: "单字",
            granularity: SplitGranularity::Syllable,
            is_stress: false,
        },
        EvalPair {
            wav: "samples/tts_split_eval/03_wordlist_continuous_long.wav",
            tg: "samples/tts_split_eval/03_wordlist_continuous_long.TextGrid",
            parent_tier: "单字",
            child_tier: "音标",
            granularity: SplitGranularity::Phone,
            is_stress: false,
        },
        EvalPair {
            wav: "samples/tts_split_eval/04_short_words_zh.wav",
            tg: "samples/tts_split_eval/04_short_words_zh.TextGrid",
            parent_tier: "汉字",
            child_tier: "声韵",
            granularity: SplitGranularity::OnsetRime,
            is_stress: false,
        },
        EvalPair {
            wav: "samples/tts_split_eval/04_short_words_zh.wav",
            tg: "samples/tts_split_eval/04_short_words_zh.TextGrid",
            parent_tier: "汉字",
            child_tier: "音素",
            granularity: SplitGranularity::Phone,
            is_stress: false,
        },
        EvalPair {
            wav: "samples/tts_split_eval/05_short_words_en.wav",
            tg: "samples/tts_split_eval/05_short_words_en.TextGrid",
            parent_tier: "word",
            child_tier: "phone",
            granularity: SplitGranularity::Phone,
            is_stress: false,
        },
    ];

    let mut eq_stress_all = SplitMetrics { name: "equal_stress_all".into(), ..Default::default() };
    let mut eq_stress_phone = SplitMetrics { name: "equal_stress_phone".into(), ..Default::default() };
    let mut eq_stress_syl = SplitMetrics { name: "equal_stress_syl".into(), ..Default::default() };
    let mut eq_carrier_ipa = SplitMetrics { name: "equal_carrier_ipa".into(), ..Default::default() };
    let mut eq_eval_all = SplitMetrics { name: "equal_tts_split_eval".into(), ..Default::default() };

    let mut rule_stress_all = SplitMetrics { name: "rule_stress_all".into(), ..Default::default() };
    let mut rule_stress_phone = SplitMetrics { name: "rule_stress_phone".into(), ..Default::default() };
    let mut rule_stress_syl = SplitMetrics { name: "rule_stress_syl".into(), ..Default::default() };
    let mut rule_carrier_ipa = SplitMetrics { name: "rule_carrier_ipa".into(), ..Default::default() };
    let mut rule_eval_all = SplitMetrics { name: "rule_tts_split_eval".into(), ..Default::default() };

    let mut hyb_stress_all = SplitMetrics { name: "hybrid_stress_all".into(), ..Default::default() };
    let mut hyb_stress_phone = SplitMetrics { name: "hybrid_stress_phone".into(), ..Default::default() };
    let mut hyb_stress_syl = SplitMetrics { name: "hybrid_stress_syl".into(), ..Default::default() };
    let mut hyb_carrier_ipa = SplitMetrics { name: "hybrid_carrier_ipa".into(), ..Default::default() };
    let mut hyb_eval_all = SplitMetrics { name: "hybrid_tts_split_eval".into(), ..Default::default() };

    for pair in &pairs {
        let Ok((samples, sr)) = read_wav_mono(&root.join(pair.wav)) else { continue; };
        let Ok(tg_bytes) = fs::read(root.join(pair.tg)) else { continue; };
        let Ok(tg) = parse_textgrid_bytes(&tg_bytes) else { continue; };

        let find_tier = |name: &str| {
            tg.tiers
                .iter()
                .find(|t| t.kind == TierKind::IntervalTier && t.name == name)
        };
        let (Some(p_tier), Some(c_tier)) = (find_tier(pair.parent_tier), find_tier(pair.child_tier)) else {
            continue;
        };

        for p_iv in &p_tier.intervals {
            if p_iv.text.trim().is_empty() || p_iv.xmax - p_iv.xmin < 0.045 {
                continue;
            }
            let children: Vec<_> = c_tier
                .intervals
                .iter()
                .filter(|c| {
                    !c.text.trim().is_empty()
                        && c.xmin >= p_iv.xmin - 0.006
                        && c.xmax <= p_iv.xmax + 0.006
                })
                .collect();
            if children.len() < 2 {
                continue;
            }
            let xmin = children.first().unwrap().xmin;
            let xmax = children.last().unwrap().xmax;
            if xmax - xmin < 0.045 || xmax - xmin > 24.0 {
                continue;
            }
            let gt_cuts: Vec<f64> = children[..children.len() - 1].iter().map(|c| c.xmax).collect();
            let mut weights = Vec::with_capacity(children.len());
            let mut classes = Vec::with_capacity(children.len());
            for c in &children {
                let (cls, w) = infer_acoustic_class(&c.text, pair.granularity);
                classes.push(cls);
                weights.push(w);
            }

            let inp = AcousticSplitInput {
                samples: &samples,
                sample_rate: sr,
                samples_origin_sec: 0.0,
                xmin,
                xmax,
                granularity: pair.granularity,
                duration_weights: &weights,
                acoustic_classes: &classes,
                f0_frames: None,
            };

            let k_segs = children.len();
            let eq_cuts: Vec<f64> = (1..k_segs)
                .map(|i| xmin + (i as f64 / k_segs as f64) * (xmax - xmin))
                .collect();
            let eq_out = AcousticSplitOutput {
                cuts: eq_cuts,
                confidence: 0.0,
                fallback_to_equal: false,
                speech_span: (xmin, xmax),
            };

            let t0 = Instant::now();
            let r_out = align_split_boundaries(&inp);
            let r_ms = t0.elapsed().as_secs_f64() * 1000.0;
            let is_phone = matches!(pair.granularity, SplitGranularity::Phone | SplitGranularity::OnsetRime);
            let is_carrier = pair.wav.contains("04_fieldwork_carrier_ipa");

            if pair.is_stress {
                eq_stress_all.record(&eq_out, &gt_cuts, 0.0);
                rule_stress_all.record(&r_out, &gt_cuts, r_ms);
                if is_phone {
                    eq_stress_phone.record(&eq_out, &gt_cuts, 0.0);
                    rule_stress_phone.record(&r_out, &gt_cuts, r_ms);
                } else {
                    eq_stress_syl.record(&eq_out, &gt_cuts, 0.0);
                    rule_stress_syl.record(&r_out, &gt_cuts, r_ms);
                }
                if is_carrier {
                    eq_carrier_ipa.record(&eq_out, &gt_cuts, 0.0);
                    rule_carrier_ipa.record(&r_out, &gt_cuts, r_ms);
                }
            } else {
                eq_eval_all.record(&eq_out, &gt_cuts, 0.0);
                rule_eval_all.record(&r_out, &gt_cuts, r_ms);
            }

            if let Some(nn) = model {
                let t1 = Instant::now();
                let h_out = align_split_boundaries_hybrid(&inp, nn);
                let h_ms = t1.elapsed().as_secs_f64() * 1000.0;
                if pair.is_stress {
                    hyb_stress_all.record(&h_out, &gt_cuts, h_ms);
                    if is_phone { hyb_stress_phone.record(&h_out, &gt_cuts, h_ms); }
                    else { hyb_stress_syl.record(&h_out, &gt_cuts, h_ms); }
                    if is_carrier { hyb_carrier_ipa.record(&h_out, &gt_cuts, h_ms); }
                } else {
                    hyb_eval_all.record(&h_out, &gt_cuts, h_ms);
                }
            }
        }
    }

    println!("=== ACOUSTIC SPLIT BENCHMARK ===");
    for m in [&eq_stress_all, &eq_stress_phone, &eq_stress_syl, &eq_carrier_ipa, &eq_eval_all] {
        println!("{}", m.summary_json());
    }
    for m in [&rule_stress_all, &rule_stress_phone, &rule_stress_syl, &rule_carrier_ipa, &rule_eval_all] {
        println!("{}", m.summary_json());
    }
    if model.is_some() {
        for m in [&hyb_stress_all, &hyb_stress_phone, &hyb_stress_syl, &hyb_carrier_ipa, &hyb_eval_all] {
            println!("{}", m.summary_json());
        }
    }

    // VAD Benchmark (Clean + Synthetic Fieldwork Noise Stress)
    println!("=== VAD BENCHMARK ===");
    let vad_files = [
        ("samples/tts_stress_tests/01_code_switch_fast_pause.wav", "samples/tts_stress_tests/01_code_switch_fast_pause.TextGrid", "utterance", false),
        ("samples/tts_stress_tests/02_fricatives_whisper_short.wav", "samples/tts_stress_tests/02_fricatives_whisper_short.TextGrid", "utterance", false),
        ("samples/tts_stress_tests/02_fricatives_whisper_short.wav", "samples/tts_stress_tests/02_fricatives_whisper_short.TextGrid", "utterance", true),
        ("samples/tts_split_eval/03_wordlist_continuous_long.wav", "samples/tts_split_eval/03_wordlist_continuous_long.TextGrid", "词表", false),
        ("samples/tts_split_eval/03_wordlist_continuous_long.wav", "samples/tts_split_eval/03_wordlist_continuous_long.TextGrid", "词表", true),
        ("samples/tts_split_eval/05_short_words_en.wav", "samples/tts_split_eval/05_short_words_en.TextGrid", "word", false),
    ];
    let vad_params = VadParams::default();
    for (wav_rel, tg_rel, tier_name, add_noise) in vad_files {
        let Ok((raw_samples, sr)) = read_wav_mono(&root.join(wav_rel)) else { continue; };
        let samples = if add_noise { add_fieldwork_interference(&raw_samples, sr) } else { raw_samples };
        let Ok(tg_bytes) = fs::read(root.join(tg_rel)) else { continue; };
        let Ok(tg) = parse_textgrid_bytes(&tg_bytes) else { continue; };
        let Some(tier) = tg.tiers.iter().find(|t| t.kind == TierKind::IntervalTier && t.name == tier_name) else {
            continue;
        };

        let mut gt_segs: Vec<(f64, f64)> = Vec::new();
        for iv in &tier.intervals {
            if iv.text.trim().is_empty() {
                continue;
            }
            if let Some(last) = gt_segs.last_mut() {
                if iv.xmin - last.1 < 0.180 {
                    last.1 = last.1.max(iv.xmax);
                    continue;
                }
            }
            gt_segs.push((iv.xmin, iv.xmax));
        }

        let eval_vad = |segs: &[tg_core::nn::VadSegment]| -> (usize, f64, f64, f64) {
            let dur = (samples.len() as f64) / (sr as f64);
            let n_grid = ((dur * 100.0).ceil() as usize).max(1);
            let mut gt_mask = vec![false; n_grid];
            let mut pr_mask = vec![false; n_grid];
            for &(s, e) in &gt_segs {
                let lo = (s * 100.0).floor() as usize;
                let hi = ((e * 100.0).ceil() as usize).min(n_grid);
                for slot in &mut gt_mask[lo.min(n_grid)..hi] { *slot = true; }
            }
            for seg in segs {
                let lo = (seg.start * 100.0).floor() as usize;
                let hi = ((seg.end * 100.0).ceil() as usize).min(n_grid);
                for slot in &mut pr_mask[lo.min(n_grid)..hi] { *slot = true; }
            }
            let (mut tp, mut fp, mut fn_) = (0usize, 0usize, 0usize);
            for i in 0..n_grid {
                match (gt_mask[i], pr_mask[i]) {
                    (true, true) => tp += 1,
                    (false, true) => fp += 1,
                    (true, false) => fn_ += 1,
                    (false, false) => {}
                }
            }
            let prec = if tp + fp > 0 { tp as f64 / (tp + fp) as f64 } else { 0.0 };
            let rec = if tp + fn_ > 0 { tp as f64 / (tp + fn_) as f64 } else { 0.0 };
            let f1 = if prec + rec > 0.0 { 2.0 * prec * rec / (prec + rec) } else { 0.0 };
            (segs.len(), f1 * 100.0, prec * 100.0, rec * 100.0)
        };

        let tag = if add_noise { format!("{wav_rel} [hum+paper]") } else { wav_rel.to_string() };
        let t0 = Instant::now();
        let dsp_segs = detect_speech_segments_dsp(&samples, sr, &vad_params);
        let dsp_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let (dsp_n, dsp_f1, dsp_p, dsp_r) = eval_vad(&dsp_segs);

        if let Some(nn) = model {
            let t1 = Instant::now();
            let nn_segs = detect_speech_segments_nn(&samples, sr, &vad_params, nn);
            let nn_ms = t1.elapsed().as_secs_f64() * 1000.0;
            let (nn_n, nn_f1, nn_p, nn_r) = eval_vad(&nn_segs);
            println!(
                "{{\"file\":\"{}\",\"gt_count\":{},\"dsp_count\":{},\"dsp_f1\":{:.2},\"dsp_p\":{:.2},\"dsp_r\":{:.2},\"dsp_ms\":{:.2},\"nn_count\":{},\"nn_f1\":{:.2},\"nn_p\":{:.2},\"nn_r\":{:.2},\"nn_ms\":{:.2}}}",
                tag, gt_segs.len(), dsp_n, dsp_f1, dsp_p, dsp_r, dsp_ms, nn_n, nn_f1, nn_p, nn_r, nn_ms
            );
        } else {
            println!(
                "{{\"file\":\"{}\",\"gt_count\":{},\"dsp_count\":{},\"dsp_f1\":{:.2},\"dsp_p\":{:.2},\"dsp_r\":{:.2},\"dsp_ms\":{:.2}}}",
                tag, gt_segs.len(), dsp_n, dsp_f1, dsp_p, dsp_r, dsp_ms
            );
        }
    }

    // Latency micro-benchmark (1.5s slice & 60s VAD)
    if let Some(nn) = model {
        println!("=== LATENCY BENCHMARK (Native Rust Release) ===");
        let pcm_1_5s = vec![0.05f32; 16_000 * 3 / 2];
        let pcm_60s = vec![0.05f32; 16_000 * 60];
        // Warmup
        let _ = nn.forward_pcm(&pcm_1_5s, 16_000);
        let t0 = Instant::now();
        for _ in 0..20 {
            let _ = nn.forward_pcm(&pcm_1_5s, 16_000);
        }
        let ms_1_5s = t0.elapsed().as_secs_f64() * 1000.0 / 20.0;

        let t1 = Instant::now();
        for _ in 0..3 {
            let _ = detect_speech_segments_nn(&pcm_60s, 16_000, &vad_params, nn);
        }
        let ms_60s = t1.elapsed().as_secs_f64() * 1000.0 / 3.0;
        println!(
            "{{\"hidden_dim\":{},\"infer_1_5s_ms\":{:.3},\"vad_60s_ms\":{:.2}}}",
            nn.header.hidden_dim, ms_1_5s, ms_60s
        );
    }
}

#[derive(Deserialize)]
struct ManifestTask {
    group: String,       // "zh_real" | "en_real" | "dialect_real"
    wav: String,         // absolute path to WAV
    granularity: String, // "syllable" | "word" | "phone" | "onset_rime"
    xmin: f64,
    xmax: f64,
    gt_cuts: Vec<f64>,
    labels: Vec<String>,
}

fn eval_manifest(manifest_path: &Path, h48_path: &Path, h96_path: &Path) {
    let m48 = MicroSegNet::from_bytes(&fs::read(h48_path).expect("read h48")).expect("parse h48");
    let m96 = MicroSegNet::from_bytes(&fs::read(h96_path).expect("read h96")).expect("parse h96");
    eprintln!(
        "Loaded manifest models: h48={} ({} B) | h96={} ({} B)",
        m48.header.model_tag,
        fs::metadata(h48_path).map(|m| m.len()).unwrap_or(0),
        m96.header.model_tag,
        fs::metadata(h96_path).map(|m| m.len()).unwrap_or(0),
    );

    let text = fs::read_to_string(manifest_path).expect("read manifest jsonl");
    let mut wav_cache: HashMap<String, (Vec<f32>, u32)> = HashMap::new();
    let mut buckets: HashMap<String, SplitMetrics> = HashMap::new();

    let mut rec = |key: &str, out: &AcousticSplitOutput, gt: &[f64], ms: f64| {
        buckets
            .entry(key.to_string())
            .or_insert_with(|| SplitMetrics {
                name: key.to_string(),
                ..Default::default()
            })
            .record(out, gt, ms);
    };

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(task) = serde_json::from_str::<ManifestTask>(trimmed) else {
            continue;
        };
        if task.labels.len() < 2 || task.gt_cuts.len() + 1 != task.labels.len() {
            continue;
        }
        if !wav_cache.contains_key(&task.wav) {
            if let Ok(decoded) = read_wav_mono(Path::new(&task.wav)) {
                wav_cache.insert(task.wav.clone(), decoded);
            } else {
                continue;
            }
        }
        let (samples, sr) = &wav_cache[&task.wav];
        let gran = match task.granularity.as_str() {
            "phone" => SplitGranularity::Phone,
            "onset_rime" => SplitGranularity::OnsetRime,
            "word" => SplitGranularity::Word,
            _ => SplitGranularity::Syllable,
        };
        let is_phone = matches!(gran, SplitGranularity::Phone | SplitGranularity::OnsetRime);
        let sub_tag = if is_phone { "phone" } else { "syl" };

        let mut weights = Vec::with_capacity(task.labels.len());
        let mut classes = Vec::with_capacity(task.labels.len());
        for lbl in &task.labels {
            let (cls, w) = infer_acoustic_class(lbl, gran);
            classes.push(cls);
            weights.push(w);
        }

        let k_segs = task.labels.len();
        let eq_cuts: Vec<f64> = (1..k_segs)
            .map(|i| task.xmin + (i as f64 / k_segs as f64) * (task.xmax - task.xmin))
            .collect();
        let eq_out = AcousticSplitOutput {
            cuts: eq_cuts,
            confidence: 0.0,
            fallback_to_equal: false,
            speech_span: (task.xmin, task.xmax),
        };

        let inp = AcousticSplitInput {
            samples,
            sample_rate: *sr,
            samples_origin_sec: 0.0,
            xmin: task.xmin,
            xmax: task.xmax,
            granularity: gran,
            duration_weights: &weights,
            acoustic_classes: &classes,
            f0_frames: None,
        };

        let t0 = Instant::now();
        let r_out = align_split_boundaries(&inp);
        let r_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let t1 = Instant::now();
        let o48 = align_split_boundaries_hybrid(&inp, &m48);
        let ms48 = t1.elapsed().as_secs_f64() * 1000.0;

        let t2 = Instant::now();
        let o96 = align_split_boundaries_hybrid(&inp, &m96);
        let ms96 = t2.elapsed().as_secs_f64() * 1000.0;

        for (method, out, ms) in [
            ("equal", &eq_out, 0.0),
            ("rule", &r_out, r_ms),
            ("v3_h48", &o48, ms48),
            ("v3_h96", &o96, ms96),
        ] {
            rec(&format!("{method}_{}_all", task.group), out, &task.gt_cuts, ms);
            rec(&format!("{method}_{}_{sub_tag}", task.group), out, &task.gt_cuts, ms);
            rec(&format!("{method}_all_real_all"), out, &task.gt_cuts, ms);
            rec(&format!("{method}_all_real_{sub_tag}"), out, &task.gt_cuts, ms);
        }
    }

    let mut keys: Vec<String> = buckets.keys().cloned().collect();
    keys.sort();
    println!("=== REAL-HUMAN UNSEEN VALIDATION BENCHMARK ===");
    for k in keys {
        println!("{}", buckets[&k].summary_json());
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage:");
        eprintln!("  microseg_bench feat-dump <in.wav> <out.f32bin>");
        eprintln!("  microseg_bench eval-bench <repo_root> [model.tgnn]");
        eprintln!("  microseg_bench eval-manifest <manifest.jsonl> <h48.tgnn> <h96.tgnn>");
        std::process::exit(1);
    }

    match args[1].as_str() {
        "feat-dump" => {
            let (samples, sr) = read_wav_mono(Path::new(&args[2])).expect("read wav");
            let feats = extract_features(&samples, sr);
            let mut out = Vec::with_capacity(8 + feats.data.len() * 4);
            out.extend_from_slice(&(feats.num_frames as u32).to_le_bytes());
            out.extend_from_slice(&32u32.to_le_bytes());
            for &v in &feats.data {
                out.extend_from_slice(&v.to_le_bytes());
            }
            fs::write(&args[3], &out).expect("write features");
        }
        "eval-bench" => {
            let root = Path::new(args.get(2).map(|s| s.as_str()).unwrap_or("."));
            let model = args.get(3).map(|p| {
                let bytes = fs::read(p).expect("read .tgnn");
                let m = MicroSegNet::from_bytes(&bytes).expect("parse .tgnn");
                eprintln!(
                    "Loaded .tgnn: tag={} hidden={} layers={} bytes={}",
                    m.header.model_tag, m.header.hidden_dim, m.header.num_layers, bytes.len()
                );
                m
            });
            eval_suite(root, model.as_ref());
        }
        "eval-manifest" => {
            eval_manifest(
                Path::new(&args[2]),
                Path::new(&args[3]),
                Path::new(&args[4]),
            );
        }
        other => {
            eprintln!("Unknown command: {other}");
            std::process::exit(1);
        }
    }
}
