use tg_core::acoustic_split::{AcousticSplitInput, AcousticSplitOutput, AcousticSplitParams};
use tg_core::model::{
    CollectionFormat, CollectionItem, ContourBox, ContourPath, EngineInfo, IpaCandidate,
    IpaConvertResult, IpaSymbolInfo, LinearSeg, ParsedDocument, PraatMatch, SliceOptions, TextGrid,
    TextGridFormat, TierDiagnostics, YunlongStepResult, ZipEntryInput,
};
use tg_dsp::{AudioAnalysisSummary, AudioSummary};

#[tauri::command]
fn engine_info() -> EngineInfo {
    tg_core::engine_info("tauri-native")
}

#[tauri::command]
fn parse_praat_bytes(bytes: Vec<u8>, filename: String) -> Result<ParsedDocument, String> {
    tg_core::parse_praat_bytes(&bytes, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
fn parse_textgrid_bytes(bytes: Vec<u8>) -> Result<TextGrid, String> {
    tg_core::parse_textgrid_bytes(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn serialize_textgrid(tg: TextGrid, format: TextGridFormat) -> Result<Vec<u8>, String> {
    tg_core::serialize_textgrid(&tg, format).map_err(|e| e.to_string())
}

#[tauri::command]
fn serialize_collection(
    items: Vec<CollectionItem>,
    format: CollectionFormat,
) -> Result<Vec<u8>, String> {
    tg_core::serialize_collection(&items, format).map_err(|e| e.to_string())
}

#[tauri::command]
fn slice_textgrid(tg: TextGrid, opts: SliceOptions) -> TextGrid {
    tg_core::slice_textgrid(&tg, &opts)
}

#[tauri::command]
fn scan_diagnostics(tg: TextGrid) -> Vec<TierDiagnostics> {
    tg_core::scan_diagnostics(&tg)
}

#[tauri::command]
fn build_zip_store(entries: Vec<ZipEntryInput>) -> Vec<u8> {
    tg_core::build_zip_store(&entries)
}

#[tauri::command]
fn decode_praat_trigraphs(input: String) -> IpaConvertResult {
    tg_core::decode_praat_trigraphs(&input)
}

#[tauri::command]
fn encode_praat_trigraphs(input: String) -> IpaConvertResult {
    tg_core::encode_praat_trigraphs(&input)
}

#[tauri::command]
fn has_praat_trigraphs(input: String) -> bool {
    tg_core::has_praat_trigraphs(&input)
}

#[tauri::command]
fn get_yunlong_candidates(buffer: String) -> Vec<IpaCandidate> {
    tg_core::get_yunlong_candidates(&buffer)
}

#[tauri::command]
fn step_yunlong_char(buffer: String, ch: String) -> Result<YunlongStepResult, String> {
    let c = ch.chars().next().ok_or_else(|| "Empty character".to_string())?;
    Ok(tg_core::step_yunlong_char(&buffer, c))
}

#[tauri::command]
fn get_praat_matches(first_char: Option<String>) -> Vec<PraatMatch> {
    let fc = first_char.and_then(|s| s.chars().next());
    tg_core::get_praat_matches(fc)
}

#[tauri::command]
fn lookup_ipa_symbol(sym: String) -> IpaSymbolInfo {
    tg_core::lookup_ipa_symbol(&sym)
}

#[tauri::command]
fn summarize_audio(samples: Vec<f32>, sample_rate: u32) -> Result<AudioSummary, String> {
    tg_dsp::summarize_pcm_f32(&samples, sample_rate).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_pcm_session(
    samples: Vec<f32>,
    sample_rate: u32,
    offset: f64,
) -> Result<AudioAnalysisSummary, String> {
    tg_dsp::load_pcm_session(samples, sample_rate, offset).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_wav_session(bytes: Vec<u8>, offset: f64) -> Result<AudioAnalysisSummary, String> {
    tg_dsp::load_wav_session(&bytes, offset).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_wav_file_session(path: String, offset: f64) -> Result<AudioAnalysisSummary, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("无法读取音频文件 {path}: {e}"))?;
    tg_dsp::load_wav_session(&bytes, offset).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_audio_session(session_id: u32) -> bool {
    tg_dsp::remove_audio_session(session_id)
}

#[tauri::command]
fn clear_audio_session() {
    tg_dsp::clear_audio_session();
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn render_spectrogram_rgba_packed(
    session_id: u32,
    segs: Vec<LinearSeg>,
    band_origin_x: f64,
    band_content_w: f64,
    spec_h: f64,
    max_freq: f64,
    scale: f64,
    dyn_range: f64,
    palette_key: String,
) -> Result<Vec<u8>, String> {
    let out = tg_dsp::session_render_spectrogram_rgba(
        session_id,
        &segs,
        band_origin_x,
        band_content_w,
        spec_h,
        max_freq,
        scale,
        dyn_range,
        &palette_key,
    )
    .map_err(|e| e.to_string())?;
    let mut packed = Vec::with_capacity(8 + out.rgba.len());
    packed.extend_from_slice(&out.width.to_be_bytes());
    packed.extend_from_slice(&out.height.to_be_bytes());
    packed.extend_from_slice(&out.rgba);
    Ok(packed)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn compute_band_contours(
    session_id: u32,
    segs: Vec<LinearSeg>,
    band_origin_x: f64,
    band_content_w: f64,
    max_freq: f64,
    cols: usize,
    rows: usize,
    dyn_range: f64,
    smooth: bool,
    box_rect: ContourBox,
    levels: usize,
    palette_key: String,
) -> Result<Vec<ContourPath>, String> {
    tg_dsp::session_compute_contours(
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
        &palette_key,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn compute_waveform_path(
    session_id: u32,
    segs: Vec<LinearSeg>,
    y: f64,
    h: f64,
) -> Result<String, String> {
    tg_dsp::session_waveform_path(session_id, &segs, y, h).map_err(|e| e.to_string())
}

#[tauri::command]
fn find_zero_crossing(
    session_id: u32,
    t: f64,
    max_window_sec: f64,
) -> Result<f64, String> {
    tg_dsp::session_zero_crossing(session_id, t, max_window_sec).map_err(|e| e.to_string())
}

#[tauri::command]
fn align_split_boundaries(samples: Vec<f32>, params: AcousticSplitParams) -> AcousticSplitOutput {
    let input = AcousticSplitInput {
        samples: &samples,
        sample_rate: params.sample_rate,
        samples_origin_sec: params.samples_origin_sec,
        xmin: params.xmin,
        xmax: params.xmax,
        granularity: params.granularity,
        duration_weights: &params.duration_weights,
        acoustic_classes: &params.acoustic_classes,
        f0_frames: params.f0_frames.as_deref(),
    };
    tg_core::align_split_boundaries(&input)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CorpusScannedAudioFile {
    rel_path: String,
    stem: String,
    duration: Option<f64>,
    size_bytes: u64,
    modified_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CorpusScannedFileEntry {
    rel_path: String,
    stem: String,
    size_bytes: u64,
    modified_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CorpusDirScanResult {
    dir_path: String,
    dir_name: String,
    audio_files: Vec<CorpusScannedAudioFile>,
    text_grid_files: Vec<CorpusScannedFileEntry>,
    has_project_file: bool,
    project_file_rel_path: String,
    word_list_files: Vec<String>,
}

fn probe_wav_duration_from_header(path: &std::path::Path, file_size: u64) -> Option<f64> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 4096];
    let mut read_len = 0usize;
    while read_len < buf.len() {
        match file.read(&mut buf[read_len..]) {
            Ok(0) => break,
            Ok(n) => read_len += n,
            Err(_) => return None,
        }
    }
    if read_len < 44 || &buf[0..4] != b"RIFF" || &buf[8..12] != b"WAVE" {
        return None;
    }

    let mut pos = 12usize;
    let mut eff_byte_rate: Option<f64> = None;
    let mut data_bytes: Option<f64> = None;

    while pos + 8 <= read_len {
        let chunk_id = &buf[pos..pos + 4];
        let chunk_size = u32::from_le_bytes([
            buf[pos + 4],
            buf[pos + 5],
            buf[pos + 6],
            buf[pos + 7],
        ]);
        pos += 8;

        if chunk_id == b"fmt " {
            if pos + 16 > read_len {
                break;
            }
            let num_channels = u16::from_le_bytes([buf[pos + 2], buf[pos + 3]]);
            let sample_rate = u32::from_le_bytes([
                buf[pos + 4],
                buf[pos + 5],
                buf[pos + 6],
                buf[pos + 7],
            ]);
            let byte_rate = u32::from_le_bytes([
                buf[pos + 8],
                buf[pos + 9],
                buf[pos + 10],
                buf[pos + 11],
            ]);
            let bits_per_sample = u16::from_le_bytes([buf[pos + 14], buf[pos + 15]]);

            if byte_rate > 0 {
                eff_byte_rate = Some(byte_rate as f64);
            } else if sample_rate > 0 && num_channels > 0 && bits_per_sample >= 8 {
                eff_byte_rate =
                    Some((sample_rate as f64) * (num_channels as f64) * ((bits_per_sample / 8) as f64));
            }
        } else if chunk_id == b"data" {
            let size = if chunk_size > 0 && chunk_size != u32::MAX {
                chunk_size as f64
            } else {
                file_size.saturating_sub(pos as u64) as f64
            };
            data_bytes = Some(size);
            if eff_byte_rate.is_some() {
                break;
            }
        }

        let step = (chunk_size as usize).saturating_add((chunk_size as usize) & 1);
        pos = match pos.checked_add(step) {
            Some(next) if next <= read_len => next,
            _ => break,
        };
    }

    let rate = eff_byte_rate?;
    let bytes = data_bytes?;
    if rate > 0.0 && bytes > 0.0 {
        let dur = bytes / rate;
        if dur.is_finite() && dur > 0.0 {
            return Some(dur);
        }
    }
    None
}

#[tauri::command]
fn scan_corpus_dir(dir: String) -> Result<CorpusDirScanResult, String> {
    let root = std::path::Path::new(&dir);
    if !root.is_dir() {
        return Err(format!("目录不存在或无法访问: {dir}"));
    }

    let entries =
        std::fs::read_dir(root).map_err(|e| format!("无法读取目录 {dir}: {e}"))?;

    let mut audio_files: Vec<CorpusScannedAudioFile> = Vec::new();
    let mut text_grid_files: Vec<CorpusScannedFileEntry> = Vec::new();
    let mut word_list_files: Vec<String> = Vec::new();
    let mut has_project_file = false;
    let mut project_file_rel_path = ".tgrid-project.json".to_string();

    for entry in entries.flatten() {
        let ep = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name.eq_ignore_ascii_case(".tgrid-project.json") {
            has_project_file = true;
            project_file_rel_path = file_name;
            continue;
        }
        if file_name.starts_with('.') {
            continue;
        }

        let size_bytes = meta.len();
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let ext = ep
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let stem = ep
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if stem.is_empty() {
            continue;
        }

        if ext == "wav" {
            let duration = probe_wav_duration_from_header(&ep, size_bytes);
            audio_files.push(CorpusScannedAudioFile {
                rel_path: file_name,
                stem,
                duration,
                size_bytes,
                modified_ms,
            });
        } else if matches!(
            ext.as_str(),
            "mp3" | "flac" | "ogg" | "m4a" | "aac" | "opus"
        ) {
            audio_files.push(CorpusScannedAudioFile {
                rel_path: file_name,
                stem,
                duration: None,
                size_bytes,
                modified_ms,
            });
        } else if ext == "textgrid" {
            text_grid_files.push(CorpusScannedFileEntry {
                rel_path: file_name,
                stem,
                size_bytes,
                modified_ms,
            });
        } else if matches!(ext.as_str(), "csv" | "tsv" | "xlsx") {
            word_list_files.push(file_name);
        }
    }

    audio_files.sort_by(|a, b| a.rel_path.to_lowercase().cmp(&b.rel_path.to_lowercase()));
    text_grid_files.sort_by(|a, b| a.rel_path.to_lowercase().cmp(&b.rel_path.to_lowercase()));
    word_list_files.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));

    let dir_name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| dir.clone());

    Ok(CorpusDirScanResult {
        dir_path: dir,
        dir_name,
        audio_files,
        text_grid_files,
        has_project_file,
        project_file_rel_path,
        word_list_files,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFileStat {
    exists: bool,
    size: u64,
    modified_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DroppedPathInfo {
    path: String,
    name: String,
    parent_dir: String,
    is_dir: bool,
    size: u64,
    exists: bool,
}

#[tauri::command]
fn inspect_dropped_paths(paths: Vec<String>) -> Vec<DroppedPathInfo> {
    paths
        .into_iter()
        .map(|raw_path| {
            let trimmed = raw_path.trim().to_string();
            let p = std::path::Path::new(&trimmed);
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| trimmed.clone());
            let parent_dir = p
                .parent()
                .map(|par| par.to_string_lossy().into_owned())
                .unwrap_or_default();
            match std::fs::metadata(p) {
                Ok(meta) => {
                    let is_dir = meta.is_dir();
                    DroppedPathInfo {
                        path: trimmed,
                        name,
                        parent_dir,
                        is_dir,
                        size: if is_dir { 0 } else { meta.len() },
                        exists: true,
                    }
                }
                Err(_) => DroppedPathInfo {
                    path: trimmed,
                    name,
                    parent_dir,
                    is_dir: false,
                    size: 0,
                    exists: false,
                },
            }
        })
        .collect()
}

#[tauri::command]
fn stat_local_file(path: String) -> Result<LocalFileStat, String> {
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() => {
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Ok(LocalFileStat {
                exists: true,
                size: meta.len(),
                modified_ms,
            })
        }
        Ok(_) => Ok(LocalFileStat {
            exists: false,
            size: 0,
            modified_ms: 0,
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(LocalFileStat {
            exists: false,
            size: 0,
            modified_ms: 0,
        }),
        Err(e) => Err(format!("无法获取文件状态 {path}: {e}")),
    }
}

#[tauri::command]
fn read_local_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("无法读取文件 {path}: {e}"))
}

#[tauri::command]
fn read_local_file_if_exists(path: String) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("无法读取文件 {path}: {e}")),
    }
}

#[tauri::command]
fn write_local_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &bytes).map_err(|e| format!("无法写入文件 {path}: {e}"))
}

#[tauri::command]
fn write_local_file_atomic(path: String, bytes: Vec<u8>) -> Result<(), String> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

    let target = std::path::Path::new(&path);
    let parent = target.parent().unwrap_or_else(|| std::path::Path::new("."));
    let fname = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "file".to_string());
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = parent.join(format!(".{fname}.tmp.{}.{}", std::process::id(), seq));

    {
        let mut file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("无法创建临时文件 {}: {e}", tmp_path.display()))?;
        if let Err(e) = file.write_all(&bytes).and_then(|_| file.flush()) {
            drop(file);
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("无法写入临时文件 {path}: {e}"));
        }
        let _ = file.sync_data();
    }

    let retry_delays = [15u64, 40, 90];
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..=retry_delays.len() {
        match std::fs::rename(&tmp_path, target) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if attempt < retry_delays.len() {
                    std::thread::sleep(Duration::from_millis(retry_delays[attempt]));
                }
            }
        }
    }

    let _ = std::fs::remove_file(&tmp_path);
    Err(format!(
        "无法保存文件 {path}: {}",
        last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "未知错误".to_string())
    ))
}

#[tauri::command]
fn find_companion_audio(tg_path: String) -> Option<String> {
    let p = std::path::Path::new(&tg_path);
    let parent = p.parent()?;
    let stem = p.file_stem()?.to_string_lossy().to_lowercase();
    let entries = std::fs::read_dir(parent).ok()?;
    for entry in entries.flatten() {
        let ep = entry.path();
        if !ep.is_file() {
            continue;
        }
        let ext_matches = ep
            .extension()
            .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("wav"))
            .unwrap_or(false);
        if !ext_matches {
            continue;
        }
        let stem_matches = ep
            .file_stem()
            .map(|s| s.to_string_lossy().to_lowercase() == stem)
            .unwrap_or(false);
        if stem_matches {
            return Some(ep.to_string_lossy().into_owned());
        }
    }
    None
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let normalized = path.replace('/', "\\");
        let arg = if p.is_file() {
            format!("/select,\"{}\"", normalized.replace('"', ""))
        } else {
            format!("\"{}\"", normalized.replace('"', ""))
        };
        std::process::Command::new("explorer.exe")
            .raw_arg(arg)
            .spawn()
            .map_err(|e| format!("无法打开文件夹: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(p)
            .spawn()
            .map_err(|e| format!("无法打开访达: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if p.is_dir() {
            p
        } else {
            p.parent().unwrap_or_else(|| std::path::Path::new("."))
        };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("无法打开文件夹: {e}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("当前系统不支持定位文件夹".to_string())
}

fn validate_external_url(url: &str) -> Result<&str, String> {
    let trimmed = url.trim();
    let rest = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .ok_or_else(|| "仅支持打开 http:// 或 https:// 链接".to_string())?;
    if rest.is_empty()
        || rest.starts_with('/')
        || trimmed.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("链接格式无效".to_string());
    }
    Ok(trimmed)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let clean = validate_external_url(&url)?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", clean])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("无法打开外部浏览器: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(clean)
            .spawn()
            .map_err(|e| format!("无法打开外部浏览器: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(clean)
            .spawn()
            .map_err(|e| format!("无法打开外部浏览器: {e}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("当前系统不支持打开外部链接".to_string())
}

#[tauri::command]
fn get_launch_file_arg() -> Option<String> {
    let arg = std::env::args().nth(1)?;
    if arg.starts_with('-') {
        return None;
    }
    let p = std::path::Path::new(&arg);
    if p.is_file() {
        Some(arg)
    } else {
        None
    }
}

fn normalize_clipboard_newlines(s: &str) -> String {
    if s.contains('\r') {
        s.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        s.to_string()
    }
}

#[cfg(target_os = "windows")]
mod native_clipboard {
    use std::ffi::c_void;
    use std::ptr;
    use std::thread;
    use std::time::Duration;

    const CF_UNICODETEXT: u32 = 13;
    const GMEM_MOVEABLE: u32 = 0x0002;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hwnd_new_owner: *mut c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn GetClipboardData(format: u32) -> *mut c_void;
        fn SetClipboardData(format: u32, mem: *mut c_void) -> *mut c_void;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> *mut c_void;
        fn GlobalLock(mem: *mut c_void) -> *mut c_void;
        fn GlobalUnlock(mem: *mut c_void) -> i32;
        fn GlobalFree(mem: *mut c_void) -> *mut c_void;
    }

    struct ClipboardGuard;

    impl ClipboardGuard {
        fn open() -> Result<Self, String> {
            for _ in 0..8 {
                // SAFETY: NULL associates the open clipboard with the current task.
                if unsafe { OpenClipboard(ptr::null_mut()) } != 0 {
                    return Ok(Self);
                }
                thread::sleep(Duration::from_millis(5));
            }
            Err("剪贴板正被其他程序占用，请稍后重试".to_string())
        }
    }

    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            // SAFETY: Only constructed after a successful OpenClipboard call.
            unsafe {
                CloseClipboard();
            }
        }
    }

    pub fn read_text() -> Result<String, String> {
        let _guard = ClipboardGuard::open()?;
        // SAFETY: Clipboard is open via ClipboardGuard.
        unsafe {
            if IsClipboardFormatAvailable(CF_UNICODETEXT) == 0 {
                return Ok(String::new());
            }
            let handle = GetClipboardData(CF_UNICODETEXT);
            if handle.is_null() {
                return Ok(String::new());
            }
            let ptr_u16 = GlobalLock(handle) as *const u16;
            if ptr_u16.is_null() {
                return Err("无法锁定剪贴板数据".to_string());
            }
            let mut len = 0usize;
            while *ptr_u16.add(len) != 0 {
                len += 1;
            }
            let slice = std::slice::from_raw_parts(ptr_u16, len);
            let text = String::from_utf16_lossy(slice);
            GlobalUnlock(handle);
            Ok(super::normalize_clipboard_newlines(&text))
        }
    }

    pub fn write_text(text: &str) -> Result<(), String> {
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let byte_len = wide.len() * std::mem::size_of::<u16>();

        let _guard = ClipboardGuard::open()?;
        // SAFETY: Clipboard is open via ClipboardGuard; ownership of hmem transfers to Windows on SetClipboardData success.
        unsafe {
            if EmptyClipboard() == 0 {
                return Err("清空剪贴板失败".to_string());
            }
            let hmem = GlobalAlloc(GMEM_MOVEABLE, byte_len);
            if hmem.is_null() {
                return Err("分配剪贴板内存失败".to_string());
            }
            let dst = GlobalLock(hmem) as *mut u16;
            if dst.is_null() {
                GlobalFree(hmem);
                return Err("锁定剪贴板内存失败".to_string());
            }
            ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
            GlobalUnlock(hmem);

            if SetClipboardData(CF_UNICODETEXT, hmem).is_null() {
                GlobalFree(hmem);
                return Err("写入剪贴板失败".to_string());
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod native_clipboard {
    use std::io::Write;
    use std::process::{Command, Stdio};

    pub fn read_text() -> Result<String, String> {
        let out = Command::new("pbpaste")
            .env("LANG", "en_US.UTF-8")
            .output()
            .map_err(|e| format!("读取剪贴板失败: {e}"))?;
        if !out.status.success() {
            return Err("读取剪贴板失败".to_string());
        }
        Ok(super::normalize_clipboard_newlines(
            &String::from_utf8_lossy(&out.stdout),
        ))
    }

    pub fn write_text(text: &str) -> Result<(), String> {
        let mut child = Command::new("pbcopy")
            .env("LANG", "en_US.UTF-8")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("写入剪贴板失败: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("写入剪贴板失败: {e}"))?;
        }
        let status = child.wait().map_err(|e| format!("写入剪贴板失败: {e}"))?;
        if !status.success() {
            return Err("写入剪贴板失败".to_string());
        }
        Ok(())
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod native_clipboard {
    use std::io::Write;
    use std::process::{Command, Stdio};

    pub fn read_text() -> Result<String, String> {
        for (cmd, args) in [
            ("wl-paste", vec!["--no-newline"]),
            ("xclip", vec!["-selection", "clipboard", "-o"]),
            ("xsel", vec!["--clipboard", "--output"]),
        ] {
            if let Ok(out) = Command::new(cmd).args(&args).output() {
                if out.status.success() {
                    return Ok(super::normalize_clipboard_newlines(
                        &String::from_utf8_lossy(&out.stdout),
                    ));
                }
            }
        }
        Err("读取剪贴板失败".to_string())
    }

    pub fn write_text(text: &str) -> Result<(), String> {
        for (cmd, args) in [
            ("wl-copy", vec![]),
            ("xclip", vec!["-selection", "clipboard", "-i"]),
            ("xsel", vec!["--clipboard", "--input"]),
        ] {
            if let Ok(mut child) = Command::new(cmd)
                .args(&args)
                .stdin(Stdio::piped())
                .spawn()
            {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(text.as_bytes());
                }
                if let Ok(status) = child.wait() {
                    if status.success() {
                        return Ok(());
                    }
                }
            }
        }
        Err("写入剪贴板失败".to_string())
    }
}

#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    native_clipboard::read_text()
}

#[tauri::command]
fn write_clipboard_text(text: String) -> Result<(), String> {
    native_clipboard::write_text(&text)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            engine_info,
            parse_praat_bytes,
            parse_textgrid_bytes,
            serialize_textgrid,
            serialize_collection,
            slice_textgrid,
            scan_diagnostics,
            build_zip_store,
            decode_praat_trigraphs,
            encode_praat_trigraphs,
            has_praat_trigraphs,
            get_yunlong_candidates,
            step_yunlong_char,
            get_praat_matches,
            lookup_ipa_symbol,
            summarize_audio,
            load_pcm_session,
            load_wav_session,
            load_wav_file_session,
            remove_audio_session,
            clear_audio_session,
            render_spectrogram_rgba_packed,
            compute_band_contours,
            compute_waveform_path,
            find_zero_crossing,
            align_split_boundaries,
            scan_corpus_dir,
            stat_local_file,
            inspect_dropped_paths,
            read_local_file,
            read_local_file_if_exists,
            write_local_file,
            write_local_file_atomic,
            find_companion_audio,
            reveal_in_explorer,
            open_external_url,
            get_launch_file_arg,
            read_clipboard_text,
            write_clipboard_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running T·Grid - TextGrid Editor");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_case_insensitive_companion_wav() {
        let dir = std::env::temp_dir().join(format!(
            "tgrid_companion_test_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let tg_file = dir.join("Sample_01.TextGrid");
        let wav_file = dir.join("sample_01.WAV");
        std::fs::write(&tg_file, b"tg").unwrap();
        std::fs::write(&wav_file, b"wav").unwrap();

        let found = find_companion_audio(tg_file.to_string_lossy().into_owned());
        assert!(found.is_some());
        assert!(found.unwrap().to_lowercase().ends_with("sample_01.wav"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validates_external_urls_safely() {
        assert_eq!(
            validate_external_url("https://github.com/KasumiKitsune/tgrid").unwrap(),
            "https://github.com/KasumiKitsune/tgrid"
        );
        assert_eq!(
            validate_external_url("  http://example.org/docs  ").unwrap(),
            "http://example.org/docs"
        );
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(validate_external_url("https://").is_err());
        assert!(validate_external_url("https://example.org/a b").is_err());
        assert!(validate_external_url("https://example.org/\nfoo").is_err());
    }

    #[test]
    fn normalizes_clipboard_newlines() {
        assert_eq!(normalize_clipboard_newlines("a\r\nb\rc\nd"), "a\nb\nc\nd");
        assert_eq!(normalize_clipboard_newlines("plain ʃ 中文"), "plain ʃ 中文");
    }

    #[test]
    fn scans_corpus_dir_and_writes_atomically() {
        let dir = std::env::temp_dir().join(format!("tgrid_corpus_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Build minimal 16-bit mono 16kHz WAV header claiming 32000 bytes (1.0s)
        let mut wav = Vec::with_capacity(44);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36u32 + 32000).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&32000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&32000u32.to_le_bytes());

        std::fs::write(dir.join("001_ba.WAV"), &wav).unwrap();
        std::fs::write(dir.join("001_ba.TextGrid"), b"tg").unwrap();
        std::fs::write(dir.join(".tgrid-project.json"), b"{}").unwrap();

        let res = scan_corpus_dir(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(res.audio_files.len(), 1);
        assert_eq!(res.text_grid_files.len(), 1);
        assert!(res.has_project_file);
        let dur = res.audio_files[0].duration.unwrap();
        assert!((dur - 1.0).abs() < 1e-6);

        let target = dir.join("001_ba.TextGrid");
        write_local_file_atomic(target.to_string_lossy().into_owned(), b"updated".to_vec())
            .unwrap();
        assert_eq!(
            read_local_file_if_exists(target.to_string_lossy().into_owned()).unwrap(),
            Some(b"updated".to_vec())
        );
        assert_eq!(
            read_local_file_if_exists(dir.join("missing.TextGrid").to_string_lossy().into_owned())
                .unwrap(),
            None
        );

        let present_stat = stat_local_file(target.to_string_lossy().into_owned()).unwrap();
        assert!(present_stat.exists);
        assert_eq!(present_stat.size, b"updated".len() as u64);
        assert!(present_stat.modified_ms > 0);

        let missing_stat =
            stat_local_file(dir.join("missing.TextGrid").to_string_lossy().into_owned()).unwrap();
        assert!(!missing_stat.exists);
        assert_eq!(missing_stat.size, 0);
        assert_eq!(missing_stat.modified_ms, 0);

        let inspected = inspect_dropped_paths(vec![
            dir.to_string_lossy().into_owned(),
            target.to_string_lossy().into_owned(),
            dir.join("missing.TextGrid").to_string_lossy().into_owned(),
        ]);
        assert_eq!(inspected.len(), 3);
        assert!(inspected[0].exists && inspected[0].is_dir && inspected[0].size == 0);
        assert!(
            inspected[1].exists
                && !inspected[1].is_dir
                && inspected[1].size == b"updated".len() as u64
                && inspected[1].name == "001_ba.TextGrid"
        );
        assert!(!inspected[2].exists && !inspected[2].is_dir);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
