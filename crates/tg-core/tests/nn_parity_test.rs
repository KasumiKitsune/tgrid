use std::path::Path;
use tg_core::acoustic_split::{AcousticClass, AcousticSplitInput, SplitGranularity};
use tg_core::nn::{
    align_split_boundaries_hybrid, builtin_acouseg_net, extract_acoustic_snap_peaks,
    extract_features, snap_boundary_to_acoustic_edge, AcousticSnapKind, MicroSegNet, TgnnError,
    TGNN_TOTAL_BYTES,
};

fn read_u16_le(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([b[off], b[off + 1]])
}

fn read_u32_le(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

fn read_f32_slice(b: &[u8], off: usize, count: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let p = off + i * 4;
        out.push(f32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]));
    }
    out
}

fn find_primary_tgnn_path() -> Option<std::path::PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for rel in [
        "src/nn/weights/tgrid-acouseg-1.0.tgnn",
        "../../tools/microseg-train/artifacts/tgrid_microseg_v3_h96.tgnn",
        "../../tools/microseg-train/artifacts/tgrid_microseg_v3_h48.tgnn",
        "../../tools/microseg-train/artifacts/tgrid_microseg_v2_h96.tgnn",
        "../../tools/microseg-train/artifacts/tgrid_microseg_v2_h48.tgnn",
        "../../tools/microseg-train/artifacts/tgrid_microseg_v1.tgnn",
        "src/nn/weights/tgrid_microseg_v3_h96.tgnn",
        "src/nn/weights/tgrid_microseg_v2_h96.tgnn",
        "src/nn/weights/tgrid_microseg_v1.tgnn",
    ] {
        let p = manifest.join(rel);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

#[test]
fn test_tgnn_crc_and_header_validation() {
    let Some(tgnn_path) = find_primary_tgnn_path() else {
        // Before weights are trained, still verify basic parser rejections
        assert_eq!(MicroSegNet::from_bytes(&[]).unwrap_err(), TgnnError::InvalidLength { expected: 64, actual: 0 });
        assert_eq!(MicroSegNet::from_bytes(&[0u8; 64]).unwrap_err(), TgnnError::InvalidMagic);
        return;
    };

    let bytes = std::fs::read(&tgnn_path).expect("read primary .tgnn");
    let model = MicroSegNet::from_bytes(&bytes).expect("parse valid primary .tgnn");
    assert_eq!(model.header.version, 1);
    assert_eq!(model.header.num_layers, 18);
    assert!(model.header.hidden_dim == 96 || model.header.hidden_dim == 48);

    // Flip 1 bit in weight payload -> must fail CRC32
    let mut corrupted = bytes.clone();
    corrupted[10_000] ^= 0x01;
    assert!(matches!(
        MicroSegNet::from_bytes(&corrupted).unwrap_err(),
        TgnnError::ChecksumMismatch { .. }
    ));

    // Also validate h=48 lightweight artifact exact size (58,432 B) & forward pass if present
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for rel48 in [
        "../../tools/microseg-train/artifacts/tgrid_microseg_v3_h48.tgnn",
        "../../tools/microseg-train/artifacts/tgrid_microseg_v2_h48.tgnn",
    ] {
        let p48 = manifest.join(rel48);
        if p48.exists() {
            let b48 = std::fs::read(&p48).expect("read h48 .tgnn");
            assert_eq!(b48.len(), TGNN_TOTAL_BYTES, "h=48 .tgnn must be exact 58,432 bytes");
            let m48 = MicroSegNet::from_bytes(&b48).expect("parse h48 .tgnn");
            assert_eq!(m48.header.hidden_dim, 48);
            assert_eq!(m48.header.num_layers, 18);
            assert_eq!(m48.header.weight_bytes, 49_536);
            let dummy = vec![0.0f32; 10 * 32];
            let out = m48.forward_features(&dummy, 10);
            assert_eq!(out.len(), 10 * 12);
            assert!(out.iter().all(|v| v.is_finite()));
        }
    }
}

#[test]
fn test_python_vs_rust_numerical_parity_golden() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let golden_path = manifest.join("tests/fixtures/nn_parity_golden.bin");
    let Some(tgnn_path) = find_primary_tgnn_path() else {
        eprintln!("Skipping golden parity test: .tgnn artifact not yet present");
        return;
    };
    assert!(
        golden_path.exists(),
        "Expected golden parity fixture at {}",
        golden_path.display()
    );

    let model_bytes = std::fs::read(&tgnn_path).expect("read .tgnn");
    let model = MicroSegNet::from_bytes(&model_bytes).expect("parse .tgnn");
    let g = std::fs::read(&golden_path).expect("read golden bin");

    assert_eq!(&g[0..4], b"TGGN");
    assert_eq!(read_u16_le(&g, 4), 1);
    let num_cases = read_u16_le(&g, 6) as usize;
    assert_eq!(num_cases, 3);

    let mut off = 8usize;
    for case_idx in 0..num_cases {
        let sr = read_u32_le(&g, off);
        let n_samples = read_u32_le(&g, off + 4) as usize;
        let n_frames = read_u32_le(&g, off + 8) as usize;
        let feat_dim = read_u16_le(&g, off + 12) as usize;
        let out_dim = read_u16_le(&g, off + 14) as usize;
        off += 16;
        assert_eq!(feat_dim, 32);
        assert_eq!(out_dim, 12);

        let pcm = read_f32_slice(&g, off, n_samples);
        off += n_samples * 4;
        let py_feats = read_f32_slice(&g, off, n_frames * feat_dim);
        off += n_frames * feat_dim * 4;
        let py_logits = read_f32_slice(&g, off, n_frames * out_dim);
        off += n_frames * out_dim * 4;

        // 1. Feature parity: Python vs Rust from raw PCM (including 44.1kHz & 8kHz resampler!)
        let rs_feats = extract_features(&pcm, sr);
        assert_eq!(
            rs_feats.num_frames, n_frames,
            "case {case_idx} frame count mismatch"
        );
        let mut max_feat_diff = 0.0f32;
        for (&a, &b) in rs_feats.data.iter().zip(py_feats.iter()) {
            max_feat_diff = max_feat_diff.max((a - b).abs());
        }
        assert!(
            max_feat_diff < 5e-5,
            "case {case_idx} (sr={sr}) feature max_abs_diff={max_feat_diff:.3e} >= 5e-5"
        );

        // 2. Logits parity given identical [T, 32] features: MUST be < 1e-5!
        let rs_logits_from_py_feat = model.forward_features(&py_feats, n_frames);
        let mut max_logit_diff = 0.0f32;
        for (&a, &b) in rs_logits_from_py_feat.iter().zip(py_logits.iter()) {
            max_logit_diff = max_logit_diff.max((a - b).abs());
        }
        assert!(
            max_logit_diff < 1e-5,
            "case {case_idx} (sr={sr}) logits max_abs_diff={max_logit_diff:.3e} >= 1e-5"
        );

        // 3. End-to-end PCM -> Logits parity: MUST be < 5e-4!
        let (_, rs_post) = model.forward_pcm(&pcm, sr);
        let mut max_e2e_diff = 0.0f32;
        for (&a, &b) in rs_post.logits.iter().zip(py_logits.iter()) {
            max_e2e_diff = max_e2e_diff.max((a - b).abs());
        }
        assert!(
            max_e2e_diff < 5e-4,
            "case {case_idx} (sr={sr}) e2e logits max_abs_diff={max_e2e_diff:.3e} >= 5e-4"
        );
        println!(
            "case {case_idx} (sr={sr}, T={n_frames}): feat_diff={max_feat_diff:.2e}, logit_diff={max_logit_diff:.2e}, e2e_diff={max_e2e_diff:.2e}"
        );
    }
    assert_eq!(off, g.len());
}

#[test]
fn test_hybrid_split_safety_invariants() {
    let Some(tgnn_path) = find_primary_tgnn_path() else {
        return;
    };
    let model = MicroSegNet::from_bytes(&std::fs::read(&tgnn_path).unwrap()).unwrap();

    // Deterministic stationary white noise -> MUST fallback to equal cuts
    let mut state = 0x1234_5678_9ABC_DEF0u64;
    let mut next_f32 = || -> f32 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let u = (state >> 11) as f64 / ((1u64 << 53) as f64);
        (2.0 * u - 1.0) as f32 * 0.25
    };
    let noise: Vec<f32> = (0..16_000).map(|_| next_f32()).collect();
    let out = align_split_boundaries_hybrid(
        &AcousticSplitInput {
            samples: &noise,
            sample_rate: 16_000,
            samples_origin_sec: 0.0,
            xmin: 0.0,
            xmax: 1.0,
            granularity: SplitGranularity::Syllable,
            duration_weights: &[1.0, 1.0, 1.0],
            acoustic_classes: &[
                AcousticClass::Syllable,
                AcousticClass::Syllable,
                AcousticClass::Syllable,
            ],
            f0_frames: None,
        },
        &model,
    );
    assert!(out.fallback_to_equal, "white noise must fallback to equal");
    assert_eq!(out.cuts.len(), 2);

    // ToneSplit must always fallback
    let out_tone = align_split_boundaries_hybrid(
        &AcousticSplitInput {
            samples: &noise,
            sample_rate: 16_000,
            samples_origin_sec: 0.0,
            xmin: 0.0,
            xmax: 1.0,
            granularity: SplitGranularity::ToneSplit,
            duration_weights: &[1.0, 1.0],
            acoustic_classes: &[AcousticClass::Syllable, AcousticClass::Other],
            f0_frames: None,
        },
        &model,
    );
    assert!(out_tone.fallback_to_equal);
}

#[test]
fn test_builtin_acouseg_singleton_and_snap_apis() {
    // 1. Built-in TGrid-AcouSeg 1.0 singleton loads cleanly and matches expected architecture
    let net_a = builtin_acouseg_net();
    let net_b = builtin_acouseg_net();
    assert!(std::ptr::eq(net_a, net_b), "builtin_acouseg_net must be a singleton");
    assert_eq!(net_a.header.version, 1);
    assert_eq!(net_a.header.num_layers, 18);
    assert_eq!(net_a.header.hidden_dim, 96);

    // 2. Pure silence: must NOT produce any snap peaks and must NOT snap
    let sr = 16_000u32;
    let silence = vec![0.0f32; sr as usize * 2];
    let sil_peaks = extract_acoustic_snap_peaks(&silence, sr, 0.0, 0.2, 1.8);
    assert!(sil_peaks.is_empty(), "pure silence must yield zero snap peaks");
    let sil_snap = snap_boundary_to_acoustic_edge(&silence, sr, 0.0, 1.0, 0.045);
    assert!(!sil_snap.found, "pure silence must not snap");
    assert_eq!(sil_snap.kind, AcousticSnapKind::None);
    assert!((sil_snap.snapped_time_sec - 1.0).abs() < 1e-9);

    // 3. Stationary white noise: must NOT produce false snap peaks
    let mut state = 0xCAFE_BABE_1234_5678u64;
    let mut next_noise = || -> f32 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let u = (state >> 11) as f64 / ((1u64 << 53) as f64);
        (2.0 * u - 1.0) as f32 * 0.20
    };
    let white_noise: Vec<f32> = (0..(sr as usize * 2)).map(|_| next_noise()).collect();
    let noise_peaks = extract_acoustic_snap_peaks(&white_noise, sr, 0.0, 0.2, 1.8);
    assert!(
        noise_peaks.is_empty(),
        "stationary white noise must not emit snap peaks, got {}",
        noise_peaks.len()
    );
    let noise_snap = snap_boundary_to_acoustic_edge(&white_noise, sr, 0.0, 1.0, 0.045);
    assert!(!noise_snap.found, "stationary white noise must not snap");

    // 4. Synthetic speech-like transition (silence -> unvoiced fricative -> harmonic vowel -> silence)
    //    Verifies peaks are time-ordered, NMS-spaced >= 15ms, and snap finds the onset/CV transition.
    let n_total = (sr as usize) * 2;
    let mut sig = vec![0.0f32; n_total];
    for (i, slot) in sig.iter_mut().enumerate() {
        let t = (i as f64) / (sr as f64);
        if (0.50..0.70).contains(&t) {
            // High-frequency fricative-like burst (high-passed noise)
            let n0 = next_noise();
            *slot = n0 * 0.35;
        } else if (0.70..1.30).contains(&t) {
            // Voiced harmonic vowel (F0 = 150 Hz + formant harmonics)
            let env = ((t - 0.70) / 0.015).min(1.0) * ((1.30 - t) / 0.020).min(1.0);
            let f0 = 150.0;
            let val = 0.45 * (std::f64::consts::TAU * f0 * t).sin()
                + 0.30 * (std::f64::consts::TAU * 3.0 * f0 * t).sin()
                + 0.20 * (std::f64::consts::TAU * 5.0 * f0 * t).sin()
                + 0.12 * (std::f64::consts::TAU * 11.0 * f0 * t).sin();
            *slot = (val * env * 0.55) as f32;
        }
    }

    let peaks = extract_acoustic_snap_peaks(&sig, sr, 0.0, 0.1, 1.9);
    assert!(
        !peaks.is_empty(),
        "synthetic speech-like transition must yield acoustic snap peaks"
    );
    for w in peaks.windows(2) {
        assert!(
            w[1].time_sec - w[0].time_sec >= 0.014999,
            "NMS must keep peaks >= 15ms apart: {} vs {}",
            w[0].time_sec,
            w[1].time_sec
        );
    }
    for p in &peaks {
        assert!(p.time_sec >= 0.1 && p.time_sec <= 1.9);
        assert!(p.strength > 0.0 && p.strength <= 1.0);
        assert_ne!(p.kind, AcousticSnapKind::None);
    }

    // Snap near a detected peak (perturbed by +15 ms) must snap back accurately
    let anchor = peaks[0].time_sec;
    let snap = snap_boundary_to_acoustic_edge(&sig, sr, 0.0, anchor + 0.015, 0.045);
    assert!(snap.found, "snap near real acoustic transition must succeed");
    assert!(
        (snap.snapped_time_sec - anchor).abs() <= 0.012,
        "snapped time {} should land close to anchor {}",
        snap.snapped_time_sec,
        anchor
    );
    assert!(snap.confidence > 0.2);

    // Snap far inside leading silence (t = 0.15 s) must NOT snap
    let sil_edge = snap_boundary_to_acoustic_edge(&sig, sr, 0.0, 0.15, 0.045);
    assert!(
        !sil_edge.found,
        "target deep inside leading silence should not snap, got {:?}",
        sil_edge
    );
}
