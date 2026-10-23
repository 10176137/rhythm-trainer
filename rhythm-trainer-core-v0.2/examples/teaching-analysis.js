// Example API shape for v0.2. Requires the native addon to be built first.
// This sample uses synthetic judgments; it is not real performance evidence.
// Field names are camelCase to match the napi-rs generated index.d.ts contract.
const { analyzeTiming } = require('../bindings/node');

const judgments = Array.from({ length: 12 }, (_, index) => ({
  grade: 'good',
  targetId: `example:target:${index}`,
  targetIndex: index,
  strikeSeq: index + 1,
  errorMs: 35,
  expectedAtMs: 1000 + index * 500,
  actualAtMs: 1035 + index * 500,
  bar: Math.floor(index / 4) + 1,
  beat: (index % 4) + 1,
}));

const result = analyzeTiming(judgments, {
  measurementTrustworthy: true,
  restReentryTargetIds: [],
  offbeatTargetIds: [],
}, 80);

console.dir(result, { depth: null });
