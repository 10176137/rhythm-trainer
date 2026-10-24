//! Contract error codes — 1:1 with the TS ContractError codes
//! (contract-v1/plan-fingerprint.ts). R2-3a1 only needs the primitives;
//! the full code matrix grows with a2/a3.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractError {
    pub code: String,
    pub message: String,
}

impl ContractError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ContractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ContractError {}
