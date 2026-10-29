import { MODE_CN, type SessionSummary } from '../services/practiceRepository';
import { EMPTY_HISTORY_FILTER, type HistoryFilter } from '../features/practice/historyFilter';

export default function HistoryFilters({ value, items, count, onChange }: {
  value: HistoryFilter;
  items: readonly SessionSummary[];
  count: number;
  onChange: (value: HistoryFilter) => void;
}) {
  const active = value.query.trim() || value.mode !== 'all' || value.period !== 'all' || value.status !== 'all';
  return <div className="history-filters" role="search" aria-label="检索练习记录">
    <label className="history-search"><span>查找练习</span><input type="search" placeholder="模式、日期、BPM 或方案名称" value={value.query}
      onChange={(event) => onChange({ ...value, query: event.target.value })} /></label>
    <div className="history-filter-selects">
      <label><span>练习模式</span><select value={value.mode} onChange={(event) => onChange({ ...value, mode: event.target.value })}>
        <option value="all">所有模式</option>{[...new Set(items.map((item) => item.modeId))].map((mode) => <option key={mode} value={mode}>{MODE_CN[mode] ?? mode}</option>)}
      </select></label>
      <label><span>时间范围</span><select value={value.period} onChange={(event) => onChange({ ...value, period: event.target.value as HistoryFilter['period'] })}>
        <option value="all">全部已加载记录</option><option value="today">今天</option><option value="week">最近 7 天</option><option value="month">最近 30 天</option>
      </select></label>
      <label><span>记录状态</span><select value={value.status} onChange={(event) => onChange({ ...value, status: event.target.value as HistoryFilter['status'] })}>
        <option value="all">所有状态</option><option value="completed">已完成</option><option value="interrupted">中途结束</option><option value="trustworthy">数据可信</option>
      </select></label>
    </div>
    <div className="history-filter-result"><span role="status" aria-live="polite">找到 <b>{count}</b> 条 · 当前检索最近 {items.length} 条演奏记录</span>
      <button type="button" className="text-button" disabled={!active} onClick={() => onChange({ ...EMPTY_HISTORY_FILTER })}>清空筛选</button></div>
  </div>;
}
