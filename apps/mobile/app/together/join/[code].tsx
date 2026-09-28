import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { TogetherInvitePreview } from '../../../../../packages/shared/src/together';
import { client, errorMessage, isGone } from '../../../lib/api';
import { useFlag } from '../../../lib/flags';
import { useT } from '../../../lib/i18n';
import { radius, space } from '../../../lib/theme';
import { Avatar, Button, Card, EmptyState, Icon, Loading, Notice, ScreenError, useColors, userText } from '../../../lib/ui';

/**
 * An invite link to a Together album (or its QR code at the event): what it is and who hosts
 * it, and a way to ask to join. Nothing in it shows until a host lets you in.
 */
export default function JoinTogether() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const c = useColors();
  const { t, tp } = useT();
  const on = useFlag('REAL_TOGETHER');
  const [invite, setInvite] = useState<TogetherInvitePreview | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Why it couldn't load, when that isn't because the invite is gone.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    void client()
      .then((api) => api.together.invite(code))
      .then(
        (r) => setInvite(r.invite),
        (e) => (isGone(e) ? setInvite(null) : setLoadError(errorMessage(e))),
      );
  }, [code]);
  useEffect(() => {
    if (on) load();
  }, [load, on]);

  if (on && invite === undefined && loadError) return <ScreenError message={loadError} onRetry={load} />;
  if (on === undefined || (on && invite === undefined)) return <Loading />;
  if (!on)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('together.off')} />
      </View>
    );
  if (!invite)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <Stack.Screen options={{ title: t('together.join.title') }} />
        <EmptyState title={t('together.join.missing')} body={t('together.join.missingBody')} />
      </View>
    );

  return (
    <ScrollView style={{ backgroundColor: c.ground }} contentContainerStyle={{ padding: space[4], gap: space[4] }}>
      <Stack.Screen options={{ title: t('together.join.title') }} />
      <Card style={{ alignItems: 'center', gap: space[3], padding: space[6] }}>
        <View style={{ width: 88, height: 88, borderRadius: radius.md, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="images-outline" size={36} color={c.yapi} />
        </View>
        <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 24, fontWeight: '800', textAlign: 'center' }, userText]}>
          {invite.title}
        </Text>
        {invite.description ? <Text style={[{ color: c.ink, textAlign: 'center', lineHeight: 20 }, userText]}>{invite.description}</Text> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <Avatar name={invite.host.displayName} url={invite.host.avatarUrl} size={28} />
          <Text style={[{ color: c.ink, fontWeight: '700' }, userText]}>{t('together.join.by', { name: invite.host.displayName })}</Text>
        </View>
        <Text style={{ color: c.inkMuted }}>
          {tp('together.people', invite.memberCount)} · {tp('together.items', invite.itemCount)}
        </Text>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {invite.state === 'member' ? (
          <Button label={t('together.join.open')} onPress={() => router.replace(`/together/${invite.id}`)} />
        ) : invite.state === 'requested' ? (
          <Text accessibilityLiveRegion="polite" style={{ color: c.ink, textAlign: 'center', lineHeight: 20 }}>
            {t('together.join.requested')}
          </Text>
        ) : invite.state === 'declined' ? (
          <Text style={{ color: c.inkMuted, textAlign: 'center' }}>{t('together.join.declined')}</Text>
        ) : (
          <>
            <Button
              label={t('together.join.ask')}
              onPress={async () => {
                setError(null);
                try {
                  setInvite((await (await client()).together.requestToJoin(code)).invite);
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
            <Text style={{ color: c.inkMuted, textAlign: 'center', fontSize: 13 }}>{t('together.join.privacy')}</Text>
          </>
        )}
      </Card>
    </ScrollView>
  );
}
