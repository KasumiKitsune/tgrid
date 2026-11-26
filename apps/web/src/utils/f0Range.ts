import type { AudioAnalysisSummary } from '../bridge/types';

export type F0RangeMode = 'auto' | 'male' | 'female' | 'custom';

export interface F0RangeBounds {
  floor: number;
  ceil: number;
}

export const F0_DEFAULT_CUSTOM: [number, number] = [75, 450];
export const F0_MIN_HZ = 40;
export const F0_MAX_HZ = 1000;
export const F0_MIN_SPAN_HZ = 25;

const F0_RANGE_STORAGE_KEY = 'tg_f0_range_prefs_v1';

export function clampCustomF0Range(minHz: number, maxHz: number): [number, number] {
  let lo = Number.isFinite(minHz) ? Math.round(minHz) : F0_DEFAULT_CUSTOM[0];
  let hi = Number.isFinite(maxHz) ? Math.round(maxHz) : F0_DEFAULT_CUSTOM[1];
  lo = Math.max(F0_MIN_HZ, Math.min(F0_MAX_HZ - F0_MIN_SPAN_HZ, lo));
  hi = Math.max(lo + F0_MIN_SPAN_HZ, Math.min(F0_MAX_HZ, hi));
  return [lo, hi];
}

export function resolveEffectiveF0Range(
  analysis: Pick<AudioAnalysisSummary, 'f0Floor' | 'f0Ceil'> | null | undefined,
  mode: F0RangeMode,
  custom: [number, number]
): F0RangeBounds {
  if (mode === 'male') return { floor: 75, ceil: 300 };
  if (mode === 'female') return { floor: 100, ceil: 500 };
  if (mode === 'custom') {
    const [lo, hi] = clampCustomF0Range(custom[0], custom[1]);
    return { floor: lo, ceil: hi };
  }
  const floor = analysis?.f0Floor ?? 65;
  const ceil = Math.max(floor + 50, analysis?.f0Ceil || 500);
  return { floor, ceil };
}

export function resolveF0RangeOverride(
  mode: F0RangeMode,
  custom: [number, number]
): F0RangeBounds | null {
  if (mode === 'auto') return null;
  return resolveEffectiveF0Range(null, mode, custom);
}

export function loadF0RangePrefs(): { mode: F0RangeMode; custom: [number, number] } {
  try {
    const raw = JSON.parse(localStorage.getItem(F0_RANGE_STORAGE_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      const r = raw as { mode?: unknown; custom?: unknown };
      const mode: F0RangeMode =
        r.mode === 'male' || r.mode === 'female' || r.mode === 'custom' ? r.mode : 'auto';
      const custom: [number, number] =
        Array.isArray(r.custom) && r.custom.length === 2
          ? clampCustomF0Range(Number(r.custom[0]), Number(r.custom[1]))
          : [...F0_DEFAULT_CUSTOM];
      return { mode, custom };
    }
  } catch {
    // ignore storage errors
  }
  return { mode: 'auto', custom: [...F0_DEFAULT_CUSTOM] };
}

export function saveF0RangePrefs(mode: F0RangeMode, custom: [number, number]): void {
  try {
    localStorage.setItem(F0_RANGE_STORAGE_KEY, JSON.stringify({ mode, custom }));
  } catch {
    // ignore storage errors
  }
}
