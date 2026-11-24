use crate::DspError;

#[derive(Debug, Clone)]
pub struct DecodedWav {
    pub sample_rate: u32,
    pub channels: u16,
    pub mono: Vec<f32>,
}

/// Pure-Rust WAV decoder supporting PCM 8/16/24/32-bit and IEEE float 32/64-bit (including WAVE_FORMAT_EXTENSIBLE),
/// downmixing multi-channel audio cleanly to mono `Vec<f32>`.
pub fn decode_wav_bytes(bytes: &[u8]) -> Result<DecodedWav, DspError> {
    if bytes.len() < 44 {
        return Err(DspError::InvalidAudio("WAV file too short".into()));
    }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(DspError::InvalidAudio("Missing RIFF/WAVE header".into()));
    }

    let mut pos = 12usize;
    let mut audio_format: Option<u16> = None;
    let mut num_channels: u16 = 0;
    let mut sample_rate: u32 = 0;
    let mut bits_per_sample: u16 = 0;
    let mut data_slice: Option<&[u8]> = None;

    while pos + 8 <= bytes.len() {
        let chunk_id = &bytes[pos..pos + 4];
        let chunk_size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        pos += 8;
        let avail = bytes.len().saturating_sub(pos);
        let actual_size = chunk_size.min(avail);
        let chunk_data = &bytes[pos..pos + actual_size];

        if chunk_id == b"fmt " {
            if chunk_data.len() < 16 {
                return Err(DspError::InvalidAudio("Truncated fmt chunk".into()));
            }
            let mut fmt = u16::from_le_bytes([chunk_data[0], chunk_data[1]]);
            num_channels = u16::from_le_bytes([chunk_data[2], chunk_data[3]]);
            sample_rate = u32::from_le_bytes([
                chunk_data[4],
                chunk_data[5],
                chunk_data[6],
                chunk_data[7],
            ]);
            bits_per_sample = u16::from_le_bytes([chunk_data[14], chunk_data[15]]);
            if fmt == 0xFFFE && chunk_data.len() >= 26 {
                // WAVE_FORMAT_EXTENSIBLE: subformat GUID starts at offset 24
                fmt = u16::from_le_bytes([chunk_data[24], chunk_data[25]]);
            }
            audio_format = Some(fmt);
        } else if chunk_id == b"data" {
            data_slice = Some(chunk_data);
        }

        // Chunks are word-aligned (padded to even byte boundary)
        let advance = chunk_size + (chunk_size & 1);
        pos = pos.saturating_add(advance);
        if data_slice.is_some() && audio_format.is_some() {
            break;
        }
    }

    let fmt = audio_format.ok_or_else(|| DspError::InvalidAudio("Missing fmt chunk".into()))?;
    let data = data_slice.ok_or_else(|| DspError::InvalidAudio("Missing data chunk".into()))?;
    if num_channels == 0 || sample_rate == 0 {
        return Err(DspError::InvalidAudio(
            "Invalid WAV channels or sample_rate".into(),
        ));
    }

    let bytes_per_sample = (bits_per_sample / 8) as usize;
    if bytes_per_sample == 0 {
        return Err(DspError::InvalidAudio("Invalid bits_per_sample".into()));
    }
    let ch = num_channels as usize;
    let frame_stride = bytes_per_sample * ch;
    let frame_count = data.len() / frame_stride;
    let mut mono = Vec::with_capacity(frame_count);
    let inv_ch = 1.0_f32 / (ch as f32);

    match (fmt, bits_per_sample) {
        (1, 8) => {
            for f in 0..frame_count {
                let mut sum = 0.0_f32;
                let base = f * frame_stride;
                for c in 0..ch {
                    sum += (data[base + c] as f32 - 128.0) / 128.0;
                }
                mono.push(sum * inv_ch);
            }
        }
        (1, 16) => {
            for f in 0..frame_count {
                let mut sum = 0.0_f32;
                let base = f * frame_stride;
                for c in 0..ch {
                    let o = base + c * 2;
                    let s = i16::from_le_bytes([data[o], data[o + 1]]);
                    sum += s as f32 / 32768.0;
                }
                mono.push(sum * inv_ch);
            }
        }
        (1, 24) => {
            for f in 0..frame_count {
                let mut sum = 0.0_f32;
                let base = f * frame_stride;
                for c in 0..ch {
                    let o = base + c * 3;
                    let b0 = data[o] as i32;
                    let b1 = (data[o + 1] as i32) << 8;
                    let b2 = (data[o + 2] as i32) << 16;
                    let raw = b0 | b1 | b2;
                    let signed = if (raw & 0x0080_0000) != 0 {
                        raw | !0x00FF_FFFF
                    } else {
                        raw
                    };
                    sum += signed as f32 / 8_388_608.0;
                }
                mono.push(sum * inv_ch);
            }
        }
        (1, 32) => {
            for f in 0..frame_count {
                let mut sum = 0.0_f32;
                let base = f * frame_stride;
                for c in 0..ch {
                    let o = base + c * 4;
                    let s = i32::from_le_bytes([data[o], data[o + 1], data[o + 2], data[o + 3]]);
                    sum += (s as f64 / 2_147_483_648.0) as f32;
                }
                mono.push(sum * inv_ch);
            }
        }
        (3, 32) => {
            for f in 0..frame_count {
                let mut sum = 0.0_f32;
                let base = f * frame_stride;
                for c in 0..ch {
                    let o = base + c * 4;
                    let s = f32::from_le_bytes([data[o], data[o + 1], data[o + 2], data[o + 3]]);
                    sum += if s.is_finite() { s } else { 0.0 };
                }
                mono.push(sum * inv_ch);
            }
        }
        (3, 64) => {
            for f in 0..frame_count {
                let mut sum = 0.0_f32;
                let base = f * frame_stride;
                for c in 0..ch {
                    let o = base + c * 8;
                    let mut arr = [0u8; 8];
                    arr.copy_from_slice(&data[o..o + 8]);
                    let s = f64::from_le_bytes(arr) as f32;
                    sum += if s.is_finite() { s } else { 0.0 };
                }
                mono.push(sum * inv_ch);
            }
        }
        _ => {
            return Err(DspError::InvalidAudio(format!(
                "Unsupported WAV format={fmt} bits_per_sample={bits_per_sample}"
            )));
        }
    }

    Ok(DecodedWav {
        sample_rate,
        channels: num_channels,
        mono,
    })
}
