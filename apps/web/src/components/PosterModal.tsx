import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPlatformBridge, isTauriRuntime } from '../bridge/PlatformBridge';
import { formatByteSize } from '../render/exporter';
import {
  copyPosterPngToClipboard,
  exportPosterPng,
  exportPosterSvg,
  getDefaultPosterTierSelection,
  loadPosterPrefs,
  printPosterPdf,
  renderPosterPreview,
  resolvePosterTimeRange,
  savePosterPrefs
} from '../render/poster/posterExporter';
import { resolvePosterText } from '../render/poster/polarSolver';
import {
  POSTER_TEMPLATE_ORDER,
  POSTER_TEMPLATE_REGISTRY,
  type PosterConfig,
  type PosterCopyOverrides,
  type PosterPngScale,
  type PosterPrefs,
  type PosterRenderInput,
  type PosterResult,
  type PosterTemplateId
} from '../render/poster/types';
import { useEditorStore } from '../store/useEditorStore';
import { getElementRectScale } from '../utils/uiScale';
import { ChevronIcon, CloseIcon, UiIcon } from './Icons';
import '../styles/posterModal.css';

interface PosterModalProps {
  audioBuffer: AudioBuffer | null;
}

const VinylGlyph: React.FC = () => (
  <svg width="28" height="34" viewBox="0 0 28 34" aria-hidden="true">
    <line x1="3.5" y1="5" x2="15" y2="5" stroke="currentColor" strokeWidth="1.6" />
    <line x1="3.5" y1="8.2" x2="11" y2="8.2" stroke="currentColor" strokeWidth="1.1" opacity="0.52" />
    <circle cx="14" cy="21" r="10.2" fill="none" stroke="currentColor" strokeWidth="0.75" opacity="0.38" />
    <circle cx="14" cy="21" r="7.4" fill="none" stroke="currentColor" strokeWidth="1.15" opacity="0.82" />
    <circle cx="14" cy="21" r="4.3" fill="currentColor" opacity="0.92" />
    <circle cx="14" cy="21" r="1.8" fill="#D64028" />
    <circle cx="14" cy="21" r="0.65" fill="#FAF7F1" />
    <line x1="18.8" y1="9.6" x2="15.7" y2="16.4" stroke="currentColor" strokeWidth="0.95" />
    <circle cx="18.8" cy="9.6" r="1.35" fill="currentColor" />
  </svg>
);

const BauhausGlyph: React.FC = () => (
  <svg width="28" height="34" viewBox="0 0 28 34" aria-hidden="true">
    <rect x="3.5" y="4" width="6.5" height="1.6" fill="#D93829" />
    <rect x="11" y="4" width="3.5" height="1.6" fill="#EAB308" />
    <rect x="15.4" y="4" width="2.2" height="1.6" fill="#1B4F9C" />
    <line x1="3.5" y1="8.2" x2="14.5" y2="8.2" stroke="currentColor" strokeWidth="1.6" />
    <path d="M 5.6 24.4 A 9.6 9.6 0 1 1 22.8 23.6" fill="none" stroke="currentColor" strokeWidth="1.25" />
    <path d="M 8.2 23.4 A 6.8 6.8 0 1 1 20.4 22.8" fill="none" stroke="currentColor" strokeWidth="0.9" opacity="0.55" />
    <line x1="4" y1="29.5" x2="18.5" y2="17.5" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="14.5" cy="20.8" r="2.1" fill="none" stroke="#1B4F9C" strokeWidth="0.95" />
    <circle cx="14.5" cy="20.8" r="0.9" fill="currentColor" />
  </svg>
);

const BraunStripGlyph: React.FC = () => (
  <svg width="28" height="34" viewBox="0 0 28 34" aria-hidden="true">
    <circle cx="8.5" cy="8.2" r="3.8" fill="#FAF9F5" stroke="currentColor" strokeWidth="0.95" />
    <line x1="8.5" y1="8.2" x2="10.8" y2="5.7" stroke="#E84A27" strokeWidth="1.0" strokeLinecap="round" />
    <circle cx="17.5" cy="8.2" r="3.8" fill="#FAF9F5" stroke="currentColor" strokeWidth="0.95" />
    <line x1="17.5" y1="8.2" x2="18.9" y2="5.4" stroke="#E84A27" strokeWidth="1.0" strokeLinecap="round" />
    <circle cx="23.8" cy="6.2" r="1.15" fill="#E84A27" />
    <rect x="3" y="14" width="22" height="1.6" rx="0.5" fill="currentColor" opacity="0.88" />
    <rect x="4.5" y="15.2" width="19" height="15.2" fill="#FFFFFF" stroke="currentColor" strokeWidth="0.65" opacity="0.94" />
    <rect x="7" y="17.4" width="14" height="3.2" fill="currentColor" opacity="0.22" />
    <line x1="7" y1="23.2" x2="21" y2="23.2" stroke="currentColor" strokeWidth="0.6" opacity="0.55" />
    <line x1="7" y1="26.2" x2="21" y2="26.2" stroke="currentColor" strokeWidth="0.6" opacity="0.4" />
    <line x1="7" y1="28.8" x2="17" y2="28.8" stroke="#E84A27" strokeWidth="0.8" opacity="0.8" />
  </svg>
);

const FoldingFanGlyph: React.FC = () => (
  <svg width="28" height="34" viewBox="0 0 28 34" aria-hidden="true">
    <line x1="3.5" y1="5.4" x2="11.5" y2="5.4" stroke="currentColor" strokeWidth="1.45" />
    <rect x="13" y="3.8" width="2.3" height="3.2" rx="0.4" fill="#B63B2A" />
    <path d="M 4.4 18.2 A 13.4 13.4 0 0 1 25.0 27.6" fill="none" stroke="#2D666B" strokeWidth="1.5" />
    <path d="M 6.8 20.0 A 10.2 10.2 0 0 1 22.0 27.4" fill="none" stroke="currentColor" strokeWidth="0.7" opacity="0.52" />
    <path d="M 9.0 22.0 A 7.2 7.2 0 0 1 19.0 27.2" fill="none" stroke="#2D666B" strokeWidth="1.35" opacity="0.65" />
    <line x1="11.8" y1="27.2" x2="4.6" y2="18.4" stroke="#8C7353" strokeWidth="1.0" />
    <line x1="11.8" y1="27.2" x2="24.8" y2="27.6" stroke="#8C7353" strokeWidth="1.0" />
    <line x1="11.8" y1="27.2" x2="13.8" y2="14.6" stroke="#8C7353" strokeWidth="0.65" opacity="0.65" />
    <line x1="11.8" y1="27.2" x2="19.6" y2="18.2" stroke="#8C7353" strokeWidth="0.65" opacity="0.65" />
    <circle cx="11.8" cy="27.2" r="1.4" fill="#7B6242" />
    <circle cx="16.4" cy="13.4" r="0.95" fill="#B63B2A" />
  </svg>
);

const RisographGlyph: React.FC = () => (
  <svg width="28" height="34" viewBox="0 0 28 34" aria-hidden="true">
    <line x1="4.4" y1="5.4" x2="16.4" y2="5.4" stroke="#FFD026" strokeWidth="1.7" />
    <line x1="3.6" y1="4.8" x2="15.6" y2="4.8" stroke="#FF5277" strokeWidth="1.5" />
    <rect x="3.5" y="8.4" width="21" height="5.2" rx="0.8" fill="#00A5C8" opacity="0.28" />
    <line x1="4.5" y1="10.8" x2="23.5" y2="10.8" stroke="#FF5277" strokeWidth="1.0" opacity="0.85" />
    <path d="M 6.5 14 L 5.2 20 L 10.6 20 L 9.8 14 Z" fill="#FF5277" opacity="0.45" />
    <path d="M 11.8 14 L 11.4 21.5 L 16.8 21.5 L 16.2 14 Z" fill="#FFD026" opacity="0.62" />
    <path d="M 18.2 14 L 17.6 19.6 L 23.0 19.6 L 21.5 14 Z" fill="#00A5C8" opacity="0.45" />
    <rect x="4.5" y="19.8" width="6.0" height="5.6" rx="1.0" fill="#FF5277" />
    <rect x="11.2" y="21.4" width="5.8" height="5.6" rx="1.0" fill="#FFD026" />
    <rect x="17.8" y="19.4" width="5.8" height="5.6" rx="1.0" fill="#00A5C8" />
    <circle cx="6.2" cy="30.2" r="1.2" fill="#FF5277" />
    <circle cx="8.6" cy="30.2" r="1.2" fill="#FFD026" />
    <circle cx="11.0" cy="30.2" r="1.2" fill="#00A5C8" />
  </svg>
);

const TEMPLATE_GLYPHS: Record<PosterTemplateId, React.FC> = {
  vinyl: VinylGlyph,
  bauhaus: BauhausGlyph,
  braun_strip: BraunStripGlyph,
  folding_fan: FoldingFanGlyph,
  risograph: RisographGlyph
};

export const PosterModal: React.FC<PosterModalProps> = ({ audioBuffer }) => {
  const open = useEditorStore((s) => s.posterOpen);
  const setOpen = useEditorStore((s) => s.setPosterOpen);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const collectionActiveIdx = useEditorStore((s) => s.collectionActiveIdx);
  const tg = useEditorStore((s) => s.tg);
  const filename = useEditorStore((s) => s.filename);
  const viewDomain = useEditorStore((s) => s.viewDomain);
  const playRange = useEditorStore((s) => s.playRange);
  const selection = useEditorStore((s) => s.selection);
  const audioName = useEditorStore((s) => s.audioName);
  const audioOffset = useEditorStore((s) => s.audioOffset);
  const audioSampleRate = useEditorStore((s) => s.audioSampleRate);
  const analysis = useEditorStore((s) => s.analysis);
  const maxFreq = useEditorStore((s) => s.maxFreq);
  const showToast = useEditorStore((s) => s.showToast);

  const [prefs, setPrefs] = useState<PosterPrefs>(() => loadPosterPrefs());
  const [orderedIntervalTiers, setOrderedIntervalTiers] = useState<number[]>([]);
  const [enabledIntervalTiers, setEnabledIntervalTiers] = useState<number[]>([]);
  const [pointTierIndex, setPointTierIndex] = useState<number | null>(null);
  const [pointMenuOpen, setPointMenuOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const pointMenuRef = useRef<HTMLDivElement>(null);
  const modalCardRef = useRef<HTMLDivElement>(null);
  const [copyOverrides, setCopyOverrides] = useState<PosterCopyOverrides>({
    title: '',
    subtitle: '',
    footer: '',
    pointNotes: {}
  });

  const [previewRes, setPreviewRes] = useState<PosterResult | null>(null);
  const [rendering, setRendering] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Interactive cursor-anchored wheel-zoom & drag-to-pan preview state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [baseSize, setBaseSize] = useState({ w: 300, h: 400 });
  const stageRef = useRef<HTMLDivElement>(null);
  const backdropPointerDownRef = useRef(false);
  const lastDocKeyRef = useRef<string>('');
  const lastPreviewContextKeyRef = useRef<string>('');

  const hasAudio = Boolean(audioName && (audioBuffer || analysis));
  const hasSelectionRange = Boolean(
    (playRange && playRange.end > playRange.start + 1e-5) ||
      (selection?.kind === 'interval' &&
        (tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex]?.xmax ?? 0) >
          (tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex]?.xmin ?? 0) + 1e-5)
  );

  const allIntervalTierIndices = useMemo(
    () => tg.tiers.map((t, idx) => (t.kind === 'intervalTier' ? idx : -1)).filter((i) => i >= 0),
    [tg.tiers]
  );
  const allPointTierIndices = useMemo(
    () => tg.tiers.map((t, idx) => (t.kind === 'textTier' ? idx : -1)).filter((i) => i >= 0),
    [tg.tiers]
  );

  const updatePrefs = useCallback((patch: Partial<PosterPrefs>) => {
    setPrefs((prev) => {
      const next: PosterPrefs = { ...prev, ...patch };
      savePosterPrefs(next);
      return next;
    });
  }, []);

  // Re-initialize tier mapping & range fallback when modal opens or active document changes
  useEffect(() => {
    if (!open) {
      setPreviewRes(null);
      return;
    }
    const docKey = `${activeTabId}|${collectionActiveIdx}|${filename}|${tg.tiers.map((t) => `${t.kind}:${t.name}`).join(',')}|${tg.xmin}|${tg.xmax}`;
    const previewContextKey = `${docKey}|${audioName}|${analysis?.sessionId ?? ''}|${audioBuffer ? 1 : 0}`;
    if (previewContextKey !== lastPreviewContextKeyRef.current) {
      lastPreviewContextKeyRef.current = previewContextKey;
      setPreviewRes(null);
    }
    if (docKey !== lastDocKeyRef.current) {
      lastDocKeyRef.current = docKey;
      const defaults = getDefaultPosterTierSelection(tg);
      setOrderedIntervalTiers(allIntervalTierIndices);
      setEnabledIntervalTiers(defaults.intervalTierIndices);
      setPointTierIndex(defaults.pointTierIndex);
      setCopyOverrides({ title: '', subtitle: '', footer: '', pointNotes: {} });
    } else {
      // Sanitize existing tier indices if tiers were edited
      setOrderedIntervalTiers((prev) => {
        const kept = prev.filter((i) => allIntervalTierIndices.includes(i));
        const missing = allIntervalTierIndices.filter((i) => !kept.includes(i));
        return [...kept, ...missing];
      });
      setEnabledIntervalTiers((prev) => prev.filter((i) => allIntervalTierIndices.includes(i)));
      setPointTierIndex((prev) =>
        prev !== null && allPointTierIndices.includes(prev) ? prev : null
      );
    }

    setPrefs((prev) => {
      let nextRange = prev.rangeMode;
      if (nextRange === 'view' && !viewDomain) nextRange = 'all';
      if (nextRange === 'selection' && !hasSelectionRange) nextRange = 'all';
      if (nextRange === prev.rangeMode) return prev;
      const next: PosterPrefs = { ...prev, rangeMode: nextRange };
      savePosterPrefs(next);
      return next;
    });
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [
    open,
    activeTabId,
    collectionActiveIdx,
    filename,
    audioName,
    analysis?.sessionId,
    audioBuffer,
    tg,
    allIntervalTierIndices,
    allPointTierIndices,
    viewDomain,
    hasSelectionRange
  ]);

  // Focus modal container on open so keyboard focus stays inside dialog
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      modalCardRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const activeIntervalTierIndices = useMemo(
    () => orderedIntervalTiers.filter((idx) => enabledIntervalTiers.includes(idx)).slice(0, 6),
    [orderedIntervalTiers, enabledIntervalTiers]
  );

  const activeRange = useMemo(
    () => resolvePosterTimeRange(tg, prefs.rangeMode, viewDomain, playRange, selection),
    [tg, prefs.rangeMode, viewDomain, playRange, selection]
  );

  const activePointsForNotes = useMemo(() => {
    if (pointTierIndex === null) return [];
    const tier = tg.tiers[pointTierIndex];
    if (!tier || tier.kind !== 'textTier') return [];
    return tier.points
      .filter((pt) => pt.number >= activeRange.tMin - 1e-7 && pt.number <= activeRange.tMax + 1e-7)
      .sort((a, b) => a.number - b.number)
      .slice(0, 30);
  }, [tg.tiers, pointTierIndex, activeRange.tMin, activeRange.tMax]);

  const buildInput = useCallback(
    (previewMode: boolean): PosterRenderInput => {
      const config: PosterConfig = {
        ...prefs,
        intervalTierIndices: activeIntervalTierIndices,
        pointTierIndex,
        copy: copyOverrides
      };
      return {
        bridge: getPlatformBridge(),
        tg,
        filename,
        config,
        previewMode,
        viewDomain,
        playRange,
        selection,
        hasAudio,
        audioBuffer,
        audioOffset,
        audioSampleRate: audioSampleRate || analysis?.sampleRate || 0,
        analysis,
        maxFreq
      };
    },
    [
      prefs,
      activeIntervalTierIndices,
      pointTierIndex,
      copyOverrides,
      tg,
      filename,
      viewDomain,
      playRange,
      selection,
      hasAudio,
      audioBuffer,
      audioOffset,
      audioSampleRate,
      analysis,
      maxFreq
    ]
  );

  const recomputeBaseFit = useCallback((wPt: number, hPt: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const availW = Math.max(120, stage.clientWidth - 36);
    const availH = Math.max(120, stage.clientHeight - 36);
    const ratio = Math.min(availW / Math.max(1, wPt), availH / Math.max(1, hPt), 1);
    setBaseSize({
      w: Math.max(60, Math.round(wPt * ratio)),
      h: Math.max(60, Math.round(hPt * ratio))
    });
  }, []);

  // Close point-tier custom dropdown on outside pointerdown, Escape key, or modal close
  useEffect(() => {
    if (!open) {
      setPointMenuOpen(false);
      return;
    }
    if (!pointMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (pointMenuRef.current && !pointMenuRef.current.contains(e.target as Node)) {
        setPointMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setPointMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, pointMenuOpen]);

  // Re-fit preview when container resizes
  useEffect(() => {
    const stage = stageRef.current;
    if (!open || !stage || !previewRes) return;
    const ro = new ResizeObserver(() => {
      recomputeBaseFit(previewRes.widthPt, previewRes.heightPt);
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, [open, previewRes?.widthPt, previewRes?.heightPt, recomputeBaseFit]);

  // Debounced live SVG proofing render
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRendering(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await renderPosterPreview(buildInput(true));
        if (cancelled) return;
        setPreviewRes(res);
        recomputeBaseFit(res.widthPt, res.heightPt);
      } catch (err) {
        if (!cancelled) {
          showToast(`海报预览生成失败：${String(err)}`, true);
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    }, 95);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, buildInput, recomputeBaseFit, showToast]);

  const zoomAt = useCallback((targetZoom: number, clientX?: number, clientY?: number) => {
    setZoom((prevZoom) => {
      const clamped = Math.max(0.5, Math.min(8, Number(targetZoom.toFixed(3))));
      if (Math.abs(clamped - prevZoom) < 1e-4) return prevZoom;
      const stage = stageRef.current;
      if (clamped <= 1.001) {
        setPan({ x: 0, y: 0 });
      } else if (stage && clientX !== undefined && clientY !== undefined) {
        const z = getElementRectScale(stage);
        const rect = stage.getBoundingClientRect();
        const cx = (clientX - (rect.left + rect.width / 2)) / z;
        const cy = (clientY - (rect.top + rect.height / 2)) / z;
        const ratio = clamped / prevZoom;
        setPan((p) => ({
          x: cx - (cx - p.x) * ratio,
          y: cy - (cy - p.y) * ratio
        }));
      }
      return clamped;
    });
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!open || !stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = Math.max(-180, Math.min(180, e.deltaY));
      const factor = Math.exp(-delta * 0.0022);
      zoomAt(zoom * factor, e.clientX, e.clientY);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [open, zoom, zoomAt]);

  const previewHtml = useMemo(() => {
    if (!previewRes?.svgMarkup) return null;
    const stripped = previewRes.svgMarkup.replace(/^<\?xml[^>]*\?>\s*/i, '');
    return {
      __html: stripped.replace(/<svg\b/, '<svg style="width:100%;height:100%;display:block;"')
    };
  }, [previewRes?.svgMarkup]);

  const handleStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    backdropPointerDownRef.current = false;
    setDragging(true);
    const stageEl = stageRef.current;
    const pointerId = e.pointerId;
    try {
      stageEl?.setPointerCapture(pointerId);
    } catch {
      // ignore
    }
    const startX = e.clientX;
    const startY = e.clientY;
    const origPan = { ...pan };
    const onMove = (ev: PointerEvent) => {
      const z = getElementRectScale(stageEl);
      setPan({ x: origPan.x + (ev.clientX - startX) / z, y: origPan.y + (ev.clientY - startY) / z });
    };
    const cleanup = () => {
      setDragging(false);
      backdropPointerDownRef.current = false;
      try {
        if (stageEl?.hasPointerCapture(pointerId)) {
          stageEl.releasePointerCapture(pointerId);
        }
      } catch {
        // ignore
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  };

  const makeRevealAction = useCallback((savedPath: string) => {
    return {
      label: '打开所在文件夹',
      onClick: () => {
        void getPlatformBridge()
          .revealInExplorer(savedPath)
          .catch(() => {
            useEditorStore.getState().showToast('无法打开所在文件夹', true);
          });
      }
    };
  }, []);

  const handleExportSvg = async () => {
    if (busyAction) return;
    setBusyAction('svg');
    try {
      const res = await exportPosterSvg(buildInput(false));
      if (isTauriRuntime()) {
        if (res.savedPath) {
          showToast(`已导出矢量海报 (${res.filename})`, false, makeRevealAction(res.savedPath));
        }
      } else {
        showToast(`已下载矢量海报 (${res.filename})`);
      }
    } catch (err) {
      showToast(`导出 SVG 失败：${String(err)}`, true);
    } finally {
      setBusyAction(null);
    }
  };

  const handleExportPng = async () => {
    if (busyAction) return;
    setBusyAction('png');
    try {
      const res = await exportPosterPng(buildInput(false));
      const suffix = res.scaleCapped ? ` · 自动降倍 ${res.effectiveScale}×` : '';
      const msg = `已导出声纹海报 (${res.width}×${res.height}${suffix})`;
      if (isTauriRuntime()) {
        if (res.savedPath) {
          showToast(msg, false, makeRevealAction(res.savedPath));
        }
      } else {
        showToast(msg);
      }
    } catch (err) {
      showToast(`导出 PNG 失败：${String(err)}`, true);
    } finally {
      setBusyAction(null);
    }
  };

  const handleCopyPng = async () => {
    if (busyAction) return;
    setBusyAction('copy');
    try {
      const res = await copyPosterPngToClipboard(buildInput(false));
      showToast(`已复制海报 PNG (${res.width}×${res.height}) 到剪贴板`);
    } catch (err) {
      showToast(`复制 PNG 失败：${String(err)}`, true);
    } finally {
      setBusyAction(null);
    }
  };

  const handlePrintPdf = async () => {
    if (busyAction) return;
    setBusyAction('pdf');
    try {
      await printPosterPdf(buildInput(false));
    } catch (err) {
      showToast(`调用打印失败：${String(err)}`, true);
    } finally {
      setBusyAction(null);
    }
  };

  const toggleIntervalTier = (tierIdx: number) => {
    setEnabledIntervalTiers((prev) => {
      if (prev.includes(tierIdx)) {
        return prev.filter((i) => i !== tierIdx);
      }
      if (prev.length >= 6) {
        showToast('海报版式最多同时映射 6 个区间层');
        return prev;
      }
      return [...prev, tierIdx];
    });
  };

  const moveOrderedTier = (pos: number, delta: -1 | 1) => {
    const nextPos = pos + delta;
    if (nextPos < 0 || nextPos >= orderedIntervalTiers.length) return;
    setOrderedIntervalTiers((prev) => {
      const arr = [...prev];
      const tmp = arr[pos];
      arr[pos] = arr[nextPos];
      arr[nextPos] = tmp;
      return arr;
    });
  };

  if (!open) return null;

  const outW = previewRes ? Math.round(previewRes.widthPt * prefs.pngScale) : 0;
  const outH = previewRes ? Math.round(previewRes.heightPt * prefs.pngScale) : 0;
  const wMm = outW > 0 ? Math.round((outW / 300) * 25.4) : 0;
  const hMm = outH > 0 ? Math.round((outH / 300) * 25.4) : 0;
  const ratioLabel = prefs.framing === 'emblem_1_1' ? '1:1' : '3:4';
  const specSummary = previewRes
    ? `${outW} × ${outH} px · 300 DPI · ${wMm} × ${hMm} mm · ${ratioLabel}${prefs.includeBleed ? ' (+3mm)' : ''}`
    : '正在生成声纹海报预览…';

  const isLongDuration = activeRange.duration > 10.0;
  const isEmblem = prefs.framing === 'emblem_1_1';
  const activeTemplateMeta = POSTER_TEMPLATE_REGISTRY[prefs.template];
  const isLinearTemplate = activeTemplateMeta.layoutKind === 'linear';
  const autoTitleDisplay = copyOverrides.title.trim() || previewRes?.autoCopy.title || '自动提取标题';
  const customNoteCount = Object.values(copyOverrides.pointNotes).filter((v) => v.trim() !== '').length;
  const customCopyCount =
    (copyOverrides.title.trim() ? 1 : 0) +
    (copyOverrides.subtitle.trim() ? 1 : 0) +
    (copyOverrides.footer.trim() ? 1 : 0) +
    customNoteCount;

  return (
    <div
      className="modal-backdrop open"
      role="dialog"
      aria-modal="true"
      aria-labelledby="poster-modal-title"
      onPointerDown={(e) => {
        backdropPointerDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (backdropPointerDownRef.current && e.target === e.currentTarget) {
          setOpen(false);
        }
        backdropPointerDownRef.current = false;
      }}
    >
      <div ref={modalCardRef} tabIndex={-1} className="modal-card poster-modal-card">
        <div className="modal-head">
          <span id="poster-modal-title" className="modal-title">
            <UiIcon name="export" size={14} />
            <span>导出声纹海报</span>
          </span>
          <button
            type="button"
            className="icon-btn compact"
            title="关闭 (Esc)"
            onClick={() => setOpen(false)}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="poster-split">
          {/* Left: Live Interactive Proofing Stage */}
          <div className="poster-preview-pane">
            <div
              ref={stageRef}
              className={`export-preview-stage poster-preview-stage ${dragging ? 'dragging' : ''}`}
              title="滚轮缩放 · 拖拽平移 · 双击复原"
              onPointerDown={handleStagePointerDown}
              onDoubleClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
            >
              {previewHtml ? (
                <div
                  className={`export-preview-paper ${prefs.bgMode === 'transparent' ? 'checkerboard' : ''}`}
                  style={{
                    width: `${(baseSize.w * zoom).toFixed(2)}px`,
                    height: `${(baseSize.h * zoom).toFixed(2)}px`,
                    transform: `translate(calc(-50% + ${pan.x.toFixed(1)}px), calc(-50% + ${pan.y.toFixed(1)}px))`
                  }}
                  dangerouslySetInnerHTML={previewHtml}
                />
              ) : (
                <div className="poster-preview-loading" role="status" aria-live="polite">
                  <span className="poster-preview-loading-bar" aria-hidden="true" />
                  <span>正在生成声纹海报预览…</span>
                </div>
              )}
              <div className="export-preview-zoom-bar" role="group" aria-label="预览缩放">
                <button type="button" title="缩小" onClick={() => zoomAt(zoom / 1.25)}>
                  −
                </button>
                <button
                  type="button"
                  title="当前缩放比例"
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                  }}
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button type="button" title="放大" onClick={() => zoomAt(zoom * 1.25)}>
                  +
                </button>
                <button
                  type="button"
                  title="适应预览窗口"
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                  }}
                >
                  适应
                </button>
              </div>
            </div>
            <div className="poster-spec-bar">
              <span>{!previewRes ? '正在生成声纹海报预览…' : rendering ? '正在更新预览…' : specSummary}</span>
              <strong>{previewRes ? formatByteSize(previewRes.estimatedBytes) : ''}</strong>
            </div>
          </div>

          {/* Right: Structured Archival Control Pane */}
          <div className="poster-controls-pane">
            {/* 1. 版式模板 */}
            <div className="export-group">
              <div className="export-group-head">
                <span className="export-group-title">版式模板</span>
                <span className="poster-muted-note">{activeTemplateMeta.eraLabel}</span>
              </div>
              <div className="poster-template-grid" role="radiogroup" aria-label="海报版式模板">
                {POSTER_TEMPLATE_ORDER.map((tid) => {
                  const meta = POSTER_TEMPLATE_REGISTRY[tid];
                  const active = prefs.template === tid;
                  const Glyph = TEMPLATE_GLYPHS[tid];
                  return (
                    <button
                      key={tid}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      title={`${meta.nameZh} · ${meta.subtitleZh}`}
                      className={`poster-template-card ${active ? 'active' : ''}`}
                      onClick={() => updatePrefs({ template: tid })}
                    >
                      <span
                        className="poster-template-thumb"
                        style={active ? undefined : { background: meta.paperColor }}
                      >
                        <Glyph />
                      </span>
                      <span className="poster-template-name">{meta.nameZh}</span>
                    </button>
                  );
                })}
              </div>
              <div className="poster-template-caption">
                <span
                  className="poster-template-dot"
                  style={{ background: activeTemplateMeta.accentColor }}
                  aria-hidden="true"
                />
                <span className="poster-template-caption-text">
                  <strong>{activeTemplateMeta.nameZh}</strong> · {activeTemplateMeta.subtitleZh}
                </span>
              </div>
            </div>

            {/* 2. 载体构图与介质 */}
            <div className="export-group">
              <span className="export-group-title">载体构图与介质</span>
              <div className="export-sub-row">
                <span className="setting-label">构图比例</span>
                <div className="segmented" role="group">
                  <button
                    type="button"
                    className={`compact ${prefs.framing === 'poster_3_4' ? 'active' : ''}`}
                    onClick={() => updatePrefs({ framing: 'poster_3_4' })}
                  >
                    完整展陈海报 3:4
                  </button>
                  <button
                    type="button"
                    className={`compact ${prefs.framing === 'emblem_1_1' ? 'active' : ''}`}
                    onClick={() => updatePrefs({ framing: 'emblem_1_1' })}
                  >
                    纯声纹徽章 1:1
                  </button>
                </div>
              </div>
              <div className="export-sub-row">
                <span className="setting-label">底色介质</span>
                <div className="segmented" role="group">
                  <button
                    type="button"
                    className={`compact ${prefs.bgMode === 'paper' ? 'active' : ''}`}
                    onClick={() => updatePrefs({ bgMode: 'paper' })}
                  >
                    原生纸底
                  </button>
                  <button
                    type="button"
                    className={`compact ${prefs.bgMode === 'transparent' ? 'active' : ''}`}
                    onClick={() => updatePrefs({ bgMode: 'transparent' })}
                  >
                    透明背景
                  </button>
                </div>
              </div>
              <label className="export-check">
                <input
                  type="checkbox"
                  checked={prefs.includeBleed}
                  onChange={(e) => updatePrefs({ includeBleed: e.target.checked })}
                />
                <span>附带 3mm 印刷出血与裁切角线</span>
              </label>
            </div>

            {/* 3. 时间范围与层级映射 */}
            <div className="export-group">
              <div className="export-group-head">
                <span className="export-group-title">时间范围与层级映射</span>
                <span className="poster-muted-note">
                  {activeRange.tMin.toFixed(2)}–{activeRange.tMax.toFixed(2)}s ({activeRange.duration.toFixed(2)}s)
                </span>
              </div>

              <div className="export-sub-row">
                <span className="setting-label">时间范围</span>
                <div className="segmented" role="group">
                  <button
                    type="button"
                    className={`compact ${prefs.rangeMode === 'all' ? 'active' : ''}`}
                    onClick={() => updatePrefs({ rangeMode: 'all' })}
                  >
                    全段
                  </button>
                  <button
                    type="button"
                    className={`compact ${prefs.rangeMode === 'view' ? 'active' : ''}`}
                    disabled={!viewDomain}
                    onClick={() => updatePrefs({ rangeMode: 'view' })}
                  >
                    当前视口
                  </button>
                  <button
                    type="button"
                    className={`compact ${prefs.rangeMode === 'selection' ? 'active' : ''}`}
                    disabled={!hasSelectionRange}
                    onClick={() => updatePrefs({ rangeMode: 'selection' })}
                  >
                    当前选区
                  </button>
                </div>
              </div>

              {isLongDuration && (
                <div className="poster-density-notice" role="status">
                  <span>
                    当前时段超过 10 秒（{activeRange.duration.toFixed(1)}s），多层音标可能较密集。建议截取单句视口或选区。
                  </span>
                  {hasSelectionRange ? (
                    <button
                      type="button"
                      className="compact"
                      onClick={() => updatePrefs({ rangeMode: 'selection' })}
                    >
                      切至选区
                    </button>
                  ) : viewDomain ? (
                    <button
                      type="button"
                      className="compact"
                      onClick={() => updatePrefs({ rangeMode: 'view' })}
                    >
                      切至视口
                    </button>
                  ) : null}
                </div>
              )}

              <div className="poster-acoustic-row">
                <span className="setting-label">声学底图</span>
                <div className="poster-acoustic-checks">
                  <label className="export-check">
                    <input
                      type="checkbox"
                      disabled={!hasAudio}
                      checked={hasAudio && prefs.showSpectrogram}
                      onChange={(e) => updatePrefs({ showSpectrogram: e.target.checked })}
                    />
                    <span>频谱</span>
                  </label>
                  <label className="export-check">
                    <input
                      type="checkbox"
                      disabled={!hasAudio}
                      checked={hasAudio && prefs.showWaveform}
                      onChange={(e) => updatePrefs({ showWaveform: e.target.checked })}
                    />
                    <span>波形</span>
                  </label>
                  <label className="export-check">
                    <input
                      type="checkbox"
                      disabled={!hasAudio || !analysis?.pitchTrack?.length}
                      checked={Boolean(hasAudio && analysis?.pitchTrack?.length && prefs.showPitch)}
                      onChange={(e) => updatePrefs({ showPitch: e.target.checked })}
                    />
                    <span>基频</span>
                  </label>
                </div>
                {!hasAudio && <span className="poster-muted-note">无录音 · 纯几何底图</span>}
              </div>

              {orderedIntervalTiers.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div className="export-group-head">
                    <span className="setting-label">
                      区间标注层（{isLinearTemplate ? '自上而下' : '由内向外'}，最多 6 层）
                    </span>
                    <span className="poster-muted-note">已选 {activeIntervalTierIndices.length} 层</span>
                  </div>
                  <div className="poster-tier-list">
                    {orderedIntervalTiers.map((tierIdx, pos) => {
                      const tier = tg.tiers[tierIdx];
                      if (!tier) return null;
                      const activeOrder = activeIntervalTierIndices.indexOf(tierIdx);
                      const isChecked = activeOrder >= 0;
                      return (
                        <div
                          key={`iv-tier-${tierIdx}`}
                          className={`poster-tier-row ${isChecked ? '' : 'inactive'}`}
                        >
                          <div className="poster-tier-left">
                            <label className="export-check" style={{ minWidth: 0, flex: '1 1 auto' }}>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleIntervalTier(tierIdx)}
                              />
                              <span className="poster-ring-idx">
                                {isChecked ? String(activeOrder + 1).padStart(2, '0') : '—'}
                              </span>
                              <span className="poster-tier-name" title={tier.name || `层 ${tierIdx + 1}`}>
                                {tier.name || `层 ${tierIdx + 1}`}
                              </span>
                            </label>
                          </div>
                          <div className="poster-tier-actions">
                            <button
                              type="button"
                              className="compact"
                              title={isLinearTemplate ? '上移一层' : '向内环移动'}
                              disabled={pos === 0}
                              onClick={() => moveOrderedTier(pos, -1)}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="compact"
                              title={isLinearTemplate ? '下移一层' : '向外环移动'}
                              disabled={pos === orderedIntervalTiers.length - 1}
                              onClick={() => moveOrderedTier(pos, 1)}
                            >
                              ↓
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="export-sub-row">
                <span className="setting-label">标点标注层</span>
                <div
                  ref={pointMenuRef}
                  className={`menu-wrap poster-point-menu ${pointMenuOpen ? 'open' : ''}`}
                >
                  <button
                    type="button"
                    className="select-trigger compact poster-select-trigger"
                    disabled={allPointTierIndices.length === 0}
                    aria-haspopup="listbox"
                    aria-expanded={pointMenuOpen}
                    onClick={() => setPointMenuOpen((v) => !v)}
                  >
                    <span className="poster-select-label">
                      {allPointTierIndices.length === 0
                        ? '当前文档无标点层'
                        : pointTierIndex === null
                          ? '不显示标点层'
                          : `${pointTierIndex + 1}. ${tg.tiers[pointTierIndex]?.name || `标点层 ${pointTierIndex + 1}`} (${tg.tiers[pointTierIndex]?.points.length ?? 0})`}
                    </span>
                    <ChevronIcon />
                  </button>
                  <div className="dropdown poster-select-dropdown" role="listbox">
                    <button
                      type="button"
                      role="option"
                      aria-selected={pointTierIndex === null}
                      className={pointTierIndex === null ? 'selected' : ''}
                      onClick={() => {
                        setPointTierIndex(null);
                        setPointMenuOpen(false);
                      }}
                    >
                      <span>不显示标点层</span>
                    </button>
                    {allPointTierIndices.length > 0 && <div className="menu-divider" />}
                    {allPointTierIndices.map((ti) => {
                      const t = tg.tiers[ti];
                      const selected = pointTierIndex === ti;
                      return (
                        <button
                          key={`pt-opt-${ti}`}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={selected ? 'selected' : ''}
                          onClick={() => {
                            setPointTierIndex(ti);
                            setPointMenuOpen(false);
                          }}
                        >
                          <span className="poster-select-opt-main">
                            <span>
                              {ti + 1}. {t?.name || `标点层 ${ti + 1}`}
                            </span>
                            <span className="poster-select-opt-cnt">{t?.points.length ?? 0}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* 4. 文案与题注 */}
            <div className="export-group" style={{ borderBottom: 'none', paddingBottom: 0 }}>
              <div className="export-group-head">
                <span className="export-group-title">文案与题注</span>
                {!isEmblem && (
                  <label className="export-check">
                    <input
                      type="checkbox"
                      checked={prefs.pureVisual}
                      onChange={(e) => updatePrefs({ pureVisual: e.target.checked })}
                    />
                    <span>纯视觉模式</span>
                  </label>
                )}
              </div>

              {isEmblem ? (
                <div className="poster-copy-empty-note">
                  1:1 徽章模式自动隐藏页眉与底部目录，仅保留核心声纹图形与标注。
                </div>
              ) : (
                <div className={`poster-copy-card ${copyOpen ? 'open' : ''}`}>
                  <div className="poster-copy-head">
                    <button
                      type="button"
                      className="poster-copy-trigger"
                      aria-expanded={copyOpen}
                      onClick={() => setCopyOpen((v) => !v)}
                    >
                      <span className="poster-copy-chev" aria-hidden="true">
                        {copyOpen ? '▾' : '▸'}
                      </span>
                      <span className="poster-copy-trigger-label">标题、副题与标点释义</span>
                      <span className={`poster-copy-status ${customCopyCount > 0 ? 'modified' : ''}`}>
                        {prefs.pureVisual
                          ? '已隐藏'
                          : customCopyCount > 0
                            ? `已自定义 ${customCopyCount} 项`
                            : '自动生成'}
                      </span>
                    </button>
                    {customCopyCount > 0 && (
                      <button
                        type="button"
                        className="poster-copy-reset"
                        title="清空自定义内容，恢复自动生成文案"
                        onClick={() =>
                          setCopyOverrides({ title: '', subtitle: '', footer: '', pointNotes: {} })
                        }
                      >
                        恢复默认
                      </button>
                    )}
                  </div>

                  {!copyOpen && (
                    <div className="poster-copy-summary">
                      <span className="poster-copy-summary-key">
                        {prefs.pureVisual ? '模式' : '当前标题'}
                      </span>
                      <span className="poster-copy-summary-text">
                        {prefs.pureVisual ? '纯视觉（隐藏所有页眉、目录与图例文字）' : autoTitleDisplay}
                      </span>
                    </div>
                  )}

                  {copyOpen && (
                    <div className={`poster-copy-body ${prefs.pureVisual ? 'is-muted' : ''}`}>
                      {prefs.pureVisual && (
                        <div className="poster-copy-pure-banner">
                          <span>纯视觉模式已开启，以下文字仅在关闭后显示</span>
                          <button
                            type="button"
                            className="compact"
                            onClick={() => updatePrefs({ pureVisual: false })}
                          >
                            显示文字
                          </button>
                        </div>
                      )}

                      <div className="poster-copy-grid">
                        <div className="poster-field">
                          <div className="poster-field-head">
                            <label htmlFor="poster-title-input">主标题</label>
                            <span className="poster-field-hint">
                              {copyOverrides.title ? '自定义' : '留空自动'}
                            </span>
                          </div>
                          <div className="poster-input-wrap">
                            <input
                              id="poster-title-input"
                              type="text"
                              value={copyOverrides.title}
                              placeholder={previewRes?.autoCopy.title || ''}
                              disabled={prefs.pureVisual}
                              onChange={(e) =>
                                setCopyOverrides((prev) => ({ ...prev, title: e.target.value }))
                              }
                            />
                            {copyOverrides.title && !prefs.pureVisual && (
                              <button
                                type="button"
                                className="poster-input-clear"
                                title="清空"
                                onClick={() => setCopyOverrides((prev) => ({ ...prev, title: '' }))}
                              >
                                ×
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="poster-field">
                          <div className="poster-field-head">
                            <label htmlFor="poster-sub-input">副标题 / 语料题注</label>
                            <span className="poster-field-hint">
                              {copyOverrides.subtitle ? '自定义' : '留空自动'}
                            </span>
                          </div>
                          <div className="poster-input-wrap">
                            <input
                              id="poster-sub-input"
                              type="text"
                              value={copyOverrides.subtitle}
                              placeholder={previewRes?.autoCopy.subtitle || ''}
                              disabled={prefs.pureVisual}
                              onChange={(e) =>
                                setCopyOverrides((prev) => ({ ...prev, subtitle: e.target.value }))
                              }
                            />
                            {copyOverrides.subtitle && !prefs.pureVisual && (
                              <button
                                type="button"
                                className="poster-input-clear"
                                title="清空"
                                onClick={() => setCopyOverrides((prev) => ({ ...prev, subtitle: '' }))}
                              >
                                ×
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="poster-field">
                          <div className="poster-field-head">
                            <label htmlFor="poster-foot-input">页脚铭文</label>
                            <span className="poster-field-hint">
                              {copyOverrides.footer ? '自定义' : '留空显示默认图例'}
                            </span>
                          </div>
                          <div className="poster-input-wrap">
                            <input
                              id="poster-foot-input"
                              type="text"
                              value={copyOverrides.footer}
                              placeholder={previewRes?.autoCopy.footer || ''}
                              disabled={prefs.pureVisual}
                              onChange={(e) =>
                                setCopyOverrides((prev) => ({ ...prev, footer: e.target.value }))
                              }
                            />
                            {copyOverrides.footer && !prefs.pureVisual && (
                              <button
                                type="button"
                                className="poster-input-clear"
                                title="清空"
                                onClick={() => setCopyOverrides((prev) => ({ ...prev, footer: '' }))}
                              >
                                ×
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      {activePointsForNotes.length > 0 && (
                        <div className="poster-point-section">
                          <div className="poster-field-head">
                            <span className="poster-point-title">
                              标点释义 · {activePointsForNotes.length} 项
                            </span>
                            <span className="poster-field-hint">显示于底部目录</span>
                          </div>
                          <div className="poster-point-ledger">
                            {activePointsForNotes.map((pt, idx) => {
                              const decoded = resolvePosterText(pt.mark) || `P${idx + 1}`;
                              return (
                                <div key={`pt-note-${idx}`} className="poster-point-note-row">
                                  <span className="pt-idx">{String(idx + 1).padStart(2, '0')}</span>
                                  <span className="pt-time">{pt.number.toFixed(2)}s</span>
                                  <span className="pt-mark" title={decoded}>
                                    {decoded}
                                  </span>
                                  <input
                                    type="text"
                                    disabled={prefs.pureVisual}
                                    placeholder="输入简短释义…"
                                    value={copyOverrides.pointNotes[String(idx)] || ''}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setCopyOverrides((prev) => ({
                                        ...prev,
                                        pointNotes: { ...prev.pointNotes, [String(idx)]: val }
                                      }));
                                    }}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="export-modal-foot">
          <span className="export-foot-note">
            {busyAction
              ? '正在渲染高分辨率声纹海报…'
              : previewRes
                ? `${previewRes.activeIntervalCount} 层标注${previewRes.activePointCount > 0 ? ` · ${previewRes.activePointCount} 个标点` : ''} · 矢量分组支持 Illustrator / Figma 编辑`
                : '正在生成声纹海报预览…'}
          </span>
          <div className="poster-foot-controls">
            <div className="poster-foot-scale">
              <span className="poster-foot-scale-label">PNG 倍率</span>
              <div className="segmented" role="group" aria-label="输出规格 PNG 倍率">
                {([2, 3, 4] as PosterPngScale[]).map((sc) => (
                  <button
                    key={sc}
                    type="button"
                    className={`compact ${prefs.pngScale === sc ? 'active' : ''}`}
                    disabled={Boolean(busyAction)}
                    onClick={() => updatePrefs({ pngScale: sc })}
                  >
                    {sc === 2 ? '2×' : sc === 3 ? '3× 推荐' : '4×'}
                  </button>
                ))}
              </div>
            </div>
            <div className="sep" aria-hidden="true" />
            <div className="export-foot-actions">
              <button type="button" disabled={Boolean(busyAction)} onClick={() => void handleCopyPng()}>
                <UiIcon name="copy" size={13} />
                <span>复制 PNG</span>
              </button>
              <button type="button" disabled={Boolean(busyAction)} onClick={() => void handlePrintPdf()}>
                <span>打印 PDF</span>
              </button>
              <button type="button" disabled={Boolean(busyAction)} onClick={() => void handleExportSvg()}>
                <UiIcon name="exportSvg" size={13} />
                <span>导出 SVG</span>
              </button>
              <button
                type="button"
                className="primary"
                disabled={Boolean(busyAction)}
                onClick={() => void handleExportPng()}
              >
                <UiIcon name="exportPng" size={14} />
                <span>导出 PNG</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
