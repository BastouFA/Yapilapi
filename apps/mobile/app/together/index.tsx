import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import type { YapilapiClient } from '../../../../packages/api-client/src/index';
import { client, errorMessage } from '../../lib/api';
import { useFlag } from '../../lib/flags';
import { FriendPicker, useFriends } from '../../lib/friend-picker';
import { useT } from '../../lib/i18n';
import { space } from '../../lib/theme';
import { Button, Card, EmptyState, Field, Loading, Notice, Pill, useColors, userText } from '../../lib/ui';

type TogetherItem = Awaited<ReturnType<YapilapiClient['together']['list']>>['items'][number];

/**
 * Together: one moment, everyone's view. The Togethers you're in (only members see them), and
 * starting one with friends. Behind the REAL_TOGETHER flag.
 */
export default function TogetherList() {
  const c = useColors();
  const { t, tp } = useT();
  const on = useFlag('REAL_TOGETHER');
  const friends = useFriends();
  const [items, setItems] = useState<TogetherItem[] | null>(null);
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await (await client()).together.list()).items);
    } catch (e) {
      setItems((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (on) void load();
    }, [on, load]),
  );

  if (on === undefined) return <Loading />;
  if (!on)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.together.off')} />
      </View>
    );

  async function start() {
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await (await client()).together.create({ title: name, memberIds: [...picked] });
      setTitle('');
      setPicked(new Set());
      router.push(`/together/${r.together.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.together.intro')}</Text>
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <View style={{ gap: space[2] }}>
        {items === null ? (
          <Loading />
        ) : items.length ? (
          items.map((x) => {
            const sub = `${tp('m.together.photos', x.contributions)} · ${tp('m.together.people', x.members)}`;
            return (
              <Card
                key={x.id}
                onPress={() => router.push(`/together/${x.id}`)}
                label={`${x.title}, ${sub}${x.status === 'closed' ? `, ${t('m.together.closed')}` : ''}`}
                style={{ gap: space[1] }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
                  <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 16, flex: 1 }, userText]} numberOfLines={2}>
                    {x.title}
                  </Text>
                  {x.status === 'closed' ? <Pill text={t('m.together.closed')} /> : null}
                </View>
                <Text style={{ color: c.inkMuted, fontSize: 13 }}>{sub}</Text>
              </Card>
            );
          })
        ) : (
          <EmptyState title={t('m.together.empty')} body={t('m.together.emptyBody')} />
        )}
      </View>

      <Card style={{ gap: space[3] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 17 }}>
          {t('m.together.start')}
        </Text>
        <Field label={t('m.together.what')} placeholder={t('m.together.placeholder')} value={title} onChangeText={setTitle} maxLength={120} />
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.together.invite')}</Text>
        <FriendPicker friends={friends} picked={picked} onChange={setPicked} empty={t('m.together.noFriends')} />
        <Button label={t('m.together.start')} disabled={!title.trim() || busy} onPress={() => void start()} />
      </Card>
    </ScrollView>
  );
}
