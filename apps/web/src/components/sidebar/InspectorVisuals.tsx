import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  inferSmartSplit,
  type AcousticSegmentClass,
  type SmartSplitCandidate
} from '../../utils/smartSplit';
import { ToggleSwitch } from '../ToggleSwitch';
import '../../styles/inspector.css';

/* ============================================================================
   1. BoundaryMicroWave: ±30ms Local Waveform Preview + Zero-Crossing Indicator
   ============================================================================ */

export interface BoundaryMicroWaveProps {
  audioBuffer: AudioBuffer | null;
  timeSec: number;
  nearestZeroSec?: number | null;
  accentColor?: string;
  disabled?: boolean;
  onSnapZero?: () => void;
}

const WAVE_HALF_WIN_SEC = 0.03; // ±30 ms
const WAVE_CSS_H = 56;
const ZERO_ALIGNED_EPS_MS = 0.05;

export const BoundaryMicroWave: React.FC<BoundaryMicroWaveProps> = ({
  audioBuffer,
  timeSec,
  nearestZeroSec = null,
  accentColor = '#D97706',
  disabled = false,
  onSnapZero
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cssWidth, setCssWidth] = useState<number>(260);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.max(120, Math.round(el.clientWidth));
      setCssWidth((prev) => (prev === w ? prev : w));
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    return undefined;
  }, [audioBuffer]);

  const hasNearestZero =
    nearestZeroSec !== null &&
    nearestZeroSec !== undefined &&
    Number.isFinite(nearestZeroSec);
  const deltaMs = hasNearestZero ? (nearestZeroSec - timeSec) * 1000 : null;
  const absDeltaMs = deltaMs !== null ? Math.abs(deltaMs) : null;
  const isAlignedZero = absDeltaMs !== null && absDeltaMs <= ZERO_ALIGNED_EPS_MS;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !audioBuffer || audioBuffer.length === 0 || !Number.isFinite(timeSec)) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(120, cssWidth);
    const H = WAVE_CSS_H;
    const pixelW = Math.round(W * dpr);
    const pixelH = Math.round(H * dpr);
    if (canvas.width !== pixelW) canvas.width = pixelW;
    if (canvas.height !== pixelH) canvas.height = pixelH;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Warm paper background
    ctx.fillStyle = '#FAF9F6';
    ctx.fillRect(0, 0, W, H);

    // Subtle quarter-window gridlines (-15ms, +15ms)
    ctx.strokeStyle = '#EAE6DC';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(W * 0.25) + 0.5, 0);
    ctx.lineTo(Math.round(W * 0.25) + 0.5, H);
    ctx.moveTo(Math.round(W * 0.75) + 0.5, 0);
    ctx.lineTo(Math.round(W * 0.75) + 0.5, H);
    ctx.stroke();

    // Horizontal zero-amplitude axis
    const midY = H * 0.5;
    ctx.strokeStyle = '#D3CFC5';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY + 0.5);
    ctx.lineTo(W, midY + 0.5);
    ctx.stroke();

    const t0 = timeSec - WAVE_HALF_WIN_SEC;
    const t1 = timeSec + WAVE_HALF_WIN_SEC;
    const sr = audioBuffer.sampleRate;
    const raw = audioBuffer.getChannelData(0);
    const len = raw.length;
    const sStart = Math.floor(t0 * sr);
    const sEnd = Math.ceil(t1 * sr);
    const totalSpan = Math.max(1, (t1 - t0) * sr);

    // Local peak normalization
    let localPeak = 0.05;
    const peakStart = Math.max(0, sStart);
    const peakEnd = Math.min(len - 1, sEnd);
    for (let i = peakStart; i <= peakEnd; i++) {
      const a = Math.abs(raw[i]);
      if (a > localPeak) localPeak = a;
    }

    const ampScale = midY - 7;
    const samplesPerPx = (sEnd - sStart) / Math.max(1, W);

    if (samplesPerPx >= 2) {
      // Envelope fill for dense audio
      ctx.fillStyle = 'rgba(20, 20, 19, 0.13)';
      ctx.beginPath();
      let startedEnv = false;
      const maxYs = new Float32Array(W);
      const minYs = new Float32Array(W);
      const hasCol = new Uint8Array(W);

      for (let x = 0; x < W; x++) {
        const colS0 = Math.floor(t0 * sr + (x / W) * totalSpan);
        const colS1 = Math.ceil(t0 * sr + ((x + 1) / W) * totalSpan);
        const c0 = Math.max(0, colS0);
        const c1 = Math.min(len - 1, colS1);
        if (c0 > c1) continue;
        let lo = raw[c0];
        let hi = raw[c0];
        for (let i = c0 + 1; i <= c1; i++) {
          const v = raw[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        maxYs[x] = midY - (hi / localPeak) * ampScale;
        minYs[x] = midY - (lo / localPeak) * ampScale;
        hasCol[x] = 1;
      }

      for (let x = 0; x < W; x++) {
        if (!hasCol[x]) continue;
        if (!startedEnv) {
          ctx.moveTo(x + 0.5, maxYs[x]);
          startedEnv = true;
        } else {
          ctx.lineTo(x + 0.5, maxYs[x]);
        }
      }
      for (let x = W - 1; x >= 0; x--) {
        if (!hasCol[x]) continue;
        ctx.lineTo(x + 0.5, minYs[x]);
      }
      if (startedEnv) {
        ctx.closePath();
        ctx.fill();
      }
    }

    // Crisp waveform polyline
    ctx.strokeStyle = '#141413';
    ctx.lineWidth = 1.15;
    ctx.beginPath();
    let started = false;
    const step = Math.max(1, Math.floor((sEnd - sStart) / (W * 2)));
    for (let i = sStart; i <= sEnd; i += step) {
      if (i < 0 || i >= len) continue;
      const x = ((i - t0 * sr) / totalSpan) * W;
      const y = midY - (raw[i] / localPeak) * ampScale;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Center dashed vertical marker for current timeSec
    const cx = W * 0.5;
    ctx.save();
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, 1);
    ctx.lineTo(cx, H - 1);
    ctx.stroke();
    ctx.setLineDash([]);

    // Small top & bottom alignment ticks
    ctx.fillStyle = accentColor;
    ctx.fillRect(cx - 2.5, 0, 5, 2.5);
    ctx.fillRect(cx - 2.5, H - 2.5, 5, 2.5);
    ctx.restore();

    // Nearest zero-crossing marker
    if (hasNearestZero && nearestZeroSec !== null && nearestZeroSec >= t0 && nearestZeroSec <= t1) {
      const zx = ((nearestZeroSec - t0) / (t1 - t0)) * W;
      if (!isAlignedZero) {
        // Horizontal delta bridge on zero line
        ctx.save();
        ctx.strokeStyle = 'rgba(29, 78, 216, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, midY);
        ctx.lineTo(zx, midY);
        ctx.stroke();

        // Subtle vertical dotted guide at zero-crossing
        ctx.strokeStyle = 'rgba(29, 78, 216, 0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(zx, 6);
        ctx.lineTo(zx, H - 6);
        ctx.stroke();
        ctx.restore();

        // Prominent dot with white halo
        ctx.beginPath();
        ctx.arc(zx, midY, 4.6, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(zx, midY, 3.1, 0, Math.PI * 2);
        ctx.fillStyle = '#1D4ED8';
        ctx.fill();
      } else {
        // Aligned confirmation ring right on center
        ctx.beginPath();
        ctx.arc(cx, midY, 4.4, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, midY, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#0D9488';
        ctx.fill();
      }
    }

    ctx.restore();
  }, [audioBuffer, timeSec, nearestZeroSec, hasNearestZero, isAlignedZero, accentColor, cssWidth]);

  if (!audioBuffer || audioBuffer.length === 0 || !Number.isFinite(timeSec)) {
    return null;
  }

  const formattedDelta =
    deltaMs !== null
      ? `${deltaMs >= 0 ? '+' : ''}${Math.abs(deltaMs) < 0.1 ? deltaMs.toFixed(2) : deltaMs.toFixed(1)} ms`
      : '';

  return (
    <div className="insp-wave-box">
      <div className="insp-wave-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="insp-wave-canvas"
          aria-label="当前位置附近波形预览"
        />
        <span className="insp-wave-tag">附近波形</span>
        <span className="insp-wave-scale is-left">-30ms</span>
        <span className="insp-wave-scale is-right">+30ms</span>
      </div>

      <div className="insp-wave-foot">
        {isAlignedZero ? (
          <span className="insp-wave-status is-aligned">
            <span className="insp-wave-dot is-aligned" aria-hidden="true" />
            <span>已对齐过零点</span>
          </span>
        ) : deltaMs !== null ? (
          <>
            <span
              className="insp-wave-status"
              title={`距最近过零点 ${formattedDelta}`}
            >
              <span className="insp-wave-dot" aria-hidden="true" />
              <span>距最近过零点</span>
              <span className="insp-wave-delta">{formattedDelta}</span>
            </span>
            {onSnapZero && (
              <button
                type="button"
                className="insp-wave-snap-btn"
                disabled={disabled}
                onClick={onSnapZero}
                title="将当前位置吸附到最近过零点"
              >
                吸附过零点
              </button>
            )}
          </>
        ) : (
          <span className="insp-wave-status">附近波形（±30 ms）</span>
        )}
      </div>
    </div>
  );
};

/* ============================================================================
   2. IntervalF0Sparkline: F0 Contour Chart + Acoustic Metrics + Formant Bars
   ============================================================================ */

export interface IntervalF0SparklineProps {
  pitchTrack?: ReadonlyArray<{ t: number; f0: number | null }> | null;
  xmin: number;
  xmax: number;
  meanF0?: number | null;
  minF0?: number | null;
  maxF0?: number | null;
  voicedRatio?: number | null;
  rmsDb?: number | null;
  formants?: { f1?: number | null; f2?: number | null; f3?: number | null } | null;
  onCopyTsv?: () => void;
}

const F0_SVG_W = 240;
const F0_SVG_H = 42;
const F0_PAD_TOP = 6;
const F0_PAD_BOT = 5;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function formatHzVal(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return '—';
  return `${v.toFixed(digits)} Hz`;
}

export const IntervalF0Sparkline: React.FC<IntervalF0SparklineProps> = ({
  pitchTrack,
  xmin,
  xmax,
  meanF0,
  minF0,
  maxF0,
  voicedRatio,
  rmsDb,
  formants,
  onCopyTsv
}) => {
  const span = Math.max(1e-6, xmax - xmin);

  const chartData = useMemo(() => {
    const rawInSpan: Array<{ t: number; f0: number | null }> = [];
    if (pitchTrack && pitchTrack.length > 0 && Number.isFinite(xmin) && Number.isFinite(xmax) && xmax > xmin) {
      for (let i = 0; i < pitchTrack.length; i++) {
        const pt = pitchTrack[i];
        if (pt.t < xmin || pt.t > xmax) continue;
        rawInSpan.push(pt);
      }
    }

    const validPts: Array<{ t: number; f0: number }> = [];
    let trackMin = Infinity;
    let trackMax = -Infinity;
    let trackSum = 0;

    for (let i = 0; i < rawInSpan.length; i++) {
      const f = rawInSpan[i].f0;
      if (f !== null && Number.isFinite(f) && f > 0) {
        validPts.push({ t: rawInSpan[i].t, f0: f });
        if (f < trackMin) trackMin = f;
        if (f > trackMax) trackMax = f;
        trackSum += f;
      }
    }

    const effMean =
      meanF0 !== undefined && meanF0 !== null && Number.isFinite(meanF0) && meanF0 > 0
        ? meanF0
        : validPts.length > 0
          ? trackSum / validPts.length
          : null;
    const effMin =
      minF0 !== undefined && minF0 !== null && Number.isFinite(minF0) && minF0 > 0
        ? minF0
        : validPts.length > 0
          ? trackMin
          : null;
    const effMax =
      maxF0 !== undefined && maxF0 !== null && Number.isFinite(maxF0) && maxF0 > 0
        ? maxF0
        : validPts.length > 0
          ? trackMax
          : null;

    const effVoicedRatio =
      voicedRatio !== undefined && voicedRatio !== null && Number.isFinite(voicedRatio)
        ? clamp01(voicedRatio)
        : rawInSpan.length > 0
          ? clamp01(validPts.length / rawInSpan.length)
          : null;

    // Build contiguous voiced runs
    const runs: Array<Array<{ x: number; y: number }>> = [];
    let yLo = effMin ?? 75;
    let yHi = effMax ?? 300;
    if (yHi - yLo < 24) {
      const mid = (yHi + yLo) * 0.5;
      yLo = Math.max(40, mid - 12);
      yHi = mid + 12;
    } else {
      const pad = (yHi - yLo) * 0.14;
      yLo = Math.max(30, yLo - pad);
      yHi = yHi + pad;
    }
    const yRange = Math.max(1, yHi - yLo);
    const usableH = F0_SVG_H - F0_PAD_TOP - F0_PAD_BOT;

    const toX = (t: number) => clamp01((t - xmin) / span) * F0_SVG_W;
    const toY = (f0: number) => F0_PAD_TOP + (1 - clamp01((f0 - yLo) / yRange)) * usableH;

    const maxGapSec = Math.max(0.045, span * 0.14);
    let currentRun: Array<{ x: number; y: number }> = [];
    let lastValidT = -Infinity;

    for (let i = 0; i < rawInSpan.length; i++) {
      const pt = rawInSpan[i];
      if (pt.f0 === null || !Number.isFinite(pt.f0) || pt.f0 <= 0) {
        if (currentRun.length > 0) {
          runs.push(currentRun);
          currentRun = [];
        }
        lastValidT = -Infinity;
        continue;
      }
      if (currentRun.length > 0 && pt.t - lastValidT > maxGapSec) {
        runs.push(currentRun);
        currentRun = [];
      }
      currentRun.push({ x: toX(pt.t), y: toY(pt.f0) });
      lastValidT = pt.t;
    }
    if (currentRun.length > 0) {
      runs.push(currentRun);
    }

    const meanY = effMean !== null ? toY(effMean) : null;

    return {
      runs,
      meanY,
      effMean,
      effMin,
      effMax,
      effVoicedRatio,
      hasCurve: validPts.length > 0
    };
  }, [pitchTrack, xmin, xmax, span, meanF0, minF0, maxF0, voicedRatio]);

  const semitoneRange =
    chartData.effMin !== null &&
    chartData.effMax !== null &&
    chartData.effMin > 0 &&
    chartData.effMax >= chartData.effMin
      ? 12 * Math.log2(chartData.effMax / chartData.effMin)
      : null;

  const hasFormants = Boolean(
    formants &&
      ((formants.f1 !== null && formants.f1 !== undefined && Number.isFinite(formants.f1) && formants.f1 > 0) ||
        (formants.f2 !== null && formants.f2 !== undefined && Number.isFinite(formants.f2) && formants.f2 > 0) ||
        (formants.f3 !== null && formants.f3 !== undefined && Number.isFinite(formants.f3) && formants.f3 > 0))
  );

  const formantRows = useMemo(() => {
    if (!hasFormants || !formants) return [];
    const specs: Array<{ key: 'f1' | 'f2' | 'f3'; label: string; value: number | null | undefined; lo: number; hi: number }> = [
      { key: 'f1', label: 'F1', value: formants.f1, lo: 200, hi: 1100 },
      { key: 'f2', label: 'F2', value: formants.f2, lo: 600, hi: 3000 },
      { key: 'f3', label: 'F3', value: formants.f3, lo: 1500, hi: 4200 }
    ];
    return specs.map((item) => {
      const valid =
        item.value !== null &&
        item.value !== undefined &&
        Number.isFinite(item.value) &&
        item.value > 0;
      const pct = valid ? clamp01(((item.value as number) - item.lo) / (item.hi - item.lo)) * 100 : 0;
      return {
        ...item,
        valid,
        pct: valid ? Math.max(4, pct) : 0
      };
    });
  }, [hasFormants, formants]);

  const voicedPctText =
    chartData.effVoicedRatio !== null ? `浊音 ${Math.round(chartData.effVoicedRatio * 100)}%` : null;

  return (
    <div className="insp-f0-box">
      <div className="insp-f0-chart-wrap" aria-label="区间基频曲线">
        <svg
          className="insp-f0-svg"
          viewBox={`0 0 ${F0_SVG_W} ${F0_SVG_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="基频曲线图"
        >
          {/* Subtle horizontal guide lines */}
          <line
            x1={0}
            y1={F0_SVG_H * 0.5}
            x2={F0_SVG_W}
            y2={F0_SVG_H * 0.5}
            stroke="#E6E2D8"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />

          {/* Mean F0 dashed reference line */}
          {chartData.meanY !== null && (
            <line
              x1={0}
              y1={chartData.meanY}
              x2={F0_SVG_W}
              y2={chartData.meanY}
              stroke="#1D4ED8"
              strokeOpacity={0.42}
              strokeWidth={1}
              strokeDasharray="3 2.5"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* Voiced pitch runs */}
          {chartData.runs.map((run, idx) => {
            if (run.length === 1) {
              return (
                <circle
                  key={idx}
                  cx={run[0].x}
                  cy={run[0].y}
                  r={1.9}
                  fill="#1D4ED8"
                />
              );
            }
            const lineD = run
              .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
              .join(' ');
            const areaD = `${lineD} L${run[run.length - 1].x.toFixed(1)},${F0_SVG_H} L${run[0].x.toFixed(1)},${F0_SVG_H} Z`;
            return (
              <g key={idx}>
                <path d={areaD} fill="#1D4ED8" fillOpacity={0.09} />
                <path
                  d={lineD}
                  fill="none"
                  stroke="#1D4ED8"
                  strokeWidth={1.6}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
        </svg>

        <span className="insp-f0-chart-label">基频曲线</span>
        {voicedPctText && (
          <span className="insp-f0-voiced-badge" title={`浊音占比 ${voicedPctText}`}>
            {voicedPctText}
          </span>
        )}
        {!chartData.hasCurve && (
          <span className="insp-f0-empty-msg">当前段无有效基频</span>
        )}
      </div>

      {/* Compact 2-column acoustic readout */}
      <div className="insp-f0-metrics">
        <div className="insp-f0-metric">
          <span className="insp-f0-metric-k">基频均值</span>
          <span className="insp-f0-metric-v">{formatHzVal(chartData.effMean, 1)}</span>
        </div>

        <div className="insp-f0-metric">
          <span className="insp-f0-metric-k">相对强度 (dB)</span>
          <span className="insp-f0-metric-v">
            {rmsDb !== null && rmsDb !== undefined && Number.isFinite(rmsDb)
              ? `${rmsDb.toFixed(1)} dB`
              : '—'}
          </span>
        </div>

        <div className="insp-f0-metric is-span-2">
          <span className="insp-f0-metric-k">基频范围</span>
          <span className="insp-f0-metric-v">
            {chartData.effMin !== null && chartData.effMax !== null ? (
              <>
                {Math.round(chartData.effMin)} – {Math.round(chartData.effMax)} Hz
                {semitoneRange !== null && (
                  <span className="insp-f0-metric-sub">
                    {semitoneRange.toFixed(1)} 半音
                  </span>
                )}
              </>
            ) : (
              '—'
            )}
          </span>
        </div>
      </div>

      {/* Formant bars (when provided and valid) */}
      {formantRows.length > 0 && (
        <div className="insp-formant-list" aria-label="共振峰数值">
          {formantRows.map((row) => (
            <div key={row.key} className="insp-formant-row">
              <span className="insp-formant-name">{row.label}</span>
              <div className="insp-formant-track" aria-hidden="true">
                {row.valid && (
                  <div
                    className={`insp-formant-fill is-${row.key}`}
                    style={{ width: `${row.pct.toFixed(1)}%` }}
                  />
                )}
              </div>
              <span className="insp-formant-val">
                {row.valid ? `${Math.round(row.value as number)} Hz` : '—'}
              </span>
            </div>
          ))}
        </div>
      )}

      {onCopyTsv && (
        <div className="insp-f0-foot">
          <button
            type="button"
            className="insp-btn is-xs"
            onClick={onCopyTsv}
            title="将当前声学统计复制为制表符分隔数据"
          >
            复制数据 (TSV)
          </button>
        </div>
      )}
    </div>
  );
};

/* ============================================================================
   3. BoundaryBalanceBar: Left / Right Neighbor Duration & Quick-Jump Strip
   ============================================================================ */

export interface BoundaryBalanceBarProps {
  leftText: string;
  rightText: string;
  leftDurSec: number;
  rightDurSec: number;
  onJumpLeft?: () => void;
  onJumpRight?: () => void;
}

function formatCompactDur(sec: number): string {
  const safe = Math.max(0, Number.isFinite(sec) ? sec : 0);
  if (safe >= 1) return `${safe.toFixed(2)}s`;
  const ms = safe * 1000;
  if (ms >= 10) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(1)}ms`;
}

export const BoundaryBalanceBar: React.FC<BoundaryBalanceBarProps> = ({
  leftText,
  rightText,
  leftDurSec,
  rightDurSec,
  onJumpLeft,
  onJumpRight
}) => {
  const lDur = Math.max(0, Number.isFinite(leftDurSec) ? leftDurSec : 0);
  const rDur = Math.max(0, Number.isFinite(rightDurSec) ? rightDurSec : 0);
  const total = lDur + rDur;
  const rawLeftPct = total > 0 ? (lDur / total) * 100 : 50;
  const visualLeftPct = Math.max(8, Math.min(92, rawLeftPct));
  const visualRightPct = 100 - visualLeftPct;

  const lTrim = leftText.trim();
  const rTrim = rightText.trim();
  const lDurStr = formatCompactDur(lDur);
  const rDurStr = formatCompactDur(rDur);

  return (
    <div className="insp-balance-bar" aria-label="左右相邻区间时长占比">
      <div className="insp-balance-cells">
        <button
          type="button"
          className="insp-balance-cell is-left"
          disabled={!onJumpLeft}
          onClick={onJumpLeft}
          title={
            onJumpLeft
              ? `点击选中左侧区间：${lTrim ? `「${lTrim}」` : '（空白）'} · ${lDurStr} (${Math.round(rawLeftPct)}%)`
              : `左侧区间：${lTrim ? `「${lTrim}」` : '（空白）'} · ${lDurStr}`
          }
        >
          <span className="insp-balance-side">左侧区间</span>
          <span className="insp-balance-main">
            <span className={`insp-balance-text${lTrim ? '' : ' is-empty'}`}>
              {lTrim || '空白'}
            </span>
            <span className="insp-balance-dur">· {lDurStr}</span>
          </span>
        </button>

        <span className="insp-balance-divider" aria-hidden="true" />

        <button
          type="button"
          className="insp-balance-cell is-right"
          disabled={!onJumpRight}
          onClick={onJumpRight}
          title={
            onJumpRight
              ? `点击选中右侧区间：${rTrim ? `「${rTrim}」` : '（空白）'} · ${rDurStr} (${Math.round(100 - rawLeftPct)}%)`
              : `右侧区间：${rTrim ? `「${rTrim}」` : '（空白）'} · ${rDurStr}`
          }
        >
          <span className="insp-balance-side">右侧区间</span>
          <span className="insp-balance-main">
            <span className={`insp-balance-text${rTrim ? '' : ' is-empty'}`}>
              {rTrim || '空白'}
            </span>
            <span className="insp-balance-dur">· {rDurStr}</span>
          </span>
        </button>
      </div>

      <div className="insp-balance-ratio">
        <div
          className={`insp-balance-seg is-left${onJumpLeft ? ' is-clickable' : ''}`}
          style={{ width: `${visualLeftPct.toFixed(1)}%` }}
          onClick={onJumpLeft}
          title={`左侧区间占 ${Math.round(rawLeftPct)}%`}
        />
        <span className="insp-balance-spine" aria-hidden="true" />
        <div
          className={`insp-balance-seg is-right${onJumpRight ? ' is-clickable' : ''}`}
          style={{ width: `${visualRightPct.toFixed(1)}%` }}
          onClick={onJumpRight}
          title={`右侧区间占 ${Math.round(100 - rawLeftPct)}%`}
        />
      </div>
    </div>
  );
};

/* ============================================================================
   4. SmartSplitInlineCard: Collapsible Single-Interval Smart Split Card
   ============================================================================ */

export interface SmartSplitInlineCardProps {
  rawText: string;
  decodedPraatText?: string | null;
  tierName: string;
  peerTexts: string[];
  xmin: number;
  xmax: number;
  hasAudio: boolean;
  useAcoustic: boolean;
  disabled?: boolean;
  onToggleAcoustic: (v: boolean) => void;
  onApplyCandidate: (candidate: SmartSplitCandidate, useAcoustic: boolean) => void;
  onOpenAdvancedModal: () => void;
}

const MAX_INLINE_CANDIDATES = 4;
const MAX_PREVIEW_SEGS = 9;

function segClassName(cls: AcousticSegmentClass | undefined): string {
  switch (cls) {
    case 'vowel':
      return 'cls-vowel';
    case 'voiceless-obs':
      return 'cls-voiceless-obs';
    case 'voiced-obs':
      return 'cls-voiced-obs';
    case 'nasal-liquid':
      return 'cls-nasal-liquid';
    case 'syllable':
      return 'cls-syllable';
    default:
      return 'cls-other';
  }
}

export const SmartSplitInlineCard: React.FC<SmartSplitInlineCardProps> = ({
  rawText,
  decodedPraatText,
  tierName,
  peerTexts,
  xmin,
  xmax,
  hasAudio,
  useAcoustic,
  disabled = false,
  onToggleAcoustic,
  onApplyCandidate,
  onOpenAdvancedModal
}) => {
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState('');

  const plan = useMemo(
    () =>
      inferSmartSplit(rawText, decodedPraatText, {
        tierName,
        peerTexts,
        hasAudio
      }),
    [rawText, decodedPraatText, tierName, peerTexts, hasAudio]
  );

  const candidates = useMemo<SmartSplitCandidate[]>(() => {
    if (!plan.primary) return [];
    return [plan.primary, ...plan.alternatives].slice(0, MAX_INLINE_CANDIDATES);
  }, [plan]);

  useEffect(() => {
    if (candidates.length === 0) {
      setSelectedId('');
      setExpanded(false);
      return;
    }
    setSelectedId((prev) =>
      candidates.some((c) => c.id === prev) ? prev : candidates[0].id
    );
  }, [candidates]);

  const activeCandidate = useMemo<SmartSplitCandidate | null>(() => {
    if (candidates.length === 0) return null;
    return candidates.find((c) => c.id === selectedId) ?? candidates[0];
  }, [candidates, selectedId]);

  const totalDur = Math.max(0, xmax - xmin);

  // Prepare proportional preview cells (always declared before early return to respect Rules of Hooks)
  const previewItems = useMemo(() => {
    if (!activeCandidate) return [];
    const texts = activeCandidate.texts;
    const weights = activeCandidate.durationWeights;
    const classes = activeCandidate.acousticClasses;
    const n = texts.length;

    const getWeight = (i: number) => {
      const w = weights[i];
      return Number.isFinite(w) && w > 0 ? w : 1;
    };

    if (n <= MAX_PREVIEW_SEGS) {
      return texts.map((tok, i) => ({
        key: `${i}`,
        text: tok,
        weight: getWeight(i),
        cls: segClassName(classes[i]),
        isEllipsis: false,
        altTint: i % 2 === 1
      }));
    }

    const headCount = MAX_PREVIEW_SEGS - 2;
    const items = texts.slice(0, headCount).map((tok, i) => ({
      key: `${i}`,
      text: tok,
      weight: getWeight(i),
      cls: segClassName(classes[i]),
      isEllipsis: false,
      altTint: i % 2 === 1
    }));
    items.push({
      key: 'ellipsis',
      text: '…',
      weight: 0.6,
      cls: '',
      isEllipsis: true,
      altTint: false
    });
    const lastIdx = n - 1;
    items.push({
      key: `${lastIdx}`,
      text: texts[lastIdx],
      weight: getWeight(lastIdx),
      cls: segClassName(classes[lastIdx]),
      isEllipsis: false,
      altTint: lastIdx % 2 === 1
    });
    return items;
  }, [activeCandidate]);

  // No smart recommendation: single compact equal-split row
  if (!plan.primary || !activeCandidate) {
    return (
      <div className="insp-split-card">
        <div className="insp-split-head">
          <div className="insp-split-summary is-static">
            <span className="insp-split-tag is-muted">等分区间</span>
          </div>
          <button
            type="button"
            className="insp-split-toggle-btn"
            disabled={disabled}
            onClick={onOpenAdvancedModal}
          >
            打开设置…
          </button>
        </div>
      </div>
    );
  }

  const primary = plan.primary;
  const segCount = activeCandidate.texts.length;
  const avgDurStr = segCount > 0 ? formatCompactDur(totalDur / segCount) : '0ms';
  const canApply = !disabled && totalDur > 1e-6 && segCount >= 2;

  const summaryText = `建议${primary.strategyLabel}（${primary.texts.length} 段）`;

  return (
    <div className={`insp-split-card${expanded ? ' is-expanded' : ''}`}>
      <div className="insp-split-head">
        <div
          className="insp-split-summary"
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setExpanded((v) => !v);
            }
          }}
          title={`${summaryText} — 点击${expanded ? '收起' : '展开'}拆分预览`}
        >
          <span className="insp-split-tag">智能拆分</span>
          <span className="insp-split-suggest">· {summaryText}</span>
        </div>
        <button
          type="button"
          className="insp-split-toggle-btn"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '收起' : '展开'}
        </button>
      </div>

      {expanded && (
        <div className="insp-split-body">
          {/* Strategy capsules */}
          <div className="insp-split-pills" role="radiogroup" aria-label="拆分方案">
            {candidates.map((cand, idx) => {
              const isActive = cand.id === activeCandidate.id;
              return (
                <button
                  key={cand.id}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  className={`insp-split-pill${isActive ? ' is-active' : ''}`}
                  onClick={() => setSelectedId(cand.id)}
                  title={`${cand.strategyLabel}：${cand.reason}`}
                >
                  {idx === 0 && <span className="insp-split-pill-rec">推荐</span>}
                  <span>{cand.switchLabel || cand.strategyLabel}</span>
                  <span className="insp-split-pill-cnt">{cand.texts.length}段</span>
                </button>
              );
            })}
          </div>

          {/* Proportional segment preview bar */}
          <div className="insp-split-bar" aria-label="切分结果预览">
            {previewItems.map((seg) => (
              <div
                key={seg.key}
                className={`insp-split-seg ${seg.cls}${seg.altTint ? ' is-alt-tint' : ''}${seg.isEllipsis ? ' is-ellipsis' : ''}`}
                style={{ flexGrow: seg.weight, flexShrink: 1, flexBasis: 0 }}
                title={seg.isEllipsis ? `共 ${segCount} 段` : seg.text}
              >
                <span className="insp-split-seg-tok">{seg.text}</span>
              </div>
            ))}
          </div>

          <div className="insp-split-meta">
            <span className="insp-split-reason" title={activeCandidate.reason}>
              {activeCandidate.reason}
            </span>
            <span className="insp-split-avg">
              共 {segCount} 段 · 均约 {avgDurStr}
            </span>
          </div>

          {/* Acoustic boundary alignment toggle (when audio is loaded) */}
          {hasAudio && (
            <div className="insp-split-acoustic">
              <ToggleSwitch
                compact
                label="声学边界对齐"
                checked={useAcoustic}
                disabled={disabled}
                onChange={onToggleAcoustic}
                title="结合音频声学特征自动对齐切分边界"
              />
            </div>
          )}

          {/* Action buttons */}
          <div className="insp-split-actions">
            <button
              type="button"
              className="insp-btn insp-btn-primary"
              disabled={!canApply}
              onClick={() => onApplyCandidate(activeCandidate, hasAudio && useAcoustic)}
            >
              应用拆分
            </button>
            <button
              type="button"
              className="insp-btn"
              disabled={disabled}
              onClick={onOpenAdvancedModal}
            >
              更多拆分选项…
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
