import React, { useEffect, useState } from 'react';
import { isTauriRuntime } from '../../bridge/PlatformBridge';
import { isComposingEvent } from '../../shortcuts/registry';
import { useEditorStore, type EditInspectorMode, type IpaInputMode } from '../../store/useEditorStore';
import { resolveEffectiveF0Range, type F0RangeMode } from '../../utils/f0Range';
import { UI_SCALE_PRESETS } from '../../utils/uiScale';
import { clampHistoryLimit } from '../../store/historyModel';
import { InfoIcon, TGridIcon, UiIcon } from '../Icons';
import { CollapsibleSection } from './CollapsibleSection';

interface SettingsPanelProps {
  onOpenAudioPicker: () => void;
  onClearAudio: () => void;
  onBatchConvertIpa: (direction: 'toUnicode' | 'toPraat') => void;
}

const IPA_MODE_LABELS: Record<IpaInputMode, string> = {
  off: '关闭',
  yunlong: '云龙音标',
  praat: 'Praat 编码'
};

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  onOpenAudioPicker,
  onClearAudio,
  onBatchConvertIpa
}) => {
  const mode = useEditorStore((s) => s.mode);
  const isReadOnly = mode === 'read';
  const editInspectorMode = useEditorStore((s) => s.editInspectorMode);
  const setEditInspectorMode = useEditorStore((s) => s.setEditInspectorMode);
  const autoOpenInspectorOnSelect = useEditorStore((s) => s.autoOpenInspectorOnSelect);
  const setAutoOpenInspectorOnSelect = useEditorStore((s) => s.setAutoOpenInspectorOnSelect);
  const showMicroLoupe = useEditorStore((s) => s.showMicroLoupe);
  const setShowMicroLoupe = useEditorStore((s) => s.setShowMicroLoupe);
  const showCorpusStatusMarks = useEditorStore((s) => s.showCorpusStatusMarks);
  const setShowCorpusStatusMarks = useEditorStore((s) => s.setShowCorpusStatusMarks);
  const uiScale = useEditorStore((s) => s.uiScale);
  const setUiScale = useEditorStore((s) => s.setUiScale);
  const legendOpen = useEditorStore((s) => s.legendOpen);
  const toggleLegend = useEditorStore((s) => s.toggleLegend);
  const historyLimit = useEditorStore((s) => s.historyLimit);
  const setHistoryLimit = useEditorStore((s) => s.setHistoryLimit);
  const [historyLimitText, setHistoryLimitText] = useState(() => String(historyLimit));

  useEffect(() => {
    setHistoryLimitText(String(historyLimit));
  }, [historyLimit]);

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

  const [f0MinText, setF0MinText] = useState(() => String(f0RangeCustom[0]));
  const [f0MaxText, setF0MaxText] = useState(() => String(f0RangeCustom[1]));

  useEffect(() => {
    setF0MinText(String(f0RangeCustom[0]));
    setF0MaxText(String(f0RangeCustom[1]));
  }, [f0RangeCustom[0], f0RangeCustom[1]]);

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

  const ipaMode = useEditorStore((s) => s.ipaMode);
  const setIpaMode = useEditorStore((s) => s.setIpaMode);
  const ipaDockOpen = useEditorStore((s) => s.ipaDockOpen);
  const setIpaDockOpen = useEditorStore((s) => s.setIpaDockOpen);
  const setAboutOpen = useEditorStore((s) => s.setAboutOpen);
  const isDesktop = isTauriRuntime();

  return (
    <div className="sb-panel-root">
      <CollapsibleSection id="set-ui" title="编辑与界面交互" defaultOpen={true}>
        <div className="sb-stack">
          <div className="sb-setting-block">
            <span className="sb-field-lbl">选中编辑方式</span>
            <div className="segmented sb-seg-full" role="group" aria-label="选中编辑方式">
              {(
                [
                  ['sidebar', '侧边栏'],
                  ['floating', '浮动条']
                ] as Array<[EditInspectorMode, string]>
              ).map(([val, lbl]) => (
                <button
                  key={val}
                  type="button"
                  className={`compact ${editInspectorMode === val ? 'active' : ''}`}
                  onClick={() => setEditInspectorMode(val)}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <label className="export-check">
            <input
              type="checkbox"
              checked={autoOpenInspectorOnSelect}
              onChange={(e) => setAutoOpenInspectorOnSelect(e.target.checked)}
            />
            <span>编辑模式下点选自动展开属性栏</span>
          </label>

          <label className="export-check">
            <input
              type="checkbox"
              checked={showMicroLoupe}
              onChange={(e) => setShowMicroLoupe(e.target.checked)}
            />
            <span>拖拽边界/标点时显示声学放大镜</span>
          </label>

          <label className="export-check">
            <input type="checkbox" checked={legendOpen} onChange={() => toggleLegend()} />
            <span>显示底部交互图例</span>
          </label>

          <label className="export-check">
            <input
              type="checkbox"
              checked={showCorpusStatusMarks}
              onChange={(e) => setShowCorpusStatusMarks(e.target.checked)}
            />
            <span>显示词条状态标记</span>
          </label>
          <div className="sb-hint">
            关闭后隐藏列表与顶栏中的未标、已完成、存疑、需重录标记。
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
              <span
                className="sb-field-lbl"
                title="设置单文档保留的最大可回退历史步数（10–200 步）"
              >
                操作历史上限
              </span>
              <div className="sb-hist-limit-custom">
                <input
                  type="number"
                  className="sb-hist-limit-input"
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
                <span className="sb-hist-limit-unit">步</span>
              </div>
            </div>
            <div className="segmented sb-seg-full" role="group" aria-label="操作历史上限预设">
              {([20, 50, 100, 200] as const).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`compact ${historyLimit === preset ? 'active' : ''}`}
                  onClick={() => setHistoryLimit(preset)}
                >
                  {preset} 步
                </button>
              ))}
            </div>
            <div className="sb-hint">
              默认 50 步（可调 10–200）；800 ms 内连续同目标微调自动合并。调低上限时仅裁剪最早记录，保留当前及后续步与初始快照。
            </div>
          </div>

          <div className="sb-setting-block">
            <span
              className="sb-field-lbl"
              title="调整顶部工具栏、侧边栏、弹窗等外部界面大小（不影响导出图像物理尺寸）"
            >
              界面大小
            </span>
            <div className="segmented sb-seg-full" role="group" aria-label="界面大小">
              {UI_SCALE_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className={`compact ${Math.abs(uiScale - preset.scale) < 0.01 ? 'active' : ''}`}
                  title={`${preset.label}（${preset.pct}）`}
                  onClick={() => setUiScale(preset.scale)}
                >
                  {preset.label} {preset.pct}
                </button>
              ))}
            </div>
          </div>
          <div className="sb-hint">
            调整外部界面缩放（小 100% / 中 120% / 大 140%）；谱面画布缩放可通过 Ctrl+滚轮、Ctrl+±/0 或底部状态栏控制，均不影响导出尺寸。
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="set-layout" title="版面与时间刻度" defaultOpen={true}>
        <div className="sb-stack">
          <div className="sb-setting-block">
            <span className="sb-field-lbl">折行方式</span>
            <div className="segmented sb-seg-full" role="group">
              <button
                type="button"
                className={`compact ${wrapMode === 'auto' ? 'active' : ''}`}
                onClick={() => setWrapMode('auto')}
              >
                自动折行
              </button>
              <button
                type="button"
                className={`compact ${wrapMode === 'single' ? 'active' : ''}`}
                onClick={() => setWrapMode('single')}
              >
                单行展开
              </button>
            </div>
          </div>

          {(() => {
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
                ? '已自动适配当前窗口宽度（点击 − 可收窄折行宽度）'
                : `固定折行宽度 ${targetWidth} px（点击一键恢复自动适配窗口）`
              : widthAutoFit
                ? `单行自然宽度 ${renderedW} px（点击 −/+ 或 Alt+滚轮 可收窄/拉宽）`
                : `自定义单行宽度 ${renderedW} px（点击一键恢复默认自然宽度）`;

            return (
              <div className="sb-setting-inline">
                <span className="sb-field-lbl">
                  {isAutoMode ? '最大折行宽度' : '单行展开宽度'}
                </span>
                <div className="width-stepper">
                  <button
                    type="button"
                    className="icon-btn compact"
                    disabled={minusDisabled}
                    title={
                      minusDisabled
                        ? isAutoMode
                          ? '已达最小折行宽度 (280 px)'
                          : '已达当前文本可读下限'
                        : '收窄宽度'
                    }
                    onClick={handleNarrow}
                  >
                    <TGridIcon name="stepper-minus" size={13} />
                  </button>
                  <button
                    type="button"
                    className={`width-readout ${!isEffectiveAuto ? 'is-custom' : ''}`}
                    disabled={isEffectiveAuto}
                    title={readoutTitle}
                    onClick={() => setWidthAutoFit(true)}
                  >
                    {readoutText}
                  </button>
                  <button
                    type="button"
                    className="icon-btn compact"
                    disabled={plusDisabled}
                    title={
                      plusDisabled
                        ? isAutoMode
                          ? '已适配窗口最大宽度（如需超宽展开请切至「单行展开」）'
                          : '已达最大展开宽度 (18000 px)'
                        : '加宽宽度'
                    }
                    onClick={handleWiden}
                  >
                    <TGridIcon name="stepper-plus" size={13} />
                  </button>
                </div>
              </div>
            );
          })()}

          <div className="sb-setting-block">
            <span className="sb-field-lbl">时间比例</span>
            <div className="segmented sb-seg-full" role="group">
              <button
                type="button"
                className={`compact ${scaleMode === 'elastic' ? 'active' : ''}`}
                title="短音段按文字宽度适度展开，长静音自动折叠"
                onClick={() => setScaleMode('elastic')}
              >
                自适应宽度
              </button>
              <button
                type="button"
                className={`compact ${scaleMode === 'linear' ? 'active' : ''}`}
                title="按真实物理时长比例排列，与语谱图垂直对齐"
                onClick={() => setScaleMode('linear')}
              >
                线性对齐
              </button>
            </div>
          </div>

          <div className="sb-setting-block">
            <span className="sb-field-lbl">刻度精度</span>
            <div className="segmented sb-seg-full" role="group">
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
                  className={`compact ${tickPrecision === val ? 'active' : ''}`}
                  onClick={() => setTickPrecision(val)}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <label className={`export-check ${tickFixedDisabled ? 'is-disabled' : ''}`}>
            <input
              type="checkbox"
              disabled={tickFixedDisabled}
              checked={tickFixedDecimals}
              onChange={(e) => setTickFixedDecimals(e.target.checked)}
            />
            <span>固定小数位补零（如 10.30）</span>
          </label>

          <div className="sb-hint">
            仅简化画面刻度显示并自动展开相邻冲突小数位；悬停、编辑、复制与导出均保留完整精度。
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        id="set-audio"
        title="录音与声学图谱"
        badge={audioName ? '已载入' : '未载入'}
        defaultOpen={true}
      >
        <div className="sb-stack">
          <div className="sb-audio-card">
            <div className="sb-audio-info">
              <span className="sb-audio-name" title={audioName || '未载入录音'}>
                {audioName || '未载入录音'}
              </span>
              <span className="sb-audio-sub">
                {audioName
                  ? `${audioDuration.toFixed(3)} s · ${(audioSampleRate / 1000).toFixed(1)} kHz`
                  : '支持本地 WAV / MP3 / FLAC 或配套集合文件'}
              </span>
            </div>
            <div className="sb-audio-btns">
              <button type="button" className="compact" onClick={onOpenAudioPicker}>
                <UiIcon name="waveform" size={13} />
                <span>打开录音</span>
              </button>
              {audioName && (
                <button type="button" className="compact danger" onClick={onClearAudio}>
                  <UiIcon name="removeAudio" size={13} />
                  <span>移除</span>
                </button>
              )}
            </div>
          </div>

          {audioName && (
            <>
              <div className="sb-setting-inline">
                <span className="sb-field-lbl">显示语谱图</span>
                <div className="segmented" role="group">
                  <button
                    type="button"
                    className={`compact ${showSpectrogram ? 'active' : ''}`}
                    onClick={() => setShowSpectrogram(true)}
                  >
                    显示
                  </button>
                  <button
                    type="button"
                    className={`compact ${!showSpectrogram ? 'active' : ''}`}
                    onClick={() => setShowSpectrogram(false)}
                  >
                    隐藏
                  </button>
                </div>
              </div>

              {showSpectrogram && (
                <>
                  <div className="sb-setting-block">
                    <span className="sb-field-lbl">频率上限</span>
                    <div className="segmented sb-seg-full" role="group">
                      {(
                        [
                          [5000, '5 kHz', '5 kHz（聚焦元音与共振峰 F1–F3）'],
                          [8000, '8 kHz', '8 kHz（兼顾元音与高频擦音 /s, ʃ/）'],
                          [10000, '10 kHz', '10 kHz（宽频观测高频摩擦与爆破）']
                        ] as const
                      ).map(([hz, label, tip]) => {
                        const nyquist = audioSampleRate > 0 ? audioSampleRate / 2 : Infinity;
                        const exceedsNyquist = audioSampleRate > 0 && hz > nyquist;
                        const disabled = exceedsNyquist && hz > 5000;
                        const title = exceedsNyquist
                          ? `超出当前音频 Nyquist 上限 (${(nyquist / 1000).toFixed(1)} kHz)`
                          : tip;
                        return (
                          <button
                            key={hz}
                            type="button"
                            className={`compact ${maxFreq === hz ? 'active' : ''}`}
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

                  <div className="sb-setting-block">
                    <span className="sb-field-lbl">声学提示层</span>
                    <div className="segmented sb-seg-full" role="group">
                      {(
                        [
                          ['auto', '自动'],
                          ['pitch', '音高'],
                          ['formant', '共振峰'],
                          ['plain', '纯语谱']
                        ] as const
                      ).map(([val, lbl]) => (
                        <button
                          key={val}
                          type="button"
                          className={`compact ${cueMode === val ? 'active' : ''}`}
                          onClick={() => setCueMode(val)}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </div>

                  {(cueMode === 'auto' || cueMode === 'pitch') && (
                    <div className="sb-setting-block">
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 6
                        }}
                      >
                        <span className="sb-field-lbl">音高范围 (F0)</span>
                        <span className="sb-kv-val mono" style={{ fontSize: 11 }}>
                          {Math.round(effF0.floor)}–{Math.round(effF0.ceil)} Hz
                        </span>
                      </div>
                      <div className="segmented sb-seg-full" role="group" aria-label="音高显示范围预设">
                        {(
                          [
                            ['auto', '自动', '按当前录音 P2–P98 自适应确定音高上下限'],
                            ['male', '男声', '男声常用基频范围 75–300 Hz'],
                            ['female', '女声', '女声常用基频范围 100–500 Hz'],
                            ['custom', '自定义', '手动指定画布与导出的基频显示上下限']
                          ] as Array<[F0RangeMode, string, string]>
                        ).map(([val, lbl, tip]) => (
                          <button
                            key={val}
                            type="button"
                            className={`compact ${f0RangeMode === val ? 'active' : ''}`}
                            title={tip}
                            onClick={() => setF0RangeMode(val)}
                          >
                            {lbl}
                          </button>
                        ))}
                      </div>
                      {f0RangeMode === 'custom' && (
                        <div className="sb-field-grid-2" style={{ marginTop: 4 }}>
                          <label className="sb-field">
                            <span className="sb-field-lbl">下限 (Hz)</span>
                            <input
                              type="number"
                              min={40}
                              max={975}
                              step={5}
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
                          </label>
                          <label className="sb-field">
                            <span className="sb-field-lbl">上限 (Hz)</span>
                            <input
                              type="number"
                              min={65}
                              max={1000}
                              step={5}
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
                          </label>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="sb-setting-block">
                    <span className="sb-field-lbl">层级排列顺序</span>
                    <div className="segmented sb-seg-full" role="group">
                      <button
                        type="button"
                        className={`compact ${tierOrder === 'raw' ? 'active' : ''}`}
                        title="按文件原有的层级顺序显示"
                        onClick={() => setTierOrder('raw')}
                      >
                        原始顺序
                      </button>
                      <button
                        type="button"
                        className={`compact ${tierOrder === 'spec' ? 'active' : ''}`}
                        title="将细颗粒标注层紧贴语谱图下方显示"
                        onClick={() => setTierOrder('spec')}
                      >
                        声学优先
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        id="set-ipa"
        title="音标与编码工具"
        badge={IPA_MODE_LABELS[ipaMode]}
        defaultOpen={false}
      >
        <div className="sb-stack">
          <div className="sb-setting-block">
            <span className="sb-field-lbl">音标输入方案</span>
            <div className="segmented sb-seg-full" role="group">
              {(
                [
                  ['off', '关闭'],
                  ['yunlong', '云龙音标'],
                  ['praat', 'Praat 编码']
                ] as Array<[IpaInputMode, string]>
              ).map(([val, lbl]) => (
                <button
                  key={val}
                  type="button"
                  className={`compact ${ipaMode === val ? 'active' : ''}`}
                  onClick={() => setIpaMode(val)}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            className={`compact sb-full-btn ${ipaDockOpen ? 'active' : ''}`}
            onClick={() => setIpaDockOpen(!ipaDockOpen)}
          >
            <UiIcon name="keyboard" size={13} />
            <span>{ipaDockOpen ? '隐藏虚拟音标键盘' : '显示虚拟音标键盘'}</span>
          </button>

          <div className="sb-setting-block">
            <span className="sb-field-lbl">整份文档批量转换</span>
            <div className="sb-stack-tight">
              <button
                type="button"
                className="compact sb-full-btn"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => onBatchConvertIpa('toUnicode')}
              >
                <UiIcon name="convertUnicode" size={13} />
                <span>全部转为 Unicode 音标</span>
              </button>
              <button
                type="button"
                className="compact sb-full-btn"
                disabled={isReadOnly}
                title={isReadOnly ? '请先切换至编辑模式' : undefined}
                onClick={() => onBatchConvertIpa('toPraat')}
              >
                <UiIcon name="convertPraat" size={13} />
                <span>全部转为 Praat 编码</span>
              </button>
            </div>
          </div>

          <div className="sb-hint">
            仅批量转换当前文档内区间与标点的标注文本，不改动层级名称，操作支持撤销。
          </div>
        </div>
      </CollapsibleSection>

      <div className="sb-about-footer">
        <button
          type="button"
          className="compact sb-full-btn sb-about-trigger"
          onClick={() => setAboutOpen(true)}
        >
          <InfoIcon size={14} />
          <span>{isDesktop ? '关于 T·Grid 与检查更新' : '关于 T·Grid'}</span>
        </button>
      </div>
    </div>
  );
};
