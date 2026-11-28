import React, { useMemo } from 'react';
import {
  CORPUS_STATUS_META,
  CORPUS_STATUS_ORDER,
  CorpusExportZipIcon,
  CorpusNextIcon,
  CorpusPrevIcon,
  CorpusSaveIcon,
  CorpusSidebarToggleIcon,
  CorpusStatusIcon
} from '../corpus/corpusIcons';
import type { CorpusItemStatus, CorpusProjectState } from '../corpus/types';
import { formatKeyCombo } from '../shortcuts/registry';
import { UiIcon } from './Icons';

export interface CorpusNavBarProps {
  corpus: CorpusProjectState;
  /** 当前编辑区是否存在尚未落盘的修改 */
  isDirty?: boolean;
  /** 是否开启自动保存 */
  corpusAutoSave?: boolean;
  /** 全部待保存词条 ID 列表 */
  unsavedItemIds?: readonly string[];
  /** 项目索引是否有未写入的状态/配置变更 */
  projectIndexDirty?: boolean;
  /** 批量保存进度 */
  saveProgress?: { done: number; total: number } | null;
  /** 当前词条是否存在自动保存覆写前的原件备份 */
  activeItemBackupTime?: number | null;
  /** 当前词条是否存在原文件解析损坏告警 */
  activeItemParseError?: string | null;
  /** 是否显示词条四态切换按钮组（默认 true） */
  showStatusMarks?: boolean;
  /** 当前词条在当前筛选列表中的位置（0-based），未提供时按全量列表计算 */
  currentIndex?: number;
  /** 当前导航序列总条数，未提供时按全量列表计算 */
  totalCount?: number;
  /** 是否可切换至上一条 / 下一条 */
  canPrev?: boolean;
  canNext?: boolean;
  /** 展开或收起左侧词条列表 */
  onToggleSidebar: () => void;
  /** 切换至上一条词条 */
  onPrev: () => void;
  /** 切换至下一条词条 */
  onNext: () => void;
  /** 一键设置当前词条状态 */
  onSetStatus: (status: CorpusItemStatus) => void;
  /** 保存当前词条 */
  onSaveCurrent?: () => void;
  /** 保存全部待保存词条 */
  onSaveAll?: () => void;
  /** 还原当前词条为磁盘原文件 */
  onRevertCurrent?: () => void;
  /** 恢复当前词条的编辑前原件备份 */
  onRestoreBackupCurrent?: () => void;
  /** 只读模式下导出修改包 */
  onExportModifiedZip?: () => void;
  exportingZip?: boolean;
  /** @deprecated 已迁入顶部「词表」页签，保留可选以兼容旧调用 */
  onToggleAutoPlay?: () => void;
  /** @deprecated 已迁入顶部「词表」页签，保留可选以兼容旧调用 */
  onToggleAutoVad?: () => void;
}

function formatShortClock(ts: number): string {
  try {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

export const CorpusNavBar: React.FC<CorpusNavBarProps> = ({
  corpus,
  isDirty = false,
  corpusAutoSave = false,
  unsavedItemIds,
  projectIndexDirty = false,
  saveProgress = null,
  activeItemBackupTime = null,
  activeItemParseError = null,
  showStatusMarks = true,
  currentIndex,
  totalCount,
  canPrev,
  canNext,
  onToggleSidebar,
  onPrev,
  onNext,
  onSetStatus,
  onSaveCurrent,
  onSaveAll,
  onRevertCurrent,
  onRestoreBackupCurrent,
  onExportModifiedZip,
  exportingZip = false
}) => {
  const activeItem = corpus.activeItemId ? corpus.itemMap[corpus.activeItemId] ?? null : null;

  const fallbackIndex = useMemo(() => {
    if (!corpus.activeItemId) return -1;
    return corpus.items.findIndex((it) => it.id === corpus.activeItemId);
  }, [corpus.items, corpus.activeItemId]);

  const resolvedIndex = currentIndex !== undefined ? currentIndex : fallbackIndex;
  const resolvedTotal = totalCount !== undefined ? totalCount : corpus.items.length;
  const resolvedCanPrev =
    canPrev !== undefined ? canPrev : resolvedIndex > 0 && resolvedTotal > 0;
  const resolvedCanNext =
    canNext !== undefined
      ? canNext
      : resolvedTotal > 0 && (resolvedIndex === -1 || resolvedIndex < resolvedTotal - 1);

  const displayName = activeItem ? activeItem.label || activeItem.id : '未选择词条';
  const positionText =
    resolvedIndex >= 0 && resolvedTotal > 0
      ? `${resolvedIndex + 1} / ${resolvedTotal}`
      : `0 / ${resolvedTotal}`;

  const corpusExt = corpus as CorpusProjectState & {
    unsavedItemIds?: string[];
    projectIndexDirty?: boolean;
  };
  const resolvedUnsavedIds = unsavedItemIds ?? corpusExt.unsavedItemIds ?? [];
  const resolvedIndexDirty = projectIndexDirty || Boolean(corpusExt.projectIndexDirty);
  const activeId = corpus.activeItemId;
  const isCurrentUnsaved = Boolean(
    isDirty || (activeId && resolvedUnsavedIds.includes(activeId))
  );
  const totalUnsavedItems = useMemo(() => {
    const set = new Set<string>(resolvedUnsavedIds);
    if (isDirty && activeId) set.add(activeId);
    return set.size;
  }, [resolvedUnsavedIds, isDirty, activeId]);
  const otherUnsavedCount = Math.max(0, totalUnsavedItems - (isCurrentUnsaved ? 1 : 0));

  const isSaving = corpus.saveStatus === 'saving';
  const isError = corpus.saveStatus === 'error';
  const parseErr =
    activeItemParseError ??
    (activeItem as (typeof activeItem & { parseError?: string }) | null)?.parseError ??
    null;

  return (
    <div className="corpus-navbar" role="region" aria-label="词条快速导航栏">
      <div className="corpus-navbar-group corpus-navbar-left">
        {!corpus.sidebarOpen && (
          <>
            <button
              type="button"
              className="compact corpus-nav-expand-btn"
              title="展开左侧词条列表"
              aria-label="展开左侧词条列表"
              onClick={onToggleSidebar}
            >
              <CorpusSidebarToggleIcon collapsed size={13} />
              <span>词条列表</span>
            </button>
            <div className="sep" />
          </>
        )}

        <div className="corpus-nav-step-group" role="group" aria-label="切换词条">
          <button
            type="button"
            className="compact corpus-nav-step-btn"
            disabled={!resolvedCanPrev}
            title="上一条词条 (Alt+[)"
            onClick={onPrev}
          >
            <CorpusPrevIcon size={13} />
            <span>上一条</span>
          </button>
          <button
            type="button"
            className="compact corpus-nav-step-btn"
            disabled={!resolvedCanNext}
            title="下一条词条 (Alt+])"
            onClick={onNext}
          >
            <span>下一条</span>
            <CorpusNextIcon size={13} />
          </button>
        </div>

        <div
          className="corpus-nav-current"
          title={activeItem ? `${positionText}  ${displayName} (${activeItem.audioRelPath})` : positionText}
        >
          <span className="corpus-nav-pos">{positionText}</span>
          <span className="corpus-nav-name">{displayName}</span>
        </div>
      </div>

      <div
        className="corpus-navbar-group corpus-navbar-right"
        onMouseDown={(e) => e.preventDefault()}
      >
        {showStatusMarks && (
          <>
            <div
              className="corpus-status-group"
              role="group"
              aria-label="词条标注状态"
            >
              {CORPUS_STATUS_ORDER.map((status) => {
                const meta = CORPUS_STATUS_META[status];
                const isSelected = activeItem?.status === status;
                const tooltip = meta.shortcut
                  ? `标记为${meta.label} (${meta.shortcut} 标记并下一条)`
                  : `标记为${meta.label}`;
                return (
                  <button
                    key={status}
                    type="button"
                    className={`compact corpus-status-btn is-${status} ${isSelected ? 'is-selected' : ''}`}
                    disabled={!activeItem || Boolean(parseErr)}
                    aria-pressed={isSelected}
                    title={parseErr ? '原文件解析损坏，已开启只读保护' : tooltip}
                    onClick={() => onSetStatus(status)}
                  >
                    <CorpusStatusIcon status={status} size={12} />
                    <span>{meta.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="sep corpus-navbar-sep" />
          </>
        )}

        <div className="corpus-nav-save-group" aria-live="polite">
          {parseErr ? (
            <span
              className="corpus-save-badge is-error"
              title={`磁盘原文件解析失败，已进入只读保护以防覆盖原文件：${parseErr}`}
            >
              <UiIcon name="warning" size={11} />
              <span>原文件损坏（只读）</span>
            </span>
          ) : isSaving ? (
            <span className="corpus-save-badge is-saving" title="正在将修改原子写回原文件夹">
              <CorpusSaveIcon size={11} />
              <span>
                {saveProgress && saveProgress.total > 0
                  ? `正在保存 ${saveProgress.done}/${saveProgress.total}…`
                  : '保存中…'}
              </span>
            </span>
          ) : isError ? (
            <>
              <span
                className="corpus-save-badge is-error"
                title={corpus.lastSaveError || '保存失败，请检查文件权限或是否被外部占用'}
              >
                <UiIcon name="warning" size={11} />
                <span>保存失败</span>
              </span>
              {corpus.writable && onSaveCurrent && (
                <button
                  type="button"
                  className="compact corpus-nav-action-btn is-primary"
                  title="重试保存当前词条"
                  onClick={onSaveCurrent}
                >
                  <span>重试保存</span>
                </button>
              )}
            </>
          ) : !corpus.writable ? (
            <>
              <span
                className="corpus-save-badge is-readonly"
                title={corpus.readOnlyReason || '只读模式，修改已暂存本地，可打包导出 (.zip)'}
              >
                <CorpusSaveIcon size={11} />
                <span>
                  {totalUnsavedItems > 0
                    ? `已暂存 ${totalUnsavedItems} 条`
                    : corpus.dirtyCount > 0
                      ? `已暂存 ${corpus.dirtyCount} 项`
                      : '只读模式'}
                </span>
              </span>
              {isCurrentUnsaved && onRevertCurrent && (
                <button
                  type="button"
                  className="compact corpus-nav-action-btn"
                  title="放弃当前词条修改，还原为打开时的磁盘原文件"
                  onClick={onRevertCurrent}
                >
                  <span>还原</span>
                </button>
              )}
              {onExportModifiedZip && (totalUnsavedItems > 0 || corpus.dirtyCount > 0) && (
                <button
                  type="button"
                  className="compact corpus-nav-action-btn is-primary"
                  disabled={exportingZip}
                  title="将已暂存修改打包导出为 .zip"
                  onClick={onExportModifiedZip}
                >
                  <CorpusExportZipIcon size={11} />
                  <span>{exportingZip ? '导出中…' : '导出 (.zip)'}</span>
                </button>
              )}
            </>
          ) : isCurrentUnsaved ? (
            <>
              <span
                className="corpus-save-badge is-dirty"
                title="当前词条有未保存修改（已暂存本地防丢），未覆盖磁盘原文件"
              >
                <span className="corpus-save-dot" aria-hidden="true" />
                <span>未保存</span>
              </span>
              {onSaveCurrent && (
                <button
                  type="button"
                  className="compact corpus-nav-action-btn is-primary"
                  title={`保存当前词条到原文件夹 (${formatKeyCombo('Mod+S')})`}
                  onClick={onSaveCurrent}
                >
                  <span>保存</span>
                </button>
              )}
              {onRevertCurrent && (
                <button
                  type="button"
                  className="compact corpus-nav-action-btn"
                  title="放弃当前词条的未保存修改，还原为磁盘原文件"
                  onClick={onRevertCurrent}
                >
                  <span>还原</span>
                </button>
              )}
              {otherUnsavedCount > 0 && onSaveAll && (
                <button
                  type="button"
                  className="compact corpus-nav-action-btn"
                  title={`保存全部 ${totalUnsavedItems} 条未保存词条 (${formatKeyCombo('Mod+Alt+S')})`}
                  onClick={onSaveAll}
                >
                  <span>全部 ({totalUnsavedItems})</span>
                </button>
              )}
            </>
          ) : otherUnsavedCount > 0 || resolvedIndexDirty ? (
            <>
              <span
                className="corpus-save-badge is-dirty"
                title={
                  otherUnsavedCount > 0
                    ? `当前词条无更改，另有 ${otherUnsavedCount} 条词条待保存`
                    : '项目索引状态有未保存更改'
                }
              >
                <span className="corpus-save-dot" aria-hidden="true" />
                <span>
                  {otherUnsavedCount > 0 ? `另有 ${otherUnsavedCount} 条待保存` : '状态待保存'}
                </span>
              </span>
              {onSaveAll && (
                <button
                  type="button"
                  className="compact corpus-nav-action-btn is-primary"
                  title={`批量保存全部未保存词条 (${formatKeyCombo('Mod+Alt+S')})`}
                  onClick={onSaveAll}
                >
                  <span>保存全部</span>
                </button>
              )}
            </>
          ) : (
            <>
              <span
                className="corpus-save-badge is-saved"
                title={
                  corpusAutoSave
                    ? '自动保存已开启 · 所有词条已同步到文件夹'
                    : '所有词条已与磁盘同步'
                }
              >
                <CorpusSaveIcon size={11} />
                <span>{corpusAutoSave ? '已同步 · 自动保存' : '已同步'}</span>
              </span>
              {activeItemBackupTime && onRestoreBackupCurrent && (
                <button
                  type="button"
                  className="compact corpus-nav-action-btn"
                  title={`恢复为自动保存覆写前的编辑前备份 (${formatShortClock(activeItemBackupTime)})`}
                  onClick={onRestoreBackupCurrent}
                >
                  <span>恢复备份</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
