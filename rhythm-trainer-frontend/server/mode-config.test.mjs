import { describe, expect, it } from 'vitest';
import { MODE_CONFIG_VERSION, MODE_IDS, resolveModeScoringConfig } from './mode-config.mjs';

describe('mode → ScoringConfig mapping', () => {
  it('maps every real mode ID; none falls through to one shared default', () => {
    const configs = Object.fromEntries(MODE_IDS.map((id) => [id, resolveModeScoringConfig({ modeId: id })]));
    expect(Object.keys(configs).sort()).toEqual(['exercise', 'fixed-line', 'free', 'hands', 'loop', 'rhythm', 'score']);
    expect(configs.rhythm.judgmentProfile).toBe('standard');
    expect(configs.score.judgmentProfile).toBe('standard');
    expect(configs['fixed-line'].judgmentProfile).toBe('standard');
    expect(configs.exercise.judgmentProfile).toBe('standard');
    expect(configs.hands.judgmentProfile).toBe('relaxed');
    expect(configs.loop.judgmentProfile).toBe('strict');
    expect(configs.free.durationPolicy).toBe('disabled');
    expect(configs.free.scoringStartPolicy).toBe('none');
    // rhythm and free declare pitch hints off; A/B/C/hands/loop declare them on
    expect(configs.rhythm.pitchHint).toBe(false);
    expect(configs.free.pitchHint).toBe(false);
    expect(configs.score.pitchHint).toBe(true);
    expect(configs.hands.pitchHint).toBe(true);
    expect(configs.loop.pitchHint).toBe(true);
    expect(configs['fixed-line'].pitchHint).toBe(true);
    expect(configs.exercise.pitchHint).toBe(true);
    expect(configs['fixed-line'].modeLabel).toBe('固定判定线节奏练习');
    expect(configs.exercise.modeLabel).toBe('节奏型与技巧训练');
    // every config is versioned and traceable
    for (const config of Object.values(configs)) {
      expect(config.configVersion).toBe(MODE_CONFIG_VERSION);
      expect(config.notApplicable).toBeInstanceOf(Array);
      expect(config.diagnosis).toBeTypeOf('object');
    }
  });

  it('end-to-end fields feed real consumers: profile → JudgmentProfile, duration → grading', () => {
    const config = resolveModeScoringConfig({ modeId: 'loop' });
    // loop defaults to strict; buildSchedule consumes exactly this string.
    expect(['strict', 'standard', 'relaxed']).toContain(config.judgmentProfile);
    expect(['strict-keydown', 'disabled']).toContain(config.durationPolicy);
    // scoringStartPolicy 'first-target-early-window' is the schedule-window rule
    expect(config.scoringStartPolicy).toBe('first-target-early-window');
  });

  it('behavior: the same override produces different effective configs per mode', () => {
    // Free mode forbids profile/duration/feedback overrides entirely.
    expect(() => resolveModeScoringConfig({ modeId: 'free', userOverrides: { profile: 'strict' } }))
      .toThrowError(/不适用/);
    expect(() => resolveModeScoringConfig({ modeId: 'free', userOverrides: { durationPolicy: 'strict-keydown' } }))
      .toThrowError(/不适用/);
    // loop defaults strict; the user can relax it explicitly.
    const relaxed = resolveModeScoringConfig({ modeId: 'loop', userOverrides: { profile: 'relaxed' } });
    expect(relaxed.judgmentProfile).toBe('relaxed');
    expect(relaxed.judgmentProfileSource).toBe('user');
    // mode default source is recorded so reports can tell who chose it
    const def = resolveModeScoringConfig({ modeId: 'loop' });
    expect(def.judgmentProfileSource).toBe('mode-default');
  });

  it('rejects invalid values with stable messages', () => {
    expect(() => resolveModeScoringConfig({ modeId: 'nope' })).toThrowError(/未知练习模式/);
    expect(() => resolveModeScoringConfig({ modeId: 'score', userOverrides: { profile: 'impossible' } }))
      .toThrowError(/判定档位非法/);
    expect(() => resolveModeScoringConfig({ modeId: 'score', userOverrides: { durationPolicy: 'sometimes' } }))
      .toThrowError(/时值评估策略非法/);
    expect(() => resolveModeScoringConfig({ modeId: 'score', userOverrides: { feedback: 'maybe' } }))
      .toThrowError(/反馈方式非法/);
  });

  it('is a pure snapshot: resolving again is unaffected by later calls', () => {
    const first = resolveModeScoringConfig({ modeId: 'hands' });
    resolveModeScoringConfig({ modeId: 'loop', userOverrides: { profile: 'relaxed' } });
    const again = resolveModeScoringConfig({ modeId: 'hands' });
    expect(again).toEqual(first);
  });
});
