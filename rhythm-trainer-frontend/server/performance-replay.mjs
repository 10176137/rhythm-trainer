import fs from 'node:fs';
import path from 'node:path';

/** Listening material only, never scoring input. Voice identity includes input
 * source/channel; note-off, sustain and re-attacks must not merge by pitch. */
export function buildPerformanceReplay(take, trace) {
  if (!trace?.events?.length) throw new Error('没有保存可重放的完整 MIDI 事件');
  const notes = []; const held = new Map(); const sustained = new Map(); const pedals = new Map();
  const warnings = new Set(); let last = 0;
  const close = (note, at) => { note.durationMs = Math.max(1, at - note.atMs); };
  const releasePedal = (channel, at) => { for (const n of sustained.get(channel) ?? []) close(n, at); sustained.delete(channel); };
  const events = trace.events.map((e, index) => ({ ...e, index })).filter(e => Number.isFinite(e.sessionTimeMs)).sort((a, b) => a.sessionTimeMs - b.sessionTimeMs || a.index - b.index);
  const pauses = (take.evidence?.pauseIntervals ?? []).filter(p => Number.isFinite(p.startMs)).map(p => p.startMs).sort((a,b) => a-b); let pause = 0;
  for (const event of events) {
    const at = Math.max(0, event.sessionTimeMs); last = Math.max(last, at);
    while (pause < pauses.length && pauses[pause] <= at) {
      for (const group of held.values()) for (const n of group) close(n, pauses[pause]);
      for (const channel of sustained.keys()) releasePedal(channel, pauses[pause]);
      held.clear(); pedals.clear(); pause++; warnings.add('暂停期间停声，保留实际暂停间隔。');
    }
    const [status, pitch, value] = event.rawBytes ?? []; const command = status & 240;
    const channel = `${event.sourceId ?? 'input'}:${status & 15}`; const key = `${channel}:${pitch}`;
    if (command === 144 && value > 0) {
      if (event.duringPause || event.countdownSuppressed || event.admission?.finalOnset === false) continue;
      if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) continue;
      const n = { id: `performed-${notes.length}`, pitch, velocity: Math.max(1, Math.min(127, value)), atMs: at, durationMs: null, keyDurationMs: null };
      notes.push(n); const group = held.get(key) ?? []; group.push(n); held.set(key, group);
    } else if (command === 128 || (command === 144 && value === 0)) {
      const group = held.get(key); const n = group?.shift(); if (!n) continue;
      if (!group.length) held.delete(key); n.keyDurationMs = Math.max(0, at - n.atMs);
      if (pedals.get(channel)) { const list = sustained.get(channel) ?? []; list.push(n); sustained.set(channel, list); } else close(n, at);
    } else if (command === 176 && pitch === 64) {
      if (value !== 0 && value !== 127) warnings.add('延音踏板按开关重放，不模拟半踏板深度。');
      if (value < 64) releasePedal(channel, at); pedals.set(channel, value >= 64);
    } else if (command === 176 && [120, 123].includes(pitch)) {
      for (const [k, group] of held) if (k.startsWith(`${channel}:`)) { for (const n of group) close(n, at); held.delete(k); }
      releasePedal(channel, at); pedals.delete(channel);
    } else if (command === 176 && [66, 67].includes(pitch)) {
      warnings.add('记录含其他踏板；当前音色仅合成 CC64 延音踏板。');
    }
  }
  if (!notes.length) throw new Error('此记录没有可重放的按键事件');
  for (const n of notes) if (n.durationMs === null) { close(n, Math.max(last, n.atMs) + 250); warnings.add('存在未收到松键或踏板释放的音，已在记录末尾截断。'); }
  if (trace.manifest?.complete === false || trace.manifest?.dropped > 0) warnings.add('原始 MIDI 记录不完整，重放可能缺少事件。');
  const offset = Math.min(...notes.map(n => n.atMs));
  for (const n of notes) n.atMs -= offset;
  return { version: 1, takeId: take.takeId, durationMs: Math.max(...notes.map(n => n.atMs + n.durationMs)), warnings: [...warnings], notes };
}

/** A manifest is the permanent Take association. Once created, a missing or
 * corrupt payload is reported as missing, never silently regenerated. */
export function loadPerformanceReplay(dir, take, loadTrace) {
  if (!/^[A-Za-z0-9_-]+$/.test(take.takeId)) throw new Error('Take ID 非法');
  fs.mkdirSync(dir, { recursive: true });
  const payload = path.join(dir, `${take.takeId}.json`); const marker = path.join(dir, `${take.takeId}.manifest.json`);
  if (fs.existsSync(marker)) {
    try { const data = JSON.parse(fs.readFileSync(payload, 'utf8')); if (data.takeId !== take.takeId || data.version !== 1 || !Array.isArray(data.notes)
      || !Number.isFinite(data.durationMs) || data.durationMs < 0 || !Array.isArray(data.warnings)
      || data.notes.some(n => !Number.isInteger(n.pitch) || n.pitch < 0 || n.pitch > 127 || !Number.isFinite(n.atMs) || n.atMs < 0 || !Number.isFinite(n.durationMs) || n.durationMs <= 0 || !Number.isFinite(n.velocity) || n.velocity < 1 || n.velocity > 127)) throw new Error(); return { status: 'available', data }; }
    catch { return { status: 'missing', message: '本地重放文件已丢失或损坏。原有成绩仍可查看。' }; }
  }
  let data;
  try { data = buildPerformanceReplay(take, loadTrace()); } catch (e) { return { status: 'unavailable', message: e.message }; }
  fs.writeFileSync(`${payload}.tmp`, JSON.stringify(data)); fs.renameSync(`${payload}.tmp`, payload);
  fs.writeFileSync(marker, JSON.stringify({ version: 1, takeId: take.takeId, file: path.basename(payload) }));
  return { status: 'available', data };
}
