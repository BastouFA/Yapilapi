import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Platform, ScrollView, Share, Text, View } from 'react-native';
import type { InvitesInfo } from '../../../packages/api-client/src/index';
import { client, errorMessage, webUrl } from '../lib/api';
import { useT } from '../lib/i18n';
import { radius, space } from '../lib/theme';
import { Avatar, Button, Card, EmptyState, Loading, Notice, useColors, userText } from '../lib/ui';

/** Your invite link, with sharing, how many friends joined, and progress to the next free month of Plus. */
export default function InviteScreen() {
  const c = useColors();
  const { t } = useT();
  const [info, setInfo] = useState<InvitesInfo | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => setInfo(await (await client()).invites.mine()))().catch((e) => (setInfo(null), setError(errorMessage(e))));
  }, []);

  if (info === undefined) return <Loading />;
  if (info === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice tone="danger">{error}</Notice>
      </View>
    );

  const { reward } = info;
  const done = info.toNextReward === null ? reward.perPeople : reward.perPeople - info.toNextReward;
  const share = async () => {
    const message = t('invite.shareText');
    try {
      await Share.share(Platform.OS === 'ios' ? { url: info.link, message } : { message: `${message}\n${info.link}`, title: message });
    } catch {
      // The person closed the share sheet.
    }
  };

  return (
    <ScrollView style={{ backgroundColor: c.ground }} contentContainerStyle={{ padding: space[4], gap: space[3] }}>
      <Text style={{ color: c.inkMuted, fontSize: 15, lineHeight: 21 }}>{t('invite.intro')}</Text>
      <Card style={{ gap: space[3] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
          {t('invite.yourLink')}
        </Text>
        <Text selectable style={{ color: c.ink, fontSize: 15, backgroundColor: c.surfaceSunken, padding: space[3], borderRadius: radius.md }}>
          {info.link}
        </Text>
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('invite.code', { code: info.code })}</Text>
        <Button label={t('invite.share')} icon="share-outline" onPress={share} />
      </Card>

      <Card style={{ gap: space[2] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
          {t('plus.title')}
        </Text>
        <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>
          {t('invite.reward', { count: reward.perPeople, days: reward.days, max: reward.max })}
        </Text>
        {info.toNextReward === null ? (
          <Text style={{ color: c.ink, fontSize: 14 }}>{t('invite.maxed')}</Text>
        ) : (
          <View style={{ gap: space[1] }}>
            <Text style={{ color: c.ink, fontSize: 14, fontWeight: '600' }}>{t('invite.progress', { done, total: reward.perPeople })}</Text>
            <View
              accessible
              accessibilityRole="progressbar"
              accessibilityValue={{ min: 0, max: reward.perPeople, now: done }}
              style={{ height: 8, borderRadius: 4, backgroundColor: c.surfaceSunken, overflow: 'hidden' }}
            >
              <View style={{ width: `${Math.round((done / reward.perPeople) * 100)}%`, height: '100%', backgroundColor: c.yapi }} />
            </View>
          </View>
        )}
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>
          {t('invite.stats', { joined: info.joined, confirmed: info.confirmed })} · {t('invite.earned', { count: reward.earned })}
        </Text>
        <Button label={t('plus.open')} variant="secondary" size="sm" onPress={() => void Linking.openURL(`${webUrl}/plus`)} />
      </Card>

      <Card style={{ gap: space[3] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
          {t('invite.people')}
        </Text>
        {info.people.length ? (
          info.people.map((p) => (
            <View key={p.user.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
              <Avatar name={p.user.displayName} url={p.user.avatarUrl} size={36} />
              <View style={{ flex: 1 }}>
                <Text
                  accessibilityRole="link"
                  onPress={() => router.push(`/u/${p.user.username}`)}
                  style={[{ color: c.ink, fontWeight: '700' }, userText]}
                  numberOfLines={1}
                >
                  {p.user.displayName}
                </Text>
                <Text style={{ color: c.inkMuted, fontSize: 12 }}>{p.confirmed ? t('invite.confirmed') : t('invite.pending')}</Text>
              </View>
            </View>
          ))
        ) : (
          <EmptyState title={t('invite.empty')} />
        )}
      </Card>
    </ScrollView>
  );
}
