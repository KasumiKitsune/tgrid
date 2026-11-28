"""
Lightweight Dialect Fine-Tuning for TGrid-AcouSeg 1.0 (CPU-friendly, 2-4 min for 30-200 files).

Adapts the built-in `tgrid-acouseg-1.0.tgnn` (or any compatible `.tgnn` base model) to a user's
own annotated dialect corpus (paired `.wav` + `.TextGrid` files):
  - Freezes stem + first 4 ConvNeXt blocks (`L00..L12`) to prevent small-sample overfitting.
  - Unfreezes only the final block (`b4`), `head_neck`, and `head_out` (`L13..L17`) under INT8 QAT.
  - Supports partial-tier TextGrids (e.g., syllable/hanzi-only or phone-only) with Masked Partial-Tier
    Loss + Knowledge Distillation (KL / BCE anchor to the frozen base model, lambda_kd=0.25) so
    unannotated granularities remain intact.
  - Exports an isomorphic `.tgnn` file with IEEE CRC32 checksum, directly loadable in T·Grid.

Example:
  python finetune_dialect.py \
    --input ./my_dialect_corpus \
    --output ./my_dialect_acouseg.tgnn \
    --base-model ../../crates/tg-core/src/nn/weights/tgrid-acouseg-1.0.tgnn
"""
from __future__ import annotations

import argparse
import copy
import math
import re
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, TensorDataset

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dataset.augment_field import augment_utterance
from dataset.ipa_manner_map import build_frame_targets
from export_tgnn import load_tgnn_into_model, pack_tgnn_bytes
from model.features_ref import extract_features
from model.losses import MicroSegLoss
from model.microseg_net import MicroSegNet

_PHONE_TIER_HINTS = ("phone", "phon", "ipa", "seg", "initial", "final", "音素", "声韵", "音段")
_SYL_TIER_HINTS = ("syl", "word", "hanzi", "char", "pinyin", "gloss", "text", "orth", "音节", "词", "汉字", "拼音", "字")


def read_textgrid_file(path: Path) -> Dict[str, List[Tuple[float, float, str]]]:
    """
    Parse both Standard Long Text and Compact Short Text Praat `.TextGrid` files
    (UTF-8 with/without BOM or UTF-16). Returns `{tier_name: [(xmin, xmax, text), ...]}`
    for IntervalTiers.
    """
    raw = path.read_bytes()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = raw.decode("utf-16", errors="replace")
    else:
        text = raw.decode("utf-8-sig", errors="replace")

    tiers: Dict[str, List[Tuple[float, float, str]]] = {}

    # 1. Standard Long Text format
    blocks = re.split(r"\bitem\s*\[\d+\]\s*:", text)
    if len(blocks) > 1:
        for idx, blk in enumerate(blocks[1:], start=1):
            m_cls = re.search(r'class\s*=\s*"([^"]+)"', blk)
            if not m_cls or "IntervalTier" not in m_cls.group(1):
                continue
            m_name = re.search(r'name\s*=\s*"((?:[^"]|"")*)"', blk)
            tname = (m_name.group(1).replace('""', '"').strip() if m_name else f"tier_{idx}")
            ivs: List[Tuple[float, float, str]] = []
            for m in re.finditer(
                r'xmin\s*=\s*([0-9.eE+-]+)\s+xmax\s*=\s*([0-9.eE+-]+)\s+text\s*=\s*"((?:[^"]|"")*)"',
                blk,
                flags=re.DOTALL,
            ):
                ts, te = float(m.group(1)), float(m.group(2))
                lbl = m.group(3).replace('""', '"').strip()
                if te > ts:
                    ivs.append((ts, te, lbl))
            if ivs:
                tiers[tname] = ivs
        if tiers:
            return tiers

    # 2. Compact Short Text format fallback
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    i = 0
    while i < len(lines):
        if lines[i] == '"IntervalTier"' and i + 4 < len(lines):
            tname = lines[i + 1].strip('"').replace('""', '"').strip() or f"tier_{len(tiers) + 1}"
            try:
                n_iv = int(float(lines[i + 4]))
            except ValueError:
                i += 1
                continue
            i += 5
            ivs = []
            for _ in range(n_iv):
                if i + 2 >= len(lines):
                    break
                try:
                    ts = float(lines[i])
                    te = float(lines[i + 1])
                except ValueError:
                    break
                lbl = lines[i + 2].strip('"').replace('""', '"').strip()
                if te > ts:
                    ivs.append((ts, te, lbl))
                i += 3
            if ivs:
                tiers[tname] = ivs
        else:
            i += 1
    return tiers


def infer_tiers(
    tiers: Dict[str, List[Tuple[float, float, str]]],
    phone_tier_name: Optional[str] = None,
    syl_tier_name: Optional[str] = None,
) -> Tuple[Optional[List[Tuple[float, float, str]]], Optional[List[Tuple[float, float, str]]]]:
    """Select phone and/or syllable tiers by explicit name or acoustic-tier heuristics."""
    lower_map = {k.lower(): k for k in tiers}

    phones = None
    syls = None
    if phone_tier_name and phone_tier_name.lower() in lower_map:
        phones = tiers[lower_map[phone_tier_name.lower()]]
    if syl_tier_name and syl_tier_name.lower() in lower_map:
        syls = tiers[lower_map[syl_tier_name.lower()]]

    if phones is None:
        for k, ivs in tiers.items():
            kl = k.lower()
            if any(h in kl for h in _PHONE_TIER_HINTS):
                phones = ivs
                break
    if syls is None:
        for k, ivs in tiers.items():
            kl = k.lower()
            if any(h in kl for h in _SYL_TIER_HINTS) and ivs is not phones:
                syls = ivs
                break

    # Fallback when tier names are generic (e.g. "tier1"): classify by median non-empty interval duration
    if phones is None and syls is None and tiers:
        ranked = []
        for k, ivs in tiers.items():
            non_empty = [te - ts for ts, te, lbl in ivs if lbl.strip()]
            if not non_empty:
                continue
            ranked.append((float(np.median(non_empty)), ivs))
        ranked.sort(key=lambda pair: pair[0])
        if len(ranked) == 1:
            med_dur, ivs = ranked[0]
            if med_dur <= 0.13:
                phones = ivs
            else:
                syls = ivs
        elif len(ranked) >= 2:
            phones = ranked[0][1]
            syls = ranked[-1][1]

    return phones, syls


def discover_pairs(input_dir: Path) -> List[Tuple[Path, Path]]:
    """Recursively find matching `(wav_path, textgrid_path)` pairs by stem."""
    wavs: Dict[str, Path] = {}
    tgs: Dict[str, Path] = {}
    for p in sorted(input_dir.rglob("*")):
        if not p.is_file():
            continue
        suf = p.suffix.lower()
        key = str(p.with_suffix("")).lower()
        if suf == ".wav":
            wavs[key] = p
        elif suf == ".textgrid":
            tgs[key] = p
    pairs = [(wavs[k], tgs[k]) for k in sorted(wavs.keys()) if k in tgs]
    return pairs


def load_corpus_items(
    pairs: List[Tuple[Path, Path]],
    phone_tier: Optional[str],
    syl_tier: Optional[str],
    alphabet: str,
) -> List[dict]:
    items: List[dict] = []
    for wav_p, tg_p in pairs:
        try:
            tiers = read_textgrid_file(tg_p)
            phones, syls = infer_tiers(tiers, phone_tier, syl_tier)
            if not phones and not syls:
                continue
            pcm, sr = sf.read(str(wav_p), dtype="float32")
            if pcm.ndim == 2:
                pcm = np.mean(pcm, axis=1)
            # Extract via exact feature frontend resampler (ensures 0 train/infer drift)
            from model.features_ref import resample_to_16k

            x16 = resample_to_16k(pcm, int(sr))
            if len(x16) < 2400:
                continue
            items.append({
                "id": wav_p.stem,
                "audio": x16,
                "phones": phones or [],
                "syllables": syls,
                "has_phone_tier": bool(phones),
                "alphabet": alphabet,
            })
        except Exception as e:
            print(f"[warn] Skipped {wav_p.name}: {e}", flush=True)
    return items


def pack_items_to_tensors(
    items: List[dict],
    chunk_frames: int = 400,
    aug_copies: int = 2,
    is_train: bool = True,
    seed: int = 2026,
) -> TensorDataset:
    rng = np.random.default_rng(seed)
    feats_l, m_l, mm_l, p_l, pm_l, s_l, sm_l, v_l, vm_l = [], [], [], [], [], [], [], [], []

    def _append_clip(x16: np.ndarray, phones, syls, has_phone: bool, alpha: str):
        feat = extract_features(x16, 16000)
        t_len = feat.shape[0]
        if t_len < 12:
            return
        tgt = build_frame_targets(
            t_len,
            x16,
            phones,
            syllables=syls,
            alphabet=alpha,
            sigma_phone_ms=5.5,
            sigma_syl_ms=9.5,
            has_phone_tier=has_phone,
        )
        if t_len <= chunk_frames:
            pad_t = chunk_frames - t_len
            feats_l.append(np.pad(feat, ((0, pad_t), (0, 0)), mode="edge"))
            m_l.append(np.pad(tgt["manner"], (0, pad_t), constant_values=0))
            mm_l.append(np.pad(tgt["manner_mask"], (0, pad_t), constant_values=0.0))
            p_l.append(np.pad(tgt["pbnd"], ((0, pad_t), (0, 0)), constant_values=0.0))
            pm_l.append(np.pad(tgt["pbnd_mask"], ((0, pad_t), (0, 0)), constant_values=0.0))
            s_l.append(np.pad(tgt["sbnd"], (0, pad_t), constant_values=0.0))
            sm_l.append(np.pad(tgt["sbnd_mask"], (0, pad_t), constant_values=0.0))
            v_l.append(np.pad(tgt["vad"], (0, pad_t), constant_values=0.0))
            vm_l.append(np.pad(tgt["vad_mask"], (0, pad_t), constant_values=0.0))
        else:
            stride = chunk_frames // 2 if is_train else chunk_frames
            starts = list(range(0, t_len - chunk_frames + 1, stride))
            if starts[-1] + chunk_frames < t_len:
                starts.append(t_len - chunk_frames)
            for st in starts:
                en = st + chunk_frames
                feats_l.append(feat[st:en])
                m_l.append(tgt["manner"][st:en])
                mm_l.append(tgt["manner_mask"][st:en])
                p_l.append(tgt["pbnd"][st:en])
                pm_l.append(tgt["pbnd_mask"][st:en])
                s_l.append(tgt["sbnd"][st:en])
                sm_l.append(tgt["sbnd_mask"][st:en])
                v_l.append(tgt["vad"][st:en])
                vm_l.append(tgt["vad_mask"][st:en])

    for it in items:
        _append_clip(it["audio"], it["phones"], it["syllables"], it["has_phone_tier"], it["alphabet"])
        if is_train and aug_copies > 0:
            for _ in range(aug_copies):
                y_aug, ph_aug, sy_aug = augment_utterance(it["audio"], it["phones"], it["syllables"], rng)
                _append_clip(y_aug, ph_aug, sy_aug, it["has_phone_tier"], it["alphabet"])

    return TensorDataset(
        torch.from_numpy(np.stack(feats_l).astype(np.float32)),
        torch.from_numpy(np.stack(m_l).astype(np.int64)),
        torch.from_numpy(np.stack(mm_l).astype(np.float32)),
        torch.from_numpy(np.stack(p_l).astype(np.float32)),
        torch.from_numpy(np.stack(pm_l).astype(np.float32)),
        torch.from_numpy(np.stack(s_l).astype(np.float32)),
        torch.from_numpy(np.stack(sm_l).astype(np.float32)),
        torch.from_numpy(np.stack(v_l).astype(np.float32)),
        torch.from_numpy(np.stack(vm_l).astype(np.float32)),
    )


def freeze_shallow_backbone(model: MicroSegNet) -> Tuple[int, int]:
    """
    Freeze `stem_pw` and first 4 ConvNeXt blocks (`blocks[0..4]`, i.e., `L00..L12`).
    Unfreeze only the final block (`blocks[-1]`), `head_neck`, and `head_out` (`L13..L17`).
    """
    for p in model.parameters():
        p.requires_grad = False

    for module in (model.blocks[-1], model.head_neck, model.head_out):
        for p in module.parameters():
            p.requires_grad = True

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    return trainable, total


def kd_anchor_loss(
    student_logits: torch.Tensor,
    teacher_logits: torch.Tensor,
    manner_mask: torch.Tensor,
    pbnd_mask: torch.Tensor,
    sbnd_mask: torch.Tensor,
    vad_mask: torch.Tensor,
) -> torch.Tensor:
    """
    Distill knowledge from the frozen multilingual base model onto unannotated / masked channels
    (and weakly regularize all channels) so fine-tuning on syllable-only TextGrids preserves
    phone-level & acoustic-manner accuracy.
    """
    # Unmasked (labeled) weight = 0.15 gentle anchor; masked (unlabeled) weight = 1.0 full preservation
    w_m = torch.where(manner_mask > 0.5, 0.15, 1.0)
    w_p = torch.where(pbnd_mask > 0.5, 0.15, 1.0)
    w_s = torch.where(sbnd_mask > 0.5, 0.15, 1.0)
    w_v = torch.where(vad_mask > 0.5, 0.15, 1.0)

    # Manner KL divergence
    t_prob = F.softmax(teacher_logits[:, :, 0:8], dim=-1)
    s_logp = F.log_softmax(student_logits[:, :, 0:8], dim=-1)
    kl_m = F.kl_div(s_logp, t_prob, reduction="none").sum(dim=-1)
    loss_m = (kl_m * w_m).sum() / w_m.sum().clamp(min=1.0)

    # Boundary & VAD soft-target BCE
    t_p = torch.sigmoid(teacher_logits[:, :, 8:10])
    bce_p = F.binary_cross_entropy_with_logits(student_logits[:, :, 8:10], t_p, reduction="none")
    loss_p = (bce_p * w_p).sum() / w_p.sum().clamp(min=1.0)

    t_s = torch.sigmoid(teacher_logits[:, :, 10])
    bce_s = F.binary_cross_entropy_with_logits(student_logits[:, :, 10], t_s, reduction="none")
    loss_s = (bce_s * w_s).sum() / w_s.sum().clamp(min=1.0)

    t_v = torch.sigmoid(teacher_logits[:, :, 11])
    bce_v = F.binary_cross_entropy_with_logits(student_logits[:, :, 11], t_v, reduction="none")
    loss_v = (bce_v * w_v).sum() / w_v.sum().clamp(min=1.0)

    return loss_m + loss_p + loss_s + loss_v


def main():
    default_base = (
        Path(__file__).resolve().parent.parent.parent
        / "crates"
        / "tg-core"
        / "src"
        / "nn"
        / "weights"
        / "tgrid-acouseg-1.0.tgnn"
    )
    ap = argparse.ArgumentParser(description="Fine-tune TGrid-AcouSeg 1.0 on a custom dialect TextGrid + WAV corpus")
    ap.add_argument("--input", type=str, required=True, help="Directory containing paired .wav and .TextGrid files")
    ap.add_argument("--output", type=str, required=True, help="Output path for fine-tuned .tgnn weight file")
    ap.add_argument(
        "--base-model",
        type=str,
        default=str(default_base),
        help="Path to base .tgnn weight file (default: built-in tgrid-acouseg-1.0.tgnn)",
    )
    ap.add_argument("--tag", type=str, default="acouseg-1.0-custom", help="ASCII model tag stored in .tgnn header (<=27 chars)")
    ap.add_argument("--phone-tier", type=str, default=None, help="Optional explicit phone/IPA tier name")
    ap.add_argument("--syllable-tier", type=str, default=None, help="Optional explicit syllable/word tier name")
    ap.add_argument("--alphabet", type=str, default="auto", choices=("auto", "ipa", "pinyin", "arpa"), help="Phone tier symbol set")
    ap.add_argument("--epochs", type=int, default=16, help="QAT fine-tuning epochs (recommended 12-20)")
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--kd-weight", type=float, default=0.25, help="Knowledge distillation anchor weight lambda_kd")
    ap.add_argument("--aug-copies", type=int, default=2, help="Fieldwork augmentation copies per training utterance")
    ap.add_argument("--val-ratio", type=float, default=0.15, help="Held-out validation ratio (default 0.15)")
    ap.add_argument("--seed", type=int, default=2026)
    args = ap.parse_args()

    t0 = time.time()
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    base_path = Path(args.base_model)
    if not base_path.exists():
        raise FileNotFoundError(f"Base model not found: {base_path}")

    pairs = discover_pairs(Path(args.input))
    if len(pairs) < 5:
        raise RuntimeError(f"Found only {len(pairs)} paired (.wav + .TextGrid) files in {args.input}; need at least 5.")

    items = load_corpus_items(pairs, args.phone_tier, args.syllable_tier, args.alphabet)
    if len(items) < 5:
        raise RuntimeError(f"Only {len(items)} valid utterances parsed from {args.input}.")

    n_phone = sum(1 for it in items if it["has_phone_tier"])
    n_syl = sum(1 for it in items if it["syllables"])
    total_min = sum(len(it["audio"]) for it in items) / 16000.0 / 60.0
    print(
        f"[finetune] Loaded {len(items)} utterances ({total_min:.2f} min) | "
        f"phone_tier={n_phone}, syl_tier={n_syl} | device={device}",
        flush=True,
    )

    # Deterministic 85/15 split
    rng = np.random.default_rng(args.seed)
    perm = rng.permutation(len(items))
    n_val = max(1, int(round(len(items) * args.val_ratio)))
    val_items = [items[i] for i in perm[:n_val]]
    train_items = [items[i] for i in perm[n_val:]]
    print(f"[finetune] Split: train={len(train_items)} utts, val={len(val_items)} utts", flush=True)

    train_ds = pack_items_to_tensors(train_items, aug_copies=args.aug_copies, is_train=True, seed=args.seed)
    val_ds = pack_items_to_tensors(val_items, aug_copies=0, is_train=False, seed=args.seed + 1)
    train_loader = DataLoader(train_ds, batch_size=min(args.batch_size, len(train_ds)), shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=min(args.batch_size, len(val_ds)), shuffle=False)

    # Load base .tgnn model + frozen teacher copy
    model, hdr = load_tgnn_into_model(base_path)
    teacher = copy.deepcopy(model).to(device).eval()
    for p in teacher.parameters():
        p.requires_grad = False

    trainable, total = freeze_shallow_backbone(model)
    model.enable_qat(True)
    model.to(device)
    print(
        f"[finetune] Base: {hdr['model_tag']} (h={hdr['hidden_dim']}, {hdr['file_bytes']} B) | "
        f"Unfrozen L13..L17: {trainable:,} / {total:,} params ({100.0 * trainable / total:.1f}%)",
        flush=True,
    )

    from train_qat import evaluate_model

    criterion = MicroSegLoss().to(device)
    before_metrics = evaluate_model(model, val_loader, criterion, device)
    print(f"[before ] {before_metrics}", flush=True)

    optimizer = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad],
        lr=args.lr,
        weight_decay=1e-3,
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, args.epochs), eta_min=2e-5)

    best_loss = before_metrics["val_loss"]
    best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}

    for ep in range(1, args.epochs + 1):
        model.train()
        tr_loss = 0.0
        nb = 0
        for batch in train_loader:
            feats, m_t, m_m, p_t, p_m, s_t, s_m, v_t, v_m = [b.to(device) for b in batch]
            optimizer.zero_grad(set_to_none=True)
            s_logits = model(feats)
            sup_loss, _ = criterion(s_logits, m_t, m_m, p_t, p_m, s_t, s_m, v_t, v_m)
            if args.kd_weight > 0.0:
                with torch.no_grad():
                    t_logits = teacher(feats)
                kd = kd_anchor_loss(s_logits, t_logits, m_m, p_m, s_m, v_m)
                loss = sup_loss + args.kd_weight * kd
            else:
                loss = sup_loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.5)
            optimizer.step()
            tr_loss += float(loss.item())
            nb += 1
        scheduler.step()

        if ep == 1 or ep % 2 == 0 or ep == args.epochs:
            val_m = evaluate_model(model, val_loader, criterion, device)
            print(
                f"[ep {ep:02d}/{args.epochs}] train_loss={tr_loss / max(1, nb):.4f} "
                f"val_loss={val_m['val_loss']:.4f} phone_F1@20ms={val_m['phone_bnd_f1_20ms']}% "
                f"syl_F1@20ms={val_m['syl_bnd_f1_20ms']}% MAE={val_m['phone_matched_mae_ms']}ms",
                flush=True,
            )
            if val_m["val_loss"] < best_loss:
                best_loss = val_m["val_loss"]
                best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}

    model.load_state_dict(best_state)
    after_metrics = evaluate_model(model, val_loader, criterion, device)
    print(f"[after  ] {after_metrics}", flush=True)

    # Export isomorphic .tgnn
    model.cpu().eval()
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tgnn_bytes = pack_tgnn_bytes(model, model_tag=args.tag)
    out_path.write_bytes(tgnn_bytes)

    print(
        f"[export ] Wrote {out_path} ({len(tgnn_bytes):,} bytes, tag={args.tag!r}) in {time.time() - t0:.1f}s",
        flush=True,
    )


if __name__ == "__main__":
    main()
