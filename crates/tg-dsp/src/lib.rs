pub mod analysis;
pub mod fft;
pub mod spectrogram;
pub mod wav;

pub use analysis::{
    analyze_pcm_f32, summarize_pcm_f32, AudioAnalysis, AudioAnalysisSummary, AudioSummary,
    FormantPoint, PitchPoint,
};
pub use spectrogram::{compute_spectrogram_grid, render_spectrogram_rgba};
pub use wav::{decode_wav_bytes, DecodedWav};

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tg_core::model::{ContourBox, ContourPath, LinearSeg};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DspError {
    #[error("Invalid audio data: {0}")]
    InvalidAudio(String),
    #[error("Audio session not found: {0}")]
    SessionNotFound(u32),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectrogramRgbaOutput {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

struct SessionSlot {
    next_id: u32,
    sessions: HashMap<u32, AudioAnalysis>,
}

fn session_store() -> &'static Mutex<SessionSlot> {
    static STORE: OnceLock<Mutex<SessionSlot>> = OnceLock::new();
    STORE.get_or_init(|| {
        Mutex::new(SessionSlot {
            next_id: 1,
            sessions: HashMap::new(),
        })
    })
}

/// Load & analyze raw mono PCM f32 samples into a new multi-session audio entry.
pub fn load_pcm_session(
    samples: Vec<f32>,
    sample_rate: u32,
    offset: f64,
) -> Result<AudioAnalysisSummary, DspError> {
    let analysis = analyze_pcm_f32(samples, sample_rate, offset)?;
    let mut guard = session_store()
        .lock()
        .map_err(|_| DspError::InvalidAudio("Audio session lock poisoned".into()))?;
    let mut id = guard.next_id;
    while id == 0 || guard.sessions.contains_key(&id) {
        id = id.wrapping_add(1).max(1);
    }
    guard.next_id = id.wrapping_add(1).max(1);
    let summary = analysis.to_summary(id);
    guard.sessions.insert(id, analysis);
    Ok(summary)
}

/// Decode WAV bytes and analyze into a new multi-session audio entry.
pub fn load_wav_session(bytes: &[u8], offset: f64) -> Result<AudioAnalysisSummary, DspError> {
    let wav = decode_wav_bytes(bytes)?;
    load_pcm_session(wav.mono, wav.sample_rate, offset)
}

/// Remove a single audio session by ID. Returns true if it existed.
pub fn remove_audio_session(session_id: u32) -> bool {
    if let Ok(mut guard) = session_store().lock() {
        guard.sessions.remove(&session_id).is_some()
    } else {
        false
    }
}

/// Clear all audio sessions.
pub fn clear_audio_session() {
    if let Ok(mut guard) = session_store().lock() {
        guard.sessions.clear();
    }
}

pub fn with_session<R, F>(session_id: u32, f: F) -> Result<R, DspError>
where
    F: FnOnce(&AudioAnalysis) -> R,
{
    let guard = session_store()
        .lock()
        .map_err(|_| DspError::InvalidAudio("Audio session lock poisoned".into()))?;
    match guard.sessions.get(&session_id) {
        Some(analysis) => Ok(f(analysis)),
        None => Err(DspError::SessionNotFound(session_id)),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn session_render_spectrogram_rgba(
    session_id: u32,
    segs: &[LinearSeg],
    band_origin_x: f64,
    band_content_w: f64,
    spec_h: f64,
    max_freq: f64,
    scale: f64,
    dyn_range: f64,
    palette_key: &str,
) -> Result<SpectrogramRgbaOutput, DspError> {
    with_session(session_id, |analysis| {
        let (width, height, rgba) = render_spectrogram_rgba(
            analysis,
            segs,
            band_origin_x,
            band_content_w,
            spec_h,
            max_freq,
            scale,
            dyn_range,
            palette_key,
        );
        SpectrogramRgbaOutput {
            width,
            height,
            rgba,
        }
    })
}

#[allow(clippy::too_many_arguments)]
pub fn session_compute_contours(
    session_id: u32,
    segs: &[LinearSeg],
    band_origin_x: f64,
    band_content_w: f64,
    max_freq: f64,
    cols: usize,
    rows: usize,
    dyn_range: f64,
    smooth: bool,
    box_rect: ContourBox,
    levels: usize,
    palette_key: &str,
) -> Result<Vec<ContourPath>, DspError> {
    with_session(session_id, |analysis| {
        let grid = compute_spectrogram_grid(
            analysis,
            segs,
            band_origin_x,
            band_content_w,
            max_freq,
            cols,
            rows,
            dyn_range,
            smooth,
        );
        tg_core::generate_spectrogram_contours(&grid, cols, rows, box_rect, levels, palette_key)
    })
}

pub fn session_waveform_path(
    session_id: u32,
    segs: &[LinearSeg],
    y: f64,
    h: f64,
) -> Result<String, DspError> {
    with_session(session_id, |analysis| analysis.compute_waveform_path(segs, y, h))
}

pub fn session_zero_crossing(
    session_id: u32,
    t: f64,
    max_window_sec: f64,
) -> Result<f64, DspError> {
    with_session(session_id, |analysis| {
        analysis.find_nearest_zero_crossing(t, max_window_sec)
    })
}
