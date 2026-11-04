# Alignment benchmark v1 — DP candidate (alignment-dp-v2) summary

- Generated: 2026-11-04T15:37:33.889Z
- Git SHA: `78cacceadcdd271244c0f34f3ba177811f1f635c`
- Dataset: `alignment-bench-v1` (28 timeline, 7 follow)
- Baseline: Rust `alignment-dp-v2` / FollowRuntime
- Deterministic (two runs): **yes**

## Aggregate (Timeline)

| Metric | Value |
|---|---|
| pairingPrecision | 1 |
| pairingRecall | 1 |
| pairingF1 | 1 |
| classAccuracy | 1 |
| onsetMaeVsLabel | 0 |
| quality accuracy | 1 |
| cascade errors (v2 clean-tail) | 0 across 1 trigger cases |
| local IOI MAE vs label (ms) | 0 |
| ambiguous pairs predicted / label-matched | 2 / 0 |

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
| tl-tempo-drift | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
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
| tl-one-note-400ms-late | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-late-300-return | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-late-300-phase | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-late-600-phase | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-early-300-control | 1 | 1 | 1 | 1 | 0 | — | — | healthy |
| tl-missing-note-on | 1 | 1 | 1 | 1 | 0 | — | — | degraded |
| tl-device-disconnect | 1 | 1 | 1 | 1 | 0 | — | — | degraded |
| tl-empty-input | 1 | 1 | 1 | 1 | — | — | — | unscorable |
| tl-clock-degraded-v2 | 1 | 1 | 1 | 1 | 0 | — | 0 | degraded |
| tl-pause-resume-v2 | 1 | 1 | 1 | 1 | 0 | — | 0 | healthy |
| tl-same-time-diff-pitch | 1 | 1 | 1 | 1 | 0 | — | 0 | healthy |
| tl-adversarial-mixed | 1 | 1 | 1 | 1 | 0 | 0/4 | 0 | healthy |
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

- none

Labels are independent of the implementation; a low score is a benchmark observation, not a gate failure at Stage 3.
