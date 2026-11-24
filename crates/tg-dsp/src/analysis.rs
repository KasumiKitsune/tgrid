use crate::fft::{build_gaussian_window, fft_in_place, pre_emphasis};
use crate::DspError;
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;
use tg_core::model::LinearSeg;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchPoint {
    pub t: f64,
    pub f0: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormantPoint {
    pub t: f64,
    pub freqs: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSummary {
    pub sample_rate: u32,
    pub sample_count: usize,
    pub duration: f64,
    pub peak_amplitude: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAnalysisSummary {
    pub session_id: u32,
    pub sample_rate: u32,
    pub sample_count: usize,
    pub duration: f64,
    pub offset: f64,
    pub peak_amplitude: f32,
    pub spec_max_db: f64,
    pub f0_ceil: f64,
    pub pitch_track: Vec<PitchPoint>,
    pub formant_track: Vec<FormantPoint>,
}

#[derive(Debug, Clone)]
pub struct AudioAnalysis {
    pub sample_rate: u32,
    pub offset: f64,
    pub raw: Vec<f32>,
    pub pre: Vec<f32>,
    pub fft_size: usize,
    pub half_win: usize,
    pub g_win: Vec<f64>,
    pub peak_amplitude: f32,
    pub spec_max_db: f64,
    pub max_rms: f64,
    pub pitch_track: Vec<PitchPoint>,
    pub f0_ceil: f64,
    pub formant_track: Vec<FormantPoint>,
}

impl AudioAnalysis {
    pub fn to_summary(&self, session_id: u32) -> AudioAnalysisSummary {
        AudioAnalysisSummary {
            session_id,
            sample_rate: self.sample_rate,
            sample_count: self.raw.len(),
            duration: self.raw.len() as f64 / self.sample_rate as f64,
            offset: self.offset,
            peak_amplitude: self.peak_amplitude,
            spec_max_db: self.spec_max_db,
            f0_ceil: self.f0_ceil,
            pitch_track: self.pitch_track.clone(),
            formant_track: self.formant_track.clone(),
        }
    }

    /// Find nearest waveform zero-crossing within `max_window_sec` around `t`.
    pub fn find_nearest_zero_crossing(&self, t: f64, max_window_sec: f64) -> f64 {
        let sr = self.sample_rate as f64;
        let len = self.raw.len() as isize;
        if len < 2 {
            return t;
        }
        let c = ((t - self.offset) * sr).round() as isize;
        let max_span = (max_window_sec * sr).round().max(0.0) as isize;

        for d in 0..=max_span {
            let offsets: &[isize] = if d == 0 { &[0] } else { &[-d, d] };
            for &delta in offsets {
                let i = c + delta;
                if i >= 1 && i < len {
                    let a = self.raw[(i - 1) as usize];
                    let b = self.raw[i as usize];
                    if (a <= 0.0 && b >= 0.0) || (a >= 0.0 && b <= 0.0) {
                        let denom = (b - a) as f64;
                        let frac = if denom.abs() > 1e-9 {
                            (-(a as f64) / denom).clamp(0.0, 1.0)
                        } else {
                            0.0
                        };
                        return self.offset + ((i - 1) as f64 + frac) / sr;
                    }
                }
            }
        }
        t
    }

    /// Compute SVG path string `d` for waveform across a band's linear segments.
    pub fn compute_waveform_path(&self, segs: &[LinearSeg], y: f64, h: f64) -> String {
        if self.raw.is_empty() || h <= 0.0 {
            return String::new();
        }
        let sr = self.sample_rate as f64;
        let len = self.raw.len();
        let mid_y = y + h * 0.5;
        let amp_h = h * 0.44;
        let mut d = String::with_capacity(segs.len() * 64);

        for seg in segs {
            if seg.collapsed {
                continue;
            }
            let px_w = (seg.x1 - seg.x0).round() as isize;
            if px_w < 1 {
                continue;
            }
            let steps = (px_w as usize).min(1200).max(2);
            let dt = seg.t1 - seg.t0;
            if dt <= 0.0 {
                continue;
            }
            let step_px = (seg.x1 - seg.x0) / steps as f64;

            for i in 0..steps {
                let f0 = i as f64 / steps as f64;
                let f1 = (i + 1) as f64 / steps as f64;
                let s0 = (((seg.t0 + f0 * dt) - self.offset) * sr).floor() as isize;
                let s1 = (((seg.t0 + f1 * dt) - self.offset) * sr).ceil() as isize;
                let i0 = s0.clamp(0, (len - 1) as isize) as usize;
                let i1 = s1.clamp(i0 as isize + 1, len as isize) as usize;

                let mut lo = 1.0_f32;
                let mut hi = -1.0_f32;
                let stride = ((i1 - i0) / 32).max(1);
                let mut k = i0;
                while k < i1 {
                    let v = self.raw[k];
                    if v < lo {
                        lo = v;
                    }
                    if v > hi {
                        hi = v;
                    }
                    k += stride;
                }
                if lo > hi {
                    lo = 0.0;
                    hi = 0.0;
                }
                let x = seg.x0 + (i as f64 + 0.5) * step_px;
                let y_top = mid_y - (hi as f64) * amp_h;
                let y_bot = mid_y - (lo as f64) * amp_h;
                use std::fmt::Write;
                let _ = write!(d, "M{x:.1},{y_top:.1}L{x:.1},{:.1}", y_bot.max(y_top + 0.6));
            }
        }
        d
    }
}

pub fn summarize_pcm_f32(samples: &[f32], sample_rate: u32) -> Result<AudioSummary, DspError> {
    if sample_rate == 0 {
        return Err(DspError::InvalidAudio("sample_rate must be > 0".into()));
    }
    let peak = samples.iter().fold(0.0_f32, |acc, &s| acc.max(s.abs()));
    Ok(AudioSummary {
        sample_rate,
        sample_count: samples.len(),
        duration: samples.len() as f64 / sample_rate as f64,
        peak_amplitude: peak,
    })
}

/// Full acoustic analysis: pre-emphasis, global peak spectrogram dB, MPM F0 pitch tracker,
/// and anti-aliased decimated Levinson-Durbin LPC F1–F3 formant tracker.
pub fn analyze_pcm_f32(
    samples: Vec<f32>,
    sample_rate: u32,
    offset: f64,
) -> Result<AudioAnalysis, DspError> {
    if sample_rate == 0 {
        return Err(DspError::InvalidAudio("sample_rate must be > 0".into()));
    }
    let sr = sample_rate as f64;
    let len = samples.len();
    let peak_amplitude = samples.iter().fold(0.0_f32, |acc, &s| acc.max(s.abs()));
    let pre = pre_emphasis(&samples, sample_rate);
    let (fft_size, half_win, g_win) = build_gaussian_window(sample_rate);
    let win_len = g_win.len();

    // Estimate global peak spectrogram dB across sampled frames
    let mut re = vec![0.0_f64; fft_size];
    let mut im = vec![0.0_f64; fft_size];
    let mut spec_max_db = -120.0_f64;
    let probe_step = ((sr * 0.008).round() as usize)
        .max(len / 420)
        .max(1);
    let max_bin = (fft_size >> 1).min(((8000.0 / sr) * (fft_size as f64)).ceil() as usize);

    if len > half_win * 2 {
        let mut c = half_win;
        while c < len - half_win {
            re.fill(0.0);
            im.fill(0.0);
            for k in 0..win_len {
                re[k] = (pre[c - half_win + k] as f64) * g_win[k];
            }
            fft_in_place(&mut re, &mut im);
            for b in 1..=max_bin {
                let p = re[b] * re[b] + im[b] * im[b];
                if p > 1e-18 {
                    let db = 10.0 * p.log10();
                    if db > spec_max_db {
                        spec_max_db = db;
                    }
                }
            }
            c += probe_step;
        }
    }
    if spec_max_db < -90.0 {
        spec_max_db = 0.0;
    }

    // Global peak RMS for voicing gate
    let mut max_rms = 1e-6_f64;
    let rms_win = ((sr * 0.02).round() as usize).max(64);
    if len >= rms_win {
        let mut i = 0;
        while i + rms_win <= len {
            let mut s = 0.0_f64;
            for j in 0..rms_win {
                let v = samples[i + j] as f64;
                s += v * v;
            }
            let r = (s / rms_win as f64).sqrt();
            if r > max_rms {
                max_rms = r;
            }
            i += rms_win;
        }
    }

    // 1. Pitch F0 Extraction (Normalized Autocorrelation / MPM Peak Picking, 75..660 Hz)
    let mut pitch_track = Vec::new();
    let p_win = ((sr * 0.032).round() as usize).clamp(256, 2048);
    let p_hop = ((sr * 0.008).round() as usize).max(64);
    let min_lag = ((sr / 660.0).floor() as usize).max(4);
    let max_lag = ((sr / 75.0).ceil() as usize).min(p_win.saturating_sub(16));

    if len >= p_win && max_lag > min_lag + 2 {
        let mut nsdf = vec![0.0_f64; max_lag + 2];
        let mut start = 0usize;
        while start + p_win <= len {
            let t_center = offset + (start as f64 + p_win as f64 * 0.5) / sr;
            let mut energy = 0.0_f64;
            for i in 0..p_win {
                let v = samples[start + i] as f64;
                energy += v * v;
            }
            let rms = (energy / p_win as f64).sqrt();
            if rms < max_rms * 0.055 {
                pitch_track.push(PitchPoint {
                    t: t_center,
                    f0: None,
                });
                start += p_hop;
                continue;
            }

            let mut max_peak = -1.0_f64;
            for lag in min_lag..=max_lag {
                let mut acf = 0.0_f64;
                let mut m = 0.0_f64;
                let lim = p_win - lag;
                for i in 0..lim {
                    let a = samples[start + i] as f64;
                    let b = samples[start + i + lag] as f64;
                    acf += a * b;
                    m += a * a + b * b;
                }
                let val = if m > 1e-12 { (2.0 * acf) / m } else { 0.0 };
                nsdf[lag] = val;
                if val > max_peak {
                    max_peak = val;
                }
            }

            if max_peak < 0.58 {
                pitch_track.push(PitchPoint {
                    t: t_center,
                    f0: None,
                });
                start += p_hop;
                continue;
            }

            let thresh = (max_peak * 0.86).max(0.58);
            let mut best_lag: Option<usize> = None;
            for lag in (min_lag + 1)..max_lag {
                if nsdf[lag] >= thresh && nsdf[lag] >= nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1] {
                    best_lag = Some(lag);
                    break;
                }
            }
            let f0_opt = match best_lag {
                None => None,
                Some(bl) => {
                    let y0 = nsdf[bl - 1];
                    let y1 = nsdf[bl];
                    let y2 = nsdf[bl + 1];
                    let denom = y0 - 2.0 * y1 + y2;
                    let shift = if denom.abs() > 1e-9 {
                        (0.5 * (y0 - y2) / denom).clamp(-0.5, 0.5)
                    } else {
                        0.0
                    };
                    let f0 = sr / (bl as f64 + shift);
                    if (70.0..=670.0).contains(&f0) {
                        Some(f0)
                    } else {
                        None
                    }
                }
            };
            pitch_track.push(PitchPoint {
                t: t_center,
                f0: f0_opt,
            });
            start += p_hop;
        }
    }

    // 3-point median smooth on voiced F0
    if pitch_track.len() >= 3 {
        let orig: Vec<Option<f64>> = pitch_track.iter().map(|p| p.f0).collect();
        for i in 1..(pitch_track.len() - 1) {
            match (orig[i - 1], orig[i], orig[i + 1]) {
                (Some(a), Some(b), Some(c)) => {
                    let mut arr = [a, b, c];
                    arr.sort_by(|x, y| x.total_cmp(y));
                    pitch_track[i].f0 = Some(arr[1]);
                }
                (None, Some(_), None) => {
                    pitch_track[i].f0 = None;
                }
                _ => {}
            }
        }
    }

    let mut max_f0 = 500.0_f64;
    for p in &pitch_track {
        if let Some(f0) = p.f0 {
            if f0 > max_f0 {
                max_f0 = f0;
            }
        }
    }
    let f0_ceil = ((max_f0 / 50.0).ceil() * 50.0).clamp(500.0, 700.0);

    // 2. Formants F1-F3 Extraction (Anti-Aliased Windowed-Sinc FIR Decimation + Levinson-Durbin Order-10 LPC)
    let mut formant_track = Vec::new();
    let dec = ((sr / 10_000.0).round() as usize).max(1);
    let eff_sr = sr / dec as f64;
    let dec_owned: Vec<f32>;
    let dec_signal: &[f32] = if dec > 1 {
        let lpf_half = (dec * 4).clamp(12, 64);
        let tap_count = lpf_half * 2 + 1;
        let mut lpf_kernel = vec![0.0_f64; tap_count];
        let fc_norm = 0.42 / dec as f64;
        let mut k_sum = 0.0_f64;
        for k in -(lpf_half as isize)..=(lpf_half as isize) {
            let kf = k as f64;
            let sinc = if k == 0 {
                2.0 * fc_norm
            } else {
                (2.0 * PI * fc_norm * kf).sin() / (PI * kf)
            };
            let hann = 0.5 * (1.0 + (PI * kf / lpf_half as f64).cos());
            let wv = sinc * hann;
            lpf_kernel[(k + lpf_half as isize) as usize] = wv;
            k_sum += wv;
        }
        if k_sum > 0.0 {
            for v in &mut lpf_kernel {
                *v /= k_sum;
            }
        }
        let dec_len = len / dec;
        let mut ds = vec![0.0_f32; dec_len];
        for (n, slot) in ds.iter_mut().enumerate() {
            let center = (n * dec) as isize;
            let mut acc = 0.0_f64;
            for k in -(lpf_half as isize)..=(lpf_half as isize) {
                let idx = center + k;
                if idx >= 0 && (idx as usize) < len {
                    acc += (samples[idx as usize] as f64)
                        * lpf_kernel[(k + lpf_half as isize) as usize];
                }
            }
            *slot = acc as f32;
        }
        dec_owned = ds;
        &dec_owned
    } else {
        &samples
    };

    let dec_len = dec_signal.len();
    let f_win_dec = ((eff_sr * 0.025).round() as usize).max(40);
    let f_hop_dec = ((eff_sr * 0.01).round() as usize).max(16);
    const P_ORDER: usize = 10;
    const N_BINS: usize = 110;

    if dec_len >= f_win_dec {
        let mut dec_buf = vec![0.0_f64; f_win_dec];
        let mut r_auto = [0.0_f64; P_ORDER + 1];
        let mut lpc_a = [0.0_f64; P_ORDER + 1];
        let mut lpc_prev = [0.0_f64; P_ORDER + 1];
        let mut env = [0.0_f64; N_BINS];

        let mut start = 0usize;
        while start + f_win_dec <= dec_len {
            let t_center = offset + (start as f64 + f_win_dec as f64 * 0.5) / eff_sr;
            let mut e_sum = 0.0_f64;
            for i in 0..f_win_dec {
                let s = dec_signal[start + i] as f64;
                e_sum += s * s;
                dec_buf[i] = s;
            }
            if (e_sum / f_win_dec as f64).sqrt() < max_rms * 0.07 {
                start += f_hop_dec;
                continue;
            }

            // Pre-emphasis + Hamming window
            for i in (1..f_win_dec).rev() {
                let w = 0.54 - 0.46 * ((2.0 * PI * i as f64) / (f_win_dec - 1) as f64).cos();
                dec_buf[i] = (dec_buf[i] - 0.95 * dec_buf[i - 1]) * w;
            }
            dec_buf[0] *= 0.08;

            for lag in 0..=P_ORDER {
                let mut s = 0.0_f64;
                for i in 0..(f_win_dec - lag) {
                    s += dec_buf[i] * dec_buf[i + lag];
                }
                r_auto[lag] = s;
            }
            if r_auto[0] < 1e-10 {
                start += f_hop_dec;
                continue;
            }

            // Levinson-Durbin recursion
            lpc_a.fill(0.0);
            lpc_a[0] = 1.0;
            let mut err = r_auto[0];
            let mut valid = true;
            for m in 1..=P_ORDER {
                let mut acc = r_auto[m];
                for j in 1..m {
                    acc += lpc_a[j] * r_auto[m - j];
                }
                let k = -acc / err;
                if !k.is_finite() || k.abs() >= 0.999 {
                    valid = false;
                    break;
                }
                for j in 1..m {
                    lpc_prev[j] = lpc_a[j] + k * lpc_a[m - j];
                }
                lpc_a[1..m].copy_from_slice(&lpc_prev[1..m]);
                lpc_a[m] = k;
                err *= 1.0 - k * k;
                if err <= 1e-12 {
                    valid = false;
                    break;
                }
            }
            if !valid {
                start += f_hop_dec;
                continue;
            }

            let f_min = 180.0_f64;
            let f_max = (eff_sr * 0.46).min(4600.0);
            for (b, slot) in env.iter_mut().enumerate() {
                let freq = f_min + (b as f64 / (N_BINS - 1) as f64) * (f_max - f_min);
                let w = (2.0 * PI * freq) / eff_sr;
                let mut c_re = 1.0_f64;
                let mut c_im = 0.0_f64;
                for (m, &am) in lpc_a.iter().enumerate().skip(1) {
                    let wm = w * m as f64;
                    c_re += am * wm.cos();
                    c_im -= am * wm.sin();
                }
                *slot = -(c_re * c_re + c_im * c_im + 1e-12).ln();
            }

            let mut peaks = Vec::with_capacity(3);
            for b in 1..(N_BINS - 1) {
                if env[b] > env[b - 1] && env[b] > env[b + 1] && env[b] > 0.6 {
                    let freq = f_min + (b as f64 / (N_BINS - 1) as f64) * (f_max - f_min);
                    if peaks.last().is_none_or(|&prev| freq - prev >= 240.0) {
                        peaks.push(freq);
                        if peaks.len() == 3 {
                            break;
                        }
                    }
                }
            }
            if !peaks.is_empty() {
                formant_track.push(FormantPoint {
                    t: t_center,
                    freqs: peaks,
                });
            }

            start += f_hop_dec;
        }
    }

    Ok(AudioAnalysis {
        sample_rate,
        offset,
        raw: samples,
        pre,
        fft_size,
        half_win,
        g_win,
        peak_amplitude,
        spec_max_db,
        max_rms,
        pitch_track,
        f0_ceil,
        formant_track,
    })
}
