import type {
  AudioAnalysisSummary,
  CorpusDirScanResult,
  CorpusScannedAudioFile,
  CorpusScannedFileEntry,
  TextGridFormat,
  TierKind
} from '../bridge/types';

export type {
  CorpusDirScanResult,
  CorpusScannedAudioFile,
  CorpusScannedFileEntry
};

export type CorpusItemStatus = 'todo' | 'done' | 'doubt' | 'trash';

export interface CorpusTierTemplateItem {
  name: string;
  kind: TierKind;
}

export interface CorpusItemRecord {
  /** 词条唯一标识，取归一化后的文件主名（不含扩展名） */
  id: string;
  /** 音频相对路径（相对于项目根目录） */
  audioRelPath: string;
  /** 对应的 TextGrid 相对路径（未落盘时为预期写入路径） */
  tgRelPath: string;
  /** 磁盘或本地缓存中是否已存在对应的 TextGrid */
  hasTextGrid: boolean;
  /** 标注状态：未标 / 已完成 / 存疑 / 需重录 */
  status: CorpusItemStatus;
  /** 音频时长（秒），未探测时为 null */
  duration: number | null;
  /** 展示名（从文件名提取或来自字表元数据） */
  label: string;
  /** 目标层已标音标或文本摘要 */
  ipaPreview: string;
  /** 词条备注 */
  note: string;
  /** 最近更新时间戳（毫秒），未更新为 0 */
  updatedAt: number;
  /** 磁盘上是否已缺失对应音频文件 */
  missing?: boolean;
  /** 预留给字表导入的附加列信息 */
  meta?: Record<string, string>;
}

export interface CorpusProjectItemPersisted {
  audioRelPath: string;
  tgRelPath: string;
  status: CorpusItemStatus;
  duration: number | null;
  label?: string;
  ipaPreview?: string;
  note?: string;
  updatedAt?: number;
  missing?: boolean;
  meta?: Record<string, string>;
}

export interface CorpusWordListMeta {
  sourceFile: string;
  idColumn: string;
  displayColumns: string[];
}

export interface CorpusOptions {
  /** 切入词条后自动播放当前选段 */
  autoPlay: boolean;
  /** 打开无 TextGrid 的音频时自动按静音切分 */
  autoVad: boolean;
  /** 默认自动聚焦与摘要提取的目标层索引 */
  targetTierIndex: number;
}

export interface CorpusProjectFile {
  schemaVersion: 1;
  projectName: string;
  updatedAt: string;
  defaultSaveFormat?: TextGridFormat;
  tierTemplate: CorpusTierTemplateItem[];
  activeItemId: string | null;
  options?: Partial<CorpusOptions>;
  wordListMeta?: CorpusWordListMeta;
  items: Record<string, CorpusProjectItemPersisted>;
}

export interface CorpusFilterState {
  query: string;
  status: 'all' | CorpusItemStatus;
}

export type CorpusSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export type CorpusWorkspaceMode = 'tauri' | 'web-fsa' | 'web-fallback';

export interface CorpusProjectState {
  /** 运行时项目 ID，用于关联工作区适配器与音频 LRU 缓存 */
  projectId: string;
  /** 根目录唯一键（用于避免重复打开同一文件夹） */
  rootKey: string;
  /** 项目名称（通常为文件夹名） */
  projectName: string;
  /** 当前工作区是否可直接静默写回本地磁盘 */
  writable: boolean;
  /** 只读或沙盒降级模式下的简明说明 */
  readOnlyReason?: string;
  /** 默认保存 TextGrid 格式 */
  defaultSaveFormat: TextGridFormat;
  /** 新建 TextGrid 时的层结构模板 */
  tierTemplate: CorpusTierTemplateItem[];
  /** 按顺序排列的全部词条列表 */
  items: CorpusItemRecord[];
  /** 按 id 索引的词条快速查询表 */
  itemMap: Record<string, CorpusItemRecord>;
  /** 当前激活词条的 id */
  activeItemId: string | null;
  /** 列表搜索与状态筛选条件 */
  filter: CorpusFilterState;
  /** 工作区行为选项 */
  options: CorpusOptions;
  /** 左侧词条列表是否展开 */
  sidebarOpen: boolean;
  /** 左侧词条列表宽度（像素） */
  sidebarWidth: number;
  /** 尚未导出或待落盘的修改计数 */
  dirtyCount: number;
  /** 词条切换竞态保护序号 */
  loadSeq: number;
  /** 当前自动保存状态 */
  saveStatus: CorpusSaveStatus;
  /** 最近一次保存失败的错误信息 */
  lastSaveError?: string | null;
  /** 预留给字表导入的列配置 */
  wordListMeta?: CorpusWordListMeta;
}

export interface CorpusAudioCacheEntry {
  itemId: string;
  buffer: AudioBuffer;
  mono: Float32Array;
  analysis: AudioAnalysisSummary;
  lastUsed: number;
}

export interface VadSegment {
  start: number;
  end: number;
}

export const CORPUS_PROJECT_FILENAME = '.tgrid-project.json';

export const DEFAULT_CORPUS_TIER_TEMPLATE: CorpusTierTemplateItem[] = [
  { name: '字词', kind: 'intervalTier' },
  { name: '音标', kind: 'intervalTier' },
  { name: '备注', kind: 'textTier' }
];

export const DEFAULT_CORPUS_OPTIONS: CorpusOptions = {
  autoPlay: true,
  autoVad: true,
  targetTierIndex: 1
};
