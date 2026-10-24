# Core API and design contract

## The event model

`StrikeEvent` is one rhythmic strike, not necessarily one MIDI Note On. A chord should be coalesced by the future MIDI adapter into one event with `notes: [note1, note2, ...]`; do not push each chord tone as an independent rhythmic strike. That MIDI coalescer is not implemented in this starter.

`at_ms` is the event occurrence time normalized into the same monotonic millisecond domain as `TargetHit.at_ms`. Core APIs do not perform clock synchronization. `seq` is assigned by the session adapter and must increase monotonically for all accepted events in that session.

## Core calls

- `build_schedule(pattern, bpm, start_at_ms, profile)` → validated target onsets with effective windows.
- `RingBuffer::push` / `pop` → fixed-capacity FIFO. Queue overflow is returned to the caller; never overwrite silently.
- `SessionEngine::start()` → begin accepting input.
- `SessionEngine::push_event(event)` → log original event and enqueue it.
- `SessionEngine::process_pending()` → consume queued events and return live judgments.
- `SessionEngine::advance(now_ms)` → finalize expired target windows after the configured grace interval.
- `pause(now_ms)` / `resume(now_ms)` → pause and shift unresolved future targets by elapsed pause duration.
- `finish()` → deterministic replay over stored raw events, then return final judgments, summary statistics and data-quality diagnostics.
- `replay_score(targets, events)` → offline scoring; sorts by `(at_ms, seq)` first.

## What a judgment means

- `Perfect` and `Good` refer to a matched target and carry `error_ms = actual - expected`.
- `Miss` refers to an expected target without a matched event. `expected_at_ms` is filled; `actual_at_ms` is absent.
- `Extra` refers to an event that cannot be matched to the first unresolved target. `actual_at_ms` is filled; target fields are absent.

One target consumes at most one event. One event consumes at most one target. An early Extra does not consume the expected target. A sufficiently late event can finalize an earlier target as Miss and still match a later target if it falls within that later target's window.

## Data quality

`trustworthy` is false if the session was invalidated or a queue overflow, sequence gap, duplicate/regressing sequence, timestamp-order error or invalid event was observed. `late_arrival_count` is diagnostic; final replay may correct timing matches if all source events were preserved and remain valid. Do not present an invalid session report as a definitive measurement.

## Full-performance scoring_v1 (post-finalize)

`score_performance(score_events, performed_notes, &ScoringConfig::default())` is
the authoritative offline score for a finalized Take. It does not run during
live play and does not parse MusicXML; the host must supply the semantic score
events and performed notes.

```ts
const report = addon.scorePerformance(scoreEvents, performedNotes);
// eventResults: MATCH | WRONG_PITCH | MISSING | EXTRA | AMBIGUOUS
// pitch, onset, rhythm, duration, continuity, measures, overall,
// confidence, dataDegraded, diagnostics, practiceRanges
```

- Score events are per note occurrence: stable id, measure, beat position,
  MIDI pitch, target onset/duration in ms, part id and optional parse confidence.
- Performed notes use session-relative onsets; a missing Note Off is
  `pairingStatus: 'missing-release'` and contributes no duration verdict.
- `overall.renormalized` means at least one sub-score had no samples. The host
  must not present that as a complete Overall score.
- `confidence: 'low'` / `'not-assessable'` means the evidence is thin; it is not
  a zero score. The host should expose an insufficient-data state.

## Current feature boundary

This core judges rhythm onset timing against a fixed target schedule and, after
a Take is finalized, note identity/timing/duration against supplied per-note
score events. It does not do live pitch scoring, MusicXML parsing, note
release/articulation interpretation, pedal technique, velocity interpretation,
fingering, posture, tone quality or musical expression. Those require additional
host score semantics / audio / sensor modules.

## v0.2 teaching analysis API

Rust exports:

```rust
let mut context = DiagnosticContext::new(session_report.trustworthy);
context.offbeat_target_ids = score_metadata.offbeat_target_ids.clone();
context.rest_reentry_target_ids = score_metadata.rest_reentry_target_ids.clone();
let diagnosis = diagnose_timing(&session_report.judgments, &context);
let prescription = recommend_exercise(&diagnosis, Some(80));
```

The rules are intentionally explainable and conservative. The diagnosis output includes its evidence and a `confidence` label that reflects sample support; it is not a probability that the proposed cause is true. Context target IDs must come from score metadata.

Node binding (JS fields are camelCase, matching the generated `index.d.ts`):

```ts
const analysis = analyzeTiming(judgments, {
  measurementTrustworthy: true,
  restReentryTargetIds: scoreRestReentryIds,
  offbeatTargetIds: scoreOffbeatIds,
}, currentBpm);
```

`analysis.report.features` contains timing statistics, `analysis.report.diagnostics` contains up to three rule findings, and `analysis.prescription` contains one primary next-step exercise. When `measurementTrustworthy` is false, the function returns a measurement warning and suppresses performance diagnosis.

## StudentModel persistence

`StudentModel` tracks per-skill mastery evidence in the Rust core. Persistence is snapshot-based; the host application owns JSON storage, the persistence/teaching layers stay dependency-free; the R2-3 contract_v1 fingerprint layer adds unicode-normalization, sha2 and serde/serde_json (see crates/rhythm-core/Cargo.toml).

Rust:

```rust
let snapshot = model.snapshot();            // Vec<SkillProgress>, sorted by skill id
let restored = StudentModel::restore(snapshot)?;  // rejects duplicate or empty skill ids
```

Node binding (`NativeStudentModel`):

```ts
const model = new NativeStudentModel();                 // empty, or:
const model = new NativeStudentModel(savedSnapshot);    // restore from previous snapshot()
const state = model.observeAttempt('offbeat', {
  passed: true, trustworthy: true, targetCount: 16,
  assisted: false, transferTest: false, delayedRetest: false,
}); // -> 'developing' | 'provisional' | 'consolidated' | 'needs_review' | 'not_assessed'
const saved = model.snapshot();                         // persist this as JSON
```

Attempts with `trustworthy: false` or `targetCount` below the policy minimum do not update mastery and do not create a skill entry, so untrusted sessions never leak into the learning profile. Do not maintain a second conflicting mastery algorithm in TypeScript.
