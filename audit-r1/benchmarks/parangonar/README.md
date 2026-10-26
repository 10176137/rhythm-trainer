# Parangonar offline comparison (Stage 4)

Research-only, isolated Python environment. **Not** imported by the Node/Rust production path and **not** a production dependency.

## Setup (recorded)

- Python: `/opt/anaconda3/bin/python3.13` (3.13.9); system Python 3.9 is below Parangonar's `>=3.10`.
- Venv: `audit-r1/benchmarks/parangonar/.venv` (gitignored).
- Install:

```bash
/opt/anaconda3/bin/python3.13 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install parangonar==3.4.0
.venv/bin/python -m pip install tqdm   # undeclared transitive import in 3.4.0
```

- Pinned evidence: `out/requirements-lock.txt`.
- Upstream: tag `3.4.0`, commit `737f6fa32ac432ae17aa9bbc3adb21e4e8d15ced`.
- License: Parangonar 3.4.0 metadata declares `License-Expression: Apache-2.0`.

## Run

```bash
audit-r1/benchmarks/parangonar/.venv/bin/python \
  audit-r1/benchmarks/parangonar/run_parangonar.py
```

Outputs:

- `out/parangonar-baseline.json` — per-case predictions/metrics, two-pass determinism, versions, limitations;
- `out/parangonar-summary.md` — human-readable comparison;
- `out/requirements-lock.txt` — installed package lock.

## Method

- Input: the Stage 3 `alignment-bench-v1` Timeline traces and labels (same plan/config/performance/ground truth as `scoring_v1`).
- Score note array is built from the trace's canonical `scoreEvents`; performance note array from `performed` Note On/Off. Missing Note Off is represented with duration `0.0` (no invented duration).
- Matcher: `DualDTWNoteMatcher` with fresh `OnsetMatcherDTW(DTWSL())` and `CleanOrnamentMatcher()` per case (Parangonar's default arguments are shared instances; fresh objects are required for cross-case determinism).
- Labels are only used for comparison; they never enter the matcher.
- Onset error is computed from original trace times, never from a DTW warp.

## Result (2026-10-26)

- Executed 18/19 Timeline cases; empty input crashes Parangonar with `IndexError: index -1 ... size 0`.
- Same-18 comparison: baseline F1 **0.970** vs Parangonar **0.962**; class accuracy **0.951** vs **0.941**; recall **0.951** vs **0.939**.
- Improvements: tempo drift (F1 0.857→1.0), one note 400 ms late (0.933→1.0).
- Regressions / limits: cross-hand unison (1.0→0.8), wrong pitch (1.0→0.933/0.875), mixed errors (1.0→0.923/0.889), tie/long note unchanged (0.667).
- Executable cases are deterministic across two passes; the empty-input crash is recorded separately.
- **Stage 5 threshold not met**: no +5 pp macro F1 and no ≥20% hard-case mismatch reduction; clean cases did not degrade.

## Boundaries

- Synthetic dataset only; no real-device or public labeled data.
- Wrong-pitch pairing is structurally hard for a pitch-based matcher; the benchmark reports it instead of hiding it.
- No Parangonar code, model, or data is copied into production. License review for any future distribution is a separate decision.
- If this harness is ever used outside local research, the exact Apache-2.0 notice requirements must be reviewed with the pinned commit.
