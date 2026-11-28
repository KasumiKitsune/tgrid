import type React from 'react';
import type { IconName } from '@tgrid/icons';

export const IS_MAC: boolean =
  typeof navigator !== 'undefined' &&
  /Mac|iPod|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

export function formatKeyCombo(combo: string): string {
  return combo.replace(/\bMod\b/g, IS_MAC ? '⌘' : 'Ctrl');
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as HTMLElement;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  if (typeof el.getAttribute === 'function' && el.getAttribute('contenteditable') === 'true') {
    return true;
  }
  if (typeof el.closest === 'function' && el.closest('[contenteditable="true"]')) {
    return true;
  }
  return false;
}

export function isComposingEvent(e: {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  return Boolean(
    e.isComposing ||
      e.keyCode === 229 ||
      e.nativeEvent?.isComposing ||
      e.nativeEvent?.keyCode === 229
  );
}

export type ShortcutScope = 'all' | 'edit' | 'read' | 'input';

export interface ShortcutEntry {
  id: string;
  keys: string[];
  label: string;
  description?: string;
  icon?: IconName;
  scope?: ShortcutScope;
  rebindable?: boolean;
}

export interface ShortcutGroup {
  id: string;
  title: string;
  subtitle?: string;
  entries: ShortcutEntry[];
}

export interface MouseGestureTip {
  id: string;
  gesture: string;
  label: string;
  description?: string;
  scope?: 'all' | 'edit' | 'read';
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: 'playback-nav',
    title: '播放与跳转导航',
    subtitle: '只读 & 编辑双模式通用',
    entries: [
      {
        id: 'play-toggle',
        keys: ['Space'],
        label: '播放 / 暂停',
        icon: 'transport-play',
        scope: 'all'
      },
      {
        id: 'play-stop-reset',
        keys: ['Shift+Space'],
        label: '停止并归位播放头',
        description: '按选区起点 → 视图起点 → 全篇起点顺序归位',
        icon: 'transport-stop',
        scope: 'all'
      },
      {
        id: 'replay-selection',
        keys: ['R', 'Alt+P', 'F4'],
        label: '重播当前区间或选区',
        description: '输入框内按 Alt+P 或 F4 同样可边打字边听辨',
        icon: 'play',
        scope: 'input'
      },
      {
        id: 'replay-context',
        keys: ['Shift+R', 'Alt+Shift+P', 'Shift+F4'],
        label: '带语境重播（±250 ms）',
        description: '前后各扩展 250 ms，便于辨听短辅音',
        icon: 'playContext',
        scope: 'input'
      },
      {
        id: 'loop-toggle',
        keys: ['L'],
        label: '开关循环播放',
        icon: 'loop',
        scope: 'all'
      },
      {
        id: 'seek-back',
        keys: [','],
        label: '播放头后退 100 ms',
        description: '加 Alt 精细后退 10 ms',
        icon: 'seekBack',
        scope: 'all'
      },
      {
        id: 'seek-forward',
        keys: ['.'],
        label: '播放头前进 100 ms',
        description: '加 Alt 精细前进 10 ms',
        icon: 'seekForward',
        scope: 'all'
      },
      {
        id: 'rate-down',
        keys: ['<'],
        label: '降低播放倍速',
        description: '档位 0.5× / 0.75× / 1.0× / 1.25× / 1.5×',
        icon: 'rateDown',
        scope: 'all'
      },
      {
        id: 'rate-up',
        keys: ['>'],
        label: '提高播放倍速',
        description: '档位 0.5× / 0.75× / 1.0× / 1.25× / 1.5×',
        icon: 'rateUp',
        scope: 'all'
      },
      {
        id: 'nav-horizontal',
        keys: ['←', '→'],
        label: '同层前 / 后一项',
        description: '从边界或时间列按方向键切入相邻区间，并同步选区',
        icon: 'navHorizontal',
        scope: 'all',
        rebindable: false
      },
      {
        id: 'nav-vertical',
        keys: ['↑', '↓'],
        label: '按时间对齐跳转上 / 下一层',
        icon: 'navVertical',
        scope: 'all',
        rebindable: false
      },
      {
        id: 'nav-tab',
        keys: ['Tab', 'Shift+Tab'],
        label: '下一格 / 上一格',
        description: '原地编辑时自动提交并进入相邻格',
        icon: 'navHorizontal',
        scope: 'input',
        rebindable: false
      },
      {
        id: 'nav-empty-next',
        keys: ['N'],
        label: '跳至下一个空白区间',
        description: '快速逐格补录未标注区间',
        icon: 'nextEmpty',
        scope: 'all'
      },
      {
        id: 'nav-empty-prev',
        keys: ['Shift+N'],
        label: '跳至上一个空白区间',
        description: '回溯上一个未标注区间',
        icon: 'prevEmpty',
        scope: 'all'
      },
      {
        id: 'nav-home-end',
        keys: ['Home', 'End'],
        label: '本层首项 / 末项',
        description: 'Mod+Home / Mod+End 跳至全篇起点 / 终点',
        icon: 'navHorizontal',
        scope: 'all',
        rebindable: false
      },
      {
        id: 'locate-playhead',
        keys: ['G'],
        label: '定位到播放头并选中所在区间',
        icon: 'locatePlayhead',
        scope: 'all'
      }
    ]
  },
  {
    id: 'creation-selection',
    title: '切分、新建与边界选取',
    subtitle: '编辑模式',
    entries: [
      {
        id: 'tap-split-playhead',
        keys: ['B'],
        label: '在播放头时刻向活跃区间层落边界',
        description: '支持边听边敲“打点切音”',
        icon: 'split',
        scope: 'edit'
      },
      {
        id: 'tap-split-all-tiers',
        keys: ['Shift+B'],
        label: '在播放头时刻向全部区间层同步落边界',
        description: '单步可撤销',
        icon: 'splitAllTiers',
        scope: 'edit'
      },
      {
        id: 'split-mid',
        keys: ['S'],
        label: '从当前选中区间正中点切分',
        icon: 'split',
        scope: 'edit'
      },
      {
        id: 'add-point-playhead',
        keys: ['P'],
        label: '在播放头时刻向活跃点层添加标点',
        description: '暂停时自动进入编辑，播放中静默打点',
        icon: 'addPointTier',
        scope: 'edit'
      },
      {
        id: 'create-from-playrange',
        keys: ['I'],
        label: '按当前选区在活跃空区间内创建区间',
        description: '语谱图框选后可直接按 I 落区间',
        icon: 'createFromRange',
        scope: 'edit'
      },
      {
        id: 'remap-block-to-playrange',
        keys: ['Shift+I'],
        label: '将选中标注块跨层重映射到当前选区',
        description: '语谱图框选真实发音后，一键平移并按比例缩放对齐层及内部子边界',
        icon: 'nudgeShared',
        scope: 'edit'
      },
      {
        id: 'select-left-edge',
        keys: ['['],
        label: '选中当前区间的左边界',
        icon: 'selectLeftEdge',
        scope: 'edit'
      },
      {
        id: 'select-right-edge',
        keys: [']'],
        label: '选中当前区间的右边界',
        icon: 'selectRightEdge',
        scope: 'edit'
      }
    ]
  },
  {
    id: 'editing-delete',
    title: '文本编辑、删除与音标',
    subtitle: '编辑模式 · 首次清空文本，再按或按住 Shift 删除边界或标点',
    entries: [
      {
        id: 'inline-edit',
        keys: ['Enter', 'F2'],
        label: '打开原地编辑（区间 / 标点 / 层名）',
        description: '只读模式按 Enter 直接播放当前选中项',
        icon: 'edit',
        scope: 'all'
      },
      {
        id: 'delete-gentle',
        keys: ['Backspace', 'Delete'],
        label: '删除文本或边界（有字先清空；空区间删左/右边界）',
        description: '选中边界时删本层边界；选中标点时删点并选相邻点；选中整层时不触发',
        icon: 'clear',
        scope: 'edit',
        rebindable: false
      },
      {
        id: 'delete-structural',
        keys: ['Shift+Backspace', 'Shift+Delete'],
        label: '直接删除（清空并删左/右边界；跨层删边界）',
        description: '选中边界或时间列时跨层删除全部对齐边界；选中整层按 Shift+Delete 删除整层（支持撤销）',
        icon: 'trash',
        scope: 'edit',
        rebindable: false
      },
      {
        id: 'merge-right',
        keys: ['M'],
        label: '保留文本向右合并相邻区间',
        icon: 'mergeRight',
        scope: 'edit'
      },
      {
        id: 'merge-left',
        keys: ['Shift+M'],
        label: '保留文本向左合并相邻区间',
        icon: 'mergeLeft',
        scope: 'edit'
      },
      {
        id: 'clipboard-text',
        keys: ['Mod+C', 'Mod+X', 'Mod+V'],
        label: '复制 / 剪切 / 粘贴选中文本',
        description: 'Mod+Shift+C 复制区间起止时间或声学 TSV',
        icon: 'copy',
        scope: 'edit',
        rebindable: false
      },
      {
        id: 'undo-redo',
        keys: ['Mod+Z', 'Mod+Shift+Z', 'Mod+Y'],
        label: '撤销 / 重做',
        description: '提示具体撤销或重做的操作名称',
        icon: 'undo',
        scope: 'edit',
        rebindable: false
      },
      {
        id: 'ipa-cycle',
        keys: ['Mod+\\', 'Alt+I'],
        label: '循环切换音标输入模式（关 / 云龙 / Praat）',
        description: '输入框内同样有效',
        icon: 'ipaMode',
        scope: 'input'
      },
      {
        id: 'ipa-temp-en',
        keys: ['Alt+E'],
        label: '临时切换英文 / 音标输入',
        description: '输入框内暂停或恢复当前音标输入方案（避开系统输入法 Shift 键）',
        icon: 'ipaToggleLang',
        scope: 'input'
      },
      {
        id: 'ipa-dock-toggle',
        keys: ['Alt+K'],
        label: '显示 / 隐藏虚拟音标键盘',
        icon: 'keyboard',
        scope: 'edit'
      }
    ]
  },
  {
    id: 'boundary-nudge',
    title: '边界与标点微调',
    subtitle: '编辑模式',
    entries: [
      {
        id: 'nudge-10ms',
        keys: ['Shift+←', 'Shift+→'],
        label: '微调选中边界 / 标点 / 时间列 ±10 ms',
        icon: 'nudgeBoundary',
        scope: 'edit',
        rebindable: false
      },
      {
        id: 'nudge-1ms',
        keys: ['Shift+Alt+←', 'Shift+Alt+→'],
        label: '超精微调 ±1 ms',
        icon: 'nudgeFine',
        scope: 'edit',
        rebindable: false
      },
      {
        id: 'nudge-shared',
        keys: ['Mod+Shift+←', 'Mod+Shift+→'],
        label: '跨层联动平移对齐边界（±10 ms）',
        description: '加 Alt 为 ±1 ms 超精跨层平移',
        icon: 'nudgeShared',
        scope: 'edit',
        rebindable: false
      },
      {
        id: 'snap-zero-crossing',
        keys: ['Z'],
        label: '将选中边界 / 时间列吸附至最近过零点',
        description: '拖拽中按住 Z 保持实时过零点吸附',
        icon: 'zeroCross',
        scope: 'edit'
      }
    ]
  },
  {
    id: 'view-zoom',
    title: '视图、缩放与模式',
    subtitle: '全局画布控制',
    entries: [
      {
        id: 'mode-toggle',
        keys: ['E'],
        label: '切换只读 / 编辑模式',
        icon: 'edit',
        scope: 'all'
      },
      {
        id: 'zoom-focus',
        keys: ['F'],
        label: '局部放大到选中项或选区',
        icon: 'zoomIn',
        scope: 'all'
      },
      {
        id: 'zoom-reset',
        keys: ['Shift+F'],
        label: '恢复全长视图',
        icon: 'zoomReset',
        scope: 'all'
      },
      {
        id: 'canvas-zoom',
        keys: ['Mod+=', 'Mod+-', 'Mod+0'],
        label: '画布放大 / 缩小 / 复位 100%',
        description: '等比缩放谱面画布（50%–200%），与底部状态栏同步，不影响界面与导出尺寸',
        icon: 'zoomIn',
        scope: 'all',
        rebindable: false
      },
      {
        id: 'canvas-pan',
        keys: ['Space + 拖拽'],
        label: '按住空格拖拽平移画布',
        description: '任意缩放比例下按住空格拖拽即可 1:1 平移视口；轻按空格仍正常播放 / 暂停',
        icon: 'navHorizontal',
        scope: 'all',
        rebindable: false
      },
      {
        id: 'scale-toggle',
        keys: ['V'],
        label: '切换自适应 / 线性比例',
        icon: 'toggleScale',
        scope: 'all'
      },
      {
        id: 'wrap-toggle',
        keys: ['W'],
        label: '切换自动折行 / 单行模式',
        icon: 'wrapToggle',
        scope: 'all'
      },
      {
        id: 'sidebar-toggle',
        keys: ['Mod+B'],
        label: '展开 / 收起右侧任务窗格',
        icon: 'sidebarToggle',
        scope: 'all'
      },
      {
        id: 'sidebar-tabs',
        keys: ['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5'],
        label: '直达 属性 / 层级 / 历史 / 画布与声学 / 悬浮条定制',
        icon: 'inspector',
        scope: 'all',
        rebindable: false
      },
      {
        id: 'legend-toggle',
        keys: ['Alt+L'],
        label: '开关底部图例栏',
        icon: 'legend',
        scope: 'all'
      }
    ]
  },
  {
    id: 'file-tabs-help',
    title: '文件、标签页、帮助与取消',
    subtitle: '文件管理与逐级取消',
    entries: [
      {
        id: 'open-files',
        keys: ['Mod+O'],
        label: '打开标注文件',
        icon: 'folder',
        scope: 'all'
      },
      {
        id: 'open-audio',
        keys: ['Mod+Shift+O'],
        label: '载入配套录音',
        icon: 'waveform',
        scope: 'all'
      },
      {
        id: 'save-file',
        keys: ['Mod+S'],
        label: '保存 TextGrid',
        description: '输入框内触发时自动先提交当前文本',
        icon: 'save',
        scope: 'input'
      },
      {
        id: 'save-as',
        keys: ['Mod+Shift+S'],
        label: '另存为 TextGrid',
        description: '输入框内触发时自动先提交当前文本',
        icon: 'saveAs',
        scope: 'input'
      },
      {
        id: 'corpus-save-all',
        keys: ['Mod+Alt+S'],
        label: '保存全部未保存词条',
        description: '词表模式下批量将全部待保存词条与项目索引写回文件夹',
        icon: 'save',
        scope: 'input'
      },
      {
        id: 'find-open',
        keys: ['Mod+F'],
        label: '跨层查找',
        icon: 'search',
        scope: 'all'
      },
      {
        id: 'replace-open',
        keys: ['Mod+H'],
        label: '跨层查找并替换',
        icon: 'replace',
        scope: 'all'
      },
      {
        id: 'export-figure',
        keys: ['Mod+P', 'Mod+Shift+E'],
        label: '打开导出插图工作台',
        icon: 'export',
        scope: 'all'
      },
      {
        id: 'tab-manage',
        keys: ['Mod+T', 'Mod+W', 'Mod+1..9'],
        label: '新建标签 / 关闭标签 / 跳转指定标签',
        icon: 'tab-add',
        scope: 'all',
        rebindable: false
      },
      {
        id: 'preferences-modal',
        keys: ['Mod+,'],
        label: '打开偏好设置中心',
        icon: 'gear',
        scope: 'all',
        rebindable: false
      },
      {
        id: 'shortcuts-modal',
        keys: ['?', 'Mod+/', 'F1'],
        label: '打开快捷键与交互速查表',
        icon: 'shortcuts',
        scope: 'all'
      },
      {
        id: 'layered-escape',
        keys: ['Esc'],
        label: '逐级取消或关闭',
        description: '依次关闭音标候选、取消拖拽、关闭弹窗或菜单、退出输入、清空选区与选中项',
        icon: 'CloseIcon',
        scope: 'all',
        rebindable: false
      }
    ]
  },
  {
    id: 'corpus-workflow',
    title: '字表项目与词条切换',
    subtitle: '打开文件夹项目时生效 · 输入框内可用',
    entries: [
      {
        id: 'corpus-done-next',
        keys: ['Alt+Enter'],
        label: '标记已完成并下一条',
        description: '标记当前词条为已完成并跳到下一条（音标候选窗未打开时也支持 Mod+Enter）',
        icon: 'check',
        scope: 'input'
      },
      {
        id: 'corpus-doubt-next',
        keys: ['Alt+M'],
        label: '标记存疑并下一条',
        description: '标记当前词条为存疑并跳到下一条',
        icon: 'warning',
        scope: 'input'
      },
      {
        id: 'corpus-trash-next',
        keys: ['Alt+X'],
        label: '标记需重录并下一条',
        description: '标记当前词条为需重录并跳到下一条',
        icon: 'trash',
        scope: 'input'
      },
      {
        id: 'corpus-replay',
        keys: ['Alt+R'],
        label: '重播当前选段',
        description: '在输入框内随时重播当前词条选段',
        icon: 'play',
        scope: 'input'
      },
      {
        id: 'corpus-prev',
        keys: ['Alt+['],
        label: '上一条词条',
        description: '暂存当前修改并切换到上一条词条',
        icon: 'seekBack',
        scope: 'input'
      },
      {
        id: 'corpus-next',
        keys: ['Alt+]'],
        label: '下一条词条',
        description: '暂存当前修改并切换到下一条词条',
        icon: 'seekForward',
        scope: 'input'
      }
    ]
  }
];

export const MOUSE_GESTURE_TIPS: MouseGestureTip[] = [
  {
    id: 'drag-empty-create',
    gesture: '拖拽空白区间',
    label: '划选新建区间',
    description: '悬停与拖拽时自动对齐其他层边界，并用橙色参考线标明对齐来源层',
    scope: 'edit'
  },
  {
    id: 'shift-click-split',
    gesture: 'Shift + 单击区间',
    label: '吸附切分区间',
    description: '自动吸附其他层边界或选区线，保证边界时间完全一致',
    scope: 'edit'
  },
  {
    id: 'alt-bypass-snap',
    gesture: '按住 Alt 拖拽',
    label: '临时关闭对齐自由定位',
    description: '临时关闭跨层对齐和边缘吸附',
    scope: 'edit'
  },
  {
    id: 'z-zero-crossing-drag',
    gesture: '按住 Z 拖拽边界',
    label: '实时吸附音频过零点',
    description: '在 ±8 ms 窗口内定位最近过零点，避免切片爆音',
    scope: 'edit'
  },
  {
    id: 'shift-drag-shared',
    gesture: 'Shift + 拖拽边界',
    label: '跨层联动平移对齐边界',
    description: '同步移动所有对齐层上该时刻的边界与标点',
    scope: 'edit'
  },
  {
    id: 'mod-click-multi-select',
    gesture: 'Mod + 单击区间',
    label: '复选多个区间（支持同层 / 跨层）',
    description: '单击可加入或取消复选，按所选位置自动提供合并、批量清空、边界对齐或同步移动；按 Esc 退出复选',
    scope: 'edit'
  },
  {
    id: 'mod-drag-block-move',
    gesture: 'Mod + 拖拽非空区间',
    label: '跨层整块平移对齐区间与子层',
    description: '连同对齐层、子区间及区间内标点同步平移，碰到相邻有字区间时自动停止',
    scope: 'edit'
  },
  {
    id: 'mod-drag-block-resize',
    gesture: 'Mod + 拖拽边界',
    label: '跨层按比例缩放（子边界同步跟随）',
    description: '固定另一侧边界拉伸或压缩整块，内部子边界按比例同步调整',
    scope: 'edit'
  },
  {
    id: 'alt-click-audition',
    gesture: 'Alt + 单击 / 中键单击',
    label: '编辑模式下直接试听',
    description: '无需切回只读模式即可听辨任意区间',
    scope: 'edit'
  },
  {
    id: 'mod-wheel-zoom',
    gesture: 'Mod + 滚轮',
    label: '以指针为中心缩放画布（50%–200%）',
    description: '与底部状态栏画布缩放同步，不破坏折行排版；按住 Alt + 滚轮可横向拉伸或收窄时间轴宽度',
    scope: 'all'
  },
  {
    id: 'space-drag-pan',
    gesture: 'Space + 拖拽',
    label: '按住空格拖拽平移画布',
    description: '放大后免滚动条自由平移画布；轻按空格仍正常播放 / 暂停',
    scope: 'all'
  },
  {
    id: 'double-click-edit',
    gesture: '双击区间 / 标点 / 层名',
    label: '快速进入原地文本编辑',
    scope: 'edit'
  },
  {
    id: 'alt-click-eye-solo',
    gesture: 'Alt + 单击层级眼睛图标',
    label: '仅显示当前层 / 恢复全部显示',
    scope: 'all'
  },
  {
    id: 'context-menu-actions',
    gesture: '右键区间 / 边界 / 语谱图',
    label: '打开右键操作菜单',
    description: '支持等分为 N 段、边界或区间复制到其他层、过零点吸附与选区导出',
    scope: 'all'
  }
];

const ENTRY_MAP = new Map<string, ShortcutEntry>();
for (const group of SHORTCUT_GROUPS) {
  for (const entry of group.entries) {
    ENTRY_MAP.set(entry.id, entry);
  }
}

export function getShortcutEntry(id: string): ShortcutEntry | undefined {
  return ENTRY_MAP.get(id);
}

export function getShortcutHint(id: string): string {
  const entry = ENTRY_MAP.get(id);
  if (!entry || entry.keys.length === 0) return '';
  return formatKeyCombo(entry.keys[0]);
}

// ============================================================================
// Rebindable Shortcut Normalization, Recording, Matching & Conflict Detection
// ============================================================================

const SHIFTED_SYMBOLS = new Set([
  '<',
  '>',
  '?',
  '!',
  '@',
  '#',
  '$',
  '%',
  '^',
  '&',
  '*',
  '(',
  ')',
  '_',
  '+',
  '{',
  '}',
  '|',
  ':',
  '"',
  '~'
]);

const IGNORED_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'OS',
  'Fn',
  'FnLock',
  'AltGraph',
  'Dead',
  'Process',
  'Unidentified'
]);

const CODE_TO_PUNCT: Record<string, [string, string]> = {
  Comma: [',', '<'],
  Period: ['.', '>'],
  Slash: ['/', '?'],
  Backslash: ['\\', '|'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  Backquote: ['`', '~']
};

function splitComboTokens(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const tokens: string[] = [];
  let i = 0;
  while (i < trimmed.length) {
    if (trimmed[i] === '+') {
      tokens.push('+');
      i++;
      if (i < trimmed.length && trimmed[i] === '+') i++;
      continue;
    }
    const nextPlus = trimmed.indexOf('+', i);
    if (nextPlus === -1) {
      tokens.push(trimmed.slice(i));
      break;
    }
    tokens.push(trimmed.slice(i, nextPlus));
    i = nextPlus + 1;
  }
  return tokens.map((t) => t.trim()).filter((t) => t.length > 0);
}

function normalizeKeyName(rawKey: string): string {
  if (!rawKey) return '';
  if (rawKey === ' ') return 'Space';
  const trimmed = rawKey.trim();
  if (!trimmed) return '';
  if (trimmed.length === 1) {
    if (/^[a-zA-Z]$/.test(trimmed)) return trimmed.toUpperCase();
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'space' || lower === 'spacebar') return 'Space';
  if (lower === 'escape' || lower === 'esc') return 'Esc';
  if (lower === 'enter' || lower === 'return') return 'Enter';
  if (lower === 'tab') return 'Tab';
  if (lower === 'backspace') return 'Backspace';
  if (lower === 'delete' || lower === 'del') return 'Delete';
  if (lower === 'arrowleft' || lower === 'left') return '←';
  if (lower === 'arrowright' || lower === 'right') return '→';
  if (lower === 'arrowup' || lower === 'up') return '↑';
  if (lower === 'arrowdown' || lower === 'down') return '↓';
  if (lower === 'home') return 'Home';
  if (lower === 'end') return 'End';
  if (lower === 'pageup') return 'PageUp';
  if (lower === 'pagedown') return 'PageDown';
  if (lower === 'insert') return 'Insert';
  const fnMatch = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(trimmed);
  if (fnMatch) return `F${fnMatch[1]}`;
  return trimmed;
}

function buildCanonicalCombo(mod: boolean, alt: boolean, shift: boolean, key: string): string {
  if (!key) return '';
  const effectiveShift = SHIFTED_SYMBOLS.has(key) ? false : shift;
  const parts: string[] = [];
  if (mod) parts.push('Mod');
  if (alt) parts.push('Alt');
  if (effectiveShift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

export function normalizeKeyCombo(combo: string): string {
  const tokens = splitComboTokens(combo);
  if (tokens.length === 0) return '';
  let mod = false;
  let alt = false;
  let shift = false;
  let mainKey = '';

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const isLast = i === tokens.length - 1;
    const lower = tok.toLowerCase();
    if (
      !isLast &&
      (lower === 'mod' ||
        lower === 'ctrl' ||
        lower === 'control' ||
        lower === 'cmd' ||
        lower === 'command' ||
        lower === 'meta' ||
        tok === '⌘')
    ) {
      mod = true;
    } else if (!isLast && (lower === 'alt' || lower === 'option' || lower === 'opt' || tok === '⌥')) {
      alt = true;
    } else if (!isLast && (lower === 'shift' || tok === '⇧')) {
      shift = true;
    } else {
      mainKey = normalizeKeyName(tok);
    }
  }

  return buildCanonicalCombo(mod, alt, shift, mainKey);
}

function resolveEventKey(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const rawKey = e.key || '';
  const code = e.code || '';
  const mod = Boolean(e.ctrlKey || e.metaKey);
  const alt = Boolean(e.altKey);
  const shift = Boolean(e.shiftKey);

  // macOS Option+Key (e.g. Option+P -> 'π', Option+I -> 'Dead') or non-Latin Alt/Mod shortcuts:
  // fall back to physical e.code before rejecting 'Dead'.
  if (alt || mod) {
    const letterCode = /^Key([A-Z])$/.exec(code);
    if (letterCode && !/^[a-zA-Z]$/.test(rawKey)) {
      return letterCode[1];
    }
    const digitCode = /^Digit([0-9])$/.exec(code);
    if (digitCode && !shift && !/^[0-9]$/.test(rawKey)) {
      return digitCode[1];
    }
    const punctPair = CODE_TO_PUNCT[code];
    if (punctPair && (rawKey === 'Dead' || rawKey === 'Process' || rawKey.charCodeAt(0) > 127)) {
      return shift ? punctPair[1] : punctPair[0];
    }
  }

  if (!rawKey || IGNORED_KEYS.has(rawKey)) {
    return null;
  }

  const normalized = normalizeKeyName(rawKey);
  return normalized || null;
}

function extractEventCombo(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const key = resolveEventKey(e);
  if (!key) return null;
  const mod = Boolean(e.ctrlKey || e.metaKey);
  const alt = Boolean(e.altKey);
  const shift = Boolean(e.shiftKey);
  return buildCanonicalCombo(mod, alt, shift, key);
}

function isReservedRecordingCombo(combo: string): boolean {
  const norm = normalizeKeyCombo(combo);
  if (!norm) return true;
  if (norm === 'Esc' || norm.endsWith('+Esc')) return true;
  if (norm === 'Tab' || norm.endsWith('+Tab')) return true;
  if (norm === 'Mod+Q') return true;
  if (norm === 'Alt+F4') return true;
  return false;
}

export function eventToKeyCombo(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const combo = extractEventCombo(e);
  if (!combo) return null;
  if (isReservedRecordingCombo(combo)) return null;
  return combo;
}

export function getEffectiveKeys(id: string, overrides?: Record<string, string[]>): string[] {
  const entry = ENTRY_MAP.get(id);
  if (!entry) return [];
  if (entry.rebindable === false) return entry.keys;
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, id)) {
    return overrides[id];
  }
  return entry.keys;
}

export function getEffectiveShortcutHint(
  id: string,
  overrides?: Record<string, string[]>
): string {
  const keys = getEffectiveKeys(id, overrides);
  if (keys.length === 0) return '';
  return formatKeyCombo(keys[0]);
}

export function isShortcutCustomized(id: string, overrides?: Record<string, string[]>): boolean {
  const entry = ENTRY_MAP.get(id);
  if (!entry || entry.rebindable === false) return false;
  if (!overrides || !Object.prototype.hasOwnProperty.call(overrides, id)) return false;
  const custom = overrides[id].map(normalizeKeyCombo).filter(Boolean);
  const defaults = entry.keys.map(normalizeKeyCombo).filter(Boolean);
  if (custom.length !== defaults.length) return true;
  for (let i = 0; i < custom.length; i++) {
    if (custom[i] !== defaults[i]) return true;
  }
  return false;
}

export function matchesKeyCombo(combo: string, e: KeyboardEvent | React.KeyboardEvent): boolean {
  const target = normalizeKeyCombo(combo);
  if (!target) return false;
  const actual = extractEventCombo(e);
  if (!actual) return false;
  return actual === target;
}

export function matchesShortcut(
  id: string,
  e: KeyboardEvent | React.KeyboardEvent,
  overrides?: Record<string, string[]>
): boolean {
  const keys = getEffectiveKeys(id, overrides);
  if (keys.length === 0) return false;
  return keys.some((k) => matchesKeyCombo(k, e));
}

function scopesOverlap(a: ShortcutScope = 'all', b: ShortcutScope = 'all'): boolean {
  if (a === 'all' || b === 'all' || a === 'input' || b === 'input') return true;
  return a === b;
}

function comboMatchesEntryKey(normCombo: string, entryKey: string): boolean {
  if (entryKey === 'Mod+1..9') {
    return /^Mod\+[1-9]$/.test(normCombo);
  }
  return normalizeKeyCombo(entryKey) === normCombo;
}

export function findShortcutConflicts(
  actionId: string,
  combo: string,
  overrides?: Record<string, string[]>
): ShortcutEntry[] {
  const normCombo = normalizeKeyCombo(combo);
  if (!normCombo) return [];
  const targetEntry = ENTRY_MAP.get(actionId);
  const targetScope: ShortcutScope = targetEntry?.scope ?? 'all';
  const conflicts: ShortcutEntry[] = [];

  for (const group of SHORTCUT_GROUPS) {
    for (const entry of group.entries) {
      if (entry.id === actionId) continue;
      if (!scopesOverlap(targetScope, entry.scope ?? 'all')) continue;
      const effKeys = getEffectiveKeys(entry.id, overrides);
      if (effKeys.some((k) => comboMatchesEntryKey(normCombo, k))) {
        conflicts.push(entry);
      }
    }
  }
  return conflicts;
}
