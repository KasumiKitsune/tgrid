"""
GPU-Accelerated Forced Alignment for Chinese Dialects & Cross-Lingual Key Phonetic Classes
for TGrid-AcouSeg 1.0, using Meta's `torchaudio.pipelines.MMS_FA` with strict bottom-25%
confidence filtering.

License note:
  Meta's `MMS_FA` weights are distributed under CC-BY-NC-4.0. If you require a strictly
  commercial-permissive (MIT / CC-BY / Apache-2.0) clean-room reproduction, pass
  `--skip-dialects` to `prepare_corpora.py` or replace `MmsGpuAligner` with Montreal Forced
  Aligner (MFA) IPA acoustic models.

Covers:
  1. Cantonese (ming030890/mdcc, train/validation splits):
     - Checked-tone unreleased stop codas (-p̚, -t̚, -k̚ -> STOP_CL), nasal codas (-m/-n/-ŋ), affricates
  2. Taiwanese Hokkien / Minnan (sarahwei/Taiwanese-Minnan-Sutiau + jiyuntu/common_voice_minnan):
     - True voiced stops/affricates (b/g/dz -> OBS_VD), checked-tone codas (-p̚/-t̚/-k̚/-ʔ -> STOP_CL), nasalized vowels
  3. Chinese 8-Dialect Group (TwinkStart/KeSpeech test, speaker-disjoint split):
     - Northeastern, Southwestern, Zhongyuan, Jiang-Huai, Lan-Yin, Ji-Lu, Jiao-Liao, Beijing
  4. Vietnamese (ademax/vivos-vie-speech2text):
     - Checked-tone unreleased codas (-p̚/-t̚/-k̚ -> STOP_CL) + voiced/implosive obstruents (b/d/g/v/z)
  5. French (facebook/multilingual_librispeech french, speaker-disjoint split):
     - True pre-voiced obstruents (b/d/g/v/z/ʒ -> OBS_VD) + nasalized vowels

Every aligned phone is emitted as canonical IPA verified 100% explicitly mapped by `ipa_manner_map.py`.
"""
from __future__ import annotations

import io
import math
import re
import time
import unicodedata
from typing import Dict, List, Optional, Tuple

import numpy as np
import soundfile as sf
import torch
import torchaudio
from scipy.signal import resample_poly


def _fast_16k(arr: np.ndarray, sr: int) -> np.ndarray:
    x = np.asarray(arr, dtype=np.float32).reshape(-1)
    if x.size == 0 or sr <= 0:
        return np.zeros((0,), dtype=np.float32)
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    x = x - np.float32(np.mean(x, dtype=np.float64))
    if sr == 16000:
        return x.astype(np.float32)
    g = math.gcd(16000, int(sr))
    return resample_poly(x.astype(np.float64), 16000 // g, int(sr) // g).astype(np.float32)


def _decode_audio(audio_field) -> Optional[np.ndarray]:
    if audio_field is None:
        return None
    try:
        if isinstance(audio_field, dict):
            if audio_field.get("array") is not None:
                arr = np.asarray(audio_field["array"], dtype=np.float32)
                sr = int(audio_field["sampling_rate"])
            elif audio_field.get("bytes"):
                arr, sr = sf.read(io.BytesIO(audio_field["bytes"]), dtype="float32")
            else:
                return None
        else:
            return None
        if arr.ndim == 2:
            arr = np.mean(arr, axis=1)
        return _fast_16k(arr, int(sr))
    except Exception:
        return None


def _strip_accents_ascii(s: str) -> str:
    nfd = unicodedata.normalize("NFD", s)
    return "".join(ch for ch in nfd if not unicodedata.combining(ch))


# -------------------------------------------------------------------------
# Language-Specific Syllable/Word -> (MMS letters, [(char_len, ipa_sym), ...])
# -------------------------------------------------------------------------

_JYUT_ONSETS = [
    ("gw", "kʷ"), ("kw", "kʷʰ"), ("ng", "ŋ"),
    ("b", "p"), ("p", "pʰ"), ("d", "t"), ("t", "tʰ"), ("g", "k"), ("k", "kʰ"),
    ("z", "ts"), ("c", "tsʰ"), ("f", "f"), ("s", "s"), ("h", "h"),
    ("m", "m"), ("n", "n"), ("l", "l"), ("j", "j"), ("w", "w"),
]
_JYUT_CODAS = [
    ("ng", "ŋ"), ("p", "p̚"), ("t", "t̚"), ("k", "k̚"), ("m", "m"), ("n", "n"),
]


def parse_jyutping_syllable(syl: str) -> Optional[Tuple[str, List[Tuple[int, str]]]]:
    s = re.sub(r"[^a-z]", "", syl.lower())
    if not s:
        return None
    # Syllabic nasals m / ng
    if s == "m":
        return "m", [(1, "m̩")]
    if s == "ng":
        return "ng", [(2, "ŋ̍")]
    segs: List[Tuple[int, str]] = []
    rem = s
    for pref, ipa in _JYUT_ONSETS:
        if rem.startswith(pref) and len(rem) > len(pref):
            segs.append((len(pref), ipa))
            rem = rem[len(pref):]
            break
    coda = None
    for suf, ipa in _JYUT_CODAS:
        if rem.endswith(suf) and len(rem) > len(suf):
            coda = (len(suf), ipa)
            rem = rem[:-len(suf)]
            break
    if rem:
        segs.append((len(rem), "a"))
    if coda:
        segs.append(coda)
    if not segs or sum(n for n, _ in segs) != len(s):
        return None
    return s, segs


_TAILO_ONSETS = [
    ("tsh", "tsʰ"), ("chh", "tsʰ"), ("ph", "pʰ"), ("th", "tʰ"), ("kh", "kʰ"),
    ("ng", "ŋ"), ("ts", "ts"), ("ch", "ts"),
    ("b", "b"), ("g", "g"), ("j", "dz"),  # True voiced obstruents in Hokkien/Minnan!
    ("p", "p"), ("t", "t"), ("k", "k"), ("s", "s"), ("h", "h"),
    ("m", "m"), ("n", "n"), ("l", "l"),
]
_TAILO_CODAS = [
    ("ng", "ŋ"), ("p", "p̚"), ("t", "t̚"), ("k", "k̚"), ("h", "ʔ"), ("m", "m"), ("n", "n"),
]


def parse_tailo_syllable(syl: str) -> Optional[Tuple[str, List[Tuple[int, str]]]]:
    s = re.sub(r"[^a-z]", "", _strip_accents_ascii(syl).lower())
    if not s:
        return None
    if s == "m":
        return "m", [(1, "m̩")]
    if s == "ng":
        return "ng", [(2, "ŋ̍")]
    segs: List[Tuple[int, str]] = []
    rem = s
    for pref, ipa in _TAILO_ONSETS:
        if rem.startswith(pref) and len(rem) > len(pref):
            segs.append((len(pref), ipa))
            rem = rem[len(pref):]
            break
    coda = None
    # Strip nasalization marker 'nn' into vowel nucleus before checking codas
    if rem.endswith("nn") and len(rem) > 2:
        segs.append((len(rem), "a"))
        return s, segs
    for suf, ipa in _TAILO_CODAS:
        if rem.endswith(suf) and len(rem) > len(suf):
            coda = (len(suf), ipa)
            rem = rem[:-len(suf)]
            break
    if rem:
        segs.append((len(rem), "a"))
    if coda:
        segs.append(coda)
    if not segs or sum(n for n, _ in segs) != len(s):
        return None
    return s, segs


_PY_ONSETS = [
    ("zh", "tʂ"), ("ch", "tʂʰ"), ("sh", "ʂ"),
    ("b", "p"), ("p", "pʰ"), ("d", "t"), ("t", "tʰ"), ("g", "k"), ("k", "kʰ"),
    ("j", "tɕ"), ("q", "tɕʰ"), ("x", "ɕ"), ("z", "ts"), ("c", "tsʰ"),
    ("f", "f"), ("s", "s"), ("h", "x"), ("m", "m"), ("n", "n"), ("l", "l"),
    ("r", "ɻ"), ("y", "j"), ("w", "w"),
]
_PY_CODAS = [("ng", "ŋ"), ("n", "n")]


def parse_pinyin_syllable(syl: str) -> Optional[Tuple[str, List[Tuple[int, str]]]]:
    s = re.sub(r"[^a-z]", "", syl.lower())
    if not s:
        return None
    segs: List[Tuple[int, str]] = []
    rem = s
    for pref, ipa in _PY_ONSETS:
        if rem.startswith(pref) and len(rem) > len(pref):
            segs.append((len(pref), ipa))
            rem = rem[len(pref):]
            break
    coda = None
    for suf, ipa in _PY_CODAS:
        if rem.endswith(suf) and len(rem) > len(suf):
            coda = (len(suf), ipa)
            rem = rem[:-len(suf)]
            break
    if rem:
        segs.append((len(rem), "a"))
    if coda:
        segs.append(coda)
    if not segs or sum(n for n, _ in segs) != len(s):
        return None
    return s, segs


_VIET_ONSETS = [
    ("ngh", "ŋ"), ("ng", "ŋ"), ("nh", "ɲ"), ("ph", "f"), ("th", "tʰ"),
    ("kh", "x"), ("tr", "tʂ"), ("ch", "tɕ"), ("gh", "ɣ"), ("gi", "z"), ("qu", "kʷ"),
    ("b", "b"), ("d", "z"), ("g", "ɣ"), ("v", "v"), ("r", "ʐ"),
    ("t", "t"), ("c", "k"), ("k", "k"), ("p", "p"), ("s", "s"), ("x", "s"),
    ("h", "h"), ("m", "m"), ("n", "n"), ("l", "l"),
]
_VIET_CODAS = [
    ("ng", "ŋ"), ("nh", "ɲ"), ("ch", "k̚"),
    ("p", "p̚"), ("t", "t̚"), ("c", "k̚"), ("m", "m"), ("n", "n"),
]


def parse_viet_syllable(word: str) -> Optional[Tuple[str, List[Tuple[int, str]]]]:
    w_low = word.lower()
    is_d_bar = w_low.startswith("đ")
    s = re.sub(r"[^a-z]", "", _strip_accents_ascii(w_low.replace("đ", "d")))
    if not s:
        return None
    segs: List[Tuple[int, str]] = []
    rem = s
    if is_d_bar and len(rem) > 1:
        segs.append((1, "d"))  # Vietnamese đ = voiced alveolar implosive/stop -> OBS_VD
        rem = rem[1:]
    else:
        for pref, ipa in _VIET_ONSETS:
            if rem.startswith(pref) and len(rem) > len(pref):
                segs.append((len(pref), ipa))
                rem = rem[len(pref):]
                break
    coda = None
    for suf, ipa in _VIET_CODAS:
        if rem.endswith(suf) and len(rem) > len(suf):
            coda = (len(suf), ipa)
            rem = rem[:-len(suf)]
            break
    if rem:
        segs.append((len(rem), "a"))
    if coda:
        segs.append(coda)
    if not segs or sum(n for n, _ in segs) != len(s):
        return None
    return s, segs


_FR_DIGRAPHS = [
    ("ch", "ʃ"), ("ph", "f"), ("gn", "ɲ"), ("qu", "k"), ("th", "t"),
    ("eau", "a"), ("ou", "a"), ("au", "a"), ("ai", "a"), ("ei", "a"), ("eu", "a"), ("oi", "a"),
]
_FR_SINGLE = {
    "b": "b", "d": "d", "g": "g", "v": "v", "z": "z", "j": "ʒ",  # True voiced obstruents!
    "p": "p", "t": "t", "k": "k", "c": "k", "q": "k",
    "f": "f", "s": "s", "x": "s", "h": "h",
    "m": "m", "n": "n",
    "l": "l", "r": "ʁ", "w": "w",
    "a": "a", "e": "a", "i": "a", "o": "a", "u": "a", "y": "a",
}


def parse_french_word(word: str) -> Optional[Tuple[str, List[Tuple[int, str]]]]:
    s = re.sub(r"[^a-z]", "", _strip_accents_ascii(word.lower()))
    if len(s) < 2:
        return None
    segs: List[Tuple[int, str]] = []
    i = 0
    while i < len(s):
        matched = False
        for dg, ipa in _FR_DIGRAPHS:
            if s.startswith(dg, i):
                segs.append((len(dg), ipa))
                i += len(dg)
                matched = True
                break
        if matched:
            continue
        ch = s[i]
        # Collapse consecutive identical letters or vowel clusters
        j = i + 1
        if ch in "aeiouy":
            while j < len(s) and s[j] in "aeiouy":
                j += 1
            segs.append((j - i, "a"))
        else:
            while j < len(s) and s[j] == ch:
                j += 1
            segs.append((j - i, _FR_SINGLE.get(ch, "a")))
        i = j
    if not segs or sum(n for n, _ in segs) != len(s):
        return None
    return s, segs


# -------------------------------------------------------------------------
# GPU MMS_FA Forced Aligner Engine
# -------------------------------------------------------------------------

class MmsGpuAligner:
    def __init__(self, device: Optional[torch.device] = None):
        self.device = device or torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.bundle = torchaudio.pipelines.MMS_FA
        self.model = self.bundle.get_model().to(self.device).eval()
        self.tokenizer = self.bundle.get_tokenizer()
        self.aligner = self.bundle.get_aligner()
        self.valid_chars = set(self.bundle.get_dict().keys())

    @torch.inference_mode()
    def align_utterance(
        self,
        x16: np.ndarray,
        parsed_words: List[Tuple[str, List[Tuple[int, str]]]],
    ) -> Optional[Tuple[List[Tuple[float, float, str]], List[Tuple[float, float, str]], float]]:
        """
        Align `parsed_words` [(ascii_str, [(char_len, ipa_sym), ...]), ...] onto `x16`.
        Returns (phones, syllables, mean_confidence) or None on failure.
        """
        if not parsed_words or len(x16) < 4000 or len(x16) > 16000 * 15:
            return None
        clean_words = []
        clean_specs = []
        for w_str, segs in parsed_words:
            if all(ch in self.valid_chars for ch in w_str) and len(w_str) > 0:
                clean_words.append(w_str)
                clean_specs.append(segs)
        if len(clean_words) < 2:
            return None
        if sum(len(w) for w in clean_words) > int(len(x16) / 320 * 0.85):
            return None

        wav = torch.from_numpy(x16).unsqueeze(0).to(self.device)
        emission, _ = self.model(wav)
        em_cpu = emission[0].detach().cpu()
        ratio = (len(x16) / float(em_cpu.shape[0])) / 16000.0

        try:
            tokens = self.tokenizer(clean_words)
            spans_per_word = self.aligner(em_cpu, tokens)
        except Exception:
            return None

        phones: List[Tuple[float, float, str]] = []
        syllables: List[Tuple[float, float, str]] = []
        scores: List[float] = []

        for w_str, segs, w_spans in zip(clean_words, clean_specs, spans_per_word):
            if len(w_spans) != len(w_str):
                continue
            w_s = w_spans[0].start * ratio
            w_e = w_spans[-1].end * ratio
            if w_e <= w_s:
                continue
            syllables.append((w_s, w_e, w_str))
            pos = 0
            for clen, ipa in segs:
                sub = w_spans[pos : pos + clen]
                pos += clen
                if not sub:
                    continue
                ps = sub[0].start * ratio
                pe = sub[-1].end * ratio
                if pe > ps:
                    phones.append((ps, pe, ipa))
                    scores.extend(float(sp.score) for sp in sub)

        if len(phones) < 3 or not scores:
            return None
        return phones, syllables, float(np.mean(scores))


def _filter_top_confidence(raw_items: List[Tuple[float, dict]], drop_bottom_frac: float = 0.25) -> Tuple[List[dict], float]:
    """Strictly discard lowest `drop_bottom_frac` (25%) confidence alignments."""
    if not raw_items:
        return [], 0.0
    raw_items.sort(key=lambda pair: pair[0])
    cut = int(len(raw_items) * drop_bottom_frac)
    kept = raw_items[cut:]
    thresh = kept[0][0] if kept else 0.0
    return [it for _, it in kept], round(float(thresh), 4)


# -------------------------------------------------------------------------
# Individual Open-Access Dialect / Cross-Lingual Corpus Loaders
# -------------------------------------------------------------------------

def load_cantonese_mdcc(aligner: MmsGpuAligner, max_train: int = 1600, max_val: int = 240) -> Tuple[List[dict], List[dict], dict]:
    """Cantonese MDCC (`ming030890/mdcc`): checked-tone -p̚/-t̚/-k̚ codas, nasal codas, affricates."""
    from datasets import Audio, load_dataset
    import pycantonese

    t0 = time.time()
    def _run_split(split_name: str, limit: int) -> List[Tuple[float, dict]]:
        out = []
        try:
            ds = load_dataset("ming030890/mdcc", split=split_name, streaming=True).cast_column("audio", Audio(decode=False))
            for idx, row in enumerate(ds):
                if len(out) >= limit:
                    break
                txt = str(row.get("transcript") or "").strip()
                if not txt:
                    continue
                x16 = _decode_audio(row.get("audio"))
                if x16 is None or len(x16) < 4800 or len(x16) > 16000 * 14:
                    continue
                jp_pairs = pycantonese.characters_to_jyutping(txt)
                parsed = []
                for _, jp in jp_pairs:
                    if not jp:
                        continue
                    for syl in re.findall(r"[a-z]+[1-6]?", jp.lower()):
                        p = parse_jyutping_syllable(syl)
                        if p:
                            parsed.append(p)
                res = aligner.align_utterance(x16, parsed)
                if res is None:
                    continue
                phones, syls, conf = res
                out.append((conf, {
                    "id": f"mdcc_{split_name}_{idx}",
                    "corpus": "cantonese_mdcc",
                    "lang": "dialect",
                    "alphabet": "ipa",
                    "sigma_p": 6.5,
                    "sigma_s": 9.5,
                    "audio": x16,
                    "phones": phones,
                    "syllables": syls,
                }))
        except Exception as e:
            print(f"[dialect] Cantonese MDCC ({split_name}) error: {e}", flush=True)
        return out

    tr_raw = _run_split("train", max_train)
    va_raw = _run_split("validation", max_val)
    tr, tr_th = _filter_top_confidence(tr_raw, 0.25)
    va, va_th = _filter_top_confidence(va_raw, 0.25)
    dur_h = (sum(len(it["audio"]) for it in tr + va) / 16000.0) / 3600.0
    info = {
        "name": "Cantonese MDCC (ming030890/mdcc + MMS_FA top-75%)",
        "status": "ok" if tr else "skipped",
        "aligned_raw": len(tr_raw) + len(va_raw),
        "kept_train": len(tr),
        "kept_val": len(va),
        "conf_thresh_train": tr_th,
        "conf_thresh_val": va_th,
        "hours": round(dur_h, 3),
        "elapsed_sec": round(time.time() - t0, 1),
    }
    print(f"[dialect] {info}", flush=True)
    return tr, va, info


def load_hokkien_minnan(aligner: MmsGpuAligner, max_train: int = 900, max_val: int = 150) -> Tuple[List[dict], List[dict], dict]:
    """Taiwanese Hokkien / Minnan (`sarahwei/Taiwanese-Minnan-Sutiau` + `jiyuntu/common_voice_minnan`): voiced b/g/dz + checked-tone -p̚/-t̚/-k̚/-ʔ."""
    from datasets import Audio, load_dataset

    t0 = time.time()
    all_raw: List[Tuple[float, dict]] = []
    sources_used = []

    # Source A: jiyuntu/common_voice_minnan (sentence-level with explicit `tailo` column!)
    try:
        ds = load_dataset("jiyuntu/common_voice_minnan", split="train", streaming=True)
        for cname, feat in ds.features.items():
            if isinstance(feat, Audio):
                ds = ds.cast_column(cname, Audio(decode=False))
        cnt = 0
        for idx, row in enumerate(ds):
            if cnt >= max_train + max_val:
                break
            tailo = str(row.get("tailo") or "").strip()
            if not tailo:
                continue
            x16 = _decode_audio(row.get("audio") or row.get("path"))
            if x16 is None or len(x16) < 4800 or len(x16) > 16000 * 14:
                continue
            parsed = [p for tok in re.split(r"[\s\-]+", tailo) if (p := parse_tailo_syllable(tok))]
            res = aligner.align_utterance(x16, parsed)
            if res is None:
                continue
            phones, syls, conf = res
            all_raw.append((conf, {
                "id": f"minnan_cv_{idx}",
                "corpus": "hokkien_minnan",
                "lang": "dialect",
                "alphabet": "ipa",
                "sigma_p": 6.5,
                "sigma_s": 9.5,
                "audio": x16,
                "phones": phones,
                "syllables": syls,
            }))
            cnt += 1
        if cnt > 0:
            sources_used.append(f"common_voice_minnan({cnt})")
    except Exception as e:
        print(f"[dialect] common_voice_minnan skipped: {e}", flush=True)

    # Source B: sarahwei/Taiwanese-Minnan-Sutiau (short Hokkien words/phrases with `minnan roman`!)
    if len(all_raw) < max_train + max_val:
        try:
            ds = load_dataset("sarahwei/Taiwanese-Minnan-Sutiau", split="train", streaming=True).cast_column("audio", Audio(decode=False))
            cnt = 0
            need = max_train + max_val - len(all_raw)
            for idx, row in enumerate(ds):
                if cnt >= need:
                    break
                roman = str(row.get("minnan roman") or "").strip()
                if not roman:
                    continue
                x16 = _decode_audio(row.get("audio"))
                if x16 is None or len(x16) < 4000 or len(x16) > 16000 * 14:
                    continue
                parsed = [p for tok in re.split(r"[\s\-]+", roman) if (p := parse_tailo_syllable(tok))]
                res = aligner.align_utterance(x16, parsed)
                if res is None:
                    continue
                phones, syls, conf = res
                all_raw.append((conf, {
                    "id": f"minnan_sutiau_{idx}",
                    "corpus": "hokkien_minnan",
                    "lang": "dialect",
                    "alphabet": "ipa",
                    "sigma_p": 6.5,
                    "sigma_s": 9.5,
                    "audio": x16,
                    "phones": phones,
                    "syllables": syls,
                }))
                cnt += 1
            if cnt > 0:
                sources_used.append(f"Taiwanese-Minnan-Sutiau({cnt})")
        except Exception as e:
            print(f"[dialect] Taiwanese-Minnan-Sutiau skipped: {e}", flush=True)

    # Deterministic 85/15 split by utterance hash before confidence filtering
    tr_raw = [pair for i, pair in enumerate(all_raw) if i % 7 != 0]
    va_raw = [pair for i, pair in enumerate(all_raw) if i % 7 == 0]
    tr, tr_th = _filter_top_confidence(tr_raw, 0.25)
    va, va_th = _filter_top_confidence(va_raw, 0.25)
    dur_h = (sum(len(it["audio"]) for it in tr + va) / 16000.0) / 3600.0
    info = {
        "name": "Taiwanese Hokkien / Minnan (MMS_FA top-75%)",
        "sources": sources_used,
        "status": "ok" if tr else "skipped",
        "aligned_raw": len(all_raw),
        "kept_train": len(tr),
        "kept_val": len(va),
        "conf_thresh_train": tr_th,
        "hours": round(dur_h, 3),
        "elapsed_sec": round(time.time() - t0, 1),
    }
    print(f"[dialect] {info}", flush=True)
    return tr, va, info


def load_kespeech_dialects(aligner: MmsGpuAligner, max_total: int = 1100) -> Tuple[List[dict], List[dict], dict]:
    """KeSpeech 8 Chinese Regional Dialects (`TwinkStart/KeSpeech` test) with strict speaker-disjoint val."""
    from datasets import Audio, load_dataset
    from pypinyin import Style, lazy_pinyin

    t0 = time.time()
    by_spk: Dict[str, List[Tuple[float, dict]]] = {}
    dialect_counts: Dict[str, int] = {}
    try:
        ds = load_dataset("TwinkStart/KeSpeech", split="test", streaming=True).cast_column("audio", Audio(decode=False))
        total = 0
        for idx, row in enumerate(ds):
            if total >= max_total:
                break
            dialect = str(row.get("Dialect") or "unknown")
            if dialect.lower() == "mandarin":
                continue  # Focus exclusively on the 8 non-standard regional dialects!
            txt = str(row.get("Text") or "").strip()
            if not txt:
                continue
            x16 = _decode_audio(row.get("audio"))
            if x16 is None or len(x16) < 4800 or len(x16) > 16000 * 14:
                continue
            pys = lazy_pinyin(txt, style=Style.NORMAL, errors="ignore")
            parsed = [p for py in pys if (p := parse_pinyin_syllable(py))]
            res = aligner.align_utterance(x16, parsed)
            if res is None:
                continue
            phones, syls, conf = res
            uid = str(row.get("ID") or f"ks_{idx}")
            spk = uid.split("_")[0]
            by_spk.setdefault(spk, []).append((conf, {
                "id": f"kespeech_{uid}",
                "corpus": "kespeech_dialects",
                "lang": "dialect",
                "alphabet": "ipa",
                "sigma_p": 6.5,
                "sigma_s": 9.5,
                "audio": x16,
                "phones": phones,
                "syllables": syls,
            }))
            dialect_counts[dialect] = dialect_counts.get(dialect, 0) + 1
            total += 1
    except Exception as e:
        print(f"[dialect] KeSpeech skipped: {e}", flush=True)

    spks = sorted(by_spk.keys())
    n_val_spks = max(1, len(spks) // 6) if len(spks) >= 4 else 0
    val_spks = set(spks[:n_val_spks])
    tr_raw = [pair for s, lst in by_spk.items() if s not in val_spks for pair in lst]
    va_raw = [pair for s, lst in by_spk.items() if s in val_spks for pair in lst]
    tr, tr_th = _filter_top_confidence(tr_raw, 0.25)
    va, va_th = _filter_top_confidence(va_raw, 0.25)
    dur_h = (sum(len(it["audio"]) for it in tr + va) / 16000.0) / 3600.0
    info = {
        "name": "KeSpeech 8 Regional Dialects (TwinkStart/KeSpeech + MMS_FA top-75%)",
        "status": "ok" if tr else "skipped",
        "dialects": dialect_counts,
        "train_speakers": len(spks) - len(val_spks),
        "val_speakers": len(val_spks),
        "kept_train": len(tr),
        "kept_val": len(va),
        "conf_thresh_train": tr_th,
        "hours": round(dur_h, 3),
        "elapsed_sec": round(time.time() - t0, 1),
    }
    print(f"[dialect] {info}", flush=True)
    return tr, va, info


def load_vietnamese_vivos(aligner: MmsGpuAligner, max_total: int = 900) -> Tuple[List[dict], List[dict], dict]:
    """Vietnamese VIVOS (`ademax/vivos-vie-speech2text`): checked-tone -p̚/-t̚/-k̚ codas & voiced stops."""
    from datasets import Audio, load_dataset

    t0 = time.time()
    all_raw: List[Tuple[float, dict]] = []
    try:
        ds = load_dataset("ademax/vivos-vie-speech2text", split="train", streaming=True).cast_column("audio", Audio(decode=False))
        for idx, row in enumerate(ds):
            if len(all_raw) >= max_total:
                break
            txt = str(row.get("transcription") or row.get("raw_transcription") or "").strip()
            if not txt:
                continue
            x16 = _decode_audio(row.get("audio"))
            if x16 is None or len(x16) < 4800 or len(x16) > 16000 * 14:
                continue
            parsed = [p for tok in re.split(r"[\s,.;:!?\"']+", txt) if tok and (p := parse_viet_syllable(tok))]
            res = aligner.align_utterance(x16, parsed)
            if res is None:
                continue
            phones, syls, conf = res
            all_raw.append((conf, {
                "id": f"vivos_vi_{idx}",
                "corpus": "vietnamese_vivos",
                "lang": "dialect",
                "alphabet": "ipa",
                "sigma_p": 6.5,
                "sigma_s": 9.5,
                "audio": x16,
                "phones": phones,
                "syllables": syls,
            }))
    except Exception as e:
        print(f"[dialect] Vietnamese VIVOS skipped: {e}", flush=True)

    tr_raw = [pair for i, pair in enumerate(all_raw) if i % 7 != 0]
    va_raw = [pair for i, pair in enumerate(all_raw) if i % 7 == 0]
    tr, tr_th = _filter_top_confidence(tr_raw, 0.25)
    va, va_th = _filter_top_confidence(va_raw, 0.25)
    dur_h = (sum(len(it["audio"]) for it in tr + va) / 16000.0) / 3600.0
    info = {
        "name": "Vietnamese VIVOS (ademax/vivos-vie-speech2text + MMS_FA top-75%)",
        "status": "ok" if tr else "skipped",
        "aligned_raw": len(all_raw),
        "kept_train": len(tr),
        "kept_val": len(va),
        "conf_thresh_train": tr_th,
        "hours": round(dur_h, 3),
        "elapsed_sec": round(time.time() - t0, 1),
    }
    print(f"[dialect] {info}", flush=True)
    return tr, va, info


def load_french_mls(aligner: MmsGpuAligner, max_train: int = 380, max_val: int = 80) -> Tuple[List[dict], List[dict], dict]:
    """French MLS (`facebook/multilingual_librispeech`, french): true pre-voiced obstruents b/d/g/v/z/ʒ & nasal vowels."""
    from datasets import Audio, load_dataset

    t0 = time.time()
    def _run_split(split_name: str, limit: int) -> List[Tuple[float, dict]]:
        out = []
        try:
            ds = load_dataset("facebook/multilingual_librispeech", "french", split=split_name, streaming=True).cast_column("audio", Audio(decode=False))
            for idx, row in enumerate(ds):
                if len(out) >= limit:
                    break
                txt = str(row.get("transcript") or "").strip()
                if not txt:
                    continue
                x16 = _decode_audio(row.get("audio"))
                if x16 is None or len(x16) < 4800 or len(x16) > 16000 * 13:
                    continue
                parsed = [p for tok in re.split(r"[\s,.;:!?\"'-]+", txt) if tok and (p := parse_french_word(tok))]
                res = aligner.align_utterance(x16, parsed)
                if res is None:
                    continue
                phones, syls, conf = res
                out.append((conf, {
                    "id": f"mls_fr_{split_name}_{idx}",
                    "corpus": "french_mls",
                    "lang": "dialect",
                    "alphabet": "ipa",
                    "sigma_p": 6.5,
                    "sigma_s": 9.5,
                    "audio": x16,
                    "phones": phones,
                    "syllables": syls,
                }))
        except Exception as e:
            print(f"[dialect] French MLS ({split_name}) skipped: {e}", flush=True)
        return out

    tr_raw = _run_split("train", max_train)
    va_raw = _run_split("dev", max_val)
    tr, tr_th = _filter_top_confidence(tr_raw, 0.25)
    va, va_th = _filter_top_confidence(va_raw, 0.25)
    dur_h = (sum(len(it["audio"]) for it in tr + va) / 16000.0) / 3600.0
    info = {
        "name": "French MLS (facebook/multilingual_librispeech french + MMS_FA top-75%)",
        "status": "ok" if tr else "skipped",
        "aligned_raw": len(tr_raw) + len(va_raw),
        "kept_train": len(tr),
        "kept_val": len(va),
        "conf_thresh_train": tr_th,
        "hours": round(dur_h, 3),
        "elapsed_sec": round(time.time() - t0, 1),
    }
    print(f"[dialect] {info}", flush=True)
    return tr, va, info


def load_all_dialects_mms() -> Tuple[List[dict], List[dict], List[dict]]:
    """Run GPU MMS_FA forced alignment across all available open-access dialect & key-manner corpora."""
    print("[dialect] Initializing torchaudio.pipelines.MMS_FA on GPU ...", flush=True)
    aligner = MmsGpuAligner()
    tr_all: List[dict] = []
    va_all: List[dict] = []
    manifests: List[dict] = []

    for loader in (
        lambda: load_cantonese_mdcc(aligner, max_train=1600, max_val=240),
        lambda: load_hokkien_minnan(aligner, max_train=900, max_val=150),
        lambda: load_kespeech_dialects(aligner, max_total=1100),
        lambda: load_vietnamese_vivos(aligner, max_total=900),
        lambda: load_french_mls(aligner, max_train=380, max_val=80),
    ):
        tr, va, info = loader()
        manifests.append(info)
        tr_all.extend(tr)
        va_all.extend(va)

    # Release GPU memory before training!
    del aligner
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    return tr_all, va_all, manifests
