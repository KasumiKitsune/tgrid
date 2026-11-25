import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  SHORTCUT_GROUPS,
  eventToKeyCombo,
  findShortcutConflicts,
  formatKeyCombo,
  getEffectiveKeys,
  isComposingEvent,
  isShortcutCustomized,
  type ShortcutEntry
} from '../../shortcuts/registry';
import {
  FLOATING_BAR_CATALOG,
  FLOATING_BAR_PRESETS,
  useEditorStore,
  type FloatingBarConfig,
  type FloatingBarPresetKey,
  type FloatingBarTarget
} from '../../store/useEditorStore';
import { UiIcon, type IconName } from '../Icons';

const DragGripIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
    <circle cx="4" cy="2.5" r="0.95" />
    <circle cx="8" cy="2.5" r="0.95" />
    <circle cx="4" cy="6" r="0.95" />
    <circle cx="8" cy="6" r="0.95" />
    <circle cx="4" cy="9.5" r="0.95" />
    <circle cx="8" cy="9.5" r="0.95" />
  </svg>
);

type CustomizeSubtab = 'floating' | 'shortcuts';

let pendingSubtabRequest: CustomizeSubtab | null = null;
const subtabListeners = new Set<(tab: CustomizeSubtab) => void>();

export function requestCustomizeSubtab(tab: CustomizeSubtab): void {
  pendingSubtabRequest = tab;
  subtabListeners.forEach((fn) => fn(tab));
}

const TARGET_OPTIONS: Array<{ key: FloatingBarTarget; label: string }> = [
  { key: 'interval', label: '区间' },
  { key: 'point', label: '标点' },
  { key: 'boundary', label: '边界' },
  { key: 'tier', label: '层级' }
];

const PRESET_OPTIONS: Array<{ key: FloatingBarPresetKey; label: string; title: string }> = [
  { key: 'full', label: '完整', title: '显示起止时间框与全部常用按钮' },
  { key: 'compact', label: '精简标注', title: '隐藏时间框，聚焦高频标注动作' },
  { key: 'minimal', label: '极简', title: '仅保留核心改字、切分与播放按钮' }
];

const FIELD_ITEM_IDS = new Set([
  'iv-times',
  'pt-time',
  'bnd-time',
  'tier-name',
  'tier-bounds'
]);

const FLOATING_ITEM_ICONS: Partial<Record<string, IconName>> = {
  'iv-times': 'copyTime',
  'iv-dur': 'copyTime',
  'iv-edit': 'edit',
  'iv-clear': 'clear',
  'iv-split': 'split',
  'iv-split-equal': 'splitEqual',
  'iv-merge-left': 'mergeLeft',
  'iv-merge-right': 'mergeRight',
  'iv-play': 'play',
  'iv-play-ctx': 'playContext',
  'iv-zoom': 'zoomIn',
  'iv-copy-text': 'copy',
  'pt-time': 'copyTime',
  'pt-edit': 'edit',
  'pt-play': 'play',
  'pt-delete': 'trash',
  'bnd-time': 'copyTime',
  'bnd-zero': 'zeroCross',
  'bnd-audition': 'playContext',
  'bnd-delete': 'delBoundary',
  'tier-name': 'edit',
  'tier-bounds': 'copyTime',
  'tier-move': 'navVertical',
  'tier-delete': 'trash'
};

interface PendingConflict {
  actionId: string;
  combo: string;
  conflicts: ShortcutEntry[];
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function matchesPreset(cfg: FloatingBarConfig, presetKey: FloatingBarPresetKey): boolean {
  const preset = FLOATING_BAR_PRESETS[presetKey];
  if (!preset) return false;
  const targets: FloatingBarTarget[] = ['interval', 'point', 'boundary', 'tier'];
  return targets.every(
    (t) =>
      sameStringList(cfg[t].order, preset[t].order) &&
      sameStringList(cfg[t].hidden, preset[t].hidden)
  );
}

export const CustomizePanel: React.FC = () => {
  const [subtab, setSubtab] = useState<CustomizeSubtab>(() => {
    const initial = pendingSubtabRequest ?? 'floating';
    pendingSubtabRequest = null;
    return initial;
  });

  // Floating bar state
  const editInspectorMode = useEditorStore((s) => s.editInspectorMode);
  const setEditInspectorMode = useEditorStore((s) => s.setEditInspectorMode);
  const floatingBarConfig = useEditorStore((s) => s.floatingBarConfig);
  const toggleFloatingBarItem = useEditorStore((s) => s.toggleFloatingBarItem);
  const reorderFloatingBarItem = useEditorStore((s) => s.reorderFloatingBarItem);
  const applyFloatingBarPreset = useEditorStore((s) => s.applyFloatingBarPreset);
  const resetFloatingBarConfig = useEditorStore((s) => s.resetFloatingBarConfig);

  const [target, setTarget] = useState<FloatingBarTarget>('interval');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{ id: string; pos: 'top' | 'bottom' } | null>(null);
  const itemListRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  // Shortcuts state
  const customShortcuts = useEditorStore((s) => s.customShortcuts);
  const setCustomShortcut = useEditorStore((s) => s.setCustomShortcut);
  const resetCustomShortcut = useEditorStore((s) => s.resetCustomShortcut);
  const resetAllCustomShortcuts = useEditorStore((s) => s.resetAllCustomShortcuts);

  const [searchQuery, setSearchQuery] = useState('');
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);

  // Allow ShortcutsModal "自定义快捷键…" to switch straight to shortcuts subtab
  useEffect(() => {
    const listener = (nextTab: CustomizeSubtab) => {
      pendingSubtabRequest = null;
      setSubtab(nextTab);
    };
    subtabListeners.add(listener);
    if (pendingSubtabRequest) {
      const next = pendingSubtabRequest;
      pendingSubtabRequest = null;
      setSubtab(next);
    }
    return () => {
      subtabListeners.delete(listener);
    };
  }, []);

  // Cancel recording when switching away from shortcuts subtab
  useEffect(() => {
    if (subtab !== 'shortcuts') {
      setRecordingId(null);
      setPendingConflict(null);
    }
  }, [subtab]);

  // Global capture keydown recorder while recording a shortcut
  useEffect(() => {
    if (!recordingId) return;

    const handleCaptureKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setRecordingId(null);
        setPendingConflict(null);
        return;
      }

      if (isComposingEvent(e)) return;

      e.preventDefault();
      e.stopPropagation();

      if (
        (e.key === 'Backspace' || e.key === 'Delete') &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        setCustomShortcut(recordingId, []);
        setRecordingId(null);
        setPendingConflict(null);
        return;
      }

      const combo = eventToKeyCombo(e);
      if (!combo) return;

      const conflicts = findShortcutConflicts(recordingId, combo, customShortcuts);
      if (conflicts.length === 0) {
        setCustomShortcut(recordingId, [combo]);
        setRecordingId(null);
        setPendingConflict(null);
      } else {
        setRecordingId(null);
        setPendingConflict({
          actionId: recordingId,
          combo,
          conflicts
        });
      }
    };

    window.addEventListener('keydown', handleCaptureKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleCaptureKeyDown, true);
    };
  }, [recordingId, customShortcuts, setCustomShortcut]);

  // Catalog map for active floating bar target
  const activeCatalogMap = useMemo(() => {
    const map = new Map<string, (typeof FLOATING_BAR_CATALOG)[FloatingBarTarget][number]>();
    for (const item of FLOATING_BAR_CATALOG[target]) {
      map.set(item.id, item);
    }
    return map;
  }, [target]);

  const activeSection = floatingBarConfig[target];
  const hiddenSet = useMemo(() => new Set(activeSection.hidden), [activeSection.hidden]);
  const orderedItems = useMemo(
    () =>
      activeSection.order
        .map((id) => activeCatalogMap.get(id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    [activeSection.order, activeCatalogMap]
  );
  const visibleItems = useMemo(
    () => orderedItems.filter((item) => !hiddenSet.has(item.id)),
    [orderedItems, hiddenSet]
  );

  // Filtered shortcut groups
  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return SHORTCUT_GROUPS;

    return SHORTCUT_GROUPS.map((group) => {
      const groupTitleHit = group.title.toLowerCase().includes(q);
      const entries = group.entries.filter((entry) => {
        if (groupTitleHit) return true;
        if (entry.label.toLowerCase().includes(q)) return true;
        if (entry.description && entry.description.toLowerCase().includes(q)) return true;
        const effectiveKeys = getEffectiveKeys(entry.id, customShortcuts);
        const allKeys = [...entry.keys, ...effectiveKeys];
        return allKeys.some(
          (k) => k.toLowerCase().includes(q) || formatKeyCombo(k).toLowerCase().includes(q)
        );
      });
      return { ...group, entries };
    }).filter((g) => g.entries.length > 0);
  }, [searchQuery, customShortcuts]);

  const customizedCount = Object.keys(customShortcuts).length;

  const handleItemPointerDown = (e: React.PointerEvent<HTMLDivElement>, itemId: string) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement | null;
    if (!el) return;
    const isCheckbox = el.tagName === 'INPUT';
    if (isCheckbox) return;
    const isHandle = Boolean(el.closest('.cust-drag-handle'));
    if (isHandle) {
      e.preventDefault();
    }

    dragCleanupRef.current?.();

    const startY = e.clientY;
    const activeTarget = target;
    const currentOrder = [...activeSection.order];
    let active = false;
    let latestHit: { id: string; pos: 'top' | 'bottom' } | null = null;

    const computeHit = (clientY: number): { id: string; pos: 'top' | 'bottom' } | null => {
      const container = itemListRef.current;
      if (!container) return null;
      const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-item-id]'));
      if (rows.length === 0) return null;

      let chosen: { id: string; pos: 'top' | 'bottom' } | null = null;
      const firstRect = rows[0].getBoundingClientRect();
      const lastRect = rows[rows.length - 1].getBoundingClientRect();

      if (clientY <= firstRect.top) {
        const id = rows[0].dataset.itemId;
        if (id) chosen = { id, pos: 'top' };
      } else if (clientY >= lastRect.bottom) {
        const id = rows[rows.length - 1].dataset.itemId;
        if (id) chosen = { id, pos: 'bottom' };
      } else {
        let bestDist = Infinity;
        for (const row of rows) {
          const id = row.dataset.itemId;
          if (!id) continue;
          const rect = row.getBoundingClientRect();
          if (clientY >= rect.top && clientY <= rect.bottom) {
            chosen = { id, pos: clientY < rect.top + rect.height / 2 ? 'top' : 'bottom' };
            break;
          }
          const center = rect.top + rect.height / 2;
          const dist = Math.abs(clientY - center);
          if (dist < bestDist) {
            bestDist = dist;
            chosen = { id, pos: clientY < center ? 'top' : 'bottom' };
          }
        }
      }

      if (!chosen || chosen.id === itemId) return null;
      return chosen;
    };

    const onMove = (ev: PointerEvent) => {
      if (!active) {
        const threshold = isHandle ? 2 : 4;
        if (Math.abs(ev.clientY - startY) < threshold) return;
        active = true;
        suppressClickRef.current = true;
        setDraggingId(itemId);
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
      }
      const hit = computeHit(ev.clientY);
      latestHit = hit;
      setDragOver((prev) =>
        prev?.id === hit?.id && prev?.pos === hit?.pos ? prev : hit
      );
    };

    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown, true);
      dragCleanupRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      if (active && commit && latestHit && latestHit.id !== itemId) {
        const fromIdx = currentOrder.indexOf(itemId);
        const toIdx = currentOrder.indexOf(latestHit.id);
        if (fromIdx !== -1 && toIdx !== -1) {
          let effectiveToIdx = toIdx;
          if (fromIdx < toIdx && latestHit.pos === 'top') {
            effectiveToIdx = toIdx - 1;
          } else if (fromIdx > toIdx && latestHit.pos === 'bottom') {
            effectiveToIdx = toIdx + 1;
          }
          if (
            effectiveToIdx !== fromIdx &&
            effectiveToIdx >= 0 &&
            effectiveToIdx < currentOrder.length
          ) {
            reorderFloatingBarItem(activeTarget, itemId, currentOrder[effectiveToIdx]);
          }
        }
      }

      setDraggingId(null);
      setDragOver(null);
      if (active) {
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    };

    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      }
    };

    dragCleanupRef.current = () => finish(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown, true);
  };

  return (
    <div className="cust-root">
      <div className="cust-subtabs" role="tablist" aria-label="自定义分类">
        <button
          type="button"
          role="tab"
          aria-selected={subtab === 'floating'}
          className={subtab === 'floating' ? 'active' : ''}
          onClick={() => setSubtab('floating')}
        >
          <UiIcon name="customize" size={12} />
          <span>悬浮工具栏</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subtab === 'shortcuts'}
          className={subtab === 'shortcuts' ? 'active' : ''}
          onClick={() => setSubtab('shortcuts')}
        >
          <UiIcon name="shortcuts" size={12} />
          <span>快捷键{customizedCount > 0 ? ` (${customizedCount})` : ''}</span>
        </button>
      </div>

      {subtab === 'floating' ? (
        <>
          <div
            className="sb-panel-root"
            style={{
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
              padding: '10px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10
            }}
          >
            {editInspectorMode !== 'floating' && (
              <div className="sb-readonly-banner" role="status" style={{ margin: 0 }}>
                <span className="sb-readonly-text">当前选中编辑方式为侧边栏</span>
                <button
                  type="button"
                  className="compact sb-readonly-btn"
                  onClick={() => setEditInspectorMode('floating')}
                >
                  切换为浮动条模式
                </button>
              </div>
            )}

            <div className="sb-setting-block">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6
                }}
              >
                <span className="sb-field-lbl">布局预设</span>
                <button
                  type="button"
                  className="compact"
                  style={{ height: 21, padding: '0 7px', fontSize: 10.5 }}
                  onClick={() => resetFloatingBarConfig()}
                >
                  <UiIcon name="reset" size={11} />
                  <span>恢复默认</span>
                </button>
              </div>
              <div className="cust-preset-row" role="group" aria-label="悬浮工具栏预设">
                {PRESET_OPTIONS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    className={matchesPreset(floatingBarConfig, preset.key) ? 'active' : ''}
                    title={preset.title}
                    onClick={() => applyFloatingBarPreset(preset.key)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="sb-setting-block">
              <span className="sb-field-lbl">目标对象</span>
              <div className="segmented sb-seg-full" role="group" aria-label="悬浮工具栏目标对象">
                {TARGET_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={`compact ${target === opt.key ? 'active' : ''}`}
                    onClick={() => {
                      setTarget(opt.key);
                      setDraggingId(null);
                      setDragOver(null);
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="sb-setting-block">
              <span className="sb-field-lbl">实时预览</span>
              <div className="cust-preview-wrap" aria-label="悬浮工具栏预览">
                {visibleItems.length > 0 ? (
                  <div className="cust-preview-bar">
                    {visibleItems.map((item) => (
                      <span
                        key={item.id}
                        className={
                          FIELD_ITEM_IDS.has(item.id) ? 'cust-preview-field' : 'cust-preview-pill'
                        }
                        title={item.label}
                      >
                        {item.previewLabel}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="sb-hint" style={{ margin: 0 }}>
                    当前对象不显示悬浮条
                  </span>
                )}
              </div>
            </div>

            <div className="sb-setting-block">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6
                }}
              >
                <span className="sb-field-lbl">按钮与排序</span>
                <span className="sb-hint" style={{ margin: 0 }}>
                  {visibleItems.length} / {orderedItems.length} 显示
                </span>
              </div>

              <div
                ref={itemListRef}
                className="cust-item-list"
                role="list"
                aria-label="悬浮工具栏条目列表"
              >
                {orderedItems.map((item) => {
                  const isHidden = hiddenSet.has(item.id);
                  const isDragging = draggingId === item.id;
                  const isOverTop = dragOver?.id === item.id && dragOver.pos === 'top';
                  const isOverBottom = dragOver?.id === item.id && dragOver.pos === 'bottom';
                  const rowClasses = [
                    'cust-item-row',
                    isHidden ? 'is-hidden-item' : '',
                    isDragging ? 'is-dragging' : '',
                    isOverTop ? 'drag-over-top' : '',
                    isOverBottom ? 'drag-over-bottom' : ''
                  ]
                    .filter(Boolean)
                    .join(' ');

                  return (
                    <div
                      key={item.id}
                      data-item-id={item.id}
                      role="listitem"
                      className={rowClasses}
                      onPointerDown={(e) => handleItemPointerDown(e, item.id)}
                    >
                      <span
                        className="cust-drag-handle"
                        aria-hidden="true"
                        title="拖拽调整顺序"
                      >
                        <DragGripIcon size={11} />
                      </span>
                      <label
                        className="export-check cust-item-check"
                        title={item.label}
                        onClick={(e) => {
                          if (suppressClickRef.current) {
                            e.preventDefault();
                            e.stopPropagation();
                          }
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={!isHidden}
                          aria-label={`显示 ${item.label}`}
                          onChange={() => toggleFloatingBarItem(target, item.id)}
                        />
                        {FLOATING_ITEM_ICONS[item.id] && (
                          <UiIcon name={FLOATING_ITEM_ICONS[item.id]!} size={12} />
                        )}
                        <span className="cust-item-label">{item.label}</span>
                      </label>
                    </div>
                  );
                })}
              </div>

              <div className="sb-hint">
                拖拽条目可调整按钮顺序；时间框支持按住鼠标上下拖动连续微调。
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div
            style={{
              padding: '9px 12px',
              borderBottom: '1px solid var(--rule)',
              background: 'var(--bg-subtle)',
              flexShrink: 0
            }}
          >
            <input
              type="search"
              className="cust-key-search"
              placeholder="搜索动作名或快捷键…"
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
          </div>

          <div
            style={{
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
              padding: '10px 12px'
            }}
          >
            {filteredGroups.length === 0 ? (
              <div className="sb-hint" style={{ textAlign: 'center', padding: '16px 0' }}>
                未找到匹配的快捷键动作
              </div>
            ) : (
              filteredGroups.map((group) => (
                <section key={group.id} className="cust-key-group" aria-label={group.title}>
                  <div
                    style={{
                      padding: '5px 8px',
                      fontSize: 10.5,
                      fontWeight: 600,
                      letterSpacing: '0.03em',
                      color: 'var(--ink-muted)',
                      background: 'var(--bg-subtle)',
                      borderBottom: '1px solid var(--rule)'
                    }}
                  >
                    {group.title}
                  </div>

                  {group.entries.map((entry) => {
                    const effectiveKeys = getEffectiveKeys(entry.id, customShortcuts);
                    const customized = isShortcutCustomized(entry.id, customShortcuts);
                    const isRecording = recordingId === entry.id;
                    const isUnbound = effectiveKeys.length === 0;
                    const conflictHere =
                      pendingConflict && pendingConflict.actionId === entry.id
                        ? pendingConflict
                        : null;
                    const hasFixedConflict = Boolean(
                      conflictHere?.conflicts.some((c) => c.rebindable === false)
                    );

                    return (
                      <React.Fragment key={entry.id}>
                        <div className="cust-key-row">
                          <div
                            className="cust-key-label-wrap"
                            title={entry.description || entry.label}
                          >
                            <span className="cust-key-icon" aria-hidden="true">
                              {entry.icon ? <UiIcon name={entry.icon} size={13} /> : null}
                            </span>
                            <span className="cust-key-label-text">
                              <span>{entry.label}</span>
                              {customized && (
                                <span
                                  className="cust-key-dot"
                                  title="已自定义快捷键"
                                  aria-label="已自定义"
                                />
                              )}
                            </span>
                          </div>

                          {entry.rebindable === false ? (
                            <span
                              className="cust-key-controls"
                              style={{ gap: 3 }}
                              title="内置组合键，不可重绑"
                            >
                              {entry.keys.map((k) => (
                                <kbd key={k} className="kbd" style={{ opacity: 0.78 }}>
                                  {formatKeyCombo(k)}
                                </kbd>
                              ))}
                            </span>
                          ) : (
                            <div className="cust-key-controls">
                              {customized && !isRecording && (
                                <button
                                  type="button"
                                  className="compact"
                                  style={{
                                    height: 22,
                                    padding: '0 5px',
                                    fontSize: 10,
                                    color: 'var(--ink-muted)'
                                  }}
                                  title="恢复此动作默认快捷键"
                                  onClick={() => {
                                    resetCustomShortcut(entry.id);
                                    if (conflictHere) setPendingConflict(null);
                                  }}
                                >
                                  <UiIcon name="reset" size={10} />
                                  <span>重置</span>
                                </button>
                              )}
                              <button
                                type="button"
                                className={`cust-key-btn ${isRecording ? 'is-recording' : ''} ${
                                  !isRecording && isUnbound ? 'is-unbound' : ''
                                }`}
                                title={
                                  isRecording
                                    ? '按下新快捷键，Esc 取消，Backspace 清除绑定'
                                    : isUnbound
                                      ? '点击录制快捷键'
                                      : `${effectiveKeys.map(formatKeyCombo).join(' / ')} — 点击修改`
                                }
                                onClick={() => {
                                  setPendingConflict(null);
                                  setRecordingId((cur) => (cur === entry.id ? null : entry.id));
                                }}
                              >
                                {isRecording ? (
                                  '按下新键… (Esc取消 / Backspace清除)'
                                ) : isUnbound ? (
                                  '未绑定'
                                ) : (
                                  effectiveKeys.map((k, idx) => (
                                    <React.Fragment key={`${entry.id}-${k}-${idx}`}>
                                      {idx > 0 && <span className="cust-key-sep">/</span>}
                                      <span className="cust-key-cap">{formatKeyCombo(k)}</span>
                                    </React.Fragment>
                                  ))
                                )}
                              </button>
                            </div>
                          )}
                        </div>

                        {conflictHere && (
                          <div
                            className="cust-conflict-banner"
                            role="alert"
                            style={{
                              borderLeft: 'none',
                              borderRight: 'none',
                              borderTop: 'none'
                            }}
                          >
                            <span>
                              <strong>{formatKeyCombo(conflictHere.combo)}</strong>{' '}
                              {hasFixedConflict
                                ? `与内置快捷键「${conflictHere.conflicts
                                    .map((c) => c.label)
                                    .join('、')}」冲突，不可覆盖`
                                : `与「${conflictHere.conflicts
                                    .map((c) => c.label)
                                    .join('、')}」冲突`}
                            </span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              {!hasFixedConflict && (
                                <button
                                  type="button"
                                  className="compact primary"
                                  style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                                  onClick={() => {
                                    setCustomShortcut(
                                      conflictHere.actionId,
                                      [conflictHere.combo],
                                      conflictHere.conflicts.map((c) => c.id)
                                    );
                                    setPendingConflict(null);
                                  }}
                                >
                                  替换原绑定
                                </button>
                              )}
                              <button
                                type="button"
                                className="compact"
                                style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                                onClick={() => setPendingConflict(null)}
                              >
                                取消
                              </button>
                            </div>
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </section>
              ))
            )}
          </div>

          <div className="cust-footer-actions">
            <span className="sb-hint" style={{ margin: 0 }}>
              {customizedCount > 0 ? `已自定义 ${customizedCount} 项` : '当前全部为默认键位'}
            </span>
            <button
              type="button"
              className="compact"
              disabled={customizedCount === 0}
              onClick={() => {
                resetAllCustomShortcuts();
                setRecordingId(null);
                setPendingConflict(null);
              }}
            >
              <UiIcon name="reset" size={12} />
              <span>恢复全部默认快捷键</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
};
