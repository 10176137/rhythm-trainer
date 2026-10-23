use crate::{Grade, Judgment};

#[derive(Debug, Clone, PartialEq)]
pub struct ScoreStats {
    pub target_count: usize,
    pub perfect_count: usize,
    pub good_count: usize,
    pub miss_count: usize,
    pub extra_count: usize,
    /// Perfect hits / number of targets.
    pub perfect_rate: f64,
    /// (Perfect + Good) / number of targets; misses remain in the denominator.
    pub target_hit_rate: f64,
    pub miss_rate: f64,
    /// Mean signed error for matched targets only. Positive means late.
    pub mean_signed_ms: Option<f64>,
    /// Mean absolute error for matched targets only.
    pub mean_absolute_ms: Option<f64>,
    /// Population standard deviation for matched-target signed errors.
    pub standard_deviation_ms: Option<f64>,
}

pub fn calculate_stats(target_count: usize, judgments: &[Judgment]) -> ScoreStats {
    let perfect_count = judgments.iter().filter(|j| j.grade == Grade::Perfect).count();
    let good_count = judgments.iter().filter(|j| j.grade == Grade::Good).count();
    let miss_count = judgments.iter().filter(|j| j.grade == Grade::Miss).count();
    let extra_count = judgments.iter().filter(|j| j.grade == Grade::Extra).count();
    let errors: Vec<f64> = judgments.iter()
        .filter(|j| matches!(j.grade, Grade::Perfect | Grade::Good))
        .filter_map(|j| j.error_ms)
        .collect();

    let denominator = target_count as f64;
    let perfect_rate = if target_count == 0 { 0.0 } else { perfect_count as f64 / denominator };
    let target_hit_rate = if target_count == 0 { 0.0 } else { (perfect_count + good_count) as f64 / denominator };
    let miss_rate = if target_count == 0 { 0.0 } else { miss_count as f64 / denominator };

    if errors.is_empty() {
        return ScoreStats {
            target_count, perfect_count, good_count, miss_count, extra_count,
            perfect_rate, target_hit_rate, miss_rate,
            mean_signed_ms: None, mean_absolute_ms: None, standard_deviation_ms: None,
        };
    }

    let n = errors.len() as f64;
    let mean = errors.iter().sum::<f64>() / n;
    let mean_absolute = errors.iter().map(|error| error.abs()).sum::<f64>() / n;
    let variance = errors.iter().map(|error| (error - mean).powi(2)).sum::<f64>() / n;
    ScoreStats {
        target_count, perfect_count, good_count, miss_count, extra_count,
        perfect_rate, target_hit_rate, miss_rate,
        mean_signed_ms: Some(mean),
        mean_absolute_ms: Some(mean_absolute),
        standard_deviation_ms: Some(variance.sqrt()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Judgment;

    fn result(grade: Grade, error_ms: Option<f64>) -> Judgment {
        Judgment { grade, target_id: None, target_index: None, strike_seq: None, error_ms,
            expected_at_ms: None, actual_at_ms: None, bar: None, beat: None }
    }

    #[test]
    fn zero_mean_does_not_hide_large_absolute_error() {
        let stats = calculate_stats(2, &[
            result(Grade::Good, Some(-50.0)), result(Grade::Good, Some(50.0)),
        ]);
        assert_eq!(stats.mean_signed_ms, Some(0.0));
        assert_eq!(stats.mean_absolute_ms, Some(50.0));
        assert_eq!(stats.standard_deviation_ms, Some(50.0));
    }

    #[test]
    fn miss_remains_in_hit_rate_denominator() {
        let stats = calculate_stats(2, &[result(Grade::Perfect, Some(0.0)), result(Grade::Miss, None)]);
        assert_eq!(stats.target_hit_rate, 0.5);
        assert_eq!(stats.miss_rate, 0.5);
    }
}
