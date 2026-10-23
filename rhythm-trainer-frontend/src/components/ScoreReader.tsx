import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';

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
        const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay');
        if (cancelled) return;
        const osmd = new OpenSheetMusicDisplay(host, {
          autoResize: true,
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
        await osmd.load(xml);
        if (cancelled) return;
        osmd.Zoom = 1;
        osmd.render();
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
