//! R2-3a2 acceptance: time conversion (frozen formula incl. bpm.denominator)
//! and the planner config input boundary. Error codes align with TS.

use rhythm_core::contract_v1::{
    beat_to_microseconds, count_in_beats, parse_plan_request_config, target_onset_us, RationalV1,
};

fn rat(n: i64, d: i64) -> RationalV1 {
    RationalV1 { numerator: n, denominator: d }
}

#[test]
fn review_anchor_rational_bpm() {
    let bpm = rat(175, 2);
    assert_eq!(beat_to_microseconds(&rat(1, 1), &bpm).unwrap(), 685_714);
    assert_eq!(beat_to_microseconds(&rat(2, 1), &bpm).unwrap(), 1_371_429);
}

#[test]
fn integer_bpm_table() {
    assert_eq!(beat_to_microseconds(&rat(1, 1), &rat(80, 1)).unwrap(), 750_000);
    assert_eq!(beat_to_microseconds(&rat(1, 1), &rat(90, 1)).unwrap(), 666_667);
    assert_eq!(beat_to_microseconds(&rat(1, 3), &rat(60, 1)).unwrap(), 333_333);
    assert_eq!(beat_to_microseconds(&rat(2, 3), &rat(60, 1)).unwrap(), 666_667);
    // 1/7 beat @60 BPM: 60e6/(7×60) = 142,857.14 → 142,857 (exact half-up).
    assert_eq!(beat_to_microseconds(&rat(1, 7), &rat(60, 1)).unwrap(), 142_857);
}

#[test]
fn count_in_beats_exact() {
    assert_eq!(count_in_beats(3_000_000, &rat(175, 2)).unwrap(), rat(35, 8));
    assert_eq!(count_in_beats(2_666_667, &rat(90, 1)).unwrap(), rat(8_000_001, 2_000_000));
}

#[test]
fn final_addition_respects_the_safe_integer_bound() {
    let max = 9_007_199_254_740_991i64;
    // Legal addends, illegal sum → TIME_OUT_OF_RANGE (no wrap, no truncation).
    let bpm = rat(1, max);
    let error = target_onset_us(max, &rat(1, 1), &bpm).unwrap_err();
    assert_eq!(error.code, "TIME_OUT_OF_RANGE");
    // Exact in-domain sum stays exact.
    assert_eq!(target_onset_us(3_000_000, &rat(1, 1), &rat(120, 1)).unwrap(), 3_500_000);
}

fn valid_config_json() -> String {
    r#"{
        "partId": "P1",
        "range": { "startMeasureOrdinal": 1, "endMeasureOrdinal": 2 },
        "repeatSelection": { "kind": "none" },
        "hand": "both",
        "handMapping": {
            "schemaVersion": 1,
            "mappingVersion": "hand-mapping-1",
            "source": "user",
            "parts": [{ "partId": "P1", "staves": [{ "staffNumber": 1, "hand": "right" }] }]
        },
        "bpm": { "numerator": 80, "denominator": 1 },
        "ticksPerQuarter": 960,
        "countInUs": 3000000,
        "unsupportedNotationPolicy": "reject-strict",
        "plannerVersion": "parity-harness-1"
    }"#
    .to_string()
}

#[test]
fn valid_config_parses() {
    let config = parse_plan_request_config(&valid_config_json()).expect("valid config");
    assert_eq!(config.part_id, "P1");
    assert_eq!(config.count_in_us, 3_000_000);
}

#[test]
fn unknown_fields_are_rejected() {
    let mut json = valid_config_json();
    json.insert_str(json.len() - 2, r#", "surprise": 1"#);
    let error = parse_plan_request_config(&json).expect_err("unknown field must fail");
    assert_eq!(error.code, "SCHEMA_VIOLATION");
}

#[test]
fn invalid_configs_are_rejected_with_frozen_codes() {
    // range: start < 1
    let json = valid_config_json().replace(
        "\"startMeasureOrdinal\": 1",
        "\"startMeasureOrdinal\": 0",
    );
    assert_eq!(parse_plan_request_config(&json).unwrap_err().code, "INVALID_RANGE");

    // range: end < start
    let json = valid_config_json().replace(
        "\"endMeasureOrdinal\": 2",
        "\"endMeasureOrdinal\": 0",
    );
    assert_eq!(parse_plan_request_config(&json).unwrap_err().code, "INVALID_RANGE");

    // loop count 0 and 33
    for count in [0, 33] {
        let json = valid_config_json().replace(
            r#""repeatSelection": { "kind": "none" }"#,
            &format!(r#""repeatSelection": {{ "kind": "range-loop", "count": {count} }}"#),
        );
        assert_eq!(parse_plan_request_config(&json).unwrap_err().code, "INVALID_REPEAT_COUNT");
    }

    // Frozen oneOf mutual exclusion (fifth review §二-2): "none" must NOT
    // carry a count; "range-loop" must carry one.
    let json = valid_config_json().replace(
        r#""repeatSelection": { "kind": "none" }"#,
        r#""repeatSelection": { "kind": "none", "count": 2 }"#,
    );
    assert_eq!(
        parse_plan_request_config(&json).unwrap_err().code,
        "INVALID_REPEAT_SELECTION"
    );
    let json = valid_config_json().replace(
        r#""repeatSelection": { "kind": "none" }"#,
        r#""repeatSelection": { "kind": "range-loop" }"#,
    );
    assert_eq!(parse_plan_request_config(&json).unwrap_err().code, "INVALID_REPEAT_COUNT");

    // handMapping frozen schemaVersion/mappingVersion values.
    let json = valid_config_json().replace("\"schemaVersion\": 1", "\"schemaVersion\": 2");
    assert_eq!(
        parse_plan_request_config(&json).unwrap_err().code,
        "HAND_MAPPING_INCOMPLETE"
    );
    let json = valid_config_json().replace(
        "\"mappingVersion\": \"hand-mapping-1\"",
        "\"mappingVersion\": \"hand-mapping-2\"",
    );
    assert_eq!(
        parse_plan_request_config(&json).unwrap_err().code,
        "HAND_MAPPING_INCOMPLETE"
    );

    // Non-empty partId (top level and hand-mapping parts).
    let json = valid_config_json().replacen("\"partId\": \"P1\",", "\"partId\": \" \",", 1);
    assert_eq!(parse_plan_request_config(&json).unwrap_err().code, "INVALID_CONFIG");
    let json = valid_config_json().replace(
        "\"parts\": [{ \"partId\": \"P1\"",
        "\"parts\": [{ \"partId\": \"\"",
    );
    assert_eq!(
        parse_plan_request_config(&json).unwrap_err().code,
        "HAND_MAPPING_INCOMPLETE"
    );

    // Safe-integer input domain: bpm parts and countInUs beyond ±(2^53-1).
    let beyond = "9007199254740992"; // 2^53
    let json = valid_config_json().replace(
        "\"bpm\": { \"numerator\": 80, \"denominator\": 1 }",
        &format!("\"bpm\": {{ \"numerator\": 80, \"denominator\": {beyond} }}"),
    );
    assert_eq!(parse_plan_request_config(&json).unwrap_err().code, "RATIONAL_OUT_OF_RANGE");
    let json = valid_config_json().replace(
        "\"countInUs\": 3000000",
        &format!("\"countInUs\": {beyond}"),
    );
    assert_eq!(parse_plan_request_config(&json).unwrap_err().code, "RATIONAL_OUT_OF_RANGE");

    // BPM bounds comparison must survive huge denominators without i64
    // overflow (the comparison is BigInt after the safe-integer check): a
    // huge denominator makes bpm < 20 without any multiplication overflow.
    let json = valid_config_json().replace(
        "\"bpm\": { \"numerator\": 80, \"denominator\": 1 }",
        &format!(
            "\"bpm\": {{ \"numerator\": {}, \"denominator\": {} }}",
            9_007_199_254_740_000i64, 9_007_199_254_740_991i64
        ),
    );
    assert_eq!(parse_plan_request_config(&json).unwrap_err().code, "INVALID_BPM");

    // bpm zero and unreduced
    let json = valid_config_json().replace(
        "\"numerator\": 80",
        "\"numerator\": 0",
    );
    assert_eq!(parse_plan_request_config(&json).unwrap_err().code, "INVALID_BPM");
    let json = valid_config_json().replace(
        "\"numerator\": 80, \"denominator\": 1",
        "\"numerator\": 160, \"denominator\": 2",
    );
    assert_eq!(parse_plan_request_config(&json).unwrap_err().code, "INVALID_RATIONAL");

    // bpm out of the 20–300 product range
    let json = valid_config_json().replace("\"numerator\": 80", "\"numerator\": 10");
    assert_eq!(parse_plan_request_config(&json).unwrap_err().code, "INVALID_BPM");

    // negative count-in
    let json = valid_config_json().replace(
        "\"countInUs\": 3000000",
        "\"countInUs\": -1",
    );
    assert_eq!(parse_plan_request_config(&json).unwrap_err().code, "INVALID_TIME");

    // clef-heuristic mapping source
    let json = valid_config_json().replace("\"source\": \"user\"", "\"source\": \"clef-heuristic\"");
    assert_eq!(
        parse_plan_request_config(&json).unwrap_err().code,
        "HAND_MAPPING_SOURCE_NOT_ALLOWED"
    );

    // unknown policy
    let json = valid_config_json().replace(
        "\"unsupportedNotationPolicy\": \"reject-strict\"",
        "\"unsupportedNotationPolicy\": \"yolo\"",
    );
    assert_eq!(parse_plan_request_config(&json).unwrap_err().code, "INVALID_POLICY");

    // empty plannerVersion
    let json = valid_config_json().replace(
        "\"plannerVersion\": \"parity-harness-1\"",
        "\"plannerVersion\": \" \"",
    );
    assert_eq!(parse_plan_request_config(&json).unwrap_err().code, "INVALID_PLANNER_VERSION");
}
