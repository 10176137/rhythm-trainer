//! Repeatable software-performance benchmark required by the PRD:
//! 10,000 targets + 10,000 events through the full offline pipeline
//! (replay matching, statistics, timing features, diagnosis) with a
//! p95 wall-clock budget of 100 ms per iteration.
//!
//! This measures computation speed only. It says nothing about MIDI capture
//! accuracy, clock mapping quality, or audio output latency.

use std::time::Instant;

use rhythm_core::{
    calculate_stats, diagnose_timing, extract_timing_features, replay_score, AtomKind,
    DiagnosticContext, InputSource, JudgmentProfile, RhythmAtom, RhythmPattern, StrikeEvent,
};

const TARGET_COUNT: usize = 10_000;
const EVENT_COUNT: usize = 10_000;
const ITERATIONS: usize = 30;
/// PRD budget: p95 per-iteration compute time below 100 ms on the reference dev machine.
const P95_BUDGET_MS: f64 = 100.0;

fn dense_sixteenth_pattern(atom_count: usize) -> RhythmPattern {
    let atoms = (0..atom_count).map(|index| RhythmAtom {
        start_tick: (index as u64) * 240,
        duration_ticks: 240,
        kind: AtomKind::Note,
        bar: (index / 16 + 1) as u32,
        beat: (index % 4 + 1) as f64,
    }).collect();
    RhythmPattern { id: "bench-sixteenths".to_string(), ticks_per_quarter: 960, atoms }
}

fn bench_events(targets: &[rhythm_core::TargetHit]) -> Vec<StrikeEvent> {
    // Deterministic pseudo-random errors keep every run comparable.
    let mut state = 0x5EED_1234u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    (0..EVENT_COUNT.min(targets.len())).map(|index| {
        let error_ms = ((next() % 121) as f64) - 60.0; // -60..=60 ms
        StrikeEvent {
            seq: index as u64 + 1,
            at_ms: (targets[index].at_ms + error_ms).max(0.0),
            source: InputSource::Midi,
            notes: vec![60],
            velocity: Some(90),
        }
    }).collect()
}

fn percentile_95(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(f64::total_cmp);
    let position = ((samples.len() as f64) * 0.95).ceil() as usize;
    samples[position.saturating_sub(1).min(samples.len() - 1)]
}

#[test]
fn replay_of_ten_thousand_targets_and_events_meets_p95_budget() {
    let targets = rhythm_core::build_schedule(
        &dense_sixteenth_pattern(TARGET_COUNT),
        160.0,
        2_000.0,
        JudgmentProfile::standard(),
    ).expect("dense benchmark schedule builds");

    let mut iteration_times = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let events = bench_events(&targets);
        let started = Instant::now();
        let replay = replay_score(targets.clone(), events.clone()).expect("replay succeeds");
        let stats = calculate_stats(replay.target_count, &replay.judgments);
        let context = DiagnosticContext::new(true);
        let features = extract_timing_features(&replay.judgments, &context);
        let report = diagnose_timing(&replay.judgments, &context);
        iteration_times.push(started.elapsed().as_secs_f64() * 1_000.0);

        // Sanity: the workload actually scored something. With ±60 ms uniform
        // errors against ~±42 ms effective windows (dense sixteenths at 160 BPM),
        // a healthy pipeline still clears half the targets.
        assert_eq!(replay.target_count, TARGET_COUNT);
        assert!(stats.target_hit_rate > 0.5);
        assert!(features.target_count > 0);
        assert!(!report.diagnostics.is_empty());
    }

    let p95 = percentile_95(iteration_times.clone());
    println!(
        "benchmark: {TARGET_COUNT} targets + {EVENT_COUNT} events, {ITERATIONS} iterations, \
         min={:.2}ms p95={:.2}ms max={:.2}ms (budget {P95_BUDGET_MS:.0}ms)",
        iteration_times.iter().cloned().fold(f64::INFINITY, f64::min),
        p95,
        iteration_times.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
    );
    assert!(
        p95 < P95_BUDGET_MS,
        "p95 replay+stats+diagnosis time {p95:.2} ms exceeded the {P95_BUDGET_MS} ms software-performance budget"
    );
}
