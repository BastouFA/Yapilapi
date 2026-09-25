'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ApiError, type Community, type CommunityMember } from '@yapilapi/api-client';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  FeedTabs,
  FormField,
  Input,
  Textarea,
  UsersIcon,
  buttonClass,
  useToast,
} from '@yapilapi/ui';
import { useI18n, type T } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, useInfinite, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { ConfirmDialog, ErrorView, InfiniteFooter, PageSpinner } from '@/components/common';
import { PostList } from '@/components/PostList';
import { UserRow } from '@/components/profile/UserRow';
import { CommunityCard, VisibilityBadge } from './CommunityCard';

type Tab = 'posts' | 'channels' | 'members' | 'about';
const can = (c: Community, perm: string) => Boolean(c.viewer?.permissions?.includes(perm));

const roleLabel = (key: string, fallback: string, t: T): string =>
  key === 'owner'
    ? t('community.role.owner')
    : key === 'admin'
      ? t('community.role.admin')
      : key === 'moderator'
        ? t('community.role.moderator')
        : key === 'member'
          ? t('community.role.member')
          : fallback;

export function CommunityView({ idOrSlug }: { idOrSlug: string }) {
  const { t } = useI18n();
  const api = useApi();
  const comm = useAsync((signal) => api.communities.get(idOrSlug, { signal }), [api, idOrSlug]);
  const c = comm.data;
  usePageTitle(c?.name, t('app.name'));

  if (comm.loading && !c) return <PageSpinner />;
  if (comm.error && !c) {
    if (
      comm.error instanceof ApiError &&
      (comm.error.status === 404 || comm.error.status === 403)
    ) {
      return (
        <EmptyState
          icon={<UsersIcon size={28} />}
          title={t('community.notFoundTitle')}
          description={t('community.notFoundBody')}
          action={
            <Link href="/communities" className={buttonClass({ variant: 'primary' })}>
              {t('community.toList')}
            </Link>
          }
        />
      );
    }
    return <ErrorView error={comm.error} onRetry={comm.reload} />;
  }
  if (!c) return null;
  return <CommunityBody community={c} reload={comm.reload} />;
}

function CommunityBody({ community: c, reload }: { community: Community; reload: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('posts');
  const [busy, setBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const status = c.viewer?.status ?? null;
  const isMember = status === 'active';
  const full = c.access === 'full';

  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      reload();
      if (ok) toast.show({ tone: 'success', title: ok });
      return true;
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('community.actionFailed'),
        description: describeError(e, t).message,
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const actions = (() => {
    if (isMember)
      return (
        <Button
          variant="secondary"
          onClick={() => setConfirmLeave(true)}
          disabled={busy}
          data-testid="leave-community"
        >
          {t('community.leave')}
        </Button>
      );
    if (status === 'pending')
      return (
        <Button variant="secondary" disabled>
          {t('community.requested')}
        </Button>
      );
    if (status === 'invited') {
      return (
        <>
          <Button
            onClick={() =>
              void run(
                () => api.communities.acceptInvitation(c.id),
                t('communities.accepted', { name: c.name }),
              )
            }
            disabled={busy}
          >
            {t('communities.accept')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => void run(() => api.communities.declineInvitation(c.id))}
            disabled={busy}
          >
            {t('communities.decline')}
          </Button>
        </>
      );
    }
    if (status === 'banned') return null;
    if (c.joinPolicy === 'invite') return null;
    return (
      <Button
        onClick={() =>
          void run(
            () => api.communities.join(c.id),
            c.joinPolicy === 'open' ? t('community.joined', { name: c.name }) : undefined,
          )
        }
        disabled={busy}
        data-testid="join-community"
      >
        {c.joinPolicy === 'open' ? t('community.join') : t('community.requestJoin')}
      </Button>
    );
  })();

  const tabs: Tab[] = full ? ['posts', 'channels', 'members', 'about'] : ['about'];
  const active: Tab = full ? tab : 'about';

  return (
    <div className="commhub-wide">
      <p>
        <Link href="/communities">{t('community.toList')}</Link>
      </p>
      <header className="comm-head">
        <div className="comm-head__top">
          <Avatar name={c.name} size="xl" decorative />
          <div className="comm-head__text">
            <h1 className="comm-head__title" tabIndex={-1}>
              {c.name}
            </h1>
            <div className="comm-card__meta">
              <span>{t('communities.members', { count: c.memberCount })}</span>
              <VisibilityBadge community={c} />
              <span>{t(`communities.joinPolicy.${c.joinPolicy}`)}</span>
              {isMember && c.viewer ? (
                <Badge tone="secondary">
                  {roleLabel(c.viewer.roleKey ?? 'member', c.viewer.roleKey ?? '', t)}
                </Badge>
              ) : null}
            </div>
            {c.description ? <p className="comm-head__desc">{c.description}</p> : null}
          </div>
          <div className="comm-head__actions">{actions}</div>
        </div>
        {status === 'pending' ? (
          <p className="yl-notice yl-notice--info" role="status">
            {t('community.requestedBanner')}
          </p>
        ) : null}
        {status === 'banned' ? (
          <p className="yl-notice yl-notice--warning" role="status">
            {t('community.banned')}
          </p>
        ) : null}
        {!status && c.joinPolicy === 'invite' ? (
          <p className="yl-notice yl-notice--info" role="status">
            {t('community.inviteOnly')}
          </p>
        ) : null}
        {status === 'invited' ? (
          <p className="yl-notice yl-notice--info" role="status">
            {t('community.invited')}
          </p>
        ) : null}
      </header>

      {!full ? (
        <EmptyState
          icon={<UsersIcon size={28} />}
          title={t('community.summaryTitle')}
          description={t('community.summaryBody')}
        />
      ) : null}

      <FeedTabs
        label={t('community.tabs')}
        value={active}
        onChange={(v) => setTab(v as Tab)}
        tabs={tabs.map((id) => ({ id, label: t(`community.tab.${id}`) }))}
      >
        {active === 'posts' ? (
          <PostsTab community={c} />
        ) : active === 'channels' ? (
          <ChannelsTab community={c} />
        ) : active === 'members' ? (
          <MembersTab community={c} />
        ) : (
          <AboutTab community={c} />
        )}
      </FeedTabs>

      <ConfirmDialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        busy={busy}
        danger
        title={t('community.leaveTitle', { name: c.name })}
        description={t('community.leaveBody')}
        confirmLabel={t('community.leave')}
        onConfirm={() =>
          void run(() => api.communities.leave(c.id)).then((ok) => {
            if (ok) setConfirmLeave(false);
          })
        }
      />
    </div>
  );
}

// ------------------------------------------------------------------ posts
function PostsTab({ community: c }: { community: Community }) {
  const { t } = useI18n();
  const api = useApi();
  const toast = useToast();
  const state = useInfinite(
    (cursor, signal) =>
      api.communities.feed(c.id, { ...(cursor ? { cursor } : {}), limit: 12, signal }),
    `comm:feed:${c.id}`,
  );
  const canPost = can(c, 'post');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    if (text.length > 5000) {
      setError(t('community.tooLong'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const post = await api.posts.create({
        body: text,
        visibility: 'community',
        communityId: c.id,
      });
      state.setItems((prev) => [post, ...prev]);
      setBody('');
      toast.show({ tone: 'success', title: t('community.posted', { name: c.name }) });
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {canPost ? (
        <form className="comm-composer" onSubmit={(e) => void submit(e)} noValidate>
          <FormField
            label={t('community.composerLabel', { name: c.name })}
            {...(error ? { error } : {})}
          >
            <Textarea
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setError(null);
              }}
              rows={3}
              maxLength={5000}
              placeholder={t('community.composerPlaceholder')}
              data-testid="community-post-body"
            />
          </FormField>
          <div className="button-row button-row--end">
            <Button
              type="submit"
              loading={busy}
              loadingLabel={t('common.working')}
              disabled={!body.trim()}
              data-testid="community-post-submit"
            >
              {t('community.post')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="muted">{t('community.cannotPost')}</p>
      )}
      <PostList
        state={state}
        label={t('community.postsList')}
        explain={false}
        empty={
          <EmptyState
            title={t('community.emptyPostsTitle')}
            description={
              canPost ? t('community.emptyPostsBody') : t('community.emptyPostsBodyReadOnly')
            }
          />
        }
      />
    </div>
  );
}

// ------------------------------------------------------------------ channels
function ChannelsTab({ community: c }: { community: Community }) {
  const { t } = useI18n();
  const api = useApi();
  const toast = useToast();
  const list = useAsync((signal) => api.communities.channels(c.id, { signal }), [api, c.id]);
  const canManage = can(c, 'manage_channels');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const ch = await api.communities.createChannel(c.id, name.trim().toLowerCase());
      list.setData((d) => ({ items: [...(d?.items ?? []), ch] }));
      setName('');
      toast.show({ tone: 'success', title: t('community.channelCreated') });
    } catch (err) {
      const d = describeError(err, t);
      setError(d.fields['name'] ?? d.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {list.loading && !list.data ? (
        <PageSpinner />
      ) : list.error && !list.data ? (
        <ErrorView error={list.error} onRetry={list.reload} />
      ) : (list.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title={t('community.emptyChannelsTitle')}
          description={t('community.emptyChannelsBody')}
          headingLevel={3}
        />
      ) : (
        <ul className="channel-list" aria-label={t('community.channelsList')}>
          {list.data!.items.map((ch) => (
            <li key={ch.id}>
              <Link
                href={`/communities/${encodeURIComponent(c.slug)}/channels/${ch.id}`}
                data-testid="channel-link"
                aria-label={t('community.openChannel', { name: ch.name ?? '' })}
              >
                <span aria-hidden="true">#</span> {ch.name}
                {ch.archived ? <Badge>{t('community.archived')}</Badge> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form className="inline-form" onSubmit={(e) => void create(e)} noValidate>
          <FormField
            label={t('community.channelName')}
            description={t('community.channelNameHelp')}
            {...(error ? { error } : {})}
          >
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              maxLength={40}
              dir="ltr"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              data-testid="channel-name"
            />
          </FormField>
          <Button
            type="submit"
            loading={busy}
            loadingLabel={t('common.working')}
            disabled={!name.trim()}
            data-testid="channel-create"
          >
            {t('community.createChannel')}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ members
function MembersTab({ community: c }: { community: Community }) {
  const { t } = useI18n();
  const api = useApi();
  const toast = useToast();
  const active = useInfinite(
    (cursor, signal) =>
      api.communities.members(c.id, {
        status: 'active',
        ...(cursor ? { cursor } : {}),
        limit: 30,
        signal,
      }),
    `comm:members:${c.id}`,
  );
  const canManage = can(c, 'manage_members');
  const pending = useInfinite(
    (cursor, signal) =>
      api.communities.members(c.id, {
        status: 'pending',
        ...(cursor ? { cursor } : {}),
        limit: 30,
        signal,
      }),
    `comm:pending:${c.id}`,
    canManage,
  );
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (m: CommunityMember, approve: boolean) => {
    setBusy(m.user.id);
    try {
      if (approve) await api.communities.approveRequest(c.id, m.user.id);
      else await api.communities.rejectRequest(c.id, m.user.id);
      pending.setItems((prev) => prev.filter((x) => x.user.id !== m.user.id));
      if (approve) active.reload();
      toast.show({
        tone: 'success',
        title: approve
          ? t('community.approved', { name: m.user.displayName })
          : t('community.rejected', { name: m.user.displayName }),
      });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('community.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      {canManage && pending.items.length > 0 ? (
        <section aria-labelledby="pending-h" className="stack-sm">
          <h2 id="pending-h" className="section-title">
            {t('community.pendingTitle')}
          </h2>
          <ul className="person-list" aria-label={t('community.pendingTitle')}>
            {pending.items.map((m) => (
              <UserRow
                key={m.user.id}
                user={m.user}
                actions={
                  <>
                    <Button
                      size="sm"
                      onClick={() => void decide(m, true)}
                      disabled={busy === m.user.id}
                      aria-label={t('community.approve', { name: m.user.displayName })}
                      data-testid="approve-request"
                    >
                      {t('communities.accept')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void decide(m, false)}
                      disabled={busy === m.user.id}
                      aria-label={t('community.reject', { name: m.user.displayName })}
                    >
                      {t('communities.decline')}
                    </Button>
                  </>
                }
              />
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="members-h" className="stack-sm">
        <h2 id="members-h" className="section-title">
          {t('community.membersTitle')}
        </h2>
        {active.loading ? (
          <PageSpinner />
        ) : active.error ? (
          <ErrorView error={active.error} onRetry={active.reload} />
        ) : (
          <>
            <ul className="person-list" aria-label={t('community.membersList')}>
              {active.items.map((m) => (
                <UserRow
                  key={m.user.id}
                  user={m.user}
                  actions={
                    <Badge tone={m.rank >= 50 ? 'secondary' : 'neutral'}>
                      {roleLabel(m.roleKey, m.roleName, t)}
                    </Badge>
                  }
                />
              ))}
            </ul>
            <InfiniteFooter
              hasMore={active.hasMore}
              loading={active.loadingMore}
              error={active.moreError}
              onLoadMore={active.loadMore}
              onRetry={active.loadMore}
            />
          </>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ about
function AboutTab({ community: c }: { community: Community }) {
  const { t, fmt } = useI18n();
  return (
    <div className="stack">
      {c.description ? <p>{c.description}</p> : null}
      <ul className="comm-card__meta">
        <li>{t('community.created', { date: fmt.date(c.createdAt) })}</li>
        {c.language ? <li>{t('community.language', { lang: c.language })}</li> : null}
        {c.topics.length ? (
          <li>
            <span className="yl-sr-only">{t('community.topics')}: </span>
            {c.topics.map((x) => `#${x}`).join(' ')}
          </li>
        ) : null}
      </ul>
      {c.access === 'full' ? (
        <section aria-labelledby="rules-h" className="stack-sm">
          <h2 id="rules-h" className="section-title">
            {t('community.rules')}
          </h2>
          {(c.rules?.length ?? 0) === 0 ? (
            <p className="muted">{t('community.noRules')}</p>
          ) : (
            <ol className="comm-rules">
              {c.rules!.map((r, i) => (
                <li key={i}>
                  <strong>{r.title}</strong>
                  {r.body ? <p>{r.body}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </div>
  );
}

export { CommunityCard };
