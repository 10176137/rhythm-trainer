// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EngineHandlers } from '../../services/engineBridge';
import { usePracticeSession } from './usePracticeSession';
const fake = vi.hoisted(() => ({ handlers: null as unknown as EngineHandlers, finish: vi.fn(), pause: vi.fn(), resume: vi.fn(), raw: vi.fn() }));
vi.mock('../../services/engineBridge', () => ({ EngineBridge: class {
  constructor(handlers: EngineHandlers) { fake.handlers = handlers; }
  connect = async () => {}; start = vi.fn(); tick = vi.fn(); sessionOrigin = vi.fn();
  finish = fake.finish; pause = fake.pause; resume = fake.resume; sendRawMidi = fake.raw; close = vi.fn();
} }));
let session: ReturnType<typeof usePracticeSession>; let root: Root; let host: HTMLDivElement;
const started = vi.fn();
function Probe() { session = usePracticeSession({ onStarted: started }); return null; }
beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Probe />));
  await act(async () => session.begin({ modeId: 'score', bpm: 60, profile: 'standard', countInBeats: 3, ticksPerQuarter: 960,
    atoms: [], metronomeEnabled: false, armOnFirstInput: true }));
  await act(async () => fake.handlers.onStarted([], 60, 'standard', 7, undefined, { armed: true, countInMs: 3000, firstTargetAtMs: 4000 }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('waits for the server clock and ignores a stale capture epoch', async () => {
  expect(session.waitingForFirstInput).toBe(true); expect(started).not.toHaveBeenCalled();
  await act(async () => fake.handlers.onClockStarted?.({ type: 'clock-started', captureEpoch: 6, originClientPerfMs: 1000, firstTargetAtMs: 4000 }));
  expect(session.waitingForFirstInput).toBe(true);
  await act(async () => fake.handlers.onClockStarted?.({ type: 'clock-started', captureEpoch: 7, originClientPerfMs: 1000, firstTargetAtMs: 4000 }));
  expect(session.waitingForFirstInput).toBe(false); expect(session.originPerfMs).toBe(1000);
  expect(started).toHaveBeenCalledWith(expect.objectContaining({ originPerfMs: 1000 }));
});
it('forwards virtual input while waiting without starting a browser scoring clock', async () => {
  await act(async () => session.ingestPacket({ sourceId: 'virtual', sourceSeq: 1, clockDomainId: 'performance', capturedAtMs: 5000,
    rawBytes: [0x90, 60, 90], transport: 'mock', captureEpoch: 7 }));
  expect(fake.raw).toHaveBeenCalledWith(expect.objectContaining({ sessionTimeMs: null }));
  expect(started).not.toHaveBeenCalled(); expect(session.originPerfMs).toBeNull();
});
it('can pause/resume and reset an armed take before the first key', async () => {
  await act(async () => session.pause()); expect(fake.pause).toHaveBeenCalledWith(0, expect.any(Number));
  await act(async () => session.resume()); expect(fake.resume).toHaveBeenCalledWith(0, expect.any(Number));
  await act(async () => session.reset()); expect(fake.finish).toHaveBeenCalledOnce();
  expect(session.waitingForFirstInput).toBe(false); expect(session.status).toBe('idle');
});
it('terminates a waiting take when its engine connection is lost', async () => {
  await act(async () => fake.handlers.onDisconnected());
  expect(session.status).toBe('idle'); expect(session.waitingForFirstInput).toBe(false);
});
