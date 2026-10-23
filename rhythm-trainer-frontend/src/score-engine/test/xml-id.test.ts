import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importMusicXml } from '../import/musicxml-importer';

const FIXTURE_ROOT = new URL('../../../../audit-r1/fixtures/', import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_ROOT), 'utf8');
}

describe('MusicXML note@id validation', () => {
  it('keeps a score without ids fully usable', () => {
    const result = importMusicXml(fixture('g1_single_voice.musicxml'), { fileName: 'g1_single_voice.musicxml' });
    expect(result.importReport.status).toBe('READY');
    expect(result.importReport.strictAllowed).toBe(true);
    expect(result.importReport.issues.map((issue) => issue.code)).not.toContain('duplicate_xml_id');
    const events = result.scoreDocument!.parts[0].measures[0].events;
    expect(events.every((event) => event.source.xmlId === undefined)).toBe(true);
  });

  it('accepts unique ids and preserves them on the source reference', () => {
    const result = importMusicXml(fixture('g1_single_voice.ids.musicxml'), { fileName: 'g1_single_voice.ids.musicxml' });
    expect(result.importReport.status).toBe('READY');
    expect(result.importReport.strictAllowed).toBe(true);
    expect(result.importReport.issues.map((issue) => issue.code)).not.toContain('duplicate_xml_id');
    const xmlIds = result.scoreDocument!.parts[0].measures
      .flatMap((measure) => measure.events)
      .map((event) => event.source.xmlId);
    expect(xmlIds).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
  });

  it('fails closed on duplicate ids with a stable machine code and conflict context', () => {
    const result = importMusicXml(
      fixture('negative/duplicate-note-id.musicxml'),
      { fileName: 'duplicate-note-id.musicxml' },
    );
    expect(result.importReport.status).toBe('DISPLAY_ONLY');
    expect(result.importReport.strictAllowed).toBe(false);

    const duplicates = result.importReport.issues.filter((issue) => issue.code === 'duplicate_xml_id');
    expect(duplicates).toHaveLength(1);
    const issue = duplicates[0];
    expect(issue.severity).toBe('warning');
    expect(issue.blocksStrict).toBe(true);
    expect(issue.xmlId).toBe('dup');
    expect(issue.measureOrdinal).toBe(1);
    expect(issue.eventId).toBe(`${result.importReport.fingerprint.slice(0, 16)}:P1:m1:e2`);
    // The first occurrence is not reported; the conflict names both locations.
    expect(issue.message).toContain('第 1 小节');
    expect(issue.message).toContain('dup');

    // The document is still available for display; only strict timing is blocked.
    expect(result.scoreDocument).toBeDefined();
    const events = result.scoreDocument!.parts[0].measures
      .flatMap((measure) => measure.events);
    expect(events.map((event) => event.source.xmlId)).toEqual(['dup', 'dup', 'unique']);
  });

  it('treats a whitespace-only id as absent', () => {
    const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note id="   "><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`;
    const result = importMusicXml(xml, { fileName: 'blank-id.musicxml' });
    expect(result.importReport.status).toBe('READY');
    expect(result.scoreDocument!.parts[0].measures[0].events[0].source.xmlId).toBeUndefined();
  });
});
