import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { useEditorStore, type SidebarTab } from '../../store/useEditorStore';
import { CloseIcon, InfoIcon, UiIcon, type IconName } from '../Icons';
import { InspectorPanel, type InspectorPanelHandle } from './InspectorPanel';
import { SettingsPanel } from './SettingsPanel';
import { TiersPanel } from './TiersPanel';

export interface RightSidebarHandle {
  insertIpaSymbol: (sym: string, isTieBar?: boolean) => boolean;
  flushDraft: () => void;
}

interface RightSidebarProps {
  onStartPlayback: (startT: number, endT: number) => void;
  onOpenAudioPicker: () => void;
  onClearAudio: () => void;
  onBatchConvertIpa: (direction: 'toUnicode' | 'toPraat') => void;
}

const RAIL_ITEMS: Array<{ tab: SidebarTab; title: string; icon: IconName; tooltip: string }> = [
  { tab: 'inspector', title: '属性', icon: 'inspector', tooltip: '属性检查器 (Ctrl+B)' },
  { tab: 'tiers', title: '层级', icon: 'layers', tooltip: '层级列表与管理' },
  { tab: 'settings', title: '设置', icon: 'gear', tooltip: '界面、版面与声学设置' }
];

export const RightSidebar = forwardRef<RightSidebarHandle, RightSidebarProps>(
  ({ onStartPlayback, onOpenAudioPicker, onClearAudio, onBatchConvertIpa }, ref) => {
    const sidebarOpen = useEditorStore((s) => s.sidebarOpen);
    const sidebarTab = useEditorStore((s) => s.sidebarTab);
    const sidebarWidth = useEditorStore((s) => s.sidebarWidth);
    const setSidebarOpen = useEditorStore((s) => s.setSidebarOpen);
    const toggleSidebarTab = useEditorStore((s) => s.toggleSidebarTab);
    const setSidebarWidth = useEditorStore((s) => s.setSidebarWidth);
    const aboutOpen = useEditorStore((s) => s.aboutOpen);
    const setAboutOpen = useEditorStore((s) => s.setAboutOpen);
    const tierCount = useEditorStore((s) => s.tg.tiers.length);
    const selection = useEditorStore((s) => s.selection);
    const playRange = useEditorStore((s) => s.playRange);

    const [resizing, setResizing] = useState(false);
    const inspectorRef = useRef<InspectorPanelHandle>(null);

    useImperativeHandle(
      ref,
      () => ({
        insertIpaSymbol: (sym: string, isTieBar?: boolean) => {
          if (!sidebarOpen || sidebarTab !== 'inspector') return false;
          return inspectorRef.current?.insertIpaSymbol(sym, isTieBar) ?? false;
        },
        flushDraft: () => {
          inspectorRef.current?.flushDraft();
        }
      }),
      [sidebarOpen, sidebarTab]
    );

    const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || !sidebarOpen) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      setResizing(true);
      document.body.style.cursor = 'col-resize';

      let collapsed = false;
      const onMove = (ev: PointerEvent) => {
        const rawW = startWidth + (startX - ev.clientX);
        if (rawW < 175) {
          if (!collapsed) {
            collapsed = true;
            setSidebarOpen(false);
          }
          return;
        }
        if (collapsed) {
          collapsed = false;
          setSidebarOpen(true);
        }
        setSidebarWidth(rawW);
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

    const activeItem = RAIL_ITEMS.find((r) => r.tab === sidebarTab) || RAIL_ITEMS[0];

    let headBadge = '';
    if (sidebarTab === 'tiers') {
      headBadge = `${tierCount} 层`;
    } else if (sidebarTab === 'inspector') {
      if (selection?.kind === 'interval') headBadge = '区间';
      else if (selection?.kind === 'point') headBadge = '标点';
      else if (selection?.kind === 'boundary') headBadge = '边界';
      else if (selection?.kind === 'spine') headBadge = '时刻';
      else if (selection?.kind === 'tier') headBadge = '层级';
      else if (playRange && playRange.end > playRange.start) headBadge = '选区';
      else headBadge = '文档';
    }

    return (
      <aside
        className={`right-sidebar ${sidebarOpen ? 'open' : 'collapsed'} ${resizing ? 'is-resizing resizing' : ''}`}
      >
        <div
          className={`sidebar-pane ${resizing ? 'is-resizing' : ''}`}
          style={{ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}
          aria-label={`${activeItem.title}侧边面板`}
          aria-hidden={!sidebarOpen}
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
                <span className="sidebar-title">{activeItem.title}</span>
                {headBadge && <span className="sidebar-head-badge">{headBadge}</span>}
              </div>
              <button
                type="button"
                className="icon-btn compact sidebar-close-btn"
                title="收起面板 (Ctrl+B)"
                aria-label="收起面板"
                tabIndex={sidebarOpen ? 0 : -1}
                onClick={() => setSidebarOpen(false)}
              >
                <CloseIcon />
              </button>
            </div>

            <div className="sidebar-body">
              {sidebarTab === 'inspector' && (
                <InspectorPanel ref={inspectorRef} onStartPlayback={onStartPlayback} />
              )}
              {sidebarTab === 'tiers' && <TiersPanel />}
              {sidebarTab === 'settings' && (
                <SettingsPanel
                  onOpenAudioPicker={onOpenAudioPicker}
                  onClearAudio={onClearAudio}
                  onBatchConvertIpa={onBatchConvertIpa}
                />
              )}
            </div>
          </div>
        </div>

        <nav className="sidebar-rail" aria-label="右侧功能切换栏">
          {RAIL_ITEMS.map((item) => {
            const isActive = sidebarOpen && sidebarTab === item.tab;
            return (
              <button
                key={item.tab}
                type="button"
                className={`sidebar-rail-btn ${isActive ? 'active' : ''}`}
                title={`${item.title} — ${item.tooltip}`}
                aria-label={item.title}
                aria-pressed={isActive}
                onClick={() => toggleSidebarTab(item.tab)}
              >
                <UiIcon name={item.icon} size={16} />
              </button>
            );
          })}

          <div className="sidebar-rail-bottom">
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
