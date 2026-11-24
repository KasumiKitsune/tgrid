import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../store/useEditorStore';
import {
  WARM_PALETTE,
  collectActiveLegendItems,
  getStructureLines,
  renderStructureDiagramSVG,
  renderSwatchSVG,
  type LegendCatalogItem
} from '../layout/legendCore';

const MiniStructureSvg: React.FC<{ scaleMode: 'elastic' | 'linear' }> = ({ scaleMode }) => {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    renderStructureDiagramSVG(svg, 0, 0, scaleMode, WARM_PALETTE, 1);
  }, [scaleMode]);

  return (
    <svg
      ref={ref}
      width="56"
      height="46"
      viewBox="0 0 56 46"
      className="legend-dock-diagram"
      aria-hidden="true"
    />
  );
};

const SwatchSvg: React.FC<{ item: LegendCatalogItem }> = ({ item }) => {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    renderSwatchSVG(svg, item, 0, 0, WARM_PALETTE, { sScale: 1, inlinePatterns: true });
  }, [item]);

  return <svg ref={ref} width="22" height="12" viewBox="0 0 22 12" aria-hidden="true" />;
};

function applySvgHighlight(key: string | null) {
  const svgEl = document.getElementById('score-svg');
  if (!svgEl) return;
  svgEl.classList.remove('legend-hl-active');
  svgEl.querySelectorAll('.legend-hl-hit').forEach((n) => n.classList.remove('legend-hl-hit'));
  svgEl
    .querySelectorAll('.legend-hl-ancestor')
    .forEach((n) => n.classList.remove('legend-hl-ancestor'));

  if (!key) return;
  svgEl.classList.add('legend-hl-active');
  const candidates = svgEl.querySelectorAll('[data-legend-keys]');
  const hits: Element[] = [];
  candidates.forEach((node) => {
    const keys = (node.getAttribute('data-legend-keys') || '').split(/\s+/);
    if (keys.includes(key)) {
      node.classList.add('legend-hl-hit');
      hits.push(node);
    }
  });
  for (const hit of hits) {
    let cur = hit.parentNode;
    while (cur && cur !== svgEl) {
      if (cur.nodeType === 1) {
        const el = cur as Element;
        if (
          el.hasAttribute('data-legend-keys') ||
          el.tagName.toLowerCase() === 'text' ||
          el.hasAttribute('data-text-node')
        ) {
          el.classList.add('legend-hl-ancestor');
        }
      }
      cur = cur.parentNode;
    }
  }
}

export const LegendDock: React.FC = () => {
  const legendOpen = useEditorStore((s) => s.legendOpen);
  const tg = useEditorStore((s) => s.tg);
  const layout = useEditorStore((s) => s.layout);
  const scaleMode = useEditorStore((s) => s.scaleMode);
  const audioName = useEditorStore((s) => s.audioName);
  const analysis = useEditorStore((s) => s.analysis);
  const cueMode = useEditorStore((s) => s.cueMode);
  const maxFreq = useEditorStore((s) => s.maxFreq);
  const selection = useEditorStore((s) => s.selection);

  const [hoverKey, setHoverKey] = useState<string | null>(null);

  useEffect(() => {
    applySvgHighlight(legendOpen ? hoverKey : null);
    return () => applySvgHighlight(null);
  }, [legendOpen, hoverKey, layout]);

  const resolvedSelectionKind = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === 'tier') {
      return tg.tiers[selection.tierIndex]?.kind === 'textTier' ? 'point' : 'interval';
    }
    return selection.kind;
  }, [selection, tg.tiers]);

  const lines = useMemo(() => getStructureLines(scaleMode, 'zh'), [scaleMode]);
  const items = useMemo(() => {
    if (!legendOpen || !layout) return [];
    return collectActiveLegendItems(tg, layout, {
      isExport: false,
      lang: 'zh',
      hasAudio: Boolean(audioName),
      analysis,
      cueMode,
      maxFreq,
      selectionKind: resolvedSelectionKind,
      hideMetaSymbols: false,
      hideStretchCues: false,
      trigraphMode: 'dual',
      specStrategy: 'raster'
    });
  }, [legendOpen, layout, tg, audioName, analysis, cueMode, maxFreq, resolvedSelectionKind]);

  return (
    <section
      id="legend-dock"
      className={`legend-dock ${legendOpen ? 'visible' : ''}`}
      aria-label="读图图例"
      aria-hidden={!legendOpen}
    >
      <div className="legend-dock-inner">
        <div className="legend-dock-struct">
          <MiniStructureSvg scaleMode={scaleMode} />
          <div className="legend-dock-guide">
            {lines.map((line, i) => {
              const colonIdx = line.indexOf('：');
              return (
                <div key={i} className="legend-dock-guide-line">
                  {colonIdx !== -1 ? (
                    <>
                      <strong>{line.slice(0, colonIdx + 1)}</strong>
                      <span>{line.slice(colonIdx + 1)}</span>
                    </>
                  ) : (
                    line
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="legend-dock-divider" aria-hidden="true" />

        <div
          className="legend-dock-symbols"
          role="list"
          onMouseLeave={() => setHoverKey(null)}
        >
          {items.map((item) => (
            <div
              key={item.key}
              className={`legend-pill ${hoverKey === item.key ? 'is-hover' : ''}`}
              role="listitem"
              tabIndex={0}
              title={`悬停高亮画布中的「${item.label}」`}
              onMouseEnter={() => setHoverKey(item.key)}
              onFocus={() => setHoverKey(item.key)}
              onBlur={() => setHoverKey(null)}
            >
              <SwatchSvg item={item} />
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
