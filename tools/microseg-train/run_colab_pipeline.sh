#!/usr/bin/env bash
# End-to-end training script for TGrid-AcouSeg 1.0 on Google Colab (T4 / L4 GPU) or Linux GPU host.
# Pass `--skip-dialects` to prepare_corpora.py if you want a strictly permissive-license reproduction
# without Meta MMS_FA (CC-BY-NC-4.0) aligned dialect subsets.
set -euo pipefail

export MPLBACKEND=Agg
export HF_HUB_DISABLE_PROGRESS_BARS=1
export TOKENIZERS_PARALLELISM=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${DATA_DIR:-$SCRIPT_DIR/data/acouseg}"
OUT="${OUT_DIR:-$SCRIPT_DIR/artifacts}"
EXTRA_PREP_ARGS="${EXTRA_PREP_ARGS:-}"
mkdir -p "$DATA" "$OUT"

echo "=== [1/5] Environment, Disk & GPU check ==="
nvidia-smi || true
df -h "$DATA"
nproc
python3 --version

echo "=== [2/5] Install Python dependencies ==="
pip install -q -r "$SCRIPT_DIR/requirements.txt"

echo "=== [3/5] Prepare multilingual & dialect corpora ==="
cd "$SCRIPT_DIR"
WORKERS=$(nproc)
python3 dataset/prepare_corpora.py \
  --work-dir "$DATA" \
  --aug-copies 2 \
  --workers "$WORKERS" \
  --version acouseg-1.0 \
  $EXTRA_PREP_ARGS

echo "=== [4/5] Train TGrid-AcouSeg 1.0 Standard (hidden_dim=96, 203.69 KiB INT8) ==="
python3 train_qat.py \
  --data-dir "$DATA" \
  --out-dir "$OUT" \
  --hidden-dim 96 \
  --version-tag acouseg-1.0 \
  --batch-size 96 \
  --fp32-epochs 35 \
  --qat-epochs 10 \
  --export-golden

echo "=== [5/5] Train TGrid-AcouSeg 1.0 Lite (hidden_dim=48, 57.06 KiB INT8) ==="
python3 train_qat.py \
  --data-dir "$DATA" \
  --out-dir "$OUT" \
  --hidden-dim 48 \
  --version-tag acouseg-1.0 \
  --batch-size 96 \
  --fp32-epochs 35 \
  --qat-epochs 10 \
  --export-golden

cp "$DATA/corpus_manifest_acouseg-1.0.json" "$OUT/corpus_manifest_acouseg-1.0.json"
ls -lh "$OUT"
echo "=== TGRID-ACOUSEG 1.0 TRAINING PIPELINE COMPLETED ==="
