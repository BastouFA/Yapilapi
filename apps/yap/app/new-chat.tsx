import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../../mobile/lib/api';
import { useT } from '../../mobile/lib/i18n';
import { space } from '../../mobile/lib/theme';
import { Field, KeyboardAvoid, Notice, SkeletonList, useColors } from '../../mobile/lib/ui';
import { ListRow, RowIcon, RowLine } from '../lib/rows';

type Suggestion = { user: PublicUser; relation: 'friend' | 'following' | null; canMessage: boolean };

/**
 * New chat: New group at the top, then people to message, friends and people you follow first;
 * typing narrows it down. Tapping someone opens your chat with them (the API gives back the one you
 * already have). People you can't message yet are shown with the reason, and can't be tapped.
 */
export default function NewChat() {
  const c = useColors();
  const { t } = useT();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);

  useEffect(() => {
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        void client()
          .then((api) => api.people.suggest(q.trim(), 20))
          .then(
            (r) => n === req.current && setItems(r.items),
            () => n === req.current && setItems((cur) => cur ?? []),
          ),
      q ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [q]);

  async function open(user: PublicUser) {
    if (opening) return;
    setOpening(user.id);
    setError(null);
    try {
      const { conversation } = await (await client()).conversations.create([user.id]);
      router.replace(`/chat/${conversation.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setOpening(null);
    }
  }

  return (
    <KeyboardAvoid style={{ backgroundColor: c.ground }}>
      <FlatList
        data={items ?? []}
        keyExtractor={(s) => s.user.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ItemSeparatorComponent={RowLine}
        ListHeaderComponent={
          <View style={{ gap: space[2], paddingBottom: space[2] }}>
            <View style={{ paddingHorizontal: space[4], paddingTop: space[3] }}>
              <Field
                label={t('m.stories.searchPeople')}
                hideLabel
                placeholder={t('m.group.placeholder')}
                value={q}
                onChangeText={setQ}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                returnKeyType="search"
              />
            </View>
            <ListRow name={t('m.inbox.newGroup')} start={<RowIcon icon="people" />} title={t('m.inbox.newGroup')} onPress={() => router.push('/new-group')} />
            {error ? (
              <View style={{ paddingHorizontal: space[4] }}>
                <Notice tone="danger">{error}</Notice>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          items === null ? (
            <SkeletonList />
          ) : q.trim() ? (
            <Text style={{ color: c.inkMuted, textAlign: 'center', padding: space[6] }}>{t('m.group.noMatch', { query: q.trim() })}</Text>
          ) : null
        }
        renderItem={({ item }) => {
          const note = !item.canMessage
            ? t('m.group.cantMessage')
            : item.relation === 'friend'
              ? t('m.group.friend')
              : item.relation === 'following'
                ? t('m.group.following')
                : `@${item.user.username}`;
          return (
            <View style={{ opacity: item.canMessage ? 1 : 0.6 }} accessibilityState={{ disabled: !item.canMessage, busy: opening === item.user.id }}>
              <ListRow
                name={item.user.displayName}
                avatarUrl={item.user.avatarUrl}
                title={item.user.displayName}
                subtitle={note}
                onPress={() => (item.canMessage ? void open(item.user) : setError(t('m.group.cantMessage')))}
              />
            </View>
          );
        }}
      />
    </KeyboardAvoid>
  );
}
