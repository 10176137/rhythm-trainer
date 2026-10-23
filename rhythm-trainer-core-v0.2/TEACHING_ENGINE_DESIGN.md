# Teacher-engine foundation (v0.2)

## Goal

Move from a score-only rhythm engine toward an explainable practice coach without adding an LLM dependency. The engine observes timing outcomes, extracts measurable features, emits limited evidence-bearing diagnoses, and recommends one next exercise. It does not claim to infer a learner's thoughts, technique, or musical intention.

## New Rust module

`crates/rhythm-core/src/teaching.rs`

- `extract_timing_features`: computes matched count, miss/extra rates, signed/absolute timing error, median, population standard deviation, linear drift, and group statistics for targets tagged as rest re-entry or offbeat.
- `diagnose_timing`: a deterministic rule engine. It suppresses performance diagnoses if `measurement_trustworthy == false`; it limits the number of surfaced findings; and every finding includes evidence text and a data-support confidence label.
- `recommend_exercise`: translates the most actionable finding into one exercise prescription with a simple success criterion and an optional BPM adjustment.
- `StudentModel`: tracks evidence for a skill across attempts. `Provisional` means the skill has passed repeated attempts under current conditions. `Consolidated` additionally requires successful unassisted transfer attempts and a delayed retest. This is a transparent heuristic state tracker, not a calibrated probability of mastery.

## Node API added

`analyzeTiming(judgments, context, currentBpm?)` is exposed by the napi-rs binding. The context includes:

- `measurement_trustworthy`: must be false when MIDI event sequence, clock mapping, or score alignment is not reliable.
- `rest_reentry_target_ids`: target IDs labeled by the score importer as the first onset after a rest.
- `offbeat_target_ids`: target IDs labeled by the score importer as offbeat/subdivision onsets.

The score importer must produce these labels. They must not be guessed from timing error alone. The function returns the computed features, up to three prioritized diagnostics, and one primary exercise prescription.

## Default rules

The defaults in `DiagnosisThresholds` are starter engineering parameters, not universal music pedagogy thresholds:

- at least 8 targets for a session-level analysis;
- at least 6 matched hits for timing-pattern diagnoses;
- absolute mean signed error of 20 ms for global early/late bias;
- population standard deviation of 30 ms for unstable timing;
- miss rate of 15%; extra-event-to-target ratio of 10%;
- linear timing-error slope of 3 ms per target;
- 20 ms between-group difference for rest-re-entry/offbeat analysis.

These defaults require real-device validation. They should be versioned, logged with each analysis, and configurable after empirical testing. A rule firing means “a measurable pattern worth investigating,” not “the causal explanation has been proven.”

## Important limitations

1. Current diagnostics operate on rhythm-onset `Judgment`s. They do not yet diagnose pitch errors, note duration, articulation, dynamics, pedal use, hand coordination, or phrasing.
2. Rest/offbeat diagnostics work only if the caller supplies correct target-ID metadata from the parsed score.
3. One attempt can identify a candidate problem; repeated-session history is needed before describing the problem as persistent.
4. The default exercise mapping is deterministic and conservative. It is a starting policy to evaluate, not a clinically or pedagogically validated teaching method.
5. The core module has no serde dependency. The application should persist skill history and policy version in its own storage layer or add a separately reviewed serialization layer.
6. `StudentModel` is available in Rust but is not yet wrapped as a persistent N-API class. The app should not recreate this model in TypeScript as a second source of truth if the team later exposes it through N-API.

## Recommended next development stages

### T1 — Validate the current feature/rule layer

- Run `cargo test` on a Rust-enabled machine.
- Add generated/property tests for schedules and judgments.
- Capture sample sessions and compare diagnosis with a piano teacher's labels.
- Test rules under clean timestamps, deliberate clock offsets, missing events, and score-alignment errors.

### T2 — Add event-to-score alignment

- Parse MusicXML into a score model retaining note identity, voice/hand, onset tick, duration, ties, rests, and articulation hints.
- Align polyphonic MIDI events to score events with explicit skip penalties and confidence metrics.
- Do not run per-note diagnosis when alignment confidence is low.

### T3 — Add duration, voice, and pitch features

- Record Note On and Note Off separately.
- Match pitches within chord groups and voices.
- Measure note duration and inter-hand timing only when the device exposes sufficient MIDI events.
- Store data-quality metadata with each feature.

### T4 — Operationalize student history

- Persist each trustworthy attempt's score policy, tempo, prompts, and transfer/delayed-test status.
- Version the diagnosis and exercise policy.
- Add a `StudentModel` state snapshot/restore API before exposing it to a long-running Node service.

### T5 — Validate educational effectiveness

- Compare detected diagnoses against expert-labeled examples.
- Track original-exercise improvement separately from unpracticed transfer and delayed retention.
- A/B test alternative prescriptions rather than assuming the default rules are optimal.

## Example usage

See `examples/teaching-analysis.js` for the intended Node API shape. The Rust core's unit tests cover deterministic rule behavior, but compilation must be verified with `cargo test` on the target toolchain before relying on this release.
