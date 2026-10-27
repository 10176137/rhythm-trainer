import type { PracticeModeId } from '../types/practice';

export interface ModeDefinition {
  id: PracticeModeId;
  title: string;
  subtitle: string;
  description: string;
  icon: string;
  requiresScore: boolean;
  requiresMidi: boolean;
  supportsHandSelection: boolean;
  supportsLiveFeedback: boolean;
  category: '基础技能' | '演奏能力' | '自由练习';
}

export const modeRegistry: Record<PracticeModeId, ModeDefinition> = {
  rhythm: {
    id: 'rhythm', title: '节奏训练', subtitle: '拍点与时值',
    description: '聚焦拍点偏差、节奏比例与稳定性。', icon: '◷',
    requiresScore: true, requiresMidi: true, supportsHandSelection: true,
    supportsLiveFeedback: true, category: '基础技能',
  },
  score: {
    id: 'score', title: '正常曲目演奏', subtitle: '按曲谱、固定时间判定',
    description: '选择现有曲目，按正常乐谱演奏；系统按固定时间判定节奏、音高与时值。', icon: '♫',
    requiresScore: true, requiresMidi: true, supportsHandSelection: true,
    supportsLiveFeedback: true, category: '基础技能',
  },
  'fixed-line': {
    id: 'fixed-line', title: '固定判定线节奏练习', subtitle: '音符到达判定线时演奏',
    description: '单行大谱表向左滚动，音符到达固定判定线时演奏；专注节奏与时值。', icon: '▶',
    requiresScore: true, requiresMidi: true, supportsHandSelection: true,
    supportsLiveFeedback: true, category: '基础技能',
  },
  'reading-free': {
    id: 'reading-free', title: '自由识谱', subtitle: '81 键 · 不限时',
    description: '不限时识别目标音符：弹出当前题目的全部目标琴键后进入下一题，不按反应速度评分。',
    icon: '◈', requiresScore: false, requiresMidi: true, supportsHandSelection: false,
    supportsLiveFeedback: true, category: '基础技能',
  },
  'reading-rhythm': {
    id: 'reading-rhythm', title: '节奏识谱', subtitle: '81 键 · 判定线',
    description: '按乐谱、拍号和速度演奏；系统评价音高、起音时间、按键时长与同时起音准确性。',
    icon: '◈', requiresScore: false, requiresMidi: true, supportsHandSelection: false,
    supportsLiveFeedback: true, category: '基础技能',
  },
  hands: {
    id: 'hands', title: '分手练习', subtitle: '单手到双手',
    description: '隔离左右手难点，再逐步回到双手合奏。', icon: 'Ⅱ',
    requiresScore: true, requiresMidi: true, supportsHandSelection: true,
    supportsLiveFeedback: true, category: '演奏能力',
  },
  loop: {
    id: 'loop', title: '乐句循环', subtitle: '局部重复攻克',
    description: '圈选小节并循环练习，可为后续自动提速留出扩展位。', icon: '↻',
    requiresScore: true, requiresMidi: true, supportsHandSelection: true,
    supportsLiveFeedback: true, category: '演奏能力',
  },
  free: {
    id: 'free', title: '自由弹奏', subtitle: '记录，不强制对谱',
    description: '采集 MIDI 演奏事件，为之后的回放与表达分析做准备。', icon: '⌁',
    requiresScore: false, requiresMidi: true, supportsHandSelection: false,
    supportsLiveFeedback: false, category: '自由练习',
  },
};

export const modeList = Object.values(modeRegistry);
