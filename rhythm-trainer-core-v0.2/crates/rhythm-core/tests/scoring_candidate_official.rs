//! Versioned official scoring: candidate alignment must reuse v1 math.
//! Legacy entrypoint remains frozen; the engine selects one at Take finalization.

use rhythm_core::{
    score_performance, score_performance_candidate, PairingStatusV1,
    PerformedNoteV1, ScoreEvent, ScoringConfig,
    SCORING_ALGORITHM_VERSION, SCORING_CANDIDATE_ALGORITHM_VERSION,
};

const EXPECTED: [f64; 5] = [0.0, 500.0, 1000.0, 1500.0, 2000.0];
const PITCHES: [u8; 5] = [60, 62, 64, 65, 67];

fn score() -> Vec<ScoreEvent> {
    EXPECTED.iter().enumerate().map(|(i, &onset)| ScoreEvent {
        score_event_id: format!("s{}", i + 1),
        measure: (i as u32) / 4 + 1,
        beat_position: i as f64,
        pitch: PITCHES[i],
        target_onset_ms: onset,
        target_duration_ms: 400.0,
        part_id: "piano".into(),
        parse_confidence: 1.0,
    }).collect()
}

fn performed(onsets: [f64; 5]) -> Vec<PerformedNoteV1> {
    onsets.iter().enumerate().map(|(i, &onset)| PerformedNoteV1 {
        performed_note_id: format!("p{}", i + 1),
        pitch: PITCHES[i],
        onset_ms: onset,
        release_ms: Some(onset + 400.0),
        pairing_status: PairingStatusV1::Complete,
    }).collect()
}

#[test]
fn late_phase_is_correctly_paired_but_not_retimed() {
    let input = score();
    let played = performed([0.0, 800.0, 1300.0, 1800.0, 2300.0]);
    let cfg = ScoringConfig::default();
    let baseline = score_performance(&input, &played, &cfg).unwrap();
    let new = score_performance_candidate(&input, &played, &cfg).unwrap();
    assert_eq!(baseline.algorithm_version, SCORING_ALGORITHM_VERSION);
    assert_eq!(new.algorithm_version, SCORING_CANDIDATE_ALGORITHM_VERSION);
    assert!(baseline.alignment.pairs.len() < 5);
    assert_eq!(new.alignment.pairs.len(), 5);
    assert!(new.alignment.missed_score_event_ids.is_empty());
    assert!(new.alignment.extra_performed_ids.is_empty());
    assert_eq!(new.pitch.correct, 5);
    assert_eq!(new.pitch.wrong_pitch, 0);
    assert_eq!(new.onset.matched, 5);
    for (i, pair) in new.alignment.pairs.iter().enumerate() {
        assert_eq!(pair.score_event_id, format!("s{}", i + 1));
        assert_eq!(pair.performed_note_id, format!("p{}", i + 1));
        assert_eq!(pair.onset_error_ms, if i == 0 { 0.0 } else { 300.0 });
    }
    assert_eq!(new.onset.out_of_tolerance_count, 4);
    // The onset subscore is NOT artificially improved by the alignment.
    let onset_score = new.overall.subscores.iter().find(|s| s.name == "onset").unwrap().score.unwrap();
    assert!((onset_score - 20.0).abs() < 1e-9, "onset score must reflect four late notes");
    assert_eq!(new.duration.graded, 5);
    assert_eq!(new.duration.too_long_count, 0);
    assert_eq!(new.duration.too_short_count, 0);
}

#[test]
fn clean_scores_are_equal_except_explicit_algorithm_identity() {
    let input = score();
    let played = performed(EXPECTED);
    let cfg = ScoringConfig::default();
    let legacy = score_performance(&input, &played, &cfg).unwrap();
    let mut candidate = score_performance_candidate(&input, &played, &cfg).unwrap();
    candidate.algorithm_version = legacy.algorithm_version.clone();
    assert_eq!(legacy, candidate, "candidate must not modify any clean-case metric");
}

#[test]
fn replay_is_deterministic_for_same_inputs_and_config() {
    let input = score();
    let played = performed([0.0, 800.0, 1000.0, 1500.0, 2000.0]);
    let cfg = ScoringConfig::default();
    let first = score_performance_candidate(&input, &played, &cfg).unwrap();
    let second = score_performance_candidate(&input, &played, &cfg).unwrap();
    assert_eq!(first, second);
    assert_eq!(first.alignment.pairs.len(), 5);
    assert_eq!(first.alignment.pairs[1].onset_error_ms, 300.0);
    assert_eq!(first.alignment.pairs[2].onset_error_ms, 0.0);
}
