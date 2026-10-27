// Fixed-judgment-line viewport built on the SAME OSMD/Bravura engraving as the
// normal score page. The score is not re-drawn by hand: OSMD renders it once,
// we show one system at a time and translate that system so the current
// target's engraved notehead sits on the fixed line at its target time.
//
// Time mapping uses OSMD note anchors (piecewise between consecutive targets),
// not a constant px/ms over an arbitrary VexFlow layout. rAF only moves the
// SVG; the engine remains the scoring clock.

import { useEffect, useRef, useState } from 'react';
import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { OsmdScoreViewAdapter } from '../score-engine/view/score-view-adapter';
import type { ScoreDocument as EngineScoreDocument } from '../score-engine/domain/types';
import type { SessionStatus } from '../types/practice';
import type { PracticeTarget } from '../features/practice/usePracticeSession';

interface Props {
  xml: string | null;
  engine: EngineScoreDocument | null;
  targets: readonly PracticeTarget[];
  groups: readonly string[][];
  status: SessionStatus;
  tempo: number;
  /** performance.now() when the session display clock started (incl. count-in). */
  displayStartMs: number | null;
  onRendered?: () => void;
}

interface TargetAnchor {
  targetIndex: number;
  atMs: number;
  system: number;
  x: number;
}

interface SystemGeom {
  index: number;
  top: number;
  bottom: number;
  stafflines: SVGGElement[];
}

const JUDGE_RATIO = 0.3;

function osmdHostRect(host: HTMLDivElement): DOMRect {
  return host.getBoundingClientRect();
}

function nearestStaffline(element: Element | null): SVGGElement | null {
  let current: Element | null = element;
  while (current) {
    if (current instanceof SVGGElement && current.classList.contains('staffline')) return current;
    current = current.parentElement;
  }
  return null;
}

export default function FixedLineScoreView({
  xml,
  engine,
  targets,
  groups,
  status,
  tempo,
  displayStartMs,
  onRendered,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<OsmdScoreViewAdapter | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const previousActiveRef = useRef<string[]>([]);
  const timeHighlightRef = useRef(-1);
  const anchorsRef = useRef<TargetAnchor[]>([]);
  const systemsRef = useRef<SystemGeom[]>([]);
  const currentSystemRef = useRef(-1);
  const [ready, setReady] = useState(0);
  const [loading, setLoading] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;

  // Load/render OSMD exactly like the normal score page.
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host || !xml || !engine) return;
    host.innerHTML = '';
    host.style.transform = 'translate(0px, 0px)';
    setLoading(true);
    setRenderError(null);
    adapterRef.current = null;
    anchorsRef.current = [];
    systemsRef.current = [];
    currentSystemRef.current = -1;
    previousActiveRef.current = [];

    void (async () => {
      try {
        const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay');
        if (cancelled) return;
        const osmd = new OpenSheetMusicDisplay(host, {
          autoResize: false,
          backend: 'svg',
          drawTitle: false,
          drawComposer: false,
          drawCredits: false,
          drawPartNames: true,
          drawPartAbbreviations: false,
          drawMeasureNumbers: true,
          drawMeasureNumbersOnlyAtSystemStart: true,
          followCursor: false,
          disableCursor: true,
        });
        osmdRef.current = osmd;
        await osmd.load(xml);
        if (cancelled) return;
        osmd.Zoom = 1.0;
        osmd.render();
        if (cancelled) return;
        adapterRef.current = new OsmdScoreViewAdapter(osmd);
        adapterRef.current.buildMapping(engine);
        setLoading(false);
        setReady((value) => value + 1);
        onRenderedRef.current?.();
      } catch (error) {
        if (cancelled) return;
        setLoading(false);
        setRenderError(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      cancelled = true;
      try { osmdRef.current?.clear(); } catch { /* best effort */ }
      osmdRef.current = null;
      adapterRef.current = null;
      if (host) host.innerHTML = '';
    };
  }, [xml, engine]);

  // Measure OSMD anchors once per plan/score. The host is temporarily reset to
  // translate(0,0), so these coordinates are independent of the animation.
  useEffect(() => {
    const host = hostRef.current;
    const adapter = adapterRef.current;
    if (!host || !adapter || loading || !targets.length) return;
    host.style.transform = 'translate(0px, 0px)';
    const hostRect = osmdHostRect(host);
    const stafflines = Array.from(host.querySelectorAll<SVGGElement>('g.staffline'));
    const staves = Math.max(1, engine?.parts[0]?.staves ?? 1);
    const systems: SystemGeom[] = [];
    for (let i = 0; i < stafflines.length; i += staves) {
      const group = stafflines.slice(i, i + staves);
      if (!group.length) continue;
      const rects = group.map((item) => item.getBoundingClientRect());
      systems.push({
        index: systems.length,
        top: Math.min(...rects.map((rect) => rect.top)) - hostRect.top,
        bottom: Math.max(...rects.map((rect) => rect.bottom)) - hostRect.top,
        stafflines: group,
      });
    }
    const stafflineIndex = new Map<SVGGElement, number>();
    stafflines.forEach((element, index) => stafflineIndex.set(element, index));
    const anchors: TargetAnchor[] = [];
    for (const [targetIndex, target] of targets.entries()) {
      const ids = groups[targetIndex] ?? [];
      let element: SVGGElement | null = null;
      for (const id of ids) {
        const graphical = adapter.getGraphicalNotes(id)[0] as unknown as { getSVGGElement?: () => SVGGElement };
        const candidate = graphical?.getSVGGElement?.();
        if (candidate) { element = candidate; break; }
      }
      if (!element) continue;
      const staffline = nearestStaffline(element);
      const lineIndex = staffline ? stafflineIndex.get(staffline) : undefined;
      if (lineIndex === undefined) continue;
      const system = Math.floor(lineIndex / staves);
      const notehead = element.querySelector<SVGGraphicsElement>('.vf-notehead') ?? element;
      const noteRect = notehead.getBoundingClientRect();
      anchors.push({
        targetIndex,
        atMs: target.displayAtMs,
        system,
        x: noteRect.left + noteRect.width / 2 - hostRect.left,
      });
    }
    anchorsRef.current = anchors;
    systemsRef.current = systems;
    // Show only the first system until the clock moves.
    for (const system of systems) {
      for (const line of system.stafflines) line.style.display = system.index === 0 ? '' : 'none';
    }
    currentSystemRef.current = 0;
    timeHighlightRef.current = -1;
    applyTimeHighlight(0);
    // Place the first system at the left edge so the pre-start preview is readable.
    if (wrapRef.current) {
      const wrap = wrapRef.current;
      const judgeX = wrap.clientWidth * JUDGE_RATIO;
      const centerY = wrap.clientHeight / 2;
      const first = anchors[0];
      const x = first ? judgeX - first.x : 24;
      const y = centerY - ((systems[0]?.top ?? 0) + (systems[0]?.bottom ?? 0)) / 2;
      host.style.transform = `translate(${x}px, ${y}px)`;
    }
  }, [targets, groups, loading, ready, engine]);

  // The green highlight follows the TARGET AT THE FIXED LINE, derived from the
  // same target times as the animation. It must not lag behind when a target
  // is missed: the line is the time reference.
  const applyTimeHighlight = (index: number) => {
    if (timeHighlightRef.current === index) return;
    const adapter = adapterRef.current;
    if (!adapter) return;
    for (const id of previousActiveRef.current) adapter.highlightScoreEvent(id, 'default');
    const ids = groups[index] ?? [];
    for (const id of ids) adapter.highlightScoreEvent(id, 'current');
    previousActiveRef.current = [...ids];
    timeHighlightRef.current = index;
  };

  // Critical: if the OSMD render finished after the plan, anchors may not have
  // been measured yet (ready changes). The anchor effect above depends on ready.

  // Animate by moving the engraved system; never feed this clock to the engine.
  useEffect(() => {
    if (loading || !anchorsRef.current.length || displayStartMs === null) return;
    if (status !== 'running' && status !== 'countdown') return;
    let frame = 0;
    const tick = () => {
      const wrap = wrapRef.current;
      const host = hostRef.current;
      if (!wrap || !host) return;
      const now = Math.max(0, performance.now() - displayStartMs);
      const anchors = anchorsRef.current;
      let index = 0;
      for (let i = 0; i < anchors.length; i += 1) {
        if (anchors[i].atMs <= now) index = i;
        else break;
      }
      const active = anchors[index];
      const next = anchors[index + 1];
      applyTimeHighlight(active.targetIndex);
      let anchorX = active.x;
      if (next && next.system === active.system && next.atMs > active.atMs) {
        const progress = Math.min(1, Math.max(0, (now - active.atMs) / (next.atMs - active.atMs)));
        anchorX = active.x + (next.x - active.x) * progress;
      }
      const system = systemsRef.current[active.system];
      if (!system) { frame = requestAnimationFrame(tick); return; }
      if (currentSystemRef.current !== active.system) {
        for (const item of systemsRef.current) {
          for (const line of item.stafflines) line.style.display = item.index === active.system ? '' : 'none';
        }
        currentSystemRef.current = active.system;
      }
      const judgeX = wrap.clientWidth * JUDGE_RATIO;
      const centerY = wrap.clientHeight / 2;
      const x = judgeX - anchorX;
      const y = centerY - (system.top + system.bottom) / 2;
      host.style.transform = `translate(${x}px, ${y}px)`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [status, displayStartMs, loading, ready, targets.length, groups]);

  // Reset the visual clock on reset/idle; keep the first system readable.
  useEffect(() => {
    if (displayStartMs !== null) return;
    const host = hostRef.current;
    const wrap = wrapRef.current;
    if (!host || !wrap || !systemsRef.current.length) return;
    const system = systemsRef.current[0];
    for (const item of systemsRef.current) {
      for (const line of item.stafflines) line.style.display = item.index === 0 ? '' : 'none';
    }
    currentSystemRef.current = 0;
    const x = 24;
    const y = wrap.clientHeight / 2 - (system.top + system.bottom) / 2;
    host.style.transform = `translate(${x}px, ${y}px)`;
  }, [displayStartMs, ready, targets.length]);

  const firstTargetMs = targets[0]?.displayAtMs ?? null;
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    if (displayStartMs === null || (status !== 'running' && status !== 'countdown')) return;
    let frame = 0;
    const tick = () => {
      setNowMs(Math.max(0, performance.now() - displayStartMs));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [displayStartMs, status]);
  const countdownRemain = status === 'countdown' && firstTargetMs !== null ? firstTargetMs - nowMs : null;

  return (
    <section className="fixed-line-viewport" aria-label="固定判定线谱面">
      <div className="fixed-line-toolbar">
        <span className="fixed-line-kind">固定判定线 · 单行大谱表</span>
        <span className="fixed-line-meta">
          {tempo} BPM · 与专业谱面同一份 OSMD 排版
        </span>
        <span className="fixed-line-hint">音符到达判定线时演奏</span>
      </div>
      <div className="fixed-line-osmd-wrap" ref={wrapRef}>
        <div className="fixed-line-osmd-host" ref={hostRef} aria-label="固定判定线专业谱面" />
        <div className="fixed-line-line" style={{ left: `${JUDGE_RATIO * 100}%` }}>
          <span>判定线</span>
        </div>
        {loading && <div className="fixed-line-osmd-status">正在用 Bravura 制谱引擎渲染…</div>}
        {renderError && <div className="fixed-line-osmd-status error">专业谱面渲染失败：{renderError}</div>}
        {countdownRemain !== null && countdownRemain > 0 && (
          <div className="fixed-line-countdown" role="status" aria-live="assertive">
            <strong>{Math.ceil(countdownRemain / 1000)}</strong>
            <span>距离第一个音</span>
          </div>
        )}
        {status === 'paused' && <div className="fixed-line-paused">已暂停</div>}
      </div>
    </section>
  );
}
