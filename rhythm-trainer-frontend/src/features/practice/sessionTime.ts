// Session-time mapping for captured MIDI events.
//
// Both MIDIMessageEvent.timeStamp and performance.now() sit on the page's
// performance timeline in Chromium. An override outside this take's range is
// not "now": on the performance timeline it belongs to a previous/idle epoch
// and must be quarantined, never re-timed into the current take. Other clock
// domains (legacy/non-conforming UAs, e.g. epoch-based WebKit stamps) keep the
// handler-time fallback.

const PERFORMANCE_TIMELINE = 'web-page-performance-timeline';
const MAX_SESSION_MS = 24 * 60 * 60 * 1000;

export function toSessionMs(
  override: number | undefined,
  originPerfMs: number,
  clockDomainId: string,
  nowMs: number = performance.now(),
): number | null {
  if (override != null && isFinite(override)) {
    const sessionMs = override - originPerfMs;
    if (sessionMs >= 0 && sessionMs < MAX_SESSION_MS) return sessionMs;
    if (clockDomainId === PERFORMANCE_TIMELINE) return null;
  }
  return nowMs - originPerfMs;
}
