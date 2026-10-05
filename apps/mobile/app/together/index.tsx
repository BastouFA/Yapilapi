import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Image, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { TogetherSummary } from '../../../../packages/shared/src/together';
import { client, errorMessage, mediaUrl } from '../../lib/api';
import { useFlag } from '../../lib/flags';
import { useT } from '../../lib/i18n';
import { useRealtime } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { statusText } from '../../lib/together';
import { Button, Card, EmptyState, ErrorState, Icon, Loading, Notice, useColors, userText } from '../../lib/ui';

/**
 * Together: the shared albums you're in (only their people see them), open ones first, and a
 * way to start one. Behind the REAL_TOGETHER flag.
 */
export default function TogetherList() {
  const c = useColors();
  const tr = useT();
  const { t, tp } = tr;
  const on = useFlag('REAL_TOGETHER');
  const [items, setItems] = useState<TogetherSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await (await client()).together.list()).items);
      setError(null);
    } catch (e) {
      // A list already showing stays, with the reason above it; with none yet, the reason and Try again.
      setError(errorMessage(e));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (on) void load();
    }, [on, load]),
  );
  useRealtime((e) => {
    if (e.type === 'together.items' || e.type === 'together.updated' || e.type === 'together.requests') void load();
  });

  if (on === undefined) return <Loading />;
  if (!on)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('together.off')} />
      </View>
    );

  const open = items?.filter((a) => a.status === 'open') ?? [];
  const closed = items?.filter((a) => a.status === 'closed') ?? [];
  const card = (a: TogetherSummary) => {
    const sub = `${tp('together.items', a.itemCount)} · ${tp('together.people', a.memberCount)}`;
    const status = statusText(a, tr);
    return (
      <Card
        key={a.id}
        onPress={() => router.push(`/together/${a.id}`)}
        label={`${a.title}, ${sub}, ${status}${a.requestCount ? `, ${tp('together.requests.count', a.requestCount)}` : ''}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], padding: space[2] }}
      >
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: radius.md,
            overflow: 'hidden',
            backgroundColor: c.yapiSoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {a.cover?.thumbUrl ? (
            <Image source={{ uri: mediaUrl(a.cover.thumbUrl) }} style={{ width: '100%', height: '100%' }} accessibilityIgnoresInvertColors />
          ) : (
            <Icon name="images-outline" size={28} color={c.yapi} />
          )}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[{ color: c.ink, fontWeight: '800', fontSize: 16 }, userText]} numberOfLines={1}>
            {a.title}
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{sub}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {a.status === 'open' ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.success }} /> : null}
            <Text style={{ color: c.inkMuted, fontSize: 13 }} numberOfLines={1}>
              {status}
            </Text>
          </View>
          {a.requestCount ? (
            <Text
              style={{
                alignSelf: 'flex-start',
                color: c.ink,
                backgroundColor: c.saffronSoft,
                borderRadius: radius.full,
                paddingHorizontal: 8,
                fontSize: 12,
                fontWeight: '700',
              }}
            >
              {tp('together.requests.count', a.requestCount)}
            </Text>
          ) : null}
        </View>
        <Icon name="chevron-forward" size={18} color={c.inkMuted} directional />
      </Card>
    );
  };

  return (
    <ScrollView
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[8] }}
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
      <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('together.intro')}</Text>
      <Button label={t('together.new')} icon="add" onPress={() => router.push('/together/new')} />
      {error && items ? <Notice tone="danger">{error}</Notice> : null}
      {items === null && error ? (
        <ErrorState message={error} onRetry={load} />
      ) : items === null ? (
        <Loading />
      ) : items.length ? (
        <>
          {open.length ? (
            <Text accessibilityRole="header" style={{ color: c.inkMuted, fontWeight: '700', fontSize: 13, marginTop: space[2] }}>
              {t('together.list.open')}
            </Text>
          ) : null}
          {open.map(card)}
          {closed.length ? (
            <Text accessibilityRole="header" style={{ color: c.inkMuted, fontWeight: '700', fontSize: 13, marginTop: space[2] }}>
              {t('together.list.closed')}
            </Text>
          ) : null}
          {closed.map(card)}
        </>
      ) : (
        <EmptyState title={t('together.empty')} body={t('together.emptyBody')} />
      )}
    </ScrollView>
  );
}
