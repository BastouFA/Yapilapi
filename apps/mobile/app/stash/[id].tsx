import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { MAP_DEFAULT_ZOOM, mapDistance, type MapItem } from '../../../../packages/shared/src/city-map';
import { distanceMetres, type LatLng } from '../../../../packages/shared/src/location';
import {
  STASH_AUDIENCE_KEYS,
  STASH_KIND_KEYS,
  STASH_REACTIONS,
  STASH_REACTION_KEYS,
  STASH_THANKS_MAX,
  type StashCard,
  type StashFind,
  type StashReaction,
} from '../../../../packages/shared/src/stash';
import { client, errorMessage, isGone } from '../../lib/api';
import { CityMapView } from '../../lib/city-map';
import { useFlag } from '../../lib/flags';
import { useT } from '../../lib/i18n';
import { useReport } from '../../lib/report';
import { StashInside, hiddenBy, readPrecise, useWhereProblem, type Position } from '../../lib/stash';
import { radius, space } from '../../lib/theme';
import { Avatar, Button, EmptyState, ErrorState, Loading, Notice, Pill, useColors, userText } from '../../lib/ui';

const REACTION_ICONS = { thanks: 'heart-outline', love: 'heart', laugh: 'happy-outline', wow: 'star-outline' } as const;

/**
 * A stash (docs/product/stash.md): its area on a small map (never the spot), title, hint and who
 * hid it, and "Open it here", which reads where the phone is now (after the tap) and sends it.
 * Opened: what's inside and a thank-you. Yours: your spot, who it's for, who found it, take it back.
 */
export default function StashScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, tp, locale } = useT();
  const win = useWindowDimensions();
  const on = useFlag('STASH') !== false;
  const where = useWhereProblem();
  const report = useReport();
  const [stash, setStash] = useState<StashCard | null>(null);
  const [finds, setFinds] = useState<StashFind[]>([]);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [center, setCenter] = useState<LatLng | null>(null);
  const [zoom, setZoom] = useState(MAP_DEFAULT_ZOOM + 3);
  const [size, setSize] = useState({ width: win.width - space[4] * 2, height: 220 });
  const [pos, setPos] = useState<Position | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [reaction, setReaction] = useState<StashReaction | null>(null);
  const [thanks, setThanks] = useState('');
  const [thanked, setThanked] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    void client()
      .then((api) => api.stash.get(id))
      .then(
        (r) => {
          setStash(r.stash);
          setFinds(r.finds);
          setCenter((cur) => cur ?? r.stash.area.center);
        },
        (e) => (isGone(e) ? setMissing(true) : setLoadError(errorMessage(e))),
      );
  }, [id]);
  useEffect(load, [load]);

  if (!on || missing) return <EmptyState title={t('stash.ended')} icon="gift-outline" />;
  if (loadError) return <ErrorState message={loadError} onRetry={load} />;
  if (!stash || !center) return <Loading />;

  async function open() {
    setOpening(true);
    setNote(null);
    try {
      const p = await readPrecise();
      setPos(p);
      const r = await (await client()).stash.open(id, p);
      setStash(r.stash);
      if (!r.opened)
        setNote(
          r.toGoMetres
            ? t('stash.toGo', { distance: mapDistance(t, r.toGoMetres, locale) ?? t('location.distance.m', { n: r.toGoMetres }) })
            : t('stash.keepLooking'),
        );
    } catch (e) {
      setNote(e === 'denied' || e === 'unavailable' ? where(e) : errorMessage(e));
    } finally {
      setOpening(false);
    }
  }

  async function sendThanks() {
    try {
      await (await client()).stash.thank(id, { reaction: reaction ?? undefined, text: thanks.trim() || undefined });
      setThanked(true);
    } catch (e) {
      setNote(errorMessage(e));
    }
  }

  function takeBack() {
    Alert.alert(t('stash.takeBack'), t('stash.takeBackConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('stash.takeBack'),
        style: 'destructive',
        onPress: () =>
          void client()
            .then((api) => api.stash.takeBack(id))
            .then(
              () => (router.canGoBack() ? router.back() : router.replace('/stash')),
              (e) => setNote(errorMessage(e)),
            ),
      },
    ]);
  }

  const area: MapItem = {
    key: `stashes:${stash.id}`,
    layer: 'stashes',
    title: stash.title ?? '',
    subtitle: stash.hint,
    point: stash.area.center,
    approximate: true,
    at: stash.createdAt,
    endsAt: stash.expiresAt,
    thumbUrl: null,
    count: stash.finds,
    user: stash.owner,
    target: { kind: 'stash', id: stash.id },
  };
  const away = pos ? mapDistance(t, distanceMetres(pos, stash.area.center), locale) : null;
  const meta = [hiddenBy(t, stash), stash.city, stash.finds ? tp('stash.finds', stash.finds) : null].filter(Boolean).join(' · ');
  const unavailable = stash.ended || (stash.taken && !stash.found);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.ground }} contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[8] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 24, fontWeight: '800' }}>
        {stash.title || t('stash.untitled')}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        <Pill text={t(STASH_KIND_KEYS[stash.kind])} />
        {stash.firstOnly ? <Pill text={t('stash.firstOnly')} /> : null}
        {stash.mine ? <Pill text={t(STASH_AUDIENCE_KEYS[stash.audience])} /> : null}
        {stash.expiresAt ? (
          <Pill text={t('stash.until', { date: new Date(stash.expiresAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) })} />
        ) : null}
      </View>
      <Text style={{ color: c.inkMuted, fontSize: 14 }}>{meta}</Text>
      {stash.hint ? <Text style={{ color: c.ink, fontSize: 17, lineHeight: 24 }}>{stash.hint}</Text> : null}

      <View style={{ height: 220, borderRadius: radius.lg, overflow: 'hidden' }}>
        <CityMapView
          center={center}
          zoom={zoom}
          size={size}
          items={[area]}
          here={pos}
          selected={null}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            if (width && height) setSize({ width: Math.round(width), height: Math.round(height) });
          }}
          onMove={setCenter}
          onZoom={setZoom}
          onSelect={() => {}}
          onLocate={() => setCenter(stash.area.center)}
        />
      </View>
      <Text style={{ color: c.inkMuted, fontSize: 13 }}>
        {[away ? t('stash.away', { distance: away }) : null, t('stash.areaNote')].filter(Boolean).join(' · ')}
      </Text>

      {stash.mine ? (
        <View style={{ gap: space[3] }}>
          {stash.moderation && stash.moderation !== 'normal' ? <Notice tone="warn">{t('stash.held')}</Notice> : null}
          {stash.point ? (
            <Text style={{ color: c.inkMuted }}>{t('stash.yourSpot', { point: `${stash.point.lat.toFixed(5)}, ${stash.point.lng.toFixed(5)}` })}</Text>
          ) : null}
          {stash.recipient ? <Text style={{ color: c.ink }}>{t('stash.for', { name: stash.recipient.displayName })}</Text> : null}
          {stash.squad ? <Text style={{ color: c.ink }}>{t('stash.for', { name: stash.squad.name })}</Text> : null}
          {stash.content ? <StashInside content={stash.content} own /> : null}
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 18, fontWeight: '800' }}>
            {t('stash.whoFound')}
          </Text>
          {finds.length ? (
            finds.map((f) => (
              <View key={f.finder.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
                <Avatar name={f.finder.displayName} url={f.finder.avatarUrl} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.ink, fontWeight: '700' }}>{f.finder.displayName}</Text>
                  {f.reaction || f.thanks ? (
                    <Text style={{ color: c.inkMuted }}>{[f.reaction ? t(STASH_REACTION_KEYS[f.reaction]) : null, f.thanks].filter(Boolean).join(' · ')}</Text>
                  ) : null}
                </View>
              </View>
            ))
          ) : (
            <Text style={{ color: c.inkMuted }}>{tp('stash.finds', 0)}</Text>
          )}
          {!stash.ended ? <Button label={t('stash.takeBack')} variant="ghost" onPress={takeBack} /> : null}
        </View>
      ) : stash.found && stash.content ? (
        <View style={{ gap: space[3] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 18, fontWeight: '800' }}>
            {t('stash.opened')}
          </Text>
          <StashInside content={stash.content} />
          {stash.owner && !thanked ? (
            <View style={{ gap: space[2] }}>
              <Text style={{ color: c.ink, fontWeight: '700' }}>{t('stash.thank')}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
                {STASH_REACTIONS.map((r) => (
                  <Button
                    key={r}
                    label={t(STASH_REACTION_KEYS[r])}
                    icon={REACTION_ICONS[r]}
                    size="sm"
                    variant={reaction === r ? 'primary' : 'secondary'}
                    onPress={() => setReaction(reaction === r ? null : r)}
                  />
                ))}
              </View>
              <TextInput
                accessibilityLabel={t('stash.thanksPlaceholder')}
                placeholder={t('stash.thanksPlaceholder')}
                placeholderTextColor={c.inkMuted}
                value={thanks}
                maxLength={STASH_THANKS_MAX}
                onChangeText={setThanks}
                style={[
                  {
                    minHeight: 44,
                    borderWidth: 1,
                    borderColor: c.line,
                    borderRadius: radius.md,
                    paddingHorizontal: space[3],
                    color: c.ink,
                    backgroundColor: c.surface,
                  },
                  userText,
                ]}
              />
              <Button label={t('stash.thank')} disabled={!reaction && !thanks.trim()} onPress={() => sendThanks()} />
            </View>
          ) : thanked ? (
            <Notice>{t('stash.thanked')}</Notice>
          ) : null}
        </View>
      ) : unavailable ? (
        <Notice>{stash.ended ? t('stash.ended') : t('stash.taken')}</Notice>
      ) : (
        <View style={{ gap: space[2] }}>
          <Button label={opening ? t('location.locating') : t('stash.open')} icon="locate-outline" disabled={opening} onPress={() => open()} />
          {pos ? <Text style={{ color: c.inkMuted }}>{t('stash.form.accuracy', { n: pos.accuracy })}</Text> : null}
        </View>
      )}
      {note ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: c.ink, fontSize: 15, padding: space[3], borderRadius: radius.md, backgroundColor: c.surfaceSunken }}
        >
          {note}
        </Text>
      ) : null}

      {!stash.mine ? (
        <Button
          label={t('post.report')}
          icon="flag-outline"
          variant="ghost"
          size="sm"
          style={{ alignSelf: 'flex-start' }}
          onPress={() => report.open({ type: 'stash', id: stash.id })}
        />
      ) : null}
      {report.sheet}
    </ScrollView>
  );
}
