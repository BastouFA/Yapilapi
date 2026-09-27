import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Image, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { TogetherDetail } from '../../../../packages/api-client/src/index';
import { client, errorMessage, mediaUrl } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { SensitiveCover } from '../../lib/safety';
import { useRealtime } from '../../lib/session';
import { space } from '../../lib/theme';
import { Avatar, Button, Card, EmptyState, Loading, Notice, Pill, useColors, userText } from '../../lib/ui';

type Contribution = TogetherDetail['contributions'][number];

/**
 * A Together: who's in it, and each person's photo of the moment with when it was taken. Only
 * members can open it (the API answers "not found" to anyone else). While it's open, "Add your
 * view" takes a photo with the Real camera; the creator can close it. New photos from others
 * arrive live.
 */
export default function TogetherScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, dateTime } = useT();
  const [tg, setTg] = useState<TogetherDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setTg((await (await client()).together.get(id)).together);
    } catch {
      setTg((cur) => cur ?? null);
    }
  }, [id]);

  // Also on coming back from the camera, with your photo in it.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useRealtime((e) => {
    if (e.type === 'together.contribution' && e.data?.togetherId === id) void load();
    if (e.type === 'app.foreground') void load();
  });

  if (tg === undefined) return <Loading />;
  if (tg === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <Stack.Screen options={{ title: t('m.together.title') }} />
        <EmptyState title={t('m.together.missing')} />
      </View>
    );
  const together = tg;

  function close() {
    Alert.alert(t('m.together.closeTitle'), t('m.together.closeBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('m.together.close'),
        onPress: async () => {
          setError(null);
          try {
            setTg((await (await client()).together.close(id)).together);
          } catch (e) {
            setError(errorMessage(e));
          }
        },
      },
    ]);
  }

  const names = together.members.map((m) => m.user.displayName.split(' ')[0]).join(', ');

  return (
    <>
      <Stack.Screen options={{ title: together.title }} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
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
        <View style={{ gap: space[2] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.4, flex: 1 }, userText]}>
              {together.title}
            </Text>
            {together.status === 'closed' ? <Pill text={t('m.together.closed')} /> : null}
          </View>
          <View accessible accessibilityLabel={t('m.together.members', { names })} style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <View style={{ flexDirection: 'row' }}>
              {together.members.slice(0, 5).map((m, i) => (
                <View key={m.user.id} style={{ marginStart: i ? -10 : 0, borderRadius: 16, borderWidth: 2, borderColor: c.ground }}>
                  <Avatar name={m.user.displayName} url={m.user.avatarUrl} size={28} />
                </View>
              ))}
            </View>
            <Text style={[{ color: c.inkMuted, flex: 1 }, userText]} numberOfLines={2}>
              {names}
            </Text>
          </View>
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>
            {together.status === 'open' && together.closesAt
              ? `${t('m.together.membersOnly')} ${t('m.together.openUntil', { time: dateTime(together.closesAt) })}`
              : t('m.together.membersOnly')}
          </Text>
        </View>

        {error ? <Notice tone="danger">{error}</Notice> : null}

        {together.status === 'open' ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button label={t('m.together.add')} icon="camera-outline" onPress={() => router.push(`/real?together=${encodeURIComponent(id)}`)} />
            {together.myRole === 'creator' ? <Button label={t('m.together.close')} variant="secondary" onPress={close} /> : null}
          </View>
        ) : null}

        {together.contributions.length ? (
          together.contributions.map((x) => <ContributionCard key={x.id} item={x} when={dateTime(x.capturedAt)} />)
        ) : (
          <EmptyState title={t('m.together.noViews')} body={t('m.together.noViewsBody')} />
        )}
      </ScrollView>
    </>
  );
}

/** One person's photo; sensitive ones stay blurred until the viewer chooses to see them. */
function ContributionCard({ item, when }: { item: Contribution; when: string }) {
  const c = useColors();
  const { t } = useT();
  const [shown, setShown] = useState(!item.media?.sensitive);
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      {item.media ? (
        <View style={{ width: '100%', aspectRatio: 4 / 5, backgroundColor: c.surfaceSunken }}>
          <Image
            source={{ uri: mediaUrl(item.media.url) }}
            accessibilityIgnoresInvertColors
            accessible={shown}
            accessibilityLabel={shown ? (item.media.altText ?? t('m.together.photoBy', { name: item.author.displayName })) : undefined}
            blurRadius={shown ? 0 : 30}
            resizeMode="cover"
            style={{ width: '100%', height: '100%' }}
          />
          {shown ? null : <SensitiveCover onReveal={() => setShown(true)} />}
        </View>
      ) : null}
      <View style={{ padding: space[3], gap: space[1], flexDirection: 'row', alignItems: 'flex-start' }}>
        <Avatar name={item.author.displayName} url={item.author.avatarUrl} size={32} />
        <View style={{ flex: 1, gap: 2, marginStart: space[2] }}>
          <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
            {item.author.displayName}
            <Text style={{ color: c.inkMuted, fontWeight: '400' }}> · {when}</Text>
          </Text>
          {item.caption ? <Text style={[{ color: c.ink, lineHeight: 20 }, userText]}>{item.caption}</Text> : null}
        </View>
      </View>
    </Card>
  );
}
