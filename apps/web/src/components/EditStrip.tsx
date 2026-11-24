import React, { useEffect, useState } from 'react';
import { useEditorStore } from '../store/useEditorStore';
import { formatPraatDouble } from '../layout/richText';
import { UiIcon } from './Icons';

export const EditStrip: React.FC = () => {
  const mode = useEditorStore((s) => s.mode);
  const tg = useEditorStore((s) => s.tg);
  const undoStackLen = useEditorStore((s) => s.undoStack.length);
  const redoStackLen = useEditorStore((s) => s.redoStack.length);
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

  useEffect(() => {
    setMinText(formatPraatDouble(tg.xmin));
    setMaxText(formatPraatDouble(tg.xmax));
  }, [tg.xmin, tg.xmax]);

  const commitGlobalMin = () => {
    const val = parseFloat(minText);
    if (!Number.isFinite(val) || val > tg.xmax) {
      showToast('全局起点不能大于终点', true);
      setMinText(formatPraatDouble(tg.xmin));
      return;
    }
    if (val !== tg.xmin) {
      commitTgMutation((draft) => {
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
      });
    }
  };

  const commitGlobalMax = () => {
    const val = parseFloat(maxText);
    if (!Number.isFinite(val) || val < tg.xmin) {
      showToast('全局终点不能小于起点', true);
      setMaxText(formatPraatDouble(tg.xmax));
      return;
    }
    if (val !== tg.xmax) {
      commitTgMutation((draft) => {
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
      });
    }
  };

  return (
    <div className={`edit-strip-wrap ${mode === 'edit' ? 'visible' : ''}`}>
      <div className="edit-strip">
        <div className="bar-group">
          <button
            type="button"
            className="compact"
            title="撤销 (Ctrl+Z)"
            disabled={undoStackLen === 0}
            onClick={undo}
          >
            <UiIcon name="undo" size={13} />
            <span>撤销</span>
          </button>
          <button
            type="button"
            className="compact"
            title="重做 (Ctrl+Y)"
            disabled={redoStackLen === 0}
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
                if (e.key === 'Enter') {
                  e.preventDefault();
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
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </label>

          <div className="sep" />
          <div
            className="segmented ipa-ctrl-noblur"
            role="group"
            title="国际音标输入方案 (Ctrl+\ 或 Alt+I 切换)"
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
            title="打开 / 关闭交互式国际音标虚拟键盘"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setIpaDockOpen(!ipaDockOpen)}
          >
            <UiIcon name="keyboard" size={13} />
            <span>音标盘</span>
          </button>
        </div>

        <span className="hint-text">
          方向键跨格/跨层 · Enter/双击改字 · Tab 连编 · Ctrl+\ 切音标 · Shift+点击切分
        </span>
      </div>
    </div>
  );
};
