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
  extractIpaPreview,
  findPreferredSpeechIntervalIndex,
  parseProjectFile,
  reconcileProjectWithScan,
  serializeProjectFile,
  sniffTierTemplateFromTextGrid
} from './corpus/projectCodec';
import {
  CORPUS_PROJECT_FILENAME,
  type CorpusAudioCacheEntry,
  type CorpusItemRecord,
  type CorpusItemStatus,
  type CorpusProjectState
} from './corpus/types';
import {
  createMemoryCorpusAdapter,
  createWebFallbackCorpusAdapter,
  disposeCorpusAdapter,
  getCorpusAdapter,
  isWebDirectoryPickerSupported,
  openTauriCorpusAdapter,
  openWebFsaCorpusAdapter,
  type CorpusWorkspaceAdapter
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
  type PendingAutoEditTarget
} from './store/useEditorStore';
import { resolveF0RangeOverride } from './utils/f0Range';
import { isComposingEvent, isEditableTarget, matchesShortcut } from './shortcuts/registry';
import { applyUiScaleToDom, stepCanvasScale, syncUiScaleViewportAttrs } from './utils/uiScale';
import { Topbar, type ExportActionKind } from './components/Topbar';
import { TransportBar } from './components/TransportBar';
import { EditStrip } from './components/EditStrip';
import { LegendDock } from './components/LegendDock';
import { CorpusSidebar, filterCorpusItems } from './components/CorpusSidebar';
import { CorpusNavBar } from './components/CorpusNavBar';
import { ScoreStage, type ScoreStageHandle } from './components/ScoreStage';
import { RightSidebar, type RightSidebarHandle } from './components/sidebar/RightSidebar';
import { IpaDock } from './components/IpaDock';
import { ExportModal } from './components/ExportModal';
import { PosterModal } from './components/PosterModal';
import { prunePolarSpecCacheForSession } from './render/poster/polarSpectrogram';
import { AboutModal } from './components/AboutModal';
import { ShortcutsModal } from './components/ShortcutsModal';
import { FindReplaceBar } from './components/FindReplaceBar';
import { StatusBar } from './components/StatusBar';
import { UnsavedDialog, type UnsavedDialogState } from './components/UnsavedDialog';
import { GlobalContextMenu } from './components/GlobalContextMenu';
import { Toast } from './components/Toast';

interface IncomingFilePayload {
  name: string;
  bytes: Uint8Array;
  path?: string | null;
}

const AUDIO_EXT_RE = /\.(wav|mp3|ogg|flac|m4a|aac|webm)$/i;

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
  const corpusProjectSaveTimersRef = useRef<Map<string, number>>(new Map());
  const corpusAudioInflightRef = useRef<Map<string, Promise<CorpusAudioCacheEntry | null>>>(new Map());

  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [unsavedDialog, setUnsavedDialog] = useState<UnsavedDialogState>(null);
  const [unsavedBusy, setUnsavedBusy] = useState(false);
  const [exportingCorpusZip, setExportingCorpusZip] = useState(false);

  const unsavedDialogRef = useRef<UnsavedDialogState>(null);
  unsavedDialogRef.current = unsavedDialog;
  const unsavedBusyRef = useRef(false);
  unsavedBusyRef.current = unsavedBusy;

  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const isDirty = useEditorStore((s) => s.isDirty);
  const docVersion = useEditorStore((s) => s.docVersion);
  const showCorpusStatusMarks = useEditorStore((s) => s.showCorpusStatusMarks);
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
      if (corpusPreloadTimerRef.current !== null) {
        window.clearTimeout(corpusPreloadTimerRef.current);
      }
      for (const timer of corpusProjectSaveTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      corpusProjectSaveTimersRef.current.clear();
    };
  }, []);

  const persistCorpusProjectIndex = useCallback(
    async (tabId: string, immediate = false): Promise<boolean> => {
      const existingTimer = corpusProjectSaveTimersRef.current.get(tabId);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
        corpusProjectSaveTimersRef.current.delete(tabId);
      }

      if (!immediate) {
        const timer = window.setTimeout(() => {
          corpusProjectSaveTimersRef.current.delete(tabId);
          void persistCorpusProjectIndex(tabId, true);
        }, 800);
        corpusProjectSaveTimersRef.current.set(tabId, timer);
        return true;
      }

      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return true;
      const adapter = getCorpusAdapter(tab.corpus.projectId);
      if (!adapter) return false;

      try {
        const bytes = serializeProjectFile(tab.corpus);
        await adapter.writeFile(CORPUS_PROJECT_FILENAME, bytes);
        useEditorStore
          .getState()
          .setCorpusSaveState({ dirtyCount: adapter.getPendingExportCount() }, tabId);
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
    []
  );

  const saveCorpusEntrySilent = useCallback(
    async (
      tabId: string,
      opts?: { forceWrite?: boolean; statusOverride?: CorpusItemStatus; persistIndexImmediate?: boolean }
    ): Promise<boolean> => {
      const st = useEditorStore.getState();
      const tab = st.tabs.find((t) => t.id === tabId);
      const corpus = tab?.kind === 'corpus' ? tab.corpus : undefined;
      const itemId = corpus?.activeItemId ?? null;
      if (!tab || !corpus || !itemId) {
        return true;
      }

      const item = corpus.itemMap[itemId];
      if (!item) return true;

      const tg = tabId === st.activeTabId ? st.tg : tab.tg;
      const dirty = tabId === st.activeTabId ? st.isDirty : tab.isDirty;
      const shouldWriteTg = Boolean(dirty || opts?.forceWrite);
      const now = Date.now();
      const preview = extractIpaPreview(tg, corpus.options.targetTierIndex);

      if (!shouldWriteTg) {
        if (opts?.statusOverride !== undefined && opts.statusOverride !== item.status) {
          useEditorStore.getState().updateCorpusItemMeta(
            itemId,
            {
              status: opts.statusOverride,
              ipaPreview: preview,
              updatedAt: now
            },
            tabId
          );
          await persistCorpusProjectIndex(tabId, Boolean(opts?.persistIndexImmediate));
        }
        return true;
      }

      const adapter = getCorpusAdapter(corpus.projectId);
      if (!adapter) return false;

      useEditorStore
        .getState()
        .setCorpusSaveState({ saveStatus: 'saving', lastSaveError: null }, tabId);

      try {
        const fmt = tab.currentFileFormat || corpus.defaultSaveFormat || 'longText';
        const bytes = await getPlatformBridge().serializeTextGrid(tg, fmt);
        await adapter.writeFile(item.tgRelPath, bytes);

        const postSt = useEditorStore.getState();
        const postTab = postSt.tabs.find((t) => t.id === tabId);
        const postTg = tabId === postSt.activeTabId ? postSt.tg : postTab?.tg;
        if (postTab?.kind === 'corpus' && postTab.corpus?.activeItemId === itemId && postTg === tg) {
          markTabSaved(tabId);
        }

        useEditorStore.getState().updateCorpusItemMeta(
          itemId,
          {
            hasTextGrid: true,
            ipaPreview: preview,
            updatedAt: now,
            ...(opts?.statusOverride !== undefined ? { status: opts.statusOverride } : {})
          },
          tabId
        );
        useEditorStore.getState().setCorpusSaveState(
          {
            saveStatus: 'saved',
            lastSaveError: null,
            dirtyCount: adapter.getPendingExportCount()
          },
          tabId
        );
        await persistCorpusProjectIndex(tabId, Boolean(opts?.persistIndexImmediate));
        return true;
      } catch (err) {
        const msg = String(err);
        useEditorStore
          .getState()
          .setCorpusSaveState({ saveStatus: 'error', lastSaveError: msg }, tabId);
        showToast(`自动保存失败：${msg}`, true);
        return false;
      }
    },
    [markTabSaved, persistCorpusProjectIndex, showToast]
  );

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
      opts?: { autoFocus?: boolean; autoPlayOverride?: boolean; skipFlushPrev?: boolean }
    ) => {
      if (corpusPreloadTimerRef.current !== null) {
        window.clearTimeout(corpusPreloadTimerRef.current);
        corpusPreloadTimerRef.current = null;
      }
      if (corpusAutoSaveTimerRef.current !== null) {
        window.clearTimeout(corpusAutoSaveTimerRef.current);
        corpusAutoSaveTimerRef.current = null;
      }

      // Prime AudioContext synchronously inside the user gesture for zero-latency playback
      playerRef.current?.ensureContext(true);

      if (!opts?.skipFlushPrev) {
        const curSt = useEditorStore.getState();
        if (tabId === curSt.activeTabId) {
          flushActiveEdits();
        }
        const prevTab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
        if (prevTab?.kind === 'corpus' && prevTab.isDirty) {
          await saveCorpusEntrySilent(tabId);
        }
      }

      const seq = (corpusLoadSeqRef.current.get(tabId) ?? 0) + 1;
      corpusLoadSeqRef.current.set(tabId, seq);

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

      try {
        const tgBytes = await adapter.readFileIfExists(item.tgRelPath);
        if (corpusLoadSeqRef.current.get(tabId) !== seq) return;
        if (tgBytes && tgBytes.length > 0) {
          const parsed = await bridge.parsePraatFile(tgBytes, item.tgRelPath);
          if (corpusLoadSeqRef.current.get(tabId) !== seq) return;
          const foundTg = parsed.items.find(
            (it): it is Extract<CollectionItem, { type: 'TextGrid' }> => it.type === 'TextGrid'
          );
          if (foundTg) {
            tg = foundTg;
            fileFormat = inferTextGridFormat(parsed.sourceFormat);
            hasTextGrid = true;
          }
        }
      } catch {
        // 解析现有 TextGrid 失败时回退按模板重建，不阻塞工作流
        tg = null;
      }

      if (!tg) {
        const latestCorpus = useEditorStore.getState().tabs.find((t) => t.id === tabId)?.corpus ?? corpus;
        let vadBounds = null;
        if (audioEntry && latestCorpus.options.autoVad) {
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
        hasTextGrid = false;
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
        if (opts?.autoFocus !== false) {
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
      useEditorStore.getState().activateCorpusEntry({
        tabId,
        itemId,
        tg,
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
          duration: effectiveDuration > 0 ? effectiveDuration : item.duration
        },
        pendingAutoEditTarget
      });

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

      void persistCorpusProjectIndex(tabId, false);

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
    },
    [
      flushActiveEdits,
      loadCorpusAudioEntry,
      persistCorpusProjectIndex,
      saveCorpusEntrySilent,
      showToast
    ]
  );

  const handleSwitchTab = useCallback(
    (tabId: string) => {
      const st = useEditorStore.getState();
      if (tabId === st.activeTabId) return;
      flushActiveEdits();
      const prevTab = useEditorStore.getState().tabs.find((t) => t.id === st.activeTabId);
      if (prevTab?.kind === 'corpus' && prevTab.corpus) {
        if (prevTab.isDirty) {
          void saveCorpusEntrySilent(prevTab.id, { persistIndexImmediate: true });
        } else {
          void persistCorpusProjectIndex(prevTab.id, true);
        }
      }
      playerRef.current?.stop(false);
      useEditorStore.getState().switchTab(tabId);
      syncPlayerForTab(tabId);
    },
    [flushActiveEdits, persistCorpusProjectIndex, saveCorpusEntrySilent, syncPlayerForTab]
  );

  const openCorpusWithAdapter = useCallback(
    async (adapter: CorpusWorkspaceAdapter) => {
      const st = useEditorStore.getState();
      const existingTab = st.findCorpusTabByRootKey(adapter.rootKey);
      if (existingTab) {
        disposeCorpusAdapter(adapter.projectId);
        handleSwitchTab(existingTab.id);
        showToast(`已切换至已打开的文件夹：${existingTab.corpus?.projectName ?? adapter.projectName}`);
        return;
      }

      try {
        const scan = await adapter.scan();
        if (scan.audioFiles.length === 0 && scan.textGridFiles.length === 0) {
          disposeCorpusAdapter(adapter.projectId);
          showToast('该文件夹中未找到音频或 TextGrid 文件', true);
          return;
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
          loadSeq: 0,
          saveStatus: 'idle',
          lastSaveError: null,
          wordListMeta: reconciled.wordListMeta
        };

        flushActiveEdits();
        playerRef.current?.stop(false);
        const tabId = useEditorStore.getState().openCorpusTab(corpusState, { activate: true });

        if (adapter.writable && !scan.hasProjectFile) {
          void persistCorpusProjectIndex(tabId, true);
        }

        if (reconciled.activeItemId) {
          await switchCorpusEntry(tabId, reconciled.activeItemId, {
            autoFocus: true,
            skipFlushPrev: true
          });
        }

        const doneCount = reconciled.items.filter((it) => it.status === 'done').length;
        showToast(
          `已打开文件夹：${reconciled.projectName}（已完成 ${doneCount} / 共 ${reconciled.items.length} 条）`
        );
      } catch (err) {
        disposeCorpusAdapter(adapter.projectId);
        showToast(`打开文件夹失败：${String(err)}`, true);
      }
    },
    [flushActiveEdits, handleSwitchTab, persistCorpusProjectIndex, showToast, switchCorpusEntry]
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

  const handleExportCorpusZip = useCallback(
    async (tabId?: string): Promise<boolean> => {
      const st = useEditorStore.getState();
      const targetTabId = tabId ?? st.activeTabId;
      const tab = st.tabs.find((t) => t.id === targetTabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus) return false;
      const adapter = getCorpusAdapter(tab.corpus.projectId);
      if (!adapter) return false;

      setExportingCorpusZip(true);
      try {
        if (targetTabId === st.activeTabId) {
          flushActiveEdits();
        }
        await saveCorpusEntrySilent(targetTabId, { persistIndexImmediate: true });
        await persistCorpusProjectIndex(targetTabId, true);
        const { bytes, fileCount } = await adapter.exportModifiedZip(getPlatformBridge());
        if (fileCount === 0) {
          showToast('当前没有可导出的修改文件');
          return true;
        }
        const zipName = `${tab.corpus.projectName || 'corpus'}_modified.zip`;
        triggerBlobDownload(new Blob([bytes as BlobPart], { type: 'application/zip' }), zipName);
        showToast(`已导出修改包 ${zipName}（含 ${fileCount} 个文件）`);
        return true;
      } catch (err) {
        showToast(`导出修改包失败：${String(err)}`, true);
        return false;
      } finally {
        setExportingCorpusZip(false);
      }
    },
    [flushActiveEdits, persistCorpusProjectIndex, saveCorpusEntrySilent, showToast]
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

      const savedOk = await saveCorpusEntrySilent(tab.id, {
        forceWrite: status === 'done',
        statusOverride: status
      });
      if (!savedOk) return;

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
    [flushActiveEdits, saveCorpusEntrySilent, showToast, switchCorpusEntry]
  );

  const handleCorpusSetStatus = useCallback(
    async (status: CorpusItemStatus) => {
      flushActiveEdits();
      const st = useEditorStore.getState();
      const tab = st.tabs.find((t) => t.id === st.activeTabId);
      if (!tab || tab.kind !== 'corpus' || !tab.corpus || !tab.corpus.activeItemId) return;
      await saveCorpusEntrySilent(tab.id, {
        forceWrite: status === 'done',
        statusOverride: status
      });
    },
    [flushActiveEdits, saveCorpusEntrySilent]
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
      st.updateCorpusItemMeta(itemId, { status, updatedAt: Date.now() }, tab.id);
      await persistCorpusProjectIndex(tab.id, false);
    },
    [handleCorpusSetStatus, persistCorpusProjectIndex]
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

  // Debounced silent auto-save (600ms) for active corpus tab
  useEffect(() => {
    if (corpusAutoSaveTimerRef.current !== null) {
      window.clearTimeout(corpusAutoSaveTimerRef.current);
      corpusAutoSaveTimerRef.current = null;
    }
    const st = useEditorStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (!tab || tab.kind !== 'corpus' || !tab.corpus?.activeItemId || !st.isDirty) {
      return;
    }

    const tabId = tab.id;
    const itemId = tab.corpus.activeItemId;
    const preview = extractIpaPreview(st.tg, tab.corpus.options.targetTierIndex);
    const curItem = tab.corpus.itemMap[itemId];
    if (curItem && curItem.ipaPreview !== preview) {
      st.updateCorpusItemMeta(itemId, { ipaPreview: preview }, tabId);
    }

    corpusAutoSaveTimerRef.current = window.setTimeout(() => {
      corpusAutoSaveTimerRef.current = null;
      void saveCorpusEntrySilent(tabId);
    }, 600);

    return () => {
      if (corpusAutoSaveTimerRef.current !== null) {
        window.clearTimeout(corpusAutoSaveTimerRef.current);
        corpusAutoSaveTimerRef.current = null;
      }
    };
  }, [docVersion, activeTabId, isDirty, saveCorpusEntrySilent]);

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

  const requestCloseTab = useCallback(
    (tabId: string) => {
      const st = useEditorStore.getState();
      if (tabId === st.activeTabId) {
        flushActiveEdits();
      }
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab) return;

      if (tab.kind === 'corpus' && tab.corpus) {
        const corpusProjectId = tab.corpus.projectId;
        const corpusName = tab.corpus.projectName;
        const writable = tab.corpus.writable;
        void (async () => {
          const ok = await saveCorpusEntrySilent(tabId, { persistIndexImmediate: true });
          const idxOk = await persistCorpusProjectIndex(tabId, true);
          const latestTab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
          if (!latestTab) return;

          if (!writable) {
            const adapter = getCorpusAdapter(corpusProjectId);
            const pendingCount = adapter?.getPendingExportCount() ?? latestTab.corpus?.dirtyCount ?? 0;
            if (pendingCount > 0 || latestTab.isDirty) {
              setUnsavedDialog({
                mode: 'tab',
                tabId: latestTab.id,
                filename: `${corpusName}（有 ${Math.max(1, pendingCount)} 项待导出修改）`
              });
              return;
            }
            closeTabAndCleanup(tabId);
            return;
          }

          if (ok && idxOk && !latestTab.isDirty) {
            closeTabAndCleanup(tabId);
          } else {
            setUnsavedDialog({ mode: 'tab', tabId: latestTab.id, filename: latestTab.filename });
          }
        })();
        return;
      }

      if (tab.isDirty) {
        setUnsavedDialog({ mode: 'tab', tabId: tab.id, filename: tab.filename });
        return;
      }
      closeTabAndCleanup(tabId);
    },
    [closeTabAndCleanup, flushActiveEdits, persistCorpusProjectIndex, saveCorpusEntrySilent]
  );

  const saveTabAsTextGrid = useCallback(
    async (tabId: string): Promise<boolean> => {
      const st = useEditorStore.getState();
      const tab = st.tabs.find((t) => t.id === tabId);
      if (!tab) return true;

      if (tab.kind === 'corpus' && tab.corpus) {
        const ok = await saveCorpusEntrySilent(tabId, {
          forceWrite: true,
          persistIndexImmediate: true
        });
        if (ok) {
          if (tab.corpus.writable) {
            showToast(`已保存：${tab.filename}`);
          } else {
            showToast('修改已暂存到本地，可在左侧点击「导出修改 (.zip)」');
          }
        }
        return ok;
      }

      const bridge = getPlatformBridge();
      const stem = getBaseStem(tab.filename);
      const fmt = tab.currentFileFormat;

      try {
        const bytes = await bridge.serializeTextGrid(tab.tg, fmt);
        if (isDesktop) {
          if (tab.currentFilePath) {
            await bridge.writeNativeFile(tab.currentFilePath, bytes);
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
    [isDesktop, makeRevealAction, markTabSaved, saveCorpusEntrySilent, showToast]
  );

  const destroyDesktopWindow = useCallback(async () => {
    if (!isDesktop) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().destroy();
    } catch {
      // ignore
    }
  }, [isDesktop]);

  const handleUnsavedCancel = useCallback(() => {
    if (unsavedBusyRef.current) return;
    setUnsavedDialog(null);
  }, []);

  const handleUnsavedDiscard = useCallback(() => {
    const dlg = unsavedDialogRef.current;
    if (!dlg || unsavedBusyRef.current) return;
    setUnsavedDialog(null);
    if (dlg.mode === 'tab') {
      closeTabAndCleanup(dlg.tabId);
    } else {
      void destroyDesktopWindow();
    }
  }, [closeTabAndCleanup, destroyDesktopWindow]);

  const handleUnsavedSave = useCallback(async () => {
    const dlg = unsavedDialogRef.current;
    if (!dlg || unsavedBusyRef.current) return;

    setUnsavedBusy(true);
    try {
      if (dlg.mode === 'tab') {
        const targetTab = useEditorStore.getState().tabs.find((t) => t.id === dlg.tabId);
        const ok =
          targetTab?.kind === 'corpus' && targetTab.corpus && !targetTab.corpus.writable
            ? await handleExportCorpusZip(dlg.tabId)
            : await saveTabAsTextGrid(dlg.tabId);
        setUnsavedDialog(null);
        if (ok) {
          closeTabAndCleanup(dlg.tabId);
        }
      } else {
        for (const item of dlg.dirtyTabs) {
          const curTab = useEditorStore.getState().tabs.find((t) => t.id === item.id);
          if (!curTab || !curTab.isDirty) continue;
          if (!curTab.currentFilePath && curTab.kind !== 'corpus' && useEditorStore.getState().activeTabId !== curTab.id) {
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
  }, [closeTabAndCleanup, destroyDesktopWindow, handleExportCorpusZip, handleSwitchTab, saveTabAsTextGrid]);

  const openFilePayloads = useCallback(
    async (files: IncomingFilePayload[], opts?: { replaceActiveTab?: boolean }) => {
      const bridge = getPlatformBridge();
      const docFiles = files.filter((f) => !AUDIO_EXT_RE.test(f.name));
      const audioFiles = files.filter((f) => AUDIO_EXT_RE.test(f.name));
      const hasExplicitAudio = audioFiles.length > 0;
      const ordered = [...docFiles, ...audioFiles];

      let replaceFirst = Boolean(opts?.replaceActiveTab);

      for (const file of ordered) {
        const lower = file.name.toLowerCase();
        const isAudio = AUDIO_EXT_RE.test(lower);
        if (isAudio) {
          try {
            const targetTabId = useEditorStore.getState().activeTabId;
            await loadAudioBytesForTab(targetTabId, file.bytes, file.name, 0);
            showToast(`已载入录音：${file.name}`);
          } catch (err) {
            showToast(`音频解码失败：${String(err)}`, true);
          }
          continue;
        }

        // If desktop file path is already open in a tab, switch directly to it
        if (file.path) {
          const existing = useEditorStore.getState().findTabByPath(file.path);
          if (existing) {
            handleSwitchTab(existing.id);
            showToast('已切换至已打开的标签页');
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
              showToast(`已从 Praat 文件载入音频：${firstSound.name || file.name}`);
              continue;
            }
            showToast('文件中未包含 TextGrid 对象', true);
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
            showToast(`已载入集合：${tgs.length} 个 TextGrid + 配套音频`);
          } else {
            let autoPairedAudioName: string | null = null;
            if (isDesktop && file.path && !hasExplicitAudio) {
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

            if (autoPairedAudioName) {
              showToast(`已自动配对加载同名音频: ${autoPairedAudioName}`);
            } else {
              showToast(
                tgs.length > 1
                  ? `已载入集合：${file.name}（含 ${tgs.length} 个 TextGrid）`
                  : `已载入：${file.name}`
              );
            }
          }
        } catch (err) {
          showToast(`解析失败：${String(err)}`, true);
        }
      }
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

  const openFiles = useCallback(
    async (files: FileList | File[]) => {
      const payloads: IncomingFilePayload[] = [];
      for (const file of Array.from(files)) {
        payloads.push({
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
          path: null
        });
      }
      await openFilePayloads(payloads);
    },
    [openFilePayloads]
  );

  const handleOpenTextGridPicker = useCallback(async () => {
    if (isDesktop) {
      try {
        const opened = await getPlatformBridge().openNativeFileDialog(
          [
            {
              name: 'Praat 标注与音频文件',
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
                'm4a'
              ]
            },
            { name: '所有文件', extensions: ['*'] }
          ],
          { title: '打开标注或音频文件', multiple: true }
        );
        if (opened && opened.length > 0) {
          await openFilePayloads(opened);
        }
      } catch (err) {
        showToast(`打开文件失败：${String(err)}`, true);
      }
      return;
    }
    tgInputRef.current?.click();
  }, [isDesktop, openFilePayloads, showToast]);

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

  // Initialize bridge (WASM or Tauri), prefetch trigraphs, and load launch file arg if provided
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
              return;
            }
          }
        } catch {
          // Fall back to default initial sample if launch arg failed
        }
      }
      await prefetchTrigraphCache(useEditorStore.getState().tg, bridge);
      if (active) useEditorStore.getState().bumpDocVersion();
    });
    return () => {
      active = false;
    };
  }, [isDesktop, openFilePayloads]);

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

  // Custom Architectural Unsaved-Changes Close Guard on Desktop (and beforeunload on Web)
  useEffect(() => {
    if (!isDesktop) {
      const onBeforeUnload = (e: BeforeUnloadEvent) => {
        const st = useEditorStore.getState();
        const hasSingleDirty = st.tabs.some((t) => t.kind !== 'corpus' && t.isDirty);
        const hasPendingCorpus = st.tabs.some((t) => {
          if (t.kind !== 'corpus' || !t.corpus) return false;
          if (t.isDirty) return true;
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

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested((event) => {
          flushActiveEdits();
          const curTabs = useEditorStore.getState().tabs;
          const corpusTabs = curTabs.filter((t) => t.kind === 'corpus' && t.corpus);
          const hasDirtyCorpus = corpusTabs.some(
            (t) => t.isDirty || corpusProjectSaveTimersRef.current.has(t.id)
          );
          if (hasDirtyCorpus) {
            event.preventDefault();
            void (async () => {
              for (const cTab of corpusTabs) {
                if (cTab.isDirty) {
                  await saveCorpusEntrySilent(cTab.id, { persistIndexImmediate: true });
                } else if (corpusProjectSaveTimersRef.current.has(cTab.id)) {
                  await persistCorpusProjectIndex(cTab.id, true);
                }
              }
              const remainingDirty = useEditorStore.getState().getDirtyTabs();
              if (remainingDirty.length === 0) {
                await destroyDesktopWindow();
                return;
              }
              setUnsavedDialog({
                mode: 'window',
                dirtyTabs: remainingDirty.map((t) => ({ id: t.id, filename: t.filename }))
              });
            })();
            return;
          }

          const dirtyTabs = useEditorStore.getState().getDirtyTabs();
          if (dirtyTabs.length === 0) return;
          event.preventDefault();
          setUnsavedDialog({
            mode: 'window',
            dirtyTabs: dirtyTabs.map((t) => ({ id: t.id, filename: t.filename }))
          });
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
    destroyDesktopWindow,
    flushActiveEdits,
    persistCorpusProjectIndex,
    saveCorpusEntrySilent
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
  }, [isDesktop, openFilePayloads, showToast]);

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
        f0RangeOverride: resolveF0RangeOverride(st.f0RangeMode, st.f0RangeCustom)
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
          stNow.exportOpen ||
          stNow.posterOpen ||
          stNow.aboutOpen ||
          stNow.shortcutsOpen ||
          document.querySelector('.modal-backdrop.open')
      );

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
        if (!unsavedDialogRef.current && !stNow.exportOpen && !stNow.posterOpen && !stNow.aboutOpen) {
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
    setExportOpen,
    setPosterOpen,
    setAboutOpen
  ]);

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
              if (e.dataTransfer.files?.length) {
                void openFiles(e.dataTransfer.files);
              }
            }
      }
    >
      <Topbar
        onOpenTextGridPicker={() => void handleOpenTextGridPicker()}
        onOpenCorpusFolder={() => void handleOpenCorpusFolder()}
        onOpenAudioPicker={() => void handleOpenAudioPicker()}
        onLoadSample={(id) => void loadSample(id)}
        onExportAction={(kind) => void handleExportAction(kind)}
        onNewTab={handleNewTab}
        onSwitchTab={handleSwitchTab}
        onRequestCloseTab={requestCloseTab}
      />

      <TransportBar
        onTogglePlay={handleTogglePlay}
        onStop={handleStopPlayback}
        onRateChange={handleRateChange}
        onVolumeChange={handleVolumeChange}
        onClearAudio={() => void clearAudio()}
        onOpenAudio={() => void handleOpenAudioPicker()}
      />

      <EditStrip />

      <div className="workspace-body">
        {activeCorpus && (
          <CorpusSidebar
            corpus={activeCorpus}
            isDirty={isDirty}
            showStatusMarks={showCorpusStatusMarks}
            onSelectItem={(itemId) => void switchCorpusEntry(activeTabId, itemId, { autoFocus: true })}
            onChangeFilter={(patch) => useEditorStore.getState().setCorpusFilter(patch)}
            onToggleOpen={(open) => useEditorStore.getState().toggleCorpusSidebar(open)}
            onResizeWidth={(w) => useEditorStore.getState().setCorpusSidebarWidth(w)}
            onSetItemStatus={(itemId, status) => void handleCorpusSetItemStatus(itemId, status)}
            canRevealItem={isDesktop && !activeCorpus.rootKey.startsWith('sample:')}
            onRevealItem={(itemId) => void handleCorpusRevealItem(itemId)}
            onCopyItemText={(text, label) => void handleCorpusCopyItemText(text, label)}
            onExportModifiedZip={
              !activeCorpus.writable ? () => void handleExportCorpusZip() : undefined
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
                  <CorpusNavBar
                    corpus={activeCorpus}
                    isDirty={isDirty}
                    showStatusMarks={showCorpusStatusMarks}
                    currentIndex={activeCorpusNav?.currentIndex}
                    totalCount={activeCorpusNav?.totalCount}
                    canPrev={activeCorpusNav?.canPrev}
                    canNext={activeCorpusNav?.canNext}
                    onToggleSidebar={() => useEditorStore.getState().toggleCorpusSidebar()}
                    onPrev={() => void handleCorpusStep(-1)}
                    onNext={() => void handleCorpusStep(1)}
                    onSetStatus={(status) => void handleCorpusSetStatus(status)}
                    onToggleAutoPlay={() => {
                      useEditorStore
                        .getState()
                        .setCorpusOptions({ autoPlay: !activeCorpus.options.autoPlay });
                      void persistCorpusProjectIndex(activeTabId, false);
                    }}
                    onToggleAutoVad={() => {
                      useEditorStore
                        .getState()
                        .setCorpusOptions({ autoVad: !activeCorpus.options.autoVad });
                      void persistCorpusProjectIndex(activeTabId, false);
                    }}
                  />
                ) : undefined
              }
            />
            <FindReplaceBar />
          </div>

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
          onStartPlayback={handleStartPlayback}
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

      <UnsavedDialog
        state={unsavedDialog}
        busy={unsavedBusy}
        onCancel={handleUnsavedCancel}
        onDiscard={handleUnsavedDiscard}
        onSave={() => void handleUnsavedSave()}
      />

      <GlobalContextMenu
        onOpenTextGridPicker={() => void handleOpenTextGridPicker()}
        onOpenAudioPicker={() => void handleOpenAudioPicker()}
      />

      <Toast />

      {/* Drag-and-drop overlay */}
      <div className={`drop-overlay ${dropActive ? 'visible' : ''}`}>
        <div className="drop-box">松开以载入 .TextGrid / .Collection / 音频文件</div>
      </div>

      {/* Hidden file inputs (Web / Single-File fallback) */}
      <input
        ref={tgInputRef}
        type="file"
        accept=".TextGrid,.textgrid,.Collection,.collection,.IntervalTier,.TextTier,.txt"
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
