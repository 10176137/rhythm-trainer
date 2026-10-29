import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { applyMeasureGrid, prepareMeasureGrid, renderMeasureGrid } from './osmdEngraving';

interface Props {
  xml: string;
  zoom: number;
  /** CSS-fit the engraved SVG to the reading pane without re-engraving. */
  fitWidth?: boolean;
  onRendered?: () => void;
}

/**
 * Display-only OSMD reader. It intentionally has no ScoreViewAdapter or
 * scoring highlight: semantic parsing, ImportReport and OSMD rendering remain
 * separate facts. The container is fluid; zoom is a CSS reading scale.
 */
export default function ScoreReader({ xml, zoom, fitWidth = false, onRendered }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const renderedRef = useRef(onRendered);
  renderedRef.current = onRendered;

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';
    osmdRef.current = null;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const { OpenSheetMusicDisplay, MusicSystemBuilder } = await import('opensheetmusicdisplay');
        if (cancelled) return;
        const options = {
          autoResize: false,
          backend: 'svg' as const,
          drawTitle: false,
          drawComposer: false,
          drawCredits: false,
          // 与 OsmdScoreView 一致:部件名会把首行推向右侧造成行间错位。
          drawPartNames: false,
          drawPartAbbreviations: false,
          drawMeasureNumbers: true,
          drawMeasureNumbersOnlyAtSystemStart: true,
          followCursor: false,
          disableCursor: true,
        };
        // Padding is visual only; the original score remains unchanged.
        const osmd = new OpenSheetMusicDisplay(host, options);
        applyMeasureGrid(osmd);
        const grid = prepareMeasureGrid(xml);
        await osmd.load(grid.xml);
        if (cancelled) return;
        osmd.Zoom = 1;
        renderMeasureGrid(osmd, host, MusicSystemBuilder);
        if (cancelled) return;
        host.dataset.osmdGrid = JSON.stringify({ columns: 4, measures: grid.measureCount, slots: grid.slotCount });
        if (cancelled) return;
        osmdRef.current = osmd;
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
      if (host) host.innerHTML = '';
    };
    // The XML is loaded once per document; the reading scale is CSS-only so
    // changing zoom never re-engages the engraver or loses the mapping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xml]);

  return (
    <div className="score-reader-canvas">
      <div
        className={`score-reader-host${fitWidth ? ' is-fit' : ''}`}
        ref={hostRef}
        aria-label="专业制谱阅读区"
        style={fitWidth ? undefined : ({ transform: `scale(${zoom})`, transformOrigin: 'top left' } as CSSProperties)}
      />
      {loading && <div className="osmd-status" role="status">正在用 Bravura 制谱引擎渲染…</div>}
      {error && (
        <div className="osmd-status osmd-status-error" role="alert">
          乐谱渲染失败：{error}
        </div>
      )}
    </div>
  );
}
