import { PracticeChromeContext, usePracticeChrome } from '../features/practice/usePracticeChrome';
import type { ReactNode } from 'react';

interface AppShellProps {
  focus?: boolean;
  /** Immersive practice: no sidebar/topbar, the score owns the screen. */
  immersive?: boolean;
  revealControls?: boolean;
  sidebar: ReactNode;
  topbar: ReactNode;
  /** Page-independent status, e.g. an engine/MIDI error that must survive route changes. */
  notice?: ReactNode;
  children: ReactNode;
}

/**
 * The one application frame. Page-specific content stays in the current
 * workbench/HistoryView/ProfileView components; this component only owns the
 * shared sidebar/main layout and the global notice slot.
 */
export default function AppShell({ focus = false, immersive = false, revealControls = false, sidebar, topbar, notice, children }: AppShellProps) {
  const chrome = usePracticeChrome(immersive, revealControls);
  return (
    <PracticeChromeContext.Provider value={chrome.visible}>
    <div ref={chrome.stageRef} tabIndex={immersive ? 0 : undefined} aria-label={immersive ? '演奏谱面，轻点空白或按 Tab 显示控制' : undefined} className={`app-shell${focus ? ' practice-focus' : ''}${immersive ? ` immersive chrome-enabled${chrome.visible ? ' controls-visible' : ''}` : ''}`}>
      {immersive ? null : sidebar}
      <main className="main-area">
        {immersive ? null : topbar}
        {notice ? <div className="page-content app-global-notice">{notice}</div> : null}
        {children}
      </main>
    </div>
    </PracticeChromeContext.Provider>
  );
}
