import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Comment, Post } from '../../../../packages/shared/src/types';
import { client, errorMessage } from '../../lib/api';
import { PostCard, timeAgo } from '../../lib/post';
import { useSession } from '../../lib/session';
import { elevation, radius, space } from '../../lib/theme';
import { Avatar, Button, EmptyState, Loading, Notice, useColors } from '../../lib/ui';

/** A single post with its comments (link target for notifications, search and the feed). */
export default function PostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
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
        setPost((await (await client()).posts.get(id)).post);
        await loadComments();
      } catch {
        setPost(null);
      }
    })();
  }, [id, loadComments]);

  if (post === undefined) return <Loading />;
  if (post === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title="This post isn't available" body="It may have been removed, or it isn't shared with you." />
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
              Comments
            </Text>
          </View>
        }
        ListEmptyComponent={<Text style={{ color: c.inkMuted }}>No comments yet.</Text>}
        onEndReached={() => cursor && void loadComments(cursor).catch(() => {})}
        renderItem={({ item }) => {
          const parent = item.parentId ? byId.get(item.parentId) : undefined;
          return (
            <View style={{ flexDirection: 'row', gap: space[2], marginLeft: item.parentId ? space[6] : 0 }}>
              <Avatar name={item.author.displayName} url={item.author.avatarUrl} size={32} />
              <View style={[{ flex: 1, backgroundColor: c.surface, borderRadius: radius.md, padding: space[3], gap: 2 }, elevation(c)]}>
                <Text style={{ color: c.ink, fontWeight: '700', fontSize: 13 }}>
                  {item.author.displayName} <Text style={{ color: c.inkMuted, fontWeight: '400' }}>· {timeAgo(item.createdAt)}</Text>
                </Text>
                {parent ? <Text style={{ color: c.inkMuted, fontSize: 12 }}>Replying to {parent.author.displayName}</Text> : null}
                <Text style={{ color: c.ink, fontSize: 15, lineHeight: 21 }}>{item.body}</Text>
                {me ? (
                  <Pressable accessibilityRole="button" onPress={() => setReplyTo(item)} hitSlop={6} style={{ alignSelf: 'flex-start', marginTop: 2 }}>
                    <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 12 }}>Reply</Text>
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
                Replying to {replyTo.author.displayName}
              </Text>
              <Pressable accessibilityRole="button" onPress={() => setReplyTo(null)} hitSlop={6}>
                <Text style={{ color: c.yapi, fontWeight: '700' }}>Cancel</Text>
              </Pressable>
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'flex-end' }}>
            <TextInput
              accessibilityLabel="Add a comment"
              placeholder="Add a comment"
              placeholderTextColor={c.inkMuted}
              value={body}
              onChangeText={setBody}
              multiline
              maxLength={2000}
              style={{
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
              }}
            />
            <Button
              label={busy ? 'Posting…' : 'Post'}
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
