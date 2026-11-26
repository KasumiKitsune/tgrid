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
import { getPlatformBridge, isTauriRuntime } from '../bridge/PlatformBridge';
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
import {
  formatKeyCombo,
  getEffectiveShortcutHint,
  isComposingEvent,
  isEditableTarget,
  matchesShortcut
} from '../shortcuts/registry';
import { rgbaToPngDataUrl } from '../render/exporter';
import {
  clampCanvasScale,
  getElementRectScale,
  getLogicalViewportSize,
  getViewportZoom,
  stepCanvasScale
} from '../utils/uiScale';
import {
  formatDeltaTime,
  formatDurationLabel,
  formatQuote,
  formatTierLabel,
  formatTimeSec,
  formatTimeSpan
} from '../store/historyModel';
import {
  getBoundaryBoundsForTier,
  useEditorStore,
  type FloatingBarTarget,
  type SidebarTab
} from '../store/useEditorStore';
import { resolveF0RangeOverride } from '../utils/f0Range';
import { formatAlignMicroFeedback } from '../utils/qaDiagnostics';
import type { TextGrid } from '../bridge/types';
import { SubmenuChevronIcon, UiIcon, type IconName } from './Icons';
import { ScrubNumberInput } from './ScrubNumberInput';
import { IpaImePopover, IpaModePill } from './IpaImePopover';
import { isIpaRelatedElement, useIpaIme } from './useIpaIme';
import { AcousticMicroLoupe, type MicroLoupeAnchor } from './AcousticMicroLoupe';
import { SplitEqualModal, type SplitEqualDialogState } from './SplitEqualModal';

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
  icon?: IconName;
  badge?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  action?: () => void;
  children?: ContextMenuItem[];
}

const FLOATING_FIELD_IDS = new Set([
  'iv-times',
  'iv-dur',
  'pt-time',
  'bnd-time',
  'tier-name',
  'tier-bounds'
]);

function assembleFloatingBarNodes(
  entries: Array<{ id: string; node: React.ReactNode }>
): React.ReactNode[] | null {
  if (entries.length === 0) return null;
  const out: React.ReactNode[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) {
      const prevIsField = FLOATING_FIELD_IDS.has(entries[i - 1].id);
      const curIsField = FLOATING_FIELD_IDS.has(entries[i].id);
      if (prevIsField !== curIsField) {
        out.push(<div key={`sep-${entries[i - 1].id}-${entries[i].id}`} className="sep" />);
      }
    }
    out.push(<React.Fragment key={entries[i].id}>{entries[i].node}</React.Fragment>);
  }
  return out;
}

function isSafeInputShortcutEvent(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey || e.altKey || /^F([1-9]|1[0-9]|2[0-4])$/.test(e.key);
}

const CtxSubmenuPanel: React.FC<{
  items: ContextMenuItem[];
  openLeft: boolean;
  onSelectItem: (child: ContextMenuItem) => void;
  onMouseEnter: () => void;
}> = ({ items, openLeft, onSelectItem, onMouseEnter }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [topOffset, setTopOffset] = useState<number>(-4);

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    el.style.top = '-4px';
    const z = getViewportZoom();
    const rect = el.getBoundingClientRect();
    const overflowBottom = (rect.bottom - (window.innerHeight - 8 * z)) / z;
    if (overflowBottom > 0) {
      const shifted = -4 - overflowBottom;
      const minTop = -4 - Math.max(0, (rect.top - 8 * z) / z);
      const finalTop = Math.round(Math.max(minTop, shifted));
      el.style.top = `${finalTop}px`;
      setTopOffset(finalTop);
    } else {
      setTopOffset(-4);
    }
  }, [items, openLeft]);

  return (
    <div
      ref={panelRef}
      className={`ctx-submenu-panel${openLeft ? ' open-left' : ''}`}
      style={{ top: topOffset }}
      onMouseEnter={onMouseEnter}
    >
      {items.map((child, cIdx) =>
        child.divider ? (
          <div key={`sub-div-${cIdx}`} className="menu-divider" />
        ) : (
          <button
            key={`${child.label}-${cIdx}`}
            type="button"
            className={child.danger ? 'danger' : ''}
            disabled={child.disabled}
            onClick={() => onSelectItem(child)}
          >
            <span>{child.label}</span>
            {child.badge && <span className="ctx-sub-badge">{child.badge}</span>}
            {child.shortcut && <span className="shortcut">{child.shortcut}</span>}
          </button>
        )
      )}
    </div>
  );
};

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
    const widthAutoFit = useEditorStore((s) => s.widthAutoFit);
    const setTargetWidth = useEditorStore((s) => s.setTargetWidth);
    const setWidthAutoFit = useEditorStore((s) => s.setWidthAutoFit);
    const setStageAvailableWidth = useEditorStore((s) => s.setStageAvailableWidth);
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
    const f0RangeMode = useEditorStore((s) => s.f0RangeMode);
    const f0RangeCustom = useEditorStore((s) => s.f0RangeCustom);
    const editInspectorMode = useEditorStore((s) => s.editInspectorMode);
    const showMicroLoupe = useEditorStore((s) => s.showMicroLoupe);
    const uiScale = useEditorStore((s) => s.uiScale);
    const canvasScale = useEditorStore((s) => s.canvasScale);
    const setCanvasScale = useEditorStore((s) => s.setCanvasScale);
    const floatingBarConfig = useEditorStore((s) => s.floatingBarConfig);
    const customShortcuts = useEditorStore((s) => s.customShortcuts);
    const exportOpen = useEditorStore((s) => s.exportOpen);
    const posterOpen = useEditorStore((s) => s.posterOpen);
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
    const lastHistoryNav = useEditorStore((s) => s.lastHistoryNav);
    const showToast = useEditorStore((s) => s.showToast);
    const [splitEqualDialog, setSplitEqualDialog] = useState<SplitEqualDialogState | null>(null);

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
    const spacePanRef = useRef<{
      held: boolean;
      dragging: boolean;
      didDrag: boolean;
      downAt: number;
      shouldTogglePlayOnRelease: boolean;
    }>({
      held: false,
      dragging: false,
      didDrag: false,
      downAt: 0,
      shouldTogglePlayOnRelease: false
    });
    const spacePanDragCleanupRef = useRef<(() => void) | null>(null);
    const suppressNextStageClickRef = useRef(false);
    const onTogglePlayRef = useRef(onTogglePlay);
    onTogglePlayRef.current = onTogglePlay;
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
    const [stageH, setStageH] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 800));
    const [trigraphTick, setTrigraphTick] = useState(0);
    const [specUrls, setSpecUrls] = useState<Map<number, string>>(() => new Map());
    const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
    const [scrubPreviewing, setScrubPreviewing] = useState(false);
    const [intervalDragPreview, setIntervalDragPreview] = useState<IntervalDragPreviewState | null>(null);
    const [loupeAnchor, setLoupeAnchor] = useState<MicroLoupeAnchor | null>(null);
    const [dismissedBlankTabIds, setDismissedBlankTabIds] = useState<Set<string>>(() => new Set());
    const [openSubmenuIdx, setOpenSubmenuIdx] = useState<number | null>(null);
    const submenuCloseTimerRef = useRef<number | null>(null);

    const cancelSubmenuClose = useCallback(() => {
      if (submenuCloseTimerRef.current !== null) {
        window.clearTimeout(submenuCloseTimerRef.current);
        submenuCloseTimerRef.current = null;
      }
    }, []);

    const scheduleSubmenuClose = useCallback(() => {
      cancelSubmenuClose();
      submenuCloseTimerRef.current = window.setTimeout(() => {
        submenuCloseTimerRef.current = null;
        setOpenSubmenuIdx(null);
      }, 120);
    }, [cancelSubmenuClose]);

    useEffect(() => {
      return () => cancelSubmenuClose();
    }, [cancelSubmenuClose]);

    const getVisibleBarItems = useCallback(
      (target: FloatingBarTarget): string[] => {
        const sec = floatingBarConfig[target];
        if (!sec) return [];
        const hiddenSet = new Set(sec.hidden);
        return sec.order.filter((id) => !hiddenSet.has(id));
      },
      [floatingBarConfig]
    );

    const showScrubPreviewLine = useCallback(
      (previewT: number, tierIndex: number, fullBand: boolean) => {
        const curLayout = layoutRef.current;
        if (!curLayout.bands.length || !Number.isFinite(previewT)) return;
        const band =
          curLayout.bands.find((b) => previewT >= b.startT - 1e-9 && previewT <= b.endT + 1e-9) ??
          curLayout.bands[selection?.bandIndex ?? 0] ??
          curLayout.bands[0];
        if (!band) return;
        const clampedT = Math.max(band.startT, Math.min(band.endT, previewT));
        const x = elasticXInBand(band, clampedT);
        const linearX = band.linearXForTime(clampedT);
        const tl = !fullBand ? band.tiersLayout[tierIndex] : undefined;
        const y0 = fullBand || !tl ? band.tiersTopY : tl.y;
        const y1 = fullBand || !tl ? band.tiersBottomY : tl.y + tl.h;
        setScrubPreviewing(true);
        setDragPreview({
          bandIndex: band.bandIndex,
          x,
          linearX,
          y0,
          y1,
          snapX: null,
          snapMode: false,
          snapLabel: null,
          showCompactTag: true,
          time: previewT
        });
      },
      [selection?.bandIndex]
    );

    const clearScrubPreview = useCallback(() => {
      setScrubPreviewing(false);
      setDragPreview(null);
    }, []);

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

    const exitSpacePan = useCallback((allowTogglePlay: boolean) => {
      const pan = spacePanRef.current;
      if (!pan.held) return;
      const shouldPlay =
        allowTogglePlay &&
        pan.shouldTogglePlayOnRelease &&
        !pan.didDrag &&
        performance.now() - pan.downAt < 400;
      pan.held = false;
      pan.dragging = false;
      pan.didDrag = false;
      pan.shouldTogglePlayOnRelease = false;
      spacePanDragCleanupRef.current?.();
      spacePanDragCleanupRef.current = null;
      stageRef.current?.classList.remove('space-pan', 'space-pan-dragging');
      if (shouldPlay) {
        onTogglePlayRef.current();
      } else if (!draggingRef.current && !inlineTargetRef.current && lastPointerRef.current) {
        refreshHoverGuideRef.current();
      }
    }, []);

    // Dedicated Space-pan release & blur guard (isolated from high-frequency currentTime updates)
    useEffect(() => {
      const onSpaceKeyUp = (e: KeyboardEvent) => {
        if ((e.code === 'Space' || e.key === ' ') && spacePanRef.current.held) {
          e.preventDefault();
          exitSpacePan(true);
        }
      };
      const onWindowBlur = () => {
        exitSpacePan(false);
      };
      window.addEventListener('keyup', onSpaceKeyUp);
      window.addEventListener('blur', onWindowBlur);
      return () => {
        window.removeEventListener('keyup', onSpaceKeyUp);
        window.removeEventListener('blur', onWindowBlur);
        exitSpacePan(false);
      };
    }, [exitSpacePan]);

    // Exit Space-pan cleanly if any modal opens
    useEffect(() => {
      if (exportOpen || posterOpen || aboutOpen || shortcutsOpen) {
        exitSpacePan(false);
      }
    }, [exportOpen, posterOpen, aboutOpen, shortcutsOpen, exitSpacePan]);

    const handleInlineUnhandledKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposingEvent(e)) return;
      const isEnter = e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter';
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeInlineRef.current(false);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
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
          e.stopPropagation();
          const cur = inlineTargetRef.current;
          closeInlineRef.current(true);
          if (cur) stepSelectionRef.current(e.key === 'ArrowUp' ? -1 : 1, 'y', true, cur);
        }
      } else if (isEnter && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
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
      cancelSubmenuClose();
      setOpenSubmenuIdx(null);
    }, [ctxMenu, cancelSubmenuClose]);

    // Clear transient UI overlays when switching / closing document tabs
    useEffect(() => {
      pendingDragAnchorRef.current = null;
      pendingInlineOpenRef.current = null;
      hoverSnapRef.current = null;
      setInlineTarget(null);
      setInlineBox(null);
      setCtxMenu(null);
      setScrubPreviewing(false);
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
        setScrubPreviewing(false);
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

    // Stage ResizeObserver (measures unzoomed CSS viewport of #stage so canvasScale is independent of uiScale)
    useEffect(() => {
      const el = stageRef.current;
      if (!el) return;
      const updateSize = () => {
        const z = uiScale > 0 ? uiScale : 1;
        const rect = el.getBoundingClientRect();
        const w = el.clientWidth > 0 ? el.clientWidth * z : rect.width || window.innerWidth;
        const h = el.clientHeight > 0 ? el.clientHeight * z : rect.height || window.innerHeight;
        setStageW(w);
        setStageH(h);
        const sidePad = w < 480 ? 12 : 24;
        setStageAvailableWidth(Math.max(260, Math.round(w - sidePad)));
      };
      updateSize();
      const raf = requestAnimationFrame(updateSize);
      const ro = new ResizeObserver(updateSize);
      ro.observe(el);
      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
      };
    }, [uiScale, setStageAvailableWidth]);

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
      const sidePad = stageW < 480 ? 12 : 24;
      const availableW = Math.max(260, stageW - sidePad);
      const effWidth =
        wrapMode === 'auto'
          ? widthAutoFit
            ? availableW
            : Math.min(targetWidth, availableW)
          : widthAutoFit
            ? availableW
            : targetWidth;
      return computeLayout(tg, {
        wrapMode,
        targetWidth: effWidth,
        hasAudio: Boolean(audioName && audioBuffer),
        audioBuffer,
        audioOffset,
        showSpectrogram,
        tierOrder,
        scaleMode,
        tickPrecision,
        tickFixedDecimals,
        viewDomain,
        mode,
        hiddenTierIndices,
        isInteractive: true,
        floatingBarMode: mode === 'edit' && editInspectorMode === 'floating',
        allowSingleCompress: wrapMode === 'single' && !widthAutoFit,
        viewportHeight: stageH
      });
    }, [
      tg,
      trigraphTick,
      stageW,
      stageH,
      wrapMode,
      targetWidth,
      widthAutoFit,
      audioName,
      audioBuffer,
      audioOffset,
      showSpectrogram,
      tierOrder,
      scaleMode,
      tickPrecision,
      tickFixedDecimals,
      viewDomain,
      mode,
      editInspectorMode,
      hiddenTierIndices
    ]);

    const layoutRef = useRef<ScoreLayout>(layout);
    layoutRef.current = layout;

    // Playhead Auto-Follow Scroll (throttled cleanly; half-open [startT, endT) band lookup + tall-band guard prevents bounce/jitter)
    useEffect(() => {
      if (!playing || !followPlayhead || !Number.isFinite(currentTime)) return;
      const now = performance.now();
      if (now - lastAutoScrollMsRef.current < 240) return;

      const stageEl = stageRef.current;
      const sheetEl = sheetRef.current;
      if (!stageEl || !sheetEl || layout.bands.length === 0) return;

      const lastBandIdx = layout.bands.length - 1;
      const band =
        layout.bands.find(
          (b, idx) =>
            currentTime >= b.startT &&
            (idx === lastBandIdx ? currentTime <= b.endT : currentTime < b.endT)
        ) ?? (layout.bands.length === 1 ? layout.bands[0] : undefined);
      if (!band) return;

      const zStage = getElementRectScale(stageEl);
      const zSheet = getElementRectScale(sheetEl);
      const stageRect = stageEl.getBoundingClientRect();
      const sheetRect = sheetEl.getBoundingClientRect();
      const x = elasticXInBand(band, currentTime);
      const pxInStage = (sheetRect.left + x * zSheet - stageRect.left) / zStage;
      const bandTopInStage = (sheetRect.top + band.linearY * zSheet - stageRect.top) / zStage;
      const bandBotInStage = (sheetRect.top + band.tiersBottomY * zSheet - stageRect.top) / zStage;

      const viewW = stageEl.clientWidth;
      const viewH = stageEl.clientHeight;
      const maxScrollLeft = Math.max(0, stageEl.scrollWidth - viewW);
      const maxScrollTop = Math.max(0, stageEl.scrollHeight - viewH);
      const marginX = Math.min(84, viewW * 0.18);
      const marginY = 24;

      let nextLeft = stageEl.scrollLeft;
      let nextTop = stageEl.scrollTop;

      if (maxScrollLeft > 0 && (pxInStage < marginX || pxInStage > viewW - marginX)) {
        nextLeft = Math.max(
          0,
          Math.min(maxScrollLeft, stageEl.scrollLeft + (pxInStage - viewW * 0.25))
        );
      }

      if (maxScrollTop > 0) {
        const bandH = Math.max(0, bandBotInStage - bandTopInStage);
        if (bandH >= viewH - marginY * 2) {
          // Tall band (taller than or nearly filling #stage): only scroll if the band isn't already covering the viewport
          const alreadyCoveringView = bandTopInStage <= viewH * 0.35 && bandBotInStage >= viewH * 0.65;
          if (!alreadyCoveringView) {
            nextTop = Math.max(
              0,
              Math.min(maxScrollTop, stageEl.scrollTop + (bandTopInStage - 16))
            );
          }
        } else if (bandTopInStage < marginY) {
          nextTop = Math.max(
            0,
            Math.min(maxScrollTop, stageEl.scrollTop + (bandTopInStage - marginY))
          );
        } else if (bandBotInStage > viewH - marginY) {
          nextTop = Math.max(
            0,
            Math.min(maxScrollTop, stageEl.scrollTop + (bandBotInStage - (viewH - marginY)))
          );
        }
      }

      const needsScroll =
        Math.abs(nextLeft - stageEl.scrollLeft) > 8 || Math.abs(nextTop - stageEl.scrollTop) > 8;

      if (needsScroll) {
        lastAutoScrollMsRef.current = now;
        stageEl.scrollTo({ left: nextLeft, top: nextTop, behavior: 'smooth' });
      }
    }, [playing, followPlayhead, currentTime, layout, canvasScale]);

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
      const zStage = getElementRectScale(stageEl);
      const dx = (newClientX - anchor.clientX) / zStage;
      const dy = (newClientY - anchor.clientY) / zStage;
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
      const dpr = Math.min(3, (window.devicePixelRatio || 1) * Math.max(1, canvasScale));
      const dprKey = dpr.toFixed(2);
      const bridge = getPlatformBridge();

      (async () => {
        const nextMap = new Map<number, string>();
        for (const band of layout.bands) {
          if (band.specH <= 0) continue;
          const segSig = band.linearSegs.map((s) => `${s.t0}:${s.t1}:${s.collapsed ? 1 : 0}`).join(',');
          const key = `${analysis.sessionId}|${maxFreq}|${dprKey}|${Math.round(band.bandContentW)}|${band.specH}|${segSig}`;
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
    }, [analysis, showSpectrogram, audioName, layout, maxFreq, uiScale, canvasScale]);

    const f0RangeOverride = useMemo(
      () => resolveF0RangeOverride(f0RangeMode, f0RangeCustom),
      [f0RangeMode, f0RangeCustom]
    );

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
        f0RangeOverride,
        mode,
        selection,
        playRange,
        currentTime,
        showPlayhead,
        dragPreview,
        intervalDragPreview,
        screenSpecUrls: specUrls
      });
    }, [
      tg,
      layout,
      audioName,
      audioBuffer,
      audioOffset,
      analysis,
      maxFreq,
      f0RangeOverride,
      mode,
      specUrls
    ]);

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

    const pendingCanvasZoomAnchorRef = useRef<{
      relX: number;
      relY: number;
      pointerXInStage: number;
      pointerYInStage: number;
    } | null>(null);
    const pendingWidthZoomAnchorRef = useRef<{
      relX: number;
      pointerXInStage: number;
    } | null>(null);

    // Apply cursor-anchored scroll synchronously after canvasScale zoom commits (zero 1-frame flicker)
    useLayoutEffect(() => {
      const anchor = pendingCanvasZoomAnchorRef.current;
      if (!anchor) return;
      pendingCanvasZoomAnchorRef.current = null;
      const stageEl = stageRef.current;
      const sheetEl = sheetRef.current;
      if (!stageEl || !sheetEl) return;
      const curStageRect = stageEl.getBoundingClientRect();
      const curSheetRect = sheetEl.getBoundingClientRect();
      const curZStage = getElementRectScale(stageEl);
      const sheetLeftInScroll = stageEl.scrollLeft + (curSheetRect.left - curStageRect.left) / curZStage;
      const sheetTopInScroll = stageEl.scrollTop + (curSheetRect.top - curStageRect.top) / curZStage;
      const newSheetWInStage = curSheetRect.width / curZStage;
      const newSheetHInStage = curSheetRect.height / curZStage;
      stageEl.scrollLeft = Math.max(
        0,
        sheetLeftInScroll + anchor.relX * newSheetWInStage - anchor.pointerXInStage
      );
      stageEl.scrollTop = Math.max(
        0,
        sheetTopInScroll + anchor.relY * newSheetHInStage - anchor.pointerYInStage
      );
    }, [canvasScale]);

    // Apply horizontal cursor-anchored scroll synchronously after Alt+Wheel width reflow commits
    useLayoutEffect(() => {
      const anchor = pendingWidthZoomAnchorRef.current;
      if (!anchor) return;
      pendingWidthZoomAnchorRef.current = null;
      const stageEl = stageRef.current;
      const sheetEl = sheetRef.current;
      if (!stageEl || !sheetEl) return;
      const curStageRect = stageEl.getBoundingClientRect();
      const curSheetRect = sheetEl.getBoundingClientRect();
      const curZStage = getElementRectScale(stageEl);
      const sheetLeftInScroll = stageEl.scrollLeft + (curSheetRect.left - curStageRect.left) / curZStage;
      const newSheetWInStage = curSheetRect.width / curZStage;
      stageEl.scrollLeft = Math.max(
        0,
        sheetLeftInScroll + anchor.relX * newSheetWInStage - anchor.pointerXInStage
      );
    }, [layout]);

    // Smooth Ctrl/Meta + Wheel canvas zoom (synced with StatusBar 50%–200%, X+Y cursor-anchored)
    // and Alt + Wheel horizontal timeline width stretch/compress (symmetric, never band-trapped)
    useEffect(() => {
      const stageEl = stageRef.current;
      if (!stageEl) return;

      const onWheel = (e: WheelEvent) => {
        const isCanvasWheel = (e.ctrlKey || e.metaKey) && !e.altKey;
        const isWidthWheel = e.altKey && !e.ctrlKey && !e.metaKey;
        if (!isCanvasWheel && !isWidthWheel) return;
        if (e.deltaY === 0) return;

        e.preventDefault();
        const sheetEl = sheetRef.current;
        if (!sheetEl) return;

        const zStage = getElementRectScale(stageEl);
        const stageRect = stageEl.getBoundingClientRect();
        const sheetRect = sheetEl.getBoundingClientRect();
        const pointerXInStage = (e.clientX - stageRect.left) / zStage;
        const pointerYInStage = (e.clientY - stageRect.top) / zStage;
        const relX = Math.max(0, Math.min(1, (e.clientX - sheetRect.left) / Math.max(1, sheetRect.width)));
        const relY = Math.max(0, Math.min(1, (e.clientY - sheetRect.top) / Math.max(1, sheetRect.height)));

        const st = useEditorStore.getState();

        if (isCanvasWheel) {
          const curScale = st.canvasScale;
          const isDiscreteNotch = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 40;
          let nextScale: number;
          if (isDiscreteNotch) {
            nextScale = stepCanvasScale(curScale, e.deltaY < 0 ? 1 : -1);
          } else {
            const rawNext = clampCanvasScale(curScale * Math.exp(-e.deltaY * 0.008));
            const crossedOne = (curScale < 1 && rawNext > 1) || (curScale > 1 && rawNext < 1);
            nextScale = crossedOne || Math.abs(rawNext - 1) <= 0.012 ? 1 : rawNext;
          }
          if (Math.abs(nextScale - curScale) < 0.0005) return;
          pendingCanvasZoomAnchorRef.current = {
            relX,
            relY,
            pointerXInStage,
            pointerYInStage
          };
          setCanvasScale(nextScale);
          return;
        }

        // Alt + Wheel: horizontal time-axis width adjustment (always bases on effective targetWidth, never shrunk multi-band layout.width)
        const dir: -1 | 1 = e.deltaY < 0 ? 1 : -1;
        const factor = dir > 0 ? 1.15 : 1 / 1.15;
        const curStageW = (stageEl.clientWidth || getLogicalViewportSize().width) * (st.uiScale || 1);
        const sidePad = curStageW < 480 ? 12 : 24;
        const availW = Math.max(260, Math.round(curStageW - sidePad));
        const renderedW = st.layout && st.layout.width > 0 ? Math.round(st.layout.width) : availW;
        const dom = st.viewDomain || { min: st.tg.xmin, max: st.tg.xmax };
        const dur = Math.max(
          0.1,
          (Number.isFinite(dom.max) ? dom.max : 1) - (Number.isFinite(dom.min) ? dom.min : 0)
        );
        const maxSingleW = Math.max(4800, Math.min(18000, Math.round(dur * 600)));

        if (st.wrapMode === 'auto') {
          const curEffW = st.widthAutoFit ? availW : Math.min(st.targetWidth, availW);
          if (dir > 0) {
            if (!st.widthAutoFit && curEffW < availW - 4) {
              const nextW = Math.max(curEffW + 24, Math.round(curEffW * factor));
              if (nextW >= availW - 4) {
                setWidthAutoFit(true);
              } else {
                setTargetWidth(nextW);
              }
            } else {
              // Already at full viewport auto-wrap width: unfold cleanly into single-line timeline
              const startW = Math.max(availW, renderedW);
              const nextW = Math.min(maxSingleW, Math.max(startW + 120, Math.round(startW * factor)));
              setWrapMode('single');
              setTargetWidth(nextW);
            }
          } else {
            const nextW = Math.max(280, Math.min(curEffW - 24, Math.round(curEffW * factor)));
            if (nextW === curEffW && !st.widthAutoFit) return;
            setTargetWidth(nextW);
          }
        } else {
          // Single-line timeline mode
          if (dir < 0 && !st.widthAutoFit && st.targetWidth < renderedW - 2) {
            // Already hit readability floor; zooming back in starts from renderedW with zero dead ticks
            return;
          }
          const baseW = st.widthAutoFit
            ? renderedW
            : dir > 0
              ? Math.max(st.targetWidth, renderedW)
              : Math.min(st.targetWidth, renderedW);
          const nextW =
            dir > 0
              ? Math.min(maxSingleW, Math.max(baseW + 32, Math.round(baseW * factor)))
              : Math.max(280, Math.min(baseW - 32, Math.round(baseW * factor)));
          if (!st.widthAutoFit && nextW === st.targetWidth) return;
          setTargetWidth(nextW);
        }

        pendingWidthZoomAnchorRef.current = { relX, pointerXInStage };
      };

      stageEl.addEventListener('wheel', onWheel, { passive: false });
      return () => {
        stageEl.removeEventListener('wheel', onWheel);
      };
    }, [setCanvasScale, setWrapMode, setTargetWidth, setWidthAutoFit]);

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
            const tier = tg.tiers[tgt.tierIndex];
            const cur = tier?.intervals[tgt.itemIndex];
            if (tier && cur && cur.text !== finalVal) {
              const tierName = formatTierLabel(tier.name, tgt.tierIndex);
              const oldText = cur.text;
              const focusT = cur.xmin;
              commitTgMutation(
                (_draft, ctx) => {
                  const dTier = ctx.editTier(tgt.tierIndex);
                  const target = dTier?.intervals[tgt.itemIndex];
                  if (!target || target.text === finalVal) return false;
                  target.text = finalVal;
                },
                undefined,
                {
                  type: 'edit-interval-text',
                  title: '编辑区间文本',
                  detail: `${tierName} · ${formatQuote(oldText)}→${formatQuote(finalVal)}`,
                  icon: 'edit',
                  tierName,
                  focusTime: focusT
                }
              );
            }
          } else if (tgt.kind === 'point') {
            const tier = tg.tiers[tgt.tierIndex];
            const cur = tier?.points[tgt.itemIndex];
            if (tier && cur && cur.mark !== finalVal) {
              const tierName = formatTierLabel(tier.name, tgt.tierIndex);
              const oldMark = cur.mark;
              const ptTime = cur.number;
              commitTgMutation(
                (_draft, ctx) => {
                  const dTier = ctx.editTier(tgt.tierIndex);
                  const target = dTier?.points[tgt.itemIndex];
                  if (!target || target.mark === finalVal) return false;
                  target.mark = finalVal;
                },
                undefined,
                {
                  type: 'edit-point-text',
                  title: '编辑标点文本',
                  detail: `${tierName} · ${formatTimeSec(ptTime)} ${formatQuote(oldMark)}→${formatQuote(finalVal)}`,
                  icon: 'edit',
                  tierName,
                  focusTime: ptTime
                }
              );
            }
          } else if (tgt.kind === 'tier-name') {
            const cur = tg.tiers[tgt.tierIndex];
            if (cur && cur.name !== finalVal) {
              const prevName = cur.name;
              commitTgMutation(
                (_draft, ctx) => {
                  const dTier = ctx.editTier(tgt.tierIndex);
                  if (!dTier || dTier.name === finalVal) return false;
                  dTier.name = finalVal;
                },
                undefined,
                {
                  type: 'rename-tier',
                  title: '重命名层级',
                  detail: `${formatQuote(prevName)}→${formatQuote(finalVal)}`,
                  icon: 'edit',
                  tierName: formatTierLabel(finalVal, tgt.tierIndex)
                }
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
        const zStage = getElementRectScale(stageEl);
        const zSheet = getElementRectScale(sheetEl);
        const sheetRect = sheetEl.getBoundingClientRect();
        const stageRect = stageEl.getBoundingClientRect();
        const elemLeft = (sheetRect.left + anchor.x * zSheet - stageRect.left) / zStage;
        const elemRight = (sheetRect.left + (anchor.x + anchor.w) * zSheet - stageRect.left) / zStage;
        const elemTop = (sheetRect.top + anchor.y * zSheet - stageRect.top) / zStage;
        const elemBottom = (sheetRect.top + (anchor.y + anchor.h) * zSheet - stageRect.top) / zStage;
        const padX = 48;
        const padY = 48;
        if (elemLeft < padX) {
          stageEl.scrollLeft += elemLeft - padX;
        } else if (elemRight > stageEl.clientWidth - padX) {
          stageEl.scrollLeft += elemRight - (stageEl.clientWidth - padX);
        }
        if (elemTop < padY) {
          stageEl.scrollTop += elemTop - padY;
        } else if (elemBottom > stageEl.clientHeight - padY) {
          stageEl.scrollTop += elemBottom - (stageEl.clientHeight - padY);
        }
      },
      [layout]
    );

    const scrollTimeIntoStageView = useCallback(
      (t: number) => {
        const stageEl = stageRef.current;
        const sheetEl = sheetRef.current;
        if (!stageEl || !sheetEl || !Number.isFinite(t) || layout.bands.length === 0) return;
        const lastIdx = layout.bands.length - 1;
        const band =
          layout.bands.find(
            (b, idx) => t >= b.startT - 1e-9 && (idx === lastIdx ? t <= b.endT + 1e-9 : t < b.endT)
          ) ?? layout.bands[0];
        if (!band) return;
        const clampedT = Math.max(band.startT, Math.min(band.endT, t));
        const x = elasticXInBand(band, clampedT);
        const zStage = getElementRectScale(stageEl);
        const zSheet = getElementRectScale(sheetEl);
        const sheetRect = sheetEl.getBoundingClientRect();
        const stageRect = stageEl.getBoundingClientRect();
        const pxInStage = (sheetRect.left + x * zSheet - stageRect.left) / zStage;
        const topInStage = (sheetRect.top + band.tiersTopY * zSheet - stageRect.top) / zStage;
        const botInStage = (sheetRect.top + band.tiersBottomY * zSheet - stageRect.top) / zStage;
        const padX = 48;
        const padY = 36;
        if (pxInStage < padX) {
          stageEl.scrollLeft += pxInStage - padX;
        } else if (pxInStage > stageEl.clientWidth - padX) {
          stageEl.scrollLeft += pxInStage - (stageEl.clientWidth - padX);
        }
        if (topInStage < padY) {
          stageEl.scrollTop += topInStage - padY;
        } else if (botInStage > stageEl.clientHeight - padY) {
          stageEl.scrollTop += botInStage - (stageEl.clientHeight - padY);
        }
      },
      [layout]
    );

    const lastHandledHistorySeqRef = useRef(0);
    useLayoutEffect(() => {
      if (!lastHistoryNav || lastHistoryNav.tabId !== activeTabId) return;
      if (lastHistoryNav.seq === lastHandledHistorySeqRef.current) return;
      lastHandledHistorySeqRef.current = lastHistoryNav.seq;
      if (lastHistoryNav.selection && getSelectionAnchorRect(layout, lastHistoryNav.selection)) {
        scrollSelectionIntoStageView(lastHistoryNav.selection);
      } else if (lastHistoryNav.focusTime !== undefined && Number.isFinite(lastHistoryNav.focusTime)) {
        scrollTimeIntoStageView(lastHistoryNav.focusTime);
      }
    }, [lastHistoryNav, activeTabId, layout, scrollSelectionIntoStageView, scrollTimeIntoStageView]);

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
        void getPlatformBridge()
          .writeClipboardText(text)
          .then(() => showToast(`已复制${label}`))
          .catch(() => showToast('剪贴板写入受限', true));
      },
      [showToast]
    );

    const applyPastedTextToSelection = useCallback(
      (snapSel: EditorSelection, rawClip: string) => {
        if (!snapSel || (snapSel.kind !== 'interval' && snapSel.kind !== 'point')) return;
        const clip = rawClip.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const st = useEditorStore.getState();
        const tier = st.tg.tiers[snapSel.tierIndex];
        const tierName = formatTierLabel(tier?.name, snapSel.tierIndex);
        if (snapSel.kind === 'interval') {
          const iv = tier?.intervals[snapSel.itemIndex];
          if (!iv) return;
          if (iv.text !== clip) {
            commitTgMutation(
              (_d, ctx) => {
                const dTier = ctx.editTier(snapSel.tierIndex);
                const target = dTier?.intervals[snapSel.itemIndex];
                if (!target || target.text === clip) return false;
                target.text = clip;
              },
              snapSel,
              {
                type: 'paste-text',
                title: '粘贴标注文本',
                detail: `${tierName} · →${formatQuote(clip)}`,
                icon: 'paste',
                tierName,
                focusTime: iv.xmin
              }
            );
          }
        } else {
          const pt = tier?.points[snapSel.itemIndex];
          if (!pt) return;
          if (pt.mark !== clip) {
            commitTgMutation(
              (_d, ctx) => {
                const dTier = ctx.editTier(snapSel.tierIndex);
                const target = dTier?.points[snapSel.itemIndex];
                if (!target || target.mark === clip) return false;
                target.mark = clip;
              },
              snapSel,
              {
                type: 'paste-text',
                title: '粘贴标注文本',
                detail: `${tierName} · →${formatQuote(clip)}`,
                icon: 'paste',
                tierName,
                focusTime: pt.number
              }
            );
          }
        }
        showToast('已粘贴文本');
      },
      [commitTgMutation, showToast]
    );

    // Web runtime: handle native `paste` event on canvas selection without triggering
    // browser clipboard-read permission prompts (Desktop uses native Tauri clipboard directly).
    useEffect(() => {
      if (isTauriRuntime()) return;
      const onPaste = (e: ClipboardEvent) => {
        if (e.defaultPrevented) return;
        if (inlineTargetRef.current) return;
        if (isEditableTarget(e.target)) return;
        const st = useEditorStore.getState();
        if (st.mode !== 'edit' || st.exportOpen || st.posterOpen || st.aboutOpen || st.shortcutsOpen) {
          return;
        }
        const snapSel = st.selection;
        if (!snapSel || (snapSel.kind !== 'interval' && snapSel.kind !== 'point')) return;
        const nativeSel = window.getSelection()?.toString() || '';
        if (nativeSel.length > 0) return;
        const clip = e.clipboardData?.getData('text/plain');
        if (clip === undefined || clip === null) return;
        e.preventDefault();
        applyPastedTextToSelection(snapSel, clip);
      };
      window.addEventListener('paste', onPaste);
      return () => window.removeEventListener('paste', onPaste);
    }, [applyPastedTextToSelection]);

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
        if (sel?.kind === 'boundary' || sel?.kind === 'spine') {
          const pad = withContext ? 0.25 : 0.2;
          const start = Math.max(curTg.xmin, sel.time - pad);
          const end = Math.min(curTg.xmax, sel.time + pad);
          if (end > start) {
            onStartPlayback(start, end);
          }
          return;
        }
        if (sel?.kind === 'point') {
          const pt = curTg.tiers[sel.tierIndex]?.points[sel.itemIndex];
          if (pt) {
            const pad = withContext ? 0.25 : 0.2;
            const s = Math.max(curTg.xmin, pt.number - pad);
            const e = Math.min(curTg.xmax, pt.number + pad);
            if (e > s) onStartPlayback(s, e);
            return;
          }
        }
        if (!range && st.playRange && st.playRange.end > st.playRange.start) {
          range = { start: st.playRange.start, end: st.playRange.end };
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
            if (
              moveTierBoundary(target.tierIndex, target.time, zt, false, {
                coalesce: false,
                actionMeta: { type: 'snap-zero-crossing' },
                nextSelection: {
                  kind: 'boundary',
                  tierIndex: target.tierIndex,
                  time: zt,
                  bandIndex: target.bandIndex
                }
              })
            ) {
              showToast(`已吸附至过零点 (${formatPraatDouble(zt)} s)`);
            }
          } else {
            if (
              moveSharedTimestamp(target.time, zt, {
                coalesce: false,
                actionMeta: { type: 'snap-zero-crossing' },
                nextSelection: {
                  kind: 'spine',
                  time: zt,
                  bandIndex: target.bandIndex
                }
              })
            ) {
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

        const tierName = formatTierLabel(tier.name, ti);
        commitTgMutation(
          (_draft, ctx) => {
            const dTier = ctx.editTier(ti);
            if (!dTier || dTier.kind !== 'intervalTier' || !dTier.intervals[ii]) return false;
            dTier.intervals.splice(ii, 1, ...replacements);
            ctx.setNextPlayRange({ start: t0, end: t1 });
          },
          nextSel,
          {
            type: 'create-interval',
            title: label,
            detail: `${tierName} · ${formatTimeSpan(t0, t1)} (${formatDurationLabel(t1 - t0)})`,
            icon: 'createFromRange',
            tierName,
            focusTime: t0
          }
        );
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
        if (document.querySelector('.cust-key-btn.is-recording')) return;

        const hasOpenModal =
          exportOpen ||
          posterOpen ||
          aboutOpen ||
          shortcutsOpen ||
          Boolean(document.querySelector('.modal-backdrop.open'));

        const editable = isEditableTarget(e.target) || isEditableTarget(document.activeElement);

        // Input-allowed shortcuts (work inside InlineEditor / Inspector inputs too; plain letters stay typable)
        if (!hasOpenModal) {
          const allowInInput = !editable || isSafeInputShortcutEvent(e);
          if (allowInInput && matchesShortcut('replay-context', e, customShortcuts)) {
            e.preventDefault();
            replayCurrent(true);
            return;
          }
          if (allowInInput && matchesShortcut('replay-selection', e, customShortcuts)) {
            e.preventDefault();
            replayCurrent(false);
            return;
          }
          if (
            mode === 'edit' &&
            allowInInput &&
            (!editable || !e.defaultPrevented) &&
            matchesShortcut('ipa-cycle', e, customShortcuts)
          ) {
            e.preventDefault();
            cycleIpaMode();
            return;
          }
        }

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

        // Layered Escape: spacePan -> ctxMenu -> inline -> playRange -> selection (one layer per press)
        if (e.key === 'Escape' && !mod && !e.altKey && !e.shiftKey) {
          if (spacePanRef.current.held) {
            e.preventDefault();
            exitSpacePan(false);
            return;
          }
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

        // Structural Mod+ shortcuts: Undo / Redo
        if (mod && !e.altKey && lower === 'z') {
          if (mode !== 'edit') return;
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
          return;
        }
        if (mod && !e.altKey && lower === 'y') {
          if (mode !== 'edit') return;
          e.preventDefault();
          redo();
          return;
        }

        // Structural Mod+Home / Mod+End -> jump playhead to full start / end
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

        // Structural Mod+Shift+ArrowLeft/Right (+ Alt ±1ms) -> cross-tier shared boundary/spine nudge
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
          const nextSel: EditorSelection =
            selection.kind === 'boundary'
              ? {
                  kind: 'boundary',
                  tierIndex: selection.tierIndex,
                  time: newT,
                  bandIndex: selection.bandIndex
                }
              : {
                  kind: 'spine',
                  time: newT,
                  bandIndex: selection.bandIndex
                };
          moveSharedTimestamp(selection.time, newT, { nextSelection: nextSel });
          return;
        }

        // Structural Mod+C / Mod+Shift+C / Mod+X / Mod+V (guarded against native text selection)
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
              const tier = tg.tiers[selection.tierIndex];
              const tierName = formatTierLabel(tier?.name, selection.tierIndex);
              const iv = tier?.intervals[selection.itemIndex];
              if (iv) {
                e.preventDefault();
                copyText(iv.text, '区间文本（已剪切）');
                if (iv.text !== '') {
                  const oldText = iv.text;
                  commitTgMutation(
                    (_d, ctx) => {
                      const dTier = ctx.editTier(selection.tierIndex);
                      const target = dTier?.intervals[selection.itemIndex];
                      if (!target || target.text === '') return false;
                      target.text = '';
                    },
                    selection,
                    {
                      type: 'cut-text',
                      title: '剪切标注文本',
                      detail: `${tierName} · ${formatQuote(oldText)}`,
                      icon: 'cut',
                      tierName,
                      focusTime: iv.xmin
                    }
                  );
                }
              }
            } else if (selection.kind === 'point') {
              const tier = tg.tiers[selection.tierIndex];
              const tierName = formatTierLabel(tier?.name, selection.tierIndex);
              const pt = tier?.points[selection.itemIndex];
              if (pt) {
                e.preventDefault();
                copyText(pt.mark, '标点文本（已剪切）');
                if (pt.mark !== '') {
                  const oldMark = pt.mark;
                  commitTgMutation(
                    (_d, ctx) => {
                      const dTier = ctx.editTier(selection.tierIndex);
                      const target = dTier?.points[selection.itemIndex];
                      if (!target || target.mark === '') return false;
                      target.mark = '';
                    },
                    selection,
                    {
                      type: 'cut-text',
                      title: '剪切标注文本',
                      detail: `${tierName} · ${formatQuote(oldMark)}`,
                      icon: 'cut',
                      tierName,
                      focusTime: pt.number
                    }
                  );
                }
              }
            }
            return;
          }

          if (lower === 'v' && !e.shiftKey && mode === 'edit') {
            if (selection.kind === 'interval' || selection.kind === 'point') {
              if (!isTauriRuntime()) {
                // Let the browser dispatch a native `paste` event (handled above with zero permission prompt).
                return;
              }
              e.preventDefault();
              const snapSel = selection;
              void getPlatformBridge()
                .readClipboardText()
                .then((clip) => applyPastedTextToSelection(snapSel, clip))
                .catch(() => showToast('剪贴板读取受限', true));
            }
            return;
          }
        }

        // ====================================================================
        // Unified Rebindable Canvas Shortcuts (matchesShortcut)
        // ====================================================================

        // Shortcuts reference modal (default: ?, Mod+/, F1)
        if (matchesShortcut('shortcuts-modal', e, customShortcuts)) {
          e.preventDefault();
          setShortcutsOpen(!shortcutsOpen);
          return;
        }

        // Find / Replace (default: Mod+F / Mod+H)
        if (!e.defaultPrevented && matchesShortcut('find-open', e, customShortcuts)) {
          e.preventDefault();
          openFindBar(false);
          return;
        }
        if (!e.defaultPrevented && matchesShortcut('replace-open', e, customShortcuts)) {
          e.preventDefault();
          openFindBar(true);
          return;
        }

        // Playback stop & reset / toggle play (default: Shift+Space / Space)
        if (matchesShortcut('play-stop-reset', e, customShortcuts)) {
          e.preventDefault();
          if (document.activeElement instanceof HTMLButtonElement) {
            document.activeElement.blur();
          }
          const savedRange = playRange;
          const resetT = savedRange?.start ?? viewDomain?.min ?? tg.xmin;
          onStopPlayback();
          if (savedRange) setPlayRange(savedRange);
          setPlaybackTime(resetT, true);
          return;
        }
        // Hold Space + Drag Canvas Panning (quick tap <400ms without drag triggers play-toggle when bound to Space)
        const isPlainSpace =
          (e.code === 'Space' || e.key === ' ') &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !e.shiftKey;
        if (isPlainSpace) {
          e.preventDefault();
          if (document.activeElement instanceof HTMLButtonElement) {
            document.activeElement.blur();
          }
          if (e.repeat || spacePanRef.current.held || draggingRef.current) {
            return;
          }
          const pan = spacePanRef.current;
          pan.held = true;
          pan.dragging = false;
          pan.didDrag = false;
          pan.downAt = performance.now();
          pan.shouldTogglePlayOnRelease = matchesShortcut('play-toggle', e, customShortcuts);
          clearHoverGuide();
          svgRef.current?.classList.remove('shift-split');
          stageRef.current?.classList.add('space-pan');
          return;
        }
        if (matchesShortcut('play-toggle', e, customShortcuts)) {
          e.preventDefault();
          if (e.repeat) return;
          if (document.activeElement instanceof HTMLButtonElement) {
            document.activeElement.blur();
          }
          onTogglePlay();
          return;
        }

        // Loop toggle (default: L)
        if (matchesShortcut('loop-toggle', e, customShortcuts)) {
          e.preventDefault();
          const nextLoop = !loop;
          setLoop(nextLoop);
          showToast(nextLoop ? '已开启循环播放' : '已关闭循环播放');
          return;
        }

        // Playback rate down / up (default: < / >)
        const isRateDown = matchesShortcut('rate-down', e, customShortcuts);
        const isRateUp = !isRateDown && matchesShortcut('rate-up', e, customShortcuts);
        if (isRateDown || isRateUp) {
          e.preventDefault();
          let bestIdx = 0;
          let bestDist = Infinity;
          PLAYBACK_RATES.forEach((r, i) => {
            const d = Math.abs(r - rate);
            if (d < bestDist) {
              bestDist = d;
              bestIdx = i;
            }
          });
          const nextIdx = Math.max(0, Math.min(PLAYBACK_RATES.length - 1, bestIdx + (isRateDown ? -1 : 1)));
          const nextRate = PLAYBACK_RATES[nextIdx];
          setRate(nextRate);
          showToast(`播放倍速：${nextRate}×`);
          return;
        }

        // Seek playhead back / forward (default: , / .)
        const isSeekBack = matchesShortcut('seek-back', e, customShortcuts);
        const isSeekForward = !isSeekBack && matchesShortcut('seek-forward', e, customShortcuts);
        if (isSeekBack || isSeekForward) {
          e.preventDefault();
          const base = Number.isFinite(currentTime) ? currentTime : tg.xmin;
          const nextT = Math.max(
            tg.xmin,
            Math.min(tg.xmax, Number((base + (isSeekBack ? -0.1 : 0.1)).toFixed(6)))
          );
          if (playing) {
            const endT =
              playRange && playRange.end > nextT
                ? playRange.end
                : viewDomain && viewDomain.max > nextT
                  ? viewDomain.max
                  : tg.xmax;
            if (endT > nextT + 0.002) {
              onStartPlayback(nextT, endT);
            } else {
              onStopPlayback();
              setPlaybackTime(nextT, true);
            }
          } else {
            setPlaybackTime(nextT, true);
          }
          return;
        }

        // Jump to next / prev empty interval (default: N / Shift+N)
        const isEmptyNext = matchesShortcut('nav-empty-next', e, customShortcuts);
        const isEmptyPrev = !isEmptyNext && matchesShortcut('nav-empty-prev', e, customShortcuts);
        if (isEmptyNext || isEmptyPrev) {
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
          if (!isEmptyPrev) {
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
            showToast(isEmptyPrev ? '已循环回本层末尾空白区间' : '已循环回本层首个空白区间');
          }
          return;
        }

        // Locate playhead & select containing interval (default: G)
        if (matchesShortcut('locate-playhead', e, customShortcuts)) {
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

        // Toggle Read / Edit mode (default: E)
        if (matchesShortcut('mode-toggle', e, customShortcuts)) {
          e.preventDefault();
          const nextMode = mode === 'edit' ? 'read' : 'edit';
          setMode(nextMode);
          showToast(nextMode === 'edit' ? '已进入编辑模式' : '已切换为只读模式');
          return;
        }

        // Zoom reset / focus (default: Shift+F / F)
        if (matchesShortcut('zoom-reset', e, customShortcuts)) {
          e.preventDefault();
          setViewDomain(null);
          return;
        }
        if (matchesShortcut('zoom-focus', e, customShortcuts)) {
          e.preventDefault();
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

        // Scale & wrap toggles (default: V / W)
        if (matchesShortcut('scale-toggle', e, customShortcuts)) {
          e.preventDefault();
          const next = scaleMode === 'elastic' ? 'linear' : 'elastic';
          setScaleMode(next);
          showToast(next === 'linear' ? '时间比例：线性等比' : '时间比例：自适应弹性');
          return;
        }
        if (matchesShortcut('wrap-toggle', e, customShortcuts)) {
          e.preventDefault();
          const next = wrapMode === 'auto' ? 'single' : 'auto';
          setWrapMode(next);
          showToast(next === 'single' ? '排版：单行长卷展开' : '排版：自动折行');
          return;
        }

        // Legend toggle (default: Alt+L)
        if (matchesShortcut('legend-toggle', e, customShortcuts)) {
          e.preventDefault();
          toggleLegend();
          return;
        }

        // Virtual IPA dock toggle (default: Alt+K)
        if (matchesShortcut('ipa-dock-toggle', e, customShortcuts)) {
          e.preventDefault();
          if (mode === 'edit') setIpaDockOpen(!ipaDockOpen);
          else showToast('音标键盘仅在编辑模式可用');
          return;
        }

        // Inline edit (default: Enter, F2; in read mode Enter plays selected item)
        if (matchesShortcut('inline-edit', e, customShortcuts) && selection) {
          if (mode === 'edit') {
            if (selection.kind === 'interval' || selection.kind === 'point') {
              e.preventDefault();
              openInline(selection);
            } else if (selection.kind === 'tier') {
              e.preventDefault();
              openInline({ kind: 'tier-name', tierIndex: selection.tierIndex });
            }
            return;
          } else if (mode === 'read' && e.key === 'Enter') {
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
            return;
          }
        }

        // Edit-only rebindable canvas actions
        if (mode === 'edit') {
          // Drop boundary across all interval tiers at playhead (default: Shift+B)
          if (matchesShortcut('tap-split-all-tiers', e, customShortcuts)) {
            e.preventDefault();
            const splitT = Number(currentTime.toFixed(6));
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
              (draft, ctx) => {
                let applied = 0;
                for (let ti = 0; ti < draft.tiers.length; ti++) {
                  const origTier = draft.tiers[ti];
                  if (origTier.kind !== 'intervalTier') continue;
                  const idx = origTier.intervals.findIndex(
                    (iv) => iv.xmin < splitT - 1e-6 && iv.xmax > splitT + 1e-6
                  );
                  if (idx !== -1) {
                    const t = ctx.editTier(ti);
                    if (!t || t.kind !== 'intervalTier') continue;
                    const iv = t.intervals[idx];
                    const right = { xmin: splitT, xmax: iv.xmax, text: '' };
                    iv.xmax = splitT;
                    t.intervals.splice(idx + 1, 0, right);
                    applied++;
                  }
                }
                if (applied === 0) return false;
              },
              undefined,
              {
                type: 'split-all-tiers',
                title: '全层落边界',
                detail: `${splitCount} 个区间层 · ${formatTimeSec(splitT)}`,
                icon: 'splitAllTiers',
                focusTime: splitT
              }
            );
            showToast(`已在 ${splitCount} 个区间层落边界 (${splitT.toFixed(3)} s)`);
            return;
          }

          // Drop boundary at playhead on active interval tier (default: B)
          if (matchesShortcut('tap-split-playhead', e, customShortcuts)) {
            e.preventDefault();
            const splitT = Number(currentTime.toFixed(6));
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

          // Split selected interval at midpoint (default: S)
          if (matchesShortcut('split-mid', e, customShortcuts)) {
            if (selection?.kind === 'interval') {
              e.preventDefault();
              splitInterval(selection.tierIndex, selection.itemIndex);
            }
            return;
          }

          // Add point at playhead on active TextTier (default: P)
          if (matchesShortcut('add-point-playhead', e, customShortcuts)) {
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

          // Create interval from playRange (default: I)
          if (matchesShortcut('create-from-playrange', e, customShortcuts)) {
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

          // Select selected interval's left / right interior boundary (default: [ / ])
          const isSelectLeft = matchesShortcut('select-left-edge', e, customShortcuts);
          const isSelectRight = !isSelectLeft && matchesShortcut('select-right-edge', e, customShortcuts);
          if ((isSelectLeft || isSelectRight) && selection?.kind === 'interval') {
            e.preventDefault();
            const tier = tg.tiers[selection.tierIndex];
            const iv = tier?.intervals[selection.itemIndex];
            if (!tier || !iv) return;
            const edgeT = isSelectLeft ? iv.xmin : iv.xmax;
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

          // Non-destructive merge left / right (default: Shift+M / M)
          const isMergeLeft = matchesShortcut('merge-left', e, customShortcuts);
          const isMergeRight = !isMergeLeft && matchesShortcut('merge-right', e, customShortcuts);
          if ((isMergeLeft || isMergeRight) && selection?.kind === 'interval') {
            e.preventDefault();
            const tier = tg.tiers[selection.tierIndex];
            if (!tier) return;
            if (isMergeLeft) {
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

          // Snap boundary / spine to nearest audio zero-crossing (default: Z)
          if (
            !e.repeat &&
            !draggingRef.current &&
            selection &&
            (selection.kind === 'boundary' || selection.kind === 'spine') &&
            matchesShortcut('snap-zero-crossing', e, customShortcuts)
          ) {
            e.preventDefault();
            void snapTargetToZeroCrossing(selection);
            return;
          }
        }

        // Alt + seek-back / seek-forward -> fine ±10 ms playhead seek
        if (!mod && e.altKey && !e.shiftKey) {
          const noAltEv = {
            key: e.key,
            code: e.code,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            altKey: false
          } as KeyboardEvent;
          const isFineBack = matchesShortcut('seek-back', noAltEv, customShortcuts);
          const isFineFwd = !isFineBack && matchesShortcut('seek-forward', noAltEv, customShortcuts);
          if (isFineBack || isFineFwd) {
            e.preventDefault();
            const base = Number.isFinite(currentTime) ? currentTime : tg.xmin;
            const nextT = Math.max(
              tg.xmin,
              Math.min(tg.xmax, Number((base + (isFineBack ? -0.01 : 0.01)).toFixed(6)))
            );
            if (playing) {
              const endT =
                playRange && playRange.end > nextT
                  ? playRange.end
                  : viewDomain && viewDomain.max > nextT
                    ? viewDomain.max
                    : tg.xmax;
              if (endT > nextT + 0.002) {
                onStartPlayback(nextT, endT);
              } else {
                onStopPlayback();
                setPlaybackTime(nextT, true);
              }
            } else {
              setPlaybackTime(nextT, true);
            }
            return;
          }
        }

        // Stop here for any other Mod+ shortcut (handled in App or browser)
        if (mod) return;

        // Structural Alt+1..5 -> right sidebar tabs (inspector / tiers / history / settings / customize)
        if (e.altKey && !e.shiftKey) {
          if (
            e.code === 'Digit1' ||
            e.code === 'Digit2' ||
            e.code === 'Digit3' ||
            e.code === 'Digit4' ||
            e.code === 'Digit5'
          ) {
            e.preventDefault();
            const tab: SidebarTab =
              e.code === 'Digit1'
                ? 'inspector'
                : e.code === 'Digit2'
                  ? 'tiers'
                  : e.code === 'Digit3'
                    ? 'history'
                    : e.code === 'Digit4'
                      ? 'settings'
                      : 'customize';
            setSidebarTab(tab);
            setSidebarOpen(true);
            return;
          }
        }

        // Structural Arrows & Tab
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
              moveTierBoundary(selection.tierIndex, selection.time, newT, false, {
                nextSelection: {
                  kind: 'boundary',
                  tierIndex: selection.tierIndex,
                  time: newT,
                  bandIndex: selection.bandIndex
                }
              });
            } else if (selection.kind === 'spine') {
              const newT = Number((selection.time + dir * stepSec).toFixed(6));
              moveSharedTimestamp(selection.time, newT, {
                nextSelection: {
                  kind: 'spine',
                  time: newT,
                  bandIndex: selection.bandIndex
                }
              });
            } else {
              const ti = selection.tierIndex;
              const pi = selection.itemIndex;
              const tier = tg.tiers[ti];
              const pt = tier?.points[pi];
              if (tier && pt) {
                const oldT = pt.number;
                const newT = Number(
                  Math.max(tier.xmin, Math.min(tier.xmax, oldT + dir * stepSec)).toFixed(6)
                );
                if (tier.points.some((p, i) => i !== pi && p.number === newT)) {
                  showToast('目标时刻已存在标点', true);
                } else if (Math.abs(newT - oldT) > 1e-9) {
                  const tierName = formatTierLabel(tier.name, ti);
                  commitTgMutation(
                    (_draft, ctx) => {
                      const dTier = ctx.editTier(ti);
                      if (!dTier || dTier.kind !== 'textTier') return false;
                      const targetPt = dTier.points[pi];
                      if (!targetPt) return false;
                      targetPt.number = newT;
                      dTier.points.sort((a, b) => a.number - b.number);
                      const newIdx = dTier.points.indexOf(targetPt);
                      ctx.setNextSelection({
                        kind: 'point',
                        tierIndex: ti,
                        itemIndex: Math.max(0, newIdx),
                        bandIndex: selection.bandIndex
                      });
                    },
                    undefined,
                    {
                      type: 'move-point',
                      title: '移动标注点',
                      detail: `${tierName} · ${formatTimeSec(oldT)} → ${formatTimeSec(newT)} (${formatDeltaTime(newT - oldT)})`,
                      icon: 'nudgeFine',
                      tierName,
                      focusTime: newT,
                      coalesce: {
                        key: `move-point:${ti}`,
                        originValue: oldT,
                        latestValue: newT,
                        chainPrevLatest: oldT,
                        formatMergedDetail: (orig, latest, count) => {
                          const o = Number(orig);
                          const l = Number(latest);
                          return `${tierName} · ${formatTimeSec(o)} → ${formatTimeSec(l)} (${formatDeltaTime(l - o)}${count > 1 ? ` · ${count}次` : ''})`;
                        }
                      }
                    }
                  );
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

        // Structural Home / End -> first / last item in active tier
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

        // Read-mode Enter fallback if inline-edit was rebound away from Enter
        if (e.key === 'Enter' && !e.shiftKey && !e.altKey && mode === 'read' && selection) {
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
          return;
        }

        // Structural 4-Quadrant Backspace / Delete / Shift+Backspace / Shift+Delete
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

            const tierName = formatTierLabel(tier.name, ti);
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
                (_draft, ctx) => {
                  const dTier = ctx.editTier(ti);
                  if (!dTier || !dTier.intervals[ii]) return false;
                  dTier.intervals.splice(ii, 1);
                },
                nextSel,
                {
                  type: 'delete-zero-interval',
                  title: '删除零时长区间',
                  detail: `${tierName} · ${formatTimeSec(iv.xmin)}`,
                  icon: 'trash',
                  tierName,
                  focusTime: iv.xmin
                }
              );
              return;
            }

            // Non-empty interval
            if (iv.text !== '') {
              const oldText = iv.text;
              if (!e.shiftKey) {
                commitTgMutation(
                  (_draft, ctx) => {
                    const dTier = ctx.editTier(ti);
                    const target = dTier?.intervals[ii];
                    if (!target || target.text === '') return false;
                    target.text = '';
                  },
                  selection,
                  {
                    type: 'clear-interval-text',
                    title: '清空区间文本',
                    detail: `${tierName} · 原${formatQuote(oldText)}`,
                    icon: 'clear',
                    tierName,
                    focusTime: iv.xmin
                  }
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
                    (_draft, ctx) => {
                      const dTier = ctx.editTier(ti);
                      const target = dTier?.intervals[ii];
                      if (!target || target.text === '') return false;
                      target.text = '';
                    },
                    selection,
                    {
                      type: 'clear-interval-text',
                      title: '清空区间文本',
                      detail: `${tierName} · 原${formatQuote(oldText)}`,
                      icon: 'clear',
                      tierName,
                      focusTime: iv.xmin
                    }
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
                  (_draft, ctx) => {
                    const dTier = ctx.editTier(ti);
                    if (!dTier) return false;
                    const prev = dTier.intervals[ii - 1];
                    const cur = dTier.intervals[ii];
                    if (!prev || !cur) return false;
                    prev.xmax = cur.xmax;
                    dTier.intervals.splice(ii, 1);
                  },
                  nextSel,
                  {
                    type: 'clear-and-remove-edge',
                    title: '清除并移除左界',
                    detail: `${tierName} · 原${formatQuote(oldText)}`,
                    icon: 'trash',
                    tierName,
                    focusTime: iv.xmin
                  }
                );
                return;
              }
              if (ii >= tier.intervals.length - 1) {
                commitTgMutation(
                  (_draft, ctx) => {
                    const dTier = ctx.editTier(ti);
                    const target = dTier?.intervals[ii];
                    if (!target || target.text === '') return false;
                    target.text = '';
                  },
                  selection,
                  {
                    type: 'clear-interval-text',
                    title: '清空区间文本',
                    detail: `${tierName} · 原${formatQuote(oldText)}`,
                    icon: 'clear',
                    tierName,
                    focusTime: iv.xmin
                  }
                );
                showToast('末格无右边界可移除');
                return;
              }
              commitTgMutation(
                (_draft, ctx) => {
                  const dTier = ctx.editTier(ti);
                  if (!dTier) return false;
                  const cur = dTier.intervals[ii];
                  const next = dTier.intervals[ii + 1];
                  if (!cur || !next) return false;
                  cur.xmax = next.xmax;
                  cur.text = next.text;
                  dTier.intervals.splice(ii + 1, 1);
                },
                selection,
                {
                  type: 'clear-and-remove-edge',
                  title: '清除并移除右界',
                  detail: `${tierName} · 原${formatQuote(oldText)}`,
                  icon: 'trash',
                  tierName,
                  focusTime: iv.xmax
                }
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
            const tierName = formatTierLabel(tier.name, ti);
            if (e.shiftKey && isBackspace) {
              if (pt.mark !== '') {
                const oldMark = pt.mark;
                commitTgMutation(
                  (_draft, ctx) => {
                    const dTier = ctx.editTier(ti);
                    const target = dTier?.points[pi];
                    if (!target || target.mark === '') return false;
                    target.mark = '';
                  },
                  selection,
                  {
                    type: 'clear-point-text',
                    title: '清空标点文本',
                    detail: `${tierName} · ${formatTimeSec(pt.number)} 原${formatQuote(oldMark)}`,
                    icon: 'clear',
                    tierName,
                    focusTime: pt.number
                  }
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
            const ptTime = pt.number;
            const ptMark = pt.mark;
            commitTgMutation(
              (_draft, ctx) => {
                const dTier = ctx.editTier(ti);
                if (!dTier || !dTier.points[pi]) return false;
                dTier.points.splice(pi, 1);
              },
              nextSel,
              {
                type: 'delete-point',
                title: '删除标注点',
                detail: `${tierName} · ${formatTimeSec(ptTime)} ${formatQuote(ptMark)}`,
                icon: 'trash',
                tierName,
                focusTime: ptTime
              }
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
      posterOpen,
      aboutOpen,
      shortcutsOpen,
      customShortcuts,
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
      applyPastedTextToSelection,
      showToast,
      clearHoverGuide,
      exitSpacePan
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

        const drawHoverSpineSafeVertical = (
          x: number,
          yBottom: number,
          stroke: string,
          strokeWidth: number,
          opacity?: number,
          dashArray?: string
        ) => {
          const splitForTicks = !curLayout.hideTicks && band.tiersTopY - band.neckBotY > 8;
          if (splitForTicks) {
            svgEl(
              'line',
              {
                x1: x,
                y1: band.neckBotY,
                x2: x,
                y2: band.neckBotY + 3,
                stroke,
                'stroke-width': strokeWidth,
                ...(opacity !== undefined ? { opacity } : {})
              },
              hg
            );
            svgEl(
              'line',
              {
                x1: x,
                y1: band.tiersTopY - 3,
                x2: x,
                y2: band.tiersTopY,
                stroke,
                'stroke-width': strokeWidth,
                ...(opacity !== undefined ? { opacity } : {})
              },
              hg
            );
            svgEl(
              'line',
              {
                x1: x,
                y1: band.tiersTopY,
                x2: x,
                y2: yBottom,
                stroke,
                'stroke-width': strokeWidth,
                ...(opacity !== undefined ? { opacity } : {}),
                ...(dashArray ? { 'stroke-dasharray': dashArray } : {})
              },
              hg
            );
          } else {
            svgEl(
              'line',
              {
                x1: x,
                y1: band.neckBotY,
                x2: x,
                y2: yBottom,
                stroke,
                'stroke-width': strokeWidth,
                ...(opacity !== undefined ? { opacity } : {}),
                ...(dashArray ? { 'stroke-dasharray': dashArray } : {})
              },
              hg
            );
          }
        };

        const drawHoverNecks = (times: number[]) => {
          const anchorTopY = band.anchorH > 0 ? band.anchorY : band.linearY;
          if (times.length === 2 && Number.isFinite(times[0]) && Number.isFinite(times[1])) {
            const t0 = Math.max(band.startT, Math.min(times[0], times[1]));
            const t1 = Math.min(band.endT, Math.max(times[0], times[1]));
            if (t1 > t0) {
              const lx0 = band.linearXForTime(t0);
              const lx1 = band.linearXForTime(t1);
              const ex0 = elasticXInBand(band, t0);
              const ex1 = elasticXInBand(band, t1);
              svgEl(
                'polygon',
                {
                  points: `${lx0},${band.neckTopY} ${lx1},${band.neckTopY} ${ex1},${band.neckBotY} ${ex0},${band.neckBotY}`,
                  fill: '#1D4ED8',
                  'fill-opacity': 0.065
                },
                hg
              );
            }
          }
          const drawn: number[] = [];
          for (const t of times) {
            if (!Number.isFinite(t) || t < band.startT || t > band.endT) continue;
            if (drawn.some((prev) => Math.abs(prev - t) <= 1e-12)) continue;
            drawn.push(t);
            const lx = band.linearXForTime(t);
            const ex = elasticXInBand(band, t);
            if (band.specH > 0) {
              svgEl(
                'line',
                {
                  x1: lx,
                  y1: band.specY,
                  x2: lx,
                  y2: band.anchorY,
                  stroke: '#1D4ED8',
                  'stroke-width': 1,
                  'stroke-dasharray': '3 2.5',
                  opacity: 0.48
                },
                hg
              );
            }
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
          // Straight sloped amber neck line
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
          // Spine-safe full-column amber solid guide across all visible tiers
          drawHoverSpineSafeVertical(snap.x, band.tiersBottomY, '#B45309', 1.5);
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
          svgEl('line', {
            x1: aimX,
            y1: band.neckTopY,
            x2: ex,
            y2: band.neckBotY,
            stroke: strokeC,
            'stroke-width': nearBnd ? 1.3 : 0.85,
            opacity: op * 0.85,
            'stroke-dasharray': nearBnd ? 'none' : '2 2'
          }, hg);
          drawHoverSpineSafeVertical(
            ex,
            band.tiersBottomY,
            strokeC,
            nearBnd ? 1.3 : 0.85,
            op * 0.85,
            nearBnd ? undefined : '2 2'
          );

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
            d: `M${clampedX},${band.linearY} L${clampedX},${band.neckTopY} L${ex},${band.neckBotY}`,
            fill: 'none',
            stroke: '#141413',
            'stroke-width': 0.9,
            opacity: 0.35,
            'stroke-dasharray': '2 2'
          }, hg);
          drawHoverSpineSafeVertical(ex, band.tiersBottomY, '#141413', 0.9, 0.35, '2 2');

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
      if (spacePanRef.current.held) {
        clearHoverGuide();
        return;
      }
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
        const origInActiveBand =
          origTime >= activeBand.startT - 1e-9 && origTime <= activeBand.endT + 1e-9;
        const origX = origInActiveBand ? elasticXInBand(activeBand, origTime) : undefined;
        const origLinearX = origInActiveBand ? activeBand.linearXForTime(origTime) : undefined;
        const loupeVisible = Boolean(audioBuffer && showMicroLoupe);

        setDragPreview({
          bandIndex: activeBand.bandIndex,
          x,
          linearX: linX,
          origTime,
          origX,
          origLinearX,
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
          if (
            !moveTierBoundary(ti, origTime, latestTime, shared, {
              coalesce: false,
              nextSelection: {
                kind: 'boundary',
                tierIndex: ti,
                time: latestTime,
                bandIndex: latestBandIdx
              }
            })
          ) {
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
      if (spacePanRef.current.held) {
        e.preventDefault();
        return;
      }
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
          const origInActiveBand =
            origPt.number >= activeBand.startT - 1e-9 && origPt.number <= activeBand.endT + 1e-9;
          const origX = origInActiveBand ? elasticXInBand(activeBand, origPt.number) : undefined;
          const origLinearX = origInActiveBand
            ? activeBand.linearXForTime(origPt.number)
            : undefined;
          const loupeVisible = Boolean(audioBuffer && showMicroLoupe);

          setDragPreview({
            bandIndex: activeBand.bandIndex,
            x,
            linearX: activeBand.linearXForTime(latestTime),
            origTime: origPt.number,
            origX,
            origLinearX,
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
            const tierName = formatTierLabel(tier.name, ti);
            const oldT = origPt.number;
            commitTgMutation(
              (_draft, ctx) => {
                const dTier = ctx.editTier(ti);
                if (!dTier || dTier.kind !== 'textTier') return false;
                const p = dTier.points[pi];
                if (!p) return false;
                p.number = latestTime;
                dTier.points.sort((a, b) => a.number - b.number);
                const nextIdx = dTier.points.indexOf(p);
                ctx.setNextSelection({
                  kind: 'point',
                  tierIndex: ti,
                  itemIndex: Math.max(0, nextIdx),
                  bandIndex: latestBandIdx
                });
              },
              undefined,
              {
                type: 'move-point',
                title: '移动标注点',
                detail: `${tierName} · ${formatTimeSec(oldT)} → ${formatTimeSec(latestTime)} (${formatDeltaTime(latestTime - oldT)})`,
                icon: 'nudgeFine',
                tierName,
                focusTime: latestTime
              }
            );
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
            const tierName = formatTierLabel(tier.name, ti);
            const textHint = iv.text ? formatQuote(iv.text, 8) : '';
            commitTgMutation(
              (_draft, ctx) => {
                const draftTier = ctx.editTier(ti);
                if (!draftTier || draftTier.kind !== 'intervalTier') return false;
                const targetIv = draftTier.intervals[ii];
                if (!targetIv) return false;
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
                ctx.setNextPlayRange({ start: finalXmin, end: finalXmax });
              },
              nextSel,
              {
                type: 'slide-interval',
                title: '平移区间',
                detail: `${tierName}${textHint} · ${formatDeltaTime(finalXmin - iv.xmin)}`,
                icon: 'navHorizontal',
                tierName,
                focusTime: finalXmin
              }
            );
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
        setSelection({ kind: 'tier', tierIndex: ti, bandIndex: bandIdx });
        if (mode === 'edit') {
          maybeAutoOpenInspector();
        } else {
          const st = useEditorStore.getState();
          if (st.autoOpenInspectorOnSelect && st.editInspectorMode === 'sidebar') {
            if (!st.sidebarOpen) {
              st.setSidebarTab('inspector');
              st.setSidebarOpen(true);
            } else if (st.sidebarTab === 'tiers') {
              st.setSidebarTab('inspector');
            }
          }
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
      if (spacePanRef.current.held) {
        e.preventDefault();
        return;
      }
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
      if (spacePanRef.current.held) return;
      if (inlineTarget) closeInline(true);
      const pt = svgPointFromEvent(e);
      const target = (e.target as Element).closest('[data-role]');
      const isEdit = mode === 'edit';
      const hint = (id: string): string | undefined =>
        getEffectiveShortcutHint(id, customShortcuts) || undefined;
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
                icon: 'play',
                shortcut: hint('replay-selection'),
                action: () => onStartPlayback(playRange.start, playRange.end)
              },
              {
                label: '循环播放',
                icon: 'loop',
                shortcut: hint('loop-toggle'),
                action: () => {
                  setLoop(true);
                  onStartPlayback(playRange.start, playRange.end);
                }
              }
            );
          } else {
            items.push({
              label: `从此处播放 (${clickT.toFixed(3)} s)`,
              icon: 'play',
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
              icon: 'createFromRange',
              shortcut: hint('create-from-playrange'),
              disabled: !hasRange || targetTi < 0,
              action: () => {
                if (targetTi >= 0) createIntervalFromPlayRange(targetTi, bandIdx);
              }
            });
          }
          items.push(
            {
              label: '局部放大到此段',
              icon: 'zoomIn',
              shortcut: hint('zoom-focus'),
              disabled: !hasRange,
              action: () => {
                if (playRange) setViewDomain({ min: playRange.start, max: playRange.end });
              }
            },
            {
              label: '恢复全长',
              icon: 'zoomReset',
              shortcut: hint('zoom-reset'),
              disabled: !viewDomain,
              action: () => setViewDomain(null)
            },
            { divider: true },
            {
              label: '导出此段插图…',
              icon: 'export',
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
                  icon: 'createFromRange',
                  shortcut: hint('create-from-playrange'),
                  action: () => createIntervalFromPlayRange(ti, bandIdx)
                });
              }

              const otherIntervalTiers = tg.tiers
                .map((t, idx) => ({ t, idx }))
                .filter(({ t, idx }) => idx !== ti && t.kind === 'intervalTier');

              const copySpanChildren: ContextMenuItem[] = [];
              otherIntervalTiers.forEach(({ t, idx: targetTi }, pos) => {
                const tierLabel = `${t.displayNum ?? targetTi + 1}. ${t.name || '未命名'}`;
                if (pos > 0) copySpanChildren.push({ divider: true });
                copySpanChildren.push(
                  {
                    label: tierLabel,
                    badge: '含文本',
                    action: () => copyIntervalSpanToTier(ti, ii, targetTi, true)
                  },
                  {
                    label: tierLabel,
                    badge: '仅边界',
                    action: () => copyIntervalSpanToTier(ti, ii, targetTi, false)
                  }
                );
              });

              items.push(
                { label: '编辑文本', icon: 'edit', shortcut: '双击', action: () => openInline({ kind: 'interval', tierIndex: ti, itemIndex: ii }) },
                {
                  label: splitSnap ? `在此处切分（${splitSnap.label}）` : '在此处切分',
                  icon: 'split',
                  disabled: !(splitTargetT > iv.xmin && splitTargetT < iv.xmax),
                  action: () => splitInterval(ti, ii, splitTargetT, { exact: Boolean(splitSnap) })
                },
                { label: '从正中切分', icon: 'split', shortcut: hint('split-mid'), disabled: iv.xmax <= iv.xmin, action: () => splitInterval(ti, ii) },
                {
                  label: '等分该区间',
                  icon: 'splitEqual',
                  disabled: iv.xmax <= iv.xmin,
                  children: [
                    {
                      label: '等分为 2 段',
                      action: () => splitIntervalEqualN(ti, ii, 2)
                    },
                    {
                      label: '等分为 3 段',
                      action: () => splitIntervalEqualN(ti, ii, 3)
                    },
                    {
                      label: '等分为 4 段',
                      action: () => splitIntervalEqualN(ti, ii, 4)
                    },
                    { divider: true },
                    {
                      label: '自定义段数…',
                      action: () => {
                        setSplitEqualDialog({
                          tierIndex: ti,
                          itemIndex: ii,
                          tierName: tier.name || `层 ${ti + 1}`,
                          text: iv.text,
                          xmin: iv.xmin,
                          xmax: iv.xmax
                        });
                      }
                    }
                  ]
                },
                { divider: true },
                { label: '向左合并', icon: 'mergeLeft', shortcut: hint('merge-left'), disabled: ii === 0, action: () => mergeIntervalWith(ti, ii, -1) },
                { label: '向右合并', icon: 'mergeRight', shortcut: hint('merge-right'), disabled: ii >= tier.intervals.length - 1, action: () => mergeIntervalWith(ti, ii, 1) },
                ...(otherIntervalTiers.length > 0
                  ? [
                      {
                        label: '复制到层',
                        icon: 'projectToTier' as IconName,
                        disabled: iv.xmax <= iv.xmin,
                        children: copySpanChildren
                      }
                    ]
                  : []),
                {
                  label: '清空文本',
                  icon: 'clear',
                  shortcut: 'Del',
                  disabled: iv.text === '',
                  action: () => {
                    const tierName = formatTierLabel(tier.name, ti);
                    const oldText = iv.text;
                    commitTgMutation(
                      (_d, ctx) => {
                        const dTier = ctx.editTier(ti);
                        const target = dTier?.intervals[ii];
                        if (!target || target.text === '') return false;
                        target.text = '';
                      },
                      { kind: 'interval', tierIndex: ti, itemIndex: ii, bandIndex: bandIdx },
                      {
                        type: 'clear-interval-text',
                        title: '清空区间文本',
                        detail: `${tierName} · 原${formatQuote(oldText)}`,
                        icon: 'clear',
                        tierName,
                        focusTime: iv.xmin
                      }
                    );
                  }
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
                icon: 'play',
                shortcut: hint('replay-selection'),
                disabled: iv.xmax <= iv.xmin,
                action: () => {
                  setPlayRange({ start: iv.xmin, end: iv.xmax });
                  onStartPlayback(iv.xmin, iv.xmax);
                }
              },
              {
                label: '带语境播放 (±250 ms)',
                icon: 'playContext',
                shortcut: hint('replay-context'),
                disabled: iv.xmax <= iv.xmin,
                action: () => {
                  const s = Math.max(tg.xmin, iv.xmin - 0.25);
                  const en = Math.min(tg.xmax, iv.xmax + 0.25);
                  if (en > s) onStartPlayback(s, en);
                }
              },
              {
                label: '循环播放该区间',
                icon: 'loop',
                disabled: iv.xmax <= iv.xmin,
                action: () => {
                  setLoop(true);
                  setPlayRange({ start: iv.xmin, end: iv.xmax });
                  onStartPlayback(iv.xmin, iv.xmax);
                }
              },
              isZoomedHere
                ? { label: '显示全长视图', icon: 'zoomReset', shortcut: hint('zoom-focus'), action: () => setViewDomain(null) }
                : { label: '放大查看该区间', icon: 'zoomIn', shortcut: hint('zoom-focus'), disabled: iv.xmax <= iv.xmin, action: () => setViewDomain({ min: iv.xmin, max: iv.xmax }) },
              { divider: true },
              { label: '复制文本', icon: 'copy', shortcut: formatKeyCombo('Mod+C'), disabled: iv.text === '', action: () => copyText(iv.text, '区间文本') },
              {
                label: '复制起止时间',
                icon: 'copyTime',
                shortcut: formatKeyCombo('Mod+Shift+C'),
                action: () => copyText(`${formatPraatDouble(iv.xmin)}\t${formatPraatDouble(iv.xmax)}`, '起止时间')
              }
            );
            if (!isEdit) items.push({ divider: true }, { label: '切换到编辑模式', icon: 'edit', shortcut: hint('mode-toggle'), action: () => setMode('edit') });
          }
        } else if (role === 'point') {
          const ti = parseInt(target.getAttribute('data-tier') || '0', 10);
          const pi = parseInt(target.getAttribute('data-idx') || '0', 10);
          const p = tg.tiers[ti]?.points[pi];
          if (p) {
            setSelection({ kind: 'point', tierIndex: ti, itemIndex: pi, bandIndex: bandIdx });
            const playPointContext = () => {
              const s = Math.max(tg.xmin, p.number - 0.25);
              const en = Math.min(tg.xmax, p.number + 0.25);
              if (en > s) onStartPlayback(s, en);
            };
            if (isEdit) {
              items.push(
                { label: '编辑标记', icon: 'edit', shortcut: '双击', action: () => openInline({ kind: 'point', tierIndex: ti, itemIndex: pi }) },
                { label: '带语境播放 (±250 ms)', icon: 'playContext', shortcut: hint('replay-context'), action: playPointContext },
                { label: '从此点播放', icon: 'play', action: () => { setPlayRange(null); onStartPlayback(p.number, tg.xmax); } },
                { label: '复制标记文本', icon: 'copy', shortcut: formatKeyCombo('Mod+C'), disabled: p.mark === '', action: () => copyText(p.mark, '标记文本') },
                { label: '复制时间戳', icon: 'copyTime', action: () => copyText(formatPraatDouble(p.number), '时间戳') },
                { divider: true },
                {
                  label: '删除此点',
                  icon: 'trash',
                  shortcut: 'Del',
                  danger: true,
                  action: () => {
                    const tierName = formatTierLabel(tg.tiers[ti]?.name, ti);
                    const ptTime = p.number;
                    const ptMark = p.mark;
                    commitTgMutation(
                      (_d, ctx) => {
                        const dTier = ctx.editTier(ti);
                        if (!dTier || !dTier.points[pi]) return false;
                        dTier.points.splice(pi, 1);
                      },
                      null,
                      {
                        type: 'delete-point',
                        title: '删除标注点',
                        detail: `${tierName} · ${formatTimeSec(ptTime)} ${formatQuote(ptMark)}`,
                        icon: 'trash',
                        tierName,
                        focusTime: ptTime
                      }
                    );
                  }
                }
              );
            } else {
              items.push(
                { label: '带语境播放 (±250 ms)', icon: 'playContext', shortcut: hint('replay-context'), action: playPointContext },
                { label: '从此点播放', icon: 'play', action: () => { setPlayRange(null); onStartPlayback(p.number, tg.xmax); } },
                { label: '复制标记文本', icon: 'copy', disabled: p.mark === '', action: () => copyText(p.mark, '标记文本') },
                { label: '复制时间戳', icon: 'copyTime', action: () => copyText(formatPraatDouble(p.number), '时间戳') },
                { divider: true },
                { label: '切换到编辑模式', icon: 'edit', shortcut: hint('mode-toggle'), action: () => setMode('edit') }
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
                { label: '试听跨越边界 (±200 ms)', icon: 'playContext', action: auditionBoundary },
                { label: '从此处播放', icon: 'play', action: () => { setPlayRange(null); onStartPlayback(time, tg.xmax); } },
                { label: '复制边界时间', icon: 'copyTime', action: () => copyText(formatPraatDouble(time), '边界时间') },
                { divider: true },
                {
                  label: '吸附最近过零点',
                  icon: 'zeroCross',
                  shortcut: hint('snap-zero-crossing'),
                  disabled: !analysis,
                  action: () => void snapTargetToZeroCrossing({ kind: 'boundary', tierIndex: ti, time, bandIndex: bandIdx })
                },
                ...(otherIntervalTiers.length > 0
                  ? [
                      {
                        label: '将边界复制到层',
                        icon: 'projectToTier' as IconName,
                        children: otherIntervalTiers.map(({ t, idx: targetTi }) => ({
                          label: `${t.displayNum ?? targetTi + 1}. ${t.name || '未命名'}`,
                          action: () => projectBoundaryToTier(targetTi, time)
                        }))
                      }
                    ]
                  : []),
                { divider: true },
                { label: '删除边界（合并两侧）', icon: 'delBoundary', shortcut: 'Del', danger: true, action: () => deleteBoundaryAt(ti, time) },
                {
                  label: '跨层删除对齐边界',
                  icon: 'delBoundaryAll',
                  shortcut: 'Shift+Del',
                  danger: true,
                  action: () => deleteBoundaryAcrossAllTiers(time)
                }
              );
            } else {
              items.push(
                { label: '试听跨越边界 (±200 ms)', icon: 'playContext', action: auditionBoundary },
                { label: '从此处播放', icon: 'play', action: () => { setPlayRange(null); onStartPlayback(time, tg.xmax); } },
                { label: '复制边界时间', icon: 'copyTime', action: () => copyText(formatPraatDouble(time), '边界时间') },
                { divider: true },
                { label: '切换到编辑模式', icon: 'edit', shortcut: hint('mode-toggle'), action: () => setMode('edit') }
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
              icon: 'addPointTier',
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
            icon: 'play',
            action: () => {
              setPlayRange(null);
              onStartPlayback(clickT, tg.xmax);
            }
          });
          if (!isEdit) {
            items.push({ divider: true }, { label: '切换到编辑模式', icon: 'edit', shortcut: hint('mode-toggle'), action: () => setMode('edit') });
          }
        } else if (role === 'spine-tick') {
          const t = parseFloat(target.getAttribute('data-time') || '0');
          if (Number.isFinite(t)) {
            if (isEdit) {
              setSelection({ kind: 'spine', time: t, bandIndex: bandIdx });
            }
            items.push(
              { label: `复制时刻 (${formatPraatDouble(t)})`, icon: 'copyTime', action: () => copyText(formatPraatDouble(t), '时间戳') },
              {
                label: '从此精确时刻播放',
                icon: 'play',
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
                  icon: 'zeroCross',
                  shortcut: hint('snap-zero-crossing'),
                  disabled: !analysis,
                  action: () => void snapTargetToZeroCrossing({ kind: 'spine', time: t, bandIndex: bandIdx })
                },
                {
                  label: '跨层删除对齐边界',
                  icon: 'delBoundaryAll',
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
              { label: '重命名层', icon: 'edit', shortcut: '双击', action: () => openInline({ kind: 'tier-name', tierIndex: ti }) },
              { label: '上移一层', icon: 'up', disabled: ti === 0, action: () => moveTier(ti, -1) },
              { label: '下移一层', icon: 'down', disabled: ti >= tg.tiers.length - 1, action: () => moveTier(ti, 1) },
              { divider: true },
              { label: '在上方插入区间层', icon: 'addIntervalTier', action: () => insertTierAt(ti, 'intervalTier') },
              { label: '在下方插入区间层', icon: 'addIntervalTier', action: () => insertTierAt(ti + 1, 'intervalTier') },
              { label: '在下方插入点层', icon: 'addPointTier', action: () => insertTierAt(ti + 1, 'textTier') },
              { divider: true },
              { label: '复制层级（含文本）', icon: 'duplicateTier', action: () => duplicateTier(ti, { copyText: true }) },
              {
                label: '仅复制边界新建层',
                icon: 'duplicateTier',
                disabled: tier.kind !== 'intervalTier',
                action: () => duplicateTier(ti, { copyText: false })
              },
              {
                label: '从区间派生点层（中点）',
                icon: 'derivePointTier',
                disabled: tier.kind !== 'intervalTier',
                action: () => derivePointTierFromIntervals(ti, 'mid')
              },
              {
                label: '对齐微偏边界 (< 5 ms)',
                icon: 'normalize',
                action: () => {
                  const res = alignMicroBoundaries(ti, 0.005);
                  const fb = formatAlignMicroFeedback(res, tier.name || `第 ${ti + 1} 层`);
                  showToast(fb.message, fb.isError);
                }
              },
              { divider: true },
              { label: '隐藏此层', icon: 'hideTier', action: () => toggleTierVisibility(ti) },
              { label: '清空本层文本', icon: 'clear', action: () => clearTierText(ti) },
              { label: '删除该层', icon: 'trash', shortcut: 'Shift+Del', danger: true, action: () => removeTierWithUndoToast(ti) }
            );
          } else if (tier) {
            items.push(
              { label: '复制层名', icon: 'copy', disabled: !tier.name, action: () => copyText(tier.name, '层名') },
              { label: '隐藏此层', icon: 'hideTier', action: () => toggleTierVisibility(ti) },
              { divider: true },
              {
                label: '切换到编辑模式',
                icon: 'edit',
                shortcut: hint('mode-toggle'),
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
      const z = getViewportZoom();
      const { width: vw, height: vh } = getLogicalViewportSize();
      const estHeight = items.reduce((acc, it) => acc + (it.divider ? 7 : 30), 12);
      const x = Math.max(8, Math.min(e.clientX / z, vw - 220));
      const y = Math.max(8, Math.min(e.clientY / z, vh - estHeight - 12));
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
      (!dragPreview || scrubPreviewing) &&
      !intervalDragPreview
        ? getSelectionAnchor(layout, selection)
        : null;
    const anchorRect = selectionAnchor?.rect ?? null;
    const anchorBand = selectionAnchor?.band ?? null;

    const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (isComposingEvent(e)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.currentTarget.blur();
      }
    };

    const renderFloatingBarContent = (): React.ReactNode => {
      if (!selection || !anchorRect || !anchorBand) return null;

      if (selection.kind === 'interval') {
        const tier = tg.tiers[selection.tierIndex];
        const iv = tier?.intervals[selection.itemIndex];
        if (!tier || !iv) return null;
        const visibleIds = getVisibleBarItems('interval');
        if (visibleIds.length === 0) return null;

        const isZoomedHere = Boolean(
          viewDomain && Math.abs(viewDomain.min - iv.xmin) < 1e-4 && Math.abs(viewDomain.max - iv.xmax) < 1e-4
        );
        const durMs = Math.max(0, Math.round((iv.xmax - iv.xmin) * 1000));
        const prev = tier.intervals[selection.itemIndex - 1];
        const next = tier.intervals[selection.itemIndex + 1];
        const hasContigPrev = Boolean(prev && prev.xmax === iv.xmin);
        const hasContigNext = Boolean(next && next.xmin === iv.xmax);

        const entries: Array<{ id: string; node: React.ReactNode }> = [];
        for (const id of visibleIds) {
          switch (id) {
            case 'iv-times':
              entries.push({
                id,
                node: (
                  <>
                    <ScrubNumberInput
                      variant="floating"
                      label="起"
                      value={iv.xmin}
                      min={hasContigPrev && prev ? prev.xmin : undefined}
                      strictMin={hasContigPrev}
                      max={iv.xmax}
                      strictMax
                      formatValue={formatPraatDouble}
                      onScrubPreview={(previewT) =>
                        showScrubPreviewLine(previewT, selection.tierIndex, false)
                      }
                      onScrubEnd={clearScrubPreview}
                      onCommit={(val) => {
                        if (val >= iv.xmax) {
                          showToast('起点必须严格小于终点', true);
                          return false;
                        }
                        if (prev && prev.xmax === iv.xmin && val <= prev.xmin) {
                          showToast('起点不能越过左侧相邻区间', true);
                          return false;
                        }
                        if (val !== iv.xmin) {
                          const ti = selection.tierIndex;
                          const ii = selection.itemIndex;
                          const tierName = formatTierLabel(tier.name, ti);
                          const oldVal = iv.xmin;
                          commitTgMutation(
                            (_draft, ctx) => {
                              const dTier = ctx.editTier(ti);
                              if (!dTier || dTier.kind !== 'intervalTier') return false;
                              const dPrev = dTier.intervals[ii - 1];
                              const cur = dTier.intervals[ii];
                              if (!cur) return false;
                              if (dPrev && dPrev.xmax === cur.xmin && val > dPrev.xmin) dPrev.xmax = val;
                              cur.xmin = val;
                              ctx.setNextPlayRange({ start: val, end: cur.xmax });
                            },
                            undefined,
                            {
                              type: 'edit-interval-edge',
                              title: '调整区间起点',
                              detail: `${tierName} · 起点 ${formatTimeSec(oldVal)} → ${formatTimeSec(val)} (${formatDeltaTime(val - oldVal)})`,
                              icon: 'nudgeFine',
                              tierName,
                              focusTime: val,
                              coalesce: {
                                key: `edge:${ti}:${ii}:start`,
                                originValue: oldVal,
                                latestValue: val,
                                chainPrevLatest: oldVal,
                                formatMergedDetail: (orig, latest, count) => {
                                  const o = Number(orig);
                                  const l = Number(latest);
                                  return `${tierName} · 起点 ${formatTimeSec(o)} → ${formatTimeSec(l)} (${formatDeltaTime(l - o)}${count > 1 ? ` · ${count}次` : ''})`;
                                }
                              }
                            }
                          );
                        }
                        return true;
                      }}
                    />
                    <ScrubNumberInput
                      variant="floating"
                      label="止"
                      value={iv.xmax}
                      min={iv.xmin}
                      strictMin
                      max={hasContigNext && next ? next.xmax : undefined}
                      strictMax={hasContigNext}
                      formatValue={formatPraatDouble}
                      onScrubPreview={(previewT) =>
                        showScrubPreviewLine(previewT, selection.tierIndex, false)
                      }
                      onScrubEnd={clearScrubPreview}
                      onCommit={(val) => {
                        if (val <= iv.xmin) {
                          showToast('终点必须严格大于起点', true);
                          return false;
                        }
                        if (next && next.xmin === iv.xmax && val >= next.xmax) {
                          showToast('终点不能越过右侧相邻区间', true);
                          return false;
                        }
                        if (val !== iv.xmax) {
                          const ti = selection.tierIndex;
                          const ii = selection.itemIndex;
                          const tierName = formatTierLabel(tier.name, ti);
                          const oldVal = iv.xmax;
                          commitTgMutation(
                            (_draft, ctx) => {
                              const dTier = ctx.editTier(ti);
                              if (!dTier || dTier.kind !== 'intervalTier') return false;
                              const dNext = dTier.intervals[ii + 1];
                              const cur = dTier.intervals[ii];
                              if (!cur) return false;
                              if (dNext && dNext.xmin === cur.xmax && val < dNext.xmax) dNext.xmin = val;
                              cur.xmax = val;
                              ctx.setNextPlayRange({ start: cur.xmin, end: val });
                            },
                            undefined,
                            {
                              type: 'edit-interval-edge',
                              title: '调整区间终点',
                              detail: `${tierName} · 终点 ${formatTimeSec(oldVal)} → ${formatTimeSec(val)} (${formatDeltaTime(val - oldVal)})`,
                              icon: 'nudgeFine',
                              tierName,
                              focusTime: val,
                              coalesce: {
                                key: `edge:${ti}:${ii}:end`,
                                originValue: oldVal,
                                latestValue: val,
                                chainPrevLatest: oldVal,
                                formatMergedDetail: (orig, latest, count) => {
                                  const o = Number(orig);
                                  const l = Number(latest);
                                  return `${tierName} · 终点 ${formatTimeSec(o)} → ${formatTimeSec(l)} (${formatDeltaTime(l - o)}${count > 1 ? ` · ${count}次` : ''})`;
                                }
                              }
                            }
                          );
                        }
                        return true;
                      }}
                    />
                  </>
                )
              });
              break;
            case 'iv-dur':
              entries.push({
                id,
                node: (
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
                )
              });
              break;
            case 'iv-edit':
              entries.push({
                id,
                node: (
                  <button type="button" className="compact" onClick={() => openInline(selection)}>
                    <UiIcon name="edit" size={13} />
                    <span>改字</span>
                  </button>
                )
              });
              break;
            case 'iv-clear':
              if (iv.text !== '') {
                entries.push({
                  id,
                  node: (
                    <button
                      type="button"
                      className="compact"
                      onClick={() => {
                        const ti = selection.tierIndex;
                        const ii = selection.itemIndex;
                        const tierName = formatTierLabel(tier.name, ti);
                        const oldText = iv.text;
                        commitTgMutation(
                          (_d, ctx) => {
                            const dTier = ctx.editTier(ti);
                            const target = dTier?.intervals[ii];
                            if (!target || target.text === '') return false;
                            target.text = '';
                          },
                          selection,
                          {
                            type: 'clear-interval-text',
                            title: '清空区间文本',
                            detail: `${tierName} · 原${formatQuote(oldText)}`,
                            icon: 'clear',
                            tierName,
                            focusTime: iv.xmin
                          }
                        );
                      }}
                    >
                      <UiIcon name="clear" size={13} />
                      <span>清空</span>
                    </button>
                  )
                });
              }
              break;
            case 'iv-split':
              entries.push({
                id,
                node: (
                  <button
                    type="button"
                    className="compact"
                    disabled={iv.xmax <= iv.xmin}
                    onClick={() => splitInterval(selection.tierIndex, selection.itemIndex)}
                  >
                    <UiIcon name="split" size={13} />
                    <span>切分</span>
                  </button>
                )
              });
              break;
            case 'iv-split-equal':
              entries.push({
                id,
                node: (
                  <button
                    type="button"
                    className="compact"
                    disabled={iv.xmax <= iv.xmin}
                    title="等分为 2 段"
                    onClick={() => splitIntervalEqualN(selection.tierIndex, selection.itemIndex, 2)}
                  >
                    <UiIcon name="splitEqual" size={13} />
                    <span>等分</span>
                  </button>
                )
              });
              break;
            case 'iv-merge-left':
              entries.push({
                id,
                node: (
                  <button
                    type="button"
                    className="compact"
                    disabled={selection.itemIndex === 0}
                    onClick={() => mergeIntervalWith(selection.tierIndex, selection.itemIndex, -1)}
                  >
                    <UiIcon name="mergeLeft" size={13} />
                    <span>合左</span>
                  </button>
                )
              });
              break;
            case 'iv-merge-right':
              entries.push({
                id,
                node: (
                  <button
                    type="button"
                    className="compact"
                    disabled={selection.itemIndex >= tier.intervals.length - 1}
                    onClick={() => mergeIntervalWith(selection.tierIndex, selection.itemIndex, 1)}
                  >
                    <UiIcon name="mergeRight" size={13} />
                    <span>合右</span>
                  </button>
                )
              });
              break;
            case 'iv-play':
              entries.push({
                id,
                node: (
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
                )
              });
              break;
            case 'iv-play-ctx':
              entries.push({
                id,
                node: (
                  <button
                    type="button"
                    className="compact"
                    disabled={iv.xmax <= iv.xmin}
                    title="带语境播放 (±250 ms)"
                    onClick={() => {
                      const s = Math.max(tg.xmin, iv.xmin - 0.25);
                      const en = Math.min(tg.xmax, iv.xmax + 0.25);
                      if (en > s) onStartPlayback(s, en);
                    }}
                  >
                    <UiIcon name="playContext" size={13} />
                    <span>±250ms</span>
                  </button>
                )
              });
              break;
            case 'iv-zoom':
              entries.push({
                id,
                node: isZoomedHere ? (
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
                )
              });
              break;
            case 'iv-copy-text':
              entries.push({
                id,
                node: (
                  <button
                    type="button"
                    className="compact"
                    disabled={iv.text === ''}
                    title="复制区间文本"
                    onClick={() => copyText(iv.text, '区间文本')}
                  >
                    <UiIcon name="copy" size={13} />
                    <span>复制</span>
                  </button>
                )
              });
              break;
          }
        }
        return assembleFloatingBarNodes(entries);
      }

      if (selection.kind === 'point') {
        const tier = tg.tiers[selection.tierIndex];
        const pt = tier?.points[selection.itemIndex];
        if (!tier || !pt) return null;
        const visibleIds = getVisibleBarItems('point');
        if (visibleIds.length === 0) return null;

        const entries: Array<{ id: string; node: React.ReactNode }> = [];
        for (const id of visibleIds) {
          switch (id) {
            case 'pt-time':
              entries.push({
                id,
                node: (
                  <ScrubNumberInput
                    variant="floating"
                    label="时间"
                    value={pt.number}
                    min={Number.isFinite(tier.xmin) ? tier.xmin : undefined}
                    max={Number.isFinite(tier.xmax) ? tier.xmax : undefined}
                    formatValue={formatPraatDouble}
                    onScrubPreview={(previewT) =>
                      showScrubPreviewLine(previewT, selection.tierIndex, false)
                    }
                    onScrubEnd={clearScrubPreview}
                    onCommit={(val) => {
                      if (tier.points.some((p, i) => i !== selection.itemIndex && p.number === val)) {
                        showToast('目标时刻已存在标点', true);
                        return false;
                      }
                      if (val !== pt.number) {
                        const ti = selection.tierIndex;
                        const pi = selection.itemIndex;
                        const tierName = formatTierLabel(tier.name, ti);
                        const oldT = pt.number;
                        commitTgMutation(
                          (_draft, ctx) => {
                            const dTier = ctx.editTier(ti);
                            if (!dTier || dTier.kind !== 'textTier') return false;
                            const targetPt = dTier.points[pi];
                            if (!targetPt) return false;
                            targetPt.number = val;
                            dTier.points.sort((a, b) => a.number - b.number);
                            const nextIdx = dTier.points.indexOf(targetPt);
                            ctx.setNextSelection({
                              kind: 'point',
                              tierIndex: ti,
                              itemIndex: Math.max(0, nextIdx),
                              bandIndex: selection.bandIndex
                            });
                          },
                          undefined,
                          {
                            type: 'move-point',
                            title: '移动标注点',
                            detail: `${tierName} · ${formatTimeSec(oldT)} → ${formatTimeSec(val)} (${formatDeltaTime(val - oldT)})`,
                            icon: 'nudgeFine',
                            tierName,
                            focusTime: val,
                            coalesce: {
                              key: `move-point:${ti}`,
                              originValue: oldT,
                              latestValue: val,
                              chainPrevLatest: oldT,
                              formatMergedDetail: (orig, latest, count) => {
                                const o = Number(orig);
                                const l = Number(latest);
                                return `${tierName} · ${formatTimeSec(o)} → ${formatTimeSec(l)} (${formatDeltaTime(l - o)}${count > 1 ? ` · ${count}次` : ''})`;
                              }
                            }
                          }
                        );
                      }
                      return true;
                    }}
                  />
                )
              });
              break;
            case 'pt-edit':
              entries.push({
                id,
                node: (
                  <button type="button" className="compact" onClick={() => openInline(selection)}>
                    <UiIcon name="edit" size={13} />
                    <span>改字</span>
                  </button>
                )
              });
              break;
            case 'pt-play':
              entries.push({
                id,
                node: (
                  <button
                    type="button"
                    className="compact"
                    onClick={() => {
                      setPlayRange(null);
                      onStartPlayback(pt.number, tg.xmax);
                    }}
                  >
                    <UiIcon name="play" size={13} />
                    <span>播放</span>
                  </button>
                )
              });
              break;
            case 'pt-play-ctx':
              entries.push({
                id,
                node: (
                  <button
                    type="button"
                    className="compact"
                    title="跨越标点带语境试听 (±250 ms)"
                    onClick={() => {
                      const s = Math.max(tg.xmin, pt.number - 0.25);
                      const en = Math.min(tg.xmax, pt.number + 0.25);
                      if (en > s) onStartPlayback(s, en);
                    }}
                  >
                    <UiIcon name="playContext" size={13} />
                    <span>±250ms</span>
                  </button>
                )
              });
              break;
            case 'pt-delete':
              entries.push({
                id,
                node: (
                  <button
                    type="button"
                    className="compact danger"
                    onClick={() => {
                      const ti = selection.tierIndex;
                      const pi = selection.itemIndex;
                      const tierName = formatTierLabel(tier.name, ti);
                      const ptTime = pt.number;
                      const ptMark = pt.mark;
                      commitTgMutation(
                        (_draft, ctx) => {
                          const dTier = ctx.editTier(ti);
                          if (!dTier || !dTier.points[pi]) return false;
                          dTier.points.splice(pi, 1);
                        },
                        null,
                        {
                          type: 'delete-point',
                          title: '删除标注点',
                          detail: `${tierName} · ${formatTimeSec(ptTime)} ${formatQuote(ptMark)}`,
                          icon: 'trash',
                          tierName,
                          focusTime: ptTime
                        }
                      );
                    }}
                  >
                    <UiIcon name="trash" size={13} />
                    <span>删除</span>
                  </button>
                )
              });
              break;
          }
        }
        return assembleFloatingBarNodes(entries);
      }

      if (selection.kind === 'boundary') {
        const visibleIds = getVisibleBarItems('boundary');
        if (visibleIds.length === 0) return null;
        const { minAllowed, maxAllowed } = getBoundaryDragBounds(
          tg,
          selection.tierIndex,
          selection.time,
          false
        );
        const zHint = getEffectiveShortcutHint('snap-zero-crossing', customShortcuts);
        const entries: Array<{ id: string; node: React.ReactNode }> = [];
        for (const id of visibleIds) {
          switch (id) {
            case 'bnd-time':
              entries.push({
                id,
                node: (
                  <ScrubNumberInput
                    variant="floating"
                    label="边界"
                    value={selection.time}
                    min={Number.isFinite(minAllowed) ? minAllowed : undefined}
                    max={Number.isFinite(maxAllowed) ? maxAllowed : undefined}
                    formatValue={formatPraatDouble}
                    onScrubPreview={(previewT) =>
                      showScrubPreviewLine(previewT, selection.tierIndex, false)
                    }
                    onScrubEnd={clearScrubPreview}
                    onCommit={(val) =>
                      moveTierBoundary(selection.tierIndex, selection.time, val, false, {
                        nextSelection: {
                          kind: 'boundary',
                          tierIndex: selection.tierIndex,
                          time: val,
                          bandIndex: selection.bandIndex
                        }
                      })
                    }
                  />
                )
              });
              break;
            case 'bnd-zero':
              entries.push({
                id,
                node: (
                  <button
                    type="button"
                    className="compact"
                    disabled={!analysis}
                    title={zHint ? `吸附最近音频过零点 (${zHint})` : '吸附最近音频过零点'}
                    onClick={() => void snapTargetToZeroCrossing(selection)}
                  >
                    <UiIcon name="zeroCross" size={13} />
                    <span>过零</span>
                  </button>
                )
              });
              break;
            case 'bnd-audition':
              entries.push({
                id,
                node: (
                  <button
                    type="button"
                    className="compact"
                    onClick={() => {
                      const s = Math.max(tg.xmin, selection.time - 0.2);
                      const en = Math.min(tg.xmax, selection.time + 0.2);
                      if (en > s) onStartPlayback(s, en);
                    }}
                  >
                    <UiIcon name="playContext" size={13} />
                    <span>试听 ±200ms</span>
                  </button>
                )
              });
              break;
            case 'bnd-delete':
              entries.push({
                id,
                node: (
                  <button
                    type="button"
                    className="compact danger"
                    onClick={() => deleteBoundaryAt(selection.tierIndex, selection.time)}
                  >
                    <UiIcon name="delBoundary" size={13} />
                    <span>删除边界</span>
                  </button>
                )
              });
              break;
          }
        }
        return assembleFloatingBarNodes(entries);
      }

      if (selection.kind === 'spine') {
        const { minAllowed, maxAllowed } = getBoundaryDragBounds(tg, 0, selection.time, true);
        const showSpineZero = !floatingBarConfig.boundary.hidden.includes('bnd-zero');
        const zHint = getEffectiveShortcutHint('snap-zero-crossing', customShortcuts);
        return (
          <>
            <ScrubNumberInput
              variant="floating"
              label="对齐时刻"
              value={selection.time}
              min={Number.isFinite(minAllowed) ? minAllowed : undefined}
              max={Number.isFinite(maxAllowed) ? maxAllowed : undefined}
              formatValue={formatPraatDouble}
              onScrubPreview={(previewT) => showScrubPreviewLine(previewT, 0, true)}
              onScrubEnd={clearScrubPreview}
              onCommit={(val) =>
                moveSharedTimestamp(selection.time, val, {
                  nextSelection: {
                    kind: 'spine',
                    time: val,
                    bandIndex: selection.bandIndex
                  }
                })
              }
            />
            {showSpineZero && (
              <>
                <div className="sep" />
                <button
                  type="button"
                  className="compact"
                  disabled={!analysis}
                  title={zHint ? `跨层吸附最近音频过零点 (${zHint})` : '跨层吸附最近音频过零点'}
                  onClick={() => void snapTargetToZeroCrossing(selection)}
                >
                  <UiIcon name="zeroCross" size={13} />
                  <span>过零</span>
                </button>
              </>
            )}
          </>
        );
      }

      if (selection.kind === 'tier') {
        const tier = tg.tiers[selection.tierIndex];
        if (!tier) return null;
        const visibleIds = getVisibleBarItems('tier');
        if (visibleIds.length === 0) return null;

        const entries: Array<{ id: string; node: React.ReactNode }> = [];
        for (const id of visibleIds) {
          switch (id) {
            case 'tier-name':
              entries.push({
                id,
                node: (
                  <label className="field-inline">
                    层名
                    <input
                      type="text"
                      defaultValue={tier.name}
                      key={`tn-${selection.tierIndex}-${tier.name}`}
                      onKeyDown={blurOnEnter}
                      onBlur={(e) => {
                        if (e.target.value !== tier.name) {
                          const ti = selection.tierIndex;
                          const prevName = tier.name;
                          const nextName = e.target.value;
                          commitTgMutation(
                            (_d, ctx) => {
                              const dTier = ctx.editTier(ti);
                              if (!dTier || dTier.name === nextName) return false;
                              dTier.name = nextName;
                            },
                            undefined,
                            {
                              type: 'rename-tier',
                              title: '重命名层级',
                              detail: `${formatQuote(prevName)}→${formatQuote(nextName)}`,
                              icon: 'edit',
                              tierName: formatTierLabel(nextName, ti)
                            }
                          );
                        }
                      }}
                    />
                  </label>
                )
              });
              break;
            case 'tier-bounds':
              entries.push({
                id,
                node: (
                  <>
                    <ScrubNumberInput
                      variant="floating"
                      label="起"
                      value={tier.xmin}
                      max={tier.xmax}
                      strictMax
                      formatValue={formatPraatDouble}
                      onCommit={(val) => {
                        if (!Number.isFinite(val) || val >= tier.xmax) {
                          showToast('起点必须严格小于终点', true);
                          return false;
                        }
                        if (val !== tier.xmin) {
                          const ti = selection.tierIndex;
                          const tierName = formatTierLabel(tier.name, ti);
                          const oldV = tier.xmin;
                          commitTgMutation(
                            (_d, ctx) => {
                              const dTier = ctx.editTier(ti);
                              if (!dTier || dTier.xmin === val) return false;
                              dTier.xmin = val;
                            },
                            undefined,
                            {
                              type: 'edit-tier-bounds',
                              title: '修改层起点',
                              detail: `${formatQuote(tierName)} · ${formatTimeSec(oldV)} → ${formatTimeSec(val)}`,
                              icon: 'copyTime',
                              tierName,
                              focusTime: val
                            }
                          );
                        }
                        return true;
                      }}
                    />
                    <ScrubNumberInput
                      variant="floating"
                      label="止"
                      value={tier.xmax}
                      min={tier.xmin}
                      strictMin
                      formatValue={formatPraatDouble}
                      onCommit={(val) => {
                        if (!Number.isFinite(val) || val <= tier.xmin) {
                          showToast('终点必须严格大于起点', true);
                          return false;
                        }
                        if (val !== tier.xmax) {
                          const ti = selection.tierIndex;
                          const tierName = formatTierLabel(tier.name, ti);
                          const oldV = tier.xmax;
                          commitTgMutation(
                            (_d, ctx) => {
                              const dTier = ctx.editTier(ti);
                              if (!dTier || dTier.xmax === val) return false;
                              dTier.xmax = val;
                            },
                            undefined,
                            {
                              type: 'edit-tier-bounds',
                              title: '修改层终点',
                              detail: `${formatQuote(tierName)} · ${formatTimeSec(oldV)} → ${formatTimeSec(val)}`,
                              icon: 'copyTime',
                              tierName,
                              focusTime: val
                            }
                          );
                        }
                        return true;
                      }}
                    />
                  </>
                )
              });
              break;
            case 'tier-move':
              entries.push({
                id,
                node: (
                  <>
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
                  </>
                )
              });
              break;
            case 'tier-delete':
              entries.push({
                id,
                node: (
                  <button
                    type="button"
                    className="compact danger"
                    onClick={() => removeTierWithUndoToast(selection.tierIndex)}
                  >
                    <UiIcon name="trash" size={13} />
                    <span>删除</span>
                  </button>
                )
              });
              break;
          }
        }
        return assembleFloatingBarNodes(entries);
      }

      return null;
    };

    const floatingBarContent = renderFloatingBarContent();
    const hasFloatingBarContent = Boolean(floatingBarContent);

    const [floatingPos, setFloatingPos] = useState<{ left: number; top: number } | null>(null);

    useLayoutEffect(() => {
      if (!anchorRect || !anchorBand || !selection || !hasFloatingBarContent) {
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
          const z = getElementRectScale(sheetEl);
          const stageRect = stageEl.getBoundingClientRect();
          const sheetRect = sheetEl.getBoundingClientRect();
          const sheetOriginX = sheetRect.left + sheetEl.clientLeft * z;
          const visLeftInSheet = (stageRect.left - sheetOriginX) / z;
          const visRightInSheet = (stageRect.right - sheetOriginX) / z;
          const visMin = Math.max(margin, visLeftInSheet + margin);
          const visMax = Math.min(
            layout.width - barW - margin,
            visRightInSheet - barW - margin
          );
          if (visMin <= visMax) {
            minLeft = visMin;
            maxLeft = visMax;
          }
        }
        const left = Math.max(minLeft, Math.min(maxLeft, anchorRect.x + anchorRect.w / 2 - barW / 2));

        // Vertical: avoid own tiers, own waveform/spectrogram, and adjacent bands' waveform/tier boundaries.
        const prevBand = anchorBand.bandIndex > 0 ? layout.bands[anchorBand.bandIndex - 1] : null;
        const nextBand =
          anchorBand.bandIndex + 1 < layout.bands.length
            ? layout.bands[anchorBand.bandIndex + 1]
            : null;
        const compactGap = 6;
        const belowTop = anchorBand.tiersBottomY + compactGap;
        const aboveTop = anchorBand.linearY - barH - compactGap;

        const overlapLen = (a0: number, a1: number, b0: number, b1: number) =>
          Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

        const rectsOverlap = (
          ax0: number,
          ay0: number,
          ax1: number,
          ay1: number,
          bx0: number,
          by0: number,
          bx1: number,
          by1: number
        ) => overlapLen(ax0, ax1, bx0, bx1) * overlapLen(ay0, ay1, by0, by1);

        let minVisTop = margin;
        let maxVisTop = Math.max(margin, layout.height - barH - margin);
        let visBottomInSheet = layout.height - margin;
        if (stageEl && sheetEl) {
          const z = getElementRectScale(sheetEl);
          const stageRect = stageEl.getBoundingClientRect();
          const sheetRect = sheetEl.getBoundingClientRect();
          const sheetOriginY = sheetRect.top + sheetEl.clientTop * z;
          const visibleTopInSheet = (stageRect.top - sheetOriginY) / z;
          const visibleBottomInSheet = (stageRect.bottom - sheetOriginY) / z;
          minVisTop = visibleTopInSheet + margin;
          visBottomInSheet = visibleBottomInSheet - margin;
          maxVisTop = Math.max(minVisTop, visBottomInSheet - barH);
        }

        const belowClearOfNext = !nextBand || belowTop + barH <= nextBand.linearY - 4;
        const aboveClearOfPrev = !prevBand || aboveTop >= prevBand.tiersBottomY + 4;
        const fitsBelow = belowClearOfNext && belowTop >= minVisTop && belowTop <= maxVisTop;
        const fitsAbove = aboveClearOfPrev && aboveTop >= minVisTop && aboveTop <= maxVisTop;

        let chosenLeft = left;
        let chosenTop = belowTop;

        if (fitsBelow) {
          chosenTop = belowTop;
        } else if (fitsAbove) {
          chosenTop = aboveTop;
        } else {
          // Score non-occluding fallback slots (below/above selection, beside selection, viewport edges)
          const acousticTop = anchorBand.linearY;
          const acousticBot =
            anchorBand.specH > 0 ? anchorBand.anchorY + anchorBand.anchorH : anchorBand.linearY + anchorBand.linearH;

          const scorePlacement = (candL: number, candT: number): number => {
            const l = Math.max(minLeft, Math.min(maxLeft, candL));
            const t = Math.max(minVisTop, Math.min(maxVisTop, candT));
            const r = l + barW;
            const b = t + barH;
            let penalty = 0;
            // Heavy penalty for overlapping the selected target itself
            penalty +=
              rectsOverlap(
                l,
                t,
                r,
                b,
                anchorRect.x - 4,
                anchorRect.y - 4,
                anchorRect.x + anchorRect.w + 4,
                anchorRect.y + anchorRect.h + 4
              ) * 40;
            // Heavy penalty for overlapping adjacent band waveforms / bands
            if (nextBand) {
              penalty += overlapLen(t, b, nextBand.linearY - 2, nextBand.tiersTopY) * 180;
              penalty += overlapLen(t, b, nextBand.tiersTopY, nextBand.tiersBottomY) * 90;
            }
            if (prevBand) {
              penalty += overlapLen(t, b, prevBand.linearY, prevBand.tiersBottomY + 2) * 140;
            }
            // High penalty for overlapping owning band's waveform / spectrogram
            if (anchorBand.linearH > 0) {
              penalty += overlapLen(t, b, acousticTop, acousticBot) * 120;
            }
            // Mild penalty for overlapping sibling tiers inside owning band
            penalty += overlapLen(t, b, anchorBand.tiersTopY, anchorBand.tiersBottomY) * 20;
            // Slight preference for proximity to anchor
            penalty += Math.abs(t - (anchorRect.y + anchorRect.h / 2)) * 0.05;
            return penalty;
          };

          const candidates: Array<{ l: number; t: number }> = [
            { l: left, t: belowTop },
            { l: left, t: aboveTop },
            { l: left, t: anchorRect.y + anchorRect.h + 6 },
            { l: left, t: anchorRect.y - barH - 6 },
            { l: anchorRect.x + anchorRect.w + 10, t: anchorRect.y },
            { l: anchorRect.x - barW - 10, t: anchorRect.y },
            { l: left, t: minVisTop },
            { l: left, t: maxVisTop }
          ];
          let bestScore = Infinity;
          for (const c of candidates) {
            const cl = Math.max(minLeft, Math.min(maxLeft, c.l));
            const ct = Math.max(minVisTop, Math.min(maxVisTop, c.t));
            const s = scorePlacement(cl, ct);
            if (s < bestScore) {
              bestScore = s;
              chosenLeft = cl;
              chosenTop = ct;
            }
          }
        }

        const next = { left: Math.round(chosenLeft), top: Math.round(chosenTop) };
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
      hasFloatingBarContent,
      floatingBarConfig,
      layout.bands,
      layout.width,
      layout.height,
      stageW,
      stageH,
      canvasScale
    ]);

    const activeTab = useMemo(
      () => tabs.find((t) => t.id === activeTabId) ?? null,
      [tabs, activeTabId]
    );
    const showBlankQuickStart = Boolean(
      activeTab?.isBlankPlaceholder && !dismissedBlankTabIds.has(activeTab.id)
    );

    const handleStagePointerDownCapture = (e: React.PointerEvent<HTMLElement>) => {
      if (!spacePanRef.current.held) return;
      if ((e.target as HTMLElement | null)?.closest('.modal-backdrop')) return;
      if (e.button !== 0) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const stageEl = stageRef.current;
      if (!stageEl) return;

      e.preventDefault();
      e.stopPropagation();
      setCtxMenu(null);
      if (inlineTargetRef.current) closeInlineRef.current(true);

      spacePanDragCleanupRef.current?.();

      const pan = spacePanRef.current;
      pan.dragging = true;
      pan.didDrag = true;
      suppressNextStageClickRef.current = true;
      stageEl.classList.add('space-pan-dragging');

      const pointerId = e.pointerId;
      try {
        stageEl.setPointerCapture(pointerId);
      } catch {
        // ignore if pointer capture is unsupported
      }

      const startClientX = e.clientX;
      const startClientY = e.clientY;
      const startScrollLeft = stageEl.scrollLeft;
      const startScrollTop = stageEl.scrollTop;
      const prevBodyCursor = document.body.style.cursor;
      document.body.style.cursor = 'grabbing';

      let active = true;

      const onMove = (ev: PointerEvent) => {
        if (!active) return;
        const z = getElementRectScale(stageEl);
        stageEl.scrollLeft = startScrollLeft - (ev.clientX - startClientX) / z;
        stageEl.scrollTop = startScrollTop - (ev.clientY - startClientY) / z;
      };

      const stopDrag = () => {
        if (!active) return;
        active = false;
        pan.dragging = false;
        stageEl.classList.remove('space-pan-dragging');
        document.body.style.cursor = prevBodyCursor;
        try {
          if (stageEl.hasPointerCapture(pointerId)) {
            stageEl.releasePointerCapture(pointerId);
          }
        } catch {
          // ignore
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', stopDrag);
        window.removeEventListener('pointercancel', stopDrag);
        spacePanDragCleanupRef.current = null;
        window.setTimeout(() => {
          suppressNextStageClickRef.current = false;
        }, 0);
      };

      spacePanDragCleanupRef.current = stopDrag;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stopDrag);
      window.addEventListener('pointercancel', stopDrag);
    };

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
                <kbd>{getEffectiveShortcutHint('shortcuts-modal', customShortcuts) || '?'}</kbd> 查看快捷键
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
          onPointerDownCapture={handleStagePointerDownCapture}
          onClickCapture={(e) => {
            if (spacePanRef.current.held || suppressNextStageClickRef.current) {
              e.preventDefault();
              e.stopPropagation();
              suppressNextStageClickRef.current = false;
            }
          }}
          onClick={(e) => {
            if (e.target === stageRef.current) {
              setCtxMenu(null);
              if (inlineTarget) closeInline(true);
              setSelection(null);
              setPlayRange(null);
            }
          }}
        >
          <div
            ref={sheetRef}
            id="sheet"
            className="sheet"
            style={
              Math.abs(canvasScale / (uiScale || 1) - 1) < 0.001
                ? undefined
                : { zoom: Number((canvasScale / (uiScale || 1)).toFixed(4)) }
            }
          >
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
                    ipaIme.onBlur();
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

            {/* High-Contrast Dark Customizable Floating Contextual Bar */}
            {selection && anchorRect && anchorBand && floatingBarContent && (
              <div
                ref={floatingBarRef}
                className={`floating-bar ${floatingPos ? 'visible' : ''}`}
                style={
                  floatingPos
                    ? { left: floatingPos.left, top: floatingPos.top }
                    : { left: 6, top: Math.round(anchorBand.tiersBottomY + 8) }
                }
              >
                {floatingBarContent}
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

          {/* Right-Click Context Menu (Standard Desktop Cascading Submenus) */}
          {ctxMenu && (
            <div className="context-menu open" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
              {ctxMenu.items.map((item, idx) =>
                item.divider ? (
                  <div key={`div-${idx}`} className="menu-divider" />
                ) : item.children && item.children.length > 0 ? (
                  <div
                    key={`${item.label}-${idx}`}
                    className="ctx-submenu-wrap"
                    onMouseEnter={() => {
                      cancelSubmenuClose();
                      if (!item.disabled) setOpenSubmenuIdx(idx);
                    }}
                    onMouseLeave={scheduleSubmenuClose}
                  >
                    <button
                      type="button"
                      className={`ctx-submenu-trigger${openSubmenuIdx === idx ? ' is-open' : ''}`}
                      disabled={item.disabled}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        cancelSubmenuClose();
                        if (!item.disabled) {
                          setOpenSubmenuIdx((prev) => (prev === idx ? null : idx));
                        }
                      }}
                    >
                      <span className="ctx-item-main">
                        <span className="ctx-item-icon" aria-hidden="true">
                          {item.icon ? <UiIcon name={item.icon} size={14} /> : null}
                        </span>
                        <span>{item.label}</span>
                      </span>
                      <span className="ctx-submenu-arrow">
                        <SubmenuChevronIcon size={12} />
                      </span>
                    </button>
                    {openSubmenuIdx === idx && !item.disabled && (
                      <CtxSubmenuPanel
                        items={item.children}
                        openLeft={ctxMenu.x + 410 > getLogicalViewportSize().width}
                        onMouseEnter={cancelSubmenuClose}
                        onSelectItem={(child) => {
                          cancelSubmenuClose();
                          setCtxMenu(null);
                          child.action?.();
                        }}
                      />
                    )}
                  </div>
                ) : (
                  <button
                    key={`${item.label}-${idx}`}
                    type="button"
                    className={item.danger ? 'danger' : ''}
                    disabled={item.disabled}
                    onMouseEnter={() => {
                      if (openSubmenuIdx !== null && submenuCloseTimerRef.current === null) {
                        scheduleSubmenuClose();
                      }
                    }}
                    onClick={() => {
                      cancelSubmenuClose();
                      setCtxMenu(null);
                      item.action?.();
                    }}
                  >
                    <span className="ctx-item-main">
                      <span className="ctx-item-icon" aria-hidden="true">
                        {item.icon ? <UiIcon name={item.icon} size={14} /> : null}
                      </span>
                      <span>{item.label}</span>
                    </span>
                    {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
                  </button>
                )
              )}
            </div>
          )}
          {/* Custom Architectural Equal-Split Slider Modal */}
          <SplitEqualModal
            state={splitEqualDialog}
            onCancel={() => setSplitEqualDialog(null)}
            onConfirm={(n) => {
              const dlg = splitEqualDialog;
              setSplitEqualDialog(null);
              if (dlg) {
                splitIntervalEqualN(dlg.tierIndex, dlg.itemIndex, n);
              }
            }}
          />
        </main>
      </div>
    );
  }
);
