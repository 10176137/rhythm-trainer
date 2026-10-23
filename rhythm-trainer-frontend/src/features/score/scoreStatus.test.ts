import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importMusicXml } from '../../score-engine/import/musicxml-importer';
import {
  canPracticeWithEntry,
  canPracticeWithReport,
  displayStatusForEntry,
  displayStatusForImportStatus,
  summarizeImportReport,
  type ScoreDisplayStatus,
} from './scoreStatus';
import type { ScoreLibraryEntry } from './scoreLibrary';

const fixture = (name: string) =>
  readFileSync(new URL(`../../score-engine/test/fixtures/${name}`, import.meta.url), 'utf8');

function reportFor(name: string) {
  const result = importMusicXml(fixture(name), { fileName: name });
  return result.importReport;
}

function entry(overrides: Partial<ScoreLibraryEntry> = {}): ScoreLibraryEntry {
  return {
    id: 'score-test',
    name: 'Test',
    fileName: 'test.musicxml',
    size: 100,
    savedAtIso: '2026-10-22T00:00:00.000Z',
    updatedAtIso: '2026-10-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('score library import status', () => {
  it('maps valid, warning/restricted and rejected reports without inventing readiness', () => {
    const valid = reportFor('piano-two-staff-basic.musicxml');
    expect(canPracticeWithReport(valid)).toBe(true);
    expect(displayStatusForImportStatus(valid.status)).toBe('READY');

    const restricted = reportFor('unsupported-repeat-tempo-curve.musicxml');
    expect(restricted.status).toBe('DISPLAY_ONLY');
    expect(displayStatusForImportStatus(restricted.status)).toBe('RESTRICTED');
    expect(canPracticeWithReport(restricted)).toBe(false);

    const rejected = reportFor('malformed.musicxml');
    expect(rejected.status).toBe('REJECTED');
    expect(displayStatusForImportStatus(rejected.status)).toBe('FAILED');
    expect(canPracticeWithReport(rejected)).toBe(false);
  });

  it('stores a bounded summary rather than the note tree', () => {
    const summary = summarizeImportReport(reportFor('piano-two-staff-basic.musicxml'));
    expect(summary.counts.noteCount).toBeGreaterThan(0);
    expect(summary.topIssues.length).toBeLessThanOrEqual(20);
    expect(summary).not.toHaveProperty('notes');
    expect(summary.parserVersion).toBeTruthy();
    expect(summary.fingerprint).toHaveLength(64);
  });

  it('marks old/stale/missing records without pretending they are READY', () => {
    const summary = summarizeImportReport(reportFor('piano-two-staff-basic.musicxml'));
    const statuses: ScoreDisplayStatus[] = [
      displayStatusForEntry(entry()),
      displayStatusForEntry(entry({ importStatus: summary.status, importReportSummary: summary, parserVersion: summary.parserVersion })),
      displayStatusForEntry(entry({ importStatus: summary.status, importReportSummary: summary, parserVersion: '0.0.0' })),
      displayStatusForEntry(entry({ fileMissing: true })),
    ];
    expect(statuses).toEqual(['UNVERIFIED', 'READY', 'STALE', 'MISSING']);
    expect(canPracticeWithEntry(entry())).toBe(false);
    expect(canPracticeWithEntry(entry({ importStatus: 'READY', importReportSummary: summary, parserVersion: summary.parserVersion }))).toBe(true);
  });
});
