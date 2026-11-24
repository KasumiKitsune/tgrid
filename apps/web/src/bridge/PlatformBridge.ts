import type { PlatformBridge } from './types';
import { TauriBridge } from './TauriBridge';
import { WebWasmBridge } from './WebWasmBridge';

let cachedBridge: PlatformBridge | null = null;

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function getPlatformBridge(): PlatformBridge {
  if (!cachedBridge) {
    cachedBridge = isTauriRuntime() ? new TauriBridge() : new WebWasmBridge();
  }
  return cachedBridge;
}

export type * from './types';
