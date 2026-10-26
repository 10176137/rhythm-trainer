//! Self-paced score follower (Follow mode).
//!
//! This is a Rust port of the previously browser-side `FollowSession`
//! behaviour. The cursor never advances on a clock: it advances only when the
//! current target's full pitch set has been played. Pitch/order correctness
//! and relative IOI against the notated durations are recorded per target.
//! This is intentionally NOT the fixed-clock `scoring_v1` path.

use std::collections::HashSet;

use crate::CoreError;

#[derive(Clone, Debug, PartialEq)]
pub struct FollowPitch {
    pub midi_note: u8,
    pub spelling: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FollowGroup {
    pub group_id: String,
    pub bar: u32,
    /// Playback position in quarter-note beats from the start of the range.
    pub playback_beat: f64,
    pub pitches: Vec<FollowPitch>,
}

/// One group's canonicalization evidence. Duplicate MIDI notes are collapsed to
/// one key for the Follow cursor, but the source spellings that were collapsed
/// stay auditable here instead of disappearing in the transport layer.
#[derive(Clone, Debug, PartialEq)]
pub struct FollowGroupNormalization {
    pub group_id: String,
    pub source_pitch_count: usize,
    pub canonical_pitch_count: usize,
    pub duplicate_midi_notes: Vec<u8>,
    pub duplicate_spellings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NormalizedFollowGroups {
    pub groups: Vec<FollowGroup>,
    pub normalizations: Vec<FollowGroupNormalization>,
    pub source_pitch_count: usize,
    pub canonical_pitch_count: usize,
    pub groups_with_duplicates: usize,
}

/// Canonicalizes a Follow target list before runtime construction.
///
/// Follow advances on the set of distinct MIDI keys in the current group, so a
/// group that notates the same key in two voices must count that key once. This
/// decision (and the ordering/identity validation around it) is music semantics
/// and therefore lives in the Rust authority, not in Node.
pub fn normalize_follow_groups(
    groups: Vec<FollowGroup>,
) -> Result<NormalizedFollowGroups, CoreError> {
    if groups.is_empty() {
        return Err(CoreError::InvalidPattern("follow plan has no targets".to_string()));
    }
    if groups.len() > 20_000 {
        return Err(CoreError::InvalidPattern(
            "follow target count exceeds 20000".to_string(),
        ));
    }
    let mut seen_group_ids = HashSet::new();
    let mut previous_beat = f64::NEG_INFINITY;
    let mut source_pitch_count = 0;
    let mut canonical_pitch_count = 0;
    let mut normalized_groups = Vec::with_capacity(groups.len());
    let mut normalizations = Vec::new();
    for group in groups {
        let group_id = group.group_id.trim().to_string();
        if group_id.is_empty() || group_id.len() > 200 {
            return Err(CoreError::InvalidPattern(
                "follow group id must be non-empty and at most 200 chars".to_string(),
            ));
        }
        if !seen_group_ids.insert(group_id.clone()) {
            return Err(CoreError::InvalidPattern(format!(
                "duplicate follow group id: {group_id}"
            )));
        }
        if group.bar == 0 {
            return Err(CoreError::InvalidPattern(format!(
                "follow group {group_id} has an invalid bar"
            )));
        }
        if !group.playback_beat.is_finite() || group.playback_beat < 0.0 {
            return Err(CoreError::InvalidPattern(format!(
                "follow group {group_id} has an invalid playback beat"
            )));
        }
        if group.playback_beat < previous_beat {
            return Err(CoreError::InvalidPattern(
                "follow groups are not in playback order".to_string(),
            ));
        }
        previous_beat = group.playback_beat;
        if group.pitches.is_empty() {
            return Err(CoreError::InvalidPattern(format!(
                "follow group {group_id} has no MIDI-mappable pitch"
            )));
        }
        let source_count = group.pitches.len();
        let mut seen_notes = HashSet::new();
        let mut pitches = Vec::with_capacity(source_count);
        let mut duplicate_midi_notes = Vec::new();
        let mut duplicate_spellings = Vec::new();
        for pitch in group.pitches {
            if pitch.spelling.trim().is_empty() {
                return Err(CoreError::InvalidPattern(format!(
                    "follow group {group_id} has a pitch without a spelling"
                )));
            }
            if seen_notes.insert(pitch.midi_note) {
                pitches.push(pitch);
            } else {
                duplicate_midi_notes.push(pitch.midi_note);
                duplicate_spellings.push(pitch.spelling);
            }
        }
        source_pitch_count += source_count;
        canonical_pitch_count += pitches.len();
        normalizations.push(FollowGroupNormalization {
            group_id: group_id.clone(),
            source_pitch_count: source_count,
            canonical_pitch_count: pitches.len(),
            duplicate_midi_notes,
            duplicate_spellings,
        });
        normalized_groups.push(FollowGroup {
            group_id,
            bar: group.bar,
            playback_beat: group.playback_beat,
            pitches,
        });
    }
    Ok(NormalizedFollowGroups {
        groups: normalized_groups,
        groups_with_duplicates: normalizations
            .iter()
            .filter(|normalization| !normalization.duplicate_midi_notes.is_empty())
            .count(),
        normalizations,
        source_pitch_count,
        canonical_pitch_count,
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FollowOptions {
    pub bpm: f64,
    pub timing_tolerance_ms: f64,
    pub chord_spread_tolerance_ms: f64,
}

impl FollowOptions {
    pub fn validate(self) -> Result<(), CoreError> {
        if !self.bpm.is_finite() || !(20.0..=300.0).contains(&self.bpm) {
            return Err(CoreError::InvalidTempo);
        }
        if !self.timing_tolerance_ms.is_finite() || self.timing_tolerance_ms < 0.0 {
            return Err(CoreError::InvalidTimeValue);
        }
        if !self.chord_spread_tolerance_ms.is_finite() || self.chord_spread_tolerance_ms < 0.0 {
            return Err(CoreError::InvalidTimeValue);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FollowWrongNote {
    pub midi_note: u8,
    pub at_ms: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FollowTargetResult {
    pub target_id: String,
    pub bar: u32,
    pub expected_pitches: Vec<String>,
    pub matched_pitches: Vec<String>,
    pub wrong_notes: Vec<FollowWrongNote>,
    pub duplicate_notes: usize,
    pub completed: bool,
    pub standard: bool,
    pub first_correct_at_ms: Option<f64>,
    pub completion_at_ms: Option<f64>,
    pub chord_spread_ms: Option<f64>,
    pub interval_error_ms: Option<f64>,
    pub interval_judged: bool,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct FollowTimingSummary {
    pub samples: usize,
    pub mean_signed_ms: Option<f64>,
    pub mean_absolute_ms: Option<f64>,
    pub standard_deviation_ms: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FollowReport {
    pub strict_timing: bool,
    pub total_targets: usize,
    pub completed_targets: usize,
    pub standard_targets: usize,
    pub pending_target_id: Option<String>,
    pub wrong_note_count: usize,
    pub extra_note_count: usize,
    pub duplicate_note_count: usize,
    pub timing: FollowTimingSummary,
    pub targets: Vec<FollowTargetResult>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FollowNoteResult {
    /// correct | partial | wrong | duplicate | complete | extra
    pub kind: String,
    pub target_id: Option<String>,
    pub advanced: bool,
    pub expected_pitches: Vec<String>,
    pub remaining_pitches: Vec<String>,
    pub completed_target: Option<FollowTargetResult>,
    pub report: Option<FollowReport>,
    pub progress_index: usize,
    pub progress_total: usize,
    pub completed_count: usize,
}

#[derive(Clone, Debug)]
pub struct FollowRuntime {
    groups: Vec<FollowGroup>,
    options: FollowOptions,
    target_results: Vec<FollowTargetResult>,
    current_index: usize,
    matched: HashSet<u8>,
    matched_names: Vec<String>,
    wrong_notes: Vec<FollowWrongNote>,
    duplicate_notes: usize,
    first_correct_at_ms: Option<f64>,
    previous_first_correct_at_ms: Option<f64>,
    previous_playback_beat: f64,
    extra_note_count: usize,
}

impl FollowRuntime {
    pub fn new(groups: Vec<FollowGroup>, options: FollowOptions) -> Result<Self, CoreError> {
        options.validate()?;
        Ok(Self {
            groups,
            options,
            target_results: Vec::new(),
            current_index: 0,
            matched: HashSet::new(),
            matched_names: Vec::new(),
            wrong_notes: Vec::new(),
            duplicate_notes: 0,
            first_correct_at_ms: None,
            previous_first_correct_at_ms: None,
            previous_playback_beat: 0.0,
            extra_note_count: 0,
        })
    }

    pub fn is_complete(&self) -> bool {
        self.current_index >= self.groups.len()
    }

    pub fn completed_count(&self) -> usize {
        self.target_results.iter().filter(|target| target.completed).count()
    }

    pub fn progress(&self) -> (usize, usize) {
        (self.current_index, self.groups.len())
    }

    pub fn current_group(&self) -> Option<&FollowGroup> {
        self.groups.get(self.current_index)
    }

    pub fn push_note(&mut self, midi_note: u8, at_ms: f64) -> Result<FollowNoteResult, CoreError> {
        if !at_ms.is_finite() || at_ms < 0.0 {
            return Err(CoreError::InvalidTimeValue);
        }
        if self.is_complete() {
            self.extra_note_count += 1;
            return Ok(self.result("extra", None, false, Vec::new(), Vec::new(), None, None));
        }
        let group = self.groups[self.current_index].clone();
        let expected = &group.pitches;
        if expected.is_empty() {
            return Err(CoreError::InvalidPattern(
                "current follow target has no MIDI-mappable pitch".to_string(),
            ));
        }
        let expected_names: Vec<String> = expected.iter().map(|pitch| pitch.spelling.clone()).collect();
        let expected_midi: Vec<u8> = expected.iter().map(|pitch| pitch.midi_note).collect();
        if !expected_midi.contains(&midi_note) {
            self.wrong_notes.push(FollowWrongNote { midi_note, at_ms });
            let remaining = names_without_matched(&expected_names, &expected_midi, &self.matched);
            return Ok(self.result(
                "wrong",
                Some(group.group_id.clone()),
                false,
                expected_names,
                remaining,
                None,
                None,
            ));
        }
        if self.matched.contains(&midi_note) {
            self.duplicate_notes += 1;
            let remaining = names_without_matched(&expected_names, &expected_midi, &self.matched);
            return Ok(self.result(
                "duplicate",
                Some(group.group_id.clone()),
                false,
                expected_names,
                remaining,
                None,
                None,
            ));
        }

        if self.first_correct_at_ms.is_none() {
            self.first_correct_at_ms = Some(at_ms);
        }
        self.matched.insert(midi_note);
        let matched_position = expected_midi.iter().position(|note| *note == midi_note).unwrap_or(0);
        self.matched_names.push(expected[matched_position].spelling.clone());
        let remaining = names_without_matched(&expected_names, &expected_midi, &self.matched);

        if self.matched.len() < expected.len() {
            return Ok(self.result(
                "partial",
                Some(group.group_id.clone()),
                false,
                expected_names,
                remaining,
                None,
                None,
            ));
        }

        let first_correct_at_ms = self.first_correct_at_ms;
        let chord_spread_ms = first_correct_at_ms.map(|first| at_ms - first);
        let mut interval_error_ms = None;
        let mut interval_judged = false;
        if let Some(previous) = self.previous_first_correct_at_ms {
            let expected_gap_ms =
                (group.playback_beat - self.previous_playback_beat) * (60_000.0 / self.options.bpm);
            let actual_gap_ms = first_correct_at_ms.unwrap_or(at_ms) - previous;
            interval_error_ms = Some(actual_gap_ms - expected_gap_ms);
            interval_judged = true;
        }
        let clean = self.wrong_notes.is_empty();
        let spread_ok = chord_spread_ms
            .map(|spread| spread <= self.options.chord_spread_tolerance_ms)
            .unwrap_or(true);
        let timing_ok = interval_error_ms
            .map(|error| error.abs() <= self.options.timing_tolerance_ms)
            .unwrap_or(true);
        let completed = FollowTargetResult {
            target_id: group.group_id.clone(),
            bar: group.bar,
            expected_pitches: expected_names.clone(),
            matched_pitches: self.matched_names.clone(),
            wrong_notes: self.wrong_notes.clone(),
            duplicate_notes: self.duplicate_notes,
            completed: true,
            standard: clean && spread_ok && timing_ok,
            first_correct_at_ms,
            completion_at_ms: Some(at_ms),
            chord_spread_ms,
            interval_error_ms,
            interval_judged,
        };
        self.target_results.push(completed.clone());
        self.previous_first_correct_at_ms = first_correct_at_ms;
        self.previous_playback_beat = group.playback_beat;
        self.current_index += 1;
        self.matched.clear();
        self.matched_names.clear();
        self.wrong_notes.clear();
        self.duplicate_notes = 0;
        self.first_correct_at_ms = None;

        let kind = if self.is_complete() { "complete" } else { "correct" };
        let report = if self.is_complete() { Some(self.build_report()) } else { None };
        let mut result = self.result(
            kind,
            Some(group.group_id.clone()),
            true,
            expected_names,
            Vec::new(),
            Some(completed),
            report,
        );
        result.progress_index = self.current_index;
        result.completed_count = self.completed_count();
        Ok(result)
    }

    /// After a deliberate pause, the next interval is not comparable.
    pub fn invalidate_next_interval(&mut self) {
        self.previous_first_correct_at_ms = None;
    }

    pub fn finish(&self) -> FollowReport {
        self.build_report()
    }

    fn result(
        &self,
        kind: &str,
        target_id: Option<String>,
        advanced: bool,
        expected_pitches: Vec<String>,
        remaining_pitches: Vec<String>,
        completed_target: Option<FollowTargetResult>,
        report: Option<FollowReport>,
    ) -> FollowNoteResult {
        FollowNoteResult {
            kind: kind.to_string(),
            target_id,
            advanced,
            expected_pitches,
            remaining_pitches,
            completed_target,
            report,
            progress_index: self.current_index,
            progress_total: self.groups.len(),
            completed_count: self.completed_count(),
        }
    }

    fn build_report(&self) -> FollowReport {
        let completed: Vec<&FollowTargetResult> =
            self.target_results.iter().filter(|target| target.completed).collect();
        let timing_samples: Vec<f64> = completed
            .iter()
            .filter(|target| target.interval_judged && target.wrong_notes.is_empty())
            .filter_map(|target| target.interval_error_ms)
            .collect();
        let mean_signed = if timing_samples.is_empty() {
            None
        } else {
            Some(timing_samples.iter().sum::<f64>() / timing_samples.len() as f64)
        };
        let mean_absolute = if timing_samples.is_empty() {
            None
        } else {
            Some(timing_samples.iter().map(|value| value.abs()).sum::<f64>() / timing_samples.len() as f64)
        };
        let variance = match (timing_samples.is_empty(), mean_signed) {
            (false, Some(mean)) => Some(
                timing_samples.iter().map(|value| (value - mean).powi(2)).sum::<f64>()
                    / timing_samples.len() as f64,
            ),
            _ => None,
        };
        FollowReport {
            strict_timing: false,
            total_targets: self.groups.len(),
            completed_targets: completed.len(),
            standard_targets: completed.iter().filter(|target| target.standard).count(),
            pending_target_id: self.groups.get(self.current_index).map(|group| group.group_id.clone()),
            wrong_note_count: self.target_results.iter().map(|target| target.wrong_notes.len()).sum::<usize>()
                + self.wrong_notes.len(),
            extra_note_count: self.extra_note_count,
            duplicate_note_count: self.target_results.iter().map(|target| target.duplicate_notes).sum::<usize>()
                + self.duplicate_notes,
            timing: FollowTimingSummary {
                samples: timing_samples.len(),
                mean_signed_ms: mean_signed,
                mean_absolute_ms: mean_absolute,
                standard_deviation_ms: variance.map(f64::sqrt),
            },
            targets: self.target_results.clone(),
        }
    }
}

fn names_without_matched(
    expected_names: &[String],
    expected_midi: &[u8],
    matched: &HashSet<u8>,
) -> Vec<String> {
    expected_names
        .iter()
        .zip(expected_midi.iter())
        .filter(|(_, midi)| !matched.contains(midi))
        .map(|(name, _)| name.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pitch(midi_note: u8, spelling: &str) -> FollowPitch {
        FollowPitch { midi_note, spelling: spelling.to_string() }
    }

    fn group(id: &str, beat: f64, pitches: Vec<FollowPitch>) -> FollowGroup {
        FollowGroup { group_id: id.to_string(), bar: 1, playback_beat: beat, pitches }
    }

    fn options() -> FollowOptions {
        FollowOptions { bpm: 60.0, timing_tolerance_ms: 60.0, chord_spread_tolerance_ms: 50.0 }
    }

    #[test]
    fn wrong_and_duplicate_notes_do_not_advance() {
        let mut runtime = FollowRuntime::new(vec![group("g1", 0.0, vec![pitch(60, "C4"), pitch(64, "E4")])], options()).unwrap();
        let wrong = runtime.push_note(62, 100.0).unwrap();
        assert_eq!(wrong.kind, "wrong");
        assert!(!wrong.advanced);
        assert_eq!(wrong.remaining_pitches, vec!["C4", "E4"]);
        let partial = runtime.push_note(60, 120.0).unwrap();
        assert_eq!(partial.kind, "partial");
        assert_eq!(partial.remaining_pitches, vec!["E4"]);
        let duplicate = runtime.push_note(60, 130.0).unwrap();
        assert_eq!(duplicate.kind, "duplicate");
        assert!(!duplicate.advanced);
        let complete = runtime.push_note(64, 140.0).unwrap();
        assert_eq!(complete.kind, "complete");
        assert!(complete.advanced);
        assert!(complete.report.is_some());
        assert_eq!(complete.completed_target.unwrap().standard, false); // wrong note in target
    }

    #[test]
    fn interval_error_and_standard_flag() {
        let mut runtime = FollowRuntime::new(
            vec![group("g1", 0.0, vec![pitch(60, "C4")]), group("g2", 1.0, vec![pitch(62, "D4")])],
            options(),
        ).unwrap();
        assert_eq!(runtime.push_note(60, 0.0).unwrap().kind, "correct");
        let second = runtime.push_note(62, 1_100.0).unwrap();
        assert_eq!(second.kind, "complete");
        let target = second.completed_target.unwrap();
        assert_eq!(target.interval_error_ms, Some(100.0));
        assert_eq!(target.standard, false); // timing tolerance 60ms
        assert_eq!(runtime.finish().timing.mean_absolute_ms, Some(100.0));
    }

    #[test]
    fn pause_invalidation_drops_next_interval() {
        let mut runtime = FollowRuntime::new(
            vec![group("g1", 0.0, vec![pitch(60, "C4")]), group("g2", 1.0, vec![pitch(62, "D4")])],
            options(),
        ).unwrap();
        runtime.push_note(60, 0.0).unwrap();
        runtime.invalidate_next_interval();
        let second = runtime.push_note(62, 5_000.0).unwrap();
        assert_eq!(second.completed_target.unwrap().interval_judged, false);
        assert_eq!(runtime.finish().timing.samples, 0);
    }

    #[test]
    fn extra_after_completion_is_counted() {
        let mut runtime = FollowRuntime::new(vec![group("g1", 0.0, vec![pitch(60, "C4")])], options()).unwrap();
        assert_eq!(runtime.push_note(60, 0.0).unwrap().kind, "complete");
        let extra = runtime.push_note(62, 100.0).unwrap();
        assert_eq!(extra.kind, "extra");
        assert_eq!(runtime.finish().extra_note_count, 1);
    }

    #[test]
    fn normalization_dedupes_unison_and_preserves_source_evidence() {
        let normalized = normalize_follow_groups(vec![
            group("g1", 0.0, vec![pitch(60, "C4"), pitch(60, "C4"), pitch(64, "E4")]),
            group("g2", 1.0, vec![pitch(67, "G4")]),
        ])
        .unwrap();
        assert_eq!(normalized.groups[0].pitches, vec![pitch(60, "C4"), pitch(64, "E4")]);
        assert_eq!(normalized.groups_with_duplicates, 1);
        assert_eq!(normalized.source_pitch_count, 4);
        assert_eq!(normalized.canonical_pitch_count, 3);
        assert_eq!(normalized.normalizations[0].duplicate_midi_notes, vec![60]);
        assert_eq!(
            normalized.normalizations[0].duplicate_spellings,
            vec!["C4".to_string()]
        );
        assert!(normalized.normalizations[1].duplicate_midi_notes.is_empty());
    }

    #[test]
    fn normalization_rejects_semantically_invalid_target_lists() {
        assert!(normalize_follow_groups(Vec::new()).is_err());
        assert!(normalize_follow_groups(vec![group("g1", 0.0, vec![])]).is_err());
        assert!(normalize_follow_groups(vec![
            group("g1", 0.0, vec![pitch(60, "C4")]),
            group("g1", 1.0, vec![pitch(62, "D4")]),
        ])
        .is_err());
        assert!(normalize_follow_groups(vec![
            group("g1", 1.0, vec![pitch(60, "C4")]),
            group("g2", 0.0, vec![pitch(62, "D4")]),
        ])
        .is_err());
        assert!(normalize_follow_groups(vec![FollowGroup {
            group_id: "g1".to_string(),
            bar: 0,
            playback_beat: 0.0,
            pitches: vec![pitch(60, "C4")],
        }])
        .is_err());
    }
}
