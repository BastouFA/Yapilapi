import { File, Paths } from 'expo-file-system';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import { useEffect, useState, type ReactNode } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import type { PluralKey } from './locale';
import type {
  OnThisDayCard,
  PulseCards as PulseCardsData,
  WeeklyWrap,
  WeeklyWrapCard,
  WeeklyWrapCounts,
  WeeklyWrapSettings,
} from '../../../packages/shared/src/wrap';
import type { Post } from '../../../packages/shared/src/types';
import { baseUrl, client, errorMessage, getToken, mediaUrl } from './api';
import { useT, type Translator } from './i18n';
import { radius, space } from './theme';
import { Avatar, Button, Card, Icon, Loading, Notice, SwitchRow, Title, useColors, userText } from './ui';
import { postThumb } from './watch';

/**
 * The weekly wrap (a private look back at your week) and "On this day" on the phone: the gentle
 * cards at the top of Pulse, the pieces of the wrap screen (app/wraps/[id].tsx), sharing its
 * card image, and the Weekly wrap switches in Settings > Notifications.
 */

/** A week's date (YYYY-MM-DD) in the app's language, e.g. "22 Sept". Read as UTC so it never moves a day. */
export const wrapDate = (date: Translator['date'], ymd: string) => date(`${ymd}T00:00:00Z`, { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "2023, 2021 and 2019" in the app's language (a plain comma list where the phone can't format lists). */
function listOf(items: string[], locale: string): string {
  const LF = (Intl as unknown as { ListFormat?: new (l: string, o: object) => { format: (x: string[]) => string } }).ListFormat;
  try {
    if (LF) return new LF(locale, { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    // Fall through to the plain list.
  }
  return items.join(', ');
}

/** The counts shown under a wrap, in order, with their labels (the labels carry no number: it's drawn beside them). */
const STATS: [keyof WeeklyWrapCounts, PluralKey][] = [
  ['posts', 'wrap.stat.posts'],
  ['reels', 'wrap.stat.reels'],
  ['newFriends', 'wrap.stat.friends'],
  ['communities', 'wrap.stat.communities'],
  ['places', 'wrap.stat.places'],
  ['events', 'wrap.stat.events'],
  ['songs', 'wrap.stat.songs'],
];

/** The week's counts that aren't zero, in words ("3 posts, 1 new friend"), for a screen reader label. */
export function wrapStatsText(counts: WeeklyWrapCounts, { tp, number }: Pick<Translator, 'tp' | 'number'>): string {
  return STATS.filter(([k]) => counts[k] > 0)
    .map(([k, label]) => `${number(counts[k])} ${tp(label, counts[k])}`)
    .join(', ');
}

/** The week's counts that aren't zero, as small number-and-label pairs. */
export function WrapStats({ counts }: { counts: WeeklyWrapCounts }) {
  const c = useColors();
  const { tp, number } = useT();
  const shown = STATS.filter(([k]) => counts[k] > 0);
  if (!shown.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
      {shown.map(([k, label]) => (
        <View
          key={k}
          accessible
          style={{
            flexDirection: 'row',
            alignItems: 'baseline',
            gap: 4,
            backgroundColor: c.surfaceSunken,
            borderRadius: radius.full,
            paddingHorizontal: space[3],
            paddingVertical: 4,
          }}
        >
          <Text style={{ color: c.ink, fontWeight: '800', fontSize: 14 }}>{number(counts[k])}</Text>
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{tp(label, counts[k])}</Text>
        </View>
      ))}
    </View>
  );
}

const OTD_KEY = 'yp.otd.hiddenOn';
/** Today on this phone, as YYYY-MM-DD. */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const deviceZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

/**
 * The top of Pulse: this week's wrap card and "On this day", when there are any. Both are quiet
 * and can be put away: the wrap card for good, "On this day" until tomorrow (on this phone).
 */
export function PulseCards() {
  const [cards, setCards] = useState<PulseCardsData | null>(null);
  const [otdHidden, setOtdHidden] = useState(true);
  useEffect(() => {
    let live = true;
    void (async () => {
      const hiddenOn = await SecureStore.getItemAsync(OTD_KEY).catch(() => null);
      if (live) setOtdHidden(hiddenOn === today());
      try {
        const r = await (await client()).wraps.pulseCards(deviceZone());
        if (live) setCards(r);
      } catch {
        // A bonus on Pulse: the feed works without it.
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  if (!cards) return null;
  const wrap = cards.wrap;
  const otd = otdHidden ? null : cards.onThisDay;
  if (!wrap && !otd) return null;
  return (
    <View style={{ gap: space[3] }}>
      {wrap ? (
        <WrapPulseCard
          wrap={wrap}
          onDismiss={() => {
            setCards((cur) => (cur ? { ...cur, wrap: null } : cur));
            void client()
              .then((api) => api.wraps.dismiss(wrap.id))
              .catch(() => {});
          }}
        />
      ) : null}
      {otd ? (
        <OnThisDay
          card={otd}
          onDismiss={() => {
            setOtdHidden(true);
            void SecureStore.setItemAsync(OTD_KEY, today()).catch(() => {});
          }}
        />
      ) : null}
    </View>
  );
}

function WrapPulseCard({ wrap, onDismiss }: { wrap: WeeklyWrapCard; onDismiss: () => void }) {
  const c = useColors();
  const { t, date } = useT();
  return (
    <Card style={{ gap: space[3] }}>
      <View style={{ flexDirection: 'row', gap: space[3], alignItems: 'center' }}>
        {wrap.thumbUrl ? (
          <Image
            source={{ uri: mediaUrl(wrap.thumbUrl) }}
            accessibilityIgnoresInvertColors
            style={{ width: 56, height: 56, borderRadius: radius.md, backgroundColor: c.surfaceSunken }}
          />
        ) : (
          <View style={{ width: 56, height: 56, borderRadius: radius.md, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="sparkles-outline" size={24} color={c.yapi} />
          </View>
        )}
        <View style={{ flex: 1, gap: 2 }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 16 }}>
            {t('wrap.cardTitle')}
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>
            {t('wrap.cardBody', { start: wrapDate(date, wrap.weekStart), end: wrapDate(date, wrap.weekEnd) })}
          </Text>
        </View>
      </View>
      <WrapStats counts={wrap.counts} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        <Button label={t('wrap.open')} size="sm" icon="sparkles-outline" onPress={() => router.push({ pathname: '/wraps/[id]', params: { id: wrap.id } })} />
        <Button label={t('wrap.dismiss')} size="sm" variant="ghost" onPress={onDismiss} />
      </View>
    </Card>
  );
}

function OnThisDay({ card, onDismiss }: { card: OnThisDayCard; onDismiss: () => void }) {
  const c = useColors();
  const { t, tp, locale } = useT();
  const thumbs = card.posts
    .map((p) => ({ id: p.id, uri: postThumb(p) }))
    .filter((x): x is { id: string; uri: string } => !!x.uri)
    .slice(0, 3);
  return (
    <Card style={{ gap: space[3] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
        <Icon name="time-outline" size={20} color={c.yapi} />
        <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 16, flex: 1 }}>
          {t('otd.title')}
        </Text>
      </View>
      <View style={{ gap: 2 }}>
        <Text style={{ color: c.ink, fontSize: 14, lineHeight: 20 }}>{tp('otd.body', card.count)}</Text>
        {card.years.length ? (
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('otd.years', { years: listOf(card.years.map(String), locale) })}</Text>
        ) : null}
      </View>
      {thumbs.length ? (
        <View style={{ flexDirection: 'row', gap: space[2] }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {thumbs.map((x) => (
            <Image key={x.id} source={{ uri: x.uri }} style={{ width: 64, height: 64, borderRadius: radius.md, backgroundColor: c.surfaceSunken }} />
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        <Button label={t('otd.open')} size="sm" variant="secondary" icon="albums-outline" onPress={() => router.push('/memories')} />
        <Button label={t('otd.dismiss')} size="sm" variant="ghost" onPress={onDismiss} />
      </View>
    </Card>
  );
}

// ── The wrap screen ─────────────────────────────────────────────────────

const cardAddress = (id: string) => `${baseUrl}/v1/wraps/${id}/card.png`;

/** The card image (only for you, so it's fetched signed in). 4:5, like the image the API draws. */
export function WrapCardImage({ id }: { id: string }) {
  const c = useColors();
  const { t } = useT();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void getToken().then((tk) => setToken(tk ?? null));
  }, []);
  return (
    <View style={{ width: '100%', aspectRatio: 4 / 5, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: c.surfaceSunken }}>
      {token !== undefined && !failed ? (
        <Image
          source={{ uri: cardAddress(id), headers: token ? { authorization: `Bearer ${token}` } : undefined }}
          accessibilityLabel={t('wrap.cardAlt')}
          accessibilityIgnoresInvertColors
          onError={() => setFailed(true)}
          resizeMode="cover"
          style={{ width: '100%', height: '100%' }}
        />
      ) : null}
      {failed ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="image-outline" size={32} color={c.inkMuted} />
        </View>
      ) : null}
    </View>
  );
}

/** Download the card (signed in) to the cache and open the share sheet with it. */
export async function shareWrapCard(id: string, dialogTitle: string) {
  const token = await getToken();
  const file = await File.downloadFileAsync(cardAddress(id), new File(Paths.cache, `yapilapi-week-${id}.png`), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    idempotent: true,
  });
  if (!(await Sharing.isAvailableAsync())) throw new Error(dialogTitle);
  await Sharing.shareAsync(file.uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle });
}

/** A post in the wrap, small: its picture and the start of its text. Opens the post. */
function WrapPost({ post, big }: { post: Post; big?: boolean }) {
  const c = useColors();
  const { t, dateTime } = useT();
  const thumb = postThumb(post);
  const size = big ? 88 : 64;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${post.body || t('m.title.post')}, ${dateTime(post.createdAt)}`}
      onPress={() => router.push(`/p/${post.id}`)}
      style={({ pressed }) => ({ flexDirection: 'row', gap: space[3], alignItems: 'center', minHeight: 48, opacity: pressed ? 0.85 : 1 })}
    >
      <View
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
        {thumb ? (
          <Image source={{ uri: thumb }} style={{ width: size, height: size }} accessibilityIgnoresInvertColors />
        ) : (
          <Icon name="document-text-outline" size={22} color={c.inkMuted} />
        )}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        {post.body ? (
          <Text numberOfLines={big ? 4 : 2} style={[{ color: c.ink, fontSize: 14, lineHeight: 20 }, userText]}>
            {post.body}
          </Text>
        ) : null}
        <Text style={{ color: c.inkMuted, fontSize: 12 }}>{dateTime(post.createdAt)}</Text>
      </View>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const c = useColors();
  return (
    <Card style={{ gap: space[3] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 16 }}>
        {title}
      </Text>
      {children}
    </Card>
  );
}

/** Everything in a wrap below the card: only the parts with something in them. */
export function WrapSections({ wrap }: { wrap: WeeklyWrap }) {
  const c = useColors();
  const { t, tp, dateTime } = useT();
  const best = wrap.best.filter((p) => p.id !== wrap.moment?.id).slice(0, 3);
  const line = { color: c.ink, fontSize: 15, fontWeight: '600' as const };
  const row = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: space[3], minHeight: 44 };
  return (
    <>
      {wrap.moment ? (
        <Section title={t('wrap.moment')}>
          <WrapPost post={wrap.moment} big />
        </Section>
      ) : null}
      {best.length ? (
        <Section title={t('wrap.best')}>
          {best.map((p) => (
            <WrapPost key={p.id} post={p} />
          ))}
        </Section>
      ) : null}
      {wrap.newFriends.length ? (
        <Section title={t('wrap.newFriends')}>
          {wrap.newFriends.map((u) => (
            <Pressable key={u.id} accessibilityRole="link" accessibilityLabel={u.displayName} onPress={() => router.push(`/u/${u.username}`)} style={row}>
              <Avatar name={u.displayName} url={u.avatarUrl} size={36} />
              <Text numberOfLines={1} style={[line, userText, { flexShrink: 1 }]}>
                {u.displayName}
              </Text>
            </Pressable>
          ))}
        </Section>
      ) : null}
      {wrap.communities.length ? (
        <Section title={t('wrap.communities')}>
          {wrap.communities.map((x) => (
            <Pressable key={x.id} accessibilityRole="link" accessibilityLabel={x.name} onPress={() => router.push(`/c/${x.slug}`)} style={row}>
              <Icon name="people-outline" size={20} color={c.yapi} />
              <Text numberOfLines={1} style={[line, userText, { flexShrink: 1 }]}>
                {x.name}
              </Text>
            </Pressable>
          ))}
        </Section>
      ) : null}
      {wrap.events.length ? (
        <Section title={t('wrap.events')}>
          {wrap.events.map((x) => (
            <Pressable key={x.id} accessibilityRole="link" onPress={() => router.push(`/event/${x.id}`)} style={row}>
              <Icon name="calendar-outline" size={20} color={c.yapi} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[line, userText]}>
                  {x.title}
                </Text>
                <Text style={{ color: c.inkMuted, fontSize: 12 }}>{dateTime(x.startsAt)}</Text>
              </View>
            </Pressable>
          ))}
        </Section>
      ) : null}
      {wrap.places.length ? (
        <Section title={t('wrap.places')}>
          {wrap.places.map((x) => (
            <Pressable key={x.id} accessibilityRole="link" accessibilityLabel={x.name} onPress={() => router.push(`/place/${x.id}`)} style={row}>
              <Icon name="location-outline" size={20} color={c.yapi} />
              <Text numberOfLines={1} style={[line, userText, { flexShrink: 1 }]}>
                {x.name}
              </Text>
            </Pressable>
          ))}
        </Section>
      ) : null}
      {wrap.songs.length ? (
        <Section title={t('wrap.songs')}>
          {wrap.songs.map((x) => (
            <Pressable
              key={`${x.kind}-${x.id}`}
              accessibilityRole="link"
              onPress={() => router.push(x.kind === 'track' ? `/music/${x.id}` : `/sounds/${x.id}`)}
              style={row}
            >
              <Icon name="musical-notes-outline" size={20} color={c.yapi} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[line, userText]}>
                  {x.artist ? `${x.title} · ${x.artist}` : x.title}
                </Text>
                <Text style={{ color: c.inkMuted, fontSize: 12 }}>{tp('wrap.songUses', x.uses)}</Text>
              </View>
            </Pressable>
          ))}
        </Section>
      ) : null}
    </>
  );
}

/** A past week in the list: its dates and counts. */
export function WrapRow({ wrap }: { wrap: WeeklyWrapCard }) {
  const c = useColors();
  const tr = useT();
  const { t, date } = tr;
  const dates = t('wrap.dates', { start: wrapDate(date, wrap.weekStart), end: wrapDate(date, wrap.weekEnd) });
  // The card's label is all a screen reader hears of it, so it carries the counts too.
  const stats = wrapStatsText(wrap.counts, tr);
  return (
    <Card
      onPress={() => router.push({ pathname: '/wraps/[id]', params: { id: wrap.id } })}
      label={stats ? `${dates}, ${stats}` : dates}
      style={{ gap: space[2] }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
        {wrap.thumbUrl ? (
          <Image source={{ uri: mediaUrl(wrap.thumbUrl) }} style={{ width: 48, height: 48, borderRadius: radius.md }} accessibilityIgnoresInvertColors />
        ) : (
          <View style={{ width: 48, height: 48, borderRadius: radius.md, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="sparkles-outline" size={22} color={c.yapi} />
          </View>
        )}
        <Text style={{ color: c.ink, fontWeight: '700', fontSize: 15, flex: 1 }}>{dates}</Text>
        <Icon name="chevron-forward" size={18} color={c.inkMuted} directional />
      </View>
      <WrapStats counts={wrap.counts} />
    </Card>
  );
}

// ── Settings ────────────────────────────────────────────────────────────

/** Settings > Notifications: make a weekly wrap, and tell me when it's ready. */
export function WeeklyWrapSettingsCard() {
  const c = useColors();
  const { t } = useT();
  const [settings, setSettings] = useState<WeeklyWrapSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void client()
      .then((api) => api.wraps.settings())
      .then(
        (r) => setSettings(r.settings),
        (e) => setError(errorMessage(e)),
      );
  }, []);
  async function save(patch: { enabled?: boolean; notify?: boolean }) {
    if (!settings) return;
    const before = settings;
    setSettings({ ...settings, ...patch });
    setError(null);
    try {
      setSettings((await (await client()).wraps.updateSettings(patch)).settings);
    } catch (e) {
      setSettings(before);
      setError(errorMessage(e));
    }
  }
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('wrap.settings.desc')}>{t('wrap.settings.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {settings ? (
        <>
          <SwitchRow label={t('wrap.settings.enabled')} value={settings.enabled} onValueChange={(v) => void save({ enabled: v })} />
          <SwitchRow
            label={t('wrap.settings.notify')}
            value={settings.enabled && settings.notify}
            disabled={!settings.enabled}
            onValueChange={(v) => void save({ notify: v })}
          />
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('wrap.settings.timezone', { zone: settings.timezone })}</Text>
          <Button
            label={t('wrap.past')}
            size="sm"
            variant="ghost"
            icon="albums-outline"
            style={{ alignSelf: 'flex-start' }}
            onPress={() => router.push('/wraps')}
          />
        </>
      ) : !error ? (
        <Loading />
      ) : null}
    </Card>
  );
}
