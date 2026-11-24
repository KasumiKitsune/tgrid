use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TierKind {
    IntervalTier,
    TextTier,
}

impl TierKind {
    pub fn praat_class_name(self) -> &'static str {
        match self {
            TierKind::IntervalTier => "IntervalTier",
            TierKind::TextTier => "TextTier",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextGridFormat {
    LongText,
    ShortText,
    Binary,
    Chronological,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CollectionFormat {
    LongText,
    Binary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interval {
    pub xmin: f64,
    pub xmax: f64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPoint {
    pub number: f64,
    pub mark: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tier {
    pub kind: TierKind,
    pub name: String,
    pub xmin: f64,
    pub xmax: f64,
    #[serde(default)]
    pub intervals: Vec<Interval>,
    #[serde(default)]
    pub points: Vec<TextPoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_num: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextGrid {
    #[serde(default)]
    pub name: String,
    pub xmin: f64,
    pub xmax: f64,
    pub tiers: Vec<Tier>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundObject {
    #[serde(default)]
    pub name: String,
    pub xmin: f64,
    pub xmax: f64,
    pub nx: usize,
    pub dx: f64,
    pub x1: f64,
    pub ny: usize,
    pub channels: Vec<Vec<f32>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CollectionItem {
    TextGrid(TextGrid),
    Sound(SoundObject),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDocument {
    pub source_format: String,
    pub items: Vec<CollectionItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub name: String,
    pub version: String,
    pub backend: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceOptions {
    pub tier_indices: Option<Vec<usize>>,
    pub t_min: Option<f64>,
    pub t_max: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TierDiagnostics {
    pub tier_index: usize,
    pub gap_count: usize,
    pub overlap_count: usize,
    pub zero_duration_count: usize,
    pub micro_segment_count: usize,
    pub out_of_domain: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipEntryInput {
    pub name: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContourBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContourPath {
    pub level: usize,
    pub threshold: f64,
    pub fill: String,
    pub d: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearSeg {
    pub x0: f64,
    pub x1: f64,
    pub t0: f64,
    pub t1: f64,
    #[serde(default)]
    pub collapsed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpaCandidate {
    pub text: String,
    pub code: String,
    pub suffix: String,
    pub synthetic: bool,
    pub exact: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YunlongStepResult {
    pub action: String,
    pub commit: String,
    pub recent: Vec<String>,
    pub buffer: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PraatMatch {
    pub code: String,
    pub ch: String,
    pub cp: u32,
    pub al: u8,
    pub is_combining: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpaConvertResult {
    pub text: String,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpaSymbolInfo {
    pub sym: String,
    pub display: String,
    pub name: String,
    pub yunlong: Vec<String>,
    pub praat: String,
    pub unicode: String,
    pub is_combining: bool,
}
