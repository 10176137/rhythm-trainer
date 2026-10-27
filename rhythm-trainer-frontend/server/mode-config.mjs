'use strict';

// Mode → scoring configuration resolution. This is the single authority for
// what a practice mode means at session creation. It does not invent a second
// scoring engine: judgment windows still come from the existing JudgmentProfile
// (strict/standard/relaxed), duration grading from the existing duration
// policy, and diagnosis from DiagnosisThresholds. The mode decides which of
// those knobs apply and which are explicitly N/A.

export const MODE_CONFIG_VERSION = 'mode-config-1.0.0';

export const MODE_IDS = ['rhythm', 'score', 'hands', 'loop', 'free', 'fixed-line', 'exercise'];

/**
 * Per-mode policy:
 * - judgmentProfile:    mode default; the user's explicit profile overrides it.
 * - durationPolicy:     mode default for key-down grading.
 * - scoringStartPolicy: where scoreable input begins relative to the schedule.
 * - pitchHint:          whether wrong-pitch feedback is shown (never affects rhythm grades).
 * - diagnosis:          which coaching dimensions this mode reports.
 * - notApplicable:      knobs that are meaningless here; using them is an error, not silence.
 * - userOverrides:      which knobs the user MAY override for this mode.
 */
const MODE_POLICIES = {
  rhythm: {
    label: '节奏训练',
    judgmentProfile: 'standard',
    durationPolicy: 'strict-keydown',
    scoringStartPolicy: 'first-target-early-window',
    pitchHint: false,
    diagnosis: { onset: true, stability: true, duration: false, pitch: false, misses: true },
    notApplicable: ['pitchHint'],
    userOverrides: ['profile', 'durationPolicy', 'feedback'],
  },
  score: {
    label: '正常曲目演奏',
    judgmentProfile: 'standard',
    durationPolicy: 'strict-keydown',
    scoringStartPolicy: 'first-target-early-window',
    pitchHint: true,
    diagnosis: { onset: true, stability: true, duration: true, pitch: true, misses: true },
    notApplicable: [],
    userOverrides: ['profile', 'durationPolicy', 'feedback'],
  },
  'fixed-line': {
    label: '固定判定线节奏练习',
    judgmentProfile: 'standard',
    durationPolicy: 'strict-keydown',
    scoringStartPolicy: 'first-target-early-window',
    pitchHint: true,
    diagnosis: { onset: true, stability: true, duration: true, pitch: true, misses: true },
    notApplicable: [],
    userOverrides: ['profile', 'durationPolicy', 'feedback'],
  },
  exercise: {
    label: '节奏型与技巧训练',
    judgmentProfile: 'standard',
    durationPolicy: 'strict-keydown',
    scoringStartPolicy: 'first-target-early-window',
    pitchHint: true,
    diagnosis: { onset: true, stability: true, duration: true, pitch: true, misses: true },
    notApplicable: [],
    userOverrides: ['profile', 'durationPolicy', 'feedback'],
  },
  hands: {
    label: '分手练习',
    judgmentProfile: 'relaxed',
    durationPolicy: 'strict-keydown',
    scoringStartPolicy: 'first-target-early-window',
    pitchHint: true,
    diagnosis: { onset: true, stability: true, duration: true, pitch: true, misses: true },
    notApplicable: [],
    // Hand selection is a target-filtering knob consumed by the client plan,
    // not a scoring knob; it is validated on the start payload instead.
    userOverrides: ['profile', 'durationPolicy', 'feedback', 'hand'],
  },
  loop: {
    label: '乐句循环',
    judgmentProfile: 'strict',
    durationPolicy: 'strict-keydown',
    scoringStartPolicy: 'first-target-early-window',
    pitchHint: true,
    diagnosis: { onset: true, stability: true, duration: true, pitch: true, misses: true },
    notApplicable: [],
    userOverrides: ['profile', 'durationPolicy', 'feedback'],
  },
  free: {
    label: '自由弹奏',
    judgmentProfile: 'standard',
    durationPolicy: 'disabled',
    scoringStartPolicy: 'none',
    pitchHint: false,
    diagnosis: { onset: false, stability: false, duration: false, pitch: false, misses: false },
    // Free play records events and never scores; profile/duration/feedback
    // semantics do not exist here, so overriding them is rejected loudly.
    notApplicable: ['profile', 'durationPolicy', 'feedback', 'pitchHint'],
    userOverrides: [],
  },
};

function requireMode(modeId) {
  if (!MODE_IDS.includes(modeId)) {
    const error = new Error(`未知练习模式 ${modeId}`);
    error.code = 'INVALID_MODE';
    throw error;
  }
  return MODE_POLICIES[modeId];
}

/**
 * Resolves the effective scoring configuration for one Take.
 *
 * @param {object} params
 * @param {string} params.modeId           one of MODE_IDS
 * @param {object} [params.userOverrides]  { profile?, durationPolicy?, feedback?, hand? }
 * @returns effective config snapshot (plain JSON, versioned)
 */
export function resolveModeScoringConfig({ modeId, userOverrides = {} }) {
  const policy = requireMode(modeId);
  const overrides = userOverrides ?? {};

  // Reject overrides that this mode declares not applicable — silence would
  // make users believe a knob had effect.
  for (const key of Object.keys(overrides)) {
    if (policy.notApplicable.includes(key)) {
      const error = new Error(`${policy.label}模式不适用设置项「${key}」，已拒绝（该模式语义固定）`);
      error.code = 'CONFIG_NOT_APPLICABLE';
      throw error;
    }
    if (!policy.userOverrides.includes(key) && !['tempo', 'countInBeats'].includes(key)) {
      const error = new Error(`练习模式 ${modeId} 不支持覆盖「${key}」`);
      error.code = 'CONFIG_OVERRIDE_UNSUPPORTED';
      throw error;
    }
  }

  const allowedProfiles = ['strict', 'standard', 'relaxed'];
  const requestedProfile = overrides.profile ?? policy.judgmentProfile;
  if (!allowedProfiles.includes(requestedProfile)) {
    const error = new Error(`判定档位非法: ${requestedProfile}（允许 strict/standard/relaxed）`);
    error.code = 'INVALID_PROFILE';
    throw error;
  }

  const allowedDuration = ['strict-keydown', 'disabled'];
  const requestedDuration = overrides.durationPolicy ?? policy.durationPolicy;
  if (!allowedDuration.includes(requestedDuration)) {
    const error = new Error(`时值评估策略非法: ${requestedDuration}（允许 strict-keydown/disabled）`);
    error.code = 'INVALID_DURATION_POLICY';
    throw error;
  }

  const feedback = overrides.feedback ?? 'live';
  if (!['live', 'after'].includes(feedback)) {
    const error = new Error(`反馈方式非法: ${feedback}（允许 live/after）`);
    error.code = 'INVALID_FEEDBACK';
    throw error;
  }

  return {
    configVersion: MODE_CONFIG_VERSION,
    modeId,
    modeLabel: policy.label,
    // The profile is BOTH a snapshot field and the value handed to
    // buildSchedule → JudgmentProfile windows. No second copy exists.
    judgmentProfile: requestedProfile,
    judgmentProfileSource: overrides.profile ? 'user' : 'mode-default',
    durationPolicy: requestedDuration,
    durationPolicySource: overrides.durationPolicy ? 'user' : 'mode-default',
    feedback,
    pitchHint: policy.pitchHint,
    scoringStartPolicy: policy.scoringStartPolicy,
    diagnosis: { ...policy.diagnosis },
    notApplicable: [...policy.notApplicable],
  };
}
