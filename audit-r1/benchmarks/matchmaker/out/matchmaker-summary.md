# Stage 6 — Matchmaker Follow experiment

- Generated: 2026-10-26T06:58:31Z
- pymatchmaker: 0.3.0 (Apache-2.0); Python 3.12.15
- Dataset: alignment-bench-v1 Follow subset (7 cases)
- Deterministic: **yes**
- Executed: 7/7

| Case | Comparable | Index accuracy | False advances | Reached expected | Positions |
|---|---|---|---|---|---|
| fw-clean | True | 1.0 | 0 | True | [0.0, 1.0, 2.0] |
| fw-skip-target | True | 1.0 | 0 | True | [0.0, 1.0] |
| fw-wrong-then-correct | True | 1.0 | 0 | True | [0.0, 0.0, 1.0, 2.0] |
| fw-chord-spread | True | 1.0 | 0 | True | [0.0, 0.0, 1.0] |
| fw-duplicate-note | False | None | 0 | True | [0.0, 0.0, 1.0] |
| fw-pause-resume | True | 1.0 | 0 | True | [0.0, 1.0, 2.0] |
| fw-extra-after-complete | False | None | 0 | False | [] |

## Reading

- This is an independent position-tracking experiment; it does not replace FollowRuntime.
- False advance means the candidate moved ahead of the expected active group.
- Pause latency is not measured because the experiment is offline; a live-stream experiment is still required for Stage 6 acceptance of latency.
