import React, { memo, useState } from 'react';
import { Pressable, Share, View } from 'react-native';
import { useRouter } from 'expo-router';
import { REACTION_KINDS, type Post, type ReactionKind } from '@yapilapi/api-client';
import { useTheme } from '../theme';
import { useI18n } from '../i18n';
import { useApi } from '../auth/AuthProvider';
import { WEB_URL } from '../config';
import { compactNumber, relativeTime } from '../lib/format';
import { useDeletePost, useReactPost, useSavePost } from '../data/posts';
import { useFeedControl, useFeedExplain, type FeedControl } from '../data/feed';
import { ActionMenu, AppText, Avatar, ConfirmDialog, Icon, type MenuAction } from '../ui';
import { MediaGrid } from './media';
import { PollView } from './PollView';

const REASON_KEYS = [
  'followed_author',
  'friend',
  'topic',
  'community',
  'trending',
  'discovery',
] as const;

function ActionButton({
  icon,
  label,
  count,
  active,
  onPress,
  onLongPress,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  count?: string | undefined;
  active?: boolean | undefined;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const th = useTheme();
  const color = active ? th.colors.primary : th.colors.textMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(active) }}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={4}
      style={{
        minHeight: th.targetMin,
        minWidth: th.targetMin,
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space[1],
      }}
    >
      <Icon name={icon} color={color} filled={active === true && icon !== 'comment'} size={20} />
      {count ? (
        <AppText variant="caption" style={{ color }}>
          {count}
        </AppText>
      ) : null}
    </Pressable>
  );
}

export interface PostCardProps {
  post: Post;
  /** On the detail screen the card is not tappable and shows the full reaction picker. */ detail?: boolean;
  showReasons?: boolean;
}

function PostCardBase({ post, detail, showReasons }: PostCardProps) {
  const th = useTheme();
  const { t, locale } = useI18n();
  const router = useRouter();
  const api = useApi();
  const react = useReactPost();
  const save = useSavePost();
  const del = useDeletePost();
  const control = useFeedControl();
  const [menu, setMenu] = useState<'none' | 'more' | 'reactions'>('none');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [why, setWhy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const explain = useFeedExplain(why ? post.id : null);

  const name = post.author.displayName || post.author.username;
  const liked = post.viewer.reaction !== null;
  const openProfile = () =>
    router.push({ pathname: '/user/[username]', params: { username: post.author.username } });
  const openPost = () => {
    if (!detail) router.push({ pathname: '/post/[id]', params: { id: post.id } });
  };

  const doShare = async () => {
    try {
      const res = await Share.share({ message: `${WEB_URL}/post/${post.id}` });
      if (res.action === Share.sharedAction)
        void api.posts.share(post.id, { channel: 'external' }).catch(() => undefined);
    } catch {
      setNote(t('post.shareFailed'));
    }
  };
  const ctl = (c: FeedControl) =>
    control.mutate(
      { post, control: c },
      {
        onSuccess: () => setNote(t('post.feedbackDone')),
        onError: () => setNote(t('error.generic')),
      },
    );

  const actions: MenuAction[] = [
    { key: 'react', label: t('post.react'), onPress: () => setMenu('reactions') },
    ...(!post.viewer.isAuthor
      ? [
          { key: 'why', label: t('post.why'), onPress: () => setWhy(true) },
          { key: 'more', label: t('post.moreLikeThis'), onPress: () => ctl('more_like_this') },
          { key: 'less', label: t('post.lessLikeThis'), onPress: () => ctl('less_like_this') },
          { key: 'ni', label: t('post.notInterested'), onPress: () => ctl('not_interested') },
          {
            key: 'mute',
            label: t('post.muteCreator', { name }),
            onPress: () => ctl('mute_creator'),
          },
          ...(post.topics.length
            ? [{ key: 'topic', label: t('post.muteTopic'), onPress: () => ctl('mute_topic') }]
            : []),
          {
            key: 'hide',
            label: t('post.hideCreator', { name }),
            onPress: () => ctl('hide_creator'),
          },
        ]
      : [
          {
            key: 'del',
            label: t('post.delete'),
            destructive: true,
            onPress: () => setConfirmDelete(true),
          },
        ]),
  ];

  const reasonText = (r: string) =>
    (REASON_KEYS as readonly string[]).includes(r)
      ? t(`reason.${r as (typeof REASON_KEYS)[number]}`)
      : r;
  const reasons = post.reasons?.length ? post.reasons.slice(0, 1) : [];

  return (
    <View
      accessibilityLabel={t('post.by', { name })}
      style={{
        backgroundColor: th.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: th.colors.border,
        paddingHorizontal: th.space[4],
        paddingTop: th.space[3],
        paddingBottom: th.space[1],
      }}
    >
      {showReasons && reasons.length ? (
        <AppText variant="caption" tone="subtle" style={{ marginBottom: th.space[1] }}>
          {reasonText(reasons[0]!)}
        </AppText>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('a11y.openProfile', { name })}
        onPress={openProfile}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: th.space[3],
          minHeight: th.targetMin,
        }}
      >
        <Avatar name={name} uri={post.author.avatarUrl} size={40} />
        <View style={{ flex: 1 }}>
          <AppText variant="bodyStrong" numberOfLines={1}>
            {name}
          </AppText>
          <AppText
            variant="caption"
            tone="subtle"
            numberOfLines={1}
          >{`@${post.author.username} · ${relativeTime(post.createdAt, locale)}${post.editedAt ? ` · ${t('post.edited')}` : ''}`}</AppText>
        </View>
      </Pressable>

      <Pressable
        accessibilityRole={detail ? 'text' : 'button'}
        accessible={!detail || undefined}
        onPress={openPost}
        disabled={detail}
        style={{ marginTop: th.space[2] }}
      >
        {post.body ? (
          <AppText variant="body" selectable={detail}>
            {post.body}
          </AppText>
        ) : null}
      </Pressable>
      {post.link ? (
        <AppText
          variant="caption"
          tone="primary"
          style={{ marginTop: th.space[2] }}
          numberOfLines={1}
        >
          {post.link.url}
        </AppText>
      ) : null}
      <MediaGrid media={post.media} />
      {post.poll ? <PollView postId={post.id} poll={post.poll} /> : null}
      {post.topics.length ? (
        <AppText variant="caption" tone="subtle" style={{ marginTop: th.space[2] }}>
          {post.topics.map((x) => `#${x}`).join(' ')}
        </AppText>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: th.space[1],
        }}
      >
        <ActionButton
          icon="heart"
          active={liked}
          label={`${liked ? t('post.unlike') : t('post.like')}, ${t('post.likeCount', { count: post.counts.likes })}`}
          count={post.counts.likes > 0 ? compactNumber(post.counts.likes, locale) : undefined}
          onPress={() => react.mutate({ post })}
          onLongPress={() => setMenu('reactions')}
        />
        <ActionButton
          icon="comment"
          label={`${t('post.comment')}, ${t('post.commentCount', { count: post.counts.comments })}`}
          count={post.counts.comments > 0 ? compactNumber(post.counts.comments, locale) : undefined}
          onPress={openPost}
        />
        <ActionButton
          icon="bookmark"
          active={post.viewer.saved}
          label={post.viewer.saved ? t('post.unsave') : t('post.save')}
          onPress={() => save.mutate(post)}
        />
        <ActionButton icon="send" label={t('post.share')} onPress={() => void doShare()} />
        <ActionButton icon="more" label={t('post.more')} onPress={() => setMenu('more')} />
      </View>
      {note ? (
        <AppText
          variant="caption"
          tone="muted"
          accessibilityLiveRegion="polite"
          style={{ paddingBottom: th.space[2] }}
        >
          {note}
        </AppText>
      ) : null}

      <ActionMenu
        visible={menu === 'more'}
        title={t('common.moreOptions')}
        actions={actions}
        onClose={() => setMenu('none')}
      />
      <ActionMenu
        visible={menu === 'reactions'}
        title={t('post.react')}
        onClose={() => setMenu('none')}
        actions={REACTION_KINDS.map((k: ReactionKind) => ({
          key: k,
          label: `${t(`reaction.${k}`)}${post.viewer.reaction === k ? ` (${t('a11y.selected')})` : ''}`,
          onPress: () => react.mutate({ post, kind: k }),
        }))}
      />
      <ConfirmDialog
        visible={confirmDelete}
        title={t('post.deleteConfirmTitle')}
        body={t('post.deleteConfirmBody')}
        confirmLabel={t('post.delete')}
        destructive
        loading={del.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() =>
          del.mutate(post.id, {
            onSettled: () => setConfirmDelete(false),
            onSuccess: () => {
              if (detail) router.back();
            },
          })
        }
      />
      <ConfirmDialog
        visible={why}
        title={t('post.whyTitle')}
        confirmLabel={t('common.close')}
        onCancel={() => setWhy(false)}
        onConfirm={() => setWhy(false)}
      >
        {explain.isPending ? (
          <AppText variant="body" tone="muted">
            {t('common.loading')}
          </AppText>
        ) : explain.isError ? (
          <AppText variant="body" tone="muted">
            {t('state.loadFailed')}
          </AppText>
        ) : (
          (explain.data?.reasons ?? []).map((r) => (
            <AppText key={r} variant="body">{`• ${reasonText(r)}`}</AppText>
          ))
        )}
      </ConfirmDialog>
    </View>
  );
}

export const PostCard = memo(PostCardBase);
