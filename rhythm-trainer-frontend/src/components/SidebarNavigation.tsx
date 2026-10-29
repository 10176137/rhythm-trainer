import { useEffect, useState } from 'react';
import { NAV_ROUTES, type AppRouteId } from '../app/routes';

const GROUPS = [
  { id: 'practice', title: '练习空间', routes: ['performance', 'workbench', 'training'] },
  { id: 'personal', title: '我的空间', routes: ['history', 'settings'] },
] as const;

export function navigationParent(routeId?: AppRouteId): string {
  return GROUPS.find((group) => group.routes.some((id) => id === routeId))?.title ?? '学习';
}

export default function SidebarNavigation({ routeId, onNavigate }: {
  routeId?: AppRouteId;
  onNavigate: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ practice: true, personal: true });
  useEffect(() => {
    const active = GROUPS.find((group) => group.routes.some((id) => id === routeId));
    if (active) setExpanded((previous) => ({ ...previous, [active.id]: true }));
  }, [routeId]);

  return <nav className="main-nav grouped-navigation" aria-label="主导航">
    {GROUPS.map((group) => {
      const active = group.routes.some((id) => id === routeId);
      return <div className={`navigation-group${active ? ' contains-current' : ''}`} key={group.id}>
        <button type="button" className="navigation-parent" aria-expanded={expanded[group.id]} aria-controls={`navigation-${group.id}`}
          onClick={() => setExpanded((previous) => ({ ...previous, [group.id]: !previous[group.id] }))}>
          <span className="navigation-folder" aria-hidden="true">▱</span><span>{group.title}</span>
          <span className="navigation-chevron" aria-hidden="true">{expanded[group.id] ? '⌄' : '›'}</span>
        </button>
        <div id={`navigation-${group.id}`} className="navigation-children" hidden={!expanded[group.id]}>
          {group.routes.map((id) => {
            const item = NAV_ROUTES.find((entry) => entry.id === id);
            if (!item) return null;
            return <button type="button" key={id} className={`nav-item ${routeId === id ? 'active' : ''}`}
              aria-current={routeId === id ? 'page' : undefined} aria-label={item.navTitle ?? item.title}
              title={`${group.title} / ${item.title}`} onClick={() => onNavigate(item.path)}>
              <span className="nav-icon" aria-hidden="true">{item.icon}</span><span>{item.navTitle ?? item.title}</span>
            </button>;
          })}
        </div>
      </div>;
    })}
  </nav>;
}
