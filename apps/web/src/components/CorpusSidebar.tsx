import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CORPUS_STATUS_META,
  CORPUS_STATUS_ORDER,
  CorpusCloseIcon,
  CorpusExportZipIcon,
  CorpusFilterAllIcon,
  CorpusFolderIcon,
  CorpusNextIcon,
  CorpusSaveIcon,
  CorpusSearchIcon,
  CorpusSidebarToggleIcon,
  CorpusStatusIcon
} from '../corpus/corpusIcons';
import type {
  CorpusFilterState,
  CorpusItemRecord,
  CorpusItemStatus,
  CorpusProjectState
} from '../corpus/types';
import { formatKeyCombo } from '../shortcuts/registry';
import { getLogicalViewportSize, getViewportZoom } from '../utils/uiScale';
import { UiIcon } from './Icons';

export interface CorpusSidebarProps {
  corpus: CorpusProjectState;
  /** 当前编辑区是否有尚未落盘的修改 */
  isDirty?: boolean;
  /** 是否开启自动保存 */
  corpusAutoSave?: boolean;
  /** 未保存词条 ID 列表 */
  unsavedItemIds?: readonly string[];
  /** 项目索引是否有未落盘变更 */
  projectIndexDirty?: boolean;
  /** 单文件离线模式下本地缓存是否被浏览器禁用 */
  recoveryDegraded?: boolean;
  /** 批量保存进度 */
  saveProgress?: { done: number; total: number } | null;
  /** 各词条自动保存覆写前的原件备份时间戳（itemId -> updatedAt） */
  backupTimestamps?: Record<string, number>;
  /** 是否显示词条四态标记与状态筛选行（默认 true） */
  showStatusMarks?: boolean;
  /** 选中并切换至指定词条 */
  onSelectItem: (itemId: string) => void;
  /** 更新搜索词或状态筛选 */
  onChangeFilter: (patch: Partial<CorpusFilterState>) => void;
  /** 展开或收起左侧词条栏 */
  onToggleOpen: (open: boolean) => void;
  /** 拖拽调整左侧词条栏宽度 */
  onResizeWidth: (width: number) => void;
  /** 右键菜单中直接修改任意词条的标注状态 */
  onSetItemStatus?: (itemId: string, status: CorpusItemStatus) => void;
  /** 保存单条词条到磁盘 */
  onSaveItem?: (itemId: string) => void;
  /** 批量保存全部未保存词条 */
  onSaveAll?: () => void;
  /** 还原单条词条为磁盘原文件 */
  onRevertItem?: (itemId: string) => void;
  /** 放弃全部未保存修改 */
  onDiscardAllDrafts?: () => void;
  /** 恢复某条词条自动保存覆写前的编辑前备份 */
  onRestoreItemBackup?: (itemId: string) => void;
  /** 切换自动保存开关 */
  onToggleAutoSave?: () => void;
  /** 桌面端可用时在系统文件管理器中定位该词条音频文件 */
  onRevealItem?: (itemId: string) => void;
  /** 复制文件名或音标文本（未传入时自动回退到 navigator.clipboard.writeText） */
  onCopyItemText?: (text: string, label: string) => void;
  /** 是否允许显示「在文件夹中显示」菜单项（桌面端为 true） */
  canRevealItem?: boolean;
  /** Web 只读降级模式下导出修改包 (.zip) */
  onExportModifiedZip?: () => void;
  /** 是否正在打包导出 */
  exportingZip?: boolean;
}

const ROW_HEIGHT = 38;
const OVERSCAN = 8;
const DEFAULT_SIDEBAR_WIDTH = 272;

interface IndexedCorpusItem {
  item: CorpusItemRecord;
  order: number;
}

interface RowContextMenuState {
  itemId: string;
  x: number;
  y: number;
}

export function filterCorpusItems(
  items: readonly CorpusItemRecord[],
  filter: CorpusFilterState,
  ignoreStatusFilter = false
): CorpusItemRecord[] {
  const q = filter.query.trim().toLowerCase();
  const status = ignoreStatusFilter ? 'all' : filter.status;
  if (!q && status === 'all') {
    return items as CorpusItemRecord[];
  }
  const result: CorpusItemRecord[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (status !== 'all' && item.status !== status) continue;
    if (q) {
      const hayLabel = item.label.toLowerCase();
      const hayId = item.id.toLowerCase();
      const hayIpa = item.ipaPreview.toLowerCase();
      const hayNote = item.note ? item.note.toLowerCase() : '';
      const hayAudio = item.audioRelPath.toLowerCase();
      if (
        !hayLabel.includes(q) &&
        !hayId.includes(q) &&
        !hayIpa.includes(q) &&
        !hayNote.includes(q) &&
        !hayAudio.includes(q)
      ) {
        continue;
      }
    }
    result.push(item);
  }
  return result;
}

function formatDurationShort(duration: number | null): string {
  if (duration == null || !Number.isFinite(duration) || duration <= 0) return '';
  if (duration < 60) {
    return `${duration.toFixed(duration < 10 ? 2 : 1)}s`;
  }
  const mins = Math.floor(duration / 60);
  const secs = Math.floor(duration % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatBackupTime(ts: number): string {
  try {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

function getFileBaseName(relPath: string): string {
  const parts = relPath.split(/[/\\]/);
  return parts[parts.length - 1] || relPath;
}

export const CorpusSidebar: React.FC<CorpusSidebarProps> = ({
  corpus,
  isDirty = false,
  corpusAutoSave = false,
  unsavedItemIds,
  projectIndexDirty = false,
  recoveryDegraded = false,
  saveProgress = null,
  backupTimestamps,
  showStatusMarks = true,
  onSelectItem,
  onChangeFilter,
  onToggleOpen,
  onResizeWidth,
  onSetItemStatus,
  onSaveItem,
  onSaveAll,
  onRevertItem,
  onDiscardAllDrafts,
  onRestoreItemBackup,
  onToggleAutoSave,
  onRevealItem,
  onCopyItemText,
  canRevealItem = false,
  onExportModifiedZip,
  exportingZip = false
}) => {
  const { items, activeItemId, filter, sidebarOpen, sidebarWidth } = corpus;

  const [resizing, setResizing] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const [ctxMenu, setCtxMenu] = useState<RowContextMenuState | null>(null);
  const [ctxPos, setCtxPos] = useState<{ left: number; top: number } | null>(null);

  const listViewportRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  const corpusExt = corpus as CorpusProjectState & {
    unsavedItemIds?: string[];
    projectIndexDirty?: boolean;
    recoveryDegraded?: boolean;
  };
  const resolvedUnsavedIds = unsavedItemIds ?? corpusExt.unsavedItemIds ?? [];
  const resolvedIndexDirty = projectIndexDirty || Boolean(corpusExt.projectIndexDirty);
  const resolvedDegraded = recoveryDegraded || Boolean(corpusExt.recoveryDegraded);

  const unsavedSet = useMemo(() => {
    const s = new Set<string>(resolvedUnsavedIds);
    if (isDirty && activeItemId) s.add(activeItemId);
    return s;
  }, [resolvedUnsavedIds, isDirty, activeItemId]);

  const unsavedCount = unsavedSet.size;
  const hasPendingSave = unsavedCount > 0 || resolvedIndexDirty;
  const isSaving = corpus.saveStatus === 'saving';

  const counts = useMemo(() => {
    const c: Record<'all' | CorpusItemStatus, number> = {
      all: items.length,
      todo: 0,
      done: 0,
      doubt: 0,
      trash: 0
    };
    for (let i = 0; i < items.length; i++) {
      c[items[i].status] += 1;
    }
    return c;
  }, [items]);

  const effectiveStatusFilter: 'all' | CorpusItemStatus = showStatusMarks ? filter.status : 'all';

  const filteredIndexed = useMemo<IndexedCorpusItem[]>(() => {
    const q = filter.query.trim().toLowerCase();
    const status = effectiveStatusFilter;
    const out: IndexedCorpusItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (status !== 'all' && item.status !== status) continue;
      if (q) {
        const hayLabel = item.label.toLowerCase();
        const hayId = item.id.toLowerCase();
        const hayIpa = item.ipaPreview.toLowerCase();
        const hayNote = item.note ? item.note.toLowerCase() : '';
        const hayAudio = item.audioRelPath.toLowerCase();
        if (
          !hayLabel.includes(q) &&
          !hayId.includes(q) &&
          !hayIpa.includes(q) &&
          !hayNote.includes(q) &&
          !hayAudio.includes(q)
        ) {
          continue;
        }
      }
      out.push({ item, order: i + 1 });
    }
    return out;
  }, [items, filter.query, effectiveStatusFilter]);

  // Measure virtual list viewport height via ResizeObserver
  useEffect(() => {
    const el = listViewportRef.current;
    if (!el) return;
    const updateHeight = () => {
      const next = el.clientHeight;
      if (next > 0) setViewportHeight(next);
    };
    updateHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(updateHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sidebarOpen]);

  // Clamp scrollTop when filter reduces total list height
  useEffect(() => {
    const el = listViewportRef.current;
    if (!el) return;
    const maxScroll = Math.max(0, filteredIndexed.length * ROW_HEIGHT - viewportHeight);
    if (el.scrollTop > maxScroll) {
      el.scrollTop = maxScroll;
      setScrollTop(maxScroll);
    }
  }, [filteredIndexed.length, viewportHeight]);

  // Scroll active entry into view when activeItemId changes or sidebar opens
  useEffect(() => {
    if (!sidebarOpen || !activeItemId) return;
    const el = listViewportRef.current;
    if (!el) return;
    const idx = filteredIndexed.findIndex((entry) => entry.item.id === activeItemId);
    if (idx === -1) return;

    const itemTop = idx * ROW_HEIGHT;
    const itemBottom = itemTop + ROW_HEIGHT;
    const curTop = el.scrollTop;
    const curHeight = el.clientHeight || viewportHeight;
    const curBottom = curTop + curHeight;

    if (itemTop < curTop) {
      const target = Math.max(0, itemTop - ROW_HEIGHT);
      el.scrollTop = target;
      setScrollTop(target);
    } else if (itemBottom > curBottom) {
      const target = Math.max(0, itemBottom - curHeight + ROW_HEIGHT);
      el.scrollTop = target;
      setScrollTop(target);
    }
  }, [activeItemId, sidebarOpen, filteredIndexed, viewportHeight]);

  // Close row context menu when sidebar collapses or project changes
  useEffect(() => {
    if (!sidebarOpen) setCtxMenu(null);
  }, [sidebarOpen, corpus.projectId]);

  // Global dismissal listeners for row context menu
  useEffect(() => {
    if (!ctxMenu) return;

    const close = () => setCtxMenu(null);

    const onPointerDown = (e: PointerEvent) => {
      if (ctxMenuRef.current && ctxMenuRef.current.contains(e.target as Node)) return;
      setCtxMenu(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setCtxMenu(null);
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('tg-close-stage-ctx', close);
    window.addEventListener('tg-close-global-ctx', close);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('tg-close-stage-ctx', close);
      window.removeEventListener('tg-close-global-ctx', close);
    };
  }, [ctxMenu]);

  // Clamp context menu inside logical viewport bounds after render
  useLayoutEffect(() => {
    if (!ctxMenu) {
      setCtxPos(null);
      return;
    }
    const { width: vw, height: vh } = getLogicalViewportSize();
    const menuEl = ctxMenuRef.current;
    const menuW = menuEl ? menuEl.offsetWidth : 210;
    const menuH = menuEl ? menuEl.offsetHeight : 280;
    const left = Math.max(8, Math.min(ctxMenu.x, vw - menuW - 8));
    const top = Math.max(8, Math.min(ctxMenu.y, vh - menuH - 8));
    setCtxPos({ left, top });
  }, [ctxMenu, showStatusMarks, canRevealItem, unsavedSet, backupTimestamps]);

  const handleRowContextMenu = (e: React.MouseEvent<HTMLDivElement>, itemId: string) => {
    e.preventDefault();
    e.stopPropagation();
    (e.nativeEvent as MouseEvent & { __tgCtxHandled?: boolean }).__tgCtxHandled = true;
    window.dispatchEvent(new Event('tg-close-stage-ctx'));
    window.dispatchEvent(new Event('tg-close-global-ctx'));

    const z = getViewportZoom();
    setCtxMenu({
      itemId,
      x: e.clientX / z,
      y: e.clientY / z
    });
  };

  const handleCopyText = (text: string, label: string) => {
    if (!text) return;
    if (onCopyItemText) {
      onCopyItemText(text, label);
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => {});
    }
  };

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !sidebarOpen) return;
    e.preventDefault();
    setCtxMenu(null);
    const startX = e.clientX;
    const startWidth = sidebarWidth || DEFAULT_SIDEBAR_WIDTH;
    setResizing(true);
    document.body.style.cursor = 'col-resize';

    let collapsed = false;
    const onMove = (ev: PointerEvent) => {
      const z = getViewportZoom();
      const { width: vw } = getLogicalViewportSize();
      const maxSafeW = Math.max(220, Math.min(440, Math.floor(vw * 0.45)));
      const rawW = startWidth + (ev.clientX - startX) / z;
      if (rawW < 175) {
        if (!collapsed) {
          collapsed = true;
          onToggleOpen(false);
        }
        return;
      }
      if (collapsed) {
        collapsed = false;
        onToggleOpen(true);
      }
      onResizeWidth(Math.min(maxSafeW, Math.max(210, Math.round(rawW))));
    };

    const onUp = () => {
      setResizing(false);
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const totalHeight = filteredIndexed.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(filteredIndexed.length, startIndex + visibleCount);
  const visibleSlice = filteredIndexed.slice(startIndex, endIndex);
  const offsetY = startIndex * ROW_HEIGHT;

  const hasActiveFilter = Boolean(filter.query.trim()) || effectiveStatusFilter !== 'all';

  let saveFooterText = corpusAutoSave ? '自动保存已开启 · 已同步' : '已与磁盘同步';
  let saveFooterTone: 'normal' | 'saving' | 'error' | 'pending' = 'normal';
  if (corpus.saveStatus === 'error') {
    saveFooterText = corpus.lastSaveError
      ? `保存失败：${corpus.lastSaveError}`
      : '保存失败，请检查文件权限';
    saveFooterTone = 'error';
  } else if (isSaving) {
    saveFooterText =
      saveProgress && saveProgress.total > 0
        ? `正在保存 ${saveProgress.done}/${saveProgress.total}…`
        : '正在保存修改…';
    saveFooterTone = 'saving';
  } else if (unsavedCount > 0) {
    saveFooterText = resolvedDegraded
      ? `待保存 ${unsavedCount} 条（仅内存暂存）`
      : `待保存 ${unsavedCount} 条（已暂存本地防丢）`;
    saveFooterTone = 'pending';
  } else if (resolvedIndexDirty) {
    saveFooterText = '有未保存的项目状态变更';
    saveFooterTone = 'pending';
  }

  const ctxItem = ctxMenu ? corpus.itemMap[ctxMenu.itemId] ?? null : null;
  const ctxItemUnsaved = Boolean(ctxItem && unsavedSet.has(ctxItem.id));
  const ctxItemBackupTs = ctxItem ? backupTimestamps?.[ctxItem.id] ?? null : null;
  const showOpenAction = Boolean(ctxItem && ctxItem.id !== activeItemId);
  const showDraftActions = Boolean(
    ctxItem &&
      ((ctxItemUnsaved && ((corpus.writable && onSaveItem) || onRevertItem)) ||
        (ctxItemBackupTs && onRestoreItemBackup))
  );
  const showStatusSection = Boolean(ctxItem && showStatusMarks && onSetItemStatus);
  const showRevealSection = Boolean(ctxItem && canRevealItem && onRevealItem);

  const headBadgeText = showStatusMarks ? `${counts.done} / ${counts.all}` : `${counts.all} 条`;
  const headBadgeTitle = showStatusMarks
    ? `已完成 ${counts.done} 条，共 ${counts.all} 条`
    : `共 ${counts.all} 条词条`;

  const readonlyPendingCount = Math.max(unsavedCount, corpus.dirtyCount);

  return (
    <aside
      className={`corpus-sidebar ${sidebarOpen ? 'open' : 'collapsed'} ${resizing ? 'is-resizing resizing' : ''}`}
      aria-label="词条列表侧边栏"
    >
      {!sidebarOpen && (
        <div className="corpus-rail" aria-label="展开词条列表">
          <button
            type="button"
            className="corpus-rail-btn"
            title={
              showStatusMarks
                ? `展开词条列表 (${counts.done} / ${counts.all})`
                : `展开词条列表 (共 ${counts.all} 条)`
            }
            aria-label="展开词条列表"
            onClick={() => onToggleOpen(true)}
          >
            <CorpusSidebarToggleIcon collapsed size={15} />
          </button>
          <div className="corpus-rail-progress" title={headBadgeTitle}>
            {showStatusMarks ? (
              <>
                <span>{counts.done}</span>
                <span className="corpus-rail-divider" />
                <span>{counts.all}</span>
              </>
            ) : (
              <span>{counts.all}</span>
            )}
          </div>
          {unsavedCount > 0 && (
            <span
              className="corpus-rail-unsaved"
              title={`有 ${unsavedCount} 条词条未保存`}
              aria-label={`有 ${unsavedCount} 条词条未保存`}
            >
              {unsavedCount}
            </span>
          )}
        </div>
      )}

      <div
        className={`corpus-pane-shell ${resizing ? 'is-resizing' : ''}`}
        style={{ '--corpus-sidebar-w': `${sidebarWidth || DEFAULT_SIDEBAR_WIDTH}px` } as React.CSSProperties}
      >
        <div
          className={`corpus-pane ${resizing ? 'is-resizing' : ''}`}
          aria-hidden={!sidebarOpen}
        >
          <div className="corpus-pane-inner">
            <div className="corpus-head">
              <div className="corpus-head-left">
                <CorpusFolderIcon size={14} className="corpus-head-icon" />
                <span className="corpus-title" title={corpus.projectName}>
                  {corpus.projectName}
                </span>
                <span
                  className="sidebar-head-badge corpus-progress-badge"
                  title={headBadgeTitle}
                >
                  {headBadgeText}
                </span>
              </div>
              <button
                type="button"
                className="icon-btn compact sidebar-close-btn"
                title="收起词条列表"
                aria-label="收起词条列表"
                tabIndex={sidebarOpen ? 0 : -1}
                onClick={() => onToggleOpen(false)}
              >
                <CorpusSidebarToggleIcon size={14} />
              </button>
            </div>

            <div className="corpus-controls">
              <div className="corpus-search-box">
                <CorpusSearchIcon size={13} className="corpus-search-icon" />
                <input
                  ref={searchInputRef}
                  type="text"
                  className="corpus-search-input"
                  placeholder="搜索文件名、字词或音标"
                  aria-label="搜索词条"
                  tabIndex={sidebarOpen ? 0 : -1}
                  value={filter.query}
                  onChange={(e) => onChangeFilter({ query: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      if (filter.query) {
                        onChangeFilter({ query: '' });
                      } else {
                        searchInputRef.current?.blur();
                      }
                    }
                  }}
                />
                {filter.query && (
                  <button
                    type="button"
                    className="corpus-search-clear"
                    title="清空搜索"
                    aria-label="清空搜索"
                    tabIndex={sidebarOpen ? 0 : -1}
                    onClick={() => {
                      onChangeFilter({ query: '' });
                      searchInputRef.current?.focus();
                    }}
                  >
                    <CorpusCloseIcon size={10} />
                  </button>
                )}
              </div>

              {showStatusMarks && (
                <div className="corpus-filter-grid" role="group" aria-label="按标注状态筛选">
                  <button
                    type="button"
                    className={`corpus-filter-btn is-all ${filter.status === 'all' ? 'active-filter' : ''}`}
                    aria-pressed={filter.status === 'all'}
                    title={`全部 (${counts.all})`}
                    tabIndex={sidebarOpen ? 0 : -1}
                    onClick={() => onChangeFilter({ status: 'all' })}
                  >
                    <span className="corpus-filter-label">全部</span>
                    <span className="corpus-filter-meta">
                      <CorpusFilterAllIcon size={11} />
                      <span className="corpus-filter-count">{counts.all}</span>
                    </span>
                  </button>

                  {CORPUS_STATUS_ORDER.map((status) => {
                    const isSelected = filter.status === status;
                    const meta = CORPUS_STATUS_META[status];
                    return (
                      <button
                        key={status}
                        type="button"
                        className={`corpus-filter-btn is-${status} ${isSelected ? 'active-filter' : ''}`}
                        aria-pressed={isSelected}
                        title={`${meta.label} (${counts[status]})`}
                        tabIndex={sidebarOpen ? 0 : -1}
                        onClick={() => onChangeFilter({ status })}
                      >
                        <span className="corpus-filter-label">{meta.label}</span>
                        <span className="corpus-filter-meta">
                          <CorpusStatusIcon status={status} size={11} />
                          <span className="corpus-filter-count">{counts[status]}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div
              ref={listViewportRef}
              className="corpus-list-viewport"
              role="listbox"
              aria-label="词条列表"
              onScroll={(e) => {
                setScrollTop(e.currentTarget.scrollTop);
                if (ctxMenu) setCtxMenu(null);
              }}
            >
              {filteredIndexed.length === 0 ? (
                <div className="corpus-list-empty">
                  <p className="corpus-list-empty-text">
                    {items.length === 0 ? '该文件夹中未找到音频文件' : '没有符合条件的词条'}
                  </p>
                  {hasActiveFilter && (
                    <button
                      type="button"
                      className="compact"
                      tabIndex={sidebarOpen ? 0 : -1}
                      onClick={() => onChangeFilter({ query: '', status: 'all' })}
                    >
                      显示全部词条
                    </button>
                  )}
                </div>
              ) : (
                <div className="corpus-list-spacer" style={{ height: totalHeight }}>
                  <div
                    className="corpus-list-slice"
                    style={{ transform: `translateY(${offsetY}px)` }}
                  >
                    {visibleSlice.map(({ item, order }) => {
                      const isActive = item.id === activeItemId;
                      const isCtxTarget = ctxMenu?.itemId === item.id;
                      const isItemUnsaved = unsavedSet.has(item.id);
                      const parseError = (item as CorpusItemRecord & { parseError?: string }).parseError;
                      const durText = formatDurationShort(item.duration);
                      const displayTitle = item.label || item.id;
                      const showSubId = !item.ipaPreview && item.label && item.label !== item.id;
                      return (
                        <div
                          key={item.id}
                          role="option"
                          aria-selected={isActive}
                          tabIndex={sidebarOpen ? 0 : -1}
                          className={`corpus-row is-${item.status} ${isActive ? 'is-active' : ''} ${isCtxTarget ? 'is-ctx-target' : ''} ${isItemUnsaved ? 'is-unsaved' : ''} ${!showStatusMarks ? 'no-status-mark' : ''} ${item.missing ? 'is-missing' : ''}`}
                          style={{ height: ROW_HEIGHT }}
                          title={`${order}. ${displayTitle} (${item.audioRelPath})${isItemUnsaved ? ' [未保存]' : ''}${parseError ? ` [原文件损坏：${parseError}]` : ''}${item.ipaPreview ? ` — ${item.ipaPreview}` : ''}`}
                          onClick={() => onSelectItem(item.id)}
                          onContextMenu={(e) => handleRowContextMenu(e, item.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onSelectItem(item.id);
                            }
                          }}
                        >
                          {showStatusMarks && (
                            <span
                              className="corpus-row-status"
                              title={CORPUS_STATUS_META[item.status].label}
                            >
                              <CorpusStatusIcon status={item.status} size={13} />
                            </span>
                          )}

                          <div className="corpus-row-main">
                            <div className="corpus-row-top">
                              <span className="corpus-row-order">{order}</span>
                              {isItemUnsaved && (
                                <span
                                  className="corpus-row-dirty-dot"
                                  title="有未保存修改"
                                  aria-label="未保存"
                                />
                              )}
                              <span className="corpus-row-title">{displayTitle}</span>
                            </div>
                            <div className="corpus-row-sub">
                              {item.ipaPreview ? (
                                <span className="corpus-row-ipa">{item.ipaPreview}</span>
                              ) : showSubId ? (
                                <span className="corpus-row-placeholder">{item.id}</span>
                              ) : (
                                <span className="corpus-row-placeholder">
                                  {item.hasTextGrid ? '已有标注文件' : '未填写音标'}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="corpus-row-right">
                            {parseError ? (
                              <span className="corpus-row-missing" title={parseError}>
                                损坏
                              </span>
                            ) : item.missing ? (
                              <span className="corpus-row-missing">缺失</span>
                            ) : (
                              durText && <span className="corpus-row-dur">{durText}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className={`corpus-footer ${!corpus.writable ? 'is-readonly' : ''}`}>
              {resolvedDegraded && (
                <div
                  className="corpus-footer-degraded"
                  title="当前单文件离线环境下浏览器禁用了本地存储缓存，关闭页面前请及时导出 (.zip)"
                >
                  单文件离线模式下浏览器禁用本地缓存，请阶段性导出 (.zip) 保存进度
                </div>
              )}

              {!corpus.writable ? (
                <div className="corpus-footer-readonly">
                  <div className="corpus-footer-status-row">
                    <span
                      className="corpus-footer-note"
                      title={corpus.readOnlyReason || '当前浏览器不支持直接写入文件夹，修改已暂存在本地'}
                    >
                      {readonlyPendingCount > 0
                        ? `只读模式 · 已暂存 ${readonlyPendingCount} 项修改`
                        : corpus.readOnlyReason || '浏览器只读模式，可打包导出修改'}
                    </span>
                    {unsavedCount > 0 && onDiscardAllDrafts && (
                      <button
                        type="button"
                        className="corpus-footer-link-btn"
                        tabIndex={sidebarOpen ? 0 : -1}
                        title="放弃全部已暂存修改"
                        onClick={onDiscardAllDrafts}
                      >
                        放弃
                      </button>
                    )}
                  </div>
                  {onExportModifiedZip && (
                    <button
                      type="button"
                      className="compact primary corpus-export-zip-btn"
                      disabled={exportingZip}
                      tabIndex={sidebarOpen ? 0 : -1}
                      title="将已修改的标注文件与项目索引打包导出为 .zip"
                      onClick={onExportModifiedZip}
                    >
                      <CorpusExportZipIcon size={12} />
                      <span>
                        {exportingZip
                          ? '导出中…'
                          : readonlyPendingCount > 0
                            ? `导出修改 (.zip) (${readonlyPendingCount})`
                            : '导出修改 (.zip)'}
                      </span>
                    </button>
                  )}
                </div>
              ) : (
                <div className="corpus-footer-writable">
                  <div className="corpus-footer-status-row">
                    <div className={`corpus-footer-save is-${saveFooterTone}`} title={saveFooterText}>
                      <CorpusSaveIcon size={12} />
                      <span className="corpus-footer-save-text">{saveFooterText}</span>
                    </div>
                    {unsavedCount > 0 && onDiscardAllDrafts && !isSaving && (
                      <button
                        type="button"
                        className="corpus-footer-link-btn"
                        tabIndex={sidebarOpen ? 0 : -1}
                        title="放弃全部未保存词条修改，恢复磁盘原文件"
                        onClick={onDiscardAllDrafts}
                      >
                        放弃全部
                      </button>
                    )}
                  </div>

                  <div className="corpus-footer-actions">
                    {onSaveAll && (
                      <button
                        type="button"
                        className={`compact corpus-save-all-btn ${hasPendingSave ? 'primary' : ''}`}
                        disabled={!hasPendingSave || isSaving}
                        tabIndex={sidebarOpen ? 0 : -1}
                        title={`批量将全部未保存词条写回原文件夹 (${formatKeyCombo('Mod+Alt+S')})`}
                        onClick={onSaveAll}
                      >
                        <CorpusSaveIcon size={12} />
                        <span>
                          {isSaving && saveProgress && saveProgress.total > 0
                            ? `正在保存 ${saveProgress.done}/${saveProgress.total}…`
                            : isSaving
                              ? '正在保存…'
                              : unsavedCount > 0
                                ? `保存全部 (${unsavedCount})`
                                : resolvedIndexDirty
                                  ? '保存状态'
                                  : '保存全部'}
                        </span>
                      </button>
                    )}

                    {onToggleAutoSave && (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={corpusAutoSave}
                        className={`compact corpus-autosave-toggle ${corpusAutoSave ? 'is-on' : ''}`}
                        tabIndex={sidebarOpen ? 0 : -1}
                        title={
                          corpusAutoSave
                            ? '自动保存已开启（覆盖原文件前会保留 7 天编辑前备份）；点击关闭'
                            : '自动保存默认关闭，避免误操作覆盖原文件；点击开启'
                        }
                        onClick={onToggleAutoSave}
                      >
                        <span className="corpus-switch-track" aria-hidden="true">
                          <span className="corpus-switch-thumb" />
                        </span>
                        <span>自动保存</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {sidebarOpen && (
          <div
            className="corpus-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整词条列表宽度"
            title="左右拖拽调整宽度，拖窄收起，双击恢复默认"
            onPointerDown={handleResizePointerDown}
            onDoubleClick={() => onResizeWidth(DEFAULT_SIDEBAR_WIDTH)}
          />
        )}
      </div>

      {ctxMenu &&
        ctxItem &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={ctxMenuRef}
            className="context-menu open corpus-ctx-menu"
            role="menu"
            aria-label="词条操作菜单"
            style={{
              left: ctxPos ? ctxPos.left : ctxMenu.x,
              top: ctxPos ? ctxPos.top : ctxMenu.y
            }}
            onMouseDown={(e) => e.preventDefault()}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {showOpenAction && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const targetId = ctxItem.id;
                  setCtxMenu(null);
                  onSelectItem(targetId);
                }}
              >
                <span className="ctx-item-main">
                  <span className="ctx-item-icon" aria-hidden="true">
                    <CorpusNextIcon size={13} />
                  </span>
                  <span>打开此条</span>
                </span>
              </button>
            )}

            {showDraftActions && (
              <>
                {showOpenAction && <div className="menu-divider" />}
                {ctxItemUnsaved && corpus.writable && onSaveItem && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const targetId = ctxItem.id;
                      setCtxMenu(null);
                      onSaveItem(targetId);
                    }}
                  >
                    <span className="ctx-item-main">
                      <span className="ctx-item-icon" aria-hidden="true">
                        <CorpusSaveIcon size={13} />
                      </span>
                      <span>保存此条</span>
                    </span>
                  </button>
                )}
                {ctxItemUnsaved && onRevertItem && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const targetId = ctxItem.id;
                      setCtxMenu(null);
                      onRevertItem(targetId);
                    }}
                  >
                    <span className="ctx-item-main">
                      <span className="ctx-item-icon" aria-hidden="true">
                        <UiIcon name="undo" size={13} />
                      </span>
                      <span>还原为磁盘原文件</span>
                    </span>
                  </button>
                )}
                {ctxItemBackupTs && onRestoreItemBackup && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const targetId = ctxItem.id;
                      setCtxMenu(null);
                      onRestoreItemBackup(targetId);
                    }}
                  >
                    <span className="ctx-item-main">
                      <span className="ctx-item-icon" aria-hidden="true">
                        <UiIcon name="history" size={13} />
                      </span>
                      <span>恢复为编辑前备份（{formatBackupTime(ctxItemBackupTs)}）</span>
                    </span>
                  </button>
                )}
              </>
            )}

            {showStatusSection && (
              <>
                {(showOpenAction || showDraftActions) && <div className="menu-divider" />}
                {CORPUS_STATUS_ORDER.map((status) => {
                  const meta = CORPUS_STATUS_META[status];
                  const isCurrent = ctxItem.status === status;
                  return (
                    <button
                      key={status}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isCurrent}
                      className={isCurrent ? 'corpus-ctx-selected' : ''}
                      onClick={() => {
                        const targetId = ctxItem.id;
                        setCtxMenu(null);
                        onSetItemStatus?.(targetId, status);
                      }}
                    >
                      <span className="ctx-item-main">
                        <span className="ctx-item-icon" aria-hidden="true">
                          <CorpusStatusIcon status={status} size={13} />
                        </span>
                        <span>标记为{meta.label}</span>
                      </span>
                      {isCurrent && <span className="corpus-ctx-current-mark" aria-hidden="true" />}
                    </button>
                  );
                })}
              </>
            )}

            {(showOpenAction || showDraftActions || showStatusSection) && (
              <div className="menu-divider" />
            )}

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const fileName = getFileBaseName(ctxItem.audioRelPath);
                setCtxMenu(null);
                handleCopyText(fileName, '文件名');
              }}
            >
              <span className="ctx-item-main">
                <span className="ctx-item-icon" aria-hidden="true">
                  <UiIcon name="copy" size={13} />
                </span>
                <span>复制文件名</span>
              </span>
            </button>

            <button
              type="button"
              role="menuitem"
              disabled={!ctxItem.ipaPreview.trim()}
              title={ctxItem.ipaPreview.trim() ? `复制音标：${ctxItem.ipaPreview}` : '该词条尚未填写音标'}
              onClick={() => {
                const ipa = ctxItem.ipaPreview.trim();
                setCtxMenu(null);
                if (ipa) handleCopyText(ipa, '音标');
              }}
            >
              <span className="ctx-item-main">
                <span className="ctx-item-icon" aria-hidden="true">
                  <UiIcon name="copy" size={13} />
                </span>
                <span>复制音标</span>
              </span>
            </button>

            {showRevealSection && (
              <>
                <div className="menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  disabled={Boolean(ctxItem.missing)}
                  title={ctxItem.missing ? '对应音频文件已缺失' : ctxItem.audioRelPath}
                  onClick={() => {
                    const targetId = ctxItem.id;
                    setCtxMenu(null);
                    onRevealItem?.(targetId);
                  }}
                >
                  <span className="ctx-item-main">
                    <span className="ctx-item-icon" aria-hidden="true">
                      <UiIcon name="folder" size={13} />
                    </span>
                    <span>在文件夹中显示</span>
                  </span>
                </button>
              </>
            )}
          </div>,
          document.body
        )}
    </aside>
  );
};
