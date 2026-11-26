import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentEntryId, type HistoryEntry } from '../../store/historyModel';
import { useEditorStore } from '../../store/useEditorStore';
import { UiIcon } from '../Icons';

function formatClockTime(ts: number): string {
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return '';
  }
}

export const HistoryPanel: React.FC = () => {
  const history = useEditorStore((s) => s.history);
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const jumpToHistory = useEditorStore((s) => s.jumpToHistory);
  const jumpToSavedPoint = useEditorStore((s) => s.jumpToSavedPoint);
  const clearHistoryToCurrent = useEditorStore((s) => s.clearHistoryToCurrent);
  const showToast = useEditorStore((s) => s.showToast);

  const isReadOnly = mode === 'read';
  const { baseline, entries, cursor, savedEntryId, prunedCount, maxEntries } = history;
  const currentEntryId = getCurrentEntryId(history);
  const canUndo = cursor >= 0;
  const canRedo = cursor < entries.length - 1;
  const futureCount = Math.max(0, entries.length - 1 - cursor);
  const canJumpSaved = savedEntryId !== null && currentEntryId !== savedEntryId;
  const isBaselineCurrent = cursor === -1;
  const isBaselineSaved = savedEntryId === baseline.id;

  const [hoverCursor, setHoverCursor] = useState<number | null>(null);
  const [kbdCursor, setKbdCursor] = useState<number>(() => cursor);
  const [confirmClear, setConfirmClear] = useState(false);

  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setKbdCursor(cursor);
    setConfirmClear(false);
    const raf = requestAnimationFrame(() => {
      const el = timelineRef.current?.querySelector<HTMLElement>('[data-hist-current="true"]');
      el?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [cursor, entries.length]);

  useEffect(() => {
    if (isReadOnly) {
      setConfirmClear(false);
    }
  }, [isReadOnly]);

  const notifyReadOnlyBlock = useCallback(() => {
    showToast('当前为只读模式，切至编辑模式后可回退历史（按 E 切换）', false, {
      label: '切至编辑',
      onClick: () => setMode('edit')
    });
  }, [setMode, showToast]);

  const handleSelectCursor = useCallback(
    (targetCursor: number) => {
      if (isReadOnly) {
        notifyReadOnlyBlock();
        return;
      }
      setConfirmClear(false);
      setKbdCursor(targetCursor);
      if (targetCursor !== cursor) {
        jumpToHistory(targetCursor);
      }
    },
    [cursor, isReadOnly, jumpToHistory, notifyReadOnlyBlock]
  );

  const handleTimelineKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      let next = kbdCursor;
      if (e.key === 'ArrowDown') {
        next = Math.min(entries.length - 1, kbdCursor + 1);
      } else if (e.key === 'ArrowUp') {
        next = Math.max(-1, kbdCursor - 1);
      } else if (e.key === 'Home') {
        next = -1;
      } else if (e.key === 'End') {
        next = entries.length - 1;
      }
      setKbdCursor(next);
      const opt = timelineRef.current?.querySelector<HTMLElement>(`[data-hist-cursor="${next}"]`);
      opt?.scrollIntoView({ block: 'nearest' });
      return;
    }

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      handleSelectCursor(kbdCursor);
    }
  };

  const getOptionTooltip = useCallback(
    (targetCursor: number, entry?: HistoryEntry): string => {
      const timeSuffix = entry ? ` · ${formatClockTime(entry.timestamp)}` : ` · ${formatClockTime(baseline.timestamp)}`;
      if (isReadOnly) {
        return targetCursor === cursor
          ? `当前状态${timeSuffix}（只读模式）`
          : `当前为只读模式，切至编辑模式后可回退历史${timeSuffix}`;
      }
      if (targetCursor === cursor) {
        return targetCursor === -1 ? `当前位于初始快照${timeSuffix}` : `当前状态${timeSuffix}`;
      }
      if (targetCursor < cursor) {
        const steps = cursor - targetCursor;
        return targetCursor === -1
          ? `点击回退 ${steps} 步回到初始快照${timeSuffix}`
          : `点击回退 ${steps} 步到此状态${timeSuffix}`;
      }
      const steps = targetCursor - cursor;
      return `点击重做 ${steps} 步到此状态${timeSuffix}`;
    },
    [baseline.timestamp, cursor, isReadOnly]
  );

  const activeDescendantId = useMemo(
    () => (kbdCursor === -1 ? 'hist-opt-baseline' : `hist-opt-${kbdCursor}`),
    [kbdCursor]
  );

  return (
    <div className="hist-root">
      {isReadOnly && (
        <div className="sb-readonly-banner" role="status">
          <span className="sb-readonly-text">只读模式：可查阅操作历史</span>
          <button
            type="button"
            className="compact sb-readonly-btn"
            onClick={() => setMode('edit')}
          >
            切换至编辑
          </button>
        </div>
      )}

      {futureCount > 0 && (
        <div className="hist-branch-banner" role="status">
          <UiIcon name="warning" size={12} />
          <span>历史回溯态：继续编辑将覆盖后续 {futureCount} 步</span>
        </div>
      )}

      <div
        ref={timelineRef}
        className="hist-timeline-wrap"
        role="listbox"
        tabIndex={0}
        aria-label="操作历史记录时间线"
        aria-activedescendant={activeDescendantId}
        onKeyDown={handleTimelineKeyDown}
        onMouseLeave={() => setHoverCursor(null)}
      >
        {/* Pinned Initial Baseline Snapshot */}
        <div className="hist-baseline-pin">
          <div className="hist-pin-label">初始快照</div>
          <div
            id="hist-opt-baseline"
            role="option"
            aria-selected={isBaselineCurrent}
            data-hist-cursor={-1}
            data-hist-current={isBaselineCurrent ? 'true' : undefined}
            className={[
              'hist-item',
              'is-baseline',
              isBaselineCurrent ? 'is-current' : 'is-past',
              kbdCursor === -1 ? 'is-kbd-focus' : '',
              hoverCursor === -1 && cursor >= 0 ? 'is-preview-target' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            title={getOptionTooltip(-1)}
            onMouseEnter={() => setHoverCursor(-1)}
            onClick={() => handleSelectCursor(-1)}
          >
            <span className="hist-item-icon" aria-hidden="true">
              <UiIcon name={baseline.icon} size={13} />
            </span>
            <div className="hist-item-body">
              <div className="hist-item-top">
                <span className="hist-item-title">{baseline.title}</span>
                <div className="hist-item-badges">
                  {isBaselineSaved ? (
                    <span className="hist-badge is-saved" title="与磁盘或最近一次保存一致">
                      <UiIcon name="save" size={10} />
                      <span>已存</span>
                    </span>
                  ) : (
                    <span className="hist-badge is-init">初始</span>
                  )}
                </div>
              </div>
              <div className="hist-item-detail" title={baseline.detail}>
                {baseline.detail}
              </div>
            </div>
          </div>
        </div>

        {/* Scrollable History Entries */}
        <div className="hist-scroll-list">
          {prunedCount > 0 && (
            <div
              className="hist-pruned-strip"
              title={`为控制内存占用，最早的 ${prunedCount} 步已超出当前 ${maxEntries} 步上限并被折叠`}
            >
              已折叠 {prunedCount} 步更早记录（上限 {maxEntries} 步）
            </div>
          )}

          {entries.length === 0 ? (
            <div className="hist-empty-note">
              暂无后续编辑记录 — 修改标注、切分或调整边界后，每步历史将按时间顺序排列于此。
            </div>
          ) : (
            entries.map((entry, idx) => {
              const isCurrent = idx === cursor;
              const isPast = idx < cursor;
              const isFuture = idx > cursor;
              const isSaved = savedEntryId === entry.id;
              const isPreviewUndo =
                hoverCursor !== null && hoverCursor < cursor && idx > hoverCursor && idx <= cursor;
              const isPreviewRedo =
                hoverCursor !== null && hoverCursor > cursor && idx > cursor && idx <= hoverCursor;
              const isPreviewTarget = hoverCursor === idx && idx !== cursor;

              const rowClasses = [
                'hist-item',
                isCurrent ? 'is-current' : isPast ? 'is-past' : 'is-future',
                kbdCursor === idx ? 'is-kbd-focus' : '',
                isPreviewUndo ? 'is-preview-undo' : '',
                isPreviewRedo ? 'is-preview-redo' : '',
                isPreviewTarget ? 'is-preview-target' : ''
              ]
                .filter(Boolean)
                .join(' ');

              const stepText = `#${String(entry.stepNumber).padStart(2, '0')}`;

              return (
                <div
                  key={entry.id}
                  id={`hist-opt-${idx}`}
                  role="option"
                  aria-selected={isCurrent}
                  data-hist-cursor={idx}
                  data-hist-current={isCurrent ? 'true' : undefined}
                  className={rowClasses}
                  title={getOptionTooltip(idx, entry)}
                  onMouseEnter={() => setHoverCursor(idx)}
                  onClick={() => handleSelectCursor(idx)}
                >
                  <span className="hist-item-seq">{stepText}</span>
                  <span className="hist-item-icon" aria-hidden="true">
                    <UiIcon name={entry.meta.icon} size={13} />
                  </span>
                  <div className="hist-item-body">
                    <div className="hist-item-top">
                      <span className="hist-item-title">{entry.meta.title}</span>
                      {(isSaved || isCurrent) && (
                        <div className="hist-item-badges">
                          {isSaved && (
                            <span className="hist-badge is-saved" title="与最近一次保存状态一致">
                              <UiIcon name="save" size={10} />
                              <span>已存</span>
                            </span>
                          )}
                          {isCurrent && <span className="hist-badge is-curr">当前</span>}
                        </div>
                      )}
                    </div>
                    {entry.meta.detail && (
                      <div className="hist-item-detail" title={entry.meta.detail}>
                        {entry.meta.detail}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Fixed Bottom Action Bar */}
      <div className="hist-footer">
        {confirmClear ? (
          <div className="hist-confirm-bar" role="alert">
            <span className="hist-confirm-text">确认清空历史？当前状态将重置为新基线</span>
            <div className="hist-confirm-actions">
              <button
                type="button"
                className="compact danger"
                onClick={() => {
                  if (isReadOnly) {
                    notifyReadOnlyBlock();
                    return;
                  }
                  setConfirmClear(false);
                  clearHistoryToCurrent();
                }}
              >
                确认
              </button>
              <button
                type="button"
                className="compact"
                onClick={() => setConfirmClear(false)}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="hist-footer-actions">
            <div className="hist-footer-group">
              <button
                type="button"
                className="compact hist-foot-btn"
                disabled={!canUndo}
                title={
                  !canUndo
                    ? '暂无可撤销操作'
                    : isReadOnly
                      ? '只读模式不可回退，点击切换至编辑模式'
                      : '撤销上一步 (Ctrl+Z)'
                }
                onClick={() => {
                  if (isReadOnly) {
                    notifyReadOnlyBlock();
                    return;
                  }
                  undo();
                }}
              >
                <UiIcon name="undo" size={12} />
                <span>撤销</span>
              </button>
              <button
                type="button"
                className="compact hist-foot-btn"
                disabled={!canRedo}
                title={
                  !canRedo
                    ? '暂无可重做操作'
                    : isReadOnly
                      ? '只读模式不可重做，点击切换至编辑模式'
                      : '重做下一步 (Ctrl+Y)'
                }
                onClick={() => {
                  if (isReadOnly) {
                    notifyReadOnlyBlock();
                    return;
                  }
                  redo();
                }}
              >
                <UiIcon name="redo" size={12} />
                <span>重做</span>
              </button>
            </div>

            <div className="hist-footer-group">
              <button
                type="button"
                className="compact hist-foot-btn"
                disabled={!canJumpSaved}
                title={
                  savedEntryId === null
                    ? '保存锚点已不在当前历史时间线上'
                    : !canJumpSaved
                      ? '当前已处于最近一次保存状态'
                      : isReadOnly
                        ? '只读模式不可跳转至保存点'
                        : '恢复至最近一次保存状态（保留可重做步骤）'
                }
                onClick={() => {
                  if (isReadOnly) {
                    notifyReadOnlyBlock();
                    return;
                  }
                  jumpToSavedPoint();
                }}
              >
                <UiIcon name="save" size={12} />
                <span className="hist-foot-label-save">回保存点</span>
              </button>
              <button
                type="button"
                className="compact danger hist-foot-btn hist-foot-btn-icon"
                disabled={entries.length === 0}
                title={
                  entries.length === 0
                    ? '暂无可清空的历史记录'
                    : isReadOnly
                      ? '只读模式不可清空历史'
                      : '清空操作历史（以当前状态重置基线）'
                }
                aria-label="清空历史"
                onClick={() => {
                  if (isReadOnly) {
                    notifyReadOnlyBlock();
                    return;
                  }
                  setConfirmClear(true);
                }}
              >
                <UiIcon name="trash" size={12} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
