import React, { useMemo } from 'react';
import type { Tier } from '../../bridge/types';
import type { VadExtractProgress } from '../../audio/vadCache';
import {
  applyVadPreset,
  detectVadPreset,
  type VadEngineMode,
  type VadPostprocessParams,
  type VadSensitivityPreset
} from '../../audio/vadPostprocess';
import type {
  VadLabelConfig,
  VadLabelMode,
  VadOverwriteWarning,
  VadWriteMode,
  VadWriteTarget
} from '../../audio/vadWriter';
import type { VadPreviewSegmentItem } from '../../render/renderVadOverlay';
import { CustomSelect, type CustomSelectOption } from '../CustomSelect';
import { CloseIcon, UiIcon } from '../Icons';
import { ToggleSwitch } from '../ToggleSwitch';
import { CollapsibleSection } from './CollapsibleSection';
import '../../styles/vadPanel.css';

export type VadScopeMode = 'all' | 'range' | 'interval';

export interface VadOpenOptions {
  scopeMode?: VadScopeMode;
  writeMode?: VadWriteMode;
  tierIndex?: number;
  itemIndex?: number;
  range?: { start: number; end: number };
  /** If already open and called with no explicit options, toggle closed */
  toggle?: boolean;
}

export interface VadPanelProps {
  /** 是否已载入配套录音 */
  hasAudio: boolean;
  /** 文档全部层级（用于选择目标区间层） */
  tiers: ReadonlyArray<Tier>;
  /** 当前作用范围模式 */
  scopeMode: VadScopeMode;
  onScopeModeChange: (mode: VadScopeMode) => void;
  /** 是否有有效的框选选区（决定「当前选区」按钮是否可用） */
  hasPlayRange: boolean;
  /** 是否有选中的区间（决定「当前区间」与「仅切分所选区间」是否可用） */
  hasSelectedInterval: boolean;
  /** 当前实际作用时间窗（文档时间，秒） */
  scopeSpan: { start: number; end: number };
  /** 当前后处理参数 */
  params: VadPostprocessParams;
  onParamsChange: (next: VadPostprocessParams) => void;
  /** 写入目标配置 */
  writeTarget: VadWriteTarget;
  onWriteTargetChange: (next: VadWriteTarget) => void;
  /** 标签模式配置 */
  labelConfig: VadLabelConfig;
  onLabelConfigChange: (next: VadLabelConfig) => void;
  /** 覆盖非空文本提醒 */
  overwriteWarning: VadOverwriteWarning;
  /** 写入前是否批量执行过零点吸附 */
  snapZeroCrossing: boolean;
  onSnapZeroCrossingChange: (checked: boolean) => void;
  /** 是否在波形区底部叠加 10ms 概率曲线 */
  showProbabilityCurve: boolean;
  onShowProbabilityCurveChange: (checked: boolean) => void;
  /** 当前检出预览段列表（含被剔除状态） */
  segments: ReadonlyArray<VadPreviewSegmentItem>;
  /** 当前选中/试听中的预览段索引 */
  activeSegmentIndex: number | null;
  onAuditionSegment: (index: number) => void;
  onToggleExcludeSegment: (index: number) => void;
  onRestoreAllExcluded: () => void;
  onHoverSegment?: (index: number | null) => void;
  /** 特征提取状态与进度 */
  extracting: boolean;
  extractProgress: VadExtractProgress | null;
  extractError?: string | null;
  onCancelExtract: () => void;
  /** 底部操作与无录音引导 */
  onOpenAudioPicker: () => void;
  onReset: () => void;
  onApply: () => void;
  applying?: boolean;
  isReadOnly?: boolean;
}

function formatSecShort(sec: number): string {
  if (!Number.isFinite(sec)) return '0.00';
  return sec.toFixed(2);
}

function formatDurCompact(sec: number): string {
  const safe = Math.max(0, Number.isFinite(sec) ? sec : 0);
  if (safe < 1) return `${Math.round(safe * 1000)}ms`;
  return `${safe.toFixed(2)}s`;
}

export const VadPanel: React.FC<VadPanelProps> = ({
  hasAudio,
  tiers,
  scopeMode,
  onScopeModeChange,
  hasPlayRange,
  hasSelectedInterval,
  scopeSpan,
  params,
  onParamsChange,
  writeTarget,
  onWriteTargetChange,
  labelConfig,
  onLabelConfigChange,
  overwriteWarning,
  snapZeroCrossing,
  onSnapZeroCrossingChange,
  showProbabilityCurve,
  onShowProbabilityCurveChange,
  segments,
  activeSegmentIndex,
  onAuditionSegment,
  onToggleExcludeSegment,
  onRestoreAllExcluded,
  onHoverSegment,
  extracting,
  extractProgress,
  extractError,
  onCancelExtract,
  onOpenAudioPicker,
  onReset,
  onApply,
  applying = false,
  isReadOnly = false
}) => {
  const activePreset: VadSensitivityPreset = useMemo(() => detectVadPreset(params), [params]);

  const intervalTierOptions = useMemo<CustomSelectOption<string>[]>(() => {
    const opts: CustomSelectOption<string>[] = [];
    tiers.forEach((tier, idx) => {
      if (tier.kind !== 'intervalTier') return;
      opts.push({
        value: String(idx),
        label: tier.name.trim() || `层 ${idx + 1}`,
        meta: `#${idx + 1}`
      });
    });
    return opts;
  }, [tiers]);

  const hasIntervalTier = intervalTierOptions.length > 0;

  const writeModeOptions = useMemo<CustomSelectOption<VadWriteMode>[]>(
    () => [
      { value: 'new-tier', label: '新建区间层' },
      {
        value: 'overwrite-tier',
        label: '覆盖指定区间层',
        disabled: !hasIntervalTier
      },
      {
        value: 'split-interval',
        label: '仅切分所选区间',
        disabled: !hasSelectedInterval
      }
    ],
    [hasIntervalTier, hasSelectedInterval]
  );

  const labelModeOptions: ReadonlyArray<CustomSelectOption<VadLabelMode>> = [
    { value: 'blank', label: '保持空白' },
    { value: 'speech-silence', label: '有声 / 静音标记' },
    { value: 'numbered', label: '自动序号 (1, 2, 3...)' }
  ];

  const stats = useMemo(() => {
    let keptCount = 0;
    let excludedCount = 0;
    let speechDur = 0;
    for (const seg of segments) {
      if (seg.excluded) {
        excludedCount++;
      } else {
        keptCount++;
        speechDur += Math.max(0, seg.end - seg.start);
      }
    }
    const spanDur = Math.max(1e-6, scopeSpan.end - scopeSpan.start);
    const ratioPct = Math.min(100, Math.round((speechDur / spanDur) * 100));
    return { keptCount, excludedCount, speechDur, ratioPct };
  }, [segments, scopeSpan.start, scopeSpan.end]);

  const handlePresetClick = (preset: Exclude<VadSensitivityPreset, 'custom'>) => {
    onParamsChange(applyVadPreset(params, preset));
  };

  const handleEngineChange = (mode: VadEngineMode) => {
    if (mode === params.engineMode) return;
    onParamsChange({ ...params, engineMode: mode });
  };

  const updateParam = <K extends keyof VadPostprocessParams>(
    key: K,
    value: VadPostprocessParams[K]
  ) => {
    const next: VadPostprocessParams = { ...params, [key]: value };
    if (key === 'highProbTh' && next.lowProbTh > next.highProbTh) {
      next.lowProbTh = next.highProbTh;
    } else if (key === 'lowProbTh' && next.lowProbTh > next.highProbTh) {
      next.highProbTh = next.lowProbTh;
    }
    onParamsChange(next);
  };

  if (!hasAudio) {
    return (
      <div className="vad-panel">
        <div className="vad-scroll">
          <div className="vad-empty-box">
            <UiIcon name="waveform" size={24} />
            <div className="vad-empty-title">尚未载入配套录音</div>
            <div className="vad-empty-desc">
              请先载入 WAV 或常见音频文件，载入后将自动提取声学特征并实时预览切分边界。
            </div>
            <button
              type="button"
              className="vad-btn vad-btn-primary"
              onClick={onOpenAudioPicker}
            >
              <UiIcon name="folder" size={14} />
              <span>载入配套录音…</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  const progressPct = extractProgress
    ? Math.min(100, Math.max(0, Math.round(extractProgress.ratio * 100)))
    : 0;

  return (
    <div className="vad-panel">
      <div className="vad-scroll">
        {/* Extraction progress banner */}
        {extracting && (
          <div className="vad-progress-banner" role="status" aria-live="polite">
            <div className="vad-progress-top">
              <span className="vad-progress-text">
                {extractProgress && extractProgress.totalChunks > 1
                  ? `正在分析声学特征 (${extractProgress.doneChunks}/${extractProgress.totalChunks} 块 · ${progressPct}%)`
                  : '正在分析声学特征…'}
              </span>
              <button
                type="button"
                className="vad-inline-btn"
                onClick={onCancelExtract}
              >
                取消
              </button>
            </div>
            <div className="vad-progress-track">
              <div className="vad-progress-fill" style={{ width: `${Math.max(8, progressPct)}%` }} />
            </div>
          </div>
        )}

        {extractError && (
          <div className="vad-error-box" role="alert">
            <UiIcon name="warning" size={14} className="vad-warn-icon" />
            <span>{extractError}</span>
          </div>
        )}

        {/* Scope selector */}
        <section className="vad-card">
          <div className="vad-card-head">
            <span className="vad-card-title">作用范围</span>
            <span className="vad-badge">
              {formatDurCompact(Math.max(0, scopeSpan.end - scopeSpan.start))}
            </span>
          </div>
          <div className="vad-seg-group" role="group" aria-label="语音切分作用范围">
            <button
              type="button"
              className={`vad-seg-btn${scopeMode === 'all' ? ' is-active' : ''}`}
              aria-pressed={scopeMode === 'all'}
              onClick={() => onScopeModeChange('all')}
            >
              全录音
            </button>
            <button
              type="button"
              className={`vad-seg-btn${scopeMode === 'range' ? ' is-active' : ''}`}
              aria-pressed={scopeMode === 'range'}
              disabled={!hasPlayRange}
              title={hasPlayRange ? '仅在当前语谱图框选范围内切分' : '请先在语谱图或波形区拖拽框选时间范围'}
              onClick={() => onScopeModeChange('range')}
            >
              当前选区
            </button>
            <button
              type="button"
              className={`vad-seg-btn${scopeMode === 'interval' ? ' is-active' : ''}`}
              aria-pressed={scopeMode === 'interval'}
              disabled={!hasSelectedInterval}
              title={hasSelectedInterval ? '仅在当前选中区间内部切分' : '请先在谱面选中一个区间'}
              onClick={() => onScopeModeChange('interval')}
            >
              当前区间
            </button>
          </div>
          <div className="vad-scope-meta">
            <span>
              {formatSecShort(scopeSpan.start)} – {formatSecShort(scopeSpan.end)} s
            </span>
            <span>{params.engineMode === 'neural' ? 'AcouSeg 1.0' : '传统规则'}</span>
          </div>
        </section>

        {/* Sensitivity presets & 3 core sliders */}
        <section className="vad-card">
          <div className="vad-card-head">
            <span className="vad-card-title">灵敏度与切分参数</span>
            {activePreset === 'custom' && <span className="vad-badge is-teal">自定义</span>}
          </div>

          <div className="vad-seg-group" role="group" aria-label="灵敏度预设">
            <button
              type="button"
              className={`vad-seg-btn${activePreset === 'tight' ? ' is-active' : ''}`}
              aria-pressed={activePreset === 'tight'}
              title="适合干净词表与逐字精切，抑制呼吸声"
              onClick={() => handlePresetClick('tight')}
            >
              紧凑
            </button>
            <button
              type="button"
              className={`vad-seg-btn${activePreset === 'standard' ? ' is-active' : ''}`}
              aria-pressed={activePreset === 'standard'}
              title="适合常规田野录音、对话与朗读"
              onClick={() => handlePresetClick('standard')}
            >
              标准
            </button>
            <button
              type="button"
              className={`vad-seg-btn${activePreset === 'loose' ? ' is-active' : ''}`}
              aria-pressed={activePreset === 'loose'}
              title="适合轻声、气声或远场录音，减少漏切"
              onClick={() => handlePresetClick('loose')}
            >
              宽松
            </button>
          </div>

          <div className="vad-slider-row">
            <div className="vad-slider-head">
              <span className="vad-slider-label">最短有声</span>
              <span className="vad-slider-val">{Math.round(params.minSpeechMs)} ms</span>
            </div>
            <input
              type="range"
              className="vad-range"
              min={20}
              max={500}
              step={5}
              value={Math.round(params.minSpeechMs)}
              aria-label="最短有声时长"
              onChange={(e) => updateParam('minSpeechMs', Number(e.target.value))}
            />
          </div>

          <div className="vad-slider-row">
            <div className="vad-slider-head">
              <span className="vad-slider-label">最短停顿</span>
              <span className="vad-slider-val">{Math.round(params.mergeGapMs)} ms</span>
            </div>
            <input
              type="range"
              className="vad-range"
              min={20}
              max={1000}
              step={10}
              value={Math.round(params.mergeGapMs)}
              aria-label="最短停顿时长"
              onChange={(e) => updateParam('mergeGapMs', Number(e.target.value))}
            />
          </div>

          <div className="vad-slider-row">
            <div className="vad-slider-head">
              <span className="vad-slider-label">边界留白</span>
              <span className="vad-slider-val">{Math.round(params.padMs)} ms</span>
            </div>
            <input
              type="range"
              className="vad-range"
              min={0}
              max={150}
              step={5}
              value={Math.round(params.padMs)}
              aria-label="边界留白时长"
              onChange={(e) => updateParam('padMs', Number(e.target.value))}
            />
          </div>
        </section>

        {/* Write strategy */}
        <section className="vad-card">
          <div className="vad-card-head">
            <span className="vad-card-title">写入策略</span>
          </div>

          <div className="vad-field-row">
            <span className="vad-field-label">目标</span>
            <CustomSelect<VadWriteMode>
              size="compact"
              ariaLabel="写入目标方式"
              value={writeTarget.mode}
              options={writeModeOptions}
              onChange={(mode) =>
                onWriteTargetChange({
                  ...writeTarget,
                  mode
                })
              }
            />
          </div>

          {writeTarget.mode === 'new-tier' && (
            <div className="vad-field-row">
              <span className="vad-field-label">层名</span>
              <input
                type="text"
                className="vad-text-input"
                value={writeTarget.newTierName}
                placeholder="VAD"
                aria-label="新建区间层名称"
                onChange={(e) =>
                  onWriteTargetChange({
                    ...writeTarget,
                    newTierName: e.target.value
                  })
                }
              />
            </div>
          )}

          {writeTarget.mode === 'overwrite-tier' && hasIntervalTier && (
            <div className="vad-field-row">
              <span className="vad-field-label">目标层</span>
              <CustomSelect<string>
                size="compact"
                ariaLabel="选择待覆盖区间层"
                value={String(writeTarget.targetTierIndex)}
                options={intervalTierOptions}
                onChange={(val) =>
                  onWriteTargetChange({
                    ...writeTarget,
                    targetTierIndex: Number(val)
                  })
                }
              />
            </div>
          )}

          <div className="vad-field-row">
            <span className="vad-field-label">标签</span>
            <CustomSelect<VadLabelMode>
              size="compact"
              ariaLabel="切分标签模式"
              value={labelConfig.mode}
              options={labelModeOptions}
              onChange={(mode) =>
                onLabelConfigChange({
                  ...labelConfig,
                  mode
                })
              }
            />
          </div>

          {labelConfig.mode === 'speech-silence' && (
            <div className="vad-dual-inputs">
              <label className="vad-mini-field">
                <span className="vad-mini-label">有声标记</span>
                <input
                  type="text"
                  className="vad-text-input"
                  value={labelConfig.speechLabel}
                  placeholder="sounding"
                  onChange={(e) =>
                    onLabelConfigChange({ ...labelConfig, speechLabel: e.target.value })
                  }
                />
              </label>
              <label className="vad-mini-field">
                <span className="vad-mini-label">静音标记</span>
                <input
                  type="text"
                  className="vad-text-input"
                  value={labelConfig.silenceLabel}
                  placeholder="留空"
                  onChange={(e) =>
                    onLabelConfigChange({ ...labelConfig, silenceLabel: e.target.value })
                  }
                />
              </label>
            </div>
          )}

          {overwriteWarning.nonEmptyCount > 0 && (
            <div className="vad-warn-box" role="status">
              <UiIcon name="warning" size={14} className="vad-warn-icon" />
              <span>
                将替换该范围内 {overwriteWarning.nonEmptyCount} 个已有文本区间，写入后可 Ctrl+Z 撤销
              </span>
            </div>
          )}
        </section>

        {/* Advanced settings (collapsed by default) */}
        <CollapsibleSection id="vad-advanced" title="高级参数" defaultOpen={false}>
          <div className="vad-field-row">
            <span className="vad-field-label">引擎</span>
            <div className="vad-seg-group" role="group" aria-label="语音检测引擎">
              <button
                type="button"
                className={`vad-seg-btn${params.engineMode === 'neural' ? ' is-active' : ''}`}
                aria-pressed={params.engineMode === 'neural'}
                onClick={() => handleEngineChange('neural')}
              >
                AcouSeg 1.0
              </button>
              <button
                type="button"
                className={`vad-seg-btn${params.engineMode === 'classic' ? ' is-active' : ''}`}
                aria-pressed={params.engineMode === 'classic'}
                onClick={() => handleEngineChange('classic')}
              >
                传统规则
              </button>
            </div>
          </div>

          <div className="vad-slider-row">
            <div className="vad-slider-head">
              <span className="vad-slider-label">触发阈值</span>
              <span className="vad-slider-val">{params.highProbTh.toFixed(2)}</span>
            </div>
            <input
              type="range"
              className="vad-range"
              min={0.1}
              max={0.85}
              step={0.02}
              value={params.highProbTh}
              aria-label="触发阈值"
              onChange={(e) => updateParam('highProbTh', Number(e.target.value))}
            />
          </div>

          <div className="vad-slider-row">
            <div className="vad-slider-head">
              <span className="vad-slider-label">延展阈值</span>
              <span className="vad-slider-val">{params.lowProbTh.toFixed(2)}</span>
            </div>
            <input
              type="range"
              className="vad-range"
              min={0.04}
              max={0.7}
              step={0.02}
              value={params.lowProbTh}
              aria-label="延展阈值"
              onChange={(e) => updateParam('lowProbTh', Number(e.target.value))}
            />
          </div>

          {params.engineMode === 'neural' && (
            <>
              <div className="vad-slider-row">
                <div className="vad-slider-head">
                  <span
                    className="vad-slider-label"
                    title="当清擦音/送气后验达到该阈值时继续向外延展边界，值越低对轻擦音保护越强"
                  >
                    清擦音保护
                  </span>
                  <span className="vad-slider-val">{params.obsProtectTh.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  className="vad-range"
                  min={0.02}
                  max={0.4}
                  step={0.02}
                  value={params.obsProtectTh}
                  aria-label="清擦音保护阈值"
                  onChange={(e) => updateParam('obsProtectTh', Number(e.target.value))}
                />
              </div>

              <div className="vad-slider-row">
                <div className="vad-slider-head">
                  <span className="vad-slider-label">塞音桥接上限</span>
                  <span className="vad-slider-val">{Math.round(params.maxStopGapMs)} ms</span>
                </div>
                <input
                  type="range"
                  className="vad-range"
                  min={0}
                  max={300}
                  step={10}
                  value={Math.round(params.maxStopGapMs)}
                  aria-label="塞音闭塞桥接上限"
                  onChange={(e) => updateParam('maxStopGapMs', Number(e.target.value))}
                />
              </div>
            </>
          )}

          <ToggleSwitch
            compact
            label="写入时过零点吸附"
            title="点击应用写入时，将有声段首尾边界微调至最近波形过零点"
            checked={snapZeroCrossing}
            onChange={onSnapZeroCrossingChange}
          />
          <ToggleSwitch
            compact
            label="波形区显示概率曲线"
            title="在波形底部叠加 10 ms 语音概率包络与动态触发阈值虚线"
            checked={showProbabilityCurve}
            onChange={onShowProbabilityCurveChange}
          />
        </CollapsibleSection>

        {/* Detected segments list */}
        <CollapsibleSection
          id="vad-segments"
          title="检出片段"
          badge={`${stats.keptCount} 段`}
          defaultOpen={true}
        >
          <div className="vad-seg-toolbar">
            <span>
              有声 {stats.speechDur.toFixed(2)}s · 占比 {stats.ratioPct}%
              {stats.excludedCount > 0 ? ` · 已剔除 ${stats.excludedCount}` : ''}
            </span>
            {stats.excludedCount > 0 && (
              <button
                type="button"
                className="vad-inline-btn"
                onClick={onRestoreAllExcluded}
              >
                全部恢复
              </button>
            )}
          </div>

          {!extracting && segments.length === 0 ? (
            <div className="vad-zero-box">
              <div className="vad-zero-title">当前作用范围内未检出有声段</div>
              <div className="vad-zero-actions">
                {activePreset !== 'loose' && (
                  <button
                    type="button"
                    className="vad-inline-btn"
                    onClick={() => handlePresetClick('loose')}
                  >
                    切至宽松预设
                  </button>
                )}
                <button
                  type="button"
                  className="vad-inline-btn"
                  onClick={() =>
                    handleEngineChange(params.engineMode === 'neural' ? 'classic' : 'neural')
                  }
                >
                  {params.engineMode === 'neural' ? '切至传统规则对比' : '切至 AcouSeg 1.0'}
                </button>
              </div>
            </div>
          ) : (
            <div className="vad-seg-list" role="list" aria-label="检出语音段列表">
              {segments.map((seg) => {
                const isActive = activeSegmentIndex === seg.index;
                return (
                  <div
                    key={seg.index}
                    role="listitem"
                    className={`vad-seg-row${isActive ? ' is-active' : ''}${
                      seg.excluded ? ' is-excluded' : ''
                    }`}
                    onMouseEnter={() => onHoverSegment?.(seg.index)}
                    onMouseLeave={() => onHoverSegment?.(null)}
                    onClick={() => onAuditionSegment(seg.index)}
                  >
                    <span className="vad-seg-num">#{seg.index + 1}</span>
                    <span className="vad-seg-span">
                      {formatSecShort(seg.start)}–{formatSecShort(seg.end)}s
                    </span>
                    <span className="vad-seg-dur">
                      {formatDurCompact(seg.end - seg.start)}
                    </span>
                    <button
                      type="button"
                      className="vad-row-icon-btn"
                      title="试听该片段"
                      aria-label={`试听第 ${seg.index + 1} 段`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onAuditionSegment(seg.index);
                      }}
                    >
                      <UiIcon name="play" size={11} />
                    </button>
                    <button
                      type="button"
                      className={`vad-row-icon-btn ${seg.excluded ? 'is-restore' : 'is-danger'}`}
                      title={seg.excluded ? '恢复该片段' : '剔除此误检片段'}
                      aria-label={
                        seg.excluded
                          ? `恢复第 ${seg.index + 1} 段`
                          : `剔除第 ${seg.index + 1} 段`
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleExcludeSegment(seg.index);
                      }}
                    >
                      {seg.excluded ? <UiIcon name="undo" size={11} /> : <CloseIcon size={10} />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </CollapsibleSection>
      </div>

      {/* Pinned footer */}
      <div className="vad-footer">
        <button
          type="button"
          className="vad-btn"
          disabled={extracting || applying}
          title="恢复标准参数并清空已剔除标记"
          onClick={onReset}
        >
          <UiIcon name="reset" size={13} />
          <span>重置</span>
        </button>
        <button
          type="button"
          className="vad-btn vad-btn-primary"
          disabled={extracting || applying || stats.keptCount === 0}
          title={
            isReadOnly
              ? '自动切换至编辑模式并将预览边界写入 TextGrid（单步可 Ctrl+Z 撤销）'
              : '将预览边界写入 TextGrid（单步可 Ctrl+Z 撤销）'
          }
          onClick={onApply}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
            <path d="M2 6.4L4.7 9.1L10 3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>
            {applying
              ? '正在写入…'
              : isReadOnly
                ? `进入编辑并写入 (${stats.keptCount})`
                : `应用写入 (${stats.keptCount})`}
          </span>
        </button>
      </div>
    </div>
  );
};
