use crate::{CoreError, Grade, Judgment, StrikeEvent, TargetHit};

/// Deterministic, order-preserving matcher for non-overlapping target windows.
/// Input events MUST be ordered by occurrence timestamp. Offline replay sorts events first.
#[derive(Debug, Clone)]
pub struct HitMatcher {
    targets: Vec<TargetHit>,
    cursor: usize,
    last_hit_at_ms: Option<f64>,
    finalized_through_ms: Option<f64>,
}

impl HitMatcher {
    pub fn new(targets: Vec<TargetHit>) -> Result<Self, CoreError> {
        if targets.is_empty() {
            return Err(CoreError::InvalidTargetSchedule("at least one target is required".to_string()));
        }
        for (index, target) in targets.iter().enumerate() {
            if !target.at_ms.is_finite() || target.at_ms < 0.0 {
                return Err(CoreError::InvalidTargetSchedule("target time must be finite and non-negative".to_string()));
            }
            if !target.good_window_ms.is_finite()
                || !target.perfect_window_ms.is_finite()
                || target.perfect_window_ms < 0.0
                || target.good_window_ms < target.perfect_window_ms
            {
                return Err(CoreError::InvalidTargetSchedule("invalid target windows".to_string()));
            }
            if target.index != index {
                return Err(CoreError::InvalidTargetSchedule("target indexes must be contiguous and zero-based".to_string()));
            }
            if index > 0 {
                let previous = &targets[index - 1];
                if target.at_ms <= previous.at_ms {
                    return Err(CoreError::InvalidTargetSchedule("target times must be strictly increasing".to_string()));
                }
                // Windows are inclusive in matching, so even touching windows are ambiguous.
                if previous.at_ms + previous.good_window_ms >= target.at_ms - target.good_window_ms {
                    return Err(CoreError::InvalidTargetSchedule("adjacent Good windows overlap; narrow windows before creating matcher".to_string()));
                }
            }
        }
        Ok(Self { targets, cursor: 0, last_hit_at_ms: None, finalized_through_ms: None })
    }

    pub fn cursor(&self) -> usize { self.cursor }
    pub fn target_count(&self) -> usize { self.targets.len() }
    pub fn last_hit_at_ms(&self) -> Option<f64> { self.last_hit_at_ms }
    pub fn finalized_through_ms(&self) -> Option<f64> { self.finalized_through_ms }
    pub fn targets(&self) -> &[TargetHit] { &self.targets }

    pub fn ingest(&mut self, event: &StrikeEvent) -> Result<Vec<Judgment>, CoreError> {
        event.validate()?;
        if let Some(previous) = self.last_hit_at_ms {
            if event.at_ms < previous {
                return Err(CoreError::OutOfOrderEvent { previous_ms: previous, current_ms: event.at_ms });
            }
        }
        self.last_hit_at_ms = Some(event.at_ms);
        let mut results = Vec::new();

        // A sufficiently late incoming event first expires earlier target windows.
        while self.cursor < self.targets.len() {
            let target = &self.targets[self.cursor];
            if event.at_ms > target.at_ms + target.good_window_ms {
                results.push(self.miss_current());
            } else {
                break;
            }
        }

        if self.cursor >= self.targets.len() {
            results.push(Judgment {
                grade: Grade::Extra,
                target_id: None,
                target_index: None,
                strike_seq: Some(event.seq),
                error_ms: None,
                expected_at_ms: None,
                actual_at_ms: Some(event.at_ms),
                bar: None,
                beat: None,
            });
            return Ok(results);
        }

        let target = &self.targets[self.cursor];
        let error_ms = event.at_ms - target.at_ms;
        if error_ms.abs() <= target.good_window_ms {
            let grade = if error_ms.abs() <= target.perfect_window_ms { Grade::Perfect } else { Grade::Good };
            results.push(Judgment {
                grade,
                target_id: Some(target.id.clone()),
                target_index: Some(target.index),
                strike_seq: Some(event.seq),
                error_ms: Some(error_ms),
                expected_at_ms: Some(target.at_ms),
                actual_at_ms: Some(event.at_ms),
                bar: target.bar,
                beat: target.beat,
            });
            self.cursor += 1;
        } else {
            // Too early for the first unresolved target: an Extra; keep the target pending.
            results.push(Judgment {
                grade: Grade::Extra,
                target_id: None,
                target_index: None,
                strike_seq: Some(event.seq),
                error_ms: None,
                expected_at_ms: None,
                actual_at_ms: Some(event.at_ms),
                bar: None,
                beat: None,
            });
        }
        Ok(results)
    }

    pub fn advance(&mut self, now_ms: f64, finalization_grace_ms: f64) -> Result<Vec<Judgment>, CoreError> {
        validate_time(now_ms)?;
        if !finalization_grace_ms.is_finite() || finalization_grace_ms < 0.0 {
            return Err(CoreError::InvalidTimeValue);
        }
        let mut results = Vec::new();
        while self.cursor < self.targets.len() {
            let target = &self.targets[self.cursor];
            let deadline = target.at_ms + target.good_window_ms + finalization_grace_ms;
            if now_ms > deadline {
                results.push(self.miss_current());
            } else {
                break;
            }
        }
        Ok(results)
    }

    pub fn finish(&mut self) -> Vec<Judgment> {
        let mut results = Vec::new();
        while self.cursor < self.targets.len() {
            results.push(self.miss_current());
        }
        results
    }

    /// Shifts all unresolved future targets, used when pausing and resuming a session.
    pub fn shift_remaining(&mut self, delta_ms: f64) -> Result<(), CoreError> {
        if !delta_ms.is_finite() || delta_ms < 0.0 {
            return Err(CoreError::InvalidTimeValue);
        }
        for target in self.targets.iter_mut().skip(self.cursor) {
            target.at_ms += delta_ms;
            if !target.at_ms.is_finite() {
                return Err(CoreError::InvalidTargetSchedule("shifted target time overflowed".to_string()));
            }
        }
        Ok(())
    }

    fn miss_current(&mut self) -> Judgment {
        let target = &self.targets[self.cursor];
        let result = Judgment {
            grade: Grade::Miss,
            target_id: Some(target.id.clone()),
            target_index: Some(target.index),
            strike_seq: None,
            error_ms: None,
            expected_at_ms: Some(target.at_ms),
            actual_at_ms: None,
            bar: target.bar,
            beat: target.beat,
        };
        self.finalized_through_ms = Some(target.at_ms + target.good_window_ms);
        self.cursor += 1;
        result
    }
}

fn validate_time(value: f64) -> Result<(), CoreError> {
    if !value.is_finite() || value < 0.0 { Err(CoreError::InvalidTimeValue) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{InputSource, TargetHit};

    fn targets(times: &[f64]) -> Vec<TargetHit> {
        times.iter().enumerate().map(|(i, time)| TargetHit {
            id: format!("t{i}"), index: i, at_ms: *time, bar: Some(1), beat: Some(i as f64 + 1.0),
            perfect_window_ms: 10.0, good_window_ms: 30.0, nominal_duration_ms: 375.0,
        }).collect()
    }
    fn hit(seq: u64, at_ms: f64) -> StrikeEvent {
        StrikeEvent { seq, at_ms, source: InputSource::Midi, notes: vec![60], velocity: Some(80) }
    }

    #[test]
    fn perfect_good_extra_and_miss_are_distinct() {
        let mut m = HitMatcher::new(targets(&[100.0, 200.0, 300.0])).unwrap();
        assert_eq!(m.ingest(&hit(1, 100.0)).unwrap()[0].grade, Grade::Perfect);
        assert_eq!(m.ingest(&hit(2, 225.0)).unwrap()[0].grade, Grade::Good);
        assert_eq!(m.ingest(&hit(3, 250.0)).unwrap()[0].grade, Grade::Extra);
        assert_eq!(m.finish()[0].grade, Grade::Miss);
    }

    #[test]
    fn early_extra_does_not_consume_target() {
        let mut m = HitMatcher::new(targets(&[100.0])).unwrap();
        assert_eq!(m.ingest(&hit(1, 50.0)).unwrap()[0].grade, Grade::Extra);
        assert_eq!(m.ingest(&hit(2, 100.0)).unwrap()[0].grade, Grade::Perfect);
    }

    #[test]
    fn late_hit_misses_old_target_then_can_match_next() {
        let mut m = HitMatcher::new(targets(&[100.0, 200.0])).unwrap();
        let results = m.ingest(&hit(1, 205.0)).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].grade, Grade::Miss);
        assert_eq!(results[1].grade, Grade::Perfect);
    }

    #[test]
    fn rejects_overlapping_target_windows() {
        let mut overlapping = targets(&[100.0, 150.0]);
        overlapping[0].good_window_ms = 30.0;
        overlapping[1].good_window_ms = 30.0;
        assert!(HitMatcher::new(overlapping).is_err());
    }

    #[test]
    fn rejects_out_of_order_events() {
        let mut m = HitMatcher::new(targets(&[100.0, 200.0])).unwrap();
        m.ingest(&hit(1, 120.0)).unwrap();
        assert!(m.ingest(&hit(2, 110.0)).is_err());
    }

    #[test]
    fn advance_waits_until_deadline_plus_grace() {
        let mut m = HitMatcher::new(targets(&[100.0])).unwrap();
        assert!(m.advance(130.0, 10.0).unwrap().is_empty());
        assert_eq!(m.advance(140.1, 10.0).unwrap()[0].grade, Grade::Miss);
    }
}
