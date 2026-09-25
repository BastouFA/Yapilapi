import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { Comment } from '@yapilapi/api-client';
import { useTheme } from '../theme';
import { useI18n } from '../i18n';
import { relativeTime } from '../lib/format';
import { useReactComment, useReplies } from '../data/posts';
import { AppText, Avatar, Button, Icon } from '../ui';

export function CommentItem({
  comment,
  postId,
  onReply,
  nested,
}: {
  comment: Comment;
  postId: string;
  onReply: (c: Comment) => void;
  nested?: boolean;
}) {
  const th = useTheme();
  const { t, locale } = useI18n();
  const router = useRouter();
  const react = useReactComment(postId);
  const [open, setOpen] = useState(false);
  const replies = useReplies(comment.id, open);
  const name = comment.author.displayName || comment.author.username;
  const liked = comment.viewer.reaction !== null;
  return (
    <View style={{ paddingStart: nested ? th.space[10] : 0, paddingVertical: th.space[2] }}>
      <View style={{ flexDirection: 'row', gap: th.space[3] }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('a11y.openProfile', { name })}
          onPress={() =>
            router.push({
              pathname: '/user/[username]',
              params: { username: comment.author.username },
            })
          }
        >
          <Avatar name={name} uri={comment.author.avatarUrl} size={nested ? 28 : 34} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <View
            style={{
              backgroundColor: th.colors.surfaceSubtle,
              borderRadius: th.radius.md,
              padding: th.space[3],
            }}
          >
            <AppText variant="label">{name}</AppText>
            <AppText variant="body" selectable>
              {comment.body}
            </AppText>
            {comment.pendingApproval ? (
              <AppText variant="caption" tone="subtle">
                {t('comments.pending')}
              </AppText>
            ) : null}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space[3] }}>
            <AppText variant="caption" tone="subtle">
              {relativeTime(comment.createdAt, locale)}
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={liked ? t('comments.unlike') : t('comments.like')}
              accessibilityState={{ selected: liked }}
              onPress={() => react.mutate(comment)}
              hitSlop={6}
              style={{
                minHeight: th.targetMin,
                flexDirection: 'row',
                alignItems: 'center',
                gap: th.space[1],
                justifyContent: 'center',
              }}
            >
              <Icon
                name="heart"
                size={16}
                color={liked ? th.colors.primary : th.colors.textMuted}
                filled={liked}
              />
              {comment.counts.likes > 0 ? (
                <AppText variant="caption" tone="muted">
                  {String(comment.counts.likes)}
                </AppText>
              ) : null}
            </Pressable>
            {!nested ? (
              <Button
                label={t('comments.reply')}
                variant="ghost"
                compact
                onPress={() => onReply(comment)}
                accessibilityLabel={`${t('comments.reply')} ${name}`}
              />
            ) : null}
          </View>
          {!nested && comment.counts.replies > 0 ? (
            <Button
              label={
                open
                  ? t('comments.hideReplies')
                  : t('comments.replies', { count: comment.counts.replies })
              }
              variant="ghost"
              compact
              onPress={() => setOpen((o) => !o)}
              style={{ alignSelf: 'flex-start' }}
            />
          ) : null}
        </View>
      </View>
      {open ? (
        replies.isPending ? (
          <AppText variant="caption" tone="muted" style={{ paddingStart: th.space[10] }}>
            {t('common.loading')}
          </AppText>
        ) : replies.isError ? (
          <Button
            label={t('common.retry')}
            variant="ghost"
            compact
            onPress={() => void replies.refetch()}
          />
        ) : (
          <View>
            {replies.items.map((r) => (
              <CommentItem key={r.id} comment={r} postId={postId} onReply={onReply} nested />
            ))}
            {replies.hasNextPage ? (
              <Button
                label={t('common.loadMore')}
                variant="ghost"
                compact
                onPress={() => void replies.fetchNextPage()}
              />
            ) : null}
          </View>
        )
      ) : null}
    </View>
  );
}
