import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import type { FaqEntry } from '../../../../packages/api-client/src/index';
import type { Community, Post, PublicUser } from '../../../../packages/shared/src/types';
import { client, errorMessage } from '../../lib/api';
import { PostCard } from '../../lib/post';
import { useSession } from '../../lib/session';
import { space } from '../../lib/theme';
import { Avatar, Button, Card, EmptyState, Field, Icon, Loading, Notice, Row, Segmented, Title, useColors } from '../../lib/ui';

type Tab = 'posts' | 'faq' | 'members';
type Item = { key: string; post?: Post; faq?: FaqEntry; member?: { user: PublicUser; role: string } };

/** A community: posts, its FAQ and members, with join and leave. */
export default function CommunityScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const c = useColors();
  const navigation = useNavigation();
  const { me } = useSession();
  const [community, setCommunity] = useState<(Community & { membershipStatus: string | null }) | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('posts');
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [faq, setFaq] = useState<{ items: FaqEntry[]; canEdit: boolean } | null>(null);
  const [members, setMembers] = useState<{ user: PublicUser; role: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setCommunity((await (await client()).communities.get(slug)).community);
    } catch {
      setCommunity(null);
    }
  }, [slug]);
  useEffect(() => {
    void reload();
  }, [reload]);

  useLayoutEffect(() => {
    if (community) navigation.setOptions({ title: community.name });
  }, [navigation, community]);

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
      } catch (e) {
        setError(errorMessage(e));
        if (tab === 'posts') setPosts([]);
        if (tab === 'members') setMembers([]);
      }
    })();
  }, [tab, community, locked, slug, posts, faq, members, loadFaq]);

  if (community === undefined) return <Loading />;
  if (community === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title="Community not found" body="It may have been removed or renamed." />
      </View>
    );

  const items: Item[] =
    tab === 'posts'
      ? (posts ?? []).map((p) => ({ key: p.id, post: p }))
      : tab === 'faq'
        ? (faq?.items ?? []).map((f) => ({ key: f.id, faq: f }))
        : (members ?? []).map((m) => ({ key: m.user.id, member: m }));
  const loadingTab = !locked && ((tab === 'posts' && !posts) || (tab === 'faq' && !faq) || (tab === 'members' && !members));

  const header = (
    <View style={{ gap: space[3], marginBottom: space[1] }}>
      <Card style={{ gap: space[2] }}>
        <Title
          sub={`${community.memberCount} ${community.memberCount === 1 ? 'member' : 'members'} · ${community.visibility === 'private' ? 'Private' : 'Public'}`}
        >
          {community.name}
        </Title>
        {community.description ? <Text style={{ color: c.ink, lineHeight: 21 }}>{community.description}</Text> : null}
        {me ? (
          community.myRole ? (
            community.myRole !== 'owner' ? (
              <Button
                label="Leave"
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
            <Text style={{ color: c.inkMuted }}>Your request to join is waiting for the moderators.</Text>
          ) : (
            <Button
              label={community.visibility === 'private' ? 'Request to join' : 'Join'}
              size="sm"
              style={{ alignSelf: 'flex-start' }}
              onPress={async () => {
                try {
                  const r = await (await client()).communities.join(slug);
                  setNote(r.status === 'pending' ? 'Request sent to the moderators.' : `Welcome to ${community.name}.`);
                  setPosts(null);
                  setFaq(null);
                  setMembers(null);
                  await reload();
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
          )
        ) : null}
      </Card>
      <Segmented
        label="Community sections"
        options={[
          { id: 'posts', label: 'Posts' },
          { id: 'faq', label: 'FAQ' },
          { id: 'members', label: 'Members', count: community.memberCount },
        ]}
        value={tab}
        onChange={setTab}
      />
      {note ? <Notice>{note}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {locked ? <Notice>{`Join this private community to see its ${tab === 'faq' ? 'FAQ' : tab}.`}</Notice> : null}
    </View>
  );

  return (
    <FlatList
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[8] }}
      data={locked ? [] : items}
      keyExtractor={(x) => x.key}
      ListHeaderComponent={header}
      ListEmptyComponent={
        locked ? null : loadingTab ? (
          <Loading />
        ) : tab === 'posts' ? (
          <EmptyState title="No posts yet" body="Start the first discussion from the web app." />
        ) : tab === 'faq' ? (
          <EmptyState title="No FAQ yet" body={faq?.canEdit ? 'Add the questions members ask most.' : 'Moderators can add answers to common questions here.'} />
        ) : (
          <EmptyState title="No members to show" />
        )
      }
      ListFooterComponent={tab === 'faq' && faq?.canEdit && !locked ? <AddFaq slug={slug} onAdded={loadFaq} /> : null}
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
        ) : item.member ? (
          <Row
            title={item.member.user.displayName}
            subtitle={`@${item.member.user.username}${item.member.role !== 'member' ? ` · ${item.member.role}` : ''}`}
            start={<Avatar name={item.member.user.displayName} url={item.member.user.avatarUrl} size={36} />}
          />
        ) : null
      }
    />
  );
}

function FaqItem({ entry, canEdit, onRemove }: { entry: FaqEntry; canEdit: boolean; onRemove: () => void }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <Card style={{ padding: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], padding: space[4] }}
      >
        <Text style={{ flex: 1, color: c.ink, fontWeight: '700', fontSize: 15 }}>{entry.question}</Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} color={c.inkMuted} />
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: space[4], paddingBottom: space[4], gap: space[2] }}>
          <Text style={{ color: c.ink, lineHeight: 21 }}>{entry.answer}</Text>
          {canEdit ? <Button label="Remove" variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }} onPress={onRemove} /> : null}
        </View>
      ) : null}
    </Card>
  );
}

function AddFaq({ slug, onAdded }: { slug: string; onAdded: () => Promise<void> }) {
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card style={{ gap: space[3], marginTop: space[3] }}>
      <Title>Add a question</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Field label="Question" value={q} onChangeText={setQ} maxLength={300} />
      <Field label="Answer" value={a} onChangeText={setA} multiline maxLength={4000} style={{ minHeight: 100, textAlignVertical: 'top', paddingTop: 12 }} />
      <Button
        label={saving ? 'Adding…' : 'Add to FAQ'}
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
