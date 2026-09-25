import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { ApiError, type Comment } from '@yapilapi/api-client';
import { useTheme } from '../../theme';
import { useT } from '../../i18n';
import { usePrefs } from '../../prefs';
import { useComments, useCreateComment, usePost } from '../../data/posts';
import { errorMessage } from '../../lib/errors';
import { PostCard } from '../../features/PostCard';
import { CommentItem } from '../../features/CommentItem';
import {
  AppText,
  Button,
  EmptyView,
  ErrorView,
  LoadingView,
  PagedList,
  Screen,
  TextField,
} from '../../ui';

export default function PostDetail() {
  const th = useTheme();
  const t = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { lowBandwidth } = usePrefs();
  const post = usePost(id);
  const comments = useComments(id);
  const create = useCreateComment(id);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (post.isPending)
    return (
      <Screen>
        <LoadingView />
      </Screen>
    );
  if (post.isError)
    return (
      <Screen>
        <ErrorView
          error={post.error}
          onRetry={() => void post.refetch()}
          message={
            post.error instanceof ApiError && post.error.status === 404
              ? t('post.notFound')
              : undefined
          }
        />
      </Screen>
    );

  const send = () => {
    const body = text.trim();
    if (!body) return;
    setError(null);
    create.mutate(
      { body, ...(replyTo ? { parentId: replyTo.id } : {}) },
      {
        onSuccess: () => {
          setText('');
          setReplyTo(null);
        },
        onError: (e) =>
          setError(
            e instanceof ApiError && e.retryable ? t('comments.failed') : errorMessage(e, t),
          ),
      },
    );
  };

  return (
    <Screen edges={['left', 'right', 'bottom']} padded={false}>
      <PagedList
        query={comments}
        manualPaging={lowBandwidth}
        header={
          <View>
            <PostCard post={post.data} detail />
            <AppText variant="heading" header style={{ padding: th.space[4] }}>
              {t('comments.title')}
            </AppText>
          </View>
        }
        renderItem={({ item }) => (
          <View style={{ paddingHorizontal: th.space[4] }}>
            <CommentItem comment={item} postId={id} onReply={(c) => setReplyTo(c)} />
          </View>
        )}
        empty={<EmptyView message={t('comments.empty')} />}
        keyboardShouldPersistTaps="handled"
      />
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: th.colors.border,
          backgroundColor: th.colors.surface,
          padding: th.space[3],
        }}
      >
        {replyTo ? (
          <View
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <AppText variant="caption" tone="muted">
              {t('comments.replyingTo', {
                name: replyTo.author.displayName || replyTo.author.username,
              })}
            </AppText>
            <Button
              label={t('comments.cancelReply')}
              variant="ghost"
              compact
              onPress={() => setReplyTo(null)}
            />
          </View>
        ) : null}
        <TextField
          label={t('comments.placeholder')}
          value={text}
          onChangeText={setText}
          maxLength={4000}
          multiline
          multilineHeight={56}
          error={error}
        />
        <Button
          label={t('comments.send')}
          loading={create.isPending}
          disabled={!text.trim()}
          onPress={send}
          block
        />
      </View>
    </Screen>
  );
}
