import { expect, it } from 'vitest';
import { classifyTakeEnd } from './take-end.mjs';

it('keeps user and natural completion identical and non-interrupted', () => {
  const { trigger: userTrigger, ...userEnd } = classifyTakeEnd('user');
  const { trigger: songEndTrigger, ...songEnd } = classifyTakeEnd('song-end');
  expect(userEnd).toEqual(songEnd);
  expect([userTrigger, songEndTrigger]).toEqual(['user', 'song-end']);
  expect(userEnd).toMatchObject({
    interrupted: false, endReason: null, journalEvent: null, health: null,
  });
});

it('keeps the historical persisted endReason for every trigger', () => {
  // Persisted history must not change: resource limits stay explicit, a
  // disconnect still stores 'interrupted', and normal ends stay 'completed'.
  expect(classifyTakeEnd('resource_limit')).toMatchObject({
    interrupted: true, endReason: 'resource_limit', journalEvent: 'resource_limit_closed', health: 'degraded',
  });
  expect(classifyTakeEnd('connection_closed')).toMatchObject({
    interrupted: true, endReason: null, journalEvent: 'connection_closed', health: 'disconnected',
  });
});

it('rejects an unknown trigger instead of guessing a default', () => {
  // @ts-expect-error deliberately invalid trigger
  expect(() => classifyTakeEnd('pause')).toThrow('未知的结束原因');
});
