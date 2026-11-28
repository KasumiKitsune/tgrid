import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BULK_DROP_MAX_INDIVIDUAL_TABS,
  formatFileSizeShort,
  type DropDirectoryCandidate,
  type DropIntakePlan,
  type DropOpenUnit
} from '../utils/dropIntake';
import { CorpusFolderIcon } from '../corpus/corpusIcons';
import { CloseIcon, UiIcon } from './Icons';
import '../styles/tabMenuDrop.css';

export interface BulkDropSelectionPayload {
  dirIds: string[];
  unitIds: string[];
}

export interface BulkDropModalProps {
  plan: DropIntakePlan | null;
  busy?: boolean;
  onCancel: () => void;
  onOpenAsCorpus: () => void;
  onOpenSelected: (selection: BulkDropSelectionPayload) => void;
}

interface SelectableRow {
  key: string;
  rowKind: 'dir' | 'unit';
  id: string;
  label: string;
  badge: string;
  badgeTone?: 'paired' | 'dir' | 'opened';
  sizeText: string;
  alreadyOpen: boolean;
  dir?: DropDirectoryCandidate;
  unit?: DropOpenUnit;
}

const MAX_IGNORED_PREVIEW = 30;

function buildRows(plan: DropIntakePlan): SelectableRow[] {
  const rows: SelectableRow[] = [];
  for (const dir of plan.directories) {
    rows.push({
      key: `dir:${dir.id}`,
      rowKind: 'dir',
      id: dir.id,
      label: dir.name,
      badge: dir.alreadyOpenTabId ? '已打开' : '文件夹',
      badgeTone: dir.alreadyOpenTabId ? 'opened' : 'dir',
      sizeText: '',
      alreadyOpen: Boolean(dir.alreadyOpenTabId),
      dir
    });
  }
  for (const unit of plan.openUnits) {
    const isAlready = Boolean(unit.alreadyOpenTabId);
    let badge = '标注';
    let badgeTone: SelectableRow['badgeTone'];
    if (isAlready) {
      badge = '已打开';
      badgeTone = 'opened';
    } else if (unit.kind === 'paired') {
      badge = '标注 + 录音';
      badgeTone = 'paired';
    } else if (unit.kind === 'audio') {
      badge = '录音';
    }
    rows.push({
      key: `unit:${unit.id}`,
      rowKind: 'unit',
      id: unit.id,
      label: unit.label,
      badge,
      badgeTone,
      sizeText: formatFileSizeShort(unit.size),
      alreadyOpen: isAlready,
      unit
    });
  }
  return rows;
}

function buildSummaryParts(plan: DropIntakePlan): string[] {
  const parts: string[] = [];
  if (plan.directories.length > 0) {
    parts.push(`${plan.directories.length} 个文件夹`);
  }
  if (plan.pairedCount > 0) {
    parts.push(`${plan.pairedCount} 组配对标注与录音`);
  }
  if (plan.standaloneDocCount > 0) {
    parts.push(`${plan.standaloneDocCount} 个标注文件`);
  }
  if (plan.standaloneAudioCount > 0) {
    parts.push(`${plan.standaloneAudioCount} 个独立音频`);
  }
  return parts;
}

export const BulkDropModal: React.FC<BulkDropModalProps> = ({
  plan,
  busy = false,
  onCancel,
  onOpenAsCorpus,
  onOpenSelected
}) => {
  const primaryBtnRef = useRef<HTMLButtonElement>(null);
  const backdropPointerDownRef = useRef(false);
  const lastPlanRef = useRef<DropIntakePlan | null>(null);
  if (plan) {
    lastPlanRef.current = plan;
  }

  const open = Boolean(plan);
  const view = plan ?? lastPlanRef.current;

  const rows = useMemo(() => (view ? buildRows(view) : []), [view]);
  const selectableKeys = useMemo(
    () => rows.filter((r) => !r.alreadyOpen).map((r) => r.key),
    [rows]
  );

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!plan) return;
    const initial = new Set<string>();
    const newRows = buildRows(plan).filter((r) => !r.alreadyOpen);
    for (let i = 0; i < Math.min(newRows.length, BULK_DROP_MAX_INDIVIDUAL_TABS); i++) {
      initial.add(newRows[i].key);
    }
    setSelectedKeys(initial);
    requestAnimationFrame(() => {
      primaryBtnRef.current?.focus();
    });
  }, [plan]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, busy, onCancel]);

  if (!view) return null;

  const selectedCount = selectedKeys.size;
  const selectableTotal = selectableKeys.length;
  const atLimit = selectedCount >= BULK_DROP_MAX_INDIVIDUAL_TABS;
  const summaryParts = buildSummaryParts(view);
  const rec = view.corpusRecommendation;

  const toggleRow = (key: string) => {
    if (busy) return;
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        return next;
      }
      if (next.size >= BULK_DROP_MAX_INDIVIDUAL_TABS) {
        return prev;
      }
      next.add(key);
      return next;
    });
  };

  const selectFirstN = (limit: number) => {
    if (busy) return;
    const cap = Math.min(limit, BULK_DROP_MAX_INDIVIDUAL_TABS, selectableKeys.length);
    setSelectedKeys(new Set(selectableKeys.slice(0, cap)));
  };

  const clearSelection = () => {
    if (busy) return;
    setSelectedKeys(new Set());
  };

  const emitSelection = (keys: Set<string>) => {
    const dirIds: string[] = [];
    const unitIds: string[] = [];
    for (const row of rows) {
      if (!keys.has(row.key)) continue;
      if (row.rowKind === 'dir') {
        dirIds.push(row.id);
      } else {
        unitIds.push(row.id);
      }
    }
    onOpenSelected({ dirIds, unitIds });
  };

  const handleOpenFirstFive = () => {
    const topFive = new Set(selectableKeys.slice(0, Math.min(5, selectableKeys.length)));
    emitSelection(topFive);
  };

  const extraNotes: string[] = [];
  if (view.unsupported.length > 0) {
    extraNotes.push(`已自动忽略 ${view.unsupported.length} 个不支持的文件`);
  }
  if (view.alreadyOpen.length > 0) {
    extraNotes.push(`另有 ${view.alreadyOpen.length} 个已在标签栏打开`);
  }

  return (
    <div
      className={`modal-backdrop ${open ? 'open' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      aria-labelledby="bulk-drop-modal-title"
      onPointerDown={(e) => {
        backdropPointerDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (!busy && backdropPointerDownRef.current && e.target === e.currentTarget) {
          onCancel();
        }
        backdropPointerDownRef.current = false;
      }}
    >
      <div className="modal-card bulk-drop-modal-card">
        <div className="modal-head">
          <span id="bulk-drop-modal-title" className="modal-title">
            <UiIcon name="warning" size={14} />
            <span>批量打开文件确认</span>
          </span>
          <button
            type="button"
            className="icon-btn compact"
            title="取消 (Esc)"
            aria-label="取消"
            disabled={busy}
            onClick={onCancel}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="modal-body bulk-drop-modal-body">
          <p className="bulk-drop-summary">
            检测到拖入了 <strong>{view.totalRawCount}</strong> 个条目，识别出{' '}
            <strong>{summaryParts.join('、') || '有效文件'}</strong>
            {extraNotes.length > 0 ? `（${extraNotes.join('，')}）` : ''}。
          </p>

          {rec && (
            <div className="bulk-drop-recommend">
              <div className="bulk-drop-recommend-text">
                <span className="bulk-drop-recommend-title">
                  <CorpusFolderIcon size={14} />
                  <span>推荐：作为词表文件夹打开（仅占 1 个标签页）</span>
                </span>
                <p className="bulk-drop-recommend-desc">
                  {rec.mode === 'tauri-dir' ? (
                    <>
                      打开所在文件夹「
                      <span className="bulk-drop-recommend-folder">{rec.folderName}</span>
                      」为词表项目，可在左侧列表逐条切换并按需加载音频，不占用大量标签页。
                    </>
                  ) : (
                    <>
                      将这批 {rec.itemCount} 条文件整理为一个词表标签页，按需切换加载音频，避免浏览器卡顿。
                    </>
                  )}
                </p>
              </div>
            </div>
          )}

          {view.exceedsIndividualCap && (
            <p className="bulk-drop-cap-notice">
              为防止一次性打开过多标签页导致界面卡顿，逐个作为独立标签页打开时单次最多支持勾选{' '}
              <strong>{BULK_DROP_MAX_INDIVIDUAL_TABS}</strong> 项
              {rec ? '；改用词表文件夹模式则不受此限制。' : '，可分批打开。'}
            </p>
          )}

          <div className="bulk-drop-list-bar">
            <span className={`bulk-drop-list-count ${atLimit ? 'at-limit' : ''}`}>
              已选 {selectedCount} / {Math.min(selectableTotal, BULK_DROP_MAX_INDIVIDUAL_TABS)}
              {selectableTotal > BULK_DROP_MAX_INDIVIDUAL_TABS
                ? `（共 ${selectableTotal} 项可选，上限 ${BULK_DROP_MAX_INDIVIDUAL_TABS}）`
                : ` 项`}
            </span>
            <div className="bulk-drop-quick-actions">
              <button
                type="button"
                className="bulk-drop-quick-btn"
                disabled={busy || selectableTotal === 0}
                onClick={() => selectFirstN(BULK_DROP_MAX_INDIVIDUAL_TABS)}
              >
                {selectableTotal > BULK_DROP_MAX_INDIVIDUAL_TABS
                  ? `全选前 ${BULK_DROP_MAX_INDIVIDUAL_TABS} 项`
                  : '全选'}
              </button>
              {selectableTotal > 5 && (
                <button
                  type="button"
                  className="bulk-drop-quick-btn"
                  disabled={busy}
                  onClick={() => selectFirstN(5)}
                >
                  仅选前 5 项
                </button>
              )}
              <button
                type="button"
                className="bulk-drop-quick-btn"
                disabled={busy || selectedCount === 0}
                onClick={clearSelection}
              >
                清空
              </button>
            </div>
          </div>

          <ul className="bulk-drop-list" aria-label="待打开文件列表">
            {rows.map((row) => {
              const checked = selectedKeys.has(row.key);
              const capBlocked = !row.alreadyOpen && !checked && atLimit;
              return (
                <li
                  key={row.key}
                  className={`bulk-drop-item ${row.alreadyOpen ? 'is-open' : ''} ${capBlocked ? 'is-disabled' : ''}`}
                  title={
                    row.alreadyOpen
                      ? `${row.label}（已在标签栏打开）`
                      : capBlocked
                        ? `单次最多打开 ${BULK_DROP_MAX_INDIVIDUAL_TABS} 个独立标签页`
                        : row.label
                  }
                  onClick={() => {
                    if (!row.alreadyOpen && !capBlocked) {
                      toggleRow(row.key);
                    }
                  }}
                >
                  <input
                    type="checkbox"
                    className="bulk-drop-checkbox"
                    checked={checked}
                    disabled={busy || row.alreadyOpen || capBlocked}
                    aria-label={row.label}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleRow(row.key)}
                  />
                  <span className="bulk-drop-item-icon" aria-hidden="true">
                    {row.rowKind === 'dir' ? (
                      <CorpusFolderIcon size={13} />
                    ) : row.unit?.kind === 'audio' ? (
                      <UiIcon name="waveform" size={13} />
                    ) : (
                      <UiIcon name="fileCollection" size={13} />
                    )}
                  </span>
                  <span className="bulk-drop-item-name">{row.label}</span>
                  <span className={`bulk-drop-badge ${row.badgeTone ?? ''}`}>{row.badge}</span>
                  {row.sizeText && <span className="bulk-drop-item-size">{row.sizeText}</span>}
                </li>
              );
            })}
          </ul>

          {view.unsupported.length > 0 && (
            <details className="bulk-drop-ignored">
              <summary>已自动忽略 {view.unsupported.length} 个不支持的文件（点击查看）</summary>
              <ul className="bulk-drop-ignored-list">
                {view.unsupported.slice(0, MAX_IGNORED_PREVIEW).map((item) => (
                  <li key={item.id}>{item.name}</li>
                ))}
                {view.unsupported.length > MAX_IGNORED_PREVIEW && (
                  <li>等共 {view.unsupported.length} 个文件</li>
                )}
              </ul>
            </details>
          )}
        </div>

        <div className="bulk-drop-foot">
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <div className="bulk-drop-foot-right">
            {rec ? (
              <>
                <button
                  type="button"
                  disabled={busy || selectedCount === 0}
                  onClick={() => emitSelection(selectedKeys)}
                >
                  分别打开勾选的 {selectedCount} 个
                </button>
                <button
                  ref={primaryBtnRef}
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={onOpenAsCorpus}
                >
                  <CorpusFolderIcon size={13} />
                  <span>{busy ? '正在打开…' : '作为词表文件夹打开（1 个标签页）'}</span>
                </button>
              </>
            ) : (
              <>
                {selectableTotal > 5 && (
                  <button type="button" disabled={busy} onClick={handleOpenFirstFive}>
                    仅打开前 5 个
                  </button>
                )}
                <button
                  ref={primaryBtnRef}
                  type="button"
                  className="primary"
                  disabled={busy || selectedCount === 0}
                  onClick={() => emitSelection(selectedKeys)}
                >
                  <span>
                    {busy ? '正在打开…' : `打开勾选的 ${selectedCount} 个标签页`}
                  </span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
