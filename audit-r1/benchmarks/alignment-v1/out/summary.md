# Alignment benchmark v1 — baseline summary

- Generated: 2026-10-26T06:48:06.620Z
- Git SHA: `753238b61d5af66351e77b4b5648f15358a65eb0`
- Dataset: `alignment-bench-v1` (19 timeline, 7 follow)
- Baseline: Rust `scoring-v1.0.0` / FollowRuntime
- Deterministic (two runs): **yes**

## Aggregate (Timeline)

| Metric | Value |
|---|---|
| pairingPrecision | 1 |
| pairingRecall | 0.954 |
| pairingF1 | 0.971 |
| classAccuracy | 0.954 |
| onsetMaeVsLabel | 0 |
| quality accuracy | 1 |

## Aggregate (Follow)

| Metric | Value |
|---|---|
| kindAccuracy | 1 |
| casesWithCountErrors | 0 |
| casesWithIntervalErrors | 0 |
| qualityAccuracy | 1 |

## Timeline cases

| Case | Precision | Recall | F1 | Class acc. | Onset ∆ (ms) | Quality |
|---|---|---|---|---|---|---|
| tl-clean-exact | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-late-global | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-local-deviations | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-tempo-drift | 1 | 0.75 | 0.857 | 0.75 | 0 | healthy |
| tl-one-miss | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-consecutive-miss | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-wrong-pitch | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-extra-note | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-mixed-errors | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-chord-arrival-order | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-cross-hand-unison | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-fast-repeated-note | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-tie-long-note | 1 | 0.5 | 0.667 | 0.5 | 0 | healthy |
| tl-missing-note-off | 1 | 1 | 1 | 1 | 0 | degraded |
| tl-duplicate-packet | 1 | 1 | 1 | 1 | 0 | degraded |
| tl-one-note-400ms-late | 1 | 0.875 | 0.933 | 0.875 | 0 | healthy |
| tl-missing-note-on | 1 | 1 | 1 | 1 | 0 | degraded |
| tl-device-disconnect | 1 | 1 | 1 | 1 | 0 | degraded |
| tl-empty-input | 1 | 1 | 1 | 1 | — | unscorable |

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
- `tl-tie-long-note` — tied long note followed by a short note
- `tl-one-note-400ms-late` — one note 400 ms late (outside the normal matching band)

Labels are independent of the implementation; a low score is a benchmark observation, not a gate failure at Stage 3.
