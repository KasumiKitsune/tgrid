"""
Language-agnostic IPA / ARPAbet / TIMIT / Pinyin -> 8 acoustic manner classes,
plus Auto Closure-Burst Sub-Segmentation and Temporal Gaussian Soft Label builder.

8 Manner Classes:
  0: SIL          - silence, noise, breath, paper rustle, mic pop
  1: STOP_CL      - stop/affricate closure hold, glottal stop, unreleased coda [-p̚, -t̚, -k̚, -ʔ]
  2: BURST_ASP    - stop/affricate release burst & aspiration (VOT)
  3: FRIC_VL      - voiceless fricatives & sibilants [f, s, ʂ, ɕ, ʃ, x, h, ɬ, θ, ç]
  4: OBS_VD       - voiced stops, voiced fricatives, voiced affricates [b, d, g, v, z, ʒ, ɦ, ...]
  5: NASAL        - nasal consonants [m, n, ɳ, ɲ, ŋ]
  6: LIQUID_GLIDE - liquids, flaps, taps, glides [l, ɹ, ɻ, ɾ, j, w, ɥ]
  7: VOWEL        - vowels & syllabic sonorants
"""
from __future__ import annotations

import re
import unicodedata
from typing import List, Optional, Tuple
import numpy as np

MANNER_SIL = 0
MANNER_STOP_CL = 1
MANNER_BURST_ASP = 2
MANNER_FRIC_VL = 3
MANNER_OBS_VD = 4
MANNER_NASAL = 5
MANNER_LIQUID_GLIDE = 6
MANNER_VOWEL = 7

# Special internal marker returned by map_phone_to_manner when a voiceless stop/affricate
# should be split into STOP_CL + BURST_ASP via acoustic burst detection
NEEDS_CLOSURE_BURST_SPLIT = -1

_SIL_TOKENS = {
    "", "sil", "sp", "spn", "nsn", "pau", "h#", "epi", "#", "<sil>", "<eps>",
    "<s>", "</s>", "noise", "breath", "laughter", "cough", "unk", "oov",
    "sil0", "sil1", "sil2", "q", # TIMIT 'q' is glottal stop -> handled below
}

# TIMIT explicit closure tokens! (TIMIT already separates closures!)
_TIMIT_CLOSURES = {"pcl", "tcl", "kcl", "bcl", "dcl", "gcl", "q"}
_TIMIT_VL_RELEASES = {"p", "t", "k", "ch"}
_TIMIT_VD_RELEASES = {"b", "d", "g", "jh"}

# ARPAbet / CMUbet (L2-ARCTIC, TIMIT, MFA English)
_ARPA_VL_STOP_AFFR = {"p", "t", "k", "ch"}
_ARPA_VD_OBS = {"b", "d", "g", "jh", "v", "dh", "z", "zh"}
_ARPA_VL_FRIC = {"f", "th", "s", "sh", "hh", "h"}
_ARPA_NASAL = {"m", "n", "ng", "em", "en", "eng", "nx"}
_ARPA_LIQUID_GLIDE = {"l", "el", "r", "w", "y", "dx", "er", "axr"}
_ARPA_VOWEL = {
    "aa", "ae", "ah", "ao", "aw", "ax", "ax-h", "ay", "eh", "ey",
    "ih", "ix", "iy", "ow", "oy", "uh", "uw", "ux",
}

# Mandarin Pinyin initials / finals (AISHELL-3 / forced-alignment-chinese / THCHS-30)
_PINYIN_VL_STOP_AFFR = {"b", "p", "d", "t", "g", "k", "j", "q", "zh", "ch", "z", "c"}
_PINYIN_VL_FRIC = {"f", "h", "x", "sh", "s"}
_PINYIN_NASAL = {"m", "n", "ng"}
_PINYIN_LIQUID_GLIDE = {"l", "r", "y", "w"}

# IPA sets (by base character / prefix)
# Complete coverage for Mandarin Chinese (pinyin_to_ipa / MFA / Sinological IPA),
# English, Cantonese, and cross-lingual IPA.
_IPA_VL_STOP_CHARS = set("ptckqʈȶ")
_IPA_GLOTTAL_OR_UNRELEASED = {"ʔ", "p̚", "t̚", "k̚", "q̚", "c̚"}
_IPA_VD_OBS_CHARS = set("bdgɡɖɟɢɓɗʄɠʛvzʒʐʑðɣʁɦʕβʝɮ")
_IPA_VL_FRIC_CHARS = set("fsʃʂɕxχhθçɬɸħɧʍ")
_IPA_NASAL_CHARS = set("mnŋɲɳɴɱ")
_IPA_LIQUID_GLIDE_CHARS = set("lɭʎʟɫrɾɽɹɻʀjwɥʋɰ")
_IPA_VOWEL_CHARS = set("aeiouyɑɒæɐəɚɛɜɝɞɪɨɯɵøœɶʉʊʌɔʏɤɿʅᴀᴇɪᴏᴜʮʯ")

# Strip combining diacritics, length, aspiration/secondary articulation, rhotic hooks,
# tie bars, tone letters (˥˦˧˨˩), tone numbers, breve (˘), and non-syllabic glide marks.
_STRIP_RE = re.compile(r"[\dˈˌːˑ̟̠̹̜̘̙̝̞̩̯̪̺̻̼̃̌̂́̀̄̆̈̽ʼʰʷʲˠˤ̚˞ʵ͜͡˥˦˧˨˩⁰¹²³⁴⁵˘]+")


def map_phone_to_manner_checked(label: str, alphabet: str = "auto") -> Tuple[int, bool]:
    """
    Map a phoneme symbol (TIMIT, ARPAbet, IPA, or Mandarin Pinyin) to:
      (manner_id, matched_explicitly)
    where manner_id is 0..7 or -1 (NEEDS_CLOSURE_BURST_SPLIT for voiceless stop/affricate).
    """
    raw = label.strip()
    # L2-ARCTIC manual mispronunciation annotation format: "CPL,PPL,err_type"
    # e.g., "Z,S,s" -> actual pronounced phone is the 2nd field ("S"),
    # "D,sil,d" -> deletion ("sil"), "R,R*,s" -> distorted R ("R"), "sil,AH0,a" -> insertion ("AH0").
    if alphabet in ("arpa", "auto") and "," in raw:
        parts = [p.strip() for p in raw.split(",")]
        if len(parts) >= 2:
            actual = re.sub(r"[*`_)(\s]+", "", parts[1])
            if not actual or actual.lower() in {"err", "sil", "sp", "spn", "del", "none"}:
                return MANNER_SIL, True
            raw = actual
    if alphabet in ("arpa", "timit"):
        raw = re.sub(r"[*`_)(\s]+", "", raw)
    else:
        raw = raw.replace("*", "").strip()
    low = raw.lower()
    if not raw or low in {
        "sil", "[sil]", "sp", "spn", "nsn", "pau", "h#", "epi", "#", "<sil>", "<eps>",
        "<s>", "</s>", "noise", "unk", "oov", "none", "breath", "laughter",
        "cough", "sil0", "sil1", "sil2", "err", "err'",
    }:
        return MANNER_SIL, True

    # TIMIT explicit closures & releases
    if alphabet == "timit":
        if low in _TIMIT_CLOSURES:
            return MANNER_STOP_CL, True
        if low in _TIMIT_VL_RELEASES:
            return MANNER_BURST_ASP, True
        if low in _TIMIT_VD_RELEASES:
            return MANNER_OBS_VD, True
        if low == "hv":
            return MANNER_OBS_VD, True
        if low == "dx":
            return MANNER_LIQUID_GLIDE, True

    # Strip stress / tone digits for ARPAbet & Pinyin (e.g., AA1 -> aa, ER0 -> er)
    low_nodig = re.sub(r"\d+$", "", low)

    if alphabet in ("timit", "arpa"):
        if low_nodig in _ARPA_VL_STOP_AFFR:
            return NEEDS_CLOSURE_BURST_SPLIT, True
        if low_nodig in _ARPA_VD_OBS:
            return MANNER_OBS_VD, True
        if low_nodig in _ARPA_VL_FRIC:
            return MANNER_FRIC_VL, True
        if low_nodig in _ARPA_NASAL:
            return MANNER_NASAL, True
        if low_nodig in _ARPA_LIQUID_GLIDE:
            return MANNER_LIQUID_GLIDE, True
        if low_nodig in _ARPA_VOWEL:
            return MANNER_VOWEL, True
        return MANNER_VOWEL, False

    if alphabet == "pinyin":
        # Note: Mandarin b/d/g/j/zh/z are phonetically voiceless unaspirated stops/affricates!
        if low_nodig in _PINYIN_VL_STOP_AFFR:
            return NEEDS_CLOSURE_BURST_SPLIT, True
        if low_nodig in _PINYIN_VL_FRIC:
            return MANNER_FRIC_VL, True
        if low_nodig in _PINYIN_NASAL:
            return MANNER_NASAL, True
        if low_nodig in _PINYIN_LIQUID_GLIDE:
            return MANNER_LIQUID_GLIDE, True
        if low_nodig and low_nodig[0] in "aeiouvü":
            return MANNER_VOWEL, True
        return MANNER_VOWEL, False

    # IPA / Auto mode
    # Normalize to NFD so precomposed vowels like 'ä', 'ü', 'ã', 'õ' decompose cleanly
    nfd = unicodedata.normalize("NFD", raw)

    # Check unreleased stops (e.g. p̚, t̚, k̚) and glottal stop ʔ
    if "̚" in nfd or nfd.startswith("ʔ"):
        return MANNER_STOP_CL, True

    # Syllabic consonants (m̩, n̩, ŋ̍, l̩, ɹ̩, ɻ̩, z̩, ʐ̩) act as syllable nuclei -> VOWEL
    if "̩" in nfd or "̍" in nfd:
        return MANNER_VOWEL, True

    # Only check ARPAbet tokens in "auto" mode (never when alphabet == "ipa")
    if alphabet != "ipa" and (
        raw.isupper()
        or (
            len(low_nodig) >= 2
            and low_nodig in (
                _ARPA_VOWEL | _ARPA_VL_FRIC | _ARPA_VD_OBS | _ARPA_VL_STOP_AFFR | _ARPA_NASAL | _ARPA_LIQUID_GLIDE
            )
        )
    ):
        if low_nodig in _ARPA_VL_STOP_AFFR:
            return NEEDS_CLOSURE_BURST_SPLIT, True
        if low_nodig in _ARPA_VD_OBS:
            return MANNER_OBS_VD, True
        if low_nodig in _ARPA_VL_FRIC:
            return MANNER_FRIC_VL, True
        if low_nodig in _ARPA_NASAL:
            return MANNER_NASAL, True
        if low_nodig in _ARPA_LIQUID_GLIDE:
            return MANNER_LIQUID_GLIDE, True
        if low_nodig in _ARPA_VOWEL:
            return MANNER_VOWEL, True

    # Strip IPA diacritics, tie bars, tone letters, rhotic hooks & length markers
    base = _STRIP_RE.sub("", nfd)
    if not base:
        return MANNER_SIL, True
    ch = base[0]

    # Pre-nasalized stops (e.g., mb, nd, ŋg) -> voiced obstruent if 2nd char is stop
    if ch in _IPA_NASAL_CHARS and len(base) >= 2 and base[1] in (_IPA_VD_OBS_CHARS | _IPA_VL_STOP_CHARS):
        return (MANNER_OBS_VD if base[1] in _IPA_VD_OBS_CHARS else NEEDS_CLOSURE_BURST_SPLIT), True

    if ch in _IPA_VL_STOP_CHARS:
        return NEEDS_CLOSURE_BURST_SPLIT, True
    if ch in _IPA_VD_OBS_CHARS:
        return MANNER_OBS_VD, True
    if ch in _IPA_VL_FRIC_CHARS:
        return MANNER_FRIC_VL, True
    if ch in _IPA_NASAL_CHARS:
        return MANNER_NASAL, True
    if ch in _IPA_LIQUID_GLIDE_CHARS:
        return MANNER_LIQUID_GLIDE, True
    if ch in _IPA_VOWEL_CHARS:
        return MANNER_VOWEL, True
    return MANNER_VOWEL, False


def map_phone_to_manner(label: str, alphabet: str = "auto") -> int:
    """
    Map a phoneme symbol (TIMIT, ARPAbet, IPA, or Mandarin Pinyin) to:
      0..7 (fixed manner class) OR -1 (NEEDS_CLOSURE_BURST_SPLIT for voiceless stop/affricate).
    """
    cls, _ = map_phone_to_manner_checked(label, alphabet=alphabet)
    return cls


def split_closure_burst(
    x_16k: np.ndarray,
    t_start: float,
    t_end: float,
) -> Tuple[List[Tuple[float, float, int]], Optional[float]]:
    """
    Auto Closure-Burst Sub-Segmentation (Section 3.1):
    Given a voiceless stop/affricate interval [t_start, t_end], find the internal burst
    moment where high-frequency energy jumps > 6 dB with maximum positive HF flux.
    Returns (list of (ts, te, manner_class), optional_burst_time).
    """
    dur = t_end - t_start
    if dur < 0.020:
        return [(t_start, t_end, MANNER_BURST_ASP)], None

    s0 = max(0, int(round(t_start * 16000.0)))
    s1 = min(len(x_16k), int(round(t_end * 16000.0)))
    seg = x_16k[s0:s1].astype(np.float64)
    if len(seg) < 160:
        return [(t_start, t_end, MANNER_BURST_ASP)], None

    # Compute 5ms (80-sample) high-pass energy envelope inside the segment
    step = 40  # 2.5 ms step for crisp burst localization
    win = 80   # 5 ms window
    diff = np.diff(seg, prepend=seg[0])
    n_pos = max(1, (len(seg) - win) // step + 1)
    hf_db = np.empty(n_pos, dtype=np.float64)
    for i in range(n_pos):
        sl = diff[i * step : i * step + win]
        hf_db[i] = 10.0 * np.log10(np.mean(sl * sl) + 1e-10)

    if n_pos < 4:
        return [(t_start, t_end, MANNER_BURST_ASP)], None

    # Compute positive HF jump over 2-step (5ms) delta
    delta_hf = np.zeros(n_pos, dtype=np.float64)
    delta_hf[2:] = hf_db[2:] - np.minimum(hf_db[:-2], hf_db[1:-1])

    # Search interior [15% .. 88%] for strongest burst jump
    lo_i = max(1, int(0.10 * n_pos))
    hi_i = max(lo_i + 1, int(0.90 * n_pos))
    best_rel = int(np.argmax(delta_hf[lo_i:hi_i])) + lo_i
    best_jump = float(delta_hf[best_rel])

    # Also check contrast between pre-burst minimum and post-burst peak
    pre_min = float(np.min(hf_db[:best_rel]))
    post_max = float(np.max(hf_db[best_rel:]))

    if best_jump >= 6.0 and (post_max - pre_min) >= 8.0:
        t_burst = t_start + (best_rel * step) / 16000.0
        if t_burst - t_start >= 0.010 and t_end - t_burst >= 0.008:
            return [(t_start, t_burst, MANNER_STOP_CL), (t_burst, t_end, MANNER_BURST_ASP)], t_burst

    # No burst detected: check if energy stays very low (unreleased coda stop [-p̚/-t̚/-k̚])
    # vs noisy throughout (pure burst/aspiration)
    seg_rms_db = 10.0 * np.log10(np.mean(seg * seg) + 1e-10)
    if seg_rms_db < -42.0 or (post_max - pre_min) < 5.0 and float(np.max(hf_db)) < -38.0:
        return [(t_start, t_end, MANNER_STOP_CL)], None

    return [(t_start, t_end, MANNER_BURST_ASP)], None


def build_frame_targets(
    num_frames: int,
    x_16k: np.ndarray,
    phones: List[Tuple[float, float, str]],
    syllables: Optional[List[Tuple[float, float, str]]] = None,
    alphabet: str = "auto",
    sigma_phone_ms: float = 6.0,
    sigma_syl_ms: float = 10.0,
    has_phone_tier: bool = True,
) -> dict[str, np.ndarray]:
    """
    Build all multi-task training targets aligned to `extract_features_from_clean_16k`:
      - Frame t center = 10t + 5 ms (covers [10t, 10t+10ms))
      - Subframe 2t center = 10t + 2.5 ms, subframe 2t+1 center = 10t + 7.5 ms
    """
    manner = np.zeros((num_frames,), dtype=np.int64)
    manner_mask = np.ones((num_frames,), dtype=np.float32) if has_phone_tier else np.zeros((num_frames,), dtype=np.float32)
    pbnd = np.zeros((num_frames, 2), dtype=np.float32)
    pbnd_mask = np.ones((num_frames, 2), dtype=np.float32) if has_phone_tier else np.zeros((num_frames, 2), dtype=np.float32)
    sbnd = np.zeros((num_frames,), dtype=np.float32)
    sbnd_mask = np.zeros((num_frames,), dtype=np.float32)
    vad = np.zeros((num_frames,), dtype=np.float32)
    vad_mask = np.ones((num_frames,), dtype=np.float32)

    if num_frames == 0:
        return dict(
            manner=manner, manner_mask=manner_mask,
            pbnd=pbnd, pbnd_mask=pbnd_mask,
            sbnd=sbnd, sbnd_mask=sbnd_mask,
            vad=vad, vad_mask=vad_mask,
        )

    t_10ms = (np.arange(num_frames, dtype=np.float64) * 0.010) + 0.005
    t_5ms = (np.arange(num_frames * 2, dtype=np.float64) * 0.005) + 0.0025

    expanded_segs: List[Tuple[float, float, int]] = []
    phone_bnds: List[float] = []

    if has_phone_tier and phones:
        for (ts, te, lbl) in phones:
            if te <= ts:
                continue
            cls = map_phone_to_manner(lbl, alphabet=alphabet)
            if cls == NEEDS_CLOSURE_BURST_SPLIT:
                sub_segs, _t_burst = split_closure_burst(x_16k, ts, te)
                expanded_segs.extend(sub_segs)
            else:
                expanded_segs.append((ts, te, cls))
            # Record true phonetic boundary timestamps (skip t=0)
            if ts > 0.005:
                phone_bnds.append(ts)
            if te < num_frames * 0.010 - 0.005:
                phone_bnds.append(te)

        # Fill manner & VAD
        for (ts, te, cls) in expanded_segs:
            f0 = max(0, int(np.searchsorted(t_10ms, ts, side="left")))
            f1 = min(num_frames, int(np.searchsorted(t_10ms, te, side="right")))
            if f1 > f0:
                manner[f0:f1] = cls
                if cls != MANNER_SIL:
                    vad[f0:f1] = 1.0

        # Ensure word-internal short STOP_CL keeps vad = 1.0 (already true since STOP_CL != SIL!)
        # Build Gaussian soft phone boundary target on 5ms grid
        if phone_bnds:
            b_arr = np.unique(np.round(np.array(phone_bnds, dtype=np.float64), 4))
            sig_p = sigma_phone_ms / 1000.0
            inv_2sig2 = 1.0 / (2.0 * sig_p * sig_p)
            pb_flat = np.zeros((num_frames * 2,), dtype=np.float32)
            rad = int(np.ceil(3.5 * sig_p / 0.005)) + 1
            for tb in b_arr:
                c_idx = int(round((tb - 0.0025) / 0.005))
                lo = max(0, c_idx - rad)
                hi = min(num_frames * 2, c_idx + rad + 1)
                if hi > lo:
                    dt = t_5ms[lo:hi] - tb
                    g = np.exp(-(dt * dt) * inv_2sig2).astype(np.float32)
                    pb_flat[lo:hi] = np.maximum(pb_flat[lo:hi], g)
            pbnd = pb_flat.reshape(num_frames, 2)

    # Syllable / Word boundary targets
    syl_bnds: List[float] = []
    if syllables:
        sbnd_mask[:] = 1.0
        for (ts, te, lbl) in syllables:
            if te <= ts or not lbl.strip():
                continue
            if ts > 0.005:
                syl_bnds.append(ts)
            if te < num_frames * 0.010 - 0.005:
                syl_bnds.append(te)
            if not has_phone_tier:
                f0 = max(0, int(np.searchsorted(t_10ms, ts, side="left")))
                f1 = min(num_frames, int(np.searchsorted(t_10ms, te, side="right")))
                if f1 > f0:
                    vad[f0:f1] = 1.0
    elif has_phone_tier and expanded_segs:
        # Derive syllable onset boundaries from phone sequence via vowel-nucleus Maximal Onset Principle:
        # Each transition into an onset cluster before a new VOWEL nucleus marks a syllable boundary!
        sbnd_mask[:] = 1.0
        vowel_indices = [i for i, (_, _, c) in enumerate(expanded_segs) if c == MANNER_VOWEL]
        for vi_idx in range(len(vowel_indices)):
            cur_v = vowel_indices[vi_idx]
            if vi_idx == 0:
                # First speech onset
                j = cur_v
                while j > 0 and expanded_segs[j - 1][2] != MANNER_SIL:
                    j -= 1
                if expanded_segs[j][0] > 0.005:
                    syl_bnds.append(expanded_segs[j][0])
            else:
                prev_v = vowel_indices[vi_idx - 1]
                # Find consonants between prev_v and cur_v
                inter = list(range(prev_v + 1, cur_v))
                if not inter:
                    # V-V hiatus
                    syl_bnds.append(expanded_segs[cur_v][0])
                else:
                    # If there's a SIL between them, boundary is onset after SIL
                    sil_pos = [idx for idx in inter if expanded_segs[idx][2] == MANNER_SIL]
                    if sil_pos:
                        onset_idx = sil_pos[-1] + 1
                        if onset_idx < len(expanded_segs):
                            syl_bnds.append(expanded_segs[onset_idx][0])
                    else:
                        # Place boundary before the obstruent onset (STOP_CL or FRIC/OBS) of cur_v,
                        # or if all sonorants/nasals, before the last consonant before cur_v
                        onset_idx = cur_v - 1
                        # Walk back over BURST_ASP to include its preceding STOP_CL as syllable start!
                        if expanded_segs[onset_idx][2] == MANNER_BURST_ASP and onset_idx - 1 > prev_v and expanded_segs[onset_idx - 1][2] == MANNER_STOP_CL:
                            onset_idx -= 1
                        syl_bnds.append(expanded_segs[onset_idx][0])

    if syl_bnds:
        s_arr = np.unique(np.round(np.array(syl_bnds, dtype=np.float64), 4))
        sig_s = sigma_syl_ms / 1000.0
        inv_2sig2 = 1.0 / (2.0 * sig_s * sig_s)
        rad = int(np.ceil(3.5 * sig_s / 0.010)) + 1
        for tb in s_arr:
            c_idx = int(round((tb - 0.005) / 0.010))
            lo = max(0, c_idx - rad)
            hi = min(num_frames, c_idx + rad + 1)
            if hi > lo:
                dt = t_10ms[lo:hi] - tb
                g = np.exp(-(dt * dt) * inv_2sig2).astype(np.float32)
                sbnd[lo:hi] = np.maximum(sbnd[lo:hi], g)

    return dict(
        manner=manner,
        manner_mask=manner_mask,
        pbnd=pbnd,
        pbnd_mask=pbnd_mask,
        sbnd=sbnd,
        sbnd_mask=sbnd_mask,
        vad=vad,
        vad_mask=vad_mask,
    )
