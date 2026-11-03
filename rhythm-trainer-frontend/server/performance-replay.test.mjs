import { expect, it } from 'vitest';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPerformanceReplay, loadPerformanceReplay } from './performance-replay.mjs';
const take = { takeId: 'take-test', evidence: { pauseIntervals: [] } };
const event = (at, bytes, source = 'piano') => ({ sessionTimeMs: at, rawBytes: bytes, sourceId: source });
it('preserves actual wrong pitches, velocity, re-attacks, sources and sustain release', () => {
  const trace = { events: [event(3000,[144,61,20]),event(3100,[176,64,127]),event(3200,[128,61,0]),event(3300,[144,61,100]),event(3400,[128,61,0]),event(3500,[176,64,0])] };
  const result = buildPerformanceReplay(take, trace);
  expect(result.notes.map(n => [n.pitch,n.velocity,n.atMs,n.keyDurationMs,n.durationMs])).toEqual([[61,20,0,200,500],[61,100,300,100,200]]);
  expect(result.durationMs).toBe(500);
});
it('keeps channels independent and excludes suppressed attacks', () => {
  const result = buildPerformanceReplay(take, {events:[event(0,[144,60,80]),event(5,[145,60,90]),{...event(10,[144,64,80]),admission:{finalOnset:false}},event(100,[128,60,0]),event(200,[129,60,0])]});
  expect(result.notes.map(n=>n.durationMs)).toEqual([100,195]);
});
it('warns on missing releases, truncation and cuts held voices at a pause', () => {
  const t={...take,evidence:{pauseIntervals:[{startMs:100,endMs:500}]}};
  const result=buildPerformanceReplay(t,{manifest:{complete:false},events:[event(0,[144,60,80]),event(600,[144,62,90])]});
  expect(result.notes[0].durationMs).toBe(100); expect(result.warnings.join('')).toContain('截断'); expect(result.warnings.join('')).toContain('不完整');
});
it('stores the Take association and reports a deleted or corrupt file without regenerating it', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'performance-replay-'));let reads=0;
  const trace=()=>{reads++;return{events:[event(0,[144,60,80]),event(100,[128,60,0])]};};
  expect(loadPerformanceReplay(dir,take,trace).status).toBe('available');
  expect(loadPerformanceReplay(dir,take,trace).status).toBe('available'); expect(reads).toBe(1);
  const file=path.join(dir,'take-test.json');unlinkSync(file);
  expect(loadPerformanceReplay(dir,take,trace).status).toBe('missing'); expect(reads).toBe(1);
  writeFileSync(file,'invalid');expect(loadPerformanceReplay(dir,take,trace).status).toBe('missing');
});
