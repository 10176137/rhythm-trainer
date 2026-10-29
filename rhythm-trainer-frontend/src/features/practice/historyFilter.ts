import { MODE_CN, type SessionSummary } from '../../services/practiceRepository';

export interface HistoryFilter {
  query: string;
  mode: string;
  period: 'all' | 'today' | 'week' | 'month';
  status: 'all' | 'completed' | 'interrupted' | 'trustworthy';
}

export const EMPTY_HISTORY_FILTER: HistoryFilter = { query: '', mode: 'all', period: 'all', status: 'all' };
export const HISTORY_SEARCH_LIMIT = 200;

export function filterPracticeHistory(items: readonly SessionSummary[], filter: HistoryFilter, now = new Date()): SessionSummary[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (filter.period === 'week') start.setDate(start.getDate() - 6);
  if (filter.period === 'month') start.setDate(start.getDate() - 29);
  const terms = filter.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (filter.mode !== 'all' && item.modeId !== filter.mode) return false;
    const interrupted = item.interrupted === true || item.endReason === 'interrupted';
    if (filter.status === 'interrupted' && !interrupted) return false;
    if (filter.status === 'completed' && (interrupted || item.endReason !== 'completed')) return false;
    if (filter.status === 'trustworthy' && !item.trustworthy) return false;
    const date = new Date(item.finishedAtIso);
    if (filter.period !== 'all' && (!Number.isFinite(date.getTime()) || date < start || date > now)) return false;
    const localDate = Number.isFinite(date.getTime())
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : '';
    const text = [MODE_CN[item.modeId], item.modeId, item.takeTemplateName,
      localDate, item.bpm == null ? '' : `${item.bpm} BPM`, item.reportKind === 'follow' ? '跟手 Follow' : '时间线'].join(' ').toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
