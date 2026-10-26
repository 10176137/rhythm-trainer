#!/usr/bin/env python3
"""Stage 6: independent Matchmaker follow experiment.

Builds a minimal MusicXML score and a MIDI performance from each synthetic
Follow case (same groups/inputs as the Rust FollowRuntime benchmark), runs
pymatchmaker offline, and measures score-position advance / false-advance /
recovery. Research only: not imported by production.

Run:
  audit-r1/benchmarks/matchmaker/.venv312/bin/python \
    audit-r1/benchmarks/matchmaker/run_matchmaker.py
"""

from __future__ import annotations

import json
import os
import platform
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
BENCH = HERE.parent / "alignment-v1"
OUT = HERE / "out"
OUT.mkdir(parents=True, exist_ok=True)
MANIFEST = json.loads((BENCH / "manifest.json").read_text())


def build_musicxml(groups: list[dict[str, Any]]) -> str:
    # One 4/4 measure at 60 BPM; groups are quarter-beat positions.
    ordered = sorted(groups, key=lambda group: group["playbackBeat"])
    divisions = 4
    events: list[str] = []
    cursor = 0
    for group in ordered:
        beat = int(round(float(group["playbackBeat"])))
        if beat > cursor:
            events.append(f"<note><rest/><duration>{4 * (beat - cursor)}</duration><voice>1</voice><type>quarter</type></note>")
        cursor = beat
        for index, pitch in enumerate(group["pitches"]):
            chord = "<chord/>" if index > 0 else ""
            step = pitch["spelling"][0]
            octave = int("".join(ch for ch in pitch["spelling"] if ch.isdigit()))
            alter = 1 if "#" in pitch["spelling"] else (-1 if "b" in pitch["spelling"] else 0)
            alter_xml = f"<alter>{alter}</alter>" if alter else ""
            events.append(
                f"<note>{chord}<pitch><step>{step}</step>{alter_xml}<octave>{octave}</octave></pitch>"
                f"<duration>4</duration><voice>1</voice><type>quarter</type></note>"
            )
        cursor = beat + 1
    if cursor < 4:
        events.append(f"<note><rest/><duration>{4 * (4 - cursor)}</duration><voice>1</voice><type>quarter</type></note>")
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">
<measure number="1"><attributes><divisions>{divisions}</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>60</per-minute></metronome></direction-type><sound tempo="60"/></direction>
{''.join(events)}
</measure></part></score-partwise>'''


def build_midi(inputs: list[dict[str, Any]]) -> bytes:
    import mido

    midi = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(60), time=0))
    events = []
    for note in inputs:
        tick = int(round(float(note["atMs"]) / 1000.0 * 480))
        events.append((tick, "on", int(note["midiNote"])))
        events.append((tick + 100, "off", int(note["midiNote"])))
    events.sort(key=lambda item: (item[0], 0 if item[1] == "off" else 1))
    last = 0
    for tick, kind, pitch in events:
        delta = max(0, tick - last)
        last = tick
        if kind == "on":
            track.append(mido.Message("note_on", note=pitch, velocity=80, time=delta))
        else:
            track.append(mido.Message("note_off", note=pitch, velocity=0, time=delta))
    track.append(mido.MetaMessage("end_of_track", time=480))
    buffer = BytesIO()
    midi.save(file=buffer)
    return buffer.getvalue()


from io import BytesIO  # noqa: E402  (used by build_midi)


def expected_active_indices(trace: dict[str, Any], labels: dict[str, Any]) -> list[int]:
    groups = sorted(trace["groups"], key=lambda group: group["playbackBeat"])
    current = 0
    indices = []
    for kind in labels["expected"]["kinds"]:
        if kind in ("correct", "complete"):
            indices.append(current)
            current = min(current + 1, len(groups))
        elif kind == "extra":
            indices.append(len(groups))
        else:  # partial / wrong / duplicate
            indices.append(current)
    return indices


def nearest_group_index(position: float, groups: list[dict[str, Any]]) -> int:
    ordered = sorted(groups, key=lambda group: group["playbackBeat"])
    if position >= float(ordered[-1]["playbackBeat"]) + 0.5:
        return len(ordered)
    return min(
        range(len(ordered)),
        key=lambda index: abs(float(ordered[index]["playbackBeat"]) - position),
    )


def run_case(trace: dict[str, Any], labels: dict[str, Any]) -> dict[str, Any]:
    from matchmaker import Matchmaker

    score_xml = build_musicxml(trace["groups"])
    midi_bytes = build_midi(trace["inputs"])
    with tempfile.TemporaryDirectory() as tmp:
        score_path = Path(tmp) / "score.musicxml"
        midi_path = Path(tmp) / "performance.mid"
        score_path.write_text(score_xml)
        midi_path.write_bytes(midi_bytes)
        started = time.perf_counter()
        matcher = Matchmaker(str(score_path), str(midi_path), input_type="midi")
        positions = [float(value) for value in matcher.run(verbose=False)]
        runtime_ms = (time.perf_counter() - started) * 1000

    groups = trace["groups"]
    expected_indices = expected_active_indices(trace, labels)
    predicted_indices = [nearest_group_index(value, groups) for value in positions[: len(expected_indices)]]
    comparable = len(positions) == len(expected_indices)
    pair_count = min(len(expected_indices), len(predicted_indices))
    matches = (
        sum(1 for index in range(pair_count) if expected_indices[index] == predicted_indices[index])
        if comparable else 0
    )
    false_advances = [
        {
            "inputIndex": index,
            "expectedGroup": expected_indices[index],
            "predictedGroup": predicted_indices[index],
            "position": positions[index],
        }
        for index in range(pair_count)
        if comparable and predicted_indices[index] > expected_indices[index]
    ]
    # Recovery: a correct input after a false advance that lands back on the
    # expected current group.
    recovered = 0
    for index in range(pair_count):
        if (comparable
                and labels["expected"]["kinds"][index] in ("correct", "complete")
                and predicted_indices[index] == expected_indices[index]):
            recovered += 1
    reached_expected = (
        bool(predicted_indices)
        and predicted_indices[-1] + 1 >= int(labels["expected"].get("completedTargets", 0))
    )

    return {
        "caseId": trace["caseId"],
        "scenario": trace["scenario"],
        "ok": True,
        "inputs": len(trace["inputs"]),
        "positions": [round(value, 3) for value in positions],
        "expectedIndices": expected_indices,
        "predictedIndices": predicted_indices,
        "metrics": {
            "comparable": comparable,
            "droppedInputs": len(trace["inputs"]) - len(positions),
            "positionCountMatches": comparable,
            "indexAccuracy": round(matches / pair_count, 3) if comparable and pair_count else None,
            "falseAdvances": len(false_advances),
            "correctRecoveries": recovered,
            "reachedExpectedCompleted": reached_expected,
            "runtimeMs": round(runtime_ms, 3),
        },
        "falseAdvances": false_advances,
        "baseline": labels["expected"],
    }


def main() -> None:
    import matchmaker
    import mido
    import partitura

    follow_cases = [entry for entry in MANIFEST["cases"] if entry["mode"] == "follow"]
    results = []
    for entry in follow_cases:
        trace = json.loads((BENCH / entry["trace"]).read_text())
        labels = json.loads((BENCH / entry["labels"]).read_text())
        try:
            result = run_case(trace, labels)
        except Exception as error:  # noqa: BLE001
            result = {
                "caseId": trace["caseId"],
                "scenario": trace["scenario"],
                "ok": False,
                "error": f"{type(error).__name__}: {error}",
            }
        results.append(result)

    # Determinism on the cases that execute.
    second = []
    for entry in follow_cases:
        trace = json.loads((BENCH / entry["trace"]).read_text())
        labels = json.loads((BENCH / entry["labels"]).read_text())
        try:
            second.append(run_case(trace, labels))
        except Exception as error:  # noqa: BLE001
            second.append({"caseId": trace["caseId"], "ok": False, "error": f"{type(error).__name__}: {error}"})

    def canonical(items: list[dict[str, Any]]) -> str:
        cleaned = json.loads(json.dumps(items))
        for item in cleaned:
            if "metrics" in item:
                item["metrics"].pop("runtimeMs", None)
        return json.dumps(cleaned, sort_keys=True)

    deterministic = canonical(results) == canonical(second)
    successful = [result for result in results if result.get("ok")]
    failed = [result for result in results if not result.get("ok")]
    mean = lambda values: round(sum(values) / len(values), 3) if values else None  # noqa: E731

    output = {
        "schemaVersion": 1,
        "stage": 6,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "versions": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "matchmaker": getattr(matchmaker, "__version__", "unknown"),
            "pymatchmaker": "0.3.0",
            "partitura": getattr(partitura, "__version__", "unknown"),
            "mido": getattr(mido, "__version__", "unknown"),
            "license": "Apache-2.0 (pymatchmaker 0.3.0, PyPI metadata)",
            "role": "independent offline experiment only; not imported by production",
        },
        "datasetVersion": MANIFEST["datasetVersion"],
        "aggregate": {
            "cases": len(results),
            "executed": len(successful),
            "failed": len(failed),
            "deterministic": deterministic,
            "meanIndexAccuracy": mean([result["metrics"]["indexAccuracy"] for result in successful if result["metrics"]["indexAccuracy"] is not None]),
            "comparableCases": sum(1 for result in successful if result["metrics"]["comparable"]),
            "nonComparableCases": [result["caseId"] for result in successful if not result["metrics"]["comparable"]],
            "totalFalseAdvances": sum(result["metrics"]["falseAdvances"] for result in successful),
            "reachedExpectedCompleted": sum(1 for result in successful if result["metrics"]["reachedExpectedCompleted"]),
            "positionCountMismatches": [result["caseId"] for result in successful if not result["metrics"]["positionCountMatches"]],
        },
        "cases": results,
        "knownLimitations": [
            "Synthetic Follow cases only; no real-device or audio input.",
            "Offline MIDI file, not a live stream; response latency is not measured.",
            "Pause semantics are not modeled by the generated MIDI file; the pause case is reported as not comparable.",
            "Matchmaker position -> group index is a nearest-beat mapping, not a note-level identity match.",
        ],
    }
    (OUT / "matchmaker-baseline.json").write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n")

    lines = [
        "# Stage 6 — Matchmaker Follow experiment",
        "",
        f"- Generated: {output['generatedAt']}",
        f"- pymatchmaker: {output['versions']['pymatchmaker']} (Apache-2.0); Python {output['versions']['python']}",
        f"- Dataset: {MANIFEST['datasetVersion']} Follow subset ({len(results)} cases)",
        f"- Deterministic: **{'yes' if deterministic else 'NO'}**",
        f"- Executed: {len(successful)}/{len(results)}",
        "",
        "| Case | Comparable | Index accuracy | False advances | Reached expected | Positions |",
        "|---|---|---|---|---|---|",
    ]
    for result in results:
        if result.get("ok"):
            lines.append(
                f"| {result['caseId']} | {result['metrics']['comparable']} | "
                f"{result['metrics']['indexAccuracy']} | "
                f"{result['metrics']['falseAdvances']} | {result['metrics']['reachedExpectedCompleted']} | "
                f"{result['positions']} |"
            )
        else:
            lines.append(f"| {result['caseId']} | — | ERROR | — | — | {result['error']} |")
    lines.extend([
        "",
        "## Reading",
        "",
        "- This is an independent position-tracking experiment; it does not replace FollowRuntime.",
        "- False advance means the candidate moved ahead of the expected active group.",
        "- Pause latency is not measured because the experiment is offline; a live-stream experiment is still required for Stage 6 acceptance of latency.",
        "",
    ])
    (OUT / "matchmaker-summary.md").write_text("\n".join(lines))
    freeze = os.popen(f"{sys.executable} -m pip freeze").read()
    (OUT / "requirements-lock.txt").write_text(freeze)
    print(f"matchmaker cases={len(successful)}/{len(results)} deterministic={deterministic} "
          f"meanIndexAccuracy={output['aggregate']['meanIndexAccuracy']} falseAdvances={output['aggregate']['totalFalseAdvances']}")


if __name__ == "__main__":
    main()
