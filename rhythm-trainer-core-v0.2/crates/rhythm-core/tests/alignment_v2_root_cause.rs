//! Alignment-v2 P0 root-cause tests: freeze the CURRENT scoring_v1 cascade
//! behavior with an observation trace, and probe the live HitMatcher on the
//! same late-note shapes. Nothing here changes behavior — these tests are the
//! documented baseline that any alignment_v2 candidate must beat without
//! regressing the existing benchmark set.

use rhythm_core::{
    align_performances, align_performances_traced, AlignmentBranch, HitMatcher, Judgment,
    PerformedNoteV1, ScoreEvent, ScoringConfig, StrikeEvent,
};
use rhythm_core::{Grade, TargetHit};

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

fn branch_list(alignment: &rhythm_core::TracedAlignment) -> Vec<&'static str> {
    alignment.steps.iter().map(|step| step.branch.as_str()).collect()
}

/// PRD §5.2 `tl-late-300-phase`: one +300 ms phase shift at note 2, stable
/// intervals after. The frozen V1 answer must be pinned EXACTLY as observed so
/// any candidate change is a conscious, reviewed decision: s2 is marked missed
/// while p2 stays unconsumed, and every following note pairs one target late.
#[test]
fn late_300_phase_cascades_in_frozen_v1() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0, 2000.0], &[60, 62, 64, 65, 67]);
    let perf = performed(&[0.0, 800.0, 1300.0, 1800.0, 2300.0], &[60, 62, 64, 65, 67]);
    let traced = align_performances_traced(&score, &perf, &ScoringConfig::default()).unwrap();
    let result = &traced.result;

    // Cascade shape: s2 missed; every later note pairs one target late with a
    // constant -200 ms error AND is labeled WRONG_PITCH, because the shifted
    // pairing no longer aligns pitch sequences. The user sees wrong-pitch
    // errors for notes they played with correct pitch.
    assert_eq!(result.missed_score_event_ids, vec!["s2".to_string()]);
    assert_eq!(result.extra_performed_ids, vec!["p5".to_string()]);
    let pair_errors: Vec<(String, String, f64, bool)> = result.pairs.iter().map(|pair| {
        (pair.score_event_id.clone(), pair.performed_note_id.clone(), pair.onset_error_ms, pair.pitch_matched)
    }).collect();
    assert_eq!(pair_errors, vec![
        ("s1".into(), "p1".into(), 0.0, true),
        ("s3".into(), "p2".into(), -200.0, false),
        ("s4".into(), "p3".into(), -200.0, false),
        ("s5".into(), "p4".into(), -200.0, false),
    ]);

    // The trace must show the origin: MISS_WINDOW on (s2, p2, +300) — the
    // performed note was NOT consumed — followed by a shifted wrong-pitch run.
    let branches = branch_list(&traced);
    assert_eq!(branches, vec![
        "MATCH", "MISS_WINDOW", "WRONG_PITCH", "WRONG_PITCH", "WRONG_PITCH", "EXTRA_WINDOW",
    ]);
    let origin = traced.steps.iter().find(|step| step.branch == AlignmentBranch::MissWindow).unwrap();
    assert_eq!(origin.target_id, "s2");
    assert_eq!(origin.performed_id, "p2");
    assert!((origin.delta_ms - 300.0).abs() < 1e-9);
}

/// PRD §5.2 `tl-late-300-return`: an isolated late note, the player resumes
/// the original grid. V1 still mispairs: the late note steals the NEXT
/// target even though the player intended s2.
#[test]
fn late_300_return_mispairs_next_target_in_frozen_v1() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0], &[60, 62, 64, 65]);
    // p2 late by 300; p3, p4 back on the original grid.
    let perf = performed(&[0.0, 800.0, 1050.0, 1500.0], &[60, 62, 64, 65]);
    let traced = align_performances_traced(&score, &perf, &ScoringConfig::default()).unwrap();
    let result = &traced.result;
    // The pitch lookahead partially self-heals the return case: p2 (intended
    // for the missed s2) is consumed as an EXTRA because p3 — carrying s3's
    // pitch — is already inside s3's window. The late note is therefore
    // punished twice (target MISSED + note EXTRA) but the following notes
    // keep their own targets.
    let pair_errors: Vec<(String, String, f64, bool)> = result.pairs.iter().map(|pair| {
        (pair.score_event_id.clone(), pair.performed_note_id.clone(), pair.onset_error_ms, pair.pitch_matched)
    }).collect();
    assert_eq!(pair_errors, vec![
        ("s1".into(), "p1".into(), 0.0, true),
        ("s3".into(), "p3".into(), 50.0, true),
        ("s4".into(), "p4".into(), 0.0, true),
    ]);
    assert_eq!(result.missed_score_event_ids, vec!["s2".to_string()]);
    assert_eq!(result.extra_performed_ids, vec!["p2".to_string()]);
    assert_eq!(branch_list(&traced), vec![
        "MATCH", "MISS_WINDOW", "LOOKAHEAD_SKIP_PERFORMED", "MATCH", "MATCH",
    ]);
}

/// Early-note control (`tl-early-300`): an early note does NOT cascade —
/// it is consumed as an extra immediately. The asymmetry is the defect.
#[test]
fn early_300_is_consumed_without_cascade() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0, 2000.0], &[60, 62, 64, 65, 67]);
    let perf = performed(&[0.0, 200.0, 1000.0, 1500.0, 2000.0], &[60, 62, 64, 65, 67]);
    let traced = align_performances_traced(&score, &perf, &ScoringConfig::default()).unwrap();
    let result = &traced.result;
    assert_eq!(result.extra_performed_ids, vec!["p2".to_string()]);
    assert_eq!(result.missed_score_event_ids, vec!["s2".to_string()]);
    // Everything after the early note still pairs its own target.
    assert_eq!(result.pairs.iter().map(|pair| pair.score_event_id.as_str()).collect::<Vec<_>>(), vec!["s1", "s3", "s4", "s5"]);
    assert_eq!(branch_list(&traced), vec!["MATCH", "EXTRA_WINDOW", "MISS_WINDOW", "MATCH", "MATCH", "MATCH"]);
}

/// The traced and frozen entry points must agree exactly — the trace is
/// observation-only by construction.
#[test]
fn traced_and_frozen_results_are_identical() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0, 2000.0], &[60, 62, 64, 65, 67]);
    let perf = performed(&[0.0, 800.0, 1300.0, 1800.0, 2300.0], &[60, 62, 64, 65, 67]);
    let frozen = align_performances(&score, &perf, &ScoringConfig::default()).unwrap();
    let traced = align_performances_traced(&score, &perf, &ScoringConfig::default()).unwrap();
    assert_eq!(frozen, traced.result);
}

fn targets(onsets: &[f64]) -> Vec<TargetHit> {
    onsets.iter().enumerate().map(|(index, &at)| TargetHit {
        id: format!("t{}", index + 1),
        index,
        at_ms: at,
        bar: Some(1),
        beat: Some(index as f64 + 1.0),
        perfect_window_ms: 60.0,
        good_window_ms: 150.0,
        nominal_duration_ms: 400.0,
    }).collect()
}

fn strike(seq: u64, at_ms: f64) -> StrikeEvent {
    StrikeEvent { seq, at_ms, source: rhythm_core::InputSource::Midi, notes: vec![60], velocity: Some(90) }
}

fn grades(judgments: &[Judgment]) -> Vec<&'static str> {
    judgments.iter().map(|judgment| match judgment.grade {
        Grade::Perfect => "PERFECT",
        Grade::Good => "GOOD",
        Grade::Miss => "MISSED",
        Grade::Extra => "EXTRA",
    }).collect()
}

/// Live-path probe: HitMatcher does NOT mispair like the offline matcher, but
/// a +300 ms note (outside the 150 ms Good window) is judged EXTRA and the
/// target is expired as MISSED — the live feedback has its own, different
/// failure mode. Pinned here so alignment_v2 work cannot silently claim the
/// live path was fixed.
#[test]
fn live_hitmatcher_reports_extra_and_missed_for_late_note() {
    let mut matcher = HitMatcher::new(targets(&[0.0, 500.0, 1000.0, 1500.0, 2000.0])).unwrap();
    let mut all = Vec::new();
    // The on-time first note, the +300 note, then the resumed grid.
    for (seq, at) in [(1u64, 0.0), (2, 800.0), (3, 1000.0), (4, 1500.0), (5, 2000.0)] {
        all.push(matcher.ingest(&strike(seq, at)).unwrap());
        // Advance past each target window so expired misses surface like the
        // engine's tick loop does.
        all.push(matcher.advance(at + 100.0, 250.0).unwrap());
    }
    all.push(matcher.finish());
    let flat: Vec<&Judgment> = all.iter().flatten().collect();
    let labels = flat.iter().map(|judgment| {
        (judgment.target_index, grades(std::slice::from_ref(judgment))[0])
    }).collect::<Vec<_>>();
    // p1 perfect on t1.
    assert_eq!(labels[0], (Some(0), "PERFECT"));
    // The +300 note is an EXTRA (no target), and t2 expires MISSED.
    assert!(labels.iter().any(|(target, grade)| *target == Some(1) && *grade == "MISSED"));
    assert_eq!(labels.iter().filter(|(_, grade)| *grade == "EXTRA").count(), 1);
    // Notes 3–5 land on their own targets: the live path never shifts.
    assert!(labels.iter().any(|(target, grade)| *target == Some(2) && (*grade == "PERFECT" || *grade == "GOOD")));
    assert!(labels.iter().any(|(target, grade)| *target == Some(3) && (*grade == "PERFECT" || *grade == "GOOD")));
    assert!(labels.iter().any(|(target, grade)| *target == Some(4) && (*grade == "PERFECT" || *grade == "GOOD")));
}
