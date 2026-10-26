#!/usr/bin/env python3
"""Stage 4: offline comparison of the frozen scoring_v1 alignment (Stage 3
baseline) against Parangonar's DualDTWNoteMatcher on the SAME traces, labels
and plan config.

Research-only: this script lives under audit-r1/benchmarks and is not imported
by the Node/Rust production path. Labels are read only for comparison; the
matcher receives score/performance note arrays.

Run:
  audit-r1/benchmarks/parangonar/.venv/bin/python \
    audit-r1/benchmarks/parangonar/run_parangonar.py
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
BENCH = HERE.parent / "alignment-v1"
OUT = HERE / "out"
OUT.mkdir(parents=True, exist_ok=True)

MANIFEST = json.loads((BENCH / "manifest.json").read_text())
BASELINE = json.loads((BENCH / "out" / "latest.json").read_text())
BASELINE_CASES = {case["caseId"]: case for case in BASELINE["runs"][0]["cases"]}

SCORE_DTYPE = np.dtype([
    ("onset_beat", "f4"),
    ("duration_beat", "f4"),
    ("onset_quarter", "f4"),
    ("duration_quarter", "f4"),
    ("onset_div", "i8"),
    ("duration_div", "i8"),
    ("pitch", "i4"),
    ("voice", "i4"),
    ("id", "U256"),
    ("is_grace", "i1"),
    ("grace_type", "U256"),
    ("steal_proportion", "f4"),
    ("local_grace_order", "i4"),
    ("staff", "i4"),
])

PERF_DTYPE = np.dtype([
    ("id", "U256"),
    ("pitch", "i4"),
    ("onset_sec", "f8"),
    ("duration_sec", "f8"),
    ("velocity", "i4"),
])


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def score_array(trace: dict[str, Any]) -> np.ndarray:
    count_ms = float(trace["config"]["countInMs"])
    beat_ms = 60_000.0 / float(trace["config"]["bpm"])
    rows = []
    for event in trace["scoreEvents"]:
        onset_beat = (float(event["targetOnsetMs"]) - count_ms) / beat_ms
        duration_beat = float(event["targetDurationMs"]) / beat_ms
        staff = 1
        voice = 1
        part_id = str(event.get("partId", ""))
        if part_id.startswith("staff-"):
            try:
                staff = int(part_id.split("staff-")[1].split(":")[0])
            except (IndexError, ValueError):
                staff = 1
        rows.append((
            onset_beat,
            duration_beat,
            onset_beat,
            duration_beat,
            round(onset_beat * 960),
            round(duration_beat * 960),
            int(event["pitch"]),
            voice,
            str(event["scoreEventId"]),
            0,
            "",
            -1.0,
            -1,
            staff,
        ))
    return np.array(rows, dtype=SCORE_DTYPE)


def performance_array(trace: dict[str, Any]) -> np.ndarray:
    count_ms = float(trace["config"]["countInMs"])
    rows = []
    for note in trace["performed"]:
        onset_sec = (float(note["onsetMs"]) - count_ms) / 1000.0
        release = note.get("releaseMs")
        # Missing Note Off is unknown duration in the raw evidence. Parangonar
        # requires a duration; use 0.0 (no invented duration) and record the
        # limitation in the report.
        duration_sec = 0.0 if release is None else (float(release) - float(note["onsetMs"])) / 1000.0
        rows.append((
            str(note["performedNoteId"]),
            int(note["pitch"]),
            max(0.0, onset_sec),
            max(0.0, duration_sec),
            80,
        ))
    return np.array(rows, dtype=PERF_DTYPE)


def run_matcher(trace: dict[str, Any]) -> list[dict[str, str]]:
    from parangonar import DualDTWNoteMatcher  # imported lazily
    from parangonar.match.matchers import CleanOrnamentMatcher, OnsetMatcherDTW
    from parangonar.dp.dtw import DTWSL

    score = score_array(trace)
    perf = performance_array(trace)
    # Parangonar's default arguments are shared instances; construct fresh
    # components so a previous case cannot affect the next one (determinism).
    matcher = DualDTWNoteMatcher(OnsetMatcherDTW(DTWSL()), CleanOrnamentMatcher())
    alignment = matcher(score, perf)
    result = []
    for item in alignment:
        result.append({
            "label": str(item.get("label")),
            "scoreId": str(item["score_id"]) if "score_id" in item else None,
            "performedId": str(item["performance_id"]) if "performance_id" in item else None,
        })
    # Canonical ordering: Parangonar's internal set/dict iteration is not a
    # contract; alignment identity is. Sort so two passes compare equal.
    result.sort(key=lambda item: (
        item["label"] or "",
        item["scoreId"] or "",
        item["performedId"] or "",
    ))
    return result


def evaluate(trace: dict[str, Any], labels: dict[str, Any], predicted: list[dict[str, str]]) -> dict[str, Any]:
    expected = labels["expected"]
    expected_pairs = {pair["scoreEventId"]: pair for pair in expected["pairs"]}
    predicted_pairs = {
        item["scoreId"]: item["performedId"]
        for item in predicted
        if item["label"] == "match" and item.get("scoreId") and item.get("performedId")
    }
    inserted = {item["performedId"] for item in predicted if item["label"] == "insertion" and item.get("performedId")}
    unassessable = set(expected.get("unassessableScoreEventIds") or [])
    score_by_id = {event["scoreEventId"]: event for event in trace["scoreEvents"]}
    performed_by_id = {note["performedNoteId"]: note for note in trace["performed"]}

    intersection = 0
    class_correct = 0
    class_total = 0
    onset_abs = []
    onset_delta = []
    mismatches = {"pairs": [], "wrongClass": []}
    for score_id, pair in expected_pairs.items():
        predicted_performed = predicted_pairs.get(score_id)
        class_total += 1
        if predicted_performed == pair["performedNoteId"]:
            intersection += 1
            note = performed_by_id[pair["performedNoteId"]]
            score_event = score_by_id[score_id]
            onset_abs.append(abs(note["onsetMs"] - score_event["targetOnsetMs"]))
            onset_delta.append(abs((note["onsetMs"] - score_event["targetOnsetMs"]) - pair["onsetErrorMs"]))
            if pair["pitchMatched"]:
                class_correct += 1
            else:
                mismatches["wrongClass"].append({"scoreId": score_id, "expected": "WRONG_PITCH", "predicted": "MATCH"})
        else:
            mismatches["pairs"].append(score_id)
            mismatches["wrongClass"].append({
                "scoreId": score_id,
                "expected": "MATCH" if pair["pitchMatched"] else "WRONG_PITCH",
                "predicted": "MISSING",
            })
    missed_correct = 0
    for score_id in expected["missedScoreEventIds"]:
        class_total += 1
        if score_id not in predicted_pairs:
            missed_correct += 1
        else:
            mismatches["wrongClass"].append({"scoreId": score_id, "expected": "MISSING", "predicted": "MATCH"})
    extra_correct = 0
    for performed_id in expected["extraPerformedIds"]:
        class_total += 1
        if performed_id in inserted:
            extra_correct += 1
        else:
            mismatches["wrongClass"].append({"performedId": performed_id, "expected": "EXTRA", "predicted": "not-insertion"})
    class_correct += missed_correct + extra_correct

    precision = 1.0 if not predicted_pairs else intersection / len(predicted_pairs)
    recall = 1.0 if not expected_pairs else intersection / len(expected_pairs)
    f1 = 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)
    quality = "degraded" if (
        trace.get("qualitySignals", {}).get("noteOnMissing", 0) > 0
        or trace.get("qualitySignals", {}).get("noteOffMissing", 0) > 0
        or trace.get("qualitySignals", {}).get("duplicates", 0) > 0
        or trace.get("qualitySignals", {}).get("deviceDisconnected", False)
    ) else "healthy"

    return {
        "caseId": trace["caseId"],
        "scenario": trace["scenario"],
        "expected": {
            "pairs": len(expected_pairs),
            "missed": len(expected["missedScoreEventIds"]),
            "extra": len(expected["extraPerformedIds"]),
            "unassessable": len(unassessable),
            "inputQuality": expected["inputQuality"],
        },
        "predicted": {
            "pairs": len(predicted_pairs),
            "insertions": len(inserted),
            "deletions": sum(1 for item in predicted if item["label"] == "deletion"),
            "raw": predicted,
        },
        "metrics": {
            "pairingPrecision": round(precision, 3),
            "pairingRecall": round(recall, 3),
            "pairingF1": round(f1, 3),
            "classAccuracy": round(1.0 if class_total == 0 else class_correct / class_total, 3),
            "onsetMae": round(float(np.mean(onset_abs)) if onset_abs else None, 3) if onset_abs else None,
            "onsetMaeVsLabel": round(float(np.mean(onset_delta)), 3) if onset_delta else None,
            "inputQuality": quality,
            "qualityCorrect": quality == expected["inputQuality"],
        },
        "mismatches": mismatches,
        "baseline": BASELINE_CASES.get(trace["caseId"], {}).get("metrics", {}),
    }


def main() -> None:
    import parangonar
    import partitura
    import numpy

    version_meta = {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "parangonar": getattr(parangonar, "__version__", "unknown"),
        "partitura": getattr(partitura, "__version__", "unknown"),
        "numpy": numpy.__version__,
        "license": "Apache-2.0 (Parangonar 3.4.0 License-Expression)",
        "upstreamTag": "3.4.0",
        "upstreamCommit": "737f6fa32ac432ae17aa9bbc3adb21e4e8d15ced",
        "role": "offline research only; not imported by production",
    }

    cases = [entry for entry in MANIFEST["cases"] if entry["mode"] == "timeline"]
    results = []
    for entry in cases:
        trace_path = BENCH / entry["trace"]
        labels_path = BENCH / entry["labels"]
        trace = json.loads(trace_path.read_text())
        labels = json.loads(labels_path.read_text())
        started = time.perf_counter()
        try:
            predicted = run_matcher(trace)
            result = evaluate(trace, labels, predicted)
            result["ok"] = True
        except Exception as error:  # noqa: BLE001 - research harness must record failures
            result = {
                "caseId": trace["caseId"],
                "scenario": trace["scenario"],
                "ok": False,
                "error": f"{type(error).__name__}: {error}",
            }
        result["runtimeMs"] = round((time.perf_counter() - started) * 1000, 3)
        results.append(result)

    # Determinism: a second pass must produce the same alignment identities.
    second = []
    for entry in cases:
        trace = json.loads((BENCH / entry["trace"]).read_text())
        labels = json.loads((BENCH / entry["labels"]).read_text())
        try:
            result = evaluate(trace, labels, run_matcher(trace))
            result["ok"] = True
        except Exception as error:  # noqa: BLE001
            result = {"caseId": trace["caseId"], "ok": False, "error": f"{type(error).__name__}: {error}"}
        second.append(result)

    def canonical(items: list[dict[str, Any]]) -> str:
        cleaned = json.loads(json.dumps(items))
        for item in cleaned:
            item.pop("runtimeMs", None)
        return json.dumps(cleaned, sort_keys=True)

    deterministic_all = canonical(results) == canonical(second)
    successful = [result for result in results if result.get("ok")]
    failed = [result for result in results if not result.get("ok")]
    nondeterministic_cases = []
    for first, again in zip(results, second):
        # A candidate crash on empty input is a limitation, not an alignment
        # result; determinism is asserted over cases it actually executes.
        if first.get("ok") and again.get("ok") and canonical([first]) != canonical([again]):
            nondeterministic_cases.append(first["caseId"])
    deterministic = len(nondeterministic_cases) == 0

    def mean(values: list[float]) -> float | None:
        return round(sum(values) / len(values), 3) if values else None

    baseline_matched = [
        BASELINE_CASES[result["caseId"]]["metrics"]
        for result in successful
        if result["caseId"] in BASELINE_CASES
    ]
    baseline_matched_macro = {
        "pairingPrecision": mean([m["pairingPrecision"] for m in baseline_matched]),
        "pairingRecall": mean([m["pairingRecall"] for m in baseline_matched]),
        "pairingF1": mean([m["pairingF1"] for m in baseline_matched]),
        "classAccuracy": mean([m["classAccuracy"] for m in baseline_matched]),
        "onsetMaeVsLabel": mean([m["onsetMaeVsLabel"] for m in baseline_matched if m["onsetMaeVsLabel"] is not None]),
    }

    aggregate = {
        "cases": len(results),
        "executed": len(successful),
        "failed": len(failed),
        "macro": {
            "pairingPrecision": mean([r["metrics"]["pairingPrecision"] for r in successful]),
            "pairingRecall": mean([r["metrics"]["pairingRecall"] for r in successful]),
            "pairingF1": mean([r["metrics"]["pairingF1"] for r in successful]),
            "classAccuracy": mean([r["metrics"]["classAccuracy"] for r in successful]),
            "onsetMaeVsLabel": mean([r["metrics"]["onsetMaeVsLabel"] for r in successful if r["metrics"]["onsetMaeVsLabel"] is not None]),
        },
        "baselineMacro": BASELINE["aggregate"]["timeline"]["macro"],
        "baselineMacroExecutedCases": baseline_matched_macro,
        "runtimeMsTotal": round(sum(result["runtimeMs"] for result in results), 3),
        "deterministic": deterministic,
        "deterministicAllRuns": deterministic_all,
        "nondeterministicCases": nondeterministic_cases,
    }

    output = {
        "schemaVersion": 1,
        "stage": 4,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "versions": version_meta,
        "datasetVersion": MANIFEST["datasetVersion"],
        "datasetManifestSha256": sha(json.dumps(MANIFEST, sort_keys=True)),
        "aggregate": aggregate,
        "cases": results,
        "knownLimitations": [
            "Synthetic dataset only (no real-device trace, no public labeled data).",
            "Parangonar is evaluated offline; it is not imported by the production path.",
            "Missing Note Off is represented with duration 0.0 (no invented duration).",
            "Wrong-pitch events are expected to be hard for a pitch-based matcher; this is measured, not hidden.",
        ],
    }
    (OUT / "parangonar-baseline.json").write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n")

    lines = [
        "# Stage 4 — Parangonar offline comparison",
        "",
        f"- Generated: {output['generatedAt']}",
        f"- Parangonar: {version_meta['parangonar']} (Apache-2.0, tag 3.4.0, commit 737f6fa)",
        f"- Partitura: {version_meta['partitura']}; Python {version_meta['python']}",
        f"- Dataset: {MANIFEST['datasetVersion']} (Timeline only, {len(results)} cases)",
        f"- Deterministic (executable cases): **{'yes' if deterministic else 'NO'}**",
        f"- Deterministic (all runs, incl. candidate crash): {'yes' if deterministic_all else 'no'}",
        f"- Executed: {len(successful)}/{len(results)} (empty input crashes the candidate)",
        "",
        "## Aggregate (same executed cases)",
        "",
        "| Metric | scoring_v1 | Parangonar |",
        "|---|---|---|",
        f"| pairing precision | {aggregate['baselineMacroExecutedCases']['pairingPrecision']} | {aggregate['macro']['pairingPrecision']} |",
        f"| pairing recall | {aggregate['baselineMacroExecutedCases']['pairingRecall']} | {aggregate['macro']['pairingRecall']} |",
        f"| pairing F1 | {aggregate['baselineMacroExecutedCases']['pairingF1']} | {aggregate['macro']['pairingF1']} |",
        f"| class accuracy | {aggregate['baselineMacroExecutedCases']['classAccuracy']} | {aggregate['macro']['classAccuracy']} |",
        f"| onset MAE vs label | {aggregate['baselineMacroExecutedCases']['onsetMaeVsLabel']} | {aggregate['macro']['onsetMaeVsLabel']} |",
        "",
        f"All-19 baseline macro (for reference): F1 {aggregate['baselineMacro']['pairingF1']}, class {aggregate['baselineMacro']['classAccuracy']}.",
        "",
        "## Per case",
        "",
        "| Case | Baseline F1 | Parangonar F1 | Baseline class | Parangonar class |",
        "|---|---|---|---|---|",
    ]
    for result in results:
        if result.get("ok"):
            baseline = result.get("baseline", {})
            lines.append(
                f"| {result['caseId']} | {baseline.get('pairingF1', '—')} | {result['metrics']['pairingF1']} | "
                f"{baseline.get('classAccuracy', '—')} | {result['metrics']['classAccuracy']} |"
            )
        else:
            lines.append(f"| {result['caseId']} | — | ERROR | — | {result['error']} |")
    lines.extend([
        "",
        "## Candidate failures / limits",
        "",
        *(f"- `{result['caseId']}` — {result['error']}" for result in failed),
        "- Wrong-pitch targets are not paired by a pitch-based matcher; this is measured, not hidden.",
        "- The candidate is not imported by the production path and is not a production dependency.",
        "",
        "## Reading",
        "",
        "- This is an offline candidate comparison, not a production switch.",
        "- A higher score is not sufficient: license, dependency risk, determinism and failure cases are part of Stage 4/8.",
        "- Wrong-pitch labels are deliberately hard for a pitch-based matcher; the gap is reported, not treated as ground truth.",
        "",
    ])
    (OUT / "parangonar-summary.md").write_text("\n".join(lines))

    # Machine-readable lock evidence (not the venv itself).
    freeze = os.popen(f"{sys.executable} -m pip freeze").read()
    (OUT / "requirements-lock.txt").write_text(freeze)
    print(f"parangonar cases={len(successful)}/{len(results)} deterministic={deterministic} "
          f"F1={aggregate['macro']['pairingF1']}")


if __name__ == "__main__":
    main()
