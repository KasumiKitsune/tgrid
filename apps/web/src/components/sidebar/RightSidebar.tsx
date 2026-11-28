import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { getTabAudioBuffer } from '../../audio/tabAudioStore';
import { formatKeyCombo } from '../../shortcuts/registry';
import { useEditorStore, type SidebarTab } from '../../store/useEditorStore';
import { scanTextGridQa } from '../../utils/qaDiagnostics';
import { getLogicalViewportSize, getViewportZoom } from '../../utils/uiScale';
import { CloseIcon, InfoIcon, ShortcutsIcon, UiIcon, type IconName } from '../Icons';
import { CustomizePanel } from './CustomizePanel';
import { HistoryPanel } from './HistoryPanel';
import { InspectorPanel, type InspectorPanelHandle } from './InspectorPanel';
import { SettingsPanel } from './SettingsPanel';
import { StylePanel } from './StylePanel';
import { TiersPanel } from './TiersPanel';

export interface RightSidebarHandle {
  insertIpaSymbol: (sym: string, isTieBar?: boolean) => boolean;
  flushDraft: () => void;
}

interface RightSidebarProps {
  onStartPlayback: (startT: number, endT: number) => void;
  onOpenAudioPicker: () => void;
  onClearAudio: () => void;
  onBatchConvertIpa?: (direction: 'toUnicode' | 'toPraat') => void;
  audioBuffer?: AudioBuffer | null;
  onOpenSplitModal?: (tierIndex: number, itemIndex: number) => void;
  /** 按需唤出的语音切分 (VAD) 面板槽位（不占用右侧 Rail 常驻图标格位） */
  vadOpen?: boolean;
  vadPanel?: React.ReactNode;
  vadHeadBadge?: string;
  onCloseVad?: () => void;
}

const RAIL_ITEMS: Array<{ tab: SidebarTab; title: string; icon: IconName; tooltip: string }> = [
  { tab: 'inspector', title: '属性', icon: 'inspector', tooltip: '属性检查器 (Alt+1)' },
  { tab: 'style', title: '样式', icon: 'stylePalette', tooltip: '外观与学术样式 (Alt+2)' },
  { tab: 'tiers', title: '层级', icon: 'layers', tooltip: '层级列表与管理 (Alt+3)' },
  { tab: 'history', title: '历史', icon: 'history', tooltip: '操作历史记录 (Alt+4)' },
  { tab: 'settings', title: '画布与声学', icon: 'waveform', tooltip: '谱面排版与声学图谱 (Alt+5)' }
];

export const RightSidebar = forwardRef<RightSidebarHandle, RightSidebarProps>(
  (
    {
      onStartPlayback,
      onOpenAudioPicker,
      onClearAudio,
      audioBuffer,
      onOpenSplitModal,
      vadOpen = false,
      vadPanel,
      vadHeadBadge,
      onCloseVad
    },
    ref
  ) => {
    const sidebarOpen = useEditorStore((s) => s.sidebarOpen);
    const sidebarTab = useEditorStore((s) => s.sidebarTab);
    const sidebarWidth = useEditorStore((s) => s.sidebarWidth);
    const setSidebarOpen = useEditorStore((s) => s.setSidebarOpen);
    const toggleSidebarTab = useEditorStore((s) => s.toggleSidebarTab);
    const setSidebarWidth = useEditorStore((s) => s.setSidebarWidth);
    const preferencesOpen = useEditorStore((s) => s.preferencesOpen);
    const preferencesSection = useEditorStore((s) => s.preferencesSection);
    const setPreferencesOpen = useEditorStore((s) => s.setPreferencesOpen);
    const aboutOpen = useEditorStore((s) => s.aboutOpen);
    const setAboutOpen = useEditorStore((s) => s.setAboutOpen);
    const shortcutsOpen = useEditorStore((s) => s.shortcutsOpen);
    const setShortcutsOpen = useEditorStore((s) => s.setShortcutsOpen);
    const tg = useEditorStore((s) => s.tg);
    const tierCount = tg.tiers.length;
    const selection = useEditorStore((s) => s.selection);
    const multiSelection = useEditorStore((s) => s.multiSelection);
    const playRange = useEditorStore((s) => s.playRange);
    const history = useEditorStore((s) => s.history);
    const activeTabId = useEditorStore((s) => s.activeTabId);
    const audioName = useEditorStore((s) => s.audioName);
    const audioDuration = useEditorStore((s) => s.audioDuration);

    const effectiveAudioBuffer = useMemo(() => {
      void audioName;
      void audioDuration;
      return audioBuffer ?? getTabAudioBuffer(activeTabId);
    }, [audioBuffer, activeTabId, audioName, audioDuration]);

    const hasQaIssues = useMemo(() => scanTextGridQa(tg).counts.total > 0, [tg]);

    const [resizing, setResizing] = useState(false);
    const inspectorRef = useRef<InspectorPanelHandle>(null);
    const paneRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(
      ref,
      () => ({
        insertIpaSymbol: (sym: string, isTieBar?: boolean) => {
          if (!sidebarOpen || sidebarTab !== 'inspector') return false;
          return inspectorRef.current?.insertIpaSymbol(sym, isTieBar) ?? false;
        },
        flushDraft: () => {
          inspectorRef.current?.flushDraft();
          const activeEl = document.activeElement as HTMLElement | null;
          if (
            activeEl &&
            paneRef.current?.contains(activeEl) &&
            (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')
          ) {
            activeEl.blur();
          }
        }
      }),
      [sidebarOpen, sidebarTab]
    );

    const isVadActive = Boolean(vadOpen && vadPanel);
    const effectiveOpen = sidebarOpen || isVadActive;

    const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || !effectiveOpen) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      setResizing(true);
      document.body.style.cursor = 'col-resize';

      let collapsed = false;
      const onMove = (ev: PointerEvent) => {
        const z = getViewportZoom();
        const { width: vw } = getLogicalViewportSize();
        const maxSafeW = Math.max(220, Math.min(460, Math.floor(vw * 0.48 - 42)));
        const rawW = startWidth + (startX - ev.clientX) / z;
        if (rawW < 175) {
          if (!collapsed) {
            collapsed = true;
            if (isVadActive) {
              onCloseVad?.();
            } else {
              setSidebarOpen(false);
            }
          }
          return;
        }
        if (collapsed && !isVadActive) {
          collapsed = false;
          setSidebarOpen(true);
        }
        setSidebarWidth(Math.min(maxSafeW, rawW));
      };

      const onUp = () => {
        setResizing(false);
        document.body.style.cursor = '';
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };

    const activeItem =
      RAIL_ITEMS.find((r) => r.tab === sidebarTab) ||
      (sidebarTab === 'customize'
        ? { tab: 'customize' as SidebarTab, title: '自定义', icon: 'customize' as IconName, tooltip: '自定义' }
        : RAIL_ITEMS[0]);

    let headBadge = '';
    if (sidebarTab === 'tiers') {
      headBadge = `${tierCount} 层`;
    } else if (sidebarTab === 'history') {
      headBadge = `${history.cursor + 1} / ${history.entries.length} 步`;
    } else if (sidebarTab === 'customize') {
      headBadge = '悬浮条 · 快捷键';
    } else if (sidebarTab === 'style') {
      if (multiSelection.length >= 2) headBadge = `多选 (${multiSelection.length})`;
      else if (selection?.kind === 'interval') headBadge = '区间';
      else if (selection?.kind === 'point') headBadge = '标点';
      else if (selection?.kind === 'boundary') headBadge = '边界';
      else if (selection?.kind === 'spine') headBadge = '对齐时刻';
      else if (selection?.kind === 'tier') headBadge = '层级';
      else headBadge = '主题';
    } else if (sidebarTab === 'inspector') {
      if (multiSelection.length >= 2) headBadge = `多选 (${multiSelection.length})`;
      else if (selection?.kind === 'interval') headBadge = '区间';
      else if (selection?.kind === 'point') headBadge = '标点';
      else if (selection?.kind === 'boundary') headBadge = '边界';
      else if (selection?.kind === 'spine') headBadge = '对齐时刻';
      else if (selection?.kind === 'tier') headBadge = '层级';
      else if (playRange && playRange.end > playRange.start) headBadge = '选区';
      else headBadge = '文档';
    }

    const customizeModalActive =
      preferencesOpen &&
      (preferencesSection === 'floating' || preferencesSection === 'shortcuts');
    const prefsGearActive =
      preferencesOpen &&
      (preferencesSection === 'editing' || preferencesSection === 'general');

    const displayTitle = isVadActive ? '语音切分 (VAD)' : activeItem.title;
    const displayBadge = isVadActive ? (vadHeadBadge ?? '') : headBadge;

    return (
      <aside
        className={`right-sidebar ${effectiveOpen ? 'open' : 'collapsed'} ${resizing ? 'is-resizing resizing' : ''}`}
      >
        <div
          ref={paneRef}
          className={`sidebar-pane ${resizing ? 'is-resizing' : ''}`}
          style={{ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}
          aria-label={`${displayTitle}侧边面板`}
          aria-hidden={!effectiveOpen}
        >
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧边栏宽度"
            title="左右拖拽调整宽度，拖窄收起，双击恢复默认"
            onPointerDown={handleResizePointerDown}
            onDoubleClick={() => setSidebarWidth(300)}
          />

          <div className="sidebar-pane-inner">
            <div className="sidebar-head">
              <div className="sidebar-head-left">
                <span className="sidebar-title">{displayTitle}</span>
                {displayBadge && <span className="sidebar-head-badge">{displayBadge}</span>}
              </div>
              <button
                type="button"
                className="icon-btn compact sidebar-close-btn"
                title={isVadActive ? '退出语音切分预览 (Esc)' : '收起面板 (Ctrl+B)'}
                aria-label={isVadActive ? '关闭语音切分面板' : '收起面板'}
                tabIndex={effectiveOpen ? 0 : -1}
                onClick={() => {
                  if (isVadActive) {
                    onCloseVad?.();
                  } else {
                    setSidebarOpen(false);
                  }
                }}
              >
                <CloseIcon />
              </button>
            </div>

            <div
              className={`sidebar-body ${isVadActive || sidebarTab === 'history' ? 'is-full-height' : ''}`}
            >
              {isVadActive ? (
                vadPanel
              ) : (
                <>
                  {sidebarTab === 'inspector' && (
                    <InspectorPanel
                      ref={inspectorRef}
                      onStartPlayback={onStartPlayback}
                      audioBuffer={effectiveAudioBuffer}
                      onOpenSplitModal={onOpenSplitModal}
                    />
                  )}
                  {sidebarTab === 'style' && <StylePanel />}
                  {sidebarTab === 'tiers' && <TiersPanel />}
                  {sidebarTab === 'history' && <HistoryPanel />}
                  {sidebarTab === 'settings' && (
                    <SettingsPanel
                      onOpenAudioPicker={onOpenAudioPicker}
                      onClearAudio={onClearAudio}
                    />
                  )}
                  {sidebarTab === 'customize' && <CustomizePanel />}
                </>
              )}
            </div>
          </div>
        </div>

        <nav className="sidebar-rail" aria-label="右侧功能切换栏">
          {RAIL_ITEMS.map((item) => {
            const isActive = !isVadActive && sidebarOpen && sidebarTab === item.tab;
            const showQaDot = item.tab === 'inspector' && hasQaIssues;
            return (
              <button
                key={item.tab}
                type="button"
                className={`sidebar-rail-btn ${isActive ? 'active' : ''}`}
                title={
                  showQaDot
                    ? `${item.title} — ${item.tooltip}（检测到结构或微偏异常）`
                    : `${item.title} — ${item.tooltip}`
                }
                aria-label={showQaDot ? `${item.title}（存在数据检查提醒）` : item.title}
                aria-pressed={isActive}
                onClick={() => {
                  if (isVadActive) {
                    onCloseVad?.();
                    if (!sidebarOpen || sidebarTab !== item.tab) {
                      toggleSidebarTab(item.tab);
                    }
                  } else {
                    toggleSidebarTab(item.tab);
                  }
                }}
              >
                <UiIcon name={item.icon} size={16} />
                {showQaDot && (
                  <span
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      width: 6,
                      height: 6,
                      background: 'var(--accent-amber)',
                      boxShadow: '0 0 0 1.5px var(--bg-subtle)',
                      pointerEvents: 'none'
                    }}
                  />
                )}
              </button>
            );
          })}

          <button
            type="button"
            className={`sidebar-rail-btn ${customizeModalActive ? 'active' : ''}`}
            title="自定义悬浮条按钮与快捷键 (Alt+6)"
            aria-label="自定义悬浮条按钮与快捷键"
            aria-pressed={customizeModalActive}
            onClick={() => setPreferencesOpen(true, 'floating')}
          >
            <UiIcon name="customize" size={16} />
          </button>

          <div className="sidebar-rail-bottom">
            <button
              type="button"
              className={`sidebar-rail-btn ${shortcutsOpen ? 'active' : ''}`}
              title="快捷键与操作指南 (?)"
              aria-label="快捷键与操作指南"
              aria-pressed={shortcutsOpen}
              onClick={() => setShortcutsOpen(true)}
            >
              <ShortcutsIcon size={16} />
            </button>
            <button
              type="button"
              className={`sidebar-rail-btn ${prefsGearActive ? 'active' : ''}`}
              title={`偏好设置 (${formatKeyCombo('Mod+,')})`}
              aria-label="偏好设置"
              aria-pressed={preferencesOpen}
              onClick={() =>
                setPreferencesOpen(!preferencesOpen, preferencesOpen ? undefined : 'editing')
              }
            >
              <UiIcon name="gear" size={16} />
            </button>
            <button
              type="button"
              className={`sidebar-rail-btn ${aboutOpen ? 'active' : ''}`}
              title="关于 T·Grid"
              aria-label="关于 T·Grid"
              aria-pressed={aboutOpen}
              onClick={() => setAboutOpen(!aboutOpen)}
            >
              <InfoIcon size={16} />
            </button>
          </div>
        </nav>
      </aside>
    );
  }
);
