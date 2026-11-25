use crate::analysis::AudioAnalysis;
use crate::fft::fft_in_place;
use tg_core::model::LinearSeg;

/// Compute normalized STFT spectrogram grid (`[0.0, 1.0]`, row-major `rows * cols`) for a band's segments.
#[allow(clippy::too_many_arguments)]
pub fn compute_spectrogram_grid(
    analysis: &AudioAnalysis,
    segs: &[LinearSeg],
    band_origin_x: f64,
    band_content_w: f64,
    max_freq: f64,
    cols: usize,
    rows: usize,
    dyn_range: f64,
    smooth: bool,
) -> Vec<f32> {
    let mut values = vec![0.0_f32; cols * rows];
    if cols < 2 || rows < 2 || band_content_w <= 0.0 || analysis.pre.is_empty() {
        return values;
    }

    let mut col_active = vec![false; cols];
    let sr = analysis.sample_rate as f64;
    let len = analysis.pre.len() as isize;
    let fft_size = analysis.fft_size;
    let half_win = analysis.half_win as isize;
    let win_len = analysis.g_win.len();
    let min_db = analysis.spec_max_db - dyn_range;
    let nyq_freq = sr * 0.5;
    let bin_per_hz = fft_size as f64 / sr;
    let nyq_bin = fft_size >> 1;

    let mut re = vec![0.0_f64; fft_size];
    let mut im = vec![0.0_f64; fft_size];
    let denom_r = (rows - 1).max(1) as f64;
    let row_valid: Vec<bool> = (0..rows)
        .map(|r| (1.0 - r as f64 / denom_r) * max_freq <= nyq_freq)
        .collect();

    for seg in segs {
        if seg.collapsed {
            continue;
        }
        let dt = seg.t1 - seg.t0;
        let seg_w = seg.x1 - seg.x0;
        if dt <= 0.0 || seg_w <= 0.0 {
            continue;
        }
        let c_start = (((seg.x0 - band_origin_x) / band_content_w) * cols as f64)
            .floor()
            .max(0.0) as usize;
        let c_end = ((((seg.x1 - band_origin_x) / band_content_w) * cols as f64).ceil() as isize)
            .clamp(0, (cols - 1) as isize) as usize;

        for c in c_start..=c_end {
            let x_world = band_origin_x + ((c as f64 + 0.5) / cols as f64) * band_content_w;
            if x_world < seg.x0 || x_world > seg.x1 {
                continue;
            }
            let frac = ((x_world - seg.x0) / seg_w).clamp(0.0, 1.0);
            let t = seg.t0 + frac * dt;
            let center = ((t - analysis.offset) * sr).round() as isize;
            if center < 0 || center >= len {
                continue;
            }
            col_active[c] = true;

            re.fill(0.0);
            im.fill(0.0);
            for k in 0..win_len {
                let idx = center - half_win + k as isize;
                if idx >= 0 && idx < len {
                    re[k] = (analysis.pre[idx as usize] as f64) * analysis.g_win[k];
                }
            }
            fft_in_place(&mut re, &mut im);

            for r in 0..rows {
                if !row_valid[r] {
                    continue;
                }
                let freq = (1.0 - r as f64 / denom_r) * max_freq;
                let f_bin = freq * bin_per_hz;
                let b0 = (f_bin.floor().max(0.0) as usize).min(nyq_bin);
                let b1 = (b0 + 1).min(nyq_bin);
                let frac_b = (f_bin - b0 as f64).clamp(0.0, 1.0);
                let p0 = re[b0] * re[b0] + im[b0] * im[b0];
                let p1 = re[b1] * re[b1] + im[b1] * im[b1];
                let mag_sq = p0 + (p1 - p0) * frac_b;
                let db = if mag_sq > 1e-18 {
                    10.0 * mag_sq.log10()
                } else {
                    -180.0
                };
                let norm = (db - min_db) / dyn_range;
                if norm <= 0.0 {
                    continue;
                }
                values[r * cols + c] = norm.min(1.0).powf(0.92) as f32;
            }
        }
    }

    if smooth {
        let mut tmp = vec![0.0_f32; cols * rows];
        for r in 0..rows {
            let row_off = r * cols;
            for c in 0..cols {
                if !col_active[c] {
                    continue;
                }
                let v_c = values[row_off + c];
                let v_l = if c > 0 && col_active[c - 1] {
                    values[row_off + c - 1]
                } else {
                    v_c
                };
                let v_r = if c + 1 < cols && col_active[c + 1] {
                    values[row_off + c + 1]
                } else {
                    v_c
                };
                tmp[row_off + c] = 0.25 * v_l + 0.5 * v_c + 0.25 * v_r;
            }
        }
        for r in 0..rows {
            let r_cur = r * cols;
            if !row_valid[r] {
                for c in 0..cols {
                    values[r_cur + c] = 0.0;
                }
                continue;
            }
            let r_up_idx = if r > 0 && row_valid[r - 1] { r - 1 } else { r };
            let r_dn_idx = if r + 1 < rows && row_valid[r + 1] { r + 1 } else { r };
            let r_up = r_up_idx * cols;
            let r_dn = r_dn_idx * cols;
            for c in 0..cols {
                if !col_active[c] {
                    values[r_cur + c] = 0.0;
                    continue;
                }
                values[r_cur + c] =
                    0.25 * tmp[r_up + c] + 0.5 * tmp[r_cur + c] + 0.25 * tmp[r_dn + c];
            }
        }
    }

    values
}

/// High-resolution RGBA spectrogram rasterizer (`1x`–`6x`) for both `warm` and `bw` palettes.
/// Returns `(px_w, px_h, rgba_bytes)`.
#[allow(clippy::too_many_arguments)]
pub fn render_spectrogram_rgba(
    analysis: &AudioAnalysis,
    segs: &[LinearSeg],
    band_origin_x: f64,
    band_content_w: f64,
    spec_h: f64,
    max_freq: f64,
    scale: f64,
    dyn_range: f64,
    palette_key: &str,
) -> (u32, u32, Vec<u8>) {
    if band_content_w < 2.0 || spec_h < 4.0 || analysis.pre.is_empty() {
        return (0, 0, Vec::new());
    }
    let eff_scale = scale.clamp(0.5, 6.0);
    let px_w = (band_content_w * eff_scale).round().max(2.0) as usize;
    let px_h = (spec_h * eff_scale).round().max(4.0) as usize;
    let mut rgba = vec![255u8; px_w * px_h * 4]; // Pure white paper baseline

    let sr = analysis.sample_rate as f64;
    let len = analysis.pre.len() as isize;
    let fft_size = analysis.fft_size;
    let half_win = analysis.half_win as isize;
    let win_len = analysis.g_win.len();
    let min_db = analysis.spec_max_db - dyn_range;
    let nyq_freq = sr * 0.5;
    let bin_per_hz = fft_size as f64 / sr;
    let nyq_bin = fft_size >> 1;
    let is_bw = palette_key.eq_ignore_ascii_case("bw");

    let mut re = vec![0.0_f64; fft_size];
    let mut im = vec![0.0_f64; fft_size];
    let denom_y = (px_h - 1).max(1) as f64;

    for seg in segs {
        if seg.collapsed {
            continue;
        }
        let dt = seg.t1 - seg.t0;
        if dt <= 0.0 {
            continue;
        }
        let col_start = (((seg.x0 - band_origin_x) * eff_scale).floor().max(0.0)) as usize;
        let col_end = ((((seg.x1 - band_origin_x) * eff_scale).ceil() as isize)
            .clamp(0, (px_w - 1) as isize)) as usize;
        let span_px = ((seg.x1 - seg.x0) * eff_scale).max(1.0);

        for x in col_start..=col_end {
            let frac = ((x as f64 - (seg.x0 - band_origin_x) * eff_scale) / span_px).clamp(0.0, 1.0);
            let t = seg.t0 + frac * dt;
            let center = ((t - analysis.offset) * sr).round() as isize;
            if center < 0 || center >= len {
                continue;
            }

            re.fill(0.0);
            im.fill(0.0);
            for k in 0..win_len {
                let idx = center - half_win + k as isize;
                if idx >= 0 && idx < len {
                    re[k] = (analysis.pre[idx as usize] as f64) * analysis.g_win[k];
                }
            }
            fft_in_place(&mut re, &mut im);

            for y in 0..px_h {
                let freq = (1.0 - y as f64 / denom_y) * max_freq;
                if freq > nyq_freq {
                    continue;
                }
                let f_bin = freq * bin_per_hz;
                let b0 = (f_bin.floor().max(0.0) as usize).min(nyq_bin);
                let b1 = (b0 + 1).min(nyq_bin);
                let frac_b = (f_bin - b0 as f64).clamp(0.0, 1.0);
                let p0 = re[b0] * re[b0] + im[b0] * im[b0];
                let p1 = re[b1] * re[b1] + im[b1] * im[b1];
                let mag_sq = p0 + (p1 - p0) * frac_b;
                let db = if mag_sq > 1e-18 {
                    10.0 * mag_sq.log10()
                } else {
                    -180.0
                };
                let norm = (db - min_db) / dyn_range;
                if norm <= 0.0 {
                    continue;
                }
                let n = norm.min(1.0).powf(0.92);
                let p_idx = (y * px_w + x) * 4;
                if is_bw {
                    let g = (255.0 - n * 255.0).round() as u8;
                    rgba[p_idx] = g;
                    rgba[p_idx + 1] = g;
                    rgba[p_idx + 2] = g;
                    rgba[p_idx + 3] = 255;
                } else {
                    // Warm charcoal grayscale (#FFFFFF -> #141413)
                    rgba[p_idx] = (255.0 - n * 235.0).round() as u8;
                    rgba[p_idx + 1] = (255.0 - n * 235.0).round() as u8;
                    rgba[p_idx + 2] = (255.0 - n * 236.0).round() as u8;
                    rgba[p_idx + 3] = 255;
                }
            }
        }
    }

    (px_w as u32, px_h as u32, rgba)
}
