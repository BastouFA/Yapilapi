'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, type Profile } from '@yapilapi/api-client';
import {
  Button,
  EmptyState,
  IconButton,
  Menu,
  MoreIcon,
  ProfileHeader,
  buttonClass,
  BanIcon,
  EyeOffIcon,
  ShieldIcon,
  LockIcon,
  EditIcon,
  UserIcon,
  useToast,
  type MenuItemDef,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, useInfinite, usePageTitle } from '@/lib/hooks';
import { useProfileLabels } from '@/lib/labels';
import { describeError } from '@/lib/errors';
import { ConfirmDialog, ErrorView, PageSpinner } from '@/components/common';
import { PostList } from '@/components/PostList';
import { UserListDialog } from './UserListDialog';

export function ProfileView({ username }: { username: string }) {
  const api = useApi();
  const { t } = useI18n();
  const labels = useProfileLabels();
  const toast = useToast();
  const profile = useAsync((signal) => api.profile.get(username, { signal }), [api, username]);
  const [dialog, setDialog] = useState<'followers' | 'following' | null>(null);
  const [confirm, setConfirm] = useState<'block' | 'unfriend' | null>(null);
  const [busy, setBusy] = useState(false);
  const p = profile.data;
  usePageTitle(p ? `${p.displayName} (@${p.username})` : t('profile.title'), t('app.name'));

  const posts = useInfinite(
    (cursor, signal) =>
      api.posts.byUser(username, { ...(cursor ? { cursor } : {}), limit: 15, signal }),
    `posts:${username}`,
    Boolean(p && !p.contentHidden),
  );

  if (profile.loading && !p) return <PageSpinner />;
  if (profile.error && !p) {
    if (profile.error instanceof ApiError && profile.error.status === 404) {
      return (
        <EmptyState
          icon={<UserIcon size={28} />}
          title={t('profile.notFoundTitle')}
          description={t('profile.notFoundBody', { username })}
          action={
            <Link href="/" className={buttonClass({ variant: 'primary' })}>
              {t('nav.home')}
            </Link>
          }
        />
      );
    }
    return <ErrorView error={profile.error} onRetry={profile.reload} />;
  }
  if (!p) return null;

  const run = async (fn: () => Promise<unknown>, okMessage?: string) => {
    setBusy(true);
    try {
      await fn();
      profile.reload();
      if (okMessage) toast.show({ tone: 'success', title: okMessage });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(false);
    }
  };

  const v = p.viewer;
  const actions = v.isSelf ? (
    <Link href="/settings/profile" className={buttonClass({ variant: 'secondary' })}>
      <EditIcon size={16} /> {t('profile.edit')}
    </Link>
  ) : (
    <OtherActions p={p} busy={busy} run={run} onConfirm={setConfirm} />
  );

  return (
    <>
      <ProfileHeader
        profile={p}
        labels={labels}
        actions={actions}
        headingLevel={1}
        {...(p.contentHidden && !v.isSelf
          ? {}
          : {
              onShowFollowers: () => setDialog('followers'),
              onShowFollowing: () => setDialog('following'),
            })}
      />
      <section aria-labelledby="posts-h" className="stack profile-posts">
        <h2 id="posts-h" className="section-title">
          {t('profile.posts')}
        </h2>
        {p.contentHidden ? (
          <EmptyState
            icon={<LockIcon size={28} />}
            title={t('profile.privateTitle')}
            description={t('profile.privateBody', { name: p.displayName })}
          />
        ) : (
          <PostList
            state={posts}
            label={t('profile.postsOf', { name: p.displayName })}
            explain={false}
            empty={
              <EmptyState
                title={v.isSelf ? t('profile.noPostsSelf') : t('profile.noPosts')}
                description={v.isSelf ? t('profile.noPostsSelfBody') : undefined}
                action={
                  v.isSelf ? (
                    <Link href="/create" className={buttonClass({ variant: 'primary' })}>
                      {t('nav.create')}
                    </Link>
                  ) : undefined
                }
              />
            }
          />
        )}
      </section>
      <UserListDialog
        open={dialog === 'followers'}
        onClose={() => setDialog(null)}
        title={t('profile.followersTitle')}
        cacheKey={`followers:${username}`}
        load={(cursor, signal) =>
          api.graph.followers(username, { ...(cursor ? { cursor } : {}), limit: 30, signal })
        }
      />
      <UserListDialog
        open={dialog === 'following'}
        onClose={() => setDialog(null)}
        title={t('profile.followingTitle')}
        cacheKey={`following:${username}`}
        load={(cursor, signal) =>
          api.graph.following(username, { ...(cursor ? { cursor } : {}), limit: 30, signal })
        }
      />
      <ConfirmDialog
        open={confirm === 'block'}
        onClose={() => setConfirm(null)}
        busy={busy}
        danger
        title={t('profile.blockTitle', { username: p.username })}
        confirmLabel={t('profile.block')}
        description={t('profile.blockBody')}
        onConfirm={() =>
          void run(
            () => api.graph.block(p.username),
            t('profile.blocked', { username: p.username }),
          ).then(() => setConfirm(null))
        }
      />
      <ConfirmDialog
        open={confirm === 'unfriend'}
        onClose={() => setConfirm(null)}
        busy={busy}
        danger
        title={t('profile.unfriendTitle', { username: p.username })}
        confirmLabel={t('profile.unfriend')}
        description={t('profile.unfriendBody')}
        onConfirm={() =>
          void run(
            () => api.graph.removeFriend(p.id),
            t('profile.unfriended', { username: p.username }),
          ).then(() => setConfirm(null))
        }
      />
    </>
  );
}

function OtherActions({
  p,
  busy,
  run,
  onConfirm,
}: {
  p: Profile;
  busy: boolean;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
  onConfirm: (c: 'block' | 'unfriend') => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const v = p.viewer;

  const message = async () => {
    try {
      const c = await api.conversations.direct({ userId: p.id });
      router.push(`/inbox/${c.id}`);
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  const followLabel =
    v.following === 'active'
      ? t('profile.unfollow')
      : v.following === 'pending'
        ? t('profile.cancelRequest')
        : p.isPrivate
          ? t('profile.requestFollow')
          : t('profile.follow');
  const onFollow = () =>
    v.following === 'none'
      ? run(() => api.graph.follow(p.username))
      : run(() => api.graph.unfollow(p.username));

  const friend = (() => {
    switch (v.friendship) {
      case 'none':
        return {
          label: t('profile.addFriend'),
          onClick: () =>
            run(() => api.graph.sendFriendRequest(p.username), t('profile.friendRequestSent')),
          disabled: false,
        };
      case 'pending_in':
        return {
          label: t('profile.acceptFriend'),
          onClick: () =>
            run(() => api.graph.acceptFriendRequest(p.id), t('profile.friendAccepted')),
          disabled: false,
        };
      case 'pending_out':
        return {
          label: t('profile.cancelFriendRequest'),
          onClick: () =>
            run(() => api.graph.removeFriend(p.id), t('profile.friendRequestCancelled')),
          disabled: false,
        };
      case 'friends':
        return {
          label: t('profile.friendsState'),
          onClick: async () => onConfirm('unfriend'),
          disabled: false,
        };
    }
  })();

  const items: MenuItemDef[] = [
    v.muted
      ? {
          id: 'unmute',
          label: t('profile.unmute'),
          icon: <EyeOffIcon size={16} />,
          onSelect: () => void run(() => api.graph.unmute(p.username), t('profile.unmuted')),
        }
      : {
          id: 'mute',
          label: t('profile.mute'),
          icon: <EyeOffIcon size={16} />,
          onSelect: () =>
            void run(
              () => api.graph.mute(p.username),
              t('profile.muted', { username: p.username }),
            ),
        },
    v.restricted
      ? {
          id: 'unrestrict',
          label: t('profile.unrestrict'),
          icon: <ShieldIcon size={16} />,
          onSelect: () =>
            void run(() => api.graph.unrestrict(p.username), t('profile.unrestricted')),
        }
      : {
          id: 'restrict',
          label: t('profile.restrict'),
          icon: <ShieldIcon size={16} />,
          onSelect: () =>
            void run(
              () => api.graph.restrict(p.username),
              t('profile.restricted', { username: p.username }),
            ),
        },
    {
      id: 'block',
      label: t('profile.block'),
      icon: <BanIcon size={16} />,
      danger: true,
      separatorBefore: true,
      onSelect: () => onConfirm('block'),
    },
  ];

  return (
    <>
      <Button
        variant={v.following === 'none' ? 'primary' : 'secondary'}
        onClick={() => void onFollow()}
        disabled={busy}
        data-testid="follow-btn"
        aria-pressed={v.following === 'active'}
      >
        {followLabel}
      </Button>
      <Button
        variant="secondary"
        onClick={() => void friend.onClick()}
        disabled={busy || friend.disabled}
        data-testid="friend-btn"
      >
        {friend.label}
      </Button>
      <Button
        variant="secondary"
        onClick={() => void message()}
        disabled={busy}
        data-testid="message-btn"
      >
        {t('profile.message')}
      </Button>
      <Menu
        label={t('profile.moreActions')}
        trigger={
          <IconButton label={t('profile.moreActions')} variant="secondary" icon={<MoreIcon />} />
        }
        items={items}
      />
    </>
  );
}
