"""
Two-Stage Training Pipeline for TGrid-AcouSeg 1.0:
  Stage 1: FP32 pretraining with AdamW + CosineAnnealingLR
  Stage 2: Analytical BatchNorm folding + Per-Channel Symmetric INT8 QAT fine-tuning
  Export:  Exact `.tgnn` binary + optional `nn_parity_golden.bin` + validation metrics JSON
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Dict

import numpy as np
import torch
from torch.utils.data import DataLoader, Dataset

sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_tgnn import generate_parity_golden, pack_tgnn_bytes
from model.losses import MicroSegLoss
from model.microseg_net import MicroSegNet, forward_quantized_numpy, quantize_folded_model


class ChunkDataset(Dataset):
    def __init__(self, npz_path: Path):
        data = np.load(npz_path)
        self.feats = data["feats"]
        self.manner = data["manner"]
        self.manner_mask = data["manner_mask"]
        self.pbnd = data["pbnd"]
        self.pbnd_mask = data["pbnd_mask"]
        self.sbnd = data["sbnd"]
        self.sbnd_mask = data["sbnd_mask"]
        self.vad = data["vad"]
        self.vad_mask = data["vad_mask"]

    def __len__(self) -> int:
        return int(self.feats.shape[0])

    def __getitem__(self, idx: int):
        return (
            torch.from_numpy(self.feats[idx].astype(np.float32)),
            torch.from_numpy(self.manner[idx].astype(np.int64)),
            torch.from_numpy(self.manner_mask[idx].astype(np.float32)),
            torch.from_numpy(self.pbnd[idx].astype(np.float32)),
            torch.from_numpy(self.pbnd_mask[idx].astype(np.float32)),
            torch.from_numpy(self.sbnd[idx].astype(np.float32)),
            torch.from_numpy(self.sbnd_mask[idx].astype(np.float32)),
            torch.from_numpy(self.vad[idx].astype(np.float32)),
            torch.from_numpy(self.vad_mask[idx].astype(np.float32)),
        )


def _peak_pick_1d(prob: np.ndarray, threshold: float = 0.30, min_dist: int = 3) -> np.ndarray:
    """Simple local-maximum peak picker returning frame indices."""
    n = len(prob)
    if n < 3:
        return np.zeros((0,), dtype=np.int64)
    cands = []
    for i in range(1, n - 1):
        if prob[i] >= threshold and prob[i] >= prob[i - 1] and prob[i] > prob[i + 1]:
            cands.append(i)
    if not cands:
        return np.zeros((0,), dtype=np.int64)
    # Greedy NMS by descending probability
    cands.sort(key=lambda idx: float(prob[idx]), reverse=True)
    kept = []
    for c in cands:
        if all(abs(c - k) >= min_dist for k in kept):
            kept.append(c)
    kept.sort()
    return np.array(kept, dtype=np.int64)


def _boundary_f1(pred_times_ms: np.ndarray, gt_times_ms: np.ndarray, tol_ms: float = 20.0) -> tuple[int, int, int, list[float]]:
    """One-to-one greedy matching within tolerance tol_ms."""
    used = np.zeros(len(gt_times_ms), dtype=bool)
    tp = 0
    errs = []
    for pt in pred_times_ms:
        if len(gt_times_ms) == 0:
            break
        dists = np.abs(gt_times_ms - pt)
        dists[used] = 1e9
        best = int(np.argmin(dists))
        if dists[best] <= tol_ms:
            used[best] = True
            tp += 1
            errs.append(float(dists[best]))
    fp = len(pred_times_ms) - tp
    fn = len(gt_times_ms) - tp
    return tp, fp, fn, errs


@torch.no_grad()
def evaluate_model(model: MicroSegNet, loader: DataLoader, criterion: MicroSegLoss, device: torch.device) -> Dict[str, float]:
    model.eval()
    loss_sum = 0.0
    n_batches = 0
    manner_correct = 0
    manner_total = 0
    vad_tp = vad_fp = vad_fn = 0
    p10_tp = p10_fp = p10_fn = 0
    p20_tp = p20_fp = p20_fn = 0
    s20_tp = s20_fp = s20_fn = 0
    p_errs = []

    for batch in loader:
        feats, m_t, m_m, p_t, p_m, s_t, s_m, v_t, v_m = [b.to(device) for b in batch]
        logits = model(feats)
        loss, _ = criterion(logits, m_t, m_m, p_t, p_m, s_t, s_m, v_t, v_m)
        loss_sum += float(loss.item())
        n_batches += 1

        # Manner accuracy
        m_pred = logits[:, :, 0:8].argmax(dim=-1)
        valid_m = m_m > 0.5
        manner_correct += int(((m_pred == m_t) & valid_m).sum().item())
        manner_total += int(valid_m.sum().item())

        # VAD F1
        v_pred = (torch.sigmoid(logits[:, :, 11]) >= 0.5) & (v_m > 0.5)
        v_gt = (v_t >= 0.5) & (v_m > 0.5)
        vad_tp += int((v_pred & v_gt).sum().item())
        vad_fp += int((v_pred & (~v_gt) & (v_m > 0.5)).sum().item())
        vad_fn += int(((~v_pred) & v_gt).sum().item())

        # Free boundary F1 @ 10ms and 20ms
        pb_prob = torch.sigmoid(logits[:, :, 8:10]).cpu().numpy()
        pb_gt = p_t.cpu().numpy()
        pb_mk = p_m.cpu().numpy()
        sb_prob = torch.sigmoid(logits[:, :, 10]).cpu().numpy()
        sb_gt = s_t.cpu().numpy()
        sb_mk = s_m.cpu().numpy()

        for b in range(pb_prob.shape[0]):
            valid_len = int(pb_mk[b, :, 0].sum())
            if valid_len < 10:
                continue
            pr5 = pb_prob[b, :valid_len].reshape(-1)
            gt5 = pb_gt[b, :valid_len].reshape(-1)
            pr_pks = _peak_pick_1d(pr5, threshold=0.32, min_dist=4) * 5.0 + 2.5
            gt_pks = _peak_pick_1d(gt5, threshold=0.80, min_dist=4) * 5.0 + 2.5
            if len(gt_pks) > 0:
                tp, fp, fn, _ = _boundary_f1(pr_pks, gt_pks, tol_ms=10.0)
                p10_tp += tp; p10_fp += fp; p10_fn += fn
                tp, fp, fn, errs = _boundary_f1(pr_pks, gt_pks, tol_ms=20.0)
                p20_tp += tp; p20_fp += fp; p20_fn += fn
                p_errs.extend(errs)

            if sb_mk[b, :valid_len].sum() > 10:
                sp_pr = _peak_pick_1d(sb_prob[b, :valid_len], threshold=0.32, min_dist=6) * 10.0 + 5.0
                sp_gt = _peak_pick_1d(sb_gt[b, :valid_len], threshold=0.80, min_dist=6) * 10.0 + 5.0
                if len(sp_gt) > 0:
                    tp, fp, fn, _ = _boundary_f1(sp_pr, sp_gt, tol_ms=20.0)
                    s20_tp += tp; s20_fp += fp; s20_fn += fn

    def _f1(tp, fp, fn):
        p = tp / max(1, tp + fp)
        r = tp / max(1, tp + fn)
        f1 = 2 * p * r / max(1e-9, p + r)
        return round(f1 * 100.0, 2), round(p * 100.0, 2), round(r * 100.0, 2)

    vad_f1, _, _ = _f1(vad_tp, vad_fp, vad_fn)
    p10_f1, p10_p, p10_r = _f1(p10_tp, p10_fp, p10_fn)
    p20_f1, p20_p, p20_r = _f1(p20_tp, p20_fp, p20_fn)
    s20_f1, _, _ = _f1(s20_tp, s20_fp, s20_fn)

    return {
        "val_loss": round(loss_sum / max(1, n_batches), 4),
        "manner_acc_pct": round(100.0 * manner_correct / max(1, manner_total), 2),
        "vad_f1_pct": vad_f1,
        "phone_bnd_f1_10ms": p10_f1,
        "phone_bnd_f1_20ms": p20_f1,
        "phone_bnd_p20": p20_p,
        "phone_bnd_r20": p20_r,
        "phone_matched_mae_ms": round(float(np.mean(p_errs)) if p_errs else 0.0, 2),
        "syl_bnd_f1_20ms": s20_f1,
    }


def train_and_export(args):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[train] Device={device} hidden_dim={args.hidden_dim} fp32_epochs={args.fp32_epochs} qat_epochs={args.qat_epochs}")

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    data_dir = Path(args.data_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    train_ds = ChunkDataset(data_dir / "train_chunks.npz")
    val_ds = ChunkDataset(data_dir / "val_chunks.npz")
    print(f"[train] Loaded chunks: train={len(train_ds)} val={len(val_ds)}")

    train_loader = DataLoader(
        train_ds, batch_size=args.batch_size, shuffle=True, num_workers=2, pin_memory=True, drop_last=True
    )
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False, num_workers=2, pin_memory=True)

    model = MicroSegNet(in_dim=32, hidden_dim=args.hidden_dim, out_dim=12).to(device)
    criterion = MicroSegLoss().to(device)

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.fp32_epochs, eta_min=5e-5)

    t0 = time.time()
    best_val_loss = float("inf")
    best_state = None
    history = []

    # Stage 1: FP32 Pretraining
    for ep in range(1, args.fp32_epochs + 1):
        model.train()
        tr_loss = 0.0
        n_b = 0
        for batch in train_loader:
            feats, m_t, m_m, p_t, p_m, s_t, s_m, v_t, v_m = [b.to(device, non_blocking=True) for b in batch]
            optimizer.zero_grad(set_to_none=True)
            logits = model(feats)
            loss, _ = criterion(logits, m_t, m_m, p_t, p_m, s_t, s_m, v_t, v_m)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
            optimizer.step()
            tr_loss += float(loss.item())
            n_b += 1
        scheduler.step()

        if ep == 1 or ep % 5 == 0 or ep == args.fp32_epochs:
            val_m = evaluate_model(model, val_loader, criterion, device)
            val_m["epoch"] = ep
            val_m["stage"] = "fp32"
            val_m["train_loss"] = round(tr_loss / max(1, n_b), 4)
            val_m["elapsed_s"] = round(time.time() - t0, 1)
            history.append(val_m)
            print(f"[FP32 ep {ep:02d}/{args.fp32_epochs}] {val_m}")
            if val_m["val_loss"] < best_val_loss:
                best_val_loss = val_m["val_loss"]
                best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}

    if best_state is not None:
        model.load_state_dict(best_state)
    fp32_final = evaluate_model(model, val_loader, criterion, device)
    print(f"[Stage 1 Best FP32] {fp32_final}")

    # Stage 2: Analytical BN Folding + Per-Channel Symmetric INT8 QAT
    model.cpu()
    model.fold_all_bn()
    model.enable_qat(True)
    model.to(device)

    qat_opt = torch.optim.AdamW(model.parameters(), lr=args.qat_lr, weight_decay=1e-4)
    qat_sched = torch.optim.lr_scheduler.CosineAnnealingLR(qat_opt, T_max=max(1, args.qat_epochs), eta_min=1e-5)

    best_qat_loss = float("inf")
    best_qat_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}

    for ep in range(1, args.qat_epochs + 1):
        model.train()
        tr_loss = 0.0
        n_b = 0
        for batch in train_loader:
            feats, m_t, m_m, p_t, p_m, s_t, s_m, v_t, v_m = [b.to(device, non_blocking=True) for b in batch]
            qat_opt.zero_grad(set_to_none=True)
            logits = model(feats)
            loss, _ = criterion(logits, m_t, m_m, p_t, p_m, s_t, s_m, v_t, v_m)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.5)
            qat_opt.step()
            tr_loss += float(loss.item())
            n_b += 1
        qat_sched.step()

        if ep == 1 or ep % 2 == 0 or ep == args.qat_epochs:
            val_m = evaluate_model(model, val_loader, criterion, device)
            val_m["epoch"] = args.fp32_epochs + ep
            val_m["stage"] = "qat_int8"
            val_m["train_loss"] = round(tr_loss / max(1, n_b), 4)
            val_m["elapsed_s"] = round(time.time() - t0, 1)
            history.append(val_m)
            print(f"[QAT  ep {ep:02d}/{args.qat_epochs}] {val_m}")
            if val_m["val_loss"] < best_qat_loss:
                best_qat_loss = val_m["val_loss"]
                best_qat_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}

    model.load_state_dict(best_qat_state)
    qat_final = evaluate_model(model, val_loader, criterion, device)
    print(f"[Stage 2 Best INT8 QAT] {qat_final}")

    # Evaluate on speaker-disjoint dialect validation subset if present
    dialect_val_metrics = None
    dialect_npz = data_dir / "val_dialect_chunks.npz"
    if dialect_npz.exists():
        d_ds = ChunkDataset(dialect_npz)
        d_loader = DataLoader(d_ds, batch_size=args.batch_size, shuffle=False, num_workers=2, pin_memory=True)
        dialect_val_metrics = evaluate_model(model, d_loader, criterion, device)
        print(f"[Stage 2 Dialect-Only Val ({len(d_ds)} chunks)] {dialect_val_metrics}")

    # Verify exact INT8 numpy parity vs PyTorch QAT forward pass
    model.cpu().eval()
    specs, scales, biases, weights_i8 = quantize_folded_model(model)
    sample_x = val_ds.feats[0].astype(np.float32)
    with torch.no_grad():
        pt_logits = model(torch.from_numpy(sample_x[None, :, :]))[0].numpy()
    np_logits = forward_quantized_numpy(sample_x, specs, scales, biases, weights_i8)
    pt_vs_np_diff = float(np.max(np.abs(pt_logits - np_logits)))
    print(f"[parity] PyTorch QAT vs NumPy INT8 max_abs_diff = {pt_vs_np_diff:.2e}")

    # Export .tgnn
    ver = args.version_tag
    if ver == "acouseg-1.0":
        tag = "tgrid-acouseg-1.0" if args.hidden_dim == 96 else f"tgrid-acouseg-1.0-h{args.hidden_dim}"
        tgnn_name = "tgrid-acouseg-1.0.tgnn" if args.hidden_dim == 96 else f"tgrid-acouseg-1.0-h{args.hidden_dim}.tgnn"
    else:
        tag = f"tgrid-{ver}-h{args.hidden_dim}"
        tgnn_name = f"tgrid-{ver}-h{args.hidden_dim}.tgnn"
    tgnn_bytes = pack_tgnn_bytes(model, model_tag=tag)
    tgnn_path = out_dir / tgnn_name
    tgnn_path.write_bytes(tgnn_bytes)
    print(f"[export] Wrote {tgnn_path} ({len(tgnn_bytes)} bytes)")

    golden_info = None
    if args.export_golden:
        g_name = f"nn_parity_golden_{ver}_h{args.hidden_dim}.bin"
        g_size, golden_info = generate_parity_golden(model, out_dir / g_name)
        print(f"[export] Wrote {g_name} ({g_size} bytes): {golden_info}")

    # Save training log JSON
    log = {
        "version": ver,
        "hidden_dim": args.hidden_dim,
        "tgnn_file": tgnn_name,
        "tgnn_bytes": len(tgnn_bytes),
        "total_time_sec": round(time.time() - t0, 1),
        "device": str(device),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        "pt_vs_np_max_abs_diff": pt_vs_np_diff,
        "fp32_best": fp32_final,
        "qat_int8_best": qat_final,
        "dialect_val_int8": dialect_val_metrics,
        "golden_info": golden_info,
        "history": history,
    }
    log_name = f"train_log_{ver}_h{args.hidden_dim}.json"
    log_path = out_dir / log_name
    log_path.write_text(json.dumps(log, indent=2), encoding="utf-8")
    print(f"[export] Wrote {log_path}")


def main():
    ap = argparse.ArgumentParser(description="Train and export TGrid-AcouSeg 1.0 (.tgnn)")
    ap.add_argument("--data-dir", type=str, default="./data/acouseg")
    ap.add_argument("--out-dir", type=str, default="./artifacts")
    ap.add_argument("--hidden-dim", type=int, default=96, help="96 (standard 204 KB) or 48 (lite 57 KB)")
    ap.add_argument("--version-tag", type=str, default="acouseg-1.0")
    ap.add_argument("--batch-size", type=int, default=96)
    ap.add_argument("--fp32-epochs", type=int, default=35)
    ap.add_argument("--qat-epochs", type=int, default=10)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--qat-lr", type=float, default=5e-5)
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--export-golden", action="store_true")
    args = ap.parse_args()
    train_and_export(args)


if __name__ == "__main__":
    main()
