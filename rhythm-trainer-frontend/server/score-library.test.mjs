import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_SCORE_XML_BYTES,
  ScoreLibrary,
  ScoreLibraryError,
  normalizeScoreName,
} from './score-library.mjs';

const XML_A = '<?xml version="1.0"?><score-partwise version="4.0"><part-list/></score-partwise>';
const XML_B = '<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"/></part-list></score-partwise>';

let dir;
let library;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-scores-'));
  library = new ScoreLibrary({ dir });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ScoreLibrary CRUD', () => {
  it('creates, lists by name, and reads the raw XML', () => {
    const b = library.create({ name: 'B 练习曲', fileName: 'b.musicxml', xml: XML_B });
    const a = library.create({ name: 'A 练习曲', fileName: 'a.musicxml', xml: XML_A });

    const list = library.list();
    expect(list.map((entry) => entry.name)).toEqual(['A 练习曲', 'B 练习曲']);
    expect(list[0]).not.toHaveProperty('xml');
    expect(list.find((entry) => entry.id === b.id)?.size).toBe(Buffer.byteLength(XML_B, 'utf8'));

    const loaded = library.get(a.id);
    expect(loaded.name).toBe('A 练习曲');
    expect(loaded.fileName).toBe('a.musicxml');
    expect(loaded.xml).toBe(XML_A);
  });

  it('renames and replaces XML without changing identity', () => {
    const created = library.create({ name: '初稿', fileName: 'draft.musicxml', xml: XML_A });
    const renamed = library.update(created.id, { name: '  正式   版本  ' });
    expect(renamed.name).toBe('正式 版本');
    expect(renamed.id).toBe(created.id);

    const replaced = library.update(created.id, { xml: XML_B, fileName: 'final.musicxml' });
    expect(replaced.fileName).toBe('final.musicxml');
    expect(replaced.size).toBe(Buffer.byteLength(XML_B, 'utf8'));
    expect(library.get(created.id).xml).toBe(XML_B);
  });

  it('enforces unique names case-insensitively and keeps rename id-stable', () => {
    library.create({ name: 'Sonata', fileName: 'a.musicxml', xml: XML_A });
    expect(() => library.create({ name: ' sonata ', fileName: 'b.musicxml', xml: XML_B }))
      .toThrowError(/已有名为/);
    const other = library.create({ name: 'Etude', fileName: 'c.musicxml', xml: XML_A });
    expect(() => library.update(other.id, { name: 'SONATA' })).toThrowError(/已有名为/);
    expect(library.update(other.id, { name: 'Etude 2' }).id).toBe(other.id);
  });

  it('deletes entries and persists across instances', () => {
    const created = library.create({ name: '持久化', fileName: 'p.musicxml', xml: XML_A });
    const reopened = new ScoreLibrary({ dir });
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.get(created.id).name).toBe('持久化');
    expect(reopened.remove(created.id)).toBe(true);
    expect(reopened.remove(created.id)).toBe(false);
    expect(reopened.list()).toEqual([]);
    expect(fs.existsSync(path.join(dir, `${created.id}.musicxml`))).toBe(false);
  });

  it('validates names, XML and path-safe IDs', () => {
    expect(() => normalizeScoreName('   ')).toThrowError(/不能为空/);
    expect(() => normalizeScoreName('x'.repeat(81))).toThrowError(/不能超过/);
    expect(() => library.create({ name: 'x', fileName: 'x.musicxml', xml: 'not xml' }))
      .toThrowError(/应以 </);
    expect(() => library.create({ name: 'big', fileName: 'big.musicxml', xml: `<x>${'a'.repeat(MAX_SCORE_XML_BYTES)}</x>` }))
      .toThrowError(/不能超过 10 MiB/);
    expect(() => library.get('../escape')).toThrowError(/ID 非法/);
    expect(() => library.get('missing')).not.toThrow();
    expect(library.get('missing')).toBeNull();
    expect(() => library.update('missing', { name: 'x' }))
      .toThrowError(/不存在/);
    expect(() => library.update('missing', { name: 'x' })).toThrow(ScoreLibraryError);
  });
});

describe('ScoreLibrary import summary persistence', () => {
  const summary = {
    status: 'READY_WITH_WARNINGS',
    strictAllowed: true,
    parserVersion: '1.0.0',
    supportProfileVersion: 'musicxml-v1.0',
    fingerprint: 'a'.repeat(64),
    counts: { noteCount: 12, measureCount: 2, partCount: 1, warningCount: 1, errorCount: 0 },
    topIssues: [{ code: 'test_warning', severity: 'warning', message: 'test', measureOrdinal: 2 }],
    importedAtIso: '2026-10-22T00:00:00.000Z',
  };

  it('persists a bounded summary and exposes it in list/get', () => {
    const created = library.create({ name: '摘要', fileName: 's.musicxml', xml: XML_A, importSummary: summary });
    expect(created.importStatus).toBe('READY_WITH_WARNINGS');
    expect(created.parserVersion).toBe('1.0.0');
    const listed = library.list().find((entry) => entry.id === created.id);
    expect(listed.importReportSummary.topIssues).toHaveLength(1);
    expect(listed.fileMissing).toBe(false);
    expect(library.get(created.id).importReportSummary.counts.noteCount).toBe(12);
  });

  it('updates a summary and clears stale status when XML is replaced without a new report', () => {
    const created = library.create({ name: '更新摘要', fileName: 's.musicxml', xml: XML_A, importSummary: summary });
    const updated = library.update(created.id, {
      importSummary: { ...summary, status: 'DISPLAY_ONLY', strictAllowed: false },
    });
    expect(updated.importStatus).toBe('DISPLAY_ONLY');
    const replaced = library.update(created.id, { xml: XML_B });
    expect(replaced.importStatus).toBeUndefined();
    expect(replaced.importReportSummary).toBeUndefined();
  });

  it('keeps old metadata readable and reports missing XML in listings', () => {
    const created = library.create({ name: '旧记录', fileName: 'old.musicxml', xml: XML_A });
    expect(created.importStatus).toBeUndefined();
    expect(library.list()[0].fileMissing).toBe(false);
    fs.unlinkSync(path.join(dir, `${created.id}.musicxml`));
    expect(library.list()[0].fileMissing).toBe(true);
    expect(library.get(created.id)).toBeNull();
    expect(library.invalidCount()).toBe(0);
  });
});

describe('ScoreLibrary metadata diagnostics', () => {
  it('counts unreadable metadata without failing the list', () => {
    library.create({ name: '可用', fileName: 'ok.musicxml', xml: XML_A });
    fs.writeFileSync(path.join(dir, 'broken.meta.json'), '{ not json');
    expect(library.invalidCount()).toBe(1);
    expect(library.list().map((entry) => entry.name)).toEqual(['可用']);
  });
});
