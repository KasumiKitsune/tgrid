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
  type FloatingBarDensity,
  type FloatingBarPresetKey,
  type FloatingBarTarget
} from '../../store/useEditorStore';
import { ChevronIcon, CloseIcon, UiIcon, type IconName } from '../Icons';
import '../../styles/floatingBar.css';

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

const MoreDotsIcon: React.FC = () => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.2" />
    <circle cx="8" cy="8" r="1.2" />
    <circle cx="12.5" cy="8" r="1.2" />
  </svg>
);

const CollapseIcon: React.FC = () => (
  <svg
    width={11}
    height={11}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M4 8h8" />
  </svg>
);

const NudgeLeftIcon: React.FC = () => (
  <svg
    width={12}
    height={12}
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.55}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8.5 3.5L5 7l3.5 3.5" />
  </svg>
);

const NudgeRightIcon: React.FC = () => (
  <svg
    width={12}
    height={12}
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.55}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5.5 3.5L9 7l-3.5 3.5" />
  </svg>
);

type CustomizeSubtab = 'floating' | 'shortcuts';

let pendingSubtabRequest: CustomizeSubtab | null = null;
const subtabListeners = new Set<(tab: CustomizeSubtab) => void>();

export function requestCustomizeSubtab(tab: CustomizeSubtab): void {
  pendingSubtabRequest = tab;
  subtabListeners.forEach((fn) => fn(tab));
}

const DENSITY_OPTIONS: ReadonlyArray<{
  value: FloatingBarDensity;
  label: string;
  desc: string;
}> = [
  {
    value: 'compact',
    label: '精简',
    desc: '收紧行高与按钮间距并缩短标签，适合窄画布高频标注'
  },
  {
    value: 'standard',
    label: '标准',
    desc: '时间读数收纳于顶部状态眉胶囊，动作行图标与文字均衡排布'
  },
  {
    value: 'numeric',
    label: '数值直出',
    desc: '动作行左侧直接展开可拖拽微调的起止时间、时刻或层名框'
  }
];

const TARGET_OPTIONS: Array<{
  key: FloatingBarTarget;
  label: string;
  accent: string;
  sampleKind: string;
  sampleCtx: string;
  sampleTime: string;
}> = [
  {
    key: 'interval',
    label: '区间',
    accent: '#2563EB',
    sampleKind: '区间',
    sampleCtx: '音节 #3 · ma55',
    sampleTime: '0.120–0.360s · 240ms'
  },
  {
    key: 'multi',
    label: '多选',
    accent: '#4F46E5',
    sampleKind: '多选',
    sampleCtx: '已选 3 段 · 同层连续',
    sampleTime: '0.120–0.840s · 720ms'
  },
  {
    key: 'boundary',
    label: '边界',
    accent: '#D97706',
    sampleKind: '边界',
    sampleCtx: '音节 · pa | ma',
    sampleTime: '0.360 s'
  },
  {
    key: 'point',
    label: '标点',
    accent: '#0D9488',
    sampleKind: '标点',
    sampleCtx: '声调 · H*',
    sampleTime: '0.240 s'
  },
  {
    key: 'tier',
    label: '层级',
    accent: '#475569',
    sampleKind: '层级',
    sampleCtx: '音节 · 区间层 (12 段)',
    sampleTime: '0.000–2.400s'
  }
];

const PRESET_OPTIONS: Array<{ key: FloatingBarPresetKey; label: string; title: string }> = [
  { key: 'full', label: '全显', title: '显示当前及全部对象的全部可用按钮' },
  { key: 'compact', label: '常用', title: '套用默认高频按钮组合' },
  { key: 'minimal', label: '核心', title: '仅保留 3 个核心高频动作，其余归入「…」菜单' }
];

const FLOATING_ITEM_ICONS: Partial<Record<string, IconName>> = {
  'iv-play': 'play',
  'iv-play-ctx': 'playContext',
  'iv-edit': 'edit',
  'iv-split': 'autoSplit',
  'iv-merge-left': 'mergeLeft',
  'iv-merge-right': 'mergeRight',
  'iv-zoom': 'zoomIn',
  'iv-copy-to-tier': 'projectToTier',
  'iv-copy-text': 'copy',
  'iv-clear': 'clear',
  'ml-merge': 'mergeRight',
  'ml-align': 'nudgeShared',
  'ml-play': 'play',
  'ml-nudge': 'nudgeFine',
  'ml-clear': 'clear',
  'ml-zoom': 'zoomIn',
  'bnd-zero': 'zeroCross',
  'bnd-link': 'nudgeShared',
  'bnd-audition': 'playContext',
  'bnd-project': 'projectToTier',
  'bnd-delete': 'delBoundary',
  'bnd-copy-time': 'copyTime',
  'pt-edit': 'edit',
  'pt-align': 'zeroCross',
  'pt-play-ctx': 'playContext',
  'pt-nudge': 'nudgeFine',
  'pt-delete': 'trash',
  'pt-snap-boundary': 'nudgeShared',
  'pt-move-mid': 'split',
  'pt-play': 'play',
  'tier-name': 'edit',
  'tier-visibility': 'hideTier',
  'tier-solo': 'layers',
  'tier-duplicate': 'duplicateTier',
  'tier-move': 'navVertical',
  'tier-clear': 'clear',
  'tier-delete': 'trash'
};

const PRIMARY_ITEM_IDS = new Set(['iv-play', 'ml-merge', 'bnd-zero', 'pt-edit', 'tier-name']);
const DANGER_ITEM_IDS = new Set(['iv-clear', 'ml-clear', 'bnd-delete', 'pt-delete', 'tier-clear', 'tier-delete']);
const ICON_ONLY_ITEM_IDS = new Set(['iv-merge-left', 'iv-merge-right', 'iv-zoom', 'ml-zoom']);
const DROPDOWN_ITEM_IDS = new Set(['iv-copy-to-tier', 'ml-align', 'bnd-project', 'pt-align', 'tier-duplicate']);

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
  const targets: FloatingBarTarget[] = ['interval', 'multi', 'boundary', 'point', 'tier'];
  return targets.every(
    (t) =>
      sameStringList(cfg[t].order, preset[t].order) &&
      sameStringList(cfg[t].hidden, preset[t].hidden)
  );
}

export interface CustomizePanelProps {
  sectionOnly?: 'floating' | 'shortcuts';
  embedded?: boolean;
  externalShortcutQuery?: string;
}

export const CustomizePanel: React.FC<CustomizePanelProps> = ({
  sectionOnly,
  embedded = false,
  externalShortcutQuery
}) => {
  const [subtab, setSubtab] = useState<CustomizeSubtab>(() => {
    const initial = sectionOnly ?? pendingSubtabRequest ?? 'floating';
    pendingSubtabRequest = null;
    return initial;
  });
  const activeSubtab: CustomizeSubtab = sectionOnly ?? subtab;

  // Floating bar state
  const editInspectorMode = useEditorStore((s) => s.editInspectorMode);
  const setEditInspectorMode = useEditorStore((s) => s.setEditInspectorMode);
  const floatingBarConfig = useEditorStore((s) => s.floatingBarConfig);
  const floatingBarDensity = useEditorStore((s) => s.floatingBarDensity);
  const setFloatingBarDensity = useEditorStore((s) => s.setFloatingBarDensity);
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
    if (activeSubtab !== 'shortcuts') {
      setRecordingId(null);
      setPendingConflict(null);
    }
  }, [activeSubtab]);

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
  const hiddenCount = orderedItems.length - visibleItems.length;
  const activeTargetMeta = useMemo(
    () => TARGET_OPTIONS.find((opt) => opt.key === target) ?? TARGET_OPTIONS[0],
    [target]
  );
  const isCompactDensity = floatingBarDensity === 'compact';
  const isNumericDensity = floatingBarDensity === 'numeric';

  const renderPreviewActionItem = (
    item: (typeof FLOATING_BAR_CATALOG)[FloatingBarTarget][number]
  ): React.ReactNode => {
    const labelText = isCompactDensity ? item.compactLabel ?? item.previewLabel : item.previewLabel;
    const iconName = FLOATING_ITEM_ICONS[item.id];
    const iconSize = isCompactDensity ? 12 : 13;

    if (item.id === 'iv-split') {
      return (
        <span key={item.id} className="fb-arch-split-group" title={item.label}>
          <span className="fb-arch-btn is-split-main">
            <UiIcon name="autoSplit" size={iconSize} />
            <span>{labelText}</span>
          </span>
          <span className="fb-arch-btn is-split-caret">
            <ChevronIcon size={10} />
          </span>
        </span>
      );
    }

    if (item.id === 'bnd-link') {
      return (
        <span key={item.id} className="fb-arch-seg" title={item.label}>
          <span className="fb-arch-seg-btn is-on">{isCompactDensity ? '本层' : '仅本层'}</span>
          <span className="fb-arch-seg-btn">{isCompactDensity ? '联动' : '联动对齐层'}</span>
        </span>
      );
    }

    if (item.id === 'ml-nudge' || item.id === 'pt-nudge') {
      return (
        <React.Fragment key={item.id}>
          <span className="fb-arch-btn is-icon" title="左移 5 ms">
            <NudgeLeftIcon />
          </span>
          <span className="fb-arch-btn is-icon" title="右移 5 ms">
            <NudgeRightIcon />
          </span>
        </React.Fragment>
      );
    }

    if (item.id === 'tier-move') {
      return (
        <React.Fragment key={item.id}>
          <span className="fb-arch-btn is-icon" title="上移一层">
            <UiIcon name="up" size={iconSize} />
          </span>
          <span className="fb-arch-btn is-icon" title="下移一层">
            <UiIcon name="down" size={iconSize} />
          </span>
        </React.Fragment>
      );
    }

    if (item.id === 'tier-name' && isNumericDensity) {
      return (
        <span key={item.id} className="cust-preview-scrub-pill" title="直接编辑层名称">
          <span className="cust-preview-scrub-lbl">层名</span>
          <span className="cust-preview-scrub-val">音节</span>
        </span>
      );
    }

    if (ICON_ONLY_ITEM_IDS.has(item.id) && iconName) {
      return (
        <span key={item.id} className="fb-arch-btn is-icon" title={item.label}>
          <UiIcon name={iconName} size={iconSize} />
        </span>
      );
    }

    const cls = [
      'fb-arch-btn',
      PRIMARY_ITEM_IDS.has(item.id) ? 'is-primary' : '',
      DANGER_ITEM_IDS.has(item.id) ? 'is-danger' : ''
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <span key={item.id} className={cls} title={item.label}>
        {iconName && <UiIcon name={iconName} size={iconSize} />}
        <span>{labelText}</span>
        {DROPDOWN_ITEM_IDS.has(item.id) && <ChevronIcon size={10} />}
      </span>
    );
  };

  const renderPreviewInlineFields = (): React.ReactNode => {
    if (!isNumericDensity) return null;
    if (target === 'interval') {
      return (
        <>
          <span className="fb-arch-inline-fields">
            <span className="cust-preview-scrub-pill">
              <span className="cust-preview-scrub-lbl">起</span>
              <span className="cust-preview-scrub-val">0.1200</span>
            </span>
            <span className="cust-preview-scrub-pill">
              <span className="cust-preview-scrub-lbl">止</span>
              <span className="cust-preview-scrub-val">0.3600</span>
            </span>
          </span>
          {visibleItems.length > 0 && <span className="fb-arch-sep" />}
        </>
      );
    }
    if (target === 'boundary') {
      return (
        <>
          <span className="fb-arch-inline-fields">
            <span className="cust-preview-scrub-pill">
              <span className="cust-preview-scrub-lbl">边界</span>
              <span className="cust-preview-scrub-val">0.3600</span>
            </span>
          </span>
          {visibleItems.length > 0 && <span className="fb-arch-sep" />}
        </>
      );
    }
    if (target === 'point') {
      return (
        <>
          <span className="fb-arch-inline-fields">
            <span className="cust-preview-scrub-pill">
              <span className="cust-preview-scrub-lbl">时刻</span>
              <span className="cust-preview-scrub-val">0.2400</span>
            </span>
          </span>
          {visibleItems.length > 0 && <span className="fb-arch-sep" />}
        </>
      );
    }
    if (target === 'tier' && hiddenSet.has('tier-name')) {
      return (
        <>
          <span className="fb-arch-inline-fields">
            <span className="cust-preview-scrub-pill">
              <span className="cust-preview-scrub-lbl">层名</span>
              <span className="cust-preview-scrub-val">音节</span>
            </span>
          </span>
          {visibleItems.length > 0 && <span className="fb-arch-sep" />}
        </>
      );
    }
    return null;
  };

  // Filtered shortcut groups
  const effectiveSearchQuery =
    externalShortcutQuery !== undefined ? externalShortcutQuery : searchQuery;

  const filteredGroups = useMemo(() => {
    const q = effectiveSearchQuery.trim().toLowerCase();
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
  }, [effectiveSearchQuery, customShortcuts]);

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
    <div className={`cust-root ${embedded ? 'is-embedded' : ''}`}>
      {!sectionOnly && (
        <div className="cust-subtabs" role="tablist" aria-label="自定义分类">
          <button
            type="button"
            role="tab"
            aria-selected={activeSubtab === 'floating'}
            className={activeSubtab === 'floating' ? 'active' : ''}
            onClick={() => setSubtab('floating')}
          >
            <UiIcon name="customize" size={12} />
            <span>悬浮工具栏</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeSubtab === 'shortcuts'}
            className={activeSubtab === 'shortcuts' ? 'active' : ''}
            onClick={() => setSubtab('shortcuts')}
          >
            <UiIcon name="shortcuts" size={12} />
            <span>快捷键{customizedCount > 0 ? ` (${customizedCount})` : ''}</span>
          </button>
        </div>
      )}

      {activeSubtab === 'floating' ? (
        <>
          <div
            className="sb-panel-root"
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              minHeight: 0,
              overflowX: 'hidden',
              overflowY: 'auto',
              padding: embedded ? '14px 18px 16px' : '10px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: embedded ? 12 : 10
            }}
          >
            {editInspectorMode !== 'floating' && (
              <div className="sb-readonly-banner" role="status" style={{ margin: 0 }}>
                <span className="sb-readonly-text">当前为侧边栏模式</span>
                <button
                  type="button"
                  className="compact sb-readonly-btn"
                  onClick={() => setEditInspectorMode('floating')}
                >
                  切换为浮动条
                </button>
              </div>
            )}

            <div className="sb-setting-block prefs-fb-density-wrap">
              <div className="prefs-fb-density-head">
                <span className="sb-field-lbl">显示样式</span>
                <span className="prefs-card-meta">
                  {DENSITY_OPTIONS.find((d) => d.value === floatingBarDensity)?.label ?? '标准'}
                </span>
              </div>
              <div className="prefs-fb-density-grid" role="radiogroup" aria-label="浮动工具栏显示样式">
                {DENSITY_OPTIONS.map((opt) => {
                  const active = floatingBarDensity === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`prefs-fb-density-card ${active ? 'is-active' : ''}`}
                      onClick={() => setFloatingBarDensity(opt.value)}
                    >
                      <span className="prefs-fb-density-card-head">
                        <span className="prefs-fb-density-card-name">{opt.label}</span>
                      </span>
                      <span className="prefs-fb-density-card-desc">{opt.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="sb-setting-block">
              <div className="cust-target-header">
                <span className="sb-field-lbl">目标对象</span>
                <div className="cust-target-tabs" role="tablist" aria-label="切换要编辑浮动条的目标对象">
                  {TARGET_OPTIONS.map((opt) => {
                    const active = target === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={`cust-target-tab ${active ? 'is-active' : ''}`}
                        onClick={() => {
                          setTarget(opt.key);
                          setDraggingId(null);
                          setDragOver(null);
                        }}
                      >
                        <span
                          className="cust-target-dot"
                          style={{ backgroundColor: opt.accent }}
                          aria-hidden="true"
                        />
                        <span>{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
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
                <span className="sb-field-lbl">实时预览</span>
                <span className="sb-hint" style={{ margin: 0 }}>
                  {hiddenCount > 0
                    ? `隐藏的 ${hiddenCount} 项已自动归入右侧「…」菜单`
                    : '全部常用项已展开于主行'}
                </span>
              </div>
              <div className="cust-preview-wrap" aria-label="浮动工具栏实时预览">
                <div
                  className={`fb-arch fb-obj-${target} ${isCompactDensity ? 'is-compact' : ''} cust-preview-arch`}
                >
                  <div className="fb-arch-head">
                    <div className="fb-arch-head-left">
                      <span className="fb-arch-drag" aria-hidden="true">
                        <DragGripIcon size={11} />
                      </span>
                      <span className="fb-arch-kind">{activeTargetMeta.sampleKind}</span>
                      <span className="fb-arch-ctx">{activeTargetMeta.sampleCtx}</span>
                      <span className="fb-arch-time-trigger">
                        <span>{activeTargetMeta.sampleTime}</span>
                        <ChevronIcon size={9} />
                      </span>
                    </div>
                    <div className="fb-arch-head-right">
                      <span className="fb-arch-util-btn" aria-hidden="true">
                        <UiIcon name="inspector" size={11} />
                      </span>
                      <span className="fb-arch-util-btn" aria-hidden="true">
                        <CollapseIcon />
                      </span>
                    </div>
                  </div>
                  <div className="fb-arch-body">
                    {renderPreviewInlineFields()}
                    {visibleItems.map((item) => renderPreviewActionItem(item))}
                    {visibleItems.length > 0 && <span className="fb-arch-sep" />}
                    <span
                      className="fb-arch-btn is-icon cust-preview-more-badge"
                      title={
                        hiddenCount > 0
                          ? `更多操作（含 ${hiddenCount} 项已隐藏动作）`
                          : '更多操作'
                      }
                    >
                      <MoreDotsIcon />
                      {hiddenCount > 0 && (
                        <span className="cust-preview-more-count">{hiddenCount}</span>
                      )}
                    </span>
                    {target === 'multi' && (
                      <span className="fb-arch-btn is-icon" aria-hidden="true">
                        <CloseIcon size={11} />
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="sb-setting-block">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 6
                }}
              >
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span className="sb-field-lbl">按钮与排序</span>
                  <span className="sb-hint" style={{ margin: 0 }}>
                    {visibleItems.length} / {orderedItems.length} 显示
                  </span>
                </div>
                <div className="cust-quick-bar">
                  <div className="cust-quick-seg" role="group" aria-label="快速套用按钮组合">
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
                  <button
                    type="button"
                    className="compact"
                    style={{ height: 22, padding: '0 7px', fontSize: 11 }}
                    title="重置所有对象的按钮显隐、顺序与默认显示样式"
                    onClick={() => {
                      resetFloatingBarConfig();
                      setFloatingBarDensity('standard');
                    }}
                  >
                    <UiIcon name="reset" size={11} />
                    <span>恢复默认</span>
                  </button>
                </div>
              </div>

              <div
                ref={itemListRef}
                className="cust-item-list"
                role="list"
                aria-label="浮动工具栏按钮列表"
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
                      {isHidden && <span className="cust-item-overflow-tag">收纳至「…」</span>}
                    </div>
                  );
                })}
              </div>

              <div className="sb-hint">
                拖拽条目可自由调整画布浮动工具栏上的按钮顺序；取消勾选的动作会自动归入右侧「…」菜单，不会丢失功能。
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          {externalShortcutQuery === undefined && (
            <div
              style={{
                padding: embedded ? '10px 18px' : '9px 12px',
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
          )}

          <div
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              minHeight: 0,
              overflowX: 'hidden',
              overflowY: 'auto',
              padding: embedded ? '12px 18px' : '10px 12px'
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
                      fontSize: 11,
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
                                    fontSize: 11,
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
