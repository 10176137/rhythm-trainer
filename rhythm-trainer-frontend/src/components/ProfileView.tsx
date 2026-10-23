// Ability profile view: per-skill mastery state from the rule-based
// StudentModel (Rust core) plus honest aggregate trends from session history.
// Mastery states are tentative learning decisions, not ability certifications.

import { useEffect, useMemo, useState } from 'react';
import { practiceRepository, MODE_CN, MASTERY_CN, fmtAbs, avgOf } from '../services/practiceRepository';
import type { SessionSummary, SkillSnapshot, ProfileResponse } from '../services/practiceRepository';

const STATE_CLASS: Record<string, string> = {
  not_assessed: 'state-none',
  developing: 'state-dev',
  provisional: 'state-prov',
  consolidated: 'state-cons',
  needs_review: 'state-review',
};

export default function ProfileView({ refreshKey }: { refreshKey: number }) {
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    practiceRepository.getProfile().then(setProfile).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    practiceRepository.listSessions(50).then((res) => setSessions(res.items)).catch(() => setSessions([]));
  }, [refreshKey]);

  const recent = useMemo(() => (sessions ?? []).slice(0, 10), [sessions]);
  const avgMae = useMemo(() => avgOf(recent.map((s) => s.meanAbsoluteMs)), [recent]);
  const avgHit = useMemo(() => avgOf(recent.map((s) => (s.targetCount > 0 ? s.targetHitRate : null))), [recent]);
  const trend = useMemo(() => {
    const values = [...(sessions ?? [])]
      .sort((a, b) => (a.finishedAtIso < b.finishedAtIso ? -1 : 1))
      .slice(-10)
      .map((s) => s.meanAbsoluteMs);
    return values;
  }, [sessions]);

  if (error) {
    return <section className="card history-card"><p className="report-warning">载入失败:{error}(引擎服务需要在执行中)</p></section>;
  }
  if (!profile || sessions === null) {
    return <section className="card history-card"><p className="history-empty">载入中…</p></section>;
  }

  const maxMae = Math.max(...trend.map((v) => v ?? 0), 1);

  return (
    <section className="card history-card">
      <div className="card-heading">
        <div>
          <div className="eyebrow">ABILITY PROFILE</div>
          <h3>能力画像</h3>
        </div>
        <span className="profile-totals">{profile.totals.sessions} 次练习 · {profile.totals.trustworthySessions} 次可信</span>
      </div>

      <div className="profile-skills">
        {profile.skills.length === 0 && <p className="history-empty">还没有可评估的技能——完成一次练习后,这里会按练习模式累积掌握状态。</p>}
        {profile.skills.map((skill: SkillSnapshot) => (
          <div className="skill-row" key={skill.skillId}>
            <div className="skill-name"><strong>{MODE_CN[skill.skillId] ?? skill.skillId}</strong><small>{skill.skillId}</small></div>
            <span className={`badge ${STATE_CLASS[skill.state] ?? 'state-none'}`}>{MASTERY_CN[skill.state] ?? skill.state}</span>
            <div className="skill-detail">
              <span>可信尝试 {skill.trustworthyAttempts}</span>
              <span>连续达标 {skill.consecutivePasses}</span>
              <span>上次 {skill.lastAttemptPassed === null ? '—' : skill.lastAttemptPassed ? '达标' : '未达标'}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="profile-trend">
        <h4>近期稳定度趋势(平均绝对偏差,越低越好,最近 {trend.length} 次)</h4>
        {trend.length === 0 && <p className="history-empty">暂无数据。</p>}
        <div className="trend-bars">
          {trend.map((value, i) => (
            <div className="trend-bar-col" key={i} title={value == null ? '—' : `${value.toFixed(1)}ms`}>
              <div className="trend-bar" style={{ height: `${value == null ? 0 : Math.max(4, (value / maxMae) * 100)}%` }} />
              <small>{value == null ? '—' : Math.round(value)}</small>
            </div>
          ))}
        </div>
        <p className="report-footnote">
          最近 10 次平均:MAE {fmtAbs(avgMae)} · 命中率 {avgHit == null ? '—' : `${Math.round(avgHit * 100)}%`}。
          掌握状态是暂定的学习决策(依可信尝试与连续达标),唔系能力认证;迁移测试与延迟复测接入后,状态先会升到「已巩固」。
        </p>
      </div>
    </section>
  );
}
