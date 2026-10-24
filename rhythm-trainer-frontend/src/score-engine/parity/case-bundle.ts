// R2-2b: frozen case-bundle loading. A bundle fixes the byte-frozen MusicXML
// fixture (sha256-verified), the explicit practice configuration and the
// independent expected truth (R2-1 §2). G1–G5 reuse the committed hand-derived
// golden files via a deterministic converter — no second copy of the truth is
// created. New extended cases carry hand-derived canonical expected files.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import bundleSchema from '../../../../audit-r1/contracts/parity-case-bundle-v1.schema.json';
import type { ParityCaseConfig } from './parity-candidate';
import type { CanonicalAtom, CanonicalGroup, CanonicalOccurrence, CanonicalScoreEvent, ParityCandidate } from './parity-diff';

export interface ParityCaseBundle {
  schemaVersion: 1;
  caseId: string;
  description: string;
  ruleVersions: { timeConversion: string; fingerprintSchemaVersion: number; parityGateDoc: string };
  fixture: { path: string; sha256: string };
  config: ParityCaseConfig;
  expected: { source: 'golden-fixture' | 'hand-derived'; ref: string; notes?: string };
  expectedOutcome: {
    planStatus: 'strict' | 'blocked';
    issueCodes?: string[];
    fingerprintErrorCode?: string;
    scopeCodes?: string[];
  };
  acceptanceTags: Array<'L1' | 'L2' | 'L3'>;
}

export interface ParityCaseIndex {
  schemaVersion: 1;
  cases: ParityCaseBundle[];
}

export function findRepoRoot(startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, 'audit-r1', 'contracts'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) throw new Error('repo root not found (audit-r1/contracts missing)');
    dir = parent;
  }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateBundle = ajv.compile(bundleSchema);

export function parseBundle(raw: unknown, origin: string): ParityCaseBundle {
  if (!validateBundle(raw)) {
    const errors = (validateBundle.errors ?? []).map((e) => `${e.instancePath}: ${e.message}`).join('; ');
    throw new Error(`bundle schema violation in ${origin}: ${errors}`);
  }
  return raw as unknown as ParityCaseBundle;
}

export function loadCaseIndex(root: string): ParityCaseIndex {
  const indexPath = join(root, 'audit-r1', 'fixtures', 'parity-cases', 'index.json');
  const raw = JSON.parse(readFileSync(indexPath, 'utf8'));
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.cases)) {
    throw new Error(`invalid parity case index: ${indexPath}`);
  }
  return { schemaVersion: 1, cases: raw.cases.map((entry: unknown) => parseBundle(entry, indexPath)) };
}

export function loadFixtureXml(root: string, bundle: ParityCaseBundle): { xml: string; fileName: string } {
  const fixturePath = join(root, bundle.fixture.path);
  const xml = readFileSync(fixturePath, 'utf8');
  const actual = sha256Hex(xml);
  if (actual !== bundle.fixture.sha256) {
    throw new Error(`fixture hash mismatch for ${bundle.fixture.path}: expected ${bundle.fixture.sha256}, got ${actual}`);
  }
  return { xml, fileName: bundle.fixture.path.split('/').pop() ?? 'fixture.musicxml' };
}

export function configFingerprint(config: ParityCaseConfig): string {
  const sorted = JSON.stringify(config, Object.keys(config).sort());
  return sha256Hex(sorted);
}

// ---------------------------------------------------------------------------
// golden g*.expected.json → canonical expected candidate (deterministic).
// The golden numbers stay untouched; only the shape is converted. Locators are
// derived from the golden event list (document order per measure), which the
// golden fixtures already freeze.
// ---------------------------------------------------------------------------

interface GoldenEvent {
  kind: 'note' | 'rest';
  spelling: string | null;
  midi: number | null;
  onset: string;
  duration: string;
  measure: number;
  staff: number;
  voice: string;
  grace: boolean;
}

interface GoldenCase {
  case: string;
  fixture: string;
  bpm: number;
  countInBeats: number;
  plan: {
    occurrences: { playbackBeat: string; duration: string; bar: number; staff: number; voice: string; midi: number | null; isTieOnset: boolean }[];
    groups: { playbackBeat: string; pitches: string[]; duration: string }[];
  };
  scoreEvents: { pitch: number; measure: number; beat: string; onsetUs: number; durationUs: number }[];
  atoms: { startTick: number; durationTicks: number; bar: number; beatInMeasure: string }[];
  measures: { ordinal: number; start: string; duration: string }[];
  events: GoldenEvent[];
}

const STEP_INDEX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C4" | "F#4" | "Gb4" | "F##4" → { step, alter, octave }; midi is re-derived and cross-checked. */
export function parseSpelling(spelling: string): { step: string; alter: number; octave: number; midi: number } {
  const match = /^([A-G])(#{1,2}|b{1,2})?(-?\d+)$/.exec(spelling);
  if (!match) throw new Error(`unparseable spelling: ${spelling}`);
  const step = match[1];
  const accidental = match[2] ?? '';
  const octave = Number(match[3]);
  let alter = 0;
  for (const ch of accidental) alter += ch === '#' ? 1 : -1;
  const midi = (octave + 1) * 12 + STEP_INDEX[step] + alter;
  return { step, alter, octave, midi };
}

function beatTextToNumber(text: string): number {
  const [n, d] = text.split('/').map(Number);
  return n / d;
}

export function goldenToExpected(goldenRaw: unknown): ParityCandidate {
  const golden = goldenRaw as GoldenCase;
  // Walk the golden event list once: assign per-measure source ordinals and
  // pick up the playable notes in document order.
  const ordinalByMeasure = new Map<number, number>();
  const sourceOrdinalOf = new Map<GoldenEvent, number>();
  const noteEvents: GoldenEvent[] = [];
  for (const event of golden.events) {
    const next = (ordinalByMeasure.get(event.measure) ?? 0) + 1;
    ordinalByMeasure.set(event.measure, next);
    sourceOrdinalOf.set(event, next);
    if (event.kind === 'note' && !event.grace) noteEvents.push(event);
  }
  if (noteEvents.length !== golden.plan.occurrences.length) {
    throw new Error(`golden ${golden.case}: ${noteEvents.length} note events but ${golden.plan.occurrences.length} occurrences`);
  }
  const partId = 'P1';
  const beatText = (n: number, d: number) => {
    const g = (function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a; })(Math.abs(n), d) || 1;
    return `${n / g}/${d / g}`;
  };
  const subtractBeatText = (a: string, b: string) => {
    const [an, ad] = a.split('/').map(Number);
    const [bn, bd] = b.split('/').map(Number);
    return beatText(an * bd - bn * ad, ad * bd);
  };
  const occurrences: CanonicalOccurrence[] = golden.plan.occurrences.map((occurrence, index) => {
    const event = noteEvents[index];
    const parsed = event.spelling ? parseSpelling(event.spelling) : null;
    if (parsed && event.midi != null && parsed.midi !== event.midi) {
      throw new Error(`golden ${golden.case}: spelling ${event.spelling} maps to midi ${parsed.midi} but golden says ${event.midi}`);
    }
    const measure = golden.measures.find((m) => m.ordinal === event.measure);
    if (!measure) throw new Error(`golden ${golden.case}: no measure ${event.measure}`);
    return {
      locator: { partId, measureOrdinal: event.measure, sourceOrdinal: sourceOrdinalOf.get(event) as number, voiceId: event.voice },
      passIndex: 0,
      playbackBeat: occurrence.playbackBeat,
      durationBeat: occurrence.duration,
      measureOrdinal: occurrence.bar,
      bar: occurrence.bar,
      beatInMeasure: subtractBeatText(occurrence.playbackBeat, measure.start),
      staffNumber: occurrence.staff,
      voiceId: occurrence.voice,
      pitch: parsed && event.midi != null
        ? { step: parsed.step, alter: parsed.alter, octave: parsed.octave, midiNote: event.midi, spelling: event.spelling as string }
        : null,
      isTieOnset: occurrence.isTieOnset,
      playbackIndex: index,
    };
  });

  const groups: CanonicalGroup[] = golden.plan.groups.map((group) => {
    const members = occurrences.filter((o) => o.playbackBeat === group.playbackBeat);
    return {
      passIndex: 0,
      playbackBeat: group.playbackBeat,
      members: members.map((m) => ({ partId: m.locator.partId, measureOrdinal: m.locator.measureOrdinal, sourceOrdinal: m.locator.sourceOrdinal, voiceId: m.locator.voiceId })),
      pitches: group.pitches,
      bar: members[0]?.bar ?? 1,
      beatInMeasure: members[0]?.beatInMeasure ?? '0/1',
      staffNumbers: [...new Set(members.map((m) => m.staffNumber))].sort((a, b) => a - b),
      voiceIds: [...new Set(members.map((m) => m.voiceId))].sort(),
      durationBeat: group.duration,
    };
  });

  const atoms: CanonicalAtom[] = golden.atoms.map((atom) => ({
    startTick: atom.startTick,
    durationTicks: atom.durationTicks,
    bar: atom.bar,
    beat: 1 + beatTextToNumber(atom.beatInMeasure),
  }));

  const scoreEvents: CanonicalScoreEvent[] = golden.scoreEvents.map((event, index) => {
    const occurrence = occurrences[index];
    return {
      locator: { ...occurrence.locator },
      passIndex: 0,
      measure: event.measure,
      pitch: event.pitch,
      targetOnsetUs: event.onsetUs,
      targetDurationUs: event.durationUs,
      partId: `staff-${occurrence.staffNumber}:voice-${occurrence.voiceId}`,
      parseConfidence: 1,
    };
  });

  return { side: 'golden-expected', kind: 'expected', occurrences, groups, atoms, scoreEvents };
}

/** Loads the expected side for a bundle (golden converter or hand-derived file). */
export function loadExpected(root: string, bundle: ParityCaseBundle): ParityCandidate {
  if (bundle.expected.source === 'golden-fixture') {
    const goldenPath = join(root, bundle.expected.ref);
    return goldenToExpected(JSON.parse(readFileSync(goldenPath, 'utf8')));
  }
  const expectedPath = join(root, bundle.expected.ref);
  const raw = JSON.parse(readFileSync(expectedPath, 'utf8'));
  if (raw.caseId !== bundle.caseId) {
    throw new Error(`expected file caseId ${raw.caseId} does not match bundle ${bundle.caseId}`);
  }
  const candidate: ParityCandidate = raw.expected;
  if (candidate.kind !== 'expected') throw new Error(`hand-derived expected must carry kind=expected: ${expectedPath}`);
  return candidate;
}
