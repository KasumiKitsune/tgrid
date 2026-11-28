"""
Multi-task losses for TGrid-AcouSeg 1.0:
  - Manner WCE (8 classes, 1.5x weight on STOP_CL/BURST_ASP/NASAL/LIQUID_GLIDE, label smoothing 0.03)
  - Continuous Focal BCE for 5ms phone boundaries (2.5x) & 10ms syllable boundaries (2.0x)
  - BCE for calibrated VAD speech activity (1.0x)
  - Supports per-sample / per-task masks so corpora lacking syllable or phone tiers never emit false penalties.
"""
import torch
import torch.nn as nn
import torch.nn.functional as F


class MicroSegLoss(nn.Module):
    def __init__(self):
        super().__init__()
        # [SIL, STOP_CL, BURST_ASP, FRIC_VL, OBS_VD, NASAL, LIQUID_GLIDE, VOWEL]
        self.register_buffer(
            "manner_weights",
            torch.tensor([1.0, 1.5, 1.5, 1.2, 1.2, 1.5, 1.5, 1.0], dtype=torch.float32),
        )

    @staticmethod
    def continuous_focal_bce(
        logits: torch.Tensor,
        targets: torch.Tensor,
        mask: torch.Tensor,
        gamma: float = 2.0,
        peak_weight: float = 4.0,
    ) -> torch.Tensor:
        probs = torch.sigmoid(logits)
        bce = F.binary_cross_entropy_with_logits(logits, targets, reduction="none")
        focal = (targets - probs).abs().pow(gamma)
        # Boost positive peak regions smoothly
        pos_w = 1.0 + (peak_weight - 1.0) * targets
        loss_mat = focal * pos_w * bce * mask
        denom = mask.sum().clamp(min=1.0)
        return loss_mat.sum() / denom

    def forward(
        self,
        logits: torch.Tensor,
        manner_tgt: torch.Tensor,
        manner_mask: torch.Tensor,
        pbnd_tgt: torch.Tensor,
        pbnd_mask: torch.Tensor,
        sbnd_tgt: torch.Tensor,
        sbnd_mask: torch.Tensor,
        vad_tgt: torch.Tensor,
        vad_mask: torch.Tensor,
    ) -> tuple[torch.Tensor, dict[str, float]]:
        """
        logits:      [B, T, 12]
        manner_tgt:  [B, T] long in 0..7
        manner_mask: [B, T] float 0/1
        pbnd_tgt:    [B, T, 2] float in [0, 1]
        pbnd_mask:   [B, T, 2] float 0/1
        sbnd_tgt:    [B, T] float in [0, 1]
        sbnd_mask:   [B, T] float 0/1
        vad_tgt:     [B, T] float in [0, 1]
        vad_mask:    [B, T] float 0/1
        """
        # 1. Manner weighted CE with label smoothing 0.03
        m_logits = logits[:, :, 0:8].reshape(-1, 8)
        m_tgt = manner_tgt.reshape(-1)
        m_msk = manner_mask.reshape(-1)
        ce_raw = F.cross_entropy(
            m_logits,
            m_tgt,
            weight=self.manner_weights,
            reduction="none",
            label_smoothing=0.03,
        )
        loss_manner = (ce_raw * m_msk).sum() / m_msk.sum().clamp(min=1.0)

        # 2. 5ms sub-frame phone boundary Continuous Focal BCE
        loss_pbnd = self.continuous_focal_bce(logits[:, :, 8:10], pbnd_tgt, pbnd_mask, gamma=2.0, peak_weight=4.0)

        # 3. 10ms syllable boundary Continuous Focal BCE
        loss_sbnd = self.continuous_focal_bce(logits[:, :, 10], sbnd_tgt, sbnd_mask, gamma=2.0, peak_weight=4.0)

        # 4. VAD BCE
        vad_bce = F.binary_cross_entropy_with_logits(logits[:, :, 11], vad_tgt, reduction="none")
        loss_vad = (vad_bce * vad_mask).sum() / vad_mask.sum().clamp(min=1.0)

        total = 1.0 * loss_manner + 2.5 * loss_pbnd + 2.0 * loss_sbnd + 1.0 * loss_vad
        metrics = {
            "loss": float(total.detach().item()),
            "manner": float(loss_manner.detach().item()),
            "pbnd": float(loss_pbnd.detach().item()),
            "sbnd": float(loss_sbnd.detach().item()),
            "vad": float(loss_vad.detach().item()),
        }
        return total, metrics
