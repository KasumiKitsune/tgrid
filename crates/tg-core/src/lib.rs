pub mod acoustic_split;
pub mod codec;
pub mod contour;
pub mod ipa;
mod ipa_data;
pub mod model;
pub mod ops;
pub mod zip;

use model::{
    CollectionFormat, CollectionItem, ContourBox, ContourPath, EngineInfo, IpaCandidate,
    IpaConvertResult, IpaSymbolInfo, ParsedDocument, PraatMatch, SliceOptions, TextGrid,
    TextGridFormat, TierDiagnostics, YunlongStepResult, ZipEntryInput,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("Parse error: {0}")]
    Parse(String),
    #[error("Serialization error: {0}")]
    Serialize(String),
    #[error("Invalid argument: {0}")]
    InvalidArgument(String),
}

pub fn engine_info(backend: &str) -> EngineInfo {
    EngineInfo {
        name: "TextGrid Editor Core".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        backend: backend.to_string(),
    }
}

pub fn parse_praat_bytes(bytes: &[u8], filename: &str) -> Result<ParsedDocument, CoreError> {
    codec::parse_praat_bytes(bytes, filename)
}

pub fn parse_textgrid_bytes(bytes: &[u8]) -> Result<TextGrid, CoreError> {
    codec::parse_textgrid_bytes(bytes)
}

pub fn serialize_textgrid(tg: &TextGrid, format: TextGridFormat) -> Result<Vec<u8>, CoreError> {
    codec::serialize_textgrid(tg, format)
}

pub fn serialize_collection(
    items: &[CollectionItem],
    format: CollectionFormat,
) -> Result<Vec<u8>, CoreError> {
    codec::serialize_collection(items, format)
}

pub fn slice_textgrid(tg: &TextGrid, opts: &SliceOptions) -> TextGrid {
    ops::slice_textgrid(tg, opts)
}

pub fn scan_diagnostics(tg: &TextGrid) -> Vec<TierDiagnostics> {
    ops::scan_diagnostics(tg)
}

pub fn generate_spectrogram_contours(
    grid: &[f32],
    cols: usize,
    rows: usize,
    box_rect: ContourBox,
    levels: usize,
    palette_key: &str,
) -> Vec<ContourPath> {
    contour::generate_spectrogram_contours(grid, cols, rows, box_rect, levels, palette_key)
}

pub fn build_zip_store(entries: &[ZipEntryInput]) -> Vec<u8> {
    zip::build_zip_store(entries)
}

pub fn decode_praat_trigraphs(input: &str) -> IpaConvertResult {
    ipa::ipa_engine().decode_praat_trigraphs(input)
}

pub fn encode_praat_trigraphs(input: &str) -> IpaConvertResult {
    ipa::ipa_engine().encode_praat_trigraphs(input)
}

pub fn has_praat_trigraphs(input: &str) -> bool {
    ipa::ipa_engine().has_praat_trigraphs(input)
}

pub fn get_yunlong_candidates(buffer: &str) -> Vec<IpaCandidate> {
    ipa::ipa_engine().get_yunlong_candidates(buffer)
}

pub fn step_yunlong_char(buffer: &str, ch: char) -> YunlongStepResult {
    ipa::ipa_engine().step_yunlong_char(buffer, ch)
}

pub fn get_praat_matches(first_char: Option<char>) -> Vec<PraatMatch> {
    ipa::ipa_engine().get_praat_matches(first_char)
}

pub fn lookup_ipa_symbol(sym: &str) -> IpaSymbolInfo {
    ipa::ipa_engine().lookup_symbol(sym)
}

pub fn align_split_boundaries(
    input: &acoustic_split::AcousticSplitInput<'_>,
) -> acoustic_split::AcousticSplitOutput {
    acoustic_split::align_split_boundaries(input)
}
