'use strict';

// Demo: does the engine distinguish quarter notes from eighth notes?
// It never classifies note values — it scores onsets against a tick-derived
// target grid. But playing the wrong density shows up immediately:
//   - quarters played against an eighth-note score  -> the off-beat eighths become Miss
//   - eighths played against a quarter-note score   -> the extra off-beats become Extra
// Run: node examples/note-value-demo.mjs   (build the addon first)

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildSchedule, NativeSession } = require('../bindings/node');

const atoms = (count, tickStep) => Array.from({ length: count }, (_, i) => ({
  startTick: i * tickStep,
  durationTicks: tickStep,
  kind: 'note',
  bar: 1,
  beat: 1 + i * (tickStep / 960),
}));

const QUARTER = 750;  // 80 BPM quarter in ms
const T = (i, step) => 3000 + i * step;  // count-in 4 beats = 3000 ms

function report(name, atomsList, hits) {
  const targets = buildSchedule({ id: name, ticksPerQuarter: 960, atoms: atomsList }, 80, 3000, 'standard');
  const times = targets.map((t) => Math.round(t.atMs));
  const windows = targets.map((t) => `±${Math.round(t.goodWindowMs)}`);
  const session = new NativeSession(targets, 512, 80);
  session.start();
  for (const hit of hits) session.pushHit(hit);
  session.processPending();
  const last = targets[targets.length - 1];
  session.advance(last.atMs + 500);
  const replay = session.finish();
  const counts = { perfect: 0, good: 0, miss: 0, extra: 0 };
  for (const j of replay.judgments) counts[j.grade] += 1;
  console.log(`\n【${name}】`);
  console.log(`  目标时间: ${times.join(', ')} ms`);
  console.log(`  有效窗口: ${windows.join(', ')}`);
  console.log(`  演奏输入: ${hits.length ? hits.map((h) => Math.round(h.atMs)).join(', ') : '(无)'} ms`);
  console.log(`  引擎判定: Perfect ${counts.perfect} · Good ${counts.good} · Miss ${counts.miss} · Extra ${counts.extra}`);
  return { targets, counts };
}

// 谱面一：四分音符 ×4（80 BPM → 每 750ms 一个目标）
const quarterScore = atoms(4, 960);
// 谱面二：八分音符 ×8（480 tick → 每 375ms 一个目标）
const eighthScore = atoms(8, 480);

// 情景 A：谱面是八分，你只弹四分密度（每 750ms 一下）
const quarterPulses = Array.from({ length: 4 }, (_, i) => ({
  seq: i + 1, atMs: T(i, QUARTER), source: 'keyboard', notes: [60],
}));
const a = report('谱面=八分×8，演奏=四分密度×4', eighthScore, quarterPulses);

// 情景 B：谱面是四分，你弹成八分密度（每 375ms 一下）
const eighthPulses = Array.from({ length: 8 }, (_, i) => ({
  seq: i + 1, atMs: T(0, 0) + i * (QUARTER / 2), source: 'keyboard', notes: [60],
}));
const b = report('谱面=四分×4，演奏=八分密度×8', quarterScore, eighthPulses);

// 情景 C：谱面八分、演奏八分，全部对上
const correctEighths = Array.from({ length: 8 }, (_, i) => ({
  seq: i + 1, atMs: T(i, QUARTER / 2) + 8, source: 'keyboard', notes: [60],
}));
const c = report('谱面=八分×8，演奏=八分×8（+8ms）', eighthScore, correctEighths);

console.log('\n结论：');
console.log(' - 引擎按 tick 展开目标网格：四分目标间隔 750ms，八分 375ms，密度一望而知。');
console.log(' - 弹错密度立刻现形：少弹一半 → ' + a.counts.miss + ' 个 Miss；多弹一半 → ' + b.counts.extra + ' 个 Extra。');
console.log(' - 八分段落窗口自动收窄（0.45×间隔），密集段容差更小，这是设计行为。');
console.log(' - 引擎不「认音符时值」：它对齐起音，不分类音符，也暂不评按键时长（Note Off 判定属后续里程碑）。');
