use std::f64::consts::PI;

/// In-place radix-2 Cooley-Tukey FFT. `re.len()` and `im.len()` must be equal powers of two.
pub fn fft_in_place(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    debug_assert_eq!(n, im.len());
    debug_assert!(n.is_power_of_two());

    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while (j & bit) != 0 {
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
        let ang = (-2.0 * PI) / (len as f64);
        let w_re = ang.cos();
        let w_im = ang.sin();
        let mut i = 0usize;
        while i < n {
            let mut cur_re = 1.0_f64;
            let mut cur_im = 0.0_f64;
            for k in 0..half {
                let a = i + k;
                let b = a + half;
                let u_re = re[a];
                let u_im = im[a];
                let v_re = re[b] * cur_re - im[b] * cur_im;
                let v_im = re[b] * cur_im + im[b] * cur_re;
                re[a] = u_re + v_re;
                im[a] = u_im + v_im;
                re[b] = u_re - v_re;
                im[b] = u_im - v_im;
                let n_re = cur_re * w_re - cur_im * w_im;
                cur_im = cur_re * w_im + cur_im * w_re;
                cur_re = n_re;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// Praat-style +6 dB/octave pre-emphasis above 50 Hz.
pub fn pre_emphasis(raw: &[f32], sample_rate: u32) -> Vec<f32> {
    let len = raw.len();
    if len == 0 {
        return Vec::new();
    }
    let alpha = ((-2.0 * PI * 50.0) / (sample_rate as f64)).exp() as f32;
    let mut pre = vec![0.0_f32; len];
    pre[0] = raw[0];
    for i in 1..len {
        pre[i] = raw[i] - alpha * raw[i - 1];
    }
    pre
}

/// Broadband Gaussian analysis window matching Praat spectrogram defaults.
pub fn build_gaussian_window(sample_rate: u32) -> (usize, usize, Vec<f64>) {
    let fft_size = if sample_rate <= 24_000 { 512 } else { 1024 };
    let half_win = ((sample_rate as f64) * 0.006)
        .round()
        .max(16.0)
        .min(((fft_size >> 1) - 1) as f64) as usize;
    let win_len = half_win * 2 + 1;
    let sigma = (sample_rate as f64) * 0.0021;
    let mut g_win = Vec::with_capacity(win_len);
    for k in 0..win_len {
        let d = (k as f64 - half_win as f64) / sigma;
        g_win.push((-0.5 * d * d).exp());
    }
    (fft_size, half_win, g_win)
}
