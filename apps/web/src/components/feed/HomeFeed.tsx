'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { FeedMode } from '@yapilapi/api-client';
import {
  Button,
  EmptyState,
  FeedTabs,
  Select,
  FormField,
  PinIcon,
  buttonClass,
  UsersIcon,
  CompassIcon,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useInfinite, usePageTitle } from '@/lib/hooks';
import { PageHeader } from '@/components/PageHeader';
import { PostList } from '@/components/PostList';
import { MomentsTray } from '@/components/moments/MomentsTray';
import {
  hasLocationOptIn,
  requestCoarsePosition,
  setLocationOptIn,
  type CoarsePosition,
} from '@/lib/geo';

type Tab = 'for_you' | 'following' | 'friends' | 'communities' | 'local';
const TABS: Tab[] = ['for_you', 'following', 'friends', 'communities', 'local'];
const RADII = [5, 10, 25, 50, 100];

export function HomeFeed() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('for_you');
  usePageTitle(t('nav.home'), t('app.name'));

  return (
    <>
      <PageHeader
        title={t('home.title')}
        lead={t('home.lead')}
        actions={
          <Link href="/create" className={buttonClass({ variant: 'primary' })}>
            {t('nav.create')}
          </Link>
        }
      />
      <MomentsTray />
      <FeedTabs
        label={t('home.tabs')}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={TABS.map((id) => ({ id, label: t(`home.tab.${id}`) }))}
      >
        {tab === 'local' ? <LocalFeed /> : <ModeFeed key={tab} mode={tab} />}
      </FeedTabs>
    </>
  );
}

function Empty({ mode }: { mode: Exclude<Tab, 'local'> }) {
  const { t } = useI18n();
  const action = (
    <span className="button-row">
      <Link href="/discover" className={buttonClass({ variant: 'primary' })}>
        {t('nav.discover')}
      </Link>
      <Link href="/create" className={buttonClass({ variant: 'secondary' })}>
        {t('nav.create')}
      </Link>
    </span>
  );
  return (
    <EmptyState
      icon={
        mode === 'friends' || mode === 'communities' ? (
          <UsersIcon size={28} />
        ) : (
          <CompassIcon size={28} />
        )
      }
      title={t(`home.empty.${mode}.title`)}
      description={t(`home.empty.${mode}.body`)}
      action={action}
    />
  );
}

function ModeFeed({ mode }: { mode: Exclude<Tab, 'local'> }) {
  const api = useApi();
  const { t } = useI18n();
  const state = useInfinite(
    (cursor, signal) =>
      api.feed.get(
        { mode: mode as FeedMode, ...(cursor ? { cursor } : {}), limit: 15 },
        { signal },
      ),
    `feed:${mode}`,
  );
  return (
    <PostList
      state={state}
      label={t(`home.tab.${mode}`)}
      empty={<Empty mode={mode} />}
      explain={mode === 'for_you'}
    />
  );
}

/** The Local feed needs an explicit, explained opt-in before the browser is asked for a position. */
function LocalFeed() {
  const { t } = useI18n();
  const [optedIn, setOptedIn] = useState<boolean | null>(null);
  const [pos, setPos] = useState<CoarsePosition | null>(null);
  const [problem, setProblem] = useState<'denied' | 'unavailable' | 'timeout' | null>(null);
  const [asking, setAsking] = useState(false);

  const ask = useCallback(async () => {
    setAsking(true);
    setProblem(null);
    const r = await requestCoarsePosition();
    setAsking(false);
    if (r.ok) {
      setLocationOptIn(true);
      setOptedIn(true);
      setPos(r.position);
    } else {
      setProblem(r.reason);
    }
  }, []);

  useEffect(() => {
    const on = hasLocationOptIn();
    setOptedIn(on);
    if (on) void ask();
  }, [ask]);

  if (optedIn === null) return null;
  if (!pos) {
    return (
      <div className="stack">
        <EmptyState
          icon={<PinIcon size={28} />}
          title={t('local.title')}
          description={t('local.body')}
          action={
            <Button
              onClick={() => void ask()}
              loading={asking}
              loadingLabel={t('common.working')}
              data-testid="local-optin"
            >
              {t('local.allow')}
            </Button>
          }
        />
        {problem ? (
          <p className="yl-notice yl-notice--warning" role="alert">
            {t(`local.problem.${problem}`)}
          </p>
        ) : null}
        <p className="muted center-text">{t('local.privacy')}</p>
      </div>
    );
  }
  return (
    <NearbyFeed
      pos={pos}
      onForget={() => {
        setLocationOptIn(false);
        setPos(null);
        setOptedIn(false);
      }}
    />
  );
}

function NearbyFeed({ pos, onForget }: { pos: CoarsePosition; onForget: () => void }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const [radius, setRadius] = useState(25);
  const state = useInfinite(
    (cursor, signal) =>
      api.feed.get(
        {
          mode: 'local',
          lat: pos.latitude,
          lng: pos.longitude,
          radiusKm: radius,
          ...(cursor ? { cursor } : {}),
          limit: 15,
        },
        { signal },
      ),
    `local:${pos.latitude}:${pos.longitude}:${radius}`,
  );
  return (
    <div className="stack">
      <div className="inline-form">
        <FormField label={t('local.radius')}>
          <Select value={String(radius)} onChange={(e) => setRadius(Number(e.target.value))}>
            {RADII.map((r) => (
              <option key={r} value={r}>
                {t('local.km', { n: fmt.number(r) })}
              </option>
            ))}
          </Select>
        </FormField>
        <Button variant="ghost" onClick={onForget}>
          {t('local.stop')}
        </Button>
      </div>
      <PostList
        state={state}
        label={t('home.tab.local')}
        explain={false}
        empty={
          <EmptyState
            icon={<PinIcon size={28} />}
            title={t('local.emptyTitle')}
            description={t('local.emptyBody')}
          />
        }
      />
    </div>
  );
}
