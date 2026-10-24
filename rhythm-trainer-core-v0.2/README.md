# Rhythm Trainer Core — Rust starter v0.3.0

This repository is the first implementable foundation for the Rhythm Trainer project. It is intentionally a **scoring and event-processing core**, not a complete piano-teacher product yet.

## What is implemented

- Pure Rust core with no third-party runtime dependencies.
- Fixed-capacity FIFO ring buffer. It never silently overwrites events and reports overflow.
- Rhythm-pattern expansion from integer ticks into millisecond target onsets.
- Rest-aware schedules: rests do not create expected hits; notes that start at the same tick are merged into one rhythm target.
- Strict / standard / relaxed judgment profiles, with effective windows reduced for dense rhythms so adjacent target windows do not overlap.
- Deterministic ordered matcher producing `Perfect`, `Good`, `Miss`, and `Extra`.
- Session state machine: `Ready`, `Running`, `Paused`, `Completed`, `Invalid`.
- Pause/resume shifts unresolved targets by pause duration.
- Raw event capture and deterministic final replay, sorted by occurrence timestamp and sequence.
- Report statistics: signed mean timing error, mean absolute error, standard deviation, target hit rate, miss rate, extras.
- Input sequence gap, queue overflow, invalid input and timestamp-order diagnostics.
- Timing feature extraction (median, drift slope, rest-reentry/offbeat group comparisons when score metadata is provided).
- Explainable rule-based diagnosis with evidence, severity and evidence-support labels.
- One primary practice prescription mapped from the most actionable diagnosis.
- **Key-down duration assessment (v0.3):** Note On/Off pairing (FIFO same-pitch repeats, velocity=0 normalization, orphan/open-note quality flags) and per-note duration scoring against tick-derived nominal durations. Key-down time (`Note Off − Note On`), onset error and inter-onset interval are three deliberately separate measurements — see `docs/DURATION-REQUIREMENTS-v0.3.md`. Strict-keydown and disabled policies; articulation-aware (slurs/staccato/pedal context) is a later milestone.
- A Rust `StudentModel` tracking skill progress, repeated passes, transfer attempts and delayed retest evidence, with snapshot/restore for host-side persistence.
- A Node-API binding using `napi-rs` in `bindings/node`, exposing `analyzeTiming`, `NativeSession`, `NativeStudentModel`, raw-MIDI decode/key-lifecycle APIs and `scorePerformance`.
- **Full-performance scoring_v1 (post-finalize):** `scorePerformance` accepts host-supplied per-note score events and performed notes (from the same score plan/Take) and returns the existing `score_performance` report: event-level results, pitch/onset/rhythm/duration/continuity, measure reports, overall/renormalization, confidence, diagnostics and practice ranges. This is not live scoring and does not parse MusicXML itself; the host owns score semantics.
- Unit and integration tests, property-style tests over deterministic random schedules/event streams, and a 10,000-target/10,000-event benchmark enforcing the PRD's 100 ms p95 software-performance budget.

## What is deliberately not implemented yet

- MIDI device discovery or MIDI driver callbacks.
- Clock synchronization between Node and browser AudioContext clocks.
- Audio output-latency calibration.
- MusicXML parsing and score following (the host supplies semantic score events).
- Live/real-time pitch-to-score alignment for polyphonic piano performances; `scorePerformance` is deterministic post-finalize scoring.
- Per-note articulation, hand-coordination and pedal diagnoses (duration scoring against nominal score values now exists; **articulation-aware interpretation** — slurs, staccato, pedal context — and realtime per-note-off feedback are later milestones).
- Sound quality, tone, posture or body movement analysis.

Keep those outside `rhythm-core`. The Rust core accepts already-normalized events and target times, so its behavior stays deterministic and unit-testable.

## Requirements

- Rust stable toolchain (the environment used to generate this starter did not contain `rustc`, so this source has **not been compiled or executed there*). It has since been compiled and tested on Windows with the fallback setup below.
- Node.js 18+ recommended for the optional N-API binding.
- Visual Studio C++ Build Tools on Windows when required by native dependency/toolchain setup.

### Windows build without Visual Studio Build Tools (fallback used for this snapshot)

This machine has no MSVC Build Tools or Windows SDK. Tests and the addon were built with a portable MinGW-w64 toolchain instead:

1. Extract [w64devkit](https://github.com/skeeto/w64devkit) to a user directory (for example `~/dev-tools/w64devkit`).
2. GCC 15+ no longer ships a separate `libgcc_eh.a`; the GNU target still requests it, so create an alias once:
   `cp <w64devkit>/lib/gcc/x86_64-w64-mingw32/<ver>/libgcc.a <same dir>/libgcc_eh.a`
3. Generate a MinGW import library for Node once (`LIBNODE_PATH` is only needed for the addon build):
   `mkdir -p ~/dev-tools/libnode && cd ~/dev-tools/libnode && gendef "/c/Program Files/nodejs/node.exe" && x86_64-w64-mingw32-dlltool -d node.def -l libnode.dll`
4. Run core tests:
   `CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=<w64devkit>/bin/gcc.exe cargo test --target x86_64-pc-windows-gnu`
5. Build the addon:
   `cd bindings/node && PATH="<w64devkit>/bin:$PATH" RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=<w64devkit>/bin/gcc.exe LIBNODE_PATH=~/dev-tools/libnode npm run build:debug`

The resulting `rhythm_trainer_native.node` is a GNU-flavored binary and loads through the existing `bindings/node/index.js` candidates. Distribution releases should still use MSVC builds from CI.

## Run Rust tests

From the repository root:

```bash
cargo test
```

The root workspace includes the Rust core. Since R2-3 (contract_v1 fingerprint layer) the core carries a small set of audited runtime dependencies (unicode-normalization, sha2, serde/serde_json; see crates/rhythm-core/Cargo.toml), so the first build fetches them once from crates.io.

## Build the Node-API binding

```bash
cd bindings/node
npm install
npm run build
```

The binding depends on `napi-rs` crates and downloads dependencies on the first build. Build/test separately on Windows and macOS, then package the correct platform binary with the Node app. This repository does not include precompiled binaries.

## Core event contract

Every accepted event must use the same monotonic millisecond time domain as the target schedule:

```ts
interface StrikeEvent {
  seq: number;              // strictly increasing for one session
  atMs: number;             // occurrence timestamp, not UI receive time
  source: "midi" | "keyboard";
  notes: number[];           // MIDI note numbers; [] for keyboard input
  velocity?: number;         // 0..127 when available
}
```

**Important:** `atMs` is not automatically synchronized by the Rust core. The adapter must convert a Node MIDI timestamp into the session's chosen clock domain before it calls `pushHit`. Do not subtract the player's average late response as device calibration; that would erase a real performance characteristic.

Adapters should also ensure events are sent into the core in non-decreasing timestamp order. If multiple event sources are enabled, merge them in the adapter. For a session that receives timestamp-order errors or sequence gaps, stop claiming the live score is trustworthy; use diagnostics and the raw log to decide whether a replay can recover it.

## Minimal usage shape in JavaScript

The native API is intentionally small. The exact emitted native filename depends on the target platform; run `npm run build` in `bindings/node` before importing it.

```ts
import { buildSchedule, NativeSession } from "./bindings/node";

const targets = buildSchedule(
  {
    id: "example-quarter-notes",
    ticksPerQuarter: 960,
    atoms: [
      { startTick: 0, durationTicks: 960, kind: "note", bar: 1, beat: 1 },
      { startTick: 960, durationTicks: 960, kind: "note", bar: 1, beat: 2 },
      { startTick: 1920, durationTicks: 960, kind: "note", bar: 1, beat: 3 },
      { startTick: 2880, durationTicks: 960, kind: "note", bar: 1, beat: 4 }
    ]
  },
  120,
  1000,
  "standard"
);

const session = new NativeSession(targets, 512, 35);
session.start();
session.pushHit({ seq: 1, atMs: 1000, source: "midi", notes: [60], velocity: 80 });
const realtime = session.processPending();
const report = session.finish();
```

JavaScript object fields use camelCase (`atMs`, `startTick`, `ticksPerQuarter`, ...), matching the generated `bindings/node/index.d.ts`. Run `node examples/node-smoke-test.js` after building the addon; it asserts the expected grades and exits non-zero on failure.

The code is an API example; do not use it as an audio clock implementation. The event timestamp and target schedule must refer to the same clock domain.

To use timing diagnosis after a finalized session, see `examples/teaching-analysis.js` and `TEACHING_ENGINE_DESIGN.md`. Diagnostic defaults are initial engineering thresholds, not empirically established teaching standards.

## Try it in the browser (local demo)

`demo/` contains a minimal spacebar closed loop in the spirit of milestone M0: the browser plays a Web Audio metronome and timestamps spacebar presses; scoring happens only in the local Node process through the Rust core. No scoring logic exists in the page.

```bash
cd bindings/node && npm install && npm run build:debug   # once, to build the addon
cd ../../demo && npm install && node server.js           # serves http://127.0.0.1:8787 (loopback only)
```

Open the printed URL, pick a rhythm pattern and BPM, click 开始训练, and hit the spacebar with the beats after the four-beat count-in. The page shows live grades (准/良/漏/多), a report with statistics, and the rule-based coaching analysis (evidence + one prescription) from `analyzeTiming`.

## Judgment model

| Grade | Rule |
|---|---|
| `perfect` | Absolute timing error is within the target's Perfect window. |
| `good` | Outside Perfect but within the effective Good window. |
| `miss` | Target window has expired without a matching event, or the session ends with an unresolved target. |
| `extra` | Event is not assigned to any unresolved target. |

The built-in profiles use `good_ms` maxima of 30 / 60 / 100 ms and `perfect_ms` of 15 / 30 / 50 ms for strict / standard / relaxed. These are starter defaults, not empirically validated standards. Dense passages automatically narrow the effective windows to 45% of the nearest onset interval. The UI should report the effective window when it differs from the named profile.

## Engineering rules for the next developer

1. Do not implement a second scoring algorithm in TypeScript. Rust is the single source of truth for judgment and final replay.
2. Keep input-device code, clock conversion, WebSocket, and audio scheduling outside `rhythm-core`.
3. Preserve raw events and config/profile versions for every session.
4. Do not call a session score trustworthy when `trustworthy === false`.
5. Add regression tests before changing edge-case behavior.
6. Add a separate `ScoreFollower` for follow-along score reading; do not force free-following into the fixed-tempo `HitMatcher`.
7. The current core matches **rhythm onsets**, not piano pitch correctness. A future `PerformanceAnalyzer` must align note identities/voices from MusicXML to MIDI events before making per-note pitch, articulation, hand-coordination or pedal claims.

## Suggested next milestones

- ~~**C0:** Install Rust and run `cargo test`; fix any compiler/version issues first.~~ Done in v0.2.1 (see the Windows fallback build note above).
- ~~**C1:** Add property tests for random valid schedules and event streams; benchmark 10,000 targets / events.~~ Done in v0.2.1 (`tests/property_tests.rs`, `tests/benchmark.rs`).
- ~~**C6:** Add versioned StudentModel persistence and expose snapshot/restore through N-API.~~ Done in v0.2.1 (`StudentModel::snapshot/restore`, `NativeStudentModel`).
- **C2:** Implement clock mapping and the Node MIDI adapter; verify with loopback/synthetic timestamps.
- **C3:** Add MusicXML importer and note/voice alignment tests.
- **C4:** Compare rule diagnoses with expert-labeled sessions; tune thresholds using real evidence.
- **C5:** Add Note On/Off alignment and reliable per-note pitch/duration/voice features.
- **C7:** Validate original-task improvement separately from unpracticed transfer and delayed retention.
- **C8:** Produce prebuilt MSVC Windows and macOS addon binaries from CI for distribution.
