export const INSTRUMENTS = [
  { id: 'grand', label: '采样大钢琴 · Salamander', kind: 'sample', description: '自然、均衡的录制钢琴声。', cutoff: 2500, brightness: 12500, gain: .65 },
  { id: 'bright-grand', label: '明亮钢琴 · 采样变体', kind: 'sample', description: '突出高频与起音，适合听清快速音符。', cutoff: 6500, brightness: 13000, gain: .62 },
  { id: 'soft-grand', label: '柔和钢琴 · 采样变体', kind: 'sample', description: '降低高频，适合安静慢练。', cutoff: 1200, brightness: 4800, gain: .60 },
  { id: 'electric', label: '柔和合成琴', kind: 'synth', description: '保留原有轻量合成音色。' },
  { id: 'epiano', label: '电钢琴 · 合成', kind: 'synth', description: '较圆润的基音与短促的金属泛音。' },
  { id: 'organ', label: '管风琴 · 合成', kind: 'synth', description: '按住时持续发声，便于比较各音松键时间。' },
  { id: 'bell', label: '钟琴 · 合成', kind: 'synth', description: '清脆的非整数泛音，自然衰减。' },
] as const;
export type InstrumentId = typeof INSTRUMENTS[number]['id'];
export function instrumentDefinition(value: unknown) { return INSTRUMENTS.find(item => item.id === value) ?? INSTRUMENTS[0]; }
