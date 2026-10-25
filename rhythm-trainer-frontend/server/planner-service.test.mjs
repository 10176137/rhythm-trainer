// R2-3g: automated acceptance for the server-side Rust planner generation
// chain. Every test drives the REAL implementation (createPlannerService ->
// native buildPlanV1 -> plan_fingerprint_v1_gate); no plan mocks. The
// fixtures come from the committed rust-parity-input corpus (G1-base unless
// stated). Test 10 runs the real-score regression only when the gitignored
// local fixture is present and is otherwise reported as NOT RUN.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { importMusicXml } from '../src/score-engine/import/musicxml-importer';
import {
  planFingerprintV1,
  projectScoreDocumentV1,
  validateScoreDocumentV1,
} from '../src/score-engine/contract-v1/plan-fingerprint';
import { buildPlaybackPlan } from '../src/score-engine/playback/playback-planner';
import {
  assertFollowUsable,
  assertTimelineUsable,
  createPlannerService,
  resolvePlannerAuthority,
  usToMs,
  verifyFollowCrossReferences,
  verifyTimelineSemantics,
  RUST_PLANNER_VERSION,
} from './planner-service.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const native = require(path.join(ROOT, 'rhythm-trainer-core-v0.2', 'bindings', 'node'));

function corpus(caseId = 'G1-base') {
  return JSON.parse(readFileSync(
    path.join(ROOT, 'audit-r1', 'fixtures', 'parity-cases', 'rust-parity-input', `${caseId}.json`), 'utf8'));
}

/** Corpus config without a plannerVersion — the server injects the trusted one. */
function configFor(caseId = 'G1-base') {
  const { plannerVersion, ...config } = corpus(caseId).config;
  void plannerVersion;
  return config;
}

function rustService() {
  return createPlannerService({ authority: 'rust' });
}

function callRust(service, document, report, config) {
  return service.buildRustPlan({
    document, report, config,
  });
}

const REST_STAFF2 = {
  eventId: 'rest:s2', kind: 'rest',
  source: { partId: 'P1', measureOrdinal: 1, staffNumber: 2, sourceOrdinal: 5 },
  onsetBeat: { numerator: 0, denominator: 1 },
  durationBeat: { numerator: 4, denominator: 1 },
  dots: 0,
  tieStart: false, tieStop: false, tiedStart: false, tiedStop: false,
  isGrace: false, isCue: false, articulations: [],
};

describe('R2-3g: rust planner generation chain (real NAPI)', () => {
  it('1. a valid request produces a verifiable plan, fingerprint and exact time line', () => {
    const record = corpus('G1-base');
    const service = rustService();
    const response = callRust(service, record.document, record.report, configFor());
    expect(response.plannerVersion).toBe('rust-planner-1');
    expect(response.plannerAuthority).toBe('rust');
    expect(response.strictAllowed).toBe(true);
    expect(response.planFingerprint).toMatch(/^plan-v1:sha256:[0-9a-f]{64}$/);
    expect(response.scoreFingerprint).toBe(record.report.fingerprint);

    // Stability: the same frozen inputs twice -> the same fingerprint.
    const again = callRust(service, record.document, record.report, configFor());
    expect(again.planFingerprint).toBe(response.planFingerprint);

    // The canonical time line is exact: every scoreEvent onset equals
    // countInUs + beatToMicroseconds(playbackBeat) via the frozen primitive.
    const bpm = record.config.bpm;
    for (const event of response.plan.scoreEvents) {
      const occurrence = response.plan.occurrences.find(
        (candidate) => candidate.occurrenceId === event.runtimeOccurrenceId);
      expect(occurrence).toBeTruthy();
      const [n, d] = occurrence.playbackBeat.split('/').map(Number);
      const expected = record.config.countInUs
        + native.beatToMicrosecondsJson(JSON.stringify({ numerator: n, denominator: d }),
          JSON.stringify(bpm));
      expect(event.targetOnsetUs).toBe(expected);
      const [dn, dd] = occurrence.durationBeat.split('/').map(Number);
      expect(event.targetDurationUs).toBe(
        native.beatToMicrosecondsJson(JSON.stringify({ numerator: dn, denominator: dd }), JSON.stringify(bpm)));
      expect(usToMs(event.targetOnsetUs)).toBe(event.targetOnsetUs / 1000);
    }
  });

  it('2. timeline: non-empty scopeCodes block the session even when missingEventIds is empty', () => {
    const record = corpus('G1-base');
    // Scope is assessed when hand != both. A staff-3 REST keeps
    // distinctStaffNumbers at {1,2,3} while the mapping only covers staff 1
    // (incomplete), and every PLAYABLE target stays on the mapped staff 1 —
    // so missingEventIds stays empty and scopeCodes alone must block.
    const document = record.document;
    document.parts[0].measures[0].events.push({
      ...REST_STAFF2,
      source: { partId: 'P1', measureOrdinal: 1, staffNumber: 3, sourceOrdinal: 5 },
    });
    const config = configFor();
    config.hand = 'right';
    config.handMapping.parts[0].staves = [{ staffNumber: 1, hand: 'right' }];
    const response = callRust(rustService(), document, record.report, config);
    expect(response.scopeCodes).toEqual(['hand_mapping_incomplete']);
    expect(response.missingEventIds).toEqual([]);
    expect(() => assertTimelineUsable(response))
      .toThrow(/scopeCodes:hand_mapping_incomplete/);
  });

  it('3. timeline: tick_grid_rounding with planStrictAllowed=true blocks session.begin', () => {
    const record = corpus('G1-base');
    const document = record.document;
    document.parts[0].measures[0].events[0].durationBeat = { numerator: 1, denominator: 7 };
    const response = callRust(rustService(), document, record.report, configFor());
    expect(response.strictAllowed).toBe(true);
    expect(response.atomIssueCodes).toContain('tick_grid_rounding');
    // The un-gridable group's atom is MISSING (never rounded): 4 of 5 groups
    // still map to atoms, which is exactly why the guard must block.
    expect(response.plan.groups).toHaveLength(5);
    expect(response.plan.atoms).toHaveLength(4);
    expect(() => assertTimelineUsable(response)).toThrow(/atomIssueCodes:tick_grid_rounding/);
  });

  it('4. follow: gates on its own dependencies and does NOT block on atoms', () => {
    const record = corpus('G1-base');
    const document = record.document;
    document.parts[0].measures[0].events[0].durationBeat = { numerator: 1, denominator: 7 };
    const response = callRust(rustService(), document, record.report, configFor());
    // The same response that timeline rejected (atoms) is USABLE for follow:
    // follow consumes groups/occurrences, which are complete and consistent.
    expect(assertFollowUsable(response)).toBe(true);

    // And a follow-relevant failure (missing hand mapping) does block: an
    // event on an unmapped staff cannot be assigned a hand — it lands in
    // missingEventIds while the mapped staff's targets still form a plan.
    const unmapped = JSON.parse(JSON.stringify(record));
    delete unmapped.config.plannerVersion;
    unmapped.config.hand = 'left';
    unmapped.config.handMapping.parts[0].staves = [{ staffNumber: 1, hand: 'left' }];
    const firstEvent = unmapped.document.parts[0].measures[0].events[0];
    firstEvent.source.staffNumber = 3;
    const unmappedResponse = callRust(rustService(), unmapped.document, unmapped.report, unmapped.config);
    expect(unmappedResponse.missingEventIds).toContain(firstEvent.eventId);
    expect(() => assertFollowUsable(unmappedResponse)).toThrow(/missingEventIds/);
  });

  it('5. multi-part + hand=both is rejected explicitly, never returned as a plan', () => {
    const record = corpus('G1-base');
    const document = JSON.parse(JSON.stringify(record.document));
    const secondPart = JSON.parse(JSON.stringify(document.parts[0]));
    secondPart.partId = 'P2';
    for (const measure of secondPart.measures) {
      for (const event of measure.events) {
        event.eventId = `p2:${event.eventId}`;
        event.source.partId = 'P2';
      }
    }
    document.parts.push(secondPart);
    const error = (() => {
      try {
        callRust(rustService(), document, record.report, configFor());
        return null;
      } catch (cause) {
        return cause;
      }
    })();
    expect(error?.code).toBe('MULTI_PART_PLANNER_UNSUPPORTED');
    expect(error?.message).toContain('single-part');
  });

  it('6. an untrusted plannerVersion is rejected; the server never echoes it', () => {
    const record = corpus('G1-base');
    const config = { ...configFor(), plannerVersion: 'client-forged-42' };
    const error = (() => {
      try {
        callRust(rustService(), record.document, record.report, config);
        return null;
      } catch (cause) {
        return cause;
      }
    })();
    expect(error?.code).toBe('INVALID_PLANNER_VERSION');
    expect(error?.message).toContain('client-forged-42');
  });

  it('7. generation and fingerprint gate use the SAME trusted version and inputs', () => {
    const record = corpus('G1-base');
    const config = configFor();
    const documentJson = JSON.stringify(record.document);
    const reportJson = JSON.stringify(record.report);
    const trustedConfig = { ...config, plannerVersion: RUST_PLANNER_VERSION };
    const service = rustService();
    const response = callRust(service, record.document, record.report, config);
    // Independent replay of the two-step chain with the trusted version.
    const plan = JSON.parse(native.buildPlanV1(documentJson, reportJson, JSON.stringify(trustedConfig)));
    const fingerprint = native.planFingerprintV1Gate(
      documentJson, reportJson, JSON.stringify(plan), JSON.stringify(trustedConfig));
    expect(response.planFingerprint).toBe(fingerprint);
    expect(response.plan).toEqual(plan);
    expect(fingerprint).toMatch(/^plan-v1:sha256:[0-9a-f]{64}$/);
  });

  it('8. a failed or disabled rust path never falls back to a TS plan', () => {
    // The service has no TS planner dependency at all: failures are coded
    // rejections, never a substitute plan object.
    const service = rustService();
    const error = (() => {
      try {
        service.buildRustPlan({ document: null, report: {}, config: {} });
        return null;
      } catch (cause) {
        return cause;
      }
    })();
    expect(error?.code).toBe('INVALID_REQUEST');
    expect(error?.plan).toBeUndefined();
  });

  it('9. the default authority is rts and the switch is fail-closed on unknown values', () => {
    // No RHYTHM_PLANNER in this environment -> the frozen default.
    expect(resolvePlannerAuthority()).toBe('rts');
    expect(() => resolvePlannerAuthority('rts')).not.toThrow();
    expect(() => resolvePlannerAuthority('rust')).not.toThrow();
    expect(() => resolvePlannerAuthority('best-of-both')).toThrow(/INVALID_PLANNER_AUTHORITY/);
    // With the default authority the rust chain refuses to run at all.
    const record = corpus('G1-base');
    const error = (() => {
      try {
        createPlannerService().buildRustPlan(record.document, record.report, configFor());
        return null;
      } catch (cause) {
        return cause;
      }
    })();
    expect(error?.code).toBe('PLANNER_PATH_DISABLED');
    expect(error?.plan).toBeUndefined();
  });

  const realScorePath = process.env.RHYTHM_REAL_SCORE_PATH
    ?? path.join(ROOT, 'score-latest.musicxml');
  describe.skipIf(!existsSync(realScorePath))('R2-3g: real-score end-to-end (local gitignored fixture)', () => {
    it('10. the chain runs the real score end to end and hits the frozen counts', () => {
      const raw = readFileSync(realScorePath, 'utf8');
      const imported = importMusicXml(raw, { fileName: 'real-score.musicxml' });
      expect(imported.scoreDocument).toBeTruthy();
      const projected = projectScoreDocumentV1(imported.scoreDocument, imported.importReport);
      expect(validateScoreDocumentV1(projected.dto)).toEqual([]);
      const config = {
        partId: 'P1',
        range: { startMeasureOrdinal: 1, endMeasureOrdinal: 113 },
        repeatSelection: { kind: 'none' },
        hand: 'both',
        handMapping: {
          schemaVersion: 1, mappingVersion: 'hand-mapping-1', source: 'user',
          parts: [{ partId: 'P1', staves: [{ staffNumber: 1, hand: 'right' }, { staffNumber: 2, hand: 'left' }] }],
        },
        bpm: { numerator: 90, denominator: 1 },
        ticksPerQuarter: 960,
        countInUs: 2_000_000,
        unsupportedNotationPolicy: 'reject-strict',
      };
      const response = callRust(rustService(), projected.dto, imported.importReport, config);
      expect(response.strictAllowed).toBe(true);
      expect(response.plan.occurrences).toHaveLength(1579);
      expect(response.plan.groups).toHaveLength(1018);
      expect(response.plan.atoms).toHaveLength(1018);
      expect(response.plan.scoreEvents).toHaveLength(1579);
      const first = response.planFingerprint;
      const response2 = callRust(rustService(), projected.dto, imported.importReport, config);
      expect(response2.planFingerprint).toBe(first);
      expect(assertTimelineUsable(response)).toBe(true);
    });
  });

  // ---- R2-3g-R1: server-path semantic verification + tamper negatives.
  // The baseline plans below come from the REAL Rust chain; tampering is
  // applied to COPIES and must be rejected by the server-path verifiers.
  describe('R2-3g-R1: server-path deep verification and tamper negatives', () => {
    const record = corpus('G1-base');
    const config = configFor();
    const base = rustService().buildRustPlan({
      document: record.document, report: record.report, config,
    });
    const clone = () => JSON.parse(JSON.stringify(base.plan));
    const gated = (mutate, verifier, code) => {
      const plan = clone();
      mutate(plan);
      expect(() => verifier(plan, { ...config, plannerVersion: RUST_PLANNER_VERSION }))
        .toThrow(new RegExp(code));
    };

    it('11. native Node ESM import of the service module succeeds (no Vitest loader)', async () => {
      const imported = await import('./planner-service.mjs');
      expect(typeof imported.createPlannerService).toBe('function');
      expect(typeof imported.verifyTimelineSemantics).toBe('function');
      expect(imported.resolvePlannerAuthority()).toBe('rts');
    });

    it('12. the real Rust baseline passes BOTH server-path verifiers', () => {
      const trusted = { ...config, plannerVersion: RUST_PLANNER_VERSION };
      expect(verifyTimelineSemantics(base.plan, trusted)).toBe(true);
      expect(verifyFollowCrossReferences(base.plan)).toBe(true);
    });

    it('13. tampered targetOnsetUs / targetDurationUs are rejected', () => {
      gated((plan) => { plan.scoreEvents[0].targetOnsetUs += 1; },
        verifyTimelineSemantics, 'targetOnsetUs');
      gated((plan) => { plan.scoreEvents[1].targetDurationUs += 1; },
        verifyTimelineSemantics, 'targetDurationUs');
    });

    it('14. tampered atom ticks are rejected', () => {
      gated((plan) => { plan.atoms[0].startTick += 960; },
        verifyTimelineSemantics, 'no-exact-group|missing-group');
      gated((plan) => { plan.atoms[2].durationTicks += 480; },
        verifyTimelineSemantics, 'no-exact-group|missing-group');
    });

    it('15. identity tampering (duplicate/dangling/missing score events) is rejected', () => {
      gated((plan) => { plan.scoreEvents[1].runtimeOccurrenceId = plan.scoreEvents[0].runtimeOccurrenceId; },
        verifyTimelineSemantics, 'duplicate|dangling|missing');
      gated((plan) => { plan.scoreEvents.pop(); },
        verifyTimelineSemantics, 'count|missing');
    });

    it('16. follow cross-reference tampering is rejected', () => {
      // duplicate reference inside one group (G1 groups are single-member,
      // so duplicating requires a two-member group: use A4-multivoice)
      const a4Record = corpus('A4-multivoice');
      const a4Base = rustService().buildRustPlan({
        document: a4Record.document, report: a4Record.report, config: (() => {
          const { plannerVersion, ...a4Config } = a4Record.config;
          void plannerVersion;
          return a4Config;
        })(),
      });
      const a4Plan = JSON.parse(JSON.stringify(a4Base.plan));
      a4Plan.groups[0].occurrenceIds[1] = a4Plan.groups[0].occurrenceIds[0];
      a4Plan.groups[0].scoreEventIds[1] = a4Plan.groups[0].scoreEventIds[0];
      a4Plan.groups[0].members[1] = JSON.parse(JSON.stringify(a4Plan.groups[0].members[0]));
      expect(() => verifyFollowCrossReferences(a4Plan))
        .toThrow(/duplicate-ref|scoreEventId-mismatch|multi-referenced/);
      // dangling occurrence reference
      gated((plan) => { plan.groups[0].occurrenceIds[0] = 'ghost:id'; },
        verifyFollowCrossReferences, 'dangling');
      // scoreEventId replaced
      gated((plan) => { plan.groups[0].scoreEventIds[0] = 'wrong:event'; },
        verifyFollowCrossReferences, 'scoreEventId-mismatch');
      // locator swapped
      gated((plan) => {
        plan.groups[0].members[0].sourceOrdinal += 10;
      }, verifyFollowCrossReferences, 'locator-mismatch');
      // occurrence dropped from every group (omission)
      gated((plan) => {
        const orphanId = plan.occurrences[0].occurrenceId;
        for (const group of plan.groups) {
          const at = group.occurrenceIds.indexOf(orphanId);
          if (at >= 0) {
            group.occurrenceIds.splice(at, 1);
            group.scoreEventIds.splice(at, 1);
            group.members.splice(at, 1);
          }
        }
      }, verifyFollowCrossReferences, 'unreferenced|member-count');
    });

    it('17. the server build path itself rejects tampered plans (not only the exported verifiers)', () => {
      // A tampered plan cannot reach the response: the chain re-generates
      // from the inputs and verifies internally — simulated by running the
      // verifiers INSIDE buildRustPlan, which we prove by monkey-patching
      // the native buildPlanV1 to return a tampered plan for one call.
      const service = createPlannerService({ authority: 'rust' });
      const documentJson = JSON.stringify(record.document);
      const reportJson = JSON.stringify(record.report);
      const tampered = JSON.parse(JSON.stringify(base.plan));
      tampered.scoreEvents[0].targetOnsetUs += 1;
      const nativeStub = {
        buildPlanV1: () => JSON.stringify(tampered),
        planFingerprintV1Gate: () => { throw new Error('must not be reached'); },
        beatToMicrosecondsJson: native.beatToMicrosecondsJson,
      };
      const tamperingService = createPlannerService({ authority: 'rust', nativeModule: nativeStub });
      void documentJson; void reportJson; void service;
      expect(() => tamperingService.buildRustPlan({
        document: record.document, report: record.report, config,
      })).toThrow(/TIMELINE_SEMANTICS_REJECTED/);
    });

    it('18. existing behaviors are unchanged: rts default, disabled path, multi-part, version, frozen suites', () => {
      // (covered in full by tests 5/6/8/9 above; re-asserted here for the
      // R1 boundary statement — plus the full suite regression run.)
      expect(resolvePlannerAuthority()).toBe('rts');
      expect(() => createPlannerService().buildRustPlan(record.document, record.report, config))
        .toThrow(/PLANNER_PATH_DISABLED/);
    });
  });
});
