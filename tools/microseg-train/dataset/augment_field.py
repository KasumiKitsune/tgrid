"""
9 Fieldwork-Targeted Acoustic Augmentations for TGrid-AcouSeg 1.0:
  1. Hard-Negative Adjacency (breath / paper rustle prepended 20-120 ms before speech, p=0.35)
  2. Close-Mic Plosive Pop (20-110 Hz damped low-freq impulse, p=0.25)
  3. 50/60 Hz Mains Hum + 2nd/3rd harmonics (SNR 10-25 dB, p=0.25)
  4. RIR Room Reverb Convolution with direct-path peak alignment (p=0.30)
  5. Creaky Voice / Glottalization pulse modulation on vowels (p=0.20)
  6. Off-axis HF roll-off (-6..-15 dB above 3 kHz) & 8 kHz narrowband degradation (p=0.25)
  7. Speed Perturbation alpha in [0.78, 1.28] with exact boundary timestamp scaling (p=0.30)
  8. Weak Breathy / Whisper Positive Speech Branch (F0/low-freq attenuation + speech-envelope
     HF aspiration excitation + low level -28..-42 dBFS, p=0.18, strictly preserving vad=1 & boundaries)
  9. Isolated Single-Syllable / Plosive / Fricative / Whisper Positive Clips (`build_isolated_token_clip`)

Plus pure non-speech hard-negative waveform synthesis / ESC-50 sampling (15% of training chunks).
"""
from __future__ import annotations

import math
from typing import List, Optional, Tuple
import numpy as np
from scipy import signal

SR = 16_000


def synth_breath(rng: np.random.Generator, dur_sec: float, amp: float = 0.06) -> np.ndarray:
    """Synthetic realistic inhalation / exhalation breath noise (band-shaped 400-3500 Hz)."""
    n = max(160, int(round(dur_sec * SR)))
    w = rng.standard_normal(n).astype(np.float64)
    sos = signal.butter(3, [350.0, 3400.0], btype="bandpass", fs=SR, output="sos")
    b = signal.sosfilt(sos, w)
    # Smooth rise-fall envelope
    t = np.linspace(0.0, 1.0, n)
    env = np.sin(np.pi * t) ** 1.4
    b = b * env
    rms = np.sqrt(np.mean(b * b) + 1e-12)
    return (b * (amp / rms)).astype(np.float32)


def synth_paper_rustle(rng: np.random.Generator, dur_sec: float, amp: float = 0.05) -> np.ndarray:
    """Synthetic wordlist page-turn / paper friction noise (high-passed crackling bursts)."""
    n = max(160, int(round(dur_sec * SR)))
    w = rng.standard_normal(n).astype(np.float64)
    sos = signal.butter(3, 1800.0, btype="highpass", fs=SR, output="sos")
    hp = signal.sosfilt(sos, w)
    # Modulate with random crackle envelope
    n_knots = max(4, int(dur_sec * 35))
    knots = rng.uniform(0.1, 1.0, size=n_knots) ** 2.2
    env = np.interp(np.linspace(0, n_knots - 1, n), np.arange(n_knots), knots)
    env *= np.hanning(n)
    p = hp * env
    rms = np.sqrt(np.mean(p * p) + 1e-12)
    return (p * (amp / rms)).astype(np.float32)


def synth_mic_pop(rng: np.random.Generator, dur_sec: float = 0.055, amp: float = 0.25) -> np.ndarray:
    """Close-mic plosive pop: 20-110 Hz exponentially damped impulse."""
    n = max(160, int(round(dur_sec * SR)))
    t = np.arange(n, dtype=np.float64) / SR
    f0 = rng.uniform(25.0, 95.0)
    tau = rng.uniform(0.012, 0.032)
    pop = np.sin(2.0 * np.pi * f0 * t) * np.exp(-t / tau) * (1.0 - np.exp(-t / 0.002))
    mx = np.max(np.abs(pop)) + 1e-12
    return (pop * (amp / mx)).astype(np.float32)


def add_mains_hum(x: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    n = len(x)
    t = np.arange(n, dtype=np.float64) / SR
    f0 = 50.0 if rng.random() < 0.65 else 60.0
    p1, p2, p3 = rng.uniform(0, 2 * np.pi, size=3)
    hum = (
        1.0 * np.sin(2.0 * np.pi * f0 * t + p1)
        + rng.uniform(0.2, 0.5) * np.sin(2.0 * np.pi * 2 * f0 * t + p2)
        + rng.uniform(0.1, 0.35) * np.sin(2.0 * np.pi * 3 * f0 * t + p3)
    )
    sig_rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2) + 1e-10))
    hum_rms = float(np.sqrt(np.mean(hum * hum) + 1e-10))
    snr_db = rng.uniform(10.0, 26.0)
    scale = sig_rms / (hum_rms * (10.0 ** (snr_db / 20.0)))
    return (x + (hum * scale).astype(np.float32)).astype(np.float32)


def apply_rir_aligned(x: np.ndarray, rir: np.ndarray) -> np.ndarray:
    """Convolve with RIR after aligning direct-path peak to index 0 so timestamps stay exact."""
    r = rir.astype(np.float64)
    if r.size < 8:
        return x
    peak = int(np.argmax(np.abs(r)))
    r = r[peak:]
    norm = np.sqrt(np.sum(r * r) + 1e-12)
    if norm > 1e-6:
        r = r / norm
    y = signal.fftconvolve(x.astype(np.float64), r, mode="full")[: len(x)]
    # Match RMS so level doesn't shift wildly
    x_rms = np.sqrt(np.mean(x.astype(np.float64) ** 2) + 1e-10)
    y_rms = np.sqrt(np.mean(y * y) + 1e-10)
    return (y * (x_rms / y_rms)).astype(np.float32)


def synth_room_rir(rng: np.random.Generator) -> np.ndarray:
    """Lightweight synthetic room impulse response (RT60 0.15-0.65s) fallback when RIRS_NOISES unavailable."""
    rt60 = rng.uniform(0.15, 0.65)
    n = int(round(rt60 * SR))
    t = np.arange(n, dtype=np.float64) / SR
    decay = np.exp(-6.907755 * t / rt60)
    rir = rng.standard_normal(n) * decay * 0.25
    rir[0] = 1.0
    return rir.astype(np.float32)


def apply_creaky_modulation(x: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Simulate creaky voice / glottalization (period-doubling / irregular sub-harmonic dips)."""
    y = x.copy()
    n = len(y)
    if n < 3200:
        return y
    # Pick 1-2 short 120-350ms regions
    for _ in range(int(rng.integers(1, 3))):
        dur = int(rng.uniform(0.10, 0.32) * SR)
        if dur >= n:
            continue
        start = int(rng.integers(0, n - dur))
        t = np.arange(dur, dtype=np.float64) / SR
        f_creak = rng.uniform(28.0, 58.0)
        depth = rng.uniform(0.45, 0.78)
        mod = (1.0 - depth) + depth * (0.5 + 0.5 * np.cos(2.0 * np.pi * f_creak * t)) ** 3.0
        y[start : start + dur] *= mod.astype(np.float32)
    return y


def apply_band_degrade(x: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Off-axis HF roll-off (-6..-15 dB > 3kHz) or 8 kHz narrowband telephone/tape degradation."""
    if rng.random() < 0.35:
        # 8 kHz narrowband roundtrip
        sos = signal.butter(4, 3600.0, btype="lowpass", fs=SR, output="sos")
        return signal.sosfiltfilt(sos, x.astype(np.float64)).astype(np.float32)
    else:
        # Gentle HF shelf roll-off via lowpass blend
        cutoff = rng.uniform(2600.0, 4200.0)
        sos = signal.butter(2, cutoff, btype="lowpass", fs=SR, output="sos")
        lp = signal.sosfilt(sos, x.astype(np.float64))
        mix = rng.uniform(0.50, 0.85)
        return (mix * lp + (1.0 - mix) * x.astype(np.float64)).astype(np.float32)


def apply_whisper_breathy(x: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """
    Simulate weak breathy / whispered speech while preserving exact phonetic timing & vad=1:
      - Attenuate low-frequency fundamental (F0 < 400-650 Hz) to weaken glottal periodicity
      - Modulate gentle bandpass HF aspiration noise with the speech's own 15ms amplitude envelope
        so formant structure and phone transitions stay intact
      - Scale overall RMS to low level (-28 to -42 dBFS) with optional very faint room floor
    """
    xf = x.astype(np.float64)
    n = len(xf)
    if n < 320:
        return x

    # 1. Attenuate low-frequency fundamental (< 400..650 Hz)
    hp_cut = float(rng.uniform(380.0, 650.0))
    sos_hp = signal.butter(2, hp_cut, btype="highpass", fs=SR, output="sos")
    x_hp = signal.sosfiltfilt(sos_hp, xf)
    # Keep a small fraction of original low band (0.05..0.28): near-pure whisper vs soft breathy voice
    low_keep = float(rng.uniform(0.05, 0.28))
    base = x_hp + low_keep * (xf - x_hp)

    # 2. Speech-envelope-modulated HF breathy aspiration excitation (zero phase shift)
    win = 240  # 15 ms moving RMS envelope
    kernel = np.ones(win, dtype=np.float64) / float(win)
    env = np.sqrt(np.convolve(xf * xf, kernel, mode="same") + 1e-10)
    w = rng.standard_normal(n)
    sos_bp = signal.butter(2, [700.0, 5600.0], btype="bandpass", fs=SR, output="sos")
    hf_noise = signal.sosfilt(sos_bp, w)
    hf_rms = float(np.sqrt(np.mean(hf_noise * hf_noise) + 1e-12))
    asp = (hf_noise / hf_rms) * env

    asp_mix = float(rng.uniform(0.18, 0.45))
    y = base + asp_mix * asp

    # 3. Low-level target gain in [-42, -28] dBFS
    y_rms = float(np.sqrt(np.mean(y * y) + 1e-12))
    target_db = float(rng.uniform(-42.0, -28.0))
    target_rms = 10.0 ** (target_db / 20.0)
    y = y * (target_rms / y_rms)

    # Optional faint room floor (-62..-50 dBFS, always >= 10 dB below whisper speech)
    if rng.random() < 0.50:
        floor_db = min(target_db - float(rng.uniform(10.0, 20.0)), -50.0)
        floor_rms = 10.0 ** (floor_db / 20.0)
        y = y + rng.standard_normal(n) * floor_rms

    return np.clip(y, -0.99, 0.99).astype(np.float32)


def speed_perturb(
    x: np.ndarray,
    phones: List[Tuple[float, float, str]],
    syllables: Optional[List[Tuple[float, float, str]]],
    alpha: float,
) -> Tuple[np.ndarray, List[Tuple[float, float, str]], Optional[List[Tuple[float, float, str]]]]:
    """Resample waveform by factor alpha (>1 faster, <1 slower) and scale timestamps t -> t / alpha."""
    new_len = max(160, int(round(len(x) / alpha)))
    old_idx = np.linspace(0.0, len(x) - 1, new_len, dtype=np.float64)
    y = np.interp(old_idx, np.arange(len(x), dtype=np.float64), x.astype(np.float64)).astype(np.float32)
    p_new = [(ts / alpha, te / alpha, lbl) for (ts, te, lbl) in phones]
    s_new = [(ts / alpha, te / alpha, lbl) for (ts, te, lbl) in syllables] if syllables is not None else None
    return y, p_new, s_new


def augment_utterance(
    x: np.ndarray,
    phones: List[Tuple[float, float, str]],
    syllables: Optional[List[Tuple[float, float, str]]],
    rng: np.random.Generator,
    noise_pool: Optional[List[np.ndarray]] = None,
    rir_pool: Optional[List[np.ndarray]] = None,
) -> Tuple[np.ndarray, List[Tuple[float, float, str]], Optional[List[Tuple[float, float, str]]]]:
    """Apply randomized subset of fieldwork & whisper augmentations while keeping boundaries exact."""
    y = x.astype(np.float32).copy()
    ph = list(phones)
    sy = list(syllables) if syllables is not None else None

    # 7. Speed perturbation (p=0.30)
    if rng.random() < 0.30:
        alpha = float(rng.uniform(0.78, 1.28))
        y, ph, sy = speed_perturb(y, ph, sy, alpha)

    # 1. Hard-Negative Adjacency: prepend breath/paper 20-120ms before utterance (p=0.35)
    if rng.random() < 0.35:
        neg_dur = float(rng.uniform(0.12, 0.38))
        gap_dur = float(rng.uniform(0.02, 0.12))
        sig_rms = float(np.sqrt(np.mean(y * y) + 1e-8))
        neg_amp = sig_rms * float(rng.uniform(0.18, 0.65))
        neg = synth_breath(rng, neg_dur, neg_amp) if rng.random() < 0.55 else synth_paper_rustle(rng, neg_dur, neg_amp)
        gap = np.zeros(int(round(gap_dur * SR)), dtype=np.float32)
        shift = (len(neg) + len(gap)) / float(SR)
        y = np.concatenate([neg, gap, y])
        ph = [(0.0, shift, "sil")] + [(ts + shift, te + shift, lbl) for (ts, te, lbl) in ph]
        if sy is not None:
            sy = [(0.0, shift, "")] + [(ts + shift, te + shift, lbl) for (ts, te, lbl) in sy]

    # 4. RIR room reverb (p=0.30)
    if rng.random() < 0.30:
        rir = rir_pool[int(rng.integers(0, len(rir_pool)))] if rir_pool else synth_room_rir(rng)
        y = apply_rir_aligned(y, rir)

    # 5. Creaky voice modulation (p=0.20)
    if rng.random() < 0.20:
        y = apply_creaky_modulation(y, rng)

    # 6. Off-axis HF roll-off / 8 kHz narrowband (p=0.25)
    if rng.random() < 0.25:
        y = apply_band_degrade(y, rng)

    # 8. Weak Breathy / Whisper Positive Speech Branch (p=0.18)
    # Strictly preserves vad=1 and exact boundary timestamps; trains whisper VAD recall!
    is_whisper = rng.random() < 0.18
    if is_whisper:
        y = apply_whisper_breathy(y, rng)

    # 2. Close-mic plosive pop (p=0.25; skip on whisper clips so whisper level stays realistic)
    if (not is_whisper) and rng.random() < 0.25 and len(y) > 1600:
        sig_rms = float(np.sqrt(np.mean(y * y) + 1e-8))
        pop = synth_mic_pop(rng, dur_sec=float(rng.uniform(0.03, 0.08)), amp=sig_rms * float(rng.uniform(0.8, 2.5)))
        pos = int(rng.integers(0, max(1, len(y) - len(pop))))
        y[pos : pos + len(pop)] += pop

    # 3. 50/60 Hz mains hum (p=0.25; also applies to whisper at realistic SNR so whisper+hum works!)
    if rng.random() < 0.25:
        y = add_mains_hum(y, rng)

    # Additive background noise from ESC-50 pool or white noise (p=0.45, gentler SNR for whisper)
    if rng.random() < 0.45:
        sig_rms = float(np.sqrt(np.mean(y * y) + 1e-8))
        if noise_pool:
            nz = noise_pool[int(rng.integers(0, len(noise_pool)))]
            if len(nz) >= len(y):
                off = int(rng.integers(0, len(nz) - len(y) + 1))
                nz_seg = nz[off : off + len(y)]
            else:
                reps = int(math.ceil(len(y) / max(1, len(nz))))
                nz_seg = np.tile(nz, reps)[: len(y)]
        else:
            nz_seg = rng.standard_normal(len(y)).astype(np.float32)
        nz_rms = float(np.sqrt(np.mean(nz_seg.astype(np.float64) ** 2) + 1e-10))
        snr_db = float(rng.uniform(12.0, 28.0) if is_whisper else rng.uniform(8.0, 28.0))
        scale = sig_rms / (nz_rms * (10.0 ** (snr_db / 20.0)))
        y = (y + nz_seg * scale).astype(np.float32)

    # Random gain scaling: keep whisper clips at their genuine low level (-42..-28 dBFS),
    # and widen normal speech down to -32..-8 dBFS so bounded peak-ref norm sees full dynamic range.
    if not is_whisper:
        y_rms = float(np.sqrt(np.mean(y.astype(np.float64) ** 2) + 1e-10))
        target_rms = 10.0 ** (float(rng.uniform(-32.0, -8.0)) / 20.0)
        y = np.clip(y * (target_rms / y_rms), -0.99, 0.99).astype(np.float32)
    else:
        y = np.clip(y, -0.99, 0.99).astype(np.float32)

    return y, ph, sy


def generate_pure_negative_clip(
    dur_sec: float,
    rng: np.random.Generator,
    noise_pool: Optional[List[np.ndarray]] = None,
) -> np.ndarray:
    """
    Generate a pure non-speech hard-negative clip (SIL, vad=0) for Tier-3 training.
    Prioritizes genuine ESC-50 environmental noise, mains hum, stationary noise, and gentle
    room tone; avoids isolated short high-ZCR synthetic bursts that acoustically collide
    with isolated single-syllable plosive/fricative/whispered speech tokens.
    """
    n = int(round(dur_sec * SR))
    kind = rng.random()
    if kind < 0.45 and noise_pool:
        nz = noise_pool[int(rng.integers(0, len(noise_pool)))]
        if len(nz) >= n:
            off = int(rng.integers(0, len(nz) - n + 1))
            y = nz[off : off + n].copy()
        else:
            reps = int(math.ceil(n / max(1, len(nz))))
            y = np.tile(nz, reps)[:n].copy()
        target_rms = 10.0 ** (float(rng.uniform(-50.0, -20.0)) / 20.0)
        rms = float(np.sqrt(np.mean(y.astype(np.float64) ** 2) + 1e-10))
        y = (y * (target_rms / rms)).astype(np.float32)
    elif kind < 0.62:
        # Gentle background room tone with low-level continuous breath / subtle low-freq rumble
        y = (rng.standard_normal(n) * 10.0 ** (float(rng.uniform(-60.0, -38.0)) / 20.0)).astype(np.float32)
        for _ in range(int(rng.integers(1, 3))):
            ev_type = rng.random()
            if ev_type < 0.50:
                ev = synth_breath(rng, float(rng.uniform(0.35, 0.85)), float(rng.uniform(0.004, 0.025)))
            elif ev_type < 0.75:
                ev = synth_paper_rustle(rng, float(rng.uniform(0.25, 0.65)), float(rng.uniform(0.004, 0.020)))
            else:
                ev = synth_mic_pop(rng, float(rng.uniform(0.04, 0.08)), float(rng.uniform(0.02, 0.10)))
            pos = int(rng.integers(0, max(1, n - len(ev))))
            y[pos : pos + len(ev)] += ev[: n - pos]
    elif kind < 0.85:
        # Pure stationary white/pink noise + optional 50/60 Hz mains hum (for low-SNR / noise rejection)
        amp = 10.0 ** (float(rng.uniform(-65.0, -16.0)) / 20.0)
        y = (rng.standard_normal(n) * amp).astype(np.float32)
        if rng.random() < 0.55:
            y = add_mains_hum(y, rng)
    else:
        # Near-digital silence (-75 to -50 dBFS)
        amp = 10.0 ** (float(rng.uniform(-75.0, -50.0)) / 20.0)
        y = (rng.standard_normal(n) * amp).astype(np.float32)

    return np.clip(y, -0.99, 0.99).astype(np.float32)


def build_isolated_token_clip(
    x: np.ndarray,
    phones: List[Tuple[float, float, str]],
    syllables: Optional[List[Tuple[float, float, str]]],
    rng: np.random.Generator,
    dur_sec: float = 4.0,
) -> Optional[Tuple[np.ndarray, List[Tuple[float, float, str]], List[Tuple[float, float, str]]]]:
    """
    Construct a 4-second positive training clip containing 1-4 isolated single-syllable /
    short-burst speech tokens (80-450 ms each) surrounded by 300-700 ms of digital silence
    or low room tone, with optional whisper/breathy transform (p=0.35).
    Directly cures VAD miss on isolated plosives ("啪！哒！咔！") and standalone fricatives ("嘘").
    """
    n_tot = int(round(dur_sec * SR))
    # Extract candidate 80-450ms tokens from syllables (or contiguous non-sil phone spans)
    cands: List[Tuple[float, float, str]] = []
    if syllables:
        for ts, te, lbl in syllables:
            d = te - ts
            if lbl.strip() and 0.080 <= d <= 0.450:
                cands.append((ts, te, lbl.strip()))
    if not cands and phones:
        # Group 1-3 consecutive non-sil phones into 80-450ms token
        non_sil = [(ts, te, lbl) for ts, te, lbl in phones if lbl.strip() and lbl.strip().lower() not in {"sil", "sp", "pau", "h#"}]
        for i in range(len(non_sil)):
            ts = non_sil[i][0]
            te = non_sil[min(len(non_sil) - 1, i + int(rng.integers(0, 3)))][1]
            if 0.080 <= (te - ts) <= 0.450:
                cands.append((ts, te, non_sil[i][2]))
    if not cands:
        return None

    # Background floor: 50% near-digital silence (-75..-62 dBFS), 50% faint room tone (-60..-46 dBFS)
    floor_db = float(rng.uniform(-75.0, -62.0)) if rng.random() < 0.50 else float(rng.uniform(-60.0, -46.0))
    y = (rng.standard_normal(n_tot) * (10.0 ** (floor_db / 20.0))).astype(np.float32)

    out_phones: List[Tuple[float, float, str]] = []
    out_syls: List[Tuple[float, float, str]] = []
    cursor = float(rng.uniform(0.30, 0.70))
    n_tokens = int(rng.integers(2, 5))
    is_whisper = rng.random() < 0.35

    for _ in range(n_tokens):
        ts, te, slbl = cands[int(rng.integers(0, len(cands)))]
        tok_dur = te - ts
        if cursor + tok_dur + 0.25 > dur_sec:
            break
        s0 = max(0, int(round(ts * SR)))
        s1 = min(len(x), int(round(te * SR)))
        if s1 - s0 < int(0.060 * SR):
            continue
        seg = x[s0:s1].astype(np.float32).copy()
        # 3ms cosine fade-in/out to prevent artificial clicks
        fade = min(48, len(seg) // 6)
        if fade > 2:
            ramp = 0.5 * (1.0 - np.cos(np.pi * np.arange(fade, dtype=np.float32) / fade))
            seg[:fade] *= ramp
            seg[-fade:] *= ramp[::-1]

        if is_whisper:
            seg = apply_whisper_breathy(seg, rng)
        else:
            rms = float(np.sqrt(np.mean(seg.astype(np.float64) ** 2) + 1e-10))
            tgt = 10.0 ** (float(rng.uniform(-32.0, -14.0)) / 20.0)
            seg = np.clip(seg * (tgt / rms), -0.99, 0.99).astype(np.float32)

        p0 = int(round(cursor * SR))
        p1 = min(n_tot, p0 + len(seg))
        y[p0:p1] += seg[: p1 - p0]

        # Shift all phones overlapping [ts, te]
        actual_dur = (p1 - p0) / float(SR)
        out_syls.append((cursor, cursor + actual_dur, slbl))
        for pts, pte, plbl in phones:
            ov0 = max(pts, ts)
            ov1 = min(pte, te)
            if ov1 - ov0 >= 0.012:
                out_phones.append((cursor + (ov0 - ts), cursor + (ov1 - ts), plbl))

        cursor += actual_dur + float(rng.uniform(0.30, 0.70))

    if not out_phones:
        return None
    if rng.random() < 0.25:
        y = add_mains_hum(y, rng)
    return np.clip(y, -0.99, 0.99).astype(np.float32), out_phones, out_syls
