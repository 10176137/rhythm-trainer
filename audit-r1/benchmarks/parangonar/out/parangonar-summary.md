# Stage 4 — Parangonar offline comparison

- Generated: 2026-10-26T08:31:58Z
- Parangonar: 3.4.0 (Apache-2.0, tag 3.4.0, commit 737f6fa)
- Partitura: 1.9.0; Python 3.13.9
- Dataset: alignment-bench-v1 (Timeline only, 19 cases)
- Deterministic (executable cases): **yes**
- Deterministic (all runs, incl. candidate crash): no
- Executed: 18/19 (empty input crashes the candidate)

## Aggregate (same executed cases)

| Metric | scoring_v1 | Parangonar |
|---|---|---|
| pairing precision | 1.0 | 1.0 |
| pairing recall | 0.979 | 0.967 |
| pairing F1 | 0.988 | 0.981 |
| class accuracy | 0.979 | 0.968 |
| onset MAE vs label | 0.0 | 0.0 |

All-19 baseline macro (for reference): F1 0.989, class 0.98.

## Per case

| Case | Baseline F1 | Parangonar F1 | Baseline class | Parangonar class |
|---|---|---|---|---|
| tl-clean-exact | 1 | 1.0 | 1 | 1.0 |
| tl-late-global | 1 | 1.0 | 1 | 1.0 |
| tl-local-deviations | 1 | 1.0 | 1 | 1.0 |
| tl-tempo-drift | 0.857 | 1.0 | 0.75 | 1.0 |
| tl-one-miss | 1 | 1.0 | 1 | 1.0 |
| tl-consecutive-miss | 1 | 1.0 | 1 | 1.0 |
| tl-wrong-pitch | 1 | 0.933 | 1 | 0.875 |
| tl-extra-note | 1 | 1.0 | 1 | 1.0 |
| tl-mixed-errors | 1 | 0.923 | 1 | 0.889 |
| tl-chord-arrival-order | 1 | 1.0 | 1 | 1.0 |
| tl-cross-hand-unison | 1 | 0.8 | 1 | 0.667 |
| tl-fast-repeated-note | 1 | 1.0 | 1 | 1.0 |
| tl-tie-long-note | 1 | 1.0 | 1 | 1.0 |
| tl-missing-note-off | 1 | 1.0 | 1 | 1.0 |
| tl-duplicate-packet | 1 | 1.0 | 1 | 1.0 |
| tl-one-note-400ms-late | 0.933 | 1.0 | 0.875 | 1.0 |
| tl-missing-note-on | 1 | 1.0 | 1 | 1.0 |
| tl-device-disconnect | 1 | 1.0 | 1 | 1.0 |
| tl-empty-input | — | ERROR | — | IndexError: index -1 is out of bounds for axis 0 with size 0 |

## Candidate failures / limits

- `tl-empty-input` — IndexError: index -1 is out of bounds for axis 0 with size 0
- Wrong-pitch targets are not paired by a pitch-based matcher; this is measured, not hidden.
- The candidate is not imported by the production path and is not a production dependency.

## Reading

- This is an offline candidate comparison, not a production switch.
- A higher score is not sufficient: license, dependency risk, determinism and failure cases are part of Stage 4/8.
- Wrong-pitch labels are deliberately hard for a pitch-based matcher; the gap is reported, not treated as ground truth.
