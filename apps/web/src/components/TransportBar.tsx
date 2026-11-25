import React, { useEffect, useRef, useState } from 'react';
import { formatKeyCombo, getEffectiveShortcutHint } from '../shortcuts/registry';
import { useEditorStore } from '../store/useEditorStore';
import { ChevronIcon, TGridIcon, UiIcon } from './Icons';

interface TransportBarProps {
  onTogglePlay: () => void;
  onStop: () => void;
  onRateChange: (rate: number) => void;
  onVolumeChange: (vol: number) => void;
  onClearAudio: () => void;
  onOpenAudio: () => void;
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5];

export const TransportBar: React.FC<TransportBarProps> = ({
  onTogglePlay,
  onStop,
  onRateChange,
  onVolumeChange,
  onClearAudio,
  onOpenAudio
}) => {
  const tg = useEditorStore((s) => s.tg);
  const playing = useEditorStore((s) => s.playing);
  const loop = useEditorStore((s) => s.loop);
  const setLoop = useEditorStore((s) => s.setLoop);
  const followPlayhead = useEditorStore((s) => s.followPlayhead);
  const setFollowPlayhead = useEditorStore((s) => s.setFollowPlayhead);
  const rate = useEditorStore((s) => s.rate);
  const volume = useEditorStore((s) => s.volume);
  const currentTime = useEditorStore((s) => s.currentTime);
  const playRange = useEditorStore((s) => s.playRange);
  const viewDomain = useEditorStore((s) => s.viewDomain);
  const setViewDomain = useEditorStore((s) => s.setViewDomain);
  const selection = useEditorStore((s) => s.selection);
  const audioName = useEditorStore((s) => s.audioName);
  const audioDuration = useEditorStore((s) => s.audioDuration);
  const scaleMode = useEditorStore((s) => s.scaleMode);
  const setScaleMode = useEditorStore((s) => s.setScaleMode);
  const customShortcuts = useEditorStore((s) => s.customShortcuts);
  const setSidebarTab = useEditorStore((s) => s.setSidebarTab);
  const setSidebarOpen = useEditorStore((s) => s.setSidebarOpen);

  const scaleToggleHint = getEffectiveShortcutHint('scale-toggle', customShortcuts);

  const [rateOpen, setRateOpen] = useState(false);
  const rateWrapRef = useRef<HTMLDivElement>(null);
  const volTrackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (rateWrapRef.current && !rateWrapRef.current.contains(e.target as Node)) {
        setRateOpen(false);
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  let zoomableRange: { start: number; end: number } | null = null;
  if (playRange && playRange.end - playRange.start >= 0.005) {
    zoomableRange = playRange;
  } else if (selection?.kind === 'interval') {
    const iv = tg.tiers[selection.tierIndex]?.intervals[selection.itemIndex];
    if (iv && iv.xmax - iv.xmin >= 0.005) {
      zoomableRange = { start: iv.xmin, end: iv.xmax };
    }
  }

  const curMin = viewDomain ? viewDomain.min : tg.xmin;
  const curMax = viewDomain ? viewDomain.max : tg.xmax;
  const canZoom = Boolean(
    zoomableRange && (zoomableRange.start > curMin + 0.001 || zoomableRange.end < curMax - 0.001)
  );

  const handleVolPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const track = volTrackRef.current;
    if (!track) return;
    const apply = (clientX: number) => {
      const rect = track.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      onVolumeChange(frac);
    };
    apply(e.clientX);
    const onMove = (ev: PointerEvent) => apply(ev.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="transportbar">
      <div className="bar-group">
        <button type="button" className="icon-btn" title="播放 / 暂停 (空格)" onClick={onTogglePlay}>
          {playing ? (
            <TGridIcon name="transport-pause" size={14} />
          ) : (
            <TGridIcon name="transport-play" size={14} />
          )}
        </button>

        <button type="button" className="icon-btn" title="停止并回到起点" onClick={onStop}>
          <TGridIcon name="transport-stop" size={14} />
        </button>

        <button
          type="button"
          className={loop ? 'active' : ''}
          aria-pressed={loop}
          title="循环播放当前范围 (L)"
          onClick={() => setLoop(!loop)}
        >
          <UiIcon name="loop" size={13} />
          <span>循环</span>
        </button>

        <button
          type="button"
          className={followPlayhead ? 'active' : ''}
          aria-pressed={followPlayhead}
          title="播放时自动跟随播放头滚动"
          onClick={() => setFollowPlayhead(!followPlayhead)}
        >
          <svg
            className="ui-icon"
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path d="M8 2.4 V13.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M2.5 8 H5.5 M10.5 8 H13.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
            <path
              d="M11.6 6.2 L13.6 8 L11.6 9.8"
              stroke="currentColor"
              strokeWidth="1.35"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>跟随</span>
        </button>

        <div ref={rateWrapRef} className={`menu-wrap ${rateOpen ? 'open' : ''}`}>
          <button
            type="button"
            className="select-trigger"
            style={{ width: 62 }}
            title="播放倍速"
            onClick={() => setRateOpen(!rateOpen)}
          >
            <span>{rate.toFixed(rate % 1 === 0 ? 1 : 2)}×</span>
            <ChevronIcon />
          </button>
          <div className="dropdown left narrow">
            {RATES.map((r) => (
              <button
                key={r}
                type="button"
                className={rate === r ? 'selected' : ''}
                onClick={() => {
                  onRateChange(r);
                  setRateOpen(false);
                }}
              >
                {r.toFixed(r % 1 === 0 ? 1 : 2)}×
              </button>
            ))}
          </div>
        </div>

        <div className="sep" />
        <span className="time-readout">
          {(Number.isFinite(currentTime) ? currentTime : tg.xmin).toFixed(3)}{' '}
          <span className="dim">/ {(Number.isFinite(tg.xmax) ? tg.xmax : 0).toFixed(3)} s</span>
        </span>

        {playRange && (
          <span className="audio-tag">
            {playRange.start.toFixed(3)} – {playRange.end.toFixed(3)} s
          </span>
        )}
        {!playRange && viewDomain && (
          <span className="audio-tag zoom-badge">
            视窗 {viewDomain.min.toFixed(3)} – {viewDomain.max.toFixed(3)} s
          </span>
        )}

        {canZoom && zoomableRange && (
          <button
            type="button"
            className="compact"
            title="将视图放大至当前选定时间区间"
            onClick={() => setViewDomain({ min: zoomableRange!.start, max: zoomableRange!.end })}
          >
            <UiIcon name="zoomIn" size={13} />
            <span>放大选区</span>
          </button>
        )}

        {viewDomain && (
          <button
            type="button"
            className="compact active"
            title="退出局部放大，恢复显示完整时间轴"
            onClick={() => setViewDomain(null)}
          >
            <UiIcon name="zoomReset" size={13} />
            <span>显示全长</span>
          </button>
        )}
      </div>

      <div className="bar-group audio-meta">
        <div
          className="segmented scale-mode-switch"
          role="group"
          aria-label="时间比例模式"
          title={
            scaleToggleHint
              ? `切换时间比例模式：自适应 / 线性 (${scaleToggleHint})`
              : '切换时间比例模式：自适应 / 线性'
          }
        >
          <button
            type="button"
            className={`compact ${scaleMode === 'elastic' ? 'active' : ''}`}
            aria-pressed={scaleMode === 'elastic'}
            title={
              scaleToggleHint
                ? `自适应宽度：短音段按字宽展开，≥0.5s 静音同步折叠 (${scaleToggleHint} 快速切换)`
                : '自适应宽度：短音段按字宽展开，≥0.5s 静音同步折叠'
            }
            onClick={() => setScaleMode('elastic')}
          >
            <UiIcon name="toggleScale" size={13} />
            <span>自适应</span>
          </button>
          <button
            type="button"
            className={`compact ${scaleMode === 'linear' ? 'active' : ''}`}
            aria-pressed={scaleMode === 'linear'}
            title={
              scaleToggleHint
                ? `线性对齐：全图按 1:1 真实物理时长与语谱图严格垂直对齐 (${scaleToggleHint} 快速切换)`
                : '线性对齐：全图按 1:1 真实物理时长与语谱图严格垂直对齐'
            }
            onClick={() => setScaleMode('linear')}
          >
            <span>线性</span>
            {scaleToggleHint && <kbd className="scale-kbd">{scaleToggleHint}</kbd>}
          </button>
        </div>

        <div className="sep" />

        {!audioName ? (
          <button
            type="button"
            className="transport-audio-empty-btn"
            title={`点击载入配套录音 (${formatKeyCombo('Mod+Shift+O')})`}
            onClick={onOpenAudio}
          >
            <UiIcon name="waveform" size={13} />
            <span>未载入录音</span>
          </button>
        ) : (
          <>
            <div className="audio-file-group">
              <button
                type="button"
                className="audio-tag audio-tag-btn"
                title="点击在右侧边栏打开音频与语谱图设置"
                onClick={() => {
                  setSidebarTab('settings');
                  setSidebarOpen(true);
                }}
              >
                <span className="audio-tag-text">
                  {audioName} ({audioDuration.toFixed(2)}s)
                </span>
              </button>
              <button
                type="button"
                className="icon-btn compact danger audio-remove-btn"
                title="移除录音"
                aria-label="移除录音"
                onClick={onClearAudio}
              >
                <UiIcon name="removeAudio" size={14} />
              </button>
            </div>
            <div className="sep" />
            <div className="vol-control tgi-trigger" title="音量" onPointerDown={handleVolPointer}>
              <TGridIcon name="transport-volume" size={14} />
              <div ref={volTrackRef} className="vol-track">
                <div className="vol-rail">
                  <div className="vol-fill" style={{ width: `${Math.round(volume * 100)}%` }} />
                </div>
                <div className="vol-thumb" style={{ left: `${Math.round(volume * 100)}%` }} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
