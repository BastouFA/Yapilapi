import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { LatLng } from '../../../../packages/shared/src/location';
import { LAUNCH_CITIES, type LaunchCityKey, type StashCard, type StashExplorerRow } from '../../../../packages/shared/src/stash';
import { client, errorMessage } from '../../lib/api';
import { readHere } from '../../lib/city-map';
import { useFlag } from '../../lib/flags';
import { useT } from '../../lib/i18n';
import { StashRow, StashSettingsRows } from '../../lib/stash';
import { space } from '../../lib/theme';
import { Avatar, Button, EmptyState, Notice, Segmented, useColors } from '../../lib/ui';

/**
 * The Stash screen (docs/product/stash.md): stashes near you (by their area), hide one, this month's
 * top explorers in a launch city, the stashes you hid and found, and your stash settings.
 */
export default function StashHome() {
  const c = useColors();
  const { t, tp } = useT();
  const on = useFlag('STASH') !== false;
  const [from, setFrom] = useState<LatLng | null>(null);
  const [near, setNear] = useState<{ stash: StashCard; metres: number | null }[] | null>(null);
  const [mine, setMine] = useState<{ hidden: StashCard[]; found: StashCard[] } | null>(null);
  const [tab, setTab] = useState<'found' | 'hidden'>('found');
  const [city, setCity] = useState<LaunchCityKey>('lagos');
  const [explorers, setExplorers] = useState<StashExplorerRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Where to look: here when location was allowed before, else the profile's city, else Lagos.
  useEffect(() => {
    void (async () => {
      const api = await client();
      api.stash.mine().then(setMine, () => {});
      try {
        setFrom(await readHere(false));
        return;
      } catch {
        // Not allowed before: no prompt here.
      }
      const r = await api.map.center().catch(() => null);
      setFrom(r?.center?.center ?? LAUNCH_CITIES[0].center);
    })();
  }, []);
  useEffect(() => {
    if (!from) return;
    void client()
      .then((api) => api.stash.near(from))
      .then(
        (r) => setNear(r.items),
        (e) => setProblem(errorMessage(e)),
      );
  }, [from]);
  useEffect(() => {
    setExplorers(null);
    void client()
      .then((api) => api.stash.explorers(city))
      .then(
        (r) => setExplorers(r.items),
        () => setExplorers([]),
      );
  }, [city]);

  if (!on) return <EmptyState title={t('stash.title')} icon="gift-outline" />;
  const cityName = LAUNCH_CITIES.find((x) => x.key === city)!.name;
  const header = (text: string) => (
    <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 18, fontWeight: '800' }}>
      {text}
    </Text>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.ground }} contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}>
      <Text style={{ color: c.inkMuted, fontSize: 15, lineHeight: 22 }}>{t('stash.hint')}</Text>
      <Button label={t('stash.hide')} icon="gift-outline" onPress={() => router.push('/stash/new')} />

      <View style={{ gap: space[2] }}>
        {header(t('stash.near'))}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[2] }}>
          <Text style={{ color: c.inkMuted }}>{t('near.pickCity')}</Text>
          {LAUNCH_CITIES.map((x) => (
            <Button key={x.key} label={x.name} size="sm" variant="ghost" onPress={() => setFrom(x.center)} />
          ))}
        </View>
        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        {near && !near.length ? <Text style={{ color: c.inkMuted }}>{t('stash.nearEmpty')}</Text> : null}
        {near?.map((n) => (
          <StashRow key={n.stash.id} stash={n.stash} metres={n.metres} />
        ))}
      </View>

      <View style={{ gap: space[2] }}>
        {header(t('stash.explorers', { city: cityName }))}
        <Segmented options={LAUNCH_CITIES.map((x) => ({ id: x.key, label: x.name }))} value={city} onChange={setCity} label={t('near.pickCity')} />
        {explorers && !explorers.length ? <Text style={{ color: c.inkMuted }}>{t('stash.explorersEmpty')}</Text> : null}
        {explorers?.map((x) => (
          <View key={x.user.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}>
            <Avatar name={x.user.displayName} url={x.user.avatarUrl} size={36} />
            <Text style={{ flex: 1, color: c.ink, fontWeight: '700' }} onPress={() => router.push(`/u/${x.user.username}`)}>
              {x.user.displayName}
            </Text>
            <Text style={{ color: c.inkMuted }}>{tp('stash.explorerFinds', x.finds)}</Text>
          </View>
        ))}
      </View>

      <View style={{ gap: space[2] }}>
        <Segmented
          options={[
            { id: 'found', label: t('stash.found') },
            { id: 'hidden', label: t('stash.mine') },
          ]}
          value={tab}
          onChange={setTab}
          label={t('stash.title')}
        />
        {(mine?.[tab] ?? []).map((s) => (
          <StashRow key={s.id} stash={s} />
        ))}
      </View>

      <View style={{ gap: space[2] }}>
        {header(t('settings.title'))}
        <StashSettingsRows />
      </View>
    </ScrollView>
  );
}
