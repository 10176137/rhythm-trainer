use rhythm_core::{
    build_schedule, AtomKind, InputSource, JudgmentProfile, RhythmAtom, RhythmPattern,
    SessionEngine, StrikeEvent,
};

#[test]
fn one_bar_pattern_can_be_scored_and_replayed() {
    let pattern = RhythmPattern {
        id: "l1-quarter-notes".into(),
        ticks_per_quarter: 960,
        atoms: vec![
            RhythmAtom { start_tick: 0, duration_ticks: 960, kind: AtomKind::Note, bar: 1, beat: 1.0 },
            RhythmAtom { start_tick: 960, duration_ticks: 960, kind: AtomKind::Note, bar: 1, beat: 2.0 },
            RhythmAtom { start_tick: 1920, duration_ticks: 960, kind: AtomKind::Note, bar: 1, beat: 3.0 },
            RhythmAtom { start_tick: 2880, duration_ticks: 960, kind: AtomKind::Note, bar: 1, beat: 4.0 },
        ],
    };
    let targets = build_schedule(&pattern, 120.0, 1_000.0, JudgmentProfile::standard()).unwrap();
    let mut session = SessionEngine::new(targets, 32, 35.0).unwrap();
    session.start().unwrap();
    for (seq, target_at) in [1_000.0, 1_503.0, 1_998.0, 2_510.0].iter().enumerate() {
        session.push_event(StrikeEvent {
            seq: (seq + 1) as u64,
            at_ms: *target_at,
            source: InputSource::Midi,
            notes: vec![60],
            velocity: Some(80),
        }).unwrap();
    }
    let report = session.finish().unwrap();
    assert_eq!(report.target_count, 4);
    assert!(report.trustworthy);
    assert_eq!(report.stats.good_count + report.stats.perfect_count, 4);
}
