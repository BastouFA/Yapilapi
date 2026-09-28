import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, Text, View } from 'react-native';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import type { MusicTrack, PostMusic } from '../../../packages/shared/src/music';
import {
  MAX_FEATURED_POSTS,
  MAX_PROFILE_LINKS,
  PROFILE_ACCENTS,
  PROFILE_HEADER_STYLES,
  PROFILE_LINK_LABEL_MAX,
  PROFILE_TABS,
  THEME_SURFACES,
  linkHost,
  profileAccentColors,
  type ProfileAccent,
  type ProfileHeaderStyle,
  type ProfileTab,
  type ThemeName,
} from '../../../packages/shared/src/profile-style';
import type { Post, Profile, ProfileLink } from '../../../packages/shared/src/types';
import { client, mediaUrl } from './api';
import { Chip, ChipRow } from './chips';
import { useDataSaver } from './data-saver';
import { useT } from './i18n';
import { useReducedMotion } from './motion';
import { openMusic, useMusicCredit, useMusicLoop } from './music';
import { radius, space } from './theme';
import { Avatar, Field, Icon, useColors, userText, type Tint } from './ui';

/** A profile's accent in the current theme, adjusted for AA contrast (packages/shared/src/profile-style.ts). */
export function useTint(accent: ProfileAccent | undefined): Tint {
  const c = useColors();
  return profileAccentColors(accent, c.theme);
}

const TAB_LABELS: Record<ProfileTab, MessageKey> = {
  posts: 'profile.posts',
  reels: 'm.title.reels',
  reposts: 'post.reposts',
  tagged: 'm.tagged.tab',
  boards: 'm.boards.title',
  chapters: 'm.chapters.title',
  shop: 'm.shop.tab',
  answers: 'ask.tab',
};
export const tabLabel = (tab: ProfileTab): MessageKey => TAB_LABELS[tab];

// ── On the profile ──────────────────────────────────────────────────────
/** City and when they joined, centred under the bio. */
export function ProfileAbout({ profile }: { profile: Profile }) {
  const c = useColors();
  const { t, date } = useT();
  const joined = t('ps.joined', { date: date(profile.joinedAt, { month: 'long', year: 'numeric', timeZone: 'UTC' }) });
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space[3] }}>
      {profile.city ? (
        <View accessible accessibilityLabel={`${t('ps.city')}: ${profile.city}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Icon name="location-outline" size={15} color={c.inkMuted} />
          <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>{profile.city}</Text>
        </View>
      ) : null}
      <View accessible accessibilityLabel={joined} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Icon name="calendar-outline" size={15} color={c.inkMuted} />
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>{joined}</Text>
      </View>
    </View>
  );
}

/** Links as tidy buttons: the site's icon (fetched and checked by the server) or a generic one, the title and the site. */
export function ProfileLinks({ links, tint }: { links: ProfileLink[]; tint: Tint }) {
  const c = useColors();
  const { t } = useT();
  if (!links.length) return null;
  return (
    <View style={{ alignSelf: 'stretch', gap: space[2] }}>
      {links.map((l, i) => {
        const host = linkHost(l.url) ?? '';
        return (
          <Pressable
            key={`${l.url}-${i}`}
            accessibilityRole="link"
            accessibilityLabel={`${l.label}, ${host}`}
            accessibilityHint={t('ps.links.opensBrowser')}
            onPress={() => void Linking.openURL(l.url).catch(() => {})}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[2],
              minHeight: 48,
              paddingVertical: 6,
              paddingStart: 6,
              paddingEnd: space[3],
              borderRadius: radius.full,
              borderWidth: 1,
              borderColor: c.line,
              backgroundColor: c.surface,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                // Site icons are drawn for light backgrounds: a white disc keeps them visible in dark mode.
                backgroundColor: l.iconUrl ? '#FFFFFF' : tint.soft,
                borderWidth: l.iconUrl ? 1 : 0,
                borderColor: c.line,
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              {l.iconUrl ? (
                <Image source={{ uri: mediaUrl(l.iconUrl) }} style={{ width: 20, height: 20 }} resizeMode="contain" accessibilityIgnoresInvertColors />
              ) : (
                <Icon name="link-outline" size={17} color={tint.accentStrong} />
              )}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={[{ color: c.ink, fontWeight: '700', fontSize: 14 }, userText]}>
                {l.label}
              </Text>
              <Text numberOfLines={1} style={{ color: c.inkMuted, fontSize: 12, writingDirection: 'ltr' }}>
                {host}
              </Text>
            </View>
            <Icon name="open-outline" size={16} color={c.inkMuted} />
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The profile song as a small chip. Nothing loads or plays until the play button is pressed (it
 * never autoplays and costs no data before); with Data saver the cover art isn't loaded either.
 * A song that can't play here says why, quietly.
 */
export function ProfileSongChip({ song, tint }: { song: PostMusic; tint: Tint }) {
  const c = useColors();
  const { t } = useT();
  const saver = useDataSaver().active;
  const credit = useMusicCredit();
  const reduce = useReducedMotion();
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  useMusicLoop(started && song.audioUrl ? { sound: { audioUrl: song.audioUrl }, startMs: song.startMs, durationMs: song.durationMs } : null, playing);
  const names = { title: song.title, artist: song.artist };
  return (
    <View style={{ alignItems: 'center', gap: 2, maxWidth: '100%' }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[2],
          maxWidth: '100%',
          backgroundColor: tint.soft,
          borderRadius: radius.full,
          paddingVertical: 4,
          paddingStart: 4,
          paddingEnd: 12,
        }}
      >
        {song.audioUrl ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={playing ? t('music.pauseOn', names) : t('music.playOn', names)}
            onPress={() => {
              setStarted(true);
              setPlaying((p) => !p);
            }}
            hitSlop={8}
            style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: tint.accent, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name={playing ? 'pause' : 'play'} size={14} color={tint.onAccent} />
          </Pressable>
        ) : (
          <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="volume-mute-outline" size={14} color={c.inkMuted} />
          </View>
        )}
        {song.coverUrl && !saver ? (
          <Image source={{ uri: mediaUrl(song.coverUrl) }} style={{ width: 24, height: 24, borderRadius: 6 }} accessibilityIgnoresInvertColors />
        ) : null}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${t('ps.song.title')}: ${t('music.open', { title: song.title })}`}
          onPress={() => openMusic(song)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minHeight: 32 }}
        >
          <Icon name={playing && !reduce ? 'musical-notes' : 'musical-note'} size={14} color={tint.accentStrong} />
          <Text style={[{ color: tint.accentStrong, fontWeight: '700', fontSize: 13, flexShrink: 1 }, userText]} numberOfLines={1}>
            {song.title}
          </Text>
          <Text style={[{ color: tint.accentStrong, fontSize: 13, flexShrink: 1 }, userText]} numberOfLines={1}>
            {song.artist}
          </Text>
        </Pressable>
      </View>
      <Text style={{ color: c.inkMuted, fontSize: 11, textAlign: 'center' }}>
        {song.unavailable ? t(`music.unavailable.${song.unavailable}` as MessageKey) : credit(song)}
      </Text>
    </View>
  );
}

/** A post's small picture: its first photo (small size; never the original with Data saver), a reel's poster, or none (its first words show). */
function thumbOf(p: Post, saver: boolean): string | null {
  const m = p.media[0];
  if (!m) return null;
  if (m.kind === 'image') return m.variants?.thumb ?? (saver ? null : (m.variants?.medium ?? m.url));
  return m.posterUrl ?? m.variants?.thumb ?? null;
}

function Tile({ post, tint, size, saver }: { post: Post; tint: Tint; size?: number; saver: boolean }) {
  const src = thumbOf(post, saver);
  return (
    <View
      style={{
        width: size ?? '100%',
        aspectRatio: 4 / 5,
        borderRadius: radius.md,
        borderWidth: 2,
        borderColor: tint.accent,
        backgroundColor: tint.soft,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {src ? (
        <Image
          source={{ uri: mediaUrl(src) }}
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
      ) : size ? (
        <Icon name="document-text-outline" size={18} color={tint.accentStrong} />
      ) : (
        <Text numberOfLines={5} style={[{ color: tint.accentStrong, fontWeight: '600', fontSize: 13, padding: space[2] }, userText]}>
          {post.body}
        </Text>
      )}
      {post.format === 'reel' ? (
        <View
          style={{
            position: 'absolute',
            top: 6,
            end: 6,
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: '#0E10208C',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="play" size={12} color="#FFFFFF" />
        </View>
      ) : null}
    </View>
  );
}

/** Up to 3 posts or reels the person chose, shown first. */
export function FeaturedRow({ posts, tint }: { posts: Post[]; tint: Tint }) {
  const c = useColors();
  const { t } = useT();
  const saver = useDataSaver().active;
  if (!posts.length) return null;
  return (
    <View style={{ gap: space[2] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
        {t('ps.featured.title')}
      </Text>
      <View style={{ flexDirection: 'row', gap: space[2] }}>
        {posts.map((p) => (
          <Pressable
            key={p.id}
            accessibilityRole="button"
            accessibilityLabel={`${p.format === 'reel' ? t('m.title.reels') : t('profile.posts')}: ${p.body.slice(0, 80) || t('ps.featured.untitled')}`}
            onPress={() => (p.format === 'reel' ? router.push({ pathname: '/reels', params: { start: p.id } }) : router.push(`/p/${p.id}`))}
            style={({ pressed }) => ({ flex: 1, maxWidth: '33.33%', opacity: pressed ? 0.85 : 1 })}
          >
            <Tile post={p} tint={tint} saver={saver} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ── Edit profile ────────────────────────────────────────────────────────
const HEADER_LABELS: Record<ProfileHeaderStyle, MessageKey> = { cover: 'ps.header.cover', gradient: 'ps.header.gradient', clean: 'ps.header.clean' };
const HEADER_HINTS: Record<ProfileHeaderStyle, MessageKey> = {
  cover: 'ps.header.coverHint',
  gradient: 'ps.header.gradientHint',
  clean: 'ps.header.cleanHint',
};

/** A small drawing of the profile's top in one theme, with the chosen accent and header, in the colours the profile uses. */
function Preview({
  theme,
  accent,
  header,
  profile,
  pronouns,
}: {
  theme: ThemeName;
  accent: ProfileAccent;
  header: ProfileHeaderStyle;
  profile: Profile;
  pronouns: string;
}) {
  const { t } = useT();
  const tint = profileAccentColors(accent, theme);
  const s = THEME_SURFACES[theme];
  const muted = theme === 'dark' ? '#9AA0BC' : '#555B75';
  const photo = header === 'cover' && profile.coverUrl ? mediaUrl(profile.coverUrl) : null;
  return (
    <View
      style={{
        flex: 1,
        borderRadius: radius.md,
        overflow: 'hidden',
        backgroundColor: s.ground,
        borderWidth: 1,
        borderColor: theme === 'dark' ? '#262A40' : '#E3E5EF',
      }}
    >
      {header === 'clean' ? null : photo ? (
        <Image source={{ uri: photo }} style={{ aspectRatio: 8 / 3 }} resizeMode="cover" accessibilityIgnoresInvertColors />
      ) : (
        <LinearGradient colors={[tint.accentStrong, tint.accent, tint.gradEnd]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ height: 36 }} />
      )}
      <View style={{ margin: 6, padding: 8, borderRadius: radius.sm, backgroundColor: s.surface, gap: 6, alignItems: 'center' }}>
        <Avatar name={profile.displayName} url={profile.avatarUrl} size={28} />
        <Text numberOfLines={1} style={[{ color: s.ink, fontWeight: '700', fontSize: 12 }, userText]}>
          {profile.displayName}
          {pronouns.trim() ? <Text style={{ color: muted, fontWeight: '400' }}>{` ${pronouns.trim()}`}</Text> : null}
        </Text>
        <LinearGradient
          colors={[tint.accent, tint.accentStrong, tint.gradEnd]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={{ borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4 }}
        >
          <Text style={{ color: tint.onAccent, fontWeight: '700', fontSize: 11 }}>{t('profile.follow')}</Text>
        </LinearGradient>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          <Text
            style={{
              color: tint.onAccent,
              backgroundColor: tint.accent,
              borderRadius: radius.full,
              overflow: 'hidden',
              paddingHorizontal: 6,
              paddingVertical: 2,
              fontSize: 10,
              fontWeight: '700',
            }}
          >
            {t('profile.posts')}
          </Text>
          <Text style={{ color: muted, paddingHorizontal: 6, paddingVertical: 2, fontSize: 10 }}>{t('m.title.reels')}</Text>
        </View>
      </View>
      <Text style={{ color: muted, fontSize: 11, paddingHorizontal: 8, paddingBottom: 6 }}>
        {t(theme === 'dark' ? 'st.appearance.dark' : 'st.appearance.light')}
      </Text>
    </View>
  );
}

/** Accent swatches and header style, with a live preview in light and dark. */
export function StyleEditor({
  profile,
  accent,
  onAccent,
  header,
  onHeader,
  pronouns,
}: {
  profile: Profile;
  accent: ProfileAccent;
  onAccent: (a: ProfileAccent) => void;
  header: ProfileHeaderStyle;
  onHeader: (h: ProfileHeaderStyle) => void;
  pronouns: string;
}) {
  const c = useColors();
  const { t } = useT();
  const name = (id: ProfileAccent) => t(`ps.accent.${id}` as MessageKey);
  return (
    <View style={{ gap: space[3] }}>
      <View style={{ flexDirection: 'row', gap: space[2] }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Preview theme="light" accent={accent} header={header} profile={profile} pronouns={pronouns} />
        <Preview theme="dark" accent={accent} header={header} profile={profile} pronouns={pronouns} />
      </View>
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('ps.accent.label')}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={t('ps.accent.label')} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
        {PROFILE_ACCENTS.map((a) => {
          const on = accent === a.id;
          return (
            <Pressable
              key={a.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={name(a.id)}
              onPress={() => onAccent(a.id)}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  overflow: 'hidden',
                  borderWidth: on ? 3 : 1,
                  borderColor: on ? c.ink : c.lineStrong,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <LinearGradient
                  colors={[profileAccentColors(a.id, 'light').accent, profileAccentColors(a.id, 'dark').accent]}
                  locations={[0.5, 0.5]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
                />
                {on ? <Icon name="checkmark" size={18} color="#FFFFFF" /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('ps.accent.hint', { name: name(accent) })}</Text>
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('ps.header.label')}</Text>
      <ChipRow radios label={t('ps.header.label')}>
        {PROFILE_HEADER_STYLES.map((h) => (
          <Chip key={h} radio label={t(HEADER_LABELS[h])} selected={header === h} onPress={() => onHeader(h)} />
        ))}
      </ChipRow>
      <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t(HEADER_HINTS[header])}</Text>
    </View>
  );
}

/** Up to 5 links, each a title and a web address. */
export function LinksEditor({
  links,
  onChange,
  errors,
}: {
  links: { label: string; url: string }[];
  onChange: (l: { label: string; url: string }[]) => void;
  errors: Record<string, string>;
}) {
  const c = useColors();
  const { t } = useT();
  const set = (i: number, patch: Partial<{ label: string; url: string }>) => onChange(links.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <View style={{ gap: space[3] }}>
      <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('ps.links.hint', { max: MAX_PROFILE_LINKS })}</Text>
      {links.map((l, i) => (
        <View key={i} style={{ gap: space[2], paddingBottom: space[2], borderBottomWidth: 1, borderBottomColor: c.line }}>
          <Field
            label={t('ps.links.label', { n: i + 1 })}
            value={l.label}
            maxLength={PROFILE_LINK_LABEL_MAX}
            onChangeText={(v) => set(i, { label: v })}
            error={errors[`links.${i}.label`]}
          />
          <Field
            label={t('ps.links.url', { n: i + 1 })}
            value={l.url}
            placeholder="https://"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            maxLength={500}
            onChangeText={(v) => set(i, { url: v })}
            error={errors[`links.${i}.url`]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('ps.links.remove', { n: i + 1 })}
            onPress={() => onChange(links.filter((_, j) => j !== i))}
            hitSlop={8}
            style={{ alignSelf: 'flex-end', flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44 }}
          >
            <Icon name="trash-outline" size={16} color={c.danger} />
            <Text style={{ color: c.danger, fontWeight: '600', fontSize: 13 }}>{t('m.common.remove')}</Text>
          </Pressable>
        </View>
      ))}
      {errors.links ? <Text style={{ color: c.danger, fontSize: 13 }}>{errors.links}</Text> : null}
      {links.length < MAX_PROFILE_LINKS ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onChange([...links, { label: '', url: '' }])}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 }}
        >
          <Icon name="add-circle-outline" size={18} color={c.yapi} />
          <Text style={{ color: c.yapi, fontWeight: '700' }}>{t('ps.links.add')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Which tabs show, and their order: a switch-like check and up and down buttons for each. */
export function TabsEditor({
  order,
  shown,
  onChange,
}: {
  order: ProfileTab[];
  shown: Set<ProfileTab>;
  onChange: (order: ProfileTab[], shown: Set<ProfileTab>) => void;
}) {
  const c = useColors();
  const { t } = useT();
  const [status, setStatus] = useState('');
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next, shown);
    setStatus(t('ps.tabs.moved', { tab: t(TAB_LABELS[next[j]!]), position: j + 1 }));
  };
  return (
    <View style={{ gap: space[2] }}>
      <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('ps.tabs.hint')}</Text>
      {order.map((tab, i) => {
        const label = t(TAB_LABELS[tab]);
        const on = shown.has(tab);
        const last = on && shown.size === 1;
        return (
          <View
            key={tab}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[2],
              borderWidth: 1,
              borderColor: c.line,
              borderRadius: radius.md,
              paddingStart: space[2],
            }}
          >
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled: last }}
              accessibilityLabel={label}
              accessibilityHint={last ? t('ps.tabs.lastOne') : undefined}
              disabled={last}
              onPress={() => {
                const next = new Set(shown);
                if (on) next.delete(tab);
                else next.add(tab);
                onChange(order, next);
              }}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 44 }}
            >
              <Icon name={on ? 'checkbox' : 'square-outline'} size={22} color={on ? c.yapi : c.inkMuted} />
              <Text style={{ color: c.ink, fontWeight: '600' }}>{label}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('ps.tabs.up', { tab: label })}
              accessibilityState={{ disabled: i === 0 }}
              disabled={i === 0}
              onPress={() => move(i, -1)}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="chevron-up" size={20} color={i === 0 ? c.lineStrong : c.ink} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('ps.tabs.down', { tab: label })}
              accessibilityState={{ disabled: i === order.length - 1 }}
              disabled={i === order.length - 1}
              onPress={() => move(i, 1)}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="chevron-down" size={20} color={i === order.length - 1 ? c.lineStrong : c.ink} />
            </Pressable>
          </View>
        );
      })}
      <Text accessibilityLiveRegion="polite" style={{ height: 0, opacity: 0 }}>
        {status}
      </Text>
    </View>
  );
}

/** Choose up to 3 of your own posts or reels (that other people can see) to show first. */
export function FeaturedEditor({
  username,
  value,
  onChange,
  error,
  tint,
}: {
  username: string;
  value: Post[];
  onChange: (p: Post[]) => void;
  error?: string;
  tint: Tint;
}) {
  const c = useColors();
  const { t } = useT();
  const saver = useDataSaver().active;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Post[] | null>(null);
  useEffect(() => {
    if (!open || items) return;
    void client()
      .then((api) => api.users.posts(username))
      .then(
        (r) => setItems(r.items),
        () => setItems([]),
      );
  }, [open, items, username]);
  const chosen = useMemo(() => new Set(value.map((p) => p.id)), [value]);
  const choosable = (items ?? []).filter((p) => p.visibility !== 'private' && !p.community && !p.status);
  return (
    <View style={{ gap: space[2] }}>
      <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('ps.featured.hint', { max: MAX_FEATURED_POSTS })}</Text>
      {value.length ? (
        value.map((p, i) => (
          <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Tile post={p} tint={tint} size={44} saver={saver} />
            <Text numberOfLines={1} style={[{ flex: 1, color: c.ink }, userText]}>
              {p.body.slice(0, 60) || t('ps.featured.untitled')}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('ps.featured.remove', { n: i + 1 })}
              onPress={() => onChange(value.filter((x) => x.id !== p.id))}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="close" size={20} color={c.inkMuted} />
            </Pressable>
          </View>
        ))
      ) : (
        <Text style={{ color: c.inkMuted }}>{t('ps.featured.none')}</Text>
      )}
      {error ? <Text style={{ color: c.danger, fontSize: 13 }}>{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 }}
      >
        <Icon name={open ? 'chevron-up' : 'add-circle-outline'} size={18} color={c.yapi} />
        <Text style={{ color: c.yapi, fontWeight: '700' }}>{open ? t('ps.featured.done') : t('ps.featured.pick')}</Text>
      </Pressable>
      {open ? (
        items === null ? (
          <ActivityIndicator color={c.yapi} />
        ) : choosable.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {choosable.map((p) => {
              const on = chosen.has(p.id);
              const full = !on && value.length >= MAX_FEATURED_POSTS;
              return (
                <Pressable
                  key={p.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on, disabled: full }}
                  accessibilityLabel={p.body.slice(0, 80) || t('ps.featured.untitled')}
                  accessibilityHint={full ? t('ps.featured.max', { max: MAX_FEATURED_POSTS }) : undefined}
                  disabled={full}
                  onPress={() => onChange(on ? value.filter((x) => x.id !== p.id) : [...value, p])}
                  style={{ width: 88, opacity: full ? 0.5 : 1 }}
                >
                  <View style={{ borderRadius: radius.md, borderWidth: on ? 3 : 0, borderColor: c.ink }}>
                    <Tile post={p} tint={tint} saver={saver} />
                  </View>
                  {on ? (
                    <View
                      style={{
                        position: 'absolute',
                        top: 6,
                        start: 6,
                        width: 24,
                        height: 24,
                        borderRadius: 12,
                        backgroundColor: tint.accent,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ color: tint.onAccent, fontWeight: '800', fontSize: 12 }}>{value.findIndex((x) => x.id === p.id) + 1}</Text>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Text style={{ color: c.inkMuted }}>{t('ps.featured.nothing')}</Text>
        )
      ) : null}
    </View>
  );
}

/** The profile song as a picker track, so the music field can show and change it. */
export function songAsTrack(m: PostMusic): MusicTrack {
  return {
    source: m.source,
    id: m.id,
    title: m.title,
    artist: m.artist,
    album: null,
    durationMs: null,
    coverUrl: m.coverUrl,
    previewUrl: m.audioUrl,
    licence: {
      name: m.licenceName ?? '',
      url: m.licenceUrl,
      commercialUse: true,
      regions: null,
      excludedRegions: [],
      maxClipSeconds: 30,
      attribution: m.attribution,
      expiresAt: null,
      cacheAllowed: false,
    },
    attribution: m.attribution ?? '',
    maxClipMs: Math.max(m.durationMs, 30_000),
    uses: 0,
    saved: false,
    canUse: true,
  };
}

/** The default tab order with the saved ones first. */
export const editorTabs = (saved: ProfileTab[]): ProfileTab[] => [...saved, ...PROFILE_TABS.filter((x) => !saved.includes(x))];
