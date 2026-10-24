//! R2-3a2: frozen time conversion (time-conversion-v1), with the
//! bpm.denominator factor in the numerator — byte-compatible with the TS
//! reference `beatToMicroseconds` (plan-fingerprint.ts:1229):
//!
//!   µs = roundHalfUp( beat.num × 60_000_000 × bpm.den
//!                     ───────────────────────────── )
//!                     beat.den  ×  bpm.num
//!
//! All intermediates are BigInt; the safe-integer check happens on the FINAL
//! value (and on the final addition for target onsets, §3.5). Never floats.

use num_bigint::BigInt;

use crate::contract_v1::error::ContractError;
use crate::contract_v1::rational::{big_gcd, contract_error, is_canonical, MAX_SAFE_INTEGER, RationalV1};

fn err(code: &str, message: impl Into<String>) -> ContractError {
    contract_error(code, message)
}

/// Input-domain alignment with TS `isCanonicalRationalV1`: parts beyond
/// ±(2^53-1) are not canonical rationals (third review §一.3, input-domain
/// consistency for the time/rational conversion interfaces).
fn ensure_rational_in_domain(rational: &RationalV1, field: &str) -> Result<(), ContractError> {
    let over = |v: i64| v > MAX_SAFE_INTEGER || v < -MAX_SAFE_INTEGER;
    if over(rational.numerator) || over(rational.denominator) {
        return Err(err(
            "INVALID_RATIONAL",
            format!("{field} parts exceed the safe-integer domain"),
        ));
    }
    Ok(())
}

fn ensure_count_in_us_in_domain(count_in_us: i64) -> Result<(), ContractError> {
    if count_in_us < 0 {
        return Err(err("INVALID_TIME", "count-in must be a non-negative integer µs value"));
    }
    if count_in_us > MAX_SAFE_INTEGER {
        return Err(err(
            "TIME_OUT_OF_RANGE",
            format!("count-in exceeds the safe-integer domain: {count_in_us}"),
        ));
    }
    Ok(())
}

fn half_up_div(numerator: &BigInt, denominator: &BigInt) -> BigInt {
    // floor((N + D/2) / D) — exact half-up for non-negative values.
    let two = BigInt::from(2);
    let half = denominator / &two;
    let biased = numerator + &half;
    biased / denominator
}

fn to_safe_integer(value: &BigInt) -> Result<i64, ContractError> {
    i64::try_from(value)
        .ok()
        .filter(|v| (0..=MAX_SAFE_INTEGER).contains(v))
        .ok_or_else(|| {
            err("TIME_OUT_OF_RANGE", format!("microsecond result exceeds the safe-integer domain: {value}"))
        })
}

/// Frozen conversion of a non-negative reduced rational beat under a positive
/// reduced rational BPM. Mirrors TS `beatToMicroseconds` error-for-error:
/// `INVALID_RATIONAL` (unreduced), `NEGATIVE_TIME`, `INVALID_BPM`,
/// `TIME_OUT_OF_RANGE`.
pub fn beat_to_microseconds(beat: &RationalV1, bpm: &RationalV1) -> Result<i64, ContractError> {
    ensure_rational_in_domain(beat, "beat")?;
    ensure_rational_in_domain(bpm, "bpm")?;
    if !is_canonical(beat.numerator, beat.denominator) {
        return Err(err("INVALID_RATIONAL", "beat is not a reduced RationalV1"));
    }
    if !is_canonical(bpm.numerator, bpm.denominator) {
        return Err(err("INVALID_RATIONAL", "bpm is not a reduced RationalV1"));
    }
    if beat.numerator < 0 {
        return Err(err("NEGATIVE_TIME", "beat must be non-negative"));
    }
    if bpm.numerator <= 0 {
        return Err(err("INVALID_BPM", "bpm must be positive"));
    }
    // Three-factor numerator — exactly why BigInt (v2's i128 proof failed here).
    let numerator = BigInt::from(beat.numerator) * 60_000_000i64 * BigInt::from(bpm.denominator);
    let denominator = BigInt::from(beat.denominator) * BigInt::from(bpm.numerator);
    let rounded = half_up_div(&numerator, &denominator);
    to_safe_integer(&rounded)
}

/// Count-in beats: `CountInUs × bpm.num / (60_000_000 × bpm.den)` as an
/// exact reduced rational (payload `tempo.countInBeats`). Reduced parts
/// beyond the safe-integer domain → `RATIONAL_OUT_OF_RANGE` (aligned with
/// the TS constructor; C-7).
pub fn count_in_beats(count_in_us: i64, bpm: &RationalV1) -> Result<RationalV1, ContractError> {
    ensure_count_in_us_in_domain(count_in_us)?;
    ensure_rational_in_domain(bpm, "bpm")?;
    if !is_canonical(bpm.numerator, bpm.denominator) {
        return Err(err("INVALID_RATIONAL", "bpm is not a reduced RationalV1"));
    }
    if bpm.numerator <= 0 {
        return Err(err("INVALID_BPM", "bpm must be positive"));
    }
    let numerator = BigInt::from(count_in_us) * BigInt::from(bpm.numerator);
    let denominator = 60_000_000i64 * BigInt::from(bpm.denominator);
    let g = big_gcd(numerator.clone(), denominator.clone());
    let reduced_n = &numerator / &g;
    let reduced_d = &denominator / &g;
    let n = i64::try_from(&reduced_n)
        .map_err(|_| err("RATIONAL_OUT_OF_RANGE", "countInBeats numerator out of range"))?;
    let d = i64::try_from(&reduced_d)
        .map_err(|_| err("RATIONAL_OUT_OF_RANGE", "countInBeats denominator out of range"))?;
    if n.abs() > MAX_SAFE_INTEGER || d.abs() > MAX_SAFE_INTEGER {
        return Err(err("RATIONAL_OUT_OF_RANGE", "countInBeats exceeds the safe-integer domain"));
    }
    Ok(RationalV1 { numerator: n, denominator: d })
}

/// TargetOnsetUs = CountInUs + PlanOffsetUs with the §3.5 final-addition
/// bound: both addends may individually be legal while their sum exceeds the
/// safe-integer domain — the addition is exact and the SUM is checked.
pub fn target_onset_us(
    count_in_us: i64,
    beat: &RationalV1,
    bpm: &RationalV1,
) -> Result<i64, ContractError> {
    // §3.5 + input-domain alignment: reject a negative count-in at THIS
    // entry (a negative addend could cancel a positive offset and slip a
    // distorted result through), then add exactly and bound-check the sum.
    ensure_count_in_us_in_domain(count_in_us)?;
    let offset = beat_to_microseconds(beat, bpm)?;
    let total = BigInt::from(count_in_us) + BigInt::from(offset);
    match i64::try_from(&total) {
        Ok(v) if (0..=MAX_SAFE_INTEGER).contains(&v) => Ok(v),
        _ => Err(err(
            "TIME_OUT_OF_RANGE",
            format!("target onset exceeds the safe-integer domain: {total}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rat(n: i64, d: i64) -> RationalV1 {
        RationalV1 { numerator: n, denominator: d }
    }

    #[test]
    fn integer_bpm_anchors() {
        let bpm = rat(80, 1);
        assert_eq!(beat_to_microseconds(&rat(0, 1), &bpm).unwrap(), 0);
        assert_eq!(beat_to_microseconds(&rat(1, 1), &bpm).unwrap(), 750_000);
        let bpm90 = rat(90, 1);
        assert_eq!(beat_to_microseconds(&rat(1, 1), &bpm90).unwrap(), 666_667);
        let bpm60 = rat(60, 1);
        assert_eq!(beat_to_microseconds(&rat(1, 3), &bpm60).unwrap(), 333_333);
        assert_eq!(beat_to_microseconds(&rat(2, 3), &bpm60).unwrap(), 666_667);
    }

    #[test]
    fn rational_bpm_anchor_from_review() {
        // 175/2 BPM: one beat = 685,714 µs (the v2 formula produced 342,857).
        let bpm = rat(175, 2);
        assert_eq!(beat_to_microseconds(&rat(1, 1), &bpm).unwrap(), 685_714);
        assert_eq!(beat_to_microseconds(&rat(2, 1), &bpm).unwrap(), 1_371_429);
        assert_eq!(beat_to_microseconds(&rat(3, 1), &bpm).unwrap(), 2_057_143);
        assert_eq!(beat_to_microseconds(&rat(4, 1), &bpm).unwrap(), 2_742_857);
    }

    #[test]
    fn half_up_rounds_exact_half_up() {
        // Exact .5 anchor (fourth review P2): beat 1/1_000_000 at 120 BPM →
        // 60e6 × 1 × 1 / (1e6 × 120) = 0.5 µs → half-up = 1 µs.
        let bpm = rat(120, 1);
        assert_eq!(beat_to_microseconds(&rat(1, 1_000_000), &bpm).unwrap(), 1);
    }

    #[test]
    fn half_up_rounds_below_half_down_and_above_half_up() {
        // 60e6 / 119_999_999 = 0.50000004… → rounds UP to 1.
        let bpm = rat(119_999_999, 1);
        assert_eq!(beat_to_microseconds(&rat(1, 1), &bpm).unwrap(), 1);
        // 60e6 / 120_000_001 = 0.49999999… → rounds DOWN to 0.
        let bpm = rat(120_000_001, 1);
        assert_eq!(beat_to_microseconds(&rat(1, 1), &bpm).unwrap(), 0);
    }

    #[test]
    fn negative_count_in_is_rejected_at_the_entry() {
        // §3.5 discipline: target_onset_us itself rejects a negative count-in
        // before the addition — a negative addend must never cancel a
        // positive offset into a "successful" distorted result.
        let bpm = rat(120, 1);
        let error = target_onset_us(-3_000_000, &rat(1, 1), &bpm).unwrap_err();
        assert_eq!(error.code, "INVALID_TIME");
        // Safe-integer domain: beyond ±(2^53-1) µs count-in is out of domain.
        let error = target_onset_us(9_007_199_254_740_992, &rat(1, 1), &bpm).unwrap_err();
        assert_eq!(error.code, "TIME_OUT_OF_RANGE");
    }

    #[test]
    fn error_codes_align_with_ts() {
        let bpm = rat(120, 1);
        assert_eq!(beat_to_microseconds(&rat(2, 4), &bpm).unwrap_err().code, "INVALID_RATIONAL"); // unreduced
        assert_eq!(beat_to_microseconds(&rat(-1, 1), &bpm).unwrap_err().code, "NEGATIVE_TIME");
        assert_eq!(beat_to_microseconds(&rat(1, 1), &rat(0, 1)).unwrap_err().code, "INVALID_BPM");
        assert_eq!(beat_to_microseconds(&rat(1, 1), &rat(4, 2)).unwrap_err().code, "INVALID_RATIONAL");
    }

    #[test]
    fn three_factor_extremes_survive_bigint() {
        // beat.num ≈ 2^53-1, bpm.den ≈ 2^53-1 — the exact case that broke the
        // v2 i128 bound (≈2^132 intermediate). The exact quotient exceeds the
        // safe-integer domain and must be REJECTED, never wrapped.
        let max = 9_007_199_254_740_991i64;
        let beat = rat(max, 1);
        let bpm = rat(1, max);
        let error = beat_to_microseconds(&beat, &bpm).unwrap_err();
        assert_eq!(error.code, "TIME_OUT_OF_RANGE");
    }

    #[test]
    fn count_in_beats_is_exact_rational() {
        // 3_000_000 × 175 / (60e6 × 2) = 525e6/120e6 → 35/8.
        assert_eq!(count_in_beats(3_000_000, &rat(175, 2)).unwrap(), rat(35, 8));
        assert_eq!(count_in_beats(3_000_000, &rat(80, 1)).unwrap(), rat(4, 1));
        // 2_666_667 × 90 / 60e6 = 240_000_030/60_000_000 → 8_000_001/2_000_000.
        assert_eq!(
            count_in_beats(2_666_667, &rat(90, 1)).unwrap(),
            rat(8_000_001, 2_000_000)
        );
    }

    #[test]
    fn final_addition_overflow_is_rejected() {
        // §3.5: both addends individually legal, the sum beyond 2^53-1.
        let max = 9_007_199_254_740_991i64;
        let count_in = max; // legal count-in input (non-negative integer µs)
        let bpm = rat(1, max); // one beat ≈ 2^53 µs — legal inputs, huge offset
        let error = target_onset_us(count_in, &rat(1, 1), &bpm).unwrap_err();
        assert_eq!(error.code, "TIME_OUT_OF_RANGE");
        // Exact in-domain case stays exact.
        let bpm_small = rat(120, 1);
        assert_eq!(target_onset_us(3_000_000, &rat(1, 1), &bpm_small).unwrap(), 3_500_000);
    }
}
