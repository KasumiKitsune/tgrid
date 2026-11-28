use tg_core::acoustic_split::{AcousticSplitInput, AcousticSplitParams};
use tg_core::model::{
    CollectionFormat, CollectionItem, ContourBox, LinearSeg, SliceOptions, TextGrid,
    TextGridFormat, ZipEntryInput,
};
use wasm_bindgen::prelude::*;

fn to_js_err(e: impl ToString) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[wasm_bindgen]
pub fn engine_info_json() -> String {
    serde_json::to_string(&tg_core::engine_info("wasm")).unwrap_or_else(|_| "{}".to_string())
}

#[wasm_bindgen]
pub fn parse_praat_to_json(bytes: &[u8], filename: &str) -> Result<String, JsValue> {
    let doc = tg_core::parse_praat_bytes(bytes, filename).map_err(to_js_err)?;
    serde_json::to_string(&doc).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn parse_textgrid_to_json(bytes: &[u8]) -> Result<String, JsValue> {
    let tg = tg_core::parse_textgrid_bytes(bytes).map_err(to_js_err)?;
    serde_json::to_string(&tg).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn serialize_textgrid_from_json(tg_json: &str, format: &str) -> Result<Vec<u8>, JsValue> {
    let tg: TextGrid = serde_json::from_str(tg_json).map_err(to_js_err)?;
    let fmt = match format {
        "shortText" => TextGridFormat::ShortText,
        "binary" => TextGridFormat::Binary,
        "chronological" => TextGridFormat::Chronological,
        _ => TextGridFormat::LongText,
    };
    tg_core::serialize_textgrid(&tg, fmt).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn serialize_collection_from_json(items_json: &str, format: &str) -> Result<Vec<u8>, JsValue> {
    let items: Vec<CollectionItem> = serde_json::from_str(items_json).map_err(to_js_err)?;
    let fmt = match format {
        "binary" => CollectionFormat::Binary,
        _ => CollectionFormat::LongText,
    };
    tg_core::serialize_collection(&items, fmt).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn slice_textgrid_json(tg_json: &str, opts_json: &str) -> Result<String, JsValue> {
    let tg: TextGrid = serde_json::from_str(tg_json).map_err(to_js_err)?;
    let opts: SliceOptions = serde_json::from_str(opts_json).map_err(to_js_err)?;
    let sliced = tg_core::slice_textgrid(&tg, &opts);
    serde_json::to_string(&sliced).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn scan_diagnostics_json(tg_json: &str) -> Result<String, JsValue> {
    let tg: TextGrid = serde_json::from_str(tg_json).map_err(to_js_err)?;
    let diags = tg_core::scan_diagnostics(&tg);
    serde_json::to_string(&diags).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn build_zip_store_packed(
    names_json: &str,
    lengths: &[u32],
    flat_data: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let names: Vec<String> = serde_json::from_str(names_json).map_err(to_js_err)?;
    if names.len() != lengths.len() {
        return Err(to_js_err("names and lengths count mismatch"));
    }
    let mut entries = Vec::with_capacity(names.len());
    let mut offset = 0usize;
    for (name, &len) in names.into_iter().zip(lengths.iter()) {
        let l = len as usize;
        let end = offset
            .checked_add(l)
            .ok_or_else(|| to_js_err("ZIP entry length overflow"))?;
        if end > flat_data.len() {
            return Err(to_js_err("ZIP flat_data truncated"));
        }
        entries.push(ZipEntryInput {
            name,
            data: flat_data[offset..end].to_vec(),
        });
        offset = end;
    }
    Ok(tg_core::build_zip_store(&entries))
}

#[wasm_bindgen]
pub fn decode_praat_trigraphs_json(input: &str) -> Result<String, JsValue> {
    serde_json::to_string(&tg_core::decode_praat_trigraphs(input)).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn encode_praat_trigraphs_json(input: &str) -> Result<String, JsValue> {
    serde_json::to_string(&tg_core::encode_praat_trigraphs(input)).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn has_praat_trigraphs(input: &str) -> bool {
    tg_core::has_praat_trigraphs(input)
}

#[wasm_bindgen]
pub fn get_yunlong_candidates_json(buffer: &str) -> Result<String, JsValue> {
    serde_json::to_string(&tg_core::get_yunlong_candidates(buffer)).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn step_yunlong_char_json(buffer: &str, ch: &str) -> Result<String, JsValue> {
    let c = ch
        .chars()
        .next()
        .ok_or_else(|| to_js_err("Empty character"))?;
    serde_json::to_string(&tg_core::step_yunlong_char(buffer, c)).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn get_praat_matches_json(first_char: &str) -> Result<String, JsValue> {
    let fc = first_char.chars().next();
    serde_json::to_string(&tg_core::get_praat_matches(fc)).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn lookup_ipa_symbol_json(sym: &str) -> Result<String, JsValue> {
    serde_json::to_string(&tg_core::lookup_ipa_symbol(sym)).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn summarize_audio_json(samples: &[f32], sample_rate: u32) -> Result<String, JsValue> {
    let summary = tg_dsp::summarize_pcm_f32(samples, sample_rate).map_err(to_js_err)?;
    serde_json::to_string(&summary).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn load_pcm_session_json(
    samples: &[f32],
    sample_rate: u32,
    offset: f64,
) -> Result<String, JsValue> {
    let summary =
        tg_dsp::load_pcm_session(samples.to_vec(), sample_rate, offset).map_err(to_js_err)?;
    serde_json::to_string(&summary).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn load_wav_session_json(bytes: &[u8], offset: f64) -> Result<String, JsValue> {
    let summary = tg_dsp::load_wav_session(bytes, offset).map_err(to_js_err)?;
    serde_json::to_string(&summary).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn remove_audio_session(session_id: u32) -> bool {
    tg_dsp::remove_audio_session(session_id)
}

#[wasm_bindgen]
pub fn clear_audio_session() {
    tg_dsp::clear_audio_session();
}

/// Returns packed bytes: `[u32 width BE][u32 height BE][rgba...]`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn render_spectrogram_rgba_packed(
    session_id: u32,
    segs_json: &str,
    band_origin_x: f64,
    band_content_w: f64,
    spec_h: f64,
    max_freq: f64,
    scale: f64,
    dyn_range: f64,
    palette_key: &str,
) -> Result<Vec<u8>, JsValue> {
    let segs: Vec<LinearSeg> = serde_json::from_str(segs_json).map_err(to_js_err)?;
    let out = tg_dsp::session_render_spectrogram_rgba(
        session_id,
        &segs,
        band_origin_x,
        band_content_w,
        spec_h,
        max_freq,
        scale,
        dyn_range,
        palette_key,
    )
    .map_err(to_js_err)?;

    let mut packed = Vec::with_capacity(8 + out.rgba.len());
    packed.extend_from_slice(&out.width.to_be_bytes());
    packed.extend_from_slice(&out.height.to_be_bytes());
    packed.extend_from_slice(&out.rgba);
    Ok(packed)
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn compute_band_contours_json(
    session_id: u32,
    segs_json: &str,
    band_origin_x: f64,
    band_content_w: f64,
    max_freq: f64,
    cols: usize,
    rows: usize,
    dyn_range: f64,
    smooth: bool,
    box_json: &str,
    levels: usize,
    palette_key: &str,
) -> Result<String, JsValue> {
    let segs: Vec<LinearSeg> = serde_json::from_str(segs_json).map_err(to_js_err)?;
    let box_rect: ContourBox = serde_json::from_str(box_json).map_err(to_js_err)?;
    let contours = tg_dsp::session_compute_contours(
        session_id,
        &segs,
        band_origin_x,
        band_content_w,
        max_freq,
        cols,
        rows,
        dyn_range,
        smooth,
        box_rect,
        levels,
        palette_key,
    )
    .map_err(to_js_err)?;
    serde_json::to_string(&contours).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn compute_waveform_path(
    session_id: u32,
    segs_json: &str,
    y: f64,
    h: f64,
) -> Result<String, JsValue> {
    let segs: Vec<LinearSeg> = serde_json::from_str(segs_json).map_err(to_js_err)?;
    tg_dsp::session_waveform_path(session_id, &segs, y, h).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn find_zero_crossing(
    session_id: u32,
    t: f64,
    max_window_sec: f64,
) -> Result<f64, JsValue> {
    tg_dsp::session_zero_crossing(session_id, t, max_window_sec).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn align_split_boundaries_json(samples: &[f32], params_json: &str) -> Result<String, JsValue> {
    let params: AcousticSplitParams = serde_json::from_str(params_json).map_err(to_js_err)?;
    let input = AcousticSplitInput {
        samples,
        sample_rate: params.sample_rate,
        samples_origin_sec: params.samples_origin_sec,
        xmin: params.xmin,
        xmax: params.xmax,
        granularity: params.granularity,
        duration_weights: &params.duration_weights,
        acoustic_classes: &params.acoustic_classes,
        f0_frames: params.f0_frames.as_deref(),
    };
    let use_nn = params.use_nn.unwrap_or(true);
    let out = if use_nn {
        tg_core::nn::align_split_boundaries_hybrid(&input, tg_core::nn::builtin_acouseg_net())
    } else {
        tg_core::align_split_boundaries(&input)
    };
    serde_json::to_string(&out).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn detect_speech_segments_nn_json(
    samples: &[f32],
    sample_rate: u32,
    params_json: &str,
) -> Result<String, JsValue> {
    let params: tg_core::nn::VadParams = if params_json.trim().is_empty() {
        tg_core::nn::VadParams::default()
    } else {
        serde_json::from_str(params_json).map_err(to_js_err)?
    };
    let segs = tg_core::nn::detect_speech_segments_nn(
        samples,
        sample_rate,
        &params,
        tg_core::nn::builtin_acouseg_net(),
    );
    serde_json::to_string(&segs).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn extract_acoustic_snap_peaks_json(
    samples: &[f32],
    sample_rate: u32,
    samples_origin_sec: f64,
    xmin: f64,
    xmax: f64,
) -> Result<String, JsValue> {
    let peaks = tg_core::nn::extract_acoustic_snap_peaks(
        samples,
        sample_rate,
        samples_origin_sec,
        xmin,
        xmax,
    );
    serde_json::to_string(&peaks).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn snap_acoustic_boundary_json(
    samples: &[f32],
    sample_rate: u32,
    samples_origin_sec: f64,
    target_time_sec: f64,
    window_sec: f64,
) -> Result<String, JsValue> {
    let res = tg_core::nn::snap_boundary_to_acoustic_edge(
        samples,
        sample_rate,
        samples_origin_sec,
        target_time_sec,
        window_sec,
    );
    serde_json::to_string(&res).map_err(to_js_err)
}
