//! R2-3a2: exact rational arithmetic for the contract layer. All
//! intermediate math uses `num_bigint::BigInt` (arbitrary precision — the
//! three-factor product beat.num × 60_000_000 × bpm.denominator can reach
//! ≈2^132, beyond i128); results are range-checked to the safe-integer
//! domain only AFTER the exact computation (task card §3, fourth review).

use num_bigint::BigInt;
use serde::{Deserialize, Serialize};

use crate::contract_v1::error::ContractError;

pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991; // 2^53 - 1

/// Reduced rational with i64 parts (the persisted contract domain). All
/// arithmetic happens in BigInt and is checked back into this domain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RationalV1 {
    pub numerator: i64,
    pub denominator: i64,
}

pub fn contract_error(code: &str, message: impl Into<String>) -> ContractError {
    ContractError::new(code, message)
}

/// gcd over BigInt (Euclid; magnitudes only). Implemented with the inherent
/// BigInt operators only — no numeric traits.
pub fn big_gcd(mut a: BigInt, mut b: BigInt) -> BigInt {
    let zero = BigInt::from(0);
    if a < zero.clone() {
        a = -a;
    }
    if b < zero {
        b = -b;
    }
    while b != zero {
        let r = &a % &b;
        a = b;
        b = r;
    }
    a
}

/// Canonical (reduced, denominator > 0) check over i64 parts — mirrors TS
/// `isCanonicalRationalV1`.
pub fn is_canonical(numerator: i64, denominator: i64) -> bool {
    if denominator <= 0 {
        return false;
    }
    if numerator == 0 {
        return denominator == 1;
    }
    big_gcd(BigInt::from(numerator), BigInt::from(denominator)) == BigInt::from(1)
}

/// Reduces arbitrary i64 parts into canonical form; zero normalizes to 0/1.
/// Reduced parts beyond the safe-integer domain are rejected (aligned with
/// the TS constructor's RATIONAL_OUT_OF_RANGE).
pub fn reduce(numerator: i64, denominator: i64) -> Result<RationalV1, ContractError> {
    if denominator == 0 {
        return Err(contract_error("INVALID_RATIONAL", "denominator must not be zero"));
    }
    if numerator == 0 {
        return Ok(RationalV1 { numerator: 0, denominator: 1 });
    }
    let n_big = BigInt::from(numerator);
    let d_big = BigInt::from(denominator);
    let g = big_gcd(n_big.clone(), d_big.clone());
    let reduced_n = &n_big / &g;
    let reduced_d = &d_big / &g;
    let n = i64::try_from(&reduced_n)
        .map_err(|_| contract_error("RATIONAL_OUT_OF_RANGE", "reduced numerator out of range"))?;
    let d = i64::try_from(&reduced_d)
        .map_err(|_| contract_error("RATIONAL_OUT_OF_RANGE", "reduced denominator out of range"))?;
    if n.abs() > MAX_SAFE_INTEGER || d.abs() > MAX_SAFE_INTEGER {
        return Err(contract_error(
            "RATIONAL_OUT_OF_RANGE",
            "reduced rational exceeds the safe-integer domain",
        ));
    }
    Ok(RationalV1 { numerator: n, denominator: d })
}

/// Cross-multiplied exact comparison: a/b > c/d via BigInt.
pub fn rational_greater(a: &RationalV1, b: &RationalV1) -> bool {
    BigInt::from(a.numerator) * BigInt::from(b.denominator)
        > BigInt::from(b.numerator) * BigInt::from(a.denominator)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_checks_match_ts_semantics() {
        assert!(is_canonical(1, 3));
        assert!(is_canonical(0, 1));
        assert!(!is_canonical(2, 6)); // not reduced
        assert!(!is_canonical(1, -3)); // negative denominator
        assert!(!is_canonical(1, 0));
        assert!(!is_canonical(0, 2)); // zero must be 0/1
    }

    #[test]
    fn reduce_normalizes_and_rejects() {
        assert_eq!(reduce(2, 6).unwrap(), RationalV1 { numerator: 1, denominator: 3 });
        assert_eq!(reduce(0, 5).unwrap(), RationalV1 { numerator: 0, denominator: 1 });
        assert_eq!(reduce(-2, 6).unwrap(), RationalV1 { numerator: -1, denominator: 3 });
        assert!(reduce(1, 0).is_err());
    }

    #[test]
    fn cross_multiplication_is_exact_near_the_boundary() {
        let a = RationalV1 { numerator: MAX_SAFE_INTEGER, denominator: MAX_SAFE_INTEGER - 1 };
        let b = RationalV1 { numerator: MAX_SAFE_INTEGER - 1, denominator: MAX_SAFE_INTEGER - 2 };
        // a = max/(max-1), b = (max-1)/(max-2); cross-multiplying:
        // max·(max-2) = max²-2max < (max-1)² = max²-2max+1, so b > a by
        // exactly 1/(product) — a difference Number arithmetic would lose.
        assert!(rational_greater(&b, &a));
        assert!(!rational_greater(&a, &b));
    }
}
