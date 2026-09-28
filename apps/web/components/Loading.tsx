'use client';

import { Skeleton } from '@yapilapi/design-system';
import { useSession } from '@/app/providers';

// Stand-ins for the parts of a page that download when they're first needed (next/dynamic). Each
// takes the place and look of what it stands for, so nothing jumps when it arrives, and tells
// screen readers it's loading.

/** A block of a set height, such as the card form in checkout. */
export function LoadingBlock({ height }: { height: number }) {
  const { t } = useSession();
  return (
    <div role="status">
      <Skeleton height={height} />
      <span className="yp-visually-hidden">{t('common.loading')}</span>
    </div>
  );
}

/** The full-screen photo, video, collage and cover editors. */
export function EditorLoading() {
  const { t } = useSession();
  return (
    <div className="ed" role="status">
      <div className="ed__bar" aria-hidden>
        <Skeleton height={32} width={72} />
        <Skeleton height={32} width={72} />
      </div>
      <div className="ed__stage" aria-hidden />
      <div className="ed__tools" aria-hidden>
        <Skeleton height={44} />
      </div>
      <span className="yp-visually-hidden">{t('common.loading')}</span>
    </div>
  );
}

/** A full-screen viewer (stories, a Together album's viewer or slideshow): its backdrop, empty. */
export function ScreenLoading({ className }: { className: 'story' | 'tg-viewer' | 'tg-show' }) {
  const { t } = useSession();
  return (
    <div className={className} role="status">
      <span className="yp-visually-hidden">{t('common.loading')}</span>
    </div>
  );
}
