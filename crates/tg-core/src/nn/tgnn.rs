use crate::nn::features::{extract_features, AcousticFeatures, FEATURE_DIM};

pub const TGNN_MAGIC: &[u8; 4] = b"TGNN";
pub const TGNN_VERSION: u16 = 1;
pub const TGNN_ARCH_MICROSEG_V1: u16 = 1;
pub const TGNN_NUM_LAYERS_V1: usize = 18;
pub const TGNN_CHANNEL_COUNT_H48: usize = 1068;
pub const TGNN_WEIGHT_BYTES_H48: usize = 49_536;
pub const TGNN_HEADER_BYTES: usize = 64;
pub const TGNN_LAYER_DESC_BYTES: usize = 16;
pub const TGNN_TOTAL_BYTES: usize = 58_432; // Exact size for hidden_dim = 48 v1
pub const MICROSEG_OUT_DIM: usize = 12;

pub const MANNER_SIL: usize = 0;
pub const MANNER_STOP_CL: usize = 1;
pub const MANNER_BURST_ASP: usize = 2;
pub const MANNER_FRIC_VL: usize = 3;
pub const MANNER_OBS_VD: usize = 4;
pub const MANNER_NASAL: usize = 5;
pub const MANNER_LIQUID_GLIDE: usize = 6;
pub const MANNER_VOWEL: usize = 7;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TgnnError {
    InvalidLength { expected: usize, actual: usize },
    InvalidMagic,
    UnsupportedVersion(u16),
    UnsupportedArch(u16),
    InvalidDimensions,
    ChecksumMismatch { expected: u32, actual: u32 },
    InvalidLayerDesc(usize),
}

impl std::fmt::Display for TgnnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TgnnError::InvalidLength { expected, actual } => {
                write!(f, "invalid .tgnn length: expected {expected}, got {actual}")
            }
            TgnnError::InvalidMagic => write!(f, "invalid .tgnn magic (expected TGNN)"),
            TgnnError::UnsupportedVersion(v) => write!(f, "unsupported .tgnn version: {v}"),
            TgnnError::UnsupportedArch(a) => write!(f, "unsupported .tgnn arch_id: {a}"),
            TgnnError::InvalidDimensions => write!(f, "invalid .tgnn header dimensions"),
            TgnnError::ChecksumMismatch { expected, actual } => {
                write!(
                    f,
                    ".tgnn CRC32 mismatch: expected 0x{expected:08x}, got 0x{actual:08x}"
                )
            }
            TgnnError::InvalidLayerDesc(i) => write!(f, "invalid .tgnn layer descriptor at #{i}"),
        }
    }
}

impl std::error::Error for TgnnError {}

#[derive(Debug, Clone)]
pub struct TgnnHeader {
    pub version: u16,
    pub arch_id: u16,
    pub sample_rate: u32,
    pub hop_samples: u16,
    pub in_dim: u16,
    pub out_dim: u16,
    pub hidden_dim: u16,
    pub num_layers: u16,
    pub weight_bytes: u32,
    pub channel_count: u32,
    pub crc32_ieee: u32,
    pub model_tag: String,
}

#[derive(Debug, Clone, Copy)]
pub struct LayerDesc {
    pub op_kind: u8,    // 0 = Pointwise, 1 = Depthwise
    pub act_kind: u8,   // 0 = Identity, 1 = ReLU6
    pub res_mode: u8,   // 0 = None, 1 = PushAndKeep (save input), 2 = PopAndAdd (add saved to output)
    pub kernel: u8,
    pub dilation: u16,
    pub c_in: u16,
    pub c_out: u16,
    pub param_idx: u16,
    pub weight_off: u32,
}

/// Standard IEEE 802.3 CRC32 (polynomial 0xEDB88320).
pub fn crc32_ieee(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in bytes {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320u32 & mask);
        }
    }
    !crc
}

#[inline]
fn read_u16_le(bytes: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([bytes[off], bytes[off + 1]])
}

#[inline]
fn read_u32_le(bytes: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
}

#[inline]
fn read_f32_le(bytes: &[u8], off: usize) -> f32 {
    f32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
}

/// Decoded posteriors for a sequence of `T` frames (10 ms hop, 100 Hz).
#[derive(Debug, Clone)]
pub struct MicroSegPosteriors {
    pub num_frames: usize,
    /// Raw 12-dim logits `[T * 12]`
    pub logits: Vec<f32>,
    /// Softmax 8-class manner posteriors `[T * 8]`
    pub manner_probs: Vec<f32>,
    /// 5 ms sub-frame phone boundary probabilities `[T * 2]` (200 Hz)
    pub phone_bnd_5ms: Vec<f32>,
    /// 10 ms syllable boundary probabilities `[T]` (100 Hz)
    pub syl_bnd_10ms: Vec<f32>,
    /// 10 ms calibrated VAD speech probabilities `[T]` (100 Hz)
    pub vad_speech_10ms: Vec<f32>,
}

/// Parsed zero-dependency `TGrid-MicroSegNet v1` model.
#[derive(Debug, Clone)]
pub struct MicroSegNet {
    pub header: TgnnHeader,
    pub layers: Vec<LayerDesc>,
    pub scales: Vec<f32>,
    pub biases: Vec<f32>,
    pub weights: Vec<i8>,
    max_channels: usize,
}

impl MicroSegNet {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, TgnnError> {
        if bytes.len() < TGNN_HEADER_BYTES {
            return Err(TgnnError::InvalidLength {
                expected: TGNN_HEADER_BYTES,
                actual: bytes.len(),
            });
        }
        if &bytes[0..4] != TGNN_MAGIC {
            return Err(TgnnError::InvalidMagic);
        }

        let version = read_u16_le(bytes, 4);
        if version != TGNN_VERSION {
            return Err(TgnnError::UnsupportedVersion(version));
        }
        let arch_id = read_u16_le(bytes, 6);
        if arch_id != TGNN_ARCH_MICROSEG_V1 {
            return Err(TgnnError::UnsupportedArch(arch_id));
        }

        let sample_rate = read_u32_le(bytes, 8);
        let hop_samples = read_u16_le(bytes, 12);
        let in_dim = read_u16_le(bytes, 14);
        let out_dim = read_u16_le(bytes, 16);
        let hidden_dim = read_u16_le(bytes, 18);
        let num_layers = read_u16_le(bytes, 20);
        let weight_bytes = read_u32_le(bytes, 24);
        let channel_count = read_u32_le(bytes, 28);
        let crc32_expected = read_u32_le(bytes, 32);

        if sample_rate != 16_000
            || hop_samples != 160
            || in_dim as usize != FEATURE_DIM
            || out_dim as usize != MICROSEG_OUT_DIM
            || hidden_dim == 0
            || num_layers == 0
            || weight_bytes == 0
            || channel_count == 0
        {
            return Err(TgnnError::InvalidDimensions);
        }

        let n_layers = num_layers as usize;
        let n_channels = channel_count as usize;
        let n_weights = weight_bytes as usize;
        let scales_off = TGNN_HEADER_BYTES + n_layers * TGNN_LAYER_DESC_BYTES;
        let biases_off = scales_off + n_channels * 4;
        let weights_off = biases_off + n_channels * 4;
        let expected_total = weights_off + n_weights;

        if bytes.len() != expected_total {
            return Err(TgnnError::InvalidLength {
                expected: expected_total,
                actual: bytes.len(),
            });
        }

        let crc32_actual = crc32_ieee(&bytes[TGNN_HEADER_BYTES..]);
        if crc32_actual != crc32_expected {
            return Err(TgnnError::ChecksumMismatch {
                expected: crc32_expected,
                actual: crc32_actual,
            });
        }

        let tag_raw = &bytes[36..64];
        let tag_end = tag_raw.iter().position(|&b| b == 0).unwrap_or(tag_raw.len());
        let model_tag = String::from_utf8_lossy(&tag_raw[..tag_end]).into_owned();

        let header = TgnnHeader {
            version,
            arch_id,
            sample_rate,
            hop_samples,
            in_dim,
            out_dim,
            hidden_dim,
            num_layers,
            weight_bytes,
            channel_count,
            crc32_ieee: crc32_expected,
            model_tag,
        };

        let mut layers = Vec::with_capacity(n_layers);
        let mut max_channels = FEATURE_DIM.max(hidden_dim as usize);
        for i in 0..n_layers {
            let off = TGNN_HEADER_BYTES + i * TGNN_LAYER_DESC_BYTES;
            let desc = LayerDesc {
                op_kind: bytes[off],
                act_kind: bytes[off + 1],
                res_mode: bytes[off + 2],
                kernel: bytes[off + 3],
                dilation: read_u16_le(bytes, off + 4),
                c_in: read_u16_le(bytes, off + 6),
                c_out: read_u16_le(bytes, off + 8),
                param_idx: read_u16_le(bytes, off + 10),
                weight_off: read_u32_le(bytes, off + 12),
            };
            let w_needed = match desc.op_kind {
                0 => (desc.c_in as usize) * (desc.c_out as usize),
                1 => {
                    if desc.c_in != desc.c_out || desc.kernel == 0 || desc.kernel % 2 == 0 {
                        return Err(TgnnError::InvalidLayerDesc(i));
                    }
                    (desc.kernel as usize) * (desc.c_out as usize)
                }
                _ => return Err(TgnnError::InvalidLayerDesc(i)),
            };
            if (desc.param_idx as usize) + (desc.c_out as usize) > n_channels
                || (desc.weight_off as usize) + w_needed > n_weights
            {
                return Err(TgnnError::InvalidLayerDesc(i));
            }
            max_channels = max_channels.max(desc.c_in as usize).max(desc.c_out as usize);
            layers.push(desc);
        }

        if layers.first().map(|l| l.c_in as usize) != Some(FEATURE_DIM)
            || layers.last().map(|l| l.c_out as usize) != Some(MICROSEG_OUT_DIM)
        {
            return Err(TgnnError::InvalidDimensions);
        }

        let mut scales = Vec::with_capacity(n_channels);
        let mut biases = Vec::with_capacity(n_channels);
        for i in 0..n_channels {
            scales.push(read_f32_le(bytes, scales_off + i * 4));
            biases.push(read_f32_le(bytes, biases_off + i * 4));
        }

        let weights: Vec<i8> = bytes[weights_off..weights_off + n_weights]
            .iter()
            .map(|&b| b as i8)
            .collect();

        Ok(Self {
            header,
            layers,
            scales,
            biases,
            weights,
            max_channels,
        })
    }

    /// Run forward pass directly on pre-extracted `[t_len, 32]` features and return raw `[t_len, 12]` logits.
    pub fn forward_features(&self, feat: &[f32], t_len: usize) -> Vec<f32> {
        if t_len == 0 {
            return Vec::new();
        }
        debug_assert_eq!(feat.len(), t_len * FEATURE_DIM);

        let arena_len = t_len * self.max_channels;
        let mut buf_a = vec![0.0f32; arena_len];
        let mut buf_b = vec![0.0f32; arena_len];
        let mut res_buf = vec![0.0f32; t_len * (self.header.hidden_dim as usize)];

        buf_a[..feat.len()].copy_from_slice(feat);
        let mut a_is_input = true;

        for desc in &self.layers {
            let c_in = desc.c_in as usize;
            let c_out = desc.c_out as usize;
            let p_idx = desc.param_idx as usize;
            let w_off = desc.weight_off as usize;

            let scales = &self.scales[p_idx..p_idx + c_out];
            let biases = &self.biases[p_idx..p_idx + c_out];

            let (inp, out) = if a_is_input {
                (&buf_a[..t_len * c_in], &mut buf_b[..t_len * c_out])
            } else {
                (&buf_b[..t_len * c_in], &mut buf_a[..t_len * c_out])
            };

            if desc.res_mode == 1 {
                res_buf[..t_len * c_in].copy_from_slice(inp);
            }

            match desc.op_kind {
                0 => {
                    let w_slice = &self.weights[w_off..w_off + c_in * c_out];
                    run_pointwise_1d(inp, out, t_len, c_in, c_out, w_slice, scales, biases, desc.act_kind);
                }
                1 => {
                    let k = desc.kernel as usize;
                    let d = desc.dilation as usize;
                    let w_slice = &self.weights[w_off..w_off + k * c_out];
                    run_depthwise_1d(inp, out, t_len, c_out, k, d, w_slice, scales, biases, desc.act_kind);
                }
                _ => unreachable!(),
            }

            if desc.res_mode == 2 {
                let n_el = t_len * c_out;
                for i in 0..n_el {
                    out[i] += res_buf[i];
                }
            }

            a_is_input = !a_is_input;
        }

        let final_buf = if a_is_input { &buf_a } else { &buf_b };
        final_buf[..t_len * MICROSEG_OUT_DIM].to_vec()
    }

    /// Extract features from arbitrary sample-rate PCM and run forward inference to obtain posteriors.
    pub fn forward_pcm(&self, samples: &[f32], sample_rate: u32) -> (AcousticFeatures, MicroSegPosteriors) {
        let feats = extract_features(samples, sample_rate);
        let logits = self.forward_features(&feats.data, feats.num_frames);
        let post = decode_logits(logits, feats.num_frames);
        (feats, post)
    }
}

#[inline(always)]
fn apply_act(v: f32, act_kind: u8) -> f32 {
    match act_kind {
        1 => v.clamp(0.0, 6.0), // ReLU6
        _ => v,
    }
}

#[inline(always)]
fn sigmoid_f32(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

pub fn decode_logits(logits: Vec<f32>, num_frames: usize) -> MicroSegPosteriors {
    let mut manner_probs = vec![0.0f32; num_frames * 8];
    let mut phone_bnd_5ms = vec![0.0f32; num_frames * 2];
    let mut syl_bnd_10ms = vec![0.0f32; num_frames];
    let mut vad_speech_10ms = vec![0.0f32; num_frames];

    for t in 0..num_frames {
        let row = &logits[t * MICROSEG_OUT_DIM..(t + 1) * MICROSEG_OUT_DIM];
        let mut max_v = f32::NEG_INFINITY;
        for &v in &row[0..8] {
            if v > max_v {
                max_v = v;
            }
        }
        let mut sum_exp = 0.0f32;
        let m_out = &mut manner_probs[t * 8..(t + 1) * 8];
        for c in 0..8 {
            let e = (row[c] - max_v).exp();
            m_out[c] = e;
            sum_exp += e;
        }
        let inv = 1.0 / sum_exp.max(1e-12);
        for v in m_out.iter_mut() {
            *v *= inv;
        }

        phone_bnd_5ms[t * 2] = sigmoid_f32(row[8]);
        phone_bnd_5ms[t * 2 + 1] = sigmoid_f32(row[9]);
        syl_bnd_10ms[t] = sigmoid_f32(row[10]);
        vad_speech_10ms[t] = sigmoid_f32(row[11]);
    }

    MicroSegPosteriors {
        num_frames,
        logits,
        manner_probs,
        phone_bnd_5ms,
        syl_bnd_10ms,
        vad_speech_10ms,
    }
}

/// Pointwise Conv1d: input [T, c_in], weights [c_out, c_in] (i8), output [T, c_out].
/// Uses f64 dot-product accumulation so Rust scalar/SIMD and Python BLAS match within < 1e-6.
pub fn run_pointwise_1d(
    inp: &[f32],
    out: &mut [f32],
    t_len: usize,
    c_in: usize,
    c_out: usize,
    w_i8: &[i8],
    scales: &[f32],
    biases: &[f32],
    act_kind: u8,
) {
    for t in 0..t_len {
        let x = &inp[t * c_in..(t + 1) * c_in];
        let y = &mut out[t * c_out..(t + 1) * c_out];
        for o in 0..c_out {
            let w_row = &w_i8[o * c_in..(o + 1) * c_in];
            let mut acc = 0.0f64;
            for i in 0..c_in {
                acc += (x[i] as f64) * (w_row[i] as f64);
            }
            let val = (acc * (scales[o] as f64) + (biases[o] as f64)) as f32;
            y[o] = apply_act(val, act_kind);
        }
    }
}

/// Depthwise Conv1d with replicate boundary padding: weights [K, C] (i8), channel-contiguous.
pub fn run_depthwise_1d(
    inp: &[f32],
    out: &mut [f32],
    t_len: usize,
    c: usize,
    kernel: usize,
    dilation: usize,
    w_i8: &[i8],
    scales: &[f32],
    biases: &[f32],
    act_kind: u8,
) {
    let half = (kernel / 2) * dilation;
    let last_t = (t_len - 1) as isize;
    let mut acc_row = vec![0.0f64; c];
    for t in 0..t_len {
        acc_row.fill(0.0);
        for k in 0..kernel {
            let src_t = ((t as isize) + ((k * dilation) as isize) - (half as isize))
                .clamp(0, last_t) as usize;
            let x = &inp[src_t * c..(src_t + 1) * c];
            let w_tap = &w_i8[k * c..(k + 1) * c];
            for ch in 0..c {
                acc_row[ch] += (x[ch] as f64) * (w_tap[ch] as f64);
            }
        }
        let y = &mut out[t * c..(t + 1) * c];
        for ch in 0..c {
            let val = (acc_row[ch] * (scales[ch] as f64) + (biases[ch] as f64)) as f32;
            y[ch] = apply_act(val, act_kind);
        }
    }
}
