import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProfileEvidenceCache } from './profile-evidence.mjs';
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const createModel = (snapshot = []) => {
  let items = [...snapshot];
  return { snapshot: () => [...items], observeAttempt: (mode, evidence) => { items.push({ mode, ...evidence }); } };
};
const take = (id) => ({ takeId: id, lifecycle: { finishedAtIso: '2026-10-28T00:00:00Z' }, engineDiagnostics: { profileEvidence: { modeId: 'score', attempt: { passed: true, trustworthy: true, targetCount: 4, assisted: false, transferTest: false, delayedRetest: false } } } });
describe('profile evidence recovery', () => {
  it('recovers committed evidence after a restart and never applies it twice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-')); dirs.push(dir); const file = path.join(dir, 'profile.json');
    let fail = true;
    const cache = new ProfileEvidenceCache({ file, createModel, write: (record) => { if (fail) throw new Error('disk full'); fs.writeFileSync(file, JSON.stringify(record)); } });
    expect(() => cache.recover([take('a')])).toThrow('disk full');
    expect(cache.snapshot()).toHaveLength(1);
    fail = false;
    cache.recover([take('a')]);
    expect(cache.snapshot()).toHaveLength(1);
    const reopened = new ProfileEvidenceCache({ file, createModel });
    reopened.recover([take('a'), take('b')]);
    expect(reopened.snapshot()).toHaveLength(2);
    expect(new ProfileEvidenceCache({ file, createModel }).snapshot()).toHaveLength(2);
  });
  it('replays a Take that committed before the profile write ever happened, preserving legacy cache', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-')); dirs.push(dir); const file = path.join(dir, 'profile.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, snapshot: [{ mode: 'legacy' }] }));
    const cache = new ProfileEvidenceCache({ file, createModel });
    cache.recover([take('committed'), { takeId: 'legacy-take' }]);
    expect(cache.snapshot()).toHaveLength(2);
    cache.recover([take('committed')]);
    expect(cache.snapshot()).toHaveLength(2);
  });
});
