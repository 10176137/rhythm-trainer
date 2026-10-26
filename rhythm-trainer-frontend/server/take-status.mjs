'use strict';

// Orthogonal Take status dimensions. These answer different questions and must
// not be collapsed into the legacy `assessment.trustworthy` boolean:
//   attemptStatus     — did the user complete the attempt?
//   inputQuality      — is the device/clock evidence reliable enough?
//   planAuthority     — who authored the standard answer?
//   planIntegrity     — was that plan verified as server authority?
//   scoreStatus       — which scores may legally be produced?
//   persistenceStatus — was the final Take actually written?
//
// `trustworthy` stays as a compatibility projection for old readers.

const PLAN_AUTHORITY = Object.freeze({
  rust: 'server-rust',
  rts: 'client-rts-projection',
  legacy: 'legacy',
});

/**
 * @param {object} input
 * @param {'completed'|'interrupted'|'abandoned'|'rejected'} input.attemptStatus
 * @param {string} [input.inputHealth] adapter health: healthy|degraded|disconnected|unknown
 * @param {string} [input.clockMappingStatus] ok|limited|unscorable|unknown
 * @param {'rust'|'rts'|'legacy'|null} [input.plannerAuthority]
 * @param {string|null} [input.scoreStatus]
 * @param {'persisted'|'pending-retry'|'failed'} [input.persistenceStatus]
 */
export function deriveTakeStatus({
  attemptStatus,
  inputHealth = 'unknown',
  clockMappingStatus = 'unknown',
  plannerAuthority = null,
  scoreStatus = null,
  persistenceStatus = 'persisted',
}) {
  return {
    attemptStatus,
    inputQuality: deriveInputQuality(inputHealth, clockMappingStatus),
    planAuthority: PLAN_AUTHORITY[plannerAuthority] ?? 'unknown',
    // Only a server-issued Rust plan carries a verified fingerprint gate today.
    // The rts projection has no server plan fingerprint, so it must not claim
    // verification.
    planIntegrity: plannerAuthority === 'rust' ? 'verified' : 'unavailable',
    scoreStatus: scoreStatus ?? 'UNAVAILABLE',
    persistenceStatus,
  };
}

export function deriveInputQuality(inputHealth, clockMappingStatus) {
  if (clockMappingStatus === 'unscorable') return 'unscorable';
  if (inputHealth === 'unknown' || inputHealth == null) return 'unknown';
  if (inputHealth !== 'healthy') return 'degraded';
  if (clockMappingStatus === 'limited') return 'degraded';
  return 'healthy';
}
