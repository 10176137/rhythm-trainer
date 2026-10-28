import { describe, expect, it } from 'vitest';
import { APP_ROUTES, DEFAULT_ROUTE_PATH, NAV_ROUTES, matchAppRoute, normalizePath } from './routes';

describe('app route registry', () => {
  it('normalizes paths and ignores query/hash/trailing slashes', () => {
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/history/')).toBe('/history');
    expect(normalizePath('/history?tab=all#top')).toBe('/history');
  });

  it('maps the root and index.html to the default workbench', () => {
    expect(matchAppRoute('/').path).toBe(DEFAULT_ROUTE_PATH);
    expect(matchAppRoute('/index.html').route?.id).toBe('workbench');
    expect(matchAppRoute('/workbench').route?.id).toBe('workbench');
  });

  it('exposes reading and the merged performance workspace', () => {
    expect(NAV_ROUTES.map((route) => route.id)).toEqual(['performance', 'workbench']);
    expect(NAV_ROUTES.map((route) => route.navTitle)).toEqual(['演奏', '识谱']);
    expect(NAV_ROUTES.every((route) => route.enabled)).toBe(true);
    expect(new Set(APP_ROUTES.map((route) => route.path)).size).toBe(APP_ROUTES.length);
    // Secondary pages stay reachable by URL but leave the primary nav.
    expect(APP_ROUTES.filter((route) => ['scores', 'history', 'profile', 'device'].includes(route.id))
      .every((route) => route.nav === false)).toBe(true);
  });

  it('registers the teaching and progress workspaces', () => {
    const teaching = matchAppRoute('/teaching');
    expect(teaching.route?.id).toBe('teaching');
    expect(teaching.route?.enabled).toBe(true);
    expect(teaching.route?.nav).toBe(false);
    const progress = matchAppRoute('/progress');
    expect(progress.route?.id).toBe('progress');
    expect(progress.route?.enabled).toBe(true);
    expect(progress.route?.nav).toBe(false);
  });

  it('enables A1 pages and reserves later paths without enabling them', () => {
    const scores = matchAppRoute('/scores');
    expect(scores.route?.id).toBe('scores');
    expect(scores.route?.enabled).toBe(true);
    const reader = matchAppRoute('/reader');
    expect(reader.route?.id).toBe('reader');
    expect(reader.route?.enabled).toBe(true);
    const report = matchAppRoute('/report');
    expect(report.route?.id).toBe('report');
    expect(report.route?.enabled).toBe(false);
  });

  it('returns null for unknown paths', () => {
    expect(matchAppRoute('/not-a-page').route).toBeNull();
    expect(matchAppRoute('/not-a-page').path).toBe('/not-a-page');
  });
});
