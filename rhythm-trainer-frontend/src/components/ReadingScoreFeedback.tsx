import { useEffect, useMemo, useRef, useState } from 'react';
import { readingFeedbackXml } from '../features/reading/readingNotation';
import type { KeySelection } from '../features/reading/readingKeys';

interface Props {
  targets: readonly number[];
  hits: readonly number[];
  wrongPitches: readonly number[];
  staff: 1 | 2;
  musicKey: KeySelection | null;
}

/** An isolated display engraving. Extra red notes are never parsed as targets. */
export default function ReadingScoreFeedback({ targets, hits, wrongPitches, staff, musicKey }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const xml = useMemo(() => readingFeedbackXml(targets, hits, wrongPitches, staff, musicKey), [targets, hits, wrongPitches, staff, musicKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let committed = false;
    const layer = document.createElement('div');
    layer.className = 'reading-engraving-layer';
    layer.style.width = '760px';
    layer.style.position = 'absolute';
    layer.style.visibility = 'hidden';
    host.append(layer);
    setError(null);
    void (async () => {
      try {
        const { OpenSheetMusicDisplay, ColoringModes } = await import('opensheetmusicdisplay');
        if (cancelled) return;
        const renderer = new OpenSheetMusicDisplay(layer, {
          autoResize: false, backend: 'svg', drawTitle: false, drawComposer: false, drawCredits: false,
          drawPartNames: false, drawPartAbbreviations: false, drawMeasureNumbers: false,
          drawTimeSignatures: false, disableCursor: true, coloringEnabled: true, coloringMode: ColoringModes.XML,
        });
        await renderer.load(xml);
        if (cancelled) return;
        renderer.EngravingRules.FixedMeasureWidth = true;
        renderer.EngravingRules.FixedMeasureWidthFixedValue = 23;
        renderer.Zoom = 1.8;
        renderer.render();
        if (cancelled) return;
        // Swap the complete engraving so quick key events never blank the staff.
        for (const previous of Array.from(host.children)) if (previous !== layer) previous.remove();
        layer.style.position = 'relative';
        layer.style.visibility = 'visible';
        host.dataset.renderedXml = xml;
        committed = true;
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { cancelled = true; if (!committed) layer.remove(); };
  }, [xml]);

  return <div className="reading-note-feedback">
    <div ref={hostRef} className="reading-note-engraving" aria-label="识谱音符反馈" />
    {error && <p role="alert">音符渲染失败：{error}</p>}
  </div>;
}
