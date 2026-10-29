import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import FreeReadingView, { type FreeReadingInputEvent } from './FreeReadingView';
import { FreeReadingSession } from '../features/reading/freeReadingSession';
import { forwardReadingInput, heldReadingErrors, type ReadingInputFeedback } from '../features/reading/readingInput';

// Verify the view forwards real session feedback to the engraver in BOTH task modes.
vi.mock('./ReadingScoreFeedback', () => ({ default: ({ hits, wrongPitches }: { hits: number[]; wrongPitches: number[] }) =>
  <output data-hit-pitches={hits.join(',')} data-wrong-pitches={wrongPitches.join(',')} /> }));

describe('reading feedback in practice and tests', () => {
  it.each(['practice', 'test'] as const)('%s shows correct hits and held wrong notes, then clears only released errors', (task) => {
    const session = new FreeReadingSession([[60, 64, 67]], { task });
    let input: FreeReadingInputEvent | null = null;
    let sequence = 0;
    const receive = (event: ReadingInputFeedback) => {
      const seq = ++sequence;
      input = { ...event, seq, heldWrongPitches: heldReadingErrors(input?.heldWrongPitches ?? [], event),
        attack: event.isRelease ? input?.attack ?? null : { ...event, seq } };
    };
    const send = (midi: number, isRelease = false) => forwardReadingInput(session, { midi, isRelease, source: 'midi' }, receive);
    const render = () => renderToStaticMarkup(<FreeReadingView session={session} input={input} deviceConnected={false}
      setup={null} onInput={() => {}} onFinish={() => {}} onRetrySameConfig={() => {}} onReviewWeak={null}
      onChangeConfig={() => {}} onExit={() => {}} saveStatus={{ status: 'idle' }} onRetrySave={() => {}}
      onStartTest={null} onNextLevel={null} />);
    send(60);
    send(61);
    const held = render();
    expect(held).toContain('data-hit-pitches="60"');
    expect(held).toContain('data-wrong-pitches="61"');
    expect(held).toContain('rk-black rk-wrong');
    if (task === 'test') {
      expect(held).not.toContain('查看本题提示');
      expect(session.hint()).toBe(false);
    }
    send(61, true);
    const released = render();
    expect(released).toContain('data-hit-pitches="60"');
    expect(released).toContain('data-wrong-pitches=""');
    expect(released).not.toContain('rk-black rk-wrong');
    expect(session.evidence()).toEqual([{ type: 'note', midi: 60 }, { type: 'note', midi: 61 }]);
  });
});
