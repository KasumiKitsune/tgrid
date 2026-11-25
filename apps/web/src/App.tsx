import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  getPlatformBridge,
  isTauriRuntime,
  type CollectionItem,
  type TextGrid,
  type TextGridFormat
} from './bridge/PlatformBridge';
import { AudioPlayer } from './audio/AudioPlayer';
import {
  deleteTabAudioBuffer,
  getTabAudioBuffer,
  setTabAudioBuffer
} from './audio/tabAudioStore';
import { createSample, type BuiltinSample } from './data/samples';
import { prefetchTrigraphCache } from './layout/richText';
import {
  buildExportZipBytes,
  getBaseStem,
  loadExportPrefs,
  renderOffscreenExport,
  renderOffscreenPngBlob,
  triggerBlobDownload
} from './render/exporter';
import { useEditorStore } from './store/useEditorStore';
import { isComposingEvent, isEditableTarget, matchesShortcut } from './shortcuts/registry';
import { applyUiScaleToDom, stepCanvasScale, syncUiScaleViewportAttrs } from './utils/uiScale';
import { Topbar, type ExportActionKind } from './components/Topbar';
import { TransportBar } from './components/TransportBar';
import { EditStrip } from './components/EditStrip';
import { LegendDock } from './components/LegendDock';
import { ScoreStage, type ScoreStageHandle } from './components/ScoreStage';
import { RightSidebar, type RightSidebarHandle } from './components/sidebar/RightSidebar';
import { IpaDock } from './components/IpaDock';
import { ExportModal } from './components/ExportModal';
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
  const stageRef = useRef<ScoreStageHandle>(null);
  const sidebarRef = useRef<RightSidebarHandle>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const dragDepthRef = useRef(0);

  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [unsavedDialog, setUnsavedDialog] = useState<UnsavedDialogState>(null);
  const [unsavedBusy, setUnsavedBusy] = useState(false);

  const unsavedDialogRef = useRef<UnsavedDialogState>(null);
  unsavedDialogRef.current = unsavedDialog;
  const unsavedBusyRef = useRef(false);
  unsavedBusyRef.current = unsavedBusy;

  const setDocument = useEditorStore((s) => s.setDocument);
  const markSaved = useEditorStore((s) => s.markSaved);
  const markTabSaved = useEditorStore((s) => s.markTabSaved);
  const setAudioMetaForTab = useEditorStore((s) => s.setAudioMetaForTab);
  const setPlaybackTime = useEditorStore((s) => s.setPlaybackTime);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const setRateStore = useEditorStore((s) => s.setRate);
  const setVolumeStore = useEditorStore((s) => s.setVolume);
  const setExportOpen = useEditorStore((s) => s.setExportOpen);
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

  const syncPlayerForTab = useCallback((tabId: string) => {
    const st = useEditorStore.getState();
    const tab = st.tabs.find((t) => t.id === tabId);
    const buf = getTabAudioBuffer(tabId);
    const offset = tab ? tab.audioOffset : 0;
    playerRef.current?.setBuffer(buf, offset);
    setAudioBuffer(buf);
  }, []);

  const handleSwitchTab = useCallback(
    (tabId: string) => {
      const st = useEditorStore.getState();
      if (tabId === st.activeTabId) return;
      flushActiveEdits();
      playerRef.current?.stop(false);
      st.switchTab(tabId);
      syncPlayerForTab(tabId);
    },
    [flushActiveEdits, syncPlayerForTab]
  );

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
      const { removedSessionId, nextActiveTabId } = useEditorStore.getState().closeTabImmediate(tabId);
      deleteTabAudioBuffer(tabId);
      if (removedSessionId !== null) {
        stageRef.current?.pruneSpecCacheForSession(removedSessionId);
        void getPlatformBridge()
          .removeAudioSession(removedSessionId)
          .catch(() => {});
      }
      syncPlayerForTab(nextActiveTabId);
    },
    [syncPlayerForTab]
  );

  const requestCloseTab = useCallback(
    (tabId: string) => {
      const st = useEditorStore.getState();
      if (tabId === st.activeTabId) {
        flushActiveEdits();
      }
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab) return;
      if (tab.isDirty) {
        setUnsavedDialog({ mode: 'tab', tabId: tab.id, filename: tab.filename });
        return;
      }
      closeTabAndCleanup(tabId);
    },
    [flushActiveEdits, closeTabAndCleanup]
  );

  const saveTabAsTextGrid = useCallback(
    async (tabId: string): Promise<boolean> => {
      const st = useEditorStore.getState();
      const tab = st.tabs.find((t) => t.id === tabId);
      if (!tab) return true;
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
    [isDesktop, makeRevealAction, markTabSaved, showToast]
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
        const ok = await saveTabAsTextGrid(dlg.tabId);
        setUnsavedDialog(null);
        if (ok) {
          closeTabAndCleanup(dlg.tabId);
        }
      } else {
        for (const item of dlg.dirtyTabs) {
          const curTab = useEditorStore.getState().tabs.find((t) => t.id === item.id);
          if (!curTab || !curTab.isDirty) continue;
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
  }, [closeTabAndCleanup, destroyDesktopWindow, handleSwitchTab, saveTabAsTextGrid]);

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
            replaceFirst ||
            Boolean(
              curActiveTab &&
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
              isBlankPlaceholder: false
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
              isBlankPlaceholder: false
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
        if (useEditorStore.getState().getDirtyTabs().length > 0) {
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
  }, [isDesktop, flushActiveEdits]);

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
    async (id: BuiltinSample['id']) => {
      if (id === 'blank') {
        handleNewTab();
        showToast('已新建空白标签页');
        return;
      }

      const sample = createSample(id);
      const bridge = getPlatformBridge();
      await prefetchTrigraphCache(sample.tg, bridge);

      flushActiveEdits();
      const st = useEditorStore.getState();
      const curActiveTab = st.tabs.find((t) => t.id === st.activeTabId);
      const reuseCurrent = Boolean(
        curActiveTab && !curActiveTab.isDirty && !curActiveTab.currentFilePath
      );

      let targetTabId: string;
      if (reuseCurrent && curActiveTab) {
        await evictTabAudio(curActiveTab.id);
        setDocument(sample.tg, sample.tg.name, [], 0, {
          filePath: null,
          fileFormat: 'longText',
          isBlankPlaceholder: false
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
          isBlankPlaceholder: false
        });
        syncPlayerForTab(targetTabId);
      }

      if (sample.audioUrl) {
        try {
          const resp = await fetch(sample.audioUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const ab = await resp.arrayBuffer();
          await loadAudioBytesForTab(targetTabId, new Uint8Array(ab), sample.audioName || 'sample.wav', 0);
          showToast(`已载入示例与配套录音：${sample.label}`);
        } catch {
          await evictTabAudio(targetTabId);
          showToast('已载入示例标注（离线模式下可手动点击「打开录音」载入音频）');
        }
      } else {
        showToast(`已切换示例：${sample.label}`);
      }
    },
    [
      evictTabAudio,
      flushActiveEdits,
      handleNewTab,
      loadAudioBytesForTab,
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
      const bridge = getPlatformBridge();
      const st = useEditorStore.getState();
      if (st.mode === 'read') {
        showToast('请先切换至编辑模式');
        return;
      }
      const draft: TextGrid = JSON.parse(JSON.stringify(st.tg));
      let changedCount = 0;

      for (const tier of draft.tiers) {
        if (tier.kind === 'intervalTier') {
          for (const iv of tier.intervals) {
            if (!iv.text) continue;
            const res =
              direction === 'toUnicode'
                ? await bridge.decodePraatTrigraphs(iv.text)
                : await bridge.encodePraatTrigraphs(iv.text);
            if (res.changed) {
              iv.text = res.text;
              changedCount++;
            }
          }
        } else {
          for (const pt of tier.points) {
            if (!pt.mark) continue;
            const res =
              direction === 'toUnicode'
                ? await bridge.decodePraatTrigraphs(pt.mark)
                : await bridge.encodePraatTrigraphs(pt.mark);
            if (res.changed) {
              pt.mark = res.text;
              changedCount++;
            }
          }
        }
      }

      if (changedCount === 0) {
        showToast(direction === 'toUnicode' ? '未发现可转换的 Praat 音标编码' : '未发现可转换的 Unicode 音标');
        return;
      }
      await prefetchTrigraphCache(draft, bridge);
      st.commitTgMutation((d) => {
        d.tiers = draft.tiers;
      });
      showToast(
        direction === 'toUnicode'
          ? `已转换 ${changedCount} 处为 Unicode IPA`
          : `已转换 ${changedCount} 处为 Praat 编码`
      );
    },
    [showToast]
  );

  const quickExportImage = useCallback(
    async (fmt: 'svg' | 'png') => {
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
        maxFreq: st.maxFreq
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
            showToast(
              `已保存集合 ${getPathBaseName(savedPath)}（含 ${colItems.length} 个对象）`,
              false,
              makeRevealAction(savedPath)
            );
          }
        } else {
          triggerBlobDownload(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), fname);
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
          e.preventDefault();
          e.stopPropagation();
          setExportOpen(false);
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
        if (!unsavedDialogRef.current && !stNow.exportOpen && !stNow.aboutOpen) {
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
    setExportOpen,
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
          />
          <FindReplaceBar />
        </div>

        <RightSidebar
          ref={sidebarRef}
          onStartPlayback={handleStartPlayback}
          onOpenAudioPicker={() => void handleOpenAudioPicker()}
          onClearAudio={() => void clearAudio()}
          onBatchConvertIpa={(dir) => void handleBatchConvertIpa(dir)}
        />
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

      <StatusBar />

      <ExportModal audioBuffer={audioBuffer} />

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
    </div>
  );
}

export default App;
