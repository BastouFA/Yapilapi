import { router } from 'expo-router';
import { Fragment, useEffect, useState } from 'react';
import { Alert, Image, Platform, Pressable, Share, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { splitRichText } from '../../../packages/shared/src/hashtags';
import type { Conversation, PhotoTag, Post, PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl, webUrl } from './api';
import { useSession } from './session';
import { useT, type Translate } from './i18n';
import { radius, space } from './theme';
import { Avatar, Button, Card, Icon, Notice, PlusBadge, useColors, userText } from './ui';
import { LockedPanel } from './money';
import { SensitiveCover } from './safety';
import { EditPostSheet, HistorySheet } from './post-edit';

export const conversationTitle = (c: Conversation, meId: string | undefined, t: Translate) =>
  c.title ??
  (c.members
    .filter((m) => m.id !== meId)
    .map((m) => m.displayName)
    .join(', ') ||
    t('m.chat.justYou'));

/** Text with #tags and @mentions that open the tag or the person's profile. */
export function RichText({
  text,
  style,
  numberOfLines,
  linkStyle,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /** Overrides the link look (Reels show white links over the video). */
  linkStyle?: StyleProp<TextStyle>;
}) {
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
            style={[{ color: c.yapi, fontWeight: '600' }, linkStyle]}
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

/** "Ada", "Ada and Bola", "Ada, Bola and Chi" in the app's language. */
export const joinNames = (names: string[], t: Translate) =>
  names.map((n, i) => (i === 0 ? '' : i === names.length - 1 ? t('m.collab.joinLast') : t('m.collab.joinSep')) + n).join('');

/**
 * A post's authors: "Ada" or, with co-authors, "Ada and Bola" where each name opens that
 * person's profile.
 */
export function AuthorNames({
  author,
  collaborators = [],
  style,
  numberOfLines,
}: {
  author: PublicUser;
  collaborators?: PublicUser[];
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const { t } = useT();
  const people = [author, ...collaborators.filter((u) => u.id !== author.id)];
  return (
    <Text style={[style, userText]} numberOfLines={numberOfLines}>
      {people.length === 1
        ? author.displayName
        : people.map((u, i) => (
            <Fragment key={u.id}>
              {i === 0 ? '' : i === people.length - 1 ? t('m.collab.joinLast') : t('m.collab.joinSep')}
              <Text
                accessibilityRole="link"
                accessibilityLabel={t('m.title.profile') + ': ' + u.displayName}
                suppressHighlighting={false}
                onPress={() => router.push(`/u/${u.username}`)}
              >
                {u.displayName}
              </Text>
            </Fragment>
          ))}
    </Text>
  );
}

/** Name bubbles over a photo at the spots people were tagged; each opens the profile, and you can remove your own tag. */
function TagBubbles({
  tags,
  width,
  height,
  meId,
  onRemove,
}: {
  tags: PhotoTag[];
  width: number;
  height: number;
  meId?: string;
  onRemove: (tag: PhotoTag) => void;
}) {
  const { t } = useT();
  const BOX = 200;
  return (
    <>
      {tags.map((tag) => {
        // Keep short names inside the photo when the spot is near an edge.
        const cx = Math.min(Math.max(tag.x * width, 56), Math.max(56, width - 56));
        const top = Math.min(Math.max(tag.y * height - 14, 4), Math.max(4, height - 36));
        const mine = tag.user.id === meId;
        return (
          <View key={tag.id} pointerEvents="box-none" style={{ position: 'absolute', left: cx - BOX / 2, top, width: BOX, alignItems: 'center' }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                maxWidth: BOX,
                backgroundColor: 'rgba(0,0,0,0.78)',
                borderRadius: 999,
                paddingHorizontal: 10,
                minHeight: 28,
              }}
            >
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={t('m.title.profile') + ': ' + tag.user.displayName}
                hitSlop={6}
                onPress={() => router.push(`/u/${tag.user.username}`)}
                style={{ flexShrink: 1 }}
              >
                <Text style={[{ color: '#FFFFFF', fontWeight: '700', fontSize: 13 }, userText]} numberOfLines={1}>
                  {tag.user.displayName}
                </Text>
              </Pressable>
              {mine ? (
                <Pressable accessibilityRole="button" accessibilityLabel={t('m.tags.removeMine')} hitSlop={8} onPress={() => onRemove(tag)}>
                  <Icon name="close" size={14} color="#FFFFFF" />
                </Pressable>
              ) : null}
            </View>
          </View>
        );
      })}
    </>
  );
}

/**
 * A post as a rounded card. Tapping it opens the post; like and save update in
 * place. Your own posts can be edited from More; "Edited" opens the history.
 */
export function PostCard({ post: given, open = true }: { post: Post; open?: boolean }) {
  const c = useColors();
  const { t, tp, number, timeAgo, dateTime } = useT();
  // The post as shown: the one given, or the version you just saved.
  const [post, setPost] = useState(given);
  useEffect(() => setPost(given), [given]);
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [liked, setLiked] = useState(post.viewer.liked);
  const [likes, setLikes] = useState(post.counts.likes);
  const [saved, setSaved] = useState(post.viewer.saved);
  const [reposted, setReposted] = useState(post.viewer.reposted);
  const [reposts, setReposts] = useState(post.counts.reposts);
  const { me } = useSession();
  const canRepost = post.visibility === 'public' && post.author.id !== me?.id;
  // Sensitive photos stay blurred until the person chooses to view them (the API never sends them to under-18s).
  const [revealed, setRevealed] = useState(false);
  const image = post.media.find((m) => m.kind === 'image');
  const covered = !!image?.sensitive && !revealed;
  const imageUri = image ? (image.variants?.medium ?? image.url) : null;
  const isAuthor = !!me && post.author.id === me.id;
  // Co-authoring: your invite to this post (if any), who accepted, and (on your own posts) who hasn't answered yet.
  const [collab, setCollab] = useState(post.viewer.collab);
  const [coauthors, setCoauthors] = useState<PublicUser[]>(post.collaborators ?? []);
  const pending = isAuthor ? (post.pendingCollaborators ?? []) : [];
  const [collabBusy, setCollabBusy] = useState(false);
  const [collabError, setCollabError] = useState<string | null>(null);
  // Photo tags: tap the photo to show or hide the names.
  const [tags, setTags] = useState<PhotoTag[]>(image?.tags ?? []);
  const [showTags, setShowTags] = useState(false);
  const [photoSize, setPhotoSize] = useState<{ width: number; height: number } | null>(null);
  const myTag = me ? tags.find((x) => x.user.id === me.id) : undefined;

  async function answerInvite(accept: boolean) {
    setCollabBusy(true);
    setCollabError(null);
    try {
      const api = await client();
      if (accept) {
        const r = await api.posts.acceptCollab(post.id);
        setCoauthors(r.post.collaborators ?? []);
        setCollab('accepted');
      } else {
        await api.posts.declineCollab(post.id);
        setCollab(undefined);
      }
    } catch (e) {
      setCollabError(errorMessage(e));
    } finally {
      setCollabBusy(false);
    }
  }

  async function leave() {
    setCollabError(null);
    try {
      await (await client()).posts.leaveCollab(post.id);
      setCollab(undefined);
      setCoauthors((cur) => cur.filter((u) => u.id !== me?.id));
    } catch (e) {
      setCollabError(errorMessage(e));
    }
  }

  async function removeTag(tag: PhotoTag) {
    const before = tags;
    setTags((cur) => cur.filter((x) => x.id !== tag.id));
    try {
      await (await client()).posts.removeTag(post.id, tag.id);
    } catch (e) {
      setTags(before);
      setCollabError(errorMessage(e));
    }
  }

  // Drafts and scheduled posts are changed from Drafts, not here.
  const canEdit = isAuthor && !post.status;

  /** More: edit your post, leave as co-author, remove your photo tag. */
  function more() {
    const options: { text: string; style?: 'destructive' | 'cancel'; onPress?: () => void }[] = [];
    if (canEdit) options.push({ text: t('m.post.edit'), onPress: () => setEditing(true) });
    if (collab === 'accepted') options.push({ text: t('m.collab.leave'), style: 'destructive', onPress: () => void leave() });
    if (myTag) options.push({ text: t('m.tags.removeMine'), onPress: () => void removeTag(myTag) });
    options.push({ text: t('common.cancel'), style: 'cancel' });
    Alert.alert(t('m.post.more'), collab === 'accepted' ? t('m.collab.leaveBody', { name: post.author.displayName }) : undefined, options);
  }

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
      {coauthors.length ? (
        // With co-authors each name is its own link, so the row isn't one big link.
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={t('m.title.profile') + ': ' + post.author.displayName}
            onPress={() => router.push(`/u/${post.author.username}`)}
          >
            <Avatar name={post.author.displayName} url={post.author.avatarUrl} size={40} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <AuthorNames author={post.author} collaborators={coauthors} numberOfLines={2} style={{ color: c.ink, fontWeight: '700', fontSize: 15 }} />
            <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]} numberOfLines={1}>
              {timeAgo(post.createdAt)}
              {post.reason ? ` · ${post.reason}` : ''}
            </Text>
          </View>
        </View>
      ) : (
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
      )}

      {post.status ? (
        <Text style={{ color: c.ink, fontSize: 13, fontWeight: '700' }}>
          {post.status === 'scheduled' && post.scheduledAt ? t('m.drafts.scheduledFor', { time: dateTime(post.scheduledAt) }) : t('m.drafts.draft')}
        </Text>
      ) : null}
      {post.editedAt ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('m.post.edited')}
          accessibilityHint={t('m.post.editedHint')}
          hitSlop={8}
          onPress={() => setHistory(true)}
          style={{ alignSelf: 'flex-start' }}
        >
          <Text style={{ color: c.inkMuted, fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' }}>{t('m.post.edited')}</Text>
        </Pressable>
      ) : null}

      {pending.length ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="people-outline" size={14} color={c.inkMuted} />
          <Text style={[{ color: c.inkMuted, fontSize: 13, flexShrink: 1 }, userText]}>
            {t('m.collab.waiting', {
              names: joinNames(
                pending.map((u) => u.displayName),
                t,
              ),
            })}
          </Text>
        </View>
      ) : null}

      {collab === 'pending' ? (
        <View style={{ backgroundColor: c.yapiSoft, borderRadius: radius.md, padding: space[3], gap: space[2] }}>
          <Text style={[{ color: c.ink, fontWeight: '700', lineHeight: 20 }, userText]}>{t('m.collab.invited', { name: post.author.displayName })}</Text>
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.collab.invitedHint')}</Text>
          <View style={{ flexDirection: 'row', gap: space[2] }}>
            <Button label={t('m.collab.accept')} size="sm" disabled={collabBusy} onPress={() => void answerInvite(true)} />
            <Button label={t('m.collab.decline')} size="sm" variant="secondary" disabled={collabBusy} onPress={() => void answerInvite(false)} />
          </View>
        </View>
      ) : null}
      {collabError ? <Notice tone="danger">{collabError}</Notice> : null}

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

      {post.locked ? <LockedPanel post={post} /> : null}
      {post.remixOf?.post ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push({ pathname: '/reels', params: { start: post.remixOf!.post!.id } })}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}
        >
          <Icon name="copy-outline" size={14} color={c.inkMuted} />
          <Text style={[{ color: c.inkMuted, fontSize: 13, fontWeight: '600' }, userText]} numberOfLines={1}>
            {t(post.remixOf.mode === 'duet' ? 'm.reels.duetWith' : 'm.reels.remixOf', { name: post.remixOf.post.author.username })}
          </Text>
        </Pressable>
      ) : null}
      {post.sound ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push(`/sounds/${post.sound!.id}`)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', maxWidth: '100%' }}
        >
          <Icon name="musical-notes" size={14} color={c.inkMuted} />
          <Text style={[{ color: c.inkMuted, fontSize: 13, fontWeight: '600', flexShrink: 1 }, userText]} numberOfLines={1}>
            {post.sound.title}
          </Text>
        </Pressable>
      ) : null}

      {imageUri ? (
        <View
          style={{ borderRadius: radius.md, overflow: 'hidden' }}
          onLayout={(e) => setPhotoSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
        >
          <Pressable
            // A photo with people tagged: a tap shows or hides their names (instead of opening the post).
            disabled={!tags.length || covered}
            accessibilityRole={tags.length && !covered ? 'button' : 'image'}
            accessibilityLabel={covered ? undefined : `${image?.altText ?? t('m.post.photo')}${tags.length ? `. ${tp('m.tags.count', tags.length)}` : ''}`}
            accessibilityHint={tags.length && !covered ? (showTags ? t('m.tags.hide') : t('m.tags.show')) : undefined}
            accessibilityElementsHidden={covered}
            onPress={() => setShowTags((v) => !v)}
          >
            <Image
              source={{ uri: mediaUrl(imageUri) }}
              blurRadius={covered ? 40 : 0}
              style={{
                width: '100%',
                aspectRatio: image?.width && image?.height ? Math.max(0.75, Math.min(1.9, image.width / image.height)) : 4 / 3,
                backgroundColor: c.surfaceSunken,
              }}
              resizeMode="cover"
            />
          </Pressable>
          {tags.length && !covered ? (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                bottom: space[2],
                start: space[2],
                width: 28,
                height: 28,
                borderRadius: 14,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'rgba(0,0,0,0.6)',
              }}
            >
              <Icon name="person" size={15} color="#FFFFFF" />
            </View>
          ) : null}
          {showTags && photoSize && !covered ? (
            <TagBubbles tags={tags} width={photoSize.width} height={photoSize.height} meId={me?.id} onRemove={(tag) => void removeTag(tag)} />
          ) : null}
          {covered ? <SensitiveCover onReveal={() => setRevealed(true)} /> : null}
        </View>
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

      {/* Drafts and scheduled posts can't be liked, shared or saved yet. */}
      {post.status ? null : (
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
          {canRepost ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={reposted ? t('m.reels.undoRepost') : t('m.reels.repost')}
              accessibilityState={{ selected: reposted }}
              hitSlop={8}
              onPress={async () => {
                const next = !reposted;
                setReposted(next);
                setReposts((n) => Math.max(0, n + (next ? 1 : -1)));
                try {
                  const api = await client();
                  const r = next ? await api.posts.repost(post.id) : await api.posts.unrepost(post.id);
                  setReposted(r.reposted);
                  setReposts(r.reposts);
                } catch {
                  setReposted(!next);
                  setReposts((n) => Math.max(0, n + (next ? -1 : 1)));
                }
              }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              <Icon name="repeat" size={20} color={reposted ? c.success : c.inkMuted} />
              <Text style={{ color: reposted ? c.success : c.inkMuted, fontSize: 13, fontWeight: '600' }}>{number(reposts)}</Text>
            </Pressable>
          ) : null}
          {post.visibility !== 'private' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.common.share')}
              hitSlop={8}
              onPress={async () => {
                const url = `${webUrl}${post.format === 'reel' ? `/reels?start=${post.id}` : `/p/${post.id}`}`;
                const title = t('m.reels.shareTitle', { name: post.author.displayName });
                try {
                  // iOS shares the link as a link; Android only takes a message.
                  await Share.share(Platform.OS === 'ios' ? { url, message: title } : { message: `${title}\n${url}`, title });
                } catch {
                  // The person closed the share sheet.
                }
              }}
            >
              <Icon name="paper-plane-outline" size={19} color={c.inkMuted} />
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }} />
          {collab === 'accepted' || myTag || canEdit ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t('m.post.more')} hitSlop={8} onPress={more}>
              <Icon name="ellipsis-horizontal" size={20} color={c.inkMuted} />
            </Pressable>
          ) : null}
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
      )}
      {editing ? (
        <EditPostSheet
          post={post}
          onClose={() => setEditing(false)}
          onSaved={(p) => {
            setPost(p);
            if (p.media.find((m) => m.kind === 'image')) setTags(p.media.find((m) => m.kind === 'image')!.tags ?? []);
          }}
        />
      ) : null}
      {history ? <HistorySheet postId={post.id} onClose={() => setHistory(false)} /> : null}
    </Card>
  );
}
