import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Linking, Pressable, Text, View } from 'react-native';
import { mapDistance } from '../../../packages/shared/src/city-map';
import type { MessageKey } from '../../../packages/shared/src/i18n-core';
import {
  STASH_BADGE_KEYS,
  STASH_KIND_KEYS,
  type StashCard,
  type StashContent,
  type StashExplorer,
  type StashKind,
  type StashSettings,
} from '../../../packages/shared/src/stash';
import { client, errorMessage, mediaUrl } from './api';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Icon, Pill, SwitchRow, useColors, type IconName } from './ui';
import { VoicePlayer } from './voice';

/**
 * Stash on the phone (docs/product/stash.md): reading the precise position (only when hiding or
 * opening, after a tap), rows, what's inside, explorer counts and settings. No new dependency:
 * expo-location was already here for chat location sharing and the map.
 */

export const STASH_KIND_ICONS: Record<StashKind, IconName> = {
  text: 'document-text-outline',
  photo: 'image-outline',
  video: 'videocam-outline',
  song: 'musical-notes-outline',
  voice: 'mic-outline',
  gift: 'gift-outline',
};

export interface Position {
  lat: number;
  lng: number;
  accuracy: number;
}

/** Where the phone is now, as precisely as it can say, or 'denied' / 'unavailable'. Asks for permission (after a tap). */
export async function readPrecise(): Promise<Position> {
  const perm = await Location.requestForegroundPermissionsAsync().catch(() => null);
  if (!perm || perm.status !== 'granted') throw 'denied';
  try {
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
    return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy ?? 999) };
  } catch {
    throw 'unavailable';
  }
}

/** Why the position couldn't be read, in words. */
export function useWhereProblem() {
  const { t } = useT();
  return (e: unknown) => (e === 'denied' ? t('m.market.nearby.denied') : e === 'unavailable' ? t('location.unavailable') : errorMessage(e));
}

/** "Hidden by Ada", or "Hidden by YAPILAPI" for the team's. */
export function hiddenBy(t: (k: MessageKey, v?: Record<string, string | number>) => string, s: StashCard): string {
  return s.seeded || !s.owner ? t('stash.byTeam') : t('stash.by', { name: s.owner.displayName });
}

/** "About 300 m away" (to the area's middle), or "Less than 100 m away". */
export function useAway() {
  const { t, locale } = useT();
  return (metres: number) => {
    const d = mapDistance(t, metres, locale);
    return d ? t('stash.away', { distance: d }) : t('stash.close');
  };
}

/** One stash in a list: its kind, title, hint, who hid it, roughly how far. Opens its page. */
export function StashRow({ stash, metres }: { stash: StashCard; metres?: number | null }) {
  const c = useColors();
  const { t, tp } = useT();
  const away = useAway();
  const title = stash.title || t('stash.untitled');
  const meta = [
    t(STASH_KIND_KEYS[stash.kind]),
    hiddenBy(t, stash),
    metres != null ? away(metres) : null,
    stash.found ? t('stash.opened') : stash.finds ? tp('stash.finds', stash.finds) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={[title, stash.hint, meta].filter(Boolean).join(', ')}
      onPress={() => router.push(`/stash/${stash.id}`)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        minHeight: 64,
        paddingVertical: space[2],
        paddingHorizontal: space[3],
        borderRadius: radius.md,
        backgroundColor: pressed ? c.surfaceSunken : 'transparent',
      })}
    >
      <View style={{ width: 44, height: 44, borderRadius: radius.md, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={STASH_KIND_ICONS[stash.kind]} size={22} color={c.yapi} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.ink, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>
          {title}
        </Text>
        {stash.hint ? (
          <Text style={{ color: c.ink, fontSize: 14 }} numberOfLines={1}>
            {stash.hint}
          </Text>
        ) : null}
        <Text style={{ color: c.inkMuted, fontSize: 13 }} numberOfLines={2}>
          {meta}
        </Text>
      </View>
    </Pressable>
  );
}

/** What's inside: the words, the gift, the photo, the voice note, the song (a video opens full screen). */
export function StashInside({ content, own }: { content: StashContent; own?: boolean }) {
  const c = useColors();
  const { t } = useT();
  return (
    <View style={{ gap: space[3], padding: space[4], borderRadius: radius.lg, borderWidth: 1, borderColor: c.line, backgroundColor: c.surface }}>
      {content.media?.kind === 'image' ? (
        <Image
          source={{ uri: mediaUrl(content.media.url) }}
          accessibilityLabel={content.media.altText ?? t('stash.kind.photo')}
          style={{
            width: '100%',
            aspectRatio: content.media.width && content.media.height ? content.media.width / content.media.height : 1,
            borderRadius: radius.md,
          }}
          resizeMode="cover"
        />
      ) : null}
      {content.media?.kind === 'video' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('stash.kind.video')}
          onPress={() => void Linking.openURL(mediaUrl(content.media!.url))}
          style={{
            borderRadius: radius.md,
            overflow: 'hidden',
            backgroundColor: c.surfaceSunken,
            minHeight: 160,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {content.media.posterUrl ? (
            <Image
              source={{ uri: mediaUrl(content.media.posterUrl) }}
              style={{ position: 'absolute', top: 0, start: 0, end: 0, bottom: 0 }}
              accessibilityIgnoresInvertColors
            />
          ) : null}
          <Icon name="play-circle" size={56} color={c.onYapi} />
        </Pressable>
      ) : null}
      {content.voice ? <VoicePlayer clip={content.voice} label={t('stash.kind.voice')} own={own} /> : null}
      {content.song ? (
        <View style={{ flexDirection: 'row', gap: space[3], alignItems: 'center' }}>
          {content.song.track.coverUrl ? (
            <Image source={{ uri: content.song.track.coverUrl }} style={{ width: 56, height: 56, borderRadius: radius.sm }} accessibilityIgnoresInvertColors />
          ) : (
            <Icon name="musical-notes" size={28} color={c.yapi} />
          )}
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: c.ink, fontWeight: '700' }}>{content.song.track.title}</Text>
            <Text style={{ color: c.inkMuted }}>{content.song.track.artist}</Text>
            <Text style={{ color: c.inkMuted, fontSize: 12 }}>{content.song.track.attribution}</Text>
          </View>
          {content.song.track.previewUrl ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={content.song.track.title}
              onPress={() => void Linking.openURL(content.song!.track.previewUrl!)}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="play" size={24} color={c.yapi} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {content.giftCode ? (
        <View
          accessibilityLabel={`${t('stash.kind.gift')}: ${content.giftCode}`}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space[2],
            padding: space[3],
            borderRadius: radius.md,
            borderWidth: 2,
            borderStyle: 'dashed',
            borderColor: c.yapi,
          }}
        >
          <Icon name="gift" size={20} color={c.yapi} />
          <Text selectable style={{ color: c.ink, fontSize: 20, fontWeight: '800', letterSpacing: 1 }}>
            {content.giftCode}
          </Text>
        </View>
      ) : null}
      {content.body ? <Text style={{ color: c.ink, fontSize: 16, lineHeight: 24 }}>{content.body}</Text> : null}
    </View>
  );
}

/** "Stashes found: 12 · Hidden: 5" and badges, on a profile (nothing when the person keeps it to themselves). */
export function ExplorerLine({ username }: { username: string }) {
  const c = useColors();
  const { t } = useT();
  const [ex, setEx] = useState<StashExplorer | null>(null);
  useEffect(() => {
    let live = true;
    void client()
      .then((api) => api.stash.explorer(username))
      .then(
        (r) => live && setEx(r.explorer),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [username]);
  if (!ex || (!ex.found && !ex.hidden)) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[2] }}>
      <Icon name="gift-outline" size={16} color={c.inkMuted} />
      <Text style={{ color: c.inkMuted, fontSize: 14 }}>{t('stash.explorer', { found: ex.found, hidden: ex.hidden })}</Text>
      {ex.badges.map((b) => (
        <Pill key={b} text={t(STASH_BADGE_KEYS[b])} />
      ))}
    </View>
  );
}

/** Stash settings: counts on your profile, explorer lists and "new stashes near me". */
export function StashSettingsRows() {
  const c = useColors();
  const { t } = useT();
  const [s, setS] = useState<StashSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    void client()
      .then((api) => api.stash.settings())
      .then(
        (r) => setS(r.settings),
        () => {},
      );
  }, []);
  if (!s) return null;
  const save = async (patch: Partial<Pick<StashSettings, 'showCounts' | 'explorerLists' | 'nearbyNotify'>>) => {
    const before = s;
    setS({ ...s, ...patch });
    setProblem(null);
    try {
      setS((await (await client()).stash.setSettings(patch)).settings);
    } catch (e) {
      setS(before);
      setProblem(errorMessage(e));
    }
  };
  return (
    <View style={{ gap: space[1] }}>
      <SwitchRow label={t('stash.settings.showCounts')} value={s.showCounts} onValueChange={(v) => void save({ showCounts: v })} />
      <SwitchRow
        label={t('stash.settings.explorerLists')}
        hint={s.explorerListsLocked ? t('stash.settings.explorerListsLocked') : undefined}
        value={s.explorerLists}
        disabled={s.explorerListsLocked}
        onValueChange={(v) => void save({ explorerLists: v })}
      />
      <SwitchRow label={t('stash.settings.nearby')} value={s.nearbyNotify} onValueChange={(v) => void save({ nearbyNotify: v })} />
      {problem ? <Text style={{ color: c.danger }}>{problem}</Text> : null}
    </View>
  );
}
