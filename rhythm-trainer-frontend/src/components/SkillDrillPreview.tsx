import { useMemo, useRef } from 'react';
import { importScoreText } from '../features/score/scoreImport';
import OsmdScoreView from './OsmdScoreView';

/** The preview and the launch consume the same generated MusicXML. */
export default function SkillDrillPreview({ xml }: { xml: string }) {
  const parsed = useMemo(() => importScoreText(xml, 'training-preview.musicxml'), [xml]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  if (!parsed.doc?.engine) return <p role="alert">当前练习谱无法预览，请调整训练选项。</p>;
  return <div ref={scrollRef} className="skill-sheet-preview" aria-label="基本功练习谱预览">
    <OsmdScoreView xml={xml} engine={parsed.doc.engine} width={860} activeNoteIds={[]} follow={false} followSignal={0}
      systemNoteIds={[]} userNoteIds={[]} colorSystemNotes={false} scrollRef={scrollRef} onSelectEvent={() => {}} />
  </div>;
}
