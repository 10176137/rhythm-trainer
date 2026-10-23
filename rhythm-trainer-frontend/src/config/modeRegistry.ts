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
    id: 'score', title: '乐谱跟练', subtitle: '跟随乐谱演奏',
    description: '在乐谱上定位当前音符，并在演奏时给出即时反馈。', icon: '♫',
    requiresScore: true, requiresMidi: true, supportsHandSelection: true,
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
