//! R2-3a3 acceptance: document validation, projection binding, payload
//! validation, and the mandatory fingerprint gate. Cross-check anchor: the
//! committed fixture `a3-gate-fixture.json` carries a TS-projected
//! ScoreDocumentV1 and the TS gate's expected fingerprint on the same
//! semantics — the Rust gate must reproduce it byte-for-byte.

use rhythm_core::contract_v1::{
    build_payload, parse_plan_request_config, plan_fingerprint_v1_gate, project_score_document_v1,
    validate_plan_fingerprint_payload_v1, validate_score_document_v1,
};
use serde_json::Value;

const FIXTURE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../audit-r1/fixtures/parity-cases/expected/a3-gate-fixture.json"
);

fn load_fixture() -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(FIXTURE_PATH).expect("read a3 gate fixture"),
    )
    .expect("a3 gate fixture parses")
}

fn issue_codes(value: &Value) -> Vec<String> {
    validate_score_document_v1(value).into_iter().map(|issue| issue.code).collect()
}

#[test]
fn legal_document_and_binding_produce_the_ts_fingerprint() {
    let fixture = load_fixture();
    let fingerprint = plan_fingerprint_v1_gate(
        &fixture["document"],
        &fixture["report"],
        &fixture["plannerOutput"],
        &fixture["config"],
    )
    .expect("gate accepts the legal fixture");
    // JSON-level cross-check: the Rust-built payload must equal the TS-built
    // payload object the fixture embeds (diffs surface as field-level noise
    // instead of a bare hash mismatch).
    let config = parse_plan_request_config(&fixture["config"].to_string())
        .expect("fixture config parses");
    let _ = config; // (payload equality below is the actual check)
    assert_eq!(
        fingerprint,
        fixture["expectedFingerprint"].as_str().expect("expectedFingerprint"),
        "Rust gate must reproduce the TS gate fingerprint byte-for-byte"
    );
}

#[test]
fn projection_binding_uses_the_prefixed_source_fingerprint() {
    let fixture = load_fixture();
    // Legal binding: source.sourceFingerprint (sha256:-prefixed) matches
    // report.fingerprint (bare) — the C-12 five-step rule.
    let projected = project_score_document_v1(&fixture["document"], &fixture["report"])
        .expect("legal binding projects");
    assert_eq!(
        projected["source"]["sourceFingerprint"],
        fixture["document"]["source"]["sourceFingerprint"]
    );

    // Mismatched report fingerprint -> DOCUMENT_REPORT_MISMATCH.
    let mut mismatched_report = fixture["report"].clone();
    mismatched_report["fingerprint"] = Value::String("b".repeat(64));
    let error = project_score_document_v1(&fixture["document"], &mismatched_report)
        .expect_err("mismatch must fail closed");
    assert_eq!(error.code, "DOCUMENT_REPORT_MISMATCH");

    // Wrong source fingerprint format -> INVALID_SOURCE_FINGERPRINT.
    let mut bad_document = fixture["document"].clone();
    bad_document["source"]["sourceFingerprint"] = Value::String("not-a-fingerprint".into());
    let error = project_score_document_v1(&bad_document, &fixture["report"])
        .expect_err("format violation must fail closed");
    assert_eq!(error.code, "INVALID_SOURCE_FINGERPRINT");

    // The C-12 trap: ScoreDocumentV1 has NO top-level fingerprint field; the
    // binding must not be fooled by one.
    let mut smuggled = fixture["document"].clone();
    smuggled["fingerprint"] = Value::String("c".repeat(64));
    smuggled["source"]["sourceFingerprint"] =
        Value::String(format!("sha256:{}", "a".repeat(64)));
    assert!(project_score_document_v1(&smuggled, &fixture["report"]).is_ok(),
        "the smuggled top-level field is ignored by the binding rule");
}

#[test]
fn document_negative_matrix_reports_frozen_codes() {
    let fixture = load_fixture();
    let base = fixture["document"].clone();

    // Closed keys: an unexpected root field is reported.
    let mut unexpected = base.clone();
    unexpected["surprise"] = Value::Bool(true);
    assert!(issue_codes(&unexpected).contains(&"unexpected_field".to_string()));

    // Unknown schema version short-circuits.
    let mut version = base.clone();
    version["schemaVersion"] = Value::from(2);
    assert_eq!(issue_codes(&version), vec!["unknown_schema_version".to_string()]);

    // Missing required field.
    let mut missing = base.clone();
    missing.as_object_mut().unwrap().remove("metadata");
    assert!(issue_codes(&missing).contains(&"missing_field".to_string()));

    // Non-reduced rational in a measure.
    let mut unreduced = base.clone();
    unreduced["parts"][0]["measures"][0]["startBeat"] = serde_json::json!({"numerator": 2, "denominator": 4});
    assert!(issue_codes(&unreduced).contains(&"invalid_rational".to_string()));

    // Duplicate measure ordinal / non-consecutive ordinals.
    let mut duplicated_ordinal = base.clone();
    duplicated_ordinal["parts"][0]["measures"].as_array_mut().unwrap()[0]["ordinal"] = Value::from(1);
    let mut single = duplicated_ordinal;
    single["parts"][0]["measures"] = Value::Array(vec![
        single["parts"][0]["measures"][0].clone(),
        single["parts"][0]["measures"][0].clone(),
    ]);
    single["parts"][0]["measures"].as_array_mut().unwrap()[1]["ordinal"] = Value::from(1);
    assert!(issue_codes(&single).contains(&"duplicate_ordinal".to_string()));
    let _ = duplicated_ordinal;

    // source_measure_mismatch: the event claims the wrong measure.
    let mut mismatch = base.clone();
    mismatch["parts"][0]["measures"][0]["events"][0]["source"]["measureOrdinal"] = Value::from(2);
    assert!(issue_codes(&mismatch).contains(&"source_measure_mismatch".to_string()));

    // Duplicate event id.
    let mut duplicate_event = base.clone();
    let events = duplicate_event["parts"][0]["measures"][0]["events"].as_array_mut().unwrap();
    events.push(events[0].clone());
    assert!(issue_codes(&duplicate_event).contains(&"duplicate_event_id".to_string()));

    // Duplicate xml id.
    let mut duplicate_xml = base.clone();
    duplicate_xml["parts"][0]["measures"][0]["events"][0]["source"]["xmlId"] = Value::String("n1".into());
    let events = duplicate_xml["parts"][0]["measures"][0]["events"].as_array_mut().unwrap();
    if events.len() < 2 {
        events.push(events[0].clone());
    }
    events[1]["source"]["xmlId"] = Value::String("n1".into());
    assert!(issue_codes(&duplicate_xml).contains(&"duplicate_xml_id".to_string()));

    // Duplicate source locator.
    let mut duplicate_locator = base.clone();
    let events = duplicate_locator["parts"][0]["measures"][0]["events"].as_array_mut().unwrap();
    if events.len() < 2 {
        events.push(events[0].clone());
    }
    events[1]["source"]["sourceOrdinal"] = Value::from(1);
    assert!(issue_codes(&duplicate_locator).contains(&"duplicate_source_locator".to_string()));

    // Revision id formula: a tampered stamp is an identity forgery.
    let mut forged = base.clone();
    forged["scoreRevisionId"] = Value::String(format!(
        "score-revision-v1:sha256:{}", "0".repeat(64)
    ));
    assert!(issue_codes(&forged).contains(&"revision_id_mismatch".to_string()));

    // Tie spans: dangling reference and bidirectional mismatch.
    let mut dangling = base.clone();
    dangling["tieSpans"] = serde_json::json!([
        { "id": "tie:1", "pitchKey": "60", "eventIds": ["fix:m1:e1", "ghost"],
          "startBeat": {"numerator": 0, "denominator": 1},
          "endBeat": {"numerator": 1, "denominator": 1} }
    ]);
    let codes = issue_codes(&dangling);
    assert!(codes.contains(&"dangling_reference".to_string()), "codes: {codes:?}");

    let mut mismatched = base.clone();
    mismatched["parts"][0]["measures"][0]["events"][0]["tieSpanId"] = Value::String("tie:1".into());
    mismatched["tieSpans"] = serde_json::json!([
        { "id": "tie:1", "pitchKey": "60", "eventIds": ["other:event"],
          "startBeat": {"numerator": 0, "denominator": 1},
          "endBeat": {"numerator": 1, "denominator": 1} }
    ]);
    let codes = issue_codes(&mismatched);
    assert!(codes.contains(&"tie_reference_mismatch".to_string()), "codes: {codes:?}");
}

#[test]
fn payload_negative_matrix_reports_frozen_codes() {
    let fixture = load_fixture();
    let mut payload = serde_json::json!({
        "fingerprintSchemaVersion": 1,
        "plannerVersion": "parity-harness-1",
        "scoreRevisionId": fixture["document"]["scoreRevisionId"],
        "normalizerVersion": "normalizer-1",
        "supportProfileVersion": "musicxml-v1.0",
        "scope": {
            "partId": "P1",
            "range": { "startMeasureOrdinal": 1, "endMeasureOrdinal": 1 },
            "hand": "both",
            "handMapping": {
                "schemaVersion": 1, "mappingVersion": "hand-mapping-1", "source": "user",
                "parts": [{ "partId": "P1", "staves": [{ "staffNumber": 1, "hand": "right" }] }]
            }
        },
        "repeatSelection": { "kind": "none" },
        "tempo": {
            "bpm": { "numerator": 80, "denominator": 1 },
            "ticksPerQuarter": 960,
            "countInBeats": { "numerator": 4, "denominator": 1 },
            "timeOrigin": "playback-start"
        },
        "targetGroups": [{
            "groupIndex": 0, "passIndex": 0, "bar": 1,
            "onsetBeatFromRangeStart": { "numerator": 0, "denominator": 1 },
            "durationBeat": { "numerator": 1, "denominator": 1 },
            "beatInMeasure": { "numerator": 0, "denominator": 1 },
            "staffNumbers": [1], "voiceIds": ["1"],
            "members": [{
                "sourceLocator": { "partId": "P1", "measureOrdinal": 1, "sourceOrdinal": 1, "voiceId": "1" },
                "pitch": { "midiNote": 60, "spelling": "C4" },
                "durationBeat": { "numerator": 1, "denominator": 1 }, "isTieOnset": false
            }]
        }]
    });

    fn codes(value: &Value) -> Vec<String> {
        validate_plan_fingerprint_payload_v1(value)
            .into_iter()
            .map(|issue| issue.code)
            .collect()
    }
    let ok = codes(&payload);
    assert!(ok.is_empty(), "baseline payload must validate cleanly: {ok:?}");

    // empty_plan
    let mut empty = payload.clone();
    empty["targetGroups"] = Value::Array(vec![]);
    assert!(codes(&empty).contains(&"empty_plan".to_string()));

    // group_index_out_of_sequence
    let mut out_of_sequence = payload.clone();
    out_of_sequence["targetGroups"][0]["groupIndex"] = Value::from(3);
    assert!(codes(&out_of_sequence).contains(&"group_index_out_of_sequence".to_string()));

    // group_duration_mismatch: group longer than its only member.
    let mut mismatch = payload.clone();
    mismatch["targetGroups"][0]["durationBeat"] = serde_json::json!({"numerator": 4, "denominator": 1});
    assert!(codes(&mismatch).contains(&"group_duration_mismatch".to_string()));

    // hand_mapping_conflict: one staff listed twice with different hands.
    let mut conflict = payload.clone();
    conflict["scope"]["handMapping"]["parts"][0]["staves"] = serde_json::json!([
        { "staffNumber": 1, "hand": "right" }, { "staffNumber": 1, "hand": "left" }
    ]);
    assert!(codes(&conflict).contains(&"hand_mapping_conflict".to_string()));

    // duplicate member locator.
    let mut duplicate_locator = payload.clone();
    let members = duplicate_locator["targetGroups"][0]["members"].as_array_mut().unwrap();
    members.push(members[0].clone());
    assert!(codes(&duplicate_locator).contains(&"duplicate_member_locator".to_string()));

    // invalid pitch domain.
    let mut bad_pitch = payload.clone();
    bad_pitch["targetGroups"][0]["members"][0]["pitch"]["midiNote"] = Value::from(200);
    assert!(codes(&bad_pitch).contains(&"invalid_member".to_string()));

    // repeatSelection carrying a count on none.
    let mut none_with_count = payload.clone();
    none_with_count["repeatSelection"] = serde_json::json!({ "kind": "none", "count": 2 });
    assert!(codes(&none_with_count).contains(&"unexpected_field".to_string()));
}

#[test]
fn gate_rejects_invalid_documents_before_hashing() {
    let fixture = load_fixture();

    // A tampered document (non-reduced rational) cannot pass the gate.
    let mut tampered = fixture["document"].clone();
    tampered["parts"][0]["measures"][0]["startBeat"] =
        serde_json::json!({"numerator": 2, "denominator": 4});
    let error = plan_fingerprint_v1_gate(
        &tampered,
        &fixture["report"],
        &fixture["plannerOutput"],
        &fixture["config"],
    )
    .expect_err("tampered document must be rejected");
    assert_eq!(error.code, "DOCUMENT_VALIDATION_FAILED");

    // A plan bound to a different score cannot pass.
    let mut foreign_plan = fixture["plannerOutput"].clone();
    foreign_plan["scoreFingerprint"] = Value::String("b".repeat(64));
    let error = plan_fingerprint_v1_gate(
        &fixture["document"],
        &fixture["report"],
        &foreign_plan,
        &fixture["config"],
    )
    .expect_err("foreign plan must be rejected");
    assert_eq!(error.code, "PLAN_DOCUMENT_MISMATCH");

    // A plan missing its scoreFingerprint cannot pass either.
    let mut anonymous_plan = fixture["plannerOutput"].clone();
    anonymous_plan.as_object_mut().unwrap().remove("scoreFingerprint");
    let error = plan_fingerprint_v1_gate(
        &fixture["document"],
        &fixture["report"],
        &anonymous_plan,
        &fixture["config"],
    )
    .expect_err("anonymous plan must be rejected");
    assert_eq!(error.code, "PLAN_DOCUMENT_MISMATCH");
}

#[test]
fn config_boundary_stays_wired_into_the_contract_layer() {
    // a2's config boundary remains reachable from the contract layer (the
    // gate consumes the validated shape); spot-check the parser is still
    // exported and rejects an unknown field.
    let invalid = r#"{ "unexpected": true }"#;
    let error = parse_plan_request_config(invalid).expect_err("unknown config must fail");
    assert_eq!(error.code, "SCHEMA_VIOLATION");
}


#[test]
fn rust_payload_matches_the_ts_built_payload_object() {
    let fixture = load_fixture();
    let config = parse_plan_request_config(&fixture["config"].to_string()).expect("fixture config");
    let score_revision_id = fixture["document"]["scoreRevisionId"].as_str().expect("revision");
    let payload = build_payload(
        fixture["plannerOutput"].as_object().expect("plan object"),
        serde_json::to_value(&config).unwrap().as_object().expect("config object"),
        score_revision_id,
    )
    .expect("payload builds");
    assert_eq!(
        &payload,
        &fixture["tsPayload"],
        "Rust payload must equal the TS-built payload object"
    );
}


// ---- Fifth-follow-up: projection fail-open closure + locator voiceId ----

fn payload_codes(value: &Value) -> Vec<String> {
    validate_plan_fingerprint_payload_v1(value).into_iter().map(|issue| issue.code).collect()
}

#[test]
fn gate_rejects_missing_or_mistyped_capabilities() {
    let fixture = load_fixture();

    // document.capabilities removed.
    let mut no_caps = fixture["document"].clone();
    no_caps.as_object_mut().unwrap().remove("capabilities");
    let error = plan_fingerprint_v1_gate(
        &no_caps, &fixture["report"], &fixture["plannerOutput"], &fixture["config"],
    )
    .expect_err("missing document capabilities must fail closed");
    assert_eq!(error.code, "UNKNOWN_CAPABILITY");

    // document.capabilities wrong type.
    let mut bad_type = fixture["document"].clone();
    bad_type["capabilities"] = Value::String("chords".into());
    let error = plan_fingerprint_v1_gate(
        &bad_type, &fixture["report"], &fixture["plannerOutput"], &fixture["config"],
    )
    .expect_err("mistyped document capabilities must fail closed");
    assert_eq!(error.code, "UNKNOWN_CAPABILITY");

    // report.capabilities removed and mistyped.
    let mut no_report_caps = fixture["report"].clone();
    no_report_caps.as_object_mut().unwrap().remove("capabilities");
    let error = plan_fingerprint_v1_gate(
        &fixture["document"], &no_report_caps, &fixture["plannerOutput"], &fixture["config"],
    )
    .expect_err("missing report capabilities must fail closed");
    assert_eq!(error.code, "UNKNOWN_CAPABILITY");

    let mut bad_report_caps = fixture["report"].clone();
    bad_report_caps["capabilities"] = Value::from(7);
    let error = plan_fingerprint_v1_gate(
        &fixture["document"], &bad_report_caps, &fixture["plannerOutput"], &fixture["config"],
    )
    .expect_err("mistyped report capabilities must fail closed");
    assert_eq!(error.code, "UNKNOWN_CAPABILITY");
}

#[test]
fn schema_tier_gaps_are_reported_by_the_validator() {
    let fixture = load_fixture();
    let base = fixture["document"].clone();
    fn codes(value: &Value) -> Vec<String> {
        validate_score_document_v1(value).into_iter().map(|i| i.code).collect()
    }

    // measure.attributes missing entirely.
    let mut no_attributes = base.clone();
    no_attributes["parts"][0]["measures"][0].as_object_mut().unwrap().remove("attributes");
    let attributes_codes = codes(&no_attributes);
    assert!(attributes_codes.contains(&"missing_field".to_string()), "codes: {attributes_codes:?}");

    // attributes missing divisions.
    let mut no_divisions = base.clone();
    no_divisions["parts"][0]["measures"][0]["attributes"]
        .as_object_mut().unwrap().remove("divisions");
    assert!(codes(&no_divisions).contains(&"missing_field".to_string()));

    // divisions out of range (schema tier: minimum 1).
    let mut zero_divisions = base.clone();
    zero_divisions["parts"][0]["measures"][0]["attributes"]["divisions"] = Value::from(0);
    assert!(codes(&zero_divisions).contains(&"schema_violation".to_string()));

    // time missing beatType.
    let mut no_beat_type = base.clone();
    no_beat_type["parts"][0]["measures"][0]["attributes"]["time"]
        .as_object_mut().unwrap().remove("beatType");
    assert!(codes(&no_beat_type).contains(&"missing_field".to_string()));

    // key.fifths out of the frozen -7..=7 range.
    let mut bad_fifths = base.clone();
    bad_fifths["parts"][0]["measures"][0]["attributes"]["key"]["fifths"] = Value::from(8);
    assert!(codes(&bad_fifths).contains(&"schema_violation".to_string()));

    // clef missing sign.
    let mut no_sign = base.clone();
    no_sign["parts"][0]["measures"][0]["attributes"]["clefs"][0]
        .as_object_mut().unwrap().remove("sign");
    assert!(codes(&no_sign).contains(&"missing_field".to_string()));

    // barline repeat with an unknown direction.
    let mut bad_direction = base.clone();
    bad_direction["parts"][0]["measures"][0]["barlines"] = serde_json::json!([
        { "repeat": { "direction": "sideways" } }
    ]);
    assert!(codes(&bad_direction).contains(&"schema_violation".to_string()));

    // barline ending with an unknown type.
    let mut bad_ending = base.clone();
    bad_ending["parts"][0]["measures"][0]["barlines"] = serde_json::json!([
        { "ending": { "type": "pause" } }
    ]);
    assert!(codes(&bad_ending).contains(&"schema_violation".to_string()));

    // A1/A2 fixes must not disturb the legal fixture.
    let base_codes = codes(&base);
    assert!(base_codes.is_empty(), "legal fixture must stay clean: {base_codes:?}");
}

// A3: payload member locator identity includes voiceId — same
// partId/measureOrdinal/sourceOrdinal with a different voiceId is a
// DIFFERENT member (TS locatorKey uses voiceId ?? '').
#[test]
fn payload_locator_identity_includes_voice_id() {
    let member = |voice: &str| serde_json::json!({
        "sourceLocator": { "partId": "P1", "measureOrdinal": 1, "sourceOrdinal": 1, "voiceId": voice },
        "pitch": { "midiNote": 60, "spelling": "C4" },
        "durationBeat": { "numerator": 1, "denominator": 1 }
    });
    let payload_for = |members: Value| serde_json::json!({
        "fingerprintSchemaVersion": 1,
        "plannerVersion": "parity-harness-1",
        "scoreRevisionId": "score-revision-v1:sha256:3b7309c75e2c549a6b532568fdbe6cf5befc35d60d3bb15f7b2c34585bfa0b3d",
        "normalizerVersion": "normalizer-1",
        "supportProfileVersion": "musicxml-v1.0",
        "scope": {
            "partId": "P1",
            "range": { "startMeasureOrdinal": 1, "endMeasureOrdinal": 1 },
            "hand": "both",
            "handMapping": { "schemaVersion": 1, "mappingVersion": "hand-mapping-1", "source": "user",
                "parts": [{ "partId": "P1", "staves": [{ "staffNumber": 1, "hand": "right" }] }] }
        },
        "repeatSelection": { "kind": "none" },
        "tempo": {
            "bpm": { "numerator": 80, "denominator": 1 }, "ticksPerQuarter": 960,
            "countInBeats": { "numerator": 4, "denominator": 1 }, "timeOrigin": "playback-start"
        },
        "targetGroups": [{
            "groupIndex": 0, "passIndex": 0, "bar": 1,
            "onsetBeatFromRangeStart": { "numerator": 0, "denominator": 1 },
            "durationBeat": { "numerator": 1, "denominator": 1 },
            "beatInMeasure": { "numerator": 0, "denominator": 1 },
            "staffNumbers": [1], "voiceIds": ["1", "2"],
            "members": members
        }]
    });

    // Same full quadruple twice -> duplicate_member_locator.
    let duplicated = serde_json::json!([member("1"), member("1")]);
    let codes: Vec<String> = validate_plan_fingerprint_payload_v1(&payload_for(duplicated))
        .into_iter().map(|issue| issue.code).collect();
    assert!(codes.contains(&"duplicate_member_locator".to_string()), "codes: {codes:?}");

    // Different voiceId only -> the TS locatorKey differs -> NO duplicate.
    let distinct_voices = serde_json::json!([member("1"), member("2")]);
    let codes: Vec<String> = validate_plan_fingerprint_payload_v1(&payload_for(distinct_voices))
        .into_iter().map(|issue| issue.code).collect();
    assert!(!codes.contains(&"duplicate_member_locator".to_string()), "codes: {codes:?}");
}


#[test]
fn barline_optional_fields_are_not_mandatory() {
    let fixture = load_fixture();
    let base = fixture["document"].clone();
    fn codes(value: &Value) -> Vec<String> {
        validate_score_document_v1(value).into_iter().map(|issue| issue.code).collect()
    }
    fn full_issues(value: &Value) -> Vec<rhythm_core::contract_v1::Issue> {
        validate_score_document_v1(value)
    }
    let with_barlines = |barlines: Value| {
        let mut document = base.clone();
        document["parts"][0]["measures"][0]["barlines"] = barlines;
        codes(&document)
    };

    // Empty barline object: everything optional, all legal.
    assert!(with_barlines(serde_json::json!([])).is_empty());
    let codes_empty_object = with_barlines(serde_json::json!([{}]));
    assert!(codes_empty_object.is_empty());

    // Only location.
    assert!(with_barlines(serde_json::json!([{ "location": "left" }])).is_empty());

    // Only a legal repeat direction.
    let repeat_codes = with_barlines(serde_json::json!([
        { "repeat": { "direction": "forward" } }
    ]));
    if !repeat_codes.is_empty() {
        println!("DEBUG full issues: {:?}", full_issues(&{
            let mut document = base.clone();
            document["parts"][0]["measures"][0]["barlines"] = serde_json::json!([
                { "repeat": { "direction": "forward" } }
            ]);
            document
        }));
    }
    assert!(repeat_codes.is_empty());
    assert!(with_barlines(serde_json::json!([
        { "repeat": { "direction": "backward", "times": 2, "afterJump": true } }
    ])).is_empty());

    // Only a legal ending type.
    assert!(with_barlines(serde_json::json!([
        { "ending": { "type": "discontinue" } }
    ])).is_empty());

    // Optional-but-present fields still enforce their types/ranges.
    let codes = with_barlines(serde_json::json!([
        { "repeat": { "direction": "forward", "times": 0 } }
    ]));
    assert!(codes.iter().any(|code| code == "schema_violation"), "times=0 must fail");
    assert!(with_barlines(serde_json::json!([
        { "ending": { "type": "discontinue", "number": 5 } }
    ]))
    .iter()
    .any(|code| code == "schema_violation"), "numeric ending.number must fail");
}


// ---- Sixth-round follow-up: None vs Some(Null) semantics, required-key
// ---- completeness, locator voiceId typing ----

#[test]
fn part_name_and_tempo_ordinal_are_required() {
    let fixture = load_fixture();
    let base = fixture["document"].clone();
    fn document_codes(value: &Value) -> Vec<String> {
        validate_score_document_v1(value).into_iter().map(|issue| issue.code).collect()
    }

    // parts[0].name removed -> missing_field.
    let mut no_name = base.clone();
    no_name["parts"][0].as_object_mut().unwrap().remove("name");
    assert!(document_codes(&no_name).contains(&"missing_field".to_string()));

    // parts[0].name = null -> schema_violation (null is NOT the same as absent).
    let mut null_name = base.clone();
    null_name["parts"][0]["name"] = Value::Null;
    assert!(document_codes(&null_name).contains(&"schema_violation".to_string()));

    // tempoMark negatives: inject a tempoMark first (the TS-projected fixture
    // has none), then break measureOrdinal in both the missing and null forms.
    let mut with_mark = base.clone();
    with_mark["tempoMarks"] = serde_json::json!([
        { "measureOrdinal": 1, "beat": {"numerator": 0, "denominator": 1},
          "bpm": {"numerator": 80, "denominator": 1}, "kind": "metronome" }
    ]);
    let mut no_ordinal = with_mark.clone();
    no_ordinal["tempoMarks"][0].as_object_mut().unwrap().remove("measureOrdinal");
    assert!(document_codes(&no_ordinal).contains(&"missing_field".to_string()));

    let mut null_ordinal = with_mark.clone();
    null_ordinal["tempoMarks"][0]["measureOrdinal"] = Value::Null;
    assert!(document_codes(&null_ordinal).contains(&"schema_violation".to_string()));
}

#[test]
fn event_nested_required_fields_are_enforced() {
    let fixture = load_fixture();
    let base = fixture["document"].clone();
    fn document_codes(value: &Value) -> Vec<String> {
        validate_score_document_v1(value).into_iter().map(|issue| issue.code).collect()
    }
    let with_event = |patch: Value| {
        let mut document = base.clone();
        let event = document["parts"][0]["measures"][0]["events"][0].as_object_mut().unwrap();
        if let Value::Object(patch) = patch {
            for (key, value) in patch {
                event.insert(key, value);
            }
        }
        document_codes(&document)
    };
    let remove_key = |key: &str| {
        let mut document = base.clone();
        document["parts"][0]["measures"][0]["events"][0]
            .as_object_mut().unwrap().remove(key);
        document_codes(&document)
    };

    // event.dots as a string -> schema_violation.
    assert!(with_event(serde_json::json!({ "dots": "three" }))
        .contains(&"schema_violation".to_string()));
    // dots removed -> missing_field.
    assert!(remove_key("dots").contains(&"missing_field".to_string()));

    // tieStart as a string -> schema_violation.
    assert!(with_event(serde_json::json!({ "tieStart": "yes" }))
        .contains(&"schema_violation".to_string()));

    // articulations with a non-string item -> schema_violation.
    assert!(with_event(serde_json::json!({ "articulations": [1, 2] }))
        .contains(&"schema_violation".to_string()));

    // pitch fields: missing alter -> missing_field; step enum violation;
    // octave out of range; midiNote out of domain; spelling empty.
    assert!(with_event(serde_json::json!({
        "pitch": { "step": "C", "octave": 4, "midiNote": 60, "spelling": "C4" }
    })).contains(&"missing_field".to_string()));
    assert!(with_event(serde_json::json!({
        "pitch": { "step": "H", "alter": {"numerator":0,"denominator":1}, "octave": 4,
                   "midiNote": 60, "spelling": "C4" }
    })).contains(&"schema_violation".to_string()));
    assert!(with_event(serde_json::json!({
        "pitch": { "step": "C", "alter": {"numerator":0,"denominator":1}, "octave": 11,
                   "midiNote": 60, "spelling": "C4" }
    })).contains(&"schema_violation".to_string()));
    assert!(with_event(serde_json::json!({
        "pitch": { "step": "C", "alter": {"numerator":0,"denominator":1}, "octave": 4,
                   "midiNote": 200, "spelling": "C4" }
    })).contains(&"schema_violation".to_string()));
    assert!(with_event(serde_json::json!({
        "pitch": { "step": "C", "alter": {"numerator":0,"denominator":1}, "octave": 4,
                   "midiNote": 60, "spelling": "" }
    })).contains(&"schema_violation".to_string()));

    // timeModification missing a required field -> missing_field.
    assert!(with_event(serde_json::json!({
        "timeModification": { "actualNotes": 3 }
    })).contains(&"missing_field".to_string()));

    // SourceRefV1: voiceId present but numeric -> schema_violation.
    assert!(with_event(serde_json::json!({
        "source": { "partId": "P1", "measureOrdinal": 1, "staffNumber": 1,
                    "sourceOrdinal": 1, "voiceId": 7 }
    })).contains(&"schema_violation".to_string()));

    // A fully legal event variant still passes.
    assert!(with_event(serde_json::json!({
        "notatedType": "quarter",
        "chordGroupId": "chord:1",
        "lyricText": "la"
    })).iter().all(|code| code != "schema_violation" && code != "missing_field"));
}

#[test]
fn gate_payload_missing_member_fields_are_rejected() {
    let fixture = load_fixture();
    // A PlannerOutput whose member omits sourceLocator and pitch must be
    // rejected by the gate (payload construction produces an invalid member).
    let mut plan = fixture["plannerOutput"].clone();
    for occurrence in plan["occurrences"].as_array_mut().unwrap() {
        occurrence.as_object_mut().unwrap().remove("locator");
        occurrence.as_object_mut().unwrap().remove("pitch");
    }
    let error = plan_fingerprint_v1_gate(
        &fixture["document"], &fixture["report"], &plan, &fixture["config"],
    )
    .expect_err("members without locator/pitch must fail closed");
    assert_eq!(error.code, "PAYLOAD_VALIDATION_FAILED");
}


// ---- Seventh-round follow-up: TieSpan id/eventIds typing, document-level
// ---- sections out of the per-part loop, payload required/allowed split,
// ---- handMapping completeness, TargetGroup required fields + arrays ----

fn document_codes_of(value: &Value) -> Vec<String> {
    validate_score_document_v1(value).into_iter().map(|issue| issue.code).collect()
}

fn payload_codes_of(value: &Value) -> Vec<String> {
    validate_plan_fingerprint_payload_v1(value).into_iter().map(|issue| issue.code).collect()
}

/// The legal TieSpanV1 shape used by the positives below. `eventIds` must
/// name events that actually exist in the document under test.
fn legal_tie_span(first: &str, second: &str) -> Value {
    serde_json::json!([
        { "id": "tie:1", "pitchKey": "60:1", "eventIds": [first, second],
          "startBeat": { "numerator": 0, "denominator": 1 },
          "endBeat": { "numerator": 1, "denominator": 1 } }
    ])
}

/// A two-part document whose tie span joins one event from EACH part. Under
/// the pre-fix layout (document-level sections nested inside the per-part
/// loop) the P2 events were not yet registered when tieSpans was checked
/// after P1, so this legal document reported a spurious dangling_reference.
fn two_part_cross_tie_document() -> Value {
    let fixture = load_fixture();
    let mut document = fixture["document"].clone();
    let mut part1 = document["parts"][0].clone();
    // A second P1 event: the tie span itself stays on the two e1 ends.
    let mut second = part1["measures"][0]["events"][0].clone();
    second["eventId"] = Value::String("fix:m1:e2".into());
    second["source"]["sourceOrdinal"] = Value::from(2);
    part1["measures"][0]["events"].as_array_mut().unwrap().push(second);
    let first = part1["measures"][0]["events"][0].as_object_mut().unwrap();
    first.insert("tieStart".into(), Value::Bool(true));
    first.insert("tieStop".into(), Value::Bool(true));
    first.insert("tieSpanId".into(), Value::String("tie:1".into()));

    // P2 = a renamed deep copy of P1: new partId, renamed eventIds.
    let mut part2 = part1.clone();
    part2["partId"] = Value::String("P2".into());
    part2["name"] = Value::String("Piano 2".into());
    for measure in part2["measures"].as_array_mut().unwrap() {
        for event in measure["events"].as_array_mut().unwrap() {
            let renamed = event["eventId"].as_str().unwrap().replace("fix:", "fix2:");
            event["eventId"] = Value::String(renamed);
            event["source"]["partId"] = Value::String("P2".into());
        }
    }
    let p2_first = part2["measures"][0]["events"][0].as_object_mut().unwrap();
    p2_first.insert("tieStart".into(), Value::Bool(true));
    p2_first.insert("tieStop".into(), Value::Bool(true));
    p2_first.insert("tieSpanId".into(), Value::String("tie:1".into()));

    document["parts"] = Value::Array(vec![part1, part2]);
    document["tieSpans"] = legal_tie_span("fix:m1:e1", "fix2:m1:e1");
    document
}

#[test]
fn tie_span_id_requires_a_non_empty_string() {
    let fixture = load_fixture();
    let base = fixture["document"].clone();
    // Two real events so eventIds reference legality never muddies the id
    // assertions below.
    let mut two_events = base.clone();
    let mut second = two_events["parts"][0]["measures"][0]["events"][0].clone();
    second["eventId"] = Value::String("fix:m1:e2".into());
    second["source"]["sourceOrdinal"] = Value::from(2);
    two_events["parts"][0]["measures"][0]["events"]
        .as_array_mut().unwrap().push(second);

    // Positive: a fully legal tie span still validates clean.
    two_events["tieSpans"] = legal_tie_span("fix:m1:e1", "fix:m1:e2");
    let codes = document_codes_of(&two_events);
    assert!(codes.is_empty(), "legal tie span must stay clean: {codes:?}");

    // Negative: numeric id — previously SILENTLY accepted.
    let mut numeric = two_events.clone();
    numeric["tieSpans"][0]["id"] = Value::from(5);
    let codes = document_codes_of(&numeric);
    assert!(codes.contains(&"schema_violation".to_string()), "codes: {codes:?}");

    // Negative: empty-string id — previously silently accepted.
    let mut empty_id = two_events.clone();
    empty_id["tieSpans"][0]["id"] = Value::String(String::new());
    let codes = document_codes_of(&empty_id);
    assert!(codes.contains(&"schema_violation".to_string()), "codes: {codes:?}");

    // Negative: missing id (required by the frozen schema).
    let mut missing = two_events.clone();
    missing["tieSpans"][0].as_object_mut().unwrap().remove("id");
    let codes = document_codes_of(&missing);
    assert!(codes.contains(&"missing_field".to_string()), "codes: {codes:?}");
}

#[test]
fn tie_span_event_ids_items_are_typed_and_checked() {
    let fixture = load_fixture();
    let base = fixture["document"].clone();

    // Negative: a non-string element is NEVER silently skipped — it violates
    // the item schema and cannot name a known event.
    let mut numeric_member = base.clone();
    numeric_member["tieSpans"] = serde_json::json!([
        { "id": "tie:1", "pitchKey": "60", "eventIds": ["fix:m1:e1", 5],
          "startBeat": {"numerator": 0, "denominator": 1},
          "endBeat": {"numerator": 1, "denominator": 1} }
    ]);
    let codes = document_codes_of(&numeric_member);
    assert!(codes.contains(&"schema_violation".to_string()), "codes: {codes:?}");
    assert!(codes.contains(&"dangling_reference".to_string()), "codes: {codes:?}");

    // Negative: an empty-string element violates the item minLength.
    let mut empty_member = base.clone();
    empty_member["tieSpans"] = serde_json::json!([
        { "id": "tie:1", "pitchKey": "60", "eventIds": ["fix:m1:e1", ""],
          "startBeat": {"numerator": 0, "denominator": 1},
          "endBeat": {"numerator": 1, "denominator": 1} }
    ]);
    let codes = document_codes_of(&empty_member);
    assert!(codes.contains(&"schema_violation".to_string()), "codes: {codes:?}");

    // Negative: fewer than two elements.
    let mut single = base.clone();
    single["tieSpans"] = serde_json::json!([
        { "id": "tie:1", "pitchKey": "60", "eventIds": ["fix:m1:e1"],
          "startBeat": {"numerator": 0, "denominator": 1},
          "endBeat": {"numerator": 1, "denominator": 1} }
    ]);
    assert!(document_codes_of(&single).contains(&"invalid_tie_span".to_string()));
}

#[test]
fn document_level_sections_run_once_after_all_parts() {
    // Positive: a cross-part tie (P1 event + P2 event in one span, both ends
    // claiming it back) validates CLEAN. This is the structural pin: with the
    // tieSpans section nested in the per-part loop it produced a spurious
    // dangling_reference for the not-yet-registered P2 event.
    let cross_tie = two_part_cross_tie_document();
    let codes = document_codes_of(&cross_tie);
    assert!(codes.is_empty(), "cross-part tie document must be clean: {codes:?}");

    // Positive: parts=[] is schema-legal on its own.
    let fixture = load_fixture();
    let mut emptied = fixture["document"].clone();
    emptied["parts"] = Value::Array(vec![]);
    let codes = document_codes_of(&emptied);
    assert!(codes.is_empty(), "empty parts must stay clean: {codes:?}");

    // Negative discriminator: with parts=[] a TAMPERED tieSpan must still be
    // rejected. Pre-fix, the tieSpans section lived inside the per-part loop
    // and an empty parts array skipped it entirely — a silent fail-open.
    emptied["tieSpans"] = serde_json::json!([
        { "id": "tie:ghost", "pitchKey": "60", "eventIds": ["ghost1", "ghost2"],
          "startBeat": {"numerator": 0, "denominator": 1},
          "endBeat": {"numerator": 1, "denominator": 1} }
    ]);
    let codes = document_codes_of(&emptied);
    assert!(
        codes.iter().filter(|code| *code == "dangling_reference").count() >= 1,
        "tampered tieSpan with parts=[] must be reported: {codes:?}"
    );
}

#[test]
fn gate_rejects_tampered_tie_spans() {
    let fixture = load_fixture();

    // A numeric tieSpan id cannot reach a fingerprint through the gate.
    let mut numeric_id = fixture["document"].clone();
    numeric_id["tieSpans"] = serde_json::json!([
        { "id": 5, "pitchKey": "60", "eventIds": ["fix:m1:e1", "fix:m1:e1"],
          "startBeat": {"numerator": 0, "denominator": 1},
          "endBeat": {"numerator": 1, "denominator": 1} }
    ]);
    let error = plan_fingerprint_v1_gate(
        &numeric_id, &fixture["report"], &fixture["plannerOutput"], &fixture["config"],
    )
    .expect_err("numeric tieSpan id must fail closed");
    assert_eq!(error.code, "DOCUMENT_VALIDATION_FAILED");

    // parts=[] + tampered tieSpan: pre-fix the section never ran for an empty
    // parts array; the formal gate must still reject.
    let mut emptied = fixture["document"].clone();
    emptied["parts"] = Value::Array(vec![]);
    emptied["tieSpans"] = serde_json::json!([
        { "id": "tie:ghost", "pitchKey": "60", "eventIds": ["ghost1", "ghost2"],
          "startBeat": {"numerator": 0, "denominator": 1},
          "endBeat": {"numerator": 1, "denominator": 1} }
    ]);
    let error = plan_fingerprint_v1_gate(
        &emptied, &fixture["report"], &fixture["plannerOutput"], &fixture["config"],
    )
    .expect_err("tampered tieSpan with parts=[] must fail closed");
    assert_eq!(error.code, "DOCUMENT_VALIDATION_FAILED");
}

fn baseline_payload() -> Value {
    let fixture = load_fixture();
    serde_json::json!({
        "fingerprintSchemaVersion": 1,
        "plannerVersion": "parity-harness-1",
        "scoreRevisionId": fixture["document"]["scoreRevisionId"],
        "normalizerVersion": "normalizer-1",
        "supportProfileVersion": "musicxml-v1.0",
        "scope": {
            "partId": "P1",
            "range": { "startMeasureOrdinal": 1, "endMeasureOrdinal": 1 },
            "hand": "both",
            "handMapping": { "schemaVersion": 1, "mappingVersion": "hand-mapping-1",
                "source": "user",
                "parts": [{ "partId": "P1", "staves": [{ "staffNumber": 1, "hand": "right" }] }] }
        },
        "repeatSelection": { "kind": "none" },
        "tempo": {
            "bpm": { "numerator": 80, "denominator": 1 }, "ticksPerQuarter": 960,
            "countInBeats": { "numerator": 4, "denominator": 1 },
            "timeOrigin": "playback-start"
        },
        "targetGroups": [{
            "groupIndex": 0, "passIndex": 0, "bar": 1,
            "onsetBeatFromRangeStart": { "numerator": 0, "denominator": 1 },
            "durationBeat": { "numerator": 1, "denominator": 1 },
            "beatInMeasure": { "numerator": 0, "denominator": 1 },
            "staffNumbers": [1], "voiceIds": ["1"],
            "members": [{
                "sourceLocator": { "partId": "P1", "measureOrdinal": 1,
                    "sourceOrdinal": 1, "voiceId": "1" },
                "pitch": { "midiNote": 60, "spelling": "C4" },
                "durationBeat": { "numerator": 1, "denominator": 1 },
                "isTieOnset": false
            }]
        }]
    })
}

#[test]
fn repeat_selection_is_optional_and_rationals_are_closed() {
    // Positive discriminator: repeatSelection ABSENT must validate clean.
    // Pre-fix the root required list wrongly included it (allowed == required).
    let mut optional = baseline_payload();
    optional.as_object_mut().unwrap().remove("repeatSelection");
    let codes = payload_codes_of(&optional);
    assert!(codes.is_empty(), "absent repeatSelection must be legal: {codes:?}");

    // Negative: RationalV1 is a CLOSED object — an extra key is reported.
    let mut extra_bpm_key = baseline_payload();
    extra_bpm_key["tempo"]["bpm"]["approx"] = Value::from(0.5);
    let codes = payload_codes_of(&extra_bpm_key);
    assert!(codes.contains(&"unexpected_field".to_string()), "codes: {codes:?}");

    let mut extra_count_in = baseline_payload();
    extra_count_in["tempo"]["countInBeats"]["hint"] = Value::String("4".into());
    assert!(payload_codes_of(&extra_count_in).contains(&"unexpected_field".to_string()));

    // Positive: the baseline (closed rationals) stays clean.
    let codes = payload_codes_of(&baseline_payload());
    assert!(codes.is_empty(), "baseline payload must validate cleanly: {codes:?}");
}

#[test]
fn hand_mapping_completeness_is_enforced() {
    // Negative: mappingVersion missing (required by the frozen schema).
    let mut no_version = baseline_payload();
    no_version["scope"]["handMapping"].as_object_mut().unwrap().remove("mappingVersion");
    let codes = payload_codes_of(&no_version);
    assert!(codes.contains(&"missing_field".to_string()), "codes: {codes:?}");

    // Negative: mappingVersion present but mistyped / empty.
    let mut numeric_version = baseline_payload();
    numeric_version["scope"]["handMapping"]["mappingVersion"] = Value::from(7);
    let codes = payload_codes_of(&numeric_version);
    assert!(codes.contains(&"schema_violation".to_string()), "codes: {codes:?}");

    let mut empty_version = baseline_payload();
    empty_version["scope"]["handMapping"]["mappingVersion"] = Value::String(String::new());
    assert!(payload_codes_of(&empty_version).contains(&"schema_violation".to_string()));

    // Negative: a mapping part carries an extra field (additionalProperties).
    let mut extra_part_field = baseline_payload();
    extra_part_field["scope"]["handMapping"]["parts"][0]["label"] = Value::String("top".into());
    let codes = payload_codes_of(&extra_part_field);
    assert!(codes.contains(&"unexpected_field".to_string()), "codes: {codes:?}");

    // Negative: a staff entry carries an extra field.
    let mut extra_staff_field = baseline_payload();
    extra_staff_field["scope"]["handMapping"]["parts"][0]["staves"][0]["brackets"] = Value::Bool(true);
    assert!(payload_codes_of(&extra_staff_field).contains(&"unexpected_field".to_string()));

    // Positive: the complete legal mapping stays clean.
    let codes = payload_codes_of(&baseline_payload());
    assert!(codes.is_empty(), "legal handMapping must stay clean: {codes:?}");
}

#[test]
fn target_group_required_fields_and_member_arrays_are_enforced() {
    let with_group = |patch: &dyn Fn(&mut Value)| {
        let mut payload = baseline_payload();
        patch(&mut payload);
        payload_codes_of(&payload)
    };

    // passIndex: required, integer >= 0.
    let codes = with_group(&|payload| {
        payload["targetGroups"][0].as_object_mut().unwrap().remove("passIndex");
    });
    assert!(codes.contains(&"invalid_integer".to_string()), "codes: {codes:?}");
    let codes = with_group(&|payload| {
        payload["targetGroups"][0]["passIndex"] = Value::from(-1);
    });
    assert!(codes.contains(&"invalid_integer".to_string()), "codes: {codes:?}");

    // bar: required, integer >= 1.
    let codes = with_group(&|payload| {
        payload["targetGroups"][0].as_object_mut().unwrap().remove("bar");
    });
    assert!(codes.contains(&"invalid_integer".to_string()), "codes: {codes:?}");
    let codes = with_group(&|payload| {
        payload["targetGroups"][0]["bar"] = Value::from(0);
    });
    assert!(codes.contains(&"invalid_integer".to_string()), "codes: {codes:?}");

    // staffNumbers: non-empty array of integers >= 1.
    let codes = with_group(&|payload| {
        payload["targetGroups"][0]["staffNumbers"] = Value::Array(vec![]);
    });
    assert!(codes.contains(&"invalid_group".to_string()), "codes: {codes:?}");
    let codes = with_group(&|payload| {
        payload["targetGroups"][0].as_object_mut().unwrap().remove("staffNumbers");
    });
    assert!(codes.contains(&"invalid_group".to_string()), "codes: {codes:?}");
    let codes = with_group(&|payload| {
        payload["targetGroups"][0]["staffNumbers"] = serde_json::json!([0]);
    });
    assert!(codes.contains(&"schema_violation".to_string()), "codes: {codes:?}");
    let codes = with_group(&|payload| {
        payload["targetGroups"][0]["staffNumbers"] = serde_json::json!(["1"]);
    });
    assert!(codes.contains(&"schema_violation".to_string()), "codes: {codes:?}");

    // voiceIds: non-empty array of strings.
    let codes = with_group(&|payload| {
        payload["targetGroups"][0]["voiceIds"] = Value::Array(vec![]);
    });
    assert!(codes.contains(&"invalid_group".to_string()), "codes: {codes:?}");
    let codes = with_group(&|payload| {
        payload["targetGroups"][0].as_object_mut().unwrap().remove("voiceIds");
    });
    assert!(codes.contains(&"invalid_group".to_string()), "codes: {codes:?}");
    let codes = with_group(&|payload| {
        payload["targetGroups"][0]["voiceIds"] = serde_json::json!([1]);
    });
    assert!(codes.contains(&"schema_violation".to_string()), "codes: {codes:?}");

    // Positive: legal staffNumbers/voiceIds (the baseline) stay clean.
    let codes = payload_codes_of(&baseline_payload());
    assert!(codes.is_empty(), "baseline targetGroup must stay clean: {codes:?}");
}

#[test]
fn payload_schema_version_and_revision_pattern_short_circuit() {
    // A wrong fingerprintSchemaVersion short-circuits with exactly one issue
    // (mirrors TS :925-927).
    let mut wrong_version = baseline_payload();
    wrong_version["fingerprintSchemaVersion"] = Value::from(2);
    assert_eq!(payload_codes_of(&wrong_version), vec!["unknown_schema_version".to_string()]);

    // scoreRevisionId must match the frozen revision-id pattern.
    let mut bad_pattern = baseline_payload();
    bad_pattern["scoreRevisionId"] = Value::String("score-revision-v1:sha256:nothex".into());
    assert!(payload_codes_of(&bad_pattern).contains(&"invalid_revision_id".to_string()));

    // A missing scoreRevisionId is both a missing key and a pattern failure
    // (TS behaves identically: typeof undefined is not a pattern match).
    let mut missing_revision = baseline_payload();
    missing_revision.as_object_mut().unwrap().remove("scoreRevisionId");
    let codes = payload_codes_of(&missing_revision);
    assert!(codes.contains(&"missing_field".to_string()), "codes: {codes:?}");
    assert!(codes.contains(&"invalid_revision_id".to_string()), "codes: {codes:?}");
}

#[test]
fn locator_voice_id_absence_and_typing_stay_distinct() {
    // Absent voiceId: legal — the frozen identity key uses voiceId ?? ''.
    let mut absent = baseline_payload();
    absent["targetGroups"][0]["members"][0]["sourceLocator"]
        .as_object_mut().unwrap().remove("voiceId");
    let codes = payload_codes_of(&absent);
    assert!(codes.is_empty(), "absent locator voiceId must stay legal: {codes:?}");

    // Present but non-string voiceId: a violation, never silently ''.
    let mut numeric = baseline_payload();
    numeric["targetGroups"][0]["members"][0]["sourceLocator"]["voiceId"] = Value::from(7);
    let codes = payload_codes_of(&numeric);
    assert!(codes.contains(&"invalid_member".to_string()), "codes: {codes:?}");
}
