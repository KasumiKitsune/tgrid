import React, { useEffect, useMemo, useRef, useState } from 'react';
import { isTauriRuntime } from '../bridge/PlatformBridge';
import {
  SHORTCUT_GROUPS,
  formatKeyCombo,
  getEffectiveKeys,
  isComposingEvent
} from '../shortcuts/registry';
import { clampHistoryLimit } from '../store/historyModel';
import { useEditorStore, type PreferencesSection } from '../store/useEditorStore';
import { CloseIcon, UiIcon } from './Icons';
import {
  EditModeVisualCards,
  EditingToggleDiagramCards,
  GeneralToggleDiagramCards,
  HistoryLimitTimelineBar,
  QTip,
  UiScaleVisualCards
} from './SettingsVisualCards';
import { CustomizePanel } from './sidebar/CustomizePanel';

interface SearchableCardDef {
  id:
    | 'edit-mode'
    | 'edit-toggles'
    | 'history-limit'
    | 'ui-scale'
    | 'general-toggles'
    | 'floating-bar'
    | 'shortcuts';
  section: PreferencesSection;
  keywords: string;
}

const SEARCHABLE_CARDS: SearchableCardDef[] = [
  {
    id: 'edit-mode',
    section: 'editing',
    keywords: '选中 编辑方式 侧边栏 属性栏 浮动条 悬浮条 画布 就近 交互'
  },
  {
    id: 'edit-toggles',
    section: 'editing',
    keywords: '点选 自动展开 属性栏 拖拽 边界 标点 声学 放大镜 局部 波形 语谱 交互'
  },
  {
    id: 'history-limit',
    section: 'editing',
    keywords: '操作历史 历史 上限 撤销 重做 回退 步数 合并 20 50 100 200'
  },
  {
    id: 'ui-scale',
    section: 'general',
    keywords: '界面 大小 缩放 比例 字号 字体 工具栏 小 中 大 100 120 140'
  },
  {
    id: 'general-toggles',
    section: 'general',
    keywords: '词条 状态 标记 进度 角标 未标 已完成 存疑 重录 启动 恢复 上次 未关闭 工作 标签页'
  },
  {
    id: 'floating-bar',
    section: 'floating',
    keywords: '悬浮条 浮动条 按钮 排序 定制 预设 完整 精简 极简 区间 标点 边界 层级'
  },
  {
    id: 'shortcuts',
    section: 'shortcuts',
    keywords: '快捷键 键位 键盘 绑定 重绑 冲突 自定义'
  }
];

const GENERIC_SHORTCUT_TERMS = new Set(['快捷键', '键位', '键盘', '绑定', '重绑', '冲突', '自定义']);

const NAV_ITEMS: Array<{ id: PreferencesSection; label: string }> = [
  { id: 'editing', label: '编辑与交互' },
  { id: 'general', label: '界面与启动' },
  { id: 'floating', label: '悬浮条按钮' },
  { id: 'shortcuts', label: '快捷键' }
];

export const PreferencesModal: React.FC = () => {
  const isDesktop = isTauriRuntime();

  const preferencesOpen = useEditorStore((s) => s.preferencesOpen);
  const preferencesSection = useEditorStore((s) => s.preferencesSection);
  const setPreferencesOpen = useEditorStore((s) => s.setPreferencesOpen);
  const setPreferencesSection = useEditorStore((s) => s.setPreferencesSection);

  const editInspectorMode = useEditorStore((s) => s.editInspectorMode);
  const setEditInspectorMode = useEditorStore((s) => s.setEditInspectorMode);
  const autoOpenInspectorOnSelect = useEditorStore((s) => s.autoOpenInspectorOnSelect);
  const setAutoOpenInspectorOnSelect = useEditorStore((s) => s.setAutoOpenInspectorOnSelect);
  const showMicroLoupe = useEditorStore((s) => s.showMicroLoupe);
  const setShowMicroLoupe = useEditorStore((s) => s.setShowMicroLoupe);

  const historyLimit = useEditorStore((s) => s.historyLimit);
  const setHistoryLimit = useEditorStore((s) => s.setHistoryLimit);

  const uiScale = useEditorStore((s) => s.uiScale);
  const setUiScale = useEditorStore((s) => s.setUiScale);
  const showCorpusStatusMarks = useEditorStore((s) => s.showCorpusStatusMarks);
  const setShowCorpusStatusMarks = useEditorStore((s) => s.setShowCorpusStatusMarks);
  const restoreSessionOnStartup = useEditorStore((s) => s.restoreSessionOnStartup);
  const setRestoreSessionOnStartup = useEditorStore((s) => s.setRestoreSessionOnStartup);

  const customShortcuts = useEditorStore((s) => s.customShortcuts);
  const customizedShortcutCount = Object.keys(customShortcuts).length;

  const [searchQuery, setSearchQuery] = useState('');
  const [historyLimitText, setHistoryLimitText] = useState(() => String(historyLimit));
  const searchInputRef = useRef<HTMLInputElement>(null);
  const backdropPointerDownRef = useRef(false);

  useEffect(() => {
    setHistoryLimitText(String(historyLimit));
  }, [historyLimit]);

  useEffect(() => {
    if (!preferencesOpen) {
      setSearchQuery('');
    }
  }, [preferencesOpen]);

  const commitHistoryLimit = () => {
    const parsed = Number(historyLimitText);
    if (!Number.isFinite(parsed)) {
      setHistoryLimitText(String(historyLimit));
      return;
    }
    const clamped = clampHistoryLimit(parsed);
    setHistoryLimitText(String(clamped));
    if (clamped !== historyLimit) {
      setHistoryLimit(clamped);
    }
  };

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const isSearching = trimmedQuery.length > 0;

  const shortcutEntryHit = useMemo(() => {
    if (!isSearching) return false;
    return SHORTCUT_GROUPS.some((group) => {
      if (group.title.toLowerCase().includes(trimmedQuery)) return true;
      return group.entries.some((entry) => {
        if (entry.label.toLowerCase().includes(trimmedQuery)) return true;
        if (entry.description?.toLowerCase().includes(trimmedQuery)) return true;
        const keys = [...entry.keys, ...getEffectiveKeys(entry.id, customShortcuts)];
        return keys.some(
          (k) => k.toLowerCase().includes(trimmedQuery) || formatKeyCombo(k).toLowerCase().includes(trimmedQuery)
        );
      });
    });
  }, [isSearching, trimmedQuery, customShortcuts]);

  const matchedCards = useMemo(() => {
    if (!isSearching) return [];
    const tokens = trimmedQuery.split(/\s+/).filter(Boolean);
    return SEARCHABLE_CARDS.filter((card) => {
      const kw = card.keywords.toLowerCase();
      if (tokens.every((tk) => kw.includes(tk))) return true;
      if (card.id === 'shortcuts' && shortcutEntryHit) return true;
      return false;
    });
  }, [isSearching, trimmedQuery, shortcutEntryHit]);

  const useShortcutFilterInSearch =
    shortcutEntryHit && !GENERIC_SHORTCUT_TERMS.has(trimmedQuery);

  const renderEditModeCard = (searchHit = false) => (
    <section
      key="edit-mode"
      className={`prefs-card ${searchHit ? 'is-search-hit' : ''}`}
      aria-label="选中编辑方式"
    >
      <div className="prefs-card-hd">
        <span className="prefs-card-title">
          <span>选中编辑方式</span>
          <QTip
            align="right"
            down
            tip="切换点选音段或标点后属性编辑面板的位置，不影响双击原地打字。"
          />
        </span>
        <span className="prefs-card-meta">
          {editInspectorMode === 'sidebar' ? '侧边栏' : '画布浮动条'}
        </span>
      </div>
      <EditModeVisualCards value={editInspectorMode} onChange={setEditInspectorMode} />
    </section>
  );

  const renderEditTogglesCard = (searchHit = false) => (
    <section
      key="edit-toggles"
      className={`prefs-card ${searchHit ? 'is-search-hit' : ''}`}
      aria-label="交互辅助"
    >
      <div className="prefs-card-hd">
        <span className="prefs-card-title">交互辅助</span>
      </div>
      <EditingToggleDiagramCards
        autoOpenInspector={autoOpenInspectorOnSelect}
        onToggleAutoOpen={setAutoOpenInspectorOnSelect}
        showMicroLoupe={showMicroLoupe}
        onToggleMicroLoupe={setShowMicroLoupe}
      />
    </section>
  );

  const renderHistoryLimitCard = (searchHit = false) => (
    <section
      key="history-limit"
      className={`prefs-card ${searchHit ? 'is-search-hit' : ''}`}
      aria-label="操作历史上限"
    >
      <div className="prefs-card-hd">
        <span className="prefs-card-title">
          <span>操作历史上限</span>
          <QTip
            align="right"
            tip="默认 50 步（可调 10–200）；800 ms 内连续同目标微调自动合并。调低上限时仅裁剪最早记录，保留当前及后续步与初始快照。"
          />
        </span>
        <span className="prefs-card-meta">当前 {historyLimit} 步</span>
      </div>

      <HistoryLimitTimelineBar value={historyLimit} />

      <div className="prefs-hist-row">
        <div className="pref-seg" style={{ flex: '1 1 auto' }} role="group" aria-label="操作历史上限预设">
          {([20, 50, 100, 200] as const).map((preset) => (
            <button
              key={preset}
              type="button"
              className={historyLimit === preset ? 'is-active' : ''}
              onClick={() => setHistoryLimit(preset)}
            >
              {preset} 步
            </button>
          ))}
        </div>
        <div className="prefs-hist-input-wrap">
          <input
            type="number"
            className="pref-hist-input"
            min={10}
            max={200}
            step={10}
            aria-label="自定义操作历史上限步数"
            value={historyLimitText}
            onChange={(e) => setHistoryLimitText(e.target.value)}
            onBlur={commitHistoryLimit}
            onKeyDown={(e) => {
              if (isComposingEvent(e)) return;
              if (e.key === 'Enter' || e.code === 'NumpadEnter') {
                e.preventDefault();
                e.stopPropagation();
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setHistoryLimitText(String(historyLimit));
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <span className="prefs-hist-unit">步</span>
        </div>
      </div>
    </section>
  );

  const renderUiScaleCard = (searchHit = false) => (
    <section
      key="ui-scale"
      className={`prefs-card ${searchHit ? 'is-search-hit' : ''}`}
      aria-label="界面大小"
    >
      <div className="prefs-card-hd">
        <span className="prefs-card-title">
          <span>界面大小</span>
          <QTip
            align="right"
            down
            tip="缩放外围工具栏、侧栏与弹窗文字，不影响谱面画布缩放与导出图像尺寸。"
          />
        </span>
        <span className="prefs-card-meta">{Math.round(uiScale * 100)}%</span>
      </div>
      <UiScaleVisualCards value={uiScale} onChange={setUiScale} />
    </section>
  );

  const renderGeneralTogglesCard = (searchHit = false) => (
    <section
      key="general-toggles"
      className={`prefs-card ${searchHit ? 'is-search-hit' : ''}`}
      aria-label="词条标记与启动行为"
    >
      <div className="prefs-card-hd">
        <span className="prefs-card-title">
          {isDesktop ? '词条标记与启动行为' : '词条显示'}
        </span>
      </div>
      <GeneralToggleDiagramCards
        showCorpusStatusMarks={showCorpusStatusMarks}
        onToggleStatusMarks={setShowCorpusStatusMarks}
        isDesktop={isDesktop}
        restoreSessionOnStartup={restoreSessionOnStartup}
        onToggleRestoreSession={setRestoreSessionOnStartup}
      />
    </section>
  );

  const renderSearchCard = (cardId: SearchableCardDef['id']) => {
    switch (cardId) {
      case 'edit-mode':
        return renderEditModeCard(true);
      case 'edit-toggles':
        return renderEditTogglesCard(true);
      case 'history-limit':
        return renderHistoryLimitCard(true);
      case 'ui-scale':
        return renderUiScaleCard(true);
      case 'general-toggles':
        return renderGeneralTogglesCard(true);
      case 'floating-bar':
        return (
          <section key="floating-bar" className="prefs-card is-search-hit" aria-label="悬浮条按钮">
            <div className="prefs-card-hd">
              <span className="prefs-card-title">悬浮条按钮定制</span>
              <button
                type="button"
                className="compact"
                onClick={() => {
                  setSearchQuery('');
                  setPreferencesSection('floating');
                }}
              >
                打开完整页
              </button>
            </div>
            <div className="prefs-embedded-card-body">
              <CustomizePanel sectionOnly="floating" embedded />
            </div>
          </section>
        );
      case 'shortcuts':
        return (
          <section key="shortcuts" className="prefs-card is-search-hit" aria-label="快捷键">
            <div className="prefs-card-hd">
              <span className="prefs-card-title">快捷键自定义</span>
              <button
                type="button"
                className="compact"
                onClick={() => {
                  setSearchQuery('');
                  setPreferencesSection('shortcuts');
                }}
              >
                打开完整页
              </button>
            </div>
            <div className="prefs-embedded-card-body">
              <CustomizePanel
                sectionOnly="shortcuts"
                embedded
                externalShortcutQuery={useShortcutFilterInSearch ? trimmedQuery : ''}
              />
            </div>
          </section>
        );
    }
  };

  const isFlushSection =
    !isSearching && (preferencesSection === 'floating' || preferencesSection === 'shortcuts');

  return (
    <div
      className={`modal-backdrop ${preferencesOpen ? 'open' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-hidden={!preferencesOpen}
      aria-labelledby="prefs-modal-title"
      onPointerDown={(e) => {
        backdropPointerDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (backdropPointerDownRef.current && e.target === e.currentTarget) {
          setPreferencesOpen(false);
        }
        backdropPointerDownRef.current = false;
      }}
    >
      <div className="modal-card prefs-modal-card">
        <div className="prefs-head">
          <span id="prefs-modal-title" className="prefs-title">
            <UiIcon name="gear" size={14} />
            <span>偏好设置</span>
            <span className="prefs-title-kbd">{formatKeyCombo('Mod+,')}</span>
          </span>

          <div className="prefs-search-wrap">
            <span className="prefs-search-ico" aria-hidden="true">
              <UiIcon name="search" size={13} />
            </span>
            <input
              ref={searchInputRef}
              type="text"
              className="prefs-search-input"
              placeholder="搜索：放大镜、历史、恢复、缩放、浮动条、快捷键…"
              aria-label="搜索偏好设置"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (isComposingEvent(e)) return;
                if (e.key === 'Escape' && searchQuery) {
                  e.preventDefault();
                  e.stopPropagation();
                  setSearchQuery('');
                }
              }}
            />
            {isSearching && (
              <span className="prefs-search-meta">
                <span className="prefs-search-count">{matchedCards.length} 项</span>
                <button
                  type="button"
                  className="icon-btn prefs-search-clear"
                  title="清空搜索"
                  aria-label="清空搜索"
                  onClick={() => {
                    setSearchQuery('');
                    searchInputRef.current?.focus();
                  }}
                >
                  <CloseIcon size={10} />
                </button>
              </span>
            )}
          </div>

          <button
            type="button"
            className="icon-btn compact prefs-close-btn"
            title="关闭 (Esc)"
            aria-label="关闭偏好设置"
            onClick={() => setPreferencesOpen(false)}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="prefs-body">
          <nav className="prefs-nav" aria-label="偏好分类">
            {NAV_ITEMS.map((item) => {
              const active = !isSearching && preferencesSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`prefs-nav-btn ${active ? 'is-active' : ''} ${
                    isSearching ? 'is-dimmed' : ''
                  }`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => {
                    if (isSearching) setSearchQuery('');
                    setPreferencesSection(item.id);
                  }}
                >
                  <span>{item.label}</span>
                  {item.id === 'shortcuts' && customizedShortcutCount > 0 && (
                    <span className="prefs-nav-count">{customizedShortcutCount}</span>
                  )}
                </button>
              );
            })}
            {isSearching && (
              <div className="prefs-nav-search-note">
                跨分类实时筛选中，点击左侧任一分类恢复分组浏览
              </div>
            )}
          </nav>

          <div className={`prefs-content ${isFlushSection ? 'is-flush' : ''}`}>
            {isSearching ? (
              matchedCards.length > 0 ? (
                matchedCards.map((c) => renderSearchCard(c.id))
              ) : (
                <div className="prefs-empty">
                  <span>未找到与「{searchQuery.trim()}」匹配的设置项</span>
                  <button
                    type="button"
                    className="compact"
                    onClick={() => {
                      setSearchQuery('');
                      searchInputRef.current?.focus();
                    }}
                  >
                    清空搜索条件
                  </button>
                </div>
              )
            ) : (
              <>
                {preferencesSection === 'editing' && (
                  <>
                    {renderEditModeCard()}
                    {renderEditTogglesCard()}
                    {renderHistoryLimitCard()}
                  </>
                )}
                {preferencesSection === 'general' && (
                  <>
                    {renderUiScaleCard()}
                    {renderGeneralTogglesCard()}
                  </>
                )}
                {preferencesSection === 'floating' && (
                  <CustomizePanel sectionOnly="floating" embedded />
                )}
                {preferencesSection === 'shortcuts' && (
                  <CustomizePanel sectionOnly="shortcuts" embedded />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
