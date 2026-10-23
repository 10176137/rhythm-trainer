// Runs the golden MIDI packet traces (test-fixtures/golden-midi-traces.json)
// through the authoritative Rust decoder + key lifecycle tracker via the
// N-API addon. Deterministic-replay check included.
// Run: node examples/golden-fixtures-run.mjs  (build the addon first)

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { decodeMidiPackets, trackKeyLifecycles } = require('../bindings/node');

const golden = JSON.parse(readFileSync(new URL('../test-fixtures/golden-midi-traces.json', import.meta.url), 'utf8'));

const toIngest = (packet, mapping) => {
  const ingest = {
    packet: {
      sourceId: packet.sourceId,
      sourceSeq: packet.sourceSeq,
      clockDomainId: packet.clockDomainId,
      capturedAtMs: packet.capturedAtMs,
      rawBytes: packet.rawBytes,
      transport: packet.transport ?? 'mock',
    },
  };
  if (packet.sessionTimeMs != null) ingest.sessionTimeMs = packet.sessionTimeMs;
  if (mapping) {
    ingest.clockMappingId = mapping.clockMappingId;
    ingest.clockUncertaintyMs = mapping.uncertaintyMs;
    ingest.clockQuality = mapping.quality;
  }
  return ingest;
};

let failures = 0;
for (const testCase of golden.cases) {
  const ingests = testCase.packets.map((p) => toIngest(p, golden.clockMapping));
  const decoded = decodeMidiPackets(ingests);
  const report = trackKeyLifecycles(ingests);
  const problems = [];
  if (testCase.expected?.decodedKinds) {
    const kinds = decoded.map((d) => d.kind);
    if (JSON.stringify(kinds) !== JSON.stringify(testCase.expected.decodedKinds)) {
      problems.push(`kinds ${JSON.stringify(kinds)}`);
    }
  }
  if (testCase.expected?.keyPresses) {
    const presses = report.observations.map((o) => ({
      sourceId: o.sourceId, channel: o.channel, noteNumber: o.noteNumber,
      keyDownDurationMs: o.keyDownDurationMs ?? null, status: o.status,
    }));
    for (const expected of testCase.expected.keyPresses) {
      const match = presses.find((p) =>
        (!expected.channel || p.channel === expected.channel) && p.noteNumber === expected.noteNumber);
      if (!match) { problems.push(`missing press ${JSON.stringify(expected)}`); continue; }
      if (expected.keyDownDurationMs != null && match.keyDownDurationMs !== expected.keyDownDurationMs) {
        problems.push(`duration ${JSON.stringify(match)}`);
      }
      if (expected.status && match.status !== expected.status) {
        problems.push(`status ${match.status} (want ${expected.status})`);
      }
    }
  }
  if (testCase.expected?.diagnosticCodes) {
    for (const code of testCase.expected.diagnosticCodes) {
      if (!report.diagnostics.some((d) => d.code === code)) problems.push(`missing diagnostic ${code}`);
    }
  }
  if (testCase.expectedAfterFinish) {
    const presses = report.observations.map((o) => ({
      noteNumber: o.noteNumber, status: o.status, keyDownDurationMs: o.keyDownDurationMs ?? null,
    }));
    for (const expected of testCase.expectedAfterFinish.keyPresses) {
      const match = presses.find((p) => p.noteNumber === expected.noteNumber);
      if (!match || match.status !== expected.status || match.keyDownDurationMs !== expected.keyDownDurationMs) {
        problems.push(`after-finish ${JSON.stringify(match)}`);
      }
    }
    for (const code of testCase.expectedAfterFinish.diagnosticCodes) {
      if (!report.diagnostics.some((d) => d.code === code)) problems.push(`missing diagnostic ${code}`);
    }
  }
  console.log(`${problems.length ? 'FAIL' : '  ok'}  ${testCase.name}${problems.length ? ' — ' + problems.join('; ') : ''}`);
  if (problems.length) failures += 1;
}

const flat = golden.cases.flatMap((c) => c.packets.map((p) => toIngest(p, null)));
const first = JSON.stringify(trackKeyLifecycles(flat));
const second = JSON.stringify(trackKeyLifecycles(flat));
console.log(`${first === second ? '  ok' : 'FAIL'}  replay determinism`);
if (first !== second || failures > 0) {
  console.error(`${failures + (first === second ? 0 : 1)} failures`);
  process.exit(1);
}
console.log('golden fixtures: 全部通过');
