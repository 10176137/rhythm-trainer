// R2-2a: deterministic parity comparator per audit-r1/docs/TS_RUST_PARITY_GATE_V1.md
// (frozen @ 838cd9b). Pure functions over JSON-shaped canonical candidates:
// no IO, no clock, no globals. Every difference must be classified into one of
// the frozen categories; anything unexplainable is `unclassified` and fails.
//
// Canonical shapes are the offline acceptance projections of R2-1 §3.1–§3.4:
// rationals as reduced "n/d" strings, times as exact integer microseconds.
// They are NOT wire objects — EngineScoreEvent keeps its ms fields untouched.

export type DiffCategory =
  | 'identity-mapping'
  | 'serialization-only'
  | 'time-rounding'
  | 'semantic-defect'
  | 'unsupported-behavior'
  | 'unclassified';

export interface ParityDiff {
  path: string;
  category: DiffCategory;
  ruleRef: string;
  left: unknown;
  right: unknown;
  attribution?: string;
}

export interface CanonicalLocator {
  partId: string;
  measureOrdinal: number;
  sourceOrdinal: number;
  voiceId?: string;
}

export interface CanonicalPitch {
  step: string;
  alter: number;
  octave: number;
  midiNote: number;
  spelling: string;
}

export interface CanonicalOccurrence {
  locator: CanonicalLocator;
  passIndex: number;
  playbackBeat: string;
  durationBeat: string;
  measureOrdinal: number;
  bar: number;
  beatInMeasure: string;
  staffNumber: number;
  voiceId: string;
  pitch: CanonicalPitch | null;
  isTieOnset: boolean;
  playbackIndex: number;
}

export interface CanonicalGroup {
  passIndex: number;
  playbackBeat: string;
  members: CanonicalLocator[];
  pitches: string[];
  bar: number;
  beatInMeasure: string;
  staffNumbers: number[];
  voiceIds: string[];
  durationBeat: string;
}

export interface CanonicalAtom {
  startTick: number;
  durationTicks: number;
  bar: number;
  /** Display/serialization field only (R2-1 §3.3); never a truth source. */
  beat: number;
}

export interface CanonicalScoreEvent {
  locator: CanonicalLocator;
  passIndex: number;
  measure: number;
  pitch: number;
  targetOnsetUs: number;
  targetDurationUs: number;
  /** Derived wire identity `staff-{staff}:voice-{voice}` (R2-1 §3.4). */
  partId: string;
  parseConfidence: number;
  /** Candidate-only runtime key aligning the wire snapshot; never compared. */
  runtimeOccurrenceId?: string;
}

export interface RuntimeIdSnapshot {
  planId: string;
  occurrenceIds: string[];
  groupIds: string[];
}

export interface WireMsSnapshot {
  scoreEventId: string;
  beatPosition: number;
  targetOnsetMs: number;
  targetDurationMs: number;
}

export interface ParityCandidate {
  side: string;
  kind: 'expected' | 'candidate';
  occurrences: CanonicalOccurrence[];
  groups: CanonicalGroup[];
  atoms: CanonicalAtom[];
  scoreEvents: CanonicalScoreEvent[];
  /** Candidate-only (TS): runtime IDs checked structurally, never byte-compared. */
  runtimeIds?: RuntimeIdSnapshot;
  /** Candidate-only (TS legacy): current ms wire snapshot for the L3 tracks. */
  wireMs?: WireMsSnapshot[];
}

// ---------------------------------------------------------------------------
// Exact rational helpers ("n/d" text, reduced; BigInt cross-multiplication).
// ---------------------------------------------------------------------------

function parseRational(text: string): { n: number; d: number } {
  const match = /^(-?\d+)\/(\d+)$/.exec(text);
  if (!match) throw new Error(`非法有理数文本: ${text}`);
  return { n: Number(match[1]), d: Number(match[2]) };
}

function gcdNumber(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

export function canonicalRationalText(text: string): string {
  const { n, d } = parseRational(text);
  if (d <= 0) throw new Error(`分母必须为正: ${text}`);
  const sign = n < 0 ? -1 : 1;
  const absN = Math.abs(n);
  if (absN === 0) return '0/1';
  const g = gcdNumber(absN, d);
  return `${sign * (absN / g)}/${d / g}`;
}

export function rationalsEqual(a: string, b: string): boolean {
  const x = parseRational(canonicalRationalText(a));
  const y = parseRational(canonicalRationalText(b));
  return BigInt(x.n) * BigInt(y.d) === BigInt(y.n) * BigInt(x.d);
}

function locatorKey(locator: CanonicalLocator): string {
  return `${locator.partId}:m${locator.measureOrdinal}:e${locator.sourceOrdinal}:v${locator.voiceId ?? ''}`;
}

function occurrenceKey(occurrence: CanonicalOccurrence): string {
  return `${locatorKey(occurrence.locator)}:p${occurrence.passIndex}`;
}

function groupKey(group: CanonicalGroup): string {
  return `p${group.passIndex}@${canonicalRationalText(group.playbackBeat)}`;
}

// ---------------------------------------------------------------------------
// Comparator
// ---------------------------------------------------------------------------

export interface CompareOptions {
  /**
   * Legacy ms → µs comparison track. When the candidate carries a wire
   * snapshot, each |round(ms*1000) − canonical µs| ≤ 1 difference is recorded
   * as `time-rounding` with attribution; larger is a semantic defect.
   * (R2-1 §3.5/§5: the ≤1 µs tolerance exists ONLY for the legacy ms
   * representation, never for canonical integer µs.)
   */
  compareWireMs?: boolean;
}

export function diffCandidates(
  expected: ParityCandidate,
  candidate: ParityCandidate,
  options: CompareOptions = {},
): ParityDiff[] {
  const diffs: ParityDiff[] = [];
  diffOccurrences(expected, candidate, diffs);
  diffGroups(expected, candidate, diffs);
  diffAtoms(expected, candidate, diffs);
  diffScoreEvents(expected, candidate, diffs);
  if (options.compareWireMs !== false) diffWireMs(candidate, diffs);
  checkRuntimeIdRules(candidate, diffs);
  checkClosedKeys(expected, 'expected', diffs);
  checkClosedKeys(candidate, 'candidate', diffs);
  return diffs.sort((a, b) => a.path.localeCompare(b.path));
}

const OCCURRENCE_KEYS = ['locator', 'passIndex', 'playbackBeat', 'durationBeat', 'measureOrdinal',
  'bar', 'beatInMeasure', 'staffNumber', 'voiceId', 'pitch', 'isTieOnset', 'playbackIndex'];
const GROUP_KEYS = ['passIndex', 'playbackBeat', 'members', 'pitches', 'bar', 'beatInMeasure',
  'staffNumbers', 'voiceIds', 'durationBeat'];
const SCORE_EVENT_KEYS = ['locator', 'passIndex', 'measure', 'pitch', 'targetOnsetUs',
  'targetDurationUs', 'partId', 'parseConfidence', 'runtimeOccurrenceId'];
const ATOM_KEYS = ['startTick', 'durationTicks', 'bar', 'beat'];

/**
 * Fail-closed on unknown fields: anything outside the frozen canonical shapes
 * is `unclassified` and blocks the report (task card §4.3). Candidate-only
 * runtime keys (runtimeOccurrenceId) are structural, never semantic.
 */
function checkClosedKeys(candidate: ParityCandidate, sideLabel: string, diffs: ParityDiff[]): void {
  const rule = 'TS_RUST_PARITY_GATE_V1 §3 (closed canonical shapes)';
  const unclassified = (path: string, keys: string[]) => {
    diffs.push({ path, category: 'unclassified', ruleRef: rule, left: 'closed key set', right: keys });
  };
  candidate.occurrences.forEach((occurrence, index) => {
    const extra = Object.keys(occurrence).filter((key) => !OCCURRENCE_KEYS.includes(key));
    if (extra.length) unclassified(`${sideLabel}.occurrences[${index}].{${extra.join(',')}}`, extra);
    const locatorExtra = Object.keys(occurrence.locator).filter((key) => !['partId', 'measureOrdinal', 'sourceOrdinal', 'voiceId'].includes(key));
    if (locatorExtra.length) unclassified(`${sideLabel}.occurrences[${index}].locator.{${locatorExtra.join(',')}}`, locatorExtra);
  });
  candidate.groups.forEach((group, index) => {
    const extra = Object.keys(group).filter((key) => !GROUP_KEYS.includes(key));
    if (extra.length) unclassified(`${sideLabel}.groups[${index}].{${extra.join(',')}}`, extra);
  });
  candidate.atoms.forEach((atom, index) => {
    const extra = Object.keys(atom).filter((key) => !ATOM_KEYS.includes(key));
    if (extra.length) unclassified(`${sideLabel}.atoms[${index}].{${extra.join(',')}}`, extra);
  });
  candidate.scoreEvents.forEach((event, index) => {
    const extra = Object.keys(event).filter((key) => !SCORE_EVENT_KEYS.includes(key));
    if (extra.length) unclassified(`${sideLabel}.scoreEvents[${index}].{${extra.join(',')}}`, extra);
  });
}

function semantic(
  diffs: ParityDiff[],
  path: string,
  ruleRef: string,
  left: unknown,
  right: unknown,
): void {
  diffs.push({ path, category: 'semantic-defect', ruleRef, left, right });
}

function diffOccurrences(expected: ParityCandidate, candidate: ParityCandidate, diffs: ParityDiff[]): void {
  const rule = 'TS_RUST_PARITY_GATE_V1 §3.1';
  const leftByKey = new Map(expected.occurrences.map((o) => [occurrenceKey(o), o]));
  const rightByKey = new Map(candidate.occurrences.map((o) => [occurrenceKey(o), o]));
  for (const [key, want] of leftByKey) {
    const got = rightByKey.get(key);
    if (!got) {
      semantic(diffs, `occurrences[${key}].presence`, rule, 'present', 'missing');
      continue;
    }
    const fields: Array<[string, string | number | boolean | null, string | number | boolean | null, boolean]> = [
      ['playbackBeat', want.playbackBeat, got.playbackBeat, true],
      ['durationBeat', want.durationBeat, got.durationBeat, true],
      ['beatInMeasure', want.beatInMeasure, got.beatInMeasure, true],
      ['bar', want.bar, got.bar, false],
      ['measureOrdinal', want.measureOrdinal, got.measureOrdinal, false],
      ['staffNumber', want.staffNumber, got.staffNumber, false],
      ['voiceId', want.voiceId, got.voiceId, false],
      ['isTieOnset', want.isTieOnset, got.isTieOnset, false],
      ['playbackIndex', want.playbackIndex, got.playbackIndex, false],
    ];
    for (const [field, left, right, rational] of fields) {
      const equal = rational ? rationalsEqual(String(left), String(right)) : left === right;
      if (!equal) semantic(diffs, `occurrences[${key}].${field}`, rule, left, right);
    }
    diffPitch(want.pitch, got.pitch, `occurrences[${key}].pitch`, rule, diffs);
  }
  for (const key of rightByKey.keys()) {
    if (!leftByKey.has(key)) {
      semantic(diffs, `occurrences[${key}].presence`, rule, 'absent', 'present');
    }
  }
}

function diffPitch(
  left: CanonicalPitch | null,
  right: CanonicalPitch | null,
  path: string,
  rule: string,
  diffs: ParityDiff[],
): void {
  if ((left === null) !== (right === null)) {
    semantic(diffs, path, rule, left, right);
    return;
  }
  if (!left || !right) return;
  const fields: Array<keyof CanonicalPitch> = ['step', 'alter', 'octave', 'midiNote', 'spelling'];
  for (const field of fields) {
    if (left[field] !== right[field]) {
      semantic(diffs, `${path}.${field}`, rule, left[field], right[field]);
    }
  }
}

function diffGroups(expected: ParityCandidate, candidate: ParityCandidate, diffs: ParityDiff[]): void {
  const rule = 'TS_RUST_PARITY_GATE_V1 §3.2';
  const leftByKey = new Map(expected.groups.map((g) => [groupKey(g), g]));
  const rightByKey = new Map(candidate.groups.map((g) => [groupKey(g), g]));
  for (const [key, want] of leftByKey) {
    const got = rightByKey.get(key);
    if (!got) {
      semantic(diffs, `groups[${key}].presence`, rule, 'present', 'missing');
      continue;
    }
    if (want.members.length !== got.members.length) {
      semantic(diffs, `groups[${key}].members.length`, rule, want.members.length, got.members.length);
    } else {
      for (let i = 0; i < want.members.length; i += 1) {
        if (locatorKey(want.members[i]) !== locatorKey(got.members[i])) {
          semantic(diffs, `groups[${key}].members[${i}]`, rule, locatorKey(want.members[i]), locatorKey(got.members[i]));
        }
      }
    }
    if (want.pitches.join(',') !== got.pitches.join(',')) {
      semantic(diffs, `groups[${key}].pitches`, rule, want.pitches, got.pitches);
    }
    if (!rationalsEqual(want.durationBeat, got.durationBeat)) {
      semantic(diffs, `groups[${key}].durationBeat`, rule, want.durationBeat, got.durationBeat);
    }
    if (!rationalsEqual(want.beatInMeasure, got.beatInMeasure)) {
      semantic(diffs, `groups[${key}].beatInMeasure`, rule, want.beatInMeasure, got.beatInMeasure);
    }
    if (want.bar !== got.bar) semantic(diffs, `groups[${key}].bar`, rule, want.bar, got.bar);
    if (want.staffNumbers.join(',') !== got.staffNumbers.join(',')) {
      semantic(diffs, `groups[${key}].staffNumbers`, rule, want.staffNumbers, got.staffNumbers);
    }
    if (want.voiceIds.join(',') !== got.voiceIds.join(',')) {
      semantic(diffs, `groups[${key}].voiceIds`, rule, want.voiceIds, got.voiceIds);
    }
  }
  for (const key of rightByKey.keys()) {
    if (!leftByKey.has(key)) semantic(diffs, `groups[${key}].presence`, rule, 'absent', 'present');
  }
}

function diffAtoms(expected: ParityCandidate, candidate: ParityCandidate, diffs: ParityDiff[]): void {
  const rule = 'TS_RUST_PARITY_GATE_V1 §3.3';
  const byTick = (atoms: CanonicalAtom[]) => new Map(atoms.map((a) => [a.startTick, a]));
  const left = byTick(expected.atoms);
  const right = byTick(candidate.atoms);
  for (const [tick, want] of left) {
    const got = right.get(tick);
    if (!got) {
      semantic(diffs, `atoms[tick=${tick}].presence`, rule, 'present', 'missing');
      continue;
    }
    if (want.durationTicks !== got.durationTicks) {
      semantic(diffs, `atoms[tick=${tick}].durationTicks`, rule, want.durationTicks, got.durationTicks);
    }
    if (want.bar !== got.bar) semantic(diffs, `atoms[tick=${tick}].bar`, rule, want.bar, got.bar);
    if (want.beat !== got.beat) {
      // Display field: recorded as serialization-only, never a truth source.
      diffs.push({
        path: `atoms[tick=${tick}].beat`,
        category: 'serialization-only',
        ruleRef: rule,
        left: want.beat,
        right: got.beat,
      });
    }
  }
  for (const tick of right.keys()) {
    if (!left.has(tick)) semantic(diffs, `atoms[tick=${tick}].presence`, rule, 'absent', 'present');
  }
}

function diffScoreEvents(expected: ParityCandidate, candidate: ParityCandidate, diffs: ParityDiff[]): void {
  const rule = 'TS_RUST_PARITY_GATE_V1 §3.4/§3.5';
  const keyOf = (event: CanonicalScoreEvent) => `${locatorKey(event.locator)}:p${event.passIndex}`;
  const leftByKey = new Map(expected.scoreEvents.map((e) => [keyOf(e), e]));
  const rightByKey = new Map(candidate.scoreEvents.map((e) => [keyOf(e), e]));
  for (const [key, want] of leftByKey) {
    const got = rightByKey.get(key);
    if (!got) {
      semantic(diffs, `scoreEvents[${key}].presence`, rule, 'present', 'missing');
      continue;
    }
    if (want.measure !== got.measure) semantic(diffs, `scoreEvents[${key}].measure`, rule, want.measure, got.measure);
    if (want.pitch !== got.pitch) semantic(diffs, `scoreEvents[${key}].pitch`, rule, want.pitch, got.pitch);
    // Canonical µs are exact integer truth — no tolerance on either side.
    if (want.targetOnsetUs !== got.targetOnsetUs) {
      semantic(diffs, `scoreEvents[${key}].targetOnsetUs`, rule, want.targetOnsetUs, got.targetOnsetUs);
    }
    if (want.targetDurationUs !== got.targetDurationUs) {
      semantic(diffs, `scoreEvents[${key}].targetDurationUs`, rule, want.targetDurationUs, got.targetDurationUs);
    }
    if (want.partId !== got.partId) semantic(diffs, `scoreEvents[${key}].partId`, rule, want.partId, got.partId);
    if (want.parseConfidence !== got.parseConfidence) {
      semantic(diffs, `scoreEvents[${key}].parseConfidence`, rule, want.parseConfidence, got.parseConfidence);
    }
  }
  for (const key of rightByKey.keys()) {
    if (!leftByKey.has(key)) semantic(diffs, `scoreEvents[${key}].presence`, rule, 'absent', 'present');
  }
}

function diffWireMs(candidate: ParityCandidate, diffs: ParityDiff[]): void {
  if (!candidate.wireMs) return;
  const rule = 'TS_RUST_PARITY_GATE_V1 §3.5 (legacy ms track)';
  if (candidate.wireMs.length !== candidate.scoreEvents.length) {
    semantic(diffs, 'wireMs.length', rule, candidate.scoreEvents.length, candidate.wireMs.length);
    return;
  }
  // buildEngineScoreEvents sorts by (onsetMs, scoreEventId) while the canonical
  // events follow plan order — align via the runtime occurrence id.
  const wireByOccurrenceId = new Map(candidate.wireMs.map((wire) => [wire.scoreEventId, wire]));
  const seenWireIds = new Set<string>();
  candidate.scoreEvents.forEach((canonical) => {
    const id = canonical.runtimeOccurrenceId;
    const wire = id ? wireByOccurrenceId.get(id) : undefined;
    if (!wire) {
      if (id) semantic(diffs, `wireMs[${id}].presence`, rule, 'present', 'missing');
      return;
    }
    seenWireIds.add(wire.scoreEventId);
    const fields: Array<['targetOnsetMs' | 'targetDurationMs', number]> = [
      ['targetOnsetMs', canonical.targetOnsetUs],
      ['targetDurationMs', canonical.targetDurationUs],
    ];
    for (const [msField, usValue] of fields) {
      const legacyUs = Math.round(wire[msField] * 1000);
      const delta = legacyUs - usValue;
      if (delta === 0) continue;
      if (Math.abs(delta) <= 1) {
        diffs.push({
          path: `wireMs[${id}].${msField}`,
          category: 'time-rounding',
          ruleRef: rule,
          left: usValue,
          right: legacyUs,
          attribution: `legacy float ms ${wire[msField]} -> µs ${legacyUs} vs canonical ${usValue} (delta ${delta > 0 ? '+' : ''}${delta} µs); float chain toNumber(beat)×(60000/bpm)+countIn, round(ms×1000); R2-1 §3.5 legacy track`,
        });
      } else {
        semantic(diffs, `wireMs[${id}].${msField}`, rule, usValue, legacyUs);
      }
    }
  });
  for (const id of wireByOccurrenceId.keys()) {
    if (!seenWireIds.has(id)) semantic(diffs, `wireMs[${id}].orphan`, rule, 'absent', 'present');
  }
}

/**
 * Structural rules for runtime IDs (R2-1 §3.1 【结构】): generation pattern and
 * uniqueness are verified — never byte equality against the expected side.
 */
function checkRuntimeIdRules(candidate: ParityCandidate, diffs: ParityDiff[]): void {
  if (!candidate.runtimeIds) return;
  const rule = 'TS_RUST_PARITY_GATE_V1 §3.1 (runtime ID structural rules)';
  const { occurrenceIds, groupIds } = candidate.runtimeIds;
  if (new Set(occurrenceIds).size !== occurrenceIds.length) {
    semantic(diffs, 'runtimeIds.occurrenceIds.uniqueness', rule, 'unique', 'duplicates present');
  }
  if (new Set(groupIds).size !== groupIds.length) {
    semantic(diffs, 'runtimeIds.groupIds.uniqueness', rule, 'unique', 'duplicates present');
  }
  // occurrenceId pattern: `...:p{pass}:{notated event id}`. The pass segment
  // must be embedded. We do NOT require the planId prefix: hand filtering
  // appends `:hand=…` to plan.planId but keeps member occurrenceIds unchanged
  // (existing behavior, R2-1 §10③ legacyReference baseline), so a strict
  // prefix check would misreport legal filtered plans.
  candidate.occurrences.forEach((occurrence, index) => {
    const id = occurrenceIds[index];
    if (!id) {
      semantic(diffs, `runtimeIds.occurrenceIds[${index}]`, rule, 'defined', 'missing');
      return;
    }
    if (!id.includes(`:p${occurrence.passIndex}:`)) {
      semantic(diffs, `runtimeIds.occurrenceIds[${index}].pattern`, rule, `:p${occurrence.passIndex}: segment`, id);
    }
  });
}

// ---------------------------------------------------------------------------
// Report contract (parity-diff-report-v1)
// ---------------------------------------------------------------------------

export interface ParityReportV1 {
  schemaVersion: 1;
  caseId: string;
  fixture: { path: string; sha256: string };
  configSha256: string;
  sides: {
    expected: { kind: string; source: string };
    candidate: { kind: string; gitSha: string | null; plannerVersion: string; engineVersion: string };
  };
  /** R2-2 is TS-side only; this field must stay explicit (task card §4.4). */
  rustSide: 'not-implemented / not-run';
  l1: {
    status: 'pass' | 'fail' | 'not-applicable';
    fingerprint: string | null;
    fingerprintErrorCode: string | null;
    stableAcrossRuns: boolean;
    note: string;
  };
  l2: { status: 'pass' | 'fail'; occurrenceCount: number; groupCount: number; diffCount: number };
  l3: {
    status: 'pass' | 'fail';
    atomCount: number;
    scoreEventCount: number;
    wireCompatibility: 'pass' | 'fail' | 'not-applicable';
    p1_3Invariants: { check: string; status: 'pass' | 'fail' }[];
  };
  summary: {
    status: 'pass' | 'fail';
    categories: Record<DiffCategory, number>;
    pass: boolean;
  };
  diffs: ParityDiff[];
  meta: {
    generatedAt: string;
    gitSha: string | null;
    command: string;
    timeConversionVersion: string;
    fingerprintSchemaVersion: number;
    parityGateDoc: string;
  };
}

export function emptyCategories(): Record<DiffCategory, number> {
  return {
    'identity-mapping': 0,
    'serialization-only': 0,
    'time-rounding': 0,
    'semantic-defect': 0,
    'unsupported-behavior': 0,
    unclassified: 0,
  };
}

export function categorize(diffs: ParityDiff[]): Record<DiffCategory, number> {
  const categories = emptyCategories();
  for (const diff of diffs) categories[diff.category] += 1;
  return categories;
}

export function reportPasses(categories: Record<DiffCategory, number>): boolean {
  return categories['semantic-defect'] === 0 && categories.unclassified === 0;
}
