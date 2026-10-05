import { router, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import type { FaqEntry } from '../../../../packages/api-client/src/index';
import { ROOM_TITLE_MAX } from '../../../../packages/shared/src/constants';
import type { Community, EventItem, Post, PublicUser, RoomSummary } from '../../../../packages/shared/src/types';
import { client, errorMessage, isGone } from '../../lib/api';
import { DateField } from '../../lib/date-time';
import { canManage, canOrganize, roleName } from '../../lib/community-roles';
import { useT } from '../../lib/i18n';
import { useReport } from '../../lib/report';
import { PostCard } from '../../lib/post';
import { CommunityCatchUp } from '../../lib/ai-helpers';
import { roomDuration, roomStatusLabel } from '../../lib/rooms';
import { useSession } from '../../lib/session';
import { space } from '../../lib/theme';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ScreenError,
  feedListProps,
  Field,
  Icon,
  KeyboardAvoid,
  Loading,
  Notice,
  Row,
  Segmented,
  Title,
  useActionSheet,
  useColors,
  useRefresh,
  userText,
} from '../../lib/ui';

type Tab = 'posts' | 'faq' | 'rooms' | 'events' | 'members';
type Item = { key: string; post?: Post; faq?: FaqEntry; room?: RoomSummary; event?: EventItem; member?: { user: PublicUser; role: string } };

const LOCKED = {
  posts: 'm.community.locked.posts',
  faq: 'm.community.locked.faq',
  rooms: 'm.rooms.locked',
  events: 'm.community.locked.events',
  members: 'm.community.locked.members',
} as const;

/** A community: posts, its FAQ, audio rooms, events and members, with join and leave, and its group chat for members. */
export default function CommunityScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const c = useColors();
  const { t, tp, dateTime } = useT();
  const navigation = useNavigation();
  const { me } = useSession();
  const [community, setCommunity] = useState<(Community & { membershipStatus: string | null }) | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('posts');
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [faq, setFaq] = useState<{ items: FaqEntry[]; canEdit: boolean } | null>(null);
  const [members, setMembers] = useState<{ user: PublicUser; role: string }[] | null>(null);
  const [rooms, setRooms] = useState<{ items: RoomSummary[]; canStart: boolean } | null>(null);
  const [events, setEvents] = useState<EventItem[] | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Why it couldn't load, when that isn't because it's gone; a community already showing stays.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await (await client()).communities.get(slug);
      setCommunity(r.community);
      setChatId(r.chatConversationId);
      setLoadError(null);
    } catch (e) {
      if (isGone(e)) setCommunity(null);
      else setLoadError(errorMessage(e));
    }
  }, [slug]);
  // Again on coming back, so changes from the settings screen (name, description) show.
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  // More in the header: report the community (not your own).
  const menu = useActionSheet();
  const report = useReport();
  const { show: showMenu } = menu;
  const { open: openReport } = report;
  const canReport = !!me && !!community && community.myRole !== 'owner';
  useLayoutEffect(() => {
    if (!community) return;
    navigation.setOptions({
      title: community.name,
      headerRight: canReport
        ? () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.post.more')}
              hitSlop={10}
              onPress={() =>
                showMenu({
                  title: community.name,
                  actions: [
                    { label: t('post.report'), icon: 'flag-outline', destructive: true, onPress: () => openReport({ type: 'community', id: community.id }) },
                  ],
                })
              }
            >
              <Icon name="ellipsis-horizontal-circle-outline" size={24} color={c.yapi} />
            </Pressable>
          )
        : undefined,
    });
  }, [navigation, community, canReport, showMenu, openReport, t, c.yapi]);

  const locked = !!community && community.visibility === 'private' && !community.myRole;

  const loadFaq = useCallback(async () => {
    try {
      setFaq(await (await client()).communities.faq(slug));
    } catch (e) {
      setFaq({ items: [], canEdit: false });
      setError(errorMessage(e));
    }
  }, [slug]);

  useEffect(() => {
    if (!community || locked) return;
    void (async () => {
      const api = await client();
      try {
        if (tab === 'posts' && !posts) {
          const page = await api.communities.posts(slug);
          setPosts(page.items);
          setCursor(page.nextCursor);
        }
        if (tab === 'faq' && !faq) await loadFaq();
        if (tab === 'members' && !members) setMembers((await api.communities.members(slug)).items);
        if (tab === 'rooms' && !rooms) setRooms(await api.communities.rooms(slug));
        if (tab === 'events' && !events)
          setEvents((await api.raw.get<{ items: EventItem[] }>(`/v1/events?communityId=${encodeURIComponent(community.id)}`)).items);
      } catch (e) {
        setError(errorMessage(e));
        if (tab === 'posts') setPosts([]);
        if (tab === 'members') setMembers([]);
        if (tab === 'rooms') setRooms({ items: [], canStart: false });
        if (tab === 'events') setEvents([]);
      }
    })();
  }, [tab, community, locked, slug, posts, faq, members, rooms, events, loadFaq]);

  // Pull to refresh or Try again: the community again, and the section on screen from the start
  // (the effect above loads whichever section is empty).
  const refreshAll = useCallback(async () => {
    setError(null);
    await reload();
    setPosts(null);
    setCursor(null);
    setFaq(null);
    setMembers(null);
    setRooms(null);
    setEvents(null);
  }, [reload]);
  const refresh = useRefresh(refreshAll);

  if (community === undefined) return loadError ? <ScreenError message={loadError} onRetry={reload} /> : <Loading />;
  if (community === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState
          title={t('m.community.notFound.title')}
          body={t('m.community.notFound.body')}
          action={{ label: t('m.common.retry'), icon: 'refresh', onPress: () => void reload() }}
        />
      </View>
    );

  const items: Item[] =
    tab === 'posts'
      ? (posts ?? []).map((p) => ({ key: p.id, post: p }))
      : tab === 'faq'
        ? (faq?.items ?? []).map((f) => ({ key: f.id, faq: f }))
        : tab === 'rooms'
          ? (rooms?.items ?? []).map((r) => ({ key: r.id, room: r }))
          : tab === 'events'
            ? (events ?? []).map((e) => ({ key: e.id, event: e }))
            : (members ?? []).map((m) => ({ key: m.user.id, member: m }));
  const loadingTab =
    !locked &&
    ((tab === 'posts' && !posts) || (tab === 'faq' && !faq) || (tab === 'rooms' && !rooms) || (tab === 'events' && !events) || (tab === 'members' && !members));

  const header = (
    <View style={{ gap: space[3], marginBottom: space[1] }}>
      <Card style={{ gap: space[2] }}>
        <Title
          sub={`${tp('m.community.members', community.memberCount)} · ${community.visibility === 'private' ? t('m.community.private') : t('m.community.public')}`}
        >
          {community.name}
        </Title>
        {community.description ? <Text style={[{ color: c.ink, lineHeight: 21 }, userText]}>{community.description}</Text> : null}
        {(community.myRole && chatId) || canOrganize(community.myRole) ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {community.myRole && chatId ? (
              <Button label={t('m.community.chat')} icon="chatbubbles-outline" size="sm" variant="secondary" onPress={() => router.push(`/chat/${chatId}`)} />
            ) : null}
            {canOrganize(community.myRole) ? (
              <Button
                label={t('events.create')}
                icon="calendar-outline"
                size="sm"
                variant="secondary"
                onPress={() => router.push(`/event-edit?community=${encodeURIComponent(community.id)}`)}
              />
            ) : null}
            {canManage(community.myRole) ? (
              <Button
                label={t('m.manage.open')}
                icon="settings-outline"
                size="sm"
                variant="secondary"
                onPress={() => router.push(`/community-settings?slug=${encodeURIComponent(community.slug)}`)}
              />
            ) : null}
          </View>
        ) : null}
        {me ? (
          community.myRole ? (
            community.myRole !== 'owner' ? (
              <Button
                label={t('communities.leave')}
                variant="secondary"
                size="sm"
                style={{ alignSelf: 'flex-start' }}
                onPress={async () => {
                  await (await client()).communities.leave(slug).catch((e) => setError(errorMessage(e)));
                  await reload();
                }}
              />
            ) : null
          ) : community.membershipStatus === 'pending' ? (
            <View style={{ gap: space[2] }}>
              <Text style={{ color: c.inkMuted }}>{t('m.community.pending')}</Text>
              <Button
                label={t('m.community.withdraw')}
                variant="secondary"
                size="sm"
                style={{ alignSelf: 'flex-start' }}
                onPress={async () => {
                  setError(null);
                  try {
                    await (await client()).communities.leave(slug);
                    setNote(t('profile.requestWithdrawn'));
                  } catch (e) {
                    setError(errorMessage(e));
                  }
                  await reload();
                }}
              />
            </View>
          ) : (
            <Button
              label={community.visibility === 'private' ? t('m.community.requestJoin') : t('communities.join')}
              size="sm"
              style={{ alignSelf: 'flex-start' }}
              onPress={async () => {
                try {
                  const r = await (await client()).communities.join(slug);
                  setNote(r.status === 'pending' ? t('m.community.requestSent') : t('m.community.welcome', { name: community.name }));
                  setPosts(null);
                  setFaq(null);
                  setMembers(null);
                  setRooms(null);
                  setEvents(null);
                  await reload();
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
          )
        ) : null}
        {me && (community.visibility !== 'private' || community.myRole) ? <CommunityCatchUp communityId={community.id} /> : null}
      </Card>
      <Segmented
        label={t('m.community.sections')}
        options={[
          { id: 'posts', label: t('profile.posts') },
          { id: 'faq', label: t('m.community.faq') },
          { id: 'rooms', label: t('m.rooms.tab') },
          { id: 'events', label: t('events.title') },
          { id: 'members', label: t('m.community.membersTab') },
        ]}
        value={tab}
        onChange={setTab}
      />
      {note ? <Notice>{note}</Notice> : null}
      {error ? <ErrorState message={error} onRetry={refreshAll} /> : null}
      {locked ? <Notice>{t(LOCKED[tab])}</Notice> : null}
      {tab === 'posts' && community.myRole && !locked ? (
        <CommunityComposer slug={slug} communityId={community.id} name={community.name} onPosted={(p) => setPosts((cur) => [p, ...(cur ?? [])])} />
      ) : null}
    </View>
  );

  return (
    <KeyboardAvoid>
      <FlatList
        keyboardShouldPersistTaps="handled"
        // Scrolling tucks the keyboard away, so the whole conversation is readable again.
        keyboardDismissMode="on-drag"
        {...feedListProps}
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[8] }}
        data={locked ? [] : items}
        keyExtractor={(x) => x.key}
        refreshControl={refresh}
        ListHeaderComponent={header}
        ListEmptyComponent={
          locked ? null : loadingTab ? (
            <Loading />
          ) : tab === 'posts' ? (
            <EmptyState title={t('m.community.noPosts.title')} body={community?.myRole ? t('m.community.noPosts.member') : t('m.community.noPosts.body')} />
          ) : tab === 'faq' ? (
            <EmptyState title={t('m.community.noFaq.title')} body={faq?.canEdit ? t('m.community.noFaq.editor') : t('m.community.noFaq.body')} />
          ) : tab === 'rooms' ? (
            <EmptyState title={t('m.rooms.none')} body={t('m.rooms.noneBody')} />
          ) : tab === 'events' ? (
            <EmptyState title={t('m.events.none')} body={t('m.community.noEvents')} />
          ) : (
            <EmptyState title={t('m.community.noMembers')} />
          )
        }
        ListFooterComponent={
          tab === 'faq' && faq?.canEdit && !locked ? (
            <AddFaq slug={slug} onAdded={loadFaq} />
          ) : tab === 'rooms' && rooms?.canStart && !locked ? (
            <StartRoom
              slug={slug}
              onScheduled={() =>
                void client()
                  .then((api) => api.communities.rooms(slug))
                  .then(setRooms, () => {})
              }
            />
          ) : null
        }
        onEndReached={async () => {
          if (tab !== 'posts' || !cursor) return;
          const page = await (await client()).communities.posts(slug, cursor).catch(() => null);
          if (page) {
            setPosts((cur) => [...(cur ?? []), ...page.items]);
            setCursor(page.nextCursor);
          }
        }}
        renderItem={({ item }) =>
          item.post ? (
            <PostCard post={item.post} />
          ) : item.faq ? (
            <FaqItem
              entry={item.faq}
              canEdit={!!faq?.canEdit}
              onRemove={async () => {
                try {
                  await (await client()).communities.deleteFaq(slug, item.faq!.id);
                  await loadFaq();
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
          ) : item.room ? (
            <RoomCard room={item.room} />
          ) : item.event ? (
            <Row
              title={item.event.title}
              subtitle={[dateTime(item.event.startsAt), item.event.online ? t('m.event.online') : (item.event.place?.name ?? item.event.locationText)]
                .filter(Boolean)
                .join(' · ')}
              start={<Icon name="calendar-outline" size={22} color={c.yapi} />}
              onPress={() => router.push(`/event/${item.event!.id}`)}
            />
          ) : item.member ? (
            <Row
              title={item.member.user.displayName}
              subtitle={`@${item.member.user.username}${item.member.role !== 'member' ? ` · ${roleName(item.member.role, t)}` : ''}`}
              start={<Avatar name={item.member.user.displayName} url={item.member.user.avatarUrl} size={36} />}
              onPress={() => router.push(`/u/${encodeURIComponent(item.member!.user.username)}`)}
            />
          ) : null
        }
      />
      {menu.sheet}
      {report.sheet}
    </KeyboardAvoid>
  );
}

function FaqItem({ entry, canEdit, onRemove }: { entry: FaqEntry; canEdit: boolean; onRemove: () => void }) {
  const c = useColors();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <Card style={{ padding: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], padding: space[4] }}
      >
        <Text style={[{ flex: 1, color: c.ink, fontWeight: '700', fontSize: 15 }, userText]}>{entry.question}</Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} color={c.inkMuted} />
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: space[4], paddingBottom: space[4], gap: space[2] }}>
          <Text style={[{ color: c.ink, lineHeight: 21 }, userText]}>{entry.answer}</Text>
          {canEdit ? <Button label={t('m.common.remove')} variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }} onPress={onRemove} /> : null}
        </View>
      ) : null}
    </Card>
  );
}

function AddFaq({ slug, onAdded }: { slug: string; onAdded: () => Promise<void> }) {
  const { t } = useT();
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card style={{ gap: space[3], marginTop: space[3] }}>
      <Title>{t('m.faq.add.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Field label={t('m.faq.question')} value={q} onChangeText={setQ} maxLength={300} />
      <Field
        label={t('m.faq.answer')}
        value={a}
        onChangeText={setA}
        multiline
        maxLength={4000}
        style={{ minHeight: 100, textAlignVertical: 'top', paddingTop: 12 }}
      />
      <Button
        label={saving ? t('m.faq.adding') : t('m.faq.add')}
        disabled={!q.trim() || !a.trim() || saving}
        onPress={async () => {
          setSaving(true);
          setError(null);
          try {
            await (await client()).communities.addFaq(slug, { question: q.trim(), answer: a.trim() });
            setQ('');
            setA('');
            await onAdded();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setSaving(false);
          }
        }}
      />
    </Card>
  );
}

function RoomCard({ room }: { room: RoomSummary }) {
  const c = useColors();
  const { t, tp, dateTime } = useT();
  const meta =
    room.status === 'live'
      ? tp('m.rooms.listening', room.listenerCount)
      : room.status === 'scheduled'
        ? room.scheduledFor
          ? dateTime(room.scheduledFor)
          : ''
        : room.status === 'ended'
          ? t('m.rooms.endedLine', { duration: roomDuration(room.durationSeconds, t), count: room.peakListeners })
          : '';
  return (
    <Card label={room.title} onPress={() => router.push(`/room/${room.id}`)} style={{ gap: space[1] }}>
      <Text style={{ color: room.status === 'live' ? c.danger : c.inkMuted, fontWeight: '700', fontSize: 12 }}>{roomStatusLabel(room, t)}</Text>
      <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 16 }, userText]}>{room.title}</Text>
      {meta ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{meta}</Text> : null}
    </Card>
  );
}

/** The API takes a scheduled start in the future and within 60 days (apps/api/src/modules/rooms.ts). */
const ROOM_SCHEDULE_MIN_MS = 5 * 60_000;
const ROOM_SCHEDULE_MAX_MS = 60 * 86_400_000;

/** Moderators and owners start a room now, or schedule it for later (members can ask to be reminded). */
function StartRoom({ slug, onScheduled }: { slug: string; onScheduled: () => void }) {
  const { t, dateTime } = useT();
  const c = useColors();
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const later = when === 'later';
  return (
    <Card style={{ gap: space[3], marginTop: space[3] }}>
      <Title>{t('m.rooms.new')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {done ? <Notice>{done}</Notice> : null}
      <Field label={t('m.rooms.titleLabel')} value={title} onChangeText={setTitle} maxLength={ROOM_TITLE_MAX} />
      <Segmented
        label={t('m.rooms.when')}
        options={[
          { id: 'now', label: t('m.rooms.startNow') },
          { id: 'later', label: t('m.rooms.later') },
        ]}
        value={when}
        onChange={(v) => {
          setWhen(v);
          setDone(null);
        }}
      />
      {later ? (
        <DateField
          label={t('m.rooms.startsAt')}
          sheetTitle={t('m.rooms.whenTitle')}
          value={at}
          onChange={setAt}
          min={new Date(Date.now() + ROOM_SCHEDULE_MIN_MS)}
          max={new Date(Date.now() + ROOM_SCHEDULE_MAX_MS)}
          quick
          hint={t('m.rooms.laterHint')}
        />
      ) : null}
      <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.rooms.startNote')}</Text>
      <Button
        label={later ? t('m.rooms.scheduleRoom') : t('m.rooms.start')}
        icon={later ? 'calendar-outline' : 'mic'}
        disabled={!title.trim() || saving || (later && !at)}
        onPress={async () => {
          setSaving(true);
          setError(null);
          setDone(null);
          try {
            const api = await client();
            if (later && at) {
              await api.communities.startRoom(slug, { title: title.trim(), scheduledFor: at.toISOString() });
              setTitle('');
              setAt(null);
              setDone(t('m.rooms.scheduledFor', { time: dateTime(at) }));
              onScheduled();
              return;
            }
            const { room } = await api.communities.startRoom(slug, { title: title.trim() });
            setTitle('');
            router.push(`/room/${room.id}`);
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setSaving(false);
          }
        }}
      />
    </Card>
  );
}

/**
 * Write to the community from the phone. While you type a question, answers already in the FAQ or
 * earlier posts that look similar show up, so people find them before asking again.
 */
function CommunityComposer({ slug, communityId, name, onPosted }: { slug: string; communityId: string; name: string; onPosted: (p: Post) => void }) {
  const c = useColors();
  const { t } = useT();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [similar, setSimilar] = useState<{ faq: FaqEntry[]; posts: Post[] }>({ faq: [], posts: [] });

  useEffect(() => {
    const q = body.trim();
    if (q.length < 12) return setSimilar({ faq: [], posts: [] });
    const timer = setTimeout(() => {
      void client()
        .then((api) => api.communities.similar(slug, q))
        .then(
          (r) => setSimilar({ faq: r.faq.slice(0, 2), posts: r.posts.slice(0, 2).map((x) => x.post) }),
          () => {},
        );
    }, 450);
    return () => clearTimeout(timer);
  }, [body, slug]);

  async function post() {
    setBusy(true);
    setError(null);
    try {
      const r = await (await client()).posts.create({ body: body.trim(), communityId, visibility: 'public' });
      onPosted(r.post);
      setBody('');
      setSimilar({ faq: [], posts: [] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const hasSimilar = similar.faq.length > 0 || similar.posts.length > 0;
  return (
    <Card style={{ gap: space[2] }}>
      <Field
        label={t('m.community.composeLabel')}
        hideLabel
        placeholder={t('m.community.composePlaceholder', { name })}
        value={body}
        onChangeText={setBody}
        multiline
        maxLength={2000}
        style={{ minHeight: 72, paddingTop: space[2] }}
      />
      {hasSimilar ? (
        <View accessibilityLiveRegion="polite" style={{ gap: space[1] }}>
          <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '700' }}>{t('m.community.similarTitle')}</Text>
          {similar.faq.map((f) => (
            <View key={f.id} style={{ gap: 2 }}>
              <Text style={[{ color: c.ink, fontWeight: '600' }, userText]}>{f.question}</Text>
              <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={3}>
                {f.answer}
              </Text>
            </View>
          ))}
          {/* Links 4pt apart: each is 44pt tall itself, as slop would overlap the next one. */}
          {similar.posts.map((p) => (
            <Pressable key={p.id} accessibilityRole="link" onPress={() => router.push(`/p/${p.id}`)} style={{ minHeight: 44, justifyContent: 'center' }}>
              <Text style={[{ color: c.yapi, fontWeight: '600' }, userText]} numberOfLines={2}>
                {p.body}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button label={t('create.publish')} size="sm" style={{ alignSelf: 'flex-end' }} disabled={!body.trim() || busy} onPress={() => post()} />
    </Card>
  );
}
