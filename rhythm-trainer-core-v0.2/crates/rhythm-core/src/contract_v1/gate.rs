//! R2-3a3: the mandatory fingerprint gate — single entry, no bypass.
//! Order (mirrors TS planFingerprintV1 :1171):
//!   1. projection fail-closed invariants (project.rs)
//!   2. full ScoreDocumentV1 validation (document.rs)
//!   3. plan↔document binding: plan.scoreFingerprint == report.fingerprint
//!   4. payload construction from the plan + config, then full validation
//!   5. NFC -> JCS -> SHA-256 (fingerprint.rs, byte-identical to the six
//!      committed vectors)
//!
//! plan_json shape = the frozen PlannerOutput (task card §2.3), including the
//! top-level scoreFingerprint carried by build_plan_v1's five-step rule.

use num_bigint::BigInt;
use serde_json::{json, Map, Value};

use crate::contract_v1::document::require_valid_document;
use crate::contract_v1::error::ContractError;
use crate::contract_v1::fingerprint::compute_plan_fingerprint_v1;
use crate::contract_v1::payload_check::validate_plan_fingerprint_payload_v1;
use crate::contract_v1::project::{project_score_document_v1, projected_score_revision_id};
use crate::contract_v1::rational::{is_canonical, reduce, RationalV1};
use crate::contract_v1::time::count_in_beats;

fn err(code: &str, message: impl Into<String>) -> ContractError {
    ContractError::new(code, message)
}

fn as_object<'v>(value: &'v Value, code: &str, message: &str) -> Result<&'v Map<String, Value>, ContractError> {
    value.as_object().ok_or_else(|| err(code, message.to_string()))
}

/// Parses a frozen reduced-rational text ("n/d") into the payload object shape.
fn parse_beat_text(value: &Value) -> Result<Value, ContractError> {
    let text = value
        .as_str()
        .ok_or_else(|| err("INVALID_GROUP", "beat fields must be reduced \"n/d\" strings"))?;
    let (n, d) = text
        .split_once('/')
        .ok_or_else(|| err("INVALID_GROUP", format!("beat text missing '/': {text}")))?;
    let reduced = reduce(
        n.parse::<i64>()
            .map_err(|_| err("INVALID_GROUP", format!("beat numerator invalid: {text}")))?,
        d.parse::<i64>()
            .map_err(|_| err("INVALID_GROUP", format!("beat denominator invalid: {text}")))?,
    )?;
    Ok(json!({ "numerator": reduced.numerator, "denominator": reduced.denominator }))
}

/// Builds the PlanFingerprintPayloadV1 from a PlannerOutput + config. Rules
/// mirror TS buildPlanFingerprintPayloadV1: members resolve through
/// occurrenceIds (scoreEventId is NEVER a lookup key), the pairing is
/// cross-checked, one group cannot mix passes, the group duration equals its
/// longest member, and the hand mapping is canonicalized (parts by partId,
/// staves by staff number).
pub fn build_payload(
    plan: &Map<String, Value>,
    config: &Map<String, Value>,
    score_revision_id: &str,
) -> Result<Value, ContractError> {
    let occurrences = plan.get("occurrences").and_then(Value::as_array)
        .ok_or_else(|| err("EMPTY_PLAN", "PlannerOutput.occurrences missing"))?;
    let groups = plan.get("groups").and_then(Value::as_array)
        .ok_or_else(|| err("EMPTY_PLAN", "PlannerOutput.groups missing"))?;

    // occurrenceId -> occurrence; duplicate ids are a contract break.
    let mut by_occurrence_id: std::collections::HashMap<&str, &Value> = std::collections::HashMap::new();
    for occurrence in occurrences {
        let id = occurrence.get("occurrenceId").and_then(Value::as_str)
            .ok_or_else(|| err("DUPLICATE_OCCURRENCE_ID", "occurrence missing occurrenceId"))?;
        if by_occurrence_id.insert(id, occurrence).is_some() {
            return Err(err("DUPLICATE_OCCURRENCE_ID",
                format!("occurrenceId not unique in plan: {id}")));
        }
    }

    let bpm_value = config.get("bpm").ok_or_else(|| err("INVALID_BPM", "config.bpm missing"))?;
    let bpm_numerator = bpm_value.get("numerator").and_then(Value::as_i64)
        .ok_or_else(|| err("INVALID_BPM", "config.bpm.numerator missing"))?;
    let bpm_denominator = bpm_value.get("denominator").and_then(Value::as_i64)
        .ok_or_else(|| err("INVALID_BPM", "config.bpm.denominator missing"))?;
    if bpm_denominator <= 0 || bpm_numerator <= 0 {
        return Err(err("INVALID_BPM", "bpm must be positive"));
    }
    if !is_canonical(bpm_numerator, bpm_denominator) {
        return Err(err("INVALID_RATIONAL", "bpm must be a reduced rational"));
    }
    let bpm_rational = RationalV1 { numerator: bpm_numerator, denominator: bpm_denominator };
    let count_in_us = config.get("countInUs").and_then(Value::as_i64)
        .ok_or_else(|| err("INVALID_TIME", "config.countInUs missing"))?;
    let ticks_per_quarter = config.get("ticksPerQuarter").and_then(Value::as_i64)
        .ok_or_else(|| err("INVALID_PPQ", "config.ticksPerQuarter missing"))?;
    let hand_mapping = config.get("handMapping").cloned()
        .ok_or_else(|| err("INVALID_SCOPE", "config.handMapping missing"))?;

    let count_in_beats = count_in_beats(count_in_us, &bpm_rational)?;
    let count_in_beats_value = json!({
        "numerator": count_in_beats.numerator,
        "denominator": count_in_beats.denominator,
    });
    // Suppress the unused warning: reduce() is the a2 constructor the config
    // path validates through when bpm arrives unreduced from other callers.
    let _ = reduce(bpm_numerator, bpm_denominator)?;

    let mut target_groups: Vec<Value> = Vec::new();
    let mut used_occurrence_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (position, group) in groups.iter().enumerate() {
        let group = as_object(group, "INVALID_GROUP", "targetGroup must be an object")?;
        let occurrence_ids = group.get("occurrenceIds").and_then(Value::as_array)
            .ok_or_else(|| err("OCCURRENCE_NOT_IN_PLAN", "group.occurrenceIds missing"))?;
        let score_event_ids = group.get("scoreEventIds").and_then(Value::as_array)
            .ok_or_else(|| err("GROUP_ID_MISMATCH", "group.scoreEventIds missing"))?;
        if occurrence_ids.len() != score_event_ids.len() {
            return Err(err("GROUP_ID_MISMATCH",
                format!("group {position}: occurrenceIds and scoreEventIds must pair 1:1")));
        }
        let mut members: Vec<Value> = Vec::new();
        let mut group_pass_index: Option<i64> = None;
        for occurrence_id in occurrence_ids {
            let id = occurrence_id.as_str()
                .ok_or_else(|| err("OCCURRENCE_NOT_IN_PLAN", "occurrenceIds entries must be strings"))?;
            let occurrence = by_occurrence_id.get(id)
                .ok_or_else(|| err("OCCURRENCE_NOT_IN_PLAN", format!("group references unknown occurrence {id}")))?;
            if !used_occurrence_ids.insert(id.to_string()) {
                return Err(err("OCCURRENCE_REUSED",
                    format!("occurrence {id} is claimed by more than one group")));
            }
            let pass_index = occurrence.get("passIndex").and_then(Value::as_i64)
                .ok_or_else(|| err("OCCURRENCE_NOT_IN_PLAN", format!("occurrence {id} missing passIndex")))?;
            match group_pass_index {
                None => group_pass_index = Some(pass_index),
                Some(existing) if existing != pass_index => {
                    return Err(err("GROUP_PASS_MISMATCH",
                        format!("group {position} mixes pass {existing} and {pass_index}")));
                }
                Some(_) => {}
            }
            let mut member = json!({
                "sourceLocator": occurrence.get("locator").cloned().unwrap_or(Value::Null),
                "pitch": {
                    "midiNote": occurrence.get("pitch").and_then(|p| p.get("midiNote")).cloned().unwrap_or(Value::Null),
                    "spelling": occurrence.get("pitch").and_then(|p| p.get("spelling")).cloned().unwrap_or(Value::Null),
                },
                "durationBeat": parse_beat_text(occurrence.get("durationBeat").ok_or_else(|| err("OCCURRENCE_NOT_IN_PLAN", format!("occurrence {id} missing durationBeat")))?)?,
            });
            // TS buildPlanFingerprintPayloadV1 :882 carries isTieOnset ONLY
            // when true — a tie onset member changes the fingerprint (found
            // by the R2-3b frozen-corpus diff on the tie case G3-base).
            if occurrence.get("isTieOnset").and_then(Value::as_bool) == Some(true) {
                member.as_object_mut().expect("member object just built")
                    .insert("isTieOnset".to_string(), Value::Bool(true));
            }
            members.push(member);
        }
        // Pairing cross-check: each occurrence must carry exactly the paired
        // scoreEventId (same member order).
        for (index, member) in members.iter().enumerate() {
            let _ = member;
            let occurrence_id = occurrence_ids[index].as_str().unwrap_or_default();
            let occurrence = by_occurrence_id.get(occurrence_id)
                .ok_or_else(|| err("OCCURRENCE_NOT_IN_PLAN", format!("unknown occurrence {occurrence_id}")))?;
            let paired = score_event_ids[index].as_str().unwrap_or_default();
            let actual = occurrence.get("scoreEventId").and_then(Value::as_str).unwrap_or_default();
            if actual != paired {
                return Err(err("GROUP_ID_MISMATCH",
                    format!("group {position} member {index}: occurrence {occurrence_id} carries scoreEventId {actual}, group lists {paired}")));
            }
        }
        let pass_index = group_pass_index.unwrap_or(0);
        target_groups.push(json!({
            "groupIndex": position,
            "passIndex": pass_index,
            "bar": group.get("bar").cloned().unwrap_or(Value::Null),
            "onsetBeatFromRangeStart": parse_beat_text(group.get("playbackBeat").ok_or_else(|| err("INVALID_GROUP", "group.playbackBeat missing"))?)?,
            "durationBeat": parse_beat_text(group.get("durationBeat").ok_or_else(|| err("INVALID_GROUP", "group.durationBeat missing"))?)?,
            "beatInMeasure": parse_beat_text(group.get("beatInMeasure").ok_or_else(|| err("INVALID_GROUP", "group.beatInMeasure missing"))?)?,
            "staffNumbers": group.get("staffNumbers").cloned().unwrap_or(Value::Array(Vec::new())),
            "voiceIds": group.get("voiceIds").cloned().unwrap_or(Value::Array(Vec::new())),
            "members": members,
        }));
    }

    // Canonicalized hand mapping: parts by partId, staves by staff number.
    let mut canonical_mapping = hand_mapping;
    if let Some(parts) = canonical_mapping.get_mut("parts").and_then(Value::as_array_mut) {
        parts.sort_by_key(|part| part.get("partId").and_then(Value::as_str).unwrap_or_default().to_string());
        for part in parts.iter_mut() {
            if let Some(staves) = part.get_mut("staves").and_then(Value::as_array_mut) {
                staves.sort_by_key(|staff| staff.get("staffNumber").and_then(Value::as_i64).unwrap_or(0));
            }
        }
    }

    Ok(json!({
        "fingerprintSchemaVersion": 1,
        "plannerVersion": config.get("plannerVersion").cloned().unwrap_or(Value::Null),
        "scoreRevisionId": score_revision_id,
        "normalizerVersion": crate::contract_v1::project::NORMALIZER_VERSION,
        "supportProfileVersion": crate::contract_v1::project::SUPPORT_PROFILE_VERSION_V1,
        "scope": {
            "partId": config.get("partId").cloned().unwrap_or(Value::Null),
            "range": config.get("range").cloned().unwrap_or(Value::Null),
            "hand": config.get("hand").cloned().unwrap_or(Value::Null),
            "handMapping": canonical_mapping,
        },
        "repeatSelection": config.get("repeatSelection").cloned().unwrap_or(Value::Null),
        "tempo": {
            "bpm": { "numerator": bpm_numerator, "denominator": bpm_denominator },
            "ticksPerQuarter": ticks_per_quarter,
            "countInBeats": count_in_beats_value,
            "timeOrigin": "playback-start",
        },
        "targetGroups": target_groups,
    }))
}

/// THE mandatory gate. Every failure path rejects; nothing degrades to a
/// warning, an empty plan, or an unvalidated fingerprint.
pub fn plan_fingerprint_v1_gate(
    document_json: &Value,
    report_json: &Value,
    plan_json: &Value,
    config_json: &Value,
) -> Result<String, ContractError> {
    // 1. Projection fail-closed invariants (binding + duplicates + enums).
    let document = project_score_document_v1(document_json, report_json)?;
    // 2. Full ScoreDocumentV1 validation.
    require_valid_document(&document)?;
    // 3. Plan↔document binding (bare 64-hex on both sides).
    let report_fingerprint = report_json.get("fingerprint").and_then(Value::as_str)
        .ok_or_else(|| err("INVALID_SOURCE_FINGERPRINT", "report.fingerprint missing"))?;
    let plan_fingerprint = plan_json.get("scoreFingerprint").and_then(Value::as_str)
        .ok_or_else(|| err("PLAN_DOCUMENT_MISMATCH", "plan is missing scoreFingerprint"))?;
    if plan_fingerprint != report_fingerprint {
        return Err(err("PLAN_DOCUMENT_MISMATCH",
            format!("plan was built for score {plan_fingerprint}, document is {}", report_fingerprint)));
    }
    // 4. Payload construction + full payload validation.
    let config = as_object(config_json, "INVALID_CONFIG", "config must be an object")?;
    let plan = as_object(plan_json, "INVALID_PLAN", "plan must be an object")?;
    let score_revision_id = projected_score_revision_id(&document)?;
    let mut payload = build_payload(plan, config, &score_revision_id)?;
    let payload_issues = validate_plan_fingerprint_payload_v1(&payload);
    if !payload_issues.is_empty() {
        return Err(err("PAYLOAD_VALIDATION_FAILED",
            format!(
                "payload failed validation: {} ({})",
                payload_issues.iter().map(|issue| issue.code.as_str()).collect::<Vec<_>>().join(", "),
                payload_issues[0].message,
            )));
    }
    // 5. Frozen fingerprint primitive.
    compute_plan_fingerprint_v1(&mut payload)
}
