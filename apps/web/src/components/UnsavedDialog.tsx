import React, { useEffect, useRef } from 'react';
import { CloseIcon, UiIcon } from './Icons';

export interface UnsavedCorpusDetail {
  projectName: string;
  writable: boolean;
  unsavedItemCount: number;
  unsavedItemNames: string[];
  projectIndexDirty?: boolean;
}

export interface UnsavedWindowTabEntry {
  id: string;
  filename: string;
  corpus?: UnsavedCorpusDetail;
}

export type UnsavedDialogState =
  | null
  | {
      mode: 'tab';
      tabId: string;
      filename: string;
      corpus?: UnsavedCorpusDetail;
    }
  | {
      mode: 'batch-tabs';
      scopeLabel: string;
      totalCloseCount: number;
      targetTabIds: string[];
      dirtyTabs: UnsavedWindowTabEntry[];
    }
  | {
      mode: 'window';
      dirtyTabs: UnsavedWindowTabEntry[];
    };

interface UnsavedDialogProps {
  state: UnsavedDialogState;
  busy?: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

const MAX_CORPUS_PREVIEW = 8;

function renderCorpusItemPreview(corpus: UnsavedCorpusDetail) {
  const previewNames = corpus.unsavedItemNames.slice(0, MAX_CORPUS_PREVIEW);
  const totalCount = Math.max(corpus.unsavedItemCount, corpus.unsavedItemNames.length);
  const hasMore = totalCount > previewNames.length;

  return (
    <>
      {previewNames.length > 0 && (
        <ul className="unsaved-tab-list unsaved-corpus-item-list" aria-label="未保存词条清单">
          {previewNames.map((name, idx) => (
            <li key={`${name}-${idx}`} className="unsaved-tab-list-item" title={name}>
              <span className="dirty-dot" aria-hidden="true" />
              <span className="unsaved-tab-list-name">{name}</span>
            </li>
          ))}
          {hasMore && (
            <li className="unsaved-tab-list-more">等共 {totalCount} 条未保存词条</li>
          )}
        </ul>
      )}
      {previewNames.length === 0 && corpus.projectIndexDirty && (
        <p className="unsaved-sub-note">
          包含未写入项目索引（.tgrid-project.json）的词条状态或配置变更。
        </p>
      )}
    </>
  );
}

export const UnsavedDialog: React.FC<UnsavedDialogProps> = ({
  state,
  busy = false,
  onCancel,
  onDiscard,
  onSave
}) => {
  const saveBtnRef = useRef<HTMLButtonElement>(null);
  const backdropPointerDownRef = useRef(false);
  const lastStateRef = useRef<Exclude<UnsavedDialogState, null> | null>(null);
  if (state) {
    lastStateRef.current = state;
  }

  const open = Boolean(state);
  const view = state ?? lastStateRef.current;

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        saveBtnRef.current?.focus();
      });
    }
  }, [open]);

  if (!view) return null;

  const isWindow = view.mode === 'window';
  const isBatchTabs = view.mode === 'batch-tabs';
  const title = isWindow
    ? '退出前保存更改'
    : isBatchTabs
      ? `${view.scopeLabel}前保存更改`
      : '保存更改';
  const discardLabel = isWindow ? '不保存并退出' : '不保存并关闭';

  let saveLabel = '保存为 TextGrid';
  if (view.mode === 'tab' && view.corpus) {
    saveLabel = view.corpus.writable ? '保存全部并关闭' : '导出修改 (.zip) 并关闭';
  } else if (view.mode === 'batch-tabs') {
    const allReadonlyCorpus =
      view.dirtyTabs.length > 0 &&
      view.dirtyTabs.every((t) => Boolean(t.corpus) && !t.corpus!.writable);
    saveLabel = allReadonlyCorpus ? '导出修改 (.zip) 并关闭' : '全部保存并关闭';
  } else if (view.mode === 'window') {
    const hasCorpus = view.dirtyTabs.some((t) => Boolean(t.corpus));
    if (hasCorpus) {
      saveLabel = '保存全部并退出';
    } else if (view.dirtyTabs.length > 1) {
      saveLabel = '全部保存并退出';
    }
  }

  return (
    <div
      className={`modal-backdrop ${open ? 'open' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      aria-labelledby="unsaved-modal-title"
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
      <div className="modal-card unsaved-modal-card">
        <div className="modal-head">
          <span id="unsaved-modal-title" className="modal-title">
            <UiIcon name="warning" size={14} />
            <span>{title}</span>
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

        <div className="modal-body unsaved-modal-body">
          {view.mode === 'tab' ? (
            view.corpus ? (
              <>
                <p className="unsaved-desc">
                  词表项目「<strong className="unsaved-fname">{view.corpus.projectName}</strong>」
                  {view.corpus.unsavedItemCount > 0 ? (
                    <>
                      有 <strong>{view.corpus.unsavedItemCount}</strong> 条未保存词条
                    </>
                  ) : (
                    <>有未保存的项目状态变更</>
                  )}
                  ，关闭前是否{view.corpus.writable ? '全部保存到原文件夹' : '打包导出修改 (.zip)'}？
                </p>
                {renderCorpusItemPreview(view.corpus)}
                <p className="unsaved-sub-note">
                  选择「{discardLabel}」将不修改原文件夹中的文件，并清理本次会话的本地恢复草稿。
                </p>
              </>
            ) : (
              <p className="unsaved-desc">
                「<strong className="unsaved-fname">{view.filename}</strong>」有未保存的修改，关闭前是否保存为
                TextGrid 文件？
              </p>
            )
          ) : view.mode === 'batch-tabs' ? (
            <>
              <p className="unsaved-desc">
                {view.totalCloseCount > view.dirtyTabs.length ? (
                  <>
                    本次将关闭共 <strong>{view.totalCloseCount}</strong> 个标签页，其中以下{' '}
                    <strong>{view.dirtyTabs.length}</strong> 个有未保存的修改，关闭前是否
                    {view.dirtyTabs.every((t) => Boolean(t.corpus) && !t.corpus!.writable)
                      ? '打包导出修改 (.zip)'
                      : '全部保存'}
                    ？
                  </>
                ) : (
                  <>
                    以下 <strong>{view.dirtyTabs.length}</strong> 个标签页有未保存的修改，关闭前是否
                    {view.dirtyTabs.every((t) => Boolean(t.corpus) && !t.corpus!.writable)
                      ? '打包导出修改 (.zip)'
                      : '全部保存'}
                    ？
                  </>
                )}
              </p>
              <ul className="unsaved-tab-list" aria-label="未保存的标签页列表">
                {view.dirtyTabs.map((item) => {
                  const corpusMeta = item.corpus;
                  const summary = corpusMeta
                    ? corpusMeta.unsavedItemCount > 0
                      ? `${corpusMeta.projectName}（${corpusMeta.unsavedItemCount} 条词条未保存）`
                      : `${corpusMeta.projectName}（项目状态未保存）`
                    : item.filename;
                  return (
                    <li key={item.id} className="unsaved-tab-list-item" title={summary}>
                      <span className="dirty-dot" aria-hidden="true" />
                      <div className="unsaved-tab-list-entry">
                        <span className="unsaved-tab-list-name">{summary}</span>
                        {corpusMeta && corpusMeta.unsavedItemNames.length > 0 && (
                          <span className="unsaved-tab-list-sub">
                            {corpusMeta.unsavedItemNames.slice(0, MAX_CORPUS_PREVIEW).join('、')}
                            {Math.max(corpusMeta.unsavedItemCount, corpusMeta.unsavedItemNames.length) >
                            MAX_CORPUS_PREVIEW
                              ? ` 等共 ${Math.max(corpusMeta.unsavedItemCount, corpusMeta.unsavedItemNames.length)} 条`
                              : ''}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {view.dirtyTabs.some((t) => Boolean(t.corpus)) && (
                <p className="unsaved-sub-note">
                  选择「{discardLabel}」将不修改原文件夹中的文件，并清理本次会话的本地恢复草稿。
                </p>
              )}
            </>
          ) : view.dirtyTabs.length === 1 && view.dirtyTabs[0]?.corpus ? (
            <>
              <p className="unsaved-desc">
                词表项目「<strong className="unsaved-fname">{view.dirtyTabs[0].corpus.projectName}</strong>」
                {view.dirtyTabs[0].corpus.unsavedItemCount > 0 ? (
                  <>
                    有 <strong>{view.dirtyTabs[0].corpus.unsavedItemCount}</strong> 条未保存词条
                  </>
                ) : (
                  <>有未保存的项目状态变更</>
                )}
                ，退出前是否全部保存到原文件夹？
              </p>
              {renderCorpusItemPreview(view.dirtyTabs[0].corpus)}
              <p className="unsaved-sub-note">
                选择「{discardLabel}」将不修改原文件夹中的文件，并清理本次会话的本地恢复草稿。
              </p>
            </>
          ) : view.dirtyTabs.length <= 1 ? (
            <p className="unsaved-desc">
              「<strong className="unsaved-fname">{view.dirtyTabs[0]?.filename ?? '未命名.TextGrid'}</strong>
              」有未保存的修改，退出前是否保存为 TextGrid 文件？
            </p>
          ) : (
            <>
              <p className="unsaved-desc">
                以下 <strong>{view.dirtyTabs.length}</strong> 个标签页有未保存的修改，退出前是否全部保存？
              </p>
              <ul className="unsaved-tab-list" aria-label="未保存的标签页列表">
                {view.dirtyTabs.map((item) => {
                  const corpusMeta = item.corpus;
                  const summary = corpusMeta
                    ? corpusMeta.unsavedItemCount > 0
                      ? `${corpusMeta.projectName}（${corpusMeta.unsavedItemCount} 条词条未保存）`
                      : `${corpusMeta.projectName}（项目状态未保存）`
                    : item.filename;
                  return (
                    <li key={item.id} className="unsaved-tab-list-item" title={summary}>
                      <span className="dirty-dot" aria-hidden="true" />
                      <div className="unsaved-tab-list-entry">
                        <span className="unsaved-tab-list-name">{summary}</span>
                        {corpusMeta && corpusMeta.unsavedItemNames.length > 0 && (
                          <span className="unsaved-tab-list-sub">
                            {corpusMeta.unsavedItemNames.slice(0, MAX_CORPUS_PREVIEW).join('、')}
                            {Math.max(corpusMeta.unsavedItemCount, corpusMeta.unsavedItemNames.length) >
                            MAX_CORPUS_PREVIEW
                              ? ` 等共 ${Math.max(corpusMeta.unsavedItemCount, corpusMeta.unsavedItemNames.length)} 条`
                              : ''}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        <div className="unsaved-modal-foot">
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <div className="unsaved-foot-right">
            <button type="button" className="danger" disabled={busy} onClick={onDiscard}>
              {discardLabel}
            </button>
            <button
              ref={saveBtnRef}
              type="button"
              className="primary"
              disabled={busy}
              onClick={onSave}
            >
              <UiIcon name="save" size={13} />
              <span>{busy ? '正在保存…' : saveLabel}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
