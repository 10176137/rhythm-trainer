// R2-3h-R1: behavioural regression tests for the two review blockers.
// These drive the REAL launch-flow helpers with injected spies and delayed
// promises, and assert on SIDE EFFECTS (was a session/follow started? was the
// TS planner called?) — not on source text.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../parity/case-bundle';
import {
  decideAuthority,
  evaluatePlanCurrency,
  orchestrateRustLaunch,
  planContextKey,
  type LaunchToken,
  type LiveLaunchState,
} from './launch-flow';
import type { RustPlanResponse } from './rust-plan';

const root = findRepoRoot();
const CORPUS = JSON.parse(readFileSync(
  join(root, 'audit-r1', 'fixtures', 'parity-cases', 'rust-parity-input', 'G1-base.json'), 'utf8'));
const FINGERPRINT = CORPUS.report.fingerprint as string;

const MAPPING = CORPUS.config.handMapping;

function contextKeyFor(overrides: Partial<{ hand: string; tempo: number; end: number }> = {}) {
  return planContextKey({
    hand: overrides.hand ?? 'both',
    tempo: overrides.tempo ?? 80,
    modeId: 'score',
    loopActive: false,
    loopStartBar: 1,
    loopEndBar: 2,
    range: { startMeasureOrdinal: 1, endMeasureOrdinal: overrides.end ?? 2 },
    handMapping: MAPPING,
  });
}

const token: LaunchToken = {
  generation: 1,
  contextKey: contextKeyFor(),
  scoreFingerprint: FINGERPRINT,
  mode: 'timeline',
};

function live(overrides: Partial<LiveLaunchState> = {}): LiveLaunchState {
  return {
    generation: 1,
    contextKey: contextKeyFor(),
    scoreFingerprint: FINGERPRINT,
    mode: 'timeline',
    authority: 'rust',
    ...overrides,
  };
}

function response(): RustPlanResponse {
  return {
    requestId: 'plan-1',
    ok: true,
    plannerAuthority: 'rust',
    plannerVersion: 'rust-planner-1',
    planFingerprint: `plan-v1:sha256:${'a'.repeat(64)}`,
    scoreFingerprint: FINGERPRINT,
    strictAllowed: true,
    planIssues: [],
    scopeCodes: [],
    missingEventIds: [],
    atomIssueCodes: [],
    plan: { occurrences: [], groups: [], atoms: [], scoreEvents: [] } as never,
  };
}

/** Delayed plan response controlled by the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Models App.startRustPractice's `mode` parameter: a union-typed value, so the
 * captured closure branch is not statically narrowed to a single literal.
 */
function capturedMode(mode: 'timeline' | 'follow'): 'timeline' | 'follow' {
  return mode;
}

describe('R2-3h-R1 F1: unknown planner authority never falls back to TS', () => {
  it('1. while the status answer is pending, a launch is blocked and the TS planner is never called', async () => {
    // The mount effect starts a probe that has NOT answered yet; the cache is
    // still null when the user hits start.
    let cache: 'rts' | 'rust' | null = null;
    const pendingProbe = new Promise<{ authority: string }>(() => { /* never settles */ });
    void pendingProbe.then((status) => { cache = status.authority as 'rts' | 'rust'; });

    const route = decideAuthority(cache);
    const tsPlanner = vi.fn(() => 'ts-plan');
    const startSession = vi.fn();
    if (route.route === 'rts') tsPlanner();
    if (route.route === 'rust') startSession();

    expect(route.route).toBe('blocked');
    expect(tsPlanner).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it('2. a failed status probe leaves the authority unknown and the launch blocked (no silent switch)', async () => {
    const probe = vi.fn(async () => { throw new Error('PLANNER_STATUS_TIMEOUT: no answer'); });
    let cached: 'rts' | 'rust' | null = 'rust'; // pretend it was cached before
    try {
      const status = (await probe()) as { authority: 'rts' | 'rust' };
      cached = status.authority;
    } catch {
      cached = null; // invalidation path (App.refreshPlannerAuthority)
    }
    const route = decideAuthority(cached);
    expect(route.route).toBe('blocked');
    if (route.route === 'blocked') expect(route.code).toBe('AUTHORITY_UNKNOWN');
  });

  it('3. an explicit rts answer keeps the TS path available', () => {
    expect(decideAuthority('rts')).toEqual({ route: 'rts' });
    const tsPlanner = vi.fn(() => 'ts-plan');
    const route = decideAuthority('rts');
    if (route.route === 'rts') tsPlanner();
    expect(tsPlanner).toHaveBeenCalledTimes(1);
  });

  it('3b. an unparsable status value is blocked, not treated as rts', () => {
    for (const garbage of ['legacy', '', null, undefined, 7, {}]) {
      expect(decideAuthority(garbage as never).route).toBe('blocked');
    }
  });
});

describe('R2-3h-R1 F2: a stale plan never starts', () => {
  it('4. score switched while waiting -> the old plan is discarded and nothing starts', async () => {
    const plan = deferred<RustPlanResponse>();
    const beginSession = vi.fn();
    const startFollow = vi.fn();
    let currentFingerprint: string | null = FINGERPRINT;
    const outcomePromise = orchestrateRustLaunch({
      token,
      request: () => plan.promise,
      live: () => live({ scoreFingerprint: currentFingerprint }),
      accept: (res) => {
        beginSession(res.requestId);
        return 'started';
      },
    });
    // The user switches scores while the request is in flight.
    currentFingerprint = 'c'.repeat(64);
    plan.resolve(response());
    const outcome = await outcomePromise;
    expect(outcome.status).toBe('cancelled');
    if (outcome.status === 'cancelled') expect(outcome.code).toBe('STALE_SCORE');
    expect(beginSession).not.toHaveBeenCalled();
    expect(startFollow).not.toHaveBeenCalled();
  });

  it('4b. follow mode: a stale plan never builds a FollowSession', async () => {
    const plan = deferred<RustPlanResponse>();
    const startFollow = vi.fn();
    let currentFingerprint: string | null = FINGERPRINT;
    const outcomePromise = orchestrateRustLaunch({
      token,
      request: () => plan.promise,
      live: () => live({ scoreFingerprint: currentFingerprint }),
      accept: () => { startFollow(); return 'ok'; },
    });
    currentFingerprint = null; // score selection cleared
    plan.resolve(response());
    const outcome = await outcomePromise;
    expect(outcome.status).toBe('cancelled');
    expect(startFollow).not.toHaveBeenCalled();
  });

  it('5. config/range change or a newer launch generation discards the old response', async () => {
    // (a) context changed
    const planA = deferred<RustPlanResponse>();
    const acceptA = vi.fn();
    let context: string = contextKeyFor();
    const runA = orchestrateRustLaunch({
      token,
      request: () => planA.promise,
      live: () => live({ contextKey: context }),
      accept: acceptA,
    });
    context = contextKeyFor({ tempo: 120 }); // tempo changed during the wait
    planA.resolve(response());
    const outcomeA = await runA;
    expect(outcomeA.status).toBe('cancelled');
    if (outcomeA.status === 'cancelled') expect(outcomeA.code).toBe('STALE_CONTEXT');
    expect(acceptA).not.toHaveBeenCalled();

    // (a2) range changed
    const runA2 = orchestrateRustLaunch({
      token,
      request: async () => response(),
      live: () => live({ contextKey: contextKeyFor({ end: 3 }) }),
      accept: acceptA,
    });
    expect((await runA2).status).toBe('cancelled');
    expect(acceptA).not.toHaveBeenCalled();

    // (b) superseded by a newer launch
    const planB = deferred<RustPlanResponse>();
    const acceptB = vi.fn();
    let generation = 1;
    const runB = orchestrateRustLaunch({
      token,
      request: () => planB.promise,
      live: () => live({ generation }),
      accept: acceptB,
    });
    generation = 2; // a newer launch started
    planB.resolve(response());
    const outcomeB = await runB;
    expect(outcomeB.status).toBe('cancelled');
    if (outcomeB.status === 'cancelled') expect(outcomeB.code).toBe('STALE_SUPERSEDED');
    expect(acceptB).not.toHaveBeenCalled();
  });

  it('5b. the authority disappearing mid-flight discards the plan', async () => {
    const plan = deferred<RustPlanResponse>();
    const accept = vi.fn();
    let authority: 'rts' | 'rust' | null = 'rust';
    const run = orchestrateRustLaunch({
      token,
      request: () => plan.promise,
      live: () => live({ authority }),
      accept,
    });
    authority = null; // disconnect invalidated the cache
    plan.resolve(response());
    const outcome = await run;
    expect(outcome.status).toBe('cancelled');
    if (outcome.status === 'cancelled') expect(outcome.code).toBe('AUTHORITY_LOST');
    expect(accept).not.toHaveBeenCalled();
  });

  it('5c. timeline -> follow while waiting: the old timeline plan never calls session.begin', async () => {
    const plan = deferred<RustPlanResponse>();
    const beginSession = vi.fn();
    const startFollow = vi.fn();
    // `launchMode` is the mode captured by the launch closure (App.tsx passes
    // it down and accept branches on it); `currentMode` is the live setting.
    const launchMode = capturedMode('timeline');
    let currentMode: 'timeline' | 'follow' = 'timeline';
    const run = orchestrateRustLaunch({
      token: { ...token, mode: launchMode },
      request: () => plan.promise,
      // Score, generation and context key are all unchanged — only the mode
      // differs, which is exactly the case the previous context key missed.
      live: () => live({ mode: currentMode }),
      accept: (res) => {
        if (launchMode === 'follow') startFollow();
        else beginSession(res.requestId);
        return 'started';
      },
    });
    currentMode = 'follow'; // the user flips the setting before the response
    plan.resolve(response());
    const outcome = await run;
    expect(outcome.status).toBe('cancelled');
    if (outcome.status === 'cancelled') expect(outcome.code).toBe('STALE_MODE');
    expect(beginSession).not.toHaveBeenCalled();
    expect(startFollow).not.toHaveBeenCalled();
  });

  it('5d. follow -> timeline while waiting: the old follow plan never builds a FollowSession', async () => {
    const plan = deferred<RustPlanResponse>();
    const beginSession = vi.fn();
    const startFollow = vi.fn();
    const launchMode = capturedMode('follow');
    let currentMode: 'timeline' | 'follow' = 'follow';
    const run = orchestrateRustLaunch({
      token: { ...token, mode: launchMode },
      request: () => plan.promise,
      live: () => live({ mode: currentMode }),
      accept: () => {
        if (launchMode === 'follow') startFollow();
        else beginSession();
        return 'started';
      },
    });
    currentMode = 'timeline';
    plan.resolve(response());
    const outcome = await run;
    expect(outcome.status).toBe('cancelled');
    if (outcome.status === 'cancelled') expect(outcome.code).toBe('STALE_MODE');
    expect(startFollow).not.toHaveBeenCalled();
    expect(beginSession).not.toHaveBeenCalled();
  });

  it('5e. the mode cause survives an otherwise identical snapshot', () => {
    // Same generation, score and context key: only the explicit mode check
    // can distinguish this launch from the live state.
    const verdict = evaluatePlanCurrency(
      { ...token, mode: 'timeline' },
      live({ mode: 'follow', contextKey: token.contextKey }),
    );
    expect(verdict).toMatchObject({ current: false, code: 'STALE_MODE' });
  });

  it('6. a current response still starts normally (timeline and follow accept paths)', async () => {
    const timelineAccept = vi.fn(() => 'timeline-started');
    const timeline = await orchestrateRustLaunch({
      token,
      request: async () => response(),
      live: () => live(),
      accept: timelineAccept,
    });
    expect(timeline).toEqual({ status: 'started', result: 'timeline-started' });
    expect(timelineAccept).toHaveBeenCalledTimes(1);

    const followAccept = vi.fn(() => 'follow-started');
    const follow = await orchestrateRustLaunch({
      token: { ...token, mode: 'follow' },
      request: async () => response(),
      live: () => live({ mode: 'follow' }),
      accept: followAccept,
    });
    expect(follow).toEqual({ status: 'started', result: 'follow-started' });
  });

  it('6b. a request failure surfaces as a coded failure and never calls accept', async () => {
    const accept = vi.fn();
    const outcome = await orchestrateRustLaunch({
      token,
      request: async () => { throw new Error('TIMELINE_SEMANTICS_REJECTED: atoms mismatch'); },
      live: () => live(),
      accept,
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.code).toBe('TIMELINE_SEMANTICS_REJECTED');
    expect(accept).not.toHaveBeenCalled();
  });

  it('6c. a failing accept (mode gate) is reported as failed, not started', async () => {
    const outcome = await orchestrateRustLaunch({
      token,
      request: async () => response(),
      live: () => live(),
      accept: () => { throw new Error('FOLLOW_PLAN_REJECTED: scopeCodes'); },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.code).toBe('FOLLOW_PLAN_REJECTED');
  });

  it('currency evaluation distinguishes each stale cause', () => {
    expect(evaluatePlanCurrency(token, live())).toEqual({ current: true });
    expect(evaluatePlanCurrency(token, live({ generation: 2 }))).toMatchObject({ current: false, code: 'STALE_SUPERSEDED' });
    expect(evaluatePlanCurrency(token, live({ scoreFingerprint: null }))).toMatchObject({ current: false, code: 'STALE_SCORE' });
    expect(evaluatePlanCurrency(token, live({ mode: 'follow' }))).toMatchObject({ current: false, code: 'STALE_MODE' });
    expect(evaluatePlanCurrency(token, live({ contextKey: 'other' }))).toMatchObject({ current: false, code: 'STALE_CONTEXT' });
    expect(evaluatePlanCurrency(token, live({ authority: 'rts' }))).toMatchObject({ current: false, code: 'AUTHORITY_LOST' });
    expect(evaluatePlanCurrency(token, live({ authority: null }))).toMatchObject({ current: false, code: 'AUTHORITY_LOST' });
  });
});
