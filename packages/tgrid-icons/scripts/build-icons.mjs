#!/usr/bin/env node
/**
 * Deterministic compiler for @tgrid/icons.
 * Compiles packages/tgrid-icons/svg/*.svg into:
 *   - packages/tgrid-icons/src/icons.generated.ts
 *   - packages/tgrid-icons/src/icons.generated.css
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '..');
const SVG_DIR = path.join(PKG_ROOT, 'svg');
const SRC_DIR = path.join(PKG_ROOT, 'src');
const OUT_TS = path.join(SRC_DIR, 'icons.generated.ts');
const OUT_CSS = path.join(SRC_DIR, 'icons.generated.css');

const STATIC_BRAND_ICONS = new Set(['brand-logo']);

const TRIGGER =
  ':where(button, a, [role="button"], .tgi-trigger):not(:disabled):not([aria-disabled="true"])';

const DIRECTIONAL_PRESS = {
  up: 'translateY(-0.8px) scale(0.93)',
  down: 'translateY(0.8px) scale(0.93)',
  mergeLeft: 'translateX(-0.8px) scale(0.93)',
  mergeRight: 'translateX(0.8px) scale(0.93)',
  submenuChevron: 'translateX(0.8px) scale(0.93)',
  export: 'translateY(0.7px) scale(0.93)'
};

const ROTATIONAL_PRESS = {
  undo: 'rotate(-12deg) scale(0.91)',
  redo: 'rotate(12deg) scale(0.91)'
};

const FAST_CONTROL_PREFIXES = ['win-', 'transport-'];

function isFastControl(name) {
  return FAST_CONTROL_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Tokenize themeable literal colors to CSS custom properties with exact original defaults.
 * Preserves mask luminance values (#000000 / #ffffff) verbatim.
 */
function tokenizeColors(cssValue) {
  let out = cssValue;

  // rgba(...) patterns first so rgb channels aren't partially touched
  out = out.replace(/rgba\(\s*37\s*,\s*99\s*,\s*235\s*,\s*0(?:\.0+)?\s*\)/gi, (m) => {
    return `var(--tgi-accent-bg-0, ${m})`;
  });
  out = out.replace(/rgba\(\s*37\s*,\s*99\s*,\s*235\s*,\s*(?!0(?:\.0+)?\s*\))([0-9.]+)\s*\)/gi, (m) => {
    return `var(--tgi-accent-bg, ${m})`;
  });
  out = out.replace(/rgba\(\s*55\s*,\s*65\s*,\s*81\s*,\s*[0-9.]+\s*\)/gi, (m) => {
    return `var(--tgi-neutral-bg, ${m})`;
  });
  out = out.replace(/rgba\(\s*245\s*,\s*158\s*,\s*11\s*,\s*0?\.08\s*\)/gi, (m) => {
    return `var(--tgi-warning-bg, ${m})`;
  });
  out = out.replace(/rgba\(\s*245\s*,\s*158\s*,\s*11\s*,\s*0?\.16\s*\)/gi, (m) => {
    return `var(--tgi-warning-bg-hover, ${m})`;
  });
  out = out.replace(/rgba\(\s*22\s*,\s*163\s*,\s*74\s*,\s*0?\.08\s*\)/gi, (m) => {
    return `var(--tgi-success-bg, ${m})`;
  });
  out = out.replace(/rgba\(\s*22\s*,\s*163\s*,\s*74\s*,\s*0?\.16\s*\)/gi, (m) => {
    return `var(--tgi-success-bg-hover, ${m})`;
  });

  // Hex color mapping (case-insensitive, word boundary)
  const hexMap = {
    '#374151': 'var(--tgi-stroke, #374151)',
    '#4b5563': 'var(--tgi-stroke-muted, #4b5563)',
    '#6b7280': 'var(--tgi-stroke-subtle, #6b7280)',
    '#9ca3af': 'var(--tgi-stroke-faint, #9ca3af)',
    '#111827': 'var(--tgi-stroke-hover, #111827)',
    '#1f2937': 'var(--tgi-stroke-hover, #1f2937)',
    '#2563eb': 'var(--tgi-accent, #2563eb)',
    '#1d4ed8': 'var(--tgi-accent-strong, #1d4ed8)',
    '#3b82f6': 'var(--tgi-accent-mid, #3b82f6)',
    '#60a5fa': 'var(--tgi-accent-soft, #60a5fa)',
    '#dc2626': 'var(--tgi-danger, #dc2626)',
    '#ef4444': 'var(--tgi-danger, #ef4444)',
    '#b91c1c': 'var(--tgi-danger-active, var(--tgi-danger, #b91c1c))',
    '#d97706': 'var(--tgi-warning, #d97706)',
    '#f59e0b': 'var(--tgi-warning, #f59e0b)',
    '#b45309': 'var(--tgi-warning-hover, #b45309)',
    '#16a34a': 'var(--tgi-success, #16a34a)',
    '#059669': 'var(--tgi-success, #059669)',
    '#15803d': 'var(--tgi-success-hover, #15803d)'
  };

  out = out.replace(/#[0-9a-fA-F]{6}\b/g, (hex) => {
    const key = hex.toLowerCase();
    return hexMap[key] ?? hex;
  });

  return out;
}

/**
 * Parse top-level CSS blocks (supporting nested @keyframes blocks).
 */
function parseCssBlocks(rawCss) {
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  let i = 0;
  const n = css.length;

  while (i < n) {
    while (i < n && /\s/.test(css[i])) i++;
    if (i >= n) break;

    const headerStart = i;
    while (i < n && css[i] !== '{') i++;
    if (i >= n) break;
    const header = css.slice(headerStart, i).trim();

    // Find matching closing brace
    let depth = 0;
    const bodyStart = i + 1;
    while (i < n) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    const body = css.slice(bodyStart, i).trim();
    i++; // consume closing '}'
    blocks.push({ header, body });
  }
  return blocks;
}

/**
 * Split a CSS declaration block into [{ prop, val }].
 */
function parseDeclarations(declBlock) {
  const decls = [];
  let cur = '';
  let parenDepth = 0;
  for (let i = 0; i < declBlock.length; i++) {
    const ch = declBlock[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')' && parenDepth > 0) parenDepth--;
    if (ch === ';' && parenDepth === 0) {
      if (cur.trim()) decls.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) decls.push(cur.trim());

  const out = [];
  for (const item of decls) {
    const colon = item.indexOf(':');
    if (colon === -1) continue;
    const prop = item.slice(0, colon).trim().toLowerCase();
    const val = item.slice(colon + 1).trim();
    if (prop && val) out.push({ prop, val });
  }
  return out;
}

/**
 * Split selector list by commas outside parentheses/brackets.
 */
function splitSelectors(selectorList) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < selectorList.length; i++) {
    const ch = selectorList[i];
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Rewrite @keyframes references in animation / animation-name declarations.
 */
function rewriteAnimationNames(prop, val, keyframeMap) {
  if (keyframeMap.size === 0) return val;
  if (prop !== 'animation' && prop !== 'animation-name') return val;
  let next = val;
  for (const [orig, scoped] of keyframeMap.entries()) {
    const re = new RegExp(`(?<![a-zA-Z0-9_-])${orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9_-])`, 'g');
    next = next.replace(re, scoped);
  }
  return next;
}

/**
 * Compile one icon's raw <style> text into strictly scoped CSS rules.
 */
function compileIconCss(name, rawStyle) {
  if (!rawStyle.trim()) return '';
  const blocks = parseCssBlocks(rawStyle);
  const keyframeMap = new Map();

  // Pass 1: collect @keyframes names
  for (const b of blocks) {
    const kfMatch = b.header.match(/^@keyframes\s+([a-zA-Z0-9_-]+)$/);
    if (kfMatch) {
      const orig = kfMatch[1];
      keyframeMap.set(orig, `tgi-${name}-${orig}`);
    }
  }

  const outLines = [];

  for (const b of blocks) {
    const kfMatch = b.header.match(/^@keyframes\s+([a-zA-Z0-9_-]+)$/);
    if (kfMatch) {
      const scopedName = keyframeMap.get(kfMatch[1]);
      const tokenizedInner = tokenizeColors(b.body).replace(/\s+/g, ' ').trim();
      outLines.push(`@keyframes ${scopedName} { ${tokenizedInner} }`);
      continue;
    }

    const selectors = splitSelectors(b.header);
    const rawDecls = parseDeclarations(b.body);
    if (selectors.length === 0 || rawDecls.length === 0) continue;

    // Group selectors by kind (base / bare-svg / hover / open / active)
    const normalSels = [];
    const hoverSels = [];
    const openSels = [];
    const activeSels = [];
    const bareSvgSels = [];

    for (const sel of selectors) {
      const cleanSel = sel.replace(/\s+/g, ' ').trim();
      if (cleanSel === 'svg') {
        bareSvgSels.push(cleanSel);
      } else if (/^svg:hover(?=$|[\s.#:>~+[])/.test(cleanSel)) {
        hoverSels.push(cleanSel);
      } else if (/^svg\.is-open(?=$|[\s.#:>~+[])/.test(cleanSel)) {
        openSels.push(cleanSel);
      } else if (/^svg:active(?=$|[\s.#:>~+[])/.test(cleanSel)) {
        activeSels.push(cleanSel);
      } else {
        normalSels.push(cleanSel);
      }
    }

    const formatDecls = (decls) =>
      decls
        .map(({ prop, val }) => {
          const withAnim = rewriteAnimationNames(prop, val, keyframeMap);
          const withColors = tokenizeColors(withAnim);
          return `  ${prop}: ${withColors};`;
        })
        .join('\n');

    // Bare `svg { cursor: pointer; overflow: visible; }` -> strip cursor/overflow; emit nothing if empty
    if (bareSvgSels.length > 0) {
      const kept = rawDecls.filter((d) => d.prop !== 'cursor' && d.prop !== 'overflow');
      if (kept.length > 0) {
        outLines.push(`.tgi.tgi-${name} {\n${formatDecls(kept)}\n}`);
      }
    }

    // Normal descendant selectors
    if (normalSels.length > 0) {
      const scoped = normalSels.map((s) => `.tgi.tgi-${name} ${s}`).join(',\n');
      outLines.push(`${scoped} {\n${formatDecls(rawDecls)}\n}`);
    }

    // Hover & .is-open selectors (self + non-disabled interactive parent)
    if (hoverSels.length > 0 || openSels.length > 0) {
      const scoped = [
        ...hoverSels.flatMap((s) => {
          const rest = s.slice('svg:hover'.length);
          return [
            `.tgi.tgi-${name}:hover${rest}`,
            `${TRIGGER}:hover .tgi.tgi-${name}${rest}`
          ];
        }),
        ...openSels.flatMap((s) => {
          const rest = s.slice('svg.is-open'.length);
          return [
            `.tgi.tgi-${name}.is-open${rest}`,
            `${TRIGGER}.is-open .tgi.tgi-${name}${rest}`
          ];
        })
      ].join(',\n');
      outLines.push(`${scoped} {\n${formatDecls(rawDecls)}\n}`);
    }

    // Active selectors: strip `transform` (handled cleanly by unified `.tgi-press` wrapper),
    // preserve non-transform active styles (e.g. stroke accent on chevrons / win-close).
    if (activeSels.length > 0) {
      const kept = rawDecls.filter((d) => d.prop !== 'transform');
      if (kept.length > 0) {
        const scoped = activeSels
          .flatMap((s) => {
            const rest = s.slice('svg:active'.length);
            return [
              `.tgi.tgi-${name}:active${rest}`,
              `${TRIGGER}:active .tgi.tgi-${name}${rest}`
            ];
          })
          .join(',\n');
        outLines.push(`${scoped} {\n${formatDecls(kept)}\n}`);
      }
    }
  }

  return outLines.join('\n');
}

/**
 * Tokenize all SVG <defs>/element IDs and references (id="", url(#...), href="#...", xlink:href="#...")
 * with {{ID}} so TGridIcon can substitute React useId() uniquely per instance.
 */
function tokenizeSvgIds(markup) {
  let out = markup;
  out = out.replace(/\bid="([^"]+)"/g, 'id="{{ID}}$1"');
  out = out.replace(/url\(#([^)]+)\)/g, 'url(#{{ID}}$1)');
  out = out.replace(/\b((?:xlink:)?href)="#([^"]+)"/g, '$1="#{{ID}}$2"');
  return out;
}

/**
 * Wrap non-<defs> inner geometry in <g class="tgi-press">...</g> so press micro-interactions
 * compose cleanly with every icon's hover transforms without double-scaling or transform clobbering.
 */
function wrapPressGroup(innerMarkup) {
  const defsBlocks = [];
  const rest = innerMarkup
    .replace(/<defs\b[^>]*>[\s\S]*?<\/defs>/gi, (m) => {
      defsBlocks.push(m.trim());
      return '';
    })
    .trim();
  const defsPart = defsBlocks.join('');
  return `${defsPart}<g class="tgi-press">${rest}</g>`;
}

/**
 * Compact SVG inner markup cleanly (strip XML comments and inter-tag whitespace).
 */
function compactSvgMarkup(markup) {
  return markup
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function main() {
  if (!fs.existsSync(SVG_DIR)) {
    throw new Error(`SVG source directory not found: ${SVG_DIR}`);
  }
  fs.mkdirSync(SRC_DIR, { recursive: true });

  const svgFiles = fs
    .readdirSync(SVG_DIR)
    .filter((f) => f.endsWith('.svg'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const registry = [];
  const cssSections = [];

  cssSections.push(`/* AUTO-GENERATED by packages/tgrid-icons/scripts/build-icons.mjs — DO NOT EDIT BY HAND */

.tgi {
  display: inline-block;
  flex-shrink: 0;
  vertical-align: middle;
  overflow: visible;
}

:where(button, input, select, textarea, fieldset):disabled .tgi,
[aria-disabled="true"] .tgi {
  pointer-events: none;
}

/* Unified crisp press micro-interaction (100ms, scale 0.91) */
.tgi .tgi-press {
  transform-origin: 8px 8px;
  transition: transform 100ms cubic-bezier(0.22, 1, 0.36, 1);
}

.tgi:active .tgi-press,
${TRIGGER}:active .tgi .tgi-press {
  transform: scale(0.91);
}
`);

  const fastControlNames = [];

  for (const file of svgFiles) {
    const name = path.basename(file, '.svg');
    const raw = fs.readFileSync(path.join(SVG_DIR, file), 'utf8');

    const openMatch = raw.match(/<svg([^>]*)>/i);
    if (!openMatch) {
      throw new Error(`Invalid SVG (missing <svg> tag): ${file}`);
    }
    const openAttrs = openMatch[1];
    const viewBoxMatch = openAttrs.match(/\bviewBox="([^"]+)"/i);
    const fillMatch = openAttrs.match(/\bfill="([^"]+)"/i);
    const viewBox = viewBoxMatch ? viewBoxMatch[1] : '0 0 16 16';
    const fill = fillMatch ? fillMatch[1] : undefined;

    const closeIdx = raw.lastIndexOf('</svg>');
    if (closeIdx === -1) {
      throw new Error(`Invalid SVG (missing </svg> tag): ${file}`);
    }
    const openEndIdx = openMatch.index + openMatch[0].length;
    let inner = raw.slice(openEndIdx, closeIdx);

    // Extract & remove <style> blocks
    const styleChunks = [];
    inner = inner.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_m, cssText) => {
      styleChunks.push(cssText);
      return '';
    });

    const isStaticBrand = STATIC_BRAND_ICONS.has(name);
    let body = compactSvgMarkup(inner);
    body = tokenizeSvgIds(body);
    if (!isStaticBrand) {
      body = wrapPressGroup(body);
    }

    const hasIds = body.includes('{{ID}}');

    registry.push({
      name,
      viewBox,
      fill,
      hasIds,
      body
    });

    if (!isStaticBrand) {
      if (isFastControl(name)) {
        fastControlNames.push(name);
      }
      const combinedStyle = styleChunks.join('\n');
      const compiledCss = compileIconCss(name, combinedStyle);
      if (compiledCss) {
        cssSections.push(`/* Icon: ${name} */\n${compiledCss}\n`);
      }
    }
  }

  // Emit refined semantic press overrides AFTER base .tgi-press rules
  const pressOverrides = ['/* Refined press micro-interaction overrides */'];

  if (fastControlNames.length > 0) {
    const fastBase = fastControlNames.map((n) => `.tgi.tgi-${n} .tgi-press`).join(',\n');
    const fastActive = fastControlNames
      .flatMap((n) => [
        `.tgi.tgi-${n}:active .tgi-press`,
        `${TRIGGER}:active .tgi.tgi-${n} .tgi-press`
      ])
      .join(',\n');
    pressOverrides.push(
      `${fastBase} {\n  transition-duration: 80ms;\n}\n${fastActive} {\n  transform: scale(0.92);\n}`
    );
  }

  for (const [name, transform] of Object.entries(DIRECTIONAL_PRESS)) {
    pressOverrides.push(
      `.tgi.tgi-${name}:active .tgi-press,\n${TRIGGER}:active .tgi.tgi-${name} .tgi-press {\n  transform: ${transform};\n}`
    );
  }

  for (const [name, transform] of Object.entries(ROTATIONAL_PRESS)) {
    pressOverrides.push(
      `.tgi.tgi-${name}:active .tgi-press,\n${TRIGGER}:active .tgi.tgi-${name} .tgi-press {\n  transform: ${transform};\n}`
    );
  }

  cssSections.push(pressOverrides.join('\n\n') + '\n');

  // Write icons.generated.css
  fs.writeFileSync(OUT_CSS, cssSections.join('\n'), 'utf8');

  // Write icons.generated.ts
  const iconNamesList = registry.map((r) => r.name);
  const tsLines = [
    '// AUTO-GENERATED by packages/tgrid-icons/scripts/build-icons.mjs — DO NOT EDIT BY HAND',
    '',
    'export interface CompiledIconEntry {',
    '  readonly viewBox: string;',
    '  readonly fill?: string;',
    '  readonly hasIds: boolean;',
    '  readonly body: string;',
    '}',
    '',
    `export const ICON_NAMES = ${JSON.stringify(iconNamesList, null, 2)} as const;`,
    '',
    'export type IconName = (typeof ICON_NAMES)[number];',
    '',
    'export const ICON_REGISTRY: Record<IconName, CompiledIconEntry> = {'
  ];

  for (const item of registry) {
    const entryObj = {
      viewBox: item.viewBox,
      ...(item.fill !== undefined ? { fill: item.fill } : {}),
      hasIds: item.hasIds,
      body: item.body
    };
    tsLines.push(`  ${JSON.stringify(item.name)}: ${JSON.stringify(entryObj)},`);
  }

  tsLines.push('};', '');

  fs.writeFileSync(OUT_TS, tsLines.join('\n'), 'utf8');

  console.log(
    `[@tgrid/icons] Compiled ${registry.length} icons -> src/icons.generated.ts & src/icons.generated.css`
  );
}

main();
