import type { ImportReport } from '../../score-engine/domain/types';
import { importMusicXml } from '../../score-engine/import/musicxml-importer';
import { toLegacyScoreDocument } from '../../score-engine/legacy-bridge';
import type { ScoreDocument } from '../../core/sampleScore';

export interface ScoreImportResult {
  doc?: ScoreDocument;
  report: ImportReport;
  xml: string;
  fileName: string;
}

/**
 * One parsed result for the import preview, the library and the reader. The
 * semantic importer stays the only parse authority; the legacy document is
 * only the existing React view model.
 */
export function importScoreText(xml: string, fileName: string): ScoreImportResult {
  const result = importMusicXml(xml, { fileName });
  const doc = result.scoreDocument
    ? {
      ...toLegacyScoreDocument(result.scoreDocument, result.importReport, fileName, 'imported'),
      sourceXml: xml,
    }
    : undefined;
  return {
    doc,
    report: result.importReport,
    xml,
    fileName,
  };
}
