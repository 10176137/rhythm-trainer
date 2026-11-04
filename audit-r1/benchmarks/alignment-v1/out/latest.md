# Alignment benchmark v1 — frozen scoring_v1 baseline summary

- Generated: 2026-11-04T15:30:10.852Z
- Git SHA: `1180a1d52cefaa990b84b59033ddaf41011eeac8`
- Dataset: `alignment-bench-v1` (28 timeline, 7 follow)
- Baseline: Rust `scoring-v1.0.1` / FollowRuntime
- Deterministic (two runs): **yes**

## Aggregate (Timeline)

| Metric | Value |
|---|---|
| pairingPrecision | 0.98 |
| pairingRecall | 0.928 |
| pairingF1 | 0.947 |
| classAccuracy | 0.929 |
| onsetMaeVsLabel | 0 |
| quality accuracy | 1 |
| cascade errors (v2 clean-tail) | 0 across 1 trigger cases |
| local IOI MAE vs label (ms) | 0 |
| ambiguous pairs predicted / label-matched | 0 / 0 |

## Aggregate (Follow)

| Metric | Value |
|---|---|
| kindAccuracy | 1 |
| casesWithCountErrors | 0 |
| casesWithIntervalErrors | 0 |
| qualityAccuracy | 1 |

## Timeline cases

| Case | Precision | Recall | F1 | Class acc. | Onset ∆ (ms) | Cascade | IOI MAE | Quality |
|---|---|---|---|---|---|---|---|---|
| tl-clean-exact | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-late-global | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-local-deviations | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-tempo-drift | 1 | 0.75 | 0.857 | 0.75 | 0 | — | — | healthy |
| tl-one-miss | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-consecutive-miss | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-wrong-pitch | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-extra-note | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-mixed-errors | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-chord-arrival-order | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-cross-hand-unison | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-fast-repeated-note | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-tie-long-note | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-missing-note-off | 1 | 1 | 1 | 1 | 0 | — | — | degraded |
| tl-duplicate-packet | 1 | 1 | 1 | 1 | 0 | — | — | degraded |
| tl-one-note-400ms-late | 1 | 0.875 | 0.933 | 0.875 | 0 | — | — | healthy |
| tl-late-300-return | 1 | 0.875 | 0.933 | 0.875 | 0 | — | — | healthy |
| tl-late-300-phase | 1 | 0.375 | 0.545 | 0.375 | 0 | — | — | healthy |
| tl-late-600-phase | 0.429 | 0.375 | 0.4 | 0.375 | 0 | — | — | healthy |
| tl-early-300-control | 1 | 0.875 | 0.933 | 0.875 | 0 | — | — | healthy |
| tl-missing-note-on | 1 | 1 | 1 | 1 | 0 | — | — | degraded |
| tl-device-disconnect | 1 | 1 | 1 | 1 | 0 | — | — | degraded |
| tl-empty-input | 1 | 1 | 1 | 1 | — | — | — | unscorable |
| tl-clock-degraded-v2 | 1 | 1 | 1 | 1 | 0 | — | 0 | degraded |
| tl-pause-resume-v2 | 1 | 1 | 1 | 1 | 0 | — | 0 | healthy |
| tl-same-time-diff-pitch | 1 | 1 | 1 | 1 | 0 | — | 0 | healthy |
| tl-adversarial-mixed | 1 | 0.857 | 0.923 | 0.889 | 0 | 0/4 | 0 | healthy |
| tl-selection-pass-boundary | 1 | 1 | 1 | 1 | 0 | — | 0 | healthy |

## Follow cases

| Case | Kind acc. | Count errors | Interval errors |
|---|---|---|---|
| fw-clean | 1 | — | 0 |
| fw-skip-target | 1 | — | 0 |
| fw-wrong-then-correct | 1 | — | 0 |
| fw-chord-spread | 1 | — | 0 |
| fw-duplicate-note | 1 | — | 0 |
| fw-pause-resume | 1 | — | 0 |
| fw-extra-after-complete | 1 | — | 0 |

## Known baseline failures (expected evidence, not harness failure)

- `tl-tempo-drift` — accelerando / tempo drift
- `tl-one-note-400ms-late` — one note 400 ms late (outside the normal matching band)
- `tl-late-300-return` — one note 300 ms late, then back on the original grid
- `tl-late-300-phase` — one 300 ms phase change, stable intervals afterwards
- `tl-late-600-phase` — one 600 ms phase change: shifted notes land in the next window
- `tl-early-300-control` — one note 300 ms early (asymmetry control)
- `tl-adversarial-mixed` — late + wrong pitch + miss + extra + repeated pitch in one take

Labels are independent of the implementation; a low score is a benchmark observation, not a gate failure at Stage 3.
