import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getPlatformBridge } from '../bridge/PlatformBridge';
import type { AudioAnalysisSummary } from '../bridge/types';
import { getElementRectScale } from '../utils/uiScale';

export interface MicroLoupeAnchor {
  centerT: number;
  anchorX: number;
  anchorTopY: number;
  anchorBottomY: number;
  snapLabel: string | null;
}

interface AcousticMicroLoupeProps {
  anchor: MicroLoupeAnchor | null;
  audioBuffer: AudioBuffer | null;
  audioOffset: number;
  analysis: AudioAnalysisSummary | null;
  showSpectrogram: boolean;
  maxFreq: number;
  layoutWidth: number;
  stageRef: React.RefObject<HTMLElement | null>;
  sheetRef: React.RefObject<HTMLDivElement | null>;
}

const LOUPE_CSS_W = 260;
const LOUPE_W = 520; // 2x HiDPI
const WAVE_H = 84; // 42px CSS
const BRIDGE_H = 18; // 9px CSS
const SPEC_H = 160; // 80px CSS
const WAVE_HALF_WIN_SEC = 0.04; // ±40 ms (total 80 ms)
const SPEC_HALF_WIN_SEC = 0.15; // ±150 ms (total 300 ms)
const FOOT_H = 20;
const BORDER_H = 2;

export const AcousticMicroLoupe: React.FC<AcousticMicroLoupeProps> = ({
  anchor,
  audioBuffer,
  audioOffset,
  analysis,
  showSpectrogram,
  maxFreq,
  layoutWidth,
  stageRef,
  sheetRef
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const specCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastSpecMetaRef = useRef<{ sessionId: number; maxFreq: number; centerT: number } | null>(null);
  const specInFlightRef = useRef(false);
  const pendingSpecRef = useRef<{ centerT: number; sessionId: number; maxFreq: number } | null>(null);
  const activeRunIdRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);

  const visible = Boolean(anchor && audioBuffer && audioBuffer.length > 0);
  const showSpec = Boolean(showSpectrogram && analysis);
  const totalCanvasH = WAVE_H + (showSpec ? BRIDGE_H + SPEC_H : 0);

  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 8, top: 8 });
  const latestDrawRef = useRef<() => void>(() => {});

  const drawCanvas = useCallback(
    (curAnchor: MicroLoupeAnchor) => {
      const canvas = canvasRef.current;
      if (!canvas || !audioBuffer || audioBuffer.length === 0) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const W = LOUPE_W;
      const waveH = WAVE_H;
      const bridgeH = showSpec ? BRIDGE_H : 0;
      const specH = showSpec ? SPEC_H : 0;
      const specY = waveH + bridgeH;
      const H = specY + specH;

      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;

      const centerT = curAnchor.centerT;
      const t0 = centerT - WAVE_HALF_WIN_SEC;
      const t1 = centerT + WAVE_HALF_WIN_SEC;
      const sr = audioBuffer.sampleRate;
      const raw = audioBuffer.getChannelData(0);
      const len = raw.length;
      const offset = audioOffset;

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, W, H);

      // 1. Upper section: ±40 ms high-resolution waveform
      ctx.fillStyle = '#FAF9F6';
      ctx.fillRect(0, 0, W, waveH);

      const midY = waveH / 2;
      ctx.strokeStyle = '#D4D0C7';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(W, midY);
      ctx.stroke();

      const sStart = Math.floor((t0 - offset) * sr);
      const sEnd = Math.ceil((t1 - offset) * sr);
      const totalSpan = Math.max(1, (t1 - t0) * sr);

      let localPeak = 0.05;
      const peakStart = Math.max(0, sStart);
      const peakEnd = Math.min(len - 1, sEnd);
      for (let i = peakStart; i <= peakEnd; i++) {
        const a = Math.abs(raw[i]);
        if (a > localPeak) localPeak = a;
      }

      // Sample-accurate waveform curve
      ctx.strokeStyle = '#141413';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      const step = Math.max(1, Math.floor((sEnd - sStart) / W));
      for (let i = sStart; i <= sEnd; i += step) {
        if (i < 0 || i >= len) continue;
        const x = ((i - (t0 - offset) * sr) / totalSpan) * W;
        const y = midY - (raw[i] / localPeak) * (midY - 8);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      // 2. Dual-scale bridge strip + lower ±150 ms natural-aspect broadband spectrogram
      if (showSpec && analysis) {
        const focusHalfW = (WAVE_HALF_WIN_SEC / SPEC_HALF_WIN_SEC) * (W / 2);
        const boxL = W / 2 - focusHalfW;
        const boxR = W / 2 + focusHalfW;

        // 2a. Connecting trapezoid bridge strip (waveH .. waveH + bridgeH)
        ctx.fillStyle = '#F6F4EE';
        ctx.fillRect(0, waveH, W, bridgeH);

        ctx.fillStyle = 'rgba(29, 78, 216, 0.09)';
        ctx.beginPath();
        ctx.moveTo(0, waveH);
        ctx.lineTo(W, waveH);
        ctx.lineTo(boxR, specY);
        ctx.lineTo(boxL, specY);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = 'rgba(29, 78, 216, 0.55)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, waveH);
        ctx.lineTo(boxL, specY);
        ctx.moveTo(W, waveH);
        ctx.lineTo(boxR, specY);
        ctx.stroke();

        // 2b. Lower spectrogram (±150 ms)
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, specY, W, specH);

        const specCanvas = specCanvasRef.current;
        const meta = lastSpecMetaRef.current;
        if (
          specCanvas &&
          meta &&
          meta.sessionId === analysis.sessionId &&
          meta.maxFreq === maxFreq
        ) {
          const shiftPx = ((meta.centerT - centerT) / (SPEC_HALF_WIN_SEC * 2)) * W;
          if (Math.abs(shiftPx) < W) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, specY, W, specH);
            ctx.clip();
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(specCanvas, shiftPx, specY, W, specH);
            ctx.restore();
          }
        }

        // 2c. Matching ±40 ms focus frame overlay inside the ±150 ms spectrogram
        ctx.fillStyle = 'rgba(29, 78, 216, 0.05)';
        ctx.fillRect(boxL, specY, boxR - boxL, specH);

        ctx.save();
        ctx.strokeStyle = 'rgba(29, 78, 216, 0.62)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(boxL, specY);
        ctx.lineTo(boxL, specY + specH);
        ctx.moveTo(boxR, specY);
        ctx.lineTo(boxR, specY + specH);
        ctx.stroke();
        ctx.restore();

        // Crisp 1px dividers at wave/bridge and bridge/spec boundaries
        ctx.strokeStyle = '#C8C4BA';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, waveH + 0.5);
        ctx.lineTo(W, waveH + 0.5);
        ctx.stroke();

        ctx.strokeStyle = '#141413';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, specY + 0.5);
        ctx.lineTo(W, specY + 0.5);
        ctx.stroke();

        // Subtle corner scale micro-tags (2x HiDPI)
        const drawScalePill = (label: string, topY: number) => {
          ctx.save();
          ctx.font = '18px "JetBrains Mono", Consolas, monospace';
          const pillW = Math.ceil(ctx.measureText(label).width) + 12;
          const pillH = 24;
          const px = W - pillW - 6;
          ctx.fillStyle = '#FFFFFFD9';
          ctx.fillRect(px, topY, pillW, pillH);
          ctx.fillStyle = '#6E6A60';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, px + pillW / 2, topY + pillH / 2 + 0.5);
          ctx.restore();
        };
        drawScalePill('±40 ms', 5);
        drawScalePill('±150 ms', specY + 6);
      }

      // 3. Center crisp red (or amber when snapped) vertical crosshair + horizontal ticks
      const cx = W / 2;
      const reticleColor = curAnchor.snapLabel ? '#B45309' : '#B91C1C';
      ctx.strokeStyle = reticleColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (showSpec) {
        const specMidY = specY + specH * 0.5;
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, specMidY - 22);
        ctx.moveTo(cx, specMidY + 22);
        ctx.lineTo(cx, H);
        ctx.moveTo(cx - 12, specMidY);
        ctx.lineTo(cx - 5, specMidY);
        ctx.moveTo(cx + 5, specMidY);
        ctx.lineTo(cx + 12, specMidY);
      } else {
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, H);
      }
      ctx.stroke();
    },
    [audioBuffer, audioOffset, showSpec, analysis, maxFreq]
  );

  // Keep latestDrawRef pointed at current anchor render so async spectrogram resolution redraws immediately
  const anchorRef = useRef<MicroLoupeAnchor | null>(null);
  anchorRef.current = anchor;
  latestDrawRef.current = () => {
    if (anchorRef.current) drawCanvas(anchorRef.current);
  };

  // Throttled / coalesced Rust spectrogram fetch (1 in-flight request max, latest wins, zero stale frames)
  const pumpSpectrogramFetch = useCallback(() => {
    if (specInFlightRef.current) return;
    const req = pendingSpecRef.current;
    if (!req) return;
    pendingSpecRef.current = null;

    const runId = activeRunIdRef.current;
    specInFlightRef.current = true;

    const bridge = getPlatformBridge();
    const t0 = req.centerT - SPEC_HALF_WIN_SEC;
    const t1 = req.centerT + SPEC_HALF_WIN_SEC;
    // Render 260x80 (1px per CSS pixel -> natural broadband aspect ratio + sharp 2x HiDPI draw onto 520x160)
    void bridge
      .renderSpectrogramRgba(
        req.sessionId,
        [{ x0: 0, x1: LOUPE_CSS_W, t0, t1, collapsed: false }],
        0,
        LOUPE_CSS_W,
        SPEC_H / 2,
        req.maxFreq,
        1,
        50,
        'warm'
      )
      .then((res) => {
        if (runId !== activeRunIdRef.current || !anchorRef.current) return;
        if (res.width > 0 && res.height > 0 && res.rgba.length >= res.width * res.height * 4) {
          let off = specCanvasRef.current;
          if (!off) {
            off = document.createElement('canvas');
            specCanvasRef.current = off;
          }
          if (off.width !== res.width) off.width = res.width;
          if (off.height !== res.height) off.height = res.height;
          const octx = off.getContext('2d');
          if (octx) {
            const copy = new Uint8ClampedArray(res.width * res.height * 4);
            copy.set(res.rgba.subarray(0, res.width * res.height * 4));
            octx.putImageData(new ImageData(copy, res.width, res.height), 0, 0);
            lastSpecMetaRef.current = {
              sessionId: req.sessionId,
              maxFreq: req.maxFreq,
              centerT: req.centerT
            };
            latestDrawRef.current();
          }
        }
      })
      .catch(() => {
        // Ignore transient spectrogram errors during rapid dragging
      })
      .finally(() => {
        specInFlightRef.current = false;
        if (runId === activeRunIdRef.current && pendingSpecRef.current && anchorRef.current) {
          if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = requestAnimationFrame(() => {
            rafIdRef.current = null;
            pumpSpectrogramFetch();
          });
        }
      });
  }, []);

  // Synchronous waveform + crosshair redraw & queued Rust spectrogram refresh on every anchor update
  useEffect(() => {
    if (!visible || !anchor) {
      activeRunIdRef.current++;
      pendingSpecRef.current = null;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      return;
    }

    drawCanvas(anchor);

    if (showSpec && analysis) {
      pendingSpecRef.current = {
        centerT: anchor.centerT,
        sessionId: analysis.sessionId,
        maxFreq
      };
      if (!specInFlightRef.current && rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          pumpSpectrogramFetch();
        });
      }
    }
  }, [visible, anchor, drawCanvas, showSpec, analysis, maxFreq, pumpSpectrogramFetch]);

  // Cleanup any pending RAF on unmount
  useEffect(() => {
    return () => {
      activeRunIdRef.current++;
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  // Placement: ALWAYS prefer BELOW the dragged boundary/point (never obscuring time spine / waveform / spectrogram).
  // Flip above the dragged tier ONLY if placing below would clip off the bottom of the visible #stage viewport.
  useLayoutEffect(() => {
    if (!visible || !anchor) return;
    const loupeW = LOUPE_CSS_W + 2;
    const loupeH = totalCanvasH / 2 + FOOT_H + BORDER_H;

    let minLeft = 8;
    let maxLeft = Math.max(8, layoutWidth - loupeW - 8);
    let visTop = 0;
    let visBottom = Number.POSITIVE_INFINITY;

    const stageEl = stageRef.current;
    const sheetEl = sheetRef.current;
    if (stageEl && sheetEl) {
      const z = getElementRectScale(sheetEl);
      const stageRect = stageEl.getBoundingClientRect();
      const sheetRect = sheetEl.getBoundingClientRect();
      const visLeft = (stageRect.left - sheetRect.left) / z;
      const visRight = (stageRect.right - sheetRect.left) / z;
      visTop = (stageRect.top - sheetRect.top) / z;
      visBottom = (stageRect.bottom - sheetRect.top) / z;

      const clampedMin = Math.max(8, visLeft + 8);
      const clampedMax = Math.min(layoutWidth - loupeW - 8, visRight - loupeW - 8);
      if (clampedMin <= clampedMax) {
        minLeft = clampedMin;
        maxLeft = clampedMax;
      }
    }

    const left = Math.max(minLeft, Math.min(maxLeft, anchor.anchorX - loupeW / 2));

    const belowTop = anchor.anchorBottomY + 10;
    let top: number;
    if (belowTop + loupeH <= visBottom - 8) {
      top = belowTop;
    } else {
      const aboveTop = anchor.anchorTopY - loupeH - 12;
      const minTop = Math.max(6, visTop + 6);
      top = aboveTop >= minTop ? aboveTop : Math.max(minTop, visBottom - loupeH - 8);
    }

    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [visible, anchor, totalCanvasH, layoutWidth, stageRef, sheetRef]);

  const snapLabel = anchor?.snapLabel ?? null;

  return (
    <div
      className={`micro-loupe ${visible ? 'visible' : ''}`}
      style={{ left: pos.left, top: pos.top }}
      aria-hidden={!visible}
    >
      <canvas
        ref={canvasRef}
        width={LOUPE_W}
        height={totalCanvasH}
        style={{ width: `${LOUPE_CSS_W}px`, height: `${totalCanvasH / 2}px` }}
      />
      <div className="micro-loupe-foot">
        <span className="micro-loupe-time">
          {anchor ? `${anchor.centerT.toFixed(6)} s` : '0.000000 s'}
        </span>
        <span className={`micro-loupe-tag ${snapLabel ? 'snapped' : ''}`}>
          {snapLabel || (showSpec ? '波 ±40 / 谱 ±150 ms' : '波形 ±40 ms')}
        </span>
      </div>
    </div>
  );
};
