"""Regenerate `nn_parity_golden.bin` directly from a trained `.tgnn` file using f64 dot-product parity."""
import struct
import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model.features_ref import extract_features
from model.microseg_net import ExportLayerSpec, forward_quantized_numpy


def load_tgnn_file(path: Path):
    b = path.read_bytes()
    magic, ver, arch, sr, hop, in_d, out_d, hid, n_layers, _res, w_bytes, ch_cnt, crc, tag = struct.unpack(
        "<4sHHIHHHHHHIII28s", b[:64]
    )
    assert magic == b"TGNN" and ver == 1
    specs = []
    off = 64
    for i in range(n_layers):
        op, act, res, k, dil, c_in, c_out, p_idx, w_off = struct.unpack("<BBBBHHHHI", b[off : off + 16])
        off += 16
        specs.append(ExportLayerSpec(f"L{i:02d}", op, act, res, k, dil, c_in, c_out, None))
    scales = np.frombuffer(b[off : off + ch_cnt * 4], dtype="<f4").copy()
    off += ch_cnt * 4
    biases = np.frombuffer(b[off : off + ch_cnt * 4], dtype="<f4").copy()
    off += ch_cnt * 4
    weights = np.frombuffer(b[off : off + w_bytes], dtype="i1").copy()
    return specs, scales, biases, weights


def main():
    tgnn_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    specs, scales, biases, weights_i8 = load_tgnn_file(tgnn_path)

    rng = np.random.default_rng(12345)
    # Case A: 16 kHz, 0.20s
    sr_a = 16000
    t_a = np.arange(3200, dtype=np.float64) / sr_a
    pcm_a = np.zeros_like(t_a)
    w = rng.standard_normal(800)
    pcm_a[:800] = (w - 0.92 * np.roll(w, 1)) * 0.14
    pcm_a[800:1440] = rng.standard_normal(640) * 1e-4
    pcm_a[1440:1920] = rng.standard_normal(480) * 0.18
    pcm_a[1920:] = 0.28 * np.sin(2 * np.pi * 185 * t_a[1920:]) + 0.16 * np.sin(2 * np.pi * 740 * t_a[1920:])
    pcm_a = pcm_a.astype(np.float32)

    # Case B: 44.1 kHz, 0.08s
    sr_b = 44100
    t_b = np.arange(3528, dtype=np.float64) / sr_b
    pcm_b = (
        0.02
        + 0.25 * np.sin(2 * np.pi * 220.0 * t_b)
        + 0.15 * np.sin(2 * np.pi * 1320.0 * t_b)
        + 0.05 * rng.standard_normal(len(t_b))
    ).astype(np.float32)

    # Case C: 8 kHz, 0.14s
    sr_c = 8000
    t_c = np.arange(1120, dtype=np.float64) / sr_c
    pcm_c = np.concatenate([
        0.22 * np.sin(2 * np.pi * 160.0 * t_c[:560]) + 0.12 * np.sin(2 * np.pi * 960.0 * t_c[:560]),
        0.002 * rng.standard_normal(560),
    ]).astype(np.float32)

    cases = [(sr_a, pcm_a), (sr_b, pcm_b), (sr_c, pcm_c)]
    buf = bytearray()
    buf += struct.pack("<4sHH", b"TGGN", 1, len(cases))
    for sr, pcm in cases:
        feats = extract_features(pcm, sr).astype(np.float32)
        logits = forward_quantized_numpy(feats, specs, scales, biases, weights_i8).astype(np.float32)
        buf += struct.pack("<IIIHH", sr, len(pcm), feats.shape[0], 32, 12)
        buf += np.ascontiguousarray(pcm, dtype="<f4").tobytes()
        buf += np.ascontiguousarray(feats, dtype="<f4").tobytes()
        buf += np.ascontiguousarray(logits, dtype="<f4").tobytes()
    out_path.write_bytes(bytes(buf))
    print(f"Regenerated {out_path} ({len(buf)} bytes)")


if __name__ == "__main__":
    main()
