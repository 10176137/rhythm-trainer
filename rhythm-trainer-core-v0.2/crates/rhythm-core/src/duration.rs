//! Note On / Note Off pairing and key-down duration assessment (v0.3).
//!
//! Three timelines, deliberately kept apart:
//!   1. Onset error   — when the key went down vs the target onset (HitMatcher).
//!   2. Key-down time — how long the key stayed down (Note Off − Note On).
//!   3. Inter-onset   — spacing to the next onset (rhythm structure; NOT the
//!      key-down time of the current note).
//!
//! MIDI measures key events only. It cannot measure how long the string
//! sounds; sustain pedal (CC64) extends the sound, not `key_down_ms`.

use crate::midi::{track_key_lifecycles, ClockQuality, IngestMidiPacket, KeyPressObservation,
    KeyPressStatus, KeyLifecycleTracker, MidiTransport, RawMidiPacket};
use crate::{CoreError, Grade, Judgment, TargetHit};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawNoteKind {
    NoteOn,
    NoteOff,
}

impl RawNoteKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoteOn => "note_on",
            Self::NoteOff => "note_off",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "note_on" => Some(Self::NoteOn),
            "note_off" => Some(Self::NoteOff),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteEventQuality {
    Ok,
    /// Note On arrived while the same pitch was still open; pairing is FIFO
    /// but the interval context is ambiguous, so treat with care.
    OverlappingSamePitch,
    /// No Note Off arrived before the end of the log — duration unknowable.
    OpenNoteInterrupted,
    /// The key-down interval spans a Pause/Resume boundary. The physical
    /// duration may be known, but it includes non-performance time and must
    /// not be graded as a normal strict-keydown sample.
    CrossedPauseBoundary,
}

impl NoteEventQuality {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::OverlappingSamePitch => "overlapping_same_pitch",
            Self::OpenNoteInterrupted => "open_note_interrupted",
            Self::CrossedPauseBoundary => "crossed_pause_boundary",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RawMidiNoteEvent {
    pub seq: u64,
    /// Session-relative monotonic milliseconds.
    pub at_ms: f64,
    pub kind: RawNoteKind,
    pub pitch: u8,
    pub velocity: Option<u8>,
}

impl RawMidiNoteEvent {
    /// Many devices send Note Off as Note On with velocity=0; normalize here.
    pub fn effective_kind(&self) -> RawNoteKind {
        if self.kind == RawNoteKind::NoteOn && self.velocity == Some(0) {
            RawNoteKind::NoteOff
        } else {
            self.kind
        }
    }

    fn validate(&self) -> Result<(), CoreError> {
        if !self.at_ms.is_finite() || self.at_ms < 0.0 {
            return Err(CoreError::InvalidEvent(
                "note event at_ms must be finite and non-negative".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PerformedNote {
    pub onset_seq: u64,
    pub pitch: u8,
    pub onset_ms: f64,
    pub offset_ms: Option<f64>,
    pub key_down_ms: Option<f64>,
    /// Gap to the NEXT performed onset (any pitch). Deliberately NOT the
    /// key-down time of this note.
    pub inter_onset_interval_ms: Option<f64>,
    pub quality: NoteEventQuality,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurationPolicyKind {
    /// Duration training: nominal score duration IS the target key-down time,
    /// judged with explicit tolerances.
    StrictKeyDown,
    /// Record measured durations, judge nothing (free play, or score contexts
    /// where articulation is not yet modelled).
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DurationPolicy {
    pub kind: DurationPolicyKind,
    pub tolerance_ms: f64,
    pub tolerance_ratio: f64,
}

impl Default for DurationPolicy {
    fn default() -> Self {
        // Product heuristics, not musicology: calibrate per use before trusting.
        Self { kind: DurationPolicyKind::StrictKeyDown, tolerance_ms: 50.0, tolerance_ratio: 0.15 }
    }
}

impl DurationPolicy {
    pub fn validate(&self) -> Result<(), CoreError> {
        if !self.tolerance_ms.is_finite()
            || self.tolerance_ms < 0.0
            || !self.tolerance_ratio.is_finite()
            || self.tolerance_ratio < 0.0
        {
            return Err(CoreError::InvalidConfig(
                "duration tolerances must be finite and non-negative".to_string(),
            ));
        }
        Ok(())
    }

    fn allowed_error_ms(&self, nominal_ms: f64) -> f64 {
        // Take the wider of the two so fast passages don't become unjudgeable
        // and slow ones don't get over-lenient.
        self.tolerance_ms.max(nominal_ms * self.tolerance_ratio)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurationResult {
    WithinTolerance,
    TooShort,
    TooLong,
    /// Missing Note Off, unmatched onset, or no credible target duration.
    Unknown,
    /// Policy is Disabled: measured values (if any) are recorded, not judged.
    PolicyDisabled,
}

impl DurationResult {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WithinTolerance => "within_tolerance",
            Self::TooShort => "too_short",
            Self::TooLong => "too_long",
            Self::Unknown => "unknown",
            Self::PolicyDisabled => "disabled",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DurationAssessment {
    pub target_index: Option<usize>,
    pub target_id: Option<String>,
    pub onset_seq: Option<u64>,
    pub pitch: Option<u8>,
    pub nominal_duration_ms: Option<f64>,
    pub actual_key_down_ms: Option<f64>,
    pub duration_error_ms: Option<f64>,
    pub allowed_error_ms: Option<f64>,
    pub inter_onset_interval_ms: Option<f64>,
    pub result: DurationResult,
    pub quality: NoteEventQuality,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DurationReport {
    pub policy_version: u32,
    pub assessments: Vec<DurationAssessment>,
    pub orphan_note_off_count: usize,
    pub open_note_count: usize,
}

/// Pairs Note On / Note Off into performed key-down intervals.
///
/// v0.6: this is now a thin compatibility adapter over the authoritative
/// [`crate::midi::KeyLifecycleTracker`] — there is exactly ONE pairing
/// implementation in the core. Raw note events are re-encoded as synthetic
/// packets (source `legacy`, channel 0) and routed through the same decoder
/// and tracker as live device traffic.
pub fn pair_note_events(events: &[RawMidiNoteEvent]) -> (Vec<PerformedNote>, usize, usize) {
    let mut ordered: Vec<&RawMidiNoteEvent> = events.iter().collect();
    ordered.sort_by(|a, b| a.at_ms.total_cmp(&b.at_ms).then(a.seq.cmp(&b.seq)));

    let ingests: Vec<IngestMidiPacket> = ordered.iter().map(|event| {
        let raw_bytes = match event.kind {
            RawNoteKind::NoteOn => vec![0x90u8, event.pitch, event.velocity.unwrap_or(100)],
            RawNoteKind::NoteOff => vec![0x80u8, event.pitch, 0],
        };
        IngestMidiPacket {
            packet: RawMidiPacket {
                source_id: "legacy".to_string(),
                source_seq: event.seq,
                clock_domain_id: "legacy-clock".to_string(),
                captured_at_ms: event.at_ms,
                handler_at_ms: None,
                raw_bytes,
                transport: MidiTransport::Mock,
            },
            session_time_ms: Some(event.at_ms),
            clock_mapping_id: None,
            clock_uncertainty_ms: None,
            clock_quality: ClockQuality::Good,
        }
    }).collect();

    let mut tracker = KeyLifecycleTracker::new();
    for ingest in &ingests {
        let _ = tracker.ingest(ingest); // synthetic packets are valid by construction
    }
    tracker.finish();
    let report = tracker.into_report();

    let mut performed: Vec<PerformedNote> = report.observations.iter().map(|observation| PerformedNote {
        onset_seq: observation.note_on_source_seq,
        pitch: observation.note_number,
        onset_ms: observation.start_source_time_ms,
        offset_ms: observation.end_source_time_ms,
        key_down_ms: observation.key_down_duration_ms,
        inter_onset_interval_ms: None,
        quality: match observation.status {
            KeyPressStatus::Complete => NoteEventQuality::Ok,
            KeyPressStatus::AmbiguousPairing => NoteEventQuality::OverlappingSamePitch,
            _ => NoteEventQuality::OpenNoteInterrupted,
        },
    }).collect();

    for index in 0..performed.len() {
        performed[index].inter_onset_interval_ms = performed
            .get(index + 1)
            .map(|next| next.onset_ms - performed[index].onset_ms);
    }

    let orphan_count = report.diagnostics.iter()
        .filter(|d| d.code == crate::midi::diagnostic_codes::ORPHAN_NOTE_OFF)
        .count();
    let open_count = report.observations.iter()
        .filter(|o| o.status == KeyPressStatus::MissingNoteOff)
        .count();
    (performed, orphan_count, open_count)
}

/// Assesses key-down durations from v0.6 key-press observations.
///
/// Alignment joins each performed note to the target its Note On was matched
/// to by the onset matcher (judgment `strike_seq` ↔ observation
/// `note_on_source_seq`) — onset scoring stays authoritative and untouched.
/// Only `complete` presses receive strict grades; ambiguous / missing /
/// interrupted presses yield `Unknown`, never a guess.
pub fn assess_presses(
    targets: &[TargetHit],
    presses: &[crate::midi::KeyPressObservation],
    judgments: &[Judgment],
    policy: &DurationPolicy,
) -> Result<DurationReport, CoreError> {
    assess_presses_with_pauses(targets, presses, judgments, policy, &[])
}

/// Same as [`assess_presses`], but intervals are in the SOURCE clock domain
/// (`start_source_time_ms` / `end_source_time_ms`). A key-down interval that
/// intersects a pause interval is marked `CrossedPauseBoundary` and is never
/// graded strictly: the physical hold may include arbitrary non-performance
/// time, and the Note Off may have been observed only after resume.
pub fn assess_presses_with_pauses(
    targets: &[TargetHit],
    presses: &[crate::midi::KeyPressObservation],
    judgments: &[Judgment],
    policy: &DurationPolicy,
    pause_intervals_source_ms: &[(f64, f64)],
) -> Result<DurationReport, CoreError> {
    policy.validate()?;

    // Inter-onset interval per press: gap to the NEXT onset (any pitch) in
    // onset-time order — a separate measurement from key-down duration.
    let mut onsets: Vec<(u64, f64)> = presses.iter()
        .map(|p| (p.note_on_source_seq, p.start_source_time_ms))
        .collect();
    onsets.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
    let mut ioi_by_seq: BTreeMap<u64, f64> = BTreeMap::new();
    for window in onsets.windows(2) {
        ioi_by_seq.insert(window[0].0, window[1].1 - window[0].1);
    }

    // strike_seq → target index, for onsets the matcher consumed (Perfect/Good).
    let mut matched_targets: BTreeMap<u64, usize> = BTreeMap::new();
    for judgment in judgments {
        if matches!(judgment.grade, Grade::Perfect | Grade::Good) {
            if let (Some(seq), Some(index)) = (judgment.strike_seq, judgment.target_index) {
                matched_targets.entry(seq).or_insert(index);
            }
        }
    }

    let mut assessments = Vec::with_capacity(presses.len());
    for press in presses {
        let matched = matched_targets
            .get(&press.note_on_source_seq)
            .and_then(|index| targets.get(*index).map(|target| (index, target)));
        let (target_index, target_id, nominal) = match matched {
            Some((index, target)) if target.nominal_duration_ms.is_finite() && target.nominal_duration_ms > 0.0 => {
                (Some(*index), Some(target.id.clone()), Some(target.nominal_duration_ms))
            }
            Some((index, target)) => (Some(*index), Some(target.id.clone()), None),
            None => (None, None, None),
        };
        let crossed_pause = pause_intervals_source_ms.iter().any(|(pause_start, pause_end)| {
            if !pause_start.is_finite() || !pause_end.is_finite() || *pause_end <= *pause_start {
                return false;
            }
            let start = press.start_source_time_ms;
            let end = press.end_source_time_ms.unwrap_or(f64::INFINITY);
            start < *pause_end && end > *pause_start
        });
        let quality = if crossed_pause {
            NoteEventQuality::CrossedPauseBoundary
        } else {
            match press.status {
                KeyPressStatus::Complete => NoteEventQuality::Ok,
                KeyPressStatus::AmbiguousPairing => NoteEventQuality::OverlappingSamePitch,
                _ => NoteEventQuality::OpenNoteInterrupted,
            }
        };

        let (result, error, allowed) = match (policy.kind, nominal, press.key_down_duration_ms, press.status) {
            (DurationPolicyKind::Disabled, _, _, _) => (DurationResult::PolicyDisabled, None, None),
            (_, _, _, _) if crossed_pause => (DurationResult::Unknown, None, None),
            (_, _, _, KeyPressStatus::AmbiguousPairing)
            | (_, _, _, KeyPressStatus::InvalidTime) => (DurationResult::Unknown, None, None),
            (_, None, _, _) => (DurationResult::Unknown, None, None),
            (_, _, None, _) => (DurationResult::Unknown, None, None),
            (DurationPolicyKind::StrictKeyDown, Some(nominal_ms), Some(actual), KeyPressStatus::Complete) => {
                let allowed_ms = policy.allowed_error_ms(nominal_ms);
                let error_ms = actual - nominal_ms;
                let result = if error_ms < -allowed_ms {
                    DurationResult::TooShort
                } else if error_ms > allowed_ms {
                    DurationResult::TooLong
                } else {
                    DurationResult::WithinTolerance
                };
                (result, Some(error_ms), Some(allowed_ms))
            }
            (DurationPolicyKind::StrictKeyDown, _, _, _) => (DurationResult::Unknown, None, None),
        };

        assessments.push(DurationAssessment {
            target_index,
            target_id,
            onset_seq: Some(press.note_on_source_seq),
            pitch: Some(press.note_number),
            nominal_duration_ms: nominal,
            actual_key_down_ms: press.key_down_duration_ms,
            duration_error_ms: error,
            allowed_error_ms: allowed,
            inter_onset_interval_ms: ioi_by_seq.get(&press.note_on_source_seq).copied(),
            result,
            quality,
        });
    }

    let orphan_note_off_count = 0usize; // orphan info lives in tracker diagnostics
    Ok(DurationReport {
        policy_version: 1,
        assessments,
        orphan_note_off_count,
        open_note_count: presses.iter().filter(|p| p.status == KeyPressStatus::MissingNoteOff).count(),
    })
}

/// Legacy entry point: assesses from raw note events by routing them through
/// the same v0.6 decoder/tracker (`track_key_lifecycles`) and then grading.
/// New callers should prefer `assess_presses` with tracker observations.
pub fn assess_durations(
    targets: &[TargetHit],
    raw: &[RawMidiNoteEvent],
    judgments: &[Judgment],
    policy: &DurationPolicy,
) -> Result<DurationReport, CoreError> {
    policy.validate()?;
    let ingests: Vec<IngestMidiPacket> = raw.iter().map(|event| {
        let raw_bytes = match event.kind {
            RawNoteKind::NoteOn => vec![0x90u8, event.pitch, event.velocity.unwrap_or(100)],
            RawNoteKind::NoteOff => vec![0x80u8, event.pitch, 0],
        };
        IngestMidiPacket {
            packet: RawMidiPacket {
                source_id: "legacy".to_string(),
                source_seq: event.seq,
                clock_domain_id: "legacy-clock".to_string(),
                captured_at_ms: event.at_ms,
                handler_at_ms: None,
                raw_bytes,
                transport: MidiTransport::Mock,
            },
            session_time_ms: Some(event.at_ms),
            clock_mapping_id: None,
            clock_uncertainty_ms: None,
            clock_quality: ClockQuality::Good,
        }
    }).collect();
    let lifecycles = track_key_lifecycles(&ingests)?;
    let mut report = assess_presses(targets, &lifecycles.observations, judgments, policy)?;
    report.orphan_note_off_count = lifecycles.diagnostics.iter()
        .filter(|d| d.code == crate::midi::diagnostic_codes::ORPHAN_NOTE_OFF)
        .count();
    Ok(report)
}


#[cfg(test)]
mod tests {
    use super::*;

    fn on(seq: u64, at_ms: f64, pitch: u8) -> RawMidiNoteEvent {
        RawMidiNoteEvent { seq, at_ms, kind: RawNoteKind::NoteOn, pitch, velocity: Some(90) }
    }
    fn off(seq: u64, at_ms: f64, pitch: u8) -> RawMidiNoteEvent {
        RawMidiNoteEvent { seq, at_ms, kind: RawNoteKind::NoteOff, pitch, velocity: None }
    }

    fn target(index: usize, at_ms: f64, nominal: f64) -> TargetHit {
        TargetHit {
            id: format!("t{index}"),
            index,
            at_ms,
            bar: None,
            beat: None,
            perfect_window_ms: 10.0,
            good_window_ms: 30.0,
            nominal_duration_ms: nominal,
        }
    }

    fn judgment_matched(seq: u64, target_index: usize) -> Judgment {
        Judgment {
            grade: Grade::Perfect,
            target_id: Some(format!("t{target_index}")),
            target_index: Some(target_index),
            strike_seq: Some(seq),
            error_ms: Some(0.0),
            expected_at_ms: Some(0.0),
            actual_at_ms: Some(0.0),
            bar: None,
            beat: None,
        }
    }

    #[test]
    fn key_down_and_ioi_are_separate_measurements() {
        // Spec §10.1.1/§10.1.2: On 1000/Off 1400 → 400 ms key-down;
        // next onset at 1450 → IOI 450 ms. Never conflated.
        let (performed, orphan, open) = pair_note_events(&[
            on(1, 1000.0, 60),
            off(2, 1400.0, 60),
            on(3, 1450.0, 62),
        ]);
        assert_eq!((orphan, open), (0, 1));
        assert_eq!(performed[0].key_down_ms, Some(400.0));
        assert_eq!(performed[0].inter_onset_interval_ms, Some(450.0));
        assert_eq!(performed[1].key_down_ms, None);
        assert_eq!(performed[1].quality, NoteEventQuality::OpenNoteInterrupted);
    }

    #[test]
    fn velocity_zero_note_on_normalizes_to_release() {
        let (performed, orphan, open) = pair_note_events(&[
            RawMidiNoteEvent { seq: 1, at_ms: 500.0, kind: RawNoteKind::NoteOn, pitch: 60, velocity: Some(0) }, // → release with nothing open
            on(2, 600.0, 60),
            RawMidiNoteEvent { seq: 3, at_ms: 900.0, kind: RawNoteKind::NoteOn, pitch: 60, velocity: Some(0) },
        ]);
        assert_eq!(orphan, 1, "leading velocity-0 on has nothing to close");
        assert_eq!(open, 0);
        assert_eq!(performed[0].key_down_ms, Some(300.0));
    }

    #[test]
    fn same_pitch_repeats_pair_fifo_without_overwrite() {
        // Spec §10.2.4: repeated pitch must not clobber the earlier onset.
        let (performed, orphan, open) = pair_note_events(&[
            on(1, 1000.0, 60),
            on(2, 1100.0, 60),
            off(3, 1200.0, 60),
            off(4, 1300.0, 60),
        ]);
        assert_eq!((orphan, open), (0, 0));
        assert_eq!(performed.len(), 2);
        assert_eq!(performed[0].key_down_ms, Some(200.0));
        assert_eq!(performed[1].key_down_ms, Some(200.0));
        assert_eq!(performed[1].quality, NoteEventQuality::OverlappingSamePitch);
    }

    #[test]
    fn orphan_note_off_never_produces_negative_duration() {
        let (performed, orphan, open) = pair_note_events(&[off(1, 1200.0, 60)]);
        assert!(performed.is_empty());
        assert_eq!((orphan, open), (1, 0));
    }

    #[test]
    fn missing_note_off_is_unknown_not_zero() {
        let targets = [target(0, 1000.0, 375.0)];
        let judgments = [judgment_matched(1, 0)];
        let report = assess_durations(&targets, &[on(1, 1000.0, 60)], &judgments, &DurationPolicy::default()).unwrap();
        assert_eq!(report.assessments[0].result, DurationResult::Unknown);
        assert_eq!(report.assessments[0].actual_key_down_ms, None);
        assert_eq!(report.open_note_count, 1);
    }

    #[test]
    fn strict_policy_judges_short_long_and_within() {
        let targets = [target(0, 1000.0, 375.0), target(1, 1375.0, 375.0), target(2, 1750.0, 375.0)];
        let judgments = [
            judgment_matched(1, 0),
            judgment_matched(3, 1),
            judgment_matched(5, 2),
        ];
        // nominal 375; allowed = max(50, 56.25) = 56.25
        let report = assess_durations(&targets, &[
            on(1, 1000.0, 60), off(2, 1290.0, 60),  // 290 → −85 → too short (spec §11)
            on(3, 1375.0, 62), off(4, 1755.0, 62),  // 380 → +5 → within
            on(5, 1750.0, 64), off(6, 2160.0, 64),  // 410 → +35 → within
        ], &judgments, &DurationPolicy::default()).unwrap();
        assert_eq!(report.assessments[0].result, DurationResult::TooShort);
        assert_eq!(report.assessments[0].duration_error_ms, Some(-85.0));
        assert_eq!(report.assessments[0].allowed_error_ms, Some(56.25));
        assert_eq!(report.assessments[1].result, DurationResult::WithinTolerance);
        assert_eq!(report.assessments[2].result, DurationResult::WithinTolerance);
    }

    #[test]
    fn tolerance_boundary_is_inclusive() {
        let targets = [target(0, 1000.0, 375.0)];
        let judgments = [judgment_matched(1, 0)];
        let allowed = (50.0f64).max(375.0 * 0.15);
        let report = assess_durations(&targets, &[
            on(1, 1000.0, 60), off(2, 1000.0 + 375.0 - allowed, 60),
        ], &judgments, &DurationPolicy::default()).unwrap();
        assert_eq!(report.assessments[0].result, DurationResult::WithinTolerance);
    }

    #[test]
    fn disabled_policy_measures_without_judging() {
        let targets = [target(0, 1000.0, 375.0)];
        let judgments = [judgment_matched(1, 0)];
        let policy = DurationPolicy { kind: DurationPolicyKind::Disabled, ..DurationPolicy::default() };
        let report = assess_durations(&targets, &[
            on(1, 1000.0, 60), off(2, 1100.0, 60), // 100 ms, way short — but not judged
        ], &judgments, &policy).unwrap();
        assert_eq!(report.assessments[0].result, DurationResult::PolicyDisabled);
        assert_eq!(report.assessments[0].actual_key_down_ms, Some(100.0));
        assert_eq!(report.assessments[0].duration_error_ms, None);
    }

    #[test]
    fn unmatched_onset_reports_measurement_without_target() {
        let targets = [target(0, 1000.0, 375.0)];
        let judgments: Vec<Judgment> = Vec::new(); // onset matcher matched nothing
        let report = assess_durations(&targets, &[
            on(1, 1010.0, 60), off(2, 1260.0, 60),
        ], &judgments, &DurationPolicy::default()).unwrap();
        let a = &report.assessments[0];
        assert_eq!(a.target_index, None);
        assert_eq!(a.nominal_duration_ms, None);
        assert_eq!(a.actual_key_down_ms, Some(250.0));
        assert_eq!(a.result, DurationResult::Unknown);
    }

    #[test]
    fn rejects_invalid_policy() {
        let policy = DurationPolicy { tolerance_ms: -1.0, ..DurationPolicy::default() };
        assert!(assess_durations(&[], &[], &[], &policy).is_err());
    }

    fn press(start: f64, end: Option<f64>) -> KeyPressObservation {
        KeyPressObservation {
            press_id: "p1".to_string(),
            source_id: "s1".to_string(),
            channel: 0,
            note_number: 60,
            velocity_on: 90,
            note_on_event_id: "on1".to_string(),
            note_off_event_id: end.map(|_| "off1".to_string()),
            start_source_time_ms: start,
            end_source_time_ms: end,
            key_down_duration_ms: end.map(|e| e - start),
            status: if end.is_some() { KeyPressStatus::Complete } else { KeyPressStatus::MissingNoteOff },
            quality_reasons: Vec::new(),
            note_on_source_seq: 1,
        }
    }

    #[test]
    fn key_down_spanning_pause_is_not_strictly_graded() {
        let targets = [target(0, 1000.0, 375.0)];
        let judgments = [judgment_matched(1, 0)];
        let report = assess_presses_with_pauses(
            &targets,
            &[press(1000.0, Some(1400.0))],
            &judgments,
            &DurationPolicy::default(),
            &[(1100.0, 1300.0)],
        ).unwrap();
        assert_eq!(report.assessments[0].quality, NoteEventQuality::CrossedPauseBoundary);
        assert_eq!(report.assessments[0].result, DurationResult::Unknown);
    }

    #[test]
    fn missing_note_off_after_pause_is_also_flagged() {
        let targets = [target(0, 1000.0, 375.0)];
        let judgments = [judgment_matched(1, 0)];
        let report = assess_presses_with_pauses(
            &targets,
            &[press(1000.0, None)],
            &judgments,
            &DurationPolicy::default(),
            &[(1100.0, 1300.0)],
        ).unwrap();
        assert_eq!(report.assessments[0].quality, NoteEventQuality::CrossedPauseBoundary);
        assert_eq!(report.assessments[0].result, DurationResult::Unknown);
    }

    #[test]
    fn normal_press_next_to_pause_is_still_graded() {
        let targets = [target(0, 1000.0, 375.0)];
        let judgments = [judgment_matched(1, 0)];
        let report = assess_presses_with_pauses(
            &targets,
            &[press(1000.0, Some(1400.0))],
            &judgments,
            &DurationPolicy::default(),
            &[(1400.0, 1500.0)],
        ).unwrap();
        assert_eq!(report.assessments[0].quality, NoteEventQuality::Ok);
        assert_eq!(report.assessments[0].result, DurationResult::WithinTolerance);
    }
}
