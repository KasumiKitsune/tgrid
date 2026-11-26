import React, { useMemo } from 'react';
import type { TextGrid } from '../bridge/types';
import { getEffectiveShortcutHint } from '../shortcuts/registry';
import { useEditorStore, type IpaInputMode } from '../store/useEditorStore';
import { CANVAS_SCALE_MAX, CANVAS_SCALE_MIN, stepCanvasScale } from '../utils/uiScale';
import { UiIcon } from './Icons';

interface QuickDiagCounts {
  gaps: number;
  overlaps: number;
  zeros: number;
  micros: number;
  total: number;
}

function scanQuickDiagnostics(tg: TextGrid): QuickDiagCounts {
  let gaps = 0;
  let overlaps = 0;
  let zeros = 0;
  let micros = 0;
  const eps = 1e-9;
  const microThreshold = 0.005 - 1e-9;

  for (const tier of tg.tiers) {
    if (tier.kind !== 'intervalTier') continue;
    const ivs = tier.intervals;
    if (ivs.length === 0) continue;

    if (Number.isFinite(tier.xmin) && ivs[0].xmin > tier.xmin + eps) {
      gaps++;
    }

    for (let i = 0; i < ivs.length; i++) {
      const iv = ivs[i];
      const dur = iv.xmax - iv.xmin;
      if (dur <= 1e-12) {
        zeros++;
      } else if (dur < microThreshold) {
        micros++;
      }
      if (i > 0) {
        const prev = ivs[i - 1];
        if (iv.xmin > prev.xmax + eps) {
          gaps++;
        } else if (iv.xmin < prev.xmax - eps) {
          overlaps++;
        }
      }
    }

    if (Number.isFinite(tier.xmax) && ivs[ivs.length - 1].xmax < tier.xmax - eps) {
      gaps++;
    }
  }

  return {
    gaps,
    overlaps,
    zeros,
    micros,
    total: gaps + overlaps + zeros + micros
  };
}

const IPA_LABELS: Record<IpaInputMode, string> = {
  off: '音标：关',
  yunlong: '云龙 IPA',
  praat: 'Praat 音标'
};

export const StatusBar: React.FC = () => {
  const tg = useEditorStore((s) => s.tg);
  const selection = useEditorStore((s) => s.selection);
  const hiddenTierIndices = useEditorStore((s) => s.hiddenTierIndices);
  const showAllTiers = useEditorStore((s) => s.showAllTiers);
  const ipaMode = useEditorStore((s) => s.ipaMode);
  const cycleIpaMode = useEditorStore((s) => s.cycleIpaMode);
  const setSidebarTab = useEditorStore((s) => s.setSidebarTab);
  const setSidebarOpen = useEditorStore((s) => s.setSidebarOpen);
  const setShortcutsOpen = useEditorStore((s) => s.setShortcutsOpen);
  const customShortcuts = useEditorStore((s) => s.customShortcuts);
  const canvasScale = useEditorStore((s) => s.canvasScale);
  const setCanvasScale = useEditorStore((s) => s.setCanvasScale);

  const ipaCycleHint = getEffectiveShortcutHint('ipa-cycle', customShortcuts);
  const shortcutsHint = getEffectiveShortcutHint('shortcuts-modal', customShortcuts);

  const diag = useMemo(() => scanQuickDiagnostics(tg), [tg]);

  const selectionSummary = useMemo(() => {
    if (selection?.kind === 'interval') {
      const tier = tg.tiers[selection.tierIndex];
      const iv = tier?.intervals[selection.itemIndex];
      if (tier && iv) {
        const n = selection.tierIndex + 1;
        const name = tier.name || '未命名';
        const dur = Math.max(0, iv.xmax - iv.xmin);
        return `第 ${n} 层「${name}」· #${selection.itemIndex + 1} · ${(dur * 1000).toFixed(1)} ms`;
      }
    } else if (selection?.kind === 'boundary') {
      const tier = tg.tiers[selection.tierIndex];
      if (tier) {
        const n = selection.tierIndex + 1;
        const name = tier.name || '未命名';
        return `第 ${n} 层「${name}」· 边界 ${selection.time.toFixed(3)} s`;
      }
    } else if (selection?.kind === 'point') {
      const tier = tg.tiers[selection.tierIndex];
      const pt = tier?.points[selection.itemIndex];
      if (tier && pt) {
        const n = selection.tierIndex + 1;
        const name = tier.name || '未命名';
        return `第 ${n} 层「${name}」· 标点 ${pt.number.toFixed(3)} s`;
      }
    } else if (selection?.kind === 'tier') {
      const tier = tg.tiers[selection.tierIndex];
      if (tier) {
        const n = selection.tierIndex + 1;
        const name = tier.name || '未命名';
        return `第 ${n} 层「${name}」`;
      }
    } else if (selection?.kind === 'spine') {
      return `对齐时间列 · ${selection.time.toFixed(3)} s`;
    }

    const dur = Math.max(
      0,
      (Number.isFinite(tg.xmax) ? tg.xmax : 0) - (Number.isFinite(tg.xmin) ? tg.xmin : 0)
    );
    return `共 ${tg.tiers.length} 层 · 总长 ${dur.toFixed(2)} s`;
  }, [tg, selection]);

  const diagTooltip = useMemo(() => {
    const parts: string[] = [];
    if (diag.gaps > 0) parts.push(`缝隙 ${diag.gaps}`);
    if (diag.overlaps > 0) parts.push(`重叠 ${diag.overlaps}`);
    if (diag.zeros > 0) parts.push(`零时长 ${diag.zeros}`);
    if (diag.micros > 0) parts.push(`<5ms 微段 ${diag.micros}`);
    return `${parts.join(' · ')} — 点击打开右侧诊断面板`;
  }, [diag]);

  const ipaClass =
    ipaMode === 'yunlong'
      ? 'status-ipa-pill is-yunlong'
      : ipaMode === 'praat'
        ? 'status-ipa-pill is-praat'
        : 'status-ipa-pill';

  return (
    <footer className="app-status-bar" aria-label="状态摘要栏">
      <div className="status-bar-left">
        <span className="status-seg mono" title={selectionSummary}>
          {selectionSummary}
        </span>

        {hiddenTierIndices.length > 0 && (
          <>
            <span className="status-sep" aria-hidden="true" />
            <button
              type="button"
              className="status-diag-pill"
              title="点击恢复显示所有隐藏层级"
              onClick={showAllTiers}
            >
              <UiIcon name="showTier" size={11} />
              <span>已隐藏 {hiddenTierIndices.length} 层 · 恢复</span>
            </button>
          </>
        )}
      </div>

      <div className="status-bar-right">
        {diag.total > 0 && (
          <button
            type="button"
            className="status-diag-pill"
            title={diagTooltip}
            onClick={() => {
              setSidebarTab('inspector');
              setSidebarOpen(true);
            }}
          >
            <UiIcon name="warning" size={11} />
            <span>{diag.total} 处异常</span>
          </button>
        )}

        <button
          type="button"
          className={ipaClass}
          title={
            ipaCycleHint
              ? `点击切换音标输入模式 (${ipaCycleHint})`
              : '点击切换音标输入模式'
          }
          onClick={cycleIpaMode}
        >
          <UiIcon name="ipaMode" size={11} />
          <span>{IPA_LABELS[ipaMode]}</span>
        </button>

        <div className="status-zoom-group" role="group" aria-label="画布缩放">
          <button
            type="button"
            className="status-zoom-btn"
            disabled={canvasScale <= CANVAS_SCALE_MIN + 0.001}
            title="缩小画布（50%–200%，Ctrl+- 或 Ctrl+滚轮）"
            aria-label="缩小画布"
            onClick={() => setCanvasScale(stepCanvasScale(canvasScale, -1))}
          >
            −
          </button>
          <button
            type="button"
            className={`status-zoom-val ${canvasScale !== 1 ? 'is-scaled' : ''}`}
            title={
              canvasScale === 1
                ? '画布缩放 100%（Ctrl+滚轮缩放，Ctrl+0 复原，不影响界面与导出尺寸）'
                : '点击或按 Ctrl+0 一键复原画布缩放为 100%'
            }
            onClick={() => setCanvasScale(1)}
          >
            {Math.round(canvasScale * 100)}%
          </button>
          <button
            type="button"
            className="status-zoom-btn"
            disabled={canvasScale >= CANVAS_SCALE_MAX - 0.001}
            title="放大画布（50%–200%，Ctrl+= 或 Ctrl+滚轮）"
            aria-label="放大画布"
            onClick={() => setCanvasScale(stepCanvasScale(canvasScale, 1))}
          >
            +
          </button>
        </div>

        <button
          type="button"
          className="status-help-btn"
          style={{ width: 'auto', padding: '0 6px', gap: 4 }}
          title={
            shortcutsHint
              ? `打开快捷键与交互速查表 (${shortcutsHint})`
              : '打开快捷键与交互速查表'
          }
          onClick={() => setShortcutsOpen(true)}
        >
          <UiIcon name="shortcuts" size={11} />
          <span>{shortcutsHint ? `${shortcutsHint} 快捷键` : '快捷键'}</span>
        </button>
      </div>
    </footer>
  );
};
