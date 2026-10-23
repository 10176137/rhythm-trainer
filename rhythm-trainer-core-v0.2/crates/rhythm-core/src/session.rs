use crate::{
    calculate_stats, replay_score, CoreError, Judgment, RingBuffer,
    ScoreStats, StrikeEvent, TargetHit,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState { Ready, Running, Paused, Completed, Invalid }

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready", Self::Running => "running", Self::Paused => "paused",
            Self::Completed => "completed", Self::Invalid => "invalid",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EngineDiagnostics {
    pub received_events: usize,
    pub queue_overflow_count: usize,
    pub sequence_gap_count: usize,
    pub duplicate_or_regressing_sequence_count: usize,
    pub out_of_order_timestamp_count: usize,
    pub invalid_event_count: usize,
    pub late_arrival_count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionReport {
    pub state: SessionState,
    pub target_count: usize,
    pub raw_events: Vec<StrikeEvent>,
    pub judgments: Vec<Judgment>,
    pub stats: ScoreStats,
    pub diagnostics: EngineDiagnostics,
    pub trustworthy: bool,
}

#[derive(Debug, Clone, Copy)]
struct PauseAdjustment { from_target_index: usize, delta_ms: f64 }

/// Coordinates the real-time queue and matcher. The final report is rebuilt from raw events.
pub struct SessionEngine {
    original_targets: Vec<TargetHit>,
    matcher: crate::HitMatcher,
    queue: RingBuffer<StrikeEvent>,
    raw_events: Vec<StrikeEvent>,
    state: SessionState,
    finalization_grace_ms: f64,
    diagnostics: EngineDiagnostics,
    last_sequence: Option<u64>,
    last_received_at_ms: Option<f64>,
    last_engine_now_ms: Option<f64>,
    pause_started_at_ms: Option<f64>,
    pause_adjustments: Vec<PauseAdjustment>,
}

impl SessionEngine {
    pub fn new(
        targets: Vec<TargetHit>,
        queue_capacity: usize,
        finalization_grace_ms: f64,
    ) -> Result<Self, CoreError> {
        if !finalization_grace_ms.is_finite() || finalization_grace_ms < 0.0 {
            return Err(CoreError::InvalidTimeValue);
        }
        let matcher = crate::HitMatcher::new(targets.clone())?;
        Ok(Self {
            original_targets: targets,
            matcher,
            queue: RingBuffer::new(queue_capacity)?,
            raw_events: Vec::new(),
            state: SessionState::Ready,
            finalization_grace_ms,
            diagnostics: EngineDiagnostics::default(),
            last_sequence: None,
            last_received_at_ms: None,
            last_engine_now_ms: None,
            pause_started_at_ms: None,
            pause_adjustments: Vec::new(),
        })
    }

    pub fn state(&self) -> SessionState { self.state }
    pub fn diagnostics(&self) -> &EngineDiagnostics { &self.diagnostics }
    pub fn queued_events(&self) -> usize { self.queue.len() }
    pub fn raw_event_count(&self) -> usize { self.raw_events.len() }

    pub fn start(&mut self) -> Result<(), CoreError> {
        if self.state != SessionState::Ready { return Err(self.state_error("start")); }
        self.state = SessionState::Running;
        Ok(())
    }

    /// Captures the original event before queueing so a queue overflow remains diagnosable.
    pub fn push_event(&mut self, event: StrikeEvent) -> Result<(), CoreError> {
        if self.state != SessionState::Running { return Err(self.state_error("push_event")); }
        self.diagnostics.received_events += 1;
        if let Err(error) = event.validate() {
            self.diagnostics.invalid_event_count += 1;
            self.state = SessionState::Invalid;
            return Err(error);
        }
        self.raw_events.push(event.clone());

        if let Some(previous_seq) = self.last_sequence {
            if event.seq <= previous_seq {
                self.diagnostics.duplicate_or_regressing_sequence_count += 1;
                self.state = SessionState::Invalid;
                return Err(CoreError::InvalidEvent("seq must be strictly increasing for a session".to_string()));
            }
            if event.seq > previous_seq + 1 {
                self.diagnostics.sequence_gap_count += (event.seq - previous_seq - 1) as usize;
            }
        }
        self.last_sequence = Some(event.seq);

        if let Some(previous_ms) = self.last_received_at_ms {
            if event.at_ms < previous_ms {
                self.diagnostics.out_of_order_timestamp_count += 1;
                self.state = SessionState::Invalid;
                return Err(CoreError::OutOfOrderEvent { previous_ms, current_ms: event.at_ms });
            }
        }
        self.last_received_at_ms = Some(event.at_ms);

        if self.matcher.finalized_through_ms().is_some_and(|cutoff| event.at_ms <= cutoff) {
            // It will be corrected by final replay if complete raw data remains available.
            self.diagnostics.late_arrival_count += 1;
        }

        if self.queue.push(event).is_err() {
            self.diagnostics.queue_overflow_count += 1;
            self.state = SessionState::Invalid;
            return Err(CoreError::QueueOverflow);
        }
        Ok(())
    }

    pub fn process_pending(&mut self) -> Result<Vec<Judgment>, CoreError> {
        if self.state != SessionState::Running { return Err(self.state_error("process_pending")); }
        let events = self.queue.drain();
        let mut judgments = Vec::new();
        for event in events {
            match self.matcher.ingest(&event) {
                Ok(results) => judgments.extend(results),
                Err(error) => {
                    self.diagnostics.out_of_order_timestamp_count += 1;
                    self.state = SessionState::Invalid;
                    return Err(error);
                }
            }
        }
        Ok(judgments)
    }

    pub fn advance(&mut self, now_ms: f64) -> Result<Vec<Judgment>, CoreError> {
        if self.state != SessionState::Running { return Err(self.state_error("advance")); }
        self.check_engine_clock(now_ms)?;
        let mut judgments = self.process_pending()?;
        match self.matcher.advance(now_ms, self.finalization_grace_ms) {
            Ok(results) => judgments.extend(results),
            Err(error) => { self.state = SessionState::Invalid; return Err(error); }
        }
        self.last_engine_now_ms = Some(now_ms);
        Ok(judgments)
    }

    pub fn pause(&mut self, now_ms: f64) -> Result<Vec<Judgment>, CoreError> {
        if self.state != SessionState::Running { return Err(self.state_error("pause")); }
        self.check_engine_clock(now_ms)?;
        let mut judgments = self.process_pending()?;
        judgments.extend(self.matcher.advance(now_ms, self.finalization_grace_ms)?);
        self.last_engine_now_ms = Some(now_ms);
        self.pause_started_at_ms = Some(now_ms);
        self.state = SessionState::Paused;
        Ok(judgments)
    }

    pub fn resume(&mut self, now_ms: f64) -> Result<(), CoreError> {
        if self.state != SessionState::Paused { return Err(self.state_error("resume")); }
        self.check_engine_clock(now_ms)?;
        let paused_at = self.pause_started_at_ms.ok_or(CoreError::InvalidTimeValue)?;
        if now_ms < paused_at { return Err(CoreError::InvalidTimeValue); }
        let delta_ms = now_ms - paused_at;
        let from_target_index = self.matcher.cursor();
        self.matcher.shift_remaining(delta_ms)?;
        self.pause_adjustments.push(PauseAdjustment { from_target_index, delta_ms });
        self.pause_started_at_ms = None;
        self.last_engine_now_ms = Some(now_ms);
        self.state = SessionState::Running;
        Ok(())
    }

    /// Final score is a deterministic replay over the raw log and pause-adjusted targets.
    pub fn finish(&mut self) -> Result<SessionReport, CoreError> {
        match self.state {
            SessionState::Running => { let _ = self.process_pending(); }
            SessionState::Paused | SessionState::Invalid => {}
            _ => return Err(self.state_error("finish")),
        }
        let final_state = if self.state == SessionState::Invalid { SessionState::Invalid } else { SessionState::Completed };
        let adjusted_targets = self.adjusted_targets();
        let replay = replay_score(adjusted_targets, self.raw_events.clone())?;
        let stats = calculate_stats(replay.target_count, &replay.judgments);
        let trustworthy = final_state != SessionState::Invalid
            && self.diagnostics.queue_overflow_count == 0
            && self.diagnostics.sequence_gap_count == 0
            && self.diagnostics.duplicate_or_regressing_sequence_count == 0
            && self.diagnostics.out_of_order_timestamp_count == 0
            && self.diagnostics.invalid_event_count == 0;
        self.state = final_state;
        Ok(SessionReport {
            state: final_state,
            target_count: replay.target_count,
            raw_events: self.raw_events.clone(),
            judgments: replay.judgments,
            stats,
            diagnostics: self.diagnostics.clone(),
            trustworthy,
        })
    }

    fn adjusted_targets(&self) -> Vec<TargetHit> {
        let mut targets = self.original_targets.clone();
        for adjustment in &self.pause_adjustments {
            for target in targets.iter_mut().skip(adjustment.from_target_index) {
                target.at_ms += adjustment.delta_ms;
            }
        }
        targets
    }

    fn check_engine_clock(&self, now_ms: f64) -> Result<(), CoreError> {
        if !now_ms.is_finite() || now_ms < 0.0 { return Err(CoreError::InvalidTimeValue); }
        if let Some(previous_ms) = self.last_engine_now_ms {
            if now_ms < previous_ms {
                return Err(CoreError::OutOfOrderClock { previous_ms, current_ms: now_ms });
            }
        }
        Ok(())
    }

    fn state_error(&self, operation: &'static str) -> CoreError {
        CoreError::InvalidState { operation, state: self.state.as_str().to_string() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Grade, InputSource};

    fn targets() -> Vec<TargetHit> {
        [100.0, 200.0].iter().enumerate().map(|(index, at_ms)| TargetHit {
            id: format!("t{index}"), index, at_ms: *at_ms, bar: Some(1), beat: Some(index as f64 + 1.0),
            perfect_window_ms: 10.0, good_window_ms: 30.0, nominal_duration_ms: 375.0,
        }).collect()
    }
    fn event(seq: u64, at_ms: f64) -> StrikeEvent {
        StrikeEvent { seq, at_ms, source: InputSource::Midi, notes: vec![60], velocity: Some(80) }
    }

    #[test]
    fn session_finishes_with_replayed_report() {
        let mut session = SessionEngine::new(targets(), 8, 20.0).unwrap();
        session.start().unwrap();
        session.push_event(event(1, 100.0)).unwrap();
        session.push_event(event(2, 200.0)).unwrap();
        session.process_pending().unwrap();
        let report = session.finish().unwrap();
        assert_eq!(report.judgments.len(), 2);
        assert_eq!(report.stats.perfect_count, 2);
        assert!(report.trustworthy);
    }

    #[test]
    fn sequence_gap_is_visible_and_not_trustworthy() {
        let mut session = SessionEngine::new(targets(), 8, 20.0).unwrap();
        session.start().unwrap();
        session.push_event(event(1, 100.0)).unwrap();
        session.push_event(event(3, 200.0)).unwrap();
        let report = session.finish().unwrap();
        assert_eq!(report.diagnostics.sequence_gap_count, 1);
        assert!(!report.trustworthy);
    }

    #[test]
    fn pause_time_shifts_remaining_targets() {
        let mut session = SessionEngine::new(targets(), 8, 20.0).unwrap();
        session.start().unwrap();
        session.push_event(event(1, 100.0)).unwrap();
        session.process_pending().unwrap();
        session.pause(150.0).unwrap();
        session.resume(1_150.0).unwrap();
        session.push_event(event(2, 1_200.0)).unwrap();
        let report = session.finish().unwrap();
        assert!(report.judgments.iter().any(|j| j.grade == Grade::Perfect && j.target_index == Some(1)));
    }

    #[test]
    fn engine_clock_cannot_move_backwards() {
        let mut session = SessionEngine::new(targets(), 8, 20.0).unwrap();
        session.start().unwrap();
        session.advance(250.0).unwrap();
        assert!(matches!(session.advance(200.0), Err(CoreError::OutOfOrderClock { .. })));
    }

    #[test]
    fn overflow_invalidates_session_instead_of_silently_dropping() {
        let mut session = SessionEngine::new(targets(), 1, 20.0).unwrap();
        session.start().unwrap();
        session.push_event(event(1, 100.0)).unwrap();
        assert_eq!(session.push_event(event(2, 200.0)), Err(CoreError::QueueOverflow));
        let report = session.finish().unwrap();
        assert_eq!(report.diagnostics.queue_overflow_count, 1);
        assert!(!report.trustworthy);
    }
}
