import { AppButton } from './ui/controls';
import { useEffect, useRef, useState } from 'react';
import type { PerformanceReplay } from '../../shared/performance-replay';
import { backendUrl } from '../services/backendEndpoint';
import { ReferencePlaybackController, type PlaybackSnapshot } from '../features/playback/reference-playback-controller';
import { WebAudioEngineAdapter } from '../features/playback/audioEngineAdapter';
import { ensureSharedAudioContext } from '../features/playback/sharedAudioContext';
import { performedPlaybackPlan } from '../features/playback/performedPlaybackPlan';
import InstrumentSelect from './InstrumentSelect';
import './performanceReplay.css';
const time = (ms: number) => `${Math.floor(ms / 60000)}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}.${Math.floor(ms % 1000 / 100)}`;
export default function PerformanceReplayPanel({ takeId }: { takeId: string }) {
  const [data, setData] = useState<PerformanceReplay | null>(null); const [message, setMessage] = useState('载入本地重放…');
  const [error, setError] = useState(''); const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
  const [speed, setSpeed] = useState(1); const [volume, setVolume] = useState(.75); const [retry, setRetry] = useState(0);
  const player = useRef<ReferencePlaybackController | null>(null); const generation = useRef(0);
  useEffect(() => {
    const controller = new ReferencePlaybackController({ audio: new WebAudioEngineAdapter() }); player.current = controller;
    const unsubscribe = controller.subscribe(s => { setSnapshot(s); if (s.status === 'FAILED') setError('播放失败，请检查本地音色文件或音频权限。'); });
    return () => { generation.current++; unsubscribe(); controller.dispose(); player.current = null; };
  }, []);
  useEffect(() => {
    let stale = false; generation.current++; player.current?.stop('take-changed'); setData(null); setError(''); setMessage('载入本地重放…');
    fetch(backendUrl(`/api/takes/${encodeURIComponent(takeId)}/performance-replay`)).then(async response => {
      if (!response.ok) throw new Error(`载入失败 (${response.status})`); return response.json();
    }).then(result => { if (stale) return; if (result.status === 'available') { setData(result.data); setMessage(''); } else setMessage(result.message); })
      .catch(e => { if (!stale) setMessage(e instanceof Error ? e.message : String(e)); });
    return () => { stale = true; generation.current++; player.current?.stop('take-closed'); };
  }, [takeId, retry]);
  const stop = () => { generation.current++; player.current?.stop('user'); };
  const play = async (position = 0) => {
    if (!data || !player.current) return; const token = ++generation.current; setError('');
    try { await ensureSharedAudioContext(); if (token !== generation.current) return;
      player.current.setGain(volume); await player.current.start(performedPlaybackPlan(data, speed), { startAtMs: position / speed });
    } catch (e) { if (token === generation.current) setError(e instanceof Error ? e.message : String(e)); }
  };
  const playing = snapshot && ['PREPARING', 'PLAYING', 'COUNT_IN'].includes(snapshot.status);
  const paused = snapshot?.status === 'PAUSED'; const position = (snapshot?.positionMs ?? 0) * speed;
  return <section className="performance-replay" aria-label="重放我的演奏"><div><div className="eyebrow">MY PERFORMANCE</div><h3>重放我的演奏</h3>
    <p>本地 MIDI 演奏重放 · 保留实际错音、节奏、力度和踏板延音；不是电钢琴原声录音。</p></div>
    {message && <p role="status">{message}</p>}{!data && <AppButton onClick={() => setRetry(n => n + 1)}>重新检查文件</AppButton>}
    {data && <><div className="replay-controls"><InstrumentSelect disabled={!!playing || paused} />
      <label className="field"><span>重放速度</span><select aria-label="重放速度" value={speed} disabled={!!playing || paused} onChange={e => { stop(); setSpeed(Number(e.target.value)); }}><option value="0.5">0.5 倍</option><option value="0.75">0.75 倍</option><option value="1">原速</option></select></label>
      <AppButton disabled={!!playing} onClick={() => paused ? void player.current?.resume() : void play()}>{paused ? '继续重放' : '重放我的演奏'}</AppButton>
      <AppButton disabled={snapshot?.status !== 'PLAYING' && snapshot?.status !== 'COUNT_IN'} onClick={() => player.current?.pause()}>暂停重放</AppButton><AppButton onClick={stop}>停止重放</AppButton>
      <label>音量<input aria-label="重放音量" type="range" min="0" max="1" step="0.05" value={volume} onChange={e => { const value = Number(e.target.value); setVolume(value); player.current?.setGain(value); }} /></label>
    </div><label className="replay-position">{time(position)} / {time(data.durationMs)}<input aria-label="重放位置" type="range" min="0" max={data.durationMs} step="100" value={Math.min(position, data.durationMs)} disabled={snapshot?.status === 'PREPARING'} onChange={e => { stop(); void play(Number(e.target.value)); }} /></label>
      {data.warnings.map(w => <p className="report-warning" key={w}>{w}</p>)}
      <p className="replay-credit">大钢琴采样：Alexander Holm / Salamander · <a href="/audio/salamander/ATTRIBUTION.txt" target="_blank" rel="noreferrer">音色来源与许可</a>。音色选择也用于标准乐谱试听。</p></>}
    {snapshot?.status === 'PREPARING' && <p role="status">正在加载本地音色…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
