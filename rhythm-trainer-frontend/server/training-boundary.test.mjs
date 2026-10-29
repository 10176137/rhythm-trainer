import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
function imports(file) {
  return [...readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]);
}
describe('training architecture boundary', () => {
  it('keeps server runtime modules outside the browser import graph', () => {
    const client = files(path.join(ROOT, 'src')).filter((file) => /\.(?:ts|tsx|mjs)$/.test(file) && !file.includes(`${path.sep}dev${path.sep}`) && !file.includes('.test.'));
    for (const file of client) for (const specifier of imports(file).filter((value) => value.startsWith('.'))) {
      expect(path.resolve(path.dirname(file), specifier).startsWith(path.join(ROOT, 'server') + path.sep), `${file}: ${specifier}`).toBe(false);
    }
  });
  it('keeps authoritative generators on Node and independent of React/display modules', () => {
    const serverFiles = [path.join(ROOT, 'server', 'training-service.mjs'), ...files(path.join(ROOT, 'server', 'training')).filter((file) => file.endsWith('.mjs'))];
    for (const file of serverFiles) for (const specifier of imports(file)) {
      expect(specifier === 'react' || specifier === 'opensheetmusicdisplay').toBe(false);
      if (specifier.startsWith('.')) expect(path.resolve(path.dirname(file), specifier).startsWith(path.join(ROOT, 'src') + path.sep)).toBe(false);
    }
    for (const old of ['practice/skillDrills.ts', 'practice/fundamentalDrills.ts', 'practice/skillDrillCatalog.ts', 'reading/readingGenerator.ts']) {
      expect(existsSync(path.join(ROOT, 'src', 'features', old))).toBe(false);
    }
  });
});
