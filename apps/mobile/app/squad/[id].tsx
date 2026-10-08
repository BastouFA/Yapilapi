import { router, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useLayoutEffect, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { SQUAD_RULES, type SquadColor } from '../../../../packages/shared/src/constants';
import type { Squad, SquadMember } from '../../../../packages/shared/src/squads';
import type { Post } from '../../../../packages/shared/src/types';
import { client, errorMessage, isGone } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { PostCard } from '../../lib/post';
import { useSession } from '../../lib/session';
import { ColorChoice, MAX_SQUAD_MEMBERS, MemoryCard, PeoplePick, PhotoChoice, SquadCoverView } from '../../lib/squads';
import { space } from '../../lib/theme';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Field,
  KeyboardAvoid,
  Loading,
  Notice,
  ScreenError,
  useActionSheet,
  useColors,
  userText,
  type ActionSheetAction,
} from '../../lib/ui';

/**
 * One squad: share to it, add to its story, open its chat, this week's memory, what was shared, and
 * who is in it (the owner and admins remove people; the owner chooses admins and hands it on).
 */
export default function SquadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, tp } = useT();
  const { me } = useSession();
  const navigation = useNavigation();
  const sheet = useActionSheet();
  const [squad, setSquad] = useState<Squad | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviting, setInviting] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<{ name: string; color: SquadColor; photo: { id: string; url: string } | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const api = await client();
      const r = await api.squads.get(id);
      setSquad(r.squad);
      setLoadError(null);
      if (r.squad.viewer.role) {
        const p = await api.squads.posts(id);
        setPosts(p.items);
        setCursor(p.nextCursor);
      }
    } catch (e) {
      if (!isGone(e)) return setLoadError(errorMessage(e));
      setSquad(null);
      setError(errorMessage(e));
    }
  }, [id]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useLayoutEffect(() => {
    navigation.setOptions({ title: squad?.name ?? t('squads.title') });
  }, [navigation, squad?.name, t]);

  if (squad === undefined) return loadError ? <ScreenError message={loadError} onRetry={load} /> : <Loading />;
  if (squad === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4], gap: space[3] }}>
        <EmptyState title={t('m.post.unavailable.title')} />
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </View>
    );

  async function run(key: string, work: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const s = squad;
  const role = s.viewer.role;
  const set = (r: { squad?: Squad }) => r.squad && setSquad(r.squad);

  if (s.viewer.invited)
    return (
      <ScrollView style={{ backgroundColor: c.ground }} contentContainerStyle={{ padding: space[4], gap: space[4] }}>
        <SquadCoverView name={s.name} cover={s.cover} size={96} />
        <Text accessibilityRole="header" style={[{ color: c.ink, fontWeight: '800', fontSize: 24 }, userText]}>
          {s.name}
        </Text>
        {s.viewer.invitedBy ? <Text style={[{ color: c.inkMuted }, userText]}>{t('squads.invitedBy', { name: s.viewer.invitedBy.displayName })}</Text> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <View style={{ flexDirection: 'row', gap: space[2] }}>
          <Button
            label={t('squads.join')}
            disabled={!!busy}
            onPress={() =>
              run('join', async () => {
                set(await (await client()).squads.accept(s.id));
                await load();
              })
            }
          />
          <Button
            label={t('m.common.decline')}
            variant="secondary"
            disabled={!!busy}
            onPress={() =>
              run('decline', async () => {
                await (await client()).squads.decline(s.id);
                router.back();
              })
            }
          />
        </View>
      </ScrollView>
    );

  const more = () =>
    run('more', async () => {
      if (!cursor) return;
      const p = await (await client()).squads.posts(s.id, cursor);
      setPosts((cur) => [...cur, ...p.items]);
      setCursor(p.nextCursor);
    });

  const memberMenu = (m: SquadMember) => {
    const actions: ActionSheetAction[] = [];
    if (role === 'owner' && !m.invited && m.role !== 'owner') {
      actions.push({
        label: m.role === 'admin' ? t('chat.group.dropAdmin') : t('chat.group.makeAdmin'),
        icon: 'shield-outline',
        onPress: () => void run('role', async () => set(await (await client()).squads.setRole(s.id, m.user.id, m.role === 'admin' ? 'member' : 'admin'))),
      });
      actions.push({
        label: t('squads.makeOwner'),
        icon: 'key-outline',
        onPress: () =>
          Alert.alert(t('squads.makeOwner'), t('squads.makeOwnerConfirm', { name: m.user.displayName }), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('squads.makeOwner'), onPress: () => void run('owner', async () => set(await (await client()).squads.makeOwner(s.id, m.user.id))) },
          ]),
      });
    }
    if (m.user.id !== me?.id && m.role !== 'owner' && (role === 'owner' || (role === 'admin' && m.role !== 'admin')))
      actions.push({
        label: t('m.group.removePerson', { name: m.user.displayName }),
        icon: 'person-remove-outline',
        destructive: true,
        onPress: () => void run('remove', async () => set(await (await client()).squads.removeMember(s.id, m.user.id))),
      });
    actions.push({
      label: t('acct.viewProfile'),
      icon: 'person-outline',
      onPress: () => router.push({ pathname: '/u/[username]', params: { username: m.user.username } }),
    });
    sheet.show({ title: m.user.displayName, actions });
  };

  const leave = () =>
    Alert.alert(t('squads.leave'), t('squads.leaveConfirm', { name: s.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('squads.leave'),
        style: 'destructive',
        onPress: () =>
          void run('leave', async () => {
            await (await client()).squads.leave(s.id);
            router.back();
          }),
      },
    ]);
  const destroy = () =>
    Alert.alert(t('squads.delete'), t('squads.deleteConfirm', { name: s.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('m.common.delete'),
        style: 'destructive',
        onPress: () =>
          void run('delete', async () => {
            await (await client()).squads.remove(s.id);
            router.back();
          }),
      },
    ]);

  const full = s.memberCount >= MAX_SQUAD_MEMBERS;
  const roleLabel = (m: SquadMember) =>
    m.invited ? t('m.rooms.invitedLabel') : m.role === 'owner' ? t('m.role.owner') : m.role === 'admin' ? t('m.role.admin') : null;

  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
          <SquadCoverView name={s.name} cover={s.cover} size={72} />
          <View style={{ flex: 1 }}>
            <Text accessibilityRole="header" style={[{ color: c.ink, fontWeight: '800', fontSize: 22 }, userText]}>
              {s.name}
            </Text>
            <Text style={{ color: c.inkMuted }}>{tp('squads.people', s.memberCount)}</Text>
          </View>
        </View>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          <Button label={t('squads.share')} icon="add" size="sm" onPress={() => router.push({ pathname: '/create', params: { squad: s.id, mode: 'post' } })} />
          <Button
            label={t('squads.addStory')}
            icon="aperture-outline"
            size="sm"
            variant="secondary"
            onPress={() => router.push({ pathname: '/create', params: { squad: s.id, mode: 'story' } })}
          />
          {s.conversationId ? (
            <Button
              label={t('mixes.share.open')}
              icon="chatbubbles-outline"
              size="sm"
              variant="secondary"
              onPress={() => router.push({ pathname: '/chat/[id]', params: { id: s.conversationId! } })}
            />
          ) : null}
        </View>

        {s.memory ? <MemoryCard memory={s.memory} /> : null}

        {posts.length ? (
          <View style={{ gap: space[3] }}>
            {posts.map((p) => (
              <PostCard key={p.id} post={p} />
            ))}
            {cursor ? <Button label={t('m.common.loadingMore')} variant="ghost" disabled={busy === 'more'} onPress={more} /> : null}
          </View>
        ) : (
          <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('squads.feedEmpty')}</Text>
        )}

        <Card style={{ gap: space[3] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
            {t('m.community.membersTab')} · {tp('squads.people', s.memberCount)}
          </Text>
          {s.members.map((m) => (
            <View key={m.user.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 48 }}>
              <Avatar name={m.user.displayName} url={m.user.avatarUrl} size={36} />
              <View style={{ flex: 1 }}>
                <Text style={[{ color: c.ink, fontWeight: '600' }, userText]} numberOfLines={1}>
                  {m.user.displayName}
                </Text>
                <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                  @{m.user.username}
                  {roleLabel(m) ? ` · ${roleLabel(m)}` : ''}
                </Text>
              </View>
              {m.user.id !== me?.id ? (
                <Button
                  label="…"
                  accessibilityLabel={t('chat.group.optionsFor', { name: m.user.displayName })}
                  size="sm"
                  variant="ghost"
                  onPress={() => memberMenu(m)}
                />
              ) : null}
            </View>
          ))}
          {full ? (
            <Text style={{ color: c.inkMuted }}>{t('squads.full', { max: MAX_SQUAD_MEMBERS })}</Text>
          ) : inviting ? (
            <>
              <PeoplePick
                squadId={s.id}
                chosen={inviting}
                max={MAX_SQUAD_MEMBERS - s.memberCount}
                onToggle={(u) => setInviting((cur) => ((cur ?? []).includes(u.id) ? (cur ?? []).filter((x) => x !== u.id) : [...(cur ?? []), u.id]))}
              />
              <View style={{ flexDirection: 'row', gap: space[2] }}>
                <Button
                  label={t('friends.invite')}
                  disabled={!inviting.length || !!busy}
                  onPress={() =>
                    run('invite', async () => {
                      const r = await (await client()).squads.invite(s.id, inviting);
                      setSquad(r.squad);
                      setInviting(null);
                      Alert.alert(tp('squads.invited', r.invited));
                    })
                  }
                />
                <Button label={t('common.cancel')} variant="ghost" onPress={() => setInviting(null)} />
              </View>
            </>
          ) : (
            <Button
              label={t('squads.invite')}
              icon="person-add-outline"
              variant="secondary"
              size="sm"
              onPress={() => setInviting([])}
              style={{ alignSelf: 'flex-start' }}
            />
          )}
        </Card>

        {role === 'owner' || role === 'admin' ? (
          editing ? (
            <Card style={{ gap: space[3] }}>
              <Field label={t('squads.name')} value={editing.name} onChangeText={(name) => setEditing({ ...editing, name })} maxLength={SQUAD_RULES.nameMax} />
              <ColorChoice value={editing.color} onChange={(color) => setEditing({ ...editing, color })} />
              <PhotoChoice value={editing.photo} onChange={(photo) => setEditing({ ...editing, photo })} onError={setError} />
              <View style={{ flexDirection: 'row', gap: space[2] }}>
                <Button
                  label={busy === 'save' ? t('m.common.saving') : t('common.save')}
                  disabled={!!busy || !editing.name.trim()}
                  onPress={() =>
                    run('save', async () => {
                      const r = await (
                        await client()
                      ).squads.edit(s.id, {
                        name: editing.name.trim(),
                        color: editing.color,
                        ...(editing.photo?.id !== s.cover.photo?.id ? { coverMediaId: editing.photo?.id ?? null } : {}),
                      });
                      setSquad(r.squad);
                      setEditing(null);
                    })
                  }
                />
                <Button label={t('common.cancel')} variant="ghost" onPress={() => setEditing(null)} />
              </View>
            </Card>
          ) : (
            <Button
              label={t('m.title.settings')}
              icon="settings-outline"
              variant="ghost"
              onPress={() => setEditing({ name: s.name, color: s.cover.color, photo: s.cover.photo ? { id: s.cover.photo.id, url: s.cover.photo.url } : null })}
            />
          )
        ) : null}

        {role === 'owner' ? (
          <View style={{ gap: space[2] }}>
            <Text style={{ color: c.inkMuted }}>{t('squads.ownerNote')}</Text>
            <Button label={t('squads.delete')} variant="danger" icon="trash-outline" disabled={!!busy} onPress={destroy} />
          </View>
        ) : (
          <Button label={t('squads.leave')} variant="secondary" disabled={!!busy} onPress={leave} />
        )}
      </ScrollView>
      {sheet.sheet}
    </KeyboardAvoid>
  );
}
