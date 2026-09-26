import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { useT } from '../lib/i18n';
import { radius, space } from '../lib/theme';
import { Avatar, Button, Field, Icon, Notice, useColors, userText } from '../lib/ui';

type Suggestion = { user: PublicUser; relation: 'friend' | 'following' | null; canMessage: boolean };

/**
 * New group: a name, then people picked from suggestions. Before typing it offers friends,
 * people you follow and recent chats; each letter narrows it down. People you can't message
 * yet are shown, with the reason, but can't be added.
 */
export default function NewGroup() {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const req = useRef(0);

  useEffect(() => {
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        void client()
          .then((api) => api.people.suggest(q.trim(), 12))
          .then(
            (r) => n === req.current && setItems(r.items),
            () => n === req.current && setItems((cur) => cur ?? []),
          ),
      q ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [q]);

  const shown = (items ?? []).filter((s) => !picked.some((p) => p.id === s.user.id));

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { conversation } = await (
        await client()
      ).conversations.create(
        picked.map((p) => p.id),
        title.trim() || (picked.length > 1 ? picked.map((p) => p.displayName.split(' ')[0]).join(', ') : undefined),
      );
      router.replace(`/chat/${conversation.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.ground }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 56 : 0}
    >
      <FlatList
        data={shown}
        keyExtractor={(s) => s.user.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space[4], gap: space[2] }}
        ListHeaderComponent={
          <View style={{ gap: space[3], marginBottom: space[1] }}>
            <Field label={t('m.group.name')} value={title} onChangeText={setTitle} maxLength={80} />
            <View style={{ gap: space[1] }}>
              <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.group.addPeople')}</Text>
              {picked.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2], marginBottom: space[1] }}>
                  {picked.map((p) => (
                    <Pressable
                      key={p.id}
                      accessibilityRole="button"
                      accessibilityLabel={t('m.group.removePerson', { name: p.displayName })}
                      onPress={() => setPicked((cur) => cur.filter((x) => x.id !== p.id))}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        backgroundColor: c.yapiSoft,
                        borderRadius: radius.full,
                        paddingStart: 4,
                        paddingEnd: 10,
                        paddingVertical: 4,
                      }}
                    >
                      <Avatar name={p.displayName} url={p.avatarUrl} size={24} />
                      <Text style={[{ color: c.ink, fontWeight: '600', fontSize: 13, maxWidth: 160 }, userText]} numberOfLines={1}>
                        {p.displayName}
                      </Text>
                      <Icon name="close" size={14} color={c.inkMuted} />
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <Field
                label={t('m.group.addPeople')}
                hideLabel
                placeholder={t('m.group.placeholder')}
                value={q}
                onChangeText={setQ}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
              />
            </View>
            {items !== null && !shown.length && q.trim() ? (
              <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted }}>
                {t('m.group.noMatch', { query: q.trim() })}
              </Text>
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          const meta = [
            `@${item.user.username}`,
            item.relation === 'friend' ? t('m.group.friend') : item.relation === 'following' ? t('m.group.following') : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !item.canMessage }}
              accessibilityLabel={item.user.displayName}
              accessibilityHint={item.canMessage ? meta : t('m.group.cantMessage')}
              disabled={!item.canMessage}
              onPress={() => {
                setPicked((cur) => [...cur, item.user]);
                setQ('');
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
                <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                  {meta}
                </Text>
                {!item.canMessage ? <Text style={{ color: c.inkMuted, fontSize: 12, fontStyle: 'italic' }}>{t('m.group.cantMessage')}</Text> : null}
              </View>
              {item.canMessage ? <Icon name="add-circle-outline" size={22} color={c.yapi} /> : null}
            </Pressable>
          );
        }}
      />
      <View style={{ padding: space[4], paddingBottom: Math.max(insets.bottom, space[4]), gap: space[2], borderTopWidth: 1, borderTopColor: c.line }}>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button label={busy ? t('m.group.starting') : t('m.group.start')} disabled={!picked.length || busy} onPress={() => void start()} />
      </View>
    </KeyboardAvoidingView>
  );
}
