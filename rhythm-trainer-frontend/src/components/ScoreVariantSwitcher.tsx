import { AppButton } from './ui/controls';
import { scorerCn, type ScoreViewKey } from '../features/practice/scoreVariants';

interface Props {
  /** Which alignment the take's OFFICIAL score used ('dp' | 'candidate' | 'legacy'). */
  officialScorer: string | null;
  /** Same-input stored variants; a key missing or null hides that option. */
  variants: Record<string, unknown> | null;
  value: ScoreViewKey;
  onChange: (value: ScoreViewKey) => void;
}

/**
 * Switches the take record view between the official score and the stored
 * same-input variants (2026-11-05 user request). Pure display: switching
 * never re-scores — every option was computed at finalize time and stored.
 */
export default function ScoreVariantSwitcher({ officialScorer, variants, value, onChange }: Props) {
  const hasCandidate = !!variants && 'candidate' in variants && variants.candidate != null;
  const hasLegacy = !!variants && 'legacy' in variants && variants.legacy != null;
  if (value === 'official' && !hasCandidate && !hasLegacy) return null;
  const option = (key: ScoreViewKey, label: string, available: boolean) => (
    <AppButton
      key={key}
      type="button"
      className="text-button"
      aria-pressed={value === key}
      disabled={!available}
      onClick={() => onChange(key)}
    >
      {value === key ? `【当前】${label}` : label}
    </AppButton>
  );
  return (
    <div className="score-variant-switch" role="group" aria-label="评分算法视图">
      <span className="history-take-link">评分算法：</span>
      {option('official', `当时默认（${scorerCn(officialScorer)}）`, true)}
      {hasCandidate && option('candidate', '规则候选', true)}
      {hasLegacy && option('legacy', '冻结 v1', true)}
    </div>
  );
}
