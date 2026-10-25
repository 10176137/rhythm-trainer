//! R2-3a3: full payload validation, collected-style, mirroring TS
//! `validatePlanFingerprintPayloadV1` over the JSON value domain.

use serde_json::Value;

use crate::contract_v1::document::{check_closed_keys, check_required_keys, is_object, Issue};

fn issue(code: &str, message: impl Into<String>) -> Issue {
    Issue { code: code.to_string(), message: message.into() }
}

fn check_rational(value: &Value, context: &str, issues: &mut Vec<Issue>) {
    let Some(map) = value.as_object() else {
        issues.push(issue("invalid_rational", format!("{context}: not an object")));
        return;
    };
    let Some(numerator) = map.get("numerator").and_then(Value::as_i64) else {
        issues.push(issue("invalid_rational", format!("{context}: numerator must be an integer")));
        return;
    };
    let Some(denominator) = map.get("denominator").and_then(Value::as_i64) else {
        issues.push(issue("invalid_rational", format!("{context}: denominator must be an integer")));
        return;
    };
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    if denominator <= 0
        || numerator > MAX_SAFE_INTEGER
        || numerator < -MAX_SAFE_INTEGER
        || denominator > MAX_SAFE_INTEGER
        || (numerator != 0 && gcd(numerator.unsigned_abs(), denominator.unsigned_abs()) != 1)
        || (numerator == 0 && denominator != 1) {
        issues.push(issue("invalid_rational", format!("{context}: not a reduced RationalV1")));
    }
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let r = a % b;
        a = b;
        b = r;
    }
    a
}

/// Full payload validation. `empty_plan` short-circuits (as in TS :1060).
pub fn validate_plan_fingerprint_payload_v1(payload: &Value) -> Vec<Issue> {
    let mut issues = Vec::new();
    if !is_object(payload) {
        return vec![issue("invalid_payload", "not an object")];
    }
    const ROOT_ALLOWED: [&str; 9] = ["fingerprintSchemaVersion", "plannerVersion", "scoreRevisionId",
        "normalizerVersion", "supportProfileVersion", "scope", "repeatSelection", "tempo", "targetGroups"];
    check_closed_keys(payload, &ROOT_ALLOWED, "payload", &mut issues);
    check_required_keys(payload, &ROOT_ALLOWED, "payload", &mut issues);
    if payload.get("fingerprintSchemaVersion").and_then(Value::as_i64) != Some(1) {
        issues.push(issue("invalid_payload", "fingerprintSchemaVersion must be 1"));
    }
    for key in ["plannerVersion", "scoreRevisionId", "normalizerVersion", "supportProfileVersion"] {
        if !payload.get(key).and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false) {
            issues.push(issue("missing_field", format!("{key} must be a non-empty string")));
        }
    }

    if let Some(scope) = payload.get("scope") {
        if !is_object(scope) {
            issues.push(issue("invalid_scope", "scope must be an object"));
        } else {
            check_closed_keys(scope, &["partId", "range", "hand", "handMapping"], "scope", &mut issues);
            check_required_keys(scope, &["partId", "range", "hand", "handMapping"], "scope", &mut issues);
            if !scope.get("partId").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false) {
                issues.push(issue("invalid_scope", "scope.partId must be a non-empty string"));
            }
            if let Some(range) = scope.get("range") {
                if !is_object(range) {
                    issues.push(issue("invalid_scope", "scope.range must be an object"));
                } else {
                    check_closed_keys(range, &["startMeasureOrdinal", "endMeasureOrdinal"], "scope.range", &mut issues);
                    let start = range.get("startMeasureOrdinal").and_then(Value::as_i64);
                    let end = range.get("endMeasureOrdinal").and_then(Value::as_i64);
                    if start.map(|v| v < 1).unwrap_or(true) {
                        issues.push(issue("invalid_integer", "scope.range.start must be an integer >= 1"));
                    }
                    if end.map(|v| v < 1).unwrap_or(true) {
                        issues.push(issue("invalid_integer", "scope.range.end must be an integer >= 1"));
                    }
                    if let (Some(start), Some(end)) = (start, end) {
                        if end < start {
                            issues.push(issue("invalid_scope", "scope.range end must be >= start"));
                        }
                    }
                }
            }
            if !matches!(scope.get("hand").and_then(Value::as_str), Some("left") | Some("right") | Some("both")) {
                issues.push(issue("invalid_scope", "scope.hand must be left|right|both"));
            }
            if let Some(mapping) = scope.get("handMapping") {
                if !is_object(mapping) {
                    issues.push(issue("invalid_scope", "scope.handMapping must be an object"));
                } else {
                    check_closed_keys(mapping, &["schemaVersion", "mappingVersion", "source", "parts"], "handMapping", &mut issues);
                    if !matches!(mapping.get("source").and_then(Value::as_str), Some("user") | Some("score-metadata")) {
                        issues.push(issue("invalid_scope",
                            format!("handMapping.source must be user|score-metadata (got {})", mapping.get("source").map(|v| v.to_string()).unwrap_or_default())));
                    }
                    if mapping.get("schemaVersion").and_then(Value::as_i64) != Some(1) {
                        issues.push(issue("invalid_scope", "handMapping.schemaVersion must be 1"));
                    }
                    match mapping.get("parts") {
                        Some(Value::Array(parts)) => {
                            let mut seen_part_ids = std::collections::HashSet::new();
                            for part in parts {
                                let Some(part_object) = part.as_object() else {
                                    issues.push(issue("invalid_scope", "handMapping part must be an object"));
                                    continue;
                                };
                                let Some(part_id) = part_object.get("partId").and_then(Value::as_str) else {
                                    issues.push(issue("invalid_scope", "handMapping part.partId must be a non-empty string"));
                                    continue;
                                };
                                if part_id.is_empty() {
                                    issues.push(issue("invalid_scope", "handMapping part.partId must be a non-empty string"));
                                    continue;
                                }
                                if !seen_part_ids.insert(part_id.to_string()) {
                                    issues.push(issue("hand_mapping_conflict",
                                        format!("handMapping lists part {part_id} more than once")));
                                }
                                match part_object.get("staves") {
                                    Some(Value::Array(staves)) => {
                                        let mut assignments: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
                                        for staff in staves {
                                            let Some(staff_object) = staff.as_object() else {
                                                issues.push(issue("invalid_scope",
                                                    format!("handMapping part {part_id}: each staff needs staffNumber>=1 and hand left|right")));
                                                continue;
                                            };
                                            let staff_number = staff_object.get("staffNumber").and_then(Value::as_i64);
                                            let hand = staff_object.get("hand").and_then(Value::as_str);
                                            let valid = matches!((staff_number, hand), (Some(n), Some(h)) if n >= 1 && (h == "left" || h == "right"));
                                            if !valid {
                                                issues.push(issue("invalid_scope",
                                                    format!("handMapping part {part_id}: each staff needs staffNumber>=1 and hand left|right")));
                                                continue;
                                            }
                                            let number = staff_number.unwrap();
                                            let hand_value = hand.unwrap().to_string();
                                            match assignments.get(&number) {
                                                None => {
                                                    assignments.insert(number, hand_value);
                                                }
                                                Some(previous) if *previous != hand_value => {
                                                    issues.push(issue("hand_mapping_conflict",
                                                        format!("handMapping assigns staff {number} of {part_id} both {previous} and {hand_value}")));
                                                }
                                                Some(_) => {
                                                    issues.push(issue("hand_mapping_conflict",
                                                        format!("handMapping lists staff {number} of {part_id} more than once")));
                                                }
                                            }
                                        }
                                    }
                                    _ => issues.push(issue("invalid_scope",
                                        format!("handMapping part {part_id}: staves must be an array"))),
                                }
                            }
                        }
                        _ => issues.push(issue("invalid_scope", "handMapping.parts must be an array")),
                    }
                }
            }
        }
    } else {
        issues.push(issue("invalid_scope", "scope must be an object"));
    }

    if let Some(repeat) = payload.get("repeatSelection") {
        if !is_object(repeat) {
            issues.push(issue("invalid_repeat", "repeatSelection must be an object"));
        } else {
            match repeat.get("kind").and_then(Value::as_str) {
                Some("none") => check_closed_keys(repeat, &["kind"], "repeatSelection", &mut issues),
                Some("range-loop") => {
                    check_closed_keys(repeat, &["kind", "count"], "repeatSelection", &mut issues);
                    let count = repeat.get("count").and_then(Value::as_i64);
                    if !count.map(|c| (1..=32).contains(&c)).unwrap_or(false) {
                        issues.push(issue("invalid_repeat", "range-loop count must be an integer 1-32"));
                    }
                }
                other => issues.push(issue("invalid_repeat",
                    format!("repeatSelection.kind must be none|range-loop (got {})", other.unwrap_or("missing")))),
            }
        }
    }

    if let Some(tempo) = payload.get("tempo") {
        if !is_object(tempo) {
            issues.push(issue("invalid_tempo", "tempo must be an object"));
        } else {
            check_closed_keys(tempo, &["bpm", "ticksPerQuarter", "countInBeats", "timeOrigin"], "tempo", &mut issues);
            check_rational(tempo.get("bpm").unwrap_or(&Value::Null), "tempo.bpm", &mut issues);
            check_rational(tempo.get("countInBeats").unwrap_or(&Value::Null), "tempo.countInBeats", &mut issues);
            let positive = tempo.get("bpm")
                .and_then(|bpm| bpm.get("numerator"))
                .and_then(Value::as_i64)
                .map(|n| n > 0)
                .unwrap_or(true);
            if !positive {
                issues.push(issue("invalid_tempo", "tempo.bpm must be positive"));
            }
            if tempo.get("ticksPerQuarter").and_then(Value::as_i64).map(|v| v < 1).unwrap_or(true) {
                issues.push(issue("invalid_integer", "tempo.ticksPerQuarter must be an integer >= 1"));
            }
            if tempo.get("timeOrigin").and_then(Value::as_str) != Some("playback-start") {
                issues.push(issue("invalid_tempo", "tempo.timeOrigin must be playback-start"));
            }
        }
    } else {
        issues.push(issue("invalid_tempo", "tempo must be an object"));
    }

    let groups = match payload.get("targetGroups") {
        Some(Value::Array(groups)) if !groups.is_empty() => groups.clone(),
        Some(Value::Array(_)) => {
            issues.push(issue("empty_plan", "targetGroups must be a non-empty array"));
            return issues;
        }
        _ => {
            issues.push(issue("empty_plan", "targetGroups must be a non-empty array"));
            return issues;
        }
    };
    let mut group_indexes = std::collections::HashSet::new();
    for (position, group) in groups.iter().enumerate() {
        if !is_object(group) {
            issues.push(issue("invalid_group", "targetGroup must be an object"));
            continue;
        }
        check_closed_keys(group, &["groupIndex", "passIndex", "bar", "onsetBeatFromRangeStart", "durationBeat",
            "beatInMeasure", "staffNumbers", "voiceIds", "members"], "targetGroup", &mut issues);
        let group_index = group.get("groupIndex").and_then(Value::as_i64);
        match group_index {
            None => issues.push(issue("invalid_group", "groupIndex must be a non-negative integer")),
            Some(index) if index < 0 => issues.push(issue("invalid_group", "groupIndex must be a non-negative integer")),
            Some(index) => {
                if !group_indexes.insert(index) {
                    issues.push(issue("duplicate_group_index", format!("groupIndex duplicated: {index}")));
                }
                if index != position as i64 {
                    issues.push(issue("group_index_out_of_sequence",
                        format!("groupIndex must equal its array position (position {position}, got {index})")));
                }
            }
        }
        if let Some(staff_numbers) = group.get("staffNumbers") {
            if !staff_numbers.is_array() {
                issues.push(issue("invalid_group", "staffNumbers must be an array"));
            }
        }
        if let Some(voice_ids) = group.get("voiceIds") {
            if !voice_ids.is_array() {
                issues.push(issue("invalid_group", "voiceIds must be an array"));
            }
        }
        check_rational(group.get("onsetBeatFromRangeStart").unwrap_or(&Value::Null),
            "targetGroup.onsetBeatFromRangeStart", &mut issues);
        check_rational(group.get("durationBeat").unwrap_or(&Value::Null),
            "targetGroup.durationBeat", &mut issues);
        check_rational(group.get("beatInMeasure").unwrap_or(&Value::Null),
            "targetGroup.beatInMeasure", &mut issues);
        match group.get("members") {
            Some(Value::Array(members)) if !members.is_empty() => {
                let mut locators = std::collections::HashSet::new();
                let mut longest: Option<(i64, i64)> = None;
                for member in members {
                    if !is_object(member) {
                        issues.push(issue("invalid_member", "member must be an object"));
                        continue;
                    }
                    check_closed_keys(member, &["sourceLocator", "pitch", "durationBeat", "isTieOnset"],
                        "member", &mut issues);
                    check_rational(member.get("durationBeat").unwrap_or(&Value::Null),
                        "member.durationBeat", &mut issues);
                    if let Some(is_tie_onset) = member.get("isTieOnset") {
                        if !is_tie_onset.is_boolean() {
                            issues.push(issue("invalid_member", "isTieOnset must be boolean"));
                        }
                    }
                    if let Some(locator) = member.get("sourceLocator") {
                        if !is_object(locator) {
                            issues.push(issue("invalid_member", "sourceLocator must be an object"));
                        } else {
                            check_closed_keys(locator, &["partId", "measureOrdinal", "sourceOrdinal", "voiceId"],
                                "member.sourceLocator", &mut issues);
                            let part = locator.get("partId").and_then(Value::as_str).unwrap_or_default();
                            let measure = locator.get("measureOrdinal").and_then(Value::as_i64);
                            let ordinal = locator.get("sourceOrdinal").and_then(Value::as_i64);
                            if part.is_empty() || measure.is_none() || ordinal.is_none() {
                                issues.push(issue("invalid_member", "sourceLocator must carry partId/measureOrdinal/sourceOrdinal"));
                            } else {
                                let voice = locator.get("voiceId").and_then(Value::as_str).unwrap_or("");
                            let key = format!("{part}:{measure:?}:{ordinal:?}:{voice}");
                                if !locators.insert(key.clone()) {
                                    issues.push(issue("duplicate_member_locator",
                                        format!("member locator duplicated: {key}")));
                                }
                            }
                        }
                    }
                    if let Some(pitch) = member.get("pitch") {
                        if !is_object(pitch) {
                            issues.push(issue("invalid_member", "member.pitch must be an object"));
                        } else {
                            check_closed_keys(pitch, &["midiNote", "spelling"], "member.pitch", &mut issues);
                            let midi = pitch.get("midiNote").and_then(Value::as_i64);
                            if !midi.map(|n| (0..=127).contains(&n)).unwrap_or(false) {
                                issues.push(issue("invalid_member", "pitch.midiNote must be an integer 0-127"));
                            }
                            if !pitch.get("spelling").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false) {
                                issues.push(issue("invalid_member", "pitch.spelling must be a non-empty string"));
                            }
                        }
                    }
                    // Track the longest member duration for the group check.
                    if let Some(duration) = member.get("durationBeat").and_then(Value::as_object) {
                        if let (Some(n), Some(d)) = (
                            duration.get("numerator").and_then(Value::as_i64),
                            duration.get("denominator").and_then(Value::as_i64),
                        ) {
                            let replaces = match longest {
                                None => true,
                                Some((ln, ld)) => BigIntCross::new(n, d) > BigIntCross::new(ln, ld),
                            };
                            if replaces {
                                longest = Some((n, d));
                            }
                        }
                    }
                }
                // Group duration must equal the LONGEST member duration.
                if let (Some(duration_value), Some((ln, ld))) =
                    (group.get("durationBeat").and_then(Value::as_object), longest) {
                    if let (Some(gn), Some(gd)) = (
                        duration_value.get("numerator").and_then(Value::as_i64),
                        duration_value.get("denominator").and_then(Value::as_i64),
                    ) {
                        if BigIntCross::new(gn, gd) != BigIntCross::new(ln, ld) {
                            issues.push(issue("group_duration_mismatch",
                                "targetGroup.durationBeat must equal the longest member durationBeat"));
                        }
                    }
                }
            }
            _ => issues.push(issue("invalid_group", "targetGroup.members must be a non-empty array")),
        }
    }
    issues
}

/// Exact cross-multiplied rational comparison key (n, d over BigInt).
struct BigIntCross {
    n: i64,
    d: i64,
}

impl BigIntCross {
    fn new(n: i64, d: i64) -> Self {
        Self { n, d }
    }
}

impl PartialEq for BigIntCross {
    fn eq(&self, other: &Self) -> bool {
        use num_bigint::BigInt;
        BigInt::from(self.n) * BigInt::from(other.d) == BigInt::from(other.n) * BigInt::from(self.d)
    }
}

impl PartialOrd for BigIntCross {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        use num_bigint::BigInt;
        use std::cmp::Ordering;
        let left = BigInt::from(self.n) * BigInt::from(other.d);
        let right = BigInt::from(other.n) * BigInt::from(self.d);
        Some(match left.cmp(&right) {
            Ordering::Less => Ordering::Less,
            Ordering::Greater => Ordering::Greater,
            Ordering::Equal => Ordering::Equal,
        })
    }
}
