import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { dropCountdown, dropDay, dropPhase, type Drop } from '../../../packages/shared/src/drops';
import { client, mediaUrl } from './api';
import { useFlag } from './flags';
import { useT } from './i18n';
import type { Translator } from './locale';
import { radius, space } from './theme';
import { Icon, useColors, userText } from './ui';

/**
 * Drops on the phone: the words for a drop's time (plain, like "Opens Friday at 6:00 PM", never
 * a ticking clock), a card, and the rows on a profile and on Pulse. Buying and making drops
 * happen on the web; the drop screen links there.
 */

/** The current time, moved on every `ms` so relative words stay right. Minutes are enough. */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function opensText(tr: Pick<Translator, 't' | 'locale'>, startsAt: string, now = new Date()): string {
  let d: ReturnType<typeof dropDay>;
  try {
    d = dropDay(startsAt, tr.locale, now);
  } catch {
    return tr.t('m.drops.opensOn', { day: new Date(startsAt).toLocaleDateString(), time: new Date(startsAt).toLocaleTimeString() });
  }
  if (d.kind === 'today') return tr.t('m.drops.opensToday', { time: d.time });
  if (d.kind === 'tomorrow') return tr.t('m.drops.opensTomorrow', { time: d.time });
  return tr.t('m.drops.opensOn', { day: d.day, time: d.time });
}

/** "in 3 days", from the catalog: the phone's JavaScript engine has no relative time formatting. */
export function untilText(tr: Pick<Translator, 'tp'>, at: string, now = new Date()): string | null {
  const c = dropCountdown(at, now);
  if (!c) return null;
  return tr.tp(c.unit === 'day' ? 'm.drops.inDays' : c.unit === 'hour' ? 'm.drops.inHours' : 'm.drops.inMinutes', c.value);
}

/** One line for where a drop is: when it opens, that it's open (and until when), or how it ended. */
export function dropStatusText(tr: Pick<Translator, 't' | 'tp' | 'locale' | 'date'>, d: Drop, now = new Date()): string {
  const phase = dropPhase(d, now);
  if (phase === 'upcoming' || phase === 'draft') {
    const opens = opensText(tr, d.startsAt, now);
    const until = untilText(tr, d.startsAt, now);
    return phase === 'draft' ? `${tr.t('m.drops.draft')} · ${opens}` : until ? `${opens} · ${until}` : opens;
  }
  if (phase === 'opening') return tr.t('m.drops.opening');
  if (phase === 'open')
    return d.endsAt
      ? tr.t('m.drops.closesOn', { when: tr.date(d.endsAt, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) })
      : tr.t('m.drops.open');
  if (phase === 'cancelled') return tr.t('m.drops.cancelled');
  return d.endReason === 'sold_out' ? tr.t('m.drops.soldOut') : tr.t('m.drops.ended');
}

export function DropCover({ drop, size = 64, wide }: { drop: Pick<Drop, 'coverUrl' | 'coverAlt' | 'title'>; size?: number; wide?: boolean }) {
  const c = useColors();
  const { t } = useT();
  const style = wide ? { width: '100%' as const, aspectRatio: 16 / 9, borderRadius: radius.md } : { width: size, height: size, borderRadius: radius.md };
  return drop.coverUrl ? (
    <Image
      source={{ uri: mediaUrl(drop.coverUrl) }}
      style={[style, { backgroundColor: c.surfaceSunken }]}
      accessibilityLabel={drop.coverAlt || t('m.drops.coverAlt', { title: drop.title })}
      accessibilityIgnoresInvertColors
    />
  ) : (
    <View
      style={[style, { backgroundColor: c.yapi, alignItems: 'center', justifyContent: 'center' }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Icon name="bag-handle-outline" size={wide ? 40 : 26} color="#FFFFFF" />
    </View>
  );
}

/** A drop in a list or row: cover, name, who, and when. Opens the drop. */
export function DropCard({ drop, now, showSeller = true, width }: { drop: Drop; now: Date; showSeller?: boolean; width?: number }) {
  const c = useColors();
  const tr = useT();
  const phase = dropPhase(drop, now);
  const status = dropStatusText(tr, drop, now);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${drop.title}, ${showSeller ? `${tr.t('m.drops.by', { name: drop.seller.displayName })}, ` : ''}${status}`}
      onPress={() => router.push(`/drop/${drop.id}`)}
      style={({ pressed }) => ({
        width,
        flexDirection: 'row',
        gap: space[3],
        padding: space[3],
        minHeight: 44,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: c.line,
        backgroundColor: pressed ? c.surfaceSunken : c.surface,
      })}
    >
      <DropCover drop={drop} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[{ color: c.ink, fontWeight: '800', fontSize: 16 }, userText]} numberOfLines={2}>
          {drop.title}
        </Text>
        {showSeller ? (
          <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
            {tr.t('m.drops.by', { name: drop.seller.displayName })}
          </Text>
        ) : null}
        <Text style={{ color: phase === 'open' || phase === 'opening' ? c.success : c.ink, fontWeight: '700', fontSize: 14 }}>{status}</Text>
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>{tr.tp('m.drops.products', drop.items.length)}</Text>
      </View>
    </Pressable>
  );
}

function DropsStrip({
  title,
  items,
  showSeller,
  action,
}: {
  title: string;
  items: Drop[];
  showSeller: boolean;
  action?: { label: string; onPress: () => void };
}) {
  const c = useColors();
  const now = useNow();
  return (
    <View style={{ gap: space[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text accessibilityRole="header" style={{ flex: 1, color: c.ink, fontSize: 17, fontWeight: '800' }}>
          {title}
        </Text>
        {action ? (
          <Pressable accessibilityRole="button" hitSlop={10} onPress={action.onPress} style={{ minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: c.yapi, fontWeight: '700' }}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[3] }}>
        {items.map((d) => (
          <DropCard key={d.id} drop={d} now={now} showSeller={showSeller} width={290} />
        ))}
      </ScrollView>
    </View>
  );
}

/** A person's drops on their profile (nothing when they have none). */
export function DropsRow({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const { t } = useT();
  const commerce = useFlag('COMMERCE');
  const [items, setItems] = useState<Drop[]>([]);
  useEffect(() => {
    let live = true;
    client()
      .then((api) => api.drops.byUser(userId))
      .then(
        (r) => live && setItems(r.items),
        () => live && setItems([]),
      );
    return () => {
      live = false;
    };
  }, [userId]);
  if (commerce === false || !items.length) return null;
  return (
    <DropsStrip
      title={t('m.drops.onProfile')}
      items={items}
      showSeller={false}
      action={isSelf ? { label: t('m.drops.yours'), onPress: () => router.push('/drops') } : undefined}
    />
  );
}

/** On Pulse: open and coming drops from people you follow (nothing when there are none). */
export function FollowingDrops({ reloadKey }: { reloadKey?: unknown }) {
  const { t } = useT();
  const commerce = useFlag('COMMERCE');
  const [items, setItems] = useState<Drop[]>([]);
  useEffect(() => {
    let live = true;
    client()
      .then((api) => api.drops.following())
      .then(
        (r) => live && setItems(r.items),
        () => live && setItems([]),
      );
    return () => {
      live = false;
    };
  }, [reloadKey]);
  if (commerce === false || !items.length) return null;
  return (
    <DropsStrip title={t('m.drops.fromFollowing')} items={items} showSeller action={{ label: t('m.drops.yours'), onPress: () => router.push('/drops') }} />
  );
}
