import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import type { ScoreDocument as EngineScoreDocument } from '../score-engine/domain/types';
import { OsmdScoreViewAdapter } from '../score-engine/view/score-view-adapter';
import { groupSystems, loopBandBoxes, nearestLoopEdge } from '../score-engine/view/score-layout';
import { applyMeasureGrid, prepareMeasureGrid, renderMeasureGrid } from './osmdEngraving';
import { bindNoteSelection } from '../features/score/bindNoteSelection';
import { needsFollowScroll } from './followScroll';
import type { HighlightState } from '../score-engine/view/score-view-adapter';

interface Props {
  reviewStates?: Record<string, HighlightState>;
  width?: number;
  /** Fit the final SVG to the viewport after native four-measure engraving. */
  fitWidth?: boolean;
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
  /** The tapped boundary notes; the band edges clip to their exact positions. */
  loopRangeNotes?: { start: { eventId: string }; end: { eventId: string } } | null;
  /** Commits a dragged loop boundary (A=start, B=end) snapped to this note. */
  onLoopDragCommit?: (which: 'start' | 'end', eventId: string) => void;
  /** Whether system-played notes should stay red. */
  colorSystemNotes: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onSelectEvent: (eventId: string) => void;
  onInteractionStart?: () => void;
  onRendered?: () => void;
  /** Engraver zoom (OSMD Zoom). Default 1.0; reading drills render larger. */
  zoom?: number;
}

/** Fixed natural width: no downscaling on narrow screens; the outer pane scrolls. */
export const ENGRAVED_SCORE_WIDTH = 1510;
/** Loose-tap fallback radius: finger taps cannot reliably hit a small notehead. */
const TAP_TOLERANCE_PX = 48;
/** How far a released loop handle may be from a note to snap to it. */
const DRAG_SNAP_PX = 400;
/** Pointer travel below this is a TAP on the band, not a handle drag. */
const TAP_SLOP_PX = 6;
const EMPTY_NOTE_IDS: string[] = [];

/**
 * Professional MusicXML engraving (OSMD/VexFlow + Bravura). This is display
 * only: the Rust engine remains the scoring authority. The adapter maps domain
 * note-event IDs to OSMD graphical notes for active-target coloring and click.
 */
export default function OsmdScoreView({
  reviewStates,
  width = ENGRAVED_SCORE_WIDTH,
  fitWidth = false,
  xml,
  engine,
  activeNoteIds,
  follow,
  followSignal,
  systemNoteIds,
  userNoteIds,
  mutedNoteIds = EMPTY_NOTE_IDS,
  loopRangeNotes = null,
  onLoopDragCommit,
  colorSystemNotes,
  scrollRef,
  onSelectEvent,
  onInteractionStart,
  onRendered,
  zoom = 1.0,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const previousReviewRef = useRef<string[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const adapterRef = useRef<OsmdScoreViewAdapter | null>(null);
  const previousActiveRef = useRef<string[]>([]);
  const previousSystemRef = useRef<string[]>([]);
  const previousUserRef = useRef<string[]>([]);
  const previousMutedRef = useRef<string[]>([]);
  const onScoreTapRef = useRef<(() => void) | null>(null);
  const widthRetryRef = useRef(false);
  const selectRef = useRef(onSelectEvent);
  const interactionRef = useRef(onInteractionStart); interactionRef.current = onInteractionStart;
  const renderedRef = useRef(onRendered);
  const commitRef = useRef(onLoopDragCommit);
  commitRef.current = onLoopDragCommit;
  selectRef.current = onSelectEvent;
  renderedRef.current = onRendered;
  const dragRef = useRef<{ which: 'start' | 'end'; pointerId: number; startX: number; startY: number; moved: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [viewportEpoch, setViewportEpoch] = useState(0);
  const [loopHighlights, setLoopHighlights] = useState<Array<{ system: number; left: number; top: number; width: number; height: number }>>([]);
  const [dragGuide, setDragGuide] = useState<{ which: 'start' | 'end'; x: number } | null>(null);

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
        host.dataset.osmdStage = 'importing';
        const { OpenSheetMusicDisplay, MusicSystemBuilder } = await import('opensheetmusicdisplay');
        if (cancelled) return;
        const options = {
          autoResize: false,
          backend: 'svg' as const,
          drawTitle: false,
          drawComposer: false,
          drawCredits: false,
          // 部件名只画在首行,会把第一行谱面推向右侧,与后续行错位;页面
          // 自带标题/题号上下文,这里不画,保证所有行同一左缘对齐。
          drawPartNames: false,
          drawPartAbbreviations: false,
          drawMeasureNumbers: true,
          drawMeasureNumbersOnlyAtSystemStart: true,
          followCursor: false,
          disableCursor: true,
        };
        // Only the engraving receives padded XML; mapping/scoring retain engine.
        const osmd = new OpenSheetMusicDisplay(host, options);
        osmdRef.current = osmd;
        applyMeasureGrid(osmd);
        host.dataset.osmdStage = 'loading';
        const grid = prepareMeasureGrid(xml);
        await osmd.load(grid.xml);
        if (cancelled) return;
        host.dataset.osmdStage = 'rendering';
        osmd.Zoom = zoom;
        renderMeasureGrid(osmd, host, MusicSystemBuilder);
        if (cancelled) return;
        host.dataset.osmdGrid = JSON.stringify({ columns: 4, measures: grid.measureCount, slots: grid.slotCount });
        host.dataset.osmdStage = 'done';
        if (cancelled) return;

        const adapter = new OsmdScoreViewAdapter(osmd);
        const mapping = adapter.buildMapping(engine);
        adapterRef.current = adapter;
        host.dataset.osmdMapped = String(mapping.mappedEventCount);
        host.dataset.osmdTotal = String(mapping.noteEventCount);
        host.dataset.osmdDuplicates = String(mapping.duplicateGraphicalRefs.length);
        // Ambiguous anchors are never highlighted; expose the state for
        // diagnostics instead of guessing which notehead to colour.
        host.dataset.osmdConflicts = String(mapping.conflicts.length);
        host.dataset.osmdAnchorStatus = mapping.anchorStatus;
        host.dataset.osmdMappingVersion = mapping.mappingVersion;

        // Tap routing lives on the HOST and resolves targets LAZILY through
        // the adapter at click time — never from a closure snapshot, so the
        // handler can never go stale against a rebuilt SVG. A direct hit
        // resolves to its note; a loose tap (a finger cannot reliably hit a
        // ~12px notehead) falls back to the nearest mapped note within
        // TAP_TOLERANCE_PX. Chord members share one group; first-wins maps
        // them to the earliest member.
        for (const [, ref] of mapping.byEventId) {
          const graphical = ref.graphicalNotes[0] as unknown as { getSVGGElement?: () => SVGGElement };
          const element = graphical.getSVGGElement?.();
          if (element) element.style.cursor = 'pointer';
        }
        const onScoreTap = (event: MouseEvent) => {
          host.dataset.tapHits = String((Number(host.dataset.tapHits) || 0) + 1);
          const adapter = adapterRef.current;
          if (!adapter) { host.dataset.tapMatch = 'no-adapter'; return; }
          const direct = adapter.resolveTapEventId(event.target);
          if (direct) {
            host.dataset.tapMatch = 'direct';
            selectRef.current(direct);
            return;
          }
          const best = adapter.nearestTapEventId(event.clientX, event.clientY, TAP_TOLERANCE_PX);
          if (best) {
            host.dataset.tapMatch = `nearest:${Math.round(best.distance)}px`;
            selectRef.current(best.eventId);
          } else {
            host.dataset.tapMatch = 'miss';
            host.dataset.tapDebug = JSON.stringify(adapter.debugTapMiss(event.target));
          }
        };
        onScoreTapRef.current = bindNoteSelection(host, onScoreTap);
        host.dataset.tapTargets = String(adapter.getTapTargetCount());
        host.dataset.tapAttached = '1';

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
      onScoreTapRef.current?.();
      onScoreTapRef.current = null;
      try { osmdRef.current?.clear(); } catch { /* best effort */ }
      osmdRef.current = null;
      adapterRef.current = null;
      if (host) host.innerHTML = '';
    };
  // Fitting is CSS-only: entering focus and rotating the screen preserve the
  // existing SVG, note mapping and highlights instead of restarting engraving.
  }, [xml, engine, layoutEpoch, zoom, width]);

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

  // Current target = blue; completed user targets = green; system notes = red.
  // The user-paced guide owns completion highlights independently of timing grades.
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter || loading) return;
    const systemSet = new Set(systemNoteIds);
    for (const id of previousReviewRef.current) adapter.highlightScoreEvent(id, 'default');
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
    for (const [id, state] of Object.entries(reviewStates ?? {})) adapter.highlightScoreEvent(id, state);
    previousReviewRef.current = Object.keys(reviewStates ?? {});
    // Current expected position is applied last so it is always visible.
    for (const eventId of activeNoteIds) adapter.highlightScoreEvent(eventId, 'current');
    previousActiveRef.current = [...activeNoteIds];
    previousSystemRef.current = [...systemNoteIds];
    previousUserRef.current = [...userNoteIds];
  }, [activeNoteIds, systemNoteIds, userNoteIds, colorSystemNotes, loading, reviewStates]);

  // Single-hand practice keeps the other staff visible for context, but the
  // non-target notes are de-emphasized instead of looking equally active.
  // The adapter also dims VexFlow's sibling stem/beam/ledger/flag groups.
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter || loading) return;
    for (const eventId of previousMutedRef.current) adapter.setScoreEventOpacity(eventId, '');
    for (const eventId of mutedNoteIds) adapter.setScoreEventOpacity(eventId, '0.45');
    previousMutedRef.current = [...mutedNoteIds];
  }, [mutedNoteIds, loading]);

  // Loop band, driven by the explicit layout model (score-layout.ts):
  // systems = staff-line pairs, and the band is a pure function of the two
  // boundary notes. No clustering thresholds, no re-clipping. The band is a
  // segment of ONE continuous strip (the score's reading order); systems are
  // only the line wrapping it has to be painted through.
  const loopRangeKey = loopRangeNotes ? `${loopRangeNotes.start.eventId}|${loopRangeNotes.end.eventId}` : '';
  useEffect(() => {
    if (loading) return;
    const root = rootRef.current;
    const host = hostRef.current;
    if (!root || !host) return;

    const update = () => {
      const adapter = adapterRef.current;
      const startRect = adapter?.getNoteRect(loopRangeNotes?.start?.eventId ?? null) ?? null;
      const endRect = adapter?.getNoteRect(loopRangeNotes?.end?.eventId ?? null) ?? null;
      if (!startRect || !endRect || startRect.width === 0 || endRect.width === 0) {
        setLoopHighlights((current) => (current.length ? [] : current));
        return;
      }
      const rootRect = root.getBoundingClientRect();
      const relative = (rect: DOMRect) => ({
        top: rect.top - rootRect.top,
        bottom: rect.bottom - rootRect.top,
        left: rect.left - rootRect.left,
        right: rect.right - rootRect.left,
      });
      const stavesPerSystem = Math.max(1, engine.parts.reduce((sum, part) => sum + part.staves, 0));
      const stafflines = [...host.querySelectorAll<SVGGElement>("g.staffline")]
        .map((line) => relative(line.getBoundingClientRect()));
      const systems = groupSystems(stafflines, stavesPerSystem);
      // The score is ONE continuous strip; systems are only line wrapping.
      // The band therefore runs from A's note to B's note through every
      // wrapped system in between — no measure-grid row arithmetic, so a
      // different wrap can never move or drop a segment.
      const boxes = loopBandBoxes(systems, relative(startRect), relative(endRect));
      setLoopHighlights(boxes.map((box) => ({
        system: box.system,
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      })));
    };

    // First measure can run before the engraving has settled: the SVG is
    // scaled by the fitted layout and the Bravura font may still be loading,
    // so note rects shift after this effect starts. Re-measure on the next
    // paint, once fonts are ready, and whenever the host/SVG resizes — a band
    // measured against the pre-layout rects would sit on the wrong rows.
    let cancelled = false;
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (!cancelled) update();
      });
    };
    update();
    schedule();
    const fontsReady = typeof document !== 'undefined' ? document.fonts?.ready : undefined;
    void fontsReady?.then(() => schedule());
    const settleTimer = window.setTimeout(schedule, 300);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    observer?.observe(host);
    const svg = host.querySelector('svg');
    if (svg) observer?.observe(svg);
    window.addEventListener('resize', schedule);
    return () => {
      cancelled = true;
      window.clearTimeout(settleTimer);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [loopRangeKey, loading]);

  // A/B handle dragging: the handle follows the pointer (root-relative), and
  // on release the boundary snaps to the nearest mapped note and commits.
  const rootRelativeX = (clientX: number) => {
    const root = rootRef.current;
    return root ? clientX - root.getBoundingClientRect().left : clientX;
  };
  const rootRelativeY = (clientY: number) => {
    const root = rootRef.current;
    return root ? clientY - root.getBoundingClientRect().top : clientY;
  };
  const beginLoopDrag = (which: 'start' | 'end') => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (rootRef.current) rootRef.current.dataset.drag = `begin:${which}:${commitRef.current ? 'hasCommit' : 'NO_COMMIT'}`;
    if (!commitRef.current) return;
    interactionRef.current?.();
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { which, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic events have no active pointer */ }
    setDragGuide({ which, x: rootRelativeX(event.clientX) });
  };
  const handleLoopDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > TAP_SLOP_PX) drag.moved = true;
    setDragGuide({ which: drag.which, x: rootRelativeX(event.clientX) });
  };
  /** Grabbing anywhere on the band drags the NEAREST edge — the 9px visual
   * bars are too small to aim at, so the whole band is the hit area. The band
   * is one wrapped strip: B may sit to the LEFT of A in x, so the edge is
   * picked by distance to each handle, never by an x midpoint. */
  const beginLoopDragFromLayer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!commitRef.current) return;
    interactionRef.current?.();
    const target = event.target as HTMLElement;
    if (target.closest('.osmd-loop-handle')) return; // the handle's own handler runs
    const bandBox = target.closest('.osmd-loop-highlight');
    if (!bandBox) return;
    const sorted = [...loopHighlights].sort((x, y) => x.system - y.system);
    if (!sorted.length) return;
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    // Both band boxes and the handle anchors are ROOT-relative, so the
    // pointer must be converted before comparing.
    const which = nearestLoopEdge(
      { x: rootRelativeX(event.clientX), y: rootRelativeY(event.clientY) },
      { left: first.left, top: first.top, height: first.height },
      { left: last.left + last.width, top: last.top, height: last.height },
    );
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { which, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic events have no active pointer */ }
    setDragGuide({ which, x: rootRelativeX(event.clientX) });
  };
  const endLoopDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (rootRef.current) rootRef.current.dataset.dragEnd = drag ? `${drag.which}:pid${drag.pointerId}vs${event.pointerId}` : 'no-drag';
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragGuide(null);
    const best = adapterRef.current?.nearestTapEventId(event.clientX, event.clientY, drag.moved ? DRAG_SNAP_PX : TAP_TOLERANCE_PX);
    if (rootRef.current) rootRef.current.dataset.dragSnap = best ? `hit:${Math.round(best.distance)}` : 'miss';
    if (!best) return;
    // A tap on the band is a range adjustment, not a handle drag: route it
    // through the same note-pick path as a tap on the score, so the endpoint
    // chosen is the one nearest the note in reading order (musically), not
    // the handle that happens to be closest on screen.
    if (!drag.moved) selectRef.current(best.eventId);
    else commitRef.current?.(drag.which, best.eventId);
  };

  /** Staves per system, derived from the document (used by systemRects). */
  const stavesPerSystemForLayout = () => Math.max(1, engine.parts.reduce((sum, part) => sum + part.staves, 0));
  const systemRects = () => {
    const lines = [...hostRef.current?.querySelectorAll<SVGGElement>('g.staffline') ?? []];
    return Array.from({ length: Math.ceil(lines.length / stavesPerSystemForLayout()) }, (_, index) => {
      const group = lines.slice(index * stavesPerSystemForLayout(), (index + 1) * stavesPerSystemForLayout());
      const rects = group.map((line) => line.getBoundingClientRect());
      return { lines: group, top: Math.min(...rects.map((rect) => rect.top)), bottom: Math.max(...rects.map((rect) => rect.bottom)) };
    });
  };

  // Display-only trailing space lets even the final system reach the top.
  const followViewport = followSignal > 0;
  useEffect(() => {
    const outer = scrollRef.current;
    const root = rootRef.current;
    if (loading || !outer || !root || !followViewport) return;
    root.style.marginBlock = '0px';
    const update = () => {
      const last = systemRects().at(-1);
      if (!last) return;
      const rootRect = root.getBoundingClientRect();
      const currentPadding = parseFloat(root.style.paddingBottom) || 0;
      const naturalHeight = rootRect.height - currentPadding;
      const lastTop = last.top - rootRect.top;
      const style = getComputedStyle(outer);
      const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      root.style.paddingBottom = `${Math.max(0, outer.clientHeight + lastTop - naturalHeight - padding + 2)}px`;
    };
    update();
    let width = outer.clientWidth;
    let height = outer.clientHeight;
    const observer = new ResizeObserver(() => {
      update();
      if (outer.clientWidth !== width || outer.clientHeight !== height) {
        width = outer.clientWidth; height = outer.clientHeight;
        setViewportEpoch((value) => value + 1);
      }
    });
    observer.observe(outer);
    return () => { observer.disconnect(); root.style.paddingBottom = ''; root.style.marginBlock = ''; };
  }, [loading, fitWidth, engine, scrollRef, followViewport]);

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
    const line = element.closest('g.staffline');
    const system = systemRects().find((system) => line && system.lines.includes(line as SVGGElement));
    if (!system) return;
    const viewRect = outer.getBoundingClientRect();
    const margin = parseFloat(getComputedStyle(outer).paddingTop) || 8;
    // A note tap fires the follow signal while the system is already on
    // screen. Re-aligning it would scroll the pane under the fixed toolbar
    // and look like the page jumping; only move when the system is clipped.
    if (!needsFollowScroll(system, viewRect, margin)) return;
    const top = Math.max(0, outer.scrollTop + system.top - viewRect.top - margin);
    if (Math.abs(outer.scrollTop - top) > 2) outer.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [followSignal, follow, loading, fitWidth, viewportEpoch, scrollRef]);

  return (
    <div
      ref={rootRef}
      className={`osmd-score${fitWidth ? ' is-fit' : ''}`}
      style={fitWidth ? { width: '100%', minWidth: 0 } : { width, minWidth: width }}
    >
      <div className="osmd-host" ref={hostRef} aria-label="专业制谱渲染" />
      {loopHighlights.length > 0 && (
        <div className="osmd-loop-highlight-layer" aria-hidden="true" onPointerDown={beginLoopDragFromLayer} onPointerMove={handleLoopDragMove} onPointerUp={endLoopDrag} onPointerCancel={endLoopDrag}>
          {(() => {
            const sorted = [...loopHighlights].sort((a, b) => a.system - b.system);
            // The band is the committed strip segment; while a handle is
            // dragged only the handle/guide follows the finger, and the band
            // re-derives from the two boundary notes on release. Clipping the
            // boxes by pointer x would be row algebra again and cuts the
            // wrong rows in a wrapped range.
            const bands = sorted;
            // Close the gap between rows: a band extends to the next row top,
            // while the A/B handles keep the fixed height so they stay equal.
            const rowTopOf = (top: number) => Math.round(top);
            const rows = [...new Set(bands.map((box) => rowTopOf(box.top)))].sort((a, b) => a - b);
            const extended = bands.map((box) => {
              const rowIndex = rows.indexOf(rowTopOf(box.top));
              const nextTop = rowIndex >= 0 ? rows[rowIndex + 1] : undefined;
              return typeof nextTop === "number" ? { ...box, height: nextTop - box.top } : box;
            });
            if (!bands.length) return null;
            const first = bands[0];
            const last = bands[bands.length - 1];
            const dragX = dragGuide ? dragGuide.x : null;
            return (
              <>
                {extended.map((cover) => (
                  <div
                    key={cover.system}
                    className="osmd-loop-highlight"
                    data-system={cover.system}
                    style={{ left: cover.left, top: cover.top, width: cover.width, height: cover.height }}
                  />
                ))}
                <div
                  className="osmd-loop-flag"
                  data-which="start"
                  style={{ left: dragGuide?.which === 'start' && dragX !== null ? dragX : first.left, top: first.top + 2 }}
                >A</div>
                <div
                  className={`osmd-loop-handle${dragGuide?.which === 'start' ? ' dragging' : ''}`}
                  data-which="start"
                  style={{ left: dragGuide?.which === 'start' && dragX !== null ? dragX : first.left, top: first.top, height: first.height }}
                  onPointerDown={beginLoopDrag('start')}
                  onPointerMove={handleLoopDragMove}
                  onPointerUp={endLoopDrag}
                  onPointerCancel={endLoopDrag}
                />
                <div
                  className="osmd-loop-flag"
                  data-which="end"
                  style={{ left: dragGuide?.which === 'end' && dragX !== null ? dragX : last.left + last.width, top: last.top + 2 }}
                >B</div>
                <div
                  className={`osmd-loop-handle${dragGuide?.which === 'end' ? ' dragging' : ''}`}
                  data-which="end"
                  style={{ left: dragGuide?.which === 'end' && dragX !== null ? dragX : last.left + last.width, top: last.top, height: last.height }}
                  onPointerDown={beginLoopDrag('end')}
                  onPointerMove={handleLoopDragMove}
                  onPointerUp={endLoopDrag}
                  onPointerCancel={endLoopDrag}
                />
                {dragGuide && <div className="osmd-loop-dragline" style={{ left: dragGuide.x, top: 0, height: '100%' }} />}
              </>
            );
          })()}
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
