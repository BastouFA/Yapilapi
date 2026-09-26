import { router } from 'expo-router';
import { useState } from 'react';
import { Image, Pressable, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { splitRichText } from '../../../packages/shared/src/hashtags';
import type { Conversation, Post } from '../../../packages/shared/src/types';
import { client, mediaUrl } from './api';
import { useT, type Translate } from './i18n';
import { radius, space } from './theme';
import { Avatar, Card, Icon, PlusBadge, useColors, userText } from './ui';

export const conversationTitle = (c: Conversation, meId: string | undefined, t: Translate) =>
  c.title ??
  (c.members
    .filter((m) => m.id !== meId)
    .map((m) => m.displayName)
    .join(', ') ||
    t('m.chat.justYou'));

/** Text with #tags and @mentions that open the tag or the person's profile. */
export function RichText({ text, style, numberOfLines }: { text: string; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  const c = useColors();
  return (
    <Text style={[style, userText]} numberOfLines={numberOfLines}>
      {splitRichText(text).map((part, i) =>
        'tag' in part || 'mention' in part ? (
          <Text
            key={i}
            accessibilityRole="link"
            suppressHighlighting={false}
            onPress={() => router.push('tag' in part ? `/t/${encodeURIComponent(part.tag)}` : `/u/${part.mention}`)}
            style={{ color: c.yapi, fontWeight: '600' }}
          >
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}

/** A post as a rounded card. Tapping it opens the post; like and save update in place. */
export function PostCard({ post, open = true }: { post: Post; open?: boolean }) {
  const c = useColors();
  const { t, tp, number, timeAgo } = useT();
  const [liked, setLiked] = useState(post.viewer.liked);
  const [likes, setLikes] = useState(post.counts.likes);
  const [saved, setSaved] = useState(post.viewer.saved);
  const image = post.media.find((m) => m.kind === 'image');
  const imageUri = image ? (image.variants?.medium ?? image.url) : null;

  return (
    <Card
      onPress={open ? () => router.push(`/p/${post.id}`) : undefined}
      label={open ? t('m.post.by', { name: post.author.displayName }) : undefined}
      style={{ gap: space[3] }}
    >
      {post.pinned ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Icon name="bookmark" size={12} color={c.inkMuted} />
          <Text style={{ color: c.inkMuted, fontSize: 12, fontWeight: '600' }}>{t('m.post.pinned')}</Text>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={t('m.title.profile') + ': ' + post.author.displayName}
        onPress={() => router.push(`/u/${post.author.username}`)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}
      >
        <Avatar name={post.author.displayName} url={post.author.avatarUrl} size={40} />
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 15, flexShrink: 1 }, userText]} numberOfLines={1}>
              {post.author.displayName}
            </Text>
            {post.author.plus ? <PlusBadge /> : null}
          </View>
          <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]} numberOfLines={1}>
            @{post.author.username} · {timeAgo(post.createdAt)}
            {post.reason ? ` · ${post.reason}` : ''}
          </Text>
        </View>
      </Pressable>

      {post.community ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push(`/c/${post.community!.slug}`)}
          style={{ alignSelf: 'flex-start', backgroundColor: c.yapiSoft, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4 }}
        >
          <Text style={[{ color: c.yapi, fontSize: 12, fontWeight: '700' }, userText]}>{post.community.name}</Text>
        </Pressable>
      ) : null}

      {post.body ? <RichText text={post.body} style={{ color: c.ink, fontSize: 15, lineHeight: 22 }} /> : null}

      {imageUri ? (
        <Image
          source={{ uri: mediaUrl(imageUri) }}
          accessibilityLabel={image?.altText ?? t('m.post.photo')}
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
            <Text key={o.id} style={[{ color: c.inkMuted, fontSize: 14 }, userText]}>
              {o.label} · {tp('m.poll.votes', o.votes)}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[4] }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={liked ? t('post.unlike') : t('post.like')}
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
          <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '600' }}>{number(likes)}</Text>
        </Pressable>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }} accessible accessibilityLabel={tp('m.post.commentCount', post.counts.comments)}>
          <Icon name="chatbubble-outline" size={19} color={c.inkMuted} />
          <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '600' }}>{number(post.counts.comments)}</Text>
        </View>
        <View style={{ flex: 1 }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={saved ? t('m.post.unsave') : t('post.save')}
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
