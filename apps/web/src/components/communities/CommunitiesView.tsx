'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Button,
  EmptyState,
  FeedTabs,
  FormField,
  Input,
  UsersIcon,
  buttonClass,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useDebounced, useInfinite, usePageTitle, type InfiniteState } from '@/lib/hooks';
import type { Community } from '@yapilapi/api-client';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, FeedSkeleton, InfiniteFooter } from '@/components/common';
import { CommunityCard } from './CommunityCard';

type Tab = 'discover' | 'mine' | 'invites';
const TABS: Tab[] = ['discover', 'mine', 'invites'];

export function CommunitiesView() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('discover');
  usePageTitle(t('communities.title'), t('app.name'));
  return (
    <div className="commhub-wide">
      <PageHeader
        title={t('communities.title')}
        lead={t('communities.lead')}
        actions={
          <Link
            href="/communities/new"
            className={buttonClass({ variant: 'primary' })}
            data-testid="create-community"
          >
            {t('communities.create')}
          </Link>
        }
      />
      <FeedTabs
        label={t('communities.tabs')}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={TABS.map((id) => ({ id, label: t(`communities.tab.${id}`) }))}
      >
        {tab === 'discover' ? <DiscoverList /> : tab === 'mine' ? <MineList /> : <Invitations />}
      </FeedTabs>
    </div>
  );
}

function DiscoverList() {
  const { t } = useI18n();
  const api = useApi();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const state = useInfinite(
    (cursor, signal) =>
      api.communities.list({
        ...(dq ? { q: dq } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 12,
        signal,
      }),
    `comm:discover:${dq}`,
  );
  return (
    <div className="stack">
      <FormField label={t('communities.search')}>
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('communities.searchPlaceholder')}
          maxLength={80}
          data-testid="community-search"
        />
      </FormField>
      <List
        state={state}
        label={t('communities.tab.discover')}
        empty={
          <EmptyState
            icon={<UsersIcon size={28} />}
            title={t('communities.emptyDiscover.title')}
            description={t('communities.emptyDiscover.body')}
            action={
              <Link href="/communities/new" className={buttonClass({ variant: 'primary' })}>
                {t('communities.create')}
              </Link>
            }
          />
        }
      />
    </div>
  );
}

function MineList() {
  const { t } = useI18n();
  const api = useApi();
  const state = useInfinite(
    (cursor, signal) => api.communities.mine({ ...(cursor ? { cursor } : {}), limit: 12, signal }),
    'comm:mine',
  );
  return (
    <List
      state={state}
      label={t('communities.tab.mine')}
      empty={
        <EmptyState
          icon={<UsersIcon size={28} />}
          title={t('communities.emptyMine.title')}
          description={t('communities.emptyMine.body')}
        />
      }
    />
  );
}

function List({
  state,
  empty,
  label,
}: {
  state: InfiniteState<Community>;
  empty: React.ReactNode;
  label: string;
}) {
  if (state.loading) return <FeedSkeleton count={2} />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  if (state.items.length === 0) return <>{empty}</>;
  return (
    <>
      <ul className="comm-list" aria-label={label}>
        {state.items.map((c) => (
          <li key={c.id}>
            <CommunityCard community={c} />
          </li>
        ))}
      </ul>
      <InfiniteFooter
        hasMore={state.hasMore}
        loading={state.loadingMore}
        error={state.moreError}
        onLoadMore={state.loadMore}
        onRetry={state.loadMore}
      />
    </>
  );
}

function Invitations() {
  const { t } = useI18n();
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const state = useInfinite(
    (cursor, signal) =>
      api.communities.invitations({ ...(cursor ? { cursor } : {}), limit: 12, signal }),
    'comm:invites',
  );

  const act = async (id: string, name: string, accept: boolean) => {
    setBusy(id);
    try {
      if (accept) await api.communities.acceptInvitation(id);
      else await api.communities.declineInvitation(id);
      state.setItems((prev) => prev.filter((c) => c.id !== id));
      toast.show({
        tone: 'success',
        title: accept ? t('communities.accepted', { name }) : t('communities.declined'),
      });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('communities.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(null);
    }
  };

  if (state.loading) return <FeedSkeleton count={1} />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  if (state.items.length === 0)
    return (
      <EmptyState
        icon={<UsersIcon size={28} />}
        title={t('communities.emptyInvites.title')}
        description={t('communities.emptyInvites.body')}
      />
    );
  return (
    <ul className="comm-list" aria-label={t('communities.tab.invites')}>
      {state.items.map((c) => (
        <li key={c.id}>
          <CommunityCard
            community={c}
            actions={
              <>
                <Button
                  size="sm"
                  onClick={() => void act(c.id, c.name, true)}
                  disabled={busy === c.id}
                  data-testid="accept-invite"
                >
                  {t('communities.accept')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void act(c.id, c.name, false)}
                  disabled={busy === c.id}
                >
                  {t('communities.decline')}
                </Button>
              </>
            }
          />
        </li>
      ))}
    </ul>
  );
}
