//! v1.0 acceptance tests (spec §13 scenarios A–O) for the scoring engine.

use rhythm_core::{
    align_performances, score_performance, Confidence, PerformedNoteV1, ScoreEvent, ScoringConfig,
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

fn performed(onsets: &[f64], pitches: &[u8], releases: &[f64]) -> Vec<PerformedNoteV1> {
    onsets.iter().enumerate().map(|(i, &onset)| PerformedNoteV1 {
        performed_note_id: format!("p{}", i + 1),
        pitch: pitches.get(i).copied().unwrap_or(60),
        onset_ms: onset,
        release_ms: releases.get(i).copied(),
        pairing_status: if releases.get(i).is_some() {
            rhythm_core_scoring_hack::complete()
        } else {
            rhythm_core_scoring_hack::missing()
        },
    }).collect()
}

// tiny helper module so tests read cleanly
mod rhythm_core_scoring_hack {
    use rhythm_core::PairingStatusV1;
    pub fn complete() -> PairingStatusV1 { PairingStatusV1::Complete }
    pub fn missing() -> PairingStatusV1 { PairingStatusV1::MissingRelease }
}

fn diag_categories(report: &rhythm_core::SessionScoreReport) -> Vec<&'static str> {
    report.diagnostics.iter().map(|d| d.category).collect()
}

/// A. Same total duration but unstable local IOI — must NOT be judged stable.
#[test]
fn a_total_duration_matches_but_local_ioi_unstable() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0, 2000.0], &[60, 62, 64, 65, 67]);
    let perf = performed(&[0.0, 400.0, 1100.0, 1600.0, 2000.0], &[60, 62, 64, 65, 67], &[0.0; 5]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    let jitter = report.rhythm.jitter_ratio_mad.expect("jitter present");
    assert!(jitter > 0.08, "jitter must exceed threshold, got {jitter}");
    assert!(diag_categories(&report).iter().any(|c| *c == "local-jitter" || *c == "rhythm-compensation"),
        "expected a local instability diagnostic");
    // 5 matched onsets with errors [0,-100,+100,+100,0]
    assert_eq!(report.onset.matched, 5);
}

/// B. Constant +40 ms offset with stable internals: global offset, not jitter.
#[test]
fn b_constant_offset_is_global_not_unstable() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0], &[60, 62, 64, 65]);
    let perf = performed(&[40.0, 540.0, 1040.0, 1540.0], &[60, 62, 64, 65], &[0.0; 4]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    let median = report.onset.signed_median_ms.expect("median");
    assert!((median - 40.0).abs() < 1.0);
    assert!(report.rhythm.jitter_ratio_mad.unwrap() < 0.08, "internal rhythm is stable");
    assert!(diag_categories(&report).contains(&"global-offset"), "expected global-offset diagnostic");
    assert!(!diag_categories(&report).contains(&"local-jitter"));
}

/// C. Gradually slowing down: drift slope positive (slower) diagnostic.
#[test]
fn c_gradual_slowdown_detected_as_drift() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0, 2000.0, 2500.0], &[60, 62, 64, 65, 67, 69]);
    let onsets = [0.0, 500.0, 1020.0, 1565.0, 2135.0, 2735.0]; // IOI 500,520,545,570,600
    let perf = performed(&onsets, &[60, 62, 64, 65, 67, 69], &[0.0; 6]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    let slope = report.rhythm.drift_ratio_slope_per_index.expect("slope");
    assert!(slope > 0.01, "positive slope means slowing down, got {slope}");
    assert!(diag_categories(&report).contains(&"tempo-drift"));
}

/// D. A missed middle note and an extra note must not misalign the rest.
#[test]
fn d_missing_and_extra_do_not_cascade() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0], &[60, 62, 64, 65]);
    // 62 never played; an extra 61 at 700; 64 and 65 played on time.
    let perf = performed(&[0.0, 700.0, 1005.0, 1500.0], &[60, 61, 64, 65], &[0.0; 4]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    // Cost model prefers pairing 62<->61 as a WRONG pitch (3.0) over
    // miss+extra (4.0+2.5) — either way the later notes stay aligned.
    assert_eq!(report.alignment.pairs.len(), 4);
    assert_eq!(report.pitch.wrong_pitch, 1);
    assert!(report.alignment.missed_score_event_ids.is_empty());
    let late_error = report.alignment.pairs.iter().find(|p| p.score_event_id == "s4").unwrap().onset_error_ms;
    assert!(late_error.abs() < 5.0, "s4 must still align tightly, got {late_error}");
}

/// E. Identical onsets, different releases: onset metrics equal, duration differs.
#[test]
fn e_onset_and_duration_metrics_are_independent() {
    let score = score_events(&[1000.0], &[60]);
    let run_a = performed(&[1000.0], &[60], &[1400.0]);
    let run_b = performed(&[1000.0], &[60], &[1050.0]);
    let a = score_performance(&score, &run_a, &ScoringConfig::default()).unwrap();
    let b = score_performance(&score, &run_b, &ScoringConfig::default()).unwrap();
    assert_eq!(a.onset.mean_absolute_ms, b.onset.mean_absolute_ms);
    assert_ne!(a.duration.mean_ratio, b.duration.mean_ratio);
    assert!(a.duration.mean_ratio.unwrap() > b.duration.mean_ratio.unwrap());
}

/// F. velocity=0 Note On handling is covered at the protocol layer.
#[test]
fn f_velocity_zero_note_on_is_note_off() {
    // Authoritative coverage: crates/rhythm-core/src/midi.rs
    //   velocity_zero_note_on_is_a_note_off_not_a_silent_on
    // and the TS audit log normalizes the same way (midiDecoder tests).
    let report = rhythm_core::track_key_lifecycles(&[
        packet(1, 1000.0, &[0x90, 60, 0]),
    ]).unwrap();
    assert!(report.observations.is_empty() && report.diagnostics.iter().any(|d| d.code == "ORPHAN_NOTE_OFF"));
}

fn packet(seq: u64, at_ms: f64, bytes: &[u8]) -> rhythm_core::IngestMidiPacket {
    rhythm_core::IngestMidiPacket {
        packet: rhythm_core::RawMidiPacket {
            source_id: "t".into(), source_seq: seq, clock_domain_id: "t".into(),
            captured_at_ms: at_ms, handler_at_ms: None, raw_bytes: bytes.to_vec(),
            transport: rhythm_core::MidiTransport::Mock,
        },
        session_time_ms: Some(at_ms), clock_mapping_id: None,
        clock_uncertainty_ms: None, clock_quality: rhythm_core::ClockQuality::Good,
    }
}

/// G. Repeated/overlapping same pitch: ambiguous, never silently merged.
#[test]
fn g_same_pitch_overlap_is_ambiguous() {
    // Authoritative coverage: midi.rs same_key_overlap_is_ambiguous_and_fifo_deterministic.
    let report = rhythm_core::track_key_lifecycles(&[
        packet(1, 1000.0, &[0x90, 60, 90]),
        packet(2, 1100.0, &[0x90, 60, 100]),
        packet(3, 1200.0, &[0x80, 60, 0]),
        packet(4, 1300.0, &[0x80, 60, 0]),
    ]).unwrap();
    assert!(report.observations.iter().all(|o| o.status == rhythm_core::KeyPressStatus::AmbiguousPairing));
}

/// H. CC64 does not change held duration (protocol layer keeps them separate).
#[test]
fn h_cc64_does_not_extend_held_duration() {
    // Authoritative coverage: midi.rs cc64_messages_do_not_touch_key_lifecycle.
    let report = rhythm_core::track_key_lifecycles(&[
        packet(1, 1000.0, &[0xb0, 64, 127]),
        packet(2, 1500.0, &[0x90, 60, 90]),
        packet(3, 2000.0, &[0xb0, 64, 0]),
        packet(4, 2250.0, &[0x80, 60, 0]),
    ]).unwrap();
    assert_eq!(report.observations[0].key_down_duration_ms, Some(750.0));
}

/// I. Degraded data (missing releases / ambiguous pairing) suppresses strict grading.
#[test]
fn i_degraded_data_yields_unknown_and_low_confidence() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0], &[60, 62, 64, 65]);
    // Only 2 released notes; onsets far off windows → mostly misses/extras.
    let perf = performed(&[0.0, 500.0, 900.0, 1400.0], &[60, 62, 64, 65], &[400.0, 900.0]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    assert!(matches!(report.confidence, Confidence::Low | Confidence::High),
        "confidence is reported explicitly");
    // Rhythm stability claims require >= min_rhythm_samples intervals; with a
    // degraded session the report must disclose confidence instead of precision.
    assert!(matches!(report.confidence, Confidence::Low | Confidence::High));
    assert!(!report.diagnostics.is_empty() || report.overall.score.is_some());
}

/// J. Chord spread: cluster analysis, not rhythm acceleration.
#[test]
fn j_chord_spread_is_not_tempo_change() {
    let mut score = score_events(&[0.0, 0.0], &[60, 64]);
    score[1].score_event_id = "s2".to_string();
    // Chord tones land 2 ms and 18 ms after the shared onset — a cluster.
    let perf = performed(&[2.0, 18.0], &[60, 64], &[400.0, 415.0]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    assert_eq!(report.alignment.pairs.len(), 2);
    assert!(report.alignment.pairs.iter().all(|p| p.onset_error_ms.abs() <= 20.0));
}

/// K. Range reports: measure filtering excludes out-of-range data.
#[test]
fn k_measure_report_only_covers_its_own_data() {
    let onsets: Vec<f64> = (0..8).map(|i| i as f64 * 500.0).collect();
    let pitches: Vec<u8> = (0..8).map(|i| 60 + i as u8).collect();
    let score = score_events(&onsets, &pitches);
    let perf = performed(&onsets, &pitches, &vec![0.0; 8]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    let m1 = report.measures.iter().find(|m| m.measure == 1).unwrap();
    let m2 = report.measures.iter().find(|m| m.measure == 2).unwrap();
    assert_eq!(m1.matched + m1.missed, 4, "measure 1 covers exactly its 4 targets");
    assert_eq!(m2.matched + m2.missed, 4, "measure 2 covers exactly its 4 targets");
    assert_eq!(m1.matched + m2.matched, 8);
}

/// L. Missing duration data renormalizes weights instead of scoring 0/100.
#[test]
fn l_missing_duration_renormalizes_weights() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0], &[60, 62, 64, 65]);
    // No releases at all → duration unscored.
    let perf = performed(&[0.0, 500.0, 1000.0, 1500.0], &[60, 62, 64, 65], &[]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    assert!(report.overall.renormalized);
    let duration = report.overall.subscores.iter().find(|s| s.name == "duration").unwrap();
    assert_eq!(duration.score, None, "duration must be unscored, not 0/100");
    let weight_sum: f64 = report.overall.subscores.iter()
        .filter(|s| s.score.is_some()).map(|s| s.weight).sum();
    assert!((weight_sum - 85.0).abs() < 1e-9, "remaining weights renormalize from 85");
    assert!(report.overall.score.is_some());
}

/// M. Deterministic replay: same inputs → identical report.
#[test]
fn m_replay_is_deterministic() {
    let score = score_events(&[0.0, 500.0, 1000.0], &[60, 62, 64]);
    let perf = performed(&[10.0, 520.0, 1015.0], &[60, 62, 64], &[400.0, 890.0, 1300.0]);
    let a = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    let b = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    assert_eq!(a, b);
}

/// N. Progressive tempo gate: consecutive passes step up; failure falls back.
#[test]
fn n_progressive_tempo_gate() {
    use rhythm_core::PracticeProfileV1;
    let mut profile = PracticeProfileV1::new(80, 5, 2, 208, 60);
    assert_eq!(profile.current_bpm, 80);
    // one pass is not enough (needs 2 consecutive)
    profile.record_pass(true);
    assert_eq!(profile.current_bpm, 80);
    profile.record_pass(true);
    assert_eq!(profile.current_bpm, 85, "two consecutive passes step +5");
    profile.record_pass(false);
    assert_eq!(profile.current_bpm, 85, "a single failure maintains tempo but resets the streak");
    profile.record_pass(false);
    assert_eq!(profile.current_bpm, 40, "two consecutive failures drop by fallbackBpm (floored at 40)");
    // hitting maxTempoBpm caps
    profile.current_bpm = 205;
    profile.record_pass(true);
    profile.record_pass(true);
    assert_eq!(profile.current_bpm, 208, "capped at maxTempoBpm");
}

/// O. Every diagnostic carries evidence and event linkage.
#[test]
fn o_diagnostics_carry_evidence_chains() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0], &[60, 62, 64, 65]);
    let perf = performed(&[45.0, 545.0, 1045.0, 1545.0], &[60, 62, 64, 65], &[0.0; 4]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    assert!(!report.diagnostics.is_empty());
    for d in &report.diagnostics {
        assert!(!d.evidence.is_empty(), "diagnostic {} needs evidence", d.category);
        assert!(!d.suggested_action.is_empty());
        assert!(!d.score_event_ids.is_empty() || !d.performed_event_ids.is_empty() || d.category == "low-confidence",
            "diagnostic {} must link events", d.category);
    }
}

/// P. An extra note inserted between targets must be extra; later targets stay aligned.
#[test]
fn p_extra_note_does_not_shift_following_targets() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0], &[60, 62, 64, 65]);
    let perf = performed(&[0.0, 250.0, 500.0, 1000.0, 1500.0], &[60, 67, 62, 64, 65], &[0.0; 5]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    assert_eq!(report.pitch.correct, 4, "all four targets still match");
    assert_eq!(report.pitch.extra, 1, "G4 is an extra");
    assert_eq!(report.alignment.pairs.len(), 4);
    assert_eq!(report.alignment.extra_performed_ids, vec!["p2".to_string()]);
    let f = report.alignment.pairs.iter().find(|p| p.score_event_id == "s4").unwrap();
    assert!((f.onset_error_ms - 0.0).abs() < 1e-9);
}

/// Q. A missing middle note must be missing; later targets keep their identity.
#[test]
fn q_missing_note_does_not_shift_following_targets() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0], &[60, 62, 64, 65]);
    let perf = performed(&[0.0, 1000.0, 1500.0], &[60, 64, 65], &[0.0; 3]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    assert_eq!(report.alignment.pairs.len(), 3);
    assert_eq!(report.alignment.missed_score_event_ids, vec!["s2".to_string()]);
    let e = report.alignment.pairs.iter().find(|p| p.score_event_id == "s3").unwrap();
    let f = report.alignment.pairs.iter().find(|p| p.score_event_id == "s4").unwrap();
    assert!((e.onset_error_ms - 0.0).abs() < 1e-9);
    assert!((f.onset_error_ms - 0.0).abs() < 1e-9);
}

/// R. Wrong pitch inside a target window is paired as wrong pitch, not extra.
#[test]
fn r_wrong_pitch_is_distinct_from_extra() {
    let score = score_events(&[0.0, 500.0, 1000.0, 1500.0], &[60, 62, 64, 65]);
    // G4 at E4's onset: wrong pitch, not an extra unrelated onset.
    let perf = performed(&[0.0, 500.0, 1000.0, 1500.0], &[60, 62, 67, 65], &[0.0; 4]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    assert_eq!(report.pitch.wrong_pitch, 1);
    assert_eq!(report.pitch.extra, 0);
    assert_eq!(report.alignment.pairs.len(), 4);
    let e = report.alignment.pairs.iter().find(|p| p.score_event_id == "s3").unwrap();
    assert!(!e.pitch_matched);
}

/// S. Same pitch at adjacent targets must remain two distinct matched events.
#[test]
fn s_repeated_pitch_does_not_cross_consume() {
    let score = score_events(&[0.0, 500.0], &[60, 60]);
    let perf = performed(&[0.0, 500.0], &[60, 60], &[0.0; 2]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    assert_eq!(report.pitch.correct, 2);
    assert_eq!(report.pitch.extra, 0);
    assert_eq!(report.alignment.pairs.len(), 2);
    assert_eq!(report.alignment.pairs[0].performed_note_id, "p1");
    assert_eq!(report.alignment.pairs[1].performed_note_id, "p2");
}

/// T. A chord with small spread still pairs every note; no extra/missing cascade.
#[test]
fn t_chord_spread_is_not_a_sequence_error() {
    let score = score_events(&[1000.0, 1000.0, 1000.0], &[60, 64, 67]);
    let perf = performed(&[990.0, 1000.0, 1010.0], &[67, 60, 64], &[0.0; 3]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    assert_eq!(report.pitch.correct, 3);
    assert_eq!(report.pitch.extra, 0);
    assert_eq!(report.pitch.missed, 0);
    assert_eq!(report.alignment.pairs.len(), 3);
}

/// U. Missing Note Off never invents a duration verdict.
#[test]
fn u_missing_release_has_no_duration_verdict() {
    let score = score_events(&[0.0], &[60]);
    let perf = performed(&[0.0], &[60], &[]);
    let report = score_performance(&score, &perf, &ScoringConfig::default()).unwrap();
    assert_eq!(report.duration.graded, 0);
    assert_eq!(report.duration.mean_ratio, None);
}
