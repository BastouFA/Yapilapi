import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Platform, Pressable, RefreshControl, Share, StyleSheet, Text, View } from 'react-native';
import type { Post, Profile } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl, webUrl } from './api';
import { useT } from './i18n';
import { pickOne, uploadPicked } from './media';
import { liveStatus, NowStatusLine, onStatusChanged } from './now-status';
import { PostCard, RichText } from './post';
import { radius, space } from './theme';
import { Avatar, Button, Card, EmptyState, Icon, Notice, PlusBadge, Segmented, Skeleton, SkeletonList, useColors, userText } from './ui';
import { ShopList, SupportCard } from './money';
import { isVerificationError, VerifyPrompt } from './safety';
import { ChaptersRow } from './chapters';
import { ProfileBoards } from './boards';
import { ProfileMenu } from './profile-menu';

/**
 * A profile: name, bio, counts, Follow and Message for other people, and
 * their posts (pinned post first). `actions` adds your own buttons on your
 * profile.
 */
export function ProfileView({ username, actions, bottom = 0 }: { username: string; actions?: ReactNode; bottom?: number }) {
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
  const [needsVerify, setNeedsVerify] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<'posts' | 'tagged' | 'boards' | 'shop'>('posts');
  // Photos this person is tagged in, loaded the first time the tab opens.
  const [tagged, setTagged] = useState<{ items: Post[]; cursor: string | null; hidden: boolean } | null>(null);
  // A new cover photo on its way: the phone's copy shows while it uploads and is prepared.
  const [coverUpload, setCoverUpload] = useState<{ local: string; progress: number | null } | null>(null);

  // Your status, set or cleared in the status sheet, shows here as soon as you come back.
  useEffect(() => onStatusChanged((nowStatus) => setProfile((p) => (p && p.relationship.isSelf ? { ...p, nowStatus } : p))), []);

  const load = useCallback(async () => {
    const api = await client();
    try {
      const p = (await api.users.get(username)).profile;
      setProfile(p);
      try {
        const page = await api.users.posts(username);
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
  }, [username]);

  useEffect(() => {
    void load();
    setTagged(null);
  }, [load]);

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

  useEffect(() => {
    if (tab === 'tagged' && !tagged) void loadTagged();
  }, [tab, tagged, loadTagged]);

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
        <EmptyState title={t('m.post.unavailable.title')} />
      </View>
    );

  const rel = profile.relationship;
  const status = liveStatus(profile.nowStatus);

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

  async function changeCover() {
    setError(null);
    const asset = await pickOne(['images']).catch((e: unknown) => {
      setError(errorMessage(e));
      return null;
    });
    if (asset === 'denied') return setError(t('m.create.photosPermission'));
    if (!asset) return;
    setCoverUpload({ local: asset.uri, progress: 0 });
    try {
      const m = await uploadPicked(asset, (progress) => setCoverUpload({ local: asset.uri, progress }));
      // Uploaded: the server now prepares the sizes, and the cover is set once they're ready.
      setCoverUpload({ local: asset.uri, progress: null });
      const r = await (await client()).me.setCoverWhenReady(m.id);
      setProfile((p) => (p ? { ...p, coverUrl: r.profile.coverUrl, coverAlt: r.profile.coverAlt } : p));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCoverUpload(null);
    }
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
            setProfile((p) => (p ? { ...p, coverUrl: r.profile.coverUrl, coverAlt: r.profile.coverAlt } : p));
          } catch (e) {
            setError(errorMessage(e));
          }
        },
      },
    ]);
  }

  function editCover() {
    if (!profile?.coverUrl) return void changeCover();
    Alert.alert(t('m.cover.edit'), undefined, [
      { text: t('m.cover.choose'), onPress: () => void changeCover() },
      { text: t('m.cover.remove'), style: 'destructive', onPress: removeCover },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  }

  const header = (
    <View style={{ gap: space[3], marginBottom: space[3] }}>
      <Cover profile={profile} upload={coverUpload} onEdit={rel.isSelf ? editCover : undefined} />
      <Card style={{ alignItems: 'center', gap: space[2], paddingVertical: space[6], marginTop: -56 }}>
        <Avatar name={profile.displayName} url={profile.avatarUrl} size={84} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <Text style={[{ color: c.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }, userText]}>{profile.displayName}</Text>
          {profile.plus ? <PlusBadge /> : null}
        </View>
        <Text style={[{ color: c.inkMuted }, userText]}>
          @{profile.username}
          {rel.followedBy && !rel.isSelf ? ` · ${t('m.profile.followsYou')}` : ''}
        </Text>
        {status ? <NowStatusLine status={status} center /> : null}
        {profile.bio ? <RichText text={profile.bio} style={{ color: c.ink, fontSize: 15, lineHeight: 22, textAlign: 'center' }} /> : null}
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
            <Button label={t('m.profile.share')} variant="secondary" size="sm" icon="share-outline" onPress={() => void shareProfile()} />
          </View>
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space[2], marginTop: space[2] }}>
            <Button
              label={rel.following ? t('profile.unfollow') : t('profile.follow')}
              variant={rel.following ? 'secondary' : 'primary'}
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
      <ChaptersRow userId={profile.id} isSelf={rel.isSelf} />
      <Segmented
        label={t('m.title.profile')}
        value={tab}
        onChange={setTab}
        options={[
          { id: 'posts', label: t('profile.posts') },
          { id: 'tagged', label: t('m.tagged.tab') },
          { id: 'boards', label: t('m.boards.title') },
          { id: 'shop', label: t('m.shop.tab') },
        ]}
      />
      {needsVerify ? <VerifyPrompt action="message" /> : null}
    </View>
  );

  return (
    <FlatList
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: bottom + space[4] }}
      data={tab === 'posts' ? posts : tab === 'tagged' ? (tagged?.items ?? []) : []}
      keyExtractor={(p) => p.id}
      ListHeaderComponent={header}
      renderItem={({ item }) => <PostCard post={item} />}
      onEndReached={() => void (tab === 'posts' ? more() : tab === 'tagged' && tagged?.cursor ? loadTagged(tagged.cursor) : undefined)}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            if (tab === 'tagged') await loadTagged();
            setRefreshing(false);
          }}
        />
      }
      ListEmptyComponent={
        tab === 'shop' ? (
          <ShopList userId={profile.id} username={profile.username} isSelf={rel.isSelf} />
        ) : tab === 'boards' ? (
          <ProfileBoards username={profile.username} isSelf={rel.isSelf} />
        ) : tab === 'tagged' ? (
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
function Cover({ profile, upload, onEdit }: { profile: Profile; upload: { local: string; progress: number | null } | null; onEdit?: () => void }) {
  const c = useColors();
  const { t, number } = useT();
  const uri = upload?.local ?? (profile.coverUrl ? mediaUrl(profile.coverUrl) : null);
  return (
    <View style={{ height: uri ? 176 : 104, marginHorizontal: -space[4], marginTop: -space[4], backgroundColor: c.surfaceSunken, overflow: 'hidden' }}>
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
      ) : onEdit ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={profile.coverUrl ? t('m.cover.edit') : t('m.cover.add')}
          onPress={onEdit}
          hitSlop={6}
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
