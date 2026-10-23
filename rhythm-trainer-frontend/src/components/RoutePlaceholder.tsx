import type { AppRouteDefinition } from '../app/routes';

interface Props {
  route: AppRouteDefinition | null;
  path: string;
  onBack: () => void;
}

/**
 * Honest boundary for future pages. It never renders business data or fake
 * statistics; it only explains that the page is not part of A0.
 */
export default function RoutePlaceholder({ route, path, onBack }: Props) {
  const known = Boolean(route);
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{known ? 'PAGE RESERVED' : 'PAGE NOT FOUND'}</div>
          <h1>{route?.title ?? '页面不存在'}</h1>
          <p>
            {known
              ? '这个页面已经在导航结构中登记，但 A0 尚未开放；不会显示伪造数据。'
              : '当前地址没有对应的页面。'}
          </p>
        </div>
      </div>
      <section className="card route-placeholder">
        <div className="route-placeholder-copy">
          <strong>{known ? '尚未开放' : '没有找到这个页面'}</strong>
          <p>
            {known
              ? route?.description ?? '后续批次会接入真实页面。'
              : '检查地址，或返回已开放的练习工作台。'}
          </p>
          <code>{path}</code>
        </div>
        <button type="button" className="button button-primary" onClick={onBack}>
          返回练习工作台
        </button>
      </section>
    </div>
  );
}
