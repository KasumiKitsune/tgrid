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
  type EdgeSnapVisual,
  type EditorSelection,
  type IntervalDragPreviewState
} from '../render/renderScoreSvg';
import { resolveDualEdgeSnap, resolveSnap, type SnapResult } from '../interaction/snapEngine';
import { formatKeyCombo, isComposingEvent, isEditableTarget } from '../shortcuts/registry';
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
  children?: ContextMenuItem[];
}

const PLAYBACK_RATES = [0.5, 0.75, 1.0, 1.25, 1.5] as const;

function snapToEdgeVisual(snap: SnapResult | null): EdgeSnapVisual | null {
  return snap ? { x: snap.x, linX: snap.linX, label: snap.label } : null;
}

function resolveBandAtY(curLayout: ScoreLayout, y: number, fallbackBand: BandLayout): BandLayout {
  for (const b of curLayout.bands) {
    if (y >= b.linearY - 12 && y <= b.tiersBottomY + 12) return b;
  }
  let best = curLayout.bands[fallbackBand.bandIndex] ?? curLayout.bands[0] ?? fallbackBand;
  let bestDist = Infinity;
  for (const b of curLayout.bands) {
    const cy = (b.linearY + b.tiersBottomY) * 0.5;
    const d = Math.abs(y - cy);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}

function getTargetIntervalTierIndex(
  tg: TextGrid,
  selection: EditorSelection,
  lastActiveTierIndex: number,
  hiddenTierIndices: number[],
  fallbackFinest = -1
): number {
  if (
    selection &&
    'tierIndex' in selection &&
    tg.tiers[selection.tierIndex]?.kind === 'intervalTier'
  ) {
    return selection.tierIndex;
  }
  if (tg.tiers[lastActiveTierIndex]?.kind === 'intervalTier') {
    return lastActiveTierIndex;
  }
  if (fallbackFinest >= 0 && tg.tiers[fallbackFinest]?.kind === 'intervalTier') {
    return fallbackFinest;
  }
  const hiddenSet = new Set(hiddenTierIndices);
  for (let i = 0; i < tg.tiers.length; i++) {
    if (tg.tiers[i].kind === 'intervalTier' && !hiddenSet.has(i)) return i;
  }
  for (let i = 0; i < tg.tiers.length; i++) {
    if (tg.tiers[i].kind === 'intervalTier') return i;
  }
  return -1;
}

function getTargetTextTierIndex(
  tg: TextGrid,
  selection: EditorSelection,
  lastActiveTierIndex: number,
  hiddenTierIndices: number[]
): number {
  if (
    selection &&
    'tierIndex' in selection &&
    tg.tiers[selection.tierIndex]?.kind === 'textTier'
  ) {
    return selection.tierIndex;
  }
  if (tg.tiers[lastActiveTierIndex]?.kind === 'textTier') {
    return lastActiveTierIndex;
  }
  const hiddenSet = new Set(hiddenTierIndices);
  for (let i = 0; i < tg.tiers.length; i++) {
    if (tg.tiers[i].kind === 'textTier' && !hiddenSet.has(i)) return i;
  }
  for (let i = 0; i < tg.tiers.length; i++) {
    if (tg.tiers[i].kind === 'textTier') return i;
  }
  return -1;
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

function findNearbySpecBoundary(
  tg: TextGrid,
  selection: EditorSelection,
  lastActiveTierIndex: number,
  band: BandLayout,
  xPx: number,
  hiddenTierIndices: number[] = [],
  tolPx = 6
): { tierIndex: number; tierName: string; time: number; x: number } | null {
  const hiddenSet = new Set(hiddenTierIndices);
  const allHidden = tg.tiers.length > 0 && tg.tiers.every((_, i) => hiddenSet.has(i));
  const isVisible = (ti: number) => allHidden || !hiddenSet.has(ti);

  const candidates: number[] = [];
  if (
    selection &&
    'tierIndex' in selection &&
    tg.tiers[selection.tierIndex]?.kind === 'intervalTier' &&
    isVisible(selection.tierIndex)
  ) {
    candidates.push(selection.tierIndex);
  }
  if (
    tg.tiers[lastActiveTierIndex]?.kind === 'intervalTier' &&
    isVisible(lastActiveTierIndex) &&
    !candidates.includes(lastActiveTierIndex)
  ) {
    candidates.push(lastActiveTierIndex);
  }
  if (
    band.finestIntervalTierIdx >= 0 &&
    isVisible(band.finestIntervalTierIdx) &&
    !candidates.includes(band.finestIntervalTierIdx)
  ) {
    candidates.push(band.finestIntervalTierIdx);
  }
  tg.tiers.forEach((t, idx) => {
    if (t.kind === 'intervalTier' && isVisible(idx) && !candidates.includes(idx)) {
      candidates.push(idx);
    }
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
          return { tierIndex: ti, tierName: tier.name || `层 ${ti + 1}`, time: bt, x: bx };
        }
      }
    }
  }
  return null;
}

export const ScoreStage = forwardRef<ScoreStageHandle, ScoreStageProps>(
  ({ audioBuffer, onStartPlayback, onTogglePlay, onStopPlayback }, ref) => {
    const tabs = useEditorStore((s) => s.tabs);
    const tg = useEditorStore((s) => s.tg);
    const activeTabId = useEditorStore((s) => s.activeTabId);
    const docVersion = useEditorStore((s) => s.docVersion);
    const mode = useEditorStore((s) => s.mode);
    const setMode = useEditorStore((s) => s.setMode);
    const wrapMode = useEditorStore((s) => s.wrapMode);
    const setWrapMode = useEditorStore((s) => s.setWrapMode);
    const scaleMode = useEditorStore((s) => s.scaleMode);
    const setScaleMode = useEditorStore((s) => s.setScaleMode);
    const tickPrecision = useEditorStore((s) => s.tickPrecision);
    const tickFixedDecimals = useEditorStore((s) => s.tickFixedDecimals);
    const viewDomain = useEditorStore((s) => s.viewDomain);
    const setViewDomain = useEditorStore((s) => s.setViewDomain);
    const targetWidth = useEditorStore((s) => s.targetWidth);
    const setTargetWidth = useEditorStore((s) => s.setTargetWidth);
    const selection = useEditorStore((s) => s.selection);
    const setSelection = useEditorStore((s) => s.setSelection);
    const lastActiveTierIndex = useEditorStore((s) => s.lastActiveTierIndex);
    const hiddenTierIndices = useEditorStore((s) => s.hiddenTierIndices);
    const playRange = useEditorStore((s) => s.playRange);
    const setPlayRange = useEditorStore((s) => s.setPlayRange);
    const currentTime = useEditorStore((s) => s.currentTime);
    const setPlaybackTime = useEditorStore((s) => s.setPlaybackTime);
    const showPlayhead = useEditorStore((s) => s.showPlayhead);
    const playing = useEditorStore((s) => s.playing);
    const loop = useEditorStore((s) => s.loop);
    const setLoop = useEditorStore((s) => s.setLoop);
    const followPlayhead = useEditorStore((s) => s.followPlayhead);
    const rate = useEditorStore((s) => s.rate);
    const setRate = useEditorStore((s) => s.setRate);
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
    const aboutOpen = useEditorStore((s) => s.aboutOpen);
    const shortcutsOpen = useEditorStore((s) => s.shortcutsOpen);
    const ipaDockOpen = useEditorStore((s) => s.ipaDockOpen);
    const setIpaDockOpen = useEditorStore((s) => s.setIpaDockOpen);
    const toggleLegend = useEditorStore((s) => s.toggleLegend);
    const setSidebarOpen = useEditorStore((s) => s.setSidebarOpen);
    const setSidebarTab = useEditorStore((s) => s.setSidebarTab);
    const setShortcutsOpen = useEditorStore((s) => s.setShortcutsOpen);
    const openFindBar = useEditorStore((s) => s.openFindBar);
    const openExportModal = useEditorStore((s) => s.openExportModal);
    const cycleIpaMode = useEditorStore((s) => s.cycleIpaMode);
    const setLayoutStore = useEditorStore((s) => s.setLayout);
    const commitTgMutation = useEditorStore((s) => s.commitTgMutation);
    const undo = useEditorStore((s) => s.undo);
    const redo = useEditorStore((s) => s.redo);
    const splitInterval = useEditorStore((s) => s.splitInterval);
    const splitIntervalEqualN = useEditorStore((s) => s.splitIntervalEqualN);
    const mergeIntervalWith = useEditorStore((s) => s.mergeIntervalWith);
    const deleteBoundaryAt = useEditorStore((s) => s.deleteBoundaryAt);
    const deleteBoundaryAcrossAllTiers = useEditorStore((s) => s.deleteBoundaryAcrossAllTiers);
    const addPointAt = useEditorStore((s) => s.addPointAt);
    const insertTierAt = useEditorStore((s) => s.insertTierAt);
    const duplicateTier = useEditorStore((s) => s.duplicateTier);
    const derivePointTierFromIntervals = useEditorStore((s) => s.derivePointTierFromIntervals);
    const moveTier = useEditorStore((s) => s.moveTier);
    const removeTierWithUndoToast = useEditorStore((s) => s.removeTierWithUndoToast);
    const clearTierText = useEditorStore((s) => s.clearTierText);
    const toggleTierVisibility = useEditorStore((s) => s.toggleTierVisibility);
    const projectBoundaryToTier = useEditorStore((s) => s.projectBoundaryToTier);
    const copyIntervalSpanToTier = useEditorStore((s) => s.copyIntervalSpanToTier);
    const alignMicroBoundaries = useEditorStore((s) => s.alignMicroBoundaries);
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
    const shiftKeyDownRef = useRef(false);
    const draggingRef = useRef(false);
    const lastAutoScrollMsRef = useRef(0);
    const lastPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const hoverSnapRef = useRef<{
      bandIdx: number;
      ti: number;
      time: number;
      x: number;
      linX: number;
      label: string;
    } | null>(null);
    const pendingDragAnchorRef = useRef<{
      time: number;
      bandIndex: number;
      clientX: number;
      clientY: number;
    } | null>(null);
    const pendingInlineOpenRef = useRef<InlineTarget | null>(null);

    const [stageW, setStageW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1200));
    const [trigraphTick, setTrigraphTick] = useState(0);
    const [specUrls, setSpecUrls] = useState<Map<number, string>>(() => new Map());
    const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
    const [intervalDragPreview, setIntervalDragPreview] = useState<IntervalDragPreviewState | null>(null);
    const [loupeAnchor, setLoupeAnchor] = useState<MicroLoupeAnchor | null>(null);
    const [dismissedBlankTabIds, setDismissedBlankTabIds] = useState<Set<string>>(() => new Set());
    const [openSubmenuIdx, setOpenSubmenuIdx] = useState<number | null>(null);

    // Inline editor state
    const [inlineTarget, setInlineTarget] = useState<InlineTarget | null>(null);
    const [inlineBox, setInlineBox] = useState<(BoxRect & { align: 'center' | 'left' }) | null>(null);
    const [inlineVal, setInlineVal] = useState('');

    // Refs to break circular callbacks with useIpaIme & stationary modifier hover refresh
    const closeInlineRef = useRef<(commit: boolean) => void>(() => {});
    const stepSelectionRef = useRef<
      (dir: -1 | 1, axis: 'x' | 'y', openAfter: boolean, baseSel?: EditorSelection | InlineTarget) => void
    >(() => {});
    const refreshHoverGuideRef = useRef<() => void>(() => {});
    const inlineTargetRef = useRef<InlineTarget | null>(null);
    inlineTargetRef.current = inlineTarget;

    const handleInlineUnhandledKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposingEvent(e)) return;
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

    useEffect(() => {
      setOpenSubmenuIdx(null);
    }, [ctxMenu]);

    // Clear transient UI overlays when switching / closing document tabs
    useEffect(() => {
      pendingDragAnchorRef.current = null;
      pendingInlineOpenRef.current = null;
      hoverSnapRef.current = null;
      setInlineTarget(null);
      setInlineBox(null);
      setCtxMenu(null);
      setDragPreview(null);
      setIntervalDragPreview(null);
      setLoupeAnchor(null);
    }, [activeTabId]);

    // Close inline editor & drag overlays immediately when entering read-only mode
    useEffect(() => {
      if (mode === 'read') {
        pendingInlineOpenRef.current = null;
        hoverSnapRef.current = null;
        svgRef.current?.classList.remove('shift-split');
        if (inlineTargetRef.current) closeInlineRef.current(true);
        setDragPreview(null);
        setIntervalDragPreview(null);
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
        mode,
        hiddenTierIndices
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
      mode,
      hiddenTierIndices
    ]);

    const layoutRef = useRef<ScoreLayout>(layout);
    layoutRef.current = layout;

    // Playhead Auto-Follow Scroll (throttled cleanly so it never fights manual scroll)
    useEffect(() => {
      if (!playing || !followPlayhead || !Number.isFinite(currentTime)) return;
      const now = performance.now();
      if (now - lastAutoScrollMsRef.current < 180) return;

      const stageEl = stageRef.current;
      const sheetEl = sheetRef.current;
      if (!stageEl || !sheetEl || layout.bands.length === 0) return;

      const band =
        layout.bands.find(
          (b) => (b.bandIndex === 0 ? currentTime >= b.startT : currentTime > b.startT) && currentTime <= b.endT
        ) ?? (layout.bands.length === 1 ? layout.bands[0] : undefined);
      if (!band) return;

      const stageRect = stageEl.getBoundingClientRect();
      const sheetRect = sheetEl.getBoundingClientRect();
      const x = elasticXInBand(band, currentTime);
      const px = sheetRect.left + x;
      const bandTop = sheetRect.top + band.linearY;
      const bandBot = sheetRect.top + band.tiersBottomY;

      const marginX = Math.min(84, stageEl.clientWidth * 0.18);
      const marginY = 24;

      let nextLeft = stageEl.scrollLeft;
      let nextTop = stageEl.scrollTop;
      let needsScroll = false;

      if (px < stageRect.left + marginX || px > stageRect.right - marginX) {
        nextLeft = Math.max(0, stageEl.scrollLeft + (px - (stageRect.left + stageEl.clientWidth * 0.25)));
        needsScroll = true;
      }
      if (bandTop < stageRect.top + marginY || bandBot > stageRect.bottom - marginY) {
        nextTop = Math.max(0, stageEl.scrollTop + (bandTop - stageRect.top - 28));
        needsScroll = true;
      }

      if (needsScroll) {
        lastAutoScrollMsRef.current = now;
        stageEl.scrollTo({ left: nextLeft, top: nextTop, behavior: 'smooth' });
      }
    }, [playing, followPlayhead, currentTime, layout]);

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
        intervalDragPreview,
        screenSpecUrls: specUrls
      });
    }, [tg, layout, audioName, audioBuffer, audioOffset, analysis, maxFreq, mode, specUrls]);

    // Fast overlay-only updates for playhead, selection, and boundary/interval drag
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
        intervalDragPreview,
        hasAudio: Boolean(audioName && audioBuffer)
      });
    }, [
      layout,
      selection,
      playRange,
      currentTime,
      showPlayhead,
      dragPreview,
      intervalDragPreview,
      audioName,
      audioBuffer
    ]);

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
              commitTgMutation(
                (draft) => {
                  draft.tiers[tgt.tierIndex].intervals[tgt.itemIndex].text = finalVal;
                },
                undefined,
                '编辑区间文本'
              );
            }
          } else if (tgt.kind === 'point') {
            const cur = tg.tiers[tgt.tierIndex]?.points[tgt.itemIndex];
            if (cur && cur.mark !== finalVal) {
              commitTgMutation(
                (draft) => {
                  draft.tiers[tgt.tierIndex].points[tgt.itemIndex].mark = finalVal;
                },
                undefined,
                '编辑标点文本'
              );
            }
          } else if (tgt.kind === 'tier-name') {
            const cur = tg.tiers[tgt.tierIndex];
            if (cur && cur.name !== finalVal) {
              commitTgMutation(
                (draft) => {
                  draft.tiers[tgt.tierIndex].name = finalVal;
                },
                undefined,
                '重命名层级'
              );
            }
          }
        }
      },
      [inlineTarget, inlineVal, ipaIme, tg, commitTgMutation]
    );
    closeInlineRef.current = closeInline;

    const clearHoverGuide = useCallback(() => {
      hoverSnapRef.current = null;
      const svg = svgRef.current;
      if (!svg) return;
      const hg = svg.querySelector('#hover-guide-layer');
      if (hg) {
        while (hg.firstChild) hg.removeChild(hg.firstChild);
      }
      svg.querySelectorAll<SVGElement>('[data-role="spec-area"]').forEach((node) => {
        if (node.style.cursor) node.style.cursor = '';
      });
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

    // Open inline editor after a newly created interval commits and layout recomputes
    useEffect(() => {
      const pending = pendingInlineOpenRef.current;
      if (!pending) return;
      pendingInlineOpenRef.current = null;
      openInline(pending);
    }, [tg, layout, openInline]);

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

    const copyText = useCallback(
      (text: string, label: string) => {
        void navigator.clipboard
          .writeText(text)
          .then(() => showToast(`已复制${label}`))
          .catch(() => showToast('剪贴板写入受限', true));
      },
      [showToast]
    );

    const syncAudioForSelection = useCallback(
      (sel: EditorSelection) => {
        if (!sel || sel.kind !== 'interval') return;
        const st = useEditorStore.getState();
        const iv = st.tg.tiers[sel.tierIndex]?.intervals[sel.itemIndex];
        if (!iv || iv.xmax <= iv.xmin) return;
        setPlayRange({ start: iv.xmin, end: iv.xmax });
        if (!st.playing) {
          setPlaybackTime(iv.xmin, true);
        }
      },
      [setPlayRange, setPlaybackTime]
    );

    const replayCurrent = useCallback(
      (withContext: boolean) => {
        const st = useEditorStore.getState();
        const curTg = st.tg;
        const sel = st.selection;
        let range: { start: number; end: number } | null = null;
        if (sel?.kind === 'interval') {
          const iv = curTg.tiers[sel.tierIndex]?.intervals[sel.itemIndex];
          if (iv && iv.xmax > iv.xmin) {
            range = { start: iv.xmin, end: iv.xmax };
          }
        }
        if (!range && st.playRange && st.playRange.end > st.playRange.start) {
          range = { start: st.playRange.start, end: st.playRange.end };
        }
        if (!range && (sel?.kind === 'boundary' || sel?.kind === 'spine')) {
          const pad = withContext ? 0.25 : 0.2;
          range = {
            start: Math.max(curTg.xmin, sel.time - pad),
            end: Math.min(curTg.xmax, sel.time + pad)
          };
          if (range.end > range.start) {
            onStartPlayback(range.start, range.end);
          }
          return;
        }
        if (!range && sel?.kind === 'point') {
          const pt = curTg.tiers[sel.tierIndex]?.points[sel.itemIndex];
          if (pt) {
            const pad = withContext ? 0.25 : 0.2;
            const s = Math.max(curTg.xmin, pt.number - pad);
            const e = Math.min(curTg.xmax, pt.number + pad);
            if (e > s) onStartPlayback(s, e);
            return;
          }
        }
        if (range) {
          const start = withContext ? Math.max(curTg.xmin, range.start - 0.25) : range.start;
          const end = withContext ? Math.min(curTg.xmax, range.end + 0.25) : range.end;
          if (end > start) onStartPlayback(start, end);
          return;
        }
        if (withContext && Number.isFinite(st.currentTime)) {
          const s = Math.max(curTg.xmin, st.currentTime - 0.25);
          const e = Math.min(curTg.xmax, st.currentTime + 0.25);
          if (e > s) onStartPlayback(s, e);
          return;
        }
        const domMin = st.viewDomain?.min ?? curTg.xmin;
        const domMax = st.viewDomain?.max ?? curTg.xmax;
        if (domMax > domMin) onStartPlayback(domMin, domMax);
      },
      [onStartPlayback]
    );

    const snapTargetToZeroCrossing = useCallback(
      async (
        target:
          | { kind: 'boundary'; tierIndex: number; time: number; bandIndex?: number }
          | { kind: 'spine'; time: number; bandIndex?: number }
      ) => {
        const st = useEditorStore.getState();
        if (!st.analysis) {
          showToast('请先载入录音以使用过零点吸附');
          return;
        }
        try {
          const zt = await getPlatformBridge().findZeroCrossing(
            st.analysis.sessionId,
            target.time,
            0.008
          );
          if (!Number.isFinite(zt) || Math.abs(zt - target.time) <= 1e-9) {
            showToast('当前已位于最近过零点');
            return;
          }
          if (target.kind === 'boundary') {
            if (moveTierBoundary(target.tierIndex, target.time, zt, false)) {
              setSelection({
                kind: 'boundary',
                tierIndex: target.tierIndex,
                time: zt,
                bandIndex: target.bandIndex
              });
              showToast(`已吸附至过零点 (${formatPraatDouble(zt)} s)`);
            }
          } else {
            if (moveSharedTimestamp(target.time, zt)) {
              setSelection({
                kind: 'spine',
                time: zt,
                bandIndex: target.bandIndex
              });
              showToast(`已跨层吸附至过零点 (${formatPraatDouble(zt)} s)`);
            }
          }
        } catch {
          showToast('过零点计算失败', true);
        }
      },
      [moveTierBoundary, moveSharedTimestamp, setSelection, showToast]
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
            syncAudioForSelection(hit);
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
    }, [
      layout,
      currentTime,
      tg,
      findBestVisibleItemInTier,
      setSelection,
      syncAudioForSelection,
      scrollSelectionIntoStageView
    ]);

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
            syncAudioForSelection(best);
            scrollSelectionIntoStageView(best);
            if (openAfter && (best.kind === 'interval' || best.kind === 'point')) openInline(best);
            return;
          }
          if (cur.kind === 'boundary' || cur.kind === 'spine') {
            const targetTi =
              cur.kind === 'boundary'
                ? cur.tierIndex
                : getTargetIntervalTierIndex(
                    tg,
                    null,
                    lastActiveTierIndex,
                    hiddenTierIndices,
                    layout.bands[0]?.finestIntervalTierIdx ?? -1
                  );
            const tier = tg.tiers[targetTi];
            if (!tier || tier.kind !== 'intervalTier' || tier.intervals.length === 0) return;
            const eps = 1e-9;
            let idx = -1;
            if (dir === -1) {
              idx = tier.intervals.findIndex((iv) => Math.abs(iv.xmax - cur.time) <= eps);
              if (idx === -1) {
                for (let k = tier.intervals.length - 1; k >= 0; k--) {
                  if (tier.intervals[k].xmin < cur.time - eps) {
                    idx = k;
                    break;
                  }
                }
              }
            } else {
              idx = tier.intervals.findIndex((iv) => Math.abs(iv.xmin - cur.time) <= eps);
              if (idx === -1) {
                idx = tier.intervals.findIndex((iv) => iv.xmax > cur.time + eps);
              }
            }
            if (idx === -1) return;
            let foundBand = cur.bandIndex ?? 0;
            for (const band of layout.bands) {
              const tl = band.tiersLayout[targetTi];
              if (!tl) continue;
              if (
                tl.visibleIvs?.some((v) => v.iv.origIdx === idx) ||
                tl.visibleZeros?.some((v) => v.iv.origIdx === idx)
              ) {
                foundBand = band.bandIndex;
                break;
              }
            }
            const iv = tier.intervals[idx];
            if (iv) lastNavTimeRef.current = (iv.xmin + iv.xmax) / 2;
            const nextSel: EditorSelection = {
              kind: 'interval',
              tierIndex: targetTi,
              itemIndex: idx,
              bandIndex: foundBand
            };
            setSelection(nextSel);
            syncAudioForSelection(nextSel);
            scrollSelectionIntoStageView(nextSel);
            if (openAfter) openInline({ kind: 'interval', tierIndex: targetTi, itemIndex: idx });
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
              syncAudioForSelection(nextSel);
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
            syncAudioForSelection(best);
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
        lastActiveTierIndex,
        hiddenTierIndices,
        setSelection,
        syncAudioForSelection,
        openInline,
        selectInitialItemForKeyboard,
        findBestVisibleItemInTier,
        scrollSelectionIntoStageView
      ]
    );
    stepSelectionRef.current = stepSelection;

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

    const captureDragAnchor = useCallback((band: BandLayout, bandIdx: number, time: number) => {
      const svg = svgRef.current;
      const curLayout = layoutRef.current;
      if (!svg || curLayout.width <= 0 || curLayout.height <= 0) {
        pendingDragAnchorRef.current = null;
        return;
      }
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        pendingDragAnchorRef.current = null;
        return;
      }
      const scaleX = rect.width / curLayout.width;
      const scaleY = rect.height / curLayout.height;
      const svgX = elasticXInBand(band, time);
      const svgY = (band.tiersTopY + band.tiersBottomY) / 2;
      pendingDragAnchorRef.current = {
        time,
        bandIndex: bandIdx,
        clientX: rect.left + svgX * scaleX,
        clientY: rect.top + svgY * scaleY
      };
    }, []);

    const createIntervalInEmptySlot = useCallback(
      (ti: number, ii: number, rawT0: number, rawT1: number, bandIdx?: number, label = '划选新建区间') => {
        const tier = tg.tiers[ti];
        if (!tier || tier.kind !== 'intervalTier') return false;
        const iv = tier.intervals[ii];
        if (!iv || iv.text !== '' || iv.xmax <= iv.xmin) return false;

        let t0 = Math.max(iv.xmin, Math.min(iv.xmax, rawT0));
        let t1 = Math.max(iv.xmin, Math.min(iv.xmax, rawT1));
        const hasLeft = t0 > iv.xmin + 1e-9;
        const hasRight = t1 < iv.xmax - 1e-9;
        if (!hasLeft) t0 = iv.xmin;
        if (!hasRight) t1 = iv.xmax;
        if (t1 - t0 < 0.001) return false;

        const replacements: Array<{ xmin: number; xmax: number; text: string }> = [];
        if (hasLeft) replacements.push({ xmin: iv.xmin, xmax: t0, text: '' });
        const createdIdx = ii + replacements.length;
        replacements.push({ xmin: t0, xmax: t1, text: '' });
        if (hasRight) replacements.push({ xmin: t1, xmax: iv.xmax, text: '' });

        const curLayout = layoutRef.current;
        const midT = (t0 + t1) / 2;
        const targetBand =
          (bandIdx !== undefined ? curLayout.bands[bandIdx] : undefined) ??
          curLayout.bands.find((b) => midT >= b.startT - 1e-9 && midT <= b.endT + 1e-9);
        const resolvedBandIdx = targetBand?.bandIndex ?? bandIdx ?? 0;

        if (targetBand) {
          captureDragAnchor(targetBand, resolvedBandIdx, midT);
        }

        const nextSel: EditorSelection = {
          kind: 'interval',
          tierIndex: ti,
          itemIndex: createdIdx,
          bandIndex: resolvedBandIdx
        };

        commitTgMutation(
          (draft) => {
            const dTier = draft.tiers[ti];
            if (!dTier || dTier.kind !== 'intervalTier' || !dTier.intervals[ii]) return;
            dTier.intervals.splice(ii, 1, ...replacements);
          },
          nextSel,
          label
        );

        setPlayRange({ start: t0, end: t1 });
        if (!useEditorStore.getState().playing) {
          setPlaybackTime(t0, true);
        }
        pendingInlineOpenRef.current = { kind: 'interval', tierIndex: ti, itemIndex: createdIdx };
        return true;
      },
      [tg, commitTgMutation, setPlayRange, setPlaybackTime, captureDragAnchor]
    );

    const createIntervalFromPlayRange = useCallback(
      (tierIndex: number, bandIdx?: number) => {
        if (mode !== 'edit' || !playRange || playRange.end - playRange.start < 0.001) return false;
        const tier = tg.tiers[tierIndex];
        if (!tier || tier.kind !== 'intervalTier') return false;

        const slotIdx = tier.intervals.findIndex(
          (iv) =>
            iv.text === '' &&
            iv.xmax > iv.xmin &&
            iv.xmin <= playRange.start + 1e-6 &&
            iv.xmax >= playRange.end - 1e-6
        );
        if (slotIdx === -1) {
          showToast('当前框选跨越已有边界或含非空文本，请在空白区间内框选后创建', true);
          return false;
        }

        const iv = tier.intervals[slotIdx];
        const clampEdge = (val: number) => {
          const c = Math.max(iv.xmin, Math.min(iv.xmax, val));
          if (c <= iv.xmin + 1e-9) return iv.xmin;
          if (c >= iv.xmax - 1e-9) return iv.xmax;
          if (layout.tToIdx.has(c)) return c;
          return Math.max(iv.xmin, Math.min(iv.xmax, Number(c.toFixed(6))));
        };
        const t0 = clampEdge(playRange.start);
        const t1 = clampEdge(playRange.end);
        if (t1 - t0 < 0.001) {
          showToast('当前框选跨越已有边界或含非空文本，请在空白区间内框选后创建', true);
          return false;
        }
        maybeAutoOpenInspector();
        return createIntervalInEmptySlot(tierIndex, slotIdx, t0, t1, bandIdx, '按选区新建区间');
      },
      [mode, playRange, tg, layout, showToast, maybeAutoOpenInspector, createIntervalInEmptySlot]
    );

    // Global keyboard shortcuts & 2D navigation
    useEffect(() => {
      const onKeyDown = (e: KeyboardEvent) => {
        if (isComposingEvent(e)) return;

        const hasOpenModal =
          exportOpen ||
          aboutOpen ||
          shortcutsOpen ||
          Boolean(document.querySelector('.modal-backdrop.open'));

        // Replay WHILE typing in InlineEditor or Inspector textarea: Alt+P / F4 (+ Shift for ±250 ms context)
        const isInputReplayCombo =
          !e.ctrlKey &&
          !e.metaKey &&
          ((e.altKey && e.code === 'KeyP') || (!e.altKey && e.key === 'F4'));
        if (isInputReplayCombo && !hasOpenModal) {
          e.preventDefault();
          replayCurrent(e.shiftKey);
          return;
        }

        const editable = isEditableTarget(e.target) || isEditableTarget(document.activeElement);
        if (editable || hasOpenModal) return;

        if (e.code === 'KeyZ' && !e.ctrlKey && !e.metaKey) zKeyDownRef.current = true;
        if (e.key === 'Alt') {
          altKeyDownRef.current = true;
          if (!draggingRef.current && !inlineTargetRef.current && lastPointerRef.current) {
            refreshHoverGuideRef.current();
          }
        }
        if (e.key === 'Shift') {
          shiftKeyDownRef.current = true;
          if (!draggingRef.current && !inlineTargetRef.current) {
            svgRef.current?.classList.toggle('shift-split', mode === 'edit');
            if (lastPointerRef.current) refreshHoverGuideRef.current();
          }
        }

        const mod = e.ctrlKey || e.metaKey;
        const lower = e.key.toLowerCase();

        // IPA input mode cycle (Mod+\ or Alt+I)
        if (
          mode === 'edit' &&
          ((mod && (e.key === '\\' || e.code === 'Backslash')) ||
            (e.altKey && !mod && e.code === 'KeyI'))
        ) {
          e.preventDefault();
          cycleIpaMode();
          return;
        }

        // Undo / Redo
        if (mod && lower === 'z') {
          if (mode !== 'edit') return;
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
          return;
        }
        if (mod && lower === 'y') {
          if (mode !== 'edit') return;
          e.preventDefault();
          redo();
          return;
        }

        // Mod+/ shortcuts reference
        if (mod && !e.altKey && (e.key === '/' || e.code === 'Slash')) {
          e.preventDefault();
          setShortcutsOpen(!shortcutsOpen);
          return;
        }

        // Mod+F / Mod+H find & replace
        if (mod && !e.altKey && (lower === 'f' || lower === 'h') && !e.defaultPrevented) {
          e.preventDefault();
          openFindBar(lower === 'h');
          return;
        }

        // Mod+Home / Mod+End -> jump playhead to full start / end
        if (mod && !e.altKey && (e.key === 'Home' || e.key === 'End')) {
          e.preventDefault();
          const tTarget = e.key === 'Home' ? tg.xmin : tg.xmax;
          setPlaybackTime(tTarget, true);
          const stageEl = stageRef.current;
          if (stageEl) {
            if (e.key === 'Home') {
              stageEl.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
            } else {
              stageEl.scrollTo({ left: stageEl.scrollWidth, top: stageEl.scrollHeight, behavior: 'smooth' });
            }
          }
          return;
        }

        // Mod+Shift+ArrowLeft/Right (+ Alt ±1ms) -> cross-tier shared boundary/spine nudge
        if (
          mod &&
          e.shiftKey &&
          mode === 'edit' &&
          (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
          selection &&
          (selection.kind === 'boundary' || selection.kind === 'spine')
        ) {
          e.preventDefault();
          const dir: -1 | 1 = e.key === 'ArrowLeft' ? -1 : 1;
          const stepSec = e.altKey ? 0.001 : 0.01;
          const newT = Number((selection.time + dir * stepSec).toFixed(6));
          if (moveSharedTimestamp(selection.time, newT)) {
            if (selection.kind === 'boundary') {
              setSelection({
                kind: 'boundary',
                tierIndex: selection.tierIndex,
                time: newT,
                bandIndex: selection.bandIndex
              });
            } else {
              setSelection({
                kind: 'spine',
                time: newT,
                bandIndex: selection.bandIndex
              });
            }
          }
          return;
        }

        // Mod+C / Mod+Shift+C / Mod+X / Mod+V (guarded against native text selection)
        if (mod && !e.altKey && (lower === 'c' || lower === 'x' || lower === 'v') && selection) {
          const nativeSel = window.getSelection()?.toString() || '';
          if (nativeSel.length > 0) return;

          if (lower === 'c' && e.shiftKey) {
            if (selection.kind === 'interval') {
              const iv = tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex];
              if (iv) {
                e.preventDefault();
                copyText(`${formatPraatDouble(iv.xmin)}\t${formatPraatDouble(iv.xmax)}`, '起止时间');
              }
            } else if (selection.kind === 'point') {
              const pt = tg.tiers[selection.tierIndex]?.points[selection.itemIndex];
              if (pt) {
                e.preventDefault();
                copyText(formatPraatDouble(pt.number), '时间戳');
              }
            } else if (selection.kind === 'boundary' || selection.kind === 'spine') {
              e.preventDefault();
              copyText(formatPraatDouble(selection.time), '边界时间');
            }
            return;
          }

          if (lower === 'c' && !e.shiftKey) {
            if (selection.kind === 'interval') {
              const iv = tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex];
              if (iv) {
                e.preventDefault();
                copyText(iv.text, '区间文本');
              }
            } else if (selection.kind === 'point') {
              const pt = tg.tiers[selection.tierIndex]?.points[selection.itemIndex];
              if (pt) {
                e.preventDefault();
                copyText(pt.mark, '标点文本');
              }
            }
            return;
          }

          if (lower === 'x' && !e.shiftKey && mode === 'edit') {
            if (selection.kind === 'interval') {
              const iv = tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex];
              if (iv) {
                e.preventDefault();
                copyText(iv.text, '区间文本（已剪切）');
                if (iv.text !== '') {
                  commitTgMutation(
                    (d) => {
                      d.tiers[selection.tierIndex].intervals[selection.itemIndex].text = '';
                    },
                    selection,
                    '剪切区间文本'
                  );
                }
              }
            } else if (selection.kind === 'point') {
              const pt = tg.tiers[selection.tierIndex]?.points[selection.itemIndex];
              if (pt) {
                e.preventDefault();
                copyText(pt.mark, '标点文本（已剪切）');
                if (pt.mark !== '') {
                  commitTgMutation(
                    (d) => {
                      d.tiers[selection.tierIndex].points[selection.itemIndex].mark = '';
                    },
                    selection,
                    '剪切标点文本'
                  );
                }
              }
            }
            return;
          }

          if (lower === 'v' && !e.shiftKey && mode === 'edit') {
            if (selection.kind === 'interval' || selection.kind === 'point') {
              e.preventDefault();
              const snapSel = selection;
              void navigator.clipboard
                .readText()
                .then((clip) => {
                  const st = useEditorStore.getState();
                  if (snapSel.kind === 'interval') {
                    const iv = st.tg.tiers[snapSel.tierIndex]?.intervals[snapSel.itemIndex];
                    if (!iv) return;
                    commitTgMutation(
                      (d) => {
                        d.tiers[snapSel.tierIndex].intervals[snapSel.itemIndex].text = clip;
                      },
                      snapSel,
                      '粘贴区间文本'
                    );
                  } else {
                    const pt = st.tg.tiers[snapSel.tierIndex]?.points[snapSel.itemIndex];
                    if (!pt) return;
                    commitTgMutation(
                      (d) => {
                        d.tiers[snapSel.tierIndex].points[snapSel.itemIndex].mark = clip;
                      },
                      snapSel,
                      '粘贴标点文本'
                    );
                  }
                  showToast('已粘贴文本');
                })
                .catch(() => showToast('剪贴板读取受限', true));
            }
            return;
          }
        }

        // Stop here for any other Mod+ shortcut
        if (mod) return;

        // Layered Escape: ctxMenu -> inline -> playRange -> selection (one layer per press)
        if (e.key === 'Escape') {
          if (ctxMenu) {
            e.preventDefault();
            setCtxMenu(null);
            return;
          }
          if (inlineTargetRef.current) {
            e.preventDefault();
            closeInlineRef.current(false);
            return;
          }
          if (playRange) {
            e.preventDefault();
            setPlayRange(null);
            return;
          }
          if (selection) {
            e.preventDefault();
            setSelection(null);
            return;
          }
          return;
        }

        // Space / Shift+Space
        if ((e.code === 'Space' || e.key === ' ') && !e.altKey) {
          e.preventDefault();
          if (document.activeElement instanceof HTMLButtonElement) {
            document.activeElement.blur();
          }
          if (e.shiftKey) {
            const savedRange = playRange;
            const resetT = savedRange?.start ?? viewDomain?.min ?? tg.xmin;
            onStopPlayback();
            if (savedRange) setPlayRange(savedRange);
            setPlaybackTime(resetT, true);
          } else {
            onTogglePlay();
          }
          return;
        }

        // F1 / ? -> toggle shortcuts reference modal
        if (
          e.key === 'F1' ||
          (!e.altKey && (e.key === '?' || (e.shiftKey && e.code === 'Slash')))
        ) {
          e.preventDefault();
          setShortcutsOpen(!shortcutsOpen);
          return;
        }

        // F2 -> open inline editor in edit mode
        if (e.key === 'F2' && !e.altKey && !e.shiftKey && mode === 'edit' && selection) {
          if (selection.kind === 'interval' || selection.kind === 'point') {
            e.preventDefault();
            openInline(selection);
          } else if (selection.kind === 'tier') {
            e.preventDefault();
            openInline({ kind: 'tier-name', tierIndex: selection.tierIndex });
          }
          return;
        }

        // Alt+K / Alt+L / Alt+1..3
        if (e.altKey && !e.shiftKey) {
          if (e.code === 'KeyK') {
            e.preventDefault();
            if (mode === 'edit') setIpaDockOpen(!ipaDockOpen);
            else showToast('音标键盘仅在编辑模式可用');
            return;
          }
          if (e.code === 'KeyL') {
            e.preventDefault();
            toggleLegend();
            return;
          }
          if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') {
            e.preventDefault();
            const tab =
              e.code === 'Digit1' ? 'inspector' : e.code === 'Digit2' ? 'tiers' : 'settings';
            setSidebarTab(tab);
            setSidebarOpen(true);
            return;
          }
        }

        // Arrows & Tab
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const dir: -1 | 1 = e.key === 'ArrowLeft' ? -1 : 1;
          if (
            mode === 'edit' &&
            e.shiftKey &&
            selection &&
            (selection.kind === 'boundary' || selection.kind === 'point' || selection.kind === 'spine')
          ) {
            // Shift+Left/Right micro-nudge boundary, point, or spine by ±10 ms (±1 ms with Alt)
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
            } else if (selection.kind === 'spine') {
              const newT = Number((selection.time + dir * stepSec).toFixed(6));
              if (moveSharedTimestamp(selection.time, newT)) {
                setSelection({
                  kind: 'spine',
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
                  commitTgMutation(
                    (draft) => {
                      const dTier = draft.tiers[selection.tierIndex];
                      const targetPt = dTier.points[selection.itemIndex];
                      if (!targetPt) return;
                      targetPt.number = newT;
                      dTier.points.sort((a, b) => a.number - b.number);
                      newIdx = dTier.points.indexOf(targetPt);
                    },
                    undefined,
                    '微调标点'
                  );
                  setSelection({
                    kind: 'point',
                    tierIndex: selection.tierIndex,
                    itemIndex: Math.max(0, newIdx),
                    bandIndex: selection.bandIndex
                  });
                }
              }
            }
          } else if (!e.altKey) {
            stepSelection(dir, 'x', false);
          }
          return;
        }

        if (e.key === 'ArrowUp' && !e.altKey) {
          e.preventDefault();
          stepSelection(-1, 'y', false);
          return;
        }
        if (e.key === 'ArrowDown' && !e.altKey) {
          e.preventDefault();
          stepSelection(1, 'y', false);
          return;
        }
        if (e.key === 'Tab' && !e.altKey) {
          e.preventDefault();
          stepSelection(e.shiftKey ? -1 : 1, 'x', false);
          return;
        }

        // Home / End -> first / last item in active tier
        if ((e.key === 'Home' || e.key === 'End') && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          const ti =
            selection && 'tierIndex' in selection && tg.tiers[selection.tierIndex]
              ? selection.tierIndex
              : tg.tiers[lastActiveTierIndex]
                ? lastActiveTierIndex
                : layout.bands[0]?.displayOrder[0] ?? 0;
          const tier = tg.tiers[ti];
          if (!tier) return;
          const wantFirst = e.key === 'Home';
          if (tier.kind === 'intervalTier' && tier.intervals.length > 0) {
            const idx = wantFirst ? 0 : tier.intervals.length - 1;
            const iv = tier.intervals[idx];
            if (iv) lastNavTimeRef.current = (iv.xmin + iv.xmax) / 2;
            const nextSel: EditorSelection = {
              kind: 'interval',
              tierIndex: ti,
              itemIndex: idx,
              bandIndex: wantFirst ? 0 : Math.max(0, layout.bands.length - 1)
            };
            setSelection(nextSel);
            syncAudioForSelection(nextSel);
            scrollSelectionIntoStageView(nextSel);
          } else if (tier.kind === 'textTier' && tier.points.length > 0) {
            const idx = wantFirst ? 0 : tier.points.length - 1;
            const pt = tier.points[idx];
            if (pt) lastNavTimeRef.current = pt.number;
            const nextSel: EditorSelection = {
              kind: 'point',
              tierIndex: ti,
              itemIndex: idx,
              bandIndex: wantFirst ? 0 : Math.max(0, layout.bands.length - 1)
            };
            setSelection(nextSel);
            scrollSelectionIntoStageView(nextSel);
          }
          return;
        }

        // , / . (+ Alt ±10 ms) seek playhead; < / > (Shift+, / Shift+.) cycle playback rate
        if (e.code === 'Comma' || e.code === 'Period') {
          e.preventDefault();
          const isBack = e.code === 'Comma';
          if (e.shiftKey && !e.altKey) {
            let bestIdx = 0;
            let bestDist = Infinity;
            PLAYBACK_RATES.forEach((r, i) => {
              const d = Math.abs(r - rate);
              if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
              }
            });
            const nextIdx = Math.max(0, Math.min(PLAYBACK_RATES.length - 1, bestIdx + (isBack ? -1 : 1)));
            const nextRate = PLAYBACK_RATES[nextIdx];
            setRate(nextRate);
            showToast(`播放倍速：${nextRate}×`);
          } else if (!e.shiftKey) {
            const step = e.altKey ? 0.01 : 0.1;
            const base = Number.isFinite(currentTime) ? currentTime : tg.xmin;
            const nextT = Math.max(
              tg.xmin,
              Math.min(tg.xmax, Number((base + (isBack ? -step : step)).toFixed(6)))
            );
            setPlaybackTime(nextT, true);
          }
          return;
        }

        // Enter (edit: inline edit; read: play selected item)
        if (e.key === 'Enter' && !e.shiftKey && !e.altKey && selection) {
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
          return;
        }

        // 4-Quadrant Backspace / Delete / Shift+Backspace / Shift+Delete
        if ((e.key === 'Delete' || e.key === 'Backspace') && !e.altKey && mode === 'edit' && selection) {
          const isBackspace = e.key === 'Backspace';
          const isDelete = e.key === 'Delete';
          e.preventDefault();

          if (selection.kind === 'interval') {
            const ti = selection.tierIndex;
            const ii = selection.itemIndex;
            const tier = tg.tiers[ti];
            const iv = tier?.intervals[ii];
            if (!tier || !iv) return;

            // Zero-duration interval
            if (iv.xmax <= iv.xmin) {
              const remLen = tier.intervals.length - 1;
              const nextIdx =
                remLen <= 0
                  ? -1
                  : isBackspace
                    ? Math.max(0, ii - 1)
                    : Math.min(remLen - 1, ii);
              const nextSel: EditorSelection =
                nextIdx >= 0
                  ? { kind: 'interval', tierIndex: ti, itemIndex: nextIdx, bandIndex: selection.bandIndex }
                  : null;
              commitTgMutation(
                (draft) => {
                  draft.tiers[ti].intervals.splice(ii, 1);
                },
                nextSel,
                '删除零时长区间'
              );
              return;
            }

            // Non-empty interval
            if (iv.text !== '') {
              if (!e.shiftKey) {
                commitTgMutation(
                  (draft) => {
                    draft.tiers[ti].intervals[ii].text = '';
                  },
                  selection,
                  '清空区间文本'
                );
                showToast(
                  isBackspace
                    ? '已清空文本（再按 Backspace 移除左边界）'
                    : '已清空文本（再按 Delete 移除右边界）'
                );
                return;
              }
              // Shift+Backspace: clear text & merge left; Shift+Delete: clear text & merge right
              if (isBackspace) {
                if (ii === 0) {
                  commitTgMutation(
                    (draft) => {
                      draft.tiers[ti].intervals[ii].text = '';
                    },
                    selection,
                    '清空区间文本'
                  );
                  showToast('首格无左边界可移除');
                  return;
                }
                const nextSel: EditorSelection = {
                  kind: 'interval',
                  tierIndex: ti,
                  itemIndex: ii - 1,
                  bandIndex: selection.bandIndex
                };
                commitTgMutation(
                  (draft) => {
                    const dTier = draft.tiers[ti];
                    const prev = dTier.intervals[ii - 1];
                    const cur = dTier.intervals[ii];
                    prev.xmax = cur.xmax;
                    dTier.intervals.splice(ii, 1);
                  },
                  nextSel,
                  '清除并移除左边界'
                );
                return;
              }
              if (ii >= tier.intervals.length - 1) {
                commitTgMutation(
                  (draft) => {
                    draft.tiers[ti].intervals[ii].text = '';
                  },
                  selection,
                  '清空区间文本'
                );
                showToast('末格无右边界可移除');
                return;
              }
              commitTgMutation(
                (draft) => {
                  const dTier = draft.tiers[ti];
                  const cur = dTier.intervals[ii];
                  const next = dTier.intervals[ii + 1];
                  cur.xmax = next.xmax;
                  cur.text = next.text;
                  dTier.intervals.splice(ii + 1, 1);
                },
                selection,
                '清除并移除右边界'
              );
              return;
            }

            // Empty interval
            if (isBackspace) {
              if (ii === 0) {
                showToast('首格无法移除左边界');
                return;
              }
              mergeIntervalWith(ti, ii, -1);
            } else {
              if (ii >= tier.intervals.length - 1) {
                showToast('末格无法移除右边界');
                return;
              }
              mergeIntervalWith(ti, ii, 1);
            }
            return;
          }

          if (selection.kind === 'boundary') {
            if (e.shiftKey) {
              deleteBoundaryAcrossAllTiers(selection.time);
            } else {
              deleteBoundaryAt(selection.tierIndex, selection.time);
            }
            return;
          }

          if (selection.kind === 'point') {
            const ti = selection.tierIndex;
            const pi = selection.itemIndex;
            const tier = tg.tiers[ti];
            const pt = tier?.points[pi];
            if (!tier || !pt) return;
            if (e.shiftKey && isBackspace) {
              if (pt.mark !== '') {
                commitTgMutation(
                  (draft) => {
                    draft.tiers[ti].points[pi].mark = '';
                  },
                  selection,
                  '清空标点文本'
                );
              }
              return;
            }
            const remLen = tier.points.length - 1;
            const nextIdx =
              remLen <= 0 ? -1 : isBackspace ? Math.max(0, pi - 1) : Math.min(remLen - 1, pi);
            const nextSel: EditorSelection =
              nextIdx >= 0
                ? { kind: 'point', tierIndex: ti, itemIndex: nextIdx, bandIndex: selection.bandIndex }
                : null;
            commitTgMutation(
              (draft) => {
                draft.tiers[ti].points.splice(pi, 1);
              },
              nextSel,
              '删除标点'
            );
            return;
          }

          if (selection.kind === 'tier') {
            if (e.shiftKey && isDelete) {
              removeTierWithUndoToast(selection.tierIndex);
            } else if (!e.shiftKey) {
              showToast('删除整层请按 Shift+Delete');
            }
            return;
          }

          if (selection.kind === 'spine') {
            if (e.shiftKey) {
              deleteBoundaryAcrossAllTiers(selection.time);
            }
            return;
          }
          return;
        }

        // Single-key shortcuts (no Alt)
        if (e.altKey) return;

        // R / Shift+R -> replay selection (with ±250ms context if Shift)
        if (lower === 'r') {
          e.preventDefault();
          replayCurrent(e.shiftKey);
          return;
        }

        // L -> toggle loop playback
        if (lower === 'l' && !e.shiftKey) {
          e.preventDefault();
          const nextLoop = !loop;
          setLoop(nextLoop);
          showToast(nextLoop ? '已开启循环播放' : '已关闭循环播放');
          return;
        }

        // N / Shift+N -> jump to next / prev empty interval in active tier
        if (lower === 'n') {
          e.preventDefault();
          const ti = getTargetIntervalTierIndex(
            tg,
            selection,
            lastActiveTierIndex,
            hiddenTierIndices,
            layout.bands[0]?.finestIntervalTierIdx ?? -1
          );
          const tier = tg.tiers[ti];
          if (!tier || tier.kind !== 'intervalTier') {
            showToast('当前文档没有区间层');
            return;
          }
          const empties: number[] = [];
          tier.intervals.forEach((iv, idx) => {
            if (iv.text === '' && iv.xmax > iv.xmin) empties.push(idx);
          });
          if (empties.length === 0) {
            showToast(`「${tier.name || '当前层'}」没有空白区间`);
            return;
          }
          const curIdx =
            selection?.kind === 'interval' && selection.tierIndex === ti ? selection.itemIndex : -1;
          let targetIdx: number;
          let wrapped = false;
          if (!e.shiftKey) {
            const after = empties.find((idx) => idx > curIdx);
            if (after !== undefined) {
              targetIdx = after;
            } else {
              targetIdx = empties[0];
              wrapped = curIdx !== -1;
            }
          } else {
            let before: number | undefined;
            for (let k = empties.length - 1; k >= 0; k--) {
              if (empties[k] < curIdx) {
                before = empties[k];
                break;
              }
            }
            if (before !== undefined) {
              targetIdx = before;
            } else {
              targetIdx = empties[empties.length - 1];
              wrapped = curIdx !== -1;
            }
          }
          let foundBand = 0;
          for (const band of layout.bands) {
            const tl = band.tiersLayout[ti];
            if (!tl) continue;
            if (tl.visibleIvs?.some((v) => v.iv.origIdx === targetIdx)) {
              foundBand = band.bandIndex;
              break;
            }
          }
          const iv = tier.intervals[targetIdx];
          if (iv) lastNavTimeRef.current = (iv.xmin + iv.xmax) / 2;
          const nextSel: EditorSelection = {
            kind: 'interval',
            tierIndex: ti,
            itemIndex: targetIdx,
            bandIndex: foundBand
          };
          setSelection(nextSel);
          syncAudioForSelection(nextSel);
          scrollSelectionIntoStageView(nextSel);
          if (wrapped) {
            showToast(e.shiftKey ? '已循环回本层末尾空白区间' : '已循环回本层首个空白区间');
          }
          return;
        }

        // G -> jump/scroll to playhead & select containing interval on active tier
        if (lower === 'g' && !e.shiftKey) {
          e.preventDefault();
          const t = Number.isFinite(currentTime) ? currentTime : tg.xmin;
          setPlaybackTime(t, true);
          const ti =
            selection && 'tierIndex' in selection && tg.tiers[selection.tierIndex]
              ? selection.tierIndex
              : tg.tiers[lastActiveTierIndex]
                ? lastActiveTierIndex
                : layout.bands[0]?.displayOrder[0] ?? 0;
          const hit = findBestVisibleItemInTier(ti, t);
          if (hit) {
            setSelection(hit);
            syncAudioForSelection(hit);
            scrollSelectionIntoStageView(hit);
          }
          return;
        }

        // E -> toggle Read / Edit mode
        if (lower === 'e' && !e.shiftKey) {
          e.preventDefault();
          const nextMode = mode === 'edit' ? 'read' : 'edit';
          setMode(nextMode);
          showToast(nextMode === 'edit' ? '已进入编辑模式' : '已切换为只读模式');
          return;
        }

        // F / Shift+F -> reversible zoom viewDomain / reset full
        if (lower === 'f') {
          e.preventDefault();
          if (e.shiftKey) {
            setViewDomain(null);
            return;
          }
          let targetDom: { min: number; max: number } | null = null;
          if (selection?.kind === 'interval') {
            const iv = tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex];
            if (iv && iv.xmax > iv.xmin) targetDom = { min: iv.xmin, max: iv.xmax };
          }
          if (!targetDom && playRange && playRange.end > playRange.start) {
            targetDom = { min: playRange.start, max: playRange.end };
          }
          if (targetDom) {
            const already =
              viewDomain &&
              Math.abs(viewDomain.min - targetDom.min) < 1e-4 &&
              Math.abs(viewDomain.max - targetDom.max) < 1e-4;
            setViewDomain(already ? null : targetDom);
          } else if (viewDomain) {
            setViewDomain(null);
          }
          return;
        }

        // V / W -> toggle scaleMode / wrapMode
        if (lower === 'v' && !e.shiftKey) {
          e.preventDefault();
          const next = scaleMode === 'elastic' ? 'linear' : 'elastic';
          setScaleMode(next);
          showToast(next === 'linear' ? '时间比例：线性等比' : '时间比例：自适应弹性');
          return;
        }
        if (lower === 'w' && !e.shiftKey) {
          e.preventDefault();
          const next = wrapMode === 'auto' ? 'single' : 'auto';
          setWrapMode(next);
          showToast(next === 'single' ? '排版：单行长卷展开' : '排版：自动折行');
          return;
        }

        // Edit-only canvas shortcuts below
        if (mode !== 'edit') return;

        // B / Shift+B -> drop boundary at playhead
        if (lower === 'b') {
          e.preventDefault();
          const splitT = Number(currentTime.toFixed(6));
          if (e.shiftKey) {
            if (!Number.isFinite(splitT) || splitT <= tg.xmin + 1e-6 || splitT >= tg.xmax - 1e-6) {
              showToast('请先将播放头定位到文档内部时刻', true);
              return;
            }
            let splitCount = 0;
            for (const t of tg.tiers) {
              if (
                t.kind === 'intervalTier' &&
                t.intervals.some((iv) => iv.xmin < splitT - 1e-6 && iv.xmax > splitT + 1e-6)
              ) {
                splitCount++;
              }
            }
            if (splitCount === 0) {
              showToast('该时刻在全部区间层已存在边界');
              return;
            }
            commitTgMutation(
              (draft) => {
                for (const t of draft.tiers) {
                  if (t.kind !== 'intervalTier') continue;
                  const idx = t.intervals.findIndex(
                    (iv) => iv.xmin < splitT - 1e-6 && iv.xmax > splitT + 1e-6
                  );
                  if (idx !== -1) {
                    const iv = t.intervals[idx];
                    const right = { xmin: splitT, xmax: iv.xmax, text: '' };
                    iv.xmax = splitT;
                    t.intervals.splice(idx + 1, 0, right);
                  }
                }
              },
              undefined,
              '全部层播放头落边界'
            );
            showToast(`已在 ${splitCount} 个区间层落边界 (${splitT.toFixed(3)} s)`);
            return;
          }

          const ti = getTargetIntervalTierIndex(
            tg,
            selection,
            lastActiveTierIndex,
            hiddenTierIndices,
            layout.bands[0]?.finestIntervalTierIdx ?? -1
          );
          const tier = tg.tiers[ti];
          if (!tier || tier.kind !== 'intervalTier') {
            showToast('当前文档没有区间层', true);
            return;
          }
          const idx = tier.intervals.findIndex(
            (iv) => Number.isFinite(splitT) && iv.xmin < splitT - 1e-6 && iv.xmax > splitT + 1e-6
          );
          if (idx !== -1) {
            splitInterval(ti, idx, splitT);
          } else if (selection?.kind === 'interval') {
            splitInterval(selection.tierIndex, selection.itemIndex);
          } else {
            showToast('播放头未位于可切分区间内部');
          }
          return;
        }

        // S -> split selected interval at midpoint
        if (lower === 's' && !e.shiftKey) {
          if (selection?.kind === 'interval') {
            e.preventDefault();
            splitInterval(selection.tierIndex, selection.itemIndex);
          }
          return;
        }

        // P -> add point at currentTime on active TextTier
        if (lower === 'p' && !e.shiftKey) {
          e.preventDefault();
          const ti = getTargetTextTierIndex(tg, selection, lastActiveTierIndex, hiddenTierIndices);
          if (ti < 0) {
            showToast('当前文档没有点层 (TextTier)');
            return;
          }
          const idx = addPointAt(ti, Number.isFinite(currentTime) ? currentTime : tg.xmin);
          if (idx !== null && !playing) {
            pendingInlineOpenRef.current = { kind: 'point', tierIndex: ti, itemIndex: idx };
          }
          return;
        }

        // I -> create interval from playRange using active / lastActive interval tier
        if (lower === 'i' && !e.shiftKey) {
          if (playRange && playRange.end - playRange.start >= 0.001) {
            e.preventDefault();
            const ti = getTargetIntervalTierIndex(
              tg,
              selection,
              lastActiveTierIndex,
              hiddenTierIndices,
              layout.bands[0]?.finestIntervalTierIdx ?? -1
            );
            if (ti >= 0) {
              createIntervalFromPlayRange(ti, selection?.bandIndex);
            } else {
              showToast('当前文档没有区间层 (IntervalTier)', true);
            }
          }
          return;
        }

        // [ / ] -> select selected interval's left / right interior boundary
        if ((e.key === '[' || e.key === ']') && !e.shiftKey && selection?.kind === 'interval') {
          e.preventDefault();
          const tier = tg.tiers[selection.tierIndex];
          const iv = tier?.intervals[selection.itemIndex];
          if (!tier || !iv) return;
          const edgeT = e.key === '[' ? iv.xmin : iv.xmax;
          if (edgeT <= tier.xmin + 1e-9 || edgeT >= tier.xmax - 1e-9) {
            showToast('该侧为层端点，无内部边界');
            return;
          }
          const nextSel: EditorSelection = {
            kind: 'boundary',
            tierIndex: selection.tierIndex,
            time: edgeT,
            bandIndex: selection.bandIndex
          };
          setSelection(nextSel);
          scrollSelectionIntoStageView(nextSel);
          return;
        }

        // M / Shift+M -> non-destructive merge right / left
        if (lower === 'm' && selection?.kind === 'interval') {
          e.preventDefault();
          const tier = tg.tiers[selection.tierIndex];
          if (!tier) return;
          if (e.shiftKey) {
            if (selection.itemIndex === 0) {
              showToast('首格无法向左合并');
              return;
            }
            mergeIntervalWith(selection.tierIndex, selection.itemIndex, -1);
          } else {
            if (selection.itemIndex >= tier.intervals.length - 1) {
              showToast('末格无法向右合并');
              return;
            }
            mergeIntervalWith(selection.tierIndex, selection.itemIndex, 1);
          }
          return;
        }

        // Z tap (when not dragging & boundary/spine selected) -> snap to nearest audio zero-crossing
        if (
          lower === 'z' &&
          !e.shiftKey &&
          !e.repeat &&
          !draggingRef.current &&
          selection &&
          (selection.kind === 'boundary' || selection.kind === 'spine')
        ) {
          e.preventDefault();
          void snapTargetToZeroCrossing(selection);
        }
      };

      const onKeyUp = (e: KeyboardEvent) => {
        if (e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z') zKeyDownRef.current = false;
        if (e.key === 'Alt') {
          altKeyDownRef.current = false;
          if (!draggingRef.current && !inlineTargetRef.current && lastPointerRef.current) {
            refreshHoverGuideRef.current();
          }
        }
        if (e.key === 'Shift') {
          shiftKeyDownRef.current = false;
          svgRef.current?.classList.remove('shift-split');
          if (!draggingRef.current && !inlineTargetRef.current && lastPointerRef.current) {
            refreshHoverGuideRef.current();
          }
        }
      };
      const onBlur = () => {
        zKeyDownRef.current = false;
        altKeyDownRef.current = false;
        shiftKeyDownRef.current = false;
        svgRef.current?.classList.remove('shift-split');
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
      aboutOpen,
      shortcutsOpen,
      selection,
      lastActiveTierIndex,
      hiddenTierIndices,
      playRange,
      viewDomain,
      currentTime,
      playing,
      loop,
      rate,
      scaleMode,
      wrapMode,
      ipaDockOpen,
      ctxMenu,
      tg,
      layout,
      undo,
      redo,
      cycleIpaMode,
      onTogglePlay,
      onStopPlayback,
      onStartPlayback,
      setMode,
      setLoop,
      setRate,
      setScaleMode,
      setWrapMode,
      setViewDomain,
      setSelection,
      setPlayRange,
      setPlaybackTime,
      setIpaDockOpen,
      toggleLegend,
      setSidebarOpen,
      setSidebarTab,
      setShortcutsOpen,
      openFindBar,
      stepSelection,
      findBestVisibleItemInTier,
      syncAudioForSelection,
      scrollSelectionIntoStageView,
      openInline,
      commitTgMutation,
      splitInterval,
      mergeIntervalWith,
      deleteBoundaryAt,
      deleteBoundaryAcrossAllTiers,
      addPointAt,
      removeTierWithUndoToast,
      moveTierBoundary,
      moveSharedTimestamp,
      createIntervalFromPlayRange,
      replayCurrent,
      snapTargetToZeroCrossing,
      copyText,
      showToast
    ]);

    const svgPointFromEvent = useCallback((e: { clientX: number; clientY: number }) => {
      const svg = svgRef.current;
      const curLayout = layoutRef.current;
      if (!svg || curLayout.width <= 0 || curLayout.height <= 0) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * curLayout.width,
        y: ((e.clientY - rect.top) / Math.max(1, rect.height)) * curLayout.height
      };
    }, []);

    const renderHoverAt = useCallback(
      (
        clientX: number,
        clientY: number,
        shiftKey: boolean,
        altKey: boolean,
        targetOverride?: Element | null
      ) => {
        clearHoverGuide();
        if (draggingRef.current || inlineTargetRef.current) return;
        const svg = svgRef.current;
        const hg = svg?.querySelector('#hover-guide-layer');
        if (!svg || !hg) return;

        const rawTarget = targetOverride ?? document.elementFromPoint(clientX, clientY);
        const target = rawTarget?.closest('[data-role]') as SVGElement | null;
        if (!target || !svg.contains(target)) return;

        const curLayout = layoutRef.current;
        const st = useEditorStore.getState();
        const role = target.getAttribute('data-role');
        const bandIdx = parseInt(target.getAttribute('data-band') || '0', 10);
        const band = curLayout.bands[bandIdx];
        if (!band) return;
        const pt = svgPointFromEvent({ clientX, clientY });

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

        const drawAmberPreSnap = (
          snap: SnapResult,
          tl: BandLayout['tiersLayout'][number],
          isPointWire: boolean,
          isShiftSplit: boolean
        ) => {
          const anchorTopY = band.anchorH > 0 ? band.anchorY : band.linearY;
          // Sloped amber neck line
          svgEl(
            'path',
            {
              d: `M${snap.linX},${anchorTopY} L${snap.linX},${band.neckTopY} L${snap.x},${band.neckBotY}`,
              fill: 'none',
              stroke: '#B45309',
              'stroke-width': 1.35,
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round',
              opacity: 0.72
            },
            hg
          );
          if (band.tiersTopY > band.neckBotY) {
            svgEl(
              'line',
              {
                x1: snap.x,
                y1: band.neckBotY,
                x2: snap.x,
                y2: band.tiersTopY,
                stroke: '#B45309',
                'stroke-width': 1.15,
                opacity: 0.55
              },
              hg
            );
          }
          // Full-column amber solid guide across all visible tiers
          svgEl(
            'line',
            {
              x1: snap.x,
              y1: band.tiersTopY,
              x2: snap.x,
              y2: band.tiersBottomY,
              stroke: '#B45309',
              'stroke-width': 1.5
            },
            hg
          );
          // Tier-local anchor glyph
          if (isPointWire && tl.wireY !== undefined) {
            svgEl(
              'polygon',
              {
                points: `${snap.x},${tl.wireY - 4.5} ${snap.x + 4.5},${tl.wireY} ${snap.x},${tl.wireY + 4.5} ${snap.x - 4.5},${tl.wireY}`,
                fill: '#FEF3C7',
                stroke: '#B45309',
                'stroke-width': 1.5
              },
              hg
            );
          } else {
            svgEl(
              'line',
              { x1: snap.x - 4, y1: tl.y, x2: snap.x + 4, y2: tl.y, stroke: '#B45309', 'stroke-width': 1.5 },
              hg
            );
            svgEl(
              'line',
              {
                x1: snap.x - 4,
                y1: tl.y + tl.h,
                x2: snap.x + 4,
                y2: tl.y + tl.h,
                stroke: '#B45309',
                'stroke-width': 1.5
              },
              hg
            );
            svgEl(
              'circle',
              {
                cx: snap.x,
                cy: tl.midY,
                r: 3.5,
                fill: '#B45309',
                stroke: '#FFFFFF',
                'stroke-width': 1
              },
              hg
            );
          }
          // Compact amber pill above tier
          const pillTxt = `${formatPraatDouble(snap.t)} s · ${isShiftSplit ? 'Shift 切分 · ' : ''}${snap.label}`;
          const pw = Math.ceil(measurePx(pillTxt, `9.5px ${MONO_FONT_STACK}`)) + 12;
          const px = Math.max(4, Math.min(curLayout.width - pw - 4, snap.x - pw / 2));
          const py = Math.max(2, tl.y - 19);
          svgEl(
            'rect',
            {
              x: px,
              y: py,
              width: pw,
              height: 16,
              fill: '#B45309',
              'fill-opacity': '0.94'
            },
            hg
          );
          svgEl(
            'text',
            {
              x: px + pw / 2,
              y: py + 11.2,
              'text-anchor': 'middle',
              'font-family': MONO_FONT_STACK,
              'font-size': '9.5',
              fill: '#FFFFFF'
            },
            hg
          ).textContent = pillTxt;
        };

        const drawMutedHairline = (
          clampedX: number,
          rawT: number,
          tl: BandLayout['tiersLayout'][number],
          isPointWire: boolean,
          isShiftSplit: boolean
        ) => {
          svgEl(
            'line',
            {
              x1: clampedX,
              y1: tl.y,
              x2: clampedX,
              y2: tl.y + tl.h,
              stroke: '#1D4ED8',
              'stroke-width': isShiftSplit ? 1.3 : 1,
              opacity: isShiftSplit ? 0.72 : 0.55,
              'stroke-dasharray': '3 2'
            },
            hg
          );
          if (isPointWire && tl.wireY !== undefined) {
            svgEl(
              'polygon',
              {
                points: `${clampedX},${tl.wireY - 4} ${clampedX + 4},${tl.wireY} ${clampedX},${tl.wireY + 4} ${clampedX - 4},${tl.wireY}`,
                fill: '#EEF3FF',
                stroke: '#1D4ED8',
                'stroke-width': 1.2,
                opacity: 0.85
              },
              hg
            );
          }
          const tagTxt = `${rawT.toFixed(3)} s${isShiftSplit ? ' · Shift 切分' : ''}`;
          const tw = Math.ceil(measurePx(tagTxt, `9.5px ${MONO_FONT_STACK}`)) + 10;
          const tx = Math.max(4, Math.min(curLayout.width - tw - 4, clampedX - tw / 2));
          const ty = Math.max(2, tl.y - 18);
          svgEl(
            'rect',
            {
              x: tx,
              y: ty,
              width: tw,
              height: 15,
              fill: '#FFFFFF',
              'fill-opacity': '0.9',
              stroke: '#C8C4BA',
              'stroke-width': '0.65'
            },
            hg
          );
          svgEl(
            'text',
            {
              x: tx + tw / 2,
              y: ty + 10.5,
              'text-anchor': 'middle',
              'font-family': MONO_FONT_STACK,
              'font-size': '9.5',
              fill: '#57554F'
            },
            hg
          ).textContent = tagTxt;
        };

        if (role === 'spec-area') {
          const clampedX = Math.max(band.originX, Math.min(band.originX + band.bandContentW, pt.x));
          const nearBnd =
            st.mode === 'edit'
              ? findNearbySpecBoundary(
                  st.tg,
                  st.selection,
                  st.lastActiveTierIndex,
                  band,
                  clampedX,
                  st.hiddenTierIndices
                )
              : null;
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
            Math.max(0, Math.min(st.maxFreq, (1 - (pt.y - band.specY) / Math.max(1, band.specH)) * st.maxFreq))
          );
          const readoutTxt = nearBnd
            ? `${formatPraatDouble(t)} s · 拖拽「${nearBnd.tierName}」边界`
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
        } else if (role === 'texttier-wire' && st.mode === 'edit') {
          const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
          const tl = band.tiersLayout[ti];
          const tier = st.tg.tiers[ti];
          if (!tl || tl.wireY === undefined || !tier) return;
          const clampedX = Math.max(band.originX, Math.min(band.originX + band.bandContentW, pt.x));
          const minAllowed = Math.max(tier.xmin, band.startT);
          const maxAllowed = Math.min(tier.xmax, band.endT);
          const snap = resolveSnap({
            tg: st.tg,
            band,
            pointerX: clampedX,
            fromSpec: false,
            minAllowed,
            maxAllowed,
            allowEndpoints: true,
            activeTierIndex: ti,
            playRange: st.playRange,
            currentTime: st.currentTime,
            showPlayhead: st.showPlayhead,
            bypassAlt: altKey,
            hiddenTierIndices: st.hiddenTierIndices
          });
          if (snap) {
            hoverSnapRef.current = {
              bandIdx,
              ti,
              time: snap.t,
              x: snap.x,
              linX: snap.linX,
              label: snap.label
            };
            drawAmberPreSnap(snap, tl, true, false);
          } else {
            hoverSnapRef.current = null;
            const rawT = Math.max(minAllowed, Math.min(maxAllowed, timeFromElasticX(band, clampedX)));
            drawMutedHairline(clampedX, rawT, tl, true, false);
          }
        } else if (
          role === 'interval' &&
          st.mode === 'edit' &&
          (shiftKey || target.getAttribute('data-empty') === '1')
        ) {
          const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
          const ii = parseInt(target.getAttribute('data-idx') || '0', 10);
          const tl = band.tiersLayout[ti];
          const iv = st.tg.tiers[ti]?.intervals[ii];
          if (!tl || !iv || iv.xmax <= iv.xmin) return;
          const isShiftSplit = shiftKey;
          const snap = resolveSnap({
            tg: st.tg,
            band,
            pointerX: pt.x,
            fromSpec: false,
            minAllowed: iv.xmin,
            maxAllowed: iv.xmax,
            allowEndpoints: !isShiftSplit,
            activeTierIndex: ti,
            slotEdges: !isShiftSplit ? [iv.xmin, iv.xmax] : undefined,
            playRange: st.playRange,
            currentTime: st.currentTime,
            showPlayhead: st.showPlayhead,
            bypassAlt: altKey,
            hiddenTierIndices: st.hiddenTierIndices
          });
          if (snap) {
            hoverSnapRef.current = {
              bandIdx,
              ti,
              time: snap.t,
              x: snap.x,
              linX: snap.linX,
              label: snap.label
            };
            drawAmberPreSnap(snap, tl, false, isShiftSplit);
          } else {
            hoverSnapRef.current = null;
            const xMin = elasticXInBand(band, Math.max(band.startT, iv.xmin));
            const xMax = elasticXInBand(band, Math.min(band.endT, iv.xmax));
            const clampedX = Math.max(Math.min(xMin, xMax), Math.min(Math.max(xMin, xMax), pt.x));
            const rawT = Math.max(iv.xmin, Math.min(iv.xmax, timeFromElasticX(band, clampedX)));
            drawMutedHairline(clampedX, rawT, tl, false, isShiftSplit);
          }
        } else if (role === 'interval') {
          const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
          const ii = parseInt(target.getAttribute('data-idx') || '0', 10);
          const iv = st.tg.tiers[ti]?.intervals[ii];
          if (iv) drawHoverNecks([iv.xmin, iv.xmax]);
        } else if (role === 'boundary') {
          const t = parseFloat(target.getAttribute('data-time') || 'NaN');
          drawHoverNecks([t]);
        } else if (role === 'point') {
          const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
          const pi = parseInt(target.getAttribute('data-idx') || '0', 10);
          const ptItem = st.tg.tiers[ti]?.points[pi];
          if (ptItem) drawHoverNecks([ptItem.number]);
        }
      },
      [clearHoverGuide, svgPointFromEvent]
    );

    refreshHoverGuideRef.current = () => {
      const lp = lastPointerRef.current;
      if (!lp) return;
      renderHoverAt(lp.clientX, lp.clientY, shiftKeyDownRef.current, altKeyDownRef.current);
    };

    const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
      lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
      shiftKeyDownRef.current = e.shiftKey;
      altKeyDownRef.current = e.altKey;
      svgRef.current?.classList.toggle('shift-split', mode === 'edit' && e.shiftKey);
      renderHoverAt(e.clientX, e.clientY, e.shiftKey, e.altKey, e.target as Element);
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
      const initY0 = shared ? band.tiersTopY : tl.y;
      const initY1 = shared ? band.tiersBottomY : tl.y + tl.h;
      const { minAllowed, maxAllowed } = getBoundaryDragBounds(tg, ti, origTime, shared);

      setSelection({ kind: 'boundary', tierIndex: ti, time: origTime, bandIndex: bandIdx });
      clearHoverGuide();
      draggingRef.current = true;
      const prevBodyCursor = document.body.style.cursor;
      document.body.style.cursor = 'ew-resize';

      let latestTime = origTime;
      let latestBand = band;
      let latestBandIdx = bandIdx;
      let stickyTime: number | null = null;
      let lastClientX = startClientX;
      let lastClientY = startClientY;
      let dragActive = true;
      let moveSeq = 0;

      const updateBoundaryAt = async (clientX: number, clientY: number) => {
        const seq = ++moveSeq;
        const curLayout = layoutRef.current;
        const curPt = svgPointFromEvent({ clientX, clientY });
        const activeBand = resolveBandAtY(curLayout, curPt.y, band);
        const activeTl = activeBand.tiersLayout[ti];
        if (!activeTl) return;
        const y0 = shared ? activeBand.tiersTopY : activeTl.y;
        const y1 = shared ? activeBand.tiersBottomY : activeTl.y + activeTl.h;

        const rawT = fromSpec ? timeFromLinearX(activeBand, curPt.x) : timeFromElasticX(activeBand, curPt.x);
        let t = Math.max(minAllowed, Math.min(maxAllowed, rawT));
        let snapX: number | null = null;
        let snapMode = false;
        let snapLabel: string | null = null;
        let exactSnapped = false;

        if (zKeyDownRef.current && analysis) {
          stickyTime = null;
          const zt = await getPlatformBridge().findZeroCrossing(analysis.sessionId, t, 0.008);
          if (!dragActive || seq !== moveSeq) return;
          t = Math.max(minAllowed, Math.min(maxAllowed, zt));
          snapMode = true;
          snapLabel = '已吸附过零';
        } else {
          const hit = resolveSnap({
            tg,
            band: activeBand,
            pointerX: curPt.x,
            fromSpec,
            minAllowed,
            maxAllowed,
            allowEndpoints: false,
            activeTierIndex: ti,
            excludeOwnBoundaryTime: origTime,
            playRange,
            currentTime,
            showPlayhead,
            bypassAlt: altKeyDownRef.current,
            stickyTime,
            hiddenTierIndices
          });
          if (hit) {
            t = hit.t;
            snapX = hit.x;
            snapMode = true;
            snapLabel = hit.label;
            exactSnapped = true;
            stickyTime = hit.t;
          } else {
            stickyTime = null;
          }
        }

        if (!dragActive || seq !== moveSeq) return;
        latestTime = exactSnapped
          ? t
          : Math.max(minAllowed, Math.min(maxAllowed, Number(t.toFixed(6))));
        latestBand = activeBand;
        latestBandIdx = activeBand.bandIndex;
        const x = snapX !== null ? snapX : elasticXInBand(activeBand, latestTime);
        const linX = activeBand.linearXForTime(latestTime);
        const loupeVisible = Boolean(audioBuffer && showMicroLoupe);

        setDragPreview({
          bandIndex: activeBand.bandIndex,
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
            anchorTopY: fromSpec ? activeBand.waveY : y0,
            anchorBottomY: fromSpec ? activeBand.neckTopY : y1,
            snapLabel
          });
        }
      };

      if (audioBuffer && showMicroLoupe) {
        const initX = fromSpec ? band.linearXForTime(origTime) : elasticXInBand(band, origTime);
        setLoupeAnchor({
          centerT: origTime,
          anchorX: initX,
          anchorTopY: fromSpec ? band.waveY : initY0,
          anchorBottomY: fromSpec ? band.neckTopY : initY1,
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
        if (ev.type === 'keydown' && ev.key === 'Escape') {
          ev.preventDefault();
          cleanup(false);
          return;
        }
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
        document.body.style.cursor = prevBodyCursor;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onModKey);
        window.removeEventListener('keyup', onModKey);
        window.removeEventListener('blur', onCancel);
        setDragPreview(null);
        setLoupeAnchor(null);
        if (commit && Math.abs(latestTime - origTime) > 1e-9) {
          captureDragAnchor(latestBand, latestBandIdx, latestTime);
          if (moveTierBoundary(ti, origTime, latestTime, shared)) {
            setSelection({ kind: 'boundary', tierIndex: ti, time: latestTime, bandIndex: latestBandIdx });
          } else {
            pendingDragAnchorRef.current = null;
          }
        } else if (commit) {
          maybeAutoOpenInspector();
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
      // Middle-click direct audition on interval or point (zero mode-switch)
      if (e.button === 1) {
        const midEl = (e.target as Element).closest('[data-role]');
        const midRole = midEl?.getAttribute('data-role');
        if (midEl && midRole === 'interval') {
          e.preventDefault();
          const ti = parseInt(midEl.getAttribute('data-tier') || '0', 10);
          const ii = parseInt(midEl.getAttribute('data-idx') || '0', 10);
          const iv = tg.tiers[ti]?.intervals[ii];
          if (iv && iv.xmax > iv.xmin) {
            setPlayRange({ start: iv.xmin, end: iv.xmax });
            onStartPlayback(iv.xmin, iv.xmax);
          }
        } else if (midEl && midRole === 'point') {
          e.preventDefault();
          const ti = parseInt(midEl.getAttribute('data-tier') || '0', 10);
          const pi = parseInt(midEl.getAttribute('data-idx') || '0', 10);
          const ptItem = tg.tiers[ti]?.points[pi];
          if (ptItem) {
            onStartPlayback(
              Math.max(tg.xmin, ptItem.number - 0.2),
              Math.min(tg.xmax, ptItem.number + 0.2)
            );
          }
        }
        return;
      }

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
      const band = layoutRef.current.bands[bandIdx];
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
        e.preventDefault();

        const origPt = tg.tiers[ti]?.points[pi];
        const initTl = band.tiersLayout[ti];
        if (!origPt || !initTl) return;

        const startX = e.clientX;
        let moved = false;
        let prevBodyCursor = '';
        let latestTime = origPt.number;
        let latestBand = band;
        let latestBandIdx = bandIdx;
        let stickyTime: number | null = null;
        let lastClientX = e.clientX;
        let lastClientY = e.clientY;
        let dragActive = true;
        let moveSeq = 0;
        const tierMin = tg.tiers[ti].xmin;
        const tierMax = tg.tiers[ti].xmax;

        const updatePointAt = async (clientX: number, clientY: number) => {
          const seq = ++moveSeq;
          const curLayout = layoutRef.current;
          const curPt = svgPointFromEvent({ clientX, clientY });
          const activeBand = resolveBandAtY(curLayout, curPt.y, band);
          const activeTl = activeBand.tiersLayout[ti];
          if (!activeTl) return;

          let t = Math.max(tierMin, Math.min(tierMax, timeFromElasticX(activeBand, curPt.x)));
          let snapX: number | null = null;
          let snapMode = false;
          let snapLabel: string | null = null;
          let exactSnapped = false;

          if (zKeyDownRef.current && analysis) {
            stickyTime = null;
            const zt = await getPlatformBridge().findZeroCrossing(analysis.sessionId, t, 0.008);
            if (!dragActive || seq !== moveSeq) return;
            t = Math.max(tierMin, Math.min(tierMax, zt));
            snapMode = true;
            snapLabel = '已吸附过零';
          } else {
            const hit = resolveSnap({
              tg,
              band: activeBand,
              pointerX: curPt.x,
              fromSpec: false,
              minAllowed: tierMin,
              maxAllowed: tierMax,
              allowEndpoints: true,
              activeTierIndex: ti,
              excludePoint: { tierIndex: ti, time: origPt.number },
              playRange,
              currentTime,
              showPlayhead,
              bypassAlt: altKeyDownRef.current,
              stickyTime,
              hiddenTierIndices
            });
            if (hit) {
              t = hit.t;
              snapX = hit.x;
              snapMode = true;
              snapLabel = hit.label;
              exactSnapped = true;
              stickyTime = hit.t;
            } else {
              stickyTime = null;
            }
          }

          if (!dragActive || seq !== moveSeq) return;
          latestTime = exactSnapped
            ? t
            : Math.max(tierMin, Math.min(tierMax, Number(t.toFixed(6))));
          latestBand = activeBand;
          latestBandIdx = activeBand.bandIndex;
          const x = snapX !== null ? snapX : elasticXInBand(activeBand, latestTime);
          const loupeVisible = Boolean(audioBuffer && showMicroLoupe);

          setDragPreview({
            bandIndex: activeBand.bandIndex,
            x,
            linearX: activeBand.linearXForTime(latestTime),
            y0: activeTl.y,
            y1: activeTl.y + activeTl.h,
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
              anchorTopY: activeTl.y,
              anchorBottomY: activeTl.y + activeTl.h,
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
            prevBodyCursor = document.body.style.cursor;
            document.body.style.cursor = 'ew-resize';
          }
          void updatePointAt(ev.clientX, ev.clientY);
        };
        const onModKey = (ev: KeyboardEvent) => {
          if (ev.type === 'keydown' && ev.key === 'Escape') {
            ev.preventDefault();
            cleanup(false);
            return;
          }
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
          if (moved) {
            document.body.style.cursor = prevBodyCursor;
          }
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
          window.removeEventListener('keydown', onModKey);
          window.removeEventListener('keyup', onModKey);
          window.removeEventListener('blur', onCancel);
          setDragPreview(null);
          setLoupeAnchor(null);
          if (commit && !moved) {
            maybeAutoOpenInspector();
          } else if (commit && moved && Math.abs(latestTime - origPt.number) > 1e-9) {
            const tier = tg.tiers[ti];
            if (tier.points.some((p, i) => i !== pi && p.number === latestTime)) {
              showToast('目标时刻已存在标点', true);
              return;
            }
            captureDragAnchor(latestBand, latestBandIdx, latestTime);
            let nextIdx = pi;
            commitTgMutation(
              (draft) => {
                const dTier = draft.tiers[ti];
                const p = dTier.points[pi];
                if (!p) return;
                p.number = latestTime;
                dTier.points.sort((a, b) => a.number - b.number);
                nextIdx = dTier.points.indexOf(p);
              },
              undefined,
              '移动标点'
            );
            setSelection({
              kind: 'point',
              tierIndex: ti,
              itemIndex: Math.max(0, nextIdx),
              bandIndex: latestBandIdx
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
        const tier = tg.tiers[ti];
        const iv = tier?.intervals[ii];
        if (!tier || !iv) return;

        // Shift+Click split with unified magnetic snap + exact IEEE-754 passthrough
        if (mode === 'edit' && e.shiftKey) {
          e.preventDefault();
          const hs = hoverSnapRef.current;
          let splitSnapT: number | null = null;
          if (
            !e.altKey &&
            hs &&
            hs.bandIdx === bandIdx &&
            hs.ti === ti &&
            hs.time > iv.xmin + 1e-9 &&
            hs.time < iv.xmax - 1e-9
          ) {
            splitSnapT = hs.time;
          } else {
            const hit = resolveSnap({
              tg,
              band,
              pointerX: pt.x,
              fromSpec: false,
              minAllowed: iv.xmin,
              maxAllowed: iv.xmax,
              allowEndpoints: false,
              activeTierIndex: ti,
              playRange,
              currentTime,
              showPlayhead,
              bypassAlt: e.altKey,
              hiddenTierIndices
            });
            if (hit) splitSnapT = hit.t;
          }
          const targetT = splitSnapT !== null ? splitSnapT : timeFromElasticX(band, pt.x);
          splitInterval(ti, ii, targetT, { exact: splitSnapT !== null });
          return;
        }

        if (mode === 'edit') e.preventDefault();
        setSelection({ kind: 'interval', tierIndex: ti, itemIndex: ii, bandIndex: bandIdx });
        const keepSubPlayRange =
          mode === 'edit' &&
          iv.text === '' &&
          iv.xmax > iv.xmin &&
          Boolean(
            playRange &&
              playRange.end - playRange.start >= 0.001 &&
              iv.xmin <= playRange.start + 1e-6 &&
              iv.xmax >= playRange.end - 1e-6 &&
              (playRange.start > iv.xmin + 1e-4 || playRange.end < iv.xmax - 1e-4)
          );
        if (iv.xmax > iv.xmin && !keepSubPlayRange) {
          setPlayRange({ start: iv.xmin, end: iv.xmax });
          if (!useEditorStore.getState().playing) {
            setPlaybackTime(iv.xmin, true);
          }
        }

        if (mode !== 'edit' || iv.xmax <= iv.xmin) {
          if (mode === 'edit') maybeAutoOpenInspector();
          return;
        }

        const tl = band.tiersLayout[ti];
        if (!tl) return;
        const startClientX = e.clientX;
        const startedWithAlt = e.altKey;
        const initHoverSnap = hoverSnapRef.current;

        if (iv.text === '') {
          // Empty-interval horizontal sweep-create with persistent startSnap + cross-band support
          let startT: number;
          let startSnapped = false;
          let startSnapLabel = '';

          if (
            !e.altKey &&
            initHoverSnap &&
            initHoverSnap.bandIdx === bandIdx &&
            initHoverSnap.ti === ti &&
            initHoverSnap.time >= iv.xmin - 1e-12 &&
            initHoverSnap.time <= iv.xmax + 1e-12
          ) {
            startT = initHoverSnap.time;
            startSnapped = true;
            startSnapLabel = initHoverSnap.label;
          } else {
            const startHit = resolveSnap({
              tg,
              band,
              pointerX: pt.x,
              fromSpec: false,
              minAllowed: iv.xmin,
              maxAllowed: iv.xmax,
              allowEndpoints: true,
              activeTierIndex: ti,
              slotEdges: [iv.xmin, iv.xmax],
              playRange,
              currentTime,
              showPlayhead,
              bypassAlt: e.altKey,
              hiddenTierIndices
            });
            if (startHit) {
              startT = startHit.t;
              startSnapped = true;
              startSnapLabel = startHit.label;
            } else {
              const rawStartT = Math.max(iv.xmin, Math.min(iv.xmax, timeFromElasticX(band, pt.x)));
              startT = Math.max(iv.xmin, Math.min(iv.xmax, Number(rawStartT.toFixed(6))));
            }
          }

          let moved = false;
          let prevBodyCursor = '';
          let latestEndT = startT;
          let endSnapped = false;
          let stickyEndTime: number | null = null;
          let latestBandIdx = bandIdx;
          let lastClientX = e.clientX;
          let lastClientY = e.clientY;
          let dragActive = true;
          let moveSeq = 0;

          const updateCreateAt = async (clientX: number, clientY: number) => {
            const seq = ++moveSeq;
            const curLayout = layoutRef.current;
            const curPt = svgPointFromEvent({ clientX, clientY });
            const activeBand = resolveBandAtY(curLayout, curPt.y, band);
            const activeTl = activeBand.tiersLayout[ti];
            if (!activeTl) return;
            const activeVi = activeTl.visibleIvs?.find((v) => v.iv.origIdx === ii);
            const laneY0 = activeVi
              ? activeTl.y + (activeTl.laneOffsets?.[activeVi.iv.lane] || 0)
              : activeTl.y;
            const laneY1 = activeVi
              ? laneY0 + (activeTl.laneHeights?.[activeVi.iv.lane] || activeTl.h)
              : activeTl.y + activeTl.h;

            let endT = Math.max(iv.xmin, Math.min(iv.xmax, timeFromElasticX(activeBand, curPt.x)));
            let endSnapVisual: EdgeSnapVisual | null = null;
            let exactEnd = false;
            let curEndSnapped = false;

            if (zKeyDownRef.current && analysis) {
              stickyEndTime = null;
              const zt = await getPlatformBridge().findZeroCrossing(analysis.sessionId, endT, 0.008);
              if (!dragActive || seq !== moveSeq) return;
              endT = Math.max(iv.xmin, Math.min(iv.xmax, zt));
              curEndSnapped = true;
              endSnapVisual = {
                x: elasticXInBand(activeBand, endT),
                linX: activeBand.linearXForTime(endT),
                label: '已吸附过零'
              };
            } else {
              const hit = resolveSnap({
                tg,
                band: activeBand,
                pointerX: curPt.x,
                fromSpec: false,
                minAllowed: iv.xmin,
                maxAllowed: iv.xmax,
                allowEndpoints: true,
                activeTierIndex: ti,
                slotEdges: [iv.xmin, iv.xmax],
                playRange,
                currentTime,
                showPlayhead,
                bypassAlt: altKeyDownRef.current,
                stickyTime: stickyEndTime,
                hiddenTierIndices
              });
              if (hit && Math.abs(hit.t - startT) > 1e-9) {
                endT = hit.t;
                stickyEndTime = hit.t;
                exactEnd = true;
                curEndSnapped = true;
                endSnapVisual = snapToEdgeVisual(hit);
              } else {
                stickyEndTime = null;
              }
            }

            if (!dragActive || seq !== moveSeq) return;
            if (!exactEnd) {
              endT = Math.max(iv.xmin, Math.min(iv.xmax, Number(endT.toFixed(6))));
            }
            latestEndT = endT;
            endSnapped = curEndSnapped;
            latestBandIdx = activeBand.bandIndex;

            const tStart = Math.min(startT, latestEndT);
            const tEnd = Math.max(startT, latestEndT);
            const endIsRight = latestEndT >= startT;

            const startInActiveBand =
              startT >= activeBand.startT - 1e-9 && startT <= activeBand.endT + 1e-9;
            const liveStartSnapVisual: EdgeSnapVisual | null =
              startSnapped && startInActiveBand
                ? {
                    x: elasticXInBand(activeBand, startT),
                    linX: activeBand.linearXForTime(startT),
                    label: startSnapLabel
                  }
                : null;

            const leftSnap = endIsRight ? liveStartSnapVisual : endSnapVisual;
            const rightSnap = endIsRight ? endSnapVisual : liveStartSnapVisual;

            const clampedTStart = Math.max(activeBand.startT, Math.min(activeBand.endT, tStart));
            const clampedTEnd = Math.max(activeBand.startT, Math.min(activeBand.endT, tEnd));
            const x0 = leftSnap ? leftSnap.x : elasticXInBand(activeBand, clampedTStart);
            const x1 = rightSnap ? rightSnap.x : elasticXInBand(activeBand, clampedTEnd);
            const linX0 = leftSnap ? leftSnap.linX : activeBand.linearXForTime(clampedTStart);
            const linX1 = rightSnap ? rightSnap.linX : activeBand.linearXForTime(clampedTEnd);

            setIntervalDragPreview({
              bandIndex: activeBand.bandIndex,
              tierIndex: ti,
              mode: 'create',
              tStart,
              tEnd,
              x0,
              x1,
              linX0,
              linX1,
              y0: laneY0,
              y1: laneY1,
              startSnap: leftSnap,
              endSnap: rightSnap
            });

            if (audioBuffer && showMicroLoupe) {
              setLoupeAnchor({
                centerT: latestEndT,
                anchorX: endIsRight ? x1 : x0,
                anchorTopY: laneY0,
                anchorBottomY: laneY1,
                snapLabel: endSnapVisual?.label ?? null
              });
            }
          };

          const onMove = (ev: PointerEvent) => {
            lastClientX = ev.clientX;
            lastClientY = ev.clientY;
            altKeyDownRef.current = ev.altKey;
            if (!moved && Math.abs(ev.clientX - startClientX) < 5) return;
            if (!moved) {
              moved = true;
              draggingRef.current = true;
              clearHoverGuide();
              prevBodyCursor = document.body.style.cursor;
              document.body.style.cursor = 'var(--cursor-time-ibeam)';
            }
            void updateCreateAt(ev.clientX, ev.clientY);
          };

          const onModKey = (ev: KeyboardEvent) => {
            if (ev.type === 'keydown' && ev.key === 'Escape') {
              ev.preventDefault();
              cleanup(false);
              return;
            }
            if (ev.code === 'KeyZ' || ev.key === 'z' || ev.key === 'Z') {
              zKeyDownRef.current = ev.type === 'keydown';
              if (moved) void updateCreateAt(lastClientX, lastClientY);
            } else if (ev.key === 'Alt') {
              ev.preventDefault();
              altKeyDownRef.current = ev.type === 'keydown';
              if (moved) void updateCreateAt(lastClientX, lastClientY);
            }
          };

          const cleanup = (commit: boolean) => {
            if (!dragActive) return;
            dragActive = false;
            draggingRef.current = false;
            if (moved) {
              document.body.style.cursor = prevBodyCursor;
            }
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onCancel);
            window.removeEventListener('keydown', onModKey);
            window.removeEventListener('keyup', onModKey);
            window.removeEventListener('blur', onCancel);
            setIntervalDragPreview(null);
            setLoupeAnchor(null);

            if (commit && !moved) {
              maybeAutoOpenInspector();
              if (startedWithAlt && iv.xmax > iv.xmin) {
                setPlayRange({ start: iv.xmin, end: iv.xmax });
                onStartPlayback(iv.xmin, iv.xmax);
              }
            } else if (commit && moved) {
              let t0 = Math.min(startT, latestEndT);
              let t1 = Math.max(startT, latestEndT);
              // Only flush tiny near-edge residuals when neither side intentionally snapped and Alt is not held
              if (!startSnapped && !endSnapped && !altKeyDownRef.current) {
                const curBand = layoutRef.current.bands[latestBandIdx] ?? band;
                const xIvMin = elasticXInBand(curBand, iv.xmin);
                const xIvMax = elasticXInBand(curBand, iv.xmax);
                const xT0 = elasticXInBand(curBand, t0);
                const xT1 = elasticXInBand(curBand, t1);
                if (
                  t0 - iv.xmin < 0.002 ||
                  (iv.xmin >= curBand.startT - 1e-9 && Math.abs(xT0 - xIvMin) < 3)
                ) {
                  t0 = iv.xmin;
                }
                if (
                  iv.xmax - t1 < 0.002 ||
                  (iv.xmax <= curBand.endT + 1e-9 && Math.abs(xIvMax - xT1) < 3)
                ) {
                  t1 = iv.xmax;
                }
              }
              if (t1 - t0 >= 0.001) {
                createIntervalInEmptySlot(ti, ii, t0, t1, latestBandIdx, '划选新建区间');
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
          return;
        }

        // Non-empty interval whole-interval horizontal translation / slide (with empty-neighbor flush & dual-edge snap)
        const prevIv =
          ii > 0 && Math.abs(tier.intervals[ii - 1].xmax - iv.xmin) < 1e-7
            ? tier.intervals[ii - 1]
            : null;
        const nextIv =
          ii + 1 < tier.intervals.length && Math.abs(tier.intervals[ii + 1].xmin - iv.xmax) < 1e-7
            ? tier.intervals[ii + 1]
            : null;
        const prevIsEmpty = Boolean(prevIv && prevIv.text === '');
        const nextIsEmpty = Boolean(nextIv && nextIv.text === '');
        const dur = iv.xmax - iv.xmin;
        const MIN_NEIGHBOR_DUR = 0.001;
        let minXmin = prevIv
          ? prevIsEmpty
            ? prevIv.xmin
            : prevIv.xmin + MIN_NEIGHBOR_DUR
          : iv.xmin > tier.xmin + 1e-9
            ? tier.xmin
            : iv.xmin;
        if (!prevIv && ii > 0 && tier.intervals[ii - 1].xmax <= iv.xmin + 1e-9) {
          minXmin = Math.max(minXmin, tier.intervals[ii - 1].xmax);
        }
        let maxXmax = nextIv
          ? nextIsEmpty
            ? nextIv.xmax
            : nextIv.xmax - MIN_NEIGHBOR_DUR
          : iv.xmax < tier.xmax - 1e-9
            ? tier.xmax
            : iv.xmax;
        if (!nextIv && ii + 1 < tier.intervals.length && tier.intervals[ii + 1].xmin >= iv.xmax - 1e-9) {
          maxXmax = Math.min(maxXmax, tier.intervals[ii + 1].xmin);
        }
        const maxXmin = maxXmax - dur;

        if (maxXmin <= minXmin + 1e-9) {
          maybeAutoOpenInspector();
          if (startedWithAlt && iv.xmax > iv.xmin) {
            setPlayRange({ start: iv.xmin, end: iv.xmax });
            onStartPlayback(iv.xmin, iv.xmax);
          }
          return;
        }

        const slotEdges: number[] = [];
        if (prevIsEmpty && prevIv) slotEdges.push(prevIv.xmin);
        if (nextIsEmpty && nextIv) slotEdges.push(nextIv.xmax);

        const startDragT = timeFromElasticX(band, pt.x);
        let moved = false;
        let prevBodyCursor = '';
        let latestXmin = iv.xmin;
        let latestXmax = iv.xmax;
        let latestBand = band;
        let latestBandIdx = bandIdx;
        let stickyStartTime: number | null = null;
        let stickyEndTime: number | null = null;
        let lastClientX = e.clientX;
        let lastClientY = e.clientY;
        let dragActive = true;
        let moveSeq = 0;

        const updateMoveAt = async (clientX: number, clientY: number) => {
          const seq = ++moveSeq;
          const curLayout = layoutRef.current;
          const curPt = svgPointFromEvent({ clientX, clientY });
          const activeBand = resolveBandAtY(curLayout, curPt.y, band);
          const activeTl = activeBand.tiersLayout[ti];
          if (!activeTl) return;
          const activeVi = activeTl.visibleIvs?.find((v) => v.iv.origIdx === ii);
          const laneY0 = activeVi
            ? activeTl.y + (activeTl.laneOffsets?.[activeVi.iv.lane] || 0)
            : activeTl.y;
          const laneY1 = activeVi
            ? laneY0 + (activeTl.laneHeights?.[activeVi.iv.lane] || activeTl.h)
            : activeTl.y + activeTl.h;

          const dt = timeFromElasticX(activeBand, curPt.x) - startDragT;
          const rawNewXmin = Math.max(minXmin, Math.min(maxXmin, iv.xmin + dt));
          const rawNewXmax = rawNewXmin + dur;

          let newXmin = rawNewXmin;
          let newXmax = rawNewXmax;
          let startSnapVisual: EdgeSnapVisual | null = null;
          let endSnapVisual: EdgeSnapVisual | null = null;
          let snappedStart = false;
          let snappedEnd = false;

          if (zKeyDownRef.current && analysis) {
            stickyStartTime = null;
            stickyEndTime = null;
            const leadingRight = dt >= 0;
            const targetEdgeT = leadingRight ? rawNewXmax : rawNewXmin;
            const zt = await getPlatformBridge().findZeroCrossing(
              analysis.sessionId,
              targetEdgeT,
              0.008
            );
            if (!dragActive || seq !== moveSeq) return;
            const candidateXmin = leadingRight ? zt - dur : zt;
            newXmin = Math.max(minXmin, Math.min(maxXmin, candidateXmin));
            newXmax = newXmin + dur;
            if (leadingRight) {
              snappedEnd = true;
              endSnapVisual = {
                x: elasticXInBand(activeBand, newXmax),
                linX: activeBand.linearXForTime(newXmax),
                label: '已吸附过零'
              };
            } else {
              snappedStart = true;
              startSnapVisual = {
                x: elasticXInBand(activeBand, newXmin),
                linX: activeBand.linearXForTime(newXmin),
                label: '已吸附过零'
              };
            }
          } else {
            const dual = resolveDualEdgeSnap({
              tg,
              band: activeBand,
              rawXmin: rawNewXmin,
              duration: dur,
              fromSpec: false,
              minXmin,
              maxXmax,
              activeTierIndex: ti,
              excludeStartTime: iv.xmin,
              excludeEndTime: iv.xmax,
              slotEdges,
              playRange,
              currentTime,
              showPlayhead,
              bypassAlt: altKeyDownRef.current,
              stickyStartTime,
              stickyEndTime,
              hiddenTierIndices
            });
            newXmin = dual.newXmin;
            newXmax = dual.newXmax;
            startSnapVisual = snapToEdgeVisual(dual.startSnap);
            endSnapVisual = snapToEdgeVisual(dual.endSnap);
            snappedStart = Boolean(dual.startSnap);
            snappedEnd = Boolean(dual.endSnap);
            stickyStartTime = dual.startSnap?.t ?? null;
            stickyEndTime = dual.endSnap?.t ?? null;
          }

          if (!dragActive || seq !== moveSeq) return;
          if (!snappedStart && !snappedEnd) {
            newXmin = Math.max(minXmin, Math.min(maxXmin, Number(newXmin.toFixed(6))));
            newXmax = dur >= 1e-5 ? Number((newXmin + dur).toFixed(6)) : newXmin + dur;
            if (newXmax > maxXmax) {
              newXmax = maxXmax;
              newXmin = Math.max(minXmin, newXmax - dur);
            }
          } else if (snappedStart && !snappedEnd) {
            newXmax = dur >= 1e-5 ? Number((newXmin + dur).toFixed(6)) : newXmin + dur;
            if (newXmax > maxXmax) newXmax = maxXmax;
          } else if (snappedEnd && !snappedStart) {
            newXmin = dur >= 1e-5 ? Number((newXmax - dur).toFixed(6)) : newXmax - dur;
            if (newXmin < minXmin) newXmin = minXmin;
          }

          latestXmin = newXmin;
          latestXmax = newXmax;
          latestBand = activeBand;
          latestBandIdx = activeBand.bandIndex;

          const clampedXmin = Math.max(activeBand.startT, Math.min(activeBand.endT, latestXmin));
          const clampedXmax = Math.max(activeBand.startT, Math.min(activeBand.endT, latestXmax));
          const x0 = startSnapVisual ? startSnapVisual.x : elasticXInBand(activeBand, clampedXmin);
          const x1 = endSnapVisual ? endSnapVisual.x : elasticXInBand(activeBand, clampedXmax);
          const linX0 = startSnapVisual ? startSnapVisual.linX : activeBand.linearXForTime(clampedXmin);
          const linX1 = endSnapVisual ? endSnapVisual.linX : activeBand.linearXForTime(clampedXmax);

          const compressWarningSide: 'left' | 'right' | null =
            latestXmin < iv.xmin - 1e-6 && prevIv && !prevIsEmpty
              ? 'left'
              : latestXmax > iv.xmax + 1e-6 && nextIv && !nextIsEmpty
                ? 'right'
                : null;

          setIntervalDragPreview({
            bandIndex: activeBand.bandIndex,
            tierIndex: ti,
            mode: 'move',
            tStart: latestXmin,
            tEnd: latestXmax,
            x0,
            x1,
            linX0,
            linX1,
            y0: laneY0,
            y1: laneY1,
            startSnap: startSnapVisual,
            endSnap: endSnapVisual,
            compressWarningSide,
            text: iv.text
          });

          if (audioBuffer && showMicroLoupe) {
            const anchorRight = endSnapVisual && !startSnapVisual ? true : startSnapVisual && !endSnapVisual ? false : dt >= 0;
            const loupeSnapLabel =
              startSnapVisual && endSnapVisual
                ? '双端对齐'
                : (anchorRight ? endSnapVisual?.label : startSnapVisual?.label) ??
                  startSnapVisual?.label ??
                  endSnapVisual?.label ??
                  null;
            setLoupeAnchor({
              centerT: anchorRight ? latestXmax : latestXmin,
              anchorX: anchorRight ? x1 : x0,
              anchorTopY: laneY0,
              anchorBottomY: laneY1,
              snapLabel: loupeSnapLabel
            });
          }
        };

        const onMove = (ev: PointerEvent) => {
          lastClientX = ev.clientX;
          lastClientY = ev.clientY;
          altKeyDownRef.current = ev.altKey;
          if (!moved && Math.abs(ev.clientX - startClientX) < 5) return;
          if (!moved) {
            moved = true;
            draggingRef.current = true;
            clearHoverGuide();
            prevBodyCursor = document.body.style.cursor;
            document.body.style.cursor = 'grabbing';
          }
          void updateMoveAt(ev.clientX, ev.clientY);
        };

        const onModKey = (ev: KeyboardEvent) => {
          if (ev.type === 'keydown' && ev.key === 'Escape') {
            ev.preventDefault();
            cleanup(false);
            return;
          }
          if (ev.code === 'KeyZ' || ev.key === 'z' || ev.key === 'Z') {
            zKeyDownRef.current = ev.type === 'keydown';
            if (moved) void updateMoveAt(lastClientX, lastClientY);
          } else if (ev.key === 'Alt') {
            ev.preventDefault();
            altKeyDownRef.current = ev.type === 'keydown';
            if (moved) void updateMoveAt(lastClientX, lastClientY);
          }
        };

        const cleanup = (commit: boolean) => {
          if (!dragActive) return;
          dragActive = false;
          draggingRef.current = false;
          if (moved) {
            document.body.style.cursor = prevBodyCursor;
          }
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
          window.removeEventListener('keydown', onModKey);
          window.removeEventListener('keyup', onModKey);
          window.removeEventListener('blur', onCancel);
          setIntervalDragPreview(null);
          setLoupeAnchor(null);

          if (commit && !moved) {
            maybeAutoOpenInspector();
            if (startedWithAlt && iv.xmax > iv.xmin) {
              setPlayRange({ start: iv.xmin, end: iv.xmax });
              onStartPlayback(iv.xmin, iv.xmax);
            }
          } else if (commit && moved && Math.abs(latestXmin - iv.xmin) > 1e-9) {
            const dropPrev = Boolean(prevIsEmpty && prevIv && latestXmin - prevIv.xmin <= 1e-9);
            const dropNext = Boolean(nextIsEmpty && nextIv && nextIv.xmax - latestXmax <= 1e-9);
            const finalXmin = dropPrev && prevIv ? prevIv.xmin : latestXmin;
            const finalXmax = dropNext && nextIv ? nextIv.xmax : latestXmax;

            captureDragAnchor(latestBand, latestBandIdx, (finalXmin + finalXmax) / 2);
            const nextSel: EditorSelection = {
              kind: 'interval',
              tierIndex: ti,
              itemIndex: dropPrev ? Math.max(0, ii - 1) : ii,
              bandIndex: latestBandIdx
            };
            commitTgMutation(
              (draft) => {
                const draftTier = draft.tiers[ti];
                if (!draftTier || draftTier.kind !== 'intervalTier') return;
                const targetIv = draftTier.intervals[ii];
                if (!targetIv) return;
                targetIv.xmin = finalXmin;
                targetIv.xmax = finalXmax;
                if (dropNext) {
                  draftTier.intervals.splice(ii + 1, 1);
                } else if (nextIv && draftTier.intervals[ii + 1]) {
                  draftTier.intervals[ii + 1].xmin = finalXmax;
                }
                if (dropPrev) {
                  draftTier.intervals.splice(ii - 1, 1);
                } else if (prevIv && draftTier.intervals[ii - 1]) {
                  draftTier.intervals[ii - 1].xmax = finalXmin;
                }
              },
              nextSel,
              '平移区间'
            );
            setPlayRange({ start: finalXmin, end: finalXmax });
            if (!useEditorStore.getState().playing) {
              setPlaybackTime(finalXmin, true);
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
        e.preventDefault();
        const ti = parseInt(el.getAttribute('data-tier') || '0', 10);
        const tier = tg.tiers[ti];
        if (!tier || tier.kind !== 'textTier') return;
        const hs = hoverSnapRef.current;
        let snapT: number | null = null;
        if (!e.altKey && hs && hs.bandIdx === bandIdx && hs.ti === ti) {
          snapT = hs.time;
        } else {
          const hit = resolveSnap({
            tg,
            band,
            pointerX: pt.x,
            fromSpec: false,
            minAllowed: Math.max(tier.xmin, band.startT),
            maxAllowed: Math.min(tier.xmax, band.endT),
            allowEndpoints: true,
            activeTierIndex: ti,
            playRange,
            currentTime,
            showPlayhead,
            bypassAlt: e.altKey,
            hiddenTierIndices
          });
          if (hit) snapT = hit.t;
        }
        const targetT = snapT !== null ? snapT : timeFromElasticX(band, pt.x);
        const idx = addPointAt(ti, targetT, { exact: snapT !== null });
        if (idx !== null) {
          maybeAutoOpenInspector();
          pendingInlineOpenRef.current = { kind: 'point', tierIndex: ti, itemIndex: idx };
        }
        return;
      }

      if ((role === 'linear-bar' || role === 'spec-area') && band) {
        e.preventDefault();
        // In edit mode, clicking directly on a nearby spectrogram boundary drags that boundary!
        if (role === 'spec-area' && mode === 'edit') {
          const hit = findNearbySpecBoundary(
            tg,
            selection,
            lastActiveTierIndex,
            band,
            pt.x,
            hiddenTierIndices
          );
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
        const prevBodyCursor = document.body.style.cursor;
        document.body.style.cursor = 'var(--cursor-time-ibeam)';

        const startSnap = resolveSnap({
          tg,
          band,
          pointerX: pt.x,
          fromSpec: true,
          minAllowed: tg.xmin,
          maxAllowed: tg.xmax,
          allowEndpoints: true,
          currentTime,
          showPlayhead,
          bypassAlt: e.altKey,
          hiddenTierIndices
        });
        const t0 = startSnap
          ? startSnap.t
          : Math.max(tg.xmin, Math.min(tg.xmax, timeFromLinearX(band, pt.x)));
        const startClientX = e.clientX;
        let dragged = false;
        let latestT = t0;
        let stickyEndTime: number | null = null;
        let sweepActive = true;

        if (!(mode === 'edit' && selection?.kind === 'tier')) {
          setSelection(null);
        }
        setPlaybackTime(t0, true);

        const onMove = (ev: PointerEvent) => {
          if (!sweepActive) return;
          if (!dragged && Math.abs(ev.clientX - startClientX) < 4) return;
          dragged = true;
          const curPt = svgPointFromEvent(ev);
          const activeBand = resolveBandAtY(layoutRef.current, curPt.y, band);
          const endSnap = resolveSnap({
            tg,
            band: activeBand,
            pointerX: curPt.x,
            fromSpec: true,
            minAllowed: tg.xmin,
            maxAllowed: tg.xmax,
            allowEndpoints: true,
            currentTime,
            showPlayhead,
            bypassAlt: ev.altKey,
            stickyTime: stickyEndTime,
            hiddenTierIndices
          });
          stickyEndTime = endSnap?.t ?? null;
          const t1 = endSnap
            ? endSnap.t
            : Math.max(tg.xmin, Math.min(tg.xmax, timeFromLinearX(activeBand, curPt.x)));
          latestT = t1;
          const a = Math.min(t0, t1);
          const b = Math.max(t0, t1);
          if (b - a >= 0.001) {
            setPlayRange({ start: a, end: b });
            setPlaybackTime(a, true);
          }
        };

        const cleanupSweep = (commit: boolean) => {
          if (!sweepActive) return;
          sweepActive = false;
          draggingRef.current = false;
          document.body.style.cursor = prevBodyCursor;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
          window.removeEventListener('keydown', onKey);
          window.removeEventListener('blur', onCancel);
          if (!commit || !dragged || Math.abs(latestT - t0) < 0.001) {
            setPlayRange(null);
            setPlaybackTime(t0, true);
          } else {
            const a = Math.min(t0, latestT);
            const b = Math.max(t0, latestT);
            setPlayRange({ start: a, end: b });
            setPlaybackTime(a, true);
          }
        };
        const onUp = () => cleanupSweep(true);
        const onCancel = () => cleanupSweep(false);
        const onKey = (ev: KeyboardEvent) => {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            cleanupSweep(false);
          }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        window.addEventListener('keydown', onKey);
        window.addEventListener('blur', onCancel);
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

        if ((role === 'spec-area' || role === 'linear-bar') && band) {
          const clickT = Math.max(tg.xmin, Math.min(tg.xmax, timeFromLinearX(band, pt.x)));
          const hasRange = Boolean(playRange && playRange.end - playRange.start >= 0.001);
          const targetTi = getTargetIntervalTierIndex(
            tg,
            selection,
            lastActiveTierIndex,
            hiddenTierIndices,
            band.finestIntervalTierIdx
          );
          if (hasRange && playRange) {
            items.push(
              {
                label: '播放选区',
                shortcut: 'R',
                action: () => onStartPlayback(playRange.start, playRange.end)
              },
              {
                label: '循环播放',
                shortcut: 'L',
                action: () => {
                  setLoop(true);
                  onStartPlayback(playRange.start, playRange.end);
                }
              }
            );
          } else {
            items.push({
              label: `从此处播放 (${clickT.toFixed(3)} s)`,
              action: () => {
                setPlayRange(null);
                onStartPlayback(clickT, tg.xmax);
              }
            });
          }
          items.push({ divider: true });
          if (isEdit) {
            items.push({
              label: '按当前框选创建区间',
              shortcut: 'I',
              disabled: !hasRange || targetTi < 0,
              action: () => {
                if (targetTi >= 0) createIntervalFromPlayRange(targetTi, bandIdx);
              }
            });
          }
          items.push(
            {
              label: '局部放大到此段',
              shortcut: 'F',
              disabled: !hasRange,
              action: () => {
                if (playRange) setViewDomain({ min: playRange.start, max: playRange.end });
              }
            },
            {
              label: '恢复全长',
              shortcut: 'Shift+F',
              disabled: !viewDomain,
              action: () => setViewDomain(null)
            },
            { divider: true },
            {
              label: '导出此段插图…',
              action: () => openExportModal(hasRange ? 'selection' : 'view')
            }
          );
        } else if (role === 'interval') {
          const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
          const ii = parseInt(target.getAttribute('data-idx') || '0', 10);
          const tier = tg.tiers[ti];
          const iv = tier?.intervals[ii];
          if (iv) {
            setSelection({ kind: 'interval', tierIndex: ti, itemIndex: ii, bandIndex: bandIdx });
            if (isEdit) {
              const splitSnap =
                band && iv.xmax > iv.xmin
                  ? resolveSnap({
                      tg,
                      band,
                      pointerX: pt.x,
                      fromSpec: false,
                      minAllowed: iv.xmin,
                      maxAllowed: iv.xmax,
                      allowEndpoints: false,
                      activeTierIndex: ti,
                      playRange,
                      currentTime,
                      showPlayhead,
                      bypassAlt: false,
                      hiddenTierIndices
                    })
                  : null;
              const splitTargetT = splitSnap
                ? splitSnap.t
                : band
                  ? Number(timeFromElasticX(band, pt.x).toFixed(6))
                  : NaN;
              const canCreateFromRange = Boolean(
                iv.text === '' &&
                  iv.xmax > iv.xmin &&
                  playRange &&
                  playRange.end - playRange.start >= 0.001 &&
                  iv.xmin <= playRange.start + 1e-6 &&
                  iv.xmax >= playRange.end - 1e-6
              );
              if (canCreateFromRange) {
                items.push({
                  label: '按当前框选创建区间',
                  shortcut: 'I',
                  action: () => createIntervalFromPlayRange(ti, bandIdx)
                });
              }

              const otherIntervalTiers = tg.tiers
                .map((t, idx) => ({ t, idx }))
                .filter(({ t, idx }) => idx !== ti && t.kind === 'intervalTier');

              const copySpanChildren: ContextMenuItem[] = [];
              otherIntervalTiers.forEach(({ t, idx: targetTi }, pos) => {
                const name = t.name || `层 ${targetTi + 1}`;
                if (pos > 0) copySpanChildren.push({ divider: true });
                copySpanChildren.push(
                  {
                    label: `→「${name}」（含文本）`,
                    action: () => copyIntervalSpanToTier(ti, ii, targetTi, true)
                  },
                  {
                    label: `→「${name}」（仅边界）`,
                    action: () => copyIntervalSpanToTier(ti, ii, targetTi, false)
                  }
                );
              });

              items.push(
                { label: '编辑文本', shortcut: '双击', action: () => openInline({ kind: 'interval', tierIndex: ti, itemIndex: ii }) },
                {
                  label: splitSnap ? `在此处切分（${splitSnap.label}）` : '在此处切分',
                  disabled: !(splitTargetT > iv.xmin && splitTargetT < iv.xmax),
                  action: () => splitInterval(ti, ii, splitTargetT, { exact: Boolean(splitSnap) })
                },
                { label: '从正中切分', shortcut: 'S', disabled: iv.xmax <= iv.xmin, action: () => splitInterval(ti, ii) },
                {
                  label: '等分为 2 段',
                  disabled: iv.xmax <= iv.xmin,
                  action: () => splitIntervalEqualN(ti, ii, 2)
                },
                {
                  label: '等分为 3 段',
                  disabled: iv.xmax <= iv.xmin,
                  action: () => splitIntervalEqualN(ti, ii, 3)
                },
                {
                  label: '等分为 N 段…',
                  disabled: iv.xmax <= iv.xmin,
                  action: () => {
                    const raw = window.prompt('请输入等分段数（2–20）：', '4');
                    if (raw === null) return;
                    const n = parseInt(raw.trim(), 10);
                    splitIntervalEqualN(ti, ii, n);
                  }
                },
                { divider: true },
                { label: '向左合并', shortcut: 'Shift+M', disabled: ii === 0, action: () => mergeIntervalWith(ti, ii, -1) },
                { label: '向右合并', shortcut: 'M', disabled: ii >= tier.intervals.length - 1, action: () => mergeIntervalWith(ti, ii, 1) },
                ...(otherIntervalTiers.length > 0
                  ? [
                      {
                        label: '复制到层 ▸',
                        disabled: iv.xmax <= iv.xmin,
                        children: copySpanChildren
                      }
                    ]
                  : []),
                {
                  label: '清空文本',
                  shortcut: 'Del',
                  disabled: iv.text === '',
                  action: () =>
                    commitTgMutation(
                      (d) => {
                        d.tiers[ti].intervals[ii].text = '';
                      },
                      { kind: 'interval', tierIndex: ti, itemIndex: ii, bandIndex: bandIdx },
                      '清空区间文本'
                    )
                },
                { divider: true }
              );
            }
            const isZoomedHere = Boolean(
              viewDomain && Math.abs(viewDomain.min - iv.xmin) < 1e-4 && Math.abs(viewDomain.max - iv.xmax) < 1e-4
            );
            items.push(
              {
                label: '播放该区间',
                shortcut: 'R',
                disabled: iv.xmax <= iv.xmin,
                action: () => {
                  setPlayRange({ start: iv.xmin, end: iv.xmax });
                  onStartPlayback(iv.xmin, iv.xmax);
                }
              },
              {
                label: '带语境播放 (±250 ms)',
                shortcut: 'Shift+R',
                disabled: iv.xmax <= iv.xmin,
                action: () => {
                  const s = Math.max(tg.xmin, iv.xmin - 0.25);
                  const en = Math.min(tg.xmax, iv.xmax + 0.25);
                  if (en > s) onStartPlayback(s, en);
                }
              },
              {
                label: '循环播放该区间',
                disabled: iv.xmax <= iv.xmin,
                action: () => {
                  setLoop(true);
                  setPlayRange({ start: iv.xmin, end: iv.xmax });
                  onStartPlayback(iv.xmin, iv.xmax);
                }
              },
              isZoomedHere
                ? { label: '显示全长视图', shortcut: 'F', action: () => setViewDomain(null) }
                : { label: '放大查看该区间', shortcut: 'F', disabled: iv.xmax <= iv.xmin, action: () => setViewDomain({ min: iv.xmin, max: iv.xmax }) },
              { divider: true },
              { label: '复制文本', shortcut: formatKeyCombo('Mod+C'), disabled: iv.text === '', action: () => copyText(iv.text, '区间文本') },
              {
                label: '复制起止时间',
                shortcut: formatKeyCombo('Mod+Shift+C'),
                action: () => copyText(`${formatPraatDouble(iv.xmin)}\t${formatPraatDouble(iv.xmax)}`, '起止时间')
              }
            );
            if (!isEdit) items.push({ divider: true }, { label: '切换到编辑模式', shortcut: 'E', action: () => setMode('edit') });
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
                { label: '复制标记文本', shortcut: formatKeyCombo('Mod+C'), disabled: p.mark === '', action: () => copyText(p.mark, '标记文本') },
                { label: '复制时间戳', action: () => copyText(formatPraatDouble(p.number), '时间戳') },
                { divider: true },
                {
                  label: '删除此点',
                  shortcut: 'Del',
                  danger: true,
                  action: () =>
                    commitTgMutation(
                      (d) => {
                        d.tiers[ti].points.splice(pi, 1);
                      },
                      null,
                      '删除标点'
                    )
                }
              );
            } else {
              items.push(
                { label: '从此点播放', action: () => { setPlayRange(null); onStartPlayback(p.number, tg.xmax); } },
                { label: '复制标记文本', disabled: p.mark === '', action: () => copyText(p.mark, '标记文本') },
                { label: '复制时间戳', action: () => copyText(formatPraatDouble(p.number), '时间戳') },
                { divider: true },
                { label: '切换到编辑模式', shortcut: 'E', action: () => setMode('edit') }
              );
            }
          }
        } else if (role === 'boundary') {
          const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
          const time = parseFloat(target.getAttribute('data-time') || '0');
          if (Number.isFinite(time)) {
            const auditionBoundary = () => {
              const s = Math.max(tg.xmin, time - 0.2);
              const en = Math.min(tg.xmax, time + 0.2);
              if (en > s) onStartPlayback(s, en);
            };
            if (isEdit) {
              setSelection({ kind: 'boundary', tierIndex: ti, time, bandIndex: bandIdx });
              const otherIntervalTiers = tg.tiers
                .map((t, idx) => ({ t, idx }))
                .filter(({ t, idx }) => idx !== ti && t.kind === 'intervalTier');
              items.push(
                { label: '试听跨越边界 (±200 ms)', action: auditionBoundary },
                { label: '从此处播放', action: () => { setPlayRange(null); onStartPlayback(time, tg.xmax); } },
                { label: '复制边界时间', action: () => copyText(formatPraatDouble(time), '边界时间') },
                { divider: true },
                {
                  label: '吸附最近过零点',
                  shortcut: 'Z',
                  disabled: !analysis,
                  action: () => void snapTargetToZeroCrossing({ kind: 'boundary', tierIndex: ti, time, bandIndex: bandIdx })
                },
                ...(otherIntervalTiers.length > 0
                  ? [
                      {
                        label: '将边界复制到层 ▸',
                        children: otherIntervalTiers.map(({ t, idx: targetTi }) => ({
                          label: `→「${t.name || `层 ${targetTi + 1}`}」`,
                          action: () => projectBoundaryToTier(targetTi, time)
                        }))
                      }
                    ]
                  : []),
                { divider: true },
                { label: '删除边界（合并两侧）', shortcut: 'Del', danger: true, action: () => deleteBoundaryAt(ti, time) },
                {
                  label: '跨层删除对齐边界',
                  shortcut: 'Shift+Del',
                  danger: true,
                  action: () => deleteBoundaryAcrossAllTiers(time)
                }
              );
            } else {
              items.push(
                { label: '试听跨越边界 (±200 ms)', action: auditionBoundary },
                { label: '从此处播放', action: () => { setPlayRange(null); onStartPlayback(time, tg.xmax); } },
                { label: '复制边界时间', action: () => copyText(formatPraatDouble(time), '边界时间') },
                { divider: true },
                { label: '切换到编辑模式', shortcut: 'E', action: () => setMode('edit') }
              );
            }
          }
        } else if (role === 'texttier-wire') {
          const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
          const tier = tg.tiers[ti];
          const wireSnap =
            band && tier && isEdit
              ? resolveSnap({
                  tg,
                  band,
                  pointerX: pt.x,
                  fromSpec: false,
                  minAllowed: Math.max(tier.xmin, band.startT),
                  maxAllowed: Math.min(tier.xmax, band.endT),
                  allowEndpoints: true,
                  activeTierIndex: ti,
                  playRange,
                  currentTime,
                  showPlayhead,
                  bypassAlt: false,
                  hiddenTierIndices
                })
              : null;
          const clickT = wireSnap
            ? wireSnap.t
            : band
              ? Number(timeFromElasticX(band, pt.x).toFixed(6))
              : 0;
          if (isEdit) {
            items.push({
              label: wireSnap
                ? `在此处添加标点 (${clickT.toFixed(3)} s · ${wireSnap.label})`
                : `在此处添加标点 (${clickT.toFixed(3)} s)`,
              action: () => {
                const idx = addPointAt(ti, clickT, { exact: Boolean(wireSnap) });
                if (idx !== null) {
                  maybeAutoOpenInspector();
                  pendingInlineOpenRef.current = { kind: 'point', tierIndex: ti, itemIndex: idx };
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
            items.push({ divider: true }, { label: '切换到编辑模式', shortcut: 'E', action: () => setMode('edit') });
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
            if (isEdit) {
              items.push(
                { divider: true },
                {
                  label: '跨层吸附过零点',
                  shortcut: 'Z',
                  disabled: !analysis,
                  action: () => void snapTargetToZeroCrossing({ kind: 'spine', time: t, bandIndex: bandIdx })
                },
                {
                  label: '跨层删除对齐边界',
                  shortcut: 'Shift+Del',
                  danger: true,
                  action: () => deleteBoundaryAcrossAllTiers(t)
                }
              );
            }
          }
        } else if (role === 'tier-header') {
          const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
          const tier = tg.tiers[ti];
          if (isEdit && tier) {
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
              { label: '复制层级（含文本）', action: () => duplicateTier(ti, { copyText: true }) },
              {
                label: '仅复制边界新建层',
                disabled: tier.kind !== 'intervalTier',
                action: () => duplicateTier(ti, { copyText: false })
              },
              {
                label: '从区间派生点层（中点）',
                disabled: tier.kind !== 'intervalTier',
                action: () => derivePointTierFromIntervals(ti, 'mid')
              },
              {
                label: '对齐微偏边界 (< 5 ms)',
                action: () => {
                  const n = alignMicroBoundaries(ti, 0.005);
                  showToast(n > 0 ? `已对齐 ${n} 处微偏边界` : '未发现 < 5 ms 的微偏边界');
                }
              },
              { divider: true },
              { label: '隐藏此层', action: () => toggleTierVisibility(ti) },
              { label: '清空本层文本', action: () => clearTierText(ti) },
              { label: '删除该层', shortcut: 'Shift+Del', danger: true, action: () => removeTierWithUndoToast(ti) }
            );
          } else if (tier) {
            items.push(
              { label: '复制层名', disabled: !tier.name, action: () => copyText(tier.name, '层名') },
              { label: '隐藏此层', action: () => toggleTierVisibility(ti) },
              { divider: true },
              {
                label: '切换到编辑模式',
                shortcut: 'E',
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
      const estHeight = items.reduce((acc, it) => acc + (it.divider ? 7 : 30), 12);
      const x = Math.max(8, Math.min(e.clientX, window.innerWidth - 220));
      const y = Math.max(8, Math.min(e.clientY, window.innerHeight - estHeight - 12));
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
      mode === 'edit' &&
      showFloatingBar &&
      selection &&
      !inlineTarget &&
      !dragPreview &&
      !intervalDragPreview
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
      if (isComposingEvent(e)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.currentTarget.blur();
      }
    };

    const activeTab = useMemo(
      () => tabs.find((t) => t.id === activeTabId) ?? null,
      [tabs, activeTabId]
    );
    const showBlankQuickStart = Boolean(
      activeTab?.isBlankPlaceholder && !dismissedBlankTabIds.has(activeTab.id)
    );

    return (
      <div
        className="stage-inner-wrap"
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          overflow: 'hidden'
        }}
      >
        {showBlankQuickStart && activeTab && (
          <div className="blank-quickstart-strip" role="status">
            <div className="blank-quickstart-content">
              <span>
                拖入 <strong>.wav</strong> / <strong>.TextGrid</strong> 文件，或在空白槽内拖拽划出新区间 · 按{' '}
                <kbd>?</kbd> 查看快捷键
              </span>
            </div>
            <button
              type="button"
              className="blank-quickstart-dismiss"
              onClick={() =>
                setDismissedBlankTabIds((prev) => {
                  const next = new Set(prev);
                  next.add(activeTab.id);
                  return next;
                })
              }
            >
              知道了
            </button>
          </div>
        )}

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
              onPointerLeave={() => {
                lastPointerRef.current = null;
                clearHoverGuide();
              }}
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
                  const durMs = Math.max(0, Math.round((iv.xmax - iv.xmin) * 1000));
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
                            const raw = parseFloat(e.target.value);
                            if (!Number.isFinite(raw)) {
                              e.target.value = formatPraatDouble(iv.xmin);
                              return;
                            }
                            const val = Number(raw.toFixed(6));
                            const prev = tier.intervals[selection.itemIndex - 1];
                            if (val >= iv.xmax) {
                              showToast('起点必须严格小于终点', true);
                              e.target.value = formatPraatDouble(iv.xmin);
                              return;
                            }
                            if (prev && prev.xmax === iv.xmin && val <= prev.xmin) {
                              showToast('起点不能越过左侧相邻区间', true);
                              e.target.value = formatPraatDouble(iv.xmin);
                              return;
                            }
                            if (val !== iv.xmin) {
                              commitTgMutation(
                                (draft) => {
                                  const dTier = draft.tiers[selection.tierIndex];
                                  const dPrev = dTier.intervals[selection.itemIndex - 1];
                                  const cur = dTier.intervals[selection.itemIndex];
                                  if (dPrev && dPrev.xmax === cur.xmin && val > dPrev.xmin) dPrev.xmax = val;
                                  cur.xmin = val;
                                },
                                undefined,
                                '修改区间起点'
                              );
                              setPlayRange({ start: val, end: iv.xmax });
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
                            const raw = parseFloat(e.target.value);
                            if (!Number.isFinite(raw)) {
                              e.target.value = formatPraatDouble(iv.xmax);
                              return;
                            }
                            const val = Number(raw.toFixed(6));
                            const next = tier.intervals[selection.itemIndex + 1];
                            if (val <= iv.xmin) {
                              showToast('终点必须严格大于起点', true);
                              e.target.value = formatPraatDouble(iv.xmax);
                              return;
                            }
                            if (next && next.xmin === iv.xmax && val >= next.xmax) {
                              showToast('终点不能越过右侧相邻区间', true);
                              e.target.value = formatPraatDouble(iv.xmax);
                              return;
                            }
                            if (val !== iv.xmax) {
                              commitTgMutation(
                                (draft) => {
                                  const dTier = draft.tiers[selection.tierIndex];
                                  const dNext = dTier.intervals[selection.itemIndex + 1];
                                  const cur = dTier.intervals[selection.itemIndex];
                                  if (dNext && dNext.xmin === cur.xmax && val < dNext.xmax) dNext.xmin = val;
                                  cur.xmax = val;
                                },
                                undefined,
                                '修改区间终点'
                              );
                              setPlayRange({ start: iv.xmin, end: val });
                            }
                          }}
                        />
                      </label>
                      <span
                        className="floating-dur-badge"
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '10.5px',
                          color: '#C2BEB4',
                          fontVariantNumeric: 'tabular-nums',
                          padding: '0 3px'
                        }}
                      >
                        {durMs} ms
                      </span>
                      <div className="sep" />
                      <button type="button" className="compact" onClick={() => openInline(selection)}>
                        <UiIcon name="edit" size={13} />
                        <span>改字</span>
                      </button>
                      {iv.text !== '' && (
                        <button
                          type="button"
                          className="compact"
                          onClick={() =>
                            commitTgMutation(
                              (d) => {
                                d.tiers[selection.tierIndex].intervals[selection.itemIndex].text = '';
                              },
                              selection,
                              '清空区间文本'
                            )
                          }
                        >
                          <UiIcon name="clear" size={13} />
                          <span>清空</span>
                        </button>
                      )}
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
                            const raw = parseFloat(e.target.value);
                            if (!Number.isFinite(raw)) {
                              e.target.value = formatPraatDouble(pt.number);
                              return;
                            }
                            const val = Number(raw.toFixed(6));
                            if (tier.points.some((p, i) => i !== selection.itemIndex && p.number === val)) {
                              showToast('目标时刻已存在标点', true);
                              e.target.value = formatPraatDouble(pt.number);
                              return;
                            }
                            if (val !== pt.number) {
                              let nextIdx = selection.itemIndex;
                              commitTgMutation(
                                (draft) => {
                                  const dTier = draft.tiers[selection.tierIndex];
                                  const targetPt = dTier.points[selection.itemIndex];
                                  if (!targetPt) return;
                                  targetPt.number = val;
                                  dTier.points.sort((a, b) => a.number - b.number);
                                  nextIdx = dTier.points.indexOf(targetPt);
                                },
                                undefined,
                                '修改标点时间'
                              );
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
                          commitTgMutation(
                            (draft) => {
                              draft.tiers[selection.tierIndex].points.splice(selection.itemIndex, 1);
                            },
                            null,
                            '删除标点'
                          )
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
                          const raw = parseFloat(e.target.value);
                          const val = Number.isFinite(raw) ? Number(raw.toFixed(6)) : NaN;
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
                      className="compact"
                      disabled={!analysis}
                      title="吸附最近音频过零点 (Z)"
                      onClick={() => void snapTargetToZeroCrossing(selection)}
                    >
                      <UiIcon name="zeroCross" size={13} />
                      <span>过零</span>
                    </button>
                    <button
                      type="button"
                      className="compact"
                      onClick={() => {
                        const s = Math.max(tg.xmin, selection.time - 0.2);
                        const en = Math.min(tg.xmax, selection.time + 0.2);
                        if (en > s) onStartPlayback(s, en);
                      }}
                    >
                      <UiIcon name="play" size={13} />
                      <span>试听 ±200ms</span>
                    </button>
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
                  <>
                    <label className="field-inline">
                      对齐时刻
                      <input
                        type="number"
                        step="any"
                        defaultValue={formatPraatDouble(selection.time)}
                        key={`sp-${selection.time}`}
                        onKeyDown={blurOnEnter}
                        onBlur={(e) => {
                          const raw = parseFloat(e.target.value);
                          const val = Number.isFinite(raw) ? Number(raw.toFixed(6)) : NaN;
                          if (Number.isFinite(val) && moveSharedTimestamp(selection.time, val)) {
                            setSelection({ kind: 'spine', time: val, bandIndex: selection.bandIndex });
                          } else {
                            e.target.value = formatPraatDouble(selection.time);
                          }
                        }}
                      />
                    </label>
                    <div className="sep" />
                    <button
                      type="button"
                      className="compact"
                      disabled={!analysis}
                      title="跨层吸附最近音频过零点 (Z)"
                      onClick={() => void snapTargetToZeroCrossing(selection)}
                    >
                      <UiIcon name="zeroCross" size={13} />
                      <span>过零</span>
                    </button>
                  </>
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
                              commitTgMutation(
                                (d) => {
                                  d.tiers[selection.tierIndex].name = e.target.value;
                                },
                                undefined,
                                '重命名层级'
                              );
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
                            if (!Number.isFinite(val) || val >= tier.xmax) {
                              showToast('起点必须严格小于终点', true);
                              e.target.value = formatPraatDouble(tier.xmin);
                              return;
                            }
                            if (val !== tier.xmin) {
                              commitTgMutation(
                                (d) => {
                                  d.tiers[selection.tierIndex].xmin = val;
                                },
                                undefined,
                                '修改层起点'
                              );
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
                            if (!Number.isFinite(val) || val <= tier.xmin) {
                              showToast('终点必须严格大于起点', true);
                              e.target.value = formatPraatDouble(tier.xmax);
                              return;
                            }
                            if (val !== tier.xmax) {
                              commitTgMutation(
                                (d) => {
                                  d.tiers[selection.tierIndex].xmax = val;
                                },
                                undefined,
                                '修改层终点'
                              );
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
                        onClick={() => removeTierWithUndoToast(selection.tierIndex)}
                      >
                        <UiIcon name="trash" size={13} />
                        <span>删除</span>
                      </button>
                    </>
                  );
                })()}
              </div>
            )}

            {/* Live Dual-Scale (±40 ms / ±150 ms) Floating Acoustic Micro-Loupe */}
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

          {/* Right-Click Context Menu (with flyout submenus) */}
          {ctxMenu && (
            <div className="context-menu open" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
              {ctxMenu.items.map((item, idx) =>
                item.divider ? (
                  <div key={`div-${idx}`} className="menu-divider" />
                ) : item.children && item.children.length > 0 ? (
                  <div
                    key={`${item.label}-${idx}`}
                    style={{ position: 'relative' }}
                    onMouseEnter={() => {
                      if (!item.disabled) setOpenSubmenuIdx(idx);
                    }}
                  >
                    <button
                      type="button"
                      disabled={item.disabled}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (!item.disabled) {
                          setOpenSubmenuIdx((prev) => (prev === idx ? null : idx));
                        }
                      }}
                    >
                      <span>{item.label}</span>
                    </button>
                    {openSubmenuIdx === idx && !item.disabled && (
                      <div
                        className="context-menu open"
                        style={{
                          position: 'absolute',
                          top: -4,
                          ...(ctxMenu.x + 410 > window.innerWidth
                            ? { right: '100%', left: 'auto', marginRight: -1 }
                            : { left: '100%', marginLeft: -1 }),
                          maxHeight: '60vh',
                          overflowY: 'auto'
                        }}
                      >
                        {item.children.map((child, cIdx) =>
                          child.divider ? (
                            <div key={`sub-div-${cIdx}`} className="menu-divider" />
                          ) : (
                            <button
                              key={`${child.label}-${cIdx}`}
                              type="button"
                              className={child.danger ? 'danger' : ''}
                              disabled={child.disabled}
                              onClick={() => {
                                setCtxMenu(null);
                                child.action?.();
                              }}
                            >
                              <span>{child.label}</span>
                              {child.shortcut && <span className="shortcut">{child.shortcut}</span>}
                            </button>
                          )
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    key={`${item.label}-${idx}`}
                    type="button"
                    className={item.danger ? 'danger' : ''}
                    disabled={item.disabled}
                    onMouseEnter={() => setOpenSubmenuIdx(null)}
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
      </div>
    );
  }
);
