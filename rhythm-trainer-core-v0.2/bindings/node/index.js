'use strict';

// The N-API CLI emits a platform-specific binary and would like to overwrite
// this file with a generated loader that assumes npm optional-dependency
// platform packages. This repo distributes the addon as local files instead,
// so this loader is hand-maintained; build scripts pass `--js false` to keep
// the CLI from clobbering it.
const path = require('node:path');
const fs = require('node:fs');
const stem = 'rhythm_trainer_native';
const candidates = [
  `${stem}.${process.platform}-${process.arch}-msvc.node`,
  `${stem}.${process.platform}-${process.arch}-gnu.node`,
  `${stem}.${process.platform}-${process.arch}.node`,
  `${stem}.node`
];

let lastError;
for (const candidate of candidates) {
  const fullPath = path.join(__dirname, candidate);
  if (!fs.existsSync(fullPath)) continue;
  try {
    module.exports = require(fullPath);
    return;
  } catch (error) {
    lastError = error;
  }
}

throw new Error(
  `Rhythm Trainer native addon not found for ${process.platform}-${process.arch}. ` +
  `Run "npm install && npm run build" in bindings/node. ` +
  (lastError ? `Last load error: ${lastError.message}` : '')
);
