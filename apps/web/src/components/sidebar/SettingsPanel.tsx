import React from 'react';
import { isTauriRuntime } from '../../bridge/PlatformBridge';
import { useEditorStore, type EditInspectorMode, type IpaInputMode } from '../../store/useEditorStore';
import { UI_SCALE_MAX, UI_SCALE_MIN, stepUiScale } from '../../utils/uiScale';
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
  const uiScale = useEditorStore((s) => s.uiScale);
  const setUiScale = useEditorStore((s) => s.setUiScale);
  const legendOpen = useEditorStore((s) => s.legendOpen);
  const toggleLegend = useEditorStore((s) => s.toggleLegend);

  const wrapMode = useEditorStore((s) => s.wrapMode);
  const setWrapMode = useEditorStore((s) => s.setWrapMode);
  const targetWidth = useEditorStore((s) => s.targetWidth);
  const widthAutoFit = useEditorStore((s) => s.widthAutoFit);
  const setTargetWidth = useEditorStore((s) => s.setTargetWidth);
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
  const showSpectrogram = useEditorStore((s) => s.showSpectrogram);
  const setShowSpectrogram = useEditorStore((s) => s.setShowSpectrogram);
  const maxFreq = useEditorStore((s) => s.maxFreq);
  const setMaxFreq = useEditorStore((s) => s.setMaxFreq);
  const cueMode = useEditorStore((s) => s.cueMode);
  const setCueMode = useEditorStore((s) => s.setCueMode);
  const tierOrder = useEditorStore((s) => s.tierOrder);
  const setTierOrder = useEditorStore((s) => s.setTierOrder);

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

          <div className="sb-setting-inline">
            <span className="sb-field-lbl" title="全局缩放界面与谱面视图（75%–200%，不影响导出图像物理尺寸）">
              界面缩放
            </span>
            <div className="width-stepper ui-scale-stepper">
              <button
                type="button"
                className="icon-btn compact"
                disabled={uiScale <= UI_SCALE_MIN + 0.001}
                title="缩小界面"
                aria-label="缩小界面"
                onClick={() => setUiScale(stepUiScale(uiScale, -1))}
              >
                <TGridIcon name="stepper-minus" size={13} />
              </button>
              <button
                type="button"
                className="compact ui-scale-reset-btn"
                title={uiScale === 1 ? '当前为默认 100% 缩放' : '点击一键复原为 100%'}
                onClick={() => setUiScale(1)}
              >
                {Math.round(uiScale * 100)}%
              </button>
              <button
                type="button"
                className="icon-btn compact"
                disabled={uiScale >= UI_SCALE_MAX - 0.001}
                title="放大界面"
                aria-label="放大界面"
                onClick={() => setUiScale(stepUiScale(uiScale, 1))}
              >
                <TGridIcon name="stepper-plus" size={13} />
              </button>
            </div>
          </div>
          {uiScale !== 1 && (
            <div className="sb-hint">
              界面缩放仅影响当前屏幕显示，离线导出 SVG/PNG 仍保持精确出版尺寸。
            </div>
          )}
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

          <div className="sb-setting-inline">
            <span className="sb-field-lbl">单行基准宽度</span>
            <div className="width-stepper">
              <button
                type="button"
                className="icon-btn compact"
                title="收窄行宽"
                onClick={() => {
                  const baseW =
                    wrapMode === 'auto' && widthAutoFit && layout?.width
                      ? Math.round(layout.width)
                      : targetWidth;
                  setTargetWidth(baseW - 120);
                }}
              >
                <TGridIcon name="stepper-minus" size={13} />
              </button>
              <span
                className="width-readout"
                title={
                  wrapMode === 'auto' && widthAutoFit
                    ? '自动适配窗口宽度（点击 −/+ 可切换固定宽度）'
                    : `固定基准宽度 ${targetWidth} px`
                }
              >
                {wrapMode === 'auto' && widthAutoFit
                  ? layout?.width
                    ? `自动 ${Math.round(layout.width)}px`
                    : '自动'
                  : `${targetWidth} px`}
              </span>
              <button
                type="button"
                className="icon-btn compact"
                title="加宽行宽"
                onClick={() => {
                  const baseW =
                    wrapMode === 'auto' && widthAutoFit && layout?.width
                      ? Math.round(layout.width)
                      : targetWidth;
                  setTargetWidth(baseW + 120);
                }}
              >
                <TGridIcon name="stepper-plus" size={13} />
              </button>
            </div>
          </div>

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
