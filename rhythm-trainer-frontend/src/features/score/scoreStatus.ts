import { SCORE_ENGINE_VERSION, type ImportIssue, type ImportReport, type ImportStatus } from '../../score-engine/domain/types';
import type { ScoreLibraryEntry } from './scoreLibrary';

export type ScoreDisplayStatus =
  | 'READY'
  | 'WARNINGS'
  | 'RESTRICTED'
  | 'FAILED'
  | 'UNVERIFIED'
  | 'STALE'
  | 'MISSING';

export interface StoredImportSummary {
  status: ImportStatus;
  strictAllowed: boolean;
  parserVersion: string;
  supportProfileVersion: string;
  fingerprint: string;
  counts: {
    noteCount: number;
    measureCount: number;
    partCount: number;
    warningCount: number;
    errorCount: number;
  };
  topIssues: Array<{
    code: string;
    severity: 'info' | 'warning' | 'error';
    message: string;
    measureOrdinal?: number;
  }>;
  importedAtIso: string;
}

export const SCORE_DISPLAY_STATUS_LABEL: Record<ScoreDisplayStatus, string> = {
  READY: '可练习',
  WARNINGS: '可练习 · 有警告',
  RESTRICTED: '可阅读 · 练习受限',
  FAILED: '导入失败',
  UNVERIFIED: '待校验',
  STALE: '需重新校验',
  MISSING: '文件缺失',
};

const STATUS_MAP: Record<ImportStatus, ScoreDisplayStatus> = {
  READY: 'READY',
  READY_WITH_WARNINGS: 'WARNINGS',
  DISPLAY_ONLY: 'RESTRICTED',
  REJECTED: 'FAILED',
};

export function displayStatusForImportStatus(status: ImportStatus): ScoreDisplayStatus {
  return STATUS_MAP[status] ?? 'UNVERIFIED';
}

export function summarizeImportReport(report: ImportReport): StoredImportSummary {
  const topIssues = report.issues.slice(0, 20).map((issue: ImportIssue) => ({
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    ...(issue.measureOrdinal != null ? { measureOrdinal: issue.measureOrdinal } : {}),
  }));
  return {
    status: report.status,
    strictAllowed: report.strictAllowed,
    parserVersion: report.parserVersion,
    supportProfileVersion: report.supportProfileVersion,
    fingerprint: report.fingerprint,
    counts: {
      noteCount: report.counts.noteCount,
      measureCount: report.counts.measureCount,
      partCount: report.counts.partCount,
      warningCount: report.counts.warningCount,
      errorCount: report.counts.errorCount,
    },
    topIssues,
    importedAtIso: new Date().toISOString(),
  };
}

export function displayStatusForEntry(
  entry: Pick<ScoreLibraryEntry, 'fileMissing' | 'importStatus' | 'importReportSummary' | 'parserVersion'>,
  currentParserVersion = SCORE_ENGINE_VERSION,
): ScoreDisplayStatus {
  if (entry.fileMissing) return 'MISSING';
  if (!entry.importStatus || !entry.importReportSummary) return 'UNVERIFIED';
  if (!(entry.importStatus in STATUS_MAP)) return 'UNVERIFIED';
  if (entry.parserVersion && entry.parserVersion !== currentParserVersion) return 'STALE';
  return STATUS_MAP[entry.importStatus as ImportStatus];
}

export function canPracticeWithReport(report: ImportReport | undefined): boolean {
  return Boolean(report && report.status !== 'REJECTED' && report.strictAllowed);
}

export function canPracticeWithEntry(entry: Pick<ScoreLibraryEntry, 'fileMissing' | 'importStatus' | 'importReportSummary' | 'parserVersion'>): boolean {
  const status = displayStatusForEntry(entry);
  return (status === 'READY' || status === 'WARNINGS') && Boolean(entry.importReportSummary?.strictAllowed);
}
