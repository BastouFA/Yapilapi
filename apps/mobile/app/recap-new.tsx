import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { ApiError } from '../../../packages/api-client/src/index';
import {
  RECAP_LENGTHS,
  RECAP_MAX_ITEMS,
  RECAP_SOURCES,
  RECAP_TITLE_MAX,
  type RecapAspect,
  type RecapSource,
  type RecapStyle,
} from '../../../packages/shared/src/constants';
import type { RecapCandidate, RecapCandidates, Sound } from '../../../packages/shared/src/types';
import { client, mediaUrl } from '../lib/api';
import { useT } from '../lib/i18n';
import { recapError } from '../lib/recaps';
import { useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { Button, Card, EmptyState, Field, Icon, Loading, Notice, Segmented, useColors, userText } from '../lib/ui';

type Length = 'auto' | `${(typeof RECAP_LENGTHS)[number]}`;

/**
 * Make a recap video from `?source=memory|on_this_day|chapter&sourceId=`. The suggested pick
 * comes first, in playing order (move, remove or add more, up to 30), then the title, style,
 * shape, length and an optional sound. Making it opens it on the Recaps screen, where it
 * shows as being made until it's ready.
 */
export default function RecapNew() {
  const c = useColors();
  const { t, tp } = useT();
  const itemLabel = useItemLabel();
  const { me } = useSession();
  const params = useLocalSearchParams<{ source?: string; sourceId?: string }>();
  const source = (RECAP_SOURCES as readonly string[]).includes(params.source ?? '') ? (params.source as RecapSource) : null;
  const sourceId = source === 'on_this_day' ? undefined : params.sourceId || undefined;
  const valid = !!source && (source === 'on_this_day' || !!sourceId);

  const [data, setData] = useState<RecapCandidates | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [style, setStyle] = useState<RecapStyle>('calm');
  const [aspect, setAspect] = useState<RecapAspect>('9:16');
  const [length, setLength] = useState<Length>('auto');
  const [sound, setSound] = useState<Sound | null>(null);
  const [pickingSound, setPickingSound] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me || !source || !valid) return;
    client()
      .then((api) => api.recaps.candidates(source, sourceId))
      .then(
        (r) => {
          const ids = new Set(r.items.map((x) => x.mediaId));
          setData(r);
          setChosen(r.preselected.filter((id) => ids.has(id)).slice(0, RECAP_MAX_ITEMS));
          setTitle(r.title.slice(0, RECAP_TITLE_MAX));
          setRemaining(r.remainingToday);
        },
        (e) => {
          setData(null);
          setLoadError(recapError(e, t));
        },
      );
  }, [me, source, sourceId, valid, t]);

  if (me === undefined) return <Loading />;
  if (!me)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );
  if (!valid)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.recap.badSource')} />
      </View>
    );
  if (data === undefined) return <Loading />;
  if (data === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice tone="danger">{loadError ?? t('m.recap.missing')}</Notice>
      </View>
    );
  if (!data.items.length)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.recap.nothing')} />
      </View>
    );

  const byId = new Map(data.items.map((x) => [x.mediaId, x]));
  const rest = data.items.filter((x) => !chosen.includes(x.mediaId));
  const full = chosen.length >= RECAP_MAX_ITEMS;
  const noneLeft = remaining === 0;

  const move = (i: number, by: -1 | 1) =>
    setChosen((cur) => {
      const j = i + by;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  async function create() {
    if (!source || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { recap } = await (
        await client()
      ).recaps.create({
        source,
        ...(sourceId ? { sourceId } : {}),
        title: title.trim(),
        mediaIds: chosen,
        style,
        aspect,
        ...(sound ? { soundId: sound.id } : {}),
        ...(length !== 'auto' ? { lengthSeconds: Number(length) } : {}),
      });
      // Back to Recaps if it's under us, else Recaps in place of this screen; either way it opens.
      router.dismissTo({ pathname: '/recaps', params: { open: recap.id } });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'recap_limit') setRemaining(0);
      setError(recapError(e, t));
      setBusy(false);
    }
  }

  const heading = (text: string, sub?: string) => (
    <View style={{ gap: 2 }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
        {text}
      </Text>
      {sub ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{sub}</Text> : null}
    </View>
  );
  const styleHint = { calm: t('m.recap.style.calmHint'), quick: t('m.recap.style.quickHint'), film: t('m.recap.style.filmHint') }[style];

  return (
    <ScrollView
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
      keyboardShouldPersistTaps="handled"
    >
      <Field label={t('m.recap.name')} value={title} onChangeText={setTitle} maxLength={RECAP_TITLE_MAX} />

      <View style={{ gap: space[2] }}>
        {heading(t('m.recap.chosen'), t('m.recap.chosenCount', { count: chosen.length, max: RECAP_MAX_ITEMS }))}
        {chosen.length ? (
          chosen.map((id, i) => {
            const item = byId.get(id);
            if (!item) return null;
            return (
              <View key={id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
                <Text style={{ color: c.inkMuted, width: 22, textAlign: 'center', fontWeight: '700' }}>{i + 1}</Text>
                <Thumb item={item} size={56} />
                <Text style={{ flex: 1, color: c.ink, fontSize: 13 }} numberOfLines={2}>
                  {itemLabel(item)}
                </Text>
                <IconButton icon="arrow-up" label={t('m.recap.moveUp')} disabled={i === 0} onPress={() => move(i, -1)} />
                <IconButton icon="arrow-down" label={t('m.recap.moveDown')} disabled={i === chosen.length - 1} onPress={() => move(i, 1)} />
                <IconButton icon="close" label={t('m.common.remove')} onPress={() => setChosen((cur) => cur.filter((x) => x !== id))} />
              </View>
            );
          })
        ) : (
          <Text style={{ color: c.inkMuted }}>{t('m.recap.chooseSome')}</Text>
        )}
      </View>

      {rest.length ? (
        <View style={{ gap: space[2] }}>
          {heading(t('m.recap.more'), full ? t('m.recap.full', { max: RECAP_MAX_ITEMS }) : undefined)}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[3] }}>
            {rest.map((item) => (
              <View key={item.mediaId} style={{ width: 96, gap: space[1] }}>
                <Thumb item={item} size={96} label={itemLabel(item)} />
                <Button
                  size="sm"
                  variant="secondary"
                  icon="add"
                  label={t('m.recap.add')}
                  disabled={full}
                  onPress={() => setChosen((cur) => [...cur, item.mediaId])}
                />
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <View style={{ gap: space[2] }}>
        {heading(t('m.recap.style'))}
        <Segmented
          label={t('m.recap.style')}
          options={[
            { id: 'calm' as const, label: t('m.recap.style.calm') },
            { id: 'quick' as const, label: t('m.recap.style.quick') },
            { id: 'film' as const, label: t('m.recap.style.film') },
          ]}
          value={style}
          onChange={setStyle}
        />
        <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{styleHint}</Text>
      </View>

      <View style={{ gap: space[2] }}>
        {heading(t('m.recap.shape'))}
        <Segmented
          label={t('m.recap.shape')}
          options={[
            { id: '9:16' as const, label: t('m.recap.shape.tall') },
            { id: '1:1' as const, label: t('m.recap.shape.square') },
          ]}
          value={aspect}
          onChange={setAspect}
        />
      </View>

      <View style={{ gap: space[2] }}>
        {heading(t('m.recap.length'), t('m.recap.lengthHint'))}
        <Segmented<Length>
          label={t('m.recap.length')}
          options={[
            { id: 'auto', label: t('m.recap.length.auto') },
            ...RECAP_LENGTHS.map((n) => ({ id: `${n}` as Length, label: t('m.recap.seconds', { count: n }) })),
          ]}
          value={length}
          onChange={setLength}
        />
      </View>

      <View style={{ gap: space[2] }}>
        {heading(t('m.recap.sound'))}
        {sound ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
            <Icon name="musical-notes-outline" size={20} color={c.yapi} />
            <View style={{ flex: 1 }}>
              <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                {sound.title}
              </Text>
              <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                {t('m.sound.by', { name: sound.owner.displayName })}
              </Text>
            </View>
            <Button size="sm" variant="ghost" label={t('m.common.remove')} onPress={() => setSound(null)} />
          </View>
        ) : (
          <>
            <Text style={{ color: c.inkMuted }}>{t('m.recap.noSound')}</Text>
            <Button
              size="sm"
              variant="secondary"
              icon="musical-notes-outline"
              label={t('m.recap.addSound')}
              onPress={() => setPickingSound((v) => !v)}
              style={{ alignSelf: 'flex-start' }}
            />
          </>
        )}
        {pickingSound && !sound ? (
          <SoundPicker
            onPick={(s) => {
              setSound(s);
              setPickingSound(false);
            }}
          />
        ) : null}
      </View>

      {remaining !== null ? (
        noneLeft ? (
          <Notice tone="warn">{t('m.recap.noneLeft')}</Notice>
        ) : (
          <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{tp('m.recap.remaining', remaining)}</Text>
        )
      ) : null}
      {error ? (
        <Notice tone="danger" key={error}>
          {error}
        </Notice>
      ) : null}
      <Button label={t('m.recap.create')} icon="film-outline" disabled={busy || noneLeft || !chosen.length || !title.trim()} onPress={() => void create()} />
      {busy ? <ActivityIndicator color={c.yapi} /> : null}
    </ScrollView>
  );
}

function Thumb({ item, size, label }: { item: RecapCandidate; size: number; label?: string }) {
  const c = useColors();
  return (
    <View
      accessible={!!label}
      accessibilityLabel={label}
      style={{
        width: size,
        height: size,
        borderRadius: radius.md,
        overflow: 'hidden',
        backgroundColor: c.surfaceSunken,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {item.thumbUrl ? (
        <Image source={{ uri: mediaUrl(item.thumbUrl) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
      ) : (
        <Icon name={item.kind === 'video' ? 'videocam-outline' : 'image-outline'} size={22} color={c.inkMuted} />
      )}
      {item.kind === 'video' && item.thumbUrl ? (
        <View style={{ position: 'absolute', top: 4, end: 4, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radius.full, padding: 3 }}>
          <Icon name="videocam" size={12} color="#FFFFFF" />
        </View>
      ) : null}
    </View>
  );
}

/** "Photo from 3 May 2024" / "Video from …", for the list and for screen readers. */
function useItemLabel() {
  const { t, date } = useT();
  return (item: RecapCandidate) => {
    const when = date(item.takenAt, { dateStyle: 'medium' });
    return item.kind === 'video' ? t('m.recap.videoFrom', { date: when }) : t('m.recap.photoFrom', { date: when });
  };
}

function IconButton({ icon, label, onPress, disabled }: { icon: 'arrow-up' | 'arrow-down' | 'close'; label: string; onPress: () => void; disabled?: boolean }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 36,
        height: 36,
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: c.line,
        backgroundColor: c.surface,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.35 : pressed ? 0.7 : 1,
      })}
    >
      <Icon name={icon} size={18} color={c.ink} />
    </Pressable>
  );
}

/** Sounds from the library that can be used in new videos, most used first; search by name. */
function SoundPicker({ onPick }: { onPick: (s: Sound) => void }) {
  const c = useColors();
  const { t } = useT();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Sound[] | null>(null);
  useEffect(() => {
    const timer = setTimeout(
      () =>
        void client()
          .then((api) => api.sounds.list(q.trim(), 20))
          .then(
            (r) => setItems(r.items.filter((s) => s.canUse)),
            () => setItems([]),
          ),
      q ? 200 : 0,
    );
    return () => clearTimeout(timer);
  }, [q]);
  return (
    <Card style={{ gap: space[3] }}>
      <Field label={t('m.recap.searchSounds')} hideLabel placeholder={t('m.recap.searchSounds')} value={q} onChangeText={setQ} autoCapitalize="none" />
      {items === null ? (
        <ActivityIndicator color={c.yapi} />
      ) : items.length ? (
        items.map((s) => (
          <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
            <Icon name="musical-notes-outline" size={20} color={c.inkMuted} />
            <View style={{ flex: 1 }}>
              <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                {s.title}
              </Text>
              <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                {t('m.sound.by', { name: s.owner.displayName })}
              </Text>
            </View>
            <Button size="sm" label={t('m.recap.add')} onPress={() => onPick(s)} />
          </View>
        ))
      ) : (
        <Text style={{ color: c.inkMuted }}>{t('m.recap.noSounds')}</Text>
      )}
    </Card>
  );
}
