import { useEffect, useRef, useState, type RefObject } from 'react';
import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import type { ScoreDocument as EngineScoreDocument } from '../score-engine/domain/types';
import { OsmdScoreViewAdapter } from '../score-engine/view/score-view-adapter';

interface Props {
  xml: string;
  engine: EngineScoreDocument;
  activeNoteIds: string[];
  follow: boolean;
  /** Increments when the player hits the current target (or re-enables follow). */
  followSignal: number;
  /** Target group IDs the system has played. */
  systemNoteIds: string[];
  /** Target group IDs the player has hit correctly. */
  userNoteIds: string[];
  /** Notes outside the current hand/range; keep them visible but de-emphasized. */
  mutedNoteIds?: string[];
  /** Measures outside the loop range; covered with a translucent green cloth. */
  loopCoveredMeasures?: number[];
  /** Whether system-played notes should stay red. */
  colorSystemNotes: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onSelectEvent: (eventId: string) => void;
  onRendered?: () => void;
}

/** Fixed natural width: no downscaling on narrow screens; the outer pane scrolls. */
export const ENGRAVED_SCORE_WIDTH = 1510;

/**
 * Professional MusicXML engraving (OSMD/VexFlow + Bravura). This is display
 * only: the Rust engine remains the scoring authority. The adapter maps domain
 * note-event IDs to OSMD graphical notes for active-target coloring and click.
 */
export default function OsmdScoreView({
  xml,
  engine,
  activeNoteIds,
  follow,
  followSignal,
  systemNoteIds,
  userNoteIds,
  mutedNoteIds = [],
  loopCoveredMeasures = [],
  colorSystemNotes,
  scrollRef,
  onSelectEvent,
  onRendered,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const adapterRef = useRef<OsmdScoreViewAdapter | null>(null);
  const previousActiveRef = useRef<string[]>([]);
  const previousSystemRef = useRef<string[]>([]);
  const previousUserRef = useRef<string[]>([]);
  const previousMutedRef = useRef<string[]>([]);
  const widthRetryRef = useRef(false);
  const selectRef = useRef(onSelectEvent);
  const renderedRef = useRef(onRendered);
  selectRef.current = onSelectEvent;
  renderedRef.current = onRendered;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [loopCovers, setLoopCovers] = useState<Array<{ measure: number; left: number; top: number; width: number; height: number }>>([]);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';
    setLoading(true);
    setError(null);
    previousActiveRef.current = [];
    previousSystemRef.current = [];
    previousUserRef.current = [];
    previousMutedRef.current = [];

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

        const adapter = new OsmdScoreViewAdapter(osmd);
        const mapping = adapter.buildMapping(engine);
        adapterRef.current = adapter;
        host.dataset.osmdMapped = String(mapping.mappedEventCount);
        host.dataset.osmdTotal = String(mapping.noteEventCount);
        host.dataset.osmdDuplicates = String(mapping.duplicateGraphicalRefs.length);

        for (const [eventId, ref] of mapping.byEventId) {
          const graphical = ref.graphicalNotes[0] as unknown as { getSVGGElement?: () => SVGGElement };
          const element = graphical.getSVGGElement?.();
          if (!element) continue;
          element.style.cursor = 'pointer';
          element.addEventListener('click', () => selectRef.current(eventId));
        }

        setLoading(false);
        renderedRef.current?.();
      } catch (renderError) {
        if (cancelled) return;
        setLoading(false);
        setError(renderError instanceof Error ? renderError.message : String(renderError));
      }
    })();

    return () => {
      cancelled = true;
      try { osmdRef.current?.clear(); } catch { /* best effort */ }
      osmdRef.current = null;
      adapterRef.current = null;
      if (host) host.innerHTML = '';
    };
  }, [xml, engine, layoutEpoch]);

  // OSMD can render a 0-width page when it was mounted inside a hidden route
  // or while the score card was transiently width-less. The host is fixed at
  // 1510px once visible; if the SVG still has width=0, remount/rebuild once.
  useEffect(() => {
    if (loading) return;
    const host = hostRef.current;
    if (!host) return;
    const checkWidth = () => {
      const svg = host.querySelector('svg');
      const svgWidth = Number(svg?.getAttribute('width') || 0);
      if (host.clientWidth > 0 && svgWidth === 0 && !widthRetryRef.current) {
        widthRetryRef.current = true;
        setLayoutEpoch((value) => value + 1);
        window.setTimeout(() => { widthRetryRef.current = false; }, 600);
      }
    };
    checkWidth();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(checkWidth) : null;
    observer?.observe(host);
    return () => observer?.disconnect();
  }, [loading, layoutEpoch]);

  // Current target = green. Notes the system has played = red; everything
  // else stays the engraver's default black.
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter || loading) return;
    const systemSet = new Set(systemNoteIds);
    const userSet = new Set(userNoteIds);
    for (const eventId of previousActiveRef.current) adapter.highlightScoreEvent(eventId, 'default');
    for (const eventId of previousSystemRef.current) {
      if (!colorSystemNotes || !systemSet.has(eventId)) adapter.highlightScoreEvent(eventId, 'default');
    }
    for (const eventId of previousUserRef.current) {
      if (!userSet.has(eventId)) adapter.highlightScoreEvent(eventId, 'default');
    }
    if (colorSystemNotes) {
      for (const eventId of systemNoteIds) adapter.highlightScoreEvent(eventId, 'system');
    }
    for (const eventId of userNoteIds) adapter.highlightScoreEvent(eventId, 'user');
    // Current expected position is applied last so it is always visible.
    for (const eventId of activeNoteIds) adapter.highlightScoreEvent(eventId, 'current');
    previousActiveRef.current = [...activeNoteIds];
    previousSystemRef.current = [...systemNoteIds];
    previousUserRef.current = [...userNoteIds];
  }, [activeNoteIds, systemNoteIds, userNoteIds, colorSystemNotes, loading]);

  // Single-hand practice keeps the other staff visible for context, but the
  // non-target notes are de-emphasized instead of looking equally active.
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter || loading) return;
    const svgElement = (graphical: unknown) => (
      (graphical as { getSVGGElement?: () => SVGGElement }).getSVGGElement?.()
    );
    for (const eventId of previousMutedRef.current) {
      for (const graphical of adapter.getGraphicalNotes(eventId)) {
        const element = svgElement(graphical);
        if (element) element.style.opacity = '';
      }
    }
    for (const eventId of mutedNoteIds) {
      for (const graphical of adapter.getGraphicalNotes(eventId)) {
        const element = svgElement(graphical);
        if (element) element.style.opacity = '0.22';
      }
    }
    previousMutedRef.current = [...mutedNoteIds];
  }, [mutedNoteIds, loading]);

  // Loop practice: keep non-loop measures readable but cover them with a
  // translucent green cloth. Coordinates come from the rendered OSMD measure
  // groups, relative to this component's root, so they survive scrolling.
  useEffect(() => {
    if (loading) return;
    const root = rootRef.current;
    const host = hostRef.current;
    if (!root || !host) return;
    const covered = new Set(loopCoveredMeasures);
    const update = () => {
      if (covered.size === 0) {
        setLoopCovers([]);
        return;
      }
      const rootRect = root.getBoundingClientRect();
      const boxes = new Map<number, { left: number; top: number; right: number; bottom: number }>();
      for (const element of host.querySelectorAll<SVGGElement>('g.vf-measure')) {
        const measure = Number(element.id);
        if (!Number.isInteger(measure) || !covered.has(measure)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const left = rect.left - rootRect.left;
        const top = rect.top - rootRect.top;
        const right = left + rect.width;
        const bottom = top + rect.height;
        const existing = boxes.get(measure);
        if (existing) {
          existing.left = Math.min(existing.left, left);
          existing.top = Math.min(existing.top, top);
          existing.right = Math.max(existing.right, right);
          existing.bottom = Math.max(existing.bottom, bottom);
        } else {
          boxes.set(measure, { left, top, right, bottom });
        }
      }
      setLoopCovers([...boxes.entries()].map(([measure, box]) => ({
        measure,
        left: box.left,
        top: box.top,
        width: box.right - box.left,
        height: box.bottom - box.top,
      })));
    };
    update();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(host);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [loopCoveredMeasures, loading]);

  // Follow only on an explicit signal: a correct target hit, or the user
  // re-enabling follow. Engine target changes, misses and manual scrolling do
  // not yank the page away from where the player is reading.
  useEffect(() => {
    if (!follow || loading || followSignal <= 0) return;
    const adapter = adapterRef.current;
    const outer = scrollRef.current;
    const eventId = activeNoteIds[0];
    if (!adapter || !outer || !eventId) return;
    const graphical = adapter.getGraphicalNotes(eventId)[0] as unknown as { getSVGGElement?: () => SVGGElement };
    const element = graphical?.getSVGGElement?.();
    if (!element) return;
    const noteRect = element.getBoundingClientRect();
    const viewRect = outer.getBoundingClientRect();
    const margin = Math.min(56, viewRect.height * 0.2);
    if (noteRect.top >= viewRect.top + margin && noteRect.bottom <= viewRect.bottom - margin) return;
    const top = outer.scrollTop + (noteRect.top - viewRect.top) - margin;
    outer.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [followSignal, follow, loading, scrollRef]);

  return (
    <div ref={rootRef} className="osmd-score" style={{ width: ENGRAVED_SCORE_WIDTH, minWidth: ENGRAVED_SCORE_WIDTH }}>
      <div className="osmd-host" ref={hostRef} aria-label="专业制谱渲染" />
      {loopCovers.length > 0 && (
        <div className="osmd-loop-cover-layer" aria-hidden="true">
          {loopCovers.map((cover) => (
            <div
              key={cover.measure}
              className="osmd-loop-cover"
              data-measure={cover.measure}
              style={{ left: cover.left, top: cover.top, width: cover.width, height: cover.height }}
            />
          ))}
        </div>
      )}
      {loading && <div className="osmd-status" role="status">正在用 Bravura 制谱引擎渲染…</div>}
      {error && (
        <div className="osmd-status osmd-status-error" role="alert">
          专业谱面渲染失败：{error}。请切换到「练习视图」。
        </div>
      )}
    </div>
  );
}
