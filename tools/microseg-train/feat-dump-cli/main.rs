// Standalone zero-dependency batch feature extractor using the EXACT same
// `crates/tg-core/src/nn/features.rs` implementation (zero train/infer drift).
// Compile on Linux/Colab with: `rustc -O -o feat_dump_cli main.rs`

#[cfg(feature = "colab_local")]
mod features;

#[cfg(not(feature = "colab_local"))]
#[path = "../../../crates/tg-core/src/nn/features.rs"]
mod features;

use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

fn read_wav_mono(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!("invalid WAV: {}", path.display()));
    }
    let mut off = 12usize;
    let mut audio_fmt = 0u16;
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits_per_sample = 0u16;
    let mut data_slice: Option<&[u8]> = None;

    while off + 8 <= bytes.len() {
        let id = &bytes[off..off + 4];
        let size = u32::from_le_bytes([
            bytes[off + 4],
            bytes[off + 5],
            bytes[off + 6],
            bytes[off + 7],
        ]) as usize;
        off += 8;
        if off + size > bytes.len() {
            break;
        }
        if id == b"fmt " && size >= 16 {
            audio_fmt = u16::from_le_bytes([bytes[off], bytes[off + 1]]);
            channels = u16::from_le_bytes([bytes[off + 2], bytes[off + 3]]);
            sample_rate = u32::from_le_bytes([
                bytes[off + 4],
                bytes[off + 5],
                bytes[off + 6],
                bytes[off + 7],
            ]);
            bits_per_sample = u16::from_le_bytes([bytes[off + 14], bytes[off + 15]]);
        } else if id == b"data" {
            data_slice = Some(&bytes[off..off + size]);
        }
        off += size + (size & 1);
    }
    let data = data_slice.ok_or_else(|| "missing data chunk".to_string())?;
    let ch = channels.max(1) as usize;
    let samples = match (audio_fmt, bits_per_sample) {
        (1, 16) => {
            let n = data.len() / (2 * ch);
            let mut out = Vec::with_capacity(n);
            for f in 0..n {
                let mut acc = 0.0f32;
                for c in 0..ch {
                    let p = (f * ch + c) * 2;
                    acc += (i16::from_le_bytes([data[p], data[p + 1]]) as f32) / 32768.0;
                }
                out.push(acc / (ch as f32));
            }
            out
        }
        (3, 32) => {
            let n = data.len() / (4 * ch);
            let mut out = Vec::with_capacity(n);
            for f in 0..n {
                let mut acc = 0.0f32;
                for c in 0..ch {
                    let p = (f * ch + c) * 4;
                    acc += f32::from_le_bytes([data[p], data[p + 1], data[p + 2], data[p + 3]]);
                }
                out.push(acc / (ch as f32));
            }
            out
        }
        _ => return Err(format!("unsupported wav fmt={audio_fmt} bits={bits_per_sample}")),
    };
    Ok((samples, sample_rate))
}

fn write_f32_feats(path: &Path, num_frames: usize, data: &[f32]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut buf = Vec::with_capacity(8 + data.len() * 4);
    buf.extend_from_slice(&(num_frames as u32).to_le_bytes());
    buf.extend_from_slice(&32u32.to_le_bytes());
    for &v in data {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    fs::write(path, &buf).map_err(|e| format!("write {}: {e}", path.display()))
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage:");
        eprintln!("  feat_dump_cli wav <in.wav> <out.f32>");
        eprintln!("  feat_dump_cli f32 <in.f32> <sample_rate> <out.f32>");
        eprintln!("  feat_dump_cli batch <manifest.tsv> [num_threads]");
        eprintln!("    manifest.tsv lines: <in_path>\\t<sample_rate_or_0_for_wav>\\t<out_path>");
        std::process::exit(1);
    }

    match args[1].as_str() {
        "wav" => {
            let (samples, sr) = read_wav_mono(Path::new(&args[2])).expect("read wav");
            let feats = features::extract_features(&samples, sr);
            write_f32_feats(Path::new(&args[3]), feats.num_frames, &feats.data).expect("write");
        }
        "f32" => {
            let raw = fs::read(&args[2]).expect("read f32");
            let sr: u32 = args[3].parse().expect("parse sr");
            let n = raw.len() / 4;
            let mut samples = Vec::with_capacity(n);
            for i in 0..n {
                samples.push(f32::from_le_bytes([
                    raw[i * 4],
                    raw[i * 4 + 1],
                    raw[i * 4 + 2],
                    raw[i * 4 + 3],
                ]));
            }
            let feats = features::extract_features(&samples, sr);
            write_f32_feats(Path::new(&args[4]), feats.num_frames, &feats.data).expect("write");
        }
        "batch" => {
            let manifest = Path::new(&args[2]);
            let threads: usize = args
                .get(3)
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(|| {
                    thread::available_parallelism()
                        .map(|n| n.get())
                        .unwrap_or(4)
                });
            let file = fs::File::open(manifest).expect("open manifest");
            let jobs: Vec<(String, u32, String)> = BufReader::new(file)
                .lines()
                .filter_map(|l| l.ok())
                .filter_map(|line| {
                    let parts: Vec<&str> = line.trim().split('\t').collect();
                    if parts.len() >= 3 {
                        let sr = parts[1].parse::<u32>().unwrap_or(0);
                        Some((parts[0].to_string(), sr, parts[2].to_string()))
                    } else {
                        None
                    }
                })
                .collect();

            let total = jobs.len();
            let queue = Arc::new(Mutex::new(jobs.into_iter()));
            let ok_cnt = Arc::new(Mutex::new(0usize));
            let err_cnt = Arc::new(Mutex::new(0usize));

            let mut handles = Vec::new();
            for _ in 0..threads.max(1) {
                let q = Arc::clone(&queue);
                let ok = Arc::clone(&ok_cnt);
                let err = Arc::clone(&err_cnt);
                handles.push(thread::spawn(move || loop {
                    let job = { q.lock().unwrap().next() };
                    let Some((in_p, sr, out_p)) = job else { break; };
                    let res = if sr == 0 {
                        read_wav_mono(Path::new(&in_p))
                    } else {
                        fs::read(&in_p)
                            .map_err(|e| e.to_string())
                            .map(|raw| {
                                let n = raw.len() / 4;
                                let mut s = Vec::with_capacity(n);
                                for i in 0..n {
                                    s.push(f32::from_le_bytes([
                                        raw[i * 4],
                                        raw[i * 4 + 1],
                                        raw[i * 4 + 2],
                                        raw[i * 4 + 3],
                                    ]));
                                }
                                (s, sr)
                            })
                    };
                    match res {
                        Ok((samples, rate)) => {
                            let feats = features::extract_features(&samples, rate);
                            if write_f32_feats(Path::new(&out_p), feats.num_frames, &feats.data)
                                .is_ok()
                            {
                                *ok.lock().unwrap() += 1;
                            } else {
                                *err.lock().unwrap() += 1;
                            }
                        }
                        Err(_) => {
                            *err.lock().unwrap() += 1;
                        }
                    }
                }));
            }
            for h in handles {
                let _ = h.join();
            }
            println!(
                "batch done: total={} ok={} err={}",
                total,
                *ok_cnt.lock().unwrap(),
                *err_cnt.lock().unwrap()
            );
        }
        other => {
            eprintln!("unknown subcommand: {other}");
            std::process::exit(1);
        }
    }
}
