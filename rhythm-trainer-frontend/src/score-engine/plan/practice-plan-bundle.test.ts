// Stage 2 Gate 2: PracticePlanBundleV1 must pass for real plans and catch
// tampering with pitch, membership, IDs, times, pass, BPM/count-in and
// fingerprint. The bundle is internal; these tests exercise the gate directly.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { beatToString, rational } from '../domain/rational';
import { importMusicXml } from '../import/musicxml-importer';
import { buildPlaybackPlan, scoreOccurrencesToEngineAtoms } from '../playback/playback-planner';
import { TS_PLANNER_VERSION } from '../playback/playback-planner';
import type { HandMappingV1 } from '../scope/practice-scope';
import type { ImportReport, PlaybackPlan, ScoreDocument } from '../domain/types';
import {
  assertPracticePlanBundle,
  buildPracticePlanBundleFromPlayback,
  buildPracticePlanBundleFromRust,
  engineAtomsFromBundle,
  engineScoreEventsFromBundle,
  PlanBundleRejected,
  validatePracticePlanBundle,
  type BundleConfigInput,
  type PracticePlanBundleV1,
} from './practice-plan-bundle';
import type { RustPlanResponse } from './rust-plan';
import { rangeSpanFromDocument, toPlaybackPlan } from './rust-plan';
import { findRepoRoot } from '../parity/case-bundle';

const XML = readFileSync(new URL('../test/fixtures/piano-two-staff-basic.musicxml', import.meta.url), 'utf8');

function fixture(): {
  plan: PlaybackPlan;
  config: BundleConfigInput;
  fingerprint: { document: ScoreDocument; report: ImportReport; partId: string };
} {
  const imported = importMusicXml(XML, { fileName: 'piano-two-staff-basic.musicxml' });
  if (!imported.scoreDocument) throw new Error('fixture import failed');
  const document = imported.scoreDocument;
  const report = imported.importReport;
  const part = document.parts[0];
  const barCount = part.measures.length;
  const semantics = buildPlaybackPlan(document, {
    range: { startMeasureOrdinal: 1, endMeasureOrdinal: barCount },
    repeatSelection: { kind: 'none' },
    unsupportedNotationPolicy: 'reject-strict',
  });
  if (!semantics.plan) throw new Error(`fixture plan failed: ${semantics.issues.map((i) => i.message).join(', ')}`);
  const handMapping: HandMappingV1 = {
    schemaVersion: 1,
    mappingVersion: 'test-mapping-v1',
    source: 'user',
    parts: [{
      partId: part.id,
      staves: Array.from({ length: part.staves }, (_, index) => ({
        staffNumber: index + 1,
        hand: index === 0 ? 'right' : 'left',
      })),
    }],
  };
  return {
    plan: semantics.plan,
    config: {
      modeId: 'score',
      advanceMode: 'timeline',
      bpm: { numerator: 60, denominator: 1 },
      range: { startMeasureOrdinal: 1, endMeasureOrdinal: barCount },
      repeatSelection: { kind: 'none' },
      hand: 'both',
      handMapping,
      countInUs: 3_000_000,
      ticksPerQuarter: 960,
      unsupportedNotationPolicy: 'reject-strict',
      plannerVersion: TS_PLANNER_VERSION,
    },
    fingerprint: { document, report, partId: part.id },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function rustProjection(base: ReturnType<typeof fixture>, bundle: PracticePlanBundleV1): RustPlanResponse {
  const occurrenceById = new Map(bundle.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const planFingerprintVersion = 'rust-planner-1';
  const rustConfig = { ...base.config, plannerVersion: planFingerprintVersion };
  // Compute the same frozen fingerprint with the Rust planner version.
  const rustBundle = buildPracticePlanBundleFromPlayback({
    plan: base.plan,
    config: rustConfig,
    fingerprint: base.fingerprint,
  });
  const rustPlan = {
    scoreFingerprint: bundle.scoreFingerprint,
    occurrences: base.plan.occurrences.map((occurrence) => ({
        occurrenceId: occurrence.occurrenceId,
        scoreEventId: occurrence.scoreEventId,
        locator: {
          partId: occurrence.sourcePartId,
          measureOrdinal: occurrence.sourceMeasureOrdinal,
          sourceOrdinal: occurrence.sourceOrdinal,
          ...(occurrence.voiceId !== undefined ? { voiceId: occurrence.voiceId } : {}),
        },
        passIndex: occurrence.passIndex,
        playbackBeat: beatToString(occurrence.playbackBeat),
        durationBeat: beatToString(occurrence.durationBeat),
        measureOrdinal: occurrence.measureOrdinal,
        bar: occurrence.bar,
        beatInMeasure: beatToString(occurrence.beatInMeasure),
        staffNumber: occurrence.staffNumber,
        voiceId: occurrence.voiceId ?? '1',
        pitch: occurrence.pitch
          ? { ...occurrence.pitch, midiNote: occurrence.pitch.midiNote ?? null }
          : null,
        isTieOnset: occurrence.isTieOnset,
        playbackIndex: occurrence.playbackIndex,
      })),
    groups: base.plan.groups.map((group) => {
      const members = group.occurrenceIds.map((id) => occurrenceById.get(id)!);
      return {
        passIndex: members[0]?.passIndex ?? 0,
        playbackBeat: beatToString(group.playbackBeat),
        members: members.map((member) => ({
          partId: member.sourcePartId,
          measureOrdinal: member.sourceMeasureOrdinal,
          sourceOrdinal: member.sourceOrdinal,
          ...(member.voiceId !== undefined ? { voiceId: member.voiceId } : {}),
        })),
        pitches: members.map((member) => member.spelling ?? ''),
        bar: group.bar,
        beatInMeasure: beatToString(group.beatInMeasure),
        staffNumbers: [...group.staffNumbers],
        voiceIds: [...group.voiceIds],
        durationBeat: beatToString(group.durationBeat),
        occurrenceIds: [...group.occurrenceIds],
        scoreEventIds: members.map((member) => member.sourceScoreEventId),
      };
    }),
    atoms: scoreOccurrencesToEngineAtoms(base.plan).atoms.map((atom) => ({
      startTick: atom.startTick,
      durationTicks: atom.durationTicks,
      bar: atom.bar,
      beat: atom.beat,
    })),
    scoreEvents: bundle.scoreEvents.map((event) => ({
      locator: {
        partId: event.locator.partId,
        measureOrdinal: event.locator.measureOrdinal,
        sourceOrdinal: event.locator.sourceOrdinal,
        ...(event.locator.voiceId !== undefined ? { voiceId: event.locator.voiceId } : {}),
      },
      passIndex: event.passIndex,
      measure: event.measure,
      pitch: event.pitch,
      targetOnsetUs: event.targetOnsetUs,
      targetDurationUs: event.targetDurationUs,
      partId: event.partId,
      parseConfidence: event.parseConfidence,
      runtimeOccurrenceId: event.occurrenceId,
    })),
    runtimeIds: {
      planId: base.plan.planId,
      occurrenceIds: base.plan.occurrences.map((occurrence) => occurrence.occurrenceId),
      groupIds: base.plan.groups.map((group) => group.groupId),
    },
    planStrictAllowed: true,
    planIssues: [],
    scopeCodes: [],
    missingEventIds: [],
    atomIssueCodes: [],
  };
  return {
    requestId: 'test-request',
    ok: true,
    plannerAuthority: 'rust',
    plannerVersion: planFingerprintVersion,
    planFingerprint: rustBundle.planFingerprint,
    scoreFingerprint: rustBundle.scoreFingerprint,
    strictAllowed: true,
    planIssues: [],
    scopeCodes: [],
    missingEventIds: [],
    atomIssueCodes: [],
    plan: rustPlan,
  };
}

describe('PracticePlanBundleV1', () => {
  it('builds a consistent bundle from the production playback plan', () => {
    const base = fixture();
    const bundle = buildPracticePlanBundleFromPlayback(base);
    expect(bundle.integrityReport.ok).toBe(true);
    expect(bundle.integrityReport.issues.filter((issue) => issue.blocking)).toEqual([]);
    expect(bundle.occurrences.length).toBeGreaterThan(0);
    expect(bundle.groups.length).toBeGreaterThan(0);
    expect(bundle.atoms.length).toBe(bundle.groups.length);
    expect(bundle.scoreEvents.length).toBe(bundle.occurrences.length);
    expect(bundle.timebase).toMatchObject({
      countInUs: 3_000_000,
      ticksPerQuarter: 960,
      sessionTimeUnit: 'microsecond',
      roundingPolicyVersion: 'time-conversion-v1',
    });
    // The one frozen count-in produces the exact rational countInBeats.
    expect(bundle.config.countInBeats).toEqual(rational(3_000_000 * 60, 60_000_000));
    expect(engineAtomsFromBundle(bundle)).toHaveLength(bundle.groups.length);
    expect(engineScoreEventsFromBundle(bundle)).toHaveLength(bundle.occurrences.length);
    expect(() => assertPracticePlanBundle(bundle)).not.toThrow();
  });

  it('builds the Rust-projected bundle through the same gate', () => {
    const base = fixture();
    const rts = buildPracticePlanBundleFromPlayback(base);
    const response = rustProjection(base, rts);
    const bundle = buildPracticePlanBundleFromRust({
      response,
      plan: base.plan,
      config: { ...base.config, plannerVersion: 'rust-planner-1' },
      fingerprint: base.fingerprint,
    });
    expect(bundle.authority).toBe('rust-planner');
    expect(bundle.planFingerprint).toBe(response.planFingerprint);
    expect(bundle.integrityReport.ok).toBe(true);
    expect(bundle.integrityReport.issues.filter((issue) => issue.blocking)).toEqual([]);
  });

  it('accepts the REAL Rust planner output through the bundle gate', () => {
    const require = createRequire(import.meta.url);
    const root = findRepoRoot();
    const native = require(join(root, 'rhythm-trainer-core-v0.2', 'bindings', 'node'));
    const corpus = JSON.parse(readFileSync(
      join(root, 'audit-r1', 'fixtures', 'parity-cases', 'rust-parity-input', 'G1-base.json'),
      'utf8',
    ));
    const plannerConfig = { ...corpus.config, plannerVersion: 'rust-planner-1' };
    const plan = JSON.parse(native.buildPlanV1(
      JSON.stringify(corpus.document), JSON.stringify(corpus.report), JSON.stringify(plannerConfig)));
    const planFingerprint = native.planFingerprintV1Gate(
      JSON.stringify(corpus.document), JSON.stringify(corpus.report), JSON.stringify(plan), JSON.stringify(plannerConfig));
    const response: RustPlanResponse = {
      requestId: 'bundle-real-rust',
      ok: true,
      plannerAuthority: 'rust',
      plannerVersion: 'rust-planner-1',
      planFingerprint,
      scoreFingerprint: corpus.report.fingerprint,
      strictAllowed: plan.planStrictAllowed,
      planIssues: plan.planIssues,
      scopeCodes: plan.scopeCodes,
      missingEventIds: plan.missingEventIds,
      atomIssueCodes: plan.atomIssueCodes,
      plan,
    };
    const span = rangeSpanFromDocument(corpus.document.parts[0].measures, plannerConfig.range);
    const imported = importMusicXml(
      readFileSync(join(root, 'audit-r1', 'fixtures', 'g1_single_voice.musicxml'), 'utf8'),
      { fileName: 'g1_single_voice.musicxml' },
    );
    if (!imported.scoreDocument) throw new Error('G1 source fixture import failed');
    expect(imported.importReport.fingerprint).toBe(corpus.report.fingerprint);
    const parsed = toPlaybackPlan(response, {
      range: plannerConfig.range,
      repeatSelection: plannerConfig.repeatSelection,
      rangeStartBeat: span.rangeStartBeat,
      rangeDurationBeat: span.rangeDurationBeat,
    });
    const bundle = buildPracticePlanBundleFromRust({
      response,
      plan: parsed.plan,
      config: {
        modeId: 'score',
        advanceMode: 'timeline',
        bpm: plannerConfig.bpm,
        range: plannerConfig.range,
        repeatSelection: plannerConfig.repeatSelection,
        hand: plannerConfig.hand,
        handMapping: plannerConfig.handMapping,
        countInUs: plannerConfig.countInUs,
        ticksPerQuarter: plannerConfig.ticksPerQuarter,
        unsupportedNotationPolicy: plannerConfig.unsupportedNotationPolicy,
        plannerVersion: 'rust-planner-1',
      },
      fingerprint: { document: imported.scoreDocument, report: imported.importReport, partId: plannerConfig.partId },
    });
    expect(bundle.integrityReport.issues.filter((issue) => issue.blocking)).toEqual([]);
    expect(bundle.integrityReport.ok).toBe(true);
    expect(bundle.planFingerprint).toBe(planFingerprint);
    expect(bundle.atoms.length).toBe(bundle.groups.length);
    expect(bundle.scoreEvents.length).toBe(bundle.occurrences.length);
  });

  it('allows a Follow bundle to skip atom strictness but still validates its groups', () => {
    const base = fixture();
    const follow = buildPracticePlanBundleFromPlayback({
      ...base,
      config: { ...base.config, advanceMode: 'follow' },
    });
    expect(follow.integrityReport.ok).toBe(true);
    expect(follow.integrityReport.issues.some((issue) => issue.code === 'PLAN_ATOM_UNUSED_FOLLOW')).toBe(true);
    expect(follow.integrityReport.issues.some((issue) => issue.blocking)).toBe(false);

    const tampered = clone(follow);
    tampered.groups[0].occurrenceIds = [...tampered.groups[0].occurrenceIds, tampered.groups[0].occurrenceIds[0]];
    expect(validatePracticePlanBundle(tampered).ok).toBe(false);
  });

  const mutations: Array<[string, (bundle: PracticePlanBundleV1) => void]> = [
    ['occurrence pitch', (bundle) => { bundle.occurrences[0].midiNote = (bundle.occurrences[0].midiNote ?? 60) + 1; }],
    ['occurrence onset', (bundle) => { bundle.occurrences[0].targetOnsetUs += 1; }],
    ['occurrence duration', (bundle) => { bundle.occurrences[0].targetDurationUs += 1; }],
    ['occurrence pass', (bundle) => { bundle.occurrences[0].passIndex += 1; }],
    ['occurrence duplicate id', (bundle) => { bundle.occurrences[1].occurrenceId = bundle.occurrences[0].occurrenceId; }],
    ['occurrence group id', (bundle) => { bundle.occurrences[0].groupId = 'tampered-group'; }],
    ['group membership', (bundle) => {
      bundle.groups[0].occurrenceIds = [...bundle.groups[0].occurrenceIds, bundle.groups[0].occurrenceIds[0]];
    }],
    ['group pitch list', (bundle) => { bundle.groups[0].pitches[0] = bundle.groups[0].pitches[0] + 1; }],
    ['group duration', (bundle) => { bundle.groups[0].targetDurationUs += 1; }],
    ['group onset', (bundle) => { bundle.groups[0].targetOnsetUs += 1; }],
    ['group duplicate id', (bundle) => { bundle.groups[1].groupId = bundle.groups[0].groupId; }],
    ['atom onset', (bundle) => { bundle.atoms[0].startTick += 1; }],
    ['atom duration', (bundle) => { bundle.atoms[0].durationTicks += 1; }],
    ['scoreEvent pitch', (bundle) => { bundle.scoreEvents[0].pitch += 1; }],
    ['scoreEvent onset', (bundle) => { bundle.scoreEvents[0].targetOnsetUs += 1; }],
    ['scoreEvent duplicate id', (bundle) => { bundle.scoreEvents[1].scoreEventId = bundle.scoreEvents[0].scoreEventId; }],
    ['BPM', (bundle) => { bundle.config.bpm = { numerator: 61, denominator: 1 }; }],
    ['count-in', (bundle) => { bundle.config.countInUs += 1; }],
    ['countInBeats', (bundle) => { bundle.config.countInBeats = { numerator: 1, denominator: 1 }; }],
    ['repeat policy', (bundle) => { bundle.config.repeatSelection = { kind: 'range-loop', count: 0 }; }],
    ['fingerprint', (bundle) => { bundle.planFingerprint = `plan-v1:sha256:${'0'.repeat(64)}`; }],
  ];

  for (const [name, mutate] of mutations) {
    it(`rejects tampering: ${name}`, () => {
      const base = fixture();
      const valid = buildPracticePlanBundleFromPlayback(base);
      expect(valid.integrityReport.ok).toBe(true);
      const tampered = clone(valid);
      mutate(tampered);
      const report = validatePracticePlanBundle(tampered, {
        expectedPlanFingerprint: valid.planFingerprint,
        expectedScoreFingerprint: valid.scoreFingerprint,
      });
      expect(report.ok, `${name} should be blocked`).toBe(false);
      expect(report.issues.some((issue) => issue.blocking)).toBe(true);
    });
  }

  it('throws a coded rejection when asserted', () => {
    const base = fixture();
    const valid = buildPracticePlanBundleFromPlayback(base);
    const tampered = clone(valid);
    tampered.groups[0].pitches = tampered.groups[0].pitches.map((pitch) => pitch + 1);
    tampered.integrityReport = validatePracticePlanBundle(tampered);
    expect(() => assertPracticePlanBundle(tampered)).toThrow(PlanBundleRejected);
    try {
      assertPracticePlanBundle(tampered);
    } catch (error) {
      expect((error as PlanBundleRejected).code).toBe('PLAN_BUNDLE_REJECTED');
      expect((error as PlanBundleRejected).issues.length).toBeGreaterThan(0);
    }
  });
});
