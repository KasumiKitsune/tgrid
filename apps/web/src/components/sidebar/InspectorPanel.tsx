import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';
import { getPlatformBridge } from '../../bridge/PlatformBridge';
import type { AudioAnalysisSummary, TextGridFormat, TierDiagnostics } from '../../bridge/types';
import {
  decodeTrigraphGlossSync,
  formatPraatDouble,
  primeTrigraphString
} from '../../layout/richText';
import { useEditorStore } from '../../store/useEditorStore';
import { UiIcon } from '../Icons';
import { IpaImePopover, IpaModePill } from '../IpaImePopover';
import { isIpaRelatedElement, useIpaIme } from '../useIpaIme';
import { CollapsibleSection } from './CollapsibleSection';

export interface InspectorPanelHandle {
  insertIpaSymbol: (sym: string, isTieBar?: boolean) => boolean;
  flushDraft: () => void;
}

interface InspectorPanelProps {
  onStartPlayback: (startT: number, endT: number) => void;
}

interface AcousticStats {
  f0Mean: number | null;
  f0Min: number | null;
  f0Max: number | null;
  voicedCount: number;
  f1: number | null;
  f2: number | null;
  f3: number | null;
}

function round6(t: number): number {
  return Number(t.toFixed(6));
}

function formatDurationBadge(durSec: number): string {
  const safe = Math.max(0, durSec);
  if (safe < 1) return `${Math.round(safe * 1000)} ms`;
  return `${safe.toFixed(3)} s`;
}

function formatFormatLabel(fmt: TextGridFormat): string {
  switch (fmt) {
    case 'shortText':
      return '短文本 (.TextGrid)';
    case 'binary':
      return '二进制 (.TextGrid)';
    case 'chronological':
      return '按时间排序文本';
    default:
      return '标准文本 (.TextGrid)';
  }
}

function computeAcousticStats(
  analysis: AudioAnalysisSummary | null,
  tMin: number,
  tMax: number
): AcousticStats | null {
  if (!analysis || !Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax <= tMin) {
    return null;
  }

  let f0Sum = 0;
  let f0Min = Infinity;
  let f0Max = -Infinity;
  let voicedCount = 0;

  for (const p of analysis.pitchTrack) {
    if (p.t < tMin || p.t > tMax) continue;
    if (p.f0 !== null && Number.isFinite(p.f0) && p.f0 > 0) {
      f0Sum += p.f0;
      if (p.f0 < f0Min) f0Min = p.f0;
      if (p.f0 > f0Max) f0Max = p.f0;
      voicedCount++;
    }
  }

  const midT = (tMin + tMax) * 0.5;
  let bestFrame: { t: number; freqs: number[] } | null = null;
  let bestDist = Infinity;
  for (const frame of analysis.formantTrack) {
    if (frame.t < tMin || frame.t > tMax || !frame.freqs.length) continue;
    const d = Math.abs(frame.t - midT);
    if (d < bestDist) {
      bestDist = d;
      bestFrame = frame;
    }
  }

  const readF = (idx: number): number | null => {
    const v = bestFrame?.freqs[idx];
    return v !== undefined && Number.isFinite(v) && v > 0 ? v : null;
  };

  return {
    f0Mean: voicedCount > 0 ? f0Sum / voicedCount : null,
    f0Min: voicedCount > 0 ? f0Min : null,
    f0Max: voicedCount > 0 ? f0Max : null,
    voicedCount,
    f1: readF(0),
    f2: readF(1),
    f3: readF(2)
  };
}

function formatHz(v: number | null, digits = 0): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)} Hz`;
}

export const InspectorPanel = forwardRef<InspectorPanelHandle, InspectorPanelProps>(
  ({ onStartPlayback }, ref) => {
    const tg = useEditorStore((s) => s.tg);
    const mode = useEditorStore((s) => s.mode);
    const setMode = useEditorStore((s) => s.setMode);
    const isReadOnly = mode === 'read';
    const docVersion = useEditorStore((s) => s.docVersion);
    const filename = useEditorStore((s) => s.filename);
    const currentFileFormat = useEditorStore((s) => s.currentFileFormat);
    const sidebarOpen = useEditorStore((s) => s.sidebarOpen);
    const sidebarTab = useEditorStore((s) => s.sidebarTab);
    const selection = useEditorStore((s) => s.selection);
    const setSelection = useEditorStore((s) => s.setSelection);
    const playRange = useEditorStore((s) => s.playRange);
    const setPlayRange = useEditorStore((s) => s.setPlayRange);
    const setPlaybackTime = useEditorStore((s) => s.setPlaybackTime);
    const viewDomain = useEditorStore((s) => s.viewDomain);
    const setViewDomain = useEditorStore((s) => s.setViewDomain);
    const setLoop = useEditorStore((s) => s.setLoop);
    const audioName = useEditorStore((s) => s.audioName);
    const audioDuration = useEditorStore((s) => s.audioDuration);
    const audioSampleRate = useEditorStore((s) => s.audioSampleRate);
    const analysis = useEditorStore((s) => s.analysis);
    const commitTgMutation = useEditorStore((s) => s.commitTgMutation);
    const splitInterval = useEditorStore((s) => s.splitInterval);
    const mergeIntervalWith = useEditorStore((s) => s.mergeIntervalWith);
    const deleteBoundaryAt = useEditorStore((s) => s.deleteBoundaryAt);
    const insertTierAt = useEditorStore((s) => s.insertTierAt);
    const moveTier = useEditorStore((s) => s.moveTier);
    const deleteTier = useEditorStore((s) => s.deleteTier);
    const normalizeTextGrid = useEditorStore((s) => s.normalizeTextGrid);
    const moveTierBoundary = useEditorStore((s) => s.moveTierBoundary);
    const moveSharedTimestamp = useEditorStore((s) => s.moveSharedTimestamp);
    const openExportModal = useEditorStore((s) => s.openExportModal);
    const showToast = useEditorStore((s) => s.showToast);

    // Local editing drafts + race-free target tracking
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [textDraft, setTextDraft] = useState('');
    const draftTargetRef = useRef<
      { kind: 'interval' | 'point'; tierIndex: number; itemIndex: number } | null
    >(null);
    const draftValueRef = useRef('');
    const draftDirtyRef = useRef(false);
    const [trigraphPreview, setTrigraphPreview] = useState<string | null>(null);
    const [linkAdjacent, setLinkAdjacent] = useState(true);
    const [boundaryShared, setBoundaryShared] = useState(false);

    // Numeric input drafts
    const [startInput, setStartInput] = useState('');
    const [endInput, setEndInput] = useState('');
    const [singleTimeInput, setSingleTimeInput] = useState('');
    const [tierNameInput, setTierNameInput] = useState('');

    // Diagnostics for document overview
    const [diagnostics, setDiagnostics] = useState<TierDiagnostics[]>([]);

    // Resolve active target objects safely
    const activeInterval =
      selection?.kind === 'interval'
        ? tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex] ?? null
        : null;
    const activePoint =
      selection?.kind === 'point'
        ? tg.tiers[selection.tierIndex]?.points[selection.itemIndex] ?? null
        : null;
    const activeTier =
      selection &&
      (selection.kind === 'tier' ||
        selection.kind === 'interval' ||
        selection.kind === 'point' ||
        selection.kind === 'boundary')
        ? tg.tiers[selection.tierIndex] ?? null
        : null;

    // Commit interval or point text draft to its exact owning target (race-free on rapid selection switch)
    const commitDraftTarget = useCallback(
      (
        tgt: { kind: 'interval' | 'point'; tierIndex: number; itemIndex: number } | null,
        valueToCommit: string
      ) => {
        if (!tgt) return;
        const st = useEditorStore.getState();
        if (st.mode === 'read') return;
        const bridge = getPlatformBridge();
        if (tgt.kind === 'interval') {
          const cur = st.tg.tiers[tgt.tierIndex]?.intervals[tgt.itemIndex];
          if (cur && cur.text !== valueToCommit) {
            void primeTrigraphString(valueToCommit, bridge).then(() => st.bumpDocVersion());
            st.commitTgMutation((draft) => {
              const target = draft.tiers[tgt.tierIndex]?.intervals[tgt.itemIndex];
              if (target) target.text = valueToCommit;
            });
          }
        } else if (tgt.kind === 'point') {
          const cur = st.tg.tiers[tgt.tierIndex]?.points[tgt.itemIndex];
          if (cur && cur.mark !== valueToCommit) {
            void primeTrigraphString(valueToCommit, bridge).then(() => st.bumpDocVersion());
            st.commitTgMutation((draft) => {
              const target = draft.tiers[tgt.tierIndex]?.points[tgt.itemIndex];
              if (target) target.mark = valueToCommit;
            });
          }
        }
      },
      []
    );

    const handleDraftValueChange = useCallback((v: string) => {
      if (useEditorStore.getState().mode === 'read') return;
      setTextDraft(v);
      draftValueRef.current = v;
      draftDirtyRef.current = true;
    }, []);

    const flushPendingRef = useRef<() => void>(() => {});
    const resetDraftRef = useRef<() => void>(() => {});

    const handleInspectorUnhandledKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          flushPendingRef.current();
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          resetDraftRef.current();
          (e.target as HTMLTextAreaElement).blur();
        }
      },
      []
    );

    const ipaIme = useIpaIme({
      textareaRef,
      value: textDraft,
      onChangeValue: handleDraftValueChange,
      active: Boolean(
        !isReadOnly &&
          sidebarOpen &&
          sidebarTab === 'inspector' &&
          (selection?.kind === 'interval' || selection?.kind === 'point')
      ),
      onUnhandledKeyDown: handleInspectorUnhandledKeyDown
    });

    const flushPendingTextDraft = useCallback(() => {
      const resolved = ipaIme.resolvePendingValue();
      if (resolved !== draftValueRef.current) {
        draftValueRef.current = resolved;
        draftDirtyRef.current = true;
        setTextDraft(resolved);
      }
      ipaIme.clearComposing();
      if (draftDirtyRef.current && draftTargetRef.current) {
        const tgt = draftTargetRef.current;
        const val = draftValueRef.current;
        draftDirtyRef.current = false;
        commitDraftTarget(tgt, val);
      }
    }, [commitDraftTarget, ipaIme]);
    flushPendingRef.current = flushPendingTextDraft;

    resetDraftRef.current = () => {
      ipaIme.clearComposing();
      const orig =
        selection?.kind === 'interval'
          ? activeInterval?.text ?? ''
          : selection?.kind === 'point'
            ? activePoint?.mark ?? ''
            : '';
      draftDirtyRef.current = false;
      draftValueRef.current = orig;
      setTextDraft(orig);
    };

    // Flush any uncommitted text edit when sidebar collapses or switches away from Inspector
    useEffect(() => {
      if (!sidebarOpen || sidebarTab !== 'inspector') {
        flushPendingRef.current();
      }
    }, [sidebarOpen, sidebarTab]);

    // Clear any transient IME state & ensure displayed drafts match committed data on entering read-only mode
    useEffect(() => {
      if (isReadOnly) {
        ipaIme.clearComposing();
        draftDirtyRef.current = false;
        if (selection?.kind === 'interval' && activeInterval) {
          setTextDraft(activeInterval.text);
          draftValueRef.current = activeInterval.text;
          setStartInput(formatPraatDouble(activeInterval.xmin));
          setEndInput(formatPraatDouble(activeInterval.xmax));
        } else if (selection?.kind === 'point' && activePoint) {
          setTextDraft(activePoint.mark);
          draftValueRef.current = activePoint.mark;
          setSingleTimeInput(formatPraatDouble(activePoint.number));
        } else if (selection?.kind === 'tier' && activeTier) {
          setTierNameInput(activeTier.name);
        }
      }
    }, [isReadOnly, ipaIme, selection, activeInterval, activePoint, activeTier]);

    // Flush any uncommitted text edit if the Inspector unmounts
    useEffect(() => {
      return () => {
        flushPendingRef.current();
      };
    }, []);

    // Sync local drafts when selection or document data changes
    useEffect(() => {
      const nextTarget =
        selection?.kind === 'interval'
          ? { kind: 'interval' as const, tierIndex: selection.tierIndex, itemIndex: selection.itemIndex }
          : selection?.kind === 'point'
            ? { kind: 'point' as const, tierIndex: selection.tierIndex, itemIndex: selection.itemIndex }
            : null;

      const prevTarget = draftTargetRef.current;
      const targetChanged =
        prevTarget?.kind !== nextTarget?.kind ||
        prevTarget?.tierIndex !== nextTarget?.tierIndex ||
        prevTarget?.itemIndex !== nextTarget?.itemIndex;

      if (targetChanged && draftDirtyRef.current && prevTarget) {
        const valToCommit = draftValueRef.current;
        draftDirtyRef.current = false;
        commitDraftTarget(prevTarget, valToCommit);
      }
      if (targetChanged) {
        ipaIme.clearComposing();
      }

      draftTargetRef.current = nextTarget;

      if (selection?.kind === 'interval' && activeInterval) {
        setTextDraft(activeInterval.text);
        draftValueRef.current = activeInterval.text;
        draftDirtyRef.current = false;
        setStartInput(formatPraatDouble(activeInterval.xmin));
        setEndInput(formatPraatDouble(activeInterval.xmax));
      } else if (selection?.kind === 'point' && activePoint) {
        setTextDraft(activePoint.mark);
        draftValueRef.current = activePoint.mark;
        draftDirtyRef.current = false;
        setSingleTimeInput(formatPraatDouble(activePoint.number));
      } else if (selection?.kind === 'boundary' || selection?.kind === 'spine') {
        setSingleTimeInput(formatPraatDouble(selection.time));
      } else if (selection?.kind === 'tier' && activeTier) {
        setTierNameInput(activeTier.name);
      } else if (!selection && playRange) {
        setStartInput(formatPraatDouble(playRange.start));
        setEndInput(formatPraatDouble(playRange.end));
      }
    }, [
      selection,
      activeInterval?.text,
      activeInterval?.xmin,
      activeInterval?.xmax,
      activePoint?.mark,
      activePoint?.number,
      activeTier?.name,
      playRange?.start,
      playRange?.end,
      commitDraftTarget
    ]);

    // Live Praat \xx trigraph preview for interval / point text drafts
    useEffect(() => {
      if (selection?.kind !== 'interval' && selection?.kind !== 'point') {
        setTrigraphPreview(null);
        return;
      }
      if (!textDraft.includes('\\')) {
        setTrigraphPreview(null);
        return;
      }
      const syncCached = decodeTrigraphGlossSync(textDraft);
      if (syncCached) setTrigraphPreview(syncCached);
      let cancelled = false;
      void getPlatformBridge()
        .decodePraatTrigraphs(textDraft)
        .then((res) => {
          if (!cancelled) setTrigraphPreview(res.changed ? res.text : null);
        })
        .catch(() => {
          if (!cancelled) setTrigraphPreview(null);
        });
      return () => {
        cancelled = true;
      };
    }, [selection?.kind, textDraft]);

    // Document structural diagnostics when overview is shown
    useEffect(() => {
      if (selection !== null || playRange !== null) return;
      let cancelled = false;
      void getPlatformBridge()
        .scanDiagnostics(tg)
        .then((res) => {
          if (!cancelled) setDiagnostics(res);
        })
        .catch(() => {
          if (!cancelled) setDiagnostics([]);
        });
      return () => {
        cancelled = true;
      };
    }, [tg, docVersion, selection, playRange]);

    // Allow IpaDock to insert symbols directly into the focused Inspector textarea
    useImperativeHandle(
      ref,
      () => ({
        insertIpaSymbol: (sym: string, isTieBar = false) => {
          if (useEditorStore.getState().mode === 'read') return false;
          const el = textareaRef.current;
          if (!el || document.activeElement !== el || el.readOnly) return false;
          ipaIme.clearComposing();
          return ipaIme.insertAtCaret(sym, isTieBar);
        },
        flushDraft: () => {
          if (useEditorStore.getState().mode === 'read') return;
          flushPendingRef.current();
        }
      }),
      [ipaIme]
    );

    // Acoustic stats for active interval or playRange
    const intervalAcoustic = useMemo(() => {
      if (selection?.kind !== 'interval' || !activeInterval) return null;
      return computeAcousticStats(analysis, activeInterval.xmin, activeInterval.xmax);
    }, [selection?.kind, activeInterval?.xmin, activeInterval?.xmax, analysis]);

    const rangeAcoustic = useMemo(() => {
      if (selection !== null || !playRange) return null;
      return computeAcousticStats(analysis, playRange.start, playRange.end);
    }, [selection, playRange?.start, playRange?.end, analysis]);

    const copyAcousticTsv = (
      stats: AcousticStats,
      tMin: number,
      tMax: number,
      label?: string
    ) => {
      const durMs = Math.max(0, (tMax - tMin) * 1000).toFixed(1);
      const cols = [
        ...(label !== undefined ? [label.replace(/[\t\r\n]+/g, ' ')] : []),
        formatPraatDouble(tMin),
        formatPraatDouble(tMax),
        durMs,
        stats.f0Mean !== null ? stats.f0Mean.toFixed(1) : '',
        stats.f0Min !== null ? stats.f0Min.toFixed(1) : '',
        stats.f0Max !== null ? stats.f0Max.toFixed(1) : '',
        stats.f1 !== null ? stats.f1.toFixed(0) : '',
        stats.f2 !== null ? stats.f2.toFixed(0) : '',
        stats.f3 !== null ? stats.f3.toFixed(0) : ''
      ];
      void navigator.clipboard
        .writeText(cols.join('\t'))
        .then(() => showToast('已复制声学数据（制表符分隔）'))
        .catch(() => showToast('剪贴板写入受限', true));
    };

    // Interval start / end mutations
    const updateIntervalBound = (which: 'start' | 'end', targetVal: number) => {
      if (isReadOnly) return;
      if (selection?.kind !== 'interval' || !activeInterval) return;
      const tier = tg.tiers[selection.tierIndex];
      if (!tier || tier.kind !== 'intervalTier') return;
      const ii = selection.itemIndex;
      const val = round6(targetVal);
      if (!Number.isFinite(val)) return;

      if (which === 'start') {
        if (val >= activeInterval.xmax) {
          showToast('起始时间必须小于结束时间', true);
          setStartInput(formatPraatDouble(activeInterval.xmin));
          return;
        }
        const prev = tier.intervals[ii - 1];
        const linked = Boolean(linkAdjacent && prev && Math.abs(prev.xmax - activeInterval.xmin) < 1e-9);
        if (linked && val <= prev.xmin) {
          showToast('起始时间不能越过前一个区间起点', true);
          setStartInput(formatPraatDouble(activeInterval.xmin));
          return;
        }
        if (val === activeInterval.xmin) return;
        commitTgMutation((draft) => {
          const dTier = draft.tiers[selection.tierIndex];
          const cur = dTier.intervals[ii];
          const dPrev = dTier.intervals[ii - 1];
          if (linkAdjacent && dPrev && Math.abs(dPrev.xmax - cur.xmin) < 1e-9 && val > dPrev.xmin) {
            dPrev.xmax = val;
          }
          cur.xmin = val;
        });
        if (playRange && Math.abs(playRange.start - activeInterval.xmin) < 1e-6 && Math.abs(playRange.end - activeInterval.xmax) < 1e-6) {
          setPlayRange({ start: val, end: activeInterval.xmax });
        }
      } else {
        if (val <= activeInterval.xmin) {
          showToast('结束时间必须大于起始时间', true);
          setEndInput(formatPraatDouble(activeInterval.xmax));
          return;
        }
        const next = tier.intervals[ii + 1];
        const linked = Boolean(linkAdjacent && next && Math.abs(next.xmin - activeInterval.xmax) < 1e-9);
        if (linked && val >= next.xmax) {
          showToast('结束时间不能越过下一个区间终点', true);
          setEndInput(formatPraatDouble(activeInterval.xmax));
          return;
        }
        if (val === activeInterval.xmax) return;
        commitTgMutation((draft) => {
          const dTier = draft.tiers[selection.tierIndex];
          const cur = dTier.intervals[ii];
          const dNext = dTier.intervals[ii + 1];
          if (linkAdjacent && dNext && Math.abs(dNext.xmin - cur.xmax) < 1e-9 && val < dNext.xmax) {
            dNext.xmin = val;
          }
          cur.xmax = val;
        });
        if (playRange && Math.abs(playRange.start - activeInterval.xmin) < 1e-6 && Math.abs(playRange.end - activeInterval.xmax) < 1e-6) {
          setPlayRange({ start: activeInterval.xmin, end: val });
        }
      }
    };

    // Point timestamp mutation
    const updatePointTime = (targetVal: number) => {
      if (isReadOnly) return;
      if (selection?.kind !== 'point' || !activePoint || !activeTier) return;
      const val = round6(Math.max(activeTier.xmin, Math.min(activeTier.xmax, targetVal)));
      if (!Number.isFinite(val) || val === activePoint.number) {
        setSingleTimeInput(formatPraatDouble(activePoint.number));
        return;
      }
      if (activeTier.points.some((p, i) => i !== selection.itemIndex && p.number === val)) {
        showToast('目标时刻已存在标点', true);
        setSingleTimeInput(formatPraatDouble(activePoint.number));
        return;
      }
      let nextIdx = selection.itemIndex;
      commitTgMutation((draft) => {
        const dTier = draft.tiers[selection.tierIndex];
        const pt = dTier.points[selection.itemIndex];
        if (!pt) return;
        pt.number = val;
        dTier.points.sort((a, b) => a.number - b.number);
        nextIdx = dTier.points.indexOf(pt);
      });
      setSelection({ kind: 'point', tierIndex: selection.tierIndex, itemIndex: Math.max(0, nextIdx) });
    };

    // Boundary or spine timestamp mutation
    const updateBoundaryOrSpineTime = (targetVal: number) => {
      if (isReadOnly) return;
      if (!selection || (selection.kind !== 'boundary' && selection.kind !== 'spine')) return;
      const val = round6(targetVal);
      if (!Number.isFinite(val) || Math.abs(val - selection.time) < 1e-9) {
        setSingleTimeInput(formatPraatDouble(selection.time));
        return;
      }
      if (selection.kind === 'boundary') {
        if (moveTierBoundary(selection.tierIndex, selection.time, val, boundaryShared)) {
          setSelection({ kind: 'boundary', tierIndex: selection.tierIndex, time: val, bandIndex: selection.bandIndex });
        } else {
          setSingleTimeInput(formatPraatDouble(selection.time));
        }
      } else {
        if (moveSharedTimestamp(selection.time, val)) {
          setSelection({ kind: 'spine', time: val, bandIndex: selection.bandIndex });
        } else {
          setSingleTimeInput(formatPraatDouble(selection.time));
        }
      }
    };

    const handleSnapZeroCrossing = async () => {
      if (isReadOnly) return;
      if (!analysis || !selection || (selection.kind !== 'boundary' && selection.kind !== 'spine')) return;
      try {
        const snapped = round6(
          await getPlatformBridge().findZeroCrossing(analysis.sessionId, selection.time, 0.015)
        );
        if (Math.abs(snapped - selection.time) < 1e-7) {
          showToast('当前位置已位于最近过零点');
          return;
        }
        updateBoundaryOrSpineTime(snapped);
        showToast(`已吸附至最近过零点 (${snapped.toFixed(6)} s)`);
      } catch (err) {
        showToast(`过零点吸附失败：${String(err)}`, true);
      }
    };

    const renderAcousticBlock = (
      stats: AcousticStats | null,
      tMin: number,
      tMax: number,
      label?: string
    ) => {
      if (!analysis || !stats) return null;
      return (
        <div className="sb-stack">
          <div className="sb-metric-grid">
            <div className="sb-metric-cell">
              <span className="sb-metric-lbl">平均基频 F₀</span>
              <span className="sb-metric-val">{formatHz(stats.f0Mean, 1)}</span>
            </div>
            <div className="sb-metric-cell">
              <span className="sb-metric-lbl">基频范围</span>
              <span className="sb-metric-val">
                {stats.f0Min !== null && stats.f0Max !== null
                  ? `${stats.f0Min.toFixed(0)}–${stats.f0Max.toFixed(0)} Hz`
                  : '—'}
              </span>
            </div>
          </div>
          <div className="sb-metric-grid sb-metric-grid-3">
            <div className="sb-metric-cell">
              <span className="sb-metric-lbl">中点 F₁</span>
              <span className="sb-metric-val">{formatHz(stats.f1, 0)}</span>
            </div>
            <div className="sb-metric-cell">
              <span className="sb-metric-lbl">中点 F₂</span>
              <span className="sb-metric-val">{formatHz(stats.f2, 0)}</span>
            </div>
            <div className="sb-metric-cell">
              <span className="sb-metric-lbl">中点 F₃</span>
              <span className="sb-metric-val">{formatHz(stats.f3, 0)}</span>
            </div>
          </div>
          <button
            type="button"
            className="compact sb-full-btn"
            title="复制起止时间、时长、基频与共振峰读数（制表符分隔）"
            onClick={() => copyAcousticTsv(stats, tMin, tMax, label)}
          >
            <UiIcon name="copy" size={13} />
            <span>复制声学数据</span>
          </button>
        </div>
      );
    };

    const readOnlyBanner = isReadOnly ? (
      <div className="sb-readonly-banner" role="status">
        <span className="sb-readonly-text">当前为只读模式</span>
        <button
          type="button"
          className="compact sb-readonly-btn"
          onClick={() => setMode('edit')}
        >
          切换至编辑
        </button>
      </div>
    ) : null;

    // 1. INTERVAL SELECTED
    if (selection?.kind === 'interval' && activeInterval && activeTier) {
      const ti = selection.tierIndex;
      const ii = selection.itemIndex;
      const durSec = Math.max(0, activeInterval.xmax - activeInterval.xmin);
      const durMs = durSec * 1000;
      const isZoomedHere = Boolean(
        viewDomain &&
          Math.abs(viewDomain.min - activeInterval.xmin) < 1e-4 &&
          Math.abs(viewDomain.max - activeInterval.xmax) < 1e-4
      );

      return (
        <div className="sb-panel-root">
          <div className="sb-context-strip">
            <span className="sb-context-tag">
              第 {ti + 1} 层 · 第 {ii + 1} 段
            </span>
            <span className="sb-context-name" title={activeTier.name || '未命名层'}>
              {activeTier.name || '未命名层'}
            </span>
          </div>
          {readOnlyBanner}

          <CollapsibleSection id="insp-iv-text" title="文本与音标" defaultOpen={true}>
            <div className="sb-stack">
              <div className={`sb-ipa-field-wrap ${!isReadOnly && ipaIme.ipaMode !== 'off' ? 'has-pill' : ''}`}>
                {!isReadOnly && <IpaModePill ime={ipaIme} className="is-sidebar-docked" />}
                <textarea
                  ref={textareaRef}
                  className={`sb-textarea ${isReadOnly ? 'is-readonly' : ''}`}
                  data-ipa-input={isReadOnly ? undefined : '1'}
                  rows={3}
                  spellCheck={false}
                  readOnly={isReadOnly}
                  placeholder={isReadOnly ? '（空区间）' : '输入区间标注文本或音标…'}
                  value={textDraft}
                  onChange={isReadOnly ? undefined : (e) => handleDraftValueChange(e.target.value)}
                  onCompositionStart={isReadOnly ? undefined : ipaIme.onCompositionStart}
                  onCompositionEnd={isReadOnly ? undefined : ipaIme.onCompositionEnd}
                  onKeyDown={isReadOnly ? undefined : ipaIme.onKeyDown}
                  onKeyUp={isReadOnly ? undefined : ipaIme.onKeyUp}
                  onBlur={
                    isReadOnly
                      ? undefined
                      : (e) => {
                          if (isIpaRelatedElement(e.relatedTarget)) return;
                          flushPendingTextDraft();
                        }
                  }
                />
              </div>
              {!isReadOnly && <IpaImePopover ime={ipaIme} />}
              {trigraphPreview && (
                <div className="sb-trigraph-preview">
                  <span className="sb-trigraph-label">音标预览</span>
                  <span className="sb-trigraph-val selectable">{trigraphPreview}</span>
                </div>
              )}
              <div className="sb-hint">
                {isReadOnly
                  ? '只读模式：可选中复制文本，切换至编辑模式后修改。'
                  : '失焦或按 Ctrl+Enter 提交，Ctrl+\\ 切换音标输入，支持音标盘直输。'}
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            id="insp-iv-time"
            title="起止时间与微调"
            badge={formatDurationBadge(durSec)}
            defaultOpen={true}
          >
            <div className="sb-stack">
              <div className="sb-field-grid-2">
                <label className="sb-field">
                  <span className="sb-field-lbl">起始 (s)</span>
                  <input
                    type="number"
                    step="any"
                    readOnly={isReadOnly}
                    disabled={isReadOnly}
                    value={startInput}
                    onChange={isReadOnly ? undefined : (e) => setStartInput(e.target.value)}
                    onBlur={isReadOnly ? undefined : () => updateIntervalBound('start', parseFloat(startInput))}
                    onKeyDown={
                      isReadOnly
                        ? undefined
                        : (e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              (e.target as HTMLInputElement).blur();
                            }
                          }
                    }
                  />
                </label>
                <label className="sb-field">
                  <span className="sb-field-lbl">结束 (s)</span>
                  <input
                    type="number"
                    step="any"
                    readOnly={isReadOnly}
                    disabled={isReadOnly}
                    value={endInput}
                    onChange={isReadOnly ? undefined : (e) => setEndInput(e.target.value)}
                    onBlur={isReadOnly ? undefined : () => updateIntervalBound('end', parseFloat(endInput))}
                    onKeyDown={
                      isReadOnly
                        ? undefined
                        : (e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              (e.target as HTMLInputElement).blur();
                            }
                          }
                    }
                  />
                </label>
              </div>

              <div className="sb-kv-row">
                <span className="sb-kv-key">区间时长</span>
                <span className="sb-kv-val mono">
                  {durMs.toFixed(1)} ms / {durSec.toFixed(4)} s
                </span>
              </div>

              <div className="sb-nudge-group">
                <span className="sb-nudge-lbl">起始微调</span>
                <div className="sb-nudge-row">
                  {([-0.01, -0.001, 0.001, 0.01] as const).map((delta) => (
                    <button
                      key={`st-${delta}`}
                      type="button"
                      className="compact sb-nudge-btn"
                      disabled={isReadOnly}
                      title={isReadOnly ? '请先切换至编辑模式' : undefined}
                      onClick={() => updateIntervalBound('start', activeInterval.xmin + delta)}
                    >
                      {delta < 0 ? `−${Math.abs(delta * 1000)}` : `+${delta * 1000}`}ms
                    </button>
                  ))}
                </div>
              </div>

              <div className="sb-nudge-group">
                <span className="sb-nudge-lbl">结束微调</span>
                <div className="sb-nudge-row">
                  {([-0.01, -0.001, 0.001, 0.01] as const).map((delta) => (
                    <button
                      key={`en-${delta}`}
                      type="button"
                      className="compact sb-nudge-btn"
                      disabled={isReadOnly}
                      title={isReadOnly ? '请先切换至编辑模式' : undefined}
                      onClick={() => updateIntervalBound('end', activeInterval.xmax + delta)}
                    >
                      {delta < 0 ? `−${Math.abs(delta * 1000)}` : `+${delta * 1000}`}ms
                    </button>
                  ))}
                </div>
              </div>

              <label className={`export-check ${isReadOnly ? 'is-disabled' : ''}`}>
                <input
                  type="checkbox"
                  disabled={isReadOnly}
                  checked={linkAdjacent}
                  onChange={(e) => setLinkAdjacent(e.target.checked)}
                />
                <span>联动相邻边界</span>
              </label>
            </div>
          </CollapsibleSection>

          {analysis && (
            <CollapsibleSection
              id="insp-iv-acoustic"
              title="声学读数"
              badge={intervalAcoustic?.f0Mean ? `${intervalAcoustic.f0Mean.toFixed(0)} Hz` : undefined}
              defaultOpen={true}
            >
              {renderAcousticBlock(
                intervalAcoustic,
                activeInterval.xmin,
                activeInterval.xmax,
                activeInterval.text
              )}
            </CollapsibleSection>
          )}

          <CollapsibleSection id="insp-iv-actions" title="快捷操作" defaultOpen={true}>
            <div className="sb-action-grid">
              <button
                type="button"
                className="compact"
                disabled={isReadOnly || activeInterval.xmax <= activeInterval.xmin}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) splitInterval(ti, ii);
                }}
              >
                <UiIcon name="split" size={13} />
                <span>从正中切分</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly || ii === 0}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) mergeIntervalWith(ti, ii, -1);
                }}
              >
                <UiIcon name="mergeLeft" size={13} />
                <span>向左合并</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly || ii >= activeTier.intervals.length - 1}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) mergeIntervalWith(ti, ii, 1);
                }}
              >
                <UiIcon name="mergeRight" size={13} />
                <span>向右合并</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly || activeInterval.text === ''}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (isReadOnly) return;
                  draftDirtyRef.current = false;
                  draftValueRef.current = '';
                  setTextDraft('');
                  commitTgMutation((d) => {
                    d.tiers[ti].intervals[ii].text = '';
                  });
                }}
              >
                <UiIcon name="clear" size={13} />
                <span>清空文本</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={activeInterval.xmax <= activeInterval.xmin}
                onClick={() => {
                  setPlayRange({ start: activeInterval.xmin, end: activeInterval.xmax });
                  onStartPlayback(activeInterval.xmin, activeInterval.xmax);
                }}
              >
                <UiIcon name="play" size={13} />
                <span>播放该区间</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={activeInterval.xmax <= activeInterval.xmin}
                onClick={() => {
                  setLoop(true);
                  setPlayRange({ start: activeInterval.xmin, end: activeInterval.xmax });
                  onStartPlayback(activeInterval.xmin, activeInterval.xmax);
                }}
              >
                <UiIcon name="loop" size={13} />
                <span>循环播放</span>
              </button>
              {isZoomedHere ? (
                <button type="button" className="compact active" onClick={() => setViewDomain(null)}>
                  <UiIcon name="zoomReset" size={13} />
                  <span>显示全长</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="compact"
                  disabled={activeInterval.xmax <= activeInterval.xmin}
                  onClick={() => setViewDomain({ min: activeInterval.xmin, max: activeInterval.xmax })}
                >
                  <UiIcon name="zoomIn" size={13} />
                  <span>放大查看</span>
                </button>
              )}
              <button
                type="button"
                className="compact"
                disabled={activeInterval.xmax <= activeInterval.xmin}
                onClick={() => openExportModal('selection')}
              >
                <UiIcon name="export" size={13} />
                <span>以此选区导出</span>
              </button>
            </div>
          </CollapsibleSection>
        </div>
      );
    }

    // 2. POINT SELECTED
    if (selection?.kind === 'point' && activePoint && activeTier) {
      const ti = selection.tierIndex;
      const pi = selection.itemIndex;
      return (
        <div className="sb-panel-root">
          <div className="sb-context-strip">
            <span className="sb-context-tag">
              第 {ti + 1} 层 · 第 {pi + 1} 点
            </span>
            <span className="sb-context-name" title={activeTier.name || '未命名点层'}>
              {activeTier.name || '未命名点层'}
            </span>
          </div>
          {readOnlyBanner}

          <CollapsibleSection id="insp-pt-text" title="文本与音标" defaultOpen={true}>
            <div className="sb-stack">
              <div className={`sb-ipa-field-wrap ${!isReadOnly && ipaIme.ipaMode !== 'off' ? 'has-pill' : ''}`}>
                {!isReadOnly && <IpaModePill ime={ipaIme} className="is-sidebar-docked" />}
                <textarea
                  ref={textareaRef}
                  className={`sb-textarea ${isReadOnly ? 'is-readonly' : ''}`}
                  data-ipa-input={isReadOnly ? undefined : '1'}
                  rows={3}
                  spellCheck={false}
                  readOnly={isReadOnly}
                  placeholder={isReadOnly ? '（空白标点）' : '输入标注点文本或音标…'}
                  value={textDraft}
                  onChange={isReadOnly ? undefined : (e) => handleDraftValueChange(e.target.value)}
                  onCompositionStart={isReadOnly ? undefined : ipaIme.onCompositionStart}
                  onCompositionEnd={isReadOnly ? undefined : ipaIme.onCompositionEnd}
                  onKeyDown={isReadOnly ? undefined : ipaIme.onKeyDown}
                  onKeyUp={isReadOnly ? undefined : ipaIme.onKeyUp}
                  onBlur={
                    isReadOnly
                      ? undefined
                      : (e) => {
                          if (isIpaRelatedElement(e.relatedTarget)) return;
                          flushPendingTextDraft();
                        }
                  }
                />
              </div>
              {!isReadOnly && <IpaImePopover ime={ipaIme} />}
              {trigraphPreview && (
                <div className="sb-trigraph-preview">
                  <span className="sb-trigraph-label">音标预览</span>
                  <span className="sb-trigraph-val selectable">{trigraphPreview}</span>
                </div>
              )}
              <div className="sb-hint">
                {isReadOnly
                  ? '只读模式：可选中复制标记，切换至编辑模式后修改。'
                  : '失焦或按 Ctrl+Enter 提交，Ctrl+\\ 切换音标输入，支持音标盘直输。'}
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            id="insp-pt-time"
            title="时刻与微调"
            badge={`${activePoint.number.toFixed(3)} s`}
            defaultOpen={true}
          >
            <div className="sb-stack">
              <label className="sb-field">
                <span className="sb-field-lbl">标注时刻 (s)</span>
                <input
                  type="number"
                  step="any"
                  readOnly={isReadOnly}
                  disabled={isReadOnly}
                  value={singleTimeInput}
                  onChange={isReadOnly ? undefined : (e) => setSingleTimeInput(e.target.value)}
                  onBlur={isReadOnly ? undefined : () => updatePointTime(parseFloat(singleTimeInput))}
                  onKeyDown={
                    isReadOnly
                      ? undefined
                      : (e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                          }
                        }
                  }
                />
              </label>

              <div className="sb-nudge-group">
                <span className="sb-nudge-lbl">时刻微调</span>
                <div className="sb-nudge-row">
                  {([-0.01, -0.001, 0.001, 0.01] as const).map((delta) => (
                    <button
                      key={`pt-${delta}`}
                      type="button"
                      className="compact sb-nudge-btn"
                      disabled={isReadOnly}
                      title={isReadOnly ? '请先切换至编辑模式' : undefined}
                      onClick={() => updatePointTime(activePoint.number + delta)}
                    >
                      {delta < 0 ? `−${Math.abs(delta * 1000)}` : `+${delta * 1000}`}ms
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="insp-pt-actions" title="快捷操作" defaultOpen={true}>
            <div className="sb-action-grid">
              <button
                type="button"
                className="compact"
                onClick={() => {
                  setPlayRange(null);
                  onStartPlayback(activePoint.number, tg.xmax);
                }}
              >
                <UiIcon name="play" size={13} />
                <span>从此点播放</span>
              </button>
              <button
                type="button"
                className="compact danger"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (isReadOnly) return;
                  commitTgMutation((draft) => {
                    draft.tiers[ti].points.splice(pi, 1);
                  }, null);
                }}
              >
                <UiIcon name="trash" size={13} />
                <span>删除此标注点</span>
              </button>
            </div>
          </CollapsibleSection>
        </div>
      );
    }

    // 3. BOUNDARY OR SPINE SELECTED
    if (selection?.kind === 'boundary' || selection?.kind === 'spine') {
      const isBoundary = selection.kind === 'boundary';
      const tier = isBoundary ? tg.tiers[selection.tierIndex] : null;
      return (
        <div className="sb-panel-root">
          <div className="sb-context-strip">
            <span className="sb-context-tag">
              {isBoundary ? `第 ${selection.tierIndex + 1} 层 · 边界` : '对齐时刻线'}
            </span>
            <span className="sb-context-name">
              {isBoundary ? tier?.name || '未命名层' : '跨层共享时刻'}
            </span>
          </div>
          {readOnlyBanner}

          <CollapsibleSection
            id="insp-bnd-time"
            title="精确时刻与微调"
            badge={`${selection.time.toFixed(3)} s`}
            defaultOpen={true}
          >
            <div className="sb-stack">
              <label className="sb-field">
                <span className="sb-field-lbl">边界时刻 (s)</span>
                <input
                  type="number"
                  step="any"
                  readOnly={isReadOnly}
                  disabled={isReadOnly}
                  value={singleTimeInput}
                  onChange={isReadOnly ? undefined : (e) => setSingleTimeInput(e.target.value)}
                  onBlur={isReadOnly ? undefined : () => updateBoundaryOrSpineTime(parseFloat(singleTimeInput))}
                  onKeyDown={
                    isReadOnly
                      ? undefined
                      : (e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                          }
                        }
                  }
                />
              </label>

              <div className="sb-nudge-group">
                <span className="sb-nudge-lbl">精确微调</span>
                <div className="sb-nudge-row">
                  {([-0.01, -0.001, 0.001, 0.01] as const).map((delta) => (
                    <button
                      key={`bnd-${delta}`}
                      type="button"
                      className="compact sb-nudge-btn"
                      disabled={isReadOnly}
                      title={isReadOnly ? '请先切换至编辑模式' : undefined}
                      onClick={() => updateBoundaryOrSpineTime(selection.time + delta)}
                    >
                      {delta < 0 ? `−${Math.abs(delta * 1000)}` : `+${delta * 1000}`}ms
                    </button>
                  ))}
                </div>
              </div>

              {analysis && (
                <button
                  type="button"
                  className="compact sb-full-btn"
                  disabled={isReadOnly}
                  title={
                    isReadOnly
                      ? '请先切换至编辑模式'
                      : '查找音频波形中距此边界最近的过零点并对齐'
                  }
                  onClick={() => void handleSnapZeroCrossing()}
                >
                  <UiIcon name="zeroCross" size={13} />
                  <span>吸附最近过零点</span>
                </button>
              )}
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="insp-bnd-actions" title="对齐与操作" defaultOpen={true}>
            <div className="sb-stack">
              {isBoundary ? (
                <>
                  <div className="sb-setting-block">
                    <span className="sb-field-lbl">移动作用范围</span>
                    <div className="segmented sb-seg-full" role="group">
                      <button
                        type="button"
                        className={`compact ${!boundaryShared ? 'active' : ''}`}
                        disabled={isReadOnly}
                        title={isReadOnly ? '请先切换至编辑模式' : undefined}
                        onClick={() => setBoundaryShared(false)}
                      >
                        仅当前层
                      </button>
                      <button
                        type="button"
                        className={`compact ${boundaryShared ? 'active' : ''}`}
                        disabled={isReadOnly}
                        title={isReadOnly ? '请先切换至编辑模式' : undefined}
                        onClick={() => setBoundaryShared(true)}
                      >
                        联动对齐层
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="compact danger sb-full-btn"
                    disabled={isReadOnly}
                    title={isReadOnly ? '请先切换至编辑模式' : undefined}
                    onClick={() => {
                      if (!isReadOnly) deleteBoundaryAt(selection.tierIndex, selection.time);
                    }}
                  >
                    <UiIcon name="delBoundary" size={13} />
                    <span>删除边界</span>
                  </button>
                </>
              ) : (
                <>
                  <div className="sb-hint">
                    调整此对齐时刻将同步移动所有处于该时间点的区间边界与标注点。
                  </div>
                  <button
                    type="button"
                    className="compact sb-full-btn"
                    onClick={() => {
                      setPlayRange(null);
                      onStartPlayback(selection.time, tg.xmax);
                    }}
                  >
                    <UiIcon name="play" size={13} />
                    <span>从此位置播放</span>
                  </button>
                </>
              )}
            </div>
          </CollapsibleSection>
        </div>
      );
    }

    // 4. TIER SELECTED
    if (selection?.kind === 'tier' && activeTier) {
      const ti = selection.tierIndex;
      const itemCount =
        activeTier.kind === 'intervalTier' ? activeTier.intervals.length : activeTier.points.length;

      const commitTierName = () => {
        if (isReadOnly) return;
        if (tierNameInput !== activeTier.name) {
          commitTgMutation((d) => {
            if (d.tiers[ti]) d.tiers[ti].name = tierNameInput;
          });
        }
      };

      return (
        <div className="sb-panel-root">
          <div className="sb-context-strip">
            <span className="sb-context-tag">第 {ti + 1} 层</span>
            <span className="sb-context-name" title={activeTier.name || '未命名层'}>
              {activeTier.name || '未命名层'}
            </span>
          </div>
          {readOnlyBanner}

          <CollapsibleSection
            id="insp-tier-info"
            title="层级信息"
            badge={activeTier.kind === 'intervalTier' ? '区间层' : '点层'}
            defaultOpen={true}
          >
            <div className="sb-stack">
              <label className="sb-field">
                <span className="sb-field-lbl">层级名称</span>
                <input
                  type="text"
                  readOnly={isReadOnly}
                  disabled={isReadOnly}
                  value={tierNameInput}
                  onChange={isReadOnly ? undefined : (e) => setTierNameInput(e.target.value)}
                  onBlur={isReadOnly ? undefined : commitTierName}
                  onKeyDown={
                    isReadOnly
                      ? undefined
                      : (e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                          } else if (e.key === 'Escape') {
                            setTierNameInput(activeTier.name);
                            (e.target as HTMLInputElement).blur();
                          }
                        }
                  }
                />
              </label>

              <div className="sb-kv-list">
                <div className="sb-kv-row">
                  <span className="sb-kv-key">层级类型</span>
                  <span className="sb-kv-val">
                    {activeTier.kind === 'intervalTier' ? '区间层 (IntervalTier)' : '点层 (TextTier)'}
                  </span>
                </div>
                <div className="sb-kv-row">
                  <span className="sb-kv-key">条目数量</span>
                  <span className="sb-kv-val mono">
                    {itemCount} {activeTier.kind === 'intervalTier' ? '段区间' : '个标点'}
                  </span>
                </div>
                <div className="sb-kv-row">
                  <span className="sb-kv-key">时间范围</span>
                  <span className="sb-kv-val mono">
                    {formatPraatDouble(activeTier.xmin)} – {formatPraatDouble(activeTier.xmax)} s
                  </span>
                </div>
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="insp-tier-actions" title="层级操作" defaultOpen={true}>
            <div className="sb-action-grid">
              <button
                type="button"
                className="compact"
                disabled={isReadOnly || ti === 0}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) moveTier(ti, -1);
                }}
              >
                <UiIcon name="up" size={13} />
                <span>上移一层</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly || ti >= tg.tiers.length - 1}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) moveTier(ti, 1);
                }}
              >
                <UiIcon name="down" size={13} />
                <span>下移一层</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) insertTierAt(ti, 'intervalTier');
                }}
              >
                <UiIcon name="addIntervalTier" size={13} />
                <span>上方插入区间层</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) insertTierAt(ti + 1, 'intervalTier');
                }}
              >
                <UiIcon name="addIntervalTier" size={13} />
                <span>下方插入区间层</span>
              </button>
              <button
                type="button"
                className="compact"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) insertTierAt(ti + 1, 'textTier');
                }}
              >
                <UiIcon name="addPointTier" size={13} />
                <span>下方插入点层</span>
              </button>
              <button
                type="button"
                className="compact danger"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) deleteTier(ti);
                }}
              >
                <UiIcon name="trash" size={13} />
                <span>删除该层</span>
              </button>
            </div>
          </CollapsibleSection>
        </div>
      );
    }

    // 5. PLAY RANGE ACTIVE (NO SELECTION)
    if (playRange && playRange.end > playRange.start) {
      const durSec = Math.max(0, playRange.end - playRange.start);
      const durMs = durSec * 1000;

      const applyRange = (which: 'start' | 'end', rawVal: number) => {
        if (!Number.isFinite(rawVal)) {
          setStartInput(formatPraatDouble(playRange.start));
          setEndInput(formatPraatDouble(playRange.end));
          return;
        }
        const clamped = round6(Math.max(tg.xmin, Math.min(tg.xmax, rawVal)));
        const nextStart = which === 'start' ? clamped : playRange.start;
        const nextEnd = which === 'end' ? clamped : playRange.end;
        if (nextEnd <= nextStart) {
          showToast('选区结束时间必须大于起始时间', true);
          setStartInput(formatPraatDouble(playRange.start));
          setEndInput(formatPraatDouble(playRange.end));
          return;
        }
        setPlayRange({ start: nextStart, end: nextEnd });
        setPlaybackTime(nextStart, true);
      };

      return (
        <div className="sb-panel-root">
          <div className="sb-context-strip">
            <span className="sb-context-tag">时间选区</span>
            <span className="sb-context-name mono">
              {playRange.start.toFixed(3)} – {playRange.end.toFixed(3)} s
            </span>
          </div>

          <CollapsibleSection
            id="insp-range-time"
            title="选区时间范围"
            badge={formatDurationBadge(durSec)}
            defaultOpen={true}
          >
            <div className="sb-stack">
              <div className="sb-field-grid-2">
                <label className="sb-field">
                  <span className="sb-field-lbl">起始 (s)</span>
                  <input
                    type="number"
                    step="any"
                    value={startInput}
                    onChange={(e) => setStartInput(e.target.value)}
                    onBlur={() => applyRange('start', parseFloat(startInput))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </label>
                <label className="sb-field">
                  <span className="sb-field-lbl">结束 (s)</span>
                  <input
                    type="number"
                    step="any"
                    value={endInput}
                    onChange={(e) => setEndInput(e.target.value)}
                    onBlur={() => applyRange('end', parseFloat(endInput))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </label>
              </div>

              <div className="sb-kv-row">
                <span className="sb-kv-key">选区时长</span>
                <span className="sb-kv-val mono">
                  {durMs.toFixed(1)} ms / {durSec.toFixed(4)} s
                </span>
              </div>

              <button
                type="button"
                className="compact sb-full-btn"
                onClick={() => setPlayRange(null)}
              >
                <UiIcon name="clear" size={13} />
                <span>清除选区</span>
              </button>
            </div>
          </CollapsibleSection>

          {analysis && (
            <CollapsibleSection
              id="insp-range-acoustic"
              title="选区声学统计"
              badge={rangeAcoustic?.f0Mean ? `${rangeAcoustic.f0Mean.toFixed(0)} Hz` : undefined}
              defaultOpen={true}
            >
              {renderAcousticBlock(rangeAcoustic, playRange.start, playRange.end)}
            </CollapsibleSection>
          )}

          <CollapsibleSection id="insp-range-actions" title="选区操作" defaultOpen={true}>
            <div className="sb-action-grid">
              <button
                type="button"
                className="compact"
                onClick={() => onStartPlayback(playRange.start, playRange.end)}
              >
                <UiIcon name="play" size={13} />
                <span>播放选区</span>
              </button>
              <button
                type="button"
                className="compact"
                onClick={() => {
                  setLoop(true);
                  onStartPlayback(playRange.start, playRange.end);
                }}
              >
                <UiIcon name="loop" size={13} />
                <span>循环播放</span>
              </button>
              <button
                type="button"
                className="compact"
                onClick={() => setViewDomain({ min: playRange.start, max: playRange.end })}
              >
                <UiIcon name="zoomIn" size={13} />
                <span>放大选区</span>
              </button>
              <button
                type="button"
                className="compact"
                onClick={() => openExportModal('selection')}
              >
                <UiIcon name="export" size={13} />
                <span>以此选区导出</span>
              </button>
            </div>
          </CollapsibleSection>
        </div>
      );
    }

    // 6. DOCUMENT OVERVIEW (NOTHING SELECTED)
    const totalIntervals = tg.tiers.reduce(
      (acc, t) => acc + (t.kind === 'intervalTier' ? t.intervals.length : 0),
      0
    );
    const totalPoints = tg.tiers.reduce(
      (acc, t) => acc + (t.kind === 'textTier' ? t.points.length : 0),
      0
    );
    const totalDur = Math.max(0, (Number.isFinite(tg.xmax) ? tg.xmax : 0) - (Number.isFinite(tg.xmin) ? tg.xmin : 0));

    const gapTotal = diagnostics.reduce((acc, d) => acc + d.gapCount, 0);
    const overlapTotal = diagnostics.reduce((acc, d) => acc + d.overlapCount, 0);
    const zeroTotal = diagnostics.reduce((acc, d) => acc + d.zeroDurationCount, 0);
    const oodTotal = diagnostics.reduce((acc, d) => acc + (d.outOfDomain ? 1 : 0), 0);
    const anomalyTotal = gapTotal + overlapTotal + zeroTotal + oodTotal;

    return (
      <div className="sb-panel-root">
        <div className="sb-context-strip">
          <span className="sb-context-tag">文档概览</span>
          <span className="sb-context-name" title={filename}>
            {filename}
          </span>
        </div>
        {readOnlyBanner}

        <CollapsibleSection
          id="insp-doc-overview"
          title="文档概览"
          badge={`${tg.tiers.length} 层`}
          defaultOpen={true}
        >
          <div className="sb-kv-list">
            <div className="sb-kv-row">
              <span className="sb-kv-key">文件名称</span>
              <span className="sb-kv-val mono sb-ellipsis" title={filename}>
                {filename}
              </span>
            </div>
            <div className="sb-kv-row">
              <span className="sb-kv-key">文件格式</span>
              <span className="sb-kv-val">{formatFormatLabel(currentFileFormat)}</span>
            </div>
            <div className="sb-kv-row">
              <span className="sb-kv-key">时间范围</span>
              <span className="sb-kv-val mono">
                {formatPraatDouble(tg.xmin)} – {formatPraatDouble(tg.xmax)} s
              </span>
            </div>
            <div className="sb-kv-row">
              <span className="sb-kv-key">文档总长</span>
              <span className="sb-kv-val mono">{totalDur.toFixed(3)} s</span>
            </div>
            <div className="sb-kv-row">
              <span className="sb-kv-key">层级数量</span>
              <span className="sb-kv-val mono">{tg.tiers.length} 层</span>
            </div>
            <div className="sb-kv-row">
              <span className="sb-kv-key">标注统计</span>
              <span className="sb-kv-val mono">
                {totalIntervals} 段区间 · {totalPoints} 个标点
              </span>
            </div>
            {audioName && (
              <div className="sb-kv-row">
                <span className="sb-kv-key">配套录音</span>
                <span className="sb-kv-val mono sb-ellipsis" title={audioName}>
                  {audioName} ({audioDuration.toFixed(2)}s · {(audioSampleRate / 1000).toFixed(1)}kHz)
                </span>
              </div>
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          id="insp-doc-diag"
          title="结构诊断"
          badge={
            <span className={anomalyTotal > 0 ? 'sb-badge-warn' : 'sb-badge-ok'}>
              {anomalyTotal > 0 ? `${anomalyTotal} 处异常` : '无异常'}
            </span>
          }
          defaultOpen={true}
        >
          <div className="sb-stack">
            <div className="sb-kv-list">
              <div className="sb-kv-row">
                <span className="sb-kv-key">区间缝隙</span>
                <span className={`sb-kv-val mono ${gapTotal > 0 ? 'is-warn' : ''}`}>{gapTotal}</span>
              </div>
              <div className="sb-kv-row">
                <span className="sb-kv-key">区间重叠</span>
                <span className={`sb-kv-val mono ${overlapTotal > 0 ? 'is-warn' : ''}`}>{overlapTotal}</span>
              </div>
              <div className="sb-kv-row">
                <span className="sb-kv-key">零时长区间</span>
                <span className={`sb-kv-val mono ${zeroTotal > 0 ? 'is-warn' : ''}`}>{zeroTotal}</span>
              </div>
              <div className="sb-kv-row">
                <span className="sb-kv-key">越界层级</span>
                <span className={`sb-kv-val mono ${oodTotal > 0 ? 'is-warn' : ''}`}>{oodTotal} 层</span>
              </div>
            </div>

            {anomalyTotal > 0 ? (
              <button
                type="button"
                className="compact primary sb-full-btn"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => {
                  if (!isReadOnly) normalizeTextGrid();
                }}
              >
                <UiIcon name="normalize" size={13} />
                <span>一键规范修复</span>
              </button>
            ) : (
              <div className="sb-status-ok">
                <UiIcon name="check" size={13} />
                <span>各层起止对齐且区间连续，未发现结构异常。</span>
              </div>
            )}
          </div>
        </CollapsibleSection>
      </div>
    );
  }
);
