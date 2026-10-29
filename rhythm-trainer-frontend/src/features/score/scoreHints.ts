import type { JudgmentProfile } from '../../types/practice';

/** Persisted user overrides; `undefined` means "follow the mode/profile default". */
export interface ScoreHintOverrides {
  noteNames?: boolean;
  positionHints?: boolean;
}

export interface ScoreHintState {
  noteNames: boolean;
  positionHints: boolean;
  noteNamesSource: 'default' | 'user';
  positionHintsSource: 'default' | 'user';
}

export const SCORE_HINTS_STORAGE_KEY = 'rhythm-trainer.score-hints.v3';

/**
 * The default presentation is the clean score: black/gray notes with a blue
 * current-beat pill and no answer labels. Hints are opt-in from settings; the
 * profile parameter remains so strict mode can keep them off if defaults change.
 */
export function defaultScoreHints(_profile: JudgmentProfile): Pick<ScoreHintState, 'noteNames' | 'positionHints'> {
  return { noteNames: false, positionHints: false };
}

export function resolveScoreHints(overrides: ScoreHintOverrides, profile: JudgmentProfile): ScoreHintState {
  const defaults = defaultScoreHints(profile);
  return {
    noteNames: overrides.noteNames ?? defaults.noteNames,
    positionHints: overrides.positionHints ?? defaults.positionHints,
    noteNamesSource: overrides.noteNames === undefined ? 'default' : 'user',
    positionHintsSource: overrides.positionHints === undefined ? 'default' : 'user',
  };
}

/** Validates untrusted localStorage content without throwing. */
export function parseScoreHintOverrides(raw: string | null): ScoreHintOverrides {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return {};
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.noteNames === 'boolean' ? { noteNames: record.noteNames } : {}),
      ...(typeof record.positionHints === 'boolean' ? { positionHints: record.positionHints } : {}),
    };
  } catch {
    return {};
  }
}

export function loadScoreHintOverrides(): ScoreHintOverrides {
  if (typeof window === 'undefined') return {};
  try {
    return parseScoreHintOverrides(window.localStorage.getItem(SCORE_HINTS_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function saveScoreHintOverrides(overrides: ScoreHintOverrides): void {
  if (typeof window === 'undefined') return;
  try {
    const hasOverride = overrides.noteNames !== undefined || overrides.positionHints !== undefined;
    if (!hasOverride) window.localStorage.removeItem(SCORE_HINTS_STORAGE_KEY);
    else window.localStorage.setItem(SCORE_HINTS_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Display settings are best-effort; storage failures must not break practice.
  }
}
