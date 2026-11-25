import React, { useEffect, useRef } from 'react';
import { CloseIcon, UiIcon } from './Icons';

export type UnsavedDialogState =
  | null
  | {
      mode: 'tab';
      tabId: string;
      filename: string;
    }
  | {
      mode: 'window';
      dirtyTabs: Array<{ id: string; filename: string }>;
    };

interface UnsavedDialogProps {
  state: UnsavedDialogState;
  busy?: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
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
  const title = isWindow ? '退出前保存更改' : '保存更改';
  const discardLabel = isWindow ? '不保存并退出' : '不保存并关闭';

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
            <p className="unsaved-desc">
              「<strong className="unsaved-fname">{view.filename}</strong>」有未保存的修改，关闭前是否保存为
              TextGrid 文件？
            </p>
          ) : view.dirtyTabs.length <= 1 ? (
            <p className="unsaved-desc">
              「<strong className="unsaved-fname">{view.dirtyTabs[0]?.filename ?? '未命名.TextGrid'}</strong>
              」有未保存的修改，退出前是否保存为 TextGrid 文件？
            </p>
          ) : (
            <>
              <p className="unsaved-desc">
                以下 <strong>{view.dirtyTabs.length}</strong> 个标签页有未保存的修改，退出前是否依次保存为
                TextGrid 文件？
              </p>
              <ul className="unsaved-tab-list" aria-label="未保存的标签页列表">
                {view.dirtyTabs.map((item) => (
                  <li key={item.id} className="unsaved-tab-list-item" title={item.filename}>
                    <span className="dirty-dot" aria-hidden="true" />
                    <span className="unsaved-tab-list-name">{item.filename}</span>
                  </li>
                ))}
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
              <span>{busy ? '正在保存…' : '保存为 TextGrid'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
