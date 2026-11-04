//! Acceptance for the weighted sequence DP alignment candidate
//! (`WeightedSequenceAlignerV2`, PRD §4.2 / Task C). Pins the behaviors the
//! frozen greedy matcher gets wrong (late-note cascade) and the behaviors it
//! already gets right (clean / chord / wrong-pitch / missing / extra must not
//! regress), plus resource limits, ambiguity reporting and determinism.

use rhythm_core::alignment_dp_v2::{
    align_performances_dp_v2, to_legacy_alignment, validate_alignment_result_v2, AlignmentDpConfigV1,
    AlignmentKind, AlignmentStatusV2, ALIGNMENT_DP_V2_ALGORITHM_VERSION,
};
use rhythm_core::{PairingStatusV1, PerformedNoteV1, ScoreEvent, ScoringConfig, SCORING_ALGORITHM_VERSION, SCORING_DP_V2_ALGORITHM_VERSION};

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

fn performed_events(notes: &[(u8, f64)]) -> Vec<PerformedNoteV1> {
    notes.iter().enumerate().map(|(i, (pitch, onset))| PerformedNoteV1 {
        performed_note_id: format!("p{}", i + 1),
        pitch: *pitch,
        onset_ms: *onset,
        release_ms: Some(onset + 200.0),
        pairing_status: PairingStatusV1::Complete,
    }).collect()
}

fn dp(score: &[ScoreEvent], played: &[PerformedNoteV1]) -> rhythm_core::alignment_dp_v2::AlignmentResultV2 {
    align_performances_dp_v2(score, played, &ScoringConfig::default(), &AlignmentDpConfigV1::default())
        .expect("dp alignment must not error on valid inputs")
}

fn pair_list(result: &rhythm_core::alignment_dp_v2::AlignmentResultV2) -> Vec<(String, String, f64, AlignmentKind)> {
    let mut pairs: Vec<_> = result.pairs.iter().map(|pair| (
        pair.score_event_id.clone(),
        pair.performed_note_id.clone(),
        pair.onset_error_ms,
        pair.kind,
    )).collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    pairs
}

const C4: u8 = 60;
const D4: u8 = 62;
const E4: u8 = 64;
const F4: u8 = 65;
const G4: u8 = 67;

#[test]
fn clean_performance_pairs_everything_like_frozen() {
    let score = score_events(&[3000.0, 3750.0, 4500.0, 5250.0], &[C4, D4, E4, F4]);
    let played = performed_events(&[(C4, 3000.0), (D4, 3750.0), (E4, 4500.0), (F4, 5250.0)]);
    let result = dp(&score, &played);
    assert_eq!(result.status, AlignmentStatusV2::Completed);
    assert_eq!(result.pairs.len(), 4);
    assert!(result.missed_score_event_ids.is_empty());
    assert!(result.extra_performed_ids.is_empty());
    assert!(result.pairs.iter().all(|pair| pair.kind == AlignmentKind::CorrectPitch));
    validate_alignment_result_v2(&result, &score, &played).expect("clean result must satisfy invariants");
}

#[test]
fn late_300_phase_keeps_all_identities_and_raw_errors() {
    // PRD §3.3 canonical case: one +300 ms phase step, then steady.
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0, 2000.0], &[C4, D4, E4, F4, G4]);
    let played = performed_events(&[(C4, 0.0), (D4, 800.0), (E4, 1300.0), (F4, 1800.0), (G4, 2300.0)]);
    let result = dp(&score, &played);
    let pairs = pair_list(&result);
    assert_eq!(pairs, vec![
        ("s1".into(), "p1".into(), 0.0, AlignmentKind::CorrectPitch),
        ("s2".into(), "p2".into(), 300.0, AlignmentKind::CorrectPitch),
        ("s3".into(), "p3".into(), 300.0, AlignmentKind::CorrectPitch),
        ("s4".into(), "p4".into(), 300.0, AlignmentKind::CorrectPitch),
        ("s5".into(), "p5".into(), 300.0, AlignmentKind::CorrectPitch),
    ]);
    assert!(result.missed_score_event_ids.is_empty() && result.extra_performed_ids.is_empty());
    // Raw lateness survives untouched; the recovery beyond the legacy window
    // is reported as diagnostics, not hidden.
    assert!(result.diagnostics.iter().any(|d| d.code == "LATE_BUT_PAIRED_BEYOND_LEGACY_WINDOW"));
}

#[test]
fn late_600_phase_keeps_all_identities() {
    // Frozen v1 turns this whole tail into WRONG_PITCH (root-cause report);
    // the DP must keep every identity with the raw 600 ms shift visible.
    let score = score_events(&[3000.0, 3750.0, 4500.0, 5250.0, 6000.0, 6750.0, 7500.0, 8250.0], &[60, 62, 64, 65, 67, 69, 71, 72]);
    let played = performed_events(&[
        (60, 3000.0), (62, 3750.0), (64, 4500.0), (65, 5100.0),
        (67, 5850.0), (69, 6600.0), (71, 7350.0), (72, 8100.0),
    ]);
    let result = dp(&score, &played);
    assert_eq!(result.pairs.len(), 8);
    assert!(result.missed_score_event_ids.is_empty() && result.extra_performed_ids.is_empty());
    assert!(result.pairs.iter().all(|pair| pair.kind == AlignmentKind::CorrectPitch));
}

#[test]
fn isolated_late_note_then_return_does_not_cascade() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0, 2000.0], &[C4, D4, E4, F4, G4]);
    let played = performed_events(&[(C4, 0.0), (D4, 800.0), (E4, 1000.0), (F4, 1500.0), (G4, 2000.0)]);
    let result = dp(&score, &played);
    let pairs = pair_list(&result);
    assert_eq!(pairs.len(), 5);
    assert_eq!(pairs[1], ("s2".into(), "p2".into(), 300.0, AlignmentKind::CorrectPitch));
    assert_eq!(pairs[2], ("s3".into(), "p3".into(), 0.0, AlignmentKind::CorrectPitch));
    assert!(result.missed_score_event_ids.is_empty() && result.extra_performed_ids.is_empty());
}

#[test]
fn early_note_is_consumed_without_degradation() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0], &[C4, D4, E4, F4]);
    let played = performed_events(&[(C4, 0.0), (D4, 200.0), (E4, 1000.0), (F4, 1500.0)]);
    let result = dp(&score, &played);
    let pairs = pair_list(&result);
    assert_eq!(pairs.len(), 4);
    assert_eq!(pairs[1], ("s2".into(), "p2".into(), -300.0, AlignmentKind::CorrectPitch));
    assert!(result.missed_score_event_ids.is_empty() && result.extra_performed_ids.is_empty());
}

#[test]
fn wrong_pitch_stays_a_wrong_pitch_pair() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0], &[C4, D4, E4, F4]);
    let played = performed_events(&[(C4, 0.0), (D4 + 1, 500.0), (E4, 1000.0), (F4, 1500.0)]);
    let result = dp(&score, &played);
    let pairs = pair_list(&result);
    assert_eq!(pairs[1], ("s2".into(), "p2".into(), 0.0, AlignmentKind::WrongPitch));
    assert!(result.missed_score_event_ids.is_empty(), "wrong pitch must not become a miss");
    assert!(result.extra_performed_ids.is_empty(), "wrong pitch must not become an extra");
}

#[test]
fn one_missed_target_does_not_shift_the_tail() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0, 2000.0], &[C4, D4, E4, F4, G4]);
    // s3 never played; the rest exact.
    let played = performed_events(&[(C4, 0.0), (D4, 500.0), (F4, 1500.0), (G4, 2000.0)]);
    let result = dp(&score, &played);
    let pairs = pair_list(&result);
    assert_eq!(pairs, vec![
        ("s1".into(), "p1".into(), 0.0, AlignmentKind::CorrectPitch),
        ("s2".into(), "p2".into(), 0.0, AlignmentKind::CorrectPitch),
        ("s4".into(), "p3".into(), 0.0, AlignmentKind::CorrectPitch),
        ("s5".into(), "p4".into(), 0.0, AlignmentKind::CorrectPitch),
    ]);
    assert_eq!(result.missed_score_event_ids, vec!["s3".to_string()]);
    assert!(result.extra_performed_ids.is_empty());
}

#[test]
fn mid_phrase_extra_is_recorded_once_without_stealing() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0], &[C4, D4, E4, F4]);
    let played = performed_events(&[(C4, 0.0), (D4, 500.0), (72, 700.0), (E4, 1000.0), (F4, 1500.0)]);
    let result = dp(&score, &played);
    assert_eq!(result.pairs.len(), 4);
    assert_eq!(result.extra_performed_ids, vec!["p3".to_string()]);
    assert!(result.missed_score_event_ids.is_empty());
}

#[test]
fn repeated_same_pitch_stays_three_independent_occurrences() {
    let score = score_events(&[0.0, 500.0, 1000.0], &[C4, C4, C4]);
    let played = performed_events(&[(C4, 0.0), (C4, 500.0), (C4, 1000.0)]);
    let result = dp(&score, &played);
    assert_eq!(result.pairs.len(), 3);
    assert_eq!(pair_list(&result), vec![
        ("s1".into(), "p1".into(), 0.0, AlignmentKind::CorrectPitch),
        ("s2".into(), "p2".into(), 0.0, AlignmentKind::CorrectPitch),
        ("s3".into(), "p3".into(), 0.0, AlignmentKind::CorrectPitch),
    ]);
}

#[test]
fn reversed_chord_arrival_keeps_all_three_identities() {
    // Three-note chord rolled in reverse (+5/+8/+10 ms): the performed spread
    // merges one block and the in-block assignment keeps identities.
    let score = score_events(&[3000.0, 3000.0, 3000.0, 3750.0], &[C4, E4, G4, C4 + 12]);
    let played = performed_events(&[(G4, 3005.0), (E4, 3008.0), (C4, 3010.0), (C4 + 12, 3750.0)]);
    let result = dp(&score, &played);
    let pairs = pair_list(&result);
    assert_eq!(pairs, vec![
        ("s1".into(), "p3".into(), 10.0, AlignmentKind::CorrectPitch),
        ("s2".into(), "p2".into(), 8.0, AlignmentKind::CorrectPitch),
        ("s3".into(), "p1".into(), 5.0, AlignmentKind::CorrectPitch),
        ("s4".into(), "p4".into(), 0.0, AlignmentKind::CorrectPitch),
    ]);
}

#[test]
fn incomplete_chord_misses_only_the_missing_tone() {
    // Missing middle tone of a chord must not eat the played top tone
    // (mirrors the frozen matcher's reserved-later-tone rule intent).
    let score = score_events(&[3000.0, 3000.0, 3000.0], &[C4, E4, G4]);
    let played = performed_events(&[(C4, 3000.0), (G4, 3002.0)]);
    let result = dp(&score, &played);
    let pairs = pair_list(&result);
    assert_eq!(pairs, vec![
        ("s1".into(), "p1".into(), 0.0, AlignmentKind::CorrectPitch),
        ("s3".into(), "p2".into(), 2.0, AlignmentKind::CorrectPitch),
    ]);
    assert_eq!(result.missed_score_event_ids, vec!["s2".to_string()]);
    assert!(result.extra_performed_ids.is_empty(), "the played top tone must not become an extra");
}

#[test]
fn cross_hand_same_pitch_unison_is_reported_ambiguous() {
    // Two staves, same pitch, same onset; MIDI cannot observe which hand
    // played which instance — must be flagged, not asserted.
    let mut score = score_events(&[3000.0, 3000.0], &[C4, C4]);
    score[0].part_id = "P1-staff1".into();
    score[1].part_id = "P1-staff2".into();
    let played = performed_events(&[(C4, 3000.0), (C4, 3002.0)]);
    let result = dp(&score, &played);
    assert_eq!(result.pairs.len(), 2, "a deterministic assignment is still reported");
    assert!(result.pairs.iter().all(|pair| pair.assignment_ambiguous));
    assert_eq!(result.ambiguous_groups.len(), 1);
    let group = &result.ambiguous_groups[0];
    assert_eq!(group.reason_code, "SAME_PITCH_ASSIGNMENT_AMBIGUOUS");
    assert_eq!(group.score_event_ids, vec!["s1".to_string(), "s2".to_string()]);
    assert_eq!(group.performed_note_ids, vec!["p1".to_string(), "p2".to_string()]);
}

#[test]
fn missing_release_does_not_break_alignment() {
    let score = score_events(&[0.0, 500.0, 1000.0], &[C4, D4, E4]);
    let mut played = performed_events(&[(C4, 0.0), (D4, 500.0), (E4, 1000.0)]);
    played[1].release_ms = None;
    played[1].pairing_status = PairingStatusV1::MissingRelease;
    let result = dp(&score, &played);
    assert_eq!(result.pairs.len(), 3);
    assert!(result.missed_score_event_ids.is_empty() && result.extra_performed_ids.is_empty());
}

#[test]
fn empty_inputs_yield_completed_empty_result() {
    let score = score_events(&[], &[]);
    let played = performed_events(&[]);
    let result = dp(&score, &played);
    assert_eq!(result.status, AlignmentStatusV2::Completed);
    assert!(result.pairs.is_empty());

    // Score with no performance at all: everything missed.
    let score = score_events(&[0.0, 500.0], &[C4, D4]);
    let result = dp(&score, &performed_events(&[]));
    assert_eq!(result.missed_score_event_ids, vec!["s1".to_string(), "s2".to_string()]);

    // Performed notes with no score: everything extra.
    let score = score_events(&[], &[]);
    let result = dp(&score, &performed_events(&[(C4, 100.0)]));
    assert_eq!(result.extra_performed_ids, vec!["p1".to_string()]);
}

#[test]
fn oversized_onset_block_returns_resource_limit_not_panic() {
    // 20 same-onset performed notes merge into one block above max_block_notes.
    let score = score_events(&vec![3000.0; 20], &vec![C4; 20]);
    let played = performed_events(&vec![(C4, 3000.0); 20]);
    let result = dp(&score, &played);
    assert_eq!(
        result.status,
        AlignmentStatusV2::ResourceLimit { reason_code: "ALIGNMENT_RESOURCE_LIMIT".into() }
    );
    assert!(result.pairs.is_empty());
    assert_eq!(result.algorithm_version, ALIGNMENT_DP_V2_ALGORITHM_VERSION);
    assert_eq!(result.parameter_fingerprint, AlignmentDpConfigV1::default().parameter_fingerprint());
    assert!(result.diagnostics.iter().any(|d| d.code == "ALIGNMENT_RESOURCE_LIMIT"));
}

#[test]
fn tiny_cell_budget_returns_resource_limit() {
    let score = score_events(&(0..200).map(|i| 3000.0 + i as f64 * 500.0).collect::<Vec<_>>(), &vec![60; 200]);
    let played = performed_events(&(0..200).map(|i| (60u8, 3000.0 + i as f64 * 500.0)).collect::<Vec<_>>());
    let mut config = AlignmentDpConfigV1::default();
    config.max_cells = 10;
    let result = align_performances_dp_v2(&score, &played, &ScoringConfig::default(), &config).expect("must not error");
    assert_eq!(
        result.status,
        AlignmentStatusV2::ResourceLimit { reason_code: "ALIGNMENT_RESOURCE_LIMIT".into() }
    );
}

#[test]
fn alignment_is_deterministic_across_runs() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0, 2000.0], &[C4, D4, E4, F4, G4]);
    let played = performed_events(&[(C4, 0.0), (D4, 800.0), (E4, 1300.0), (F4, 1800.0), (72, 1250.0)]);
    let first = dp(&score, &played);
    let second = dp(&score, &played);
    assert_eq!(first, second, "same inputs and config must produce identical results");
}

#[test]
fn score_performance_dp_v2_matches_legacy_scores_on_clean_input_except_identity() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0], &[C4, D4, E4, F4]);
    let played = performed_events(&[(C4, 0.0), (D4, 500.0), (E4, 1000.0), (F4, 1500.0)]);
    let config = ScoringConfig::default();
    let legacy = rhythm_core::score_performance(&score, &played, &config).expect("legacy scoring works");
    let dp_scored = rhythm_core::score_performance_dp_v2(&score, &played, &config).expect("dp scoring works");
    assert_eq!(dp_scored.algorithm_version, SCORING_DP_V2_ALGORITHM_VERSION);
    assert_eq!(legacy.algorithm_version, SCORING_ALGORITHM_VERSION);
    // Same pairing, same sub-scores; only the identity string differs.
    assert_eq!(dp_scored.overall, legacy.overall);
    assert_eq!(dp_scored.pitch, legacy.pitch);
    assert_eq!(dp_scored.rhythm, legacy.rhythm);
}

#[test]
fn score_performance_dp_v2_recovers_late_phase_with_raw_errors() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0, 2000.0], &[C4, D4, E4, F4, G4]);
    let played = performed_events(&[(C4, 0.0), (D4, 800.0), (E4, 1300.0), (F4, 1800.0), (G4, 2300.0)]);
    let config = ScoringConfig::default();
    let report = rhythm_core::score_performance_dp_v2(&score, &played, &config).expect("dp scoring works");
    assert_eq!(report.algorithm_version, SCORING_DP_V2_ALGORITHM_VERSION);
    // 5 matches with +300 raw errors; nothing missing or extra.
    assert_eq!(report.pitch.correct, 5);
    assert_eq!(report.pitch.missed, 0);
    assert_eq!(report.pitch.extra, 0);
}

#[test]
fn score_performance_dp_v2_falls_back_to_legacy_on_resource_limit() {
    let score = score_events(&vec![3000.0; 20], &vec![C4; 20]);
    let played = performed_events(&vec![(C4, 3000.0); 20]);
    let config = ScoringConfig::default();
    let report = rhythm_core::score_performance_dp_v2(&score, &played, &config).expect("fallback scoring works");
    // Degraded run must be stamped with the LEGACY identity, never disguised
    // as a V2 result (PRD Gate D: 保留旧结果并标记 V2 未运行).
    assert_eq!(report.algorithm_version, SCORING_ALGORITHM_VERSION);
    let legacy = rhythm_core::score_performance(&score, &played, &config).expect("legacy scoring works");
    assert_eq!(report.overall, legacy.overall);
}

#[test]
fn to_legacy_alignment_maps_pairs_and_rest_window_extras() {
    // A rest-window extra sits strictly between two matched onsets.
    let score = score_events(&[0.0, 1500.0], &[C4, E4]);
    let played = performed_events(&[(C4, 0.0), (72, 700.0), (E4, 1500.0)]);
    let result = dp(&score, &played);
    let legacy = to_legacy_alignment(&result, &played);
    assert_eq!(legacy.pairs.len(), 2);
    assert_eq!(legacy.extra_performed_ids, vec!["p2".to_string()]);
    assert_eq!(legacy.rest_window_extra_ids, vec!["p2".to_string()]);
    assert!(legacy.pairs.iter().all(|pair| pair.pitch_matched));
}
