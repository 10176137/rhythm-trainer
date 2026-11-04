# Alignment benchmark v1 — baseline summary

- Generated: 2026-11-04T08:25:39.534Z
- Git SHA: `9b5ae66d205444ff86faaa6a868675a57addbe9a`
- Dataset: `alignment-bench-v1` (23 timeline, 7 follow)
- Baseline: Rust `alignment-candidate-v2` / FollowRuntime
- Deterministic (two runs): **yes**

## Aggregate (Timeline)

| Metric | Value |
|---|---|
| pairingPrecision | 1 |
| pairingRecall | 0.995 |
| pairingF1 | 0.997 |
| classAccuracy | 0.995 |
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
| tl-tempo-drift | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-one-miss | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-consecutive-miss | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-wrong-pitch | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-extra-note | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-mixed-errors | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-chord-arrival-order | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-cross-hand-unison | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-fast-repeated-note | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-tie-long-note | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-missing-note-off | 1 | 1 | 1 | 1 | 0 | degraded |
| tl-duplicate-packet | 1 | 1 | 1 | 1 | 0 | degraded |
| tl-one-note-400ms-late | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-late-300-return | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-late-300-phase | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-late-600-phase | 1 | 1 | 1 | 1 | 0 | healthy |
| tl-early-300-control | 1 | 0.875 | 0.933 | 0.875 | 0 | healthy |
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

- `tl-early-300-control` — one note 300 ms early (asymmetry control)

Labels are independent of the implementation; a low score is a benchmark observation, not a gate failure at Stage 3.
