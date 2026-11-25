export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 2.0;
export const UI_SCALE_STORAGE_KEY = 'tg_ui_scale_v1';

export const UI_SCALE_STOPS = [0.75, 0.85, 0.9, 1, 1.1, 1.25, 1.4, 1.5, 1.75, 2] as const;

export function clampUiScale(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  const clamped = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, raw));
  return Math.round(clamped * 100) / 100;
}

export function stepUiScale(current: number, dir: -1 | 1): number {
  const cur = clampUiScale(current);
  if (dir > 0) {
    for (const stop of UI_SCALE_STOPS) {
      if (stop > cur + 0.005) return stop;
    }
    return UI_SCALE_MAX;
  }
  for (let i = UI_SCALE_STOPS.length - 1; i >= 0; i--) {
    if (UI_SCALE_STOPS[i] < cur - 0.005) return UI_SCALE_STOPS[i];
  }
  return UI_SCALE_MIN;
}

export function loadSavedUiScale(): number {
  try {
    const raw = localStorage.getItem(UI_SCALE_STORAGE_KEY);
    if (raw !== null) {
      const parsed = parseFloat(raw);
      if (Number.isFinite(parsed)) return clampUiScale(parsed);
    }
  } catch {
    // ignore storage errors
  }
  return 1;
}

export function saveUiScale(scale: number): void {
  try {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, String(clampUiScale(scale)));
  } catch {
    // ignore storage errors
  }
}

export function getViewportZoom(): number {
  if (typeof document === 'undefined') return 1;
  const raw = parseFloat(document.documentElement.style.zoom || '');
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * Exact ratio between `getBoundingClientRect()` pixels and element-local CSS pixels.
 * Automatically adapts to both standard CSS zoom (rect scaled by zoom) and any legacy engine.
 */
export function getElementRectScale(el?: HTMLElement | null): number {
  if (el && el.offsetWidth > 0) {
    const ratio = el.getBoundingClientRect().width / el.offsetWidth;
    if (Number.isFinite(ratio) && ratio > 0.25 && ratio < 4) {
      return ratio;
    }
  }
  return getViewportZoom();
}

export function getLogicalViewportSize(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 1280, height: 820 };
  const z = getViewportZoom();
  return {
    width: window.innerWidth / z,
    height: window.innerHeight / z
  };
}

export function syncUiScaleViewportAttrs(scaleOverride?: number): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const z = scaleOverride ?? getViewportZoom();
  const vw = window.innerWidth / z;
  const vh = window.innerHeight / z;
  const html = document.documentElement;
  html.dataset.uiNarrow = vw <= 880 ? '1' : '0';
  html.dataset.uiCompact = vw <= 740 ? '1' : '0';
  html.dataset.uiShort = vh <= 560 ? '1' : '0';
}

export function applyUiScaleToDom(scale: number): void {
  if (typeof document === 'undefined') return;
  const safe = clampUiScale(scale);
  const html = document.documentElement;
  html.style.zoom = safe === 1 ? '' : String(safe);
  html.style.setProperty('--ui-scale', String(safe));
  syncUiScaleViewportAttrs(safe);
}
