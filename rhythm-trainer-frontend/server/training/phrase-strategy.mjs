// Authored transformations of complete motives. Randomness chooses a variant;
// it never chooses individual pitches, chord tones, or reference fingerings.
const token = (degrees, beats) => ({ degrees, beats });
const line = (degrees, beats = 1) => degrees.map((degree) => token(degree === null ? null : [degree], beats));
const rhythm = (degrees, durations) => durations.map((beats, i) => token(degrees[i % degrees.length], beats));
const clone = (value) => structuredClone(value);

function barsOf(tokens) {
  const bars = [[]];
  let beat = 0;
  for (const note of tokens) {
    if (beat === 4) { bars.push([]); beat = 0; }
    if (!(note.beats > 0) || beat + note.beats > 4) throw new Error('乐句音型跨越小节边界');
    bars.at(-1).push(note); beat += note.beats;
  }
  if (beat !== 4) throw new Error('乐句没有填满末小节');
  return bars;
}

function holdEnding(tokens) {
  while (tokens.at(-1)?.degrees === null) {
    const rest = tokens.pop();
    if (!tokens.length) throw new Error('乐句没有收束音');
    tokens.at(-1).beats += rest.beats;
  }
}

export function phraseMetadata(id, level, seed, variant, pattern) {
  const bars = level === 1 ? 4 : 8;
  const foundationEnd = id === 'scales' && level === 3 ? 4 : 2;
  return { strategyVersion: 'piano-phrase-1', id: `${id}:${level}:${variant}`, seed, variant, pattern,
    stages: [{ label: '基础音型', startBar: 1, endBar: foundationEnd },
      { label: id === 'scales' && level === 1 ? '回程' : '变式练习', startBar: foundationEnd + 1, endBar: bars - 1 }, { label: '收束', startBar: bars, endBar: bars }] };
}

export function fundamentalPhrase(id, level, base, { seed, variant = 0 }) {
  const v = ((seed >>> 0) + variant) % 3;
  let bars = clone(base);
  let pattern;
  if (id === 'triads') {
    const tonic = [0, 2, 4];
    if (level === 1) {
      const middle = [
        [token(tonic, 2), token(null, 2)],
        [token(null, 2), token(tonic, 2)],
        [token(tonic, 1), token(tonic, 1), token(null, 2)],
      ][v];
      bars = [[token(tonic, 2), token(tonic, 2)], [token(tonic, 4)], middle, [token(tonic, 4)]];
    } else {
      const durations = [[1, 1, 2], [2, 1, 1], [1, 2, 1]];
      for (let bar = 2; bar < 7; bar++) {
        const chords = base[bar].map((note) => note.degrees);
        bars[bar] = rhythm(chords, durations[(bar + v) % 3]);
        if (bar === 5) bars[bar][1].degrees = null;
      }
      bars[7] = [token(tonic, 4)];
    }
    pattern = `${level === 1 ? '固定主和弦原位' : level === 2 ? '主和弦原位、第一与第二转位' : 'I–IV–V–I 和弦连接'}；先练两拍齐奏，再练保持与休止后的重新落键，末小节主和弦保持四拍。`;
  } else if (id === 'scales') {
    const tokens = clone(base.flat());
    const top = level === 3 ? 14 : 7;
    if (level === 1 && v === 1) for (const note of tokens) if (note.degrees) note.degrees = [top - note.degrees[0]];
    if (level === 2) for (let cycle = 1; cycle <= 2; cycle++) {
      if (v === 0 || v === cycle) for (const note of tokens.slice(cycle * 16, (cycle + 1) * 16)) if (note.degrees) note.degrees = [7 - note.degrees[0]];
    }
    if (level === 3 && v !== 2) for (let i = 32; i < tokens.length; i++) tokens[i].beats = (i + v) % 2 === 0 ? .75 : .25;
    if (level > 1 || v === 2) holdEnding(tokens);
    bars = barsOf(tokens);
    pattern = level === 1 ? `一八度${v === 1 ? '先下行再上行' : '先上行再下行'}，四分音符；完整返回起始主音后${v === 2 ? '保持两拍收束' : '休止一拍'}。`
      : level === 2 ? '一八度八分音符上下行；中段换成从高音向下出发的完整音阶，轮间休止半拍，最后回主音保持。'
      : `两八度完整上下行；后半段${v === 2 ? '保持均分' : v === 0 ? '采用长短节奏（附点八分与十六分）' : '采用短长节奏（十六分与附点八分）'}，末尾主音延长收束。`;
  } else if (id === 'arpeggios') {
    const cycleLength = level === 3 ? 16 : 8;
    const descending = level === 3 ? [14, 11, 9, 7, 4, 2, 0, 2, 4, 7, 9, 11, 14, null, null, null] : [7, 4, 2, 0, 2, 4, 7, null];
    const tokens = clone(base.flat());
    const count = tokens.length / cycleLength;
    for (let cycle = 0; cycle < count; cycle++) {
      if ((cycle + v) % 3 !== 1) continue;
      for (let i = 0; i < cycleLength; i++) tokens[cycle * cycleLength + i].degrees = descending[i] === null ? null : [descending[i]];
    }
    holdEnding(tokens); bars = barsOf(tokens);
    pattern = `${level === 3 ? '两八度' : '一八度'}琶音，${level === 1 ? '四分音符' : '八分音符'}；在完整上行回程与完整下行回程之间变化，轮间休止后再换位置，末尾主音延长。`;
  } else if (level === 1) {
    if (id === 'five-finger') {
      bars[2] = line([[0, 1, 2, 1], [0, 1, 0, 1], [0, 1, 2, 3]][v]);
      bars[3] = [token([2], 1), token([1], 1), token([0], 2)];
      pattern = '先按 1–2–3–4–5–4–3–2 练相邻五音；第三小节在五指位置内作相邻音变式，最后 3–2–1 回主音并保持两拍。';
    } else {
      const motifs = id === 'broken-chords' ? [[4, 2, 0, 2], [0, 4, 2, 4], [2, 4, 2, 0]] : [[4, 0, 4, 0], [0, 0, 4, 0], [4, 4, 0, 4]];
      bars[2] = line(motifs[v]);
      bars[3] = [token([4], 1), token([id === 'broken-chords' ? 2 : 0], 1), token([0], 2)];
      pattern = `${id === 'broken-chords' ? '先按根音–三音–五音–三音分解主和弦，中段改变和弦音顺序' : '先练根音与五度往返，中段改变出发音和落点顺序'}；全句使用四分音符，末尾回根音保持两拍。`;
    }
  } else {
    for (let bar = 2; bar < 6; bar++) {
      const motive = clone(base[bar]);
      const change = (bar + v) % 3;
      if (change === 0) bars[bar] = motive.reverse();
      else if (change === 1) bars[bar] = [...motive.slice(2), ...motive.slice(0, 2)];
      else bars[bar] = rhythm(motive.map((note) => note.degrees), [1, .5, .5, 1, .5, .5]);
    }
    bars[7] = [...clone(base[7].slice(0, 4)), token([0], 1), token(null, 1)];
    pattern = `${id === 'five-finger' ? '以 1–3–2–4 等五指间隔音型为基础' : id === 'broken-chords' ? level === 2 ? '按主和弦原位与转位轮换' : '按 I–IV–V–I 分解和弦连接' : '在根音与八度位置之间依次跳进'}；先练基础音型，中段变化音型方向、出发音及四分/八分节奏，最后回根音并休止。`;
  }
  return { bars, metadata: phraseMetadata(id, level, seed, v, pattern) };
}
