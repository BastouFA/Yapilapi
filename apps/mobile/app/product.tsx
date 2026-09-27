import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { ShopItem } from '../../../packages/api-client/src/index';
import { formatBytes } from '../../../packages/shared/src/data-saver';
import { formatMoney } from '../../../packages/shared/src/i18n';
import type { Profile } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { useFlag } from '../lib/flags';
import { Pill } from '../lib/forms';
import { useT } from '../lib/i18n';
import { openDownload, openOnWeb, useKindLabel, useWebCheckout, webCheckout } from '../lib/money';
import { useReport } from '../lib/report';
import { useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { Avatar, Button, Card, EmptyState, Icon, Loading, Notice, useActionSheet, useColors, userText } from '../lib/ui';

/**
 * One thing from a profile's Shop (`product?username=&id=`, and web links to
 * /u/<name>?shop=1&product=<id>): what it is, its price, the file for a download, and who sells
 * it. A download you bought opens from here with a fresh link that works for 10 minutes, in the
 * system (browser or Files). Buying and booking open checkout on the web.
 */
export default function ProductScreen() {
  const { username, id } = useLocalSearchParams<{ username: string; id: string }>();
  const c = useColors();
  const { t, tp, locale } = useT();
  const kindLabel = useKindLabel();
  const commerce = useFlag('COMMERCE');
  const [seller, setSeller] = useState<Profile | null>(null);
  const [item, setItem] = useState<ShopItem | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // More in the header: report someone else's listing.
  const { me } = useSession();
  const menu = useActionSheet();
  const report = useReport();

  const load = useCallback(async () => {
    try {
      const api = await client();
      const p = (await api.users.get(username)).profile;
      setSeller(p);
      setItem((await api.shop.list(p.id)).items.find((x) => x.id === id) ?? null);
    } catch {
      setItem((cur) => cur ?? null);
    }
  }, [username, id]);
  useEffect(() => {
    void load();
  }, [load]);
  const { open, opened } = useWebCheckout(() => void load());

  if (item === undefined) return <Loading />;
  if (item === null || !seller)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.product.missing')} />
      </View>
    );

  const self = seller.relationship.isSelf;
  const price = formatMoney(item.priceCents, item.currency, locale);
  const soldOut = item.inventory === 0;

  async function download() {
    setBusy(true);
    setError(null);
    try {
      await openDownload(item!.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
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
      <Stack.Screen
        options={{
          headerRight:
            me && !self
              ? () => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('m.post.more')}
                    hitSlop={10}
                    onPress={() =>
                      menu.show({
                        title: item.title,
                        actions: [
                          {
                            label: t('post.report'),
                            icon: 'flag-outline',
                            destructive: true,
                            onPress: () => report.open({ type: 'product', id: item.id, authorId: seller.id, authorName: seller.displayName }),
                          },
                        ],
                      })
                    }
                  >
                    <Icon name="ellipsis-horizontal-circle-outline" size={24} color={c.yapi} />
                  </Pressable>
                )
              : undefined,
        }}
      />
      {menu.sheet}
      {report.sheet}
      <Card style={{ gap: space[3] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
          <View style={{ width: 52, height: 52, borderRadius: radius.md, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Icon
              name={item.kind === 'digital' ? 'download-outline' : item.kind === 'service' ? 'calendar-outline' : 'bag-handle-outline'}
              size={26}
              color={c.yapi}
            />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Pill text={kindLabel(item.kind)} />
            <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 }, userText]}>
              {item.title}
            </Text>
          </View>
        </View>
        <Text style={{ color: c.ink, fontSize: 22, fontWeight: '800' }}>{price}</Text>
        {item.owned ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="checkmark-circle" size={18} color={c.success} />
            <Text style={{ color: c.ink, fontWeight: '700' }}>{t('m.product.owned')}</Text>
          </View>
        ) : soldOut ? (
          <Text style={{ color: c.inkMuted, fontWeight: '700' }}>{t('shop.soldOut')}</Text>
        ) : item.inventory !== null && item.kind === 'product' ? (
          <Text style={{ color: c.inkMuted }}>{tp('m.product.left', item.inventory)}</Text>
        ) : null}
        {item.description ? <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 22 }, userText]}>{item.description}</Text> : null}
        {item.file ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Icon name="document-outline" size={18} color={c.inkMuted} />
            <Text style={[{ color: c.inkMuted, flex: 1 }, userText]}>
              {t('m.product.file', { name: item.file.name, size: formatBytes(item.file.sizeBytes) })}
            </Text>
          </View>
        ) : null}
      </Card>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {self ? (
        <Card style={{ gap: space[2] }}>
          <Text style={{ color: c.ink, lineHeight: 20 }}>{t('m.product.yours')}</Text>
          <Button label={t('m.studio.openWeb')} variant="secondary" icon="open-outline" onPress={() => openOnWeb('/studio#shop')} />
        </Card>
      ) : commerce === false ? (
        <Notice>{t('shop.unavailable')}</Notice>
      ) : item.kind === 'digital' && item.owned ? (
        <View style={{ gap: space[2] }}>
          <Button label={t('m.shop.download')} icon="download-outline" disabled={busy} onPress={() => download()} />
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.purchases.linkNote')}</Text>
        </View>
      ) : soldOut ? null : (
        <View style={{ gap: space[2] }}>
          {item.kind === 'service' ? <Text style={{ color: c.ink, lineHeight: 20 }}>{t('m.product.serviceNote', { name: seller.displayName })}</Text> : null}
          <Button
            label={item.kind === 'service' ? t('m.product.bookOnWeb') : t('m.product.buyOnWeb')}
            icon="open-outline"
            onPress={() => open(webCheckout.product(seller.username, item.id))}
          />
          <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>
            {opened ? t('m.product.afterPaying') : t('m.money.noCard')}
          </Text>
        </View>
      )}

      <Card onPress={() => router.push(`/u/${seller.username}`)} label={t('m.product.seller', { name: seller.displayName })}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
          <Avatar name={seller.displayName} url={seller.avatarUrl} size={40} />
          <View style={{ flex: 1 }}>
            <Text style={[{ color: c.ink, fontWeight: '700' }, userText]}>{t('m.product.seller', { name: seller.displayName })}</Text>
            <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>@{seller.username}</Text>
          </View>
          <Icon name="chevron-forward" size={18} color={c.inkMuted} directional />
        </View>
      </Card>
    </ScrollView>
  );
}
