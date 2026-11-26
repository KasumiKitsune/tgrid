import React, { useEffect, useRef, useState } from 'react';
import { formatPraatDouble } from '../layout/richText';
import {
  IS_MAC,
  formatKeyCombo,
  getEffectiveShortcutHint,
  isComposingEvent
} from '../shortcuts/registry';
import {
  canRedoTimeline,
  canUndoTimeline,
  getLatestRedoEntry,
  getLatestUndoEntry
} from '../store/historyModel';
import { useEditorStore } from '../store/useEditorStore';
import { UiIcon } from './Icons';

export const EditStrip: React.FC = () => {
  const mode = useEditorStore((s) => s.mode);
  const tg = useEditorStore((s) => s.tg);
  const history = useEditorStore((s) => s.history);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const sidebarOpen = useEditorStore((s) => s.sidebarOpen);
  const sidebarTab = useEditorStore((s) => s.sidebarTab);
  const toggleSidebarTab = useEditorStore((s) => s.toggleSidebarTab);
  const insertTierAt = useEditorStore((s) => s.insertTierAt);
  const normalizeTextGrid = useEditorStore((s) => s.normalizeTextGrid);
  const commitTgMutation = useEditorStore((s) => s.commitTgMutation);
  const showToast = useEditorStore((s) => s.showToast);
  const ipaMode = useEditorStore((s) => s.ipaMode);
  const setIpaMode = useEditorStore((s) => s.setIpaMode);
  const ipaDockOpen = useEditorStore((s) => s.ipaDockOpen);
  const setIpaDockOpen = useEditorStore((s) => s.setIpaDockOpen);
  const customShortcuts = useEditorStore((s) => s.customShortcuts);

  const ipaCycleHint = getEffectiveShortcutHint('ipa-cycle', customShortcuts);
  const ipaTempEnHint = getEffectiveShortcutHint('ipa-temp-en', customShortcuts);
  const ipaDockHint = getEffectiveShortcutHint('ipa-dock-toggle', customShortcuts);
  const tapSplitHint = getEffectiveShortcutHint('tap-split-playhead', customShortcuts);
  const shortcutsHint = getEffectiveShortcutHint('shortcuts-modal', customShortcuts);

  const [minText, setMinText] = useState(formatPraatDouble(tg.xmin));
  const [maxText, setMaxText] = useState(formatPraatDouble(tg.xmax));
  const skipMinBlurRef = useRef(false);
  const skipMaxBlurRef = useRef(false);

  useEffect(() => {
    setMinText(formatPraatDouble(tg.xmin));
    setMaxText(formatPraatDouble(tg.xmax));
  }, [tg.xmin, tg.xmax]);

  const canUndo = canUndoTimeline(history);
  const canRedo = canRedoTimeline(history);
  const undoEntry = getLatestUndoEntry(history);
  const redoEntry = getLatestRedoEntry(history);
  const undoShortcut = formatKeyCombo('Mod+Z');
  const redoShortcut = formatKeyCombo(IS_MAC ? 'Mod+Shift+Z' : 'Mod+Y');
  const undoTitle = undoEntry
    ? `撤销：${undoEntry.meta.title}${undoEntry.meta.detail ? ` (${undoEntry.meta.detail})` : ''} (${undoShortcut})`
    : `撤销 (${undoShortcut})`;
  const redoTitle = redoEntry
    ? `重做：${redoEntry.meta.title}${redoEntry.meta.detail ? ` (${redoEntry.meta.detail})` : ''} (${redoShortcut})`
    : `重做 (${redoShortcut})`;
  const histCountLabel =
    history.cursor < history.entries.length - 1
      ? `${history.cursor + 1}/${history.entries.length}`
      : String(history.entries.length);

  const commitGlobalMin = () => {
    if (skipMinBlurRef.current) {
      skipMinBlurRef.current = false;
      return;
    }
    const val = parseFloat(minText);
    if (!Number.isFinite(val) || val >= tg.xmax) {
      showToast('全局起点必须严格小于终点', true);
      setMinText(formatPraatDouble(tg.xmin));
      return;
    }
    if (val !== tg.xmin) {
      const oldMin = tg.xmin;
      commitTgMutation(
        (draft, ctx) => {
          draft.xmin = val;
          for (let ti = 0; ti < draft.tiers.length; ti++) {
            const origTier = draft.tiers[ti];
            const touchesBound = origTier.xmin === oldMin;
            const touchesFirstIv =
              origTier.kind === 'intervalTier' &&
              origTier.intervals.length > 0 &&
              origTier.intervals[0].xmin === oldMin &&
              origTier.intervals[0].xmax > val;
            if (!touchesBound && !touchesFirstIv) continue;
            const dTier = ctx.editTier(ti);
            if (!dTier) continue;
            if (dTier.xmin === oldMin) dTier.xmin = val;
            if (
              dTier.kind === 'intervalTier' &&
              dTier.intervals.length > 0 &&
              dTier.intervals[0].xmin === oldMin &&
              dTier.intervals[0].xmax > val
            ) {
              dTier.intervals[0].xmin = val;
            }
          }
        },
        undefined,
        {
          type: 'edit-global-bounds',
          title: '修改全局起点',
          detail: `起点 ${oldMin.toFixed(3)}s → ${val.toFixed(3)}s`,
          icon: 'copyTime',
          focusTime: val
        }
      );
    }
  };

  const commitGlobalMax = () => {
    if (skipMaxBlurRef.current) {
      skipMaxBlurRef.current = false;
      return;
    }
    const val = parseFloat(maxText);
    if (!Number.isFinite(val) || val <= tg.xmin) {
      showToast('全局终点必须严格大于起点', true);
      setMaxText(formatPraatDouble(tg.xmax));
      return;
    }
    if (val !== tg.xmax) {
      const oldMax = tg.xmax;
      commitTgMutation(
        (draft, ctx) => {
          draft.xmax = val;
          for (let ti = 0; ti < draft.tiers.length; ti++) {
            const origTier = draft.tiers[ti];
            const touchesBound = origTier.xmax === oldMax;
            const lastOrig =
              origTier.kind === 'intervalTier' && origTier.intervals.length > 0
                ? origTier.intervals[origTier.intervals.length - 1]
                : null;
            const touchesLastIv = Boolean(
              lastOrig && lastOrig.xmax === oldMax && lastOrig.xmin < val
            );
            if (!touchesBound && !touchesLastIv) continue;
            const dTier = ctx.editTier(ti);
            if (!dTier) continue;
            if (dTier.xmax === oldMax) dTier.xmax = val;
            if (dTier.kind === 'intervalTier' && dTier.intervals.length > 0) {
              const last = dTier.intervals[dTier.intervals.length - 1];
              if (last.xmax === oldMax && last.xmin < val) {
                last.xmax = val;
              }
            }
          }
        },
        undefined,
        {
          type: 'edit-global-bounds',
          title: '修改全局终点',
          detail: `终点 ${oldMax.toFixed(3)}s → ${val.toFixed(3)}s`,
          icon: 'copyTime',
          focusTime: val
        }
      );
    }
  };

  return (
    <div className={`edit-strip-wrap ${mode === 'edit' ? 'visible' : ''}`}>
      <div className="edit-strip">
        <div className="bar-group">
          <button
            type="button"
            className="compact"
            title={undoTitle}
            disabled={!canUndo}
            onClick={undo}
          >
            <UiIcon name="undo" size={13} />
            <span>撤销</span>
          </button>
          <button
            type="button"
            className="compact"
            title={redoTitle}
            disabled={!canRedo}
            onClick={redo}
          >
            <UiIcon name="redo" size={13} />
            <span>重做</span>
          </button>
          <button
            type="button"
            className={`compact edit-hist-btn ${sidebarOpen && sidebarTab === 'history' ? 'active' : ''}`}
            title="打开 / 收起操作历史面板 (Alt+3)"
            aria-pressed={sidebarOpen && sidebarTab === 'history'}
            onClick={() => toggleSidebarTab('history')}
          >
            <UiIcon name="history" size={13} />
            <span className="edit-hist-count">{histCountLabel}</span>
          </button>

          <div className="sep" />
          <button
            type="button"
            className="compact"
            onClick={() => insertTierAt(tg.tiers.length, 'intervalTier')}
          >
            <UiIcon name="addIntervalTier" size={13} />
            <span>+ 区间层</span>
          </button>
          <button
            type="button"
            className="compact"
            onClick={() => insertTierAt(tg.tiers.length, 'textTier')}
          >
            <UiIcon name="addPointTier" size={13} />
            <span>+ 点层</span>
          </button>
          <button
            type="button"
            className="compact"
            title="补齐缝隙并统一各层起止时间"
            onClick={normalizeTextGrid}
          >
            <UiIcon name="normalize" size={13} />
            <span>整理边界</span>
          </button>

          <div className="sep" />
          <label className="field-inline">
            起点
            <input
              type="number"
              step="any"
              value={minText}
              onChange={(e) => setMinText(e.target.value)}
              onBlur={commitGlobalMin}
              onKeyDown={(e) => {
                if (isComposingEvent(e)) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  skipMinBlurRef.current = true;
                  setMinText(formatPraatDouble(tg.xmin));
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </label>
          <label className="field-inline">
            终点
            <input
              type="number"
              step="any"
              value={maxText}
              onChange={(e) => setMaxText(e.target.value)}
              onBlur={commitGlobalMax}
              onKeyDown={(e) => {
                if (isComposingEvent(e)) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  skipMaxBlurRef.current = true;
                  setMaxText(formatPraatDouble(tg.xmax));
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </label>

          <div className="sep" />
          <div
            className="segmented ipa-ctrl-noblur"
            role="group"
            title={
              ipaCycleHint
                ? `国际音标输入方案 (${ipaCycleHint} 切换；不影响画布与属性栏显示已有 \\xx 转义对照)`
                : '国际音标输入方案（不影响画布与属性栏显示已有 \\xx 转义对照）'
            }
            onMouseDown={(e) => e.preventDefault()}
          >
            <button
              type="button"
              className={`compact ${ipaMode === 'off' ? 'active' : ''}`}
              title="关闭音标键盘输入（文本中已有的 Praat \\xx 转义仍会显示对照）"
              onClick={() => setIpaMode('off')}
            >
              关闭
            </button>
            <button
              type="button"
              className={`compact ${ipaMode === 'yunlong' ? 'active' : ''}`}
              title={
                ipaTempEnHint
                  ? `云龙国际音标输入方案 (${ipaTempEnHint} 临时切英文)`
                  : '云龙国际音标输入方案'
              }
              onClick={() => setIpaMode('yunlong')}
            >
              云龙
            </button>
            <button
              type="button"
              className={`compact ${ipaMode === 'praat' ? 'active' : ''}`}
              title={
                ipaTempEnHint
                  ? `Praat 音标转义输入（即时转 Unicode IPA，${ipaTempEnHint} 临时切英文）`
                  : 'Praat 音标转义输入（即时转 Unicode IPA）'
              }
              onClick={() => setIpaMode('praat')}
            >
              Praat
            </button>
          </div>

          <button
            type="button"
            className={`compact ipa-ctrl-noblur ${ipaDockOpen ? 'active' : ''}`}
            title={
              ipaDockHint
                ? `打开 / 关闭交互式国际音标虚拟键盘 (${ipaDockHint})`
                : '打开 / 关闭交互式国际音标虚拟键盘'
            }
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setIpaDockOpen(!ipaDockOpen)}
          >
            <UiIcon name="keyboard" size={13} />
            <span>音标盘</span>
          </button>
        </div>

        <span className="hint-text">
          {[
            '拖拽划建/平移',
            '悬停自动磁吸',
            tapSplitHint ? `${tapSplitHint} 播头切分` : null,
            shortcutsHint ? `${shortcutsHint} 快捷键` : null
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
    </div>
  );
};
