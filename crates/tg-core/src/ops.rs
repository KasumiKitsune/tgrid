use crate::model::{Interval, SliceOptions, TextGrid, Tier, TierDiagnostics, TierKind};

/// Non-mutating TextGrid tier-subsetting & time-domain slicing, preserving 1-based original tier indices.
pub fn slice_textgrid(tg: &TextGrid, opts: &SliceOptions) -> TextGrid {
    let has_slice = match (opts.t_min, opts.t_max) {
        (Some(a), Some(b)) => a.is_finite() && b.is_finite() && b > a,
        _ => false,
    };
    let t_min = if has_slice { opts.t_min.unwrap() } else { tg.xmin };
    let t_max = if has_slice { opts.t_max.unwrap() } else { tg.xmax };

    let selected: Vec<usize> = match &opts.tier_indices {
        Some(indices) if !indices.is_empty() => indices
            .iter()
            .copied()
            .filter(|&i| i < tg.tiers.len())
            .collect(),
        _ => (0..tg.tiers.len()).collect(),
    };

    let tiers = selected
        .into_iter()
        .map(|orig_idx| {
            let src = &tg.tiers[orig_idx];
            let raw_tmin = if src.xmin.is_finite() { src.xmin } else { t_min };
            let raw_tmax = if src.xmax.is_finite() { src.xmax } else { t_max };
            let tier_xmin = if has_slice {
                raw_tmin.clamp(t_min, t_max)
            } else {
                raw_tmin
            };
            let tier_xmax = if has_slice {
                raw_tmax.clamp(tier_xmin, t_max)
            } else {
                raw_tmax
            };

            match src.kind {
                TierKind::IntervalTier => {
                    let intervals = if !has_slice {
                        src.intervals.clone()
                    } else {
                        let mut out = Vec::new();
                        for iv in &src.intervals {
                            if !iv.xmin.is_finite() || !iv.xmax.is_finite() {
                                continue;
                            }
                            if iv.xmin == iv.xmax {
                                if iv.xmin >= t_min && iv.xmin <= t_max {
                                    out.push(iv.clone());
                                }
                            } else if iv.xmax > t_min && iv.xmin < t_max {
                                let a = iv.xmin.max(t_min);
                                let b = iv.xmax.min(t_max);
                                if b > a {
                                    out.push(Interval {
                                        xmin: a,
                                        xmax: b,
                                        text: iv.text.clone(),
                                    });
                                }
                            }
                        }
                        if out.is_empty() && !src.intervals.is_empty() {
                            out.push(Interval {
                                xmin: tier_xmin,
                                xmax: tier_xmax,
                                text: String::new(),
                            });
                        }
                        out
                    };

                    Tier {
                        kind: TierKind::IntervalTier,
                        name: src.name.clone(),
                        xmin: tier_xmin,
                        xmax: tier_xmax,
                        intervals,
                        points: Vec::new(),
                        display_num: Some(orig_idx + 1),
                    }
                }
                TierKind::TextTier => {
                    let points = src
                        .points
                        .iter()
                        .filter(|p| {
                            p.number.is_finite()
                                && (!has_slice || (p.number >= t_min && p.number <= t_max))
                        })
                        .cloned()
                        .collect();
                    Tier {
                        kind: TierKind::TextTier,
                        name: src.name.clone(),
                        xmin: tier_xmin,
                        xmax: tier_xmax,
                        intervals: Vec::new(),
                        points,
                        display_num: Some(orig_idx + 1),
                    }
                }
            }
        })
        .collect();

    TextGrid {
        name: tg.name.clone(),
        xmin: t_min,
        xmax: t_max,
        tiers,
    }
}

/// Scans all tiers for structural issues: gaps, overlaps, zero-duration intervals, micro-segments (< 5ms), and out-of-domain bounds.
pub fn scan_diagnostics(tg: &TextGrid) -> Vec<TierDiagnostics> {
    tg.tiers
        .iter()
        .enumerate()
        .map(|(tier_index, tier)| {
            let mut gap_count = 0;
            let mut overlap_count = 0;
            let mut zero_duration_count = 0;
            let mut micro_segment_count = 0;

            if tier.kind == TierKind::IntervalTier {
                for (i, iv) in tier.intervals.iter().enumerate() {
                    let dur = iv.xmax - iv.xmin;
                    if dur.abs() <= 1e-12 {
                        zero_duration_count += 1;
                    } else if dur > 0.0 && dur < 0.005 {
                        micro_segment_count += 1;
                    }
                    if i > 0 {
                        let prev = &tier.intervals[i - 1];
                        let diff = iv.xmin - prev.xmax;
                        if diff > 1e-9 {
                            gap_count += 1;
                        } else if diff < -1e-9 {
                            overlap_count += 1;
                        }
                    }
                }
            }

            let out_of_domain =
                (tier.xmin - tg.xmin).abs() > 1e-9 || (tier.xmax - tg.xmax).abs() > 1e-9;

            TierDiagnostics {
                tier_index,
                gap_count,
                overlap_count,
                zero_duration_count,
                micro_segment_count,
                out_of_domain,
            }
        })
        .collect()
}
