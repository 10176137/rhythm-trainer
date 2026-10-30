import { Capacitor } from '@capacitor/core';
import { useId, useState, type ReactNode } from 'react';

/** Aids stay available without taking space from the tablet score by default. */
export default function PracticeExtras({ children }: { children: ReactNode }) {
  const [native] = useState(() => Capacitor.isNativePlatform());
  const [expanded, setExpanded] = useState(!native);
  const id = useId();
  return <aside className="practice-dock">
    {native && <button type="button" className="practice-dock-toggle" aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded((value) => !value)}>练习辅助 <span>{expanded ? '收起 ⌄' : '输入状态与反馈 ⌃'}</span></button>}
    <div id={id} className="practice-dock-content" hidden={!expanded}>{children}</div>
  </aside>;
}
