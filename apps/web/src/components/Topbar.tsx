import React, { useEffect, useRef, useState } from 'react';
import { isTauriRuntime } from '../bridge/PlatformBridge';
import { formatKeyCombo, getEffectiveShortcutHint } from '../shortcuts/registry';
import { useEditorStore } from '../store/useEditorStore';
import type { BuiltinSample } from '../data/samples';
import { BrandLogoIcon, ChevronIcon, CloseIcon, TGridIcon, UiIcon } from './Icons';

export type ExportActionKind =
  | 'save'
  | 'save-as'
  | 'svg'
  | 'png'
  | 'dialog'
  | 'poster'
  | 'long'
  | 'short'
  | 'binary'
  | 'chrono'
  | 'col-bin'
  | 'col-text';

interface TopbarProps {
  onOpenTextGridPicker: () => void;
  onOpenAudioPicker: () => void;
  onLoadSample: (id: BuiltinSample['id']) => void;
  onExportAction: (kind: ExportActionKind) => void;
  onNewTab: () => void;
  onSwitchTab: (tabId: string) => void;
  onRequestCloseTab: (tabId: string) => void;
}

export const Topbar: React.FC<TopbarProps> = ({
  onOpenTextGridPicker,
  onOpenAudioPicker,
  onLoadSample,
  onExportAction,
  onNewTab,
  onSwitchTab,
  onRequestCloseTab
}) => {
  const isDesktop = isTauriRuntime();

  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const filename = useEditorStore((s) => s.filename);
  const currentFilePath = useEditorStore((s) => s.currentFilePath);
  const isDirty = useEditorStore((s) => s.isDirty);
  const collectionTgs = useEditorStore((s) => s.collectionTgs);
  const collectionActiveIdx = useEditorStore((s) => s.collectionActiveIdx);
  const switchCollectionItem = useEditorStore((s) => s.switchCollectionItem);
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const legendOpen = useEditorStore((s) => s.legendOpen);
  const toggleLegend = useEditorStore((s) => s.toggleLegend);
  const sidebarOpen = useEditorStore((s) => s.sidebarOpen);
  const sidebarTab = useEditorStore((s) => s.sidebarTab);
  const setSidebarTab = useEditorStore((s) => s.setSidebarTab);
  const setSidebarOpen = useEditorStore((s) => s.setSidebarOpen);
  const toggleSidebarTab = useEditorStore((s) => s.toggleSidebarTab);
  const openFindBar = useEditorStore((s) => s.openFindBar);
  const setShortcutsOpen = useEditorStore((s) => s.setShortcutsOpen);
  const customShortcuts = useEditorStore((s) => s.customShortcuts);

  const openFilesHint = getEffectiveShortcutHint('open-files', customShortcuts);
  const openAudioHint = getEffectiveShortcutHint('open-audio', customShortcuts);
  const saveFileHint = getEffectiveShortcutHint('save-file', customShortcuts);
  const saveAsHint = getEffectiveShortcutHint('save-as', customShortcuts);
  const exportFigureHint = getEffectiveShortcutHint('export-figure', customShortcuts);
  const findOpenHint = getEffectiveShortcutHint('find-open', customShortcuts);
  const replaceOpenHint = getEffectiveShortcutHint('replace-open', customShortcuts);
  const shortcutsModalHint = getEffectiveShortcutHint('shortcuts-modal', customShortcuts);

  const [openMenu, setOpenMenu] = useState<'col' | 'samples' | 'tools' | 'export' | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const tabstripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  // Scroll active tab smoothly into view when switching / opening tabs
  useEffect(() => {
    const strip = tabstripRef.current;
    if (!strip) return;
    const activeEl = strip.querySelector<HTMLElement>('[data-tab-active="true"]');
    activeEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  // Convert vertical wheel into horizontal scroll when tab strip overflows
  useEffect(() => {
    const strip = tabstripRef.current;
    if (!strip) return;
    const onWheel = (e: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        strip.scrollLeft += e.deltaY;
      }
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, []);

  // Track maximized state on desktop
  useEffect(() => {
    if (!isDesktop) return;
    let active = true;
    let unlistenResize: (() => void) | null = null;

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const max = await win.isMaximized();
        if (active) setIsMaximized(max);
        unlistenResize = await win.onResized(async () => {
          try {
            const nextMax = await win.isMaximized();
            if (active) setIsMaximized(nextMax);
          } catch {
            // ignore
          }
        });
      } catch {
        // ignore outside Tauri
      }
    })();

    return () => {
      active = false;
      if (unlistenResize) unlistenResize();
    };
  }, [isDesktop]);

  // Sync window title with active filename + dirty indicator
  // On Web, preserve the clean SEO title while viewing the unmodified default sample so crawlers
  // do not index "春晓示例.TextGrid" as the site's main title.
  useEffect(() => {
    const defaultWebTitle = 'T·Grid — Praat TextGrid 编辑器与语音标注出图工具';
    const isUnmodifiedDefaultSample =
      !isDesktop && !isDirty && tabs.length <= 1 && (!filename || filename === '春晓示例.TextGrid');
    const docLabel = filename ? `${isDirty ? '● ' : ''}${filename} — ` : '';
    const desktopTitle = `${docLabel}T·Grid - TextGrid Editor`;
    document.title = isUnmodifiedDefaultSample ? defaultWebTitle : desktopTitle;
    if (!isDesktop) return;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setTitle(desktopTitle);
      } catch {
        // ignore
      }
    })();
  }, [filename, isDirty, isDesktop, tabs.length]);

  const handleMinimize = async () => {
    if (!isDesktop) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().minimize();
    } catch {
      // ignore
    }
  };

  const handleToggleMaximize = async () => {
    if (!isDesktop) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      await win.toggleMaximize();
      setIsMaximized(await win.isMaximized());
    } catch {
      // ignore
    }
  };

  const handleCloseWindow = async () => {
    if (!isDesktop) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch {
      // ignore
    }
  };

  const tabStrip = (
    <div className="tabstrip-area">
      <div
        ref={tabstripRef}
        className="tabstrip"
        role="tablist"
        aria-label="已打开的文档标签页"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const tooltip = tab.currentFilePath
            ? `${tab.currentFilePath}${tab.isDirty ? ' (未保存)' : ''}`
            : `${tab.filename}${tab.isDirty ? ' (未保存)' : ''}`;
          return (
            <div
              key={tab.id}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              data-tab-active={isActive ? 'true' : undefined}
              className={`tab-item ${isActive ? 'active' : ''}`}
              title={tooltip}
              onClick={() => onSwitchTab(tab.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onSwitchTab(tab.id);
                }
              }}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  e.stopPropagation();
                  onRequestCloseTab(tab.id);
                }
              }}
            >
              {tab.isDirty && <span className="dirty-dot" aria-label="有未保存的修改" />}
              {tab.audioName && (
                <span className="tab-audio-ind" title={`已载入录音：${tab.audioName}`}>
                  <UiIcon name="waveform" size={11} />
                </span>
              )}
              <span className="tab-label">{tab.filename}</span>
              <button
                type="button"
                className="tab-close-btn"
                title={`关闭标签页 (${formatKeyCombo('Mod+W')})`}
                aria-label={`关闭 ${tab.filename}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestCloseTab(tab.id);
                }}
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="tab-add-btn"
        title={`新建空白标签页 (${formatKeyCombo('Mod+T')})`}
        aria-label="新建空白标签页"
        onClick={onNewTab}
      >
        <TGridIcon name="tab-add" size={12} />
      </button>
    </div>
  );

  return (
    <div className="topbar-stack" ref={headerRef}>
      {isDesktop ? (
        <div
          className="titlebar"
          data-tauri-drag-region=""
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest('button, .tab-item, .tabstrip-area')) return;
            void handleToggleMaximize();
          }}
        >
          <div className="titlebar-brand-slot" data-tauri-drag-region="">
            <span className="brand titlebar-brand" data-tauri-drag-region="">
              <BrandLogoIcon size={15} />
              <strong className="brand-mark">T·Grid</strong>
            </span>
          </div>

          {tabStrip}

          <div className="titlebar-drag-spacer" data-tauri-drag-region="" />

          <div className="window-controls" role="group" aria-label="窗口控制">
            <button
              type="button"
              className="win-btn"
              title="最小化"
              aria-label="最小化"
              onClick={() => void handleMinimize()}
            >
              <TGridIcon name="win-minimize" size={13} />
            </button>
            <button
              type="button"
              className="win-btn"
              title={isMaximized ? '还原窗口' : '最大化'}
              aria-label={isMaximized ? '还原窗口' : '最大化'}
              onClick={() => void handleToggleMaximize()}
            >
              {isMaximized ? (
                <TGridIcon name="win-restore" size={13} />
              ) : (
                <TGridIcon name="win-maximize" size={13} />
              )}
            </button>
            <button
              type="button"
              className="win-btn win-close"
              title="关闭"
              aria-label="关闭"
              onClick={() => void handleCloseWindow()}
            >
              <TGridIcon name="win-close" size={13} />
            </button>
          </div>
        </div>
      ) : (
        <div className="tabbar">
          <h1 className="brand tabbar-brand">
            <BrandLogoIcon size={16} />
            <strong className="brand-mark">T·Grid</strong>
            <span className="brand-sub">TextGrid Editor</span>
            <span className="sr-only"> — Praat TextGrid 编辑器与语音标注出图工具</span>
          </h1>
          {tabStrip}
        </div>
      )}

      <header className="topbar is-desktop-toolbar">
        <div className="bar-group">
          {collectionTgs.length > 1 && (
            <>
              <div className={`menu-wrap ${openMenu === 'col' ? 'open' : ''}`}>
                <button
                  type="button"
                  className="select-trigger"
                  title="切换集合中的对象"
                  onClick={() => setOpenMenu(openMenu === 'col' ? null : 'col')}
                >
                  <span>
                    {collectionActiveIdx + 1}. {collectionTgs[collectionActiveIdx]?.name || 'TextGrid'}
                  </span>
                  <ChevronIcon />
                </button>
                <div className="dropdown left">
                  {collectionTgs.map((item, idx) => (
                    <button
                      key={`${item.name}-${idx}`}
                      type="button"
                      className={idx === collectionActiveIdx ? 'selected' : ''}
                      onClick={() => {
                        switchCollectionItem(idx);
                        setOpenMenu(null);
                      }}
                    >
                      <span>
                        {idx + 1}. {item.name || `TextGrid ${idx + 1}`}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="sep" />
            </>
          )}

          <button
            type="button"
            title={
              openFilesHint
                ? `打开 TextGrid / Collection / 单层文件 (${openFilesHint})`
                : '打开 TextGrid / Collection / 单层文件'
            }
            onClick={onOpenTextGridPicker}
          >
            <UiIcon name="folder" size={14} />
            <span>打开文件</span>
          </button>
          <button
            type="button"
            title={openAudioHint ? `载入配套录音 (${openAudioHint})` : '载入配套录音'}
            onClick={onOpenAudioPicker}
          >
            <UiIcon name="waveform" size={14} />
            <span>打开录音</span>
          </button>

          <div className={`menu-wrap ${openMenu === 'samples' ? 'open' : ''}`}>
            <button
              type="button"
              className="select-trigger"
              onClick={() => setOpenMenu(openMenu === 'samples' ? null : 'samples')}
            >
              <span className="btn-lead">
                <UiIcon name="samples" size={14} />
                <span>示例</span>
              </span>
              <ChevronIcon />
            </button>
            <div className="dropdown left">
              <button type="button" onClick={() => { setOpenMenu(null); onLoadSample('dialogue'); }}>
                <span className="btn-lead">
                  <UiIcon name="waveform" size={13} />
                  <span>双人对话与声谱（含录音）</span>
                </span>
              </button>
              <button type="button" onClick={() => { setOpenMenu(null); onLoadSample('poem'); }}>
                <span className="btn-lead">
                  <UiIcon name="samples" size={13} />
                  <span>普通话与音标示例</span>
                </span>
              </button>
              <button type="button" onClick={() => { setOpenMenu(null); onLoadSample('edge'); }}>
                <span className="btn-lead">
                  <UiIcon name="samples" size={13} />
                  <span>完整字符与边界示例</span>
                </span>
              </button>
              <button type="button" onClick={() => { setOpenMenu(null); onLoadSample('wild'); }}>
                <span className="btn-lead">
                  <UiIcon name="samples" size={13} />
                  <span>长停顿与特殊结构示例</span>
                </span>
              </button>
              <div className="menu-divider" />
              <button type="button" onClick={() => { setOpenMenu(null); onLoadSample('blank'); }}>
                <span className="btn-lead">
                  <UiIcon name="tab-add" size={13} />
                  <span>新建空白文件</span>
                </span>
                <span className="shortcut">{formatKeyCombo('Mod+T')}</span>
              </button>
            </div>
          </div>

          <div className={`menu-wrap ${openMenu === 'tools' ? 'open' : ''}`}>
            <button
              type="button"
              className="select-trigger"
              onClick={() => setOpenMenu(openMenu === 'tools' ? null : 'tools')}
            >
              <span className="btn-lead">
                <UiIcon name="tools" size={14} />
                <span>工具</span>
              </span>
              <ChevronIcon />
            </button>
            <div className="dropdown left">
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  openFindBar(false);
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="search" size={13} />
                  <span>查找与替换</span>
                </span>
                {findOpenHint && <span className="shortcut">{findOpenHint}</span>}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  openFindBar(true);
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="replace" size={13} />
                  <span>替换标注文本…</span>
                </span>
                {replaceOpenHint && <span className="shortcut">{replaceOpenHint}</span>}
              </button>
              <div className="menu-divider" />
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  setSidebarTab('customize');
                  setSidebarOpen(true);
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="customize" size={13} />
                  <span>自定义悬浮条与快捷键</span>
                </span>
                <span className="shortcut">Alt+4</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  setShortcutsOpen(true);
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="shortcuts" size={13} />
                  <span>快捷键指南</span>
                </span>
                {shortcutsModalHint && <span className="shortcut">{shortcutsModalHint}</span>}
              </button>
            </div>
          </div>
        </div>

        <div className="bar-group topbar-right">
          <div className="segmented" role="group">
            <button
              type="button"
              className={mode === 'read' ? 'active' : ''}
              onClick={() => setMode('read')}
            >
              <UiIcon name="readMode" size={13} />
              <span>只读</span>
            </button>
            <button
              type="button"
              className={mode === 'edit' ? 'active' : ''}
              onClick={() => setMode('edit')}
            >
              <UiIcon name="edit" size={13} />
              <span>编辑</span>
            </button>
          </div>

          <button
            type="button"
            className={legendOpen ? 'active' : ''}
            aria-expanded={legendOpen}
            title="在底部显示或隐藏交互式读图图例"
            onClick={toggleLegend}
          >
            <UiIcon name="legend" size={14} />
            <span>图例</span>
          </button>

          <button
            type="button"
            className={sidebarOpen && sidebarTab === 'settings' ? 'active' : ''}
            aria-expanded={sidebarOpen && sidebarTab === 'settings'}
            title="在右侧边栏打开版面、时间精度与声学设置"
            onClick={() => toggleSidebarTab('settings')}
          >
            <UiIcon name="gear" size={14} />
            <span>设置</span>
          </button>

          <div className={`menu-wrap ${openMenu === 'export' ? 'open' : ''}`}>
            <button
              type="button"
              className="primary select-trigger"
              onClick={() => setOpenMenu(openMenu === 'export' ? null : 'export')}
            >
              <span className="btn-lead">
                <UiIcon name="export" size={14} />
                <span>导出与保存</span>
              </span>
              <ChevronIcon />
            </button>
            <div className="dropdown">
              <button type="button" onClick={() => { setOpenMenu(null); onExportAction('save'); }}>
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>{isDesktop && !currentFilePath ? '保存 (.TextGrid)…' : '保存 (.TextGrid)'}</span>
                </span>
                {saveFileHint && <span className="shortcut">{saveFileHint}</span>}
              </button>
              {isDesktop && (
                <button type="button" onClick={() => { setOpenMenu(null); onExportAction('save-as'); }}>
                  <span className="btn-lead">
                    <UiIcon name="saveAs" size={13} />
                    <span>另存为…</span>
                  </span>
                  {saveAsHint && <span className="shortcut">{saveAsHint}</span>}
                </button>
              )}
              <div className="menu-divider" />
              <button type="button" onClick={() => { setOpenMenu(null); onExportAction('svg'); }}>
                <span className="btn-lead">
                  <UiIcon name="exportSvg" size={13} />
                  <span>导出矢量图 (.svg)</span>
                </span>
              </button>
              <button type="button" onClick={() => { setOpenMenu(null); onExportAction('png'); }}>
                <span className="btn-lead">
                  <UiIcon name="exportPng" size={13} />
                  <span>导出高清图片 (.png)</span>
                </span>
              </button>
              <button type="button" onClick={() => { setOpenMenu(null); onExportAction('dialog'); }}>
                <span className="btn-lead">
                  <UiIcon name="export" size={13} />
                  <span>自定义导出图像…</span>
                </span>
                {exportFigureHint && <span className="shortcut">{exportFigureHint}</span>}
              </button>
              <div className="menu-divider" />
              <button type="button" onClick={() => { setOpenMenu(null); onExportAction('poster'); }}>
                <span className="btn-lead">
                  <UiIcon name="exportSvg" size={13} />
                  <span>导出声纹海报…</span>
                </span>
              </button>
              <div className="menu-divider" />
              <button type="button" onClick={() => { setOpenMenu(null); onExportAction('long'); }}>
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>保存标准文本 (.TextGrid)</span>
                </span>
              </button>
              <button type="button" onClick={() => { setOpenMenu(null); onExportAction('short'); }}>
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>保存短文本 (.TextGrid)</span>
                </span>
              </button>
              <button type="button" onClick={() => { setOpenMenu(null); onExportAction('binary'); }}>
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>保存二进制 (.TextGrid)</span>
                </span>
              </button>
              <button type="button" onClick={() => { setOpenMenu(null); onExportAction('chrono'); }}>
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>保存按时间排序文本</span>
                </span>
              </button>
              <div className="menu-divider" />
              <button type="button" onClick={() => { setOpenMenu(null); onExportAction('col-bin'); }}>
                <span className="btn-lead">
                  <UiIcon name="fileCollection" size={13} />
                  <span>保存集合 (.Collection 二进制)</span>
                </span>
              </button>
              <button type="button" onClick={() => { setOpenMenu(null); onExportAction('col-text'); }}>
                <span className="btn-lead">
                  <UiIcon name="fileCollection" size={13} />
                  <span>保存集合 (.Collection 文本)</span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </header>
    </div>
  );
};
