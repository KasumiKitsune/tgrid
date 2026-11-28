"""
TGrid-AcouSeg 1.0 (MicroSegNet) PyTorch model definition with:
  - Dynamic hidden_dim (96 for standard 203.69 KiB model, 48 for 57.06 KiB lite variant)
  - 18 Conv1d layers with Replicate boundary padding & ReLU6 activations
  - Exact analytical BatchNorm1d folding into Conv1d weights/biases
  - Per-output-channel symmetric INT8 QAT (FakeQuantize [-127, 127] with STE)
  - Exact INT8 simulated forward pass matching Rust `crates/tg-core/src/nn/tgnn.rs`
"""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass
from typing import List, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


class SymmetricPerChannelFakeQuant(torch.autograd.Function):
    @staticmethod
    def forward(ctx, weight: torch.Tensor) -> torch.Tensor:
        # weight: [C_out, ...]
        flat = weight.view(weight.shape[0], -1)
        max_abs = flat.abs().amax(dim=1).clamp(min=1e-8)
        scale = max_abs / 127.0
        scale_view = scale.view(-1, *([1] * (weight.ndim - 1)))
        q = torch.round(weight / scale_view).clamp(-127.0, 127.0)
        return q * scale_view

    @staticmethod
    def backward(ctx, grad_output: torch.Tensor) -> torch.Tensor:
        # Straight-Through Estimator (STE)
        return grad_output


def fake_quant_per_channel(w: torch.Tensor) -> torch.Tensor:
    return SymmetricPerChannelFakeQuant.apply(w)


class ReplicateConv1d(nn.Module):
    """Conv1d with replicate boundary padding and optional per-channel INT8 QAT."""

    def __init__(
        self,
        c_in: int,
        c_out: int,
        kernel: int = 1,
        dilation: int = 1,
        groups: int = 1,
        use_bn: bool = True,
        act_relu6: bool = False,
    ):
        super().__init__()
        self.c_in = c_in
        self.c_out = c_out
        self.kernel = kernel
        self.dilation = dilation
        self.groups = groups
        self.act_relu6 = act_relu6
        self.pad = (kernel // 2) * dilation

        self.conv = nn.Conv1d(
            c_in,
            c_out,
            kernel_size=kernel,
            dilation=dilation,
            groups=groups,
            padding=0,
            bias=not use_bn,
        )
        self.bn = nn.BatchNorm1d(c_out) if use_bn else None
        self.qat_enabled = False

    def fold_bn(self) -> None:
        if self.bn is None:
            return
        with torch.no_grad():
            bn = self.bn
            std = torch.sqrt(bn.running_var + bn.eps)
            scale = bn.weight / std
            w = self.conv.weight.data
            b = (
                self.conv.bias.data
                if self.conv.bias is not None
                else torch.zeros(self.c_out, device=w.device, dtype=w.dtype)
            )
            w_folded = w * scale.view(-1, 1, 1)
            b_folded = (b - bn.running_mean) * scale + bn.bias
            self.conv.weight.data.copy_(w_folded)
            if self.conv.bias is None:
                self.conv.bias = nn.Parameter(b_folded.clone())
            else:
                self.conv.bias.data.copy_(b_folded)
            self.bn = None

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self.pad > 0:
            x = F.pad(x, (self.pad, self.pad), mode="replicate")
        w = fake_quant_per_channel(self.conv.weight) if self.qat_enabled else self.conv.weight
        y = F.conv1d(
            x,
            w,
            bias=self.conv.bias,
            dilation=self.dilation,
            groups=self.groups,
        )
        if self.bn is not None:
            y = self.bn(y)
        if self.act_relu6:
            y = F.relu6(y)
        return y


class ConvNeXtBlock1d(nn.Module):
    def __init__(self, hidden_dim: int, dilation: int):
        super().__init__()
        exp_dim = hidden_dim * 2
        self.dw = ReplicateConv1d(
            hidden_dim, hidden_dim, kernel=5, dilation=dilation, groups=hidden_dim, use_bn=True, act_relu6=False
        )
        self.pw_exp = ReplicateConv1d(
            hidden_dim, exp_dim, kernel=1, dilation=1, groups=1, use_bn=True, act_relu6=True
        )
        self.pw_prj = ReplicateConv1d(
            exp_dim, hidden_dim, kernel=1, dilation=1, groups=1, use_bn=True, act_relu6=False
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = self.dw(x)
        h = self.pw_exp(h)
        h = self.pw_prj(h)
        return x + h


@dataclass
class ExportLayerSpec:
    name: str
    op_kind: int  # 0=Pointwise, 1=Depthwise
    act_kind: int  # 0=Identity, 1=ReLU6
    res_mode: int  # 0=None, 1=PushAndKeep, 2=PopAndAdd
    kernel: int
    dilation: int
    c_in: int
    c_out: int
    module: ReplicateConv1d


class MicroSegNet(nn.Module):
    """TGrid-AcouSeg 1.0 backbone: 18-layer Dilated Depthwise-Separable ConvNeXt-1D."""

    def __init__(self, in_dim: int = 32, hidden_dim: int = 48, out_dim: int = 12, dilations=(1, 1, 2, 4, 8)):
        super().__init__()
        self.in_dim = in_dim
        self.hidden_dim = hidden_dim
        self.out_dim = out_dim
        self.dilations = tuple(dilations)

        self.stem_pw = ReplicateConv1d(in_dim, hidden_dim, kernel=1, use_bn=True, act_relu6=True)
        self.blocks = nn.ModuleList([ConvNeXtBlock1d(hidden_dim, d) for d in self.dilations])
        self.head_neck = ReplicateConv1d(
            hidden_dim, hidden_dim, kernel=3, dilation=1, groups=hidden_dim, use_bn=True, act_relu6=True
        )
        self.head_out = ReplicateConv1d(hidden_dim, out_dim, kernel=1, use_bn=False, act_relu6=False)

    def all_conv_layers(self) -> List[ExportLayerSpec]:
        specs: List[ExportLayerSpec] = [
            ExportLayerSpec("stem_pw", 0, 1, 0, 1, 1, self.in_dim, self.hidden_dim, self.stem_pw)
        ]
        for idx, (blk, d) in enumerate(zip(self.blocks, self.dilations)):
            h = self.hidden_dim
            specs.append(ExportLayerSpec(f"b{idx}_dw", 1, 0, 1, 5, d, h, h, blk.dw))
            specs.append(ExportLayerSpec(f"b{idx}_pw_exp", 0, 1, 0, 1, 1, h, h * 2, blk.pw_exp))
            specs.append(ExportLayerSpec(f"b{idx}_pw_prj", 0, 0, 2, 1, 1, h * 2, h, blk.pw_prj))
        specs.append(
            ExportLayerSpec("head_neck", 1, 1, 0, 3, 1, self.hidden_dim, self.hidden_dim, self.head_neck)
        )
        specs.append(
            ExportLayerSpec("head_out", 0, 0, 0, 1, 1, self.hidden_dim, self.out_dim, self.head_out)
        )
        return specs

    def fold_all_bn(self) -> None:
        self.eval()
        for spec in self.all_conv_layers():
            spec.module.fold_bn()

    def enable_qat(self, enabled: bool = True) -> None:
        for spec in self.all_conv_layers():
            spec.module.qat_enabled = enabled

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Args:
            x: [B, T, 32] float32 feature tensor
        Returns:
            logits: [B, T, 12] float32 logits
        """
        h = x.transpose(1, 2)  # [B, 32, T]
        h = self.stem_pw(h)
        for blk in self.blocks:
            h = blk(h)
        h = self.head_neck(h)
        h = self.head_out(h)
        return h.transpose(1, 2)  # [B, T, 12]


def quantize_folded_model(model: MicroSegNet) -> Tuple[List[ExportLayerSpec], np.ndarray, np.ndarray, np.ndarray]:
    """
    Fold any remaining BN (on a copy) and quantize all layers to symmetric per-channel INT8.
    Returns: (specs, scales_f32, biases_f32, weights_i8)
    """
    m = copy.deepcopy(model).cpu().eval()
    m.fold_all_bn()
    specs = m.all_conv_layers()

    scales_list: List[np.ndarray] = []
    biases_list: List[np.ndarray] = []
    weights_list: List[np.ndarray] = []

    for spec in specs:
        w = spec.module.conv.weight.detach().cpu().numpy().astype(np.float32)
        b = (
            spec.module.conv.bias.detach().cpu().numpy().astype(np.float32)
            if spec.module.conv.bias is not None
            else np.zeros((spec.c_out,), dtype=np.float32)
        )
        # w shape: Pointwise [c_out, c_in, 1], Depthwise [c_out, 1, K]
        flat = w.reshape(spec.c_out, -1)
        max_abs = np.maximum(np.max(np.abs(flat), axis=1), 1e-8)
        scale = (max_abs / 127.0).astype(np.float32)
        q = np.clip(np.round(flat / scale[:, None]), -127, 127).astype(np.int8)

        if spec.op_kind == 0:
            # Pointwise: [c_out, c_in] row-major
            w_packed = q.reshape(-1)
        else:
            # Depthwise: [K, c_out] time-major, channel-contiguous!
            # flat is [c_out, K] -> transpose to [K, c_out]
            w_packed = np.ascontiguousarray(q.T).reshape(-1)

        scales_list.append(scale)
        biases_list.append(b)
        weights_list.append(w_packed)

    return (
        specs,
        np.concatenate(scales_list).astype(np.float32),
        np.concatenate(biases_list).astype(np.float32),
        np.concatenate(weights_list).astype(np.int8),
    )


def forward_quantized_numpy(
    feat: np.ndarray,
    specs: List[ExportLayerSpec],
    scales: np.ndarray,
    biases: np.ndarray,
    weights_i8: np.ndarray,
) -> np.ndarray:
    """
    Exact NumPy float32 simulation of Rust `MicroSegNet::forward_features`
    (guaranteed bit-close < 1e-5 parity).
    """
    x = np.asarray(feat, dtype=np.float32)  # [T, 32]
    t_len = x.shape[0]
    p_idx = 0
    w_off = 0
    res_buf = None

    for spec in specs:
        c_in = spec.c_in
        c_out = spec.c_out
        sc = scales[p_idx : p_idx + c_out]
        bi = biases[p_idx : p_idx + c_out]
        p_idx += c_out

        if spec.res_mode == 1:
            res_buf = x.copy()

        if spec.op_kind == 0:
            n_w = c_out * c_in
            w_mat = weights_i8[w_off : w_off + n_w].reshape(c_out, c_in).astype(np.float64)
            w_off += n_w
            acc = x.astype(np.float64) @ w_mat.T
            y = (acc * sc.astype(np.float64)[None, :] + bi.astype(np.float64)[None, :]).astype(np.float32)
        else:
            k = spec.kernel
            d = spec.dilation
            n_w = k * c_out
            w_kc = weights_i8[w_off : w_off + n_w].reshape(k, c_out).astype(np.float64)
            w_off += n_w
            half = (k // 2) * d
            t_idx = np.arange(t_len, dtype=np.int64)
            acc = np.zeros((t_len, c_out), dtype=np.float64)
            for tap in range(k):
                src = np.clip(t_idx + tap * d - half, 0, t_len - 1)
                acc += x[src].astype(np.float64) * w_kc[tap][None, :]
            y = (acc * sc.astype(np.float64)[None, :] + bi.astype(np.float64)[None, :]).astype(np.float32)

        if spec.act_kind == 1:
            y = np.clip(y, 0.0, 6.0)
        if spec.res_mode == 2:
            y = y + res_buf
        x = y.astype(np.float32)

    return x
