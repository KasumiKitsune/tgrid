// Module-level store for decoded WebAudio AudioBuffer instances keyed by tabId.
// Kept outside Zustand state so large Float32 PCM arrays are never cloned or proxied.

const tabAudioBuffers = new Map<string, AudioBuffer>();

export function getTabAudioBuffer(tabId: string): AudioBuffer | null {
  return tabAudioBuffers.get(tabId) ?? null;
}

export function setTabAudioBuffer(tabId: string, buffer: AudioBuffer | null): void {
  if (buffer) {
    tabAudioBuffers.set(tabId, buffer);
  } else {
    tabAudioBuffers.delete(tabId);
  }
}

export function deleteTabAudioBuffer(tabId: string): void {
  tabAudioBuffers.delete(tabId);
}

export function clearAllTabAudioBuffers(): void {
  tabAudioBuffers.clear();
}
