# Implementation status — v0.5.0

## Implemented in this source tree

- Deterministic Rust onset timing core inherited from v0.1.
- Timing feature extraction and a starter diagnostic rule set.
- One-step exercise prescription generation.
- Rust in-memory student skill progress model with snapshot/restore and
  duplicate/empty skill-id rejection.
- Raw MIDI decoder, key-lifecycle tracker, duration assessment, pause-aware
  sessions and Take lifecycle.
- `scoring_v1` full-performance scoring: pitch/onset/rhythm/duration/continuity,
  measure reports, overall renormalization, confidence, diagnostics and practice
  ranges, with acceptance tests A–U.
- Node-API `analyzeTiming`, `NativeSession`, `NativeStudentModel`, raw-MIDI
  decode/key-lifecycle APIs and `scorePerformance`.
- Assertion-based JS smoke test and teaching-analysis example.
- Property-style tests over deterministic random schedules/event streams.
- Repeatable 10k-target/10k-event performance benchmark enforcing the 100 ms p95 budget.

## Verification status (this machine, 2026-10-22)

- `cargo test --workspace --target x86_64-pc-windows-gnu`: 110 tests passed
  (82 unit, 1 end-to-end, 5 property, 1 benchmark, 21 scoring acceptance).
- N-API addon rebuilt with the GNU fallback toolchain; `scorePerformance` loaded
  and verified in Node.js (including a spread chord played out of pitch order).
- Frontend engine selftest: 126 assertions passed, including raw MIDI →
  key lifecycle → NAPI `scoring_v1` → persisted report, count-in exclusion,
  pause target shifting, `AVAILABLE` / `DEGRADED` / `INSUFFICIENT_DATA` /
  `UNAVAILABLE` states and history persistence.
- Windows build used the MinGW-w64 fallback documented in the README because
  this machine has no MSVC Build Tools or Windows SDK. Distribution releases
  should still be produced by MSVC CI builds.

## Not yet implemented (do not assume otherwise)

- Real hardware MIDI validation in this environment (no input device was present;
  all end-to-end checks used synthetic raw MIDI).
- Audio output-latency calibration.
- MusicXML parsing inside the Rust core (the frontend supplies semantic score
  events); live/real-time pitch scoring.
- Articulation/pedal/velocity/fingering/posture interpretation.
- Empirical validation against expert piano-teacher labels or user-study evidence.
- Prebuilt cross-platform native binaries (Windows/macOS) from CI.
