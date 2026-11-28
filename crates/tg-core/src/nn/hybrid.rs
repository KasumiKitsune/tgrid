use crate::acoustic_split::{
    AcousticClass, AcousticSplitInput, AcousticSplitOutput, SplitGranularity,
};
use crate::nn::tgnn::{
    MicroSegNet, MicroSegPosteriors, MANNER_BURST_ASP, MANNER_FRIC_VL, MANNER_LIQUID_GLIDE,
    MANNER_NASAL, MANNER_OBS_VD, MANNER_SIL, MANNER_STOP_CL, MANNER_VOWEL,
};
use serde::{Deserialize, Serialize};
use std::f64::consts::TAU;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VadSegment {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VadParams {
    pub frame_ms: f64,
    pub hop_ms: f64,
    pub min_speech_ms: f64,
    pub merge_gap_ms: f64,
    pub split_gap_ms: f64,
    pub pad_ms: f64,
    pub snap_zero_crossing: bool,
}

impl Default for VadParams {
    fn default() -> Self {
        Self {
            frame_ms: 20.0,
            hop_ms: 10.0,
            min_speech_ms: 60.0,
            merge_gap_ms: 180.0,
            split_gap_ms: 250.0,
            pad_ms: 25.0,
            snap_zero_crossing: true,
        }
    }
}

fn find_zero_crossing(samples: &[f32], sample_rate: u32, t_sec: f64) -> f64 {
    if samples.len() < 2 || sample_rate == 0 {
        return t_sec;
    }
    let fs = sample_rate as f64;
    let center = (t_sec * fs).round() as isize;
    let search_rad = ((0.008 * fs).round() as isize).max(8);
    let lo = (center - search_rad).max(1) as usize;
    let hi = (center + search_rad).min((samples.len() as isize) - 1) as usize;
    let mut best_idx = center.clamp(0, (samples.len() - 1) as isize) as usize;
    let mut best_dist = usize::MAX;
    for i in lo..=hi {
        let prev = samples[i - 1];
        let cur = samples[i];
        if (prev <= 0.0 && cur >= 0.0) || (prev >= 0.0 && cur <= 0.0) {
            let d = i.abs_diff(center.max(0) as usize);
            if d < best_dist {
                best_dist = d;
                best_idx = i;
            }
        }
    }
    (best_idx as f64) / fs
}

/// Exact Rust mirror of `apps/web/src/audio/vad.ts` for apples-to-apples benchmarking.
pub fn detect_speech_segments_dsp(
    mono: &[f32],
    sample_rate: u32,
    params: &VadParams,
) -> Vec<VadSegment> {
    if mono.is_empty() || sample_rate == 0 {
        return Vec::new();
    }
    let fs = sample_rate as f64;
    let duration = (mono.len() as f64) / fs;
    let min_speech_sec = params.min_speech_ms / 1000.0;
    let split_gap_sec = params.split_gap_ms / 1000.0;
    let merge_gap_sec = (params.merge_gap_ms / 1000.0).min(split_gap_sec);
    let pad_sec = params.pad_ms / 1000.0;

    let win_len = ((params.frame_ms / 1000.0) * fs).round().max(16.0) as usize;
    let hop_len = ((params.hop_ms / 1000.0) * fs).round().max(8.0) as usize;
    if mono.len() < win_len {
        return Vec::new();
    }

    let frame_count = (mono.len() - win_len) / hop_len + 1;
    let mut log_e = vec![0.0f64; frame_count];
    let mut zcr = vec![0.0f64; frame_count];

    for f in 0..frame_count {
        let base = f * hop_len;
        let mut sum_sq = 0.0f64;
        let mut crossings = 0usize;
        let mut prev = mono[base] as f64;
        sum_sq += prev * prev;
        for i in 1..win_len {
            let cur = mono[base + i] as f64;
            sum_sq += cur * cur;
            if (prev >= 0.0 && cur < 0.0) || (prev < 0.0 && cur >= 0.0) {
                crossings += 1;
            }
            prev = cur;
        }
        log_e[f] = 10.0 * (sum_sq / (win_len as f64) + 1e-10).log10();
        zcr[f] = (crossings as f64) / ((win_len - 1) as f64);
    }

    let mut sorted_e = log_e.clone();
    sorted_e.sort_by(|a, b| a.total_cmp(b));
    let noise_floor = sorted_e[((frame_count - 1) as f64 * 0.15).floor() as usize];
    let peak_energy = sorted_e[((frame_count - 1) as f64 * 0.95).floor() as usize];
    let dyn_range = peak_energy - noise_floor;
    if dyn_range < 4.5 {
        return Vec::new();
    }

    let high_th = noise_floor + (dyn_range * 0.42).clamp(8.0, 18.0);
    let low_th = noise_floor + (dyn_range * 0.16).clamp(3.5, 9.0);

    let mut noise_zcr_sum = 0.0f64;
    let mut noise_zcr_cnt = 0usize;
    for f in 0..frame_count {
        if log_e[f] <= low_th {
            noise_zcr_sum += zcr[f];
            noise_zcr_cnt += 1;
        }
    }
    let base_zcr = if noise_zcr_cnt > 0 {
        noise_zcr_sum / (noise_zcr_cnt as f64)
    } else {
        0.08
    };
    let zcr_th = (base_zcr * 1.8 + 0.06).clamp(0.18, 0.45);
    let zcr_energy_floor = noise_floor + 2.0;

    let mut active = vec![false; frame_count];
    for f in 0..frame_count {
        if log_e[f] < high_th || active[f] {
            continue;
        }
        active[f] = true;
        let mut l = f as isize - 1;
        while l >= 0 && !active[l as usize] {
            let lu = l as usize;
            if log_e[lu] >= low_th || (log_e[lu] >= zcr_energy_floor && zcr[lu] >= zcr_th) {
                active[lu] = true;
                l -= 1;
            } else {
                break;
            }
        }
        let mut r = f + 1;
        while r < frame_count && !active[r] {
            if log_e[r] >= low_th || (log_e[r] >= zcr_energy_floor && zcr[r] >= zcr_th) {
                active[r] = true;
                r += 1;
            } else {
                break;
            }
        }
    }

    let mut raw: Vec<VadSegment> = Vec::new();
    let mut in_run = false;
    let mut run_start = 0usize;
    for f in 0..=frame_count {
        let on = f < frame_count && active[f];
        if on && !in_run {
            in_run = true;
            run_start = f;
        } else if !on && in_run {
            in_run = false;
            let start = ((run_start * hop_len) as f64) / fs;
            let end = ((((f - 1) * hop_len + win_len) as f64) / fs).min(duration);
            raw.push(VadSegment { start, end });
        }
    }

    finalize_vad_segments(mono, sample_rate, duration, raw, merge_gap_sec, min_speech_sec, pad_sec, params.snap_zero_crossing)
}

/// Neural-hybrid VAD (Section 4.3B) reusing `MicroSegNet` posteriors with 30s chunking + 0.5s overlap.
pub fn detect_speech_segments_nn(
    mono: &[f32],
    sample_rate: u32,
    params: &VadParams,
    model: &MicroSegNet,
) -> Vec<VadSegment> {
    if mono.is_empty() || sample_rate == 0 {
        return Vec::new();
    }
    let fs = sample_rate as f64;
    let duration = (mono.len() as f64) / fs;
    let min_speech_sec = params.min_speech_ms / 1000.0;
    let split_gap_sec = params.split_gap_ms / 1000.0;
    let merge_gap_sec = (params.merge_gap_ms / 1000.0).min(split_gap_sec);
    let pad_sec = params.pad_ms / 1000.0;

    // Run inference in 30s chunks with 0.5s overlap to avoid memory blowup on long recordings
    let total_frames = ((duration * 100.0).round() as usize).max(1);
    let mut p_vad = vec![0.0f32; total_frames];
    let mut p_obstruent = vec![0.0f32; total_frames];
    let mut p_stop_cl = vec![0.0f32; total_frames];

    let chunk_sec = 30.0f64;
    let overlap_sec = 0.5f64;
    let mut t_start = 0.0f64;
    while t_start < duration - 1e-6 {
        let t_end = (t_start + chunk_sec).min(duration);
        let pad_l = (t_start - overlap_sec).max(0.0);
        let pad_r = (t_end + overlap_sec).min(duration);
        let s_lo = (pad_l * fs).floor() as usize;
        let s_hi = ((pad_r * fs).ceil() as usize).min(mono.len());
        if s_hi <= s_lo {
            break;
        }
        let (_, post) = model.forward_pcm(&mono[s_lo..s_hi], sample_rate);
        let f_out_lo = (t_start * 100.0).floor() as usize;
        let f_out_hi = ((t_end * 100.0).ceil() as usize).min(total_frames);
        let offset_frames = ((t_start - pad_l) * 100.0).round() as usize;
        for f in f_out_lo..f_out_hi {
            let local_f = (f - f_out_lo + offset_frames).min(post.num_frames.saturating_sub(1));
            if local_f < post.num_frames {
                let m = &post.manner_probs[local_f * 8..(local_f + 1) * 8];
                let pv = post.vad_speech_10ms[local_f].max(1.0 - m[MANNER_SIL]);
                p_vad[f] = pv;
                p_obstruent[f] = m[MANNER_FRIC_VL] + m[MANNER_BURST_ASP];
                p_stop_cl[f] = m[MANNER_STOP_CL];
            }
        }
        t_start = t_end;
    }

    // Hysteresis probability expansion (calibrated to preserve soft fricatives & whisper)
    let high_prob_th = 0.44f32;
    let low_prob_th = 0.16f32;
    let obs_protect_th = 0.12f32;

    let mut active = vec![false; total_frames];
    for f in 0..total_frames {
        if p_vad[f] < high_prob_th || active[f] {
            continue;
        }
        active[f] = true;
        let mut l = f as isize - 1;
        while l >= 0 && !active[l as usize] {
            let lu = l as usize;
            if p_vad[lu] >= low_prob_th || p_obstruent[lu] >= obs_protect_th {
                active[lu] = true;
                l -= 1;
            } else {
                break;
            }
        }
        let mut r = f + 1;
        while r < total_frames && !active[r] {
            if p_vad[r] >= low_prob_th || p_obstruent[r] >= obs_protect_th {
                active[r] = true;
                r += 1;
            } else {
                break;
            }
        }
    }

    // Bridge word-internal stop closures (< 160 ms with mean P(STOP_CL) >= 0.35)
    let max_stop_gap = 16usize; // 160 ms
    let mut f = 0usize;
    while f < total_frames {
        if !active[f] {
            let g_start = f;
            while f < total_frames && !active[f] {
                f += 1;
            }
            let g_end = f;
            let gap = g_end - g_start;
            if g_start > 0 && g_end < total_frames && gap <= max_stop_gap {
                let mean_stop: f32 =
                    p_stop_cl[g_start..g_end].iter().sum::<f32>() / (gap as f32);
                if mean_stop >= 0.35 {
                    for slot in &mut active[g_start..g_end] {
                        *slot = true;
                    }
                }
            }
        } else {
            f += 1;
        }
    }

    let mut raw: Vec<VadSegment> = Vec::new();
    let mut in_run = false;
    let mut run_start = 0usize;
    for i in 0..=total_frames {
        let on = i < total_frames && active[i];
        if on && !in_run {
            in_run = true;
            run_start = i;
        } else if !on && in_run {
            in_run = false;
            let start = (run_start as f64) * 0.010;
            let end = ((i as f64) * 0.010).min(duration);
            raw.push(VadSegment { start, end });
        }
    }

    finalize_vad_segments(
        mono,
        sample_rate,
        duration,
        raw,
        merge_gap_sec,
        min_speech_sec,
        pad_sec,
        params.snap_zero_crossing,
    )
}

fn finalize_vad_segments(
    mono: &[f32],
    sample_rate: u32,
    duration: f64,
    raw: Vec<VadSegment>,
    merge_gap_sec: f64,
    min_speech_sec: f64,
    pad_sec: f64,
    snap_zc: bool,
) -> Vec<VadSegment> {
    let mut merged: Vec<VadSegment> = Vec::new();
    for seg in raw {
        if let Some(prev) = merged.last_mut() {
            if seg.start - prev.end < merge_gap_sec {
                prev.end = prev.end.max(seg.end);
                continue;
            }
        }
        merged.push(seg);
    }

    let mut padded: Vec<VadSegment> = Vec::new();
    for seg in merged {
        if seg.end - seg.start < min_speech_sec {
            continue;
        }
        let start = (seg.start - pad_sec).clamp(0.0, duration);
        let end = (seg.end + pad_sec).clamp(0.0, duration);
        if end <= start {
            continue;
        }
        if let Some(prev) = padded.last_mut() {
            if start <= prev.end {
                let mid = 0.5 * (prev.end + start);
                prev.end = mid;
                padded.push(VadSegment { start: mid, end });
                continue;
            }
        }
        padded.push(VadSegment { start, end });
    }

    if !snap_zc || padded.is_empty() {
        return padded;
    }

    let mut out = Vec::with_capacity(padded.len());
    for i in 0..padded.len() {
        let seg = padded[i];
        let lo = if i > 0 { padded[i - 1].end } else { 0.0 };
        let hi = if i + 1 < padded.len() {
            padded[i + 1].start
        } else {
            duration
        };
        let s = find_zero_crossing(mono, sample_rate, seg.start).clamp(lo, seg.end);
        let e = find_zero_crossing(mono, sample_rate, seg.end).clamp(s, hi);
        if e - s > 0.005 {
            out.push(VadSegment { start: s, end: e });
        }
    }
    out
}

// =========================================================================
// Hybrid Acoustic Split (Section 4.3A) — Neuro-Symbolic Semi-Markov Viterbi
// =========================================================================

fn equal_cuts(xmin: f64, xmax: f64, k: usize) -> Vec<f64> {
    if k <= 1 {
        return Vec::new();
    }
    let dur = xmax - xmin;
    (1..k)
        .map(|i| xmin + (i as f64 / k as f64) * dur)
        .collect()
}

fn fallback_output(xmin: f64, xmax: f64, k: usize, speech_span: (f64, f64)) -> AcousticSplitOutput {
    AcousticSplitOutput {
        cuts: equal_cuts(xmin, xmax, k),
        confidence: 0.0,
        fallback_to_equal: true,
        speech_span,
    }
}

fn percentile_f64(vals: &[f64], p: f64) -> f64 {
    if vals.is_empty() {
        return 0.0;
    }
    let mut sorted: Vec<f64> = vals.iter().copied().filter(|v| v.is_finite()).collect();
    if sorted.is_empty() {
        return 0.0;
    }
    sorted.sort_by(|a, b| a.total_cmp(b));
    let n = sorted.len();
    if n == 1 {
        return sorted[0];
    }
    let pos = p.clamp(0.0, 1.0) * ((n - 1) as f64);
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    let frac = pos - lo as f64;
    sorted[lo] * (1.0 - frac) + sorted[hi] * frac
}

#[inline]
fn sigmoid_f64(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

#[inline]
fn interp_100hz(arr: &[f32], t_rel_sec: f64) -> f64 {
    if arr.is_empty() {
        return 0.0;
    }
    // Frame t center is t * 0.010 + 0.005
    let pos = (t_rel_sec - 0.005) * 100.0;
    let max_idx = (arr.len() - 1) as f64;
    let p = pos.clamp(0.0, max_idx);
    let lo = p.floor() as usize;
    let hi = (lo + 1).min(arr.len() - 1);
    let frac = p - (lo as f64);
    (arr[lo] as f64) * (1.0 - frac) + (arr[hi] as f64) * frac
}

#[inline]
fn interp_200hz(arr: &[f32], t_rel_sec: f64) -> f64 {
    if arr.is_empty() {
        return 0.0;
    }
    // Subframe s center is s * 0.005 + 0.0025
    let pos = (t_rel_sec - 0.0025) * 200.0;
    let max_idx = (arr.len() - 1) as f64;
    let p = pos.clamp(0.0, max_idx);
    let lo = p.floor() as usize;
    let hi = (lo + 1).min(arr.len() - 1);
    let frac = p - (lo as f64);
    (arr[lo] as f64) * (1.0 - frac) + (arr[hi] as f64) * frac
}

#[inline]
fn interp_manner(manner: &[f32], num_frames: usize, t_rel_sec: f64, class_idx: usize) -> f64 {
    if num_frames == 0 {
        return 0.0;
    }
    let pos = (t_rel_sec - 0.005) * 100.0;
    let max_idx = (num_frames - 1) as f64;
    let p = pos.clamp(0.0, max_idx);
    let lo = p.floor() as usize;
    let hi = (lo + 1).min(num_frames - 1);
    let frac = p - (lo as f64);
    (manner[lo * 8 + class_idx] as f64) * (1.0 - frac)
        + (manner[hi * 8 + class_idx] as f64) * frac
}

fn class_posterior(m: &[f64; 8], cls: AcousticClass) -> f64 {
    match cls {
        AcousticClass::VoicelessObs => {
            (m[MANNER_STOP_CL] + m[MANNER_BURST_ASP] + m[MANNER_FRIC_VL]).clamp(1e-3, 1.0)
        }
        AcousticClass::VoicedObs => (m[MANNER_OBS_VD] + 0.35 * m[MANNER_STOP_CL]).clamp(1e-3, 1.0),
        AcousticClass::NasalLiquid => {
            (m[MANNER_NASAL] + m[MANNER_LIQUID_GLIDE]).clamp(1e-3, 1.0)
        }
        AcousticClass::Vowel => m[MANNER_VOWEL].clamp(1e-3, 1.0),
        AcousticClass::Syllable | AcousticClass::Other => (1.0 - m[MANNER_SIL]).clamp(1e-3, 1.0),
    }
}

fn triangular_smooth(x: &[f64], half_width: usize) -> Vec<f64> {
    let n = x.len();
    let mut out = vec![0.0f64; n];
    for i in 0..n {
        let lo = i.saturating_sub(half_width);
        let hi = (i + half_width).min(n - 1);
        let mut num = 0.0f64;
        let mut den = 0.0f64;
        for (j, &val) in x.iter().enumerate().take(hi + 1).skip(lo) {
            let dist = j.abs_diff(i);
            let w = (half_width + 1 - dist) as f64;
            num += w * val;
            den += w;
        }
        out[i] = if den > 0.0 { num / den } else { x[i] };
    }
    out
}

fn extract_hybrid_nuclei(
    nuc_curve: &[f64],
    n_vs: usize,
    n_ve: usize,
    dt: f64,
) -> Vec<usize> {
    let rad = ((0.025 / dt).round() as usize).max(2);
    let mut cands = Vec::new();
    for m in (n_vs + 1)..n_ve {
        if nuc_curve[m] < 0.32 {
            continue;
        }
        let lo = m.saturating_sub(rad).max(n_vs);
        let hi = (m + rad).min(n_ve);
        let mut is_max = true;
        let mut strict_gt = false;
        for j in lo..=hi {
            if j == m {
                continue;
            }
            if nuc_curve[j] > nuc_curve[m] {
                is_max = false;
                break;
            }
            if nuc_curve[j] < nuc_curve[m] {
                strict_gt = true;
            } else if j < m {
                is_max = false;
                break;
            }
        }
        if is_max && strict_gt {
            cands.push(m);
        }
    }

    let min_gap = ((0.065 / dt).round() as usize).max(2);
    let mut nuclei: Vec<usize> = Vec::new();
    for cand in cands {
        if let Some(&prev) = nuclei.last() {
            let too_close = cand.saturating_sub(prev) < min_gap;
            let valley = nuc_curve[prev..=cand]
                .iter()
                .copied()
                .fold(f64::INFINITY, f64::min);
            let dip = nuc_curve[prev].min(nuc_curve[cand]) - valley;
            if too_close || dip < 0.12 {
                if nuc_curve[cand] > nuc_curve[prev] {
                    *nuclei.last_mut().unwrap() = cand;
                }
                continue;
            }
        }
        nuclei.push(cand);
    }
    nuclei
}

/// Hybrid Neuro-Symbolic Acoustic Split (Section 4.3A).
/// Combines `TGrid-MicroSegNet` posteriors with physical DSP energy/STM guardrails
/// and constrained Semi-Markov Viterbi DP + O(1) prefix-sum segmental posterior bonus.
pub fn align_split_boundaries_hybrid(
    input: &AcousticSplitInput<'_>,
    model: &MicroSegNet,
) -> AcousticSplitOutput {
    let k = input.duration_weights.len();
    let xmin = input.xmin;
    let xmax = input.xmax;
    let dur = xmax - xmin;
    let default_span = if xmin.is_finite() && xmax.is_finite() && xmax > xmin {
        (xmin, xmax)
    } else {
        (xmin, xmin)
    };

    if k <= 1
        || !xmin.is_finite()
        || !xmax.is_finite()
        || !input.samples_origin_sec.is_finite()
        || dur <= 0.0
        || input.sample_rate < 4000
        || input.samples.is_empty()
        || input.granularity == SplitGranularity::ToneSplit
    {
        return fallback_output(xmin, xmax, k, default_span);
    }
    let min_dur = (0.040_f64).max(0.015 * (k as f64));
    if dur + 1e-9 < min_dur || dur > 25.0 {
        return fallback_output(xmin, xmax, k, default_span);
    }

    // Weight normalization & class alignment
    let mut w_clean = Vec::with_capacity(k);
    let mut w_sum = 0.0f64;
    for &w in input.duration_weights {
        let wc = if w.is_finite() && w > 0.0 {
            w.clamp(0.15, 6.0)
        } else {
            1.0
        };
        w_clean.push(wc);
        w_sum += wc;
    }
    let probs: Vec<f64> = w_clean.iter().map(|&w| w / w_sum).collect();
    let mut classes = Vec::with_capacity(k);
    for idx in 0..k {
        classes.push(
            input
                .acoustic_classes
                .get(idx)
                .copied()
                .unwrap_or(AcousticClass::Other),
        );
    }

    // Extract padded slice [xmin - 0.50, xmax + 0.50] for TCN receptive-field & stable e_ref context.
    let fs = input.sample_rate as f64;
    let pad_sec = 0.50f64;
    let slice_start_idx = (((xmin - pad_sec - input.samples_origin_sec) * fs).floor() as isize)
        .clamp(0, input.samples.len() as isize) as usize;
    let slice_end_idx = (((xmax + pad_sec - input.samples_origin_sec) * fs).ceil() as isize)
        .clamp(0, input.samples.len() as isize) as usize;
    if slice_end_idx <= slice_start_idx + 16 {
        return fallback_output(xmin, xmax, k, default_span);
    }
    let slice_origin_sec = input.samples_origin_sec + (slice_start_idx as f64) / fs;
    let (nn_feats, post): (_, MicroSegPosteriors) =
        model.forward_pcm(&input.samples[slice_start_idx..slice_end_idx], input.sample_rate);
    if post.num_frames == 0 {
        return fallback_output(xmin, xmax, k, default_span);
    }

    // Frame grid on [xmin, xmax]
    let dt_nom = if dur <= 8.0 { 0.005 } else { 0.010 };
    let m_frames = (k + 2).max((dur / dt_nom).round() as usize + 1);
    let dt = dur / ((m_frames - 1) as f64);
    let frame_times: Vec<f64> = (0..m_frames).map(|m| xmin + (m as f64) * dt).collect();

    // Sample NN posteriors and total energy onto the DP frame grid
    let mut e_act = vec![-100.0f64; m_frames];
    let mut p_speech = vec![0.0f64; m_frames];
    let mut p_syl_bnd = vec![0.0f64; m_frames];
    let mut p_phone_bnd = vec![0.0f64; m_frames];
    let mut p_manner = vec![[0.0f64; 8]; m_frames];
    let mut feat_mel_flux = vec![0.0f64; m_frames];

    for (m, &t) in frame_times.iter().enumerate() {
        let t_rel = t - slice_origin_sec;
        // Energy from NN's canonical 16kHz feature extraction
        let pos100 = ((t_rel - 0.005) * 100.0).clamp(0.0, (nn_feats.num_frames - 1) as f64);
        let lo = pos100.floor() as usize;
        let hi = (lo + 1).min(nn_feats.num_frames - 1);
        let frac = pos100 - (lo as f64);
        e_act[m] = nn_feats.e_tot_db[lo] * (1.0 - frac) + nn_feats.e_tot_db[hi] * frac;
        let flux_lo = nn_feats.data[lo * 32 + 28] as f64;
        let flux_hi = nn_feats.data[hi * 32 + 28] as f64;
        feat_mel_flux[m] = flux_lo * (1.0 - frac) + flux_hi * frac;

        p_speech[m] = interp_100hz(&post.vad_speech_10ms, t_rel);
        p_syl_bnd[m] = interp_100hz(&post.syl_bnd_10ms, t_rel);
        p_phone_bnd[m] = interp_200hz(&post.phone_bnd_5ms, t_rel);
        for c in 0..8 {
            p_manner[m][c] = interp_manner(&post.manner_probs, post.num_frames, t_rel, c);
        }
    }

    // Physical DSP SNR / energy contrast guardrail (preserves 0 dB / white-noise fallback!)
    let e_peak = percentile_f64(&e_act, 0.95);
    let e_floor = percentile_f64(&e_act, 0.05);
    let d_act = e_peak - e_floor;
    let flux_p98 = percentile_f64(&feat_mel_flux, 0.98);
    let flux_p50 = percentile_f64(&feat_mel_flux, 0.50);
    // Estimate DSP STM-like contrast using 24-band Mel delta
    let snr_eff = d_act.max(20.0 * (flux_p98 - flux_p50));
    let max_p_speech = p_speech.iter().copied().fold(0.0f64, f64::max);

    if e_peak < -55.0 || (snr_eff < 8.0 && max_p_speech < 0.70) {
        return fallback_output(xmin, xmax, k, (xmin, xmax));
    }

    // Also run lightweight stationary noise check: if energy dynamic range < 5 dB AND
    // mean voicing < 0.15 AND mean flux < 0.15 -> fallback on pure stationary white noise
    let mean_voicing = {
        let mut s = 0.0f64;
        for f in 0..nn_feats.num_frames {
            s += nn_feats.data[f * 32 + 31] as f64;
        }
        s / (nn_feats.num_frames as f64)
    };
    if d_act < 5.0 && mean_voicing < 0.12 && (flux_p98 - flux_p50) < 0.20 {
        return fallback_output(xmin, xmax, k, (xmin, xmax));
    }

    // Branch routing (identical to acoustic_split.rs)
    let is_branch_b = match input.granularity {
        SplitGranularity::OnsetRime | SplitGranularity::Phone => true,
        SplitGranularity::Syllable | SplitGranularity::Word => false,
        SplitGranularity::Delimiter => {
            let has_subsyllable = classes.iter().any(|c| {
                matches!(
                    c,
                    AcousticClass::VoicelessObs
                        | AcousticClass::VoicedObs
                        | AcousticClass::NasalLiquid
                        | AcousticClass::Vowel
                )
            });
            has_subsyllable && (dur / (k as f64)) < 0.18
        }
        SplitGranularity::ToneSplit => unreachable!(),
    };

    // Step 1: Hybrid speech span & mid-utterance pause detection
    // For short Branch-B (Phone/OnsetRime) word intervals, preserve full [xmin, xmax] span
    // unless clear >60ms true silence sits at edges (avoids trimming weak initial fricatives).
    let theta_sil = if d_act >= 12.0 {
        (e_floor + 5.0).max(e_peak - 28.0)
    } else {
        e_peak - 28.0
    };
    let mut act_score = vec![0.0f64; m_frames];
    for m in 0..m_frames {
        let dsp_prob = sigmoid_f64((e_act[m] - theta_sil) / 3.0);
        let nn_act = p_speech[m].max(1.0 - p_manner[m][MANNER_SIL]);
        act_score[m] = 0.65 * nn_act + 0.35 * dsp_prob;
    }

    let (n_vs, n_ve) = if (is_branch_b && dur < 1.2) || (d_act < 10.0 && act_score.iter().all(|&a| a > 0.30)) {
        (0, m_frames - 1)
    } else {
        let active: Vec<bool> = act_score
            .iter()
            .enumerate()
            .map(|(m, &a)| a >= 0.36 || e_act[m] > theta_sil + 2.0)
            .collect();
        let first_a = active.iter().position(|&a| a);
        let last_a = active.iter().rposition(|&a| a);
        match (first_a, last_a) {
            (Some(mf), Some(ml)) => {
                let lead_pad = (0.010 / dt).round() as usize;
                let trail_pad = (0.015 / dt).round() as usize;
                let vs = if (mf as f64) * dt > 0.060 {
                    mf.saturating_sub(lead_pad)
                } else {
                    0
                };
                let ve = if ((m_frames - 1 - ml) as f64) * dt > 0.060 {
                    (ml + trail_pad).min(m_frames - 1)
                } else {
                    m_frames - 1
                };
                let min_eff = (k + 2).max((0.060 / dt).round() as usize);
                if ve <= vs || (ve - vs) < min_eff {
                    (0, m_frames - 1)
                } else {
                    (vs, ve)
                }
            }
            _ => (0, m_frames - 1),
        }
    };
    let speech_span = (frame_times[n_vs], frame_times[n_ve]);
    let n_eff = n_ve - n_vs;

    // Mid-utterance pause vs stop closure discrimination
    let mut psi = vec![1.0f64; m_frames];
    let mut c_pause_end = vec![0.0f64; m_frames];
    {
        let mut m = n_vs + 1;
        while m < n_ve {
            if act_score[m] < 0.36 || e_act[m] <= theta_sil {
                let p_s = m;
                while m < n_ve && (act_score[m] < 0.36 || e_act[m] <= theta_sil) {
                    m += 1;
                }
                let p_e = m;
                let pause_dur = ((p_e - p_s) as f64) * dt;
                let mean_stop_cl: f64 = p_manner[p_s..p_e]
                    .iter()
                    .map(|v| v[MANNER_STOP_CL])
                    .sum::<f64>()
                    / ((p_e - p_s).max(1) as f64);
                let mean_sil: f64 = p_manner[p_s..p_e]
                    .iter()
                    .map(|v| v[MANNER_SIL])
                    .sum::<f64>()
                    / ((p_e - p_s).max(1) as f64);

                let is_stop_closure = pause_dur < 0.180 && mean_stop_cl > 0.40;
                if !is_stop_closure && pause_dur >= 0.140 && (mean_sil > 0.45 || e_act[p_s] <= theta_sil) {
                    let m_resume = p_e.saturating_sub(1).max(p_s + 1);
                    c_pause_end[m_resume] = 1.0;
                    if m_resume > 0 {
                        c_pause_end[m_resume - 1] = c_pause_end[m_resume - 1].max(0.5);
                    }
                    if m_resume + 1 < m_frames {
                        c_pause_end[m_resume + 1] = c_pause_end[m_resume + 1].max(0.5);
                    }
                    for slot in &mut psi[p_s..m_resume] {
                        *slot = 0.08;
                    }
                }
            } else {
                m += 1;
            }
        }
    }

    let mut c_pref = vec![0.0f64; m_frames];
    for m in (n_vs + 1)..=n_ve {
        c_pref[m] = c_pref[m - 1] + psi[m - 1];
    }
    let c_tot = c_pref[n_ve].max(1e-6);

    // Precompute 24-band STM on DP grid for Branch A (Syllable/Word) DSP term
    let mut mel_grid = vec![[0.0f64; 24]; m_frames];
    for (m, &t) in frame_times.iter().enumerate() {
        let t_rel = t - slice_origin_sec;
        let pos100 = ((t_rel - 0.005) * 100.0).clamp(0.0, (nn_feats.num_frames - 1) as f64);
        let lo = pos100.floor() as usize;
        let hi = (lo + 1).min(nn_feats.num_frames - 1);
        let frac = pos100 - (lo as f64);
        for b in 0..24 {
            let v0 = nn_feats.data[lo * 32 + b] as f64;
            let v1 = nn_feats.data[hi * 32 + b] as f64;
            mel_grid[m][b] = v0 * (1.0 - frac) + v1 * frac;
        }
    }
    // Spectral Transition Measure (STM) on normalized 24-band Mel
    let half_i = ((0.015 / dt).round() as isize).max(2);
    let d_norm: f64 = (1..=half_i).map(|i| 2.0 * ((i * i) as f64)).sum();
    let mut stm = vec![0.0f64; m_frames];
    for m in 0..m_frames {
        let mut sq_sum = 0.0f64;
        for b in 0..24 {
            let mut num = 0.0f64;
            for i in -half_i..=half_i {
                let idx = (m as isize + i).clamp(0, (m_frames - 1) as isize) as usize;
                num += (i as f64) * mel_grid[idx][b];
            }
            let slope = num / d_norm;
            sq_sum += slope * slope;
        }
        stm[m] = (sq_sum / 24.0).sqrt();
    }
    let stm_p20 = percentile_f64(&stm[n_vs..=n_ve], 0.20);
    let stm_p95 = percentile_f64(&stm[n_vs..=n_ve], 0.95);
    let stm_denom = (stm_p95 - stm_p20).max(0.03);
    let stm_hat: Vec<f64> = stm
        .iter()
        .map(|&v| ((v - stm_p20) / stm_denom).clamp(0.0, 1.0))
        .collect();

    let smooth_hw = ((0.015 / dt).round() as usize).max(1);
    let e_smooth = triangular_smooth(&e_act, smooth_hw);
    let ws = ((0.110 / dt).round() as usize).max(1);
    let mut b_dsp = vec![0.0f64; m_frames];
    for m in 0..m_frames {
        let lo = m.saturating_sub(ws);
        let hi = (m + ws).min(m_frames - 1);
        let s_l = e_smooth[lo..=m].iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let s_r = e_smooth[m..=hi].iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let d_dip = ((s_l.min(s_r) - e_smooth[m]) / 14.0).clamp(0.0, 1.0);
        b_dsp[m] = (0.45 * d_dip + 0.55 * stm_hat[m]).clamp(0.0, 1.0);
    }

    // Build boundary scores B_k(m) + optional prefix-sum log posteriors S_c[m]
    let mut b_scores: Vec<Vec<f64>> = Vec::with_capacity(k - 1);
    let mut nuclei_corridors: Option<Vec<(usize, usize)>> = None;
    let mut log_post_pref: Option<Vec<Vec<f64>>> = None;

    if !is_branch_b {
        // Branch A: Syllable / Word
        if input.granularity == SplitGranularity::Syllable {
            let raw_nuc: Vec<f64> = p_manner
                .iter()
                .map(|m| (m[MANNER_VOWEL] + 0.5 * m[MANNER_NASAL]).clamp(0.0, 1.0))
                .collect();
            let nuc_smooth = triangular_smooth(&raw_nuc, smooth_hw);
            let nuclei = extract_hybrid_nuclei(&nuc_smooth, n_vs, n_ve, dt);
            if nuclei.len() == k {
                let mut corrs = Vec::with_capacity(k - 1);
                for idx in 0..(k - 1) {
                    let lo = (nuclei[idx] + 2).min(n_ve - 1);
                    let hi = nuclei[idx + 1].saturating_sub(2).max(n_vs + 1);
                    corrs.push((lo, hi));
                }
                nuclei_corridors = Some(corrs);
            }
        }

        let mut b_syl = vec![0.0f64; m_frames];
        for m in 0..m_frames {
            let nn_bnd = p_syl_bnd[m].max(0.35 * p_phone_bnd[m]);
            let fused = 0.74 * nn_bnd + 0.26 * b_dsp[m].max(c_pause_end[m]);
            b_syl[m] = fused.max(0.85 * c_pause_end[m]).clamp(0.0, 1.0);
        }
        for _ in 0..(k - 1) {
            b_scores.push(b_syl.clone());
        }
    } else {
        // Branch B: Onset-Rime / Phone level — true 5ms Neuro-Symbolic fusion:
        // Fuse native 5ms (15ms short-window) DSP transitions from `acoustic_split.rs`
        // directly with native 5ms neural phone boundary peaks (`p_phone_bnd`) & manner posteriors.
        let b_dsp_native = crate::acoustic_split::compute_native_5ms_branch_b_dsp(
            input,
            &frame_times,
            dt,
            n_vs,
            n_ve,
            &classes,
        );
        let delta_d = ((0.010 / dt).round() as usize).max(1);
        for cut_idx in 0..(k - 1) {
            let c_l = classes[cut_idx];
            let c_r = classes[cut_idx + 1];
            let mut b_curve = vec![0.0f64; m_frames];
            for m in 0..m_frames {
                let m_prev = m.saturating_sub(delta_d);
                let m_next = (m + delta_d).min(m_frames - 1);
                let pl_before = class_posterior(&p_manner[m_prev], c_l);
                let pr_after = class_posterior(&p_manner[m_next], c_r);
                let pl_after = class_posterior(&p_manner[m_next], c_l);
                let pr_before = class_posterior(&p_manner[m_prev], c_r);
                let trans_gain = ((pl_before - pl_after) * 0.5 + (pr_after - pr_before) * 0.5)
                    .clamp(0.0, 1.0);

                let b_dsp_cls = b_dsp_native[cut_idx][m];

                let vot_bonus = if c_l == AcousticClass::VoicelessObs && c_r == AcousticClass::Vowel {
                    let m_l1 = m.saturating_sub(1);
                    let m_r1 = (m + 1).min(m_frames - 1);
                    0.16 * (p_manner[m_l1][MANNER_BURST_ASP] + p_manner[m_l1][MANNER_FRIC_VL])
                        * p_manner[m_r1][MANNER_VOWEL]
                } else {
                    0.0
                };

                b_curve[m] = (0.44 * p_phone_bnd[m]
                    + 0.14 * trans_gain
                    + 0.42 * b_dsp_cls
                    + vot_bonus)
                    .clamp(0.0, 1.0);
            }
            b_scores.push(b_curve);
        }

        // Prefix-sum log-posterior table for each segment k (O(M) precomputation, O(1) query in DP)
        let mut prefs = Vec::with_capacity(k);
        for seg_idx in 0..k {
            let cls = classes[seg_idx];
            let mut pref = vec![0.0f64; m_frames + 1];
            for m in 0..m_frames {
                let p = class_posterior(&p_manner[m], cls);
                pref[m + 1] = pref[m] + p.ln();
            }
            prefs.push(pref);
        }
        log_post_pref = Some(prefs);
    }

    // Global Constrained Semi-Markov Viterbi DP
    let mu_frames: Vec<f64> = probs.iter().map(|&p| p * (n_eff as f64)).collect();
    let mu_active: Vec<f64> = probs.iter().map(|&p| p * c_tot).collect();

    let mut n_bar = vec![0usize; k - 1];
    let mut cum_p = 0.0f64;
    for idx in 0..(k - 1) {
        cum_p += probs[idx];
        let target_c = c_tot * cum_p;
        let mut best_m = n_vs + 1;
        let mut best_diff = f64::INFINITY;
        for m in (n_vs + 1)..n_ve {
            let d = (c_pref[m] - target_c).abs();
            if d < best_diff {
                best_diff = d;
                best_m = m;
            }
        }
        n_bar[idx] = best_m;
    }

    let (tau_floor, r_min) = if is_branch_b {
        (0.020, 0.25)
    } else {
        (0.055, 0.30)
    };
    let d0: Vec<usize> = mu_frames
        .iter()
        .map(|&mu| ((tau_floor / dt).max(r_min * mu).round() as usize).max(1))
        .collect();
    let sum_d0: usize = d0.iter().sum();
    let cap = (0.65 * (n_eff as f64)).floor() as usize;
    let mut d_min: Vec<usize> = if sum_d0 > cap && sum_d0 > 0 {
        d0.iter()
            .map(|&d| (((d as f64) * (cap as f64) / (sum_d0 as f64)).floor() as usize).max(1))
            .collect()
    } else {
        d0
    };
    if d_min.iter().sum::<usize>() >= n_eff {
        d_min.fill(1);
    }

    let mut d_lo = vec![0usize; k - 1];
    let mut d_hi = vec![0usize; k - 1];
    let mut prefix_d = 0usize;
    let total_d: usize = d_min.iter().sum();
    for idx in 0..(k - 1) {
        prefix_d += d_min[idx];
        let suffix_d = total_d - prefix_d;
        d_lo[idx] = n_vs + prefix_d;
        d_hi[idx] = n_ve - suffix_d;
    }

    let mu_bar = (n_eff as f64) / (k as f64);
    let w_half = ((0.080 / dt).round() as usize)
        .max((1.4 * mu_bar).min(0.40 * (n_eff as f64)).round() as usize);

    let mut win_l = vec![0usize; k - 1];
    let mut win_r = vec![0usize; k - 1];
    for idx in 0..(k - 1) {
        let l = d_lo[idx].max(n_bar[idx].saturating_sub(w_half));
        let r = d_hi[idx].min(n_bar[idx].saturating_add(w_half));
        if l <= r {
            win_l[idx] = l;
            win_r[idx] = r;
        } else {
            win_l[idx] = d_lo[idx];
            win_r[idx] = d_hi[idx];
        }
        if let Some(ref corrs) = nuclei_corridors {
            let (cl, cr) = corrs[idx];
            let il = win_l[idx].max(cl);
            let ir = win_r[idx].min(cr);
            if il <= ir {
                win_l[idx] = il;
                win_r[idx] = ir;
            }
        }
    }

    let mut feasible = true;
    for idx in 1..(k - 1) {
        win_l[idx] = win_l[idx].max(win_l[idx - 1] + d_min[idx]);
        if win_l[idx] > win_r[idx] {
            feasible = false;
            break;
        }
    }
    if feasible {
        for idx in (0..(k - 2)).rev() {
            win_r[idx] = win_r[idx].min(win_r[idx + 1].saturating_sub(d_min[idx + 1]));
            if win_l[idx] > win_r[idx] {
                feasible = false;
                break;
            }
        }
    }
    if !feasible {
        win_l.copy_from_slice(&d_lo);
        win_r.copy_from_slice(&d_hi);
    }

    let lambda = if is_branch_b { 0.22 } else { 0.28 };
    let mu_reg_sq = 16.0f64;
    let beta_seg = 0.12f64;

    let dur_penalty = |seg_idx: usize, j: usize, m: usize| -> f64 {
        let delta_c = c_pref[m] - c_pref[j];
        let diff_c = delta_c - mu_active[seg_idx];
        lambda * (diff_c * diff_c) / (mu_active[seg_idx] * mu_active[seg_idx] + mu_reg_sq)
    };

    let seg_bonus = |seg_idx: usize, j: usize, m: usize| -> f64 {
        if let Some(ref prefs) = log_post_pref {
            if m > j {
                let len = (m - j) as f64;
                let s = prefs[seg_idx][m] - prefs[seg_idx][j];
                // Length-neutral mean log-posterior bonus
                return beta_seg * (s / len);
            }
        }
        0.0
    };

    let num_cuts = k - 1;
    let mut dp = vec![vec![f64::NEG_INFINITY; m_frames]; num_cuts];
    let mut ptr = vec![vec![0usize; m_frames]; num_cuts];

    for m in win_l[0]..=win_r[0] {
        dp[0][m] = b_scores[0][m] + seg_bonus(0, n_vs, m) - dur_penalty(0, n_vs, m);
    }

    for cut_idx in 1..num_cuts {
        let seg_idx = cut_idx;
        let min_step = d_min[seg_idx];
        for m in win_l[cut_idx]..=win_r[cut_idx] {
            let j_lo = win_l[cut_idx - 1];
            let j_hi = win_r[cut_idx - 1].min(m.saturating_sub(min_step));
            let mut best_val = f64::NEG_INFINITY;
            let mut best_j = j_lo;
            for j in j_lo..=j_hi {
                let prev = dp[cut_idx - 1][j];
                if !prev.is_finite() {
                    continue;
                }
                let val = prev + seg_bonus(seg_idx, j, m) - dur_penalty(seg_idx, j, m);
                if val > best_val {
                    best_val = val;
                    best_j = j;
                }
            }
            if best_val.is_finite() {
                dp[cut_idx][m] = b_scores[cut_idx][m] + best_val;
                ptr[cut_idx][m] = best_j;
            }
        }
    }

    let last_cut = num_cuts - 1;
    let last_hi = win_r[last_cut].min(n_ve.saturating_sub(d_min[k - 1]));
    let mut best_end_val = f64::NEG_INFINITY;
    let mut best_last_m = win_l[last_cut];
    for j in win_l[last_cut]..=last_hi {
        let prev = dp[last_cut][j];
        if !prev.is_finite() {
            continue;
        }
        let val = prev + seg_bonus(k - 1, j, n_ve) - dur_penalty(k - 1, j, n_ve);
        if val > best_end_val {
            best_end_val = val;
            best_last_m = j;
        }
    }

    if !best_end_val.is_finite() {
        return fallback_output(xmin, xmax, k, speech_span);
    }

    let mut best_frames = vec![0usize; num_cuts];
    best_frames[last_cut] = best_last_m;
    for cut_idx in (1..num_cuts).rev() {
        best_frames[cut_idx - 1] = ptr[cut_idx][best_frames[cut_idx]];
    }

    // Parabolic sub-frame refinement
    let mut t_dp = Vec::with_capacity(num_cuts);
    for cut_idx in 0..num_cuts {
        let n_star = best_frames[cut_idx];
        let b = &b_scores[cut_idx];
        let delta = if n_star >= 1 && n_star + 1 < m_frames {
            let b_prev = b[n_star - 1];
            let b_cur = b[n_star];
            let b_next = b[n_star + 1];
            if b_cur > b_prev.max(b_next) {
                let denom = b_prev - 2.0 * b_cur + b_next;
                if denom.abs() > 1e-12 {
                    (0.5 * (b_prev - b_next) / denom).clamp(-0.35, 0.35)
                } else {
                    0.0
                }
            } else {
                0.0
            }
        } else {
            0.0
        };
        t_dp.push(xmin + ((n_star as f64) + delta) * dt);
    }

    // Confidence & piecewise saturated damping fusion
    let w_loc = ((0.060 / dt).round() as usize).max(6);
    let mut prom_sum = 0.0f64;
    for cut_idx in 0..num_cuts {
        let n_star = best_frames[cut_idx];
        let b = &b_scores[cut_idx];
        let lo = n_star.saturating_sub(w_loc);
        let hi = (n_star + w_loc).min(m_frames - 1);
        let med_loc = percentile_f64(&b[lo..=hi], 0.50);
        let prom = (b[n_star] - med_loc).max(0.0);
        prom_sum += (prom / 0.30).clamp(0.0, 1.0);
    }
    let q_prom = prom_sum / (num_cuts as f64);
    let q_snr = ((snr_eff - 8.0) / 12.0).clamp(0.0, 1.0).max(0.5 * max_p_speech);
    let confidence = (0.35 * q_snr + 0.65 * q_prom).clamp(0.0, 1.0);

    if confidence < 0.18 {
        return fallback_output(xmin, xmax, k, speech_span);
    }

    let gamma = ((confidence - 0.18) / 0.37).clamp(0.0, 1.0);
    let t_eq = equal_cuts(xmin, xmax, k);
    let cuts: Vec<f64> = t_dp
        .iter()
        .zip(t_eq.iter())
        .map(|(&dp_t, &eq_t)| gamma * dp_t + (1.0 - gamma) * eq_t)
        .collect();

    let _ = TAU;
    AcousticSplitOutput {
        cuts,
        confidence,
        fallback_to_equal: false,
        speech_span,
    }
}

// =========================================================================
// Smart Acoustic Boundary Snap (TGrid-AcouSeg 1.0)
// =========================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AcousticSnapKind {
    Phone,
    Syllable,
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcousticSnapPeak {
    pub time_sec: f64,
    pub strength: f32,
    pub kind: AcousticSnapKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcousticSnapResult {
    pub found: bool,
    pub snapped_time_sec: f64,
    pub confidence: f32,
    pub kind: AcousticSnapKind,
}

/// Extract time-ordered, NMS-deduplicated acoustic boundary candidate peaks on `[xmin, xmax]`
/// using the provided `MicroSegNet` model.
pub fn extract_acoustic_snap_peaks_with_model(
    samples: &[f32],
    sample_rate: u32,
    samples_origin_sec: f64,
    xmin: f64,
    xmax: f64,
    model: &MicroSegNet,
) -> Vec<AcousticSnapPeak> {
    if samples.is_empty()
        || sample_rate < 4000
        || !samples_origin_sec.is_finite()
        || !xmin.is_finite()
        || !xmax.is_finite()
        || xmax <= xmin
    {
        return Vec::new();
    }

    let fs = sample_rate as f64;
    let pad_sec = 0.50f64;
    let s_lo = (((xmin - pad_sec - samples_origin_sec) * fs).floor() as isize)
        .clamp(0, samples.len() as isize) as usize;
    let s_hi = (((xmax + pad_sec - samples_origin_sec) * fs).ceil() as isize)
        .clamp(0, samples.len() as isize) as usize;
    if s_hi <= s_lo + 16 {
        return Vec::new();
    }

    let slice_origin_sec = samples_origin_sec + (s_lo as f64) / fs;
    let (nn_feats, post) = model.forward_pcm(&samples[s_lo..s_hi], sample_rate);
    if post.num_frames < 2 || nn_feats.num_frames == 0 {
        return Vec::new();
    }

    // Window-scoped energy, flux, voicing & speech statistics for silence/noise guardrails
    let mut win_e = Vec::new();
    let mut win_flux = Vec::new();
    let mut voicing_sum = 0.0f64;
    let mut voicing_cnt = 0usize;
    let mut max_p_speech = 0.0f64;

    for f in 0..nn_feats.num_frames.min(post.num_frames) {
        let t_f = slice_origin_sec + (f as f64) * 0.010 + 0.005;
        if t_f >= xmin - 0.15 && t_f <= xmax + 0.15 {
            win_e.push(nn_feats.e_tot_db[f]);
            win_flux.push(nn_feats.data[f * 32 + 28] as f64);
            voicing_sum += nn_feats.data[f * 32 + 31] as f64;
            voicing_cnt += 1;
            let p_sp = (post.vad_speech_10ms[f] as f64)
                .max(1.0 - (post.manner_probs[f * 8 + MANNER_SIL] as f64));
            if p_sp > max_p_speech {
                max_p_speech = p_sp;
            }
        }
    }
    if win_e.is_empty() {
        win_e.extend_from_slice(&nn_feats.e_tot_db);
        for f in 0..nn_feats.num_frames.min(post.num_frames) {
            win_flux.push(nn_feats.data[f * 32 + 28] as f64);
            voicing_sum += nn_feats.data[f * 32 + 31] as f64;
            voicing_cnt += 1;
            let p_sp = (post.vad_speech_10ms[f] as f64)
                .max(1.0 - (post.manner_probs[f * 8 + MANNER_SIL] as f64));
            if p_sp > max_p_speech {
                max_p_speech = p_sp;
            }
        }
    }

    let e_peak = percentile_f64(&win_e, 0.95);
    let e_floor = percentile_f64(&win_e, 0.05);
    let d_act = e_peak - e_floor;
    let flux_p98 = percentile_f64(&win_flux, 0.98);
    let flux_p50 = percentile_f64(&win_flux, 0.50);
    let mean_voicing = if voicing_cnt > 0 {
        voicing_sum / (voicing_cnt as f64)
    } else {
        0.0
    };

    // Guardrail 1: pure silence / near-zero signal
    if e_peak < -52.0 || max_p_speech < 0.22 {
        return Vec::new();
    }
    // Guardrail 2: stationary white noise with no speech contrast
    if d_act < 5.0 && mean_voicing < 0.12 && (flux_p98 - flux_p50) < 0.20 && max_p_speech < 0.65 {
        return Vec::new();
    }

    // Build 200 Hz combined boundary probability curve from 5 ms phone_bnd + 10 ms syl_bnd
    let n_sub = post.phone_bnd_5ms.len();
    if n_sub < 3 {
        return Vec::new();
    }
    let mut combined = vec![0.0f32; n_sub];
    for (s, slot) in combined.iter_mut().enumerate() {
        let t_rel = (s as f64) * 0.005 + 0.0025;
        let p_phone = post.phone_bnd_5ms[s];
        let p_syl = interp_100hz(&post.syl_bnd_10ms, t_rel) as f32;
        *slot = p_phone.max(p_syl * 1.05).min(1.0);
    }

    const PEAK_MIN_STRENGTH: f32 = 0.22;
    let mut raw_peaks: Vec<AcousticSnapPeak> = Vec::new();

    for s in 1..(n_sub - 1) {
        let y_cur = combined[s];
        if y_cur < PEAK_MIN_STRENGTH {
            continue;
        }
        let y_prev = combined[s - 1];
        let y_next = combined[s + 1];
        if y_cur < y_prev || y_cur < y_next || (y_cur == y_prev && y_cur == y_next) {
            continue;
        }

        // Local ±30 ms speech & energy activity check (preserves speech onsets/offsets, rejects pure silence)
        let f_center = (s / 2).min(post.num_frames - 1);
        let f_lo = f_center.saturating_sub(3);
        let f_hi = (f_center + 3).min(post.num_frames - 1);
        let mut local_max_e = -120.0f64;
        let mut local_max_speech = 0.0f32;
        for f in f_lo..=f_hi {
            if f < nn_feats.num_frames && nn_feats.e_tot_db[f] > local_max_e {
                local_max_e = nn_feats.e_tot_db[f];
            }
            let sp = post.vad_speech_10ms[f].max(1.0 - post.manner_probs[f * 8 + MANNER_SIL]);
            if sp > local_max_speech {
                local_max_speech = sp;
            }
        }
        if local_max_e < -50.0
            || local_max_speech < 0.25
            || (local_max_e < e_peak - 36.0 && local_max_speech < 0.42)
        {
            continue;
        }

        // 3-point parabolic sub-frame refinement
        let yp = y_prev as f64;
        let yc = y_cur as f64;
        let yn = y_next as f64;
        let denom = yp - 2.0 * yc + yn;
        let delta = if denom < -1e-7 {
            (0.5 * (yp - yn) / denom).clamp(-0.5, 0.5)
        } else {
            0.0
        };
        let t_rel_ref = ((s as f64) + delta) * 0.005 + 0.0025;
        let t_abs = slice_origin_sec + t_rel_ref;
        if t_abs < xmin || t_abs > xmax {
            continue;
        }

        let p_syl_at = interp_100hz(&post.syl_bnd_10ms, t_rel_ref) as f32;
        let p_phone_at = interp_200hz(&post.phone_bnd_5ms, t_rel_ref) as f32;
        let kind = if p_syl_at >= 0.26 && p_syl_at >= 0.65 * p_phone_at {
            AcousticSnapKind::Syllable
        } else {
            AcousticSnapKind::Phone
        };
        let strength = p_phone_at.max(p_syl_at).max(y_cur).clamp(0.0, 1.0);

        raw_peaks.push(AcousticSnapPeak {
            time_sec: t_abs,
            strength,
            kind,
        });
    }

    if raw_peaks.is_empty() {
        return Vec::new();
    }

    // Greedy NMS deduplication: keep strongest peaks separated by >= 15 ms
    raw_peaks.sort_by(|a, b| {
        b.strength
            .total_cmp(&a.strength)
            .then_with(|| {
                let ka = matches!(a.kind, AcousticSnapKind::Syllable);
                let kb = matches!(b.kind, AcousticSnapKind::Syllable);
                kb.cmp(&ka)
            })
            .then_with(|| a.time_sec.total_cmp(&b.time_sec))
    });

    const MIN_PEAK_GAP_SEC: f64 = 0.015;
    let mut kept: Vec<AcousticSnapPeak> = Vec::with_capacity(raw_peaks.len());
    for cand in raw_peaks {
        if kept
            .iter()
            .all(|k| (k.time_sec - cand.time_sec).abs() >= MIN_PEAK_GAP_SEC)
        {
            kept.push(cand);
        }
    }

    kept.sort_by(|a, b| a.time_sec.total_cmp(&b.time_sec));
    kept
}

/// Extract acoustic boundary candidate peaks on `[xmin, xmax]` using the built-in `TGrid-AcouSeg 1.0` model.
pub fn extract_acoustic_snap_peaks(
    samples: &[f32],
    sample_rate: u32,
    samples_origin_sec: f64,
    xmin: f64,
    xmax: f64,
) -> Vec<AcousticSnapPeak> {
    extract_acoustic_snap_peaks_with_model(
        samples,
        sample_rate,
        samples_origin_sec,
        xmin,
        xmax,
        crate::nn::builtin_acouseg_net(),
    )
}

/// Snap a single boundary/point timestamp to the highest-scoring acoustic edge within `target_time_sec ± window_sec`.
pub fn snap_boundary_to_acoustic_edge_with_model(
    samples: &[f32],
    sample_rate: u32,
    samples_origin_sec: f64,
    target_time_sec: f64,
    window_sec: f64,
    model: &MicroSegNet,
) -> AcousticSnapResult {
    if !target_time_sec.is_finite() {
        return AcousticSnapResult {
            found: false,
            snapped_time_sec: 0.0,
            confidence: 0.0,
            kind: AcousticSnapKind::None,
        };
    }

    let win = if window_sec.is_finite() && window_sec > 0.0 {
        window_sec.clamp(0.005, 0.50)
    } else {
        0.045
    };
    let peaks = extract_acoustic_snap_peaks_with_model(
        samples,
        sample_rate,
        samples_origin_sec,
        target_time_sec - win,
        target_time_sec + win,
        model,
    );
    if peaks.is_empty() {
        return AcousticSnapResult {
            found: false,
            snapped_time_sec: target_time_sec,
            confidence: 0.0,
            kind: AcousticSnapKind::None,
        };
    }

    let sigma = (win * 0.65).max(0.012);
    let mut best_peak: Option<AcousticSnapPeak> = None;
    let mut best_score = f64::NEG_INFINITY;
    for peak in peaks {
        let dt = peak.time_sec - target_time_sec;
        let gauss = (-0.5 * (dt / sigma).powi(2)).exp();
        let kind_boost = if peak.kind == AcousticSnapKind::Syllable {
            1.06
        } else {
            1.0
        };
        let score = (peak.strength as f64) * gauss * kind_boost;
        if score > best_score {
            best_score = score;
            best_peak = Some(peak);
        }
    }

    if let Some(peak) = best_peak {
        AcousticSnapResult {
            found: true,
            snapped_time_sec: peak.time_sec,
            confidence: peak.strength,
            kind: peak.kind,
        }
    } else {
        AcousticSnapResult {
            found: false,
            snapped_time_sec: target_time_sec,
            confidence: 0.0,
            kind: AcousticSnapKind::None,
        }
    }
}

/// Snap a single boundary/point timestamp using the built-in `TGrid-AcouSeg 1.0` model.
pub fn snap_boundary_to_acoustic_edge(
    samples: &[f32],
    sample_rate: u32,
    samples_origin_sec: f64,
    target_time_sec: f64,
    window_sec: f64,
) -> AcousticSnapResult {
    snap_boundary_to_acoustic_edge_with_model(
        samples,
        sample_rate,
        samples_origin_sec,
        target_time_sec,
        window_sec,
        crate::nn::builtin_acouseg_net(),
    )
}
