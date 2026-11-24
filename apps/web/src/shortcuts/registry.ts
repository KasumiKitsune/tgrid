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
  scope?: ShortcutScope;
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
    title: '播放与二维导航',
    subtitle: '只读 & 编辑双模式通用',
    entries: [
      {
        id: 'play-toggle',
        keys: ['Space'],
        label: '播放 / 暂停',
        scope: 'all'
      },
      {
        id: 'play-stop-reset',
        keys: ['Shift+Space'],
        label: '停止并归位播放头',
        description: '按选区起点 → 视图起点 → 全篇起点顺序归位',
        scope: 'all'
      },
      {
        id: 'replay-selection',
        keys: ['R', 'Alt+P', 'F4'],
        label: '重播当前区间或选区',
        description: '输入框内按 Alt+P 或 F4 同样可边打字边听辨',
        scope: 'input'
      },
      {
        id: 'replay-context',
        keys: ['Shift+R', 'Alt+Shift+P', 'Shift+F4'],
        label: '带语境重播（±250 ms）',
        description: '前后各扩展 250 ms，便于辨听短辅音',
        scope: 'input'
      },
      {
        id: 'loop-toggle',
        keys: ['L'],
        label: '开关循环播放',
        scope: 'all'
      },
      {
        id: 'seek-step',
        keys: [',', '.'],
        label: '播放头后退 / 前进 100 ms',
        description: '加 Alt 精细步进 ±10 ms',
        scope: 'all'
      },
      {
        id: 'rate-step',
        keys: ['<', '>'],
        label: '降低 / 提高播放倍速',
        description: '档位 0.5× / 0.75× / 1.0× / 1.25× / 1.5×',
        scope: 'all'
      },
      {
        id: 'nav-horizontal',
        keys: ['←', '→'],
        label: '同层前 / 后一项',
        description: '从边界或时间列按方向键切入相邻区间，并同步选区',
        scope: 'all'
      },
      {
        id: 'nav-vertical',
        keys: ['↑', '↓'],
        label: '按时间对齐跳转上 / 下一层',
        scope: 'all'
      },
      {
        id: 'nav-tab',
        keys: ['Tab', 'Shift+Tab'],
        label: '下一格 / 上一格',
        description: '原地编辑时自动提交并进入相邻格',
        scope: 'input'
      },
      {
        id: 'nav-empty',
        keys: ['N', 'Shift+N'],
        label: '跳至下一个 / 上一个空白区间',
        description: '快速逐格补录未标注区间',
        scope: 'all'
      },
      {
        id: 'nav-home-end',
        keys: ['Home', 'End'],
        label: '本层首项 / 末项',
        description: 'Mod+Home / Mod+End 跳至全篇起点 / 终点',
        scope: 'all'
      },
      {
        id: 'locate-playhead',
        keys: ['G'],
        label: '定位到播放头并选中所在区间',
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
        scope: 'edit'
      },
      {
        id: 'tap-split-all-tiers',
        keys: ['Shift+B'],
        label: '在播放头时刻向全部区间层同步落边界',
        description: '单步可撤销',
        scope: 'edit'
      },
      {
        id: 'split-mid',
        keys: ['S'],
        label: '从当前选中区间正中点切分',
        scope: 'edit'
      },
      {
        id: 'add-point-playhead',
        keys: ['P'],
        label: '在播放头时刻向活跃点层添加标点',
        description: '暂停时自动进入编辑，播放中静默打点',
        scope: 'edit'
      },
      {
        id: 'create-from-playrange',
        keys: ['I'],
        label: '按当前选区在活跃空区间内创建区间',
        description: '语谱图框选后可直接按 I 落区间',
        scope: 'edit'
      },
      {
        id: 'select-interval-edge',
        keys: ['[', ']'],
        label: '选中当前区间的左边界 / 右边界',
        scope: 'edit'
      }
    ]
  },
  {
    id: 'editing-delete',
    title: '文本编辑、删除语义与音标',
    subtitle: '编辑模式 · 首次删内容，再按或加 Shift 删结构',
    entries: [
      {
        id: 'inline-edit',
        keys: ['Enter', 'F2'],
        label: '打开原地编辑（区间 / 标点 / 层名）',
        description: '只读态按 Enter 直接播放当前选中项',
        scope: 'all'
      },
      {
        id: 'delete-gentle',
        keys: ['Backspace', 'Delete'],
        label: '温和删除（有字先清空；空区间删左/右界）',
        description: '边界：删本层边界；标点：删点并选前/后一点；整层：安全忽略',
        scope: 'edit'
      },
      {
        id: 'delete-structural',
        keys: ['Shift+Backspace', 'Shift+Delete'],
        label: '强力删除（清字并删左/右界；跨层删界）',
        description: '边界/时间列：跨层删除全部对齐边界；整层 Shift+Delete：删除整层（可撤销）',
        scope: 'edit'
      },
      {
        id: 'merge-preserve',
        keys: ['M', 'Shift+M'],
        label: '保留文本向右 / 向左合并相邻区间',
        scope: 'edit'
      },
      {
        id: 'clipboard-text',
        keys: ['Mod+C', 'Mod+X', 'Mod+V'],
        label: '复制 / 剪切 / 粘贴选中文本',
        description: 'Mod+Shift+C 复制区间起止时间或声学 TSV',
        scope: 'edit'
      },
      {
        id: 'undo-redo',
        keys: ['Mod+Z', 'Mod+Shift+Z', 'Mod+Y'],
        label: '撤销 / 重做',
        description: '提示具体撤销或重做的操作名称',
        scope: 'edit'
      },
      {
        id: 'ipa-cycle',
        keys: ['Mod+\\', 'Alt+I'],
        label: '循环切换音标输入模式（关 / 云龙 / Praat）',
        description: '输入框内同样有效',
        scope: 'input'
      },
      {
        id: 'ipa-dock-toggle',
        keys: ['Alt+K'],
        label: '显示 / 隐藏虚拟音标键盘',
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
        scope: 'edit'
      },
      {
        id: 'nudge-1ms',
        keys: ['Shift+Alt+←', 'Shift+Alt+→'],
        label: '超精微调 ±1 ms',
        scope: 'edit'
      },
      {
        id: 'nudge-shared',
        keys: ['Mod+Shift+←', 'Mod+Shift+→'],
        label: '跨层联动平移对齐边界（±10 ms）',
        description: '加 Alt 为 ±1 ms 超精跨层平移',
        scope: 'edit'
      },
      {
        id: 'snap-zero-crossing',
        keys: ['Z'],
        label: '将选中边界 / 时间列吸附至最近过零点',
        description: '拖拽中按住 Z 保持实时过零点吸附',
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
        scope: 'all'
      },
      {
        id: 'zoom-focus',
        keys: ['F', 'Shift+F'],
        label: '局部放大到选中项或选区 / 恢复全长',
        scope: 'all'
      },
      {
        id: 'canvas-zoom',
        keys: ['Mod+=', 'Mod+-', 'Mod+0'],
        label: '画布横向放大 / 缩小 / 复位',
        scope: 'all'
      },
      {
        id: 'scale-wrap-toggle',
        keys: ['V', 'W'],
        label: '切换自适应/线性比例 · 切换自动折行/单行',
        scope: 'all'
      },
      {
        id: 'sidebar-toggle',
        keys: ['Mod+B'],
        label: '展开 / 收起右侧任务窗格',
        scope: 'all'
      },
      {
        id: 'sidebar-tabs',
        keys: ['Alt+1', 'Alt+2', 'Alt+3'],
        label: '直达右侧 属性 / 层级 / 设置 页',
        scope: 'all'
      },
      {
        id: 'legend-toggle',
        keys: ['Alt+L'],
        label: '开关底部图例栏',
        scope: 'all'
      }
    ]
  },
  {
    id: 'file-tabs-help',
    title: '文件、标签页、帮助与逐层 Esc',
    subtitle: '文档流转与安全退栈',
    entries: [
      {
        id: 'open-files',
        keys: ['Mod+O', 'Mod+Shift+O'],
        label: '打开标注文件 / 载入配套录音',
        scope: 'all'
      },
      {
        id: 'save-files',
        keys: ['Mod+S', 'Mod+Shift+S'],
        label: '保存 / 另存为 TextGrid',
        description: '输入框内触发时自动先提交当前文本',
        scope: 'input'
      },
      {
        id: 'find-replace',
        keys: ['Mod+F', 'Mod+H'],
        label: '跨层查找 / 查找并替换',
        scope: 'all'
      },
      {
        id: 'export-figure',
        keys: ['Mod+P', 'Mod+Shift+E'],
        label: '打开导出插图工作台',
        scope: 'all'
      },
      {
        id: 'tab-manage',
        keys: ['Mod+T', 'Mod+W', 'Mod+1..9'],
        label: '新建标签 / 关闭标签 / 跳转指定标签',
        scope: 'all'
      },
      {
        id: 'shortcuts-modal',
        keys: ['?', 'Mod+/', 'F1'],
        label: '打开快捷键与交互速查表',
        scope: 'all'
      },
      {
        id: 'layered-escape',
        keys: ['Esc'],
        label: '逐层退栈取消',
        description: '音标候选 → 取消拖拽 → 顶层弹窗/菜单 → 输入框失焦 → 清选区 → 清选中项',
        scope: 'all'
      }
    ]
  }
];

export const MOUSE_GESTURE_TIPS: MouseGestureTip[] = [
  {
    id: 'drag-empty-create',
    gesture: '拖拽空白区间',
    label: '划选新建区间',
    description: '悬停与拖拽全程实时跨层磁吸，双端琥珀贯通线标明对齐来源层',
    scope: 'edit'
  },
  {
    id: 'shift-click-split',
    gesture: 'Shift + 单击区间',
    label: '磁吸切分区间',
    description: '自动吸附跨层边界或选区线，保持 IEEE-754 浮点精确一致',
    scope: 'edit'
  },
  {
    id: 'alt-bypass-snap',
    gesture: '按住 Alt 拖拽',
    label: '临时禁用磁吸自由定位',
    description: '同时关闭跨层磁吸与端贴吸附',
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
    id: 'alt-click-audition',
    gesture: 'Alt + 单击 / 中键单击',
    label: '编辑态零切换直接试听',
    description: '无需切回只读模式即可听辨任意区间',
    scope: 'edit'
  },
  {
    id: 'mod-wheel-zoom',
    gesture: 'Mod + 滚轮',
    label: '以指针为锚点平滑缩放画布',
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
    label: '独显（Solo）当前层 / 恢复全部显示',
    scope: 'all'
  },
  {
    id: 'context-menu-actions',
    gesture: '右键区间 / 边界 / 语谱图',
    label: '打开专属上下文菜单',
    description: '支持等分为 N 段、边界/区间跨层投射、过零吸附与选区导出',
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
