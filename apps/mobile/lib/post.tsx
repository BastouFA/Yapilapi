import { router } from 'expo-router';
import { useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import type { Conversation, Post } from '../../../packages/shared/src/types';
import { client, mediaUrl } from './api';
import { radius, space } from './theme';
import { Avatar, Card, Icon, useColors } from './ui';

export function timeAgo(iso: string) {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString();
}

export const conversationTitle = (c: Conversation, meId?: string) =>
  c.title ??
  (c.members
    .filter((m) => m.id !== meId)
    .map((m) => m.displayName)
    .join(', ') ||
    'Just you');

/** A post as a rounded card. Tapping it opens the post; like and save update in place. */
export function PostCard({ post, open = true }: { post: Post; open?: boolean }) {
  const c = useColors();
  const [liked, setLiked] = useState(post.viewer.liked);
  const [likes, setLikes] = useState(post.counts.likes);
  const [saved, setSaved] = useState(post.viewer.saved);
  const image = post.media.find((m) => m.kind === 'image');
  const imageUri = image ? (image.variants?.medium ?? image.url) : null;

  return (
    <Card
      onPress={open ? () => router.push(`/p/${post.id}`) : undefined}
      label={open ? `Post by ${post.author.displayName}` : undefined}
      style={{ gap: space[3] }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
        <Avatar name={post.author.displayName} url={post.author.avatarUrl} size={40} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.ink, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>
            {post.author.displayName}
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 12 }} numberOfLines={1}>
            @{post.author.username} · {timeAgo(post.createdAt)}
            {post.reason ? ` · ${post.reason}` : ''}
          </Text>
        </View>
      </View>

      {post.community ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push(`/c/${post.community!.slug}`)}
          style={{ alignSelf: 'flex-start', backgroundColor: c.yapiSoft, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4 }}
        >
          <Text style={{ color: c.yapi, fontSize: 12, fontWeight: '700' }}>{post.community.name}</Text>
        </Pressable>
      ) : null}

      {post.body ? <Text style={{ color: c.ink, fontSize: 15, lineHeight: 22 }}>{post.body}</Text> : null}

      {imageUri ? (
        <Image
          source={{ uri: mediaUrl(imageUri) }}
          accessibilityLabel={image?.altText ?? 'Photo'}
          style={{
            width: '100%',
            aspectRatio: image?.width && image?.height ? Math.max(0.75, Math.min(1.9, image.width / image.height)) : 4 / 3,
            borderRadius: radius.md,
            backgroundColor: c.surfaceSunken,
          }}
          resizeMode="cover"
        />
      ) : null}

      {post.poll ? (
        <View style={{ gap: space[1] }}>
          {post.poll.options.map((o) => (
            <Text key={o.id} style={{ color: c.inkMuted, fontSize: 14 }}>
              {o.label} · {o.votes} {o.votes === 1 ? 'vote' : 'votes'}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[4] }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={liked ? 'Unlike' : 'Like'}
          accessibilityState={{ selected: liked }}
          hitSlop={8}
          onPress={async () => {
            const next = !liked;
            setLiked(next);
            setLikes((n) => n + (next ? 1 : -1));
            try {
              const api = await client();
              const r = next ? await api.posts.like(post.id) : await api.posts.unlike(post.id);
              setLiked(r.liked);
              setLikes(r.likes);
            } catch {
              setLiked(!next);
              setLikes((n) => n + (next ? -1 : 1));
            }
          }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <Icon name={liked ? 'heart' : 'heart-outline'} size={20} color={liked ? c.yapi : c.inkMuted} />
          <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '600' }}>{likes}</Text>
        </Pressable>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }} accessible accessibilityLabel={`${post.counts.comments} comments`}>
          <Icon name="chatbubble-outline" size={19} color={c.inkMuted} />
          <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '600' }}>{post.counts.comments}</Text>
        </View>
        <View style={{ flex: 1 }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={saved ? 'Remove from saved' : 'Save'}
          accessibilityState={{ selected: saved }}
          hitSlop={8}
          onPress={async () => {
            const next = !saved;
            setSaved(next);
            try {
              const api = await client();
              await (next ? api.posts.save(post.id) : api.posts.unsave(post.id));
            } catch {
              setSaved(!next);
            }
          }}
        >
          <Icon name={saved ? 'bookmark' : 'bookmark-outline'} size={19} color={saved ? c.yapi : c.inkMuted} />
        </Pressable>
      </View>
    </Card>
  );
}
