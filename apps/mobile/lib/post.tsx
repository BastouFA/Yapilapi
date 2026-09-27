import { router } from 'expo-router';
import { Fragment, memo, useEffect, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, Share, Text, View, type StyleProp, type TextStyle } from 'react-native';
import type { Conversation, MediaItem, PhotoTag, Post, PublicUser } from '../../../packages/shared/src/types';
import { formatBytes } from '../../../packages/shared/src/data-saver';
import { client, errorMessage, mediaUrl, webUrl } from './api';
import { useDataSaver } from './data-saver';
import { useBoards, type SaveChange } from './boards';
import { useSession } from './session';
import { useT, type Translate } from './i18n';
import { radius, space } from './theme';
import { type ActionSheetAction, Avatar, Button, Card, Icon, Notice, PlusBadge, useActionSheet, useColors, userText } from './ui';
import { LockedPanel, TipButton } from './money';
import { SensitiveCover } from './safety';
import { EditPostSheet, HistorySheet } from './post-edit';
import { RichText } from './rich-text';
import { TranslatableText } from './translation';
import { PostMusicChip } from './music';
import { MediaViewer } from './media-viewer';
import { RepostersSheet } from './reposters';
import { useFlag } from './flags';
import { AddToMemorySheet } from './memories';

export { RichText };

export const conversationTitle = (c: Conversation, meId: string | undefined, t: Translate) =>
  c.title ??
  (c.members
    .filter((m) => m.id !== meId)
    .map((m) => m.displayName)
    .join(', ') ||
    t('m.chat.justYou'));

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
 * Memoised: in a long feed a card only renders again when its post changes.
 */
export const PostCard = memo(PostCardView);

function PostCardView({ post: given, open = true }: { post: Post; open?: boolean }) {
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
  const boards = useBoards();
  const onSaveChange = (ch: SaveChange) => setSaved(ch.saved);
  const saveTo = () => boards.openSaveSheet(post, onSaveChange);
  const [reposted, setReposted] = useState(post.viewer.reposted);
  const [reposts, setReposts] = useState(post.counts.reposts);
  const { me } = useSession();
  const canRepost = post.visibility === 'public' && post.author.id !== me?.id;
  const saver = useDataSaver().active;
  // The photos and videos shown in the card (a reel shows its own preview instead).
  const gallery = post.media.filter((m) => m.kind === 'image' || m.kind === 'video');
  const isAuthor = !!me && post.author.id === me.id;
  // "Reposted by", on your own posts.
  const [repostersOpen, setRepostersOpen] = useState(false);
  // Co-authoring: your invite to this post (if any), who accepted, and (on your own posts) who hasn't answered yet.
  const [collab, setCollab] = useState(post.viewer.collab);
  const [coauthors, setCoauthors] = useState<PublicUser[]>(post.collaborators ?? []);
  const pending = isAuthor ? (post.pendingCollaborators ?? []) : [];
  const [collabBusy, setCollabBusy] = useState(false);
  const [collabError, setCollabError] = useState<string | null>(null);
  // Photo tags, per photo: the tag button on a photo shows or hides the names.
  const [tags, setTags] = useState<Record<string, PhotoTag[]>>(() => tagsOf(post));
  const myTag = me
    ? Object.values(tags)
        .flat()
        .find((x) => x.user.id === me.id)
    : undefined;

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
    setTags((cur) => Object.fromEntries(Object.entries(cur).map(([id, list]) => [id, list.filter((x) => x.id !== tag.id)])));
    try {
      await (await client()).posts.removeTag(post.id, tag.id);
    } catch (e) {
      setTags(before);
      setCollabError(errorMessage(e));
    }
  }

  // Drafts and scheduled posts are changed from Drafts, not here.
  const canEdit = isAuthor && !post.status;
  // Memories (behind the MEMORY flag): add a published post to one of yours.
  const memoryOn = useFlag('MEMORY');
  const canRemember = !!me && !post.status && memoryOn === true;
  const [remembering, setRemembering] = useState(false);
  // Your published posts (and ones you co-author) have insights; your public ones can be boosted.
  const canSeeInsights = !post.status && (isAuthor || collab === 'accepted');
  const adsOn = useFlag('ADS');
  const commerceOn = useFlag('COMMERCE');
  const canBoost = isAuthor && !post.status && post.visibility === 'public' && adsOn === true && commerceOn !== false;
  // A tip for a creator's post, paid on the web.
  const canTip = !!me && !isAuthor && !post.status && !post.locked && post.author.mode === 'creator';

  /** More: insights and boost, edit your post, save to a board, add to a memory, leave as co-author, remove your photo tag. */
  const menu = useActionSheet();
  function more() {
    const actions: ActionSheetAction[] = [];
    if (canSeeInsights) actions.push({ label: t('m.post.insights'), icon: 'stats-chart-outline', onPress: () => router.push(`/insights/${post.id}`) });
    if (canBoost)
      actions.push({ label: t('m.boost.cta'), icon: 'rocket-outline', onPress: () => router.push({ pathname: '/boost', params: { id: post.id } }) });
    if (canEdit) actions.push({ label: t('m.post.edit'), icon: 'create-outline', onPress: () => setEditing(true) });
    if (me) actions.push({ label: t('m.boards.saveTo'), icon: 'bookmarks-outline', onPress: saveTo });
    if (canRemember) actions.push({ label: t('m.mem.addToMemory'), icon: 'albums-outline', onPress: () => setRemembering(true) });
    if (collab === 'accepted') actions.push({ label: t('m.collab.leave'), icon: 'exit-outline', destructive: true, onPress: () => void leave() });
    if (myTag) actions.push({ label: t('m.tags.removeMine'), icon: 'pricetag-outline', onPress: () => void removeTag(myTag) });
    menu.show({
      title: t('m.post.more'),
      message: collab === 'accepted' ? t('m.collab.leaveBody', { name: post.author.displayName }) : undefined,
      actions,
    });
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
              {post.editedAt ? (
                <>
                  {' · '}
                  <Text
                    accessibilityRole="button"
                    accessibilityHint={t('m.post.editedHint')}
                    onPress={() => setHistory(true)}
                    style={{ textDecorationLine: 'underline', fontWeight: '600' }}
                  >
                    {t('m.post.edited')}
                  </Text>
                </>
              ) : null}
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
              {post.editedAt ? (
                <>
                  {' · '}
                  <Text
                    accessibilityRole="button"
                    accessibilityHint={t('m.post.editedHint')}
                    onPress={() => setHistory(true)}
                    style={{ textDecorationLine: 'underline', fontWeight: '600' }}
                  >
                    {t('m.post.edited')}
                  </Text>
                </>
              ) : null}
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
            <Button label={t('m.collab.accept')} size="sm" disabled={collabBusy} onPress={() => answerInvite(true)} />
            <Button label={t('m.collab.decline')} size="sm" variant="secondary" disabled={collabBusy} onPress={() => answerInvite(false)} />
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

      {post.body ? (
        <TranslatableText
          kind="post"
          id={post.id}
          text={post.body}
          lang={post.lang}
          own={post.author.id === me?.id || !!post.status}
          style={{ color: c.ink, fontSize: 15, lineHeight: 22 }}
        />
      ) : null}

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
      {post.music ? <PostMusicChip music={post.music} /> : null}

      {post.format === 'reel' && !post.locked && post.media.some((m) => m.kind === 'video') ? <ReelPreview post={post} saver={saver} /> : null}
      {post.format !== 'reel' && gallery.length ? <MediaGallery media={gallery} tags={tags} meId={me?.id} onRemoveTag={(tag) => void removeTag(tag)} /> : null}

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
          ) : reposts && isAuthor ? (
            // Your own post: the count opens who reposted it.
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${t('post.reposts')}, ${number(reposts)}`}
              accessibilityHint={t('m.post.repostersHint')}
              hitSlop={8}
              onPress={() => setRepostersOpen(true)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 }}
            >
              <Icon name="repeat" size={20} color={c.inkMuted} />
              <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '600', textDecorationLine: 'underline' }}>{number(reposts)}</Text>
            </Pressable>
          ) : reposts ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }} accessible accessibilityLabel={`${t('post.reposts')}, ${number(reposts)}`}>
              <Icon name="repeat" size={20} color={c.inkMuted} />
              <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '600' }}>{number(reposts)}</Text>
            </View>
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
          {canTip ? <TipButton post={post} /> : null}
          <View style={{ flex: 1 }} />
          {collab === 'accepted' || myTag || canEdit || canRemember || canSeeInsights ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t('m.post.more')} hitSlop={8} onPress={more}>
              <Icon name="ellipsis-horizontal" size={20} color={c.inkMuted} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={saved ? t('m.post.unsave') : t('post.save')}
            accessibilityState={{ selected: saved }}
            // Press and hold for "Save to…"; screen readers get it as a named action.
            accessibilityActions={me ? [{ name: 'saveTo', label: t('m.boards.saveTo') }] : undefined}
            onAccessibilityAction={(e) => {
              if (e.nativeEvent.actionName === 'saveTo') saveTo();
            }}
            hitSlop={8}
            onLongPress={me ? saveTo : undefined}
            onPress={async () => {
              const next = !saved;
              setSaved(next);
              try {
                const api = await client();
                await (next ? api.posts.save(post.id) : api.posts.unsave(post.id));
                if (next) boards.confirmSaved(post, onSaveChange);
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
            setTags(tagsOf(p));
          }}
        />
      ) : null}
      {history ? <HistorySheet postId={post.id} onClose={() => setHistory(false)} /> : null}
      {repostersOpen ? <RepostersSheet postId={post.id} onClose={() => setRepostersOpen(false)} /> : null}
      {remembering ? <AddToMemorySheet postId={post.id} onClose={() => setRemembering(false)} /> : null}
      {menu.sheet}
    </Card>
  );
}

/** Each photo's tags, by photo. */
const tagsOf = (p: Post): Record<string, PhotoTag[]> => Object.fromEntries(p.media.filter((m) => m.tags?.length).map((m) => [m.id, m.tags!]));

const clampRatio = (r: number) => Math.max(0.75, Math.min(1.9, r));

/**
 * A post's photos and videos: one, or a carousel to swipe through with dots. A tap opens the
 * full-screen viewer at that one. Sensitive media stays blurred until the person chooses to see
 * it (one choice for the post; the API never sends it to under-18s). On Data saver photos load
 * small first, over their blurred preview, with "Load full photo". Photos with people tagged
 * have a button that shows or hides the names.
 */
function MediaGallery({
  media,
  tags,
  meId,
  onRemoveTag,
}: {
  media: MediaItem[];
  tags: Record<string, PhotoTag[]>;
  meId?: string;
  onRemoveTag: (tag: PhotoTag) => void;
}) {
  const c = useColors();
  const { t, tp, number } = useT();
  const saver = useDataSaver().active;
  const [revealed, setRevealed] = useState(false);
  const [full, setFull] = useState<ReadonlySet<string>>(() => new Set());
  const [showTags, setShowTags] = useState(false);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const [viewer, setViewer] = useState<number | null>(null);
  const covered = media.some((m) => m.sensitive) && !revealed;
  const first = media[0]!;
  const ratio = first.width && first.height ? clampRatio(first.width / first.height) : first.kind === 'video' ? 16 / 9 : 4 / 3;
  const many = media.length > 1;
  const current = media[Math.min(page, media.length - 1)]!;
  const currentTags = current.kind === 'image' ? (tags[current.id] ?? []) : [];

  const small = (m: MediaItem) => saver && !full.has(m.id) && !!m.variants?.thumb;
  const src = (m: MediaItem) =>
    m.kind === 'video'
      ? saver
        ? (m.variants?.thumb ?? m.posterUrl ?? null)
        : (m.posterUrl ?? m.variants?.thumb ?? null)
      : small(m)
        ? m.variants!.thumb!
        : (m.variants?.medium ?? m.url);
  const fullBytes = current.sizes?.medium ?? current.sizes?.original;
  const label = (m: MediaItem, i: number) =>
    m.altText || t(m.kind === 'video' ? 'm.viewer.videoOf' : 'ds.media.photoOf', { index: number(i + 1), total: number(media.length) });

  const pageView = (m: MediaItem, i: number) => {
    const uri = src(m);
    return (
      <Pressable
        key={m.id}
        accessibilityRole="imagebutton"
        accessibilityLabel={t('ds.media.openFull', { label: label(m, i) })}
        accessibilityElementsHidden={covered}
        importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
        disabled={covered}
        onPress={() => setViewer(i)}
        style={{ width: many ? width : '100%', height: '100%' }}
      >
        {saver && m.placeholder ? (
          <Image
            source={{ uri: m.placeholder }}
            blurRadius={20}
            style={{ position: 'absolute', top: 0, bottom: 0, start: 0, end: 0 }}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
          />
        ) : null}
        {uri ? (
          <Image
            source={{ uri: mediaUrl(uri) }}
            blurRadius={covered ? 40 : 0}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
          />
        ) : null}
        {m.kind === 'video' && !covered ? (
          <View style={{ position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, alignItems: 'center', justifyContent: 'center' }} pointerEvents="none">
            <View style={{ width: 52, height: 52, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(5,6,11,0.5)' }}>
              <Icon name="play" size={24} color="#FFFFFF" />
            </View>
          </View>
        ) : null}
        {m.altText && !covered ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: space[2],
              start: space[2],
              paddingHorizontal: 5,
              paddingVertical: 1,
              borderRadius: 4,
              backgroundColor: 'rgba(0,0,0,0.7)',
            }}
          >
            <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: 11 }}>{t('ds.media.alt')}</Text>
          </View>
        ) : null}
      </Pressable>
    );
  };

  return (
    <View style={{ gap: space[2] }}>
      <View
        style={{ width: '100%', aspectRatio: ratio, borderRadius: radius.md, overflow: 'hidden', backgroundColor: c.surfaceSunken }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        {many ? (
          width ? (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              horizontal
              pagingEnabled
              scrollEnabled={!covered}
              showsHorizontalScrollIndicator={false}
              onMomentumScrollEnd={(e) => {
                setPage(Math.max(0, Math.min(media.length - 1, Math.round(e.nativeEvent.contentOffset.x / width))));
                setShowTags(false);
              }}
            >
              {media.map(pageView)}
            </ScrollView>
          ) : null
        ) : (
          pageView(first, 0)
        )}
        {many && !covered ? (
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
              position: 'absolute',
              top: space[2],
              end: space[2],
              paddingHorizontal: 8,
              paddingVertical: 3,
              borderRadius: 999,
              backgroundColor: 'rgba(0,0,0,0.6)',
            }}
          >
            <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] }}>
              {t('m.boards.position', { index: number(page + 1), total: number(media.length) })}
            </Text>
          </View>
        ) : null}
        {!covered && current.kind === 'image' && small(current) && current.variants?.thumb !== (current.variants?.medium ?? current.url) ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setFull((f) => new Set(f).add(current.id))}
            style={{
              position: 'absolute',
              bottom: space[2],
              alignSelf: 'center',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              minHeight: 36,
              paddingHorizontal: space[3],
              borderRadius: 999,
              backgroundColor: 'rgba(0,0,0,0.65)',
            }}
          >
            <Icon name="image-outline" size={14} color="#FFFFFF" />
            <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '600' }}>
              {fullBytes ? t('dataSaver.loadFullSize', { size: formatBytes(fullBytes) }) : t('dataSaver.loadFull')}
            </Text>
          </Pressable>
        ) : null}
        {showTags && width > 0 && !covered && currentTags.length > 0 ? (
          <TagBubbles tags={currentTags} width={width} height={width / ratio} meId={meId} onRemove={onRemoveTag} />
        ) : null}
        {currentTags.length && !covered ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={tp('m.tags.count', currentTags.length)}
            accessibilityHint={showTags ? t('m.tags.hide') : t('m.tags.show')}
            accessibilityState={{ expanded: showTags }}
            onPress={() => setShowTags((v) => !v)}
            style={{ position: 'absolute', bottom: 0, start: 0, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: showTags ? '#FFFFFF' : 'rgba(0,0,0,0.6)',
              }}
            >
              <Icon name="person" size={15} color={showTags ? '#000000' : '#FFFFFF'} />
            </View>
          </Pressable>
        ) : null}
        {covered ? <SensitiveCover onReveal={() => setRevealed(true)} /> : null}
      </View>
      {many ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ flexDirection: 'row', justifyContent: 'center', gap: 5 }}
          pointerEvents="none"
        >
          {media.map((m, i) => (
            <View key={m.id} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: i === page ? c.yapi : c.line }} />
          ))}
        </View>
      ) : null}
      {viewer !== null ? <MediaViewer media={media} index={viewer} onClose={() => setViewer(null)} /> : null}
    </View>
  );
}

/**
 * A reel in a feed, on a profile or a tag page: its poster frame with a play sign and "Watch reel";
 * a tap opens it full screen in Reels, at this reel (Back returns here).
 */
function ReelPreview({ post, saver }: { post: Post; saver: boolean }) {
  const c = useColors();
  const { t } = useT();
  const m = post.media.find((x) => x.kind === 'video')!;
  const poster = saver ? (m.variants?.thumb ?? m.posterUrl) : m.posterUrl;
  const ratio = m.width && m.height ? m.width / m.height : 9 / 16;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t('reel.card.label', { name: post.author.displayName })}
      onPress={() => router.push({ pathname: '/reels', params: { start: post.id } })}
      style={({ pressed }) => ({
        alignSelf: ratio > 1.2 ? 'stretch' : 'flex-start',
        width: ratio > 1.2 ? undefined : '72%',
        aspectRatio: ratio > 1.2 ? 16 / 9 : ratio > 0.85 ? 1 : 9 / 16,
        maxHeight: 460,
        borderRadius: radius.md,
        overflow: 'hidden',
        backgroundColor: '#0B0C14',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {poster ? (
        <Image source={{ uri: mediaUrl(poster) }} blurRadius={m.sensitive ? 40 : 0} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
      ) : null}
      <View style={{ position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, alignItems: 'center', justifyContent: 'center' }} pointerEvents="none">
        <View style={{ width: 56, height: 56, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(5,6,11,0.5)' }}>
          <Icon name="play" size={26} color="#FFFFFF" />
        </View>
      </View>
      <View style={{ position: 'absolute', bottom: space[2], start: space[3], flexDirection: 'row', alignItems: 'center', gap: 6 }} pointerEvents="none">
        <Icon name="sparkles-outline" size={14} color="#FFFFFF" />
        <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: 14, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 }}>
          {t('reel.card.watch')}
        </Text>
      </View>
      <View
        style={{ position: 'absolute', top: 0, start: 0, end: 0, bottom: 0, borderRadius: radius.md, borderWidth: 1, borderColor: c.line }}
        pointerEvents="none"
      />
    </Pressable>
  );
}
