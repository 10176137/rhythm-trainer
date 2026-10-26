'use strict';

import { describe, expect, it } from 'vitest';
import { deriveInputQuality, deriveTakeStatus } from './take-status.mjs';

describe('deriveTakeStatus', () => {
  it('keeps attempt, plan, score and persistence dimensions independent', () => {
    expect(deriveTakeStatus({
      attemptStatus: 'completed',
      inputHealth: 'healthy',
      clockMappingStatus: 'ok',
      plannerAuthority: 'rust',
      scoreStatus: 'AVAILABLE',
      persistenceStatus: 'persisted',
    })).toEqual({
      attemptStatus: 'completed',
      inputQuality: 'healthy',
      planAuthority: 'server-rust',
      planIntegrity: 'verified',
      scoreStatus: 'AVAILABLE',
      persistenceStatus: 'persisted',
    });

    expect(deriveTakeStatus({
      attemptStatus: 'interrupted',
      inputHealth: 'disconnected',
      clockMappingStatus: 'unscorable',
      plannerAuthority: 'rts',
      scoreStatus: 'DEGRADED',
      persistenceStatus: 'pending-retry',
    })).toEqual({
      attemptStatus: 'interrupted',
      inputQuality: 'unscorable',
      planAuthority: 'client-rts-projection',
      planIntegrity: 'unavailable',
      scoreStatus: 'DEGRADED',
      persistenceStatus: 'pending-retry',
    });

    expect(deriveTakeStatus({ attemptStatus: 'completed', plannerAuthority: 'legacy' })).toMatchObject({
      attemptStatus: 'completed',
      planAuthority: 'legacy',
      planIntegrity: 'unavailable',
      scoreStatus: 'UNAVAILABLE',
      persistenceStatus: 'persisted',
    });
  });

  it('never claims plan integrity for a client projection or unknown authority', () => {
    expect(deriveTakeStatus({ attemptStatus: 'completed', plannerAuthority: 'rts' }).planIntegrity).toBe('unavailable');
    expect(deriveTakeStatus({ attemptStatus: 'completed', plannerAuthority: null }).planAuthority).toBe('unknown');
    expect(deriveTakeStatus({ attemptStatus: 'completed', plannerAuthority: null }).planIntegrity).toBe('unavailable');
  });
});

describe('deriveInputQuality', () => {
  it('distinguishes healthy, degraded, unscorable and unknown evidence', () => {
    expect(deriveInputQuality('healthy', 'ok')).toBe('healthy');
    expect(deriveInputQuality('healthy', 'limited')).toBe('degraded');
    expect(deriveInputQuality('degraded', 'ok')).toBe('degraded');
    expect(deriveInputQuality('disconnected', 'ok')).toBe('degraded');
    expect(deriveInputQuality('healthy', 'unscorable')).toBe('unscorable');
    expect(deriveInputQuality('unknown', 'ok')).toBe('unknown');
    expect(deriveInputQuality(undefined, undefined)).toBe('unknown');
  });
});
