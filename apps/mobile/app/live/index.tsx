import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import type { LiveSummary } from '../../../../packages/api-client/src/index';
import { client, errorMessage } from '../../lib/api';
import { useFlag } from '../../lib/flags';
import { useT } from '../../lib/i18n';
import { openOnWeb } from '../../lib/money';
import { space } from '../../lib/theme';
import { Avatar, Button, Card, EmptyState, ErrorState, Icon, Loading, Notice, Pill, useColors, userText } from '../../lib/ui';

/**
 * Live: who's live now, and lives coming up, from people you can see. Watching happens here;
 * going live needs streaming software on a computer, so that's on the web. Behind the LIVE flag.
 */
export default function LiveList() {
  const c = useColors();
  const { t } = useT();
  const on = useFlag('LIVE');
  const [items, setItems] = useState<LiveSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await (await client()).live.list()).items);
      setError(null);
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
        <EmptyState title={t('m.live.off')} />
      </View>
    );

  const now = items?.filter((l) => l.status === 'live') ?? [];
  const soon = items?.filter((l) => l.status === 'scheduled') ?? [];

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
      {items === null ? (
        <Loading />
      ) : (
        <>
          <Section title={t('m.live.now')}>{now.length ? now.map((l) => <LiveRow key={l.id} live={l} />) : <EmptyState title={t('m.live.empty')} />}</Section>
          {soon.length ? (
            <Section title={t('m.live.comingUp')}>
              {soon.map((l) => (
                <LiveRow key={l.id} live={l} />
              ))}
            </Section>
          ) : null}
        </>
      )}
      <Notice title={t('m.live.goLiveTitle')}>
        <Text style={{ color: c.ink, lineHeight: 20 }}>{t('m.live.fromComputer')}</Text>
        <Button
          label={t('m.live.setUpOnWeb')}
          icon="open-outline"
          size="sm"
          variant="secondary"
          onPress={() => openOnWeb('/live')}
          style={{ alignSelf: 'flex-start', marginTop: space[1] }}
        />
      </Notice>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ gap: space[2] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function LiveRow({ live: l }: { live: LiveSummary }) {
  const c = useColors();
  const { t, tp, dateTime } = useT();
  const status = l.status === 'live' ? tp('m.live.watching', l.viewers) : t('m.live.scheduled');
  const when = l.status === 'scheduled' && l.scheduledFor ? dateTime(l.scheduledFor) : null;
  return (
    <Card
      onPress={() => router.push(`/live/${l.id}`)}
      label={[l.title, l.host.displayName, status, l.ticket ? t('m.live.ticketed') : null].filter(Boolean).join(', ')}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], padding: space[3] }}
    >
      <Avatar name={l.host.displayName} url={l.host.avatarUrl} size={44} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 15 }, userText]} numberOfLines={2}>
          {l.title}
        </Text>
        <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
          {[l.host.displayName, when].filter(Boolean).join(' · ')}
        </Text>
        {l.ticket ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon name="ticket-outline" size={14} color={c.inkMuted} />
            <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('m.live.ticketed')}</Text>
          </View>
        ) : null}
      </View>
      <Pill text={l.status === 'live' ? t('m.live.badge', { count: l.viewers }) : t('m.live.scheduled')} tone={l.status === 'live' ? 'live' : 'neutral'} />
    </Card>
  );
}
