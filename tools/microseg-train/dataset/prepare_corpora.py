"""
Multilingual & Dialect Corpus Preparation Pipeline for TGrid-AcouSeg 1.0.

Default 9-corpus balanced mix (~26% Mandarin + ~30% Dialects/Key-Manner + ~30% English/Multi-accent + 15% Hard Negatives):
  1. Mandarin Chinese:
     - Default: THCHS-30 (`urarik/thchs30` + `anyspeech/THCHS-30-alignments`, strict A/B/C vs D speaker split)
     - Optional (`--mandarin-source aishell3`): AISHELL-3 (OpenSLR SLR93 + lars76 IPA TextGrids)
  2. Chinese Dialects & Key Phonetic Classes (`dataset/align_dialects_mms.py`, optional via `--skip-dialects`):
     - Cantonese MDCC, Taiwanese Hokkien / Minnan, KeSpeech 8 Regional Dialects, Vietnamese VIVOS, French MLS
  3. English & Multi-Accent:
     - TIMIT (`kylelovesllms/timit_asr`) - gold manual phones + explicit closures + words
     - L2-ARCTIC v5.0 (`chikingsley/l2-arctic-release-v5.0`) - 10 diverse L1 speakers, speaker-disjoint val
     - LibriSpeech MFA (`gilkeyio/librispeech-alignments`) - natural continuous English speech
  4. Fieldwork Noise & Augmentations:
     - ESC-50 (`ashraq/esc50`) + optional OpenSLR SLR28 RIRS_NOISES (synthetic RIR fallback)
     - 9 fieldwork/whisper/isolated-token augmentations + 15% pure non-speech hard negatives
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import subprocess
import sys
import time
import zipfile
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dataset.augment_field import augment_utterance, build_isolated_token_clip, generate_pure_negative_clip
from dataset.ipa_manner_map import build_frame_targets, map_phone_to_manner_checked
from model.features_ref import extract_features_from_clean_16k


def fast_resample_to_16k(arr: np.ndarray, sr: int) -> np.ndarray:
    """Fast C-accelerated DC-removed band-limited resampler to 16 kHz for corpus loading."""
    x = np.asarray(arr, dtype=np.float32).reshape(-1)
    if x.size == 0 or sr <= 0:
        return np.zeros((0,), dtype=np.float32)
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    x = x - np.float32(np.mean(x, dtype=np.float64))
    if sr == 16000:
        return x.astype(np.float32)
    g = math.gcd(16000, int(sr))
    up = 16000 // g
    down = int(sr) // g
    y = resample_poly(x.astype(np.float64), up, down)
    return y.astype(np.float32)


def _decode_audio_dict(audio_dict: dict) -> Optional[np.ndarray]:
    if audio_dict is None:
        return None
    if "array" in audio_dict and audio_dict["array"] is not None:
        arr = np.asarray(audio_dict["array"], dtype=np.float32)
        sr = int(audio_dict["sampling_rate"])
    elif audio_dict.get("bytes"):
        arr, sr = sf.read(io.BytesIO(audio_dict["bytes"]), dtype="float32")
    elif audio_dict.get("path") and os.path.exists(audio_dict["path"]):
        arr, sr = sf.read(audio_dict["path"], dtype="float32")
    else:
        return None
    if arr.ndim == 2:
        arr = np.mean(arr, axis=1)
    return fast_resample_to_16k(arr, int(sr))


def parse_textgrid_str(text: str) -> Dict[str, List[Tuple[float, float, str]]]:
    tiers: Dict[str, List[Tuple[float, float, str]]] = {}
    blocks = re.split(r"\bitem\s*\[\d+\]\s*:", text)
    if len(blocks) <= 1:
        return tiers
    for blk in blocks[1:]:
        m_class = re.search(r'class\s*=\s*"([^"]+)"', blk)
        if not m_class or "IntervalTier" not in m_class.group(1):
            continue
        m_name = re.search(r'name\s*=\s*"([^"]*)"', blk)
        tname = m_name.group(1).strip().lower() if m_name else "tier"
        ivs = [
            (float(m.group(1)), float(m.group(2)), m.group(3).strip())
            for m in re.finditer(
                r'xmin\s*=\s*([0-9.eE+-]+)\s+xmax\s*=\s*([0-9.eE+-]+)\s+text\s*=\s*"([^"]*)"',
                blk,
            )
        ]
        if ivs:
            tiers[tname] = ivs
    return tiers


def audit_phone_coverage(items: List[dict]) -> dict:
    """Verify 100% explicit IPA/ARPAbet/TIMIT mapping coverage (zero unintended fallback)."""
    total_tokens = 0
    unmapped = Counter()
    unique_mapped = set()
    for it in items:
        alpha = it["alphabet"]
        for _, _, lbl in it["phones"]:
            total_tokens += 1
            _, matched = map_phone_to_manner_checked(lbl, alphabet=alpha)
            if matched:
                unique_mapped.add(lbl.strip())
            else:
                unmapped[f"{alpha}:{lbl.strip()}"] += 1
    return {
        "total_phone_tokens": total_tokens,
        "unique_mapped_symbols": len(unique_mapped),
        "unmapped_count": sum(unmapped.values()),
        "unmapped_top20": unmapped.most_common(20),
    }


def _load_aishell3_shard(args_tuple: Tuple[str, List[Tuple[str, str, str]]]) -> List[dict]:
    """Worker: read extracted AISHELL-3 wavs + matching TextGrids from zip and resample to 16 kHz."""
    tg_zip_path, entries = args_tuple
    out: List[dict] = []
    with zipfile.ZipFile(tg_zip_path, "r") as zf:
        for utt_id, wav_path, tg_member in entries:
            try:
                tg_text = zf.read(tg_member).decode("utf-8", errors="replace")
                tiers = parse_textgrid_str(tg_text)
                phones = tiers.get("phones") or tiers.get("phone")
                syllables = tiers.get("pinyins") or tiers.get("hanzis") or tiers.get("words") or tiers.get("word")
                if not phones or len(phones) < 4:
                    continue
                arr, sr = sf.read(wav_path, dtype="float32")
                if arr.ndim == 2:
                    arr = np.mean(arr, axis=1)
                x16 = fast_resample_to_16k(arr, int(sr))
                if len(x16) < 4800 or len(x16) > 16000 * 14:
                    continue
                out.append({
                    "id": f"aishell3_{utt_id}",
                    "corpus": "aishell3",
                    "lang": "zh",
                    "alphabet": "ipa",
                    "sigma_p": 5.0,
                    "sigma_s": 8.5,
                    "audio": x16,
                    "phones": phones,
                    "syllables": syllables,
                })
            except Exception:
                continue
    return out


def load_aishell3_lars76(
    work_dir: Path,
    train_spks_n: int = 80,
    val_spks_n: int = 12,
    max_per_train_spk: int = 85,
    max_per_val_spk: int = 68,
    workers: int = 8,
) -> Tuple[List[dict], List[dict], dict]:
    """
    Download OpenSLR SLR93 AISHELL-3 + lars76/forced-alignment-chinese IPA TextGrids.
    Performs strict speaker-ID (SSBxxxx) disjoint train/val split and selective tar extraction
    so disk usage remains compact (< 25 GB peak, tgz deleted immediately after extraction).
    """
    tg_zip = work_dir / "aishell3_textgrid_files.zip"
    tg_url = "https://github.com/lars76/forced-alignment-chinese/releases/download/textgrid_files/aishell3_textgrid_files.zip"
    try:
        if not tg_zip.exists():
            print("[corpus] Downloading lars76 AISHELL-3 IPA TextGrids ...", flush=True)
            subprocess.run(
                ["aria2c", "-c", "-x", "16", "-s", "16", "-k", "1M", tg_url, "-d", str(work_dir), "-o", tg_zip.name],
                check=True,
                timeout=300,
            )
    except Exception as e:
        print(f"[corpus] AISHELL-3 TextGrid download failed: {e}", flush=True)
        return [], [], {"name": "AISHELL-3 (SLR93 + lars76 IPA)", "status": f"tg_failed: {e}"}

    # Index all TextGrids by speaker ID (SSBxxxx)
    spk_to_tgs: Dict[str, List[Tuple[str, str]]] = {}
    with zipfile.ZipFile(tg_zip, "r") as zf:
        for name in zf.namelist():
            if not name.endswith(".TextGrid") or "__MACOSX" in name:
                continue
            stem = Path(name).stem
            m = re.match(r"^(SSB\d{4})", stem)
            if not m:
                continue
            spk = m.group(1)
            spk_to_tgs.setdefault(spk, []).append((stem, name))

    eligible_spks = sorted(s for s, lst in spk_to_tgs.items() if len(lst) >= 40)
    rng = np.random.default_rng(2026)
    rng.shuffle(eligible_spks)

    val_spks = sorted(eligible_spks[:val_spks_n])
    train_spks = sorted(eligible_spks[val_spks_n : val_spks_n + train_spks_n])
    assert set(train_spks).isdisjoint(set(val_spks)), "AISHELL-3 speaker leak!"
    selected_spks = set(train_spks) | set(val_spks)
    print(
        f"[corpus] AISHELL-3 indexed {len(spk_to_tgs)} spks; selected {len(train_spks)} train + {len(val_spks)} val spks",
        flush=True,
    )

    # Extract only selected speaker wavs from OpenSLR SLR93 data_aishell3.tgz
    wav_root = work_dir / "aishell3_wavs"
    wav_root.mkdir(parents=True, exist_ok=True)
    existing_wavs = list(wav_root.rglob("*.wav"))
    if len(existing_wavs) < 3000:
        tgz_path = work_dir / "data_aishell3.tgz"
        aria2_ctrl = work_dir / "data_aishell3.tgz.aria2"
        if (not tgz_path.exists()) or aria2_ctrl.exists():
            urls = [
                "https://www.openslr.org/resources/93/data_aishell3.tgz",
                "https://openslr.magicdatatech.com/resources/93/data_aishell3.tgz",
            ]
            downloaded = False
            for url in urls:
                try:
                    print(f"[corpus] Downloading/resuming OpenSLR SLR93 data_aishell3.tgz from {url} ...", flush=True)
                    subprocess.run(
                        ["aria2c", "-c", "-x", "16", "-s", "16", "-k", "4M", "--max-tries=5", "--retry-wait=3", url, "-d", str(work_dir), "-o", tgz_path.name],
                        check=True,
                        timeout=1200,
                    )
                    if not aria2_ctrl.exists():
                        downloaded = True
                        break
                except Exception as e:
                    print(f"[corpus] Mirror failed ({url}): {e}", flush=True)
            if not downloaded:
                return [], [], {"name": "AISHELL-3 (SLR93 + lars76 IPA)", "status": "audio_download_failed"}

        # Single-pass selective extraction of only the selected speaker folders
        patterns = [f"*/{spk}/*.wav" for spk in sorted(selected_spks)]
        print(f"[corpus] Selectively extracting {len(selected_spks)} speakers from data_aishell3.tgz ...", flush=True)
        t_ext = time.time()
        cmd = ["tar", "-xzf", str(tgz_path), "-C", str(wav_root), "--wildcards", *patterns]
        subprocess.run(cmd, check=True, timeout=600)
        print(f"[corpus] Extracted selected AISHELL-3 speakers in {time.time() - t_ext:.1f}s", flush=True)
        # Immediately remove 19 GB archive to free Colab disk
        try:
            tgz_path.unlink()
        except OSError:
            pass
        existing_wavs = list(wav_root.rglob("*.wav"))

    wav_map = {p.stem: str(p) for p in existing_wavs}
    print(f"[corpus] AISHELL-3 matched wav files on disk: {len(wav_map)}", flush=True)

    train_entries: List[Tuple[str, str, str]] = []
    val_entries: List[Tuple[str, str, str]] = []
    for spk in train_spks:
        cands = [(st, wav_map[st], tg) for (st, tg) in sorted(spk_to_tgs[spk]) if st in wav_map]
        train_entries.extend(cands[:max_per_train_spk])
    for spk in val_spks:
        cands = [(st, wav_map[st], tg) for (st, tg) in sorted(spk_to_tgs[spk]) if st in wav_map]
        val_entries.extend(cands[:max_per_val_spk])

    def _run_parallel(entries: List[Tuple[str, str, str]]) -> List[dict]:
        if not entries:
            return []
        n_sh = max(1, min(workers * 2, len(entries)))
        shards = [(str(tg_zip), entries[i::n_sh]) for i in range(n_sh)]
        res: List[dict] = []
        with ProcessPoolExecutor(max_workers=workers) as ex:
            for chunk in ex.map(_load_aishell3_shard, shards):
                res.extend(chunk)
        return res

    t0 = time.time()
    tr = _run_parallel(train_entries)
    va = _run_parallel(val_entries)
    dur_h = (sum(len(it["audio"]) for it in tr + va) / 16000.0) / 3600.0
    cov = audit_phone_coverage(tr + va)
    info = {
        "name": "AISHELL-3 (OpenSLR SLR93 + lars76 IPA TextGrids)",
        "status": "ok" if tr else "empty",
        "train_speakers": len(train_spks),
        "val_speakers": len(val_spks),
        "val_speaker_ids": val_spks,
        "train_utts": len(tr),
        "val_utts": len(va),
        "hours": round(dur_h, 3),
        "load_sec": round(time.time() - t0, 1),
        "ipa_audit": cov,
    }
    print(f"[corpus] {info}", flush=True)
    return tr, va, info


def load_thchs30_hf(max_train: int = 1750, max_val: int = 260) -> Tuple[List[dict], List[dict], dict]:
    """
    Fast HF Parquet Mandarin corpus: `urarik/thchs30` (16 kHz native WAV) joined 1-to-1 by utterance ID
    with `anyspeech/THCHS-30-alignments` (13,388 gold IPA phone + word timestamps, 50 speakers).
    Strictly speaker-disjoint split by speaker prefix (`A*/B*/C*` train vs `D*` unseen val speakers).
    """
    from datasets import Audio, load_dataset

    t0 = time.time()
    print("[corpus] Loading anyspeech/THCHS-30-alignments (13,388 gold Mandarin IPA alignments) ...", flush=True)
    aln_ds = load_dataset("anyspeech/THCHS-30-alignments", split="train")
    by_id = {row["id"]: row for row in aln_ds}

    def _stream(split_name: str, limit: int, allowed_prefixes: Tuple[str, ...]) -> Tuple[List[dict], set]:
        out: List[dict] = []
        spks = set()
        ds = load_dataset("urarik/thchs30", split=split_name, streaming=True).cast_column("audio", Audio(decode=False))
        for row in ds:
            if len(out) >= limit:
                break
            ap = row["audio"].get("path") or ""
            stem = Path(ap).stem
            if stem not in by_id:
                continue
            spk = stem.split("_")[0]
            if not spk.startswith(allowed_prefixes):
                continue
            a_row = by_id[stem]
            x16 = _decode_audio_dict(row["audio"])
            if x16 is None or len(x16) < 4800 or len(x16) > 16000 * 16:
                continue
            phones = [
                (float(s), float(e), str(p))
                for s, e, p in zip(a_row["start"], a_row["end"], a_row["phones"])
                if float(e) > float(s)
            ]
            words = [
                (float(s), float(e), str(w))
                for s, e, w in zip(a_row["word_start"], a_row["word_end"], a_row["words"])
                if float(e) > float(s) and str(w) != "[SIL]"
            ]
            if len(phones) < 4:
                continue
            spks.add(spk)
            out.append({
                "id": f"thchs30_{stem}",
                "corpus": "thchs30_zh",
                "lang": "zh",
                "alphabet": "ipa",
                "sigma_p": 5.0,
                "sigma_s": 9.0,
                "audio": x16,
                "phones": phones,
                "syllables": words if len(words) >= 2 else None,
            })
        return out, spks

    tr, tr_spks = _stream("train", max_train, ("A", "B", "C"))
    va, va_spks = _stream("test", max_val, ("D",))
    if len(va) < max_val // 2:
        # Also draw unseen D* speakers from train split if test had fewer D* rows
        va_extra, va_spks_extra = _stream("train", max_val - len(va), ("D",))
        va.extend(va_extra)
        va_spks |= va_spks_extra
    assert tr_spks.isdisjoint(va_spks), f"THCHS-30 speaker leak: {tr_spks & va_spks}"

    dur_h = (sum(len(it["audio"]) for it in tr + va) / 16000.0) / 3600.0
    cov = audit_phone_coverage(tr + va)
    info = {
        "name": "THCHS-30 Mandarin (urarik/thchs30 + anyspeech/THCHS-30-alignments IPA)",
        "status": "ok" if tr else "empty",
        "train_speakers": len(tr_spks),
        "val_speakers": len(va_spks),
        "val_speaker_ids": sorted(va_spks),
        "train_utts": len(tr),
        "val_utts": len(va),
        "hours": round(dur_h, 3),
        "load_sec": round(time.time() - t0, 1),
        "ipa_audit": cov,
    }
    print(f"[corpus] {info}", flush=True)
    return tr, va, info


def load_timit_hf(max_train: int = 4620, max_val: int = 600) -> Tuple[List[dict], List[dict], dict]:
    from datasets import Audio, load_dataset

    try:
        print("[corpus] Loading kylelovesllms/timit_asr (train & test) ...", flush=True)
        ds_tr = load_dataset("kylelovesllms/timit_asr", split="train").cast_column("audio", Audio(decode=False))
        ds_te = load_dataset("kylelovesllms/timit_asr", split="test").cast_column("audio", Audio(decode=False))
    except Exception as e:
        print(f"[corpus] TIMIT failed: {e}", flush=True)
        return [], [], {"name": "TIMIT (kylelovesllms/timit_asr)", "status": f"failed: {e}"}

    def _parse(ds, limit: int) -> List[dict]:
        out = []
        for idx, row in enumerate(ds):
            if len(out) >= limit:
                break
            try:
                x16 = _decode_audio_dict(row["audio"])
                if x16 is None or len(x16) < 3200:
                    continue
                ph_raw = row.get("phonetic_detail") or []
                phones = []
                if isinstance(ph_raw, list) and ph_raw and isinstance(ph_raw[0], dict):
                    max_t = max(float(p["stop"]) for p in ph_raw)
                    scale = 1.0 / 16000.0 if max_t > 20.0 else 1.0
                    for p in ph_raw:
                        phones.append((float(p["start"]) * scale, float(p["stop"]) * scale, str(p["utterance"])))
                if len(phones) < 4:
                    continue
                w_raw = row.get("word_detail") or []
                words = None
                if isinstance(w_raw, list) and w_raw and isinstance(w_raw[0], dict):
                    max_w = max(float(w["stop"]) for w in w_raw)
                    wscale = 1.0 / 16000.0 if max_w > 20.0 else 1.0
                    words = [(float(w["start"]) * wscale, float(w["stop"]) * wscale, str(w["utterance"])) for w in w_raw]
                out.append({
                    "id": f"timit_{idx}",
                    "corpus": "timit",
                    "lang": "en",
                    "alphabet": "timit",
                    "sigma_p": 4.8,
                    "sigma_s": 9.5,
                    "audio": x16,
                    "phones": phones,
                    "syllables": words,
                })
            except Exception:
                continue
        return out

    tr = _parse(ds_tr, max_train)
    va = _parse(ds_te, max_val)
    dur_h = (sum(len(it["audio"]) for it in tr + va) / 16000.0) / 3600.0
    info = {
        "name": "TIMIT (kylelovesllms/timit_asr)",
        "status": "ok",
        "train_utts": len(tr),
        "val_utts": len(va),
        "hours": round(dur_h, 3),
        "ipa_audit": audit_phone_coverage(tr + va),
    }
    print(f"[corpus] {info}", flush=True)
    return tr, va, info


def _load_single_l2_speaker(args_tuple: Tuple[str, str, int]) -> Tuple[str, List[dict]]:
    spk, zip_dir, max_utts = args_tuple
    from huggingface_hub import hf_hub_download

    out = []
    try:
        zpath = hf_hub_download(
            repo_id="chikingsley/l2-arctic-release-v5.0",
            filename=f"{spk}.zip",
            repo_type="dataset",
            local_dir=zip_dir,
        )
        with zipfile.ZipFile(zpath, "r") as zf:
            names = zf.namelist()
            ann_tgs = {Path(n).stem: n for n in names if "/annotation/" in n.lower() and n.endswith(".TextGrid")}
            auto_tgs = {Path(n).stem: n for n in names if "/textgrid/" in n.lower() and n.endswith(".TextGrid")}
            wavs = {Path(n).stem: n for n in names if n.endswith(".wav") and "__MACOSX" not in n}
            stems = sorted(set(wavs.keys()) & (set(ann_tgs.keys()) | set(auto_tgs.keys())))
            stems.sort(key=lambda s: (0 if s in ann_tgs else 1, s))
            for st in stems[:max_utts]:
                try:
                    tg_member = ann_tgs.get(st) or auto_tgs[st]
                    is_manual = st in ann_tgs
                    tg_text = zf.read(tg_member).decode("utf-8", errors="replace")
                    tiers = parse_textgrid_str(tg_text)
                    phones = tiers.get("phones") or tiers.get("phone")
                    words = tiers.get("words") or tiers.get("word")
                    if not phones or len(phones) < 4:
                        continue
                    raw_wav = zf.read(wavs[st])
                    arr, sr = sf.read(io.BytesIO(raw_wav), dtype="float32")
                    if arr.ndim == 2:
                        arr = np.mean(arr, axis=1)
                    x16 = fast_resample_to_16k(arr, int(sr))
                    if len(x16) < 3200:
                        continue
                    out.append({
                        "id": f"l2a_{spk}_{st}",
                        "corpus": "l2arctic",
                        "lang": "en_l2",
                        "alphabet": "arpa",
                        "sigma_p": 5.0 if is_manual else 6.0,
                        "sigma_s": 9.5,
                        "audio": x16,
                        "phones": phones,
                        "syllables": words,
                    })
                except Exception:
                    continue
        print(f"[corpus] L2-ARCTIC {spk}: loaded {len(out)} utts", flush=True)
    except Exception as e:
        print(f"[corpus] L2-ARCTIC {spk} skipped: {e}", flush=True)
    return spk, out


def load_l2arctic_zips(
    work_dir: Path,
    train_speakers=("BWC", "LXC", "NCC", "HKK", "HJK", "ABA", "ASI", "EBVS"),
    val_speakers=("TXHC", "THV"),
    max_per_train_spk: int = 230,
    max_per_val_spk: int = 200,
    workers: int = 8,
) -> Tuple[List[dict], List[dict], dict]:
    """Download & resample 10 L2-ARCTIC speakers in parallel across all CPU cores!"""
    zip_dir = str(work_dir / "l2arctic_zips")
    tasks = [(s, zip_dir, max_per_train_spk) for s in train_speakers] + [
        (s, zip_dir, max_per_val_spk) for s in val_speakers
    ]
    val_set = set(val_speakers)
    tr_items: List[dict] = []
    va_items: List[dict] = []
    used_spks: List[str] = []

    with ProcessPoolExecutor(max_workers=min(workers, len(tasks))) as ex:
        for spk, items in ex.map(_load_single_l2_speaker, tasks):
            if items:
                used_spks.append(spk)
                if spk in val_set:
                    va_items.extend(items)
                else:
                    tr_items.extend(items)

    dur_h = (sum(len(it["audio"]) for it in tr_items + va_items) / 16000.0) / 3600.0
    info = {
        "name": "L2-ARCTIC v5.0 (chikingsley/l2-arctic-release-v5.0)",
        "status": "ok" if (tr_items or va_items) else "skipped",
        "speakers": used_spks,
        "train_utts": len(tr_items),
        "val_utts": len(va_items),
        "hours": round(dur_h, 3),
        "ipa_audit": audit_phone_coverage(tr_items + va_items),
    }
    print(f"[corpus] {info}", flush=True)
    return tr_items, va_items, info


def load_librispeech_mfa_hf(max_train: int = 420, max_val: int = 120) -> Tuple[List[dict], List[dict], dict]:
    """Load natural English speech with MFA alignments from gilkeyio/librispeech-alignments (`phonemes` key)."""
    from datasets import Audio, load_dataset

    def _stream(split_name: str, limit: int) -> List[dict]:
        out = []
        try:
            ds = load_dataset("gilkeyio/librispeech-alignments", split=split_name, streaming=True)
            for cname, feat in ds.features.items():
                if isinstance(feat, Audio):
                    ds = ds.cast_column(cname, Audio(decode=False))
            for idx, row in enumerate(ds):
                if len(out) >= limit:
                    break
                if idx == 0:
                    print(f"[corpus] librispeech-alignments({split_name}) keys: {list(row.keys())}", flush=True)
                x16 = _decode_audio_dict(row.get("audio"))
                if x16 is None or len(x16) < 4000 or len(x16) > 16000 * 13:
                    continue
                phones = []
                words = None
                ph_field = row.get("phonemes") or row.get("phones") or row.get("phone_alignments")
                if isinstance(ph_field, list) and ph_field and isinstance(ph_field[0], dict):
                    for p in ph_field:
                        ts = float(p.get("start", p.get("begin", 0.0)))
                        te = float(p.get("end", p.get("stop", 0.0)))
                        lbl = str(p.get("phoneme", p.get("phone", p.get("label", p.get("text", "")))))
                        phones.append((ts, te, lbl))
                elif isinstance(ph_field, dict) and "start" in ph_field:
                    lbl_key = next((k for k in ("phoneme", "phone", "utterance", "label", "text") if k in ph_field), None)
                    end_key = "end" if "end" in ph_field else "stop"
                    if lbl_key is not None:
                        for s, e, l in zip(ph_field["start"], ph_field[end_key], ph_field[lbl_key]):
                            phones.append((float(s), float(e), str(l)))

                w_field = row.get("words") or row.get("word_alignments")
                if isinstance(w_field, list) and w_field and isinstance(w_field[0], dict):
                    words = [
                        (float(w.get("start", 0.0)), float(w.get("end", w.get("stop", 0.0))), str(w.get("word", w.get("text", ""))))
                        for w in w_field
                    ]
                elif isinstance(w_field, dict) and "start" in w_field:
                    lbl_key = next((k for k in ("word", "utterance", "label", "text") if k in w_field), None)
                    end_key = "end" if "end" in w_field else "stop"
                    if lbl_key is not None:
                        words = [(float(s), float(e), str(l)) for s, e, l in zip(w_field["start"], w_field[end_key], w_field[lbl_key])]

                if len(phones) < 4:
                    continue
                out.append({
                    "id": f"ls_{split_name}_{idx}",
                    "corpus": "librispeech_mfa",
                    "lang": "en",
                    "alphabet": "arpa",
                    "sigma_p": 6.0,
                    "sigma_s": 9.5,
                    "audio": x16,
                    "phones": phones,
                    "syllables": words,
                })
        except Exception as e:
            print(f"[corpus] librispeech-alignments({split_name}) skipped: {e}", flush=True)
        return out

    tr = _stream("train_clean_100", max_train)
    va = _stream("dev_clean", max_val)
    dur_h = (sum(len(it["audio"]) for it in tr + va) / 16000.0) / 3600.0
    info = {
        "name": "LibriSpeech MFA (gilkeyio/librispeech-alignments)",
        "status": "ok" if tr else "skipped",
        "train_utts": len(tr),
        "val_utts": len(va),
        "hours": round(dur_h, 3),
        "ipa_audit": audit_phone_coverage(tr + va) if (tr or va) else None,
    }
    print(f"[corpus] {info}", flush=True)
    return tr, va, info


def load_noise_and_rirs(work_dir: Path, max_noises: int = 250, max_rirs: int = 150) -> Tuple[List[np.ndarray], List[np.ndarray], dict]:
    noise_pool: List[np.ndarray] = []
    rir_pool: List[np.ndarray] = []
    sources: List[str] = []

    try:
        from datasets import Audio, load_dataset
        print("[corpus] Loading ESC-50 noises (ashraq/esc50) ...", flush=True)
        ds = load_dataset("ashraq/esc50", split="train", streaming=True).cast_column("audio", Audio(decode=False))
        for row in ds:
            if len(noise_pool) >= max_noises:
                break
            x16 = _decode_audio_dict(row.get("audio"))
            if x16 is not None and len(x16) >= 8000:
                noise_pool.append(x16)
        sources.append(f"HF ashraq/esc50 ({len(noise_pool)} clips)")
    except Exception as e:
        print(f"[corpus] ESC-50 skipped: {e}", flush=True)

    try:
        rir_zip = work_dir / "rirs_noises.zip"
        url = "https://www.openslr.org/resources/28/rirs_noises.zip"
        if not rir_zip.exists():
            print("[corpus] Downloading OpenSLR SLR28 RIRS_NOISES (1.3 GB) via aria2c ...", flush=True)
            subprocess.run(
                ["aria2c", "-c", "-x", "16", "-s", "16", "-k", "1M", url, "-d", str(work_dir), "-o", "rirs_noises.zip"],
                check=True,
                timeout=45,
            )
        with zipfile.ZipFile(rir_zip, "r") as zf:
            rng = np.random.default_rng(42)
            rir_names = [n for n in zf.namelist() if ("real_rirs" in n or "simulated_rirs" in n) and n.endswith(".wav")]
            rng.shuffle(rir_names)
            for name in rir_names[:max_rirs]:
                try:
                    data, sr = sf.read(io.BytesIO(zf.read(name)), dtype="float32")
                    if data.ndim == 2:
                        data = data[:, 0]
                    x16 = fast_resample_to_16k(data, int(sr))
                    if len(x16) >= 64:
                        rir_pool.append(x16)
                except Exception:
                    continue
        sources.append(f"OpenSLR SLR28 RIRS_NOISES ({len(rir_pool)} RIRs)")
    except Exception as e:
        print(f"[corpus] RIRS_NOISES skipped (synthetic RIR fallback active): {e}", flush=True)

    info = {"noises": len(noise_pool), "rirs": len(rir_pool), "sources": sources}
    print(f"[corpus] Noise/RIR pool: {info}", flush=True)
    return noise_pool, rir_pool, info


# Globals populated before ProcessPoolExecutor fork on Linux for zero-copy sharing!
_G_NOISE_POOL: List[np.ndarray] = []
_G_RIR_POOL: List[np.ndarray] = []
_G_CHUNK_FRAMES: int = 400
_G_AUG_COPIES: int = 2
_G_IS_TRAIN: bool = True
_G_ISOLATED_PROB: float = 0.0


def _pack_single_clip(
    x16: np.ndarray,
    phones,
    syllables,
    alphabet: str,
    sigma_p: float,
    sigma_s: float,
    chunk_frames: int,
    is_train: bool,
):
    feat = extract_features_from_clean_16k(x16)
    t_len = feat.shape[0]
    if t_len < 15:
        return []
    tgt = build_frame_targets(
        t_len,
        x16,
        phones,
        syllables=syllables,
        alphabet=alphabet,
        sigma_phone_ms=sigma_p,
        sigma_syl_ms=sigma_s,
        has_phone_tier=True,
    )
    out = []
    if t_len <= chunk_frames:
        pad_t = chunk_frames - t_len
        out.append((
            np.pad(feat, ((0, pad_t), (0, 0)), mode="edge").astype(np.float16),
            np.pad(tgt["manner"], (0, pad_t), constant_values=0).astype(np.uint8),
            np.pad(tgt["manner_mask"], (0, pad_t), constant_values=0.0).astype(np.uint8),
            np.pad(tgt["pbnd"], ((0, pad_t), (0, 0)), constant_values=0.0).astype(np.float16),
            np.pad(tgt["pbnd_mask"], ((0, pad_t), (0, 0)), constant_values=0.0).astype(np.uint8),
            np.pad(tgt["sbnd"], (0, pad_t), constant_values=0.0).astype(np.float16),
            np.pad(tgt["sbnd_mask"], (0, pad_t), constant_values=0.0).astype(np.uint8),
            np.pad(tgt["vad"], (0, pad_t), constant_values=0.0).astype(np.float16),
            np.pad(tgt["vad_mask"], (0, pad_t), constant_values=0.0).astype(np.uint8),
        ))
    else:
        stride = chunk_frames // 2 if is_train else chunk_frames
        starts = list(range(0, t_len - chunk_frames + 1, stride))
        if starts[-1] + chunk_frames < t_len:
            starts.append(t_len - chunk_frames)
        for st in starts:
            en = st + chunk_frames
            out.append((
                feat[st:en].astype(np.float16),
                tgt["manner"][st:en].astype(np.uint8),
                tgt["manner_mask"][st:en].astype(np.uint8),
                tgt["pbnd"][st:en].astype(np.float16),
                tgt["pbnd_mask"][st:en].astype(np.uint8),
                tgt["sbnd"][st:en].astype(np.float16),
                tgt["sbnd_mask"][st:en].astype(np.uint8),
                tgt["vad"][st:en].astype(np.float16),
                tgt["vad_mask"][st:en].astype(np.uint8),
            ))
    return out


def _process_item_shard(shard_tuple: Tuple[int, List[dict]]):
    shard_id, items = shard_tuple
    rng = np.random.default_rng(2026 + shard_id * 997)
    chunks = []
    corpus_counts: Counter = Counter()
    isolated_count = 0
    for it in items:
        c_name = it["corpus"]
        sigma_s = float(it.get("sigma_s", 9.5))
        base = _pack_single_clip(
            it["audio"], it["phones"], it["syllables"], it["alphabet"], it["sigma_p"], sigma_s, _G_CHUNK_FRAMES, _G_IS_TRAIN
        )
        chunks.extend(base)
        corpus_counts[c_name] += len(base)
        if _G_IS_TRAIN and _G_AUG_COPIES > 0:
            for _ in range(_G_AUG_COPIES):
                y_aug, ph_aug, sy_aug = augment_utterance(
                    it["audio"], it["phones"], it["syllables"], rng, noise_pool=_G_NOISE_POOL, rir_pool=_G_RIR_POOL
                )
                aug_c = _pack_single_clip(
                    y_aug, ph_aug, sy_aug, it["alphabet"], it["sigma_p"], sigma_s, _G_CHUNK_FRAMES, _G_IS_TRAIN
                )
                chunks.extend(aug_c)
                corpus_counts[c_name] += len(aug_c)
        # Isolated single-syllable / plosive / fricative / whisper positive clips
        if _G_ISOLATED_PROB > 0.0 and rng.random() < _G_ISOLATED_PROB:
            iso = build_isolated_token_clip(it["audio"], it["phones"], it["syllables"], rng, dur_sec=_G_CHUNK_FRAMES * 0.010)
            if iso is not None:
                y_iso, ph_iso, sy_iso = iso
                iso_c = _pack_single_clip(
                    y_iso, ph_iso, sy_iso, it["alphabet"], it["sigma_p"], sigma_s, _G_CHUNK_FRAMES, _G_IS_TRAIN
                )
                chunks.extend(iso_c)
                corpus_counts[c_name] += len(iso_c)
                isolated_count += len(iso_c)
    return chunks, dict(corpus_counts), isolated_count


def _process_neg_shard(shard_tuple: Tuple[int, int]):
    shard_id, count = shard_tuple
    rng = np.random.default_rng(99999 + shard_id * 1013)
    cf = _G_CHUNK_FRAMES
    chunks = []
    for _ in range(count):
        y_neg = generate_pure_negative_clip(cf * 0.010, rng, noise_pool=_G_NOISE_POOL)
        feat = extract_features_from_clean_16k(y_neg)
        if feat.shape[0] < cf:
            feat = np.pad(feat, ((0, cf - feat.shape[0]), (0, 0)), mode="edge")
        else:
            feat = feat[:cf]
        chunks.append((
            feat.astype(np.float16),
            np.zeros((cf,), dtype=np.uint8),
            np.ones((cf,), dtype=np.uint8),
            np.zeros((cf, 2), dtype=np.float16),
            np.ones((cf, 2), dtype=np.uint8),
            np.zeros((cf,), dtype=np.float16),
            np.ones((cf,), dtype=np.uint8),
            np.zeros((cf,), dtype=np.float16),
            np.ones((cf,), dtype=np.uint8),
        ))
    return chunks


def build_chunk_dataset(
    items: List[dict],
    out_npz: Path,
    noise_pool: List[np.ndarray],
    rir_pool: List[np.ndarray],
    aug_copies: int = 2,
    neg_ratio: float = 0.15,
    isolated_prob: float = 0.0,
    chunk_frames: int = 400,
    is_train: bool = True,
    workers: int = 8,
) -> dict:
    global _G_NOISE_POOL, _G_RIR_POOL, _G_CHUNK_FRAMES, _G_AUG_COPIES, _G_IS_TRAIN, _G_ISOLATED_PROB
    _G_NOISE_POOL = noise_pool
    _G_RIR_POOL = rir_pool
    _G_CHUNK_FRAMES = chunk_frames
    _G_AUG_COPIES = aug_copies
    _G_IS_TRAIN = is_train
    _G_ISOLATED_PROB = isolated_prob

    t0 = time.time()
    n_shards = max(1, min(workers * 4, len(items)))
    shards = [(i, items[i::n_shards]) for i in range(n_shards)]
    all_chunks = []
    corpus_chunk_counts: Counter = Counter()
    iso_total = 0
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for res, cc, iso_c in ex.map(_process_item_shard, shards):
            all_chunks.extend(res)
            corpus_chunk_counts.update(cc)
            iso_total += iso_c
    n_pos = len(all_chunks)
    print(f"[prep] {'train' if is_train else 'val'} pos chunks={n_pos} (isolated={iso_total}) by_corpus={dict(corpus_chunk_counts)} in {time.time()-t0:.1f}s", flush=True)

    n_neg = max(40, int(round(n_pos * neg_ratio / max(1e-3, 1.0 - neg_ratio)))) if neg_ratio > 0 else 0
    if n_neg > 0:
        neg_shards = [(i, n_neg // workers + (1 if i < (n_neg % workers) else 0)) for i in range(workers)]
        with ProcessPoolExecutor(max_workers=workers) as ex:
            for res in ex.map(_process_neg_shard, neg_shards):
                all_chunks.extend(res)

    total = len(all_chunks)
    zh_chunks = corpus_chunk_counts.get("aishell3", 0) + corpus_chunk_counts.get("thchs30_zh", 0)
    en_chunks = sum(corpus_chunk_counts.get(k, 0) for k in ("timit", "l2arctic", "librispeech_mfa"))
    dialect_chunks = n_pos - zh_chunks - en_chunks
    mix_pct = {
        "mandarin_pct": round(100.0 * zh_chunks / max(1, total), 2),
        "dialect_key_manner_pct": round(100.0 * dialect_chunks / max(1, total), 2),
        "en_multi_pct": round(100.0 * en_chunks / max(1, total), 2),
        "hard_neg_pct": round(100.0 * n_neg / max(1, total), 2),
        "isolated_token_pct": round(100.0 * iso_total / max(1, total), 2),
    }
    print(f"[prep] {'train' if is_train else 'val'} total={total} mix={mix_pct} packing npz...", flush=True)
    out_npz.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        out_npz,
        feats=np.stack([c[0] for c in all_chunks], axis=0),
        manner=np.stack([c[1] for c in all_chunks], axis=0),
        manner_mask=np.stack([c[2] for c in all_chunks], axis=0),
        pbnd=np.stack([c[3] for c in all_chunks], axis=0),
        pbnd_mask=np.stack([c[4] for c in all_chunks], axis=0),
        sbnd=np.stack([c[5] for c in all_chunks], axis=0),
        sbnd_mask=np.stack([c[6] for c in all_chunks], axis=0),
        vad=np.stack([c[7] for c in all_chunks], axis=0),
        vad_mask=np.stack([c[8] for c in all_chunks], axis=0),
    )
    return {
        "file": str(out_npz),
        "total_chunks": total,
        "pos_chunks": n_pos,
        "neg_chunks": n_neg,
        "isolated_chunks": iso_total,
        "by_corpus": dict(corpus_chunk_counts),
        "mix_pct": mix_pct,
        "elapsed_sec": round(time.time() - t0, 1),
    }


def main():
    ap = argparse.ArgumentParser(description="Prepare multilingual & dialect training chunks for TGrid-AcouSeg 1.0")
    ap.add_argument("--work-dir", type=str, default="./data/acouseg")
    ap.add_argument("--aug-copies", type=int, default=2)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--version", type=str, default="acouseg-1.0")
    ap.add_argument(
        "--mandarin-source",
        type=str,
        choices=("thchs30", "aishell3"),
        default="thchs30",
        help="Mandarin corpus source: thchs30 (fast HuggingFace Parquet) or aishell3 (OpenSLR SLR93)",
    )
    ap.add_argument(
        "--skip-dialects",
        action="store_true",
        help="Skip MMS_FA-aligned dialect corpora (useful for strictly permissive-license clean-room reproduction)",
    )
    args = ap.parse_args()

    work = Path(args.work_dir)
    work.mkdir(parents=True, exist_ok=True)

    train_all: List[dict] = []
    val_all: List[dict] = []
    val_dialect: List[dict] = []
    manifest: List[dict] = []

    # 1. Load Mandarin Chinese (strictly speaker-disjoint train/val split)
    if args.mandarin_source == "aishell3":
        tr_zh, va_zh, info_zh = load_aishell3_lars76(work, workers=args.workers)
    else:
        tr_zh, va_zh, info_zh = load_thchs30_hf(max_train=1450, max_val=240)
    manifest.append(info_zh)
    train_all.extend(tr_zh)
    val_all.extend(va_zh)

    # 2. Run GPU MMS_FA Dialect & Key-Manner Alignment
    if not args.skip_dialects:
        from dataset.align_dialects_mms import load_all_dialects_mms
        d_tr, d_va, d_infos = load_all_dialects_mms()
        for info in d_infos:
            manifest.append(info)
        if d_tr or d_va:
            d_cov = audit_phone_coverage(d_tr + d_va)
            print(f"[dialect] Combined dialect IPA audit: {d_cov}", flush=True)
            manifest.append({"name": "Dialect Combined IPA Audit", "ipa_audit": d_cov})
        train_all.extend(d_tr)
        val_all.extend(d_va)
        val_dialect.extend(d_va)

    # 3. Load TIMIT + L2-ARCTIC (100% explicit mapping) + LibriSpeech MFA
    va_en_list: List[dict] = []
    for loader in (
        lambda: load_timit_hf(max_train=2800, max_val=500),
        lambda: load_l2arctic_zips(work, max_per_train_spk=190, max_per_val_spk=200, workers=args.workers),
        lambda: load_librispeech_mfa_hf(max_train=260, max_val=100),
    ):
        tr, va, info = loader()
        manifest.append(info)
        train_all.extend(tr)
        val_all.extend(va)
        va_en_list.extend(va)

    # 4. Export speaker-disjoint real-human benchmark manifest directly from validation sets
    val_eval_dir = work.parent / "acouseg_val_eval"
    val_wav_dir = val_eval_dir / "wavs"
    val_wav_dir.mkdir(parents=True, exist_ok=True)
    def _export_val_group(group_name: str, items_g: List[dict], max_syl: int = 180, max_ph: int = 220) -> List[dict]:
        def _ok(s: str) -> bool:
            low = s.strip().lower()
            return bool(low) and low not in {"sil", "[sil]", "sp", "spn", "nsn", "pau", "h#", "epi", "#", "<sil>", "<eps>", "err"}
        tasks_g = []
        n_s = 0
        n_p = 0
        for it in items_g:
            if n_s >= max_syl and n_p >= max_ph:
                break
            wp = val_wav_dir / f"{it['id']}.wav"
            if not wp.exists():
                sf.write(str(wp), it["audio"], 16000, subtype="PCM_16")
            phs = [(ts, te, lbl) for ts, te, lbl in it["phones"] if _ok(lbl) and te > ts + 0.008]
            sys_ = [(ts, te, lbl) for ts, te, lbl in (it.get("syllables") or []) if _ok(lbl) and te > ts + 0.015]
            if n_s < max_syl and len(sys_) >= 2:
                chunk = sys_[:12]
                xmin, xmax = chunk[0][0], chunk[-1][1]
                if 0.12 <= (xmax - xmin) <= 10.0:
                    tasks_g.append({
                        "group": group_name, "wav": str(wp), "granularity": "syllable",
                        "xmin": round(xmin, 5), "xmax": round(xmax, 5),
                        "gt_cuts": [round(s[1], 5) for s in chunk[:-1]], "labels": [s[2] for s in chunk],
                    })
                    n_s += 1
            if n_p < max_ph and sys_ and phs:
                added = 0
                for s_ts, s_te, _ in sys_:
                    if n_p >= max_ph or added >= 2:
                        break
                    ch = [p for p in phs if p[0] >= s_ts - 0.008 and p[1] <= s_te + 0.008]
                    if 2 <= len(ch) <= 6:
                        xmin, xmax = ch[0][0], ch[-1][1]
                        if 0.055 <= (xmax - xmin) <= 2.0:
                            tasks_g.append({
                                "group": group_name, "wav": str(wp), "granularity": "phone",
                                "xmin": round(xmin, 5), "xmax": round(xmax, 5),
                                "gt_cuts": [round(p[1], 5) for p in ch[:-1]], "labels": [p[2] for p in ch],
                            })
                            n_p += 1
                            added += 1
        print(f"[val-manifest] {group_name}: syl_tasks={n_s}, phone_tasks={n_p}", flush=True)
        return tasks_g

    val_tasks = (
        _export_val_group("zh_real", va_zh, max_syl=180, max_ph=220)
        + _export_val_group("en_real", va_en_list, max_syl=180, max_ph=220)
        + _export_val_group("dialect_real", val_dialect, max_syl=180, max_ph=220)
    )
    with (val_eval_dir / "manifest.jsonl").open("w", encoding="utf-8") as mf:
        for t_row in val_tasks:
            mf.write(json.dumps(t_row, ensure_ascii=False) + "\n")
    print(f"[val-manifest] Exported {len(val_tasks)} real-human unseen-speaker eval tasks!", flush=True)

    if len(train_all) < 50:
        raise RuntimeError(f"Insufficient aligned corpora loaded! Manifest: {manifest}")

    noise_pool, rir_pool, nr_info = load_noise_and_rirs(work)

    # ~8% of total training chunks are isolated single-syllable/plosive/fricative/whisper positive clips!
    iso_p = 0.24 if args.aug_copies <= 1 else 0.33
    tr_stats = build_chunk_dataset(
        train_all,
        work / "train_chunks.npz",
        noise_pool,
        rir_pool,
        aug_copies=args.aug_copies,
        neg_ratio=0.15,
        isolated_prob=iso_p,
        is_train=True,
        workers=args.workers,
    )
    va_stats = build_chunk_dataset(
        val_all,
        work / "val_chunks.npz",
        noise_pool,
        rir_pool,
        aug_copies=0,
        neg_ratio=0.15,
        isolated_prob=0.06,
        is_train=False,
        workers=args.workers,
    )
    va_dialect_stats = None
    if val_dialect:
        va_dialect_stats = build_chunk_dataset(
            val_dialect,
            work / "val_dialect_chunks.npz",
            noise_pool,
            rir_pool,
            aug_copies=0,
            neg_ratio=0.0,
            isolated_prob=0.0,
            is_train=False,
            workers=args.workers,
        )

    summary = {
        "version": args.version,
        "corpora": manifest,
        "noise_rir": nr_info,
        "train_utts_raw": len(train_all),
        "val_utts_raw": len(val_all),
        "val_dialect_utts_raw": len(val_dialect),
        "train_hours_raw": round(sum(len(it["audio"]) for it in train_all) / 16000.0 / 3600.0, 3),
        "val_hours_raw": round(sum(len(it["audio"]) for it in val_all) / 16000.0 / 3600.0, 3),
        "train_hours_effective_with_aug": round(tr_stats["total_chunks"] * 4.0 / 3600.0, 3),
        "train_chunks": tr_stats,
        "val_chunks": va_stats,
        "val_dialect_chunks": va_dialect_stats,
    }
    manifest_name = f"corpus_manifest_{args.version}.json"
    (work / manifest_name).write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"=== CORPUS PREPARATION SUMMARY ({args.version}) ===", flush=True)
    print(json.dumps(summary, indent=2, ensure_ascii=False), flush=True)
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
