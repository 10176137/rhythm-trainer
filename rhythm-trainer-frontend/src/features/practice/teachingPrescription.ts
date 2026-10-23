import type { HandSelection } from '../../types/practice';
import type {
  EngineDurationAssessment,
  EngineDurationReport,
  EngineScoreEventResult,
  EngineScoreStatus,
  EngineSessionScoreReport,
} from '../../types/engine';
import type {
  MeasureRange,
  PrescriptionAnalysis,
  PrescriptionBlock,
  PrescriptionConfidenceStatus,
  PrescriptionEvidence,
  TeachingPrescription,
} from '../../types/teaching';

const ONSET_TOLERANCE_MS = 60;
const LOCAL_CONTRAST_MS = 20;
const MIN_MEASURE_MATCHES = 2;
const MIN_DURATION_GRADED = 2;

const GLOBAL_DIAGNOSTIC_LABELS: Record<string, string> = {
  'global-offset': '固定起音偏移',
  'local-jitter': '局部节奏抖动',
  'rhythm-compensation': '节奏补偿',
  'tempo-drift': '速度漂移',
};

export interface TeachingPrescriptionInput {
  scoreReport: EngineSessionScoreReport | { error: string } | null;
  scoreStatus: EngineScoreStatus | null;
  durations?: EngineDurationReport | { error: string } | null;
  sourceReportId: string | null;
  sourceTakeId: string | null;
  bpm: number | null;
  hand: HandSelection | null;
  sourceScoreFingerprint?: string | null;
  scoreBarCount?: number | null;
  nowIso?: string;
}

interface Candidate {
  priority: number;
  problemType: TeachingPrescription['problemType'];
  ruleId: string;
  range: MeasureRange;
  evidence: PrescriptionEvidence[];
  confidence: PrescriptionConfidenceStatus;
  factor: number;
  reason: string;
  action: string;
}

interface DurationBarGroup {
  bar: number;
  graded: EngineDurationAssessment[];
  issues: EngineDurationAssessment[];
}

const isScoreReport = (
  value: TeachingPrescriptionInput['scoreReport'],
): value is EngineSessionScoreReport => !!value && !('error' in value);

const isDurationReport = (
  value: TeachingPrescriptionInput['durations'],
): value is EngineDurationReport => !!value && !('error' in value);

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const measureNumber = (value: number | null | undefined): number | null =>
  Number.isInteger(value) && Number(value) >= 1 ? Number(value) : null;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundBpm(value: number): number {
  return Math.min(300, Math.max(40, Math.round(value / 5) * 5));
}

export function recommendBpm(bpm: number | null, factor: number): number {
  const source = finite(bpm) && bpm >= 20 && bpm <= 300 ? bpm : 72;
  return roundBpm(source * factor);
}

function normalizeConfidence(value: string | null | undefined): PrescriptionConfidenceStatus {
  return value === 'high' || value === 'medium' || value === 'low' || value === 'not-assessable'
    ? value
    : 'not-assessable';
}

function confidenceFor(
  report: EngineSessionScoreReport,
  category: string,
): PrescriptionConfidenceStatus {
  const diagnostic = report.diagnostics.find((item) => item.category === category);
  return normalizeConfidence(diagnostic?.confidence ?? report.confidence);
}

function coreRangeEvidence(
  report: EngineSessionScoreReport,
  range: MeasureRange,
): PrescriptionEvidence[] {
  const matching = report.practiceRanges.filter(
    (item) => item.startMeasure === range.startMeasure && item.endMeasure === range.endMeasure,
  );
  if (matching.length === 0) return [];
  return [{
    source: 'practice-range',
    metric: 'core-practice-range',
    value: `priority ${matching[0].priority}`,
    measure: matching[0].startMeasure,
    detail: matching[0].reason,
  }];
}

function measureRange(value: number): MeasureRange {
  return { startMeasure: value, endMeasure: value };
}

function prescriptionId(
  sourceReportId: string,
  ruleId: string,
  range: MeasureRange,
): string {
  return `rx-${sourceReportId}-${ruleId}-${range.startMeasure}-${range.endMeasure}`;
}

function makePrescription(
  input: TeachingPrescriptionInput,
  sourceReportId: string,
  sourceTakeId: string,
  candidate: Candidate,
): TeachingPrescription {
  const bpm = recommendBpm(input.bpm, candidate.factor);
  const hand = input.hand ?? 'both';
  return {
    prescriptionId: prescriptionId(sourceReportId, candidate.ruleId, candidate.range),
    sourceReportId,
    sourceTakeId,
    ruleId: candidate.ruleId,
    problemType: candidate.problemType,
    evidence: candidate.evidence,
    confidenceStatus: candidate.confidence,
    measureRange: candidate.range,
    recommendedBpm: bpm,
    recommendedHand: hand,
    recommendedMode: 'loop',
    reason: candidate.reason,
    action: `${candidate.action} 建议 ${bpm} BPM；当前 loop 只练所选范围一次，不会自动重复。`,
    status: 'EXECUTABLE',
    createdAtIso: input.nowIso ?? new Date().toISOString(),
    sourceScoreFingerprint: input.sourceScoreFingerprint ?? null,
  };
}

function missingEventsByMeasure(
  report: EngineSessionScoreReport,
): Map<number, EngineScoreEventResult[]> {
  const result = new Map<number, EngineScoreEventResult[]>();
  for (const event of report.eventResults) {
    if (event.result !== 'MISSING') continue;
    const measure = measureNumber(event.measure);
    if (measure == null) continue;
    const list = result.get(measure) ?? [];
    list.push(event);
    result.set(measure, list);
  }
  return result;
}

function wrongEventsByMeasure(
  report: EngineSessionScoreReport,
): Map<number, EngineScoreEventResult[]> {
  const result = new Map<number, EngineScoreEventResult[]>();
  for (const event of report.eventResults) {
    if (event.result !== 'WRONG_PITCH') continue;
    const measure = measureNumber(event.measure);
    if (measure == null) continue;
    const list = result.get(measure) ?? [];
    list.push(event);
    result.set(measure, list);
  }
  return result;
}

function extraEventsByMeasure(
  report: EngineSessionScoreReport,
): Map<number, EngineScoreEventResult[]> {
  const result = new Map<number, EngineScoreEventResult[]>();
  for (const event of report.eventResults) {
    if (event.result !== 'EXTRA') continue;
    const measure = measureNumber(event.measure);
    if (measure == null) continue;
    const list = result.get(measure) ?? [];
    list.push(event);
    result.set(measure, list);
  }
  return result;
}

function durationGroups(
  durations: TeachingPrescriptionInput['durations'],
): { groups: Map<number, DurationBarGroup>; hasUnknown: boolean; hasMissingBar: boolean } {
  const groups = new Map<number, DurationBarGroup>();
  if (!isDurationReport(durations)) {
    return { groups, hasUnknown: false, hasMissingBar: false };
  }
  let hasUnknown = false;
  let hasMissingBar = false;
  for (const assessment of durations.assessments) {
    if (assessment.result === 'unknown' || assessment.quality !== 'ok') {
      hasUnknown = true;
      continue;
    }
    if (!['within_tolerance', 'too_short', 'too_long'].includes(assessment.result)) continue;
    const bar = measureNumber(assessment.bar);
    if (bar == null) {
      hasMissingBar = true;
      continue;
    }
    const group = groups.get(bar) ?? { bar, graded: [], issues: [] };
    group.graded.push(assessment);
    if (assessment.result === 'too_short' || assessment.result === 'too_long') {
      group.issues.push(assessment);
    }
    groups.set(bar, group);
  }
  return { groups, hasUnknown, hasMissingBar };
}

function localOnsetCandidates(report: EngineSessionScoreReport): Candidate[] {
  const measured = report.measures
    .filter((measure) => measureNumber(measure.measure) != null && measure.matched >= MIN_MEASURE_MATCHES)
    .map((measure) => ({
      measure,
      mae: measure.meanAbsOnsetErrorMs,
    }))
    .filter((item): item is { measure: typeof item.measure; mae: number } => finite(item.mae));
  if (measured.length === 0) return [];

  const baseline = median(measured.map((item) => item.mae));
  return measured
    .filter(({ measure, mae }) => {
      if (measure.missed > 0) return false; // missing-note rule owns this measure
      if (mae <= ONSET_TOLERANCE_MS) return false;
      if (measured.length === 1) return true;
      return baseline != null && mae - baseline >= LOCAL_CONTRAST_MS;
    })
    .map(({ measure, mae }) => {
      const range = measureRange(measure.measure);
      const evidence: PrescriptionEvidence[] = [{
        source: 'score-measure',
        metric: 'meanAbsOnsetErrorMs',
        value: mae,
        measure: measure.measure,
        detail: `matched ${measure.matched}; measure median baseline ${baseline == null ? 'n/a' : baseline.toFixed(1)}ms`,
      }, ...coreRangeEvidence(report, range)];
      const baselineText = measured.length === 1 || baseline == null
        ? '报告只有一个可比较小节'
        : `全曲可比较小节中位数 ${baseline.toFixed(1)}ms`;
      return {
        priority: 3,
        problemType: 'local-onset' as const,
        ruleId: 'LOCAL_ONSET_V1',
        range,
        evidence,
        confidence: normalizeConfidence(report.confidence),
        factor: 0.8,
        reason: `第 ${measure.measure} 小节平均绝对起音误差 ${mae.toFixed(1)}ms（${baselineText}，匹配 ${measure.matched} 个目标）。`,
        action: `降低速度练习第 ${measure.measure} 小节，先让每个起音落在同一拍点。`,
      };
    });
}

function missingCandidates(report: EngineSessionScoreReport): Candidate[] {
  const byMeasure = missingEventsByMeasure(report);
  const candidates: Candidate[] = [];
  for (const [measure, events] of byMeasure) {
    const range = measureRange(measure);
    const ids = events.map((event) => event.scoreEventId).filter(Boolean).slice(0, 8) as string[];
    candidates.push({
      priority: 0,
      problemType: 'missing-notes',
      ruleId: 'MISSING_NOTES_V1',
      range,
      evidence: [
        {
          source: 'score-event',
          metric: 'missingEvents',
          value: events.length,
          measure,
          eventId: ids[0],
          detail: ids.join(', '),
        },
        ...coreRangeEvidence(report, range),
      ],
      confidence: confidenceFor(report, 'missed-notes'),
      factor: 0.8,
      reason: `第 ${measure} 小节有 ${events.length} 个目标被引擎判定为漏音（来自事件级 MISSING，不是目标/实际数量差）。`,
      action: `降低速度补齐第 ${measure} 小节的漏音，再回到原速。`,
    });
  }
  return candidates;
}

function wrongPitchCandidates(report: EngineSessionScoreReport): Candidate[] {
  const byMeasure = wrongEventsByMeasure(report);
  const candidates: Candidate[] = [];
  for (const [measure, events] of byMeasure) {
    const range = measureRange(measure);
    const ids = events.map((event) => event.scoreEventId).filter(Boolean).slice(0, 8) as string[];
    candidates.push({
      priority: 1,
      problemType: 'pitch-errors',
      ruleId: 'PITCH_ERRORS_V1',
      range,
      evidence: [
        {
          source: 'score-event',
          metric: 'wrongPitchEvents',
          value: events.length,
          measure,
          eventId: ids[0],
          detail: events.slice(0, 3).map((event) => (
            `${event.scoreEventId ?? '?'}: ${event.expectedPitch ?? '?'}→${event.actualPitch ?? '?'}`
          )).join('; '),
        },
      ],
      confidence: confidenceFor(report, 'pitch-errors'),
      factor: 0.9,
      reason: `第 ${measure} 小节有 ${events.length} 个事件被引擎配为错音（期望/实际音高见事件关联）。`,
      action: `单独慢练第 ${measure} 小节的错音位置，确认音高后再恢复速度。`,
    });
  }
  return candidates;
}

function extraCandidates(report: EngineSessionScoreReport): Candidate[] {
  const byMeasure = extraEventsByMeasure(report);
  const candidates: Candidate[] = [];
  for (const [measure, events] of byMeasure) {
    const range = measureRange(measure);
    candidates.push({
      priority: 1,
      problemType: 'extra-notes',
      ruleId: 'EXTRA_NOTES_V1',
      range,
      evidence: [{
        source: 'score-event',
        metric: 'extraEvents',
        value: events.length,
        measure,
        detail: events.map((event) => event.performedNoteId).filter(Boolean).slice(0, 8).join(', '),
      }],
      confidence: confidenceFor(report, 'extra-notes'),
      factor: 0.9,
      reason: `第 ${measure} 小节有 ${events.length} 个额外音事件（事件级结果带可靠小节映射）。`,
      action: `慢速练习第 ${measure} 小节，先确认休止与起音边界。`,
    });
  }
  return candidates;
}

function durationCandidates(
  report: EngineSessionScoreReport,
  durations: TeachingPrescriptionInput['durations'],
): Candidate[] {
  const { groups } = durationGroups(durations);
  const candidates: Candidate[] = [];
  for (const group of groups.values()) {
    if (group.issues.length === 0 || group.graded.length < MIN_DURATION_GRADED) continue;
    const shortCount = group.issues.filter((item) => item.result === 'too_short').length;
    const longCount = group.issues.filter((item) => item.result === 'too_long').length;
    const details = group.issues.slice(0, 3).map((item) => ({
      source: 'duration-assessment' as const,
      metric: 'durationErrorMs',
      value: item.durationErrorMs,
      measure: group.bar,
      eventId: item.targetId ?? undefined,
      detail: `actual ${item.actualKeyDownMs ?? '?'}ms / target ${item.nominalDurationMs ?? '?'}ms; ${item.result}`,
    }));
    candidates.push({
      priority: 2,
      problemType: 'duration',
      ruleId: 'DURATION_V1',
      range: measureRange(group.bar),
      evidence: [
        {
          source: 'duration-assessment',
          metric: 'gradedDurationNotes',
          value: group.graded.length,
          measure: group.bar,
          detail: `valid quality=ok notes; ${shortCount} too_short, ${longCount} too_long`,
        },
        ...details,
      ],
      confidence: confidenceFor(report, 'duration'),
      factor: 0.8,
      reason: `第 ${group.bar} 小节有 ${group.issues.length}/${group.graded.length} 个有效按键时值偏离目标（偏短 ${shortCount}，偏长 ${longCount}）；未松键/不确定配对未计入。`,
      action: `以较慢速度练习第 ${group.bar} 小节，按满目标时值再回到原速。`,
    });
  }
  return candidates;
}

function selectCandidates(candidates: Candidate[], limit = 5): Candidate[] {
  const byRange = new Map<string, Candidate>();
  for (const candidate of [...candidates].sort((a, b) => (
    a.priority - b.priority || a.range.startMeasure - b.range.startMeasure
  ))) {
    const key = `${candidate.range.startMeasure}-${candidate.range.endMeasure}`;
    if (!byRange.has(key)) byRange.set(key, candidate);
  }
  return [...byRange.values()]
    .sort((a, b) => a.priority - b.priority || a.range.startMeasure - b.range.startMeasure)
    .slice(0, limit);
}

function block(
  ruleId: string,
  problemType: string,
  reason: string,
  evidence: PrescriptionEvidence[] = [],
): PrescriptionBlock {
  return { ruleId, problemType, reason, evidence };
}

/**
 * Pure rule selection from the existing Rust report and duration report.
 * It never computes pitch/onset/rhythm/duration scores itself.
 */
export function buildTeachingPrescriptions(
  input: TeachingPrescriptionInput,
): PrescriptionAnalysis {
  const sourceReportId = input.sourceReportId?.trim() || null;
  const sourceTakeId = input.sourceTakeId?.trim() || null;
  const report = isScoreReport(input.scoreReport) ? input.scoreReport : null;
  const status = input.scoreStatus;
  const blocks: PrescriptionBlock[] = [];

  const maxMeasureFromReport = report
    ? Math.max(
      0,
      ...report.measures.map((item) => item.measure),
      ...report.practiceRanges.map((item) => item.endMeasure),
      ...report.eventResults.map((item) => item.measure ?? 0),
    )
    : 0;
  const maxMeasure = finite(input.scoreBarCount) && input.scoreBarCount >= 1
    ? Math.floor(input.scoreBarCount)
    : maxMeasureFromReport;

  const reportUsable = !!report;
  const manualStatusAllowed = status === 'AVAILABLE'
    || status === 'DEGRADED'
    || status === 'INSUFFICIENT_DATA';
  const canCreateManual = reportUsable
    && !!sourceReportId
    && !!sourceTakeId
    && manualStatusAllowed
    && maxMeasure >= 1;

  if (!sourceReportId || !sourceTakeId) {
    blocks.push(block(
      'SOURCE_REF_V1',
      'data-quality',
      '缺少来源报告或来源 Take 标识，不能创建可追溯的复练任务。',
    ));
  }
  if (!report) {
    blocks.push(block(
      'REPORT_UNAVAILABLE_V1',
      'data-quality',
      '当前报告没有可用的 Rust 完整评分，不能生成确定性处方。',
    ));
  }

  if (report && status !== 'AVAILABLE') {
    blocks.push(block(
      `STATUS_${status ?? 'UNKNOWN'}_V1`,
      'data-quality',
      status === 'DEGRADED'
        ? '报告状态为数据降级；不自动生成依赖受影响数据的处方，可手动选择范围。'
        : status === 'INSUFFICIENT_DATA'
          ? '报告证据不足；不自动生成需要精确匹配证据的处方，可手动选择范围。'
          : '报告不可评分或无效；不能生成自动处方。',
    ));
  }

  const automaticAllowed = report
    && status === 'AVAILABLE'
    && report.confidence !== 'low'
    && report.confidence !== 'not-assessable'
    && !report.dataDegraded;

  if (report && status === 'AVAILABLE' && !automaticAllowed) {
    blocks.push(block(
      'LOW_CONFIDENCE_V1',
      'data-quality',
      '本次评分的证据支持不足（confidence 低或数据降级），不能把分项指标转成确定性复练结论。',
    ));
  }

  const candidates: Candidate[] = [];
  if (report && automaticAllowed) {
    candidates.push(...missingCandidates(report));
    candidates.push(...wrongPitchCandidates(report));
    candidates.push(...durationCandidates(report, input.durations));
    candidates.push(...localOnsetCandidates(report));
    candidates.push(...extraCandidates(report));

    const ambiguous = report.eventResults.filter((event) => event.result === 'AMBIGUOUS');
    if (ambiguous.length > 0) {
      blocks.push(block(
        'AMBIGUOUS_V1',
        'alignment',
        `${ambiguous.length} 个事件存在配对歧义；不会把 AMBIGUOUS 当作确定错音、漏音或额外音。`,
        ambiguous.slice(0, 3).map((event) => ({
          source: 'score-event' as const,
          metric: 'ambiguousEvent',
          value: event.result,
          measure: event.measure ?? undefined,
          eventId: event.scoreEventId ?? undefined,
        })),
      ));
    }

    const extraWithoutMeasure = report.eventResults.filter(
      (event) => event.result === 'EXTRA' && measureNumber(event.measure) == null,
    );
    if (report.pitch.extra > 0 && extraWithoutMeasure.length > 0) {
      blocks.push(block(
        'EXTRA_NO_MEASURE_V1',
        'extra-notes',
        '额外音事件没有可靠的小节映射；不能据此生成逐小节额外音处方。',
        extraWithoutMeasure.slice(0, 3).map((event) => ({
          source: 'score-event' as const,
          metric: 'extraWithoutMeasure',
          value: event.performedNoteId ?? 'extra',
        })),
      ));
    }

    const durationState = durationGroups(input.durations);
    const durationDiagnostic = report.diagnostics.find((item) => item.category === 'duration');
    if (durationDiagnostic && durationState.groups.size === 0) {
      blocks.push(block(
        durationState.hasMissingBar ? 'DURATION_NO_MEASURE_V1' : 'DURATION_NO_VALID_SAMPLE_V1',
        'duration',
        durationState.hasMissingBar
          ? '存在时值诊断，但当前时值记录缺少小节映射；不能自动定位到时值练习范围。'
          : '时值数据缺少 quality=ok 且 complete 的有效样本；不能判定按键过短或过长。',
        [{
          source: 'score-diagnostic',
          metric: 'durationDiagnostic',
          value: durationDiagnostic.evidence,
        }],
      ));
    }

    const globalDiagnostics = report.diagnostics.filter(
      (item) => item.category in GLOBAL_DIAGNOSTIC_LABELS,
    );
    if (candidates.length === 0 && globalDiagnostics.length > 0) {
      for (const diagnostic of globalDiagnostics) {
        blocks.push(block(
          `GLOBAL_${diagnostic.category.toUpperCase().replace(/-/g, '_')}_V1`,
          'global-rhythm',
          `${GLOBAL_DIAGNOSTIC_LABELS[diagnostic.category]}是全局指标，报告没有提供可信的逐小节定位；不能据此自动生成具体小节任务。`,
          [{
            source: 'score-diagnostic',
            metric: diagnostic.category,
            value: diagnostic.evidence,
          }],
        ));
      }
    }

    if (report.pitch.missed > 0 && !report.eventResults.some((event) => (
      event.result === 'MISSING' && measureNumber(event.measure) != null
    ))) {
      blocks.push(block(
        'MISSING_NO_MEASURE_V1',
        'missing-notes',
        '报告有漏音统计，但缺少带小节映射的 MISSING 事件；不能仅凭目标数与实际数不同生成逐小节漏音处方。',
      ));
    }
    if (report.pitch.wrongPitch > 0 && !report.eventResults.some((event) => (
      event.result === 'WRONG_PITCH' && measureNumber(event.measure) != null
    ))) {
      blocks.push(block(
        'PITCH_NO_MEASURE_V1',
        'pitch-errors',
        '报告有错音统计，但缺少带小节映射的 WRONG_PITCH 事件；不能自动定位错音范围。',
      ));
    }
  }

  const selected = selectCandidates(candidates);
  const seenBlocks = new Set<string>();
  const uniqueBlocks = blocks.filter((item) => {
    if (seenBlocks.has(item.ruleId)) return false;
    seenBlocks.add(item.ruleId);
    return true;
  });

  const prescriptions = sourceReportId && sourceTakeId
    ? selected.map((candidate) => makePrescription(
      input,
      sourceReportId,
      sourceTakeId,
      candidate,
    ))
    : [];

  return {
    prescriptions,
    blocks: uniqueBlocks,
    canCreateManual,
    manualBlockReason: canCreateManual
      ? null
      : !sourceReportId || !sourceTakeId
        ? '缺少来源报告/Take，不能创建可追溯任务。'
        : !report
          ? '当前报告没有可用的完整评分数据。'
          : status === 'UNAVAILABLE' || status === 'INVALID'
            ? '当前报告不可评分，不能创建复练任务。'
            : '报告没有可用小节范围，不能手动选择。',
  };
}

export interface ManualPrescriptionInput {
  sourceReportId: string;
  sourceTakeId: string;
  startMeasure: number;
  endMeasure: number;
  bpm: number;
  hand: HandSelection;
  sourceScoreFingerprint?: string | null;
  nowIso?: string;
}

/** A user-selected range is explicitly not a system diagnosis. */
export function buildManualPrescription(input: ManualPrescriptionInput): TeachingPrescription | null {
  const start = Math.floor(input.startMeasure);
  const end = Math.floor(input.endMeasure);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  const range = { startMeasure: start, endMeasure: end };
  const bpm = roundBpm(finite(input.bpm) ? input.bpm : 72);
  return {
    prescriptionId: prescriptionId(input.sourceReportId, 'MANUAL_RANGE_V1', range),
    sourceReportId: input.sourceReportId,
    sourceTakeId: input.sourceTakeId,
    ruleId: 'MANUAL_RANGE_V1',
    problemType: 'manual-range',
    evidence: [{
      source: 'user-selection',
      metric: 'manualMeasureRange',
      value: `${start}-${end}`,
      measure: start,
      detail: '用户手动选择的范围，不是系统诊断。',
    }],
    confidenceStatus: 'not-assessable',
    measureRange: range,
    recommendedBpm: bpm,
    recommendedHand: input.hand,
    recommendedMode: 'loop',
    reason: `用户手动选择第 ${start}–${end} 小节进行复练；这不是系统生成的薄弱点结论。`,
    action: `按确认后的 BPM 练习第 ${start}–${end} 小节；loop 只练所选范围一次，不会自动重复。`,
    status: 'MANUAL',
    createdAtIso: input.nowIso ?? new Date().toISOString(),
    sourceScoreFingerprint: input.sourceScoreFingerprint ?? null,
  };
}
