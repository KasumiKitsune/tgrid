const SESSION_STORAGE_KEY = 'tg_last_session_v1';

export type PersistedSessionTab =
  | { kind: 'single'; filePath: string }
  | { kind: 'corpus'; dirPath: string; activeItemId?: string | null };

export interface PersistedSession {
  version: 1;
  activeIndex: number;
  tabs: PersistedSessionTab[];
}

function normalizePathKey(rawPath: string): string {
  const unified = rawPath.trim().replace(/\\/g, '/');
  const withoutTrailing = unified.length > 1 ? unified.replace(/\/+$/, '') : unified;
  return withoutTrailing.toLowerCase();
}

function sanitizeSessionTab(raw: unknown): PersistedSessionTab | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  if (obj.kind === 'single') {
    if (typeof obj.filePath !== 'string') return null;
    const filePath = obj.filePath.trim();
    if (!filePath) return null;
    return { kind: 'single', filePath };
  }

  if (obj.kind === 'corpus') {
    if (typeof obj.dirPath !== 'string') return null;
    const dirPath = obj.dirPath.trim();
    if (!dirPath) return null;
    let activeItemId: string | null | undefined;
    if (typeof obj.activeItemId === 'string') {
      const trimmedId = obj.activeItemId.trim();
      activeItemId = trimmedId ? trimmedId : null;
    } else if (obj.activeItemId === null) {
      activeItemId = null;
    }
    return activeItemId !== undefined
      ? { kind: 'corpus', dirPath, activeItemId }
      : { kind: 'corpus', dirPath };
  }

  return null;
}

function getTabDedupKey(tab: PersistedSessionTab): string {
  return tab.kind === 'single'
    ? `single:${normalizePathKey(tab.filePath)}`
    : `corpus:${normalizePathKey(tab.dirPath)}`;
}

function sanitizePersistedSession(raw: unknown): PersistedSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1 || !Array.isArray(obj.tabs)) return null;

  const rawActiveIndex =
    typeof obj.activeIndex === 'number' && Number.isFinite(obj.activeIndex)
      ? Math.trunc(obj.activeIndex)
      : -1;

  const tabs: PersistedSessionTab[] = [];
  const seenIndexByKey = new Map<string, number>();
  let mappedActiveIndex: number | null = null;

  for (let i = 0; i < obj.tabs.length; i++) {
    const clean = sanitizeSessionTab(obj.tabs[i]);
    if (!clean) continue;

    const key = getTabDedupKey(clean);
    const existingIdx = seenIndexByKey.get(key);
    if (existingIdx !== undefined) {
      if (i === rawActiveIndex) {
        mappedActiveIndex = existingIdx;
      }
      continue;
    }

    const nextIdx = tabs.length;
    seenIndexByKey.set(key, nextIdx);
    tabs.push(clean);
    if (i === rawActiveIndex) {
      mappedActiveIndex = nextIdx;
    }
  }

  if (tabs.length === 0) return null;

  const fallbackIndex =
    rawActiveIndex >= 0 ? Math.min(rawActiveIndex, tabs.length - 1) : 0;
  const activeIndex =
    mappedActiveIndex !== null
      ? Math.max(0, Math.min(mappedActiveIndex, tabs.length - 1))
      : fallbackIndex;

  return {
    version: 1,
    activeIndex,
    tabs
  };
}

export function loadPersistedSession(): PersistedSession | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const rawText = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!rawText) return null;
    const parsed: unknown = JSON.parse(rawText);
    return sanitizePersistedSession(parsed);
  } catch {
    return null;
  }
}

export function savePersistedSession(session: PersistedSession): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const sanitized = sanitizePersistedSession(session);
    if (!sanitized || sanitized.tabs.length === 0) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      return;
    }
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    // 忽略本地存储写入异常
  }
}

export function clearPersistedSession(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // 忽略本地存储清理异常
  }
}
