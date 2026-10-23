use crate::{CoreError, HitMatcher, Judgment, StrikeEvent, TargetHit};

#[derive(Debug, Clone, PartialEq)]
pub struct ReplayResult {
    pub judgments: Vec<Judgment>,
    pub target_count: usize,
    pub event_count: usize,
}

/// Deterministic final scoring. All raw events are sorted by occurrence time, then sequence.
/// Network arrival order is intentionally not used for the final score.
pub fn replay_score(
    targets: Vec<TargetHit>,
    mut events: Vec<StrikeEvent>,
) -> Result<ReplayResult, CoreError> {
    for event in &events { event.validate()?; }
    events.sort_by(|a, b| a.at_ms.total_cmp(&b.at_ms).then_with(|| a.seq.cmp(&b.seq)));
    let event_count = events.len();
    let target_count = targets.len();
    let mut matcher = HitMatcher::new(targets)?;
    let mut judgments = Vec::new();
    for event in &events {
        judgments.extend(matcher.ingest(event)?);
    }
    judgments.extend(matcher.finish());
    Ok(ReplayResult { judgments, target_count, event_count })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Grade, InputSource};

    fn target(index: usize, at_ms: f64) -> TargetHit {
        TargetHit { id: format!("t{index}"), index, at_ms, bar: None, beat: None, perfect_window_ms: 10.0, good_window_ms: 30.0, nominal_duration_ms: 375.0 }
    }
    fn event(seq: u64, at_ms: f64) -> StrikeEvent {
        StrikeEvent { seq, at_ms, source: InputSource::Midi, notes: vec![60], velocity: None }
    }

    #[test]
    fn replay_sorts_arrival_order_for_deterministic_final_grade() {
        let result = replay_score(vec![target(0, 100.0), target(1, 200.0)], vec![event(2, 200.0), event(1, 100.0)]).unwrap();
        assert_eq!(result.judgments[0].grade, Grade::Perfect);
        assert_eq!(result.judgments[1].grade, Grade::Perfect);
    }
}
