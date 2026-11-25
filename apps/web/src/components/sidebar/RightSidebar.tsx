import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { TextGrid } from '../../bridge/types';
import { useEditorStore, type SidebarTab } from '../../store/useEditorStore';
import { getLogicalViewportSize, getViewportZoom } from '../../utils/uiScale';
import { CloseIcon, InfoIcon, ShortcutsIcon, UiIcon, type IconName } from '../Icons';
import { CustomizePanel } from './CustomizePanel';
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

function detectQuickQaIssues(tg: TextGrid): boolean {
  const EPS = 1e-9;
  const MICRO_THRESHOLD = 0.005;
  const boundaryEntries: Array<{ t: number; ti: number }> = [];

  for (let ti = 0; ti < tg.tiers.length; ti++) {
    const tier = tg.tiers[ti];
    if (tier.xmin < tg.xmin - EPS || tier.xmax > tg.xmax + EPS) return true;
    if (tier.kind === 'intervalTier') {
      const ivs = tier.intervals;
      if (ivs.length === 0) {
        if (tier.xmax > tier.xmin + EPS) return true;
        continue;
      }
      if (ivs[0].xmin > tier.xmin + EPS) return true;
      for (let i = 0; i < ivs.length; i++) {
        const iv = ivs[i];
        const dur = iv.xmax - iv.xmin;
        if (dur <= EPS) return true; // zero or inverted
        if (dur < MICRO_THRESHOLD) return true; // micro segment (< 5 ms)
        if (i > 0) {
          const prev = ivs[i - 1];
          if (iv.xmin > prev.xmax + EPS) return true; // gap
          if (iv.xmin < prev.xmax - EPS) return true; // overlap
        }
        if (iv.xmin > tier.xmin + EPS && iv.xmin < tier.xmax - EPS) {
          boundaryEntries.push({ t: iv.xmin, ti });
        }
        if (iv.xmax > tier.xmin + EPS && iv.xmax < tier.xmax - EPS) {
          boundaryEntries.push({ t: iv.xmax, ti });
        }
      }
      if (ivs[ivs.length - 1].xmax < tier.xmax - EPS) return true;
    } else {
      for (const pt of tier.points) {
        if (pt.number < tier.xmin - EPS || pt.number > tier.xmax + EPS) return true;
        boundaryEntries.push({ t: pt.number, ti });
      }
    }
  }

  // Cross-tier micro boundary misalignment (< 5 ms)
  if (boundaryEntries.length > 1) {
    boundaryEntries.sort((a, b) => a.t - b.t || a.ti - b.ti);
    for (let i = 0; i < boundaryEntries.length; i++) {
      const a = boundaryEntries[i];
      for (let j = i + 1; j < boundaryEntries.length; j++) {
        const b = boundaryEntries[j];
        const diff = b.t - a.t;
        if (diff >= MICRO_THRESHOLD) break;
        if (diff > EPS && a.ti !== b.ti) return true;
      }
    }
  }

  return false;
}

const RAIL_ITEMS: Array<{ tab: SidebarTab; title: string; icon: IconName; tooltip: string }> = [
  { tab: 'inspector', title: '属性', icon: 'inspector', tooltip: '属性检查器 (Ctrl+B)' },
  { tab: 'tiers', title: '层级', icon: 'layers', tooltip: '层级列表与管理' },
  { tab: 'settings', title: '设置', icon: 'gear', tooltip: '界面、版面与声学设置' },
  { tab: 'customize', title: '自定义', icon: 'customize', tooltip: '自定义悬浮工具栏与快捷键 (Alt+4)' }
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
    const shortcutsOpen = useEditorStore((s) => s.shortcutsOpen);
    const setShortcutsOpen = useEditorStore((s) => s.setShortcutsOpen);
    const tg = useEditorStore((s) => s.tg);
    const tierCount = tg.tiers.length;
    const selection = useEditorStore((s) => s.selection);
    const playRange = useEditorStore((s) => s.playRange);

    const hasQaIssues = useMemo(() => detectQuickQaIssues(tg), [tg]);

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
        const z = getViewportZoom();
        const { width: vw } = getLogicalViewportSize();
        const maxSafeW = Math.max(220, Math.min(460, Math.floor(vw * 0.48 - 42)));
        const rawW = startWidth + (startX - ev.clientX) / z;
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

    const activeItem = RAIL_ITEMS.find((r) => r.tab === sidebarTab) || RAIL_ITEMS[0];

    let headBadge = '';
    if (sidebarTab === 'tiers') {
      headBadge = `${tierCount} 层`;
    } else if (sidebarTab === 'customize') {
      headBadge = '悬浮条 · 快捷键';
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
              {sidebarTab === 'customize' && <CustomizePanel />}
            </div>
          </div>
        </div>

        <nav className="sidebar-rail" aria-label="右侧功能切换栏">
          {RAIL_ITEMS.map((item) => {
            const isActive = sidebarOpen && sidebarTab === item.tab;
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
                aria-label={showQaDot ? `${item.title}（存在数据体检提醒）` : item.title}
                aria-pressed={isActive}
                onClick={() => toggleSidebarTab(item.tab)}
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
                      borderRadius: '50%',
                      background: 'var(--accent-amber)',
                      boxShadow: '0 0 0 1.5px var(--bg-subtle)',
                      pointerEvents: 'none'
                    }}
                  />
                )}
              </button>
            );
          })}

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
