import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Conversation, PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { useT } from '../lib/i18n';
import { useRealtime, useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { Avatar, Button, ErrorState, Field, Icon, KeyboardAvoid, Notice, useColors, userText } from '../lib/ui';

type Suggestion = { user: PublicUser; relation: 'friend' | 'following' | null; canMessage: boolean };

/**
 * A group's name and the people in it. Admins rename it, remove people and choose admins; anyone
 * in it adds people and can leave. Each change writes a line in the chat.
 */
export default function GroupInfo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const insets = useSafeAreaInsets();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const req = useRef(0);

  const load = useCallback(async () => {
    try {
      const { conversation } = await (await client()).conversations.get(id);
      setConv(conversation);
      setTitle(conversation.title ?? '');
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime((e) => {
    if (e.type === 'conversation.changed' && e.data?.id === id) void load();
    if (e.type === 'conversation.removed' && e.data?.id === id) router.back();
  });

  // People to add, as you type (friends, people you follow and recent chats first).
  useEffect(() => {
    if (!q.trim()) return setItems(null);
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        void client()
          .then((api) => api.people.suggest(q.trim(), 8))
          .then(
            (r) => n === req.current && setItems(r.items),
            () => n === req.current && setItems([]),
          ),
      150,
    );
    return () => clearTimeout(timer);
  }, [q]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <ErrorState message={loadError} onRetry={load} />;
  if (!conv) return <ActivityIndicator color={c.yapi} accessibilityLabel={t('common.loading')} style={{ marginTop: space[6] }} />;

  // A squad's chat follows the squad: who is in it, its name and leaving are managed there.
  const squad = !!conv.squadId;
  const admin = conv.myRole === 'admin' && !squad;
  const admins = new Set(conv.adminIds ?? []);
  const inGroup = new Set(conv.members.map((m) => m.id));
  const shown = squad ? [] : (items ?? []).filter((s) => !inGroup.has(s.user.id));
  const people = [...conv.members].sort((a, b) => (a.id === me?.id ? -1 : b.id === me?.id ? 1 : Number(admins.has(b.id)) - Number(admins.has(a.id))));

  const personOptions = (p: PublicUser) =>
    Alert.alert(p.displayName, undefined, [
      admins.has(p.id)
        ? { text: t('chat.group.dropAdmin'), onPress: () => void act(async () => (await client()).conversations.setRole(id, p.id, 'member')) }
        : { text: t('chat.group.makeAdmin'), onPress: () => void act(async () => (await client()).conversations.setRole(id, p.id, 'admin')) },
      {
        text: t('chat.group.remove'),
        style: 'destructive',
        onPress: () =>
          Alert.alert(t('chat.group.removeConfirm', { name: p.displayName }), undefined, [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('chat.group.remove'), style: 'destructive', onPress: () => void act(async () => (await client()).conversations.removeMember(id, p.id)) },
          ]),
      },
      { text: t('common.cancel'), style: 'cancel' },
    ]);

  const leave = () =>
    Alert.alert(t('chat.group.leaveConfirm'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('chat.group.leave'),
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await (await client()).conversations.leave(id);
            // Out of the group and its chat, back to the chats.
            if (router.canDismiss()) router.dismissAll();
            router.replace('/inbox');
          } catch (e) {
            setError(errorMessage(e));
            setBusy(false);
          }
        },
      },
    ]);

  return (
    <KeyboardAvoid style={{ backgroundColor: c.ground }}>
      <FlatList
        data={shown}
        keyExtractor={(s) => s.user.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space[4], gap: space[2], paddingBottom: Math.max(insets.bottom, space[4]) }}
        ListHeaderComponent={
          <View style={{ gap: space[3], marginBottom: space[1] }}>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            {admin ? (
              <View style={{ gap: space[2] }}>
                <Field label={t('chat.group.name')} value={title} onChangeText={setTitle} maxLength={80} />
                <Button
                  label={t('chat.group.saveName')}
                  size="sm"
                  variant="secondary"
                  disabled={busy || !title.trim() || title.trim() === conv.title}
                  onPress={() => act(async () => (await client()).conversations.rename(id, title.trim()))}
                />
              </View>
            ) : null}
            <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 16 }}>
              {t('chat.group.people')}
            </Text>
            {people.map((p) => {
              const canManage = admin && p.id !== me?.id;
              return (
                <Pressable
                  key={p.id}
                  accessibilityRole={canManage ? 'button' : 'text'}
                  accessibilityLabel={canManage ? t('chat.group.optionsFor', { name: p.displayName }) : p.displayName}
                  disabled={!canManage || busy}
                  onPress={() => personOptions(p)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space[3],
                    padding: space[3],
                    minHeight: 52,
                    borderRadius: radius.md,
                    backgroundColor: c.surface,
                  }}
                >
                  <Avatar name={p.displayName} url={p.avatarUrl} size={40} />
                  <View style={{ flex: 1 }}>
                    <Text style={[{ color: c.ink, fontWeight: '600', fontSize: 15 }, userText]} numberOfLines={1}>
                      {p.id === me?.id ? `${p.displayName} (${t('m.chat.you')})` : p.displayName}
                    </Text>
                    <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                      {admins.has(p.id) ? t('chat.group.adminBadge') : `@${p.username}`}
                    </Text>
                  </View>
                  {canManage ? <Icon name="ellipsis-horizontal" size={20} color={c.inkMuted} /> : null}
                </Pressable>
              );
            })}
            {squad ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('squads.chatNote')}</Text> : null}
            {squad ? null : <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('chat.group.adminsNote')}</Text>}
            {squad ? null : (
              <Field
                label={t('chat.group.add')}
                placeholder={t('m.group.placeholder')}
                value={q}
                onChangeText={setQ}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
              />
            )}
            {!squad && items !== null && !shown.length && q.trim() ? (
              <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted }}>
                {t('m.group.noMatch', { query: q.trim() })}
              </Text>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !item.canMessage || busy }}
            accessibilityLabel={`${t('chat.group.addButton')}: ${item.user.displayName}`}
            accessibilityHint={item.canMessage ? undefined : t('m.group.cantMessage')}
            disabled={!item.canMessage || busy}
            onPress={async () => {
              if (await act(async () => (await client()).conversations.addMembers(id, [item.user.id]))) setQ('');
            }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[3],
              padding: space[3],
              borderRadius: radius.md,
              backgroundColor: c.surface,
              opacity: item.canMessage ? (pressed ? 0.8 : 1) : 0.5,
            })}
          >
            <Avatar name={item.user.displayName} url={item.user.avatarUrl} size={40} />
            <View style={{ flex: 1 }}>
              <Text style={[{ color: c.ink, fontWeight: '600', fontSize: 15 }, userText]} numberOfLines={1}>
                {item.user.displayName}
              </Text>
              {!item.canMessage ? <Text style={{ color: c.inkMuted, fontSize: 12, fontStyle: 'italic' }}>{t('m.group.cantMessage')}</Text> : null}
            </View>
            {item.canMessage ? <Icon name="add-circle-outline" size={22} color={c.yapi} /> : null}
          </Pressable>
        )}
        ListFooterComponent={
          squad ? null : (
            <View style={{ marginTop: space[4] }}>
              <Button label={t('chat.group.leave')} variant="danger" disabled={busy} onPress={leave} />
            </View>
          )
        }
      />
    </KeyboardAvoid>
  );
}
