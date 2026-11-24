use std::fs;
use std::path::Path;
use tg_core::model::{ContourBox, LinearSeg};
use tg_dsp::{
    analyze_pcm_f32, compute_spectrogram_grid, decode_wav_bytes, load_pcm_session,
    load_wav_session, remove_audio_session, render_spectrogram_rgba, session_compute_contours,
    session_render_spectrogram_rgba, session_waveform_path, session_zero_crossing, DspError,
};

#[test]
fn test_dialogue_wav_decode_analysis_and_spectrogram() {
    let wav_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/web/public/samples/two_speaker_dialogue.wav");
    let bytes = fs::read(&wav_path).expect("read two_speaker_dialogue.wav");

    let decoded = decode_wav_bytes(&bytes).expect("decode WAV");
    assert!(decoded.sample_rate >= 8000);
    assert!(!decoded.mono.is_empty());

    let analysis = analyze_pcm_f32(decoded.mono.clone(), decoded.sample_rate, 0.0)
        .expect("analyze dialogue audio");
    let dur = analysis.raw.len() as f64 / analysis.sample_rate as f64;
    assert!(dur > 10.0, "expected >10s dialogue, got {dur}");
    assert!(analysis.spec_max_db.is_finite());

    let voiced_f0: Vec<f64> = analysis.pitch_track.iter().filter_map(|p| p.f0).collect();
    assert!(!voiced_f0.is_empty(), "expected non-empty voiced F0 points");
    assert!(
        voiced_f0.iter().all(|&f0| (60.0..=700.0).contains(&f0)),
        "all voiced F0 points must be within plausible vocal pitch bounds"
    );
    assert!(!analysis.formant_track.is_empty(), "expected non-empty formant track");
    assert!(
        analysis.formant_track.iter().any(|f| f.freqs.len() >= 2),
        "expected detected F1 and F2 peaks"
    );

    let segs = vec![LinearSeg {
        x0: 40.0,
        x1: 340.0,
        t0: 0.5,
        t1: 2.5,
        collapsed: false,
    }];

    // Spectrogram grid
    let grid = compute_spectrogram_grid(&analysis, &segs, 40.0, 300.0, 5000.0, 80, 40, 55.0, true);
    assert_eq!(grid.len(), 80 * 40);
    assert!(grid.iter().any(|&v| v > 0.2), "grid should contain non-zero acoustic energy");
    assert!(grid.iter().all(|&v| (0.0..=1.0).contains(&v)));

    // RGBA rasterizer (warm & bw)
    for palette in ["warm", "bw"] {
        let (w, h, rgba) =
            render_spectrogram_rgba(&analysis, &segs, 40.0, 300.0, 60.0, 5000.0, 2.0, 55.0, palette);
        assert_eq!(w, 600);
        assert_eq!(h, 120);
        assert_eq!(rgba.len(), (w * h * 4) as usize);
        assert!(rgba.chunks_exact(4).all(|px| px[3] == 255));
        if palette == "bw" {
            assert!(
                rgba.chunks_exact(4).all(|px| px[0] == px[1] && px[1] == px[2]),
                "bw spectrogram RGBA pixels must be strictly achromatic (R == G == B)"
            );
        }
    }

    // Stateful session API
    let summary = load_wav_session(&bytes, 0.0).expect("load wav session");
    assert!(summary.session_id >= 1);
    assert!((summary.duration - dur).abs() < 1e-6);

    let rgba_out = session_render_spectrogram_rgba(
        summary.session_id,
        &segs,
        40.0,
        300.0,
        50.0,
        5000.0,
        1.0,
        55.0,
        "warm",
    )
    .expect("session rgba");
    assert_eq!(rgba_out.width, 300);
    assert_eq!(rgba_out.height, 50);

    let contours = session_compute_contours(
        summary.session_id,
        &segs,
        40.0,
        300.0,
        5000.0,
        90,
        45,
        55.0,
        true,
        ContourBox {
            x: 40.0,
            y: 10.0,
            width: 300.0,
            height: 60.0,
        },
        6,
        "warm",
    )
    .expect("session contours");
    assert!(!contours.is_empty(), "expected spectrogram contours on speech segment");

    let wf_path = session_waveform_path(summary.session_id, &segs, 10.0, 36.0)
        .expect("session waveform path");
    assert!(wf_path.starts_with('M'));

    let zc = session_zero_crossing(summary.session_id, 1.0, 0.02).expect("zero crossing");
    assert!((zc - 1.0).abs() <= 0.025);

    assert!(remove_audio_session(summary.session_id));
}

#[test]
fn test_extreme_wav_fixtures_decode() {
    let dir = Path::new(r"C:\Users\Sager\Desktop\Praat_Extreme_Examples");
    if !dir.exists() {
        eprintln!("Skipping external Praat_Extreme_Examples WAV test (directory not present)");
        return;
    }

    for fname in [
        "01_multilingual_quotes.wav",
        "02_two_speaker_dialogue.wav",
        "03_rapid_staccato_utf16be.wav",
    ] {
        let path = dir.join(fname);
        if !path.exists() {
            continue;
        }
        let bytes = fs::read(&path).expect("read extreme wav");
        let wav = decode_wav_bytes(&bytes).unwrap_or_else(|e| panic!("decode {fname}: {e}"));
        let analysis = analyze_pcm_f32(wav.mono, wav.sample_rate, 0.0)
            .unwrap_or_else(|e| panic!("analyze {fname}: {e}"));
        let dur = analysis.raw.len() as f64 / analysis.sample_rate as f64;
        assert!(dur > 0.1, "{fname} duration too short: {dur}");
        assert!(analysis.spec_max_db.is_finite());
    }
}

#[test]
fn test_synthetic_sine_pitch_accuracy() {
    // Generate a 0.6s 220Hz sine wave at 16kHz and verify F0 tracking accuracy
    let sr = 16000u32;
    let n = (sr as f64 * 0.6) as usize;
    let samples: Vec<f32> = (0..n)
        .map(|i| (2.0 * std::f32::consts::PI * 220.0 * (i as f32) / (sr as f32)).sin() * 0.6)
        .collect();
    let analysis = analyze_pcm_f32(samples, sr, 0.0).expect("analyze 220Hz sine");
    let voiced: Vec<f64> = analysis.pitch_track.iter().filter_map(|p| p.f0).collect();
    assert!(!voiced.is_empty());
    let avg_f0: f64 = voiced.iter().sum::<f64>() / (voiced.len() as f64);
    assert!(
        (avg_f0 - 220.0).abs() < 6.0,
        "expected ~220Hz F0 on pure sine, got {avg_f0:.2}Hz"
    );
}

#[test]
fn test_multi_session_audio_store_isolation_and_removal() {
    let sr = 16000u32;
    let n = (sr as f64 * 0.4) as usize;
    let sine_a: Vec<f32> = (0..n)
        .map(|i| (2.0 * std::f32::consts::PI * 220.0 * (i as f32) / (sr as f32)).sin() * 0.5)
        .collect();
    let sine_b: Vec<f32> = (0..n)
        .map(|i| (2.0 * std::f32::consts::PI * 440.0 * (i as f32) / (sr as f32)).sin() * 0.8)
        .collect();

    let s1 = load_pcm_session(sine_a, sr, 0.0).expect("load session 1");
    let s2 = load_pcm_session(sine_b, sr, 1.0).expect("load session 2");
    assert_ne!(s1.session_id, s2.session_id);
    assert!(s2.session_id > s1.session_id);

    let seg_a = vec![LinearSeg {
        x0: 0.0,
        x1: 120.0,
        t0: 0.05,
        t1: 0.35,
        collapsed: false,
    }];
    let seg_b = vec![LinearSeg {
        x0: 0.0,
        x1: 120.0,
        t0: 1.05,
        t1: 1.35,
        collapsed: false,
    }];

    // Both sessions coexist and render independently
    let wf1 = session_waveform_path(s1.session_id, &seg_a, 0.0, 40.0).expect("wf1 active");
    let wf2 = session_waveform_path(s2.session_id, &seg_b, 0.0, 40.0).expect("wf2 active");
    assert!(wf1.starts_with('M'));
    assert!(wf2.starts_with('M'));
    assert_ne!(wf1, wf2);

    let spec1 = session_render_spectrogram_rgba(
        s1.session_id,
        &seg_a,
        0.0,
        120.0,
        40.0,
        5000.0,
        1.0,
        52.0,
        "warm",
    )
    .expect("spec1 active");
    let spec2 = session_render_spectrogram_rgba(
        s2.session_id,
        &seg_b,
        0.0,
        120.0,
        40.0,
        5000.0,
        1.0,
        52.0,
        "warm",
    )
    .expect("spec2 active");
    assert_eq!(spec1.width, 120);
    assert_eq!(spec2.width, 120);

    // Removing session 1 evicts only session 1, leaving session 2 intact
    assert!(remove_audio_session(s1.session_id));
    assert!(!remove_audio_session(s1.session_id));
    assert!(matches!(
        session_zero_crossing(s1.session_id, 0.2, 0.02),
        Err(DspError::SessionNotFound(id)) if id == s1.session_id
    ));
    let zc2 = session_zero_crossing(s2.session_id, 1.2, 0.02).expect("s2 still alive");
    assert!((zc2 - 1.2).abs() <= 0.025);

    // Removing session 2 cleans up cleanly
    assert!(remove_audio_session(s2.session_id));
    assert!(matches!(
        session_waveform_path(s2.session_id, &seg_b, 0.0, 40.0),
        Err(DspError::SessionNotFound(id)) if id == s2.session_id
    ));
}
