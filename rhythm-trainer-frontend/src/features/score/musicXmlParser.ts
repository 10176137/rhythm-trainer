import type { ScoreDocument } from '../../core/sampleScore';
import { importMusicXml } from '../../score-engine/import/musicxml-importer';
import { toLegacyScoreDocument } from '../../score-engine/legacy-bridge';

export class ScoreImportError extends Error {
  constructor(
    message: string,
    readonly code = 'score_import_failed',
    readonly issues: readonly { code: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ScoreImportError';
  }
}

/**
 * Compatibility entry point for the existing React view model. Parsing and
 * strict-support decisions are delegated to the independent score-engine; this
 * function only maps the semantic document into the current display model.
 */
export function parseMusicXml(xml: string, fileName = 'imported.musicxml'): ScoreDocument {
  const result = importMusicXml(xml, { fileName });
  if (!result.scoreDocument) {
    const issues = result.importReport.issues.map((issue) => ({ code: issue.code, message: issue.message }));
    const message = issues.length ? issues.map((issue) => issue.message).join('；') : 'MusicXML 导入失败';
    throw new ScoreImportError(message, result.importReport.issues[0]?.code ?? 'score_import_failed', issues);
  }
  return {
    ...toLegacyScoreDocument(result.scoreDocument, result.importReport, fileName, 'imported'),
    sourceXml: xml,
  };
}
