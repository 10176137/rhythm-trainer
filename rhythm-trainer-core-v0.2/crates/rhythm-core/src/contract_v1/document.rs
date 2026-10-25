//! R2-3a3: full structural + semantic validation of a ScoreDocumentV1,
//! collected-style (every issue reported, mirroring TS
//! `validateScoreDocumentV1`), over the JSON value domain — the same domain
//! the TS validator works on, so closed-key checks and issue codes map 1:1.
//!
//! Structural constraints that TS delegates to the committed JSON Schema
//! (AJV `schema_violation`) are implemented here with the same code so the
//! Rust validator accepts exactly the frozen schema language.

use serde_json::Value;

use crate::contract_v1::error::ContractError;
use crate::contract_v1::rational::{big_gcd, MAX_SAFE_INTEGER};
use crate::contract_v1::fingerprint::sha256_hex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub code: String,
    pub message: String,
}

fn issue(code: &str, message: impl Into<String>) -> Issue {
    Issue { code: code.to_string(), message: message.into() }
}


/// Schema-tier violation (TS routes these through AJV as schema_violation).
fn schema_violation(message: impl Into<String>) -> Issue {
    issue("schema_violation", message)
}

fn check_integer_bounds(value: Option<&Value>, context: &str, min: i64, max: Option<i64>, issues: &mut Vec<Issue>) {
    // OPTIONAL integer field: ABSENCE is legal; PRESENCE must be an integer
    // meeting the range constraint (never silently skipped).
    match value.and_then(Value::as_i64) {
        None => {
            if value.map(|v| !v.is_null()).unwrap_or(false) {
                issues.push(schema_violation(format!("{context}: must be an integer")));
            }
        }
        Some(v) => {
            if v < min {
                issues.push(schema_violation(format!("{context}: must be >= {min}")));
            } else if let Some(max) = max {
                if v > max {
                    issues.push(schema_violation(format!("{context}: must be <= {max}")));
                }
            }
        }
    }
}

fn check_string_field(value: Option<&Value>, context: &str, min_len: usize, issues: &mut Vec<Issue>) {
    // OPTIONAL string field: ABSENCE is legal; PRESENCE must be a string
    // meeting the length constraint (never silently skipped).
    match value {
        None | Some(Value::Null) => {}
        Some(Value::String(text)) => {
            if text.len() < min_len {
                issues.push(schema_violation(format!("{context}: must be a string of length >= {min_len}")));
            }
        }
        Some(other) => issues.push(schema_violation(format!("{context}: must be a string, got {other}"))),
    }
}

fn check_boolean_field(value: Option<&Value>, context: &str, issues: &mut Vec<Issue>) {
    // OPTIONAL boolean field: absence is legal where the schema marks the
    // field optional; when present, it must be a boolean.
    let Some(actual) = value else { return };
    if !actual.is_boolean() {
        issues.push(schema_violation(format!("{context}: must be a boolean")));
    }
}

fn check_enum(value: Option<&Value>, allowed: &[&str], context: &str, issues: &mut Vec<Issue>) {
    let actual = value.and_then(Value::as_str);
    if !actual.map(|v| allowed.contains(&v)).unwrap_or(false) {
        issues.push(schema_violation(format!(
            "{context}: must be one of {} (got {})",
            allowed.join("|"),
            value.map(|v| v.to_string()).unwrap_or_else(|| "missing".into())
        )));
    }
}

fn check_string_array(value: Option<&Value>, context: &str, issues: &mut Vec<Issue>) {
    match value {
        Some(Value::Array(items)) => {
            for item in items {
                if !item.is_string() {
                    issues.push(schema_violation(format!("{context}: items must be strings")));
                    return;
                }
            }
        }
        _ => issues.push(schema_violation(format!("{context}: must be an array of strings"))),
    }
}

/// Closed-object gate: reports unexpected fields (closed) and missing
/// required fields SEPARATELY — optional fields (in allowed but not in
/// required) must not be upgraded to mandatory. Returns whether the value
/// is an object (callers skip field checks when false).
fn check_object_shape(
    value: &Value,
    allowed: &[&str],
    required: &[&str],
    context: &str,
    issues: &mut Vec<Issue>,
) -> bool {
    if !is_object(value) {
        issues.push(schema_violation(format!("{context} must be an object")));
        return false;
    }
    check_closed_keys(value, allowed, context, issues);
    check_required_keys(value, required, context, issues);
    true
}

pub fn is_object(value: &Value) -> bool {
    value.is_object()
}

fn keys_of(value: &Value) -> Vec<String> {
    value.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default()
}

pub fn check_closed_keys(value: &Value, allowed: &[&str], context: &str, issues: &mut Vec<Issue>) {
    for key in keys_of(value) {
        if !allowed.contains(&key.as_str()) {
            issues.push(issue("unexpected_field", format!("{context}: unexpected field \"{key}\"")));
        }
    }
}

pub fn check_required_keys(value: &Value, required: &[&str], context: &str, issues: &mut Vec<Issue>) {
    for key in required {
        if value.get(key).is_none() {
            issues.push(issue("missing_field", format!("{context}: missing field \"{key}\"")));
        }
    }
}

fn is_canonical_rational(value: &Value) -> bool {
    let Some(map) = value.as_object() else { return false };
    if map.len() != 2 { return false; }
    let Some(numerator) = map.get("numerator").and_then(Value::as_i64) else { return false };
    let Some(denominator) = map.get("denominator").and_then(Value::as_i64) else { return false };
    if denominator <= 0 { return false; }
    if numerator > MAX_SAFE_INTEGER || numerator < -MAX_SAFE_INTEGER { return false; }
    if denominator > MAX_SAFE_INTEGER { return false; }
    if numerator == 0 { return denominator == 1; }
    big_gcd_from_i64(numerator, denominator) == 1
}

fn big_gcd_from_i64(a: i64, b: i64) -> i64 {
    // gcd <= |a|, so the cast back is lossless.
    let (mut a, mut b) = (a.unsigned_abs(), b.unsigned_abs());
    while b != 0 {
        let r = a % b;
        a = b;
        b = r;
    }
    a as i64
}

fn check_rational(value: &Value, context: &str, issues: &mut Vec<Issue>) {
    if !is_canonical_rational(value) {
        issues.push(issue("invalid_rational", format!("{context}: not a reduced RationalV1")));
    }
}

fn check_positive_integer(value: &Value, context: &str, min: i64, issues: &mut Vec<Issue>) {
    let ok = value.as_i64().map(|v| v >= min).unwrap_or(false);
    if !ok {
        issues.push(issue("invalid_integer", format!("{context}: must be an integer >= {min}")));
    }
}

fn is_string_non_empty(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false)
}

pub const CAPABILITY_ENUM: [&str; 15] = [
    "chords", "cue", "grace", "microtone", "multi_staff", "multi_voice", "multiple_parts",
    "repeat", "tempo_curve", "ties", "transpose", "tuplets", "unsupported_clef",
    "unsupported_transpose", "unrepresentable_pitch",
];

/// `score-revision-v1:sha256:<hex>` over JCS({normalizerVersion,
/// sourceFingerprint}) where sourceFingerprint INCLUDES the `sha256:` prefix
/// (TS computeScoreRevisionId :166).
pub fn compute_score_revision_id(source_fingerprint_prefixed: &str, normalizer_version: &str) -> String {
    let mut object = serde_json::Map::new();
    object.insert("normalizerVersion".to_string(), Value::String(normalizer_version.to_string()));
    object.insert("sourceFingerprint".to_string(), Value::String(source_fingerprint_prefixed.to_string()));
    let payload = serde_json::to_string(&Value::Object(object)).expect("map serializes");
    format!("score-revision-v1:sha256:{}", sha256_hex(payload.as_bytes()))
}

/// Full validation. An empty list = the document satisfies the frozen V1.
pub fn validate_score_document_v1(dto: &Value) -> Vec<Issue> {
    let mut issues = Vec::new();
    if !is_object(dto) {
        return vec![issue("invalid_document", "not an object")];
    }
    if dto.get("schemaVersion").and_then(Value::as_i64) != Some(1) {
        return vec![issue(
            "unknown_schema_version",
            format!("schemaVersion must be 1, got {}", dto.get("schemaVersion").map(|v| v.to_string()).unwrap_or_default()),
        )];
    }
    const ROOT_ALLOWED: [&str; 10] = ["schemaVersion", "normalizerVersion", "supportProfileVersion",
        "scoreRevisionId", "source", "metadata", "parts", "tieSpans", "tempoMarks", "capabilities"];
    const ROOT_REQUIRED: [&str; 10] = ROOT_ALLOWED;
    check_closed_keys(dto, &ROOT_ALLOWED, "root", &mut issues);
    check_required_keys(dto, &ROOT_ALLOWED, "root", &mut issues);
    for key in ["normalizerVersion", "supportProfileVersion"] {
        if !is_string_non_empty(dto.get(key)) {
            issues.push(issue("missing_field", format!("{key} must be a non-empty string")));
        }
    }
    let revision_ok = dto.get("scoreRevisionId")
        .and_then(Value::as_str)
        .and_then(|s| s.strip_prefix("score-revision-v1:sha256:"))
        .map(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
        .unwrap_or(false);
    if !revision_ok {
        issues.push(issue("invalid_revision_id", "scoreRevisionId does not match the frozen pattern"));
    }
    if let Some(source) = dto.get("source") {
        if !is_object(source) {
            issues.push(issue("invalid_source", "source must be an object"));
        } else {
            check_closed_keys(source, &["format", "sourceFingerprint"], "source", &mut issues);
            if source.get("format").and_then(Value::as_str) != Some("musicxml-partwise") {
                issues.push(issue("invalid_source", "source.format must be musicxml-partwise"));
            }
            let fingerprint_ok = source.get("sourceFingerprint")
                .and_then(Value::as_str)
                .map(|s| s.strip_prefix("sha256:").map(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())).unwrap_or(false))
                .unwrap_or(false);
            if !fingerprint_ok {
                issues.push(issue("invalid_source", "sourceFingerprint must be sha256:<64 hex>"));
            }
        }
    } else {
        issues.push(issue("invalid_source", "source must be an object"));
    }
    if let Some(metadata) = dto.get("metadata") {
        if !is_object(metadata) {
            issues.push(issue("invalid_metadata", "metadata must be an object"));
        } else {
            check_closed_keys(metadata, &["workTitle", "composer"], "metadata", &mut issues);
            let title_ok = metadata.get("workTitle").map(Value::is_string).unwrap_or(false);
            let composer_ok = metadata.get("composer").map(Value::is_string).unwrap_or(false);
            if !title_ok || !composer_ok {
                issues.push(issue("invalid_metadata", "metadata.workTitle/composer must be strings"));
            }
        }
    } else {
        issues.push(issue("invalid_metadata", "metadata must be an object"));
    }
    match dto.get("capabilities") {
        Some(Value::Array(capabilities)) => {
            let mut seen = std::collections::HashSet::new();
            for capability in capabilities {
                let name = capability.as_str();
                let ok = name.map(|c| CAPABILITY_ENUM.contains(&c)).unwrap_or(false);
                if !ok {
                    issues.push(issue("unknown_capability",
                        format!("capability not in frozen enum: {}", capability)));
                }
                if !seen.insert(capability.to_string()) {
                    issues.push(schema_violation("capabilities: items must be unique"));
                }
            }
        }
        _ => issues.push(issue("invalid_capabilities", "capabilities must be an array")),
    }

    let mut part_ids = std::collections::HashSet::new();
    let mut event_ids = std::collections::HashSet::new();
    let mut xml_ids = std::collections::HashSet::new();
    let mut locator_keys = std::collections::HashSet::new();
    let parts = match dto.get("parts") {
        Some(Value::Array(parts)) => parts.clone(),
        _ => {
            issues.push(issue("invalid_parts", "parts must be an array"));
            Vec::new()
        }
    };
    for part in &parts {
        if !is_object(part) {
            issues.push(issue("invalid_part", "part must be an object"));
            continue;
        }
        check_closed_keys(part, &["partId", "name", "staves", "measures"], "part", &mut issues);
        let part_id = part.get("partId").and_then(Value::as_str).unwrap_or_default();
        if part_id.is_empty() {
            issues.push(issue("invalid_part", "partId must be a non-empty string"));
        } else if !part_ids.insert(part_id.to_string()) {
            issues.push(issue("duplicate_part_id", format!("partId duplicated: {part_id}")));
        }
        check_string_field(part.get("name"), "part.name", 0, &mut issues);
        check_positive_integer(&part["staves"], "part.staves", 1, &mut issues);
        let measures = match part.get("measures") {
            Some(Value::Array(measures)) => measures.clone(),
            _ => {
                issues.push(issue("invalid_measures", format!("part {part_id}: measures must be an array")));
                continue;
            }
        };
        let mut previous_ordinal: i64 = 0;
        let mut ordinals = std::collections::HashSet::new();
        for measure in &measures {
            if !is_object(measure) {
                issues.push(issue("invalid_measure", "measure must be an object"));
                continue;
            }
            check_closed_keys(measure, &["ordinal", "printedNumber", "implicit", "startBeat", "durationBeat",
                "attributes", "events", "barlines", "capabilities"], "measure", &mut issues);
            check_required_keys(measure, &["ordinal", "implicit", "startBeat", "durationBeat", "attributes", "events", "barlines", "capabilities"], "measure", &mut issues);
            let ordinal = measure.get("ordinal").and_then(Value::as_i64);
            match ordinal {
                None => issues.push(issue("invalid_ordinal", "measure.ordinal must be a positive integer")),
                Some(o) if o < 1 => issues.push(issue("invalid_ordinal", "measure.ordinal must be a positive integer")),
                Some(o) => {
                    if !ordinals.insert(o) {
                        issues.push(issue("duplicate_ordinal", format!("measure ordinal duplicated: {o}")));
                    }
                    if o != previous_ordinal + 1 {
                        issues.push(issue("non_consecutive_ordinal",
                            format!("measure ordinals must be consecutive from 1; got {o} after {previous_ordinal}")));
                    }
                    previous_ordinal = o;
                }
            }
            if !measure.get("implicit").map(Value::is_boolean).unwrap_or(false) {
                issues.push(issue("invalid_implicit", "measure.implicit must be boolean"));
            }

            // MeasureAttributesV1 (frozen schema: all five fields required, closed).
            if let Some(attributes) = measure.get("attributes") {
                const ATTR_ALLOWED: [&str; 5] = ["divisions", "time", "key", "staves", "clefs"];
                if check_object_shape(attributes, &ATTR_ALLOWED, &ATTR_ALLOWED, "measure.attributes", &mut issues) {
                    check_integer_bounds(attributes.get("divisions"), "measure.attributes.divisions", 1, None, &mut issues);
                    if let Some(time) = attributes.get("time") {
                        const TIME_ALLOWED: [&str; 2] = ["beats", "beatType"];
                        if check_object_shape(time, &TIME_ALLOWED, &TIME_ALLOWED, "measure.attributes.time", &mut issues) {
                            check_integer_bounds(time.get("beats"), "measure.attributes.time.beats", 1, None, &mut issues);
                            check_integer_bounds(time.get("beatType"), "measure.attributes.time.beatType", 1, None, &mut issues);
                        }
                    }
                    if let Some(key) = attributes.get("key") {
                        const KEY_ALLOWED: [&str; 2] = ["fifths", "mode"];
                        if check_object_shape(key, &KEY_ALLOWED, &KEY_ALLOWED, "measure.attributes.key", &mut issues) {
                            check_integer_bounds(key.get("fifths"), "measure.attributes.key.fifths", -7, Some(7), &mut issues);
                            check_string_field(key.get("mode"), "measure.attributes.key.mode", 0, &mut issues);
                        }
                    }
                    check_integer_bounds(attributes.get("staves"), "measure.attributes.staves", 1, None, &mut issues);
                    match attributes.get("clefs") {
                        Some(Value::Array(clefs)) => {
                            for clef in clefs {
                                const CLEF_ALLOWED: [&str; 3] = ["staffNumber", "sign", "line"];
                                if check_object_shape(clef, &CLEF_ALLOWED, &CLEF_ALLOWED, "measure.attributes.clefs[]", &mut issues) {
                                    check_integer_bounds(clef.get("staffNumber"), "measure.attributes.clefs[].staffNumber", 1, None, &mut issues);
                                    check_string_field(clef.get("sign"), "measure.attributes.clefs[].sign", 1, &mut issues);
                                    check_integer_bounds(clef.get("line"), "measure.attributes.clefs[].line", 1, None, &mut issues);
                                }
                            }
                        }
                        _ => issues.push(schema_violation("measure.attributes.clefs must be an array")),
                    }
                }
            } else {
                issues.push(issue("missing_field", "measure.attributes is required (frozen schema)"));
            }
            check_rational(measure.get("startBeat").unwrap_or(&Value::Null), "measure.startBeat", &mut issues);
            check_rational(measure.get("durationBeat").unwrap_or(&Value::Null), "measure.durationBeat", &mut issues);
            match measure.get("events") {
                Some(Value::Array(events)) => {
                    for event in events {
                        validate_event(event, &mut issues, part_id, &mut event_ids, &mut xml_ids, &mut locator_keys);
                        // The event's source must point back INTO its parent measure.
                        let measure_ordinal = measure.get("ordinal").and_then(Value::as_i64);
                        let source_ordinal = event.get("source")
                            .and_then(|source| source.get("measureOrdinal"))
                            .and_then(Value::as_i64);
                        if let (Some(expected), Some(actual)) = (measure_ordinal, source_ordinal) {
                            if expected != actual {
                                issues.push(issue("source_measure_mismatch", format!(
                                    "event {} in measure {expected} claims source measure {actual}",
                                    event.get("eventId").map(|v| v.to_string()).unwrap_or_default(),
                                )));
                            }
                        }
                    }
                }
                _ => issues.push(issue("invalid_events", "measure.events must be an array")),
            }
            match measure.get("barlines") {
                Some(Value::Array(barlines)) => {
                    for barline in barlines {
                        const BARLINE_ALLOWED: [&str; 4] = ["location", "barStyle", "repeat", "ending"];
                        const BARLINE_REQUIRED: [&str; 0] = [];
                        if check_object_shape(barline, &BARLINE_ALLOWED, &BARLINE_REQUIRED, "measure.barlines[]", &mut issues) {
                            check_string_field(barline.get("location"), "measure.barlines[].location", 0, &mut issues);
                            check_string_field(barline.get("barStyle"), "measure.barlines[].barStyle", 0, &mut issues);
                            if let Some(repeat) = barline.get("repeat") {
                                const REPEAT_ALLOWED: [&str; 3] = ["direction", "times", "afterJump"];
                                const REPEAT_REQUIRED: [&str; 1] = ["direction"];
                                if check_object_shape(repeat, &REPEAT_ALLOWED, &REPEAT_REQUIRED, "measure.barlines[].repeat", &mut issues) {
                                    check_enum(repeat.get("direction"), &["forward", "backward"],
                                        "measure.barlines[].repeat.direction", &mut issues);
                                    check_integer_bounds(repeat.get("times"), "measure.barlines[].repeat.times", 1, None, &mut issues);
                                    check_boolean_field(repeat.get("afterJump"), "measure.barlines[].repeat.afterJump", &mut issues);
                                }
                            }
                            if let Some(ending) = barline.get("ending") {
                                const ENDING_ALLOWED: [&str; 2] = ["number", "type"];
                                const ENDING_REQUIRED: [&str; 1] = ["type"];
                                if check_object_shape(ending, &ENDING_ALLOWED, &ENDING_REQUIRED, "measure.barlines[].ending", &mut issues) {
                                    check_string_field(ending.get("number"), "measure.barlines[].ending.number", 0, &mut issues);
                                    check_enum(ending.get("type"), &["start", "stop", "discontinue"],
                                        "measure.barlines[].ending.type", &mut issues);
                                }
                            }
                        }
                    }
                }
                _ => issues.push(issue("invalid_barlines", "measure.barlines must be an array")),
            }
            match measure.get("capabilities") {
                Some(Value::Array(capabilities)) => {
                    let mut seen = std::collections::HashSet::new();
                    for capability in capabilities {
                        let name = capability.as_str();
                        if name != Some("chords") && name != Some("tuplets") {
                            issues.push(issue("unknown_capability",
                                format!("measure capability not in enum: {capability}")));
                        }
                        if !seen.insert(capability.to_string()) {
                            issues.push(schema_violation("measure capabilities: items must be unique"));
                        }
                    }
                }
                _ => issues.push(issue("invalid_capabilities", "measure.capabilities must be an array")),
            }
        }
    }

    match dto.get("tieSpans") {
        Some(Value::Array(tie_spans)) => {
            let mut tie_span_ids = std::collections::HashSet::new();
            for span in tie_spans {
                if !is_object(span) {
                    issues.push(issue("invalid_tie_span", "tieSpan must be an object"));
                    continue;
                }
                check_closed_keys(span, &["id", "pitchKey", "eventIds", "startBeat", "endBeat"], "tieSpan", &mut issues);
                if let Some(id) = span.get("id").and_then(Value::as_str) {
                    if !tie_span_ids.insert(id.to_string()) {
                        issues.push(issue("duplicate_tie_span_id", format!("tieSpan id duplicated: {id}")));
                    }
                }
                match span.get("eventIds") {
                    Some(Value::Array(span_member_ids)) if span_member_ids.len() >= 2 => {
                        for span_member in span_member_ids {
                            if let Some(id) = span_member.as_str() {
                                if !event_ids.contains(id) {
                                    issues.push(issue("dangling_reference",
                                        format!("tieSpan references unknown eventId: {id}")));
                                }
                            }
                        }
                    }
                    _ => issues.push(issue("invalid_tie_span", "tieSpan.eventIds must list at least 2 events")),
                }
                check_rational(span.get("startBeat").unwrap_or(&Value::Null), "tieSpan.startBeat", &mut issues);
                check_rational(span.get("endBeat").unwrap_or(&Value::Null), "tieSpan.endBeat", &mut issues);
            }
        }
        _ => issues.push(issue("invalid_tie_spans", "tieSpans must be an array")),
    }
    // Bidirectional tie consistency.
    let tie_spans_list = dto.get("tieSpans").and_then(Value::as_array).cloned().unwrap_or_default();
    for part in &parts {
        let Some(measures) = part.get("measures").and_then(Value::as_array) else { continue };
        for measure in measures {
            let Some(events) = measure.get("events").and_then(Value::as_array) else { continue };
            for event in events {
                let Some(tie_span_id) = event.get("tieSpanId").and_then(Value::as_str) else { continue };
                let Some(event_id) = event.get("eventId").and_then(Value::as_str) else { continue };
                let Some(span) = tie_spans_list.iter().find(|span| span.get("id").and_then(Value::as_str) == Some(tie_span_id)) else {
                    issues.push(issue("dangling_reference",
                        format!("event {event_id} references unknown tieSpanId {tie_span_id}")));
                    continue;
                };
                let member_ids = span.get("eventIds").and_then(Value::as_array).cloned().unwrap_or_default();
                let member = member_ids.iter().any(|v| v.as_str() == Some(event_id));
                if !member {
                    issues.push(issue("tie_reference_mismatch",
                        format!("event {event_id} claims tieSpanId {tie_span_id} but is not in its eventIds")));
                }
            }
        }
    }
    for span in &tie_spans_list {
        let Some(event_ids) = span.get("eventIds").and_then(Value::as_array) else { continue };
        let Some(span_id) = span.get("id").and_then(Value::as_str) else { continue };
        for event_id in event_ids {
            let Some(event_id) = event_id.as_str() else { continue };
            if let Some(owner) = find_event_tie_span_id(dto, event_id) {
                if owner != span_id {
                    issues.push(issue("tie_reference_mismatch",
                        format!("tieSpan {span_id} lists {event_id} but that event claims tieSpanId {owner}")));
                }
            }
        }
    }

    match dto.get("tempoMarks") {
        Some(Value::Array(tempo_marks)) => {
            for mark in tempo_marks {
                if !is_object(mark) {
                    issues.push(issue("invalid_tempo_mark", "tempoMark must be an object"));
                    continue;
                }
                check_closed_keys(mark, &["measureOrdinal", "beat", "bpm", "kind"], "tempoMark", &mut issues);
                check_integer_bounds(mark.get("measureOrdinal"), "tempoMark.measureOrdinal", 1, None, &mut issues);
                check_rational(mark.get("beat").unwrap_or(&Value::Null), "tempoMark.beat", &mut issues);
                check_rational(mark.get("bpm").unwrap_or(&Value::Null), "tempoMark.bpm", &mut issues);
                if mark.get("kind").and_then(Value::as_str) != Some("metronome")
                    && mark.get("kind").and_then(Value::as_str) != Some("sound") {
                    issues.push(issue("invalid_tempo_mark", "tempoMark.kind must be metronome|sound"));
                }
            }
        }
        _ => issues.push(issue("invalid_tempo_marks", "tempoMarks must be an array")),
    }

    // The revision id must equal the frozen formula over the document's own
    // sourceFingerprint + normalizerVersion.
    if let (Some(revision), Some(source_fingerprint), Some(normalizer_version)) = (
        dto.get("scoreRevisionId").and_then(Value::as_str),
        dto.get("source").and_then(|source| source.get("sourceFingerprint")).and_then(Value::as_str),
        dto.get("normalizerVersion").and_then(Value::as_str),
    ) {
        let expected = compute_score_revision_id(source_fingerprint, normalizer_version);
        if revision != expected {
            issues.push(issue("revision_id_mismatch",
                format!("scoreRevisionId does not match sha256(JCS({{sourceFingerprint, normalizerVersion}})): expected {expected}")));
        }
    }
    issues
}


#[allow(clippy::too_many_arguments)]
fn validate_event(
    event: &Value,
    issues: &mut Vec<Issue>,
    part_id: &str,
    event_ids: &mut std::collections::HashSet<String>,
    xml_ids: &mut std::collections::HashSet<String>,
    locator_keys: &mut std::collections::HashSet<String>,
) {
    if !is_object(event) {
        issues.push(issue("invalid_event", "event must be an object"));
        return;
    }
    check_closed_keys(event, &["eventId", "kind", "source", "onsetBeat", "durationBeat", "notatedType", "dots",
        "pitch", "chordGroupId", "tieStart", "tieStop", "tiedStart", "tiedStop", "tieSpanId", "isGrace", "isCue",
        "lyricText", "articulations", "timeModification"], "event", issues);
    check_required_keys(event, &["eventId", "kind", "source", "onsetBeat", "durationBeat", "dots", "tieStart", "tieStop", "tiedStart", "tiedStop", "isGrace", "isCue", "articulations"], "event", issues);
    let event_id = event.get("eventId").and_then(Value::as_str);
    match event_id {
        None => issues.push(issue("invalid_event", "eventId must be a non-empty string")),
        Some(id) if id.is_empty() => issues.push(issue("invalid_event", "eventId must be a non-empty string")),
        Some(id) => {
            if !event_ids.insert(id.to_string()) {
                issues.push(issue("duplicate_event_id", format!("eventId duplicated: {id}")));
            }
        }
    }
    let kind = event.get("kind").and_then(Value::as_str);
    if kind != Some("note") && kind != Some("rest") {
        issues.push(issue("invalid_event", "kind must be note|rest"));
    }
    if kind == Some("note") && !is_object(event.get("pitch").unwrap_or(&Value::Null)) {
        issues.push(issue("invalid_event", "kind=note must carry pitch"));
    }
    if kind == Some("rest") && event.get("pitch").is_some() {
        issues.push(issue("invalid_event", "kind=rest must not carry pitch"));
    }
    check_rational(event.get("onsetBeat").unwrap_or(&Value::Null), "event.onsetBeat", issues);
    check_rational(event.get("durationBeat").unwrap_or(&Value::Null), "event.durationBeat", issues);
    let is_grace = event.get("isGrace").and_then(Value::as_bool) == Some(true);
    if is_canonical_rational(event.get("durationBeat").unwrap_or(&Value::Null)) {
        let numerator = event.get("durationBeat")
            .and_then(|duration| duration.get("numerator"))
            .and_then(Value::as_i64);
        if let Some(numerator) = numerator {
            if !is_grace && numerator <= 0 {
                issues.push(issue("invalid_event", "non-grace event duration must be positive"));
            }
            if is_grace && numerator < 0 {
                issues.push(issue("invalid_event", "grace duration must be non-negative"));
            }
        }
    }
    match event.get("source") {
        Some(source) if is_object(source) => {
            check_closed_keys(source, &["partId", "measureOrdinal", "staffNumber", "sourceOrdinal",
                "printedMeasureNumber", "voiceId", "xmlId"], "event.source", issues);
            let source_part = source.get("partId").and_then(Value::as_str).unwrap_or_default();
            if source_part != part_id {
                issues.push(issue("invalid_event", "event.source.partId does not match its part"));
            }
            check_positive_integer(&source["measureOrdinal"], "event.source.measureOrdinal", 1, issues);
            check_positive_integer(&source["staffNumber"], "event.source.staffNumber", 1, issues);
            check_positive_integer(&source["sourceOrdinal"], "event.source.sourceOrdinal", 1, issues);
            let measure = source.get("measureOrdinal").and_then(Value::as_i64);
            let ordinal = source.get("sourceOrdinal").and_then(Value::as_i64);
            if let (Some(measure), Some(ordinal)) = (measure, ordinal) {
                let key = format!("{source_part}:{measure}:{ordinal}");
                if !locator_keys.insert(key.clone()) {
                    issues.push(issue("duplicate_source_locator",
                        format!("source locator claimed by two events: {key}")));
                }
            }
            if let Some(xml_id) = source.get("xmlId") {
                match xml_id.as_str() {
                    None => issues.push(issue("invalid_event", "xmlId must be a non-empty string")),
                    Some(id) if id.is_empty() => issues.push(issue("invalid_event", "xmlId must be a non-empty string")),
                    Some(id) => {
                        if !xml_ids.insert(id.to_string()) {
                            issues.push(issue("duplicate_xml_id", format!("note@id duplicated: {id}")));
                        }
                    }
                }
            }
        }
        _ => issues.push(issue("invalid_event", "event.source must be an object")),
    }
}

fn find_event_tie_span_id(dto: &Value, event_id: &str) -> Option<String> {
    for part in dto.get("parts").and_then(Value::as_array)? {
        for measure in part.get("measures").and_then(Value::as_array)? {
            for event in measure.get("events").and_then(Value::as_array)? {
                if event.get("eventId").and_then(Value::as_str) == Some(event_id) {
                    return event.get("tieSpanId").and_then(Value::as_str).map(String::from);
                }
            }
        }
    }
    None
}

/// Gate-level aggregation: `DOCUMENT_VALIDATION_FAILED` with every issue.
pub fn require_valid_document(dto: &Value) -> Result<(), ContractError> {
    let issues = validate_score_document_v1(dto);
    if issues.is_empty() {
        Ok(())
    } else {
        Err(ContractError::new(
            "DOCUMENT_VALIDATION_FAILED",
            format!(
                "ScoreDocumentV1 failed validation: {} ({})",
                issues.iter().map(|i| i.code.as_str()).collect::<Vec<_>>().join(", "),
                issues[0].message,
            ),
        ))
    }
}
