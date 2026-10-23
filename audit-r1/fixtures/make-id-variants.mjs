// Generates the note@id variants used by the OSMD anchor spike.
// Deterministic: ids are assigned in MusicXML document order (n1..nN).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cases = ['g1_single_voice', 'g2_chord', 'g3_tie_across_bar'];

for (const name of cases) {
  const src = readFileSync(join(dir, `${name}.musicxml`), 'utf8');
  let index = 0;
  const out = src.replace(/<note>/g, () => `<note id="n${++index}">`);
  writeFileSync(join(dir, `${name}.ids.musicxml`), out);
  console.log(`${name}.ids.musicxml: ${index} note ids`);
}
