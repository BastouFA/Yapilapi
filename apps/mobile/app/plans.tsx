import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import type { Profile } from '../../../packages/shared/src/types';
import { client, errorMessage, isGone } from '../lib/api';
import { useFlag } from '../lib/flags';
import { useT } from '../lib/i18n';
import { PlanList, usePlans, useWebCheckout, webCheckout } from '../lib/money';
import { ManagedOnWeb, useDigitalPurchases } from '../lib/store';
import { space } from '../lib/theme';
import { Avatar, Button, Card, EmptyState, Loading, Notice, ScreenError, useColors, userText } from '../lib/ui';

/**
 * A creator's plans (`plans?username=`, and web links to /u/<name>?subscribe=1): each plan's
 * price and perks, and whether you're subscribed. Subscribing and tipping are paid on the web;
 * coming back shows the new subscription. Where the app store rules don't allow a link out
 * (lib/store.tsx), prices and buttons are left out.
 */
export default function PlansScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const c = useColors();
  const { t } = useT();
  const commerce = useFlag('COMMERCE');
  const offer = useDigitalPurchases();
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  // Why the profile couldn't load, when that isn't because it's gone or private.
  const [profileError, setProfileError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadProfile = useCallback(() => {
    setProfileError(null);
    void client()
      .then((api) => api.users.get(username))
      .then(
        (r) => setProfile(r.profile),
        (e) => (isGone(e) ? setProfile(null) : setProfileError(errorMessage(e))),
      );
  }, [username]);
  useEffect(() => {
    loadProfile();
  }, [loadProfile]);
  const { data, loadError, load } = usePlans(profile?.id);
  const { open, opened } = useWebCheckout(() => void load());

  if (profile === undefined && profileError) return <ScreenError message={profileError} onRetry={loadProfile} />;
  if (profile && data === undefined && loadError) return <ScreenError message={loadError} onRetry={load} />;
  if (profile === undefined || (profile && data === undefined)) return <Loading />;
  if (profile === null || data === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.post.unavailable.title')} />
      </View>
    );
  const self = profile.relationship.isSelf;
  const sub = data!.mySubscription;

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
      <Card onPress={() => router.push(`/u/${profile.username}`)} label={t('m.title.profile') + ': ' + profile.displayName}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
          <Avatar name={profile.displayName} url={profile.avatarUrl} size={48} />
          <View style={{ flex: 1 }}>
            <Text accessibilityRole="header" style={[{ color: c.ink, fontWeight: '800', fontSize: 18 }, userText]}>
              {t('m.money.supportTitle', { name: profile.displayName })}
            </Text>
            <Text style={[{ color: c.inkMuted }, userText]}>@{profile.username}</Text>
          </View>
        </View>
      </Card>
      {commerce === false ? <Notice>{t('shop.unavailable')}</Notice> : null}
      <Text style={{ color: c.ink, lineHeight: 22 }}>{t('m.money.plansIntro')}</Text>
      {data!.items.length ? (
        <PlanList plans={data!.items} mine={sub} hidePrices={offer !== 'link'} />
      ) : (
        <EmptyState title={t('m.money.noPlans', { name: profile.displayName })} />
      )}
      {self || commerce === false ? null : offer !== 'link' ? (
        <ManagedOnWeb text={t('m.store.support')} />
      ) : (
        <View style={{ gap: space[2] }}>
          {data!.items.length && !sub ? (
            <Button label={t('m.money.subscribeOnWeb')} icon="open-outline" onPress={() => open(webCheckout.subscribe(profile.username))} />
          ) : null}
          <Button label={t('m.money.tip')} variant="secondary" icon="cash-outline" onPress={() => open(webCheckout.tip(profile.username))} />
          <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>
            {opened ? t('m.money.afterSubscribing') : `${t('m.money.fee')} ${t('m.shop.onWeb')}`}
          </Text>
        </View>
      )}
    </ScrollView>
  );
}
