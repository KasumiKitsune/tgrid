import React, { useEffect, useMemo, useRef, useState } from 'react';
import { isTauriRuntime } from '../bridge/PlatformBridge';
import type { BuiltinSampleId } from '../data/samples';
import {
  AutoPlayIcon,
  AutoSplitIcon,
  CorpusExportZipIcon,
  CorpusFolderIcon,
  CorpusNextIcon,
  CorpusPrevIcon,
  CorpusSidebarToggleIcon
} from '../corpus/corpusIcons';
import { formatPraatDouble } from '../layout/richText';
import {
  IS_MAC,
  formatKeyCombo,
  getEffectiveShortcutHint,
  isComposingEvent
} from '../shortcuts/registry';
import {
  canRedoTimeline,
  canUndoTimeline,
  getLatestRedoEntry,
  getLatestUndoEntry
} from '../store/historyModel';
import { useEditorStore, type RibbonTabId } from '../store/useEditorStore';
import { getElementRectScale } from '../utils/uiScale';
import { ChevronIcon, UiIcon } from './Icons';
import type { ExportActionKind } from './Topbar';

export interface RibbonBarProps {
  onOpenTextGridPicker: () => void;
  onOpenCorpusFolder: () => void;
  onOpenAudioPicker: () => void;
  onLoadSample: (id: BuiltinSampleId) => void;
  onExportAction: (kind: ExportActionKind) => void;
  onBatchConvertIpa: (direction: 'toUnicode' | 'toPraat') => void;
  corpusCanPrev?: boolean;
  corpusCanNext?: boolean;
  onCorpusPrev?: () => void;
  onCorpusNext?: () => void;
  onToggleCorpusAutoPlay?: () => void;
  onToggleCorpusAutoVad?: () => void;
  onExportCorpusZip?: () => void;
  exportingCorpusZip?: boolean;
}

interface PopoutPos {
  left: number;
  top: number;
}

const BASE_TABS: Array<{ id: RibbonTabId; label: string }> = [
  { id: 'file', label: '文件' },
  { id: 'annotate', label: '标注' },
  { id: 'tiers', label: '层与时间' },
  { id: 'view', label: '视图' },
  { id: 'tools', label: '工具' }
];

const CUE_MODES: Array<{ id: 'auto' | 'pitch' | 'formant' | 'plain'; label: string; title: string }> = [
  { id: 'auto', label: '自动', title: '根据语音与声学特征自动叠加提示曲线' },
  { id: 'pitch', label: '基频', title: '在语谱图上叠加基频曲线 (F0)' },
  { id: 'formant', label: '共振峰', title: '在语谱图上叠加共振峰轨迹 (F1–F3)' },
  { id: 'plain', label: '纯语谱', title: '仅显示宽带语谱图，不叠加声学曲线' }
];

const preventBlur = (e: React.MouseEvent) => {
  e.preventDefault();
};

export const RibbonBar: React.FC<RibbonBarProps> = ({
  onOpenTextGridPicker,
  onOpenCorpusFolder,
  onOpenAudioPicker,
  onLoadSample,
  onExportAction,
  onBatchConvertIpa,
  corpusCanPrev,
  corpusCanNext,
  onCorpusPrev,
  onCorpusNext,
  onToggleCorpusAutoPlay,
  onToggleCorpusAutoVad,
  onExportCorpusZip,
  exportingCorpusZip = false
}) => {
  const isDesktop = isTauriRuntime();

  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const currentFilePath = useEditorStore((s) => s.currentFilePath);
  const tg = useEditorStore((s) => s.tg);
  const collectionTgs = useEditorStore((s) => s.collectionTgs);
  const collectionActiveIdx = useEditorStore((s) => s.collectionActiveIdx);
  const switchCollectionItem = useEditorStore((s) => s.switchCollectionItem);
  const history = useEditorStore((s) => s.history);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);

  const ribbonTab = useEditorStore((s) => s.ribbonTab);
  const setRibbonTab = useEditorStore((s) => s.setRibbonTab);
  const ribbonCollapsed = useEditorStore((s) => s.ribbonCollapsed);
  const setRibbonCollapsed = useEditorStore((s) => s.setRibbonCollapsed);
  const toggleRibbonCollapsed = useEditorStore((s) => s.toggleRibbonCollapsed);

  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const isReadOnly = mode === 'read';

  const ipaMode = useEditorStore((s) => s.ipaMode);
  const setIpaMode = useEditorStore((s) => s.setIpaMode);
  const ipaDockOpen = useEditorStore((s) => s.ipaDockOpen);
  const setIpaDockOpen = useEditorStore((s) => s.setIpaDockOpen);

  const legendOpen = useEditorStore((s) => s.legendOpen);
  const toggleLegend = useEditorStore((s) => s.toggleLegend);
  const sidebarOpen = useEditorStore((s) => s.sidebarOpen);
  const sidebarTab = useEditorStore((s) => s.sidebarTab);
  const setSidebarOpen = useEditorStore((s) => s.setSidebarOpen);
  const toggleSidebarTab = useEditorStore((s) => s.toggleSidebarTab);

  const scaleMode = useEditorStore((s) => s.scaleMode);
  const setScaleMode = useEditorStore((s) => s.setScaleMode);
  const wrapMode = useEditorStore((s) => s.wrapMode);
  const setWrapMode = useEditorStore((s) => s.setWrapMode);
  const audioName = useEditorStore((s) => s.audioName);
  const showSpectrogram = useEditorStore((s) => s.showSpectrogram);
  const setShowSpectrogram = useEditorStore((s) => s.setShowSpectrogram);
  const cueMode = useEditorStore((s) => s.cueMode);
  const setCueMode = useEditorStore((s) => s.setCueMode);
  const canvasScale = useEditorStore((s) => s.canvasScale);
  const setCanvasScale = useEditorStore((s) => s.setCanvasScale);

  const insertTierAt = useEditorStore((s) => s.insertTierAt);
  const normalizeTextGrid = useEditorStore((s) => s.normalizeTextGrid);
  const commitTgMutation = useEditorStore((s) => s.commitTgMutation);
  const showToast = useEditorStore((s) => s.showToast);

  const openFindBar = useEditorStore((s) => s.openFindBar);
  const setShortcutsOpen = useEditorStore((s) => s.setShortcutsOpen);
  const setAboutOpen = useEditorStore((s) => s.setAboutOpen);
  const customShortcuts = useEditorStore((s) => s.customShortcuts);

  const showCorpusStatusMarks = useEditorStore((s) => s.showCorpusStatusMarks);
  const setShowCorpusStatusMarks = useEditorStore((s) => s.setShowCorpusStatusMarks);
  const toggleCorpusSidebar = useEditorStore((s) => s.toggleCorpusSidebar);
  const setCorpusOptions = useEditorStore((s) => s.setCorpusOptions);

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);
  const activeCorpus = activeTab?.kind === 'corpus' ? (activeTab.corpus ?? null) : null;
  const isCorpus = Boolean(activeCorpus);

  // If user switches to a single-file tab while on 'corpus', fall back to 'annotate'
  useEffect(() => {
    if (!isCorpus && ribbonTab === 'corpus') {
      setRibbonTab('annotate');
    }
  }, [isCorpus, ribbonTab, setRibbonTab]);

  const effectiveTab: RibbonTabId = !isCorpus && ribbonTab === 'corpus' ? 'annotate' : ribbonTab;

  // Shortcut hints
  const openFilesHint = getEffectiveShortcutHint('open-files', customShortcuts);
  const openAudioHint = getEffectiveShortcutHint('open-audio', customShortcuts);
  const saveFileHint = getEffectiveShortcutHint('save-file', customShortcuts);
  const saveAsHint = getEffectiveShortcutHint('save-as', customShortcuts);
  const exportFigureHint = getEffectiveShortcutHint('export-figure', customShortcuts);
  const findOpenHint = getEffectiveShortcutHint('find-open', customShortcuts);
  const replaceOpenHint = getEffectiveShortcutHint('replace-open', customShortcuts);
  const shortcutsModalHint = getEffectiveShortcutHint('shortcuts-modal', customShortcuts);
  const sidebarToggleHint = getEffectiveShortcutHint('sidebar-toggle', customShortcuts);
  const ipaCycleHint = getEffectiveShortcutHint('ipa-cycle', customShortcuts);
  const ipaTempEnHint = getEffectiveShortcutHint('ipa-temp-en', customShortcuts);
  const ipaDockHint = getEffectiveShortcutHint('ipa-dock-toggle', customShortcuts);

  // Undo / Redo state
  const canUndo = canUndoTimeline(history);
  const canRedo = canRedoTimeline(history);
  const undoEntry = getLatestUndoEntry(history);
  const redoEntry = getLatestRedoEntry(history);
  const undoShortcut = formatKeyCombo('Mod+Z');
  const redoShortcut = formatKeyCombo(IS_MAC ? 'Mod+Shift+Z' : 'Mod+Y');
  const undoTitle = undoEntry
    ? `撤销：${undoEntry.meta.title}${undoEntry.meta.detail ? ` (${undoEntry.meta.detail})` : ''} (${undoShortcut})`
    : `撤销 (${undoShortcut})`;
  const redoTitle = redoEntry
    ? `重做：${redoEntry.meta.title}${redoEntry.meta.detail ? ` (${redoEntry.meta.detail})` : ''} (${redoShortcut})`
    : `重做 (${redoShortcut})`;
  const histCountLabel =
    history.cursor < history.entries.length - 1
      ? `${history.cursor + 1}/${history.entries.length}`
      : String(history.entries.length);

  // Global time bounds local state (replicated faithfully from EditStrip.tsx)
  const [minText, setMinText] = useState(formatPraatDouble(tg.xmin));
  const [maxText, setMaxText] = useState(formatPraatDouble(tg.xmax));
  const skipMinBlurRef = useRef(false);
  const skipMaxBlurRef = useRef(false);

  useEffect(() => {
    setMinText(formatPraatDouble(tg.xmin));
    setMaxText(formatPraatDouble(tg.xmax));
  }, [tg.xmin, tg.xmax]);

  const commitGlobalMin = () => {
    if (skipMinBlurRef.current) {
      skipMinBlurRef.current = false;
      return;
    }
    if (isReadOnly) {
      setMinText(formatPraatDouble(tg.xmin));
      return;
    }
    const val = parseFloat(minText);
    if (!Number.isFinite(val) || val >= tg.xmax) {
      showToast('全局起点必须严格小于终点', true);
      setMinText(formatPraatDouble(tg.xmin));
      return;
    }
    if (val !== tg.xmin) {
      const oldMin = tg.xmin;
      commitTgMutation(
        (draft, ctx) => {
          draft.xmin = val;
          for (let ti = 0; ti < draft.tiers.length; ti++) {
            const origTier = draft.tiers[ti];
            const touchesBound = origTier.xmin === oldMin;
            const touchesFirstIv =
              origTier.kind === 'intervalTier' &&
              origTier.intervals.length > 0 &&
              origTier.intervals[0].xmin === oldMin &&
              origTier.intervals[0].xmax > val;
            if (!touchesBound && !touchesFirstIv) continue;
            const dTier = ctx.editTier(ti);
            if (!dTier) continue;
            if (dTier.xmin === oldMin) dTier.xmin = val;
            if (
              dTier.kind === 'intervalTier' &&
              dTier.intervals.length > 0 &&
              dTier.intervals[0].xmin === oldMin &&
              dTier.intervals[0].xmax > val
            ) {
              dTier.intervals[0].xmin = val;
            }
          }
        },
        undefined,
        {
          type: 'edit-global-bounds',
          title: '修改全局起点',
          detail: `起点 ${oldMin.toFixed(3)}s → ${val.toFixed(3)}s`,
          icon: 'copyTime',
          focusTime: val
        }
      );
    }
  };

  const commitGlobalMax = () => {
    if (skipMaxBlurRef.current) {
      skipMaxBlurRef.current = false;
      return;
    }
    if (isReadOnly) {
      setMaxText(formatPraatDouble(tg.xmax));
      return;
    }
    const val = parseFloat(maxText);
    if (!Number.isFinite(val) || val <= tg.xmin) {
      showToast('全局终点必须严格大于起点', true);
      setMaxText(formatPraatDouble(tg.xmax));
      return;
    }
    if (val !== tg.xmax) {
      const oldMax = tg.xmax;
      commitTgMutation(
        (draft, ctx) => {
          draft.xmax = val;
          for (let ti = 0; ti < draft.tiers.length; ti++) {
            const origTier = draft.tiers[ti];
            const touchesBound = origTier.xmax === oldMax;
            const lastOrig =
              origTier.kind === 'intervalTier' && origTier.intervals.length > 0
                ? origTier.intervals[origTier.intervals.length - 1]
                : null;
            const touchesLastIv = Boolean(
              lastOrig && lastOrig.xmax === oldMax && lastOrig.xmin < val
            );
            if (!touchesBound && !touchesLastIv) continue;
            const dTier = ctx.editTier(ti);
            if (!dTier) continue;
            if (dTier.xmax === oldMax) dTier.xmax = val;
            if (dTier.kind === 'intervalTier' && dTier.intervals.length > 0) {
              const last = dTier.intervals[dTier.intervals.length - 1];
              if (last.xmax === oldMax && last.xmin < val) {
                last.xmax = val;
              }
            }
          }
        },
        undefined,
        {
          type: 'edit-global-bounds',
          title: '修改全局终点',
          detail: `终点 ${oldMax.toFixed(3)}s → ${val.toFixed(3)}s`,
          icon: 'copyTime',
          focusTime: val
        }
      );
    }
  };

  // Dropdown state: 'export' lives in .ribbon-tabrow (overflow visible),
  // while 'samples' & 'col' are detached popouts inside .ribbon-bar to never clip on .ribbon-panel scroll.
  const [openMenu, setOpenMenu] = useState<'export' | 'samples' | 'col' | null>(null);
  const [popoutPos, setPopoutPos] = useState<PopoutPos | null>(null);
  const ribbonBarRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ribbonBarRef.current && !ribbonBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenMenu(null);
      }
    };
    const onResize = () => {
      setOpenMenu((cur) => (cur === 'samples' || cur === 'col' ? null : cur));
    };
    document.addEventListener('click', onDocClick);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useEffect(() => {
    setOpenMenu(null);
  }, [effectiveTab, ribbonCollapsed]);

  const togglePopoutMenu = (menu: 'samples' | 'col', triggerEl: HTMLElement) => {
    if (openMenu === menu) {
      setOpenMenu(null);
      return;
    }
    const barEl = ribbonBarRef.current;
    if (barEl) {
      const barRect = barEl.getBoundingClientRect();
      const btnRect = triggerEl.getBoundingClientRect();
      const scale = getElementRectScale(barEl);
      setPopoutPos({
        left: Math.max(4, (btnRect.left - barRect.left) / scale),
        top: (btnRect.bottom - barRect.top) / scale + 4
      });
    }
    setOpenMenu(menu);
  };

  // Corpus prev/next fallback computation when optional props are omitted
  const corpusFallbackNav = useMemo(() => {
    if (!activeCorpus) return { canPrev: false, canNext: false };
    const idx = activeCorpus.activeItemId
      ? activeCorpus.items.findIndex((it) => it.id === activeCorpus.activeItemId)
      : -1;
    const total = activeCorpus.items.length;
    return {
      canPrev: idx > 0 && total > 0,
      canNext: total > 0 && (idx === -1 || idx < total - 1)
    };
  }, [activeCorpus]);

  const resolvedCorpusCanPrev =
    corpusCanPrev !== undefined ? corpusCanPrev : corpusFallbackNav.canPrev;
  const resolvedCorpusCanNext =
    corpusCanNext !== undefined ? corpusCanNext : corpusFallbackNav.canNext;

  const handleToggleAutoPlay = () => {
    if (onToggleCorpusAutoPlay) {
      onToggleCorpusAutoPlay();
      return;
    }
    if (activeCorpus) {
      setCorpusOptions({ autoPlay: !activeCorpus.options.autoPlay });
    }
  };

  const handleToggleAutoVad = () => {
    if (onToggleCorpusAutoVad) {
      onToggleCorpusAutoVad();
      return;
    }
    if (activeCorpus) {
      setCorpusOptions({ autoVad: !activeCorpus.options.autoVad });
    }
  };

  const handleTabClick = (tabId: RibbonTabId) => {
    if (tabId === effectiveTab) {
      if (ribbonCollapsed) {
        setRibbonCollapsed(false);
      }
      return;
    }
    setRibbonTab(tabId);
    if (ribbonCollapsed) {
      setRibbonCollapsed(false);
    }
  };

  const handleTabDoubleClick = (tabId: RibbonTabId) => {
    if (tabId === effectiveTab) {
      toggleRibbonCollapsed();
    }
  };

  const renderFileTab = () => (
    <>
      {collectionTgs.length > 1 && (
        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ribbon-col-trigger ${openMenu === 'col' ? 'is-menu-open' : ''}`}
                  title="切换当前集合文件中的 TextGrid 对象"
                  onClick={(e) => togglePopoutMenu('col', e.currentTarget)}
                >
                  <UiIcon name="fileCollection" size={13} />
                  <span className="ribbon-col-name">
                    {collectionActiveIdx + 1}. {collectionTgs[collectionActiveIdx]?.name || 'TextGrid'}
                  </span>
                  <ChevronIcon size={10} />
                </button>
              </div>
              <div className="ribbon-row">
                <span style={{ fontSize: 10.5, color: 'var(--ink-faint)', padding: '0 2px' }}>
                  共 {collectionTgs.length} 个对象
                </span>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">集合对象</div>
        </div>
      )}

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            type="button"
            className="ribbon-big-btn"
            title={
              openFilesHint
                ? `打开 TextGrid / Collection / 单层文件 (${openFilesHint})`
                : '打开 TextGrid / Collection / 单层文件'
            }
            onClick={onOpenTextGridPicker}
          >
            <UiIcon name="folder" size={22} />
            <span>打开 TextGrid</span>
          </button>
          <button
            type="button"
            className="ribbon-big-btn"
            title="打开文件夹，批量标注录音与 TextGrid"
            onClick={onOpenCorpusFolder}
          >
            <CorpusFolderIcon size={22} />
            <span>打开文件夹</span>
          </button>
          <div className="ribbon-stack">
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn"
                title={openAudioHint ? `载入配套录音 (${openAudioHint})` : '载入配套录音'}
                onClick={onOpenAudioPicker}
              >
                <UiIcon name="waveform" size={13} />
                <span>打开录音</span>
              </button>
            </div>
            <div className="ribbon-row">
              <button
                type="button"
                className={`ribbon-sm-btn ${openMenu === 'samples' ? 'is-menu-open' : ''}`}
                aria-expanded={openMenu === 'samples'}
                title="载入内置示例或新建空白文件"
                onClick={(e) => togglePopoutMenu('samples', e.currentTarget)}
              >
                <UiIcon name="samples" size={13} />
                <span>示例</span>
                <ChevronIcon size={10} />
              </button>
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">打开</div>
      </div>

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            type="button"
            className="ribbon-big-btn"
            title={saveFileHint ? `保存 TextGrid (${saveFileHint})` : '保存 TextGrid'}
            onClick={() => onExportAction('save')}
          >
            <UiIcon name="save" size={22} />
            <span>保存</span>
          </button>
          <button
            type="button"
            className="ribbon-big-btn"
            title={exportFigureHint ? `自定义导出图像 (${exportFigureHint})` : '自定义导出图像'}
            onClick={() => onExportAction('dialog')}
          >
            <UiIcon name="export" size={22} />
            <span>导出图像…</span>
          </button>
          <div className="ribbon-stack">
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn"
                title="快速导出矢量图 (.svg)"
                onClick={() => onExportAction('svg')}
              >
                <UiIcon name="exportSvg" size={13} />
                <span>导出矢量图 (.svg)</span>
              </button>
              <button
                type="button"
                className="ribbon-sm-btn"
                title="快速导出高清图片 (.png)"
                onClick={() => onExportAction('png')}
              >
                <UiIcon name="exportPng" size={13} />
                <span>导出高清图片 (.png)</span>
              </button>
            </div>
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn"
                title="打开声纹海报生成器"
                onClick={() => onExportAction('poster')}
              >
                <UiIcon name="exportSvg" size={13} />
                <span>导出声纹海报…</span>
              </button>
              {isDesktop && (
                <button
                  type="button"
                  className="ribbon-sm-btn"
                  title={saveAsHint ? `另存为 (${saveAsHint})` : '另存为'}
                  onClick={() => onExportAction('save-as')}
                >
                  <UiIcon name="saveAs" size={13} />
                  <span>另存为…</span>
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">保存与导出</div>
      </div>
    </>
  );

  const renderAnnotateTab = () => (
    <>
      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            type="button"
            className={`ribbon-big-btn ipa-ctrl-noblur ${ipaDockOpen ? 'ribbon-soft-active' : ''}`}
            aria-pressed={ipaDockOpen}
            title={
              ipaDockHint
                ? `打开 / 关闭交互式国际音标虚拟键盘 (${ipaDockHint})`
                : '打开 / 关闭交互式国际音标虚拟键盘'
            }
            onMouseDown={preventBlur}
            onClick={() => setIpaDockOpen(!ipaDockOpen)}
          >
            <UiIcon name="keyboard" size={22} />
            <span>音标盘</span>
          </button>

          <div className="ribbon-stack">
            <div className="ribbon-row">
              <div
                className="ribbon-seg ipa-ctrl-noblur"
                role="group"
                aria-label="国际音标输入方案"
                title={
                  ipaCycleHint
                    ? `国际音标输入方案 (${ipaCycleHint} 切换；不影响画布与属性栏显示已有 \\xx 转义对照)`
                    : '国际音标输入方案（不影响画布与属性栏显示已有 \\xx 转义对照）'
                }
                onMouseDown={preventBlur}
              >
                <button
                  type="button"
                  className={ipaMode === 'off' ? 'is-active' : ''}
                  title="关闭音标键盘输入（文本中已有的 Praat \\xx 转义仍会显示对照）"
                  onClick={() => setIpaMode('off')}
                >
                  关闭
                </button>
                <button
                  type="button"
                  className={ipaMode === 'yunlong' ? 'is-active' : ''}
                  title={
                    ipaTempEnHint
                      ? `云龙国际音标输入方案 (${ipaTempEnHint} 临时切英文)`
                      : '云龙国际音标输入方案'
                  }
                  onClick={() => setIpaMode('yunlong')}
                >
                  云龙
                </button>
                <button
                  type="button"
                  className={ipaMode === 'praat' ? 'is-active' : ''}
                  title={
                    ipaTempEnHint
                      ? `Praat 音标转义输入（即时转 Unicode IPA，${ipaTempEnHint} 临时切英文）`
                      : 'Praat 音标转义输入（即时转 Unicode IPA）'
                  }
                  onClick={() => setIpaMode('praat')}
                >
                  Praat
                </button>
              </div>
            </div>
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn ipa-ctrl-noblur"
                title="将全文 Praat 转义音标批量转为 Unicode IPA"
                onMouseDown={preventBlur}
                onClick={() => onBatchConvertIpa('toUnicode')}
              >
                <UiIcon name="convertUnicode" size={13} />
                <span>转 Unicode</span>
              </button>
              <button
                type="button"
                className="ribbon-sm-btn ipa-ctrl-noblur"
                title="将全文 Unicode IPA 批量转为 Praat 转义编码"
                onMouseDown={preventBlur}
                onClick={() => onBatchConvertIpa('toPraat')}
              >
                <UiIcon name="convertPraat" size={13} />
                <span>转 Praat</span>
              </button>
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">国际音标</div>
      </div>

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            type="button"
            className="ribbon-big-btn ipa-ctrl-noblur"
            title={findOpenHint ? `查找与替换 (${findOpenHint})` : '查找与替换'}
            onMouseDown={preventBlur}
            onClick={() => openFindBar(false)}
          >
            <UiIcon name="search" size={22} />
            <span>查找与替换</span>
          </button>
          <div className="ribbon-stack">
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn ipa-ctrl-noblur"
                title={replaceOpenHint ? `替换标注文本 (${replaceOpenHint})` : '替换标注文本'}
                onMouseDown={preventBlur}
                onClick={() => openFindBar(true)}
              >
                <UiIcon name="replace" size={13} />
                <span>替换文本…</span>
              </button>
            </div>
            <div className="ribbon-row">
              <button
                type="button"
                className={`ribbon-sm-btn ipa-ctrl-noblur ${
                  sidebarOpen && sidebarTab === 'history' ? 'ribbon-soft-active' : ''
                }`}
                aria-pressed={sidebarOpen && sidebarTab === 'history'}
                title="打开 / 收起操作历史面板 (Alt+3)"
                onMouseDown={preventBlur}
                onClick={() => toggleSidebarTab('history')}
              >
                <UiIcon name="history" size={13} />
                <span>操作历史</span>
                <span className="ribbon-count-pill">{histCountLabel}</span>
              </button>
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">编辑与历史</div>
      </div>

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            type="button"
            className={`ribbon-big-btn ipa-ctrl-noblur ${legendOpen ? 'ribbon-soft-active' : ''}`}
            aria-pressed={legendOpen}
            title="在底部显示或隐藏交互式读图图例"
            onMouseDown={preventBlur}
            onClick={toggleLegend}
          >
            <UiIcon name="legend" size={22} />
            <span>读图图例</span>
          </button>
          <div className="ribbon-stack">
            <div className="ribbon-row">
              <button
                type="button"
                className={`ribbon-sm-btn ipa-ctrl-noblur ${
                  sidebarOpen && sidebarTab === 'inspector' ? 'ribbon-soft-active' : ''
                }`}
                aria-pressed={sidebarOpen && sidebarTab === 'inspector'}
                title="在右侧边栏打开或收起属性面板 (Alt+1)"
                onMouseDown={preventBlur}
                onClick={() => toggleSidebarTab('inspector')}
              >
                <UiIcon name="inspector" size={13} />
                <span>属性面板</span>
              </button>
            </div>
            <div className="ribbon-row">
              <button
                type="button"
                className={`ribbon-sm-btn ipa-ctrl-noblur ${
                  sidebarOpen && sidebarTab === 'settings' ? 'ribbon-soft-active' : ''
                }`}
                aria-pressed={sidebarOpen && sidebarTab === 'settings'}
                title="在右侧边栏打开版面、时间精度与声学设置 (Alt+4)"
                onMouseDown={preventBlur}
                onClick={() => toggleSidebarTab('settings')}
              >
                <UiIcon name="gear" size={13} />
                <span>版面与声学设置</span>
              </button>
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">参考与面板</div>
      </div>
    </>
  );

  const renderTiersTab = () => {
    const readOnlyHint = '仅编辑模式下可用，请先切至编辑模式';
    return (
      <>
        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={isReadOnly}
              title={isReadOnly ? readOnlyHint : '在底部新建一个区间层 (IntervalTier)'}
              onMouseDown={preventBlur}
              onClick={() => insertTierAt(tg.tiers.length, 'intervalTier')}
            >
              <UiIcon name="addIntervalTier" size={22} />
              <span>+ 区间层</span>
            </button>
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={isReadOnly}
              title={isReadOnly ? readOnlyHint : '在底部新建一个点层 (TextTier)'}
              onMouseDown={preventBlur}
              onClick={() => insertTierAt(tg.tiers.length, 'textTier')}
            >
              <UiIcon name="addPointTier" size={22} />
              <span>+ 点层</span>
            </button>
          </div>
          <div className="ribbon-group-label">新建层</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn ipa-ctrl-noblur"
              disabled={isReadOnly}
              title={isReadOnly ? readOnlyHint : '补齐缝隙并统一各层起止时间'}
              onMouseDown={preventBlur}
              onClick={normalizeTextGrid}
            >
              <UiIcon name="normalize" size={22} />
              <span>整理边界</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ipa-ctrl-noblur ${
                    sidebarOpen && sidebarTab === 'tiers' ? 'ribbon-soft-active' : ''
                  }`}
                  aria-pressed={sidebarOpen && sidebarTab === 'tiers'}
                  title="打开 / 收起层管理面板 (Alt+2)"
                  onMouseDown={preventBlur}
                  onClick={() => toggleSidebarTab('tiers')}
                >
                  <UiIcon name="layers" size={13} />
                  <span>层管理面板</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ipa-ctrl-noblur ${
                    sidebarOpen && sidebarTab === 'inspector' ? 'ribbon-soft-active' : ''
                  }`}
                  aria-pressed={sidebarOpen && sidebarTab === 'inspector'}
                  title="打开 / 收起属性面板 (Alt+1)"
                  onMouseDown={preventBlur}
                  onClick={() => toggleSidebarTab('inspector')}
                >
                  <UiIcon name="inspector" size={13} />
                  <span>属性面板</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">整理</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <label
                  className="ribbon-field"
                  title={isReadOnly ? readOnlyHint : '修改文档全局起点时间 (秒)，回车确认 / Esc 取消'}
                >
                  <span className="ribbon-field-lbl">起点</span>
                  <input
                    type="number"
                    step="any"
                    disabled={isReadOnly}
                    aria-label="全局起点时间"
                    value={minText}
                    onChange={(e) => setMinText(e.target.value)}
                    onBlur={commitGlobalMin}
                    onKeyDown={(e) => {
                      if (isComposingEvent(e)) return;
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        skipMinBlurRef.current = true;
                        setMinText(formatPraatDouble(tg.xmin));
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </label>
              </div>
              <div className="ribbon-row">
                <label
                  className="ribbon-field"
                  title={isReadOnly ? readOnlyHint : '修改文档全局终点时间 (秒)，回车确认 / Esc 取消'}
                >
                  <span className="ribbon-field-lbl">终点</span>
                  <input
                    type="number"
                    step="any"
                    disabled={isReadOnly}
                    aria-label="全局终点时间"
                    value={maxText}
                    onChange={(e) => setMaxText(e.target.value)}
                    onBlur={commitGlobalMax}
                    onKeyDown={(e) => {
                      if (isComposingEvent(e)) return;
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        skipMaxBlurRef.current = true;
                        setMaxText(formatPraatDouble(tg.xmax));
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </label>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">时间范围</div>
        </div>
      </>
    );
  };

  const renderViewTab = () => {
    const scalePct = Math.round(canvasScale * 100);
    const isDefaultScale = Math.abs(canvasScale - 1) < 0.005;
    const hasAudio = Boolean(audioName);

    return (
      <>
        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className={`ribbon-big-btn ${scaleMode === 'elastic' ? 'ribbon-soft-active' : ''}`}
              aria-pressed={scaleMode === 'elastic'}
              title="自适应时间比例：自动放宽短音段以便阅读标注文字"
              onClick={() => setScaleMode('elastic')}
            >
              <UiIcon name="toggleScale" size={22} />
              <span>自适应</span>
            </button>
            <button
              type="button"
              className={`ribbon-big-btn ${scaleMode === 'linear' ? 'ribbon-soft-active' : ''}`}
              aria-pressed={scaleMode === 'linear'}
              title="严格线性时间比例：与声学波形和语谱图等比对齐"
              onClick={() => setScaleMode('linear')}
            >
              <UiIcon name="navHorizontal" size={22} />
              <span>线性</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ${wrapMode === 'auto' ? 'ribbon-soft-active' : ''}`}
                  aria-pressed={wrapMode === 'auto'}
                  title={
                    wrapMode === 'auto'
                      ? '当前：自动折行多行排版（点击切为单行展开）'
                      : '当前：单行横向展开（点击切为自动折行）'
                  }
                  onClick={() => setWrapMode(wrapMode === 'auto' ? 'single' : 'auto')}
                >
                  <UiIcon name="wrapToggle" size={13} />
                  <span>自动折行</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ${legendOpen ? 'ribbon-soft-active' : ''}`}
                  aria-pressed={legendOpen}
                  title="显示或隐藏底部交互式读图图例"
                  onClick={toggleLegend}
                >
                  <UiIcon name="legend" size={13} />
                  <span>读图图例</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">时间与折行</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className={`ribbon-big-btn ${hasAudio && showSpectrogram ? 'ribbon-soft-active' : ''}`}
              disabled={!hasAudio}
              aria-pressed={hasAudio && showSpectrogram}
              title={
                hasAudio
                  ? showSpectrogram
                    ? '隐藏宽带语谱图'
                    : '显示宽带语谱图'
                  : '请先载入配套录音后查看语谱图'
              }
              onClick={() => setShowSpectrogram(!showSpectrogram)}
            >
              <UiIcon name="waveform" size={22} />
              <span>宽带语图</span>
            </button>

            <div className="ribbon-stack">
              <div className="ribbon-row">
                <div
                  className="ribbon-seg"
                  role="group"
                  aria-label="声学曲线提示层"
                  title={hasAudio ? '选择语谱图叠加的声学曲线' : '载入录音后可切换声学曲线'}
                >
                  {CUE_MODES.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      disabled={!hasAudio || !showSpectrogram}
                      className={cueMode === item.id ? 'is-active' : ''}
                      title={item.title}
                      onClick={() => setCueMode(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn"
                  disabled={isDefaultScale}
                  title={`恢复谱面画布缩放为 100%（当前 ${scalePct}%，${formatKeyCombo('Mod+0')}）`}
                  onClick={() => setCanvasScale(1)}
                >
                  <UiIcon name="reset" size={13} />
                  <span>重置画布缩放</span>
                  {!isDefaultScale && <span className="ribbon-count-pill">{scalePct}%</span>}
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">声学曲线</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ${sidebarOpen ? 'ribbon-soft-active' : ''}`}
                  aria-pressed={sidebarOpen}
                  title={
                    sidebarToggleHint
                      ? `展开或收起右侧边栏 (${sidebarToggleHint})`
                      : '展开或收起右侧边栏'
                  }
                  onClick={() => setSidebarOpen(!sidebarOpen)}
                >
                  <UiIcon name="sidebarToggle" size={13} />
                  <span>右侧栏</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ${
                    sidebarOpen && sidebarTab === 'settings' ? 'ribbon-soft-active' : ''
                  }`}
                  aria-pressed={sidebarOpen && sidebarTab === 'settings'}
                  title="打开 / 收起设置面板 (Alt+4)"
                  onClick={() => toggleSidebarTab('settings')}
                >
                  <UiIcon name="gear" size={13} />
                  <span>设置面板</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">侧边栏</div>
        </div>
      </>
    );
  };

  const renderToolsTab = () => (
    <>
      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            type="button"
            className="ribbon-big-btn ipa-ctrl-noblur"
            title={findOpenHint ? `查找与替换 (${findOpenHint})` : '查找与替换'}
            onMouseDown={preventBlur}
            onClick={() => openFindBar(false)}
          >
            <UiIcon name="search" size={22} />
            <span>查找与替换</span>
          </button>
          <div className="ribbon-stack">
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn ipa-ctrl-noblur"
                title="将全文 Praat 转义音标批量转为 Unicode IPA"
                onMouseDown={preventBlur}
                onClick={() => onBatchConvertIpa('toUnicode')}
              >
                <UiIcon name="convertUnicode" size={13} />
                <span>转 Unicode IPA</span>
              </button>
            </div>
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn ipa-ctrl-noblur"
                title="将全文 Unicode IPA 批量转为 Praat 转义编码"
                onMouseDown={preventBlur}
                onClick={() => onBatchConvertIpa('toPraat')}
              >
                <UiIcon name="convertPraat" size={13} />
                <span>转 Praat 转义</span>
              </button>
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">查找与转换</div>
      </div>

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            type="button"
            className="ribbon-big-btn"
            title={shortcutsModalHint ? `快捷键指南 (${shortcutsModalHint})` : '快捷键指南'}
            onClick={() => setShortcutsOpen(true)}
          >
            <UiIcon name="shortcuts" size={22} />
            <span>快捷键指南</span>
          </button>
          <div className="ribbon-stack">
            <div className="ribbon-row">
              <button
                type="button"
                className={`ribbon-sm-btn ${
                  sidebarOpen && sidebarTab === 'customize' ? 'ribbon-soft-active' : ''
                }`}
                aria-pressed={sidebarOpen && sidebarTab === 'customize'}
                title="自定义悬浮工具栏与快捷键 (Alt+5)"
                onClick={() => toggleSidebarTab('customize')}
              >
                <UiIcon name="customize" size={13} />
                <span>自定义悬浮条与快捷键</span>
              </button>
              <button
                type="button"
                className={`ribbon-sm-btn ${
                  sidebarOpen && sidebarTab === 'history' ? 'ribbon-soft-active' : ''
                }`}
                aria-pressed={sidebarOpen && sidebarTab === 'history'}
                title="操作历史记录 (Alt+3)"
                onClick={() => toggleSidebarTab('history')}
              >
                <UiIcon name="history" size={13} />
                <span>操作历史</span>
              </button>
            </div>
            <div className="ribbon-row">
              <button
                type="button"
                className="ribbon-sm-btn"
                title="查看 T·Grid 版本与说明"
                onClick={() => setAboutOpen(true)}
              >
                <UiIcon name="info" size={13} />
                <span>关于 T·Grid</span>
              </button>
            </div>
          </div>
        </div>
        <div className="ribbon-group-label">效率与关于</div>
      </div>
    </>
  );

  const renderCorpusTab = () => {
    if (!activeCorpus) return null;
    const canExportZip = !activeCorpus.writable && Boolean(onExportCorpusZip);
    const zipTitle = activeCorpus.writable
      ? '当前文件夹已启用自动保存，修改会直接写回原目录'
      : activeCorpus.dirtyCount > 0
        ? `导出已修改的 ${activeCorpus.dirtyCount} 个标注文件 (.zip)`
        : '导出当前文件夹已修改的标注文件 (.zip)';

    return (
      <>
        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className={`ribbon-big-btn ipa-ctrl-noblur ${
                activeCorpus.options.autoPlay ? 'ribbon-soft-active' : ''
              }`}
              aria-pressed={activeCorpus.options.autoPlay}
              title="切换词条后自动播放当前语音段"
              onMouseDown={preventBlur}
              onClick={handleToggleAutoPlay}
            >
              <AutoPlayIcon size={22} />
              <span>自动播放</span>
            </button>
            <button
              type="button"
              className={`ribbon-big-btn ipa-ctrl-noblur ${
                activeCorpus.options.autoVad ? 'ribbon-soft-active' : ''
              }`}
              aria-pressed={activeCorpus.options.autoVad}
              title="打开无标注文件的音频时，自动按静音切分起止边界"
              onMouseDown={preventBlur}
              onClick={handleToggleAutoVad}
            >
              <AutoSplitIcon size={22} />
              <span>自动切分</span>
            </button>
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ${showCorpusStatusMarks ? 'ribbon-soft-active' : ''}`}
                  aria-pressed={showCorpusStatusMarks}
                  title="显示或隐藏词条的未标、已完成、存疑、需重录标记"
                  onClick={() => setShowCorpusStatusMarks(!showCorpusStatusMarks)}
                >
                  <UiIcon name="check" size={13} />
                  <span>显示状态标记</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className={`ribbon-sm-btn ${activeCorpus.sidebarOpen ? 'ribbon-soft-active' : ''}`}
                  aria-pressed={activeCorpus.sidebarOpen}
                  title="展开或收起左侧词条列表栏"
                  onClick={() => toggleCorpusSidebar()}
                >
                  <CorpusSidebarToggleIcon collapsed={!activeCorpus.sidebarOpen} size={13} />
                  <span>左侧词条栏</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">批量设置</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <div className="ribbon-stack">
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn"
                  disabled={!resolvedCorpusCanPrev || !onCorpusPrev}
                  title="切换至上一条词条 (Alt+[)"
                  onClick={() => onCorpusPrev?.()}
                >
                  <CorpusPrevIcon size={13} />
                  <span>上一条词条</span>
                </button>
              </div>
              <div className="ribbon-row">
                <button
                  type="button"
                  className="ribbon-sm-btn"
                  disabled={!resolvedCorpusCanNext || !onCorpusNext}
                  title="切换至下一条词条 (Alt+])"
                  onClick={() => onCorpusNext?.()}
                >
                  <CorpusNextIcon size={13} />
                  <span>下一条词条</span>
                </button>
              </div>
            </div>
          </div>
          <div className="ribbon-group-label">导航</div>
        </div>

        <div className="ribbon-group">
          <div className="ribbon-group-body">
            <button
              type="button"
              className="ribbon-big-btn"
              disabled={!canExportZip || exportingCorpusZip}
              title={zipTitle}
              onClick={() => onExportCorpusZip?.()}
            >
              <CorpusExportZipIcon size={22} />
              <span>
                {exportingCorpusZip
                  ? '正在打包…'
                  : activeCorpus.writable
                    ? '已自动保存'
                    : '导出修改 (.zip)'}
              </span>
            </button>
          </div>
          <div className="ribbon-group-label">导出</div>
        </div>
      </>
    );
  };

  return (
    <div className="ribbon-bar" ref={ribbonBarRef}>
      {/* Row 1: 28px Underline Ribbon Tab Row + Right Pinned Global Controls */}
      <div className="ribbon-tabrow">
        <div
          className="ribbon-tabs ipa-ctrl-noblur"
          role="tablist"
          aria-label="功能页签"
          onMouseDown={preventBlur}
        >
          {BASE_TABS.map((tab) => {
            const isActive = effectiveTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`ribbon-tab ${isActive ? 'is-active' : ''}`}
                title="点击切换页签，双击当前页签可收起或展开工具区"
                onClick={() => handleTabClick(tab.id)}
                onDoubleClick={() => handleTabDoubleClick(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
          {isCorpus && (
            <button
              type="button"
              role="tab"
              aria-selected={effectiveTab === 'corpus'}
              className={`ribbon-tab is-contextual ${effectiveTab === 'corpus' ? 'is-active' : ''}`}
              title="文件夹批量标注设置与导航（双击可收起或展开工具区）"
              onClick={() => handleTabClick('corpus')}
              onDoubleClick={() => handleTabDoubleClick('corpus')}
            >
              词表
            </button>
          )}
        </div>

        <div className="ribbon-right-pin">
          <button
            type="button"
            className="ribbon-pin-btn ipa-ctrl-noblur"
            title={undoTitle}
            disabled={!canUndo}
            onMouseDown={preventBlur}
            onClick={undo}
          >
            <UiIcon name="undo" size={13} />
            <span className="ribbon-pin-label">撤销</span>
          </button>
          <button
            type="button"
            className="ribbon-pin-btn ipa-ctrl-noblur"
            title={redoTitle}
            disabled={!canRedo}
            onMouseDown={preventBlur}
            onClick={redo}
          >
            <UiIcon name="redo" size={13} />
            <span className="ribbon-pin-label">重做</span>
          </button>

          <span className="ribbon-pin-sep" aria-hidden="true" />

          <div
            className="ribbon-mode-seg ipa-ctrl-noblur"
            role="group"
            aria-label="浏览与编辑模式"
            onMouseDown={preventBlur}
          >
            <button
              type="button"
              className={mode === 'read' ? 'is-active' : ''}
              aria-pressed={mode === 'read'}
              title="只读浏览模式"
              onClick={() => setMode('read')}
            >
              <UiIcon name="readMode" size={12} />
              <span>只读</span>
            </button>
            <button
              type="button"
              className={mode === 'edit' ? 'is-active' : ''}
              aria-pressed={mode === 'edit'}
              title="编辑标注模式 (E)"
              onClick={() => setMode('edit')}
            >
              <UiIcon name="edit" size={12} />
              <span>编辑</span>
            </button>
          </div>

          <span className="ribbon-pin-sep" aria-hidden="true" />

          <div className={`menu-wrap ribbon-export-wrap ${openMenu === 'export' ? 'open' : ''}`}>
            <button
              type="button"
              className="ribbon-export-btn ribbon-ink-primary"
              aria-expanded={openMenu === 'export'}
              onClick={() => setOpenMenu(openMenu === 'export' ? null : 'export')}
            >
              <span className="btn-lead">
                <UiIcon name="export" size={13} />
                <span>导出与保存</span>
              </span>
              <ChevronIcon size={10} />
            </button>
            <div className="dropdown">
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('save');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>
                    {isDesktop && !currentFilePath ? '保存 (.TextGrid)…' : '保存 (.TextGrid)'}
                  </span>
                </span>
                {saveFileHint && <span className="shortcut">{saveFileHint}</span>}
              </button>
              {isDesktop && (
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenu(null);
                    onExportAction('save-as');
                  }}
                >
                  <span className="btn-lead">
                    <UiIcon name="saveAs" size={13} />
                    <span>另存为…</span>
                  </span>
                  {saveAsHint && <span className="shortcut">{saveAsHint}</span>}
                </button>
              )}
              <div className="menu-divider" />
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('svg');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="exportSvg" size={13} />
                  <span>导出矢量图 (.svg)</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('png');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="exportPng" size={13} />
                  <span>导出高清图片 (.png)</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('dialog');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="export" size={13} />
                  <span>自定义导出图像…</span>
                </span>
                {exportFigureHint && <span className="shortcut">{exportFigureHint}</span>}
              </button>
              <div className="menu-divider" />
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('poster');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="exportSvg" size={13} />
                  <span>导出声纹海报…</span>
                </span>
              </button>
              <div className="menu-divider" />
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('long');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>保存标准文本 (.TextGrid)</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('short');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>保存短文本 (.TextGrid)</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('binary');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>保存二进制 (.TextGrid)</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('chrono');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="save" size={13} />
                  <span>保存按时间排序文本</span>
                </span>
              </button>
              <div className="menu-divider" />
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('col-bin');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="fileCollection" size={13} />
                  <span>保存集合 (.Collection 二进制)</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  onExportAction('col-text');
                }}
              >
                <span className="btn-lead">
                  <UiIcon name="fileCollection" size={13} />
                  <span>保存集合 (.Collection 文本)</span>
                </span>
              </button>
            </div>
          </div>

          <button
            type="button"
            className={`ribbon-collapse-btn ipa-ctrl-noblur ${ribbonCollapsed ? 'is-collapsed' : ''}`}
            aria-expanded={!ribbonCollapsed}
            title={ribbonCollapsed ? '展开工具区' : '收起工具区'}
            aria-label={ribbonCollapsed ? '展开工具区' : '收起工具区'}
            onMouseDown={preventBlur}
            onClick={toggleRibbonCollapsed}
          >
            <ChevronIcon size={11} />
          </button>
        </div>
      </div>

      {/* Row 2: 74px Classic Tiered Ribbon Panel */}
      <div className={`ribbon-panel-shell ${ribbonCollapsed ? 'is-collapsed' : ''}`}>
        <div
          ref={panelRef}
          className="ribbon-panel"
          role="toolbar"
          aria-label="当前页签工具区"
          onScroll={() => {
            if (openMenu === 'samples' || openMenu === 'col') {
              setOpenMenu(null);
            }
          }}
        >
          {effectiveTab === 'file' && renderFileTab()}
          {effectiveTab === 'annotate' && renderAnnotateTab()}
          {effectiveTab === 'tiers' && renderTiersTab()}
          {effectiveTab === 'view' && renderViewTab()}
          {effectiveTab === 'tools' && renderToolsTab()}
          {effectiveTab === 'corpus' && renderCorpusTab()}
        </div>
      </div>

      {/* Detached Popout Menus (mounted outside scrollable .ribbon-panel so they never clip) */}
      {openMenu === 'samples' && popoutPos && (
        <div
          className="ribbon-popout-menu"
          role="menu"
          style={{ left: popoutPos.left, top: popoutPos.top }}
        >
          <button
            type="button"
            onClick={() => {
              setOpenMenu(null);
              onLoadSample('dialogue');
            }}
          >
            <span className="btn-lead">
              <UiIcon name="waveform" size={13} />
              <span>双人对话与声谱（含录音）</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpenMenu(null);
              onLoadSample('corpus');
            }}
          >
            <span className="btn-lead">
              <CorpusFolderIcon size={13} />
              <span>文件夹批量标注示例（5 条）</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpenMenu(null);
              onLoadSample('poem');
            }}
          >
            <span className="btn-lead">
              <UiIcon name="samples" size={13} />
              <span>普通话与音标示例</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpenMenu(null);
              onLoadSample('edge');
            }}
          >
            <span className="btn-lead">
              <UiIcon name="samples" size={13} />
              <span>完整字符与边界示例</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpenMenu(null);
              onLoadSample('wild');
            }}
          >
            <span className="btn-lead">
              <UiIcon name="samples" size={13} />
              <span>长停顿与特殊结构示例</span>
            </span>
          </button>
          <div className="menu-divider" />
          <button
            type="button"
            onClick={() => {
              setOpenMenu(null);
              onLoadSample('blank');
            }}
          >
            <span className="btn-lead">
              <UiIcon name="tab-add" size={13} />
              <span>新建空白文件</span>
            </span>
            <span className="shortcut">{formatKeyCombo('Mod+T')}</span>
          </button>
        </div>
      )}

      {openMenu === 'col' && popoutPos && collectionTgs.length > 1 && (
        <div
          className="ribbon-popout-menu"
          role="menu"
          style={{ left: popoutPos.left, top: popoutPos.top }}
        >
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
      )}
    </div>
  );
};
