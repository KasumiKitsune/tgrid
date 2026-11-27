import React, { useMemo } from 'react';
import {
  AutoPlayIcon,
  AutoSplitIcon,
  CORPUS_STATUS_META,
  CORPUS_STATUS_ORDER,
  CorpusNextIcon,
  CorpusPrevIcon,
  CorpusSaveIcon,
  CorpusSidebarToggleIcon,
  CorpusStatusIcon
} from '../corpus/corpusIcons';
import type { CorpusItemStatus, CorpusProjectState } from '../corpus/types';

export interface CorpusNavBarProps {
  corpus: CorpusProjectState;
  /** 当前编辑区是否存在尚未落盘的修改 */
  isDirty?: boolean;
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
  /** 切换切条后自动播放开关 */
  onToggleAutoPlay: () => void;
  /** 切换静音自动切分开关 */
  onToggleAutoVad: () => void;
}

export const CorpusNavBar: React.FC<CorpusNavBarProps> = ({
  corpus,
  isDirty = false,
  showStatusMarks = true,
  currentIndex,
  totalCount,
  canPrev,
  canNext,
  onToggleSidebar,
  onPrev,
  onNext,
  onSetStatus,
  onToggleAutoPlay,
  onToggleAutoVad
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

  let saveBadgeLabel = '已保存';
  let saveBadgeTone: 'saved' | 'saving' | 'dirty' | 'readonly' | 'error' = 'saved';
  let saveBadgeTitle = '修改会自动写回当前文件夹';

  if (corpus.saveStatus === 'error') {
    saveBadgeLabel = '保存失败';
    saveBadgeTone = 'error';
    saveBadgeTitle = corpus.lastSaveError || '自动保存失败，请检查文件是否被占用';
  } else if (corpus.saveStatus === 'saving') {
    saveBadgeLabel = '保存中';
    saveBadgeTone = 'saving';
    saveBadgeTitle = '正在自动写入标注文件';
  } else if (!corpus.writable) {
    saveBadgeLabel = isDirty || corpus.dirtyCount > 0 ? '暂存本地' : '只读模式';
    saveBadgeTone = 'readonly';
    saveBadgeTitle = corpus.readOnlyReason || '浏览器只读模式，修改暂存本地，可在左侧底部导出 (.zip)';
  } else if (isDirty) {
    saveBadgeLabel = '待保存';
    saveBadgeTone = 'dirty';
    saveBadgeTitle = '有未写入的修改，即将自动保存';
  }

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

        <div className="segmented" role="group" aria-label="切换词条">
          <button
            type="button"
            className="compact"
            disabled={!resolvedCanPrev}
            title="上一条词条 (Alt+[)"
            onClick={onPrev}
          >
            <CorpusPrevIcon size={13} />
            <span>上一条</span>
          </button>
          <button
            type="button"
            className="compact"
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

      {showStatusMarks && (
        <div
          className="segmented corpus-status-group"
          role="group"
          aria-label="词条标注状态"
          onMouseDown={(e) => e.preventDefault()}
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
                disabled={!activeItem}
                aria-pressed={isSelected}
                title={tooltip}
                onClick={() => onSetStatus(status)}
              >
                <CorpusStatusIcon status={status} size={12} />
                <span>{meta.label}</span>
              </button>
            );
          })}
        </div>
      )}

      <div
        className="corpus-navbar-group corpus-navbar-right"
        onMouseDown={(e) => e.preventDefault()}
      >
        <button
          type="button"
          className={`compact corpus-toggle-btn ${corpus.options.autoPlay ? 'is-on' : ''}`}
          aria-pressed={corpus.options.autoPlay}
          title="切换词条后自动播放当前语音段"
          onClick={onToggleAutoPlay}
        >
          <AutoPlayIcon size={13} />
          <span>自动播放</span>
        </button>

        <button
          type="button"
          className={`compact corpus-toggle-btn ${corpus.options.autoVad ? 'is-on' : ''}`}
          aria-pressed={corpus.options.autoVad}
          title="打开无标注文件的音频时，自动按静音切分起止边界"
          onClick={onToggleAutoVad}
        >
          <AutoSplitIcon size={13} />
          <span>自动切分</span>
        </button>

        <span
          className={`corpus-save-badge is-${saveBadgeTone}`}
          title={saveBadgeTitle}
          aria-live="polite"
        >
          <CorpusSaveIcon size={11} />
          <span>{saveBadgeLabel}</span>
        </span>
      </div>
    </div>
  );
};
