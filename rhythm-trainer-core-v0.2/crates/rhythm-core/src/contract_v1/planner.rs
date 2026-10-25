//! R2-3b: planner semantics — `build_plan_v1`, the Rust port of the TS
//! production pipeline that R2-1/R2-2 froze as the parity blueprint:
//!   - `playback-planner.ts` buildPlaybackPlan (:89) — range/loop validation,
//!     tie-aware occurrences, exact rational beat arithmetic, deterministic
//!     ordering, same-onset (chord) grouping;
//!   - `reference-playback-plan.ts` filterPlaybackPlanByHand (:103) — the
//!     practice-scope hand filter (original playbackIndex values are KEPT);
//!   - the canonical projection of `parity-candidate.ts` — "n/d" beat texts,
//!     per-note scoreEvents with Rust-computed integer µs, tick-grid atoms.
//!
//! Input domain: a frozen ScoreDocumentV1 JSON instance (fully validated
//! here — an invalid document can never yield a plan), the ImportReportV1
//! JSON (strictAllowed + fingerprint binding) and the frozen parity-case
//! planner config (validated by the a2 boundary). The output is the frozen
//! PlannerOutput (task card §2.3): directly consumable by the a3 fingerprint
//! gate and projectable onto the R2-2 ParityCandidate shape.
//!
//! All beat arithmetic runs in BigInt and is reduced back into the
//! safe-integer rational domain (task card §3); every divergence between a
//! huge-value edge and TS float behavior is exact-by-construction (C-7/C-9
//! discipline), never an undocumented relaxation.

use std::collections::HashMap;

use num_bigint::BigInt;
use serde_json::{json, Map, Number, Value};

use crate::contract_v1::canonical::utf16_code_unit_cmp;
use crate::contract_v1::config::{validate_plan_request_config, PlanRequestConfig, MAX_LOOP_PASSES};
use crate::contract_v1::document::require_valid_document;
use crate::contract_v1::error::ContractError;
use crate::contract_v1::project::strip_sha256_prefix;
use crate::contract_v1::rational::{
    big_gcd, contract_error, RationalV1, MAX_SAFE_INTEGER,
};
use crate::contract_v1::time::beat_to_microseconds;

const PLANNER_VERSION: &str = "playback-planner-1.0.0";

fn err(code: &str, message: impl Into<String>) -> ContractError {
    contract_error(code, message)
}

// ---------------------------------------------------------------------------
// Exact rational helpers over the validated document domain.
// ---------------------------------------------------------------------------

fn rational_of(value: &Value) -> Result<RationalV1, ContractError> {
    let numerator = value
        .get("numerator")
        .and_then(Value::as_i64)
        .ok_or_else(|| err("INVALID_RATIONAL", "rational.numerator missing"))?;
    let denominator = value
        .get("denominator")
        .and_then(Value::as_i64)
        .ok_or_else(|| err("INVALID_RATIONAL", "rational.denominator missing"))?;
    Ok(RationalV1 { numerator, denominator })
}

/// Reduces an exact BigInt fraction back into the i64 rational domain.
fn reduce_big(numerator: BigInt, denominator: BigInt) -> Result<RationalV1, ContractError> {
    let zero = BigInt::from(0);
    let g = big_gcd(numerator.clone(), denominator.clone());
    let mut n = &numerator / &g;
    let mut d = &denominator / &g;
    if d < zero {
        n = -n;
        d = -d;
    }
    let max = BigInt::from(MAX_SAFE_INTEGER);
    let min = -&max;
    if n > max || n < min || d > max || d < min {
        return Err(err("RATIONAL_OUT_OF_RANGE", "reduced rational exceeds the safe-integer domain"));
    }
    Ok(RationalV1 {
        numerator: i64::try_from(&n).map_err(|_| err("RATIONAL_OUT_OF_RANGE", "numerator out of range"))?,
        denominator: i64::try_from(&d).map_err(|_| err("RATIONAL_OUT_OF_RANGE", "denominator out of range"))?,
    })
}

fn add_rational(a: &RationalV1, b: &RationalV1) -> Result<RationalV1, ContractError> {
    reduce_big(
        BigInt::from(a.numerator) * BigInt::from(b.denominator)
            + BigInt::from(b.numerator) * BigInt::from(a.denominator),
        BigInt::from(a.denominator) * BigInt::from(b.denominator),
    )
}

fn subtract_rational(a: &RationalV1, b: &RationalV1) -> Result<RationalV1, ContractError> {
    reduce_big(
        BigInt::from(a.numerator) * BigInt::from(b.denominator)
            - BigInt::from(b.numerator) * BigInt::from(a.denominator),
        BigInt::from(a.denominator) * BigInt::from(b.denominator),
    )
}

fn multiply_rational_by_i64(a: &RationalV1, multiplier: i64) -> Result<RationalV1, ContractError> {
    reduce_big(
        BigInt::from(a.numerator) * BigInt::from(multiplier),
        BigInt::from(a.denominator),
    )
}

/// Exact three-way comparison (BigInt cross-multiplication; TS compareBeat).
fn compare_rational(a: &RationalV1, b: &RationalV1) -> std::cmp::Ordering {
    let left = BigInt::from(a.numerator) * BigInt::from(b.denominator);
    let right = BigInt::from(b.numerator) * BigInt::from(a.denominator);
    left.cmp(&right)
}

fn beat_text(value: &RationalV1) -> String {
    format!("{}/{}", value.numerator, value.denominator)
}

/// Exact rational → tick conversion; None instead of silently rounding
/// (playback-planner.ts planToTicks :272 — integer-grid-or-refuse).
fn to_ticks(value: &RationalV1, ticks_per_quarter: i64) -> Option<i64> {
    let scaled = BigInt::from(value.numerator) * BigInt::from(ticks_per_quarter);
    let denominator = BigInt::from(value.denominator);
    if &scaled % &denominator != BigInt::from(0) {
        return None;
    }
    let ticks = &scaled / &denominator;
    if ticks < BigInt::from(0) || ticks > BigInt::from(MAX_SAFE_INTEGER) {
        return None;
    }
    i64::try_from(ticks).ok()
}

// ---------------------------------------------------------------------------
// Internal parsed shapes over the validated document.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ParsedPitch {
    step: String,
    alter: RationalV1,
    octave: i64,
    midi_note: Option<i64>,
    spelling: String,
}

#[derive(Debug, Clone)]
struct PlannedOccurrence {
    occurrence_id: String,
    score_event_id: String,
    part_id: String,
    source_measure_ordinal: i64,
    source_ordinal: i64,
    source_voice_id: Option<String>,
    pass_index: i64,
    playback_beat: RationalV1,
    duration_beat: RationalV1,
    measure_ordinal: i64,
    bar: i64,
    beat_in_measure: RationalV1,
    staff_number: i64,
    pitch: Option<ParsedPitch>,
    is_tie_onset: bool,
    playback_index: i64,
}

#[derive(Debug, Clone)]
struct PlannedGroup {
    group_id: String,
    pass_index: i64,
    playback_beat: RationalV1,
    /// Indices into the CURRENT occurrences vector (pre-filter).
    member_indices: Vec<usize>,
    bar: i64,
    beat_in_measure: RationalV1,
    duration_beat: RationalV1,
}

fn parse_pitch(event: &Map<String, Value>) -> Result<Option<ParsedPitch>, ContractError> {
    let Some(pitch) = event.get("pitch") else {
        return Ok(None);
    };
    let object = pitch
        .as_object()
        .ok_or_else(|| err("INVALID_EVENT", "event.pitch must be an object"))?;
    Ok(Some(ParsedPitch {
        step: object.get("step").and_then(Value::as_str).unwrap_or_default().to_string(),
        alter: rational_of(object.get("alter").unwrap_or(&Value::Null))?,
        octave: object.get("octave").and_then(Value::as_i64).unwrap_or_default(),
        midi_note: object.get("midiNote").and_then(Value::as_i64),
        spelling: object.get("spelling").and_then(Value::as_str).unwrap_or_default().to_string(),
    }))
}

fn integer_of(value: Option<&Value>, field: &str) -> Result<i64, ContractError> {
    value
        .and_then(Value::as_i64)
        .ok_or_else(|| err("INVALID_EVENT", format!("{field} must be an integer")))
}

fn string_of(value: Option<&Value>, field: &str) -> Result<String, ContractError> {
    value
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| err("INVALID_EVENT", format!("{field} must be a string")))
}

// ---------------------------------------------------------------------------
// Practice-scope assessment (port of scope/practice-scope.ts, V1 document).
// ---------------------------------------------------------------------------

/// Distinct staff numbers of one part over ALL measures (events + clefs);
/// defaults to {1} when the part carries none (practice-scope.ts :70).
fn distinct_staff_numbers<'a>(parts: &'a [Value], part_id: &str) -> Vec<i64> {
    let mut staffs = std::collections::BTreeSet::new();
    for part in parts {
        if part.get("partId").and_then(Value::as_str) != Some(part_id) {
            continue;
        }
        for measure in part.get("measures").and_then(Value::as_array).into_iter().flatten() {
            for event in measure.get("events").and_then(Value::as_array).into_iter().flatten() {
                if let Some(staff) = event.get("source").and_then(|s| s.get("staffNumber")).and_then(Value::as_i64) {
                    staffs.insert(staff);
                }
            }
            for clef in measure.get("attributes").and_then(|a| a.get("clefs")).and_then(Value::as_array).into_iter().flatten() {
                if let Some(staff) = clef.get("staffNumber").and_then(Value::as_i64) {
                    staffs.insert(staff);
                }
            }
        }
    }
    if staffs.is_empty() {
        staffs.insert(1);
    }
    staffs.into_iter().collect()
}

/// Playable-target count of one part/staff inside the range
/// (practice-scope.ts countTargetEvents :46).
fn count_target_events(parts: &[Value], part_id: &str, staff_number: i64, start: i64, end: i64) -> i64 {
    let mut count = 0;
    for part in parts {
        if part.get("partId").and_then(Value::as_str) != Some(part_id) {
            continue;
        }
        for measure in part.get("measures").and_then(Value::as_array).into_iter().flatten() {
            let ordinal = measure.get("ordinal").and_then(Value::as_i64).unwrap_or(0);
            if ordinal < start || ordinal > end {
                continue;
            }
            for event in measure.get("events").and_then(Value::as_array).into_iter().flatten() {
                if event.get("kind").and_then(Value::as_str) != Some("note")
                    || event.get("isGrace").and_then(Value::as_bool).unwrap_or(false)
                    || event.get("isCue").and_then(Value::as_bool).unwrap_or(false)
                {
                    continue;
                }
                if event.get("source").and_then(|s| s.get("staffNumber")).and_then(Value::as_i64) == Some(staff_number) {
                    count += 1;
                }
            }
        }
    }
    count
}

/// Port of assessPracticeScope (:94) — the frozen scope issue codes, in the
/// TS push order. The config boundary already guarantees a well-formed
/// mapping (user/score-metadata source, schema/mapping versions), so the
/// missing-mapping / heuristic branches reduce to the part lookup.
fn assess_practice_scope(parts: &[Value], config: &PlanRequestConfig) -> Vec<String> {
    let mut codes: Vec<String> = Vec::new();
    let start = config.range.start_measure_ordinal;
    let end = config.range.end_measure_ordinal;

    let part = parts.iter().find(|part| part.get("partId").and_then(Value::as_str) == Some(config.part_id.as_str()));
    let Some(part) = part else {
        return vec!["range_part_mismatch".to_string()];
    };
    if parts.len() > 1 {
        return vec!["multiple_parts_require_part_selection".to_string()];
    }

    let mapping = config
        .hand_mapping
        .parts
        .iter()
        .find(|part| part.partId == config.part_id);
    let Some(mapping) = mapping else {
        // No mapping entry for the part: the mapping is incomplete regardless
        // of staff counts (missingStaffs is a UI detail, not a contract code).
        return vec!["hand_mapping_incomplete".to_string()];
    };

    let mapped_staffs: std::collections::BTreeSet<i64> =
        mapping.staves.iter().map(|staff| staff.staff_number).collect();
    let mut incomplete = false;
    for staff_number in distinct_staff_numbers(parts, &config.part_id) {
        if mapped_staffs.contains(&staff_number) {
            continue;
        }
        let _event_count = count_target_events(parts, &config.part_id, staff_number, start, end);
        incomplete = true;
    }
    if incomplete {
        codes.push("hand_mapping_incomplete".to_string());
    }

    // The range must keep at least one playable note after the hand filter.
    let mut in_range = false;
    'outer: for measure in part.get("measures").and_then(Value::as_array).into_iter().flatten() {
        let ordinal = measure.get("ordinal").and_then(Value::as_i64).unwrap_or(0);
        if ordinal < start || ordinal > end {
            continue;
        }
        for event in measure.get("events").and_then(Value::as_array).into_iter().flatten() {
            if event.get("kind").and_then(Value::as_str) != Some("note")
                || event.get("isGrace").and_then(Value::as_bool).unwrap_or(false)
                || event.get("isCue").and_then(Value::as_bool).unwrap_or(false)
            {
                continue;
            }
            let staff_number = event.get("source").and_then(|s| s.get("staffNumber")).and_then(Value::as_i64);
            let Some(staff) = mapping.staves.iter().find(|staff| Some(staff.staff_number) == staff_number) else {
                continue;
            };
            if config.hand != "both" && staff.hand != config.hand {
                continue;
            }
            in_range = true;
            break 'outer;
        }
    }
    if !in_range {
        codes.push("range_empty_after_hand_filter".to_string());
    }
    codes
}

/// Port of handByScoreEventIdFromMapping (:207): scoreEventId -> hand for the
/// scope's part/range; unmapped events are simply absent (fail closed).
fn hand_by_score_event_id(parts: &[Value], config: &PlanRequestConfig) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(mapping) = config
        .hand_mapping
        .parts
        .iter()
        .find(|part| part.partId == config.part_id)
    else {
        return map;
    };
    let start = config.range.start_measure_ordinal;
    let end = config.range.end_measure_ordinal;
    for part in parts {
        if part.get("partId").and_then(Value::as_str) != Some(config.part_id.as_str()) {
            continue;
        }
        for measure in part.get("measures").and_then(Value::as_array).into_iter().flatten() {
            let ordinal = measure.get("ordinal").and_then(Value::as_i64).unwrap_or(0);
            if ordinal < start || ordinal > end {
                continue;
            }
            for event in measure.get("events").and_then(Value::as_array).into_iter().flatten() {
                if event.get("kind").and_then(Value::as_str) != Some("note")
                    || event.get("isGrace").and_then(Value::as_bool).unwrap_or(false)
                    || event.get("isCue").and_then(Value::as_bool).unwrap_or(false)
                {
                    continue;
                }
                let Some(event_id) = event.get("eventId").and_then(Value::as_str) else {
                    continue;
                };
                let staff_number = event.get("source").and_then(|s| s.get("staffNumber")).and_then(Value::as_i64);
                if let Some(staff) = mapping.staves.iter().find(|staff| staff.staff_number == staff_number.unwrap_or(0)) {
                    map.insert(event_id.to_string(), staff.hand.clone());
                }
            }
        }
    }
    map
}

// ---------------------------------------------------------------------------
// build_plan_v1
// ---------------------------------------------------------------------------

/// THE planner entry: frozen ScoreDocumentV1 + ImportReportV1 + parity-case
/// config → PlannerOutput JSON (task card §2.3). Fails closed on every
/// invalid input; the output is directly consumable by
/// `plan_fingerprint_v1_gate` and projectable onto ParityCandidate.
pub fn build_plan_v1(
    document_json: &Value,
    report_json: &Value,
    config_json: &Value,
) -> Result<Value, ContractError> {
    // 0. Config boundary (a2) — an invalid config never yields a plan.
    let config: PlanRequestConfig = serde_json::from_value(config_json.clone())
        .map_err(|error| err("SCHEMA_VIOLATION", error.to_string()))?;
    validate_plan_request_config(&config)?;

    // 1. Full ScoreDocumentV1 validation (a3) — fail closed.
    require_valid_document(document_json)?;

    // 2. C-12 identity: source.sourceFingerprint (sha256:-prefixed) is the
    //    only fingerprint the V1 document carries; it must match the report.
    let source_fingerprint = document_json
        .get("source")
        .and_then(|source| source.get("sourceFingerprint"))
        .and_then(Value::as_str)
        .ok_or_else(|| err("INVALID_SOURCE_FINGERPRINT", "source.sourceFingerprint missing"))?;
    let score_fingerprint = strip_sha256_prefix(source_fingerprint)?;
    let report_fingerprint = report_json
        .get("fingerprint")
        .and_then(Value::as_str)
        .ok_or_else(|| err("INVALID_SOURCE_FINGERPRINT", "report.fingerprint missing"))?;
    if score_fingerprint != report_fingerprint {
        return Err(err("DOCUMENT_REPORT_MISMATCH",
            format!("document fingerprint {source_fingerprint} does not match report fingerprint {report_fingerprint}")));
    }
    let strict_allowed = match report_json.get("strictAllowed") {
        Some(Value::Bool(flag)) => *flag,
        _ => return Err(err("INVALID_REPORT", "report.strictAllowed must be a boolean")),
    };

    let empty = Vec::new();
    let parts = document_json.get("parts").and_then(Value::as_array).unwrap_or(&empty);
    let tie_spans = document_json.get("tieSpans").and_then(Value::as_array).unwrap_or(&empty);

    // 3. Range + loop validation (playback-planner.ts :90-101).
    let start = config.range.start_measure_ordinal;
    let end = config.range.end_measure_ordinal;
    let measure_count = parts
        .iter()
        .map(|part| part.get("measures").and_then(Value::as_array).map(Vec::len).unwrap_or(0))
        .max()
        .unwrap_or(0);
    if start < 1 || end < start || end > measure_count as i64 {
        return Err(err("INVALID_RANGE",
            format!("invalid measure range: {start}–{end} (score has {measure_count} measures)")));
    }
    let passes = match config.repeat_selection.kind.as_str() {
        "range-loop" => config.repeat_selection.count.unwrap_or(0),
        _ => 1,
    };
    if passes < 1 || passes > MAX_LOOP_PASSES {
        return Err(err("INVALID_REPEAT_COUNT",
            format!("A–B loop count must be within 1–{MAX_LOOP_PASSES}, got {passes}")));
    }

    // Reference measures (parts[0]) select the range span (:75).
    let reference_measures: Vec<&Value> = parts
        .first()
        .and_then(|part| part.get("measures").and_then(Value::as_array))
        .map(|measures| {
            measures
                .iter()
                .filter(|measure| {
                    let ordinal = measure.get("ordinal").and_then(Value::as_i64).unwrap_or(0);
                    ordinal >= start && ordinal <= end
                })
                .collect()
        })
        .unwrap_or_default();
    if reference_measures.is_empty() {
        return Err(err("INVALID_RANGE", format!("measure range {start}–{end} has no usable measures")));
    }
    let range_start_beat = rational_of(
        reference_measures[0].get("startBeat").ok_or_else(|| err("INVALID_MEASURE", "measure.startBeat missing"))?,
    )?;
    let mut range_duration_beat = RationalV1 { numerator: 0, denominator: 1 };
    for measure in &reference_measures {
        let duration = rational_of(
            measure.get("durationBeat").ok_or_else(|| err("INVALID_MEASURE", "measure.durationBeat missing"))?,
        )?;
        range_duration_beat = add_rational(&range_duration_beat, &duration)?;
    }

    // planId branch follows repeatSelection.KIND (playback-planner.ts :107-113):
    // range-loop reads `loop{count}` even when count == 1 — a legal config
    // (1..=32) whose IDs must not silently read `once`.
    let plan_id = format!(
        "plan:{}:m{start}-{end}:{}:{PLANNER_VERSION}",
        &score_fingerprint[..16],
        if config.repeat_selection.kind == "range-loop" {
            format!("loop{passes}")
        } else {
            "once".to_string()
        },
    );

    // 4. Plan issues (strict blockers), TS order (:115-131, :208-214).
    let mut plan_issues: Vec<Value> = Vec::new();
    if !strict_allowed {
        plan_issues.push(json!({
            "code": "score_not_strict_ready", "blocksStrict": true,
        }));
    }
    let capabilities: Vec<String> = document_json
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    if capabilities.iter().any(|capability| capability == "repeat")
        && config.unsupported_notation_policy == "reject-strict"
    {
        plan_issues.push(json!({
            "code": "unsupported_repeat_structure", "blocksStrict": true,
        }));
    }

    // 5. Collect playable refs (collectEvents :46): notes with pitch inside
    //    the range; grace/cue never targets. Rests dropped by kind.
    struct EventRef<'a> {
        event: &'a Map<String, Value>,
        measure: &'a Map<String, Value>,
    }
    let mut refs: Vec<EventRef> = Vec::new();
    for part in parts {
        for measure in part.get("measures").and_then(Value::as_array).into_iter().flatten() {
            let ordinal = measure.get("ordinal").and_then(Value::as_i64).unwrap_or(0);
            if ordinal < start || ordinal > end {
                continue;
            }
            for event in measure.get("events").and_then(Value::as_array).into_iter().flatten() {
                if event.get("kind").and_then(Value::as_str) != Some("note") {
                    continue;
                }
                if event.get("pitch").is_none()
                    || event.get("isGrace").and_then(Value::as_bool).unwrap_or(false)
                    || event.get("isCue").and_then(Value::as_bool).unwrap_or(false)
                {
                    continue;
                }
                refs.push(EventRef {
                    event: event.as_object().expect("validated event object"),
                    measure: measure.as_object().expect("validated measure object"),
                });
            }
        }
    }

    // Tie-span index: id -> (first member event id, endBeat) (:61-73).
    let mut tie_index: HashMap<String, (String, RationalV1)> = HashMap::new();
    for span in tie_spans {
        let id = string_of(span.get("id"), "tieSpan.id")?;
        let first = span
            .get("eventIds")
            .and_then(Value::as_array)
            .and_then(|ids| ids.first())
            .and_then(Value::as_str)
            .ok_or_else(|| err("INVALID_TIE_SPAN", "tieSpan.eventIds[0] missing"))?
            .to_string();
        let end_beat = rational_of(span.get("endBeat").ok_or_else(|| err("INVALID_TIE_SPAN", "tieSpan.endBeat missing"))?)?;
        tie_index.insert(id, (first, end_beat));
    }

    // 6. Occurrences per pass (:135-163). Tie continuations emit nothing; a
    //    tie ONSET's duration stretches to the span end.
    let mut occurrences: Vec<PlannedOccurrence> = Vec::new();
    for pass_index in 0..passes {
        let pass_offset = multiply_rational_by_i64(&range_duration_beat, pass_index)?;
        for reference in &refs {
            let event = reference.event;
            let measure = reference.measure;
            let event_id = string_of(event.get("eventId"), "event.eventId")?;
            let tie_span_id = event.get("tieSpanId").and_then(Value::as_str).map(str::to_string);
            let tie_span = tie_span_id.as_ref().and_then(|id| tie_index.get(id));
            // isTieContinuation (:69): a span member that is not the first.
            if tie_span.map(|(first, _)| first != &event_id).unwrap_or(false) {
                continue;
            }
            let onset_beat = rational_of(event.get("onsetBeat").ok_or_else(|| err("INVALID_EVENT", "event.onsetBeat missing"))?)?;
            let measure_start_beat = rational_of(measure.get("startBeat").ok_or_else(|| err("INVALID_MEASURE", "measure.startBeat missing"))?)?;
            let own_duration = rational_of(event.get("durationBeat").ok_or_else(|| err("INVALID_EVENT", "event.durationBeat missing"))?)?;
            // scoreTieDuration (:61): only the FIRST member stretches.
            let duration_beat = match tie_span {
                Some((first, end_beat)) if first == &event_id => subtract_rational(end_beat, &onset_beat)?,
                _ => own_duration,
            };
            let source = event.get("source").and_then(Value::as_object).ok_or_else(|| err("INVALID_EVENT", "event.source missing"))?;
            let measure_ordinal = integer_of(measure.get("ordinal"), "measure.ordinal")?;
            occurrences.push(PlannedOccurrence {
                occurrence_id: format!("{plan_id}:p{pass_index}:{event_id}"),
                score_event_id: event_id.clone(),
                part_id: string_of(source.get("partId"), "source.partId")?,
                source_measure_ordinal: integer_of(source.get("measureOrdinal"), "source.measureOrdinal")?,
                source_ordinal: integer_of(source.get("sourceOrdinal"), "source.sourceOrdinal")?,
                source_voice_id: source.get("voiceId").and_then(Value::as_str).map(str::to_string),
                pass_index,
                playback_beat: add_rational(&subtract_rational(&onset_beat, &range_start_beat)?, &pass_offset)?,
                duration_beat,
                measure_ordinal,
                bar: measure_ordinal,
                beat_in_measure: subtract_rational(&onset_beat, &measure_start_beat)?,
                staff_number: integer_of(source.get("staffNumber"), "source.staffNumber")?,
                pitch: parse_pitch(event)?,
                is_tie_onset: tie_span.map(|(first, _)| first == &event_id).unwrap_or(false),
                playback_index: -1,
            });
        }
    }

    // 7. Deterministic order (:164-171): playbackBeat, passIndex, bar,
    //    occurrenceId. Exact BigInt comparison stands in for TS cross-multiply.
    occurrences.sort_by(|a, b| {
        compare_rational(&a.playback_beat, &b.playback_beat)
            .then(a.pass_index.cmp(&b.pass_index))
            .then(a.bar.cmp(&b.bar))
            .then(a.occurrence_id.cmp(&b.occurrence_id))
    });
    for (index, occurrence) in occurrences.iter_mut().enumerate() {
        occurrence.playback_index = index as i64;
    }

    // 8. Same-onset grouping (:173-206). Key = pass:beatText over the sorted
    //    occurrences; group duration = longest member.
    let mut group_order: Vec<(i64, String)> = Vec::new();
    let mut groups_by_key: HashMap<String, PlannedGroup> = HashMap::new();
    for (index, occurrence) in occurrences.iter().enumerate() {
        let key = format!("{}:{}", occurrence.pass_index, beat_text(&occurrence.playback_beat));
        if !groups_by_key.contains_key(&key) {
            group_order.push((occurrence.pass_index, beat_text(&occurrence.playback_beat)));
            groups_by_key.insert(key.clone(), PlannedGroup {
                group_id: format!("{plan_id}:g{}:{}", occurrence.pass_index, beat_text(&occurrence.playback_beat)),
                pass_index: occurrence.pass_index,
                playback_beat: occurrence.playback_beat.clone(),
                member_indices: Vec::new(),
                bar: occurrence.bar,
                beat_in_measure: occurrence.beat_in_measure.clone(),
                duration_beat: RationalV1 { numerator: 0, denominator: 1 },
            });
        }
        let group = groups_by_key.get_mut(&key).expect("just inserted");
        group.member_indices.push(index);
        if compare_rational(&occurrence.duration_beat, &group.duration_beat) == std::cmp::Ordering::Greater {
            group.duration_beat = occurrence.duration_beat.clone();
        }
    }
    let mut groups: Vec<PlannedGroup> = group_order
        .iter()
        .map(|(pass, beat)| groups_by_key[&format!("{pass}:{beat}")].clone())
        .collect();
    groups.sort_by(|a, b| {
        compare_rational(&a.playback_beat, &b.playback_beat).then_with(|| a.group_id.cmp(&b.group_id))
    });

    if occurrences.is_empty() {
        plan_issues.push(json!({
            "code": "no_playable_notes", "blocksStrict": true,
        }));
    }

    // 9. Hand filter (:103 reference-playback-plan.ts): 'both' is a no-op;
    //    otherwise only mapped occurrences of the selected hand survive, the
    //    group is recomputed from the survivors (longest selected duration),
    //    empty groups drop, and playbackIndex values are NOT renumbered.
    let mut scope_codes: Vec<String> = Vec::new();
    let mut missing_event_ids: Vec<String> = Vec::new();
    let mut plan_id_final = plan_id.clone();
    if config.hand != "both" {
        scope_codes = assess_practice_scope(parts, &config);
        let hand_map = hand_by_score_event_id(parts, &config);
        let mut filtered_occurrences: Vec<PlannedOccurrence> = Vec::new();
        let mut filtered_groups: Vec<PlannedGroup> = Vec::new();
        let mut seen_missing = std::collections::HashSet::new();
        for group in &groups {
            let mut selected: Vec<usize> = Vec::new();
            for member in &group.member_indices {
                let occurrence = &occurrences[*member];
                match hand_map.get(&occurrence.score_event_id) {
                    Some(hand) if *hand == config.hand => selected.push(*member),
                    Some(_) => {}
                    None => {
                        if seen_missing.insert(occurrence.score_event_id.clone()) {
                            missing_event_ids.push(occurrence.score_event_id.clone());
                        }
                    }
                }
            }
            if selected.is_empty() {
                continue;
            }
            for index in &selected {
                filtered_occurrences.push(occurrences[*index].clone());
            }
            filtered_groups.push(PlannedGroup {
                group_id: group.group_id.clone(),
                pass_index: group.pass_index,
                playback_beat: group.playback_beat.clone(),
                member_indices: {
                    let base = filtered_occurrences.len() - selected.len();
                    (base..filtered_occurrences.len()).collect()
                },
                bar: group.bar,
                beat_in_measure: group.beat_in_measure.clone(),
                duration_beat: selected
                    .iter()
                    .map(|index| occurrences[*index].duration_beat.clone())
                    .reduce(|longest, value| {
                        if compare_rational(&value, &longest) == std::cmp::Ordering::Greater {
                            value
                        } else {
                            longest
                        }
                    })
                    .expect("selected non-empty"),
            });
        }
        occurrences = filtered_occurrences;
        groups = filtered_groups;
        plan_id_final = format!("{plan_id}:hand={}", config.hand);
    }

    // 10. Atoms on the tick grid (scoreOccurrencesToEngineAtoms :242): an
    //     inexact conversion is a blocking issue, never a rounded atom.
    let mut atoms: Vec<Value> = Vec::new();
    let mut atom_issue_codes: Vec<String> = Vec::new();
    for group in &groups {
        let (Some(start_tick), Some(duration_ticks)) = (
            to_ticks(&group.playback_beat, config.ticks_per_quarter),
            to_ticks(&group.duration_beat, config.ticks_per_quarter),
        ) else {
            atom_issue_codes.push("tick_grid_rounding".to_string());
            continue;
        };
        let beat_value = group.beat_in_measure.numerator as f64 / group.beat_in_measure.denominator as f64 + 1.0;
        // TS writes whole numbers as JSON integers (1, not 1.0); mirror the
        // integer form so canonical comparisons see identical numbers.
        let beat = if group.beat_in_measure.numerator % group.beat_in_measure.denominator == 0 {
            Value::from(group.beat_in_measure.numerator / group.beat_in_measure.denominator + 1)
        } else {
            Value::Number(Number::from_f64(beat_value).expect("finite beat display value"))
        };
        atoms.push(json!({
            "startTick": start_tick,
            "durationTicks": std::cmp::max(1, duration_ticks),
            "bar": group.bar,
            "beat": beat,
        }));
    }

    // 11. Per-note scoreEvents with RUST-computed integer µs (parity-candidate
    //     :187): onset = CountInUs + beat_to_microseconds(playbackBeat, bpm)
    //     through the §3.5 exact-addition boundary.
    let bpm = RationalV1 {
        numerator: config.bpm.numerator,
        denominator: config.bpm.denominator,
    };
    let max_us = BigInt::from(MAX_SAFE_INTEGER);
    let mut score_events: Vec<Value> = Vec::new();
    for occurrence in &occurrences {
        let offset_us = beat_to_microseconds(&occurrence.playback_beat, &bpm)?;
        let duration_us = beat_to_microseconds(&occurrence.duration_beat, &bpm)?;
        let onset_us = BigInt::from(config.count_in_us) + BigInt::from(offset_us);
        if onset_us > max_us {
            return Err(err("TIME_OUT_OF_RANGE",
                format!("target onset exceeds safe integers: {config_in_us} + {offset_us}", config_in_us = config.count_in_us)));
        }
        let onset_us = i64::try_from(&onset_us)
            .map_err(|_| err("TIME_OUT_OF_RANGE", "target onset out of range"))?;
        let voice = occurrence.source_voice_id.clone().unwrap_or_else(|| "1".to_string());
        score_events.push(json!({
            "locator": locator_json(occurrence),
            "passIndex": occurrence.pass_index,
            "measure": occurrence.bar,
            "pitch": occurrence.pitch.as_ref().and_then(|pitch| pitch.midi_note).unwrap_or(-1),
            "targetOnsetUs": onset_us,
            "targetDurationUs": duration_us,
            "partId": format!("staff-{}:voice-{}", occurrence.staff_number, voice),
            "parseConfidence": 1,
            "runtimeOccurrenceId": occurrence.occurrence_id,
        }));
    }

    // 12. Assemble the PlannerOutput (§2.3 / a3-gate-fixture plannerOutput).
    let occurrence_values: Vec<Value> = occurrences
        .iter()
        .map(|occurrence| {
            let voice = occurrence.source_voice_id.clone().unwrap_or_else(|| "1".to_string());
            let pitch_json = match &occurrence.pitch {
                // Canonical pitch: midiNote == null projects to null (TS
                // toCanonicalOccurrence :107). Whole-number alters stay JSON
                // integers (TS source numbers serialize without a fraction).
                Some(pitch) if pitch.midi_note.is_some() => {
                    let alter = if pitch.alter.denominator == 1 {
                        Value::from(pitch.alter.numerator)
                    } else {
                        Value::Number(Number::from_f64(
                            pitch.alter.numerator as f64 / pitch.alter.denominator as f64,
                        ).expect("finite alter value"))
                    };
                    json!({
                        "step": pitch.step,
                        "alter": alter,
                        "octave": pitch.octave,
                        "midiNote": pitch.midi_note,
                        "spelling": pitch.spelling,
                    })
                }
                _ => Value::Null,
            };
            json!({
                "occurrenceId": occurrence.occurrence_id,
                "scoreEventId": occurrence.score_event_id,
                "locator": locator_json(occurrence),
                "passIndex": occurrence.pass_index,
                "playbackBeat": beat_text(&occurrence.playback_beat),
                "durationBeat": beat_text(&occurrence.duration_beat),
                "measureOrdinal": occurrence.measure_ordinal,
                "bar": occurrence.bar,
                "beatInMeasure": beat_text(&occurrence.beat_in_measure),
                "staffNumber": occurrence.staff_number,
                "voiceId": voice,
                "pitch": pitch_json,
                "isTieOnset": occurrence.is_tie_onset,
                "playbackIndex": occurrence.playback_index,
            })
        })
        .collect();

    let group_values: Vec<Value> = groups
        .iter()
        .map(|group| {
            let members: Vec<Value> = group
                .member_indices
                .iter()
                .map(|index| locator_json(&occurrences[*index]))
                .collect();
            let mut staff_numbers: Vec<i64> = group
                .member_indices
                .iter()
                .map(|index| occurrences[*index].staff_number)
                .collect();
            staff_numbers.sort_unstable();
            staff_numbers.dedup();
            let mut voice_ids: Vec<String> = group
                .member_indices
                .iter()
                .map(|index| {
                    occurrences[*index]
                        .source_voice_id
                        .clone()
                        .unwrap_or_else(|| "1".to_string())
                })
                .collect();
            voice_ids.sort_by(|a, b| utf16_code_unit_cmp(a, b));
            voice_ids.dedup();
            let pitches: Vec<String> = group
                .member_indices
                .iter()
                .filter_map(|index| occurrences[*index].pitch.as_ref().map(|pitch| pitch.spelling.clone()))
                .collect();
            json!({
                "passIndex": group.pass_index,
                "playbackBeat": beat_text(&group.playback_beat),
                "members": members,
                "pitches": pitches,
                "bar": group.bar,
                "beatInMeasure": beat_text(&group.beat_in_measure),
                "staffNumbers": staff_numbers,
                "voiceIds": voice_ids,
                "durationBeat": beat_text(&group.duration_beat),
                "occurrenceIds": group.member_indices.iter().map(|index| occurrences[*index].occurrence_id.clone()).collect::<Vec<_>>(),
                "scoreEventIds": group.member_indices.iter().map(|index| occurrences[*index].score_event_id.clone()).collect::<Vec<_>>(),
            })
        })
        .collect();

    Ok(json!({
        "scoreFingerprint": score_fingerprint,
        "occurrences": occurrence_values,
        "groups": group_values,
        "atoms": atoms,
        "scoreEvents": score_events,
        "runtimeIds": {
            "planId": plan_id_final,
            "occurrenceIds": occurrences.iter().map(|occurrence| occurrence.occurrence_id.clone()).collect::<Vec<_>>(),
            "groupIds": groups.iter().map(|group| group.group_id.clone()).collect::<Vec<_>>(),
        },
        "planStrictAllowed": !plan_issues.iter().any(|issue| issue.get("blocksStrict").and_then(Value::as_bool).unwrap_or(false)),
        "planIssues": plan_issues,
        "scopeCodes": scope_codes,
        "missingEventIds": missing_event_ids,
        "atomIssueCodes": atom_issue_codes,
    }))
}

/// Semantic locator (partId/measureOrdinal/sourceOrdinal + optional voiceId).
fn locator_json(occurrence: &PlannedOccurrence) -> Value {
    let mut locator = Map::new();
    locator.insert("partId".to_string(), Value::String(occurrence.part_id.clone()));
    locator.insert("measureOrdinal".to_string(), Value::from(occurrence.source_measure_ordinal));
    locator.insert("sourceOrdinal".to_string(), Value::from(occurrence.source_ordinal));
    if let Some(voice_id) = &occurrence.source_voice_id {
        locator.insert("voiceId".to_string(), Value::String(voice_id.clone()));
    }
    Value::Object(locator)
}

/// R2-3c: the PlannerOutput projected onto the frozen ParityCandidate shape
/// the TS `diffCandidates` comparator consumes (parity-diff.ts): occurrences
/// drop the runtime keys (occurrenceId/scoreEventId live in runtimeIds and
/// scoreEvents.runtimeOccurrenceId), groups drop the member id lists (TS
/// CanonicalGroup carries locators only). Returns `{ candidate, meta }` —
/// meta mirrors the TS TsCandidateResult's planner-domain fields so the
/// dual-run harness can assert them without re-deriving.
pub fn build_parity_candidate_v1(
    document_json: &Value,
    report_json: &Value,
    config_json: &Value,
) -> Result<Value, ContractError> {
    let plan = build_plan_v1(document_json, report_json, config_json)?;
    let strip_keys = |value: &Value, keys: &[&str]| {
        let mut object = value.clone();
        if let Some(map) = object.as_object_mut() {
            for key in keys {
                map.remove(*key);
            }
        }
        object
    };
    let candidate = json!({
        "side": "rust-planner",
        "kind": "candidate",
        "occurrences": plan["occurrences"].as_array().expect("occurrences array")
            .iter().map(|occurrence| strip_keys(occurrence, &["occurrenceId", "scoreEventId"])).collect::<Vec<_>>(),
        "groups": plan["groups"].as_array().expect("groups array")
            .iter().map(|group| strip_keys(group, &["occurrenceIds", "scoreEventIds"])).collect::<Vec<_>>(),
        "atoms": plan["atoms"].clone(),
        "scoreEvents": plan["scoreEvents"].clone(),
        "runtimeIds": plan["runtimeIds"].clone(),
    });
    let meta = json!({
        "planStrictAllowed": plan["planStrictAllowed"].clone(),
        "planIssues": plan["planIssues"].clone(),
        "scopeCodes": plan["scopeCodes"].clone(),
        "missingEventIds": plan["missingEventIds"].clone(),
        "atomIssueCodes": plan["atomIssueCodes"].clone(),
    });
    Ok(json!({ "candidate": candidate, "meta": meta }))
}
