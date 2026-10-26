// R2-3h-R1: launch-flow rules for the planner switchover. These are the
// executable contracts App.tsx follows, extracted so they can be tested with
// injected spies and delayed promises (the two review blockers):
//   F1 — an UNKNOWN planner authority must never fall through to TS planning.
//   F2 — a plan that arrives after the score/config/launch-generation changed
//        must never start a session.
import type { RustPlanResponse } from './rust-plan';
import type { ScoreAdvanceMode } from '../../types/practice';
import type { RepeatSelection } from '../domain/types';

export type PlannerAuthorityValue = 'rts' | 'rust';

export class LaunchBlockedError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'LaunchBlockedError';
  }
}

/** Narrows an arbitrary status value; anything else is a blocked launch. */
export function normalizePlannerAuthority(value: unknown): PlannerAuthorityValue {
  if (value === 'rts' || value === 'rust') return value;
  throw new LaunchBlockedError(
    'AUTHORITY_UNAVAILABLE',
    `服务端返回了无法识别的规划权威（${String(value)}）`,
  );
}

export type AuthorityRoute =
  | { route: 'blocked'; code: 'AUTHORITY_UNKNOWN'; message: string }
  | { route: 'rts' }
  | { route: 'rust' };

/**
 * The synchronous launch decision. `null` means the authority has not been
 * confirmed (initial fetch pending/failed or the engine disconnected): the
 * caller must block the launch and re-probe — NEVER run TS planning.
 */
export function decideAuthority(cached: PlannerAuthorityValue | null): AuthorityRoute {
  if (cached === 'rts') return { route: 'rts' };
  if (cached === 'rust') return { route: 'rust' };
  return {
    route: 'blocked',
    code: 'AUTHORITY_UNKNOWN',
    message: '尚未确认服务端的规划器（引擎服务可能未连接）。本次练习不会启动，也不会在浏览器内改用其他规划器。',
  };
}

/**
 * Stable key over the launch-relevant practice configuration. The launch mode
 * (timeline vs follow) is deliberately NOT part of this key: it is bound as a
 * first-class token field (`LaunchToken.mode`) so a mode switch reports its own
 * STALE_MODE cause instead of being folded into a generic config mismatch.
 */
export function planContextKey(input: {
  hand: string;
  tempo: number;
  modeId: string;
  loopActive: boolean;
  loopStartBar: number;
  loopEndBar: number;
  range: { startMeasureOrdinal: number; endMeasureOrdinal: number };
  handMapping: unknown;
  /** Stage 2: repeat policy and the canonical count-in also define the plan. */
  repeatSelection?: RepeatSelection;
  countInUs?: number;
  ticksPerQuarter?: number;
}): string {
  return JSON.stringify({
    hand: input.hand,
    tempo: input.tempo,
    modeId: input.modeId,
    loopActive: input.loopActive,
    loopStartBar: input.loopStartBar,
    loopEndBar: input.loopEndBar,
    range: [input.range.startMeasureOrdinal, input.range.endMeasureOrdinal],
    handMapping: input.handMapping,
    repeatSelection: input.repeatSelection ?? { kind: 'none' },
    countInUs: input.countInUs ?? 3_000_000,
    ticksPerQuarter: input.ticksPerQuarter ?? 960,
  });
}

/** Everything a launch binds at request time. */
export interface LaunchToken {
  generation: number;
  contextKey: string;
  scoreFingerprint: string;
  /** The mode this launch actually requested (not a copy of config.modeId). */
  mode: ScoreAdvanceMode;
}

export interface LiveLaunchState {
  generation: number;
  contextKey: string;
  scoreFingerprint: string | null;
  /** The advance mode currently selected in the app. */
  mode: ScoreAdvanceMode;
  authority: PlannerAuthorityValue | null;
}

export type CurrencyVerdict =
  | { current: true }
  | { current: false; code: 'STALE_SUPERSEDED' | 'STALE_SCORE' | 'STALE_MODE' | 'STALE_CONTEXT' | 'AUTHORITY_LOST'; message: string };

/**
 * Checks that the launch which issued the request is STILL the live one.
 * `live` is read from the app's current state AFTER the response arrived —
 * comparing only against values captured in the async closure would prove
 * nothing about the score being the one currently selected.
 *
 * The mode check is separate from the context key on purpose: timeline and
 * follow plans are consumed by different starters (session.begin vs
 * FollowSession), and switching between them changes neither the score nor
 * the practice config, so only an explicit mode comparison can reject it.
 */
export function evaluatePlanCurrency(token: LaunchToken, live: LiveLaunchState): CurrencyVerdict {
  if (live.generation !== token.generation) {
    return { current: false, code: 'STALE_SUPERSEDED', message: '本次启动已被新的启动流程取代' };
  }
  if (live.scoreFingerprint === null || live.scoreFingerprint !== token.scoreFingerprint) {
    return { current: false, code: 'STALE_SCORE', message: '等待期间曲谱已切换' };
  }
  if (live.mode !== token.mode) {
    return { current: false, code: 'STALE_MODE', message: '等待期间练习推进模式已切换' };
  }
  if (live.contextKey !== token.contextKey) {
    return { current: false, code: 'STALE_CONTEXT', message: '等待期间练习配置或范围已变化' };
  }
  if (live.authority !== 'rust') {
    return { current: false, code: 'AUTHORITY_LOST', message: '规划权威已失效或无法确认' };
  }
  return { current: true };
}

export type RustLaunchOutcome<Result> =
  | { status: 'started'; result: Result }
  | { status: 'cancelled'; code: string; message: string }
  | { status: 'failed'; code: string; message: string };

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const matched = /^([A-Z][A-Z0-9_]{2,}):\s*([\s\S]*)$/.exec(message);
  return matched ? matched[1] : 'PLAN_FAILED';
}

/**
 * The Rust launch orchestration: request -> currency check -> accept.
 * `accept` performs the parse and the session/FollowSession start, so a
 * stale response can never reach it.
 */
export async function orchestrateRustLaunch<Result>(input: {
  token: LaunchToken;
  request: () => Promise<RustPlanResponse>;
  /** reads the CURRENT app state once the response (or error) is in. */
  live: () => LiveLaunchState;
  /** mode-specific gates + parse + start. Runs only for a current response. */
  accept: (response: RustPlanResponse) => Result;
}): Promise<RustLaunchOutcome<Result>> {
  if (decideAuthority(input.live().authority).route !== 'rust') {
    return {
      status: 'cancelled',
      code: 'AUTHORITY_LOST',
      message: '规划权威已失效或无法确认，已丢弃计划',
    };
  }
  let response: RustPlanResponse;
  try {
    response = await input.request();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', code: errorCode(error), message };
  }
  const verdict = evaluatePlanCurrency(input.token, input.live());
  if (!verdict.current) {
    return { status: 'cancelled', code: verdict.code, message: verdict.message };
  }
  try {
    return { status: 'started', result: input.accept(response) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', code: errorCode(error), message };
  }
}
