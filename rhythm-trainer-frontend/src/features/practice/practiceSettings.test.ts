import { describe, expect, it } from 'vitest';
import {
  defaultPracticeSettings,
  loadPracticeSettings,
  parsePracticeSettings,
  savePracticeSettings,
  serializePracticeSettings,
  type PracticeSettingsStorage,
} from './practiceSettings';

function memoryStorage(initial: string | null = null): PracticeSettingsStorage & { value: string | null } {
  return {
    value: initial,
    getItem() {
      return this.value;
    },
    setItem(_key: string, value: string) {
      this.value = value;
    },
  };
}

describe('practiceSettings', () => {
  it('falls back to defaults for missing or malformed storage', () => {
    expect(parsePracticeSettings(null).config).toEqual(defaultPracticeSettings.config);
    expect(parsePracticeSettings('{not json').config).toEqual(defaultPracticeSettings.config);
    expect(parsePracticeSettings('"text"').config).toEqual(defaultPracticeSettings.config);
    expect(parsePracticeSettings(JSON.stringify({ version: 99, config: { tempo: 120 } })).config)
      .toEqual(defaultPracticeSettings.config);
  });

  it('validates untrusted values instead of trusting localStorage', () => {
    const parsed = parsePracticeSettings(JSON.stringify({
      version: 1,
      metronomeOn: 'yes',
      config: {
        modeId: 'free',
        tempo: 999,
        timeSignature: [3, 8],
        hand: 'three',
        feedback: 'after',
        profile: 'strict',
        durationPolicy: 'disabled',
        advanceMode: 'timeline',
        loopStartBar: 9,
        loopEndBar: 3,
      },
    }));
    expect(parsed.config.modeId).toBe('score');
    expect(parsed.config.tempo).toBe(160);
    expect(parsed.config.timeSignature).toEqual([3, 8]);
    expect(parsed.config.hand).toBe('both');
    expect(parsed.config.loopEnabled).toBe(false);
    expect(parsed.config.feedback).toBe('after');
    expect(parsed.config.profile).toBe('strict');
    expect(parsed.config.durationPolicy).toBe('disabled');
    expect(parsed.config.advanceMode).toBe('timeline');
    expect(parsed.config.loopStartBar).toBe(9);
    expect(parsed.config.loopEndBar).toBe(9);
    expect(parsed.metronomeOn).toBe(true);
  });

  it('round-trips preferences through storage without persisting the mode', () => {
    const storage = memoryStorage();
    const settings = {
      config: {
        ...defaultPracticeSettings.config,
        modeId: 'loop' as const,
        tempo: 96,
        hand: 'right' as const,
        loopEnabled: true,
        profile: 'strict' as const,
        advanceMode: 'timeline' as const,
      },
      metronomeOn: false,
    };
    savePracticeSettings(settings, storage);
    expect(storage.value).toContain('"version":1');
    expect(storage.value).not.toContain('"modeId"');

    const loaded = loadPracticeSettings(storage);
    expect(loaded.config.modeId).toBe('score');
    expect(loaded.config.tempo).toBe(96);
    expect(loaded.config.hand).toBe('right');
    expect(loaded.config.loopEnabled).toBe(true);
    expect(loaded.config.profile).toBe('strict');
    expect(loaded.config.advanceMode).toBe('timeline');
    expect(loaded.metronomeOn).toBe(false);
  });

  it('persists an explicitly confirmed staff->hand mapping across reloads', () => {
    const storage = memoryStorage();
    savePracticeSettings({
      config: { ...defaultPracticeSettings.config },
      metronomeOn: true,
      handMappings: {
        'fp-1': [
          { staffNumber: 1, hand: 'right' },
          { staffNumber: 2, hand: 'left' },
        ],
      },
    }, storage);
    const loaded = loadPracticeSettings(storage);
    expect(loaded.handMappings).toEqual({
      'fp-1': [
        { staffNumber: 1, hand: 'right' },
        { staffNumber: 2, hand: 'left' },
      ],
    });
  });

  it('serializes only versioned preferences and tolerates blocked storage', () => {
    const serialized = serializePracticeSettings(defaultPracticeSettings);
    expect(JSON.parse(serialized)).toMatchObject({ version: 1, metronomeOn: true });
    expect(JSON.parse(serialized).config).not.toHaveProperty('modeId');

    const blocked: PracticeSettingsStorage = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
    };
    expect(() => savePracticeSettings(defaultPracticeSettings, blocked)).not.toThrow();
    expect(loadPracticeSettings(blocked).config).toEqual(defaultPracticeSettings.config);
  });
});
