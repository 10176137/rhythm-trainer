// Reproducible JS evidence measurement, not a full native-engine RSS benchmark.
// Run: node --expose-gc scripts/measure-take-memory.mjs
import { MidiAdmissionLedger } from '../server/midi/admission-ledger.mjs';
if (!global.gc) throw new Error('Run with node --expose-gc');
const ledger = new MidiAdmissionLedger();
let ingests = [];
global.gc();
const baseline = process.memoryUsage();
const sample = (label) => {
  global.gc();
  const usage = process.memoryUsage();
  console.log(JSON.stringify({ label, events: ingests.length,
    heapGrowthMiB: +((usage.heapUsed - baseline.heapUsed) / 1048576).toFixed(2),
    rssMiB: +(usage.rss / 1048576).toFixed(2) }));
};
for (let i = 0; i < 100000; i++) {
  const packet = { sourceId: 'node-midi:test#g1', sourceSeq: i, capturedAtMs: i * 10,
    rawBytes: [144, 60, 90], transport: 'node-midi' };
  ingests.push({ packet, sessionTimeMs: i * 10 });
  ledger.record({ eventId: `node-midi:test#g1:${i}`, kind: 'note-on', complete: true }, packet, i * 10,
    { paused: false, pauseSegments: [], scoringStartMs: 0, segmentId: null });
  if ((i + 1) % 25000 === 0) sample('retained');
}
ingests = [];
ledger.reset();
sample('released');
