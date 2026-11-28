import React, { useEffect, useRef, useState } from 'react';
import { isTauriRuntime } from '../bridge/PlatformBridge';
import { formatKeyCombo } from '../shortcuts/registry';
import { useEditorStore } from '../store/useEditorStore';
import type { BuiltinSampleId } from '../data/samples';
import { CorpusFolderIcon } from '../corpus/corpusIcons';
import { getCorpusUnsavedSummary } from '../corpus/draftManager';
import { CloseIcon, TGridIcon, UiIcon } from './Icons';
import { RibbonBar } from './RibbonBar';

const BrandLockupLogo: React.FC<{ height: number }> = ({ height }) => {
  const width = Math.round((height * 352.5) / 72 * 10) / 10;
  return (
    <svg
      className="brand-lockup-svg"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="24 24 352.5 72"
      width={width}
      height={height}
      fill="none"
      aria-hidden="true"
    >
      <g>
        <path
          d="M 26.5 24 H 93.5 A 2.5 2.5 0 0 1 96 26.5 V 37.5 A 2.5 2.5 0 0 1 93.5 40 H 68 V 93.5 A 2.5 2.5 0 0 1 65.5 96 H 54.5 A 2.5 2.5 0 0 1 52 93.5 V 40 H 26.5 A 2.5 2.5 0 0 1 24 37.5 V 26.5 A 2.5 2.5 0 0 1 26.5 24 Z"
          fill="#141413"
        />
        <rect x="24" y="46" width="22" height="19" rx="2.5" fill="#1E62F5" />
        <rect x="24" y="71" width="22" height="25" rx="2.5" fill="#CBC6BC" />
        <rect x="74" y="46" width="22" height="25" rx="2.5" fill="#CBC6BC" />
        <rect x="74" y="77" width="22" height="19" rx="2.5" fill="#732BF5" />
      </g>
      <g>
        <path
          d="M 128 33 H 168 A 2 2 0 0 1 170 35 V 41.8 A 2 2 0 0 1 168 43.8 H 153.8 V 85 A 2 2 0 0 1 151.8 87 H 144.2 A 2 2 0 0 1 142.2 85 V 43.8 H 128 A 2 2 0 0 1 126 41.8 V 35 A 2 2 0 0 1 128 33 Z"
          fill="#1E62F5"
        />
        <circle cx="191.5" cy="60" r="5.8" fill="#732BF5" />
        <path
          d="M 264.5 43.4 A 27.8 28.2 0 1 0 269.7 57.5 H 242.5 V 67.3 H 256.9 A 16.4 17.4 0 1 1 255.3 49.8 Z"
          fill="#141413"
        />
        <path
          d="M 282.1 48.0 H 289.7 A 1.6 1.6 0 0 1 291.3 49.6 V 54.8 C 293.8 49.6 298.0 47.2 303.5 47.2 C 304.4 47.2 305.2 47.3 305.8 47.5 V 57.5 C 304.6 57.2 303.2 57.1 301.6 57.1 C 295.2 57.1 291.5 61.0 291.5 68.2 V 85.4 A 1.6 1.6 0 0 1 289.9 87.0 H 282.1 A 1.6 1.6 0 0 1 280.5 85.4 V 49.6 A 1.6 1.6 0 0 1 282.1 48.0 Z"
          fill="#141413"
        />
        <circle cx="318.5" cy="36.8" r="6.0" fill="#141413" />
        <rect x="313.0" y="48.0" width="11.0" height="39.0" rx="1.6" fill="#141413" />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M 367.1 31.0 H 374.9 A 1.6 1.6 0 0 1 376.5 32.6 V 85.4 A 1.6 1.6 0 0 1 374.9 87.0 H 367.1 A 1.6 1.6 0 0 1 365.5 85.4 V 84.8 A 20.5 20.5 0 1 1 365.5 50.2 V 32.6 A 1.6 1.6 0 0 1 367.1 31.0 Z M 355.0 56.9 A 10.2 10.6 0 1 0 355.0 78.1 A 10.2 10.6 0 1 0 355.0 56.9 Z"
          fill="#141413"
        />
      </g>
    </svg>
  );
};

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
    const activeHasUnsaved =
      activeTabNow?.kind === 'corpus' && activeTabNow.corpus
        ? getCorpusUnsavedSummary(activeTabNow.corpus, isDirty).hasAnyUnsaved
        : isDirty;
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
          const corpusSummary = isCorpus
            ? getCorpusUnsavedSummary(tab.corpus!, tab.isDirty)
            : null;
          const corpusUnsavedCount = corpusSummary?.unsavedCount ?? 0;
          const corpusHasUnsaved = corpusSummary?.hasAnyUnsaved ?? false;
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
              : corpusSummary?.projectIndexDirty
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
              <BrandLockupLogo height={16} />
              <span className="sr-only">T·Grid</span>
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
            <BrandLockupLogo height={17} />
            <span className="sr-only">T·Grid</span>
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
