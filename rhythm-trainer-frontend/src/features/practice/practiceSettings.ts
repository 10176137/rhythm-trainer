import type { DurationEvaluationPolicy, FeedbackMode, HandSelection, JudgmentProfile, PracticeConfig, ScoreAdvanceMode } from '../../types/practice';

/**
 * Practice preferences persisted on this device. `modeId` is deliberately not
 * restored: the workbench starts in score mode each time, while the settings
 * panel only edits practice parameters.
 */
export interface PersistedPracticeSettings {
  config: PracticeConfig;
  metronomeOn: boolean;
}

export interface PracticeSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PRACTICE_SETTINGS_STORAGE_KEY = 'rhythm-trainer.practice-settings.v1';
const STORAGE_VERSION = 1;

export const defaultPracticeSettings: PersistedPracticeSettings = {
  config: {
    modeId: 'score',
    tempo: 72,
    timeSignature: [4, 4],
    hand: 'both',
    feedback: 'live',
    loopEnabled: false,
    loopStartBar: 1,
    loopEndBar: 4,
    profile: 'standard',
    durationPolicy: 'strict-keydown',
    advanceMode: 'follow',
  },
  metronomeOn: true,
};

const HANDS: readonly HandSelection[] = ['both', 'right', 'left'];
const FEEDBACK_MODES: readonly FeedbackMode[] = ['live', 'after'];
const JUDGMENT_PROFILES: readonly JudgmentProfile[] = ['strict', 'standard', 'relaxed'];
const DURATION_POLICIES: readonly DurationEvaluationPolicy[] = ['strict-keydown', 'disabled'];
const ADVANCE_MODES: readonly ScoreAdvanceMode[] = ['timeline', 'follow'];

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.round(pickNumber(value, fallback));
  return Math.min(max, Math.max(min, parsed));
}

function parseTimeSignature(value: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return fallback;
  const beats = Math.round(pickNumber(value[0], fallback[0]));
  const unit = Math.round(pickNumber(value[1], fallback[1]));
  if (beats < 1 || beats > 16 || unit < 1 || unit > 16) return fallback;
  return [beats, unit];
}

/** Validates untrusted localStorage content without throwing. */
export function parsePracticeSettings(raw: string | null): PersistedPracticeSettings {
  const fallback = defaultPracticeSettings;
  if (!raw) return { config: { ...fallback.config }, metronomeOn: fallback.metronomeOn };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { config: { ...fallback.config }, metronomeOn: fallback.metronomeOn };
    const record = parsed as Record<string, unknown>;
    if (record.version !== STORAGE_VERSION) return { config: { ...fallback.config }, metronomeOn: fallback.metronomeOn };
    const saved = record.config && typeof record.config === 'object'
      ? record.config as Record<string, unknown>
      : {};
    const loopStartBar = clampInteger(saved.loopStartBar, 1, 999, fallback.config.loopStartBar);
    const loopEndBar = Math.max(loopStartBar, clampInteger(saved.loopEndBar, 1, 999, fallback.config.loopEndBar));
    return {
      config: {
        ...fallback.config,
        timeSignature: parseTimeSignature(saved.timeSignature, fallback.config.timeSignature),
        tempo: clampInteger(saved.tempo, 40, 160, fallback.config.tempo),
        hand: pickEnum(saved.hand, HANDS, fallback.config.hand),
        feedback: pickEnum(saved.feedback, FEEDBACK_MODES, fallback.config.feedback),
        loopEnabled: typeof saved.loopEnabled === 'boolean' ? saved.loopEnabled : fallback.config.loopEnabled,
        profile: pickEnum(saved.profile, JUDGMENT_PROFILES, fallback.config.profile),
        durationPolicy: pickEnum(saved.durationPolicy, DURATION_POLICIES, fallback.config.durationPolicy),
        advanceMode: pickEnum(saved.advanceMode, ADVANCE_MODES, fallback.config.advanceMode),
        loopStartBar,
        loopEndBar,
      },
      metronomeOn: typeof record.metronomeOn === 'boolean' ? record.metronomeOn : fallback.metronomeOn,
    };
  } catch {
    return { config: { ...fallback.config }, metronomeOn: fallback.metronomeOn };
  }
}

export function serializePracticeSettings(settings: PersistedPracticeSettings): string {
  const { modeId: _modeId, ...preferences } = settings.config;
  return JSON.stringify({
    version: STORAGE_VERSION,
    config: preferences,
    metronomeOn: settings.metronomeOn,
  });
}

function browserStorage(): PracticeSettingsStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadPracticeSettings(storage: PracticeSettingsStorage | null = browserStorage()): PersistedPracticeSettings {
  if (!storage) return parsePracticeSettings(null);
  try {
    return parsePracticeSettings(storage.getItem(PRACTICE_SETTINGS_STORAGE_KEY));
  } catch {
    return parsePracticeSettings(null);
  }
}

export function savePracticeSettings(
  settings: PersistedPracticeSettings,
  storage: PracticeSettingsStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PRACTICE_SETTINGS_STORAGE_KEY, serializePracticeSettings(settings));
  } catch {
    // Preferences are best-effort; a full/blocked storage must not break practice.
  }
}
