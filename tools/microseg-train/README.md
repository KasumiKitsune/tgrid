# `TGrid-AcouSeg 1.0` 训练、复现与方言微调工程

本目录包含 **T·Grid** 内置轻量声学边界模型 **`TGrid-AcouSeg 1.0`** 的完整训练、量化导出、跨语言数值对拍以及自定义方言微调脚手架。

关于模型架构、32 维零漂移特征定义、`.tgnn` 二进制格式、评测基准与语料许可边界的完整说明，请先阅读：
- **[`docs/ACOUSEG_MODEL_SPEC.md`](../../docs/ACOUSEG_MODEL_SPEC.md)**

---

## 目录结构

```text
tools/microseg-train/
├── README.md                  # 本操作手册
├── requirements.txt           # Python 依赖（核心微调依赖 + 全量语料训练依赖）
├── finetune_dialect.py        # 独立方言微调脚本（本地 CPU 2-4 分钟，冻结前 4 块 + 掩码蒸馏 QAT）
├── train_qat.py               # 两阶段训练脚本（FP32 预训练 -> BN 折叠 -> 逐通道对称 INT8 QAT）
├── export_tgnn.py             # `.tgnn` 64 字节对齐二进制读写与黄金对拍文件生成
├── regen_golden.py            # 从任意 `.tgnn` 重建 Rust 数值一致性黄金向量 `nn_parity_golden.bin`
├── verify_rust_py_parity.py   # 校验 Rust `feat_dump_cli` 与 Python `features_ref.py` 特征误差
├── run_colab_pipeline.sh      # Google Colab / Linux GPU 一键完整训练脚本
├── dataset/
│   ├── ipa_manner_map.py      # 语言无关 IPA/ARPAbet/TIMIT/Pinyin -> 8 类发音方式与塞音闭塞/除阻拆分
│   ├── augment_field.py       # 9 项田野/耳语/孤立单字增强与困难负样本生成
│   ├── align_dialects_mms.py  # 基于 MMS_FA 的方言 GPU 强制对齐与置信度过滤（可选）
│   └── prepare_corpora.py     # 多语种语料拉取、说话人隔离切分与 `.npz` 特征打包
├── model/
│   ├── features_ref.py        # 与 `crates/tg-core/src/nn/features.rs` 逐公式对齐的 NumPy 参考前端
│   ├── microseg_net.py        # 18 层 ConvNeXt-1D 模型、BN 解析折叠与 INT8 精确模拟前向
│   └── losses.py              # 多任务联合损失（发音方式 WCE + 连续 Focal BCE + VAD BCE）
└── feat-dump-cli/
    └── main.rs                # 零依赖 Rust 批量特征导出 CLI（直接复用 `tg-core` 前端）
```

---

## 快速上手一：用自有方言语料本地微调（推荐给语音学研究者）

当你拥有 **30–200 条**（约 **3–20 分钟**）目标方言或田野语料的已核校 `.wav + .TextGrid` 文件时，无需 GPU，直接在普通笔记本 CPU 上即可完成微调，输出与内置模型完全同构的 `208,576 B` `.tgnn` 权重文件。

### 1. 安装核心依赖

```bash
cd tools/microseg-train
pip install numpy scipy soundfile torch
```

### 2. 准备目录并运行微调

将配对的 `.wav` 与同名 `.TextGrid` 放入同一文件夹（支持嵌套子目录；支持仅含音节/汉字层、仅含音素层或双层完整 TextGrid）：

```bash
python finetune_dialect.py \
  --input ./my_dialect_corpus \
  --output ./artifacts/my_dialect_acouseg.tgnn \
  --base-model ../../crates/tg-core/src/nn/weights/tgrid-acouseg-1.0.tgnn \
  --tag acouseg-1.0-dialect \
  --epochs 16
```

常用可选参数：
- `--phone-tier <层名>` / `--syllable-tier <层名>`：显式指定 TextGrid 中的音素层或音节/词层名称（不填则自动推断）。
- `--alphabet auto|ipa|pinyin|arpa`：指定音素层符号体系（默认 `auto`）。
- `--kd-weight 0.25`：基座模型知识蒸馏锚点系数，防止在纯音节标注上微调时遗忘音素/声韵切分能力。

运行结束后脚本会打印验证集微调前后的 Loss、边界 F1 与 MAE 对比，并将结果导出至 `--output`。

---

## 快速上手二：在 Google Colab / Linux GPU 上完整复现训练

### 1. 完整多语种 + 方言路径（对应 `TGrid-AcouSeg 1.0` 默认配置）

```bash
cd tools/microseg-train
pip install -r requirements.txt

# 1) 准备 9 大语料 + 9 项田野增强（默认拉取 THCHS-30、5 类方言/关键音类与英语多口音）
python dataset/prepare_corpora.py \
  --work-dir ./data/acouseg \
  --aug-copies 2 \
  --workers 8 \
  --version acouseg-1.0

# 2) 训练标准档（hidden_dim=96，193,356 参数，208,576 B / 203.69 KiB）
python train_qat.py \
  --data-dir ./data/acouseg \
  --out-dir ./artifacts \
  --hidden-dim 96 \
  --version-tag acouseg-1.0 \
  --fp32-epochs 35 \
  --qat-epochs 10 \
  --export-golden

# 3) 可选：训练极致轻量档（hidden_dim=48，50,604 参数，58,432 B / 57.06 KiB）
python train_qat.py \
  --data-dir ./data/acouseg \
  --out-dir ./artifacts \
  --hidden-dim 48 \
  --version-tag acouseg-1.0 \
  --fp32-epochs 35 \
  --qat-epochs 10 \
  --export-golden
```

也可在 Colab / Linux GPU 上直接运行一键脚本：

```bash
bash run_colab_pipeline.sh
```

### 2. 纯商业友好协议复现路径（跳过 `MMS_FA`）

`dataset/align_dialects_mms.py` 使用的 Meta `torchaudio.pipelines.MMS_FA` 权重为 **CC-BY-NC-4.0** 协议。如需严格遵守商业友好协议从零复现，只需追加 `--skip-dialects`（或先用 Montreal Forced Aligner 替换方言对齐步骤）：

```bash
EXTRA_PREP_ARGS="--skip-dialects" bash run_colab_pipeline.sh
```

---

## 导出黄金对拍向量与运行 Rust 数值一致性测试

如果重新训练并计划替换 `crates/tg-core/src/nn/weights/tgrid-acouseg-1.0.tgnn`，请按以下两步验证 Python 与纯 Rust 推理器的比特级一致性：

```bash
# 1. 从新权重重新生成黄金对拍向量
python tools/microseg-train/regen_golden.py \
  crates/tg-core/src/nn/weights/tgrid-acouseg-1.0.tgnn \
  crates/tg-core/tests/fixtures/nn_parity_golden.bin

# 2. 运行 Rust 全工作区测试（含 16 kHz / 44.1 kHz / 8 kHz 数值对拍与 CRC32 校验）
cargo test --workspace
```

如需单独验证 Rust `feat_dump_cli` 与 Python `model/features_ref.py` 的 32 维声学特征对齐：

```bash
rustc -O -o tools/microseg-train/feat-dump-cli/feat_dump_cli tools/microseg-train/feat-dump-cli/main.rs
python tools/microseg-train/verify_rust_py_parity.py tools/microseg-train/feat-dump-cli/feat_dump_cli
```

---

## `.gitignore` 本地隔离说明

为保持开源仓库轻量且不泄露实验中间产物，根目录 `.gitignore` 已自动忽略以下本地路径（不会被 `git` 提交）：

- `tools/microseg-train/artifacts/`（本地实验权重、训练日志 JSON、临时评测输出）
- `tools/microseg-train/data/`、`cache/`、`checkpoints/`、`tmp/`、`runs/`
- `tools/microseg-train/` 下的大体积语料与缓存文件（`*.pt`、`*.pth`、`*.npz`、`*.f16`、`*.f32`、`*.wav`、`*.tar.gz`、`*.tgz`、`*.zip`、`__pycache__/`、`.colab*`）

正式发布的内置推理权重 `crates/tg-core/src/nn/weights/tgrid-acouseg-1.0.tgnn`（`208,576 bytes`）不受上述规则影响，随源码正常版本化发布。
