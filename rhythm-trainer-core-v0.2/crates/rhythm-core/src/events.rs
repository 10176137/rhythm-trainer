use crate::CoreError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputSource {
    Midi,
    Keyboard,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StrikeEvent {
    /// Session-wide sequence assigned by the input adapter.
    pub seq: u64,
    /// Event occurrence time in the session's monotonic millisecond clock domain.
    pub at_ms: f64,
    pub source: InputSource,
    /// MIDI note numbers. Empty for a keyboard-spacebar event.
    pub notes: Vec<u8>,
    /// MIDI velocity if supplied by the device, 0..=127.
    pub velocity: Option<u8>,
}

impl StrikeEvent {
    pub fn validate(&self) -> Result<(), CoreError> {
        if !self.at_ms.is_finite() || self.at_ms < 0.0 {
            return Err(CoreError::InvalidEvent(
                "at_ms must be finite and non-negative".to_string(),
            ));
        }
        if self.notes.iter().any(|note| *note > 127) {
            return Err(CoreError::InvalidEvent(
                "MIDI note numbers must be within 0..=127".to_string(),
            ));
        }
        if self.velocity.is_some_and(|velocity| velocity > 127) {
            return Err(CoreError::InvalidEvent(
                "MIDI velocity must be within 0..=127".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grade {
    Perfect,
    Good,
    Miss,
    Extra,
}

impl Grade {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Perfect => "perfect",
            Self::Good => "good",
            Self::Miss => "miss",
            Self::Extra => "extra",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Judgment {
    pub grade: Grade,
    pub target_id: Option<String>,
    pub target_index: Option<usize>,
    pub strike_seq: Option<u64>,
    /// Positive means late; negative means early. Present for matched events only.
    pub error_ms: Option<f64>,
    pub expected_at_ms: Option<f64>,
    pub actual_at_ms: Option<f64>,
    pub bar: Option<u32>,
    pub beat: Option<f64>,
}
