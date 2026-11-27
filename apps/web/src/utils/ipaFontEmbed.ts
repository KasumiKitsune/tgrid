export type IpaFontVariant = 'sans' | 'serif';

const FONT_FAMILY_NAME: Record<IpaFontVariant, string> = {
  sans: 'TGrid IPA Sans',
  serif: 'TGrid IPA Serif'
};

const DEFAULT_FONT_CSS_BYTES: Record<IpaFontVariant, number> = {
  sans: 74_000,
  serif: 81_000
};

const resolvedDataUriCache = new Map<IpaFontVariant, Promise<string | null>>();
const resolvedCssByteCache = new Map<IpaFontVariant, number>();

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(''));
}

function findCssFontFaceSrc(familyName: string): { rawUrl: string; sheetHref: string | null } | null {
  if (typeof document === 'undefined' || !document.styleSheets) return null;
  const normTarget = familyName.toLowerCase();

  for (let si = 0; si < document.styleSheets.length; si++) {
    const sheet = document.styleSheets[si];
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;
    for (let ri = 0; ri < rules.length; ri++) {
      const rule = rules[ri];
      if (typeof CSSFontFaceRule !== 'undefined' ? !(rule instanceof CSSFontFaceRule) : rule.type !== 5) {
        continue;
      }
      const style = (rule as CSSFontFaceRule).style;
      const fam = (style.getPropertyValue('font-family') || '').replace(/['"]/g, '').trim().toLowerCase();
      if (fam !== normTarget) continue;
      const srcVal = style.getPropertyValue('src') || rule.cssText || '';
      const urlMatch = srcVal.match(/url\(\s*(['"]?)([^'")]+)\1\s*\)/i);
      if (urlMatch && urlMatch[2]) {
        return { rawUrl: urlMatch[2].trim(), sheetHref: sheet.href || null };
      }
    }
  }
  return null;
}

async function resolveFontDataUri(variant: IpaFontVariant): Promise<string | null> {
  const cached = resolvedDataUriCache.get(variant);
  if (cached) return cached;

  const task = (async () => {
    const found = findCssFontFaceSrc(FONT_FAMILY_NAME[variant]);
    if (!found) return null;

    if (/^data:/i.test(found.rawUrl)) {
      resolvedCssByteCache.set(variant, found.rawUrl.length + 140);
      return found.rawUrl;
    }

    try {
      const baseHref = found.sheetHref || (typeof document !== 'undefined' ? document.baseURI : '');
      const resolvedUrl = baseHref ? new URL(found.rawUrl, baseHref).href : found.rawUrl;
      const resp = await fetch(resolvedUrl);
      if (!resp.ok) return null;
      const buf = new Uint8Array(await resp.arrayBuffer());
      const dataUri = `data:font/woff2;base64,${uint8ArrayToBase64(buf)}`;
      resolvedCssByteCache.set(variant, dataUri.length + 140);
      return dataUri;
    } catch {
      return null;
    }
  })();

  resolvedDataUriCache.set(variant, task);
  const result = await task;
  if (!result) {
    resolvedDataUriCache.delete(variant);
  }
  return result;
}

/**
 * Inspects SVG markup and returns only the embedded IPA font variants actually referenced.
 */
export function detectReferencedIpaFonts(svgMarkup: string): IpaFontVariant[] {
  const out: IpaFontVariant[] = [];
  if (svgMarkup.includes(FONT_FAMILY_NAME.sans)) out.push('sans');
  if (svgMarkup.includes(FONT_FAMILY_NAME.serif)) out.push('serif');
  return out;
}

/**
 * Estimates the Base64 `@font-face` payload size in bytes for live UI preview readouts.
 */
export function estimateEmbeddedFontBytes(variants: IpaFontVariant[]): number {
  const uniq = Array.from(new Set(variants));
  let total = 0;
  for (const v of uniq) {
    total += resolvedCssByteCache.get(v) ?? DEFAULT_FONT_CSS_BYTES[v];
  }
  return total;
}

/**
 * Ensures requested `@font-face` IPA subsets are loaded in the browser before layout/rasterization.
 */
export async function ensureIpaFontsLoaded(
  variants: IpaFontVariant[] = ['sans'],
  timeoutMs = 2500
): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  const uniq = Array.from(new Set(variants));
  if (uniq.length === 0) return;

  try {
    const loads = Promise.all(
      uniq.map((v) => document.fonts.load(`400 12px "${FONT_FAMILY_NAME[v]}"`).catch(() => []))
    );
    await Promise.race([
      loads.then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  } catch {
    // Non-fatal: fall back to available fonts if loading fails in restricted contexts
  }
}

/**
 * Builds clean Base64 `@font-face` CSS rules for standalone SVG / print iframe embedding.
 */
export async function buildEmbeddedFontCss(variants: IpaFontVariant[]): Promise<string> {
  const uniq = Array.from(new Set(variants));
  if (uniq.length === 0) return '';

  const blocks: string[] = [];
  for (const variant of uniq) {
    const dataUri = await resolveFontDataUri(variant);
    if (!dataUri) continue;
    blocks.push(
      `@font-face{font-family:"${FONT_FAMILY_NAME[variant]}";src:url("${dataUri}") format("woff2");font-weight:400;font-style:normal;}`
    );
  }
  return blocks.join('\n');
}

/**
 * Injects inline Base64 `@font-face` `<style>` into isolated SVG markup `<defs>`
 * so PNG `<img>` rasterization, PDF print iframes, browsers, and Typst render IPA & Chao tone ligatures accurately.
 */
export async function injectIpaFontsIntoSvg(
  svgMarkup: string,
  options?: { variants?: IpaFontVariant[] }
): Promise<string> {
  if (!svgMarkup) return svgMarkup;
  const variants = options?.variants ?? detectReferencedIpaFonts(svgMarkup);
  if (variants.length === 0) return svgMarkup;

  const css = await buildEmbeddedFontCss(variants);
  if (!css) return svgMarkup;

  const styleTag = `<style type="text/css">/* TGrid IPA Subset (SIL OFL 1.1) */\n${css}</style>`;

  const selfClosingDefsRe = /<defs\b([^>]*)\/>/i;
  const openDefsRe = /<defs\b[^>]*>/i;

  if (openDefsRe.test(svgMarkup)) {
    const match = svgMarkup.match(openDefsRe);
    if (match && match[0].endsWith('/>')) {
      return svgMarkup.replace(selfClosingDefsRe, `<defs$1>${styleTag}</defs>`);
    }
    return svgMarkup.replace(openDefsRe, (tag) => `${tag}${styleTag}`);
  }

  return svgMarkup.replace(/<svg\b[^>]*>/i, (tag) => `${tag}<defs>${styleTag}</defs>`);
}
