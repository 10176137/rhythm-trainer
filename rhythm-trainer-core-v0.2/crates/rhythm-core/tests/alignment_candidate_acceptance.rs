//! Acceptance for the rule-based alignment candidate: it must fix the
//! late-note cascade pinned in `alignment_v2_root_cause.rs` while keeping the
//! existing hard cases (clean / chord / wrong pitch / missing / extra / drift)
//! at least as correct as `scoring_v1`.

use rhythm_core::{
    align_performances, align_performances_candidate, PerformedNoteV1, ScoreEvent, ScoringConfig,
};

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
        pairing_status: rhythm_core::PairingStatusV1::Complete,
    }).collect()
}

fn pairs(result: &rhythm_core::AlignmentResult) -> Vec<(String, String, f64, bool)> {
    result.pairs.iter().map(|pair| (
        pair.score_event_id.clone(),
        pair.performed_note_id.clone(),
        pair.onset_error_ms,
        pair.pitch_matched,
    )).collect()
}

const ONSETS: [f64; 5] = [0.0, 500.0, 1000.0, 1500.0, 2000.0];
const PITCHES: [u8; 5] = [60, 62, 64, 65, 67];

/// The reported defect: one +300ms phase change must keep every identity and
/// report the raw +300ms error, not five miss+extra pairs.
#[test]
fn candidate_keeps_identity_for_300ms_phase_shift() {
    let score = score_events(&ONSETS, &PITCHES);
    let perf = performed(&[0.0, 800.0, 1300.0, 1800.0, 2300.0], &PITCHES);
    let result = align_performances_candidate(&score, &perf, &ScoringConfig::default()).unwrap();
    assert!(result.missed_score_event_ids.is_empty(), "{:?}", result.missed_score_event_ids);
    assert!(result.extra_performed_ids.is_empty(), "{:?}", result.extra_performed_ids);
    assert_eq!(pairs(&result), vec![
        ("s1".into(), "p1".into(), 0.0, true),
        ("s2".into(), "p2".into(), 300.0, true),
        ("s3".into(), "p3".into(), 300.0, true),
        ("s4".into(), "p4".into(), 300.0, true),
        ("s5".into(), "p5".into(), 300.0, true),
    ]);
}

/// The user-visible shape: a +600ms shift used to steal the next target and
/// label correct notes WRONG_PITCH. All five identities and pitches must hold.
#[test]
fn candidate_keeps_identity_for_600ms_phase_shift() {
    // Benchmark geometry (750 ms IOI, same as tl-late-600-phase): a +600 ms
    // shift is 0.8 x the local interval, inside the late window. Shifts larger
    // than the late window intentionally fall back to miss+extra (no cascade)
    // until the DP candidate models phase changes explicitly.
    let onsets = [0.0, 750.0, 1500.0, 2250.0, 3000.0];
    let score = score_events(&onsets, &PITCHES);
    let perf = performed(&[0.0, 1350.0, 2100.0, 2850.0, 3600.0], &PITCHES);
    let result = align_performances_candidate(&score, &perf, &ScoringConfig::default()).unwrap();
    assert!(result.missed_score_event_ids.is_empty(), "{:?}", result.missed_score_event_ids);
    assert!(result.extra_performed_ids.is_empty(), "{:?}", result.extra_performed_ids);
    assert_eq!(pairs(&result), vec![
        ("s1".into(), "p1".into(), 0.0, true),
        ("s2".into(), "p2".into(), 600.0, true),
        ("s3".into(), "p3".into(), 600.0, true),
        ("s4".into(), "p4".into(), 600.0, true),
        ("s5".into(), "p5".into(), 600.0, true),
    ]);
}

/// Isolated late note followed by a return to the original grid: the late note
/// pairs its own target, the rest have zero error (V1 halves this into
/// miss+extra).
#[test]
fn candidate_pairs_isolated_late_note_without_punishing_neighbours() {
    let score = score_events(&ONSETS, &PITCHES);
    let perf = performed(&[0.0, 300.0 + 500.0, 1000.0, 1500.0, 2000.0], &PITCHES);
    let result = align_performances_candidate(&score, &perf, &ScoringConfig::default()).unwrap();
    assert!(result.missed_score_event_ids.is_empty());
    assert!(result.extra_performed_ids.is_empty());
    assert_eq!(pairs(&result), vec![
        ("s1".into(), "p1".into(), 0.0, true),
        ("s2".into(), "p2".into(), 300.0, true),
        ("s3".into(), "p3".into(), 0.0, true),
        ("s4".into(), "p4".into(), 0.0, true),
        ("s5".into(), "p5".into(), 0.0, true),
    ]);
}

/// Early notes keep the frozen semantics: consumed as extra, no cascade.
#[test]
fn candidate_keeps_early_note_control() {
    let score = score_events(&ONSETS, &PITCHES);
    let perf = performed(&[0.0, 200.0, 1000.0, 1500.0, 2000.0], &PITCHES);
    let frozen = align_performances(&score, &perf, &ScoringConfig::default()).unwrap();
    let candidate = align_performances_candidate(&score, &perf, &ScoringConfig::default()).unwrap();
    assert_eq!(candidate.missed_score_event_ids, frozen.missed_score_event_ids);
    assert_eq!(candidate.extra_performed_ids, frozen.extra_performed_ids);
    assert_eq!(pairs(&candidate), pairs(&frozen));
}

/// A genuinely skipped target must still be missed, and the following notes
/// must keep their own targets — the late window must not swallow skip cases.
#[test]
fn candidate_still_reports_a_skipped_target() {
    let score = score_events(&ONSETS, &PITCHES);
    // s2 skipped entirely: only four performed notes with pitches 60/64/65/67.
    let perf = performed(&[0.0, 1000.0, 1500.0, 2000.0], &[60, 64, 65, 67]);
    let result = align_performances_candidate(&score, &perf, &ScoringConfig::default()).unwrap();
    assert_eq!(result.missed_score_event_ids, vec!["s2".to_string()]);
    assert!(result.extra_performed_ids.is_empty());
    assert_eq!(pairs(&result), vec![
        ("s1".into(), "p1".into(), 0.0, true),
        ("s3".into(), "p2".into(), 0.0, true),
        ("s4".into(), "p3".into(), 0.0, true),
        ("s5".into(), "p4".into(), 0.0, true),
    ]);
}

/// A real wrong pitch inside the window must stay a wrong-pitch pair, not
/// become miss+extra, and the following notes stay aligned.
#[test]
fn candidate_keeps_wrong_pitch_pairing() {
    let score = score_events(&ONSETS, &PITCHES);
    let perf = performed(&[0.0, 500.0, 1000.0, 1500.0, 2000.0], &[60, 62, 66, 65, 67]);
    let result = align_performances_candidate(&score, &perf, &ScoringConfig::default()).unwrap();
    assert!(result.missed_score_event_ids.is_empty());
    assert!(result.extra_performed_ids.is_empty());
    let wrong = result.pairs.iter().find(|pair| !pair.pitch_matched).expect("wrong pitch pair");
    assert_eq!(wrong.score_event_id, "s3");
    assert_eq!(wrong.performed_note_id, "p3");
}

/// Clean input must be identical to the frozen matcher.
#[test]
fn candidate_matches_frozen_on_clean_input() {
    let score = score_events(&ONSETS, &PITCHES);
    let perf = performed(&ONSETS, &PITCHES);
    let frozen = align_performances(&score, &perf, &ScoringConfig::default()).unwrap();
    let candidate = align_performances_candidate(&score, &perf, &ScoringConfig::default()).unwrap();
    assert_eq!(pairs(&candidate), pairs(&frozen));
    assert!(candidate.missed_score_event_ids.is_empty());
    assert!(candidate.extra_performed_ids.is_empty());
}

/// Existing tempo-drift case: progressive lateness up to 350ms must keep
/// identity (V1 halves it into 2 miss + 2 extra).
#[test]
fn candidate_keeps_tempo_drift_identity() {
    let score = score_events(&ONSETS, &PITCHES);
    let perf = performed(&[0.0, 520.0, 1050.0, 1590.0, 2140.0], &PITCHES);
    let result = align_performances_candidate(&score, &perf, &ScoringConfig::default()).unwrap();
    assert!(result.missed_score_event_ids.is_empty(), "{:?}", result.missed_score_event_ids);
    assert!(result.extra_performed_ids.is_empty(), "{:?}", result.extra_performed_ids);
    assert_eq!(result.pairs.iter().map(|pair| pair.score_event_id.as_str()).collect::<Vec<_>>(), vec!["s1", "s2", "s3", "s4", "s5"]);
    // Raw errors must be preserved (grading is a separate layer).
    assert!(result.pairs.iter().all(|pair| pair.pitch_matched));
}
