'use client';

import { Badge, Button, EmptyState } from '@yapilapi/design-system';
import { formatRelativeTime } from '@yapilapi/shared';
import { useSession } from '@/app/providers';
import { api, errorMessage } from '@/lib/api';
import { LoadFailed, Loading, useLoad } from './shared';

/** Problems people reported from Settings > Help, newest first. Closing one takes it off the list. */
export function Problems() {
  const { t, toast, locale } = useSession();
  const { data, setData, error, reload } = useLoad(() => api.admin.problems(), []);
  if (error) return <LoadFailed error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (!data.items.length) return <EmptyState title={t('admin.problems.none')} />;
  return (
    <ul className="admin-list">
      {data.items.map((p) => (
        <li key={p.id} className="admin-list__item">
          <div className="row" style={{ alignItems: 'baseline' }}>
            <strong>{p.username ? `@${p.username}` : t('admin.case.unknownAccount')}</strong>
            <Badge tone="neutral">{p.platform}</Badge>
            {p.app_version ? <span className="muted">{p.app_version}</span> : null}
            <span className="muted">{formatRelativeTime(p.created_at, locale)}</span>
          </div>
          <p className="admin-list__text">{p.body}</p>
          {p.page ? (
            <p className="muted" style={{ margin: 0, overflowWrap: 'anywhere' }}>
              {t('admin.problems.page', { page: p.page })}
            </p>
          ) : null}
          <div className="row">
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                try {
                  await api.admin.closeProblem(p.id);
                  setData((d) => (d ? { items: d.items.filter((x) => x.id !== p.id) } : d));
                  toast(t('admin.problems.closed'));
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            >
              {t('admin.problems.close')}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
