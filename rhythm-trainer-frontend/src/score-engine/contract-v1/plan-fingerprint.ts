import { createHash } from 'node:crypto';
import jcsModule from 'canonicalize';
import Ajv2020 from 'ajv/dist/2020';
import scoreDocumentSchema from '../../../../audit-r1/contracts/score-document-v1.schema.json';
import planFingerprintPayloadSchema from '../../../../audit-r1/contracts/plan-fingerprint-payload-v1.schema.json';
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

const SAFE_INT_MAX = 2 ** 53 - 1;

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

/** true when the pair is a valid, fully-reduced RationalV1. */
export function isCanonicalRationalV1(value: unknown): value is RationalV1 {
  if (!value || typeof value !== 'object') return false;
  const { numerator, denominator } = value as Record<string, unknown>;
  if (typeof numerator !== 'number' || typeof denominator !== 'number') return false;
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) return false;
  if (numerator < -SAFE_INT_MAX || numerator > SAFE_INT_MAX) return false;
  if (denominator < 1 || denominator > SAFE_INT_MAX) return false;
  if (numerator === 0) return denominator === 1;
  return gcd(numerator, denominator) === 1;
}

/**
 * Exact rational from a JS number via its canonical decimal representation.
 * Handles plain decimals and exponent forms (1e-7 -> 1/10^7). No IEEE-754
 * binary approximation is ever written into the numerator/denominator.
 */
export function numberToRationalV1(value: number): RationalV1 {
  if (!Number.isFinite(value)) throw new ContractError('NON_FINITE_NUMBER', `not a finite number: ${String(value)}`);
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) {
      throw new ContractError('RATIONAL_OUT_OF_RANGE', `integer exceeds safe range: ${String(value)}`);
    }
    return { numerator: value, denominator: 1 };
  }
  const text = String(value);
  const sign = text.startsWith('-') ? -1 : 1;
  const unsigned = text.replace(/^-/, '');
  // Split off an exponent part (e.g. 1.5e-7). The mantissa keeps its decimal
  // point; the exponent shifts it exactly in decimal digits.
  const exponentMatch = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(unsigned);
  let intDigits: string;
  let fracDigits: string;
  if (exponentMatch) {
    const [, mantissaInt, mantissaFrac = '', exponentText] = exponentMatch;
    let digits = mantissaInt + mantissaFrac;
    let exponent = Number(exponentText);
    // Shift the decimal point by the exponent, digit-exact.
    if (exponent >= 0) {
      if (exponent >= mantissaFrac.length) {
        digits = digits + '0'.repeat(exponent - mantissaFrac.length);
        intDigits = digits;
        fracDigits = '';
      } else {
        intDigits = digits.slice(0, mantissaInt.length + exponent);
        fracDigits = digits.slice(mantissaInt.length + exponent);
      }
    } else {
      const shift = -exponent;
      if (shift >= digits.length) {
        intDigits = '0';
        fracDigits = '0'.repeat(shift - digits.length) + digits;
      } else {
        intDigits = digits.slice(0, digits.length - shift);
        fracDigits = digits.slice(digits.length - shift);
      }
    }
  } else {
    const plain = /^(\d+)\.(\d+)$/.exec(unsigned);
    if (!plain) throw new ContractError('NON_DECIMAL_NUMBER', `cannot project to a decimal fraction: ${text}`);
    intDigits = plain[1];
    fracDigits = plain[2];
  }
  const denominator = 10 ** fracDigits.length;
  const numerator = sign * (Number(intDigits) * denominator + Number(fracDigits || '0'));
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
  // The document and the report must describe the SAME source file; a mismatch
  // would stamp A's notes with B's identity.
  if (document.fingerprint !== report.fingerprint) {
    throw new ContractError('DOCUMENT_REPORT_MISMATCH',
      `document fingerprint ${document.fingerprint} does not match report fingerprint ${report.fingerprint}`);
  }
  const scoreRevisionId = computeScoreRevisionId(`sha256:${sourceFingerprint}`, NORMALIZER_VERSION);

  const eventIds = new Set<string>();
  const partIds = new Set<string>();
  const xmlIds = new Set<string>();
  const capabilities: string[] = [];
  for (const capability of document.capabilities) {
    if (!CAPABILITY_ENUM.has(capability)) {
      // The enum is closed: an unknown value is a contract break, not a
      // droppable warning. Bump the enum version instead.
      throw new ContractError('UNKNOWN_CAPABILITY', `capability not in frozen enum: ${capability}`);
    }
    capabilities.push(capability);
  }
  for (const capability of report.capabilities) {
    if (CAPABILITY_ENUM.has(capability) && !capabilities.includes(capability)) capabilities.push(capability);
  }
  capabilities.sort();

  const parts = document.parts.map((part) => {
    if (partIds.has(part.id)) {
      throw new ContractError('DUPLICATE_PART_ID', `partId duplicated: ${part.id}`);
    }
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

// --- Schema validation (AJV, JSON Schema Draft 2020-12) --------------------
// The two committed schemas are the AUTHORITY: the reference validators run
// them first, then add the semantic checks a schema cannot express. Keeping
// the schemas in the loop is what makes "schema and implementation agree" an
// automated property instead of a claim.

type Issue = { code: string; message: string };

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateScoreSchema = ajv.compile(scoreDocumentSchema);
const validatePayloadSchema = ajv.compile(planFingerprintPayloadSchema);

function schemaIssues(errors: Array<{ instancePath: string; message?: string }> | null | undefined): Issue[] {
  if (!errors) return [];
  return errors.map((error) => ({
    code: 'schema_violation',
    message: `${error.instancePath || '/'} ${error.message ?? ''}`.trim(),
  }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function checkClosedKeys(value: Record<string, unknown>, allowed: string[], where: string, issues: Issue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push({ code: 'unexpected_field', message: `${where}: unexpected field "${key}"` });
    }
  }
}

function checkRequiredKeys(value: Record<string, unknown>, required: string[], where: string, issues: Issue[]): void {
  for (const key of required) {
    if (!(key in value)) issues.push({ code: 'missing_field', message: `${where}: missing field "${key}"` });
  }
}

function checkRational(value: unknown, where: string, issues: Issue[]): void {
  if (!isCanonicalRationalV1(value)) {
    issues.push({ code: 'invalid_rational', message: `${where}: not a reduced RationalV1` });
  }
}

function checkPositiveInteger(value: unknown, where: string, issues: Issue[], min: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    issues.push({ code: 'invalid_integer', message: `${where}: must be an integer >= ${min}` });
  }
}

const SCORE_DOC_ALLOWED_ROOT = ['schemaVersion', 'normalizerVersion', 'supportProfileVersion', 'scoreRevisionId', 'source', 'metadata', 'parts', 'tieSpans', 'tempoMarks', 'capabilities'];
const SCORE_DOC_REQUIRED_ROOT = SCORE_DOC_ALLOWED_ROOT;

/**
 * Full structural + semantic validation of a ScoreDocumentV1 (closed keys,
 * nested shapes, reduced rationals, uniqueness, cross references, positive
 * durations). Returns a deterministic machine-code issue list; an empty list
 * means the document satisfies the frozen V1 contract.
 */
export function validateScoreDocumentV1(dto: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isPlainObject(dto)) return [{ code: 'invalid_document', message: 'not an object' }];
  if (dto.schemaVersion !== 1) {
    return [{ code: 'unknown_schema_version', message: `schemaVersion must be 1, got ${String(dto.schemaVersion)}` }];
  }
  // Schema-first: the committed JSON Schema is the structural authority.
  if (!validateScoreSchema(dto)) issues.push(...schemaIssues(validateScoreSchema.errors));
  checkClosedKeys(dto, SCORE_DOC_ALLOWED_ROOT, 'root', issues);
  checkRequiredKeys(dto, SCORE_DOC_REQUIRED_ROOT, 'root', issues);
  for (const key of ['normalizerVersion', 'supportProfileVersion']) {
    if (typeof dto[key] !== 'string' || (dto[key] as string).length === 0) {
      issues.push({ code: 'missing_field', message: `${key} must be a non-empty string` });
    }
  }
  if (typeof dto.scoreRevisionId !== 'string'
    || !/^score-revision-v1:sha256:[0-9a-f]{64}$/.test(dto.scoreRevisionId)) {
    issues.push({ code: 'invalid_revision_id', message: 'scoreRevisionId does not match the frozen pattern' });
  }
  if (!isPlainObject(dto.source)) {
    issues.push({ code: 'invalid_source', message: 'source must be an object' });
  } else {
    checkClosedKeys(dto.source, ['format', 'sourceFingerprint'], 'source', issues);
    if (dto.source.format !== 'musicxml-partwise') {
      issues.push({ code: 'invalid_source', message: 'source.format must be musicxml-partwise' });
    }
    if (typeof dto.source.sourceFingerprint !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(dto.source.sourceFingerprint)) {
      issues.push({ code: 'invalid_source', message: 'sourceFingerprint must be sha256:<64 hex>' });
    }
  }
  if (!isPlainObject(dto.metadata)) {
    issues.push({ code: 'invalid_metadata', message: 'metadata must be an object' });
  } else {
    checkClosedKeys(dto.metadata, ['workTitle', 'composer'], 'metadata', issues);
    if (typeof dto.metadata.workTitle !== 'string' || typeof dto.metadata.composer !== 'string') {
      issues.push({ code: 'invalid_metadata', message: 'metadata.workTitle/composer must be strings' });
    }
  }
  if (!Array.isArray(dto.capabilities)) {
    issues.push({ code: 'invalid_capabilities', message: 'capabilities must be an array' });
  } else {
    for (const capability of dto.capabilities) {
      if (typeof capability !== 'string' || !CAPABILITY_ENUM.has(capability)) {
        issues.push({ code: 'unknown_capability', message: `capability not in frozen enum: ${String(capability)}` });
      }
    }
  }

  const partIds = new Set<string>();
  const eventIds = new Set<string>();
  const xmlIds = new Set<string>();
  if (!Array.isArray(dto.parts)) {
    issues.push({ code: 'invalid_parts', message: 'parts must be an array' });
  } else {
    for (const part of dto.parts) {
      if (!isPlainObject(part)) { issues.push({ code: 'invalid_part', message: 'part must be an object' }); continue; }
      checkClosedKeys(part, ['partId', 'name', 'staves', 'measures'], 'part', issues);
      if (typeof part.partId !== 'string' || part.partId.length === 0) {
        issues.push({ code: 'invalid_part', message: 'partId must be a non-empty string' });
      } else if (partIds.has(part.partId)) {
        issues.push({ code: 'duplicate_part_id', message: `partId duplicated: ${part.partId}` });
      } else {
        partIds.add(part.partId);
      }
      checkPositiveInteger(part.staves, 'part.staves', issues, 1);
      if (!Array.isArray(part.measures)) {
        issues.push({ code: 'invalid_measures', message: `part ${String(part.partId)}: measures must be an array` });
        continue;
      }
      const ordinals = new Set<number>();
      let previousOrdinal = 0;
      for (const measure of part.measures) {
        if (!isPlainObject(measure)) { issues.push({ code: 'invalid_measure', message: 'measure must be an object' }); continue; }
        checkClosedKeys(measure, ['ordinal', 'printedNumber', 'implicit', 'startBeat', 'durationBeat', 'attributes', 'events', 'barlines', 'capabilities'], 'measure', issues);
        if (typeof measure.ordinal !== 'number' || !Number.isInteger(measure.ordinal) || measure.ordinal < 1) {
          issues.push({ code: 'invalid_ordinal', message: 'measure.ordinal must be a positive integer' });
        } else {
          if (ordinals.has(measure.ordinal)) {
            issues.push({ code: 'duplicate_ordinal', message: `measure ordinal duplicated: ${measure.ordinal}` });
          }
          if (measure.ordinal !== previousOrdinal + 1) {
            issues.push({ code: 'non_consecutive_ordinal', message: `measure ordinals must be consecutive from 1; got ${measure.ordinal} after ${previousOrdinal}` });
          }
          previousOrdinal = measure.ordinal;
          ordinals.add(measure.ordinal);
        }
        if (typeof measure.implicit !== 'boolean') {
          issues.push({ code: 'invalid_implicit', message: 'measure.implicit must be boolean' });
        }
        checkRational(measure.startBeat, 'measure.startBeat', issues);
        checkRational(measure.durationBeat, 'measure.durationBeat', issues);
        if (!Array.isArray(measure.events)) {
          issues.push({ code: 'invalid_events', message: 'measure.events must be an array' });
        } else {
          for (const event of measure.events) validateEvent(event, issues, part.partId as string, eventIds, xmlIds);
        }
        if (!Array.isArray(measure.barlines)) {
          issues.push({ code: 'invalid_barlines', message: 'measure.barlines must be an array' });
        }
        if (!Array.isArray(measure.capabilities)) {
          issues.push({ code: 'invalid_capabilities', message: 'measure.capabilities must be an array' });
        } else {
          for (const capability of measure.capabilities) {
            if (capability !== 'chords' && capability !== 'tuplets') {
              issues.push({ code: 'unknown_capability', message: `measure capability not in enum: ${String(capability)}` });
            }
          }
        }
      }
    }
  }

  if (!Array.isArray(dto.tieSpans)) {
    issues.push({ code: 'invalid_tie_spans', message: 'tieSpans must be an array' });
  } else {
    for (const span of dto.tieSpans) {
      if (!isPlainObject(span)) { issues.push({ code: 'invalid_tie_span', message: 'tieSpan must be an object' }); continue; }
      checkClosedKeys(span, ['id', 'pitchKey', 'eventIds', 'startBeat', 'endBeat'], 'tieSpan', issues);
      if (!Array.isArray(span.eventIds) || span.eventIds.length < 2) {
        issues.push({ code: 'invalid_tie_span', message: 'tieSpan.eventIds must list at least 2 events' });
      } else {
        for (const eventId of span.eventIds) {
          if (!eventIds.has(eventId)) {
            issues.push({ code: 'dangling_reference', message: `tieSpan references unknown eventId: ${String(eventId)}` });
          }
        }
      }
      checkRational(span.startBeat, 'tieSpan.startBeat', issues);
      checkRational(span.endBeat, 'tieSpan.endBeat', issues);
    }
  }

  if (!Array.isArray(dto.tempoMarks)) {
    issues.push({ code: 'invalid_tempo_marks', message: 'tempoMarks must be an array' });
  } else {
    for (const mark of dto.tempoMarks) {
      if (!isPlainObject(mark)) { issues.push({ code: 'invalid_tempo_mark', message: 'tempoMark must be an object' }); continue; }
      checkClosedKeys(mark, ['measureOrdinal', 'beat', 'bpm', 'kind'], 'tempoMark', issues);
      checkRational(mark.beat, 'tempoMark.beat', issues);
      checkRational(mark.bpm, 'tempoMark.bpm', issues);
      if (mark.kind !== 'metronome' && mark.kind !== 'sound') {
        issues.push({ code: 'invalid_tempo_mark', message: 'tempoMark.kind must be metronome|sound' });
      }
    }
  }
  return issues;
}

function validateEvent(
  event: unknown,
  issues: Issue[],
  partId: string,
  eventIds: Set<string>,
  xmlIds: Set<string>,
): void {
  if (!isPlainObject(event)) { issues.push({ code: 'invalid_event', message: 'event must be an object' }); return; }
  checkClosedKeys(event, ['eventId', 'kind', 'source', 'onsetBeat', 'durationBeat', 'notatedType', 'dots', 'pitch', 'chordGroupId', 'tieStart', 'tieStop', 'tiedStart', 'tiedStop', 'tieSpanId', 'isGrace', 'isCue', 'lyricText', 'articulations', 'timeModification'], 'event', issues);
  if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
    issues.push({ code: 'invalid_event', message: 'eventId must be a non-empty string' });
  } else if (eventIds.has(event.eventId)) {
    issues.push({ code: 'duplicate_event_id', message: `eventId duplicated: ${event.eventId}` });
  } else {
    eventIds.add(event.eventId);
  }
  if (event.kind !== 'note' && event.kind !== 'rest') {
    issues.push({ code: 'invalid_event', message: 'kind must be note|rest' });
  }
  if (event.kind === 'note' && !isPlainObject(event.pitch)) {
    issues.push({ code: 'invalid_event', message: 'kind=note must carry pitch' });
  }
  if (event.kind === 'rest' && 'pitch' in event) {
    issues.push({ code: 'invalid_event', message: 'kind=rest must not carry pitch' });
  }
  checkRational(event.onsetBeat, 'event.onsetBeat', issues);
  checkRational(event.durationBeat, 'event.durationBeat', issues);
  const isGrace = event.isGrace === true;
  if (event.durationBeat && isCanonicalRationalV1(event.durationBeat)) {
    if (!isGrace && event.durationBeat.numerator <= 0) {
      issues.push({ code: 'invalid_event', message: 'non-grace event duration must be positive' });
    }
    if (isGrace && event.durationBeat.numerator < 0) {
      issues.push({ code: 'invalid_event', message: 'grace duration must be non-negative' });
    }
  }
  if (!isPlainObject(event.source)) {
    issues.push({ code: 'invalid_event', message: 'event.source must be an object' });
  } else {
    checkClosedKeys(event.source, ['partId', 'measureOrdinal', 'staffNumber', 'sourceOrdinal', 'printedMeasureNumber', 'voiceId', 'xmlId'], 'event.source', issues);
    if (event.source.partId !== partId) {
      issues.push({ code: 'invalid_event', message: 'event.source.partId does not match its part' });
    }
    checkPositiveInteger(event.source.measureOrdinal, 'event.source.measureOrdinal', issues, 1);
    checkPositiveInteger(event.source.staffNumber, 'event.source.staffNumber', issues, 1);
    checkPositiveInteger(event.source.sourceOrdinal, 'event.source.sourceOrdinal', issues, 1);
    if (event.source.xmlId !== undefined) {
      if (typeof event.source.xmlId !== 'string' || event.source.xmlId.length === 0) {
        issues.push({ code: 'invalid_event', message: 'xmlId must be a non-empty string' });
      } else if (xmlIds.has(event.source.xmlId)) {
        issues.push({ code: 'duplicate_xml_id', message: `note@id duplicated: ${event.source.xmlId}` });
      } else {
        xmlIds.add(event.source.xmlId);
      }
    }
  }
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

type PlanOccurrenceLike = {
  scoreEventId: string;
  sourcePartId: string;
  sourceMeasureOrdinal: number;
  sourceOrdinal: number;
  measureOrdinal: number;
  voiceId?: string;
  passIndex: number;
  pitch?: { midiNote: number | null; spelling: string };
  durationBeat: { numerator: number; denominator: number };
  isTieOnset?: boolean;
};

/** Deterministic order for a hand mapping (see the payload scope comment). */
function canonicalHandMapping(mapping: HandMappingV1): HandMappingV1 {
  const comparePartIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    ...mapping,
    parts: [...mapping.parts]
      .map((part) => ({
        ...part,
        staves: [...part.staves].sort((a, b) => a.staffNumber - b.staffNumber),
      }))
      .sort((a, b) => comparePartIds(a.partId, b.partId)),
  };
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
  const occurrences = input.plan.occurrences as readonly PlanOccurrenceLike[];
  const byScoreEventId = new Map<string, PlanOccurrenceLike>();
  for (const occurrence of occurrences) byScoreEventId.set(occurrence.scoreEventId, occurrence);

  const targetGroups = input.plan.groups.map((group: PlaybackGroup, index: number) => {
    const firstOccurrence = group.occurrenceIds.length > 0
      ? occurrences.find((entry) => entry.scoreEventId === group.scoreEventIds[0] || entry.scoreEventId === group.scoreEventIds[0])
      : undefined;
    return {
      groupIndex: index,
      passIndex: firstOccurrence?.passIndex ?? 0,
      bar: group.bar,
      onsetBeatFromRangeStart: r(group.playbackBeat),
      durationBeat: r(group.durationBeat),
      beatInMeasure: r(group.beatInMeasure),
      staffNumbers: [...group.staffNumbers].sort((a, b) => a - b),
      voiceIds: [...group.voiceIds].sort(),
      members: group.scoreEventIds.map((scoreEventId) => {
        const occurrence = byScoreEventId.get(scoreEventId);
        if (!occurrence) throw new ContractError('MEMBER_NOT_IN_PLAN', `scoreEvent ${scoreEventId} has no occurrence`);
        if (typeof occurrence.sourcePartId !== 'string'
          || !Number.isInteger(occurrence.sourceMeasureOrdinal)
          || !Number.isInteger(occurrence.sourceOrdinal)) {
          throw new ContractError('LOCATOR_UNAVAILABLE',
            `occurrence for ${scoreEventId} lacks a semantic source locator (planner must fill sourcePartId/sourceMeasureOrdinal/sourceOrdinal)`);
        }
        return {
          sourceLocator: {
            partId: occurrence.sourcePartId,
            measureOrdinal: occurrence.sourceMeasureOrdinal,
            sourceOrdinal: occurrence.sourceOrdinal,
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
    };
  });
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
      // The mapping is a SET of assignments: array order carries no semantics,
      // so the payload canonicalizes it (parts by partId, staves by staff
      // number). Equivalent mappings in any input order produce identical
      // fingerprints.
      handMapping: canonicalHandMapping(input.handMapping),
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

/** Full closed validation of the fingerprint payload; empty list = valid. */
export function validatePlanFingerprintPayloadV1(payload: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isPlainObject(payload)) return [{ code: 'invalid_payload', message: 'not an object' }];
  if (payload.fingerprintSchemaVersion !== 1) {
    return [{ code: 'unknown_schema_version', message: `fingerprintSchemaVersion must be 1, got ${String(payload.fingerprintSchemaVersion)}` }];
  }
  // Schema-first: the committed JSON Schema is the structural authority.
  if (!validatePayloadSchema(payload)) issues.push(...schemaIssues(validatePayloadSchema.errors));
  checkClosedKeys(payload, ['fingerprintSchemaVersion', 'plannerVersion', 'scoreRevisionId', 'normalizerVersion', 'supportProfileVersion', 'scope', 'repeatSelection', 'tempo', 'targetGroups'], 'payload', issues);
  checkRequiredKeys(payload, ['fingerprintSchemaVersion', 'plannerVersion', 'scoreRevisionId', 'normalizerVersion', 'supportProfileVersion', 'scope', 'tempo', 'targetGroups'], 'payload', issues);
  for (const key of ['plannerVersion', 'normalizerVersion', 'supportProfileVersion']) {
    if (typeof payload[key] !== 'string' || (payload[key] as string).length === 0) {
      issues.push({ code: 'missing_field', message: `${key} must be a non-empty string` });
    }
  }
  if (typeof payload.scoreRevisionId !== 'string'
    || !/^score-revision-v1:sha256:[0-9a-f]{64}$/.test(payload.scoreRevisionId)) {
    issues.push({ code: 'invalid_revision_id', message: 'scoreRevisionId does not match the frozen pattern' });
  }

  if (!isPlainObject(payload.scope)) {
    issues.push({ code: 'invalid_scope', message: 'scope must be an object' });
  } else {
    const scope = payload.scope;
    checkClosedKeys(scope, ['partId', 'range', 'hand', 'handMapping'], 'scope', issues);
    if (typeof scope.partId !== 'string' || scope.partId.length === 0) {
      issues.push({ code: 'invalid_scope', message: 'scope.partId must be a non-empty string' });
    }
    if (!isPlainObject(scope.range)) {
      issues.push({ code: 'invalid_scope', message: 'scope.range must be an object' });
    } else {
      checkClosedKeys(scope.range, ['startMeasureOrdinal', 'endMeasureOrdinal'], 'scope.range', issues);
      checkPositiveInteger(scope.range.startMeasureOrdinal, 'scope.range.start', issues, 1);
      checkPositiveInteger(scope.range.endMeasureOrdinal, 'scope.range.end', issues, 1);
      if (typeof scope.range.startMeasureOrdinal === 'number' && typeof scope.range.endMeasureOrdinal === 'number'
        && scope.range.endMeasureOrdinal < scope.range.startMeasureOrdinal) {
        issues.push({ code: 'invalid_scope', message: 'scope.range end must be >= start' });
      }
    }
    if (scope.hand !== 'left' && scope.hand !== 'right' && scope.hand !== 'both') {
      issues.push({ code: 'invalid_scope', message: 'scope.hand must be left|right|both' });
    }
    if (!isPlainObject(scope.handMapping)) {
      issues.push({ code: 'invalid_scope', message: 'scope.handMapping must be an object' });
    } else {
      const mapping = scope.handMapping;
      checkClosedKeys(mapping, ['schemaVersion', 'mappingVersion', 'source', 'parts'], 'handMapping', issues);
      if (mapping.source !== 'user' && mapping.source !== 'score-metadata') {
        // clef-heuristic is display-only and must never enter the payload.
        issues.push({ code: 'invalid_scope', message: `handMapping.source must be user|score-metadata (got ${String(mapping.source)})` });
      }
      if (mapping.schemaVersion !== 1) {
        issues.push({ code: 'invalid_scope', message: 'handMapping.schemaVersion must be 1' });
      }
      if (!Array.isArray(mapping.parts)) {
        issues.push({ code: 'invalid_scope', message: 'handMapping.parts must be an array' });
      }
    }
  }

  if (payload.repeatSelection !== undefined) {
    if (!isPlainObject(payload.repeatSelection)) {
      issues.push({ code: 'invalid_repeat', message: 'repeatSelection must be an object' });
    } else {
      const repeat = payload.repeatSelection;
      if (repeat.kind === 'none') {
        checkClosedKeys(repeat, ['kind'], 'repeatSelection', issues);
      } else if (repeat.kind === 'range-loop') {
        checkClosedKeys(repeat, ['kind', 'count'], 'repeatSelection', issues);
        if (typeof repeat.count !== 'number' || !Number.isInteger(repeat.count) || repeat.count < 1 || repeat.count > 32) {
          issues.push({ code: 'invalid_repeat', message: 'range-loop count must be an integer 1-32' });
        }
      } else {
        issues.push({ code: 'invalid_repeat', message: 'repeatSelection.kind must be none|range-loop' });
      }
    }
  }

  if (!isPlainObject(payload.tempo)) {
    issues.push({ code: 'invalid_tempo', message: 'tempo must be an object' });
  } else {
    const tempo = payload.tempo;
    checkClosedKeys(tempo, ['bpm', 'ticksPerQuarter', 'countInBeats', 'timeOrigin'], 'tempo', issues);
    checkRational(tempo.bpm, 'tempo.bpm', issues);
    checkRational(tempo.countInBeats, 'tempo.countInBeats', issues);
    if (isCanonicalRationalV1(tempo.bpm) && tempo.bpm.numerator <= 0) {
      issues.push({ code: 'invalid_tempo', message: 'tempo.bpm must be positive' });
    }
    checkPositiveInteger(tempo.ticksPerQuarter, 'tempo.ticksPerQuarter', issues, 1);
    if (tempo.timeOrigin !== 'playback-start') {
      issues.push({ code: 'invalid_tempo', message: 'tempo.timeOrigin must be playback-start' });
    }
  }

  if (!Array.isArray(payload.targetGroups) || payload.targetGroups.length === 0) {
    issues.push({ code: 'empty_plan', message: 'targetGroups must be a non-empty array' });
    return issues;
  }
  const groupIndexes = new Set<number>();
  for (const [groupPosition, group] of payload.targetGroups.entries()) {
    if (!isPlainObject(group)) { issues.push({ code: 'invalid_group', message: 'targetGroup must be an object' }); continue; }
    checkClosedKeys(group, ['groupIndex', 'passIndex', 'bar', 'onsetBeatFromRangeStart', 'durationBeat', 'beatInMeasure', 'staffNumbers', 'voiceIds', 'members'], 'targetGroup', issues);
    if (typeof group.groupIndex !== 'number' || !Number.isInteger(group.groupIndex) || group.groupIndex < 0) {
      issues.push({ code: 'invalid_group', message: 'groupIndex must be a non-negative integer' });
    } else if (groupIndexes.has(group.groupIndex)) {
      issues.push({ code: 'duplicate_group_index', message: `groupIndex duplicated: ${group.groupIndex}` });
    } else {
      groupIndexes.add(group.groupIndex);
    }
    // The index must be the array position: the payload's group order IS the
    // playback order, so a reordered or sparse numbering is a contract break.
    if (typeof group.groupIndex === 'number' && Number.isInteger(group.groupIndex)
      && group.groupIndex !== groupPosition) {
      issues.push({ code: 'group_index_out_of_sequence', message: `groupIndex must equal its array position (position ${groupPosition}, got ${group.groupIndex})` });
    }
    checkPositiveInteger(group.passIndex, 'group.passIndex', issues, 0);
    checkPositiveInteger(group.bar, 'group.bar', issues, 1);
    checkRational(group.onsetBeatFromRangeStart, 'group.onsetBeatFromRangeStart', issues);
    checkRational(group.durationBeat, 'group.durationBeat', issues);
    checkRational(group.beatInMeasure, 'group.beatInMeasure', issues);
    if (!Array.isArray(group.staffNumbers) || group.staffNumbers.length === 0) {
      issues.push({ code: 'invalid_group', message: 'staffNumbers must be a non-empty array' });
    }
    if (!Array.isArray(group.voiceIds) || group.voiceIds.length === 0) {
      issues.push({ code: 'invalid_group', message: 'voiceIds must be a non-empty array' });
    }
    if (!Array.isArray(group.members) || group.members.length === 0) {
      issues.push({ code: 'invalid_group', message: 'members must be a non-empty array' });
      continue;
    }
    const locatorKeys = new Set<string>();
    let longestMember: RationalV1 | null = null;
    for (const member of group.members) {
      if (!isPlainObject(member)) { issues.push({ code: 'invalid_member', message: 'member must be an object' }); continue; }
      checkClosedKeys(member, ['sourceLocator', 'pitch', 'durationBeat', 'isTieOnset'], 'member', issues);
      if (!isPlainObject(member.sourceLocator)) {
        issues.push({ code: 'invalid_member', message: 'member.sourceLocator must be an object' });
      } else {
        checkClosedKeys(member.sourceLocator, ['partId', 'measureOrdinal', 'sourceOrdinal', 'voiceId'], 'member.sourceLocator', issues);
        if (typeof member.sourceLocator.partId !== 'string' || member.sourceLocator.partId.length === 0) {
          issues.push({ code: 'invalid_member', message: 'locator.partId must be a non-empty string' });
        }
        checkPositiveInteger(member.sourceLocator.measureOrdinal, 'locator.measureOrdinal', issues, 1);
        checkPositiveInteger(member.sourceOrdinal ?? member.sourceLocator.sourceOrdinal, 'locator.sourceOrdinal', issues, 1);
        // Two members of one onset group must not claim the same notated
        // source note; that means a duplicated/fabricated member.
        const locatorKey = isPlainObject(member.sourceLocator)
          ? `${member.sourceLocator.partId}:${member.sourceLocator.measureOrdinal}:${member.sourceLocator.sourceOrdinal}:${member.sourceLocator.voiceId ?? ''}`
          : '';
        if (locatorKey && locatorKeys.has(locatorKey)) {
          issues.push({ code: 'duplicate_member_locator', message: `two members of one group claim the same source locator: ${locatorKey}` });
        } else if (locatorKey) {
          locatorKeys.add(locatorKey);
        }
      }
      if (!isPlainObject(member.pitch)
        || typeof member.pitch.midiNote !== 'number'
        || !Number.isInteger(member.pitch.midiNote)
        || member.pitch.midiNote < 0 || member.pitch.midiNote > 127
        || typeof member.pitch.spelling !== 'string' || member.pitch.spelling.length === 0) {
        issues.push({ code: 'invalid_member', message: 'member.pitch must be a MIDI note and spelling' });
      }
      checkRational(member.durationBeat, 'member.durationBeat', issues);
      if (isCanonicalRationalV1(member.durationBeat)) {
        if (longestMember === null
          || member.durationBeat.numerator * longestMember.denominator > longestMember.numerator * member.durationBeat.denominator) {
          longestMember = member.durationBeat;
        }
      }
    }
    // The group's nominal duration is the LONGEST member (the atom records
    // group.durationBeat = max); anything else is a tampered plan.
    if (isCanonicalRationalV1(group.durationBeat) && longestMember
      && (group.durationBeat.numerator !== longestMember.numerator
        || group.durationBeat.denominator !== longestMember.denominator)) {
      issues.push({
        code: 'group_duration_mismatch',
        message: `group ${String(group.groupIndex)} duration ${group.durationBeat.numerator}/${group.durationBeat.denominator} != longest member ${longestMember.numerator}/${longestMember.denominator}`,
      });
    }
  }
  return issues;
}

export function computePlanFingerprintV1(payload: PlanFingerprintPayloadV1): string {
  if (payload.fingerprintSchemaVersion !== 1) {
    throw new ContractError('UNKNOWN_FINGERPRINT_SCHEMA', `fingerprintSchemaVersion must be 1, got ${String(payload.fingerprintSchemaVersion)}`);
  }
  // Fail closed: the payload must satisfy the FULL frozen contract before any
  // hash is produced. Unreduced rationals, unexpected fields, dangling
  // references and malformed scopes are all rejected here.
  const issues = validatePlanFingerprintPayloadV1(payload);
  if (issues.length > 0) {
    throw new ContractError('PAYLOAD_VALIDATION_FAILED',
      `plan fingerprint payload failed V1 validation: ${issues.map((issue) => issue.code).join(', ')} (${issues[0].message})`);
  }
  return `plan-v1:sha256:${sha256Hex(canonicalizeJcs(payload))}`;
}

/**
 * time-conversion-v1: non-negative rational beat + positive rational bpm ->
 * integer microseconds, nearest integer with exact .5 rounding up. Computed
 * with BigInt so intermediate products never leave the exact integer domain:
 *   µs = (beat.num * 60_000_000 * bpm.den) / (beat.den * bpm.num)
 * The numerator/denominator are checked against the safe-integer range, so the
 * result always fits a JSON integer.
 */
export function beatToMicroseconds(beat: RationalV1, bpm: RationalV1): number {
  if (!isCanonicalRationalV1(beat)) throw new ContractError('INVALID_RATIONAL', 'beat is not a reduced RationalV1');
  if (!isCanonicalRationalV1(bpm)) throw new ContractError('INVALID_RATIONAL', 'bpm is not a reduced RationalV1');
  if (beat.numerator < 0) throw new ContractError('NEGATIVE_TIME', 'beat must be non-negative');
  if (bpm.numerator <= 0) throw new ContractError('INVALID_BPM', 'bpm must be positive');
  const numerator = BigInt(beat.numerator) * 60_000_000n * BigInt(bpm.denominator);
  const denominator = BigInt(beat.denominator) * BigInt(bpm.numerator);
  // floor((num + den/2) / den) == round-half-up for non-negative values.
  const rounded = (numerator + denominator / 2n) / denominator;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ContractError('TIME_OUT_OF_RANGE', `microsecond result exceeds safe integers: ${rounded.toString()}`);
  }
  return Number(rounded);
}
