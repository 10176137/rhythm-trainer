import type { ReactNode } from 'react';

interface AppShellProps {
  focus?: boolean;
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
export default function AppShell({ focus = false, sidebar, topbar, notice, children }: AppShellProps) {
  return (
    <div className={`app-shell${focus ? ' practice-focus' : ''}`}>
      {sidebar}
      <main className="main-area">
        {topbar}
        {notice ? <div className="page-content app-global-notice">{notice}</div> : null}
        {children}
      </main>
    </div>
  );
}
