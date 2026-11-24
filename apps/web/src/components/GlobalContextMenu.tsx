import React, { useEffect, useRef, useState } from 'react';
import { isTauriRuntime } from '../bridge/PlatformBridge';
import { useEditorStore } from '../store/useEditorStore';

interface GlobalMenuItem {
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  divider?: boolean;
  action?: () => void;
}

interface GlobalContextMenuProps {
  onOpenTextGridPicker: () => void;
  onOpenAudioPicker: () => void;
}

function isEditableField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const t = (el.type || 'text').toLowerCase();
    return ['text', 'number', 'search', 'url', 'email', 'tel', 'password'].includes(t);
  }
  return false;
}

function setReactInputValue(el: HTMLInputElement | HTMLTextAreaElement, nextValue: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, nextValue);
  } else {
    el.value = nextValue;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function getEditableSelection(el: HTMLInputElement | HTMLTextAreaElement): {
  supported: boolean;
  start: number;
  end: number;
  selectedText: string;
} {
  try {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start !== null && end !== null) {
      return {
        supported: true,
        start,
        end,
        selectedText: el.value.slice(start, end)
      };
    }
  } catch {
    // input[type="number"] does not expose selectionStart/selectionEnd in Chromium
  }
  const winSel = window.getSelection()?.toString() || '';
  return {
    supported: false,
    start: 0,
    end: el.value.length,
    selectedText: winSel
  };
}

export const GlobalContextMenu: React.FC<GlobalContextMenuProps> = ({
  onOpenTextGridPicker,
  onOpenAudioPicker
}) => {
  const [menu, setMenu] = useState<{ x: number; y: number; items: GlobalMenuItem[] } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const isDesktop = isTauriRuntime();

    const closeMenu = () => setMenu(null);

    const onContextMenu = (e: MouseEvent) => {
      const tagged = e as MouseEvent & { __tgCtxHandled?: boolean };
      if (tagged.__tgCtxHandled) {
        setMenu(null);
        return;
      }

      const target = e.target as HTMLElement | null;

      // 1. Editable text/number inputs and textareas (Desktop takes over browser menu)
      if (isDesktop && isEditableField(target)) {
        e.preventDefault();
        window.dispatchEvent(new Event('tg-close-stage-ctx'));

        const el = target;
        el.focus();
        const readonlyOrDisabled = el.readOnly || el.disabled;
        const sel = getEditableSelection(el);
        const hasSel = sel.selectedText.length > 0;
        const hasValue = el.value.length > 0;

        const items: GlobalMenuItem[] = [
          {
            label: '剪切',
            shortcut: 'Ctrl+X',
            disabled: readonlyOrDisabled || (!hasSel && sel.supported),
            action: () => {
              const cur = getEditableSelection(el);
              const textToCopy = cur.supported ? cur.selectedText : cur.selectedText || el.value;
              if (!textToCopy) return;
              void navigator.clipboard.writeText(textToCopy).catch(() => {});
              if (cur.supported) {
                const next = el.value.slice(0, cur.start) + el.value.slice(cur.end);
                setReactInputValue(el, next);
                requestAnimationFrame(() => {
                  el.focus();
                  el.setSelectionRange(cur.start, cur.start);
                });
              } else {
                setReactInputValue(el, '');
                requestAnimationFrame(() => el.focus());
              }
            }
          },
          {
            label: '复制',
            shortcut: 'Ctrl+C',
            disabled: !hasSel && !(!sel.supported && hasValue),
            action: () => {
              const cur = getEditableSelection(el);
              const textToCopy = cur.supported ? cur.selectedText : cur.selectedText || el.value;
              if (textToCopy) {
                void navigator.clipboard.writeText(textToCopy).catch(() => {});
              }
            }
          },
          {
            label: '粘贴',
            shortcut: 'Ctrl+V',
            disabled: readonlyOrDisabled,
            action: () => {
              void navigator.clipboard
                .readText()
                .then((clip) => {
                  if (clip === undefined || clip === null) return;
                  const cur = getEditableSelection(el);
                  if (cur.supported) {
                    const next = el.value.slice(0, cur.start) + clip + el.value.slice(cur.end);
                    const caret = cur.start + clip.length;
                    setReactInputValue(el, next);
                    requestAnimationFrame(() => {
                      el.focus();
                      el.setSelectionRange(caret, caret);
                    });
                  } else {
                    setReactInputValue(el, clip.trim());
                    requestAnimationFrame(() => el.focus());
                  }
                })
                .catch(() => {
                  useEditorStore.getState().showToast('无法读取剪贴板内容', true);
                });
            }
          },
          { divider: true },
          {
            label: '全选',
            shortcut: 'Ctrl+A',
            disabled: !hasValue,
            action: () => {
              el.focus();
              el.select();
            }
          }
        ];

        const x = Math.max(8, Math.min(e.clientX, window.innerWidth - 204));
        const y = Math.max(8, Math.min(e.clientY, window.innerHeight - items.length * 32 - 16));
        setMenu({ x, y, items });
        return;
      }

      // 2. Blank stage / canvas area (.stage or empty #score-svg background)
      const inStage = Boolean(target?.closest('.stage'));
      if (inStage && !target?.closest('.floating-bar, .ipa-popover, .context-menu')) {
        e.preventDefault();
        window.dispatchEvent(new Event('tg-close-stage-ctx'));

        const st = useEditorStore.getState();
        const items: GlobalMenuItem[] = [
          {
            label: '打开文件…',
            shortcut: isDesktop ? 'Ctrl+O' : undefined,
            action: onOpenTextGridPicker
          },
          {
            label: '加载音频…',
            action: onOpenAudioPicker
          },
          { divider: true }
        ];

        if (st.viewDomain) {
          items.push({
            label: '显示全长',
            action: () => useEditorStore.getState().setViewDomain(null)
          });
        }

        items.push(
          {
            label: st.scaleMode === 'linear' ? '切换自适应宽度' : '切换线性对齐',
            action: () =>
              useEditorStore
                .getState()
                .setScaleMode(st.scaleMode === 'linear' ? 'elastic' : 'linear')
          },
          {
            label: st.legendOpen ? '隐藏图例导读' : '图例导读',
            action: () => useEditorStore.getState().toggleLegend()
          },
          { divider: true },
          {
            label: '导出谱面图像…',
            shortcut: isDesktop ? 'Ctrl+P' : undefined,
            action: () => useEditorStore.getState().setExportOpen(true)
          }
        );

        const x = Math.max(8, Math.min(e.clientX, window.innerWidth - 210));
        const y = Math.max(8, Math.min(e.clientY, window.innerHeight - items.length * 32 - 20));
        setMenu({ x, y, items });
        return;
      }

      // 3. Anywhere else on Desktop: block Edge's default context menu silently
      if (isDesktop) {
        e.preventDefault();
        setMenu(null);
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setMenu(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };

    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('tg-close-global-ctx', closeMenu);

    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('tg-close-global-ctx', closeMenu);
    };
  }, [onOpenTextGridPicker, onOpenAudioPicker]);

  if (!menu) return null;

  return (
    <div
      ref={menuRef}
      className="context-menu open"
      style={{ left: menu.x, top: menu.y }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {menu.items.map((item, idx) =>
        item.divider ? (
          <div key={`gdiv-${idx}`} className="menu-divider" />
        ) : (
          <button
            key={`${item.label}-${idx}`}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              setMenu(null);
              item.action?.();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
          </button>
        )
      )}
    </div>
  );
};
