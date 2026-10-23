use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq)]
pub enum CoreError {
    InvalidCapacity,
    InvalidTempo,
    InvalidStartTime,
    InvalidProfile,
    InvalidPattern(String),
    InvalidTargetSchedule(String),
    InvalidEvent(String),
    OutOfOrderEvent { previous_ms: f64, current_ms: f64 },
    OutOfOrderClock { previous_ms: f64, current_ms: f64 },
    QueueOverflow,
    InvalidState { operation: &'static str, state: String },
    InvalidTimeValue,
    InvalidSnapshot(String),
    InvalidConfig(String),
}

impl Display for CoreError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidCapacity => write!(f, "queue capacity must be a positive integer"),
            Self::InvalidTempo => write!(f, "BPM must be finite and within 20..=300"),
            Self::InvalidStartTime => write!(f, "start time must be finite and non-negative"),
            Self::InvalidProfile => write!(f, "judgment profile is invalid"),
            Self::InvalidPattern(message) => write!(f, "invalid rhythm pattern: {message}"),
            Self::InvalidTargetSchedule(message) => write!(f, "invalid target schedule: {message}"),
            Self::InvalidEvent(message) => write!(f, "invalid strike event: {message}"),
            Self::OutOfOrderEvent { previous_ms, current_ms } => write!(
                f,
                "strike timestamps must be non-decreasing (previous={previous_ms}, current={current_ms})"
            ),
            Self::OutOfOrderClock { previous_ms, current_ms } => write!(
                f,
                "session clock must be non-decreasing (previous={previous_ms}, current={current_ms})"
            ),
            Self::QueueOverflow => write!(f, "input queue overflowed; session is not trustworthy"),
            Self::InvalidState { operation, state } => {
                write!(f, "operation `{operation}` is not valid in state `{state}`")
            }
            Self::InvalidTimeValue => write!(f, "time value must be finite and non-negative"),
            Self::InvalidSnapshot(message) => write!(f, "invalid student-model snapshot: {message}"),
            Self::InvalidConfig(message) => write!(f, "invalid configuration: {message}"),
        }
    }
}

impl std::error::Error for CoreError {}
