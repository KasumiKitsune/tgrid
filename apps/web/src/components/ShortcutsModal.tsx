import React, { useRef } from 'react';
import {
  IS_MAC,
  MOUSE_GESTURE_TIPS,
  SHORTCUT_GROUPS,
  formatKeyCombo,
  getEffectiveKeys,
  isShortcutCustomized
} from '../shortcuts/registry';
import { useEditorStore } from '../store/useEditorStore';
import { CloseIcon, UiIcon } from './Icons';
import { requestCustomizeSubtab } from './sidebar/CustomizePanel';

interface DeleteMatrixRow {
  target: string;
  backspace: string;
  del: string;
  shiftBackspace: string;
  shiftDelete: string;
}

const DELETE_MATRIX_ROWS: DeleteMatrixRow[] = [
  {
    target: '有字区间',
    backspace: '清空文本（保持选中）',
    del: '清空文本（保持选中）',
    shiftBackspace: '清空并移除左边界（并入左邻）',
    shiftDelete: '清空并移除右边界（并入右邻）'
  },
  {
    target: '空白区间',
    backspace: '移除左边界（并入左邻）',
    del: '移除右边界（并入右邻）',
    shiftBackspace: '移除左边界',
    shiftDelete: '移除右边界'
  },
  {
    target: '零时长区间',
    backspace: '删除该区间（选前/后项）',
    del: '删除该区间（选后/前项）',
    shiftBackspace: '删除该区间',
    shiftDelete: '删除该区间'
  },
  {
    target: '边界',
    backspace: '删除本层该边界',
    del: '删除本层该边界',
    shiftBackspace: '跨层删除全部对齐边界',
    shiftDelete: '跨层删除全部对齐边界'
  },
  {
    target: '标点',
    backspace: '删除并自动选中前一点',
    del: '删除并自动选中后一点',
    shiftBackspace: '仅清空标点文本（留时刻）',
    shiftDelete: '删除该标点'
  },
  {
    target: '整层',
    backspace: '安全忽略',
    del: '安全忽略',
    shiftBackspace: '安全忽略',
    shiftDelete: '删除整层（可撤销）'
  },
  {
    target: '时间列',
    backspace: '安全忽略',
    del: '安全忽略',
    shiftBackspace: '跨层删除该时刻全部边界',
    shiftDelete: '跨层删除该时刻全部边界'
  }
];

export const ShortcutsModal: React.FC = () => {
  const shortcutsOpen = useEditorStore((s) => s.shortcutsOpen);
  const setShortcutsOpen = useEditorStore((s) => s.setShortcutsOpen);
  const customShortcuts = useEditorStore((s) => s.customShortcuts);
  const setSidebarTab = useEditorStore((s) => s.setSidebarTab);
  const setSidebarOpen = useEditorStore((s) => s.setSidebarOpen);
  const backdropPointerDownRef = useRef(false);

  const handleOpenCustomizeShortcuts = () => {
    requestCustomizeSubtab('shortcuts');
    setShortcutsOpen(false);
    setSidebarTab('customize');
    setSidebarOpen(true);
  };

  return (
    <div
      className={`modal-backdrop ${shortcutsOpen ? 'open' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-hidden={!shortcutsOpen}
      aria-labelledby="shortcuts-modal-title"
      onPointerDown={(e) => {
        backdropPointerDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (backdropPointerDownRef.current && e.target === e.currentTarget) {
          setShortcutsOpen(false);
        }
        backdropPointerDownRef.current = false;
      }}
    >
      <div className="modal-card shortcuts-modal-card">
        <div className="modal-head">
          <span id="shortcuts-modal-title" className="modal-title">
            <UiIcon name="keyboard" size={15} />
            <span>快捷键与交互速查表</span>
          </span>
          <button
            type="button"
            className="icon-btn compact"
            title="关闭 (Esc)"
            aria-label="关闭"
            onClick={() => setShortcutsOpen(false)}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="modal-body shortcuts-modal-body">
          {/* 2-Column Grouped Keyboard Shortcuts */}
          <div className="shortcuts-grid">
            {SHORTCUT_GROUPS.map((group) => (
              <section key={group.id} className="shortcuts-section" aria-label={group.title}>
                <div className="shortcuts-section-title">
                  {group.title}
                  {group.subtitle ? ` · ${group.subtitle}` : ''}
                </div>
                <div className="shortcuts-list">
                  {group.entries.map((entry) => {
                    const effectiveKeys = getEffectiveKeys(entry.id, customShortcuts);
                    const customized = isShortcutCustomized(entry.id, customShortcuts);
                    return (
                      <div
                        key={entry.id}
                        className="shortcuts-row"
                        title={entry.description || undefined}
                      >
                        <span className="shortcuts-desc">
                          <span className="shortcuts-icon" aria-hidden="true">
                            {entry.icon ? <UiIcon name={entry.icon} size={13} /> : null}
                          </span>
                          <span className="shortcuts-label-text">
                            <span>{entry.label}</span>
                            {customized && (
                              <span
                                className="cust-key-dot"
                                title="已自定义快捷键"
                                aria-label="已自定义"
                              />
                            )}
                          </span>
                        </span>
                        <span className="shortcuts-keys">
                          {effectiveKeys.length > 0 ? (
                            effectiveKeys.map((k) => (
                              <kbd key={k} className="kbd">
                                {formatKeyCombo(k)}
                              </kbd>
                            ))
                          ) : (
                            <span
                              className="kbd"
                              style={{
                                color: 'var(--ink-faint)',
                                borderStyle: 'dashed',
                                background: 'var(--bg-subtle)'
                              }}
                            >
                              未绑定
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          {/* 4-Column Delete Semantics Matrix */}
          <section className="shortcuts-matrix-wrap" aria-label="退格与删除四象限语义">
            <div className="shortcuts-section-title">
              退格与删除四象限语义 · 编辑模式（首次清空内容，再按或加 Shift 删结构，单步可撤销）
            </div>
            <table className="shortcuts-matrix-table">
              <thead>
                <tr>
                  <th>选中对象</th>
                  <th>
                    <kbd className="kbd">Backspace</kbd>
                  </th>
                  <th>
                    <kbd className="kbd">Delete</kbd>
                  </th>
                  <th>
                    <kbd className="kbd">Shift+Backspace</kbd>
                  </th>
                  <th>
                    <kbd className="kbd">Shift+Delete</kbd>
                  </th>
                </tr>
              </thead>
              <tbody>
                {DELETE_MATRIX_ROWS.map((row) => (
                  <tr key={row.target}>
                    <td>{row.target}</td>
                    <td>{row.backspace}</td>
                    <td>{row.del}</td>
                    <td>{row.shiftBackspace}</td>
                    <td>{row.shiftDelete}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* Mouse & Cross-Tier Magnet Gestures */}
          <section className="shortcuts-section" aria-label="鼠标手势与跨层磁吸">
            <div className="shortcuts-section-title">鼠标手势与跨层磁吸技巧</div>
            <div className="shortcuts-grid">
              <div className="shortcuts-list">
                {MOUSE_GESTURE_TIPS.slice(0, Math.ceil(MOUSE_GESTURE_TIPS.length / 2)).map(
                  (tip) => (
                    <div
                      key={tip.id}
                      className="shortcuts-row"
                      title={tip.description || undefined}
                    >
                      <span className="shortcuts-desc">{tip.label}</span>
                      <span className="shortcuts-keys">
                        <kbd className="kbd">{formatKeyCombo(tip.gesture)}</kbd>
                      </span>
                    </div>
                  )
                )}
              </div>
              <div className="shortcuts-list">
                {MOUSE_GESTURE_TIPS.slice(Math.ceil(MOUSE_GESTURE_TIPS.length / 2)).map((tip) => (
                  <div
                    key={tip.id}
                    className="shortcuts-row"
                    title={tip.description || undefined}
                  >
                    <span className="shortcuts-desc">{tip.label}</span>
                    <span className="shortcuts-keys">
                      <kbd className="kbd">{formatKeyCombo(tip.gesture)}</kbd>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>

        <div className="about-modal-foot">
          <span className="about-foot-meta">
            {IS_MAC ? 'macOS 键位（⌘）' : 'Windows / Linux 键位（Ctrl）'} · 按 ? 或{' '}
            {formatKeyCombo('Mod+/')} 随时唤出
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className="compact"
              onClick={handleOpenCustomizeShortcuts}
            >
              <UiIcon name="customize" size={13} />
              <span>自定义快捷键…</span>
            </button>
            <button type="button" className="compact" onClick={() => setShortcutsOpen(false)}>
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
