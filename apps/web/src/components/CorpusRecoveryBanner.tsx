import React from 'react';
import { CorpusExportZipIcon } from '../corpus/corpusIcons';
import { UiIcon } from './Icons';

export interface CorpusRecoveryBannerProps {
  /** 项目名称 */
  projectName: string;
  /** 待恢复的词条草稿数量 */
  draftCount: number;
  /** 最近一次写入恢复缓存的时间戳（毫秒） */
  updatedAt: number;
  /** 是否有原文件在外部被修改过的提示计数 */
  externalModifiedCount?: number;
  /** 是否包含未落盘的项目状态/备注变更 */
  hasProjectMetaChanges?: boolean;
  /** 是否正在执行恢复/导出/放弃操作 */
  busy?: boolean;
  /** 恢复到待保存区（非破坏性，不改动原目录文件） */
  onRestoreToDrafts: () => void;
  /** 导出恢复草稿 (.zip) */
  onExportRecoveryZip?: () => void;
  /** 放弃恢复草稿 */
  onDiscardRecovery: () => void;
}

function formatRecoveryTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '上次会话';
  try {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '上次会话';
  }
}

export const CorpusRecoveryBanner: React.FC<CorpusRecoveryBannerProps> = ({
  projectName,
  draftCount,
  updatedAt,
  externalModifiedCount = 0,
  hasProjectMetaChanges = false,
  busy = false,
  onRestoreToDrafts,
  onExportRecoveryZip,
  onDiscardRecovery
}) => {
  const timeLabel = formatRecoveryTime(updatedAt);
  const summaryParts: string[] = [];
  if (draftCount > 0) {
    summaryParts.push(`${draftCount} 条未保存词条草稿`);
  }
  if (hasProjectMetaChanges) {
    summaryParts.push('未保存的词条状态变更');
  }
  const summaryText = summaryParts.length > 0 ? summaryParts.join('及') : '未保存草稿';

  return (
    <div
      className="corpus-recovery-banner"
      role="status"
      aria-live="polite"
      aria-label="词表异常退出恢复提示"
    >
      <div className="corpus-recovery-main">
        <span className="corpus-recovery-icon" aria-hidden="true">
          <UiIcon name="warning" size={14} />
        </span>
        <div className="corpus-recovery-copy">
          <div className="corpus-recovery-title">
            检测到「{projectName}」上次异常退出（{timeLabel}）残留 {summaryText}
          </div>
          <div className="corpus-recovery-sub">
            恢复草稿仅载入待保存区，不会自动覆盖文件夹内的原文件；确认无误后再手动保存。
            {externalModifiedCount > 0 && (
              <span className="corpus-recovery-warn">
                {' '}
                注意：其中 {externalModifiedCount} 条磁盘原文件已被外部程序修改，保存前会提示比对。
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="corpus-recovery-actions">
        <button
          type="button"
          className="compact primary"
          disabled={busy}
          title="将残留草稿恢复到待保存区，不直接改动磁盘原文件"
          onClick={onRestoreToDrafts}
        >
          <span>{busy ? '处理中…' : '恢复到待保存区'}</span>
        </button>

        {onExportRecoveryZip && (
          <button
            type="button"
            className="compact"
            disabled={busy}
            title="将残留草稿直接打包为 .zip 压缩包备份"
            onClick={onExportRecoveryZip}
          >
            <CorpusExportZipIcon size={12} />
            <span>导出恢复草稿 (.zip)</span>
          </button>
        )}

        <button
          type="button"
          className="compact danger"
          disabled={busy}
          title="清除残留恢复缓存，以当前磁盘原文件为准"
          onClick={onDiscardRecovery}
        >
          <span>放弃恢复草稿</span>
        </button>
      </div>
    </div>
  );
};
