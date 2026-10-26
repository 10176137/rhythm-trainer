# Matchmaker Follow experiment (Stage 6)

Independent, research-only Follow position-tracking experiment. **Not** imported by production and not a production dependency.

## Setup (recorded)

- `pymatchmaker==0.3.0` requires Python `>=3.10,<3.13`; the available system Python 3.9/Anaconda 3.13 do not satisfy it.
- Created an isolated Python 3.12 conda env:
  `audit-r1/benchmarks/matchmaker/.venv312` (gitignored).
- Install: `.venv312/bin/python -m pip install pymatchmaker==0.3.0`.
- Lock: `out/requirements-lock.txt` (numpy 1.26.4, scipy, librosa, partitura, parangonar, etc.).
- License: PyPI metadata declares Apache-2.0 for `pymatchmaker 0.3.0`.
- The earlier `matchmaker` PyPI package (0.1.4) is a different project and was discarded.

## Run

```bash
audit-r1/benchmarks/matchmaker/.venv312/bin/python \
  audit-r1/benchmarks/matchmaker/run_matchmaker.py
```

## Method

- For each Stage 3 Follow case, generate a minimal 4/4 MusicXML score (groups as quarter-beat notes/chords at 60 BPM) and a MIDI performance from the same inputs.
- Run `Matchmaker(score, midi, input_type="midi")` offline (no live device, `wait=False`).
- Collect yielded score positions. Map each position to the nearest group beat; compare with the expected active group derived from the case's labelled kinds.
- Metrics: comparable (one position per input), index accuracy, false advances, correct recoveries, reached expected completed count.
- Determinism: two passes, runtime excluded.

## Result (2026-10-26)

- 7/7 cases executed, two passes deterministic.
- 5/7 comparable; mean index accuracy **1.0**, zero false advances.
- `fw-duplicate-note`: candidate yielded 3 positions for 4 inputs (duplicate input collapsed) → not comparable.
- `fw-extra-after-complete`: candidate yielded no positions once the score ended → post-score extra input not observable.
- The current Rust `FollowRuntime` already had kind accuracy 1.0 on all 7 cases and handles duplicate/extra explicitly.

## Decision

No measurable advantage over the current FollowRuntime; **do not** design/implement a Rust `FollowPositionEstimatorV2` from this evidence. Keep the current推进式 Follow runtime and its error-recovery rules.

## Boundaries

- Offline MIDI, not a live stream: response latency was not measured.
- Pause/resume is not modeled by the generated MIDI timing; the pause case only checks that positions do not jump.
- Position-to-group mapping is nearest-beat, not note-level identity.
- Synthetic data only; no real-device or audio evidence.
