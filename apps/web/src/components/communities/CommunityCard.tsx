'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import type { Community } from '@yapilapi/api-client';
import { Avatar, Badge, Card, GlobeIcon, LockIcon, ShieldIcon } from '@yapilapi/ui';
import { useI18n } from '@/i18n';

export function VisibilityBadge({ community }: { community: Pick<Community, 'visibility'> }) {
  const { t } = useI18n();
  const Icon =
    community.visibility === 'public'
      ? GlobeIcon
      : community.visibility === 'private'
        ? LockIcon
        : ShieldIcon;
  return (
    <Badge icon={<Icon size={12} />}>{t(`communities.visibility.${community.visibility}`)}</Badge>
  );
}

export function CommunityCard({
  community,
  actions,
  headingLevel = 2,
}: {
  community: Community;
  actions?: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const { t, fmt } = useI18n();
  const H = `h${headingLevel}` as 'h2';
  const href = `/communities/${encodeURIComponent(community.slug)}`;
  return (
    <Card
      as="article"
      padding="md"
      className="comm-card"
      data-testid="community-card"
      aria-labelledby={`comm-${community.id}`}
    >
      <div className="comm-card__head">
        <Avatar name={community.name} size="lg" decorative />
        <div>
          <H id={`comm-${community.id}`} className="comm-card__name">
            <Link href={href}>{community.name}</Link>
          </H>
          <div className="comm-card__meta">
            <span>{t('communities.members', { count: community.memberCount })}</span>
            <VisibilityBadge community={community} />
            <span>{t(`communities.joinPolicy.${community.joinPolicy}`)}</span>
            {community.isPaid ? <Badge tone="warning">{t('communities.paid')}</Badge> : null}
          </div>
        </div>
      </div>
      {community.description ? <p className="comm-card__desc">{community.description}</p> : null}
      {community.topics.length > 0 ? (
        <p className="comm-card__meta">{community.topics.map((tp) => `#${tp}`).join(' ')}</p>
      ) : null}
      {actions ? <div className="comm-card__actions">{actions}</div> : null}
      <span className="yl-sr-only">{fmt.date(community.createdAt)}</span>
    </Card>
  );
}
