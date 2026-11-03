import { useEffect, useRef, useState } from 'react';
import { WebAudioEngineAdapter } from '../features/playback/audioEngineAdapter';
import InstrumentSelect from './InstrumentSelect';
import { AppButton } from './ui/controls';

/** Settings owns only its short preview. Score/replay keep their own transport. */
export default function InstrumentSettingsPanel() {
  const engine = useRef<WebAudioEngineAdapter | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [error, setError] = useState('');

  const dispose = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    engine.current?.dispose();
    engine.current = null;
  };
  useEffect(() => () => dispose(), []);
  const stop = () => { dispose(); setPhase('idle'); setError(''); };
  const preview = async () => {
    stop();
    const audio = new WebAudioEngineAdapter();
    engine.current = audio;
    setPhase('loading');
    try {
      await audio.prepare();
      if (engine.current !== audio) return;
      const start = audio.currentTime() + .05;
      [60, 64, 67, 72].forEach((midiNote, index) => {
        const voiceId = `instrument-preview-${index}`;
        audio.scheduleNoteOn({ voiceId, midiNote, velocity: .75 }, start + index * .3);
        audio.scheduleNoteOff(voiceId, start + index * .3 + .55);
      });
      setPhase('playing');
      timer.current = setTimeout(stop, 2400);
    } catch (cause) {
      if (engine.current !== audio) return;
      dispose(); setPhase('idle');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <section className="card preference-card" aria-label="播放音色偏好">
    <div className="preference-heading"><div><h2>音色与重放</h2>
      <p>7 种音色，用于乐谱试听与演奏重放。选择后可直接试听比较。</p>
    </div><span className="preference-badge">自动保存</span></div>
    <InstrumentSelect onChange={stop} />
    <div className="preference-save-row"><span>偏好保存在当前设备，演奏记录内可重放实际 MIDI 输入。</span>
      <AppButton type="button" className="button button-outline" onClick={() => { if (phase === 'idle') void preview(); else stop(); }}>
        {phase === 'loading' ? '取消加载' : phase === 'playing' ? '停止试听' : '试听音色'}
      </AppButton>
    </div>
    {error && <p role="alert">{error} 请重试试听。</p>}
    <p className="settings-note">明亮与柔和钢琴为同源采样变体；电钢琴、管风琴、钟琴为合成音色。</p>
    <p className="settings-note">钢琴采样：Alexander Holm / Salamander，CC BY 3.0。<a href="/audio/salamander/ATTRIBUTION.txt">查看署名与许可</a></p>
  </section>;
}
