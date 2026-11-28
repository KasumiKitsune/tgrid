"""
Exact Python/NumPy mirror of `crates/tg-core/src/nn/features.rs`.
Used both for parity testing (`max_abs_diff < 1e-5` vs Rust) and as a fast vectorized
fallback when online waveform augmentation is executed in Python during training.
"""
import math
import numpy as np

CANONICAL_SAMPLE_RATE = 16_000
HOP_SAMPLES = 160
SUB_HOP_SAMPLES = 80
WIN_SAMPLES = 400
N_FFT = 512
NUM_MEL_BANDS = 24
FEATURE_DIM = 32

SINC_ZERO_CROSSINGS = 16
SINC_LUT_PER_ZC = 512
SINC_LUT_LEN = SINC_ZERO_CROSSINGS * SINC_LUT_PER_ZC


def _build_hann_sinc_lut() -> np.ndarray:
    idx = np.arange(SINC_LUT_LEN + 2, dtype=np.float64)
    r = np.minimum(idx / float(SINC_LUT_LEN), 1.0)
    u = SINC_ZERO_CROSSINGS * r
    sinc = np.where(u < 1e-12, 1.0, np.sin(np.pi * u) / np.where(u < 1e-12, 1.0, np.pi * u))
    win = 0.5 * (1.0 + np.cos(np.pi * r))
    lut = (sinc * win).astype(np.float32)
    lut[SINC_LUT_LEN + 1] = 0.0
    return lut


_SINC_LUT = _build_hann_sinc_lut()


def _hz_to_mel_htk(hz: float) -> float:
    return 2595.0 * math.log10(1.0 + hz / 700.0)


def _mel_to_hz_htk(mel: float) -> float:
    return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)


def _build_mel_matrix_24() -> tuple[np.ndarray, np.ndarray]:
    half = N_FFT // 2
    df = CANONICAL_SAMPLE_RATE / float(N_FFT)
    k = np.arange(half + 1, dtype=np.float64)
    g_pre = 1.0 + 0.97 * 0.97 - 2.0 * 0.97 * np.cos(2.0 * np.pi * k / float(N_FFT))

    mel_lo = _hz_to_mel_htk(60.0)
    mel_hi = _hz_to_mel_htk(7600.0)
    hz_pts = np.array(
        [_mel_to_hz_htk(mel_lo + (mel_hi - mel_lo) * i / (NUM_MEL_BANDS + 1)) for i in range(NUM_MEL_BANDS + 2)],
        dtype=np.float64,
    )

    freqs = k * df
    mat = np.zeros((NUM_MEL_BANDS, half + 1), dtype=np.float64)
    for b in range(NUM_MEL_BANDS):
        f_l, f_c, f_r = hz_pts[b], hz_pts[b + 1], hz_pts[b + 2]
        w = np.zeros(half + 1, dtype=np.float64)
        mask_l = (freqs >= f_l) & (freqs <= f_c)
        mask_r = (freqs > f_c) & (freqs <= f_r)
        w[mask_l] = (freqs[mask_l] - f_l) / max(f_c - f_l, 1e-9)
        w[mask_r] = (f_r - freqs[mask_r]) / max(f_r - f_c, 1e-9)
        if not np.any(w > 0.0):
            k_near = int(np.clip(round(f_c / df), 0, half))
            mat[b, k_near] = g_pre[k_near]
        else:
            mat[b] = w * g_pre

    tot_mask = (freqs >= 60.0) & (freqs <= 7600.0)
    return mat, tot_mask


_MEL_MAT, _TOT_MASK = _build_mel_matrix_24()
_HANN = (0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(WIN_SAMPLES, dtype=np.float64) / WIN_SAMPLES)).astype(np.float32)
_POWER_NORM = 1.0 / (N_FFT * float(np.sum(_HANN.astype(np.float64) ** 2)))


def _percentile_f64(vals: np.ndarray, p: float) -> float:
    finite = vals[np.isfinite(vals)]
    if finite.size == 0:
        return -100.0
    s = np.sort(finite)
    if s.size == 1:
        return float(s[0])
    pos = np.clip(p, 0.0, 1.0) * (s.size - 1)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    frac = pos - lo
    return float(s[lo] * (1.0 - frac) + s[hi] * frac)


def resample_to_16k(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    arr = np.asarray(samples, dtype=np.float32).reshape(-1)
    if arr.size == 0 or sample_rate <= 0:
        return np.zeros((0,), dtype=np.float32)

    finite_mask = np.isfinite(arr)
    dc_mean = np.float32(np.mean(arr[finite_mask], dtype=np.float64)) if np.any(finite_mask) else np.float32(0.0)
    clean = np.where(finite_mask, arr - dc_mean, np.float32(0.0)).astype(np.float32)

    if sample_rate == CANONICAL_SAMPLE_RATE:
        return clean

    fs_in = float(sample_rate)
    fs_out = float(CANONICAL_SAMPLE_RATE)
    n_in = clean.size
    n_out = max(1, int(round(n_in * fs_out / fs_in)))

    fc = min(7600.0, 0.45 * fs_in)
    two_fc_norm = 2.0 * fc / fs_in
    half_r = SINC_ZERO_CROSSINGS / two_fc_norm
    half_r_ceil = int(math.ceil(half_r))
    inv_half_r_lut = SINC_LUT_LEN / half_r
    step_in = fs_in / fs_out

    # Vectorized over all output samples
    src_pos = np.arange(n_out, dtype=np.float64) * step_in
    centers = np.floor(src_pos).astype(np.int64)
    offsets = np.arange(-half_r_ceil, half_r_ceil + 1, dtype=np.int64)
    idx_mat = centers[:, None] + offsets[None, :]
    valid = (idx_mat >= 0) & (idx_mat < n_in)
    idx_clamped = np.clip(idx_mat, 0, n_in - 1)
    dist = np.abs(src_pos[:, None] - idx_mat.astype(np.float64))
    in_supp = valid & (dist < half_r)

    lut_pos = np.where(in_supp, dist * inv_half_r_lut, 0.0)
    li = lut_pos.astype(np.int64)
    frac = lut_pos - li
    w = np.where(
        in_supp,
        _SINC_LUT[li].astype(np.float64) * (1.0 - frac) + _SINC_LUT[li + 1].astype(np.float64) * frac,
        0.0,
    )
    acc = np.sum(clean[idx_clamped].astype(np.float64) * w, axis=1)
    w_sum = np.sum(w, axis=1)
    out = np.where(np.abs(w_sum) > 1e-9, acc / np.where(np.abs(w_sum) > 1e-9, w_sum, 1.0), 0.0)
    return out.astype(np.float32)


def _compute_e_ref(e_tot: np.ndarray) -> np.ndarray:
    t_len = e_tot.size
    if t_len == 0:
        return np.zeros((0,), dtype=np.float64)
    if t_len <= 1200:
        return np.full((t_len,), max(_percentile_f64(e_tot, 0.95), -45.0), dtype=np.float64)

    step = 20
    half_win = 400
    anchors_t = list(range(0, t_len, step))
    if anchors_t[-1] != t_len - 1:
        anchors_t.append(t_len - 1)
    anchors_v = [
        max(_percentile_f64(e_tot[max(0, t - half_win) : min(t_len, t + half_win + 1)], 0.95), -45.0)
        for t in anchors_t
    ]
    return np.interp(np.arange(t_len, dtype=np.float64), np.array(anchors_t, dtype=np.float64), np.array(anchors_v, dtype=np.float64))


def extract_features_from_clean_16k(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32).reshape(-1)
    n = x.size
    if n == 0:
        return np.zeros((0, FEATURE_DIM), dtype=np.float32)

    t_len = max(1, (n + SUB_HOP_SAMPLES) // HOP_SAMPLES)

    # Pad x on both sides for safe slicing (window 400, voicing 480)
    pad = 320
    x_pad = np.pad(x, (pad, pad + HOP_SAMPLES + WIN_SAMPLES), mode="constant", constant_values=0.0)

    centers = np.arange(t_len, dtype=np.int64) * HOP_SAMPLES + SUB_HOP_SAMPLES + pad
    win_idx = centers[:, None] - (WIN_SAMPLES // 2) + np.arange(WIN_SAMPLES, dtype=np.int64)[None, :]
    frames = x_pad[win_idx]  # [T, 400]

    # STFT power spectrum matching packed dual-real radix-2 FFT
    windowed = frames * _HANN[None, :]
    spec_c = np.fft.rfft(windowed.astype(np.float64), n=N_FFT, axis=1)
    power = (spec_c.real ** 2 + spec_c.imag ** 2) * _POWER_NORM
    power[:, 1:-1] *= 2.0

    e_tot = 10.0 * np.log10(np.sum(power[:, _TOT_MASK], axis=1) + 1e-10)
    mel_p = power @ _MEL_MAT.T
    mel_db = 10.0 * np.log10(mel_p + 1e-10)

    # 5 ms subframes
    base0 = np.arange(t_len, dtype=np.int64) * HOP_SAMPLES + pad
    sub0_idx = base0[:, None] + np.arange(SUB_HOP_SAMPLES, dtype=np.int64)[None, :]
    sub1_idx = base0[:, None] + SUB_HOP_SAMPLES + np.arange(SUB_HOP_SAMPLES, dtype=np.int64)[None, :]

    s0 = x_pad[sub0_idx].astype(np.float64)
    s0_prev = x_pad[sub0_idx - 1].astype(np.float64)
    s1 = x_pad[sub1_idx].astype(np.float64)
    s1_prev = x_pad[sub1_idx - 1].astype(np.float64)

    sub_e0 = 10.0 * np.log10(np.mean(s0 * s0, axis=1) + 1e-10)
    sub_e1 = 10.0 * np.log10(np.mean(s1 * s1, axis=1) + 1e-10)
    sub_hf0 = 10.0 * np.log10(np.mean((s0 - s0_prev) ** 2, axis=1) + 1e-10)
    sub_hf1 = 10.0 * np.log10(np.mean((s1 - s1_prev) ** 2, axis=1) + 1e-10)

    # 25 ms ZCR
    sign_change = ((frames[:, :-1] >= 0.0) & (frames[:, 1:] < 0.0)) | ((frames[:, :-1] < 0.0) & (frames[:, 1:] >= 0.0))
    zcr = np.sum(sign_change, axis=1, dtype=np.float64) / float(WIN_SAMPLES - 1)
    zcr_norm = np.clip(zcr / 0.5, 0.0, 1.0).astype(np.float32)

    e_ref = _compute_e_ref(e_tot)

    # 4 kHz decimated autocorrelation voicing (win=480, decim=4, n_p=120, tau=8..54)
    n_p = 120
    decim = 4
    v_win_idx = centers[:, None] - (n_p * decim) // 2 + np.arange(n_p * decim, dtype=np.int64)[None, :]
    u = np.mean(x_pad[v_win_idx].astype(np.float64).reshape(t_len, n_p, decim), axis=2)

    gate = np.maximum(e_ref - 40.0, -55.0)
    active_v = e_tot > gate
    voicing = np.zeros((t_len,), dtype=np.float32)
    if np.any(active_v):
        ua = u[active_v]
        # Exact FFT autocorrelation for tau=8..54 (mathematically identical to direct loop, ~6x faster)
        spec_u = np.fft.rfft(ua, n=256, axis=1)
        acf = np.fft.irfft(spec_u * np.conj(spec_u), n=256, axis=1)[:, 8:55]
        sq = ua * ua
        cs = np.concatenate([np.zeros((ua.shape[0], 1), dtype=np.float64), np.cumsum(sq, axis=1)], axis=1)
        taus = np.arange(8, 55, dtype=np.int64)
        e1 = cs[:, n_p - taus]
        e2 = cs[:, n_p : n_p + 1] - cs[:, taus]
        r_max = np.max(acf / np.sqrt(e1 * e2 + 1e-12), axis=1)
        voicing[active_v] = np.clip((r_max - 0.35) / 0.40, 0.0, 1.0).astype(np.float32)

    # Normalize dB channels
    def _norm(v: np.ndarray) -> np.ndarray:
        return ((np.clip(v - e_ref[:, None] if v.ndim == 2 else v - e_ref, -55.0, 5.0) + 25.0) / 30.0).astype(np.float32)

    feats = np.zeros((t_len, FEATURE_DIM), dtype=np.float32)
    feats[:, 0:24] = _norm(mel_db)
    feats[:, 24] = _norm(sub_e0)
    feats[:, 25] = _norm(sub_e1)
    feats[:, 26] = _norm(sub_hf0)
    feats[:, 27] = _norm(sub_hf1)

    if t_len > 1:
        diff = np.maximum(0.0, feats[1:, 0:24] - feats[:-1, 0:24])
        feats[1:, 28] = np.clip(np.sqrt(np.sum(diff * diff, axis=1)) / 2.5, 0.0, 1.0)

    hi_mean = np.mean(feats[:, 16:24], axis=1)
    lo_mean = np.mean(feats[:, 0:6], axis=1)
    feats[:, 29] = np.clip(hi_mean - lo_mean, -1.0, 1.0)
    feats[:, 30] = zcr_norm
    feats[:, 31] = voicing
    return feats


def extract_features(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    x16 = resample_to_16k(samples, sample_rate)
    return extract_features_from_clean_16k(x16)
