pub mod features;
pub mod hybrid;
pub mod tgnn;

use std::sync::OnceLock;

pub use features::{extract_features, resample_to_16k, AcousticFeatures, FEATURE_DIM};
pub use hybrid::{
    align_split_boundaries_hybrid, detect_speech_segments_dsp, detect_speech_segments_nn,
    extract_acoustic_snap_peaks, extract_acoustic_snap_peaks_with_model,
    snap_boundary_to_acoustic_edge, snap_boundary_to_acoustic_edge_with_model, AcousticSnapKind,
    AcousticSnapPeak, AcousticSnapResult, VadParams, VadSegment,
};
pub use tgnn::{
    crc32_ieee, decode_logits, MicroSegNet, MicroSegPosteriors, TgnnError, TgnnHeader,
    TGNN_TOTAL_BYTES,
};

/// Embedded `TGrid-AcouSeg 1.0` int8 quantized acoustic boundary model weights.
pub const BUILTIN_ACOUSEG_BYTES: &[u8] = include_bytes!("weights/tgrid-acouseg-1.0.tgnn");

static BUILTIN_ACOUSEG_NET: OnceLock<MicroSegNet> = OnceLock::new();

/// Global zero-overhead read-only singleton for the built-in `TGrid-AcouSeg 1.0` model.
pub fn builtin_acouseg_net() -> &'static MicroSegNet {
    BUILTIN_ACOUSEG_NET.get_or_init(|| {
        MicroSegNet::from_bytes(BUILTIN_ACOUSEG_BYTES)
            .expect("built-in TGrid-AcouSeg 1.0 weights must be valid .tgnn")
    })
}
