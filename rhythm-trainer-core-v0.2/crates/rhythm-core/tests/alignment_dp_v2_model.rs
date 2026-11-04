//! Model-level acceptance for the Alignment V2 domain types (PRD Task B):
//! config validation + fingerprint stability, and the structural invariants
//! enforced by `validate_alignment_result_v2`.

use rhythm_core::alignment_dp_v2::{
    validate_alignment_result_v2, AlignmentDpConfigV1, AlignmentKind, AlignmentPairV2,
    AlignmentResultV2, AlignmentStatusV2, AmbiguousGroupV2,
};
use rhythm_core::{CoreError, PairingStatusV1, PerformedNoteV1, ScoreEvent};

fn score_events(onsets: &[f64], pitches: &[u8]) -> Vec<ScoreEvent> {
    onsets.iter().enumerate().map(|(i, &onset)| ScoreEvent {
        score_event_id: format!("s{}", i + 1),
        measure: (i as u32) / 4 + 1,
        beat_position: i as f64,
        pitch: pitches.get(i).copied().unwrap_or(60),
        target_onset_ms: onset,
        target_duration_ms: 400.0,
        part_id: "piano".to_string(),
        parse_confidence: 1.0,
    }).collect()
}

fn performed(onsets: &[f64], pitches: &[u8]) -> Vec<PerformedNoteV1> {
    onsets.iter().enumerate().map(|(i, &onset)| PerformedNoteV1 {
        performed_note_id: format!("p{}", i + 1),
        pitch: pitches.get(i).copied().unwrap_or(60),
        onset_ms: onset,
        release_ms: Some(onset + 200.0),
        pairing_status: PairingStatusV1::Complete,
    }).collect()
}

fn valid_result(score: &[ScoreEvent], played: &[PerformedNoteV1]) -> AlignmentResultV2 {
    AlignmentResultV2 {
        pairs: vec![AlignmentPairV2 {
            score_event_id: score[0].score_event_id.clone(),
            performed_note_id: played[0].performed_note_id.clone(),
            kind: AlignmentKind::CorrectPitch,
            onset_error_ms: played[0].onset_ms - score[0].target_onset_ms,
            match_cost: 1.5,
            assignment_ambiguous: false,
            measure: score[0].measure,
        }],
        missed_score_event_ids: score[1..].iter().map(|event| event.score_event_id.clone()).collect(),
        extra_performed_ids: played[1..].iter().map(|note| note.performed_note_id.clone()).collect(),
        ..AlignmentResultV2::default()
    }
}

#[test]
fn default_config_is_valid_and_fingerprint_is_stable() {
    let config = AlignmentDpConfigV1::default();
    config.validate().expect("defaults must validate");

    let first = config.parameter_fingerprint();
    let second = config.parameter_fingerprint();
    assert_eq!(first, second, "fingerprint must be deterministic");
    assert_eq!(first.len(), 64, "fingerprint is a sha256 hex string");

    let mut tweaked = config.clone();
    tweaked.miss_cost += 0.5;
    assert_ne!(
        first,
        tweaked.parameter_fingerprint(),
        "any parameter change must change the fingerprint"
    );
}

#[test]
fn config_validation_rejects_non_positive_and_non_finite() {
    let base = AlignmentDpConfigV1::default();

    let mutators: Vec<(&str, &str, fn(&mut AlignmentDpConfigV1))> = vec![
        ("time_tau_ms", "time_tau_ms", |c| c.time_tau_ms = 0.0),
        ("time_tau_ms_nan", "time_tau_ms", |c| c.time_tau_ms = f64::NAN),
        ("time_cost_cap", "time_cost_cap", |c| c.time_cost_cap = -1.0),
        ("pitch_mismatch_cost", "pitch_mismatch_cost", |c| c.pitch_mismatch_cost = 0.0),
        ("miss_cost", "miss_cost", |c| c.miss_cost = f64::INFINITY),
        ("extra_cost", "extra_cost", |c| c.extra_cost = -0.5),
        ("band_ms", "band_ms", |c| c.band_ms = 0.0),
    ];
    for (name, expected_field, mutator) in mutators {
        let mut config = base.clone();
        mutator(&mut config);
        assert!(
            matches!(config.validate(), Err(CoreError::InvalidConfig(message)) if message.contains(expected_field)),
            "{name} must be rejected with a named InvalidConfig error"
        );
    }

    let mut config = base.clone();
    config.max_cells = 0;
    assert!(matches!(config.validate(), Err(CoreError::InvalidConfig(_))));
    let mut config = base.clone();
    config.same_onset_epsilon_ms = -0.1;
    assert!(matches!(config.validate(), Err(CoreError::InvalidConfig(_))));
    let mut config = base.clone();
    config.ambiguous_same_pitch_min = 0;
    assert!(matches!(config.validate(), Err(CoreError::InvalidConfig(_))));
}

#[test]
fn valid_result_with_misses_and_extras_passes_validation() {
    let score = score_events(&[3000.0, 3750.0, 4500.0], &[60, 62, 64]);
    let played = performed(&[3000.0, 4520.0], &[60, 64]);
    let result = valid_result(&score, &played);
    validate_alignment_result_v2(&result, &score, &played).expect("consistent result must validate");
}

#[test]
fn validation_rejects_duplicate_and_unknown_ids() {
    let score = score_events(&[3000.0, 3750.0], &[60, 62]);
    let played = performed(&[3000.0, 3750.0], &[60, 62]);

    // Same score event paired twice breaks the 1:1 invariant.
    let doubled = AlignmentResultV2 {
        pairs: vec![
            AlignmentPairV2 {
                score_event_id: "s1".into(),
                performed_note_id: "p1".into(),
                kind: AlignmentKind::CorrectPitch,
                onset_error_ms: 0.0,
                match_cost: 1.0,
                assignment_ambiguous: false,
                measure: 1,
            },
            AlignmentPairV2 {
                score_event_id: "s1".into(),
                performed_note_id: "p2".into(),
                kind: AlignmentKind::CorrectPitch,
                onset_error_ms: 0.0,
                match_cost: 1.0,
                assignment_ambiguous: false,
                measure: 1,
            },
        ],
        ..AlignmentResultV2::default()
    };
    assert!(matches!(
        validate_alignment_result_v2(&doubled, &score, &played),
        Err(CoreError::InvalidEvent(message)) if message.contains("more than one pair")
    ));

    // Unknown performed id.
    let unknown = AlignmentResultV2 {
        pairs: vec![AlignmentPairV2 {
            score_event_id: "s1".into(),
            performed_note_id: "p-missing".into(),
            kind: AlignmentKind::CorrectPitch,
            onset_error_ms: 0.0,
            match_cost: 1.0,
            assignment_ambiguous: false,
            measure: 1,
        }],
        ..AlignmentResultV2::default()
    };
    assert!(matches!(
        validate_alignment_result_v2(&unknown, &score, &played),
        Err(CoreError::InvalidEvent(message)) if message.contains("unknown performedNoteId")
    ));
}

#[test]
fn validation_rejects_rewritten_onset_errors() {
    let score = score_events(&[3000.0], &[60]);
    let played = performed(&[3300.0], &[60]);
    let washed = AlignmentResultV2 {
        pairs: vec![AlignmentPairV2 {
            score_event_id: "s1".into(),
            performed_note_id: "p1".into(),
            kind: AlignmentKind::CorrectPitch,
            onset_error_ms: 0.0, // raw delta is +300 — a washed value
            match_cost: 1.0,
            assignment_ambiguous: false,
            measure: 1,
        }],
        ..AlignmentResultV2::default()
    };
    assert!(matches!(
        validate_alignment_result_v2(&washed, &score, &played),
        Err(CoreError::InvalidEvent(message)) if message.contains("raw times")
    ));
}

#[test]
fn validation_rejects_wrong_kind_and_pair_unmatched_overlap() {
    let score = score_events(&[3000.0, 3750.0], &[60, 62]);
    let played = performed(&[3000.0], &[64]); // wrong pitch vs s1

    let wrong_kind = AlignmentResultV2 {
        pairs: vec![AlignmentPairV2 {
            score_event_id: "s1".into(),
            performed_note_id: "p1".into(),
            kind: AlignmentKind::CorrectPitch, // pitches 60 vs 64 -> must be WrongPitch
            onset_error_ms: 0.0,
            match_cost: 1.0,
            assignment_ambiguous: false,
            measure: 1,
        }],
        ..AlignmentResultV2::default()
    };
    assert!(matches!(
        validate_alignment_result_v2(&wrong_kind, &score, &played),
        Err(CoreError::InvalidEvent(message)) if message.contains("disagrees with input pitches")
    ));

    // The same score event cannot be both paired and missed.
    let both = AlignmentResultV2 {
        pairs: vec![AlignmentPairV2 {
            score_event_id: "s1".into(),
            performed_note_id: "p1".into(),
            kind: AlignmentKind::WrongPitch,
            onset_error_ms: 0.0,
            match_cost: 1.0,
            assignment_ambiguous: false,
            measure: 1,
        }],
        missed_score_event_ids: vec!["s1".into()],
        ..AlignmentResultV2::default()
    };
    assert!(matches!(
        validate_alignment_result_v2(&both, &score, &played),
        Err(CoreError::InvalidEvent(message)) if message.contains("paired and missed")
    ));
}

#[test]
fn validation_checks_ambiguous_group_references() {
    let score = score_events(&[3000.0], &[60]);
    let played = performed(&[3000.0], &[60]);
    let bad_group = AlignmentResultV2 {
        ambiguous_groups: vec![AmbiguousGroupV2 {
            score_event_ids: vec!["s-unknown".into()],
            performed_note_ids: vec![],
            reason_code: "CROSS_HAND_SAME_PITCH_UNISON".into(),
        }],
        ..AlignmentResultV2::default()
    };
    assert!(matches!(
        validate_alignment_result_v2(&bad_group, &score, &played),
        Err(CoreError::InvalidEvent(message)) if message.contains("ambiguous group")
    ));
}

#[test]
fn status_resource_limit_carries_reason_code() {
    let status = AlignmentStatusV2::ResourceLimit {
        reason_code: "ALIGNMENT_RESOURCE_LIMIT".into(),
    };
    assert_ne!(status, AlignmentStatusV2::Completed);
    let serialized = serde_json::to_string(&status).expect("status must serialize");
    assert!(serialized.contains("ALIGNMENT_RESOURCE_LIMIT"));
}
