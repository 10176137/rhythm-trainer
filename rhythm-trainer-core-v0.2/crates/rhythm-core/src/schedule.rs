use crate::CoreError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtomKind {
    Note,
    Rest,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RhythmAtom {
    pub start_tick: u64,
    pub duration_ticks: u64,
    pub kind: AtomKind,
    /// 1-based measure number.
    pub bar: u32,
    /// 1-based beat position; fractions represent subdivisions (e.g. 1.5).
    pub beat: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RhythmPattern {
    pub id: String,
    /// Number of ticks per quarter note. 960 is a convenient default.
    pub ticks_per_quarter: u32,
    pub atoms: Vec<RhythmAtom>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JudgmentProfile {
    /// Maximum absolute error for Perfect.
    pub perfect_ms: f64,
    /// Maximum absolute error for any matched hit (Perfect or Good).
    pub good_ms: f64,
}

impl JudgmentProfile {
    pub const fn strict() -> Self { Self { perfect_ms: 15.0, good_ms: 30.0 } }
    pub const fn standard() -> Self { Self { perfect_ms: 30.0, good_ms: 60.0 } }
    pub const fn relaxed() -> Self { Self { perfect_ms: 50.0, good_ms: 100.0 } }

    pub fn validate(self) -> Result<(), CoreError> {
        if !self.perfect_ms.is_finite()
            || !self.good_ms.is_finite()
            || self.perfect_ms < 0.0
            || self.good_ms < self.perfect_ms
        {
            return Err(CoreError::InvalidProfile);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TargetHit {
    pub id: String,
    pub index: usize,
    pub at_ms: f64,
    pub bar: Option<u32>,
    pub beat: Option<f64>,
    pub perfect_window_ms: f64,
    pub good_window_ms: f64,
    /// Nominal score duration in milliseconds (duration_ticks → ms at the
    /// current tempo). Chord atoms merged into one onset take the longest
    /// duration. Feeds key-down duration assessment; onset matching ignores it.
    pub nominal_duration_ms: f64,
}

/// Converts notation ticks into target onsets. Rest atoms don't create targets.
/// Chord notes / voices sharing a tick must be represented by atoms at the same tick;
/// they are merged into one rhythm target.
pub fn build_schedule(
    pattern: &RhythmPattern,
    bpm: f64,
    start_at_ms: f64,
    profile: JudgmentProfile,
) -> Result<Vec<TargetHit>, CoreError> {
    if !bpm.is_finite() || !(20.0..=300.0).contains(&bpm) {
        return Err(CoreError::InvalidTempo);
    }
    if !start_at_ms.is_finite() || start_at_ms < 0.0 {
        return Err(CoreError::InvalidStartTime);
    }
    profile.validate()?;
    if pattern.id.trim().is_empty() {
        return Err(CoreError::InvalidPattern("id cannot be empty".to_string()));
    }
    if pattern.ticks_per_quarter == 0 {
        return Err(CoreError::InvalidPattern("ticks_per_quarter must be positive".to_string()));
    }
    if pattern.atoms.is_empty() {
        return Err(CoreError::InvalidPattern("at least one atom is required".to_string()));
    }

    for atom in &pattern.atoms {
        if atom.duration_ticks == 0 {
            return Err(CoreError::InvalidPattern("duration_ticks must be positive".to_string()));
        }
        if atom.bar == 0 || !atom.beat.is_finite() || atom.beat < 1.0 {
            return Err(CoreError::InvalidPattern("bar must be >= 1 and beat must be finite and >= 1".to_string()));
        }
    }

    let quarter_ms = 60_000.0 / bpm;
    let mut onset_atoms: Vec<&RhythmAtom> = pattern.atoms.iter()
        .filter(|atom| atom.kind == AtomKind::Note)
        .collect();
    onset_atoms.sort_by_key(|atom| atom.start_tick);

    let mut targets: Vec<TargetHit> = Vec::new();
    for atom in onset_atoms {
        if targets.last().is_some_and(|last| {
            // The tick value is encoded in the generated ID; avoid reparsing floats.
            last.id == format!("{}:tick:{}", pattern.id, atom.start_tick)
        }) {
            // Same onset (chord/voice): keep the longest duration as nominal.
            let nominal = (atom.duration_ticks as f64 / pattern.ticks_per_quarter as f64) * quarter_ms;
            if nominal > targets.last().unwrap().nominal_duration_ms {
                targets.last_mut().unwrap().nominal_duration_ms = nominal;
            }
            continue;
        }
        let at_ms = start_at_ms + (atom.start_tick as f64 / pattern.ticks_per_quarter as f64) * quarter_ms;
        if !at_ms.is_finite() {
            return Err(CoreError::InvalidPattern("calculated target time overflowed".to_string()));
        }
        targets.push(TargetHit {
            id: format!("{}:tick:{}", pattern.id, atom.start_tick),
            index: targets.len(),
            at_ms,
            bar: Some(atom.bar),
            beat: Some(atom.beat),
            perfect_window_ms: 0.0,
            good_window_ms: 0.0,
            nominal_duration_ms: (atom.duration_ticks as f64 / pattern.ticks_per_quarter as f64) * quarter_ms,
        });
    }

    if targets.is_empty() {
        return Err(CoreError::InvalidPattern("pattern contains no note onsets".to_string()));
    }
    apply_judgment_windows(&mut targets, profile)?;
    Ok(targets)
}

/// Applies maximum windows while preventing adjacent effective windows from overlapping.
pub fn apply_judgment_windows(
    targets: &mut [TargetHit],
    profile: JudgmentProfile,
) -> Result<(), CoreError> {
    profile.validate()?;
    for (index, target) in targets.iter().enumerate() {
        if !target.at_ms.is_finite() || target.at_ms < 0.0 {
            return Err(CoreError::InvalidTargetSchedule("target time must be finite and non-negative".to_string()));
        }
        if index > 0 && target.at_ms <= targets[index - 1].at_ms {
            return Err(CoreError::InvalidTargetSchedule("target onsets must be strictly increasing; merge simultaneous notes first".to_string()));
        }
    }

    for index in 0..targets.len() {
        let mut gaps = Vec::with_capacity(2);
        if index > 0 {
            gaps.push(targets[index].at_ms - targets[index - 1].at_ms);
        }
        if index + 1 < targets.len() {
            gaps.push(targets[index + 1].at_ms - targets[index].at_ms);
        }
        let nearest_gap = gaps.into_iter().fold(f64::INFINITY, f64::min);
        // 0.45 is an engineering guard, not a music-pedagogy standard.
        let effective_good = profile.good_ms.min(nearest_gap * 0.45);
        targets[index].good_window_ms = effective_good;
        targets[index].perfect_window_ms = profile.perfect_ms.min(effective_good);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern() -> RhythmPattern {
        RhythmPattern {
            id: "test".to_string(),
            ticks_per_quarter: 960,
            atoms: vec![
                RhythmAtom { start_tick: 0, duration_ticks: 960, kind: AtomKind::Note, bar: 1, beat: 1.0 },
                RhythmAtom { start_tick: 480, duration_ticks: 480, kind: AtomKind::Rest, bar: 1, beat: 1.5 },
                RhythmAtom { start_tick: 960, duration_ticks: 960, kind: AtomKind::Note, bar: 1, beat: 2.0 },
            ],
        }
    }

    #[test]
    fn converts_ticks_and_ignores_rests_as_targets() {
        let targets = build_schedule(&pattern(), 120.0, 1_000.0, JudgmentProfile::standard()).unwrap();
        assert_eq!(targets.len(), 2);
        assert!((targets[0].at_ms - 1_000.0).abs() < 0.001);
        assert!((targets[1].at_ms - 1_500.0).abs() < 0.001);
    }

    #[test]
    fn same_tick_notes_are_merged() {
        let mut p = pattern();
        p.atoms.push(RhythmAtom { start_tick: 0, duration_ticks: 1920, kind: AtomKind::Note, bar: 1, beat: 1.0 });
        assert_eq!(build_schedule(&p, 120.0, 0.0, JudgmentProfile::standard()).unwrap().len(), 2);
    }

    #[test]
    fn strict_profile_is_capped_by_neighbor_gap() {
        let p = RhythmPattern {
            id: "dense".to_string(), ticks_per_quarter: 960,
            atoms: vec![
                RhythmAtom { start_tick: 0, duration_ticks: 240, kind: AtomKind::Note, bar: 1, beat: 1.0 },
                RhythmAtom { start_tick: 240, duration_ticks: 240, kind: AtomKind::Note, bar: 1, beat: 1.25 },
            ],
        };
        let targets = build_schedule(&p, 120.0, 0.0, JudgmentProfile::relaxed()).unwrap();
        assert!(targets[0].good_window_ms + targets[1].good_window_ms < targets[1].at_ms - targets[0].at_ms);
    }

    #[test]
    fn rejects_invalid_bpm() {
        assert!(build_schedule(&pattern(), 0.0, 0.0, JudgmentProfile::standard()).is_err());
    }

    #[test]
    fn nominal_duration_scales_with_tempo_not_note_name() {
        // Spec §10.1.7: quarter (960 ticks) = 750 ms @80 BPM, 375 ms @160 BPM;
        // the beat-based source value never changes, only the conversion.
        let quarter_only = RhythmPattern {
            id: "nominal".to_string(),
            ticks_per_quarter: 960,
            atoms: vec![
                RhythmAtom { start_tick: 0, duration_ticks: 960, kind: AtomKind::Note, bar: 1, beat: 1.0 },
            ],
        };
        let slow = build_schedule(&quarter_only, 80.0, 0.0, JudgmentProfile::standard()).unwrap();
        let fast = build_schedule(&quarter_only, 160.0, 0.0, JudgmentProfile::standard()).unwrap();
        assert!((slow[0].nominal_duration_ms - 750.0).abs() < 1e-9);
        assert!((fast[0].nominal_duration_ms - 375.0).abs() < 1e-9);

        // Eighth (480 ticks) @80 BPM = 375 ms.
        let eighth = RhythmPattern {
            id: "nominal8".to_string(),
            ticks_per_quarter: 960,
            atoms: vec![
                RhythmAtom { start_tick: 0, duration_ticks: 480, kind: AtomKind::Note, bar: 1, beat: 1.0 },
            ],
        };
        let targets = build_schedule(&eighth, 80.0, 0.0, JudgmentProfile::standard()).unwrap();
        assert!((targets[0].nominal_duration_ms - 375.0).abs() < 1e-9);

        // Merged chord atoms keep the LONGEST duration as nominal.
        let chord = RhythmPattern {
            id: "chord".to_string(),
            ticks_per_quarter: 960,
            atoms: vec![
                RhythmAtom { start_tick: 0, duration_ticks: 480, kind: AtomKind::Note, bar: 1, beat: 1.0 },
                RhythmAtom { start_tick: 0, duration_ticks: 1920, kind: AtomKind::Note, bar: 1, beat: 1.0 },
            ],
        };
        let targets = build_schedule(&chord, 80.0, 0.0, JudgmentProfile::standard()).unwrap();
        assert_eq!(targets.len(), 1);
        assert!((targets[0].nominal_duration_ms - 1500.0).abs() < 1e-9, "1920 ticks = 2 beats = 1500 ms @80 BPM");
    }
}
