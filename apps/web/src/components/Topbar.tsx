import React, { useEffect, useRef, useState } from 'react';
import { isTauriRuntime } from '../bridge/PlatformBridge';
import { formatKeyCombo } from '../shortcuts/registry';
import { useEditorStore } from '../store/useEditorStore';
import type { BuiltinSampleId } from '../data/samples';
import { CorpusFolderIcon } from '../corpus/corpusIcons';
import { BrandLogoIcon, CloseIcon, TGridIcon, UiIcon } from './Icons';
import { RibbonBar } from './RibbonBar';

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

export interface TopbarProps {
  onOpenTextGridPicker: () => void;
  onOpenCorpusFolder: () => void;
  onOpenAudioPicker: () => void;
  onLoadSample: (id: BuiltinSampleId) => void;
  onExportAction: (kind: ExportActionKind) => void;
  onNewTab: () => void;
  onSwitchTab: (tabId: string) => void;
  onRequestCloseTab: (tabId: string) => void;
  ctxTargetTabId?: string | null;
  onTabContextMenu?: (tabId: string, e: React.MouseEvent) => void;
  onTabStripBlankContextMenu?: (e: React.MouseEvent) => void;
  onBatchConvertIpa: (direction: 'toUnicode' | 'toPraat') => void;
  corpusCanPrev?: boolean;
  corpusCanNext?: boolean;
  onCorpusPrev?: () => void;
  onCorpusNext?: () => void;
  onToggleCorpusAutoPlay?: () => void;
  onToggleCorpusAutoVad?: () => void;
  onCorpusSaveCurrent?: () => void;
  onCorpusSaveAll?: () => void;
  onToggleCorpusAutoSave?: () => void;
  corpusSaveProgress?: { done: number; total: number } | null;
  onExportCorpusZip?: () => void;
  exportingCorpusZip?: boolean;
}

export const Topbar: React.FC<TopbarProps> = ({
  onOpenTextGridPicker,
  onOpenCorpusFolder,
  onOpenAudioPicker,
  onLoadSample,
  onExportAction,
  onNewTab,
  onSwitchTab,
  onRequestCloseTab,
  ctxTargetTabId,
  onTabContextMenu,
  onTabStripBlankContextMenu,
  onBatchConvertIpa,
  corpusCanPrev,
  corpusCanNext,
  onCorpusPrev,
  onCorpusNext,
  onToggleCorpusAutoPlay,
  onToggleCorpusAutoVad,
  onCorpusSaveCurrent,
  onCorpusSaveAll,
  onToggleCorpusAutoSave,
  corpusSaveProgress,
  onExportCorpusZip,
  exportingCorpusZip
}) => {
  const isDesktop = isTauriRuntime();

  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const filename = useEditorStore((s) => s.filename);
  const isDirty = useEditorStore((s) => s.isDirty);
  const showCorpusStatusMarks = useEditorStore((s) => s.showCorpusStatusMarks);

  const [isMaximized, setIsMaximized] = useState(false);
  const tabstripRef = useRef<HTMLDivElement>(null);

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
    const onScroll = () => {
      window.dispatchEvent(new Event('tg-close-tab-ctx'));
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    strip.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      strip.removeEventListener('wheel', onWheel);
      strip.removeEventListener('scroll', onScroll);
    };
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
    const activeTabNow = tabs.find((t) => t.id === activeTabId);
    const activeCorpusExt =
      activeTabNow?.kind === 'corpus' && activeTabNow.corpus
        ? (activeTabNow.corpus as typeof activeTabNow.corpus & {
            unsavedItemIds?: string[];
            projectIndexDirty?: boolean;
          })
        : null;
    const activeHasUnsaved = Boolean(
      isDirty ||
        (activeCorpusExt &&
          ((activeCorpusExt.unsavedItemIds?.length ?? 0) > 0 ||
            Boolean(activeCorpusExt.projectIndexDirty)))
    );
    const defaultWebTitle = 'T·Grid — Praat TextGrid 编辑器与语音标注出图工具';
    const isUnmodifiedDefaultSample =
      !isDesktop && !activeHasUnsaved && tabs.length <= 1 && (!filename || filename === '春晓示例.TextGrid');
    const docLabel = filename ? `${activeHasUnsaved ? '● ' : ''}${filename} — ` : '';
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
  }, [filename, isDirty, isDesktop, tabs, activeTabId]);

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

  const handleBlankStripContextMenu = (e: React.MouseEvent) => {
    if (!onTabStripBlankContextMenu) return;
    if ((e.target as HTMLElement).closest('.tab-item, .tab-add-btn, .win-btn')) return;
    e.preventDefault();
    e.stopPropagation();
    (e.nativeEvent as MouseEvent & { __tgCtxHandled?: boolean }).__tgCtxHandled = true;
    onTabStripBlankContextMenu(e);
  };

  const tabStrip = (
    <div
      className="tabstrip-area"
      onContextMenu={handleBlankStripContextMenu}
      onDoubleClick={(e) => {
        if (isDesktop) return;
        if ((e.target as HTMLElement).closest('.tab-item, button')) return;
        onNewTab();
      }}
    >
      <div
        ref={tabstripRef}
        className="tabstrip"
        role="tablist"
        aria-label="已打开的文档标签页"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isCorpus = tab.kind === 'corpus' && Boolean(tab.corpus);
          const corpusExt = isCorpus
            ? (tab.corpus! as typeof tab.corpus & {
                unsavedItemIds?: string[];
                projectIndexDirty?: boolean;
              })
            : null;
          const corpusUnsavedCount = isCorpus
            ? Math.max(
                corpusExt?.unsavedItemIds?.length ?? 0,
                tab.isDirty ? 1 : 0
              )
            : 0;
          const corpusHasUnsaved = isCorpus
            ? Boolean(
                tab.isDirty ||
                  corpusUnsavedCount > 0 ||
                  corpusExt?.projectIndexDirty ||
                  (!tab.corpus!.writable && tab.corpus!.dirtyCount > 0)
              )
            : false;
          const tabHasUnsaved = isCorpus ? corpusHasUnsaved : tab.isDirty;
          const corpusTotal = isCorpus ? tab.corpus!.items.length : 0;
          let corpusDone = 0;
          if (isCorpus) {
            for (let i = 0; i < tab.corpus!.items.length; i++) {
              if (tab.corpus!.items[i].status === 'done') corpusDone += 1;
            }
          }
          const displayTitle = isCorpus ? tab.corpus!.projectName : tab.filename;
          const progressText = showCorpusStatusMarks
            ? `${corpusDone}/${corpusTotal}`
            : `${corpusTotal}`;
          const progressTitle = showCorpusStatusMarks
            ? `已完成 ${corpusDone} / 共 ${corpusTotal} 条`
            : `共 ${corpusTotal} 条`;
          const corpusUnsavedHint = !corpusHasUnsaved
            ? ''
            : corpusUnsavedCount > 0
              ? ` · 有 ${corpusUnsavedCount} 条词条未保存`
              : corpusExt?.projectIndexDirty
                ? ' · 有未保存的项目状态变更'
                : !tab.corpus!.writable && tab.corpus!.dirtyCount > 0
                  ? ` · 已暂存 ${tab.corpus!.dirtyCount} 项修改`
                  : ' · 有未保存修改';
          const tooltip = isCorpus
            ? `${tab.corpus!.projectName} (${progressText})${corpusUnsavedHint}${tab.filename ? ` · 当前：${tab.filename}` : ''}`
            : tab.currentFilePath
              ? `${tab.currentFilePath}${tab.isDirty ? ' (未保存)' : ''}`
              : `${tab.filename}${tab.isDirty ? ' (未保存)' : ''}`;
          return (
            <div
              key={tab.id}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              data-tab-active={isActive ? 'true' : undefined}
              className={`tab-item ${isActive ? 'active' : ''} ${isCorpus ? 'is-corpus' : ''} ${ctxTargetTabId === tab.id ? 'ctx-target' : ''}`}
              title={tooltip}
              onClick={() => onSwitchTab(tab.id)}
              onContextMenu={(e) => {
                if (!onTabContextMenu) return;
                e.preventDefault();
                e.stopPropagation();
                (e.nativeEvent as MouseEvent & { __tgCtxHandled?: boolean }).__tgCtxHandled = true;
                onTabContextMenu(tab.id, e);
              }}
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
              {tabHasUnsaved && (
                <span
                  className="dirty-dot"
                  aria-label={
                    isCorpus && corpusUnsavedCount > 0
                      ? `有 ${corpusUnsavedCount} 条词条未保存`
                      : '有未保存的修改'
                  }
                />
              )}
              {isCorpus ? (
                <span className="tab-corpus-ind" title={`文件夹项目：${tab.corpus!.projectName}`}>
                  <CorpusFolderIcon size={12} />
                </span>
              ) : (
                tab.audioName && (
                  <span className="tab-audio-ind" title={`已载入录音：${tab.audioName}`}>
                    <UiIcon name="waveform" size={11} />
                  </span>
                )
              )}
              <span className="tab-label" title={tooltip}>
                {displayTitle}
              </span>
              {isCorpus && (
                <span className="tab-corpus-progress" title={progressTitle}>
                  {progressText}
                </span>
              )}
              <button
                type="button"
                className="tab-close-btn"
                title={`关闭标签页 (${formatKeyCombo('Mod+W')})`}
                aria-label={`关闭 ${displayTitle}`}
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
    <div className="topbar-stack">
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

          <div
            className="titlebar-drag-spacer"
            data-tauri-drag-region=""
            onContextMenu={handleBlankStripContextMenu}
          />

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

      <RibbonBar
        onOpenTextGridPicker={onOpenTextGridPicker}
        onOpenCorpusFolder={onOpenCorpusFolder}
        onOpenAudioPicker={onOpenAudioPicker}
        onLoadSample={onLoadSample}
        onExportAction={onExportAction}
        onBatchConvertIpa={onBatchConvertIpa}
        corpusCanPrev={corpusCanPrev}
        corpusCanNext={corpusCanNext}
        onCorpusPrev={onCorpusPrev}
        onCorpusNext={onCorpusNext}
        onToggleCorpusAutoPlay={onToggleCorpusAutoPlay}
        onToggleCorpusAutoVad={onToggleCorpusAutoVad}
        onCorpusSaveCurrent={onCorpusSaveCurrent}
        onCorpusSaveAll={onCorpusSaveAll}
        onToggleCorpusAutoSave={onToggleCorpusAutoSave}
        corpusSaveProgress={corpusSaveProgress}
        onExportCorpusZip={onExportCorpusZip}
        exportingCorpusZip={exportingCorpusZip}
      />
    </div>
  );
};
