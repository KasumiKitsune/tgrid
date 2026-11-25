use crate::model::{ContourBox, ContourPath};
use std::collections::HashMap;

fn simplify_closed_ring(pts: &[[f64; 2]], eps: f64) -> Vec<[f64; 2]> {
    let n = pts.len();
    if n <= 4 || eps <= 0.0 {
        return pts.to_vec();
    }
    let eps_sq = eps * eps;
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack = vec![(0usize, n - 1)];

    while let Some((a, b)) = stack.pop() {
        let mut max_d2 = -1.0_f64;
        let mut max_idx: Option<usize> = None;
        let ax = pts[a][0];
        let ay = pts[a][1];
        let dx = pts[b][0] - ax;
        let dy = pts[b][1] - ay;
        let len_sq = dx * dx + dy * dy;

        for (i, pt) in pts.iter().enumerate().take(b).skip(a + 1) {
            let px = pt[0] - ax;
            let py = pt[1] - ay;
            let d2 = if len_sq < 1e-12 {
                px * px + py * py
            } else {
                let t = ((px * dx + py * dy) / len_sq).clamp(0.0, 1.0);
                let cx = px - t * dx;
                let cy = py - t * dy;
                cx * cx + cy * cy
            };
            if d2 > max_d2 {
                max_d2 = d2;
                max_idx = Some(i);
            }
        }

        if let Some(mid) = max_idx {
            if max_d2 > eps_sq {
                keep[mid] = true;
                stack.push((a, mid));
                stack.push((mid, b));
            }
        }
    }

    pts.iter()
        .enumerate()
        .filter_map(|(i, &p)| if keep[i] { Some(p) } else { None })
        .collect()
}

fn ring_abs_area(pts: &[[f64; 2]]) -> f64 {
    let n = pts.len();
    let mut a = 0.0;
    for i in 0..n {
        let p = pts[i];
        let q = pts[(i + 1) % n];
        a += p[0] * q[1] - q[0] * p[1];
    }
    a.abs() * 0.5
}

fn fmt_coord(n: f64) -> String {
    let s = format!("{:.2}", n);
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed == "-0" || trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

#[inline]
fn v_key(p: [f64; 2]) -> (i64, i64) {
    ((p[0] * 1000.0).round() as i64, (p[1] * 1000.0).round() as i64)
}

#[inline]
fn interp(v0: f32, v1: f32, thr: f32) -> f64 {
    let diff = (v1 - v0) as f64;
    if diff.abs() < 1e-9 {
        0.5
    } else {
        (((thr - v0) as f64) / diff).clamp(0.0, 1.0)
    }
}

/// Marching Squares pure-vector contour generator with 1-cell border padding and saddle disambiguation.
pub fn generate_spectrogram_contours(
    grid: &[f32],
    cols: usize,
    rows: usize,
    box_rect: ContourBox,
    levels: usize,
    palette_key: &str,
) -> Vec<ContourPath> {
    if grid.len() < cols * rows
        || cols < 2
        || rows < 2
        || box_rect.width <= 0.0
        || box_rect.height <= 0.0
    {
        return Vec::new();
    }

    let thresholds: &[f32] = match levels {
        4 => &[0.11, 0.32, 0.55, 0.77],
        8 => &[0.07, 0.17, 0.28, 0.40, 0.53, 0.66, 0.78, 0.89],
        _ => &[0.08, 0.22, 0.38, 0.54, 0.70, 0.84],
    };

    let p_cols = cols + 2;
    let p_rows = rows + 2;
    let mut padded = vec![-1.0_f32; p_cols * p_rows];
    for r in 0..rows {
        let src_off = r * cols;
        let dst_off = (r + 1) * p_cols + 1;
        for c in 0..cols {
            let v = grid[src_off + c];
            padded[dst_off + c] = if v.is_finite() { v } else { 0.0 };
        }
    }

    let inv_cols = 1.0 / ((cols - 1).max(1) as f64);
    let inv_rows = 1.0 / ((rows - 1).max(1) as f64);
    let map_x = |gx: f64| -> f64 {
        let u = ((gx - 1.0) * inv_cols).clamp(0.0, 1.0);
        box_rect.x + u * box_rect.width
    };
    let map_y = |gy: f64| -> f64 {
        let v = ((gy - 1.0) * inv_rows).clamp(0.0, 1.0);
        box_rect.y + v * box_rect.height
    };

    let is_bw = palette_key.eq_ignore_ascii_case("bw");
    let mut result = Vec::with_capacity(thresholds.len());

    for (li, &thr) in thresholds.iter().enumerate() {
        let t_frac = if thresholds.len() > 1 {
            li as f64 / (thresholds.len() - 1) as f64
        } else {
            1.0
        };
        let fill = if is_bw {
            let g = (230.0 - t_frac * 230.0).round() as i32;
            format!("rgb({g},{g},{g})")
        } else {
            let r_c = (233.0 - t_frac * 213.0).round() as i32;
            let g_c = (231.0 - t_frac * 211.0).round() as i32;
            let b_c = (225.0 - t_frac * 206.0).round() as i32;
            format!("rgb({r_c},{g_c},{b_c})")
        };

        let mut segments: Vec<([f64; 2], [f64; 2])> = Vec::new();
        for cy in 0..(p_rows - 1) {
            let row0 = cy * p_cols;
            let row1 = (cy + 1) * p_cols;
            for cx in 0..(p_cols - 1) {
                let tl = padded[row0 + cx];
                let tr = padded[row0 + cx + 1];
                let br = padded[row1 + cx + 1];
                let bl = padded[row1 + cx];

                let mask = (if tl >= thr { 8u8 } else { 0 })
                    | (if tr >= thr { 4u8 } else { 0 })
                    | (if br >= thr { 2u8 } else { 0 })
                    | (if bl >= thr { 1u8 } else { 0 });
                if mask == 0 || mask == 15 {
                    continue;
                }

                let cxf = cx as f64;
                let cyf = cy as f64;
                let top_pt = || [map_x(cxf + interp(tl, tr, thr)), map_y(cyf)];
                let right_pt = || [map_x(cxf + 1.0), map_y(cyf + interp(tr, br, thr))];
                let bottom_pt = || [map_x(cxf + interp(bl, br, thr)), map_y(cyf + 1.0)];
                let left_pt = || [map_x(cxf), map_y(cyf + interp(tl, bl, thr))];

                match mask {
                    1 => segments.push((bottom_pt(), left_pt())),
                    2 => segments.push((right_pt(), bottom_pt())),
                    3 => segments.push((right_pt(), left_pt())),
                    4 => segments.push((top_pt(), right_pt())),
                    5 => {
                        let avg = 0.25 * (tl + tr + br + bl);
                        if avg >= thr {
                            segments.push((top_pt(), left_pt()));
                            segments.push((bottom_pt(), right_pt()));
                        } else {
                            segments.push((top_pt(), right_pt()));
                            segments.push((bottom_pt(), left_pt()));
                        }
                    }
                    6 => segments.push((top_pt(), bottom_pt())),
                    7 => segments.push((top_pt(), left_pt())),
                    8 => segments.push((left_pt(), top_pt())),
                    9 => segments.push((bottom_pt(), top_pt())),
                    10 => {
                        let avg = 0.25 * (tl + tr + br + bl);
                        if avg >= thr {
                            segments.push((left_pt(), bottom_pt()));
                            segments.push((right_pt(), top_pt()));
                        } else {
                            segments.push((left_pt(), top_pt()));
                            segments.push((right_pt(), bottom_pt()));
                        }
                    }
                    11 => segments.push((right_pt(), top_pt())),
                    12 => segments.push((left_pt(), right_pt())),
                    13 => segments.push((bottom_pt(), right_pt())),
                    14 => segments.push((left_pt(), bottom_pt())),
                    _ => {}
                }
            }
        }

        if segments.is_empty() {
            continue;
        }

        let mut start_map: HashMap<(i64, i64), Vec<usize>> = HashMap::with_capacity(segments.len());
        for (i, seg) in segments.iter().enumerate() {
            start_map.entry(v_key(seg.0)).or_default().push(i);
        }

        let mut used = vec![false; segments.len()];
        let mut path_str = String::new();

        for i in 0..segments.len() {
            if used[i] {
                continue;
            }
            used[i] = true;
            let mut ring = vec![segments[i].0, segments[i].1];
            let start_key = v_key(ring[0]);
            let mut cur_pt = segments[i].1;
            let mut guard = 0usize;

            while guard < segments.len() + 2 {
                guard += 1;
                let cur_key = v_key(cur_pt);
                if cur_key == start_key {
                    break;
                }
                let Some(bucket) = start_map.get(&cur_key) else {
                    break;
                };
                let mut next_idx = None;
                for &idx in bucket {
                    if !used[idx] {
                        next_idx = Some(idx);
                        break;
                    }
                }
                let Some(ni) = next_idx else {
                    break;
                };
                used[ni] = true;
                cur_pt = segments[ni].1;
                ring.push(cur_pt);
            }

            if ring.len() >= 3 && v_key(ring[0]) == v_key(*ring.last().unwrap()) {
                ring.pop();
            }
            if ring.len() < 3 {
                continue;
            }
            let simp = simplify_closed_ring(&ring, 0.35);
            if simp.len() < 3 || ring_abs_area(&simp) < 0.45 {
                continue;
            }
            path_str.push('M');
            path_str.push_str(&fmt_coord(simp[0][0]));
            path_str.push(' ');
            path_str.push_str(&fmt_coord(simp[0][1]));
            for pt in &simp[1..] {
                path_str.push('L');
                path_str.push_str(&fmt_coord(pt[0]));
                path_str.push(' ');
                path_str.push_str(&fmt_coord(pt[1]));
            }
            path_str.push('Z');
        }

        if !path_str.is_empty() {
            result.push(ContourPath {
                level: li,
                threshold: thr as f64,
                fill,
                d: path_str,
            });
        }
    }

    result
}
