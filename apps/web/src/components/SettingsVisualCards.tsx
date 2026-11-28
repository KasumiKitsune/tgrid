import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EditInspectorMode } from '../store/useEditorStore';
import {
  getElementRectScale,
  getLogicalViewportSize,
  UI_SCALE_PRESETS
} from '../utils/uiScale';
import { ToggleSwitch } from './ToggleSwitch';

export const QTip: React.FC<{
  tip: string;
  align?: 'center' | 'left' | 'right';
  down?: boolean;
}> = ({ tip, align = 'center', down = false }) => {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: 0,
    top: 0,
    ready: false
  });

  useLayoutEffect(() => {
    if (!open) return;

    const updatePos = () => {
      const trigger = triggerRef.current;
      const bubble = bubbleRef.current;
      if (!trigger || !bubble) return;

      const scale = getElementRectScale(trigger);
      const rect = trigger.getBoundingClientRect();
      const { width: vw, height: vh } = getLogicalViewportSize();

      const tx = rect.left / scale;
      const ty = rect.top / scale;
      const tw = rect.width / scale;
      const th = rect.height / scale;
      const bw = bubble.offsetWidth || 200;
      const bh = bubble.offsetHeight || 28;
      const pad = 8;
      const gap = 6;

      let left =
        align === 'right' ? tx : align === 'left' ? tx + tw - bw : tx + tw / 2 - bw / 2;
      left = Math.max(pad, Math.min(vw - bw - pad, left));

      let top = down ? ty + th + gap : ty - bh - gap;
      if (!down && top < pad) {
        top = Math.min(vh - bh - pad, ty + th + gap);
      } else if (down && top + bh > vh - pad) {
        top = Math.max(pad, ty - bh - gap);
      }

      setPos({ left: Math.round(left), top: Math.round(top), ready: true });
    };

    updatePos();
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [open, align, down, tip]);

  const handleClose = () => {
    setOpen(false);
    setPos((prev) => (prev.ready ? { ...prev, ready: false } : prev));
  };

  return (
    <span
      ref={triggerRef}
      className={`pref-qtip ${open ? 'is-open' : ''}`}
      tabIndex={0}
      aria-label={tip}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={handleClose}
      onFocus={() => setOpen(true)}
      onBlur={handleClose}
    >
      ?
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={bubbleRef}
            className={`pref-qtip-portal ${pos.ready ? 'is-visible' : ''}`}
            role="tooltip"
            style={{ left: pos.left, top: pos.top }}
          >
            {tip}
          </div>,
          document.body
        )}
    </span>
  );
};

/* ============================================================================
   图卡 1 · 折行方式（自动折行 vs 单行展开）
   ============================================================================ */
export const WrapModeVisualCards: React.FC<{
  value: 'auto' | 'single';
  onChange: (v: 'auto' | 'single') => void;
}> = ({ value, onChange }) => {
  const isAuto = value === 'auto';
  const isSingle = value === 'single';
  const hiStroke = '#1D4ED8';
  const hiFill = '#EEF3FF';
  const loStroke = '#8C887F';
  const loFill = '#F2F0EA';

  return (
    <div className="pvc-grid-2" role="group" aria-label="折行方式">
      <button
        type="button"
        className={`pvc-card ${isAuto ? 'is-active' : ''}`}
        aria-pressed={isAuto}
        title="按窗口或设定宽度自动多行折返排版"
        onClick={() => onChange('auto')}
      >
        <svg className="pvc-svg" viewBox="0 0 116 36" aria-hidden="true">
          {/* Row 1 */}
          <rect x="6" y="4" width="94" height="11" fill="#FFFFFF" stroke={isAuto ? hiStroke : '#D3CFC5'} strokeWidth="1" />
          <rect x="34" y="4" width="32" height="11" fill={isAuto ? hiFill : loFill} stroke={isAuto ? '#93C5FD' : '#D3CFC5'} strokeWidth="0.9" />
          <line x1="34" y1="4" x2="34" y2="15" stroke={isAuto ? hiStroke : loStroke} strokeWidth="0.9" />
          <line x1="66" y1="4" x2="66" y2="15" stroke={isAuto ? hiStroke : loStroke} strokeWidth="0.9" />
          {/* Double-slash wrap break marker // */}
          <path d="M104 4.5 L101.5 14.5 M108 4.5 L105.5 14.5" stroke={isAuto ? hiStroke : loStroke} strokeWidth="1.25" />
          {/* Subtle return guide */}
          <path d="M103 17.5 L10 17.5" stroke={isAuto ? '#93C5FD' : '#D3CFC5'} strokeWidth="0.8" strokeDasharray="2.5 2" />
          {/* Row 2 */}
          <rect x="6" y="21" width="68" height="11" fill="#FFFFFF" stroke={isAuto ? hiStroke : '#D3CFC5'} strokeWidth="1" />
          <line x1="42" y1="21" x2="42" y2="32" stroke={isAuto ? '#93C5FD' : '#D3CFC5'} strokeWidth="0.9" />
          <line x1="80" y1="26.5" x2="86" y2="26.5" stroke={isAuto ? '#93C5FD' : '#D3CFC5'} strokeWidth="1" strokeDasharray="2 2" />
        </svg>
        <div className="pvc-card-hd">
          <span>自动折行</span>
        </div>
      </button>

      <button
        type="button"
        className={`pvc-card ${isSingle ? 'is-active' : ''}`}
        aria-pressed={isSingle}
        title="全部音段在同一条横轴上连续展开，可横向滚动"
        onClick={() => onChange('single')}
      >
        <svg className="pvc-svg" viewBox="0 0 116 36" aria-hidden="true">
          {/* Continuous single-line axis */}
          <rect x="6" y="7" width="104" height="13" fill="#FFFFFF" stroke={isSingle ? hiStroke : '#D3CFC5'} strokeWidth="1" />
          <rect x="28" y="7" width="34" height="13" fill={isSingle ? hiFill : loFill} stroke={isSingle ? '#93C5FD' : '#D3CFC5'} strokeWidth="0.9" />
          <line x1="28" y1="7" x2="28" y2="20" stroke={isSingle ? hiStroke : loStroke} strokeWidth="0.9" />
          <line x1="62" y1="7" x2="62" y2="20" stroke={isSingle ? hiStroke : loStroke} strokeWidth="0.9" />
          <line x1="88" y1="7" x2="88" y2="20" stroke={isSingle ? '#93C5FD' : '#D3CFC5'} strokeWidth="0.9" />
          {/* Horizontal scrollbar schematic */}
          <rect x="6" y="25" width="104" height="5" fill="#F2F0EA" stroke="#D3CFC5" strokeWidth="0.8" />
          <rect x="14" y="26" width="44" height="3" fill={isSingle ? hiStroke : loStroke} />
        </svg>
        <div className="pvc-card-hd">
          <span>单行展开</span>
        </div>
      </button>
    </div>
  );
};

/* ============================================================================
   图卡 2 · 时间比例（自适应宽度 vs 线性对齐）
   ============================================================================ */
export const ScaleModeVisualCards: React.FC<{
  value: 'elastic' | 'linear';
  onChange: (v: 'elastic' | 'linear') => void;
}> = ({ value, onChange }) => {
  const isElastic = value === 'elastic';
  const isLinear = value === 'linear';
  const hiStroke = '#1D4ED8';
  const hiFill = '#EEF3FF';
  const loStroke = '#8C887F';
  const loFill = '#F2F0EA';

  return (
    <div className="pvc-grid-2" role="group" aria-label="时间比例">
      <button
        type="button"
        className={`pvc-card ${isElastic ? 'is-active' : ''}`}
        aria-pressed={isElastic}
        title="短音段按文字宽度适度展开，长静音自动折叠"
        onClick={() => onChange('elastic')}
      >
        <svg className="pvc-svg" viewBox="0 0 116 36" aria-hidden="true">
          {/* Upper narrow physical time scale */}
          <rect x="6" y="4" width="104" height="7" fill="#FFFFFF" stroke="#D3CFC5" strokeWidth="0.9" />
          <rect x="44" y="4" width="14" height="7" fill={isElastic ? hiFill : loFill} stroke={isElastic ? hiStroke : loStroke} strokeWidth="0.9" />
          <line x1="88" y1="4" x2="88" y2="11" stroke="#D3CFC5" strokeWidth="0.9" />
          {/* Slanted dual-scale projection lines */}
          <line x1="44" y1="11" x2="26" y2="22" stroke={isElastic ? hiStroke : loStroke} strokeWidth="1" strokeDasharray="2 1.5" />
          <line x1="58" y1="11" x2="72" y2="22" stroke={isElastic ? hiStroke : loStroke} strokeWidth="1" strokeDasharray="2 1.5" />
          <line x1="88" y1="11" x2="94" y2="22" stroke={isElastic ? '#93C5FD' : '#D3CFC5'} strokeWidth="0.9" strokeDasharray="2 1.5" />
          {/* Lower expanded readable text tier */}
          <rect x="6" y="22" width="104" height="10" fill="#FFFFFF" stroke={isElastic ? hiStroke : '#D3CFC5'} strokeWidth="1" />
          <rect x="26" y="22" width="46" height="10" fill={isElastic ? hiFill : loFill} stroke={isElastic ? hiStroke : loStroke} strokeWidth="0.9" />
          <line x1="94" y1="22" x2="94" y2="32" stroke="#D3CFC5" strokeWidth="0.9" />
        </svg>
        <div className="pvc-card-hd">
          <span>自适应宽度</span>
        </div>
      </button>

      <button
        type="button"
        className={`pvc-card ${isLinear ? 'is-active' : ''}`}
        aria-pressed={isLinear}
        title="按真实物理时长 1:1 排列，与语谱图严格垂直对齐"
        onClick={() => onChange('linear')}
      >
        <svg className="pvc-svg" viewBox="0 0 116 36" aria-hidden="true">
          {/* Upper physical time scale */}
          <rect x="6" y="4" width="104" height="7" fill="#FFFFFF" stroke="#D3CFC5" strokeWidth="0.9" />
          <rect x="30" y="4" width="38" height="7" fill={isLinear ? hiFill : loFill} stroke={isLinear ? hiStroke : loStroke} strokeWidth="0.9" />
          <line x1="88" y1="4" x2="88" y2="11" stroke="#D3CFC5" strokeWidth="0.9" />
          {/* Straight vertical 1:1 alignment gridlines */}
          <line x1="30" y1="11" x2="30" y2="22" stroke={isLinear ? hiStroke : loStroke} strokeWidth="1" strokeDasharray="2 1.5" />
          <line x1="68" y1="11" x2="68" y2="22" stroke={isLinear ? hiStroke : loStroke} strokeWidth="1" strokeDasharray="2 1.5" />
          <line x1="88" y1="11" x2="88" y2="22" stroke={isLinear ? '#93C5FD' : '#D3CFC5'} strokeWidth="0.9" strokeDasharray="2 1.5" />
          {/* Lower strictly aligned tier */}
          <rect x="6" y="22" width="104" height="10" fill="#FFFFFF" stroke={isLinear ? hiStroke : '#D3CFC5'} strokeWidth="1" />
          <rect x="30" y="22" width="38" height="10" fill={isLinear ? hiFill : loFill} stroke={isLinear ? hiStroke : loStroke} strokeWidth="0.9" />
          <line x1="88" y1="22" x2="88" y2="32" stroke="#D3CFC5" strokeWidth="0.9" />
        </svg>
        <div className="pvc-card-hd">
          <span>线性对齐</span>
        </div>
      </button>
    </div>
  );
};

/* ============================================================================
   图卡 3 · 声学曲线（4 张紧凑微型图卡：无 / 基频 F0 / 共振峰 / 全部）
   ============================================================================ */
type CueMode = 'auto' | 'pitch' | 'formant' | 'plain';

const CUE_CARDS: Array<{ id: CueMode; label: string; title: string }> = [
  { id: 'plain', label: '无', title: '仅显示宽带语谱图，不叠加声学曲线' },
  { id: 'pitch', label: '基频 F0', title: '叠加平滑基频音高曲线 (F0)' },
  { id: 'formant', label: '共振峰', title: '叠加共振峰点状轨迹 (F1–F3)' },
  { id: 'auto', label: '全部', title: '同时叠加基频曲线与共振峰轨迹（自动模式）' }
];

export const AcousticCueVisualCards: React.FC<{
  value: CueMode;
  disabled?: boolean;
  onChange: (v: CueMode) => void;
}> = ({ value, disabled = false, onChange }) => (
  <div className="pvc-grid-4" role="group" aria-label="声学曲线">
    {CUE_CARDS.map((item) => {
      const active = value === item.id;
      const showF0 = item.id === 'pitch' || item.id === 'auto';
      const showFormant = item.id === 'formant' || item.id === 'auto';
      return (
        <button
          key={item.id}
          type="button"
          className={`pvc-card is-micro ${active ? 'is-active' : ''}`}
          disabled={disabled}
          aria-pressed={active}
          title={disabled ? '载入录音并开启语谱图后可切换' : item.title}
          onClick={() => onChange(item.id)}
        >
          <svg className="pvc-svg" viewBox="0 0 54 28" aria-hidden="true">
            {/* Soft grayscale spectrogram substrate */}
            <rect x="0" y="0" width="54" height="28" fill="#F6F5F1" />
            <rect x="0" y="14" width="54" height="6" fill="#E6E3DA" />
            <rect x="0" y="20" width="54" height="8" fill="#DBD7CC" />
            <rect x="10" y="10" width="14" height="14" fill="#D2CEC2" opacity="0.7" />
            <rect x="30" y="8" width="15" height="16" fill="#D2CEC2" opacity="0.65" />
            {/* Smooth cobalt F0 contour */}
            {showF0 && (
              <path
                d="M5 19 C13 13, 19 8, 27 14 C35 20, 41 10, 49 13"
                fill="none"
                stroke="#1D4ED8"
                strokeWidth="1.65"
                strokeLinecap="square"
              />
            )}
            {/* Refined crimson formant dot tracks */}
            {showFormant && (
              <g fill="#B91C1C">
                <circle cx="9" cy="18" r="1.35" />
                <circle cx="16" cy="15" r="1.35" />
                <circle cx="24" cy="16" r="1.35" />
                <circle cx="33" cy="13" r="1.35" />
                <circle cx="42" cy="15" r="1.35" />
                <circle cx="13" cy="9" r="1.15" opacity="0.82" />
                <circle cx="22" cy="8" r="1.15" opacity="0.82" />
                <circle cx="36" cy="7" r="1.15" opacity="0.82" />
                <circle cx="45" cy="9" r="1.15" opacity="0.82" />
              </g>
            )}
          </svg>
          <span className="pvc-card-hd">{item.label}</span>
        </button>
      );
    })}
  </div>
);

/* ============================================================================
   图卡 4 · 选中编辑方式（侧边栏编辑 vs 画布浮动条）
   ============================================================================ */
export const EditModeVisualCards: React.FC<{
  value: EditInspectorMode;
  onChange: (v: EditInspectorMode) => void;
}> = ({ value, onChange }) => {
  const isSidebar = value === 'sidebar';
  const isFloating = value === 'floating';
  const hiStroke = '#1D4ED8';
  const hiFill = '#EEF3FF';

  return (
    <div className="pvc-grid-2-lg" role="group" aria-label="选中编辑方式">
      <button
        type="button"
        className={`pvc-card is-lg ${isSidebar ? 'is-active' : ''}`}
        aria-pressed={isSidebar}
        onClick={() => onChange('sidebar')}
      >
        <svg className="pvc-svg" viewBox="0 0 220 54" aria-hidden="true">
          {/* App outer chrome */}
          <rect x="6" y="5" width="208" height="44" fill="#FAF9F6" stroke="#D3CFC5" strokeWidth="1" />
          <line x1="6" y1="13" x2="214" y2="13" stroke="#D3CFC5" strokeWidth="0.9" />
          {/* Score grid on left */}
          <rect x="12" y="19" width="132" height="24" fill="#FFFFFF" stroke="#D3CFC5" strokeWidth="0.9" />
          <line x1="12" y1="31" x2="144" y2="31" stroke="#E0DDD4" strokeWidth="0.9" />
          <rect x="46" y="19" width="44" height="12" fill={isSidebar ? hiFill : '#ECE9E1'} stroke={isSidebar ? hiStroke : '#8C887F'} strokeWidth="1" />
          {/* Right inspector panel highlighted */}
          <rect x="150" y="13" width="64" height="36" fill={isSidebar ? hiFill : '#F2F0EA'} stroke={isSidebar ? hiStroke : '#8C887F'} strokeWidth="1.2" />
          <rect x="156" y="19" width="52" height="12" fill="#FFFFFF" stroke={isSidebar ? '#93C5FD' : '#D3CFC5'} strokeWidth="0.9" />
          <line x1="160" y1="25" x2="188" y2="25" stroke={isSidebar ? hiStroke : '#8C887F'} strokeWidth="1.4" />
          <rect x="156" y="35" width="24" height="8" fill="#FFFFFF" stroke={isSidebar ? '#93C5FD' : '#D3CFC5'} strokeWidth="0.9" />
          <rect x="184" y="35" width="24" height="8" fill="#FFFFFF" stroke={isSidebar ? '#93C5FD' : '#D3CFC5'} strokeWidth="0.9" />
        </svg>
        <div className="pvc-card-hd">
          <span>侧边栏编辑</span>
          <span className="pvc-card-badge">右侧停靠</span>
        </div>
        <div className="pvc-card-sub">固定右侧，适合连续校对多字段</div>
      </button>

      <button
        type="button"
        className={`pvc-card is-lg ${isFloating ? 'is-active' : ''}`}
        aria-pressed={isFloating}
        onClick={() => onChange('floating')}
      >
        <svg className="pvc-svg" viewBox="0 0 220 54" aria-hidden="true">
          {/* App outer chrome - full width canvas */}
          <rect x="6" y="5" width="208" height="44" fill="#FAF9F6" stroke="#D3CFC5" strokeWidth="1" />
          <line x1="6" y1="13" x2="214" y2="13" stroke="#D3CFC5" strokeWidth="0.9" />
          <rect x="12" y="31" width="196" height="14" fill="#FFFFFF" stroke="#D3CFC5" strokeWidth="0.9" />
          {/* Selected interval */}
          <rect x="74" y="32" width="60" height="13" fill={isFloating ? hiFill : '#ECE9E1'} stroke={isFloating ? hiStroke : '#8C887F'} strokeWidth="1.1" />
          {/* Warm Paper Architectural Double-Layer floating bar matching .fb-arch */}
          <rect x="48" y="10" width="112" height="18" fill="#FAF9F6" stroke="#C6C2B8" strokeWidth="1" />
          {/* Left 3px semantic accent bar */}
          <rect x="48" y="10" width="3" height="18" fill={isFloating ? '#2563EB' : '#8C887F'} />
          {/* Row 1: status header + time capsule */}
          <rect x="51" y="10.5" width="108.5" height="6.5" fill="#F3F1EA" />
          <line x1="51" y1="17" x2="159.5" y2="17" stroke="#DFDCD3" strokeWidth="0.7" />
          <rect x="55" y="12.5" width="14" height="2.6" fill={isFloating ? '#2563EB' : '#8C887F'} opacity="0.8" />
          <rect x="73" y="12" width="34" height="3.8" fill="#FFFFFF" stroke="#DFDCD3" strokeWidth="0.6" />
          {/* Row 2: frameless action row with soft-blue primary button */}
          <rect x="55" y="19.5" width="22" height="6" fill={isFloating ? '#EFF6FF' : '#ECE9E1'} stroke={isFloating ? '#BFDBFE' : '#D3CFC5'} strokeWidth="0.7" />
          <line x1="60" y1="22.5" x2="72" y2="22.5" stroke={isFloating ? '#2563EB' : '#767269'} strokeWidth="1.2" />
          <line x1="83" y1="22.5" x2="97" y2="22.5" stroke="#57544D" strokeWidth="1.2" />
          <line x1="104" y1="22.5" x2="122" y2="22.5" stroke="#57544D" strokeWidth="1.2" />
          <line x1="129" y1="22.5" x2="142" y2="22.5" stroke="#8C887F" strokeWidth="1.2" />
          <circle cx="151" cy="22.5" r="0.9" fill="#8C887F" />
          <circle cx="154" cy="22.5" r="0.9" fill="#8C887F" />
          <line x1="104" y1="28" x2="104" y2="32" stroke={isFloating ? hiStroke : '#8C887F'} strokeWidth="1.1" />
        </svg>
        <div className="pvc-card-hd">
          <span>画布浮动条</span>
          <span className="pvc-card-badge">就近操作</span>
        </div>
        <div className="pvc-card-sub">满宽画布，选中后就近弹出工具条</div>
      </button>
    </div>
  );
};

/* ============================================================================
   图卡 5 · 界面大小（3 张比例字号与密度图卡）
   ============================================================================ */
const SCALE_META: Record<string, { aaSize: number; barH: number; sideW: number; sub: string }> = {
  sm: { aaSize: 13, barH: 5, sideW: 20, sub: '高信息密度' },
  md: { aaSize: 16, barH: 7, sideW: 26, sub: '均衡清晰' },
  lg: { aaSize: 19, barH: 9, sideW: 32, sub: '大屏舒展' }
};

export const UiScaleVisualCards: React.FC<{
  value: number;
  onChange: (scale: number) => void;
}> = ({ value, onChange }) => (
  <div className="pvc-grid-3" role="group" aria-label="界面大小">
    {UI_SCALE_PRESETS.map((preset) => {
      const active = Math.abs(value - preset.scale) < 0.01;
      const meta = SCALE_META[preset.key] ?? SCALE_META.sm;
      const hi = active ? '#1D4ED8' : '#8C887F';
      const fill = active ? '#EEF3FF' : '#F2F0EA';
      return (
        <button
          key={preset.key}
          type="button"
          className={`pvc-card is-lg ${active ? 'is-active' : ''}`}
          aria-pressed={active}
          onClick={() => onChange(preset.scale)}
        >
          <div className="pvc-scale-specimen">
            <span className="pvc-scale-aa" style={{ fontSize: meta.aaSize }}>
              Aa
            </span>
            <span className="pvc-scale-pct">
              {preset.label} {preset.pct}
            </span>
          </div>
          <svg className="pvc-svg" style={{ height: 34 }} viewBox="0 0 116 34" aria-hidden="true">
            <rect x="4" y="3" width="108" height="28" fill="#FFFFFF" stroke="#D3CFC5" strokeWidth="0.9" />
            {/* Proportional topbar */}
            <rect x="4" y="3" width="108" height={meta.barH} fill={fill} stroke={hi} strokeWidth="0.9" />
            {/* Proportional right panel */}
            <rect
              x={112 - meta.sideW}
              y={3 + meta.barH}
              width={meta.sideW}
              height={28 - meta.barH}
              fill={fill}
              stroke={active ? '#93C5FD' : '#D3CFC5'}
              strokeWidth="0.9"
            />
            {/* Canvas lines */}
            <line
              x1="9"
              y1={9 + meta.barH}
              x2={106 - meta.sideW}
              y2={9 + meta.barH}
              stroke="#D3CFC5"
              strokeWidth="1"
            />
            <line
              x1="9"
              y1={16 + meta.barH}
              x2={96 - meta.sideW}
              y2={16 + meta.barH}
              stroke="#E0DDD4"
              strokeWidth="1"
            />
          </svg>
          <div className="pvc-card-sub">{meta.sub}</div>
        </button>
      );
    })}
  </div>
);

/* ============================================================================
   图卡 6 · 编辑交互双图示开关卡（点选自动展开属性栏 + 拖拽显示声学放大镜）
   ============================================================================ */
export const EditingToggleDiagramCards: React.FC<{
  autoOpenInspector: boolean;
  onToggleAutoOpen: (v: boolean) => void;
  showMicroLoupe: boolean;
  onToggleMicroLoupe: (v: boolean) => void;
}> = ({ autoOpenInspector, onToggleAutoOpen, showMicroLoupe, onToggleMicroLoupe }) => {
  const onA = autoOpenInspector;
  const onB = showMicroLoupe;

  return (
    <div className="pvc-toggle-grid">
      <div className={`pvc-toggle-card ${onA ? 'is-on' : ''}`}>
        <div
          className="pvc-toggle-stage"
          role="presentation"
          onClick={() => onToggleAutoOpen(!onA)}
        >
          <svg className="pvc-toggle-svg" viewBox="0 0 216 58" aria-hidden="true">
            {/* Score strip */}
            <rect x="8" y="16" width="106" height="26" fill="#FFFFFF" stroke="#D3CFC5" strokeWidth="1" />
            <line x1="8" y1="29" x2="114" y2="29" stroke="#E0DDD4" strokeWidth="0.9" />
            <rect x="34" y="16" width="44" height="13" fill={onA ? '#EEF3FF' : '#F2F0EA'} stroke={onA ? '#1D4ED8' : '#8C887F'} strokeWidth="1.1" />
            {/* Pointer arrow clicking interval */}
            <path d="M52 24 L52 36 L55.5 33 L58 38 L60 37 L57.5 32 L62 32 Z" fill={onA ? '#1D4ED8' : '#767269'} />
            {/* Summon arrow */}
            <line x1="118" y1="29" x2={onA ? 142 : 184} y2="29" stroke={onA ? '#1D4ED8' : '#B8B3A8'} strokeWidth="1.2" strokeDasharray="3 2" />
            <path
              d={onA ? 'M138 25.5 L143 29 L138 32.5' : 'M180 26 L184 29 L180 32'}
              fill="none"
              stroke={onA ? '#1D4ED8' : '#B8B3A8'}
              strokeWidth="1.2"
            />
            {/* Inspector drawer expanded vs collapsed */}
            {onA ? (
              <g>
                <rect x="148" y="8" width="60" height="42" fill="#EEF3FF" stroke="#1D4ED8" strokeWidth="1.2" />
                <rect x="154" y="14" width="48" height="10" fill="#FFFFFF" stroke="#93C5FD" strokeWidth="0.9" />
                <line x1="158" y1="19" x2="186" y2="19" stroke="#1D4ED8" strokeWidth="1.3" />
                <line x1="154" y1="31" x2="196" y2="31" stroke="#93C5FD" strokeWidth="1.3" />
                <line x1="154" y1="39" x2="188" y2="39" stroke="#93C5FD" strokeWidth="1.3" />
              </g>
            ) : (
              <g>
                <rect x="196" y="8" width="12" height="42" fill="#F2F0EA" stroke="#D3CFC5" strokeWidth="1" />
                <line x1="199" y1="18" x2="205" y2="18" stroke="#A8A49B" strokeWidth="1.1" />
                <line x1="199" y1="24" x2="205" y2="24" stroke="#A8A49B" strokeWidth="1.1" />
                <line x1="199" y1="30" x2="205" y2="30" stroke="#A8A49B" strokeWidth="1.1" />
              </g>
            )}
          </svg>
        </div>
        <div className="pvc-toggle-foot">
          <ToggleSwitch
            label="点选自动展开属性栏"
            checked={onA}
            onChange={onToggleAutoOpen}
          />
          <span className="pvc-toggle-sub">编辑态点击区间自动展开</span>
        </div>
      </div>

      <div className={`pvc-toggle-card ${onB ? 'is-on' : ''}`}>
        <div
          className="pvc-toggle-stage"
          role="presentation"
          onClick={() => onToggleMicroLoupe(!onB)}
        >
          <svg className="pvc-toggle-svg" viewBox="0 0 216 58" aria-hidden="true">
            {/* Base score tier with draggable vertical boundary */}
            <rect x="8" y="20" width="94" height="24" fill="#FFFFFF" stroke="#D3CFC5" strokeWidth="1" />
            <line x1="56" y1="12" x2="56" y2="48" stroke={onB ? '#1D4ED8' : '#767269'} strokeWidth="1.4" />
            {/* Left-right drag arrows */}
            <path d="M46 32 L52 32 M48.5 29.5 L46 32 L48.5 34.5" fill="none" stroke={onB ? '#1D4ED8' : '#8C887F'} strokeWidth="1.1" />
            <path d="M60 32 L66 32 M63.5 29.5 L66 32 L63.5 34.5" fill="none" stroke={onB ? '#1D4ED8' : '#8C887F'} strokeWidth="1.1" />
            {/* Sightlines to optical loupe */}
            <line x1="56" y1="16" x2="116" y2="8" stroke={onB ? '#93C5FD' : '#D3CFC5'} strokeWidth="0.9" strokeDasharray="2.5 2" />
            <line x1="56" y1="44" x2="116" y2="50" stroke={onB ? '#93C5FD' : '#D3CFC5'} strokeWidth="0.9" strokeDasharray="2.5 2" />
            {/* Magnifier square frame */}
            <rect
              x="116"
              y="8"
              width="90"
              height="42"
              fill={onB ? '#FFFFFF' : '#F2F0EA'}
              stroke={onB ? '#1D4ED8' : '#C2BEB4'}
              strokeWidth={onB ? '1.3' : '1'}
              strokeDasharray={onB ? undefined : '3 2'}
            />
            {onB && <rect x="116" y="34" width="90" height="16" fill="#EEF3FF" opacity="0.65" />}
            {/* Magnified waveform */}
            <path
              d="M120 26 L126 24 L131 29 L137 16 L142 34 L148 13 L154 37 L160 19 L166 31 L172 17 L178 33 L184 22 L190 29 L196 24 L202 26"
              fill="none"
              stroke={onB ? '#141413' : '#B8B3A8'}
              strokeWidth="1.15"
            />
            <line x1="160" y1="8" x2="160" y2="50" stroke={onB ? '#1D4ED8' : '#B8B3A8'} strokeWidth="1.2" />
            {onB && <rect x="158" y="24" width="4" height="4" fill="#1D4ED8" />}
          </svg>
        </div>
        <div className="pvc-toggle-foot">
          <ToggleSwitch
            label="拖拽显示声学放大镜"
            checked={onB}
            onChange={onToggleMicroLoupe}
          />
          <span className="pvc-toggle-sub">拖拽边界时放大局部波形</span>
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
   图卡 7 · 词条与启动双图示开关卡（词条状态标记 + 启动恢复工作）
   ============================================================================ */
export const GeneralToggleDiagramCards: React.FC<{
  showCorpusStatusMarks: boolean;
  onToggleStatusMarks: (v: boolean) => void;
  isDesktop: boolean;
  restoreSessionOnStartup: boolean;
  onToggleRestoreSession: (v: boolean) => void;
}> = ({
  showCorpusStatusMarks,
  onToggleStatusMarks,
  isDesktop,
  restoreSessionOnStartup,
  onToggleRestoreSession
}) => {
  const onMarks = showCorpusStatusMarks;
  const onRestore = restoreSessionOnStartup;

  return (
    <div className={`pvc-toggle-grid ${!isDesktop ? 'is-single' : ''}`}>
      <div className={`pvc-toggle-card ${onMarks ? 'is-on' : ''}`}>
        <div
          className="pvc-toggle-stage"
          role="presentation"
          onClick={() => onToggleStatusMarks(!onMarks)}
        >
          <svg className="pvc-toggle-svg" viewBox="0 0 216 58" aria-hidden="true">
            <rect x="16" y="7" width="184" height="44" fill="#FFFFFF" stroke="#D3CFC5" strokeWidth="1" />
            <line x1="16" y1="22" x2="200" y2="22" stroke="#ECE9E1" strokeWidth="0.9" />
            <rect x="17" y="22" width="182" height="14" fill={onMarks ? '#EEF3FF' : '#FAF9F6'} />
            <line x1="16" y1="36" x2="200" y2="36" stroke="#ECE9E1" strokeWidth="0.9" />
            {onMarks ? (
              <g>
                {/* Row 1: green check */}
                <rect x="24" y="10.5" width="9" height="9" fill="#ECFDF5" stroke="#166534" strokeWidth="0.9" />
                <path d="M26.2 15 L28 16.8 L31 13.2" fill="none" stroke="#166534" strokeWidth="1.2" />
                <line x1="40" y1="15" x2="108" y2="15" stroke="#141413" strokeWidth="1.5" />
                {/* Row 2: amber exclamation */}
                <rect x="24" y="24.5" width="9" height="9" fill="#FEF3C7" stroke="#B45309" strokeWidth="0.9" />
                <line x1="28.5" y1="26.5" x2="28.5" y2="29.8" stroke="#B45309" strokeWidth="1.3" />
                <rect x="27.8" y="31" width="1.4" height="1.4" fill="#B45309" />
                <line x1="40" y1="29" x2="122" y2="29" stroke="#1D4ED8" strokeWidth="1.6" />
                {/* Row 3: crimson cross */}
                <rect x="24" y="39" width="9" height="9" fill="#FEF2F2" stroke="#B91C1C" strokeWidth="0.9" />
                <path d="M26.5 41.5 L30.5 45.5 M30.5 41.5 L26.5 45.5" stroke="#B91C1C" strokeWidth="1.15" />
                <line x1="40" y1="43.5" x2="96" y2="43.5" stroke="#57544D" strokeWidth="1.5" />
                {/* Right progress pill */}
                <rect x="164" y="11" width="28" height="8" fill="#EEF3FF" stroke="#93C5FD" strokeWidth="0.8" />
                <line x1="170" y1="15" x2="186" y2="15" stroke="#1D4ED8" strokeWidth="1.2" />
              </g>
            ) : (
              <g>
                {/* Plain minimal text rows without status badges */}
                <line x1="24" y1="15" x2="98" y2="15" stroke="#57544D" strokeWidth="1.5" />
                <line x1="24" y1="29" x2="114" y2="29" stroke="#141413" strokeWidth="1.5" />
                <line x1="24" y1="43.5" x2="88" y2="43.5" stroke="#767269" strokeWidth="1.5" />
              </g>
            )}
          </svg>
        </div>
        <div className="pvc-toggle-foot">
          <ToggleSwitch
            label={
              <span className="pvc-toggle-label-inner">
                <span>显示词条状态标记</span>
                <QTip tip="关闭后隐藏列表与顶栏中的未标、已完成、存疑、需重录标记。" />
              </span>
            }
            checked={onMarks}
            onChange={onToggleStatusMarks}
          />
          <span className="pvc-toggle-sub">列表与顶栏的校对状态点</span>
        </div>
      </div>

      {isDesktop && (
        <div className={`pvc-toggle-card ${onRestore ? 'is-on' : ''}`}>
          <div
            className="pvc-toggle-stage"
            role="presentation"
            onClick={() => onToggleRestoreSession(!onRestore)}
          >
            <svg className="pvc-toggle-svg" viewBox="0 0 216 58" aria-hidden="true">
              <rect x="16" y="7" width="184" height="44" fill="#FFFFFF" stroke="#D3CFC5" strokeWidth="1" />
              {/* Top tab bar */}
              <rect x="16" y="7" width="184" height="12" fill="#F2F0EA" stroke="#D3CFC5" strokeWidth="0.9" />
              {onRestore ? (
                <g>
                  <rect x="20" y="9" width="42" height="10" fill="#FFFFFF" stroke="#1D4ED8" strokeWidth="1" />
                  <rect x="64" y="10" width="40" height="9" fill="#EEF3FF" stroke="#93C5FD" strokeWidth="0.9" />
                  <rect x="106" y="10" width="40" height="9" fill="#EEF3FF" stroke="#93C5FD" strokeWidth="0.9" />
                  {/* Geometric restore loop arrow */}
                  <path
                    d="M98 35 A10 10 0 1 1 108 45 L102 45"
                    fill="none"
                    stroke="#1D4ED8"
                    strokeWidth="1.5"
                  />
                  <path d="M94.5 32.5 L98 36 L101.5 32.5" fill="none" stroke="#1D4ED8" strokeWidth="1.4" />
                  <line x1="126" y1="30" x2="182" y2="30" stroke="#93C5FD" strokeWidth="1.2" />
                  <line x1="126" y1="38" x2="170" y2="38" stroke="#D3CFC5" strokeWidth="1.2" />
                </g>
              ) : (
                <g>
                  <rect x="20" y="9" width="46" height="10" fill="#FFFFFF" stroke="#8C887F" strokeWidth="0.9" />
                  <line x1="28" y1="14" x2="56" y2="14" stroke="#8C887F" strokeWidth="1.1" />
                  <rect x="78" y="29" width="60" height="10" fill="#FAF9F6" stroke="#D3CFC5" strokeWidth="0.9" strokeDasharray="2.5 2" />
                </g>
              )}
            </svg>
          </div>
          <div className="pvc-toggle-foot">
            <ToggleSwitch
              label={
                <span className="pvc-toggle-label-inner">
                  <span>启动时恢复上次未关闭的工作</span>
                  <QTip
                    align="left"
                    tip="重新打开应用时自动恢复上次未关闭的本地文件与文件夹标签页；手动关闭的不会恢复。"
                  />
                </span>
              }
              checked={onRestore}
              onChange={onToggleRestoreSession}
            />
            <span className="pvc-toggle-sub">重开时还原未关闭标签页</span>
          </div>
        </div>
      )}
    </div>
  );
};

/* ============================================================================
   图卡 8 · 操作历史上限时间轴刻度条
   ============================================================================ */
const HISTORY_MILESTONES = [20, 50, 100, 200] as const;

export const HistoryLimitTimelineBar: React.FC<{ value: number }> = ({ value }) => {
  const clamped = Math.max(10, Math.min(200, Math.round(value)));
  const x0 = 10;
  const x1 = 470;
  const span = x1 - x0;
  const toX = (steps: number) => x0 + (steps / 200) * span;
  const activeX = toX(clamped);

  const ticks: number[] = [];
  for (let s = 5; s <= 200; s += 5) {
    ticks.push(s);
  }

  return (
    <div className="pvc-hist-ruler-wrap" aria-hidden="true">
      <svg className="pvc-hist-ruler-svg" viewBox="0 0 480 28">
        {/* Base track */}
        <line x1={x0} y1="13" x2={x1} y2="13" stroke="#D3CFC5" strokeWidth="1.2" />
        {/* Active span */}
        <line x1={x0} y1="13" x2={activeX} y2="13" stroke="#1D4ED8" strokeWidth="1.8" />
        {/* Graduated ticks */}
        {ticks.map((s) => {
          const x = toX(s);
          const isMajor = s === 20 || s === 50 || s === 100 || s === 200;
          const active = s <= clamped;
          const h = isMajor ? 10 : s % 10 === 0 ? 6 : 3.5;
          return (
            <line
              key={s}
              x1={x}
              y1={13 - h / 2}
              x2={x}
              y2={13 + h / 2}
              stroke={active ? (isMajor ? '#1D4ED8' : '#60A5FA') : '#D3CFC5'}
              strokeWidth={isMajor ? 1.35 : 0.9}
            />
          );
        })}
        {/* Active cap marker */}
        <rect x={activeX - 3} y="10" width="6" height="6" fill="#1D4ED8" />
        {/* Milestone labels */}
        {HISTORY_MILESTONES.map((m) => (
          <text
            key={m}
            x={toX(m)}
            y="26"
            textAnchor={m === 200 ? 'end' : 'middle'}
            fontSize="8.5"
            fontFamily="var(--font-mono)"
            fill={clamped === m ? '#1D4ED8' : '#767269'}
            fontWeight={clamped === m ? 700 : 500}
          >
            {m}
          </text>
        ))}
      </svg>
    </div>
  );
};
