import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatKeyCombo } from '../shortcuts/registry';
import type { TabRecord } from '../store/useEditorStore';
import { getLogicalViewportSize, getViewportZoom } from '../utils/uiScale';
import { UiIcon, type IconName } from './Icons';
import '../styles/tabMenuDrop.css';

export type TabContextMenuRequest =
  | { kind: 'tab'; tabId: string; x: number; y: number }
  | { kind: 'blank'; x: number; y: number };

interface TabMenuItem {
  label?: string;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
  action?: () => void;
}

export interface TabContextMenuProps {
  request: TabContextMenuRequest | null;
  tabs: TabRecord[];
  activeTabId: string;
  isDesktop: boolean;
  getCorpusNativeDirPath?: (tabId: string) => string | null;
  hasTabUnsaved?: (tab: TabRecord) => boolean;
  onClose: () => void;
  onSaveTab: (tabId: string) => void;
  onSaveTabAs: (tabId: string) => void;
  onSaveCorpusAll: (tabId: string) => void;
  onExportCorpusZip: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseRightTabs: (tabId: string) => void;
  onCloseSavedTabs: () => void;
  onCloseAllTabs: () => void;
  onCopyText: (text: string, label: string) => void;
  onRevealPath: (path: string) => void;
  onNewTab: () => void;
  onOpenTextGridPicker: () => void;
  onOpenCorpusFolder: () => void;
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const plat = (navigator.platform || navigator.userAgent || '').toLowerCase();
  return plat.includes('mac');
}

function defaultHasTabUnsaved(tab: TabRecord): boolean {
  if (tab.kind === 'corpus' && tab.corpus) {
    const ext = tab.corpus as typeof tab.corpus & {
      unsavedItemIds?: string[];
      projectIndexDirty?: boolean;
    };
    return Boolean(
      tab.isDirty ||
        (ext.unsavedItemIds?.length ?? 0) > 0 ||
        Boolean(ext.projectIndexDirty) ||
        (!tab.corpus.writable && tab.corpus.dirtyCount > 0)
    );
  }
  return tab.isDirty;
}

function isSingleBlankPlaceholder(tab: TabRecord): boolean {
  return tab.kind !== 'corpus' && tab.isBlankPlaceholder && !tab.isDirty && !tab.audioName;
}

export const TabContextMenu: React.FC<TabContextMenuProps> = ({
  request,
  tabs,
  activeTabId,
  isDesktop,
  getCorpusNativeDirPath,
  hasTabUnsaved,
  onClose,
  onSaveTab,
  onSaveTabAs,
  onSaveCorpusAll,
  onExportCorpusZip,
  onCloseTab,
  onCloseOtherTabs,
  onCloseRightTabs,
  onCloseSavedTabs,
  onCloseAllTabs,
  onCopyText,
  onRevealPath,
  onNewTab,
  onOpenTextGridPicker,
  onOpenCorpusFolder
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const checkUnsaved = hasTabUnsaved ?? defaultHasTabUnsaved;
  const isMac = useMemo(() => isMacPlatform(), []);

  const targetTab = useMemo(() => {
    if (!request || request.kind !== 'tab') return null;
    return tabs.find((t) => t.id === request.tabId) ?? null;
  }, [request, tabs]);

  // 与全局右键菜单和画布右键菜单互斥关闭
  useEffect(() => {
    if (!request) {
      setPos(null);
      return;
    }
    window.dispatchEvent(new Event('tg-close-global-ctx'));
    window.dispatchEvent(new Event('tg-close-stage-ctx'));
  }, [request]);

  // 点击菜单外部、Esc、失焦或外部广播时关闭
  useEffect(() => {
    if (!request) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const handleClose = () => onClose();

    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', handleClose);
    window.addEventListener('tg-close-tab-ctx', handleClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', handleClose);
      window.removeEventListener('tg-close-tab-ctx', handleClose);
    };
  }, [request, onClose]);

  const items = useMemo<TabMenuItem[]>(() => {
    if (!request) return [];

    const onlyBlankPlaceholder = tabs.length === 1 && isSingleBlankPlaceholder(tabs[0]);
    const hasAnyClosableSaved =
      !onlyBlankPlaceholder && tabs.some((t) => !checkUnsaved(t));

    if (request.kind === 'blank') {
      return [
        {
          label: '新建空白标签页',
          icon: 'tab-add',
          shortcut: formatKeyCombo('Mod+T'),
          action: onNewTab
        },
        {
          label: '打开标注或音频文件…',
          icon: 'folder',
          shortcut: formatKeyCombo('Mod+O'),
          action: onOpenTextGridPicker
        },
        {
          label: '打开词表文件夹…',
          icon: 'corpusFolder',
          action: onOpenCorpusFolder
        },
        { divider: true },
        {
          label: '关闭全部已保存标签页',
          icon: 'check',
          disabled: !hasAnyClosableSaved,
          action: onCloseSavedTabs
        },
        {
          label: '关闭全部标签页',
          icon: 'clear',
          disabled: onlyBlankPlaceholder,
          action: onCloseAllTabs
        }
      ];
    }

    if (!targetTab) return [];
    const tabIdx = tabs.findIndex((t) => t.id === targetTab.id);
    const isActive = targetTab.id === activeTabId;
    const isCorpus = targetTab.kind === 'corpus' && Boolean(targetTab.corpus);
    const tabUnsaved = checkUnsaved(targetTab);
    const hasRightTabs = tabIdx >= 0 && tabIdx < tabs.length - 1;
    const hasOtherTabs = tabs.length > 1;

    if (isCorpus && targetTab.corpus) {
      const corpus = targetTab.corpus;
      const nativeDirPath =
        isDesktop && !corpus.rootKey.startsWith('sample:')
          ? (getCorpusNativeDirPath?.(targetTab.id) ?? null)
          : null;
      const revealDirLabel = isMac ? '在访达中打开文件夹' : '在资源管理器中打开文件夹';

      const list: TabMenuItem[] = [];
      if (corpus.writable) {
        list.push({
          label: '保存全部修改',
          icon: 'save',
          disabled: !tabUnsaved,
          action: () => onSaveCorpusAll(targetTab.id)
        });
      } else {
        list.push({
          label: '导出已修改文件 (.zip)',
          icon: 'corpusExportZip',
          disabled: !tabUnsaved,
          action: () => onExportCorpusZip(targetTab.id)
        });
      }

      list.push(
        { divider: true },
        {
          label: '关闭文件夹项目',
          icon: 'CloseIcon',
          shortcut: isActive ? formatKeyCombo('Mod+W') : undefined,
          action: () => onCloseTab(targetTab.id)
        },
        {
          label: '关闭其他标签页',
          disabled: !hasOtherTabs,
          action: () => onCloseOtherTabs(targetTab.id)
        },
        {
          label: '关闭右侧标签页',
          disabled: !hasRightTabs,
          action: () => onCloseRightTabs(targetTab.id)
        },
        {
          label: '关闭全部已保存标签页',
          icon: 'check',
          disabled: !hasAnyClosableSaved,
          action: onCloseSavedTabs
        },
        {
          label: '关闭全部标签页',
          icon: 'clear',
          action: onCloseAllTabs
        },
        { divider: true },
        {
          label: '复制文件夹名称',
          icon: 'copy',
          action: () => onCopyText(corpus.projectName, '文件夹名称')
        }
      );

      if (isDesktop) {
        list.push(
          {
            label: '复制文件夹路径',
            icon: 'copy',
            disabled: !nativeDirPath,
            action: () => {
              if (nativeDirPath) onCopyText(nativeDirPath, '文件夹路径');
            }
          },
          {
            label: revealDirLabel,
            icon: 'corpusFolder',
            disabled: !nativeDirPath,
            action: () => {
              if (nativeDirPath) onRevealPath(nativeDirPath);
            }
          }
        );
      }

      list.push(
        { divider: true },
        {
          label: '新建空白标签页',
          icon: 'tab-add',
          shortcut: formatKeyCombo('Mod+T'),
          action: onNewTab
        }
      );
      return list;
    }

    // 普通文档标签页
    const revealFileLabel = isMac ? '在访达中显示' : '在资源管理器中显示';
    const filePath = targetTab.currentFilePath;
    const list: TabMenuItem[] = [
      {
        label: '保存',
        icon: 'save',
        shortcut: isActive ? formatKeyCombo('Mod+S') : undefined,
        disabled: !tabUnsaved && Boolean(filePath),
        action: () => onSaveTab(targetTab.id)
      },
      {
        label: '另存为…',
        icon: 'saveAs',
        action: () => onSaveTabAs(targetTab.id)
      },
      { divider: true },
      {
        label: '关闭',
        icon: 'CloseIcon',
        shortcut: isActive ? formatKeyCombo('Mod+W') : undefined,
        disabled: onlyBlankPlaceholder,
        action: () => onCloseTab(targetTab.id)
      },
      {
        label: '关闭其他标签页',
        disabled: !hasOtherTabs,
        action: () => onCloseOtherTabs(targetTab.id)
      },
      {
        label: '关闭右侧标签页',
        disabled: !hasRightTabs,
        action: () => onCloseRightTabs(targetTab.id)
      },
      {
        label: '关闭全部已保存标签页',
        icon: 'check',
        disabled: !hasAnyClosableSaved,
        action: onCloseSavedTabs
      },
      {
        label: '关闭全部标签页',
        icon: 'clear',
        disabled: onlyBlankPlaceholder,
        action: onCloseAllTabs
      },
      { divider: true },
      {
        label: '复制文件名',
        icon: 'copy',
        action: () => onCopyText(targetTab.filename, '文件名')
      }
    ];

    if (isDesktop) {
      list.push(
        {
          label: '复制完整路径',
          icon: 'copy',
          disabled: !filePath,
          action: () => {
            if (filePath) onCopyText(filePath, '完整路径');
          }
        },
        {
          label: revealFileLabel,
          icon: 'folder',
          disabled: !filePath,
          action: () => {
            if (filePath) onRevealPath(filePath);
          }
        }
      );
    }

    list.push(
      { divider: true },
      {
        label: '新建空白标签页',
        icon: 'tab-add',
        shortcut: formatKeyCombo('Mod+T'),
        action: onNewTab
      }
    );

    return list;
  }, [
    activeTabId,
    checkUnsaved,
    getCorpusNativeDirPath,
    isDesktop,
    isMac,
    onCloseAllTabs,
    onCloseOtherTabs,
    onCloseRightTabs,
    onCloseSavedTabs,
    onCloseTab,
    onCopyText,
    onExportCorpusZip,
    onNewTab,
    onOpenCorpusFolder,
    onOpenTextGridPicker,
    onRevealPath,
    onSaveCorpusAll,
    onSaveTab,
    onSaveTabAs,
    request,
    tabs,
    targetTab
  ]);

  // 基于当前 UI 缩放与菜单实际尺寸夹紧定位，避免贴边裁切
  useLayoutEffect(() => {
    if (!request || items.length === 0) return;
    const z = getViewportZoom();
    const { width: vw, height: vh } = getLogicalViewportSize();
    const el = menuRef.current;
    const rect = el?.getBoundingClientRect();
    const menuW = rect && rect.width > 0 ? rect.width / z : 220;
    const menuH = rect && rect.height > 0 ? rect.height / z : items.length * 30 + 12;

    const rawX = request.x / z;
    const rawY = request.y / z;
    const left = Math.max(8, Math.min(rawX, vw - menuW - 8));
    const top = Math.max(8, Math.min(rawY, vh - menuH - 8));
    setPos({ left, top });
  }, [request, items]);

  if (!request || items.length === 0 || typeof document === 'undefined') {
    return null;
  }

  const z = getViewportZoom();
  const fallbackLeft = request.x / z;
  const fallbackTop = request.y / z;

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu open tab-ctx-menu"
      role="menu"
      aria-label={request.kind === 'tab' ? '标签页操作菜单' : '标签栏操作菜单'}
      style={{
        left: pos ? pos.left : fallbackLeft,
        top: pos ? pos.top : fallbackTop
      }}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        (e.nativeEvent as MouseEvent & { __tgCtxHandled?: boolean }).__tgCtxHandled = true;
      }}
    >
      {items.map((item, idx) =>
        item.divider ? (
          <div key={`tdiv-${idx}`} className="menu-divider" />
        ) : (
          <button
            key={`${item.label}-${idx}`}
            type="button"
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.action?.();
            }}
          >
            <span className="ctx-item-main">
              <span className="ctx-item-icon" aria-hidden="true">
                {item.icon ? <UiIcon name={item.icon} size={14} /> : null}
              </span>
              <span>{item.label}</span>
            </span>
            {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  );
};
