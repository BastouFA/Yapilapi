import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { ApiError, type Profile } from '@yapilapi/api-client';
import { useTheme } from '../theme';
import { useI18n } from '../i18n';
import { shortDate } from '../lib/format';
import { errorMessage } from '../lib/errors';
import {
  useBlockUser,
  useFollow,
  useFriendAction,
  useMuteToggle,
  useProfile,
  useUserPosts,
} from '../data/social';
import { useStartDirect } from '../data/inbox';
import {
  ActionMenu,
  AppText,
  Avatar,
  Button,
  ConfirmDialog,
  EmptyView,
  ErrorView,
  LoadingView,
  PagedList,
  type MenuAction,
} from '../ui';
import { PostCard } from './PostCard';
import { usePrefs } from '../prefs';

function Header({ profile, self }: { profile: Profile; self: boolean }) {
  const th = useTheme();
  const { t, locale } = useI18n();
  const router = useRouter();
  const follow = useFollow(profile.username);
  const friend = useFriendAction(profile.username);
  const mute = useMuteToggle(profile.username);
  const block = useBlockUser(profile.username);
  const startChat = useStartDirect();
  const [menu, setMenu] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [confirmUnfriend, setConfirmUnfriend] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = profile.viewer;
  const fail = (e: unknown) => setError(errorMessage(e, t));

  const followLabel =
    v.following === 'active'
      ? t('profile.unfollow')
      : v.following === 'pending'
        ? t('profile.requested')
        : v.followedBy
          ? t('profile.followBack')
          : t('profile.follow');
  const friendLabel =
    v.friendship === 'friends'
      ? t('profile.friends')
      : v.friendship === 'pending_out'
        ? t('profile.requestSent')
        : v.friendship === 'pending_in'
          ? t('profile.acceptFriend')
          : t('profile.addFriend');
  const actions: MenuAction[] = [
    {
      key: 'mute',
      label: v.muted ? t('profile.unmute') : t('profile.mute'),
      onPress: () => mute.mutate(profile, { onError: fail }),
    },
    {
      key: 'block',
      label: t('profile.block'),
      destructive: true,
      onPress: () => setConfirmBlock(true),
    },
  ];

  return (
    <View
      style={{
        padding: th.space[4],
        gap: th.space[3],
        backgroundColor: th.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: th.colors.border,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space[4] }}>
        <Avatar name={profile.displayName} uri={profile.avatarUrl} size={72} />
        <View style={{ flex: 1 }}>
          <AppText variant="title" header numberOfLines={2}>
            {profile.displayName}
          </AppText>
          <AppText
            variant="caption"
            tone="subtle"
          >{`@${profile.username}${profile.isPrivate ? ` · ${t('common.private')}` : ''}`}</AppText>
        </View>
      </View>
      {profile.bio ? (
        <AppText variant="body" selectable>
          {profile.bio}
        </AppText>
      ) : null}
      {profile.locationText ? (
        <AppText variant="caption" tone="muted">
          {profile.locationText}
        </AppText>
      ) : null}
      <AppText
        variant="caption"
        tone="muted"
        accessibilityLabel={t('profile.countsLabel', {
          followers: profile.counts.followers,
          following: profile.counts.following,
          friends: profile.counts.friends,
        })}
      >
        {`${t('common.followers', { count: profile.counts.followers })} · ${t('common.following', { count: profile.counts.following })} · ${t('common.friends', { count: profile.counts.friends })}`}
      </AppText>
      <AppText variant="caption" tone="subtle">
        {t('profile.joined', { date: shortDate(profile.joinedAt, locale) })}
      </AppText>

      {self ? (
        <View style={{ flexDirection: 'row', gap: th.space[2] }}>
          <Button
            label={t('profile.edit')}
            variant="secondary"
            onPress={() => router.push('/edit-profile')}
          />
        </View>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space[2] }}>
          <Button
            label={followLabel}
            variant={v.following === 'none' ? 'primary' : 'secondary'}
            loading={follow.isPending}
            onPress={() => follow.mutate(profile, { onError: fail })}
          />
          <Button
            label={friendLabel}
            variant="secondary"
            disabled={v.friendship === 'pending_out'}
            loading={friend.isPending}
            onPress={() =>
              v.friendship === 'friends'
                ? setConfirmUnfriend(true)
                : friend.mutate(profile, { onError: fail })
            }
          />
          <Button
            label={t('profile.message')}
            variant="secondary"
            loading={startChat.isPending}
            onPress={() =>
              startChat.mutate(profile.username, {
                onSuccess: (c) => router.push({ pathname: '/chat/[id]', params: { id: c.id } }),
                onError: fail,
              })
            }
          />
          <Button label={t('common.moreOptions')} variant="ghost" onPress={() => setMenu(true)} />
        </View>
      )}
      {error ? (
        <AppText
          variant="caption"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {error}
        </AppText>
      ) : null}
      {v.muted ? (
        <AppText variant="caption" tone="muted">
          {t('profile.muted')}
        </AppText>
      ) : null}
      <ActionMenu
        visible={menu}
        title={profile.displayName}
        actions={actions}
        onClose={() => setMenu(false)}
      />
      <ConfirmDialog
        visible={confirmBlock}
        title={t('profile.blockTitle', { name: profile.displayName })}
        body={t('profile.blockBody')}
        confirmLabel={t('profile.block')}
        destructive
        loading={block.isPending}
        onCancel={() => setConfirmBlock(false)}
        onConfirm={() =>
          block.mutate(undefined, {
            onSuccess: () => {
              setConfirmBlock(false);
              router.back();
            },
            onError: (e) => {
              setConfirmBlock(false);
              fail(e);
            },
          })
        }
      />
      <ConfirmDialog
        visible={confirmUnfriend}
        title={t('profile.removeFriend')}
        body={t('profile.removeFriendConfirm', { name: profile.displayName })}
        confirmLabel={t('profile.removeFriend')}
        destructive
        loading={friend.isPending}
        onCancel={() => setConfirmUnfriend(false)}
        onConfirm={() =>
          friend.mutate(profile, { onSettled: () => setConfirmUnfriend(false), onError: fail })
        }
      />
    </View>
  );
}

export function ProfileView({ username, self = false }: { username: string; self?: boolean }) {
  const { t } = useI18n();
  const { lowBandwidth } = usePrefs();
  const profile = useProfile(username);
  const posts = useUserPosts(username, profile.data ? !profile.data.contentHidden : false);

  if (profile.isPending) return <LoadingView />;
  if (profile.isError)
    return (
      <ErrorView
        error={profile.error}
        onRetry={() => void profile.refetch()}
        message={
          profile.error instanceof ApiError && profile.error.status === 404
            ? t('profile.notFound')
            : undefined
        }
      />
    );
  const p = profile.data;
  return (
    <PagedList
      query={
        p.contentHidden
          ? { ...posts, items: [], isPending: false, isError: false, hasNextPage: false }
          : posts
      }
      manualPaging={lowBandwidth}
      onRefresh={async () => {
        await Promise.all([profile.refetch(), posts.refetch()]);
      }}
      header={<Header profile={p} self={self} />}
      renderItem={({ item }) => <PostCard post={item} />}
      empty={
        <EmptyView
          message={
            p.contentHidden
              ? t('profile.privateNotice')
              : self
                ? t('profile.noPostsSelf')
                : t('profile.noPosts')
          }
        />
      }
    />
  );
}
