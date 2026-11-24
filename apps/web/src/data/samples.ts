import type { TextGrid } from '../bridge/types';

export interface BuiltinSample {
  id: 'dialogue' | 'poem' | 'edge' | 'wild' | 'blank';
  label: string;
  tg: TextGrid;
  audioUrl?: string;
  audioName?: string;
}

export function createSample(id: BuiltinSample['id']): BuiltinSample {
  if (id === 'dialogue') {
    return {
      id: 'dialogue',
      label: '双人对话与声谱（含录音）',
      audioUrl: './samples/two_speaker_dialogue.wav',
      audioName: 'two_speaker_dialogue.wav',
      tg: {
        name: 'two_speaker_dialogue.TextGrid',
        xmin: 0,
        xmax: 10.56,
        tiers: [
          {
            kind: 'intervalTier',
            name: '说话人甲',
            xmin: 0,
            xmax: 10.56,
            intervals: [
              { xmin: 0, xmax: 0.215, text: '' },
              { xmin: 0.215, xmax: 0.48, text: '喂？' },
              { xmin: 0.48, xmax: 1.16, text: '' },
              { xmin: 1.16, xmax: 1.73, text: '听得到吗？' },
              { xmin: 1.73, xmax: 6.585, text: '' },
              { xmin: 6.585, xmax: 7.79, text: '是卷舌的 "shī"！' },
              { xmin: 7.79, xmax: 8.14, text: '' },
              { xmin: 8.14, xmax: 8.77, text: '别搞混啦。' },
              { xmin: 8.77, xmax: 10.56, text: '' }
            ],
            points: []
          },
          {
            kind: 'intervalTier',
            name: '说话人乙',
            xmin: 0,
            xmax: 10.56,
            intervals: [
              { xmin: 0, xmax: 2.51, text: '' },
              { xmin: 2.51, xmax: 2.915, text: '听得到！' },
              { xmin: 2.915, xmax: 3.385, text: '' },
              { xmin: 3.385, xmax: 3.485, text: '哎，' },
              { xmin: 3.485, xmax: 3.715, text: '' },
              { xmin: 3.715, xmax: 5.025, text: '刚才那个词是念 "shī"' },
              { xmin: 5.025, xmax: 5.21, text: '' },
              { xmin: 5.21, xmax: 5.74, text: '还是 "sī"？' },
              { xmin: 5.74, xmax: 9.39, text: '' },
              { xmin: 9.39, xmax: 9.795, text: '（轻笑）呵哼，' },
              { xmin: 9.795, xmax: 9.995, text: '' },
              { xmin: 9.995, xmax: 10.3, text: '明白！' },
              { xmin: 10.3, xmax: 10.56, text: '' }
            ],
            points: []
          },
          {
            kind: 'intervalTier',
            name: '音标对照',
            xmin: 0,
            xmax: 10.56,
            intervals: [
              { xmin: 0, xmax: 0.215, text: '' },
              { xmin: 0.215, xmax: 0.48, text: 'uei\\-3\\-5' },
              { xmin: 0.48, xmax: 1.16, text: '' },
              { xmin: 1.16, xmax: 1.73, text: 't\\^hi\\ng t\\sw t\\asu m\\sw' },
              { xmin: 1.73, xmax: 2.51, text: '' },
              { xmin: 2.51, xmax: 2.915, text: 't\\^hi\\ng t\\sw t\\asu' },
              { xmin: 2.915, xmax: 3.385, text: '' },
              { xmin: 3.385, xmax: 3.485, text: 'ai' },
              { xmin: 3.485, xmax: 3.715, text: '' },
              { xmin: 3.715, xmax: 4.44, text: 'k\\as\\ng ts\\^hai n\\sw k\\sw ts\\^hɿ \\s.ɿ' },
              { xmin: 4.44, xmax: 5.025, text: '\\s.ɿ\\-5' },
              { xmin: 5.025, xmax: 5.21, text: '' },
              { xmin: 5.21, xmax: 5.545, text: 'xai \\s.ɿ' },
              { xmin: 5.545, xmax: 5.74, text: 'sɿ\\-5' },
              { xmin: 5.74, xmax: 6.585, text: '' },
              { xmin: 6.585, xmax: 7.240413, text: '\\s.ɿ tɕɥɛn \\s.\\sw t\\sw' },
              { xmin: 7.240413, xmax: 7.79, text: '\\s.ɿ\\-5' },
              { xmin: 7.79, xmax: 8.14, text: '' },
              { xmin: 8.14, xmax: 8.77, text: 'pjɛ k\\asu xu\\swn l\\sw' },
              { xmin: 8.77, xmax: 9.39, text: '' },
              { xmin: 9.39, xmax: 9.795, text: 'x\\sw x\\sw\\ng' },
              { xmin: 9.795, xmax: 9.995, text: '' },
              { xmin: 9.995, xmax: 10.3, text: 'mi\\ng pai' },
              { xmin: 10.3, xmax: 10.56, text: '' }
            ],
            points: []
          },
          {
            kind: 'textTier',
            name: '声学事件',
            xmin: 0,
            xmax: 10.56,
            intervals: [],
            points: [
              { number: 0.215, mark: '甲起音' },
              { number: 2.51, mark: '乙高音回应' },
              { number: 4.44, mark: '卷舌擦音 ʂ' },
              { number: 5.545, mark: '平舌擦音 s' },
              { number: 6.585, mark: '甲接话' },
              { number: 7.240413, mark: '重音焦点' },
              { number: 9.39, mark: '轻笑起音' },
              { number: 10.29, mark: '句末降调' }
            ]
          },
          {
            kind: 'textTier',
            name: '备注',
            xmin: 0,
            xmax: 10.56,
            intervals: [],
            points: []
          }
        ]
      }
    };
  }

  if (id === 'poem') {
    return {
      id: 'poem',
      label: '普通话与音标示例',
      tg: {
        name: '春眠示例.TextGrid',
        xmin: 0,
        xmax: 3.2,
        tiers: [
          {
            kind: 'intervalTier',
            name: '句子',
            xmin: 0,
            xmax: 3.2,
            intervals: [
              { xmin: 0, xmax: 0.24, text: '' },
              { xmin: 0.24, xmax: 2.86, text: '春眠不觉晓，处处闻啼鸟。' },
              { xmin: 2.86, xmax: 3.2, text: '' }
            ],
            points: []
          },
          {
            kind: 'intervalTier',
            name: '词语',
            xmin: 0,
            xmax: 3.2,
            intervals: [
              { xmin: 0, xmax: 0.24, text: '' },
              { xmin: 0.24, xmax: 0.88, text: '春眠' },
              { xmin: 0.88, xmax: 1.62, text: '不觉晓' },
              { xmin: 1.62, xmax: 1.84, text: '' },
              { xmin: 1.84, xmax: 2.28, text: '处处' },
              { xmin: 2.28, xmax: 2.86, text: '闻啼鸟' },
              { xmin: 2.86, xmax: 3.2, text: '' }
            ],
            points: []
          },
          {
            kind: 'intervalTier',
            name: '音素',
            xmin: 0,
            xmax: 3.2,
            intervals: [
              { xmin: 0, xmax: 0.24, text: '' },
              { xmin: 0.24, xmax: 0.31, text: 'tʂʰ' },
              { xmin: 0.31, xmax: 0.56, text: 'uən' },
              { xmin: 0.56, xmax: 0.65, text: 'm' },
              { xmin: 0.65, xmax: 0.88, text: 'jɛn' },
              { xmin: 0.88, xmax: 0.92, text: 'p' },
              { xmin: 0.92, xmax: 1.08, text: 'u' },
              { xmin: 1.08, xmax: 1.15, text: 'tɕ' },
              { xmin: 1.15, xmax: 1.34, text: 'ɥɛ' },
              { xmin: 1.34, xmax: 1.42, text: 'ɕ' },
              { xmin: 1.42, xmax: 1.62, text: 'jɑu' },
              { xmin: 1.62, xmax: 1.84, text: '' },
              { xmin: 1.84, xmax: 1.91, text: 'tʂʰ' },
              { xmin: 1.91, xmax: 2.06, text: 'u' },
              { xmin: 2.06, xmax: 2.12, text: 'tʂʰ' },
              { xmin: 2.12, xmax: 2.28, text: 'u' },
              { xmin: 2.28, xmax: 2.46, text: 'uən' },
              { xmin: 2.46, xmax: 2.51, text: 'tʰ' },
              { xmin: 2.51, xmax: 2.64, text: 'i' },
              { xmin: 2.64, xmax: 2.71, text: 'n' },
              { xmin: 2.71, xmax: 2.86, text: 'jɑu' },
              { xmin: 2.86, xmax: 3.2, text: '' }
            ],
            points: []
          },
          {
            kind: 'textTier',
            name: '韵律',
            xmin: 0,
            xmax: 3.2,
            intervals: [],
            points: [
              { number: 0.56, mark: 'H*' },
              { number: 1.62, mark: 'B2' },
              { number: 2.28, mark: 'L-H' },
              { number: 2.86, mark: 'L%' }
            ]
          }
        ]
      }
    };
  }

  if (id === 'edge') {
    return {
      id: 'edge',
      label: '完整字符与边界示例',
      tg: {
        name: '完整字符与边界.TextGrid',
        xmin: 0,
        xmax: 2.92,
        tiers: [
          {
            kind: 'intervalTier',
            name: 'utt',
            xmin: 0,
            xmax: 2.92,
            intervals: [
              { xmin: 0, xmax: 2.5, text: 'hello "world"\nline 2' },
              { xmin: 2.5, xmax: 2.92, text: '' }
            ],
            points: []
          },
          {
            kind: 'intervalTier',
            name: 'wrd',
            xmin: 0,
            xmax: 2.786625,
            intervals: [
              { xmin: 0, xmax: 0.8, text: 'hello' },
              { xmin: 0.8, xmax: 1.5, text: 'world' },
              { xmin: 1.5, xmax: 2.5, text: 'line 2' },
              { xmin: 2.5, xmax: 2.786625, text: '' }
            ],
            points: []
          },
          {
            kind: 'intervalTier',
            name: 'phn',
            xmin: 0,
            xmax: 2.92,
            intervals: [
              { xmin: 0, xmax: 0.04, text: 'h' },
              { xmin: 0.04, xmax: 0.8, text: '\\swl\\o~' },
              { xmin: 0.8, xmax: 1.5, text: 'wɜːld' },
              { xmin: 1.5, xmax: 2.5, text: ' ' },
              { xmin: 2.5, xmax: 2.92, text: '' }
            ],
            points: []
          },
          {
            kind: 'textTier',
            name: 'ToBI',
            xmin: 0,
            xmax: 2.92,
            intervals: [],
            points: [
              { number: 0.42, mark: 'H*' },
              { number: 0.8, mark: 'L-' },
              { number: 2.1, mark: '' }
            ]
          }
        ]
      }
    };
  }

  if (id === 'wild') {
    return {
      id: 'wild',
      label: '长停顿与特殊结构示例',
      tg: {
        name: '特殊结构示例.TextGrid',
        xmin: -0.2,
        xmax: 6.4,
        tiers: [
          {
            kind: 'intervalTier',
            name: '话轮',
            xmin: -0.2,
            xmax: 6.4,
            intervals: [
              { xmin: -0.2, xmax: 0.1, text: '' },
              { xmin: 0.1, xmax: 1.45, text: '前段正常发音，含尾部空格 ' },
              { xmin: 1.45, xmax: 4.85, text: '' },
              { xmin: 4.85, xmax: 6.1, text: '长停顿之后的续段文本' },
              { xmin: 6.1, xmax: 6.4, text: '' }
            ],
            points: []
          },
          {
            kind: 'intervalTier',
            name: '重叠与空隙',
            xmin: -0.2,
            xmax: 6.4,
            intervals: [
              { xmin: 0.1, xmax: 0.95, text: '片段甲' },
              { xmin: 0.65, xmax: 1.45, text: '重叠片段乙' },
              { xmin: 4.85, xmax: 4.85, text: '0s' },
              { xmin: 5.1, xmax: 6.1, text: '缝隙后片段' }
            ],
            points: []
          },
          { kind: 'textTier', name: '空点层', xmin: -0.2, xmax: 6.4, intervals: [], points: [] },
          {
            kind: 'textTier',
            name: '事件点',
            xmin: -0.2,
            xmax: 6.4,
            intervals: [],
            points: [
              { number: 0.65, mark: '吸气' },
              { number: 0.653, mark: '微小偏移' },
              { number: 5.1, mark: '起音' }
            ]
          }
        ]
      }
    };
  }

  return {
    id: 'blank',
    label: '新建空白文件',
    tg: {
      name: '未命名.TextGrid',
      xmin: 0,
      xmax: 4,
      tiers: [
        {
          kind: 'intervalTier',
          name: '层 1',
          xmin: 0,
          xmax: 4,
          intervals: [{ xmin: 0, xmax: 4, text: '' }],
          points: []
        },
        { kind: 'textTier', name: '标记', xmin: 0, xmax: 4, intervals: [], points: [] }
      ]
    }
  };
}
