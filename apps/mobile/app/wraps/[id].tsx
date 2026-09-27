import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError } from '../../../../packages/api-client/src/index';
import type { WeeklyWrap } from '../../../../packages/shared/src/wrap';
import { client, errorMessage } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { space } from '../../lib/theme';
import { Button, EmptyState, ErrorState, Loading, Notice, useColors } from '../../lib/ui';
import { shareWrapCard, WrapCardImage, WrapSections, WrapStats, wrapDate } from '../../lib/wrap';

/**
 * One weekly wrap: the card image (share it if you like), then the week's moment, best posts,
 * new friends, communities, events, places and songs (only the parts with something in them).
 * Private to you; it can be deleted.
 */
export default function WrapScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, date } = useT();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [wrap, setWrap] = useState<WeeklyWrap | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setWrap((await (await client()).wraps.get(id)).wrap);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setGone(true);
      else setError(errorMessage(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: t('wrap.title') });
  }, [navigation, t]);

  async function share() {
    setNote(null);
    try {
      await shareWrapCard(id, t('wrap.share'));
    } catch (e) {
      setNote(errorMessage(e));
    }
  }

  function remove() {
    Alert.alert(t('wrap.deleteConfirm'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('wrap.delete'),
        style: 'destructive',
        onPress: () =>
          void (async () => {
            try {
              await (await client()).wraps.remove(id);
              if (router.canGoBack()) router.back();
              else router.replace('/wraps');
            } catch (e) {
              setNote(errorMessage(e));
            }
          })(),
      },
    ]);
  }

  if (gone)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState icon="sparkles-outline" title={t('wrap.notFound')} action={{ label: t('wrap.past'), onPress: () => router.replace('/wraps') }} />
      </View>
    );
  if (error && !wrap)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <ErrorState message={error} onRetry={load} />
      </View>
    );
  if (!wrap) return <Loading />;

  return (
    <ScrollView style={{ backgroundColor: c.ground }} contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: insets.bottom + space[6] }}>
      <View style={{ gap: 2 }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 22, fontWeight: '800', letterSpacing: -0.3 }}>
          {t('wrap.title')}
        </Text>
        <Text style={{ color: c.inkMuted, fontSize: 14 }}>{t('wrap.dates', { start: wrapDate(date, wrap.weekStart), end: wrapDate(date, wrap.weekEnd) })}</Text>
      </View>
      <Notice>{t('wrap.private')}</Notice>
      <WrapCardImage id={wrap.id} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        <Button label={t('wrap.share')} icon="share-outline" onPress={share} />
      </View>
      {note ? <Notice tone="danger">{note}</Notice> : null}
      <WrapStats counts={wrap.counts} />
      <WrapSections wrap={wrap} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2], marginTop: space[2] }}>
        <Button label={t('wrap.past')} variant="secondary" size="sm" icon="albums-outline" onPress={() => router.push('/wraps')} />
        <Button label={t('wrap.delete')} variant="ghost" size="sm" icon="trash-outline" onPress={remove} />
      </View>
    </ScrollView>
  );
}
