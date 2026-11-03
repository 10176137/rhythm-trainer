// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import NoteReviewPanel from './NoteReviewPanel';
import { practiceRepository } from '../services/practiceRepository';
import type { NoteReview } from '../../shared/note-review';
vi.mock('./OsmdScoreView', () => ({ default: () => <div>谱面</div> }));
it('shows every note via pagination, navigates issues, and ignores a stale Take response', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const data: NoteReview = { takeId: 'current', kind: 'timeline', trustworthy: true, scoreFingerprint: null, xml: null, notice: '起音与时值独立',
    items: Array.from({ length: 120 }, (_, i) => ({ id: `n${i}`, eventId: `e${i}`, measure: i + 1, pitch: 60, actualPitch: 60, pitchLabel: `C4-${i}`, state: 'attention', result: 'MATCH', messages: [`晚了 ${i} ms`], onsetErrorMs: i, intervalErrorMs: null, expectedDurationMs: 500, actualDurationMs: 450, durationResult: 'too_short' })) };
  let resolve!: (r: NoteReview) => void;
  const mock = vi.spyOn(practiceRepository, 'getNoteReview').mockImplementation(id => id === 'old' ? new Promise(r => { resolve = r; }) : Promise.resolve(data));
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(<NoteReviewPanel takeId="old" />));
    await act(async () => root.render(<NoteReviewPanel takeId="current" />));
    await act(async () => resolve({ ...data, items: [] }));
    expect(host.textContent).toContain('120 条'); expect(host.textContent).toContain('没有保存原始谱面');
    const button = (name: string) => [...host.querySelectorAll('button')].find(b => b.textContent === name)!;
    await act(async () => button('下一个').click()); expect(host.querySelector('h4')?.textContent).toContain('第 2 小节');
    await act(async () => button('下一页').click()); expect(host.querySelector('.note-review-list')?.textContent).toContain('第 120 小节');
  } finally { await act(async () => root.unmount()); mock.mockRestore(); vi.unstubAllGlobals(); }
});
