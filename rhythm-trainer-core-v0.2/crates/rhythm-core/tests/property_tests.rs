//! Property-style tests over pseudo-random, but deterministic, schedules and
//! event streams.
//!
//! These tests check INVARIANTS of the core outputs (counts, uniqueness,
//! window consistency, determinism, order independence). They deliberately do
//! not reimplement the matching algorithm: a second matching implementation
//! would drift from the real one and prove nothing.

use rhythm_core::{
    replay_score, AtomKind, InputSource, Judgment, JudgmentProfile, RhythmAtom, RhythmPattern,
    RingBuffer, StrikeEvent, TargetHit,
};

/// xorshift64* — deterministic, dependency-free pseudo-random generator.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self { Self(seed.max(1)) }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, bound: u64) -> u64 { self.next_u64() % bound.max(1) }

    /// Uniform-ish float in [0, 1).
    fn fraction(&mut self) -> f64 { (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64 }

    fn range(&mut self, low: f64, high: f64) -> f64 { low + (high - low) * self.fraction() }
}

/// Builds a random valid pattern: sequential atoms on a shared tick axis with
/// random durations, occasional rests, and occasional same-tick chord atoms.
fn random_pattern(rng: &mut Rng) -> RhythmPattern {
    let atom_count = 8 + rng.below(40) as usize;
    let subdivision = [120, 240, 360, 480, 960][rng.below(5) as usize];
    let mut atoms = Vec::with_capacity(atom_count);
    let mut tick: u64 = 0;
    for index in 0..atom_count {
        let kind = if rng.fraction() < 0.2 { AtomKind::Rest } else { AtomKind::Note };
        atoms.push(RhythmAtom {
            start_tick: tick,
            duration_ticks: subdivision,
            kind,
            bar: (index / 4 + 1) as u32,
            beat: (index % 4 + 1) as f64,
        });
        // Occasionally add a second atom at the same tick (a chord/voice).
        if kind == AtomKind::Note && rng.fraction() < 0.15 {
            atoms.push(RhythmAtom {
                start_tick: tick,
                duration_ticks: subdivision,
                kind: AtomKind::Note,
                bar: (index / 4 + 1) as u32,
                beat: (index % 4 + 1) as f64,
            });
        }
        tick += subdivision * (1 + rng.below(2));
    }
    RhythmPattern { id: format!("property-{tick}"), ticks_per_quarter: 960, atoms }
}

fn random_profile(rng: &mut Rng) -> JudgmentProfile {
    match rng.below(3) {
        0 => JudgmentProfile::strict(),
        1 => JudgmentProfile::standard(),
        _ => JudgmentProfile::relaxed(),
    }
}

fn random_targets(rng: &mut Rng) -> Vec<TargetHit> {
    let pattern = random_pattern(rng);
    let bpm = rng.range(40.0, 200.0);
    let start = rng.range(0.0, 5_000.0);
    rhythm_core::build_schedule(&pattern, bpm, start, random_profile(rng)).unwrap()
}

/// Generates one event per target with probability `hit_probability`, with a
/// signed error drawn from `error_range_ms`, plus `extra_count` stray events
/// placed at random times after the first target.
fn events_for_targets(rng: &mut Rng, targets: &[TargetHit], hit_probability: f64, error_range_ms: f64, extra_count: usize) -> Vec<StrikeEvent> {
    let mut events = Vec::new();
    let mut seq: u64 = 1;
    for target in targets {
        if rng.fraction() < hit_probability {
            events.push(StrikeEvent {
                seq,
                at_ms: (target.at_ms + rng.range(-error_range_ms, error_range_ms)).max(0.0),
                source: InputSource::Midi,
                notes: vec![60],
                velocity: Some(80),
            });
            seq += 1;
        }
    }
    if let (Some(first), Some(last)) = (targets.first(), targets.last()) {
        for _ in 0..extra_count {
            events.push(StrikeEvent {
                seq,
                at_ms: rng.range(first.at_ms, last.at_ms + 500.0),
                source: InputSource::Keyboard,
                notes: Vec::new(),
                velocity: None,
            });
            seq += 1;
        }
    }
    events
}

/// Checks invariants that must hold for ANY matcher output.
fn assert_output_invariants(targets: &[TargetHit], events: &[StrikeEvent], judgments: &[Judgment]) {
    use rhythm_core::Grade;

    let mut matched_target_ids: Vec<&str> = Vec::new();
    let mut matched_strike_seqs: Vec<u64> = Vec::new();
    let mut perfect = 0;
    let mut good = 0;
    let mut miss = 0;
    let mut extra = 0;

    for judgment in judgments {
        match judgment.grade {
            Grade::Perfect | Grade::Good => {
                let target_id = judgment.target_id.as_deref().expect("matched judgment has target id");
                let index = judgment.target_index.expect("matched judgment has target index");
                let error = judgment.error_ms.expect("matched judgment has error");
                let target = &targets[index];
                assert_eq!(target.id, target_id, "target id and index must agree");
                assert!(
                    error.abs() <= target.good_window_ms + 1e-9,
                    "matched error {error} exceeds good window {}",
                    target.good_window_ms
                );
                let is_perfect = error.abs() <= target.perfect_window_ms + 1e-9;
                assert_eq!(is_perfect, judgment.grade == Grade::Perfect, "grade matches window boundaries");
                matched_target_ids.push(target_id);
                matched_strike_seqs.push(judgment.strike_seq.expect("matched judgment has strike seq"));
                if judgment.grade == Grade::Perfect { perfect += 1 } else { good += 1 };
            }
            Grade::Miss => {
                assert!(judgment.strike_seq.is_none(), "miss must not consume an event");
                assert!(judgment.error_ms.is_none());
                miss += 1;
            }
            Grade::Extra => {
                assert!(judgment.target_id.is_none(), "extra must not claim a target");
                assert!(judgment.error_ms.is_none());
                extra += 1;
            }
        }
    }

    assert_eq!(perfect + good + miss, targets.len(), "every target resolves exactly once");
    let mut sorted_ids = matched_target_ids.clone();
    sorted_ids.sort();
    sorted_ids.dedup();
    assert_eq!(sorted_ids.len(), matched_target_ids.len(), "one event matches at most one target per target");
    let mut sorted_seqs = matched_strike_seqs.clone();
    sorted_seqs.sort();
    sorted_seqs.dedup();
    assert_eq!(sorted_seqs.len(), matched_strike_seqs.len(), "one target is matched by at most one event");
    assert_eq!(extra, events.len() - matched_strike_seqs.len(), "unmatched events are exactly the extras");
}

fn judgment_fingerprint(judgments: &[Judgment]) -> Vec<(String, Option<u64>, &'static str, Option<f64>)> {
    let mut fingerprints: Vec<_> = judgments.iter().map(|j| (
        j.target_id.clone().unwrap_or_default(),
        j.strike_seq,
        j.grade.as_str(),
        j.error_ms.map(|e| (e * 1e6).round() / 1e6),
    )).collect();
    fingerprints.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    fingerprints
}

#[test]
fn schedules_are_strictly_increasing_with_non_overlapping_windows() {
    let mut rng = Rng::new(0xC0FFEE);
    for _ in 0..200 {
        let targets = random_targets(&mut rng);
        for pair in targets.windows(2) {
            assert!(pair[0].at_ms < pair[1].at_ms, "target times strictly increase");
            assert!(
                pair[0].at_ms + pair[0].good_window_ms < pair[1].at_ms - pair[1].good_window_ms,
                "adjacent effective windows never overlap"
            );
        }
        for target in &targets {
            assert!(target.perfect_window_ms >= 0.0);
            assert!(target.good_window_ms >= target.perfect_window_ms);
        }
    }
}

#[test]
fn replay_output_invariants_hold_for_random_streams() {
    let mut rng = Rng::new(0xABCDEF01);
    for _ in 0..200 {
        let targets = random_targets(&mut rng);
        let hit_probability = rng.range(0.5, 1.0);
        let extra_count = rng.below(6) as usize;
        let events = events_for_targets(&mut rng, &targets, hit_probability, 80.0, extra_count);
        let result = replay_score(targets.clone(), events.clone()).unwrap();
        assert_output_invariants(&targets, &events, &result.judgments);
    }
}

#[test]
fn replay_is_deterministic_and_arrival_order_independent() {
    let mut rng = Rng::new(0x1234_5678);
    for _ in 0..100 {
        let targets = random_targets(&mut rng);
        let events = events_for_targets(&mut rng, &targets, 0.8, 80.0, 5);

        let first = replay_score(targets.clone(), events.clone()).unwrap();
        let second = replay_score(targets.clone(), events.clone()).unwrap();
        assert_eq!(judgment_fingerprint(&first.judgments), judgment_fingerprint(&second.judgments));

        // Shuffle the arrival order: the final score sorts by occurrence time
        // and sequence, so grades must not change.
        let mut shuffled = events.clone();
        for index in (1..shuffled.len()).rev() {
            let swap = rng.below((index + 1) as u64) as usize;
            shuffled.swap(index, swap);
        }
        let reordered = replay_score(targets.clone(), shuffled).unwrap();
        assert_eq!(
            judgment_fingerprint(&first.judgments),
            judgment_fingerprint(&reordered.judgments),
            "final score must not depend on network arrival order"
        );
    }
}

#[test]
fn dense_random_streams_never_violate_matcher_preconditions() {
    // Sixteenth-note density at high BPM shrinks windows aggressively; the
    // schedule builder must still produce a matcher-acceptable schedule.
    let mut rng = Rng::new(0xDEAD_BEEF);
    for _ in 0..100 {
        let targets = random_targets(&mut rng);
        let events = events_for_targets(&mut rng, &targets, 1.0, 40.0, 0);
        let result = replay_score(targets, events).unwrap();
        // No panic, no error: overlapping windows would have failed construction.
        assert!(!result.judgments.is_empty());
    }
}

#[test]
fn ring_buffer_preserves_fifo_order_under_random_push_pop() {
    let mut rng = Rng::new(0xFEED_FACE);
    for _ in 0..100 {
        let capacity = 1 + rng.below(16) as usize;
        let mut queue = RingBuffer::new(capacity).unwrap();
        let mut mirror: std::collections::VecDeque<u64> = Default::default();
        for value in 0..200u64 {
            if rng.fraction() < 0.6 || queue.is_full() {
                if let Some(popped) = queue.pop() {
                    assert_eq!(popped, mirror.pop_front().expect("mirror agrees on emptiness"));
                } else {
                    assert!(mirror.is_empty());
                }
            }
            let result = queue.push(value);
            match result {
                Ok(()) => mirror.push_back(value),
                Err(returned) => {
                    assert_eq!(returned, value, "overflow returns the value, never drops silently");
                    assert!(queue.is_full());
                }
            }
        }
        assert_eq!(queue.drain().into_iter().collect::<Vec<_>>(), mirror.into_iter().collect::<Vec<_>>());
    }
}
