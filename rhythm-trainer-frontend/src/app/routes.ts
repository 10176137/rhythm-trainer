export type AppRouteId =
  | 'training'
  | 'performance'
  | 'workbench'
  | 'teaching'
  | 'progress'
  | 'history'
  | 'profile'
  | 'scores'
  | 'import'
  | 'reader'
  | 'device'
  | 'settings'
  | 'report';

export interface AppRouteDefinition {
  id: AppRouteId;
  path: string;
  title: string;
  /** Short label in the primary navigation; falls back to `title`. */
  navTitle?: string;
  /** Icon shown in the sidebar for implemented navigation pages. */
  icon?: string;
  nav: boolean;
  /** A0 only implements the three existing pages. */
  enabled: boolean;
  description: string;
}

/**
 * Single route registry. Future pages are registered here so direct URLs and
 * later navigation can be added without inventing a second route state.
 * `enabled: false` means the page is not available and must render the
 * placeholder, never fake data.
 */
export const APP_ROUTES: readonly AppRouteDefinition[] = [
  { id: 'training', path: '/training', title: '专项训练', navTitle: '专项训练', icon: '◎', nav: true, enabled: true, description: '有明确目标的拍点、均分、切分和双手训练。' },
  { id: 'performance', path: '/performance', title: '演奏', navTitle: '演奏', icon: '♫', nav: true, enabled: true, description: '读谱演奏与固定线演奏，可在页内切换。' },
  {
    id: 'teaching',
    path: '/teaching',
    title: '老师带练',
    navTitle: '学习',
    icon: '✎',
    nav: false,
    enabled: true,
    description: '按步骤带练当前曲谱：讲解、单手、合手、原速通过检查。',
  },
  {
    id: 'workbench',
    path: '/workbench',
    title: '练习工作台',
    navTitle: '识谱',
    icon: '▤',
    nav: true,
    enabled: true,
    description: '自由练习、参考播放、实时反馈与设置。',
  },
  {
    id: 'progress',
    path: '/progress',
    title: '学习进度',
    navTitle: '进度',
    icon: '◷',
    nav: false,
    enabled: true,
    description: '能力画像与已保存的练习记录。',
  },
  {
    id: 'scores',
    path: '/scores',
    title: '曲谱库',
    icon: '♬',
    nav: false,
    enabled: true,
    description: '导入、检查并打开 MusicXML 曲谱。',
  },
  {
    id: 'history',
    path: '/history',
    title: '练习记录',
    navTitle: '记录',
    icon: '◷',
    nav: true,
    enabled: true,
    description: '已保存的练习轮次与报告。',
  },
  {
    id: 'profile',
    path: '/profile',
    title: '能力画像',
    icon: '⌁',
    nav: false,
    enabled: true,
    description: '按练习模式聚合的掌握状态与近期趋势。',
  },
  {
    id: 'import',
    path: '/import',
    title: '导入曲谱',
    nav: false,
    enabled: false,
    description: '独立导入与解析结果页面，A1 交付。',
  },
  {
    id: 'reader',
    path: '/reader',
    title: '曲谱阅读',
    nav: false,
    enabled: true,
    description: 'OSMD 专业谱面阅读与缩放。',
  },
  {
    id: 'device',
    path: '/device',
    title: '设备检查',
    icon: '⌨',
    nav: false,
    enabled: true,
    description: 'MIDI 连接、按键测试与输入健康。',
  },
  {
    id: 'settings',
    path: '/settings',
    title: '总设置',
    navTitle: '设置',
    icon: '⚙',
    nav: true,
    enabled: true,
    description: '管理判定、显示辅助、默认手别与曲谱设置。',
  },
  {
    id: 'report',
    path: '/report',
    title: '练习报告',
    nav: false,
    enabled: false,
    description: '完整 P08 报告页面，B1 交付。',
  },
];

export const DEFAULT_ROUTE_PATH = '/workbench';

export const NAV_ROUTES = APP_ROUTES.filter((route) => route.nav && route.enabled);

/** Strip query/hash and trailing slashes; always return an absolute path. */
export function normalizePath(raw: string): string {
  const withoutQuery = (raw || '/').split('?')[0].split('#')[0];
  const withoutTrailing = withoutQuery.replace(/\/+$/, '');
  if (!withoutTrailing) return '/';
  return withoutTrailing.startsWith('/') ? withoutTrailing : `/${withoutTrailing}`;
}

export function matchAppRoute(pathname: string): {
  route: AppRouteDefinition | null;
  path: string;
} {
  const normalized = normalizePath(pathname);
  const path = normalized === '/' || normalized === '/index.html'
    ? DEFAULT_ROUTE_PATH
    : normalized;
  return {
    route: APP_ROUTES.find((route) => route.path === path) ?? null,
    path,
  };
}

export function routeTitle(route: AppRouteDefinition | null): string {
  return route?.title ?? '页面不存在';
}
