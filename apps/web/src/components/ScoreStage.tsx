import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { getPlatformBridge } from '../bridge/PlatformBridge';
import {
  computeLayout,
  elasticXInBand,
  timeFromElasticX,
  timeFromLinearX,
  type BandLayout,
  type BoxRect,
  type ScoreLayout
} from '../layout/computeLayout';
import {
  MONO_FONT_STACK,
  formatPraatDouble,
  measurePx,
  prefetchTrigraphCache,
  primeTrigraphString
} from '../layout/richText';
import { svgEl } from '../layout/legendCore';
import {
  renderInteractiveOverlay,
  renderScoreSvg,
  type DragPreviewState,
  type EditorSelection
} from '../render/renderScoreSvg';
import { rgbaToPngDataUrl } from '../render/exporter';
import { getBoundaryBoundsForTier, useEditorStore } from '../store/useEditorStore';
import type { TextGrid } from '../bridge/types';
import { UiIcon } from './Icons';
import { IpaImePopover, IpaModePill } from './IpaImePopover';
import { isIpaRelatedElement, useIpaIme } from './useIpaIme';
import { AcousticMicroLoupe, type MicroLoupeAnchor } from './AcousticMicroLoupe';

export interface ScoreStageHandle {
  insertIpaSymbol: (sym: string, isTieBar?: boolean) => void;
  pruneSpecCacheForSession: (sessionId: number) => void;
  flushInlineEdit: () => void;
}

interface ScoreStageProps {
  audioBuffer: AudioBuffer | null;
  onStartPlayback: (startT: number, endT: number) => void;
  onTogglePlay: () => void;
  onStopPlayback: () => void;
  onQuickExportSvg: () => void;
  onQuickExportPng: () => void;
}

type InlineTarget =
  | { kind: 'interval'; tierIndex: number; itemIndex: number }
  | { kind: 'point'; tierIndex: number; itemIndex: number }
  | { kind: 'tier-name'; tierIndex: number };

interface ContextMenuItem {
  label?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  action?: () => void;
}

function getSelectionAnchor(
  layout: ScoreLayout | null,
  sel: EditorSelection
): { rect: BoxRect; band: BandLayout } | null {
  if (!sel || !layout) return null;
  const search = (restrictBand: boolean): { rect: BoxRect; band: BandLayout } | null => {
    for (const band of layout.bands) {
      if (restrictBand && sel.bandIndex !== undefined && band.bandIndex !== sel.bandIndex) continue;
      if (sel.kind === 'interval') {
        const tl = band.tiersLayout[sel.tierIndex];
        if (!tl) continue;
        for (const vi of tl.visibleIvs || []) {
          if (vi.iv.origIdx === sel.itemIndex) {
            return {
              rect: {
                x: vi.x0,
                y: tl.y + (tl.laneOffsets?.[vi.iv.lane] || 0),
                w: vi.w,
                h: tl.laneHeights?.[vi.iv.lane] || tl.h
              },
              band
            };
          }
        }
        for (const vz of tl.visibleZeros || []) {
          if (vz.iv.origIdx === sel.itemIndex) {
            return { rect: { x: vz.x - 10, y: tl.y, w: 20, h: tl.h }, band };
          }
        }
      } else if (sel.kind === 'point') {
        const tl = band.tiersLayout[sel.tierIndex];
        if (!tl || tl.wireY === undefined) continue;
        for (const vp of tl.visiblePts || []) {
          if (vp.pt.origIdx === sel.itemIndex) {
            const boxH =
              vp.rich && tl.levelY ? tl.levelY[vp.level] + vp.boxH - (tl.wireY - tl.y) : 12;
            const x = vp.rich ? vp.bx : vp.x - 12;
            return {
              rect: { x, y: tl.wireY - 6, w: Math.max(24, vp.boxW), h: Math.max(18, boxH + 6) },
              band
            };
          }
        }
      } else if (sel.kind === 'boundary') {
        const tl = band.tiersLayout[sel.tierIndex];
        if (!tl || sel.time < band.startT || sel.time > band.endT) continue;
        const idx = layout.tToIdx.get(sel.time);
        if (idx === undefined || idx < band.startIdx || idx > band.endIdx) continue;
        return {
          rect: { x: band.spineCols[idx - band.startIdx].x - 4, y: tl.y, w: 8, h: tl.h },
          band
        };
      } else if (sel.kind === 'spine') {
        if (sel.time < band.startT || sel.time > band.endT) continue;
        const idx = layout.tToIdx.get(sel.time);
        const x =
          idx !== undefined && idx >= band.startIdx && idx <= band.endIdx
            ? band.spineCols[idx - band.startIdx].x
            : elasticXInBand(band, sel.time);
        return { rect: { x: x - 6, y: band.tiersTopY - 24, w: 12, h: 24 }, band };
      } else if (sel.kind === 'tier') {
        const tl = band.tiersLayout[sel.tierIndex];
        if (tl) return { rect: tl.headerBox, band };
      }
    }
    return null;
  };
  return search(true) || search(false);
}

function getSelectionAnchorRect(layout: ScoreLayout | null, sel: EditorSelection): BoxRect | null {
  return getSelectionAnchor(layout, sel)?.rect ?? null;
}

function getBoundaryDragBounds(
  tg: TextGrid,
  tierIndex: number,
  oldT: number,
  shared: boolean
): { minAllowed: number; maxAllowed: number } {
  let minAllowed = -Infinity;
  let maxAllowed = Infinity;
  if (shared) {
    for (const t of tg.tiers) {
      if (t.kind === 'intervalTier') {
        const b = getBoundaryBoundsForTier(t, oldT);
        minAllowed = Math.max(minAllowed, b.minAllowed);
        maxAllowed = Math.min(maxAllowed, b.maxAllowed);
      }
    }
  } else {
    const tier = tg.tiers[tierIndex];
    if (tier) {
      const b = getBoundaryBoundsForTier(tier, oldT);
      minAllowed = b.minAllowed;
      maxAllowed = b.maxAllowed;
    }
  }
  return { minAllowed, maxAllowed };
}

function findCrossTierSnap(
  band: BandLayout,
  cursorX: number,
  fromSpec: boolean,
  origTime: number,
  minAllowed: number,
  maxAllowed: number,
  tolPx = 8,
  excludeTierIdx?: number,
  excludeTime?: number
): { t: number; x: number } | null {
  let best: { t: number; x: number } | null = null;
  let bestDist = Infinity;
  for (const col of band.spineCols) {
    if (col.t === origTime) continue;
    if (col.t < minAllowed || col.t > maxAllowed) continue;
    const targetPx = fromSpec ? band.linearXForTime(col.t) : col.x;
    const dist = Math.abs(targetPx - cursorX);
    if (dist <= tolPx && dist < bestDist) {
      bestDist = dist;
      best = { t: col.t, x: col.x };
    }
  }
  // Also scan detached/visible TextTier points so boundaries & points still snap to isolated points
  for (const tl of band.tiersLayout) {
    if (!tl?.visiblePts) continue;
    for (const vp of tl.visiblePts) {
      const ptT = vp.pt.number;
      if (!Number.isFinite(ptT)) continue;
      if (
        excludeTierIdx !== undefined &&
        tl.tierIndex === excludeTierIdx &&
        ptT === (excludeTime ?? origTime)
      ) {
        continue;
      }
      if (excludeTierIdx === undefined && ptT === origTime) continue;
      if (ptT < minAllowed || ptT > maxAllowed) continue;
      const targetPx = fromSpec ? band.linearXForTime(ptT) : vp.x;
      const dist = Math.abs(targetPx - cursorX);
      if (dist <= tolPx && dist < bestDist) {
        bestDist = dist;
        best = { t: ptT, x: vp.x };
      }
    }
  }
  return best;
}

function findNearbySpecBoundary(
  tg: TextGrid,
  selection: EditorSelection,
  band: BandLayout,
  xPx: number,
  tolPx = 6
): { tierIndex: number; time: number; x: number } | null {
  const candidates: number[] = [];
  if (
    selection &&
    'tierIndex' in selection &&
    tg.tiers[selection.tierIndex]?.kind === 'intervalTier'
  ) {
    candidates.push(selection.tierIndex);
  }
  if (band.finestIntervalTierIdx >= 0 && !candidates.includes(band.finestIntervalTierIdx)) {
    candidates.push(band.finestIntervalTierIdx);
  }
  tg.tiers.forEach((t, idx) => {
    if (t.kind === 'intervalTier' && !candidates.includes(idx)) candidates.push(idx);
  });

  for (const ti of candidates) {
    const tier = tg.tiers[ti];
    for (const iv of tier.intervals) {
      for (const bt of [iv.xmin, iv.xmax]) {
        if (!Number.isFinite(bt) || bt <= tier.xmin || bt >= tier.xmax || bt < band.startT || bt > band.endT) {
          continue;
        }
        const bx = band.linearXForTime(bt);
        if (Math.abs(bx - xPx) <= tolPx) {
          return { tierIndex: ti, time: bt, x: bx };
        }
      }
    }
  }
  return null;
}

export const ScoreStage = forwardRef<ScoreStageHandle, ScoreStageProps>(
  ({ audioBuffer, onStartPlayback, onTogglePlay, onStopPlayback, onQuickExportSvg, onQuickExportPng }, ref) => {
    const tg = useEditorStore((s) => s.tg);
    const activeTabId = useEditorStore((s) => s.activeTabId);
    const docVersion = useEditorStore((s) => s.docVersion);
    const mode = useEditorStore((s) => s.mode);
    const setMode = useEditorStore((s) => s.setMode);
    const wrapMode = useEditorStore((s) => s.wrapMode);
    const setWrapMode = useEditorStore((s) => s.setWrapMode);
    const scaleMode = useEditorStore((s) => s.scaleMode);
    const tickPrecision = useEditorStore((s) => s.tickPrecision);
    const tickFixedDecimals = useEditorStore((s) => s.tickFixedDecimals);
    const viewDomain = useEditorStore((s) => s.viewDomain);
    const setViewDomain = useEditorStore((s) => s.setViewDomain);
    const targetWidth = useEditorStore((s) => s.targetWidth);
    const setTargetWidth = useEditorStore((s) => s.setTargetWidth);
    const selection = useEditorStore((s) => s.selection);
    const setSelection = useEditorStore((s) => s.setSelection);
    const playRange = useEditorStore((s) => s.playRange);
    const setPlayRange = useEditorStore((s) => s.setPlayRange);
    const currentTime = useEditorStore((s) => s.currentTime);
    const setPlaybackTime = useEditorStore((s) => s.setPlaybackTime);
    const showPlayhead = useEditorStore((s) => s.showPlayhead);
    const playing = useEditorStore((s) => s.playing);
    const setLoop = useEditorStore((s) => s.setLoop);
    const audioName = useEditorStore((s) => s.audioName);
    const audioOffset = useEditorStore((s) => s.audioOffset);
    const analysis = useEditorStore((s) => s.analysis);
    const showSpectrogram = useEditorStore((s) => s.showSpectrogram);
    const cueMode = useEditorStore((s) => s.cueMode);
    const tierOrder = useEditorStore((s) => s.tierOrder);
    const maxFreq = useEditorStore((s) => s.maxFreq);
    const editInspectorMode = useEditorStore((s) => s.editInspectorMode);
    const showMicroLoupe = useEditorStore((s) => s.showMicroLoupe);
    const exportOpen = useEditorStore((s) => s.exportOpen);
    const cycleIpaMode = useEditorStore((s) => s.cycleIpaMode);
    const setLayoutStore = useEditorStore((s) => s.setLayout);
    const setExportOpen = useEditorStore((s) => s.setExportOpen);
    const commitTgMutation = useEditorStore((s) => s.commitTgMutation);
    const undo = useEditorStore((s) => s.undo);
    const redo = useEditorStore((s) => s.redo);
    const splitInterval = useEditorStore((s) => s.splitInterval);
    const mergeIntervalWith = useEditorStore((s) => s.mergeIntervalWith);
    const deleteBoundaryAt = useEditorStore((s) => s.deleteBoundaryAt);
    const addPointAt = useEditorStore((s) => s.addPointAt);
    const insertTierAt = useEditorStore((s) => s.insertTierAt);
    const moveTier = useEditorStore((s) => s.moveTier);
    const deleteTier = useEditorStore((s) => s.deleteTier);
    const normalizeTextGrid = useEditorStore((s) => s.normalizeTextGrid);
    const moveTierBoundary = useEditorStore((s) => s.moveTierBoundary);
    const moveSharedTimestamp = useEditorStore((s) => s.moveSharedTimestamp);
    const showToast = useEditorStore((s) => s.showToast);

    const stageRef = useRef<HTMLElement>(null);
    const sheetRef = useRef<HTMLDivElement>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    const inlineRef = useRef<HTMLTextAreaElement>(null);
    const floatingBarRef = useRef<HTMLDivElement>(null);
    const specCacheRef = useRef<Map<string, string>>(new Map());
    const lastNavTimeRef = useRef<number>(0);
    const zKeyDownRef = useRef(false);
    const altKeyDownRef = useRef(false);
    const draggingRef = useRef(false);
    const pendingDragAnchorRef = useRef<{
      time: number;
      bandIndex: number;
      clientX: number;
      clientY: number;
    } | null>(null);

    const [stageW, setStageW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1200));
    const [trigraphTick, setTrigraphTick] = useState(0);
    const [specUrls, setSpecUrls] = useState<Map<number, string>>(() => new Map());
    const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
    const [loupeAnchor, setLoupeAnchor] = useState<MicroLoupeAnchor | null>(null);

    // Inline editor state
    const [inlineTarget, setInlineTarget] = useState<InlineTarget | null>(null);
    const [inlineBox, setInlineBox] = useState<(BoxRect & { align: 'center' | 'left' }) | null>(null);
    const [inlineVal, setInlineVal] = useState('');

    // Refs to break circular callbacks with useIpaIme
    const closeInlineRef = useRef<(commit: boolean) => void>(() => {});
    const stepSelectionRef = useRef<
      (dir: -1 | 1, axis: 'x' | 'y', openAfter: boolean, baseSel?: EditorSelection | InlineTarget) => void
    >(() => {});
    const inlineTargetRef = useRef<InlineTarget | null>(null);
    inlineTargetRef.current = inlineTarget;

    const handleInlineUnhandledKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeInlineRef.current(false);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const cur = inlineTargetRef.current;
        closeInlineRef.current(true);
        if (cur && (cur.kind === 'interval' || cur.kind === 'point' || cur.kind === 'tier-name')) {
          stepSelectionRef.current(e.shiftKey ? -1 : 1, 'x', true, cur);
        }
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const el = e.currentTarget;
        const val = el.value;
        const selStart = el.selectionStart ?? 0;
        const selEnd = el.selectionEnd ?? val.length;
        const onFirstLine = val.lastIndexOf('\n', Math.max(0, selStart) - 1) === -1;
        const onLastLine = val.indexOf('\n', selEnd) === -1;
        const shouldJump = e.altKey || e.ctrlKey || (e.key === 'ArrowUp' ? onFirstLine : onLastLine);
        if (shouldJump) {
          e.preventDefault();
          const cur = inlineTargetRef.current;
          closeInlineRef.current(true);
          if (cur) stepSelectionRef.current(e.key === 'ArrowUp' ? -1 : 1, 'y', true, cur);
        }
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        closeInlineRef.current(true);
      }
    }, []);

    const ipaIme = useIpaIme({
      textareaRef: inlineRef,
      value: inlineVal,
      onChangeValue: setInlineVal,
      active: Boolean(inlineTarget),
      onUnhandledKeyDown: handleInlineUnhandledKeyDown
    });

    // Context menu state
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

    // Clear transient UI overlays when switching / closing document tabs
    useEffect(() => {
      pendingDragAnchorRef.current = null;
      setInlineTarget(null);
      setInlineBox(null);
      setCtxMenu(null);
      setDragPreview(null);
      setLoupeAnchor(null);
    }, [activeTabId]);

    // Close inline editor & drag overlays immediately when entering read-only mode
    useEffect(() => {
      if (mode === 'read') {
        if (inlineTargetRef.current) closeInlineRef.current(true);
        setDragPreview(null);
        setLoupeAnchor(null);
      }
    }, [mode]);

    // Close context menu when GlobalContextMenu opens or user clicks outside
    useEffect(() => {
      const onCloseStage = () => setCtxMenu(null);
      const onPointerDown = (e: PointerEvent) => {
        if ((e.target as HTMLElement | null)?.closest('.context-menu')) return;
        setCtxMenu(null);
      };
      window.addEventListener('tg-close-stage-ctx', onCloseStage);
      document.addEventListener('pointerdown', onPointerDown, true);
      return () => {
        window.removeEventListener('tg-close-stage-ctx', onCloseStage);
        document.removeEventListener('pointerdown', onPointerDown, true);
      };
    }, []);

    // Stage ResizeObserver
    useEffect(() => {
      const el = stageRef.current;
      if (!el) return;
      const ro = new ResizeObserver(() => setStageW(el.clientWidth || window.innerWidth));
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    // Prefetch trigraphs from Rust tg-core whenever document changes
    useEffect(() => {
      let cancelled = false;
      void prefetchTrigraphCache(tg, getPlatformBridge()).then(() => {
        if (!cancelled) setTrigraphTick((n) => n + 1);
      });
      return () => {
        cancelled = true;
      };
    }, [tg, docVersion]);

    // Compute ScoreLayout
    const layout = useMemo(() => {
      const sidePad = stageW < 480 ? 12 : stageW < 760 ? 24 : 56;
      const availableW = Math.max(260, stageW - sidePad);
      const effWidth = wrapMode === 'auto' ? Math.min(targetWidth, availableW) : targetWidth;
      return computeLayout(tg, {
        wrapMode,
        targetWidth: effWidth,
        hasAudio: Boolean(audioName && audioBuffer),
        showSpectrogram,
        tierOrder,
        scaleMode,
        tickPrecision,
        tickFixedDecimals,
        viewDomain,
        mode
      });
    }, [
      tg,
      trigraphTick,
      stageW,
      wrapMode,
      targetWidth,
      audioName,
      audioBuffer,
      showSpectrogram,
      tierOrder,
      scaleMode,
      tickPrecision,
      tickFixedDecimals,
      viewDomain,
      mode
    ]);

    // P1-4: Preserve visual screen anchor after boundary/point drag commit triggers elastic layout reflow
    useLayoutEffect(() => {
      const anchor = pendingDragAnchorRef.current;
      if (!anchor) return;
      pendingDragAnchorRef.current = null;
      const stageEl = stageRef.current;
      const svg = svgRef.current;
      if (!stageEl || !svg || layout.width <= 0 || layout.height <= 0) return;

      const updatedBand =
        layout.bands.find(
          (b) =>
            b.bandIndex === anchor.bandIndex &&
            anchor.time >= b.startT - 1e-9 &&
            anchor.time <= b.endT + 1e-9
        ) ??
        layout.bands.find(
          (b) => anchor.time >= b.startT - 1e-9 && anchor.time <= b.endT + 1e-9
        );
      if (!updatedBand) return;

      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const scaleX = rect.width / layout.width;
      const scaleY = rect.height / layout.height;
      const newSvgX = elasticXInBand(updatedBand, anchor.time);
      const newSvgY = (updatedBand.tiersTopY + updatedBand.tiersBottomY) / 2;
      const newClientX = rect.left + newSvgX * scaleX;
      const newClientY = rect.top + newSvgY * scaleY;
      const dx = newClientX - anchor.clientX;
      const dy = newClientY - anchor.clientY;
      if (Math.abs(dx) > 4) {
        stageEl.scrollLeft += dx;
      }
      if (Math.abs(dy) > 4) {
        stageEl.scrollTop += dy;
      }
    }, [layout]);

    useEffect(() => {
      setLayoutStore(layout);
    }, [layout, setLayoutStore]);

    // Render band spectrograms via Rust tg-dsp whenever layout/audio/maxFreq changes
    useEffect(() => {
      if (!analysis || !showSpectrogram || !audioName) {
        setSpecUrls(new Map());
        return;
      }
      let cancelled = false;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const bridge = getPlatformBridge();

      (async () => {
        const nextMap = new Map<number, string>();
        for (const band of layout.bands) {
          if (band.specH <= 0) continue;
          const segSig = band.linearSegs.map((s) => `${s.t0}:${s.t1}:${s.collapsed ? 1 : 0}`).join(',');
          const key = `${analysis.sessionId}|${maxFreq}|${Math.round(band.bandContentW)}|${band.specH}|${segSig}`;
          let url = specCacheRef.current.get(key);
          if (!url) {
            const segs = band.linearSegs.map((s) => ({
              x0: s.x0,
              x1: s.x1,
              t0: s.t0,
              t1: s.t1,
              collapsed: s.collapsed
            }));
            const rgbaRes = await bridge.renderSpectrogramRgba(
              analysis.sessionId,
              segs,
              band.originX,
              band.bandContentW,
              band.specH,
              maxFreq,
              dpr,
              52,
              'warm'
            );
            url = rgbaToPngDataUrl(rgbaRes.width, rgbaRes.height, rgbaRes.rgba);
            if (url) specCacheRef.current.set(key, url);
          }
          if (url) nextMap.set(band.bandIndex, url);
        }
        if (!cancelled) setSpecUrls(nextMap);
      })();

      return () => {
        cancelled = true;
      };
    }, [analysis, showSpectrogram, audioName, layout, maxFreq]);

    // Render full SVG whenever structural layout or spectrograms change
    useEffect(() => {
      const svg = svgRef.current;
      if (!svg) return;
      renderScoreSvg(svg, {
        tg,
        layout,
        hasAudio: Boolean(audioName && audioBuffer),
        audioBuffer,
        audioOffset,
        analysis,
        maxFreq,
        mode,
        selection,
        playRange,
        currentTime,
        showPlayhead,
        dragPreview,
        screenSpecUrls: specUrls
      });
    }, [tg, layout, audioName, audioBuffer, audioOffset, analysis, maxFreq, mode, specUrls]);

    // Fast overlay-only updates for playhead, selection, and boundary drag
    useEffect(() => {
      const svg = svgRef.current;
      if (!svg) return;
      const layer = svg.querySelector('#selection-playhead-layer');
      renderInteractiveOverlay(layer, layout, {
        selection,
        playRange,
        currentTime,
        showPlayhead,
        dragPreview,
        hasAudio: Boolean(audioName && audioBuffer)
      });
    }, [layout, selection, playRange, currentTime, showPlayhead, dragPreview, audioName, audioBuffer]);

    // Cloak underlying SVG text while inline-editing so text never bleeds/doubles behind <textarea>
    useEffect(() => {
      const svg = svgRef.current;
      if (!svg) return;
      svg.querySelectorAll('.editing-cloak').forEach((n) => n.classList.remove('editing-cloak'));
      if (!inlineTarget) return;

      const nodesToCloak: Element[] = [];
      if (inlineTarget.kind === 'interval') {
        const gs = svg.querySelectorAll(
          `[data-role="interval"][data-tier="${inlineTarget.tierIndex}"][data-idx="${inlineTarget.itemIndex}"] [data-text-node]`
        );
        gs.forEach((n) => nodesToCloak.push(n));
      } else if (inlineTarget.kind === 'point') {
        const gs = svg.querySelectorAll(
          `[data-role="point"][data-tier="${inlineTarget.tierIndex}"][data-idx="${inlineTarget.itemIndex}"] [data-text-node]`
        );
        gs.forEach((n) => nodesToCloak.push(n));
      } else if (inlineTarget.kind === 'tier-name') {
        const n = svg.querySelector(`[data-tier-name-node="${inlineTarget.tierIndex}"]`);
        if (n) nodesToCloak.push(n);
      }
      nodesToCloak.forEach((n) => n.classList.add('editing-cloak'));
      return () => {
        nodesToCloak.forEach((n) => n.classList.remove('editing-cloak'));
      };
    }, [inlineTarget, tg, layout, specUrls, mode]);

    // Auto-resize inline <textarea> height cleanly as multi-line content grows
    useLayoutEffect(() => {
      const el = inlineRef.current;
      if (!el || !inlineTarget || !inlineBox) return;
      el.style.height = 'auto';
      el.style.height = `${Math.max(Math.round(inlineBox.h), el.scrollHeight + 2)}px`;
    }, [inlineTarget, inlineVal, inlineBox]);

    // Smooth Ctrl/Meta + Wheel horizontal zoom over #stage (preserves cursor anchor!)
    useEffect(() => {
      const stageEl = stageRef.current;
      if (!stageEl) return;
      let pendingZoom: { relX: number; pointerInStage: number } | null = null;
      let zoomRaf = 0;

      const onWheel = (e: WheelEvent) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const sheetEl = sheetRef.current;
        if (!sheetEl) return;

        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const stageRect = stageEl.getBoundingClientRect();
        const sheetRect = sheetEl.getBoundingClientRect();
        const pointerInStage = e.clientX - stageRect.left;
        const oldSheetW = Math.max(1, sheetEl.offsetWidth);
        const relX = Math.max(0, Math.min(1, (e.clientX - sheetRect.left) / oldSheetW));

        const st = useEditorStore.getState();
        const curStageW = stageEl.clientWidth || window.innerWidth;
        const sidePad = curStageW < 480 ? 12 : curStageW < 760 ? 24 : 56;
        const availW = Math.max(260, curStageW - sidePad);
        const curW = st.wrapMode === 'auto' ? Math.min(st.targetWidth, availW) : st.targetWidth;
        const nextW = Math.round(curW * factor);

        let nextWrap = st.wrapMode;
        if (st.wrapMode === 'auto' && factor > 1 && nextW > availW) {
          nextWrap = 'single';
          setWrapMode('single');
        }
        const dom = st.viewDomain || { min: st.tg.xmin, max: st.tg.xmax };
        const dur = Math.max(
          0.1,
          (Number.isFinite(dom.max) ? dom.max : 1) - (Number.isFinite(dom.min) ? dom.min : 0)
        );
        const maxW =
          nextWrap === 'single' ? Math.max(4800, Math.min(18000, Math.round(dur * 600))) : 2400;
        setTargetWidth(Math.max(280, Math.min(maxW, nextW)));

        pendingZoom = { relX, pointerInStage };
        if (!zoomRaf) {
          zoomRaf = requestAnimationFrame(() => {
            zoomRaf = 0;
            const pz = pendingZoom;
            pendingZoom = null;
            if (pz && sheetRef.current && stageRef.current) {
              const newSheetW = sheetRef.current.offsetWidth;
              const sheetLeftInScroll = sheetRef.current.offsetLeft;
              stageRef.current.scrollLeft = Math.max(
                0,
                sheetLeftInScroll + pz.relX * newSheetW - pz.pointerInStage
              );
            }
          });
        }
      };

      stageEl.addEventListener('wheel', onWheel, { passive: false });
      return () => {
        stageEl.removeEventListener('wheel', onWheel);
        if (zoomRaf) cancelAnimationFrame(zoomRaf);
      };
    }, [setWrapMode, setTargetWidth]);

    const closeInline = useCallback(
      (commit: boolean) => {
        if (!inlineTarget) return;
        const tgt = inlineTarget;
        const finalVal = commit ? ipaIme.resolvePendingValue() : inlineVal;
        ipaIme.clearComposing();
        setInlineTarget(null);
        setInlineBox(null);

        if (commit) {
          void primeTrigraphString(finalVal, getPlatformBridge()).then(() =>
            setTrigraphTick((n) => n + 1)
          );
          if (tgt.kind === 'interval') {
            const cur = tg.tiers[tgt.tierIndex]?.intervals[tgt.itemIndex];
            if (cur && cur.text !== finalVal) {
              commitTgMutation((draft) => {
                draft.tiers[tgt.tierIndex].intervals[tgt.itemIndex].text = finalVal;
              });
            }
          } else if (tgt.kind === 'point') {
            const cur = tg.tiers[tgt.tierIndex]?.points[tgt.itemIndex];
            if (cur && cur.mark !== finalVal) {
              commitTgMutation((draft) => {
                draft.tiers[tgt.tierIndex].points[tgt.itemIndex].mark = finalVal;
              });
            }
          } else if (tgt.kind === 'tier-name') {
            const cur = tg.tiers[tgt.tierIndex];
            if (cur && cur.name !== finalVal) {
              commitTgMutation((draft) => {
                draft.tiers[tgt.tierIndex].name = finalVal;
              });
            }
          }
        }
      },
      [inlineTarget, inlineVal, ipaIme, tg, commitTgMutation]
    );
    closeInlineRef.current = closeInline;

    const clearHoverGuide = useCallback(() => {
      const hg = svgRef.current?.querySelector('#hover-guide-layer');
      if (hg) {
        while (hg.firstChild) hg.removeChild(hg.firstChild);
      }
    }, []);

    const openInline = useCallback(
      (tgt: InlineTarget, caretAtEnd = false) => {
        let box: (BoxRect & { align: 'center' | 'left' }) | null = null;
        let val = '';

        if (tgt.kind === 'interval') {
          const iv = tg.tiers[tgt.tierIndex]?.intervals[tgt.itemIndex];
          if (!iv) return;
          val = iv.text;
          for (const band of layout.bands) {
            const tl = band.tiersLayout[tgt.tierIndex];
            if (!tl) continue;
            const vi =
              tl.visibleIvs?.find((v) => v.iv.origIdx === tgt.itemIndex && !v.clippedLeft) ||
              tl.visibleIvs?.find((v) => v.iv.origIdx === tgt.itemIndex);
            if (vi) {
              const ly = tl.y + (tl.laneOffsets?.[vi.iv.lane] || 0);
              const lh = tl.laneHeights?.[vi.iv.lane] || tl.h;
              const w = Math.max(vi.w, 128);
              const x = Math.max(6, Math.min(layout.width - w - 6, vi.x0 + (vi.w - w) / 2));
              box = { x, y: ly, w, h: Math.max(lh, 28), align: 'center' };
              break;
            }
            const vz = tl.visibleZeros?.find((v) => v.iv.origIdx === tgt.itemIndex);
            if (vz) {
              const w = 110;
              box = {
                x: Math.max(6, Math.min(layout.width - w - 6, vz.x - w / 2)),
                y: tl.y + 3,
                w,
                h: Math.max(26, tl.h - 6),
                align: 'center'
              };
              break;
            }
          }
        } else if (tgt.kind === 'point') {
          const pt = tg.tiers[tgt.tierIndex]?.points[tgt.itemIndex];
          if (!pt) return;
          val = pt.mark;
          for (const band of layout.bands) {
            const tl = band.tiersLayout[tgt.tierIndex];
            if (!tl || tl.wireY === undefined) continue;
            const vp = tl.visiblePts?.find((v) => v.pt.origIdx === tgt.itemIndex);
            if (vp) {
              const w = Math.max(108, vp.boxW + 14);
              const h = Math.max(24, vp.boxH);
              const y = vp.rich && tl.levelY ? tl.y + tl.levelY[vp.level] : tl.wireY + 10;
              const centerX = vp.rich ? vp.bx + vp.boxW / 2 : vp.x;
              const x = Math.max(6, Math.min(layout.width - w - 6, centerX - w / 2));
              box = { x, y, w, h, align: 'center' };
              break;
            }
          }
        } else if (tgt.kind === 'tier-name') {
          const tier = tg.tiers[tgt.tierIndex];
          if (!tier) return;
          val = tier.name;
          const tl = layout.bands[0]?.tiersLayout[tgt.tierIndex];
          if (tl) {
            box = { ...tl.nameEditBox, w: Math.max(tl.nameEditBox.w, 108), align: 'left' };
          }
        }

        if (!box) return;
        clearHoverGuide();
        ipaIme.clearComposing();
        setInlineTarget(tgt);
        setInlineBox(box);
        setInlineVal(val);
        requestAnimationFrame(() => {
          const el = inlineRef.current;
          if (!el) return;
          el.focus();
          if (caretAtEnd) el.setSelectionRange(val.length, val.length);
          else el.select();
        });
      },
      [tg, layout, ipaIme, clearHoverGuide]
    );

    const insertTextIntoInline = useCallback(
      (sym: string, isTieBar = false) => {
        if (!inlineTarget || !inlineRef.current) {
          if (mode === 'edit' && selection) {
            if (selection.kind === 'interval' || selection.kind === 'point') {
              openInline(selection, true);
              setTimeout(() => {
                ipaIme.clearComposing();
                ipaIme.insertAtCaret(sym, isTieBar);
              }, 24);
            }
          } else {
            showToast('请先进入编辑模式并双击区间或标点');
          }
          return;
        }
        ipaIme.clearComposing();
        ipaIme.insertAtCaret(sym, isTieBar);
      },
      [inlineTarget, ipaIme, mode, selection, openInline, showToast]
    );

    const pruneSpecCacheForSession = useCallback((sessionId: number) => {
      const prefix = `${sessionId}|`;
      for (const key of Array.from(specCacheRef.current.keys())) {
        if (key.startsWith(prefix)) {
          specCacheRef.current.delete(key);
        }
      }
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        insertIpaSymbol: insertTextIntoInline,
        pruneSpecCacheForSession,
        flushInlineEdit: () => closeInlineRef.current(true)
      }),
      [insertTextIntoInline, pruneSpecCacheForSession]
    );

    const scrollSelectionIntoStageView = useCallback(
      (sel: EditorSelection) => {
        const anchor = getSelectionAnchorRect(layout, sel);
        const stageEl = stageRef.current;
        const sheetEl = sheetRef.current;
        if (!anchor || !stageEl || !sheetEl) return;
        const sheetRect = sheetEl.getBoundingClientRect();
        const stageRect = stageEl.getBoundingClientRect();
        const elemLeft = sheetRect.left + anchor.x;
        const elemRight = elemLeft + anchor.w;
        const elemTop = sheetRect.top + anchor.y;
        const elemBottom = elemTop + anchor.h;
        const padX = 48;
        const padY = 48;
        if (elemLeft < stageRect.left + padX) {
          stageEl.scrollLeft += elemLeft - (stageRect.left + padX);
        } else if (elemRight > stageRect.right - padX) {
          stageEl.scrollLeft += elemRight - (stageRect.right - padX);
        }
        if (elemTop < stageRect.top + padY) {
          stageEl.scrollTop += elemTop - (stageRect.top + padY);
        } else if (elemBottom > stageRect.bottom - padY) {
          stageEl.scrollTop += elemBottom - (stageRect.bottom - padY);
        }
      },
      [layout]
    );

    const findBestVisibleItemInTier = useCallback(
      (tierIndex: number, refT: number): EditorSelection => {
        const tier = tg.tiers[tierIndex];
        if (!tier) return null;
        if (tier.kind === 'intervalTier') {
          let containing: { itemIndex: number; bandIndex: number; clippedLeft: boolean } | null = null;
          let nearest: { itemIndex: number; bandIndex: number } | null = null;
          let nearestDist = Infinity;
          for (const band of layout.bands) {
            const tl = band.tiersLayout[tierIndex];
            if (!tl) continue;
            for (const vi of tl.visibleIvs || []) {
              const iv = vi.iv;
              if (refT >= iv.xmin && refT <= iv.xmax) {
                if (!containing || (!vi.clippedLeft && containing.clippedLeft)) {
                  containing = { itemIndex: iv.origIdx, bandIndex: band.bandIndex, clippedLeft: vi.clippedLeft };
                }
              }
              const d = Math.abs((iv.xmin + iv.xmax) / 2 - refT);
              if (d < nearestDist) {
                nearestDist = d;
                nearest = { itemIndex: iv.origIdx, bandIndex: band.bandIndex };
              }
            }
            for (const vz of tl.visibleZeros || []) {
              const d = Math.abs(vz.iv.xmin - refT);
              if (d < nearestDist) {
                nearestDist = d;
                nearest = { itemIndex: vz.iv.origIdx, bandIndex: band.bandIndex };
              }
            }
          }
          if (containing) {
            return { kind: 'interval', tierIndex, itemIndex: containing.itemIndex, bandIndex: containing.bandIndex };
          }
          return nearest ? { kind: 'interval', tierIndex, itemIndex: nearest.itemIndex, bandIndex: nearest.bandIndex } : null;
        }
        let nearest: { itemIndex: number; bandIndex: number } | null = null;
        let nearestDist = Infinity;
        for (const band of layout.bands) {
          const tl = band.tiersLayout[tierIndex];
          if (!tl) continue;
          for (const vp of tl.visiblePts || []) {
            const d = Math.abs(vp.pt.number - refT);
            if (d < nearestDist) {
              nearestDist = d;
              nearest = { itemIndex: vp.pt.origIdx, bandIndex: band.bandIndex };
            }
          }
        }
        return nearest ? { kind: 'point', tierIndex, itemIndex: nearest.itemIndex, bandIndex: nearest.bandIndex } : null;
      },
      [tg, layout]
    );

    const selectInitialItemForKeyboard = useCallback(() => {
      if (!layout.bands.length) return;
      const order = layout.bands[0].displayOrder;
      const refT = Number.isFinite(currentTime) ? currentTime : Number.isFinite(tg.xmin) ? tg.xmin : 0;
      for (const ti of order) {
        const hit = findBestVisibleItemInTier(ti, refT);
        if (hit) {
          setSelection(hit);
          if (hit.kind === 'interval') {
            const iv = tg.tiers[hit.tierIndex]?.intervals[hit.itemIndex];
            if (iv) lastNavTimeRef.current = (iv.xmin + iv.xmax) / 2;
          } else if (hit.kind === 'point') {
            const pt = tg.tiers[hit.tierIndex]?.points[hit.itemIndex];
            if (pt) lastNavTimeRef.current = pt.number;
          }
          scrollSelectionIntoStageView(hit);
          return;
        }
      }
      if (order.length > 0) {
        const fallback: EditorSelection = { kind: 'tier', tierIndex: order[0], bandIndex: 0 };
        setSelection(fallback);
        scrollSelectionIntoStageView(fallback);
      }
    }, [layout, currentTime, tg, findBestVisibleItemInTier, setSelection, scrollSelectionIntoStageView]);

    const stepSelection = useCallback(
      (
        dir: -1 | 1,
        axis: 'x' | 'y',
        openAfter: boolean,
        baseSel?: EditorSelection | InlineTarget
      ) => {
        const cur = baseSel ?? selection;
        if (!layout.bands.length) return;
        if (!cur) {
          selectInitialItemForKeyboard();
          return;
        }
        const order = layout.bands[0].displayOrder;

        if (axis === 'x') {
          if (cur.kind === 'tier-name') {
            const pos = order.indexOf(cur.tierIndex);
            const nextPos = pos + dir;
            if (nextPos < 0 || nextPos >= order.length) return;
            const nextTi = order[nextPos];
            const nextSel: EditorSelection = { kind: 'tier', tierIndex: nextTi, bandIndex: 0 };
            setSelection(nextSel);
            scrollSelectionIntoStageView(nextSel);
            if (openAfter) openInline({ kind: 'tier-name', tierIndex: nextTi });
            return;
          }
          if (cur.kind === 'tier') {
            const best = findBestVisibleItemInTier(cur.tierIndex, lastNavTimeRef.current);
            if (!best) return;
            setSelection(best);
            scrollSelectionIntoStageView(best);
            if (openAfter && (best.kind === 'interval' || best.kind === 'point')) openInline(best);
            return;
          }
          if (cur.kind !== 'interval' && cur.kind !== 'point') return;
          const tier = tg.tiers[cur.tierIndex];
          if (!tier) return;
          const len = cur.kind === 'interval' ? tier.intervals.length : tier.points.length;
          let nextIdx = cur.itemIndex + dir;
          while (nextIdx >= 0 && nextIdx < len) {
            let foundBand = -1;
            for (const band of layout.bands) {
              const tl = band.tiersLayout[cur.tierIndex];
              if (!tl) continue;
              if (cur.kind === 'interval') {
                if (
                  tl.visibleIvs?.some((v) => v.iv.origIdx === nextIdx) ||
                  tl.visibleZeros?.some((v) => v.iv.origIdx === nextIdx)
                ) {
                  foundBand = band.bandIndex;
                  break;
                }
              } else if (tl.visiblePts?.some((v) => v.pt.origIdx === nextIdx)) {
                foundBand = band.bandIndex;
                break;
              }
            }
            if (foundBand !== -1) {
              const nextSel: EditorSelection = {
                kind: cur.kind,
                tierIndex: cur.tierIndex,
                itemIndex: nextIdx,
                bandIndex: foundBand
              };
              if (cur.kind === 'interval') {
                const iv = tier.intervals[nextIdx];
                if (iv) lastNavTimeRef.current = (iv.xmin + iv.xmax) / 2;
              } else {
                const pt = tier.points[nextIdx];
                if (pt) lastNavTimeRef.current = pt.number;
              }
              setSelection(nextSel);
              scrollSelectionIntoStageView(nextSel);
              if (openAfter) openInline({ kind: cur.kind, tierIndex: cur.tierIndex, itemIndex: nextIdx });
              return;
            }
            nextIdx += dir;
          }
          return;
        }

        // axis === 'y'
        const curTierIdx =
          cur.kind === 'interval' ||
          cur.kind === 'point' ||
          cur.kind === 'tier' ||
          cur.kind === 'tier-name' ||
          cur.kind === 'boundary'
            ? cur.tierIndex
            : order[0];

        if (cur.kind === 'tier' || cur.kind === 'tier-name') {
          const pos = order.indexOf(curTierIdx);
          const nextPos = pos + dir;
          if (nextPos < 0 || nextPos >= order.length) return;
          const nextTi = order[nextPos];
          const nextSel: EditorSelection = { kind: 'tier', tierIndex: nextTi, bandIndex: 0 };
          setSelection(nextSel);
          scrollSelectionIntoStageView(nextSel);
          if (openAfter) openInline({ kind: 'tier-name', tierIndex: nextTi });
          return;
        }

        let refT = lastNavTimeRef.current;
        if (cur.kind === 'interval') {
          const iv = tg.tiers[cur.tierIndex]?.intervals[cur.itemIndex];
          if (iv) refT = (iv.xmin + iv.xmax) / 2;
        } else if (cur.kind === 'point') {
          const pt = tg.tiers[cur.tierIndex]?.points[cur.itemIndex];
          if (pt) refT = pt.number;
        } else if (cur.kind === 'boundary' || cur.kind === 'spine') {
          refT = cur.time;
        }
        lastNavTimeRef.current = refT;

        const curPos = order.indexOf(curTierIdx);
        for (let pos = curPos + dir; pos >= 0 && pos < order.length; pos += dir) {
          const nextTi = order[pos];
          const best = findBestVisibleItemInTier(nextTi, refT);
          if (best) {
            setSelection(best);
            scrollSelectionIntoStageView(best);
            if (openAfter && (best.kind === 'interval' || best.kind === 'point')) {
              openInline({ kind: best.kind, tierIndex: best.tierIndex, itemIndex: best.itemIndex });
            }
            return;
          }
          if (!openAfter) {
            const fallbackSel: EditorSelection = { kind: 'tier', tierIndex: nextTi, bandIndex: 0 };
            setSelection(fallbackSel);
            scrollSelectionIntoStageView(fallbackSel);
            return;
          }
        }
      },
      [
        selection,
        layout,
        tg,
        setSelection,
        openInline,
        selectInitialItemForKeyboard,
        findBestVisibleItemInTier,
        scrollSelectionIntoStageView
      ]
    );
    stepSelectionRef.current = stepSelection;

    // Global keyboard shortcuts & 2D navigation
    useEffect(() => {
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.code === 'KeyZ' && !e.ctrlKey && !e.metaKey) zKeyDownRef.current = true;
        if (e.key === 'Alt') altKeyDownRef.current = true;

        const tag = (document.activeElement?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (
          exportOpen ||
          document.querySelector('.modal-backdrop.open, .unsaved-backdrop')
        ) {
          return;
        }

        if (
          mode === 'edit' &&
          (((e.ctrlKey || e.metaKey) && (e.key === '\\' || e.code === 'Backslash')) ||
            (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyI'))
        ) {
          e.preventDefault();
          cycleIpaMode();
          return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
          if (mode !== 'edit') return;
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
          if (mode !== 'edit') return;
          e.preventDefault();
          redo();
          return;
        }
        if (e.code === 'Space' || e.key === ' ') {
          e.preventDefault();
          if (document.activeElement instanceof HTMLButtonElement) {
            document.activeElement.blur();
          }
          onTogglePlay();
          return;
        }
        if (e.key === 'Escape') {
          setCtxMenu(null);
          setSelection(null);
          setPlayRange(null);
          return;
        }

        if (e.ctrlKey || e.metaKey) return;

        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const dir: -1 | 1 = e.key === 'ArrowLeft' ? -1 : 1;
          if (
            mode === 'edit' &&
            e.shiftKey &&
            selection &&
            (selection.kind === 'boundary' || selection.kind === 'point')
          ) {
            // Shift+Left/Right micro-nudge boundary or point by ±10 ms (±1 ms with Alt)
            const stepSec = e.altKey ? 0.001 : 0.01;
            if (selection.kind === 'boundary') {
              const newT = Number((selection.time + dir * stepSec).toFixed(6));
              if (moveTierBoundary(selection.tierIndex, selection.time, newT, false)) {
                setSelection({
                  kind: 'boundary',
                  tierIndex: selection.tierIndex,
                  time: newT,
                  bandIndex: selection.bandIndex
                });
              }
            } else {
              const tier = tg.tiers[selection.tierIndex];
              const pt = tier?.points[selection.itemIndex];
              if (tier && pt) {
                const newT = Number(
                  Math.max(tier.xmin, Math.min(tier.xmax, pt.number + dir * stepSec)).toFixed(6)
                );
                if (tier.points.some((p, i) => i !== selection.itemIndex && p.number === newT)) {
                  showToast('目标时刻已存在标点', true);
                } else if (Math.abs(newT - pt.number) > 1e-9) {
                  let newIdx = selection.itemIndex;
                  commitTgMutation((draft) => {
                    const dTier = draft.tiers[selection.tierIndex];
                    const targetPt = dTier.points[selection.itemIndex];
                    if (!targetPt) return;
                    targetPt.number = newT;
                    dTier.points.sort((a, b) => a.number - b.number);
                    newIdx = dTier.points.indexOf(targetPt);
                  });
                  setSelection({
                    kind: 'point',
                    tierIndex: selection.tierIndex,
                    itemIndex: Math.max(0, newIdx),
                    bandIndex: selection.bandIndex
                  });
                }
              }
            }
          } else {
            stepSelection(dir, 'x', false);
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          stepSelection(-1, 'y', false);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          stepSelection(1, 'y', false);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          stepSelection(e.shiftKey ? -1 : 1, 'x', false);
        } else if (e.key === 'Enter' && !e.shiftKey && selection) {
          if (mode === 'edit') {
            if (selection.kind === 'interval' || selection.kind === 'point') {
              e.preventDefault();
              openInline(selection);
            } else if (selection.kind === 'tier') {
              e.preventDefault();
              openInline({ kind: 'tier-name', tierIndex: selection.tierIndex });
            }
          } else if (mode === 'read') {
            if (selection.kind === 'interval') {
              const iv = tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex];
              if (iv && iv.xmax > iv.xmin) {
                e.preventDefault();
                setPlayRange({ start: iv.xmin, end: iv.xmax });
                onStartPlayback(iv.xmin, iv.xmax);
              }
            } else if (selection.kind === 'point') {
              const pt = tg.tiers[selection.tierIndex]?.points[selection.itemIndex];
              if (pt) {
                e.preventDefault();
                setPlayRange(null);
                onStartPlayback(pt.number, tg.xmax);
              }
            }
          }
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && mode === 'edit' && selection) {
          if (selection.kind === 'point') {
            e.preventDefault();
            commitTgMutation((draft) => {
              draft.tiers[selection.tierIndex].points.splice(selection.itemIndex, 1);
            }, null);
          } else if (selection.kind === 'boundary') {
            e.preventDefault();
            deleteBoundaryAt(selection.tierIndex, selection.time);
          }
        }
      };
      const onKeyUp = (e: KeyboardEvent) => {
        if (e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z') zKeyDownRef.current = false;
        if (e.key === 'Alt') altKeyDownRef.current = false;
      };
      const onBlur = () => {
        zKeyDownRef.current = false;
        altKeyDownRef.current = false;
      };
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);
      return () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('blur', onBlur);
      };
    }, [
      mode,
      exportOpen,
      selection,
      tg,
      undo,
      redo,
      cycleIpaMode,
      onTogglePlay,
      onStartPlayback,
      setSelection,
      setPlayRange,
      stepSelection,
      openInline,
      commitTgMutation,
      deleteBoundaryAt,
      moveTierBoundary,
      showToast
    ]);

    const svgPointFromEvent = (e: { clientX: number; clientY: number }) => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * layout.width,
        y: ((e.clientY - rect.top) / Math.max(1, rect.height)) * layout.height
      };
    };

    const maybeAutoOpenInspector = useCallback(() => {
      const st = useEditorStore.getState();
      if (
        st.mode === 'edit' &&
        st.autoOpenInspectorOnSelect &&
        st.editInspectorMode === 'sidebar'
      ) {
        if (!st.sidebarOpen) {
          st.setSidebarTab('inspector');
          st.setSidebarOpen(true);
        } else if (st.sidebarTab === 'tiers') {
          st.setSidebarTab('inspector');
        }
      }
    }, []);

    const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
      clearHoverGuide();
      if (draggingRef.current || inlineTarget) return;
      const hg = svgRef.current?.querySelector('#hover-guide-layer');
      if (!hg) return;
      const target = (e.target as Element).closest('[data-role]') as SVGElement | null;
      if (!target) return;

      const role = target.getAttribute('data-role');
      const bandIdx = parseInt(target.getAttribute('data-band') || '0', 10);
      const band = layout.bands[bandIdx];
      if (!band) return;
      const pt = svgPointFromEvent(e);

      const drawHoverNecks = (times: number[]) => {
        const anchorTopY = band.anchorH > 0 ? band.anchorY : band.linearY;
        const drawn: number[] = [];
        for (const t of times) {
          if (!Number.isFinite(t) || t < band.startT || t > band.endT) continue;
          if (drawn.some((prev) => Math.abs(prev - t) <= 1e-12)) continue;
          drawn.push(t);
          const lx = band.linearXForTime(t);
          const ex = elasticXInBand(band, t);
          svgEl(
            'path',
            {
              d: `M${lx},${anchorTopY} L${lx},${band.neckTopY} L${ex},${band.neckBotY}`,
              fill: 'none',
              stroke: '#1D4ED8',
              'stroke-width': 1.35,
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round',
              opacity: 0.72
            },
            hg
          );
        }
      };

      if (role === 'spec-area') {
        const clampedX = Math.max(band.originX, Math.min(band.originX + band.bandContentW, pt.x));
        const nearBnd =
          mode === 'edit' ? findNearbySpecBoundary(tg, selection, band, clampedX) : null;
        target.style.cursor = nearBnd ? 'ew-resize' : '';
        const aimX = nearBnd ? nearBnd.x : clampedX;
        const t = nearBnd ? nearBnd.time : timeFromLinearX(band, clampedX);
        const ex = elasticXInBand(band, t);
        const gapY = Math.max(band.specY + 14, Math.min(band.specY + band.specH - 14, pt.y));
        const strokeC = nearBnd ? '#1D4ED8' : '#141413';
        const op = nearBnd ? 0.85 : 0.48;

        // Hollow-gap crosshair inside spectrogram (never obscures inspected acoustic pixel)
        svgEl('line', { x1: aimX, y1: band.waveY, x2: aimX, y2: Math.max(band.specY, gapY - 14), stroke: strokeC, 'stroke-width': nearBnd ? 1.4 : 0.9, opacity: op }, hg);
        svgEl('line', { x1: aimX, y1: Math.min(band.specY + band.specH, gapY + 14), x2: aimX, y2: band.neckTopY, stroke: strokeC, 'stroke-width': nearBnd ? 1.4 : 0.9, opacity: op }, hg);
        svgEl('line', { x1: aimX - 7, y1: gapY, x2: aimX - 3, y2: gapY, stroke: strokeC, 'stroke-width': 1, opacity: op }, hg);
        svgEl('line', { x1: aimX + 3, y1: gapY, x2: aimX + 7, y2: gapY, stroke: strokeC, 'stroke-width': 1, opacity: op }, hg);
        svgEl('path', {
          d: `M${aimX},${band.neckTopY} L${ex},${band.neckBotY} L${ex},${band.tiersBottomY}`,
          fill: 'none',
          stroke: strokeC,
          'stroke-width': nearBnd ? 1.3 : 0.85,
          opacity: op * 0.85,
          'stroke-dasharray': nearBnd ? 'none' : '2 2'
        }, hg);

        // Live t (s) · f (Hz) readout badge inside top of spectrogram
        const freqHz = Math.round(
          Math.max(0, Math.min(maxFreq, (1 - (pt.y - band.specY) / Math.max(1, band.specH)) * maxFreq))
        );
        const readoutTxt = nearBnd
          ? `${formatPraatDouble(t)} s · 拖拽边界`
          : `${t.toFixed(3)} s · ${freqHz} Hz`;
        const rw = Math.ceil(measurePx(readoutTxt, `9.5px ${MONO_FONT_STACK}`)) + 10;
        const rightBound = band.originX + band.bandContentW - 4;
        const rx = aimX + 8 + rw <= rightBound ? aimX + 8 : Math.max(band.originX + 4, aimX - rw - 8);
        const ry = band.specY + 4;
        svgEl('rect', {
          x: rx,
          y: ry,
          width: rw,
          height: 15,
          fill: nearBnd ? '#1D4ED8' : '#FFFFFF',
          'fill-opacity': nearBnd ? '0.92' : '0.88',
          stroke: nearBnd ? '#1D4ED8' : '#C8C4BA',
          'stroke-width': '0.7'
        }, hg);
        svgEl('text', {
          x: rx + rw / 2,
          y: ry + 10.5,
          'text-anchor': 'middle',
          'font-family': MONO_FONT_STACK,
          'font-size': '9.5',
          fill: nearBnd ? '#FFFFFF' : '#141413'
        }, hg).textContent = readoutTxt;
      } else if (role === 'linear-bar') {
        const clampedX = Math.max(band.originX, Math.min(band.originX + band.bandContentW, pt.x));
        const t = timeFromLinearX(band, clampedX);
        const ex = elasticXInBand(band, t);
        svgEl('path', {
          d: `M${clampedX},${band.linearY} L${clampedX},${band.neckTopY} L${ex},${band.neckBotY} L${ex},${band.tiersBottomY}`,
          fill: 'none',
          stroke: '#141413',
          'stroke-width': 0.9,
          opacity: 0.35,
          'stroke-dasharray': '2 2'
        }, hg);

        const readoutTxt = `${t.toFixed(3)} s`;
        const rw = Math.ceil(measurePx(readoutTxt, `9.5px ${MONO_FONT_STACK}`)) + 8;
        const rightBound = band.originX + band.bandContentW - 4;
        const rx = clampedX + 6 + rw <= rightBound ? clampedX + 6 : Math.max(band.originX + 4, clampedX - rw - 6);
        const ry = Math.max(2, band.linearY + 2);
        svgEl('rect', {
          x: rx,
          y: ry,
          width: rw,
          height: 14,
          fill: '#FFFFFF',
          'fill-opacity': '0.88',
          stroke: '#C8C4BA',
          'stroke-width': '0.65'
        }, hg);
        svgEl('text', {
          x: rx + rw / 2,
          y: ry + 10,
          'text-anchor': 'middle',
          'font-family': MONO_FONT_STACK,
          'font-size': '9.5',
          fill: '#141413'
        }, hg).textContent = readoutTxt;
      } else if (role === 'texttier-wire' && mode === 'edit') {
        const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
        const tl = band.tiersLayout[ti];
        if (!tl || tl.wireY === undefined) return;
        const clampedX = Math.max(band.originX, Math.min(band.originX + band.bandContentW, pt.x));
        svgEl('line', {
          x1: clampedX,
          y1: tl.y,
          x2: clampedX,
          y2: tl.y + tl.h,
          stroke: '#1D4ED8',
          'stroke-width': 0.8,
          opacity: 0.4,
          'stroke-dasharray': '2 2'
        }, hg);
        svgEl('polygon', {
          points: `${clampedX},${tl.wireY - 4} ${clampedX + 4},${tl.wireY} ${clampedX},${tl.wireY + 4} ${clampedX - 4},${tl.wireY}`,
          fill: '#EEF3FF',
          stroke: '#1D4ED8',
          'stroke-width': 1.2,
          opacity: 0.85
        }, hg);
      } else if (role === 'interval' && mode === 'edit' && e.shiftKey) {
        const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
        const tl = band.tiersLayout[ti];
        if (!tl) return;
        svgEl('line', {
          x1: pt.x,
          y1: tl.y,
          x2: pt.x,
          y2: tl.y + tl.h,
          stroke: '#1D4ED8',
          'stroke-width': 1.4,
          'stroke-dasharray': '3 2'
        }, hg);
      } else if (role === 'interval') {
        const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
        const ii = parseInt(target.getAttribute('data-idx') || '0', 10);
        const iv = tg.tiers[ti]?.intervals[ii];
        if (iv) drawHoverNecks([iv.xmin, iv.xmax]);
      } else if (role === 'boundary') {
        const t = parseFloat(target.getAttribute('data-time') || 'NaN');
        drawHoverNecks([t]);
      } else if (role === 'point') {
        const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
        const pi = parseInt(target.getAttribute('data-idx') || '0', 10);
        const ptItem = tg.tiers[ti]?.points[pi];
        if (ptItem) drawHoverNecks([ptItem.number]);
      }
    };

    const captureDragAnchor = (band: BandLayout, bandIdx: number, time: number) => {
      const svg = svgRef.current;
      if (!svg || layout.width <= 0 || layout.height <= 0) {
        pendingDragAnchorRef.current = null;
        return;
      }
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        pendingDragAnchorRef.current = null;
        return;
      }
      const scaleX = rect.width / layout.width;
      const scaleY = rect.height / layout.height;
      const svgX = elasticXInBand(band, time);
      const svgY = (band.tiersTopY + band.tiersBottomY) / 2;
      pendingDragAnchorRef.current = {
        time,
        bandIndex: bandIdx,
        clientX: rect.left + svgX * scaleX,
        clientY: rect.top + svgY * scaleY
      };
    };

    const startBoundaryDrag = (opts: {
      band: BandLayout;
      bandIdx: number;
      ti: number;
      origTime: number;
      shared: boolean;
      fromSpec: boolean;
      startClientX: number;
      startClientY: number;
    }) => {
      const { band, bandIdx, ti, origTime, shared, fromSpec, startClientX, startClientY } = opts;
      const tl = band.tiersLayout[ti];
      if (!tl) return;
      const y0 = shared ? band.tiersTopY : tl.y;
      const y1 = shared ? band.tiersBottomY : tl.y + tl.h;
      const { minAllowed, maxAllowed } = getBoundaryDragBounds(tg, ti, origTime, shared);

      setSelection({ kind: 'boundary', tierIndex: ti, time: origTime, bandIndex: bandIdx });
      maybeAutoOpenInspector();
      clearHoverGuide();
      draggingRef.current = true;

      let latestTime = origTime;
      let lastClientX = startClientX;
      let lastClientY = startClientY;
      let dragActive = true;
      let moveSeq = 0;

      const updateBoundaryAt = async (clientX: number, clientY: number) => {
        const seq = ++moveSeq;
        const curPt = svgPointFromEvent({ clientX, clientY });
        const rawT = fromSpec ? timeFromLinearX(band, curPt.x) : timeFromElasticX(band, curPt.x);
        let t = Math.max(minAllowed, Math.min(maxAllowed, rawT));
        let snapX: number | null = null;
        let snapMode = false;
        let snapLabel: string | null = null;
        let exactSnapped = false;

        if (zKeyDownRef.current && analysis) {
          const zt = await getPlatformBridge().findZeroCrossing(analysis.sessionId, t, 0.008);
          if (!dragActive || seq !== moveSeq) return;
          t = Math.max(minAllowed, Math.min(maxAllowed, zt));
          snapMode = true;
          snapLabel = '已吸附过零';
        } else if (!altKeyDownRef.current) {
          const hit = findCrossTierSnap(band, curPt.x, fromSpec, origTime, minAllowed, maxAllowed, 8);
          if (hit) {
            t = hit.t; // Keep EXACT floating-point equality with target tier!
            snapX = hit.x;
            snapMode = true;
            snapLabel = '边界对齐';
            exactSnapped = true;
          }
        }

        if (!dragActive || seq !== moveSeq) return;
        latestTime = exactSnapped
          ? t
          : Math.max(minAllowed, Math.min(maxAllowed, Number(t.toFixed(6))));
        const x = snapX !== null ? snapX : elasticXInBand(band, latestTime);
        const linX = band.linearXForTime(latestTime);
        const loupeVisible = Boolean(audioBuffer && showMicroLoupe);

        setDragPreview({
          bandIndex: bandIdx,
          x,
          linearX: linX,
          y0,
          y1,
          cursorY: fromSpec ? curPt.y : undefined,
          snapX,
          snapMode,
          snapLabel,
          showCompactTag: !loupeVisible,
          time: latestTime
        });
        if (loupeVisible) {
          setLoupeAnchor({
            centerT: latestTime,
            anchorX: fromSpec ? linX : x,
            anchorTopY: fromSpec ? band.waveY : y0,
            anchorBottomY: fromSpec ? band.neckTopY : y1,
            snapLabel
          });
        }
      };

      if (audioBuffer && showMicroLoupe) {
        const initX = fromSpec ? band.linearXForTime(origTime) : elasticXInBand(band, origTime);
        setLoupeAnchor({
          centerT: origTime,
          anchorX: initX,
          anchorTopY: fromSpec ? band.waveY : y0,
          anchorBottomY: fromSpec ? band.neckTopY : y1,
          snapLabel: zKeyDownRef.current && analysis ? '已吸附过零' : null
        });
      }

      const onMove = (ev: PointerEvent) => {
        lastClientX = ev.clientX;
        lastClientY = ev.clientY;
        altKeyDownRef.current = ev.altKey;
        void updateBoundaryAt(ev.clientX, ev.clientY);
      };
      const onModKey = (ev: KeyboardEvent) => {
        if (ev.code === 'KeyZ' || ev.key === 'z' || ev.key === 'Z') {
          zKeyDownRef.current = ev.type === 'keydown';
          void updateBoundaryAt(lastClientX, lastClientY);
        } else if (ev.key === 'Alt') {
          ev.preventDefault();
          altKeyDownRef.current = ev.type === 'keydown';
          void updateBoundaryAt(lastClientX, lastClientY);
        }
      };
      const cleanup = (commit: boolean) => {
        if (!dragActive) return;
        dragActive = false;
        draggingRef.current = false;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onModKey);
        window.removeEventListener('keyup', onModKey);
        window.removeEventListener('blur', onCancel);
        setDragPreview(null);
        setLoupeAnchor(null);
        if (commit && Math.abs(latestTime - origTime) > 1e-9) {
          captureDragAnchor(band, bandIdx, latestTime);
          if (moveTierBoundary(ti, origTime, latestTime, shared)) {
            setSelection({ kind: 'boundary', tierIndex: ti, time: latestTime, bandIndex: bandIdx });
          } else {
            pendingDragAnchorRef.current = null;
          }
        }
      };
      const onUp = () => cleanup(true);
      const onCancel = () => cleanup(false);

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onModKey);
      window.addEventListener('keyup', onModKey);
      window.addEventListener('blur', onCancel);
    };

    const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.button !== 0) return;
      setCtxMenu(null);
      if (inlineTarget) closeInline(true);
      altKeyDownRef.current = e.altKey;

      const el = (e.target as Element).closest('[data-role]');
      if (!el) {
        setSelection(null);
        setPlayRange(null);
        return;
      }

      const role = el.getAttribute('data-role');
      const bandIdx = parseInt(el.getAttribute('data-band') || '0', 10);
      const band = layout.bands[bandIdx];
      const pt = svgPointFromEvent(e);

      if (role === 'boundary' && mode === 'edit' && band) {
        e.preventDefault();
        const ti = parseInt(el.getAttribute('data-tier') || '0', 10);
        const origTime = parseFloat(el.getAttribute('data-time') || '0');
        startBoundaryDrag({
          band,
          bandIdx,
          ti,
          origTime,
          shared: e.shiftKey,
          fromSpec: false,
          startClientX: e.clientX,
          startClientY: e.clientY
        });
        return;
      }

      if (role === 'point' && band) {
        const ti = parseInt(el.getAttribute('data-tier') || '0', 10);
        const pi = parseInt(el.getAttribute('data-idx') || '0', 10);
        setSelection({ kind: 'point', tierIndex: ti, itemIndex: pi, bandIndex: bandIdx });
        if (mode !== 'edit') return;
        maybeAutoOpenInspector();

        const origPt = tg.tiers[ti]?.points[pi];
        if (!origPt) return;
        const startX = e.clientX;
        let moved = false;
        let latestTime = origPt.number;
        let lastClientX = e.clientX;
        let lastClientY = e.clientY;
        let dragActive = true;
        let moveSeq = 0;
        const tl = band.tiersLayout[ti];
        const tierMin = tg.tiers[ti].xmin;
        const tierMax = tg.tiers[ti].xmax;

        const updatePointAt = async (clientX: number, clientY: number) => {
          const seq = ++moveSeq;
          const curPt = svgPointFromEvent({ clientX, clientY });
          let t = Math.max(tierMin, Math.min(tierMax, timeFromElasticX(band, curPt.x)));
          let snapX: number | null = null;
          let snapMode = false;
          let snapLabel: string | null = null;
          let exactSnapped = false;

          if (zKeyDownRef.current && analysis) {
            const zt = await getPlatformBridge().findZeroCrossing(analysis.sessionId, t, 0.008);
            if (!dragActive || seq !== moveSeq) return;
            t = Math.max(tierMin, Math.min(tierMax, zt));
            snapMode = true;
            snapLabel = '已吸附过零';
          } else if (!altKeyDownRef.current) {
            const hit = findCrossTierSnap(
              band,
              curPt.x,
              false,
              origPt.number,
              tierMin,
              tierMax,
              8,
              ti,
              origPt.number
            );
            if (hit) {
              t = hit.t; // EXACT floating-point equality with target tier!
              snapX = hit.x;
              snapMode = true;
              snapLabel = '边界对齐';
              exactSnapped = true;
            }
          }

          if (!dragActive || seq !== moveSeq) return;
          latestTime = exactSnapped
            ? t
            : Math.max(tierMin, Math.min(tierMax, Number(t.toFixed(6))));
          const x = snapX !== null ? snapX : elasticXInBand(band, latestTime);
          const loupeVisible = Boolean(audioBuffer && showMicroLoupe);

          setDragPreview({
            bandIndex: bandIdx,
            x,
            linearX: band.linearXForTime(latestTime),
            y0: tl.y,
            y1: tl.y + tl.h,
            cursorY: curPt.y,
            snapX,
            snapMode,
            snapLabel,
            showCompactTag: !loupeVisible,
            time: latestTime
          });
          if (loupeVisible) {
            setLoupeAnchor({
              centerT: latestTime,
              anchorX: x,
              anchorTopY: tl.y,
              anchorBottomY: tl.y + tl.h,
              snapLabel
            });
          }
        };

        const onMove = (ev: PointerEvent) => {
          lastClientX = ev.clientX;
          lastClientY = ev.clientY;
          altKeyDownRef.current = ev.altKey;
          if (!moved && Math.abs(ev.clientX - startX) < 4) return;
          if (!moved) {
            moved = true;
            draggingRef.current = true;
            clearHoverGuide();
          }
          void updatePointAt(ev.clientX, ev.clientY);
        };
        const onModKey = (ev: KeyboardEvent) => {
          if (ev.code === 'KeyZ' || ev.key === 'z' || ev.key === 'Z') {
            zKeyDownRef.current = ev.type === 'keydown';
            if (moved) void updatePointAt(lastClientX, lastClientY);
          } else if (ev.key === 'Alt') {
            ev.preventDefault();
            altKeyDownRef.current = ev.type === 'keydown';
            if (moved) void updatePointAt(lastClientX, lastClientY);
          }
        };
        const cleanup = (commit: boolean) => {
          if (!dragActive) return;
          dragActive = false;
          draggingRef.current = false;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
          window.removeEventListener('keydown', onModKey);
          window.removeEventListener('keyup', onModKey);
          window.removeEventListener('blur', onCancel);
          setDragPreview(null);
          setLoupeAnchor(null);
          if (commit && moved && Math.abs(latestTime - origPt.number) > 1e-9) {
            const tier = tg.tiers[ti];
            if (tier.points.some((p, i) => i !== pi && p.number === latestTime)) {
              showToast('目标时刻已存在标点', true);
              return;
            }
            captureDragAnchor(band, bandIdx, latestTime);
            let nextIdx = pi;
            commitTgMutation((draft) => {
              const dTier = draft.tiers[ti];
              const p = dTier.points[pi];
              if (!p) return;
              p.number = latestTime;
              dTier.points.sort((a, b) => a.number - b.number);
              nextIdx = dTier.points.indexOf(p);
            });
            setSelection({
              kind: 'point',
              tierIndex: ti,
              itemIndex: Math.max(0, nextIdx),
              bandIndex: bandIdx
            });
          }
        };
        const onUp = () => cleanup(true);
        const onCancel = () => cleanup(false);

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        window.addEventListener('keydown', onModKey);
        window.addEventListener('keyup', onModKey);
        window.addEventListener('blur', onCancel);
        return;
      }

      if (role === 'interval' && band) {
        const ti = parseInt(el.getAttribute('data-tier') || '0', 10);
        const ii = parseInt(el.getAttribute('data-idx') || '0', 10);
        const iv = tg.tiers[ti]?.intervals[ii];
        if (!iv) return;
        if (mode === 'edit' && e.shiftKey) {
          const splitT = timeFromElasticX(band, pt.x);
          splitInterval(ti, ii, splitT);
          return;
        }
        setSelection({ kind: 'interval', tierIndex: ti, itemIndex: ii, bandIndex: bandIdx });
        if (iv.xmax > iv.xmin) setPlayRange({ start: iv.xmin, end: iv.xmax });
        maybeAutoOpenInspector();
        return;
      }

      if (role === 'tier-header') {
        const ti = parseInt(el.getAttribute('data-tier') || '0', 10);
        if (mode === 'edit') {
          setSelection({ kind: 'tier', tierIndex: ti, bandIndex: bandIdx });
          maybeAutoOpenInspector();
        }
        return;
      }

      if (role === 'spine-tick') {
        const t = parseFloat(el.getAttribute('data-time') || '0');
        if (mode === 'edit') {
          setSelection({ kind: 'spine', time: t, bandIndex: bandIdx });
          maybeAutoOpenInspector();
        } else {
          setPlayRange(null);
          setPlaybackTime(t, true);
        }
        return;
      }

      if (role === 'texttier-wire' && mode === 'edit' && band) {
        const ti = parseInt(el.getAttribute('data-tier') || '0', 10);
        const clickT = timeFromElasticX(band, pt.x);
        const idx = addPointAt(ti, clickT);
        if (idx !== null) {
          maybeAutoOpenInspector();
          openInline({ kind: 'point', tierIndex: ti, itemIndex: idx });
        }
        return;
      }

      if ((role === 'linear-bar' || role === 'spec-area') && band) {
        e.preventDefault();
        // In edit mode, clicking directly on a nearby spectrogram boundary drags that boundary!
        if (role === 'spec-area' && mode === 'edit') {
          const hit = findNearbySpecBoundary(tg, selection, band, pt.x);
          if (hit) {
            startBoundaryDrag({
              band,
              bandIdx,
              ti: hit.tierIndex,
              origTime: hit.time,
              shared: e.shiftKey,
              fromSpec: true,
              startClientX: e.clientX,
              startClientY: e.clientY
            });
            return;
          }
        }

        clearHoverGuide();
        draggingRef.current = true;
        const t0 = Math.max(tg.xmin, Math.min(tg.xmax, timeFromLinearX(band, pt.x)));
        const startClientX = e.clientX;
        let dragged = false;
        let latestT = t0;

        setSelection(null);
        setPlaybackTime(t0, true);

        const resolveBandAtY = (y: number) => {
          for (const b of layout.bands) {
            if (y >= b.linearY - 12 && y <= b.tiersBottomY + 12) return b;
          }
          let best = band;
          let bestDist = Infinity;
          for (const b of layout.bands) {
            const cy = (b.linearY + b.tiersBottomY) * 0.5;
            const d = Math.abs(y - cy);
            if (d < bestDist) {
              bestDist = d;
              best = b;
            }
          }
          return best;
        };

        const onMove = (ev: PointerEvent) => {
          if (!dragged && Math.abs(ev.clientX - startClientX) < 4) return;
          dragged = true;
          const curPt = svgPointFromEvent(ev);
          const activeBand = resolveBandAtY(curPt.y);
          const t1 = Math.max(tg.xmin, Math.min(tg.xmax, timeFromLinearX(activeBand, curPt.x)));
          latestT = t1;
          const a = Math.min(t0, t1);
          const b = Math.max(t0, t1);
          if (b - a >= 0.001) {
            setPlayRange({ start: a, end: b });
            setPlaybackTime(a, true);
          }
        };

        const onUp = () => {
          draggingRef.current = false;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          if (!dragged || Math.abs(latestT - t0) < 0.001) {
            setPlayRange(null);
            setPlaybackTime(t0, true);
          } else {
            const a = Math.min(t0, latestT);
            const b = Math.max(t0, latestT);
            setPlayRange({ start: a, end: b });
            setPlaybackTime(a, true);
          }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      }
    };

    const handleSvgDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
      const el = (e.target as Element).closest('[data-role]');
      if (!el) return;
      const role = el.getAttribute('data-role');
      const ti = parseInt(el.getAttribute('data-tier') || '0', 10);
      const idx = parseInt(el.getAttribute('data-idx') || '0', 10);

      if (role === 'linear-bar' || role === 'spec-area') {
        const bandIdx = parseInt(el.getAttribute('data-band') || '0', 10);
        const band = layout.bands[bandIdx];
        if (!band) return;
        const pt = svgPointFromEvent(e);
        const t = Math.max(tg.xmin, Math.min(tg.xmax, timeFromLinearX(band, pt.x)));
        if (playRange && t >= playRange.start && t <= playRange.end) {
          onStartPlayback(playRange.start, playRange.end);
        } else {
          setPlayRange(null);
          onStartPlayback(t, tg.xmax);
        }
        return;
      }

      if (mode === 'read') {
        if (role === 'interval') {
          const iv = tg.tiers[ti]?.intervals[idx];
          if (iv && iv.xmax > iv.xmin) {
            setPlayRange({ start: iv.xmin, end: iv.xmax });
            onStartPlayback(iv.xmin, iv.xmax);
          }
        } else if (role === 'point') {
          const pt = tg.tiers[ti]?.points[idx];
          if (pt) {
            setPlayRange(null);
            onStartPlayback(pt.number, tg.xmax);
          }
        }
        return;
      }

      if (role === 'interval') openInline({ kind: 'interval', tierIndex: ti, itemIndex: idx });
      else if (role === 'point') openInline({ kind: 'point', tierIndex: ti, itemIndex: idx });
      else if (role === 'tier-header') openInline({ kind: 'tier-name', tierIndex: ti });
    };

    const copyText = (text: string, label: string) => {
      void navigator.clipboard
        .writeText(text)
        .then(() => showToast(`已复制${label}`))
        .catch(() => showToast('剪贴板写入受限', true));
    };

    const handleContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
      e.preventDefault();
      if (inlineTarget) closeInline(true);
      const pt = svgPointFromEvent(e);
      const target = (e.target as Element).closest('[data-role]');
      const isEdit = mode === 'edit';
      const items: ContextMenuItem[] = [];

      if (target) {
        const role = target.getAttribute('data-role');
        const bandIdx = parseInt(target.getAttribute('data-band') || '0', 10);
        const band = layout.bands[bandIdx];

        if (role === 'interval') {
          const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
          const ii = parseInt(target.getAttribute('data-idx') || '0', 10);
          const tier = tg.tiers[ti];
          const iv = tier?.intervals[ii];
          if (iv) {
            setSelection({ kind: 'interval', tierIndex: ti, itemIndex: ii, bandIndex: bandIdx });
            if (isEdit) {
              const clickT = band ? Number(timeFromElasticX(band, pt.x).toFixed(6)) : NaN;
              items.push(
                { label: '编辑文本', shortcut: '双击', action: () => openInline({ kind: 'interval', tierIndex: ti, itemIndex: ii }) },
                { label: '在此处切分', disabled: !(clickT > iv.xmin && clickT < iv.xmax), action: () => splitInterval(ti, ii, clickT) },
                { label: '从正中切分', disabled: iv.xmax <= iv.xmin, action: () => splitInterval(ti, ii) },
                { label: '向左合并', disabled: ii === 0, action: () => mergeIntervalWith(ti, ii, -1) },
                { label: '向右合并', disabled: ii >= tier.intervals.length - 1, action: () => mergeIntervalWith(ti, ii, 1) },
                {
                  label: '清空文本',
                  disabled: iv.text === '',
                  action: () => commitTgMutation((d) => { d.tiers[ti].intervals[ii].text = ''; })
                },
                { divider: true }
              );
            }
            const isZoomedHere = Boolean(
              viewDomain && Math.abs(viewDomain.min - iv.xmin) < 1e-4 && Math.abs(viewDomain.max - iv.xmax) < 1e-4
            );
            items.push(
              { label: '播放该区间', disabled: iv.xmax <= iv.xmin, action: () => { setPlayRange({ start: iv.xmin, end: iv.xmax }); onStartPlayback(iv.xmin, iv.xmax); } },
              { label: '循环播放该区间', disabled: iv.xmax <= iv.xmin, action: () => { setLoop(true); setPlayRange({ start: iv.xmin, end: iv.xmax }); onStartPlayback(iv.xmin, iv.xmax); } },
              isZoomedHere
                ? { label: '显示全长视图', action: () => setViewDomain(null) }
                : { label: '放大查看该区间', disabled: iv.xmax <= iv.xmin, action: () => setViewDomain({ min: iv.xmin, max: iv.xmax }) },
              { divider: true },
              { label: '复制文本', disabled: iv.text === '', action: () => copyText(iv.text, '区间文本') },
              { label: '复制起止时间', action: () => copyText(`${formatPraatDouble(iv.xmin)}\t${formatPraatDouble(iv.xmax)}`, '起止时间') }
            );
            if (!isEdit) items.push({ divider: true }, { label: '切换到编辑模式', action: () => setMode('edit') });
          }
        } else if (role === 'point') {
          const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
          const pi = parseInt(target.getAttribute('data-idx') || '0', 10);
          const p = tg.tiers[ti]?.points[pi];
          if (p) {
            setSelection({ kind: 'point', tierIndex: ti, itemIndex: pi, bandIndex: bandIdx });
            if (isEdit) {
              items.push(
                { label: '编辑标记', shortcut: '双击', action: () => openInline({ kind: 'point', tierIndex: ti, itemIndex: pi }) },
                { label: '从此点播放', action: () => { setPlayRange(null); onStartPlayback(p.number, tg.xmax); } },
                { label: '复制标记文本', disabled: p.mark === '', action: () => copyText(p.mark, '标记文本') },
                { label: '复制时间戳', action: () => copyText(formatPraatDouble(p.number), '时间戳') },
                { divider: true },
                { label: '删除此点', shortcut: 'Del', danger: true, action: () => commitTgMutation((d) => { d.tiers[ti].points.splice(pi, 1); }, null) }
              );
            } else {
              items.push(
                { label: '从此点播放', action: () => { setPlayRange(null); onStartPlayback(p.number, tg.xmax); } },
                { label: '复制标记文本', disabled: p.mark === '', action: () => copyText(p.mark, '标记文本') },
                { label: '复制时间戳', action: () => copyText(formatPraatDouble(p.number), '时间戳') },
                { divider: true },
                { label: '切换到编辑模式', action: () => setMode('edit') }
              );
            }
          }
        } else if (role === 'boundary') {
          const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
          const time = parseFloat(target.getAttribute('data-time') || '0');
          if (Number.isFinite(time)) {
            if (isEdit) {
              setSelection({ kind: 'boundary', tierIndex: ti, time, bandIndex: bandIdx });
              items.push(
                { label: '复制边界时间', action: () => copyText(formatPraatDouble(time), '边界时间') },
                { label: '从此处播放', action: () => { setPlayRange(null); onStartPlayback(time, tg.xmax); } },
                { divider: true },
                { label: '删除边界（合并两侧）', shortcut: 'Del', danger: true, action: () => deleteBoundaryAt(ti, time) }
              );
            } else {
              items.push(
                { label: '复制边界时间', action: () => copyText(formatPraatDouble(time), '边界时间') },
                { label: '从此处播放', action: () => { setPlayRange(null); onStartPlayback(time, tg.xmax); } },
                { divider: true },
                { label: '切换到编辑模式', action: () => setMode('edit') }
              );
            }
          }
        } else if (role === 'texttier-wire') {
          const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
          const clickT = band ? Number(timeFromElasticX(band, pt.x).toFixed(6)) : 0;
          if (isEdit) {
            items.push({
              label: `在此处添加标点 (${clickT.toFixed(3)} s)`,
              action: () => {
                const idx = addPointAt(ti, clickT);
                if (idx !== null) {
                  maybeAutoOpenInspector();
                  openInline({ kind: 'point', tierIndex: ti, itemIndex: idx });
                }
              }
            });
          }
          items.push({
            label: '从此处播放',
            action: () => {
              setPlayRange(null);
              onStartPlayback(clickT, tg.xmax);
            }
          });
          if (!isEdit) {
            items.push({ divider: true }, { label: '切换到编辑模式', action: () => setMode('edit') });
          }
        } else if (role === 'spine-tick') {
          const t = parseFloat(target.getAttribute('data-time') || '0');
          if (Number.isFinite(t)) {
            if (isEdit) {
              setSelection({ kind: 'spine', time: t, bandIndex: bandIdx });
            }
            items.push(
              { label: `复制时刻 (${formatPraatDouble(t)})`, action: () => copyText(formatPraatDouble(t), '时间戳') },
              {
                label: '从此精确时刻播放',
                action: () => {
                  setPlayRange(null);
                  onStartPlayback(t, tg.xmax);
                }
              }
            );
          }
        } else if (role === 'tier-header') {
          const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
          if (isEdit) {
            setSelection({ kind: 'tier', tierIndex: ti, bandIndex: bandIdx });
            items.push(
              { label: '重命名层', shortcut: '双击', action: () => openInline({ kind: 'tier-name', tierIndex: ti }) },
              { label: '上移一层', disabled: ti === 0, action: () => moveTier(ti, -1) },
              { label: '下移一层', disabled: ti >= tg.tiers.length - 1, action: () => moveTier(ti, 1) },
              { divider: true },
              { label: '在上方插入区间层', action: () => insertTierAt(ti, 'intervalTier') },
              { label: '在下方插入区间层', action: () => insertTierAt(ti + 1, 'intervalTier') },
              { label: '在下方插入点层', action: () => insertTierAt(ti + 1, 'textTier') },
              { divider: true },
              { label: '删除该层', danger: true, action: () => deleteTier(ti) }
            );
          } else {
            items.push(
              { label: '复制层名', disabled: !tg.tiers[ti]?.name, action: () => copyText(tg.tiers[ti].name, '层名') },
              { divider: true },
              {
                label: '切换到编辑模式',
                action: () => {
                  setMode('edit');
                  setSelection({ kind: 'tier', tierIndex: ti, bandIndex: bandIdx });
                }
              }
            );
          }
        }
      }

      if (items.length === 0) {
        // Let GlobalContextMenu handle blank stage / SVG background right-click
        setCtxMenu(null);
        return;
      }

      (e.nativeEvent as MouseEvent & { __tgCtxHandled?: boolean }).__tgCtxHandled = true;
      window.dispatchEvent(new Event('tg-close-global-ctx'));
      const x = Math.max(8, Math.min(e.clientX, window.innerWidth - 204));
      const y = Math.max(8, Math.min(e.clientY, window.innerHeight - items.length * 32 - 20));
      setCtxMenu({ x, y, items });
    };

    // Cue CSS class calculation
    const focusClass = !selection
      ? 'focus-none'
      : selection.kind === 'point'
        ? 'focus-point'
        : selection.kind === 'tier'
          ? tg.tiers[selection.tierIndex]?.kind === 'textTier'
            ? 'focus-point'
            : 'focus-interval'
          : selection.kind === 'interval' || selection.kind === 'boundary'
            ? 'focus-interval'
            : 'focus-none';

    // Floating Contextual Edit Bar geometry (positioned outside the entire owning Band so it NEVER covers adjacent tiers)
    const showFloatingBar = editInspectorMode === 'floating';
    const selectionAnchor =
      mode === 'edit' && showFloatingBar && selection && !inlineTarget && !dragPreview
        ? getSelectionAnchor(layout, selection)
        : null;
    const anchorRect = selectionAnchor?.rect ?? null;
    const anchorBand = selectionAnchor?.band ?? null;

    const [floatingPos, setFloatingPos] = useState<{ left: number; top: number } | null>(null);

    useLayoutEffect(() => {
      if (!anchorRect || !anchorBand || !selection) {
        setFloatingPos(null);
        return;
      }

      const computePos = () => {
        const barEl = floatingBarRef.current;
        const stageEl = stageRef.current;
        const sheetEl = sheetRef.current;
        const barW = barEl ? barEl.offsetWidth : 480;
        const barH = barEl ? barEl.offsetHeight : 38;
        const gap = 8;
        const margin = 6;

        // Horizontal: center over selected element, clamped cleanly inside both sheet & visible stage bounds
        let minLeft = margin;
        let maxLeft = Math.max(margin, layout.width - barW - margin);
        if (stageEl && sheetEl) {
          const stageRect = stageEl.getBoundingClientRect();
          const sheetRect = sheetEl.getBoundingClientRect();
          const sheetOriginX = sheetRect.left + sheetEl.clientLeft;
          const visMin = Math.max(margin, stageRect.left - sheetOriginX + margin);
          const visMax = Math.min(
            layout.width - barW - margin,
            stageRect.left + stageEl.clientWidth - sheetOriginX - barW - margin
          );
          if (visMin <= visMax) {
            minLeft = visMin;
            maxLeft = visMax;
          }
        }
        const left = Math.max(minLeft, Math.min(maxLeft, anchorRect.x + anchorRect.w / 2 - barW / 2));

        // Vertical: anchor OUTSIDE the entire owning band so adjacent tiers inside the band are NEVER occluded.
        // Primary: just below band bottom (band.tiersBottomY + gap).
        // Fallback when bottom clips container/viewport: above band top (band.linearY - barH - gap).
        // Viewport clamp only if a single band is taller than (or straddles both edges of) the viewport.
        const belowTop = anchorBand.tiersBottomY + gap;
        const aboveTop = anchorBand.linearY - barH - gap;

        let top = belowTop;
        if (stageEl && sheetEl) {
          const stageRect = stageEl.getBoundingClientRect();
          const sheetRect = sheetEl.getBoundingClientRect();
          const sheetOriginY = sheetRect.top + sheetEl.clientTop;
          const visibleTopInSheet = stageRect.top - sheetOriginY;
          const visibleBottomInSheet = visibleTopInSheet + stageEl.clientHeight;
          const minVisTop = visibleTopInSheet + margin;
          const maxVisTop = Math.max(minVisTop, visibleBottomInSheet - barH - margin);

          const fitsBelow =
            belowTop >= minVisTop && belowTop + barH <= visibleBottomInSheet - margin;
          const fitsAbove =
            aboveTop >= minVisTop && aboveTop + barH <= visibleBottomInSheet - margin;

          if (fitsBelow) {
            top = belowTop;
          } else if (fitsAbove) {
            top = aboveTop;
          } else if (
            anchorBand.tiersBottomY > visibleTopInSheet &&
            anchorBand.linearY < visibleBottomInSheet
          ) {
            // Band exceeds viewport height (or straddles both viewport edges): clamp within visible bounds
            const anchorMidY = anchorRect.y + anchorRect.h / 2;
            const viewMidY = (visibleTopInSheet + visibleBottomInSheet) / 2;
            const preferred = anchorMidY > viewMidY ? minVisTop : maxVisTop;
            top = Math.max(minVisTop, Math.min(maxVisTop, preferred));
          }
        } else if (belowTop + barH > layout.height - margin && aboveTop >= margin) {
          top = aboveTop;
        }

        const next = { left: Math.round(left), top: Math.round(top) };
        setFloatingPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
      };

      computePos();
      const barEl = floatingBarRef.current;
      const stageEl = stageRef.current;
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(computePos) : null;
      if (ro && barEl) ro.observe(barEl);
      if (ro && stageEl) ro.observe(stageEl);
      if (stageEl) stageEl.addEventListener('scroll', computePos, { passive: true });
      window.addEventListener('resize', computePos, { passive: true });
      return () => {
        ro?.disconnect();
        if (stageEl) stageEl.removeEventListener('scroll', computePos);
        window.removeEventListener('resize', computePos);
      };
    }, [
      anchorRect?.x,
      anchorRect?.y,
      anchorRect?.w,
      anchorRect?.h,
      anchorBand?.bandIndex,
      anchorBand?.linearY,
      anchorBand?.tiersBottomY,
      selection,
      layout.width,
      layout.height,
      stageW
    ]);

    const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.currentTarget.blur();
      }
    };

    return (
      <main
        ref={stageRef}
        id="stage"
        className="stage"
        onClick={(e) => {
          if (e.target === stageRef.current) {
            setCtxMenu(null);
            if (inlineTarget) closeInline(true);
            setSelection(null);
            setPlayRange(null);
          }
        }}
      >
        <div ref={sheetRef} id="sheet" className="sheet">
          <svg
            ref={svgRef}
            id="score-svg"
            xmlns="http://www.w3.org/2000/svg"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className={`${mode === 'edit' ? 'mode-edit' : ''} cue-${cueMode} ${focusClass}`}
            onPointerDown={handleSvgPointerDown}
            onPointerMove={handleSvgPointerMove}
            onPointerLeave={clearHoverGuide}
            onDoubleClick={handleSvgDoubleClick}
            onContextMenu={handleContextMenu}
          />

          {/* Exact Sub-Pixel Inline Editor */}
          {inlineTarget && inlineBox && (
            <>
              <textarea
                ref={inlineRef}
                className="inline-editor visible"
                spellCheck={false}
                value={inlineVal}
                style={{
                  left: Math.round(inlineBox.x),
                  top: Math.round(inlineBox.y),
                  width: Math.round(inlineBox.w),
                  minHeight: Math.round(inlineBox.h),
                  textAlign: inlineBox.align
                }}
                onChange={(e) => setInlineVal(e.target.value)}
                onCompositionStart={ipaIme.onCompositionStart}
                onCompositionEnd={ipaIme.onCompositionEnd}
                onKeyDown={ipaIme.onKeyDown}
                onKeyUp={ipaIme.onKeyUp}
                onBlur={(e) => {
                  if (isIpaRelatedElement(e.relatedTarget)) {
                    return;
                  }
                  closeInline(true);
                }}
              />
              <IpaModePill
                ime={ipaIme}
                style={{
                  left: Math.round(inlineBox.x),
                  top: Math.max(2, Math.round(inlineBox.y - 18))
                }}
              />
            </>
          )}

          {/* High-Contrast Dark Floating Contextual Bar */}
          {selection && anchorRect && anchorBand && (
            <div
              ref={floatingBarRef}
              className={`floating-bar ${floatingPos ? 'visible' : ''}`}
              style={
                floatingPos
                  ? { left: floatingPos.left, top: floatingPos.top }
                  : { left: 6, top: Math.round(anchorBand.tiersBottomY + 8) }
              }
            >
              {selection.kind === 'interval' && (() => {
                const tier = tg.tiers[selection.tierIndex];
                const iv = tier?.intervals[selection.itemIndex];
                if (!iv) return null;
                const isZoomedHere = Boolean(
                  viewDomain && Math.abs(viewDomain.min - iv.xmin) < 1e-4 && Math.abs(viewDomain.max - iv.xmax) < 1e-4
                );
                return (
                  <>
                    <label className="field-inline">
                      起
                      <input
                        type="number"
                        step="any"
                        defaultValue={formatPraatDouble(iv.xmin)}
                        key={`iv-min-${selection.tierIndex}-${selection.itemIndex}-${iv.xmin}`}
                        onKeyDown={blurOnEnter}
                        onBlur={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!Number.isFinite(val) || val > iv.xmax) {
                            showToast('起点不能大于终点', true);
                            e.target.value = formatPraatDouble(iv.xmin);
                            return;
                          }
                          if (val !== iv.xmin) {
                            commitTgMutation((draft) => {
                              const dTier = draft.tiers[selection.tierIndex];
                              const prev = dTier.intervals[selection.itemIndex - 1];
                              const cur = dTier.intervals[selection.itemIndex];
                              if (prev && prev.xmax === cur.xmin && val >= prev.xmin) prev.xmax = val;
                              cur.xmin = val;
                            });
                          }
                        }}
                      />
                    </label>
                    <label className="field-inline">
                      止
                      <input
                        type="number"
                        step="any"
                        defaultValue={formatPraatDouble(iv.xmax)}
                        key={`iv-max-${selection.tierIndex}-${selection.itemIndex}-${iv.xmax}`}
                        onKeyDown={blurOnEnter}
                        onBlur={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!Number.isFinite(val) || val < iv.xmin) {
                            showToast('终点不能小于起点', true);
                            e.target.value = formatPraatDouble(iv.xmax);
                            return;
                          }
                          if (val !== iv.xmax) {
                            commitTgMutation((draft) => {
                              const dTier = draft.tiers[selection.tierIndex];
                              const next = dTier.intervals[selection.itemIndex + 1];
                              const cur = dTier.intervals[selection.itemIndex];
                              if (next && next.xmin === cur.xmax && val <= next.xmax) next.xmin = val;
                              cur.xmax = val;
                            });
                          }
                        }}
                      />
                    </label>
                    <div className="sep" />
                    <button type="button" className="compact" onClick={() => openInline(selection)}>
                      <UiIcon name="edit" size={13} />
                      <span>改字</span>
                    </button>
                    <button type="button" className="compact" onClick={() => splitInterval(selection.tierIndex, selection.itemIndex)}>
                      <UiIcon name="split" size={13} />
                      <span>切分</span>
                    </button>
                    <button
                      type="button"
                      className="compact"
                      disabled={selection.itemIndex === 0}
                      onClick={() => mergeIntervalWith(selection.tierIndex, selection.itemIndex, -1)}
                    >
                      <UiIcon name="mergeLeft" size={13} />
                      <span>合左</span>
                    </button>
                    <button
                      type="button"
                      className="compact"
                      disabled={selection.itemIndex >= tier.intervals.length - 1}
                      onClick={() => mergeIntervalWith(selection.tierIndex, selection.itemIndex, 1)}
                    >
                      <UiIcon name="mergeRight" size={13} />
                      <span>合右</span>
                    </button>
                    <button
                      type="button"
                      className="compact"
                      disabled={iv.xmax <= iv.xmin}
                      onClick={() => {
                        setPlayRange({ start: iv.xmin, end: iv.xmax });
                        onStartPlayback(iv.xmin, iv.xmax);
                      }}
                    >
                      <UiIcon name="play" size={13} />
                      <span>播放</span>
                    </button>
                    {isZoomedHere ? (
                      <button type="button" className="compact" onClick={() => setViewDomain(null)}>
                        <UiIcon name="zoomReset" size={13} />
                        <span>全长</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="compact"
                        disabled={iv.xmax <= iv.xmin}
                        onClick={() => setViewDomain({ min: iv.xmin, max: iv.xmax })}
                      >
                        <UiIcon name="zoomIn" size={13} />
                        <span>放大</span>
                      </button>
                    )}
                  </>
                );
              })()}

              {selection.kind === 'point' && (() => {
                const tier = tg.tiers[selection.tierIndex];
                const pt = tier?.points[selection.itemIndex];
                if (!tier || !pt) return null;
                return (
                  <>
                    <label className="field-inline">
                      时间
                      <input
                        type="number"
                        step="any"
                        defaultValue={formatPraatDouble(pt.number)}
                        key={`pt-${selection.tierIndex}-${selection.itemIndex}-${pt.number}`}
                        onKeyDown={blurOnEnter}
                        onBlur={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!Number.isFinite(val)) {
                            e.target.value = formatPraatDouble(pt.number);
                            return;
                          }
                          if (tier.points.some((p, i) => i !== selection.itemIndex && p.number === val)) {
                            showToast('目标时刻已存在标点', true);
                            e.target.value = formatPraatDouble(pt.number);
                            return;
                          }
                          if (val !== pt.number) {
                            let nextIdx = selection.itemIndex;
                            commitTgMutation((draft) => {
                              const dTier = draft.tiers[selection.tierIndex];
                              const targetPt = dTier.points[selection.itemIndex];
                              if (!targetPt) return;
                              targetPt.number = val;
                              dTier.points.sort((a, b) => a.number - b.number);
                              nextIdx = dTier.points.indexOf(targetPt);
                            });
                            setSelection({
                              kind: 'point',
                              tierIndex: selection.tierIndex,
                              itemIndex: Math.max(0, nextIdx),
                              bandIndex: selection.bandIndex
                            });
                          }
                        }}
                      />
                    </label>
                    <div className="sep" />
                    <button type="button" className="compact" onClick={() => openInline(selection)}>
                      <UiIcon name="edit" size={13} />
                      <span>改字</span>
                    </button>
                    <button type="button" className="compact" onClick={() => { setPlayRange(null); onStartPlayback(pt.number, tg.xmax); }}>
                      <UiIcon name="play" size={13} />
                      <span>播放</span>
                    </button>
                    <button
                      type="button"
                      className="compact danger"
                      onClick={() =>
                        commitTgMutation((draft) => {
                          draft.tiers[selection.tierIndex].points.splice(selection.itemIndex, 1);
                        }, null)
                      }
                    >
                      <UiIcon name="trash" size={13} />
                      <span>删除</span>
                    </button>
                  </>
                );
              })()}

              {selection.kind === 'boundary' && (
                <>
                  <label className="field-inline">
                    边界
                    <input
                      type="number"
                      step="any"
                      defaultValue={formatPraatDouble(selection.time)}
                      key={`bnd-${selection.tierIndex}-${selection.time}`}
                      onKeyDown={blurOnEnter}
                      onBlur={(e) => {
                        const val = parseFloat(e.target.value);
                        if (Number.isFinite(val) && moveTierBoundary(selection.tierIndex, selection.time, val, false)) {
                          setSelection({ kind: 'boundary', tierIndex: selection.tierIndex, time: val, bandIndex: selection.bandIndex });
                        } else {
                          e.target.value = formatPraatDouble(selection.time);
                        }
                      }}
                    />
                  </label>
                  <div className="sep" />
                  <button
                    type="button"
                    className="compact danger"
                    onClick={() => deleteBoundaryAt(selection.tierIndex, selection.time)}
                  >
                    <UiIcon name="delBoundary" size={13} />
                    <span>删除边界</span>
                  </button>
                </>
              )}

              {selection.kind === 'spine' && (
                <label className="field-inline">
                  对齐时刻
                  <input
                    type="number"
                    step="any"
                    defaultValue={formatPraatDouble(selection.time)}
                    key={`sp-${selection.time}`}
                    onKeyDown={blurOnEnter}
                    onBlur={(e) => {
                      const val = parseFloat(e.target.value);
                      if (Number.isFinite(val) && moveSharedTimestamp(selection.time, val)) {
                        setSelection({ kind: 'spine', time: val, bandIndex: selection.bandIndex });
                      } else {
                        e.target.value = formatPraatDouble(selection.time);
                      }
                    }}
                  />
                </label>
              )}

              {selection.kind === 'tier' && (() => {
                const tier = tg.tiers[selection.tierIndex];
                if (!tier) return null;
                return (
                  <>
                    <label className="field-inline">
                      层名
                      <input
                        type="text"
                        defaultValue={tier.name}
                        key={`tn-${selection.tierIndex}-${tier.name}`}
                        onKeyDown={blurOnEnter}
                        onBlur={(e) => {
                          if (e.target.value !== tier.name) {
                            commitTgMutation((d) => {
                              d.tiers[selection.tierIndex].name = e.target.value;
                            });
                          }
                        }}
                      />
                    </label>
                    <label className="field-inline">
                      起
                      <input
                        type="number"
                        step="any"
                        defaultValue={formatPraatDouble(tier.xmin)}
                        key={`tmin-${selection.tierIndex}-${tier.xmin}`}
                        onKeyDown={blurOnEnter}
                        onBlur={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!Number.isFinite(val) || val > tier.xmax) {
                            showToast('起点不能大于终点', true);
                            e.target.value = formatPraatDouble(tier.xmin);
                            return;
                          }
                          if (val !== tier.xmin) {
                            commitTgMutation((d) => {
                              d.tiers[selection.tierIndex].xmin = val;
                            });
                          }
                        }}
                      />
                    </label>
                    <label className="field-inline">
                      止
                      <input
                        type="number"
                        step="any"
                        defaultValue={formatPraatDouble(tier.xmax)}
                        key={`tmax-${selection.tierIndex}-${tier.xmax}`}
                        onKeyDown={blurOnEnter}
                        onBlur={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!Number.isFinite(val) || val < tier.xmin) {
                            showToast('终点不能小于起点', true);
                            e.target.value = formatPraatDouble(tier.xmax);
                            return;
                          }
                          if (val !== tier.xmax) {
                            commitTgMutation((d) => {
                              d.tiers[selection.tierIndex].xmax = val;
                            });
                          }
                        }}
                      />
                    </label>
                    <div className="sep" />
                    <button
                      type="button"
                      className="compact"
                      disabled={selection.tierIndex === 0}
                      onClick={() => moveTier(selection.tierIndex, -1)}
                    >
                      <UiIcon name="up" size={13} />
                      <span>上移</span>
                    </button>
                    <button
                      type="button"
                      className="compact"
                      disabled={selection.tierIndex >= tg.tiers.length - 1}
                      onClick={() => moveTier(selection.tierIndex, 1)}
                    >
                      <UiIcon name="down" size={13} />
                      <span>下移</span>
                    </button>
                    <button
                      type="button"
                      className="compact danger"
                      onClick={() => deleteTier(selection.tierIndex)}
                    >
                      <UiIcon name="trash" size={13} />
                      <span>删除</span>
                    </button>
                  </>
                );
              })()}
            </div>
          )}

          {/* Live ±40 ms Floating Acoustic Micro-Loupe (Positioned Below Dragged Tier) */}
          <AcousticMicroLoupe
            anchor={showMicroLoupe ? loupeAnchor : null}
            audioBuffer={audioBuffer}
            audioOffset={audioOffset}
            analysis={analysis}
            showSpectrogram={showSpectrogram}
            maxFreq={maxFreq}
            layoutWidth={layout.width}
            stageRef={stageRef}
            sheetRef={sheetRef}
          />
        </div>

        {/* Live Rust-Backed Yunlong / Praat Candidate Popover */}
        <IpaImePopover ime={ipaIme} />

        {/* Right-Click Context Menu */}
        {ctxMenu && (
          <div className="context-menu open" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            {ctxMenu.items.map((item, idx) =>
              item.divider ? (
                <div key={`div-${idx}`} className="menu-divider" />
              ) : (
                <button
                  key={`${item.label}-${idx}`}
                  type="button"
                  className={item.danger ? 'danger' : ''}
                  disabled={item.disabled}
                  onClick={() => {
                    setCtxMenu(null);
                    item.action?.();
                  }}
                >
                  <span>{item.label}</span>
                  {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
                </button>
              )
            )}
          </div>
        )}
      </main>
    );
  }
);
