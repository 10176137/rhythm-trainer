//! R2-3a3: full structural + semantic validation of a ScoreDocumentV1,
//! collected-style (every issue reported, mirroring TS
//! `validateScoreDocumentV1`), over the JSON value domain — the same domain
//! the TS validator works on, so closed-key checks and issue codes map 1:1.
//!
//! Field checks follow a two-tier discipline aligned with the frozen
//! score-document-v1.schema.json:
//!   - REQUIRED fields: absence, null, wrong type and out-of-range values
//!     are all violations (tier code per the TS mapping: structural gaps the
//!     TS routes through AJV are `schema_violation`; semantic gaps keep
//!     their frozen codes);
//!   - OPTIONAL fields: absence is legal, but PRESENCE must satisfy the
//!     schema type/range (`schema_violation`). `null` for an optional
//!     non-nullable field is a violation — `None` and `Some(Null)` are NOT
//!     the same legal state.

use serde_json::Value;

use crate::contract_v1::error::ContractError;
use crate::contract_v1::fingerprint::sha256_hex;
use crate::contract_v1::rational::MAX_SAFE_INTEGER;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub code: String,
    pub message: String,
}

fn issue(code: &str, message: impl Into<String>) -> Issue {
    Issue { code: code.to_string(), message: message.into() }
}

fn schema_violation(message: impl Into<String>) -> Issue {
    issue("schema_violation", message)
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
    if denominator < 1 { return false; }
    if numerator > MAX_SAFE_INTEGER || numerator < -MAX_SAFE_INTEGER { return false; }
    if denominator > MAX_SAFE_INTEGER { return false; }
    if numerator == 0 { return denominator == 1; }
    gcd(numerator.unsigned_abs(), denominator.unsigned_abs()) == 1
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let r = a % b;
        a = b;
        b = r;
    }
    a
}

fn check_rational(value: &Value, context: &str, issues: &mut Vec<Issue>) {
    // REQUIRED rational: absence/null/wrong shape all violate (TS checkRational).
    if !is_canonical_rational(value) {
        issues.push(issue("invalid_rational", format!("{context}: not a reduced RationalV1")));
    }
}

// ---------------------------------------------------------------------------
// Required-field helpers (absence/null = missing; presence must validate).
// ---------------------------------------------------------------------------

fn req_string(value: Option<&Value>, context: &str, min_len: usize, issues: &mut Vec<Issue>) {
    match value {
        None => issues.push(issue("missing_field", format!("{context}: missing field"))),
        Some(Value::String(text)) => {
            if text.len() < min_len {
                issues.push(schema_violation(format!("{context}: must be a string of length >= {min_len}")));
            }
        }
        Some(other) => issues.push(schema_violation(format!("{context}: must be a string, got {other}"))),
    }
}

fn req_integer(value: Option<&Value>, context: &str, min: i64, max: Option<i64>, issues: &mut Vec<Issue>) {
    match value.and_then(Value::as_i64) {
        None => issues.push(schema_violation(format!("{context}: must be an integer"))),
        Some(v) => check_range(v, context, min, max, issues),
    }
}

fn req_boolean(value: Option<&Value>, context: &str, issues: &mut Vec<Issue>) {
    if !value.map(Value::is_boolean).unwrap_or(false) {
        issues.push(schema_violation(format!("{context}: must be a boolean")));
    }
}

// ---------------------------------------------------------------------------
// Optional-field helpers (absence legal; null/wrong type/range violate).
// ---------------------------------------------------------------------------

fn opt_string(value: Option<&Value>, context: &str, min_len: usize, issues: &mut Vec<Issue>) {
    match value {
        None => {}
        Some(Value::Null) => issues.push(schema_violation(format!(
            "{context}: must be a string when present, got null"
        ))),
        Some(Value::String(text)) => {
            if text.len() < min_len {
                issues.push(schema_violation(format!(
                    "{context}: must be a string of length >= {min_len}"
                )));
            }
        }
        Some(other) => issues.push(schema_violation(format!("{context}: must be a string, got {other}"))),
    }
}

fn opt_integer(value: Option<&Value>, context: &str, min: i64, max: Option<i64>, issues: &mut Vec<Issue>) {
    match value {
        None => {}
        Some(Value::Null) => issues.push(schema_violation(format!(
            "{context}: must be an integer when present, got null"
        ))),
        Some(Value::Number(v)) => check_range(v.as_i64().unwrap_or(-1), context, min, max, issues),
        Some(other) => issues.push(schema_violation(format!("{context}: must be an integer, got {other}"))),
    }
}

fn opt_boolean(value: Option<&Value>, context: &str, issues: &mut Vec<Issue>) {
    match value {
        None => {}
        Some(Value::Null) => issues.push(schema_violation(format!(
            "{context}: must be a boolean when present, got null"
        ))),
        Some(v) if v.is_boolean() => {}
        Some(other) => issues.push(schema_violation(format!("{context}: must be a boolean, got {other}"))),
    }
}

fn check_range(v: i64, context: &str, min: i64, max: Option<i64>, issues: &mut Vec<Issue>) {
    if v < min {
        issues.push(schema_violation(format!("{context}: must be >= {min}")));
    } else if let Some(max) = max {
        if v > max {
            issues.push(schema_violation(format!("{context}: must be <= {max}")));
        }
    }
}

fn check_string_field(value: Option<&Value>, context: &str, min_len: usize, issues: &mut Vec<Issue>) {
    req_string(value, context, min_len, issues)
}

fn check_positive_integer(value: Option<&Value>, context: &str, min: i64, issues: &mut Vec<Issue>) {
    req_integer(value, context, min, None, issues)
}

/// Closed-object gate with SEPARATE allowed vs required lists: optional
/// fields (allowed but not required) must not be upgraded to mandatory.
/// Returns whether the value is an object.
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

pub(crate) fn is_64_lower_hex(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
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
    if !check_object_shape(dto, &ROOT_ALLOWED, &ROOT_REQUIRED, "root", &mut issues) {
        return issues;
    }
    for key in ["normalizerVersion", "supportProfileVersion"] {
        req_string(dto.get(key), key, 1, &mut issues);
    }
    match dto.get("scoreRevisionId").and_then(Value::as_str) {
        None => issues.push(issue("missing_field", "scoreRevisionId: missing field")),
        Some(text) if !text.starts_with("score-revision-v1:sha256:")
            || !is_64_lower_hex(&text["score-revision-v1:sha256:".len()..]) => {
            issues.push(issue("invalid_revision_id", "scoreRevisionId does not match the frozen pattern"));
        }
        Some(_) => {}
    }
    if let Some(source) = dto.get("source") {
        const SOURCE_ALLOWED: [&str; 2] = ["format", "sourceFingerprint"];
        const SOURCE_REQUIRED: [&str; 2] = SOURCE_ALLOWED;
        if check_object_shape(source, &SOURCE_ALLOWED, &SOURCE_REQUIRED, "source", &mut issues) {
            if source.get("format").and_then(Value::as_str) != Some("musicxml-partwise") {
                issues.push(issue("invalid_source", "source.format must be musicxml-partwise"));
            }
            match source.get("sourceFingerprint").and_then(Value::as_str) {
                None => issues.push(issue("missing_field", "source.sourceFingerprint: missing field")),
                Some(text) if !text.starts_with("sha256:")
                    || !is_64_lower_hex(&text["sha256:".len()..]) => {
                    issues.push(issue("invalid_source", "sourceFingerprint must be sha256:<64 hex>"));
                }
                Some(_) => {}
            }
        }
    }
    if let Some(metadata) = dto.get("metadata") {
        const METADATA_ALLOWED: [&str; 2] = ["workTitle", "composer"];
        const METADATA_REQUIRED: [&str; 2] = METADATA_ALLOWED;
        if check_object_shape(metadata, &METADATA_ALLOWED, &METADATA_REQUIRED, "metadata", &mut issues) {
            req_string(metadata.get("workTitle"), "metadata.workTitle", 0, &mut issues);
            req_string(metadata.get("composer"), "metadata.composer", 0, &mut issues);
        }
    }
    match dto.get("capabilities") {
        Some(Value::Array(capabilities)) => {
            let mut seen = std::collections::HashSet::new();
            for capability in capabilities {
                let name = capability.as_str();
                let known = name.map(|c| CAPABILITY_ENUM.contains(&c)).unwrap_or(false);
                if !known {
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
        const PART_ALLOWED: [&str; 4] = ["partId", "name", "staves", "measures"];
        const PART_REQUIRED: [&str; 4] = PART_ALLOWED;
        if !check_object_shape(part, &PART_ALLOWED, &PART_REQUIRED, "part", &mut issues) {
            continue;
        }
        let part_id = part.get("partId").and_then(Value::as_str).unwrap_or_default();
        if part_id.is_empty() {
            issues.push(issue("invalid_part", "partId must be a non-empty string"));
        } else if !part_ids.insert(part_id.to_string()) {
            issues.push(issue("duplicate_part_id", format!("partId duplicated: {part_id}")));
        }
        // PartV1.name is REQUIRED (string, any length).
        req_string(part.get("name"), "part.name", 0, &mut issues);
        req_integer(part.get("staves"), "part.staves", 1, None, &mut issues);
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
            const MEASURE_ALLOWED: [&str; 9] = ["ordinal", "printedNumber", "implicit", "startBeat",
                "durationBeat", "attributes", "events", "barlines", "capabilities"];
            const MEASURE_REQUIRED: [&str; 8] = ["ordinal", "implicit", "startBeat", "durationBeat",
                "attributes", "events", "barlines", "capabilities"];
            if !check_object_shape(measure, &MEASURE_ALLOWED, &MEASURE_REQUIRED, "measure", &mut issues) {
                continue;
            }
            let ordinal = measure.get("ordinal").and_then(Value::as_i64);
            match ordinal {
                None => issues.push(schema_violation("measure.ordinal must be an integer")),
                Some(o) if o < 1 => issues.push(schema_violation("measure.ordinal must be >= 1")),
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
            req_boolean(measure.get("implicit"), "measure.implicit", &mut issues);
            check_rational(measure.get("startBeat").unwrap_or(&Value::Null), "measure.startBeat", &mut issues);
            check_rational(measure.get("durationBeat").unwrap_or(&Value::Null), "measure.durationBeat", &mut issues);
            opt_string(measure.get("printedNumber"), "measure.printedNumber", 0, &mut issues);

            // MeasureAttributesV1 (all five fields required, closed).
            if let Some(attributes) = measure.get("attributes") {
                const ATTR_ALLOWED: [&str; 5] = ["divisions", "time", "key", "staves", "clefs"];
                if check_object_shape(attributes, &ATTR_ALLOWED, &ATTR_ALLOWED, "measure.attributes", &mut issues) {
                    req_integer(attributes.get("divisions"), "measure.attributes.divisions", 1, None, &mut issues);
                    if let Some(time) = attributes.get("time") {
                        const TIME_ALLOWED: [&str; 2] = ["beats", "beatType"];
                        if check_object_shape(time, &TIME_ALLOWED, &TIME_ALLOWED, "measure.attributes.time", &mut issues) {
                            req_integer(time.get("beats"), "measure.attributes.time.beats", 1, None, &mut issues);
                            req_integer(time.get("beatType"), "measure.attributes.time.beatType", 1, None, &mut issues);
                        }
                    }
                    if let Some(key) = attributes.get("key") {
                        const KEY_ALLOWED: [&str; 2] = ["fifths", "mode"];
                        if check_object_shape(key, &KEY_ALLOWED, &KEY_ALLOWED, "measure.attributes.key", &mut issues) {
                            req_integer(key.get("fifths"), "measure.attributes.key.fifths", -7, Some(7), &mut issues);
                            req_string(key.get("mode"), "measure.attributes.key.mode", 0, &mut issues);
                        }
                    }
                    req_integer(attributes.get("staves"), "measure.attributes.staves", 1, None, &mut issues);
                    match attributes.get("clefs") {
                        Some(Value::Array(clefs)) => {
                            for clef in clefs {
                                const CLEF_ALLOWED: [&str; 3] = ["staffNumber", "sign", "line"];
                                if check_object_shape(clef, &CLEF_ALLOWED, &CLEF_ALLOWED,
                                    "measure.attributes.clefs[]", &mut issues) {
                                    req_integer(clef.get("staffNumber"), "measure.attributes.clefs[].staffNumber", 1, None, &mut issues);
                                    req_string(clef.get("sign"), "measure.attributes.clefs[].sign", 1, &mut issues);
                                    req_integer(clef.get("line"), "measure.attributes.clefs[].line", 1, None, &mut issues);
                                }
                            }
                        }
                        _ => issues.push(schema_violation("measure.attributes.clefs must be an array")),
                    }
                }

                match measure.get("events") {
                    Some(Value::Array(events)) => {
                        for event in events {
                            validate_event(event, &mut issues, part_id, &mut event_ids, &mut xml_ids, &mut locator_keys);
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
                            if check_object_shape(barline, &BARLINE_ALLOWED, &BARLINE_REQUIRED,
                                "measure.barlines[]", &mut issues) {
                                opt_string(barline.get("location"), "measure.barlines[].location", 0, &mut issues);
                                opt_string(barline.get("barStyle"), "measure.barlines[].barStyle", 0, &mut issues);
                                if let Some(repeat) = barline.get("repeat") {
                                    const REPEAT_ALLOWED: [&str; 3] = ["direction", "times", "afterJump"];
                                    const REPEAT_REQUIRED: [&str; 1] = ["direction"];
                                    if check_object_shape(repeat, &REPEAT_ALLOWED, &REPEAT_REQUIRED,
                                        "measure.barlines[].repeat", &mut issues) {
                                        check_enum(repeat.get("direction"), &["forward", "backward"],
                                            "measure.barlines[].repeat.direction", &mut issues);
                                        opt_integer(repeat.get("times"), "measure.barlines[].repeat.times", 1, None, &mut issues);
                                        opt_boolean(repeat.get("afterJump"), "measure.barlines[].repeat.afterJump", &mut issues);
                                    }
                                }
                                if let Some(ending) = barline.get("ending") {
                                    const ENDING_ALLOWED: [&str; 2] = ["number", "type"];
                                    const ENDING_REQUIRED: [&str; 1] = ["type"];
                                    if check_object_shape(ending, &ENDING_ALLOWED, &ENDING_REQUIRED,
                                        "measure.barlines[].ending", &mut issues) {
                                        opt_string(ending.get("number"), "measure.barlines[].ending.number", 0, &mut issues);
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
    }

    // Document-level sections. These run ONCE, AFTER every part's events are
    // registered — never inside the per-part loop: inside it, tie references
    // could not resolve across parts, multi-part documents reported duplicated
    // issues, and an empty parts array skipped the checks entirely.

    match dto.get("tieSpans") {
        Some(Value::Array(tie_spans)) => {
            let mut tie_span_ids = std::collections::HashSet::new();
            for span in tie_spans {
                const TIE_ALLOWED: [&str; 5] = ["id", "pitchKey", "eventIds", "startBeat", "endBeat"];
                const TIE_REQUIRED: [&str; 5] = TIE_ALLOWED;
                if !check_object_shape(span, &TIE_ALLOWED, &TIE_REQUIRED, "tieSpan", &mut issues) {
                    continue;
                }
                // TieSpanV1.id: REQUIRED non-empty string. The hand-written TS
                // layer only dedups string ids; the type/length tier is what
                // AJV enforces there — this port owns that tier directly.
                match span.get("id") {
                    Some(Value::String(id)) => {
                        if id.is_empty() {
                            issues.push(schema_violation("tieSpan.id must be a non-empty string"));
                        }
                        if !tie_span_ids.insert(id.clone()) {
                            issues.push(issue("duplicate_tie_span_id", format!("tieSpan id duplicated: {id}")));
                        }
                    }
                    Some(other) => issues.push(schema_violation(format!("tieSpan.id must be a string, got {other}"))),
                    None => {} // absence already reported as missing_field
                }
                req_string(span.get("pitchKey"), "tieSpan.pitchKey", 1, &mut issues);
                match span.get("eventIds") {
                    Some(Value::Array(span_member_ids)) if span_member_ids.len() >= 2 => {
                        for span_member in span_member_ids {
                            match span_member.as_str() {
                                Some(id) => {
                                    if id.is_empty() {
                                        issues.push(schema_violation(
                                            "tieSpan.eventIds: items must be non-empty strings",
                                        ));
                                    }
                                    if !event_ids.contains(id) {
                                        issues.push(issue("dangling_reference",
                                            format!("tieSpan references unknown eventId: {id}")));
                                    }
                                }
                                // A non-string member is never silently skipped:
                                // it violates the item schema and can never name a
                                // known event (TS stringifies it into the probe).
                                None => {
                                    issues.push(schema_violation(format!(
                                        "tieSpan.eventIds: items must be strings, got {span_member}"
                                    )));
                                    issues.push(issue("dangling_reference",
                                        format!("tieSpan references unknown eventId: {span_member}")));
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
        let Some(member_ids) = span.get("eventIds").and_then(Value::as_array) else { continue };
        let Some(span_id) = span.get("id").and_then(Value::as_str) else { continue };
        for event_id in member_ids {
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
                const MARK_ALLOWED: [&str; 4] = ["measureOrdinal", "beat", "bpm", "kind"];
                const MARK_REQUIRED: [&str; 4] = MARK_ALLOWED;
                if !check_object_shape(mark, &MARK_ALLOWED, &MARK_REQUIRED, "tempoMark", &mut issues) {
                    continue;
                }
                req_integer(mark.get("measureOrdinal"), "tempoMark.measureOrdinal", 1, None, &mut issues);
                check_rational(mark.get("beat").unwrap_or(&Value::Null), "tempoMark.beat", &mut issues);
                check_rational(mark.get("bpm").unwrap_or(&Value::Null), "tempoMark.bpm", &mut issues);
                check_enum(mark.get("kind"), &["metronome", "sound"], "tempoMark.kind", &mut issues);
            }
        }
        _ => issues.push(issue("invalid_tempo_marks", "tempoMarks must be an array")),
    }

    // The revision id must equal the frozen formula over the document's own
    // sourceFingerprint + normalizerVersion; a mismatched stamp is an identity
    // forgery regardless of how well-formed the rest is.
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

fn validate_event(
    event: &Value,
    issues: &mut Vec<Issue>,
    part_id: &str,
    event_ids: &mut std::collections::HashSet<String>,
    xml_ids: &mut std::collections::HashSet<String>,
    locator_keys: &mut std::collections::HashSet<String>,
) {
    const EVENT_ALLOWED: [&str; 19] = ["eventId", "kind", "source", "onsetBeat", "durationBeat", "notatedType",
        "dots", "pitch", "chordGroupId", "tieStart", "tieStop", "tiedStart", "tiedStop", "tieSpanId", "isGrace",
        "isCue", "lyricText", "articulations", "timeModification"];
    const EVENT_REQUIRED: [&str; 13] = ["eventId", "kind", "source", "onsetBeat", "durationBeat", "dots",
        "tieStart", "tieStop", "tiedStart", "tiedStop", "isGrace", "isCue", "articulations"];
    if !check_object_shape(event, &EVENT_ALLOWED, &EVENT_REQUIRED, "event", issues) {
        return;
    }
    let event_id = event.get("eventId").and_then(Value::as_str);
    match event_id {
        None => issues.push(schema_violation("event.eventId must be a string")),
        Some(id) if id.is_empty() => issues.push(schema_violation("event.eventId must be non-empty")),
        Some(id) => {
            if !event_ids.insert(id.to_string()) {
                issues.push(issue("duplicate_event_id", format!("eventId duplicated: {id}")));
            }
        }
    }
    let kind = event.get("kind").and_then(Value::as_str);
    check_enum(event.get("kind"), &["note", "rest"], "event.kind", issues);
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
    req_integer(event.get("dots"), "event.dots", 0, None, issues);
    req_boolean(event.get("tieStart"), "event.tieStart", issues);
    req_boolean(event.get("tieStop"), "event.tieStop", issues);
    req_boolean(event.get("tiedStart"), "event.tiedStart", issues);
    req_boolean(event.get("tiedStop"), "event.tiedStop", issues);
    req_boolean(event.get("isGrace"), "event.isGrace", issues);
    req_boolean(event.get("isCue"), "event.isCue", issues);
    opt_string(event.get("notatedType"), "event.notatedType", 0, issues);
    opt_string(event.get("chordGroupId"), "event.chordGroupId", 1, issues);
    opt_string(event.get("tieSpanId"), "event.tieSpanId", 1, issues);
    opt_string(event.get("lyricText"), "event.lyricText", 0, issues);
    match event.get("articulations") {
        Some(Value::Array(items)) => {
            for item in items {
                if !item.is_string() {
                    issues.push(schema_violation("event.articulations: items must be strings"));
                    break;
                }
            }
        }
        _ => issues.push(schema_violation("event.articulations must be an array of strings")),
    }
    if let Some(modification) = event.get("timeModification") {
        const MOD_ALLOWED: [&str; 2] = ["actualNotes", "normalNotes"];
        if check_object_shape(modification, &MOD_ALLOWED, &MOD_ALLOWED, "event.timeModification", issues) {
            req_integer(modification.get("actualNotes"), "event.timeModification.actualNotes", 1, None, issues);
            req_integer(modification.get("normalNotes"), "event.timeModification.normalNotes", 1, None, issues);
        }
    }

    const SOURCE_ALLOWED: [&str; 7] = ["partId", "measureOrdinal", "staffNumber", "sourceOrdinal",
        "printedMeasureNumber", "voiceId", "xmlId"];
    const SOURCE_REQUIRED: [&str; 4] = ["partId", "measureOrdinal", "staffNumber", "sourceOrdinal"];
    match event.get("source") {
        Some(source) if check_object_shape(source, &SOURCE_ALLOWED, &SOURCE_REQUIRED, "event.source", issues) => {
            let source_part = source.get("partId").and_then(Value::as_str).unwrap_or_default();
            if source_part != part_id {
                issues.push(issue("invalid_event", "event.source.partId does not match its part"));
            }
            req_integer(source.get("measureOrdinal"), "event.source.measureOrdinal", 1, None, issues);
            req_integer(source.get("staffNumber"), "event.source.staffNumber", 1, None, issues);
            req_integer(source.get("sourceOrdinal"), "event.source.sourceOrdinal", 1, None, issues);
            opt_string(source.get("printedMeasureNumber"), "event.source.printedMeasureNumber", 0, issues);
            opt_string(source.get("voiceId"), "event.source.voiceId", 0, issues);
            if let Some(xml_id) = source.get("xmlId") {
                match xml_id.as_str() {
                    None => issues.push(schema_violation("event.source.xmlId must be a string when present")),
                    Some(id) if id.is_empty() => issues.push(schema_violation("event.source.xmlId must be non-empty")),
                    Some(id) => {
                        if !xml_ids.insert(id.to_string()) {
                            issues.push(issue("duplicate_xml_id", format!("note@id duplicated: {id}")));
                        }
                    }
                }
            }
            let measure = source.get("measureOrdinal").and_then(Value::as_i64);
            let ordinal = source.get("sourceOrdinal").and_then(Value::as_i64);
            if let (Some(measure), Some(ordinal)) = (measure, ordinal) {
                let key = format!("{source_part}:{measure}:{ordinal}");
                if !locator_keys.insert(key.clone()) {
                    issues.push(issue("duplicate_source_locator",
                        format!("source locator claimed by two events: {key}")));
                }
            }
        }
        _ => issues.push(issue("invalid_event", "event.source must be an object")),
    }

    // PitchV1: required all five, closed, frozen enum/ranges; alter is a
    // RationalV1; midiNote is integer-or-null within 0..=127.
    if let Some(pitch) = event.get("pitch") {
        const PITCH_ALLOWED: [&str; 5] = ["step", "alter", "octave", "midiNote", "spelling"];
        const PITCH_REQUIRED: [&str; 5] = ["step", "alter", "octave", "midiNote", "spelling"];
        if check_object_shape(pitch, &PITCH_ALLOWED, &PITCH_REQUIRED, "event.pitch", issues) {
            check_enum(pitch.get("step"), &["A", "B", "C", "D", "E", "F", "G"], "event.pitch.step", issues);
            check_rational(pitch.get("alter").unwrap_or(&Value::Null), "event.pitch.alter", issues);
            req_integer(pitch.get("octave"), "event.pitch.octave", -1, Some(10), issues);
            match pitch.get("midiNote") {
                None | Some(Value::Null) => {}
                Some(v) => check_range(
                    v.as_i64().unwrap_or(-1),
                    "event.pitch.midiNote",
                    0,
                    Some(127),
                    issues,
                ),
            }
            req_string(pitch.get("spelling"), "event.pitch.spelling", 1, issues);
        }
    }
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
