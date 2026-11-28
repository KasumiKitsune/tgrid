pub mod analysis;
pub mod fft;
pub mod spectrogram;
pub mod wav;

pub use analysis::{
    analyze_pcm_f32, summarize_pcm_f32, AudioAnalysis, AudioAnalysisSummary, AudioSummary,
    FormantPoint, PitchPoint,
};
pub use spectrogram::{
    build_palette_lut, colorize_spectrogram_rgba, compute_spectrogram_grid,
    compute_spectrogram_raster_matrix, render_spectrogram_rgba,
};
pub use wav::{decode_wav_bytes, DecodedWav};

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use tg_core::model::{ContourBox, ContourPath, LinearSeg};
use thiserror::Error;

const MAX_SPEC_CACHE_PER_SESSION: usize = 24;

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

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SpecCacheKey {
    kind: u8, // 0 = raster matrix, 1 = contour grid
    width: usize,
    height: usize,
    band_origin_x_bits: u64,
    band_content_w_bits: u64,
    max_freq_bits: u64,
    dyn_range_bits: u64,
    smooth: bool,
    segs_sig: Vec<(u64, u64, u64, u64, bool)>,
}

impl SpecCacheKey {
    fn quant_bits(v: f64) -> u64 {
        if !v.is_finite() {
            0
        } else {
            ((v * 1e6).round() as i64) as u64
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn new(
        kind: u8,
        width: usize,
        height: usize,
        band_origin_x: f64,
        band_content_w: f64,
        max_freq: f64,
        dyn_range: f64,
        smooth: bool,
        segs: &[LinearSeg],
    ) -> Self {
        let segs_sig = segs
            .iter()
            .map(|s| {
                (
                    Self::quant_bits(s.x0),
                    Self::quant_bits(s.x1),
                    Self::quant_bits(s.t0),
                    Self::quant_bits(s.t1),
                    s.collapsed,
                )
            })
            .collect();
        Self {
            kind,
            width,
            height,
            band_origin_x_bits: Self::quant_bits(band_origin_x),
            band_content_w_bits: Self::quant_bits(band_content_w),
            max_freq_bits: Self::quant_bits(max_freq),
            dyn_range_bits: Self::quant_bits(dyn_range),
            smooth,
            segs_sig,
        }
    }
}

struct CachedSpecMatrix {
    width: u32,
    height: u32,
    values: Vec<f32>,
}

struct SessionEntry {
    analysis: AudioAnalysis,
    spec_cache: HashMap<SpecCacheKey, Arc<CachedSpecMatrix>>,
    spec_cache_order: VecDeque<SpecCacheKey>,
    spec_cache_hits: usize,
}

impl SessionEntry {
    fn new(analysis: AudioAnalysis) -> Self {
        Self {
            analysis,
            spec_cache: HashMap::new(),
            spec_cache_order: VecDeque::new(),
            spec_cache_hits: 0,
        }
    }

    fn insert_spec_cache(&mut self, key: SpecCacheKey, val: Arc<CachedSpecMatrix>) {
        if self.spec_cache.contains_key(&key) {
            self.spec_cache.insert(key, val);
            return;
        }
        while self.spec_cache_order.len() >= MAX_SPEC_CACHE_PER_SESSION {
            if let Some(oldest) = self.spec_cache_order.pop_front() {
                self.spec_cache.remove(&oldest);
            }
        }
        self.spec_cache_order.push_back(key.clone());
        self.spec_cache.insert(key, val);
    }
}

struct SessionSlot {
    next_id: u32,
    sessions: HashMap<u32, SessionEntry>,
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
    guard.sessions.insert(id, SessionEntry::new(analysis));
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

/// Diagnostic helper returning `(cached_entries, cache_hits)` for a session's normalized dB matrix cache.
pub fn session_spec_cache_stats(session_id: u32) -> Result<(usize, usize), DspError> {
    let guard = session_store()
        .lock()
        .map_err(|_| DspError::InvalidAudio("Audio session lock poisoned".into()))?;
    match guard.sessions.get(&session_id) {
        Some(entry) => Ok((entry.spec_cache.len(), entry.spec_cache_hits)),
        None => Err(DspError::SessionNotFound(session_id)),
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
        Some(entry) => Ok(f(&entry.analysis)),
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
    if band_content_w < 2.0 || spec_h < 4.0 {
        return Ok(SpectrogramRgbaOutput {
            width: 0,
            height: 0,
            rgba: Vec::new(),
        });
    }
    let eff_scale = scale.clamp(0.5, 6.0);
    let px_w = (band_content_w * eff_scale).round().max(2.0) as usize;
    let px_h = (spec_h * eff_scale).round().max(4.0) as usize;
    let key = SpecCacheKey::new(
        0,
        px_w,
        px_h,
        band_origin_x,
        band_content_w,
        max_freq,
        dyn_range,
        false,
        segs,
    );

    let matrix = {
        let mut guard = session_store()
            .lock()
            .map_err(|_| DspError::InvalidAudio("Audio session lock poisoned".into()))?;
        let entry = guard
            .sessions
            .get_mut(&session_id)
            .ok_or(DspError::SessionNotFound(session_id))?;
        if let Some(cached) = entry.spec_cache.get(&key) {
            entry.spec_cache_hits += 1;
            Arc::clone(cached)
        } else {
            let (width, height, values) = compute_spectrogram_raster_matrix(
                &entry.analysis,
                segs,
                band_origin_x,
                band_content_w,
                spec_h,
                max_freq,
                scale,
                dyn_range,
            );
            let arc = Arc::new(CachedSpecMatrix {
                width,
                height,
                values,
            });
            entry.insert_spec_cache(key, Arc::clone(&arc));
            arc
        }
    };

    let rgba = colorize_spectrogram_rgba(matrix.width, matrix.height, &matrix.values, palette_key);
    Ok(SpectrogramRgbaOutput {
        width: matrix.width,
        height: matrix.height,
        rgba,
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
    let key = SpecCacheKey::new(
        1,
        cols,
        rows,
        band_origin_x,
        band_content_w,
        max_freq,
        dyn_range,
        smooth,
        segs,
    );

    let grid = {
        let mut guard = session_store()
            .lock()
            .map_err(|_| DspError::InvalidAudio("Audio session lock poisoned".into()))?;
        let entry = guard
            .sessions
            .get_mut(&session_id)
            .ok_or(DspError::SessionNotFound(session_id))?;
        if let Some(cached) = entry.spec_cache.get(&key) {
            entry.spec_cache_hits += 1;
            Arc::clone(cached)
        } else {
            let values = compute_spectrogram_grid(
                &entry.analysis,
                segs,
                band_origin_x,
                band_content_w,
                max_freq,
                cols,
                rows,
                dyn_range,
                smooth,
            );
            let arc = Arc::new(CachedSpecMatrix {
                width: cols as u32,
                height: rows as u32,
                values,
            });
            entry.insert_spec_cache(key, Arc::clone(&arc));
            arc
        }
    };

    Ok(tg_core::generate_spectrogram_contours(
        &grid.values,
        cols,
        rows,
        box_rect,
        levels,
        palette_key,
    ))
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

/// Clamped padded mono PCM window sliced directly from an active session's `AudioAnalysis.raw`.
#[derive(Debug, Clone)]
pub struct SessionPcmWindow {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub pad_origin_sec: f64,
    pub start_sec: f64,
    pub end_sec: f64,
    pub duration_sec: f64,
}

/// Extract a padded mono PCM slice for audio-relative `[start_sec, end_sec]` from an active session.
/// Copies only the requested chunk window and immediately releases the session mutex so concurrent
/// spectrogram/waveform requests are never blocked during neural inference.
pub fn session_pcm_window(
    session_id: u32,
    start_sec: f64,
    end_sec: f64,
    pad_sec: f64,
) -> Result<SessionPcmWindow, DspError> {
    with_session(session_id, |analysis| {
        let sr = analysis.sample_rate;
        let len = analysis.raw.len();
        if sr == 0 || len == 0 {
            return SessionPcmWindow {
                samples: Vec::new(),
                sample_rate: sr,
                pad_origin_sec: 0.0,
                start_sec: 0.0,
                end_sec: 0.0,
                duration_sec: 0.0,
            };
        }
        let fs = sr as f64;
        let duration_sec = (len as f64) / fs;
        let s0 = if start_sec.is_finite() {
            start_sec.clamp(0.0, duration_sec)
        } else {
            0.0
        };
        let s1 = if end_sec.is_finite() {
            end_sec.clamp(s0, duration_sec)
        } else {
            duration_sec
        };
        let pad = if pad_sec.is_finite() && pad_sec > 0.0 {
            pad_sec
        } else {
            0.0
        };
        let pad_l = (s0 - pad).max(0.0);
        let pad_r = (s1 + pad).min(duration_sec);
        let lo = ((pad_l * fs).floor() as usize).min(len);
        let hi = ((pad_r * fs).ceil() as usize).min(len);
        let pad_origin_sec = (lo as f64) / fs;
        let samples = if hi > lo {
            analysis.raw[lo..hi].to_vec()
        } else {
            Vec::new()
        };
        SessionPcmWindow {
            samples,
            sample_rate: sr,
            pad_origin_sec,
            start_sec: s0,
            end_sec: s1,
            duration_sec,
        }
    })
}
