// R2-0 reference implementation: ScoreDocumentV1 projection + planFingerprintV1.
// Pure functions only. No importer/domain changes; no runtime IDs in payloads.
// Normative text: audit-r1/docs/SCOREDOCUMENT_V1_CONTRACT.md and
// audit-r1/docs/PLAN_FINGERPRINT_V1.md. Schemas in audit-r1/contracts/.
import { createHash } from 'node:crypto';
import jcsModule from 'canonicalize';
import type { ScoreDocument, ScoreEvent, ImportReport } from '../domain/types';
import type { PlaybackGroup, PlaybackPlan } from '../domain/types';
import type { HandMappingV1, PracticeHand } from '../scope/practice-scope';

export const NORMALIZER_VERSION = 'normalizer-1';
export const SUPPORT_PROFILE_VERSION_V1 = 'musicxml-v1.0';
export const FINGERPRINT_SCHEMA_VERSION = 1;
export const PLANNER_VERSION_V1 = 'planner-ref-1';
export const MAPPING_VERSION_V1 = 'hand-mapping-1';

export type RationalV1 = { numerator: number; denominator: number };

export class ContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

/** Exact rational from a JS number via its canonical decimal string. */
export function numberToRationalV1(value: number): RationalV1 {
  if (!Number.isFinite(value)) throw new ContractError('NON_FINITE_NUMBER', `not a finite number: ${String(value)}`);
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) {
      throw new ContractError('RATIONAL_OUT_OF_RANGE', `integer exceeds safe range: ${String(value)}`);
    }
    return { numerator: value, denominator: 1 };
  }
  // Canonical decimal expansion of the double, as a fraction; no binary
  // mantissa smuggling, no silent rounding.
  const text = String(value);
  const sign = text.startsWith('-') ? -1 : 1;
  const unsigned = text.replace(/^-/, '');
  const [intPart, fracPart = ''] = unsigned.split('.');
  if (!/^\d*$/.test(fracPart)) throw new ContractError('NON_DECIMAL_NUMBER', `cannot project to a decimal fraction: ${text}`);
  const denominator = 10 ** fracPart.length;
  const numerator = sign * (Number(intPart) * denominator + Number(fracPart || '0'));
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new ContractError('RATIONAL_OUT_OF_RANGE', `numerator/denominator exceed safe integers: ${text}`);
  }
  return rationalV1(numerator, denominator);
}

export function rationalV1(numerator: number, denominator: number): RationalV1 {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new ContractError('RATIONAL_OUT_OF_RANGE', `not safe integers: ${numerator}/${denominator}`);
  }
  if (denominator <= 0) throw new ContractError('NON_POSITIVE_DENOMINATOR', `denominator must be > 0: ${numerator}/${denominator}`);
  if (numerator === 0) return { numerator: 0, denominator: 1 };
  const factor = gcd(numerator, denominator);
  return { numerator: numerator / factor, denominator: denominator / factor };
}

const r = (beat: { numerator: number; denominator: number }): RationalV1 =>
  rationalV1(beat.numerator, beat.denominator);

// --- NFC + JCS -------------------------------------------------------------

function nfcDeep(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(nfcDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, nfcDeep(entry)]));
  }
  return value;
}

/** RFC 8785 canonical JSON (npm `canonicalize`) over an NFC-normalized tree. */
export function canonicalizeJcs(value: unknown): string {
  const resolved = (jcsModule as unknown as { default?: (input: unknown) => string });
  const jcs = typeof resolved === 'function' ? resolved : resolved.default;
  if (typeof jcs !== 'function') throw new ContractError('JCS_UNAVAILABLE', 'canonicalize export shape not recognized');
  return jcs(nfcDeep(value));
}

function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// --- ScoreDocumentV1 -------------------------------------------------------

const CAPABILITY_ENUM = new Set([
  'chords', 'cue', 'grace', 'microtone', 'multi_staff', 'multi_voice',
  'multiple_parts', 'repeat', 'tempo_curve', 'ties', 'transpose', 'tuplets',
  'unsupported_clef', 'unsupported_transpose', 'unrepresentable_pitch',
]);

export interface ScoreDocumentV1 {
  schemaVersion: 1;
  normalizerVersion: string;
  supportProfileVersion: string;
  scoreRevisionId: string;
  source: { format: 'musicxml-partwise'; sourceFingerprint: string };
  metadata: { workTitle: string; composer: string };
  parts: unknown[];
  tieSpans: unknown[];
  tempoMarks: unknown[];
  capabilities: string[];
}

export function computeScoreRevisionId(sourceFingerprint: string, normalizerVersion: string): string {
  const payload = canonicalizeJcs({ normalizerVersion, sourceFingerprint });
  return `score-revision-v1:sha256:${sha256Hex(payload)}`;
}

/** Deterministic projection of the importer's document + report into V1. */
export function projectScoreDocumentV1(
  document: ScoreDocument,
  report: ImportReport,
): { dto: ScoreDocumentV1; issues: Array<{ code: string; message: string }> } {
  const issues: Array<{ code: string; message: string }> = [];
  const sourceFingerprint = report.fingerprint;
  if (!/^[0-9a-f]{64}$/.test(sourceFingerprint)) {
    throw new ContractError('INVALID_SOURCE_FINGERPRINT', `importer fingerprint is not sha256 hex: ${sourceFingerprint}`);
  }
  const scoreRevisionId = computeScoreRevisionId(`sha256:${sourceFingerprint}`, NORMALIZER_VERSION);

  const eventIds = new Set<string>();
  const partIds = new Set<string>();
  const xmlIds = new Set<string>();
  const capabilities: string[] = [];
  for (const capability of document.capabilities) {
    if (!CAPABILITY_ENUM.has(capability)) {
      issues.push({ code: 'unknown_capability', message: `capability not in frozen enum: ${capability}` });
      continue;
    }
    capabilities.push(capability);
  }
  for (const capability of report.capabilities) {
    if (CAPABILITY_ENUM.has(capability) && !capabilities.includes(capability)) capabilities.push(capability);
  }
  capabilities.sort();

  const parts = document.parts.map((part) => {
    if (partIds.has(part.id)) issues.push({ code: 'duplicate_part_id', message: `partId duplicated: ${part.id}` });
    partIds.add(part.id);
    return {
      partId: part.id,
      name: part.name,
      staves: part.staves,
      measures: part.measures.map((measure) => ({
        ordinal: measure.ordinal,
        ...(measure.printedNumber !== undefined ? { printedNumber: measure.printedNumber } : {}),
        implicit: measure.implicit,
        startBeat: r(measure.startBeat),
        durationBeat: r(measure.durationBeat),
        attributes: {
          divisions: measure.attributes.divisions,
          time: {
            beats: measure.attributes.time.beats,
            beatType: measure.attributes.time.beatType,
          },
          key: {
            fifths: measure.attributes.key.fifths,
            mode: measure.attributes.key.mode,
          },
          staves: measure.attributes.staves,
          clefs: measure.attributes.clefs.map((clef) => ({
            staffNumber: clef.staffNumber,
            sign: clef.sign,
            line: clef.line,
          })),
        },
        events: measure.events.map((event) => projectEvent(event, eventIds, xmlIds)),
        barlines: measure.barlines.map((barline) => ({
          ...(barline.location !== undefined ? { location: barline.location } : {}),
          ...(barline.barStyle !== undefined ? { barStyle: barline.barStyle } : {}),
          ...(barline.repeat ? {
            repeat: {
              direction: barline.repeat.direction,
              ...(barline.repeat.times !== undefined ? { times: barline.repeat.times } : {}),
              ...(barline.repeat.afterJump ? { afterJump: barline.repeat.afterJump } : {}),
            },
          } : {}),
          ...(barline.ending ? {
            ending: {
              type: barline.ending.type,
              ...(barline.ending.number !== undefined ? { number: barline.ending.number } : {}),
            },
          } : {}),
        })),
        capabilities: [...measure.capabilities].filter((capability) => capability === 'chords' || capability === 'tuplets').sort(),
      })),
    };
  });

  const tieSpans = document.tieSpans.map((span) => ({
    id: span.id,
    pitchKey: span.pitchKey,
    eventIds: [...span.eventIds],
    startBeat: r(span.startBeat),
    endBeat: r(span.endBeat),
  }));

  const tempoMarks = document.tempoMarks.map((mark) => ({
    measureOrdinal: mark.measureOrdinal,
    beat: r(mark.beat),
    bpm: numberToRationalV1(mark.bpm),
    kind: mark.kind,
  }));

  const dto: ScoreDocumentV1 = {
    schemaVersion: 1,
    normalizerVersion: NORMALIZER_VERSION,
    supportProfileVersion: SUPPORT_PROFILE_VERSION_V1,
    scoreRevisionId,
    source: { format: 'musicxml-partwise', sourceFingerprint: `sha256:${sourceFingerprint}` },
    metadata: { workTitle: document.workTitle, composer: document.composer },
    parts,
    tieSpans,
    tempoMarks,
    capabilities,
  };
  return { dto, issues };
}

function projectEvent(event: ScoreEvent, eventIds: Set<string>, xmlIds: Set<string>) {
  if (event.source.xmlId) {
    // duplicate_xml_id is already a blocking import issue; the projection
    // refuses to normalize such a document rather than picking a winner.
    if (xmlIds.has(event.source.xmlId)) {
      throw new ContractError('DUPLICATE_XML_ID', `note@id duplicated: ${event.source.xmlId}`);
    }
    xmlIds.add(event.source.xmlId);
  }
  if (eventIds.has(event.id)) {
    throw new ContractError('DUPLICATE_EVENT_ID', `eventId duplicated: ${event.id}`);
  }
  eventIds.add(event.id);
  return {
    eventId: event.id,
    kind: event.kind,
    source: {
      partId: event.source.partId,
      measureOrdinal: event.source.measureOrdinal,
      staffNumber: event.source.staffNumber,
      sourceOrdinal: event.source.sourceOrdinal,
      ...(event.source.printedMeasureNumber !== undefined ? { printedMeasureNumber: event.source.printedMeasureNumber } : {}),
      ...(event.source.voiceId !== undefined ? { voiceId: event.source.voiceId } : {}),
      ...(event.source.xmlId !== undefined ? { xmlId: event.source.xmlId } : {}),
    },
    onsetBeat: r(event.onsetBeat),
    durationBeat: r(event.durationBeat),
    ...(event.notatedType !== undefined ? { notatedType: event.notatedType } : {}),
    dots: event.dots,
    ...(event.pitch ? {
      pitch: {
        step: event.pitch.step,
        alter: numberToRationalV1(event.pitch.alter),
        octave: event.pitch.octave,
        midiNote: event.pitch.midiNote,
        spelling: event.pitch.spelling,
      },
    } : {}),
    ...(event.chordGroupId !== undefined ? { chordGroupId: event.chordGroupId } : {}),
    tieStart: event.tieStart,
    tieStop: event.tieStop,
    tiedStart: event.tiedStart,
    tiedStop: event.tiedStop,
    ...(event.tieSpanId !== undefined ? { tieSpanId: event.tieSpanId } : {}),
    isGrace: event.isGrace,
    isCue: event.isCue,
    ...(event.lyricText !== undefined ? { lyricText: event.lyricText } : {}),
    articulations: [...event.articulations],
    ...(event.timeModification ? {
      timeModification: {
        actualNotes: event.timeModification.actualNotes,
        normalNotes: event.timeModification.normalNotes,
      },
    } : {}),
  };
}

/** Schema-shaped structural validation (independent of ajv; closed checks). */
export function validateScoreDocumentV1(dto: unknown): Array<{ code: string; message: string }> {
  const issues: Array<{ code: string; message: string }> = [];
  if (!dto || typeof dto !== 'object') return [{ code: 'invalid_document', message: 'not an object' }];
  const record = dto as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    issues.push({ code: 'unknown_schema_version', message: `schemaVersion must be 1, got ${String(record.schemaVersion)}` });
    return issues;
  }
  for (const key of ['normalizerVersion', 'supportProfileVersion', 'scoreRevisionId']) {
    if (typeof record[key] !== 'string' || (record[key] as string).length === 0) {
      issues.push({ code: 'missing_field', message: `${key} must be a non-empty string` });
    }
  }
  if (typeof record.scoreRevisionId === 'string'
    && !/^score-revision-v1:sha256:[0-9a-f]{64}$/.test(record.scoreRevisionId)) {
    issues.push({ code: 'invalid_revision_id', message: 'scoreRevisionId does not match the frozen pattern' });
  }
  for (const key of ['parts', 'tieSpans', 'tempoMarks', 'capabilities']) {
    if (!Array.isArray(record[key])) issues.push({ code: 'missing_field', message: `${key} must be an array` });
  }
  return issues;
}

// --- planFingerprintV1 -----------------------------------------------------

export interface PlanFingerprintPayloadV1 {
  fingerprintSchemaVersion: 1;
  plannerVersion: string;
  scoreRevisionId: string;
  normalizerVersion: string;
  supportProfileVersion: string;
  scope: {
    partId: string;
    range: { startMeasureOrdinal: number; endMeasureOrdinal: number };
    hand: PracticeHand;
    handMapping: HandMappingV1;
  };
  repeatSelection: { kind: 'none' } | { kind: 'range-loop'; count: number };
  tempo: {
    bpm: RationalV1;
    ticksPerQuarter: number;
    countInBeats: RationalV1;
    timeOrigin: 'playback-start';
  };
  targetGroups: Array<{
    groupIndex: number;
    passIndex: number;
    bar: number;
    onsetBeatFromRangeStart: RationalV1;
    durationBeat: RationalV1;
    beatInMeasure: RationalV1;
    staffNumbers: number[];
    voiceIds: string[];
    members: Array<{
      sourceLocator: { partId: string; measureOrdinal: number; sourceOrdinal: number; voiceId?: string };
      pitch: { midiNote: number; spelling: string };
      durationBeat: RationalV1;
      isTieOnset?: boolean;
    }>;
  }>;
}

export function buildPlanFingerprintPayloadV1(input: {
  plannerVersion: string;
  scoreRevisionId: string;
  normalizerVersion: string;
  supportProfileVersion: string;
  partId: string;
  range: { startMeasureOrdinal: number; endMeasureOrdinal: number };
  hand: PracticeHand;
  handMapping: HandMappingV1;
  repeatSelection: { kind: 'none' } | { kind: 'range-loop'; count: number };
  bpm: { numerator: number; denominator: number };
  ticksPerQuarter: number;
  countInBeats: { numerator: number; denominator: number };
  plan: PlaybackPlan;
}): PlanFingerprintPayloadV1 {
  const targetGroups = input.plan.groups.map((group: PlaybackGroup, index: number) => ({
    groupIndex: index,
    passIndex: group.occurrenceIds.length > 0
      ? (input.plan.occurrences.find((occurrence) => occurrence.occurrenceId === group.occurrenceIds[0])?.passIndex ?? 0)
      : 0,
    bar: group.bar,
    onsetBeatFromRangeStart: r(group.playbackBeat),
    durationBeat: r(group.durationBeat),
    beatInMeasure: r(group.beatInMeasure),
    staffNumbers: [...group.staffNumbers].sort((a, b) => a - b),
    voiceIds: [...group.voiceIds].sort(),
    members: group.scoreEventIds.map((eventId) => {
      const occurrence = input.plan.occurrences.find((entry: { scoreEventId: string; measureOrdinal: number; voiceId?: string; pitch?: { midiNote: number | null; spelling: string }; durationBeat: { numerator: number; denominator: number }; isTieOnset?: boolean }) => entry.scoreEventId === eventId);
      if (!occurrence) throw new ContractError('MEMBER_NOT_IN_PLAN', `scoreEvent ${eventId} has no occurrence`);
      return {
        sourceLocator: {
          partId: occurrence.scoreEventId.split(':')[1] ?? '',
          measureOrdinal: occurrence.measureOrdinal,
          sourceOrdinal: Number(occurrence.scoreEventId.split(':e')[1] ?? '0'),
          ...(occurrence.voiceId !== undefined ? { voiceId: occurrence.voiceId } : {}),
        },
        pitch: {
          midiNote: occurrence.pitch?.midiNote ?? NaN,
          spelling: occurrence.pitch?.spelling ?? '',
        },
        durationBeat: r(occurrence.durationBeat),
        ...(occurrence.isTieOnset ? { isTieOnset: true } : {}),
      };
    }),
  }));
  for (const group of targetGroups) {
    for (const member of group.members) {
      if (!Number.isInteger(member.pitch.midiNote)) {
        throw new ContractError('UNMAPPABLE_PITCH', 'group member has no MIDI pitch; strict plan cannot be fingerprinted');
      }
    }
  }
  return {
    fingerprintSchemaVersion: 1,
    plannerVersion: input.plannerVersion,
    scoreRevisionId: input.scoreRevisionId,
    normalizerVersion: input.normalizerVersion,
    supportProfileVersion: input.supportProfileVersion,
    scope: {
      partId: input.partId,
      range: { ...input.range },
      hand: input.hand,
      handMapping: input.handMapping,
    },
    repeatSelection: { ...input.repeatSelection },
    tempo: {
      bpm: rationalV1(input.bpm.numerator, input.bpm.denominator),
      ticksPerQuarter: input.ticksPerQuarter,
      countInBeats: rationalV1(input.countInBeats.numerator, input.countInBeats.denominator),
      timeOrigin: 'playback-start',
    },
    targetGroups,
  };
}

export function computePlanFingerprintV1(payload: PlanFingerprintPayloadV1): string {
  if (payload.fingerprintSchemaVersion !== 1) {
    throw new ContractError('UNKNOWN_FINGERPRINT_SCHEMA', `fingerprintSchemaVersion must be 1, got ${String(payload.fingerprintSchemaVersion)}`);
  }
  if (payload.targetGroups.length === 0) {
    throw new ContractError('EMPTY_PLAN', 'refusing to fingerprint an empty target list');
  }
  return `plan-v1:sha256:${sha256Hex(canonicalizeJcs(payload))}`;
}

/** time-conversion-v1: non-negative, nearest integer, exact .5 rounds up. */
export function beatToMicroseconds(beat: RationalV1, bpm: RationalV1): number {
  if (beat.numerator < 0) throw new ContractError('NEGATIVE_TIME', 'beat must be non-negative');
  if (bpm.numerator <= 0) throw new ContractError('INVALID_BPM', 'bpm must be positive');
  const exact = (beat.numerator * 60_000_000 * bpm.denominator) / (beat.denominator * bpm.numerator);
  return Math.floor(exact + 0.5);
}
