import React from 'react';
import { TGridIcon } from '@tgrid/icons';
import type { CorpusItemStatus } from './types';

export interface CorpusIconProps {
  size?: number;
  className?: string;
}

function joinClasses(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(' ');
}

/* ============================================================================
 * 1. 直接复用 @tgrid/icons 已有图标
 * ============================================================================ */

export const CorpusSearchIcon: React.FC<CorpusIconProps> = ({ size = 13, className }) => (
  <TGridIcon name="search" size={size} className={joinClasses('ui-icon', className)} />
);

export const CorpusCloseIcon: React.FC<CorpusIconProps> = ({ size = 11, className }) => (
  <TGridIcon name="CloseIcon" size={size} className={joinClasses('ui-icon', className)} />
);

export const StatusDoneIcon: React.FC<CorpusIconProps> = ({ size = 13, className }) => (
  <TGridIcon name="check" size={size} className={joinClasses('ui-icon', className)} />
);

export const StatusDoubtIcon: React.FC<CorpusIconProps> = ({ size = 13, className }) => (
  <TGridIcon name="warning" size={size} className={joinClasses('ui-icon', className)} />
);

export const CorpusSaveIcon: React.FC<CorpusIconProps> = ({ size = 12, className }) => (
  <TGridIcon name="save" size={size} className={joinClasses('ui-icon', className)} />
);

export const CorpusExportIcon: React.FC<CorpusIconProps> = ({ size = 13, className }) => (
  <TGridIcon name="export" size={size} className={joinClasses('ui-icon', className)} />
);

/* ============================================================================
 * 2. Phase 1 新增专用图标（均已编译接入 @tgrid/icons）
 * ============================================================================ */

/** 词表文件夹项目图标 */
export const CorpusFolderIcon: React.FC<CorpusIconProps> = ({ size = 14, className }) => (
  <TGridIcon
    name="corpusFolder"
    size={size}
    className={joinClasses('ui-icon corpus-icon-folder', className)}
  />
);

/** 展开 / 收起左侧词条列表图标（collapsed 为 true 时水平翻转尖角方向，左侧窗格位置不变） */
export const CorpusSidebarToggleIcon: React.FC<CorpusIconProps & { collapsed?: boolean }> = ({
  size = 14,
  className,
  collapsed = false
}) => (
  <TGridIcon
    name="corpusSidebarToggle"
    size={size}
    className={joinClasses(
      'ui-icon corpus-icon-sidebar-toggle',
      collapsed && 'is-collapsed',
      className
    )}
  />
);

/** 词条状态：未标 */
export const StatusTodoIcon: React.FC<CorpusIconProps> = ({ size = 13, className }) => (
  <TGridIcon
    name="statusPending"
    size={size}
    className={joinClasses('ui-icon corpus-icon-status-todo', className)}
  />
);

export const StatusPendingIcon = StatusTodoIcon;

/** 词条状态：需重录 */
export const StatusTrashIcon: React.FC<CorpusIconProps> = ({ size = 13, className }) => (
  <TGridIcon
    name="statusRetake"
    size={size}
    className={joinClasses('ui-icon corpus-icon-status-trash', className)}
  />
);

export const StatusRetakeIcon = StatusTrashIcon;

/** 上一条词条图标 */
export const CorpusPrevIcon: React.FC<CorpusIconProps> = ({ size = 13, className }) => (
  <TGridIcon
    name="corpusPrev"
    size={size}
    className={joinClasses('ui-icon corpus-icon-prev', className)}
  />
);

/** 下一条词条图标 */
export const CorpusNextIcon: React.FC<CorpusIconProps> = ({ size = 13, className }) => (
  <TGridIcon
    name="corpusNext"
    size={size}
    className={joinClasses('ui-icon corpus-icon-next', className)}
  />
);

/** 自动播放开关图标 */
export const AutoPlayIcon: React.FC<CorpusIconProps> = ({ size = 13, className }) => (
  <TGridIcon
    name="autoPlay"
    size={size}
    className={joinClasses('ui-icon corpus-icon-autoplay', className)}
  />
);

/** 静音自动切分开关图标 */
export const AutoSplitIcon: React.FC<CorpusIconProps> = ({ size = 13, className }) => (
  <TGridIcon
    name="autoSplit"
    size={size}
    className={joinClasses('ui-icon corpus-icon-autosplit', className)}
  />
);

/** 词条列表 / 全部筛选图标 */
export const CorpusFilterAllIcon: React.FC<CorpusIconProps> = ({ size = 14, className }) => (
  <TGridIcon
    name="corpusFilterAll"
    size={size}
    className={joinClasses('ui-icon corpus-icon-list', className)}
  />
);

/** 导出修改包 (.zip) 图标 */
export const CorpusExportZipIcon: React.FC<CorpusIconProps> = ({ size = 13, className }) => (
  <TGridIcon
    name="corpusExportZip"
    size={size}
    className={joinClasses('ui-icon corpus-icon-export-zip', className)}
  />
);

/* ============================================================================
 * 3. 状态图标分发与朴素中文元信息
 * ============================================================================ */

export const CORPUS_STATUS_ORDER: readonly CorpusItemStatus[] = ['todo', 'done', 'doubt', 'trash'];

export const CORPUS_STATUS_META: Record<
  CorpusItemStatus,
  { label: string; shortcut?: string }
> = {
  todo: { label: '未标' },
  done: { label: '已完成', shortcut: 'Alt+Enter' },
  doubt: { label: '存疑', shortcut: 'Alt+M' },
  trash: { label: '需重录', shortcut: 'Alt+X' }
};

export const CorpusStatusIcon: React.FC<
  CorpusIconProps & { status: CorpusItemStatus }
> = ({ status, size = 13, className }) => {
  switch (status) {
    case 'done':
      return <StatusDoneIcon size={size} className={className} />;
    case 'doubt':
      return <StatusDoubtIcon size={size} className={className} />;
    case 'trash':
      return <StatusTrashIcon size={size} className={className} />;
    case 'todo':
    default:
      return <StatusTodoIcon size={size} className={className} />;
  }
};
