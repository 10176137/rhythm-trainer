import type { ReactNode } from 'react';

interface AppShellProps {
  focus?: boolean;
  /** Immersive practice: no sidebar/topbar, the score owns the screen. */
  immersive?: boolean;
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
export default function AppShell({ focus = false, immersive = false, sidebar, topbar, notice, children }: AppShellProps) {
  return (
    <div className={`app-shell${focus ? ' practice-focus' : ''}${immersive ? ' immersive' : ''}`}>
      {immersive ? null : sidebar}
      <main className="main-area">
        {immersive ? null : topbar}
        {notice ? <div className="page-content app-global-notice">{notice}</div> : null}
        {children}
      </main>
    </div>
  );
}
