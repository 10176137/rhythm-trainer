import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import TargetedPracticePanel from './TargetedPracticePanel';
import { TeachingApiError } from '../services/teachingRunRepository';

const baseProps = {
  sourceReportId: 's-source',
  sourceTakeId: 'take-1',
  sourceScoreFingerprint: 'fp',
  activeScoreFingerprint: 'fp',
  practiceBpm: 72,
  practiceHand: 'both' as const,
  scoreBarCount: 8,
  onTeachingRunCreated: () => {},
  onNavigateTeaching: () => {},
};

describe('TargetedPracticePanel (Node-backed)', () => {
  it('renders the teaching entry and computes no local prescriptions', () => {
    const html = renderToStaticMarkup(<TargetedPracticePanel {...baseProps} />);
    expect(html).toContain('从这份 Take 开始教学');
    expect(html).toContain('不再在浏览器里计算薄弱小节或推荐速度');
    // None of the old TS strategy artifacts may appear.
    expect(html).not.toContain('LOCAL_ONSET_V1');
    expect(html).not.toContain('确认创建复练任务');
    expect(html).not.toContain('系统处方');
  });

  it('marks the manual range as a user choice, not a system diagnosis', () => {
    const html = renderToStaticMarkup(<TargetedPracticePanel {...baseProps} />);
    expect(html).toContain('范围只是你的选择，不是系统诊断');
  });

  it('disables creation when the active score fingerprint differs', () => {
    const html = renderToStaticMarkup(
      <TargetedPracticePanel {...baseProps} activeScoreFingerprint="another-fp" />,
    );
    expect(html).toContain('当前打开曲谱与这份报告不一致');
    // The creation form is gated behind the warning; mismatch must never
    // render an actionable create button.
    expect(html).not.toContain('按所选范围创建教学课程');
  });

  it('disables creation when the report has no Take id', () => {
    const html = renderToStaticMarkup(
      <TargetedPracticePanel {...baseProps} sourceTakeId={null} />,
    );
    expect(html).toContain('这份记录还没有 Take 标识');
  });

  it('keeps sourceReportId accepted for display but never derives rules from it', () => {
    const html = renderToStaticMarkup(
      <TargetedPracticePanel {...baseProps} sourceReportId={null} sourceTakeId="take-1" />,
    );
    // Still creatable: only the persisted Take id drives the request.
    expect(html).not.toContain('这份记录还没有 Take 标识');
  });

  it('exposes coded 4xx errors as readable messages (repository mapping)', () => {
    const error = new TeachingApiError('SCORE_FINGERPRINT_MISMATCH', '来源 Take 与当前曲谱不一致，不能开始教学。', 409);
    expect(error.status).toBe(409);
    expect(error.message).toContain('不一致');
  });
});
