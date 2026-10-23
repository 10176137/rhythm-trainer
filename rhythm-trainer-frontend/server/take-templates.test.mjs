import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TakeTemplateError, TakeTemplateStore } from './take-templates.mjs';

const dirs = [];
const store = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-templates-test-'));
  dirs.push(dir);
  return new TakeTemplateStore({ dir });
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const config = (overrides = {}) => ({
  modeId: 'score',
  tempo: 60,
  timeSignature: [4, 4],
  hand: 'right',
  feedback: 'live',
  loopEnabled: true,
  loopStartBar: 1,
  loopEndBar: 1,
  profile: 'standard',
  durationPolicy: 'strict-keydown',
  advanceMode: 'timeline',
  ...overrides,
});

describe('TakeTemplateStore', () => {
  it('creates, lists, updates and deletes a reusable Take', () => {
    const db = store();
    const created = db.create({
      name: '右手第 1 小节',
      config: config(),
      scoreFingerprint: 'fp-1',
      scoreLabel: 'C 大调钢琴练习曲',
    });
    expect(created.id).toMatch(/^take-/);
    expect(created.config.loopEnabled).toBe(true);
    expect(db.list()).toHaveLength(1);

    const updated = db.update(created.id, { name: '右手第 1 小节（慢速）', config: config({ tempo: 40 }) });
    expect(updated.name).toContain('慢速');
    expect(updated.config.tempo).toBe(40);
    expect(updated.createdAtIso).toBe(created.createdAtIso);

    expect(db.remove(created.id)).toBe(true);
    expect(db.list()).toHaveLength(0);
    expect(db.remove(created.id)).toBe(false);
  });

  it('rejects duplicate names and invalid configs', () => {
    const db = store();
    db.create({ name: 'Take A', config: config() });
    expect(() => db.create({ name: 'take a', config: config() })).toThrow(TakeTemplateError);
    expect(() => db.create({ name: 'Take B', config: config({ tempo: 999 }) })).toThrow(TakeTemplateError);
    expect(() => db.create({ name: 'Take C', config: config({ modeId: 'hands' }) })).toThrow(TakeTemplateError);
    expect(() => db.create({ name: 'Take D', config: config({ loopStartBar: 4, loopEndBar: 2 }) })).toThrow(TakeTemplateError);
  });
});
