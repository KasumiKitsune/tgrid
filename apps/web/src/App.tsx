import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getPlatformBridge,
  isTauriRuntime,
  type AudioAnalysisSummary,
  type CollectionItem,
  type TextGrid,
  type TextGridFormat
} from './bridge/PlatformBridge';
import { AudioPlayer, decodeAudioPure } from './audio/AudioPlayer';
import { detectSpeechSegmentsAsync } from './audio/vad';
import {
  deleteTabAudioBuffer,
  getTabAudioBuffer,
  setTabAudioBuffer
} from './audio/tabAudioStore';
import { corpusAudioCache } from './corpus/audioCache';
import {
  buildTextGridFromTemplate,
  composeCorpusStyleDocument,
  extractIpaPreview,
  extractItemStyleOverrides,
  extractSharedStyle,
  findPreferredSpeechIntervalIndex,
  parseProjectFile,
  reconcileProjectWithScan,
  serializeProjectFile,
  sniffTierTemplateFromTextGrid
} from './corpus/projectCodec';
import {
  CORPUS_PROJECT_FILENAME,
  type CorpusAudioCacheEntry,
  type CorpusFileFingerprint,
  type CorpusItemRecord,
  type CorpusItemStatus,
  type CorpusProjectState
} from './corpus/types';
import {
  corpusDraftManager,
  hasExternalFileConflict,
  type CorpusItemDraft
} from './corpus/draftManager';
import {
  deleteItemDraftRecovery,
  deleteProjectRecovery,
  getOriginalSnapshot,
  isRecoveryStorageDegraded,
  listOriginalSnapshots,
  listRecoveryProjects,
  loadProjectRecovery,
  probeRecoveryStorage,
  pruneRecoveryStorage,
  saveItemDraftRecovery,
  saveOriginalSnapshotOnce,
  saveProjectRecoveryMeta,
  shouldSkipRecovery,
  type ProjectRecoveryBundle,
  type RecoveryProjectMetaDelta,
  type RecoveryProjectRecord
} from './corpus/recoveryStore';
import {
  buildCorpusZipFromEntries,
  createMemoryCorpusAdapter,
  createWebFallbackCorpusAdapter,
  createWebFsaCorpusAdapterFromHandle,
  disposeCorpusAdapter,
  getCorpusAdapter,
  isWebDirectoryPickerSupported,
  openTauriCorpusAdapter,
  openWebFsaCorpusAdapter,
  type CorpusWorkspaceAdapter,
  type CorpusZipOverrideEntry
} from './corpus/workspaceAdapter';
import { createCorpusSample, createSample, type BuiltinSampleId } from './data/samples';
import { prefetchTrigraphCache, resetFontMeasureCache } from './layout/richText';
import type { EditorSelection } from './render/renderScoreSvg';
import {
  buildExportZipBytes,
  getBaseStem,
  loadExportPrefs,
  renderOffscreenExport,
  renderOffscreenPngBlob,
  triggerBlobDownload
} from './render/exporter';
import { cloneTier } from './store/historyModel';
import {
  registerBeforeHistoryNavigate,
  useEditorStore,
  type PendingAutoEditTarget,
  type TabRecord
} from './store/useEditorStore';
import { resolveF0RangeOverride } from './utils/f0Range';
import { isComposingEvent, isEditableTarget, matchesShortcut } from './shortcuts/registry';
import { applyUiScaleToDom, stepCanvasScale, syncUiScaleViewportAttrs } from './utils/uiScale';
import {
  loadPersistedSession,
  savePersistedSession,
  type PersistedSessionTab
} from './utils/sessionPersistence';
import { Topbar, type ExportActionKind } from './components/Topbar';
import { RibbonContextProvider, type RibbonContextActions } from './components/RibbonBar';
import {
  SplitEqualModal,
  type SplitEqualConfirmPayload,
  type SplitEqualDialogState
} from './components/SplitEqualModal';
import { alignSplitBoundariesAcoustically } from './utils/acousticSplitClient';
import type {
  AcousticSegmentClass,
  SmartSplitGranularity
} from './utils/smartSplit';
import { TransportBar } from './components/TransportBar';
import { LegendDock } from './components/LegendDock';
import { CorpusSidebar, filterCorpusItems } from './components/CorpusSidebar';
import { CorpusNavBar } from './components/CorpusNavBar';
import { CorpusRecoveryBanner } from './components/CorpusRecoveryBanner';
import { CloseIcon, UiIcon } from './components/Icons';
import { ScoreStage, type ScoreStageHandle } from './components/ScoreStage';
import { RightSidebar, type RightSidebarHandle } from './components/sidebar/RightSidebar';
import { IpaDock } from './components/IpaDock';
import { ExportModal } from './components/ExportModal';
import { PosterModal } from './components/PosterModal';
import { prunePolarSpecCacheForSession } from './render/poster/polarSpectrogram';
import { AboutModal } from './components/AboutModal';
import { ShortcutsModal } from './components/ShortcutsModal';
import { PreferencesModal } from './components/PreferencesModal';
import { FindReplaceBar } from './components/FindReplaceBar';
import { StatusBar } from './components/StatusBar';
import {
  UnsavedDialog,
  type UnsavedCorpusDetail,
  type UnsavedDialogState,
  type UnsavedWindowTabEntry
} from './components/UnsavedDialog';
import {
  TabContextMenu,
  type TabContextMenuRequest
} from './components/TabContextMenu';
import {
  BulkDropModal,
  type BulkDropSelectionPayload
} from './components/BulkDropModal';
import { GlobalContextMenu } from './components/GlobalContextMenu';
import { Toast } from './components/Toast';
import {
  BULK_DROP_MAX_INDIVIDUAL_TABS,
  analyzeDropIntake,
  entriesFromDroppedPaths,
  entriesFromFiles,
  extractWebDropEntries,
  normalizeDropPathKey,
  splitFileStemAndExt,
  type DropDirectoryCandidate,
  type DropInputEntry,
  type DropIntakePlan,
  type DropOpenUnit
} from './utils/dropIntake';
import { hasAnyCustomStyle } from './style/palettes';
import { reconcileStyleDocument } from './style/reconcileStyle';
import {
  extractProjectFromSvgText,
  getStyleSidecarPath,
  parseStyleSidecar,
  serializeStyleSidecar
} from './style/styleCodec';
import type { ReconcileReport, StyleDocument } from './style/types';

interface IncomingFilePayload {
  name: string;
  bytes: Uint8Array;
  path?: string | null;
}

interface PendingCorpusRecoveryInfo {
  bundle: ProjectRecoveryBundle;
  externalModifiedCount: number;
}

interface CorpusConflictModalState {
  tabId: string;
  projectId: string;
  itemId: string;
  tgRelPath: string;
  itemLabel: string;
  tg: TextGrid;
  format: TextGridFormat;
  draftUpdatedAt?: number;
  statusOverride?: CorpusItemStatus;
}

interface CorpusConfirmModalState {
  title: string;
  description: string;
  detail?: string;
  confirmLabel: string;
  confirmTone?: 'primary' | 'danger';
  onConfirm: () => Promise<void> | void;
}

function hasRecoveryMetaDelta(project: RecoveryProjectRecord | null | undefined): boolean {
  const delta = project?.metaDelta;
  if (!delta) return false;
  return Boolean(
    (delta.itemMeta && Object.keys(delta.itemMeta).length > 0) ||
      (delta.tierTemplate && delta.tierTemplate.length > 0) ||
      delta.defaultSaveFormat
  );
}

function formatConflictStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const AUDIO_EXT_RE = /\.(wav|mp3|ogg|flac|m4a|aac|webm|opus)$/i;
const STYLE_SIDECAR_RE = /\.tgstyle\.json$/i;
const SVG_EXT_RE = /\.svg$/i;

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decodeUtf8(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function formatStyleReconcileNote(report: ReconcileReport): string {
  const parts: string[] = [];
  if (report.fuzzyMatches > 0) {
    parts.push(`自动对账找回 ${report.fuzzyMatches} 处微调标注`);
  }
  if (report.orphanedCount > 0) {
    parts.push(`${report.orphanedCount} 处失配样式已暂存`);
  }
  return parts.join('，');
}

function getPathBaseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function inferTextGridFormat(sourceFormat?: string): TextGridFormat {
  const s = (sourceFormat || '').toLowerCase();
  if (s.includes('bin')) return 'binary';
  if (s.includes('chrono')) return 'chronological';
  if (s.includes('short')) return 'shortText';
  return 'longText';
}

export function App() {
  const isDesktop = isTauriRuntime();

  const tgInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const corpusDirInputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<ScoreStageHandle>(null);
  const sidebarRef = useRef<RightSidebarHandle>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const dragDepthRef = useRef(0);
  const quickExportBusyRef = useRef(false);
  const audioLoadSeqRef = useRef<Map<string, number>>(new Map());
  const corpusLoadSeqRef = useRef<Map<string, number>>(new Map());
  const corpusPreloadTimerRef = useRef<number | null>(null);
  const corpusAutoSaveTimerRef = useRef<number | null>(null);
  const corpusRecoveryTimerRef = useRef<number | null>(null);
  const corpusProjectSaveTimersRef = useRef<Map<string, number>>(new Map());
  const corpusAudioInflightRef = useRef<Map<string, Promise<CorpusAudioCacheEntry | null>>>(new Map());
  const corpusDiskItemsRef = useRef<Map<string, Record<string, CorpusItemRecord>>>(new Map());
  const corpusBaseFpRef = useRef<
    Map<string, Map<string, { fingerprint: CorpusFileFingerprint | null; hadDiskTextGrid: boolean }>>
  >(new Map());
  const corpusSaveLockRef = useRef<Set<string>>(new Set());
  const corpusSnapshotSessionRef = useRef<Set<string>>(new Set());
  const sessionRestoredRef = useRef(false);
  const sessionSaveTimerRef = useRef<number | null>(null);

  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [unsavedDialog, setUnsavedDialog] = useState<UnsavedDialogState>(null);
  const [unsavedBusy, setUnsavedBusy] = useState(false);
  const [tabCtxMenu, setTabCtxMenu] = useState<TabContextMenuRequest | null>(null);
  const [bulkDropPlan, setBulkDropPlan] = useState<DropIntakePlan | null>(null);
  const [bulkDropBusy, setBulkDropBusy] = useState(false);
  const bulkDropPreloadedBytesRef = useRef<Map<string, Uint8Array>>(new Map());
  const [exportingCorpusZip, setExportingCorpusZip] = useState(false);
  const [splitModalState, setSplitModalState] = useState<SplitEqualDialogState | null>(null);
  const splitModalRunSeqRef = useRef(0);

  const [corpusSaveProgress, setCorpusSaveProgress] = useState<{ done: number; total: number } | null>(null);
  const [corpusPendingRecoveries, setCorpusPendingRecoveries] = useState<
    Record<string, PendingCorpusRecoveryInfo>
  >({});
  const [orphanRecoveryProjects, setOrphanRecoveryProjects] = useState<RecoveryProjectRecord[]>([]);
  const [corpusBackupTimes, setCorpusBackupTimes] = useState<Record<string, Record<string, number>>>({});
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [corpusConflictModal, setCorpusConflictModal] = useState<CorpusConflictModalState | null>(null);
  const [corpusConflictBusy, setCorpusConflictBusy] = useState(false);
  const [corpusConfirmModal, setCorpusConfirmModal] = useState<CorpusConfirmModalState | null>(null);
  const [corpusConfirmBusy, setCorpusConfirmBusy] = useState(false);

  const smartSplitUseAcoustic = useEditorStore((s) => s.smartSplitUseAcoustic);
  const setSmartSplitUseAcoustic = useEditorStore((s) => s.setSmartSplitUseAcoustic);
  const corpusAutoSave = useEditorStore((s) => s.corpusAutoSave);
  const setCorpusAutoSave = useEditorStore((s) => s.setCorpusAutoSave);

  const unsavedDialogRef = useRef<UnsavedDialogState>(null);
  unsavedDialogRef.current = unsavedDialog;
  const unsavedBusyRef = useRef(false);
  unsavedBusyRef.current = unsavedBusy;
  const tabCtxMenuRef = useRef<TabContextMenuRequest | null>(null);
  tabCtxMenuRef.current = tabCtxMenu;
  const bulkDropPlanRef = useRef<DropIntakePlan | null>(null);
  bulkDropPlanRef.current = bulkDropPlan;
  const bulkDropBusyRef = useRef(false);
  bulkDropBusyRef.current = bulkDropBusy;
  const corpusConflictModalRef = useRef<CorpusConflictModalState | null>(null);
  corpusConflictModalRef.current = corpusConflictModal;
  const corpusConfirmModalRef = useRef<CorpusConfirmModalState | null>(null);
  corpusConfirmModalRef.current = corpusConfirmModal;

  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const isDirty = useEditorStore((s) => s.isDirty);
  const docVersion = useEditorStore((s) => s.docVersion);
  const showCorpusStatusMarks = useEditorStore((s) => s.showCorpusStatusMarks);
  const restoreSessionOnStartup = useEditorStore((s) => s.restoreSessionOnStartup);
  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);
  const activeCorpus = activeTab?.kind === 'corpus' ? (activeTab.corpus ?? null) : null;

  const activeCorpusNav = useMemo(() => {
    if (!activeCorpus) return null;
    const filtered = filterCorpusItems(
      activeCorpus.items,
      activeCorpus.filter,
      !showCorpusStatusMarks
    );
    const list = filtered.length > 0 ? filtered : activeCorpus.items;
    const idx = activeCorpus.activeItemId
      ? list.findIndex((it) => it.id === activeCorpus.activeItemId)
      : -1;
    return {
      currentIndex: idx,
      totalCount: list.length,
      canPrev: idx > 0,
      canNext: list.length > 0 && (idx === -1 || idx < list.length - 1)
    };
  }, [activeCorpus, showCorpusStatusMarks]);

  const setDocument = useEditorStore((s) => s.setDocument);
  const markSaved = useEditorStore((s) => s.markSaved);
  const markTabSaved = useEditorStore((s) => s.markTabSaved);
  const setAudioMetaForTab = useEditorStore((s) => s.setAudioMetaForTab);
  const setPlaybackTime = useEditorStore((s) => s.setPlaybackTime);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const setRateStore = useEditorStore((s) => s.setRate);
  const setVolumeStore = useEditorStore((s) => s.setVolume);
  const setExportOpen = useEditorStore((s) => s.setExportOpen);
  const setPosterOpen = useEditorStore((s) => s.setPosterOpen);
  const setAboutOpen = useEditorStore((s) => s.setAboutOpen);
  const showToast = useEditorStore((s) => s.showToast);

  // Initialize Web Audio controller once (with persisted volume)
  if (!playerRef.current) {
    playerRef.current = new AudioPlayer(
      {
        onTimeUpdate: (t, showPlayhead) => setPlaybackTime(t, showPlayhead),
        onPlayingChange: (playing) => setPlaying(playing)
      },
      useEditorStore.getState().volume
    );
  }

  // Sync loop, rate, and volume settings from store into AudioPlayer
  const loop = useEditorStore((s) => s.loop);
  const rate = useEditorStore((s) => s.rate);
  const volume = useEditorStore((s) => s.volume);
  useEffect(() => {
    playerRef.current?.setLoop(loop);
  }, [loop]);
  useEffect(() => {
    playerRef.current?.setRate(rate);
  }, [rate]);
  useEffect(() => {
    playerRef.current?.setVolume(volume);
  }, [volume]);

  // Apply persisted global UI scale (75%–200%) & responsive logical viewport guards
  const uiScale = useEditorStore((s) => s.uiScale);
  useEffect(() => {
    applyUiScaleToDom(uiScale);
    const onResize = () => syncUiScaleViewportAttrs(uiScale);
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, [uiScale]);

  // Stop playback cleanly when switching between objects inside a Collection
  const collectionActiveIdx = useEditorStore((s) => s.collectionActiveIdx);
  useEffect(() => {
    playerRef.current?.stop(false);
  }, [collectionActiveIdx]);

  const makeRevealAction = useCallback(
    (savedPath: string) => ({
      label: '打开所在文件夹',
      onClick: () => {
        void getPlatformBridge()
          .revealInExplorer(savedPath)
          .catch(() => {
            useEditorStore.getState().showToast('无法打开所在文件夹', true);
          });
      }
    }),
    []
  );

  const flushActiveEdits = useCallback(() => {
    stageRef.current?.flushInlineEdit();
    sidebarRef.current?.flushDraft();
  }, []);

  useEffect(() => {
    registerBeforeHistoryNavigate(flushActiveEdits);
    return () => registerBeforeHistoryNavigate(null);
  }, [flushActiveEdits]);

  const releaseAudioSessionResources = useCallback((sessionId: number) => {
    stageRef.current?.pruneSpecCacheForSession(sessionId);
    prunePolarSpecCacheForSession(sessionId);
    void getPlatformBridge()
      .removeAudioSession(sessionId)
      .catch(() => {});
  }, []);

  useEffect(() => {
    corpusAudioCache.setOnEvict((sessionId) => {
      releaseAudioSessionResources(sessionId);
    });
    return () => {
      corpusAudioCache.setOnEvict(null);
    };
  }, [releaseAudioSessionResources]);

  useEffect(() => {
    const input = corpusDirInputRef.current;
    if (input) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    }
    return () => {
      if (corpusAutoSaveTimerRef.current !== null) {
        window.clearTimeout(corpusAutoSaveTimerRef.current);
      }
      if (corpusRecoveryTimerRef.current !== null) {
        window.clearTimeout(corpusRecoveryTimerRef.current);
      }
      if (corpusPreloadTimerRef.current !== null) {
        window.clearTimeout(corpusPreloadTimerRef.current);
      }
      for (const timer of corpusProjectSaveTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      corpusProjectSaveTimersRef.current.clear();
      if (sessionSaveTimerRef.current !== null) {
        window.clearTimeout(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }
    };
  }, []);

  const getItemBaseInfo = useCallback(
    (
      projectId: string,
      itemId: string
    ): { fingerprint: CorpusFileFingerprint | null; hadDiskTextGrid: boolean } => {
      const map = corpusBaseFpRef.current.get(projectId);
      const hit = map?.get(itemId);
      if (hit) return hit;
      const diskItem = corpusDiskItemsRef.current.get(projectId)?.[itemId];
      return {
        fingerprint: diskItem?.baseFingerprint ?? null,
        hadDiskTextGrid: Boolean(diskItem?.hasTextGrid)
      };
    },
    []
  );

  const setItemBaseInfo = useCallback(
    (
      projectId: string,
      itemId: string,
      fingerprint: CorpusFileFingerprint | null,
      hadDiskTextGrid: boolean
    ) => {
      let map = corpusBaseFpRef.current.get(projectId);
      if (!map) {
        map = new Map();
        corpusBaseFpRef.current.set(projectId, map);
      }
      map.set(itemId, { fingerprint, hadDiskTextGrid });
    },
    []
  );

  const syncCorpusUnsavedToStore = useCallback((tabId: string) => {
    const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
    const projectId = tab.corpus.projectId;
    const adapter = getCorpusAdapter(projectId);
    const unsavedItemIds = corpusDraftManager.getUnsavedItemIds(projectId);
    const projectIndexDirty = corpusDraftManager.isProjectIndexDirty(projectId);
    const dirtyCount = tab.corpus.writable
      ? unsavedItemIds.length
      : Math.max(unsavedItemIds.length, adapter?.getPendingExportCount() ?? 0);
    useEditorStore.getState().syncCorpusUnsavedState(
      {
        unsavedItemIds,
        projectIndexDirty,
        dirtyCount,
        recoveryDegraded: isRecoveryStorageDegraded()
      },
      tabId
    );
  }, []);

  const buildCorpusProjectMetaDelta = useCallback(
    (corpus: CorpusProjectState): RecoveryProjectMetaDelta | undefined => {
      const diskMap = corpusDiskItemsRef.current.get(corpus.projectId);
      const itemMeta: NonNullable<RecoveryProjectMetaDelta['itemMeta']> = {};
      if (diskMap) {
        for (const it of corpus.items) {
          const base = diskMap[it.id];
          if (!base) continue;
          if (base.status !== it.status || base.note !== it.note || base.ipaPreview !== it.ipaPreview) {
            itemMeta[it.id] = {
              status: it.status,
              note: it.note,
              ipaPreview: it.ipaPreview,
              label: it.label,
              updatedAt: it.updatedAt
            };
          }
        }
      }
      const hasItems = Object.keys(itemMeta).length > 0;
      if (!hasItems && !corpusDraftManager.isProjectIndexDirty(corpus.projectId)) {
        return undefined;
      }
      return {
        activeItemId: corpus.activeItemId,
        ...(hasItems ? { itemMeta } : {})
      };
    },
    []
  );

  const persistRecoveryForProjectMeta = useCallback(
    async (tabId: string) => {
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      const corpus = tab.corpus;
      if (shouldSkipRecovery(corpus.rootKey)) return;
      const adapter = getCorpusAdapter(corpus.projectId);
      const draftCount = corpusDraftManager.getDirtyCount(corpus.projectId);
      const metaDelta = buildCorpusProjectMetaDelta(corpus);
      if (draftCount === 0 && !metaDelta) {
        await deleteProjectRecovery(corpus.rootKey);
        return;
      }
      await saveProjectRecoveryMeta({
        projectKey: corpus.rootKey,
        projectName: corpus.projectName,
        mode: adapter?.mode ?? (corpus.writable ? 'tauri' : 'web-fallback'),
        nativeDirPath: adapter?.nativeDirPath,
        draftCount,
        metaDelta
      });
    },
    [buildCorpusProjectMetaDelta]
  );

  const syncActiveCorpusStyleToProject = useCallback((tabId: string): boolean => {
    const st = useEditorStore.getState();
    const tab = st.tabs.find((t) => t.id === tabId);
    const corpus = tab?.kind === 'corpus' ? tab.corpus : undefined;
    const itemId = corpus?.activeItemId ?? null;
    if (!tab || !corpus || !itemId) return false;

    const styleDoc = tabId === st.activeTabId ? st.styleDoc : tab.styleDoc;
    const nextShared = extractSharedStyle(styleDoc);
    const nextItemOv = extractItemStyleOverrides(styleDoc);
    const prevShared = corpus.sharedStyle;
    const prevItemStyles = corpus.itemStyles;
    const prevItemOv = prevItemStyles?.[itemId];

    const sharedChanged =
      JSON.stringify(prevShared ?? null) !== JSON.stringify(nextShared ?? null);
    const itemChanged =
      JSON.stringify(prevItemOv ?? null) !== JSON.stringify(nextItemOv ?? null);
    if (!sharedChanged && !itemChanged) return false;

    let nextItemStyles = prevItemStyles;
    if (itemChanged) {
      const copy = { ...(prevItemStyles ?? {}) };
      if (nextItemOv) {
        copy[itemId] = nextItemOv;
      } else {
        delete copy[itemId];
      }
      nextItemStyles = Object.keys(copy).length > 0 ? copy : undefined;
    }

    useEditorStore.getState().setCorpusStyleData(
      {
        sharedStyle: nextShared,
        itemStyles: nextItemStyles
      },
      tabId
    );
    corpusDraftManager.setProjectIndexDirty(corpus.projectId, true);
    return true;
  }, []);

  const stageCorpusItem = useCallback(
    (
      tabId: string,
      opts?: {
        forceStage?: boolean;
        statusOverride?: CorpusItemStatus;
        flushRecoveryNow?: boolean;
      }
    ): CorpusItemDraft | null => {
      syncActiveCorpusStyleToProject(tabId);
      const st = useEditorStore.getState();
      const tab = st.tabs.find((t) => t.id === tabId);
      const corpus = tab?.kind === 'corpus' ? tab.corpus : undefined;
      const itemId = corpus?.activeItemId ?? null;
      if (!tab || !corpus || !itemId) return null;
      const item = corpus.itemMap[itemId];
      if (!item || item.parseError) return null;

      const projectId = corpus.projectId;
      const tg = tabId === st.activeTabId ? st.tg : tab.tg;
      const isTgDirty = tabId === st.activeTabId ? st.isDirty : tab.isDirty;
      const existingDraft = corpusDraftManager.getDraft(projectId, itemId);
      const diskBaseItem = corpusDiskItemsRef.current.get(projectId)?.[itemId];
      const nextStatus = opts?.statusOverride ?? existingDraft?.statusOverride ?? item.status;
      const statusChanged = Boolean(diskBaseItem && nextStatus !== diskBaseItem.status);
      const noteChanged = Boolean(diskBaseItem && item.note !== diskBaseItem.note);
      const hasMetaOverride = statusChanged || noteChanged || Boolean(opts?.forceStage);

      const preview = extractIpaPreview(tg, corpus.options.targetTierIndex);
      if (
        item.ipaPreview !== preview ||
        (opts?.statusOverride !== undefined && opts.statusOverride !== item.status)
      ) {
        useEditorStore.getState().updateCorpusItemMeta(
          itemId,
          {
            ipaPreview: preview,
            ...(opts?.statusOverride !== undefined ? { status: opts.statusOverride } : {})
          },
          tabId
        );
      }

      if (!isTgDirty && !hasMetaOverride) {
        const hadDraft = corpusDraftManager.hasDraft(projectId, itemId);
        corpusDraftManager.syncDraftWithDirtyState(projectId, itemId, {
          isTgDirty: false,
          hasMetaOverride: false
        });
        syncCorpusUnsavedToStore(tabId);
        if (hadDraft && !shouldSkipRecovery(corpus.rootKey)) {
          void deleteItemDraftRecovery(corpus.rootKey, itemId);
        }
        return null;
      }

      const baseInfo = getItemBaseInfo(projectId, itemId);
      const draft: CorpusItemDraft = {
        itemId,
        tgRelPath: item.tgRelPath,
        tg,
        format: tab.currentFileFormat || corpus.defaultSaveFormat || 'longText',
        baseFingerprint: existingDraft?.baseFingerprint ?? baseInfo.fingerprint,
        hadDiskTextGrid: existingDraft?.hadDiskTextGrid ?? baseInfo.hadDiskTextGrid,
        ipaPreview: preview,
        statusOverride: statusChanged || opts?.statusOverride !== undefined ? nextStatus : undefined,
        noteOverride: noteChanged ? item.note : undefined,
        updatedAt: Date.now()
      };

      corpusDraftManager.setDraft(projectId, draft);
      syncCorpusUnsavedToStore(tabId);

      if (opts?.flushRecoveryNow && !shouldSkipRecovery(corpus.rootKey)) {
        const adapter = getCorpusAdapter(projectId);
        const latestCorpus = useEditorStore.getState().tabs.find((t) => t.id === tabId)?.corpus ?? corpus;
        void saveItemDraftRecovery(
          {
            projectKey: corpus.rootKey,
            itemId: draft.itemId,
            tgRelPath: draft.tgRelPath,
            tg: draft.tg,
            format: draft.format,
            baseFingerprint: draft.baseFingerprint,
            hadDiskTextGrid: draft.hadDiskTextGrid,
            ipaPreview: draft.ipaPreview,
            statusOverride: draft.statusOverride,
            noteOverride: draft.noteOverride,
            updatedAt: draft.updatedAt
          },
          {
            projectName: latestCorpus.projectName,
            mode: adapter?.mode ?? (latestCorpus.writable ? 'tauri' : 'web-fallback'),
            nativeDirPath: adapter?.nativeDirPath,
            metaDelta: buildCorpusProjectMetaDelta(latestCorpus)
          }
        );
      }

      return draft;
    },
    [
      buildCorpusProjectMetaDelta,
      getItemBaseInfo,
      syncActiveCorpusStyleToProject,
      syncCorpusUnsavedToStore
    ]
  );

  const flushAllPendingRecovery = useCallback(() => {
    if (corpusRecoveryTimerRef.current !== null) {
      window.clearTimeout(corpusRecoveryTimerRef.current);
      corpusRecoveryTimerRef.current = null;
    }
    const st = useEditorStore.getState();
    for (const tab of st.tabs) {
      if (tab.kind !== 'corpus' || !tab.corpus) continue;
      if (shouldSkipRecovery(tab.corpus.rootKey)) continue;
      if (tab.corpus.activeItemId) {
        stageCorpusItem(tab.id, { flushRecoveryNow: true });
      }
      if (corpusDraftManager.isProjectIndexDirty(tab.corpus.projectId)) {
        void persistRecoveryForProjectMeta(tab.id);
      }
    }
  }, [persistRecoveryForProjectMeta, stageCorpusItem]);

  const ensureOriginalSnapshotBackup = useCallback(
    async (
      corpus: CorpusProjectState,
      adapter: CorpusWorkspaceAdapter,
      itemId: string,
      tgRelPath: string,
      baseFingerprint: CorpusFileFingerprint | null
    ) => {
      if (shouldSkipRecovery(corpus.rootKey)) return;
      const sessionKey = `${corpus.rootKey}::${itemId}`;
      if (corpusSnapshotSessionRef.current.has(sessionKey)) return;
      corpusSnapshotSessionRef.current.add(sessionKey);
      try {
        const origBytes = await adapter.readFileIfExists(tgRelPath);
        if (!origBytes || origBytes.length === 0) return;
        const now = Date.now();
        const saved = await saveOriginalSnapshotOnce({
          projectKey: corpus.rootKey,
          itemId,
          tgRelPath,
          bytes: origBytes,
          fingerprint: baseFingerprint,
          updatedAt: now
        });
        if (saved) {
          setCorpusBackupTimes((prev) => ({
            ...prev,
            [corpus.projectId]: {
              ...(prev[corpus.projectId] ?? {}),
              [itemId]: now
            }
          }));
        }
      } catch {
        // 备份失败不阻塞写盘
      }
    },
    []
  );

  const persistDiskProjectIndex = useCallback(
    async (
      tabId: string,
      opts?: { commitAllMeta?: boolean }
    ): Promise<boolean> => {
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return true;
      const corpus = tab.corpus;
      if (!corpus.writable) return true;
      const adapter = getCorpusAdapter(corpus.projectId);
      if (!adapter) return false;

      const diskMap = corpusDiskItemsRef.current.get(corpus.projectId) ?? {};
      const unsavedIds = new Set(corpusDraftManager.getUnsavedItemIds(corpus.projectId));

      // 单条保存时只合并已落盘词条元数据；仍在暂存区的词条沿用磁盘基线元数据，避免索引与磁盘 TextGrid 脱节
      const mergedItems: CorpusItemRecord[] = corpus.items.map((item) => {
        if (!opts?.commitAllMeta && unsavedIds.has(item.id) && diskMap[item.id]) {
          return diskMap[item.id];
        }
        return item;
      });
      const mergedItemMap: Record<string, CorpusItemRecord> = {};
      for (const it of mergedItems) {
        mergedItemMap[it.id] = it;
      }

      try {
        const bytes = serializeProjectFile({
          ...corpus,
          items: mergedItems,
          itemMap: mergedItemMap
        });
        await adapter.writeFile(CORPUS_PROJECT_FILENAME, bytes);
        if (opts?.commitAllMeta) {
          corpusDiskItemsRef.current.set(corpus.projectId, mergedItemMap);
          corpusDraftManager.setProjectIndexDirty(corpus.projectId, false);
        }
        syncCorpusUnsavedToStore(tabId);
        return true;
      } catch (err) {
        useEditorStore
          .getState()
          .setCorpusSaveState(
            { saveStatus: 'error', lastSaveError: `索引写入失败：${String(err)}` },
            tabId
          );
        return false;
      }
    },
    [syncCorpusUnsavedToStore]
  );

  const writeCorpusItemToDisk = useCallback(
    async (
      tabId: string,
      params: {
        itemId: string;
        tg: TextGrid;
        format: TextGridFormat;
        tgRelPath: string;
        draftUpdatedAt?: number;
        statusOverride?: CorpusItemStatus;
        skipConflictCheck?: boolean;
        recordOriginalBackup?: boolean;
        writeProjectIndex?: boolean;
      }
    ): Promise<'saved' | 'conflict' | 'permission-denied' | 'error'> => {
      const st = useEditorStore.getState();
      const tab = st.tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return 'error';
      const corpus = tab.corpus;
      const item = corpus.itemMap[params.itemId];
      if (!item) return 'error';
      if (item.parseError) return 'error';

      const adapter = getCorpusAdapter(corpus.projectId);
      if (!adapter || !corpus.writable) return 'error';

      if (adapter.ensureWritePermission) {
        const granted = await adapter.ensureWritePermission();
        if (!granted) {
          useEditorStore.getState().setCorpusSaveState(
            { saveStatus: 'error', lastSaveError: '未获得文件夹写入权限' },
            tabId
          );
          return 'permission-denied';
        }
      }

      const baseInfo = getItemBaseInfo(corpus.projectId, params.itemId);
      const existingDraft = corpusDraftManager.getDraft(corpus.projectId, params.itemId);
      const baseFp = existingDraft?.baseFingerprint ?? baseInfo.fingerprint;
      const hadDisk = existingDraft?.hadDiskTextGrid ?? baseInfo.hadDiskTextGrid;

      if (!params.skipConflictCheck) {
        try {
          const curStat = await adapter.statFile(params.tgRelPath);
          if (hasExternalFileConflict(baseFp, curStat, hadDisk)) {
            return 'conflict';
          }
        } catch {
          // stat 失败时继续尝试保存
        }
      }

      if (params.recordOriginalBackup) {
        await ensureOriginalSnapshotBackup(corpus, adapter, params.itemId, params.tgRelPath, baseFp);
      }

      try {
        const bytes = await getPlatformBridge().serializeTextGrid(params.tg, params.format);
        await adapter.writeFile(params.tgRelPath, bytes);
        const newStat = await adapter.statFile(params.tgRelPath).catch(() => null);
        const nextFp: CorpusFileFingerprint | null =
          newStat && newStat.exists
            ? { size: newStat.size, modifiedMs: newStat.modifiedMs }
            : { size: bytes.byteLength, modifiedMs: Date.now() };
        setItemBaseInfo(corpus.projectId, params.itemId, nextFp, true);

        const now = Date.now();
        const preview = extractIpaPreview(params.tg, corpus.options.targetTierIndex);
        const nextStatus = params.statusOverride ?? existingDraft?.statusOverride ?? item.status;

        // 竞态保护：仅当内存当前 tg 仍与开始写盘时的快照一致时才清除草稿与脏标记
        const clearedDraft = corpusDraftManager.clearDraftIfUnchanged(
          corpus.projectId,
          params.itemId,
          params.tg,
          params.draftUpdatedAt
        );
        const stillHasNewerDraft = !clearedDraft && corpusDraftManager.hasDraft(corpus.projectId, params.itemId);

        const postSt = useEditorStore.getState();
        const postTab = postSt.tabs.find((t) => t.id === tabId);
        const postTg = tabId === postSt.activeTabId ? postSt.tg : postTab?.tg;
        if (postTab?.kind === 'corpus' && postTab.corpus?.activeItemId === params.itemId) {
          if (postTg === params.tg) {
            markTabSaved(tabId);
          }
        } else if (!stillHasNewerDraft) {
          useEditorStore.getState().markCorpusEntryHistorySaved(params.itemId, tabId);
        }

        const metaPatch = {
          hasTextGrid: true,
          ipaPreview: preview,
          status: nextStatus,
          updatedAt: now,
          baseFingerprint: nextFp ?? undefined,
          parseError: undefined
        };
        useEditorStore.getState().updateCorpusItemMeta(params.itemId, metaPatch, tabId);

        const diskMap = corpusDiskItemsRef.current.get(corpus.projectId) ?? {};
        const prevDiskItem = diskMap[params.itemId] ?? item;
        diskMap[params.itemId] = { ...prevDiskItem, ...metaPatch };
        corpusDiskItemsRef.current.set(corpus.projectId, diskMap);

        if (!stillHasNewerDraft && !shouldSkipRecovery(corpus.rootKey)) {
          await deleteItemDraftRecovery(corpus.rootKey, params.itemId);
        }

        if (params.writeProjectIndex !== false) {
          await persistDiskProjectIndex(tabId, {
            commitAllMeta: corpusDraftManager.getDirtyCount(corpus.projectId) === 0
          });
        }

        syncCorpusUnsavedToStore(tabId);
        useEditorStore.getState().setCorpusSaveState(
          { saveStatus: 'saved', lastSaveError: null },
          tabId
        );
        return 'saved';
      } catch (err) {
        const msg = String(err);
        useEditorStore
          .getState()
          .setCorpusSaveState({ saveStatus: 'error', lastSaveError: msg }, tabId);
        return 'error';
      }
    },
    [
      ensureOriginalSnapshotBackup,
      getItemBaseInfo,
      markTabSaved,
      persistDiskProjectIndex,
      setItemBaseInfo,
      syncCorpusUnsavedToStore
    ]
  );

  const saveAllCorpusEntriesRef = useRef<(tabId?: string) => Promise<boolean>>(async () => false);
  const handleExportCorpusZipRef = useRef<(tabId?: string) => Promise<boolean>>(async () => false);

  const saveCurrentCorpusEntry = useCallback(
    async (
      tabId?: string,
      opts?: { targetItemId?: string; skipConflictCheck?: boolean; silent?: boolean }
    ): Promise<boolean> => {
      const st0 = useEditorStore.getState();
      const targetTabId = tabId ?? st0.activeTabId;
      if (targetTabId === st0.activeTabId) {
        flushActiveEdits();
      }
      const st = useEditorStore.getState();
      const tab = st.tabs.find((t) => t.id === targetTabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return false;
      const corpus = tab.corpus;
      const itemId = opts?.targetItemId ?? corpus.activeItemId;
      if (!itemId) return false;
      const item = corpus.itemMap[itemId];
      if (!item) return false;

      if (item.parseError) {
        if (!opts?.silent) {
          showToast('原 .TextGrid 文件解析损坏，已禁止覆盖保存，请使用上方横幅另存或重建', true);
        }
        return false;
      }

      if (itemId === corpus.activeItemId) {
        stageCorpusItem(targetTabId, { flushRecoveryNow: true });
      }

      if (!corpus.writable) {
        if (!opts?.silent) {
          showToast('当前浏览器无法直接写回文件夹，修改已暂存，请点击「导出修改 (.zip)」保存成果');
        }
        return true;
      }

      const draft = corpusDraftManager.getDraft(corpus.projectId, itemId);
      const isActiveItem = itemId === corpus.activeItemId;
      const activeDirty = targetTabId === st.activeTabId ? st.isDirty : tab.isDirty;

      if (!draft && (!isActiveItem || !activeDirty)) {
        const otherUnsaved = corpusDraftManager.getDirtyCount(corpus.projectId);
        const indexDirty = corpusDraftManager.isProjectIndexDirty(corpus.projectId);
        if (!opts?.silent) {
          if (otherUnsaved > 0 || indexDirty) {
            showToast(
              otherUnsaved > 0
                ? `当前词条无更改，另有 ${otherUnsaved} 条待保存`
                : '当前词条无更改，项目状态待保存',
              false,
              {
                label: '保存全部',
                onClick: () => void saveAllCorpusEntriesRef.current(targetTabId)
              }
            );
          } else {
            showToast('当前词条已与磁盘同步');
          }
        }
        return true;
      }

      const tgToSave = draft ? draft.tg : targetTabId === st.activeTabId ? st.tg : tab.tg;
      const fmtToSave = draft
        ? draft.format
        : tab.currentFileFormat || corpus.defaultSaveFormat || 'longText';

      useEditorStore.getState().setCorpusSaveState({ saveStatus: 'saving', lastSaveError: null }, targetTabId);
      const outcome = await writeCorpusItemToDisk(targetTabId, {
        itemId,
        tg: tgToSave,
        format: fmtToSave,
        tgRelPath: item.tgRelPath,
        draftUpdatedAt: draft?.updatedAt,
        statusOverride: draft?.statusOverride,
        skipConflictCheck: opts?.skipConflictCheck,
        recordOriginalBackup: useEditorStore.getState().corpusAutoSave,
        writeProjectIndex: true
      });

      if (outcome === 'saved') {
        if (!opts?.silent) {
          showToast(`已保存 ${item.tgRelPath}`);
        }
        return true;
      }
      if (outcome === 'conflict') {
        useEditorStore.getState().setCorpusSaveState({ saveStatus: 'idle', lastSaveError: null }, targetTabId);
        setCorpusConflictModal({
          tabId: targetTabId,
          projectId: corpus.projectId,
          itemId,
          tgRelPath: item.tgRelPath,
          itemLabel: item.label || item.id,
          tg: tgToSave,
          format: fmtToSave,
          draftUpdatedAt: draft?.updatedAt,
          statusOverride: draft?.statusOverride
        });
        return false;
      }
      if (outcome === 'permission-denied') {
        if (!opts?.silent) {
          showToast('文件夹写入权限已失效，草稿已保留在本地，可先导出 (.zip) 备份', true, {
            label: '导出草稿 (.zip)',
            onClick: () => void handleExportCorpusZipRef.current(targetTabId)
          });
        }
        return false;
      }
      if (!opts?.silent) {
        const errText =
          useEditorStore.getState().tabs.find((t) => t.id === targetTabId)?.corpus?.lastSaveError ||
          '写入失败';
        showToast(`保存失败：${errText}`, true);
      }
      return false;
    },
    [flushActiveEdits, showToast, stageCorpusItem, writeCorpusItemToDisk]
  );

  const saveAllCorpusEntries = useCallback(
    async (tabId?: string, opts?: { silent?: boolean }): Promise<boolean> => {
      const st0 = useEditorStore.getState();
      const targetTabId = tabId ?? st0.activeTabId;
      if (targetTabId === st0.activeTabId) {
        flushActiveEdits();
      }
      const st = useEditorStore.getState();
      const tab = st.tabs.find((t) => t.id === targetTabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return false;
      const corpus = tab.corpus;
      const projectId = corpus.projectId;

      if (corpusSaveLockRef.current.has(projectId)) {
        return false;
      }

      if (corpus.activeItemId) {
        stageCorpusItem(targetTabId, { flushRecoveryNow: false });
      }

      if (!corpus.writable) {
        return handleExportCorpusZipRef.current(targetTabId);
      }

      const drafts = corpusDraftManager
        .getProjectDrafts(projectId)
        .filter((d) => !corpus.itemMap[d.itemId]?.parseError);
      const indexDirty = corpusDraftManager.isProjectIndexDirty(projectId);

      if (drafts.length === 0 && !indexDirty) {
        if (!opts?.silent) {
          showToast('全部词条已与磁盘同步');
        }
        return true;
      }

      const adapter = getCorpusAdapter(projectId);
      if (!adapter) return false;
      if (adapter.ensureWritePermission) {
        const granted = await adapter.ensureWritePermission();
        if (!granted) {
          showToast('文件夹写入权限已失效，全部草稿已保留在本地，可先导出 (.zip)', true, {
            label: '导出草稿 (.zip)',
            onClick: () => void handleExportCorpusZipRef.current(targetTabId)
          });
          return false;
        }
      }

      corpusSaveLockRef.current.add(projectId);
      useEditorStore.getState().setCorpusSaveState({ saveStatus: 'saving', lastSaveError: null }, targetTabId);
      setCorpusSaveProgress(drafts.length > 0 ? { done: 0, total: drafts.length } : null);

      let savedCount = 0;
      const failedLabels: string[] = [];
      let firstConflict: CorpusItemDraft | null = null;
      let permissionFailed = false;

      try {
        for (let i = 0; i < drafts.length; i++) {
          const d = drafts[i];
          setCorpusSaveProgress({ done: i + 1, total: drafts.length });
          const outcome = await writeCorpusItemToDisk(targetTabId, {
            itemId: d.itemId,
            tg: d.tg,
            format: d.format,
            tgRelPath: d.tgRelPath,
            draftUpdatedAt: d.updatedAt,
            statusOverride: d.statusOverride,
            recordOriginalBackup: useEditorStore.getState().corpusAutoSave,
            writeProjectIndex: false
          });
          if (outcome === 'saved') {
            savedCount += 1;
          } else if (outcome === 'permission-denied') {
            permissionFailed = true;
            failedLabels.push(corpus.itemMap[d.itemId]?.label || d.itemId);
            break;
          } else {
            if (outcome === 'conflict' && !firstConflict) {
              firstConflict = d;
            }
            failedLabels.push(corpus.itemMap[d.itemId]?.label || d.itemId);
          }
        }

        const remainingDrafts = corpusDraftManager.getDirtyCount(projectId);
        let indexOk = true;
        if (savedCount > 0 || indexDirty) {
          indexOk = await persistDiskProjectIndex(targetTabId, {
            commitAllMeta: remainingDrafts === 0
          });
        }

        if (remainingDrafts === 0 && indexOk) {
          if (!shouldSkipRecovery(corpus.rootKey)) {
            await deleteProjectRecovery(corpus.rootKey);
          }
          useEditorStore.getState().setCorpusSaveState({ saveStatus: 'saved', lastSaveError: null }, targetTabId);
          syncCorpusUnsavedToStore(targetTabId);
          if (!opts?.silent) {
            showToast(
              savedCount > 0 ? `已保存全部 ${savedCount} 条词条` : '已保存项目状态到文件夹'
            );
          }
          return true;
        }

        syncCorpusUnsavedToStore(targetTabId);
        if (permissionFailed) {
          showToast(
            `已保存 ${savedCount} 条，剩余词条因文件夹写权限失效未保存（草稿已保留）`,
            true,
            {
              label: '导出草稿 (.zip)',
              onClick: () => void handleExportCorpusZipRef.current(targetTabId)
            }
          );
          return false;
        }

        if (firstConflict && failedLabels.length === 1) {
          const cItem = corpus.itemMap[firstConflict.itemId];
          useEditorStore.getState().setCorpusSaveState({ saveStatus: 'idle', lastSaveError: null }, targetTabId);
          setCorpusConflictModal({
            tabId: targetTabId,
            projectId,
            itemId: firstConflict.itemId,
            tgRelPath: firstConflict.tgRelPath,
            itemLabel: cItem?.label || firstConflict.itemId,
            tg: firstConflict.tg,
            format: firstConflict.format,
            draftUpdatedAt: firstConflict.updatedAt,
            statusOverride: firstConflict.statusOverride
          });
          return false;
        }

        if (!opts?.silent) {
          const detail = failedLabels.slice(0, 3).join('、');
          showToast(
            `已保存 ${savedCount} 条，另有 ${failedLabels.length} 条未保存（${detail}${failedLabels.length > 3 ? ' 等' : ''}，草稿已保留）`,
            true
          );
        }
        return false;
      } finally {
        corpusSaveLockRef.current.delete(projectId);
        setCorpusSaveProgress(null);
      }
    },
    [
      flushActiveEdits,
      persistDiskProjectIndex,
      showToast,
      stageCorpusItem,
      syncCorpusUnsavedToStore,
      writeCorpusItemToDisk
    ]
  );

  saveAllCorpusEntriesRef.current = saveAllCorpusEntries;

  const loadCorpusAudioEntry = useCallback(
    async (
      projectId: string,
      adapter: CorpusWorkspaceAdapter,
      item: CorpusItemRecord
    ): Promise<CorpusAudioCacheEntry | null> => {
      const hit = corpusAudioCache.get(projectId, item.id);
      if (hit) return hit;

      const inflightKey = `${projectId}::${item.id}`;
      const existingPromise = corpusAudioInflightRef.current.get(inflightKey);
      if (existingPromise) return existingPromise;

      const task = (async (): Promise<CorpusAudioCacheEntry | null> => {
        const bytes = await adapter.readFile(item.audioRelPath);
        const ctx = playerRef.current!.ensureContext(false);
        const { buffer, mono } = await decodeAudioPure(ctx, bytes);
        const bridge = getPlatformBridge();
        const nativePath = adapter.resolveNativePath(item.audioRelPath);

        let analysis: AudioAnalysisSummary | null = null;
        if (nativePath && item.audioRelPath.toLowerCase().endsWith('.wav')) {
          try {
            analysis = await bridge.loadWavFileSession(nativePath, 0);
          } catch {
            analysis = null;
          }
        }
        if (!analysis) {
          analysis = await bridge.loadPcmSession(mono, buffer.sampleRate, 0);
        }

        if (!getCorpusAdapter(projectId)) {
          releaseAudioSessionResources(analysis.sessionId);
          return null;
        }

        return corpusAudioCache.set(projectId, item.id, { buffer, mono, analysis });
      })();

      corpusAudioInflightRef.current.set(inflightKey, task);
      try {
        return await task;
      } finally {
        corpusAudioInflightRef.current.delete(inflightKey);
      }
    },
    [releaseAudioSessionResources]
  );

  const syncPlayerForTab = useCallback((tabId: string) => {
    const st = useEditorStore.getState();
    const tab = st.tabs.find((t) => t.id === tabId);
    let buf = getTabAudioBuffer(tabId);
    if (!buf && tab?.kind === 'corpus' && tab.corpus?.activeItemId) {
      buf = corpusAudioCache.get(tab.corpus.projectId, tab.corpus.activeItemId)?.buffer ?? null;
      if (buf) setTabAudioBuffer(tabId, buf);
    }
    const offset = tab ? tab.audioOffset : 0;
    playerRef.current?.setBuffer(buf, offset);
    setAudioBuffer(buf);
  }, []);

  const switchCorpusEntry = useCallback(
    async (
      tabId: string,
      itemId: string,
      opts?: {
        autoFocus?: boolean;
        autoPlayOverride?: boolean;
        skipFlushPrev?: boolean;
        resetHistory?: boolean;
        ignoreDraft?: boolean;
      }
    ) => {
      if (corpusPreloadTimerRef.current !== null) {
        window.clearTimeout(corpusPreloadTimerRef.current);
        corpusPreloadTimerRef.current = null;
      }
      if (corpusAutoSaveTimerRef.current !== null) {
        window.clearTimeout(corpusAutoSaveTimerRef.current);
        corpusAutoSaveTimerRef.current = null;
      }
      if (corpusRecoveryTimerRef.current !== null) {
        window.clearTimeout(corpusRecoveryTimerRef.current);
        corpusRecoveryTimerRef.current = null;
      }

      // Prime AudioContext synchronously inside the user gesture for zero-latency playback
      playerRef.current?.ensureContext(true);

      const seq = (corpusLoadSeqRef.current.get(tabId) ?? 0) + 1;
      corpusLoadSeqRef.current.set(tabId, seq);

      // Mark switching BEFORE flushing the previous entry's inline editor so the
      // floating bar never flashes over the old entry during async file/audio loading.
      useEditorStore.getState().setCorpusSwitchingForTab(tabId, true);

      try {
      if (!opts?.skipFlushPrev) {
        const curSt = useEditorStore.getState();
        if (tabId === curSt.activeTabId) {
          flushActiveEdits();
        }
        const prevTab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
        if (prevTab?.kind === 'corpus' && prevTab.corpus?.activeItemId) {
          const staged = stageCorpusItem(tabId, { flushRecoveryNow: true });
          // 仅在用户主动开启自动保存且目录可写时，切词条才写回磁盘（覆写前留存 7 天原件备份）
          if (staged && useEditorStore.getState().corpusAutoSave && prevTab.corpus.writable) {
            const outcome = await writeCorpusItemToDisk(tabId, {
              itemId: staged.itemId,
              tg: staged.tg,
              format: staged.format,
              tgRelPath: staged.tgRelPath,
              draftUpdatedAt: staged.updatedAt,
              statusOverride: staged.statusOverride,
              recordOriginalBackup: true,
              writeProjectIndex: true
            });
            if (outcome === 'conflict') {
              showToast(`「${staged.tgRelPath}」被外部修改，已保留在待保存区，请手动核对保存`, true);
            }
          }
        }
      }

      if (corpusLoadSeqRef.current.get(tabId) !== seq) {
        return;
      }

      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      const corpus = tab.corpus;
      const item = corpus.itemMap[itemId];
      if (!item) return;
      if (item.missing) {
        showToast(`音频文件缺失：${item.audioRelPath}`, true);
        return;
      }

      const adapter = getCorpusAdapter(corpus.projectId);
      if (!adapter) return;
      const projectId = corpus.projectId;

      const hasAudio = Boolean(item.audioRelPath);
      let audioEntry: CorpusAudioCacheEntry | null = hasAudio
        ? corpusAudioCache.get(projectId, itemId) ?? null
        : null;
      if (hasAudio && !audioEntry) {
        useEditorStore.getState().setAudioLoadingForTab(tabId, true);
        try {
          audioEntry = await loadCorpusAudioEntry(projectId, adapter, item);
        } catch (err) {
          if (corpusLoadSeqRef.current.get(tabId) === seq) {
            useEditorStore.getState().setAudioLoadingForTab(tabId, false);
            showToast(`加载音频失败 (${item.audioRelPath})：${String(err)}`, true);
          }
          return;
        }
      }

      if (corpusLoadSeqRef.current.get(tabId) !== seq) {
        return;
      }
      if (hasAudio && !audioEntry) {
        return;
      }

      const bridge = getPlatformBridge();
      let tg: TextGrid | null = null;
      let fileFormat: TextGridFormat = corpus.defaultSaveFormat || 'longText';
      let hasTextGrid = item.hasTextGrid;
      let parseError: string | undefined = undefined;
      let loadedFromDraft = false;
      let baseFp: CorpusFileFingerprint | null = getItemBaseInfo(projectId, itemId).fingerprint;

      const existingDraft = opts?.ignoreDraft
        ? null
        : corpusDraftManager.getDraft(projectId, itemId);

      if (existingDraft) {
        tg = existingDraft.tg;
        fileFormat = existingDraft.format;
        hasTextGrid = existingDraft.hadDiskTextGrid || item.hasTextGrid;
        baseFp = existingDraft.baseFingerprint;
        loadedFromDraft = true;
      } else {
        let diskStat = { exists: false, size: 0, modifiedMs: 0 };
        try {
          diskStat = await adapter.statFile(item.tgRelPath);
          if (corpusLoadSeqRef.current.get(tabId) !== seq) return;
        } catch {
          diskStat = { exists: false, size: 0, modifiedMs: 0 };
        }

        let tgBytes: Uint8Array | null = null;
        try {
          tgBytes = await adapter.readFileIfExists(item.tgRelPath);
          if (corpusLoadSeqRef.current.get(tabId) !== seq) return;
        } catch (readErr) {
          if (diskStat.exists) {
            parseError = `无法读取原文件：${String(readErr)}`;
          }
        }

        const hadDiskFile = Boolean(diskStat.exists || (tgBytes && tgBytes.length > 0));
        baseFp = diskStat.exists
          ? { size: diskStat.size, modifiedMs: diskStat.modifiedMs }
          : tgBytes && tgBytes.length > 0
            ? { size: tgBytes.byteLength, modifiedMs: 0 }
            : null;
        setItemBaseInfo(projectId, itemId, baseFp, hadDiskFile);

        if (tgBytes && tgBytes.length > 0) {
          try {
            const parsed = await bridge.parsePraatFile(tgBytes, item.tgRelPath);
            if (corpusLoadSeqRef.current.get(tabId) !== seq) return;
            const foundTg = parsed.items.find(
              (it): it is Extract<CollectionItem, { type: 'TextGrid' }> => it.type === 'TextGrid'
            );
            if (foundTg) {
              tg = foundTg;
              fileFormat = inferTextGridFormat(parsed.sourceFormat);
              hasTextGrid = true;
            } else {
              // 磁盘原文件非空但不含有效 TextGrid 对象：进入只读告警状态，严禁静默覆盖
              parseError = '原文件中未检测到有效的 TextGrid 对象';
              hasTextGrid = true;
            }
          } catch (err) {
            // 磁盘已有 .TextGrid 解析损坏：进入只读告警状态，严禁静默用空模板覆盖原文件
            parseError = String(err instanceof Error ? err.message : err);
            hasTextGrid = true;
          }
        } else if (!parseError) {
          hasTextGrid = false;
        }
      }

      if (!tg) {
        const latestCorpus = useEditorStore.getState().tabs.find((t) => t.id === tabId)?.corpus ?? corpus;
        let vadBounds = null;
        if (!parseError && audioEntry && latestCorpus.options.autoVad) {
          try {
            vadBounds = await detectSpeechSegmentsAsync(
              audioEntry.mono,
              audioEntry.buffer.sampleRate,
              {
                snapZeroCrossing: (t) => bridge.findZeroCrossing(audioEntry!.analysis.sessionId, t, 0.015)
              }
            );
          } catch {
            vadBounds = null;
          }
          if (corpusLoadSeqRef.current.get(tabId) !== seq) return;
        }
        tg = buildTextGridFromTemplate(
          latestCorpus.tierTemplate,
          audioEntry ? audioEntry.buffer.duration : item.duration ?? 1.0,
          item.id,
          vadBounds
        );
        if (!parseError) {
          hasTextGrid = false;
        }
      }

      await prefetchTrigraphCache(tg, bridge);
      if (corpusLoadSeqRef.current.get(tabId) !== seq) return;

      const latestTab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!latestTab || latestTab.kind !== 'corpus' || !latestTab.corpus) return;
      const latestCorpus = latestTab.corpus;

      let targetTierIdx = latestCorpus.options.targetTierIndex;
      if (!tg.tiers[targetTierIdx] || tg.tiers[targetTierIdx].kind !== 'intervalTier') {
        const firstIntervalTier = tg.tiers.findIndex((t) => t.kind === 'intervalTier');
        targetTierIdx = firstIntervalTier >= 0 ? firstIntervalTier : 0;
      }

      const targetTier = tg.tiers[targetTierIdx];
      let selection: EditorSelection = null;
      let playRange: { start: number; end: number } | null = null;
      let pendingAutoEditTarget: PendingAutoEditTarget | null = null;

      if (targetTier && targetTier.kind === 'intervalTier' && targetTier.intervals.length > 0) {
        const ivIdx = findPreferredSpeechIntervalIndex(tg, targetTierIdx);
        const iv = targetTier.intervals[ivIdx] ?? targetTier.intervals[0];
        selection = { kind: 'interval', tierIndex: targetTierIdx, itemIndex: ivIdx };
        if (iv && iv.xmax > iv.xmin) {
          playRange = { start: iv.xmin, end: iv.xmax };
        }
        if (!parseError && opts?.autoFocus !== false) {
          pendingAutoEditTarget = {
            kind: 'interval',
            tierIndex: targetTierIdx,
            itemIndex: ivIdx,
            caretAtEnd: true
          };
        }
      }

      const ipaPreview = extractIpaPreview(tg, targetTierIdx);
      const tgNativePath = adapter.resolveNativePath(item.tgRelPath);
      const effectiveDuration = audioEntry
        ? audioEntry.buffer.duration
        : Math.max(0, tg.xmax - tg.xmin);

      if (audioEntry) {
        setTabAudioBuffer(tabId, audioEntry.buffer);
      } else {
        deleteTabAudioBuffer(tabId);
      }
      const composedCorpusStyle = composeCorpusStyleDocument(
        latestCorpus.sharedStyle,
        latestCorpus.itemStyles?.[itemId]
      );
      const { doc: reconciledCorpusStyle } = reconcileStyleDocument(composedCorpusStyle, tg);
      useEditorStore.getState().activateCorpusEntry({
        tabId,
        itemId,
        tg,
        styleDoc: reconciledCorpusStyle,
        filename: item.tgRelPath,
        currentFilePath: tgNativePath,
        currentFileFormat: fileFormat,
        selection,
        playRange,
        audioName: audioEntry ? item.audioRelPath : '',
        audioOffset: 0,
        audioDuration: audioEntry ? audioEntry.buffer.duration : 0,
        audioSampleRate: audioEntry ? audioEntry.buffer.sampleRate : 0,
        analysis: audioEntry ? audioEntry.analysis : null,
        loadSeq: seq,
        itemPatch: {
          hasTextGrid,
          ipaPreview,
          duration: effectiveDuration > 0 ? effectiveDuration : item.duration,
          parseError,
          baseFingerprint: baseFp ?? undefined
        },
        pendingAutoEditTarget,
        resetHistory: Boolean(opts?.resetHistory || parseError),
        initialDirty: loadedFromDraft
      });

      if (parseError) {
        useEditorStore.getState().setMode('read');
        showToast(`原文件解析损坏，已开启只读保护以防覆盖：${item.tgRelPath}`, true);
      }

      if (useEditorStore.getState().activeTabId === tabId) {
        if (audioEntry) {
          playerRef.current?.setBuffer(audioEntry.buffer, 0);
          setAudioBuffer(audioEntry.buffer);
          const shouldAutoPlay = opts?.autoPlayOverride ?? latestCorpus.options.autoPlay;
          if (shouldAutoPlay) {
            const pStart = playRange ? playRange.start : tg.xmin;
            const pEnd = playRange ? playRange.end : tg.xmax;
            if (pEnd > pStart) {
              playerRef.current?.start(pStart, pEnd);
            }
          }
        } else {
          playerRef.current?.clear();
          setAudioBuffer(null);
        }
      }

      // Staggered idle preload for N+1 and N-1
      corpusPreloadTimerRef.current = window.setTimeout(() => {
        corpusPreloadTimerRef.current = null;
        if (corpusLoadSeqRef.current.get(tabId) !== seq) return;
        const curTab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
        if (!curTab || curTab.kind !== 'corpus' || !curTab.corpus) return;
        const curAdapter = getCorpusAdapter(curTab.corpus.projectId);
        if (!curAdapter) return;

        const filtered = filterCorpusItems(
          curTab.corpus.items,
          curTab.corpus.filter,
          !useEditorStore.getState().showCorpusStatusMarks
        );
        const navList = filtered.length > 0 ? filtered : curTab.corpus.items;
        const idx = navList.findIndex((it) => it.id === itemId);
        if (idx === -1) return;

        const neighbors = [navList[idx + 1], navList[idx - 1]].filter(
          (n): n is CorpusItemRecord => Boolean(n && !n.missing && n.audioRelPath)
        );
        void (async () => {
          for (const neighbor of neighbors) {
            if (corpusLoadSeqRef.current.get(tabId) !== seq) return;
            if (corpusAudioCache.has(projectId, neighbor.id)) continue;
            try {
              await loadCorpusAudioEntry(projectId, curAdapter, neighbor);
            } catch {
              // 静默忽略预加载失败
            }
          }
        })();
      }, 80);
      } finally {
        if (corpusLoadSeqRef.current.get(tabId) === seq) {
          useEditorStore.getState().setCorpusSwitchingForTab(tabId, false);
        }
      }
    },
    [
      flushActiveEdits,
      getItemBaseInfo,
      loadCorpusAudioEntry,
      setItemBaseInfo,
      showToast,
      stageCorpusItem,
      writeCorpusItemToDisk
    ]
  );

  const handleSwitchTab = useCallback(
    (tabId: string) => {
      const st = useEditorStore.getState();
      if (tabId === st.activeTabId) return;
      flushActiveEdits();
      const prevTab = useEditorStore.getState().tabs.find((t) => t.id === st.activeTabId);
      if (prevTab?.kind === 'corpus' && prevTab.corpus) {
        const staged = stageCorpusItem(prevTab.id, { flushRecoveryNow: true });
        if (useEditorStore.getState().corpusAutoSave && prevTab.corpus.writable) {
          if (staged) {
            void writeCorpusItemToDisk(prevTab.id, {
              itemId: staged.itemId,
              tg: staged.tg,
              format: staged.format,
              tgRelPath: staged.tgRelPath,
              draftUpdatedAt: staged.updatedAt,
              statusOverride: staged.statusOverride,
              recordOriginalBackup: true,
              writeProjectIndex: true
            });
          } else if (corpusDraftManager.isProjectIndexDirty(prevTab.corpus.projectId)) {
            void persistDiskProjectIndex(prevTab.id, { commitAllMeta: true });
          }
        }
      }
      playerRef.current?.stop(false);
      useEditorStore.getState().switchTab(tabId);
      syncPlayerForTab(tabId);
    },
    [
      flushActiveEdits,
      persistDiskProjectIndex,
      stageCorpusItem,
      syncPlayerForTab,
      writeCorpusItemToDisk
    ]
  );

  const openCorpusWithAdapter = useCallback(
    async (
      adapter: CorpusWorkspaceAdapter,
      opts?: { preferredItemId?: string | null; silent?: boolean }
    ): Promise<string | null> => {
      try {
        const probe = await probeRecoveryStorage();
        const scan = await adapter.scan();

        // Web FSA 适配器在 scan() 后才会生成带 FNV-1a 指纹的最终 rootKey，因此先 scan 再去重
        const st = useEditorStore.getState();
        const existingTab = st.findCorpusTabByRootKey(adapter.rootKey);
        if (existingTab) {
          disposeCorpusAdapter(adapter.projectId);
          handleSwitchTab(existingTab.id);
          if (!opts?.silent) {
            showToast(`已切换至已打开的文件夹：${existingTab.corpus?.projectName ?? adapter.projectName}`);
          }
          return existingTab.id;
        }

        if (scan.audioFiles.length === 0 && scan.textGridFiles.length === 0) {
          disposeCorpusAdapter(adapter.projectId);
          if (!opts?.silent) {
            showToast('该文件夹中未找到音频或 TextGrid 文件', true);
          }
          return null;
        }

        let existingProject = null;
        if (scan.hasProjectFile) {
          const projBytes = await adapter.readFileIfExists(scan.projectFileRelPath);
          if (projBytes) {
            existingProject = parseProjectFile(projBytes);
          }
        }

        let sniffedTemplate = null;
        if (
          (!existingProject || existingProject.tierTemplate.length === 0) &&
          scan.textGridFiles.length > 0
        ) {
          try {
            const firstTgEntry = scan.textGridFiles[0];
            const firstTgBytes = await adapter.readFileIfExists(firstTgEntry.relPath);
            if (firstTgBytes) {
              const parsed = await getPlatformBridge().parsePraatFile(
                firstTgBytes,
                firstTgEntry.relPath
              );
              const firstTg = parsed.items.find(
                (it): it is Extract<CollectionItem, { type: 'TextGrid' }> => it.type === 'TextGrid'
              );
              if (firstTg) {
                sniffedTemplate = sniffTierTemplateFromTextGrid(firstTg);
              }
            }
          } catch {
            // 回退默认层模板
          }
        }

        const reconciled = reconcileProjectWithScan(scan, existingProject, sniffedTemplate);

        // 记录磁盘基线词条元数据（供单条保存索引合并与单条/批量还原使用）
        const diskBaselineMap: Record<string, CorpusItemRecord> = {};
        for (const it of reconciled.items) {
          diskBaselineMap[it.id] = { ...it };
        }
        corpusDiskItemsRef.current.set(adapter.projectId, diskBaselineMap);

        // 检测异常退出残留恢复草稿（非破坏性，绝不自动覆盖原文件）
        let pendingRecovery: PendingCorpusRecoveryInfo | null = null;
        if (!shouldSkipRecovery(adapter.rootKey)) {
          try {
            const bundle = await loadProjectRecovery(adapter.rootKey);
            if (bundle && (bundle.drafts.length > 0 || hasRecoveryMetaDelta(bundle.project))) {
              let externalModifiedCount = 0;
              for (const d of bundle.drafts) {
                try {
                  const curStat = await adapter.statFile(d.tgRelPath);
                  if (hasExternalFileConflict(d.baseFingerprint, curStat, d.hadDiskTextGrid)) {
                    externalModifiedCount += 1;
                  }
                } catch {
                  // ignore stat errors
                }
              }
              pendingRecovery = { bundle, externalModifiedCount };
            }
          } catch {
            pendingRecovery = null;
          }

          try {
            const snaps = await listOriginalSnapshots(adapter.rootKey);
            if (snaps.length > 0) {
              const map: Record<string, number> = {};
              for (const snap of snaps) {
                map[snap.itemId] = snap.updatedAt;
              }
              setCorpusBackupTimes((prev) => ({ ...prev, [adapter.projectId]: map }));
            }
          } catch {
            // ignore snapshot listing errors
          }
        }

        const corpusState: CorpusProjectState = {
          projectId: adapter.projectId,
          rootKey: adapter.rootKey,
          projectName: reconciled.projectName,
          writable: adapter.writable,
          readOnlyReason: adapter.readOnlyReason,
          defaultSaveFormat: reconciled.defaultSaveFormat,
          tierTemplate: reconciled.tierTemplate,
          items: reconciled.items,
          itemMap: reconciled.itemMap,
          activeItemId: null,
          filter: { query: '', status: 'all' },
          options: reconciled.options,
          sidebarOpen: true,
          sidebarWidth: 272,
          dirtyCount: adapter.getPendingExportCount(),
          unsavedItemIds: [],
          projectIndexDirty: false,
          recoveryDegraded: probe.degraded,
          pendingRecoveryCount: pendingRecovery ? pendingRecovery.bundle.drafts.length : 0,
          loadSeq: 0,
          saveStatus: 'idle',
          lastSaveError: null,
          wordListMeta: reconciled.wordListMeta,
          ...(reconciled.sharedStyle ? { sharedStyle: reconciled.sharedStyle } : {}),
          ...(reconciled.itemStyles ? { itemStyles: reconciled.itemStyles } : {})
        };

        flushActiveEdits();
        playerRef.current?.stop(false);
        const tabId = useEditorStore.getState().openCorpusTab(corpusState, { activate: true });

        if (pendingRecovery) {
          setCorpusPendingRecoveries((prev) => ({
            ...prev,
            [adapter.projectId]: pendingRecovery!
          }));
          setOrphanRecoveryProjects((prev) => prev.filter((p) => p.projectKey !== adapter.rootKey));
        }

        // 打开文件夹仅浏览，严禁静默创建 .tgrid-project.json

        const preferredItem = opts?.preferredItemId
          ? reconciled.itemMap[opts.preferredItemId]
          : null;
        const initialItemId =
          preferredItem && !preferredItem.missing ? preferredItem.id : reconciled.activeItemId;

        if (initialItemId) {
          await switchCorpusEntry(tabId, initialItemId, {
            autoFocus: !opts?.silent,
            autoPlayOverride: opts?.silent ? false : undefined,
            skipFlushPrev: true
          });
        }

        if (!opts?.silent) {
          const doneCount = reconciled.items.filter((it) => it.status === 'done').length;
          showToast(
            `已打开文件夹：${reconciled.projectName}（已完成 ${doneCount} / 共 ${reconciled.items.length} 条）`
          );
        }
        return tabId;
      } catch (err) {
        disposeCorpusAdapter(adapter.projectId);
        corpusDiskItemsRef.current.delete(adapter.projectId);
        corpusBaseFpRef.current.delete(adapter.projectId);
        if (!opts?.silent) {
          showToast(`打开文件夹失败：${String(err)}`, true);
        }
        return null;
      }
    },
    [flushActiveEdits, handleSwitchTab, showToast, switchCorpusEntry]
  );

  const handleOpenCorpusFolder = useCallback(async () => {
    try {
      if (isDesktop) {
        const adapter = await openTauriCorpusAdapter(getPlatformBridge());
        if (adapter) {
          await openCorpusWithAdapter(adapter);
        }
        return;
      }
      if (isWebDirectoryPickerSupported()) {
        const adapter = await openWebFsaCorpusAdapter();
        if (adapter) {
          await openCorpusWithAdapter(adapter);
        }
        return;
      }
      const input = corpusDirInputRef.current;
      if (input) {
        input.setAttribute('webkitdirectory', '');
        input.setAttribute('directory', '');
        input.click();
      }
    } catch (err) {
      showToast(`打开文件夹失败：${String(err)}`, true);
    }
  }, [isDesktop, openCorpusWithAdapter, showToast]);

  const clearExportedCorpusDrafts = useCallback(
    async (tabId: string) => {
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      const corpus = tab.corpus;
      const adapter = getCorpusAdapter(corpus.projectId);
      corpusDraftManager.clearProject(corpus.projectId);
      if (!shouldSkipRecovery(corpus.rootKey)) {
        await deleteProjectRecovery(corpus.rootKey);
      }
      if (adapter?.clearPendingExports) {
        await adapter.clearPendingExports();
      }
      if (corpus.activeItemId) {
        markTabSaved(tabId);
      }
      for (const it of corpus.items) {
        useEditorStore.getState().markCorpusEntryHistorySaved(it.id, tabId);
      }
      syncCorpusUnsavedToStore(tabId);
      showToast('已清空已导出的本地暂存');
    },
    [markTabSaved, showToast, syncCorpusUnsavedToStore]
  );

  const handleExportCorpusZip = useCallback(
    async (tabId?: string): Promise<boolean> => {
      const st = useEditorStore.getState();
      const targetTabId = tabId ?? st.activeTabId;
      const tab = st.tabs.find((t) => t.id === targetTabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return false;
      const corpus = tab.corpus;
      const adapter = getCorpusAdapter(corpus.projectId);
      if (!adapter) return false;

      setExportingCorpusZip(true);
      try {
        if (targetTabId === st.activeTabId) {
          flushActiveEdits();
        }
        if (corpus.activeItemId) {
          stageCorpusItem(targetTabId, { flushRecoveryNow: true });
        }

        const latestTab = useEditorStore.getState().tabs.find((t) => t.id === targetTabId);
        const latestCorpus = latestTab?.kind === 'corpus' ? latestTab.corpus : corpus;
        const bridge = getPlatformBridge();
        const drafts = corpusDraftManager.getProjectDrafts(corpus.projectId);
        const overrides: CorpusZipOverrideEntry[] = [];

        for (const d of drafts) {
          const bytes = await bridge.serializeTextGrid(d.tg, d.format);
          overrides.push({ relPath: d.tgRelPath, bytes });
        }

        if (latestCorpus && (overrides.length > 0 || corpusDraftManager.isProjectIndexDirty(corpus.projectId))) {
          overrides.push({
            relPath: CORPUS_PROJECT_FILENAME,
            bytes: serializeProjectFile(latestCorpus)
          });
        }

        const { bytes, fileCount } = await adapter.exportModifiedZip(bridge, overrides);
        if (fileCount === 0) {
          showToast('当前没有可导出的修改文件');
          return true;
        }
        const zipName = `${corpus.projectName || 'corpus'}_modified.zip`;
        triggerBlobDownload(new Blob([bytes as BlobPart], { type: 'application/zip' }), zipName);
        if (!corpus.writable) {
          showToast(`已导出修改包 ${zipName}（含 ${fileCount} 个文件）`, false, {
            label: '清空已导出暂存',
            onClick: () => void clearExportedCorpusDrafts(targetTabId)
          });
        } else {
          showToast(`已导出草稿备份包 ${zipName}（含 ${fileCount} 个文件）`);
        }
        return true;
      } catch (err) {
        showToast(`导出修改包失败：${String(err)}`, true);
        return false;
      } finally {
        setExportingCorpusZip(false);
      }
    },
    [clearExportedCorpusDrafts, flushActiveEdits, showToast, stageCorpusItem]
  );

  handleExportCorpusZipRef.current = handleExportCorpusZip;

  const executeRevertCorpusEntryToDisk = useCallback(
    async (tabId: string, itemId: string) => {
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      const corpus = tab.corpus;
      const projectId = corpus.projectId;
      const item = corpus.itemMap[itemId];
      if (!item) return;

      corpusDraftManager.deleteDraft(projectId, itemId);
      if (!shouldSkipRecovery(corpus.rootKey)) {
        await deleteItemDraftRecovery(corpus.rootKey, itemId);
      }

      const diskItem = corpusDiskItemsRef.current.get(projectId)?.[itemId];
      if (diskItem) {
        useEditorStore.getState().updateCorpusItemMeta(
          itemId,
          {
            status: diskItem.status,
            ipaPreview: diskItem.ipaPreview,
            note: diskItem.note,
            hasTextGrid: diskItem.hasTextGrid,
            updatedAt: diskItem.updatedAt,
            parseError: undefined
          },
          tabId
        );
      }
      useEditorStore.getState().clearCorpusEntryHistory(itemId, tabId);
      syncCorpusUnsavedToStore(tabId);

      if (corpus.activeItemId === itemId) {
        await switchCorpusEntry(tabId, itemId, {
          autoFocus: false,
          autoPlayOverride: false,
          skipFlushPrev: true,
          resetHistory: true,
          ignoreDraft: true
        });
      }
      showToast(`已还原为磁盘原文件：${item.label || item.id}`);
    },
    [showToast, switchCorpusEntry, syncCorpusUnsavedToStore]
  );

  const revertCorpusEntryToDisk = useCallback(
    (tabId: string, itemId: string) => {
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      const item = tab.corpus.itemMap[itemId];
      if (!item) return;
      setCorpusConfirmModal({
        title: '还原为磁盘原文件',
        description: `确定放弃「${item.label || item.id}」的未保存修改，并重新读取磁盘原文件吗？未保存的更改将被清空。`,
        detail: item.tgRelPath,
        confirmLabel: '确认还原',
        confirmTone: 'danger',
        onConfirm: () => executeRevertCorpusEntryToDisk(tabId, itemId)
      });
    },
    [executeRevertCorpusEntryToDisk]
  );

  const executeDiscardAllCorpusDrafts = useCallback(
    async (tabId: string) => {
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      const corpus = tab.corpus;
      const projectId = corpus.projectId;
      const activeId = corpus.activeItemId;

      corpusDraftManager.clearProject(projectId);
      if (!shouldSkipRecovery(corpus.rootKey)) {
        await deleteProjectRecovery(corpus.rootKey);
      }

      const diskMap = corpusDiskItemsRef.current.get(projectId);
      if (diskMap) {
        for (const it of corpus.items) {
          const base = diskMap[it.id];
          if (base) {
            useEditorStore.getState().updateCorpusItemMeta(
              it.id,
              {
                status: base.status,
                ipaPreview: base.ipaPreview,
                note: base.note,
                hasTextGrid: base.hasTextGrid,
                updatedAt: base.updatedAt
              },
              tabId
            );
          }
          useEditorStore.getState().clearCorpusEntryHistory(it.id, tabId);
        }
      }
      syncCorpusUnsavedToStore(tabId);

      if (activeId) {
        await switchCorpusEntry(tabId, activeId, {
          autoFocus: false,
          autoPlayOverride: false,
          skipFlushPrev: true,
          resetHistory: true,
          ignoreDraft: true
        });
      }
      showToast('已放弃全部未保存修改');
    },
    [showToast, switchCorpusEntry, syncCorpusUnsavedToStore]
  );

  const discardAllCorpusDrafts = useCallback(
    (tabId: string) => {
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      const count = Math.max(
        corpusDraftManager.getDirtyCount(tab.corpus.projectId),
        tab.isDirty ? 1 : 0
      );
      setCorpusConfirmModal({
        title: '放弃全部未保存修改',
        description: `确定放弃「${tab.corpus.projectName}」中的全部 ${count} 条未保存修改吗？本地暂存与恢复草稿将被清空，原文件夹不受影响。`,
        confirmLabel: '放弃全部',
        confirmTone: 'danger',
        onConfirm: () => executeDiscardAllCorpusDrafts(tabId)
      });
    },
    [executeDiscardAllCorpusDrafts]
  );

  const restoreOriginalSnapshot = useCallback(
    async (tabId: string, itemId: string) => {
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      const corpus = tab.corpus;
      const item = corpus.itemMap[itemId];
      if (!item) return;

      const snap = await getOriginalSnapshot(corpus.rootKey, itemId);
      if (!snap || snap.bytes.byteLength === 0) {
        showToast('未找到该词条的编辑前原件备份', true);
        return;
      }

      try {
        const bridge = getPlatformBridge();
        const parsed = await bridge.parsePraatFile(snap.bytes, snap.tgRelPath);
        const restoredTg = parsed.items.find(
          (it): it is Extract<CollectionItem, { type: 'TextGrid' }> => it.type === 'TextGrid'
        );
        if (!restoredTg) {
          showToast('备份文件中未包含有效的 TextGrid 对象', true);
          return;
        }
        await prefetchTrigraphCache(restoredTg, bridge);

        if (useEditorStore.getState().activeTabId !== tabId) {
          handleSwitchTab(tabId);
        }
        if (useEditorStore.getState().tabs.find((t) => t.id === tabId)?.corpus?.activeItemId !== itemId) {
          await switchCorpusEntry(tabId, itemId, {
            autoFocus: false,
            autoPlayOverride: false
          });
        }

        const st = useEditorStore.getState();
        if (st.mode === 'read') {
          st.setMode('edit');
        }
        st.commitTgMutation(
          (draft) => {
            draft.name = restoredTg.name;
            draft.xmin = restoredTg.xmin;
            draft.xmax = restoredTg.xmax;
            draft.tiers = restoredTg.tiers.map((t) => cloneTier(t));
          },
          null,
          {
            type: 'normalize-tg',
            title: '恢复为编辑前备份',
            detail: item.tgRelPath,
            icon: 'history'
          }
        );
        stageCorpusItem(tabId, { flushRecoveryNow: true });
        showToast('已载入编辑前原件备份（可撤销，确认无误后按 Ctrl+S 保存回原文件）');
      } catch (err) {
        showToast(`恢复原件备份失败：${String(err)}`, true);
      }
    },
    [handleSwitchTab, showToast, stageCorpusItem, switchCorpusEntry]
  );

  const handleToggleCorpusAutoSave = useCallback(() => {
    const st = useEditorStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    const corpus = tab?.kind === 'corpus' ? tab.corpus : null;
    if (corpus && !corpus.writable) {
      showToast(corpus.readOnlyReason || '当前只读模式无法直接写回磁盘，不支持开启自动保存', true);
      return;
    }

    if (st.corpusAutoSave) {
      if (corpusAutoSaveTimerRef.current !== null) {
        window.clearTimeout(corpusAutoSaveTimerRef.current);
        corpusAutoSaveTimerRef.current = null;
      }
      setCorpusAutoSave(false);
      showToast('已关闭自动保存，后续修改将先暂存在待保存区');
      return;
    }

    flushActiveEdits();
    const dirtyWritableCorpusTabs: Array<{ tabId: string; unsavedCount: number }> = [];
    for (const t of useEditorStore.getState().tabs) {
      if (t.kind !== 'corpus' || !t.corpus || !t.corpus.writable) continue;
      if (t.corpus.activeItemId) {
        stageCorpusItem(t.id, { flushRecoveryNow: true });
      }
      const cnt = corpusDraftManager.getDirtyCount(t.corpus.projectId);
      const idxDirty = corpusDraftManager.isProjectIndexDirty(t.corpus.projectId);
      if (cnt > 0 || idxDirty) {
        dirtyWritableCorpusTabs.push({ tabId: t.id, unsavedCount: cnt });
      }
    }

    if (dirtyWritableCorpusTabs.length === 0) {
      setCorpusAutoSave(true);
      showToast('已开启自动保存（覆写原文件前会自动保留 7 天原件备份）');
      return;
    }

    const totalPending = dirtyWritableCorpusTabs.reduce((acc, x) => acc + x.unsavedCount, 0);
    setCorpusConfirmModal({
      title: '开启自动保存',
      description:
        totalPending > 0
          ? `开启自动保存后，后续修改将在停顿约 1 秒后及切换词条时自动覆盖原文件夹中的文件（首次覆盖前会保留 7 天原件备份）。是否先保存当前已修改的 ${totalPending} 条词条？`
          : '开启自动保存后，后续修改将自动写回原文件夹。是否先保存当前的项目状态变更？',
      confirmLabel: '保存并开启',
      confirmTone: 'primary',
      onConfirm: async () => {
        for (const entry of dirtyWritableCorpusTabs) {
          const ok = await saveAllCorpusEntriesRef.current(entry.tabId);
          if (!ok) return;
        }
        setCorpusAutoSave(true);
        showToast('已保存当前修改并开启自动保存');
      }
    });
  }, [flushActiveEdits, setCorpusAutoSave, showToast, stageCorpusItem]);

  const handleRestoreRecoveryToDrafts = useCallback(
    async (tabId: string) => {
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      const corpus = tab.corpus;
      const pending = corpusPendingRecoveries[corpus.projectId];
      if (!pending) return;

      setRecoveryBusy(true);
      try {
        let restoredActive = false;
        for (const d of pending.bundle.drafts) {
          if (!corpus.itemMap[d.itemId]) continue;
          corpusDraftManager.setDraft(corpus.projectId, {
            itemId: d.itemId,
            tgRelPath: d.tgRelPath,
            tg: d.tg,
            format: d.format,
            baseFingerprint: d.baseFingerprint,
            hadDiskTextGrid: d.hadDiskTextGrid,
            ipaPreview: d.ipaPreview,
            statusOverride: d.statusOverride,
            noteOverride: d.noteOverride,
            updatedAt: d.updatedAt
          });
          useEditorStore.getState().updateCorpusItemMeta(
            d.itemId,
            {
              ipaPreview: d.ipaPreview,
              ...(d.statusOverride ? { status: d.statusOverride } : {}),
              ...(d.noteOverride !== undefined ? { note: d.noteOverride } : {})
            },
            tabId
          );
          if (d.itemId === corpus.activeItemId) {
            restoredActive = true;
          }
        }

        const itemMetaDelta = pending.bundle.project?.metaDelta?.itemMeta;
        if (itemMetaDelta) {
          let appliedMeta = false;
          for (const [itemId, delta] of Object.entries(itemMetaDelta)) {
            if (!corpus.itemMap[itemId]) continue;
            useEditorStore.getState().updateCorpusItemMeta(
              itemId,
              {
                ...(delta.status ? { status: delta.status } : {}),
                ...(delta.note !== undefined ? { note: delta.note } : {}),
                ...(delta.ipaPreview !== undefined ? { ipaPreview: delta.ipaPreview } : {})
              },
              tabId
            );
            appliedMeta = true;
          }
          if (appliedMeta) {
            corpusDraftManager.setProjectIndexDirty(corpus.projectId, true);
          }
        }

        setCorpusPendingRecoveries((prev) => {
          const next = { ...prev };
          delete next[corpus.projectId];
          return next;
        });
        useEditorStore.getState().syncCorpusUnsavedState({ pendingRecoveryCount: 0 }, tabId);
        syncCorpusUnsavedToStore(tabId);

        if (restoredActive && corpus.activeItemId) {
          await switchCorpusEntry(tabId, corpus.activeItemId, {
            autoFocus: false,
            autoPlayOverride: false,
            skipFlushPrev: true,
            resetHistory: true
          });
        }
        showToast(
          `已恢复 ${pending.bundle.drafts.length} 条草稿到待保存区（原文件夹未改动，确认后请保存）`
        );
      } finally {
        setRecoveryBusy(false);
      }
    },
    [corpusPendingRecoveries, showToast, switchCorpusEntry, syncCorpusUnsavedToStore]
  );

  const handleExportRecoveryZip = useCallback(
    async (tabId: string) => {
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      const corpus = tab.corpus;
      const pending = corpusPendingRecoveries[corpus.projectId];
      if (!pending || pending.bundle.drafts.length === 0) return;

      setRecoveryBusy(true);
      try {
        const bridge = getPlatformBridge();
        const entries: CorpusZipOverrideEntry[] = [];
        for (const d of pending.bundle.drafts) {
          const bytes = await bridge.serializeTextGrid(d.tg, d.format);
          entries.push({ relPath: d.tgRelPath, bytes });
        }
        const { bytes, fileCount } = await buildCorpusZipFromEntries(bridge, entries);
        const zipName = `${corpus.projectName || 'corpus'}_recovery.zip`;
        triggerBlobDownload(new Blob([bytes as BlobPart], { type: 'application/zip' }), zipName);
        showToast(`已导出恢复草稿 ${zipName}（含 ${fileCount} 个文件）`);
      } catch (err) {
        showToast(`导出恢复草稿失败：${String(err)}`, true);
      } finally {
        setRecoveryBusy(false);
      }
    },
    [corpusPendingRecoveries, showToast]
  );

  const handleDiscardRecoveryDrafts = useCallback(
    async (tabId: string) => {
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      const corpus = tab.corpus;

      setRecoveryBusy(true);
      try {
        if (!shouldSkipRecovery(corpus.rootKey)) {
          await deleteProjectRecovery(corpus.rootKey);
        }
        setCorpusPendingRecoveries((prev) => {
          const next = { ...prev };
          delete next[corpus.projectId];
          return next;
        });
        useEditorStore.getState().syncCorpusUnsavedState({ pendingRecoveryCount: 0 }, tabId);
        showToast('已放弃残留恢复草稿，当前以磁盘原文件为准');
      } finally {
        setRecoveryBusy(false);
      }
    },
    [showToast]
  );

  const handleConflictOverwrite = useCallback(async () => {
    const dlg = corpusConflictModalRef.current;
    if (!dlg || corpusConflictBusy) return;
    setCorpusConflictBusy(true);
    try {
      const outcome = await writeCorpusItemToDisk(dlg.tabId, {
        itemId: dlg.itemId,
        tg: dlg.tg,
        format: dlg.format,
        tgRelPath: dlg.tgRelPath,
        draftUpdatedAt: dlg.draftUpdatedAt,
        statusOverride: dlg.statusOverride,
        skipConflictCheck: true,
        recordOriginalBackup: true,
        writeProjectIndex: true
      });
      setCorpusConflictModal(null);
      if (outcome === 'saved') {
        showToast(`已覆盖保存：${dlg.tgRelPath}`);
      } else {
        showToast('覆盖保存失败，草稿已保留', true);
      }
    } finally {
      setCorpusConflictBusy(false);
    }
  }, [corpusConflictBusy, showToast, writeCorpusItemToDisk]);

  const handleConflictSaveCopy = useCallback(async () => {
    const dlg = corpusConflictModalRef.current;
    if (!dlg || corpusConflictBusy) return;
    const adapter = getCorpusAdapter(dlg.projectId);
    if (!adapter) return;
    setCorpusConflictBusy(true);
    try {
      const bridge = getPlatformBridge();
      const bytes = await bridge.serializeTextGrid(dlg.tg, dlg.format);
      const stem = getBaseStem(dlg.tgRelPath);
      const copyRelPath = `${stem}_conflict_${formatConflictStamp()}.TextGrid`;
      await adapter.writeFile(copyRelPath, bytes);
      setCorpusConflictModal(null);
      showToast(`已另存副本：${copyRelPath}（原文件保持未改，草稿仍保留在待保存区）`);
    } catch (err) {
      showToast(`另存副本失败：${String(err)}`, true);
    } finally {
      setCorpusConflictBusy(false);
    }
  }, [corpusConflictBusy, showToast]);

  const handleConflictReloadDisk = useCallback(async () => {
    const dlg = corpusConflictModalRef.current;
    if (!dlg || corpusConflictBusy) return;
    setCorpusConflictBusy(true);
    try {
      setCorpusConflictModal(null);
      await executeRevertCorpusEntryToDisk(dlg.tabId, dlg.itemId);
    } finally {
      setCorpusConflictBusy(false);
    }
  }, [corpusConflictBusy, executeRevertCorpusEntryToDisk]);

  const handleRebuildCorruptCorpusItem = useCallback(
    async (tabId: string, itemId: string) => {
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      const corpus = tab.corpus;
      const item = corpus.itemMap[itemId];
      if (!item) return;
      const adapter = getCorpusAdapter(corpus.projectId);
      if (!adapter) return;

      try {
        const rawBytes = await adapter.readFileIfExists(item.tgRelPath);
        if (rawBytes && rawBytes.length > 0 && corpus.writable) {
          const backupRel = `${getBaseStem(item.tgRelPath)}_corrupt_${formatConflictStamp()}.TextGrid.bak`;
          await adapter.writeFile(backupRel, rawBytes);
          showToast(`已备份损坏原文件为 ${backupRel}，正在按模板重建`);
        }
        useEditorStore.getState().updateCorpusItemMeta(
          itemId,
          { parseError: undefined, hasTextGrid: false },
          tabId
        );
        const audioEntry = corpusAudioCache.get(corpus.projectId, itemId);
        const freshTg = buildTextGridFromTemplate(
          corpus.tierTemplate,
          audioEntry ? audioEntry.buffer.duration : item.duration ?? 1.0,
          item.id,
          null
        );
        const composedRebuildStyle = composeCorpusStyleDocument(
          corpus.sharedStyle,
          corpus.itemStyles?.[itemId]
        );
        const { doc: reconciledRebuildStyle } = reconcileStyleDocument(composedRebuildStyle, freshTg);
        useEditorStore.getState().activateCorpusEntry({
          tabId,
          itemId,
          tg: freshTg,
          styleDoc: reconciledRebuildStyle,
          filename: item.tgRelPath,
          currentFilePath: adapter.resolveNativePath(item.tgRelPath),
          currentFileFormat: corpus.defaultSaveFormat || 'longText',
          audioName: audioEntry ? item.audioRelPath : '',
          audioOffset: 0,
          audioDuration: audioEntry ? audioEntry.buffer.duration : 0,
          audioSampleRate: audioEntry ? audioEntry.buffer.sampleRate : 0,
          analysis: audioEntry ? audioEntry.analysis : null,
          itemPatch: { parseError: undefined, hasTextGrid: false },
          resetHistory: true,
          initialDirty: true
        });
        useEditorStore.getState().setMode('edit');
        stageCorpusItem(tabId, { forceStage: true, flushRecoveryNow: true });
      } catch (err) {
        showToast(`备份重建失败：${String(err)}`, true);
      }
    },
    [showToast, stageCorpusItem]
  );

  const handleCorpusStep = useCallback(
    async (delta: -1 | 1) => {
      const st = useEditorStore.getState();
      const tab = st.tabs.find((t) => t.id === st.activeTabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      const corpus = tab.corpus;
      const filtered = filterCorpusItems(corpus.items, corpus.filter, !st.showCorpusStatusMarks);
      const navList = filtered.length > 0 ? filtered : corpus.items;
      if (navList.length === 0) return;

      const curIdx = corpus.activeItemId
        ? navList.findIndex((it) => it.id === corpus.activeItemId)
        : -1;
      let nextIdx = curIdx === -1 ? (delta > 0 ? 0 : navList.length - 1) : curIdx + delta;
      while (nextIdx >= 0 && nextIdx < navList.length && navList[nextIdx].missing) {
        nextIdx += delta;
      }
      if (nextIdx < 0 || nextIdx >= navList.length) {
        showToast(delta < 0 ? '已是第一条词条' : '已是最后一条词条');
        return;
      }
      await switchCorpusEntry(tab.id, navList[nextIdx].id, { autoFocus: true });
    },
    [showToast, switchCorpusEntry]
  );

  const handleCorpusMarkAndNext = useCallback(
    async (status: CorpusItemStatus) => {
      flushActiveEdits();
      const st = useEditorStore.getState();
      const tab = st.tabs.find((t) => t.id === st.activeTabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus || !tab.corpus.activeItemId) return;
      const corpus = tab.corpus;
      const activeItemId = tab.corpus.activeItemId;
      const activeItem = corpus.itemMap[activeItemId];
      if (!activeItem || activeItem.parseError) {
        showToast('当前词条原文件已损坏，请先通过上方横幅另存或重建', true);
        return;
      }

      // Resolve next target BEFORE updating status so filtering by 'todo' advances smoothly
      const filtered = filterCorpusItems(corpus.items, corpus.filter, !st.showCorpusStatusMarks);
      const navList = filtered.length > 0 ? filtered : corpus.items;
      const curIdx = navList.findIndex((it) => it.id === corpus.activeItemId);
      let nextItem: CorpusItemRecord | null = null;
      if (curIdx >= 0) {
        for (let i = curIdx + 1; i < navList.length; i++) {
          if (!navList[i].missing) {
            nextItem = navList[i];
            break;
          }
        }
      }

      // 默认手动模式下：仅暂存到内存草稿区与本地恢复缓存，严禁静默写盘
      const staged = stageCorpusItem(tab.id, {
        forceStage: status === 'done' || status !== activeItem.status,
        statusOverride: status,
        flushRecoveryNow: true
      });
      corpusDraftManager.setProjectIndexDirty(corpus.projectId, true);
      syncCorpusUnsavedToStore(tab.id);

      if (useEditorStore.getState().corpusAutoSave && corpus.writable && staged) {
        const outcome = await writeCorpusItemToDisk(tab.id, {
          itemId: staged.itemId,
          tg: staged.tg,
          format: staged.format,
          tgRelPath: staged.tgRelPath,
          draftUpdatedAt: staged.updatedAt,
          statusOverride: status,
          recordOriginalBackup: true,
          writeProjectIndex: true
        });
        if (outcome === 'conflict') {
          showToast(`「${staged.tgRelPath}」被外部修改，已保留在待保存区，请手动核对保存`, true);
          return;
        }
        if (outcome !== 'saved') {
          return;
        }
      }

      if (nextItem) {
        await switchCorpusEntry(tab.id, nextItem.id, { autoFocus: true, skipFlushPrev: true });
      } else {
        const labelMap: Record<CorpusItemStatus, string> = {
          todo: '未标',
          done: '已完成',
          doubt: '存疑',
          trash: '需重录'
        };
        showToast(`已标记为${labelMap[status]}（已是最后一条词条）`);
      }
    },
    [
      flushActiveEdits,
      showToast,
      stageCorpusItem,
      switchCorpusEntry,
      syncCorpusUnsavedToStore,
      writeCorpusItemToDisk
    ]
  );

  const handleCorpusSetStatus = useCallback(
    async (status: CorpusItemStatus) => {
      flushActiveEdits();
      const st = useEditorStore.getState();
      const tab = st.tabs.find((t) => t.id === st.activeTabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus || !tab.corpus.activeItemId) return;
      const corpus = tab.corpus;
      const activeItemId = tab.corpus.activeItemId;
      const activeItem = corpus.itemMap[activeItemId];
      if (!activeItem || activeItem.parseError) return;

      const staged = stageCorpusItem(tab.id, {
        forceStage: status === 'done' || status !== activeItem.status,
        statusOverride: status,
        flushRecoveryNow: true
      });
      corpusDraftManager.setProjectIndexDirty(corpus.projectId, true);
      syncCorpusUnsavedToStore(tab.id);

      if (useEditorStore.getState().corpusAutoSave && corpus.writable && staged) {
        await writeCorpusItemToDisk(tab.id, {
          itemId: staged.itemId,
          tg: staged.tg,
          format: staged.format,
          tgRelPath: staged.tgRelPath,
          draftUpdatedAt: staged.updatedAt,
          statusOverride: status,
          recordOriginalBackup: true,
          writeProjectIndex: true
        });
      }
    },
    [flushActiveEdits, stageCorpusItem, syncCorpusUnsavedToStore, writeCorpusItemToDisk]
  );

  const handleCorpusSetItemStatus = useCallback(
    async (itemId: string, status: CorpusItemStatus) => {
      const st = useEditorStore.getState();
      const tab = st.tabs.find((t) => t.id === st.activeTabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      if (itemId === tab.corpus.activeItemId) {
        await handleCorpusSetStatus(status);
        return;
      }
      if (!tab.corpus.itemMap[itemId]) return;
      const now = Date.now();
      st.updateCorpusItemMeta(itemId, { status, updatedAt: now }, tab.id);
      const existingDraft = corpusDraftManager.getDraft(tab.corpus.projectId, itemId);
      if (existingDraft) {
        corpusDraftManager.setDraft(tab.corpus.projectId, {
          ...existingDraft,
          statusOverride: status,
          updatedAt: now
        });
      }
      corpusDraftManager.setProjectIndexDirty(tab.corpus.projectId, true);
      syncCorpusUnsavedToStore(tab.id);

      if (useEditorStore.getState().corpusAutoSave && tab.corpus.writable) {
        await persistDiskProjectIndex(tab.id, {
          commitAllMeta: corpusDraftManager.getDirtyCount(tab.corpus.projectId) === 0
        });
      } else {
        void persistRecoveryForProjectMeta(tab.id);
      }
    },
    [
      handleCorpusSetStatus,
      persistDiskProjectIndex,
      persistRecoveryForProjectMeta,
      syncCorpusUnsavedToStore
    ]
  );

  const handleCorpusRevealItem = useCallback(
    async (itemId: string) => {
      const st = useEditorStore.getState();
      const tab = st.tabs.find((t) => t.id === st.activeTabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
      const item = tab.corpus.itemMap[itemId];
      if (!item) return;
      const adapter = getCorpusAdapter(tab.corpus.projectId);
      const targetRel = item.audioRelPath || item.tgRelPath;
      const nativePath = targetRel ? adapter?.resolveNativePath(targetRel) : null;
      if (!nativePath) {
        showToast('当前环境无法打开所在文件夹', true);
        return;
      }
      try {
        await getPlatformBridge().revealInExplorer(nativePath);
      } catch {
        showToast('无法打开所在文件夹', true);
      }
    },
    [showToast]
  );

  const handleCorpusCopyItemText = useCallback(
    async (text: string, label: string) => {
      if (!text) return;
      try {
        await getPlatformBridge().writeClipboardText(text);
        showToast(`已复制${label}：${text}`);
      } catch {
        try {
          await navigator.clipboard?.writeText(text);
          showToast(`已复制${label}：${text}`);
        } catch {
          showToast(`复制${label}失败`, true);
        }
      }
    },
    [showToast]
  );

  const handleCorpusReplay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    const st = useEditorStore.getState();
    if (st.playRange && st.playRange.end > st.playRange.start) {
      player.start(st.playRange.start, st.playRange.end);
      return;
    }
    if (st.selection?.kind === 'interval') {
      const tier = st.tg.tiers[st.selection.tierIndex];
      const iv = tier?.kind === 'intervalTier' ? tier.intervals[st.selection.itemIndex] : null;
      if (iv && iv.xmax > iv.xmin) {
        player.start(iv.xmin, iv.xmax);
        return;
      }
    }
    if (st.tg.xmax > st.tg.xmin) {
      player.start(st.tg.xmin, st.tg.xmax);
    }
  }, []);

  // 词表编辑双通道防抖：
  // 1) 默认手动模式：立即更新内存暂存区（撤销回基线自动归零），800ms 防抖写入本地 IndexedDB 恢复库，绝不覆写磁盘原文件；
  // 2) 开启自动保存且可写模式：额外以 1000ms 防抖写回磁盘，覆写前留存 7 天原件备份。
  useEffect(() => {
    if (corpusRecoveryTimerRef.current !== null) {
      window.clearTimeout(corpusRecoveryTimerRef.current);
      corpusRecoveryTimerRef.current = null;
    }
    if (corpusAutoSaveTimerRef.current !== null) {
      window.clearTimeout(corpusAutoSaveTimerRef.current);
      corpusAutoSaveTimerRef.current = null;
    }

    const st = useEditorStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (!tab || tab.kind !== 'corpus' || !tab.corpus?.activeItemId) {
      return;
    }
    const corpus = tab.corpus;
    const tabId = tab.id;
    const itemId = tab.corpus.activeItemId;
    const curItem = corpus.itemMap[itemId];
    if (!curItem || curItem.parseError) return;

    // 同步当前条内存暂存态（若通过 Ctrl+Z 撤销回基线则自动移出暂存区与恢复库）
    const staged = stageCorpusItem(tabId, { flushRecoveryNow: false });
    if (!staged) {
      return;
    }

    if (!shouldSkipRecovery(corpus.rootKey)) {
      corpusRecoveryTimerRef.current = window.setTimeout(() => {
        corpusRecoveryTimerRef.current = null;
        stageCorpusItem(tabId, { flushRecoveryNow: true });
      }, 800);
    }

    if (corpusAutoSave && corpus.writable) {
      corpusAutoSaveTimerRef.current = window.setTimeout(() => {
        corpusAutoSaveTimerRef.current = null;
        const latestSt = useEditorStore.getState();
        if (!latestSt.corpusAutoSave) return;
        const latestDraft = corpusDraftManager.getDraft(corpus.projectId, itemId);
        if (!latestDraft) return;
        void (async () => {
          const outcome = await writeCorpusItemToDisk(tabId, {
            itemId: latestDraft.itemId,
            tg: latestDraft.tg,
            format: latestDraft.format,
            tgRelPath: latestDraft.tgRelPath,
            draftUpdatedAt: latestDraft.updatedAt,
            statusOverride: latestDraft.statusOverride,
            recordOriginalBackup: true,
            writeProjectIndex: true
          });
          if (outcome === 'conflict') {
            showToast(`「${latestDraft.tgRelPath}」被外部修改，已暂停自动覆盖，请手动保存处理冲突`, true);
          }
        })();
      }, 1000);
    }

    return () => {
      if (corpusRecoveryTimerRef.current !== null) {
        window.clearTimeout(corpusRecoveryTimerRef.current);
        corpusRecoveryTimerRef.current = null;
      }
      if (corpusAutoSaveTimerRef.current !== null) {
        window.clearTimeout(corpusAutoSaveTimerRef.current);
        corpusAutoSaveTimerRef.current = null;
      }
    };
  }, [docVersion, activeTabId, isDirty, corpusAutoSave, showToast, stageCorpusItem, writeCorpusItemToDisk]);

  const handleNewTab = useCallback(() => {
    flushActiveEdits();
    playerRef.current?.stop(false);
    const st = useEditorStore.getState();
    const newId = st.createNewTab({ isBlankPlaceholder: true });
    if (st.mode === 'read') {
      st.setMode('edit');
    }
    syncPlayerForTab(newId);
  }, [flushActiveEdits, syncPlayerForTab]);

  const evictTabAudio = useCallback(
    async (tabId: string) => {
      const st = useEditorStore.getState();
      const tab = st.tabs.find((t) => t.id === tabId);
      const prevSessionId = tab?.analysis?.sessionId ?? null;
      deleteTabAudioBuffer(tabId);

      if (tabId === st.activeTabId) {
        playerRef.current?.clear();
        setAudioBuffer(null);
      }

      if (prevSessionId !== null) {
        stageRef.current?.pruneSpecCacheForSession(prevSessionId);
        prunePolarSpecCacheForSession(prevSessionId);
        try {
          await getPlatformBridge().removeAudioSession(prevSessionId);
        } catch {
          // ignore cleanup failure
        }
      }

      setAudioMetaForTab(tabId, {
        name: '',
        offset: 0,
        duration: 0,
        sampleRate: 0,
        analysis: null
      });
    },
    [setAudioMetaForTab]
  );

  const clearAudio = useCallback(async () => {
    const activeTabId = useEditorStore.getState().activeTabId;
    await evictTabAudio(activeTabId);
  }, [evictTabAudio]);

  const loadAudioBytesForTab = useCallback(
    async (tabId: string, bytes: Uint8Array, name: string, offset = 0) => {
      const player = playerRef.current!;
      const bridge = getPlatformBridge();

      // Evict only this tab's previous audio session
      const prevTab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      const prevSessionId = prevTab?.analysis?.sessionId ?? null;
      if (prevSessionId !== null) {
        stageRef.current?.pruneSpecCacheForSession(prevSessionId);
        prunePolarSpecCacheForSession(prevSessionId);
        void bridge.removeAudioSession(prevSessionId).catch(() => {});
      }

      const { buffer, mono } = await player.decodeAudioBytes(bytes, offset);
      const analysis = await bridge.loadPcmSession(mono, buffer.sampleRate, offset);

      // Guard if tab was closed while decoding asynchronously
      const stillExists = useEditorStore.getState().tabs.some((t) => t.id === tabId);
      if (!stillExists) {
        void bridge.removeAudioSession(analysis.sessionId).catch(() => {});
        syncPlayerForTab(useEditorStore.getState().activeTabId);
        return;
      }

      const curActiveId = useEditorStore.getState().activeTabId;
      if (curActiveId === tabId) {
        useEditorStore.getState().updateBlankTabDuration(offset, buffer.duration);
      }

      setTabAudioBuffer(tabId, buffer);
      setAudioMetaForTab(tabId, {
        name,
        offset,
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        analysis
      });

      const postActiveId = useEditorStore.getState().activeTabId;
      if (postActiveId === tabId) {
        player.setBuffer(buffer, offset);
        setAudioBuffer(buffer);
      } else {
        syncPlayerForTab(postActiveId);
      }
    },
    [setAudioMetaForTab, syncPlayerForTab]
  );

  const closeTabAndCleanup = useCallback(
    (tabId: string) => {
      playerRef.current?.stop(false);
      const pendingProjTimer = corpusProjectSaveTimersRef.current.get(tabId);
      if (pendingProjTimer !== undefined) {
        window.clearTimeout(pendingProjTimer);
        corpusProjectSaveTimersRef.current.delete(tabId);
      }
      corpusLoadSeqRef.current.delete(tabId);
      const { removedSessionId, removedCorpusProjectId, nextActiveTabId } = useEditorStore
        .getState()
        .closeTabImmediate(tabId);
      deleteTabAudioBuffer(tabId);
      if (removedCorpusProjectId) {
        corpusDraftManager.clearProject(removedCorpusProjectId);
        corpusDiskItemsRef.current.delete(removedCorpusProjectId);
        corpusBaseFpRef.current.delete(removedCorpusProjectId);
        corpusSaveLockRef.current.delete(removedCorpusProjectId);
        setCorpusPendingRecoveries((prev) => {
          if (!(removedCorpusProjectId in prev)) return prev;
          const next = { ...prev };
          delete next[removedCorpusProjectId];
          return next;
        });
        setCorpusBackupTimes((prev) => {
          if (!(removedCorpusProjectId in prev)) return prev;
          const next = { ...prev };
          delete next[removedCorpusProjectId];
          return next;
        });
        corpusAudioCache.clearProject(removedCorpusProjectId);
        disposeCorpusAdapter(removedCorpusProjectId);
      }
      if (removedSessionId !== null) {
        releaseAudioSessionResources(removedSessionId);
      }
      syncPlayerForTab(nextActiveTabId);
    },
    [releaseAudioSessionResources, syncPlayerForTab]
  );

  const closeTabsAndCleanup = useCallback(
    (tabIds: string[], preferredActiveTabId?: string) => {
      if (tabIds.length === 0) return;
      const prevActiveId = useEditorStore.getState().activeTabId;
      const closingActive = tabIds.includes(prevActiveId);
      if (closingActive) {
        playerRef.current?.stop(false);
      }
      for (const tabId of tabIds) {
        const pendingProjTimer = corpusProjectSaveTimersRef.current.get(tabId);
        if (pendingProjTimer !== undefined) {
          window.clearTimeout(pendingProjTimer);
          corpusProjectSaveTimersRef.current.delete(tabId);
        }
        corpusLoadSeqRef.current.delete(tabId);
      }
      const {
        removedTabIds,
        removedSessionIds,
        removedCorpusProjectIds,
        nextActiveTabId,
        activeTabChanged
      } = useEditorStore.getState().closeTabsImmediate(tabIds, preferredActiveTabId);

      for (const removedId of removedTabIds) {
        deleteTabAudioBuffer(removedId);
      }
      if (removedCorpusProjectIds.length > 0) {
        for (const projId of removedCorpusProjectIds) {
          corpusDraftManager.clearProject(projId);
          corpusDiskItemsRef.current.delete(projId);
          corpusBaseFpRef.current.delete(projId);
          corpusSaveLockRef.current.delete(projId);
          corpusAudioCache.clearProject(projId);
          disposeCorpusAdapter(projId);
        }
        const removedProjSet = new Set(removedCorpusProjectIds);
        setCorpusPendingRecoveries((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const projId of removedProjSet) {
            if (projId in next) {
              delete next[projId];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        setCorpusBackupTimes((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const projId of removedProjSet) {
            if (projId in next) {
              delete next[projId];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
      for (const sessionId of removedSessionIds) {
        releaseAudioSessionResources(sessionId);
      }
      if (activeTabChanged || closingActive) {
        syncPlayerForTab(nextActiveTabId);
      }
    },
    [releaseAudioSessionResources, syncPlayerForTab]
  );

  const buildUnsavedCorpusDetail = useCallback((tabId: string): UnsavedCorpusDetail | null => {
    const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab || tab.kind !== 'corpus' || !tab.corpus) return null;
    const corpus = tab.corpus;
    const ids = new Set<string>(corpusDraftManager.getUnsavedItemIds(corpus.projectId));
    if (tab.isDirty && corpus.activeItemId) {
      ids.add(corpus.activeItemId);
    }
    const unsavedItemNames: string[] = [];
    for (const id of ids) {
      const it = corpus.itemMap[id];
      unsavedItemNames.push(it ? it.label || it.id : id);
    }
    const indexDirty = corpusDraftManager.isProjectIndexDirty(corpus.projectId);
    const adapter = getCorpusAdapter(corpus.projectId);
    const readonlyPending = !corpus.writable
      ? Math.max(ids.size, adapter?.getPendingExportCount() ?? corpus.dirtyCount)
      : ids.size;
    if (readonlyPending === 0 && !indexDirty) {
      return null;
    }
    return {
      projectName: corpus.projectName,
      writable: corpus.writable,
      unsavedItemCount: readonlyPending,
      unsavedItemNames,
      projectIndexDirty: indexDirty
    };
  }, []);

  const requestCloseTab = useCallback(
    (tabId: string) => {
      const st = useEditorStore.getState();
      if (tabId === st.activeTabId) {
        flushActiveEdits();
      }
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab) return;

      if (tab.kind === 'corpus' && tab.corpus) {
        const corpus = tab.corpus;
        if (corpus.activeItemId) {
          stageCorpusItem(tabId, { flushRecoveryNow: true });
        }

        // 仅在用户主动开启自动保存且目录可写时才自动落盘；默认手动模式绝不静默写盘
        if (useEditorStore.getState().corpusAutoSave && corpus.writable) {
          void (async () => {
            const ok = await saveAllCorpusEntries(tabId, { silent: true });
            const latestTab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
            if (!latestTab) return;
            const remaining = buildUnsavedCorpusDetail(tabId);
            if (ok && !remaining) {
              closeTabAndCleanup(tabId);
            } else {
              setUnsavedDialog({
                mode: 'tab',
                tabId: latestTab.id,
                filename: corpus.projectName,
                corpus: remaining ?? {
                  projectName: corpus.projectName,
                  writable: corpus.writable,
                  unsavedItemCount: 1,
                  unsavedItemNames: [latestTab.filename]
                }
              });
            }
          })();
          return;
        }

        const detail = buildUnsavedCorpusDetail(tabId);
        if (!detail) {
          closeTabAndCleanup(tabId);
          return;
        }
        setUnsavedDialog({
          mode: 'tab',
          tabId: tab.id,
          filename: corpus.projectName,
          corpus: detail
        });
        return;
      }

      if (tab.isDirty) {
        setUnsavedDialog({ mode: 'tab', tabId: tab.id, filename: tab.filename });
        return;
      }
      closeTabAndCleanup(tabId);
    },
    [
      buildUnsavedCorpusDetail,
      closeTabAndCleanup,
      flushActiveEdits,
      saveAllCorpusEntries,
      stageCorpusItem
    ]
  );

  const isTabUnsavedForMenu = useCallback(
    (tab: TabRecord): boolean => {
      if (tab.kind === 'corpus' && tab.corpus) {
        return Boolean(buildUnsavedCorpusDetail(tab.id));
      }
      return tab.isDirty;
    },
    [buildUnsavedCorpusDetail]
  );

  const requestCloseTabs = useCallback(
    (
      rawTargetTabIds: string[],
      scopeLabel: string,
      opts?: { preferredActiveTabId?: string }
    ) => {
      const stBefore = useEditorStore.getState();
      const existingIds = new Set(stBefore.tabs.map((t) => t.id));
      const targetTabIds: string[] = [];
      const seen = new Set<string>();
      for (const id of rawTargetTabIds) {
        if (!existingIds.has(id) || seen.has(id)) continue;
        seen.add(id);
        targetTabIds.push(id);
      }
      if (targetTabIds.length === 0) return;

      if (targetTabIds.length === 1) {
        requestCloseTab(targetTabIds[0]);
        return;
      }

      if (targetTabIds.includes(stBefore.activeTabId)) {
        flushActiveEdits();
      }

      const tabsAfterFlush = useEditorStore.getState().tabs;
      for (const id of targetTabIds) {
        const t = tabsAfterFlush.find((x) => x.id === id);
        if (t?.kind === 'corpus' && t.corpus?.activeItemId) {
          stageCorpusItem(t.id, { flushRecoveryNow: true });
        }
      }

      const collectDirtyEntries = (ids: string[]): UnsavedWindowTabEntry[] => {
        const curTabs = useEditorStore.getState().tabs;
        const entries: UnsavedWindowTabEntry[] = [];
        for (const id of ids) {
          const tab = curTabs.find((x) => x.id === id);
          if (!tab) continue;
          if (tab.kind === 'corpus' && tab.corpus) {
            const detail = buildUnsavedCorpusDetail(tab.id);
            if (detail) {
              entries.push({
                id: tab.id,
                filename: tab.corpus.projectName,
                corpus: detail
              });
            }
          } else if (tab.isDirty) {
            entries.push({ id: tab.id, filename: tab.filename });
          }
        }
        return entries;
      };

      const stNow = useEditorStore.getState();
      if (stNow.corpusAutoSave) {
        const writableDirtyCorpusIds = targetTabIds.filter((id) => {
          const t = stNow.tabs.find((x) => x.id === id);
          return Boolean(
            t &&
              t.kind === 'corpus' &&
              t.corpus &&
              t.corpus.writable &&
              buildUnsavedCorpusDetail(t.id)
          );
        });
        if (writableDirtyCorpusIds.length > 0) {
          void (async () => {
            for (const cId of writableDirtyCorpusIds) {
              await saveAllCorpusEntries(cId, { silent: true });
            }
            const remainingDirty = collectDirtyEntries(targetTabIds);
            if (remainingDirty.length === 0) {
              closeTabsAndCleanup(targetTabIds, opts?.preferredActiveTabId);
            } else {
              setUnsavedDialog({
                mode: 'batch-tabs',
                scopeLabel,
                totalCloseCount: targetTabIds.length,
                targetTabIds,
                dirtyTabs: remainingDirty
              });
            }
          })();
          return;
        }
      }

      const dirtyEntries = collectDirtyEntries(targetTabIds);
      if (dirtyEntries.length === 0) {
        closeTabsAndCleanup(targetTabIds, opts?.preferredActiveTabId);
        return;
      }

      setUnsavedDialog({
        mode: 'batch-tabs',
        scopeLabel,
        totalCloseCount: targetTabIds.length,
        targetTabIds,
        dirtyTabs: dirtyEntries
      });
    },
    [
      buildUnsavedCorpusDetail,
      closeTabsAndCleanup,
      flushActiveEdits,
      requestCloseTab,
      saveAllCorpusEntries,
      stageCorpusItem
    ]
  );

  const persistStyleSidecarForDesktop = useCallback(
    async (savedPath: string, styleDoc: StyleDocument) => {
      if (!isDesktop || !savedPath) return;
      if (!hasAnyCustomStyle(styleDoc)) return;
      try {
        const sidecarPath = getStyleSidecarPath(savedPath);
        await getPlatformBridge().writeNativeFile(
          sidecarPath,
          encodeUtf8(serializeStyleSidecar(styleDoc))
        );
      } catch {
        // 伴生样式写入失败不阻塞主 TextGrid 保存
      }
    },
    [isDesktop]
  );

  const saveTabAsTextGrid = useCallback(
    async (tabId: string): Promise<boolean> => {
      const st = useEditorStore.getState();
      if (tabId === st.activeTabId) {
        flushActiveEdits();
      }
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab) return true;

      if (tab.kind === 'corpus' && tab.corpus) {
        return saveCurrentCorpusEntry(tabId);
      }

      const bridge = getPlatformBridge();
      const stem = getBaseStem(tab.filename);
      const fmt = tab.currentFileFormat;

      try {
        const bytes = await bridge.serializeTextGrid(tab.tg, fmt);
        if (isDesktop) {
          if (tab.currentFilePath) {
            await bridge.writeNativeFile(tab.currentFilePath, bytes);
            await persistStyleSidecarForDesktop(tab.currentFilePath, tab.styleDoc);
            markTabSaved(tabId);
            showToast(`已保存：${tab.filename}`, false, makeRevealAction(tab.currentFilePath));
            return true;
          }
          const defaultName = `${stem}.TextGrid`;
          const savedPath = await bridge.saveNativeFileDialog(
            defaultName,
            [{ name: 'Praat TextGrid 文件', extensions: ['TextGrid', 'textgrid'] }],
            bytes,
            { title: `保存 ${tab.filename}` }
          );
          if (!savedPath) return false;
          await persistStyleSidecarForDesktop(savedPath, tab.styleDoc);
          const savedName = getPathBaseName(savedPath);
          markTabSaved(tabId, { filePath: savedPath, filename: savedName, fileFormat: fmt });
          showToast(`已保存：${savedName}`, false, makeRevealAction(savedPath));
          return true;
        }

        const defaultName = `${stem}.TextGrid`;
        triggerBlobDownload(
          new Blob([bytes as BlobPart], { type: 'application/octet-stream' }),
          defaultName
        );
        markTabSaved(tabId);
        showToast(`已保存 ${defaultName}`);
        return true;
      } catch (err) {
        showToast(`保存失败：${String(err)}`, true);
        return false;
      }
    },
    [
      flushActiveEdits,
      isDesktop,
      makeRevealAction,
      markTabSaved,
      persistStyleSidecarForDesktop,
      saveCurrentCorpusEntry,
      showToast
    ]
  );

  const saveTabAsNewFile = useCallback(
    async (tabId: string): Promise<boolean> => {
      const st = useEditorStore.getState();
      if (tabId === st.activeTabId) {
        flushActiveEdits();
      }
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab) return false;

      const bridge = getPlatformBridge();
      const stem = getBaseStem(tab.filename);
      const fmt = tab.currentFileFormat;
      const defaultName = `${stem}.TextGrid`;

      try {
        const bytes = await bridge.serializeTextGrid(tab.tg, fmt);
        if (isDesktop) {
          const savedPath = await bridge.saveNativeFileDialog(
            defaultName,
            [{ name: 'Praat TextGrid 文件', extensions: ['TextGrid', 'textgrid'] }],
            bytes,
            { title: `另存为 ${tab.filename}` }
          );
          if (!savedPath) return false;
          await persistStyleSidecarForDesktop(savedPath, tab.styleDoc);
          const savedName = getPathBaseName(savedPath);
          markTabSaved(tabId, { filePath: savedPath, filename: savedName, fileFormat: fmt });
          showToast(`已另存为：${savedName}`, false, makeRevealAction(savedPath));
          return true;
        }
        triggerBlobDownload(
          new Blob([bytes as BlobPart], { type: 'application/octet-stream' }),
          defaultName
        );
        markTabSaved(tabId);
        showToast(`已保存 ${defaultName}`);
        return true;
      } catch (err) {
        showToast(`保存失败：${String(err)}`, true);
        return false;
      }
    },
    [
      flushActiveEdits,
      isDesktop,
      makeRevealAction,
      markTabSaved,
      persistStyleSidecarForDesktop,
      showToast
    ]
  );

  const handleTabContextMenu = useCallback((tabId: string, e: React.MouseEvent) => {
    setTabCtxMenu({ kind: 'tab', tabId, x: e.clientX, y: e.clientY });
  }, []);

  const handleTabStripBlankContextMenu = useCallback((e: React.MouseEvent) => {
    setTabCtxMenu({ kind: 'blank', x: e.clientX, y: e.clientY });
  }, []);

  const handleCloseOtherTabs = useCallback(
    (keepTabId: string) => {
      const st = useEditorStore.getState();
      const others = st.tabs.filter((t) => t.id !== keepTabId).map((t) => t.id);
      if (others.length === 0) return;
      requestCloseTabs(others, '关闭其他标签页', { preferredActiveTabId: keepTabId });
    },
    [requestCloseTabs]
  );

  const handleCloseRightTabs = useCallback(
    (anchorTabId: string) => {
      const st = useEditorStore.getState();
      const idx = st.tabs.findIndex((t) => t.id === anchorTabId);
      if (idx < 0 || idx >= st.tabs.length - 1) return;
      const rightIds = st.tabs.slice(idx + 1).map((t) => t.id);
      requestCloseTabs(rightIds, '关闭右侧标签页');
    },
    [requestCloseTabs]
  );

  const handleCloseSavedTabs = useCallback(() => {
    flushActiveEdits();
    const st = useEditorStore.getState();
    for (const tab of st.tabs) {
      if (tab.kind === 'corpus' && tab.corpus?.activeItemId) {
        stageCorpusItem(tab.id, { flushRecoveryNow: true });
      }
    }
    const latestTabs = useEditorStore.getState().tabs;
    const savedIds = latestTabs.filter((t) => !isTabUnsavedForMenu(t)).map((t) => t.id);
    if (savedIds.length === 0) return;
    closeTabsAndCleanup(savedIds);
  }, [closeTabsAndCleanup, flushActiveEdits, isTabUnsavedForMenu, stageCorpusItem]);

  const handleCloseAllTabs = useCallback(() => {
    const allIds = useEditorStore.getState().tabs.map((t) => t.id);
    if (allIds.length === 0) return;
    requestCloseTabs(allIds, '关闭全部标签页');
  }, [requestCloseTabs]);

  const handleTabCopyText = useCallback(
    (text: string, label: string) => {
      void getPlatformBridge()
        .writeClipboardText(text)
        .then(() => {
          showToast(`已复制${label}`);
        })
        .catch(() => {
          showToast(`复制${label}失败`, true);
        });
    },
    [showToast]
  );

  const handleTabRevealPath = useCallback(
    (targetPath: string) => {
      void getPlatformBridge()
        .revealInExplorer(targetPath)
        .catch(() => {
          showToast('无法打开所在文件夹', true);
        });
    },
    [showToast]
  );

  const getCorpusNativeDirPath = useCallback((tabId: string): string | null => {
    const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab || tab.kind !== 'corpus' || !tab.corpus) return null;
    if (tab.corpus.rootKey.startsWith('sample:')) return null;
    return getCorpusAdapter(tab.corpus.projectId)?.nativeDirPath ?? null;
  }, []);

  const handleToggleCorpusAutoPlay = useCallback(() => {
    const st = useEditorStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
    st.setCorpusOptions({ autoPlay: !tab.corpus.options.autoPlay });
    corpusDraftManager.setProjectIndexDirty(tab.corpus.projectId, true);
    syncCorpusUnsavedToStore(tab.id);
    if (st.corpusAutoSave && tab.corpus.writable) {
      void persistDiskProjectIndex(tab.id, {
        commitAllMeta: corpusDraftManager.getDirtyCount(tab.corpus.projectId) === 0
      });
    } else {
      void persistRecoveryForProjectMeta(tab.id);
    }
  }, [persistDiskProjectIndex, persistRecoveryForProjectMeta, syncCorpusUnsavedToStore]);

  const handleToggleCorpusAutoVad = useCallback(() => {
    const st = useEditorStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (!tab || tab.kind !== 'corpus' || !tab.corpus) return;
    st.setCorpusOptions({ autoVad: !tab.corpus.options.autoVad });
    corpusDraftManager.setProjectIndexDirty(tab.corpus.projectId, true);
    syncCorpusUnsavedToStore(tab.id);
    if (st.corpusAutoSave && tab.corpus.writable) {
      void persistDiskProjectIndex(tab.id, {
        commitAllMeta: corpusDraftManager.getDirtyCount(tab.corpus.projectId) === 0
      });
    } else {
      void persistRecoveryForProjectMeta(tab.id);
    }
  }, [persistDiskProjectIndex, persistRecoveryForProjectMeta, syncCorpusUnsavedToStore]);

  const persistDesktopSessionNow = useCallback(() => {
    if (!isDesktop || !sessionRestoredRef.current) return;
    if (sessionSaveTimerRef.current !== null) {
      window.clearTimeout(sessionSaveTimerRef.current);
      sessionSaveTimerRef.current = null;
    }
    const st = useEditorStore.getState();
    if (!st.restoreSessionOnStartup) return;

    const entries: PersistedSessionTab[] = [];
    let activeIndex = -1;

    for (const tab of st.tabs) {
      if (tab.kind === 'corpus' && tab.corpus) {
        const adapter = getCorpusAdapter(tab.corpus.projectId);
        const dirPath = adapter?.nativeDirPath;
        if (!dirPath) continue;
        if (tab.id === st.activeTabId) {
          activeIndex = entries.length;
        }
        entries.push({
          kind: 'corpus',
          dirPath,
          activeItemId: tab.corpus.activeItemId
        });
      } else if (tab.currentFilePath) {
        if (tab.id === st.activeTabId) {
          activeIndex = entries.length;
        }
        entries.push({
          kind: 'single',
          filePath: tab.currentFilePath
        });
      }
    }

    savePersistedSession({
      version: 1,
      activeIndex: activeIndex >= 0 ? activeIndex : 0,
      tabs: entries
    });
  }, [isDesktop]);

  useEffect(() => {
    if (!isDesktop || !sessionRestoredRef.current || !restoreSessionOnStartup) return;
    if (sessionSaveTimerRef.current !== null) {
      window.clearTimeout(sessionSaveTimerRef.current);
    }
    sessionSaveTimerRef.current = window.setTimeout(() => {
      sessionSaveTimerRef.current = null;
      persistDesktopSessionNow();
    }, 300);
    return () => {
      if (sessionSaveTimerRef.current !== null) {
        window.clearTimeout(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }
    };
  }, [
    isDesktop,
    tabs,
    activeTabId,
    activeCorpus?.activeItemId,
    restoreSessionOnStartup,
    persistDesktopSessionNow
  ]);

  const destroyDesktopWindow = useCallback(async () => {
    if (!isDesktop) return;
    persistDesktopSessionNow();
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().destroy();
    } catch {
      // ignore
    }
  }, [isDesktop, persistDesktopSessionNow]);

  const handleUnsavedCancel = useCallback(() => {
    if (unsavedBusyRef.current) return;
    setUnsavedDialog(null);
  }, []);

  const handleUnsavedDiscard = useCallback(() => {
    const dlg = unsavedDialogRef.current;
    if (!dlg || unsavedBusyRef.current) return;
    setUnsavedDialog(null);
    if (dlg.mode === 'tab') {
      const targetTab = useEditorStore.getState().tabs.find((t) => t.id === dlg.tabId);
      if (targetTab?.kind === 'corpus' && targetTab.corpus) {
        const rootKey = targetTab.corpus.rootKey;
        const projId = targetTab.corpus.projectId;
        corpusDraftManager.clearProject(projId);
        if (!shouldSkipRecovery(rootKey)) {
          void deleteProjectRecovery(rootKey);
        }
      }
      closeTabAndCleanup(dlg.tabId);
    } else if (dlg.mode === 'batch-tabs') {
      const curTabs = useEditorStore.getState().tabs;
      for (const item of dlg.dirtyTabs) {
        const t = curTabs.find((x) => x.id === item.id);
        if (t?.kind === 'corpus' && t.corpus) {
          corpusDraftManager.clearProject(t.corpus.projectId);
          if (!shouldSkipRecovery(t.corpus.rootKey)) {
            void deleteProjectRecovery(t.corpus.rootKey);
          }
        }
      }
      closeTabsAndCleanup(dlg.targetTabIds);
    } else {
      void (async () => {
        const curTabs = useEditorStore.getState().tabs;
        for (const item of dlg.dirtyTabs) {
          const t = curTabs.find((x) => x.id === item.id);
          if (t?.kind === 'corpus' && t.corpus) {
            corpusDraftManager.clearProject(t.corpus.projectId);
            if (!shouldSkipRecovery(t.corpus.rootKey)) {
              await deleteProjectRecovery(t.corpus.rootKey);
            }
          }
        }
        await destroyDesktopWindow();
      })();
    }
  }, [closeTabAndCleanup, closeTabsAndCleanup, destroyDesktopWindow]);

  const handleUnsavedSave = useCallback(async () => {
    const dlg = unsavedDialogRef.current;
    if (!dlg || unsavedBusyRef.current) return;

    setUnsavedBusy(true);
    try {
      if (dlg.mode === 'tab') {
        const targetTab = useEditorStore.getState().tabs.find((t) => t.id === dlg.tabId);
        let ok = true;
        if (targetTab?.kind === 'corpus' && targetTab.corpus) {
          ok = targetTab.corpus.writable
            ? await saveAllCorpusEntries(dlg.tabId)
            : await handleExportCorpusZip(dlg.tabId);
        } else {
          ok = await saveTabAsTextGrid(dlg.tabId);
        }
        setUnsavedDialog(null);
        if (ok) {
          closeTabAndCleanup(dlg.tabId);
        }
      } else if (dlg.mode === 'batch-tabs') {
        for (const item of dlg.dirtyTabs) {
          const curTab = useEditorStore.getState().tabs.find((t) => t.id === item.id);
          if (!curTab) continue;
          if (curTab.kind === 'corpus' && curTab.corpus) {
            const ok = curTab.corpus.writable
              ? await saveAllCorpusEntries(curTab.id)
              : await handleExportCorpusZip(curTab.id);
            if (!ok) {
              setUnsavedDialog(null);
              return;
            }
            continue;
          }
          if (!curTab.isDirty) continue;
          if (!curTab.currentFilePath && useEditorStore.getState().activeTabId !== curTab.id) {
            handleSwitchTab(curTab.id);
          }
          const ok = await saveTabAsTextGrid(curTab.id);
          if (!ok) {
            setUnsavedDialog(null);
            return;
          }
        }
        setUnsavedDialog(null);
        closeTabsAndCleanup(dlg.targetTabIds);
      } else {
        for (const item of dlg.dirtyTabs) {
          const curTab = useEditorStore.getState().tabs.find((t) => t.id === item.id);
          if (!curTab) continue;
          if (curTab.kind === 'corpus' && curTab.corpus) {
            const ok = curTab.corpus.writable
              ? await saveAllCorpusEntries(curTab.id)
              : await handleExportCorpusZip(curTab.id);
            if (!ok) {
              setUnsavedDialog(null);
              return;
            }
            continue;
          }
          if (!curTab.isDirty) continue;
          if (!curTab.currentFilePath && useEditorStore.getState().activeTabId !== curTab.id) {
            handleSwitchTab(curTab.id);
          }
          const ok = await saveTabAsTextGrid(curTab.id);
          if (!ok) {
            setUnsavedDialog(null);
            return;
          }
        }
        setUnsavedDialog(null);
        await destroyDesktopWindow();
      }
    } finally {
      setUnsavedBusy(false);
    }
  }, [
    closeTabAndCleanup,
    closeTabsAndCleanup,
    destroyDesktopWindow,
    handleExportCorpusZip,
    handleSwitchTab,
    saveAllCorpusEntries,
    saveTabAsTextGrid
  ]);

  const openFilePayloads = useCallback(
    async (
      files: IncomingFilePayload[],
      opts?: { replaceActiveTab?: boolean; silent?: boolean; standaloneAudioInNewTab?: boolean }
    ): Promise<string[]> => {
      const bridge = getPlatformBridge();
      const svgFiles = files.filter((f) => SVG_EXT_RE.test(f.name));
      const styleFiles = files.filter((f) => STYLE_SIDECAR_RE.test(f.name));
      const audioFiles = files.filter((f) => AUDIO_EXT_RE.test(f.name));
      const docFiles = files.filter(
        (f) =>
          !AUDIO_EXT_RE.test(f.name) &&
          !STYLE_SIDECAR_RE.test(f.name) &&
          !SVG_EXT_RE.test(f.name)
      );

      const audioPriority = (name: string) => {
        const { ext } = splitFileStemAndExt(name);
        if (ext === 'wav') return 0;
        if (ext === 'flac') return 1;
        if (ext === 'mp3') return 2;
        return 3;
      };
      const parentOfPath = (p?: string | null) => {
        if (!p) return '';
        const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
        return idx > 0 ? normalizeDropPathKey(p.slice(0, idx)) : '';
      };

      // 建立按主干（及父目录）索引的显式音频表，确保多对标注+音频精准绑定而非全覆盖到最后一个标签页
      const sortedAudios = audioFiles
        .map((f, idx) => ({
          idx,
          file: f,
          stemKey: splitFileStemAndExt(f.name).stem.toLowerCase(),
          parentKey: parentOfPath(f.path)
        }))
        .sort((a, b) => audioPriority(a.file.name) - audioPriority(b.file.name));
      const consumedAudioIndices = new Set<number>();

      const indexedStyles = styleFiles.map((f, idx) => ({
        idx,
        file: f,
        stemKey: splitFileStemAndExt(f.name).stem.toLowerCase(),
        parentKey: parentOfPath(f.path)
      }));
      const consumedStyleIndices = new Set<number>();

      const takeMatchingAudio = (docFile: IncomingFilePayload): IncomingFilePayload | null => {
        const docStem = splitFileStemAndExt(docFile.name).stem.toLowerCase();
        const docParent = parentOfPath(docFile.path);
        const exactMatch = sortedAudios.find(
          (a) =>
            !consumedAudioIndices.has(a.idx) &&
            a.stemKey === docStem &&
            (docParent === '' || a.parentKey === '' || a.parentKey === docParent)
        );
        if (exactMatch) {
          consumedAudioIndices.add(exactMatch.idx);
          return exactMatch.file;
        }
        // 单标注 + 单音频配对场景（允许文件名不完全一致时自动合入同一标签页）
        if (docFiles.length === 1 && audioFiles.length === 1) {
          const single = sortedAudios.find((a) => !consumedAudioIndices.has(a.idx));
          if (single) {
            consumedAudioIndices.add(single.idx);
            return single.file;
          }
        }
        return null;
      };

      const takeMatchingStyle = (docFile: IncomingFilePayload): IncomingFilePayload | null => {
        const docStem = splitFileStemAndExt(docFile.name).stem.toLowerCase();
        const docParent = parentOfPath(docFile.path);
        const exactMatch = indexedStyles.find(
          (s) =>
            !consumedStyleIndices.has(s.idx) &&
            s.stemKey === docStem &&
            (docParent === '' || s.parentKey === '' || s.parentKey === docParent)
        );
        if (exactMatch) {
          consumedStyleIndices.add(exactMatch.idx);
          return exactMatch.file;
        }
        return null;
      };

      const tryApplyStyleBytesToTab = (
        tabId: string,
        bytes: Uint8Array,
        tg: TextGrid,
        markDirty: boolean
      ): { ok: boolean; note: string } => {
        const parsed = parseStyleSidecar(decodeUtf8(bytes));
        if (!parsed) return { ok: false, note: '' };
        const { doc: reconciled, report } = reconcileStyleDocument(parsed, tg);
        useEditorStore.getState().loadStyleDocForTab(tabId, reconciled, { markDirty });
        return { ok: true, note: formatStyleReconcileNote(report) };
      };

      let replaceFirst = Boolean(opts?.replaceActiveTab);
      const silent = Boolean(opts?.silent);
      const openedTabIds: string[] = [];

      for (const file of docFiles) {
        const lower = file.name.toLowerCase();
        const matchedExplicitAudio = takeMatchingAudio(file);
        const matchedExplicitStyle = takeMatchingStyle(file);

        // If desktop file path is already open in a tab, switch directly to it
        if (file.path) {
          const existing = useEditorStore.getState().findTabByPath(file.path);
          if (existing) {
            handleSwitchTab(existing.id);
            let styleAppliedNote = '';
            if (matchedExplicitStyle) {
              const res = tryApplyStyleBytesToTab(
                existing.id,
                matchedExplicitStyle.bytes,
                existing.tg,
                true
              );
              if (res.ok) {
                styleAppliedNote = res.note;
              }
            }
            if (matchedExplicitAudio) {
              try {
                await loadAudioBytesForTab(
                  existing.id,
                  matchedExplicitAudio.bytes,
                  matchedExplicitAudio.name,
                  0
                );
                if (!silent) showToast(`已切换至已打开标签页并载入录音：${matchedExplicitAudio.name}`);
              } catch (err) {
                if (!silent) showToast(`音频解码失败：${String(err)}`, true);
              }
            } else if (matchedExplicitStyle && !silent) {
              showToast(
                styleAppliedNote
                  ? `已切换至已打开标签页并载入样式（${styleAppliedNote}）`
                  : `已切换至已打开标签页并载入样式：${matchedExplicitStyle.name}`
              );
            } else if (!silent) {
              showToast('已切换至已打开的标签页');
            }
            openedTabIds.push(existing.id);
            replaceFirst = false;
            continue;
          }
        }

        try {
          const doc = await bridge.parsePraatFile(file.bytes, file.name);
          const tgs: TextGrid[] = [];
          let firstSound: Extract<CollectionItem, { type: 'Sound' }> | null = null;
          for (const item of doc.items) {
            if (item.type === 'TextGrid') tgs.push(item);
            else if (item.type === 'Sound' && !firstSound) firstSound = item;
          }
          if (tgs.length === 0) {
            if (firstSound) {
              const targetTabId = useEditorStore.getState().activeTabId;
              const sr = firstSound.dx > 0 ? 1 / firstSound.dx : 16000;
              const { buffer, mono } = playerRef.current!.loadFromSoundObject(
                firstSound.channels,
                sr,
                firstSound.xmin
              );
              const analysis = await bridge.loadPcmSession(mono, buffer.sampleRate, firstSound.xmin);
              if (useEditorStore.getState().activeTabId === targetTabId) {
                useEditorStore.getState().updateBlankTabDuration(firstSound.xmin, buffer.duration);
              }
              setTabAudioBuffer(targetTabId, buffer);
              setAudioMetaForTab(targetTabId, {
                name: firstSound.name || file.name,
                offset: firstSound.xmin,
                duration: buffer.duration,
                sampleRate: buffer.sampleRate,
                analysis
              });
              if (useEditorStore.getState().activeTabId === targetTabId) {
                playerRef.current!.setBuffer(buffer, firstSound.xmin);
                setAudioBuffer(buffer);
              }
              if (!silent) showToast(`已从 Praat 文件载入音频：${firstSound.name || file.name}`);
              continue;
            }
            if (!silent) showToast('文件中未包含 TextGrid 对象', true);
            continue;
          }
          await prefetchTrigraphCache(tgs[0], bridge);
          const fileFormat = inferTextGridFormat(doc.sourceFormat);
          const isCollection = doc.items.length > 1 || lower.endsWith('.collection');
          const resolvedPath = !isCollection && file.path ? file.path : null;

          flushActiveEdits();
          const st = useEditorStore.getState();
          const curActiveTab = st.tabs.find((t) => t.id === st.activeTabId);
          const canReuseActive =
            (replaceFirst && curActiveTab?.kind !== 'corpus') ||
            Boolean(
              curActiveTab &&
                curActiveTab.kind !== 'corpus' &&
                curActiveTab.isBlankPlaceholder &&
                !curActiveTab.isDirty &&
                !curActiveTab.audioName
            );
          replaceFirst = false;

          let targetTabId: string;
          if (canReuseActive && curActiveTab) {
            if (curActiveTab.audioName || curActiveTab.analysis) {
              await evictTabAudio(curActiveTab.id);
            }
            setDocument(tgs[0], file.name, tgs.length > 1 ? tgs : [], 0, {
              filePath: resolvedPath,
              fileFormat,
              isBlankPlaceholder: false,
              baselineKind: 'open'
            });
            targetTabId = curActiveTab.id;
            syncPlayerForTab(targetTabId);
          } else {
            playerRef.current?.stop(false);
            targetTabId = useEditorStore.getState().createNewTab({
              tg: tgs[0],
              filename: file.name,
              collectionTgs: tgs.length > 1 ? tgs : [],
              activeIdx: 0,
              filePath: resolvedPath,
              fileFormat,
              isBlankPlaceholder: false,
              baselineKind: 'open'
            });
            syncPlayerForTab(targetTabId);
          }
          openedTabIds.push(targetTabId);

          // 载入伴生 .tgstyle.json（显式同批拖入优先，其次桌面端磁盘自动探测）
          let sidecarReconcileNote = '';
          let sidecarLoaded = false;
          if (matchedExplicitStyle) {
            const applied = tryApplyStyleBytesToTab(
              targetTabId,
              matchedExplicitStyle.bytes,
              tgs[0],
              false
            );
            if (applied.ok) {
              sidecarLoaded = true;
              sidecarReconcileNote = applied.note;
            }
          } else if (isDesktop && resolvedPath) {
            try {
              const sidecarPath = getStyleSidecarPath(resolvedPath);
              let sidecarBytes: Uint8Array | null = null;
              if (typeof bridge.readNativeFileIfExists === 'function') {
                sidecarBytes = await bridge.readNativeFileIfExists(sidecarPath);
              } else {
                const openedSidecar = await bridge.readNativeFile(sidecarPath);
                sidecarBytes = openedSidecar?.bytes ?? null;
              }
              if (sidecarBytes && sidecarBytes.byteLength > 0) {
                const applied = tryApplyStyleBytesToTab(targetTabId, sidecarBytes, tgs[0], false);
                if (applied.ok) {
                  sidecarLoaded = true;
                  sidecarReconcileNote = applied.note;
                }
              }
            } catch {
              // 静默忽略伴生样式读取失败
            }
          }

          if (firstSound) {
            const sr = firstSound.dx > 0 ? 1 / firstSound.dx : 16000;
            const { buffer, mono } = playerRef.current!.loadFromSoundObject(
              firstSound.channels,
              sr,
              firstSound.xmin
            );
            const analysis = await bridge.loadPcmSession(mono, buffer.sampleRate, firstSound.xmin);
            setTabAudioBuffer(targetTabId, buffer);
            setAudioMetaForTab(targetTabId, {
              name: firstSound.name || `${file.name} (Sound)`,
              offset: firstSound.xmin,
              duration: buffer.duration,
              sampleRate: buffer.sampleRate,
              analysis
            });
            if (useEditorStore.getState().activeTabId === targetTabId) {
              playerRef.current!.setBuffer(buffer, firstSound.xmin);
              setAudioBuffer(buffer);
            }
            if (!silent) showToast(`已载入集合：${tgs.length} 个 TextGrid + 配套音频`);
          } else if (matchedExplicitAudio) {
            try {
              await loadAudioBytesForTab(
                targetTabId,
                matchedExplicitAudio.bytes,
                matchedExplicitAudio.name,
                0
              );
              if (!silent) {
                const styleSuffix = sidecarReconcileNote
                  ? `（已载入伴生样式，${sidecarReconcileNote}）`
                  : sidecarLoaded
                    ? '（已载入伴生样式）'
                    : '';
                showToast(
                  `已配对载入：${file.name} + ${matchedExplicitAudio.name}${styleSuffix}`
                );
              }
            } catch (err) {
              if (!silent) showToast(`音频解码失败：${String(err)}`, true);
            }
          } else {
            let autoPairedAudioName: string | null = null;
            if (isDesktop && file.path) {
              try {
                const companionPath = await bridge.findCompanionAudio(file.path);
                if (companionPath) {
                  const wavFile = await bridge.readNativeFile(companionPath);
                  if (wavFile) {
                    await loadAudioBytesForTab(targetTabId, wavFile.bytes, wavFile.name, 0);
                    autoPairedAudioName = wavFile.name;
                  }
                }
              } catch {
                // Ignore companion audio errors silently; TextGrid is already loaded
              }
            }

            if (!silent) {
              if (sidecarReconcileNote) {
                showToast(`已载入伴生样式（${sidecarReconcileNote}）`);
              } else if (autoPairedAudioName) {
                showToast(
                  sidecarLoaded
                    ? `已自动配对加载同名音频与伴生样式：${autoPairedAudioName}`
                    : `已自动配对加载同名音频: ${autoPairedAudioName}`
                );
              } else if (sidecarLoaded) {
                showToast(`已载入：${file.name}（含伴生样式）`);
              } else {
                showToast(
                  tgs.length > 1
                    ? `已载入集合：${file.name}（含 ${tgs.length} 个 TextGrid）`
                    : `已载入：${file.name}`
                );
              }
            }
          }
        } catch (err) {
          if (!silent) showToast(`解析失败：${String(err)}`, true);
        }
      }

      // 处理含 <tgrid:project> 工程元数据的 SVG 矢量图还原
      for (const svgFile of svgFiles) {
        try {
          const payload = extractProjectFromSvgText(decodeUtf8(svgFile.bytes));
          if (!payload) {
            if (!silent) {
              showToast('该 SVG 不含 T·Grid 工程数据，已忽略');
            }
            continue;
          }
          await prefetchTrigraphCache(payload.tg, bridge);
          const { doc: reconciledStyle } = reconcileStyleDocument(payload.styleDoc, payload.tg);
          const restoredFilename =
            payload.filename || `${getBaseStem(svgFile.name)}.TextGrid`;

          flushActiveEdits();
          const st = useEditorStore.getState();
          const curActiveTab = st.tabs.find((t) => t.id === st.activeTabId);
          const canReuseActive =
            (replaceFirst && curActiveTab?.kind !== 'corpus') ||
            Boolean(
              curActiveTab &&
                curActiveTab.kind !== 'corpus' &&
                curActiveTab.isBlankPlaceholder &&
                !curActiveTab.isDirty &&
                !curActiveTab.audioName
            );
          replaceFirst = false;

          let targetTabId: string;
          if (canReuseActive && curActiveTab) {
            if (curActiveTab.audioName || curActiveTab.analysis) {
              await evictTabAudio(curActiveTab.id);
            }
            setDocument(payload.tg, restoredFilename, [], 0, {
              filePath: null,
              fileFormat: 'longText',
              isBlankPlaceholder: false,
              baselineKind: 'open',
              styleDoc: reconciledStyle
            });
            targetTabId = curActiveTab.id;
            syncPlayerForTab(targetTabId);
          } else {
            playerRef.current?.stop(false);
            targetTabId = useEditorStore.getState().createNewTab({
              tg: payload.tg,
              styleDoc: reconciledStyle,
              filename: restoredFilename,
              filePath: null,
              fileFormat: 'longText',
              isBlankPlaceholder: false,
              baselineKind: 'open'
            });
            syncPlayerForTab(targetTabId);
          }
          openedTabIds.push(targetTabId);
          if (!silent) {
            showToast('已从 SVG 还原标注与样式');
          }
        } catch (err) {
          if (!silent) showToast(`SVG 解析失败：${String(err)}`, true);
        }
      }

      // 处理单独拖入（未与同批 TextGrid 配对）的 .tgstyle.json 样式包：应用到当前标签页
      const remainingStyles = indexedStyles.filter((s) => !consumedStyleIndices.has(s.idx));
      for (const entry of remainingStyles) {
        const curSt = useEditorStore.getState();
        const applied = tryApplyStyleBytesToTab(
          curSt.activeTabId,
          entry.file.bytes,
          curSt.tg,
          true
        );
        if (!applied.ok) {
          if (!silent) showToast(`样式文件解析失败：${entry.file.name}`, true);
          continue;
        }
        if (!silent) {
          showToast(
            applied.note
              ? `已应用样式文件：${entry.file.name}（${applied.note}）`
              : `已应用样式文件：${entry.file.name}`
          );
        }
      }

      // 处理剩余未配对的独立音频文件
      const remainingAudios = audioFiles.filter((_, idx) => !consumedAudioIndices.has(idx));
      const openAudioInNewTabs =
        Boolean(opts?.standaloneAudioInNewTab) || remainingAudios.length > 1;
      for (const audioFile of remainingAudios) {
        try {
          let targetTabId = useEditorStore.getState().activeTabId;
          if (openAudioInNewTabs) {
            flushActiveEdits();
            const st = useEditorStore.getState();
            const curActiveTab = st.tabs.find((t) => t.id === st.activeTabId);
            const { stem } = splitFileStemAndExt(audioFile.name);
            const targetName = `${stem || audioFile.name}.TextGrid`;
            const canReuseBlank = Boolean(
              curActiveTab &&
                curActiveTab.kind !== 'corpus' &&
                curActiveTab.isBlankPlaceholder &&
                !curActiveTab.isDirty &&
                !curActiveTab.audioName
            );
            if (canReuseBlank && curActiveTab) {
              setDocument(createSample('blank').tg, targetName, [], 0, {
                filePath: null,
                fileFormat: 'longText',
                isBlankPlaceholder: true,
                baselineKind: 'blank'
              });
              targetTabId = curActiveTab.id;
              syncPlayerForTab(targetTabId);
            } else {
              playerRef.current?.stop(false);
              targetTabId = useEditorStore.getState().createNewTab({
                tg: createSample('blank').tg,
                filename: targetName,
                isBlankPlaceholder: true,
                baselineKind: 'blank'
              });
              syncPlayerForTab(targetTabId);
            }
            openedTabIds.push(targetTabId);
          }
          await loadAudioBytesForTab(targetTabId, audioFile.bytes, audioFile.name, 0);
          if (!silent) showToast(`已载入录音：${audioFile.name}`);
        } catch (err) {
          if (!silent) showToast(`音频解码失败：${String(err)}`, true);
        }
      }

      return openedTabIds;
    },
    [
      evictTabAudio,
      flushActiveEdits,
      handleSwitchTab,
      isDesktop,
      loadAudioBytesForTab,
      setAudioMetaForTab,
      setDocument,
      showToast,
      syncPlayerForTab
    ]
  );

  const readDropEntryBytes = useCallback(async (entry: DropInputEntry): Promise<Uint8Array | null> => {
    if (entry.path) {
      const cached = bulkDropPreloadedBytesRef.current.get(normalizeDropPathKey(entry.path));
      if (cached) return cached;
      const opened = await getPlatformBridge().readNativeFile(entry.path);
      return opened?.bytes ?? null;
    }
    if (entry.file) {
      return new Uint8Array(await entry.file.arrayBuffer());
    }
    return null;
  }, []);

  const openDroppedDirectories = useCallback(
    async (dirs: DropDirectoryCandidate[], opts?: { silent?: boolean }): Promise<number> => {
      const bridge = getPlatformBridge();
      let openedCount = 0;
      for (const dir of dirs) {
        if (dir.alreadyOpenTabId) {
          handleSwitchTab(dir.alreadyOpenTabId);
          continue;
        }
        try {
          let adapter: CorpusWorkspaceAdapter | null = null;
          if (isDesktop && dir.path) {
            adapter = await openTauriCorpusAdapter(bridge, dir.path);
          } else if (dir.dirHandle) {
            adapter = await createWebFsaCorpusAdapterFromHandle(dir.dirHandle);
          } else if (dir.dirFiles && dir.dirFiles.length > 0) {
            adapter = createWebFallbackCorpusAdapter(dir.dirFiles, dir.name);
          }
          if (adapter) {
            const tabId = await openCorpusWithAdapter(adapter, { silent: opts?.silent });
            if (tabId) openedCount += 1;
          } else if (!opts?.silent) {
            showToast(`文件夹「${dir.name}」中没有可打开的文件`, true);
          }
        } catch (err) {
          showToast(`打开文件夹「${dir.name}」失败：${String(err)}`, true);
        }
      }
      return openedCount;
    },
    [handleSwitchTab, isDesktop, openCorpusWithAdapter, showToast]
  );

  const openDroppedUnits = useCallback(
    async (
      units: DropOpenUnit[],
      opts?: { silent?: boolean; standaloneStyleFiles?: DropInputEntry[] }
    ): Promise<number> => {
      const payloads: IncomingFilePayload[] = [];
      let directAudioAttachCount = 0;
      for (const unit of units) {
        if (unit.alreadyOpenTabId && !unit.audio && !unit.styleSidecar) {
          handleSwitchTab(unit.alreadyOpenTabId);
          continue;
        }
        if (unit.doc) {
          try {
            const bytes = await readDropEntryBytes(unit.doc);
            if (bytes) {
              payloads.push({
                name: unit.doc.name,
                bytes,
                path: unit.doc.path ?? null
              });
            }
          } catch (err) {
            showToast(`读取文件「${unit.doc.name}」失败：${String(err)}`, true);
          }
        }
        if (unit.styleSidecar) {
          try {
            const bytes = await readDropEntryBytes(unit.styleSidecar);
            if (bytes) {
              payloads.push({
                name: unit.styleSidecar.name,
                bytes,
                path: unit.styleSidecar.path ?? null
              });
            }
          } catch (err) {
            showToast(`读取样式文件「${unit.styleSidecar.name}」失败：${String(err)}`, true);
          }
        }
        if (unit.audio) {
          try {
            const bytes = await readDropEntryBytes(unit.audio);
            if (bytes) {
              payloads.push({
                name: unit.audio.name,
                bytes,
                path: unit.audio.path ?? null
              });
              if (!unit.doc) directAudioAttachCount += 1;
            }
          } catch (err) {
            showToast(`读取音频「${unit.audio.name}」失败：${String(err)}`, true);
          }
        }
      }
      if (opts?.standaloneStyleFiles && opts.standaloneStyleFiles.length > 0) {
        for (const styleEntry of opts.standaloneStyleFiles) {
          try {
            const bytes = await readDropEntryBytes(styleEntry);
            if (bytes) {
              payloads.push({
                name: styleEntry.name,
                bytes,
                path: styleEntry.path ?? null
              });
            }
          } catch (err) {
            showToast(`读取样式文件「${styleEntry.name}」失败：${String(err)}`, true);
          }
        }
      }
      if (payloads.length === 0) return 0;
      const standaloneAudioInNewTab = units.length > 1 && directAudioAttachCount > 0;
      const ids = await openFilePayloads(payloads, {
        silent: opts?.silent,
        standaloneAudioInNewTab
      });
      return ids.length;
    },
    [handleSwitchTab, openFilePayloads, readDropEntryBytes, showToast]
  );

  const processDropEntries = useCallback(
    async (entries: DropInputEntry[]) => {
      if (entries.length === 0) {
        bulkDropPreloadedBytesRef.current.clear();
        return;
      }
      const st = useEditorStore.getState();
      const plan = analyzeDropIntake(entries, {
        findOpenFileTabId: (p) => st.findTabByPath(p)?.id ?? null,
        findOpenCorpusTabId: (dirPath) =>
          st.findCorpusTabByRootKey(`tauri:${normalizeDropPathKey(dirPath)}`)?.id ?? null
      });

      if (plan.decision === 'empty') {
        bulkDropPreloadedBytesRef.current.clear();
        if (plan.unsupported.length > 0) {
          showToast(
            `未发现可打开的 TextGrid、音频或样式文件（已忽略 ${plan.unsupported.length} 个不支持的文件）`
          );
        }
        return;
      }

      if (plan.decision === 'switch-existing') {
        bulkDropPreloadedBytesRef.current.clear();
        const first = plan.alreadyOpen[0];
        if (first) {
          handleSwitchTab(first.tabId);
        }
        const suffix =
          plan.unsupported.length > 0
            ? `（已忽略 ${plan.unsupported.length} 个不支持的文件）`
            : '';
        showToast(`所拖入的文件均已在标签栏打开${suffix}`);
        return;
      }

      if (plan.decision === 'confirm') {
        setBulkDropPlan(plan);
        return;
      }

      // 直接放行模式
      try {
        const silentPerFile =
          plan.directories.length + plan.openUnits.length + plan.standaloneStyleFiles.length > 1 ||
          plan.unsupported.length > 0;
        const dirCount = await openDroppedDirectories(plan.directories, { silent: silentPerFile });
        const fileCount = await openDroppedUnits(plan.openUnits, {
          silent: silentPerFile,
          standaloneStyleFiles: plan.standaloneStyleFiles
        });
        if (silentPerFile) {
          const openedTotal = dirCount + fileCount;
          const parts: string[] = [];
          if (openedTotal > 0) parts.push(`已打开 ${openedTotal} 项`);
          if (plan.standaloneStyleFiles.length > 0) {
            parts.push(`应用 ${plan.standaloneStyleFiles.length} 个样式文件`);
          }
          if (plan.alreadyOpen.length > 0) parts.push(`跳过 ${plan.alreadyOpen.length} 个已打开项`);
          if (plan.unsupported.length > 0) parts.push(`忽略 ${plan.unsupported.length} 个不支持的文件`);
          if (parts.length > 0) {
            showToast(parts.join('，'));
          }
        }
      } finally {
        bulkDropPreloadedBytesRef.current.clear();
      }
    },
    [handleSwitchTab, openDroppedDirectories, openDroppedUnits, showToast]
  );

  const handleBulkDropCancel = useCallback(() => {
    if (bulkDropBusyRef.current) return;
    setBulkDropPlan(null);
    bulkDropPreloadedBytesRef.current.clear();
  }, []);

  const handleBulkDropOpenAsCorpus = useCallback(async () => {
    const plan = bulkDropPlanRef.current;
    const rec = plan?.corpusRecommendation;
    if (!plan || !rec || bulkDropBusyRef.current) return;

    setBulkDropBusy(true);
    try {
      let adapter: CorpusWorkspaceAdapter | null = null;
      if (rec.mode === 'tauri-dir') {
        adapter = await openTauriCorpusAdapter(getPlatformBridge(), rec.dirPath);
        if (adapter) {
          await openCorpusWithAdapter(adapter, {
            preferredItemId: rec.preferredItemStem ?? null
          });
        }
      } else {
        adapter = createWebFallbackCorpusAdapter(rec.files, rec.folderName);
        if (adapter) {
          await openCorpusWithAdapter(adapter);
        }
      }
      setBulkDropPlan(null);
      bulkDropPreloadedBytesRef.current.clear();
    } catch (err) {
      showToast(`以词表文件夹打开失败：${String(err)}`, true);
    } finally {
      setBulkDropBusy(false);
    }
  }, [openCorpusWithAdapter, showToast]);

  const handleBulkDropOpenSelected = useCallback(
    async (selection: BulkDropSelectionPayload) => {
      const plan = bulkDropPlanRef.current;
      if (!plan || bulkDropBusyRef.current) return;

      const dirSet = new Set(selection.dirIds);
      const unitSet = new Set(selection.unitIds);
      let budget = BULK_DROP_MAX_INDIVIDUAL_TABS;
      const chosenDirs: DropDirectoryCandidate[] = [];
      for (const d of plan.directories) {
        if (!dirSet.has(d.id) || d.alreadyOpenTabId) continue;
        if (budget <= 0) break;
        chosenDirs.push(d);
        budget -= 1;
      }
      const chosenUnits: DropOpenUnit[] = [];
      for (const u of plan.openUnits) {
        if (!unitSet.has(u.id) || u.alreadyOpenTabId) continue;
        if (budget <= 0) break;
        chosenUnits.push(u);
        budget -= 1;
      }

      if (chosenDirs.length === 0 && chosenUnits.length === 0) {
        setBulkDropPlan(null);
        bulkDropPreloadedBytesRef.current.clear();
        return;
      }

      setBulkDropBusy(true);
      try {
        const dirCount = await openDroppedDirectories(chosenDirs, { silent: true });
        const unitCount = await openDroppedUnits(chosenUnits, { silent: true });
        const total = dirCount + unitCount;
        if (total > 0) {
          showToast(`已打开 ${total} 个标签页`);
        }
        setBulkDropPlan(null);
        bulkDropPreloadedBytesRef.current.clear();
      } finally {
        setBulkDropBusy(false);
      }
    },
    [openDroppedDirectories, openDroppedUnits, showToast]
  );

  const openFiles = useCallback(
    async (files: FileList | File[]) => {
      await processDropEntries(entriesFromFiles(files));
    },
    [processDropEntries]
  );

  const handleOpenTextGridPicker = useCallback(async () => {
    if (isDesktop) {
      try {
        const opened = await getPlatformBridge().openNativeFileDialog(
          [
            {
              name: 'Praat 标注、音频与样式文件',
              extensions: [
                'TextGrid',
                'textgrid',
                'Collection',
                'collection',
                'IntervalTier',
                'TextTier',
                'txt',
                'wav',
                'mp3',
                'ogg',
                'flac',
                'm4a',
                'svg',
                'json'
              ]
            },
            { name: '所有文件', extensions: ['*'] }
          ],
          { title: '打开标注或音频文件', multiple: true }
        );
        if (opened && opened.length > 0) {
          if (opened.length === 1) {
            await openFilePayloads(opened);
            return;
          }
          bulkDropPreloadedBytesRef.current.clear();
          const entries: DropInputEntry[] = opened.map((item, idx) => {
            const normKey = normalizeDropPathKey(item.path);
            bulkDropPreloadedBytesRef.current.set(normKey, item.bytes);
            const sepIdx = Math.max(item.path.lastIndexOf('\\'), item.path.lastIndexOf('/'));
            const parentDir = sepIdx > 0 ? item.path.slice(0, sepIdx) : '';
            return {
              id: `picker_${idx}_${normKey}`,
              name: item.name,
              isDir: false,
              size: item.bytes.byteLength,
              path: item.path,
              parentDir
            };
          });
          await processDropEntries(entries);
        }
      } catch (err) {
        showToast(`打开文件失败：${String(err)}`, true);
      }
      return;
    }
    tgInputRef.current?.click();
  }, [isDesktop, openFilePayloads, processDropEntries, showToast]);

  const handleOpenAudioPicker = useCallback(async () => {
    if (isDesktop) {
      try {
        const opened = await getPlatformBridge().openNativeFileDialog(
          [
            { name: '音频文件', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm'] },
            { name: '所有文件', extensions: ['*'] }
          ],
          { title: '打开录音文件', multiple: false }
        );
        if (opened && opened.length > 0) {
          await openFilePayloads(opened);
        }
      } catch (err) {
        showToast(`打开录音失败：${String(err)}`, true);
      }
      return;
    }
    audioInputRef.current?.click();
  }, [isDesktop, openFilePayloads, showToast]);

  // Initialize bridge (WASM or Tauri), prefetch trigraphs, and load launch file arg or restore last desktop session
  useEffect(() => {
    let active = true;
    const bridge = getPlatformBridge();
    void bridge.init().then(async () => {
      if (!active) return;

      if (isDesktop) {
        try {
          const launchPath = await bridge.getLaunchFileArg();
          if (launchPath && active) {
            const opened = await bridge.readNativeFile(launchPath);
            if (opened && active) {
              await openFilePayloads([opened], { replaceActiveTab: true });
              if (active) {
                sessionRestoredRef.current = true;
              }
              return;
            }
          }
        } catch {
          // Fall back to session restore or initial sample if launch arg failed
        }

        if (active && useEditorStore.getState().restoreSessionOnStartup) {
          const savedSession = loadPersistedSession();
          if (savedSession && savedSession.tabs.length > 0) {
            const initialSt = useEditorStore.getState();
            const initialTab = initialSt.tabs.length === 1 ? initialSt.tabs[0] : null;
            const initialBlankId =
              initialTab &&
              initialTab.kind !== 'corpus' &&
              initialTab.isBlankPlaceholder &&
              !initialTab.isDirty &&
              !initialTab.audioName
                ? initialTab.id
                : null;

            const restoredTabIds: Array<string | null> = [];
            let restoredCount = 0;

            for (const entry of savedSession.tabs) {
              if (!active) return;
              if (entry.kind === 'single') {
                try {
                  const opened = await bridge.readNativeFile(entry.filePath);
                  if (!opened || !active) {
                    restoredTabIds.push(null);
                    continue;
                  }
                  const ids = await openFilePayloads([opened], {
                    replaceActiveTab: restoredCount === 0 && Boolean(initialBlankId),
                    silent: true
                  });
                  if (ids.length > 0) {
                    restoredTabIds.push(ids[0]);
                    restoredCount++;
                  } else {
                    restoredTabIds.push(null);
                  }
                } catch {
                  restoredTabIds.push(null);
                }
              } else {
                try {
                  const adapter = await openTauriCorpusAdapter(bridge, entry.dirPath);
                  if (!adapter || !active) {
                    restoredTabIds.push(null);
                    continue;
                  }
                  const tabId = await openCorpusWithAdapter(adapter, {
                    preferredItemId: entry.activeItemId ?? null,
                    silent: true
                  });
                  if (tabId) {
                    restoredTabIds.push(tabId);
                    restoredCount++;
                  } else {
                    restoredTabIds.push(null);
                  }
                } catch {
                  restoredTabIds.push(null);
                }
              }
            }

            if (!active) return;

            if (restoredCount > 0) {
              if (initialBlankId) {
                const stillBlank = useEditorStore
                  .getState()
                  .tabs.find(
                    (t) =>
                      t.id === initialBlankId &&
                      t.kind !== 'corpus' &&
                      t.isBlankPlaceholder &&
                      !t.isDirty &&
                      !t.audioName
                  );
                if (stillBlank && useEditorStore.getState().tabs.length > 1) {
                  closeTabAndCleanup(initialBlankId);
                }
              }

              const targetTabId =
                restoredTabIds[savedSession.activeIndex] ??
                restoredTabIds.find((id): id is string => Boolean(id)) ??
                null;
              if (targetTabId && useEditorStore.getState().tabs.some((t) => t.id === targetTabId)) {
                handleSwitchTab(targetTabId);
              }

              sessionRestoredRef.current = true;
              persistDesktopSessionNow();
              showToast(`已恢复上次未关闭的 ${restoredCount} 个标签页`);
              return;
            }
          }
        }

        if (active) {
          sessionRestoredRef.current = true;
        }
      }

      await prefetchTrigraphCache(useEditorStore.getState().tg, bridge);
      if (active) useEditorStore.getState().bumpDocVersion();
    });
    return () => {
      active = false;
    };
  }, [
    isDesktop,
    closeTabAndCleanup,
    handleSwitchTab,
    openCorpusWithAdapter,
    openFilePayloads,
    persistDesktopSessionNow,
    showToast
  ]);

  // Trigger IPA WebFont load & re-measure Canvas text layout once ready (eliminates cold-start width drift)
  useEffect(() => {
    if (typeof document === 'undefined' || !('fonts' in document)) return;
    const fontSet = document.fonts;
    let active = true;
    const triggerReflow = () => {
      if (!active) return;
      resetFontMeasureCache();
      useEditorStore.getState().bumpDocVersion();
    };
    const isIpaFace = (f: FontFace) => {
      const fam = f.family.replace(/['"]/g, '').trim();
      return fam === 'TGrid IPA Sans' || fam === 'TGrid IPA Serif';
    };
    const onLoadingDone = (ev: Event) => {
      const faces = (ev as FontFaceSetLoadEvent).fontfaces;
      if (!faces || faces.length === 0 || faces.some(isIpaFace)) {
        triggerReflow();
      }
    };
    fontSet.addEventListener?.('loadingdone', onLoadingDone);
    void fontSet.load?.('400 12.5px "TGrid IPA Sans"').catch(() => []);
    void fontSet.ready.then(() => {
      triggerReflow();
    });
    return () => {
      active = false;
      fontSet.removeEventListener?.('loadingdone', onLoadingDone);
    };
  }, []);

  // Zero-white-flash startup reveal on desktop (with guaranteed safety-net timeout)
  useEffect(() => {
    if (!isDesktop) return;
    let shown = false;
    const revealWindow = async () => {
      if (shown) return;
      shown = true;
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().show();
      } catch {
        // ignore
      }
    };

    const safetyTimer = window.setTimeout(() => {
      void revealWindow();
    }, 320);

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        window.clearTimeout(safetyTimer);
        void revealWindow();
      });
    });

    return () => {
      window.clearTimeout(safetyTimer);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [isDesktop]);

  // 启动时探活 IndexedDB 恢复库（处理 file:// 离线降级）、空闲回收超期快照，并检查桌面端未自动打开的异常退出残留项目
  useEffect(() => {
    let active = true;
    void (async () => {
      const probe = await probeRecoveryStorage();
      if (!active || probe.degraded) return;
      await pruneRecoveryStorage();
      if (!active || !isDesktop) return;
      // 延迟检查孤立异常退出词表（避免与启动恢复会话竞态）
      window.setTimeout(() => {
        if (!active) return;
        void (async () => {
          const projects = await listRecoveryProjects();
          if (!active || projects.length === 0) return;
          const openKeys = new Set(
            useEditorStore
              .getState()
              .tabs.filter((t) => t.kind === 'corpus' && t.corpus)
              .map((t) => t.corpus!.rootKey)
          );
          const orphans = projects.filter(
            (p) =>
              p.mode === 'tauri' &&
              Boolean(p.nativeDirPath) &&
              (p.draftCount > 0 || hasRecoveryMetaDelta(p)) &&
              !openKeys.has(p.projectKey)
          );
          if (active && orphans.length > 0) {
            setOrphanRecoveryProjects(orphans);
          }
        })();
      }, 900);
    })();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushAllPendingRecovery();
      }
    };
    const onPageHide = () => {
      flushAllPendingRecovery();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [flushAllPendingRecovery, isDesktop]);

  // Custom Architectural Unsaved-Changes Close Guard on Desktop (and beforeunload on Web)
  useEffect(() => {
    if (!isDesktop) {
      const onBeforeUnload = (e: BeforeUnloadEvent) => {
        flushAllPendingRecovery();
        const st = useEditorStore.getState();
        const hasSingleDirty = st.tabs.some((t) => t.kind !== 'corpus' && t.isDirty);
        const hasPendingCorpus = st.tabs.some((t) => {
          if (t.kind !== 'corpus' || !t.corpus) return false;
          if (t.isDirty) return true;
          if (corpusDraftManager.isProjectDirty(t.corpus.projectId)) return true;
          if (t.corpus.unsavedItemIds.length > 0 || t.corpus.projectIndexDirty) return true;
          if (!t.corpus.writable) {
            const adapter = getCorpusAdapter(t.corpus.projectId);
            return (adapter?.getPendingExportCount() ?? t.corpus.dirtyCount) > 0;
          }
          return false;
        });
        if (hasSingleDirty || hasPendingCorpus) {
          e.preventDefault();
          e.returnValue = '';
        }
      };
      window.addEventListener('beforeunload', onBeforeUnload);
      return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }

    let unlisten: (() => void) | null = null;
    let active = true;

    const buildWindowDirtyEntries = (): UnsavedWindowTabEntry[] => {
      const curTabs = useEditorStore.getState().tabs;
      const entries: UnsavedWindowTabEntry[] = [];
      for (const tab of curTabs) {
        if (tab.kind === 'corpus' && tab.corpus) {
          const detail = buildUnsavedCorpusDetail(tab.id);
          if (detail) {
            entries.push({
              id: tab.id,
              filename: tab.corpus.projectName,
              corpus: detail
            });
          }
        } else if (tab.isDirty) {
          entries.push({ id: tab.id, filename: tab.filename });
        }
      }
      return entries;
    };

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested((event) => {
          flushActiveEdits();
          flushAllPendingRecovery();
          persistDesktopSessionNow();

          const stNow = useEditorStore.getState();
          // 仅在用户主动开启自动保存时才自动落盘；默认手动模式下绝不静默覆写原磁盘文件
          if (stNow.corpusAutoSave) {
            const writableDirtyCorpus = stNow.tabs.filter(
              (t) =>
                t.kind === 'corpus' &&
                t.corpus &&
                t.corpus.writable &&
                Boolean(buildUnsavedCorpusDetail(t.id))
            );
            if (writableDirtyCorpus.length > 0) {
              event.preventDefault();
              void (async () => {
                for (const cTab of writableDirtyCorpus) {
                  await saveAllCorpusEntries(cTab.id, { silent: true });
                }
                const remaining = buildWindowDirtyEntries();
                if (remaining.length === 0) {
                  await destroyDesktopWindow();
                  return;
                }
                setUnsavedDialog({ mode: 'window', dirtyTabs: remaining });
              })();
              return;
            }
          }

          const dirtyEntries = buildWindowDirtyEntries();
          if (dirtyEntries.length === 0) return;
          event.preventDefault();
          setUnsavedDialog({ mode: 'window', dirtyTabs: dirtyEntries });
        });
        if (!active && unlisten) {
          unlisten();
          unlisten = null;
        }
      } catch {
        // ignore
      }
    })();

    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, [
    isDesktop,
    buildUnsavedCorpusDetail,
    destroyDesktopWindow,
    flushActiveEdits,
    flushAllPendingRecovery,
    persistDesktopSessionNow,
    saveAllCorpusEntries
  ]);

  // Native Tauri drag-and-drop listener (reads real OS paths + companion audio)
  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | null = null;
    let active = true;

    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const bridge = getPlatformBridge();
        unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
          if (!active) return;
          if (event.payload.type === 'enter') {
            setDropActive(true);
          } else if (event.payload.type === 'leave') {
            setDropActive(false);
          } else if (event.payload.type === 'drop') {
            setDropActive(false);
            const paths = event.payload.paths || [];
            if (paths.length === 0) return;
            try {
              if (typeof bridge.inspectDroppedPaths === 'function') {
                const infos = await bridge.inspectDroppedPaths(paths);
                if (infos) {
                  const entries = entriesFromDroppedPaths(infos);
                  await processDropEntries(entries);
                  return;
                }
              }
            } catch (err) {
              showToast(`检查拖入文件失败：${String(err)}`, true);
              return;
            }
            const payloads: IncomingFilePayload[] = [];
            for (const p of paths) {
              try {
                const opened = await bridge.readNativeFile(p);
                if (opened) payloads.push(opened);
              } catch (err) {
                showToast(`读取拖入文件失败：${String(err)}`, true);
              }
            }
            if (payloads.length > 0) {
              await openFilePayloads(payloads);
            }
          }
        });
        if (!active && unlisten) {
          unlisten();
          unlisten = null;
        }
      } catch {
        // ignore
      }
    })();

    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, [isDesktop, openFilePayloads, processDropEntries, showToast]);

  const loadSample = useCallback(
    async (id: BuiltinSampleId) => {
      if (id === 'blank') {
        handleNewTab();
        showToast('已新建空白标签页');
        return;
      }

      if (id === 'corpus') {
        const corpusDemo = createCorpusSample();
        const existingTab = useEditorStore.getState().findCorpusTabByRootKey(corpusDemo.rootKey);
        if (existingTab) {
          handleSwitchTab(existingTab.id);
          showToast(`已切换至示例：${corpusDemo.projectName}`);
          return;
        }

        const bridge = getPlatformBridge();
        const files: Array<{ relPath: string; bytes: Uint8Array }> = [];
        const persistedItems: Record<
          string,
          {
            audioRelPath: string;
            tgRelPath: string;
            status: CorpusItemStatus;
            duration: number;
            label: string;
            ipaPreview: string;
            note: string;
            updatedAt: number;
          }
        > = {};

        for (const item of corpusDemo.items) {
          const tgRelPath = `${item.id}.TextGrid`;
          const tgBytes = await bridge.serializeTextGrid(item.tg, 'longText');
          files.push({ relPath: tgRelPath, bytes: tgBytes });
          persistedItems[item.id.toLowerCase()] = {
            audioRelPath: '',
            tgRelPath,
            status: item.status,
            duration: item.duration,
            label: item.label,
            ipaPreview: item.ipaPreview,
            note: item.note,
            updatedAt: 0
          };
        }

        const projectFileJson = {
          schemaVersion: 1,
          projectName: corpusDemo.projectName,
          updatedAt: new Date().toISOString(),
          defaultSaveFormat: 'longText',
          tierTemplate: corpusDemo.tierTemplate,
          activeItemId: corpusDemo.activeItemId.toLowerCase(),
          options: {
            autoPlay: false,
            autoVad: false,
            targetTierIndex: 1
          },
          items: persistedItems
        };
        files.push({
          relPath: CORPUS_PROJECT_FILENAME,
          bytes: new TextEncoder().encode(`${JSON.stringify(projectFileJson, null, 2)}\n`)
        });

        const adapter = createMemoryCorpusAdapter({
          rootKey: corpusDemo.rootKey,
          projectName: corpusDemo.projectName,
          files
        });
        await openCorpusWithAdapter(adapter);
        return;
      }

      const sample = createSample(id);
      const bridge = getPlatformBridge();
      await prefetchTrigraphCache(sample.tg, bridge);

      flushActiveEdits();
      const st = useEditorStore.getState();
      const curActiveTab = st.tabs.find((t) => t.id === st.activeTabId);
      const reuseCurrent = Boolean(
        curActiveTab &&
          curActiveTab.kind !== 'corpus' &&
          !curActiveTab.isDirty &&
          !curActiveTab.currentFilePath
      );

      let targetTabId: string;
      if (reuseCurrent && curActiveTab) {
        await evictTabAudio(curActiveTab.id);
        setDocument(sample.tg, sample.tg.name, [], 0, {
          filePath: null,
          fileFormat: 'longText',
          isBlankPlaceholder: false,
          baselineKind: 'sample'
        });
        targetTabId = curActiveTab.id;
        syncPlayerForTab(targetTabId);
      } else {
        playerRef.current?.stop(false);
        targetTabId = useEditorStore.getState().createNewTab({
          tg: sample.tg,
          filename: sample.tg.name,
          filePath: null,
          fileFormat: 'longText',
          isBlankPlaceholder: false,
          baselineKind: 'sample'
        });
        syncPlayerForTab(targetTabId);
      }

      if (sample.audioUrl) {
        const seq = (audioLoadSeqRef.current.get(targetTabId) ?? 0) + 1;
        audioLoadSeqRef.current.set(targetTabId, seq);
        useEditorStore.getState().setAudioLoadingForTab(targetTabId, true);
        try {
          const resp = await fetch(sample.audioUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const ab = await resp.arrayBuffer();
          if (audioLoadSeqRef.current.get(targetTabId) !== seq) return;
          await loadAudioBytesForTab(targetTabId, new Uint8Array(ab), sample.audioName || 'sample.wav', 0);
          if (audioLoadSeqRef.current.get(targetTabId) !== seq) return;
          showToast(`已载入示例与配套录音：${sample.label}`);
        } catch {
          if (audioLoadSeqRef.current.get(targetTabId) !== seq) return;
          await evictTabAudio(targetTabId);
          showToast('已载入示例标注（离线模式下可手动点击「打开录音」载入音频）');
        } finally {
          if (audioLoadSeqRef.current.get(targetTabId) === seq) {
            useEditorStore.getState().setAudioLoadingForTab(targetTabId, false);
          }
        }
      } else {
        showToast(`已切换示例：${sample.label}`);
      }
    },
    [
      evictTabAudio,
      flushActiveEdits,
      handleNewTab,
      handleSwitchTab,
      loadAudioBytesForTab,
      openCorpusWithAdapter,
      setDocument,
      showToast,
      syncPlayerForTab
    ]
  );

  const handleStartPlayback = useCallback((startT: number, endT: number) => {
    playerRef.current?.start(startT, endT);
  }, []);

  const handleOpenSplitModal = useCallback((tierIndex: number, itemIndex: number) => {
    const st = useEditorStore.getState();
    if (st.mode === 'read') {
      showToast('请先切换至编辑模式');
      return;
    }
    const tier = st.tg.tiers[tierIndex];
    if (!tier || tier.kind !== 'intervalTier') return;
    const iv = tier.intervals[itemIndex];
    if (!iv || iv.xmax <= iv.xmin) return;
    const peerTexts: string[] = [];
    for (let idx = Math.max(0, itemIndex - 20); idx < itemIndex; idx++) {
      const t = tier.intervals[idx]?.text.trim();
      if (t) peerTexts.push(t);
    }
    for (
      let idx = itemIndex + 1;
      idx < Math.min(tier.intervals.length, itemIndex + 21);
      idx++
    ) {
      const t = tier.intervals[idx]?.text.trim();
      if (t) peerTexts.push(t);
    }
    setSplitModalState({
      tierIndex,
      itemIndex,
      tierName: tier.name || `层 ${tierIndex + 1}`,
      text: iv.text,
      xmin: iv.xmin,
      xmax: iv.xmax,
      peerTexts
    });
  }, [showToast]);

  const handleSplitModalConfirm = useCallback(
    async (payload: SplitEqualConfirmPayload) => {
      const dlg = splitModalState;
      setSplitModalState(null);
      if (!dlg) return;

      const st0 = useEditorStore.getState();
      if (payload.mode === 'count') {
        st0.splitIntervalEqualN(dlg.tierIndex, dlg.itemIndex, payload.count);
        return;
      }

      const seq = ++splitModalRunSeqRef.current;
      const startTabId = st0.activeTabId;
      const startCorpusEntryId = st0.corpusActiveEntryId;

      let texts: string[];
      let granularity: SmartSplitGranularity;
      let durationWeights: number[];
      let acousticClasses: AcousticSegmentClass[];
      let useAcoustic: boolean;
      let strategyLabel: string;
      let metaTitle: string;

      if (payload.mode === 'smart') {
        texts = payload.candidate.texts;
        granularity = payload.candidate.granularity;
        durationWeights = payload.candidate.durationWeights;
        acousticClasses = payload.candidate.acousticClasses;
        useAcoustic = payload.useAcoustic;
        strategyLabel = payload.candidate.strategyLabel;
        metaTitle = `智能拆分（${strategyLabel}）`;
      } else if (payload.mode === 'chars') {
        texts = payload.texts;
        granularity = 'syllable';
        durationWeights = texts.map(() => 1);
        acousticClasses = texts.map(() => 'syllable');
        useAcoustic = Boolean(payload.useAcoustic);
        strategyLabel = '按字数';
        metaTitle = '按字数等分区间';
      } else {
        texts = payload.texts;
        granularity = 'delimiter';
        durationWeights = texts.map(() => 1);
        acousticClasses = texts.map(() => 'syllable');
        useAcoustic = Boolean(payload.useAcoustic);
        strategyLabel = `按${payload.delimiterLabel}分词`;
        metaTitle = '按分词等分区间';
      }

      let cuts: number[] | null = null;
      let usedAcoustic = false;

      if (useAcoustic && audioBuffer && texts.length >= 2 && dlg.xmax > dlg.xmin) {
        try {
          const res = await alignSplitBoundariesAcoustically({
            audioBuffer,
            xmin: dlg.xmin,
            xmax: dlg.xmax,
            granularity,
            durationWeights,
            acousticClasses
          });
          if (res && res.usedAcoustic && res.cuts.length === texts.length - 1) {
            cuts = res.cuts;
            usedAcoustic = true;
          }
        } catch {
          cuts = null;
          usedAcoustic = false;
        }

        if (seq !== splitModalRunSeqRef.current) return;
        const latest = useEditorStore.getState();
        if (
          latest.activeTabId !== startTabId ||
          latest.corpusActiveEntryId !== startCorpusEntryId
        ) {
          return;
        }
        const curTier = latest.tg.tiers[dlg.tierIndex];
        if (!curTier || curTier.kind !== 'intervalTier') return;
        const curIv = curTier.intervals[dlg.itemIndex];
        if (
          !curIv ||
          curIv.xmin !== dlg.xmin ||
          curIv.xmax !== dlg.xmax ||
          curIv.text !== dlg.text
        ) {
          return;
        }
      }

      const modeWord = usedAcoustic ? '声学拆分为' : '拆分为';
      useEditorStore.getState().splitIntervalWithCuts(dlg.tierIndex, dlg.itemIndex, texts, cuts, {
        title: usedAcoustic && payload.mode !== 'smart' ? `${metaTitle}（声学）` : metaTitle,
        detailPrefix: `${strategyLabel}${modeWord}`,
        toastLabel: `已${strategyLabel}${modeWord}`
      });
    },
    [audioBuffer, splitModalState]
  );

  const handleTogglePlay = useCallback(() => {
    const player = playerRef.current!;
    const st = useEditorStore.getState();
    if (player.isPlaying()) {
      player.stop(false);
      return;
    }
    const domMin = st.viewDomain && st.viewDomain.max > st.viewDomain.min ? st.viewDomain.min : st.tg.xmin;
    const domMax = st.viewDomain && st.viewDomain.max > st.viewDomain.min ? st.viewDomain.max : st.tg.xmax;
    if (st.playRange && st.playRange.end > st.playRange.start) {
      const start =
        st.currentTime >= st.playRange.start && st.currentTime < st.playRange.end - 0.002
          ? st.currentTime
          : st.playRange.start;
      player.start(start, st.playRange.end);
    } else {
      const start =
        st.currentTime >= domMin && st.currentTime < domMax - 0.002 ? st.currentTime : domMin;
      player.start(start, domMax);
    }
  }, []);

  const handleStopPlayback = useCallback(() => {
    const st = useEditorStore.getState();
    st.setPlayRange(null);
    playerRef.current?.stop(true, st.viewDomain ? st.viewDomain.min : st.tg.xmin);
  }, []);

  const handlePausePlayback = useCallback(() => {
    playerRef.current?.stop(false);
  }, []);

  const ribbonContextValue = useMemo<RibbonContextActions>(
    () => ({
      audioBuffer,
      onStartPlayback: handleStartPlayback,
      onStopPlayback: handlePausePlayback,
      onOpenSplitModal: handleOpenSplitModal
    }),
    [audioBuffer, handleStartPlayback, handlePausePlayback, handleOpenSplitModal]
  );

  const handleRateChange = useCallback(
    (rate: number) => {
      setRateStore(rate);
      playerRef.current?.setRate(rate);
    },
    [setRateStore]
  );

  const handleVolumeChange = useCallback(
    (vol: number) => {
      setVolumeStore(vol);
      playerRef.current?.setVolume(vol);
    },
    [setVolumeStore]
  );

  const handleBatchConvertIpa = useCallback(
    async (direction: 'toUnicode' | 'toPraat') => {
      flushActiveEdits();
      const bridge = getPlatformBridge();
      const st = useEditorStore.getState();
      if (st.mode === 'read') {
        showToast('请先切换至编辑模式');
        return;
      }
      const convertedTiers = new Map<number, TextGrid['tiers'][number]>();
      let changedCount = 0;

      for (let ti = 0; ti < st.tg.tiers.length; ti++) {
        const origTier = st.tg.tiers[ti];
        let cloned: TextGrid['tiers'][number] | null = null;
        if (origTier.kind === 'intervalTier') {
          for (let ii = 0; ii < origTier.intervals.length; ii++) {
            const iv = origTier.intervals[ii];
            if (!iv.text) continue;
            const res =
              direction === 'toUnicode'
                ? await bridge.decodePraatTrigraphs(iv.text)
                : await bridge.encodePraatTrigraphs(iv.text);
            if (res.changed) {
              if (!cloned) cloned = cloneTier(origTier);
              cloned.intervals[ii].text = res.text;
              changedCount++;
            }
          }
        } else {
          for (let pi = 0; pi < origTier.points.length; pi++) {
            const pt = origTier.points[pi];
            if (!pt.mark) continue;
            const res =
              direction === 'toUnicode'
                ? await bridge.decodePraatTrigraphs(pt.mark)
                : await bridge.encodePraatTrigraphs(pt.mark);
            if (res.changed) {
              if (!cloned) cloned = cloneTier(origTier);
              cloned.points[pi].mark = res.text;
              changedCount++;
            }
          }
        }
        if (cloned) {
          convertedTiers.set(ti, cloned);
        }
      }

      if (changedCount === 0) {
        showToast(direction === 'toUnicode' ? '未发现可转换的 Praat 音标编码' : '未发现可转换的 Unicode 音标');
        return;
      }
      const previewTg: TextGrid = {
        ...st.tg,
        tiers: st.tg.tiers.map((t, i) => convertedTiers.get(i) ?? t)
      };
      await prefetchTrigraphCache(previewTg, bridge);
      useEditorStore.getState().commitTgMutation(
        (d) => {
          for (const [ti, nextTier] of convertedTiers) {
            if (d.tiers[ti]) d.tiers[ti] = nextTier;
          }
        },
        undefined,
        {
          type: 'convert-ipa',
          title: '批量转换音标',
          detail:
            direction === 'toUnicode'
              ? `转为 Unicode IPA · 共 ${changedCount} 处`
              : `转为 Praat 编码 · 共 ${changedCount} 处`,
          icon: direction === 'toUnicode' ? 'convertUnicode' : 'convertPraat'
        }
      );
      showToast(
        direction === 'toUnicode'
          ? `已转换 ${changedCount} 处为 Unicode IPA`
          : `已转换 ${changedCount} 处为 Praat 编码`
      );
    },
    [flushActiveEdits, showToast]
  );

  const quickExportImage = useCallback(
    async (fmt: 'svg' | 'png') => {
      if (quickExportBusyRef.current) return;
      quickExportBusyRef.current = true;
      showToast(fmt === 'png' ? '正在生成高清图像…' : '正在生成矢量图像…');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const st = useEditorStore.getState();
      const bridge = getPlatformBridge();
      const prefs = { ...loadExportPrefs(), format: fmt };
      const stem = getBaseStem(st.filename);
      const input = {
        bridge,
        tg: st.tg,
        filename: st.filename,
        prefs,
        tierIndices: st.tg.tiers.map((_, i) => i),
        previewMode: false,
        stageWidth: Math.max(320, window.innerWidth - 56),
        uiWrapMode: st.wrapMode,
        uiScaleMode: st.scaleMode,
        uiTargetWidth: st.targetWidth,
        uiWidthAutoFit: st.widthAutoFit,
        viewDomain: st.viewDomain,
        playRange: st.playRange,
        selection: st.selection,
        hasAudio: Boolean(st.audioName && audioBuffer),
        audioBuffer,
        audioOffset: st.audioOffset,
        analysis: st.analysis,
        showSpectrogram: st.showSpectrogram,
        cueMode: st.cueMode,
        tierOrder: st.tierOrder,
        maxFreq: st.maxFreq,
        f0RangeOverride: resolveF0RangeOverride(st.f0RangeMode, st.f0RangeCustom),
        styleDoc: st.styleDoc,
        bwPrintMode: st.styleDoc.bwPrintMode || prefs.palette === 'bw',
        showStyleLegend: st.styleDoc.showLegendInExport,
        embedProjectMetadata: true
      };

      try {
        if (fmt === 'png') {
          const res = await renderOffscreenPngBlob(input);
          if (isDesktop) {
            const bytes = new Uint8Array(await res.blob.arrayBuffer());
            const savedPath = await bridge.saveNativeFileDialog(
              `${stem}.png`,
              [{ name: '高清图片 (PNG)', extensions: ['png'] }],
              bytes,
              { title: '导出高清图片' }
            );
            if (savedPath) {
              showToast(`已导出高清图片 (${res.width}×${res.height})`, false, makeRevealAction(savedPath));
            }
          } else {
            triggerBlobDownload(res.blob, `${stem}.png`);
            showToast(`已导出高清图片 (${res.width}×${res.height})`);
          }
        } else {
          const res = await renderOffscreenExport(input);
          if (res.specStrategy === 'external-zip') {
            const zipBytes = await buildExportZipBytes(bridge, stem, res.svgMarkup, res.externalAssets);
            if (isDesktop) {
              const savedPath = await bridge.saveNativeFileDialog(
                `${stem}_vector_bundle.zip`,
                [{ name: '图文分离压缩包 (ZIP)', extensions: ['zip'] }],
                zipBytes,
                { title: '导出图文分离包' }
              );
              if (savedPath) {
                showToast('已导出图文分离包 (.zip)', false, makeRevealAction(savedPath));
              }
            } else {
              triggerBlobDownload(
                new Blob([zipBytes as BlobPart], { type: 'application/zip' }),
                `${stem}_vector_bundle.zip`
              );
              showToast('已导出图文分离包 (.zip)');
            }
          } else {
            if (isDesktop) {
              const svgBytes = new TextEncoder().encode(res.svgMarkup);
              const savedPath = await bridge.saveNativeFileDialog(
                `${stem}.svg`,
                [{ name: '矢量图 (SVG)', extensions: ['svg'] }],
                svgBytes,
                { title: '导出矢量图' }
              );
              if (savedPath) {
                showToast('已导出矢量图 (.svg)', false, makeRevealAction(savedPath));
              }
            } else {
              triggerBlobDownload(
                new Blob([res.svgMarkup], { type: 'image/svg+xml;charset=utf-8' }),
                `${stem}.svg`
              );
              showToast('已导出矢量图 (.svg)');
            }
          }
        }
      } catch (err) {
        showToast(`导出失败：${String(err)}`, true);
      } finally {
        quickExportBusyRef.current = false;
      }
    },
    [audioBuffer, isDesktop, makeRevealAction, showToast]
  );

  const handleExportAction = useCallback(
    async (kind: ExportActionKind) => {
      flushActiveEdits();
      const st = useEditorStore.getState();
      const bridge = getPlatformBridge();
      const stem = getBaseStem(st.filename);

      if (kind === 'dialog') {
        setExportOpen(true);
        return;
      }
      if (kind === 'poster') {
        setPosterOpen(true);
        return;
      }
      if (kind === 'svg' || kind === 'png') {
        await quickExportImage(kind);
        return;
      }

      try {
        if (kind === 'save') {
          await saveTabAsTextGrid(st.activeTabId);
          return;
        }

        if (kind === 'save-as') {
          const bytes = await bridge.serializeTextGrid(st.tg, st.currentFileFormat);
          const defaultName = `${stem}.TextGrid`;
          if (isDesktop) {
            const savedPath = await bridge.saveNativeFileDialog(
              defaultName,
              [{ name: 'Praat TextGrid 文件', extensions: ['TextGrid', 'textgrid'] }],
              bytes,
              { title: '另存为 TextGrid 文件' }
            );
            if (savedPath) {
              await persistStyleSidecarForDesktop(savedPath, st.styleDoc);
              const savedName = getPathBaseName(savedPath);
              markSaved({ filePath: savedPath, filename: savedName, fileFormat: st.currentFileFormat });
              showToast(`已另存为：${savedName}`, false, makeRevealAction(savedPath));
            }
          } else {
            triggerBlobDownload(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), defaultName);
            markSaved();
            showToast(`已保存 ${defaultName}`);
          }
          return;
        }

        if (kind === 'long' || kind === 'short' || kind === 'binary' || kind === 'chrono') {
          const fmtMap = {
            long: 'longText',
            short: 'shortText',
            binary: 'binary',
            chrono: 'chronological'
          } as const;
          const targetFmt = fmtMap[kind];
          const bytes = await bridge.serializeTextGrid(st.tg, targetFmt);
          const suffix =
            kind === 'short'
              ? '_short.TextGrid'
              : kind === 'binary'
                ? '_binary.TextGrid'
                : kind === 'chrono'
                  ? '_chronological.TextGrid'
                  : '.TextGrid';
          const defaultName = `${stem}${suffix}`;
          if (isDesktop) {
            const savedPath = await bridge.saveNativeFileDialog(
              defaultName,
              [{ name: 'Praat TextGrid 文件', extensions: ['TextGrid', 'textgrid'] }],
              bytes,
              { title: '保存 TextGrid 文件' }
            );
            if (savedPath) {
              await persistStyleSidecarForDesktop(savedPath, st.styleDoc);
              const savedName = getPathBaseName(savedPath);
              markSaved({ filePath: savedPath, filename: savedName, fileFormat: targetFmt });
              showToast(`已保存：${savedName}`, false, makeRevealAction(savedPath));
            }
          } else {
            triggerBlobDownload(
              new Blob([bytes as BlobPart], { type: 'application/octet-stream' }),
              defaultName
            );
            markSaved();
            showToast(`已保存 ${defaultName}`);
          }
          return;
        }

        // Collection export
        const colItems: CollectionItem[] =
          st.collectionTgs.length > 0
            ? st.collectionTgs.map((t, i) => ({
                type: 'TextGrid',
                ...(i === st.collectionActiveIdx ? st.tg : t)
              }))
            : [{ type: 'TextGrid', ...st.tg, name: st.tg.name || stem }];

        if (audioBuffer) {
          const channels: number[][] = [];
          for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
            channels.push(Array.from(audioBuffer.getChannelData(ch)));
          }
          const dx = 1 / audioBuffer.sampleRate;
          colItems.push({
            type: 'Sound',
            name: getBaseStem(st.audioName || stem),
            xmin: st.audioOffset,
            xmax: st.audioOffset + audioBuffer.duration,
            nx: audioBuffer.length,
            dx,
            x1: st.audioOffset + 0.5 * dx,
            ny: audioBuffer.numberOfChannels,
            channels
          });
        }

        const bytes = await bridge.serializeCollection(
          colItems,
          kind === 'col-bin' ? 'binary' : 'longText'
        );
        const fname = `${stem}.Collection`;
        if (isDesktop) {
          const savedPath = await bridge.saveNativeFileDialog(
            fname,
            [{ name: 'Praat Collection 集合', extensions: ['Collection', 'collection'] }],
            bytes,
            { title: '保存 Collection 集合' }
          );
          if (savedPath) {
            markSaved({ markAllCollectionItems: true });
            showToast(
              `已保存集合 ${getPathBaseName(savedPath)}（含 ${colItems.length} 个对象）`,
              false,
              makeRevealAction(savedPath)
            );
          }
        } else {
          triggerBlobDownload(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), fname);
          markSaved({ markAllCollectionItems: true });
          showToast(`已保存集合 ${fname}（含 ${colItems.length} 个对象）`);
        }
      } catch (err) {
        showToast(`保存失败：${String(err)}`, true);
      }
    },
    [
      audioBuffer,
      flushActiveEdits,
      isDesktop,
      makeRevealAction,
      markSaved,
      persistStyleSidecarForDesktop,
      quickExportImage,
      saveTabAsTextGrid,
      setExportOpen,
      setPosterOpen,
      showToast
    ]
  );

  // Capture-phase browser shortcut blocker, desktop & multi-tab shortcut rebinding, and Ctrl/Meta+wheel zoom guard
  useEffect(() => {
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (isComposingEvent(e)) return;
      if (document.querySelector('.cust-key-btn.is-recording')) return;

      const ctrl = e.ctrlKey || e.metaKey;
      const lower = e.key.toLowerCase();

      if (e.key === 'Escape') {
        if (useEditorStore.getState().styleBrush) {
          e.preventDefault();
          e.stopPropagation();
          useEditorStore.getState().clearStyleBrush();
          return;
        }
        if (tabCtxMenuRef.current) {
          e.preventDefault();
          e.stopPropagation();
          setTabCtxMenu(null);
          return;
        }
        if (bulkDropPlanRef.current) {
          e.preventDefault();
          e.stopPropagation();
          if (!bulkDropBusyRef.current) {
            setBulkDropPlan(null);
            bulkDropPreloadedBytesRef.current.clear();
          }
          return;
        }
        if (corpusConflictModalRef.current) {
          e.preventDefault();
          e.stopPropagation();
          setCorpusConflictModal(null);
          return;
        }
        if (corpusConfirmModalRef.current) {
          e.preventDefault();
          e.stopPropagation();
          setCorpusConfirmModal(null);
          return;
        }
        if (unsavedDialogRef.current) {
          e.preventDefault();
          e.stopPropagation();
          if (!unsavedBusyRef.current) setUnsavedDialog(null);
          return;
        }
        const st = useEditorStore.getState();
        if (st.aboutOpen) {
          e.preventDefault();
          e.stopPropagation();
          setAboutOpen(false);
          return;
        }
        if (st.exportOpen) {
          const activeEl = document.activeElement;
          if (
            activeEl instanceof HTMLInputElement &&
            activeEl.closest('.export-custom-range, .scrub-field')
          ) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          setExportOpen(false);
          return;
        }
        if (st.posterOpen) {
          if (document.querySelector('.poster-point-menu.open')) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          setPosterOpen(false);
          return;
        }
        if (st.preferencesOpen) {
          const activeEl = document.activeElement;
          if (
            activeEl instanceof HTMLInputElement &&
            activeEl.closest('.prefs-modal-card') &&
            (activeEl.classList.contains('pref-hist-input') ||
              ((activeEl.classList.contains('prefs-search-input') ||
                activeEl.classList.contains('cust-key-search')) &&
                activeEl.value.length > 0))
          ) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          st.setPreferencesOpen(false);
          return;
        }
        if (st.shortcutsOpen) {
          e.preventDefault();
          e.stopPropagation();
          st.setShortcutsOpen(false);
          return;
        }
        if (st.findBarOpen) {
          if (document.querySelector('.find-replace-tier-menu')) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          st.closeFindBar();
          return;
        }
      }

      const stNow = useEditorStore.getState();
      const customShortcuts = stNow.customShortcuts;
      const anyModalOpen = Boolean(
        unsavedDialogRef.current ||
          bulkDropPlanRef.current ||
          corpusConflictModalRef.current ||
          corpusConfirmModalRef.current ||
          stNow.exportOpen ||
          stNow.posterOpen ||
          stNow.aboutOpen ||
          stNow.shortcutsOpen ||
          stNow.preferencesOpen ||
          document.querySelector('.modal-backdrop.open')
      );

      // Preferences center toggle (Mod+,)
      if (ctrl && !e.altKey && !e.shiftKey && (e.key === ',' || e.code === 'Comma')) {
        e.preventDefault();
        e.stopPropagation();
        if (
          !unsavedDialogRef.current &&
          !bulkDropPlanRef.current &&
          !stNow.exportOpen &&
          !stNow.posterOpen &&
          !stNow.aboutOpen &&
          !stNow.shortcutsOpen
        ) {
          stNow.setPreferencesOpen(!stNow.preferencesOpen);
        }
        return;
      }

      const isFnKey = /^F([1-9]|1[0-2])$/i.test(e.key);
      const isBareEvent = !ctrl && !e.altKey && !isFnKey;
      const isEditingInput = isEditableTarget(e.target);
      const matchGlobalShortcut = (id: string): boolean => {
        if (isBareEvent && isEditingInput) return false;
        return matchesShortcut(id, e, customShortcuts);
      };

      if (isDesktop) {
        // Block WebView2 / Edge browser chrome shortcuts
        if (e.key === 'F5') {
          e.preventDefault();
          return;
        }
        if (ctrl && (lower === 'r' || lower === 'g' || lower === 'u')) {
          e.preventDefault();
          return;
        }
        if (
          import.meta.env.PROD &&
          (e.key === 'F12' || (ctrl && e.shiftKey && lower === 'i'))
        ) {
          e.preventDefault();
          return;
        }
        // Only suppress browser-back Alt+Arrow when Shift is NOT held (preserve Shift+Alt+Arrow ±1ms nudge)
        if (e.altKey && !e.shiftKey && !ctrl && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          return;
        }
      }

      // Reclaim Mod+= / Mod++ / Mod+- / Mod+_ / Mod+0 for #sheet visual canvas zoom (synced with StatusBar 50%–200%)
      const isZoomIn =
        ctrl &&
        !e.altKey &&
        (e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd');
      const isZoomOut =
        ctrl &&
        !e.altKey &&
        (e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract');
      const isZoomReset =
        ctrl &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0');

      if (isZoomIn || isZoomOut || isZoomReset) {
        e.preventDefault();
        if (anyModalOpen) return;
        const st = useEditorStore.getState();
        if (isZoomReset) {
          st.setCanvasScale(1);
          return;
        }
        st.setCanvasScale(stepCanvasScale(st.canvasScale, isZoomIn ? 1 : -1));
        return;
      }

      // Shortcuts modal (default: ? / Mod+/ / F1, or custom binding)
      if (matchGlobalShortcut('shortcuts-modal')) {
        e.preventDefault();
        e.stopPropagation();
        if (
          !unsavedDialogRef.current &&
          !bulkDropPlanRef.current &&
          !stNow.exportOpen &&
          !stNow.posterOpen &&
          !stNow.aboutOpen &&
          !stNow.preferencesOpen
        ) {
          stNow.setShortcutsOpen(!stNow.shortcutsOpen);
        }
        return;
      }

      // Block global document/tab/bar shortcuts whenever a modal dialog is open
      const isModalBlockedShortcut =
        ctrl &&
        !e.altKey &&
        (lower === 't' ||
          lower === 'w' ||
          lower === 'o' ||
          lower === 's' ||
          lower === 'p' ||
          lower === 'b' ||
          lower === 'f' ||
          lower === 'h' ||
          (e.shiftKey && lower === 'e') ||
          e.key === 'Tab' ||
          (!e.shiftKey && /^[1-9]$/.test(e.key)));

      const matchesRebindableGlobal =
        matchGlobalShortcut('find-open') ||
        matchGlobalShortcut('replace-open') ||
        matchGlobalShortcut('open-files') ||
        matchGlobalShortcut('open-audio') ||
        matchGlobalShortcut('save-file') ||
        matchGlobalShortcut('save-as') ||
        matchGlobalShortcut('corpus-save-all') ||
        matchGlobalShortcut('export-figure') ||
        matchGlobalShortcut('sidebar-toggle');

      if (anyModalOpen && (isModalBlockedShortcut || matchesRebindableGlobal)) {
        e.preventDefault();
        return;
      }

      // Corpus workflow shortcuts (active only when current tab is a folder project)
      const activeTabNow = stNow.tabs.find((t) => t.id === stNow.activeTabId);
      if (!anyModalOpen && activeTabNow?.kind === 'corpus' && activeTabNow.corpus) {
        const isModEnterFallback =
          ctrl &&
          !e.altKey &&
          !e.shiftKey &&
          e.key === 'Enter' &&
          !document.querySelector('.ipa-popover.visible');

        if (matchGlobalShortcut('corpus-done-next') || isModEnterFallback) {
          e.preventDefault();
          e.stopPropagation();
          void handleCorpusMarkAndNext('done');
          return;
        }
        if (matchGlobalShortcut('corpus-doubt-next')) {
          e.preventDefault();
          e.stopPropagation();
          void handleCorpusMarkAndNext('doubt');
          return;
        }
        if (matchGlobalShortcut('corpus-trash-next')) {
          e.preventDefault();
          e.stopPropagation();
          void handleCorpusMarkAndNext('trash');
          return;
        }
        if (matchGlobalShortcut('corpus-replay')) {
          e.preventDefault();
          e.stopPropagation();
          handleCorpusReplay();
          return;
        }
        if (matchGlobalShortcut('corpus-prev')) {
          e.preventDefault();
          e.stopPropagation();
          void handleCorpusStep(-1);
          return;
        }
        if (matchGlobalShortcut('corpus-next')) {
          e.preventDefault();
          e.stopPropagation();
          void handleCorpusStep(1);
          return;
        }
      }

      // Multi-tab shortcuts (capture phase prevents WebView2 from closing window on Ctrl+W)
      if (ctrl && !e.altKey && !e.shiftKey && lower === 't') {
        e.preventDefault();
        handleNewTab();
        return;
      }
      if (ctrl && !e.altKey && !e.shiftKey && lower === 'w') {
        e.preventDefault();
        requestCloseTab(useEditorStore.getState().activeTabId);
        return;
      }
      if (ctrl && !e.altKey && e.key === 'Tab') {
        e.preventDefault();
        const st = useEditorStore.getState();
        if (st.tabs.length > 1) {
          const curIdx = st.tabs.findIndex((t) => t.id === st.activeTabId);
          const delta = e.shiftKey ? -1 : 1;
          const nextIdx = (curIdx + delta + st.tabs.length) % st.tabs.length;
          handleSwitchTab(st.tabs[nextIdx].id);
        }
        return;
      }
      if (ctrl && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const st = useEditorStore.getState();
        const targetIdx = parseInt(e.key, 10) - 1;
        if (targetIdx >= 0 && targetIdx < st.tabs.length) {
          handleSwitchTab(st.tabs[targetIdx].id);
        }
        return;
      }

      // Find & Replace
      if (matchGlobalShortcut('find-open')) {
        e.preventDefault();
        e.stopPropagation();
        useEditorStore.getState().openFindBar(false);
        return;
      }
      if (matchGlobalShortcut('replace-open')) {
        e.preventDefault();
        e.stopPropagation();
        useEditorStore.getState().openFindBar(true);
        return;
      }

      // Open files & companion audio (Desktop & Web)
      if (matchGlobalShortcut('open-files')) {
        e.preventDefault();
        e.stopPropagation();
        void handleOpenTextGridPicker();
        return;
      }
      if (matchGlobalShortcut('open-audio')) {
        e.preventDefault();
        e.stopPropagation();
        void handleOpenAudioPicker();
        return;
      }

      // Save & Export & Sidebar
      if (matchGlobalShortcut('corpus-save-all')) {
        if (activeTabNow?.kind === 'corpus' && activeTabNow.corpus) {
          e.preventDefault();
          e.stopPropagation();
          void saveAllCorpusEntries(activeTabNow.id);
          return;
        }
      }
      if (matchGlobalShortcut('save-as')) {
        e.preventDefault();
        e.stopPropagation();
        void handleExportAction('save-as');
        return;
      }
      if (matchGlobalShortcut('save-file')) {
        e.preventDefault();
        e.stopPropagation();
        void handleExportAction('save');
        return;
      }
      if (matchGlobalShortcut('export-figure')) {
        e.preventDefault();
        e.stopPropagation();
        setExportOpen(true);
        return;
      }
      if (matchGlobalShortcut('sidebar-toggle')) {
        e.preventDefault();
        e.stopPropagation();
        const st = useEditorStore.getState();
        st.setSidebarOpen(!st.sidebarOpen);
        return;
      }
    };

    const onWheelCapture = (e: WheelEvent) => {
      if (!isDesktop || (!e.ctrlKey && !e.metaKey)) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('.export-preview-stage, #stage')) return;
      e.preventDefault();
    };

    window.addEventListener('keydown', onKeyDownCapture, { capture: true });
    if (isDesktop) {
      window.addEventListener('wheel', onWheelCapture, { capture: true, passive: false });
    }
    return () => {
      window.removeEventListener('keydown', onKeyDownCapture, { capture: true });
      if (isDesktop) {
        window.removeEventListener('wheel', onWheelCapture, { capture: true });
      }
    };
  }, [
    isDesktop,
    handleNewTab,
    requestCloseTab,
    handleSwitchTab,
    handleOpenTextGridPicker,
    handleOpenAudioPicker,
    handleExportAction,
    handleCorpusMarkAndNext,
    handleCorpusReplay,
    handleCorpusStep,
    saveAllCorpusEntries,
    setExportOpen,
    setPosterOpen,
    setAboutOpen
  ]);

  const activePendingRecovery = activeCorpus
    ? corpusPendingRecoveries[activeCorpus.projectId] ?? null
    : null;
  const activeBackupMap = activeCorpus ? corpusBackupTimes[activeCorpus.projectId] : undefined;
  const activeItemObj =
    activeCorpus && activeCorpus.activeItemId
      ? activeCorpus.itemMap[activeCorpus.activeItemId] ?? null
      : null;
  const activeItemBackupTime =
    activeItemObj && activeBackupMap ? activeBackupMap[activeItemObj.id] ?? null : null;
  const activeItemParseError = activeItemObj?.parseError ?? null;
  const firstOrphanRecovery = !activeCorpus && orphanRecoveryProjects.length > 0
    ? orphanRecoveryProjects[0]
    : null;

  return (
    <div
      id="app"
      onDragEnter={
        isDesktop
          ? undefined
          : (e) => {
              e.preventDefault();
              dragDepthRef.current++;
              setDropActive(true);
            }
      }
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={
        isDesktop
          ? undefined
          : (e) => {
              e.preventDefault();
              dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
              if (dragDepthRef.current === 0) setDropActive(false);
            }
      }
      onDrop={
        isDesktop
          ? (e) => e.preventDefault()
          : (e) => {
              e.preventDefault();
              dragDepthRef.current = 0;
              setDropActive(false);
              const entriesPromise = extractWebDropEntries(e.dataTransfer);
              void entriesPromise.then((entries) => {
                if (entries.length > 0) {
                  void processDropEntries(entries);
                }
              });
            }
      }
    >
      <RibbonContextProvider value={ribbonContextValue}>
        <Topbar
          onOpenTextGridPicker={() => void handleOpenTextGridPicker()}
          onOpenCorpusFolder={() => void handleOpenCorpusFolder()}
          onOpenAudioPicker={() => void handleOpenAudioPicker()}
          onLoadSample={(id) => void loadSample(id)}
          onExportAction={(kind) => void handleExportAction(kind)}
          onNewTab={handleNewTab}
          onSwitchTab={handleSwitchTab}
          onRequestCloseTab={requestCloseTab}
          ctxTargetTabId={tabCtxMenu?.kind === 'tab' ? tabCtxMenu.tabId : null}
          onTabContextMenu={handleTabContextMenu}
          onTabStripBlankContextMenu={handleTabStripBlankContextMenu}
          onBatchConvertIpa={(dir) => void handleBatchConvertIpa(dir)}
          corpusCanPrev={activeCorpusNav?.canPrev}
          corpusCanNext={activeCorpusNav?.canNext}
          onCorpusPrev={activeCorpus ? () => void handleCorpusStep(-1) : undefined}
          onCorpusNext={activeCorpus ? () => void handleCorpusStep(1) : undefined}
          onToggleCorpusAutoPlay={activeCorpus ? handleToggleCorpusAutoPlay : undefined}
          onToggleCorpusAutoVad={activeCorpus ? handleToggleCorpusAutoVad : undefined}
          onCorpusSaveCurrent={activeCorpus ? () => void saveCurrentCorpusEntry(activeTabId) : undefined}
          onCorpusSaveAll={activeCorpus ? () => void saveAllCorpusEntries(activeTabId) : undefined}
          onToggleCorpusAutoSave={activeCorpus ? handleToggleCorpusAutoSave : undefined}
          corpusSaveProgress={corpusSaveProgress}
          onExportCorpusZip={activeCorpus ? () => void handleExportCorpusZip(activeTabId) : undefined}
          exportingCorpusZip={exportingCorpusZip}
        />
      </RibbonContextProvider>

      <div className="workspace-body">
        {activeCorpus && (
          <CorpusSidebar
            corpus={activeCorpus}
            isDirty={isDirty}
            corpusAutoSave={corpusAutoSave}
            unsavedItemIds={activeCorpus.unsavedItemIds}
            projectIndexDirty={activeCorpus.projectIndexDirty}
            recoveryDegraded={activeCorpus.recoveryDegraded}
            saveProgress={corpusSaveProgress}
            backupTimestamps={activeBackupMap}
            showStatusMarks={showCorpusStatusMarks}
            onSelectItem={(itemId) => void switchCorpusEntry(activeTabId, itemId, { autoFocus: true })}
            onChangeFilter={(patch) => useEditorStore.getState().setCorpusFilter(patch)}
            onToggleOpen={(open) => useEditorStore.getState().toggleCorpusSidebar(open)}
            onResizeWidth={(w) => useEditorStore.getState().setCorpusSidebarWidth(w)}
            onSetItemStatus={(itemId, status) => void handleCorpusSetItemStatus(itemId, status)}
            onSaveItem={
              activeCorpus.writable
                ? (itemId) => void saveCurrentCorpusEntry(activeTabId, { targetItemId: itemId })
                : undefined
            }
            onSaveAll={
              activeCorpus.writable ? () => void saveAllCorpusEntries(activeTabId) : undefined
            }
            onRevertItem={(itemId) => revertCorpusEntryToDisk(activeTabId, itemId)}
            onDiscardAllDrafts={() => discardAllCorpusDrafts(activeTabId)}
            onRestoreItemBackup={(itemId) => void restoreOriginalSnapshot(activeTabId, itemId)}
            onToggleAutoSave={activeCorpus.writable ? handleToggleCorpusAutoSave : undefined}
            canRevealItem={isDesktop && !activeCorpus.rootKey.startsWith('sample:')}
            onRevealItem={(itemId) => void handleCorpusRevealItem(itemId)}
            onCopyItemText={(text, label) => void handleCorpusCopyItemText(text, label)}
            onExportModifiedZip={
              !activeCorpus.writable ? () => void handleExportCorpusZip(activeTabId) : undefined
            }
            exportingZip={exportingCorpusZip}
          />
        )}

        <div className="workspace-center">
          <div
            id="stage-wrap"
            style={{
              position: 'relative',
              flex: '1 1 auto',
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              overflow: 'hidden'
            }}
          >
            <ScoreStage
              ref={stageRef}
              audioBuffer={audioBuffer}
              onStartPlayback={handleStartPlayback}
              onTogglePlay={handleTogglePlay}
              onStopPlayback={handleStopPlayback}
              onQuickExportSvg={() => void quickExportImage('svg')}
              onQuickExportPng={() => void quickExportImage('png')}
              topBanner={
                activeCorpus ? (
                  <>
                    {activePendingRecovery && (
                      <CorpusRecoveryBanner
                        projectName={activeCorpus.projectName}
                        draftCount={activePendingRecovery.bundle.drafts.length}
                        updatedAt={
                          activePendingRecovery.bundle.project?.updatedAt ??
                          activePendingRecovery.bundle.drafts[
                            activePendingRecovery.bundle.drafts.length - 1
                          ]?.updatedAt ??
                          0
                        }
                        externalModifiedCount={activePendingRecovery.externalModifiedCount}
                        hasProjectMetaChanges={hasRecoveryMetaDelta(
                          activePendingRecovery.bundle.project
                        )}
                        busy={recoveryBusy}
                        onRestoreToDrafts={() => void handleRestoreRecoveryToDrafts(activeTabId)}
                        onExportRecoveryZip={
                          activePendingRecovery.bundle.drafts.length > 0
                            ? () => void handleExportRecoveryZip(activeTabId)
                            : undefined
                        }
                        onDiscardRecovery={() => void handleDiscardRecoveryDrafts(activeTabId)}
                      />
                    )}
                    {activeItemParseError && activeItemObj && (
                      <div
                        className="corpus-corrupt-banner"
                        role="alert"
                        aria-label="原 TextGrid 文件解析损坏保护"
                      >
                        <div className="corpus-recovery-main">
                          <span className="corpus-recovery-icon" aria-hidden="true">
                            <UiIcon name="warning" size={14} />
                          </span>
                          <div className="corpus-recovery-copy">
                            <div className="corpus-recovery-title">
                              原标注文件「{activeItemObj.tgRelPath}」解析失败，已进入只读保护模式
                            </div>
                            <div className="corpus-recovery-sub">
                              为防止空模板覆盖损坏原件，已禁止直接保存。错误详情：{activeItemParseError}
                            </div>
                          </div>
                        </div>
                        <div className="corpus-recovery-actions">
                          <button
                            type="button"
                            className="compact"
                            onClick={() => void handleExportAction('save-as')}
                          >
                            <span>另存为新文件</span>
                          </button>
                          <button
                            type="button"
                            className="compact primary"
                            onClick={() =>
                              void handleRebuildCorruptCorpusItem(activeTabId, activeItemObj.id)
                            }
                          >
                            <span>备份原件并按模板重建</span>
                          </button>
                        </div>
                      </div>
                    )}
                    <CorpusNavBar
                      corpus={activeCorpus}
                      isDirty={isDirty}
                      corpusAutoSave={corpusAutoSave}
                      unsavedItemIds={activeCorpus.unsavedItemIds}
                      projectIndexDirty={activeCorpus.projectIndexDirty}
                      saveProgress={corpusSaveProgress}
                      activeItemBackupTime={activeItemBackupTime}
                      activeItemParseError={activeItemParseError}
                      showStatusMarks={showCorpusStatusMarks}
                      currentIndex={activeCorpusNav?.currentIndex}
                      totalCount={activeCorpusNav?.totalCount}
                      canPrev={activeCorpusNav?.canPrev}
                      canNext={activeCorpusNav?.canNext}
                      onToggleSidebar={() => useEditorStore.getState().toggleCorpusSidebar()}
                      onPrev={() => void handleCorpusStep(-1)}
                      onNext={() => void handleCorpusStep(1)}
                      onSetStatus={(status) => void handleCorpusSetStatus(status)}
                      onSaveCurrent={() => void saveCurrentCorpusEntry(activeTabId)}
                      onSaveAll={() => void saveAllCorpusEntries(activeTabId)}
                      onRevertCurrent={
                        activeCorpus.activeItemId
                          ? () => revertCorpusEntryToDisk(activeTabId, activeCorpus.activeItemId!)
                          : undefined
                      }
                      onRestoreBackupCurrent={
                        activeCorpus.activeItemId && activeItemBackupTime
                          ? () => void restoreOriginalSnapshot(activeTabId, activeCorpus.activeItemId!)
                          : undefined
                      }
                      onExportModifiedZip={
                        !activeCorpus.writable
                          ? () => void handleExportCorpusZip(activeTabId)
                          : undefined
                      }
                      exportingZip={exportingCorpusZip}
                    />
                  </>
                ) : firstOrphanRecovery ? (
                  <div
                    className="corpus-recovery-banner"
                    role="status"
                    aria-live="polite"
                    aria-label="检测到上次异常退出残留词表"
                  >
                    <div className="corpus-recovery-main">
                      <span className="corpus-recovery-icon" aria-hidden="true">
                        <UiIcon name="warning" size={14} />
                      </span>
                      <div className="corpus-recovery-copy">
                        <div className="corpus-recovery-title">
                          检测到词表「{firstOrphanRecovery.projectName}」上次异常退出有{' '}
                          {Math.max(1, firstOrphanRecovery.draftCount)} 条未保存草稿
                        </div>
                        <div className="corpus-recovery-sub">
                          目录：{firstOrphanRecovery.nativeDirPath}
                        </div>
                      </div>
                    </div>
                    <div className="corpus-recovery-actions">
                      <button
                        type="button"
                        className="compact primary"
                        onClick={() => {
                          const dirPath = firstOrphanRecovery.nativeDirPath;
                          if (!dirPath) return;
                          void (async () => {
                            try {
                              const adapter = await openTauriCorpusAdapter(
                                getPlatformBridge(),
                                dirPath
                              );
                              if (adapter) {
                                await openCorpusWithAdapter(adapter);
                              }
                            } catch (err) {
                              showToast(`打开原目录失败：${String(err)}`, true);
                            }
                          })();
                        }}
                      >
                        <span>打开目录并恢复</span>
                      </button>
                      <button
                        type="button"
                        className="compact"
                        onClick={() =>
                          setOrphanRecoveryProjects((prev) =>
                            prev.filter((p) => p.projectKey !== firstOrphanRecovery.projectKey)
                          )
                        }
                      >
                        <span>暂不处理</span>
                      </button>
                    </div>
                  </div>
                ) : undefined
              }
            />
            <FindReplaceBar />
          </div>

          <TransportBar
            onTogglePlay={handleTogglePlay}
            onStop={handleStopPlayback}
            onRateChange={handleRateChange}
            onVolumeChange={handleVolumeChange}
            onClearAudio={() => void clearAudio()}
            onOpenAudio={() => void handleOpenAudioPicker()}
          />

          <IpaDock
            onInsertSymbol={(sym, isTieBar) => {
              if (useEditorStore.getState().mode === 'read') {
                showToast('请先切换至编辑模式');
                return;
              }
              if (sidebarRef.current?.insertIpaSymbol(sym, isTieBar)) return;
              stageRef.current?.insertIpaSymbol(sym, isTieBar);
            }}
          />

          <LegendDock />
        </div>

        <RightSidebar
          ref={sidebarRef}
          audioBuffer={audioBuffer}
          onStartPlayback={handleStartPlayback}
          onOpenSplitModal={handleOpenSplitModal}
          onOpenAudioPicker={() => void handleOpenAudioPicker()}
          onClearAudio={() => void clearAudio()}
          onBatchConvertIpa={(dir) => void handleBatchConvertIpa(dir)}
        />
      </div>

      <StatusBar />

      <ExportModal audioBuffer={audioBuffer} />

      <PosterModal audioBuffer={audioBuffer} />

      <AboutModal />

      <ShortcutsModal />

      <PreferencesModal />

      <SplitEqualModal
        state={splitModalState}
        hasAudio={Boolean(audioBuffer)}
        useAcoustic={smartSplitUseAcoustic}
        onToggleAcoustic={setSmartSplitUseAcoustic}
        onCancel={() => setSplitModalState(null)}
        onConfirm={(payload) => void handleSplitModalConfirm(payload)}
      />

      <UnsavedDialog
        state={unsavedDialog}
        busy={unsavedBusy}
        onCancel={handleUnsavedCancel}
        onDiscard={handleUnsavedDiscard}
        onSave={() => void handleUnsavedSave()}
      />

      <BulkDropModal
        plan={bulkDropPlan}
        busy={bulkDropBusy}
        onCancel={handleBulkDropCancel}
        onOpenAsCorpus={() => void handleBulkDropOpenAsCorpus()}
        onOpenSelected={(sel) => void handleBulkDropOpenSelected(sel)}
      />

      {corpusConflictModal && (
        <div
          className="modal-backdrop open"
          role="dialog"
          aria-modal="true"
          aria-labelledby="corpus-conflict-title"
          onClick={(e) => {
            if (!corpusConflictBusy && e.target === e.currentTarget) {
              setCorpusConflictModal(null);
            }
          }}
        >
          <div className="modal-card corpus-confirm-modal-card">
            <div className="modal-head">
              <span id="corpus-conflict-title" className="modal-title">
                <UiIcon name="warning" size={14} />
                <span>外部文件修改冲突</span>
              </span>
              <button
                type="button"
                className="icon-btn compact"
                title="取消 (Esc)"
                aria-label="取消"
                disabled={corpusConflictBusy}
                onClick={() => setCorpusConflictModal(null)}
              >
                <CloseIcon />
              </button>
            </div>
            <div className="modal-body">
              <p className="corpus-confirm-desc">
                词条「<strong>{corpusConflictModal.itemLabel}</strong>」对应的磁盘原文件在打开后已被外部程序修改（或创建/删除）。为避免覆盖外部改动，请选择处理方式：
              </p>
              <div className="corpus-confirm-detail">{corpusConflictModal.tgRelPath}</div>
            </div>
            <div className="unsaved-modal-foot">
              <button
                type="button"
                disabled={corpusConflictBusy}
                onClick={() => setCorpusConflictModal(null)}
              >
                取消
              </button>
              <div className="unsaved-foot-right">
                <button
                  type="button"
                  className="danger"
                  disabled={corpusConflictBusy}
                  onClick={() => void handleConflictReloadDisk()}
                >
                  放弃本地修改重载磁盘
                </button>
                <button
                  type="button"
                  disabled={corpusConflictBusy}
                  onClick={() => void handleConflictSaveCopy()}
                >
                  另存副本
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={corpusConflictBusy}
                  onClick={() => void handleConflictOverwrite()}
                >
                  {corpusConflictBusy ? '正在保存…' : '覆盖原文件'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {corpusConfirmModal && (
        <div
          className="modal-backdrop open"
          role="dialog"
          aria-modal="true"
          aria-labelledby="corpus-confirm-title"
          onClick={(e) => {
            if (!corpusConfirmBusy && e.target === e.currentTarget) {
              setCorpusConfirmModal(null);
            }
          }}
        >
          <div className="modal-card corpus-confirm-modal-card">
            <div className="modal-head">
              <span id="corpus-confirm-title" className="modal-title">
                <UiIcon name="warning" size={14} />
                <span>{corpusConfirmModal.title}</span>
              </span>
              <button
                type="button"
                className="icon-btn compact"
                title="取消 (Esc)"
                aria-label="取消"
                disabled={corpusConfirmBusy}
                onClick={() => setCorpusConfirmModal(null)}
              >
                <CloseIcon />
              </button>
            </div>
            <div className="modal-body">
              <p className="corpus-confirm-desc">{corpusConfirmModal.description}</p>
              {corpusConfirmModal.detail && (
                <div className="corpus-confirm-detail">{corpusConfirmModal.detail}</div>
              )}
            </div>
            <div className="unsaved-modal-foot">
              <button
                type="button"
                disabled={corpusConfirmBusy}
                onClick={() => setCorpusConfirmModal(null)}
              >
                取消
              </button>
              <div className="unsaved-foot-right">
                <button
                  type="button"
                  className={corpusConfirmModal.confirmTone === 'danger' ? 'danger' : 'primary'}
                  disabled={corpusConfirmBusy}
                  onClick={() => {
                    const action = corpusConfirmModal.onConfirm;
                    setCorpusConfirmBusy(true);
                    void Promise.resolve(action()).finally(() => {
                      setCorpusConfirmBusy(false);
                      setCorpusConfirmModal(null);
                    });
                  }}
                >
                  {corpusConfirmBusy ? '处理中…' : corpusConfirmModal.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <TabContextMenu
        request={tabCtxMenu}
        tabs={tabs}
        activeTabId={activeTabId}
        isDesktop={isDesktop}
        getCorpusNativeDirPath={getCorpusNativeDirPath}
        hasTabUnsaved={isTabUnsavedForMenu}
        onClose={() => setTabCtxMenu(null)}
        onSaveTab={(tabId) => void saveTabAsTextGrid(tabId)}
        onSaveTabAs={(tabId) => void saveTabAsNewFile(tabId)}
        onSaveCorpusAll={(tabId) => void saveAllCorpusEntries(tabId)}
        onExportCorpusZip={(tabId) => void handleExportCorpusZip(tabId)}
        onCloseTab={requestCloseTab}
        onCloseOtherTabs={handleCloseOtherTabs}
        onCloseRightTabs={handleCloseRightTabs}
        onCloseSavedTabs={handleCloseSavedTabs}
        onCloseAllTabs={handleCloseAllTabs}
        onCopyText={handleTabCopyText}
        onRevealPath={handleTabRevealPath}
        onNewTab={handleNewTab}
        onOpenTextGridPicker={() => void handleOpenTextGridPicker()}
        onOpenCorpusFolder={() => void handleOpenCorpusFolder()}
      />

      <GlobalContextMenu
        onOpenTextGridPicker={() => void handleOpenTextGridPicker()}
        onOpenAudioPicker={() => void handleOpenAudioPicker()}
      />

      <Toast />

      {/* Drag-and-drop overlay */}
      <div className={`drop-overlay ${dropActive ? 'visible' : ''}`}>
        <div className="drop-box">
          松开即可打开 TextGrid、录音或词表文件夹（大批量文件将先确认再打开）
        </div>
      </div>

      {/* Hidden file inputs (Web / Single-File fallback) */}
      <input
        ref={tgInputRef}
        type="file"
        accept=".TextGrid,.textgrid,.Collection,.collection,.IntervalTier,.TextTier,.txt,.svg,.tgstyle.json,audio/*,.wav,.mp3,.ogg,.flac,.m4a"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) void openFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) void openFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={corpusDirInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) {
            const adapter = createWebFallbackCorpusAdapter(e.target.files);
            if (adapter) {
              void openCorpusWithAdapter(adapter);
            }
          }
          e.target.value = '';
        }}
      />
    </div>
  );
}

export default App;
