import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { MAX_SQUAD_MEMBERS, SQUAD_COLORS, type SquadColor } from '../../../packages/shared/src/constants';
import { SQUAD_INK, squadColor, type SquadCover, type SquadMemory } from '../../../packages/shared/src/squads';
import type { MessageKey } from '../../../packages/shared/src/i18n-core';
import { formatList } from '../../../packages/shared/src/feed-reasons';
import type { PublicUser } from '../../../packages/shared/src/types';
import { client } from './api';
import { useT } from './i18n';
import { pickOne, uploadPicked } from './media';
import { PostCard } from './post';
import { radius, space } from './theme';
import { Avatar, Button, Field, Icon, useColors, userText } from './ui';

/**
 * Squads on the phone (docs/product/squads.md): small private groups of friends with a shared
 * feed, a shared story, a chat and a weekly memory. Screens: app/squads.tsx, app/squad/[id].tsx.
 */

export { MAX_SQUAD_MEMBERS };

/** A squad's cover: its photo, or its colour with its first letter (white on every squad colour is AA). */
export function SquadCoverView({ name, cover, size = 56 }: { name: string; cover: SquadCover; size?: number }) {
  const photo = cover.photo?.variants?.medium ?? cover.photo?.url;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 4),
        backgroundColor: squadColor(cover.color),
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {photo ? (
        <Image source={{ uri: photo }} style={{ width: size, height: size }} />
      ) : (
        <Text style={{ color: SQUAD_INK, fontWeight: '800', fontSize: Math.round(size / 2.4) }}>{Array.from(name.trim())[0]?.toUpperCase() ?? ''}</Text>
      )}
    </View>
  );
}

/** The cover colours, as a row of labelled 44pt choices (named like the profile accents). */
export function ColorChoice({ value, onChange }: { value: SquadColor; onChange: (c: SquadColor) => void }) {
  const c = useColors();
  const { t } = useT();
  return (
    <View style={{ gap: space[2] }}>
      <Text style={{ color: c.ink, fontWeight: '600' }}>{t('squads.color')}</Text>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {SQUAD_COLORS.map((x) => (
          <Pressable
            key={x}
            accessibilityRole="radio"
            accessibilityState={{ checked: value === x }}
            accessibilityLabel={t(`ps.accent.${x}` as MessageKey)}
            onPress={() => onChange(x)}
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: squadColor(x),
              borderWidth: value === x ? 3 : 0,
              borderColor: c.ink,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {value === x ? <Icon name="checkmark" size={20} color={SQUAD_INK} /> : null}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** A cover photo: pick and upload one of yours, or go back to the colour. */
export function PhotoChoice({
  value,
  onChange,
  onError,
}: {
  value: { id: string; url: string } | null;
  onChange: (v: { id: string; url: string } | null) => void;
  onError: (message: string) => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  async function pick() {
    const picked = await pickOne(['images']);
    if (!picked || picked === 'denied') return;
    setBusy(true);
    try {
      const up = await uploadPicked(picked);
      onChange({ id: up.id, url: up.url });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
      <Button label={value ? t('squads.photo') : t('squads.photo.choose')} icon="image-outline" size="sm" variant="secondary" disabled={busy} onPress={pick} />
      {value ? <Button label={t('squads.photo.remove')} size="sm" variant="ghost" onPress={() => onChange(null)} /> : null}
    </View>
  );
}

/** People you could invite (friends, and people you follow who follow you back), with a search; tap to choose. */
export function PeoplePick({ squadId, chosen, onToggle, max }: { squadId?: string; chosen: string[]; onToggle: (u: PublicUser) => void; max: number }) {
  const c = useColors();
  const { t } = useT();
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<PublicUser[] | null>(null);
  const req = useRef(0);
  useEffect(() => {
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        void client()
          .then((api) => api.squads.candidates({ squadId, q: q.trim() || undefined }))
          .then(
            (r) => n === req.current && setPeople(r.items),
            () => n === req.current && setPeople([]),
          ),
      q ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [q, squadId]);
  return (
    <View style={{ gap: space[2] }}>
      <Field
        label={t('squads.invite')}
        placeholder={t('m.collab.search')}
        value={q}
        onChangeText={setQ}
        autoCorrect={false}
        autoCapitalize="none"
        hint={t('squads.inviteHint')}
      />
      {people?.length ? (
        people.map((u) => {
          const on = chosen.includes(u.id);
          const off = !on && chosen.length >= max;
          return (
            <Pressable
              key={u.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled: off }}
              accessibilityLabel={`${u.displayName}, @${u.username}`}
              disabled={off}
              onPress={() => onToggle(u)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 48, opacity: off ? 0.5 : 1 }}
            >
              <Avatar name={u.displayName} url={u.avatarUrl} size={36} />
              <View style={{ flex: 1 }}>
                <Text style={[{ color: c.ink, fontWeight: '600' }, userText]} numberOfLines={1}>
                  {u.displayName}
                </Text>
                <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                  @{u.username}
                </Text>
              </View>
              <Icon name={on ? 'checkbox' : 'square-outline'} size={24} color={on ? c.yapi : c.inkMuted} />
            </Pressable>
          );
        })
      ) : people ? (
        <Text style={{ color: c.inkMuted, lineHeight: 20 }} accessibilityLiveRegion="polite">
          {q.trim() ? t('m.group.noMatch', { query: q.trim() }) : t('squads.noCandidates')}
        </Text>
      ) : null}
    </View>
  );
}

/** "Your squad's week", pinned on the squad until the next one. */
export function MemoryCard({ memory }: { memory: SquadMemory }) {
  const c = useColors();
  const { t, tp, locale } = useT();
  const total = memory.counts.posts + memory.counts.reels + memory.counts.stories;
  const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${memory.weekStart}T00:00:00Z`));
  return (
    <View style={{ gap: space[2], backgroundColor: c.surface, borderRadius: radius.lg, padding: space[4] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 17 }}>
        {t('squads.memory.title')}
      </Text>
      <Text style={{ color: c.inkMuted }}>{t('squads.memory.week', { date })}</Text>
      <Text style={{ color: c.ink }}>{tp('squads.memory.moments', total)}</Text>
      {memory.people.length ? (
        <Text style={[{ color: c.inkMuted }, userText]}>
          {t('squads.memory.by', {
            names: formatList(
              memory.people.map((u) => u.displayName),
              locale,
            ),
          })}
        </Text>
      ) : null}
      {memory.top.map((p) => (
        <PostCard key={p.id} post={p} />
      ))}
    </View>
  );
}
