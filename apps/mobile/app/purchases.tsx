import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { PublicUser } from '../../../packages/shared/src/types';
import { formatBytes } from '../../../packages/shared/src/data-saver';
import { formatMoney } from '../../../packages/shared/src/i18n-core';
import { client, errorMessage } from '../lib/api';
import { SectionHeader } from '../lib/chips';
import { useT } from '../lib/i18n';
import { openDownload } from '../lib/money';
import { space } from '../lib/theme';
import { Avatar, Button, Card, ErrorState, Icon, Loading, Notice, Row, useColors, userText } from '../lib/ui';

type Purchase = { productId: string; title: string; boughtAt: string; file: { name: string; sizeBytes: number } | null; seller: PublicUser };
type Subscription = { id: string; status: string; plan: string; priceCents: number; currency: string; creator: PublicUser };

/**
 * Purchases (web: "Your downloads" in Settings): downloads you bought, each opened with a fresh
 * link that works for 10 minutes; the creators you subscribe to, with cancel; and the tips and
 * gifts you sent.
 */
export default function PurchasesScreen() {
  const c = useColors();
  const { t, locale, date } = useT();
  const [downloads, setDownloads] = useState<Purchase[] | null>(null);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const api = await client();
    const [p, s] = await Promise.allSettled([api.shop.purchases(), api.economy.mySubscriptions()]);
    setDownloads(p.status === 'fulfilled' ? p.value.items : []);
    setSubs(s.status === 'fulfilled' ? s.value.items : []);
    if (p.status === 'rejected') setError(errorMessage(p.reason));
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (downloads === null) return <Loading />;

  async function download(id: string) {
    setBusy(id);
    setError(null);
    try {
      await openDownload(id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  function cancel(s: Subscription) {
    Alert.alert(t('m.purchases.cancelTitle', { name: s.creator.displayName }), t('m.purchases.cancelBody'), [
      { text: t('m.purchases.keep'), style: 'cancel' },
      {
        text: t('m.purchases.cancel'),
        style: 'destructive',
        onPress: async () => {
          setError(null);
          try {
            await (await client()).economy.cancel(s.id);
            setNote(t('m.purchases.cancelled'));
            await load();
          } catch (e) {
            setError(errorMessage(e));
          }
        },
      },
    ]);
  }

  return (
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
      {error ? <ErrorState message={error} onRetry={load} /> : null}
      {note ? (
        <View accessibilityLiveRegion="polite">
          <Notice>{note}</Notice>
        </View>
      ) : null}

      <View style={{ gap: space[2] }}>
        <SectionHeader title={t('shop.purchases.title')} />
        {downloads.length ? (
          <>
            {downloads.map((p) => (
              <Card key={p.productId} style={{ gap: space[2] }}>
                <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 15 }, userText]}>{p.title}</Text>
                <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>
                  {t('m.purchases.from', { name: p.seller.displayName, date: date(p.boughtAt, { dateStyle: 'medium' }) })}
                  {p.file ? ` · ${formatBytes(p.file.sizeBytes)}` : ''}
                </Text>
                {p.file ? (
                  <Button
                    label={t('m.shop.download')}
                    icon="download-outline"
                    size="sm"
                    style={{ alignSelf: 'flex-start' }}
                    disabled={busy === p.productId}
                    onPress={() => download(p.productId)}
                  />
                ) : (
                  <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.purchases.noFile')}</Text>
                )}
              </Card>
            ))}
            <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.purchases.linkNote')}</Text>
          </>
        ) : (
          <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.purchases.noDownloads')}</Text>
        )}
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title={t('m.purchases.subscriptions')} />
        {subs.length ? (
          subs.map((s) => (
            <Card key={s.id} style={{ gap: space[2] }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
                <Avatar name={s.creator.displayName} url={s.creator.avatarUrl} size={40} />
                <View style={{ flex: 1 }}>
                  <Text style={[{ color: c.ink, fontWeight: '700' }, userText]}>{s.creator.displayName}</Text>
                  <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>
                    {s.plan} · {t('m.money.perMonth', { price: formatMoney(s.priceCents, s.currency, locale) })}
                  </Text>
                  {s.status !== 'active' ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.money.waitingPayment')}</Text> : null}
                </View>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
                <Button
                  label={t('m.money.seePlans')}
                  size="sm"
                  variant="secondary"
                  onPress={() => router.push({ pathname: '/plans', params: { username: s.creator.username } })}
                />
                <Button label={t('m.purchases.cancel')} size="sm" variant="ghost" onPress={() => cancel(s)} />
              </View>
            </Card>
          ))
        ) : (
          <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.purchases.noSubscriptions')}</Text>
        )}
      </View>

      <Row
        title={t('m.purchases.tipsSent')}
        start={<Icon name="gift-outline" size={20} color={c.yapi} />}
        end={<Icon name="chevron-forward" size={18} color={c.inkMuted} directional />}
        onPress={() => router.push({ pathname: '/gifts', params: { tab: 'sent' } })}
      />
    </ScrollView>
  );
}
