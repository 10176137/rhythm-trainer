//! R2-3a2: planner config input boundary. The JSON shape mirrors the frozen
//! `parity-case-bundle-v1.schema.json` `config` object; unknown fields are
//! rejected (`deny_unknown_fields`) and every contract constraint is checked
//! BEFORE any plan is produced — an invalid config can never yield a
//! seemingly-successful plan (fourth review item 3).

use num_bigint::BigInt;
use serde::{Deserialize, Serialize};

use crate::contract_v1::error::ContractError;
use crate::contract_v1::rational::{contract_error, is_canonical, MAX_SAFE_INTEGER, RationalV1};

pub const MAX_LOOP_PASSES: i64 = 32;
pub const MIN_BPM: i64 = 20;
pub const MAX_BPM: i64 = 300;

/// Safe-integer domain check over any i64 the config carries (third review:
/// i64 values beyond ±(2^53-1) must not enter arithmetic).
fn ensure_safe_integer(value: i64, field: &str) -> Result<(), ContractError> {
    if value > MAX_SAFE_INTEGER || value < -MAX_SAFE_INTEGER {
        return Err(contract_error(
            "RATIONAL_OUT_OF_RANGE",
            format!("{field} exceeds the safe-integer domain: {value}"),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanRequestConfig {
    #[serde(rename = "partId")]
    pub part_id: String,
    pub range: ConfigRange,
    #[serde(rename = "repeatSelection")]
    pub repeat_selection: ConfigRepeatSelection,
    pub hand: String,
    #[serde(rename = "handMapping")]
    pub hand_mapping: ConfigHandMapping,
    pub bpm: ConfigRational,
    #[serde(rename = "ticksPerQuarter")]
    pub ticks_per_quarter: i64,
    #[serde(rename = "countInUs")]
    pub count_in_us: i64,
    #[serde(rename = "unsupportedNotationPolicy")]
    pub unsupported_notation_policy: String,
    #[serde(rename = "plannerVersion")]
    pub planner_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigRange {
    #[serde(rename = "startMeasureOrdinal")]
    pub start_measure_ordinal: i64,
    #[serde(rename = "endMeasureOrdinal")]
    pub end_measure_ordinal: i64,
}

/// Frozen `oneOf` shape (parity-case-bundle-v1.schema.json): `"none"` carries
/// ONLY `kind`; `"range-loop"` carries `kind` AND a positive `count` within
/// 1..=32. serde cannot express this struct-level mutual exclusion through
/// untagged variants (they silently ignore extra fields), so the exclusion is
/// enforced in `validate_plan_request_config` with negative tests for all
/// three illegal shapes (none+count, range-loop without count, unknown kind).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigRepeatSelection {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigHandMapping {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "mappingVersion")]
    pub mapping_version: String,
    pub source: String,
    pub parts: Vec<ConfigHandMappingPart>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigHandMappingPart {
    pub partId: String,
    pub staves: Vec<ConfigHandMappingStaff>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigHandMappingStaff {
    #[serde(rename = "staffNumber")]
    pub staff_number: i64,
    pub hand: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigRational {
    pub numerator: i64,
    pub denominator: i64,
}

/// Parses and fully validates a planner config. Returns the typed config or
/// the first contract violation (frozen codes; never a partial plan).
pub fn parse_plan_request_config(json: &str) -> Result<PlanRequestConfig, ContractError> {
    let config: PlanRequestConfig = serde_json::from_str(json)
        .map_err(|error| contract_error("SCHEMA_VIOLATION", error.to_string()))?;
    validate_plan_request_config(&config)?;
    Ok(config)
}

pub fn validate_plan_request_config(config: &PlanRequestConfig) -> Result<(), ContractError> {
    // Safe-integer domain for every integer the config carries (third review
    // §一.3: i64 can hold values beyond ±(2^53-1); they must not enter
    // arithmetic — the BPM range comparison below is done in BigInt).
    ensure_safe_integer(config.range.start_measure_ordinal, "startMeasureOrdinal")?;
    ensure_safe_integer(config.range.end_measure_ordinal, "endMeasureOrdinal")?;
    ensure_safe_integer(config.ticks_per_quarter, "ticksPerQuarter")?;
    ensure_safe_integer(config.count_in_us, "countInUs")?;
    ensure_safe_integer(config.bpm.numerator, "bpm.numerator")?;
    ensure_safe_integer(config.bpm.denominator, "bpm.denominator")?;
    for staff in config.hand_mapping.parts.iter().flat_map(|p| &p.staves) {
        ensure_safe_integer(staff.staff_number, "staffNumber")?;
    }
    if let Some(count) = config.repeat_selection.count {
        ensure_safe_integer(count, "repeatSelection.count")?;
    }

    // Non-empty identifiers.
    if config.part_id.trim().is_empty() {
        return Err(contract_error("INVALID_CONFIG", "partId must not be empty"));
    }
    if config.planner_version.trim().is_empty() {
        return Err(contract_error("INVALID_PLANNER_VERSION", "plannerVersion must not be empty"));
    }

    // Range: 1-based, ordered, non-empty.
    let (start, end) = (
        config.range.start_measure_ordinal,
        config.range.end_measure_ordinal,
    );
    if start < 1 || end < start {
        return Err(contract_error(
            "INVALID_RANGE",
            format!("invalid measure range: {start}–{end}"),
        ));
    }

    // Repeat selection — the frozen oneOf is mutually exclusive:
    //   "none" carries ONLY kind (a count present is a contract violation);
    //   "range-loop" REQUIRES count within 1..=32;
    //   any other kind is unknown.
    match config.repeat_selection.kind.as_str() {
        "none" => {
            if config.repeat_selection.count.is_some() {
                return Err(contract_error(
                    "INVALID_REPEAT_SELECTION",
                    "repeatSelection kind 'none' must not carry a count",
                ));
            }
        }
        "range-loop" => match config.repeat_selection.count {
            Some(count) if (1..=MAX_LOOP_PASSES).contains(&count) => {}
            Some(count) => {
                return Err(contract_error(
                    "INVALID_REPEAT_COUNT",
                    format!("range-loop count must be within 1–{MAX_LOOP_PASSES}, got {count}"),
                ))
            }
            None => {
                return Err(contract_error(
                    "INVALID_REPEAT_COUNT",
                    "repeatSelection kind 'range-loop' requires a count",
                ))
            }
        },
        other => {
            return Err(contract_error(
                "INVALID_REPEAT_SELECTION",
                format!("unknown repeat selection kind: {other}"),
            ))
        }
    }

    // Hand: the frozen three-value set.
    if !matches!(config.hand.as_str(), "left" | "right" | "both") {
        return Err(contract_error(
            "INVALID_HAND",
            format!("hand must be left|right|both, got {}", config.hand),
        ));
    }

    // Hand mapping: user/score-metadata only (clef heuristics are display-only
    // and rejected for strict practice, per the frozen HandMappingV1 contract);
    // frozen schemaVersion/mappingVersion values; non-empty part ids.
    if !matches!(config.hand_mapping.source.as_str(), "user" | "score-metadata") {
        return Err(contract_error(
            "HAND_MAPPING_SOURCE_NOT_ALLOWED",
            format!(
                "hand mapping source {} is not allowed for strict practice",
                config.hand_mapping.source
            ),
        ));
    }
    if config.hand_mapping.schema_version != 1 {
        return Err(contract_error(
            "HAND_MAPPING_INCOMPLETE",
            format!(
                "handMapping.schemaVersion must be 1, got {}",
                config.hand_mapping.schema_version
            ),
        ));
    }
    if config.hand_mapping.mapping_version != "hand-mapping-1" {
        return Err(contract_error(
            "HAND_MAPPING_INCOMPLETE",
            format!(
                "handMapping.mappingVersion must be hand-mapping-1, got {}",
                config.hand_mapping.mapping_version
            ),
        ));
    }
    if config.hand_mapping.parts.is_empty() {
        return Err(contract_error("HAND_MAPPING_INCOMPLETE", "hand mapping has no parts"));
    }
    for part in &config.hand_mapping.parts {
        if part.partId.trim().is_empty() {
            return Err(contract_error(
                "HAND_MAPPING_INCOMPLETE",
                "hand mapping partId must not be empty",
            ));
        }
        if part.staves.is_empty() {
            return Err(contract_error(
                "HAND_MAPPING_INCOMPLETE",
                format!("hand mapping part {} has no staves", part.partId),
            ));
        }
        for staff in &part.staves {
            if staff.staff_number < 1 {
                return Err(contract_error(
                    "HAND_MAPPING_INCOMPLETE",
                    "staff numbers must be positive",
                ));
            }
            if !matches!(staff.hand.as_str(), "left" | "right") {
                return Err(contract_error(
                    "HAND_MAPPING_INCOMPLETE",
                    format!("staff hand must be left|right, got {}", staff.hand),
                ));
            }
        }
    }

    // BPM: positive, reduced, safe-integer parts, inside the frozen 20–300
    // product range. The bounds comparison is BigInt: i64 × i64 could
    // overflow even after the safe-integer check (2^53 × 300 > i64::MAX).
    let bpm = &config.bpm;
    if bpm.denominator <= 0 || bpm.numerator <= 0 {
        return Err(contract_error("INVALID_BPM", "bpm must be positive"));
    }
    if !is_canonical(bpm.numerator, bpm.denominator) {
        return Err(contract_error("INVALID_RATIONAL", "bpm must be a reduced rational"));
    }
    let num = BigInt::from(bpm.numerator);
    let den = BigInt::from(bpm.denominator);
    let min_bound = BigInt::from(MIN_BPM) * &den;
    let max_bound = BigInt::from(MAX_BPM) * &den;
    if num < min_bound || num > max_bound {
        return Err(contract_error(
            "INVALID_BPM",
            format!("bpm must be within {MIN_BPM}–{MAX_BPM}"),
        ));
    }

    // PPQ / count-in.
    if config.ticks_per_quarter <= 0 {
        return Err(contract_error("INVALID_PPQ", "ticksPerQuarter must be positive"));
    }
    if config.count_in_us < 0 {
        return Err(contract_error("INVALID_TIME", "countInUs must be a non-negative integer"));
    }

    // Policy: the frozen two-value set.
    if !matches!(
        config.unsupported_notation_policy.as_str(),
        "reject-strict" | "allow-display-only"
    ) {
        return Err(contract_error(
            "INVALID_POLICY",
            format!(
                "unsupportedNotationPolicy must be reject-strict|allow-display-only, got {}",
                config.unsupported_notation_policy
            ),
        ));
    }
    Ok(())
}
