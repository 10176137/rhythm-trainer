// R2-3h: parser + response-binding tests. Plans come from the REAL Rust NAPI
// (buildPlanV1) — no plan mocks. The binding rule is exercised directly
// because it is the same pure function the EngineBridge uses.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../parity/case-bundle';
import {
  assertFollowResponseUsable,
  assertTimelineResponseUsable,
  bindPlanResponse,
  rangeSpanFromDocument,
  toEngineAtoms,
  toEngineScoreEvents,
  toPlaybackGroups,
  toPlaybackOccurrence,
  toPlaybackPlan,
  type RustPlanResponse,
  type RustPlannerOutput,
} from './rust-plan';

const require = createRequire(import.meta.url);
const root = findRepoRoot();
const native = require(join(root, 'rhythm-trainer-core-v0.2', 'bindings', 'node'));

const corpus = JSON.parse(readFileSync(
  join(root, 'audit-r1', 'fixtures', 'parity-cases', 'rust-parity-input', 'G1-base.json'), 'utf8'));
const { plannerVersion, ...config } = corpus.config;
void plannerVersion;
const TRUSTED = { ...config, plannerVersion: 'rust-planner-1' };

/** Real Rust PlannerOutput + the response envelope the server builds. */
function realResponse(): RustPlanResponse & { plan: RustPlannerOutput } {
  const plan = JSON.parse(native.buildPlanV1(
    JSON.stringify(corpus.document), JSON.stringify(corpus.report), JSON.stringify(TRUSTED)));
  const planFingerprint = native.planFingerprintV1Gate(
    JSON.stringify(corpus.document), JSON.stringify(corpus.report), JSON.stringify(plan), JSON.stringify(TRUSTED));
  return {
    requestId: 'plan-1-test',
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
}

const range = { startMeasureOrdinal: 1, endMeasureOrdinal: 2 };
const span = rangeSpanFromDocument(
  corpus.document.parts[0].measures.map((measure: { ordinal: number; startBeat: unknown; durationBeat: unknown }) => ({
    ordinal: measure.ordinal,
    startBeat: measure.startBeat as { numerator: number; denominator: number },
    durationBeat: measure.durationBeat as { numerator: number; denominator: number },
  })),
  range,
);

describe('R2-3h: deterministic Rust plan projection', () => {
  it('maps occurrences field-by-field, with rational parsing and no extra fields', () => {
    const response = realResponse();
    const rustOccurrence = response.plan.occurrences[0];
    const mapped = toPlaybackOccurrence(rustOccurrence);
    expect(mapped.occurrenceId).toBe(rustOccurrence.occurrenceId);
    expect(mapped.scoreEventId).toBe(rustOccurrence.scoreEventId);
    expect(mapped.sourcePartId).toBe(rustOccurrence.locator.partId);
    expect(mapped.sourceMeasureOrdinal).toBe(rustOccurrence.locator.measureOrdinal);
    expect(mapped.sourceOrdinal).toBe(rustOccurrence.locator.sourceOrdinal);
    expect(mapped.playbackIndex).toBe(rustOccurrence.playbackIndex);
    expect(mapped.passIndex).toBe(rustOccurrence.passIndex);
    expect(mapped.playbackBeat).toEqual({ numerator: 0, denominator: 1 });
    expect(mapped.durationBeat).toEqual({ numerator: 1, denominator: 1 });
    expect(mapped.bar).toBe(rustOccurrence.bar);
    expect(mapped.staffNumber).toBe(rustOccurrence.staffNumber);
    expect(mapped.pitch).toEqual({
      step: 'C', alter: 0, octave: 4, midiNote: 60, spelling: 'C4',
    });
    // The Rust planner does not emit chordGroupId; the projection must not
    // invent one.
    expect('chordGroupId' in mapped).toBe(false);
  });

  it('restores group pitches through the member occurrences (no re-clustering)', () => {
    const response = realResponse();
    const occurrences = response.plan.occurrences.map(toPlaybackOccurrence);
    const groups = toPlaybackGroups(response.plan, occurrences);
    expect(groups).toHaveLength(response.plan.groups.length);
    // groupId alignment comes from runtimeIds.groupIds in array order.
    expect(groups.map((group) => group.groupId)).toEqual(response.plan.runtimeIds.groupIds);
    for (const [index, group] of groups.entries()) {
      const rustGroup = response.plan.groups[index];
      expect(group.occurrenceIds).toEqual(rustGroup.occurrenceIds);
      expect(group.scoreEventIds).toEqual(rustGroup.scoreEventIds);
      expect(group.pitches.map((pitch) => pitch.spelling)).toEqual(rustGroup.pitches);
      const [numerator, denominator] = rustGroup.durationBeat.split('/').map(Number);
      expect(group.durationBeat).toEqual({ numerator, denominator });
    }
  });

  it('projects atoms with kind="note" and scoreEvents with exactly ONE us/1000 division', () => {
    const response = realResponse();
    const occurrences = response.plan.occurrences.map(toPlaybackOccurrence);
    const atoms = toEngineAtoms(response.plan.atoms);
    expect(atoms.every((atom) => atom.kind === 'note')).toBe(true);
    expect(atoms[0]).toEqual({
      startTick: response.plan.atoms[0].startTick,
      durationTicks: response.plan.atoms[0].durationTicks,
      kind: 'note',
      bar: response.plan.atoms[0].bar,
      beat: response.plan.atoms[0].beat,
    });
    const scoreEvents = toEngineScoreEvents(response.plan, occurrences);
    expect(scoreEvents).toHaveLength(occurrences.length);
    for (const [index, event] of scoreEvents.entries()) {
      const rust = response.plan.scoreEvents[index];
      expect(event.scoreEventId).toBe(rust.runtimeOccurrenceId);
      expect(event.pitch).toBe(rust.pitch);
      expect(event.measure).toBe(rust.measure);
      expect(event.partId).toBe(rust.partId);
      // The ONLY conversion is us/1000 — exact for these frozen values.
      expect(event.targetOnsetMs).toBe(rust.targetOnsetUs / 1000);
      expect(event.targetDurationMs).toBe(rust.targetDurationUs / 1000);
    }
  });

  it('builds a PlaybackPlan whose gates pass for both consumption modes', () => {
    const response = realResponse();
    assertTimelineResponseUsable(response);
    assertFollowResponseUsable(response);
    const { plan, groups } = toPlaybackPlan(response, {
      range,
      repeatSelection: { kind: 'none' },
      rangeStartBeat: span.rangeStartBeat,
      rangeDurationBeat: span.rangeDurationBeat,
    });
    expect(plan.planId).toBe(response.plan.runtimeIds.planId);
    expect(plan.scoreFingerprint).toBe(response.scoreFingerprint);
    expect(groups.length).toBe(plan.groups.length);
    expect(plan.rangeDurationBeat).toEqual({ numerator: 8, denominator: 1 });
  });

  it('rejects a tampered scoreEvent count/identity and an atom-less plan for timeline', () => {
    const base = realResponse();
    const tampered = JSON.parse(JSON.stringify(base)) as RustPlanResponse;
    tampered.plan.scoreEvents.pop();
    expect(() => assertTimelineResponseUsable(tampered)).toThrow(/scoreEvents:count/);

    const noAtoms = JSON.parse(JSON.stringify(base)) as RustPlanResponse;
    noAtoms.plan.atoms = [];
    expect(() => assertTimelineResponseUsable(noAtoms)).toThrow(/atoms:empty/);

    // Follow does not consume atoms/scoreEvents: the same tampering is legal.
    expect(assertFollowResponseUsable(tampered)).toBeUndefined();
    expect(assertFollowResponseUsable(noAtoms)).toBeUndefined();
  });

  it('rejects a malformed rational instead of coercing it', () => {
    const base = realResponse();
    const tampered = JSON.parse(JSON.stringify(base)) as RustPlanResponse;
    tampered.plan.occurrences[0].playbackBeat = '0.5';
    expect(() => tampered.plan.occurrences.map(toPlaybackOccurrence)).toThrow(/malformed rational/);
  });
});

describe('R2-3h: response binding (requestId + fingerprint + staleness)', () => {
  const pending = { scoreFingerprint: 'a'.repeat(64) };
  const okMessage = {
    requestId: 'plan-1', ok: true, scoreFingerprint: 'a'.repeat(64),
  };

  it('accepts only the matching requestId bound to the same score', () => {
    expect(bindPlanResponse(okMessage, pending).action).toBe('accept');
  });

  it('drops a response for an unknown/settled requestId (stale response)', () => {
    const decision = bindPlanResponse({ ...okMessage, requestId: 'plan-old' }, null);
    expect(decision.action).toBe('drop');
  });

  it('drops a response with no requestId at all', () => {
    expect(bindPlanResponse({ ...okMessage, requestId: null }, pending).action).toBe('drop');
  });

  it('rejects a response carrying a DIFFERENT score fingerprint', () => {
    const decision = bindPlanResponse({ ...okMessage, scoreFingerprint: 'b'.repeat(64) }, pending);
    expect(decision.action).toBe('reject');
    if (decision.action === 'reject') expect(decision.code).toBe('PLAN_RESPONSE_MISMATCH');
  });

  it('rejects a coded server failure with its own code (never an empty success)', () => {
    const decision = bindPlanResponse({
      requestId: 'plan-1', ok: false, error: { code: 'TIMELINE_SEMANTICS_REJECTED', message: 'boom' },
    }, pending);
    expect(decision.action).toBe('reject');
    if (decision.action === 'reject') expect(decision.code).toBe('TIMELINE_SEMANTICS_REJECTED');
  });
});
