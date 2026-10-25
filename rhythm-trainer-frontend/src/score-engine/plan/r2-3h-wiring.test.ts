// R2-3h: structural guarantees for the browser wiring. These read the real
// App.tsx source so they fail loudly if someone re-introduces TS planning,
// second hand filtering or atom/scoreEvent regeneration on the Rust branch.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../parity/case-bundle';

const root = findRepoRoot();
const appSource = readFileSync(join(root, 'rhythm-trainer-frontend', 'src', 'App.tsx'), 'utf8');

function rustBranchSource(): string {
  const start = appSource.indexOf('const startRustPractice = async');
  const end = appSource.indexOf('const launchPractice = (');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return appSource.slice(start, end);
}

describe('R2-3h: single plan authority in the rust branch', () => {
  it('the rust launch branch never calls the TS planner or re-derives targets', () => {
    const branch = rustBranchSource();
    for (const forbidden of [
      'buildPlaybackPlan',
      'scoreOccurrencesToEngineAtoms',
      'buildEngineScoreEvents',
      'filterPlaybackPlanByHand',
    ]) {
      expect(branch.includes(forbidden), `rust branch must not call ${forbidden}`).toBe(false);
    }
  });

  it('the rust branch is only reachable through the server-reported authority', () => {
    // Both launch sites gate on plannerAuthorityRef.current === 'rust' and the
    // server status is the only writer of that ref.
    const gatedCalls = appSource.match(/plannerAuthorityRef\.current === 'rust'/g) ?? [];
    expect(gatedCalls.length).toBe(2); // follow + timeline
    expect(appSource).toContain('session.getPlannerStatus()');
    // No client-side env/switch reading — the browser never owns a second switch.
    expect(appSource.includes('RHYTHM_PLANNER')).toBe(false);
  });

  it('free play stays independent of any plan request', () => {
    const freeStart = appSource.indexOf("if (config.modeId === 'free') {");
    const freeEnd = appSource.indexOf("if (config.advanceMode === 'follow') {", freeStart);
    expect(freeStart).toBeGreaterThan(-1);
    expect(freeEnd).toBeGreaterThan(freeStart);
    const freeBranch = appSource.slice(freeStart, freeEnd);
    expect(freeBranch).toContain('beginFreePlay');
    expect(freeBranch.includes('requestPlannerPlan')).toBe(false);
  });

  it('the default rts path keeps using the TS planner (unchanged behavior)', () => {
    // The TS timeline block is still present after the rust branch returns.
    const timelineStart = appSource.indexOf("if (plannerAuthorityRef.current === 'rust' && scoreDoc.engine && launchScope)");
    expect(timelineStart).toBeGreaterThan(-1);
    const rest = appSource.slice(timelineStart, timelineStart + 4000);
    expect(rest).toContain('buildPlaybackPlan');
  });
});
