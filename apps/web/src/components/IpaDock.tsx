import React, { useEffect, useRef, useState } from 'react';
import { getPlatformBridge, type IpaSymbolInfo } from '../bridge/PlatformBridge';
import { useEditorStore } from '../store/useEditorStore';
import { getLogicalViewportSize, getViewportZoom } from '../utils/uiScale';
import { CloseIcon, UiIcon } from './Icons';

interface KeySpecObj {
  sym: string;
  sub?: string;
  wide?: boolean;
  tiebar?: boolean;
}
type KeySpec = string | KeySpecObj;

interface KeyGroup {
  label: string;
  keys: KeySpec[];
}

const STORAGE_RECENT = 'tg_ipa_recent';
const DEFAULT_RECENT = ['ə', 'ɛ', 'ɔ', 'ɑ', 'ʃ', 'ʂ', 'ɕ', 'ŋ', 'ʰ', 'ː', 'ʔ', 'ɿ', 'ʅ', '˥'];

const TAB_LAYOUTS: Record<string, KeyGroup[]> = {
  consonants: [
    { label: '塞音/鼻音', keys: ['p', 'b', 't', 'd', 'ʈ', 'ɖ', 'c', 'ɟ', 'k', 'ɡ', 'q', 'ɢ', 'ʔ', '|sep|', 'm', 'ɱ', 'n', 'ɳ', 'ɲ', 'ŋ', 'ɴ'] },
    { label: '擦音', keys: ['ɸ', 'β', 'f', 'v', 'θ', 'ð', 's', 'z', 'ʃ', 'ʒ', 'ʂ', 'ʐ', 'ɕ', 'ʑ', 'ç', 'ʝ', 'x', 'ɣ', 'χ', 'ʁ', 'ħ', 'ʕ', 'h', 'ɦ'] },
    { label: '闪颤/边/近', keys: ['ʙ', 'r', 'ʀ', 'ɾ', 'ɽ', 'ⱱ', '|sep|', 'l', 'ɭ', 'ʎ', 'ʟ', 'ɫ', 'ɬ', 'ɮ', '|sep|', 'ʋ', 'ɹ', 'ɻ', 'j', 'ɰ', 'w', 'ʍ', 'ɥ'] },
    {
      label: '塞擦音',
      keys: [
        { sym: 'ts', wide: true }, { sym: 'dz', wide: true }, { sym: 'tʃ', wide: true }, { sym: 'dʒ', wide: true },
        { sym: 'tʂ', wide: true }, { sym: 'dʐ', wide: true }, { sym: 'tɕ', wide: true }, { sym: 'dʑ', wide: true },
        { sym: 'pf', wide: true }, { sym: 'kx', wide: true }, '|sep|',
        { sym: 't\u0361s', wide: true }, { sym: 't\u0361ʃ', wide: true }, { sym: 't\u0361ʂ', wide: true }, { sym: 't\u0361ɕ', wide: true },
        { sym: '\u0361', tiebar: true, wide: true }
      ]
    },
    { label: '内爆/搭嘴', keys: ['ɓ', 'ɗ', 'ʄ', 'ɠ', 'ʛ', '|sep|', 'ʘ', 'ǀ', 'ǃ', 'ǂ', 'ǁ'] }
  ],
  vowels: [
    { label: '闭 / 次闭', keys: ['i', 'y', '|sep|', 'ɨ', 'ʉ', '|sep|', 'ɯ', 'u', '|sep|', 'ɪ', 'ʏ', 'ʊ'] },
    { label: '半闭 / 央', keys: ['e', 'ø', '|sep|', 'ɘ', 'ɵ', '|sep|', 'ɤ', 'o', '|sep|', 'ə', 'ɚ', 'ɝ'] },
    { label: '半开', keys: ['ɛ', 'œ', '|sep|', 'ɜ', 'ɞ', '|sep|', 'ʌ', 'ɔ'] },
    { label: '次开 / 开', keys: ['æ', 'ɐ', '|sep|', 'a', 'ɶ', '|sep|', 'ɑ', 'ɒ'] }
  ],
  sinology: [
    { label: '舌尖元音', keys: ['ɿ', 'ʅ', 'ʮ', 'ʯ', '|sep|', { sym: 'z\u0329', wide: true }, { sym: 'ʐ\u0329', wide: true }] },
    { label: '汉藏特字', keys: ['ȶ', 'ȡ', 'ȵ', 'ȴ', '|sep|', 'ᴀ', 'ᴇ', '∅'] },
    { label: '旧式合体', keys: ['ʦ', 'ʣ', 'ʧ', 'ʤ', 'ʨ', 'ʥ', 'ꭧ', 'ꭦ'] },
    {
      label: '四角调类',
      keys: [
        { sym: '꜀', sub: '阴平', wide: true }, { sym: '꜁', sub: '阳平', wide: true },
        { sym: '꜂', sub: '阴上', wide: true }, { sym: '꜃', sub: '阳上', wide: true },
        { sym: '꜄', sub: '阴去', wide: true }, { sym: '꜅', sub: '阳去', wide: true },
        { sym: '꜆', sub: '阴入', wide: true }, { sym: '꜇', sub: '阳入', wide: true }
      ]
    },
    { label: '高频修饰', keys: ['ʰ', 'ʱ', 'ʷ', 'ʲ', 'ˠ', 'ⁿ', 'ˡ', '\u031A', '\u0303', '\u0329', 'ː', 'ˑ', 'ˈ', 'ˌ'] }
  ],
  tones: [
    {
      label: '五度右竖',
      keys: [
        { sym: '˥', sub: '5' }, { sym: '˦', sub: '4' }, { sym: '˧', sub: '3' }, { sym: '˨', sub: '2' }, { sym: '˩', sub: '1' },
        '|sep|',
        { sym: '꜈', sub: '·5' }, { sym: '꜉', sub: '·4' }, { sym: '꜊', sub: '·3' }, { sym: '꜋', sub: '·2' }, { sym: '꜌', sub: '·1' }
      ]
    },
    {
      label: '常用调值',
      keys: [
        { sym: '˥˥', sub: '55', wide: true }, { sym: '˧˥', sub: '35', wide: true }, { sym: '˨˩˦', sub: '214', wide: true },
        { sym: '˥˩', sub: '51', wide: true }, { sym: '˨˩', sub: '21', wide: true }, { sym: '˧˧', sub: '33', wide: true },
        { sym: '˨˨', sub: '22', wide: true }, { sym: '˩˧', sub: '13', wide: true }, { sym: '˦˨', sub: '42', wide: true },
        { sym: '˧˩', sub: '31', wide: true }, { sym: '˥˧', sub: '53', wide: true }, { sym: '˨˦', sub: '24', wide: true },
        { sym: '˧˩˧', sub: '313', wide: true }
      ]
    },
    {
      label: '左竖变调',
      keys: [
        { sym: '꜒', sub: '5' }, { sym: '꜓', sub: '4' }, { sym: '꜔', sub: '3' }, { sym: '꜕', sub: '2' }, { sym: '꜖', sub: '1' },
        '|sep|', '꜍', '꜎', '꜏', '꜐', '꜑'
      ]
    },
    { label: '声调/韵律', keys: ['\u030B', '\u0301', '\u0304', '\u0300', '\u030F', '\u030C', '\u0302', '|sep|', 'ˈ', 'ˌ', 'ː', 'ˑ', '‿', '|', '‖', '↗', '↘', 'ꜛ', 'ꜜ'] }
  ],
  diacritics: [
    { label: '发声/除阻', keys: ['\u0325', '\u030A', '\u032C', 'ʰ', '\u0324', '\u0330', '\u031A', 'ʼ', 'ⁿ', 'ˡ'] },
    { label: '次要调音', keys: ['\u0303', 'ʷ', 'ʲ', 'ˠ', 'ˤ', '\u0334', '˞'] },
    { label: '舌位/唇形', keys: ['\u031F', '\u0320', '\u0308', '\u033D', '\u031D', '\u031E', '\u0339', '\u031C', '\u0318', '\u0319'] },
    { label: '部位/连字', keys: ['\u032A', '\u033A', '\u033B', '\u033C', '\u0329', '\u030D', '\u032F', '\u0306', '|sep|', { sym: '\u0361', tiebar: true, wide: true }, { sym: '\u035C', tiebar: true, wide: true }] }
  ]
};

const TABS = [
  { id: 'consonants', label: '辅音' },
  { id: 'vowels', label: '元音' },
  { id: 'sinology', label: '汉藏/方言' },
  { id: 'tones', label: '声调' },
  { id: 'diacritics', label: '附加符' }
];

function isCombining(sym: string): boolean {
  if (!sym || sym.length !== 1) return false;
  const cp = sym.codePointAt(0) || 0;
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff)
  );
}

function isMicroGlyph(sym: string): boolean {
  if (!sym || sym.length !== 1) return false;
  const cp = sym.codePointAt(0) || 0;
  return cp >= 0xa700 && cp <= 0xa716;
}

function displayGlyph(sym: string): string {
  if (sym === '\u0361') return '\u25CC\u0361\u25CC';
  if (sym === '\u035C') return '\u25CC\u035C\u25CC';
  if (isCombining(sym)) return '\u25CC' + sym;
  return sym;
}

interface IpaDockProps {
  onInsertSymbol: (sym: string, isTieBar?: boolean) => void;
}

export const IpaDock: React.FC<IpaDockProps> = ({ onInsertSymbol }) => {
  const mode = useEditorStore((s) => s.mode);
  const showToast = useEditorStore((s) => s.showToast);
  const ipaDockOpen = useEditorStore((s) => s.ipaDockOpen);
  const setIpaDockOpen = useEditorStore((s) => s.setIpaDockOpen);
  const ipaFloating = useEditorStore((s) => s.ipaFloating);
  const setIpaFloating = useEditorStore((s) => s.setIpaFloating);
  const sidebarOpen = useEditorStore((s) => s.sidebarOpen);
  const sidebarWidth = useEditorStore((s) => s.sidebarWidth);

  const [activeTab, setActiveTab] = useState('consonants');
  const [recentList, setRecentList] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_RECENT) || 'null');
      if (Array.isArray(saved) && saved.length > 0) {
        return saved.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 14);
      }
    } catch {
      // ignore
    }
    return [...DEFAULT_RECENT];
  });
  const [inspected, setInspected] = useState<IpaSymbolInfo | null>(null);
  const [floatPos, setFloatPos] = useState<{ left: number; top: number }>(() => {
    const { width: vw, height: vh } = getLogicalViewportSize();
    const w = Math.min(840, vw - 64);
    return {
      left: Math.max(12, Math.round(vw - 46 - w - 12)),
      top: Math.max(48, Math.round(vh - 36 - 350))
    };
  });
  const [floatSize, setFloatSize] = useState<{ width: number; height: number } | null>(null);
  const [dockWidth, setDockWidth] = useState(840);
  const userPositionedRef = useRef(false);

  const dockRef = useRef<HTMLElement>(null);

  const inspectSymbol = (sym: string) => {
    void getPlatformBridge()
      .lookupIpaSymbol(sym)
      .then((info) => setInspected(info))
      .catch(() => {});
  };

  useEffect(() => {
    if (ipaDockOpen && !inspected) {
      inspectSymbol('ə');
    }
  }, [ipaDockOpen]);

  // Measure dock width to gracefully wrap inspector bar on narrow widths (docked or resized floating)
  useEffect(() => {
    const el = dockRef.current;
    if (!el || !ipaDockOpen) return;
    const syncWidth = () => {
      if (el.offsetWidth > 0) setDockWidth(el.offsetWidth);
    };
    syncWidth();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncWidth) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [ipaDockOpen, ipaFloating]);

  // Smart default bottom-right positioning avoiding right sidebar & status bar; preserve manual drags
  useEffect(() => {
    if (!ipaDockOpen || !ipaFloating) return;
    const reposition = () => {
      const { width: vw, height: vh } = getLogicalViewportSize();
      const rightReserve = (sidebarOpen ? sidebarWidth + 38 : 38) + 12;
      const bottomReserve = 36;
      const defaultW = Math.min(840, Math.max(360, vw - rightReserve - 16));
      const measuredW = dockRef.current?.offsetWidth || defaultW;
      const measuredH = dockRef.current?.offsetHeight || Math.min(390, vh - 68);
      const targetW = floatSize ? Math.min(floatSize.width, vw - 24) : measuredW;
      const targetH = floatSize ? Math.min(floatSize.height, vh - 68) : measuredH;

      if (!userPositionedRef.current) {
        const smartRight = Math.max(12 + targetW, vw - rightReserve);
        const smartLeft = Math.max(12, Math.min(vw - targetW - 12, smartRight - targetW));
        const smartTop = Math.max(48, Math.min(vh - targetH - bottomReserve, vh - targetH - bottomReserve));
        setFloatPos({ left: Math.round(smartLeft), top: Math.round(smartTop) });
      } else {
        setFloatPos((prev) => ({
          left: Math.round(Math.max(8, Math.min(Math.max(8, vw - targetW - 8), prev.left))),
          top: Math.round(Math.max(48, Math.min(Math.max(48, vh - targetH - bottomReserve), prev.top)))
        }));
      }
      if (floatSize) {
        setFloatSize((prev) =>
          prev
            ? {
                width: Math.max(420, Math.min(vw - 24, prev.width)),
                height: Math.max(220, Math.min(vh - 68, prev.height))
              }
            : null
        );
      }
    };
    const raf = requestAnimationFrame(reposition);
    window.addEventListener('resize', reposition);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', reposition);
    };
  }, [ipaDockOpen, ipaFloating, sidebarOpen, sidebarWidth, floatSize?.width, floatSize?.height]);

  const recordRecent = (sym: string) => {
    if (!sym || sym.length > 4 || /^[\x00-\x7F]+$/.test(sym)) return;
    setRecentList((prev) => {
      if (prev[0] === sym) return prev;
      const next = [sym, ...prev.filter((x) => x !== sym)].slice(0, 14);
      try {
        localStorage.setItem(STORAGE_RECENT, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const handleKeyPress = (e: React.MouseEvent, sym: string, tiebar?: boolean) => {
    e.preventDefault();
    inspectSymbol(sym);
    if (mode === 'read') {
      showToast('请先切换至编辑模式');
      return;
    }
    const isTieBar = Boolean(tiebar || sym === '\u0361' || sym === '\u035C');
    recordRecent(sym);
    onInsertSymbol(sym, isTieBar);
  };

  const handleHeadDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ipaFloating || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    userPositionedRef.current = true;
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = floatPos.left;
    const origTop = floatPos.top;
    const onMove = (ev: PointerEvent) => {
      const z = getViewportZoom();
      const { width: vw, height: vh } = getLogicalViewportSize();
      const w = dockRef.current?.offsetWidth || 840;
      const h = dockRef.current?.offsetHeight || 350;
      setFloatPos({
        left: Math.round(Math.max(8, Math.min(Math.max(8, vw - w - 8), origLeft + (ev.clientX - startX) / z))),
        top: Math.round(Math.max(48, Math.min(Math.max(48, vh - h - 28), origTop + (ev.clientY - startY) / z)))
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleResizeCorner = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ipaFloating) return;
    e.preventDefault();
    e.stopPropagation();
    userPositionedRef.current = true;
    const startX = e.clientX;
    const startY = e.clientY;
    const origW = dockRef.current?.offsetWidth || floatSize?.width || 840;
    const origH = dockRef.current?.offsetHeight || floatSize?.height || 360;
    const onMove = (ev: PointerEvent) => {
      const z = getViewportZoom();
      const { width: vw, height: vh } = getLogicalViewportSize();
      const maxW = Math.max(420, vw - floatPos.left - 8);
      const maxH = Math.max(220, vh - floatPos.top - 28);
      setFloatSize({
        width: Math.round(Math.max(420, Math.min(maxW, origW + (ev.clientX - startX) / z))),
        height: Math.round(Math.max(220, Math.min(maxH, origH + (ev.clientY - startY) / z)))
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const groups = TAB_LAYOUTS[activeTab] || TAB_LAYOUTS.consonants;
  const isNarrowHead = dockWidth < 780;

  return (
    <section
      ref={dockRef}
      id="ipa-dock"
      className={`ipa-dock ${ipaDockOpen ? 'open' : ''} ${ipaFloating ? 'floating' : ''} ${
        isNarrowHead ? 'is-narrow' : ''
      }`}
      style={
        ipaFloating
          ? {
              left: floatPos.left,
              top: floatPos.top,
              ...(floatSize
                ? {
                    width: floatSize.width,
                    height: floatSize.height,
                    maxHeight: floatSize.height
                  }
                : {})
            }
          : undefined
      }
      aria-label="国际音标虚拟键盘"
      onMouseDown={(e) => {
        // Keep focus inside active inline / inspector editor when interacting with any part of IPA dock
        e.preventDefault();
      }}
    >
      <div className="ipa-dock-head" onPointerDown={handleHeadDrag}>
        <div className="ipa-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              tabIndex={-1}
              className={`compact ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="ipa-inspector" aria-live="polite">
          <span className="ipa-insp-glyph">{inspected ? inspected.display : 'ə'}</span>
          <span className="ipa-insp-name" title={inspected?.name || undefined}>
            {inspected ? inspected.name || '国际音标符号' : '悬停或点击音标查看云龙编码与 Praat 写法'}
          </span>
          <span className="ipa-insp-badges">
            {inspected && inspected.yunlong.length > 0 && (
              <span className="ipa-insp-badge yl">云龙 {inspected.yunlong.join(' / ')}</span>
            )}
            {inspected && inspected.praat && (
              <span className="ipa-insp-badge pr">Praat {inspected.praat}</span>
            )}
            {inspected && <span className="ipa-insp-badge uc">{inspected.unicode}</span>}
          </span>
        </div>

        <div className="ipa-dock-actions">
          <button
            type="button"
            tabIndex={-1}
            className="compact"
            title="切换底部停靠 / 悬浮小窗"
            onClick={() => setIpaFloating(!ipaFloating)}
          >
            <UiIcon name={ipaFloating ? 'dockBottom' : 'floatWin'} size={13} />
            <span>{ipaFloating ? '底部停靠' : '悬浮小窗'}</span>
          </button>
          <button
            type="button"
            tabIndex={-1}
            className="icon-btn compact"
            title="关闭音标盘"
            onClick={() => setIpaDockOpen(false)}
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className="ipa-recent-bar">
        <span className="ipa-recent-label">常用/最近</span>
        <div className="ipa-recent-keys">
          {recentList.map((sym) => (
            <button
              key={sym}
              type="button"
              tabIndex={-1}
              className={`ipa-key recent-key ${isCombining(sym) ? 'diacritic' : ''} ${
                isMicroGlyph(sym) ? 'micro-glyph' : ''
              }`}
              onMouseEnter={() => inspectSymbol(sym)}
              onMouseDown={(e) => handleKeyPress(e, sym)}
            >
              {displayGlyph(sym)}
            </button>
          ))}
        </div>
      </div>

      <div className="ipa-keys-body">
        {groups.map((grp) => (
          <div key={grp.label} className="ipa-group">
            <span className="ipa-group-lbl">{grp.label}</span>
            <div className="ipa-group-grid">
              {grp.keys.map((spec, idx) => {
                if (spec === '|sep|') {
                  return <span key={`sep-${idx}`} className="ipa-key-sep" />;
                }
                const cfg: KeySpecObj = typeof spec === 'string' ? { sym: spec } : spec;
                return (
                  <button
                    key={`${cfg.sym}-${idx}`}
                    type="button"
                    tabIndex={-1}
                    className={`ipa-key ${cfg.wide ? 'wide' : ''} ${isCombining(cfg.sym) ? 'diacritic' : ''} ${
                      isMicroGlyph(cfg.sym) ? 'micro-glyph' : ''
                    } ${cfg.tiebar ? 'tiebar' : ''}`}
                    onMouseEnter={() => inspectSymbol(cfg.sym)}
                    onMouseDown={(e) => handleKeyPress(e, cfg.sym, cfg.tiebar)}
                  >
                    <span>{displayGlyph(cfg.sym)}</span>
                    {cfg.sub && <span className="ipa-key-sub">{cfg.sub}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {ipaFloating && (
        <div
          className="ipa-dock-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整音标盘大小"
          title="拖拽调整音标盘悬浮窗口大小"
          onPointerDown={handleResizeCorner}
        />
      )}
    </section>
  );
};
