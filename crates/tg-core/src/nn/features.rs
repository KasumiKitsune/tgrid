use std::f64::consts::{PI, TAU};

pub const CANONICAL_SAMPLE_RATE: u32 = 16_000;
pub const HOP_SAMPLES: usize = 160;
pub const SUB_HOP_SAMPLES: usize = 80;
pub const WIN_SAMPLES: usize = 400;
pub const N_FFT: usize = 512;
pub const NUM_MEL_BANDS: usize = 24;
pub const FEATURE_DIM: usize = 32;

const SINC_ZERO_CROSSINGS: usize = 16;
const SINC_LUT_PER_ZC: usize = 512;
const SINC_LUT_LEN: usize = SINC_ZERO_CROSSINGS * SINC_LUT_PER_ZC;

fn percentile_f64(vals: &[f64], p: f64) -> f64 {
    if vals.is_empty() {
        return -100.0;
    }
    let mut sorted: Vec<f64> = vals.iter().copied().filter(|v| v.is_finite()).collect();
    if sorted.is_empty() {
        return -100.0;
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

fn build_hann_sinc_lut() -> Vec<f32> {
    let mut lut = vec![0.0f32; SINC_LUT_LEN + 2];
    let n_zc = SINC_ZERO_CROSSINGS as f64;
    for i in 0..=SINC_LUT_LEN {
        let r = (i as f64) / (SINC_LUT_LEN as f64); // in [0.0, 1.0]
        let u = n_zc * r;
        let sinc = if u < 1e-12 {
            1.0
        } else {
            let pu = PI * u;
            pu.sin() / pu
        };
        let win = 0.5 * (1.0 + (PI * r).cos());
        lut[i] = (sinc * win) as f32;
    }
    lut[SINC_LUT_LEN + 1] = 0.0;
    lut
}

/// Remove DC mean (replacing non-finite samples with 0.0) and resample to canonical 16,000 Hz
/// using a fixed-table Hann-Sinc band-limited resampler (fc = min(7600 Hz, 0.45 * fs_in), Nz = 16).
pub fn resample_to_16k(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    if samples.is_empty() || sample_rate == 0 {
        return Vec::new();
    }

    let mut dc_acc = 0.0f64;
    let mut dc_cnt = 0usize;
    for &s in samples {
        if s.is_finite() {
            dc_acc += s as f64;
            dc_cnt += 1;
        }
    }
    let dc_mean = if dc_cnt > 0 {
        (dc_acc / (dc_cnt as f64)) as f32
    } else {
        0.0f32
    };

    let clean: Vec<f32> = samples
        .iter()
        .map(|&s| if s.is_finite() { s - dc_mean } else { 0.0 })
        .collect();

    if sample_rate == CANONICAL_SAMPLE_RATE {
        return clean;
    }

    let fs_in = sample_rate as f64;
    let fs_out = CANONICAL_SAMPLE_RATE as f64;
    let n_in = clean.len();
    let n_out = ((n_in as f64) * fs_out / fs_in).round().max(1.0) as usize;

    let fc = 7600.0_f64.min(0.45 * fs_in);
    let two_fc_norm = 2.0 * fc / fs_in; // sinc argument scale per input sample
    let half_r = (SINC_ZERO_CROSSINGS as f64) / two_fc_norm;
    let half_r_ceil = half_r.ceil() as isize;
    let inv_half_r_lut = (SINC_LUT_LEN as f64) / half_r;
    let step_in = fs_in / fs_out;

    let lut = build_hann_sinc_lut();
    let mut out = vec![0.0f32; n_out];

    for (i, slot) in out.iter_mut().enumerate() {
        let src_pos = (i as f64) * step_in;
        let center = src_pos.floor() as isize;
        let start = (center - half_r_ceil).max(0);
        let end = (center + half_r_ceil).min((n_in as isize) - 1);

        let mut acc = 0.0f64;
        let mut w_sum = 0.0f64;
        for idx in start..=end {
            let dist = (src_pos - (idx as f64)).abs();
            if dist >= half_r {
                continue;
            }
            let lut_pos = dist * inv_half_r_lut;
            let li = lut_pos as usize;
            let frac = lut_pos - (li as f64);
            let w = (lut[li] as f64) * (1.0 - frac) + (lut[li + 1] as f64) * frac;
            acc += (clean[idx as usize] as f64) * w;
            w_sum += w;
        }
        *slot = if w_sum.abs() > 1e-9 {
            (acc / w_sum) as f32
        } else {
            0.0
        };
    }

    out
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

#[inline]
fn hz_to_mel_htk(hz: f64) -> f64 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

#[inline]
fn mel_to_hz_htk(mel: f64) -> f64 {
    700.0 * (10.0_f64.powf(mel / 2595.0) - 1.0)
}

fn build_mel_bank_24() -> Vec<Vec<(usize, f64)>> {
    let half = N_FFT / 2;
    let df = (CANONICAL_SAMPLE_RATE as f64) / (N_FFT as f64);

    let mut g_pre = vec![0.0f64; half + 1];
    for (k, g) in g_pre.iter_mut().enumerate() {
        *g = 1.0 + 0.97 * 0.97 - 2.0 * 0.97 * (TAU * (k as f64) / (N_FFT as f64)).cos();
    }

    let mel_lo = hz_to_mel_htk(60.0);
    let mel_hi = hz_to_mel_htk(7600.0);
    let mut hz_pts = [0.0f64; NUM_MEL_BANDS + 2];
    for (i, pt) in hz_pts.iter_mut().enumerate() {
        let mel = mel_lo + (mel_hi - mel_lo) * (i as f64) / ((NUM_MEL_BANDS + 1) as f64);
        *pt = mel_to_hz_htk(mel);
    }

    let mut bank = Vec::with_capacity(NUM_MEL_BANDS);
    for b in 0..NUM_MEL_BANDS {
        let f_l = hz_pts[b];
        let f_c = hz_pts[b + 1];
        let f_r = hz_pts[b + 2];
        let mut weights = Vec::new();
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
                weights.push((k, w * g_pre[k]));
            }
        }
        if weights.is_empty() {
            let k_nearest = ((f_c / df).round() as usize).clamp(0, half);
            weights.push((k_nearest, g_pre[k_nearest]));
        }
        bank.push(weights);
    }
    bank
}

fn compute_e_ref_per_frame(e_tot: &[f64]) -> Vec<f64> {
    let t_len = e_tot.len();
    if t_len == 0 {
        return Vec::new();
    }
    if t_len <= 1200 {
        let e_ref = percentile_f64(e_tot, 0.95).max(-45.0);
        return vec![e_ref; t_len];
    }

    // Sliding symmetric window [t - 400, t + 400] (8s total), sampled every 20 frames + linear interp
    const STEP: usize = 20;
    const HALF_WIN: usize = 400;
    let mut anchors: Vec<(usize, f64)> = Vec::with_capacity(t_len / STEP + 2);
    let mut t = 0usize;
    while t < t_len {
        let lo = t.saturating_sub(HALF_WIN);
        let hi = (t + HALF_WIN).min(t_len - 1);
        let val = percentile_f64(&e_tot[lo..=hi], 0.95).max(-45.0);
        anchors.push((t, val));
        t += STEP;
    }
    if anchors.last().map(|a| a.0) != Some(t_len - 1) {
        let last = t_len - 1;
        let lo = last.saturating_sub(HALF_WIN);
        let val = percentile_f64(&e_tot[lo..=last], 0.95).max(-45.0);
        anchors.push((last, val));
    }

    let mut out = vec![-45.0f64; t_len];
    for w in anchors.windows(2) {
        let (t0, v0) = w[0];
        let (t1, v1) = w[1];
        let span = (t1 - t0) as f64;
        for idx in t0..=t1 {
            let alpha = if span > 0.0 {
                ((idx - t0) as f64) / span
            } else {
                0.0
            };
            out[idx] = v0 * (1.0 - alpha) + v1 * alpha;
        }
    }
    out
}

#[inline]
fn norm_db(val: f64, e_ref: f64) -> f32 {
    (((val - e_ref).clamp(-55.0, 5.0) + 25.0) / 30.0) as f32
}

/// Extracted 32-dim frame-major features `[T, 32]` at 10 ms hop (100 Hz).
/// Frame `t` covers `[10t ms, 10t + 10ms)` with center `10t + 5ms`.
#[derive(Debug, Clone)]
pub struct AcousticFeatures {
    pub num_frames: usize,
    pub data: Vec<f32>, // length = num_frames * 32
    pub e_tot_db: Vec<f64>,
    pub e_ref_db: Vec<f64>,
}

/// Extract 32-dim features from arbitrary sample-rate mono PCM.
pub fn extract_features(samples: &[f32], sample_rate: u32) -> AcousticFeatures {
    let x16 = resample_to_16k(samples, sample_rate);
    extract_features_from_clean_16k(&x16)
}

/// Extract 32-dim features from DC-removed 16,000 Hz mono PCM.
pub fn extract_features_from_clean_16k(x: &[f32]) -> AcousticFeatures {
    if x.is_empty() {
        return AcousticFeatures {
            num_frames: 0,
            data: Vec::new(),
            e_tot_db: Vec::new(),
            e_ref_db: Vec::new(),
        };
    }

    let n = x.len();
    let t_len = ((n + SUB_HOP_SAMPLES) / HOP_SAMPLES).max(1);
    let half_fft = N_FFT / 2;
    let df = (CANONICAL_SAMPLE_RATE as f64) / (N_FFT as f64);

    // Periodic 25 ms Hann window (400 samples)
    let mut hann = [0.0f32; WIN_SAMPLES];
    let mut s_h = 0.0f64;
    for (i, h) in hann.iter_mut().enumerate() {
        let v = 0.5 - 0.5 * (TAU * (i as f64) / (WIN_SAMPLES as f64)).cos();
        *h = v as f32;
        s_h += v * v;
    }
    let power_norm = 1.0 / ((N_FFT as f64) * s_h);

    let mel_bank = build_mel_bank_24();
    let tot_bins: Vec<usize> = (0..=half_fft)
        .filter(|&k| {
            let f = (k as f64) * df;
            (60.0..=7600.0).contains(&f)
        })
        .collect();

    let mut mel_db = vec![[-100.0f64; NUM_MEL_BANDS]; t_len];
    let mut e_tot = vec![-100.0f64; t_len];
    let mut sub_db = vec![[-100.0f64; 4]; t_len];
    let mut zcr_norm = vec![0.0f32; t_len];

    let sample_at = |idx: isize| -> f32 {
        if idx >= 0 && (idx as usize) < n {
            x[idx as usize]
        } else {
            0.0
        }
    };

    // Dual-real packed radix-2 FFT
    let mut fft_re = [0.0f32; N_FFT];
    let mut fft_im = [0.0f32; N_FFT];
    let mut p_even = [0.0f64; N_FFT / 2 + 1];
    let mut p_odd = [0.0f64; N_FFT / 2 + 1];

    let mut pair_start = 0usize;
    while pair_start < t_len {
        let has_odd = pair_start + 1 < t_len;
        fft_re.fill(0.0);
        fft_im.fill(0.0);

        let c0 = (pair_start * HOP_SAMPLES + SUB_HOP_SAMPLES) as isize;
        let s0 = c0 - (WIN_SAMPLES as isize) / 2;
        for j in 0..WIN_SAMPLES {
            fft_re[j] = sample_at(s0 + j as isize) * hann[j];
        }

        if has_odd {
            let c1 = ((pair_start + 1) * HOP_SAMPLES + SUB_HOP_SAMPLES) as isize;
            let s1 = c1 - (WIN_SAMPLES as isize) / 2;
            for j in 0..WIN_SAMPLES {
                fft_im[j] = sample_at(s1 + j as isize) * hann[j];
            }
        }

        fft_radix2_inplace(&mut fft_re, &mut fft_im);

        p_even[0] = (fft_re[0] as f64).powi(2) * power_norm;
        p_odd[0] = (fft_im[0] as f64).powi(2) * power_norm;
        p_even[half_fft] = (fft_re[half_fft] as f64).powi(2) * power_norm;
        p_odd[half_fft] = (fft_im[half_fft] as f64).powi(2) * power_norm;

        for kb in 1..half_fft {
            let kp = N_FFT - kb;
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

        let mut store_spec = |t_idx: usize, spec: &[f64]| {
            let mut tot_p = 0.0f64;
            for &b in &tot_bins {
                tot_p += spec[b];
            }
            e_tot[t_idx] = 10.0 * (tot_p + 1e-10).log10();
            for (b_idx, weights) in mel_bank.iter().enumerate() {
                let mut ms = 0.0f64;
                for &(bin, w) in weights {
                    ms += w * spec[bin];
                }
                mel_db[t_idx][b_idx] = 10.0 * (ms + 1e-10).log10();
            }
        };

        store_spec(pair_start, &p_even);
        if has_odd {
            store_spec(pair_start + 1, &p_odd);
        }

        pair_start += 2;
    }

    // 5 ms subframes & 25 ms ZCR
    let inv_sub = 1.0 / (SUB_HOP_SAMPLES as f64);
    for t in 0..t_len {
        let base0 = (t * HOP_SAMPLES) as isize;
        let base1 = base0 + (SUB_HOP_SAMPLES as isize);

        let mut e0 = 0.0f64;
        let mut hf0 = 0.0f64;
        for i in 0..SUB_HOP_SAMPLES {
            let cur = sample_at(base0 + i as isize) as f64;
            let prev = sample_at(base0 + i as isize - 1) as f64;
            e0 += cur * cur;
            let d = cur - prev;
            hf0 += d * d;
        }
        let mut e1 = 0.0f64;
        let mut hf1 = 0.0f64;
        for i in 0..SUB_HOP_SAMPLES {
            let cur = sample_at(base1 + i as isize) as f64;
            let prev = sample_at(base1 + i as isize - 1) as f64;
            e1 += cur * cur;
            let d = cur - prev;
            hf1 += d * d;
        }

        sub_db[t][0] = 10.0 * (e0 * inv_sub + 1e-10).log10();
        sub_db[t][1] = 10.0 * (e1 * inv_sub + 1e-10).log10();
        sub_db[t][2] = 10.0 * (hf0 * inv_sub + 1e-10).log10();
        sub_db[t][3] = 10.0 * (hf1 * inv_sub + 1e-10).log10();

        // 25 ms ZCR
        let c = (t * HOP_SAMPLES + SUB_HOP_SAMPLES) as isize;
        let s = c - (WIN_SAMPLES as isize) / 2;
        let mut prev = sample_at(s);
        let mut crossings = 0u32;
        for j in 1..WIN_SAMPLES {
            let cur = sample_at(s + j as isize);
            if (prev >= 0.0 && cur < 0.0) || (prev < 0.0 && cur >= 0.0) {
                crossings += 1;
            }
            prev = cur;
        }
        let zcr = (crossings as f64) / ((WIN_SAMPLES - 1) as f64);
        zcr_norm[t] = (zcr / 0.5).clamp(0.0, 1.0) as f32;
    }

    let e_ref = compute_e_ref_per_frame(&e_tot);

    // 4 kHz decimated autocorrelation voicing (30 ms = 480 samples, decim = 4, n_p = 120)
    const DECIM: usize = 4;
    const N_P: usize = 120;
    const TAU_MIN: usize = 8; // floor(4000 / 450)
    const TAU_MAX: usize = 54; // ceil(4000 / 75)
    let mut u = [0.0f64; N_P];
    let mut voicing = vec![0.0f32; t_len];

    for t in 0..t_len {
        let gate = (e_ref[t] - 40.0).max(-55.0);
        if e_tot[t] <= gate {
            voicing[t] = 0.0;
            continue;
        }
        let center = (t * HOP_SAMPLES + SUB_HOP_SAMPLES) as isize;
        let win_start = center - ((N_P * DECIM) as isize) / 2;
        for (i, slot) in u.iter_mut().enumerate() {
            let base = win_start + (i * DECIM) as isize;
            let acc = (sample_at(base) as f64)
                + (sample_at(base + 1) as f64)
                + (sample_at(base + 2) as f64)
                + (sample_at(base + 3) as f64);
            *slot = acc * 0.25;
        }
        let mut r_max = 0.0f64;
        for tau in TAU_MIN..=TAU_MAX {
            let len = N_P - tau;
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
        voicing[t] = ((r_max - 0.35) / 0.40).clamp(0.0, 1.0) as f32;
    }

    // Assemble final [T, 32] feature matrix
    let mut data = vec![0.0f32; t_len * FEATURE_DIM];
    for t in 0..t_len {
        let row = &mut data[t * FEATURE_DIM..(t + 1) * FEATURE_DIM];
        let er = e_ref[t];
        for b in 0..NUM_MEL_BANDS {
            row[b] = norm_db(mel_db[t][b], er);
        }
        row[24] = norm_db(sub_db[t][0], er);
        row[25] = norm_db(sub_db[t][1], er);
        row[26] = norm_db(sub_db[t][2], er);
        row[27] = norm_db(sub_db[t][3], er);

        // ch[29]: normalized spectral tilt mean(M~[16..24]) - mean(M~[0..6])
        let hi_mean: f32 = row[16..24].iter().sum::<f32>() / 8.0;
        let lo_mean: f32 = row[0..6].iter().sum::<f32>() / 6.0;
        row[29] = (hi_mean - lo_mean).clamp(-1.0, 1.0);

        row[30] = zcr_norm[t];
        row[31] = voicing[t];
    }

    // ch[28]: half-wave rectified positive spectral flux ||max(0, M~_t - M~_{t-1})||_2 / 2.5
    for t in 1..t_len {
        let prev_off = (t - 1) * FEATURE_DIM;
        let cur_off = t * FEATURE_DIM;
        let mut sq = 0.0f32;
        for b in 0..NUM_MEL_BANDS {
            let d = (data[cur_off + b] - data[prev_off + b]).max(0.0);
            sq += d * d;
        }
        data[cur_off + 28] = (sq.sqrt() / 2.5).clamp(0.0, 1.0);
    }

    AcousticFeatures {
        num_frames: t_len,
        data,
        e_tot_db: e_tot,
        e_ref_db: e_ref,
    }
}
