import React, { useEffect, useRef, useState } from 'react';
import { formatPraatDouble } from '../layout/richText';
import { IS_MAC, formatKeyCombo, isComposingEvent } from '../shortcuts/registry';
import {
  getLatestRedoLabel,
  getLatestUndoLabel,
  useEditorStore
} from '../store/useEditorStore';
import { UiIcon } from './Icons';

export const EditStrip: React.FC = () => {
  const mode = useEditorStore((s) => s.mode);
  const tg = useEditorStore((s) => s.tg);
  const undoStack = useEditorStore((s) => s.undoStack);
  const redoStack = useEditorStore((s) => s.redoStack);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const insertTierAt = useEditorStore((s) => s.insertTierAt);
  const normalizeTextGrid = useEditorStore((s) => s.normalizeTextGrid);
  const commitTgMutation = useEditorStore((s) => s.commitTgMutation);
  const showToast = useEditorStore((s) => s.showToast);
  const ipaMode = useEditorStore((s) => s.ipaMode);
  const setIpaMode = useEditorStore((s) => s.setIpaMode);
  const ipaDockOpen = useEditorStore((s) => s.ipaDockOpen);
  const setIpaDockOpen = useEditorStore((s) => s.setIpaDockOpen);

  const [minText, setMinText] = useState(formatPraatDouble(tg.xmin));
  const [maxText, setMaxText] = useState(formatPraatDouble(tg.xmax));
  const skipMinBlurRef = useRef(false);
  const skipMaxBlurRef = useRef(false);

  useEffect(() => {
    setMinText(formatPraatDouble(tg.xmin));
    setMaxText(formatPraatDouble(tg.xmax));
  }, [tg.xmin, tg.xmax]);

  const undoLabel = getLatestUndoLabel(undoStack);
  const redoLabel = getLatestRedoLabel(redoStack);
  const undoShortcut = formatKeyCombo('Mod+Z');
  const redoShortcut = formatKeyCombo(IS_MAC ? 'Mod+Shift+Z' : 'Mod+Y');
  const undoTitle = undoLabel ? `撤销：${undoLabel} (${undoShortcut})` : `撤销 (${undoShortcut})`;
  const redoTitle = redoLabel ? `重做：${redoLabel} (${redoShortcut})` : `重做 (${redoShortcut})`;

  const commitGlobalMin = () => {
    if (skipMinBlurRef.current) {
      skipMinBlurRef.current = false;
      return;
    }
    const val = parseFloat(minText);
    if (!Number.isFinite(val) || val > tg.xmax) {
      showToast('全局起点不能大于终点', true);
      setMinText(formatPraatDouble(tg.xmin));
      return;
    }
    if (val !== tg.xmin) {
      commitTgMutation(
        (draft) => {
          const oldMin = draft.xmin;
          draft.xmin = val;
          for (const t of draft.tiers) {
            if (t.xmin === oldMin) t.xmin = val;
            if (
              t.kind === 'intervalTier' &&
              t.intervals.length > 0 &&
              t.intervals[0].xmin === oldMin &&
              t.intervals[0].xmax >= val
            ) {
              t.intervals[0].xmin = val;
            }
          }
        },
        undefined,
        '修改全局起点'
      );
    }
  };

  const commitGlobalMax = () => {
    if (skipMaxBlurRef.current) {
      skipMaxBlurRef.current = false;
      return;
    }
    const val = parseFloat(maxText);
    if (!Number.isFinite(val) || val < tg.xmin) {
      showToast('全局终点不能小于起点', true);
      setMaxText(formatPraatDouble(tg.xmax));
      return;
    }
    if (val !== tg.xmax) {
      commitTgMutation(
        (draft) => {
          const oldMax = draft.xmax;
          draft.xmax = val;
          for (const t of draft.tiers) {
            if (t.xmax === oldMax) t.xmax = val;
            if (t.kind === 'intervalTier' && t.intervals.length > 0) {
              const last = t.intervals[t.intervals.length - 1];
              if (last.xmax === oldMax && last.xmin <= val) {
                last.xmax = val;
              }
            }
          }
        },
        undefined,
        '修改全局终点'
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
            disabled={undoStack.length === 0}
            onClick={undo}
          >
            <UiIcon name="undo" size={13} />
            <span>撤销</span>
          </button>
          <button
            type="button"
            className="compact"
            title={redoTitle}
            disabled={redoStack.length === 0}
            onClick={redo}
          >
            <UiIcon name="redo" size={13} />
            <span>重做</span>
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
            title={`国际音标输入方案 (${formatKeyCombo('Mod+\\')} 或 Alt+I 切换)`}
            onMouseDown={(e) => e.preventDefault()}
          >
            <button
              type="button"
              className={`compact ${ipaMode === 'off' ? 'active' : ''}`}
              title="关闭音标输入"
              onClick={() => setIpaMode('off')}
            >
              关闭
            </button>
            <button
              type="button"
              className={`compact ${ipaMode === 'yunlong' ? 'active' : ''}`}
              title="云龙国际音标输入方案 (按 Shift 临时切英文)"
              onClick={() => setIpaMode('yunlong')}
            >
              云龙
            </button>
            <button
              type="button"
              className={`compact ${ipaMode === 'praat' ? 'active' : ''}`}
              title="Praat 反斜杠三字符 (\xx 即时转 Unicode IPA)"
              onClick={() => setIpaMode('praat')}
            >
              \xx
            </button>
          </div>

          <button
            type="button"
            className={`compact ipa-ctrl-noblur ${ipaDockOpen ? 'active' : ''}`}
            title="打开 / 关闭交互式国际音标虚拟键盘 (Alt+K)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setIpaDockOpen(!ipaDockOpen)}
          >
            <UiIcon name="keyboard" size={13} />
            <span>音标盘</span>
          </button>
        </div>

        <span className="hint-text">
          拖拽划建/平移 · 悬停自动磁吸 · B 播头切分 · ? 快捷键
        </span>
      </div>
    </div>
  );
};
