import React, { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../../store/useEditorStore';
import { CloseIcon, UiIcon } from '../Icons';
import { CollapsibleSection } from './CollapsibleSection';

export const TiersPanel: React.FC = () => {
  const tg = useEditorStore((s) => s.tg);
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const isReadOnly = mode === 'read';
  const selection = useEditorStore((s) => s.selection);
  const setSelection = useEditorStore((s) => s.setSelection);
  const insertTierAt = useEditorStore((s) => s.insertTierAt);
  const moveTier = useEditorStore((s) => s.moveTier);
  const deleteTier = useEditorStore((s) => s.deleteTier);
  const commitTgMutation = useEditorStore((s) => s.commitTgMutation);

  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

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
    setEditingIdx(idx);
    setNameDraft(currentName);
  };

  const commitRename = (idx: number) => {
    const tier = tg.tiers[idx];
    setEditingIdx(null);
    if (isReadOnly || !tier || nameDraft === tier.name) return;
    commitTgMutation((draft) => {
      if (draft.tiers[idx]) draft.tiers[idx].name = nameDraft;
    });
  };

  const selectedTierIndex =
    selection &&
    (selection.kind === 'tier' ||
      selection.kind === 'interval' ||
      selection.kind === 'point' ||
      selection.kind === 'boundary')
      ? selection.tierIndex
      : -1;

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
        badge={`${tg.tiers.length} 层`}
        defaultOpen={true}
      >
        {tg.tiers.length === 0 ? (
          <div className="sb-empty-note">
            {isReadOnly ? '当前文档暂无标注层级，切换至编辑模式后可新增。' : '当前文档暂无标注层级，可在下方新增。'}
          </div>
        ) : (
          <div className="sb-tier-list" role="listbox" aria-label="全部层级列表">
            {tg.tiers.map((tier, idx) => {
              const isSelected = idx === selectedTierIndex;
              const isEditing = !isReadOnly && idx === editingIdx;
              const isInterval = tier.kind === 'intervalTier';
              const count = isInterval ? tier.intervals.length : tier.points.length;

              return (
                <div
                  key={`${idx}-${tier.kind}`}
                  className={`sb-tier-row ${isSelected ? 'selected' : ''}`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    if (!isEditing) setSelection({ kind: 'tier', tierIndex: idx });
                  }}
                >
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
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitRename(idx);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setEditingIdx(null);
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
                        title="删除该层"
                        onClick={() => deleteTier(idx)}
                      >
                        <CloseIcon />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {tg.tiers.length > 0 && (
          <div className="sb-hint" style={{ marginTop: 6 }}>
            {isReadOnly
              ? '只读模式：单击层级可在属性栏查看详情。'
              : '单击选中层级，双击层名可直接重命名。'}
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
