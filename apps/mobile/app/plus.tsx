import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { InvitesInfo, PlusInfo } from '../../../packages/api-client/src/index';
import { formatMoney } from '../../../packages/shared/src/i18n';
import { client, errorMessage } from '../lib/api';
import { SectionHeader } from '../lib/chips';
import { useT } from '../lib/i18n';
import { openOnWeb } from '../lib/money';
import { useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { Button, Card, Icon, Loading, Notice, PlusBadge, useColors, type IconName } from '../lib/ui';

const ICON: Record<PlusInfo['benefits'][number]['id'], IconName> = {
  no_ads: 'shield-checkmark-outline',
  long_reels: 'film-outline',
  big_uploads: 'cloud-upload-outline',
  badge: 'sparkles-outline',
};

/**
 * YAPILAPI Plus (apps/web/app/(app)/plus): what it gives, what it costs, whether you have it and
 * until when, and how close your invites are to a free month. Paying happens in the web checkout,
 * opened in the browser: the app never sees card details. Coming back to the app shows the new end
 * date as soon as the payment is confirmed.
 */
export default function PlusScreen() {
  const c = useColors();
  const { t, locale, date } = useT();
  const { me, refresh } = useSession();
  const [info, setInfo] = useState<PlusInfo | null | undefined>(undefined);
  const [invites, setInvites] = useState<InvitesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const api = await client();
      setInfo(await api.plus.get());
      setError(null);
      if (me) api.invites.mine().then(setInvites, () => {});
    } catch (e) {
      setInfo((cur) => cur ?? null);
      setError(errorMessage(e));
    }
  }, [me]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  // Back from the browser's checkout: look again, and refresh the badge on your profile.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && opened) {
        void load();
        void refresh();
      }
    });
    return () => sub.remove();
  }, [opened, load, refresh]);

  if (info === undefined) return <Loading />;
  if (info === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice tone="danger">{error}</Notice>
      </View>
    );

  const price = formatMoney(info.priceCents, info.currency, locale);
  const long = (iso: string) => date(iso, { dateStyle: 'long' });
  const status = info.status;
  const benefit = (b: PlusInfo['benefits'][number]) => {
    switch (b.id) {
      case 'no_ads':
        return { title: t('plus.benefit.noAds'), body: t('plus.benefit.noAds.body') };
      case 'long_reels':
        return { title: t('plus.benefit.longReels'), body: t('plus.benefit.longReels.body', { minutes: b.minutes, standard: b.standardMinutes }) };
      case 'big_uploads':
        return { title: t('plus.benefit.bigUploads'), body: t('plus.benefit.bigUploads.body', { size: b.megabytes, standard: b.standardMegabytes }) };
      case 'badge':
        return { title: t('plus.benefit.badge'), body: t('plus.benefit.badge.body') };
    }
  };
  const reward = invites?.reward;
  const done = invites && reward ? (invites.toNextReward === null ? reward.perPeople : reward.perPeople - invites.toNextReward) : 0;

  return (
    <ScrollView
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
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }}>
          {t('plus.title')}
        </Text>
        <PlusBadge />
      </View>
      <Text style={{ color: c.ink, fontSize: 15, lineHeight: 22 }}>{t('plus.intro')}</Text>
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Card style={{ gap: space[3] }}>
        <Text style={{ color: c.ink, fontSize: 18, fontWeight: '800' }}>{t('plus.price', { price })}</Text>
        <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('plus.noRenew')}</Text>
        {status?.active && status.until ? (
          <Notice title={t('plus.status.active', { date: long(status.until) })}>{t('plus.status.ends')}</Notice>
        ) : (
          <Text style={{ color: c.ink }}>{status ? t('plus.status.none') : t('m.plus.signIn')}</Text>
        )}
        {!status ? null : !status.canExtend ? (
          <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('plus.maxed')}</Text>
        ) : (
          <View style={{ gap: space[2] }}>
            <Button
              label={status.active ? t('plus.extend', { price }) : t('plus.buy', { price })}
              icon="open-outline"
              onPress={() => {
                setOpened(true);
                void openOnWeb('/plus');
              }}
            />
            <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.plus.onWeb')}</Text>
          </View>
        )}
        {opened ? (
          <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13 }}>
            {t('m.plus.afterPaying')}
          </Text>
        ) : null}
      </Card>

      <View style={{ gap: space[2] }}>
        <SectionHeader title={t('plus.benefits.title')} />
        <Card style={{ gap: space[4] }}>
          {info.benefits.map((b) => {
            const text = benefit(b);
            return (
              <View key={b.id} accessible style={{ flexDirection: 'row', gap: space[3], alignItems: 'flex-start' }}>
                <View
                  style={{ width: 36, height: 36, borderRadius: radius.md, backgroundColor: c.saffronSoft, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name={ICON[b.id]} size={20} color={c.ink} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>{text.title}</Text>
                  <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{text.body}</Text>
                </View>
              </View>
            );
          })}
        </Card>
      </View>

      {me ? (
        <View style={{ gap: space[2] }}>
          <SectionHeader title={t('m.plus.invites')} action={{ label: t('invite.title'), onPress: () => router.push('/invite') }} />
          <Card style={{ gap: space[2] }}>
            <Text style={{ color: c.ink, lineHeight: 20 }}>{t('plus.inviteHint')}</Text>
            {invites && reward ? (
              <>
                <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>
                  {t('invite.reward', { count: reward.perPeople, days: reward.days, max: reward.max })}
                </Text>
                {invites.toNextReward === null ? (
                  <Text style={{ color: c.ink }}>{t('invite.maxed')}</Text>
                ) : (
                  <View style={{ gap: space[1] }}>
                    <Text style={{ color: c.ink, fontWeight: '600' }}>{t('invite.progress', { done, total: reward.perPeople })}</Text>
                    <View
                      accessible
                      accessibilityRole="progressbar"
                      accessibilityLabel={t('invite.progress', { done, total: reward.perPeople })}
                      accessibilityValue={{ min: 0, max: reward.perPeople, now: done }}
                      style={{ height: 8, borderRadius: 4, backgroundColor: c.surfaceSunken, overflow: 'hidden' }}
                    >
                      <View style={{ width: `${Math.round((done / reward.perPeople) * 100)}%`, height: '100%', backgroundColor: c.yapi }} />
                    </View>
                  </View>
                )}
                <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('invite.earned', { count: reward.earned })}</Text>
              </>
            ) : null}
            <Button
              label={t('invite.share')}
              variant="secondary"
              size="sm"
              icon="share-outline"
              style={{ alignSelf: 'flex-start' }}
              onPress={() => router.push('/invite')}
            />
          </Card>
        </View>
      ) : null}

      {info.history.length ? (
        <View style={{ gap: space[2] }}>
          <SectionHeader title={t('plus.history')} />
          <Card style={{ gap: space[3] }}>
            {info.history.map((h) => (
              <View key={h.createdAt + h.source} accessible style={{ gap: 2 }}>
                <Text style={{ color: c.ink, fontWeight: '600' }}>
                  {h.source === 'purchase' ? t('plus.history.purchase', { days: h.days }) : t('plus.history.referral', { days: h.days })}
                </Text>
                <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.plus.range', { start: long(h.startsAt), end: long(h.endsAt) })}</Text>
              </View>
            ))}
          </Card>
        </View>
      ) : null}
    </ScrollView>
  );
}
