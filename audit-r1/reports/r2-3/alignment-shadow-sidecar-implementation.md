# Alignment V2 — Timeline Shadow Sidecar

Status: **IMPLEMENTED ON DEVELOPMENT BRANCH; NOT RUN HERE**
Base: r2-3-alignment-v2 @ d56771b
Development branch: r2-3-alignment-v2-shadow-sidecar

## Goal

The same finalized Timeline score targets and the same admitted MIDI performed notes are passed to the existing authoritative Rust scoring-v1 and to the read-only rule-based candidate. Only their note pairing identities are compared. This does not change scoring policies, P08 reports, original traces, score fingerprints, planner contracts, or frozen scoring-v1.

## Wiring and switches

- Default OFF: opt in by setting RHYTHM_ALIGNMENT_SHADOW=1.
- Timeline only; no Follow modifications.
- Research N-API: alignPerformancesCandidate. The official scorePerformance call is unchanged.
- Data: DATA_DIR/assessments/<takeId>/offline-alignment-shadow-v1.json.
- Additive Take assessment fields only when stored: assessmentV2Ref, assessmentV2Summary.
- Read-only URL: GET /api/takes/<takeId>/alignment-shadow. A matching committed Take and exact ref are required.
- Every sidecar records versions, parameter fingerprint, optional runtime code SHA, score and plan fingerprints, raw trace SHA-256 (if persisted), normalized scoring input SHA-256, input and clock quality, pairs/misses/extras, and changed target IDs.
- The raw onset error is never warped or rewritten; candidate output is validated against the original scored MIDI timestamp and pitch.
- Sidecar status is AVAILABLE / DEGRADED / INSUFFICIENT / UNAVAILABLE / INVALID and does not count as an official scoring status.
- Missing candidate, validation error, disk error or resource cap cannot block or change the authoritative Take or score.
- Maximum 2000 score notes and 2000 performed notes are evaluated by the shadow. Over-budget Takes record RESOURCE_LIMIT without executing candidate; V1 keeps scoring normally.
- Sidecar write is atomic, immutable and idempotent; differing existing payloads fail closed instead of overwrite.

### Storage caveat

The sidecar is written just before the official Take is committed, to avoid storing a reference to a missing sidecar. If the Take save permanently fails, an unreferenced derived sidecar may remain. Persist-retry retains its original frozen Take, whose sidecar ref will still be valid. Unreferenced artifacts can be collected separately later; raw Trace and authoritative Take must never be deleted by shadow cleanup.

## Verification commands

Build the Rust addon from this branch and run the Node tests (from repo root):

~~~bash
git switch r2-3-alignment-v2-shadow-sidecar
git rev-parse HEAD
cd rhythm-trainer-core-v0.2/bindings/node
npm ci
npm run build:debug
cd ../../../rhythm-trainer-frontend
npm ci
npx vitest run server/alignment-shadow.test.mjs server/alignment-shadow.integration.test.mjs server/take-finalization.test.mjs server/take-persistence.test.mjs
npm run selftest
npm run build
cd ../rhythm-trainer-core-v0.2
cargo test --workspace
~~~

Integration assertions: real native addon, real WebSocket Timeline finish, persisted Take scoreV1 equals the outbound V1 report, independent shadow ref exists, read-only endpoint matches the sidecar, the delayed +300ms onset remains raw, a candidate provides recovered pairs, and persistence retry does not change the evidence.

Run exploratory 5000/10000-note candidate benchmark:

~~~bash
# From repository root after building the N-API addon:
node audit-r1/benchmarks/alignment-v1/bench-shadow-scale.mjs > audit-r1/benchmarks/alignment-v1/out/shadow-scale.json
~~~

Four cases: clean/phase+300ms times 5000/10000 notes, 10 measured runs after warmup; p50/p95/p99 estimates, RSS delta, deterministic output hashes. Ten runs are insufficient to establish a robust tail latency SLO. A separate 100–2000 note P95, cold starts, 100-repeat stress, and memory cap check remain necessary before Gate D.

Example opt-in environment when recording actual SP-A500 Takes:

~~~bash
export RHYTHM_ALIGNMENT_SHADOW=1
export RHYTHM_CODE_SHA="$(git rev-parse HEAD)"
cd rhythm-trainer-frontend
npm run server
~~~

Turn the flag off to stop research collection. Do not change production scorePerformance or promote candidate scoring on the basis of shadow output.

## Real device and holdout

Capture five categories: (1) clean, (2) one 300–400ms late note then return to grid, (3) one 300ms late note followed by persistent phase, (4) wrong-pitch and missed-note recovery, (5) chord, repeated note and cross-hand unison. Keep original raw MIDI timestamps and NoteOn/NoteOff, pause/clock metadata, plan fingerprint, takeId, P08 screenshot and human-checked score note labels. Collect >=20 independent labeled Takes across multiple pieces for Gate A. A video may support the labels but cannot by itself establish sub-100ms event ground truth.

## Gate status

- Gate B: candidate's 30-case synthetic PASS is a user-reported prior result, not rerun here.
- Gate C: code and unit/integration tests ADDED, execution PENDING.
- Gate D: scaling runner ADDED, measurement PENDING.
- Gate A: real SP-A500 MIDI NOT PROVIDED, BLOCKED.
- Gate E: production switch NOT APPROVED, V1 remains official.

No Rust compiler, native Node addon build, benchmark, live MIDI or test suite was run in this working session: all must be executed on an actual development checkout before claiming PASS.
