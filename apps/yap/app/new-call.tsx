import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { Conversation } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../../mobile/lib/api';
import { useCalls } from '../../mobile/lib/calls';
import { useT } from '../../mobile/lib/i18n';
import { conversationTitle } from '../../mobile/lib/post';
import { useSession } from '../../mobile/lib/session';
import { space } from '../../mobile/lib/theme';
import { ErrorState, Field, KeyboardAvoid, SkeletonList, useColors } from '../../mobile/lib/ui';
import { ListRow, RoundButton, RowLine } from '../lib/rows';

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/**
 * New call: your chats (people and groups), searchable, each with an audio and a video call
 * button. Calls follow the same rules as messages (the API checks blocks, minor safety and who can
 * message whom), and ring through CallsProvider.
 */
export default function NewCall() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const { start } = useCalls();
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const load = () =>
    client()
      .then((api) => api.conversations.list())
      .then(
        (r) => (setItems(r.items), setError(null)),
        (e) => (setItems((cur) => cur ?? []), setError(errorMessage(e))),
      );
  useEffect(() => {
    void load();
  }, []);

  const meId = me?.id;
  // The call screen opens over the chats, not over this sheet.
  const call = (id: string, kind: 'audio' | 'video') => {
    if (router.canGoBack()) router.back();
    void start(id, kind);
  };
  const shown = useMemo(() => {
    const needle = fold(q.trim());
    const list = items ?? [];
    return needle ? list.filter((x) => fold(conversationTitle(x, meId, t)).includes(needle)) : list;
  }, [items, q, meId, t]);

  return (
    <KeyboardAvoid style={{ backgroundColor: c.ground }}>
      <FlatList
        data={shown}
        keyExtractor={(x) => x.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ItemSeparatorComponent={RowLine}
        ListHeaderComponent={
          <View style={{ padding: space[4], gap: space[2] }}>
            <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
              {t('yapApp.calls.pick')}
            </Text>
            <Field label={t('yapApp.chats.search')} hideLabel placeholder={t('yapApp.chats.search')} value={q} onChangeText={setQ} autoCorrect={false} />
            {error ? <ErrorState message={error} onRetry={load} /> : null}
          </View>
        }
        ListEmptyComponent={
          items === null ? (
            <SkeletonList />
          ) : q.trim() ? (
            <Text style={{ color: c.inkMuted, textAlign: 'center', padding: space[6] }}>{t('yapApp.chats.noMatch', { query: q.trim() })}</Text>
          ) : null
        }
        renderItem={({ item }) => {
          const title = conversationTitle(item, meId, t);
          const other = item.members.find((m) => m.id !== meId);
          return (
            <ListRow
              name={title}
              avatarUrl={item.kind === 'direct' ? (other?.avatarUrl ?? null) : null}
              title={title}
              onPress={() => call(item.id, 'audio')}
              label={`${title}, ${t('m.calls.startAudio')}`}
              end={
                <View style={{ flexDirection: 'row' }}>
                  <RoundButton icon="call-outline" label={`${t('m.calls.startAudio')}: ${title}`} onPress={() => call(item.id, 'audio')} />
                  <RoundButton icon="videocam-outline" label={`${t('m.calls.startVideo')}: ${title}`} onPress={() => call(item.id, 'video')} />
                </View>
              }
            />
          );
        }}
      />
    </KeyboardAvoid>
  );
}
