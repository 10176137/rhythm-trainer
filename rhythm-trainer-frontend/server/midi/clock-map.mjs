'use strict';

// Node ↔ browser monotonic clock mapping. The PRD formula uses four
// timestamps; this module is pure so it can be tested without a socket.

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Four-timestamp sample:
 *   c0 browser send, s1 server receive, s2 server send, c3 browser receive.
 * offsetServerMinusClient = ((s1 - c0) + (s2 - c3)) / 2
 * clientTime ≈ serverTime - offsetServerMinusClient
 */
export function computeClockSample(input) {
  const { clientSendPerfMs: c0, clientReceivePerfMs: c3, serverReceivePerfMs: s1, serverSendPerfMs: s2 } = input ?? {};
  if (![c0, c3, s1, s2].every(finite)) return null;
  // The server cannot send before it receives; the client cannot receive
  // before it sends. Such a sample is not a usable clock estimate.
  if (s2 < s1 || c3 < c0) return null;
  const rtt = (c3 - c0) - (s2 - s1);
  if (!finite(rtt) || rtt < 0) return null;
  const offset = ((s1 - c0) + (s2 - c3)) / 2;
  if (!finite(offset)) return null;
  return { rtt, offset, uncertainty: rtt / 2 };
}

/** Pick the lowest-RTT sample and expose a quality label for diagnostics. */
export function selectClockSample(samples) {
  const valid = (samples ?? []).filter((sample) => finite(sample?.rtt) && finite(sample?.offset) && sample.rtt >= 0);
  if (valid.length === 0) return null;
  const best = valid.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  let quality = 'unstable';
  if (best.rtt <= 3 && valid.length >= 5) quality = 'good';
  else if (best.rtt <= 15) quality = 'estimated';
  return {
    offsetServerMinusClientMs: best.offset,
    uncertaintyMs: best.uncertainty,
    rttMs: best.rtt,
    sampleCount: valid.length,
    quality,
  };
}

/**
 * Map a Node monotonic capture time into the browser session timeline.
 * `sessionOriginClientPerfMs` is the browser performance.now() at session 0.
 */
export function mapNodeEventToSession(input) {
  const { capturedAtMonotonicMs, offsetServerMinusClientMs, sessionOriginClientPerfMs } = input ?? {};
  if (![capturedAtMonotonicMs, offsetServerMinusClientMs, sessionOriginClientPerfMs].every(finite)) return null;
  const clientPerfMs = capturedAtMonotonicMs - offsetServerMinusClientMs;
  const atSessionMs = clientPerfMs - sessionOriginClientPerfMs;
  if (!finite(clientPerfMs) || !finite(atSessionMs)) return null;
  return { clientPerfMs, atSessionMs };
}
