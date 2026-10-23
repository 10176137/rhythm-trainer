// OSMD 2.2.1 anchor spike — runs in a real Chromium page against the locked
// package version served from the frontend's node_modules. Produces structured
// JSON on window.__SPIKE__ (no screenshot judgement).
const OSMD = window.opensheetmusicdisplay.OpenSheetMusicDisplay;

const CASES = [
  { name: 'g1-no-ids', file: 'g1_single_voice.musicxml', ids: [] },
  { name: 'g1-ids', file: 'g1_single_voice.ids.musicxml', ids: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'] },
  { name: 'g2-no-ids', file: 'g2_chord.musicxml', ids: [] },
  { name: 'g2-ids', file: 'g2_chord.ids.musicxml', ids: ['n1', 'n2', 'n3', 'n4', 'n5'] },
  { name: 'g3-no-ids', file: 'g3_tie_across_bar.musicxml', ids: [] },
  { name: 'g3-ids', file: 'g3_tie_across_bar.ids.musicxml', ids: ['n1', 'n2'] },
  { name: 'g4-triplet', file: 'g4_triplet.musicxml', ids: [] },
  { name: 'g6-unison', file: 'g6_unison_two_staves.musicxml', ids: [] },
  { name: 'g7-hidden-grace', file: 'g7_hidden_grace.musicxml', ids: ['h1', 'h2', 'h3', 'h4', 'h5'] },
  { name: 'g8-key-alter', file: 'g8_key_alter.musicxml', ids: ['k1', 'k2', 'k3', 'k4'] },
];

// Hand-derived expected per-note identity, in MusicXML document order.
// [measureIndex(0-based), staffIndex(0-based), voiceId, onsetQuarterBeats
//  RELATIVE TO THE MEASURE START, midi]
const EXPECTED = {
  'g1-no-ids': [[0, 0, 1, 0, 60], [0, 0, 1, 1, 62], [0, 0, 1, 2, 64], [0, 0, 1, 3, 65], [1, 0, 1, 0, 67], [1, 0, 1, 2, null]],
  'g1-ids': [[0, 0, 1, 0, 60], [0, 0, 1, 1, 62], [0, 0, 1, 2, 64], [0, 0, 1, 3, 65], [1, 0, 1, 0, 67], [1, 0, 1, 2, null]],
  'g2-no-ids': [[0, 0, 1, 0, 60], [0, 0, 1, 0, 64], [0, 0, 1, 0, 67], [0, 0, 1, 1, 60], [0, 0, 1, 2, null]],
  'g2-ids': [[0, 0, 1, 0, 60], [0, 0, 1, 0, 64], [0, 0, 1, 0, 67], [0, 0, 1, 1, 60], [0, 0, 1, 2, null]],
  'g3-no-ids': [[0, 0, 1, 0, 60], [1, 0, 1, 0, 60]],
  'g3-ids': [[0, 0, 1, 0, 60], [1, 0, 1, 0, 60]],
  'g4-triplet': [[0, 0, 1, 0, 60], [0, 0, 1, 1 / 3, 62], [0, 0, 1, 2 / 3, 64], [0, 0, 1, 1, 67], [0, 0, 1, 2, null]],
  'g6-unison': [[0, 0, 1, 0, 60], [0, 1, 1, 0, 60]],
  'g7-hidden-grace': [[0, 0, 1, 0, 60], [0, 0, 1, 1, 62], [0, 0, 1, 2, 64], [0, 0, 1, 2, 65], [0, 0, 1, 3, 67]],
  // Key signature 1 sharp; k1 has no <alter>, k2 has alter=1, k3 natural.
  // Expected per MusicXML: sounding pitches are 65, 66, 65 — OSMD may apply the
  // key signature to k1, which is exactly what this row measures.
  'g8-key-alter': [[0, 0, 1, 0, 65], [0, 0, 1, 1, 66], [0, 0, 1, 2, 65]],
};

function tryGet(object, name) {
  try { return object?.[name]; } catch (error) { return undefined; }
}

/** Calls a prototype method with the correct receiver (unbound calls lose `this`). */
function callMethod(object, name, ...args) {
  if (!object) return undefined;
  try {
    const fn = object[name];
    return typeof fn === 'function' ? fn.apply(object, args) : undefined;
  } catch (error) {
    return undefined;
  }
}

function readFraction(value) {
  if (!value) return null;
  const real = tryGet(value, 'RealValue');
  return typeof real === 'number' && Number.isFinite(real) ? real : null;
}

/** Bounded scan for a string value containing any expected id. */
function scanForIds(root, expectedIds, maxDepth = 3) {
  const hits = [];
  if (!expectedIds.length) return hits;
  const seen = new WeakSet();
  const walk = (value, path, depth) => {
    if (value == null || depth > maxDepth) return;
    if (typeof value === 'string') {
      for (const id of expectedIds) {
        if (value === id || (value.includes(id) && value.length < 120)) hits.push({ id, path, value });
      }
      return;
    }
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    const names = (() => { try { return Object.getOwnPropertyNames(value); } catch { return []; } })();
    for (const name of names) {
      if (/^(rules|graphicalMusicSheet|parent|ParentVoiceEntry|ParentStaffEntry|ParentMusicSystem)$/.test(name) && depth > 0) continue;
      walk(tryGet(value, name), `${path}.${name}`, depth + 1);
    }
    if (Array.isArray(value)) {
      value.slice(0, 30).forEach((entry, index) => walk(entry, `${path}[${index}]`, depth + 1));
    }
  };
  walk(root, '$', 0);
  return hits;
}

function collectNotes(osmd) {
  const out = [];
  const sourceMeasures = osmd.Sheet?.SourceMeasures ?? [];
  sourceMeasures.forEach((measure, measureIndex) => {
    for (const vertical of measure.VerticalSourceStaffEntryContainers ?? []) {
      const staffEntries = vertical.StaffEntries ?? [];
      staffEntries.forEach((staffEntry, stackIndex) => {
        const staffId = tryGet(tryGet(staffEntry, 'ParentStaff'), 'Id');
        for (const voiceEntry of staffEntry.VoiceEntries ?? []) {
          const voiceId = Number(tryGet(tryGet(voiceEntry, 'ParentVoice'), 'VoiceId') ?? 1);
          const timestamp = readFraction(tryGet(voiceEntry, 'Timestamp'));
          for (const note of voiceEntry.Notes ?? []) {
            const pitch = tryGet(note, 'Pitch');
            const halfTone = Number(tryGet(note, 'halfTone'));
              const absolute = readFraction(callMethod(note, 'getAbsoluteTimestamp'));
            let graphical = null;
            let graphicalError = null;
            try { graphical = osmd.rules.GNote(note); } catch (error) { graphicalError = String(error?.message ?? error); }
            const vf = graphical ? tryGet(graphical, 'vfnote') : null;
            const vfNote = Array.isArray(vf) ? vf[0] : null;
            const vfAttrs = vfNote ? tryGet(vfNote, 'attrs') : null;
            out.push({
              measureIndex,
              measureNumber: tryGet(measure, 'MeasureNumber'),
              stackIndex,
              staffId: staffId ?? null,
              voiceId,
              timestamp,
              absolute,
              halfTone: Number.isFinite(halfTone) ? halfTone + 12 : null,
              rawHalfTone: Number.isFinite(halfTone) ? halfTone : null,
              pitchShort: (() => {
                if (!pitch) return null;
                return callMethod(pitch, 'ToStringShort') ?? null;
              })(),
              isRest: callMethod(note, 'isRest') ?? null,
              noteType: tryGet(note, 'NoteTypeXml') ?? null,
              isGrace: tryGet(note, 'IsGraceNote') ?? null,
              hidden: tryGet(note, 'IsRest') === undefined ? null : null,
              printObject: tryGet(note, 'printObject') ?? null,
              isCueNote: tryGet(note, 'isCueNote') ?? null,
              ownPropNames: (() => { try { return Object.getOwnPropertyNames(note).filter((name) => /id/i.test(name)); } catch { return []; } })(),
              hasGetSVGId: typeof tryGet(note, 'getSVGId') === 'function',
              graphicalClass: graphical ? graphical.constructor?.name ?? null : null,
              graphicalHasGetSVGId: graphical ? typeof tryGet(graphical, 'getSVGId') === 'function' : false,
              vfSvgId: vfAttrs ? (tryGet(vfAttrs, 'id') ?? null) : null,
              vfAttrId: callMethod(vfNote, 'getAttribute', 'id') ?? null,
              graphicalError,
              parentTie: Boolean(tryGet(note, 'NoteTie')),
              tieStart: Boolean(tryGet(tryGet(note, 'NoteTie'), 'StartNote') === note),
              tieStop: Boolean(tryGet(tryGet(note, 'NoteTie'), 'EndNote') === note),
            });
          }
        }
      });
    }
  });
  return out;
}

function bucketStats(notes, keyFn) {
  const buckets = new Map();
  for (const note of notes) {
    const key = keyFn(note);
    if (key == null) continue;
    const list = buckets.get(key);
    if (list) list.push(note);
    else buckets.set(key, [note]);
  }
  let maxBucket = 0;
  let collisions = 0;
  for (const list of buckets.values()) {
    if (list.length > 1) collisions += 1;
    maxBucket = Math.max(maxBucket, list.length);
  }
  return { keyCount: buckets.size, maxBucket, collidingKeys: collisions };
}

/** Maps expected notes to OSMD notes using a key, then verifies one-to-one. */
function evaluateMapping(expected, notes, keyFn, ordinalOf) {
  const buckets = new Map();
  for (const note of notes) {
    const key = keyFn(note);
    if (key == null) continue;
    const list = buckets.get(key);
    if (list) list.push(note);
    else buckets.set(key, [note]);
  }
  let mapped = 0;
  const unmapped = [];
  const orderAssumed = [];
  const used = new Set();
  expected.forEach((entry, index) => {
    const [measureIndex, staffIndex, voiceId, onset, midi] = entry;
    const key = keyFn({ measureIndex, staffIndex, voiceId, onset, midi, ordinal: ordinalOf ? ordinalOf.get(entry) : undefined });
    const bucket = buckets.get(key) ?? [];
    const next = bucket.find((note) => !used.has(note));
    if (!next) { unmapped.push(index); return; }
    used.add(next);
    mapped += 1;
    if (bucket.length > 1) orderAssumed.push(index);
  });
  const extra = notes.filter((note) => !used.has(note)).length;
  return { mapped, total: expected.length, unmapped, orderAssumed, extraOsmdNotes: extra };
}

async function runCase(testCase) {
  const container = document.createElement('div');
  container.className = 'case';
  container.id = `case-${testCase.name}`;
  const title = document.createElement('h2');
  title.textContent = `${testCase.name} (${testCase.file})`;
  container.append(title);
  document.getElementById('root').append(container);

  const xml = await (await fetch(`/fixtures/${testCase.file}`)).text();
  const osmd = new OSMD(container, {
    autoResize: false, drawCredits: false, drawTitle: false, drawComposer: false,
    drawMeasureNumbers: false, drawPartNames: false, backend: 'svg',
  });
  const result = { name: testCase.name, file: testCase.file };
  try {
    await osmd.load(xml);
    osmd.Zoom = 0.7;
    osmd.render();
  } catch (error) {
    result.loadError = String(error?.stack ?? error);
    return result;
  }

  const notes = collectNotes(osmd);
  // Raw OSMD Note objects, in the same order as the metadata rows. Kept
  // outside the reported JSON because they form a cyclic object graph.
  const rawNotes = osmd.Sheet?.SourceMeasures?.flatMap((measure) =>
    (measure.VerticalSourceStaffEntryContainers ?? []).flatMap((vertical) =>
      (vertical.StaffEntries ?? []).flatMap((staffEntry) =>
        (staffEntry.VoiceEntries ?? []).flatMap((voiceEntry) => voiceEntry.Notes ?? [])))) ?? [];
  result.osmdNoteCount = notes.length;
  result.osmdVersion = window.opensheetmusicdisplay?.__version__ ?? null;

  // --- 1. Is the XML id reachable anywhere in the OSMD object graph? ---
  result.idReachability = testCase.ids.map((id) => {
    const hits = [];
    for (const note of notes) {
      // scan a small neighbourhood: the Note object and its direct parents
      const neighbours = [
        ['note', note],
      ];
      for (const [label, value] of neighbours) {
        for (const hit of scanForIds(value, [id], 3)) hits.push({ label, ...hit });
      }
    }
    // Also scan the raw XML-facing objects OSMD keeps (SourceMeasure etc.)
    for (let index = 0; index < (osmd.Sheet?.SourceMeasures?.length ?? 0); index += 1) {
      for (const hit of scanForIds(osmd.Sheet.SourceMeasures[index], [id], 3)) hits.push({ label: `SourceMeasure[${index}]`, ...hit });
    }
    return { id, hitCount: hits.length, hits: hits.slice(0, 6) };
  });
  result.idHitsTotal = result.idReachability.reduce((sum, entry) => sum + entry.hitCount, 0);

  // --- 2. DOM ---
  const idElements = Array.from(container.querySelectorAll('[id]')).map((element) => element.getAttribute('id'));
  result.dom = {
    // Exact attribute match only: innerHTML substring hits are not evidence
    // ("h2" matches the <h2> tag name, not an id).
    idPresentAsElementId: testCase.ids.filter((id) => idElements.includes(id)),
    idQuerySelectorHits: testCase.ids.filter((id) => container.querySelectorAll(`[id="${id}"]`).length > 0),
    elementIdCount: idElements.length,
    elementIdSample: idElements.slice(0, 12),
    statusElementCount: container.querySelectorAll('.vf-stavenote').length,
    noteheadCount: container.querySelectorAll('.vf-notehead').length,
    svgCount: container.querySelectorAll('svg').length,
  };

  // --- 3. Structural identity available from the public object model ---
  result.samples = notes.map((note) => ({
    measureIndex: note.measureIndex,
    measureNumber: note.measureNumber,
    stackIndex: note.stackIndex,
    staffId: note.staffId,
    voiceId: note.voiceId,
    timestampWhole: note.timestamp,
    timestampQuarters: note.timestamp == null ? null : note.timestamp * 4,
    absoluteQuarters: note.absolute == null ? null : note.absolute * 4,
    midi: note.halfTone,
    pitchShort: note.pitchShort,
    isRest: note.isRest,
    noteType: note.noteType,
    isGrace: note.isGrace,
    isCue: note.isCueNote,
    printObject: note.printObject,
    idLikeOwnProps: note.ownPropNames,
    graphicalClass: note.graphicalClass,
    hasGetSVGIdNote: note.hasGetSVGId,
    hasGetSVGIdGraphical: note.graphicalHasGetSVGId,
    vfSvgId: note.vfSvgId,
    vfAttrId: note.vfAttrId,
    parentTie: note.parentTie,
    tieStart: note.tieStart,
    tieStop: note.tieStop,
  }));

  // --- 4. Candidate key collision statistics (pitched notes only) ---
  // Rests carry no pitch; the shipped adapter also skips kind==='rest'.
  const expected = (EXPECTED[testCase.name] ?? []).filter((entry) => entry[4] != null);
  // OSMD rests also expose a halfTone (observed 12), so rest detection must use
  // isRest(), never the presence of a halfTone value.
  const pitchedNotes = notes.filter((note) => note.isRest !== true);
  // OSMD notes expose `stackIndex`; expected rows use `staffIndex`.
  const norm = (n) => ({
    measureIndex: n.measureIndex,
    staffIndex: n.staffIndex ?? n.stackIndex,
    voiceId: n.voiceId,
    onset: n.onset ?? (n.timestamp == null ? null : n.timestamp * 4),
    // raw OSMD notes carry `halfTone`, expected rows carry `midi`
    midi: n.midi ?? n.halfTone ?? null,
  });
  const normalizedNotes = pitchedNotes.map(norm);
  // Document-order index inside (measure, staff, voice): the only fallback that
  // does not use pitch or onset at all.
  const noteOrdinals = new Map();
  {
    const counters = new Map();
    for (const entry of normalizedNotes) {
      const base = `${entry.measureIndex}:${entry.staffIndex}:${entry.voiceId}`;
      const index = counters.get(base) ?? 0;
      counters.set(base, index + 1);
      noteOrdinals.set(entry, index);
      entry.ordinal = index;
    }
  }
  const expectedOrdinals = new Map();
  {
    const counters = new Map();
    for (const entry of expected) {
      const base = `${entry[0]}:${entry[1]}:${entry[2]}`;
      const index = counters.get(base) ?? 0;
      counters.set(base, index + 1);
      expectedOrdinals.set(entry, index);
    }
  }
  result.pitchedNoteCount = pitchedNotes.length;
  result.candidates = {
    // The adapter shipped in src/score-engine/view/score-view-adapter.ts.
    adapterKey: bucketStats(normalizedNotes, (entry) => `${entry.measureIndex}:${entry.staffIndex}:${entry.voiceId}:${entry.midi}`),
    onsetKey: bucketStats(normalizedNotes, (entry) => entry.onset == null ? null : `${entry.measureIndex}:${entry.staffIndex}:${entry.voiceId}:${entry.onset.toFixed(6)}:${entry.midi}`),
    ordinalKey: bucketStats(normalizedNotes, (entry) => `${entry.measureIndex}:${entry.staffIndex}:${entry.voiceId}:${noteOrdinals.get(entry)}`),
  };
  result.mappingQuality = {
    adapterKey: evaluateMapping(expected, normalizedNotes, (entry, raw) => `${entry.measureIndex}:${entry.staffIndex}:${entry.voiceId}:${entry.midi}`),
    onsetKey: evaluateMapping(expected, normalizedNotes, (entry) => entry.onset == null ? null : `${entry.measureIndex}:${entry.staffIndex}:${entry.voiceId}:${entry.onset.toFixed(6)}:${entry.midi}`),
    ordinalKey: evaluateMapping(expected, normalizedNotes, (entry) => `${entry.measureIndex}:${entry.staffIndex}:${entry.voiceId}:${entry.ordinal}`, expectedOrdinals),
  };

  // --- 5. Would the shipped adapter claim a pass, and is the identity sound? ---
  const adapter = result.candidates.adapterKey;
  const adapterMapping = result.mappingQuality.adapterKey;
  result.adapterVerdict = {
    // What src/score-engine/view/score-view-adapter.ts + mappingSummary would report:
    // mappedEventCount === noteEventCount && duplicates === 0.
    shippedCheckPasses: adapterMapping.mapped === expected.length && adapterMapping.extraOsmdNotes === 0,
    // What identity actually requires: every pitched note has its own key.
    identityUnambiguous: adapter.collidingKeys === 0 && adapter.maxBucket <= 1,
    ambiguousEvents: adapter.collidingKeys,
  };

  // --- 6. Per-note highlight granularity (chord glyph sharing) ---
  if (testCase.name.startsWith('g2')) {
    const firstRawNote = rawNotes.find((note) => !callMethod(note, 'isRest'));
    let colorError = null;
    let graphicalResolved = false;
    try {
      const graphical = osmd.rules.GNote(firstRawNote);
      graphicalResolved = Boolean(graphical);
      graphical?.setColor('#ff0000', { applyToNoteheads: true, applyToStem: true, applyToBeams: true, applyToTies: true, applyToLedgerLines: true });
    } catch (error) {
      colorError = String(error?.message ?? error);
    }
    const noteheadPaths = Array.from(container.querySelectorAll('.vf-notehead path'));
    const stemPaths = Array.from(container.querySelectorAll('.vf-stem path'));
    result.highlightProbe = {
      targetedNote: { midi: Number(tryGet(firstRawNote, 'halfTone')) + 12, onset: readFraction(tryGet(tryGet(firstRawNote, 'ParentVoiceEntry'), 'Timestamp')) },
      graphicalResolved,
      noteheadPaths: noteheadPaths.length,
      noteheadsColoredRed: noteheadPaths.filter((path) => path.getAttribute('fill') === '#ff0000').length,
      stemsColoredRed: stemPaths.filter((path) => path.getAttribute('stroke') === '#ff0000').length,
      colorError,
      interpretable: graphicalResolved && noteheadPaths.length > 0,
    };
  }

  return result;
}

async function main() {
  const results = [];
  let error = null;
  try {
    for (const testCase of CASES) {
      results.push(await runCase(testCase));
    }
  } catch (caught) {
    error = String(caught?.stack ?? caught);
  }
  window.__SPIKE__ = {
    complete: true,
    osmdVersionFromPackage: '2.2.1',
    userAgent: navigator.userAgent,
    cases: results,
    error,
  };
  document.body.dataset.spike = 'complete';
  try {
    await fetch('/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(window.__SPIKE__),
    });
  } catch (postError) {
    window.__SPIKE__.postError = String(postError);
  }
}

main();
