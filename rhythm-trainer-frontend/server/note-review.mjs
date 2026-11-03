// Read-only presentation of persisted Rust evidence. Never updates grades,
// re-aligns notes, infers missing measurements, or modifies a saved Take.
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const name = pitch => Number.isInteger(pitch) && pitch >= 0 && pitch <= 127 ? `${names[pitch % 12]}${Math.floor(pitch / 12) - 1}` : '未记录音高';
const delta = (v, early, late) => v === 0 ? '与目标同时' : `${v < 0 ? early : late} ${Math.round(Math.abs(v))} ms`;

export function buildNoteReview(take, xml = null) {
  const timeline = take.assessment?.timelineReport;
  const follow = take.assessment?.followReport;
  const score = timeline?.scoreV1;
  const result = { takeId: take.takeId, kind: 'unavailable', trustworthy: take.assessment?.trustworthy === true,
    scoreFingerprint: take.score?.scoreFingerprint ?? timeline?.scoreFingerprint ?? null, xml, notice: '', items: [] };
  if (score && !score.error && Array.isArray(score.eventResults)) {
    result.kind = 'timeline';
    // Frozen Rust default, NOT the separate realtime rhythm profile window.
    // Unknown versions retain raw measurements without a tolerance verdict.
    const tolerance = score.configVersion === 'scoring-v1.0.1:default' ? 60 : null;
    const targets = new Map((timeline.scoreEvents ?? []).map(e => [e.scoreEventId, e]));
    const presses = new Map((timeline.keyLifecycles?.observations ?? []).map(p => [p.pressId, p]));
    const durations = new Map();
    for (const d of timeline.durations?.assessments ?? []) {
      const key = `${d.onsetSeq}|${d.pitch}`;
      const group = durations.get(key) ?? []; group.push(d); durations.set(key, group);
    }
    result.items = score.eventResults.map((e, index) => {
      const target = targets.get(e.scoreEventId);
      const press = presses.get(e.performedNoteId);
      const expectedDurationMs = number(target?.targetDurationMs);
      const actualDurationMs = press?.status === 'complete' ? number(press.keyDownDurationMs) : null;
      const durationCandidates = (press ? durations.get(`${press.noteOnSourceSeq}|${e.actualPitch}`) ?? [] : []).filter(d => press && d.onsetSeq === press.noteOnSourceSeq
        && d.pitch === e.actualPitch && d.quality === 'ok' && expectedDurationMs !== null
        && number(d.nominalDurationMs) !== null && Math.abs(d.nominalDurationMs - expectedDurationMs) < 1);
      const duration = durationCandidates.length === 1 ? durationCandidates[0] : null;
      const durationResult = duration?.result ?? 'unknown';
      const onset = number(e.onsetErrorMs);
      const messages = [];
      let state = e.result === 'MATCH' ? 'good' : ['MISSING', 'WRONG_PITCH', 'EXTRA'].includes(e.result) ? 'error' : 'unknown';
      if (e.result === 'MISSING') messages.push('漏弹：未匹配到这个目标音。');
      if (e.result === 'EXTRA') messages.push('多弹：这次按键未匹配到目标音，不能强行归到附近音符。');
      if (e.result === 'WRONG_PITCH') messages.push(`音高不符：应弹 ${name(e.expectedPitch)}，实际 ${name(e.actualPitch)}。`);
      if (e.result === 'AMBIGUOUS') messages.push('匹配存在歧义，不能确定对应关系。');
      if (onset !== null) {
        const outside = tolerance !== null && Math.abs(onset) > tolerance;
        messages.push(`起音${delta(onset, '早了', '晚了')}${tolerance === null ? '（未记录适用容差）' : `（${outside ? '超出' : '在'} ±${tolerance} ms 范围${outside ? '外' : '内'}）`}。`);
        if (outside && state === 'good') state = 'attention';
      }
      if (durationResult === 'too_short' || durationResult === 'too_long') {
        messages.push(`按键时值${durationResult === 'too_short' ? '偏短' : '偏长'} ${Math.round(Math.abs(duration.durationErrorMs))} ms。`);
        if (state === 'good') state = 'attention';
      } else if (durationResult === 'within_tolerance') messages.push('按键时值在容差内。');
      else if (e.result === 'MATCH') messages.push('时值未单独判定：数据缺失、未启用或只有音符组评估。');
      if (e.result === 'MATCH' && (onset === null || tolerance === null || !['within_tolerance', 'too_short', 'too_long'].includes(durationResult)) && state === 'good') state = 'unknown';
      return { id: `timeline-${index}`, eventId: e.scoreEventId ?? null, measure: number(e.measure ?? target?.measure),
        pitch: number(e.expectedPitch), actualPitch: number(e.actualPitch), pitchLabel: name(e.expectedPitch ?? e.actualPitch),
        state, result: e.result, messages, onsetErrorMs: onset, intervalErrorMs: null,
        expectedDurationMs, actualDurationMs, durationResult };
    });
    const order = new Map((timeline.scoreEvents ?? []).map((e, index) => [e.scoreEventId, index]));
    result.items.sort((a, b) => (order.get(a.eventId) ?? Infinity) - (order.get(b.eventId) ?? Infinity));
    result.notice = '起音偏差与按键时值分开查看；未判定不等于合格。时值指按键到松键，不代表踏板延音。';
  } else if (follow && Array.isArray(follow.targets)) {
    result.kind = 'follow';
    result.notice = '跟手模式记录相邻起音间隔与和弦整体表现，不评估固定时间准点或按键时值。';
    const source = take.evidence?.followSourceNotes ?? [];
    result.items = follow.targets.flatMap((t, index) => {
      const mapped = source.filter(n => n.targetId === t.targetId);
      const notes = mapped.length ? mapped : t.expectedPitches.map(spelling => ({ spelling, eventId: null, pitch: null }));
      return notes.map((n, i) => {
        const messages = [];
        if (!t.completed) messages.push('这个目标组尚未完整弹完。');
        if (t.wrongNotes?.length) messages.push(`此目标组曾按错：${t.wrongNotes.map(p => name(p.midiNote)).join('、')}。`);
        if (t.duplicateNotes) messages.push(`此目标组有 ${t.duplicateNotes} 次重复按键。`);
        if (t.intervalJudged && number(t.intervalErrorMs) !== null) messages.push(`与上一目标的间隔${delta(t.intervalErrorMs, '短了', '长了')}。`);
        else messages.push('相邻起音间隔未判定。');
        if (number(t.chordSpreadMs) !== null && notes.length > 1) messages.push(`和弦各音落键相差 ${Math.round(t.chordSpreadMs)} ms。`);
        return { id: `follow-${index}-${i}`, eventId: n.eventId ?? null, measure: number(t.bar), pitch: number(n.pitch), actualPitch: null,
          pitchLabel: n.spelling ?? name(n.pitch), state: !t.completed ? 'unknown' : t.standard && !t.wrongNotes?.length && !t.duplicateNotes ? 'good' : 'attention',
          result: t.completed ? 'FOLLOW_COMPLETE' : 'FOLLOW_PENDING', messages, onsetErrorMs: null,
          intervalErrorMs: t.intervalJudged ? number(t.intervalErrorMs) : null, expectedDurationMs: null, actualDurationMs: null, durationResult: 'not-applicable' };
      });
    });
  } else result.notice = '此旧记录没有逐音符评分证据，无法生成可靠的音符复盘。';
  if (!result.trustworthy) result.notice = `本轮数据不可信，仅用于定位观察。${result.notice}`;
  return result;
}
