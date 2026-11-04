//! Alignment candidate v2 — rule-based minimal fix for the late-note cascade
//! documented in `audit-r1/reports/r2-3/alignment-v2-root-cause.md`.
//!
//! The frozen `scoring_v1` matcher marks a target missed when a performed note
//! is more than `max_onset_deviation_ms` late and leaves that note unconsumed;
//! the same note is then compared against the NEXT target and either steals it
//! (wrong-pitch cascade) or halves the tail into miss+extra pairs.
//!
//! This candidate keeps every other decision of the frozen matcher and adds
//! one rule: a late performed note that carries the CURRENT target's pitch is
//! paired with that target inside a bounded late window derived from the local
//! target interval. It never rewrites `onset_error_ms` — grading still sees
//! the raw lateness. Notes that cannot belong to the current target are
//! consumed instead of being left to steal the following target.
//!
//! Not wired into `scorePerformance`: callers must opt in explicitly while the
//! benchmark gate is open.

use crate::{AlignmentPair, AlignmentResult, CoreError, PerformedNoteV1, ScoreEvent, ScoringConfig};

/// Upper bound for the one-sided late window. Long enough for the synthetic
/// 600 ms phase shift at a 750 ms IOI, short enough that a genuinely extra
/// note is not absorbed into a target.
pub const MAX_LATE_WINDOW_MS: f64 = 600.0;
/// Fraction of the local target interval that may be forgiven as lateness.
pub const LATE_WINDOW_INTERVAL_RATIO: f64 = 0.8;

fn late_window_ms(targets: &[&ScoreEvent], index: usize, max_dev: f64) -> f64 {
    let target = targets[index];
    let interval = match targets.get(index + 1) {
        Some(next) => next.target_onset_ms - target.target_onset_ms,
        // The final target has no following interval: use the absolute cap so
        // the last late note can still pair its own target.
        None => return MAX_LATE_WINDOW_MS,
    };
    if !interval.is_finite() || interval <= 0.0 {
        return MAX_LATE_WINDOW_MS;
    }
    (interval * LATE_WINDOW_INTERVAL_RATIO).clamp(max_dev, MAX_LATE_WINDOW_MS)
}

/// Rule-based candidate. Same monotonic contract as `align_performances`;
/// same-onset chord handling is unchanged.
pub fn align_performances_candidate(
    score_events: &[ScoreEvent],
    performed: &[PerformedNoteV1],
    config: &ScoringConfig,
) -> Result<AlignmentResult, CoreError> {
    for event in score_events {
        if !event.target_onset_ms.is_finite() || event.target_onset_ms < 0.0 {
            return Err(CoreError::InvalidEvent("score target onset must be finite and >= 0".into()));
        }
    }
    let mut targets: Vec<&ScoreEvent> = score_events.iter().filter(|event| event.target_onset_ms.is_finite()).collect();
    targets.sort_by(|a, b| a.target_onset_ms.total_cmp(&b.target_onset_ms));
    let mut performed_sorted: Vec<&PerformedNoteV1> = performed.iter().collect();
    performed_sorted.sort_by(|a, b| a.onset_ms.total_cmp(&b.onset_ms).then(a.performed_note_id.cmp(&b.performed_note_id)));

    let mut result = AlignmentResult::default();
    let mut i = 0usize;
    let mut j = 0usize;
    let max_dev = config.max_onset_deviation_ms;
    let same_onset_epsilon = 0.001_f64;
    let mut consumed = vec![false; performed_sorted.len()];

    while i < targets.len() && j < performed_sorted.len() {
        let target = targets[i];
        let note = performed_sorted[j];
        let delta = note.onset_ms - target.target_onset_ms;

        let group_size = targets[i..]
            .iter()
            .take_while(|candidate| (candidate.target_onset_ms - target.target_onset_ms).abs() <= same_onset_epsilon)
            .count();
        if group_size > 1 {
            // Chord handling is deliberately identical to scoring_v1: the
            // cascade fix targets sequential notes, not simultaneous groups.
            while j < performed_sorted.len() && performed_sorted[j].onset_ms < target.target_onset_ms - max_dev {
                if !consumed[j] {
                    result.extra_performed_ids.push(performed_sorted[j].performed_note_id.clone());
                    consumed[j] = true;
                }
                j += 1;
            }
            let candidate_start = j;
            let next_onset = targets
                .get(i + group_size)
                .map(|next| next.target_onset_ms)
                .unwrap_or(f64::INFINITY);
            let candidate_stop = (target.target_onset_ms + max_dev).min(next_onset);
            let mut candidate_end = j;
            while candidate_end < performed_sorted.len()
                && performed_sorted[candidate_end].onset_ms < candidate_stop
            {
                candidate_end += 1;
            }
            if candidate_start == candidate_end {
                for group_target in &targets[i..i + group_size] {
                    result.missed_score_event_ids.push(group_target.score_event_id.clone());
                }
                i += group_size;
                continue;
            }
            for (group_offset, group_target) in targets[i..i + group_size].iter().enumerate() {
                let mut best: Option<usize> = None;
                let mut best_error = f64::INFINITY;
                for candidate in candidate_start..candidate_end {
                    if consumed[candidate] || performed_sorted[candidate].pitch != group_target.pitch {
                        continue;
                    }
                    let error = (performed_sorted[candidate].onset_ms - group_target.target_onset_ms).abs();
                    if error < best_error {
                        best = Some(candidate);
                        best_error = error;
                    }
                }
                let pair_index = if let Some(candidate) = best {
                    Some(candidate)
                } else {
                    let mut fallback: Option<usize> = None;
                    let mut fallback_error = f64::INFINITY;
                    for candidate in candidate_start..candidate_end {
                        if consumed[candidate] {
                            continue;
                        }
                        // Preserve a candidate whose pitch belongs to a later
                        // tone in this chord (feat/teaching-experience-v1
                        // 2d461e2). Missing low tones must not consume an
                        // actually played high tone as a wrong-pitch fallback.
                        if targets[i + group_offset + 1..i + group_size].iter().any(|other| {
                            other.pitch == performed_sorted[candidate].pitch
                        }) {
                            continue;
                        }
                        let error = (performed_sorted[candidate].onset_ms - group_target.target_onset_ms).abs();
                        if error < fallback_error {
                            fallback = Some(candidate);
                            fallback_error = error;
                        }
                    }
                    fallback
                };
                if let Some(candidate) = pair_index {
                    let matched_note = performed_sorted[candidate];
                    consumed[candidate] = true;
                    result.pairs.push(AlignmentPair {
                        score_event_id: group_target.score_event_id.clone(),
                        performed_note_id: matched_note.performed_note_id.clone(),
                        pitch_matched: matched_note.pitch == group_target.pitch,
                        onset_error_ms: matched_note.onset_ms - group_target.target_onset_ms,
                        measure: group_target.measure,
                    });
                } else {
                    result.missed_score_event_ids.push(group_target.score_event_id.clone());
                }
            }
            for candidate in candidate_start..candidate_end {
                if !consumed[candidate] {
                    result.extra_performed_ids.push(performed_sorted[candidate].performed_note_id.clone());
                    consumed[candidate] = true;
                }
            }
            i += group_size;
            j = candidate_end;
            continue;
        }

        if delta < -max_dev {
            result.extra_performed_ids.push(note.performed_note_id.clone());
            j += 1;
            continue;
        }
        if delta > max_dev {
            let window = late_window_ms(&targets, i, max_dev);
            if note.pitch == target.pitch && delta <= window {
                // The played note is the intended pitch, just late. Pair it and
                // keep the raw error; the tail no longer shifts by one target.
                result.pairs.push(AlignmentPair {
                    score_event_id: target.score_event_id.clone(),
                    performed_note_id: note.performed_note_id.clone(),
                    pitch_matched: true,
                    onset_error_ms: delta,
                    measure: target.measure,
                });
                consumed[j] = true;
                i += 1;
                j += 1;
                continue;
            }
            // A later target may legitimately own this note (skipped target).
            let later_target_owns_note = targets.iter().skip(i + 1).take(4)
                .any(|later| later.pitch == note.pitch && (note.onset_ms - later.target_onset_ms).abs() <= max_dev);
            result.missed_score_event_ids.push(target.score_event_id.clone());
            i += 1;
            if !later_target_owns_note && delta > window {
                // Too late even for the widened window and no later target can
                // take it: consume it as an extra instead of letting it steal
                // the next target.
                result.extra_performed_ids.push(note.performed_note_id.clone());
                consumed[j] = true;
                j += 1;
            }
            continue;
        }

        let pitch_equal = note.pitch == target.pitch;
        if pitch_equal {
            result.pairs.push(AlignmentPair {
                score_event_id: target.score_event_id.clone(),
                performed_note_id: note.performed_note_id.clone(),
                pitch_matched: true,
                onset_error_ms: delta,
                measure: target.measure,
            });
            i += 1;
            j += 1;
            continue;
        }
        let lookahead_target_has_pitch = targets.iter().skip(i + 1).take(4)
            .any(|later| later.pitch == note.pitch && (note.onset_ms - later.target_onset_ms).abs() <= max_dev);
        let lookahead_performed_has_pitch = performed_sorted.iter().skip(j + 1).take(4)
            .any(|later| later.pitch == target.pitch && (later.onset_ms - target.target_onset_ms).abs() <= max_dev);
        if lookahead_target_has_pitch {
            result.missed_score_event_ids.push(target.score_event_id.clone());
            i += 1;
        } else if lookahead_performed_has_pitch {
            result.extra_performed_ids.push(note.performed_note_id.clone());
            j += 1;
        } else {
            result.pairs.push(AlignmentPair {
                score_event_id: target.score_event_id.clone(),
                performed_note_id: note.performed_note_id.clone(),
                pitch_matched: false,
                onset_error_ms: delta,
                measure: target.measure,
            });
            i += 1;
            j += 1;
        }
    }
    while i < targets.len() {
        result.missed_score_event_ids.push(targets[i].score_event_id.clone());
        i += 1;
    }
    while j < performed_sorted.len() {
        result.extra_performed_ids.push(performed_sorted[j].performed_note_id.clone());
        j += 1;
    }

    let matched_onsets: Vec<f64> = result.pairs.iter()
        .filter_map(|pair| performed_sorted.iter().find(|note| note.performed_note_id == pair.performed_note_id))
        .map(|note| note.onset_ms)
        .collect();
    for extra_id in &result.extra_performed_ids {
        if let Some(note) = performed_sorted.iter().find(|candidate| candidate.performed_note_id == *extra_id) {
            for window in matched_onsets.windows(2) {
                if note.onset_ms > window[0] && note.onset_ms < window[1] {
                    result.rest_window_extra_ids.push(extra_id.clone());
                    break;
                }
            }
        }
    }
    Ok(result)
}
