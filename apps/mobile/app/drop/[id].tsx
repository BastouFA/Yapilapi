import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Platform, Pressable, RefreshControl, ScrollView, Share, Text, View } from 'react-native';
import { dropPhase, type Drop } from '../../../../packages/shared/src/drops';
import { formatMoney } from '../../../../packages/shared/src/i18n';
import { client, errorMessage, webUrl } from '../../lib/api';
import { DropCover, dropStatusText, useNow } from '../../lib/drops';
import { useT } from '../../lib/i18n';
import { openOnWeb, useWebCheckout } from '../../lib/money';
import { useReport } from '../../lib/report';
import { useRealtime, useSession } from '../../lib/session';
import { ManagedOnWeb, useDigitalPurchases } from '../../lib/store';
import { radius, space } from '../../lib/theme';
import { Avatar, Button, Card, EmptyState, Icon, Loading, Notice, useActionSheet, useColors, userText } from '../../lib/ui';

/**
 * A drop: what it is, who sells it, when it opens (in plain words), and its products with the
 * real numbers left. Before it opens, "Notify me" puts you on the reminder list (a notification
 * when it opens; nothing is charged or held). Once open, products are bought on the web, like
 * everything that costs money. The seller also sees how many are waiting and the sales, and can
 * cancel; making and editing a drop happen on the web. Downloads in a drop are digital goods:
 * where the app store rules don't allow a link out (lib/store.tsx) their prices are left out, and a
 * drop of only downloads has no buy button. Physical products always keep their checkout.
 */
export default function DropScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const tr = useT();
  const { t, tp, locale, date } = tr;
  const { me } = useSession();
  const now = useNow(15_000);
  const [drop, setDrop] = useState<Drop | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const offer = useDigitalPurchases();
  const menu = useActionSheet();
  const report = useReport();

  const load = useCallback(async () => {
    try {
      setDrop((await (await client()).drops.get(id)).drop);
    } catch {
      setDrop((cur) => cur ?? null);
    }
  }, [id]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useRealtime((e) => {
    if (e.type === 'drop.updated' && (e.data as { id?: string } | undefined)?.id === id) void load();
  });
  // About to open: look again until the server has opened it.
  const opening = drop ? dropPhase(drop, now) === 'opening' : false;
  useEffect(() => {
    if (opening) void load();
  }, [opening, now, load]);
  const { open: openCheckout, opened } = useWebCheckout(() => void load());

  // The status line changes every minute ("in 5 minutes"), so it isn't a live region: say it only
  // when the drop moves on (it opens, sells out, ends) while the screen is open.
  const phaseNow = drop ? dropPhase(drop, now) : null;
  const lastPhase = useRef<string | null>(null);
  useEffect(() => {
    if (!drop || !phaseNow) return;
    if (lastPhase.current && lastPhase.current !== phaseNow) AccessibilityInfo.announceForAccessibility(dropStatusText(tr, drop, now));
    lastPhase.current = phaseNow;
  }, [phaseNow, drop, now, tr]);
  // What Notify me (or Stop) did, or why it didn't work, is read out: the notes appear further down.
  const said = error ?? note;
  useEffect(() => {
    if (said) AccessibilityInfo.announceForAccessibility(said);
  }, [said]);

  if (drop === undefined) return <Loading />;
  if (drop === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.drops.missing')} body={t('m.drops.missingBody')} />
      </View>
    );

  const d = drop;
  const phase = dropPhase(d, now);
  const upcoming = phase === 'upcoming' || phase === 'opening';
  const webPath = `/drops/${encodeURIComponent(d.id)}`;

  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    const url = `${webUrl}${webPath}`;
    try {
      await Share.share(Platform.OS === 'ios' ? { url, message: d.title } : { message: `${d.title}\n${url}`, title: d.title });
    } catch {
      // The person closed the share sheet.
    }
  }

  function cancel() {
    Alert.alert(t('m.drops.cancel'), t('m.drops.cancelConfirm'), [
      { text: t('m.drops.keep'), style: 'cancel' },
      {
        text: t('m.drops.cancel'),
        style: 'destructive',
        onPress: () => void act(async () => setDrop((await (await client()).drops.cancel(d.id)).drop), t('m.drops.cancelDone')),
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
          tintColor={c.yapi}
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
          title: t('m.drops.title'),
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.post.more')}
              hitSlop={10}
              onPress={() =>
                menu.show({
                  title: d.title,
                  actions: [
                    ...(d.status !== 'draft' ? [{ label: t('m.drops.share'), icon: 'share-outline' as const, onPress: () => void share() }] : []),
                    ...(me && !d.isSeller
                      ? [
                          {
                            label: t('m.drops.report'),
                            icon: 'flag-outline' as const,
                            destructive: true,
                            onPress: () => report.open({ type: 'drop', id: d.id, authorId: d.seller.id, authorName: d.seller.displayName }),
                          },
                        ]
                      : []),
                  ],
                })
              }
            >
              <Icon name="ellipsis-horizontal-circle-outline" size={24} color={c.yapi} />
            </Pressable>
          ),
        }}
      />
      {menu.sheet}
      {report.sheet}

      <DropCover drop={d} wide />
      <View style={{ gap: space[2] }}>
        <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.3 }, userText]}>
          {d.title}
        </Text>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t('m.drops.by', { name: d.seller.displayName })}
          onPress={() => router.push(`/u/${d.seller.username}`)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 44 }}
        >
          <Avatar name={d.seller.displayName} url={d.seller.avatarUrl} size={32} />
          <Text style={[{ color: c.ink, fontWeight: '700' }, userText]}>{t('m.drops.by', { name: d.seller.displayName })}</Text>
        </Pressable>
        <Text style={{ color: phase === 'open' ? c.success : c.ink, fontWeight: '800', fontSize: 16 }}>{dropStatusText(tr, d, now)}</Text>
        {d.description ? <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 22 }, userText]}>{d.description}</Text> : null}
      </View>

      {phase === 'draft' ? <Notice>{t('m.drops.draftNote')}</Notice> : null}
      {phase === 'cancelled' ? <Notice>{t('m.drops.cancelledNote')}</Notice> : null}
      {phase === 'ended' ? <Notice>{d.endReason === 'sold_out' ? t('m.drops.soldOutNote') : t('m.drops.endedNote')}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {note ? <Notice>{note}</Notice> : null}

      {upcoming && !d.isSeller ? (
        <View style={{ gap: space[2] }}>
          {d.reminded ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon name="checkmark-circle" size={18} color={c.success} />
                <Text style={{ color: c.ink, fontWeight: '700' }}>{t('m.drops.notifying')}</Text>
              </View>
              <Button
                label={t('m.drops.stopNotifying')}
                variant="secondary"
                disabled={busy}
                onPress={() =>
                  act(async () => {
                    await (await client()).drops.unremind(d.id);
                    setDrop({ ...d, reminded: false });
                  }, t('m.drops.notifyOff'))
                }
              />
            </>
          ) : (
            <Button
              label={t('m.drops.notifyMe')}
              icon="notifications-outline"
              disabled={busy}
              onPress={() =>
                act(async () => {
                  await (await client()).drops.remind(d.id);
                  setDrop({ ...d, reminded: true });
                }, t('m.drops.notifyOn'))
              }
            />
          )}
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.drops.notifyNote')}</Text>
        </View>
      ) : null}

      <View style={{ gap: space[3] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
          {tp('m.drops.products', d.items.length)}
        </Text>
        {d.items.map((item) => {
          const stat = d.stats?.items.find((s) => s.productId === item.productId);
          return (
            <Card key={item.productId} style={{ gap: space[2] }}>
              <View style={{ flexDirection: 'row', gap: space[3], alignItems: 'flex-start' }}>
                <Text style={[{ flex: 1, color: c.ink, fontSize: 16, fontWeight: '800' }, userText]}>{item.title}</Text>
                {item.kind === 'digital' && offer !== 'link' ? null : (
                  <Text style={{ color: c.ink, fontSize: 16, fontWeight: '800' }}>{formatMoney(item.priceCents, item.currency, locale)}</Text>
                )}
              </View>
              {item.description ? <Text style={[{ color: c.inkMuted, lineHeight: 20 }, userText]}>{item.description}</Text> : null}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[3] }}>
                {item.soldOut ? (
                  <Text style={{ color: c.inkMuted, fontWeight: '700' }}>{t('m.drops.soldOut')}</Text>
                ) : item.remaining !== null ? (
                  <Text style={{ color: c.ink }}>{tp('m.drops.left', item.remaining)}</Text>
                ) : null}
                {item.perBuyerLimit !== null && item.kind !== 'digital' ? (
                  <Text style={{ color: c.ink }}>{t('m.drops.limit', { count: item.perBuyerLimit })}</Text>
                ) : null}
                {item.yours ? <Text style={{ color: c.ink }}>{t('m.drops.yoursCount', { count: item.yours })}</Text> : null}
              </View>
              {stat ? (
                <Text style={{ color: c.inkMuted, fontSize: 13 }}>
                  {t('m.drops.stats.itemSold', { sold: stat.sold, held: stat.held })}
                  {stat.soldOutAt ? ` · ${t('m.drops.stats.soldOutAt', { when: date(stat.soldOutAt, { dateStyle: 'medium', timeStyle: 'short' }) })}` : ''}
                </Text>
              ) : null}
            </Card>
          );
        })}
      </View>

      {phase === 'open' && !d.isSeller && offer !== 'link' && d.items.every((i) => i.kind === 'digital') ? (
        <ManagedOnWeb text={t('m.store.download')} />
      ) : phase === 'open' && !d.isSeller ? (
        <View style={{ gap: space[2] }}>
          <Button label={t('m.drops.buyOnWeb')} icon="open-outline" onPress={() => openCheckout(webPath)} />
          <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>
            {opened ? t('m.product.afterPaying') : t('m.money.noCard')}
          </Text>
        </View>
      ) : null}

      {d.isSeller && d.stats ? (
        <Card style={{ gap: space[2] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
            {t('m.drops.stats.title')}
          </Text>
          {[
            [t('m.drops.stats.waiting'), String(d.stats.waiting)],
            [t('m.drops.stats.orders'), String(d.stats.orders)],
            [t('m.drops.stats.sold'), String(d.stats.unitsSold)],
            [t('m.drops.stats.held'), String(d.stats.unitsHeld)],
            [t('m.drops.stats.revenue'), d.stats.revenue.length ? d.stats.revenue.map((r) => formatMoney(r.grossCents, r.currency, locale)).join(' · ') : '0'],
          ].map(([label, value]) => (
            <View
              key={label}
              accessible
              accessibilityLabel={`${label}: ${value}`}
              style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space[3] }}
            >
              <Text style={{ color: c.inkMuted }}>{label}</Text>
              <Text style={{ color: c.ink, fontWeight: '800' }}>{value}</Text>
            </View>
          ))}
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.drops.stats.note')}</Text>
        </Card>
      ) : null}

      {d.isSeller ? (
        <View style={{ gap: space[2] }}>
          {phase === 'draft' || phase === 'upcoming' ? (
            <Button label={t('m.drops.editOnWeb')} variant="secondary" icon="open-outline" onPress={() => openOnWeb(`${webPath}/edit`)} />
          ) : null}
          {d.status === 'scheduled' || d.status === 'open' ? <Button label={t('m.drops.cancel')} variant="danger" disabled={busy} onPress={cancel} /> : null}
        </View>
      ) : null}

      {d.status !== 'draft' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('m.drops.share')}
          onPress={() => void share()}
          style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space[2], borderRadius: radius.md }}
        >
          <Icon name="share-outline" size={20} color={c.yapi} />
          <Text style={{ color: c.yapi, fontWeight: '700' }}>{t('m.drops.share')}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
