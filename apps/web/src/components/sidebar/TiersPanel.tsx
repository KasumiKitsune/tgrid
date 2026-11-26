import React, { useEffect, useRef, useState } from 'react';
import { isComposingEvent } from '../../shortcuts/registry';
import { formatQuote, formatTierLabel } from '../../store/historyModel';
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
  const tierListRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

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
      (_draft, ctx) => {
        const dTier = ctx.editTier(idx);
        if (!dTier) return false;
        dTier.name = nextName;
      },
      undefined,
      {
        type: 'rename-tier',
        title: '重命名层级',
        detail: `${formatQuote(tier.name)}→${formatQuote(nextName)}`,
        icon: 'edit',
        tierName: formatTierLabel(nextName, idx)
      }
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

  const handleTierPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    fromIdx: number,
    isRowEditing: boolean
  ) => {
    if (mode !== 'edit' || isRowEditing || e.button !== 0) return;
    const el = e.target as HTMLElement | null;
    if (!el || el.closest('button, input')) return;

    const isHandle = Boolean(el.closest('.sb-tier-drag-handle'));
    if (isHandle) {
      e.preventDefault();
    }

    dragCleanupRef.current?.();

    const startY = e.clientY;
    const totalTiers = tg.tiers.length;
    let active = false;
    let latestHit: { idx: number; pos: 'top' | 'bottom' } | null = null;

    const computeHit = (clientY: number): { idx: number; pos: 'top' | 'bottom' } | null => {
      const container = tierListRef.current;
      if (!container) return null;
      const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-tier-idx]'));
      if (rows.length === 0) return null;

      let chosen: { idx: number; pos: 'top' | 'bottom' } | null = null;
      const firstRect = rows[0].getBoundingClientRect();
      const lastRect = rows[rows.length - 1].getBoundingClientRect();

      if (clientY <= firstRect.top) {
        const idx = Number(rows[0].dataset.tierIdx);
        if (Number.isInteger(idx)) chosen = { idx, pos: 'top' };
      } else if (clientY >= lastRect.bottom) {
        const idx = Number(rows[rows.length - 1].dataset.tierIdx);
        if (Number.isInteger(idx)) chosen = { idx, pos: 'bottom' };
      } else {
        let bestDist = Infinity;
        for (const row of rows) {
          const idx = Number(row.dataset.tierIdx);
          if (!Number.isInteger(idx)) continue;
          const rect = row.getBoundingClientRect();
          if (clientY >= rect.top && clientY <= rect.bottom) {
            chosen = { idx, pos: clientY < rect.top + rect.height / 2 ? 'top' : 'bottom' };
            break;
          }
          const center = rect.top + rect.height / 2;
          const dist = Math.abs(clientY - center);
          if (dist < bestDist) {
            bestDist = dist;
            chosen = { idx, pos: clientY < center ? 'top' : 'bottom' };
          }
        }
      }

      if (!chosen || chosen.idx === fromIdx) return null;
      return chosen;
    };

    const onMove = (ev: PointerEvent) => {
      if (!active) {
        const threshold = isHandle ? 2 : 4;
        if (Math.abs(ev.clientY - startY) < threshold) return;
        active = true;
        suppressClickRef.current = true;
        setDragFromIdx(fromIdx);
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
      }
      const hit = computeHit(ev.clientY);
      latestHit = hit;
      setDropIndicator((prev) =>
        prev?.idx === hit?.idx && prev?.pos === hit?.pos ? prev : hit
      );
    };

    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown, true);
      dragCleanupRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      if (active && commit && latestHit && latestHit.idx !== fromIdx) {
        const rawInsert = latestHit.pos === 'top' ? latestHit.idx : latestHit.idx + 1;
        const targetIdx = fromIdx < rawInsert ? rawInsert - 1 : rawInsert;
        if (targetIdx !== fromIdx && targetIdx >= 0 && targetIdx < totalTiers) {
          reorderTier(fromIdx, targetIdx);
        }
      }

      setDragFromIdx(null);
      setDropIndicator(null);
      if (active) {
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    };

    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      }
    };

    dragCleanupRef.current = () => finish(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown, true);
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
              <UiIcon name="showTier" size={13} />
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
          <div
            ref={tierListRef}
            className="sb-tier-list"
            role="listbox"
            aria-label="全部层级列表"
          >
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
                    data-tier-idx={idx}
                    className={rowClasses}
                    role="option"
                    aria-selected={isSelected}
                    onPointerDown={(e) => handleTierPointerDown(e, idx, isEditing)}
                    onClick={() => {
                      if (suppressClickRef.current) return;
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
                      <UiIcon name={isHidden ? 'hideTier' : 'showTier'} size={13} />
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
                          <UiIcon name="duplicateTier" size={11} />
                          <span>仅复制边界</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="compact"
                        style={{ height: 22, padding: '0 6px', fontSize: 10.5 }}
                        title="复制整层（含边界与全部标注文本）"
                        onClick={() => duplicateTier(idx, { copyText: true })}
                      >
                        <UiIcon name="duplicateTier" size={11} />
                        <span>复制层</span>
                      </button>
                      {isInterval && (
                        <button
                          type="button"
                          className="compact"
                          style={{ height: 22, padding: '0 6px', fontSize: 10.5 }}
                          title="按当前层所有非空区间中点派生新点层"
                          onClick={() => derivePointTierFromIntervals(idx, 'mid')}
                        >
                          <UiIcon name="derivePointTier" size={11} />
                          <span>派生点层</span>
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
