import type { Interval, TextGrid, TextGridFormat, Tier } from '../bridge/types';
import {
  DEFAULT_PALETTE_ID,
  cloneStyleDocument,
  createDefaultStyleDocument
} from '../style/palettes.ts';
import { parseStyleSidecar } from '../style/styleCodec.ts';
import type { StyleDocument } from '../style/types.ts';
import {
  DEFAULT_CORPUS_OPTIONS,
  DEFAULT_CORPUS_TIER_TEMPLATE,
  type CorpusDirScanResult,
  type CorpusItemRecord,
  type CorpusItemStatus,
  type CorpusItemStyleOverrides,
  type CorpusOptions,
  type CorpusProjectFile,
  type CorpusProjectItemPersisted,
  type CorpusProjectState,
  type CorpusSharedStyle,
  type CorpusTierTemplateItem,
  type CorpusWordListMeta,
  type VadSegment
} from './types';

function hasNonEmptyRecord(obj: object | undefined): boolean {
  if (!obj) return false;
  for (const val of Object.values(obj)) {
    if (val !== undefined) {
      if (typeof val === 'object' && val !== null) {
        if (hasNonEmptyRecord(val)) return true;
      } else {
        return true;
      }
    }
  }
  return false;
}

export function hasAnyCustomSharedStyle(shared?: CorpusSharedStyle | null): boolean {
  if (!shared) return false;
  if (shared.paletteId !== DEFAULT_PALETTE_ID) return true;
  if (shared.bwPrintMode) return true;
  if (shared.showLegendInExport === false) return true;
  if (shared.rules && shared.rules.length > 0) return true;
  if (hasNonEmptyRecord(shared.globalInterval)) return true;
  if (hasNonEmptyRecord(shared.globalBoundary)) return true;
  if (hasNonEmptyRecord(shared.globalPoint)) return true;
  if (shared.swatchLabels) {
    for (const label of Object.values(shared.swatchLabels)) {
      if (label && label.trim().length > 0) return true;
    }
  }
  if (shared.tierStyles) {
    for (const tierStyle of Object.values(shared.tierStyles)) {
      if (hasNonEmptyRecord(tierStyle)) return true;
    }
  }
  if (
    shared.layoutPrefs &&
    ((shared.layoutPrefs.scaleMode && shared.layoutPrefs.scaleMode !== 'elastic') ||
      (shared.layoutPrefs.tierScaleOverrides &&
        Object.keys(shared.layoutPrefs.tierScaleOverrides).length > 0))
  ) {
    return true;
  }
  return false;
}

export function hasAnyCustomItemStyle(itemStyle?: CorpusItemStyleOverrides | null): boolean {
  if (!itemStyle) return false;
  if (itemStyle.intervalOverrides && itemStyle.intervalOverrides.length > 0) return true;
  if (itemStyle.boundaryOverrides && itemStyle.boundaryOverrides.length > 0) return true;
  if (itemStyle.pointOverrides && itemStyle.pointOverrides.length > 0) return true;
  if (
    itemStyle.orphaned &&
    (itemStyle.orphaned.intervals.length > 0 ||
      itemStyle.orphaned.boundaries.length > 0 ||
      itemStyle.orphaned.points.length > 0)
  ) {
    return true;
  }
  return false;
}

export function extractSharedStyle(doc: StyleDocument): CorpusSharedStyle | undefined {
  const cloned = cloneStyleDocument(doc);
  const shared: CorpusSharedStyle = {
    paletteId: cloned.paletteId,
    bwPrintMode: cloned.bwPrintMode,
    showLegendInExport: cloned.showLegendInExport,
    swatchLabels: cloned.swatchLabels,
    tierStyles: cloned.tierStyles,
    rules: cloned.rules,
    ...(cloned.globalInterval && hasNonEmptyRecord(cloned.globalInterval)
      ? { globalInterval: cloned.globalInterval }
      : {}),
    ...(cloned.globalBoundary && hasNonEmptyRecord(cloned.globalBoundary)
      ? { globalBoundary: cloned.globalBoundary }
      : {}),
    ...(cloned.globalPoint && hasNonEmptyRecord(cloned.globalPoint)
      ? { globalPoint: cloned.globalPoint }
      : {}),
    ...(cloned.layoutPrefs ? { layoutPrefs: cloned.layoutPrefs } : {})
  };
  return hasAnyCustomSharedStyle(shared) ? shared : undefined;
}

export function extractItemStyleOverrides(
  doc: StyleDocument
): CorpusItemStyleOverrides | undefined {
  const cloned = cloneStyleDocument(doc);
  const ov: CorpusItemStyleOverrides = {
    intervalOverrides: cloned.intervalOverrides,
    boundaryOverrides: cloned.boundaryOverrides,
    pointOverrides: cloned.pointOverrides,
    ...(cloned.orphaned &&
    (cloned.orphaned.intervals.length > 0 ||
      cloned.orphaned.boundaries.length > 0 ||
      cloned.orphaned.points.length > 0)
      ? { orphaned: cloned.orphaned }
      : {})
  };
  return hasAnyCustomItemStyle(ov) ? ov : undefined;
}

export function composeCorpusStyleDocument(
  sharedStyle?: CorpusSharedStyle | null,
  itemStyle?: CorpusItemStyleOverrides | null
): StyleDocument {
  const base = createDefaultStyleDocument(sharedStyle?.paletteId ?? DEFAULT_PALETTE_ID);
  if (sharedStyle) {
    base.paletteId = sharedStyle.paletteId;
    base.bwPrintMode = Boolean(sharedStyle.bwPrintMode);
    base.showLegendInExport = sharedStyle.showLegendInExport ?? true;
    base.swatchLabels = { ...(sharedStyle.swatchLabels ?? {}) };
    if (sharedStyle.globalInterval) base.globalInterval = { ...sharedStyle.globalInterval };
    if (sharedStyle.globalBoundary) base.globalBoundary = { ...sharedStyle.globalBoundary };
    if (sharedStyle.globalPoint) base.globalPoint = { ...sharedStyle.globalPoint };
    base.tierStyles = { ...(sharedStyle.tierStyles ?? {}) };
    base.rules = [...(sharedStyle.rules ?? [])];
    if (sharedStyle.layoutPrefs) {
      base.layoutPrefs = {
        ...(sharedStyle.layoutPrefs.scaleMode ? { scaleMode: sharedStyle.layoutPrefs.scaleMode } : {}),
        ...(sharedStyle.layoutPrefs.tierScaleOverrides
          ? { tierScaleOverrides: { ...sharedStyle.layoutPrefs.tierScaleOverrides } }
          : {})
      };
    }
  }
  if (itemStyle) {
    base.intervalOverrides = [...(itemStyle.intervalOverrides ?? [])];
    base.boundaryOverrides = [...(itemStyle.boundaryOverrides ?? [])];
    base.pointOverrides = [...(itemStyle.pointOverrides ?? [])];
    if (itemStyle.orphaned) {
      base.orphaned = {
        intervals: [...(itemStyle.orphaned.intervals ?? [])],
        boundaries: [...(itemStyle.orphaned.boundaries ?? [])],
        points: [...(itemStyle.orphaned.points ?? [])]
      };
    }
  }
  return cloneStyleDocument(base);
}

const VALID_STATUSES = new Set<CorpusItemStatus>(['todo', 'done', 'doubt', 'trash']);
const VALID_SAVE_FORMATS = new Set<TextGridFormat>([
  'longText',
  'shortText',
  'binary',
  'chronological'
]);

// scan_diagnostics 将 < 5ms 区间标为 microSegment，此处使用 10ms 安全下限
const MIN_INTERVAL_SEC = 0.01;

export function normalizeCorpusId(stemOrRelPath: string): string {
  const trimmed = stemOrRelPath.trim();
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.trim().toLowerCase();
}

export function extractLabelFromStem(
  stem: string,
  meta?: Record<string, string>,
  displayColumns?: string[]
): string {
  if (meta) {
    const keys =
      displayColumns && displayColumns.length > 0
        ? displayColumns
        : ['字', '词', '词条', 'word', 'label'];
    const parts: string[] = [];
    for (const key of keys) {
      const val = meta[key]?.trim();
      if (val) parts.push(val);
    }
    if (parts.length > 0) {
      return parts.join(' ');
    }
  }
  return stem.trim() || '未命名词条';
}

function sanitizeStatus(raw: unknown): CorpusItemStatus {
  return typeof raw === 'string' && VALID_STATUSES.has(raw as CorpusItemStatus)
    ? (raw as CorpusItemStatus)
    : 'todo';
}

function sanitizeTierTemplate(raw: unknown): CorpusTierTemplateItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CorpusTierTemplateItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : '';
    const kind = obj.kind === 'intervalTier' || obj.kind === 'textTier' ? obj.kind : null;
    if (name && kind) {
      out.push({ name, kind });
    }
  }
  return out;
}

function resolveDefaultTargetTierIndex(
  template: CorpusTierTemplateItem[],
  preferred?: number
): number {
  if (
    typeof preferred === 'number' &&
    Number.isInteger(preferred) &&
    preferred >= 0 &&
    preferred < template.length &&
    template[preferred].kind === 'intervalTier'
  ) {
    return preferred;
  }
  if (template.length > 1 && template[1].kind === 'intervalTier') {
    return 1;
  }
  const firstInterval = template.findIndex((t) => t.kind === 'intervalTier');
  return firstInterval >= 0 ? firstInterval : 0;
}

/**
 * 解析 .tgrid-project.json 字节；若文件损坏或版本不兼容则返回 null。
 */
export function parseProjectFile(bytes: Uint8Array): CorpusProjectFile | null {
  try {
    let text = new TextDecoder('utf-8').decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1) {
      return null;
    }

    const rawItems = parsed.items;
    const items: Record<string, CorpusProjectItemPersisted> = {};
    if (rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems)) {
      for (const [rawKey, val] of Object.entries(rawItems as Record<string, unknown>)) {
        if (!val || typeof val !== 'object') continue;
        const rec = val as Record<string, unknown>;
        const id = rawKey.trim().toLowerCase();
        if (!id) continue;
        const audioRelPath =
          typeof rec.audioRelPath === 'string' ? rec.audioRelPath : '';
        const tgRelPath = typeof rec.tgRelPath === 'string' ? rec.tgRelPath : '';
        const duration =
          typeof rec.duration === 'number' && Number.isFinite(rec.duration) && rec.duration > 0
            ? rec.duration
            : null;
        const meta: Record<string, string> | undefined =
          rec.meta && typeof rec.meta === 'object' && !Array.isArray(rec.meta)
            ? Object.fromEntries(
                Object.entries(rec.meta as Record<string, unknown>).map(([k, v]) => [
                  k,
                  v == null ? '' : String(v)
                ])
              )
            : undefined;
        items[id] = {
          audioRelPath,
          tgRelPath,
          status: sanitizeStatus(rec.status),
          duration,
          label: typeof rec.label === 'string' ? rec.label : undefined,
          ipaPreview: typeof rec.ipaPreview === 'string' ? rec.ipaPreview : undefined,
          note: typeof rec.note === 'string' ? rec.note : undefined,
          updatedAt:
            typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt)
              ? rec.updatedAt
              : 0,
          missing: rec.missing === true ? true : undefined,
          meta
        };
      }
    }

    const defaultSaveFormat =
      typeof parsed.defaultSaveFormat === 'string' &&
      VALID_SAVE_FORMATS.has(parsed.defaultSaveFormat as TextGridFormat)
        ? (parsed.defaultSaveFormat as TextGridFormat)
        : undefined;

    const rawOpts =
      parsed.options && typeof parsed.options === 'object'
        ? (parsed.options as Record<string, unknown>)
        : undefined;
    const options: Partial<CorpusOptions> | undefined = rawOpts
      ? {
          autoPlay: typeof rawOpts.autoPlay === 'boolean' ? rawOpts.autoPlay : undefined,
          autoVad: typeof rawOpts.autoVad === 'boolean' ? rawOpts.autoVad : undefined,
          targetTierIndex:
            typeof rawOpts.targetTierIndex === 'number' &&
            Number.isInteger(rawOpts.targetTierIndex)
              ? rawOpts.targetTierIndex
              : undefined
        }
      : undefined;

    const rawWl =
      parsed.wordListMeta && typeof parsed.wordListMeta === 'object'
        ? (parsed.wordListMeta as Record<string, unknown>)
        : undefined;
    const wordListMeta: CorpusWordListMeta | undefined =
      rawWl && typeof rawWl.sourceFile === 'string' && typeof rawWl.idColumn === 'string'
        ? {
            sourceFile: rawWl.sourceFile,
            idColumn: rawWl.idColumn,
            displayColumns: Array.isArray(rawWl.displayColumns)
              ? rawWl.displayColumns.filter((c): c is string => typeof c === 'string')
              : []
          }
        : undefined;

    let sharedStyle: CorpusSharedStyle | undefined;
    if (parsed.sharedStyle && typeof parsed.sharedStyle === 'object' && !Array.isArray(parsed.sharedStyle)) {
      const sanitized = parseStyleSidecar(parsed.sharedStyle);
      if (sanitized) {
        sharedStyle = extractSharedStyle(sanitized);
      }
    }

    let itemStyles: Record<string, CorpusItemStyleOverrides> | undefined;
    if (parsed.itemStyles && typeof parsed.itemStyles === 'object' && !Array.isArray(parsed.itemStyles)) {
      const collected: Record<string, CorpusItemStyleOverrides> = {};
      for (const [rawKey, rawVal] of Object.entries(parsed.itemStyles as Record<string, unknown>)) {
        const id = rawKey.trim().toLowerCase();
        if (!id || !rawVal || typeof rawVal !== 'object' || Array.isArray(rawVal)) continue;
        const sanitized = parseStyleSidecar(rawVal);
        if (!sanitized) continue;
        const extracted = extractItemStyleOverrides(sanitized);
        if (extracted) {
          collected[id] = extracted;
        }
      }
      if (Object.keys(collected).length > 0) {
        itemStyles = collected;
      }
    }

    return {
      schemaVersion: 1,
      projectName: typeof parsed.projectName === 'string' ? parsed.projectName : '',
      updatedAt:
        typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      defaultSaveFormat,
      tierTemplate: sanitizeTierTemplate(parsed.tierTemplate),
      activeItemId: typeof parsed.activeItemId === 'string' ? parsed.activeItemId : null,
      options,
      wordListMeta,
      ...(sharedStyle ? { sharedStyle } : {}),
      ...(itemStyles ? { itemStyles } : {}),
      items
    };
  } catch {
    return null;
  }
}

/**
 * 将运行时 CorpusProjectState 序列化为仅含相对路径的 .tgrid-project.json 字节。
 */
export function serializeProjectFile(state: CorpusProjectState): Uint8Array {
  const items: Record<string, CorpusProjectItemPersisted> = {};
  for (const item of state.items) {
    const persisted: CorpusProjectItemPersisted = {
      audioRelPath: item.audioRelPath,
      tgRelPath: item.tgRelPath,
      status: item.status,
      duration: item.duration
    };
    if (item.label) persisted.label = item.label;
    if (item.ipaPreview) persisted.ipaPreview = item.ipaPreview;
    if (item.note) persisted.note = item.note;
    if (item.updatedAt > 0) persisted.updatedAt = item.updatedAt;
    if (item.missing) persisted.missing = true;
    if (item.meta && Object.keys(item.meta).length > 0) persisted.meta = item.meta;
    items[item.id] = persisted;
  }

  const cleanedSharedStyle = state.sharedStyle
    ? extractSharedStyle(composeCorpusStyleDocument(state.sharedStyle, null))
    : undefined;

  let cleanedItemStyles: Record<string, CorpusItemStyleOverrides> | undefined;
  if (state.itemStyles) {
    const out: Record<string, CorpusItemStyleOverrides> = {};
    for (const [rawId, ov] of Object.entries(state.itemStyles)) {
      const id = rawId.trim().toLowerCase();
      if (!id || !hasAnyCustomItemStyle(ov)) continue;
      const extracted = extractItemStyleOverrides(composeCorpusStyleDocument(null, ov));
      if (extracted) out[id] = extracted;
    }
    if (Object.keys(out).length > 0) {
      cleanedItemStyles = out;
    }
  }

  const file: CorpusProjectFile = {
    schemaVersion: 1,
    projectName: state.projectName,
    updatedAt: new Date().toISOString(),
    defaultSaveFormat: state.defaultSaveFormat,
    tierTemplate: state.tierTemplate.map((t) => ({ name: t.name, kind: t.kind })),
    activeItemId: state.activeItemId,
    options: {
      autoPlay: state.options.autoPlay,
      autoVad: state.options.autoVad,
      targetTierIndex: state.options.targetTierIndex
    },
    ...(state.wordListMeta ? { wordListMeta: state.wordListMeta } : {}),
    ...(cleanedSharedStyle ? { sharedStyle: cleanedSharedStyle } : {}),
    ...(cleanedItemStyles ? { itemStyles: cleanedItemStyles } : {}),
    items
  };

  return new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`);
}

/**
 * 从已有 TextGrid 中嗅探层结构模板；若无有效层则回退默认模板（字词 / 音标 / 备注）。
 */
export function sniffTierTemplateFromTextGrid(tg: TextGrid | null | undefined): CorpusTierTemplateItem[] {
  if (!tg || !Array.isArray(tg.tiers) || tg.tiers.length === 0) {
    return DEFAULT_CORPUS_TIER_TEMPLATE.map((t) => ({ ...t }));
  }
  return tg.tiers.map((tier, idx) => ({
    name: tier.name?.trim() || `层 ${idx + 1}`,
    kind: tier.kind === 'textTier' ? 'textTier' : 'intervalTier'
  }));
}

export interface ReconciledCorpusProject {
  projectName: string;
  defaultSaveFormat: TextGridFormat;
  tierTemplate: CorpusTierTemplateItem[];
  items: CorpusItemRecord[];
  itemMap: Record<string, CorpusItemRecord>;
  activeItemId: string | null;
  options: CorpusOptions;
  wordListMeta?: CorpusWordListMeta;
  sharedStyle?: CorpusSharedStyle;
  itemStyles?: Record<string, CorpusItemStyleOverrides>;
}

/**
 * 将磁盘扫描结果与既有 .tgrid-project.json 进行增量对账：
 * - 以磁盘音频与 TextGrid 文件为真值
 * - 保留已有词条的状态、音标摘要、备注、时长缓存与元数据
 * - 磁盘已删除但含有用户标注/备注的历史条目以 missing: true 保留
 */
export function reconcileProjectWithScan(
  scan: CorpusDirScanResult,
  existing: CorpusProjectFile | null,
  sniffedTemplate?: CorpusTierTemplateItem[] | null
): ReconciledCorpusProject {
  const tgById = new Map<string, string>();
  for (const tg of scan.textGridFiles) {
    const id = normalizeCorpusId(tg.stem);
    if (id && !tgById.has(id)) {
      tgById.set(id, tg.relPath);
    }
  }

  // 同 stem 出现多种音频格式时优先保留 .wav
  const audioById = new Map<string, (typeof scan.audioFiles)[number]>();
  for (const audio of scan.audioFiles) {
    const id = normalizeCorpusId(audio.stem);
    if (!id) continue;
    const prev = audioById.get(id);
    if (!prev) {
      audioById.set(id, audio);
    } else if (
      !prev.relPath.toLowerCase().endsWith('.wav') &&
      audio.relPath.toLowerCase().endsWith('.wav')
    ) {
      audioById.set(id, audio);
    }
  }

  const sortedAudios = Array.from(audioById.entries()).sort((a, b) =>
    a[1].relPath.localeCompare(b[1].relPath, undefined, { numeric: true, sensitivity: 'base' })
  );

  const items: CorpusItemRecord[] = [];
  const itemMap: Record<string, CorpusItemRecord> = {};
  const seenIds = new Set<string>();
  const displayCols = existing?.wordListMeta?.displayColumns;

  for (const [id, audio] of sortedAudios) {
    seenIds.add(id);
    const prev = existing?.items[id];
    const diskTgRelPath = tgById.get(id);
    const hasTextGrid = Boolean(diskTgRelPath);
    const tgRelPath = diskTgRelPath ?? prev?.tgRelPath ?? `${audio.stem}.TextGrid`;
    const duration =
      audio.duration != null && audio.duration > 0
        ? audio.duration
        : prev?.duration ?? null;

    const record: CorpusItemRecord = {
      id,
      audioRelPath: audio.relPath,
      tgRelPath,
      hasTextGrid,
      status: prev?.status ?? 'todo',
      duration,
      label: prev?.label?.trim() || extractLabelFromStem(audio.stem, prev?.meta, displayCols),
      ipaPreview: prev?.ipaPreview ?? '',
      note: prev?.note ?? '',
      updatedAt: prev?.updatedAt ?? 0,
      ...(prev?.meta ? { meta: prev.meta } : {})
    };
    items.push(record);
    itemMap[id] = record;
  }

  // 支持纯 TextGrid（无配套音频）的词条目录或内置示例
  const sortedExtraTgs = scan.textGridFiles
    .map((tg) => ({ id: normalizeCorpusId(tg.stem), tg }))
    .filter((entry) => Boolean(entry.id) && !seenIds.has(entry.id))
    .sort((a, b) =>
      a.tg.relPath.localeCompare(b.tg.relPath, undefined, { numeric: true, sensitivity: 'base' })
    );

  for (const { id, tg } of sortedExtraTgs) {
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const prev = existing?.items[id];
    const record: CorpusItemRecord = {
      id,
      audioRelPath: '',
      tgRelPath: tg.relPath,
      hasTextGrid: true,
      status: prev?.status ?? 'todo',
      duration: prev?.duration ?? null,
      label: prev?.label?.trim() || extractLabelFromStem(tg.stem, prev?.meta, displayCols),
      ipaPreview: prev?.ipaPreview ?? '',
      note: prev?.note ?? '',
      updatedAt: prev?.updatedAt ?? 0,
      ...(prev?.meta ? { meta: prev.meta } : {})
    };
    items.push(record);
    itemMap[id] = record;
  }

  // 保留磁盘已缺失但有历史进度、备注或元数据的条目
  if (existing) {
    const missingEntries = Object.entries(existing.items)
      .filter(([id, prev]) => {
        if (seenIds.has(id)) return false;
        return Boolean(
          prev.status !== 'todo' ||
            prev.note ||
            prev.ipaPreview ||
            (prev.meta && Object.keys(prev.meta).length > 0)
        );
      })
      .sort((a, b) =>
        a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' })
      );

    for (const [id, prev] of missingEntries) {
      const diskTgRelPath = tgById.get(id);
      const record: CorpusItemRecord = {
        id,
        audioRelPath: prev.audioRelPath || `${id}.wav`,
        tgRelPath: diskTgRelPath ?? prev.tgRelPath ?? `${id}.TextGrid`,
        hasTextGrid: Boolean(diskTgRelPath),
        status: prev.status,
        duration: prev.duration,
        label: prev.label?.trim() || extractLabelFromStem(id, prev.meta, displayCols),
        ipaPreview: prev.ipaPreview ?? '',
        note: prev.note ?? '',
        updatedAt: prev.updatedAt ?? 0,
        missing: true,
        ...(prev.meta ? { meta: prev.meta } : {})
      };
      items.push(record);
      itemMap[id] = record;
    }
  }

  const tierTemplate =
    existing && existing.tierTemplate.length > 0
      ? existing.tierTemplate.map((t) => ({ ...t }))
      : sniffedTemplate && sniffedTemplate.length > 0
        ? sniffedTemplate.map((t) => ({ ...t }))
        : DEFAULT_CORPUS_TIER_TEMPLATE.map((t) => ({ ...t }));

  const options: CorpusOptions = {
    autoPlay: existing?.options?.autoPlay ?? DEFAULT_CORPUS_OPTIONS.autoPlay,
    autoVad: existing?.options?.autoVad ?? DEFAULT_CORPUS_OPTIONS.autoVad,
    targetTierIndex: resolveDefaultTargetTierIndex(
      tierTemplate,
      existing?.options?.targetTierIndex
    )
  };

  let activeItemId: string | null = null;
  if (existing?.activeItemId) {
    const prevActive = itemMap[existing.activeItemId];
    if (prevActive && !prevActive.missing) {
      activeItemId = prevActive.id;
    }
  }
  if (!activeItemId) {
    const firstTodo = items.find((it) => !it.missing && it.status === 'todo');
    const firstValid = items.find((it) => !it.missing);
    activeItemId = firstTodo?.id ?? firstValid?.id ?? null;
  }

  let preservedItemStyles: Record<string, CorpusItemStyleOverrides> | undefined;
  if (existing?.itemStyles) {
    const out: Record<string, CorpusItemStyleOverrides> = {};
    for (const [id, ov] of Object.entries(existing.itemStyles)) {
      if (itemMap[id] && hasAnyCustomItemStyle(ov)) {
        out[id] = ov;
      }
    }
    if (Object.keys(out).length > 0) {
      preservedItemStyles = out;
    }
  }

  return {
    projectName: existing?.projectName?.trim() || scan.dirName || '语料文件夹',
    defaultSaveFormat: existing?.defaultSaveFormat ?? 'longText',
    tierTemplate,
    items,
    itemMap,
    activeItemId,
    options,
    wordListMeta: existing?.wordListMeta,
    ...(existing?.sharedStyle && hasAnyCustomSharedStyle(existing.sharedStyle)
      ? { sharedStyle: existing.sharedStyle }
      : {}),
    ...(preservedItemStyles ? { itemStyles: preservedItemStyles } : {})
  };
}

function normalizeVadSegmentsForDomain(
  vadBounds: VadSegment | VadSegment[] | null | undefined,
  duration: number
): VadSegment[] {
  if (!vadBounds) return [];
  const list = Array.isArray(vadBounds) ? vadBounds : [vadBounds];
  const cleaned = list
    .filter(
      (s) =>
        s &&
        Number.isFinite(s.start) &&
        Number.isFinite(s.end) &&
        s.end > s.start
    )
    .map((s) => ({
      start: Math.max(0, Math.min(duration, s.start)),
      end: Math.max(0, Math.min(duration, s.end))
    }))
    .filter((s) => s.end - s.start >= MIN_INTERVAL_SEC)
    .sort((a, b) => a.start - b.start);

  if (cleaned.length === 0) return [];

  const merged: VadSegment[] = [];
  for (const seg of cleaned) {
    const start = seg.start < MIN_INTERVAL_SEC ? 0 : seg.start;
    const end = duration - seg.end < MIN_INTERVAL_SEC ? duration : seg.end;
    if (end - start < MIN_INTERVAL_SEC) continue;
    const prev = merged[merged.length - 1];
    if (prev && start - prev.end < MIN_INTERVAL_SEC) {
      prev.end = Math.max(prev.end, end);
    } else {
      merged.push({ start, end });
    }
  }
  return merged;
}

function buildSeamlessIntervals(
  duration: number,
  segments: VadSegment[],
  prefillText: string
): Interval[] {
  if (segments.length === 0) {
    return [{ xmin: 0, xmax: duration, text: prefillText }];
  }

  const intervals: Interval[] = [];
  let cursor = 0;
  let prefilled = false;

  for (const seg of segments) {
    if (seg.start > cursor + 1e-9) {
      intervals.push({ xmin: cursor, xmax: seg.start, text: '' });
    }
    const text = !prefilled ? prefillText : '';
    prefilled = true;
    intervals.push({ xmin: seg.start, xmax: seg.end, text });
    cursor = seg.end;
  }

  if (duration > cursor + 1e-9) {
    intervals.push({ xmin: cursor, xmax: duration, text: '' });
  }

  return intervals.length > 0 ? intervals : [{ xmin: 0, xmax: duration, text: prefillText }];
}

/**
 * 按层模板瞬时构造合法的 TextGrid：
 * - 所有层的 xmin/xmax 与主文档 [0, duration] 严格对齐
 * - 所有 intervalTier 连续无缝覆盖 [0, duration]，无空隙、无重叠、无 <5ms 微段，可通过 scan_diagnostics
 * - 若提供 VAD 语音段 [t1, t2]，自动按三段（静音 / 语音 / 静音）或多段切分
 */
export function buildTextGridFromTemplate(
  template: CorpusTierTemplateItem[],
  duration: number,
  name: string,
  vadBounds?: VadSegment | VadSegment[] | null,
  prefillFirstTier?: string
): TextGrid {
  const safeDuration = Number.isFinite(duration) && duration > MIN_INTERVAL_SEC ? duration : 1.0;
  const effectiveTemplate =
    template.length > 0 ? template : DEFAULT_CORPUS_TIER_TEMPLATE;
  const normalizedSegments = normalizeVadSegmentsForDomain(vadBounds, safeDuration);
  const prefill = prefillFirstTier?.trim() ?? '';

  let appliedPrefill = false;
  const tiers: Tier[] = effectiveTemplate.map((item) => {
    if (item.kind === 'textTier') {
      return {
        kind: 'textTier',
        name: item.name,
        xmin: 0,
        xmax: safeDuration,
        intervals: [],
        points: []
      };
    }

    const tierPrefill = !appliedPrefill ? prefill : '';
    appliedPrefill = true;
    return {
      kind: 'intervalTier',
      name: item.name,
      xmin: 0,
      xmax: safeDuration,
      intervals: buildSeamlessIntervals(safeDuration, normalizedSegments, tierPrefill),
      points: []
    };
  });

  return {
    name: name.trim() || 'TextGrid',
    xmin: 0,
    xmax: safeDuration,
    tiers
  };
}

/**
 * 从 TextGrid 提取目标层非空文本摘要（用于左侧词条列表预览）。
 */
export function extractIpaPreview(
  tg: TextGrid | null | undefined,
  targetTierIndex: number,
  maxLength = 80
): string {
  if (!tg || tg.tiers.length === 0) return '';
  let tier = tg.tiers[targetTierIndex];
  if (!tier) {
    tier =
      tg.tiers.find((t) => t.kind === 'intervalTier') ??
      tg.tiers[0];
  }
  if (!tier) return '';

  const texts =
    tier.kind === 'intervalTier'
      ? tier.intervals.map((iv) => iv.text.trim()).filter(Boolean)
      : tier.points.map((pt) => pt.mark.trim()).filter(Boolean);

  if (texts.length === 0) return '';
  const joined = texts.join(' ');
  return joined.length > maxLength ? `${joined.slice(0, maxLength - 1)}…` : joined;
}

/**
 * 选出目标层中最适合默认聚焦与自动播放的区间索引：
 * - 若恰好是三段静音切分且首尾为空，优先选中中间段（索引 1）
 * - 否则优先选中首个非空段
 * - 否则若有 3 段及以上选第 1 段，否则选第 0 段
 */
export function findPreferredSpeechIntervalIndex(
  tg: TextGrid | null | undefined,
  tierIndex: number
): number {
  const tier = tg?.tiers[tierIndex];
  if (!tier || tier.kind !== 'intervalTier' || tier.intervals.length === 0) {
    return 0;
  }
  const ivs = tier.intervals;
  if (
    ivs.length === 3 &&
    !ivs[0].text.trim() &&
    !ivs[2].text.trim()
  ) {
    return 1;
  }
  const firstNonEmpty = ivs.findIndex((iv) => iv.text.trim().length > 0);
  if (firstNonEmpty >= 0) return firstNonEmpty;
  if (ivs.length >= 3) return 1;
  return 0;
}
