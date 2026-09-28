import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Platform,
  Pressable,
  RefreshControl,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import type { Post, Profile } from '../../../packages/shared/src/types';
import type { ProfileTab } from '../../../packages/shared/src/profile-style';
import { client, errorMessage, mediaUrl, webUrl } from './api';
import { useT } from './i18n';
import { pickOne, uploadPicked, type Picked } from './media';
import { CoverEditor, CoverPhotoPicker, type CoverEditorTab } from './cover-editor';
import { COVER_RATIO, type CoverRecipe } from '../../../packages/shared/src/cover';
import { liveStatus, NowStatusLine, onStatusChanged } from './now-status';
import { PostCard, RichText } from './post';
import { radius, space } from './theme';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  feedListProps,
  Icon,
  Notice,
  PlusBadge,
  Segmented,
  Skeleton,
  SkeletonList,
  useActionSheet,
  useColors,
  userText,
} from './ui';
import { ShopList, SupportCard } from './money';
import { isVerificationError, VerifyPrompt } from './safety';
import { ChaptersRow } from './chapters';
import { DropsRow } from './drops';
import { ProfileBoards } from './boards';
import { ProfileMenu } from './profile-menu';
import { FeaturedRow, ProfileAbout, ProfileLinks, ProfileSongChip, tabLabel, useTint } from './profile-style';
import type { Tint } from './ui';
import { AnswersList, AskCard } from './ask';
import { ProfileMixes } from './mixes';
import { ProfileMarket } from './market';

/**
 * A profile: name, bio, counts, Follow and Message for other people, and
 * their posts (pinned post first). `actions` adds your own buttons on your
 * profile.
 */
export function ProfileView({
  username,
  actions,
  bottom = 0,
  onMoved,
  initialTab,
}: {
  username: string;
  actions?: ReactNode;
  bottom?: number;
  /** Open on this tab (a notification about an answer opens Answers). */
  initialTab?: ProfileTab;
  /** An old username (changed in the last 14 days) found the profile: its current one, to move there. */
  onMoved?: (username: string) => void;
}) {
  const c = useColors();
  const { t, number } = useT();
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const coverMenu = useActionSheet();
  const [needsVerify, setNeedsVerify] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // null: the first tab the person chose to show.
  const [tab, setTab] = useState<ProfileTab | null>(initialTab ?? null);
  // Photos this person is tagged in, loaded the first time the tab opens.
  const [tagged, setTagged] = useState<{ items: Post[]; cursor: string | null; hidden: boolean } | null>(null);
  // Their reels and reposts, each loaded the first time its tab opens.
  const [lists, setLists] = useState<Partial<Record<'reels' | 'reposts', { items: Post[]; cursor: string | null }>>>({});
  const tint = useTint(profile?.style?.accent);
  // A new cover photo on its way: the phone's copy shows while it uploads and is prepared.
  const [coverUpload, setCoverUpload] = useState<{ local: string; progress: number | null } | null>(null);
  // The cover editor, open on a new photo from the phone or one of your uploads (your cover's original, or a recent photo).
  const [coverEditing, setCoverEditing] = useState<
    | ({ uri: string; width: number | null; height: number | null; initial: CoverRecipe | null; tab: CoverEditorTab } & (
        { kind: 'asset'; asset: Picked } | { kind: 'media'; mediaId: string }
      ))
    | null
  >(null);
  const [coverPicker, setCoverPicker] = useState(false);
  const [coverAlt, setCoverAlt] = useState('');
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);

  // Your status, set or cleared in the status sheet, shows here as soon as you come back.
  useEffect(() => onStatusChanged((nowStatus) => setProfile((p) => (p && p.relationship.isSelf ? { ...p, nowStatus } : p))), []);

  const load = useCallback(async () => {
    const api = await client();
    try {
      const p = (await api.users.get(username)).profile;
      if (onMoved && p.username.toLowerCase() !== username.toLowerCase()) return onMoved(p.username);
      setProfile(p);
      try {
        const page = await api.users.posts(p.username);
        setPosts(page.items);
        setCursor(page.nextCursor);
        setLocked(false);
      } catch {
        setPosts([]);
        setLocked(p.isPrivate && !p.relationship.isSelf);
      }
    } catch {
      setProfile(null);
    }
  }, [username, onMoved]);

  useEffect(() => {
    void load();
    setTagged(null);
    setLists({});
  }, [load]);

  const profileId = profile?.id;
  const loadList = useCallback(
    async (which: 'reels' | 'reposts', next?: string) => {
      if (!profileId) return;
      try {
        const api = await client();
        const page = which === 'reels' ? await api.users.posts(username, next, { format: 'reel' }) : await api.users.reposts(profileId, next);
        setLists((cur) => {
          const had = cur[which];
          return {
            ...cur,
            [which]: {
              items: next && had ? [...had.items, ...page.items.filter((x) => !had.items.some((y) => y.id === x.id))] : page.items,
              cursor: page.nextCursor,
            },
          };
        });
      } catch {
        setLists((cur) => ({ ...cur, [which]: cur[which] ?? { items: [], cursor: null } }));
      }
    },
    [username, profileId],
  );

  const loadTagged = useCallback(
    async (next?: string) => {
      try {
        const page = await (await client()).users.tagged(username, next);
        setTagged((cur) => ({
          items: next && cur ? [...cur.items, ...page.items.filter((x) => !cur.items.some((y) => y.id === x.id))] : page.items,
          cursor: page.nextCursor,
          hidden: !!page.hidden,
        }));
      } catch {
        setTagged((cur) => cur ?? { items: [], cursor: null, hidden: false });
      }
    },
    [username],
  );

  const current: ProfileTab = tab ?? profile?.tabs?.[0] ?? 'posts';
  useEffect(() => {
    if (current === 'tagged' && !tagged) void loadTagged();
    if ((current === 'reels' || current === 'reposts') && !lists[current]) void loadList(current);
  }, [current, tagged, loadTagged, lists, loadList]);

  const more = async () => {
    if (!cursor) return;
    const page = await (await client()).users.posts(username, cursor);
    setPosts((cur) => [...cur, ...page.items.filter((x) => !cur.some((y) => y.id === x.id))]);
    setCursor(page.nextCursor);
  };

  if (profile === undefined) return <ProfileSkeleton bottom={bottom} />;
  if (profile === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.post.unavailable.title')} action={{ label: t('m.common.retry'), icon: 'refresh', onPress: () => void load() }} />
      </View>
    );

  const rel = profile.relationship;
  const status = liveStatus(profile.nowStatus);
  // The tabs they chose, in their order; a link to one they don't list (Answers from a notification) still opens it.
  const tabs: ProfileTab[] = tab && !profile.tabs.includes(tab) ? [...profile.tabs, tab] : profile.tabs;

  async function shareProfile() {
    if (!profile) return;
    const url = `${webUrl}/u/${encodeURIComponent(profile.username)}`;
    const title = t('m.reels.shareTitle', { name: profile.displayName });
    try {
      // iOS shares the link as a link; Android only takes a message.
      await Share.share(Platform.OS === 'ios' ? { url, message: title } : { message: `${title}\n${url}`, title });
    } catch {
      // The person closed the share sheet.
    }
  }

  const coverFrom = (p: Profile) => ({ coverUrl: p.coverUrl, coverAlt: p.coverAlt, coverEdit: p.coverEdit ?? null });

  /** A new photo from the phone opens the cover editor; it is uploaded once you save. */
  async function uploadCover() {
    setError(null);
    const asset = await pickOne(['images']).catch((e: unknown) => {
      setError(errorMessage(e));
      return null;
    });
    if (asset === 'denied') return setError(t('m.create.photosPermission'));
    if (!asset) return;
    setCoverAlt('');
    setCoverEditing({ kind: 'asset', asset, uri: asset.uri, width: asset.width, height: asset.height, initial: null, tab: 'frame' });
  }

  /** Save the cover editor's recipe: straight away for one of your uploads, after uploading a new photo. */
  async function saveCover(recipe: CoverRecipe) {
    const e = coverEditing;
    if (!e) return;
    const alt = coverAlt.trim() || undefined;
    setCoverError(null);
    if (e.kind === 'media') {
      setCoverBusy(true);
      try {
        const r = await (await client()).me.setCover(e.mediaId, alt, recipe);
        setProfile((p) => (p ? { ...p, ...coverFrom(r.profile) } : p));
        setCoverEditing(null);
      } catch (err) {
        setCoverError(errorMessage(err));
      } finally {
        setCoverBusy(false);
      }
      return;
    }
    const asset = e.asset;
    setCoverEditing(null);
    setError(null);
    setCoverUpload({ local: asset.uri, progress: 0 });
    try {
      const m = await uploadPicked(asset, (progress) => setCoverUpload({ local: asset.uri, progress }));
      // Uploaded: the server now prepares the sizes, then renders the cover from the original with your edits.
      setCoverUpload({ local: asset.uri, progress: null });
      const r = await (await client()).me.setCoverWhenReady(m.id, alt, { edit: recipe });
      setProfile((p) => (p ? { ...p, ...coverFrom(r.profile) } : p));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCoverUpload(null);
    }
  }

  function openCoverEdit(tab: CoverEditorTab) {
    const edit = profile?.coverEdit;
    if (!edit) return;
    setCoverAlt(profile?.coverAlt ?? '');
    setCoverEditing({ kind: 'media', mediaId: edit.mediaId, uri: mediaUrl(edit.url), width: edit.width, height: edit.height, initial: edit.recipe, tab });
  }

  function removeCover() {
    Alert.alert(t('m.cover.removeTitle'), t('m.cover.removeBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('m.common.remove'),
        style: 'destructive',
        onPress: async () => {
          setError(null);
          try {
            const r = await (await client()).me.removeCover();
            setProfile((p) => (p ? { ...p, ...coverFrom(r.profile) } : p));
          } catch (e) {
            setError(errorMessage(e));
          }
        },
      },
    ]);
  }

  function editCover() {
    if (!profile?.coverUrl) return setCoverPicker(true);
    const editable = !!profile.coverEdit;
    coverMenu.show({
      title: t('m.cover.edit'),
      actions: [
        ...(editable
          ? [
              { label: t('m.cover.edit'), icon: 'color-wand-outline' as const, onPress: () => openCoverEdit('look') },
              { label: t('coverEditor.adjustPosition'), icon: 'move-outline' as const, onPress: () => openCoverEdit('frame') },
            ]
          : []),
        { label: t('m.cover.choose'), icon: 'image-outline', onPress: () => setCoverPicker(true) },
        { label: t('m.cover.remove'), icon: 'trash-outline', destructive: true, onPress: removeCover },
      ],
    });
  }

  const header = (
    <View style={{ gap: space[3], marginBottom: space[3] }}>
      <Cover profile={profile} tint={tint} upload={coverUpload} onEdit={rel.isSelf ? editCover : undefined} />
      <Card style={{ alignItems: 'center', gap: space[2], paddingVertical: space[6], marginTop: profile.style?.header === 'clean' ? 0 : -56 }}>
        <Avatar name={profile.displayName} url={profile.avatarUrl} size={84} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }, userText]}>
            {profile.displayName}
          </Text>
          {profile.plus ? <PlusBadge /> : null}
        </View>
        {profile.pronouns ? (
          <Text accessibilityLabel={`${t('ps.pronouns')}: ${profile.pronouns}`} style={[{ color: c.inkMuted, fontSize: 14, marginTop: -4 }, userText]}>
            {profile.pronouns}
          </Text>
        ) : null}
        <Text style={[{ color: c.inkMuted }, userText]}>
          @{profile.username}
          {rel.followedBy && !rel.isSelf ? ` · ${t('m.profile.followsYou')}` : ''}
        </Text>
        {status ? <NowStatusLine status={status} center /> : null}
        {profile.bio ? <RichText text={profile.bio} style={{ color: c.ink, fontSize: 15, lineHeight: 22, textAlign: 'center' }} /> : null}
        {profile.song ? <ProfileSongChip song={profile.song} tint={tint} /> : null}
        <ProfileLinks links={profile.links} tint={tint} />
        <ProfileAbout profile={profile} />
        <View style={{ flexDirection: 'row', gap: space[4], marginTop: space[2] }}>
          {(
            [
              ['profile.posts', profile.counts.posts],
              ['profile.followers', profile.counts.followers],
              ['profile.following', profile.counts.following],
              ['profile.friends', profile.counts.friends],
            ] as const
          ).map(([key, n]) => {
            const list = key === 'profile.followers' ? 'followers' : key === 'profile.following' ? 'following' : null;
            const stat = (
              <>
                <Text style={{ color: c.ink, fontWeight: '800', fontSize: 17 }}>{number(n)}</Text>
                <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t(key)}</Text>
              </>
            );
            // Followers and following open the list of people, as on the web.
            return list ? (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityLabel={t('m.common.stat', { label: t(key), count: n })}
                accessibilityHint={t('m.follows.hint')}
                hitSlop={8}
                onPress={() =>
                  router.push({ pathname: '/follows', params: { id: profile.id, kind: list, name: profile.displayName, self: rel.isSelf ? '1' : '' } })
                }
                style={({ pressed }) => ({ alignItems: 'center', minWidth: 44, minHeight: 44, justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
              >
                {stat}
              </Pressable>
            ) : (
              <View
                key={key}
                style={{ alignItems: 'center', minHeight: 44, justifyContent: 'center' }}
                accessible
                accessibilityLabel={t('m.common.stat', { label: t(key), count: n })}
              >
                {stat}
              </View>
            );
          })}
        </View>
        {rel.isSelf ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space[2], marginTop: space[2] }}>
            <Button label={t('profile.edit')} variant="secondary" size="sm" icon="person-circle-outline" onPress={() => router.push('/profile-edit')} />
            <Button
              label={status ? t('m.now.edit') : t('m.now.set')}
              variant="secondary"
              size="sm"
              icon={status ? 'create-outline' : 'add-circle-outline'}
              onPress={() => router.push('/now-status')}
            />
            <Button label={t('m.profile.share')} variant="secondary" size="sm" icon="share-outline" onPress={() => shareProfile()} />
          </View>
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space[2], marginTop: space[2] }}>
            <Button
              label={rel.following ? t('profile.unfollow') : t('profile.follow')}
              variant={rel.following ? 'secondary' : 'primary'}
              tint={tint}
              disabled={busy || rel.blocked}
              onPress={async () => {
                setBusy(true);
                setError(null);
                try {
                  const api = await client();
                  await (rel.following ? api.users.unfollow(profile.id) : api.users.follow(profile.id));
                  await load();
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            />
            <Button
              label={t('profile.message')}
              variant="secondary"
              icon="chatbubble-outline"
              disabled={busy || rel.blocked}
              onPress={async () => {
                setNeedsVerify(false);
                try {
                  const { conversation } = await (await client()).conversations.create([profile.id]);
                  router.push(`/chat/${conversation.id}`);
                } catch (e) {
                  if (isVerificationError(e)) setNeedsVerify(true);
                  else setError(errorMessage(e));
                }
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.profile.share')}
              hitSlop={4}
              onPress={() => void shareProfile()}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: radius.full,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: c.surface,
                borderWidth: 1,
                borderColor: c.line,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Icon name="share-outline" size={18} color={c.ink} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.profile.more')}
              hitSlop={4}
              onPress={() => setMenu(true)}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: radius.full,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: c.surface,
                borderWidth: 1,
                borderColor: c.line,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Icon name="ellipsis-horizontal" size={18} color={c.ink} />
            </Pressable>
          </View>
        )}
      </Card>
      {actions}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {note ? (
        <View accessibilityLiveRegion="polite">
          <Notice>{note}</Notice>
        </View>
      ) : null}
      {rel.isSelf ? null : (
        <ProfileMenu
          profile={profile}
          open={menu}
          onClose={() => setMenu(false)}
          onChanged={load}
          onMessage={(text, tone) => (tone === 'danger' ? (setError(text), setNote(null)) : (setNote(text), setError(null)))}
        />
      )}
      {rel.isSelf || rel.blocked ? null : (
        <SupportCard userId={profile.id} username={profile.username} name={profile.displayName} isCreator={profile.mode === 'creator'} />
      )}
      {rel.blocked ? null : <AskCard profile={profile} tint={tint} onChanged={load} />}
      <FeaturedRow posts={profile.featured} tint={tint} />
      {rel.blocked ? null : <DropsRow userId={profile.id} isSelf={rel.isSelf} />}
      {tabs.length > 1 ? (
        <Segmented label={t('m.title.profile')} value={current} onChange={setTab} tint={tint} options={tabs.map((id) => ({ id, label: t(tabLabel(id)) }))} />
      ) : (
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
          {t(tabLabel(current))}
        </Text>
      )}
      {needsVerify ? <VerifyPrompt action="message" /> : null}
      {coverMenu.sheet}
      {rel.isSelf ? (
        <CoverPhotoPicker
          visible={coverPicker}
          onClose={() => setCoverPicker(false)}
          onUpload={() => {
            setCoverPicker(false);
            // The system picker can't open over a sheet that is still closing.
            setTimeout(() => void uploadCover(), 450);
          }}
          onPick={(p) => {
            setCoverPicker(false);
            setCoverAlt(p.altText ?? '');
            setTimeout(
              () => setCoverEditing({ kind: 'media', mediaId: p.id, uri: mediaUrl(p.url), width: p.width, height: p.height, initial: null, tab: 'frame' }),
              450,
            );
          }}
        />
      ) : null}
      {coverEditing ? (
        <CoverEditor
          uri={coverEditing.uri}
          width={coverEditing.width}
          height={coverEditing.height}
          profile={profile}
          initial={coverEditing.initial}
          initialTab={coverEditing.tab}
          title={coverEditing.tab === 'frame' && coverEditing.initial ? t('coverEditor.adjustPosition') : t('m.cover.edit')}
          altText={coverAlt}
          onAltText={setCoverAlt}
          describeMediaId={coverEditing.kind === 'media' ? coverEditing.mediaId : null}
          busy={coverBusy}
          error={coverError}
          onDone={(recipe) => void saveCover(recipe)}
          onCancel={() => {
            setCoverEditing(null);
            setCoverError(null);
          }}
        />
      ) : null}
    </View>
  );

  return (
    <FlatList
      keyboardShouldPersistTaps="handled"
      {...feedListProps}
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: bottom + space[4] }}
      data={
        current === 'posts'
          ? posts
          : current === 'tagged'
            ? (tagged?.items ?? [])
            : current === 'reels' || current === 'reposts'
              ? (lists[current]?.items ?? [])
              : []
      }
      keyExtractor={(p) => p.id}
      ListHeaderComponent={header}
      renderItem={({ item }) => <PostCard post={item} />}
      onEndReached={() =>
        void (current === 'posts'
          ? more()
          : current === 'tagged' && tagged?.cursor
            ? loadTagged(tagged.cursor)
            : (current === 'reels' || current === 'reposts') && lists[current]?.cursor
              ? loadList(current, lists[current]!.cursor!)
              : undefined)
      }
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            if (current === 'tagged') await loadTagged();
            if (current === 'reels' || current === 'reposts') await loadList(current);
            setRefreshing(false);
          }}
        />
      }
      ListEmptyComponent={
        current === 'answers' ? (
          <AnswersList profile={profile} />
        ) : current === 'mixes' ? (
          <ProfileMixes username={profile.username} isSelf={rel.isSelf} />
        ) : current === 'market' ? (
          <ProfileMarket userId={profile.id} isSelf={rel.isSelf} />
        ) : current === 'shop' ? (
          <ShopList userId={profile.id} username={profile.username} isSelf={rel.isSelf} />
        ) : current === 'boards' ? (
          <ProfileBoards username={profile.username} isSelf={rel.isSelf} />
        ) : current === 'chapters' ? (
          <ChaptersRow userId={profile.id} isSelf={rel.isSelf} emptyText={t('ps.empty.chapters')} />
        ) : current === 'reels' || current === 'reposts' ? (
          !lists[current] ? (
            <SkeletonList kind="post" count={2} />
          ) : (
            <EmptyState title={current === 'reels' ? t('ps.empty.reels') : t('ps.empty.reposts')} />
          )
        ) : current === 'tagged' ? (
          !tagged ? (
            <SkeletonList kind="post" count={2} />
          ) : tagged.hidden ? (
            <EmptyState title={t('m.profile.private')} />
          ) : (
            <EmptyState title={t('m.tagged.empty')} body={rel.isSelf ? t('m.tagged.emptySelf') : undefined} />
          )
        ) : rel.isSelf && !locked ? (
          // Your own profile with nothing on it yet: the way to your first post.
          <EmptyState
            icon="camera-outline"
            title={t('m.empty.you.title')}
            body={t('m.empty.you.body')}
            action={{ label: t('m.empty.you.action'), icon: 'add', onPress: () => router.push('/camera') }}
          />
        ) : (
          <EmptyState title={locked ? t('m.profile.private') : t('m.profile.noPosts')} />
        )
      }
    />
  );
}

/** The shape of a profile while it loads: cover, photo, name, counts, then a couple of posts. */
function ProfileSkeleton({ bottom }: { bottom: number }) {
  const c = useColors();
  const { t } = useT();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('common.loading')}
      style={{ flex: 1, backgroundColor: c.ground, paddingBottom: bottom }}
    >
      <Skeleton height={120} radius={0} />
      <View style={{ padding: space[4], gap: space[3], marginTop: -36 }}>
        <Skeleton width={84} height={84} radius={42} style={{ borderWidth: 3, borderColor: c.ground }} />
        <Skeleton width="50%" height={18} />
        <Skeleton width="30%" height={12} />
        <View style={{ flexDirection: 'row', gap: space[4] }}>
          <Skeleton width={64} height={28} />
          <Skeleton width={64} height={28} />
          <Skeleton width={64} height={28} />
        </View>
        <SkeletonList kind="post" count={2} />
      </View>
    </View>
  );
}

/**
 * The cover photo across the top, fading into the page under the profile card, or a plain band
 * when there is none. On your own profile, `onEdit` adds a button to change or remove it.
 */
function Cover({
  profile,
  tint,
  upload,
  onEdit,
}: {
  profile: Profile;
  tint: Tint;
  upload: { local: string; progress: number | null } | null;
  onEdit?: () => void;
}) {
  const c = useColors();
  const { t, number } = useT();
  // The band spans the screen edge to edge (the page has space[4] padding on each side). Sized from the
  // window rather than aspectRatio, which made it wider than the screen and pushed its button off it.
  const { width: screenWidth } = useWindowDimensions();
  // 'cover': the photo, or the accent gradient without one. 'gradient': always the gradient. 'clean': no band.
  const header = profile.style?.header ?? 'cover';
  if (header === 'clean' && !upload) return null;
  const photoOk = header === 'cover' || !!upload;
  const uri = upload?.local ?? (photoOk && profile.coverUrl ? mediaUrl(profile.coverUrl) : null);
  return (
    <View
      style={{
        // Cover photos are 8:3 (COVER_RATIO), as on the web, so the band shows what was framed in the editor.
        width: screenWidth,
        height: uri ? Math.round(screenWidth / COVER_RATIO) : 104,
        marginHorizontal: -space[4],
        marginTop: -space[4],
        backgroundColor: c.surfaceSunken,
        overflow: 'hidden',
      }}
    >
      {uri ? null : (
        <LinearGradient colors={[tint.accentStrong, tint.accent, tint.gradEnd]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      )}
      {uri ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          accessible
          accessibilityRole="image"
          accessibilityLabel={profile.coverAlt || t('m.cover.alt', { name: profile.displayName })}
          accessibilityIgnoresInvertColors
        />
      ) : null}
      <LinearGradient pointerEvents="none" colors={[`${c.ground}00`, `${c.ground}00`, c.ground]} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} />
      {upload ? (
        <View
          accessibilityLiveRegion="polite"
          style={{
            position: 'absolute',
            alignSelf: 'center',
            top: space[4],
            flexDirection: 'row',
            alignItems: 'center',
            gap: space[2],
            backgroundColor: c.surface,
            borderRadius: radius.full,
            paddingHorizontal: space[3],
            paddingVertical: 6,
          }}
        >
          <ActivityIndicator size="small" color={c.yapi} />
          <Text style={{ color: c.ink, fontSize: 13, fontWeight: '600' }}>
            {upload.progress === null ? t('m.cover.preparing') : t('m.cover.uploading', { progress: number(upload.progress, { style: 'percent' }) })}
          </Text>
        </View>
      ) : onEdit && header === 'cover' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={profile.coverUrl ? t('m.cover.edit') : t('m.cover.add')}
          onPress={onEdit}
          // About 30pt tall; the touch area still reaches 44pt.
          hitSlop={8}
          style={({ pressed }) => ({
            position: 'absolute',
            top: space[3],
            end: space[4],
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            backgroundColor: c.surface,
            borderRadius: radius.full,
            paddingHorizontal: space[3],
            paddingVertical: 6,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Icon name="camera-outline" size={16} color={c.ink} />
          <Text style={{ color: c.ink, fontSize: 13, fontWeight: '600' }}>{profile.coverUrl ? t('m.cover.edit') : t('m.cover.add')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
