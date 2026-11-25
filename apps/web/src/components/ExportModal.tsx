import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPlatformBridge, isTauriRuntime } from '../bridge/PlatformBridge';
import { useEditorStore } from '../store/useEditorStore';
import { getElementRectScale } from '../utils/uiScale';
import {
  applyPresetToPrefs,
  buildExportZipBytes,
  formatByteSize,
  getBaseStem,
  loadExportPrefs,
  renderOffscreenExport,
  renderOffscreenPngBlob,
  saveExportPrefs,
  triggerBlobDownload,
  type ExportPrefs,
  type ExportRenderOutput
} from '../render/exporter';
import { CloseIcon, UiIcon } from './Icons';

interface ExportModalProps {
  audioBuffer: AudioBuffer | null;
}

export const ExportModal: React.FC<ExportModalProps> = ({ audioBuffer }) => {
  const open = useEditorStore((s) => s.exportOpen);
  const setOpen = useEditorStore((s) => s.setExportOpen);
  const exportPresetRange = useEditorStore((s) => s.exportPresetRange);
  const clearExportPresetRange = useEditorStore((s) => s.clearExportPresetRange);
  const tg = useEditorStore((s) => s.tg);
  const filename = useEditorStore((s) => s.filename);
  const wrapMode = useEditorStore((s) => s.wrapMode);
  const scaleMode = useEditorStore((s) => s.scaleMode);
  const targetWidth = useEditorStore((s) => s.targetWidth);
  const widthAutoFit = useEditorStore((s) => s.widthAutoFit);
  const tickPrecision = useEditorStore((s) => s.tickPrecision);
  const tickFixedDecimals = useEditorStore((s) => s.tickFixedDecimals);
  const viewDomain = useEditorStore((s) => s.viewDomain);
  const playRange = useEditorStore((s) => s.playRange);
  const selection = useEditorStore((s) => s.selection);
  const legendOpen = useEditorStore((s) => s.legendOpen);
  const audioName = useEditorStore((s) => s.audioName);
  const audioOffset = useEditorStore((s) => s.audioOffset);
  const analysis = useEditorStore((s) => s.analysis);
  const showSpectrogram = useEditorStore((s) => s.showSpectrogram);
  const cueMode = useEditorStore((s) => s.cueMode);
  const tierOrder = useEditorStore((s) => s.tierOrder);
  const maxFreq = useEditorStore((s) => s.maxFreq);
  const showToast = useEditorStore((s) => s.showToast);

  const [prefs, setPrefs] = useState<ExportPrefs>(() => loadExportPrefs());
  const [customStartText, setCustomStartText] = useState('');
  const [customEndText, setCustomEndText] = useState('');
  const [selectedTiers, setSelectedTiers] = useState<number[]>([]);
  const [advOpen, setAdvOpen] = useState(false);
  const [previewOut, setPreviewOut] = useState<ExportRenderOutput | null>(null);
  const [rendering, setRendering] = useState(false);

  // Interactive cursor-anchored wheel-zoom & drag-to-pan preview state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [baseSize, setBaseSize] = useState({ w: 300, h: 200 });
  const stageRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const backdropPointerDownRef = useRef(false);

  const hasSpec = Boolean(audioName && showSpectrogram && analysis);
  const hasSelectionRange = Boolean(
    (playRange && playRange.end > playRange.start) ||
      (selection?.kind === 'interval' &&
        (tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex]?.xmax ?? 0) >
          (tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex]?.xmin ?? 0))
  );

  // Sync tier selection & range fallback when document changes or modal opens
  useEffect(() => {
    if (!open) return;
    setSelectedTiers((prev) => {
      const valid = prev.filter((i) => i >= 0 && i < tg.tiers.length);
      return valid.length > 0 ? valid : tg.tiers.map((_, i) => i);
    });
    if (exportPresetRange) {
      setPrefs((prev) => {
        const next: ExportPrefs = { ...prev, rangeMode: exportPresetRange };
        saveExportPrefs(next);
        return next;
      });
      clearExportPresetRange();
    } else {
      setPrefs((prev) => {
        let nextRange = prev.rangeMode;
        if (nextRange === 'view' && !viewDomain) nextRange = 'all';
        if (nextRange === 'selection' && !hasSelectionRange) nextRange = 'all';
        if (nextRange === prev.rangeMode) return prev;
        const next: ExportPrefs = { ...prev, rangeMode: nextRange };
        saveExportPrefs(next);
        return next;
      });
    }
    setCustomStartText(String(prefs.customStart ?? tg.xmin));
    setCustomEndText(String(prefs.customEnd ?? tg.xmax));
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [open, tg.tiers.length, tg.xmin, tg.xmax, exportPresetRange, clearExportPresetRange, viewDomain, hasSelectionRange]);

  const updatePrefs = (patch: Partial<ExportPrefs>, clearPreset = true) => {
    setPrefs((prev) => {
      const next: ExportPrefs = {
        ...prev,
        ...patch,
        ...(clearPreset ? { activePreset: null } : {})
      };
      saveExportPrefs(next);
      return next;
    });
  };

  const buildInput = useCallback(
    (previewMode: boolean, overridePrefs?: ExportPrefs) => ({
      bridge: getPlatformBridge(),
      tg,
      filename,
      prefs: overridePrefs || prefs,
      tierIndices: selectedTiers.length ? selectedTiers : tg.tiers.map((_, i) => i),
      previewMode,
      stageWidth: Math.max(320, window.innerWidth - 56),
      uiWrapMode: wrapMode,
      uiScaleMode: scaleMode,
      uiTargetWidth: targetWidth,
      uiWidthAutoFit: widthAutoFit,
      viewDomain,
      playRange,
      selection,
      hasAudio: Boolean(audioName && audioBuffer),
      audioBuffer,
      audioOffset,
      analysis,
      showSpectrogram,
      cueMode,
      tierOrder,
      maxFreq
    }),
    [
      tg,
      filename,
      prefs,
      selectedTiers,
      wrapMode,
      scaleMode,
      targetWidth,
      widthAutoFit,
      viewDomain,
      playRange,
      selection,
      audioName,
      audioBuffer,
      audioOffset,
      analysis,
      showSpectrogram,
      cueMode,
      tierOrder,
      maxFreq
    ]
  );

  // Debounced live preview generation
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRendering(true);
    const timer = setTimeout(async () => {
      try {
        const res = await renderOffscreenExport(buildInput(true));
        if (cancelled) return;
        setPreviewOut(res);
        // Fit base size into preview stage
        const stage = stageRef.current;
        if (stage) {
          const availW = Math.max(120, stage.clientWidth - 32);
          const availH = Math.max(120, stage.clientHeight - 32);
          const ratio = Math.min(availW / Math.max(1, res.layout.width), availH / Math.max(1, res.layout.height), 1);
          setBaseSize({
            w: Math.max(40, Math.round(res.layout.width * ratio)),
            h: Math.max(40, Math.round(res.layout.height * ratio))
          });
        }
      } catch (err) {
        if (!cancelled) {
          showToast(`预览生成失败: ${String(err)}`, true);
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    }, 90);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, buildInput]);

  const zoomAt = useCallback(
    (targetZoom: number, clientX?: number, clientY?: number) => {
      setZoom((prevZoom) => {
        const clamped = Math.max(0.5, Math.min(10, Number(targetZoom.toFixed(3))));
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
    },
    []
  );

  // Use non-passive wheel listener so preventDefault always works cleanly without console warnings
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
    if (!previewOut?.svgMarkup) return null;
    const stripped = previewOut.svgMarkup.replace(/^<\?xml[^>]*\?>\s*/i, '');
    return {
      __html: stripped.replace(/<svg\b/, '<svg style="width:100%;height:100%;display:block;"')
    };
  }, [previewOut?.svgMarkup]);

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
      // ignore if pointer capture is unsupported
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

  const handleDownload = async () => {
    const isDesktop = isTauriRuntime();
    const bridge = getPlatformBridge();
    const makeReveal = (savedPath: string) => ({
      label: '打开所在文件夹',
      onClick: () => {
        void bridge.revealInExplorer(savedPath).catch(() => {
          useEditorStore.getState().showToast('无法打开所在文件夹', true);
        });
      }
    });

    try {
      const stem = getBaseStem(filename);
      if (prefs.format === 'png') {
        const res = await renderOffscreenPngBlob(buildInput(false));
        const label = `已导出高清 PNG (${res.width}×${res.height}${res.scaleCapped ? ` · 自动降倍 ${res.effectiveScale}×` : ''})`;
        if (isDesktop) {
          const bytes = new Uint8Array(await res.blob.arrayBuffer());
          const savedPath = await bridge.saveNativeFileDialog(
            `${stem}.png`,
            [{ name: '高清图片 (PNG)', extensions: ['png'] }],
            bytes,
            { title: '导出高清图片' }
          );
          if (savedPath) showToast(label, false, makeReveal(savedPath));
        } else {
          triggerBlobDownload(res.blob, `${stem}.png`);
          showToast(label);
        }
      } else {
        const res = await renderOffscreenExport(buildInput(false));
        if (res.specStrategy === 'external-zip') {
          const zipBytes = await buildExportZipBytes(
            bridge,
            stem,
            res.svgMarkup,
            res.externalAssets
          );
          const label = `已导出图文分离包 (.zip · 含 ${res.externalAssets.length} 张底图)`;
          if (isDesktop) {
            const savedPath = await bridge.saveNativeFileDialog(
              `${stem}_vector_bundle.zip`,
              [{ name: '图文分离压缩包 (ZIP)', extensions: ['zip'] }],
              zipBytes,
              { title: '导出图文分离包' }
            );
            if (savedPath) showToast(label, false, makeReveal(savedPath));
          } else {
            triggerBlobDownload(
              new Blob([zipBytes as BlobPart], { type: 'application/zip' }),
              `${stem}_vector_bundle.zip`
            );
            showToast(label);
          }
        } else {
          if (isDesktop) {
            const svgBytes = new TextEncoder().encode(res.svgMarkup);
            const savedPath = await bridge.saveNativeFileDialog(
              `${stem}.svg`,
              [{ name: '矢量图 (SVG)', extensions: ['svg'] }],
              svgBytes,
              { title: '导出矢量图' }
            );
            if (savedPath) showToast('已导出矢量图 (.svg)', false, makeReveal(savedPath));
          } else {
            triggerBlobDownload(
              new Blob([res.svgMarkup], { type: 'image/svg+xml;charset=utf-8' }),
              `${stem}.svg`
            );
            showToast('已导出矢量图 (.svg)');
          }
        }
      }
    } catch (err) {
      showToast(`导出失败: ${String(err)}`, true);
    }
  };

  const handleCopy = async () => {
    try {
      if (prefs.format === 'png') {
        const res = await renderOffscreenPngBlob(buildInput(false));
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': res.blob })]);
          showToast(`已复制高清图像 (${res.width}×${res.height}) 到剪贴板`);
        } else {
          showToast('当前环境不支持复制图片到剪贴板', true);
        }
      } else {
        const isZip = hasSpec && prefs.specMode === 'external-zip';
        const res = await renderOffscreenExport({
          ...buildInput(false),
          forceSpecStrategy: isZip ? 'curves-only' : undefined
        });
        await navigator.clipboard.writeText(res.svgMarkup);
        showToast(isZip ? '已复制 SVG 矢量代码（不含分离底图）' : '已复制 SVG 矢量代码到剪贴板');
      }
    } catch (err) {
      showToast(`复制失败: ${String(err)}`, true);
    }
  };

  if (!open) return null;

  const summaryText = previewOut
    ? prefs.format === 'png'
      ? `${Math.round(previewOut.layout.width * previewOut.effectiveScale)} × ${Math.round(previewOut.layout.height * previewOut.effectiveScale)} px (${previewOut.effectiveScale}×)`
      : `${previewOut.layout.width} × ${previewOut.layout.height} pt · SVG`
    : '正在生成预览…';

  return (
    <div
      className="modal-backdrop open"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-modal-title"
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
      <div className="modal-card export-modal-card">
        <div className="modal-head">
          <span id="export-modal-title" className="modal-title">
            <UiIcon name="export" size={14} />
            <span>导出谱面图像</span>
          </span>
          <button type="button" className="icon-btn compact" title="关闭 (Esc)" onClick={() => setOpen(false)}>
            <CloseIcon />
          </button>
        </div>

        <div className="export-preset-strip">
          <span className="export-preset-label">场景预设</span>
          <div className="export-preset-group" role="group">
            {(
              [
                ['screen', '与当前一致'],
                ['journal', '期刊黑白'],
                ['slides', '演示彩图'],
                ['lines', '仅留线条与标注']
              ] as const
            ).map(([pid, lbl]) => (
              <button
                key={pid}
                type="button"
                className={`compact ${prefs.activePreset === pid ? 'active' : ''}`}
                onClick={() => {
                  const next = applyPresetToPrefs(prefs, pid, {
                    tickPrecision,
                    tickFixedDecimals,
                    legendOpen
                  });
                  setPrefs(next);
                  saveExportPrefs(next);
                }}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div className="export-split">
          <div className="export-preview-pane">
            <div
              ref={stageRef}
              className={`export-preview-stage ${dragging ? 'dragging' : ''}`}
              title="滚轮缩放 · 拖拽平移 · 双击复原"
              onPointerDown={handleStagePointerDown}
              onDoubleClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
            >
              <div
                ref={paperRef}
                className={`export-preview-paper ${prefs.transparentBg ? 'checkerboard' : ''}`}
                style={{
                  width: `${(baseSize.w * zoom).toFixed(2)}px`,
                  height: `${(baseSize.h * zoom).toFixed(2)}px`,
                  transform: `translate(calc(-50% + ${pan.x.toFixed(1)}px), calc(-50% + ${pan.y.toFixed(1)}px))`
                }}
                dangerouslySetInnerHTML={previewHtml ?? undefined}
              />
              <div className="export-preview-zoom-bar" role="group" aria-label="预览缩放">
                <button type="button" title="缩小" onClick={() => zoomAt(zoom / 1.25)}>
                  −
                </button>
                <button
                  type="button"
                  title="复原视图"
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
              </div>
            </div>
            <div className="export-spec-bar">
              <span>{rendering ? '正在更新预览…' : summaryText}</span>
              <strong>{previewOut ? formatByteSize(previewOut.estimatedBytes) : ''}</strong>
            </div>
          </div>

          <div className="export-controls-pane">
            {/* 1. Format */}
            <div className="export-group">
              <div className="export-sub-row">
                <span className="export-group-title">文件格式</span>
                <div className="segmented" role="group">
                  <button
                    type="button"
                    className={`compact ${prefs.format === 'svg' ? 'active' : ''}`}
                    onClick={() => updatePrefs({ format: 'svg' }, false)}
                  >
                    <UiIcon name="exportSvg" size={13} />
                    <span>矢量图 (SVG)</span>
                  </button>
                  <button
                    type="button"
                    className={`compact ${prefs.format === 'png' ? 'active' : ''}`}
                    onClick={() => updatePrefs({ format: 'png' }, false)}
                  >
                    <UiIcon name="exportPng" size={13} />
                    <span>高清图片 (PNG)</span>
                  </button>
                </div>
              </div>
            </div>

            {/* 2. Range & Tiers */}
            <div className="export-group">
              <span className="export-group-title">导出范围</span>
              <div className="export-sub-row">
                <span className="setting-label">时间范围</span>
                <div className="segmented" role="group">
                  <button
                    type="button"
                    className={`compact ${prefs.rangeMode === 'all' ? 'active' : ''}`}
                    onClick={() => updatePrefs({ rangeMode: 'all' }, false)}
                  >
                    全部时段
                  </button>
                  <button
                    type="button"
                    className={`compact ${prefs.rangeMode === 'view' ? 'active' : ''}`}
                    disabled={!viewDomain}
                    onClick={() => updatePrefs({ rangeMode: 'view' }, false)}
                  >
                    当前视窗
                  </button>
                  <button
                    type="button"
                    className={`compact ${prefs.rangeMode === 'selection' ? 'active' : ''}`}
                    disabled={!hasSelectionRange}
                    onClick={() => updatePrefs({ rangeMode: 'selection' }, false)}
                  >
                    所选区间
                  </button>
                  <button
                    type="button"
                    className={`compact ${prefs.rangeMode === 'custom' ? 'active' : ''}`}
                    onClick={() => {
                      const sVal = prefs.customStart ?? tg.xmin;
                      const eVal = prefs.customEnd ?? tg.xmax;
                      setCustomStartText(String(sVal));
                      setCustomEndText(String(eVal));
                      updatePrefs(
                        {
                          rangeMode: 'custom',
                          customStart: sVal,
                          customEnd: eVal
                        },
                        false
                      );
                    }}
                  >
                    自定起止
                  </button>
                </div>
              </div>

              {prefs.rangeMode === 'custom' && (
                <div className="export-custom-range">
                  <label className="field-inline">
                    起 (秒)
                    <input
                      type="number"
                      step="any"
                      value={customStartText}
                      onChange={(e) => {
                        setCustomStartText(e.target.value);
                        const v = parseFloat(e.target.value);
                        if (Number.isFinite(v)) updatePrefs({ customStart: v }, false);
                      }}
                    />
                  </label>
                  <label className="field-inline">
                    止 (秒)
                    <input
                      type="number"
                      step="any"
                      value={customEndText}
                      onChange={(e) => {
                        setCustomEndText(e.target.value);
                        const v = parseFloat(e.target.value);
                        if (Number.isFinite(v)) updatePrefs({ customEnd: v }, false);
                      }}
                    />
                  </label>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 2 }}>
                <span className="setting-label">包含层级</span>
                <div className="export-tier-chips">
                  {tg.tiers.map((tier, idx) => {
                    const checked = selectedTiers.includes(idx);
                    return (
                      <button
                        key={`${tier.name}-${idx}`}
                        type="button"
                        className={`export-tier-chip ${checked ? 'active' : ''}`}
                        onClick={() => {
                          setSelectedTiers((prev) => {
                            if (prev.includes(idx)) {
                              if (prev.length <= 1) return prev;
                              return prev.filter((i) => i !== idx);
                            }
                            return [...prev, idx].sort((a, b) => a - b);
                          });
                        }}
                      >
                        <span className="chip-box" />
                        <span className="export-tier-chip-text">
                          {idx + 1}. {tier.name || '∅'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 3. Spectrogram / PNG Scale */}
            {(hasSpec || prefs.format === 'png') && (
              <div className="export-group">
                <div className="export-group-head">
                  <span className="export-group-title">
                    {prefs.format === 'png' ? '图像清晰度' : '语谱图表现'}
                  </span>
                </div>
                {prefs.format === 'svg' && hasSpec && (
                  <div className="export-grid-2" role="group">
                    {(
                      [
                        ['contour', '等值轮廓（纯矢量）', '单文件 · 放大清晰'],
                        ['external-zip', '图文分离包 (.zip)', '矢量线框 + 独立底图'],
                        ['curves-only', '不绘灰阶底图', '仅留波形、曲线与标注'],
                        ['embed-defs', '单文件内嵌', '完整灰阶 · 单文件保存']
                      ] as const
                    ).map(([val, title, sub]) => (
                      <button
                        key={val}
                        type="button"
                        className={`compact ${prefs.specMode === val ? 'active' : ''}`}
                        onClick={() => updatePrefs({ specMode: val })}
                      >
                        <span>{title}</span>
                        <span className="export-btn-sub">{sub}</span>
                      </button>
                    ))}
                  </div>
                )}
                {prefs.format === 'png' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    <div className="export-sub-row">
                      <span className="setting-label">清晰度倍率</span>
                      <div className="segmented" role="group">
                        {([2, 3, 6] as const).map((sc) => (
                          <button
                            key={sc}
                            type="button"
                            className={`compact ${prefs.pngScale === sc ? 'active' : ''}`}
                            onClick={() => updatePrefs({ pngScale: sc })}
                          >
                            {sc === 2 ? '常规 (2×)' : sc === 3 ? '高清 (3×)' : '印刷级 (6×)'}
                          </button>
                        ))}
                      </div>
                    </div>
                    {hasSpec && (
                      <div className="export-sub-row">
                        <span className="setting-label">灰阶底图</span>
                        <div className="segmented" role="group">
                          <button
                            type="button"
                            className={`compact ${prefs.pngShowBackdrop ? 'active' : ''}`}
                            onClick={() => updatePrefs({ pngShowBackdrop: true })}
                          >
                            绘制底图
                          </button>
                          <button
                            type="button"
                            className={`compact ${!prefs.pngShowBackdrop ? 'active' : ''}`}
                            onClick={() => updatePrefs({ pngShowBackdrop: false })}
                          >
                            不绘灰阶底图
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 4. Width */}
            <div className="export-group">
              <span className="export-group-title">版面宽度</span>
              <div className="export-grid-2" role="group">
                {(
                  [
                    ['window', '跟随窗口', '沿用当前版面'],
                    ['single-col', '单栏版幅', '约 8.5 cm'],
                    ['full-col', '通栏版幅', '约 17 cm'],
                    ['single-line', '单行长图', '连续展开不换行']
                  ] as const
                ).map(([val, title, sub]) => (
                  <button
                    key={val}
                    type="button"
                    className={`compact ${prefs.widthPreset === val ? 'active' : ''}`}
                    onClick={() => updatePrefs({ widthPreset: val })}
                  >
                    <span>{title}</span>
                    <span className="export-btn-sub">{sub}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 5. Palette */}
            <div className="export-group">
              <span className="export-group-title">画面配色</span>
              <div className="export-sub-row">
                <div className="segmented" role="group">
                  <button
                    type="button"
                    className={`compact ${prefs.palette === 'warm' ? 'active' : ''}`}
                    onClick={() => updatePrefs({ palette: 'warm' })}
                  >
                    暖灰原色
                  </button>
                  <button
                    type="button"
                    className={`compact ${prefs.palette === 'bw' ? 'active' : ''}`}
                    onClick={() => updatePrefs({ palette: 'bw' })}
                  >
                    纯黑白印刷
                  </button>
                </div>
                <label className="export-check">
                  <input
                    type="checkbox"
                    checked={prefs.transparentBg}
                    onChange={(e) => updatePrefs({ transparentBg: e.target.checked })}
                  />
                  <span>透明底色</span>
                </label>
              </div>
            </div>

            {/* 5.5 Legend */}
            <div className="export-group">
              <span className="export-group-title">图例设置</span>
              <div className="export-sub-row">
                <span className="setting-label">图例显示</span>
                <div className="segmented" role="group">
                  {(
                    [
                      ['full', '结构与符号'],
                      ['compact', '仅符号'],
                      ['off', '不显示']
                    ] as const
                  ).map(([val, lbl]) => (
                    <button
                      key={val}
                      type="button"
                      className={`compact ${prefs.legendMode === val ? 'active' : ''}`}
                      onClick={() => updatePrefs({ legendMode: val })}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>
              <div className="export-sub-row">
                <span className="setting-label">图例语言</span>
                <div className="segmented" role="group">
                  <button
                    type="button"
                    className={`compact ${prefs.legendLang === 'zh' ? 'active' : ''}`}
                    onClick={() => updatePrefs({ legendLang: 'zh' }, false)}
                  >
                    中文
                  </button>
                  <button
                    type="button"
                    className={`compact ${prefs.legendLang === 'en' ? 'active' : ''}`}
                    onClick={() => updatePrefs({ legendLang: 'en' }, false)}
                  >
                    English
                  </button>
                </div>
              </div>
            </div>

            {/* 6. Advanced */}
            <div className="export-group" style={{ borderBottom: 'none', paddingBottom: 0 }}>
              <button
                type="button"
                className="export-adv-toggle"
                aria-expanded={advOpen}
                onClick={() => setAdvOpen(!advOpen)}
              >
                <span>{advOpen ? '▾ 更多排版与细节' : '▸ 更多排版与细节'}</span>
              </button>

              {advOpen && (
                <div className="export-adv-body">
                  <div className="export-adv-subgroup">
                    <span className="export-adv-subtitle">标注与画面净化</span>
                    <div className="export-sub-row">
                      <span className="setting-label">音标转写</span>
                      <div className="segmented" role="group">
                        {(
                          [
                            ['ipa-only', '仅显音标'],
                            ['dual', '音标与原码对照'],
                            ['raw-only', '仅显原码']
                          ] as const
                        ).map(([val, lbl]) => (
                          <button
                            key={val}
                            type="button"
                            className={`compact ${prefs.trigraphMode === val ? 'active' : ''}`}
                            onClick={() => updatePrefs({ trigraphMode: val })}
                          >
                            {lbl}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="export-check-list">
                      <label className="export-check">
                        <input
                          type="checkbox"
                          checked={prefs.hideMetaSymbols}
                          onChange={(e) => updatePrefs({ hideMetaSymbols: e.target.checked })}
                        />
                        <span>隐藏空格与折行标记</span>
                      </label>
                      <label className="export-check">
                        <input
                          type="checkbox"
                          checked={prefs.hideStretchCues}
                          onChange={(e) => updatePrefs({ hideStretchCues: e.target.checked })}
                        />
                        <span>隐藏自适应展开提示</span>
                      </label>
                      <label className="export-check">
                        <input
                          type="checkbox"
                          checked={prefs.showCaption}
                          onChange={(e) => updatePrefs({ showCaption: e.target.checked })}
                        />
                        <span>添加标题与起止时间</span>
                      </label>
                      <label className="export-check">
                        <input
                          type="checkbox"
                          checked={prefs.showLinearScaleBar}
                          onChange={(e) => updatePrefs({ showLinearScaleBar: e.target.checked })}
                        />
                        <span>线性模式附时间标尺</span>
                      </label>
                    </div>
                  </div>

                  <div className="export-adv-subgroup">
                    <span className="export-adv-subtitle">比例与留白（仅作用于成图）</span>
                    <div className="export-sub-row">
                      <span className="setting-label">时间比例</span>
                      <div className="segmented" role="group">
                        {(
                          [
                            ['follow', '跟随界面'],
                            ['linear', '线性对齐'],
                            ['adaptive', '自适应宽度']
                          ] as const
                        ).map(([val, lbl]) => (
                          <button
                            key={val}
                            type="button"
                            className={`compact ${prefs.scaleMode === val ? 'active' : ''}`}
                            onClick={() => updatePrefs({ scaleMode: val })}
                          >
                            {lbl}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="export-sub-row">
                      <span className="setting-label">时间刻度</span>
                      <div className="segmented" role="group">
                        {(
                          [
                            ['2', '两位小数'],
                            ['3', '三位小数'],
                            ['full', '完整数值'],
                            ['none', '不显示刻度']
                          ] as const
                        ).map(([val, lbl]) => (
                          <button
                            key={val}
                            type="button"
                            className={`compact ${prefs.tickPrecision === val ? 'active' : ''}`}
                            onClick={() => updatePrefs({ tickPrecision: val })}
                          >
                            {lbl}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label
                      className={`export-check ${
                        prefs.tickPrecision === 'full' || prefs.tickPrecision === 'none'
                          ? 'is-disabled'
                          : ''
                      }`}
                    >
                      <input
                        type="checkbox"
                        disabled={prefs.tickPrecision === 'full' || prefs.tickPrecision === 'none'}
                        checked={prefs.tickFixedDecimals}
                        onChange={(e) => updatePrefs({ tickFixedDecimals: e.target.checked })}
                      />
                      <span>固定小数位补零（如 10.30）</span>
                    </label>
                    <div className="export-sub-row">
                      <span className="setting-label">四周留白</span>
                      <div className="segmented" role="group">
                        {(
                          [
                            ['tight', '紧凑'],
                            ['standard', '适中'],
                            ['wide', '宽裕']
                          ] as const
                        ).map(([val, lbl]) => (
                          <button
                            key={val}
                            type="button"
                            className={`compact ${prefs.marginPreset === val ? 'active' : ''}`}
                            onClick={() => updatePrefs({ marginPreset: val })}
                          >
                            {lbl}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="export-adv-subgroup">
                    <span className="export-adv-subtitle">图像细节</span>
                    {hasSpec && (
                      <>
                        <div className="export-sub-row">
                          <span className="setting-label">底噪洁净度</span>
                          <div className="segmented" role="group">
                            {(
                              [
                                [58, '柔和 58dB'],
                                [52, '均衡 52dB'],
                                [45, '洁净 45dB']
                              ] as const
                            ).map(([val, lbl]) => (
                              <button
                                key={val}
                                type="button"
                                className={`compact ${prefs.specDynRange === val ? 'active' : ''}`}
                                onClick={() => updatePrefs({ specDynRange: val })}
                              >
                                {lbl}
                              </button>
                            ))}
                          </div>
                        </div>
                        {prefs.format === 'svg' && prefs.specMode === 'contour' && (
                          <div className="export-sub-row">
                            <span className="setting-label">轮廓层次</span>
                            <div className="segmented" role="group">
                              {(
                                [
                                  [4, '简约 (4 阶)'],
                                  [6, '适中 (6 阶)'],
                                  [8, '细腻 (8 阶)']
                                ] as const
                              ).map(([val, lbl]) => (
                                <button
                                  key={val}
                                  type="button"
                                  className={`compact ${prefs.contourLevels === val ? 'active' : ''}`}
                                  onClick={() => updatePrefs({ contourLevels: val })}
                                >
                                  {lbl}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                    {prefs.format === 'svg' && (
                      <>
                        <label className="export-check">
                          <input
                            type="checkbox"
                            checked={prefs.semanticGroups}
                            onChange={(e) => updatePrefs({ semanticGroups: e.target.checked })}
                          />
                          <span>按层编组，便于二次编辑</span>
                        </label>
                        <label className="export-check">
                          <input
                            type="checkbox"
                            checked={prefs.roundCoords}
                            onChange={(e) => updatePrefs({ roundCoords: e.target.checked })}
                          />
                          <span>精简矢量体积</span>
                        </label>
                        <div className="export-sub-row">
                          <span className="setting-label">字体兼容</span>
                          <div className="segmented" role="group">
                            <button
                              type="button"
                              className={`compact ${prefs.fontStrategy === 'ipa' ? 'active' : ''}`}
                              onClick={() => updatePrefs({ fontStrategy: 'ipa' })}
                            >
                              完整音标字体栈（推荐）
                            </button>
                            <button
                              type="button"
                              className={`compact ${prefs.fontStrategy === 'serif' ? 'active' : ''}`}
                              onClick={() => updatePrefs({ fontStrategy: 'serif' })}
                            >
                              通用衬线体
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="export-modal-foot">
          <span className="export-foot-note">
            所有设置自动记住，不影响当前编辑画布。
          </span>
          <div className="export-foot-actions">
            <button type="button" onClick={handleCopy}>
              <UiIcon name="copy" size={13} />
              <span>{prefs.format === 'png' ? '复制图片' : '复制 SVG'}</span>
            </button>
            <button type="button" className="primary" onClick={handleDownload}>
              <UiIcon name={prefs.format === 'png' ? 'exportPng' : 'exportSvg'} size={14} />
              <span>
                {prefs.format === 'png'
                  ? isTauriRuntime()
                    ? '导出 PNG…'
                    : '下载 PNG'
                  : prefs.specMode === 'external-zip' && hasSpec
                    ? isTauriRuntime()
                      ? '导出分离包 (.zip)…'
                      : '下载分离包 (.zip)'
                    : isTauriRuntime()
                      ? '导出 SVG…'
                      : '下载 SVG'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
