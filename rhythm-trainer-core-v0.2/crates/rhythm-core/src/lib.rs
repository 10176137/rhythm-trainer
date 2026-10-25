//! Deterministic rhythm-training core. No Node, browser, MIDI, audio, or UI dependencies.

pub mod contract_v1;
mod duration;
mod error;
mod events;
pub mod follow;
mod matcher;
mod midi;
mod replay;
mod scoring_v1;
mod ring_buffer;
mod schedule;
mod session;
mod stats;
pub mod take;
mod teaching;

pub use duration::{
    assess_durations, assess_presses, assess_presses_with_pauses, pair_note_events, DurationAssessment, DurationPolicy, DurationPolicyKind,
    DurationReport, DurationResult, NoteEventQuality, PerformedNote, RawMidiNoteEvent, RawNoteKind,
};
pub use error::CoreError;
pub use events::{Grade, InputSource, Judgment, StrikeEvent};
pub use midi::{
    decode_ingest_packet, track_key_lifecycles, ClockQuality, DecodedMidiEvent, IngestMidiPacket,
    KeyLifecycleReport, KeyLifecycleTracker, KeyPressObservation, KeyPressStatus, MidiDiagnostic,
    MidiEventKind, MidiEventOriginalEncoding, MidiTransport, RawMidiPacket,
    MIDI_CONTRACT_ALGORITHM_VERSION,
};
pub use matcher::HitMatcher;
pub use replay::{replay_score, ReplayResult};
pub use ring_buffer::RingBuffer;
pub use schedule::{apply_judgment_windows, build_schedule, AtomKind, JudgmentProfile, RhythmAtom, RhythmPattern, TargetHit};
pub use scoring_v1::{
    align_performances, score_performance, AlignmentPair, AlignmentResult, Confidence,
    Diagnostic as ScoringDiagnostic,
    MeasureReport, OverallScore, PairingStatusV1, PerformedNoteV1, PitchAccuracy, PracticeProfileV1,
    PracticeRange, RhythmMetrics, ScoreEvent, ScoringConfig, SessionScoreReport, SubScore,
    SCORING_ALGORITHM_VERSION,
};
pub use session::{EngineDiagnostics, SessionEngine, SessionReport, SessionState};
pub use stats::{calculate_stats, ScoreStats};

pub use teaching::{
    diagnose_timing, extract_timing_features, recommend_exercise, DiagnosticContext,
    DiagnosisReport, Diagnostic, DiagnosisThresholds, EvidenceConfidence, ExerciseKind,
    ExercisePrescription, MasteryAttempt, MasteryPolicy, MasteryState, MetronomeMode,
    SkillProgress, Severity, StudentModel, TimingFeatures, TimingIssue,
};
