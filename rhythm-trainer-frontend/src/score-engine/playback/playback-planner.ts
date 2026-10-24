import {
  addBeat,
  beatToString,
  compareBeat,
  multiplyBeat,
  subtractBeat,
  ZERO_BEAT,
  type RationalBeat,
} from '../domain/rational';
import {
  SCORE_ENGINE_VERSION,
  type EngineAtomLike,
  type ImportIssue,
  type PlaybackGroup,
  type PlaybackOccurrence,
  type PlaybackPlan,
  type PlaybackPlanRequest,
  type PlaybackPlanResult,
  type ScoreDocument,
  type ScoreEvent,
  type ScoreMeasure,
  type ScoreOccurrence,
  type ScoreOccurrenceResult,
  type TempoMap,
} from '../domain/types';

export class PlaybackPlanError extends Error {
  constructor(
    readonly code: 'invalid_range' | 'invalid_repeat_count' | 'no_measures',
    message: string,
  ) {
    super(message);
    this.name = 'PlaybackPlanError';
  }
}

const MAX_LOOP_PASSES = 32;
const PLANNER_VERSION = 'playback-planner-1.0.0';

interface EventRef {
  event: ScoreEvent;
  measure: ScoreMeasure;
  partIndex: number;
}

function collectEvents(score: ScoreDocument, start: number, end: number): EventRef[] {
  const refs: EventRef[] = [];
  score.parts.forEach((part, partIndex) => {
    part.measures.forEach((measure) => {
      if (measure.ordinal < start || measure.ordinal > end) return;
      for (const event of measure.events) {
        if (event.kind !== 'note' || !event.pitch) continue;
        if (event.isGrace || event.isCue) continue;
        refs.push({ event, measure, partIndex });
      }
    });
  });
  return refs;
}

function scoreTieDuration(score: ScoreDocument, event: ScoreEvent): RationalBeat {
  if (!event.tieSpanId) return event.durationBeat;
  const span = score.tieSpans.find((entry) => entry.id === event.tieSpanId);
  if (!span) return event.durationBeat;
  if (span.eventIds[0] !== event.id) return event.durationBeat;
  return subtractBeat(span.endBeat, event.onsetBeat);
}

function isTieContinuation(score: ScoreDocument, event: ScoreEvent): boolean {
  if (!event.tieSpanId) return false;
  const span = score.tieSpans.find((entry) => entry.id === event.tieSpanId);
  return Boolean(span && span.eventIds[0] !== event.id);
}

function rangeMeasures(score: ScoreDocument, start: number, end: number): ScoreMeasure[] {
  const reference = score.parts[0]?.measures ?? [];
  const selected = reference.filter((measure) => measure.ordinal >= start && measure.ordinal <= end);
  if (!selected.length) {
    throw new PlaybackPlanError('invalid_range', `小节范围 ${start}–${end} 没有可用小节`);
  }
  return selected;
}

/**
 * Builds a deterministic playback plan from immutable score facts. It never
 * re-parses XML and never creates judgments. Repeat/ending semantics that are
 * not expanded leave strictAllowed=false instead of silently flattening.
 */
export function buildPlaybackPlan(score: ScoreDocument, request: PlaybackPlanRequest): PlaybackPlanResult {
  const measureCount = Math.max(0, ...score.parts.map((part) => part.measures.length));
  const start = request.range.startMeasureOrdinal;
  const end = request.range.endMeasureOrdinal;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > measureCount) {
    throw new PlaybackPlanError('invalid_range', `小节范围非法：${String(start)}–${String(end)}（共 ${measureCount} 小节）`);
  }
  const passes = request.repeatSelection.kind === 'range-loop' ? request.repeatSelection.count : 1;
  if (!Number.isSafeInteger(passes) || passes < 1 || passes > MAX_LOOP_PASSES) {
    throw new PlaybackPlanError('invalid_repeat_count', `A–B 循环次数需在 1–${MAX_LOOP_PASSES} 之间`);
  }

  const measures = rangeMeasures(score, start, end);
  const rangeStartBeat = measures[0].startBeat;
  const rangeDurationBeat = measures.reduce(
    (sum, measure) => addBeat(sum, measure.durationBeat),
    ZERO_BEAT,
  );
  const planId = [
    'plan',
    score.fingerprint.slice(0, 16),
    `m${start}-${end}`,
    request.repeatSelection.kind === 'range-loop' ? `loop${passes}` : 'once',
    PLANNER_VERSION,
  ].join(':');

  const issues: ImportIssue[] = [];
  if (!score.strictAllowed) {
    issues.push({
      code: 'score_not_strict_ready',
      severity: 'warning',
      message: '该 ScoreDocument 的 ImportReport 不允许严格计时；可显示谱面，但不能输出可信 strict 成绩',
      blocksStrict: true,
    });
  }
  if (score.capabilities.includes('repeat') && request.unsupportedNotationPolicy === 'reject-strict') {
    issues.push({
      code: 'unsupported_repeat_structure',
      severity: 'warning',
      message: '乐谱包含 repeat/ending 或跳转；PlaybackPlan 仅按线性小节生成，严格测验被阻断',
      blocksStrict: true,
    });
  }

  const refs = collectEvents(score, start, end);
  const occurrences: PlaybackOccurrence[] = [];
  for (let passIndex = 0; passIndex < passes; passIndex += 1) {
    const passOffset = multiplyBeat(rangeDurationBeat, passIndex);
    for (const ref of refs) {
      if (isTieContinuation(score, ref.event)) continue;
      const playbackBeat = addBeat(
        subtractBeat(ref.event.onsetBeat, rangeStartBeat),
        passOffset,
      );
      occurrences.push({
        occurrenceId: `${planId}:p${passIndex}:${ref.event.id}`,
        scoreEventId: ref.event.id,
        sourcePartId: ref.event.source.partId,
        sourceMeasureOrdinal: ref.event.source.measureOrdinal,
        sourceOrdinal: ref.event.source.sourceOrdinal,
        playbackIndex: -1,
        passIndex,
        measureOrdinal: ref.measure.ordinal,
        playbackBeat,
        beatInMeasure: subtractBeat(ref.event.onsetBeat, ref.measure.startBeat),
        bar: ref.measure.ordinal,
        staffNumber: ref.event.source.staffNumber,
        voiceId: ref.event.source.voiceId,
        pitch: ref.event.pitch,
        durationBeat: scoreTieDuration(score, ref.event),
        chordGroupId: ref.event.chordGroupId,
        isTieOnset: Boolean(ref.event.tieSpanId && score.tieSpans.some((span) => span.id === ref.event.tieSpanId && span.eventIds[0] === ref.event.id)),
      });
    }
  }
  occurrences.sort((a, b) => {
    const byBeat = compareBeat(a.playbackBeat, b.playbackBeat);
    if (byBeat !== 0) return byBeat;
    if (a.passIndex !== b.passIndex) return a.passIndex - b.passIndex;
    if (a.bar !== b.bar) return a.bar - b.bar;
    return a.occurrenceId.localeCompare(b.occurrenceId);
  });
  occurrences.forEach((occurrence, index) => { occurrence.playbackIndex = index; });

  const groupsByBeat = new Map<string, PlaybackOccurrence[]>();
  for (const occurrence of occurrences) {
    const key = `${occurrence.passIndex}:${beatToString(occurrence.playbackBeat)}`;
    const group = groupsByBeat.get(key);
    if (group) group.push(occurrence);
    else groupsByBeat.set(key, [occurrence]);
  }
  const groups: PlaybackGroup[] = [];
  for (const [key, entries] of groupsByBeat) {
    const first = entries[0];
    const [passText, ...beatParts] = key.split(':');
    const passIndex = Number(passText);
    const beatText = beatParts.join(':');
    const durationBeat = entries.reduce(
      (longest, entry) => compareBeat(entry.durationBeat, longest) > 0 ? entry.durationBeat : longest,
      ZERO_BEAT,
    );
    groups.push({
      groupId: `${planId}:g${passIndex}:${beatText}`,
      playbackBeat: first.playbackBeat,
      occurrenceIds: entries.map((entry) => entry.occurrenceId),
      scoreEventIds: entries.map((entry) => entry.scoreEventId),
      pitches: entries.flatMap((entry) => entry.pitch ? [entry.pitch] : []),
      bar: first.bar,
      beatInMeasure: first.beatInMeasure,
      staffNumbers: [...new Set(entries.map((entry) => entry.staffNumber))].sort((a, b) => a - b),
      voiceIds: [...new Set(entries.map((entry) => entry.voiceId ?? '1'))].sort(),
      durationBeat,
    });
  }
  groups.sort((a, b) => {
    const byBeat = compareBeat(a.playbackBeat, b.playbackBeat);
    return byBeat !== 0 ? byBeat : a.groupId.localeCompare(b.groupId);
  });

  if (!occurrences.length) {
    issues.push({
      code: 'no_playable_notes',
      severity: 'warning',
      message: '所选范围内没有可演奏的音符（休止符/装饰音不计入严格目标）',
      blocksStrict: true,
    });
  }

  const plan: PlaybackPlan = {
    planId,
    scoreFingerprint: score.fingerprint,
    range: { startMeasureOrdinal: start, endMeasureOrdinal: end },
    repeatSelection: request.repeatSelection,
    occurrences,
    groups,
    strictAllowed: !issues.some((issue) => issue.blocksStrict),
    issues,
    rangeStartBeat,
    rangeDurationBeat,
  };
  return { plan, issues, strictAllowed: plan.strictAllowed };
}

export interface EngineAtomResult {
  atoms: EngineAtomLike[];
  issues: ImportIssue[];
}

/**
 * Converts target groups to the existing Rust Core atom contract. The tick grid
 * is explicit; when an exact conversion is impossible, a blocking precision
 * issue is returned instead of silently claiming a strict timeline.
 */
export function scoreOccurrencesToEngineAtoms(
  plan: PlaybackPlan,
  ticksPerQuarter = 960,
): EngineAtomResult {
  const issues: ImportIssue[] = [];
  const atoms: EngineAtomLike[] = [];
  for (const group of plan.groups) {
    const start = multiplyBeat(group.playbackBeat, 1);
    const startTick = planToTicks(start, ticksPerQuarter);
    const durationTick = planToTicks(group.durationBeat, ticksPerQuarter);
    if (startTick === null || durationTick === null) {
      issues.push({
        code: 'tick_grid_rounding',
        severity: 'warning',
        message: `目标 ${group.groupId} 无法在 ${ticksPerQuarter} ticks/quarter 网格上无损表示；严格计时被阻断`,
        blocksStrict: true,
      });
      continue;
    }
    atoms.push({
      startTick,
      durationTicks: Math.max(1, durationTick),
      kind: 'note',
      bar: group.bar,
      beat: Number((group.beatInMeasure.numerator / group.beatInMeasure.denominator) + 1),
    });
  }
  return { atoms, issues };
}

function planToTicks(beat: RationalBeat, ticksPerQuarter: number): number | null {
  const scaled = beat.numerator * ticksPerQuarter;
  if (scaled % beat.denominator !== 0) return null;
  const ticks = scaled / beat.denominator;
  return Number.isSafeInteger(ticks) ? ticks : null;
}

export function buildScoreOccurrences(plan: PlaybackPlan, tempoMap: TempoMap): ScoreOccurrenceResult {
  const occurrences: ScoreOccurrence[] = plan.groups.map((group) => ({
    targetId: group.groupId,
    occurrenceIds: group.occurrenceIds,
    scoreEventIds: group.scoreEventIds,
    pitches: group.pitches,
    beat: group.playbackBeat,
    atMs: tempoMap.beatToMs(group.playbackBeat),
    durationMs: tempoMap.beatToMs(group.durationBeat),
    bar: group.bar,
    staffNumbers: group.staffNumbers,
    voiceIds: group.voiceIds,
    chordGroupIds: [...new Set(plan.occurrences
      .filter((occurrence) => group.occurrenceIds.includes(occurrence.occurrenceId))
      .map((occurrence) => occurrence.chordGroupId)
      .filter((id): id is string => Boolean(id)))],
    capabilities: [],
  }));
  return { occurrences, issues: [...plan.issues] };
}

export { SCORE_ENGINE_VERSION };
