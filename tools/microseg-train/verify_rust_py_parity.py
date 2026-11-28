"""
Verify exact numerical parity between Rust `crates/tg-core/src/nn/features.rs`
and Python `tools/microseg-train/model/features_ref.py` across 16 kHz, 44.1 kHz, and 8 kHz.
"""
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model.features_ref import extract_features


def run_rust_feat(exe: Path, pcm: np.ndarray, sr: int) -> np.ndarray:
    with tempfile.TemporaryDirectory() as td:
        in_p = Path(td) / "in.f32"
        out_p = Path(td) / "out.f32"
        np.ascontiguousarray(pcm, dtype="<f4").tofile(in_p)
        subprocess.run([str(exe), "f32", str(in_p), str(sr), str(out_p)], check=True)
        raw = out_p.read_bytes()
        n_frames, dim = struct.unpack("<II", raw[:8])
        assert dim == 32
        arr = np.frombuffer(raw[8:], dtype="<f4").reshape(n_frames, dim).copy()
        return arr


def main():
    exe = Path(sys.argv[1])
    rng = np.random.default_rng(777)

    cases = [
        ("16kHz speech-like", 16000, (0.25 * np.sin(2 * np.pi * 180 * np.arange(4800) / 16000) + 0.08 * rng.standard_normal(4800)).astype(np.float32)),
        ("44.1kHz + DC offset", 44100, (0.03 + 0.20 * np.sin(2 * np.pi * 240 * np.arange(8820) / 44100) + 0.10 * np.sin(2 * np.pi * 1900 * np.arange(8820) / 44100) + 0.04 * rng.standard_normal(8820)).astype(np.float32)),
        ("8kHz narrowband + noise", 8000, np.concatenate([0.22 * np.sin(2 * np.pi * 150 * np.arange(1600) / 8000), 0.001 * rng.standard_normal(1600)]).astype(np.float32)),
    ]

    max_overall = 0.0
    for name, sr, pcm in cases:
        py_f = extract_features(pcm, sr)
        rs_f = run_rust_feat(exe, pcm, sr)
        assert py_f.shape == rs_f.shape, f"{name}: shape mismatch py={py_f.shape} rs={rs_f.shape}"
        diff = float(np.max(np.abs(py_f - rs_f)))
        max_overall = max(max_overall, diff)
        print(f"[parity] {name:26s} shape={py_f.shape} max_abs_diff={diff:.3e}")
        assert diff < 5e-5, f"Parity failed for {name}: {diff}"

    print(f"[parity] ALL PASSED! overall max_abs_diff = {max_overall:.3e}")


if __name__ == "__main__":
    main()
