import React, { useEffect, useRef, useState } from 'react';
import { formatKeyCombo, isComposingEvent } from '../../shortcuts/registry';
import { useEditorStore } from '../../store/useEditorStore';
import { resolveEffectiveF0Range, type F0RangeMode } from '../../utils/f0Range';
import { getViewportZoom } from '../../utils/uiScale';
import { TGridIcon, UiIcon } from '../Icons';
import {
  AcousticCueVisualCards,
  QTip,
  ScaleModeVisualCards,
  WrapModeVisualCards
} from '../SettingsVisualCards';
import { ToggleSwitch } from '../ToggleSwitch';

interface SettingsPanelProps {
  onOpenAudioPicker: () => void;
  onClearAudio: () => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  onOpenAudioPicker,
  onClearAudio
}) => {
  const wrapMode = useEditorStore((s) => s.wrapMode);
  const setWrapMode = useEditorStore((s) => s.setWrapMode);
  const targetWidth = useEditorStore((s) => s.targetWidth);
  const widthAutoFit = useEditorStore((s) => s.widthAutoFit);
  const stageAvailableWidth = useEditorStore((s) => s.stageAvailableWidth);
  const setTargetWidth = useEditorStore((s) => s.setTargetWidth);
  const setWidthAutoFit = useEditorStore((s) => s.setWidthAutoFit);
  const layout = useEditorStore((s) => s.layout);
  const scaleMode = useEditorStore((s) => s.scaleMode);
  const setScaleMode = useEditorStore((s) => s.setScaleMode);
  const tickPrecision = useEditorStore((s) => s.tickPrecision);
  const setTickPrecision = useEditorStore((s) => s.setTickPrecision);
  const tickFixedDecimals = useEditorStore((s) => s.tickFixedDecimals);
  const setTickFixedDecimals = useEditorStore((s) => s.setTickFixedDecimals);
  const tickFixedDisabled =
    tickPrecision !== '2' && tickPrecision !== '3' && tickPrecision !== '4';

  const audioName = useEditorStore((s) => s.audioName);
  const audioDuration = useEditorStore((s) => s.audioDuration);
  const audioSampleRate = useEditorStore((s) => s.audioSampleRate);
  const analysis = useEditorStore((s) => s.analysis);
  const showSpectrogram = useEditorStore((s) => s.showSpectrogram);
  const setShowSpectrogram = useEditorStore((s) => s.setShowSpectrogram);
  const maxFreq = useEditorStore((s) => s.maxFreq);
  const setMaxFreq = useEditorStore((s) => s.setMaxFreq);
  const cueMode = useEditorStore((s) => s.cueMode);
  const setCueMode = useEditorStore((s) => s.setCueMode);
  const f0RangeMode = useEditorStore((s) => s.f0RangeMode);
  const setF0RangeMode = useEditorStore((s) => s.setF0RangeMode);
  const f0RangeCustom = useEditorStore((s) => s.f0RangeCustom);
  const setF0RangeCustom = useEditorStore((s) => s.setF0RangeCustom);
  const tierOrder = useEditorStore((s) => s.tierOrder);
  const setTierOrder = useEditorStore((s) => s.setTierOrder);
  const setPreferencesOpen = useEditorStore((s) => s.setPreferencesOpen);

  const [f0MinText, setF0MinText] = useState(() => String(f0RangeCustom[0]));
  const [f0MaxText, setF0MaxText] = useState(() => String(f0RangeCustom[1]));
  const [widthScrubbing, setWidthScrubbing] = useState(false);
  const widthScrubCleanupRef = useRef<(() => void) | null>(null);
  const widthSuppressClickRef = useRef(false);

  useEffect(() => {
    return () => {
      widthScrubCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    setF0MinText(String(f0RangeCustom[0]));
    setF0MaxText(String(f0RangeCustom[1]));
  }, [f0RangeCustom[0], f0RangeCustom[1]]);

  const hasAudio = Boolean(audioName);
  const hasSpec = hasAudio && showSpectrogram;
  const f0Active = hasSpec && (cueMode === 'auto' || cueMode === 'pitch');
  const effF0 = resolveEffectiveF0Range(analysis, f0RangeMode, f0RangeCustom);

  const commitCustomF0 = (which: 'min' | 'max') => {
    const minVal = which === 'min' ? parseFloat(f0MinText) : f0RangeCustom[0];
    const maxVal = which === 'max' ? parseFloat(f0MaxText) : f0RangeCustom[1];
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
      setF0MinText(String(f0RangeCustom[0]));
      setF0MaxText(String(f0RangeCustom[1]));
      return;
    }
    setF0RangeCustom(minVal, maxVal);
  };

  // Width stepper calculation (preserved faithfully)
  const availW = Math.max(260, stageAvailableWidth);
  const renderedW = layout?.width ? Math.round(layout.width) : availW;
  const isAutoMode = wrapMode === 'auto';
  const isEffectiveAuto = isAutoMode
    ? widthAutoFit || targetWidth >= availW
    : widthAutoFit;
  const curEffectiveW = isAutoMode
    ? isEffectiveAuto
      ? availW
      : targetWidth
    : isEffectiveAuto
      ? renderedW
      : Math.max(targetWidth, renderedW);
  const singleHitFloor = !isAutoMode && !widthAutoFit && targetWidth < renderedW - 2;
  const minusDisabled = isAutoMode
    ? !isEffectiveAuto && targetWidth <= 280
    : singleHitFloor || (!widthAutoFit && targetWidth <= 280);
  const plusDisabled = isAutoMode
    ? isEffectiveAuto
    : !widthAutoFit && curEffectiveW >= 18000;
  const singleStep = Math.max(120, Math.round((renderedW * 0.15) / 10) * 10);

  const handleNarrow = () => {
    if (isAutoMode) {
      const baseW = isEffectiveAuto ? availW : targetWidth;
      setTargetWidth(Math.max(280, baseW - 120));
    } else {
      const baseW = widthAutoFit ? renderedW : Math.min(targetWidth, renderedW);
      setTargetWidth(Math.max(280, baseW - singleStep));
    }
  };

  const handleWiden = () => {
    if (isAutoMode) {
      if (isEffectiveAuto) return;
      const nextW = targetWidth + 120;
      if (nextW >= availW - 8) {
        setWidthAutoFit(true);
      } else {
        setTargetWidth(nextW);
      }
    } else {
      const baseW = widthAutoFit ? renderedW : Math.max(targetWidth, renderedW);
      setTargetWidth(Math.min(18000, baseW + singleStep));
    }
  };

  const readoutText = isAutoMode
    ? isEffectiveAuto
      ? `自动 ${availW}px`
      : `${targetWidth} px`
    : widthAutoFit
      ? `自动 ${renderedW}px`
      : `${renderedW} px`;

  const readoutTitle = isAutoMode
    ? isEffectiveAuto
      ? '按住上下拖拽调整折行宽度（Shift 精细调节）'
      : `固定折行宽度 ${targetWidth} px（上下拖拽调节，点击恢复自动）`
    : widthAutoFit
      ? `单行自然宽度 ${renderedW} px（按住上下拖拽调节）`
      : `自定义单行宽度 ${renderedW} px（上下拖拽调节，点击恢复自动）`;

  const handleWidthReadoutPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    widthScrubCleanupRef.current?.();

    const startY = e.clientY;
    const startW = curEffectiveW;
    const autoWrap = isAutoMode;
    const maxAutoW = availW;
    const singlePxPerDrag = Math.max(6, Math.round(renderedW * 0.008));
    let dragged = false;

    const onMove = (ev: PointerEvent) => {
      const z = getViewportZoom();
      const dy = (startY - ev.clientY) / z; // 向上拖增大，向下拖减小
      if (!dragged) {
        if (Math.abs(dy) < 3) return;
        dragged = true;
        widthSuppressClickRef.current = true;
        setWidthScrubbing(true);
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
      }

      const stepPerPx = autoWrap
        ? ev.shiftKey
          ? 1
          : 4
        : ev.shiftKey
          ? 2
          : singlePxPerDrag;
      const rawNext = Math.round(startW + dy * stepPerPx);

      if (autoWrap) {
        if (rawNext >= maxAutoW - 4) {
          setWidthAutoFit(true);
        } else {
          setTargetWidth(Math.max(280, rawNext));
        }
      } else {
        setTargetWidth(Math.max(280, Math.min(18000, rawNext)));
      }
    };

    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      widthScrubCleanupRef.current = null;
      setWidthScrubbing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (dragged) {
        window.setTimeout(() => {
          widthSuppressClickRef.current = false;
        }, 0);
      }
    };

    widthScrubCleanupRef.current = finish;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  return (
    <div className="cs-panel">
      <div className="cs-body">
        {/* 区块 1：谱面排版与刻度 */}
        <section className="cs-sec" aria-label="谱面排版与刻度">
          <div className="cs-sec-hd">
            <span>谱面排版与刻度</span>
          </div>

          <div className="cs-block">
            <span className="cs-lbl cs-lbl-muted">折行方式</span>
            <WrapModeVisualCards value={wrapMode} onChange={setWrapMode} />
          </div>

          <div className="cs-block">
            <span className="cs-lbl cs-lbl-muted">时间比例</span>
            <ScaleModeVisualCards value={scaleMode} onChange={setScaleMode} />
          </div>

          <div className="cs-row">
            <span className="cs-lbl">{isAutoMode ? '最大折行宽度' : '单行展开宽度'}</span>
            <div className="width-stepper">
              <button
                type="button"
                className="icon-btn compact"
                disabled={minusDisabled}
                title={minusDisabled ? '已达最小宽度' : '收窄宽度'}
                onClick={handleNarrow}
              >
                <TGridIcon name="stepper-minus" size={13} />
              </button>
              <button
                type="button"
                className={`width-readout is-scrubbable ${!isEffectiveAuto ? 'is-custom' : ''} ${
                  widthScrubbing ? 'is-scrubbing' : ''
                }`}
                title={readoutTitle}
                onPointerDown={handleWidthReadoutPointerDown}
                onClick={() => {
                  if (widthSuppressClickRef.current) return;
                  if (!isEffectiveAuto) {
                    setWidthAutoFit(true);
                  }
                }}
              >
                {readoutText}
              </button>
              <button
                type="button"
                className="icon-btn compact"
                disabled={plusDisabled}
                title={plusDisabled ? '已达最大宽度' : '加宽宽度'}
                onClick={handleWiden}
              >
                <TGridIcon name="stepper-plus" size={13} />
              </button>
            </div>
          </div>

          <div className="cs-row">
            <span className="cs-lbl">
              <span>刻度精度</span>
              <QTip
                align="right"
                tip="仅简化画面刻度显示并自动展开相邻冲突小数位；悬停、编辑、复制与导出均保留完整精度。"
              />
            </span>
            <div className="pref-seg" style={{ width: 164 }} role="group" aria-label="刻度精度">
              {(
                [
                  ['2', '2 位'],
                  ['3', '3 位'],
                  ['4', '4 位'],
                  ['full', '完整']
                ] as const
              ).map(([val, lbl]) => (
                <button
                  key={val}
                  type="button"
                  className={tickPrecision === val ? 'is-active' : ''}
                  onClick={() => setTickPrecision(val)}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <ToggleSwitch
            label={
              <span className="cs-lbl">
                <span>固定小数位补零</span>
                <QTip align="right" tip="如 10.30；刻度精度设为完整时自动禁用。" />
              </span>
            }
            disabled={tickFixedDisabled}
            checked={tickFixedDecimals}
            onChange={setTickFixedDecimals}
          />
        </section>

        {/* 区块 2：录音与声学图谱 */}
        <section className="cs-sec" aria-label="录音与声学图谱">
          <div className="cs-sec-hd">
            <span>录音与声学图谱</span>
            <span className={`cs-sec-badge ${hasAudio ? 'is-loaded' : ''}`}>
              {hasAudio ? '已载入' : '未载入'}
            </span>
          </div>

          <div className="cs-audio-strip">
            {hasAudio ? (
              <>
                <div className="cs-audio-meta">
                  <span className="cs-audio-name" title={audioName}>
                    {audioName}
                  </span>
                  <span className="cs-audio-sub">
                    {audioDuration.toFixed(2)}s · {(audioSampleRate / 1000).toFixed(1)}kHz
                  </span>
                </div>
                <div className="cs-audio-actions">
                  <button
                    type="button"
                    className="compact"
                    title="更换配套录音"
                    onClick={onOpenAudioPicker}
                  >
                    更换
                  </button>
                  <button
                    type="button"
                    className="compact danger"
                    title="移除当前录音"
                    onClick={onClearAudio}
                  >
                    移除
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="cs-audio-empty">未载入录音</span>
                <button type="button" className="compact" onClick={onOpenAudioPicker}>
                  <UiIcon name="waveform" size={12} />
                  <span>打开录音</span>
                </button>
              </>
            )}
          </div>

          <ToggleSwitch
            label="显示语谱图"
            disabled={!hasAudio}
            checked={hasSpec}
            onChange={setShowSpectrogram}
          />

          <div className="cs-block">
            <span className={`cs-lbl ${!hasSpec ? 'cs-lbl-muted' : ''}`}>声学曲线</span>
            <AcousticCueVisualCards
              value={cueMode}
              disabled={!hasSpec}
              onChange={setCueMode}
            />
          </div>

          <div className="cs-row">
            <span className={`cs-lbl ${!hasSpec ? 'cs-lbl-muted' : ''}`}>最大频率</span>
            <div className="pref-seg" style={{ width: 164 }} role="group" aria-label="最大频率">
              {(
                [
                  [5000, '5 kHz', '5 kHz（聚焦元音与共振峰 F1–F3）'],
                  [8000, '8 kHz', '8 kHz（兼顾元音与高频擦音）'],
                  [10000, '10 kHz', '10 kHz（宽频观测高频摩擦与爆破）']
                ] as const
              ).map(([hz, label, tip]) => {
                const nyquist = audioSampleRate > 0 ? audioSampleRate / 2 : Infinity;
                const exceedsNyquist = audioSampleRate > 0 && hz > nyquist;
                const disabled = !hasSpec || (exceedsNyquist && hz > 5000);
                const title = !hasSpec
                  ? '载入录音并开启语谱图后可调整'
                  : exceedsNyquist
                    ? `超出当前音频 Nyquist 上限 (${(nyquist / 1000).toFixed(1)} kHz)`
                    : tip;
                return (
                  <button
                    key={hz}
                    type="button"
                    className={maxFreq === hz ? 'is-active' : ''}
                    disabled={disabled}
                    title={title}
                    onClick={() => setMaxFreq(hz)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="cs-block">
            <div className="cs-row">
              <span className={`cs-lbl ${!f0Active ? 'cs-lbl-muted' : ''}`}>基频 F0 范围</span>
              <span className="cs-f0-readout">
                {f0Active ? `${Math.round(effF0.floor)}–${Math.round(effF0.ceil)} Hz` : '—'}
              </span>
            </div>
            <div className="pref-seg is-full" role="group" aria-label="基频 F0 范围">
              {(
                [
                  ['auto', '自动', '按当前录音自适应确定基频上下限'],
                  ['male', '男声', '男声常用基频范围 75–300 Hz'],
                  ['female', '女声', '女声常用基频范围 100–500 Hz'],
                  ['custom', '自定义', '手动指定基频显示起止 Hz']
                ] as Array<[F0RangeMode, string, string]>
              ).map(([val, lbl, tip]) => (
                <button
                  key={val}
                  type="button"
                  disabled={!f0Active}
                  className={f0RangeMode === val ? 'is-active' : ''}
                  title={tip}
                  onClick={() => setF0RangeMode(val)}
                >
                  {lbl}
                </button>
              ))}
            </div>
            {f0Active && f0RangeMode === 'custom' && (
              <div className="cs-f0-custom">
                <span>起</span>
                <input
                  type="number"
                  min={40}
                  max={975}
                  step={5}
                  aria-label="基频下限 Hz"
                  value={f0MinText}
                  onChange={(e) => setF0MinText(e.target.value)}
                  onBlur={() => commitCustomF0('min')}
                  onKeyDown={(e) => {
                    if (isComposingEvent(e)) return;
                    if (e.key === 'Enter' || e.code === 'NumpadEnter') {
                      e.preventDefault();
                      e.stopPropagation();
                      (e.target as HTMLInputElement).blur();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setF0MinText(String(f0RangeCustom[0]));
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />
                <span>止</span>
                <input
                  type="number"
                  min={65}
                  max={1000}
                  step={5}
                  aria-label="基频上限 Hz"
                  value={f0MaxText}
                  onChange={(e) => setF0MaxText(e.target.value)}
                  onBlur={() => commitCustomF0('max')}
                  onKeyDown={(e) => {
                    if (isComposingEvent(e)) return;
                    if (e.key === 'Enter' || e.code === 'NumpadEnter') {
                      e.preventDefault();
                      e.stopPropagation();
                      (e.target as HTMLInputElement).blur();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setF0MaxText(String(f0RangeCustom[1]));
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />
                <span>Hz</span>
              </div>
            )}
          </div>

          {hasSpec && (
            <div className="cs-row">
              <span className="cs-lbl">层级顺序</span>
              <div className="pref-seg" style={{ width: 148 }} role="group" aria-label="层级排列顺序">
                <button
                  type="button"
                  className={tierOrder === 'raw' ? 'is-active' : ''}
                  title="按文件原有的层级顺序显示"
                  onClick={() => setTierOrder('raw')}
                >
                  原始顺序
                </button>
                <button
                  type="button"
                  className={tierOrder === 'spec' ? 'is-active' : ''}
                  title="将细颗粒标注层紧贴语谱图下方显示"
                  onClick={() => setTierOrder('spec')}
                >
                  声学优先
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* 面板底部固定轻按钮 */}
      <div className="cs-footer">
        <button
          type="button"
          className="cs-prefs-btn"
          title={`打开偏好设置中心 (${formatKeyCombo('Mod+,')})`}
          onClick={() => setPreferencesOpen(true)}
        >
          <span className="cs-prefs-btn-lead">
            <UiIcon name="gear" size={13} />
            <span>打开偏好设置…</span>
          </span>
          <span className="cs-kbd-cap">{formatKeyCombo('Mod+,')}</span>
        </button>
      </div>
    </div>
  );
};
