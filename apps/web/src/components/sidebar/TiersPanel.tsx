import React, { useEffect, useRef, useState } from 'react';
import { isComposingEvent } from '../../shortcuts/registry';
import { useEditorStore } from '../../store/useEditorStore';
import { CloseIcon, UiIcon } from '../Icons';
import { CollapsibleSection } from './CollapsibleSection';

const DragGripIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
    <circle cx="4" cy="2.5" r="0.95" />
    <circle cx="8" cy="2.5" r="0.95" />
    <circle cx="4" cy="6" r="0.95" />
    <circle cx="8" cy="6" r="0.95" />
    <circle cx="4" cy="9.5" r="0.95" />
    <circle cx="8" cy="9.5" r="0.95" />
  </svg>
);

const EyeIcon: React.FC<{ hidden?: boolean; size?: number }> = ({ hidden = false, size = 13 }) => (
  <svg
    className="ui-icon"
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M1.8 8 C3.4 4.9 5.5 3.6 8 3.6 C10.5 3.6 12.6 4.9 14.2 8 C12.6 11.1 10.5 12.4 8 12.4 C5.5 12.4 3.4 11.1 1.8 8 Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
    <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.3" />
    {hidden && (
      <path
        d="M2.6 13.4 L13.4 2.6"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
      />
    )}
  </svg>
);

export const TiersPanel: React.FC = () => {
  const tg = useEditorStore((s) => s.tg);
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const isReadOnly = mode === 'read';
  const selection = useEditorStore((s) => s.selection);
  const setSelection = useEditorStore((s) => s.setSelection);
  const hiddenTierIndices = useEditorStore((s) => s.hiddenTierIndices);
  const toggleTierVisibility = useEditorStore((s) => s.toggleTierVisibility);
  const soloTier = useEditorStore((s) => s.soloTier);
  const showAllTiers = useEditorStore((s) => s.showAllTiers);
  const insertTierAt = useEditorStore((s) => s.insertTierAt);
  const duplicateTier = useEditorStore((s) => s.duplicateTier);
  const derivePointTierFromIntervals = useEditorStore((s) => s.derivePointTierFromIntervals);
  const moveTier = useEditorStore((s) => s.moveTier);
  const reorderTier = useEditorStore((s) => s.reorderTier);
  const removeTierWithUndoToast = useEditorStore((s) => s.removeTierWithUndoToast);
  const commitTgMutation = useEditorStore((s) => s.commitTgMutation);

  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const cancelRenameRef = useRef(false);

  const [dragFromIdx, setDragFromIdx] = useState<number | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ idx: number; pos: 'top' | 'bottom' } | null>(
    null
  );

  useEffect(() => {
    if (isReadOnly && editingIdx !== null) {
      setEditingIdx(null);
    }
  }, [isReadOnly, editingIdx]);

  useEffect(() => {
    if (editingIdx !== null) {
      requestAnimationFrame(() => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      });
    }
  }, [editingIdx]);

  const startRename = (idx: number, currentName: string) => {
    if (isReadOnly) return;
    cancelRenameRef.current = false;
    setEditingIdx(idx);
    setNameDraft(currentName);
  };

  const commitRename = (idx: number) => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      setEditingIdx(null);
      return;
    }
    const tier = tg.tiers[idx];
    setEditingIdx(null);
    if (isReadOnly || !tier || nameDraft === tier.name) return;
    const nextName = nameDraft;
    commitTgMutation(
      (draft) => {
        if (draft.tiers[idx]) draft.tiers[idx].name = nextName;
      },
      undefined,
      `重命名层级「${nextName || '未命名'}」`
    );
  };

  const selectedTierIndex =
    selection &&
    (selection.kind === 'tier' ||
      selection.kind === 'interval' ||
      selection.kind === 'point' ||
      selection.kind === 'boundary')
      ? selection.tierIndex
      : -1;

  const hiddenSet = new Set(hiddenTierIndices);

  const clearDragState = () => {
    setDragFromIdx(null);
    setDropIndicator(null);
  };

  return (
    <div className="sb-panel-root">
      {isReadOnly && (
        <div className="sb-readonly-banner" role="status">
          <span className="sb-readonly-text">当前为只读模式</span>
          <button
            type="button"
            className="compact sb-readonly-btn"
            onClick={() => setMode('edit')}
          >
            切换至编辑
          </button>
        </div>
      )}

      <CollapsibleSection
        id="tiers-list"
        title="全部层级"
        badge={
          hiddenTierIndices.length > 0
            ? `${tg.tiers.length} 层 · ${hiddenTierIndices.length} 隐藏`
            : `${tg.tiers.length} 层`
        }
        defaultOpen={true}
      >
        {hiddenTierIndices.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            <button
              type="button"
              className="compact sb-full-btn"
              onClick={showAllTiers}
              title="恢复显示全部已隐藏层级"
            >
              <EyeIcon size={13} />
              <span>显示全部 ({hiddenTierIndices.length} 已隐藏)</span>
            </button>
          </div>
        )}

        {tg.tiers.length === 0 ? (
          <div className="sb-empty-note">
            {isReadOnly
              ? '当前文档暂无标注层级，切换至编辑模式后可新增。'
              : '当前文档暂无标注层级，可在下方新增。'}
          </div>
        ) : (
          <div className="sb-tier-list" role="listbox" aria-label="全部层级列表">
            {tg.tiers.map((tier, idx) => {
              const isSelected = idx === selectedTierIndex;
              const isEditing = !isReadOnly && idx === editingIdx;
              const isInterval = tier.kind === 'intervalTier';
              const isHidden = hiddenSet.has(idx);
              const count = isInterval ? tier.intervals.length : tier.points.length;
              const isDragging = dragFromIdx === idx;
              const isDropTop = dropIndicator?.idx === idx && dropIndicator.pos === 'top';
              const isDropBottom = dropIndicator?.idx === idx && dropIndicator.pos === 'bottom';

              const rowClasses = [
                'sb-tier-row',
                isSelected ? 'selected' : '',
                isHidden ? 'is-hidden-tier' : '',
                isDragging ? 'is-dragging' : '',
                isDropTop ? 'drag-over-top' : '',
                isDropBottom ? 'drag-over-bottom' : ''
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <React.Fragment key={`tier-${idx}-${tier.kind}-${tier.name}`}>
                  <div
                    className={rowClasses}
                    role="option"
                    aria-selected={isSelected}
                    draggable={mode === 'edit' && !isEditing}
                    onDragStart={(e) => {
                      if (mode !== 'edit' || isEditing) {
                        e.preventDefault();
                        return;
                      }
                      setDragFromIdx(idx);
                      setDropIndicator(null);
                      e.dataTransfer.effectAllowed = 'move';
                      try {
                        e.dataTransfer.setData('text/plain', String(idx));
                      } catch {
                        // ignore restricted dataTransfer
                      }
                    }}
                    onDragOver={(e) => {
                      if (mode !== 'edit' || dragFromIdx === null) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (dragFromIdx === idx) {
                        if (dropIndicator !== null) setDropIndicator(null);
                        return;
                      }
                      const rect = e.currentTarget.getBoundingClientRect();
                      const pos: 'top' | 'bottom' =
                        e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom';
                      setDropIndicator((prev) =>
                        prev && prev.idx === idx && prev.pos === pos ? prev : { idx, pos }
                      );
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                        setDropIndicator((prev) => (prev && prev.idx === idx ? null : prev));
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (mode !== 'edit' || dragFromIdx === null) {
                        clearDragState();
                        return;
                      }
                      const rect = e.currentTarget.getBoundingClientRect();
                      const pos: 'top' | 'bottom' =
                        dropIndicator?.idx === idx
                          ? dropIndicator.pos
                          : e.clientY < rect.top + rect.height / 2
                            ? 'top'
                            : 'bottom';
                      const rawInsert = pos === 'top' ? idx : idx + 1;
                      const targetIdx = dragFromIdx < rawInsert ? rawInsert - 1 : rawInsert;
                      const from = dragFromIdx;
                      clearDragState();
                      if (targetIdx !== from && targetIdx >= 0 && targetIdx < tg.tiers.length) {
                        reorderTier(from, targetIdx);
                      }
                    }}
                    onDragEnd={clearDragState}
                    onClick={() => {
                      if (!isEditing) setSelection({ kind: 'tier', tierIndex: idx });
                    }}
                  >
                    {!isReadOnly && (
                      <span
                        className="sb-tier-drag-handle"
                        title="拖拽调整层级顺序"
                        aria-hidden="true"
                      >
                        <DragGripIcon size={11} />
                      </span>
                    )}

                    <button
                      type="button"
                      className={`sb-tier-eye-btn ${isHidden ? 'is-hidden' : ''}`}
                      title="隐藏/显示层级（Alt+单击独显）"
                      aria-label={isHidden ? '显示该层级' : '隐藏该层级'}
                      aria-pressed={isHidden}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (e.altKey) {
                          soloTier(idx);
                        } else {
                          toggleTierVisibility(idx);
                        }
                      }}
                    >
                      <EyeIcon hidden={isHidden} size={13} />
                    </button>

                    <span className="sb-tier-num">{idx + 1}</span>
                    <span
                      className="sb-tier-kind-icon"
                      title={isInterval ? '区间层 (IntervalTier)' : '点层 (TextTier)'}
                    >
                      <UiIcon name={isInterval ? 'addIntervalTier' : 'addPointTier'} size={13} />
                    </span>

                    {isEditing ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        className="sb-tier-inline-input"
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => commitRename(idx)}
                        onKeyDown={(e) => {
                          if (isComposingEvent(e)) return;
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitRename(idx);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                            cancelRenameRef.current = true;
                            setNameDraft(tier.name);
                            setEditingIdx(null);
                            (e.target as HTMLInputElement).blur();
                          }
                        }}
                      />
                    ) : (
                      <span
                        className="sb-tier-name"
                        title={
                          isReadOnly
                            ? tier.name || '未命名层'
                            : `${tier.name || '未命名层'}（双击重命名）`
                        }
                        onDoubleClick={(e) => {
                          if (isReadOnly) return;
                          e.stopPropagation();
                          startRename(idx, tier.name);
                        }}
                      >
                        {tier.name || '未命名层'}
                      </span>
                    )}

                    {!isEditing && (
                      <span className="sb-tier-count">
                        {count} {isInterval ? '段' : '点'}
                      </span>
                    )}

                    {!isEditing && !isReadOnly && (
                      <div className="sb-tier-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="sb-tier-act-btn"
                          title="上移一层"
                          disabled={idx === 0}
                          onClick={() => moveTier(idx, -1)}
                        >
                          <UiIcon name="up" size={11} />
                        </button>
                        <button
                          type="button"
                          className="sb-tier-act-btn"
                          title="下移一层"
                          disabled={idx >= tg.tiers.length - 1}
                          onClick={() => moveTier(idx, 1)}
                        >
                          <UiIcon name="down" size={11} />
                        </button>
                        <button
                          type="button"
                          className="sb-tier-act-btn danger"
                          title="删除该层（可撤销）"
                          onClick={() => removeTierWithUndoToast(idx)}
                        >
                          <CloseIcon />
                        </button>
                      </div>
                    )}
                  </div>

                  {!isReadOnly && !isEditing && isSelected && (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 4,
                        padding: '4px 6px 5px 24px',
                        background: 'var(--bg-subtle)',
                        borderBottom:
                          idx < tg.tiers.length - 1 ? '1px solid var(--rule)' : 'none'
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {isInterval && (
                        <button
                          type="button"
                          className="compact"
                          style={{ height: 22, padding: '0 6px', fontSize: 10.5 }}
                          title="新建区间层并继承当前层全部边界（清空文本）"
                          onClick={() => duplicateTier(idx, { copyText: false })}
                        >
                          仅复制边界
                        </button>
                      )}
                      <button
                        type="button"
                        className="compact"
                        style={{ height: 22, padding: '0 6px', fontSize: 10.5 }}
                        title="复制整层（含边界与全部标注文本）"
                        onClick={() => duplicateTier(idx, { copyText: true })}
                      >
                        复制层
                      </button>
                      {isInterval && (
                        <button
                          type="button"
                          className="compact"
                          style={{ height: 22, padding: '0 6px', fontSize: 10.5 }}
                          title="按当前层所有非空区间中点派生新点层"
                          onClick={() => derivePointTierFromIntervals(idx, 'mid')}
                        >
                          派生点层
                        </button>
                      )}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        )}
        {tg.tiers.length > 0 && (
          <div className="sb-hint" style={{ marginTop: 6 }}>
            {isReadOnly
              ? '单击层级查看详情；眼睛图标可隐藏层级（Alt+单击独显）。'
              : '拖拽手柄调序 · 眼睛隐藏（Alt+单击独显）· 单击展开复制/派生 · 双击改名。'}
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection id="tiers-add" title="新增层级" defaultOpen={true}>
        <div className="sb-stack">
          <button
            type="button"
            className="compact sb-full-btn"
            disabled={isReadOnly}
            title={isReadOnly ? '请先切换至编辑模式' : undefined}
            onClick={() => {
              if (!isReadOnly) insertTierAt(tg.tiers.length, 'intervalTier');
            }}
          >
            <UiIcon name="addIntervalTier" size={13} />
            <span>添加区间层 (IntervalTier)</span>
          </button>
          <button
            type="button"
            className="compact sb-full-btn"
            disabled={isReadOnly}
            title={isReadOnly ? '请先切换至编辑模式' : undefined}
            onClick={() => {
              if (!isReadOnly) insertTierAt(tg.tiers.length, 'textTier');
            }}
          >
            <UiIcon name="addPointTier" size={13} />
            <span>添加点层 (TextTier)</span>
          </button>
        </div>
      </CollapsibleSection>
    </div>
  );
};
