"""
Export & load `TGrid-AcouSeg 1.0` (`MicroSegNet`) in exact binary `.tgnn` format
(208,576 bytes for hidden_dim=96 standard model; 58,432 bytes for hidden_dim=48 lite variant),
and generate `nn_parity_golden.bin` (~38 KB) for Python vs Rust numerical parity tests.
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path
from typing import Dict, Tuple

import numpy as np
import torch

from model.features_ref import extract_features
from model.microseg_net import MicroSegNet, forward_quantized_numpy, quantize_folded_model


def pack_tgnn_bytes(model: MicroSegNet, model_tag: str = "tgrid-acouseg-1.0") -> bytes:
    """
    Pack a `MicroSegNet` into exact 64-byte-aligned `.tgnn` binary format.
    """
    specs, scales, biases, weights_i8 = quantize_folded_model(model)
    num_layers = len(specs)
    channel_count = int(scales.size)
    weight_bytes = int(weights_i8.size)

    # Layer descriptors: 16 bytes each
    # op_kind(u8), act_kind(u8), res_mode(u8), kernel(u8), dilation(u16), c_in(u16), c_out(u16), param_idx(u16), weight_off(u32)
    desc_buf = bytearray()
    p_idx = 0
    w_off = 0
    for spec in specs:
        desc_buf += struct.pack(
            "<BBBBHHHHI",
            spec.op_kind,
            spec.act_kind,
            spec.res_mode,
            spec.kernel,
            spec.dilation,
            spec.c_in,
            spec.c_out,
            p_idx,
            w_off,
        )
        p_idx += spec.c_out
        w_off += (spec.c_in * spec.c_out) if spec.op_kind == 0 else (spec.kernel * spec.c_out)

    assert p_idx == channel_count
    assert w_off == weight_bytes

    payload = (
        bytes(desc_buf)
        + np.ascontiguousarray(scales, dtype="<f4").tobytes()
        + np.ascontiguousarray(biases, dtype="<f4").tobytes()
        + np.ascontiguousarray(weights_i8, dtype="i1").tobytes()
    )
    crc = zlib.crc32(payload) & 0xFFFFFFFF

    tag_bytes = model_tag.encode("utf-8")[:27]
    tag_padded = tag_bytes + b"\x00" * (28 - len(tag_bytes))

    # 64-byte header
    header = struct.pack(
        "<4sHHIHHHHHHIII28s",
        b"TGNN",
        1,                      # version
        1,                      # arch_id
        16000,                  # sample_rate
        160,                    # hop_samples
        model.in_dim,           # in_dim = 32
        model.out_dim,          # out_dim = 12
        model.hidden_dim,       # hidden_dim (48 or 96)
        num_layers,             # num_layers = 18
        0,                      # reserved
        weight_bytes,
        channel_count,
        crc,
        tag_padded,
    )
    assert len(header) == 64
    return header + payload


def generate_parity_golden(model: MicroSegNet, out_path: Path) -> Tuple[int, dict]:
    """
    Generate compact `nn_parity_golden.bin` (~22 KB) with 3 multi-SR test cases:
      Case A: 16,000 Hz synthetic fricative + closure + burst + vowel + nasal (0.24s)
      Case B: 44,100 Hz non-integer ratio sequence (0.12s -> tests Hann-Sinc resampler)
      Case C: 8,000 Hz narrowband + white noise sequence (0.16s -> tests low-SR & noise floor)

    Binary layout (little-endian):
      Magic: b"TGGN" (4B), version: u16=1, num_cases: u16=3
      For each case:
        sample_rate: u32, num_samples: u32, num_frames: u32, feat_dim: u16=32, out_dim: u16=12
        pcm: [f32; num_samples]
        feats: [f32; num_frames * 32]
        logits: [f32; num_frames * 12]
    """
    specs, scales, biases, weights_i8 = quantize_folded_model(model)
    rng = np.random.default_rng(12345)

    # Case A: 16 kHz, 0.20s (3200 samples -> 20 frames)
    sr_a = 16000
    t_a = np.arange(3200, dtype=np.float64) / sr_a
    pcm_a = np.zeros_like(t_a)
    # 0.00-0.05s fricative
    w = rng.standard_normal(800)
    pcm_a[:800] = (w - 0.92 * np.roll(w, 1)) * 0.14
    # 0.05-0.09s closure
    pcm_a[800:1440] = rng.standard_normal(640) * 1e-4
    # 0.09-0.12s burst
    pcm_a[1440:1920] = rng.standard_normal(480) * 0.18
    # 0.12-0.20s vowel+nasal harmonics
    pcm_a[1920:] = 0.28 * np.sin(2 * np.pi * 185 * t_a[1920:]) + 0.16 * np.sin(2 * np.pi * 740 * t_a[1920:])
    pcm_a = pcm_a.astype(np.float32)

    # Case B: 44.1 kHz, 0.08s (3528 samples -> ~8 frames, tests non-integer Hann-Sinc resampler)
    sr_b = 44100
    t_b = np.arange(3528, dtype=np.float64) / sr_b
    pcm_b = (
        0.02  # small DC offset to verify DC removal!
        + 0.25 * np.sin(2 * np.pi * 220.0 * t_b)
        + 0.15 * np.sin(2 * np.pi * 1320.0 * t_b)
        + 0.05 * rng.standard_normal(len(t_b))
    ).astype(np.float32)

    # Case C: 8 kHz, 0.14s (1120 samples -> 14 frames, narrowband + pure white noise tail)
    sr_c = 8000
    t_c = np.arange(1120, dtype=np.float64) / sr_c
    pcm_c = np.concatenate([
        0.22 * np.sin(2 * np.pi * 160.0 * t_c[:560]) + 0.12 * np.sin(2 * np.pi * 960.0 * t_c[:560]),
        0.002 * rng.standard_normal(560),
    ]).astype(np.float32)

    cases = [(sr_a, pcm_a), (sr_b, pcm_b), (sr_c, pcm_c)]
    buf = bytearray()
    buf += struct.pack("<4sHH", b"TGGN", 1, len(cases))

    info = {}
    for idx, (sr, pcm) in enumerate(cases):
        feats = extract_features(pcm, sr).astype(np.float32)
        logits = forward_quantized_numpy(feats, specs, scales, biases, weights_i8).astype(np.float32)
        t_len = feats.shape[0]
        buf += struct.pack("<IIIHH", sr, len(pcm), t_len, 32, 12)
        buf += np.ascontiguousarray(pcm, dtype="<f4").tobytes()
        buf += np.ascontiguousarray(feats, dtype="<f4").tobytes()
        buf += np.ascontiguousarray(logits, dtype="<f4").tobytes()
        info[f"case_{idx}"] = {"sr": sr, "samples": len(pcm), "frames": t_len}

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(bytes(buf))
    return len(buf), info


def load_tgnn_into_model(path: Path) -> Tuple[MicroSegNet, Dict[str, object]]:
    """
    Load a verified `.tgnn` binary weight file directly into a BN-folded `MicroSegNet`
    (ready for inference or INT8 QAT dialect fine-tuning without external `.pt` checkpoints).
    """
    raw = path.read_bytes()
    if len(raw) < 64:
        raise ValueError(f"Invalid .tgnn file (too short: {len(raw)} bytes): {path}")

    (
        magic,
        ver,
        arch,
        sr,
        hop,
        in_d,
        out_d,
        hid,
        n_layers,
        _res,
        w_bytes,
        ch_cnt,
        crc_expected,
        tag_raw,
    ) = struct.unpack("<4sHHIHHHHHHIII28s", raw[:64])

    if magic != b"TGNN":
        raise ValueError(f"Invalid .tgnn magic: {magic!r}")
    if ver != 1 or arch != 1:
        raise ValueError(f"Unsupported .tgnn version/arch: ver={ver}, arch={arch}")

    crc_actual = zlib.crc32(raw[64:]) & 0xFFFFFFFF
    if crc_actual != crc_expected:
        raise ValueError(
            f".tgnn CRC32 mismatch in {path}: expected 0x{crc_expected:08x}, got 0x{crc_actual:08x}"
        )

    tag = tag_raw.split(b"\x00", 1)[0].decode("utf-8", errors="replace")

    off = 64
    descs = []
    for _ in range(n_layers):
        descs.append(struct.unpack("<BBBBHHHHI", raw[off : off + 16]))
        off += 16

    scales = np.frombuffer(raw[off : off + ch_cnt * 4], dtype="<f4").copy()
    off += ch_cnt * 4
    biases = np.frombuffer(raw[off : off + ch_cnt * 4], dtype="<f4").copy()
    off += ch_cnt * 4
    weights_i8 = np.frombuffer(raw[off : off + w_bytes], dtype="i1").copy()
    if off + w_bytes != len(raw):
        raise ValueError(f"Unexpected trailing bytes in {path}: expected {off + w_bytes}, got {len(raw)}")

    # Recover block dilations from descriptors (indices 1, 4, 7, 10, 13 for 5 ConvNeXt blocks)
    block_dilations = tuple(int(descs[1 + 3 * b][4]) for b in range((n_layers - 3) // 3))
    model = MicroSegNet(in_dim=in_d, hidden_dim=hid, out_dim=out_d, dilations=block_dilations)
    model.fold_all_bn()

    specs = model.all_conv_layers()
    if len(specs) != n_layers:
        raise ValueError(f"Layer count mismatch: model has {len(specs)}, file has {n_layers}")

    with torch.no_grad():
        for spec, desc in zip(specs, descs):
            op, _act, _res_m, k, _dil, c_in, c_out, p_idx, w_off = desc
            sc = scales[p_idx : p_idx + c_out]
            bi = biases[p_idx : p_idx + c_out]
            if op == 0:
                n_w = c_out * c_in
                w_q = weights_i8[w_off : w_off + n_w].reshape(c_out, c_in).astype(np.float32)
                w_fp32 = (w_q * sc[:, None]).reshape(c_out, c_in, 1)
            else:
                n_w = k * c_out
                # Depthwise weights are stored [K, c_out] -> transpose to [c_out, 1, K]
                w_q = weights_i8[w_off : w_off + n_w].reshape(k, c_out).T.astype(np.float32)
                w_fp32 = (w_q * sc[:, None]).reshape(c_out, 1, k)
            spec.module.conv.weight.data.copy_(torch.from_numpy(w_fp32))
            if spec.module.conv.bias is None:
                spec.module.conv.bias = torch.nn.Parameter(torch.from_numpy(bi.copy()))
            else:
                spec.module.conv.bias.data.copy_(torch.from_numpy(bi))

    header_info: Dict[str, object] = {
        "version": ver,
        "arch_id": arch,
        "sample_rate": sr,
        "hop_samples": hop,
        "in_dim": in_d,
        "out_dim": out_d,
        "hidden_dim": hid,
        "num_layers": n_layers,
        "weight_bytes": w_bytes,
        "channel_count": ch_cnt,
        "crc32_ieee": f"0x{crc_expected:08x}",
        "model_tag": tag,
        "file_bytes": len(raw),
    }
    return model, header_info
