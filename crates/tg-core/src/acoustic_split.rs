use serde::{Deserialize, Serialize};
use std::f64::consts::TAU;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SplitGranularity {
    Delimiter,
    Word,
    Syllable,
    OnsetRime,
    Phone,
    ToneSplit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AcousticClass {
    VoicelessObs,
    VoicedObs,
    NasalLiquid,
    Vowel,
    Syllable,
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct F0Frame {
    pub time_sec: f64,
    pub f0_hz: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcousticSplitParams {
    pub sample_rate: u32,
    #[serde(default)]
    pub samples_origin_sec: f64,
    pub xmin: f64,
    pub xmax: f64,
    pub granularity: SplitGranularity,
    pub duration_weights: Vec<f64>,
    #[serde(default)]
    pub acoustic_classes: Vec<AcousticClass>,
    #[serde(default)]
    pub f0_frames: Option<Vec<F0Frame>>,
}

#[derive(Debug, Clone)]
pub struct AcousticSplitInput<'a> {
    pub samples: &'a [f32],
    pub sample_rate: u32,
    pub samples_origin_sec: f64,
    pub xmin: f64,
    pub xmax: f64,
    pub granularity: SplitGranularity,
    pub duration_weights: &'a [f64],
    pub acoustic_classes: &'a [AcousticClass],
    pub f0_frames: Option<&'a [F0Frame]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcousticSplitOutput {
    pub cuts: Vec<f64>,
    pub confidence: f64,
    pub fallback_to_equal: bool,
    pub speech_span: (f64, f64),
}

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

fn percentile(vals: &[f64], p: f64) -> f64 {
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

fn fft_radix2_inplace(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    debug_assert!(n.is_power_of_two() && n == im.len());
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2usize;
    while len <= n {
        let half = len >> 1;
        let ang = -TAU / (len as f64);
        let (wlen_sin, wlen_cos) = ang.sin_cos();
        for start in (0..n).step_by(len) {
            let (mut wr, mut wi) = (1.0f64, 0.0f64);
            for k in 0..half {
                let u = start + k;
                let v = u + half;
                let vr = (re[v] as f64) * wr - (im[v] as f64) * wi;
                let vi = (re[v] as f64) * wi + (im[v] as f64) * wr;
                let ur = re[u] as f64;
                let ui = im[u] as f64;
                re[u] = (ur + vr) as f32;
                im[u] = (ui + vi) as f32;
                re[v] = (ur - vr) as f32;
                im[v] = (ui - vi) as f32;
                let next_wr = wr * wlen_cos - wi * wlen_sin;
                wi = wr * wlen_sin + wi * wlen_cos;
                wr = next_wr;
            }
        }
        len <<= 1;
    }
}

fn hz_to_mel(hz: f64) -> f64 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

fn mel_to_hz(mel: f64) -> f64 {
    700.0 * (10.0_f64.powf(mel / 2595.0) - 1.0)
}

fn build_preemph_mel_bank(
    n_fft: usize,
    sample_rate: f64,
    f_low: f64,
    f_top: f64,
) -> Vec<Vec<(usize, f64)>> {
    const NUM_BANDS: usize = 20;
    let half = n_fft / 2;
    let df = sample_rate / (n_fft as f64);

    let mut g_pre = vec![0.0f64; half + 1];
    for (k, g) in g_pre.iter_mut().enumerate() {
        *g = 1.0 + 0.97 * 0.97 - 2.0 * 0.97 * (TAU * (k as f64) / (n_fft as f64)).cos();
    }

    let mel_lo = hz_to_mel(f_low);
    let mel_hi = hz_to_mel(f_top);
    let mut hz_pts = [0.0f64; NUM_BANDS + 2];
    for (i, pt) in hz_pts.iter_mut().enumerate() {
        let mel = mel_lo + (mel_hi - mel_lo) * (i as f64) / ((NUM_BANDS + 1) as f64);
        *pt = mel_to_hz(mel);
    }

    let mut bank = Vec::with_capacity(NUM_BANDS);
    for b in 0..NUM_BANDS {
        let f_l = hz_pts[b];
        let f_c = hz_pts[b + 1];
        let f_r = hz_pts[b + 2];
        let mut weights = Vec::new();
        let mut sum_w = 0.0f64;

        for k in 0..=half {
            let f = (k as f64) * df;
            let w = if f >= f_l && f <= f_c {
                (f - f_l) / (f_c - f_l).max(1e-9)
            } else if f > f_c && f <= f_r {
                (f_r - f) / (f_r - f_c).max(1e-9)
            } else {
                0.0
            };
            if w > 0.0 {
                weights.push((k, w));
                sum_w += w;
            }
        }

        if sum_w <= 0.0 {
            let k_nearest = ((f_c / df).round() as usize).clamp(0, half);
            weights.push((k_nearest, g_pre[k_nearest]));
        } else {
            for (k, w) in &mut weights {
                *w = (*w / sum_w) * g_pre[*k];
            }
        }
        bank.push(weights);
    }
    bank
}

#[inline]
fn dir_diff(arr: &[f64], m: usize, delta_d: usize) -> f64 {
    let last = arr.len() - 1;
    let hi = (m + delta_d).min(last);
    let lo = m.saturating_sub(delta_d);
    arr[hi] - arr[lo]
}

fn median3(a: f64, b: f64, c: f64) -> f64 {
    let mut v = [a, b, c];
    v.sort_by(|x, y| x.total_cmp(y));
    v[1]
}

fn compute_voicing(
    samples: &[f32],
    dc_mean: f32,
    samples_origin_sec: f64,
    fs: f64,
    frame_times: &[f64],
    e_tot: &[f64],
    e_floor: f64,
    d_act: f64,
    f0_frames: Option<&[F0Frame]>,
) -> Vec<f64> {
    let m_frames = frame_times.len();

    if let Some(f0s) = f0_frames {
        if !f0s.is_empty() {
            let mut sorted: Vec<F0Frame> = f0s
                .iter()
                .copied()
                .filter(|f| f.time_sec.is_finite())
                .collect();
            if !sorted.is_empty() {
                sorted.sort_by(|a, b| a.time_sec.total_cmp(&b.time_sec));
                let mut raw = vec![0.0f64; m_frames];
                let mut cursor = 0usize;
                for (m, &t) in frame_times.iter().enumerate() {
                    while cursor + 1 < sorted.len()
                        && (sorted[cursor + 1].time_sec - t).abs()
                            <= (sorted[cursor].time_sec - t).abs()
                    {
                        cursor += 1;
                    }
                    let hz = sorted[cursor].f0_hz;
                    raw[m] = if hz.is_finite() && hz > 0.0 { 1.0 } else { 0.0 };
                }
                let mut smoothed = vec![0.0f64; m_frames];
                for m in 0..m_frames {
                    let prev = raw[m.saturating_sub(1)];
                    let cur = raw[m];
                    let next = raw[(m + 1).min(m_frames - 1)];
                    smoothed[m] = median3(prev, cur, next);
                }
                return smoothed;
            }
        }
    }

    let win_samples = ((0.030 * fs).round() as usize).max(32);
    let decim = ((fs / 4000.0).round() as usize).max(1);
    let f_d = fs / (decim as f64);
    let n_p = (win_samples / decim).max(24);
    let tau_min = ((f_d / 450.0).floor() as usize).max(1);
    let tau_max = ((f_d / 75.0).ceil() as usize).min(n_p.saturating_sub(2));

    let sample_at = |idx: isize| -> f64 {
        if idx >= 0 && (idx as usize) < samples.len() {
            let v = samples[idx as usize];
            if v.is_finite() {
                (v - dc_mean) as f64
            } else {
                0.0
            }
        } else {
            0.0
        }
    };

    let mut u = vec![0.0f64; n_p];
    let mut voicing = vec![0.0f64; m_frames];
    let inv_decim = 1.0 / (decim as f64);

    for (m, &t) in frame_times.iter().enumerate() {
        let energy_ok = if d_act >= 12.0 {
            e_tot[m] > e_floor + 6.0
        } else {
            e_tot[m] > -55.0
        };
        if !energy_ok || tau_min > tau_max {
            voicing[m] = 0.0;
            continue;
        }

        let center_idx = ((t - samples_origin_sec) * fs).round() as isize;
        let win_start = center_idx - ((n_p * decim) as isize) / 2;

        for (i, slot) in u.iter_mut().enumerate() {
            let base = win_start + (i * decim) as isize;
            let mut acc = 0.0f64;
            for d in 0..decim {
                acc += sample_at(base + d as isize);
            }
            *slot = acc * inv_decim;
        }

        let mut r_max = 0.0f64;
        for tau in tau_min..=tau_max {
            let len = n_p - tau;
            let mut num = 0.0f64;
            let mut e1 = 0.0f64;
            let mut e2 = 0.0f64;
            for j in 0..len {
                let a = u[j];
                let b = u[j + tau];
                num += a * b;
                e1 += a * a;
                e2 += b * b;
            }
            let r = num / (e1 * e2 + 1e-12).sqrt();
            if r > r_max {
                r_max = r;
            }
        }

        voicing[m] = ((r_max - 0.35) / 0.40).clamp(0.0, 1.0);
    }

    voicing
}

fn detect_speech_span(
    e_act: &[f64],
    theta_sil: f64,
    d_act: f64,
    dt: f64,
    k: usize,
) -> (usize, usize) {
    let m_frames = e_act.len();
    if d_act < 12.0 {
        return (0, m_frames - 1);
    }

    let mut active: Vec<bool> = e_act.iter().map(|&e| e > theta_sil).collect();

    // Remove isolated short transient spikes (< 25 ms) surrounded by >= 80 ms silence
    let min_spike = ((0.025 / dt).round() as usize).max(1);
    let min_sil_surround = ((0.080 / dt).round() as usize).max(1);
    let mut i = 0usize;
    while i < m_frames {
        if active[i] {
            let start = i;
            while i < m_frames && active[i] {
                i += 1;
            }
            let end = i;
            let run_len = end - start;
            if run_len < min_spike {
                let mut left_sil = 0usize;
                let mut p = start;
                while p > 0 && !active[p - 1] {
                    left_sil += 1;
                    p -= 1;
                }
                if p == 0 {
                    left_sil = left_sil.max(min_sil_surround);
                }

                let mut right_sil = 0usize;
                let mut q = end;
                while q < m_frames && !active[q] {
                    right_sil += 1;
                    q += 1;
                }
                if q == m_frames {
                    right_sil = right_sil.max(min_sil_surround);
                }

                if left_sil >= min_sil_surround && right_sil >= min_sil_surround {
                    for slot in &mut active[start..end] {
                        *slot = false;
                    }
                }
            }
        } else {
            i += 1;
        }
    }

    // Bridge short internal closures (< 90 ms)
    let max_bridge = ((0.090 / dt).round() as usize).max(1);
    let mut j = 0usize;
    while j < m_frames {
        if !active[j] {
            let start = j;
            while j < m_frames && !active[j] {
                j += 1;
            }
            let end = j;
            if start > 0 && end < m_frames && (end - start) < max_bridge {
                for slot in &mut active[start..end] {
                    *slot = true;
                }
            }
        } else {
            j += 1;
        }
    }

    let first_act = active.iter().position(|&a| a);
    let last_act = active.iter().rposition(|&a| a);
    let (Some(m_first), Some(m_last)) = (first_act, last_act) else {
        return (0, m_frames - 1);
    };

    let lead_pad = (0.010 / dt).round() as usize;
    let trail_pad = (0.015 / dt).round() as usize;
    let n_vs = if (m_first as f64) * dt > 0.060 {
        m_first.saturating_sub(lead_pad)
    } else {
        0
    };
    let n_ve = if ((m_frames - 1 - m_last) as f64) * dt > 0.060 {
        (m_last + trail_pad).min(m_frames - 1)
    } else {
        m_frames - 1
    };

    let min_eff = (k + 2).max((0.060 / dt).round() as usize);
    if n_ve <= n_vs || (n_ve - n_vs) < min_eff {
        (0, m_frames - 1)
    } else {
        (n_vs, n_ve)
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

fn extract_syllable_nuclei(
    s_env: &[f64],
    voicing: &[f64],
    theta_sil: f64,
    n_vs: usize,
    n_ve: usize,
    dt: f64,
) -> Vec<usize> {
    let rad = ((0.020 / dt).round() as usize).max(1);
    let mut cands: Vec<usize> = Vec::new();
    for m in (n_vs + 1)..n_ve {
        if s_env[m] <= theta_sil + 6.0 || voicing[m] < 0.30 {
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
            if s_env[j] > s_env[m] {
                is_max = false;
                break;
            }
            if s_env[j] < s_env[m] {
                strict_gt = true;
            } else if j < m {
                // Plateau tie-break: pick left-most point
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
            let valley = s_env[prev..=cand]
                .iter()
                .copied()
                .fold(f64::INFINITY, f64::min);
            let dip = s_env[prev].min(s_env[cand]) - valley;
            if too_close || dip < 2.0 {
                if s_env[cand] > s_env[prev] {
                    *nuclei.last_mut().unwrap() = cand;
                }
                continue;
            }
        }
        nuclei.push(cand);
    }
    nuclei
}

pub fn align_split_boundaries(input: &AcousticSplitInput<'_>) -> AcousticSplitOutput {
    let k = input.duration_weights.len();
    let xmin = input.xmin;
    let xmax = input.xmax;
    let dur = xmax - xmin;
    let default_span = if xmin.is_finite() && xmax.is_finite() && xmax > xmin {
        (xmin, xmax)
    } else {
        (xmin, xmin)
    };

    // Guard clauses
    if k <= 1 {
        return fallback_output(xmin, xmax, k, default_span);
    }
    if !xmin.is_finite()
        || !xmax.is_finite()
        || !input.samples_origin_sec.is_finite()
        || dur <= 0.0
        || input.sample_rate < 4000
        || input.samples.is_empty()
    {
        return fallback_output(xmin, xmax, k, default_span);
    }
    if input.granularity == SplitGranularity::ToneSplit {
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

    // Frame grid
    let fs = input.sample_rate as f64;
    let dt_nom = if dur <= 8.0 { 0.005 } else { 0.010 };
    let m_frames = (k + 2).max((dur / dt_nom).round() as usize + 1);
    let dt = dur / ((m_frames - 1) as f64);
    let frame_times: Vec<f64> = (0..m_frames).map(|m| xmin + (m as f64) * dt).collect();

    // DC mean on [xmin - 0.015, xmax + 0.015]
    let dc_start = (((xmin - 0.015 - input.samples_origin_sec) * fs).floor() as isize).max(0)
        as usize;
    let dc_end = (((xmax + 0.015 - input.samples_origin_sec) * fs).ceil() as isize)
        .clamp(0, input.samples.len() as isize) as usize;
    let dc_mean: f32 = if dc_start < dc_end {
        let mut acc = 0.0f64;
        let mut cnt = 0usize;
        for &s in &input.samples[dc_start..dc_end] {
            if s.is_finite() {
                acc += s as f64;
                cnt += 1;
            }
        }
        if cnt > 0 {
            (acc / cnt as f64) as f32
        } else {
            0.0
        }
    } else {
        0.0
    };

    let lw = ((0.020 * fs).round() as usize).max(64);
    let n_fft = lw.next_power_of_two().max(256);
    let half_fft = n_fft / 2;

    let mut hann = vec![0.0f32; lw];
    let mut s_h = 0.0f64;
    for (j, h) in hann.iter_mut().enumerate() {
        let val = 0.5 * (1.0 - (TAU * (j as f64) / ((lw - 1) as f64)).cos());
        *h = val as f32;
        s_h += val * val;
    }
    let power_norm = 1.0 / ((n_fft as f64) * s_h);

    let df = fs / (n_fft as f64);
    let f_top = (8000.0_f64).min(0.475 * fs);
    let f_mid_hi = if input.sample_rate < 10_000 {
        2200.0
    } else {
        3000.0
    };

    let mel_bank = build_preemph_mel_bank(n_fft, fs, 80.0, f_top);

    let mut low_bins = Vec::new();
    let mut mid_bins = Vec::new();
    let mut high_bins = Vec::new();
    let mut tot_bins = Vec::new();
    for k_bin in 0..=half_fft {
        let f = (k_bin as f64) * df;
        if f >= 80.0 && f <= f_top {
            tot_bins.push(k_bin);
            if f < 400.0 {
                low_bins.push(k_bin);
            } else if f < f_mid_hi {
                mid_bins.push(k_bin);
            } else {
                high_bins.push(k_bin);
            }
        }
    }

    let mut e_low = vec![-100.0f64; m_frames];
    let mut e_mid = vec![-100.0f64; m_frames];
    let mut e_high = vec![-100.0f64; m_frames];
    let mut e_tot = vec![-100.0f64; m_frames];
    let mut e_act = vec![-100.0f64; m_frames];
    let mut mel_db = vec![[-100.0f64; 20]; m_frames];

    let mut fft_re = vec![0.0f32; n_fft];
    let mut fft_im = vec![0.0f32; n_fft];
    let mut p_even = vec![0.0f64; half_fft + 1];
    let mut p_odd = vec![0.0f64; half_fft + 1];

    let sample_at = |idx: isize| -> f32 {
        if idx >= 0 && (idx as usize) < input.samples.len() {
            let v = input.samples[idx as usize];
            if v.is_finite() {
                v - dc_mean
            } else {
                0.0
            }
        } else {
            0.0
        }
    };

    let mut pair_start = 0usize;
    while pair_start < m_frames {
        let has_odd = pair_start + 1 < m_frames;
        fft_re.fill(0.0);
        fft_im.fill(0.0);

        let c0 = ((frame_times[pair_start] - input.samples_origin_sec) * fs).round() as isize;
        let s0 = c0 - (lw as isize) / 2;
        for j in 0..lw {
            fft_re[j] = sample_at(s0 + j as isize) * hann[j];
        }

        if has_odd {
            let c1 =
                ((frame_times[pair_start + 1] - input.samples_origin_sec) * fs).round() as isize;
            let s1 = c1 - (lw as isize) / 2;
            for j in 0..lw {
                fft_im[j] = sample_at(s1 + j as isize) * hann[j];
            }
        }

        fft_radix2_inplace(&mut fft_re, &mut fft_im);

        p_even[0] = (fft_re[0] as f64).powi(2) * power_norm;
        p_odd[0] = (fft_im[0] as f64).powi(2) * power_norm;
        p_even[half_fft] = (fft_re[half_fft] as f64).powi(2) * power_norm;
        p_odd[half_fft] = (fft_im[half_fft] as f64).powi(2) * power_norm;

        for kb in 1..half_fft {
            let kp = n_fft - kb;
            let rk = fft_re[kb] as f64;
            let ik = fft_im[kb] as f64;
            let rkp = fft_re[kp] as f64;
            let ikp = fft_im[kp] as f64;
            let a0 = rk + rkp;
            let b0 = ik - ikp;
            p_even[kb] = 0.5 * (a0 * a0 + b0 * b0) * power_norm;
            if has_odd {
                let a1 = ik + ikp;
                let b1 = rk - rkp;
                p_odd[kb] = 0.5 * (a1 * a1 + b1 * b1) * power_norm;
            }
        }

        let store_frame = |m_idx: usize,
                           spec: &[f64],
                           e_low: &mut [f64],
                           e_mid: &mut [f64],
                           e_high: &mut [f64],
                           e_tot: &mut [f64],
                           e_act: &mut [f64],
                           mel_db: &mut [[f64; 20]]| {
            let sum_bins = |bins: &[usize]| -> f64 {
                let mut s = 0.0f64;
                for &b in bins {
                    s += spec[b];
                }
                10.0 * (s + 1e-10).log10()
            };
            let el = sum_bins(&low_bins);
            let em = sum_bins(&mid_bins);
            let eh = sum_bins(&high_bins);
            let et = sum_bins(&tot_bins);
            e_low[m_idx] = el;
            e_mid[m_idx] = em;
            e_high[m_idx] = eh;
            e_tot[m_idx] = et;
            e_act[m_idx] = et.max(eh + 6.0);
            for (b_idx, weights) in mel_bank.iter().enumerate() {
                let mut ms = 0.0f64;
                for &(bin, w) in weights {
                    ms += w * spec[bin];
                }
                mel_db[m_idx][b_idx] = 10.0 * (ms + 1e-10).log10();
            }
        };

        store_frame(
            pair_start,
            &p_even,
            &mut e_low,
            &mut e_mid,
            &mut e_high,
            &mut e_tot,
            &mut e_act,
            &mut mel_db,
        );
        if has_odd {
            store_frame(
                pair_start + 1,
                &p_odd,
                &mut e_low,
                &mut e_mid,
                &mut e_high,
                &mut e_tot,
                &mut e_act,
                &mut mel_db,
            );
        }

        pair_start += 2;
    }

    // Dynamic noise floor clamp (only anchor to e_floor when silence frames exist)
    let e_peak_act = percentile(&e_act, 0.95);
    let e_floor = percentile(&e_tot, 0.05);
    let d_act = e_peak_act - e_floor;
    let l_clamp = if d_act >= 12.0 {
        (e_floor - 3.0).max(e_peak_act - 50.0)
    } else {
        e_peak_act - 50.0
    };
    let l_clamp_mel = if d_act >= 12.0 {
        (e_floor - 15.0).max(e_peak_act - 55.0)
    } else {
        e_peak_act - 55.0
    };

    let e_low_c: Vec<f64> = e_low.iter().map(|&v| v.max(l_clamp)).collect();
    let e_mid_c: Vec<f64> = e_mid.iter().map(|&v| v.max(l_clamp)).collect();
    let e_high_c: Vec<f64> = e_high.iter().map(|&v| v.max(l_clamp)).collect();
    let h_tilt: Vec<f64> = (0..m_frames).map(|m| e_high_c[m] - e_low_c[m]).collect();

    for frame in &mut mel_db {
        for v in frame.iter_mut() {
            if *v < l_clamp_mel {
                *v = l_clamp_mel;
            }
        }
    }

    // Spectral Transition Measure (STM)
    let half_i = ((0.015 / dt).round() as isize).max(2);
    let d_norm: f64 = (1..=half_i).map(|i| 2.0 * ((i * i) as f64)).sum();
    let mut stm = vec![0.0f64; m_frames];
    for m in 0..m_frames {
        let mut sq_sum = 0.0f64;
        for b in 0..20 {
            let mut num = 0.0f64;
            for i in -half_i..=half_i {
                let idx = (m as isize + i).clamp(0, (m_frames - 1) as isize) as usize;
                num += (i as f64) * mel_db[idx][b];
            }
            let slope = num / d_norm;
            sq_sum += slope * slope;
        }
        stm[m] = (sq_sum / 20.0).sqrt();
    }

    // Effective acoustic contrast (SNR_eff) hard gate
    let stm_p98 = percentile(&stm, 0.98);
    let stm_p50 = percentile(&stm, 0.50);
    let snr_eff = d_act.max(2.5 * (stm_p98 - stm_p50));

    if e_peak_act < -55.0 || snr_eff < 8.0 {
        return fallback_output(xmin, xmax, k, (xmin, xmax));
    }

    // Voicing feature V(m)
    let voicing = compute_voicing(
        input.samples,
        dc_mean,
        input.samples_origin_sec,
        fs,
        &frame_times,
        &e_tot,
        e_floor,
        d_act,
        input.f0_frames,
    );

    // Silence threshold & leading/trailing silence stripping
    let theta_sil = if d_act >= 12.0 {
        (e_floor + 5.0).max(e_peak_act - 28.0)
    } else {
        e_peak_act - 28.0
    };
    let (n_vs, n_ve) = detect_speech_span(&e_act, theta_sil, d_act, dt, k);
    let speech_span = (frame_times[n_vs], frame_times[n_ve]);
    let n_eff = n_ve - n_vs;

    // Mid-utterance long pause detection & cumulative active progress prefix sum C[m]
    let delta_d = ((0.010 / dt).round() as usize).max(1);
    let mut c_pause_end = vec![0.0f64; m_frames];
    let mut psi = vec![1.0f64; m_frames];
    let mut is_long_pause_region = vec![false; m_frames];

    if d_act >= 12.0 {
        let mut m = n_vs + 1;
        while m < n_ve {
            if e_act[m] <= theta_sil {
                let p_s = m;
                while m < n_ve && e_act[m] <= theta_sil {
                    m += 1;
                }
                let p_e = m;
                if ((p_e - p_s) as f64) * dt >= 0.140 {
                    // Check if p_e is an unvoiced non-fricative plosive burst followed by a stop-like onset
                    let burst_shift = ((0.055 / dt).round() as usize).max(1);
                    let looks_like_burst = p_e < m_frames
                        && voicing[p_e] < 0.25
                        && h_tilt[p_e] > 0.0
                        && classes.iter().any(|&c| c == AcousticClass::VoicelessObs);
                    let m_resume = if looks_like_burst {
                        (p_s + 1).max(p_e.saturating_sub(burst_shift))
                    } else {
                        p_e.saturating_sub(1).max(p_s + 1)
                    };

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
                    let mask_lo = p_s.saturating_sub(delta_d + 2);
                    let mask_hi = m_resume.saturating_sub(delta_d + 1).max(p_s);
                    for slot in &mut is_long_pause_region[mask_lo..=mask_hi.min(m_frames - 1)] {
                        *slot = true;
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

    // Robust STM normalization on [n_vs, n_ve]
    let stm_p20 = percentile(&stm[n_vs..=n_ve], 0.20);
    let stm_p95 = percentile(&stm[n_vs..=n_ve], 0.95);
    let stm_denom = (stm_p95 - stm_p20).max(1.5);
    let stm_hat: Vec<f64> = stm
        .iter()
        .map(|&v| ((v - stm_p20) / stm_denom).clamp(0.0, 1.0))
        .collect();

    // Branch routing
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

    // Boundary score curves B_k(m) for k = 1..K (stored at index k - 1)
    let mut b_scores: Vec<Vec<f64>> = Vec::with_capacity(k - 1);
    let mut nuclei_corridors: Option<Vec<(usize, usize)>> = None;

    if !is_branch_b {
        // Branch A: Syllable / Word level
        let smooth_hw = ((0.0175 / dt).round() as usize).max(1);
        let s_env = triangular_smooth(&e_mid_c, smooth_hw);

        if input.granularity == SplitGranularity::Syllable {
            let nuclei = extract_syllable_nuclei(&s_env, &voicing, theta_sil, n_vs, n_ve, dt);
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

        let ws = ((0.120 / dt).round() as usize).max(1);
        let mut b_syl = vec![0.0f64; m_frames];

        for m in 0..m_frames {
            let lo = m.saturating_sub(ws);
            let hi = (m + ws).min(m_frames - 1);
            let s_l = s_env[lo..=m]
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max);
            let s_r = s_env[m..=hi]
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max);
            let d_dip = ((s_l.min(s_r) - s_env[m]) / 12.0).clamp(0.0, 1.0);

            let m_next = (m + delta_d).min(m_frames - 1);
            let m_prev = m.saturating_sub(delta_d);

            // Fricative onset from preceding speech (not burst after a silent stop closure)
            let prev_is_speech = e_act[m_prev] > theta_sil + 6.0;
            let c_fric = if prev_is_speech && h_tilt[m_next] > -5.0 {
                ((dir_diff(&e_high_c, m, delta_d) - dir_diff(&e_low_c, m, delta_d)) / 18.0)
                    .clamp(0.0, 1.0)
            } else {
                0.0
            };

            // Stop closure onset (short closure < 140ms belongs to following syllable)
            let c_close = if !is_long_pause_region[m] && e_act[m_next] <= theta_sil + 6.0 {
                (-dir_diff(&e_mid_c, m, delta_d) / 15.0).clamp(0.0, 1.0)
            } else {
                0.0
            };

            // Sonorant dip transition
            let ds = dir_diff(&s_env, m, delta_d);
            let c_son = if ds <= 3.0 {
                d_dip * stm_hat[m]
            } else {
                0.0
            };

            // Suppress CV release inside a syllable (unless resuming from a long pause)
            let p_cv = if c_pause_end[m] == 0.0 {
                ((ds - 6.0) / 12.0).clamp(0.0, 1.0)
            } else {
                0.0
            };

            let landmark = c_fric.max(c_close).max(c_son).max(c_pause_end[m]);
            b_syl[m] = (0.30 * d_dip
                + 0.30 * stm_hat[m] * (1.0 - p_cv)
                + 0.40 * landmark
                - 0.35 * p_cv)
                .clamp(0.0, 1.0);
        }

        for _ in 0..(k - 1) {
            b_scores.push(b_syl.clone());
        }
    } else {
        // Branch B: Onset-Rime / Phone level
        for cut_idx in 0..(k - 1) {
            let c_l = classes[cut_idx];
            let c_r = classes[cut_idx + 1];
            let mut b_curve = vec![0.0f64; m_frames];

            for m in 0..m_frames {
                let mut eta = 1.0f64;
                let phi = match (c_l, c_r) {
                    (
                        AcousticClass::VoicelessObs,
                        AcousticClass::Vowel | AcousticClass::NasalLiquid,
                    ) => {
                        let m_ahead = (m + delta_d + 1).min(m_frames - 1);
                        if voicing[m_ahead] < 0.25 && h_tilt[m_ahead] > -2.0 {
                            eta = 0.25;
                        }
                        let dv = dir_diff(&voicing, m, delta_d).clamp(0.0, 1.0);
                        let d_low = (dir_diff(&e_low_c, m, delta_d) / 18.0).clamp(0.0, 1.0);
                        let d_tilt = (-dir_diff(&h_tilt, m, delta_d) / 20.0).clamp(0.0, 1.0);
                        0.45 * dv.max(d_low) + 0.15 * d_tilt
                    }
                    (
                        AcousticClass::Vowel | AcousticClass::NasalLiquid,
                        AcousticClass::VoicelessObs,
                    ) => {
                        let dv = (-dir_diff(&voicing, m, delta_d)).clamp(0.0, 1.0);
                        let d_low = (-dir_diff(&e_low_c, m, delta_d) / 18.0).clamp(0.0, 1.0);
                        let d_high = (dir_diff(&e_high_c, m, delta_d) / 15.0).clamp(0.0, 1.0);
                        0.35 * dv.max(d_low) + 0.15 * d_high
                    }
                    (AcousticClass::Vowel, AcousticClass::NasalLiquid) => {
                        let m_next = (m + delta_d).min(m_frames - 1);
                        if e_low_c[m_next] > theta_sil + 8.0 {
                            0.40 * (-dir_diff(&e_mid_c, m, delta_d) / 10.0).clamp(0.0, 1.0)
                        } else {
                            0.0
                        }
                    }
                    (AcousticClass::NasalLiquid, AcousticClass::Vowel) => {
                        let m_prev = m.saturating_sub(delta_d);
                        if e_low_c[m_prev] > theta_sil + 8.0 {
                            0.40 * (dir_diff(&e_mid_c, m, delta_d) / 10.0).clamp(0.0, 1.0)
                        } else {
                            0.0
                        }
                    }
                    (
                        AcousticClass::VoicedObs,
                        AcousticClass::Vowel | AcousticClass::NasalLiquid,
                    ) => {
                        let d_mid = (dir_diff(&e_mid_c, m, delta_d) / 12.0).clamp(0.0, 1.0);
                        let d_high = (-dir_diff(&e_high_c, m, delta_d) / 12.0).clamp(0.0, 1.0);
                        0.35 * d_mid + 0.10 * d_high
                    }
                    (AcousticClass::Vowel, AcousticClass::VoicedObs) => {
                        0.35 * (-dir_diff(&e_mid_c, m, delta_d) / 12.0).clamp(0.0, 1.0)
                    }
                    _ => 0.25 * stm_hat[m] * voicing[m],
                };

                b_curve[m] = (0.55 * stm_hat[m] * eta + phi).clamp(0.0, 1.0);
            }

            b_scores.push(b_curve);
        }
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

    // Minimum duration constraints guaranteed to satisfy sum(d_min) < n_eff
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

    // Cumulative hard bounds [d_lo[idx], d_hi[idx]] for cut idx (0..k-1)
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

    // Ensure feasibility across adjacent layers; fallback to hard bounds if corridor causes conflict
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
    let mu_reg_sq = 16.0f64; // 4.0^2
    let dur_penalty = |seg_idx: usize, j: usize, m: usize| -> f64 {
        let delta_c = c_pref[m] - c_pref[j];
        let diff_c = delta_c - mu_active[seg_idx];
        lambda * (diff_c * diff_c) / (mu_active[seg_idx] * mu_active[seg_idx] + mu_reg_sq)
    };

    let num_cuts = k - 1;
    let mut dp = vec![vec![f64::NEG_INFINITY; m_frames]; num_cuts];
    let mut ptr = vec![vec![0usize; m_frames]; num_cuts];

    // Layer 0 (cut 1)
    for m in win_l[0]..=win_r[0] {
        dp[0][m] = b_scores[0][m] - dur_penalty(0, n_vs, m);
    }

    // Layers 1..num_cuts
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
                let val = prev - dur_penalty(seg_idx, j, m);
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

    // Terminal step (segment K = k - 1)
    let last_cut = num_cuts - 1;
    let last_hi = win_r[last_cut].min(n_ve.saturating_sub(d_min[k - 1]));
    let mut best_end_val = f64::NEG_INFINITY;
    let mut best_last_m = win_l[last_cut];
    for j in win_l[last_cut]..=last_hi {
        let prev = dp[last_cut][j];
        if !prev.is_finite() {
            continue;
        }
        let val = prev - dur_penalty(k - 1, j, n_ve);
        if val > best_end_val {
            best_end_val = val;
            best_last_m = j;
        }
    }

    if !best_end_val.is_finite() {
        return fallback_output(xmin, xmax, k, speech_span);
    }

    // Backtrace optimal frame indices
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
        let med_loc = percentile(&b[lo..=hi], 0.50);
        let prom = (b[n_star] - med_loc).max(0.0);
        prom_sum += (prom / 0.45).clamp(0.0, 1.0);
    }
    let q_prom = prom_sum / (num_cuts as f64);
    let q_snr = ((snr_eff - 8.0) / 12.0).clamp(0.0, 1.0);
    let confidence = (0.40 * q_snr + 0.60 * q_prom).clamp(0.0, 1.0);

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

    AcousticSplitOutput {
        cuts,
        confidence,
        fallback_to_equal: false,
        speech_span,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct XorShift64 {
        state: u64,
    }

    impl XorShift64 {
        fn new(seed: u64) -> Self {
            Self {
                state: if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed },
            }
        }

        fn next_u64(&mut self) -> u64 {
            let mut x = self.state;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.state = x;
            x
        }

        /// Uniform in [-1.0, 1.0]
        fn next_f32_signed(&mut self) -> f32 {
            let u = (self.next_u64() >> 11) as f64 / ((1u64 << 53) as f64);
            (2.0 * u - 1.0) as f32
        }
    }

    fn gen_highpass_noise(rng: &mut XorShift64, len: usize, amp: f32) -> Vec<f32> {
        let mut out = Vec::with_capacity(len);
        let mut prev = 0.0f32;
        for _ in 0..len {
            let w = rng.next_f32_signed() * amp;
            out.push(w - 0.95 * prev);
            prev = w;
        }
        out
    }

    fn gen_white_noise(rng: &mut XorShift64, len: usize, amp: f32) -> Vec<f32> {
        (0..len).map(|_| rng.next_f32_signed() * amp).collect()
    }

    fn gen_harmonics(fs: u32, start_sec: f64, len: usize, partials: &[(f64, f64)]) -> Vec<f32> {
        let mut out = Vec::with_capacity(len);
        let dt = 1.0 / (fs as f64);
        for i in 0..len {
            let t = start_sec + (i as f64) * dt;
            let mut s = 0.0f64;
            for &(freq, amp) in partials {
                s += amp * (TAU * freq * t).sin();
            }
            out.push(s as f32);
        }
        out
    }

    fn crossfade_boundary(buf: &mut [f32], boundary_idx: usize, fade_samples: usize) {
        if fade_samples == 0 || boundary_idx < fade_samples || boundary_idx + fade_samples > buf.len() {
            return;
        }
        // Simple linear ramp smoothing across boundary
        let left_val = buf[boundary_idx - fade_samples];
        let right_val = buf[boundary_idx + fade_samples - 1];
        let total = (2 * fade_samples) as f32;
        for k in 0..(2 * fade_samples) {
            let idx = boundary_idx - fade_samples + k;
            let alpha = (k as f32) / total;
            let w = if k < fade_samples {
                1.0 - (k as f32) / (fade_samples as f32)
            } else {
                ((k - fade_samples) as f32) / (fade_samples as f32)
            };
            let _ = (left_val, right_val, alpha);
            buf[idx] *= 0.25 + 0.75 * w;
        }
    }

    #[test]
    fn test_fricative_to_vowel_onset_rime() {
        let fs = 16_000u32;
        let total = (0.40 * fs as f64).round() as usize;
        let split_idx = (0.130 * fs as f64).round() as usize;
        let mut rng = XorShift64::new(101);

        let fric = gen_highpass_noise(&mut rng, split_idx, 0.18);
        let vowel = gen_harmonics(
            fs,
            0.130,
            total - split_idx,
            &[(180.0, 0.35), (720.0, 0.25), (1260.0, 0.12)],
        );

        let mut samples = Vec::with_capacity(total);
        samples.extend_from_slice(&fric);
        samples.extend_from_slice(&vowel);
        // 4 ms crossfade at 0.130s
        let fade = (0.004 * fs as f64).round() as usize;
        crossfade_boundary(&mut samples, split_idx, fade / 2);

        let out = align_split_boundaries(&AcousticSplitInput {
            samples: &samples,
            sample_rate: fs,
            samples_origin_sec: 0.0,
            xmin: 0.0,
            xmax: 0.40,
            granularity: SplitGranularity::OnsetRime,
            duration_weights: &[1.0, 1.3],
            acoustic_classes: &[AcousticClass::VoicelessObs, AcousticClass::Vowel],
            f0_frames: None,
        });

        assert!(!out.fallback_to_equal, "expected acoustic alignment, got fallback");
        assert!(
            out.confidence >= 0.65,
            "expected confidence >= 0.65, got {:.3}",
            out.confidence
        );
        assert_eq!(out.cuts.len(), 1);
        assert!(
            (out.cuts[0] - 0.130).abs() <= 0.010,
            "expected cut near 0.130s (<=10ms), got {:.4}s (conf={:.3})",
            out.cuts[0],
            out.confidence
        );
    }

    #[test]
    fn test_plosive_closure_syllable_vs_vot_onset_rime() {
        let fs = 16_000u32;
        let mut rng = XorShift64::new(202);

        let n1 = (0.210 * fs as f64).round() as usize;
        let n2 = (0.070 * fs as f64).round() as usize; // [0.210, 0.280)
        let n3 = (0.055 * fs as f64).round() as usize; // [0.280, 0.335)
        let n4 = (0.265 * fs as f64).round() as usize; // [0.335, 0.600]

        let mut samples = Vec::with_capacity(n1 + n2 + n3 + n4);
        samples.extend_from_slice(&gen_harmonics(
            fs,
            0.0,
            n1,
            &[(160.0, 0.32), (800.0, 0.24)],
        ));
        samples.extend_from_slice(&gen_white_noise(&mut rng, n2, 1e-4));
        samples.extend_from_slice(&gen_highpass_noise(&mut rng, n3, 0.14));
        samples.extend_from_slice(&gen_harmonics(
            fs,
            0.335,
            n4,
            &[(170.0, 0.32), (750.0, 0.24)],
        ));

        // 2A: Syllable split [0.00, 0.60] -> a | tʰa (cut at closure start 0.210s)
        let out_syl = align_split_boundaries(&AcousticSplitInput {
            samples: &samples,
            sample_rate: fs,
            samples_origin_sec: 0.0,
            xmin: 0.0,
            xmax: 0.60,
            granularity: SplitGranularity::Syllable,
            duration_weights: &[1.0, 1.0],
            acoustic_classes: &[AcousticClass::Syllable, AcousticClass::Syllable],
            f0_frames: None,
        });
        assert!(!out_syl.fallback_to_equal, "2A expected acoustic alignment");
        assert!(
            (out_syl.cuts[0] - 0.210).abs() <= 0.015,
            "2A expected cut near closure start 0.210s (<=15ms), got {:.4}s (conf={:.3})",
            out_syl.cuts[0],
            out_syl.confidence
        );

        // 2B: Onset-Rime split [0.210, 0.600] -> tʰ | a (cut at voice onset 0.335s)
        let out_or = align_split_boundaries(&AcousticSplitInput {
            samples: &samples,
            sample_rate: fs,
            samples_origin_sec: 0.0,
            xmin: 0.210,
            xmax: 0.600,
            granularity: SplitGranularity::OnsetRime,
            duration_weights: &[1.0, 1.3],
            acoustic_classes: &[AcousticClass::VoicelessObs, AcousticClass::Vowel],
            f0_frames: None,
        });
        assert!(!out_or.fallback_to_equal, "2B expected acoustic alignment");
        assert!(
            (out_or.cuts[0] - 0.335).abs() <= 0.012,
            "2B expected cut near VOT end 0.335s (<=12ms), got {:.4}s (conf={:.3})",
            out_or.cuts[0],
            out_or.confidence
        );
    }

    #[test]
    fn test_white_noise_and_low_snr_fallback_to_equal() {
        let fs = 44_100u32;
        let dur = 1.20;
        let len = (dur * fs as f64).round() as usize;
        let mut rng = XorShift64::new(303);

        // (a) Pure stationary white noise (amp 0.25)
        let noise_only = gen_white_noise(&mut rng, len, 0.25);
        let out_a = align_split_boundaries(&AcousticSplitInput {
            samples: &noise_only,
            sample_rate: fs,
            samples_origin_sec: 0.20,
            xmin: 0.20,
            xmax: 1.40,
            granularity: SplitGranularity::Syllable,
            duration_weights: &[1.0, 1.0, 1.0],
            acoustic_classes: &[
                AcousticClass::Syllable,
                AcousticClass::Syllable,
                AcousticClass::Syllable,
            ],
            f0_frames: None,
        });
        assert!(out_a.fallback_to_equal, "(a) expected fallback");
        assert_eq!(out_a.confidence, 0.0);
        assert!((out_a.cuts[0] - 0.60).abs() < 1e-9);
        assert!((out_a.cuts[1] - 1.00).abs() < 1e-9);

        // (b) SNR = 0 dB strong white noise burying weak speech
        let clean = gen_harmonics(fs, 0.20, len, &[(180.0, 0.08), (720.0, 0.06)]);
        let mut noisy = gen_white_noise(&mut rng, len, 0.25);
        // Scale speech RMS to match noise RMS (SNR = 0 dB), with mild syllable modulation
        for i in 0..len {
            let t_rel = (i as f64) / (fs as f64);
            let env = if (t_rel > 0.35 && t_rel < 0.42) || (t_rel > 0.78 && t_rel < 0.85) {
                0.2
            } else {
                1.0
            };
            noisy[i] += clean[i] * (env as f32);
        }
        let out_b = align_split_boundaries(&AcousticSplitInput {
            samples: &noisy,
            sample_rate: fs,
            samples_origin_sec: 0.20,
            xmin: 0.20,
            xmax: 1.40,
            granularity: SplitGranularity::Syllable,
            duration_weights: &[1.0, 1.0, 1.0],
            acoustic_classes: &[
                AcousticClass::Syllable,
                AcousticClass::Syllable,
                AcousticClass::Syllable,
            ],
            f0_frames: None,
        });
        assert!(
            out_b.fallback_to_equal,
            "(b) expected fallback on 0 dB SNR, got conf={:.3}",
            out_b.confidence
        );
        assert_eq!(out_b.confidence, 0.0);
        assert!((out_b.cuts[0] - 0.60).abs() < 1e-9);
        assert!((out_b.cuts[1] - 1.00).abs() < 1e-9);

        // (c) Clean speech with ToneSplit granularity
        let out_c = align_split_boundaries(&AcousticSplitInput {
            samples: &clean,
            sample_rate: fs,
            samples_origin_sec: 0.20,
            xmin: 0.20,
            xmax: 1.40,
            granularity: SplitGranularity::ToneSplit,
            duration_weights: &[1.0, 1.0, 1.0],
            acoustic_classes: &[
                AcousticClass::Syllable,
                AcousticClass::Other,
                AcousticClass::Other,
            ],
            f0_frames: None,
        });
        assert!(out_c.fallback_to_equal, "(c) expected fallback on ToneSplit");
        assert_eq!(out_c.confidence, 0.0);
        assert!((out_c.cuts[0] - 0.60).abs() < 1e-9);
        assert!((out_c.cuts[1] - 1.00).abs() < 1e-9);
    }

    #[test]
    fn test_leading_and_trailing_silence_stripping() {
        let fs = 16_000u32;
        let mut rng = XorShift64::new(404);

        let n_lead = (0.15 * fs as f64).round() as usize; // [0.00, 0.15)
        let n_s1 = (0.23 * fs as f64).round() as usize; // [0.15, 0.38)
        let n_dip = (0.05 * fs as f64).round() as usize; // [0.38, 0.43)
        let n_s2 = (0.25 * fs as f64).round() as usize; // [0.43, 0.68)
        let n_trail = (0.52 * fs as f64).round() as usize; // [0.68, 1.20]

        let mut samples = Vec::with_capacity(n_lead + n_s1 + n_dip + n_s2 + n_trail);
        samples.extend_from_slice(&gen_white_noise(&mut rng, n_lead, 0.0004));
        samples.extend_from_slice(&gen_harmonics(
            fs,
            0.15,
            n_s1,
            &[(170.0, 0.32), (760.0, 0.24)],
        ));
        samples.extend_from_slice(&gen_highpass_noise(&mut rng, n_dip, 0.04));
        samples.extend_from_slice(&gen_harmonics(
            fs,
            0.43,
            n_s2,
            &[(185.0, 0.32), (820.0, 0.24)],
        ));
        samples.extend_from_slice(&gen_white_noise(&mut rng, n_trail, 0.0004));

        let out = align_split_boundaries(&AcousticSplitInput {
            samples: &samples,
            sample_rate: fs,
            samples_origin_sec: 0.0,
            xmin: 0.0,
            xmax: 1.20,
            granularity: SplitGranularity::Syllable,
            duration_weights: &[1.0, 1.0],
            acoustic_classes: &[AcousticClass::Syllable, AcousticClass::Syllable],
            f0_frames: None,
        });

        assert!(!out.fallback_to_equal, "expected acoustic alignment");
        assert!(
            (out.speech_span.0 - 0.15).abs() <= 0.020,
            "expected speech_span.0 near 0.15s, got {:.4}s",
            out.speech_span.0
        );
        assert!(
            (out.speech_span.1 - 0.68).abs() <= 0.025,
            "expected speech_span.1 near 0.68s, got {:.4}s",
            out.speech_span.1
        );
        assert!(
            (out.cuts[0] - 0.38).abs() <= 0.020 || (out.cuts[0] >= 0.37 && out.cuts[0] <= 0.41),
            "expected cut near 0.38s or in [0.37, 0.41], got {:.4}s",
            out.cuts[0]
        );
    }

    #[test]
    fn test_phone_level_vowel_to_nasal_coda_48khz() {
        let fs = 48_000u32;
        let mut rng = XorShift64::new(505);

        let n1 = (0.11 * fs as f64).round() as usize; // [0.00, 0.11) /tʰ/
        let n2 = (0.18 * fs as f64).round() as usize; // [0.11, 0.29) /i/
        let n3 = (0.16 * fs as f64).round() as usize; // [0.29, 0.45] /ŋ/

        let mut samples = Vec::with_capacity(n1 + n2 + n3);
        samples.extend_from_slice(&gen_highpass_noise(&mut rng, n1, 0.14));
        samples.extend_from_slice(&gen_harmonics(
            fs,
            0.11,
            n2,
            &[(200.0, 0.30), (320.0, 0.20), (2200.0, 0.28)],
        ));
        samples.extend_from_slice(&gen_harmonics(
            fs,
            0.29,
            n3,
            &[(200.0, 0.32), (2200.0, 0.02)],
        ));

        let out = align_split_boundaries(&AcousticSplitInput {
            samples: &samples,
            sample_rate: fs,
            samples_origin_sec: 0.0,
            xmin: 0.0,
            xmax: 0.45,
            granularity: SplitGranularity::Phone,
            duration_weights: &[1.0, 1.3, 0.8],
            acoustic_classes: &[
                AcousticClass::VoicelessObs,
                AcousticClass::Vowel,
                AcousticClass::NasalLiquid,
            ],
            f0_frames: None,
        });

        assert!(!out.fallback_to_equal, "expected acoustic alignment");
        assert_eq!(out.cuts.len(), 2);
        assert!(
            (out.cuts[0] - 0.11).abs() <= 0.012,
            "expected cut[0] near 0.11s (<=12ms), got {:.4}s",
            out.cuts[0]
        );
        assert!(
            (out.cuts[1] - 0.29).abs() <= 0.015,
            "expected cut[1] near 0.29s (<=15ms), got {:.4}s",
            out.cuts[1]
        );
    }

    #[test]
    fn test_mid_utterance_pause_and_extreme_short_invariants() {
        let fs = 16_000u32;
        let mut rng = XorShift64::new(606);

        // 6A: Mid-utterance 320 ms pause
        let n_s1 = (0.22 * fs as f64).round() as usize; // [0.00, 0.22]
        let n_pause = (0.32 * fs as f64).round() as usize; // [0.22, 0.54]
        let n_s2 = (0.26 * fs as f64).round() as usize; // [0.54, 0.80]
        let n_dip = (0.04 * fs as f64).round() as usize; // [0.80, 0.84]
        let n_s3 = (0.26 * fs as f64).round() as usize; // [0.84, 1.10]

        let mut samples = Vec::with_capacity(n_s1 + n_pause + n_s2 + n_dip + n_s3);
        samples.extend_from_slice(&gen_harmonics(
            fs,
            0.0,
            n_s1,
            &[(175.0, 0.32), (780.0, 0.24)],
        ));
        samples.extend_from_slice(&gen_white_noise(&mut rng, n_pause, 0.0003));
        samples.extend_from_slice(&gen_harmonics(
            fs,
            0.54,
            n_s2,
            &[(180.0, 0.32), (800.0, 0.24)],
        ));
        samples.extend_from_slice(&gen_highpass_noise(&mut rng, n_dip, 0.035));
        samples.extend_from_slice(&gen_harmonics(
            fs,
            0.84,
            n_s3,
            &[(165.0, 0.32), (740.0, 0.24)],
        ));

        let out_a = align_split_boundaries(&AcousticSplitInput {
            samples: &samples,
            sample_rate: fs,
            samples_origin_sec: 0.0,
            xmin: 0.0,
            xmax: 1.10,
            granularity: SplitGranularity::Syllable,
            duration_weights: &[1.0, 1.0, 1.0],
            acoustic_classes: &[
                AcousticClass::Syllable,
                AcousticClass::Syllable,
                AcousticClass::Syllable,
            ],
            f0_frames: None,
        });

        assert!(!out_a.fallback_to_equal, "6A expected acoustic alignment");
        assert_eq!(out_a.cuts.len(), 2);
        assert!(
            (out_a.cuts[0] - 0.54).abs() <= 0.020,
            "6A expected cut[0] near pause resume 0.54s (<=20ms), got {:.4}s",
            out_a.cuts[0]
        );
        assert!(
            (out_a.cuts[1] - 0.80).abs() <= 0.025,
            "6A expected cut[1] near 0.80s (<=25ms), got {:.4}s",
            out_a.cuts[1]
        );

        // 6B: Extreme dense short interval [0.10, 0.22] split into K = 8
        let short_len = (0.12 * fs as f64).round() as usize;
        let short_samples = gen_harmonics(fs, 0.10, short_len, &[(180.0, 0.30), (750.0, 0.20)]);
        let out_b = align_split_boundaries(&AcousticSplitInput {
            samples: &short_samples,
            sample_rate: fs,
            samples_origin_sec: 0.10,
            xmin: 0.10,
            xmax: 0.22,
            granularity: SplitGranularity::Phone,
            duration_weights: &[1.0; 8],
            acoustic_classes: &[AcousticClass::Vowel; 8],
            f0_frames: None,
        });

        assert_eq!(out_b.cuts.len(), 7);
        assert!(out_b.cuts[0] > 0.10, "cut[0] must be > 0.10");
        assert!(
            out_b.cuts.windows(2).all(|w| w[0] < w[1]),
            "cuts must be strictly increasing: {:?}",
            out_b.cuts
        );
        assert!(out_b.cuts[6] < 0.22, "cut[6] must be < 0.22");
    }
}
