import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Comment, Post } from '../../../../packages/shared/src/types';
import { client, errorMessage } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { PostCard } from '../../lib/post';
import { useSession } from '../../lib/session';
import { elevation, radius, space } from '../../lib/theme';
import { Avatar, Button, EmptyState, Loading, Notice, useColors, userText } from '../../lib/ui';

/** A single post with its comments (link target for notifications, search and the feed). */
export default function PostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, timeAgo } = useT();
  const insets = useSafeAreaInsets();
  const { me } = useSession();
  const [post, setPost] = useState<Post | null | undefined>(undefined);
  const [comments, setComments] = useState<Comment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadComments = useCallback(
    async (next?: string) => {
      const page = await (await client()).posts.comments(id, next);
      setComments((cur) => (next ? [...cur, ...page.items] : page.items));
      setCursor(page.nextCursor);
    },
    [id],
  );

  useEffect(() => {
    void (async () => {
      try {
        const p = (await (await client()).posts.get(id)).post;
        setPost(p);
        // Comments on a post for subscribers are for subscribers too.
        if (!p.locked) await loadComments();
      } catch {
        setPost(null);
      }
    })();
  }, [id, loadComments]);

  if (post === undefined) return <Loading />;
  if (post === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.post.unavailable.title')} body={t('m.post.unavailable.body')} />
      </View>
    );

  const byId = new Map(comments.map((x) => [x.id, x]));

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.ground }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top + 44}
    >
      <FlatList
        data={comments}
        keyExtractor={(x) => x.id}
        contentContainerStyle={{ padding: space[4], gap: space[2] }}
        ListHeaderComponent={
          <View style={{ gap: space[3], marginBottom: space[2] }}>
            <PostCard post={post} open={false} />
            <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 17 }}>
              {t('post.comments')}
            </Text>
          </View>
        }
        ListEmptyComponent={<Text style={{ color: c.inkMuted }}>{t('m.comment.none')}</Text>}
        onEndReached={() => cursor && void loadComments(cursor).catch(() => {})}
        renderItem={({ item }) => {
          const parent = item.parentId ? byId.get(item.parentId) : undefined;
          return (
            <View style={{ flexDirection: 'row', gap: space[2], marginStart: item.parentId ? space[6] : 0 }}>
              <Avatar name={item.author.displayName} url={item.author.avatarUrl} size={32} />
              <View style={[{ flex: 1, backgroundColor: c.surface, borderRadius: radius.md, padding: space[3], gap: 2 }, elevation(c)]}>
                <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 13 }, userText]}>
                  {item.author.displayName} <Text style={{ color: c.inkMuted, fontWeight: '400' }}>· {timeAgo(item.createdAt)}</Text>
                </Text>
                {parent ? <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('m.comment.replyingTo', { name: parent.author.displayName })}</Text> : null}
                <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 21 }, userText]}>{item.body}</Text>
                {me ? (
                  <Pressable accessibilityRole="button" onPress={() => setReplyTo(item)} hitSlop={6} style={{ alignSelf: 'flex-start', marginTop: 2 }}>
                    <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 12 }}>{t('m.comment.reply')}</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          );
        }}
      />
      {me ? (
        <View
          style={{
            padding: space[3],
            paddingBottom: Math.max(insets.bottom, space[3]),
            gap: space[2],
            borderTopWidth: 1,
            borderTopColor: c.line,
            backgroundColor: c.ground,
          }}
        >
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {replyTo ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
              <Text style={{ color: c.inkMuted, flex: 1 }} numberOfLines={1}>
                {t('m.comment.replyingTo', { name: replyTo.author.displayName })}
              </Text>
              <Pressable accessibilityRole="button" onPress={() => setReplyTo(null)} hitSlop={6}>
                <Text style={{ color: c.yapi, fontWeight: '700' }}>{t('common.cancel')}</Text>
              </Pressable>
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'flex-end' }}>
            <TextInput
              accessibilityLabel={t('comment.placeholder')}
              placeholder={t('comment.placeholder')}
              placeholderTextColor={c.inkMuted}
              value={body}
              onChangeText={setBody}
              multiline
              maxLength={2000}
              style={[
                {
                  flex: 1,
                  minHeight: 44,
                  maxHeight: 120,
                  borderRadius: radius.lg,
                  borderWidth: 1,
                  borderColor: c.line,
                  backgroundColor: c.surface,
                  color: c.ink,
                  paddingHorizontal: space[4],
                  paddingTop: 12,
                  paddingBottom: 12,
                  fontSize: 15,
                },
                userText,
              ]}
            />
            <Button
              label={busy ? t('m.comment.posting') : t('m.comment.post')}
              disabled={!body.trim() || busy}
              onPress={async () => {
                setBusy(true);
                setError(null);
                try {
                  const { comment } = await (await client()).posts.comment(post.id, body.trim(), replyTo?.id);
                  setComments((cur) => [...cur, comment]);
                  setPost({ ...post, counts: { ...post.counts, comments: post.counts.comments + 1 } });
                  setBody('');
                  setReplyTo(null);
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            />
          </View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
