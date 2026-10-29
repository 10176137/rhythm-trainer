// Isolated UI contract: no device connection, engine session, or saved history.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import FreeReadingView, { type FreeReadingInputEvent } from '../../components/FreeReadingView';
import { FreeReadingSession } from './freeReadingSession';
import { forwardReadingInput, heldReadingErrors, type ReadingInputFeedback } from './readingInput';
import '../../styles.css';

function Contract() {
  const [session] = useState(() => new FreeReadingSession([[60, 64, 67], [72], [48, 52]]));
  const [input, setInput] = useState<FreeReadingInputEvent | null>(null);
  const seq = useRef(0);
  const receive = (event: ReadingInputFeedback) => {
    const id = ++seq.current;
    setInput((previous) => ({ ...event, seq: id,
      heldWrongPitches: heldReadingErrors(previous?.heldWrongPitches ?? [], event),
      attack: event.isRelease ? previous?.attack ?? null : { ...event, seq: id } }));
  };
  const send = (midi: number, isRelease = false) => forwardReadingInput(session, { midi, isRelease, source: 'midi' }, receive);
  return <main style={{ padding: 24, maxWidth: 1100, margin: 'auto' }}>
    <h1>识谱音符反馈检查</h1>
    <p>仅验证谱面交互，不连接实体设备、不生成练习记录。</p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0' }}>
      <button onClick={() => send(60)}>弹对 C4</button>
      <button onClick={() => send(61)}>按住错误音 C♯4</button>
      <button onClick={() => send(61, true)}>松开 C♯4</button>
      <button onClick={() => send(66)}>按住错误音 F♯4</button>
      <button onClick={() => send(66, true)}>松开 F♯4</button>
      <button onClick={() => { send(64); send(67); }}>完成和弦</button>
      <button onClick={() => { send(72); send(72, true); }}>快速按下并松开 C5</button>
    </div>
    <FreeReadingView session={session} input={input} deviceConnected={false} setup={{ key: null, staffPreference: 'auto' }}
      onInput={(midi, isRelease) => send(midi, isRelease)} onFinish={() => {}} onRetrySameConfig={() => location.reload()}
      onReviewWeak={null} onStartTest={null} onNextLevel={null} onChangeConfig={() => {}} onExit={() => {}}
      saveStatus={{ status: 'idle' }} onRetrySave={() => {}} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Contract />);
