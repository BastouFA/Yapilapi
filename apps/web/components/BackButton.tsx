'use client';

import { useRouter } from 'next/navigation';
import { Icon } from '@yapilapi/design-system';
import { useSession } from '@/app/providers';

/**
 * Back to where you came from (the reel or post whose music you tapped), or to `fallback` when the
 * page was opened directly from a link.
 */
export function BackButton({ fallback = '/home' }: { fallback?: string }) {
  const router = useRouter();
  const { t } = useSession();
  return (
    <button
      type="button"
      className="yp-btn yp-btn--ghost yp-btn--sm back-button"
      onClick={() => (window.history.length > 1 ? router.back() : router.push(fallback))}
    >
      <Icon name="arrow-left" size={18} />
      {t('m.common.back')}
    </button>
  );
}
