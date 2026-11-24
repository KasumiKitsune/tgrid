import React from 'react';
import { useEditorStore } from '../store/useEditorStore';

export const Toast: React.FC = () => {
  const toast = useEditorStore((s) => s.toast);
  const hideToast = useEditorStore((s) => s.hideToast);

  return (
    <div
      className={`toast ${toast.visible ? 'visible' : ''} ${toast.isError ? 'error' : ''} ${
        toast.action ? 'has-action' : ''
      }`}
      role="status"
      aria-live="polite"
    >
      <span className="toast-msg">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="toast-action-btn"
          onClick={() => {
            const act = toast.action;
            hideToast();
            act?.onClick();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
};
