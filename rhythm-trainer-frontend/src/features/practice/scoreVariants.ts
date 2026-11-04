// Alignment scorer display names (2026-11-05 user request: make the active
// algorithm visible and let the take record page switch stored views).

export type ScoreViewKey = 'official' | 'candidate' | 'legacy';

/** Chinese display name for a finalAlignmentScorer id. */
export function scorerCn(scorer: string | null | undefined): string {
  if (scorer === 'dp') return 'DP 对齐';
  if (scorer === 'candidate') return '规则候选';
  if (scorer === 'legacy') return '冻结 v1';
  return scorer ?? '未知';
}

/** Chinese display name derived from a report's algorithmVersion string. */
export function algorithmCn(version: string | null | undefined): string {
  if (!version) return '';
  if (version.includes('alignment-dp')) return 'DP 对齐 v2';
  if (version.includes('alignment-candidate')) return '规则候选';
  return '冻结 v1';
}
